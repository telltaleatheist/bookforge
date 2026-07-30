#!/usr/bin/env node
/**
 * ocr-pdf — drive BookForge's OWN OCR path over a PDF, headlessly.
 *
 *   node --require cli/electron-stub.js cli/ocr-pdf.js <book.pdf> \
 *        --out <dir> [--lang eng] [--jobs 8] [--pages a-b]
 *
 * This is deliberately a THIN driver. Everything that decides what a block is —
 * render resolution, OpenCV preprocessing, the Tesseract invocation, hOCR
 * parsing, paragraph grouping, the legacy font/typography pass — lives in
 * electron/headless-ocr.ts and electron/ocr-service.ts and is called, not
 * reimplemented. So running this exercises the same code the app runs, and a bug
 * here is a bug the app has.
 *
 * What is local, and why:
 *   - the output FORMAT (blocks.json). The app returns OCR results in memory to
 *     a renderer; there is no app-side writer for the on-disk corpus shape.
 *   - unit conversion from OCR image pixels to page points, using the page size
 *     the service now reports.
 * Neither is a second implementation of OCR.
 *
 * Running it this way is what surfaced three real bugs in that shared path,
 * which is exactly what the rule is for: the headless renderer rasterised at
 * 300 dpi while declaring 200 to Tesseract; the hOCR parser matched only
 * `ocr_line` and so silently dropped every running head, caption and footnote
 * Tesseract classed as ocr_header/ocr_caption/ocr_textfloat; and the OpenCV
 * preprocessing pass moved a third of all bounding boxes while measurably not
 * improving the text. With those fixed this tool reproduces the training
 * corpus's segmentation to 155/156 blocks on a 20-page sample.
 *
 * --preprocess re-enables the OpenCV pass for genuinely damaged scans. It is
 * off by default; see OcrServiceConfig.preprocess for the measurement.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function usage(msg) {
  if (msg) console.error(`ocr-pdf: ${msg}`);
  console.error(
    'usage: node --require cli/electron-stub.js cli/ocr-pdf.js <book.pdf> --out <dir>\n' +
    '              [--lang eng] [--jobs 8] [--pages a-b] [--engine tesseract] [--preprocess]');
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    // Skip this flag's value unless it is a known boolean switch.
    if (!['preprocess'].includes(argv[i].slice(2))) i++;
    continue;
  }
  positional.push(argv[i]);
}

const pdfPath = positional[0];
if (!pdfPath) usage('a PDF path is required');
if (!fs.existsSync(pdfPath)) usage(`no such file: ${pdfPath}`);
const outDir = opt('out');
if (!outDir) usage('--out <dir> is required');

const lang = opt('lang', 'eng');
const engine = opt('engine', 'tesseract');
const jobs = Number(opt('jobs', '8'));
if (!Number.isInteger(jobs) || jobs < 1) usage(`--jobs must be a positive integer, got ${opt('jobs')}`);
const pagesOpt = opt('pages', null);

// ── the app's own modules ────────────────────────────────────────────────────
// Required lazily and by explicit path so a missing build fails with a clear
// message rather than a bare MODULE_NOT_FOUND.
function requireBuilt(rel, what) {
  const p = path.join(REPO_ROOT, 'dist', 'electron', rel);
  if (!fs.existsSync(p)) {
    console.error(`ocr-pdf: ${what} is not built (${p}).\n` +
      '         Build the main process first:  npm run build:electron');
    process.exit(1);
  }
  return require(p);
}

const { getHeadlessOcrService } = requireBuilt('headless-ocr.js', 'headless OCR service');
const { OCR_DPI } = requireBuilt('ocr-service.js', 'OCR service');

async function main() {
  let pages;
  if (pagesOpt) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(pagesOpt);
    if (!m) usage(`--pages wants N or A-B (0-based, inclusive), got ${pagesOpt}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a) usage(`--pages range is backwards: ${pagesOpt}`);
    pages = Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const started = Date.now();
  let lastLine = 0;
  const results = await getHeadlessOcrService().processPdf(path.resolve(pdfPath), {
    engine,
    language: lang,
    pages,
    concurrency: jobs,
    preprocess: flag('preprocess'),
    onProgress: (current, total) => {
      // Rewrite one line; the service also logs per page to stdout.
      const now = Date.now();
      if (now - lastLine < 500 && current !== total) return;
      lastLine = now;
      const secs = (now - started) / 1000;
      const rate = current / secs;
      const eta = rate > 0 ? Math.round((total - current) / rate) : 0;
      process.stderr.write(
        `\r[ocr-pdf] ${current}/${total} pages  ${rate.toFixed(2)} pg/s  eta ${eta}s   `);
    },
  });
  process.stderr.write('\n');

  // ── emit blocks.json ──────────────────────────────────────────────────────
  // Same shape tools/aligner/ocr-book.mjs writes, so the labeling and
  // dataset-building tools consume either without special-casing.
  const scale = OCR_DPI / 72;               // image pixels per point
  const px2pt = (v) => v / scale;
  const blocks = [];
  const pageDimensions = [];

  for (const r of results) {
    const pageW = r.pageWidth ?? 0;
    const pageH = r.pageHeight ?? 0;
    pageDimensions[r.page] = { width: pageW, height: pageH };

    // Paragraph geometry comes from the service. Line geometry is attached from
    // textLines by (blockNum, parNum) — the same grouping key the service used.
    const linesByPar = new Map();
    for (const l of r.textLines ?? []) {
      const key = `${l.blockNum ?? 0}:${l.parNum ?? 0}`;
      let arr = linesByPar.get(key);
      if (!arr) linesByPar.set(key, arr = []);
      arr.push(l);
    }

    for (const p of r.paragraphs ?? []) {
      const [x1, y1, x2, y2] = p.bbox;
      const lines = linesByPar.get(`${p.blockNum}:${p.parNum}`) ?? [];
      const sizes = lines.map(l => l.xSize).filter(v => typeof v === 'number' && v > 0).sort((a, b) => a - b);
      blocks.push({
        page: p.page ?? r.page,
        x: px2pt(x1), y: px2pt(y1), w: px2pt(x2 - x1), h: px2pt(y2 - y1),
        text: p.text,
        lineCount: p.lineCount,
        lineBoxes: lines.map(l => ({
          x: Math.round(px2pt(l.bbox[0])), y: Math.round(px2pt(l.bbox[1])),
          w: Math.round(px2pt(l.bbox[2] - l.bbox[0])), h: Math.round(px2pt(l.bbox[3] - l.bbox[1])),
          // Typography the corpus tool cannot produce at all — it skips the
          // legacy font pass, so these are additive, never contradictory.
          ...(l.fontName !== undefined ? { fontName: l.fontName } : {}),
          ...(l.fontSize !== undefined ? { fontSize: l.fontSize } : {}),
          ...(l.boldFrac !== undefined ? { boldFrac: l.boldFrac } : {}),
          ...(l.italicFrac !== undefined ? { italicFrac: l.italicFrac } : {}),
          ...(l.descenders !== undefined ? { descenders: l.descenders } : {}),
        })),
        fsize: sizes.length ? px2pt(sizes[Math.floor(sizes.length / 2)]) : 0,
        // Already 0..1 — parseHocrOutput divides x_wconf by 100 per line before
        // averaging into the paragraph. Matches blocks.json's existing scale.
        conf: p.confidence,
        pageW, pageH,
      });
    }
  }

  blocks.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

  const outPath = path.join(outDir, 'blocks.json');
  fs.writeFileSync(outPath, JSON.stringify({
    pdf: path.resolve(pdfPath),
    dpi: OCR_DPI,
    lang,
    engine,
    // Recorded because it changes the blocks, and a corpus that mixes the two
    // silently is exactly the confusion this field exists to prevent.
    preprocessed: flag('preprocess'),
    producer: 'cli/ocr-pdf.js (app headless-ocr path)',
    pageDimensions,
    blocks,
  }, null, 1));

  const emptyPages = results.filter(r => !(r.paragraphs ?? []).length).length;
  console.log(`[ocr-pdf] ${blocks.length} blocks from ${results.length} pages` +
    ` (${emptyPages} with no text) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`[ocr-pdf] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('\nocr-pdf failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

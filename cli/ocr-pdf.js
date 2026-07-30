#!/usr/bin/env node
/**
 * ocr-pdf — drive BookForge's OWN OCR path over a PDF, headlessly.
 *
 *   node --require cli/electron-stub.js cli/ocr-pdf.js <book.pdf> \
 *        [--out <dir>] [--project <projectDir> [--overwrite-ocr]] \
 *        [--lang eng] [--jobs 8] [--pages a-b]
 *
 * This is deliberately a THIN driver. Everything that decides what a block is —
 * render resolution, OpenCV preprocessing, the Tesseract invocation, hOCR
 * parsing, line→paragraph merging, categorization, the legacy font/typography
 * pass — lives in electron/headless-ocr.ts, electron/ocr-service.ts and
 * shared/ocr/ocr-post-processing.ts and is called, not reimplemented. So running
 * this exercises the same code the app runs, and a bug here is a bug the app has.
 *
 * TWO OUTPUTS, independent:
 *
 *   --out <dir>          writes <dir>/blocks.json, the flat on-disk corpus shape
 *                        the labeling and dataset tools read. Tesseract's own
 *                        paragraph grouping, unmerged — the segmentation the
 *                        corpus was built from.
 *   --project <dir>      writes manifest.editor.ocrBlocks + .ocrCategories into a
 *                        BookForge project, exactly as the picker's save does, so
 *                        opening the book in the app loads the OCR'd blocks
 *                        instead of re-OCRing. These are the POST-PROCESSED
 *                        blocks: lines merged into paragraphs and categorized by
 *                        shared/ocr/ocr-post-processing.ts, the same call the
 *                        picker makes. The library is Syncthing-shared, so this is
 *                        how a book gets OCR'd on the GPU machine and
 *                        hand-labelled in Label mode on another one.
 *
 * The two shapes are deliberately different and both are the app's: blocks.json
 * is Tesseract's paragraphs (what the corpus is keyed to), the manifest gets the
 * picker's merged-and-classified blocks (what Label mode edits). Either flag can
 * be given alone; at least one must be.
 *
 * What is local, and why:
 *   - the blocks.json output FORMAT. The app returns OCR results in memory to a
 *     renderer; there is no app-side writer for the on-disk corpus shape.
 *   - unit conversion from OCR image pixels to page points for that file, using
 *     the page size the service now reports.
 * Neither is a second implementation of OCR. The manifest path adds nothing of
 * its own at all: block construction and the manifest write are both app modules.
 *
 * Running it this way is what surfaced four real bugs in that shared path, which
 * is exactly what the rule is for: the headless renderer rasterised at 300 dpi
 * while declaring 200 to Tesseract; the hOCR parser matched only `ocr_line` and
 * so silently dropped every running head, caption and footnote Tesseract classed
 * as ocr_header/ocr_caption/ocr_textfloat; the OpenCV preprocessing pass moved a
 * third of all bounding boxes while measurably not improving the text; and — once
 * the picker's block construction was shared rather than copied — the picker was
 * converting OCR boxes to page points with a scale derived from the document's
 * PAGE COUNT, inflating every OCR block's geometry by up to 1.85x.
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
    'usage: node --require cli/electron-stub.js cli/ocr-pdf.js <book.pdf>\n' +
    '              [--out <dir>] [--project <projectDir> [--overwrite-ocr]]\n' +
    '              [--lang eng] [--jobs 8] [--pages a-b] [--engine tesseract] [--preprocess]');
  process.exit(msg ? 1 : 0);
}

/** Flags that take no value, so the positional scan doesn't eat the next argument. */
const BOOLEAN_FLAGS = ['preprocess', 'overwrite-ocr'];

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
    if (!BOOLEAN_FLAGS.includes(argv[i].slice(2))) i++;
    continue;
  }
  positional.push(argv[i]);
}

const pdfPath = positional[0];
if (!pdfPath) usage('a PDF path is required');
if (!fs.existsSync(pdfPath)) usage(`no such file: ${pdfPath}`);
const outDir = opt('out');
const projectDir = opt('project');
if (!outDir && !projectDir) {
  usage('nothing to write: give --out <dir> (blocks.json), --project <dir> (into the ' +
        'project manifest), or both');
}
const overwriteOcr = flag('overwrite-ocr');
if (overwriteOcr && !projectDir) usage('--overwrite-ocr only means anything with --project');

const lang = opt('lang', 'eng');
const engine = opt('engine', 'tesseract');
const jobs = Number(opt('jobs', '8'));
if (!Number.isInteger(jobs) || jobs < 1) usage(`--jobs must be a positive integer, got ${opt('jobs')}`);
const pagesOpt = opt('pages', null);

// ── the app's own modules ────────────────────────────────────────────────────
// Required lazily and by explicit path so a missing build fails with a clear
// message rather than a bare MODULE_NOT_FOUND.
function requireBuilt(rel, what) {
  const p = path.join(REPO_ROOT, 'dist', rel);
  if (!fs.existsSync(p)) {
    console.error(`ocr-pdf: ${what} is not built (${p}).\n` +
      '         Build the main process first:  npm run build:electron');
    process.exit(1);
  }
  return require(p);
}

const { getHeadlessOcrService } = requireBuilt('electron/headless-ocr.js', 'headless OCR service');
const { OCR_DPI } = requireBuilt('electron/ocr-service.js', 'OCR service');
// The picker's own block construction + categorization, compiled from shared/.
const { processOcrPageResults } =
  requireBuilt('shared/ocr/ocr-post-processing.js', 'shared OCR post-processor');

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

  // Resolve and VERIFY the project before spending an hour in Tesseract. Every way
  // this can fail — wrong folder, wrong book, labels already keyed to stored blocks
  // — is knowable now, and finding out afterwards is a wasted run.
  let target = null;
  if (projectDir) {
    const store = requireBuilt('electron/ocr-project-store.js', 'OCR project store');
    target = await store.resolveOcrProjectTarget(projectDir, path.resolve(pdfPath));
    // Logged BEFORE the overwrite check, so a refusal still shows what was verified.
    console.log(`[ocr-pdf] project ${target.projectId}`);
    console.log(`[ocr-pdf]   source verified: ${target.sourceDocPath}`);
    console.log(`[ocr-pdf]   sha256 ${target.sourceSha256} (matches the PDF being OCR'd)`);
    store.assertOcrOverwriteAllowed(target, overwriteOcr);
    if (target.existingBlockCount > 0) {
      console.log(`[ocr-pdf]   --overwrite-ocr: replacing ${target.existingBlockCount} stored ` +
        `block(s) and orphaning ${target.existingCorrectionCount} hand label(s)`);
      if (target.existingCorrectionCount > 0) {
        console.log('[ocr-pdf]   those labels are LEFT IN PLACE (this writes only ocrBlocks +' +
          ' ocrCategories); clear them in the app if you do not want stale labels counted.');
      }
    }
  }

  if (outDir) fs.mkdirSync(outDir, { recursive: true });

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

  if (outDir) writeBlocksJson(results, started);
  if (target) await writeToProject(results, target);
}

/**
 * Page sizes in POINTS, as the service measured them from each MediaBox, indexed by
 * page number — how the post-processor addresses them.
 *
 * A page the service could not measure is left ABSENT rather than filled in: the
 * post-processor throws naming it, because every category threshold is a fraction of
 * page height and a substituted size silently moves all of them.
 */
function pointPageDimensions(results) {
  const dims = [];
  for (const r of results) {
    if (r.pageWidth === undefined || r.pageHeight === undefined) continue;
    dims[r.page] = { width: r.pageWidth, height: r.pageHeight };
  }
  return dims;
}

/**
 * blocks.json — Tesseract's paragraphs, flat, in page points.
 *
 * Same shape tools/aligner/ocr-book.mjs writes, so the labeling and dataset-building
 * tools consume either without special-casing. NOT the same segmentation the
 * manifest gets: this is Tesseract's own grouping (what the training corpus is keyed
 * to), the manifest gets the picker's merged-and-classified blocks.
 */
function writeBlocksJson(results, started) {
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

/**
 * The project write: the picker's own post-processor, then the app's own locked
 * manifest read-modify-write. No block construction happens in this file.
 */
async function writeToProject(results, target) {
  const processed = processOcrPageResults(results, pointPageDimensions(results));
  if (processed.blocks.length === 0) {
    throw new Error('OCR produced no blocks — nothing to store. Check that the pages ' +
      'requested actually contain text.');
  }

  const store = requireBuilt('electron/ocr-project-store.js', 'OCR project store');
  const written = await store.persistOcrToProject(
    target, processed.blocks, processed.categories, { overwrite: overwriteOcr });

  const byCategory = new Map();
  for (const b of processed.blocks) {
    byCategory.set(b.category_id, (byCategory.get(b.category_id) ?? 0) + 1);
  }
  const summary = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id}=${n}`)
    .join(' ');

  console.log(`[ocr-pdf] ${processed.blocks.length} post-processed block(s) on ` +
    `${processed.pages.length} page(s): ${summary}`);
  if (written.replacedBlockCount > 0) {
    console.log(`[ocr-pdf] replaced ${written.replacedBlockCount} previously stored block(s)`);
  }
  console.log(`[ocr-pdf] wrote editor.ocrBlocks + editor.ocrCategories to ${written.manifestPath}`);
  console.log('[ocr-pdf] Block IDs are now FROZEN — re-running OCR mints new ones and ' +
    'orphans any label keyed to these.');
}

main().catch((err) => {
  console.error('\nocr-pdf failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

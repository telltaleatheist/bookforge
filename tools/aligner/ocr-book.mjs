#!/usr/bin/env node
/**
 * ocr-book — render + OCR a PDF into paragraph blocks, no EPUB required.
 *
 *   node tools/aligner/ocr-book.mjs <book.pdf> --out <dir> [--dpi 200]
 *        [--pages a-b] [--lang eng] [--jobs 8]
 *
 * The EPUB-less half of align-pair.mjs, for books with no clean digital twin
 * that must be labeled by hand (or by eye). Emits blocks.json — the same
 * block shape align-pair produces — and KEEPS the rendered page PNGs, because
 * the whole point of hand labeling is that someone looks at the pages.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as mupdf from 'mupdf';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const [pdfPath] = positional;
if (!pdfPath) {
  console.error('usage: ocr-book.mjs <book.pdf> --out <dir> [--dpi 200] [--pages a-b] [--lang eng] [--jobs 8]');
  process.exit(1);
}
const outDir = opt('out', path.join(process.cwd(), 'ocr-out'));
const dpi = Number(opt('dpi', '200'));
const pagesOpt = opt('pages', null);
const lang = opt('lang', 'eng');
const jobs = Number(opt('jobs', '8'));
fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });

const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };

function ocrPageAsync(pageInfo) {
  return new Promise((resolve, reject) => {
    execFile('tesseract',
      [pageInfo.png, 'stdout', '-l', lang, '--oem', '1', '--psm', '3',
       '-c', 'tessedit_create_hocr=1', '-c', `user_defined_dpi=${dpi}`],
      { encoding: 'utf-8', maxBuffer: 64 << 20 },
      (err, hocr) => err ? reject(err) : resolve(parseHocr(pageInfo, hocr)));
  });
}

/** Identical block extraction to align-pair.mjs / electron/ocr-service.ts. */
function parseHocr(pageInfo, hocr) {
  const scale = dpi / 72;
  const blocks = [];
  for (const parHtml of hocr.split(/<p class='ocr_par'/).slice(1)) {
    const parBody = parHtml.split('</p>')[0];
    const bbox = /title="bbox (\d+) (\d+) (\d+) (\d+)/.exec(parHtml);
    if (!bbox) continue;
    const lines = [];
    /**
     * Per-line geometry, kept rather than collapsed into the paragraph bbox.
     *
     * Three things need it, and none of them are recoverable afterwards:
     *
     * 1. SPLITTING an under-segmented paragraph. Tesseract sometimes merges a
     *    footnote into the body above it, and a merged block is the one case a
     *    region-based label transfer cannot resolve — it straddles two labelled
     *    regions. With line boxes the paragraph can be cut at the line where the
     *    regions divide, so ground truth drives the granularity instead of
     *    Tesseract's guess. Over-segmentation is recoverable by merging;
     *    under-segmentation was not, until now.
     * 2. ALIGNMENT features. Measured Jul 2026: first-line indent separates body
     *    (+0.075 of measure), flush entries (0.000) and hanging-indent
     *    bibliography (-0.082) with near-zero variance within each group, and
     *    right-edge spread excluding the last line detects justification exactly
     *    (0.001-0.002 on justified prose). Both are invisible in a paragraph bbox.
     * 3. COLUMN RUNS for `table` — repeated x-positions down a block, which the
     *    v1 post-mortem identified as the missing structural feature and which is
     *    why `table` still scores 0.00.
     */
    const lineBoxes = [];
    const xsizes = [];
    let confSum = 0, confN = 0;
    for (const lineHtml of parBody.split(/<span class='ocr_line'|<span class='ocr_header'|<span class='ocr_caption'|<span class='ocr_textfloat'/).slice(1)) {
      const xs = num(/x_size ([\d.]+)/, lineHtml);
      if (xs) xsizes.push(xs);
      const lb = /title="bbox (\d+) (\d+) (\d+) (\d+)/.exec(lineHtml)
        ?? /title='bbox (\d+) (\d+) (\d+) (\d+)/.exec(lineHtml);
      const words = [];
      // Word boxes too: a line's x-positions are what make a column detectable.
      const wordXs = [];
      for (const w of lineHtml.matchAll(/<span class='ocrx_word'[^>]*title='([^']*)'[^>]*>([\s\S]*?)<\/span>/g)) {
        const wconf = /x_wconf (\d+)/.exec(w[1]);
        if (wconf) { confSum += Number(wconf[1]); confN++; }
        const wb = /bbox (\d+) (\d+) (\d+) (\d+)/.exec(w[1]);
        const t = w[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (t) {
          words.push(t);
          if (wb) wordXs.push(Math.round(Number(wb[1]) / scale));
        }
      }
      if (!words.length) continue;
      lines.push(words.join(' '));
      if (lb) {
        // Points, like the paragraph bbox, and rounded — sub-point precision is
        // noise at 200 dpi and these are numerous enough for size to matter.
        lineBoxes.push({
          x: Math.round(Number(lb[1]) / scale), y: Math.round(Number(lb[2]) / scale),
          w: Math.round((Number(lb[3]) - Number(lb[1])) / scale),
          h: Math.round((Number(lb[4]) - Number(lb[2])) / scale),
          wordXs,
        });
      }
    }
    let text = '';
    for (const l of lines) text = text ? (/[-‐‑]$/.test(text) ? text.slice(0, -1) + l : text + ' ' + l) : l;
    if (!text.trim()) continue;
    xsizes.sort((p, q) => p - q);
    blocks.push({
      page: pageInfo.page,
      x: Number(bbox[1]) / scale, y: Number(bbox[2]) / scale,
      w: (Number(bbox[3]) - Number(bbox[1])) / scale, h: (Number(bbox[4]) - Number(bbox[2])) / scale,
      text, lineCount: lines.length, lineBoxes,
      fsize: xsizes.length ? xsizes[Math.floor(xsizes.length / 2)] / scale : 0,
      conf: confN ? confSum / confN / 100 : 0,
      pageW: pageInfo.w, pageH: pageInfo.h,
    });
  }
  return blocks;
}

// ── main ─────────────────────────────────────────────────────────────────────

const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), 'application/pdf');
const n = doc.countPages();
const [a, b] = pagesOpt ? pagesOpt.split('-').map(Number) : [0, n - 1];
const scale = dpi / 72;

const allPageDims = [];
for (let i = 0; i < n; i++) {
  const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
  allPageDims.push({ width: x1 - x0, height: y1 - y0 });
}

console.log(`[ocr-book] rendering pages ${a}-${Math.min(n - 1, b)} at ${dpi}dpi`);
const pages = [];
for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) {
  const page = doc.loadPage(i);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = path.join(outDir, 'pages', `page-${i}.png`);
  fs.writeFileSync(png, pix.asPNG());
  const [x0, y0, x1, y1] = page.getBounds();
  // WASM heap is not garbage-collected — without explicit destroy the
  // pixmaps accumulate and malloc fails a few hundred pages in.
  pix.destroy();
  page.destroy();
  pages.push({ page: i, png, w: x1 - x0, h: y1 - y0 });
  if (i % 25 === 0) process.stdout.write(`\r[ocr-book]   rendered ${i}`);
}
console.log(`\n[ocr-book] OCR with ${jobs} parallel workers`);

const blocks = [];
let done = 0;
const queue = [...pages];
async function worker() {
  for (;;) {
    const p = queue.shift();
    if (!p) return;
    try {
      blocks.push(...await ocrPageAsync(p));
    } catch (e) {
      console.error(`\n[ocr-book] page ${p.page} FAILED: ${e.message}`);
    }
    done++;
    if (done % 10 === 0) process.stdout.write(`\r[ocr-book]   ${done}/${pages.length} pages, ${blocks.length} blocks`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
console.log(`\n[ocr-book] ${blocks.length} blocks from ${pages.length} pages`);

blocks.sort((p, q) => p.page - q.page || p.y - q.y || p.x - q.x);
fs.writeFileSync(path.join(outDir, 'blocks.json'), JSON.stringify({
  pdf: path.resolve(pdfPath), dpi, lang,
  pageDimensions: allPageDims,
  blocks,
}, null, 1));
console.log(`[ocr-book] wrote ${path.join(outDir, 'blocks.json')} (page PNGs kept in ${path.join(outDir, 'pages')})`);

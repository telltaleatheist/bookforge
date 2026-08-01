#!/usr/bin/env node
/**
 * align-pair — derive block-category training labels for a scanned/print PDF
 * by aligning its OCR text against a structurally-clean EPUB of the same book.
 *
 *   node tools/aligner/align-pair.mjs <book.pdf> <book.epub> --out <dir>
 *        [--dpi 200] [--pages 0-54] [--book-id slug]
 *
 * Standalone on purpose. Producing training data from book pairs is a batch
 * job — dozens to hundreds of pairs, no human in the loop per book — so it
 * lives beside the app rather than inside it, reusing BookForge's foundations
 * (mupdf for rendering, the Tesseract hOCR conventions from
 * electron/ocr-service.ts, and the dataset.jsonl record shape from
 * TrainingExportService) without dragging in Electron. Run from the repo root
 * so `mupdf` and `cheerio` resolve.
 *
 * Pipeline: render pages -> Tesseract hOCR -> paragraph blocks -> align each
 * block's text into the EPUB's labeled text stream -> unmatched-block
 * furniture pass (running heads, page numbers) -> dataset.jsonl + report.
 *
 * The alignment is anchor-based, not per-line greedy: unique word 4-grams
 * anchor blocks into the stream, an LIS keeps the main flow monotonic, and
 * off-flow matches are allowed only with strong verification — which is
 * exactly how a footnote at the bottom of a page finds its text in the
 * endnotes section at the back of the EPUB. (Same lesson as the audiobook
 * aligner: pointer-walking loses lock at book scale; anchors don't.)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as mupdf from 'mupdf';
import * as cheerio from 'cheerio';

// ── args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const [pdfPath, epubPath] = positional;
if (!pdfPath || !epubPath) {
  console.error('usage: align-pair.mjs <book.pdf> <book.epub> --out <dir> [--dpi 200] [--pages a-b]');
  process.exit(1);
}
const outDir = opt('out', path.join(process.cwd(), 'align-out'));
const dpi = Number(opt('dpi', '200'));
const bookId = opt('book-id', path.basename(pdfPath).replace(/\.pdf$/i, ''));
const pagesOpt = opt('pages', null);
// OCR language(s), e.g. --lang deu or --lang deu_latf+deu for Fraktur books.
// The 1933 shakedown book scored 18% with the default: blackletter through an
// antiqua model produces character soup no alignment can survive.
const lang = opt('lang', 'eng');
// Optional: write an app-compatible labelling session so the aligned book can
// be opened in BookForge's label mode for review — the human pass that turns
// ranked guesses (weak captions, weak footnotes) into ground truth. Pass the
// PROJECT DIRECTORY; the session lands in ~/Documents/BookForge/training/<dir
// basename>/labels.json, which is where label mode looks for it.
const emitSession = opt('emit-session', null);
fs.mkdirSync(outDir, { recursive: true });

import {
  normTokens, parseEpub, buildStream, align, furniture, LABEL_SET,
} from './align-core.mjs';

// ── 2. PDF pages -> Tesseract hOCR -> paragraph blocks ──────────────────────

function renderPages(file, range) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  const n = doc.countPages();
  const [a, b] = range ? range.split('-').map(Number) : [0, n - 1];
  const scale = dpi / 72;
  const pages = [];
  for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = path.join(outDir, `page-${i}.png`);
    fs.writeFileSync(png, pix.asPNG());
    const [x0, y0, x1, y1] = page.getBounds();
    // WASM heap is not garbage-collected — destroy per page or malloc dies
    // a few hundred pages in.
    pix.destroy();
    page.destroy();
    pages.push({ page: i, png, w: x1 - x0, h: y1 - y0 });
  }
  return pages;
}

const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };

/** hOCR -> paragraph blocks in PDF points. Mirrors electron/ocr-service.ts. */
function ocrPage(pageInfo) {
  const hocr = execFileSync('tesseract',
    [pageInfo.png, 'stdout', '-l', lang, '--oem', '1', '--psm', '3',
     '-c', 'tessedit_create_hocr=1', '-c', `user_defined_dpi=${dpi}`],
    { encoding: 'utf-8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] });

  const scale = dpi / 72;
  const blocks = [];
  for (const parHtml of hocr.split(/<p class='ocr_par'/).slice(1)) {
    const parBody = parHtml.split('</p>')[0];
    const bbox = /title="bbox (\d+) (\d+) (\d+) (\d+)/.exec(parHtml);
    if (!bbox) continue;
    const lines = [];
    const xsizes = [];
    let confSum = 0, confN = 0;
    for (const lineHtml of parBody.split(/<span class='ocr_line'|<span class='ocr_header'|<span class='ocr_caption'|<span class='ocr_textfloat'/).slice(1)) {
      const xs = num(/x_size ([\d.]+)/, lineHtml);
      if (xs) xsizes.push(xs);
      const words = [];
      for (const w of lineHtml.matchAll(/<span class='ocrx_word'[^>]*title='[^']*x_wconf (\d+)[^']*'[^>]*>([\s\S]*?)<\/span>/g)) {
        confSum += Number(w[1]); confN++;
        const t = w[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
        if (t) words.push(t);
      }
      if (words.length) lines.push(words.join(' '));
    }
    // hyphen-join across line breaks, then flatten
    let text = '';
    for (const l of lines) text = text ? (/[-‐‑]$/.test(text) ? text.slice(0, -1) + l : text + ' ' + l) : l;
    if (!text.trim()) continue;
    xsizes.sort((p, q) => p - q);
    blocks.push({
      page: pageInfo.page,
      x: Number(bbox[1]) / scale, y: Number(bbox[2]) / scale,
      w: (Number(bbox[3]) - Number(bbox[1])) / scale, h: (Number(bbox[4]) - Number(bbox[2])) / scale,
      text, lineCount: lines.length,
      fsize: xsizes.length ? xsizes[Math.floor(xsizes.length / 2)] / scale : 0,
      conf: confN ? confSum / confN / 100 : 0,
      pageW: pageInfo.w, pageH: pageInfo.h,
    });
  }
  return blocks;
}

// ── session emission (review bridge into the app's label mode) ──────────────

function writeSession(projectDir, blocks, results, segments, allPageDims) {
  const os = { homedir: () => process.env.HOME || process.env.USERPROFILE };
  const slug = path.basename(projectDir.replace(/[\/]+$/, ''));
  const dir = path.join('/Volumes/Callisto/training/rubric', slug);
  const target = path.join(dir, 'labels.json');
  if (fs.existsSync(target)) {
    console.error(`[aligner] REFUSING to overwrite existing session: ${target}`);
    console.error('[aligner] reset it from the app (or delete the file) first.');
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const sessionBlocks = [];
  const labels = {};
  blocks.forEach((b, i) => {
    const id = `ocr_p${b.page}_align_${i}`;
    const r = results[i];
    const cat = r.furniture ?? (r.matched && r.segIndex != null ? segments[r.segIndex].cat : null);
    sessionBlocks.push({
      id, page: b.page, x: b.x, y: b.y, width: b.w, height: b.h,
      text: b.text, font_size: Math.round(b.fsize * 10) / 10 || 10, font_name: 'OCR',
      char_count: b.text.length, region: 'body', category_id: cat ?? 'body',
      line_count: b.lineCount, is_ocr: true, ocr_confidence: b.conf,
    });
    if (cat) labels[id] = cat;
  });
  const session = {
    version: 1,
    labelSet: LABEL_SET,
    savedAt: new Date().toISOString(),
    sourceFile: path.resolve(pdfPath),
    blockSource: 'ocr',
    ocrEngine: 'tesseract',
    pageDimensions: allPageDims,
    blocks: sessionBlocks,
    labels,
  };
  fs.writeFileSync(target, JSON.stringify(session, null, 1));
  console.log(`[aligner] session written -> ${target}`);
  console.log('[aligner] open the book with its Label button to review the aligned labels.');
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`[aligner] EPUB: parsing ${path.basename(epubPath)}`);
const segments = parseEpub(epubPath);
const segStats = {};
for (const s of segments) segStats[s.cat] = (segStats[s.cat] || 0) + 1;
console.log(`[aligner]   ${segments.length} segments:`, segStats);

const stream = buildStream(segments);
console.log(`[aligner]   stream: ${stream.words.length} words`);

console.log(`[aligner] PDF: rendering + OCR at ${dpi}dpi`);
const wholeDoc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), 'application/pdf');
const allPageDims = [];
for (let i = 0; i < wholeDoc.countPages(); i++) {
  const [x0, y0, x1, y1] = wholeDoc.loadPage(i).getBounds();
  allPageDims.push({ width: x1 - x0, height: y1 - y0 });
}
const pages = renderPages(pdfPath, pagesOpt);
let blocks = [];
for (const p of pages) {
  blocks.push(...ocrPage(p));
  process.stdout.write(`\r[aligner]   page ${p.page} (${blocks.length} blocks)`);
}
console.log();
blocks.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

console.log(`[aligner] aligning ${blocks.length} blocks against ${stream.words.length} words`);
const results = align(blocks, stream);
furniture(blocks, results, segments);

// ── emit ─────────────────────────────────────────────────────────────────────

const catCount = {};
let matched = 0;
const records = [];
const byPage = new Map();
blocks.forEach((b, i) => {
  if (!byPage.has(b.page)) byPage.set(b.page, []);
  byPage.get(b.page).push([b, results[i]]);
});

for (const [pageNum, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
  const rec = {
    book: bookId, page: pageNum, pages: pages.length,
    pageWidth: Math.round(list[0][0].pageW), pageHeight: Math.round(list[0][0].pageH),
    blocks: [], labels: {}, aligned: [], human: [],
  };
  list.forEach(([b, r], j) => {
    const i = j + 1;
    rec.blocks.push({
      i,
      bbox: [b.x / b.pageW, b.y / b.pageH, (b.x + b.w) / b.pageW, (b.y + b.h) / b.pageH].map(v => Math.round(v * 1000) / 1000),
      fsize: Math.round(b.fsize * 10) / 10,
      lines: b.lineCount, chars: b.text.length,
      conf: Math.round(b.conf * 100) / 100,
      // Must match gather-corpus.mjs's cap: aligned books and session books
      // land in the same corpus, and a shorter cap on one side would show up
      // as a train/eval distribution difference rather than as missing text.
      text: b.text.slice(0, 400),
    });
    const cat = r.furniture ?? (r.matched && r.segIndex != null ? segments[r.segIndex].cat : null);
    if (r.why) rec.blocks[rec.blocks.length - 1].why = r.why;
    if (cat) {
      rec.labels[i] = cat;
      rec.aligned.push(i);
      catCount[cat] = (catCount[cat] || 0) + 1;
      matched++;
    }
  });
  records.push(rec);
}

fs.writeFileSync(path.join(outDir, 'dataset.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');

// Provenance. A dataset.jsonl alone cannot say which edition produced it, and
// books like these have several near-identical prints (312 vs 314 pages) whose
// PDFs are NOT interchangeable. Without this, re-deriving a dataset months
// later means guessing which file to align against.
fs.writeFileSync(path.join(outDir, 'source.json'), JSON.stringify({
  bookId, pdf: path.resolve(pdfPath), epub: path.resolve(epubPath),
  dpi, lang, pages: pages.length, pagesOpt,
  blocks: blocks.length, labeled: matched,
  alignedAt: new Date().toISOString(),
}, null, 2));

const unmatchedSamples = blocks
  .map((b, i) => ({ b, r: results[i] }))
  .filter(x => !x.r.matched)
  .slice(0, 12)
  .map(x => `p${x.b.page} :: ${x.b.text.slice(0, 70)}`);

const tierCount = {};
results.forEach(r => { if (r.why) tierCount[r.why] = (tierCount[r.why] || 0) + 1; });
const weak = Object.entries(tierCount).filter(([k]) => k.startsWith('weak:'));
console.log(`\n[aligner] labeled ${matched}/${blocks.length} blocks (${(100 * matched / blocks.length).toFixed(1)}%)`);
if (Object.keys(tierCount).length) console.log('[aligner] elimination tiers:', tierCount);
if (weak.length) console.log('[aligner] REVIEW FIRST (weak tiers):', Object.fromEntries(weak));
console.log('[aligner] by category:', catCount);
console.log('[aligner] unmatched sample:');
for (const s of unmatchedSamples) console.log('   ', s);
console.log(`\n[aligner] wrote ${records.length} page records -> ${path.join(outDir, 'dataset.jsonl')}`);
if (emitSession) writeSession(emitSession, blocks, results, segments, allPageDims);

// page images are working artifacts, not output
for (const p of pages) { try { fs.unlinkSync(p.png); } catch { /* keep going */ } }

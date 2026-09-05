#!/usr/bin/env node
/**
 * epub-derived-to-corpus — turn a derived book into one the Training tab opens.
 *
 *   node tools/epub-derived-to-corpus.js --book deathstalker [--pdf <path>] [--force]
 *
 * EPUB-derived labels are produced by aligning a scan's OCR blocks against the
 * publisher's own markup, so the class comes from what the content IS rather
 * than from anyone's judgement of how it looks. That makes them cheap and
 * plentiful — and unreviewed. They live in
 * `training/epub-derived/<book>/derivation.debug.jsonl`, a flat block log with
 * no home in the picker, so nobody has ever LOOKED at one.
 *
 * This writes that log out as an ordinary corpus book — `labels.json` plus
 * `book.json` under `training/<slug>/` — which is the one shape the Training tab
 * lists and the picker opens. The point is review: derived labels are a claim,
 * and the fastest way to find out whether the deriver is right is to page
 * through it against the scan.
 *
 * PAGE DIMENSIONS ARE FILLED TO THE PDF'S FULL LENGTH. Derivation covers a slice
 * (Deathstalker is pages 100-159 of a longer book), but the picker refuses to
 * save a book whose page count disagrees with the PDF — rightly, since that
 * normally means the blocks came from a different document. Pages outside the
 * derived range get the median page size and no blocks, which is true: nothing
 * was derived there.
 *
 * Blocks carrying `label: null` are written WITHOUT a label rather than dropped.
 * They are the blocks the deriver could not place, and they are exactly what a
 * reviewer needs to see — a page missing a third of its rectangles looks like a
 * clean page, not an incomplete one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TRAINING = '/Volumes/Callisto/training/rubric';
const DERIVED = path.join(TRAINING, 'epub-derived');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

function usage(msg) {
  if (msg) console.error(`epub-derived-to-corpus: ${msg}`);
  console.error(
    'usage: node tools/epub-derived-to-corpus.js --book <name> [--pdf <path>]\n' +
    '         [--slug <dir-name>] [--force]\n\n' +
    '  --book   a directory under /Volumes/Callisto/training/rubric/epub-derived/\n' +
    '  --pdf    the scan these blocks were recognized from. Optional: without it\n' +
    '           the book still lists, and says its document is missing.\n' +
    '  --force  overwrite an existing corpus book of the same slug.');
  process.exitCode = msg ? 1 : 0;
}
if (flag('help') || !argv.length) { usage(); return; }

const book = opt('book');
if (!book) { usage('--book is required'); return; }
const debugFile = path.join(DERIVED, book, 'derivation.debug.jsonl');
if (!fs.existsSync(debugFile)) { usage(`no derivation.debug.jsonl in ${path.join(DERIVED, book)}`); return; }

const derivation = (() => {
  const f = path.join(DERIVED, book, 'derivation.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
})();
const slug = opt('slug', derivation.slug || `${book}-epub-derived`);
const outDir = path.join(TRAINING, slug);
if (fs.existsSync(outDir) && !flag('force')) {
  usage(`${outDir} already exists — pass --force to overwrite it`);
  return;
}

const pdfPath = opt('pdf', null);
if (pdfPath && !fs.existsSync(pdfPath)) { usage(`no such PDF: ${pdfPath}`); return; }

/** Total pages in the PDF, so pageDimensions can be the length the picker expects. */
function pdfPageCount(file) {
  try {
    const out = execFileSync('mutool', ['info', file], { encoding: 'utf-8', maxBuffer: 8 << 20 });
    const m = /^Pages:\s*(\d+)/m.exec(out);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

const rows = fs.readFileSync(debugFile, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
if (!rows.length) { usage('derivation.debug.jsonl is empty'); return; }

const blocks = [];
const labels = {};
const dimsByPage = new Map();
for (const r of rows) {
  dimsByPage.set(r.page, { width: r.pw, height: r.ph });
  blocks.push({
    id: r.id,
    page: r.page,
    x: r.x, y: r.y, width: r.w, height: r.h,
    text: r.text ?? '',
    font_size: r.fsize ?? 0,
    font_name: 'OCR',
    char_count: (r.text ?? '').length,
    region: 'body',
    // The OCR heuristic's guess, kept as the starting paint — NOT as a label.
    category_id: r.ocr_cat ?? 'body',
    line_count: r.lines,
    is_ocr: true,
    ocr_confidence: r.conf,
  });
  if (r.label) labels[r.id] = r.label;
}
blocks.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

const derivedPages = [...dimsByPage.keys()].sort((a, b) => a - b);
const total = (pdfPath && pdfPageCount(pdfPath)) || (derivedPages[derivedPages.length - 1] + 1);
const widths = [...dimsByPage.values()].map(d => d.width).sort((a, b) => a - b);
const heights = [...dimsByPage.values()].map(d => d.height).sort((a, b) => a - b);
const median = {
  width: widths[Math.floor(widths.length / 2)],
  height: heights[Math.floor(heights.length / 2)],
};
const pageDimensions = Array.from({ length: total }, (_, i) => dimsByPage.get(i) ?? median);

fs.mkdirSync(outDir, { recursive: true });

const session = {
  version: 1,
  // The thirteen in force now. Derived labels are produced against the current
  // taxonomy by construction — the deriver has no way to emit a retired class.
  labelSet: ['body', 'title', 'chapter', 'heading', 'subheading', 'quote', 'caption',
    'footnote', 'header', 'footer', 'image', 'table', 'list'],
  savedAt: new Date().toISOString(),
  sourceFile: pdfPath ? path.resolve(pdfPath) : undefined,
  blockSource: 'ocr',
  ocrEngine: 'tesseract',
  pageDimensions,
  blocks,
  labels,
};
const write = (name, value, indent) => {
  const f = path.join(outDir, name);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(value, null, indent), 'utf-8');
  fs.renameSync(`${f}.tmp`, f);
  return f;
};
write('labels.json', session, 1);
write('book.json', {
  title: derivation.book || book,
  pdfPath: pdfPath ? path.resolve(pdfPath) : '',
  addedAt: session.savedAt,
}, 2);

const byClass = {};
for (const c of Object.values(labels)) byClass[c] = (byClass[c] || 0) + 1;
console.log(`epub-derived-to-corpus: ${slug}`);
console.log(`  ${blocks.length} blocks over ${derivedPages.length} derived pages ` +
  `(${derivedPages[0]}-${derivedPages[derivedPages.length - 1]}), padded to ${total} pages`);
console.log(`  ${Object.keys(labels).length} labelled, ${blocks.length - Object.keys(labels).length} left blank ` +
  `(the deriver could not place them — visible in the editor, which is the point)`);
console.log(`  ${Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(' ')}`);
console.log(`  → ${outDir}`);
if (!pdfPath) {
  console.log('  NO PDF RECORDED. It will list in the Training tab and say its document is ' +
    'missing; drop the scan into the folder above, or re-run with --pdf.');
}

#!/usr/bin/env node
/**
 * gather-corpus — merge every labeled training source into one corpus.
 *
 *   node tools/aligner/gather-corpus.mjs [--out <dir>]
 *
 * Sources:
 *   ~/Documents/BookForge/training/<slug>/labels.json     (label-mode sessions)
 *   ~/Documents/BookForge/training/aligned/<id>/dataset.jsonl  (aligner books)
 *
 * Sessions are converted to the aligner's page-record shape so the corpus is
 * uniform. Split is BY BOOK, never by page; variant datasets of the same book
 * (gods-people-*) share one book identity so they can never straddle the
 * train/eval boundary.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const root = path.join(os.homedir(), 'Documents', 'BookForge', 'training');
const outDir = opt('out', path.join(root, 'corpus'));
fs.mkdirSync(outDir, { recursive: true });

// Held-out eval books — chosen for diversity (rough scan + endnotes,
// born-digital + lists, aligned footnote book), leaving every class
// represented on both sides of the split.
//
// Niemoller was added once the class counts were tabulated: without it eval
// contained ZERO `table`, so table accuracy — a stated priority — could not be
// measured at all (79% of tables are in Pohl, which has to stay in train to
// learn the class). Niemoller carries 78 tables, enough for a per-class score,
// and leaves 345 in train. It is also the only German book, so this split
// trains on English and tests on German: a free check that the model keys on
// layout and structure rather than on language.
// was-hitler-an-atheist was moved OUT of eval: it is a Vellum book in the same
// house style as gods-people and understanding-jw, both of which are in train,
// so it was never really held out. Re-aligning it also surfaced 330 `list`
// blocks (the <li> mapping postdates the original alignment), which had left
// list inverted at 570 eval / 319 train.
const EVAL_BOOKS = new Set(['twisted-cross', 'from-dictatorship-to-democracy-gene-sharp-2010',
  'evangelical-kirch-leaders-with-hitler-niemoller-']);

// Excluded from the corpus entirely — unreliable provenance/quality
// (Evans: pre-convention in-app session mid-recovery; Animal Farm: weak
// conversion-PDF pair). Sessions stay on disk; they are just not gathered.
const EXCLUDE_BOOKS = new Set(['the-coming-of-the-third-reich-richard-j-evans-20',
  'animal-farm-george-orwell-1999']);

/** Book identity for splitting: variants of one text collapse to one id. */
function bookId(name) {
  const n = name.toLowerCase();
  if (n.startsWith('gods-people')) return 'gods-people';
  if (n.includes('twisted_cross') || n.includes('twisted-cross')) return 'twisted-cross';
  if (n.includes('gospel_of_lies') || n.includes('gospel-of-lies')) return 'gospel-of-lies';
  if (n.includes('understanding-jw')) return 'understanding-jw';
  if (n.includes('hitler-an-atheist') || n.includes('was-hitler')) return 'was-hitler-an-atheist';
  return n.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

const records = [];

// 1. Label-mode sessions -> page records
for (const slug of fs.readdirSync(root)) {
  const file = path.join(root, slug, 'labels.json');
  if (slug === 'aligned' || slug === 'corpus' || !fs.existsSync(file)) continue;
  const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const book = bookId(slug);
  const byPage = new Map();
  for (const b of s.blocks) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b);
  }
  for (const [pageNum, pageBlocks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const dim = s.pageDimensions?.[pageNum] ?? { width: 612, height: 792 };
    const sorted = [...pageBlocks].sort((a, b) => a.y - b.y || a.x - b.x);
    const rec = {
      book, source: 'session', page: pageNum, pages: s.pageDimensions?.length ?? byPage.size,
      pageWidth: Math.round(dim.width), pageHeight: Math.round(dim.height),
      blocks: [], labels: {}, human: [],
    };
    sorted.forEach((b, j) => {
      const i = j + 1;
      rec.blocks.push({
        i,
        bbox: [b.x / dim.width, b.y / dim.height, (b.x + b.width) / dim.width, (b.y + b.height) / dim.height]
          .map(v => Math.round(v * 1000) / 1000),
        fsize: b.font_size, lines: b.line_count || 1, chars: b.char_count,
        conf: Math.round((b.ocr_confidence ?? 1) * 100) / 100,
        // Generous cap: the corpus is the archive, and the SFT builder decides
        // the final text budget. 90 chars truncated 51% of blocks and threw
        // away the tails (trailing page numbers separate a TOC entry from a
        // chapter opening) with no way to recover them short of re-labeling.
        text: (b.text || '').slice(0, 400),
      });
      rec.labels[i] = s.labels[b.id];
      rec.human.push(i);          // session labels are reviewed ground truth
    });
    records.push(rec);
  }
}

// 2. Aligned datasets (already page records)
const alignedDir = path.join(root, 'aligned');
if (fs.existsSync(alignedDir)) {
  for (const d of fs.readdirSync(alignedDir)) {
    const file = path.join(alignedDir, d, 'dataset.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      rec.book = bookId(d);
      rec.variant = d;
      rec.source = 'aligned';
      records.push(rec);
    }
  }
}

// 3. Split + manifest
const classCounts = { train: {}, eval: {} };
const bookStats = {};
let trainN = 0, evalN = 0;
const out = { train: [], eval: [] };
for (const rec of records) {
  if (EXCLUDE_BOOKS.has(rec.book)) continue;
  const side = EVAL_BOOKS.has(rec.book) ? 'eval' : 'train';
  rec.split = side;
  out[side].push(rec);
  const labeled = Object.values(rec.labels).filter(Boolean);
  for (const c of labeled) classCounts[side][c] = (classCounts[side][c] || 0) + 1;
  if (!bookStats[rec.book]) bookStats[rec.book] = { pages: 0, blocks: 0, split: side, sources: new Set() };
  bookStats[rec.book].pages += 1;
  bookStats[rec.book].blocks += labeled.length;
  bookStats[rec.book].sources.add(rec.variant ?? rec.source);
  side === 'train' ? trainN++ : evalN++;
}
for (const b of Object.values(bookStats)) b.sources = [...b.sources];

fs.writeFileSync(path.join(outDir, 'train.jsonl'), out.train.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'eval.jsonl'), out.eval.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  generated: null,     // stamp externally if needed
  books: bookStats, pages: { train: trainN, eval: evalN }, classCounts,
}, null, 2));
console.log(`books: ${Object.keys(bookStats).length}, pages train/eval: ${trainN}/${evalN}`);
console.log('train classes:', classCounts.train);
console.log('eval classes:', classCounts.eval);
console.log(`wrote ${outDir}/{train.jsonl,eval.jsonl,manifest.json}`);

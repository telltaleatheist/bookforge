#!/usr/bin/env node
/**
 * gather-corpus — merge every labeled training source into one corpus.
 *
 *   node tools/aligner/gather-corpus.mjs [--out <dir>]
 *
 * Sources:
 *   /Volumes/Callisto/training/rubric/<slug>/labels.json     (label-mode sessions)
 *   /Volumes/Callisto/training/rubric/aligned/<id>/dataset.jsonl  (aligner books)
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
// The corpus master moved off iCloud (Aug 1 2026) — ~/Documents/BookForge/training
// was verified onto Callisto and deleted. See electron/training-data.ts.
const root = '/Volumes/Callisto/training/rubric';
const outDir = opt('out', path.join(root, 'corpus'));
fs.mkdirSync(outDir, { recursive: true });

// ── WHAT GOES IN, stated explicitly ────────────────────────────────────────
//
// An ALLOW-LIST, not a deny-list. It used to be the other way round, and that
// stopped being safe the night the Training tab arrived: a corpus book is now
// anything with a labels.json, and seven of those are labelled BY THE MODEL —
// pre-labelled with rubric-v4 and not yet reviewed by anyone. Under the old
// "gather everything except X" rule all seven would have been swept into
// training as ground truth, silently, teaching v5 its predecessor's mistakes.
//
// So a book earns its place by being named here, and the only way to be named
// is for a human to have gone through it. Adding a book is one line; forgetting
// to exclude one is a corpus you cannot trust.
//
// Reviewed and corrected by hand, Jul 30 2026:
const INCLUDE_BOOKS = new Set([
  'animal-farm-george-orwell-1999',
  'ethnic-cleansing-in-the-ussr-1937-1949-otto-pohl',
  'for-the-soul-of-the-people-victoria-barnett-1998',
  'from-dictatorship-to-democracy-gene-sharp-2010',
  'gospel-of-lies',
  'hitlers-priests-catholic-clergy-and-national-soc',
  'nuremberg-infamy-on-trial-persico-joseph-e-unkno',
  'satanic-panic-pop-cultural-paranoia-in-the-1980s',
  'the-churches-and-the-third-reich-volume-2-schold',
  'the-coming-of-the-third-reich-richard-j-evans-20',
  'the-holy-reich-richard-steigmann-gall-steigmann-',
  'twisted-cross',
  // Aligner books, derived rather than hand-labelled. Kept because they were in
  // the v4 training set and dropping them would cut 36% of the rows, which would
  // confound the v4-vs-v5 comparison with a corpus-size change.
  'gods-people',
  'understanding-jw',
  'was-hitler-an-atheist',
]);

// EVANGELICAL KIRCH (Niemoller) IS DELIBERATELY ABSENT, and it used to be an
// eval book. It is the corpus's only German title and the labeller does not read
// German; reviewing the English books turned up real errors in every one, so its
// labels cannot be assumed sound. An eval set nobody can verify is worse than a
// smaller one, because it silently misreports every score computed against it.
//
// The cost is real and was measured: Niemoller carried 108 of eval's 113 `table`
// blocks. That is survivable ONLY because `table` is now merged into `list` at
// SFT build time (--merge-table-into-list) — nothing downstream ever
// distinguished the two, and `table` had scored 0.00 F1 since it was introduced.
// If the merge is ever reverted, eval needs a table-bearing book held out again.
const EVAL_BOOKS = new Set([
  'twisted-cross',
  'from-dictatorship-to-democracy-gene-sharp-2010',
]);

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
const skipped = [];

// 1. Label-mode sessions -> page records
for (const slug of fs.readdirSync(root)) {
  const file = path.join(root, slug, 'labels.json');
  if (slug === 'aligned' || slug === 'corpus' || !fs.existsSync(file)) continue;
  const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const book = bookId(slug);
  if (!INCLUDE_BOOKS.has(book)) { skipped.push(book); continue; }
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
  // The allow-list applies to the aligner datasets too, which arrive by a
  // different route (step 2) and would otherwise bypass it entirely.
  if (!INCLUDE_BOOKS.has(rec.book)) { if (!skipped.includes(rec.book)) skipped.push(rec.book); continue; }
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
// Named, never silent: a book missing from the corpus because it is not on the
// allow-list looks exactly like a book that was lost, and the difference matters.
if (skipped.length) {
  console.log(`skipped ${skipped.length} not on the allow-list: ${skipped.sort().join(', ')}`);
}
console.log('train classes:', classCounts.train);
console.log('eval classes:', classCounts.eval);
console.log(`wrote ${outDir}/{train.jsonl,eval.jsonl,manifest.json}`);

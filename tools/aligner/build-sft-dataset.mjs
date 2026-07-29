#!/usr/bin/env node
/**
 * build-sft-dataset — corpus page records -> chat JSONL for orpheus-finetune's
 * text_sft trainer.
 *
 *   node tools/aligner/build-sft-dataset.mjs [--in <corpusDir>] [--out <dir>]
 *
 * Emits {train,eval}.jsonl in the shape text_sft.py demands:
 *   {"messages": [{role: system}, {role: user}, {role: assistant}]}
 * with the assistant message last (the trainer rejects anything else) and
 * assistant-only loss, so only the label block carries gradient.
 *
 * One conversation = one PAGE. Page is the training unit because a block's
 * class depends on its neighbours (a lone line is a heading or a footer
 * depending on what sits above it) but not on the rest of the book.
 *
 * FEATURES ARE NORMALIZED PER BOOK, not sent raw:
 *
 *  - Font size as a RATIO to the book's modal size. Measured across the 13
 *    corpus books, modal body size runs 7 to 16 — a 2.3x spread driven by scan
 *    DPI, not typography. Raw `fs9` therefore means "body" in one book and
 *    "small print" in another. The ratio is available at inference too: the
 *    whole book is OCR'd before classification, so the modal size is a free
 *    first pass.
 *  - Vertical gap above each block in units of the book's modal LEADING.
 *    Whitespace is the primary heading signal, and while it is implicit in the
 *    bboxes, differencing decimals is exactly what a language model is worst
 *    at. "2.4 lines of space above" is the fact we actually want it to use.
 *  - Block text as HEAD + TAIL, never the middle. The head carries note
 *    numbers and "Figure 3.1"; the tail carries the trailing page number that
 *    separates a TOC entry ("Chapter 3 ..... 47") from a chapter opening; the
 *    middle of a body paragraph carries nothing.
 *
 * The trainer REFUSES to truncate over-length conversations, so --stats
 * reports the length distribution that decides max_seq_length.
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
const inDir = opt('in', path.join(root, 'corpus'));
const outDir = opt('out', path.join(root, 'sft'));
const HEAD = Number(opt('head', '200'));
const TAIL = Number(opt('tail', '60'));
fs.mkdirSync(outDir, { recursive: true });

const CATEGORIES = [
  'body', 'title', 'chapter', 'heading', 'subheading', 'quote', 'caption',
  'footnote', 'footnote_ref', 'header', 'footer', 'image', 'front_matter',
  'back_matter', 'table', 'list',
];

// Kept deliberately short. A fine-tuned model learns the conventions from the
// data; a full copy of LABELING.md on every one of ~4.4k examples would just
// spend sequence budget that the block list needs. It states the task, the
// legal outputs, and the output shape — nothing the data can teach instead.
const SYSTEM = `You classify text blocks on a scanned book page so an EPUB can be rebuilt with correct structure.

You receive the page's position in the book, its dimensions, and one line per OCR block:
  <id> <x0,y0,x1,y1> fs<size vs book body text> g<blank lines above> l<lines> c<chars> q<ocr confidence> | <text>
Coordinates are fractions of the page (0-1), origin top-left. fs1.00 is normal
body type; fs2.10 is roughly double. Long text is shown as head … tail.

Label every block with exactly one of:
${CATEGORIES.join(', ')}

Reply with one line per block, "<id> <category>", in the order given. No other text.`;

/** Read one split into memory; the per-book stats need a pass over everything. */
function readSplit(split) {
  const src = path.join(inDir, `${split}.jsonl`);
  return fs.readFileSync(src, 'utf-8').split('\n')
    .filter(l => l.trim()).map(l => JSON.parse(l));
}

const splits = { train: readSplit('train'), eval: readSplit('eval') };

/** Scale key = one physical PDF. Variants of a book are separate scans with
 *  their own type size, so they must not share a normalizer. */
const scaleKey = rec => rec.variant ?? rec.book;

// ── per-book normalizers ─────────────────────────────────────────────────────
const scales = new Map();
for (const recs of Object.values(splits)) {
  for (const rec of recs) {
    const key = scaleKey(rec);
    if (!scales.has(key)) scales.set(key, { fsWeight: new Map(), leading: [] });
    const s = scales.get(key);
    for (const b of rec.blocks ?? []) {
      // Char-weighted so body type wins the mode even on pages dominated by
      // short furniture blocks.
      const bucket = Math.round(b.fsize * 2) / 2;
      s.fsWeight.set(bucket, (s.fsWeight.get(bucket) ?? 0) + (b.chars || 1));
      if (b.lines >= 2) {
        const heightPx = (b.bbox[3] - b.bbox[1]) * rec.pageHeight;
        s.leading.push(heightPx / b.lines);
      }
    }
  }
}
const norm = new Map();
for (const [key, s] of scales) {
  const modalFsize = [...s.fsWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 1;
  const lead = s.leading.sort((a, b) => a - b);
  const modalLeading = lead.length ? lead[Math.floor(lead.length / 2)] : 1;
  norm.set(key, { modalFsize, modalLeading });
}

/** Long text -> head … tail. Middles of body paragraphs carry no class signal;
 *  the two ends carry almost all of it. */
function clipText(t) {
  const text = (t || '').replace(/\s+/g, ' ').trim();
  if (text.length <= HEAD + TAIL + 3) return text;
  return `${text.slice(0, HEAD)} … ${text.slice(-TAIL)}`;
}

function blockLine(b, prev, rec, n) {
  const bbox = b.bbox.map(v => v.toFixed(3)).join(',');
  const fs_ = (b.fsize / n.modalFsize).toFixed(2);
  // Gap above, in blank lines. First block on the page measures from the top
  // edge — "how deep does the text start" is the drop that marks a chapter
  // opener. Negative means the block sits beside its predecessor, not below.
  const topPx = b.bbox[1] * rec.pageHeight;
  const prevBottomPx = prev ? prev.bbox[3] * rec.pageHeight : 0;
  const gap = ((topPx - prevBottomPx) / n.modalLeading).toFixed(1);
  return `${b.i} ${bbox} fs${fs_} g${gap} l${b.lines} c${b.chars} q${b.conf} | ${clipText(b.text)}`;
}

function toConversation(rec) {
  const blocks = [...rec.blocks].sort((a, b) => a.i - b.i);
  // A page whose blocks are not all labeled would teach the model to skip
  // blocks; drop it rather than emit a partial target.
  const labels = blocks.map(b => rec.labels[b.i] ?? rec.labels[String(b.i)]);
  if (labels.some(l => !l)) return null;
  const bad = labels.filter(l => !CATEGORIES.includes(l));
  if (bad.length) throw new Error(`unknown category in ${rec.book} p${rec.page}: ${bad}`);

  const n = norm.get(scaleKey(rec));
  const pct = rec.pages ? Math.round((rec.page / rec.pages) * 100) : 0;
  const lines = blocks.map((b, j) => blockLine(b, j ? blocks[j - 1] : null, rec, n));
  const user = [
    `page ${rec.page + 1} of ${rec.pages} (${pct}% through the book), `
      + `${rec.pageWidth}x${rec.pageHeight}, ${blocks.length} blocks`,
    '',
    ...lines,
  ].join('\n');
  const assistant = blocks.map((b, i) => `${b.i} ${labels[i]}`).join('\n');

  // book/page ride along for the eval harness's per-book breakdown.
  // text_sft.py's reader keeps only the messages field, so extra keys are inert
  // during training.
  return {
    book: rec.book, page: rec.page,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ],
  };
}

const stats = {};
for (const [split, recs] of Object.entries(splits)) {
  const rows = [];
  let dropped = 0;
  const charLens = [];
  for (const rec of recs) {
    if (!rec.blocks?.length) { dropped++; continue; }
    const conv = toConversation(rec);
    if (!conv) { dropped++; continue; }
    rows.push(conv);
    charLens.push(conv.messages.reduce((n, m) => n + m.content.length, 0));
  }
  fs.writeFileSync(path.join(outDir, `${split}.jsonl`),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  charLens.sort((a, b) => a - b);
  const at = p => charLens[Math.min(charLens.length - 1, Math.floor(charLens.length * p))];
  stats[split] = {
    rows: rows.length, droppedPages: dropped,
    chars: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: charLens[charLens.length - 1] },
  };
  console.log(`${split}: ${rows.length} conversations (${dropped} pages dropped)`);
  console.log(`  chars p50=${at(0.5)} p90=${at(0.9)} p99=${at(0.99)} max=${charLens[charLens.length - 1]}`);
}
stats.normalizers = Object.fromEntries([...norm].map(([k, v]) => [k, {
  modalFsize: v.modalFsize, modalLeading: Math.round(v.modalLeading * 10) / 10,
}]));
fs.writeFileSync(path.join(outDir, 'build-stats.json'), JSON.stringify(stats, null, 2));
console.log(`wrote ${outDir}/{train,eval}.jsonl`);

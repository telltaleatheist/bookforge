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
 * V2 FEATURES (added after run v1 scored macro-F1 0.47; every one targets a
 * class the v1 confusion matrix showed failing, and every one is derived
 * LABEL-FREE so it is equally computable at inference time):
 *
 *  - GAP BELOW (`d`). v1 sent only gap-above, which was the wrong half:
 *    measured, subheading and heading overlap on gap-above (1.44 vs 2.10) but
 *    separate 3x on gap-below (0.40 vs 1.26) — a subheading sits tight against
 *    the text it introduces. It also separates `chapter`, the only class with
 *    NEGATIVE asymmetry (more space below than above, -0.41).
 *  - REPEAT RATE (`r`). Fraction of the book's pages carrying near-identical
 *    text in the same 5% vertical band. Measured: header repeats on 34 pages
 *    against 1 for body — near-perfect separation, and v1's `footer` scored
 *    precision .99 / recall .49 purely for want of it. Digits normalize to `#`
 *    so a page number is the SAME text on every page, which is what makes a
 *    bare folio detectable at all.
 *  - ENVELOPE POSITION (`t`). Vertical position relative to the book's own
 *    text block, not the paper edge: 0 = body top, 1 = body bottom, negative =
 *    above the running text, >1 = below it. Absolute page fractions are not
 *    comparable across books — Twisted Cross's body starts at 0.039, ABOVE
 *    where Nuremberg's running heads sit (0.066) — so the same y means
 *    different classes in different books. Same lesson as the font ratio.
 *  - INSET (`il`/`ir`). Left and right offset from the body measure, in
 *    measure units. `quote` is DEFINED by symmetric both-side inset (measured
 *    0.052/0.052), and subheading is flush-left (0.001) where heading is
 *    indented (0.235).
 *
 * Still missing, and known: bold/italic/descender (Tesseract's legacy engine
 * emits them but the aligner runs --oem 1), and the column structure that
 * `table` needs — line-level x-runs the corpus does not carry. Both need a
 * re-OCR pass, so `table` is expected to stay weak until v3.
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
const TEXT_BUDGET = Number(opt('text-budget', '4000'));
const MIN_HEAD = Number(opt('min-head', '40'));
fs.mkdirSync(outDir, { recursive: true });

// THIRTEEN, since Jul 2026. `front_matter`/`back_matter` were retired because
// they were defined by POSITION, not appearance — 18% of the corpus assigned by
// `page < firstProsePage` / `page > lastProsePage`, which the model can already
// read off the "47 of 300 (16% through the book)" line it is handed. Their
// blocks now carry what they are: an index is `list`, endnotes are `footnote`,
// a title page is `title`. `footnote_ref` goes too — it had 2 examples in
// 42,759, both superscript note numbers OCR split out of the running text.
//
// This list is INTERPOLATED INTO THE SYSTEM PROMPT, so a stale entry is not
// cosmetic: it advertises a class to the model that no training example ever
// uses, spends prompt tokens on it, and invites it back at inference.
const CATEGORIES = [
  'body', 'title', 'chapter', 'heading', 'subheading', 'quote', 'caption',
  'footnote', 'header', 'footer', 'image', 'table', 'list',
];

// Kept deliberately short. A fine-tuned model learns the conventions from the
// data; a full copy of LABELING.md on every one of ~4.4k examples would just
// spend sequence budget that the block list needs. It states the task, the
// legal outputs, and the output shape — nothing the data can teach instead.
const SYSTEM = `You classify text blocks on a scanned book page so an EPUB can be rebuilt with correct structure.

You receive the page's position in the book, its dimensions, and one line per OCR block:
  <id> <x0,y0,x1,y1> fs<size vs book body text> g<blank lines above> d<blank lines below> t<position in text block> il<left inset> w<width> cx<offset from centre> r<repeats across book> l<lines> c<chars> q<ocr confidence> | <text>
Coordinates are percent of the page, origin top-left, so 12,86,90,94 is a wide
strip near the bottom. fs1.00 is normal body type; fs2.10 is roughly double.
g and d are in lines of body leading.
t is vertical position within the book's text block: t0 is where body text
starts, t100 where it ends, NEGATIVE is above the running text (running heads)
and over 100 is below it (folios, running feet).
il, w and cx describe the block horizontally against the book's body measure:
il0 is flush with the left margin, w100 spans the full measure, and cx is how
far the block's centre sits from the measure's centre, negative to the left.
A short centred line is w40 cx0; the same line indented is w40 cx-20; a short
flush-left line is il0 w40 cx-30.
r is the percent of the book's pages carrying the same text at the same height:
r80 is page furniture, r0 is unique to this page.
q is OCR confidence in percent. Long text is shown as head … tail.

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
// EVERY normalizer here is derived without reading a single label, because all
// of them have to be recomputed at inference on an unlabeled book. Anything
// that needed the labels would train the model on a feature it can never have.

/** Repetition key, byte-identical to the app's computeRepeatRates so the two
 *  paths can never drift: 5% vertical band + digits collapsed to `#`. The
 *  digit collapse is what lets a bare page number match itself across pages. */
const repeatKey = (b) => {
  const band = Math.round(b.bbox[1] * 20);
  const text = (b.text || '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${band}|${text}`;
};

const pct = (sorted, p) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

const scales = new Map();
for (const recs of Object.values(splits)) {
  for (const rec of recs) {
    const key = scaleKey(rec);
    if (!scales.has(key)) {
      scales.set(key, {
        fsWeight: new Map(), leading: [],
        tops: [], bots: [], lefts: [], rights: [],
        repeats: new Map(), pages: new Set(),
      });
    }
    const s = scales.get(key);
    s.pages.add(rec.page);
    for (const b of rec.blocks ?? []) {
      // Char-weighted so body type wins the mode even on pages dominated by
      // short furniture blocks.
      const bucket = Math.round(b.fsize * 2) / 2;
      s.fsWeight.set(bucket, (s.fsWeight.get(bucket) ?? 0) + (b.chars || 1));
      if (b.lines >= 2) {
        const heightPx = (b.bbox[3] - b.bbox[1]) * rec.pageHeight;
        s.leading.push(heightPx / b.lines);
      }
      // The text envelope and body measure are estimated from RUNNING TEXT
      // only. Three-plus lines is the label-free proxy: furniture is one line,
      // headings are one or two, and a three-line block is prose (or a
      // footnote, which does sit inside the text block anyway).
      if (b.lines >= 3) {
        s.tops.push(b.bbox[1]); s.bots.push(b.bbox[3]);
        s.lefts.push(b.bbox[0]); s.rights.push(b.bbox[2]);
      }
      const rk = repeatKey(b);
      if (!s.repeats.has(rk)) s.repeats.set(rk, new Set());
      s.repeats.get(rk).add(rec.page);
    }
  }
}
const norm = new Map();
for (const [key, s] of scales) {
  const modalFsize = [...s.fsWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 1;
  const lead = s.leading.sort((a, b) => a - b);
  const modalLeading = lead.length ? lead[Math.floor(lead.length / 2)] : 1;
  // Percentiles, not min/max: one skewed OCR box should not redefine the page.
  const tops = s.tops.sort((a, b) => a - b);
  const bots = s.bots.sort((a, b) => a - b);
  const lefts = s.lefts.sort((a, b) => a - b);
  const rights = s.rights.sort((a, b) => a - b);
  const bodyTop = pct(tops, 0.05);
  const bodyBot = pct(bots, 0.95);
  const bodyLeft = pct(lefts, 0.5);
  const bodyRight = pct(rights, 0.5);
  norm.set(key, {
    modalFsize, modalLeading,
    bodyTop, bodyBot, bodyLeft, bodyRight,
    envHeight: (bodyBot - bodyTop) || 1,
    measure: (bodyRight - bodyLeft) || 1,
    repeats: s.repeats, pageCount: Math.max(1, s.pages.size),
  });
}

/** Long text -> head … tail. Middles of body paragraphs carry no class signal;
 *  the two ends carry almost all of it. */
function clipText(t, budget) {
  const head = budget?.head ?? HEAD;
  const tail = budget?.tail ?? TAIL;
  const text = (t || '').replace(/\s+/g, ' ').trim();
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)} … ${text.slice(-tail)}`;
}

/** Per-page text budget. Dense endnote pages run to 83 blocks, and on those the
 *  geometry alone fills the window; giving every block a full 200-char head
 *  would push a single page past max_seq_length, and the trainer REFUSES to
 *  truncate rather than silently dropping the tail. Shrinking the text (never
 *  the geometry) is the right thing to give up: those pages are almost entirely
 *  footnote/back_matter, whose blocks are short and whose class is carried by
 *  position and repetition, not by prose. Ordinary pages are untouched — at the
 *  median 7 blocks the share is 570 chars, well over the 200 cap. */
function textBudget(nBlocks) {
  const share = Math.floor(TEXT_BUDGET / Math.max(1, nBlocks));
  const head = Math.max(MIN_HEAD, Math.min(HEAD, share));
  return { head, tail: Math.max(12, Math.min(TAIL, Math.floor(head * 0.3))) };
}

/** Percent as a small integer. Decimals are a TOKENIZER tax: measured on the
 *  v2 build, "0.159,0.268,0.853,0.380" style lines ran 1.2 chars per token —
 *  every "0.43" costs 3-4 tokens where "43" costs one. Rounding to whole
 *  percent loses ~1% of page width (about 4px at these scan sizes), which the
 *  leading-relative gaps already resolve far more finely than the model needs. */
const ipct = v => String(Math.round(v * 100));

function blockLine(b, prev, next, rec, n, budget) {
  const bbox = b.bbox.map(ipct).join(',');
  const fs_ = (b.fsize / n.modalFsize).toFixed(2);
  // Gap above, in blank lines. First block on the page measures from the top
  // edge — "how deep does the text start" is the drop that marks a chapter
  // opener. Negative means the block sits beside its predecessor, not below.
  const topPx = b.bbox[1] * rec.pageHeight;
  const botPx = b.bbox[3] * rec.pageHeight;
  const prevBottomPx = prev ? prev.bbox[3] * rec.pageHeight : 0;
  const gap = ((topPx - prevBottomPx) / n.modalLeading).toFixed(1);
  // Gap below — the half that actually separates subheading from heading. The
  // last block on the page measures to the bottom edge, mirroring the first.
  const nextTopPx = next ? next.bbox[1] * rec.pageHeight : rec.pageHeight;
  const gapBelow = ((nextTopPx - botPx) / n.modalLeading).toFixed(1);
  // Position within the book's text envelope rather than the sheet of paper.
  const t = ipct((b.bbox[1] - n.bodyTop) / n.envHeight);
  // il / w / cx instead of left+right insets. The four quantities (left inset,
  // right inset, width, centre offset) carry only two degrees of freedom, so
  // sending all four wastes tokens on arithmetic the model shouldn't have to
  // do. These three are the ones that mean something on their own:
  //   il0  flush with the body's left margin
  //   w    how much of the measure the block spans — short vs full line
  //   cx   how far off the body's CENTRE it sits, signed
  // Splitting shortness from off-centredness is what separates a centred
  // heading from an indented one: measured, 93% of subheadings are flush-left
  // against 28% of headings, and headings are 66% CENTRED — a fact invisible
  // in a left-inset number, which centring inflates just as indenting does.
  const il = ipct((b.bbox[0] - n.bodyLeft) / n.measure);
  const w = ipct((b.bbox[2] - b.bbox[0]) / n.measure);
  const cx = ipct(((b.bbox[0] + b.bbox[2]) / 2 - (n.bodyLeft + n.bodyRight) / 2) / n.measure);
  const r = ipct((n.repeats.get(repeatKey(b))?.size ?? 1) / n.pageCount);
  return `${b.i} ${bbox} fs${fs_} g${gap} d${gapBelow} t${t} il${il} w${w} cx${cx} r${r}`
    + ` l${b.lines} c${b.chars} q${ipct(b.conf)} | ${clipText(b.text, budget)}`;
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
  const budget = textBudget(blocks.length);
  const lines = blocks.map((b, j) =>
    blockLine(b, j ? blocks[j - 1] : null, blocks[j + 1] ?? null, rec, n, budget));
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
const r3 = v => Math.round(v * 1000) / 1000;
stats.normalizers = Object.fromEntries([...norm].map(([k, v]) => [k, {
  modalFsize: v.modalFsize, modalLeading: Math.round(v.modalLeading * 10) / 10,
  bodyTop: r3(v.bodyTop), bodyBot: r3(v.bodyBot),
  bodyLeft: r3(v.bodyLeft), bodyRight: r3(v.bodyRight),
  pageCount: v.pageCount,
}]));
fs.writeFileSync(path.join(outDir, 'build-stats.json'), JSON.stringify(stats, null, 2));
console.log(`wrote ${outDir}/{train,eval}.jsonl`);

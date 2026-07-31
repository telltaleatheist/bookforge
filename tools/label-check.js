#!/usr/bin/env node
/**
 * label-check — find wrong page-layout labels with rules, not a model.
 *
 *   node tools/label-check.js --book what-to-expect [--json out.json] [--all]
 *
 * WHY THIS REPLACED THE MODEL AUDIT. A reasoning model was tried first
 * (tools/label-audit.js, cogito 14b and 32b). Both produced flags whose stated
 * reasons were self-contradictory — 32b called a size-15 block "smaller than the
 * main heading" than a size-14 one, and justified moving a page number out of
 * `header` with "page numbers at the top are footers". Roughly one flag in four
 * survived inspection, and the justification is exactly what a human needs to
 * adjudicate, so unreliable reasons make the whole pass untrustworthy.
 *
 * The decisive observation is that EVERY flag either model raised is settled
 * better by a rule. A block labelled `image` that contains text is wrong by
 * definition. Whether a bare folio is a header or a footer is decided by which
 * end of the page it sits on, not by an opinion. A line that begins mid-sentence
 * is a continuation. These are not judgement calls, and a rule states its reason
 * the same way every time.
 *
 * So this reports only what it can PROVE from geometry, text shape and
 * cross-page repetition, and stays silent everywhere else. It is deliberately
 * incomplete: `table` cannot be recovered at all (the ebook channel reflows
 * printed tables into boxes) and heading-vs-subheading LEVEL is genuinely
 * ambiguous. Those need a human, which is the point — this exists to shrink the
 * pile a human reviews, not to replace them.
 *
 * Severity is honest about that split:
 *   error  — provably wrong; the label contradicts the block's own content
 *   warn   — strong positional evidence against the label
 *   note   — worth a glance, no claim made
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const book = opt('book', null);
const corpus = opt('corpus', null);
const jsonOut = opt('json', null);
const showAll = argv.includes('--all');

const TRAINING = path.join(os.homedir(), 'Documents/BookForge/training');

if (book && corpus) {
  console.error('label-check: give --book (an epub-derived book) or --corpus (a labelled ' +
    'corpus book), not both.');
  process.exit(1);
}

/**
 * The two stores this reads, normalised to one row-per-page shape.
 *
 * `--book` is an epub-derived book: dataset.jsonl, already page-shaped with
 * bboxes as page fractions.
 *
 * `--corpus` is a hand-labelled corpus book: labels.json, a flat block list in
 * page POINTS plus the page dimensions to divide by. Worth supporting because
 * every rule here is geometric or textual and none of them read a language —
 * which makes this the one review pass available on a book whose text the
 * labeller cannot read.
 */
function loadCorpusRows(slug) {
  const dir = path.isAbsolute(slug) ? slug : path.join(TRAINING, slug);
  const file = path.join(dir, 'labels.json');
  if (!fs.existsSync(file)) {
    console.error(`label-check: no labels.json in ${dir}`);
    process.exit(1);
  }
  const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const dims = s.pageDimensions || [];
  const byPage = new Map();
  for (const b of s.blocks) {
    const label = (s.labels || {})[b.id];
    if (!label) continue;               // unlabelled blocks make no claim to check
    const d = dims[b.page] || { width: 0, height: 0 };
    if (!d.width || !d.height) continue;
    if (!byPage.has(b.page)) byPage.set(b.page, { page: b.page, blocks: [], labels: {} });
    const row = byPage.get(b.page);
    const i = row.blocks.length;
    row.blocks.push({
      i,
      text: b.text || '',
      fsize: b.font_size || 0,
      // Page fractions, matching the epub-derived shape the rules were written
      // against: [x0, y0, x1, y1].
      bbox: [
        b.x / d.width, b.y / d.height,
        (b.x + b.width) / d.width, (b.y + b.height) / d.height,
      ],
    });
    row.labels[String(i)] = label;
  }
  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

const label = corpus ?? book ?? 'what-to-expect';
const rows = corpus
  ? loadCorpusRows(corpus)
  : fs.readFileSync(path.join(TRAINING, 'epub-derived', label, 'dataset.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map(JSON.parse);

/**
 * `[Image 630x948]` is the extractor's PLACEHOLDER for a block with no text —
 * the string IS the assertion that this block is a picture. Read as text it
 * inverts every rule that asks "does this carry words": it made the image rule
 * fire on 570 correct labels in Coming of the Third Reich, and made the
 * repetition rule call the same placeholder "page furniture" on 657 pages. So
 * it is normalised to empty at the one point where text is read.
 */
const PLACEHOLDER = /^\[Image\s+\d+\s*[x\u00d7]\s*\d+\]$/i;
const textOf = (b) => {
  const t = (b.text || '').replace(/\s+/g, ' ').trim();
  return PLACEHOLDER.test(t) ? '' : t;
};

const findings = [];
const add = (sev, row, b, is, should, why) => findings.push({
  severity: sev, page: row.page, block: b.i, is, should, why,
  text: (b.text || '').replace(/\s+/g, ' ').slice(0, 120),
  bbox: b.bbox, fsize: b.fsize,
});

// ── cross-page repetition ──────────────────────────────────────────────────
// Running heads and feet are the same words in the same place on page after
// page. Normalising away the digits is what makes "YOUR NEWBORN 125" and
// "YOUR NEWBORN 126" the same string, which is the whole signal.
const repeat = new Map();
for (const row of rows) {
  for (const b of row.blocks) {
    const norm = textOf(b).replace(/\d+/g, '#').trim().toLowerCase();
    if (!norm || norm.length > 60) continue;
    const band = b.bbox[1] < 0.12 ? 'top' : b.bbox[3] > 0.88 ? 'bottom' : null;
    if (!band) continue;
    const key = `${band}\t${norm}`;
    if (!repeat.has(key)) repeat.set(key, []);
    repeat.get(key).push({ page: row.page, i: b.i });
  }
}

const TEXTUAL = new Set(['body', 'quote', 'list', 'caption', 'footnote', 'heading',
  'subheading', 'chapter', 'title', 'header', 'footer', 'table']);

for (const row of rows) {
  // A page's own body type size. Comparing against an absolute number is what
  // made the model call a size-14 heading "body" — 14 means nothing until you
  // know this page's body is 9.
  const sizes = row.blocks.filter((b) => (row.labels[String(b.i)] === 'body')).map((b) => b.fsize);
  const bodySize = sizes.length
    ? sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)]
    : null;

  for (const [idx, b] of row.blocks.entries()) {
    const label = row.labels[String(b.i)];
    if (!label) continue;
    const text = textOf(b);
    const [, y0, , y1] = b.bbox;

    // 1. Definitional: an image region has no text of its own.
    //
    // TWO EXCEPTIONS, both learned from Coming of the Third Reich, where this
    // rule fired on 1,001 blocks and was wrong about every one:
    //
    //  - `[Image 630x948]` is the extractor's PLACEHOLDER for a block that has
    //    no text. Reading it as text inverts the rule's meaning: the string is
    //    literally the assertion that this block is an image.
    //  - Words rendered INSIDE a figure — "NORTH SEA", "FRANCE" on a map — are
    //    part of the picture. Labelling the region `image` is what keeps map
    //    furniture out of the narration, so a short all-caps or title-case
    //    fragment is not evidence against it. Only running prose is.
    if (label === 'image' && text.length > 2) {
      const prose = /[.!?,;:]\s/.test(text) || text.split(/\s+/).length >= 8;
      add(prose ? 'error' : 'note', row, b, label, prose ? 'body' : label,
        prose
          ? 'labelled image but carries running prose; an image region has no text of its own'
          : 'labelled image and carries a few words — fine if they are printed inside the figure');
      continue;
    }
    // 2. Definitional: a textual class with no text.
    if (TEXTUAL.has(label) && text.length === 0) {
      add('error', row, b, label, 'image', `labelled ${label} but has no text at all`);
      continue;
    }

    // 3. A bare folio. Which end of the page it sits on decides it — this is the
    //    case both models got wrong, in opposite directions, on the same book.
    if (/^[ivxlcdm]{1,7}$|^\d{1,4}$/i.test(text)) {
      const want = y0 < 0.12 ? 'header' : y1 > 0.88 ? 'footer' : null;
      if (want && label !== want) {
        add('error', row, b, label, want,
          `a bare page number at the ${want === 'header' ? 'top' : 'bottom'} of the page is a ${want}`);
        continue;
      }
    }

    // 4. Page furniture, proven by repetition rather than by looks.
    const norm = text.replace(/\d+/g, '#').toLowerCase();
    const reps = repeat.get(`${y0 < 0.12 ? 'top' : y1 > 0.88 ? 'bottom' : '-'}\t${norm}`) ?? [];
    if (reps.length >= 3 && !['header', 'footer'].includes(label)) {
      const want = y0 < 0.12 ? 'header' : 'footer';
      add('warn', row, b, label, want,
        `the same text appears at the ${want === 'header' ? 'top' : 'bottom'} of ${reps.length} pages`);
      continue;
    }

    // 5. Continuation, judged ONLY on the block's own first character.
    //
    //    The tempting second signal — "the previous block ended without terminal
    //    punctuation" — is wrong here and was cut after it fired on real headings
    //    ("Testing Your Baby", "Selecting a Formula"). It assumes block order is
    //    reading order, and in a book laid out with sidebars and boxes it is not:
    //    the preceding entry in the list is often a different column entirely. A
    //    rule that needs an assumption that strong belongs in the note tier or
    //    nowhere. Beginning lowercase is evidence about THIS block and needs no
    //    such assumption.
    if (/^[a-z]/.test(text) && ['heading', 'subheading', 'chapter', 'title'].includes(label)) {
      add('error', row, b, label, 'body',
        'begins lowercase, so it continues preceding prose rather than heading a new section');
      continue;
    }

    // 6. Size disagreement, stated only as a note — a heading set at body size is
    //    unusual but real (run-in heads, small caps), so this claims nothing.
    if (bodySize && ['heading', 'subheading', 'chapter'].includes(label)
        && b.fsize <= bodySize && text.length > 0) {
      add('note', row, b, label, null,
        `set at ${b.fsize}pt, no larger than this page's body text (${bodySize}pt)`);
      continue;
    }
    if (bodySize && label === 'body' && b.fsize >= bodySize + 4 && text.length < 60) {
      add('note', row, b, label, null,
        `short block set at ${b.fsize}pt against body ${bodySize}pt — may be a heading`);
    }
  }
}

const bySev = { error: 0, warn: 0, note: 0 };
for (const f of findings) bySev[f.severity]++;
const blocks = rows.reduce((n, r) => n + r.blocks.length, 0);

console.log(`label-check — ${label}: ${rows.length} pages, ${blocks} blocks`);
console.log(`  errors ${bySev.error}   warnings ${bySev.warn}   notes ${bySev.note}`
  + `   (${((bySev.error + bySev.warn) / blocks * 100).toFixed(2)}% actionable)`);

for (const sev of ['error', 'warn', 'note']) {
  const list = findings.filter((f) => f.severity === sev);
  if (!list.length) continue;
  console.log(`\n${sev.toUpperCase()} (${list.length})`);
  for (const f of (showAll ? list : list.slice(0, 12))) {
    console.log(`  p${f.page} #${f.block}  ${f.is}${f.should ? ` -> ${f.should}` : ''}  (size${f.fsize})`);
    console.log(`     "${f.text}"`);
    console.log(`     ${f.why}`);
  }
  if (!showAll && list.length > 12) console.log(`  … ${list.length - 12} more (--all)`);
}

if (jsonOut) {
  const p = jsonOut.replace(/^~(?=\/)/, os.homedir());
  fs.writeFileSync(p, JSON.stringify({ book: label, pages: rows.length, blocks, bySev, findings }, null, 1));
  console.log(`\n[check] wrote ${p}`);
}

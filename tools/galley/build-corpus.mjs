/**
 * build-corpus — turn mined OCR↔truth pairs into galley's SFT split.
 *
 *   node tools/galley/build-corpus.mjs \
 *     --pairs ~/Documents/BookForge/training/ocr-repair/pilot-pairs.jsonl \
 *     --stats ~/Documents/BookForge/training/ocr-repair \
 *     --out   ~/Documents/BookForge/training/galley/sft \
 *     [--eval-books a,b] [--max-cer 0.08] [--identity-share 0.5] [--dry-run]
 *
 * Every row is round-trip verified by tools/galley/edits.mjs before it is
 * written: the applier that will run in production reproduces the truth from
 * the target exactly, or the pair is dropped. The corpus therefore cannot
 * contain a target the runtime would reject, and the training data cannot drift
 * from the guarantee.
 *
 * THE HARD PART IS NOT THE FORMAT, IT IS THAT THE TRUTH LIES. Measured on the
 * 483-pair pilot, 98.3% of pairs derive cleanly — the edit-list format is not
 * the constraint. What nearly poisoned the corpus was ground truth that is
 * wrong in two specific, systematic ways, each of which would train the model
 * to CAUSE damage rather than repair it:
 *
 *   1. BROKEN ToUnicode CMaps. Satanic Panic's own text layer reads
 *      "Frank =appa", "P05C", "*ore" — the publisher's font maps glyph slots to
 *      junk. Tesseract read the page correctly. Training on it teaches the model
 *      to turn Zappa into =appa. This is why `--stats` is not optional: the
 *      per-book cmapSuspects list from align.py, and the born-digital text
 *      quality verdict, are both hard gates. §10d found 25 suspect and 17
 *      unusable books out of 175 — this is not a rare accident.
 *
 *   2. SMALL CAPS. A running head printed in small capitals sits in the text
 *      layer as "life in the british zone" while the page plainly reads LIFE IN
 *      THE BRITISH ZONE. Tesseract is right and the truth is a lie about what
 *      the page says. These arrive as 80%-CER pairs and would teach the model to
 *      lowercase every running head in the book.
 *
 * Case 2 is not dropped, it is INVERTED into an identity row. The OCR is
 * correct, so the correct target is `none`, and saying so is more useful than
 * silence: it is exactly the restraint the model most needs to learn. The same
 * applies to any pair whose entire difference survives typographic and case
 * folding — ligature and curly-quote variants are a Unicode preference, not a
 * recognition error, and §10d already measured that training on them builds a
 * normaliser instead of a repairer.
 *
 * Restraint is the whole game. A model that fixes nothing scores a perfect
 * false-edit rate and is useless; a model that edits confidently everywhere
 * rewrites the author. So the corpus is deliberately held at ≥50% identity rows
 * (--identity-share), matching dagger's `none` discipline.
 *
 * HOLD OUT WHOLE BOOKS. A page-level split leaks: the same running heads,
 * fonts and scanner artefacts appear on both sides, and the model scores well by
 * memorising a book rather than learning a degradation. --eval-books names them
 * explicitly rather than sampling, so a rerun is the same split.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveEdits, formatEdits, LIMITS } from './edits.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = (p) => p.replace(/^~(?=\/)/, os.homedir());

if (argv.includes('--help') || !argv.length) {
  console.error('usage: node tools/galley/build-corpus.mjs --pairs <a.jsonl,b.jsonl> [--stats <dir>]\n' +
    '         [--out <dir>] [--eval-books a,b] [--max-cer 0.08] [--identity-share 0.5] [--dry-run]');
  process.exit(argv.length ? 0 : 1);
}

const pairFiles = (opt('pairs', '')).split(',').filter(Boolean).map((p) => path.resolve(tilde(p)));
const statsDir = opt('stats', null) ? path.resolve(tilde(opt('stats'))) : null;
const outDir = path.resolve(tilde(opt('out', '~/Documents/BookForge/training/galley/sft')));
const evalBooks = new Set((opt('eval-books', '')).split(',').map((s) => s.trim()).filter(Boolean));
const maxCer = Number(opt('max-cer', '0.08'));
const identityShare = Number(opt('identity-share', '0.5'));
const dryRun = argv.includes('--dry-run');
/** Below this many characters, CER is too coarse to mean anything. */
const MIN_LEN_FOR_CER = Number(opt('min-len-for-cer', '40'));
const seed = Number(opt('seed', '20260730'));
/**
 * Sources to leave out, by the row's declared `source` field.
 *
 * ICDAR is the reason this exists. It is 27% of the rows but 70% of the EDITS
 * — 9.4 per row against 2.5 for a real book, because its blocks are long and
 * its 19th-century monographs are genuinely more damaged. Mixed in, the model
 * mostly learns to repair Victorian typesetting. §9b always specified it as a
 * separate PRETRAINING stage; keeping it out of the fine-tune mix is what that
 * actually means in practice, and `--exclude-source icdar` is how you get it.
 */
const excludeSources = new Set((opt('exclude-source', '')).split(',').map((s) => s.trim()).filter(Boolean));

/**
 * The prompt is the contract's other half and must match at inference exactly.
 * It states the format, the anchor rule and — most importantly — that doing
 * nothing is a legitimate answer, because a model that believes it must always
 * find something will invent something.
 */
const SYSTEM = [
  'You correct OCR errors in a block of text from a scanned book.',
  '',
  'Reply with one correction per line, in the form:',
  '  <text as it appears> → <text as it should be>',
  '',
  'Rules:',
  '- The left side must be copied EXACTLY from the block, and must appear there only once.',
  '  Include a few surrounding characters if that is what makes it unique.',
  '- Correct only what the scanner misread. Do not rewrite, reword, translate,',
  '  modernise spelling, or change punctuation that is merely old-fashioned.',
  '- If the block has no OCR errors, reply with the single word: none',
].join('\n');

// ── load ────────────────────────────────────────────────────────────────────
const rows = [];
for (const f of pairFiles) {
  if (!fs.existsSync(f)) { console.error(`build-corpus: no such pairs file: ${f}`); process.exit(1); }
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
}
if (!rows.length) { console.error('build-corpus: no pairs loaded'); process.exit(1); }

// ── book-level gates ────────────────────────────────────────────────────────
//
// THE GATE IS MANDATORY. An earlier version of this file printed a warning and
// carried on when --stats was absent, which is the exact shape of bug this
// project has a standing rule against: the unhappy path silently becomes a
// different, worse program. Building without the gate produces a corpus that
// looks fine and teaches the model to write "Frank =appa". So a missing gate is
// a hard stop, and a book with no stats file is a hard stop, rather than a book
// that quietly skips its own inspection.
if (!statsDir) {
  console.error('build-corpus: --stats <dir> is required.\n' +
    'It carries the per-book alignment stats that the CMap and text-quality gates read.\n' +
    '§10d measured 25 suspect and 17 unusable text layers in 175 books: a corpus built\n' +
    'without the gate trains the model to INTRODUCE those errors.');
  process.exit(1);
}
if (!fs.existsSync(statsDir)) { console.error(`build-corpus: no such stats dir: ${statsDir}`); process.exit(1); }

const statsByBook = new Map();
for (const f of fs.readdirSync(statsDir)) {
  if (!f.endsWith('.stats.json')) continue;
  const s = JSON.parse(fs.readFileSync(path.join(statsDir, f), 'utf8'));
  if (typeof s.book !== 'string') { console.error(`build-corpus: ${f} has no "book" field`); process.exit(1); }
  if (!Array.isArray(s.cmapSuspects)) { console.error(`build-corpus: ${f} has no cmapSuspects array — it was not written by align-pairs.py`); process.exit(1); }
  statsByBook.set(s.book, s);
}

// Books that came with their own ground truth (ICDAR) have no PDF text layer to
// inspect. That is an explicit exemption keyed on a declared field, not a
// missing-file fallback: the row says where it came from, and only that value
// skips the gate.
const EXEMPT_SOURCES = new Set(['icdar']);
const booksInPairs = new Map();
for (const r of rows) {
  if (typeof r.book !== 'string') { console.error('build-corpus: a pair row has no "book" field'); process.exit(1); }
  if (!booksInPairs.has(r.book)) booksInPairs.set(r.book, typeof r.source === "string" ? r.source : "");
}
const ungated = [...booksInPairs].filter(([b, src]) => !EXEMPT_SOURCES.has(src) && !statsByBook.has(b));
if (ungated.length) {
  console.error(`build-corpus: ${ungated.length} book(s) in the pairs have no ${'<book>'}.stats.json in ${statsDir}:`);
  for (const [b] of ungated) console.error(`  ${b}`);
  console.error('Mine them with tools/galley/mine-book.mjs, which writes the stats the gate reads.');
  process.exit(1);
}

/**
 * THE AUTHORITATIVE GATE is text-quality.py's verdict on the truth we actually
 * mined (tools/galley/gate-mined-truth.mjs). Two earlier candidates each got a
 * real book wrong, in opposite directions:
 *
 *   - The BOOK-LEVEL born-digital verdict called Churches vol 1 clean, because
 *     it sampled 40 pages of readable English front matter while the pages we
 *     mined are reproduced Fraktur decoding to "«roessten wert auf her.nzls".
 *     It was answering about different pages.
 *   - The CMap heuristic flagged Shirer over `†`→`t`, which is not a broken font
 *     at all: it is Tesseract misreading a correctly-set footnote dagger, and
 *     one of the more valuable errors in the corpus. Excluding on it discards a
 *     good book to avoid a fault that is not there.
 *
 * Only `unusable` excludes. `suspect` is weak evidence on a twenty-page
 * fragment — Shirer scores suspect on presentation ligatures and hyphenation,
 * both of which the folding already handles — so it is reported, not enforced.
 */
const truthQualityPath = path.join(statsDir, 'mined-truth-quality.json');
if (!fs.existsSync(truthQualityPath)) {
  console.error(`build-corpus: no mined-truth-quality.json in ${statsDir}.\n` +
    'Run: node tools/galley/gate-mined-truth.mjs --pairs ' + statsDir + '\n' +
    'It judges each book by the truth it actually contributed, which is the only\n' +
    'gate that got both Churches vol 1 and Shirer right.');
  process.exit(1);
}
const truthQuality = JSON.parse(fs.readFileSync(truthQualityPath, 'utf8'));
if (!truthQuality.books || typeof truthQuality.books !== 'object') {
  console.error(`build-corpus: ${truthQualityPath} has no books object`); process.exit(1);
}

const blockedBooks = new Map();          // book -> why
const suspectBooks = new Map();
for (const [book] of booksInPairs) {
  if (EXEMPT_SOURCES.has(booksInPairs.get(book))) continue;
  const rec = truthQuality.books[book];
  if (!rec) {
    console.error(`build-corpus: ${book} has no verdict in mined-truth-quality.json — re-run gate-mined-truth.mjs`);
    process.exit(1);
  }
  if (rec.verdict === 'unusable') {
    blockedBooks.set(book, `mined truth is not readable text (${rec.findings.map((f) => f.check).join(', ')})`);
  } else if (rec.verdict !== 'clean') {
    suspectBooks.set(book, rec.findings.map((f) => f.check).join(', '));
  }
}

// Reported, never enforced — see above for why this heuristic cannot decide.
const cmapFlagged = [...statsByBook].filter(([, s]) => s.cmapSuspects.length);

// ── per-pair gates + derivation ─────────────────────────────────────────────
const drop = { excludedSource: 0, blockedBook: 0, tooGarbled: 0, underivable: 0, empty: 0 };
const dropExamples = [];
const kept = [];
let invertedToIdentity = 0;

for (const r of rows) {
  // A malformed row is a broken miner, not a row to skip around.
  for (const field of ['ocr', 'truth']) {
    if (typeof r[field] !== 'string') { console.error(`build-corpus: pair ${r.blockId} has no string "${field}"`); process.exit(1); }
  }
  for (const field of ['cer', 'cerFoldedCaseless']) {
    if (typeof r[field] !== 'number') { console.error(`build-corpus: pair ${r.blockId} has no numeric "${field}"`); process.exit(1); }
  }
  if (excludeSources.has(typeof r.source === 'string' ? r.source : '')) { drop.excludedSource++; continue; }
  if (blockedBooks.has(r.book)) { drop.blockedBook++; continue; }
  const { ocr, truth } = r;
  if (!ocr.trim() || !truth.trim()) { drop.empty++; continue; }

  // Folding-equal means the disagreement is typography or letter case, not
  // recognition — the scanner read the page right. Target `none`.
  const foldEqual = r.cerFoldedCaseless === 0 && r.cer > 0;
  if (foldEqual) {
    invertedToIdentity++;
    kept.push({ ...r, target: 'none', nEdits: 0, identity: true, reason: 'folding-equal' });
    continue;
  }

  // The CER cap exists to keep out DENSE garble, where the alignment itself has
  // probably failed. On a short block it measures nothing of the kind: two bad
  // characters in "SCHULENBURG**4" is 14% CER and is precisely the error worth
  // learning — a misread superscript footnote marker. Below MIN_LEN_FOR_CER the
  // edit contract's own change budget is the better judge, so let derivation
  // decide instead of a ratio computed over fourteen characters.
  if (ocr.length >= MIN_LEN_FOR_CER && r.cer > maxCer) {
    drop.tooGarbled++;
    if (dropExamples.length < 6) dropExamples.push({ why: 'cer', r });
    continue;
  }

  const d = deriveEdits(ocr, truth);
  if (!d) {
    drop.underivable++;
    if (dropExamples.length < 6) dropExamples.push({ why: 'underivable', r });
    continue;
  }
  kept.push({ ...r, target: formatEdits(d.edits), nEdits: d.edits.length, identity: d.edits.length === 0 });
}

// ── identity discipline ─────────────────────────────────────────────────────
// Deterministic shuffle: a fixed seed means the same corpus every run, which is
// what makes two training runs comparable at all (§8).
let s = seed >>> 0;
const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const identities = shuffle(kept.filter((k) => k.identity));
const edited = kept.filter((k) => !k.identity);
// want / (want + edited) >= identityShare
const wantIdentity = Math.round(edited.length * identityShare / Math.max(1e-9, 1 - identityShare));
const usedIdentity = identities.slice(0, Math.min(identities.length, wantIdentity));
const identityShortfall = wantIdentity - usedIdentity.length;

const corpus = shuffle([...edited, ...usedIdentity]);

// ── split ───────────────────────────────────────────────────────────────────
const byBook = new Map();
for (const r of corpus) byBook.set(r.book, (byBook.get(r.book) ?? 0) + 1);
const unknownEval = [...evalBooks].filter((b) => !byBook.has(b));
/**
 * A degraded variant carries THE SAME PAGES as the book it was made from, so
 * holding out `michelle-remembers` while leaving `michelle-remembers-speckle0.8`
 * in train puts the eval text in front of the model during training — the exact
 * leak whole-book holdout exists to prevent, wearing a different book id.
 *
 * `sourceBook` is what ties a variant to its origin, so the held-out set is
 * closed over it in BOTH directions: name either the parent or a variant and
 * the whole family goes to eval. Expanding is announced, never silent — the
 * point is that the operator sees which ids moved and why.
 */
const familyOf = new Map();       // book id -> family key
for (const r of rows) {
  const family = typeof r.sourceBook === 'string' && r.sourceBook ? r.sourceBook : r.book;
  familyOf.set(r.book, family);
}
const evalFamilies = new Set([...evalBooks].map((b) => familyOf.get(b) ?? b));
const expandedEval = new Set(
  [...familyOf].filter(([, fam]) => evalFamilies.has(fam)).map(([book]) => book));
const added = [...expandedEval].filter((b) => !evalBooks.has(b));
if (added.length) {
  console.log(`\nEVAL EXPANDED to keep degraded variants with their source book:`);
  for (const b of added) console.log(`  + ${b}   (same pages as ${familyOf.get(b)})`);
}

const train = corpus.filter((r) => !expandedEval.has(r.book));
const evalRows = corpus.filter((r) => expandedEval.has(r.book));

const toChat = (r) => ({
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: r.ocr },
    { role: 'assistant', content: r.target },
  ],
  book: r.book, page: r.page, blockId: r.blockId, cer: r.cer, nEdits: r.nEdits,
});

// ── report ──────────────────────────────────────────────────────────────────
console.log(`galley build-corpus — ${rows.length} mined pairs from ${pairFiles.length} file(s)`);

if (blockedBooks.size) {
  console.log(`\nBOOKS EXCLUDED (${blockedBooks.size}) — their ground truth is wrong, not their OCR:`);
  for (const [b, why] of blockedBooks) console.log(`  ${b}\n    ${why}`);
} else {
  console.log('\nno book failed the truth gate');
}
if (suspectBooks.size) {
  console.log(`\nSUSPECT but KEPT (${suspectBooks.size}) — weak evidence on a short fragment:`);
  for (const [b, why] of suspectBooks) console.log(`  ${b.padEnd(46)} ${why}`);
}
if (cmapFlagged.length) {
  console.log(`\nGLYPH SUBSTITUTIONS FLAGGED (${cmapFlagged.length}) — reported, NOT enforced.`);
  console.log('  A consistent symbol→letter mapping looks the same whether the font is');
  console.log('  broken or the scanner simply misread a real character. The truth gate above');
  console.log('  decides; these are here so a human can check what it decided.');
  for (const [b, s] of cmapFlagged) {
    const ex = s.cmapSuspects.slice(0, 4).map((c) => `${JSON.stringify(c.truthGlyph)}→${JSON.stringify(c.ocrReads)}×${c.count}`).join(' ');
    console.log(`  ${blockedBooks.has(b) ? 'excluded' : 'KEPT    '} ${b.padEnd(40)} ${ex}`);
  }
}

console.log(`\nDROPPED PAIRS`);
console.log(`  from excluded books   ${drop.blockedBook}`);
if (excludeSources.size) console.log(`  from --exclude-source ${[...excludeSources].join(',')}   ${drop.excludedSource}`);
console.log(`  over --max-cer ${maxCer}   ${drop.tooGarbled}`);
console.log(`  no contract-satisfying edit set   ${drop.underivable}`);
console.log(`  empty side            ${drop.empty}`);
console.log(`  inverted to identity (folding-equal: small caps, ligatures, quotes)   ${invertedToIdentity}`);

if (dropExamples.length) {
  console.log('\n  examples of what was dropped:');
  for (const { why, r } of dropExamples) {
    console.log(`    [${why}] ${r.book} p${r.page} cer=${(r.cer * 100).toFixed(1)}%`);
    console.log(`      OCR   ${JSON.stringify(String(r.ocr).slice(0, 110))}`);
    console.log(`      TRUTH ${JSON.stringify(String(r.truth).slice(0, 110))}`);
  }
}

console.log(`\nCORPUS`);
console.log(`  edit rows      ${edited.length}`);
console.log(`  identity rows  ${usedIdentity.length} of ${identities.length} available`
  + `  (${(usedIdentity.length / Math.max(1, corpus.length) * 100).toFixed(1)}% of the corpus)`);
if (identityShortfall > 0) {
  console.log(`  !! ${identityShortfall} short of the --identity-share ${identityShare} target.`);
  console.log('     Restraint is undertrained at this ratio. Mine more clean books before training.');
}
const totalEdits = edited.reduce((n, r) => n + r.nEdits, 0);
console.log(`  edits per edited row  ${edited.length ? (totalEdits / edited.length).toFixed(2) : '-'}`);

console.log(`\nBOOKS (${byBook.size})`);
for (const [b, n] of [...byBook].sort((a, z) => z[1] - a[1])) {
  console.log(`  ${expandedEval.has(b) ? 'EVAL ' : '     '}${b.padEnd(32)} ${n}`);
}
if (unknownEval.length) {
  console.log(`\n  !! --eval-books names books with no rows: ${unknownEval.join(', ')}`);
}
if (!evalRows.length) {
  console.log('\n  !! NO EVAL SPLIT. Name held-out books with --eval-books; a page-level');
  console.log('     split leaks fonts and running heads and flatters the score.');
}
console.log(`\nSPLIT  train ${train.length}   eval ${evalRows.length}`);

if (dryRun) { console.log('\n--dry-run: nothing written'); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true });
for (const [name, set] of [['train', train], ['eval', evalRows]]) {
  fs.writeFileSync(path.join(outDir, `${name}.jsonl`),
    set.map((r) => JSON.stringify(toChat(r))).join('\n') + (set.length ? '\n' : ''));
}
fs.writeFileSync(path.join(outDir, 'build-stats.json'), JSON.stringify({
  generated: new Date().toISOString(),
  pairFiles, seed, maxCer, identityShare, limits: LIMITS,
  minedPairs: rows.length,
  blockedBooks: Object.fromEntries(blockedBooks),
  dropped: drop,
  invertedToIdentity,
  editRows: edited.length,
  identityRows: usedIdentity.length,
  identityShortfall,
  books: Object.fromEntries(byBook),
  evalBooks: [...evalBooks],
  train: train.length,
  eval: evalRows.length,
}, null, 1));
console.log(`\nwrote ${outDir}/{train,eval}.jsonl + build-stats.json`);

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
const blockedBooks = new Map();          // book -> why
if (statsDir) {
  for (const f of fs.readdirSync(statsDir)) {
    if (!f.endsWith('.stats.json')) continue;
    const s = JSON.parse(fs.readFileSync(path.join(statsDir, f), 'utf8'));
    if (s.cmapSuspects?.length) {
      const ex = s.cmapSuspects.slice(0, 3).map((c) => `${JSON.stringify(c.truthGlyph)}→${JSON.stringify(c.ocrReads)}`).join(' ');
      blockedBooks.set(s.book, `broken ToUnicode CMap in the PDF's own text layer (${ex})`);
    }
  }
  // A pilot run writes one combined stats file rather than per-book ones.
  const combined = path.join(statsDir, 'pilot-stats.json');
  if (fs.existsSync(combined)) {
    const all = JSON.parse(fs.readFileSync(combined, 'utf8'));
    for (const [book, s] of Object.entries(all.books ?? {})) {
      if (s.cmapSuspects?.length) {
        const ex = s.cmapSuspects.slice(0, 3).map((c) => `${JSON.stringify(c.truthGlyph)}→${JSON.stringify(c.ocrReads)}`).join(' ');
        blockedBooks.set(book, `broken ToUnicode CMap in the PDF's own text layer (${ex})`);
      }
    }
  }
  const quality = path.join(statsDir, 'text-quality-born-digital.json');
  if (fs.existsSync(quality)) {
    const q = JSON.parse(fs.readFileSync(quality, 'utf8'));
    const byPath = new Map((q.books ?? []).map((b) => [b.path, b.verdict ?? b.status]));
    const pdfOf = new Map();
    if (fs.existsSync(combined)) {
      for (const [book, s] of Object.entries(JSON.parse(fs.readFileSync(combined, 'utf8')).books ?? {})) pdfOf.set(book, s.pdf);
    }
    for (const [book, pdf] of pdfOf) {
      const v = byPath.get(pdf);
      if (v && v !== 'clean' && !blockedBooks.has(book)) blockedBooks.set(book, `text-quality verdict: ${v}`);
    }
  }
}

// ── per-pair gates + derivation ─────────────────────────────────────────────
const drop = { blockedBook: 0, tooGarbled: 0, underivable: 0, empty: 0 };
const dropExamples = [];
const kept = [];
let invertedToIdentity = 0;

for (const r of rows) {
  if (blockedBooks.has(r.book)) { drop.blockedBook++; continue; }
  const ocr = r.ocr ?? '';
  const truth = r.truth ?? '';
  if (!ocr.trim() || !truth.trim()) { drop.empty++; continue; }

  // Folding-equal means the disagreement is typography or letter case, not
  // recognition — the scanner read the page right. Target `none`.
  const foldEqual = typeof r.cerFoldedCaseless === 'number' && r.cerFoldedCaseless === 0 && (r.cer ?? 0) > 0;
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
  if (ocr.length >= MIN_LEN_FOR_CER && (r.cer ?? 0) > maxCer) {
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
const train = corpus.filter((r) => !evalBooks.has(r.book));
const evalRows = corpus.filter((r) => evalBooks.has(r.book));

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
} else if (statsDir) {
  console.log('\nno book failed the truth gate');
} else {
  console.log('\n!! NO --stats GIVEN: the CMap and text-quality gates did not run.');
  console.log('   §10d measured 25 suspect / 17 unusable books in 175. Do not train on this.');
}

console.log(`\nDROPPED PAIRS`);
console.log(`  from excluded books   ${drop.blockedBook}`);
console.log(`  over --max-cer ${maxCer}   ${drop.tooGarbled}`);
console.log(`  no contract-satisfying edit set   ${drop.underivable}`);
console.log(`  empty side            ${drop.empty}`);
console.log(`  inverted to identity (folding-equal: small caps, ligatures, quotes)   ${invertedToIdentity}`);

if (dropExamples.length) {
  console.log('\n  examples of what was dropped:');
  for (const { why, r } of dropExamples) {
    console.log(`    [${why}] ${r.book} p${r.page} cer=${((r.cer ?? 0) * 100).toFixed(1)}%`);
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
  console.log(`  ${evalBooks.has(b) ? 'EVAL ' : '     '}${b.padEnd(32)} ${n}`);
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

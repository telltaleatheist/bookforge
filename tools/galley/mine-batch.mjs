/**
 * mine-batch — mine OCR↔truth pairs from every clean born-digital book.
 *
 *   node tools/galley/mine-batch.mjs [--pages 20] [--limit 60] [--dry-run]
 *     [--quality ~/Documents/BookForge/training/ocr-repair/text-quality-born-digital.json]
 *     [--out ~/Documents/BookForge/training/galley/pairs]
 *
 * BOOK SPREAD IS THE LEVER, and it is the one lesson this project has paid for
 * twice. §4 measured it on rubric: `table` had 431 examples in 4 books and
 * scored F1 0.00 while `chapter` had 398 in 13 books and scored 0.66. galley's
 * version of that is degradation diversity — a tinted 1970s paperback in a worn
 * serif teaches error distributions that a hundred more pages of a clean 2024
 * Vellum PDF cannot. So this mines MODEST page counts from MANY books rather
 * than many pages from few.
 *
 * Three filters decide what gets mined, all of them already measured:
 *   - verdict `clean` from the text-quality gate (§10d: 133 clean, 25 suspect,
 *     17 unusable out of 175). Suspect and unusable books have text layers that
 *     would teach the model to introduce errors.
 *   - DEDUPLICATED by title. The 175 PDFs are only ~90 distinct books; mining
 *     both copies would double-count one book's fonts and quietly undo the
 *     spread this is built for.
 *   - pages taken from the MIDDLE of the book. Front matter and indexes are
 *     unrepresentative of the body text that gets narrated, and half-empty
 *     pages produce blocks too short to align.
 *
 * Mining is not accepting. A book whose text layer turns out to be broken is
 * still written here — build-corpus.mjs is where the CMap gate excludes it —
 * so that the evidence for excluding it stays on disk.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = (p) => p.replace(/^~(?=\/)/, os.homedir());

const qualityPath = path.resolve(tilde(opt('quality', '~/Documents/BookForge/training/ocr-repair/text-quality-born-digital.json')));
const outDir = path.resolve(tilde(opt('out', '~/Documents/BookForge/training/galley/pairs')));
const nPages = Number(opt('pages', '20'));
const limit = Number(opt('limit', '60'));
const minPages = Number(opt('min-pages', '60'));
const dryRun = argv.includes('--dry-run');

if (!fs.existsSync(qualityPath)) {
  console.error(`mine-batch: no text-quality report at ${qualityPath}`);
  console.error('Run the born-digital text-quality gate first — mining without it is how a');
  console.error('broken text layer becomes training data.');
  process.exit(1);
}

const q = JSON.parse(fs.readFileSync(qualityPath, 'utf8'));
const books = q.books ?? [];

/**
 * Strip author, year and edition noise so two files of one book collapse.
 *
 * The leading/trailing-article dance is not pedantry: the same book is on disk
 * as both "The Third Reich at War" and "Third Reich at War, The 1939-1945", and
 * a naive key keeps both — which double-counts one book's fonts and quietly
 * undoes the spread this whole batch exists to get.
 */
const titleKey = (name) => name
  .replace(/\.pdf$/i, '')
  .replace(/\(\d{3,4}\)/g, ' ')
  .replace(/\bUnknown\b/gi, ' ')
  .split('.')[0]
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+the\s*$/, '')          // "Third Reich at War, The"
  .replace(/^(the|a|an)\s+/, '')
  .replace(/\s+\d{4}(\s+\d{4})?\s*$/, '')   // trailing year or year range
  // Interior stopwords vary between cataloguers — one copy is "Pokemon Harry
  // Potter", the other "Pokemon AND Harry Potter" — so they cannot be part of
  // the identity of a title.
  .replace(/\b(and|of|the|a|an|in|for|to|by)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Subtitles are the other half of the same problem: "rise and fall of the third
 * reich" and "rise and fall of the third reich a history of nazi germany" are
 * one book. Treat a key that another key starts with as the same book — but
 * only past MIN_PREFIX characters, or short generic titles ("ethics") would
 * swallow anything beginning the same way.
 */
const MIN_PREFIX = 11;
function canonical(keys) {
  const sorted = [...keys].sort((a, b) => a.length - b.length);
  const map = new Map();
  for (const k of sorted) {
    let target = k;
    for (const shorter of sorted) {
      if (shorter === k) break;
      if (shorter.length >= MIN_PREFIX && k.startsWith(shorter + ' ')) { target = map.get(shorter) ?? shorter; break; }
    }
    map.set(k, target);
  }
  return map;
}

const eligible = [];
let nonClean = 0, tooShort = 0;
for (const b of books) {
  const verdict = b.verdict ?? b.status;
  if (verdict !== 'clean') { nonClean++; continue; }
  const pageCount = b.source?.pageCount ?? 0;
  if (pageCount < minPages) { tooShort++; continue; }
  if (!fs.existsSync(b.path)) continue;
  eligible.push({ ...b, pageCount, key: titleKey(b.name) });
}

const canon = canonical(eligible.map((b) => b.key));
const seen = new Map();
let dupes = 0;
for (const b of eligible) {
  const key = canon.get(b.key) ?? b.key;
  const prev = seen.get(key);
  if (prev) {
    dupes++;
    // Keep whichever copy has more pages — a truncated duplicate is common.
    if (b.pageCount > prev.pageCount) seen.set(key, { ...b, key });
    continue;
  }
  seen.set(key, { ...b, key });
}

const slug = (s) => s.replace(/\s+/g, '-').slice(0, 48);
const plan = [...seen.values()]
  .sort((a, z) => z.pageCount - a.pageCount)
  .slice(0, limit)
  .map((b) => {
    // Middle of the book: skip the first and last 15%.
    const lo = Math.floor(b.pageCount * 0.15);
    const hi = Math.floor(b.pageCount * 0.85);
    const from = Math.max(0, Math.floor((lo + hi) / 2 - nPages / 2));
    return { book: slug(b.key), pdf: b.path, from, pages: Math.min(nPages, b.pageCount - from) };
  });

console.log(`mine-batch: ${books.length} scanned → ${seen.size} distinct clean books ≥${minPages}pp`);
console.log(`  skipped: ${nonClean} not clean, ${tooShort} too short, ${dupes} duplicate copies`);
console.log(`  mining ${plan.length} books × ${nPages} pages` + (limit < seen.size ? `  (--limit ${limit} of ${seen.size})` : ''));

const already = plan.filter((p) => fs.existsSync(path.join(outDir, `${p.book}.pairs.jsonl`)));
if (already.length) console.log(`  ${already.length} already mined, skipping (pass --force to mine-book to redo)`);

if (dryRun) {
  for (const p of plan) console.log(`  ${p.book.padEnd(50)} p${p.from}-${p.from + p.pages - 1}`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
let done = 0, failed = 0, skipped = 0;
const t0 = Date.now();

for (const p of plan) {
  if (fs.existsSync(path.join(outDir, `${p.book}.pairs.jsonl`))) { skipped++; continue; }
  const code = await new Promise((resolve) => {
    const c = spawn('node', [path.join(HERE, 'mine-book.mjs'),
      '--book', p.book, '--pdf', p.pdf, '--from', String(p.from),
      '--pages', String(p.pages), '--out', outDir],
      // OCR chatter is the app's, not ours, and it is per-page: keep stderr
      // (which carries the alignment result and the CMap warning) and drop the
      // rest, or one batch buries its own findings.
      { stdio: ['ignore', 'ignore', 'inherit'], cwd: REPO });
    c.on('error', () => resolve(1));
    c.on('close', resolve);
  });
  if (code === 0) done++; else { failed++; console.error(`[batch] FAILED: ${p.book}`); }
  const mins = (Date.now() - t0) / 60000;
  console.error(`[batch] ${done + failed + skipped}/${plan.length}  ok=${done} failed=${failed}  ${mins.toFixed(1)}min`);
}

console.log(`\nmine-batch done: ${done} mined, ${skipped} already present, ${failed} failed`);
console.log(`next: node tools/galley/build-corpus.mjs --pairs "${outDir}/*.pairs.jsonl" --stats ${outDir}`);

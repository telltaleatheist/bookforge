/**
 * gate-mined-truth — judge each mined book's ground truth by the text it
 * actually contributed, using the existing text-quality checker.
 *
 *   node tools/galley/gate-mined-truth.mjs [--pairs <dir>] [--python python3]
 *
 * WHY THIS EXISTS: neither signal we already had is correct on its own, and
 * both failures were measured on real books rather than imagined.
 *
 *   Satanic Panic     verdict unusable   7 broken glyph maps   → exclude (agree)
 *   Churches vol 1    verdict CLEAN      «→e, »→v              → must exclude
 *   Shirer            verdict CLEAN      †→t                   → must KEEP
 *
 * The book-level text-quality verdict called Churches vol 1 clean because it
 * sampled 40 pages of readable English front matter; the middle of the book,
 * which is what we mined, is reproduced Fraktur whose text layer decodes to
 * "«roessten wert auf her.nzlshuni". The verdict was not wrong so much as
 * answering about different pages.
 *
 * The CMap heuristic in align-pairs.py has the opposite failure. It flags a
 * consistent non-alphanumeric→letter substitution, which is exactly what a
 * broken font slot looks like — and also exactly what a correctly-set footnote
 * dagger looks like when Tesseract reads it as "t". Shirer's `†` sits in clean
 * prose ("to achieve it.†"); it is a GENUINE OCR error and one of the more
 * valuable ones in the corpus. Excluding the book over it would throw away good
 * data to avoid a fault that is not there.
 *
 * So the question is neither "does this book have odd glyphs" nor "did a sample
 * of it read well". It is: IS THE TRUTH WE MINED ACTUALLY TEXT? That is what
 * tools/text-quality.py already measures, so this feeds it the mined truth
 * itself rather than reimplementing its metrics — the same reason the CLI drives
 * the app's own path instead of a parallel copy.
 *
 * Writes `mined-truth-quality.json` beside the pairs. build-corpus.mjs reads it
 * as the authoritative gate.
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

const pairsDir = path.resolve(tilde(opt('pairs', '~/Documents/BookForge/training/galley/pairs')));
const python = opt('python', 'python3');
/** text-quality.py fails a unit under 40 chars; page furniture is not evidence. */
const MIN_UNIT = 40;
if (!fs.existsSync(pairsDir)) { console.error(`gate-mined-truth: no such dir: ${pairsDir}`); process.exit(1); }

const files = fs.readdirSync(pairsDir).filter((f) => f.endsWith('.pairs.jsonl'));
if (!files.length) { console.error(`gate-mined-truth: no *.pairs.jsonl in ${pairsDir}`); process.exit(1); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-truth-'));
const books = [];
for (const f of files) {
  const book = f.replace(/\.pairs\.jsonl$/, '');
  const truth = [];
  for (const line of fs.readFileSync(path.join(pairsDir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (typeof r.truth !== 'string') { console.error(`gate-mined-truth: ${f} has a row with no "truth"`); process.exit(1); }
    // Only body-sized blocks. text-quality.py judges a unit under 40 characters
    // as an empty unit and fails the whole file on it, and it is right to: a
    // running head or a folio carries no evidence about whether the text layer
    // decodes. Feeding them in would mark every book unusable on page furniture.
    if (r.truth.trim().length >= MIN_UNIT) truth.push(r.truth.trim());
  }
  if (!truth.length) continue;
  const txt = path.join(work, `${book}.txt`);
  fs.writeFileSync(txt, truth.join('\n\n'));
  books.push({ book, txt });
}

const jsonOut = path.join(work, 'report.json');
console.error(`[gate] running text-quality.py over the mined truth of ${books.length} books`);
const code = await new Promise((resolve) => {
  const p = spawn(python, [path.join(REPO, 'tools/text-quality.py'), ...books.map((b) => b.txt),
    '--json', jsonOut, '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'], cwd: REPO });
  p.on('error', () => resolve(1));
  p.on('close', resolve);
});
// text-quality.py's exit code reports VERDICTS, not success: it returns 2 when
// any input is unusable, which is a result we specifically want, not an error.
// The report file is the contract, so a missing or unparseable report is the
// only real failure.
if (!fs.existsSync(jsonOut)) {
  console.error(`gate-mined-truth: text-quality.py wrote no report (exit ${code})`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
const recs = Array.isArray(report) ? report : report.books;
if (!Array.isArray(recs)) { console.error('gate-mined-truth: unexpected report shape from text-quality.py'); process.exit(1); }

const byBook = {};
for (const b of books) {
  const rec = recs.find((r) => path.resolve(r.path) === path.resolve(b.txt));
  if (!rec) { console.error(`gate-mined-truth: text-quality.py returned no record for ${b.book}`); process.exit(1); }
  if (typeof rec.verdict !== 'string') { console.error(`gate-mined-truth: no verdict for ${b.book}`); process.exit(1); }
  if (!Array.isArray(rec.findings)) { console.error(`gate-mined-truth: no findings array for ${b.book}`); process.exit(1); }
  byBook[b.book] = {
    verdict: rec.verdict,
    findings: rec.findings.map((f) => ({ check: f.check, severity: f.severity, detail: f.detail })),
  };
}

const out = path.join(pairsDir, 'mined-truth-quality.json');
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), source: 'tools/text-quality.py over mined truth', books: byBook }, null, 1));

const counts = {};
for (const v of Object.values(byBook)) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
console.log('mined-truth verdicts:', Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('  '));
console.log('\nONLY `unusable` excludes a book. `suspect` on a 20-page fragment is weak');
console.log('evidence — hyphenation and furniture rates are unstable at that length, and');
console.log('Shirer, whose truth is demonstrably clean prose, scores suspect on it.\n');
for (const [book, v] of Object.entries(byBook)) {
  if (v.verdict !== 'clean') console.log(`  ${v.verdict.toUpperCase().padEnd(9)} ${book}\n            ${v.findings.map((f) => `${f.check}: ${f.detail}`).join('\n            ')}`);
}
console.log(`\nwrote ${out}`);
fs.rmSync(work, { recursive: true, force: true });

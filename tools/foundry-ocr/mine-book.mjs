/**
 * mine-book — extract OCR↔truth pairs from one born-digital PDF.
 *
 *   node tools/foundry-ocr/mine-book.mjs --book shirer-rise-and-fall \
 *     --pdf "/path/to/book.pdf" --from 468 --pages 15 \
 *     [--out ~/Documents/BookForge/training/galley/pairs] [--force]
 *
 * Two steps, neither of them new:
 *   1. dump-ocr.js  — the app's OWN headless OCR path (same 200 dpi, same
 *      segmentation), keeping per-LINE text, which blocks.json drops.
 *   2. align-pairs.py — matches each truth word to the OCR line whose box it
 *      physically overlaps. GEOMETRY decides correspondence, never text
 *      similarity; edit distance is only used afterwards, to score a pair that
 *      geometry already established.
 *
 * The truth is the PDF's own text layer. That is what makes this corpus free —
 * no labelling, and the pages Tesseract read are literally the pages the
 * typesetter set. It is ALSO the corpus's single greatest hazard: a text layer
 * can be confidently wrong (see build-corpus.mjs on broken ToUnicode CMaps),
 * and a wrong truth trains the model to introduce the error rather than fix it.
 * So this writes the per-book stats file that build-corpus.mjs gates on, and
 * mining a book is never the same thing as accepting it.
 *
 * Re-mining is refused unless --force: the pairs are cheap to regenerate but a
 * silent overwrite mid-analysis is how a measurement stops being reproducible.
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

if (argv.includes('--help') || !argv.length) {
  console.error('usage: node tools/foundry-ocr/mine-book.mjs --book <id> --pdf <file> --from <page0> --pages <n>\n' +
    '         [--out <dir>] [--python python3] [--force]');
  process.exit(argv.length ? 0 : 1);
}

const book = opt('book', null);
const pdf = opt('pdf', null) ? path.resolve(tilde(opt('pdf'))) : null;
const from = Number(opt('from', '0'));
const nPages = Number(opt('pages', '15'));
const outDir = path.resolve(tilde(opt('out', '~/Documents/BookForge/training/galley/pairs')));
const python = opt('python', 'python3');
const force = argv.includes('--force');

if (!book || !pdf) { console.error('mine-book: --book and --pdf are required'); process.exit(1); }
if (!fs.existsSync(pdf)) { console.error(`mine-book: no such PDF: ${pdf}`); process.exit(1); }

fs.mkdirSync(outDir, { recursive: true });
const dumpPath = path.join(outDir, `${book}.dump.json`);
const pairsPath = path.join(outDir, `${book}.pairs.jsonl`);
const statsPath = path.join(outDir, `${book}.stats.json`);

if (fs.existsSync(pairsPath) && !force) {
  console.error(`mine-book: ${book} already mined (${pairsPath}). Pass --force to redo it.`);
  process.exit(0);
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: REPO });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

const last = from + nPages - 1;
console.error(`[mine] ${book}: pages ${from}-${last} of ${path.basename(pdf)}`);

try {
  if (!fs.existsSync(dumpPath) || force) {
    await run('node', ['--require', path.join(REPO, 'cli/electron-stub.js'),
      path.join(HERE, 'dump-ocr.js'), pdf, dumpPath, String(from), String(last)]);
  } else {
    console.error('[mine] reusing existing OCR dump');
  }
  await run(python, [path.join(HERE, 'align-pairs.py'), dumpPath, pdf, book, pairsPath, statsPath]);
} catch (err) {
  console.error(`[mine] ${book} FAILED: ${err.message}`);
  process.exit(1);
}

// Surface the two things that decide whether this book belongs in the corpus at
// all, so a bad text layer is visible at mining time rather than at training
// time. build-corpus.mjs enforces them; this only reports.
const s = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
if (s.cmapSuspects?.length) {
  console.error(`[mine] !! ${book}: the PDF's text layer looks BROKEN — ` +
    s.cmapSuspects.slice(0, 4).map((c) => `${JSON.stringify(c.truthGlyph)}→${JSON.stringify(c.ocrReads)}`).join(' '));
  console.error('[mine]    build-corpus.mjs will exclude it. Tesseract is probably right and the truth is wrong.');
}
if (s.alignmentRate < 0.85) {
  console.error(`[mine] !! ${book}: only ${(s.alignmentRate * 100).toFixed(1)}% of blocks aligned — ` +
    'geometry may be off (check CropBox/rotation) rather than the scan being bad.');
}

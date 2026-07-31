/**
 * degrade-batch — mine the SAME pages a second time, off a damaged raster.
 *
 *   node tools/galley/degrade-batch.mjs \
 *     --books catholic-church-holocaust,culture-conspiracy \
 *     --levels speckle0.4,speckle0.8,combo-mild \
 *     [--pairs ~/Documents/BookForge/training/galley/pairs] \
 *     [--work ~/Documents/BookForge/training/galley/degraded] \
 *     [--concurrency 2] [--force] [--keep-pdf]
 *
 * WHY: the clean corpus is the wrong corpus. Measured over the born-digital
 * books, render-vs-text-layer CER is 0.449% folded and 66% of it is ligature,
 * quote and case NORMALISATION; l/1/I confusion occurs once in 115,273
 * characters. Train on that and you get a Unicode normaliser. The errors a
 * repair model exists to fix only appear once the page stops being pristine, so
 * every book has to be mined twice: once clean, once damaged.
 *
 * Nothing here re-implements a step that already exists:
 *   1. degrade-render.py  renders at the app's 200 dpi, applies ONE level of the
 *      measured ladder, and re-wraps the rasters as their own short PDF at the
 *      ORIGINAL page size.
 *   2. dump-ocr.js        the app's own headless OCR path over that short PDF.
 *   3. align-pairs.py     aligns against the UNTOUCHED source PDF's text layer,
 *      with OFFSET = the first source page, because page N of the short PDF is
 *      page N+OFFSET of the book. That argument exists for exactly this case.
 *
 * The truth therefore never passes through the degradation. Only the OCR side
 * is damaged, which is the whole point: same labels, harder input.
 *
 * PAGE RANGE comes from the book's existing <book>.stats.json, not from flags.
 * Clean and degraded pairs must cover the same text or the two are not
 * comparable, and a hand-typed range is how that silently stops being true.
 *
 * NAMING and the split hazard: rows are written under book id
 * `<book>-<level>`, with `source` naming the level and `sourceBook` naming the
 * clean book. build-corpus.mjs holds out whole books by exact id match, so
 * `--eval-books <book>` would hold out the clean rows and leave the degraded
 * twins of the SAME pages in train — leakage. Hold out every variant of a book
 * together; this prints the exact list at the end.
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
const die = (msg) => { console.error(`degrade-batch: ${msg}`); process.exit(1); };

if (argv.includes('--help') || !argv.length) {
  console.error('usage: node tools/galley/degrade-batch.mjs --books a,b,c --levels speckle0.8,combo-mild\n' +
    '         [--pairs <dir>] [--work <dir>] [--concurrency 2] [--python python3] [--force] [--keep-pdf]\n' +
    '       levels come from tools/galley/degrade-render.py --list');
  process.exit(argv.length ? 0 : 1);
}

const books = (opt('books', '')).split(',').map((s) => s.trim()).filter(Boolean);
const levels = (opt('levels', '')).split(',').map((s) => s.trim()).filter(Boolean);
const pairsDir = path.resolve(tilde(opt('pairs', '~/Documents/BookForge/training/galley/pairs')));
const workDir = path.resolve(tilde(opt('work', '~/Documents/BookForge/training/galley/degraded')));
const python = opt('python', 'python3');
// 2, not the OCR path's own 6: a mining batch may be running alongside this and
// Tesseract at full width starves it. Raise it when nothing else is mining.
const concurrency = opt('concurrency', '2');
const force = argv.includes('--force');
const keepPdf = argv.includes('--keep-pdf');

if (!books.length) die('--books is required (comma-separated ids from the pairs dir)');
if (!levels.length) die('--levels is required; see `python3 tools/galley/degrade-render.py --list`');
if (!fs.existsSync(pairsDir)) die(`no such pairs dir: ${pairsDir}`);

const run = (cmd, args, env) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: REPO, env: { ...process.env, ...env } });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

// ── validate every book and level BEFORE doing any work ─────────────────────
// A batch that dies on book 3 of 3 has already spent two OCR runs. Every input
// that can be checked cheaply is checked up front, and a missing one is fatal:
// guessing a page range or a PDF path is how a corpus stops being reproducible.
const legalLevels = new Set(
  (await new Promise((res, rej) => {
    const p = spawn(python, [path.join(HERE, 'degrade-render.py'), '--list'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(`degrade-render.py --list exited ${c}`))));
  })).trim().split('\n').map((s) => s.trim()).filter(Boolean));
for (const l of levels) if (!legalLevels.has(l)) die(`unknown level ${l}. Legal: ${[...legalLevels].join(', ')}`);

const jobs = [];
for (const book of books) {
  const statsPath = path.join(pairsDir, `${book}.stats.json`);
  if (!fs.existsSync(statsPath)) die(`${book} has no ${book}.stats.json in ${pairsDir}. Mine it clean first (mine-book.mjs).`);
  const s = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  if (!s.pdf) die(`${book}.stats.json has no "pdf" field`);
  if (!fs.existsSync(s.pdf)) die(`${book}: source PDF is gone: ${s.pdf}`);
  if (!Array.isArray(s.pages) || !s.pages.length) die(`${book}.stats.json has no "pages"`);
  const pages = [...s.pages].sort((a, b) => a - b);
  // align-pairs.py's OFFSET is a single scalar, so a gap in the clean range
  // would misattribute truth to the wrong page. Refuse rather than shift.
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] !== pages[i - 1] + 1) {
      die(`${book}: clean mining used a NON-CONTIGUOUS page range (${pages.join(',')}). ` +
        'align-pairs.py takes one page offset, so this cannot be reproduced degraded.');
    }
  }
  for (const level of levels) {
    const id = `${book}-${level}`;
    const outPairs = path.join(pairsDir, `${id}.pairs.jsonl`);
    if (fs.existsSync(outPairs) && !force) {
      console.error(`[deg] ${id} already exists — skipping (pass --force to redo)`);
      continue;
    }
    jobs.push({ book, level, id, pdf: s.pdf, from: pages[0], n: pages.length, cleanStats: s });
  }
}
if (!jobs.length) { console.error('degrade-batch: nothing to do.'); process.exit(0); }

fs.mkdirSync(workDir, { recursive: true });
console.error(`[deg] ${jobs.length} job(s), OCR concurrency ${concurrency}, work dir ${workDir}`);

const done = [];
for (const j of jobs) {
  const degPdf = path.join(workDir, `${j.id}.pdf`);
  const dump = path.join(workDir, `${j.id}.dump.json`);
  const outPairs = path.join(pairsDir, `${j.id}.pairs.jsonl`);
  const outStats = path.join(pairsDir, `${j.id}.stats.json`);
  console.error(`\n[deg] ${j.id}: pages ${j.from}-${j.from + j.n - 1} of ${path.basename(j.pdf)}`);
  try {
    await run(python, [path.join(HERE, 'degrade-render.py'), j.pdf, String(j.from), String(j.n), j.level, degPdf]);
    // Pages of the short PDF are 0..n-1 by construction.
    await run('node', ['--require', path.join(REPO, 'cli/electron-stub.js'),
      path.join(HERE, 'dump-ocr.js'), degPdf, dump, '0', String(j.n - 1)],
      { GALLEY_OCR_CONCURRENCY: String(concurrency) });
    // Truth comes from the ORIGINAL pdf; OFFSET maps short-PDF page N back.
    await run(python, [path.join(HERE, 'align-pairs.py'), dump, j.pdf, j.id, outPairs, outStats, String(j.from)]);
  } catch (err) {
    die(`${j.id} FAILED: ${err.message}`);
  }

  // Tag the rows. build-corpus.mjs reads `source` (it exempts some sources from
  // the truth gate) and holds out by `book`; `sourceBook` is what ties a
  // degraded variant back to the clean pages it duplicates.
  const lines = fs.readFileSync(outPairs, 'utf8').split('\n').filter((l) => l.trim());
  const tagged = lines.map((l) => {
    const r = JSON.parse(l);
    return JSON.stringify({ ...r, source: j.level, sourceBook: j.book }, null, 0);
  });
  fs.writeFileSync(outPairs, tagged.join('\n') + (tagged.length ? '\n' : ''));

  const st = JSON.parse(fs.readFileSync(outStats, 'utf8'));
  st.source = j.level;
  st.sourceBook = j.book;
  st.degradation = { level: j.level, renderer: 'tools/galley/degrade-render.py', dpi: 200, pageOffset: j.from };
  st.cleanBaseline = {
    charCER: j.cleanStats.charCER,
    charCERFoldedCaseless: j.cleanStats.charCERFoldedCaseless,
    alignmentRate: j.cleanStats.alignmentRate,
    taxonomy: j.cleanStats.taxonomy,
  };
  fs.writeFileSync(outStats, JSON.stringify(st, null, 1));

  if (!keepPdf) fs.rmSync(degPdf, { force: true });
  console.error(`[deg] ${j.id}: ${tagged.length} pairs, align ${(st.alignmentRate * 100).toFixed(1)}%, ` +
    `CER ${(st.charCER * 100).toFixed(3)}% (folded+case ${(st.charCERFoldedCaseless * 100).toFixed(3)}%) ` +
    `vs clean ${(j.cleanStats.charCER * 100).toFixed(3)}%`);
  // 8% is where the pilot sweep saw geometry alignment start losing labels
  // along with the text; below 1% the rows are still mostly normalisation.
  if (st.charCER > 0.08) {
    console.error(`[deg] !! ${j.id} is over the 8% cap — its pairs may carry MISALIGNED truth, ` +
      'which trains the model to introduce errors. Check alignmentRate before using them.');
  }
  // A level can be safe on CER and still be unsafe on GEOMETRY. Blur re-splits
  // lines, so the app's block segmentation stops matching the truth's: measured,
  // blur2.0 took Michelle Remembers from 149 blocks/100% aligned to 206 blocks
  // and 65.5%, while its CER stayed a harmless 3.8%. CER alone would have called
  // that a good level, so alignment is checked against the book's own clean run.
  if (st.alignmentRate < j.cleanStats.alignmentRate - 0.05) {
    console.error(`[deg] !! ${j.id} aligned ${(st.alignmentRate * 100).toFixed(1)}% vs ` +
      `${(j.cleanStats.alignmentRate * 100).toFixed(1)}% clean (${j.cleanStats.nBlocks} blocks -> ${st.nBlocks}). ` +
      'This damage is changing SEGMENTATION, not just glyphs; the blocks that dropped out are ' +
      'the hard ones, so what survives is biased easy.');
  }
  done.push({ ...j, stats: st });
}

console.error('\n[deg] done. Hold every variant of a book out together, e.g.:');
const byBook = new Map();
for (const d of done) byBook.set(d.book, [...(byBook.get(d.book) || []), d.id]);
for (const [b, ids] of byBook) console.error(`      --eval-books ${[b, ...ids].join(',')}`);
console.error('[deg] then re-run gate-mined-truth.mjs so the new book ids get a truth verdict.');

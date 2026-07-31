#!/usr/bin/env node
/**
 * rubric-detect-corpus — run the layout model over a TRAINING-CORPUS book and
 * write its answers in as labels, without touching the pages a human has already
 * been through.
 *
 *   node --require cli/electron-stub.js tools/rubric-detect-corpus.js \
 *        --book "<slug>" [--model rubric-v4-4b] [--keep-pages 0-50]
 *        [--pages A-B] [--batch 8] [--dry-run]
 *
 * `cli/rubric-detect.js` does this for a LIBRARY PROJECT: it reads blocks out of
 * a manifest and paints predictions back into one. A corpus book has no manifest
 * and never will — that is the point of corpus mode — so this is the same job
 * against the other store. It shares the parts that matter: the encoder in
 * src/app/features/pdf-picker/services/rubric-encoder.ts and the inference path
 * in electron/rubric-bridge.ts, both called rather than reimplemented.
 *
 * TWO THINGS IT DOES THAT THE PROJECT VERSION DOES NOT:
 *
 * 1. `--keep-pages` is a hard exclusion, not a preference. Hand-corrected pages
 *    are the expensive artifact; a model pass over them would replace judgement
 *    with a guess. Those pages are never sent to the model and never written.
 *
 * 2. It SCORES itself on those kept pages before writing anything else. They are
 *    the one part of the book known to be right, which makes them free ground
 *    truth — so every run reports how well the model actually did on THIS book
 *    rather than asking anyone to trust a corpus-wide average. If the number is
 *    bad, the right move is to throw the run away, and you cannot make that call
 *    without measuring it.
 *
 * Blocks and page geometry both come from labels.json, so no PDF is opened and
 * no OCR runs: the block ids the labels are keyed to are exactly the ids the
 * predictions land on. Re-OCR would mint new ids and orphan the lot.
 *
 * WRITES ARE REFUSED IF labels.json CHANGED while the model was running — a book
 * left open in the editor saves over it, and a run that started from different
 * blocks must not win that race silently.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENCODER = path.join(REPO_ROOT, 'dist', 'rubric', 'features', 'pdf-picker',
  'services', 'rubric-encoder.js');
const TRAINING_ROOT = path.join(os.homedir(), 'Documents', 'BookForge', 'training');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

function usage(msg) {
  if (msg) console.error(`rubric-detect-corpus: ${msg}`);
  console.error(
    'usage: node --require cli/electron-stub.js tools/rubric-detect-corpus.js --book <slug>\n' +
    '         [--model rubric-v4-4b] [--backend local|ollama|service] [--endpoint URL]\n' +
    '         [--keep-pages A-B] [--pages A-B] [--batch 8] [--ctx 12288] [--dry-run]\n\n' +
    '  --keep-pages  0-based inclusive range left completely alone (not classified,\n' +
    '                not written) AND used as ground truth to score the run.\n' +
    '  --pages       restrict classification to this range, minus --keep-pages.\n' +
    '  --dry-run     classify and score, write nothing.');
  process.exit(msg ? 1 : 0);
}
if (flag('help') || flag('h') || !argv.length) usage();

const bookArg = opt('book');
if (!bookArg) usage('--book <slug> is required');
const bookDir = path.isAbsolute(bookArg) ? bookArg : path.join(TRAINING_ROOT, bookArg);
const labelsFile = path.join(bookDir, 'labels.json');
if (!fs.existsSync(labelsFile)) usage(`no labels.json in ${bookDir}`);

const model = opt('model', 'rubric-v4-4b');
const backend = opt('backend', 'local');
if (!['local', 'ollama', 'service'].includes(backend)) usage('--backend must be local, ollama or service');
const endpoint = opt('endpoint',
  backend === 'ollama' ? 'http://127.0.0.1:11434'
    : backend === 'service' ? 'http://127.0.0.1:8770' : '');
const batch = Number(opt('batch', '8'));
if (!Number.isInteger(batch) || batch < 1) usage('--batch must be a positive integer');
// 12288, matching electron/rubric-server.ts. 8192 truncates dense v4 pages from
// the END of the block list, and the model then answers about blocks it never
// saw — silently, because a truncated prompt is still a valid prompt.
const numCtx = Number(opt('ctx', '12288'));
const dryRun = flag('dry-run');

/** "A-B" or "N" → a 0-based inclusive test, or null. */
function rangeOpt(name) {
  const raw = opt(name, null);
  if (raw === null) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw);
  if (!m) usage(`--${name} wants N or A-B (0-based, inclusive), got ${raw}`);
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (b < a) usage(`--${name} range runs backwards: ${raw}`);
  return { a, b, has: (p) => p >= a && p <= b, text: `${a}-${b}` };
}
const keep = rangeOpt('keep-pages');
const only = rangeOpt('pages');

function requireBuilt(rel, what, how) {
  const p = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`rubric-detect-corpus: ${what} is not built (${p}).\n         ${how}`);
    process.exit(1);
  }
  return require(p);
}

const enc = fs.existsSync(ENCODER) ? require(ENCODER) : (() => {
  console.error(`rubric-detect-corpus: the block encoder is not built (${ENCODER}).\n` +
    '         Build it with:  npx tsc src/app/features/pdf-picker/services/rubric-encoder.ts' +
    ' --outDir dist/rubric --module commonjs --target es2022 --skipLibCheck');
  process.exit(1);
})();
const { rubricClassify } = requireBuilt('dist/electron/rubric-bridge.js', 'the rubric bridge',
  'Build the main process with:  npm run build:electron');

/** Read labels.json along with the mtime the write will be checked against. */
function readSession() {
  const stat = fs.statSync(labelsFile);
  const session = JSON.parse(fs.readFileSync(labelsFile, 'utf-8'));
  if (!Array.isArray(session.blocks) || !session.blocks.length) {
    console.error(`rubric-detect-corpus: ${labelsFile} has no blocks`);
    process.exit(1);
  }
  if (!Array.isArray(session.pageDimensions) || !session.pageDimensions.length) {
    console.error(`rubric-detect-corpus: ${labelsFile} has no pageDimensions`);
    process.exit(1);
  }
  return { session, mtimeMs: stat.mtimeMs };
}

/** Per-class precision/recall/F1 plus macro-F1 — the metric the corpus is judged on. */
function score(pairs) {
  const classes = [...new Set(pairs.flatMap(([g, p]) => [g, p]))].sort();
  const rows = [];
  let correct = 0;
  for (const [g, p] of pairs) if (g === p) correct++;
  for (const c of classes) {
    const tp = pairs.filter(([g, p]) => g === c && p === c).length;
    const fp = pairs.filter(([g, p]) => g !== c && p === c).length;
    const fn = pairs.filter(([g, p]) => g === c && p !== c).length;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    rows.push({ c, support: tp + fn, prec, rec, f1 });
  }
  // Macro-F1 over classes PRESENT IN GOLD. Averaging over predicted-only classes
  // would let a class the book does not contain drag the number around.
  const gold = rows.filter(r => r.support > 0);
  const macro = gold.length ? gold.reduce((s, r) => s + r.f1, 0) / gold.length : 0;
  return { rows, macro, accuracy: pairs.length ? correct / pairs.length : 0, n: pairs.length };
}

async function main() {
  const { session, mtimeMs } = readSession();
  const blocks = session.blocks;
  const labels = session.labels || {};
  const pageDimensions = session.pageDimensions.map(d => ({ width: d.width || 0, height: d.height || 0 }));

  console.log(`[corpus-detect] ${path.basename(bookDir)}`);
  console.log(`[corpus-detect]   ${blocks.length} blocks, ${Object.keys(labels).length} labelled, ` +
    `${pageDimensions.length} pages, blockSource=${session.blockSource ?? '?'}`);
  if (session.blockSource !== 'ocr') {
    // Worth saying out loud: rubric is trained on Tesseract paragraphs and served
    // Tesseract paragraphs. An embedded text layer segments differently, so the
    // score below is measuring that mismatch as well as the model.
    console.log(`[corpus-detect]   NOTE: blocks are '${session.blockSource}', not OCR — the model ` +
      'was trained on OCR segmentation, so expect the score to understate it on OCR books.');
  }

  const version = enc.rubricVersionFor(model);
  const all = enc.encodeBook(blocks, pageDimensions, { version, totalPages: pageDimensions.length });

  // The whole book is encoded before filtering: book-level features (r, the
  // repeat rate; the body-type baseline) are computed across every page, so
  // encoding a slice would describe a different book.
  let encoded = all;
  if (only) encoded = encoded.filter(p => only.has(p.page));
  const keptPages = keep ? all.filter(p => keep.has(p.page)) : [];
  if (keep) encoded = encoded.filter(p => !keep.has(p.page));

  if (!encoded.length && !keptPages.length) {
    console.error('rubric-detect-corpus: no pages selected');
    process.exit(1);
  }
  console.log(`[corpus-detect]   model ${model} (prompt v${version}), ctx ${numCtx}, ` +
    (endpoint ? `${backend} at ${endpoint}` : `${backend} (bundled llama-server)`));
  if (keep) {
    console.log(`[corpus-detect]   keeping pages ${keep.text} untouched ` +
      `(${keptPages.length} pages) and scoring against them`);
  }
  console.log(`[corpus-detect]   classifying ${encoded.length} pages` +
    (keptPages.length ? ` + ${keptPages.length} scored-only` : ''));

  const started = Date.now();
  const predictions = {};
  const unpredicted = [];
  let done = 0;
  // Kept pages go through the model too, but their answers are only ever scored —
  // never written. That is what makes the score honest and the pages safe.
  const queue = [...encoded, ...keptPages];

  for (let i = 0; i < queue.length; i += batch) {
    const slice = queue.slice(i, i + batch);
    const res = await rubricClassify({
      endpoint, backend, model, batch, numCtx,
      stop: enc.RUBRIC_STOP,
      pages: slice.map(p => ({ system: p.system, user: p.user, raw: enc.toRawPrompt(p) })),
    });
    if (!res.success) { console.error(`\nrubric-detect-corpus: ${res.error}`); process.exit(1); }
    slice.forEach((p, k) => {
      const parsed = enc.parseAnswer(res.answers[k] ?? '', p.blockIds, version);
      for (const [id, cat] of parsed) predictions[id] = cat;
      for (const id of p.blockIds) if (!parsed.has(id)) unpredicted.push(id);
      done++;
    });
    const secs = (Date.now() - started) / 1000;
    process.stderr.write(`\r[corpus-detect] ${done}/${queue.length} pages  ` +
      `${(done / secs).toFixed(2)} pg/s  eta ${Math.round((queue.length - done) / (done / secs))}s   `);
  }
  process.stderr.write('\n');

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[corpus-detect] predicted ${Object.keys(predictions).length} blocks in ${elapsed}s` +
    (unpredicted.length ? `, ${unpredicted.length} left unlabelled (dropped, not guessed)` : ''));

  // ── the measurement ────────────────────────────────────────────────────────
  let report = null;
  if (keptPages.length) {
    const keptIds = new Set(keptPages.flatMap(p => p.blockIds));
    const pairs = [];
    for (const id of keptIds) {
      const gold = labels[id];
      const pred = predictions[id];
      if (gold && pred) pairs.push([gold, pred]);
    }
    report = score(pairs);
    console.log('');
    console.log(`[corpus-detect] ── scored on hand-corrected pages ${keep.text} ──`);
    console.log(`[corpus-detect]    ${report.n} blocks   accuracy ${(report.accuracy * 100).toFixed(2)}%   ` +
      `macro-F1 ${report.macro.toFixed(4)}`);
    console.log('[corpus-detect]    class         gold   prec    rec     F1');
    for (const r of report.rows.filter(r => r.support > 0).sort((a, b) => b.support - a.support)) {
      console.log(`[corpus-detect]    ${r.c.padEnd(13)}${String(r.support).padStart(4)}  ` +
        `${r.prec.toFixed(2)}   ${r.rec.toFixed(2)}   ${r.f1.toFixed(2)}`);
    }
    const overFired = report.rows.filter(r => r.support === 0 && r.prec === 0);
    if (overFired.length) {
      console.log(`[corpus-detect]    predicted but absent from gold: ${overFired.map(r => r.c).join(' ')}`);
    }
    console.log('');
  }

  const counts = {};
  for (const [id, c] of Object.entries(predictions)) {
    if (keep && keptPages.some(p => p.blockIds.includes(id))) continue;
    counts[c] = (counts[c] || 0) + 1;
  }
  console.log('[corpus-detect] writing: ' +
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(' '));
  const absent = enc.rubricCategories(version).filter(c => !counts[c]);
  if (absent.length) console.log(`[corpus-detect] never predicted: ${absent.join(' ')}`);

  if (dryRun) { console.log('[corpus-detect] --dry-run, nothing written'); return; }

  // ── the write ──────────────────────────────────────────────────────────────
  // Re-stat rather than trusting the copy in memory: the editor writes the whole
  // file on save, so a book reopened during the run would have its work replaced
  // by predictions computed from the blocks as they were before.
  const now = fs.statSync(labelsFile);
  if (now.mtimeMs !== mtimeMs) {
    console.error(`\nrubric-detect-corpus: ${labelsFile} changed while the model was running ` +
      '(the book was probably open in the editor). NOTHING WAS WRITTEN — close it and re-run.');
    process.exit(1);
  }

  const keptIds = new Set(keptPages.flatMap(p => p.blockIds));
  const next = { ...session.labels };
  let written = 0, kept = 0;
  for (const [id, cat] of Object.entries(predictions)) {
    if (keptIds.has(id)) { kept++; continue; }
    next[id] = cat;
    written++;
  }

  const out = {
    ...session,
    labelSet: session.labelSet,
    savedAt: new Date().toISOString(),
    labels: next,
  };
  const tmp = `${labelsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
  fs.renameSync(tmp, labelsFile);
  console.log(`[corpus-detect] wrote ${written} predicted labels into ${labelsFile}` +
    (kept ? `, left ${kept} hand-corrected blocks alone` : ''));

  // The run is snapshotted beside the labels, not merged into them: rubric-report
  // diffs final labels against this to recover exactly which blocks a human had
  // to fix, which is the measurement that says where the model is weak.
  const snapshot = path.join(bookDir, 'rubric-predictions.json');
  fs.writeFileSync(snapshot, JSON.stringify({
    model, promptVersion: version, ranAt: out.savedAt,
    keptPages: keep ? keep.text : null,
    scoredOnKeptPages: report && {
      blocks: report.n, accuracy: report.accuracy, macroF1: report.macro,
      perClass: report.rows,
    },
    pagesClassified: encoded.length,
    predictions, unpredicted,
  }, null, 1), 'utf-8');
  console.log(`[corpus-detect] run snapshot → ${snapshot}`);
  console.log('[corpus-detect] Reopen the book in the Training tab and correct what is wrong.');
}

main().catch((err) => {
  console.error('\nrubric-detect-corpus failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

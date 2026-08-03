#!/usr/bin/env node
/**
 * blocks-detect — run the page-layout model over a project and PERSIST the answer.
 *
 *   node --require cli/electron-stub.js cli/blocks-detect.js --project <dir> \
 *        [--model blocks-v3-4b] [--backend local|ollama|service] [--batch 8]
 *        [--pages a-b] [--dry-run]
 *
 * The difference from `blocks-classify` is where the answer goes. classify reads a
 * blocks.json and writes a predictions.json — good for scoring a checkpoint, no use
 * for labelling. This reads the project's OWN stored blocks and writes back into
 * the manifest, so the book opens in the picker already painted with the model's
 * guesses and a human corrects from there instead of labelling from scratch.
 *
 * That correction is the product, twice over: it is a labelled block for the corpus
 * AND a measurement of where the model fails. `cli/blocks-report.js` recovers the
 * second by diffing this run against the corrections made after it, which is why
 * the run is snapshotted immutably rather than merged into the labels.
 *
 * The app's in-picker Detect mode deliberately does NOT persist — it is a preview,
 * dropped on close. Right for "what would the model say"; useless for a loop that
 * needs the predictions still there tomorrow.
 *
 * Everything load-bearing is the app's own code, as with every other CLI command:
 *   prompt      src/app/features/pdf-picker/services/blocks-encoder.ts
 *   inference   electron/blocks-bridge.ts
 *   persistence electron/blocks-predictions.ts
 *   page sizes  electron/pdf-analyzer.ts (analyzeQuick)
 *
 * RUN IT WITH THE BOOK CLOSED. The picker writes editor.ocrBlocks on save, so an
 * open book will overwrite whatever this stores.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

function usage(msg) {
  if (msg) console.error(`blocks-detect: ${msg}`);
  console.error(
    'usage: node --require cli/electron-stub.js cli/blocks-detect.js --project <dir>\n' +
    '         [--model NAME] [--backend local|ollama|service] [--batch 8]\n' +
    '         [--pages a-b] [--dry-run]\n\n' +
    '  Writes editor.blocksPredictions and paints editor.ocrBlocks[].category_id.\n' +
    '  Blocks you have already hand-laballed are never repainted.');
  process.exit(msg ? 1 : 0);
}
if (flag('help') || flag('h') || !argv.length) usage();

const projectDir = opt('project');
if (!projectDir) usage('--project <dir> is required');
if (!fs.existsSync(path.join(path.resolve(projectDir), 'manifest.json'))) {
  usage(`no manifest.json in ${projectDir}`);
}
const backend = opt('backend', 'local');
if (!['local', 'ollama', 'service'].includes(backend)) usage('--backend must be local, ollama or service');
const model = opt('model', 'blocks-v3-4b');
const endpoint = opt('endpoint',
  backend === 'ollama' ? 'http://127.0.0.1:11434'
    : backend === 'service' ? 'http://127.0.0.1:8770' : '');
const batch = Number(opt('batch', '8'));
if (!Number.isInteger(batch) || batch < 1) usage('--batch must be a positive integer');
const pagesOpt = opt('pages', null);
const dryRun = flag('dry-run');

function requireBuilt(rel, what, how) {
  const p = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`blocks-detect: ${what} is not built (${p}).\n         ${how}`);
    process.exit(1);
  }
  return require(p);
}

const { loadBlocksEncoder } = require('./lib/load-blocks-encoder');
const enc = loadBlocksEncoder();
const { blocksClassify } = requireBuilt('dist/electron/blocks-bridge.js', 'the blocks bridge',
  'Build the main process with:  npm run build:electron');
const preds = requireBuilt('dist/electron/blocks-predictions.js', 'the prediction store',
  'Build the main process with:  npm run build:electron');

/** The project's source PDF — needed only for page sizes, which the manifest lacks. */
function findPdf(dir) {
  const archive = path.join(dir, 'archive');
  if (!fs.existsSync(archive)) return null;
  const hit = fs.readdirSync(archive).filter(f => f.toLowerCase().endsWith('.pdf'))[0];
  return hit ? path.join(archive, hit) : null;
}

async function main() {
  const ref = preds.resolveProjectRef(projectDir);
  const { blocks, corrections } = await preds.readProjectBlocks(ref);
  console.log(`[detect] ${path.basename(ref.projectDir)}`);
  console.log(`[detect]   ${blocks.length} stored blocks, ${Object.keys(corrections).length} already hand-labelled`);

  // Page dimensions are NOT in the manifest, and the encoder needs them: every
  // geometric feature is a fraction of the page, so a substituted size silently
  // moves every block. analyzeQuick is the cheap read — no rendering, no OCR.
  const pdf = findPdf(ref.projectDir);
  if (!pdf) {
    console.error(`blocks-detect: no PDF in ${path.join(ref.projectDir, 'archive')} — cannot read page sizes`);
    process.exit(1);
  }
  const { PDFAnalyzer } = requireBuilt('dist/electron/pdf-analyzer.js', 'the PDF analyzer',
    'Build the main process with:  npm run build:electron');
  const quick = await new PDFAnalyzer().analyzeQuick(pdf);
  const pageDimensions = (quick.page_dimensions || []).map(
    d => ({ width: d.width || 0, height: d.height || 0 }));
  if (!pageDimensions.length) {
    console.error('blocks-detect: the analyzer reported no page dimensions');
    process.exit(1);
  }

  const version = enc.blocksVersionFor(model);
  let encoded = enc.encodeBook(blocks, pageDimensions, { version, totalPages: pageDimensions.length });
  if (pagesOpt) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(pagesOpt);
    if (!m) usage(`--pages wants N or A-B (0-based, inclusive), got ${pagesOpt}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    encoded = encoded.filter(p => p.page >= a && p.page <= b);
  }
  if (!encoded.length) { console.error('blocks-detect: no pages to classify'); process.exit(1); }

  console.log(`[detect]   ${encoded.length} pages, model ${model} (prompt v${version}), ` +
    (endpoint ? `${backend} at ${endpoint}` : `${backend} (bundled llama-server)`));

  const started = Date.now();
  const predictions = {};
  const unpredicted = [];
  let done = 0;

  for (let i = 0; i < encoded.length; i += batch) {
    const slice = encoded.slice(i, i + batch);
    const res = await blocksClassify({
      endpoint, backend, model, batch,
      stop: enc.BLOCKS_STOP,
      // Must exceed the longest prompt. A host with a smaller window TRUNCATES
      // silently, and the model then answers about blocks it never saw.
      numCtx: 8192,
      pages: slice.map(p => ({ system: p.system, user: p.user, raw: enc.toRawPrompt(p) })),
    });
    if (!res.success) { console.error(`\nblocks-detect: ${res.error}`); process.exit(1); }
    slice.forEach((p, k) => {
      const parsed = enc.parseAnswer(res.answers[k] ?? '', p.blockIds, version);
      for (const [id, cat] of parsed) predictions[id] = cat;
      for (const id of p.blockIds) if (!parsed.has(id)) unpredicted.push(id);
      done++;
    });
    const secs = (Date.now() - started) / 1000;
    process.stderr.write(`\r[detect] ${done}/${encoded.length} pages  ` +
      `${(done / secs).toFixed(2)} pg/s  eta ${Math.round((encoded.length - done) / (done / secs))}s   `);
  }
  process.stderr.write('\n');

  const counts = {};
  for (const c of Object.values(predictions)) counts[c] = (counts[c] || 0) + 1;
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(' ');
  console.log(`[detect] predicted ${Object.keys(predictions).length} blocks in ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s` +
    (unpredicted.length ? `, ${unpredicted.length} left unlabelled (dropped, not guessed)` : ''));
  console.log(`[detect] ${summary}`);

  // Absent classes are a finding, not a formatting detail: `table` and `subheading`
  // score 0.00 on held-out books, so a book that should contain them and gets none
  // is telling you which labelling work is worth the most. The legal set is the
  // encoder's, per prompt version — not a list repeated here that could drift.
  const absent = enc.blocksCategories(version).filter(c => !counts[c]);
  if (absent.length) console.log(`[detect] never predicted: ${absent.join(' ')}`);

  if (dryRun) { console.log('[detect] --dry-run, nothing written'); return; }

  const written = await preds.persistBlocksPredictions(ref, {
    model, promptVersion: version,
    ranAt: new Date().toISOString(),
    predictions, unpredicted,
    pages: encoded.length,
  });
  console.log(`[detect] painted ${written.applied} block(s) into ${written.manifestPath}`);
  if (written.skippedHandLabelled > 0) {
    console.log(`[detect] left ${written.skippedHandLabelled} hand-labelled block(s) alone`);
  }
  console.log('[detect] Open it in the picker and correct what is wrong, then:');
  console.log(`[detect]   node --require cli/electron-stub.js cli/blocks-report.js --project ${projectDir}`);
}

main().catch((err) => {
  console.error('\nblocks-detect failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

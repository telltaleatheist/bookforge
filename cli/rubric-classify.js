#!/usr/bin/env node
/**
 * rubric-classify — run the block-category model over a book's OCR blocks.
 *
 *   node --require cli/electron-stub.js cli/rubric-classify.js <blocks.json> \
 *        --out <predictions.json> [--model rubric-v3-4b] [--endpoint URL]
 *        [--backend local|ollama|service] [--pages a-b] [--batch 8]
 *
 * Batch equivalent of the picker's Detect mode. Like every other CLI command it
 * drives the app's own code rather than reimplementing it:
 *
 *   prompt building   src/app/features/pdf-picker/services/rubric-encoder.ts
 *                     (`encodeBook`, `toRawPrompt`) — THE contract. A renamed
 *                     field or a moved decimal degrades the fine-tune in a way
 *                     that looks exactly like a bad model, so there is one
 *                     implementation and this uses it.
 *   inference         electron/rubric-bridge.ts (`rubricClassify`), which
 *                     owns the raw:true / no-template / num_ctx handling.
 *   answer parsing    the encoder's `parseAnswer`, which drops illegal classes
 *                     rather than inventing them.
 *
 * Local here: reading blocks.json, mapping its fields onto TextBlock, and
 * writing the result. The encoder is a renderer module, so it is compiled
 * standalone first (its only import is `import type`) — see ENCODER below.
 *
 * The model name is LOAD-BEARING: `rubricVersionFor()` reads v1/v2/v3 out of
 * it to pick the system prompt and the legal class list. A v3 adapter served
 * under a name containing no version reads as v1 and gets a prompt advertising
 * a taxonomy it never saw.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENCODER = path.join(REPO_ROOT, 'dist', 'rubric', 'features', 'pdf-picker',
  'services', 'rubric-encoder.js');
const BRIDGE = path.join(REPO_ROOT, 'dist', 'electron', 'rubric-bridge.js');

function usage(msg) {
  if (msg) console.error(`rubric-classify: ${msg}`);
  console.error(
    'usage: node --require cli/electron-stub.js cli/rubric-classify.js <blocks.json>\n' +
    '           --out <predictions.json> [--model NAME] [--endpoint URL]\n' +
    '           [--backend local|ollama|service] [--pages a-b] [--batch 8]');
  process.exit(msg ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage();
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

const blocksPath = positional[0];
if (!blocksPath) usage('a blocks.json path is required');
if (!fs.existsSync(blocksPath)) usage(`no such file: ${blocksPath}`);
const outPath = opt('out');
if (!outPath) usage('--out <predictions.json> is required');

// Defaults to the BUILT-IN runtime — the same downloaded GGUF on the same bundled
// llama-server the app uses, so a CLI run exercises the shipping path and its
// bugs surface here. `service` and `ollama` remain for a checkpoint that has not
// been quantized and published yet.
const backend = opt('backend', 'local');
if (!['local', 'ollama', 'service'].includes(backend)) {
  usage(`--backend must be local, ollama or service`);
}
const model = opt('model', 'rubric-v3-4b');
const endpoint = opt('endpoint',
  backend === 'ollama' ? 'http://127.0.0.1:11434'
    : backend === 'service' ? 'http://127.0.0.1:8770'
      : '');   // the built-in server owns its own port
const batch = Number(opt('batch', '8'));
if (!Number.isInteger(batch) || batch < 1) usage(`--batch must be a positive integer`);
const pagesOpt = opt('pages', null);

function requireBuilt(p, what, how) {
  if (!fs.existsSync(p)) {
    console.error(`rubric-classify: ${what} is not built (${p}).\n         ${how}`);
    process.exit(1);
  }
  return require(p);
}

const enc = requireBuilt(ENCODER, 'the block encoder',
  'Build it with:  npx tsc src/app/features/pdf-picker/services/rubric-encoder.ts' +
  ' --outDir dist/rubric --module commonjs --target es2022 --skipLibCheck');
const { rubricClassify } = requireBuilt(BRIDGE, 'the rubric bridge',
  'Build the main process with:  npm run build:electron');

/**
 * blocks.json (cli/ocr-pdf.js or tools/aligner/ocr-book.mjs) -> TextBlock.
 *
 * Field renames only. The one derived value is `id`, because blocks.json has no
 * ids and the encoder needs stable ones to key predictions by — `p<page>b<i>`
 * over the sorted block order, which is the same order the prompt lists them in.
 */
function toTextBlocks(blocks) {
  const perPage = new Map();
  return blocks.map((b) => {
    const n = (perPage.get(b.page) ?? 0);
    perPage.set(b.page, n + 1);
    const first = b.lineBoxes && b.lineBoxes.length ? b.lineBoxes[0] : null;
    return {
      // Post-processed blocks.json carries the manifest's own ids — use them, so
      // predictions keyed here join directly against project labels. The derived
      // id remains for old raw-paragraph files, which had none.
      id: b.id ?? `p${b.page}b${n}`,
      page: b.page,
      x: b.x, y: b.y, width: b.w, height: b.h,
      text: b.text,
      font_size: b.fsize,
      font_name: 'OCR',
      char_count: b.text.length,
      region: '',
      category_id: '',
      line_count: b.lineCount,
      is_ocr: true,
      ocr_confidence: b.conf,
      // Typography, best source first: the post-processed file's block-level
      // majority vote, else the raw file's first line-box fractions. The encoder
      // treats these as optional, so a corpus-tool blocks.json without either
      // still encodes — just without the bold/italic signal.
      is_bold: b.bold !== undefined ? b.bold
        : first && first.boldFrac !== undefined ? first.boldFrac >= 0.5 : undefined,
      is_italic: b.italic !== undefined ? b.italic
        : first && first.italicFrac !== undefined ? first.italicFrac >= 0.5 : undefined,
    };
  });
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(blocksPath, 'utf-8'));
  if (!Array.isArray(doc.blocks) || !doc.blocks.length) {
    console.error('rubric-classify: blocks.json has no blocks');
    process.exit(1);
  }

  const version = enc.rubricVersionFor(model);
  const blocks = toTextBlocks(doc.blocks);
  const pageDimensions = (doc.pageDimensions || []).map(
    (d) => d ? { width: d.width, height: d.height } : { width: 0, height: 0 });
  const totalPages = pageDimensions.length || (Math.max(...blocks.map(b => b.page)) + 1);

  let encoded = enc.encodeBook(blocks, pageDimensions, { version, totalPages });
  if (pagesOpt) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(pagesOpt);
    if (!m) usage(`--pages wants N or A-B (0-based, inclusive), got ${pagesOpt}`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    encoded = encoded.filter((p) => p.page >= a && p.page <= b);
  }
  if (!encoded.length) {
    console.error('rubric-classify: no pages to classify after filtering');
    process.exit(1);
  }

  console.log(`[rubric] ${encoded.length} pages, ${blocks.length} blocks, ` +
    `model ${model} (prompt v${version}), ` +
    (endpoint ? `${backend} at ${endpoint}` : `${backend} (bundled llama-server)`));

  const started = Date.now();
  const predictions = {};
  const perPage = [];
  let done = 0, unparsed = 0;

  // Chunked rather than one request: a 380-page book in a single POST would
  // hold every answer in flight and report nothing until the end.
  for (let i = 0; i < encoded.length; i += batch) {
    const slice = encoded.slice(i, i + batch);
    const res = await rubricClassify({
      endpoint,
      backend,
      model,
      batch,
      stop: enc.RUBRIC_STOP,
      // Must exceed the longest prompt. Ollama otherwise reads the window from
      // GGUF metadata and a host with a smaller default TRUNCATES silently,
      // leaving the model answering about blocks it never saw.
      numCtx: 8192,
      pages: slice.map((p) => ({
        system: p.system, user: p.user, raw: enc.toRawPrompt(p),
      })),
    });
    if (!res.success) {
      console.error(`\nrubric-classify: ${res.error}`);
      process.exit(1);
    }
    slice.forEach((p, k) => {
      const answer = res.answers[k] ?? '';
      const parsed = enc.parseAnswer(answer, p.blockIds, version);
      for (const [id, cat] of parsed) predictions[id] = cat;
      const missing = p.blockIds.length - parsed.size;
      if (missing > 0) unparsed += missing;
      perPage.push({ page: p.page, blocks: p.blockIds.length, predicted: parsed.size });
      done++;
    });
    const secs = (Date.now() - started) / 1000;
    process.stderr.write(`\r[rubric] ${done}/${encoded.length} pages  ` +
      `${(done / secs).toFixed(2)} pg/s  eta ${Math.round((encoded.length - done) / (done / secs))}s   `);
  }
  process.stderr.write('\n');

  const counts = {};
  for (const c of Object.values(predictions)) counts[c] = (counts[c] || 0) + 1;

  fs.writeFileSync(outPath, JSON.stringify({
    blocksFile: path.resolve(blocksPath),
    pdf: doc.pdf,
    model, promptVersion: version, backend, endpoint,
    pages: encoded.length,
    blocks: encoded.reduce((n, p) => n + p.blockIds.length, 0),
    predicted: Object.keys(predictions).length,
    counts,
    perPage,
    // Keyed by the derived block id, which is a pure function of blocks.json's
    // sorted order — so re-deriving it from the same file reproduces the join.
    predictions,
  }, null, 1));

  const total = encoded.reduce((n, p) => n + p.blockIds.length, 0);
  console.log(`[rubric] predicted ${Object.keys(predictions).length}/${total} blocks` +
    (unparsed ? ` (${unparsed} unlabelled — dropped rather than guessed)` : '') +
    ` in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('[rubric] ' + Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} ${n}`).join('  '));
  console.log(`[rubric] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('\nrubric-classify failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

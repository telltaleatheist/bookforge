/**
 * rvc-convert.js — headless whole-file RVC voice conversion, memory-safe.
 *
 * Drives the REAL compiled runner (rvc-bridge.convertFileRvcChunked): silence-chunks
 * the input, converts each chunk in a RECYCLED worker process (each exits between
 * batches so unified memory is reclaimed — a full audiobook never balloons into swap
 * the way one long convert-dir does), then stitches the chunks back into --out. No
 * pipeline logic is reimplemented here; this only parses args and wires the call.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/rvc-convert.js \
 *        --input book.m4a --out "book RVC.flac" --model deathstalker_rvc_v1 \
 *        --index-rate 0 --protect-rate 0.2 --f0-method rmvpe
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('./electron-stub.js');   // intercept require('electron') for the compiled bridge

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; }
    else { a[body] = true; }
  }
  return a;
}

const numOr = (v, d) => (v === undefined ? d : Number(v));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error('--input <audio> is required');
  if (!args.out) throw new Error('--out <file> is required');
  if (!args.model) throw new Error('--model <rvc voice-model folder> is required');
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);

  const rvc = require('../dist/electron/rvc-bridge.js');
  if (typeof rvc.convertFileRvcChunked !== 'function') {
    throw new Error('compiled rvc-bridge missing convertFileRvcChunked — rebuild (npx tsc -p tsconfig.electron.json)');
  }
  const ready = rvc.rvcEnhancementReady();
  if (!ready.ok) throw new Error(ready.reason);

  // Ctrl+C → cooperative abort. (convertFileRvcChunked kills the child on abort; this
  // is an explicit user cancel, the one case where killing RVC mid-run is accepted.)
  const ac = new AbortController();
  process.on('SIGINT', () => { console.log('\n[rvc] SIGINT — aborting...'); ac.abort(); });
  process.on('SIGTERM', () => { console.log('\n[rvc] SIGTERM — aborting...'); ac.abort(); });

  const t0 = Date.now();
  let lastPct = -1;
  const outPath = await rvc.convertFileRvcChunked({
    inputPath,
    outputPath: path.resolve(args.out),
    modelName: args.model,
    indexRate: numOr(args['index-rate'], 0.0),
    protectRate: numOr(args['protect-rate'], 0.2),
    f0Method: args['f0-method'] || 'rmvpe',
    chunkSeconds: numOr(args['chunk-seconds'], 600),
    batchSize: numOr(args['batch-size'], 4),
    signal: ac.signal,
    onProgress: (done, total) => {
      console.log(`[RVC] ${done}/${total}`);
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; }
    },
  });
  console.log(`[rvc] done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[rvc] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});

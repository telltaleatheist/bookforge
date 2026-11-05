/**
 * rvc-convert.js — headless whole-file RVC voice conversion, on a Crucible.
 *
 * Drives the REAL compiled door (crucible/rvc-file.convertFileAtVenue): silence-chunks
 * the input here, converts the chunks in a Crucible `rvc` job, then stitches them back
 * into --out. The server is --crucible-server when given, else the routing record
 * decides. No pipeline logic is reimplemented here; this only parses args and wires
 * the call. (It was a local urvc worker until 2026-11-04, docs/REORG-PLAN.md B2.)
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/rvc-convert.js \
 *        --input book.m4a --out "book RVC.flac" --model deathstalker_rvc_v1 \
 *        --index-rate 0 --protect-rate 0.2 --f0-method rmvpe [--crucible-server <name>]
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

  const { convertFileAtVenue } = require('../dist/electron/crucible/rvc-file.js');
  const { processVenueHost } = require('../dist/electron/crucible/generation-venue.js');
  if (args['crucible-server'] === true) throw new Error('--crucible-server needs a server name');
  if (args['batch-size'] !== undefined) {
    console.log('[rvc] --batch-size is not read: it bounded the deleted local worker, and the server owns its memory');
  }

  // Ctrl+C → cooperative abort: the door DELETEs the job on the server.
  const ac = new AbortController();
  process.on('SIGINT', () => { console.log('\n[rvc] SIGINT — aborting...'); ac.abort(); });
  process.on('SIGTERM', () => { console.log('\n[rvc] SIGTERM — aborting...'); ac.abort(); });

  const t0 = Date.now();
  let lastPct = -1;
  const { outputPath: outPath, venue, chunks } = await convertFileAtVenue({
    ...(args['crucible-server'] === undefined ? {} : { crucible: { server: String(args['crucible-server']) } }),
    host: processVenueHost(),
    inputPath,
    outputPath: path.resolve(args.out),
    modelFolder: args.model,
    knobs: {
      indexRate: numOr(args['index-rate'], 0.0),
      protectRate: numOr(args['protect-rate'], 0.2),
      f0Method: args['f0-method'] || 'rmvpe',
      // Pitch shift. Default 0 keeps existing callers identical.
      nSemitones: numOr(args['n-semitones'], 0),
    },
    chunkSeconds: numOr(args['chunk-seconds'], 600),
    signal: ac.signal,
    onLog: (line) => console.log(`[rvc] ${line}`),
    onProgress: (p) => {
      const pct = Math.floor((p.fraction ?? 0) * 100);
      if (pct !== lastPct) { lastPct = pct; console.log(`[RVC] ${pct}%`); }
    },
  });
  console.log(`[rvc] ${chunks} chunk(s) on crucible "${venue.server}"`);
  console.log(`[rvc] done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outPath}`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[rvc] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});

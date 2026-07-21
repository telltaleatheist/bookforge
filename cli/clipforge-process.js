/**
 * clipforge-process.js — headless ClipForge chain runner.
 *
 * Runs a recipe over an input WAV THROUGH the shared chain engine
 * (dist/electron/clipforge-chain.js) — the exact same module the ClipForge IPC
 * layer uses, so the CLI and GUI can never drift. Prints a human-readable
 * per-stage summary and the provenance path.
 *
 *   node cli/clipforge-process.js --input <wav> --recipe <recipe.json> \
 *        --out <out.wav> [--work-dir <dir>] [--keep-stages]
 *
 * BookForge must be BUILT (dist/electron present) but need NOT be running. The
 * electron shim is preloaded so the compiled bridge's `require('electron')`
 * (via tool-paths → ffmpeg/ffprobe resolution) resolves under plain node.
 *
 * NO FALLBACKS: a missing/invalid arg, an unknown engine, a bad setting, or a
 * failed ffmpeg invocation exits NON-ZERO with the thrown message. Nothing is
 * swallowed; nothing is silently defaulted.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
require('./electron-stub.js'); // intercept require('electron') for the compiled chain engine

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

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error('--input <wav> is required');
  if (!args.recipe) throw new Error('--recipe <recipe.json> is required');
  if (!args.out) throw new Error('--out <out.wav> is required');

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
  const recipePath = path.resolve(args.recipe);
  if (!fs.existsSync(recipePath)) throw new Error(`recipe not found: ${recipePath}`);
  const outputPath = path.resolve(args.out);

  // Work dir: explicit --work-dir, else a scratch dir next to the output. Not a
  // hidden default location — it is printed, and cleaned unless --keep-stages.
  const keepStages = args['keep-stages'] === true;
  const workDir = args['work-dir']
    ? path.resolve(args['work-dir'])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-stages-'));

  let recipe;
  try {
    recipe = JSON.parse(fs.readFileSync(recipePath, 'utf-8'));
  } catch (e) {
    throw new Error(`recipe JSON is unparseable (${recipePath}): ${e.message}`);
  }

  const chainModPath = path.resolve(__dirname, '..', 'dist', 'electron', 'clipforge-chain.js');
  if (!fs.existsSync(chainModPath)) {
    throw new Error(`compiled chain engine missing: ${chainModPath} — build first (npx tsc -p tsconfig.electron.json)`);
  }
  const chain = require(chainModPath);
  if (typeof chain.runChain !== 'function') {
    throw new Error('compiled clipforge-chain is missing runChain — rebuild (npx tsc -p tsconfig.electron.json)');
  }

  const t0 = Date.now();
  const result = await chain.runChain({ inputPath, recipe, outputPath, workDir, keepStages });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const prov = result.provenance;
  console.log('');
  console.log(`ClipForge chain — recipe "${prov.recipe.name}" (v${prov.recipe.recipeVersion})`);
  console.log(`  ffmpeg:  ${prov.ffmpegVersion}`);
  console.log(`  input:   ${prov.input.path}`);
  console.log(`           ${prov.input.sampleRate} Hz / ${prov.input.channels} ch / ` +
    `${prov.input.durationSeconds.toFixed(3)} s / ${fmtBytes(prov.input.sizeBytes)}`);
  console.log(`           sha256 ${prov.input.sha256}`);
  console.log('');
  console.log(`  stages (${prov.steps.length}):`);
  for (const s of prov.steps) {
    console.log(`   [${String(s.index).padStart(2, '0')}] ${s.engine}`);
    console.log(`        settings: ${JSON.stringify(s.settings)}`);
    console.log(`        filter:   ${s.ffmpegFilter}`);
    console.log(`        out:      ${s.outputDurationSeconds.toFixed(3)} s / ${fmtBytes(s.outputSizeBytes)}  ` +
      `(in ${s.inputDurationSeconds.toFixed(3)} s → out ${s.outputDurationSeconds.toFixed(3)} s)`);
    if (keepStages) console.log(`        stage wav: ${s.outputPath}`);
  }
  console.log('');
  console.log(`  output:  ${prov.output.path}`);
  console.log(`           ${prov.output.durationSeconds.toFixed(3)} s / ${fmtBytes(prov.output.sizeBytes)}`);
  console.log(`           sha256 ${prov.output.sha256}`);
  console.log(`  provenance: ${result.provenancePath}`);
  if (keepStages) console.log(`  work dir (stages kept): ${workDir}`);
  console.log(`  done in ${elapsed}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[clipforge-process] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});

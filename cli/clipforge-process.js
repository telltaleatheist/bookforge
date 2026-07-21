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
 * A second verb, `speakers`, buckets clips by voice actor (see runSpeakers):
 *   node cli/clipforge-process.js speakers --input <file-or-dir> --out <dir> \
 *        [--cluster-threshold X] [--mixed-threshold Y] [--min-clip 3] \
 *        [--max-clip 20] [--device cpu] [--python <python.exe>]
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
const { spawn } = require('child_process');
require('./electron-stub.js'); // intercept require('electron') for the compiled chain engine

// The dedicated conda env's python and the bundled ffmpeg. Hardcoded as
// DEFAULTS (overridable via --python / --ffmpeg) — never a silent fallback: a
// missing python FAILS LOUDLY below with an install hint.
const DEFAULT_SPEAKERS_PYTHON = 'C:\\Users\\tellt\\Miniforge3\\envs\\clipforge-speakers\\python.exe';
const DEFAULT_FFMPEG = 'C:\\Users\\tellt\\Miniforge3\\envs\\bookforge-urvc\\Library\\bin\\ffmpeg.exe';

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

async function runChainVerb(args) {
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

/**
 * speakers verb — bucket clips by voice actor via the resemblyzer worker.
 *
 * Delegates all audio work to cli/py/speaker_buckets.py in the dedicated
 * clipforge-speakers conda env. This JS side only validates args, locates the
 * env python + ffmpeg (FAILING LOUDLY with an install hint if the python is
 * missing — never a silent fallback), spawns the worker, relays its
 * progress/summary lines, and writes a run provenance JSON next to the output.
 */
async function runSpeakers(args) {
  if (!args.input) throw new Error('speakers: --input <file-or-dir> is required');
  if (!args.out) throw new Error('speakers: --out <dir> is required');

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const python = args.python ? path.resolve(args.python) : DEFAULT_SPEAKERS_PYTHON;
  if (!fs.existsSync(python)) {
    throw new Error(
      `speakers python not found: ${python}\n` +
      '  Create the dedicated env (one-time):\n' +
      '    C:\\Users\\tellt\\Miniforge3\\Scripts\\conda.exe create -n clipforge-speakers python=3.11 -y\n' +
      '    C:\\Users\\tellt\\Miniforge3\\envs\\clipforge-speakers\\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu\n' +
      '    C:\\Users\\tellt\\Miniforge3\\envs\\clipforge-speakers\\python.exe -m pip install resemblyzer soundfile librosa scipy webrtcvad-wheels\n' +
      '  ...or pass --python <python.exe> pointing at an env that has those packages.');
  }
  const ffmpeg = args.ffmpeg ? path.resolve(args.ffmpeg) : DEFAULT_FFMPEG;
  if (!fs.existsSync(ffmpeg)) {
    throw new Error(`ffmpeg not found: ${ffmpeg} — pass --ffmpeg <ffmpeg.exe>`);
  }

  const worker = path.resolve(__dirname, 'py', 'speaker_buckets.py');
  if (!fs.existsSync(worker)) throw new Error(`speaker worker missing: ${worker}`);

  // Thresholds (measured defaults live in the worker; only forward when the
  // user set them — no silent duplication of defaults across the two files).
  const numFlag = (name) => (args[name] === undefined ? undefined : Number(args[name]));
  const forwarded = {
    'cluster-threshold': numFlag('cluster-threshold'),
    'mixed-threshold': numFlag('mixed-threshold'),
    'mixed-min-frac': numFlag('mixed-min-frac'),
    'music-threshold': numFlag('music-threshold'),
    'uncertain-margin': numFlag('uncertain-margin'),
    'min-clip': numFlag('min-clip'),
    'max-clip': numFlag('max-clip'),
    'top-db': numFlag('top-db'),
    'window-rate': numFlag('window-rate'),
  };
  const device = args.device || 'cpu';

  const cmd = [worker, '--input', inputPath, '--out', outDir, '--ffmpeg', ffmpeg, '--device', device];
  for (const [k, v] of Object.entries(forwarded)) {
    if (v !== undefined) {
      if (Number.isNaN(v)) throw new Error(`--${k} must be a number`);
      cmd.push(`--${k}`, String(v));
    }
  }

  console.log(`ClipForge speakers — worker: ${worker}`);
  console.log(`  python:  ${python}`);
  console.log(`  input:   ${inputPath}`);
  console.log(`  out:     ${outDir}`);
  console.log(`  device:  ${device}`);
  console.log('');

  const t0 = Date.now();
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(python, cmd, { env });
    let stdoutBuf = '';
    let resultLine = null;
    let errorLine = null;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.startsWith('RESULT ')) { resultLine = line.slice(7); }
        else if (line.startsWith('ERROR ')) { errorLine = line.slice(6); console.error(`  ${line}`); }
        else if (line.startsWith('STAGE ')) { console.log(`  [stage] ${line.slice(6)}`); }
        else if (line.startsWith('PROGRESS ')) { /* swallow numeric heartbeat */ }
        else { console.log(line); }
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(errorLine || `speaker worker exited ${code}`));
        return;
      }
      if (!resultLine) { reject(new Error('speaker worker produced no RESULT line')); return; }
      try { resolve(JSON.parse(resultLine)); }
      catch (e) { reject(new Error(`speaker worker RESULT unparseable: ${e.message}`)); }
    });
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Run provenance next to the output (the worker also writes speakers.json;
  // this records the invocation itself — versions live inside speakers.json).
  const provenance = {
    verb: 'speakers',
    ranAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    python,
    ffmpeg,
    worker,
    input: inputPath,
    out: outDir,
    device,
    thresholds: Object.fromEntries(Object.entries(forwarded).filter(([, v]) => v !== undefined)),
    result,
    speakersJson: result.speakersJson,
  };
  const provPath = path.join(outDir, 'speakers.provenance.json');
  fs.writeFileSync(provPath, JSON.stringify(provenance, null, 2));

  console.log('');
  console.log(`  clusters: ${result.clusters}  music: ${result.music}  mixed: ${result.mixed}  uncertain: ${result.uncertain}`);
  console.log(`  embedded: ${result.embedded}/${result.total} clips`);
  console.log(`  speakers.json: ${result.speakersJson}`);
  console.log(`  provenance:    ${provPath}`);
  console.log(`  done in ${elapsed}s`);
  process.exit(0);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  // Optional leading verb (no leading '--'). Default verb is the chain runner,
  // so the historical `--input ... --recipe ...` invocation still works.
  let verb = 'chain';
  let rest = rawArgs;
  if (rawArgs.length > 0 && !rawArgs[0].startsWith('--')) {
    verb = rawArgs[0];
    rest = rawArgs.slice(1);
  }
  const args = parseArgs(rest);
  if (verb === 'speakers') return runSpeakers(args);
  if (verb === 'chain') return runChainVerb(args);
  throw new Error(`unknown verb: ${verb} (expected 'speakers' or a bare chain invocation)`);
}

main().catch((e) => {
  console.error('\n[clipforge-process] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});

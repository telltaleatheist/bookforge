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
 * Further verbs:
 *   `narration` — split a corpus into narration vs character-voice clips by the
 *      book's own quote marks (see runNarration). TEXT selects; exact.
 *   `verify`    — embedding sweep: is every clip really the narrator? (runVerify).
 *      Catches a FOREIGN voice; cannot separate character voices (they overlap).
 *   `merge`/`split` — Adobe round-trip (runMerge/runSplit)
 *   `sentences` — accurate per-clip transcripts from the epub (runSentences):
 *   node cli/clipforge-process.js sentences --clips <dir-or-list.txt> \
 *        --epub <book.epub> --out <dir> --speaker <name> \
 *        [--book-vtt <vtt> --spans <json>]   # map mode; else anchor (whisper)
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
// anchor mode transcribes with faster-whisper, which lives in the e2a runtime
// env. Map mode has no whisper dependency (runs fine under clipforge-speakers).
const DEFAULT_E2A_PYTHON = path.join(
  process.env.APPDATA || 'C:\\Users\\tellt\\AppData\\Roaming',
  'BookForge', 'runtime', 'e2a-env', 'python.exe');

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
  process.exitCode = 0;
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
  process.exitCode = 0;
}

/**
 * Spawn a cli/py worker, relaying its STAGE/ERROR lines and PROGRESS heartbeat,
 * and resolve the parsed RESULT-line JSON. Shared by the merge/split verbs (the
 * speakers verb predates this and keeps its own copy). NO FALLBACKS: a non-zero
 * exit or a missing RESULT rejects with the worker's own ERROR message.
 */
function spawnWorker(python, cmd) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  return new Promise((resolve, reject) => {
    const child = spawn(python, cmd, { env });
    let buf = '';
    let resultLine = null;
    let errorLine = null;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
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
      if (code !== 0) { reject(new Error(errorLine || `worker exited ${code}`)); return; }
      if (!resultLine) { reject(new Error('worker produced no RESULT line')); return; }
      try { resolve(JSON.parse(resultLine)); }
      catch (e) { reject(new Error(`worker RESULT unparseable: ${e.message}`)); }
    });
  });
}

function resolveMergemapWorker(args) {
  const python = args.python ? path.resolve(args.python) : DEFAULT_SPEAKERS_PYTHON;
  if (!fs.existsSync(python)) {
    throw new Error(
      `python not found: ${python}\n` +
      '  merge/split reuse the clipforge-speakers env (numpy + soundfile). Create it (one-time):\n' +
      '    C:\\Users\\tellt\\Miniforge3\\Scripts\\conda.exe create -n clipforge-speakers python=3.11 -y\n' +
      '    C:\\Users\\tellt\\Miniforge3\\envs\\clipforge-speakers\\python.exe -m pip install numpy soundfile librosa\n' +
      '  ...or pass --python <python.exe> pointing at an env that has numpy + soundfile.');
  }
  const worker = path.resolve(__dirname, 'py', 'clip_mergemap.py');
  if (!fs.existsSync(worker)) throw new Error(`mergemap worker missing: ${worker}`);
  return { python, worker };
}

/**
 * merge verb — assemble many clips into one wav for an Adobe Podcast round-trip.
 *
 * Two mutually-exclusive selection modes (exactly one required):
 *   --list <txt>                              (newline-delimited clip paths)
 *   --speakers <json> --bucket <c> --source <file> --minutes <N>
 *
 * The JS side validates the mode, locates the env python (+ ffmpeg for bucket
 * mode), spawns clip_mergemap.py, and writes a run provenance JSON. The worker
 * writes <out>.mergemap.json (the per-segment timeline).
 */
async function runMerge(args) {
  if (!args.out) throw new Error('merge: --out <out.wav> is required');
  const hasList = !!args.list;
  const bucketFlags = ['speakers', 'bucket', 'source', 'minutes'];
  const hasBucketAny = bucketFlags.some((k) => args[k] !== undefined);
  if (hasList && hasBucketAny) {
    throw new Error('merge: pass EITHER --list OR the --speakers/--bucket/--source/--minutes set, not both');
  }
  if (!hasList && !hasBucketAny) {
    throw new Error('merge: one selection mode required — --list <txt> OR --speakers <json> --bucket <c> --source <file> --minutes <N>');
  }
  const mode = hasList ? 'list' : 'bucket';
  if (mode === 'bucket') {
    for (const k of bucketFlags) {
      if (args[k] === undefined) throw new Error(`merge --speakers/bucket mode requires --${k}`);
    }
  }
  const gap = args.gap === undefined ? 0 : Number(args.gap);
  if (Number.isNaN(gap) || gap < 0) throw new Error('--gap must be a number >= 0');

  const outputPath = path.resolve(args.out);
  const { python, worker } = resolveMergemapWorker(args);

  const cmd = [worker, 'merge', '--mode', mode, '--out', outputPath, '--gap', String(gap)];
  let ffmpeg = null;
  if (mode === 'list') {
    const listPath = path.resolve(args.list);
    if (!fs.existsSync(listPath)) throw new Error(`--list file not found: ${listPath}`);
    cmd.push('--list', listPath);
  } else {
    const speakers = path.resolve(args.speakers);
    const source = path.resolve(args.source);
    if (!fs.existsSync(speakers)) throw new Error(`--speakers json not found: ${speakers}`);
    if (!fs.existsSync(source)) throw new Error(`--source not found: ${source}`);
    const minutes = Number(args.minutes);
    if (Number.isNaN(minutes) || minutes <= 0) throw new Error('--minutes must be a number > 0');
    ffmpeg = args.ffmpeg ? path.resolve(args.ffmpeg) : DEFAULT_FFMPEG;
    if (!fs.existsSync(ffmpeg)) throw new Error(`ffmpeg not found: ${ffmpeg} — pass --ffmpeg <ffmpeg.exe>`);
    cmd.push('--speakers', speakers, '--bucket', String(args.bucket),
      '--source', source, '--minutes', String(minutes), '--ffmpeg', ffmpeg);
  }

  console.log(`ClipForge merge — worker: ${worker}`);
  console.log(`  python:  ${python}`);
  console.log(`  mode:    ${mode}`);
  console.log(`  out:     ${outputPath}`);
  console.log(`  gap:     ${gap} s`);
  console.log('');

  const t0 = Date.now();
  const result = await spawnWorker(python, cmd);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const provenance = {
    verb: 'merge',
    ranAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    python, worker, ffmpeg,
    mode, gap, out: outputPath,
    selection: mode === 'list'
      ? { list: path.resolve(args.list) }
      : { speakers: path.resolve(args.speakers), bucket: args.bucket, source: path.resolve(args.source), minutes: Number(args.minutes) },
    result,
    mergemap: result.mergemapPath,
  };
  const provPath = outputPath + '.provenance.json';
  fs.writeFileSync(provPath, JSON.stringify(provenance, null, 2));

  console.log('');
  console.log(`  segments: ${result.segments}  ${result.sampleRate} Hz / ${result.channels} ch  total ${result.totalDuration.toFixed(3)} s`);
  console.log(`  mergemap:   ${result.mergemapPath}`);
  console.log(`  provenance: ${provPath}`);
  console.log(`  done in ${elapsed}s`);
  process.exitCode = 0;
}

/**
 * split verb — cut an Adobe-enhanced file back into the original clip
 * boundaries using a mergemap, snapping each join to its silence trough and
 * reporting Adobe's timing drift.
 */
async function runSplit(args) {
  if (!args.input) throw new Error('split: --input <enhanced.wav> is required');
  if (!args.map) throw new Error('split: --map <x.mergemap.json> is required');
  if (!args.out) throw new Error('split: --out <dir> is required');

  const inputPath = path.resolve(args.input);
  const mapPath = path.resolve(args.map);
  const outDir = path.resolve(args.out);
  if (!fs.existsSync(inputPath)) throw new Error(`input not found: ${inputPath}`);
  if (!fs.existsSync(mapPath)) throw new Error(`mergemap not found: ${mapPath}`);
  fs.mkdirSync(outDir, { recursive: true });

  const snapWindow = args['snap-window'] === undefined ? 0.5 : Number(args['snap-window']);
  const tolerance = args.tolerance === undefined ? 1.0 : Number(args.tolerance);
  if (Number.isNaN(snapWindow) || snapWindow <= 0) throw new Error('--snap-window must be a number > 0');
  if (Number.isNaN(tolerance) || tolerance < 0) throw new Error('--tolerance must be a number >= 0');

  const { python, worker } = resolveMergemapWorker(args);
  const cmd = [worker, 'split', '--input', inputPath, '--map', mapPath, '--out', outDir,
    '--snap-window', String(snapWindow), '--tolerance', String(tolerance)];

  console.log(`ClipForge split — worker: ${worker}`);
  console.log(`  python:  ${python}`);
  console.log(`  input:   ${inputPath}`);
  console.log(`  map:     ${mapPath}`);
  console.log(`  out:     ${outDir}`);
  console.log(`  snap-window: ${snapWindow} s   tolerance: ${tolerance} s`);
  console.log('');

  const t0 = Date.now();
  const result = await spawnWorker(python, cmd);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const provenance = {
    verb: 'split',
    ranAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    python, worker,
    input: inputPath, map: mapPath, out: outDir,
    snapWindow, tolerance,
    result,
    splitmap: result.splitmapPath,
  };
  const provPath = path.join(outDir, 'split.provenance.json');
  fs.writeFileSync(provPath, JSON.stringify(provenance, null, 2));

  console.log('');
  console.log(`  segments: ${result.segments}  ${result.sampleRate} Hz / ${result.channels} ch`);
  console.log(`  drift: max |${result.driftMaxAbs.toFixed(4)}| s   mean |${result.driftMeanAbs.toFixed(4)}| s`);
  console.log(`  splitmap:   ${result.splitmapPath}`);
  console.log(`  provenance: ${provPath}`);
  console.log(`  done in ${elapsed}s`);
  process.exitCode = 0;
}

/**
 * sentences verb — accurate per-clip transcripts for Orpheus training.
 *
 * DOCTRINE (Owen, verbatim): "we should always be using sentence generation to
 * get exact text for orpheus training." The output text is the EPUB's exact
 * words wherever alignment is CONFIDENT; a clip that cannot be placed with
 * confidence is flagged `uncertain` and gets NO text row (never a best guess).
 *
 * Two modes (selected by whether --book-vtt is present):
 *   MAP    (--book-vtt <vtt> --spans <json>): clip position in the book timeline
 *          is known; text = the book-VTT cues contained in the clip's span.
 *   ANCHOR (no --book-vtt): CPU faster-whisper transcribes the clip as a LOCATOR
 *          only, then the ASR is fuzzy-anchored against the epub; output text is
 *          the epub's exact words for the matched span.
 *
 * The JS side validates args, resolves the worker python (anchor => the e2a
 * runtime env for faster_whisper; map => the clipforge-speakers env — both
 * overridable with --python, both FAIL LOUDLY if missing), spawns
 * cli/py/clip_sentences.py, relays its STAGE/RESULT lines, and writes a run
 * provenance JSON. Audio is never copied or modified — this verb produces text.
 */
async function runSentences(args) {
  if (!args.clips) throw new Error('sentences: --clips <dir-or-list.txt> is required');
  if (!args.epub) throw new Error('sentences: --epub <book.epub> is required');
  if (!args.out) throw new Error('sentences: --out <dir> is required');
  if (!args.speaker) throw new Error('sentences: --speaker <name> is required');

  const clipsPath = path.resolve(args.clips);
  if (!fs.existsSync(clipsPath)) throw new Error(`--clips not found: ${clipsPath}`);
  const epubPath = path.resolve(args.epub);
  if (!fs.existsSync(epubPath)) throw new Error(`--epub not found: ${epubPath}`);
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  // Mode is decided by --book-vtt presence (map) vs absence (anchor).
  const mapMode = args['book-vtt'] !== undefined;
  const mode = mapMode ? 'map' : 'anchor';

  // Default python per mode: anchor needs faster_whisper (e2a env); map does not
  // (clipforge-speakers env). --python overrides both. FAIL LOUDLY if missing.
  const defaultPython = mapMode ? DEFAULT_SPEAKERS_PYTHON : DEFAULT_E2A_PYTHON;
  const python = args.python ? path.resolve(args.python) : defaultPython;
  if (!fs.existsSync(python)) {
    if (mapMode) {
      throw new Error(
        `sentences python not found: ${python}\n` +
        '  map mode reuses the clipforge-speakers env (no whisper needed). Create it, or\n' +
        '  pass --python <python.exe> pointing at any env with a stdlib python 3.');
    }
    throw new Error(
      `sentences (anchor) python not found: ${python}\n` +
      '  anchor mode transcribes with faster-whisper, which lives in the e2a runtime env.\n' +
      '  Expected: %APPDATA%\\BookForge\\runtime\\e2a-env\\python.exe (install BookForge\'s\n' +
      '  e2a runtime), or pass --python <python.exe> pointing at an env with faster_whisper.');
  }

  const worker = path.resolve(__dirname, 'py', 'clip_sentences.py');
  if (!fs.existsSync(worker)) throw new Error(`sentences worker missing: ${worker}`);

  const cmd = [worker, '--mode', mode, '--clips', clipsPath, '--epub', epubPath,
    '--out', outDir, '--speaker', String(args.speaker)];

  if (mapMode) {
    const bookVtt = path.resolve(args['book-vtt']);
    if (!fs.existsSync(bookVtt)) throw new Error(`--book-vtt not found: ${bookVtt}`);
    if (!args.spans) throw new Error('sentences map mode requires --spans <json>');
    const spans = path.resolve(args.spans);
    if (!fs.existsSync(spans)) throw new Error(`--spans not found: ${spans}`);
    cmd.push('--book-vtt', bookVtt, '--spans', spans);
    if (args['edge-tol'] !== undefined) {
      const et = Number(args['edge-tol']);
      if (Number.isNaN(et) || et < 0) throw new Error('--edge-tol must be a number >= 0');
      cmd.push('--edge-tol', String(et));
    }
  } else {
    if (args.spans !== undefined || args['edge-tol'] !== undefined) {
      throw new Error('sentences: --spans/--edge-tol only apply to map mode (which needs --book-vtt)');
    }
    if (args['fidelity-threshold'] !== undefined) {
      const v = Number(args['fidelity-threshold']);
      if (Number.isNaN(v) || v < 0 || v > 1) throw new Error('--fidelity-threshold must be a number in [0,1]');
    }
    if (args.model) cmd.push('--model', String(args.model));
    const device = args.device || 'cpu';
    cmd.push('--device', device);
    for (const flag of ['similarity-threshold', 'fidelity-threshold']) {
      if (args[flag] !== undefined) {
        const v = Number(args[flag]);
        if (Number.isNaN(v)) throw new Error(`--${flag} must be a number`);
        cmd.push(`--${flag}`, String(v));
      }
    }
  }

  console.log(`ClipForge sentences — worker: ${worker}`);
  console.log(`  python:  ${python}`);
  console.log(`  mode:    ${mode}`);
  console.log(`  clips:   ${clipsPath}`);
  console.log(`  epub:    ${epubPath}`);
  console.log(`  speaker: ${args.speaker}`);
  console.log(`  out:     ${outDir}`);
  console.log('');

  const t0 = Date.now();
  const result = await spawnWorker(python, cmd);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const provenance = {
    verb: 'sentences',
    ranAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    python, worker, mode,
    clips: clipsPath,
    epub: epubPath,
    speaker: String(args.speaker),
    out: outDir,
    selection: mapMode
      ? { bookVtt: path.resolve(args['book-vtt']), spans: path.resolve(args.spans),
          edgeTol: args['edge-tol'] === undefined ? undefined : Number(args['edge-tol']) }
      : { model: args.model || 'medium', device: args.device || 'cpu',
          similarityThreshold: args['similarity-threshold'] === undefined ? undefined : Number(args['similarity-threshold']),
          fidelityThreshold: args['fidelity-threshold'] === undefined ? undefined : Number(args['fidelity-threshold']) },
    result,
    metadata: result.metadataPath,
    report: result.reportPath,
  };
  const provPath = path.join(outDir, 'sentences.provenance.json');
  fs.writeFileSync(provPath, JSON.stringify(provenance, null, 2));

  console.log('');
  console.log(`  ok: ${result.okCount}  uncertain: ${result.uncertainCount}  of ${result.total} clips  (match rate ${(result.matchRate * 100).toFixed(1)}%)`);
  if (result.benchmark) {
    const b = result.benchmark;
    console.log(`  whisper ${b.model}/${b.compute_type} on ${b.device}: load ${b.model_load_seconds}s, ` +
      `warm mean ${b.transcribe_warm_mean_seconds}s/clip, cold first ${b.cold_first_clip_incl_load_seconds}s`);
  }
  console.log(`  metadata:   ${result.metadataPath}`);
  console.log(`  report:     ${result.reportPath}`);
  console.log(`  provenance: ${provPath}`);
  console.log(`  done in ${elapsed}s`);
  process.exitCode = 0;
}

/**
 * runNarration — split a cut corpus into NARRATION vs CHARACTER-VOICE clips.
 *
 * WHY (Owen, 2026-07-24): narrators drop into character voices unpredictably, and
 * a voice model trained on the mix reproduces them at random — "it sounds worse
 * than just using normal narration voice over dialogue". A narration-only corpus
 * fixes it (proven by ds_nr1, the shipped deathstalker).
 *
 * TEXT IS THE SELECTOR, EMBEDDINGS ARE THE VERIFIER (the ds_nr1 doctrine). A clip
 * whose text carries a double-quote is dialogue by the BOOK'S OWN punctuation —
 * exact, free, and immune to the acoustic ambiguity that makes clustering guess.
 * `speakers` (WeSpeaker/pyannote) then CONFIRMS the narration bucket has no
 * acoustic outliers; it is not used to choose.
 *
 * Residual, measured on Marked Man: unquoted direct speech ("...had said X") is
 * invisible to quote flagging — 4.8% of clips, harmless there. Report it, don't
 * silently pretend the split is perfect.
 *
 *   node cli/clipforge-process.js narration --corpus <dir> [--out <dir>] [--min-chars 40]
 *
 * --corpus  a cut corpus (wavs/ + metadata_train.csv + metadata_eval.csv)
 * --out     write narration/ and dialogue/ metadata CSVs here (default: alongside)
 * NO FALLBACKS: a missing corpus or unreadable metadata exits non-zero.
 */
async function runNarration(args) {
  const corpus = args.corpus;
  if (!corpus) throw new Error('narration: --corpus <dir> is required');
  if (!fs.existsSync(corpus)) throw new Error(`narration: corpus not found: ${corpus}`);
  const outDir = args.out || corpus;
  const minChars = Number(args['min-chars'] || 40);
  if (!Number.isFinite(minChars) || minChars < 0) {
    throw new Error(`narration: --min-chars must be a non-negative number (got ${args['min-chars']})`);
  }

  const rows = [];
  for (const split of ['train', 'eval']) {
    const p = path.join(corpus, `metadata_${split}.csv`);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 3) rows.push({ wav: parts[0], text: parts[1], speaker: parts[2], split });
    }
  }
  if (rows.length === 0) throw new Error(`narration: no metadata rows under ${corpus}`);

  // Double-quote characters only. Apostrophes are ubiquitous in prose and would
  // flag nearly every clip; a curly right-single-quote is also a common apostrophe.
  const QUOTES = ['"', '“', '”', '«', '»', '‹', '›'];
  const hasQuote = (t) => QUOTES.some((q) => t.includes(q));
  // Unquoted direct speech: a said/asked/replied verb adjacent to a comma-ish
  // boundary. Reported as a WARNING bucket, never auto-dropped — it is a known
  // 4.8% residual and over-filtering costs more narration than it saves.
  const SPEECH_VERB = /\b(said|asked|replied|shouted|whispered|muttered|answered|called|added|continued)\b/i;

  const narration = [];
  const dialogue = [];
  const suspect = [];
  for (const r of rows) {
    if (hasQuote(r.text)) { dialogue.push(r); continue; }
    if (r.text.replace(/\s+/g, ' ').trim().length < minChars) { dialogue.push(r); continue; }
    narration.push(r);
    if (SPEECH_VERB.test(r.text)) suspect.push(r);
  }

  const write = (name, list) => {
    const out = path.join(outDir, `metadata_${name}.csv`);
    fs.writeFileSync(out, ['audio_file|text|speaker_name', ...list.map((r) => `${r.wav}|${r.text}|${r.speaker}`)].join('\n') + '\n', 'utf8');
    return out;
  };
  const nPath = write('narration', narration);
  const dPath = write('dialogue', dialogue);

  const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;
  console.log(`[narration] corpus ${corpus}`);
  console.log(`  clips total            : ${rows.length}`);
  console.log(`  NARRATION (no quotes)  : ${narration.length} (${pct(narration.length)})  -> ${nPath}`);
  console.log(`  dialogue / too short   : ${dialogue.length} (${pct(dialogue.length)})  -> ${dPath}`);
  console.log(`  narration clips that still contain a speech verb (unquoted direct`);
  console.log(`  speech — known ~4.8% residual, NOT removed): ${suspect.length}`);
  console.log(`  VERIFY acoustically:  node cli/clipforge-process.js speakers --input ${corpus}/wavs --out <dir>`);
}

/**
 * runVerify — is every clip in this corpus actually the narrator?
 *
 * Delegates to cli/py/speaker_verify.py in the e2a runtime env (which already has
 * pyannote.audio + soundfile + torch — no new install). Embeds with
 * pyannote/wespeaker-voxceleb-resnet34-LM, builds a centroid from a KNOWN-narrator
 * reference set, and flags clips that sit far from it.
 *
 * Complements `narration`, it does not overlap:
 *   narration  = TEXT (quote marks)  -> excludes CHARACTER voices. Exact.
 *   verify     = EMBEDDINGS          -> catches a FOREIGN voice. Threshold.
 * MEASURED on Alloy of Law (300 clips, centroid from narration): narration median
 * 0.9316 / min 0.5655; dialogue median 0.8644 / min 0.5901. Character voices pull
 * similarity down but the distributions OVERLAP — narration dips below dialogue's
 * floor — so no threshold separates them. Never use this to pick clips; use it to
 * find an intruder. A genuinely different announcer scores ~0.17 on this embedder
 * (the deathstalker_rv2h HarperAudio promo was 0.051), which is what the 0.40
 * default is calibrated for.
 *
 * NOTE the thresholds are WESPEAKER-SCALE. The `speakers` verb uses resemblyzer,
 * where a different speaker still scores ~0.79 — passing 0.40 there would flag
 * nothing. Do not carry numbers between the two.
 *
 *   node cli/clipforge-process.js verify --corpus <dir> \
 *        [--reference metadata_narration.csv] [--compare metadata_dialogue.csv] \
 *        [--flag-below 0.40] [--out report.json] [--limit N] [--python <exe>]
 */
async function runVerify(args) {
  if (!args.corpus) throw new Error('verify: --corpus <dir> is required');
  const corpus = path.resolve(args.corpus);
  if (!fs.existsSync(corpus)) throw new Error(`verify: corpus not found: ${corpus}`);

  const python = args.python ? path.resolve(args.python) : DEFAULT_E2A_PYTHON;
  if (!fs.existsSync(python)) {
    throw new Error(
      `verify python not found: ${python}\n` +
      '  Needs pyannote.audio + soundfile + torch; the BookForge e2a runtime env has them.\n' +
      '  Override with --python <exe>.');
  }
  const script = path.resolve(__dirname, 'py', 'speaker_verify.py');
  if (!fs.existsSync(script)) throw new Error(`verify worker missing: ${script}`);

  const argv = [script, '--corpus', corpus];
  for (const [flag, key] of [['--reference', 'reference'], ['--compare', 'compare'],
                             ['--flag-below', 'flag-below'], ['--out', 'out'], ['--limit', 'limit']]) {
    if (args[key] !== undefined && args[key] !== true) argv.push(flag, String(args[key]));
  }
  console.log(`[verify] ${python} ${argv.slice(1).join(' ')}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(python, argv, {
      stdio: 'inherit',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`speaker_verify.py exited ${code}`);
}

// ===========================================================================
// TRAINING VERBS - ClipForge as the front door for the corpus pipeline.
//
// Owen, 2026-09-09: "at the end of the day, clipforge can act as a CLI wrapper
// for all the training tools we've built ... just make it the central hub for
// training tools."
//
// These verbs do NOT reimplement anything. Each spawns the proven script from
// the orpheus-finetune repo, where the behaviour was measured and where the
// field notes point. What is added is discoverability: one command surface,
// named arguments, and a --help carrying the WHY plus its field-note
// reference, so a green agent can read the pipeline instead of reconstructing
// it from seven scattered scripts.
//
// THE REPO IS NAMED, NEVER GUESSED - the same doctrine as qwenAlignEnv:
//   --training-root <dir> | CLIPFORGE_TRAINING_ROOT | the default below.
// An unresolvable root REFUSES BY NAME rather than silently doing nothing.
// ===========================================================================

// PLATFORM-AWARE DEFAULTS. This same file runs on BOTH sides, deliberately (Owen, 2026-09-09:
// "we could move clipforge code to wsl"). Nothing needs moving: the CLIP tools need the
// WINDOWS BookForge components (whisperx-env, ffmpeg via tool-paths) while the GPU stack lives
// in WSL (higgs3, qwen-align, sgl-omni), so the pipeline genuinely spans two OSes. Verified
// 2026-09-09: this file loads and runs under WSL node v18.
const IS_LINUX = process.platform === 'linux';
const TRAINING_ROOT_DEFAULT = IS_LINUX
  ? '/mnt/c/Users/tellt/Projects/orpheus-finetune'
  : 'C:/Users/tellt/Projects/orpheus-finetune';
const TRAINING_PYTHON_DEFAULT = IS_LINUX
  ? '/home/telltale/anaconda3/envs/whisperx/bin/python'
  : 'C:/Users/tellt/AppData/Roaming/BookForge/components/whisperx-env/python.exe';

function resolveTrainingRoot(args) {
  const root = args['training-root'] || process.env.CLIPFORGE_TRAINING_ROOT || TRAINING_ROOT_DEFAULT;
  const abs = path.resolve(root);
  if (!fs.existsSync(path.join(abs, 'pipeline', 'untreated'))) {
    throw new Error(
      'training root not found (no pipeline/untreated under it): ' + abs + '\n' +
      '  This is the orpheus-finetune repo, which holds the slicer and the row gate.\n' +
      '  Name it with --training-root <dir> or CLIPFORGE_TRAINING_ROOT.');
  }
  return abs;
}

function resolveTrainingPython(args, what) {
  const py = args.python ? path.resolve(args.python) : TRAINING_PYTHON_DEFAULT;
  if (!fs.existsSync(py)) {
    throw new Error(
      what + ' python not found: ' + py + '\n' +
      '  The row gate needs faster-whisper (BookForge whisperx-env has it). The slicer needs\n' +
      '  soundfile + numpy + scipy, which whisperx-env does NOT have - pass a python that does.\n' +
      '  Override with --python <exe>.');
  }
  return py;
}

async function spawnTraining(python, script, argv, cwd, label) {
  console.log('[' + label + '] ' + python + ' ' + path.basename(script) + ' ' + argv.join(' '));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...argv], {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '2',
        MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '2',
      },
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(path.basename(script) + ' exited ' + code);
}

const TRAINING_HELP = {};

TRAINING_HELP.slice = [
  'clipforge slice - cut a book master into training clips (slice_vtt.py)',
  '',
  '  --raw <master>   book audio. 48 kHz input is fine; CLIPS ARE ALWAYS WRITTEN AT 24 kHz.',
  '                   build_higgs_mix asserts sr==24000, and a 44.1/48 k clip set once failed',
  '                   to encode AFTER 40 GPU-minutes of gating (field notes 4n.34.4).',
  '  --vtt <vtt>      the aligned cue file whose text is authoritative',
  '  --build <dir>    build root. EVERY source pool must live under the SAME root, or the mix',
  '                   builder reads clip N from the wrong pool and the model speaks fluent',
  '                   gibberish (4n.11).',
  '  --rows <dir>     where per-tier rows json is written',
  '  --prefix <bk>    book prefix          --speaker <voice>',
  '',
  '  BAND (4n.39.5). Dimension the corpus from the length you will SERVE, not from a cap.',
  '  Runs carry ~12.8 chars per second of clip with full tails. For a 600-1000 band:',
  '      --run-median-s 59 --run-sigma 0.35 --long-min-s 22 --long-max-s 125',
  '  Then HISTOGRAM the result and adjust - a book slices in ~11 s. Deriving the numbers once',
  '  and committing is how a corpus ends up centred at p50 542, truncating where it is used.',
  '',
  '  TAILS  --tail-s 4.0  keeps the speaker own sentence-final pause, to 40 ms before the next',
  '                       onset. A CAP, not a pad. The old 0.25 truncated every pause and is',
  '                       retired: full tails raised rendered pause 0.22 -> 1.58 s at no cost',
  '                       in early stops or coverage (4n.37.17).',
  '  MICRO  --tiers lsm --micro-min-s 0.4 --micro-max-s 8.0 --micro-max-rows 20',
  '         --micro-weights 1,1,1.5,3,3.5',
  '                       one-word entries, titles, subheadings. The SHORT tier cannot supply',
  '                       these: it floors at 8 s and requires 4+ words. Keep micro near 5% of',
  '                       rows - at 22% it drags the median, and the median sets the floor.',
].join('\n');

TRAINING_HELP.gate = [
  'clipforge gate - score every training row against its own text (row_gate.py)',
  '',
  '  --tier <dir>     a MERGED tier directory (metadata_train.csv + wavs)',
  '  --min 0.80       row coverage floor     --sent-min 0.50  per-sentence floor',
  '  --workers 4      faster-whisper takes EVERY core per worker unless OMP_NUM_THREADS is set;',
  '                   this verb exports 2. Do not run six workers beside a serving stack.',
  '',
  '  THIS IS THE REAL ALIGNMENT TEST (4n.40.4b). A mis-aligned clip fails coverage by',
  '  construction, so read the DROP RATE against these measured baselines:',
  '      prose long ~0.9%     prose short ~0.6%     micro ~14%',
  '  Micro is high by nature - one wrong ASR word on a one-word row is 100% of it. A PROSE tier',
  '  dropping much above ~2% is an ALIGNMENT problem, not a gate problem. Do not raise the',
  '  threshold to make it pass; re-align that book instead.',
  '  Proper nouns are free: the gate scores ordinary words only (4n.34.8).',
].join('\n');

TRAINING_HELP['merge-tiers'] = [
  'clipforge merge-tiers - merge per-book tiers into one corpus (merge_corpora.py)',
  '',
  '  --build <dir>    build root (must hold every <bk>_<tier> and its _raw_src_ pool)',
  '  --rows <dir>     rows json directory',
  '  --out <name>     merged tier name, e.g. mb6_l',
  '  --books fe,woa,hoa   book prefixes      --tier l|s|m',
  '',
  '  Distinct from the clip-level "merge" verb, which assembles clips for an Adobe round-trip.',
  '  This is the corpus-level merge, and it keeps each row OWN pool: a per-side constant once',
  '  paired clip N with a different passage and the model spoke fluent gibberish (4n.11).',
].join('\n');

async function runSlice(args) {
  if (args.help) { console.log(TRAINING_HELP.slice); return; }
  for (const k of ['raw', 'vtt', 'build', 'rows', 'prefix', 'speaker']) {
    if (!args[k]) throw new Error('slice: --' + k + ' is required (see: clipforge slice --help)');
  }
  const root = resolveTrainingRoot(args);
  const cwd = path.join(root, 'pipeline', 'untreated');
  const python = resolveTrainingPython(args, 'slice');
  const pass = ['raw', 'vtt', 'build', 'rows', 'prefix', 'speaker', 'min-start', 'max-end',
    'run-median-s', 'run-sigma', 'long-min-s', 'long-max-s', 'gap-s', 'tail-s', 'tiers',
    'micro-min-s', 'micro-max-s', 'micro-min-words', 'micro-max-words', 'micro-max-rows',
    'micro-weights', 'max-hours', 'exclude-cue-ids'];
  const argv = [];
  for (const k of pass) if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
  if (args['interp-interior']) argv.push('--interp-interior');
  if (args['tail-s'] === undefined) {
    console.log('[slice] NOTE: no --tail-s given, so slice_vtt uses its 0.25 default - the RETIRED cut.');
    console.log('[slice]       Pass --tail-s 4.0 to keep the speaker own pause (field notes 4n.37.17).');
  }
  await spawnTraining(python, path.join(cwd, 'slice_vtt.py'), argv, cwd, 'slice');
}

async function runGate(args) {
  if (args.help) { console.log(TRAINING_HELP.gate); return; }
  if (!args.tier) throw new Error('gate: --tier <merged tier dir> is required (see: clipforge gate --help)');
  const tier = path.resolve(args.tier);
  if (!fs.existsSync(path.join(tier, 'metadata_train.csv'))) {
    throw new Error('gate: not a corpus tier (no metadata_train.csv): ' + tier);
  }
  const root = resolveTrainingRoot(args);
  const cwd = path.join(root, 'pipeline', 'untreated');
  const python = resolveTrainingPython(args, 'gate');
  const argv = [tier,
    '--min', String(args.min || 0.8),
    '--sent-min', String(args['sent-min'] || 0.5),
    '--device', String(args.device || 'cpu'),
    '--workers', String(args.workers || 4)];
  await spawnTraining(python, path.join(cwd, 'row_gate.py'), argv, cwd, 'gate');
  const gateJson = path.join(tier, 'row_gate.json');
  if (!fs.existsSync(gateJson)) {
    throw new Error('gate: ' + path.basename(tier) + ' produced no row_gate.json - it did NOT pass');
  }
  console.log('[gate] ' + path.basename(tier) + ' -> ' + gateJson);
  console.log('[gate] Drop rate: prose ~0.9-2% healthy, micro ~14% normal. A prose tier far above');
  console.log('[gate] 2% is an ALIGNMENT problem, not a gate problem (field notes 4n.40.4b).');
}

async function runMergeTiers(args) {
  if (args.help) { console.log(TRAINING_HELP['merge-tiers']); return; }
  for (const k of ['build', 'rows', 'out', 'books', 'tier']) {
    if (!args[k]) throw new Error('merge-tiers: --' + k + ' is required (see: clipforge merge-tiers --help)');
  }
  const root = resolveTrainingRoot(args);
  const cwd = path.join(root, 'pipeline', 'untreated');
  const python = resolveTrainingPython(args, 'merge-tiers');
  const build = path.resolve(args.build);
  const rowsDir = path.resolve(args.rows);
  const tier = String(args.tier);
  const books = String(args.books).split(',').map((b) => b.trim()).filter(Boolean);
  const pairs = books.map((b) => path.join(build, b + '_' + tier) + ':' + path.join(rowsDir, b + '_' + tier + '_rows.json'));
  const argv = [path.join(build, String(args.out)), path.join(rowsDir, String(args.out) + '_rows.json'), ...pairs];
  await spawnTraining(python, path.join(cwd, 'merge_corpora.py'), argv, cwd, 'merge-tiers');
}


// --- Campaign scripts (mix, train) live outside the repo, under E:\training\_campaigns.
// Named, never guessed: --campaign-root | CLIPFORGE_CAMPAIGN_ROOT | the default.
const CAMPAIGN_ROOT_DEFAULT = IS_LINUX
  ? '/mnt/e/training/_campaigns/2026-09-01-cod-full-rebuild/higgs'
  : 'E:/training/_campaigns/2026-09-01-cod-full-rebuild/higgs';
const GPU_PYTHON_DEFAULT = '/home/telltale/anaconda3/envs/higgs3/bin/python';

function resolveCampaignRoot(args) {
  const root = args['campaign-root'] || process.env.CLIPFORGE_CAMPAIGN_ROOT || CAMPAIGN_ROOT_DEFAULT;
  const abs = path.resolve(root);
  if (!fs.existsSync(path.join(abs, 'night2', 'build_higgs_mix.py'))) {
    throw new Error(
      'campaign root not found (no night2/build_higgs_mix.py under it): ' + abs + '\n' +
      '  Name it with --campaign-root <dir> or CLIPFORGE_CAMPAIGN_ROOT.');
  }
  return abs;
}

/**
 * The GPU verbs run INSIDE WSL. Called from Windows node, path.resolve() rewrites a POSIX
 * path into a Git-Bash path and the spawn ENOENTs - measured 2026-09-09 on mix. Refuse BY
 * NAME with the command to run, rather than hand the guest a path it cannot open (the same
 * choice BookForge made for the qwen aligner door).
 */
function requireGuestSide(verb) {
  if (IS_LINUX) return;
  console.log([
    verb + ': this is a WSL GPU job and must run inside the guest.',
    '  From Windows, path.resolve() rewrites /mnt/e/... into a Git-Bash path and the spawn fails.',
    '  Run it there instead:',
    '    wsl -e node /mnt/c/Users/tellt/Projects/bookforge/cli/clipforge-process.js ' + verb + ' ...',
    '  (slice, gate and merge-tiers are Windows-side and work from here.)',
  ].join('\n'));
  throw new Error(verb + ': refusing to run a guest-side job from Windows');
}

function refuseNonHiggs(args, verb) {
  const engine = String(args.engine || 'higgs').toLowerCase();
  if (engine !== 'higgs') {
    throw new Error(
      verb + ': --engine ' + engine + ' is not wired here yet. Only higgs is.\n' +
      '  Orpheus has its own trainer and mix; running the Higgs one against an Orpheus corpus\n' +
      '  would silently produce a corpus for the wrong model. Refusing rather than guessing.');
  }
}

TRAINING_HELP.mix = [
  'clipforge mix - encode a gated corpus into a training set (night2/build_higgs_mix.py)',
  '',
  '  --out <dir>      the data directory to write   --build-root <dir>  where the tiers live',
  '  --long <tier> --short <tier> [--heading <tier>]',
  '  --rows-l / --rows-s / --rows-h <json>',
  '  --served-cap-chars <n> [--served-cap-strict]',
  '',
  '  NO BED. --nobed is passed always. The -70 dB bed is an Orpheus/SNAC EOS fix that does NOT',
  '  transfer to v3: coverage 90.9 vs 90.7, early stops 14 vs 13, runaways 0 vs 0 (field notes 4f).',
  '',
  '  TWO FLAGS SUPPRESS SHORT ROWS, NOT ONE. --short-rows-frac 0.0 leaves --short-frac at its',
  '  0.25-of-DURATION default, which is ~59% of ROWS. A "band only" corpus built with just the',
  '  first flag had 38.5% of rows in band against the base model own 34.3% - the experiment would',
  '  have compared a model to itself (4n.37.16). Pass BOTH zeros for a deliberate long-only build.',
  '',
  '  --served-cap-strict REFUSES a cap above the train rows p75. If it fires, the CORPUS is wrong',
  '  for the cap, not the flag: by 4n.37.19 a model is safe to about its corpus median, so serving',
  '  above p75 means truncating exactly where you render. Re-slice; do not drop the flag.',
].join('\n');

async function runMix(args) {
  if (args.help) { console.log(TRAINING_HELP.mix); return; }
  requireGuestSide('mix');
  refuseNonHiggs(args, 'mix');
  for (const k of ['out', 'build-root', 'long', 'short']) {
    if (!args[k]) throw new Error('mix: --' + k + ' is required (see: clipforge mix --help)');
  }
  const camp = resolveCampaignRoot(args);
  const python = args.python ? path.resolve(args.python) : GPU_PYTHON_DEFAULT;
  const pass = ['out', 'build-root', 'long', 'short', 'heading', 'rows-l', 'rows-s', 'rows-h',
    'short-rows-frac', 'short-frac', 'short-prefer-min', 'short-max', 'served-cap-chars',
    'max-hours', 'workers', 'device', 'mode-name', 'seed'];
  const argv = ['--nobed'];
  for (const k of pass) if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
  if (args['served-cap-strict']) argv.push('--served-cap-strict');
  if (args['short-rows-frac'] !== undefined && args['short-frac'] === undefined) {
    console.log('[mix] NOTE: --short-rows-frac given without --short-frac. --short-frac still');
    console.log('[mix]       defaults to 0.25 of DURATION, which is ~59% of ROWS (4n.37.16).');
  }
  await spawnTraining(python, path.join(camp, 'night2', 'build_higgs_mix.py'), argv, camp, 'mix');
}

TRAINING_HELP.train = [
  'clipforge train - LoRA fine-tune on an encoded corpus (v3_ft/train_lora.py)',
  '',
  '  --data <dir>     the mix output      --out <run dir>',
  '  --epochs 12 --patience 3 --lora-r 32 --lora-alpha 64 --lora-dropout 0.05',
  '  --lr 1e-4 --accum 4 --warmup 20 --max-seq-len 4096 --eval-every Q --save-every Q --seed 1234',
  '  Q is about rows/16. Early stop after 3 non-improving evals (field notes 4n.32.5).',
  '',
  '  GPU DISCIPLINE. Take the lock first - v3_ft/gpu_lock.sh acquire - and check the card is',
  '  actually allocatable, not merely reported free: probe_vram.py. Under WSL mem_get_info LIES;',
  '  one over-subscription episode shrank the VM budget 23 -> 13 GiB and every later train died',
  '  constructing the model while nvidia-smi still read 22.74 GiB free (4n.37.15).',
  '  Baseline is mem-fraction 0.48 / render concurrency 4, about 20 GB. Never SIGKILL a WSL GPU',
  '  process. Run campaign stages ONE AT A TIME.',
  '',
  '  PICK THE CHECKPOINT BY BEHAVIOUR, NOT LOSS. A 0.04-nat holdout gap does not resolve a',
  '  behavioural difference, and loss kept improving while worst-case coverage fell 98.1 -> 96.4%',
  '  (4n.4d, 4n.32.6). Sweep two checkpoints across 0-1600 and take the band (4n.39.1).',
].join('\n');

async function runTrain(args) {
  if (args.help) { console.log(TRAINING_HELP.train); return; }
  requireGuestSide('train');
  refuseNonHiggs(args, 'train');
  for (const k of ['data', 'out']) {
    if (!args[k]) throw new Error('train: --' + k + ' is required (see: clipforge train --help)');
  }
  const camp = resolveCampaignRoot(args);
  const ft = path.join(camp, 'v3_ft');
  const python = args.python ? path.resolve(args.python) : GPU_PYTHON_DEFAULT;
  const pass = ['data', 'out', 'init-adapter', 'steps', 'epochs', 'patience', 'lora-r',
    'lora-alpha', 'lora-dropout', 'lr', 'accum', 'warmup', 'max-seq-len', 'eval-every',
    'save-every', 'log-every', 'seed'];
  const argv = [];
  for (const k of pass) if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
  console.log('[train] GPU job. Take v3_ft/gpu_lock.sh and probe_vram.py FIRST - see --help.');
  await spawnTraining(python, path.join(ft, 'train_lora.py'), argv, ft, 'train');
}

TRAINING_HELP.masters = [
  'clipforge masters - rebuild per-book masters from Adobe returns (Adobe SPAN pipeline)',
  '',
  '  --adobe-dir <dir>   holds build_span_inventory.py and build_masters.py (e.g. mistborn/adobe_v2)',
  '  --step inventory|masters|both        (default both)',
  '',
  '  SPAN-LEVEL, not clip-level. Each Adobe part is a concatenation of non-contiguous narration',
  '  spans; the split map carries part_start_sample/part_end_sample plus the run_ci0/run_ci1 cue',
  '  range, so spans are cut back sample-exact and concatenated IN SOURCE ORDER.',
  '',
  '  TWO TRAPS. The returned-parts list has been HARDCODED before and silently excluded 2.8 h of',
  '  a book once Adobe returned more (fixed 2026-09-09 to derive from disk). And build_masters',
  '  caches segments by LIST POSITION (seg0000...), so re-running with a CHANGED span list would',
  '  reuse a cached segment for a different passage - clear _seg_<bk> before any rebuild.',
].join('\n');

async function runMasters(args) {
  if (args.help) { console.log(TRAINING_HELP.masters); return; }
  if (!args['adobe-dir']) throw new Error('masters: --adobe-dir is required (see: clipforge masters --help)');
  const dir = path.resolve(args['adobe-dir']);
  const step = String(args.step || 'both');
  const python = args.python ? path.resolve(args.python) : TRAINING_PYTHON_DEFAULT;
  const scripts = [];
  if (step === 'inventory' || step === 'both') scripts.push('build_span_inventory.py');
  if (step === 'masters' || step === 'both') scripts.push('build_masters.py');
  if (!scripts.length) throw new Error('masters: --step must be inventory, masters or both');
  for (const sc of scripts) {
    const full = path.join(dir, sc);
    if (!fs.existsSync(full)) throw new Error('masters: missing ' + full);
    if (sc === 'build_masters.py') {
      for (const d of fs.readdirSync(dir)) {
        if (d.startsWith('_seg_')) {
          console.log('[masters] STALE SEGMENT CACHE present: ' + d);
          console.log('[masters] It is keyed by list POSITION. If the span list changed, cached');
          console.log('[masters] segments pair audio with the WRONG text. Delete it, then re-run.');
          throw new Error('masters: refusing with ' + d + ' present - clear it deliberately');
        }
      }
    }
    await spawnTraining(python, full, [], dir, 'masters');
  }
}

TRAINING_HELP.align = [
  'clipforge align - align each Adobe span against its own text (adobe_v2/align_spans.py)',
  '',
  '  --adobe-dir <dir>   holds align_spans.py and the rebuilt masters',
  '  --book <fe|woa|hoa|...>   [--limit N] [--window-s 280]',
  '  --python <exe>      the qwen-align env (default /home/telltale/anaconda3/envs/qwen-align/bin/python)',
  '',
  '  PER SPAN, NOT PER BOOK. A concatenated master is non-contiguous, and the whole-book aligner',
  '  loses the thread at the seams: on fe_ad it dropped 2.71 h of 5.99 h into asr-fallback while',
  '  advancing one sentence per 22 minutes. Here each window is audio PLUS EXACTLY THE WORDS IN IT,',
  '  so nothing is searched for and there is no asr-fallback class by construction.',
  '',
  '  IT REFUSES RATHER THAN INVENTING. Above ~20% failed windows it writes NOTHING. On 2026-09-09',
  '  it refused woa at 78/362 - all one cause, cues whose text was a bare "." from spaced ellipses',
  '  and detached punctuation in the source VTT (10.3% of woa cues). Fixing the TEXT took it to',
  '  1/362. If it refuses, find the text defect; do not loosen the gate.',
  '',
  '  QWEN3 DRIFTS ON SHORT AND HEADING WINDOWS (4n.40): 395x realtime and more precise where it',
  '  places, but it publishes no confidence and never refuses, and 59 of its 116 misses over 1 s',
  '  were headings or tiny chunks. Spot-check with the row gate, listen to the SHORTEST clips, and',
  '  if a prose tier drops far above 2% re-align that book with wav2vec2 instead.',
].join('\n');

const QWEN_PYTHON_DEFAULT = '/home/telltale/anaconda3/envs/qwen-align/bin/python';

async function runAlign(args) {
  if (args.help) { console.log(TRAINING_HELP.align); return; }
  requireGuestSide('align');
  for (const k of ['adobe-dir', 'book']) {
    if (!args[k]) throw new Error('align: --' + k + ' is required (see: clipforge align --help)');
  }
  const dir = path.resolve(args['adobe-dir']);
  const script = path.join(dir, 'align_spans.py');
  if (!fs.existsSync(script)) throw new Error('align: missing ' + script);
  const python = args.python ? path.resolve(args.python) : QWEN_PYTHON_DEFAULT;
  const argv = [String(args.book)];
  for (const k of ['limit', 'window-s']) {
    if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
  }
  if (args.dry) argv.push('--dry');
  console.log('[align] GPU job. Take the lock first, and read the refusal rule in --help.');
  await spawnTraining(python, script, argv, dir, 'align');
}

function printUsage() {
  console.log([
    'clipforge-process - the ClipForge CLI',
    '',
    'CLIP TOOLS (audio in, audio or text out)',
    '  chain        run a recipe over one wav through the shared chain engine (default verb)',
    '  speakers     bucket clips by voice actor',
    '  narration    split a sliced corpus into narration vs character voices by quote marks',
    '  verify       embedding sweep: is every clip really the narrator?',
    '  merge/split  Adobe Podcast round-trip for CLIPS (keyed on a .mergemap.json)',
    '  sentences    per-clip transcripts from the epub',
    '',
    'TRAINING TOOLS (corpus in, corpus out) - wrappers over the orpheus-finetune scripts',
    '  slice        cut a book master into training clips        (slice_vtt.py)',
    '  gate         score every row against its own text         (row_gate.py)',
    '  merge-tiers  merge per-book tiers into one corpus         (merge_corpora.py)',
    '  mix          encode a gated corpus into a training set   (build_higgs_mix.py)',
    '  train        LoRA fine-tune on an encoded corpus         (train_lora.py)',
    '  masters      rebuild per-book masters from Adobe returns (Adobe SPAN pipeline)',
    '  align        align each Adobe span against its own text  (align_spans.py)',
    '  ladder       length sweep N models back to back + band calc  (ladder_chain.sh)',
    '  deploy       promote a laddered winner into BookForge       (promote_voice.py)',
    '',
    '  Each takes --help and explains the WHY with its field-note reference.',
    '  Scripts live in the orpheus-finetune repo: --training-root <dir> or',
    '  CLIPFORGE_TRAINING_ROOT (default ' + TRAINING_ROOT_DEFAULT + ').',
    '  Campaign scripts (mix, train): --campaign-root or CLIPFORGE_CAMPAIGN_ROOT',
    '  (default ' + CAMPAIGN_ROOT_DEFAULT + ').',
    '',
    '  Pipeline order is the runbook in HIGGS_FIELD_NOTES 4n.41:',
    '    masters -> align -> slice -> merge-tiers -> gate -> mix -> train -> sweep -> promote',
  ].join('\n'));
}

TRAINING_HELP.ladder = [
  'clipforge ladder - length sweep over one or more merged models, back to back',
  '',
  '  Owen 2026-09-09: "the ladder should keep the gpu occupied until it finishes rendering.',
  '  we can do the calculations while the other is rendering." So each model renders on the',
  '  GPU, then its ASR SCORING is launched on the CPU in the background while the NEXT model',
  '  takes the GPU. The GPU idles only for a serve swap (~70 s).',
  '',
  '  RENDER + CALCULATE (the whole thing):',
  '    --models "<dirA> <dirB>"   merged model dirs, rendered in this order',
  '    --bank <bank.json>          length bank from make_bank.py (held-out text for THAT voice)',
  '    --out-root <dir>            one run dir per model is created under it',
  '    --seeds "500 501 502 503"  default 4 seeds. 4n.39 says use 4, not 2: at 2 seeds a',
  '                                3-rung band is n=48 and two checkpoints 3x apart in failures',
  '                                are still inside the noise (ladder-noise-floor, 2026-09-01).',
  '    --conc 4                    concurrency. Also caps KV: conc x (max-tokens + input) must',
  '                                fit the pool (23,173 tokens at mem-fraction 0.48).',
  '    --max-tokens 5000           reserved per request UP FRONT. Too high and every request is',
  '                                refused before scheduling; too low and you manufacture the',
  '                                truncations you are trying to measure (4n.44).',
  '    --ctx 8192                  HIGGS_CONTEXT_LENGTH. The default 4096 holds only ~2,000 chars,',
  '                                so a sweep reaching 2k truncates on the WALL, not the voice.',
  '',
  '  CALCULATIONS ONLY (the calculations flag - run it on runs that already exist):',
  '    --calc --runs "<runA> <runB>" [--score]',
  '    Two or more run dirs give the head-to-head comparison and the higgs-safe-bands.json line.',
  '    --score also re-runs ASR scoring first; omit it when the chain already scored.',
  '',
  '  Bands are ranked by the Wilson 95% UPPER bound so a narrow window cannot win on luck,',
  '  which is exactly why the seed count matters (band.py, 4n.39).',
].join('\n');

async function runLadder(args) {
  if (args.help) { console.log(TRAINING_HELP.ladder); return; }
  requireGuestSide('ladder');
  const camp = resolveCampaignRoot(args);
  const n4 = path.join(camp, 'night4');
  if (args.calc) {
    if (!args.runs) throw new Error('ladder --calc: --runs "<runA> <runB>" is required');
    const argv = [];
    if (args.score) argv.push('--score');
    for (const d of String(args.runs).split(/\s+/).filter(Boolean)) argv.push(d);
    await spawnTraining('bash', path.join(n4, 'ladder_calc.sh'), argv, camp, 'ladder-calc');
    return;
  }
  for (const k of ['models', 'bank', 'out-root']) {
    if (!args[k]) throw new Error('ladder: --' + k + ' is required (see: clipforge ladder --help)');
  }
  const argv = ['--bank', String(args.bank), '--out-root', String(args['out-root'])];
  for (const k of ['seeds', 'conc', 'max-tokens', 'ctx', 'tag-prefix']) {
    if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
  }
  for (const d of String(args.models).split(/\s+/).filter(Boolean)) argv.push(d);
  await spawnTraining('bash', path.join(n4, 'ladder_chain.sh'), argv, camp, 'ladder');
}

TRAINING_HELP.deploy = [
  'clipforge deploy - promote a laddered checkpoint into BookForge (promote_voice.py)',
  '',
  'WHAT \'DEPLOY\' MEANS FOR HIGGS, AND WHY IT IS NOT JUST A FILE COPY',
  '',
  '  A Higgs voice ships as FOUR things that must agree, or the app renders the wrong voice',
  '  at the wrong chunk size and nothing errors:',
  '',
  '    1. THE MERGED WEIGHTS. Training produces a LoRA adapter, but neither serving stack can',
  '       attach one at runtime - there is no --enable-lora and the v3 talker never declares',
  '       vLLM\'s SupportsLoRA. So the adapter is merged into the base weights first',
  '       (v3_ft/merge_for_serving.py, CPU-only, ~1 min). A checkpoint dir is NOT servable.',
  '',
  '    2. TWO ARMS, TWO COPIES OF THOSE WEIGHTS. `served` is the PC: SGLang-Omni inside WSL,',
  '       reading /home/telltale/higgs_v3_merged/<dir>. `mlx` is the Mac: the same merged',
  '       directory rsynced to ~/Library/Application Support/BookForge/runtime/higgs-models/<dir>.',
  '       No safetensors->MLX conversion - MLX loads the same files. Promote one arm only and the',
  '       machines quietly disagree about which checkpoint is live.',
  '',
  '    3. THE SAFE BAND - the two numbers that actually steer the packer. A fine-tune\'s failure',
  '       curve is U-SHAPED: it truncates on chunks that are too SHORT as well as too long',
  '       (field notes 4n.37.19-21). Owen\'s Mac truncated at 323, 502 and 634 chars while the',
  '       cap was 800, because floor==cap left short paragraphs unable to merge. So a band is a',
  '       FLOOR and a CAP, measured by the length ladder, never guessed from the corpus - a rule',
  '       derived from corpus p25 was wrong in production within a day.',
  '',
  '    4. THE CATALOG RECORD. electron/data/higgs-models.json is the source of truth for caps and',
  '       arm directories; higgs-safe-bands.json is the small overlay that holds the band. The app',
  '       reads the compiled copy under dist/, so an edit that is not copied and recompiled has no',
  '       effect at all - the most common way a \'deployed\' model behaves exactly as before.',
  '',
  '  WHICH CHECKPOINT WINS. The ladder renders two candidates across the spectrum and band.py',
  '  ranks contiguous windows by the Wilson 95% UPPER bound of their failure rate (upper bound, so',
  '  a narrow window cannot win on luck; ties break toward the WIDER band, because width is room',
  '  for the chunker). Owen: fewest truncations/runaways inside the band wins, and holdout loss is',
  '  the tie-break ONLY when the margin is inside noise - which it usually is, since the top two',
  '  checkpoints differ by ~0.01% loss.',
  '',
  '  WHAT IS DELIBERATELY *NOT* HERE: HuggingFace. It holds the backups of the current models, so',
  '  anything lost from the Mac or the PC can be re-pulled. Publishing needs Owen\'s explicit green',
  '  light and is not part of promotion.',
  '',
  'USAGE',
  '    --voice <id>        catalog id in electron/data/higgs-models.json (e.g. mistborn)',
  '    --verdict <json>    verdict.json written by the ladder (band.py --json)',
  '    --run-dir <dir>     the TRAIN run dir, for the holdout losses behind the tie-break',
  '    --prod-name <dir>   merged dir name to promote to (e.g. mb_v6_prod)',
  '    --band-key <key>    higgs-safe-bands.json key, if it differs from --voice',
  '    --apply             actually write. WITHOUT it this is a dry run that only names the winner.',
  '    --push              git commit + push the two catalog files (PC)',
  '    --mac               rsync to the Mac, sha-verify every weight file, refresh its checkout',
  '                        and dist, re-run the engine test there',
  '',
  'ORDER OF OPERATIONS (what --apply --push --mac does, in order)',
  '    ladder -> verdict.json -> winner -> merged dir renamed to <prod-name> -> sha256 recorded',
  '    -> higgs-safe-bands.json { min, max } -> higgs-models.json both arms + arm dirs',
  '    -> cp electron/data/*.json dist/electron/data/ -> npx tsc -p tsconfig.electron.json',
  '    -> node tools/test-higgs-engine.js -> git commit + push -> rsync Mac -> verify -> Mac test',
  '',
  '  NEVER `npm run build:electron` here: it starts with `rm -rf dist/electron` and will break a',
  '  render in flight. `npx tsc -p tsconfig.electron.json` produces the same overlay without it.',
  '',
  'GATES (it stops rather than half-deploying)',
  '    - test-higgs-engine.js must print ALL OK *and* exit 0. A syntax error prints neither FAIL',
  '      nor OK, so the exit code is checked too - passing on silence is how a broken catalog ships.',
  '    - a safe max above that arm\'s maxChars, or a min not below the max, is refused BY NAME at',
  '      load, so the cap is raised with the band rather than left to contradict it.',
  '    - after the rsync, every weight file\'s sha256 must match or the Mac is not switched over.',
].join('\n');

async function runDeploy(args) {
  if (args.help) { console.log(TRAINING_HELP.deploy); return; }
  requireGuestSide('deploy');
  const camp = resolveCampaignRoot(args);
  for (const k of ['voice', 'verdict', 'run-dir', 'prod-name']) {
    if (!args[k]) throw new Error('deploy: --' + k + ' is required (see: clipforge deploy --help)');
  }
  const argv = [];
  for (const k of ['voice', 'verdict', 'run-dir', 'prod-name', 'band-key']) {
    if (args[k] !== undefined && args[k] !== true) argv.push('--' + k, String(args[k]));
  }
  for (const k of ['apply', 'push', 'mac']) if (args[k]) argv.push('--' + k);
  if (!args.apply) console.log('[deploy] DRY RUN - no files written. Add --apply when the winner looks right.');
  const python = args.python ? path.resolve(args.python) : GPU_PYTHON_DEFAULT;
  await spawnTraining(python, path.join(camp, 'night4', 'promote_voice.py'), argv, camp, 'deploy');
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
  if (verb === 'merge') return runMerge(args);
  if (verb === 'split') return runSplit(args);
  if (verb === 'sentences') return runSentences(args);
  if (verb === 'narration') return runNarration(args);
  if (verb === 'verify') return runVerify(args);
  if (verb === 'chain') return runChainVerb(args);
  if (verb === 'slice') return runSlice(args);
  if (verb === 'gate') return runGate(args);
  if (verb === 'merge-tiers') return runMergeTiers(args);
  if (verb === 'mix') return runMix(args);
  if (verb === 'train') return runTrain(args);
  if (verb === 'masters') return runMasters(args);
  if (verb === 'align') return runAlign(args);
  if (verb === 'ladder') return runLadder(args);
  if (verb === 'deploy') return runDeploy(args);
  if (verb === 'help') return printUsage();
  printUsage();
  throw new Error(`unknown verb: ${verb}`);
}

main().catch((e) => {
  console.error('\n[clipforge-process] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});

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
 * Further verbs: `merge`/`split` (Adobe round-trip, see runMerge/runSplit) and
 * `sentences` (accurate per-clip transcripts from the epub, see runSentences):
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
  process.exit(0);
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
  process.exit(0);
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
  if (verb === 'merge') return runMerge(args);
  if (verb === 'split') return runSplit(args);
  if (verb === 'sentences') return runSentences(args);
  if (verb === 'chain') return runChainVerb(args);
  throw new Error(`unknown verb: ${verb} (expected 'speakers', 'merge', 'split', 'sentences', or a bare chain invocation)`);
}

main().catch((e) => {
  console.error('\n[clipforge-process] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});

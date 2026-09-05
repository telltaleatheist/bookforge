#!/usr/bin/env node
/**
 * THE TWO HIGGS DOCTORS, one per arm, and the dispatcher that chooses.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-higgs-doctor-arms.js
 *
 * ── The defect this keeper is the fence around ──────────────────────────────
 *
 * Higgs v3 is one engine with two backends: a vLLM-Omni SERVER reached through
 * WSL on Windows, and an IN-PROCESS mlx-audio backend on macOS (PORT_NOTES 13).
 * There was one doctor, the WSL one, and it answered for both. On the Mac,
 * 2026-09-05, that produced:
 *
 *     "The Higgs environment is not ready … : WSL distribution.
 *      Set it up in Settings → Higgs, or pick Orpheus on the Reading tab."
 *
 * — on a Mac that renders Higgs perfectly well. And `higgsEnvironmentRefusal()`
 * carried the mirror-image bug: `return null` on darwin, having checked NOTHING,
 * so a genuinely broken Mac was waved through to fail an hour later inside a
 * worker.
 *
 * Both failures are SILENT in the only sense that matters — nothing throws at the
 * point of the mistake — and both are pure functions of the platform, so both are
 * testable here with no GPU, no WSL, no conda and no Electron main loop.
 *
 * ── Host-independent by construction ────────────────────────────────────────
 *
 * The answer differs per platform; that is the whole point of the code. So the
 * keeper DRIVES each platform as a fixture (`process.platform` forced and
 * restored, exactly as tools/serve-spawn-extract.js and
 * test-stream-engine-availability.js do) and stubs the probe spawn, rather than
 * reporting whatever this machine happens to be. It gives the same answer on
 * Owen's PC and on the Mac.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'higgs-doctor.js'))) {
  // exitCode + return, NOT process.exit(): this report goes to a pipe under
  // tools/run-keepers.js, and a hard exit truncates whatever is still buffered.
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

// ── The fixture machine ──────────────────────────────────────────────────────
//
// A REAL directory, because the darwin doctor reports whether the weights
// BookForge names are actually there — "is it real" is only a question worth
// asking against a userData that has been set up.
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'higgs-doctor-'));
const BASE_DIR = path.join(FIXTURE, 'runtime', 'higgs-models', 'base');

const FAKE = {
  conda: '/fake/miniconda/bin/conda',
  mlxEnv: '/opt/homebrew/Caskroom/miniconda/base/envs/narrator-mlx',
  wslConda: '/home/fake/anaconda3/bin/conda',
  higgsEnv: 'higgs3',
  distro: 'Ubuntu',
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => FIXTURE, isPackaged: false },
    BrowserWindow: class {},
  },
};

// ── The probe spawn, stubbed ─────────────────────────────────────────────────
//
// Both doctors reach `child_process.spawn` through a module-object property
// (`(0, child_process_1.spawn)(...)` in the compiled output), so replacing the
// property here replaces it for both — no injection seam is needed and neither
// module knows it is being watched. The stub RECORDS the call, which is half of
// what this keeper asserts: which command each arm runs is the behaviour, not an
// implementation detail.
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
/** The last spawn each doctor asked for. */
let lastSpawn = null;
/**
 * What the fake child prints, and how it ends — set per fixture by `onPlatform`.
 *
 * NULL MEANS "NO PROBE MAY RUN", and the stub throws if one does. There is no
 * default script: a fixture that expects no spawn (linux, an unresolvable env)
 * and silently got a blank one would report the doctor as green-by-accident, and
 * the blank default is exactly the shape of that mistake.
 */
let probeScript = null;

childProcess.spawn = function (command, args, opts) {
  lastSpawn = { command, args, opts };
  if (probeScript === null) {
    throw new Error(
      `a probe ran on a fixture that declared none: ${command} ${args.join(' ')}`);
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  setImmediate(() => {
    if (probeScript.exit === 'error') {
      child.emit('error', new Error('spawn ENOENT'));
      return;
    }
    if (probeScript.stdout) child.stdout.emit('data', Buffer.from(probeScript.stdout, 'utf8'));
    if (probeScript.stderr) child.stderr.emit('data', Buffer.from(probeScript.stderr, 'utf8'));
    // THE EXIT CODE IS PART OF THE FIXTURE. `conda run` failing before the
    // program runs is a different machine from one where every import failed.
    child.emit('close', probeScript.code === undefined ? 0 : probeScript.code);
  });
  return child;
};

const doctorMod = require(path.join(DIST, 'higgs-doctor.js'));
const spawnMod = require(path.join(DIST, 'higgs-spawn.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));
const narratorPathsModule = require(path.join(DIST, 'narrator-paths.js'));
const narratorSpawn = require(path.join(DIST, 'narrator-spawn.js'));
// The doctor reaches the catalog through this module object
// (`(0, higgs_models_1.listHiggsModels)()` in the compiled output), so stubbing a
// property here is a real seam and not a rewrite — the same trick the probe spawn
// uses above.
const higgsModels = require(path.join(DIST, 'higgs-models.js'));

function stub(mod, name, fn) {
  const d = Object.getOwnPropertyDescriptor(mod, name);
  const prev = mod[name];
  if (d && d.get) Object.defineProperty(mod, name, { value: fn, configurable: true, enumerable: true });
  else mod[name] = fn;
  return () => {
    if (d && d.get) Object.defineProperty(mod, name, d);
    else mod[name] = prev;
  };
}

/**
 * Run `fn` on the machine described by `opts`, then put everything back.
 *
 * WHAT IS STUBBED AND WHAT IS NOT. The leaves — where conda is, what the env is
 * called, whether the toggle is on — are fixtures, because they are facts about a
 * machine. `narratorNativePython` and `narratorPythonRoot` are NOT stubbed: they
 * are the spawn's own resolution, and the whole claim of the darwin doctor is
 * that it probes THE ENVIRONMENT THE RENDER WILL USE. Stubbing them would test
 * the keeper's idea of that instead.
 */
function onPlatform(opts, fn) {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: opts.platform, configurable: true });
  const undo = [
    stub(toolPaths, 'shouldUseWsl2ForHiggs', () => !!opts.wslHiggs),
    stub(toolPaths, 'getWslCondaPath', () => FAKE.wslConda),
    stub(toolPaths, 'getWslHiggsCondaEnv', () => FAKE.higgsEnv),
    stub(toolPaths, 'getWslDistro', () => FAKE.distro),
    stub(narratorPathsModule, 'getCondaPath', () => FAKE.conda),
    stub(narratorPathsModule, 'getNarratorMlxEnv', () => {
      if (opts.mlxEnvMissing) throw new Error("The 'narrator-mlx' environment is not installed.");
      return FAKE.mlxEnv;
    }),
    // Identity: what is under test is the PYTHONPATH the doctor sets, not this
    // machine's PATH or its ffmpeg.
    stub(narratorPathsModule, 'buildToolsSpawnEnv', (extra) => ({ ...extra })),
  ];
  // `os.platform()` is what tool-paths reads (not `process.platform`), so the WSL
  // doctor's own guard has to see the fixture's platform too.
  const realOsPlatform = os.platform;
  os.platform = () => opts.platform;
  probeScript = opts.probe === undefined ? null : opts.probe;
  if (opts.weights === 'present') {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(path.join(BASE_DIR, 'config.json'), '{}');
    fs.writeFileSync(path.join(BASE_DIR, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(BASE_DIR, 'model.safetensors'), 'x');
  } else {
    fs.rmSync(path.join(FIXTURE, 'runtime'), { recursive: true, force: true });
  }
  lastSpawn = null;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      os.platform = realOsPlatform;
      undo.reverse().forEach((u) => u());
      Object.defineProperty(process, 'platform', platformDesc);
    });
}

/** Every MLX row green. */
const MLX_GREEN = {
  stdout: [
    'python=3.11.9',
    'mlx=0.32.0',
    `mlx-audio=${doctorMod.HIGGS_MLX_AUDIO_VERSION}`,
    `narrator=${doctorMod.HIGGS_MLX_AUDIO_VERSION}`,
    '',
  ].join('\n'),
  exit: 'close',
};

/** Every WSL row green. */
const WSL_GREEN = {
  stdout: [
    'env=ok',
    'omni=ok',
    ...toolPaths.HIGGS_PATCHES.map((p) => `patch:${p.id}=ok`),
    'launcher=ok',
    '',
  ].join('\n'),
  exit: 'close',
};

/**
 * Rows are COLLECTED and then run ONE AT A TIME.
 *
 * `onPlatform` mutates process-wide state — `process.platform`, `os.platform`,
 * seven module exports and the fixture directory — so two rows in flight at once
 * would each see the other's machine. Collecting them keeps the file readable
 * top-to-bottom (a heading, then its rows) while the runner at the bottom
 * guarantees they never overlap.
 */
const rows = [];
let failures = 0;
function check(name, fn) {
  rows.push({ name, fn });
}
/** A heading, in the reading order it was written in. */
function section(name) {
  rows.push({ heading: name });
}

// ─────────────────────────────────────────────────────────────────────────────
section('win32 → the WSL doctor');
// ─────────────────────────────────────────────────────────────────────────────

check('the probe goes to wsl.exe, and it is the vllm-omni probe', () => onPlatform(
  { platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(lastSpawn.command, 'wsl.exe', 'the Windows arm did not probe WSL');
    const script = lastSpawn.args.join(' ');
    assert.match(script, /vllm_omni/, 'the WSL probe no longer asks about the serving stack');
    assert.match(script, new RegExp(FAKE.higgsEnv), 'the probe looked at some other env');
    assert.strictEqual(res.arm, 'wsl');
    assert.strictEqual(res.valid, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  },
));

check('the "WSL2 for Higgs" toggle is a REPORTED ROW, not an early return', () => onPlatform(
  { platform: 'win32', wslHiggs: false, probe: WSL_GREEN },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false, 'a Windows machine with the toggle off cannot render Higgs');
    const toggle = res.checks.find((c) => c.id === 'toggle');
    assert.ok(toggle, 'no toggle row at all');
    assert.strictEqual(toggle.ok, false);
    assert.match(toggle.detail, /WSL2 for Higgs/, 'the row does not say what to turn on');
    // NOT a short circuit: the environment rows are still there, so the Settings
    // panel can show what an install achieved before the toggle is flipped.
    assert.ok(res.checks.some((c) => c.id === 'vllm-omni'),
      'the toggle row replaced the environment rows instead of joining them');
  },
));

check('a Windows failure names the WINDOWS remedy', () => onPlatform(
  { platform: 'win32', wslHiggs: true, probe: { stdout: 'env=absent\n', exit: 'close' } },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false);
    assert.match(res.remedy, /Settings → Higgs/);
    assert.doesNotMatch(res.remedy, /narrator-mlx/,
      'the Windows arm is telling someone to build a Mac environment');
  },
));

// ─────────────────────────────────────────────────────────────────────────────
section('darwin → the MLX doctor');
// ─────────────────────────────────────────────────────────────────────────────

check('the probe is conda run in narrator-mlx — the SPAWN\'s own resolution', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'present' },
  async () => {
    const res = await doctorMod.higgsDoctor();
    // The spawn's own answer, asked the same way the doctor is supposed to ask it.
    const spawnPy = narratorSpawn.narratorNativePython('higgs');
    assert.strictEqual(lastSpawn.command, spawnPy.command,
      'the doctor probes a different interpreter from the one the render launches');
    assert.deepStrictEqual(lastSpawn.args.slice(0, spawnPy.args.length), spawnPy.args,
      'the doctor probes a different environment from the one the render launches');
    assert.strictEqual(lastSpawn.args[spawnPy.args.length], '-c');
    assert.strictEqual(res.arm, 'mlx');
    assert.strictEqual(res.valid, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  },
));

check('the probe asks about mlx, mlx-audio and the narrator backend, in one round trip', () =>
  onPlatform({ platform: 'darwin', probe: MLX_GREEN, weights: 'present' }, async () => {
    let spawns = 0;
    const restore = childProcess.spawn;
    childProcess.spawn = function (...a) { spawns++; return restore.apply(this, a); };
    try {
      await doctorMod.higgsDoctor();
    } finally {
      childProcess.spawn = restore;
    }
    assert.strictEqual(spawns, 1, 'a doctor that spawns per question is a doctor nobody runs');
    const program = lastSpawn.args[lastSpawn.args.length - 1];
    assert.match(program, /import mlx\.core/);
    assert.match(program, /import mlx_audio/);
    assert.match(program, /narrator\.engine\.higgs\.mlx_backend/);
  }));

check('PYTHONPATH is the repo\'s python/, as the spawn sets it', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'present' },
  async () => {
    await doctorMod.higgsDoctor();
    assert.strictEqual(lastSpawn.opts.env.PYTHONPATH, narratorSpawn.narratorPythonRoot(),
      'the probe would import a different narrator than the render');
  },
));

check('a Mac failure names the MAC remedy — never "Settings → Higgs" alone', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'absent' },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false, 'a Mac with no weights cannot render');
    assert.match(res.remedy, /narrator-mlx\.yml/, 'the Mac remedy does not name the env file');
    assert.match(res.remedy, /higgs-models[\\/]base/, 'the Mac remedy does not name the weights dir');
    assert.doesNotMatch(res.remedy, /WSL/i, 'the Mac is being told to install WSL');
  },
));

check('an unreadable weights directory names the ERRNO, not just "missing"', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'absent' },
  async () => {
    const res = await doctorMod.higgsDoctor();
    const weights = res.checks.find((c) => c.id === 'weights');
    assert.ok(weights && !weights.ok);
    assert.match(weights.detail, /higgs-models[\\/]base/);
    // ENOENT (download the weights), EACCES (a permissions problem on
    // Application Support) and EIO (a failing external disk — Owen keeps models
    // on one) are three different fixes, and "missing the directory itself"
    // sends all three to the first.
    assert.match(weights.detail, /ENOENT/,
      'the readdir errno was swallowed — the row cannot tell a dead disk from a missing download');
  },
));

check('a weights directory missing ONE file names that file', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'present' },
  async () => {
    fs.rmSync(path.join(BASE_DIR, 'tokenizer.json'));
    const res = await doctorMod.higgsDoctor();
    const weights = res.checks.find((c) => c.id === 'weights');
    assert.strictEqual(weights.ok, false, 'a half-downloaded checkpoint reported as ready');
    assert.match(weights.detail, /tokenizer\.json/);
  },
));

check('a NON-ZERO probe exit carries conda\'s own reason, not "no answer"', () => onPlatform(
  {
    platform: 'darwin', weights: 'present',
    probe: {
      stdout: '', exit: 'close', code: 1,
      stderr: 'EnvironmentLocationNotFound: Not a conda environment: /opt/.../narrator-mlx\n',
    },
  },
  async () => {
    const res = await doctorMod.higgsDoctor();
    for (const id of ['python', 'mlx', 'mlx-audio', 'narrator']) {
      const row = res.checks.find((c) => c.id === id);
      assert.strictEqual(row.ok, false);
      // The line Owen actually reads has to hold the REASON and the exit code.
      assert.match(row.detail, /EnvironmentLocationNotFound/,
        `${id} discarded stderr — the row states a symptom, not a reason`);
      assert.match(row.detail, /exited 1/, `${id} does not report the exit code`);
    }
  },
));

check('an interpreter that dies PARTWAY still surfaces its stderr', () => onPlatform(
  {
    platform: 'darwin', weights: 'present',
    probe: {
      stdout: 'python=3.11.9\n', exit: 'close', code: 0,
      stderr: 'Fatal Python error: Segmentation fault\n',
    },
  },
  async () => {
    const res = await doctorMod.higgsDoctor();
    const row = res.checks.find((c) => c.id === 'mlx');
    assert.strictEqual(row.ok, false);
    assert.match(row.detail, /Segmentation fault/,
      'the only evidence of why the probe stopped was thrown away');
  },
));

check('mlx-audio at the WRONG version fails, and both versions are named', () => onPlatform(
  {
    platform: 'darwin', weights: 'present',
    probe: { stdout: `python=3.11.9\nmlx=0.32.0\nmlx-audio=0.5.1\nnarrator=${doctorMod.HIGGS_MLX_AUDIO_VERSION}\n`, exit: 'close' },
  },
  async () => {
    const res = await doctorMod.higgsDoctor();
    const row = res.checks.find((c) => c.id === 'mlx-audio');
    assert.strictEqual(row.ok, false, 'an env at the wrong mlx-audio was reported as ready');
    assert.match(row.detail, /0\.5\.1/);
    assert.match(row.detail, new RegExp(doctorMod.HIGGS_MLX_AUDIO_VERSION.replace(/\./g, '\\.')));
  },
));

check('a MISSING probe line is a failure, not a pass', () => onPlatform(
  { platform: 'darwin', weights: 'present', probe: { stdout: 'python=3.11.9\n', exit: 'close' } },
  async () => {
    const res = await doctorMod.higgsDoctor();
    for (const id of ['mlx', 'mlx-audio', 'narrator']) {
      const row = res.checks.find((c) => c.id === id);
      assert.strictEqual(row.ok, false, `${id} was reported green with no answer from the probe`);
    }
  },
));

check('no narrator-mlx env: the env row fails and NOTHING is short-circuited', () => onPlatform(
  { platform: 'darwin', mlxEnvMissing: true, weights: 'present' },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(lastSpawn, null, 'the doctor probed an environment it could not resolve');
    const env = res.checks.find((c) => c.id === 'env');
    assert.strictEqual(env.ok, false);
    assert.match(env.detail, /narrator-mlx/);
    // The weights row is answered on the host, so it still reports — which is
    // exactly when "and there are no weights either" is worth knowing.
    const weights = res.checks.find((c) => c.id === 'weights');
    assert.strictEqual(weights.ok, true, 'the weights row went missing when the env failed');
    for (const id of ['python', 'mlx', 'mlx-audio', 'narrator']) {
      assert.ok(res.checks.some((c) => c.id === id), `the ${id} row was dropped`);
    }
  },
));

check('the loadable voices are NOTES, and never make a green machine invalid', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'present' },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.ok(Array.isArray(res.notes) && res.notes.length > 0, 'no voice notes at all');
    assert.ok(res.notes.some((n) => n.startsWith('default:')), 'the built-in voice is not reported');
    assert.strictEqual(res.valid, true,
      'a working environment with no fine-tune installed is still a working environment');
  },
));

// ── The three checkpoint notes ──────────────────────────────────────────────
//
// A `checkpoint` voice is ~8.5 GB on disk and the catalog names its directory
// ONCE PER ARM, so on the Mac there are THREE distinct answers to "can I use
// this voice", and they send a person three different places:
//
//   not staged for this arm   the CATALOG names no darwin directory. Nothing to
//                             download until someone decides to stage it — and
//                             staging it means MEASURING this arm's own cap.
//   staged path missing       the catalog says where it is and it is not there:
//                             an interrupted copy. A copy fixes this one.
//   loadable                  both.
//
// One sentence covered the first two until 2026-09-05, which told a person to go
// looking on disk for a directory the catalog had never named on this arm.
//
// These drive the note function through a STUBBED CATALOG rather than the shipped
// one: what is under test is the three-way branch, and the shipped row is pending
// (so it reports the pending note) and will not stay in any one of these states.
async function withCatalog(models, fn) {
  const undo = stub(higgsModels, 'listHiggsModels', () => models);
  // AWAITED INSIDE, because the notes are built after the probe's fake child
  // emits on `setImmediate` — a `finally` that ran on the un-awaited promise put
  // the real catalog back before the doctor had read anything.
  try { return await fn(); } finally { undo(); }
}

/** A staged fine-tune, as the catalog holds one. */
function checkpointRow(checkpoint) {
  return {
    id: 'ft', label: 'FT', kind: 'checkpoint', engineVersion: 'v3',
    voice: { checkpoint },
    license: 'x', commercialUse: false, sampleRate: 24000, addedAt: 'x',
    backends: { served: { maxChars: 900, maxCharsSource: 'length-sweep' } },
  };
}

check('a fine-tune the catalog does not stage HERE reads "not staged for this arm"', () =>
  onPlatform({ platform: 'darwin', probe: MLX_GREEN, weights: 'present' }, async () => {
    const res = await withCatalog(
      [checkpointRow({ wsl: '/home/telltale/higgs_v3_merged/ds' })],
      () => doctorMod.higgsDoctor(),
    );
    const note = res.notes.find((n) => n.startsWith('ft:'));
    assert.ok(note, 'the fine-tune was not reported at all');
    assert.match(note, /not staged for this arm/);
    assert.match(note, /no darwin checkpoint/);
    // It must NOT send the reader hunting for the guest's directory on this Mac.
    assert.ok(!/\/home\/telltale/.test(note),
      "the note names the WSL directory, which this machine has never had");
    assert.match(note, /NEW certificate/,
      'nothing says that staging a copy means measuring this arm again');
    assert.strictEqual(res.valid, true, 'a voice on the other machine is not a broken install');
  }));

check('a fine-tune staged in the catalog but absent on disk says exactly that', () =>
  onPlatform({ platform: 'darwin', probe: MLX_GREEN, weights: 'present' }, async () => {
    const res = await withCatalog(
      [checkpointRow({ darwin: 'runtime/higgs-models/not-copied-yet' })],
      () => doctorMod.higgsDoctor(),
    );
    const note = res.notes.find((n) => n.startsWith('ft:'));
    assert.match(note, /staged path missing on disk/);
    // NAMING THE RESOLVED PATH, not the catalog's relative one: the fix is a
    // copy, and a person cannot make one to "runtime/higgs-models/…".
    assert.ok(note.includes(path.join(FIXTURE, 'runtime', 'higgs-models', 'not-copied-yet')),
      'the note does not name the absolute directory the copy must land in: ' + note);
  }));

check('a MALFORMED staged path is a NOTE, not a doctor that throws', () =>
  onPlatform({ platform: 'darwin', probe: MLX_GREEN, weights: 'present' }, async () => {
    // A doctor that throws is a modal with no rows in it. The refusal's own
    // sentence becomes the note — never a paraphrase, or the doctor and the
    // loader would describe the same catalog differently.
    const res = await withCatalog(
      [checkpointRow({ darwin: '/Users/someone-else/Library/Application Support/BookForge/x' })],
      () => doctorMod.higgsDoctor(),
    );
    const note = res.notes.find((n) => n.startsWith('ft:'));
    assert.match(note, /is absolute/);
    assert.strictEqual(res.valid, true, 'a bad catalog row failed the ENVIRONMENT');
  }));

check('a fine-tune that is really there reads "loadable", with the directory', () =>
  onPlatform({ platform: 'darwin', probe: MLX_GREEN, weights: 'present' }, async () => {
    const dir = path.join(FIXTURE, 'runtime', 'higgs-models', 'ds_staged');
    fs.mkdirSync(dir, { recursive: true });
    const res = await withCatalog(
      [checkpointRow({ darwin: 'runtime/higgs-models/ds_staged',
                       wsl: '/home/telltale/higgs_v3_merged/ds' })],
      () => doctorMod.higgsDoctor(),
    );
    const note = res.notes.find((n) => n.startsWith('ft:'));
    assert.match(note, /loadable — fine-tuned weights at /);
    assert.ok(note.includes(dir), 'the note does not name the weights it found: ' + note);
    // The arm that has them, not the other one.
    assert.ok(!note.includes('/home/telltale'), 'the note names the WSL copy on a Mac');
  }));

// ─────────────────────────────────────────────────────────────────────────────
section('anything else → a refusal that names the platform');
// ─────────────────────────────────────────────────────────────────────────────

check('linux is refused BY NAME, not diagnosed as a broken WSL', () => onPlatform(
  { platform: 'linux', probe: MLX_GREEN },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(lastSpawn, null, 'an unsupported platform ran a probe anyway');
    assert.strictEqual(res.arm, 'none');
    assert.strictEqual(res.valid, false);
    assert.match(res.checks[0].detail, /linux/, 'the refusal does not name the platform');
  },
));

// ─────────────────────────────────────────────────────────────────────────────
section('every arm: a failed row explains itself');
// ─────────────────────────────────────────────────────────────────────────────

check('no check fails without a detail, on any arm', async () => {
  // SEQUENTIALLY, one machine at a time — see the `rows` comment. Each of these
  // is a machine where the probe itself could not run, which is the case where a
  // detail-less row would leave someone with nowhere to go.
  const results = [];
  results.push(await onPlatform(
    { platform: 'win32', wslHiggs: false, probe: { stdout: '', exit: 'error' } },
    () => doctorMod.higgsDoctor()));
  results.push(await onPlatform(
    { platform: 'darwin', weights: 'absent', probe: { stdout: '', exit: 'error' } },
    () => doctorMod.higgsDoctor()));
  results.push(await onPlatform({ platform: 'linux' }, () => doctorMod.higgsDoctor()));
  for (const res of results) {
    for (const c of res.checks) {
      if (!c.ok) {
        assert.ok(c.detail && c.detail.length > 20,
          `${res.arm}/${c.id} failed with nothing a person could act on: ${JSON.stringify(c.detail)}`);
      }
    }
    assert.ok(res.remedy && res.remedy.length > 20, `${res.arm} has no remedy`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('higgsEnvironmentRefusal consults the doctor — on EVERY platform');
// ─────────────────────────────────────────────────────────────────────────────

// THE MUTATION THIS SECTION EXISTS FOR: put `if (process.platform !== 'win32')
// return null;` back at the top of higgsEnvironmentRefusal — the unchecked pass
// that shipped — and the next row fails. That is the whole point: a Mac that
// cannot render must be refused BEFORE the job starts, not an hour in.
check('darwin, a failing check → the doctor\'s refusal, naming the row', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'absent' },
  async () => {
    const refusal = await spawnMod.higgsEnvironmentRefusal();
    assert.ok(refusal, 'a Mac with no Higgs weights was waved through');
    assert.match(refusal, /Higgs v3 base weights/, 'the refusal does not name the failed check');
    assert.match(refusal, /narrator-mlx\.yml/, 'the refusal does not carry the Mac remedy');
  },
));

check('darwin, everything green → null, and only then', () => onPlatform(
  { platform: 'darwin', probe: MLX_GREEN, weights: 'present' },
  async () => {
    assert.strictEqual(await spawnMod.higgsEnvironmentRefusal(), null,
      'a working Mac was refused');
  },
));

check('win32 with the toggle off → refused, naming the toggle', () => onPlatform(
  { platform: 'win32', wslHiggs: false, probe: WSL_GREEN },
  async () => {
    const refusal = await spawnMod.higgsEnvironmentRefusal();
    assert.ok(refusal, 'Windows without the toggle was waved through');
    assert.match(refusal, /WSL2 for Higgs/);
  },
));

check('win32, everything green with the toggle on → null', () => onPlatform(
  { platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
  async () => {
    assert.strictEqual(await spawnMod.higgsEnvironmentRefusal(), null);
  },
));

// ─────────────────────────────────────────────────────────────────────────────
section('the wiring: the IPC handler and the mirrored constants');
// ─────────────────────────────────────────────────────────────────────────────

check('the higgs:doctor IPC handler DISPATCHES rather than calling the WSL doctor', () => {
  // Read from the SOURCE: the handler is inside `registerIpcHandlers` and there is
  // no way to invoke it without an Electron main loop, but "which function does it
  // call" is exactly the thing that was wrong, and it is visible here.
  const src = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
  const start = src.indexOf("ipcMain.handle('higgs:doctor'");
  assert.ok(start > 0, 'there is no higgs:doctor handler any more');
  const body = src.slice(start, src.indexOf('ipcMain.handle', start + 10));
  assert.match(body, /higgsDoctor\(\)/, 'the handler does not call the platform dispatcher');
  assert.doesNotMatch(body, /checkWslHiggsSetup/,
    'the handler is hard-wired to the WSL doctor again — this is the Mac defect');
});

check('the Settings Install/Repair button is gated on the HOST, not on the doctor\'s reply', () => {
  // `doctor()` is null while the first check is in flight AND after a check that
  // FAILED, and a Windows machine whose doctor cannot answer is exactly the one
  // whose owner needs the repair door. Source-level because this is a template
  // condition; the shape of the mistake is `doctor()?.arm === 'wsl'` guarding the
  // button, which is what shipped in this branch's first draft.
  const src = fs.readFileSync(path.join(
    REPO, 'src', 'app', 'features', 'settings', 'components',
    'higgs-voices-panel.component.ts'), 'utf-8');
  const install = src.indexOf('(clicked)="install()"');
  assert.ok(install > 0, 'the panel no longer has an install button');
  // The nearest @if above the button is the one that gates it.
  const guard = src.lastIndexOf('@if (', install);
  const condition = src.slice(guard, src.indexOf('{', guard));
  assert.match(condition, /hostArm\(\)/, 'the install button is not keyed on the host platform');
  assert.doesNotMatch(condition, /doctor\(\)/,
    'the repair door disappears exactly when the doctor cannot answer');
});

check('the mlx-audio pin agrees with the backend module', () => {
  // The doctor must state the expected version even when the backend module is
  // the thing that failed to import, so it keeps its own copy. This is what stops
  // the two drifting.
  const src = fs.readFileSync(
    path.join(REPO, 'python', 'narrator', 'engine', 'higgs', 'mlx_backend.py'), 'utf-8');
  const m = src.match(/^MLX_AUDIO_VERSION\s*=\s*'([^']+)'/m);
  assert.ok(m, 'mlx_backend.py no longer declares MLX_AUDIO_VERSION');
  assert.strictEqual(doctorMod.HIGGS_MLX_AUDIO_VERSION, m[1],
    'BookForge and narrator disagree about which mlx-audio the Mac needs');
});

check('the weights the doctor requires are the files the backend opens', () => {
  // Not a guess: `load_model` reads config.json and `post_load_hook` opens
  // tokenizer.json. If the backend stops naming one of these, this row is where
  // the doctor's list gets re-measured rather than left to rot.
  const src = fs.readFileSync(
    path.join(REPO, 'python', 'narrator', 'engine', 'higgs', 'mlx_backend.py'), 'utf-8');
  for (const f of ['config.json', 'tokenizer.json', 'safetensors']) {
    assert.ok(src.includes(f), `mlx_backend.py no longer mentions ${f} — re-measure the doctor's list`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  for (const row of rows) {
    if (row.heading !== undefined) {
      console.log(row.heading);
      continue;
    }
    try {
      await row.fn();
      console.log(`  ok    ${row.name}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ${row.name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
    }
  }
  childProcess.spawn = realSpawn;
  fs.rmSync(FIXTURE, { recursive: true, force: true });
  console.log(failures === 0
    ? '\nAll Higgs doctor arms passed.'
    : `\n${failures} check(s) FAILED.`);
  // NOT `process.exit()`: this whole report may be going to a pipe (the keeper
  // runner reads it), and a hard exit truncates it.
  process.exitCode = failures === 0 ? 0 : 1;
})();

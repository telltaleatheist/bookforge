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
/**
 * WHICH CONDA ENV runs the probe command containing `marker`.
 *
 * NOT `script.split(';')`: the probes are `python -c '<program>'` and the
 * programs carry semicolons of their own, so splitting on them cuts a command in
 * half and the half holding `find_spec` no longer holds its interpreter. This
 * walks BACK from the marker to the nearest `/bin/python` and reads the env name
 * off the prefix in front of it, which is the question actually being asked.
 */
function envRunning(script, marker) {
  const at = script.indexOf(marker);
  assert.notStrictEqual(at, -1, `the probe contains no ${marker}`);
  const before = script.slice(0, at);
  const py = before.lastIndexOf('/bin/python');
  assert.notStrictEqual(py, -1, `no interpreter precedes ${marker}`);
  const prefix = before.slice(0, py);
  return prefix.slice(prefix.lastIndexOf('/envs/') + '/envs/'.length);
}

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
  // ── WHICH SERVING STACK, AS A FIXTURE ─────────────────────────────────────
  //
  // `higgsDoctor()` reads `serving.stack` from the catalog to decide which env to
  // examine, which package to import-probe, whether to ask about the two
  // site-packages patches and the deploy profile, and whether to ask about the
  // flashinfer CUDA links. That value is a DECISION somebody makes and changes —
  // it shipped as vllm-omni and flipped to sglang-omni on 2026-09-06 — so a row
  // that read it would (a) go red on a one-word catalog edit and (b) stop testing
  // whichever stack was not shipped, at exactly the moment a regression in it
  // could go unnoticed.
  //
  // So every stack row states its stack, both are exercised on every run, and the
  // SHIPPED value is asserted on its own row instead.
  if (opts.stack) {
    undo.push(stub(higgsModels, 'higgsServingSpec',
      () => ({ ...realServingSpec(), stack: opts.stack })));
    if (opts.stack === 'sglang-omni') {
      // The SGLang env name is the catalog's, not the `wslHiggsCondaEnv` setting
      // (whose default is literally `higgs3`). Pinned so the probe's target is a
      // fixture rather than this machine's conda layout.
      undo.push(stub(higgsModels, 'higgsSglangFor',
        () => ({ ...realSglangFor(realServingSpec()), condaEnvName: FAKE_SGL_ENV })));
    }
  }
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

/**
 * Every WSL row green.
 *
 * The two shas and the narrator-import answer are what a MATCHING env says:
 * `higgsExpectations()` reads this build's own shipped files, so the fixture
 * states the same shas rather than literals — hardcoded ones would go stale the
 * next time serve_higgs_v3.sh or the deploy profile is edited and this file
 * would start failing for a reason that is not about the doctor.
 */
const WSL_GREEN = {
  stdout: [
    'env=ok',
    'omni=ok',
    ...toolPaths.HIGGS_PATCHES.map((p) => `patch:${p.id}=ok`),
    'launcher=ok',
    `launcher-sha=${toolPaths.shippedHiggsLauncherSha256()}`,
    `profile-sha=${toolPaths.shippedHiggsProfileSha256()}`,
    'narrator-deps=ok',
    '',
  ].join('\n'),
  exit: 'close',
};

/** The same env, with a launcher from an older BookForge. */
const WSL_STALE_LAUNCHER = {
  stdout: WSL_GREEN.stdout.replace(
    `launcher-sha=${toolPaths.shippedHiggsLauncherSha256()}`,
    'launcher-sha=' + '0'.repeat(64),
  ),
  exit: 'close',
};

/**
 * The same env, with a deploy profile from an older BookForge — and the same env
 * again with none at all, which is what every env built before the profile
 * shipped looks like.
 *
 * BOTH ARE THE SAME REMEDY AND STILL WORTH TWO FIXTURES: the missing case is the
 * one that will actually be hit (an env built last week), and it is also the one
 * whose failure is invisible at run time — vllm-omni falls back to its own
 * profile, caps stage 0 at 2048 frames = 81.92 s and cuts every longer chunk
 * mid-sentence while the render reports success.
 */
const WSL_STALE_PROFILE = {
  stdout: WSL_GREEN.stdout.replace(
    `profile-sha=${toolPaths.shippedHiggsProfileSha256()}`,
    'profile-sha=' + '0'.repeat(64),
  ),
  exit: 'close',
};

const WSL_NO_PROFILE = {
  stdout: WSL_GREEN.stdout.replace(
    `profile-sha=${toolPaths.shippedHiggsProfileSha256()}`,
    'profile-sha=absent',
  ),
  exit: 'close',
};

/** The same env, missing two of narrator's runtime imports. */
const WSL_MISSING_DEPS = {
  stdout: WSL_GREEN.stdout.replace('narrator-deps=ok', 'narrator-deps=bs4,regex'),
  exit: 'close',
};

// ── THE SGLang-OMNI ARM ─────────────────────────────────────────────────────
//
// A SECOND SERVING STACK, selected by the catalog's `serving.stack` (measured
// 2026-09-05: vllm-omni at 16 in flight gives 4 early stops, 13/50 damaged and 6
// sustained voice switches; SGLang-Omni at 16 gives 0, 5 and 0, at 2.5x the
// throughput). It is a DIFFERENT ENV with DIFFERENT ROWS, and the fixtures below
// are what a healthy one of those answers.
//
// The three differences that matter to a doctor, each of which would be a false
// red or a false green if it were got wrong:
//
//   * `sglang_omni`, not `vllm_omni`. The two never live in one env (python 3.12
//     + torch 2.13.0+cu130 against python 3.11 + vllm 0.28.0).
//   * NO PATCH ROWS. Both patches edit files in `vllm/` and `vllm_omni/`, which
//     this env does not contain. Asking would report a healthy machine broken.
//   * NO PROFILE ROW, and a `cuda-links` row instead. `--deploy-config` is a
//     vllm-omni flag; what THIS stack cannot start without is the pair of
//     symlinks flashinfer's nvcc build needs inside the pip CUDA 13 wheel.
const FAKE_SGL_ENV = 'sglomni';

// THE REAL READERS, CAPTURED BEFORE ANYTHING STUBS THEM. `onPlatform`'s stack
// fixture is installed AS `higgsServingSpec`, so reading the module property from
// inside it would call itself.
const realServingSpec = higgsModels.higgsServingSpec;
const realSglangFor = higgsModels.higgsSglangFor;

/** Whichever stack the app will actually use. Asserted on its own row below. */
const SHIPPED_STACK = realServingSpec().stack;

const SGL_GREEN = {
  stdout: [
    'env=ok',
    'omni=ok',
    'cuda-links=ok',
    'launcher=ok',
    `launcher-sha=${toolPaths.higgsExpectations('sglang-omni').launcherSha}`,
    'narrator-deps=ok',
    '',
  ].join('\n'),
  exit: 'close',
};

/** The same env, with the flashinfer CUDA symlinks never made. */
const SGL_NO_CUDA_LINKS = {
  stdout: SGL_GREEN.stdout.replace('cuda-links=ok', 'cuda-links=absent'),
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
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
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
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: false, probe: WSL_GREEN },
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

check('the WSL probe asks for the launcher\'s SHA and narrator\'s imports', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
  async () => {
    await doctorMod.higgsDoctor();
    const script = lastSpawn.args.join(' ');
    // The launcher's IDENTITY, not just its presence: `test -x` reported ok on an
    // env carrying the launcher from the week it was built, while every later fix
    // to serve_higgs_v3.sh shipped in the repo and was read by nobody.
    assert.match(script, /sha256sum/, 'the probe no longer hashes the deployed launcher');
    assert.match(script, /tr -d/, 'the guest side no longer strips CR before hashing — a '
      + 'Windows-built env would report stale against a Mac-built one');
    // narrator is reached over PYTHONPATH and never pip-installed into this env,
    // so nothing but the installer's explicit step puts its imports there.
    assert.match(script, /find_spec/, 'the probe no longer asks which narrator imports are present');
    for (const dep of toolPaths.narratorRuntimeDeps()) {
      assert.ok(script.includes(` ${dep.module}`),
        `the probe does not ask about ${dep.module} (${dep.requirement})`);
    }
    // WITHOUT `--exec` wsl.exe hands the line to the distro's default shell, which
    // expands `$(...)` before bash -c sees it — the defect that blinded both patch
    // rows (da3db4c9). The launcher probe is a `$(...)`, so it is the same trap.
    assert.ok(lastSpawn.args.includes('--exec'),
      'the probe lost --exec, and its $(...) will be eaten by the default shell');
  },
));

check('a launcher from an older BookForge is launcher-stale, not ok', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_STALE_LAUNCHER },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false, 'a stale launcher passed the doctor');
    // TWO ROWS, ON PURPOSE: present-and-executable is a different question from
    // is-it-ours, and they send a person to different places.
    assert.strictEqual(res.checks.find((c) => c.id === 'launcher').ok, true,
      'the presence row failed on a launcher that is present');
    const sha = res.checks.find((c) => c.id === 'launcher-sha');
    assert.ok(sha, 'no launcher-sha row at all');
    assert.strictEqual(sha.ok, false);
    assert.match(sha.detail, /launcher-stale/, 'the row does not name the condition');
    assert.match(sha.detail, /re-run the Higgs installer/i, 'the row does not name the remedy');
  },
));

check('the WSL probe hashes the DEPLOY PROFILE as well as the launcher', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
  async () => {
    const res = await doctorMod.higgsDoctor();
    const script = lastSpawn.args.join(' ');
    assert.ok(script.includes(toolPaths.HIGGS_DEPLOY_PROFILE),
      'the probe never looks at the deploy profile, which is what carries the frame ceiling');
    const row = res.checks.find((c) => c.id === 'profile-sha');
    assert.ok(row, 'no profile-sha row at all');
    assert.strictEqual(row.ok, true, JSON.stringify(row));
    assert.strictEqual(res.valid, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  },
));

check('a deploy profile from an older BookForge is profile-stale, not ok', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_STALE_PROFILE },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false, 'a stale deploy profile passed the doctor');
    const row = res.checks.find((c) => c.id === 'profile-sha');
    assert.strictEqual(row.ok, false);
    assert.match(row.detail, /profile-stale/, 'the row does not name the condition');
    assert.match(row.detail, /re-run the Higgs installer/i, 'the row does not name the remedy');
  },
));

check('an env with NO deploy profile says what it costs, not just "missing"', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_NO_PROFILE },
  async () => {
    // This is every env built before the profile shipped, and its failure mode is
    // silent: vllm-omni auto-discovers its own profile, stage 0's max_tokens is
    // 2048 frames = 81.92 s, and a longer chunk is CUT MID-SENTENCE with the
    // request reporting success. A row that only said "not found" would be read
    // as cosmetic.
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false, 'an env with no deploy profile passed the doctor');
    const row = res.checks.find((c) => c.id === 'profile-sha');
    assert.strictEqual(row.ok, false);
    assert.match(row.detail, /81\.92 s/, 'the row does not say what the missing profile costs');
    assert.match(row.detail, /re-run the Higgs installer/i, 'the row does not name the remedy');
  },
));

check('a missing narrator import is reported BY NAME with its pip requirement', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_MISSING_DEPS },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false, "an env that cannot import bs4 cannot prep");
    const deps = res.checks.find((c) => c.id === 'narrator-deps');
    assert.ok(deps, 'no narrator-deps row at all');
    assert.strictEqual(deps.ok, false);
    // The failure Owen actually hit, asked before the run instead of after it.
    assert.match(deps.detail, /bs4/, 'the row does not name the missing module');
    assert.match(deps.detail, /beautifulsoup4/,
      'the row names the module but not the package that provides it — and they differ');
    assert.match(deps.detail, /regex/, 'the row reports only the first missing module');
  },
));

check('the doctor probes exactly the list the installer installs', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
  async () => {
    // ONE LIST, TWO READERS. install_higgs_env.sh pip-installs
    // requirements-narrator-runtime.txt and the doctor builds its probe from the
    // same rows; two lists would be two lists that disagree, and the first
    // disagreement is a green doctor over an env that cannot prep.
    const src = fs.readFileSync(
      path.join(REPO, 'electron', 'scripts', 'higgs', 'install_higgs_env.sh'), 'utf-8');
    assert.match(src, /requirements-narrator-runtime\.txt/,
      'the installer no longer reads the requirements file the doctor probes');
    assert.match(src, /pip install -r/, 'the installer no longer installs it');
    // Every row must say what it imports — the parser refuses one that does not,
    // so this is really asserting the file is well-formed on disk.
    const deps = toolPaths.narratorRuntimeDeps();
    assert.ok(deps.length >= 10, `only ${deps.length} runtime deps declared`);
    for (const dep of deps) {
      assert.ok(dep.module && dep.requirement, JSON.stringify(dep));
    }
    // The three whose pip name and import name differ — the reason the annotation
    // exists at all.
    const byModule = Object.fromEntries(deps.map((d) => [d.module, d.requirement]));
    assert.match(byModule.bs4 || '', /^beautifulsoup4/);
    assert.match(byModule.PIL || '', /^pillow/);
    assert.match(byModule.iso639 || '', /^iso639-lang/,
      'iso639 must come from iso639-lang: python-iso639 and iso-639 install the same module '
      + 'name with a different API and no Lang');
  },
));

check('a Windows failure names the WINDOWS remedy', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: { stdout: 'env=absent\n', exit: 'close' } },
  async () => {
    const res = await doctorMod.higgsDoctor();
    assert.strictEqual(res.valid, false);
    assert.match(res.remedy, /Settings → Higgs/);
    assert.doesNotMatch(res.remedy, /narrator-mlx/,
      'the Windows arm is telling someone to build a Mac environment');
  },
));

// ─────────────────────────────────────────────────────────────────────────────
section('win32 + serving.stack "sglang-omni" → the SGLang arm of the WSL doctor');
// ─────────────────────────────────────────────────────────────────────────────
//
// THE STACK IS A FIXTURE ON EVERY ROW (`onPlatform`'s `stack`), not a read of the
// catalog. `serving.stack` shipped as vllm-omni and flipped to sglang-omni on
// 2026-09-06; a suite that read it would go red on that one-word edit and — worse
// — would stop testing whichever stack was not shipped, exactly when a regression
// in it could go unnoticed. Both arms run on every machine, every run, and what
// the catalog actually says is asserted on its own row at the end of this
// section.

check('the probe examines the sglomni env and asks about sglang_omni', () => onPlatform(
  { stack: 'sglang-omni', platform: 'win32', wslHiggs: true, probe: SGL_GREEN },
  async () => {
      const res = await doctorMod.higgsDoctor();
      const script = lastSpawn.args.join(' ');
      assert.match(script, /import sglang_omni/,
        'the probe still asks about vllm_omni on the SGLang stack');
      assert.doesNotMatch(script, /import vllm_omni/);
      // THE ENV THE SPAWN WILL USE. `wslHiggsCondaEnv` names the vllm-omni env
      // (its default is literally `higgs3`); the SGLang env name lives in the
      // catalog's own block, and `higgsEnvExtras` derives the spawn's prefix from
      // exactly the same value.
      assert.match(script, new RegExp(`envs/${FAKE_SGL_ENV}`),
        `the probe looked at some env other than ${FAKE_SGL_ENV}`);
      assert.strictEqual(res.valid, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
      assert.ok(res.checks.some((c) => c.id === 'sglang-omni'),
        'no sglang-omni row at all');
  },
));

check('NO patch rows and NO deploy-profile row on this stack', () => onPlatform(
  { stack: 'sglang-omni', platform: 'win32', wslHiggs: true, probe: SGL_GREEN },
  async () => {
      const res = await doctorMod.higgsDoctor();
      const script = lastSpawn.args.join(' ');
      // Both patches edit files in vllm/ and vllm_omni/, which this env does not
      // contain: grepping for them here would report a healthy machine as broken
      // and send someone to an installer that would not touch what they were told
      // about. SGLang-Omni has its own stage processor and needs no patch.
      for (const p of toolPaths.HIGGS_PATCHES) {
        assert.ok(!script.includes(p.relPath),
          `the probe greps for ${p.id} in an env that has no vllm_omni`);
        assert.ok(!res.checks.some((c) => c.id === 'patch' && c.label.includes(p.id)),
          `a ${p.id} row was reported for the SGLang stack`);
      }
      // `--deploy-config` is a vllm-omni flag. There is no profile in the SGLang
      // launch line, and the frame ceiling it exists to raise is not how this
      // stack caps a render (per-request max_new_tokens, bounded by a hard-coded
      // 4096-token context).
      assert.ok(!script.includes(toolPaths.HIGGS_DEPLOY_PROFILE),
        'the probe hashes a deploy profile that this stack never reads');
      assert.ok(!res.checks.some((c) => c.id === 'profile-sha'),
        'a profile-sha row was reported for the SGLang stack');
      assert.strictEqual(res.valid, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  },
));

check('the launcher row is serve_higgs_sgl.sh, hashed like the other one', () => onPlatform(
  { stack: 'sglang-omni', platform: 'win32', wslHiggs: true, probe: SGL_GREEN },
  async () => {
      const res = await doctorMod.higgsDoctor();
      const script = lastSpawn.args.join(' ');
      assert.ok(script.includes(toolPaths.HIGGS_SGL_LAUNCH_SCRIPT),
        'the probe does not look at this stack\'s launcher');
      assert.ok(!script.includes(toolPaths.HIGGS_LAUNCH_SCRIPT),
        'the probe still looks at the vllm-omni launcher');
      const row = res.checks.find((c) => c.id === 'launcher-sha');
      assert.ok(row && row.ok, JSON.stringify(row));
      assert.strictEqual(res.checks.find((c) => c.id === 'launcher').label,
        toolPaths.HIGGS_SGL_LAUNCH_SCRIPT);
  },
));

check('missing flashinfer CUDA symlinks fail BY NAME, with what they cost', () => onPlatform(
  { stack: 'sglang-omni', platform: 'win32', wslHiggs: true, probe: SGL_NO_CUDA_LINKS },
  async () => {
      const res = await doctorMod.higgsDoctor();
      assert.strictEqual(res.valid, false, 'an env without the CUDA links passed the doctor');
      const row = res.checks.find((c) => c.id === 'cuda-links');
      assert.ok(row, 'no cuda-links row at all');
      assert.strictEqual(row.ok, false);
      assert.match(row.detail, /lib64/, 'the row does not name the first symlink');
      assert.match(row.detail, /libcudart\.so/, 'the row does not name the second');
      assert.match(row.detail, /installer/i, 'the row does not name the remedy');
  },
));

check('a stale sglang launcher is launcher-stale, not ok', () => onPlatform(
  {
    stack: 'sglang-omni',
    platform: 'win32',
    wslHiggs: true,
    probe: {
      stdout: SGL_GREEN.stdout.replace(
        `launcher-sha=${toolPaths.higgsExpectations('sglang-omni').launcherSha}`,
        'launcher-sha=' + '0'.repeat(64)),
      exit: 'close',
    },
  },
  async () => {
      const res = await doctorMod.higgsDoctor();
      assert.strictEqual(res.valid, false, 'a stale launcher passed the doctor');
      const row = res.checks.find((c) => c.id === 'launcher-sha');
      assert.match(row.detail, /launcher-stale/);
      assert.match(row.detail, new RegExp(toolPaths.HIGGS_SGL_LAUNCH_SCRIPT));
  },
));

check(`the SHIPPED stack (${SHIPPED_STACK}) is the one the doctor examines`, () => onPlatform(
  // NO `stack` FIXTURE: this row is the one that reads the catalog, because it is
  // the one about what the app will actually report. Everything above is about a
  // stack; this is about the decision.
  {
    platform: 'win32',
    wslHiggs: true,
    probe: SHIPPED_STACK === 'sglang-omni' ? SGL_GREEN : WSL_GREEN,
  },
  async () => {
    const res = await doctorMod.higgsDoctor();
    const script = lastSpawn.args.join(' ');
    const sgl = SHIPPED_STACK === 'sglang-omni';
    // The serving package, the patch rows and the profile row all follow from the
    // one word — asserted here so a flip that broke the doctor could not hide
    // behind fixtures that pin the stack themselves.
    assert.match(script, sgl ? /import sglang_omni/ : /import vllm_omni/,
      `the shipped stack is ${SHIPPED_STACK} but the probe imports the other package`);
    assert.strictEqual(res.checks.some((c) => c.id === 'profile-sha'), !sgl,
      `profile-sha row present=${!sgl ? 'expected' : 'unexpected'} for ${SHIPPED_STACK}`);
    assert.strictEqual(res.checks.some((c) => c.id === 'cuda-links'), sgl,
      `cuda-links row present=${sgl ? 'expected' : 'unexpected'} for ${SHIPPED_STACK}`);
    assert.strictEqual(res.checks.some((c) => c.id === 'patch'), !sgl,
      `patch rows present=${!sgl ? 'expected' : 'unexpected'} for ${SHIPPED_STACK}`);
    assert.ok(res.checks.some((c) => c.id === (sgl ? 'sglang-omni' : 'vllm-omni')),
      `no ${SHIPPED_STACK} row at all`);
    assert.strictEqual(res.valid, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  },
));

check('narrator\'s imports are probed in NARRATOR\'s env, not the server\'s', () => onPlatform(
  // TWO ENVIRONMENTS THE MOMENT THE STACK IS FLIPPED, and they answer different
  // questions. The SERVER runs in whatever the launcher names (`sglomni`);
  // NARRATOR — the client that packs the book, POSTs the chunks and writes the
  // files — runs in `getWslHiggsCondaEnv()` (`higgs3`) on BOTH stacks, because
  // that is where `narrator-spawn.ts` puts every Higgs door. It is also the
  // configuration every night-3 measurement was taken in: the probe client ran
  // out of higgs3 against a server on 8200.
  //
  // Asking "can narrator import bs4" of the SERVER's env would report a green
  // doctor for a machine whose prep dies on `No module named 'bs4'` — which is
  // the exact failure this row was added for (Owen's first in-app Higgs prep).
  { stack: 'sglang-omni', platform: 'win32', wslHiggs: true, probe: SGL_GREEN },
  async () => {
    await doctorMod.higgsDoctor();
    const script = lastSpawn.args.join(' ');
    // The find_spec probe — and ONLY it — runs out of narrator's env.
    assert.strictEqual(envRunning(script, 'find_spec'), FAKE.higgsEnv,
      "the deps probe does not run in narrator's own env");
    // …and the serving-package probe runs out of the SERVER's.
    assert.strictEqual(envRunning(script, 'import sglang_omni'), FAKE_SGL_ENV,
      "the serving-package probe does not run in the server's env");
    // The two really are different directories on this stack — otherwise the row
    // above would be asserting a distinction that does not exist.
    assert.notStrictEqual(FAKE.higgsEnv, FAKE_SGL_ENV);
  },
));

check('on vllm-omni the two envs are ONE, so nothing changed there', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
  async () => {
    await doctorMod.higgsDoctor();
    const script = lastSpawn.args.join(' ');
    // Both probes name the same prefix — the split above is a property of the
    // SGLang stack, not a new indirection on this one.
    for (const marker of ['find_spec', 'import vllm_omni']) {
      assert.strictEqual(envRunning(script, marker), FAKE.higgsEnv,
        `${marker} does not run in ${FAKE.higgsEnv}`);
    }
  },
));

check('the two stacks are the SAME vocabulary in tool-paths and the catalog', () => {
  // `tool-paths.ts` mirrors `HiggsServingStack` rather than importing the
  // catalog (a malformed JSON file must not break WSL detection), so the two
  // copies are kept in step here — the same rule `HIGGS_PATCHES` is held to.
  const catalogStacks = [...higgsModels.HIGGS_SERVING_STACKS].sort();
  assert.deepStrictEqual(catalogStacks, ['sglang-omni', 'vllm-omni']);
  for (const stack of catalogStacks) {
    const expect = toolPaths.higgsExpectations(stack);
    assert.strictEqual(expect.stack, stack,
      `tool-paths does not know the stack ${stack}`);
    assert.ok(expect.launcherSha, `no launcher sha for ${stack}`);
  }
  // AND THE CATALOG'S OWN NAMES ARE THE FILES THAT SHIP. A launcher or installer
  // named in the catalog that is not in electron/scripts/higgs is a spawn that
  // fails inside the guest with "No such file", ~0 s of useful diagnosis.
  const sgl = higgsModels.higgsSglangFor(higgsModels.higgsServingSpec());
  for (const name of [sgl.launchScript, sgl.installScript]) {
    assert.ok(fs.existsSync(path.join(toolPaths.higgsScriptsDir(), name)),
      `the catalog names ${name}, which this build does not ship`);
  }
  assert.strictEqual(sgl.launchScript, toolPaths.HIGGS_SGL_LAUNCH_SCRIPT,
    'the catalog and tool-paths disagree about the SGLang launcher');
});

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
    { stack: 'vllm-omni', platform: 'win32', wslHiggs: false, probe: { stdout: '', exit: 'error' } },
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
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: false, probe: WSL_GREEN },
  async () => {
    const refusal = await spawnMod.higgsEnvironmentRefusal();
    assert.ok(refusal, 'Windows without the toggle was waved through');
    assert.match(refusal, /WSL2 for Higgs/);
  },
));

check('win32, everything green with the toggle on → null', () => onPlatform(
  { stack: 'vllm-omni', platform: 'win32', wslHiggs: true, probe: WSL_GREEN },
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

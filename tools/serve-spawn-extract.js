#!/usr/bin/env node
/**
 * Capture the spawn plan `orpheus-worker-pool.ts` builds for the Listen server,
 * for ONE arm, as canonical JSON.
 *
 *   node tools/serve-spawn-extract.js wsl|native-win|native-mac
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The narrator cut-over (E2A_REMOVAL_PLAN phase 2) changes four things about
 * this spawn — the script path becomes `-m narrator.serve`, `EBOOK2AUDIOBOOK_PATH`
 * goes, `PYTHONPATH` and `NARRATOR_ENGINE` arrive — and must change NOTHING else.
 * PORT_NOTES section 9.4 lists 33 environment variables that keep their name,
 * value, default and precedence. "Nothing else changed" is not a claim a reading
 * can settle; it is a diff between two captures of the real function.
 *
 * So: `tools/snapshots/serve-spawn-base.json` is this extractor's output from the
 * commit BEFORE the cut-over, and `tools/test-serve-spawn-env.js` re-runs it after
 * and asserts the diff is exactly those four edits.
 *
 * ── Why a child process per arm ─────────────────────────────────────────────
 *
 * `streamBatchCeiling()` memoises, and its answer depends on `process.platform`.
 * Capturing win32 and darwin in one process would hand the second arm the first
 * arm's cached ceiling — a snapshot that is wrong in a way nobody would notice.
 * One process per arm, so every capture starts from a cold module.
 *
 * ── Why the environment is stubbed ──────────────────────────────────────────
 *
 * Every machine-specific input (the e2a root, the WSL conda path, the resolved
 * python) is replaced with a fixed constant, and `buildCondaSpawnEnv` — which
 * spreads `process.env` and prepends PATH entries — is replaced by identity. What
 * survives is exactly what the POOL contributes to the spawn, which is the thing
 * under test. The machine's own PATH is not.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

/** The fixture's userData. A real directory, because the darwin Higgs row
 *  reports whether the weights dir BookForge names actually exists. */
const FAKE_USER_DATA = path.join(REPO, '.fake-userdata');

const ARM = process.argv[2];
if (!['wsl', 'native-win', 'native-mac'].includes(ARM)) {
  console.error('usage: serve-spawn-extract.js wsl|native-win|native-mac [orpheus|higgs]');
  // The whole capture goes to a pipe; see narrator-argv-extract.js.
  process.exitCode = 64;
  return;
}

/**
 * WHICH ENGINE the Listen server is being started for.
 *
 * The pool serves both: it speaks narrator's JSON-lines protocol and the engine on
 * the other end is `NARRATOR_ENGINE` in the spawn. Orpheus is the default so the
 * pre-cut-over baseline (which predates Higgs entirely) still compares against the
 * rows it was written from.
 */
const ENGINE = process.argv[3] || 'orpheus';
if (!['orpheus', 'higgs'].includes(ENGINE)) {
  console.error('usage: serve-spawn-extract.js <arm> [orpheus|higgs]');
  process.exitCode = 64;
  return;
}

// stdout is the capture and nothing else. The modules under test log their path
// resolution on load, so their chatter is redirected rather than silenced — it is
// still readable on stderr when a capture surprises someone.
console.log = (...a) => console.error(...a);

// A fixed gpu_memory_utilization, so the ORPHEUS_GPU_MEM_UTIL export is present
// in the capture (its absence is the other branch and is not what changed).
const GPU_UTIL = 0.62;

// NOTE: these are shaped by the HOST platform, not by ARM — `native-mac` forces
// `process.platform` so the darwin BRANCH runs (the two MLX exports), but its
// paths stay host-shaped so the capture is byte-identical on any machine that
// runs it. What the mac row proves is which variables that branch adds, not what
// a real Mac's path separators look like.
const FAKE = {
  // FIXED LITERALS, NEVER `process.platform`. These two used to branch on the real
  // host - and worse, they are evaluated at module scope, BEFORE the arm's platform
  // is forced below, so they read the machine whichever fixture was asked for. A Mac
  // host therefore captured `/fake/e2a/python_env/bin/python` where the baseline
  // holds `C:/FAKE/e2a/python_env/python.exe`, and the keeper reported
  // "native-win's interpreter changed" on a tree where nothing had.
  //
  // A fixture's shape is not supposed to be the host's. Windows-shaped throughout
  // (canon() normalises the separators), so every machine captures the same bytes.
  e2a: 'C:\\FAKE\\e2a',
  wslE2a: '/home/fake/ebook2audiobook',
  wslConda: '/home/fake/anaconda3/bin/conda',
  orpheusEnv: 'orpheus_tts',
  distro: 'Ubuntu',
  python: 'C:\\FAKE\\e2a\\python_env\\python.exe',
  // The macOS arm resolves its own env rather than going through
  // getPythonInvocation, so it needs its own two fakes. Their APPEARANCE in a
  // capture is the point: it is how the mac row shows that Orpheus moved off the
  // ebook2audiobook env and onto narrator-mlx.
  conda: '/fake/miniconda/bin/conda',
  mlxEnv: '/opt/homebrew/Caskroom/miniconda/base/envs/narrator-mlx',
};

// `electron` is not require-able here. `app.getAppPath()` must answer the repo,
// because that is where BOTH the old script (electron/scripts/orpheus_stream.py)
// and the new package (python/narrator) are found.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => FAKE_USER_DATA, isPackaged: false },
    BrowserWindow: class {},
  },
};

// Force the platform BEFORE any module reads it.
// THE ARM IS THE FIXTURE'S, NOT THE HOST'S. Only the mac arm forced this, so on a
// macOS host the 'wsl' and 'native-win' fixtures resolved through the darwin branch
// and every row came back as the Mac conda invocation — a capture that compares
// equal to itself while describing an arm it never built. One process per arm (see
// the header), so nothing is restored and nothing leaks.
Object.defineProperty(process, 'platform', {
  value: ARM === 'native-mac' ? 'darwin' : 'win32',
  configurable: true,
});

const paths = require(path.join(DIST, 'e2a-paths.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));
const memory = require(path.join(DIST, 'orpheus-memory.js'));

/**
 * Replace one export.
 *
 * `export { x } from './y'` compiles to a NON-configurable getter, so plain
 * assignment throws and defineProperty is refused. Those names are stubbed on the
 * module they really come from (tool-paths), which the getter forwards to.
 */
function stub(mod, name, fn) {
  const d = Object.getOwnPropertyDescriptor(mod, name);
  if (d && !d.set && !d.writable && !d.configurable) {
    throw new Error(`${name} is a sealed re-export — stub it on the module that owns it`);
  }
  if (d && d.get) Object.defineProperty(mod, name, { value: fn, configurable: true, enumerable: true });
  else mod[name] = fn;
}

// Owned by tool-paths, re-exported (sealed) by e2a-paths.
stub(toolPaths, 'shouldUseWsl2ForOrpheus', () => ARM === 'wsl');
stub(toolPaths, 'shouldUseWsl2ForHiggs', () => ARM === 'wsl');
stub(toolPaths, 'getWslE2aPath', () => FAKE.wslE2a);
stub(toolPaths, 'getWslCondaPath', () => FAKE.wslConda);
stub(toolPaths, 'getWslOrpheusCondaEnv', () => FAKE.orpheusEnv);
stub(toolPaths, 'getWslDistro', () => FAKE.distro);

// Owned by e2a-paths.
stub(paths, 'getDefaultE2aPath', () => FAKE.e2a);
// ORPHEUS ONLY. The Orpheus component env is not installed on every dev machine,
// so its native arms need a stand-in interpreter to have anything to capture.
// HIGGS MUST NOT BE STUBBED: its native arms are supposed to REFUSE (no Windows
// build without the WSL toggle; no macOS build at all), and stubbing the resolver
// would walk straight past the refusal and record a spawn that cannot happen.
if (ENGINE === 'orpheus') {
  stub(paths, 'getPythonInvocation', () => ({ command: FAKE.python, args: [] }));
}
// Identity: the capture is the pool's OWN contribution, not the machine's env.
stub(paths, 'buildCondaSpawnEnv', (extra) => ({ ...extra }));
// Only reached on the macOS arm, and only AFTER the cut-over — the pre-cut-over
// code has no narrator-mlx concept at all. Stubbing them is what lets a Windows
// machine capture the mac row; on a real Mac these resolve or refuse by name.
if (typeof paths.getNarratorMlxEnv === 'function') {
  stub(paths, 'getNarratorMlxEnv', () => FAKE.mlxEnv);
  stub(paths, 'getCondaPath', () => FAKE.conda);
}

// Fixed memory profile so the darwin arm's MLX exports and the batch ceiling are
// the same on every machine that runs this.
stub(memory, 'orpheusMemoryProfile', () => ({
  ceiling: 0.9, capMB: 8192, marginMB: 1024, batchSize: 16,
  mlxCacheLimitGB: 8, mlxMemBudgetGB: 24,
}));
stub(memory, 'resolveConcreteOrpheusTier', () => 'balanced');
stub(memory, 'fitOrpheusTier', (t) => ({ tier: t, steppedDown: false }));

// WHICH VOICE the document is written for. The catalog is a per-machine fact - an
// artifact is installed or it is not - so the capture is pinned to the REAL
// `default` entry (the zero-shot served voice, present in every build) rather than
// to a hand-built fake. A fake would also be REFUSED, and rightly:
// `higgsServingFor` checks a voice's engineVersion against the catalog's serving
// block, which is exactly the kind of guard a fixture must not be allowed to walk
// past.
if (ENGINE === 'higgs') {
  const higgsModels = require(path.join(DIST, 'higgs-models.js'));
  const DEFAULT_MODEL = higgsModels.resolveHiggsModel('default');
  stub(higgsModels, 'listRenderableHiggsModels', () => [DEFAULT_MODEL]);
  stub(toolPaths, 'getWslHiggsCondaEnv', () => 'higgs3');
  // A PROVISIONED MAC, as far as the weights go. The darwin backend loads from
  // whatever `NARRATOR_HIGGS3_MLX_MODEL` names and refuses when it is unset, so the
  // row is worth little unless the directory BookForge names is real - and "is it
  // real" is only a question worth asking against a userData that has been set up.
  //
  // What that proves is the PATH DERIVATION (userData/runtime/higgs-models/base),
  // not that a real Mac has 8.5 GB of weights sitting there; installing them is
  // Phase 6's job.
  fs.mkdirSync(path.join(FAKE_USER_DATA, 'runtime', 'higgs-models', 'base'), { recursive: true });
}

const pool = require(path.join(DIST, 'orpheus-worker-pool.js'));
if (ENGINE === 'higgs') pool.setServeEngineProbe(() => 'higgs');

/**
 * A REFUSAL IS A CAPTURE, not a crash.
 *
 * Higgs on macOS has no backend — v3 ships a vLLM-Omni server and there is no
 * macOS build — so `buildSpawnPlan` refuses BY NAME there. That refusal is the
 * behaviour under test on that row, and a snapshot that recorded it as a stack
 * trace (or, worse, as a missing row) would let it change without anyone noticing.
 * The message is normalised through canon() like everything else.
 */
function captureRefusal(err) {
  process.stdout.write(JSON.stringify({
    arm: ARM, engine: ENGINE, refused: canon(err instanceof Error ? err.message : String(err)),
  }, null, 2) + '\n');
  // NOT a hard exit call: the whole capture has just gone to a PIPE, and an
  // undrained tail here is a refusal message the keeper reads as truncated JSON.
  // The caller returns instead, so the event loop drains it. (tools/test-cli-exit-
  // drain.js enforces this across cli/ and tools/.)
  process.exitCode = 0;
}

/**
 * The whole capture, so an early return is possible.
 *
 * Module top level has no `return`, and the refusal path must stop the rest of the
 * file from running — it used to do that with a hard exit call, which is exactly
 * what loses a piped tail.
 */
function canon(s) {
  if (typeof s !== 'string') return s;
  const win = REPO.replace(/\\/g, '\\\\');
  // The OS temp dir is as much the host's as the repo path is: the Higgs voice
  // document is written there, and `C:/Users/<name>/AppData/Local/Temp` and
  // `/var/folders/xx/...` are the same fact about two machines.
  const tmp = require('os').tmpdir();
  s = s
    .split(tmp).join('<TMP>')
    .split(tmp.replace(/\\/g, '/')).join('<TMP>')
    .split(wslish(tmp)).join('<TMP>');
  return s
    .split(REPO).join('<REPO>')
    .split(REPO.replace(/\\/g, '/')).join('<REPO>')
    .split(wslish(REPO)).join('<REPO>')
    .split(win).join('<REPO>')
    // Finally the separator itself, which is the host's and not the fixture's.
    .replace(/\\/g, '/');
}
function wslish(p) {
  const m = p.replace(/\\/g, '/').match(/^([A-Za-z]):(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}${m[2]}` : p;
}

/**
 * The WSL arm's payload is one bash string. Comparing it whole would report a
 * reordered export as "everything changed", so it is split into the three parts
 * the plan actually builds: the exported variables, the cd, and the command.
 */
function splitBash(bash) {
  const m = bash.match(/^export ([\s\S]*?) && (cd [\s\S]*?) && ([\s\S]*)$/);
  if (!m) return { raw: bash };
  const exportsMap = {};
  // K=V pairs, V either single-quoted or bare.
  const re = /([A-Za-z_][A-Za-z0-9_]*)=('(?:[^']|'\\'')*'|[^\s]*)/g;
  let hit;
  while ((hit = re.exec(m[1]))) {
    let v = hit[2];
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
    exportsMap[hit[1]] = canon(v);
  }
  return { exports: exportsMap, cd: canon(m[2]), run: canon(m[3]) };
}

// `command` is canon'd like everything else — it is a host path (a conda exe, a
// relocatable python) and an un-normalised one is the separator difference again.

function main() {
  // The signature is the detector for which side of the cut-over this is:
  // `resolveScriptPath` exists only while a script file is being spawned.
  let plan;
  try {
    plan = pool.resolveScriptPath
      ? pool.buildSpawnPlan(pool.resolveScriptPath(), GPU_UTIL)
      : pool.buildSpawnPlan(GPU_UTIL);
  } catch (err) {
    captureRefusal(err);
    return;
  }

/** Replace this checkout's location with a stable token, in both filesystems. */
/**
 * This checkout's location → one token, separators normalised.
 *
 * HOST-INDEPENDENT ON PURPOSE, and the reason is that `path.join` uses the HOST's
 * separator: faking `process.platform` does not change it, because the path module
 * binds win32/posix at load. So `narratorPythonRoot()` yields `<REPO>\python` on
 * Windows and `<REPO>/python` on a Mac, and an un-normalised capture can never
 * agree across the two. `<REPO-WSL>` collapses into `<REPO>` for the same reason:
 * on a Mac host the repo has no drive letter to translate.
 */
const out = { arm: ARM, engine: ENGINE, command: canon(plan.command), viaWsl: !!plan.viaWsl };
if (plan.viaWsl) {
  const bash = plan.args[plan.args.length - 1];
  out.args = plan.args.slice(0, -1).map(canon);
  out.bash = splitBash(bash);
  // process.env is INHERITED by wsl.exe and crosses no boundary (WSLENV is not
  // set), so it is not part of what this arm sends the worker.
  out.env = '(inherited process.env — nothing crosses into the guest)';
  out.cwd = '(process.cwd)';
} else {
  out.args = plan.args.map(canon);
  // Reported from the REAL path, before canon() turns it into a token: the
  // keeper's question is whether the directory BookForge named is there.
  if (plan.env.NARRATOR_HIGGS3_MLX_MODEL) {
    out.mlxModelDirExists = fs.existsSync(plan.env.NARRATOR_HIGGS3_MLX_MODEL);
  }
  out.env = Object.fromEntries(
    Object.entries(plan.env).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]),
  );
  out.cwd = canon(plan.cwd);
}

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();

#!/usr/bin/env node
/**
 * test-crucible-uninstall.js — taking a Crucible off THIS computer, and
 * refusing to take one off anybody else's.
 *
 * Drives the COMPILED `dist/electron/crucible/uninstall.js` (build first:
 * `npx tsc -p tsconfig.electron.json`) over a SCRIPTED runner — a fake
 * filesystem and a fake `crucible` that prints a `--json` document. Nothing
 * here spawns a process, reads a real config, deletes a byte or touches WSL.
 *
 * ── WHAT IT PINS, AND WHY EACH ONE IS WORTH A TEST ──────────────────────────
 *
 * **LOCAL ONLY, AND REFUSED BY NAME OTHERWISE.** Ruling 2026-09-15, taken with
 * Foundry so both apps draw the same door: the uninstall door is drawn only
 * for a Crucible this app can prove is on this machine. `crucible uninstall`
 * deletes a service, a home directory and possibly tens of gigabytes of
 * weights, and a door that could reach the Mac Studio from a laptop is a door
 * that will. Anything else is `uninstall_not_local`.
 *
 * **THE WEIGHTS ARE KEPT BY DEFAULT, AND "KEPT" IS REPORTED.** `--purge-weights`
 * is a flag and never a default — Crucible's own rule — and a `keep` step is a
 * RESULT with a size on it, not the absence of one. A door that quietly purged,
 * or that said nothing about what it left, would cost somebody an evening of
 * re-downloading.
 *
 * **THE DRY RUN IS THE SAME PLAN THE REAL RUN PERFORMS.** That is the only
 * definition of a dry run that cannot drift, and it is why this app SHOWS the
 * dry run before it offers the button: what is on the screen is what will
 * happen.
 *
 * **NOTHING IS DEFAULTED WHEN THE DOCUMENT IS UNREADABLE.** A `--json` answer
 * missing `steps` is not an uninstall with no steps; it is a version skew, and
 * `uninstall_unreadable` says so instead of drawing an empty list that looks
 * like success. `bytes` absent is null and never 0 — a unit, a pid and a distro
 * are not paths and have no size.
 *
 * **AND A CLI THAT PREDATES THE VERB SAYS SO.** argparse answers "invalid
 * choice: 'uninstall'" on exit 2, which is a clear sentence about a parser and
 * a useless one about a machine. It is translated ONCE, into
 * `uninstall_not_available`.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 *
 * `crucible/uninstall.py`'s `Plan.to_dict()` / `Step.to_dict()` and the flags
 * its parser declares (`--dry-run`, `--purge-weights`, `--wsl-too`, `--json`),
 * read at 2026-09-15 while that side was being written.
 *
 * **AND THE REAL RUNNER SPAWNS A `.cmd` THE ONLY WAY NODE STILL ALLOWS.** The
 * injected runners above prove the LOGIC; section 7 proves the SPAWN. Node has
 * refused a `.cmd` or `.bat` target without a shell since the CVE-2024-27980
 * fix — it throws EINVAL before the process exists — and on Windows the CLI
 * that owns the engine is `%LOCALAPPDATA%\Crucible\host\crucible.cmd`.
 * Measured by Foundry on this same PC, on Electron 33's Node. So the real
 * runner is BookForge's (`electron/crucible/host-runner.ts`), and what is
 * pinned is the argv it builds, not a mock's.
 *
 * TODO(crucible): `docs/INSTALL-UNINSTALL.md` will own this contract and had
 * not landed when this was written. Check the shape below against it when it
 * does, and delete this note.
 *
 * Run:  node tools/test-crucible-uninstall.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'electron', 'crucible', 'uninstall.js');
if (!fs.existsSync(MODULE)) {
  console.error(`Missing ${path.relative(process.cwd(), MODULE)} — run: npx tsc -p tsconfig.electron.json`);
  process.exit(1);
}
const uninstall = require(MODULE);
const { CrucibleDiscoveryError } = require(path.join(REPO, 'dist', 'electron', 'crucible', 'discovery.js'));
const { CrucibleRegistryError } = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const hostRunner = require(path.join(REPO, 'dist', 'electron', 'crucible', 'host-runner.js'));

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

// ── The scripted world ───────────────────────────────────────────────────────
//
// `crucibleUninstallTarget` asks `discovery.ts` where the Crucible on this
// computer is, and the REGISTRY what address the named row holds. Both are
// supplied: nothing below reads anything real.
//
// Since Owen's ruling of 2026-09-15 the door's gate is those TWO ADDRESSES
// MATCHING, not a reserved name. `HERE_NAME` is an ordinary registry name;
// what makes the door open is that the registry says it is at the same URL
// discovery found here.

const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bf-cru-uninstall-'));
const MAC_HOME = path.join(TMP, 'dot-crucible');
fs.mkdirSync(MAC_HOME, { recursive: true });

/*
 * WHERE discovery.ts WOULD HAVE LOOKED, supplied rather than looked at. The
 * door takes both reads as parameters for exactly this reason: a test whose
 * answer depended on whether the machine running it happens to hold a
 * Crucible is a test that passes on the PC and fails on a laptop - and, worse,
 * would read the live WSL config on Owen's machine while asserting about a
 * fixture.
 */
const HERE_URL = 'http://127.0.0.1:7100';
/** An ORDINARY registry name. Nothing about the word opens this door. */
const HERE_NAME = '3090 Ti';

const LOCAL_HERE = () => ({
  name: 'crucible@example-pc-wsl',
  url: HERE_URL,
  token: 'tok',
  configPath: path.join(MAC_HOME, 'config.toml'),
  via: 'pairing',
});

/** The registry, scripted: `3090 Ti` is here, `mac` is somewhere else. */
const REGISTRY = (name) => {
  if (name === HERE_NAME) return HERE_URL;
  if (name === 'mac') return 'http://mac.example.test:7100';
  throw new CrucibleRegistryError('unknown_server', `no crucible server named "${name}"`);
};

const NO_LOCAL = () => {
  throw new CrucibleDiscoveryError(
    'no_local_config',
    'no Crucible on this computer: there is no pairing file and no config.toml here.',
  );
};

const HOST_CLI = 'C:\\Users\\t\\AppData\\Local\\Crucible\\host\\crucible.cmd';
const SERVER_CLI = '/relocated/crucible-runtime/python';
const CLI_ARGS = ['-m', 'crucible.cli'];
const INSTALL_HOME = '/Users/test/.crucible';
const INSTALL_CWD = '/relocated/crucible-source';
function installationFiles(platform, home, executable) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return { [executable]: 'runtime', [paths.join(home, 'installation.json')]: JSON.stringify({
    schema_version: 1, platform, home, release: 'test',
    control: { command: executable, args: [...CLI_ARGS, 'local'], cwd: platform === 'win32' ? 'C:\\relocated\\source' : INSTALL_CWD },
  }) };
}

/** The `--json` document `crucible uninstall --dry-run` prints, as it prints it. */
function doc(overrides) {
  return Object.assign({
    dry_run: true,
    home: MAC_HOME,
    platform: 'darwin',
    mechanism: 'launchd',
    backend_kind: 'mlx-darwin',
    purge_weights: false,
    wsl_too: false,
    removed_bytes: 0,
    ok: true,
    steps: [
      { name: 'service', what: 'stop and forget the launchd agent', action: 'stop', target: 'com.crucible.server', done: false },
      { name: 'home:server', what: 'remove the server pack', action: 'remove', target: `${MAC_HOME}/server`, bytes: 900000000, done: false },
      { name: 'weights:models', what: 'keep the text models', action: 'keep', target: `${MAC_HOME}/models`, bytes: 42000000000, done: false },
    ],
    kept: { weights_bytes: 42000000000, paths: [`${MAC_HOME}/models`] },
  }, overrides || {});
}

function runner(overrides) {
  const o = overrides || {};
  const files = o.files || installationFiles('darwin', INSTALL_HOME, SERVER_CLI);
  const calls = [];
  const answer = o.answer || (() => ({ code: 0, stdout: JSON.stringify(doc()), stderr: '', failure: null }));
  return {
    calls,
    platform: o.platform || 'darwin',
    env: o.env || {},
    homedir: '/Users/test',
    options: [],
    run: async function (argv, options) { calls.push(argv); this.options.push(options); return answer(argv); },
    stream: async function (argv, options) {
      calls.push(argv); this.options.push(options);
      if (options && options.onLine) options.onLine('removing …', 'stdout');
      return answer(argv);
    },
    fileExists: (file) => Object.prototype.hasOwnProperty.call(files, file),
    readFile: (file) => {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
      return files[file];
    },
    realpathNative: (file) => file,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Local only
// ─────────────────────────────────────────────────────────────────────────────

check('a row whose ADDRESS is another machine is refused by name, and nothing is spawned', () => {
  const r = runner();
  let caught = null;
  try { uninstall.crucibleUninstallTarget('mac', r, undefined, LOCAL_HERE, REGISTRY); } catch (err) { caught = err; }
  assert.ok(caught, 'the door let a REMOTE engine be uninstalled from this machine');
  assert.strictEqual(caught.code, 'uninstall_not_local');
  assert.ok(
    caught.message.startsWith('uninstall_not_local: '),
    `the code is not in the sentence: ${caught.message}`,
  );
  assert.deepStrictEqual(r.calls, [], 'something ran before the refusal');
});

checkAsync('and the RUN door refuses it too — not only the button', async () => {
  const r = runner();
  let caught = null;
  try {
    await uninstall.crucibleUninstall(
      'mac', { dryRun: true, purgeWeights: false, wslToo: false }, r, undefined, LOCAL_HERE, REGISTRY,
      REGISTRY);
  } catch (err) { caught = err; }
  assert.ok(caught, 'a disabled control over an open door is a decoration');
  assert.strictEqual(caught.code, 'uninstall_not_local');
  assert.deepStrictEqual(r.calls, []);
});

check('no Crucible on this machine at all is uninstall_not_local, with the reason', () => {
  let caught = null;
  try { uninstall.crucibleUninstallTarget(HERE_NAME, runner(), undefined, NO_LOCAL, REGISTRY); } catch (err) { caught = err; }
  assert.ok(caught, 'a machine with no engine was offered an uninstall');
  assert.strictEqual(caught.code, 'uninstall_not_local');
  assert.ok(caught.detail, 'the refusal does not carry what discovery.ts actually said');
  assert.ok(
    caught.detail.includes('no_local_config'),
    `discovery.ts's own reason was replaced rather than carried: ${caught.detail}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Which CLI owns the engine on this machine
// ─────────────────────────────────────────────────────────────────────────────

check('darwin/linux: the runtime and cwd from the installed lifecycle record', () => {
  const target = uninstall.crucibleUninstallTarget(HERE_NAME, runner(), undefined, LOCAL_HERE, REGISTRY);
  assert.strictEqual(target.kind, 'native');
  assert.deepStrictEqual(target.argv, [SERVER_CLI, ...CLI_ARGS]);
  assert.deepStrictEqual(target.env, { CRUCIBLE_HOME: INSTALL_HOME });
  assert.strictEqual(target.cwd, INSTALL_CWD);
});

check('a config with no installed lifecycle record is uninstall_not_available', () => {
  // That is what a Crucible installed some other way looks like, and it is not
  // something this app can take apart: it says so rather than guessing a path.
  let caught = null;
  try { uninstall.crucibleUninstallTarget(HERE_NAME, runner({ files: {} }), undefined, LOCAL_HERE, REGISTRY); } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(caught.code, 'uninstall_not_available');
});

check('win32 uses the registered local runtime without guessing a pack layout', () => {
  const target = uninstall.crucibleUninstallTarget(HERE_NAME, runner({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
    files: installationFiles('win32', 'C:\\Users\\t\\AppData\\Local\\Crucible', 'C:\\relocated\\python.exe'),
  }), undefined, LOCAL_HERE, REGISTRY);
  assert.strictEqual(target.kind, 'host');
  assert.deepStrictEqual(target.argv, ['C:\\relocated\\python.exe', ...CLI_ARGS]);
  assert.strictEqual(target.cwd, 'C:\\relocated\\source');
});

check('win32 with no LOCALAPPDATA is refused, never assembled from a username', () => {
  let caught = null;
  try {
    uninstall.crucibleUninstallTarget(
      HERE_NAME, runner({ platform: 'win32', env: {}, files: {} }), undefined, LOCAL_HERE, REGISTRY);
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(caught.code, 'uninstall_no_localappdata');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The flags, which are Crucible's
// ─────────────────────────────────────────────────────────────────────────────

const NATIVE_TARGET = { kind: 'native', argv: [SERVER_CLI], describe: SERVER_CLI, via: 'pairing' };
const HOST_TARGET = { kind: 'host', argv: [HOST_CLI], describe: HOST_CLI, via: 'pairing' };

check('the dry run and the real run differ by exactly one flag', () => {
  const dry = uninstall.uninstallArgv(NATIVE_TARGET, { dryRun: true, purgeWeights: false, wslToo: false });
  const real = uninstall.uninstallArgv(NATIVE_TARGET, { dryRun: false, purgeWeights: false, wslToo: false });
  assert.deepStrictEqual(dry, [SERVER_CLI, 'uninstall', '--json', '--dry-run']);
  assert.deepStrictEqual(real, [SERVER_CLI, 'uninstall', '--json']);
});

check('the weights are KEPT unless --purge-weights is asked for', () => {
  const kept = uninstall.uninstallArgv(NATIVE_TARGET, { dryRun: true, purgeWeights: false, wslToo: false });
  assert.ok(!kept.includes('--purge-weights'), 'the door purges by default — tens of gigabytes, silently');
  const purged = uninstall.uninstallArgv(NATIVE_TARGET, { dryRun: true, purgeWeights: true, wslToo: false });
  assert.ok(purged.includes('--purge-weights'));
});

check('--wsl-too is a HOST flag, and asking for it anywhere else is refused by name', () => {
  const host = uninstall.uninstallArgv(HOST_TARGET, { dryRun: true, purgeWeights: false, wslToo: true });
  assert.ok(host.includes('--wsl-too'));
  let caught = null;
  try {
    uninstall.uninstallArgv(NATIVE_TARGET, { dryRun: true, purgeWeights: false, wslToo: true });
  } catch (err) { caught = err; }
  assert.ok(caught, 'a flag that means nothing here was silently dropped — a choice that did not happen');
  assert.strictEqual(caught.code, 'uninstall_wsl_too_needs_host');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The document, read field by field
// ─────────────────────────────────────────────────────────────────────────────

checkAsync('the dry run answers the CLI\'s plan, with `kept` on it', async () => {
  const r = runner();
  const plan = await uninstall.crucibleUninstall(
    HERE_NAME, { dryRun: true, purgeWeights: false, wslToo: false }, r, undefined, LOCAL_HERE, REGISTRY,
  );
  assert.deepStrictEqual(r.calls, [[SERVER_CLI, ...CLI_ARGS, 'uninstall', '--json', '--dry-run']]);
  assert.deepStrictEqual(r.options[0].env, { CRUCIBLE_HOME: INSTALL_HOME });
  assert.strictEqual(r.options[0].cwd, INSTALL_CWD);
  assert.strictEqual(plan.dryRun, true);
  assert.strictEqual(plan.mechanism, 'launchd');
  assert.strictEqual(plan.backendKind, 'mlx-darwin');
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.keptWeightsBytes, 42000000000);
  assert.deepStrictEqual(plan.keptPaths, [`${MAC_HOME}/models`]);
  assert.strictEqual(plan.ranThrough, SERVER_CLI);
  assert.strictEqual(plan.through, 'native');
});

checkAsync('`keep` is a RESULT with a size, not the absence of a step', async () => {
  const plan = await uninstall.crucibleUninstall(
    HERE_NAME, { dryRun: true, purgeWeights: false, wslToo: false }, runner(), undefined, LOCAL_HERE, REGISTRY,
  );
  const keep = plan.steps.find((s) => s.action === 'keep');
  assert.ok(keep, 'the kept weights are not a step, so the screen cannot say what it is keeping');
  assert.strictEqual(keep.bytes, 42000000000);
  assert.strictEqual(keep.done, false, 'a dry run performed a step');
});

checkAsync('a step whose target is not a path has bytes NULL, never 0', async () => {
  const plan = await uninstall.crucibleUninstall(
    HERE_NAME, { dryRun: true, purgeWeights: false, wslToo: false }, runner(), undefined, LOCAL_HERE, REGISTRY,
  );
  const service = plan.steps.find((s) => s.name === 'service');
  assert.strictEqual(
    service.bytes, null,
    'a unit, a pid and a distro are not paths. "0 B" is a measurement nobody made.',
  );
});

checkAsync('the real run streams its lines and reports what was freed', async () => {
  const lines = [];
  const r = runner({
    answer: () => ({
      code: 0,
      stdout: JSON.stringify(doc({
        dry_run: false,
        removed_bytes: 900000000,
        steps: [
          { name: 'home:server', what: 'remove the server pack', action: 'remove', target: `${MAC_HOME}/server`, bytes: 900000000, done: true },
          { name: 'weights:models', what: 'keep the text models', action: 'keep', target: `${MAC_HOME}/models`, bytes: 42000000000, done: false },
        ],
      })),
      stderr: '',
      failure: null,
    }),
  });
  const plan = await uninstall.crucibleUninstall(
    HERE_NAME, { dryRun: false, purgeWeights: false, wslToo: false }, r,
    (text) => lines.push(text), LOCAL_HERE, REGISTRY,
  );
  assert.deepStrictEqual(r.calls, [[SERVER_CLI, ...CLI_ARGS, 'uninstall', '--json']]);
  assert.deepStrictEqual(lines, ['removing …']);
  assert.strictEqual(plan.dryRun, false);
  assert.strictEqual(plan.removedBytes, 900000000);
  assert.strictEqual(plan.steps[0].done, true);
});

checkAsync('a fatal step is carried through with `ok: false` and its own words', async () => {
  const r = runner({
    answer: () => ({
      code: 1,
      stdout: JSON.stringify(doc({
        ok: false,
        steps: [{
          name: 'service',
          what: 'stop and forget the launchd agent',
          action: 'stop',
          target: 'com.crucible.server',
          done: false,
          refused: { code: 'service_busy', message: 'launchctl would not unload it', fatal: true },
        }],
      })),
      stderr: '',
      failure: null,
    }),
  });
  const plan = await uninstall.crucibleUninstall(
    HERE_NAME, { dryRun: false, purgeWeights: false, wslToo: false }, r, undefined, LOCAL_HERE, REGISTRY,
  );
  // A non-zero exit is NOT read as "no answer": the CLI prints its plan even
  // when a step refused, and the refusal is the useful half.
  assert.strictEqual(plan.ok, false);
  assert.strictEqual(plan.steps[0].refused.code, 'service_busy');
  assert.strictEqual(plan.steps[0].refused.fatal, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Version skew and unreadable answers
// ─────────────────────────────────────────────────────────────────────────────

checkAsync('a CLI that predates the verb is uninstall_not_available, not a crash', async () => {
  const r = runner({
    answer: () => ({
      code: 2,
      stdout: '',
      stderr: "crucible: error: argument command: invalid choice: 'uninstall' (choose from 'init', 'serve')",
      failure: null,
    }),
  });
  let caught = null;
  try {
    await uninstall.crucibleUninstall(
      HERE_NAME, { dryRun: true, purgeWeights: false, wslToo: false }, r, undefined, LOCAL_HERE, REGISTRY);
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(caught.code, 'uninstall_not_available');
  assert.ok(caught.detail && caught.detail.includes('invalid choice'), 'argparse\'s own words were thrown away');
});

checkAsync('an answer that is not the document is uninstall_unreadable, never an empty plan', async () => {
  const r = runner({ answer: () => ({ code: 0, stdout: 'Removed 3 things.\n', stderr: '', failure: null }) });
  let caught = null;
  try {
    await uninstall.crucibleUninstall(
      HERE_NAME, { dryRun: true, purgeWeights: false, wslToo: false }, r, undefined, LOCAL_HERE, REGISTRY);
  } catch (err) { caught = err; }
  assert.ok(caught, 'a plain-text answer was read as an uninstall with no steps');
  assert.strictEqual(caught.code, 'uninstall_unreadable');
});

check('a document missing a field is refused, not defaulted', () => {
  const target = NATIVE_TARGET;
  for (const missing of ['steps', 'kept', 'dry_run', 'home', 'purge_weights', 'ok']) {
    const partial = doc();
    delete partial[missing];
    let caught = null;
    try { uninstall.readUninstallPlan(partial, target); } catch (err) { caught = err; }
    assert.ok(caught, `a document with no \`${missing}\` was read anyway`);
    assert.strictEqual(caught.code, 'uninstall_unreadable', missing);
  }
});

check('a STEP missing a field is refused too, naming its index', () => {
  const partial = doc();
  delete partial.steps[1].action;
  let caught = null;
  try { uninstall.readUninstallPlan(partial, NATIVE_TARGET); } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(caught.code, 'uninstall_unreadable');
  assert.ok(caught.message.includes('step 1'), `the sentence does not say which step: ${caught.message}`);
});

checkAsync('a CLI that could not be spawned at all is uninstall_unrun', async () => {
  const r = runner({
    answer: () => ({ code: null, stdout: '', stderr: '', failure: 'spawn ENOENT' }),
  });
  let caught = null;
  try {
    await uninstall.crucibleUninstall(
      HERE_NAME, { dryRun: true, purgeWeights: false, wslToo: false }, r, undefined, LOCAL_HERE, REGISTRY);
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(caught.code, 'uninstall_unrun');
});

check('anything unnamed is uninstall_failed, in the error\'s own words', () => {
  const out = uninstall.uninstallRefusalOf(new RangeError('index out of range'));
  assert.strictEqual(out.code, 'uninstall_failed');
  assert.ok(out.message.includes('index out of range'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The door is drawn where the ruling says, and nowhere else
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 7. The REAL runner, which is the one that meets a .cmd
// ─────────────────────────────────────────────────────────────────────────────

check('a .cmd target goes through cmd.exe /d /s /c, with every token quoted', () => {
  const plan = hostRunner.crucibleSpawnPlan([HOST_CLI, 'uninstall', '--json', '--dry-run'], 'win32');
  assert.strictEqual(
    plan.program, 'cmd.exe',
    'the host CLI is spawned directly. Node throws EINVAL on a .cmd with no shell since the '
    + 'CVE-2024-27980 fix, so the first real press would have failed with nothing on screen '
    + 'about batch files.',
  );
  assert.deepStrictEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'],
    '/d skips AutoRun (whose output would land in the JSON this app parses) and /s makes the '
    + "quoting ONE rule rather than cmd's legacy heuristics");
  // The whole line in an OUTER pair, every token in its own INNER pair: after
  // /s strips the outer two, cmd sees a quoted program and quoted arguments,
  // and no token can be re-split on a space or read as an operator.
  assert.strictEqual(
    plan.args[3],
    `""${HOST_CLI}" "uninstall" "--json" "--dry-run""`,
    `the line is not the outer/inner quoted form: ${plan.args[3]}`,
  );
  assert.strictEqual(
    plan.verbatim, true,
    'libuv would escape the quotes this line is MADE of, and cmd.exe would receive literal '
    + 'backslash-quote pairs',
  );
});

check('a .bat target too, and a NON-.cmd target is left exactly alone', () => {
  const bat = hostRunner.crucibleSpawnPlan(['C:\\x\\crucible.BAT', 'uninstall'], 'win32');
  assert.strictEqual(bat.program, 'cmd.exe', 'the extension test is case-sensitive');

  // THE FIX IS FOR ONE TARGET, not a new spawn policy for every target.
  // wsl.exe, a guest binary and a Mac's console script keep the package's own
  // spawn, which is what its WSL UTF-16 handling and its refusals are written
  // against.
  for (const [argv, platform] of [
    [['wsl.exe', '-d', 'crucible', '--exec', '/home/t/.crucible/server/bin/crucible', 'uninstall'], 'win32'],
    [[SERVER_CLI, 'uninstall', '--json'], 'darwin'],
    [[SERVER_CLI, 'uninstall', '--json'], 'linux'],
    // A .cmd on a Mac is a file with an odd name, not a batch script.
    [['/opt/weird.cmd', 'uninstall'], 'darwin'],
  ]) {
    const plan = hostRunner.crucibleSpawnPlan(argv, platform);
    assert.strictEqual(plan.program, argv[0], `${platform}: ${argv[0]} was rewritten`);
    assert.deepStrictEqual(plan.args, argv.slice(1));
    assert.strictEqual(plan.verbatim, false);
    assert.ok(!plan.args.includes('/c'), `${platform}: a cmd.exe flag reached a non-cmd target`);
  }
});

check('a quote or a percent sign in the path is refused BY NAME, never escaped', () => {
  for (const bad of [
    'C:\\Users\\od"d\\AppData\\Local\\Crucible\\host\\crucible.cmd',
    'C:\\Users\\%USERNAME%\\AppData\\Local\\Crucible\\host\\crucible.cmd',
    // A line break MID-PATH. Deliberately not one appended after `.cmd`:
    // that string does not END in `.cmd`, so it is not a batch target at all
    // and never reaches the command processor — which is the extension test
    // doing its job, not the quoting rule doing its job.
    'C:\\Users\\t\\Cru\nible\\host\\crucible.cmd',
  ]) {
    let caught = null;
    try { hostRunner.crucibleSpawnPlan([bad, 'uninstall'], 'win32'); } catch (err) { caught = err; }
    assert.ok(caught, `a path this form cannot carry was escaped instead of refused: ${bad}`);
    assert.strictEqual(caught.code, 'uninstall_bad_path', bad);
    assert.ok(
      caught.message.startsWith('uninstall_bad_path: '),
      `the code is not in the sentence: ${caught.message}`,
    );
  }
  // A path with a SPACE is fine — that is what the quoting is for, and
  // refusing it would lock out every machine with a space in its user name.
  const spaced = 'C:\\Users\\Owen Morgan\\AppData\\Local\\Crucible\\host\\crucible.cmd';
  const plan = hostRunner.crucibleSpawnPlan([spaced, 'uninstall'], 'win32');
  assert.strictEqual(plan.args[3], `""${spaced}" "uninstall""`);
});

check('the uninstall doors in main.ts use the HARDENED runner, not the package\'s', () => {
  const main = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
  const doors = main.slice(main.indexOf("ipcMain.handle('crucible:host-uninstall-plan'"));
  const body = doors.slice(0, doors.indexOf('// ── THE OPERATOR DOOR'));
  const hardened = (body.match(/crucibleProcessRunner\(\)/g) || []).length;
  assert.strictEqual(hardened, 2, 'one of the two uninstall doors still builds its own runner');
  assert.ok(
    !/processRunner\(\)/.test(body.replace(/crucibleProcessRunner\(\)/g, '')),
    "an uninstall door still calls the package's processRunner(), which throws EINVAL on the "
    + "host's .cmd",
  );
});

check('the INSTALL door spawns no .cmd today, and shares the runner anyway', () => {
  // The native installer is invoked through PowerShell; runtime lifecycle
  // calls use the SDK's published executable. Neither spawns a .cmd directly.
  const install = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'install.ts'), 'utf-8');
  assert.ok(
    !/spawn\w*\([^)]*\.cmd/.test(install),
    'electron/crucible/install.ts spawns a .cmd directly',
  );
  const main = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
  assert.ok(
    /driveCrucibleInstall\(options, crucibleProcessRunner\(\)\)/.test(main),
    'the install door does not share the hardened runner — two runners that differ in a way '
    + 'nobody would notice until the package started spawning the host entry point',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The door
// ─────────────────────────────────────────────────────────────────────────────

check('the settings door exists, is this-machine-only, and says what it keeps', () => {
  const doors = fs.readFileSync(
    path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-doors.component.ts'),
    'utf-8',
  );
  assert.ok(
    doors.includes('Remove the engine from this computer'),
    'the uninstall door is not in Settings -> Crucible Servers',
  );
  // DRAWN ONLY WHEN THERE IS SOMETHING TO REMOVE, AND ONLY WHEN IT HAS A NAME.
  // A row on another machine never grows this button, and since the reserved
  // name went (ruling 2026-09-15) the door needs the engine here to be a
  // REGISTERED row, because the door names one.
  assert.ok(
    doors.includes('@if (registeredHere() !== null) {'),
    'the uninstall door is drawn without checking that there IS an engine here, registered',
  );
  assert.ok(
    /kept unless you say otherwise/.test(doors),
    'the door does not tell anybody the models are kept by default',
  );
  // THE DRY RUN IS SHOWN FIRST. `Remove it` only appears inside a block that
  // already has a plan on screen.
  assert.ok(doors.includes('Show me what would go'), 'there is no dry run before the real one');
});

check('changing a checkbox is CLEAR-ONLY — no automatic re-run (ruling, both apps)', () => {
  /*
   * THE RULING, 2026-09-15, taken with Foundry so the two apps behave the
   * same: ticking "also delete the models" or "also remove the WSL2 engine"
   * CLEARS the plan on screen and the person presses "Show me what would go"
   * again. It does NOT re-run the dry run for them.
   *
   * Two reasons. A dry run walks six weight directories measuring them, so a
   * checkbox that kicked one off makes a click feel like a hang. And a plan
   * that reappeared by itself, subtly different, under a live "Remove it"
   * button is the exact shape of somebody pressing Remove against numbers
   * they had not read.
   */
  const doors = fs.readFileSync(
    path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-doors.component.ts'),
    'utf-8',
  );
  const matches = doors.match(/\(change\)="[^"]*"/g) || [];
  const boxes = matches.filter((m) => /uninstallPlan/.test(m));
  assert.strictEqual(boxes.length, 2, 'the two uninstall checkboxes do not both act on the plan');
  for (const handler of boxes) {
    assert.strictEqual(
      handler, '(change)="uninstallPlan.set(null)"',
      `a checkbox does more than clear the plan: ${handler}. Clear-only is the ruling.`,
    );
  }
  // And "Remove it" is only reachable with a plan on screen.
  assert.ok(
    /@if \(uninstallPlan\(\); as u\) \{\s*@if \(u\.dryRun\) \{/.test(doors),
    'the Remove button is not gated behind a dry-run plan',
  );
});

check('the renderer reaches it through the two named channels and nothing else', () => {
  const service = fs.readFileSync(
    path.join(REPO, 'src', 'app', 'core', 'services', 'electron.service.ts'), 'utf-8');
  for (const method of ['uninstallPlan:', 'uninstall:', 'onUninstallProgress:']) {
    assert.ok(service.includes(method), `electron.service.ts has no ${method}`);
  }
  const preload = fs.readFileSync(path.join(REPO, 'electron', 'preload.ts'), 'utf-8');
  assert.ok(preload.includes("ipcRenderer.invoke('crucible:host-uninstall-plan'"), 'preload has no dry-run door');
  assert.ok(preload.includes("ipcRenderer.invoke('crucible:host-uninstall'"), 'preload has no uninstall door');
});

console.log(`\n${ran} checks; ${process.exitCode ? 'FAILURES' : 'all green'}`);

process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* a temp dir that stays is not a failure */ }
});

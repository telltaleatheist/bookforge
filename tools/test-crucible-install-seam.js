#!/usr/bin/env node
/**
 * test-crucible-install-seam.js — the install story: the installer is really
 * there, the plan is the sequence it will walk, and four doors say honest
 * things about this machine.
 *
 * Drives the COMPILED `dist/electron/crucible/install.js` (build first:
 * `npx tsc -p tsconfig.electron.json`) over a SCRIPTED host, so nothing here
 * spawns `wsl.exe`, reads `<userData>`, queries a driver or touches a guest.
 * Every branch of "what is on this machine" is driven from a fixture.
 *
 * ── WHAT IT PINS, AND WHY EACH ONE IS WORTH A TEST ──────────────────────────
 *
 * **THE PACKAGE IS REALLY IMPORTED, AND THE TYPES ARE REALLY ITS OWN.** The
 * seam this file used to guard — a hand-transcribed surface behind a
 * `DRIVEN_INSTALL_AVAILABLE = false` — is GONE (2026-09-15):
 * `vendor/crucible-bootstrap-0.6.0.tgz` is pinned in package.json and
 * `loadBootstrap()` does the real `await import`. What is guarded now is the
 * opposite failure: a button that goes live over an installer that is not
 * installed. So `loadBootstrap()` must RESOLVE, with a real `install`, and the
 * package's own `install.ps1` line must be the one the Windows door hands over.
 *
 * **WINDOWS INSTALLS ONE WAY AND IT IS THE HOST'S (PHASE15-HOST.md 4.3).** No
 * `%LOCALAPPDATA%\Crucible\host\` -> `host_not_installed` carrying
 * `hostInstallCommand()`; a host that IS there -> `POST /install` on 127.0.0.1:7101
 * and its events relayed. Driven here over a SCRIPTED runner and a SCRIPTED
 * host door, so nothing spawns, downloads, elevates or opens a socket. The
 * regression this catches is BookForge growing a second install sequence of
 * its own — PHASE14 4a: two descriptions of one install "cannot differ".
 *
 * **NO WHEEL, NO CONDA, NO COPYABLE SHELL SEQUENCE.** All three were correct
 * about a pre-PHASE14 install and are now wrong: the server arrives as an env
 * pack with its own interpreter. The plan's steps carry NO commands at all,
 * and the ONE line a person still types is Windows's install.ps1, which comes
 * from the package rather than from a string in this app.
 *
 * **THE FOUR DOORS' STATES.** Door 1 is the registry and is
 * `test-crucible-servers`'s. Doors 2, 3 and 4 are this file's: "there is a
 * config here" vs the NAMED state when there is not, "install one here" with a
 * verdict that always says why, and — new — "remove it from this computer",
 * which is `tools/test-crucible-uninstall.js`'s. `no_local_config` must NOT be
 * reported as a refusal — a machine that only renders on the Mac is not
 * broken — while an unreadable config must.
 *
 * **AND THE CARD NAMES THE MACHINE.** The small gap the page-reader work left:
 * `vlm:reader-status` answered only `wslRefusal`, so every card drew a local
 * route and said "this machine's GPU (WSL)" for a run about to go to a
 * Crucible. `resolveVlmRouteWithVenue` asks the same three questions
 * `planVlmConversion` asks, in the same order.
 *
 * Run:  node tools/test-crucible-install-seam.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const MODULE = path.join(DIST, 'electron', 'crucible', 'install.js');
const CONVERSION = path.join(DIST, 'shared', 'vlm', 'conversion.js');
for (const file of [MODULE, CONVERSION]) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(process.cwd(), file)} — run: npx tsc -p tsconfig.electron.json`);
    process.exit(1);
  }
}

const install = require(MODULE);
const conversion = require(CONVERSION);

let ran = 0;

/**
 * The package itself, for the checks that compare this app's answer to its.
 *
 * Imported through the SAME dynamic import the main process uses, so a
 * packaging change that breaks one breaks both rather than only the app.
 */
function import_bootstrap() {
  return import('@crucible/bootstrap');
}

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

// ── Scripted hosts ───────────────────────────────────────────────────────────
//
// Every fact `crucibleHostFacts` reads, supplied. A test that let ANY of these
// fall through to the real machine would pass on this PC and fail on the Mac,
// which is the property `discovery.ts` and `pages.ts` are written for too.

const WSL_TABLE = [
  '  NAME      STATE      VERSION',
  '* Ubuntu    Running    2',
  '  legacy    Stopped    1',
].join('\r\n');

const SMI = 'NVIDIA GeForce RTX 3090 Ti, 24564 MiB\n';

function host(overrides) {
  const base = {
    platform: 'win32',
    arch: 'x64',
    wslDistro: 'Ubuntu',
    listWsl: () => ({ status: 0, stdout: WSL_TABLE, stderr: '' }),
    queryGpu: () => ({ status: 0, stdout: SMI, stderr: '' }),
    discovered: () => ({
      present: false,
      code: 'no_local_config',
      reason: 'no local Crucible: ~/.crucible/config.toml does not exist inside WSL distro "Ubuntu".',
    }),
  };
  return Object.assign(base, overrides || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The installer is really there
// ─────────────────────────────────────────────────────────────────────────────

checkAsync('loadBootstrap RESOLVES — the package is vendored, not a seam', async () => {
  const bootstrap = await install.loadBootstrap();
  assert.strictEqual(
    typeof bootstrap.install, 'function',
    'loadBootstrap did not hand back an installer. @crucible/bootstrap is pinned in '
    + 'package.json to vendor/crucible-bootstrap-0.6.0.tgz; if that pin is gone this is a '
    + 'build that cannot install anything and the button must not be live over it.',
  );
});

check('the package is PINNED, and to a vendored tarball rather than a directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
  const pin = pkg.dependencies[install.BOOTSTRAP_PACKAGE];
  assert.ok(pin, `${install.BOOTSTRAP_PACKAGE} is not a dependency, and driveCrucibleInstall imports it`);
  // A `file:` DIRECTORY dependency makes node_modules/@crucible/bootstrap a
  // junction into the crucible checkout, and a later recursive delete of
  // node_modules follows it and deletes that repo's SDK source. The same rule
  // package.json already states for the client tarball.
  assert.match(pin, /^file:vendor\/crucible-bootstrap-.*\.tgz$/, `the pin is not a vendored tarball: ${pin}`);
  assert.ok(pin.includes(install.CRUCIBLE_RELEASE), `the pin is not the release this build names: ${pin}`);
  assert.ok(
    fs.existsSync(path.join(REPO, pin.slice('file:'.length))),
    'the pinned tarball is not in vendor/ — this build cannot be installed from',
  );
});

check('the driven install is available on the three platforms with a backend, and nowhere else', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.strictEqual(install.drivenInstallAvailable(platform), true, platform);
  }
  assert.strictEqual(install.drivenInstallAvailable('freebsd'), false);
  // And the reason is a SENTENCE, not a shrug: it names the platform and the
  // three backends, and says what to do instead.
  const why = install.drivenInstallUnavailableWhy('freebsd');
  assert.ok(why.includes('freebsd'), why);
  assert.ok(why.includes('cuda-linux') && why.includes('mlx-darwin') && why.includes('llama-windows'), why);
});

checkAsync('the button is live and carries NO reason; an unsupported box is the mirror', async () => {
  const plan = await install.crucibleInstallPlan(host());
  assert.strictEqual(plan.driven, true, 'the install button is dead on a machine that can install');
  assert.strictEqual(
    plan.drivenWhy, null,
    'a reason beside a live button is a sentence that contradicts what it sits on',
  );
  const other = await install.crucibleInstallPlan(host({
    platform: 'freebsd', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.strictEqual(other.driven, false);
  assert.ok(other.drivenWhy && other.drivenWhy.length > 40, 'the disabled button wears no explanation');
});

check('the wheel constants are GONE — a Crucible is not installed from a .whl', () => {
  // PHASE14: the server arrives as an env pack with its own interpreter. A
  // constant naming a wheel was a second, wrong answer to "what gets
  // installed", and the plan's `wheel` field went with it.
  assert.strictEqual(install.CRUCIBLE_WHEEL, undefined);
  assert.strictEqual(install.CRUCIBLE_BOOTSTRAP_TARBALL, undefined);
  assert.strictEqual(install.MAC_CONDA_ROOTS, undefined, 'a server pack brings its own interpreter');
  assert.strictEqual(install.DRIVEN_INSTALL_AVAILABLE, undefined, 'the build-time switch is gone');
});

check('the refusal shape is the package\'s: {code, message, command, detail}', () => {
  const err = new install.CrucibleInstallError('no_wsl_distro', 'nothing named a guest', {
    command: 'wsl --install -d Ubuntu',
  });
  const refusal = err.toRefusal();
  assert.deepStrictEqual(Object.keys(refusal).sort(), ['code', 'command', 'detail', 'message']);
  assert.strictEqual(refusal.code, 'no_wsl_distro');
  assert.strictEqual(refusal.command, 'wsl --install -d Ubuntu');
  assert.strictEqual(refusal.detail, null, 'a missing detail must be null, never undefined');
});

/*
 * NOTHING IS RENAMED ON THE WAY OUT. `installRefusalOf` is the one projector
 * between the installer and the screen, and the phase's whole argument is that
 * renaming another owner's refusal is the defect. So a BootstrapRefusal keeps
 * its code, its command and its evidence, and only a thing that is NOT a
 * refusal gets a name of this app's own.
 */
checkAsync('a package refusal crosses the wire verbatim, command included', async () => {
  const bootstrap = await import_bootstrap();
  const refused = new bootstrap.BootstrapRefusal('host_not_installed', 'there is no host here', {
    command: 'irm https://example/install.ps1 | iex',
    detail: 'looked in C:\\x\\host',
  });
  const out = install.installRefusalOf(refused);
  assert.strictEqual(out.code, 'host_not_installed');
  assert.strictEqual(out.command, 'irm https://example/install.ps1 | iex');
  assert.strictEqual(out.detail, 'looked in C:\\x\\host');
  assert.ok(out.message.includes('host_not_installed'), `the code is not in the sentence: ${out.message}`);
});

check('something that is NOT a refusal is install_failed, in its own words', () => {
  const out = install.installRefusalOf(new TypeError('cannot read properties of undefined'));
  assert.strictEqual(out.code, 'install_failed');
  assert.ok(out.message.startsWith('install_failed: '), out.message);
  assert.ok(out.message.includes('cannot read properties'), 'the error\'s own words were thrown away');
  assert.strictEqual(out.command, null);
});

/*
 * `BOOKFORGE_JOB_TYPES` AND `BOOKFORGE_NARRATOR_ENGINE` ARE DELETED, and the
 * check that pinned them asks the file that owns them now (2026-09-14,
 * PHASE13-OPERATOR.md section 5.4): `shared/crucible/bookforge.module.json`,
 * GENERATED in the crucible repo and vendored here byte for byte.
 * `tools/test-crucible-module-file.js` compares the copy to its source; this
 * checks the one thing the INSTALL cares about — the driven install asks for
 * exactly what the module asks for, so a person who pressed the button and a
 * person whose app coordinated get the same server.
 */
check('the driven install asks for exactly what the vendored module asks for', () => {
  const module_ = JSON.parse(fs.readFileSync(
    path.join(REPO, 'shared', 'crucible', 'bookforge.module.json'), 'utf-8'));
  const options = install.bookforgeInstallOptions(() => {});

  // The release is PASSED, never defaulted: the package would default to its
  // own version, which is the same number today and is not the same fact.
  assert.strictEqual(options.release, install.CRUCIBLE_RELEASE);
  assert.strictEqual(typeof options.onLine, 'function');
  // The three fields that went with the wheel and the host's distro ownership.
  assert.strictEqual(options.wheel, undefined);
  assert.strictEqual(options.condaRoots, undefined);
  assert.strictEqual(options.distro, undefined, 'the HOST owns the distro on Windows (PHASE15 4.3)');

  const asked = options.jobTypes.map((t) => (typeof t === 'string' ? t : t.type));
  assert.deepStrictEqual(
    asked, module_.job_types.map((e) => e.type),
    'the driven install and the module ask for different job types',
  );

  // `tts` must carry its engine: cuda-linux has one venv per narrator engine
  // and the package refuses a bare `tts` by name.
  const tts = options.jobTypes.find((t) => typeof t === 'object' && t.type === 'tts');
  const declared = module_.job_types.find((e) => e.type === 'tts');
  assert.ok(tts, '`tts` is a bare string — the package refuses that by name');
  assert.strictEqual(tts.narratorEngine, declared.narrator_engine);
  assert.ok(
    options.jobTypes.every((t) => typeof t === 'string' || t.type === 'tts'),
    'only tts takes an engine',
  );
});

checkAsync('the job list the package would accept — checked by the package, not by us', async () => {
  const bootstrap = await import_bootstrap();
  // `planJobTypes` is the package's own validator and it refuses by name:
  // a bare `tts`, a `denoise` with no `rvc`, an unknown type. Running the real
  // module list through it is how this app finds out its module is wrong
  // BEFORE somebody presses a button that downloads six gigabytes.
  const plan = bootstrap.planJobTypes(install.bookforgeJobTypes());
  assert.ok(plan.enableFlags.length > 0, 'a Crucible with no job types serves nothing');
  assert.ok(plan.enableFlags.every((f) => f.startsWith('--enable-')), plan.enableFlags.join(' '));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Windows installs ONE way, and it is the host's (PHASE15-HOST.md 4.3)
// ─────────────────────────────────────────────────────────────────────────────
//
// Driven over a SCRIPTED runner: a fake filesystem, a fake `fetch` for the
// host's loopback door, and no process spawned anywhere. Nothing here
// downloads, elevates, imports a distro or opens a socket.

function winRunner(overrides) {
  const files = (overrides && overrides.files) || {};
  return Object.assign({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
    homedir: 'C:\\Users\\t',
    run: async () => ({ code: 0, stdout: '', stderr: '', failure: null }),
    stream: async () => ({ code: 0, stdout: '', stderr: '', failure: null }),
    fileExists: (file) => Object.prototype.hasOwnProperty.call(files, file),
    readFile: (file) => {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
    realpathNative: (file) => file,
  }, (overrides && overrides.runner) || {});
}

const HOST_CLI = 'C:\\Users\\t\\AppData\\Local\\Crucible\\host\\crucible.cmd';
const HOST_CONFIG = 'C:\\Users\\t\\AppData\\Local\\Crucible\\config.toml';

checkAsync('no host on this Windows box: host_not_installed, carrying install.ps1', async () => {
  let caught = null;
  try {
    await install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), winRunner());
  } catch (err) { caught = err; }
  assert.ok(caught, 'the install resolved on a machine with no host — it installed nothing');
  const refusal = install.installRefusalOf(caught);
  assert.strictEqual(
    refusal.code, 'host_not_installed',
    `Windows has ONE install sequence and it is the host's: ${refusal.code} — ${refusal.message}`,
  );
  assert.ok(refusal.command, 'a refusal with nothing to type leaves a person with nowhere to go');
  assert.match(refusal.command, /install\.ps1/, `the line is not install.ps1: ${refusal.command}`);
  assert.ok(
    refusal.command.includes(install.CRUCIBLE_RELEASE),
    `the line does not name the release this build speaks: ${refusal.command}`,
  );
});

checkAsync('the install.ps1 line comes from the PACKAGE, not from a string in this app', async () => {
  const bootstrap = await import_bootstrap();
  let caught = null;
  try {
    await install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), winRunner());
  } catch (err) { caught = err; }
  assert.strictEqual(
    install.installRefusalOf(caught).command,
    bootstrap.hostInstallCommand(install.CRUCIBLE_RELEASE),
    'the app composed its own install line. One machine, one installer, one line — a second '
    + 'spelling here is the drift PHASE14 4a forbids.',
  );
});

checkAsync('a host that IS there is asked over its loopback door, and its events relayed', async () => {
  const bootstrap = await import_bootstrap();
  const events = [
    { id: 1, event: 'state', data: { code: 'wsl_missing', sentence: 'WSL is not installed.', action: 'run-elevated' } },
    { id: 2, event: 'step', data: { name: 'server-pack', index: 2, total: 7 } },
    { id: 3, event: 'progress', data: { bytes_done: 1024, bytes_total: 4096, file: 'pack.part0' } },
    { id: 4, event: 'line', data: { text: 'unpacking', stream: 'stdout' } },
    {
      id: 5,
      event: 'done',
      data: {
        server: { name: 'crucible@pc', url: 'http://127.0.0.1:7100', config_path: '/home/t/.crucible/config.toml' },
        release: install.CRUCIBLE_RELEASE,
        backend: 'cuda-linux',
        crucible: '/home/t/.crucible/server/bin/crucible',
        steps: [{ name: 'server-pack', argv: [], status: 'ok', detail: '' }],
      },
    },
  ];
  let posted = null;
  const fetchImpl = async (url, init) => {
    posted = { url: String(url), init };
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };

  const seenSteps = [];
  const seenHost = [];
  const options = install.bookforgeInstallOptions(
    () => {},
    { onStep: (step) => seenSteps.push(step.name), onHostEvent: (e) => seenHost.push(e.event) },
  );
  const result = await install.driveCrucibleInstall(
    Object.assign({}, options, { fetchImpl }),
    winRunner({ files: { [HOST_CLI]: '@echo off', [HOST_CONFIG]: '[auth]\ntoken = "abc"\n' } }),
  );

  assert.ok(posted, 'the host door was never asked');
  assert.strictEqual(posted.url, `${bootstrap.HOST_DOOR_URL}${bootstrap.HOST_INSTALL_PATH}`);
  // THE TOKEN IS THE ENGINE'S, read from the host's own config — there is no
  // second token and none is minted (PHASE15 3.5).
  assert.strictEqual(posted.init.headers.authorization, 'Bearer abc');
  const sent = JSON.parse(posted.init.body);
  assert.strictEqual(sent.target, 'wsl');
  assert.strictEqual(sent.release, install.CRUCIBLE_RELEASE);
  assert.ok(Array.isArray(sent.job_types) && sent.job_types.length > 0);

  // EVERY KIND REACHES THE APP. `state` and `progress` have no place in
  // onLine/onStep, and dropping either is how a 6 GB download becomes a screen
  // that says nothing for ten minutes.
  assert.deepStrictEqual(seenHost, ['state', 'step', 'progress', 'line', 'done']);
  assert.ok(seenSteps.includes('server-pack'), 'the step callback saw nothing');
  assert.strictEqual(result.backend, 'cuda-linux');
  assert.strictEqual(result.server.name, 'crucible@pc');
});

checkAsync('a stream that ends without `done` is a FAILURE, named, not a success', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ id: 1, event: 'step', data: { name: 'init', index: 1, total: 7 } }) + '\n',
    { status: 200 },
  );
  let caught = null;
  try {
    await install.driveCrucibleInstall(
      Object.assign({}, install.bookforgeInstallOptions(() => {}), { fetchImpl }),
      winRunner({ files: { [HOST_CLI]: '@echo off', [HOST_CONFIG]: '[auth]\ntoken = "abc"\n' } }),
    );
  } catch (err) { caught = err; }
  assert.ok(caught, 'a truncated install stream was read as a finished install');
  assert.strictEqual(install.installRefusalOf(caught).code, 'host_install_failed');
});

checkAsync('a second install while one is in flight is refused by NAME', async () => {
  // The host's own word for it (409 host_install_running), which main.ts
  // repeats for the machines that have no door to refuse it — one install per
  // machine, and the second caller waits rather than starting a second walk
  // over the same distro.
  const fetchImpl = async () => new Response(
    JSON.stringify({ code: 'host_install_running', message: 'one already running' }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  );
  let caught = null;
  try {
    await install.driveCrucibleInstall(
      Object.assign({}, install.bookforgeInstallOptions(() => {}), { fetchImpl }),
      winRunner({ files: { [HOST_CLI]: '@echo off', [HOST_CONFIG]: '[auth]\ntoken = "abc"\n' } }),
    );
  } catch (err) { caught = err; }
  assert.ok(caught);
  assert.strictEqual(install.installRefusalOf(caught).code, 'host_install_running');
});

check('main.ts refuses a concurrent install itself, with the host\'s own name', () => {
  const main = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
  assert.ok(
    main.includes("'host_install_running'"),
    'main.ts lets two installs start at once on macOS and Linux, where there is no host door '
    + 'to refuse the second',
  );
  assert.ok(
    main.includes("event.sender.send('crucible:install-progress'"),
    'main.ts does not stream the install — an await with nothing in between is a spinner for '
    + 'twenty minutes over a multi-gigabyte download',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. The plan describes that sequence, and prints no shell to paste
// ─────────────────────────────────────────────────────────────────────────────

function commandsOf(plan) {
  return plan.steps.flatMap((s) => s.commands);
}

checkAsync('the plan carries NO commands — those were a second copy of the installer', () => install
  .crucibleInstallPlan(host()).then((plan) => {
    assert.deepStrictEqual(
      commandsOf(plan), [],
      'a copyable shell sequence came back into the plan. It was eight lines describing a conda '
      + 'and a wheel install that PHASE14 replaced with env packs, and nothing compared the two.',
    );
    assert.ok(plan.steps.length > 0, 'the plan describes nothing at all');
    for (const step of plan.steps) {
      assert.ok(step.title && step.detail, `a step with no words: ${JSON.stringify(step)}`);
    }
  }));

checkAsync('the plan names no wheel and no conda, on any platform', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = await install.crucibleInstallPlan(host({
      platform,
      arch: platform === 'darwin' ? 'arm64' : 'x64',
      wslDistro: platform === 'win32' ? 'Ubuntu' : undefined,
      listWsl: platform === 'win32'
        ? () => ({ status: 0, stdout: WSL_TABLE, stderr: '' })
        : () => { throw new Error('wsl.exe must not be asked off Windows'); },
      queryGpu: () => ({ status: 0, stdout: SMI, stderr: '' }),
    }));
    assert.strictEqual(plan.wheel, undefined, `${platform}: the plan still carries a wheel field`);
    const words = JSON.stringify(plan.steps) + JSON.stringify(plan.elevated);
    assert.ok(!/\.whl/.test(words), `${platform}: the plan still names a wheel`);
    assert.ok(!/conda/.test(words), `${platform}: the plan still names conda`);
  }
});

checkAsync('on Windows the ONE line a person types is install.ps1, and nothing else', async () => {
  const plan = await install.crucibleInstallPlan(host());
  const bootstrap = await import_bootstrap();
  const elevated = plan.elevated.flatMap((s) => s.commands);
  assert.deepStrictEqual(
    elevated, [bootstrap.hostInstallCommand(install.CRUCIBLE_RELEASE)],
    '`wsl --install` and `enable-linger` are the HOST\'s to raise now (PHASE15 4.3): it walks '
    + 'the state table, prompts for elevation by name and survives the reboot. A second copy '
    + 'in this list is a person running a command the host was about to run.',
  );
});

checkAsync('macOS needs no typed line at all — its service is a launchd agent', async () => {
  const plan = await install.crucibleInstallPlan(host({
    platform: 'darwin', arch: 'arm64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.deepStrictEqual(plan.elevated, []);
  assert.strictEqual(plan.host.wsl, null);
});

checkAsync('linger is a Linux fact, and Linux still gets it', async () => {
  const plan = await install.crucibleInstallPlan(host({
    platform: 'linux', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
  }));
  assert.deepStrictEqual(
    plan.elevated.flatMap((s) => s.commands),
    ['sudo loginctl enable-linger "$USER"'],
  );
});

checkAsync('the non-Windows steps are the PACKAGE\'s step list, in its order', async () => {
  const bootstrap = await import_bootstrap();
  const plan = await install.crucibleInstallPlan(host({
    platform: 'linux', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
  }));
  const jobs = bootstrap.planJobTypes(install.bookforgeJobTypes());
  const theirs = bootstrap
    .installSteps({ enableFlags: jobs.enableFlags, installs: jobs.installs, bind: [], linger: false })
    .map((step) => step.name);
  assert.deepStrictEqual(
    plan.steps.map((s) => s.title), theirs,
    'the plan invented its own sequence again. The installer owns the order; a screen that '
    + 'describes a different one is describing a different install.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The measured machine — every null carries a named refusal
// ─────────────────────────────────────────────────────────────────────────────

check('the happy PC: a WSL2 guest, a card, no config yet, and no refusals', () => {
  const facts = install.crucibleHostFacts(host());
  assert.strictEqual(facts.platform, 'win32');
  assert.strictEqual(facts.wsl.probed, 'Ubuntu');
  assert.strictEqual(facts.gpu.vendor, 'nvidia');
  assert.strictEqual(facts.gpu.name, 'NVIDIA GeForce RTX 3090 Ti');
  assert.strictEqual(facts.gpu.vramBytes, 24564 * 1024 * 1024);
  // `no_local_config` is the ORDINARY state of a machine that has not installed
  // one — it is the reason this screen exists, not a fault to report.
  assert.deepStrictEqual(facts.refusals, []);
  assert.strictEqual(facts.discovered.present, false);
});

check('the WSL1-only machine is refused as wsl_missing, with the command', () => {
  const facts = install.crucibleHostFacts(host({
    listWsl: () => ({ status: 0, stdout: '  NAME   STATE     VERSION\n* legacy Stopped   1\n', stderr: '' }),
  }));
  const refusal = facts.refusals.find((r) => r.code === 'wsl_missing');
  assert.ok(refusal, 'a WSL1-only machine passed as installable — only WSL2 passes the card through');
  assert.strictEqual(refusal.command, 'wsl --install -d Ubuntu');
});

check('"wsl.exe could not be run" is wsl_missing, not "no distros"', () => {
  const facts = install.crucibleHostFacts(host({
    listWsl: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
  }));
  assert.ok(facts.refusals.some((r) => r.code === 'wsl_missing'));
  assert.strictEqual(facts.wsl.distros.length, 0);
});

check('"wsl.exe answered and failed" is wsl_read_failed — about the LISTING, not the guest', () => {
  const facts = install.crucibleHostFacts(host({
    listWsl: () => ({ status: 1, stdout: '', stderr: 'catastrophic failure' }),
  }));
  const refusal = facts.refusals.find((r) => r.code === 'wsl_read_failed');
  assert.ok(refusal, 'a failed listing was read as an answer about whether a distro is there');
  assert.strictEqual(refusal.detail, 'catastrophic failure');
});

check('WSL2 present but nobody said WHICH is no_wsl_distro — there is no default here', () => {
  const facts = install.crucibleHostFacts(host({ wslDistro: undefined }));
  const refusal = facts.refusals.find((r) => r.code === 'no_wsl_distro');
  assert.ok(refusal, '"the default distro" was used as a default');
  assert.ok(refusal.message.includes('Ubuntu'), 'the refusal does not list what it could be set to');
  assert.strictEqual(facts.gpu, null, 'a card was reported for a guest nobody named');
});

check('the GUEST\'s nvidia-smi is what is asked, and a missing one is named', () => {
  let askedIn = null;
  const facts = install.crucibleHostFacts(host({
    queryGpu: (distro) => { askedIn = distro; return { status: 3, stdout: '', stderr: '' }; },
  }));
  assert.strictEqual(askedIn, 'Ubuntu', 'the Windows-side driver was asked instead of the guest');
  const refusal = facts.refusals.find((r) => r.code === 'no_nvidia_driver');
  assert.ok(refusal, 'a guest with no nvidia-smi passed as having a card');
  assert.ok(refusal.command, 'nothing to do about it was said');
  assert.strictEqual(facts.gpu, null);
});

check('an Intel Mac is not_apple_silicon — mlx-darwin is Apple Silicon only', () => {
  const facts = install.crucibleHostFacts(host({
    platform: 'darwin', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.ok(facts.refusals.some((r) => r.code === 'not_apple_silicon'));
});

checkAsync('a platform Crucible has no backend for says so, and draws no sequence', async () => {
  const facts = install.crucibleHostFacts(host({
    platform: 'freebsd', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.strictEqual(facts.platform, 'other');
  assert.ok(facts.refusals.some((r) => r.code === 'unsupported_platform'));
  return install.crucibleInstallPlan(host({
    platform: 'freebsd', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  })).then((plan) => {
    assert.strictEqual(plan.steps.length, 1, 'a FreeBSD box was handed a Linux sequence');
    assert.deepStrictEqual(plan.steps[0].commands, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The four doors' states
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PRESENT = {
  present: true,
  serverName: 'crucible@owens-pc-wsl',
  url: 'http://127.0.0.1:7100',
  configPath: 'Ubuntu:/home/telltale/.crucible/config.toml',
  via: 'wsl',
};

checkAsync('DOOR 2 open: the config is here, and the plan says so', async () => {
  const plan = await install.crucibleInstallPlan(host({ discovered: () => CONFIG_PRESENT }));
  assert.strictEqual(plan.host.discovered.present, true);
  assert.strictEqual(plan.host.discovered.serverName, 'crucible@owens-pc-wsl');
  assert.ok(
    plan.machine.includes('crucible@owens-pc-wsl'),
    'the one-line description does not mention the server that is already here',
  );
  // The step this app can actually verify is `init`: discovery.ts has already read
  // whether a config is there. On a MAC or a Linux box that step is in the
  // list by the package's own name, so a machine with a config is not told to
  // initialise again.
  const mac = await install.crucibleInstallPlan(host({
    platform: 'darwin', arch: 'arm64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
    discovered: () => CONFIG_PRESENT,
  }));
  const init = mac.steps.find((step) => step.title === 'init');
  assert.ok(init, 'the installer\'s step list has no `init` step any more');
  assert.strictEqual(init.done, true, 'a machine with a config was told to initialise again');
});

check('DOOR 2 closed: `no_local_config` is a STATE and is not reported as a refusal', () => {
  const facts = install.crucibleHostFacts(host());
  assert.strictEqual(facts.discovered.present, false);
  assert.ok(
    !facts.refusals.some((r) => r.code === 'no_local_config'),
    'a laptop that only ever renders on the Mac was told it is broken',
  );
});

check('DOOR 2 broken: an unreadable config IS a refusal — that one has a fix', () => {
  const facts = install.crucibleHostFacts(host({
    discovered: () => ({
      present: false,
      code: 'config_unreadable',
      reason: 'config.toml is not valid TOML. The server would refuse it too.',
    }),
  }));
  assert.ok(facts.refusals.some((r) => r.code === 'config_unreadable'));
});

checkAsync('DOOR 3: the verdict always says why, whichever way it went', async () => {
  const plan = await install.crucibleInstallPlan(host());
  assert.ok(plan.readme.startsWith('https://'), 'no link to the argument behind the sequence');
  // `plan.jobTypes` is GONE from the wire with the constant behind it: a
  // screen that wants to name what this app asks a server for reads the
  // vendored module (`crucible:module`), which is generated from the
  // manifests. What the plan states instead is whether this machine could
  // hold a server at all, and it always says why.
  assert.strictEqual(plan.jobTypes, undefined, 'the plan restates the module\'s ids again');
  assert.ok(['yes', 'no', 'unknown'].includes(plan.hostable), `hostable: ${plan.hostable}`);
  assert.ok(plan.hostableWhy.length > 20, 'a hostability verdict with no reason is a bug');
});

checkAsync('DOOR 3: no step claims `done` that this app has not actually checked', async () => {
  // Two facts, and only two: whether a WSL2 distro is there (the listing said
  // so) and whether a config is there (discovery.ts said so). A checkbox that
  // guessed anything else would be worse than no checkbox.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = await install.crucibleInstallPlan(host({
      platform,
      arch: platform === 'darwin' ? 'arm64' : 'x64',
      wslDistro: platform === 'win32' ? 'Ubuntu' : undefined,
      listWsl: platform === 'win32'
        ? () => ({ status: 0, stdout: WSL_TABLE, stderr: '' })
        : () => { throw new Error('not asked'); },
      queryGpu: () => ({ status: 0, stdout: SMI, stderr: '' }),
      discovered: () => CONFIG_PRESENT,
    }));
    for (const step of plan.steps) {
      if (!step.done) continue;
      const checkable = step.title === 'init' || /WSL2/.test(step.title);
      assert.ok(checkable, `${platform}: "${step.title}" is ticked and nothing here verified it`);
    }
  }
});

checkAsync('DOOR 4 is there: the uninstall channels are registered and refuse remotes', async () => {
  // The door itself is `tools/test-crucible-uninstall.js`'s. What THIS file
  // pins is that the pair exists at all and is not named what Foundry names
  // its own — a duplicate ipcMain.handle throws at registration and the app
  // does not start with the Foundry window mounted.
  const main = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf-8');
  for (const ours of ['crucible:host-uninstall-plan', 'crucible:host-uninstall']) {
    assert.ok(main.includes(`ipcMain.handle('${ours}'`), `main.ts does not register ${ours}`);
  }
  for (const theirs of ["'crucible:uninstall'", "'crucible:uninstall-plan'"]) {
    assert.ok(!main.includes(`ipcMain.handle(${theirs}`), `main.ts registers the short name ${theirs}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The IPC names — a collision is a boot failure
// ─────────────────────────────────────────────────────────────────────────────
//
// `test-ipc-collision.js` is the general keeper and reads Foundry's whole doc.
// This is the specific one: the two names Foundry's OWN install screen claims,
// which are the names ours would most naturally have been given.

check('our install channels are NOT the two Foundry\'s install screen registers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf-8');
  for (const theirs of ["'crucible:install-plan'", "'crucible:install'"]) {
    assert.ok(
      !main.includes(`ipcMain.handle(${theirs}`),
      `main.ts registers ${theirs}, which the vendored Foundry also registers — two handlers of `
      + 'one name in one Electron process throw at registration and the app will not start',
    );
  }
  for (const ours of ['crucible:host-facts', 'crucible:host-install-plan', 'crucible:host-install']) {
    assert.ok(main.includes(`ipcMain.handle('${ours}'`), `main.ts does not register ${ours}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The card names the machine the run would use
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_PC = { platform: 'win32', arch: 'x64', wslReaderRefusal: null };

check('a Crucible venue is drawn as the SERVER, not as "this machine\'s GPU (WSL)"', () => {
  const route = conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC,
    endpoint: null,
    venue: { where: 'crucible', server: 'mac', because: 'top-ranked' },
    venueRefusal: null,
  });
  assert.strictEqual(route.kind, 'crucible');
  const label = conversion.vlmRouteLabel(route);
  assert.ok(label.includes('mac'), `the label does not name the server: ${label}`);
  assert.ok(!/WSL/.test(label), `the card claims this machine's GPU for a run going to mac: ${label}`);
});

check('the legacy switch keeps today\'s local label exactly', () => {
  const route = conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC,
    endpoint: null,
    venue: { where: 'legacy-local-narrator', because: 'the legacy switch is on' },
    venueRefusal: null,
  });
  assert.strictEqual(route.kind, 'wsl-server');
  assert.strictEqual(conversion.vlmRouteLabel(route), "this machine's GPU (WSL)");
});

check('a TYPED endpoint still wins, and the venue is not consulted', () => {
  const endpoint = { url: 'http://10.0.0.9:8000/v1', model: 'dots-ocr', concurrency: 0 };
  const route = conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC,
    endpoint,
    venue: { where: 'crucible', server: 'mac', because: 'top-ranked' },
    venueRefusal: null,
  });
  assert.strictEqual(route.kind, 'endpoint');
  assert.strictEqual(conversion.vlmRouteLabel(route), endpoint.url);
});

check('a venue that REFUSED is carried through as a refusal, never as "local"', () => {
  const route = conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC,
    endpoint: null,
    venue: null,
    venueRefusal: 'no_enabled_server: nothing is enabled in Settings → Crucible Servers.',
  });
  assert.strictEqual(route.kind, 'refused');
  assert.ok(route.reason.includes('no_enabled_server'), 'the refusal lost its name');
  assert.ok(/Crucible Servers/.test(route.reason), 'the refusal does not say where to fix it');
});

check('no venue and no refusal is the three LOCAL facts, unchanged', () => {
  const route = conversion.resolveVlmRouteWithVenue({
    platform: 'darwin', arch: 'arm64', endpoint: null, wslReaderRefusal: 'not configured',
    venue: null, venueRefusal: null,
  });
  assert.strictEqual(route.kind, 'mlx-local');
});

process.on('exit', () => {
  console.log(`\n${ran} checks; ${process.exitCode ? 'FAILURES' : 'all green'}`);
});

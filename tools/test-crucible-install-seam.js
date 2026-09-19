#!/usr/bin/env node
/** BookForge installation contract: native Windows first, SDK-owned runtime,
 * lifecycle verification, refusal propagation, and first-run plan/UI gates.
 * All machine reads and installer processes are scripted; the info protocol
 * is exercised against a loopback fake. No GPU, WSL or real install is used.
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
    + 'package.json to its versioned vendor/crucible-bootstrap tarball; if that pin is gone this is a '
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
  // BOOTSTRAP_LIBRARY_VERSION is BOOTSTRAP_VERSION — what the vendored package says
  // about itself — so this compares the TARBALL ON DISK with the version inside
  // it. A re-vendor that swapped the file without the pin, or a pin edited
  // without the file, is red here. The old literal could not be asked that
  // question: it only ever agreed with itself.
  assert.ok(pin.includes(install.BOOTSTRAP_LIBRARY_VERSION), `vendor/ holds ${pin} but the package inside says ${install.BOOTSTRAP_LIBRARY_VERSION}`);
  assert.ok(
    fs.existsSync(path.join(REPO, pin.slice('file:'.length))),
    'the pinned tarball is not in vendor/ — this build cannot be installed from',
  );
  // AND THE SENTENCE BESIDE THE PIN SAYS THE SAME RELEASE.
  //
  // package.json carries `//crucible-bootstrap` and `//crucible-client`, two
  // comment keys that name the vendored release IN WORDS and state the rule
  // about never repacking those bytes. On 2026-09-16 both still said 0.6.3
  // while the dependencies under them had moved to 0.6.6: the pin travelled
  // with the re-vendor and the sentence explaining it did not.
  //
  // Nothing above asks this question. Every other check here compares the pin
  // with the BYTES — the tarball on disk, the version inside it — and all of
  // them agreed, because prose is not one of the things they compare. This is
  // the same shape as the crucible repo's tests/test_doc_claims.py: a comment
  // that NAMES something has a referent in the tree, and a test can hold it to
  // it.
  for (const key of ['//crucible-bootstrap', '//crucible-client']) {
    const said = pkg[key];
    assert.ok(said, `${key} is gone from package.json — it is the sentence that explains the pin`);
    assert.ok(
      said.includes(install.BOOTSTRAP_LIBRARY_VERSION),
      `${key} names a library version the vendored package does not (${install.BOOTSTRAP_LIBRARY_VERSION}): ${said}`,
    );
  }
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
check('the service install is lightweight and model requirements stay in the later module', () => {
  const module_ = JSON.parse(fs.readFileSync(
    path.join(REPO, 'shared', 'crucible', 'bookforge.module.json'), 'utf-8'));
  const options = install.bookforgeInstallOptions(() => {});

  // THE RELEASE IS NOT HERE, and that is crucible INSTALL-UNINSTALL.md §6.5.
  // It used to be the vendored library's version, which is what made Set up
  // install 1.0.1 over a running 1.0.2. Which Crucible a machine should have is
  // the release channel's answer, read by driveCrucibleInstall at install time.
  assert.strictEqual(options.release, undefined,
    'bookforgeInstallOptions must not name a release; the channel owns that');
  assert.strictEqual(typeof options.onLine, 'function');
  // The three fields that went with the wheel and the host's distro ownership.
  assert.strictEqual(options.wheel, undefined);
  assert.strictEqual(options.condaRoots, undefined);
  assert.strictEqual(options.distro, undefined, 'the HOST owns the distro on Windows (PHASE15 4.3)');

  const asked = options.jobTypes.map((t) => (typeof t === 'string' ? t : t.type));
  assert.deepStrictEqual(
    asked, ['echo'],
    'first-launch AI choices must precede app runtime/model preparation',
  );

  // `tts` must carry its engine: cuda-linux has one venv per narrator engine
  // and the package refuses a bare `tts` by name.
  const tts = install.bookforgeJobTypes().find((t) => typeof t === 'object' && t.type === 'tts');
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

const { startFakeCrucible } = require('./fake-crucible.js');

/*
 * THE RELEASE CHANNEL AND THE RUNNING ENGINE, BOTH SCRIPTED.
 *
 * crucible INSTALL-UNINSTALL.md §6.5.3. `driveCrucibleInstall` takes the pair as
 * its third argument for exactly this: a keeper can put a channel at one version
 * in front of an engine at another and watch what the gate does. A test that let
 * either fall through would reach api.github.com and this machine's own
 * Crucible, which is the same rule every other fixture in this file follows.
 */
const CHANNEL_LATEST = '9.9.9';
const releaseSources = (latest = CHANNEL_LATEST, running = null) => ({
  latest: async () => latest,
  running: async () => running,
});

// Exercise the published SDK's real POSIX install and lifecycle driver with a
// scripted host. No process, filesystem write, or network request can escape.
function posixRunner(platform, start) {
  const home = '/isolated/crucible';
  const command = `${home}/envs/server/bin/python3`;
  const sha = 'a'.repeat(64);
  const files = {
    [`${home}/config.toml`]: '[server]\nname="fixture"\nhost="127.0.0.1"\nport=7100\n[auth]\ntoken="fixture-secret"',
    [`${home}/installation.json`]: JSON.stringify({ schema_version: 1, platform, home, release: CHANNEL_LATEST,
      control: { command, args: ['-m', 'crucible.cli', 'local'], cwd: home } }),
    [command]: 'fixture',
  };
  return winRunner({ files, runner: {
    platform, homedir: '/unused', env: {},
    run: async (argv, opts) => {
      let stdout;
      if (argv[0] === 'bash') stdout = `home=${home}\nuser=fixture\nfree_kib=99999999\ncrucible=${home}/envs/server/bin/crucible\nsha256=${sha}\nrelease=${CHANNEL_LATEST}\n`;
      else if (argv[0] === 'curl') stdout = JSON.stringify({ schema: 1, version: CHANNEL_LATEST,
        packs: [{ name: 'server', backend: platform === 'darwin' ? 'mlx-darwin' : 'cuda-linux', python: '3.11', bytes: 1,
          unpacked_bytes: 1, sha256: sha, parts: ['fixture.tar.zst'] }] });
      else {
        assert.deepStrictEqual(argv, [command, '-m', 'crucible.cli', 'local', 'start', '--json']);
        assert.deepStrictEqual(opts.env, { CRUCIBLE_HOME: home });
        stdout = JSON.stringify(await start());
      }
      return { code: 0, failure: null, stderr: '', stdout };
    },
    stream: async argv => {
      assert.ok(argv[0].endsWith('/bin/crucible'), `Unexpected command ${argv}`);
      return { code: 0, failure: null, stderr: '', stdout: '' };
    },
  }});
}

for (const platform of ['darwin', 'linux']) {
  checkAsync(`${platform} install awaits healthy local start before returning`, async () => {
    let releaseStart;
    const waiting = new Promise(resolve => { releaseStart = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const steps = [];
    const r = posixRunner(platform, async () => { entered(); return waiting; });
    let returned = false;
    const pending = install.driveCrucibleInstall({ ...install.bookforgeInstallOptions(() => {}, { onStep: s => steps.push(`${s.name}:${s.status}`) }),
      home: '/isolated/crucible' }, r, releaseSources()).then(value => { returned = true; return value; });
    await started;
    assert.strictEqual(returned, false, 'service registration alone is not readiness');
    assert.ok(steps.includes('local-readiness:running'));
    releaseStart({ schema_version: 1, state: 'running', name: 'fixture', url: 'http://127.0.0.1:7100', detail: 'ready' });
    const result = await pending;
    assert.strictEqual(result.steps.at(-1).name, 'local-readiness');
    assert.strictEqual(result.steps.at(-1).status, 'ok');
  });
}

checkAsync('POSIX installation cannot succeed when startup reports unhealthy or a different engine', async () => {
  for (const status of [
    { state: 'unhealthy', name: 'fixture', detail: 'Startup failed: inspect Crucible logs' },
    { state: 'running', name: 'unrelated', detail: 'ready' },
  ]) {
    await assert.rejects(install.driveCrucibleInstall({ ...install.bookforgeInstallOptions(() => {}), home: '/isolated/crucible' },
      posixRunner('darwin', async () => ({ schema_version: 1, url: 'http://127.0.0.1:7100', ...status })), releaseSources()),
    /Startup failed|differs from the installed/);
  }
});

checkAsync('fresh Windows install runs the native installer, verifies lifecycle, and never requests WSL', async () => {
  const fake = await startFakeCrucible((req, res, ctx) => {
    if (ctx.url.pathname !== '/v1/info') return false;
    assert.strictEqual(req.headers.authorization, 'Bearer test-token-abcd');
    ctx.send(res, 200, {
      server: { name: 'native', version: '0.6.0', api_version: 1 },
      host: { platform: 'win32', arch: 'x86_64', backend: 'llama-windows', gpu: { vendor: 'none', name: 'CPU', vram_bytes: 0 } },
      job_types: ['echo'], capabilities: [], role: 'engine', managed_by: null,
    });
    return true;
  });
  try {
    const bootstrap = await import_bootstrap();
    const home = 'C:\\Users\\t\\AppData\\Local\\Crucible';
    const exe = 'C:\\relocated\\python.exe';
    const cwd = 'C:\\relocated\\source';
    const files = {};
    const calls = [];
    const steps = [];
    const lines = [];
    const r = winRunner({ files, runner: {
      stream: async (argv, opts) => {
        calls.push(argv);
        assert.strictEqual(argv[0], 'powershell.exe');
        assert.ok(argv.at(-1).endsWith(bootstrap.hostInstallCommand(CHANNEL_LATEST)),
          'the native installer is asked for the CHANNEL release, not the vendored library version');
        opts.onLine('native installed', 'stdout');
        files[exe] = 'python';
        files[path.win32.join(home, 'installation.json')] = JSON.stringify({ schema_version: 1, platform: 'win32', home,
          release: '0.6.0', control: { command: exe, args: ['-m', 'crucible.cli', 'local'], cwd } });
        files[path.win32.join(home, 'pairing')] = `crucible://native@${new URL(fake.url).host}/#test-token-abcd`;
        return { code: 0, stdout: '', stderr: '', failure: null };
      },
      run: async (argv, opts) => {
        calls.push(argv);
        assert.deepStrictEqual(argv, [exe, '-m', 'crucible.cli', 'local', 'start', '--json']);
        assert.strictEqual(opts.cwd, cwd);
        assert.deepStrictEqual(opts.env, { CRUCIBLE_HOME: home });
        return { code: 0, failure: null, stderr: '', stdout: JSON.stringify({ schema_version: 1, state: 'running', name: 'native', url: fake.url, detail: 'ready' }) };
      },
    }});
    const result = await install.driveCrucibleInstall(install.bookforgeInstallOptions((line) => lines.push(line), { onStep: (s) => steps.push(s.status) }), r, releaseSources());
    assert.strictEqual(result.backend, 'llama-windows');
    assert.strictEqual(result.server.name, 'native');
    assert.strictEqual(result.server.configPath, path.win32.join(home, 'pairing'));
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(steps, ['running', 'ok']);
    assert.deepStrictEqual(lines, ['native installed']);
  } finally { await fake.close(); }
});

/*
 * NEVER AN OLDER CRUCIBLE — crucible docs/INSTALL-UNINSTALL.md §6.5.3.
 *
 * Owen, 2026-09-18: "It shouldn't install an older Crucible. Maybe it should
 * pull 'latest' and latest should be the latest build. Like how WordPress does
 * it."
 *
 * The runner in each case is one that FAILS THE TEST IF IT IS ASKED TO RUN
 * ANYTHING. A refusal that spawned PowerShell first and then refused would be a
 * machine that had already been touched, and the whole value of this gate is
 * that it happens before that.
 */
const refusingRunner = () => winRunner({ runner: {
  stream: async (argv) => { throw new Error(`nothing must be spawned: ${JSON.stringify(argv)}`); },
  run: async (argv) => { throw new Error(`nothing must be run: ${JSON.stringify(argv)}`); },
  readFile: () => { throw new Error('nothing must be read'); },
}});

checkAsync('a channel OLDER than the running engine refuses by name and spawns nothing', async () => {
  await assert.rejects(
    install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), refusingRunner(), releaseSources('1.0.1', '1.0.2')),
    (err) => {
      assert.strictEqual(err.code, 'install_older_than_running');
      assert.match(err.message, /install_older_than_running:/);
      assert.match(err.message, /1\.0\.1/);
      assert.match(err.message, /1\.0\.2/);
      return true;
    },
  );
});

checkAsync('a channel EQUAL to the running engine says there is nothing to install, by name', async () => {
  await assert.rejects(
    install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), refusingRunner(), releaseSources('1.0.2', '1.0.2')),
    (err) => {
      assert.strictEqual(err.code, 'crucible_already_latest');
      assert.match(err.message, /nothing to install/);
      return true;
    },
  );
});

checkAsync('a channel NEWER than the running engine proceeds, and installs the CHANNEL\'s release', async () => {
  const asked = [];
  const r = winRunner({ runner: {
    stream: async (argv) => { asked.push(argv.at(-1)); return { code: 9, failure: null, stdout: '', stderr: 'stopped here on purpose' }; },
  }});
  await assert.rejects(
    install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), r, releaseSources('1.0.3', '1.0.2')),
    /stopped here on purpose/,
  );
  assert.strictEqual(asked.length, 1, 'the install must have started');
  assert.ok(asked[0].includes('1.0.3'), `the installer was asked for the wrong release: ${asked[0]}`);
  assert.ok(!asked[0].includes(install.BOOTSTRAP_LIBRARY_VERSION),
    'the vendored library version reached the installer; the channel owns which release is installed');
});

checkAsync('a machine with NO Crucible installs the channel\'s latest', async () => {
  const asked = [];
  const r = winRunner({ runner: {
    stream: async (argv) => { asked.push(argv.at(-1)); return { code: 9, failure: null, stdout: '', stderr: 'stopped here on purpose' }; },
  }});
  await assert.rejects(
    install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), r, releaseSources('1.0.3', null)),
    /stopped here on purpose/,
  );
  assert.ok(asked[0].includes('1.0.3'), `a bare machine must get the channel's latest: ${asked[0]}`);
});

checkAsync('an unreadable release channel is refused by name, never a vendored fallback', async () => {
  const dead = {
    latest: async () => { throw new install.CrucibleInstallError('release_channel_unreadable', 'could not read the release channel at https://fixture: ENOTFOUND'); },
    running: async () => { throw new Error('the running engine must not be asked when the channel is unreadable'); },
  };
  await assert.rejects(
    install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), refusingRunner(), dead),
    (err) => {
      assert.strictEqual(err.code, 'release_channel_unreadable');
      return true;
    },
  );
  // And the reader itself, against a channel that answers something else.
  for (const [body, status] of [['<html>404</html>', 200], ['{}', 200], ['{"tag_name":"nightly"}', 200], ['{}', 403]]) {
    const fetchImpl = async () => new Response(body, { status });
    await assert.rejects(install.crucibleChannelLatest(fetchImpl), (err) => {
      assert.strictEqual(err.code, 'release_channel_unreadable', `${body} (HTTP ${status}) should refuse by name`);
      return true;
    });
  }
  assert.strictEqual(await install.crucibleChannelLatest(async () => new Response('{"tag_name":"v1.0.2"}')), '1.0.2');
});

checkAsync('the channel URL is the PROMOTED release, assembled from the package\'s repository slug', async () => {
  const bootstrap = await import_bootstrap();
  assert.strictEqual(install.CRUCIBLE_CHANNEL_URL, `https://api.github.com/repos/${bootstrap.RELEASE_REPO}/releases/latest`);
  // `releases?per_page=1` is the newest TAG, which between a cut and its
  // promotion is the unverified candidate promote_release.py holds back.
  assert.ok(!install.CRUCIBLE_CHANNEL_URL.includes('per_page'));
});

checkAsync('native installer failure is surfaced before lifecycle or pairing is queried', async () => {
  const r = winRunner({ runner: {
    stream: async () => ({ code: 9, failure: null, stdout: '', stderr: 'download failed' }),
    run: async () => { throw new Error('must not start after failure'); },
    readFile: () => { throw new Error('must not read after failure'); },
  }});
  await assert.rejects(install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), r, releaseSources()), /download failed/);
});

checkAsync('an interrupted native installer cannot be reported as success', async () => {
  const r = winRunner({ runner: { stream: async () => ({ code: null, failure: 'timeout', stdout: '', stderr: '' }) }});
  await assert.rejects(install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), r, releaseSources()), /timeout/);
});

checkAsync('installer success without a published installation is a failure', async () => {
  const r = winRunner({ runner: { readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } }});
  await assert.rejects(install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}), r, releaseSources()), /register|Repair/);
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

checkAsync('Windows install needs no manually typed WSL or elevated command', async () => {
  const plan = await install.crucibleInstallPlan(host());
  assert.deepStrictEqual(plan.elevated, []);
  assert.ok(plan.steps.some(s => /native Windows engine/.test(s.detail)));
  assert.ok(plan.steps.some(s => /Optional WSL acceleration/.test(s.detail)));
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

for (const state of ['no WSL', 'WSL1', 'broken WSL', 'no distro selected', 'no GPU']) {
  check(`Windows native setup is available with ${state} and probes no guest or GPU`, () => {
    const facts = install.crucibleHostFacts(host({ wslDistro: undefined,
      listWsl: () => { throw new Error('must not query WSL for native setup'); },
      queryGpu: () => { throw new Error('must not query GPU for native setup'); },
    }));
    assert.strictEqual(facts.platform, 'win32');
    assert.strictEqual(facts.wsl, null);
    assert.strictEqual(facts.gpu, null);
    assert.deepStrictEqual(facts.refusals, []);
    assert.strictEqual(install.hostabilityOf(facts).hostable, 'yes');
  });
}

check('Linux still names a missing NVIDIA driver', () => {
  const facts = install.crucibleHostFacts(host({ platform: 'linux', queryGpu: () => ({ status: 3, stdout: '', stderr: '' }) }));
  assert.ok(facts.refusals.some(r => r.code === 'no_nvidia_driver'));
  assert.strictEqual(install.hostabilityOf(facts).hostable, 'no');
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
    venue: { where: 'legacy-local-narrator', because: 'the legacy switch is on' },
    venueRefusal: null,
  });
  assert.strictEqual(route.kind, 'wsl-server');
  assert.strictEqual(conversion.vlmRouteLabel(route), "this machine's GPU (WSL)");
});

/*
 * INVERTED 2026-09-17, and the old name was the defect: "a TYPED endpoint still
 * wins, and the venue is not consulted."
 *
 * It did win -- `endpoint` was the FIRST branch of `resolveVlmRouteWithVenue`,
 * so a URL somebody typed into Settings, AI, Reading pages months ago beat the
 * Crucible the queue had chosen for this run, silently and with nothing on
 * screen saying so. Owen ruled it out when he asked what that card was even
 * for: page reading is a capability class on the selected engine, picked the
 * same way as every other job.
 *
 * The parameter is GONE rather than ignored, which is why this check now passes
 * an object that has no place to put one: a field the resolver still accepted
 * and quietly dropped would read as a setting that works.
 */
check('there is no endpoint override left: the venue decides page reading', () => {
  const route = conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC,
    venue: { where: 'crucible', server: 'mac', because: 'top-ranked' },
    venueRefusal: null,
  });
  assert.strictEqual(route.kind, 'crucible',
    'the venue is not being consulted, which is what the endpoint branch used to prevent');
  assert.strictEqual(route.server, 'mac');
  assert.ok(!('endpoint' in conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC, venue: null, venueRefusal: null,
  })), 'a route still carries an endpoint');
});

check('a venue that REFUSED is carried through as a refusal, never as "local"', () => {
  const route = conversion.resolveVlmRouteWithVenue({
    ...LOCAL_PC,
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

// --------------------------------------------------- the adoption script
//
// `tools/adopt-crucible-release.mjs` is what moves this app from one Crucible
// release to the next: it fetches the two tarballs, rewrites the two pins and
// the prose beside them, and relinks. Its one piece of real parsing is reading
// the version back OUT of a `file:vendor/...tgz` specifier, and if that is
// wrong it is wrong silently — it would repin from a version nobody is on.
// So it is asked, here, about the pin this app actually carries.

function import_adopt() {
  return import('./adopt-crucible-release.mjs');
}

checkAsync('the adoption script reads the same release out of package.json as the app does', async () => {
  const adopt = await import_adopt();
  const manifest = adopt.findManifest();
  assert.strictEqual(path.resolve(manifest.file), path.join(REPO, 'package.json'),
    `adopt found ${manifest.file}, not this repo's package.json`);
  assert.strictEqual(adopt.pinnedVersion(manifest.parsed), install.BOOTSTRAP_LIBRARY_VERSION,
    'the adoption script and the vendored package disagree about what is pinned');
});

checkAsync('the adoption script refuses two packages pinned to different releases', async () => {
  const adopt = await import_adopt();
  const split = {
    dependencies: {
      '@crucible/client': 'file:vendor/crucible-client-0.6.7.tgz',
      '@crucible/bootstrap': 'file:vendor/crucible-bootstrap-0.6.6.tgz',
    },
  };
  // It exits rather than throws, so the refusal is observed by trapping exit.
  const realExit = process.exit;
  const realError = console.error;
  let said = '';
  process.exit = (code) => { throw new Error(`EXIT ${code}`); };
  console.error = (message) => { said += String(message); };
  try {
    adopt.pinnedVersion(split);
    assert.fail('a split pin was accepted');
  } catch (error) {
    assert.match(error.message, /^EXIT 1$/, `refused in an unexpected way: ${error.message}`);
    assert.ok(/different releases/.test(said), `the refusal does not say why: ${said}`);
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
});

process.on('exit', () => {
  console.log(`\n${ran} checks; ${process.exitCode ? 'FAILURES' : 'all green'}`);
});

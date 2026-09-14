#!/usr/bin/env node
/**
 * test-crucible-install-seam.js — the install story: a seam that refuses by
 * name, a plan that is the real sequence, and three doors with honest states.
 *
 * Drives the COMPILED `dist/electron/crucible/install.js` (build first:
 * `npx tsc -p tsconfig.electron.json`) over a SCRIPTED host, so nothing here
 * spawns `wsl.exe`, reads `<userData>`, queries a driver or touches a guest.
 * Every branch of "what is on this machine" is driven from a fixture.
 *
 * ── WHAT IT PINS, AND WHY EACH ONE IS WORTH A TEST ──────────────────────────
 *
 * **THE SEAM REFUSES BY NAME WHEN THE PACKAGE IS ABSENT.** `@crucible/bootstrap`
 * 0.5.0 is written and is published as an asset of a Crucible release that has
 * not been cut, so it is deliberately not a dependency. The failure mode this
 * guards is the seam quietly becoming a placeholder: a loader that returned
 * `undefined`, a driven install that resolved with nothing, a button that went
 * live because somebody flipped a constant without writing the import. So the
 * refusal must carry the package's own code (`bootstrap_not_installed`), the
 * command that clears it, and the SAME sentence the disabled button wears —
 * a button saying "not yet" over a door that threw something else is a bug
 * report about a different app.
 *
 * **THE PLAN'S COMMANDS ARE WHAT CRUCIBLE'S CLI ACTUALLY TAKES.** A step list
 * is a document somebody pastes into a shell, so a wrong flag costs them the
 * time it takes to find out. Checked against the CLI's own rules as
 * `crucible/cli.py` and `sdk/bootstrap/src/install.ts` state them: one
 * `--enable-<type>` per job type; `crucible install tts` must name its narrator
 * engine (there is one env per engine); `denoise` has NO installer of its own
 * because it shares the rvc env; and `crucible models pull` takes ONE positional
 * id, so four weights are four lines and not one line with four words.
 *
 * **THE HOST-RUN COMMANDS ARE LISTED APART AND ARE THE TWO THE DOCS NAME.**
 * `wsl --install -d Ubuntu` (elevated PowerShell, then a reboot) and
 * `sudo loginctl enable-linger "$USER"`. The package's whole division of labour
 * is that it refuses by name and hands those over rather than attempting them,
 * so an app that buried them in the sequence would be promising something it
 * cannot do. macOS gets NEITHER: its service is a launchd agent.
 *
 * **THE THREE DOORS' STATES.** Door 1 is the registry and is
 * `test-crucible-servers`'s. Doors 2 and 3 are this file's: "there is a config
 * here" vs the NAMED state when there is not, and "install one here" with the
 * button disabled and a stated reason. `no_local_config` must NOT be reported
 * as a refusal — a machine that only renders on the Mac is not broken — while
 * an unreadable config must.
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
// which is the property `local.ts` and `pages.ts` are written for too.

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
    localConfig: () => ({
      present: false,
      code: 'no_local_config',
      reason: 'no local Crucible: ~/.crucible/config.toml does not exist inside WSL distro "Ubuntu".',
    }),
  };
  return Object.assign(base, overrides || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The seam
// ─────────────────────────────────────────────────────────────────────────────

check('the driven install is OFF, and one constant says so', () => {
  assert.strictEqual(
    install.DRIVEN_INSTALL_AVAILABLE, false,
    'DRIVEN_INSTALL_AVAILABLE is true — if @crucible/bootstrap really is installable now, the '
    + 'import in loadBootstrap() must be written first (see the module header) and this check '
    + 'updated deliberately, not flipped past.',
  );
});

checkAsync('loadBootstrap refuses by NAME, with the package\'s own code', async () => {
  let caught = null;
  try { await install.loadBootstrap(); } catch (err) { caught = err; }
  assert.ok(caught, 'loadBootstrap resolved — the seam has quietly become a placeholder');
  assert.strictEqual(caught.name, 'CrucibleInstallError');
  assert.strictEqual(caught.code, 'bootstrap_not_installed');
  // The rule every Crucible door in this app follows: a CLI and a settings row
  // show `err.message` and nothing else, so "refused by name" is only true
  // where the name is IN the sentence.
  assert.ok(
    caught.message.startsWith('bootstrap_not_installed: '),
    `the code is not in the message: ${caught.message}`,
  );
});

checkAsync('the refusal carries the command that clears it, and names the package', async () => {
  let caught = null;
  try { await install.loadBootstrap(); } catch (err) { caught = err; }
  assert.ok(caught.command, 'no command — the package\'s whole rule is that a refusal hands one over');
  assert.ok(
    caught.command.includes(install.BOOTSTRAP_PACKAGE),
    `the command does not name ${install.BOOTSTRAP_PACKAGE}: ${caught.command}`,
  );
  assert.ok(
    caught.command.includes(install.CRUCIBLE_BOOTSTRAP_TARBALL),
    'the command does not name the release tarball, so nobody can act on it',
  );
  assert.ok(caught.detail && caught.detail.length > 0, 'no detail explaining why it is absent');
});

checkAsync('driveCrucibleInstall refuses the same way — the DOOR, not only the button', async () => {
  let caught = null;
  try {
    await install.driveCrucibleInstall(install.bookforgeInstallOptions(() => {}, 'win32', 'Ubuntu'));
  } catch (err) { caught = err; }
  assert.ok(caught, 'driveCrucibleInstall resolved with no bootstrap package present');
  assert.strictEqual(caught.code, 'bootstrap_not_installed');
});

check('the button\'s sentence and the door\'s refusal are ONE string', () => {
  const plan = install.crucibleInstallPlan(host());
  assert.strictEqual(plan.driven, false);
  assert.strictEqual(plan.drivenWhy, install.DRIVEN_INSTALL_UNAVAILABLE);
  assert.ok(
    plan.drivenWhy.includes(install.BOOTSTRAP_PACKAGE),
    'the disabled button does not say which package it is waiting for',
  );
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
 * `BOOKFORGE_JOB_TYPES` AND `BOOKFORGE_NARRATOR_ENGINE` ARE DELETED, and the
 * check that pinned them is replaced by one that asks the file that owns them
 * now (2026-09-14, PHASE13-OPERATOR.md section 5.4).
 *
 * They were a hand-kept restatement of ids the crucible manifests own, and
 * `shared/crucible/bookforge.module.json` — GENERATED in that repo and
 * vendored here byte for byte — is the single place BookForge says what it
 * needs from a server. `tools/test-crucible-module-file.js` is what compares
 * the copy to its source; this checks the one thing THIS seam cares about:
 * the driven install asks for exactly what the module asks for, so a person
 * who pressed the button and a person who pressed "Set up for BookForge" get
 * the same server.
 */
check('the driven install asks for exactly what the vendored module asks for', () => {
  const module_ = JSON.parse(fs.readFileSync(
    path.join(REPO, 'shared', 'crucible', 'bookforge.module.json'), 'utf-8'));
  const options = install.bookforgeInstallOptions(() => {}, 'win32', 'Ubuntu');
  assert.strictEqual(options.distro, 'Ubuntu');
  assert.strictEqual(options.wheel, install.CRUCIBLE_WHEEL);

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

check('the Mac\'s Homebrew conda root travels with a darwin install, and only there', () => {
  // PHASE12 §4, measured: that Mac\'s crucible env is under the Caskroom, which
  // is none of the package\'s three default roots — so detectHost() there would
  // answer `no_python` and hand over a line that built a SECOND interpreter.
  const mac = install.bookforgeInstallOptions(() => {}, 'darwin', undefined);
  assert.deepStrictEqual([...mac.condaRoots], ['/opt/homebrew/Caskroom/miniconda/base']);
  const pc = install.bookforgeInstallOptions(() => {}, 'win32', 'Ubuntu');
  assert.strictEqual(pc.condaRoots, undefined, 'the cask root is a fact about that Mac, not a default');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The plan's commands, against crucible's own CLI rules
// ─────────────────────────────────────────────────────────────────────────────

function commandsOf(plan) {
  return plan.steps.flatMap((s) => s.commands);
}

/*
 * ── WHAT THE PLAN NO LONGER CONTAINS, AND WHY THESE CHECKS INVERTED ───────
 *
 * Six checks stood here: `--enable-<type>` on `init`, `crucible install tts
 * --narrator-engine`, the absence of `install denoise`, one id per `pull`
 * command, the four weights by name, and `capability --write` after `service
 * install`. Every one was correct about a hand sequence that has been DELETED
 * (2026-09-14, PHASE13-OPERATOR.md section 0 and 5.2).
 *
 * The argument is theirs turned around: those eleven commands were a second
 * copy of what `shared/crucible/bookforge.module.json` states and what
 * Crucible's own page installs with a button and a progress bar. Keeping them
 * in step by hand is exactly R1's shape, in the one file whose job is to be
 * correct about ids.
 *
 * So the checks below assert the ABSENCE, by name and with the reason — which
 * is the honest successor to a pin: this is a list that must stay short, and a
 * pull list creeping back into the app is the regression.
 */
check('`crucible init` carries no --enable flags — the module turns job types on', () => {
  const plan = install.crucibleInstallPlan(host());
  const init = commandsOf(plan).filter((c) => c.includes('crucible init'));
  assert.strictEqual(init.length, 1, 'init is one command or the token would be minted twice');
  assert.ok(
    !/--enable-/.test(init[0]),
    '`crucible install <type>` MERGES the flag into config.toml and reloads the registry '
    + '(PHASE13 section 3.4), so the job types are decided by "Set up for BookForge" and not '
    + `guessed at here: ${init[0]}`,
  );
});

check('the plan installs NO job environments — that is the module task', () => {
  const commands = commandsOf(install.crucibleInstallPlan(host()));
  const installs = commands.filter((c) => /crucible install /.test(c));
  assert.deepStrictEqual(
    installs, [],
    'the env installs came back into the app. They are several gigabytes each, they are what '
    + 'the vendored module asks a server for, and they are watched on the server\'s own page.',
  );
});

check('the plan pulls NO weights — the pull list is deleted', () => {
  const commands = commandsOf(install.crucibleInstallPlan(host()));
  const pulls = commands.filter((c) => /crucible (models|voices|rvc|denoise) pull/.test(c));
  assert.deepStrictEqual(
    pulls, [],
    'the printed pull list came back. Those six ids belong to the crucible manifests, are '
    + 'restated in shared/crucible/bookforge.module.json by a GENERATOR, and are pulled by the '
    + 'module task — a copy here is the thing that goes stale when a manifest is renamed.',
  );
});

check('the plan does not measure the card either — `crucible install` writes that record', () => {
  const commands = commandsOf(install.crucibleInstallPlan(host()));
  assert.ok(
    !commands.some((c) => /crucible capability --write/.test(c)),
    'capability --write is what `crucible install <type>` does as it goes (PHASE13 section 3.4), '
    + 'so a separate step for it is one more thing to forget',
  );
});

check('the service IS still installed here — it is the pre-server minute', () => {
  // The one thing above that stayed, and the reason is the phase doc's own:
  // a local Crucible is a SERVICE and no app owns it. This is the chicken-and-
  // egg a page cannot do for itself, because until `crucible init` has run
  // there is no page.
  const commands = commandsOf(install.crucibleInstallPlan(host()));
  assert.ok(
    commands.some((c) => /crucible service install/.test(c)),
    'the server is never made a service — PHASE5-APPS section 6.0 ruled it is one',
  );
});

check('the last step is Open Crucible, and it has nothing to type', () => {
  const steps = install.crucibleInstallPlan(host()).steps;
  const last = steps[steps.length - 1];
  assert.match(last.title, /Open Crucible/, `the sequence does not end at the page: ${last.title}`);
  assert.deepStrictEqual(last.commands, [], 'the last step is a button, not a command');
});

check('the wheel and the tarball name the SAME Crucible release', () => {
  assert.ok(install.CRUCIBLE_WHEEL.includes(`v${install.CRUCIBLE_RELEASE}`));
  assert.ok(install.CRUCIBLE_BOOTSTRAP_TARBALL.includes(`v${install.CRUCIBLE_RELEASE}`));
  assert.ok(
    commandsOf(install.crucibleInstallPlan(host())).some((c) => c.includes(install.CRUCIBLE_WHEEL)),
    'the plan installs a wheel it does not name',
  );
});

check('on Windows every line runs INSIDE the guest, through --exec-shaped wsl.exe', () => {
  const plan = install.crucibleInstallPlan(host());
  for (const command of commandsOf(plan)) {
    assert.ok(
      command.startsWith('wsl.exe -d Ubuntu '),
      `a Windows step runs on the host instead of in the guest: ${command}`,
    );
  }
});

check('on macOS the lines are bare — there is no guest', () => {
  const plan = install.crucibleInstallPlan(host({
    platform: 'darwin', arch: 'arm64', wslDistro: undefined,
    listWsl: () => { throw new Error('wsl.exe must not be asked on a Mac'); },
    queryGpu: () => { throw new Error('nvidia-smi must not be asked on a Mac'); },
  }));
  assert.strictEqual(plan.host.wsl, null);
  for (const command of commandsOf(plan)) {
    assert.ok(!command.includes('wsl.exe'), `a Mac step goes through wsl.exe: ${command}`);
  }
});

// ── The commands the HOST must run, listed apart ────────────────────────────

check('Windows lists the two commands BookForge cannot run, and no others', () => {
  const plan = install.crucibleInstallPlan(host());
  const elevated = plan.elevated.flatMap((s) => s.commands);
  assert.deepStrictEqual(elevated, ['wsl --install -d Ubuntu', 'sudo loginctl enable-linger "$USER"']);
  // And they are NOT in the sequence: a step somebody cannot run would stop the
  // list dead, and the whole division of labour is that these are handed over.
  const sequence = commandsOf(plan).join('\n');
  assert.ok(!sequence.includes('wsl --install'), 'an elevated command is buried in the sequence');
  assert.ok(!sequence.includes('enable-linger'), 'an elevated command is buried in the sequence');
});

check('a machine that already has WSL2 is TOLD so rather than sent to an elevated shell', () => {
  const plan = install.crucibleInstallPlan(host());
  const wslStep = plan.elevated.find((s) => s.commands.includes('wsl --install -d Ubuntu'));
  assert.strictEqual(wslStep.done, true, 'Ubuntu v2 is present and the step is not marked done');
  const first = plan.steps[0];
  assert.strictEqual(first.done, true);
  assert.ok(first.detail.includes('Ubuntu'), 'the step does not say which distro it found');
});

check('macOS needs NEITHER elevated command — its service is a launchd agent', () => {
  const plan = install.crucibleInstallPlan(host({
    platform: 'darwin', arch: 'arm64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.deepStrictEqual(plan.elevated, []);
  assert.ok(
    plan.steps.some((s) => /launchd agent/.test(s.detail)),
    'the service step does not say what it installs on a Mac',
  );
});

check('linger is a Linux fact, and Linux gets it too', () => {
  const plan = install.crucibleInstallPlan(host({
    platform: 'linux', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
  }));
  assert.deepStrictEqual(
    plan.elevated.flatMap((s) => s.commands),
    ['sudo loginctl enable-linger "$USER"'],
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
  assert.strictEqual(facts.local.present, false);
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

check('a platform Crucible has no backend for says so, and draws no sequence', () => {
  const facts = install.crucibleHostFacts(host({
    platform: 'freebsd', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.strictEqual(facts.platform, 'other');
  assert.ok(facts.refusals.some((r) => r.code === 'unsupported_platform'));
  const plan = install.crucibleInstallPlan(host({
    platform: 'freebsd', arch: 'x64', wslDistro: undefined,
    listWsl: () => { throw new Error('not asked'); },
    queryGpu: () => { throw new Error('not asked'); },
  }));
  assert.strictEqual(plan.steps.length, 1, 'a FreeBSD box was handed a Linux sequence');
  assert.deepStrictEqual(plan.steps[0].commands, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The three doors' states
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PRESENT = {
  present: true,
  serverName: 'crucible@owens-pc-wsl',
  url: 'http://127.0.0.1:7100',
  configPath: 'Ubuntu:/home/telltale/.crucible/config.toml',
  via: 'wsl',
};

check('DOOR 2 open: the config is here, and the plan says the init step is done', () => {
  const plan = install.crucibleInstallPlan(host({ localConfig: () => CONFIG_PRESENT }));
  assert.strictEqual(plan.host.local.present, true);
  assert.strictEqual(plan.host.local.serverName, 'crucible@owens-pc-wsl');
  const init = plan.steps.find((s) => s.commands.some((c) => c.includes('crucible init')));
  assert.strictEqual(init.done, true, 'a machine with a config was told to initialise again');
  assert.ok(
    plan.machine.includes('crucible@owens-pc-wsl'),
    'the one-line description does not mention the server that is already here',
  );
});

check('DOOR 2 closed: `no_local_config` is a STATE and is not reported as a refusal', () => {
  const facts = install.crucibleHostFacts(host());
  assert.strictEqual(facts.local.present, false);
  assert.ok(
    !facts.refusals.some((r) => r.code === 'no_local_config'),
    'a laptop that only ever renders on the Mac was told it is broken',
  );
});

check('DOOR 2 broken: an unreadable config IS a refusal — that one has a fix', () => {
  const facts = install.crucibleHostFacts(host({
    localConfig: () => ({
      present: false,
      code: 'config_unreadable',
      reason: 'config.toml is not valid TOML. The server would refuse it too.',
    }),
  }));
  assert.ok(facts.refusals.some((r) => r.code === 'config_unreadable'));
});

check('DOOR 3: the button is disabled and the plan states the reason', () => {
  const plan = install.crucibleInstallPlan(host());
  assert.strictEqual(plan.driven, false, 'a driven install is offered with no installer behind it');
  assert.ok(plan.drivenWhy.length > 40, 'the disabled button wears no explanation');
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

check('DOOR 3: no step claims `done` that this app has not actually checked', () => {
  const plan = install.crucibleInstallPlan(host());
  for (const step of plan.steps) {
    if (!step.done) continue;
    const checkable = /WSL2 distribution/.test(step.title) || /Initialise/.test(step.title);
    assert.ok(checkable, `"${step.title}" is ticked and nothing here verified it`);
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

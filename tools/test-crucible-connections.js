#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { installElectronStub, makeChecker } = require('./fake-crucible');
installElectronStub('bf-connect-');
const { autoConnectLocal } = require('../dist/electron/crucible/auto-connect');
const { CrucibleConnections } = require('../dist/electron/crucible/connect');
const { upgradeWsl } = require('../dist/electron/crucible/engine-upgrade');
const { FirstRunModels } = require('../dist/electron/crucible/first-run-models');
const { HostInstallDoor, installOutcomeIsTerminal } = require('../dist/electron/crucible/install-door');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, summary } = makeChecker();
const pairing = { name: 'desk', url: 'http://127.0.0.1:7100', token: 'private-token' };
const request = { ...pairing, id: 'server-request', userCode: 'CODE-1234', deviceCode: 'private-device', expiresIn: 60, interval: 1 };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

/*
 * A SCRIPTED INSTALL DOOR (crucible PHASE19 §2.2, §2.6).
 *
 * `HostInstallDoor` takes its world as an `InstallDoorHost`, which exists for
 * this: the live door is on 127.0.0.1:7101 and on this PC that is a real
 * Crucible with a real engine behind it.
 */
const doorHost = (over = {}) => ({
  runner: () => ({ platform: 'win32' }),
  installed: () => true,
  status: async () => ({ running: false, outcome: null, presence: {} }),
  watch: async () => ({ running: false, outcome: null, presence: {} }),
  post: async () => {},
  ...over,
});
/** `wsl-outcome.json`, with the six fields §2.2 gives it. */
const anOutcome = (state, over = {}) => ({
  state, code: null, sentence: null, at: '2026-09-19T12:00:00Z', release: '1.0.5', attempts: 1, ...over,
});

function wizardProbe(names) {
  const ts = require('typescript');
  const vm = require('node:vm');
  const source = ts.createSourceFile('wizard.ts', fs.readFileSync(path.join(__dirname,
    '../src/app/features/ai-setup/ai-setup-wizard.component.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const klass = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'AiSetupWizardComponent');
  const methods = klass.members.filter(node => ts.isMethodDeclaration(node) && names.includes(node.name.getText(source)));
  assert.equal(methods.length, names.length);
  const code = ts.transpileModule(`class Probe { ${methods.map(node => node.getText(source)).join('\n')} }; Probe;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new (vm.runInNewContext(code))();
}

async function main() {
  await check('late engine reads and writes never redraw a newly selected server', async () => {
    for (const [method, api] of [['loadCapability', 'capability'], ['loadEngineSettings', 'engineSettings'],
      ['loadCrucibleModels', 'models'], ['writeEngineSettings', 'writeEngineSettings']]) {
      const probe = wizardProbe([method]); const reply = defer(); let server = 'old';
      const changed = [];
      Object.assign(probe, { crucibleServer: () => server,
        electron: { crucible: { [api]: async () => reply.promise } },
        capability: { set: v => changed.push(v) }, crucibleModels: { set: v => changed.push(v) },
        redrawEngineSettings: v => changed.push(v), crucibleStatus: { set: v => changed.push(v) },
        placeRefusal: v => changed.push(v), engineBusy: { set() {} }, wizard: () => false,
        loadCapability: method === 'loadCapability' ? probe.loadCapability : async () => changed.push('wrong refresh'),
      });
      const pending = probe[method](method === 'loadCrucibleModels' ? 'old' : {});
      server = 'new';
      reply.resolve({ success: true, data: { outcome: 'ok', models: ['old-model'] } });
      await pending;
      assert.deepEqual(changed, [], `${method} applied an old server's answer`);
    }
  });
  await check('switching servers during provider test cannot forward the old credential to the new engine', async () => {
    const probe = wizardProbe(['connectAndRoute']); const reply = defer(); let server = 'old'; const writes = [];
    Object.assign(probe, { crucibleServer: () => server, offerUpstream: () => 'openai',
      probeFor: () => ({ key: 'old-server-only' }), offerModel: () => 'model', engineBusy: { set() {} },
      electron: { crucible: { testUpstream: async () => reply.promise } }, testedModels: { update() {} },
      writeEngineSettings: async patch => writes.push({ server, patch }),
    });
    const pending = probe.connectAndRoute('clean'); server = 'new';
    reply.resolve({ success: true, data: { ok: true, models: ['model'] } }); await pending;
    assert.deepEqual(writes, []);
  });
  await check('first-run model preparation waits across restart until AI choices are finished', () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-model-setup-')), 'pending');
    const fresh = new FirstRunModels(marker, true);
    assert.equal(fresh.pending, true);
    const restartedAfterLibraryChoice = new FirstRunModels(marker, false);
    assert.equal(restartedAfterLibraryChoice.pending, true);
    assert.equal(restartedAfterLibraryChoice.complete(), true);
    assert.equal(restartedAfterLibraryChoice.pending, false);
    assert.equal(restartedAfterLibraryChoice.complete(), false);
    assert.equal(new FirstRunModels(marker, false).pending, false);
    fs.rmdirSync(path.dirname(marker));
  });
  await check('a failed setup marker update keeps model preparation deferred', () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-model-setup-')), 'pending');
    const gate = new FirstRunModels(marker, true);
    fs.unlinkSync(marker);
    assert.throws(() => gate.complete(), /ENOENT/);
    assert.equal(gate.pending, true);
    fs.rmdirSync(path.dirname(marker));
  });
  await check('connect and renderer coordination entrypoints cannot pull during unfinished setup', async () => {
    const ts = require('typescript');
    const vm = require('node:vm');
    const source = ts.createSourceFile('main.ts', fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8'),
      ts.ScriptTarget.Latest, true);
    const entrypoints = [];
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'coordinateWithServer') entrypoints.push(node.initializer);
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle'
        && node.arguments[0]?.getText(source) === "'bookforge:crucible-coordinate'") entrypoints.push(node.arguments[1]);
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.equal(entrypoints.length, 2);
    /*
     * THE SECOND GATE IS PHASE19 §2.8's. Coordination installs job
     * environments and pulls weights — gigabytes — and run against the NATIVE
     * Windows engine on a machine that is still moving to the Linux one they
     * land on Windows and migrate-weights pays for them twice. So a move with
     * no outcome yet holds the LOCAL engine's coordination and nothing else:
     * an engine on another machine is not affected by this machine's move.
     */
    const install = (running, state) => ({
      status: async () => ({ running, outcome: state === null ? null : anOutcome(state) }),
    });
    const cases = [
      // [first-run pending, install door, is the named row this machine's engine, expected runs]
      [true, install(false, null), false, 0],
      [false, install(false, null), false, 1],
      [false, install(true, null), true, 0],
      [false, install(true, null), false, 1],
      // A terminal outcome is what lets it through, even while the run is
      // still winding up: the install's own "it was installed" is the first
      // caller through this gate.
      [false, install(true, 'done'), true, 1],
      [false, install(true, 'cannot'), true, 1],
      [false, install(true, 'reboot-pending'), true, 1],
      // `failed` IS NOT TERMINAL — the tray retries it once, and coordinating
      // between the two attempts installs gigabytes onto an engine the second
      // one is about to replace. The rule is the SDK's list, not a null check.
      [false, install(true, 'failed'), true, 0],
      // A machine that never moved at all is not held for ever.
      [false, install(false, 'declined'), true, 1],
    ];
    for (const entrypoint of entrypoints) {
      for (const [pending, door, local, expected] of cases) {
        let requests = 0;
        const code = ts.transpileModule(`(${entrypoint.getText(source)})('desk', 'connected')`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
        }).outputText;
        await vm.runInNewContext(code, {
          firstRunModels: { pending },
          crucibleInstallDoor: door,
          // THE REAL RULE, imported: the gate is only right if `failed` is not
          // terminal, and a stub that said `outcome !== null` would pass a main.ts
          // that had the wrong one.
          installOutcomeIsTerminal,
          isTheEngineOnThisComputer: async () => local,
          require: () => ({ coordinateServer: async () => { requests++; return { phase: 'stocked' }; } }),
          getMainLogger: () => ({ info() {}, warn() {} }),
        });
        assert.equal(
          requests, expected,
          `pending=${pending} running=${door !== null} local=${local}: expected ${expected} run(s)`,
        );
      }
    }
  });
  await check('Finish waits for readiness, retains restart state on failure, and retries once', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-model-ready-')), 'pending');
    const gate = new FirstRunModels(marker, true);
    const delayed = defer(); let calls = 0; let completed = false;
    const pending = gate.finish(async () => { calls++; await delayed.promise; throw Error('model download failed'); });
    assert.equal(gate.pending, false, 'coordinators may run while preparing');
    assert.equal(gate.finish(async () => { calls++; }), pending, 'duplicate Finish joins the same preparation');
    pending.then(() => { completed = true; }, () => {});
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(fs.existsSync(marker), true, 'restart must resume unfinished preparation');
    delayed.resolve();
    await assert.rejects(pending, /model download failed/);
    assert.equal(gate.pending, true);
    assert.equal(new FirstRunModels(marker, false).pending, true);
    await gate.finish(async () => { calls++; });
    assert.equal(gate.pending, false);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(calls, 2);
    fs.rmdirSync(path.dirname(marker));
  });
  await check('setup has no legacy download path and selects the engine-owned cleanup route', async () => {
    /*
     * RENAMED AND REWRITTEN 2026-09-17. It used to prove that the bundled
     * local-AI card was HIDDEN during first-run while its `download` method
     * stayed available for maintenance afterwards. Owen retired that provider
     * outright ("'AI' page - it has bundled local ai. that's nullified right?
     * remove it."), so there is no card to hide and no method to guard.
     *
     * What is left worth pinning is the half that still matters: choosing the
     * engine writes THE SERVER AND NOTHING ELSE, and nothing in this component
     * can start a local download any more.
     *
     * AMENDED 2026-09-17 (later the same day). It asserted the model was saved
     * too — `capability.selected` for `clean`, read at that instant. That made
     * the app a SECOND owner of a decision the engine makes per capability
     * class, and the app's copy WON: an id stored here overrode anything later
     * chosen on the AI page, so somebody could pick a model, watch it save, and
     * have a different one do the work. The model is a run-time STAMP now
     * (`stampCrucibleModelForRun`), read from the server at the start of each
     * run, and no settings page writes one. So the assertion is inverted: a
     * saved model is the defect.
     */
    const ts = require('typescript');
    const vm = require('node:vm');
    const file = fs.readFileSync(path.join(__dirname, '../src/app/features/ai-setup/ai-setup-wizard.component.ts'), 'utf8');
    const source = ts.createSourceFile('wizard.ts', file, ts.ScriptTarget.Latest, true);
    const klass = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'AiSetupWizardComponent');
    const methods = klass.members.filter((node) => ts.isMethodDeclaration(node)
      && ['useCrucible'].includes(node.name.getText(source)));
    assert.equal(methods.length, 1);
    const code = ts.transpileModule(`class WizardProbe { ${methods.map((node) => node.getText(source)).join('\n')} }; WizardProbe;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const Probe = vm.runInNewContext(code);
    const probe = new Probe(); let saved;
    Object.assign(probe, {
      wizard: () => true, ai: { refresh: async () => {} },
      crucibleServer: () => 'desk',
      settings: { updateAIConfig: (value) => { saved = value; } },
    });
    probe.useCrucible();
    assert.equal(saved.provider, 'crucible');
    assert.equal(saved.crucible.server, 'desk');
    assert.deepStrictEqual(Object.keys(saved.crucible), ['server'],
      'choosing an engine saved something besides its name. The server is the ONE AI fact this '
      + 'app stores; a model saved beside it overrides the per-class choice made on the AI page.');

    // The retirement, asserted the strong way round: not "hidden from setup"
    // but absent everywhere, machinery included.
    // MATCHED ON MARKUP, NOT ON THE PHRASE. The component still explains the
    // retirement in a comment, and a bare /Bundled local AI/ matched THAT — a
    // test that passes only while nobody documents the thing it checks.
    assert.ok(!/<h2>[^<]*Bundled local AI/.test(file), 'the bundled local AI card is gone');
    // STRUCTURAL, NOT TEXTUAL. A /downloadedModels/ over the source matched the
    // COMMENT that explains the removal, so the test failed on its own
    // documentation. The AST is already parsed above; ask it what members the
    // class actually has.
    const memberNames = klass.members
      .filter((node) => node.name && typeof node.name.getText === 'function')
      .map((node) => node.name.getText(source));
    for (const gone of ['downloadedModels', 'confirmDeleteModels', 'deleteAllModels',
      'download', 'cancel', 'remove', 'sysInfo']) {
      assert.ok(!memberNames.includes(gone), `${gone} is gone with the card it served`);
    }
  });
  await check('first launch verifies and adds the existing engine as an ordinary row', async () => {
    const calls = [];
    const name = await autoConnectLocal(false, { registryExists: () => false, pairing: () => pairing,
      list: () => [], verify: async p => { calls.push(['verify', p]); }, add: p => { calls.push(['add', p]); return p; } });
    assert.equal(name, 'desk'); assert.deepEqual(calls.map(c => c[0]), ['verify', 'add']);
  });
  await check('an existing empty registry preserves a deliberate removal', async () => {
    assert.equal(await autoConnectLocal(false, { registryExists: () => true,
      pairing: () => { throw Error('must not discover'); } }), null);
  });
  await check('fresh machine with no pairing leaves install choice available', async () => {
    assert.equal(await autoConnectLocal(false, { registryExists: () => false, pairing: () => null }), null);
  });
  await check('explicit install must connect and cannot claim success without a pairing', async () => {
    // The sentence names what to press IN BOOKFORGE (PHASE19 §4). It used to
    // say "Open Crucible and try connecting again", which was a door this app
    // stopped having on 2026-09-17.
    await assert.rejects(
      autoConnectLocal(true, { registryExists: () => true, pairing: () => null }),
      /did not publish how to reach it.*Settings → Crucible Servers/s,
    );
  });
  await check('failed identity verification never writes registry', async () => {
    await assert.rejects(autoConnectLocal(false, { registryExists: () => false, pairing: () => pairing,
      list: () => [], verify: async () => { throw Error('identity mismatch'); }, add: () => { throw Error('write'); } }), /identity mismatch/);
  });
  await check('install with already registered endpoint preserves its chosen name', async () => {
    assert.equal(await autoConnectLocal(true, { pairing: () => pairing, list: () => [{ name: 'My PC', url: pairing.url + '/' }] }), 'My PC');
  });
  await check('concurrent first reads add once after verification', async () => {
    const rows = []; let writes = 0;
    const deps = { registryExists: () => false, pairing: () => pairing, list: () => rows,
      verify: async () => {}, add: p => { rows.push(p); writes++; return p; } };
    assert.deepEqual(await Promise.all([autoConnectLocal(false, deps), autoConnectLocal(false, deps)]), ['desk', 'desk']);
    assert.equal(writes, 1);
  });
  await check('renderer receives only short code, no bearer or device credential', async () => {
    const connections = new CrucibleConnections({ start: async () => request });
    const prompt = await connections.start(1, 'desk');
    assert.equal(prompt.userCode, request.userCode);
    assert.equal(JSON.stringify(prompt).includes('private'), false);
    assert.equal('deviceCode' in prompt, false); assert.equal('token' in prompt, false);
    connections.cancel(1);
  });
  await check('another window cannot poll the private pending request', async () => {
    const connections = new CrucibleConnections({ start: async () => request });
    const prompt = await connections.start(1, 'desk');
    await assert.rejects(connections.poll(2, prompt.requestId), /no longer active/);
    connections.cancel(1);
  });
  await check('overlapping polls save an approved connection exactly once', async () => {
    const reply = defer(); let polls = 0; let adds = 0;
    const connections = new CrucibleConnections({ start: async () => request,
      poll: async () => { polls++; return reply.promise; }, add: p => { adds++; return p; } });
    const prompt = await connections.start(1, 'desk');
    const a = connections.poll(1, prompt.requestId); const b = connections.poll(1, prompt.requestId);
    reply.resolve({ status: 'approved', pairing });
    assert.deepEqual(await a, { status: 'approved', name: 'desk' }); await b;
    assert.equal(polls, 1); assert.equal(adds, 1);
  });
  await check('cancel during an approval response never saves a connection', async () => {
    const reply = defer(); let adds = 0;
    const connections = new CrucibleConnections({ start: async () => request,
      poll: async () => reply.promise, add: p => { adds++; return p; } });
    const prompt = await connections.start(1, 'desk');
    const poll = connections.poll(1, prompt.requestId); connections.cancel(1);
    reply.resolve({ status: 'approved', pairing });
    await assert.rejects(poll, /cancelled/); assert.equal(adds, 0);
  });
  await check('cancel during discovery does not leave a hidden pending request', async () => {
    const reply = defer();
    const connections = new CrucibleConnections({ start: async () => reply.promise });
    const start = connections.start(1, 'desk'); connections.cancel(1); reply.resolve(request);
    await assert.rejects(start, /cancelled/);
  });
  await check('declined requests never write a registry entry', async () => {
    const connections = new CrucibleConnections({ start: async () => request,
      poll: async () => ({ status: 'denied' }), add: () => { throw Error('unexpected write'); } });
    const prompt = await connections.start(1, 'desk');
    assert.deepEqual(await connections.poll(1, prompt.requestId), { status: 'denied' });
  });
  await check('WSL upgrade follows the engine task and verifies the new backend after stream interruption', async () => {
    const progress = []; let infos = 0; let forgotten = false;
    const client = {
      info: async () => ({ server: { apiVersion: 1 }, host: { backend: infos++ === 0 ? 'llama-windows' : 'cuda-linux' } }),
      submitTask: async body => { assert.deepEqual(body, { type: 'engine', target: 'wsl' }); return 'task'; },
      taskEvents: async function* () { yield { event: 'step', data: { name: 'Download WSL engine' } }; throw Error('switch'); },
    };
    await upgradeWsl('desk', p => progress.push(p), { client: async () => client, pause: async () => {}, forget: () => { forgotten = true; } });
    assert.equal(progress.at(-1).state, 'done'); assert.equal(forgotten, true); assert.equal(infos, 2);
  });
  await check('WSL task named failure is shown verbatim and never reported done', async () => {
    const progress = [];
    const client = { info: async () => ({ host: { backend: 'llama-windows' } }), submitTask: async () => 'task',
      taskEvents: async function* () { yield { event: 'failed', data: { code: 'server_busy', message: 'training is active' } }; } };
    await assert.rejects(upgradeWsl('desk', p => progress.push(p), { client: async () => client }), /server_busy: training is active/);
    assert.equal(progress.at(-1).state, 'failed');
  });
  await check('WSL stream completion cannot claim success while native backend still answers', async () => {
    const progress = []; let waits = 0;
    const client = { info: async () => ({ server: { apiVersion: 1 }, host: { backend: 'llama-windows' } }), submitTask: async () => 'task',
      taskEvents: async function* () { yield { event: 'done', data: {} }; } };
    await assert.rejects(upgradeWsl('desk', p => progress.push(p), { client: async () => client, pause: async () => { waits++; }, forget: () => {} }), /not returned a working/);
    assert.equal(waits, 30); assert.equal(progress.at(-1).state, 'failed');
  });
  await check('non-Windows backend refuses WSL upgrade before task submission', async () => {
    const client = { info: async () => ({ host: { backend: 'mlx-darwin' } }), submitTask: () => { throw Error('must not submit'); } };
    await assert.rejects(upgradeWsl('mac', () => {}, { client: async () => client }), /native Windows engine only/);
  });

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * THE ORCHESTRATOR'S INSTALL DOOR (crucible PHASE19 §2.5, §2.6, §2.8)
   * ───────────────────────────────────────────────────────────────────────────
   *
   * `HostInstallDoor` is the one thing in this app that asks how this machine's
   * move to the Linux engine is going. Driven here over a scripted
   * `InstallDoorHost` — the interface exists for exactly this — so nothing
   * reaches the live door on 7101, which on this PC is a real Crucible.
   */
  await check('the terminal partition is the SDK\'s, and `failed` is not in it', () => {
    const bootstrap = require('@crucible/bootstrap');
    assert.deepEqual([...bootstrap.TERMINAL_OUTCOME_STATES].sort(),
      ['cannot', 'declined', 'done', 'reboot-pending']);
    /*
     * `failed` IS DELIBERATELY ABSENT. The tray retries a failure once, so an
     * app that treated the first one as the end would coordinate — install job
     * environments, pull weights — onto an engine the second attempt is about
     * to replace. BookForge held a hand-written `outcome !== null` for a day
     * and it was wrong in exactly this case.
     */
    assert.equal(installOutcomeIsTerminal(anOutcome('failed')), false);
    assert.equal(installOutcomeIsTerminal(anOutcome('done')), true);
    assert.equal(installOutcomeIsTerminal(anOutcome('cannot')), true);
    assert.equal(installOutcomeIsTerminal(anOutcome('reboot-pending')), true);
    assert.equal(installOutcomeIsTerminal(anOutcome('declined')), true);
    assert.equal(installOutcomeIsTerminal(null), false);
  });

  await check('a machine with no host pack has had no move, and its door is never dialled', async () => {
    let asked = 0;
    const door = new HostInstallDoor(doorHost({
      installed: () => false,
      status: async () => { asked += 1; throw Error('the door must not be asked'); },
    }));
    assert.deepEqual(await door.status(), { running: false, outcome: null });
    assert.equal(asked, 0);
    // And off Windows there is no WSL move to have an outcome about at all.
    const mac = new HostInstallDoor(doorHost({
      runner: () => ({ platform: 'darwin' }),
      status: async () => { throw Error('a Mac has no host door'); },
    }));
    assert.deepEqual(await mac.status(), { running: false, outcome: null });
  });

  await check('the outcome the door reports is the outcome the app carries', async () => {
    for (const state of ['done', 'reboot-pending', 'cannot', 'failed', 'declined']) {
      const recorded = anOutcome(state, { code: 'x_code', sentence: 'A sentence its owner wrote.' });
      const door = new HostInstallDoor(doorHost({
        status: async () => ({ running: false, outcome: recorded, presence: {} }),
      }));
      const status = await door.status();
      assert.deepEqual(status.outcome, recorded, `${state} did not cross whole`);
    }
  });

  await check('a move\'s events reach every watcher, and its ENDING comes from the outcome', async () => {
    const recorded = anOutcome('cannot', { code: 'virtualization_disabled', sentence: 'It is off in the firmware.' });
    const door = new HostInstallDoor(doorHost({
      status: async () => ({ running: true, outcome: null, presence: {} }),
      watch: async (sinks) => {
        // A TICK FIRST, as a real door does: `watchInstall` polls `GET /install`
        // and then attaches over HTTP, so every window open when the move is
        // running is subscribed before a frame arrives. A watcher that joins
        // mid-stream sees it from where it joined — that is the door's ring,
        // not this seam's business.
        await new Promise(r => setTimeout(r, 0));
        sinks.onEvent({ id: 1, event: 'step', data: { name: 'image', index: 1, total: 4 } });
        sinks.onEvent({ id: 2, event: 'line', data: { text: 'fetching', stream: 'stdout' } });
        sinks.onEvent({ id: 3, event: 'progress', data: { bytes_done: 1, bytes_total: 2, file: 'ubuntu' } });
        // A `failed` FRAME is one step's news; the outcome is the machine's.
        sinks.onEvent({ id: 4, event: 'failed', data: { code: 'virtualization_disabled', message: 'off' } });
        return { running: false, outcome: recorded, presence: {} };
      },
    }));
    const one = []; const two = [];
    const stop = door.watch(e => one.push(e));
    door.watch(e => two.push(e));
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(one.map(e => e.event), ['step', 'line', 'progress', 'error']);
    assert.deepEqual(two.map(e => e.event), one.map(e => e.event), 'a second window saw a different move');
    // A line belongs to the last step the door named — the SDK's own rule.
    assert.equal(one.find(e => e.event === 'line').step, 'image');
    assert.deepEqual(one.at(-1).outcome, recorded);
    stop();
  });

  await check('subscribing waits for nothing; Try again waits for the tray to decide', async () => {
    /*
     * `watchInstall`'s default wait is 195 s — the SDK's own citation of the
     * tray's presence-settle ceiling — which is right for a caller that has
     * just asked for a move and wrong for a settings panel merely opening:
     * that would be three minutes of polling a door four times a second on a
     * machine where nothing is happening.
     */
    const waits = [];
    const door = new HostInstallDoor(doorHost({
      status: async () => ({ running: false, outcome: anOutcome('cannot', { code: 'c', sentence: 's' }), presence: {} }),
      watch: async (sinks) => { waits.push(sinks.decisionWaitMs); return { running: false, outcome: null, presence: {} }; },
    }));
    door.watch(() => {});
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(waits, [0], 'opening a panel asked the door to wait for a move nobody requested');
    await door.start();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(waits, [0, undefined], 'Try again did not wait for the tray to pick its POST up');
  });

  await check('Try again POSTs the move the machine already attempted, and 409 is not an error', async () => {
    const posted = [];
    const door = new HostInstallDoor(doorHost({
      status: async () => ({ running: false, outcome: anOutcome('cannot', { code: 'c', sentence: 's' }), presence: {} }),
      post: async (release) => { posted.push(release); },
    }));
    await door.start();
    assert.deepEqual(posted, ['1.0.5'],
      'Try again asked for a different release; it retries the move, it does not upgrade');

    // 409 host_install_running is the door saying "it is already happening",
    // which is what the person pressing Try again wanted.
    const busy = new HostInstallDoor(doorHost({
      status: async () => ({ running: false, outcome: anOutcome('failed', { code: 'c', sentence: 's' }), presence: {} }),
      post: async () => { throw Object.assign(Error('already'), { code: 'host_install_running' }); },
    }));
    await busy.start();

    // Anything else is still an error, by its own name.
    const broken = new HostInstallDoor(doorHost({
      status: async () => ({ running: false, outcome: anOutcome('failed', { code: 'c', sentence: 's' }), presence: {} }),
      post: async () => { throw Object.assign(Error('refused'), { code: 'host_unauthorized' }); },
    }));
    await assert.rejects(broken.start(), /refused/);

    // And a machine with nothing recorded has nothing to try again.
    const fresh = new HostInstallDoor(doorHost({
      post: async () => { throw Error('must not post'); },
    }));
    await assert.rejects(fresh.start(), /no_install_outcome/);
  });

  /*
   * WHAT EACH OUTCOME PUTS ON THE SCREEN (§3.1, §2.5).
   *
   * Read out of the two components' TEMPLATES, because that is where the rule
   * actually lives and a test that re-stated it in JavaScript would be a second
   * copy of the thing it is checking. The five states and the two controls are
   * few enough that the whole table is asserted rather than a sample.
   */
  const branchOf = (template, state) => {
    const open = template.indexOf(`result.state === '${state}'`);
    if (open < 0) return null;
    const next = [...template.matchAll(/result\.state === '([a-z-]+)'/g)]
      .map(m => m.index).find(index => index > open);
    return template.slice(open, next === undefined ? template.length : next);
  };
  const templateOf = (file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = source.indexOf('template: `');
    const end = source.indexOf('\n  `,', start);
    assert.ok(start > 0 && end > start, `no template found in ${file}`);
    return source.slice(start, end);
  };

  await check('the progress list draws exactly one control per outcome, and none on done', () => {
    const template = templateOf('src/app/features/settings/components/crucible-install-progress.component.ts');
    const cannot = branchOf(template, 'cannot');
    assert.ok(cannot, 'the progress list has no `cannot` branch');
    assert.match(cannot, /result\.sentence/, 'a cannot machine is not shown the state table\'s sentence');
    assert.match(cannot, /tryAgain\(\)/, 'a cannot machine is not offered Try again (PHASE19 2.5)');
    assert.ok(!/restartNow\(\)/.test(cannot), 'a cannot machine is offered a restart it does not need');

    const reboot = branchOf(template, 'reboot-pending');
    assert.ok(reboot, 'the progress list has no `reboot-pending` branch');
    assert.match(reboot, /restartNow\(\)/, 'a machine owed a restart is not offered Restart now');
    assert.ok(!/tryAgain\(\)/.test(reboot), 'a machine owed a restart is offered Try again instead');

    const failed = branchOf(template, 'failed');
    assert.ok(failed, 'the progress list has no `failed` branch');
    assert.match(failed, /result\.sentence/);
    assert.match(failed, /tryAgain\(\)/);

    // `done` HAS NO BRANCH AT ALL, and that is the assertion: §2.5 says on a
    // finished machine there is no control, so the absence is the contract.
    assert.equal(branchOf(template, 'done'), null,
      'the progress list grew a control for a finished machine; §2.5 says there is none');
    // The finished machine's one line is the last ROW, not a button.
    assert.match(
      fs.readFileSync(path.join(__dirname, '..',
        'src/app/features/settings/components/crucible-install-progress.component.ts'), 'utf8'),
      /Done — running on the Linux engine/,
    );
  });

  await check('the engine-controls readout offers the same two controls, and nothing on done', () => {
    const template = templateOf('src/app/features/settings/components/crucible-engine-controls.component.ts');
    assert.ok(!/Enable WSL acceleration/.test(template),
      'the WSL opt-in button is back; PHASE19 makes the move automatic');
    const cannot = branchOf(template, 'cannot');
    assert.match(cannot, /result\.sentence/);
    assert.match(cannot, /tryAgain\(\)/);
    const reboot = branchOf(template, 'reboot-pending');
    assert.match(reboot, /restartNow\(\)/);
    assert.ok(!/tryAgain\(\)/.test(reboot));
    assert.equal(branchOf(template, 'done'), null, 'a finished machine has a control on its row');
  });

  summary('Crucible first launch and connections');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

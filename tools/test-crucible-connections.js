#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { installElectronStub, makeChecker } = require('./fake-crucible');
installElectronStub('bf-connect-');
const { autoConnectLocal } = require('../dist/electron/crucible/auto-connect');
const { CrucibleConnections } = require('../dist/electron/crucible/connect');
const { upgradeWsl } = require('../dist/electron/crucible/engine-upgrade');
const { FirstRunModels } = require('../dist/electron/crucible/first-run-models');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, summary } = makeChecker();
const pairing = { name: 'desk', url: 'http://127.0.0.1:7100', token: 'private-token' };
const request = { ...pairing, id: 'server-request', userCode: 'CODE-1234', deviceCode: 'private-device', expiresIn: 60, interval: 1 };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

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
    const install = (running, outcome) => ({ status: async () => ({ running, outcome }) });
    const cases = [
      // [first-run pending, install door, is the named row this machine's engine, expected runs]
      [true, install(false, null), false, 0],
      [false, install(false, null), false, 1],
      [false, install(true, null), true, 0],
      [false, install(true, null), false, 1],
      // A terminal outcome is what lets it through, even while the run is
      // still winding up: the install's own "it was installed" is the first
      // caller through this gate.
      [false, install(true, { state: 'done' }), true, 1],
      [false, install(true, { state: 'cannot' }), true, 1],
      // A machine that never moved at all is not held for ever.
      [false, install(false, { state: 'declined' }), true, 1],
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
          installOutcomeIsTerminal: (outcome) => outcome !== null,
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
  summary('Crucible first launch and connections');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

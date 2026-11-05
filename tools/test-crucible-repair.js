#!/usr/bin/env node
/**
 * REPAIR A CRUCIBLE, AND NEVER OFFER TO INSTALL A SECOND ONE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-repair.js
 *
 * No live server has the `repair` task yet and a real repair must not be run on real
 * envs, so this is a FAKE speaking the task's documented frames. It pins: the remote
 * door end to end through the one reducer; the local door through the same events; an
 * older server's refusal as a sentence rather than a crash; a dropped stream reconnected;
 * a headline that never claims more than was checked; and detect-first.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const DOOR = path.join(REPO, 'dist', 'electron', 'crucible', 'repair.js');
if (!fs.existsSync(DOOR)) {
  console.log(skipLine('dist/electron/crucible/repair.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
installElectronStub('bf-crucible-repair-');
const door = require(DOOR);
const wire = require(path.join(REPO, 'dist', 'shared', 'crucible', 'repair-wire.js'));
const install = require(path.join(REPO, 'dist', 'electron', 'crucible', 'install.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

const ENV = { kind: 'env', id: 'asr' };
const WEIGHTS = { kind: 'asr', id: 'qwen3-asr-1.7b' };
const RESULT = {
  healthy: true, verifyOnly: false, checked: [ENV, WEIGHTS],
  broken: [{ subject: WEIGHTS, was: 'hash mismatch in model.safetensors' }],
  repaired: [{ subject: WEIGHTS, was: 'hash mismatch in model.safetensors' }],
  failed: [], unverified: [],
  notHashChecked: [{ subject: ENV, files: ['a.pyc'], why: 'generated at install' }],
  bytesHashed: 5e9, bytesSkippedVerified: 2e9,
};
const WIRE_RESULT = {
  healthy: true, verify_only: false, checked: [ENV, WEIGHTS],
  broken: [{ subject: WEIGHTS, was: 'hash mismatch in model.safetensors' }],
  repaired: [{ subject: WEIGHTS, was: 'hash mismatch in model.safetensors' }],
  failed: [], unverified: [],
  not_hash_checked: [{ subject: ENV, files: ['a.pyc'], why: 'generated at install' }],
  bytes_hashed: 5e9, bytes_skipped_verified: 2e9,
};

/** `behaviour`: 'run' | 'old' (2.0.34: invalid_request) | 'drop' (the first stream dies) | 'failed'. */
function startFake(behaviour) {
  let streams = 0;
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;
    if (route === '/v1/tasks' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      if (behaviour === 'old') {
        // crucible v2.0.34 api/app.py _validation_refusal: 400, not 422.
        send(res, 400, { error: { code: 'invalid_request', message: "body.type: Input should be 'pull', 'install', 'module' or 'engine'", details: { problems: [] } } });
        return true;
      }
      send(res, 200, { task_id: 'task-1' });
      return true;
    }
    if (route === '/v1/tasks/task-1/events' && req.method === 'GET') {
      streams += 1;
      if (behaviour === 'drop' && streams === 1) { req.socket.destroy(); return true; }
      const sse = sseWriter(req, res);
      sse.frame('started', { type: 'repair' });
      sse.frame('repair', { step: 'plan', state: 'running', subject: null, detail: 'reading 7 GB', bytes_to_check: 7e9 });
      sse.frame('repair', { step: 'wait', state: 'running', subject: ENV, detail: 'env asr is in use by a job', bytes_to_check: null });
      sse.frame('progress', { bytes_done: 1e9, bytes_total: 7e9, file: 'model.safetensors' });
      sse.frame('repair', { step: 'repull', state: 'repaired', subject: WEIGHTS, detail: null, bytes_to_check: null });
      if (behaviour === 'failed') sse.frame('failed', { code: 'repair_failed', message: 'the disk is full' });
      else sse.frame('done', {});
      sse.end();
      return true;
    }
    if (route === '/v1/tasks/task-1' && req.method === 'GET') {
      send(res, 200, {
        task_id: 'task-1', type: 'repair', request: { type: 'repair' },
        state: behaviour === 'failed' ? 'failed' : 'done',
        error: behaviour === 'failed' ? { code: 'repair_failed', message: 'the disk is full' } : null,
        created: '2026-11-05T00:00:00Z', started: '2026-11-05T00:00:00Z', finished: '2026-11-05T00:01:00Z',
        unmet: [], message: null, result: behaviour === 'failed' ? null : WIRE_RESULT,
      });
      return true;
    }
    return false;
  });
}

const remoteDeps = { isLocal: async () => false, localRepair: async () => { throw new Error('the local door was used for a remote row'); }, sleep: async () => {} };

async function run(server, verifyOnly, deps) {
  const events = [];
  await door.repairCrucibleServer(server, { verifyOnly }, (e) => events.push(e), deps);
  let view = null;
  const views = [];
  for (const e of events) { view = wire.reduceCrucibleRepair(view, e); views.push(view); }
  return { events, view, views };
}

async function main() {
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const { view, views } = await run(server, false, remoteDeps);
    await fake.close();
    await check('a remote row submits the repair task and ends on the one result', () => {
      assert.deepStrictEqual(fake.state.submitted[0], { type: 'repair', scope: { verify_only: false } });
      assert.strictEqual(view.phase, 'done');
      assert.strictEqual(view.local, false);
      assert.strictEqual(view.result.repaired[0].was, 'hash mismatch in model.safetensors');
      assert.strictEqual(view.result.bytesHashed, 5e9);
    });
    await check('progress counts from the plan, and a wait frame says what is in use', () => {
      assert.ok(views.some((v) => v.bytesToCheck === 7e9), 'the plan byte count reached the view');
      assert.ok(views.some((v) => v.bytesDone === 1e9 && v.file === 'model.safetensors'));
      assert.ok(views.some((v) => /in use/.test(v.waiting ?? '')));
      assert.strictEqual(view.waiting, null, 'a finished repair is not waiting');
    });
    await check('the headline names what was checked, and what could not be fully verified', () => {
      const line = wire.crucibleRepairHeadline(view.result);
      assert.match(line, /1 repaired/);
      assert.match(line, /2 items checked/);
      assert.match(line, /1 could not be fully verified/);
    });
  }

  {
    const fake = await startFake('old');
    const server = registerFake(fake.url);
    const { view } = await run(server, true, remoteDeps);
    await fake.close();
    await check('an older server is a sentence saying it needs updating, not a crash', () => {
      assert.strictEqual(view.phase, 'refused');
      assert.strictEqual(view.refusal.needsUpdate, true);
      assert.match(view.refusal.message, /too old to repair itself/);
      assert.match(view.refusal.message, /Nothing was checked or changed/);
    });
  }

  {
    const fake = await startFake('drop');
    const server = registerFake(fake.url);
    const { view } = await run(server, false, remoteDeps);
    await fake.close();
    await check('a dropped stream is weather: the repair still reaches its result', () => {
      // The SDK reconnects a short drop itself, so the row may never need to say so;
      // the door's own loop is for an outage longer than the SDK's budget.
      assert.strictEqual(view.phase, 'done', JSON.stringify(view.refusal));
      assert.strictEqual(view.result.repaired.length, 1);
    });
  }

  {
    const fake = await startFake('failed');
    const server = registerFake(fake.url);
    const { view } = await run(server, false, remoteDeps);
    await fake.close();
    await check('a task that failed is refused in the server\'s own words', () => {
      assert.strictEqual(view.phase, 'refused');
      assert.strictEqual(view.refusal.code, 'repair_failed');
      assert.match(view.refusal.message, /the disk is full/);
    });
  }

  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const { view } = await run(server, true, {
      isLocal: async () => true,
      localRepair: async () => { throw new Error('a check took the door that can reinstall and start things'); },
      sleep: async () => {},
    });
    await fake.close();
    await check('Check only on this machine\'s row asks the running server, never bootstrap', () => {
      assert.strictEqual(view.phase, 'done', JSON.stringify(view.refusal));
      assert.deepStrictEqual(fake.state.submitted[0], { type: 'repair', scope: { verify_only: true } });
    });
  }

  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    await fake.close();
    const { view } = await run(server, true, {
      isLocal: async () => true,
      localRepair: async () => { throw new Error('a check took the door that can reinstall and start things'); },
      sleep: async () => {},
    });
    await check('Check only with nobody answering says so, and touched nothing', () => {
      assert.strictEqual(view.phase, 'refused');
      assert.strictEqual(view.refusal.code, 'server_not_answering', view.refusal.message);
      assert.match(view.refusal.message, /nothing was checked or changed/);
      assert.match(view.refusal.message, /Repair is what brings this computer's engine back/);
    });
  }

  {
    const emitted = [];
    await door.repairCrucibleHere((e) => emitted.push(e), {
      isLocal: async () => { throw new Error('there is no row to ask about'); },
      localRepair: async (options) => {
        assert.deepStrictEqual(options.scope, { verifyOnly: false });
        return { server: 'reinstalled', service: 'started', healthy: true, task: RESULT };
      },
    });
    await check('a broken Crucible with no row can still be repaired, under its own key', () => {
      assert.ok(emitted.every((e) => e.server === wire.CRUCIBLE_REPAIR_HERE));
      assert.strictEqual(emitted.at(-1).kind, 'done');
      assert.throws(() => servers.validateServerName(wire.CRUCIBLE_REPAIR_HERE), 'it can never be a row');
    });
    const doors = fs.readFileSync(path.join(REPO, 'src/app/features/settings/components/crucible-doors.component.ts'), 'utf8');
    await check('every door a machine with no row can land on offers it', () => {
      assert.strictEqual((doors.match(/<app-crucible-repair \(finished\)="repairedHere\(\)" \/>/g) ?? []).length, 3,
        'the existing face, the adopt face and settings');
    });
  }

  {
    const { events, view } = await run('here', false, {
      isLocal: async () => true,
      localRepair: async (options) => {
        assert.deepStrictEqual(options.scope, { verifyOnly: false });
        options.onStep({ name: 'server', status: 'ok', detail: 'The server answers.' });
        options.onRepair({ step: 'plan', state: 'running', subject: null, detail: null, bytesToCheck: 10 });
        options.onProgress({ bytesDone: 5, bytesTotal: 10, file: 'x' });
        return { server: 'reinstalled', service: 'started', healthy: true, task: RESULT };
      },
    });
    await check('this machine\'s row goes through bootstrap, into the same view', () => {
      assert.strictEqual(view.local, true);
      assert.strictEqual(view.phase, 'done');
      assert.ok(events.some((e) => e.kind === 'host-step'));
      assert.match(view.hostNote, /reinstalled/);
      assert.match(view.hostNote, /started/);
    });
  }

  {
    const { view } = await run('here', false, {
      isLocal: async () => true,
      localRepair: async () => {
        throw Object.assign(new Error('The server cannot be repaired. Reinstall it.'),
          { code: 'server_unrepairable', command: 'crucible install' });
      },
    });
    await check('bootstrap\'s refusal keeps its own code and its cure', () => {
      assert.strictEqual(view.refusal.code, 'server_unrepairable');
      assert.strictEqual(view.refusal.command, 'crucible install');
    });
  }

  await check('a check that changed nothing never says it repaired anything', () => {
    const line = wire.crucibleRepairHeadline({ ...RESULT, verifyOnly: true, repaired: [] });
    assert.match(line, /1 broken, nothing changed/);
    const clean = wire.crucibleRepairHeadline({ ...RESULT, verifyOnly: true, broken: [], repaired: [], notHashChecked: [] });
    assert.match(clean, /Nothing broken found \(2 items checked\)/);
    assert.ok(!/healthy|everything/i.test(clean), clean);
  });

  // ── detect-first ─────────────────────────────────────────────────────────
  const noConfig = { discovered: { present: false, code: 'no_local_config', reason: 'none' } };
  await check('a config on this machine is the existing one, and detection is not even asked', async () => {
    const found = await install.existingCrucibleOn(
      { discovered: { present: true, serverName: 'pc', url: 'http://127.0.0.1:7100', configPath: 'x', via: 'file' } },
      async () => { throw new Error('asked needlessly'); },
    );
    assert.match(found.sentence, /already has a Crucible, pc/);
  });
  await check('a runtime with no readable config is still not a machine to install on', async () => {
    const found = await install.existingCrucibleOn(noConfig, async () => ({ server: { version: '2.0.34' } }));
    assert.match(found.sentence, /rather than installing a second copy/);
  });
  await check('not being able to tell is not a yes', async () => {
    const found = await install.existingCrucibleOn(noConfig, async () => { throw new Error('wsl did not answer'); });
    assert.match(found.sentence, /could not tell/);
    assert.match(found.sentence, /wsl did not answer/);
  });
  await check('only a machine that was asked and said no gets Install', async () => {
    assert.strictEqual(await install.existingCrucibleOn(noConfig, async () => ({ server: null })), null);
  });
  await check('the screens and the press all ask first', () => {
    const doors = fs.readFileSync(path.join(REPO, 'src/app/features/settings/components/crucible-doors.component.ts'), 'utf8');
    assert.ok(/if \(plan\.existing !== null\) return 'existing';/.test(doors), 'the wizard asks before the install face');
    assert.ok(/@if \(installDoorOffered\(\)\)/.test(doors), 'settings hides the install door');
    assert.ok(/this\.plan\(\)\?\.existing === null/.test(doors), 'and only draws it once the machine said no');
    const main = fs.readFileSync(path.join(REPO, 'electron/main.ts'), 'utf8');
    const press = main.slice(main.indexOf("ipcMain.handle('crucible:host-install',"));
    assert.ok(press.indexOf('crucible_already_here') < press.indexOf('runCrucibleInstall('), 'the press refuses first');
    const firstRun = fs.readFileSync(path.join(REPO, 'src/app/features/first-run-setup/first-run-setup.component.ts'), 'utf8');
    assert.ok(!/Install it on this computer/.test(firstRun), 'setup does not tell a machine with one to install it');
    assert.ok(/It uses the one on this computer if there is one/.test(firstRun));
  });

  summary('test-crucible-repair');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });

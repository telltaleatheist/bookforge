#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { installElectronStub, makeChecker } = require('./fake-crucible');
installElectronStub('bf-connect-');
const { autoConnectLocal } = require('../dist/electron/crucible/auto-connect');
const { CrucibleConnections } = require('../dist/electron/crucible/connect');
const { upgradeWsl } = require('../dist/electron/crucible/engine-upgrade');
const { check, summary } = makeChecker();
const pairing = { name: 'desk', url: 'http://127.0.0.1:7100', token: 'private-token' };
const request = { ...pairing, id: 'server-request', userCode: 'CODE-1234', deviceCode: 'private-device', expiresIn: 60, interval: 1 };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function main() {
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
    await assert.rejects(autoConnectLocal(true, { registryExists: () => true, pairing: () => null }), /did not write/);
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

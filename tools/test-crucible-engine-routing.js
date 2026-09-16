#!/usr/bin/env node
'use strict';
// Real registry -> real SDK -> two HTTP processes. Do not stub clientFor:
// doing so hid the orchestrator/engine disconnect in the older door tests.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REPO, installElectronStub, makeChecker, startFakeCrucible, leaseRoutes } = require('./fake-crucible');
const { userData } = installElectronStub('bf-engine-routing-');
const load = (name) => require(path.join(REPO, 'dist/electron/crucible', `${name}.js`));
const servers = load('servers');
const resolver = load('engine-resolve');
const { check, summary } = makeChecker();

function info(name, extra = {}) {
  return {
    server: { name, version: '0.6.0', api_version: 1 },
    host: { platform: 'win32', arch: 'x86_64', backend: 'llama-windows', gpu: { vendor: 'none', name: 'CPU', vram_bytes: 0 } },
    job_types: ['echo'], capabilities: [], role: 'engine', managed_by: null,
    ...extra,
  };
}
function register(name, url) {
  // Test-owned registry. This exercises the production factory without any
  // changes to the user's saved servers, bearer tokens or engine processes.
  fs.writeFileSync(path.join(userData, 'crucible-servers.json'), JSON.stringify({
    servers: [{ name, url, token: 'test-token-abcd', added: '2026-09-16T00:00:00Z' }],
  }));
  resolver.forgetResolvedEngine();
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

(async () => {
  await check('an orchestrator sends uploads, jobs, events, artifacts and leases to its engine', async () => {
    const leases = leaseRoutes();
    const engineHits = [];
    const engine = await startFakeCrucible(async (req, res, ctx) => {
      const route = ctx.url.pathname;
      engineHits.push(route);
      if (await leases.handler(req, res, ctx)) return true;
      if (route === '/v1/info') { ctx.send(res, 200, info('native-engine')); return true; }
      if (route === '/v1/voices') { ctx.send(res, 200, []); return true; }
      if (route === '/v1/jobs' && req.method === 'POST') {
        ctx.state.submitted.push(JSON.parse(await ctx.readBody(req)));
        ctx.send(res, 200, { job_id: 'actual-engine-job' }); return true;
      }
      if (route === '/v1/jobs/actual-engine-job/events') {
        const stream = ctx.sseWriter(req, res);
        stream.frame('done', { artifacts: ['answer.txt'] }); stream.end(); return true;
      }
      if (route === '/v1/jobs/actual-engine-job/artifacts/answer.txt') {
        res.end('engine result'); return true;
      }
      return false;
    });
    const frontHits = [];
    const front = await startFakeCrucible(async (req, res, ctx) => {
      frontHits.push(ctx.url.pathname);
      if (ctx.url.pathname !== '/v1/info') return false;
      ctx.send(res, 200, info('host-controller', {
        role: 'orchestrator', job_types: [],
        engine: { name: 'native-engine', url: engine.url, backend: 'llama-windows', owner: 'native' },
      })); return true;
    });
    try {
      register('workstation', front.url);
      const result = await load('job').runCrucibleJob({
        server: 'workstation', type: 'echo', params: {}, inputs: { source: Buffer.from('input') },
      });
      assert.strictEqual(result.jobId, 'actual-engine-job');
      assert.strictEqual(Buffer.from(result.artifacts.bytes.get('answer.txt')).toString(), 'engine result');
      assert.strictEqual(engine.state.uploads.length, 1);
      assert.strictEqual(front.state.uploads.length, 0);
      await load('lease').withCrucibleLease({
        server: 'workstation', kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog() {},
      }, async () => {});
      assert.strictEqual(leases.lease.taken.length, 1);
      assert.strictEqual(leases.lease.released.length, 1);
      const inventory = await load('voice-inventory').readVoiceInventory([{ name: 'workstation', enabled: true }]);
      assert.strictEqual(inventory.complete, true);
      assert.deepStrictEqual(frontHits, ['/v1/info']);
      assert.strictEqual(servers.crucibleAddressClientFor('workstation', 'bookforge').url, front.url);
      assert.strictEqual((await servers.crucibleClientFor('workstation', 'bookforge')).url, engine.url);
    } finally { await front.close(); await engine.close(); resolver.forgetResolvedEngine(); }
  });

  await check('native engines work directly without WSL, a GPU, or an orchestrator', async () => {
    const engine = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/info') return false;
      ctx.send(res, 200, info('native')); return true;
    });
    try {
      register('native', engine.url);
      assert.strictEqual((await servers.crucibleClientFor('native', 'bookforge')).url, engine.url);
    } finally { await engine.close(); resolver.forgetResolvedEngine(); }
  });

  await check('the queue exposes one engine lane behind a host and deduplicates its direct address', () => {
    const { engineLanes } = load('engine-lanes');
    const facts = (name) => ({ role: name === 'host' ? 'orchestrator' : 'engine', url: 'http://127.0.0.1:7100' });
    const single = engineLanes([{ name: 'host', enabled: true }], facts);
    assert.strictEqual(single.roles.host, 'engine', 'the lane belongs to the verified engine behind the host');
    const both = engineLanes([{ name: 'host', enabled: true }, { name: 'engine', enabled: true }], facts);
    assert.deepStrictEqual(both.ranked, [{ name: 'engine', enabled: true }]);
    assert.strictEqual(both.owner.get('host'), 'engine');
    const working = engineLanes([{ name: 'host', enabled: true }, { name: 'engine', enabled: true }], facts, ['host']);
    assert.strictEqual(working.owner.get('engine'), 'host', 'discovering the direct address must not move a live job off its lane');
    const directDisabled = engineLanes([{ name: 'host', enabled: true }, { name: 'engine', enabled: false }], facts);
    assert.deepStrictEqual(directDisabled.ranked, [{ name: 'host', enabled: true }]);
    const empty = engineLanes([{ name: 'host', enabled: true }], () => ({ role: 'orchestrator', url: null }));
    assert.strictEqual(empty.roles.host, 'orchestrator', 'an empty host still gets no lane');
  });

  await check('a replaced or forgotten in-flight lookup cannot restore the old engine route', async () => {
    const gate = deferred();
    const entered = deferred();
    let oldReads = 0;
    const old = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/info') return false;
      oldReads++;
      entered.resolve(); await gate.promise;
      ctx.send(res, 200, info('old')); return true;
    });
    let newReads = 0;
    const current = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/info') return false;
      newReads++;
      ctx.send(res, 200, info('current')); return true;
    });
    const entry = (url) => ({ name: 'same-name', url, token: 'test-token-abcd' });
    try {
      const stale = resolver.resolveEngine(entry(old.url), 'bookforge');
      await entered.promise;
      const changed = await resolver.resolveEngine(entry(current.url), 'bookforge');
      assert.strictEqual(changed.url, current.url, 'new URL must not join the old in-flight request');
      gate.resolve(); await stale;
      assert.strictEqual((await resolver.resolveEngine(entry(current.url), 'bookforge')).url, current.url);
      assert.strictEqual(newReads, 1, 'late old result must not evict the new cache');
      resolver.forgetResolvedEngine('same-name');
      await resolver.resolveEngine(entry(current.url), 'bookforge');
      assert.strictEqual(newReads, 2);
      assert.strictEqual(oldReads, 1);
    } finally { gate.resolve(); await old.close(); await current.close(); resolver.forgetResolvedEngine(); }
  });
  summary('test-crucible-engine-routing');
})().catch((err) => { console.error(err); process.exitCode = 1; });

#!/usr/bin/env node
/**
 * ONE LEASE PER ROW — a row of acts is one run, and the model does not go
 * between them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-row-lease.js
 *
 * ── The defect this defends against ────────────────────────────────────────
 *
 * A queue row that cleans a book and THEN simplifies it is two acts against one
 * resident model. Each used to take and release its own lease, and Owen's
 * 2026-09-14 ruling — *"Models should always be unloaded when we're done with
 * them. Every time."* — means the server unloads a 19 GB model in the gap. The
 * second act does not merely run slowly: the chat door never loads, so it is
 * answered `model_not_resident` and the row dies between two steps that both
 * worked.
 *
 * ── What is worth defending, and why each is invisible from the call site ──
 *
 *  1. TWO ACTS, ONE LEASE. The wire is the proof: one POST and one DELETE for a
 *     row that ran two acts. Counting calls to `withCrucibleLease` would not
 *     have caught the old behaviour, which called it twice and took twice.
 *  2. AND THE DELETE COMES AFTER THE SECOND ACT, not between them. A lease
 *     released early and re-taken is the reload wearing a different hat.
 *  3. A DIFFERENT MODEL ENDS THE RUN OF ACTS. A server holds ONE lease, so a
 *     second take against the same server would be refused `409 leased` — by us,
 *     against ourselves. The first must be given back before the second is asked
 *     for, and in that order.
 *  4. OUTSIDE A ROW SCOPE NOTHING CHANGES. The CLI, Settings → AI and every
 *     headless caller must keep releasing in their own `finally`; a scope that
 *     leaked into them would hold a card for a whole ttl after a one-off press.
 *  5. TWO RUNS AT ONCE DO NOT SHARE A LEASE. The slot sets exist so two books
 *     are in flight; a single "current row" variable would hand one book's
 *     lease to the other, which is why the scope is an AsyncLocalStorage.
 *  6. THE SCHEDULER CLOSES IT WHEN NOTHING FOLLOWS. A lease held across an hour
 *     of ffmpeg holds somebody's model for work that has no use for it, and
 *     `StepModule.leasesModel` is the only thing that can say which it is.
 *  7. THE QUIT PATH FORGETS THE ROW. A released lease still sitting in the row
 *     map would be handed to the next act as if it were open.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, leaseRoutes,
} = require('./fake-crucible.js');

const LEASE = path.join(REPO, 'dist', 'electron', 'crucible', 'lease.js');
if (!fs.existsSync(LEASE)) {
  console.log('SKIP: dist/electron/crucible/lease.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

installElectronStub('bf-crucible-row-lease-');

const lease = require(LEASE);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const engine = require(path.join(REPO, 'dist', 'electron', 'queue-engine.js'));

const realGetServer = servers.getServer;
const fakesByName = new Map();
servers.getServer = function getServerWithFakes(name) {
  const fake = fakesByName.get(name);
  if (!fake) return realGetServer(name);
  return { name, url: fake.url, token: 'test-token-abcd', source: 'registry' };
};
let registered = 0;
function nameFake(url) {
  const name = `fake${++registered}`;
  fakesByName.set(name, { url });
  return name;
}

const { check, summary } = makeChecker();
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // The scope itself
  // ───────────────────────────────────────────────────────────────────────────

  await check('two acts of one row take ONE lease, and it is released after the second',
    async () => {
      const routes = leaseRoutes();
      const fake = await startFakeCrucible(routes.handler);
      const server = nameFake(fake.url);
      try {
        const order = [];
        await lease.withCrucibleRowScope('job_1', async () => {
          await lease.withCrucibleLease(
            { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
            async () => { order.push('clean'); },
          );
          assert.strictEqual(routes.lease.released.length, 0,
            'the model must still be held between the two acts — that gap IS the defect');
          await lease.withCrucibleLease(
            { server, kind: 'model', id: 'qwen3.5-9b', act: 'simplify', onLog: () => {} },
            async () => { order.push('simplify'); },
          );
        });
        assert.deepStrictEqual(order, ['clean', 'simplify']);
        assert.strictEqual(routes.lease.taken.length, 1, 'ONE lease for the whole row');
        assert.strictEqual(routes.lease.taken[0].act, 'clean',
          'stamped with the act that OPENED it — Crucible has no name for "a row of acts"');
        assert.strictEqual(routes.lease.released.length, 0,
          'the scope does not release; the scheduler does, when nothing follows');

        await lease.closeCrucibleRowLease('job_1');
        assert.strictEqual(routes.lease.released.length, 1, 'and then it is given back');
        assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
      } finally {
        await lease.closeCrucibleRowLease('job_1');
        await fake.close();
      }
    });

  await check('a DIFFERENT model ends the run of acts — released first, then taken', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const wire = [];
      routes.onEvent = (kind) => wire.push(kind);
      await lease.withCrucibleRowScope('job_2', async () => {
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
          async () => {},
        );
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.8-27b', act: 'translate', onLog: () => {} },
          async () => {
            assert.strictEqual(routes.lease.released.length, 1,
              'the first is given back BEFORE the second is asked for — a server holds one '
              + 'lease, so the other order is a 409 against ourselves');
          },
        );
      });
      assert.deepStrictEqual(routes.lease.taken.map((t) => t.model),
        ['qwen3.5-9b', 'qwen3.8-27b']);
      await lease.closeCrucibleRowLease('job_2');
      assert.strictEqual(routes.lease.released.length, 2);
    } finally {
      await lease.closeCrucibleRowLease('job_2');
      await fake.close();
    }
  });

  await check('OUTSIDE a row scope a lease is released in its own finally, as before',
    async () => {
      const routes = leaseRoutes();
      const fake = await startFakeCrucible(routes.handler);
      const server = nameFake(fake.url);
      try {
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
          async () => {},
        );
        assert.strictEqual(routes.lease.released.length, 1,
          'the CLI and Settings → AI must not leave a card held after a one-off press');
        assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
      } finally {
        await fake.close();
      }
    });

  await check('two runs in flight at once never share a lease', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      // Interleaved deliberately: a single mutable "current row" would hand the
      // second run the first's lease, which is the bug AsyncLocalStorage avoids.
      let releaseA;
      const heldA = new Promise((r) => { releaseA = r; });
      const runA = lease.withCrucibleRowScope('job_a', () =>
        lease.withCrucibleLease(
          { server, kind: 'model', id: 'model-a', act: 'clean', onLog: () => {} },
          async () => { await heldA; },
        ));
      await new Promise((r) => setTimeout(r, 10));
      await lease.withCrucibleRowScope('job_b', () =>
        lease.withCrucibleLease(
          { server, kind: 'model', id: 'model-b', act: 'translate', onLog: () => {} },
          async () => {},
        ));
      releaseA();
      await runA;

      assert.strictEqual(lease.crucibleRowLease('job_a').leased, 'model-a');
      assert.strictEqual(lease.crucibleRowLease('job_b').leased, 'model-b');
      await lease.closeCrucibleRowLease('job_a');
      await lease.closeCrucibleRowLease('job_b');
    } finally {
      await lease.closeCrucibleRowLease('job_a');
      await lease.closeCrucibleRowLease('job_b');
      await fake.close();
    }
  });

  await check('closing a row that holds nothing is a no-op, not a throw', async () => {
    await lease.closeCrucibleRowLease('job_never');
    assert.strictEqual(lease.crucibleRowLease('job_never'), null);
  });

  await check('the quit path forgets the row as well as releasing it', async () => {
    const routes = leaseRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await lease.withCrucibleRowScope('job_quit', () =>
        lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
          async () => {},
        ));
      assert.ok(lease.crucibleRowLease('job_quit'));
      await lease.releaseAllCrucibleLeases();
      assert.strictEqual(lease.crucibleRowLease('job_quit'), null,
        'a released lease left in the row map would be handed to the next act as if open');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await fake.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The scheduler's half: when the row's lease is kept, and when it is given back
  // ───────────────────────────────────────────────────────────────────────────

  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rowlease-'));

  function fakeModule(type, opts = {}) {
    const runs = [];
    const mod = {
      type,
      consumes: opts.consumes === undefined ? null : opts.consumes,
      produces: opts.produces || 'epub',
      resource: () => opts.resource || 'cpu',
      runs,
      run(ctx) {
        const record = { ctx, settled: false };
        record.promise = new Promise((resolve, reject) => {
          record.resolve = (out) => {
            record.settled = true;
            resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
          };
          record.reject = reject;
        });
        runs.push(record);
        return record.promise;
      },
      cancel() {},
    };
    if (opts.leases === true) mod.leasesModel = () => true;
    return mod;
  }

  /** Records what the scheduler asked of the lease seam, with no network. */
  function spyHost() {
    const scopes = [];
    const closed = [];
    return {
      scopes,
      closed,
      host: {
        withRowScope(row, fn) { scopes.push(row); return fn(); },
        async closeRow(row) { closed.push(row); },
      },
    };
  }

  async function freshEngine(name, mods, spy) {
    engine.clearStepModules();
    for (const mod of mods) engine.registerStepModule(mod);
    engine.setGpuLockProbe(() => null);
    engine.setGpuHolderProbe(() => null);
    engine.setCrucibleRoutingHost(null);
    engine.setCrucibleLeaseHost(spy === null ? null : spy.host);
    const dir = path.join(SCRATCH, name);
    fs.mkdirSync(dir, { recursive: true });
    await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });
    return dir;
  }

  await check('every step runs inside its RUN\'s scope — named by the job, not the step',
    async () => {
      const a = fakeModule('translation', { consumes: 'epub', leases: true });
      const spy = spyHost();
      await freshEngine('scope-name', [a], spy);
      const job = engine.enqueue({
        title: 'Mistborn',
        steps: [{
          type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' },
        }],
      });
      engine.start();
      await settle(30);
      assert.deepStrictEqual(spy.scopes, [job.id],
        'the lease has to outlive one step, so the scope cannot be named by one');
      a.runs[0].resolve();
      await settle(30);
    });

  await check('a row whose NEXT act leases keeps the lease across the seam', async () => {
    const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
    const b = fakeModule('book-analysis', { consumes: 'epub', produces: 'report', leases: true });
    const spy = spyHost();
    await freshEngine('keep-across', [t, b], spy);
    engine.enqueue({
      title: 'Mistborn',
      steps: [
        { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' } },
        { type: 'book-analysis', label: 'Analyse', config: { aiProvider: 'crucible' },
          parentIndex: 0 },
      ],
    });
    engine.start();
    await settle(30);
    t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
    await settle(30);
    assert.deepStrictEqual(spy.closed, [],
      'the model must not be unloaded between two acts of one row');
    b.runs[0].resolve({ kind: 'report', path: '/out/b' });
    await settle(30);
    assert.strictEqual(spy.closed.length, 1, 'and it IS given back when the last act lands');
  });

  await check('a row whose next step does NOT lease gives the card back at once', async () => {
    const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
    const r = fakeModule('reassembly', { consumes: 'epub', produces: 'm4b' });
    const spy = spyHost();
    await freshEngine('give-back', [t, r], spy);
    engine.enqueue({
      title: 'Mistborn',
      steps: [
        { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' } },
        { type: 'reassembly', label: 'Assemble', config: {}, parentIndex: 0 },
      ],
    });
    engine.start();
    await settle(30);
    t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
    await settle(30);
    assert.strictEqual(spy.closed.length, 1,
      'an hour of ffmpeg has no business holding somebody\'s model');
  });

  await check('a step whose config does not lease ends the run of acts too', async () => {
    // Same two module types, but the second row is against Claude — an API with
    // no card to hold. `leasesModel` is asked of the CONFIG for exactly this.
    const t = fakeModule('translation', { consumes: 'epub', produces: 'epub' });
    t.leasesModel = (config) => config.aiProvider === 'crucible';
    const b = fakeModule('book-analysis', { consumes: 'epub', produces: 'report' });
    b.leasesModel = (config) => config.aiProvider === 'crucible';
    const spy = spyHost();
    await freshEngine('config-decides', [t, b], spy);
    engine.enqueue({
      title: 'Mistborn',
      steps: [
        { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' } },
        { type: 'book-analysis', label: 'Analyse', config: { aiProvider: 'claude' },
          parentIndex: 0 },
      ],
    });
    engine.start();
    await settle(30);
    t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
    await settle(30);
    assert.strictEqual(spy.closed.length, 1,
      'the next act is a cloud API, so nothing is holding a card for it');
  });

  await check('a FAILED step gives the card back — its children are cancelled with it',
    async () => {
      const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
      const b = fakeModule('book-analysis', { consumes: 'epub', produces: 'report', leases: true });
      const spy = spyHost();
      await freshEngine('fail-closes', [t, b], spy);
      engine.enqueue({
        title: 'Mistborn',
        steps: [
          { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
            sourceRef: { kind: 'epub', path: '/a.epub' } },
          { type: 'book-analysis', label: 'Analyse', config: { aiProvider: 'crucible' },
            parentIndex: 0 },
        ],
      });
      engine.start();
      await settle(30);
      t.runs[0].reject(new Error('the model said no'));
      await settle(30);
      assert.strictEqual(spy.closed.length, 1,
        'a lease left open by a failed row holds a card for its whole ttl');
    });

  await check('a build that wired no lease seam runs exactly as it did before', async () => {
    const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
    await freshEngine('no-seam', [t], null);
    engine.enqueue({
      title: 'Mistborn',
      steps: [{
        type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
        sourceRef: { kind: 'epub', path: '/a.epub' },
      }],
    });
    engine.start();
    await settle(30);
    assert.strictEqual(t.runs.length, 1, 'the step still runs — no scope is not a refusal');
    t.runs[0].resolve();
    await settle(30);
  });

  engine.clearStepModules();
  engine.setCrucibleLeaseHost(null);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  summary('crucible row lease');
})();

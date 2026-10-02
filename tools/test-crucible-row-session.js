#!/usr/bin/env node
/**
 * ONE SESSION PER ROW — a row of acts is one run, and nothing of anybody else's
 * runs between them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-row-session.js
 *
 * Crucible 1.0.76 replaced leases with QUEUE SESSIONS: one client's turn holding
 * the machine, opened with a model resident, during which nothing from another
 * client runs. A queue row's acts share ONE session (`withRowLease`, ambient via
 * `AsyncLocalStorage`), and the scheduler closes it when nothing of the row
 * wants that machine next — or on Stop, Remove and Pause (Owen, Oct 1 2026:
 * Pause closes it and Resume rejoins the back of the line).
 *
 *  1. TWO ACTS, ONE SESSION — on the wire: one open, one close, and the close
 *     after the second act. Across a change of MODEL too: a session can change
 *     model mid-way, so only a change of MACHINE closes it.
 *  2. OUTSIDE A ROW SCOPE a session is closed in its own `finally`.
 *  3. TWO RUNS AT ONCE do not share one.
 *  4. THE SCHEDULER keeps it across the seam for any next act that opens one on
 *     the same machine, and closes it when nothing follows, on another machine,
 *     on Stop, Remove and Pause.
 *  5. THE RESERVE is the session the act uses, and a reserve the line let go is
 *     a `busyLine` the row parks on.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, sessionRoutes, fakeNamer,
  settingsRoutes,
} = require('./fake-crucible.js');
const { skipLine } = require('./keeper-skip.js');

const LEASE = path.join(REPO, 'dist', 'electron', 'crucible', 'lease.js');
if (!fs.existsSync(LEASE)) {
  console.log(skipLine('dist/electron/crucible/lease.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

installElectronStub('bf-crucible-row-session-');

const lease = require(LEASE);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
const engine = require(path.join(REPO, 'dist', 'electron', 'queue-engine.js'));

const nameFake = fakeNamer(servers);

const { check, summary } = makeChecker();
const settle = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // The scope itself
  // ───────────────────────────────────────────────────────────────────────────

  await check('two acts of one row share ONE session, closed only when the scheduler says', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      const order = [];
      await lease.withCrucibleRowScope('job_1', async () => {
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
          async () => { order.push('clean'); },
        );
        assert.strictEqual(routes.session.closed.length, 0,
          'the machine must still be ours between the two acts — that gap IS the defect');
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'simplify', onLog: () => {} },
          async () => { order.push('simplify'); },
        );
      });
      assert.deepStrictEqual(order, ['clean', 'simplify']);
      assert.strictEqual(routes.session.opened.length, 1, 'ONE session for the whole row');
      assert.strictEqual(routes.session.opened[0].act, 'clean', 'opened as the act that opened it');
      assert.strictEqual(routes.session.closed.length, 0, 'the scope does not close; the scheduler does');
      await lease.closeCrucibleRowLease('job_1');
      assert.strictEqual(routes.session.closed.length, 1, 'and then it is given back');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await lease.closeCrucibleRowLease('job_1');
      await fake.close();
    }
  });

  await check('a DIFFERENT MODEL on the same machine keeps the session — it loads inside it', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await lease.withCrucibleRowScope('job_2', async () => {
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} }, async () => {});
        await lease.withCrucibleLease(
          { server, kind: 'model', id: 'qwen3.8-27b', act: 'translate', onLog: () => {} }, async () => {});
      });
      assert.strictEqual(routes.session.opened.length, 1,
        'a session can change model mid-way; closing it would send the row to the back of the line');
      await lease.closeCrucibleRowLease('job_2');
      assert.strictEqual(routes.session.closed.length, 1);
    } finally {
      await lease.closeCrucibleRowLease('job_2');
      await fake.close();
    }
  });

  await check('a DIFFERENT MACHINE closes the first session before opening the second', async () => {
    const routesA = sessionRoutes();
    const fakeA = await startFakeCrucible(routesA.handler);
    const serverA = nameFake(fakeA.url);
    const routesB = sessionRoutes();
    const fakeB = await startFakeCrucible(routesB.handler);
    const serverB = nameFake(fakeB.url);
    try {
      await lease.withCrucibleRowScope('job_3', async () => {
        await lease.withCrucibleLease(
          { server: serverA, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} }, async () => {});
        await lease.withCrucibleLease(
          { server: serverB, kind: 'model', id: 'qwen3.5-9b', act: 'simplify', onLog: () => {} },
          async () => {
            assert.strictEqual(routesA.session.closed.length, 1, 'A is given back before B is used');
          });
      });
      assert.strictEqual(routesB.session.opened.length, 1);
      await lease.closeCrucibleRowLease('job_3');
      assert.strictEqual(routesB.session.closed.length, 1);
    } finally {
      await lease.closeCrucibleRowLease('job_3');
      await fakeA.close();
      await fakeB.close();
    }
  });

  await check('OUTSIDE a row scope a session is closed in its own finally', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    try {
      await lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} }, async () => {});
      assert.strictEqual(routes.session.closed.length, 1,
        'the CLI and Settings → AI must not leave a machine held after a one-off press');
      assert.strictEqual(lease.openCrucibleLeaseCount(), 0);
    } finally {
      await fake.close();
    }
  });

  await check('two runs in flight at once never share a session', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    const routesB = sessionRoutes();
    const fakeB = await startFakeCrucible(routesB.handler);
    const serverB = nameFake(fakeB.url);
    try {
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
          { server: serverB, kind: 'model', id: 'model-b', act: 'translate', onLog: () => {} },
          async () => {},
        ));
      releaseA();
      await runA;
      assert.strictEqual(lease.crucibleRowLease('job_a').leased, 'model-a');
      assert.strictEqual(lease.crucibleRowLease('job_b').leased, 'model-b');
    } finally {
      await lease.closeCrucibleRowLease('job_a');
      await lease.closeCrucibleRowLease('job_b');
      await fake.close();
      await fakeB.close();
    }
  });

  await check('closing a row whose session still WAITS takes it out of the line', async () => {
    const routes = sessionRoutes();
    const fake = await startFakeCrucible(routes.handler);
    const server = nameFake(fake.url);
    const sdk = require('@crucible/client');
    const foreign = new sdk.CrucibleClient({ url: fake.url, token: 't', clientName: 'foundry@else' });
    try {
      const theirs = await foreign.session({ act: 'translate' });
      const waiting = lease.withCrucibleRowScope('job_wait', () => lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
        async () => { throw new Error('must not run'); }));
      await new Promise((r) => setTimeout(r, 80));
      await lease.closeCrucibleRowLease('job_wait');
      let caught = null;
      try { await waiting; } catch (err) { caught = err; }
      assert.ok(caught && typeof caught.busyLine === 'string',
        `leaving the line is our own gesture, a park and never a failure: ${caught}`);
      assert.strictEqual(lease.crucibleRowLease('job_wait'), null);
      await theirs.close();
    } finally {
      await fake.close();
    }
  });

  await check('closing a row that holds nothing is a no-op, not a throw', async () => {
    await lease.closeCrucibleRowLease('job_never');
    assert.strictEqual(lease.crucibleRowLease('job_never'), null);
  });

  await check('the quit path forgets the row as well as closing it', async () => {
    const routes = sessionRoutes();
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

  /**
   * The CLASS the scheduler checks pretend every act is, unless they say.
   *
   * It was a model id until 2026-09-19. The id belongs to the server now
   * (`GET /v1/capability`), so what a module can state — and what the carry-over
   * compares — is the capability class it is (`StepModule.crucibleClass`).
   */
  const DEFAULT_ACT = 'clean';

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
    /*
     * `leases` is `true` for the suite's default CLASS, or a class name. BOTH
     * declarations go on together, because the scheduler needs both: one says
     * a lease may be held, the other says for WHICH ACT, and keeping it across
     * the seam requires the class to match the one the open lease was taken
     * under (`nextActWouldUseHeldCard`). It was the model ID until 2026-09-19;
     * the id is the server's answer now and no module can name it.
     */
    if (opts.leases !== undefined && opts.leases !== false) {
      const act = opts.leases === true ? DEFAULT_ACT : opts.leases;
      mod.leasesModel = () => true;
      mod.crucibleClass = () => act;
    }
    return mod;
  }

  /**
   * Records what the scheduler asked of the lease seam, with no network.
   *
   * `subject` is what the row is pretending to hold — the MACHINE and the
   * CLASS, which is what `leaseHeld` answers (the model id is the server's and
   * this side never sees it). The scheduler compares it to what the next step
   * would take, so a spy that always answered null would make every
   * keep-the-lease check vacuously pass.
   */
  function spyHost(subject = { server: 'mac', act: DEFAULT_ACT }) {
    const scopes = [];
    const closed = [];
    const held = new Map();
    return {
      scopes,
      closed,
      held,
      host: {
        withRowScope(row, fn) { scopes.push(row); held.set(row, subject); return fn(); },
        async closeRow(row) { closed.push(row); held.delete(row); },
        leaseHeld(row) { return held.get(row) ?? null; },
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

  await check('a row whose next act is a DIFFERENT CLASS on the same machine keeps the session',
    async () => {
      /*
       * Clean runs on the 9B and simplify on the 27B. Under leases the clean
       * lease had to go back first or BookForge refused its own load; a SESSION
       * can change model mid-way (Crucible 1.0.76), so the row keeps its turn
       * and the 27B loads inside it — closing it here would send the book to
       * the back of the server's line between two of its own acts.
       */
      const clean = fakeModule('narration-text', { consumes: 'epub', leases: 'clean' });
      const simplify = fakeModule('simplify', { consumes: 'epub', leases: 'simplify' });
      const spy = spyHost({ server: 'mac', act: 'clean' });
      await freshEngine('model-changes', [clean, simplify], spy);
      engine.enqueue({
        title: 'Mistborn',
        steps: [
          { type: 'narration-text', label: 'Clean', config: { kind: 'narration-text' },
            sourceRef: { kind: 'epub', path: '/a.epub' } },
          { type: 'simplify', label: 'Simplify', config: { kind: 'simplify' }, parentIndex: 0 },
        ],
      });
      engine.start();
      await settle(30);
      clean.runs[0].resolve({ kind: 'epub', path: '/out/clean' });
      await settle(30);
      assert.strictEqual(spy.closed.length, 0, 'kept across the seam: same machine');
      simplify.runs[0].resolve({ kind: 'epub', path: '/out/simplify' });
      await settle(30);
      assert.strictEqual(spy.closed.length, 1, 'and closed when the last act lands');
    });

  await check('a next act that leases but will not say WHICH ends the run of acts', async () => {
    // Undeclared is not "probably the same card": that assumption IS the
    // defect above. A module that declares `leasesModel` and no `crucibleClass`
    // releases, which is the behaviour before one lease per row existed.
    const t = fakeModule('translation', { consumes: 'epub', leases: true });
    const b = fakeModule('book-analysis', { consumes: 'epub', produces: 'report' });
    b.leasesModel = () => true;
    const spy = spyHost();
    await freshEngine('unnamed-model', [t, b], spy);
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
    assert.strictEqual(spy.closed.length, 1);
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
    t.crucibleClass = () => DEFAULT_ACT;
    const b = fakeModule('book-analysis', { consumes: 'epub', produces: 'report' });
    b.leasesModel = (config) => config.aiProvider === 'crucible';
    b.crucibleClass = () => DEFAULT_ACT;
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

  // ───────────────────────────────────────────────────────────────────────────
  // THE DISPOSAL DOORS — the lease closes when the act it was kept for is gone
  // ───────────────────────────────────────────────────────────────────────────
  //
  // `settleStep` keeps a lease open across the seam for exactly ONE reason: a
  // child of the step that just landed leases the same model. Four doors then
  // take that child away — Stop, Remove, Remove-one-step — or defer it without
  // end — Pause — and none of them used to close the row. `withRowLease` named
  // the ttl as the backstop, which is not one: the heartbeat is a THIRD of the
  // ttl, so a lease this app keeps beating never expires while the app lives.
  //
  // What that costs, measured in the shape Owen hits: stop a `clean → simplify`
  // row after `clean` lands and a 9-27 GB model stays leased until BookForge
  // quits, with Crucible answering this app's own next job `409 leased`, naming
  // `bookforge`. One case per door, because each one disposes differently.

  /**
   * A two-step row whose first act has LANDED and whose second has not started,
   * with the row's lease still open between them.
   *
   * The gap is made the way the app makes it: the card is busy with something
   * outside BookForge, so the next act is admitted nowhere and sits `queued`
   * carrying that reason. It is exactly the state `leaseWantedAfter` keeps a
   * lease for — a pending child on the same model — and it is the state every
   * door below then disposes of.
   */
  async function rowWithLeaseHeldAtTheSeam(name) {
    const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
    const b = fakeModule('book-analysis', {
      consumes: 'epub', produces: 'report', leases: true, resource: 'gpu' });
    const spy = spyHost();
    await freshEngine(name, [t, b], spy);
    engine.setGpuHolderProbe(() => 'a training run');
    const job = engine.enqueue({
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
    assert.strictEqual(b.runs.length, 0,
      'the next act must NOT have started, or the door below is testing settleStep again');
    assert.deepStrictEqual(spy.closed, [],
      'the row must be holding its lease here, or the door below proves nothing');
    assert.deepStrictEqual(spy.host.leaseHeld(job.id), { server: 'mac', act: DEFAULT_ACT });
    return { job, spy, t, b };
  }

  await check('STOP after the first act lands gives the card back', async () => {
    const { job, spy } = await rowWithLeaseHeldAtTheSeam('stop-closes');
    await engine.cancel({ jobId: job.id });
    await settle(20);
    assert.deepStrictEqual(spy.closed, [job.id],
      'the act the lease was kept for was cancelled, so nothing is holding that model for '
      + 'anything — and the ttl will never take it back, because the heartbeat keeps it');
    assert.strictEqual(spy.host.leaseHeld(job.id), null);
  });

  await check('REMOVING the run gives the card back', async () => {
    const { job, spy } = await rowWithLeaseHeldAtTheSeam('remove-closes');
    await engine.remove(job.id);
    await settle(20);
    assert.deepStrictEqual(spy.closed, [job.id],
      'a run that is no longer in the queue has no next act at all');
  });

  await check('REMOVING the one step the lease was kept for gives the card back', async () => {
    const { job, spy } = await rowWithLeaseHeldAtTheSeam('remove-step-closes');
    const second = job.steps[1];
    await engine.removeStep(second.id);
    await settle(20);
    assert.deepStrictEqual(spy.closed, [job.id],
      'the subtree went with the step, so the act the lease was kept for is gone');
  });

  await check('PAUSE gives the card back — a deferred act is not a next act', async () => {
    const { job, spy } = await rowWithLeaseHeldAtTheSeam('pause-closes');
    engine.pause();
    await settle(20);
    assert.deepStrictEqual(spy.closed, [job.id],
      'the queue has stopped claiming work, so the act this lease is held for starts when a '
      + 'person presses Start and not before — an unbounded hold on somebody else\'s card');
  });

  await check('PAUSE does NOT take the lease out from under a step that is still running',
    async () => {
      // `pause()` deliberately does not stop what is already running — each of
      // those is minutes of GPU. Closing its lease would leave a live run
      // unprotected mid-book, which is the eviction the lease exists to prevent.
      const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
      const spy = spyHost();
      await freshEngine('pause-keeps-running', [t], spy);
      const job = engine.enqueue({
        title: 'Mistborn',
        steps: [{
          type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' },
        }],
      });
      engine.start();
      await settle(30);
      engine.pause();
      await settle(20);
      assert.deepStrictEqual(spy.closed, [],
        'the act holding this lease is mid-run; a pause does not stop it, so it must not lose '
        + 'the protection it is running under');
      t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
      await settle(30);
      assert.deepStrictEqual(spy.closed, [job.id], 'and it is given back when that act lands');
    });

  await check('PAUSE keeps the lease of a RUNNING act that cannot name its card — the defect',
    async () => {
      /*
       * THE BUG THIS PACKET FIXES (bug hunt 2026-09-19, §H).
       *
       * The check above passes a module that names its class. THIS one is the
       * app: since phase 15 the model id is the server's answer, so every real
       * module answered `null` to "which model will you lease" — and the
       * running-step branch sat BEHIND that comparison. Null never equalled the
       * subject, the branch was never reached, and `pause()` closed the lease of
       * a step that was mid-act: the eviction the lease exists to prevent,
       * handed out by the app itself.
       *
       * A running act is guaranteed to be using the card. It needs no
       * comparison, and it does not get one.
       */
      const t = fakeModule('translation', { consumes: 'epub', produces: 'epub' });
      t.leasesModel = () => true;
      // No `crucibleClass`, exactly as no module could name a model id: the
      // scheduler cannot tell what this act would take, and must not need to.
      const spy = spyHost();
      await freshEngine('pause-keeps-unnamed', [t], spy);
      const job = engine.enqueue({
        title: 'Mistborn',
        steps: [{
          type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
          sourceRef: { kind: 'epub', path: '/a.epub' },
        }],
      });
      engine.start();
      await settle(30);
      assert.strictEqual(t.runs.length, 1, 'the act must be running, or this proves nothing');
      engine.pause();
      await settle(20);
      assert.deepStrictEqual(spy.closed, [],
        'the act holding this lease is mid-run — closing it evicts a live book');
      t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
      await settle(30);
      assert.deepStrictEqual(spy.closed, [job.id],
        'and it goes back the moment that act lands: a paused queue has no next act');
    });

  await check('a next act on ANOTHER MACHINE gives the card back, whatever its class',
    async () => {
      /*
       * THE SERVER IS HALF THE CARD. Two machines can both serve `clean`, and a
       * lease on one protects nothing on the other — so "same class" is only an
       * answer together with "same machine". The row here is placed on `mac`
       * (`waitForResolved`, written the moment the card is taken) while the
       * lease it carries is on `pc`.
       */
      // `gpu` and `machines: 'any'` on both: only a GPU step that travels is
      // PLACED (`pump`), and an unplaced row has no machine to compare.
      const t = fakeModule('translation', {
        consumes: 'epub', produces: 'epub', leases: true, resource: 'gpu' });
      t.machines = () => 'any';
      const b = fakeModule('book-analysis', {
        consumes: 'epub', produces: 'report', leases: true, resource: 'gpu' });
      b.machines = () => 'any';
      const spy = spyHost({ server: 'pc', act: DEFAULT_ACT });
      await freshEngine('other-machine', [t, b], spy);
      // The class these steps declare is routed LOCALLY on `mac`. Without a
      // route the pump holds the row on `unknown` — never a guess — and the
      // step would not launch at all (crucible PHASE15 §5.3).
      routes.noteCrucibleRoutes('mac', { [DEFAULT_ACT]: 'local' });
      engine.setCrucibleRoutingHost({
        routing: () => ({ ranked: [{ name: 'mac', enabled: true }] }),
        defaultWaitFor: () => 'mac',
        dial: () => 'any',
        async reach() { return { reachable: true }; },
      });
      const job = engine.enqueue({
        title: 'Mistborn',
        steps: [
          { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
            sourceRef: { kind: 'epub', path: '/a.epub' } },
          { type: 'book-analysis', label: 'Analyse', config: { aiProvider: 'crucible' },
            parentIndex: 0 },
        ],
      });
      engine.start();
      await settle(40);
      assert.strictEqual(
        engine.snapshot().jobs.find((j) => j.id === job.id).waitForResolved, 'mac',
        'the row must be placed, or the machines being compared are both nothing');
      t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
      await settle(40);
      assert.ok(spy.closed.includes(job.id),
        'the next act is the same class on a DIFFERENT machine, so the card this row holds '
        + 'is not the card it is about to take');
    });

  await check('a disposal that leaves a next act of the SAME model alone keeps the lease',
    async () => {
      /*
       * THE OTHER DIRECTION, which is what makes the four checks above a rule
       * rather than "close it whenever anything happens". A row whose landed
       * act has TWO children of the same model loses one of them and the other
       * is still next: closing here would unload a 19 GB model the very next
       * act needs, which is the defect one lease per row exists to prevent.
       */
      const t = fakeModule('translation', { consumes: 'epub', produces: 'epub', leases: true });
      const b = fakeModule('book-analysis', {
        consumes: 'epub', produces: 'report', leases: true, resource: 'gpu' });
      const s = fakeModule('simplify', {
        consumes: 'epub', produces: 'epub', leases: true, resource: 'gpu' });
      const spy = spyHost();
      await freshEngine('sibling-keeps', [t, b, s], spy);
      engine.setGpuHolderProbe(() => 'a training run');
      const job = engine.enqueue({
        title: 'Mistborn',
        steps: [
          { type: 'translation', label: 'Translate', config: { aiProvider: 'crucible' },
            sourceRef: { kind: 'epub', path: '/a.epub' } },
          { type: 'book-analysis', label: 'Analyse', config: { aiProvider: 'crucible' },
            parentIndex: 0 },
          { type: 'simplify', label: 'Simplify', config: { aiProvider: 'crucible' },
            parentIndex: 0 },
        ],
      });
      engine.start();
      await settle(30);
      t.runs[0].resolve({ kind: 'epub', path: '/out/t' });
      await settle(30);
      assert.deepStrictEqual(spy.closed, []);
      await engine.removeStep(job.steps[1].id);
      await settle(20);
      assert.deepStrictEqual(spy.closed, [],
        'the simplify is still next on the same model — the lease is exactly what stops it '
        + 'paying a full reload');
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

  // ---------------------------------------------------------------------------
  // End to end: the scheduler, the real lease seam and a server that holds ONE
  // ---------------------------------------------------------------------------
  //
  // The spy checks above prove the DECISION. These prove what crosses the wire,
  // which is the only thing a real server sees - and the fake enforces one
  // lease per server, so a keep that should have been a release shows up here
  // as a `409 leased` this app handed itself rather than as a silent pass.
  //
  // The seam itself is the app's, composed once in `crucible/lease.ts` and
  // mounted by `queue-ipc.ts`: a host written out again here would be a shape
  // the app does not use.

  /** A step that really leases, really releases, and resolves immediately. */
  function leasingModule(type, where) {
    return {
      type,
      consumes: where.consumes === undefined ? null : where.consumes,
      produces: 'epub',
      resource: () => 'gpu',
      leasesModel: () => true,
      crucibleClass: () => where.act,
      async run(ctx) {
        return lease.withCrucibleLease(
          { server: where.server, kind: 'model', id: where.model, act: where.act, onLog: () => {} },
          async () => ({ kind: 'epub', path: `/out/${ctx.stepId}` }),
        );
      },
      cancel() {},
    };
  }

  const wireOf = (routes) => routes.session.wire.map((w) => `${w.kind} ${w.model ?? ''}`.trim());

  for (const [first, second, why] of [
    [{ type: 'narration-text', model: 'qwen3.5-9b', act: 'clean', config: { kind: 'narration-text' } },
      { type: 'simplify', model: 'qwen3.8-27b-4bit', act: 'simplify', config: { kind: 'simplify' } },
      'clean(9B) then simplify(27B)'],
    [{ type: 'translate-pass', model: 'qwen3.8-27b-4bit', act: 'translate', config: { kind: 'translate' } },
      { type: 'simplify', model: 'qwen3.8-27b-4bit', act: 'simplify', config: { kind: 'simplify' } },
      'translate then simplify'],
    [{ type: 'translation', model: 'qwen3.8-27b-4bit', act: 'translate', config: { aiProvider: 'crucible' } },
      { type: 'translate-pass', model: 'qwen3.8-27b-4bit', act: 'translate', config: { kind: 'translate' } },
      'translate then translate'],
  ]) {
    await check(`${why} on the wire: ONE session, opened once and closed once`, async () => {
      /*
       * A session can change model mid-way (Crucible 1.0.76), so every act of a
       * row on one machine shares it — whatever model or class the server picks
       * for each — and nothing of another client's runs between them. Closing it
       * between acts would send the row to the BACK of the line mid-book.
       */
      const routes = sessionRoutes();
      const fake = await startFakeCrucible(routes.handler);
      const server = nameFake(fake.url);
      try {
        const a = leasingModule(first.type, { server, model: first.model, act: first.act, consumes: 'epub' });
        const b = leasingModule(second.type, { server, model: second.model, act: second.act, consumes: 'epub' });
        await freshEngine(`wire-${first.act}-${second.act}`, [a, b], { host: lease.crucibleLeaseSeam() });
        engine.enqueue({
          title: 'Mistborn',
          steps: [
            { type: first.type, label: 'First', config: first.config, sourceRef: { kind: 'epub', path: '/a.epub' } },
            { type: second.type, label: 'Second', config: second.config, parentIndex: 0 },
          ],
        });
        engine.start();
        for (let i = 0; i < 40 && routes.session.wire.length < 2; i += 1) {
          await new Promise((r) => setTimeout(r, 25));
        }
        assert.deepStrictEqual(wireOf(routes), [`open ${first.model}`, 'close'],
          'one session for the row, given back when the last act lands');
        assert.strictEqual(routes.session.opened[0].act, first.act);
      } finally {
        await fake.close();
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // THE RESERVE — admission opens the session, and the act REUSES it
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Owen, 2026-09-19: *"It reserves the lease, THEN it takes the slot and
  // starts real work."* The session is what is reserved now; it waits in the
  // server's line, and the act that follows finds it in the row map.

  await check('a reserved session is the one the act uses — ONE open on the wire', async () => {
    const routes = sessionRoutes();
    const door = settingsRoutes({});
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (await door.handle(req, res, ctx)) return true;
      return routes.handler(req, res, ctx);
    });
    const server = nameFake(fake.url);
    try {
      const seam = lease.crucibleLeaseSeam();
      await seam.reserveRow('job_reserve', { server, act: 'clean' });
      assert.strictEqual(routes.session.opened.length, 1, 'admission opened it');
      assert.strictEqual(routes.session.opened[0].model, 'qwen3.5-9b',
        'with the model the SERVER names for that class resident, not one this side guessed');
      assert.deepStrictEqual(seam.leaseHeld('job_reserve'), { server, act: 'clean' });

      await lease.withCrucibleRowScope('job_reserve', () => lease.withCrucibleLease(
        { server, kind: 'model', id: 'qwen3.5-9b', act: 'clean', onLog: () => {} },
        async () => undefined,
      ));
      assert.strictEqual(routes.session.opened.length, 1, 'the act REUSED the reserved session');
      assert.strictEqual(routes.session.closed.length, 0, 'and does not close it: the scheduler owns it');
    } finally {
      await lease.closeCrucibleRowLease('job_reserve');
      await fake.close();
    }
  });

  await check('a reserve the line let go carries a `busyLine` the row parks on, and says where it stood', async () => {
    const routes = sessionRoutes({
      holdLine: () => ({ position: 2, of: 4, then: { reason: 'expired', message: 'nobody followed it' } }),
    });
    const door = settingsRoutes({});
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (await door.handle(req, res, ctx)) return true;
      return routes.handler(req, res, ctx);
    });
    const server = nameFake(fake.url);
    try {
      const said = [];
      let thrown = null;
      try {
        await lease.crucibleLeaseSeam().reserveRow('job_refused', { server, act: 'clean' }, (line) => said.push(line));
      } catch (err) { thrown = err; }
      assert.ok(thrown !== null, 'a reserve the line let go must not resolve');
      assert.strictEqual(typeof thrown.busyLine, 'string', 'under the name the scheduler reads');
      assert.match(thrown.busyLine, /expired/);
      assert.deepStrictEqual(said, [`waiting, #2 of 4 in crucible "${server}"'s line`],
        'the row says where it stands while it waits');
      assert.strictEqual(lease.crucibleLeaseSeam().leaseHeld('job_refused'), null);
    } finally {
      await lease.closeCrucibleRowLease('job_refused');
      await fake.close();
    }
  });

  engine.clearStepModules();
  engine.setCrucibleLeaseHost(null);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
await check('an UPSTREAM-routed act takes no lease — the server would refuse one', async () => {
    /*
     * crucible PHASE15 §3.4: a chat whose model is `<upstream>/<model>` is
     * forwarded on the operator's account — "no lease, no lane, the settlement
     * untouched (nothing was on the card)" — and a lease naming one is refused
     * `lease_not_needed`, "an upstream model is never resident; send the
     * chat". So a cleanup that routed upstream must not ask.
     *
     * Pinned two ways, because the behaviour lives in a door this suite does
     * not drive: the DISCRIMINATOR is exercised for real (the contract's own
     * slash rule, §1, enforced server-side at manifest load), and the GUARD is
     * source-read at its one call site.
     */
    const acts = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-acts.js'));
    assert.strictEqual(acts.isUpstreamModelId('anthropic/claude-sonnet-5'), true);
    assert.strictEqual(acts.isUpstreamModelId('openai/gpt-5'), true);
    assert.strictEqual(acts.isUpstreamModelId('ollama/qwen3.5:9b'), true);
    assert.strictEqual(acts.isUpstreamModelId('qwen3.5-9b'), false,
      'a local model id never contains a slash — that is the whole rule');
    assert.strictEqual(acts.isUpstreamModelId('qwen3.8-27b-4bit'), false);

    const bridge = fs.readFileSync(path.join(REPO, 'electron', 'ai-bridge.ts'), 'utf-8');
    const guard = bridge.indexOf('isUpstreamModelId(named.model)');
    const lease = bridge.indexOf('withCrucibleLease');
    assert.ok(guard > 0, 'ai-bridge no longer asks whether the act was routed upstream');
    assert.ok(guard < lease,
      'the guard must come BEFORE the lease is taken; after it, the refusal has already happened');
  });

  await check('an UPSTREAM-routed act is not asked to be RESIDENT either', async () => {
    /*
     * The other half of the same sentence (§3.4): *"an upstream model is never
     * resident; send the chat."* `GET /v1/models` lists what a host has
     * manifests for, so `anthropic/claude-sonnet-5` is not in it and never
     * will be — and the preflight would have refused `crucible_unknown_model`
     * and told somebody to `--crucible-load` a thing that cannot be loaded.
     *
     * Source-read at the guard, and the ORDER matters here too: the early
     * return has to precede the `/v1/models` read, or the round trip is made
     * and its answer thrown away.
     */
    const bridge = fs.readFileSync(path.join(REPO, 'electron', 'ai-bridge.ts'), 'utf-8');
    const fn = bridge.indexOf('async function assertCrucibleModelResident');
    assert.ok(fn > 0, 'the residency preflight is gone — read why before deleting this check');
    const end = bridge.indexOf(String.fromCharCode(10) + '}', fn);
    const body = bridge.slice(fn, end);
    const skip = body.indexOf('isUpstreamModelId(model)');
    const read = body.indexOf('crucibleModelRows(');
    assert.ok(skip > 0, 'the residency preflight asks an upstream model to be resident');
    assert.ok(skip < read, 'the skip must precede the /v1/models read, not follow it');
  });

  await check('the ENGINE door skips the same machinery, and refuses a load that cannot happen', async () => {
    /*
     * `resolveCrucibleTextEngine` composes what a Foundry engine spawn needs,
     * and it proved the model RESIDENT before handing it over. For an upstream
     * model there is nothing on a card to prove — it is the same §3.4 sentence
     * a third time — so it returns the endpoint and the header map without the
     * two round trips.
     *
     * `loadFirst` is REFUSED rather than skipped: a caller that asked for a
     * model to be warmed asked for a thing that cannot happen, and silently
     * not doing it is how a person concludes the warm-up is slow.
     */
    const venue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-venue.js'));
    const asked = { models: 0, loads: 0 };
    const host = {
      view: () => ({ ranked: [{ name: 'mac', enabled: true }], newJobsWaitFor: 'any', legacyLocalRender: false, unknown: [] }),
      enabled: () => [{ name: 'mac', enabled: true }],
      ping: async () => ({ reachable: true }),
      server: () => ({ name: 'mac', url: 'http://mac:7100', token: 'test-token-abcd', source: 'registry' }),
      // `TextVenueHost.engineUrl` — where the work goes, which is not always the
      // registered address (PHASE17: an orchestrator serves no job type). This
      // check is about the upstream arm, so the two are the same here.
      engineUrl: async () => 'http://mac:7100',
      models: async () => { asked.models += 1; return []; },
      loadModel: async () => { asked.loads += 1; },
      capability: async () => ({
        backendKind: 'cuda-linux', totalBytes: 1, desktopAllowanceBytes: 1,
        classes: [{ capability: 'translate', enabled: true, selected: 'anthropic/claude-sonnet-5', reason: 'routed', shortfallBytes: 0, route: 'upstream' }],
      }),
    };
    const engine = await venue.resolveCrucibleTextEngine('translate', 'mac', host, { reach: 'spawn' });
    assert.strictEqual(engine.model, 'anthropic/claude-sonnet-5');
    assert.strictEqual(engine.endpoint, 'http://mac:7100/openai');
    assert.strictEqual(asked.models, 0, 'it asked /v1/models about a model that is never in it');
    assert.ok(engine.maskedHeaders.includes('****abcd'), 'the act still travels, masked in logs');

    let caught = null;
    try {
      await venue.resolveCrucibleTextEngine('translate', 'mac', host, { reach: 'spawn', loadFirst: true });
    } catch (err) { caught = err; }
    assert.ok(caught !== null, 'loadFirst on an upstream model was silently ignored');
    assert.strictEqual(caught.code, 'crucible_upstream_not_loadable');
    assert.strictEqual(asked.loads, 0);
  });

    summary('crucible row session');
})();

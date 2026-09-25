#!/usr/bin/env node
/**
 * A BOOK DOES NOT TAKE A SLOT UNTIL THE SERVER IS AVAILABLE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-admission.js
 *
 * ── The contract (Owen, 2026-09-19) ─────────────────────────────────────────
 *
 * *"I don't think it should move out of the queue and into a slot until it's
 * available… the book would just sit there in the queue until it's free, maybe
 * retrying every so often… as long as the queue is running/unpaused. If the
 * queue isn't active then it just sits in the active queue doing nothing."*
 *
 * And: *"Poll the server to see if it's available. If it isn't, it just waits
 * in the queue until it's available. It reserves the lease, THEN it takes the
 * slot and starts real work."*
 *
 * So admission is an ORDER, and this file is here because every step of it was
 * silent when it went wrong (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A1 and
 * A2):
 *
 *   1. POLL. `GET /v1/activity` says a card is held BEFORE anything is
 *      submitted. Without it the queue learnt "busy" only from a `409` that
 *      cost a full prep, and then paid for it again every 15 s.
 *   2. THE LOCAL GATES, so a reserved lease is never wasted on a row this
 *      machine was going to stop anyway.
 *   3. RESERVE THE LEASE. The row stays `queued` while the reserve is in the
 *      air, and nothing is assigned until it lands.
 *   4. THEN the slot, then the launch, and only THEN is `waitForResolved`
 *      written — which is the moment the card is actually taken, and the moment
 *      the book stops being editable (docs/PENDING-QUEUE-AND-GPU-DIAL.md,
 *      "Mutability").
 *
 * And the backstop, A1's own fix: a `409` that arrives anyway RELEASES the
 * venue. Left standing it pinned an `any` book to the machine that had refused
 * it, for as long as the other job ran, with a read-only picker saying it *"was
 * taken by a GPU"* — which was false, nothing was taken.
 *
 * ── Why this is testable with no network ────────────────────────────────────
 *
 * The routing record, the prober and the LEASE SEAM are all injected
 * (`setCrucibleRoutingHost`, `setCrucibleLeaseHost`), so every branch of the
 * order above is reachable with a scripted activity answer and a scripted
 * reserve. Nothing here opens a socket or reads `<userData>`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-engine.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const engine = require(path.join(DIST, 'queue-engine.js'));
const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));
// The bench composes the sentence a second book reads off the same snapshot.
const bench = require(path.join(REPO, 'dist', 'shared', 'queue', 'bench.js'));
/*
 * WHICH ENGINE RUNS WHICH CLASS, and why this file has to say so.
 *
 * A step that names a `crucibleClass` is asked one question before it is placed:
 * does that engine RUN this class or forward it upstream (crucible PHASE15
 * §5.3)? `unknown` is a WAIT and never a guess, so a suite that left the record
 * empty would park every leasing row on "BookForge has not yet read where mac
 * runs clean work" and never reach the reserve at all. The record is a
 * synchronous in-memory map with no Electron in it, so it is filled here the
 * way a connect fills it.
 */
const routes = require(path.join(DIST, 'crucible', 'routes.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-admission-'));

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Let the scheduler's promise chain — the prober AND the reserve — settle. */
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await wait(0); };

/**
 * A step module whose run the test resolves by hand.
 *
 * `leases` puts BOTH declarations on, because the scheduler needs both to
 * reserve: `leasesModel` says a lease is held at all, and `crucibleClass` names
 * the capability class it is taken under. A module that leases and cannot name
 * its class reserves nothing — that is a real answer and it is asserted below.
 */
function fakeModule(type, opts = {}) {
  const runs = [];
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
    // A stopped step of a resumable module lands `held`, not `cancelled` — the
    // status the hold rule turns on, so a test about it has to be able to say so.
    stopIsResumable: opts.stopIsResumable === true,
    runs,
    run(ctx) {
      const record = { ctx, job: ctx.job, settled: false };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => {
          record.settled = true;
          resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
        };
        record.reject = (err) => { record.settled = true; reject(err); };
      });
      runs.push(record);
      return record.promise;
    },
    cancel() {},
  };
  if (opts.travels !== false) mod.machines = () => 'any';
  if (opts.leases === true) {
    mod.leasesModel = () => true;
    // No `leasedModel`: the hook is gone (2026-09-19). What a module states is
    // the CLASS, and `leaseActOf` reads both halves.
    if (opts.act !== null) mod.crucibleClass = () => opts.act || 'clean';
  }
  return mod;
}

/**
 * The routing record and the prober, scripted — `reach` now answers with the
 * ACTIVITY read beside the ping, which is the whole of finding A2's fix.
 *
 * `reach[name]` is `{ reachable, busy }`, and `busy` is mutated mid-test to
 * play the holder finishing.
 */
function fakeHost(initial) {
  const state = {
    ranked: initial.ranked ?? [],
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    reach: initial.reach ?? {},
    asked: [],
  };
  state.host = {
    routing: () => ({
      ranked: state.ranked.map((row) => ({ ...row })),
    }),
    defaultWaitFor: () => state.defaultWaitFor,
    async reach(name) {
      state.asked.push(name);
      const answer = state.reach[name];
      if (answer === undefined) {
        return { reachable: false, detail: `Nothing answered at ${name}.` };
      }
      // A fresh object each time: the engine compares answers to decide whether
      // to publish, and a shared reference would compare equal to itself.
      return answer.reachable
        ? { reachable: true, busy: answer.busy === undefined ? null : answer.busy }
        : { reachable: false, detail: answer.detail };
    },
  };
  return state;
}

/**
 * The lease seam, scripted, recording what admission asked of it and WHEN.
 *
 * `answer` is a function of `{ row, server, act }`: it may resolve (the lease
 * is held), or throw the SDK-shaped refusal the scheduler has to read as a
 * wait. `holdOpen` keeps the reserve in flight so a test can assert what the
 * row looks like while it is.
 */
function fakeLeaseSeam(opts = {}) {
  const seam = {
    reserves: [],
    closed: [],
    scopes: [],
    held: new Map(),
    /** Resolve/reject the outstanding reserve by hand when `holdOpen` is set. */
    pending: [],
  };
  seam.host = {
    withRowScope(row, fn) { seam.scopes.push(row); return fn(); },
    async reserveRow(row, where) {
      seam.reserves.push({ row, ...where });
      // What the row then HOLDS is the machine and the class the reserve was
      // for — `leaseHeld`'s shape, and the terms the scheduler compares in.
      const subject = { server: where.server, act: where.act };
      if (opts.holdOpen === true) {
        return new Promise((resolve, reject) => {
          seam.pending.push({
            row,
            grant: () => { seam.held.set(row, subject); resolve(); },
            refuse: (err) => reject(err),
          });
        });
      }
      const answer = opts.answer === undefined ? null : opts.answer({ row, ...where });
      if (answer instanceof Error) throw answer;
      seam.held.set(row, subject);
    },
    async closeRow(row) { seam.closed.push(row); seam.held.delete(row); },
    leaseHeld(row) { return seam.held.get(row) ?? null; },
  };
  return seam;
}

/** A refusal in the shape the scheduler's one rule reads: `busyLine`. */
function refusedBusy(line) {
  return Object.assign(new Error(`crucible refused: ${line}`), { busyLine: line });
}

async function fresh(name, mods, host, seam, configureExtra = {}) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(host === null ? null : host.host);
  engine.setCrucibleLeaseHost(seam === null ? null : seam.host);
  routes.forgetCrucibleRoutes();
  for (const row of (host === null ? [] : host.ranked)) {
    routes.noteCrucibleRoutes(row.name, { clean: 'local', translate: 'local', simplify: 'local' });
  }
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  // The background sweep is off: this file asserts WHICH servers an admission
  // decision asked about, and a sweep asking all of them would drown it.
  await engine.configure({
    stateDir: dir, admissionRecheckMs: 40, reachSweepMs: 0, ...configureExtra,
  });
  return dir;
}

function jobOf(jobId) {
  return engine.snapshot().jobs.find((j) => j.id === jobId);
}
function firstStep(jobId) {
  return jobOf(jobId).steps[0];
}
function enqueueSent(spec) {
  const job = engine.enqueue(spec);
  if (job.pending === true) engine.sendToQueue(job.id);
  return job;
}
function narrate(title, type = 'pass') {
  return {
    title,
    steps: [{
      type, label: 'Clean', config: { aiProvider: 'crucible' },
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  };
}

const BUSY_LINE = 'busy: foundry, tts qwen3, 62% done';
const TWO = [{ name: 'pc', enabled: true }, { name: 'mac', enabled: true }];

// ── 1 · The poll: one owner for the sentence ────────────────────────────────

test('the polled busy line is spelt the way the SDK spells a 409', () => {
  // TWO MOMENTS, ONE SENTENCE. The row must not reword itself depending on
  // whether the card was polled or the submit was refused, and two composers
  // would drift without anybody being able to see it.
  const { CrucibleBusy } = require(path.join(REPO, 'node_modules', '@crucible', 'client'));
  const fields = {
    holder: 'foundry',
    jobId: 'j1',
    jobType: 'tts',
    model: 'qwen3',
    jobStatus: 'running',
    since: '2026-09-19T00:00:00Z',
    progress: 0.62,
    jobMessage: null,
  };
  const sdk = new CrucibleBusy(409, 'server_busy', 'busy', null, fields);
  assert.strictEqual(
    waitFor.busyLineFor({
      holder: fields.holder,
      what: `${fields.jobType} ${fields.model}`,
      progress: fields.progress,
      message: fields.jobMessage,
    }),
    sdk.busyLine,
    'busyLineFor and CrucibleBusy.busyLine must be the same sentence',
  );
  assert.strictEqual(sdk.busyLine, BUSY_LINE);
});

test('a holder with no denominator says no percentage rather than 0%', () => {
  // A streaming session has `progress: null` by contract, and "0% done" would
  // be a measurement nobody made.
  assert.strictEqual(
    waitFor.busyLineFor({ holder: null, what: 'a streaming session (zac)', progress: null, message: null }),
    'busy: an unnamed client, a streaming session (zac)',
  );
});

// ── 2 · A busy server is skipped, and nothing is sent to it ─────────────────

test('an `any` row takes rank-2 when the poll says rank-1 is busy — and rank-1 is never launched at', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO,
    defaultWaitFor: 'any',
    reach: {
      pc: { reachable: true, busy: { line: BUSY_LINE } },
      mac: { reachable: true },
    },
  });
  const seam = fakeLeaseSeam();
  await fresh('any-skips-busy', [gpu], host, seam);

  const job = enqueueSent(narrate('Mistborn'));
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 1, 'it started');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'on the machine that was free — the busy one was never a candidate');
  assert.deepStrictEqual(seam.reserves.map((r) => r.server), ['mac'],
    'and nothing was reserved on the busy machine either');
});

test('a row that NAMES a busy server waits for it, with the holder\'s line and its progress', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO,
    defaultWaitFor: 'pc',
    reach: {
      pc: { reachable: true, busy: { line: BUSY_LINE } },
      mac: { reachable: true },
    },
  });
  const seam = fakeLeaseSeam();
  await fresh('named-waits', [gpu], host, seam);

  const job = enqueueSent(narrate('Deathstalker'));
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 0, 'nothing was launched at the busy machine');
  assert.strictEqual(seam.reserves.length, 0, 'and no lease was reserved on it');
  assert.strictEqual(firstStep(job.id).status, 'queued', 'it sits in the live queue');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'nothing is assigned: the book is still editable');
  assert.strictEqual(firstStep(job.id).progress.admissionHold, waitFor.holdBusy('pc', BUSY_LINE));
  assert.match(firstStep(job.id).progress.admissionHold, /62% done/,
    'the operator is told how far along the job in front of them is');

  // The holder finishes. The next sweep of the same poll clears the wait.
  host.reach.pc = { reachable: true };
  engine.pump();
  await settle();
  // The cached answer is still the busy one until it ages out, so the row waits
  // rather than guessing; the recheck tick is what re-asks.
  await wait(80);
  await settle();

  assert.strictEqual(gpu.runs.length, 1, 'and then it runs');
  assert.deepStrictEqual(seam.reserves.map((r) => r.server), ['pc']);
  assert.strictEqual(jobOf(job.id).waitForResolved, 'pc');
});

// ── 3 · The lease is reserved BEFORE the slot is taken ──────────────────────

test('the venue is written only after the reserve lands — not while it is in the air', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam({ holdOpen: true });
  await fresh('reserve-first', [gpu], host, seam);

  const job = enqueueSent(narrate('Wool'));
  engine.start();
  await settle();

  assert.strictEqual(seam.reserves.length, 1, 'the scheduler asked for the lease');
  assert.deepStrictEqual(
    { server: seam.reserves[0].server, act: seam.reserves[0].act, row: seam.reserves[0].row },
    { server: 'mac', act: 'clean', row: job.id },
    'named by the RUN, on the machine admission chose, for the act the module declares',
  );
  assert.strictEqual(gpu.runs.length, 0, 'nothing has started');
  assert.strictEqual(firstStep(job.id).status, 'queued', 'the row is still in the queue');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'THE BOOK IS STILL EDITABLE: the card has not been taken yet');
  assert.match(firstStep(job.id).progress.message, /^Reserving mac/,
    'and it says what it is doing');
  assert.strictEqual(firstStep(job.id).progress.admissionHold, undefined,
    'a reserve in flight is not a refusal, so nothing draws it as a blocked row');

  seam.pending[0].grant();
  await settle();

  assert.strictEqual(gpu.runs.length, 1, 'the lease landed, so the slot was taken');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'and the venue is written at that moment and no earlier');
});

test('one reserve per machine per pass — two rows for one server do not race each other', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam({ holdOpen: true });
  await fresh('one-reserve', [gpu], host, seam);

  enqueueSent(narrate('Book one'));
  enqueueSent(narrate('Book two'));
  engine.start();
  await settle();

  assert.strictEqual(seam.reserves.length, 1,
    'a server holds ONE lease; a second take in the same tick would be refused by us, naming us');
  seam.pending[0].grant();
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'and the second book waits on the slot, as it always did');
});

test('a step that leases but names no act reserves nothing, and runs as before', async () => {
  const gpu = fakeModule('pass', { leases: true, act: null });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam();
  await fresh('no-act', [gpu], host, seam);

  enqueueSent(narrate('No class'));
  engine.start();
  await settle();

  assert.strictEqual(seam.reserves.length, 0);
  assert.strictEqual(gpu.runs.length, 1, 'the act takes its own lease when it runs');
});

test('a render, which leases nothing, is launched on a free server with no reserve', async () => {
  const gpu = fakeModule('tts-conversion');
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam();
  await fresh('render-no-reserve', [gpu], host, seam);

  const job = enqueueSent({
    title: 'Sigma',
    steps: [{
      type: 'tts-conversion', label: 'Narrate', config: {},
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  });
  engine.start();
  await settle();

  assert.strictEqual(seam.reserves.length, 0, 'there is no model lease to reserve for a render');
  assert.strictEqual(gpu.runs.length, 1);
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');
});

// ── 3a · Every server is the same road, local or otherwise ─────────────────

test('A SERVER AT http://127.0.0.1:7100 TAKES THE RESERVE ROAD, like any other',
  async () => {
    /*
     * Owen, 2026-09-19: *"Crucible is configured to be system agnostic. Doesn't
     * matter if it's on this system or on a rented DigitalOcean GPU, it should
     * effectively be treated the same locally or otherwise. Like Ollama — the
     * user connects to it the same way whether local or remote."*
     *
     * Until that ruling the queue looked the registered URL up
     * (`isLoopbackUrl` → `serversOnThisMachine`) and sent such a step down a
     * SECOND road: `external-gpu-job.lock` and the GPU arbiter first, the
     * reserve after. So a training chain on this box held back a render on the
     * Crucible beside it, and a Crucible render evicted the resident Ollama
     * models (`parallel-tts-bridge.ts`, `acquireGpuForJob`). Both probes are
     * about the card THIS PROCESS drives; Crucible owns its card's memory.
     *
     * The probes here answer with a HOLDER, so if either were asked the row
     * would park with its sentence instead of launching — the assertion has
     * something to fail on rather than a silent zero.
     */
    const HERE = 'wsl — http://127.0.0.1:7100';
    const gpu = fakeModule('pass', { leases: true });
    const host = fakeHost({
      ranked: [{ name: HERE, enabled: true }],
      defaultWaitFor: HERE,
      reach: { [HERE]: { reachable: true } },
    });
    const seam = fakeLeaseSeam();
    await fresh('loopback-is-an-ordinary-server', [gpu], host, seam);

    let lockAsked = 0;
    let arbiterAsked = 0;
    engine.setGpuLockProbe(() => { lockAsked += 1; return 'orpheus fine-tune (pid 1234)'; });
    engine.setGpuHolderProbe(() => { arbiterAsked += 1; return 'AI cleanup'; });

    const job = enqueueSent(narrate('Wool'));
    engine.start();
    await settle();

    assert.strictEqual(lockAsked, 0,
      "the external training lock was asked about a Crucible's card — it describes "
      + 'the card THIS PROCESS drives, and a registered server is not that');
    assert.strictEqual(arbiterAsked, 0,
      'the GPU arbiter was asked about a Crucible\'s card, for the same reason');
    assert.deepStrictEqual(
      seam.reserves.map((r) => ({ server: r.server, act: r.act })),
      [{ server: HERE, act: 'clean' }],
      'the road is the reserve, exactly as it is for the Mac across the tailnet');
    assert.strictEqual(gpu.runs.length, 1, 'and it launched');
    assert.strictEqual(jobOf(job.id).waitForResolved, HERE);
    assert.strictEqual(firstStep(job.id).progress.admissionHold, undefined,
      'nothing held it, so nothing wrote a reason on it');
  });

// ── 4 · A refused reserve is a WAIT, and it assigns nothing ─────────────────

test('`409 leased` on the reserve leaves the row queued, unassigned, and holds on the holder\'s line', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: true }],
    defaultWaitFor: 'mac',
    reach: { mac: { reachable: true } },
  });
  const leasedLine = 'leased: foundry, translate, until 2026-09-19T04:00:00Z';
  let refusals = 0;
  const seam = fakeLeaseSeam({
    answer: () => { refusals += 1; return refusals === 1 ? refusedBusy(leasedLine) : null; },
  });
  await fresh('reserve-leased', [gpu], host, seam);

  const job = enqueueSent(narrate('Hellworld'));
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 0, 'nothing started');
  assert.strictEqual(firstStep(job.id).status, 'queued', 'and nothing failed');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'THE VENUE IS NOT WRITTEN — the lease was refused, so the card was never taken');
  assert.strictEqual(firstStep(job.id).progress.admissionHold, waitFor.holdBusy('mac', leasedLine));
  assert.strictEqual(seam.reserves.length, 1, 'and the cool-off stops it hammering the door');

  // The cool-off is one admission tick. After it, the row asks again.
  await wait(90);
  await settle();
  assert.strictEqual(seam.reserves.length, 2, 'it retried once the cool-off lapsed');
  assert.strictEqual(gpu.runs.length, 1, 'and the second ask was granted');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');
});

test('a reserve refused for a REASON — not a holder — holds with that reason, and does not fail the row', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: true }],
    defaultWaitFor: 'mac',
    reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam({
    answer: () => new Error('crucible "mac" reports the "clean" class as ENABLED and names no model for it.'),
  });
  await fresh('reserve-misconfig', [gpu], host, seam);

  const job = enqueueSent(narrate('Misconfigured'));
  engine.start();
  await settle();

  assert.strictEqual(firstStep(job.id).status, 'queued',
    'the act never ran, so nothing of the book is lost and nothing is red');
  assert.match(String(firstStep(job.id).progress.admissionHold), /names no model for it/,
    'the refusal names the thing to repair, and it is shown rather than replaced');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined);
});

// ── 5 · The 409 backstop releases the venue (A1) ────────────────────────────

test('a 409 from a LAUNCHED step releases the venue, and an `any` row takes the other machine', async () => {
  const gpu = fakeModule('tts-conversion');
  const host = fakeHost({
    ranked: TWO,
    defaultWaitFor: 'any',
    reach: { pc: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('backstop-any', [gpu], host, null);

  const job = enqueueSent({
    title: 'Mistborn',
    steps: [{
      type: 'tts-conversion', label: 'Narrate', config: {},
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  });
  /*
   * THE PARKED MOMENT IS READ OFF THE SNAPSHOT, not off the queue afterwards.
   * `settleStep` parks the row and pumps in the same tick, so by the time this
   * test could look the row has already been started somewhere else — which is
   * the behaviour we want and would hide the state that proves it.
   */
  const parked = [];
  const stop = engine.onQueueChanged((snap) => {
    const row = snap.jobs.find((j) => j.id === job.id);
    if (row !== undefined && row.steps[0].status === 'queued') {
      parked.push({ resolved: row.waitForResolved, venue: row.steps[0].venue });
    }
  });
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'pc', 'rank-1 took it');

  parked.length = 0;
  gpu.runs[0].reject(refusedBusy(BUSY_LINE));
  await settle();
  stop();

  assert.ok(parked.length > 0, 'a 409 is a wait, not a failure: the row went back to `queued`');
  assert.strictEqual(parked[0].resolved, undefined,
    'AND THE VENUE IS RELEASED — nothing of the attempt stands, so the book is not pinned to it');
  assert.strictEqual(parked[0].venue, undefined,
    'the bench must not keep drawing it on the lane of a machine it is not going to');

  assert.strictEqual(gpu.runs.length, 2, 'the next pass started it somewhere');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'on the OTHER enabled machine — the busy one is held off for the cool-off');
});

test('Q1: a PREPARE that landed does not keep the venue — the 409 still releases it', async () => {
  /*
   * ── The defect (bug hunt 2026-09-20, Q1) ─────────────────────────────────
   *
   * `releaseVenueIfNothingStands` asked whether ANY step was `done` or
   * `running`. Since 2026-09-19 every narration chain opens with `prepare` —
   * CPU, local, no venue — which lands `done` FIRST. So the guard tripped on
   * the completed LOCAL row and the venue stood: `decideWaitFor` took rung 1
   * forever, and an `any` book waited hours on the machine that had refused it
   * with an idle one beside it and a read-only picker. A1 verbatim, reached
   * through the row A1's own fix had added — which is why the one-step shape
   * above passed all along and this two-step one is the keeper.
   *
   * The rule is about a MACHINE: only a TRAVELLING step stands on one
   * (`isTravellingGpuStep`), and a local prepare stands on none.
   */
  const prep = fakeModule('prepare', { travels: false, resource: () => 'cpu' });
  const render = fakeModule('tts-conversion');
  const host = fakeHost({
    ranked: TWO,
    defaultWaitFor: 'any',
    reach: { pc: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('q1-prepare-then-409', [prep, render], host, null);

  const job = enqueueSent({
    title: 'Hitler\'s People',
    steps: [
      { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();

  prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.strictEqual(jobOf(job.id).steps[0].status, 'done', 'the prepare landed, on no machine');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'pc', 'and the render took rank-1');
  assert.strictEqual(render.runs.length, 1);

  // THE PARKED MOMENT IS READ OFF THE SNAPSHOT — see the test above for why.
  const parked = [];
  const stop = engine.onQueueChanged((snap) => {
    const row = snap.jobs.find((j) => j.id === job.id);
    if (row !== undefined && row.steps[1].status === 'queued') {
      parked.push({ resolved: row.waitForResolved, venue: row.steps[1].venue });
    }
  });
  render.runs[0].reject(refusedBusy(BUSY_LINE));
  await settle();
  stop();

  assert.ok(parked.length > 0, 'a 409 is a wait: the render went back to `queued`');
  assert.strictEqual(parked[0].resolved, undefined,
    'AND THE VENUE IS RELEASED — a done LOCAL step stands on no machine');
  assert.strictEqual(parked[0].venue, undefined);
  assert.strictEqual(render.runs.length, 2, 'the next pass started it somewhere');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'on the OTHER machine — which is the whole of A1, through the prepare row');
});

test('Q1: a TRAVELLING step that landed DOES keep the venue — §4.3 is untouched', async () => {
  // The other half of the same predicate: a book whose render is `done` on a
  // machine is partway through ON THAT MACHINE, and a refusal of its next act
  // must not send the rest of it somewhere else.
  const render = fakeModule('tts-conversion');
  const align = fakeModule('align');
  const host = fakeHost({
    ranked: TWO,
    defaultWaitFor: 'any',
    reach: { pc: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('q1-render-then-409', [render, align], host, null);

  const job = enqueueSent({
    title: 'Mistborn',
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'align', label: 'Align', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();
  render.runs[0].resolve({ kind: 'audio', path: '/out/render' });
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'pc');

  align.runs[0].reject(refusedBusy(BUSY_LINE));
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'pc',
    'the render stands on that machine, so the book stays on it');
});

test('…but a row that NAMES the busy server keeps waiting for it', async () => {
  const gpu = fakeModule('tts-conversion');
  const host = fakeHost({
    ranked: TWO,
    defaultWaitFor: 'pc',
    reach: { pc: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('backstop-named', [gpu], host, null);

  const job = enqueueSent({
    title: 'Deathstalker',
    steps: [{
      type: 'tts-conversion', label: 'Narrate', config: {},
      sourceRef: { kind: 'epub', path: '/a.epub' },
    }],
  });
  engine.start();
  await settle();
  gpu.runs[0].reject(refusedBusy(BUSY_LINE));
  await settle();

  assert.strictEqual(jobOf(job.id).waitFor, 'pc', 'the instruction is untouched');
  assert.strictEqual(gpu.runs.length, 1, 'and it was NOT sent to mac instead');
  assert.strictEqual(firstStep(job.id).progress.admissionHold, waitFor.holdBusy('pc', BUSY_LINE));
});

// ── 6 · Paused ──────────────────────────────────────────────────────────────

test('a paused queue reserves nothing and launches nothing, with a free server in front of it', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam();
  await fresh('paused', [gpu], host, seam);

  const job = enqueueSent(narrate('Waiting for Resume'));
  // No `start()`: the queue is not claiming work.
  engine.pump();
  await settle();

  assert.strictEqual(seam.reserves.length, 0, 'no lease was reserved');
  assert.strictEqual(gpu.runs.length, 0, 'and nothing was launched');
  assert.notStrictEqual(firstStep(job.id).status, 'running',
    'it sits in the live queue doing nothing, which is the ruling');
  assert.strictEqual(jobOf(job.id).pending, undefined,
    'and it IS in the live queue — a paused queue accepts rows, it just starts nothing');

  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'Resume starts it');
});

test('paused BETWEEN the reserve and the launch gives the card straight back', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam({ holdOpen: true });
  await fresh('paused-mid-reserve', [gpu], host, seam);

  const job = enqueueSent(narrate('Paused mid-reserve'));
  engine.start();
  await settle();
  assert.strictEqual(seam.reserves.length, 1);

  engine.pause();
  seam.pending[0].grant();
  await settle();

  assert.strictEqual(gpu.runs.length, 0, 'nothing starts while the queue is paused');
  assert.ok(seam.closed.includes(job.id),
    'and the lease is released rather than held on somebody else\'s card until Resume');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined);
});

// ── 7 · Cancel while reserving ──────────────────────────────────────────────

test('a book cancelled while its lease is being reserved does not keep the card', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam({ holdOpen: true });
  await fresh('cancel-mid-reserve', [gpu], host, seam);

  const job = enqueueSent(narrate('Cancelled'));
  engine.start();
  await settle();
  assert.strictEqual(seam.reserves.length, 1);

  await engine.cancel({ jobId: job.id }, 'changed my mind');
  seam.pending[0].grant();
  await settle();

  assert.strictEqual(gpu.runs.length, 0, 'it never started');
  assert.ok(seam.closed.includes(job.id),
    'the reserve landed on a row nobody is going to run, so the lease goes back');
});

test('a book REMOVED while its lease is being reserved does not keep the card either', async () => {
  const gpu = fakeModule('pass', { leases: true });
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const seam = fakeLeaseSeam({ holdOpen: true });
  await fresh('remove-mid-reserve', [gpu], host, seam);

  const job = enqueueSent(narrate('Removed'));
  engine.start();
  await settle();

  await engine.remove(job.id);
  seam.pending[0].grant();
  await settle();

  assert.strictEqual(gpu.runs.length, 0);
  assert.ok(seam.closed.includes(job.id));
});

// ── 8 · A book is atomic on the card (Owen, 2026-09-20) ────────────────────
//
// > i want books to be atomic actions, ideally, where they keep the GPU until
// > all of their GPU steps are complete … they shouldnt lose their GPU slot
// > because theyre doing a quick step.
//
// He watched Mistborn finish its render, move to the CPU for the session copy,
// and then park on its OWN render's activity line: "Waiting for crucible@<the
// Mac>: busy: bookforge crucible-client/1.0.6, tts mistborn, 99% done — 80 of
// 81 chunk(s) rendered". The hold (`gpuHoldOf`) is what stops that, and these
// are the four things it has to get right at the door.

/** A narration: two travelling GPU acts, the second reading the first. */
function narrateThenAlign(title, waitForRow) {
  return {
    title,
    ...(waitForRow === undefined ? {} : { waitFor: waitForRow }),
    steps: [
      { type: 'tts-conversion', label: 'Narrate', config: {},
        sourceRef: { kind: 'epub', path: '/a.epub' } },
      { type: 'align', label: 'Align', config: {}, parentIndex: 0 },
    ],
  };
}

test('A HELD BOOK IS ADMITTED THOUGH THE POLL SAYS ITS SERVER IS BUSY — and a second book is not',
  async () => {
    const render = fakeModule('tts-conversion');
    const align = fakeModule('align');
    const host = fakeHost({
      ranked: [{ name: 'mac', enabled: true }],
      defaultWaitFor: 'mac',
      reach: { mac: { reachable: true } },
    });
    await fresh('atomic-busy-poll', [render, align], host, null);

    const book = enqueueSent(narrateThenAlign('Mistborn', 'mac'));
    const second = enqueueSent(narrate('Wool', 'tts-conversion'));
    engine.start();
    await settle();
    assert.strictEqual(render.runs.length, 1, 'the render took the card');
    assert.strictEqual(jobOf(book.id).waitForResolved, 'mac');

    /*
     * THE POLL NOW SAYS THE CARD IS BUSY — which is true, and it is OUR OWN
     * render holding it. The second book asks, so the answer lands in the reach
     * cache; the first book's cached `ready` ages out on the recheck cadence.
     */
    host.reach.mac = { reachable: true, busy: { line: BUSY_LINE } };
    await wait(60);
    engine.pump();
    await settle();
    assert.strictEqual(firstStep(second.id).status, 'queued', 'the second book waits, correctly');

    // The render lands. Its alignment is the SAME book's next GPU act.
    render.runs[0].resolve({ kind: 'epub', path: '/out/render' });
    await settle();

    assert.strictEqual(align.runs.length, 1,
      'the book kept its card: it is not parked on its own render\'s activity line');
    assert.strictEqual(jobOf(book.id).waitForResolved, 'mac', 'and it is still that machine\'s');
    assert.strictEqual(render.runs.length, 1, 'the second book did NOT take the card');
    const snap = engine.snapshot();
    const waiting = snap.jobs.find((j) => j.id === second.id);
    const reason = bench.stillReason(snap, waiting, waiting.steps[0]);
    assert.strictEqual(reason.kind, 'no-slot');
    assert.match(reason.sentence, /Aligning Mistborn|Holding the card for Mistborn/,
      'the second book is told which book has the card');
  });

test('THE GAP BETWEEN TWO GPU ACTS IS THE HOLDER\'S, and it says so on the bench', async () => {
  const render = fakeModule('tts-conversion');
  const align = fakeModule('align', { leases: true, act: 'clean' });
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: true }],
    defaultWaitFor: 'mac',
    reach: { mac: { reachable: true } },
  });
  // The reserve is held open, so the queue sits in the gap the ruling is about:
  // the render is done, the alignment has not started, and nothing is running.
  const seam = fakeLeaseSeam({ holdOpen: true });
  await fresh('atomic-gap', [render, align], host, seam);

  const book = enqueueSent(narrateThenAlign('Mistborn', 'mac'));
  const second = enqueueSent(narrate('Wool', 'tts-conversion'));
  engine.start();
  await settle();
  render.runs[0].resolve({ kind: 'epub', path: '/out/render' });
  await settle();

  assert.strictEqual(align.runs.length, 0, 'still reserving — nothing of this book is running');
  const snap = engine.snapshot();
  const lane = bench.benchLanes(snap).find((l) => l.setId === 'mac' && l.resource === 'gpu');
  assert.ok(lane.occupant, 'the card is charged, so the bench must draw who has it');
  assert.strictEqual(lane.occupant.verb, 'Holding the card');
  assert.match(lane.occupant.message, /waiting to start Align/);
  assert.strictEqual(render.runs.length, 1, 'and the next book cannot slip into the gap');
  assert.strictEqual(firstStep(second.id).status, 'queued');

  seam.pending[0].grant();
  await settle();
  assert.strictEqual(align.runs.length, 1, 'the lease landed and the book went on');
});

test("A 409 DURING THE HOLD IS THIS BOOK'S OWN TAIL: parked for seconds, venue kept", async () => {
  const render = fakeModule('tts-conversion');
  const align = fakeModule('align');
  const host = fakeHost({
    ranked: TWO, defaultWaitFor: 'mac', reach: { pc: { reachable: true }, mac: { reachable: true } },
  });
  /*
   * The two cadences are deliberately far apart, because which one re-asks is
   * the whole assertion: a stranger's 409 is held off for `admissionRecheckMs`
   * and keyed by SERVER, and this is neither.
   */
  await fresh('atomic-own-tail', [render, align], host, null,
    { admissionRecheckMs: 5_000, heldJobRecheckMs: 300 });

  const book = enqueueSent(narrateThenAlign('Mistborn', 'mac'));
  engine.start();
  await settle();
  render.runs[0].resolve({ kind: 'epub', path: '/out/render' });
  await settle();
  assert.strictEqual(align.runs.length, 1);

  align.runs[0].reject(refusedBusy(BUSY_LINE));
  await settle();

  const step = jobOf(book.id).steps[1];
  assert.strictEqual(step.status, 'queued', 'a 409 is a wait, not a failure');
  assert.strictEqual(jobOf(book.id).waitForResolved, 'mac',
    'THE VENUE STANDS: half this book is rendered on that machine, and it still holds its card');
  assert.match(step.progress.admissionHold, /previous step is still closing/);
  assert.ok(!/It takes one job at a time/.test(step.progress.admissionHold),
    'that is the sentence for a STRANGER holding the machine, and nobody else is here');
  assert.strictEqual(align.runs.length, 1, 'it does not hammer the door in the same tick');

  await wait(400);
  await settle();
  assert.strictEqual(align.runs.length, 2,
    'and it is re-asked on the SHORT cadence — the 15 s one belongs to a busy server');
});

test('THE HAND-OVER NO LONGER FREES THE CARD, and cancelling the book does', async () => {
  const render = fakeModule('tts-conversion');
  const align = fakeModule('align');
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: true }],
    defaultWaitFor: 'mac',
    reach: { mac: { reachable: true } },
  });
  await fresh('atomic-handover', [render, align], host, null);

  const book = enqueueSent(narrateThenAlign('Mistborn', 'mac'));
  const second = enqueueSent(narrate('Wool', 'tts-conversion'));
  engine.start();
  await settle();

  // The bridge says its last chunk has landed: the rest of this step is a
  // session copy on this machine's CPU (`StepRunContext.releaseGpu`).
  render.runs[0].ctx.releaseGpu('the render has settled');
  await settle();

  const tail = jobOf(book.id).steps[0];
  assert.strictEqual(tail.resource, 'cpu', 'the pool entry was handed back');
  assert.strictEqual(tail.venue, undefined);
  assert.strictEqual(render.runs.length, 1,
    'but the CARD was not: Wool must not take a machine this book is mid-flight on');
  assert.strictEqual(firstStep(second.id).status, 'queued');

  /*
   * The user stops the book. A stop no longer idles the queue (Owen,
   * 2026-09-21); Start is still pressed on the other book below, because a
   * targeted Start is the gesture that releases ITS held rows.
   */
  await engine.cancel({ jobId: book.id });
  render.runs[0].reject(new Error('Stopped by the user.'));
  await settle();
  engine.start();
  await settle();

  assert.strictEqual(render.runs.length, 2, 'the run ended, so the hold did');
  assert.strictEqual(render.runs[1].job.title, 'Wool');
});

/*
 * OWEN'S FIVE BOOKS (2026-09-20). He queued five books as "Any" while a sixth
 * rendered on the Mac, and watched the pre-hold scheduler clean book one on the
 * PC, hand the PC to book two's Clean during book one's six-second Prepare, and
 * only then render book one. Ruling 9 says the card is the BOOK's from its first
 * GPU act to its last, so this pins every gap in that exact shape — the landing,
 * the Prepare, and the render→align hand-off — and the dual-card half of it: a
 * second card free means a second book, never a second STEP of the same book's
 * neighbour on the first.
 */
function book(title) {
  return {
    title, waitFor: 'any',
    steps: [
      { type: 'foundry-job', label: 'Clean', config: {}, sourceRef: { kind: 'epub', path: `/${title}.epub` } },
      { type: 'foundry-export-landing', label: 'Land', config: {}, parentIndex: 0 },
      { type: 'prepare', label: 'Prepare', config: {}, parentIndex: 1 },
      { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 2 },
      { type: 'align', label: 'Align', config: {}, parentIndex: 3 },
    ],
  };
}
const runningOf = (mod) => mod.runs.filter((r) => !r.settled).map((r) => r.job.title);
const stepOf = (jobId, i) => jobOf(jobId).steps[i];

test("OWEN'S FIVE BOOKS: one book holds its card from Clean through Align; the next Clean waits", async () => {
  const clean = fakeModule('foundry-job');
  const land = fakeModule('foundry-export-landing', { travels: false, resource: () => 'cpu' });
  const prep = fakeModule('prepare', { travels: false, resource: () => 'cpu' });
  const render = fakeModule('tts-conversion');
  const align = fakeModule('align');
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: true }, { name: 'pc', enabled: true }],
    defaultWaitFor: 'any',
    reach: { mac: { reachable: true }, pc: { reachable: true } },
  });
  await fresh('five-books', [clean, land, prep, render, align], host, null);

  const shift = enqueueSent({ title: 'Shift', waitFor: 'mac', steps: [
    { type: 'tts-conversion', label: 'Narrate', config: {}, sourceRef: { kind: 'epub', path: '/shift.epub' } }] });
  const books = ['Conspiracies', 'People', 'Pursuit', 'Memory', 'Lying'].map((t) => enqueueSent(book(t)));
  engine.start();
  await settle();

  assert.deepStrictEqual(runningOf(render), ['Shift'], 'Shift renders on the Mac');
  assert.deepStrictEqual(runningOf(clean), ['Conspiracies'], 'the first Clean takes the PC');
  assert.strictEqual(jobOf(books[0].id).waitForResolved, 'pc');
  assert.strictEqual(stepOf(books[1].id, 0).status, 'queued', 'the second Clean waits: both cards taken');

  clean.runs[0].resolve({ kind: 'epub', path: '/out/conspiracies' });
  await settle();
  assert.deepStrictEqual(runningOf(land), ['Conspiracies'], 'the landing runs on the CPU');
  assert.strictEqual(runningOf(clean).length, 0, 'GAP 1 (landing): no other Clean took the PC');

  land.runs[0].resolve({ kind: 'epub', path: '/out/conspiracies.landed' });
  await settle();
  assert.deepStrictEqual(runningOf(prep), ['Conspiracies'], 'Prepare runs on the CPU');
  assert.strictEqual(runningOf(clean).length, 0, 'GAP 2 (prepare): no other Clean took the PC — this is the hole Owen watched');

  prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.deepStrictEqual(runningOf(render).sort(), ['Conspiracies', 'Shift'], 'the render follows on the PC');
  assert.strictEqual(runningOf(clean).length, 0);

  render.runs.find((r) => r.job.title === 'Conspiracies').resolve({ kind: 'epub', path: '/out/c.render' });
  await settle();
  assert.deepStrictEqual(runningOf(align), ['Conspiracies'], 'Align follows, same card');
  assert.strictEqual(runningOf(clean).length, 0, 'GAP 3 (render→align): still nobody else');

  align.runs[0].resolve({ kind: 'epub', path: '/out/c.aligned' });
  await settle();
  assert.strictEqual(jobOf(books[0].id).steps.every((s) => s.status === 'done'), true, 'book one is finished');
  assert.deepStrictEqual(runningOf(clean), ['People'], 'ONLY NOW does the second book take the PC');
  assert.strictEqual(jobOf(books[1].id).waitForResolved, 'pc');

  // The Mac frees up: the THIRD book takes it while the second still holds the PC.
  render.runs.find((r) => r.job.title === 'Shift').resolve({ kind: 'epub', path: '/out/shift' });
  await settle();
  assert.deepStrictEqual(runningOf(clean).sort(), ['People', 'Pursuit'], 'two books, two cards — dual rendering');
  assert.strictEqual(jobOf(books[2].id).waitForResolved, 'mac');
  assert.strictEqual(stepOf(books[3].id, 0).status, 'queued', 'the fourth waits for a card');
});

test("A HELD NEXT ACT FREES THE CARD: the second book takes the PC (Owen's Pursuit, 01:50)", async () => {
  /*
   * The same five-book shape, stopped where Owen found it: Clean done on the
   * PC, the landing and the Prepare done, `tts-conversion` HELD ("Interrupted
   * when BookForge closed. Press Start to pick it up"), Align waiting behind
   * it. Nothing was going to start, and until this fix the run's hold kept the
   * PC's card anyway — the bench drew "Holding the card · Align" over an idle
   * Crucible and the next book could not have the machine.
   */
  const clean = fakeModule('foundry-job');
  const land = fakeModule('foundry-export-landing', { travels: false, resource: () => 'cpu' });
  const prep = fakeModule('prepare', { travels: false, resource: () => 'cpu' });
  const render = fakeModule('tts-conversion', { stopIsResumable: true });
  const align = fakeModule('align');
  const host = fakeHost({
    ranked: [{ name: 'pc', enabled: true }],
    defaultWaitFor: 'any',
    reach: { pc: { reachable: true } },
  });
  await fresh('held-frees-card', [clean, land, prep, render, align], host, null);

  const [pursuit, next] = ['Pursuit', 'Memory'].map((t) => enqueueSent(book(t)));
  engine.start();
  await settle();
  clean.runs[0].resolve({ kind: 'epub', path: '/out/pursuit' });
  await settle();
  land.runs[0].resolve({ kind: 'epub', path: '/out/pursuit.landed' });
  await settle();
  prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.deepStrictEqual(runningOf(render), ['Pursuit'], 'the narration is on the PC');
  assert.strictEqual(stepOf(next.id, 0).status, 'queued', 'and the next book waits, correctly');

  // Stop — or the app closing, which `reviveInterrupted` lands in the same
  // place: `held`, with `wasInterrupted`, picked up by nothing but a press.
  await engine.cancel({ stepId: stepOf(pursuit.id, 3).id }, 'Stopped.', { resumable: true });
  render.runs[0].reject(new Error('Stopped by the user.'));
  await settle();
  assert.strictEqual(stepOf(pursuit.id, 3).status, 'held');
  assert.strictEqual(stepOf(pursuit.id, 3).wasInterrupted, true, 'and it resumes where it stopped');
  /*
   * A STOP SENDS THE BOOK TO PENDING AND GIVES UP ITS CARD (Owen, 2026-09-25:
   * "if i hit stop it should give up the lease and move to pending again").
   * Until then it stayed on its machine, Align waiting behind it. The work
   * already done is kept: Clean, the landing and the Prepare stay done.
   */
  assert.strictEqual(jobOf(pursuit.id).pending, true, 'the stopped book is in Pending');
  assert.strictEqual(stepOf(pursuit.id, 4).status, 'held', 'Align is held with it');
  assert.strictEqual(jobOf(pursuit.id).waitForResolved, undefined, 'and it gave up the PC');
  assert.deepStrictEqual([0, 1, 2].map((i) => stepOf(pursuit.id, i).status), ['done', 'done', 'done'],
    'the work already done is kept');

  /*
   * Start is pressed on the OTHER book (a stop leaves the queue running, but
   * this book's held rows are released by a targeted Start).
   * Targeted on purpose: a bare `start()` releases every held step in the queue
   * (`release`), which would un-hold the very row this test is about. Pressing
   * Start on one book is what leaves the shape Owen was looking at: a running
   * queue with somebody else's narration still held.
   */
  engine.start({ jobId: next.id });
  await settle();
  assert.deepStrictEqual(runningOf(clean), ['Memory'],
    'the card was kept for an act nobody had released; the next book has it now');
  assert.strictEqual(jobOf(next.id).waitForResolved, 'pc');
  assert.strictEqual(stepOf(pursuit.id, 3).status, 'held',
    'and the held book did not quietly restart itself');
});

test('A BOOK DRAGGED ONTO A LANE HOLDS ITS CARD THROUGH ITS LOCAL PREP, and the next one waits its turn', async () => {
  /*
   * Owen, 2026-09-25: *"i dragged pursuit of power to the wsl slot. it started.
   * then i dragged yahweh or jesus to the same slot. yahweh or jesus took the
   * slot and started processing instead of pursuit of power ... if it goes to
   * the local cpu for prep, it sohuld still hold the slot lease"* — and *"order
   * should be respected"*. Pursuit's run opened with a local `prepare`, which
   * held nothing, so Yahweh's clean (GPU first) took the PC.
   */
  const clean = fakeModule('foundry-job');
  const prep = fakeModule('prepare', { travels: false, resource: () => 'cpu' });
  const render = fakeModule('tts-conversion');
  const host = fakeHost({
    ranked: [{ name: 'pc', enabled: true }],
    defaultWaitFor: 'any',
    reach: { pc: { reachable: true } },
  });
  await fresh('dragged-prep-holds', [clean, prep, render], host, null);

  // A drag onto a lane is `setWaitFor` (queue.component's `setPlanServer`),
  // made while the book is in Pending, then Move to queue.
  const dragged = (spec) => {
    const job = engine.enqueue(spec);
    engine.setWaitFor(job.id, 'pc');
    if (jobOf(job.id).pending === true) engine.sendToQueue(job.id);
    return job;
  };
  const pursuit = dragged({
    title: 'Pursuit',
    steps: [
      { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/p.epub' } },
      { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
    ],
  });
  engine.start();
  await settle();
  assert.deepStrictEqual(runningOf(prep), ['Pursuit'], 'Pursuit prepares on this machine');

  const yahweh = dragged({
    title: 'Yahweh',
    steps: [{ type: 'foundry-job', label: 'Clean', config: {}, sourceRef: { kind: 'epub', path: '/y.epub' } }],
  });
  await settle();
  assert.deepStrictEqual(runningOf(clean), [], 'Yahweh does not take the card Pursuit is holding');
  assert.strictEqual(stepOf(yahweh.id, 0).status, 'queued');

  prep.runs[0].resolve({ kind: 'prepared-session', path: '/out/prepared' });
  await settle();
  assert.deepStrictEqual(runningOf(render), ['Pursuit'], 'Pursuit narrates on the card it kept');
  assert.deepStrictEqual(runningOf(clean), [], 'and Yahweh still waits');

  // And a second bound book whose own first step is LOCAL does not begin (and
  // so does not start holding) while the card is Pursuit's.
  const third = dragged({
    title: 'Third',
    steps: [
      { type: 'prepare', label: 'Prepare', config: {}, sourceRef: { kind: 'epub', path: '/t.epub' } },
      { type: 'tts-conversion', label: 'Narrate', config: {}, parentIndex: 0 },
    ],
  });
  await settle();
  assert.strictEqual(stepOf(third.id, 0).status, 'queued', 'its prep waits for the card, in order');
  assert.ok(/Yahweh is ahead of it|Waiting/.test(stepOf(third.id, 0).progress.message ?? ''),
    `and says why: ${stepOf(third.id, 0).progress.message}`);
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok    ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`  FAIL  ${t.name}`);
      console.log(`        ${err && err.message}`);
    }
  }
  engine.setCrucibleRoutingHost(null);
  engine.setCrucibleLeaseHost(null);
  routes.forgetCrucibleRoutes();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  console.log(`\nqueue admission: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();

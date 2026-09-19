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
    mod.leasedModel = () => null;
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
    serversOnThisMachine: initial.serversOnThisMachine === undefined ? [] : initial.serversOnThisMachine,
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    reach: initial.reach ?? {},
    asked: [],
  };
  state.host = {
    routing: () => ({
      ranked: state.ranked.map((row) => ({ ...row })),
      serversOnThisMachine: state.serversOnThisMachine,
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
      if (opts.holdOpen === true) {
        return new Promise((resolve, reject) => {
          seam.pending.push({
            row,
            grant: () => { seam.held.set(row, opts.subject || 'qwen3.5-27b'); resolve(); },
            refuse: (err) => reject(err),
          });
        });
      }
      const answer = opts.answer === undefined ? null : opts.answer({ row, ...where });
      if (answer instanceof Error) throw answer;
      seam.held.set(row, opts.subject || 'qwen3.5-27b');
    },
    async closeRow(row) { seam.closed.push(row); seam.held.delete(row); },
    leaseSubject(row) { return seam.held.get(row) ?? null; },
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

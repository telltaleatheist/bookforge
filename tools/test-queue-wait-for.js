#!/usr/bin/env node
/**
 * Tests for the queue's per-row Crucible routing — `waitFor`.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-wait-for.js
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * crucible `docs/PHASE7-LANES.md` §4.2.1, §4.2.1a, §4.2.2, §4.3, §4.4. One
 * field on the row, written from a SETTING, visible, and never re-pointed
 * behind the operator's back:
 *
 *  - the default is the top-ranked server's NAME, or `any`, as the setting says;
 *  - a row naming a server that is DISABLED or UNREACHABLE holds and says which
 *    — it is never re-routed, because a named server is an instruction;
 *  - `any` takes the first enabled server in rank order that answers, and holds
 *    NAMING that when none does;
 *  - a 409 `server_busy` is a WAIT, not a failure;
 *  - a queued row does not move when the drag-order changes;
 *  - disabling a server SURFACES the rows that name it, with a count and one
 *    click — they are told, never moved;
 *  - the machine a book is sent to is written onto the row, because a job is
 *    atomic and a resume goes back to the same machine.
 *
 * ── Why this is testable with no network and no userData ────────────────────
 *
 * The engine takes its routing record and its prober as an injected host
 * (`setCrucibleRoutingHost`), for the same reason it takes its GPU lock as a
 * probe: everything about WHERE a step goes is then reachable with a scripted
 * record and a scripted ping, at the speed of a unit test. Nothing here opens a
 * socket, reads `<userData>`, or spawns `wsl.exe`.
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
const bench = require(path.join(REPO, 'dist', 'shared', 'queue', 'bench.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-waitfor-'));

let passed = 0;
const failures = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Let the scheduler's promise chain — and the injected prober — settle. */
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await wait(0); };

/**
 * A step module whose run the test resolves by hand.
 *
 * `travels` decides whether it declares `machines() === 'any'`, which is the
 * whole difference between a step the routing applies to and one it must leave
 * completely alone.
 */
function fakeModule(type, opts = {}) {
  const runs = [];
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
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
  if (opts.travels === true) mod.machines = () => 'any';
  return mod;
}

/**
 * The routing record and the prober, scripted.
 *
 * Mutable on purpose: half of what this file defends is what happens when the
 * record CHANGES under rows that are already queued.
 */
function fakeHost(initial) {
  const state = {
    ranked: initial.ranked ?? [],
    serversOnThisMachine: initial.serversOnThisMachine === undefined ? ['local'] : initial.serversOnThisMachine,
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    // THE QUEUE'S GPU DIAL (docs/PENDING-QUEUE-AND-GPU-DIAL.md). `any` unless a
    // test turns it, because `any` is the position in which the dial changes
    // nothing — every pre-dial expectation in this file is an `any` expectation.
    dial: initial.dial === undefined ? 'any' : initial.dial,
    reach: initial.reach ?? {},
    asked: [],
  };
  state.host = {
    routing: () => ({
      ranked: state.ranked.map((row) => ({ ...row })),
      serversOnThisMachine: state.serversOnThisMachine,
    }),
    defaultWaitFor: () => state.defaultWaitFor,
    dial: () => state.dial,
    async reach(name) {
      state.asked.push(name);
      const answer = state.reach[name];
      if (answer === undefined) {
        return { reachable: false, detail: `Nothing answered at ${name}.` };
      }
      return answer;
    },
  };
  return state;
}

/** A fresh engine with a scripted host. */
async function fresh(name, mods, host, configureExtra = {}) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(host === null ? null : host.host);
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  /*
   * NO BACKGROUND REACH SWEEP HERE. The engine also pings every ENABLED server
   * on a cadence with nobody waiting on the answer, so the queue page can say a
   * machine is down while the queue is empty (`QueueSnapshot.servers`). This
   * file asserts WHICH servers a ROUTING decision asked about — "it asked the
   * machine it was told to wait for, and asked nothing about any other" — and a
   * sweep asking all of them would drown exactly that. `0` turns it off; it is
   * a real setting rather than a test hook, and the engine names it as such.
   */
  await engine.configure({
    stateDir: dir, admissionRecheckMs: 5_000, reachSweepMs: 0, ...configureExtra,
  });
  return dir;
}

function jobOf(jobId) {
  return engine.snapshot().jobs.find((j) => j.id === jobId);
}
function firstStep(jobId) {
  return jobOf(jobId).steps[0];
}
function narrate(title, epub = '/a.epub') {
  return {
    title,
    steps: [{
      type: 'tts-conversion', label: 'Narrate', config: {},
      sourceRef: { kind: 'epub', path: epub },
    }],
  };
}

/**
 * Compose a run AND SEND IT to the live queue — the two presses a person makes.
 *
 * Adding a book STAGES it in Pending now (docs/PENDING-QUEUE-AND-GPU-DIAL.md
 * §1): the pump skips a staged run whole, so every test below that is about what
 * the scheduler does with a book has to send it first. A run with nothing that
 * travels is never staged and passes straight through.
 *
 * The staging itself is pinned separately, in its own block at the end.
 */
function enqueueSent(spec) {
  const job = engine.enqueue(spec);
  if (job.pending === true) engine.sendToQueue(job.id);
  return job;
}

const TWO_SERVERS = [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }];

// ── The default is a setting, and it is written into the row ───────────────

test('"top-ranked" writes the top-ranked server\'s NAME onto the row', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('default-top', [gpu], host);

  const job = enqueueSent(narrate('Mistborn'));
  assert.strictEqual(jobOf(job.id).waitFor, 'local',
    'the row SAYS the machine it will use — no null, no inherited default');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'nothing is assigned until admission assigns it');
});

test('"any" writes `any`, and it is the row\'s real value', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'any' });
  await fresh('default-any', [gpu], host);

  const job = enqueueSent(narrate('Wool'));
  assert.strictEqual(jobOf(job.id).waitFor, 'any');
});

test('nothing to name writes NOTHING — not a name, not `any`', async () => {
  // Every server disabled, the setting on `top-ranked`. §4.2.1a: a default must
  // not manufacture an instruction, and `any` would be a routing decision
  // nobody made.
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: false }],
    defaultWaitFor: null,
  });
  await fresh('default-none', [gpu], host);

  const job = enqueueSent(narrate('Nothing to name'));
  assert.strictEqual(jobOf(job.id).waitFor, undefined);

  engine.start();
  await settle();
  assert.match(firstStep(job.id).progress.admissionHold,
    /does not say which Crucible server to render on/,
    'and the row says so rather than picking one');
});

test('a run with nothing that travels gets no field at all', async () => {
  const cpu = fakeModule('reassembly', { resource: () => 'cpu' });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('no-travel-field', [cpu], host);

  const job = enqueueSent({
    title: 'Assemble only',
    steps: [{
      type: 'reassembly', label: 'Assemble', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  assert.strictEqual(jobOf(job.id).waitFor, undefined,
    'a book of assemblies has no Crucible question to answer');
});

// ── A named server is an instruction ────────────────────────────────────────

test('a row naming a DISABLED server holds and says which, and is never re-routed', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: false }, { name: 'mac', enabled: true }],
    defaultWaitFor: 'local',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('named-disabled', [gpu], host);

  const job = enqueueSent(narrate('Deathstalker'));
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 0, 'it did not start');
  assert.strictEqual(firstStep(job.id).status, 'queued');
  assert.strictEqual(firstStep(job.id).progress.admissionHold,
    'Waiting for local: disabled. A named server is an instruction, so this book is not sent '
    + 'anywhere else — enable it in Settings → Crucible Servers, or set this book to Any.');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'and mac, which IS enabled and reachable, was not silently used instead');
});

test('a row naming an UNREACHABLE server holds and says which', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS,
    defaultWaitFor: 'mac',
    reach: { local: { reachable: true }, mac: { reachable: false, detail: 'Nothing answered at http://mac:7100.' } },
  });
  await fresh('named-unreachable', [gpu], host);

  const job = enqueueSent(narrate('Hellworld'));
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 0);
  assert.match(firstStep(job.id).progress.admissionHold, /^Waiting for mac: unreachable — /);
  assert.match(firstStep(job.id).progress.admissionHold, /Nothing answered at http:\/\/mac:7100\./);
  assert.ok(host.asked.includes('mac'), 'it asked the machine it was told to wait for');
  assert.ok(!host.asked.includes('local'), 'and asked nothing about any other');
});

test('a row naming a server this machine does not have is refused by name', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'droplet' });
  await fresh('named-unknown', [gpu], host);

  const job = enqueueSent(narrate('Ghost server'));
  engine.start();
  await settle();
  assert.match(firstStep(job.id).progress.admissionHold,
    /Waiting for droplet: it is not one of this machine's Crucible servers \(local, mac\)/);
});

test('a reachable named server runs, and the machine is written onto the row', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS,
    defaultWaitFor: 'mac',
    reach: { mac: { reachable: true } },
  });
  await fresh('named-runs', [gpu], host);

  const job = enqueueSent(narrate('Sigma'));
  engine.start();
  await settle();

  assert.strictEqual(gpu.runs.length, 1, 'it started');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'the venue is recorded, so a resume goes back to the same machine (§4.3)');
  assert.strictEqual(gpu.runs[0].ctx.job.waitForResolved, 'mac',
    'and the step can read it — that is what becomes settings.crucible');
});

// ── `any` ───────────────────────────────────────────────────────────────────

test('`any` prefers RANK, not whichever answers first', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
    defaultWaitFor: 'any',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('any-rank', [gpu], host);

  const job = enqueueSent(narrate('Rank order'));
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'local', 'the top of the list wins');
  assert.ok(!host.asked.includes('mac'), 'and a server it never needed was never asked');
});

test('`any` skips a disabled one and takes the next that answers', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: false }, { name: 'mac', enabled: true }],
    defaultWaitFor: 'any',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('any-skips', [gpu], host);

  const job = enqueueSent(narrate('Overflow'));
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');
});

test('`any` with none reachable holds and NAMES that', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS,
    defaultWaitFor: 'any',
    reach: {
      local: { reachable: false, detail: 'nothing at 127.0.0.1:7100.' },
      mac: { reachable: false, detail: 'nothing at mac:7100.' },
    },
  });
  await fresh('any-none', [gpu], host);

  const job = enqueueSent(narrate('Nobody home'));
  engine.start();
  await settle();
  assert.strictEqual(firstStep(job.id).progress.admissionHold,
    'Waiting for any server; none of the 2 enabled are reachable '
    + '(local: nothing at 127.0.0.1:7100.; mac: nothing at mac:7100.).');
});

test('`any` with nothing enabled says THAT, which is a different sentence', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: false }, { name: 'mac', enabled: false }],
    defaultWaitFor: 'any',
  });
  await fresh('any-none-enabled', [gpu], host);

  const job = enqueueSent(narrate('All off'));
  engine.start();
  await settle();
  assert.match(firstStep(job.id).progress.admissionHold,
    /none of the 2 you have is enabled \(local, mac\)/);
});

// ── A 409 is a wait ─────────────────────────────────────────────────────────

test('a busy server holds the row with the holder\'s line, and does not fail it', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  await fresh('busy', [gpu], host);

  const job = enqueueSent(narrate('Behind Foundry'));
  engine.start();
  await settle();
  assert.strictEqual(firstStep(job.id).status, 'running');

  // The submit came back 409. The step then throws, as a refused render does.
  engine.noteStepBusy(firstStep(job.id).id, 'GPU busy: foundry, tts 62% done.');
  gpu.runs[0].reject(new Error('server_busy: crucible "mac" takes one job at a time.'));
  await settle();

  const step = firstStep(job.id);
  assert.strictEqual(step.status, 'queued', 'a 409 is a wait, not a failure');
  assert.strictEqual(step.error, undefined, 'and nothing about this row is wrong');
  assert.strictEqual(step.progress.admissionHold,
    'Waiting for mac: GPU busy: foundry, tts 62% done. It takes one job at a time; this book '
    + 'goes on as soon as that one is done.');
  assert.strictEqual(gpu.runs.length, 1, 'and it did not immediately re-submit into the same 409');
});

test('the busy hold expires and the queue tries again on its own tick', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  // A second of cool-off, because `settle()`'s twenty setTimeout(0) turns are
  // real milliseconds on Windows (the timer floor is ~15 ms) and a shorter one
  // would expire inside the settle that is meant to observe it standing.
  await fresh('busy-expiry', [gpu], host, { admissionRecheckMs: 1_000 });

  const job = enqueueSent(narrate('Retry'));
  engine.start();
  await settle();
  engine.noteStepBusy(firstStep(job.id).id, 'GPU busy: foundry.');
  gpu.runs[0].reject(new Error('server_busy'));
  await settle(4);
  assert.strictEqual(firstStep(job.id).status, 'queued', 'the cool-off stands');
  assert.strictEqual(gpu.runs.length, 1);

  await wait(1_400);
  await settle();
  assert.strictEqual(gpu.runs.length, 2, 'the recheck tried the door again');
});

// ── The record changing under queued rows ───────────────────────────────────

test('a queued row does NOT move when the drag-order changes', async () => {
  // §4.2.2's "Two consequences confirmed as deliberate": re-ranking affects new
  // rows only, and the reversal is correct BECAUSE the value is visible.
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('rerank', [gpu], host);

  const job = enqueueSent(narrate('Frozen'));
  assert.strictEqual(jobOf(job.id).waitFor, 'local');

  // The operator drags mac to the top. The record's DEFAULT changes with it.
  host.ranked = [{ name: 'mac', enabled: true }, { name: 'local', enabled: true }];
  host.defaultWaitFor = 'mac';
  host.reach = { local: { reachable: true }, mac: { reachable: true } };
  engine.start();
  await settle();

  assert.strictEqual(jobOf(job.id).waitFor, 'local', 'the queued row still says what it said');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'local', 'and still runs there');
});

test('disabling a server SURFACES the rows that name it — a count and one click', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('surface', [gpu], host);

  enqueueSent(narrate('One', '/1.epub'));
  enqueueSent(narrate('Two', '/2.epub'));
  enqueueSent(narrate('Three', '/3.epub'));

  assert.deepStrictEqual(engine.waitForCounts(), { counts: { local: 3 }, unset: 0 },
    'the count the Servers row shows beside a switch somebody just turned off');

  // Told, not moved: disabling changes nothing about the rows by itself.
  host.ranked = [{ name: 'local', enabled: false }, { name: 'mac', enabled: true }];
  assert.deepStrictEqual(engine.waitForCounts(), { counts: { local: 3 }, unset: 0 });

  // The one click.
  assert.strictEqual(engine.bulkWaitFor('local', 'any'), 3);
  assert.deepStrictEqual(engine.waitForCounts(), { counts: { any: 3 }, unset: 0 });
});

test('the bulk change reaches the rows that say NOTHING as well', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: null });
  await fresh('bulk-unset', [gpu], host);

  enqueueSent(narrate('Silent one', '/1.epub'));
  enqueueSent(narrate('Silent two', '/2.epub'));
  assert.deepStrictEqual(engine.waitForCounts(), { counts: {}, unset: 2 });

  assert.strictEqual(engine.bulkWaitFor(null, 'any'), 2);
  assert.deepStrictEqual(engine.waitForCounts(), { counts: { any: 2 }, unset: 0 });
});

// ── The picker's own refusals ───────────────────────────────────────────────

test('the picker refuses a server this machine does not have, by name', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('pick-unknown', [gpu], host);
  const job = enqueueSent(narrate('Pick'));
  assert.throws(() => engine.setWaitFor(job.id, 'droplet'),
    /"droplet" is not one of this machine's Crucible servers \(local, mac\)/);
  assert.strictEqual(jobOf(job.id).waitFor, 'local', 'and it changed nothing');
});

test('the picker refuses a book that has already been assigned (§4.3)', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  await fresh('pick-assigned', [gpu], host);
  const job = enqueueSent(narrate('Assigned'));
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');
  /*
   * THE EDIT/ADMISSION RACE, SETTLED BY NAME — Owen's rule
   * (docs/PENDING-QUEUE-AND-GPU-DIAL.md, "Mutability"): an edit that arrives
   * after admission is REFUSED, naming the row and the server it went to, never
   * silently applied to a running job and never silently dropped.
   *
   * All three halves are pinned: the CODE a caller can branch on, the ROW and
   * the SERVER in the words, and the fact that the book did not move.
   */
  assert.throws(() => engine.setWaitFor(job.id, 'local'), (err) => {
    assert.strictEqual(err.name, 'QueueRoutingRefusal');
    assert.strictEqual(err.code, 'venue_fixed_at_admission');
    assert.match(err.message, /Assigned/, 'the refusal names the row');
    assert.match(err.message, /on mac/, 'and the server it went to');
    assert.match(err.message, /Nothing here has been altered/);
    return true;
  });
  assert.strictEqual(jobOf(job.id).waitFor, 'mac', 'and nothing was applied');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');
});

test('the picker refuses a run with nothing that travels', async () => {
  const cpu = fakeModule('reassembly', { resource: () => 'cpu' });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('pick-no-travel', [cpu], host);
  const job = enqueueSent({
    title: 'Assemble only',
    steps: [{
      type: 'reassembly', label: 'Assemble', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  assert.throws(() => engine.setWaitFor(job.id, 'mac'),
    /has no step that can run on a Crucible server/);
});

// ── The DELETED local narrator ──────────────────────────────────────────────

test('a row still assigned to the deleted narrator HOLDS, and is never re-decided', async () => {
  /*
   * THE SWITCH IS GONE (docs/LEGACY-REMOVAL.md) and so is the spawn behind it,
   * but a queue file on disk can still carry the venue it wrote. Re-deciding
   * would send a half-rendered book to a different card, which is exactly what
   * PHASE7-LANES §4.3 forbids — so it holds, with a sentence naming the
   * retirement, and the operator queues it again.
   */
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  await fresh('retired-venue-seed', [gpu], host);

  // A state file from the build that still had the switch, written by hand —
  // its own directory, so the hand-written file is not racing the pending
  // persist of the engine just configured on the other one.
  const dir = path.join(SCRATCH, 'retired-venue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue-engine.json'), JSON.stringify({
    version: 1,
    running: false,
    jobs: [{
      id: 'job_legacy', title: 'Rendered by the old narrator',
      waitFor: 'mac',
      waitForResolved: waitFor.RETIRED_LOCAL_NARRATOR_VENUE,
      steps: [{
        id: 'step_legacy', type: 'tts-conversion', label: 'Narrate', config: {},
        parentStepId: 'source', sourceRef: { kind: 'epub', path: '/a.epub' },
        resource: 'gpu', status: 'held', progress: {}, metrics: {},
        addedAt: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
    }],
  }), 'utf-8');
  // `reachSweepMs: 0` for `fresh`'s reason — this case's last assertion is that
  // NOTHING was asked, which is the whole point of a retired venue.
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000, reachSweepMs: 0 });

  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0, 'nothing ran');
  assert.match(
    jobOf('job_legacy').steps[0].progress.admissionHold ?? '',
    /the local narrator, which no longer exists/,
  );
  assert.strictEqual(jobOf('job_legacy').waitForResolved,
    waitFor.RETIRED_LOCAL_NARRATOR_VENUE,
    'and the row is not quietly re-pointed at a machine');
  assert.strictEqual(host.asked.length, 0, 'and no server was asked anything');
});

test('a book already assigned to a server keeps that server', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true, stopIsResumable: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  await fresh('legacy-midbook', [gpu], host);

  const job = enqueueSent(narrate('Half rendered'));
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');

  // It stops, the record changes under it, and it is started again.
  gpu.runs[0].reject(new Error('Stopped by the user.'));
  await settle();
  host.ranked = [{ name: 'mac', enabled: false }, { name: 'local', enabled: true }];
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'a job finishes on the machine it started on — §4.3');
});

// ── What routing must NOT touch ─────────────────────────────────────────────

test('a GPU step that does not travel is admitted exactly as it is today', async () => {
  const vlm = fakeModule('vlm-convert');   // no machines() — the default, `local`
  const host = fakeHost({ ranked: [], defaultWaitFor: null });
  await fresh('no-travel-admit', [vlm], host);

  const job = enqueueSent({
    title: 'Read the pages',
    steps: [{
      type: 'vlm-convert', label: 'Read', config: {},
      sourceRef: { kind: 'epub', path: '/p.pdf' },
    }],
  });
  engine.start();
  await settle();
  assert.strictEqual(vlm.runs.length, 1,
    'a machine with no Crucible server at all still reads its pages');
  assert.strictEqual(host.asked.length, 0);
});

test('a REMOTE step is not held by this machine\'s GPU lock; a local one is', async () => {
  // crucible §2.5: a step running on another machine does not hold the LOCAL
  // card, so a training chain that owns the 3090 Ti must not stop a Mac render.
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('remote-skips-lock', [gpu], host);
  engine.setGpuLockProbe(() => 'orpheus fine-tune (pid 1234)');

  const remote = enqueueSent(narrate('On the Mac', '/mac.epub'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'the Mac render started');
  assert.strictEqual(jobOf(remote.id).waitForResolved, 'mac');

  // A book bound for THIS machine waits on the lock, exactly as it always has.
  gpu.runs[0].resolve();
  await settle();
  host.defaultWaitFor = 'local';
  const local = enqueueSent(narrate('On this PC', '/pc.epub'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'nothing new started');
  assert.match(firstStep(local.id).progress.admissionHold,
    /another job outside BookForge is using it — orpheus fine-tune/);
});

// ── The migration ───────────────────────────────────────────────────────────

test('a queue file written before the field holds, and is reported ONCE by name', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('migration-seed', [gpu], host);
  // A SEPARATE directory, so the hand-written file is not racing the pending
  // persist of the engine that was just configured on the other one.
  const dir = path.join(SCRATCH, 'migration');
  fs.mkdirSync(dir, { recursive: true });

  // A state file from a build that had no `waitFor`, written by hand.
  const older = {
    version: 1,
    running: false,
    jobs: [{
      id: 'job_old', title: 'The Rise and Fall of the Third Reich',
      steps: [{
        id: 'step_old', type: 'tts-conversion', label: 'Narrate', config: {},
        parentStepId: 'source', sourceRef: { kind: 'epub', path: '/tr.epub' },
        resource: 'gpu', status: 'held', progress: {}, metrics: {},
        addedAt: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
    }],
  };
  fs.writeFileSync(path.join(dir, 'queue-engine.json'), JSON.stringify(older), 'utf-8');
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });

  const job = engine.snapshot().jobs[0];
  assert.strictEqual(job.waitFor, undefined,
    'the honest reading: nobody was ever asked, so the row carries no instruction');
  assert.strictEqual(job.steps[0].travels, true, 'and the module says it CAN travel');

  const report = engine.waitForMigrationReport();
  assert.match(report, /1 queued run\(s\) were composed before BookForge could name a Crucible server/);
  assert.match(report, /The Rise and Fall of the Third Reich/);

  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0, 'it holds rather than guessing a machine');
  assert.strictEqual(engine.snapshot().jobs[0].steps[0].progress.admissionHold, waitFor.holdNoAnswer());
});

test('a queue with nothing to migrate reports nothing', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('migration-none', [gpu], host);
  enqueueSent(narrate('Fresh'));
  assert.strictEqual(engine.describeWaitForMigration(engine.snapshot().jobs), null);
});

// ── What the page draws ─────────────────────────────────────────────────────

test('the book plan carries the answer, the venue, and whether it travels', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'any', reach: { local: { reachable: true } },
  });
  await fresh('plan', [gpu], host);

  const job = enqueueSent(narrate('Drawn'));
  let plan = bench.bookPlans(engine.snapshot())[0];
  assert.strictEqual(plan.travels, true, 'so the page draws a picker');
  assert.deepStrictEqual(plan.waitFor, ['any']);
  assert.deepStrictEqual(plan.waitForResolved, [], 'nothing assigned yet, so it is editable');

  engine.start();
  await settle();
  plan = bench.bookPlans(engine.snapshot())[0];
  assert.deepStrictEqual(plan.waitForResolved, ['local'], 'and now it reads as where it runs');
  assert.ok(jobOf(job.id).waitForResolved === 'local');
});

test('a book of passes draws no picker', async () => {
  const cpu = fakeModule('reassembly', { resource: () => 'cpu' });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('plan-no-travel', [cpu], host);
  enqueueSent({
    title: 'Assemble', steps: [{
      type: 'reassembly', label: 'Assemble', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  const plan = bench.bookPlans(engine.snapshot())[0];
  assert.strictEqual(plan.travels, false);
  assert.deepStrictEqual(plan.waitFor, []);
});

// ── The pure decision, directly ─────────────────────────────────────────────

test('decideWaitFor asks before it answers, and asks only what it needs', () => {
  const ranked = [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }];
  const unknown = () => ({ kind: 'unknown' });
  assert.deepStrictEqual(
    waitFor.decideWaitFor({
      waitFor: 'any', resolved: undefined, ranked, dial: 'any', state: unknown,
      gpuSlotTaken: () => null,
    }),
    { kind: 'ask', server: 'local', sentence: 'Checking whether local is reachable…' },
    'rank order decides WHICH question is asked first, not just which answer wins',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// THE GPU DIAL — docs/PENDING-QUEUE-AND-GPU-DIAL.md
// ────────────────────────────────────────────────────────────────────────────
//
// "The dial defers, it never overrides." Every row of Owen's precedence table is
// driven here, on the pure function, because that table IS the feature: a dial
// that quietly moved a book onto a different card would be the one outcome the
// whole document rules out.

/** The five facts `decideWaitFor` takes, with the boring ones filled in. */
function facts(over) {
  return {
    waitFor: undefined,
    resolved: undefined,
    ranked: [{ name: '3090 Ti', enabled: true }, { name: 'M1 Ultra', enabled: true }],
    dial: 'any',
    state: () => ({ kind: 'ready' }),
    gpuSlotTaken: () => null,
    ...over,
  };
}

test('PRECEDENCE: a named server + dial `any` runs on the NAMED one', () => {
  assert.deepStrictEqual(
    waitFor.decideWaitFor(facts({ waitFor: '3090 Ti', dial: 'any' })),
    { kind: 'run', server: '3090 Ti' },
    'an explicit instruction is never second-guessed',
  );
});

test('PRECEDENCE: `any` + a dial that names a server takes the DIAL\'s server', () => {
  assert.deepStrictEqual(
    waitFor.decideWaitFor(facts({ waitFor: 'any', dial: 'M1 Ultra' })),
    { kind: 'run', server: 'M1 Ultra' },
  );
});

test('PRECEDENCE: the same server on both runs there', () => {
  assert.deepStrictEqual(
    waitFor.decideWaitFor(facts({ waitFor: 'M1 Ultra', dial: 'M1 Ultra' })),
    { kind: 'run', server: 'M1 Ultra' },
  );
});

test('PRECEDENCE: a DIFFERENT server on each SITS — not failed, not re-routed', () => {
  const verdict = waitFor.decideWaitFor(facts({ waitFor: '3090 Ti', dial: 'M1 Ultra' }));
  assert.strictEqual(verdict.kind, 'hold', 'it waits; it is never sent to the other card');
  // Owen's first parked sentence, verbatim in its first clause.
  assert.ok(verdict.sentence.startsWith('Waiting for 3090 Ti — the queue is set to M1 Ultra.'),
    `the sentence must name BOTH machines: ${verdict.sentence}`);
  assert.match(verdict.sentence, /may be completely idle/,
    'and say that the card it names may be doing nothing — the fix is a dial turn');
  assert.ok(!/to become free/.test(verdict.sentence),
    'it must NOT read as "the server is occupied" — that is a different cause');
});

test('PRECEDENCE: `any` on both is today\'s behaviour — the first that will take it', () => {
  assert.deepStrictEqual(
    waitFor.decideWaitFor(facts({ waitFor: 'any', dial: 'any' })),
    { kind: 'run', server: '3090 Ti' },
  );
});

test('the dial NEVER shops: `any` + a busy dialled server waits on THAT machine', () => {
  // The `any` loop would happily take the next server in rank order. With the
  // dial set, there is no loop: the operator chose, and a choice that silently
  // slid onto another card would not be a choice.
  const verdict = waitFor.decideWaitFor(facts({
    waitFor: 'any',
    dial: 'M1 Ultra',
    state: (name) => (name === 'M1 Ultra'
      ? { kind: 'busy', line: 'Foundry is reading Mistborn.' }
      : { kind: 'ready' }),
  }));
  assert.strictEqual(verdict.kind, 'hold');
  assert.match(verdict.sentence, /M1 Ultra/);
  assert.ok(!/3090 Ti/.test(verdict.sentence), 'the other card is not even considered');
});

test('THE THREE PARKED SENTENCES NAME THREE DIFFERENT CAUSES', () => {
  const dialElsewhere = waitFor.decideWaitFor(
    facts({ waitFor: '3090 Ti', dial: 'M1 Ultra' })).sentence;
  const disabled = waitFor.decideWaitFor(facts({
    waitFor: '3090 Ti',
    dial: 'any',
    ranked: [{ name: '3090 Ti', enabled: false }, { name: 'M1 Ultra', enabled: true }],
  })).sentence;
  const unreachable = waitFor.decideWaitFor(facts({
    waitFor: '3090 Ti',
    state: () => ({ kind: 'unreachable', detail: 'Nothing answered at 3090 Ti.' }),
  })).sentence;

  assert.match(dialElsewhere, /the queue is set to M1 Ultra/);
  assert.match(disabled, /disabled/);
  assert.match(unreachable, /unreachable/);
  const all = [dialElsewhere, disabled, unreachable];
  assert.strictEqual(new Set(all).size, 3, 'three causes, three sentences, never collapsed');
  // Collapsing these would name the wrong cause, which is the failure shape this
  // whole feature exists to close.
  assert.ok(!/disabled/.test(dialElsewhere));
  assert.ok(!/the queue is set to/.test(disabled));
  assert.ok(!/the queue is set to/.test(unreachable));
});

test('a dial-chosen hold says to turn the DIAL, not to re-answer a book already on Any', () => {
  const verdict = waitFor.decideWaitFor(facts({
    waitFor: 'any',
    dial: 'M1 Ultra',
    ranked: [{ name: '3090 Ti', enabled: true }, { name: 'M1 Ultra', enabled: false }],
  }));
  assert.strictEqual(verdict.kind, 'hold');
  assert.match(verdict.sentence, /turn the queue's GPU dial to Any/);
  assert.ok(!/set this book to Any/.test(verdict.sentence),
    'the book IS on Any — telling its operator to set it to Any is the wrong fix');
});

test('A RUNNING JOB IGNORES THE DIAL — an assigned row never re-reads it', () => {
  assert.deepStrictEqual(
    waitFor.decideWaitFor(facts({ waitFor: 'any', resolved: '3090 Ti', dial: 'M1 Ultra' })),
    { kind: 'run', server: '3090 Ti' },
    'a job that started somewhere finishes there — turning the dial governs new runs only',
  );
});

test('a caller that supplies NO dial is refused by name, never defaulted', () => {
  const bare = facts({ waitFor: 'any' });
  delete bare.dial;
  assert.throws(() => waitFor.decideWaitFor(bare), /`dial` was not supplied/);
});

test('THE DIAL PARKS A ROW IN THE LIVE QUEUE, and either control frees it', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS,
    defaultWaitFor: 'mac',
    dial: 'local',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('dial-park', [gpu], host);

  const job = enqueueSent(narrate('Steered'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0, 'it is not sent to the dial\'s machine');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'and nothing is assigned, so both controls are still live');
  assert.match(firstStep(job.id).progress.admissionHold,
    /Waiting for mac — the queue is set to local\./);

  // Way out #1: move the BOOK. Same row, no cancel, no re-add.
  engine.setWaitFor(job.id, 'local');
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'it starts the moment the two agree');
  assert.strictEqual(jobOf(job.id).waitForResolved, 'local');
});

test('…or the DIAL moves, and the parked row starts where IT asked to', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS,
    defaultWaitFor: 'mac',
    dial: 'local',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('dial-turn', [gpu], host);

  const job = enqueueSent(narrate('Steered too'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0);

  host.dial = 'any';
  engine.pump();
  await settle();
  assert.strictEqual(gpu.runs.length, 1);
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac',
    'the dial deferred: the book went where IT named, not where the dial had been');
});

// ────────────────────────────────────────────────────────────────────────────
// PENDING — adding a book stages it
// ────────────────────────────────────────────────────────────────────────────

test('adding a book STAGES it: nothing is committed and Start does not move it', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS,
    defaultWaitFor: 'mac',
    reach: { local: { reachable: true }, mac: { reachable: true } },
  });
  await fresh('pending-stage', [gpu], host);

  const job = engine.enqueue(narrate('Staged'));
  assert.strictEqual(jobOf(job.id).pending, true);
  assert.strictEqual(firstStep(job.id).status, 'held');

  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0, 'the pump skips a staged run whole');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined, 'no venue is decided for it');
  assert.strictEqual(firstStep(job.id).progress.admissionHold, undefined,
    'and no admission sentence is written on it — it was never asked about');
  assert.strictEqual(firstStep(job.id).status, 'held',
    'the whole-queue Start does not sweep a staged book into the live queue');

  // Its server is editable in Pending — that is what Pending is FOR.
  engine.setWaitFor(job.id, 'local');
  assert.strictEqual(jobOf(job.id).waitFor, 'local');

  engine.sendToQueue(job.id);
  await settle();
  assert.strictEqual(jobOf(job.id).pending, undefined);
  assert.strictEqual(gpu.runs.length, 1, 'Send to queue is the press that commits it');
});

test('Start pressed ON a staged book is REFUSED BY NAME, never a silent no-op', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'mac' });
  await fresh('pending-start', [gpu], host);
  const job = engine.enqueue(narrate('Staged too'));
  assert.throws(() => engine.start({ jobId: job.id }), (err) => {
    assert.strictEqual(err.code, 'still_pending');
    assert.match(err.message, /Staged too is in Pending/);
    assert.match(err.message, /Send to queue/);
    return true;
  });
  assert.strictEqual(firstStep(job.id).status, 'held');
});

test('Send to queue on a run that is NOT staged is refused by name', async () => {
  const cpu = fakeModule('reassembly', { resource: () => 'cpu' });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'mac' });
  await fresh('pending-not', [cpu], host);
  const job = engine.enqueue({
    title: 'Assemble only',
    steps: [{
      type: 'reassembly', label: 'Assemble', config: {},
      sourceRef: { kind: 'audio-session', path: '/s' },
    }],
  });
  assert.strictEqual(jobOf(job.id).pending, undefined,
    'a run with nothing that travels has no server to choose, so it is never staged');
  assert.throws(() => engine.sendToQueue(job.id), (err) => {
    assert.strictEqual(err.code, 'not_pending');
    return true;
  });
});

test('PENDING SURVIVES A RESTART — a staged book does not vanish, and does not run', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'mac', reach: { mac: { reachable: true } },
  });
  const dir = await fresh('pending-restart', [gpu], host);
  const job = engine.enqueue(narrate('Overnight'));
  engine.setWaitFor(job.id, 'local');
  await engine.persist();

  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });
  const back = jobOf(job.id);
  assert.ok(back !== undefined, 'a book staged but not sent must not vanish');
  assert.strictEqual(back.pending, true, 'and it is still staged, not quietly queued');
  assert.strictEqual(back.waitFor, 'local', 'with the server chosen for it intact');
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0);
});

test('a build with no routing host refuses out loud rather than taking the local card', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  await fresh('no-host', [gpu], null);
  const job = enqueueSent(narrate('Unwired'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0);
  assert.match(firstStep(job.id).progress.admissionHold,
    /did not wire the queue's Crucible routing/);
});

// ── The sweep, and what it publishes ────────────────────────────────────────

/*
 * WHAT THE PAGE NEEDS AND ROUTING NEVER ASKED FOR. Every probe above is made
 * BECAUSE a queued row wants a machine. With an empty queue nobody asks, so
 * until 2026-09-18 the queue page drew a lane per engine and could not say
 * whether the machine behind it was awake — a sleeping Mac was drawn exactly
 * like a working one and its books simply never started.
 *
 * The sweep is that second caller: every ENABLED server, on the admission
 * cadence, with nobody waiting. It asks through the SAME `askReach` and lands
 * in the SAME cache, so the page and admission can never read two different
 * answers about one machine.
 */

test('the sweep asks every ENABLED server with an empty queue, and no disabled one', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: false }],
    defaultWaitFor: 'any',
    reach: { local: { reachable: true } },
  });
  // The sweep ON, and nothing queued at all.
  await fresh('reach-sweep', [gpu], host, { reachSweepMs: 50 });
  await settle();

  assert.ok(host.asked.includes('local'),
    'an enabled server is asked though no row wants it — this is the whole point');
  assert.ok(!host.asked.includes('mac'),
    'and a server the operator switched off is never pinged: they already said no');
});

test('the snapshot carries what each server said, beside the switch', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
    defaultWaitFor: 'any',
    reach: {
      local: { reachable: true },
      mac: { reachable: false, detail: 'Nothing answered at http://mac:7100.' },
    },
  });
  await fresh('reach-snapshot', [gpu], host, { reachSweepMs: 50 });
  await settle();

  const rows = engine.snapshot().servers;
  assert.deepStrictEqual(rows.map((r) => r.name), ['local', 'mac'],
    'in rank order, so the rows line up with the lanes the bench builds');
  assert.deepStrictEqual(rows.find((r) => r.name === 'local'),
    { name: 'local', enabled: true, reach: 'ready', detail: null });
  assert.deepStrictEqual(rows.find((r) => r.name === 'mac'),
    { name: 'mac', enabled: true, reach: 'unreachable', detail: 'Nothing answered at http://mac:7100.' },
    "the transport's own sentence travels with the answer — the lane has nothing to say without it");
});

test('a disabled server is REPORTED, as `unknown` — off is not a diagnosis', async () => {
  /*
   * The two facts stay apart. `enabled` is the operator's standing choice about
   * that hardware; `reach` is what the machine said. Nothing asked a disabled
   * one, so `unknown` is the honest answer — and a surface that read it as
   * "down" would be inventing a measurement, exactly as one that switched a
   * sleeping machine off would be inventing a decision.
   */
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: false }], defaultWaitFor: 'any', reach: {},
  });
  await fresh('reach-disabled', [gpu], host, { reachSweepMs: 50 });
  await settle();

  assert.deepStrictEqual(engine.snapshot().servers,
    [{ name: 'mac', enabled: false, reach: 'unknown', detail: null }],
    'a machine the operator owns never vanishes from the list they reason with');
});

test('a reach answer that CHANGES publishes a snapshot, with nothing queued', async () => {
  /*
   * `askReach` ends in `.finally(pump)`, and a pump publishes only when it
   * changes something in the QUEUE. A machine going down changes nothing there
   * when the queue is empty — which is precisely the case the page needs to
   * hear about — so a changed observation publishes on its own account.
   */
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: [{ name: 'mac', enabled: true }], defaultWaitFor: 'any',
    reach: { mac: { reachable: true } },
  });
  // A 100 ms TTL and a 30 ms sweep, which is the production relation (the sweep
  // follows `reachTtlMs`) wound down to test speed: an answer ages out, the
  // next sweep asks again, and THAT is when a machine's going away is noticed.
  await fresh('reach-publish', [gpu], host, { admissionRecheckMs: 100, reachSweepMs: 30 });
  await settle();
  assert.strictEqual(engine.snapshot().servers[0].reach, 'ready', 'it was up to begin with');

  // Only now does anyone listen, and only then does the machine go away. The
  // queue is empty throughout, so a pump has nothing to publish about.
  const seen = [];
  const off = engine.onQueueChanged((snap) => { seen.push(snap.servers); });
  host.reach = { mac: { reachable: false, detail: 'Nothing answered at http://mac:7100.' } };
  await wait(120);
  await settle();
  off();

  const down = seen.find((rows) => rows.some((r) => r.reach === 'unreachable'));
  assert.ok(down, 'the page was told, with an empty queue and nothing else to report');
  assert.strictEqual(down[0].detail, 'Nothing answered at http://mac:7100.');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  await engine.shutdown();
  engine.setCrucibleRoutingHost(null);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nqueue wait-for: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});

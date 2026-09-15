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
    localName: initial.localName === undefined ? 'local' : initial.localName,
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    reach: initial.reach ?? {},
    asked: [],
  };
  state.host = {
    routing: () => ({
      ranked: state.ranked.map((row) => ({ ...row })),
      localName: state.localName,
    }),
    defaultWaitFor: () => state.defaultWaitFor,
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
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000, ...configureExtra });
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

const TWO_SERVERS = [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }];

// ── The default is a setting, and it is written into the row ───────────────

test('"top-ranked" writes the top-ranked server\'s NAME onto the row', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('default-top', [gpu], host);

  const job = engine.enqueue(narrate('Mistborn'));
  assert.strictEqual(jobOf(job.id).waitFor, 'local',
    'the row SAYS the machine it will use — no null, no inherited default');
  assert.strictEqual(jobOf(job.id).waitForResolved, undefined,
    'nothing is assigned until admission assigns it');
});

test('"any" writes `any`, and it is the row\'s real value', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'any' });
  await fresh('default-any', [gpu], host);

  const job = engine.enqueue(narrate('Wool'));
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

  const job = engine.enqueue(narrate('Nothing to name'));
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

  const job = engine.enqueue({
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

  const job = engine.enqueue(narrate('Deathstalker'));
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

  const job = engine.enqueue(narrate('Hellworld'));
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

  const job = engine.enqueue(narrate('Ghost server'));
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

  const job = engine.enqueue(narrate('Sigma'));
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

  const job = engine.enqueue(narrate('Rank order'));
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

  const job = engine.enqueue(narrate('Overflow'));
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

  const job = engine.enqueue(narrate('Nobody home'));
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

  const job = engine.enqueue(narrate('All off'));
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

  const job = engine.enqueue(narrate('Behind Foundry'));
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

  const job = engine.enqueue(narrate('Retry'));
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

  const job = engine.enqueue(narrate('Frozen'));
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

  engine.enqueue(narrate('One', '/1.epub'));
  engine.enqueue(narrate('Two', '/2.epub'));
  engine.enqueue(narrate('Three', '/3.epub'));

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

  engine.enqueue(narrate('Silent one', '/1.epub'));
  engine.enqueue(narrate('Silent two', '/2.epub'));
  assert.deepStrictEqual(engine.waitForCounts(), { counts: {}, unset: 2 });

  assert.strictEqual(engine.bulkWaitFor(null, 'any'), 2);
  assert.deepStrictEqual(engine.waitForCounts(), { counts: { any: 2 }, unset: 0 });
});

// ── The picker's own refusals ───────────────────────────────────────────────

test('the picker refuses a server this machine does not have, by name', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('pick-unknown', [gpu], host);
  const job = engine.enqueue(narrate('Pick'));
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
  const job = engine.enqueue(narrate('Assigned'));
  engine.start();
  await settle();
  assert.strictEqual(jobOf(job.id).waitForResolved, 'mac');
  assert.throws(() => engine.setWaitFor(job.id, 'local'),
    /already running on mac, and a book finishes on the machine it started on/);
});

test('the picker refuses a run with nothing that travels', async () => {
  const cpu = fakeModule('reassembly', { resource: () => 'cpu' });
  const host = fakeHost({ ranked: TWO_SERVERS, defaultWaitFor: 'local' });
  await fresh('pick-no-travel', [cpu], host);
  const job = engine.enqueue({
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
  await engine.configure({ stateDir: dir, admissionRecheckMs: 5_000 });

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

  const job = engine.enqueue(narrate('Half rendered'));
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

  const job = engine.enqueue({
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

  const remote = engine.enqueue(narrate('On the Mac', '/mac.epub'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 1, 'the Mac render started');
  assert.strictEqual(jobOf(remote.id).waitForResolved, 'mac');

  // A book bound for THIS machine waits on the lock, exactly as it always has.
  gpu.runs[0].resolve();
  await settle();
  host.defaultWaitFor = 'local';
  const local = engine.enqueue(narrate('On this PC', '/pc.epub'));
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
  engine.enqueue(narrate('Fresh'));
  assert.strictEqual(engine.describeWaitForMigration(engine.snapshot().jobs), null);
});

// ── What the page draws ─────────────────────────────────────────────────────

test('the book plan carries the answer, the venue, and whether it travels', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  const host = fakeHost({
    ranked: TWO_SERVERS, defaultWaitFor: 'any', reach: { local: { reachable: true } },
  });
  await fresh('plan', [gpu], host);

  const job = engine.enqueue(narrate('Drawn'));
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
  engine.enqueue({
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
      waitFor: 'any', resolved: undefined, ranked, state: unknown,
      gpuSlotTaken: () => null,
    }),
    { kind: 'ask', server: 'local', sentence: 'Checking whether local is reachable…' },
    'rank order decides WHICH question is asked first, not just which answer wins',
  );
});

test('a build with no routing host refuses out loud rather than taking the local card', async () => {
  const gpu = fakeModule('tts-conversion', { travels: true });
  await fresh('no-host', [gpu], null);
  const job = engine.enqueue(narrate('Unwired'));
  engine.start();
  await settle();
  assert.strictEqual(gpu.runs.length, 0);
  assert.match(firstStep(job.id).progress.admissionHold,
    /did not wire the queue's Crucible routing/);
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

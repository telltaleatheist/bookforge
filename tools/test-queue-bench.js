#!/usr/bin/env node
/**
 * Tests for shared/queue/bench.ts — the slots, and the reason every still row
 * gives for being still.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-bench.js
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - THE ORDER OF THE REASONS. A still row usually satisfies several at once,
 *    and the one worth saying is the one that has to change first. A row whose
 *    parent has not finished is not "waiting for the card" even when the card is
 *    also busy — saying so would send the user to free a GPU that is not the
 *    problem. Every one of those precedence pairs is a test here, because they
 *    are invisible in the source: the code reads as a list of ifs, and the
 *    ORDER is the whole design.
 *  - A STALE HOLD MUST LOSE TO A FULL POOL. The engine stops asking admission
 *    once the pool is full, so a hold recorded before our own work took the card
 *    can still be sitting on the row. Reading it out then would name an external
 *    lock that may be long gone.
 *  - ALL THREE SLOTS ARE ALWAYS DRAWN. A free slot says nothing queued wants
 *    that resource, which is the difference between a queue that is stuck and a
 *    queue with nothing to do.
 *  - NULL PERCENT IS NOT ZERO PERCENT. A step that has measured nothing has not
 *    reported no progress, and a bar drawn at zero is a claim it never made.
 *  - A RUNNING OR FINISHED STEP HAS NO REASON, AND ASKING THROWS. Answering
 *    anyway would let a caller draw "waiting for the card" beside a moving bar.
 *  - A STOPPED RUN IS NOT A FAILURE. The user stopped it; it does not belong in
 *    the band that exists to be empty.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MOD = path.join(REPO, 'dist', 'shared', 'queue', 'bench.js');
if (!fs.existsSync(MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const bench = require(MOD);
const slots = require(path.join(REPO, 'dist', 'shared', 'queue', 'slot-sets.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

/** A step, with only what the bench reads. */
function step(over = {}) {
  seq += 1;
  return {
    id: over.id || `step_${seq}`,
    type: 'tts-conversion',
    label: 'Narrate',
    config: {},
    parentStepId: 'source',
    resource: 'gpu',
    status: 'queued',
    progress: {},
    metrics: {},
    addedAt: '2026-08-19T10:00:00.000Z',
    ...over,
  };
}

function job(steps, over = {}) {
  return {
    id: over.id || 'job_1',
    title: 'Flashpoint of Revival',
    steps,
    createdAt: '2026-08-19T10:00:00.000Z',
    ...over,
  };
}

/**
 * A snapshot. `running` defaults TRUE — a paused queue is its own test.
 *
 * `slotSets` is composed by the REAL composer rather than written out here, so
 * a keeper cannot pass against a capacity model the engine does not have. With
 * no servers named, that is BookForge's own two CPU slots, plus the legacy
 * narrator's one GPU slot WHEN SOMETHING IN THESE JOBS CHARGES IT (2026-09-15 —
 * the row is no longer unconditional). A test that wants a GPU lane therefore
 * queues a GPU step that cannot travel, and with that the shape is exactly what
 * the old global `RESOURCE_SLOTS` had, which is why every pre-per-server test
 * below still reads the same.
 */
function snap(jobs, running = true, servers = []) {
  const occupied = [];
  for (const j of jobs) {
    for (const s of j.steps) {
      if (s.status !== 'running') continue;
      const id = slots.slotSetForStep(j, s);
      if (id !== null && !occupied.includes(id)) occupied.push(id);
    }
  }
  return {
    jobs,
    running,
    /*
     * NOBODY HAS ASKED ANY MACHINE ANYTHING. The engine publishes one row per
     * registered server saying whether it answers (`QueueSnapshot.servers`);
     * empty is what a snapshot with no routing host carries, and it is the
     * state every pre-2026-09-18 test here was written against — no lane is
     * `down`, because nothing observed one to be.
     */
    servers: [],
    slotSets: slots.slotSets({
      rankedServers: servers.map((name) => ({ name, enabled: true })),
      // Not what these tests are about: `unknown` is what an engine nobody has
      // asked answers, and it draws the same bench they were written against.
      upstreams: Object.fromEntries(servers.map((n) => [n, 'unknown'])),
      // Nor are they about the orchestrator relation: every one of these is an
      // engine, which is what every pre-Phase-17 Crucible reads as.
      roles: Object.fromEntries(servers.map((n) => [n, 'engine'])),
      occupied,
      // Answered off these jobs with the scheduler's own function, exactly as
      // `currentSlotSets` answers it: the legacy row exists while something in
      // the queue can run nowhere else, and is absent otherwise.
      alignerCharged: slots.longformAlignCharged({ jobs }),
      serversOnThisMachine: [],
    }),
  };
}

const reasonOf = (snapshot, j, s) => bench.stillReason(snapshot, j, s);

// ── The order of the reasons ────────────────────────────────────────────────

test('a parent that has not finished outranks a busy card', () => {
  const narrate = step({ id: 's_n', status: 'running', label: 'Narrate' });
  const assemble = step({
    id: 's_a', status: 'waiting', label: 'Assemble', parentStepId: 's_n',
  });
  const j = job([narrate, assemble]);
  const r = reasonOf(snap([j]), j, assemble);
  assert.strictEqual(r.kind, 'waiting-parent');
  assert.strictEqual(r.sentence, 'Waiting for Narrate to finish.');
});

test('a paused queue outranks a full pool', () => {
  const running = step({ id: 's_r', status: 'running' });
  const queued = step({ id: 's_q', status: 'queued' });
  const j = job([running, queued]);
  const r = reasonOf(snap([j], false), j, queued);
  assert.strictEqual(r.kind, 'paused');
  assert.strictEqual(r.sentence, 'The queue is paused.');
});

test('a full pool outranks a stale admission hold, and names what is holding it', () => {
  const running = step({ id: 's_r', status: 'running', type: 'tts-conversion' });
  const queued = step({
    id: 's_q',
    status: 'queued',
    progress: { admissionHold: 'Waiting for the GPU: llama-training is using it.' },
  });
  const j = job([running, queued]);
  const r = reasonOf(snap([j]), j, queued);
  assert.strictEqual(r.kind, 'no-slot');
  // OWEN'S SECOND PARKED SENTENCE, pinned by its words
  // (docs/PENDING-QUEUE-AND-GPU-DIAL.md): "The server is occupied: 'Waiting for
  // the 3090 Ti to become free.' The dial matches, the card is working, and the
  // fix is time." It must not read like the dial sentence (which would send a
  // person to turn a knob at an idle card) and must not read like the disabled
  // one (which would send them to a switch).
  assert.match(r.sentence, /to become free/);
  assert.match(r.sentence, /Narrating Flashpoint of Revival/);
  assert.ok(!/the queue is set to/.test(r.sentence),
    'occupied is not the dial pointing elsewhere — three causes, three sentences');
  assert.ok(!/disabled/.test(r.sentence),
    'occupied is not disabled either');
  assert.ok(!/llama-training/.test(r.sentence), 'the stale hold must not be read out');
});

test('with a slot free, the admission hold is the reason, verbatim', () => {
  const hold = 'Waiting for the GPU: another job outside BookForge is using it — lora run.';
  const queued = step({ id: 's_q', status: 'queued', progress: { admissionHold: hold } });
  const j = job([queued]);
  const r = reasonOf(snap([j]), j, queued);
  assert.strictEqual(r.kind, 'admission');
  assert.strictEqual(r.sentence, hold);
});

test('released, parent done, slot free, nothing holding it: starting now', () => {
  const queued = step({ id: 's_q', status: 'queued' });
  const j = job([queued]);
  assert.strictEqual(reasonOf(snap([j]), j, queued).kind, 'ready');
});

test('both CPU slots busy is a full pool; one busy is not', () => {
  const a = step({ id: 's_a', status: 'running', resource: 'cpu' });
  const b = step({ id: 's_b', status: 'running', resource: 'cpu' });
  const waiting = step({ id: 's_c', status: 'queued', resource: 'cpu' });
  const full = job([a, b, waiting]);
  assert.strictEqual(reasonOf(snap([full]), full, waiting).kind, 'no-slot');

  const oneFree = job([a, waiting]);
  assert.strictEqual(reasonOf(snap([oneFree]), oneFree, waiting).kind, 'ready');
});

test('a GPU step is not blocked by a busy CPU pool', () => {
  const cpu1 = step({ id: 's_1', status: 'running', resource: 'cpu' });
  const cpu2 = step({ id: 's_2', status: 'running', resource: 'cpu' });
  const gpu = step({ id: 's_g', status: 'queued', resource: 'gpu' });
  const j = job([cpu1, cpu2, gpu]);
  assert.strictEqual(reasonOf(snap([j]), j, gpu).kind, 'ready');
});

// ── Held, and the two kinds of it ───────────────────────────────────────────

test('a held step that has never run says you have not started it', () => {
  const held = step({ id: 's_h', status: 'held' });
  const j = job([held]);
  const r = reasonOf(snap([j]), j, held);
  assert.strictEqual(r.kind, 'held');
  assert.match(r.sentence, /haven't started it/);
});

test('a held step behind another held step names the one in front', () => {
  const first = step({ id: 's_1', status: 'held', label: 'Narrate' });
  const second = step({ id: 's_2', status: 'held', label: 'Assemble', parentStepId: 's_1' });
  const j = job([first, second]);
  assert.strictEqual(reasonOf(snap([j]), j, second).sentence, 'Held — behind Narrate.');
});

test('a stopped step reports how far it got, and that the work is kept', () => {
  const stopped = step({
    id: 's_s', status: 'held', wasInterrupted: true, progress: { percent: 41.4 },
  });
  const j = job([stopped]);
  const r = reasonOf(snap([j]), j, stopped);
  assert.strictEqual(r.kind, 'stopped');
  assert.strictEqual(r.sentence, 'Stopped at 41% — it picks up where it left off.');
});

test('a stopped step that measured nothing still says it is resumable', () => {
  const stopped = step({ id: 's_s', status: 'held', wasInterrupted: true });
  const j = job([stopped]);
  assert.strictEqual(
    reasonOf(snap([j]), j, stopped).sentence,
    'Stopped — it picks up where it left off.');
});

// ── The refusals ────────────────────────────────────────────────────────────

test('asking why a RUNNING step is still is a bug, and it throws', () => {
  const running = step({ id: 's_r', status: 'running' });
  const j = job([running]);
  assert.throws(() => reasonOf(snap([j]), j, running), /is running/);
});

test('asking why a FINISHED step is still is a bug, and it throws', () => {
  for (const status of ['done', 'failed', 'cancelled']) {
    const finished = step({ id: `s_${status}`, status });
    const j = job([finished]);
    assert.throws(() => reasonOf(snap([j]), j, finished), /already finished/);
  }
});

test('a waiting step whose parent is not in the queue throws rather than guessing', () => {
  const orphan = step({ id: 's_o', status: 'waiting', parentStepId: 'step_gone' });
  const j = job([orphan]);
  assert.throws(() => reasonOf(snap([j]), j, orphan), /not in this queue/);
});

// ── The bench ───────────────────────────────────────────────────────────────

test('all three slots are drawn, whatever is running', () => {
  /*
   * The GPU lane here is the legacy spawn's, and since 2026-09-15 that row is
   * drawn only while something charges it — so this queues a GPU step that
   * cannot travel, which is the thing the row is FOR. It is queued, not running,
   * which is the point of the check: a free slot is information.
   */
  const lanes = bench.benchLanes(snap([job([step({ id: 's_q' })])]));
  assert.strictEqual(lanes.length, 3);
  assert.deepStrictEqual(lanes.map((l) => `${l.resource}${l.index}of${l.of}`),
    ['gpu1of1', 'cpu1of2', 'cpu2of2']);
  assert.ok(lanes.every((l) => l.occupant === null));
});

test('a running step occupies its pool\'s slot, named by what it is doing', () => {
  const running = step({
    id: 's_r', status: 'running', label: 'Narrate', progress: { percent: 62, detail: 'batch 3' },
  });
  const j = job([running]);
  const gpu = bench.benchLanes(snap([j]))[0];
  assert.strictEqual(gpu.occupant.verb, 'Narrating');
  assert.strictEqual(gpu.occupant.title, 'Flashpoint of Revival');
  assert.strictEqual(gpu.occupant.label, 'Narrate');
  assert.strictEqual(gpu.occupant.percent, 62);
  assert.strictEqual(gpu.occupant.detail, 'batch 3');
  assert.strictEqual(gpu.occupant.stepId, 's_r');
});

test('a step that has measured nothing reports null, not zero', () => {
  const running = step({ id: 's_r', status: 'running' });
  const lanes = bench.benchLanes(snap([job([running])]));
  assert.strictEqual(lanes[0].occupant.percent, null);
});

test('two CPU steps fill both CPU slots and leave the GPU free', () => {
  const a = step({ id: 's_a', status: 'running', resource: 'cpu', label: 'Read the pages' });
  const b = step({ id: 's_b', status: 'running', resource: 'cpu', label: 'Make the EPUB' });
  // …and a queued GPU row, so there is a GPU lane to leave free at all: the
  // legacy set is drawn only while something charges it.
  const g = step({ id: 's_g', label: 'Narrate' });
  const lanes = bench.benchLanes(snap([job([a, b, g])]));
  assert.strictEqual(lanes[0].occupant, null);
  assert.strictEqual(lanes[1].occupant.label, 'Read the pages');
  assert.strictEqual(lanes[2].occupant.label, 'Make the EPUB');
});

test('a hold shows on the free GPU slot, and never on a CPU slot', () => {
  const hold = 'Waiting for the GPU: llama-cleanup is using it.';
  const queued = step({ id: 's_q', status: 'queued', progress: { admissionHold: hold } });
  const lanes = bench.benchLanes(snap([job([queued])]));
  assert.strictEqual(lanes[0].hold, hold);
  assert.strictEqual(lanes[1].hold, null);
  assert.strictEqual(lanes[2].hold, null);
});

test('an occupied GPU slot carries no hold, so a busy card never reads as blocked', () => {
  const running = step({ id: 's_r', status: 'running' });
  const queued = step({
    id: 's_q', status: 'queued', progress: { admissionHold: 'stale' },
  });
  const lanes = bench.benchLanes(snap([job([running, queued])]));
  assert.strictEqual(lanes[0].occupant.stepId, 's_r');
  assert.strictEqual(lanes[0].hold, null);
});

test('the GPU lane carries the thermal reading; CPU lanes never do', () => {
  const running = step({ id: 's_r', status: 'running' });
  const s = snap([job([running])]);
  s.gpuThermal = { tempC: 86, fanPct: 96, throttleActive: true, at: '2026-08-19T22:40:00.000Z' };
  const lanes = bench.benchLanes(s);
  assert.strictEqual(lanes[0].thermal.tempC, 86);
  assert.strictEqual(lanes[0].thermal.throttleActive, true);
  assert.strictEqual(lanes[1].thermal, null);
  assert.strictEqual(lanes[2].thermal, null);
});

test("the reading lands on a LOCAL SERVER's row, not only on the aligner", () => {
  /*
   * The defect this closes, found 2026-09-15. `isThisMachine` tested
   * `setId === LONGFORM_ALIGN_SET` and ignored the snapshot it was handed, so
   * the nvidia-smi reading appeared on the long-form aligner's row — which is
   * usually empty — and NOT on the registered server that actually renders books
   * on this card. The WSL engine on this PC answers on loopback and is every bit
   * as local as the aligner.
   */
  const s = snap([job([step({ id: 's_r', status: 'running' })])]);
  s.gpuThermal = { tempC: 71, fanPct: 60, throttleActive: false, at: '2026-09-15T23:00:00.000Z' };
  // Two GPU rows: one here, one across the tailnet.
  s.slotSets = [
    { id: 'wsl', label: 'wsl', gpu: 1, cpu: 0, retiring: false, onThisMachine: true },
    { id: 'mac', label: 'mac', gpu: 1, cpu: 0, retiring: false, onThisMachine: false },
  ];
  const lanes = bench.benchLanes(s);
  const here = lanes.find((l) => l.setId === 'wsl');
  const there = lanes.find((l) => l.setId === 'mac');
  assert.ok(here && there, 'expected a lane for each set');
  assert.strictEqual(here.thermal.tempC, 71,
    "a local server renders on THIS card, so its row carries this card's temperature");
  assert.strictEqual(there.thermal, null,
    "the Mac's row must never show this PC's fan speed — a reading labelled as "
    + "somebody else's hardware is a number a person will act on");
});

// ── A machine that is not answering ─────────────────────────────────────────

/*
 * THE DEFECT, 2026-09-18. The bench drew a GPU lane per registered engine with
 * the operator's on/off switch above it and NO idea whether the machine behind
 * it was awake. A Mac that had gone to sleep looked exactly like a working
 * lane; its books sat in the queue and never started, and the reason — the
 * scheduler's own reach probe — was published nowhere.
 *
 * The three rules below are what keeps `down` an OBSERVATION. The dangerous one
 * is the second: folding "asleep" into "switched off" would disable hardware on
 * the operator's behalf, and it would stay disabled after the machine woke.
 */

/** Two engine rows, one lane each, drawn straight so the set flags are explicit. */
function twoEngines(over = {}) {
  const s = snap([]);
  s.slotSets = [
    { id: 'wsl', label: 'wsl', gpu: 1, cpu: 0, retiring: false, disabled: false, onThisMachine: true },
    { id: 'mac', label: 'mac', gpu: 1, cpu: 0, retiring: false, disabled: false, onThisMachine: false },
  ];
  Object.assign(s, over);
  return s;
}

const gpuLane = (s, setId) => bench.benchLanes(s).find((l) => l.setId === setId && l.resource === 'gpu');

test("an unreachable server's GPU lane carries the reason it is down", () => {
  const s = twoEngines({
    servers: [
      { name: 'wsl', enabled: true, reach: 'ready', detail: null },
      { name: 'mac', enabled: true, reach: 'unreachable', detail: 'nothing answered at http://mac:7100.' },
    ],
  });
  assert.strictEqual(gpuLane(s, 'mac').down, 'nothing answered at http://mac:7100.',
    "the transport's own sentence, so the lane can say WHY without a second question");
  assert.strictEqual(gpuLane(s, 'wsl').down, null,
    'and a machine that answered is not down — the fact is per server, not per bench');
});

test('a DISABLED server is never down — nobody asked it, and `off` is the fact', () => {
  /*
   * The operator switched it off, so the queue does not ping it; a "down" on
   * that lane would be a claim nothing measured. It already says `off`, which
   * is both true and the only one of the two the operator can act on.
   */
  const s = twoEngines({
    servers: [
      { name: 'wsl', enabled: true, reach: 'ready', detail: null },
      { name: 'mac', enabled: false, reach: 'unreachable', detail: 'nothing answered at http://mac:7100.' },
    ],
  });
  s.slotSets = s.slotSets.map((set) => (set.id === 'mac' ? { ...set, disabled: true } : set));
  assert.strictEqual(gpuLane(s, 'mac').down, null,
    'disabled wins: the lane is already greyed, and for a reason the operator chose');
});

test('a ready server, and one nobody has asked yet, are both null', () => {
  const s = twoEngines({
    servers: [
      { name: 'wsl', enabled: true, reach: 'ready', detail: null },
      { name: 'mac', enabled: true, reach: 'unknown', detail: null },
    ],
  });
  assert.strictEqual(gpuLane(s, 'wsl').down, null);
  assert.strictEqual(gpuLane(s, 'mac').down, null,
    '`unknown` is "nobody has asked", which is not evidence the machine is down');
});

test("BookForge's own lanes have no machine to be down, and no `servers` row to match", () => {
  /*
   * `local-work` is this app's CPU pair and `local-longform-align` its own
   * aligner — the same two `switchOf` refuses a switch to. A `servers` row could
   * never carry those names, but the rule is asserted rather than assumed: a
   * future set id that collided would grey out a lane with no machine behind it.
   */
  const s = snap([]);
  s.slotSets = [
    { id: slots.LOCAL_WORK_SET, label: 'CPU slots', gpu: 0, cpu: 2, retiring: false, disabled: false, onThisMachine: true },
    { id: slots.LONGFORM_ALIGN_SET, label: 'aligner', gpu: 1, cpu: 0, retiring: false, disabled: false, onThisMachine: true },
  ];
  s.servers = [
    { name: slots.LOCAL_WORK_SET, enabled: true, reach: 'unreachable', detail: 'impossible, but assert it' },
    { name: slots.LONGFORM_ALIGN_SET, enabled: true, reach: 'unreachable', detail: 'impossible, but assert it' },
  ];
  assert.ok(bench.benchLanes(s).every((l) => l.down === null),
    'neither of BookForge\'s own lanes can be "down" — there is no machine to be');
});

test('a CPU lane of a down server is not greyed — the reach is about its card row', () => {
  // The lane that cannot run is the GPU one. A server's CPU pool row exists for
  // work that is not on the card, and `switchOf` draws no switch over it either.
  const s = snap([]);
  s.slotSets = [
    { id: 'mac', label: 'mac', gpu: 1, cpu: 2, retiring: false, disabled: false, onThisMachine: false },
  ];
  s.servers = [{ name: 'mac', enabled: true, reach: 'unreachable', detail: 'nothing answered.' }];
  const lanes = bench.benchLanes(s).filter((l) => l.setId === 'mac');
  assert.strictEqual(lanes.find((l) => l.resource === 'gpu').down, 'nothing answered.');
  assert.ok(lanes.filter((l) => l.resource === 'cpu').every((l) => l.down === null));
});

test('no reading means no thermal on any lane — absent, not zero', () => {
  const lanes = bench.benchLanes(snap([]));
  assert.ok(lanes.every((l) => l.thermal === null));
});

// ── The bands ───────────────────────────────────────────────────────────────

test('needsYou lists failed steps with the engine\'s own words', () => {
  const failed = step({ id: 's_f', status: 'failed', label: 'Assemble', error: 'ffmpeg refused the concat list.' });
  const rows = bench.needsYou(snap([job([failed], { id: 'job_x' })]));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].error, 'ffmpeg refused the concat list.');
  assert.strictEqual(rows[0].label, 'Assemble');
  assert.strictEqual(rows[0].jobId, 'job_x');
});

test('a stopped run is NOT in needsYou', () => {
  const stopped = step({ id: 's_s', status: 'held', wasInterrupted: true });
  assert.strictEqual(bench.needsYou(snap([job([stopped])])).length, 0);
});

test('a step cancelled BECAUSE an earlier one failed is not itself reported', () => {
  const failed = step({ id: 's_f', status: 'failed', label: 'Narrate', error: 'the voice is missing' });
  const cancelled = step({ id: 's_c', status: 'cancelled', label: 'Assemble', parentStepId: 's_f' });
  const rows = bench.needsYou(snap([job([failed, cancelled])]));
  assert.deepStrictEqual(rows.map((r) => r.label), ['Narrate']);
});

test('upNext excludes what is running and what has finished', () => {
  const running = step({ id: 's_r', status: 'running' });
  const done = step({ id: 's_d', status: 'done' });
  const queued = step({ id: 's_q', status: 'queued', label: 'Assemble', parentStepId: 's_r' });
  const rows = bench.upNext(snap([job([running, done, queued])]));
  assert.deepStrictEqual(rows.map((r) => r.stepId), ['s_q']);
  assert.strictEqual(rows[0].reason.kind, 'no-slot');
});

test('only held rows are startable — a queued one is already released', () => {
  const held = step({ id: 's_h', status: 'held' });
  const queued = step({ id: 's_q', status: 'queued', resource: 'cpu' });
  const rows = bench.upNext(snap([job([held, queued])]));
  const by = Object.fromEntries(rows.map((r) => [r.stepId, r.startable]));
  assert.strictEqual(by['s_h'], true);
  assert.strictEqual(by['s_q'], false);
});

test('bookPlans groups runs that are about the same project', () => {
  const one = job([step({ id: 's_1', status: 'queued' })],
    { id: 'job_1', projectId: 'Z:/books/flashpoint', title: 'Flashpoint of Revival' });
  const two = job([step({ id: 's_2', status: 'held', resource: 'cpu' })],
    { id: 'job_2', projectId: 'Z:/books/flashpoint', title: 'Flashpoint of Revival' });
  const plans = bench.bookPlans(snap([one, two]));
  assert.strictEqual(plans.length, 1);
  assert.deepStrictEqual(plans[0].jobIds, ['job_1', 'job_2']);
  assert.deepStrictEqual(plans[0].steps.map((s) => s.stepId), ['s_1', 's_2']);
});

test('runs about no project are never grouped together', () => {
  const one = job([step({ id: 's_1', status: 'queued' })], { id: 'job_1', title: 'A' });
  const two = job([step({ id: 's_2', status: 'queued' })], { id: 'job_2', title: 'B' });
  assert.strictEqual(bench.bookPlans(snap([one, two])).length, 2);
});

test('a running step is in the plan as a marker, carrying no reason', () => {
  const running = step({ id: 's_r', status: 'running' });
  const plans = bench.bookPlans(snap([job([running])]));
  assert.strictEqual(plans[0].steps[0].reason, null);
  assert.strictEqual(plans[0].steps[0].status, 'running');
});

test('allHeld is true only when nothing in the group is released', () => {
  const held = job([step({ id: 's_1', status: 'held' })], { id: 'j1', projectId: 'p' });
  assert.strictEqual(bench.bookPlans(snap([held]))[0].allHeld, true);

  const mixed = job([step({ id: 's_2', status: 'queued' })], { id: 'j2', projectId: 'p' });
  assert.strictEqual(bench.bookPlans(snap([held, mixed]))[0].allHeld, false);
});

test('a finished run is not a plan, and leaves no empty card behind', () => {
  const done = job([step({ id: 's_d', status: 'done' })], { id: 'j', projectId: 'p' });
  assert.deepStrictEqual(bench.bookPlans(snap([done])), []);
});

test('finishedSince takes what landed after the boundary, newest first', () => {
  const early = step({
    id: 's_e', status: 'done', label: 'Narrate', finishedAt: '2026-08-19T09:00:00.000Z',
  });
  const late = step({
    id: 's_l', status: 'done', label: 'Assemble', finishedAt: '2026-08-19T13:00:00.000Z',
  });
  const yesterday = step({
    id: 's_y', status: 'done', label: 'Read', finishedAt: '2026-08-18T23:00:00.000Z',
  });
  const rows = bench.finishedSince(
    snap([job([early, late, yesterday])]),
    new Date('2026-08-19T00:00:00.000Z').getTime());
  assert.deepStrictEqual(rows.map((r) => r.stepId), ['s_l', 's_e']);
});

test('a step still running is never history, whatever its timestamps say', () => {
  const running = step({
    id: 's_r', status: 'running', startedAt: '2026-08-19T09:00:00.000Z',
  });
  assert.deepStrictEqual(bench.finishedSince(snap([job([running])]), 0), []);
});

test('a failed run appears in history AND in needsYou — they answer different questions', () => {
  const failed = step({
    id: 's_f', status: 'failed', error: 'boom', finishedAt: '2026-08-19T13:00:00.000Z',
  });
  const s = snap([job([failed])]);
  assert.strictEqual(bench.finishedSince(s, 0).length, 1);
  assert.strictEqual(bench.needsYou(s).length, 1);
});


// ── The bench grid ──────────────────────────────────────────────────────────
// Owen, 2026-09-15, by example: 1 across, then 2, then 3, "if there are four,
// drop the third and fourth down to a second row and split it in half. if there
// are five, row 1 gets 3, row 2 gets 2. if 6, row 1 gets 3, row 2 gets 3, etc."
// Four is the case that rules out filling rows of three greedily, which gives
// 3+1; his four is 2+2, so the rule is evenness, not greed.

test('the grid is the numbers Owen gave, and stays even past them', () => {
  const want = {
    1: [1], 2: [2], 3: [3],
    4: [2, 2], 5: [3, 2], 6: [3, 3],
    7: [3, 2, 2], 8: [3, 3, 2], 9: [3, 3, 3], 10: [3, 3, 2, 2],
  };
  for (const [count, rows] of Object.entries(want)) {
    assert.deepStrictEqual(bench.benchRowSizes(Number(count)), rows, `${count} lanes`);
  }
});

test('no row is ever wider than three, and the rows always total the count', () => {
  for (let n = 0; n <= 40; n += 1) {
    const rows = bench.benchRowSizes(n);
    assert.ok(rows.every((r) => r >= 1 && r <= bench.BENCH_ROW_MAX), `${n} has a bad row`);
    assert.strictEqual(rows.reduce((a, b) => a + b, 0), n, `${n} loses or invents a lane`);
    // Even: no row is more than one wider than any other, which is what stops
    // a lonely lane sitting under two full rows.
    if (rows.length > 0) {
      assert.ok(Math.max(...rows) - Math.min(...rows) <= 1, `${n} is lopsided: ${rows}`);
    }
  }
});

test('benchRows cuts the lanes into those rows, in order', () => {
  assert.deepStrictEqual(bench.benchRows(['a', 'b', 'c', 'd', 'e']), [['a', 'b', 'c'], ['d', 'e']]);
  assert.deepStrictEqual(bench.benchRows([]), []);
});

test('a lane count that is not one is refused rather than drawn', () => {
  assert.throws(() => bench.benchRowSizes(-1), /not a lane count/);
  assert.throws(() => bench.benchRowSizes(2.5), /not a lane count/);
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
  console.log(`\nqueue-bench: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});

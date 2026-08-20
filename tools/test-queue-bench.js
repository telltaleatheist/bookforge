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

/** A snapshot. `running` defaults TRUE — a paused queue is its own test. */
function snap(jobs, running = true) {
  return { jobs, running };
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
  assert.match(r.sentence, /graphics card/);
  assert.match(r.sentence, /Narrating Flashpoint of Revival/);
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
  const lanes = bench.benchLanes(snap([]));
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
  const lanes = bench.benchLanes(snap([job([a, b])]));
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

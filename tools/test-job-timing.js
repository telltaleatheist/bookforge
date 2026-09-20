/**
 * Tests for how long a queued run — and each task inside it — has been working.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-job-timing.js
 *
 * Pure arithmetic (shared/queue/job-timing.ts), so the cases worth writing down are
 * the ones a real run makes hard to see: a finished task that must stop counting, a
 * task still queued that must count nothing, and the run total that has to be the sum
 * of both while the master row it is displayed on has timestamps of its own.
 *
 * THE HOLDING is Owen's report of 2026-08-10: twenty minutes of narration followed by
 * five of assembly read as five, because the field was showing the running TASK. The
 * run is 25m, the assembly step is 5m, and both readings have to be available at once.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'job-timing.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { taskElapsedSeconds, taskWorkingSeconds, runElapsedSeconds } = require(MODULE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

const T0 = 1_700_000_000_000;
const min = (n) => T0 + n * 60_000;

// ── one task ────────────────────────────────────────────────────────────────

test('a task that has not started has spent no time', () => {
  assert.strictEqual(taskElapsedSeconds({}, min(30)), 0);
  assert.strictEqual(taskElapsedSeconds({ startedAt: undefined }, min(30)), 0);
});

test('a running task counts up to now', () => {
  const task = { startedAt: new Date(min(0)) };
  assert.strictEqual(taskElapsedSeconds(task, min(20)), 20 * 60);
  assert.strictEqual(taskElapsedSeconds(task, min(21)), 21 * 60);
});

test('a finished task counts to its completion and stops', () => {
  const task = { startedAt: new Date(min(0)), completedAt: new Date(min(20)) };
  assert.strictEqual(taskElapsedSeconds(task, min(20)), 20 * 60);
  // An hour later it still reads twenty minutes — the row must not keep ticking.
  assert.strictEqual(taskElapsedSeconds(task, min(80)), 20 * 60);
});

test('a stopped or failed task stops too — completedAt is stamped on every terminal outcome', () => {
  const stopped = { startedAt: new Date(min(0)), completedAt: new Date(min(3)) };
  assert.strictEqual(taskElapsedSeconds(stopped, min(500)), 3 * 60);
});

test('ISO strings from the persisted queue read the same as Dates', () => {
  const asDates = { startedAt: new Date(min(0)), completedAt: new Date(min(20)) };
  const asStrings = {
    startedAt: new Date(min(0)).toISOString(),
    completedAt: new Date(min(20)).toISOString(),
  };
  assert.strictEqual(taskElapsedSeconds(asStrings, min(20)), taskElapsedSeconds(asDates, min(20)));
});

test('a clock that ran backwards reads zero, never a negative duration', () => {
  const task = { startedAt: new Date(min(20)), completedAt: new Date(min(19)) };
  assert.strictEqual(taskElapsedSeconds(task, min(20)), 0);
});

test('an unreadable timestamp throws instead of reading as the epoch', () => {
  assert.throws(
    () => taskElapsedSeconds({ startedAt: 'yesterday afternoon' }, min(1)),
    /startedAt is present but unreadable/,
  );
  assert.throws(
    () => taskElapsedSeconds({ startedAt: new Date(min(0)), completedAt: 'soon' }, min(1)),
    /completedAt is present but unreadable/,
  );
});

// ── the run ─────────────────────────────────────────────────────────────────

test('a run with no tasks has spent no time', () => {
  assert.strictEqual(runElapsedSeconds([], min(30)), 0);
});

test('a standalone job is a run of one, and reads as itself', () => {
  const job = { startedAt: new Date(min(0)) };
  assert.strictEqual(runElapsedSeconds([job], min(12)), taskElapsedSeconds(job, min(12)));
});

test("Owen's case: 20m of narration plus 5m of assembly so far reads 25m", () => {
  const tts = { startedAt: new Date(min(0)), completedAt: new Date(min(20)) };
  const reassembly = { startedAt: new Date(min(20)) };
  assert.strictEqual(runElapsedSeconds([tts, reassembly], min(25)), 25 * 60);
  // …while the assembly step alone still says five, which is the other half of it.
  assert.strictEqual(taskElapsedSeconds(reassembly, min(25)), 5 * 60);
});

test('tasks still queued add nothing, so the run total is what has actually run', () => {
  const tts = { startedAt: new Date(min(0)) };
  const rvc = {};
  const reassembly = {};
  assert.strictEqual(runElapsedSeconds([tts, rvc, reassembly], min(8)), 8 * 60);
});

test('every task shows from the start, and the total grows as each one runs', () => {
  const steps = [
    { startedAt: new Date(min(0)), completedAt: new Date(min(20)) },
    { startedAt: new Date(min(20)), completedAt: new Date(min(28)) },
    { startedAt: new Date(min(28)) },
  ];
  assert.strictEqual(steps.length, 3);                      // three rows the whole way
  assert.strictEqual(runElapsedSeconds(steps, min(33)), 33 * 60);
});

test('time the queue sat idle between two steps is not time the job worked', () => {
  // Paused after narration, resumed an hour later: the run worked 25 minutes.
  const tts = { startedAt: new Date(min(0)), completedAt: new Date(min(20)) };
  const reassembly = { startedAt: new Date(min(80)), completedAt: new Date(min(85)) };
  assert.strictEqual(runElapsedSeconds([tts, reassembly], min(90)), 25 * 60);
});

test('the run total ignores the master row it is displayed on', () => {
  // The master's own stamps are a container's, and the panel never reads them.
  const master = { startedAt: new Date(min(0)) };
  const steps = [{ startedAt: new Date(min(5)), completedAt: new Date(min(9)) }];
  assert.strictEqual(runElapsedSeconds(steps, min(60)), 4 * 60);
  assert.notStrictEqual(runElapsedSeconds(steps, min(60)), taskElapsedSeconds(master, min(60)));
});

// ── a render that has settled stops counting ────────────────────────────────
//
// Owen, 2026-09-20, watching a finished render sit on an eight-minute file copy
// with the clock still running: *"it should zero out when it finishes
// rendering, not give the idea that its still rendering. for analytics
// purposes, we need it to show as finalized/'rendered' with an accurate time.
// if its doing a different action it should say its doing that."*

test('a row still running, whose render has settled, reads the RENDER time', () => {
  const row = { startedAt: new Date(min(0)), renderSettledAt: min(26) };
  assert.strictEqual(taskWorkingSeconds(row, min(26)), 26 * 60);
  // Eight minutes of publishing later it still reads twenty-six.
  assert.strictEqual(taskWorkingSeconds(row, min(34)), 26 * 60);
});

test('and it keeps reading the render time after the step completes', () => {
  const row = {
    startedAt: new Date(min(0)),
    renderSettledAt: min(26),
    completedAt: new Date(min(34)),
  };
  assert.strictEqual(taskWorkingSeconds(row, min(90)), 26 * 60,
    'the publish is a different act; charging its minutes to the render is what '
    + 'made every rate in the analytics wrong');
  assert.strictEqual(taskElapsedSeconds(row, min(90)), 34 * 60,
    'the whole-step reading is still there for whoever wants it');
});

test('a row that never rendered is timed the ordinary way', () => {
  const row = { startedAt: new Date(min(0)) };
  assert.strictEqual(taskWorkingSeconds(row, min(12)), 12 * 60);
  assert.strictEqual(taskWorkingSeconds({}, min(12)), 0);
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`job-timing: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);

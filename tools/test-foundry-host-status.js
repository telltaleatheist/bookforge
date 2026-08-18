#!/usr/bin/env node
/**
 * Tests for electron/foundry-host-status.ts — the one line BookForge draws in
 * the hosted Foundry's chrome.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-host-status.js
 *
 * ── Why this is testable at all ─────────────────────────────────────────────
 *
 * Because `hostStatusOf` is a PURE FUNCTION of a queue snapshot: it imports
 * nothing from Electron, nothing from the engine's mutable state and nothing
 * from Foundry's subtree. Every decision the chip makes is therefore reachable
 * from a hand-built object rather than by running two applications with a
 * nine-hour narration in flight — which is the only other way to see most of
 * these states.
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - AN IDLE QUEUE PUSHES NULL. That is what takes the chip out of somebody
 *    else's chrome; a status object holding "nothing" would leave it sitting
 *    there forever, which is litter in another application's window.
 *  - THE WORDS ARE THE TRAY'S. "Narrating <book>" is composed from the same
 *    table the title-bar chip composes it from, so two windows of one app cannot
 *    describe one run differently.
 *  - AN OMITTED FIELD IS AN ANSWER. No percentage means the step has measured
 *    none — Foundry draws no bar rather than a bar at nothing — and no `pending`
 *    means nothing waits, which is not a badge reading zero.
 *  - A RUNNING SECOND JOB IS NOT PENDING. The pools admit three steps at once,
 *    and counting work that is happening as work that is waiting is the one
 *    arithmetic error this readout can make.
 *  - A RUN WITH NO BOOK TITLE THROWS. Every run here is about a book; a headline
 *    reading "Narrating " is a bug wearing the shape of a readout.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-host-status.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const status = require(path.join(DIST, 'foundry-host-status.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A step, with only what the summariser reads. */
function step(over = {}) {
  return {
    id: 'step_x1',
    type: 'tts-conversion',
    label: 'Narrate',
    config: {},
    parentStepId: 'source',
    resource: 'gpu',
    status: 'queued',
    progress: {},
    metrics: {},
    addedAt: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

function job(steps, over = {}) {
  return {
    id: 'job_a1',
    title: 'Twain',
    steps,
    createdAt: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

const snap = (jobs) => ({ jobs, running: true });

// ── The empty chrome ────────────────────────────────────────────────────────

test('an empty queue says nothing at all', () => {
  assert.strictEqual(status.hostStatusOf(snap([])), null);
});

test('a queue holding only ended runs says nothing at all', () => {
  const ended = snap([
    job([step({ status: 'done' })], { id: 'job_done' }),
    job([step({ status: 'failed' })], { id: 'job_failed' }),
    job([step({ status: 'cancelled' })], { id: 'job_cancelled' }),
  ]);
  assert.strictEqual(status.hostStatusOf(ended), null);
});

// ── The running line ────────────────────────────────────────────────────────

test('a running step is named with the tray\'s own verb and the book', () => {
  const live = snap([job([step({ status: 'running', progress: { percent: 42 } })])]);
  const shown = status.hostStatusOf(live);
  assert.strictEqual(shown.headline, 'Narrating Twain');
  assert.strictEqual(shown.percent, 42);
});

test('each kind of work says its own verb', () => {
  const assembling = snap([job([
    step({ id: 'a', type: 'reassembly', label: 'Assemble', status: 'running' }),
  ])]);
  assert.strictEqual(status.hostStatusOf(assembling).headline, 'Assembling Twain');
  const enhancing = snap([job([
    step({ id: 'e', type: 'rvc-enhancement', label: 'Enhance', status: 'running' }),
  ])]);
  assert.strictEqual(status.hostStatusOf(enhancing).headline, 'Enhancing Twain');
});

test('a percentage nobody measured is omitted, not drawn at nothing', () => {
  const live = snap([job([step({ status: 'running' })])]);
  const shown = status.hostStatusOf(live);
  assert.ok(!('percent' in shown), 'percent should be absent when the step reported none');
  // And a fractional one is rounded, exactly as the title-bar chip rounds it.
  const measured = snap([job([step({ status: 'running', progress: { percent: 41.6 } })])]);
  assert.strictEqual(status.hostStatusOf(measured).percent, 42);
});

// ── The second line ─────────────────────────────────────────────────────────

test('a one-step run adds no second line, because the label is the verb', () => {
  const live = snap([job([step({ status: 'running' })])]);
  assert.ok(!('detail' in status.hostStatusOf(live)));
});

test('a run of several steps says which of them is under way', () => {
  const live = snap([job([
    step({ id: 's1', status: 'done' }),
    step({ id: 's2', type: 'rvc-enhancement', label: 'Enhance', status: 'running' }),
    step({ id: 's3', type: 'reassembly', label: 'Assemble', status: 'waiting' }),
  ])]);
  const shown = status.hostStatusOf(live);
  assert.strictEqual(shown.headline, 'Enhancing Twain');
  assert.strictEqual(shown.detail, 'Enhance · step 2 of 3');
});

// ── The count behind it ─────────────────────────────────────────────────────

test('nothing waiting means no badge at all', () => {
  const live = snap([job([step({ status: 'running' })])]);
  assert.ok(!('pending' in status.hostStatusOf(live)));
});

test('runs waiting behind the one running are counted', () => {
  const live = snap([
    job([step({ status: 'running' })], { id: 'job_running' }),
    job([step({ status: 'queued' })], { id: 'job_queued' }),
    job([step({ status: 'held' })], { id: 'job_held' }),
    job([step({ status: 'done' })], { id: 'job_done' }),
  ]);
  const shown = status.hostStatusOf(live);
  assert.strictEqual(shown.headline, 'Narrating Twain');
  assert.strictEqual(shown.pending, 2);
});

test('a SECOND running job is happening, not waiting', () => {
  const live = snap([
    job([step({ status: 'running' })], { id: 'job_one' }),
    job([step({ id: 'cpu', resource: 'cpu', status: 'running' })], { id: 'job_two' }),
  ]);
  assert.strictEqual(status.hostStatusOf(live).pending, undefined);
});

// ── Nothing running ─────────────────────────────────────────────────────────

test('runs waiting with none in flight say so, and count themselves', () => {
  const waiting = snap([
    job([step({ status: 'held' })], { id: 'job_one' }),
    job([step({ status: 'queued' })], { id: 'job_two' }),
  ]);
  const shown = status.hostStatusOf(waiting);
  assert.strictEqual(shown.headline, '2 runs waiting');
  assert.strictEqual(shown.pending, 2);
  assert.ok(!('percent' in shown), 'nothing is running, so nothing has a percentage');
  assert.ok(!('detail' in shown));
});

test('one waiting run is one run, not one runs', () => {
  const waiting = snap([job([step({ status: 'held' })])]);
  assert.strictEqual(status.hostStatusOf(waiting).headline, '1 run waiting');
});

// ── The refusal ─────────────────────────────────────────────────────────────

test('a run with no book title is a bug, and it is said rather than drawn', () => {
  const untitled = snap([job([step({ status: 'running' })], { id: 'job_blank', title: '   ' })]);
  assert.throws(
    () => status.hostStatusOf(untitled),
    (err) => err.message.includes('job_blank') && /no title/.test(err.message));
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
  console.log(`\nfoundry-host-status: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});

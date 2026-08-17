#!/usr/bin/env node
/**
 * Tests for electron/foundry-host-nodes.ts — the rows BookForge contributes to
 * the hosted Foundry's provenance tree.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-host-nodes.js
 *
 * ── Why this is testable at all ─────────────────────────────────────────────
 *
 * Because the mapping is a PURE FUNCTION of a queue snapshot. `hostNodeSets`
 * imports nothing from Electron, nothing from the engine's mutable state and
 * nothing from Foundry's subtree, so every decision it makes — which steps
 * become rows, what each row says, where a row goes when its step is cancelled,
 * and whether there is an honest ETA to show — is reachable from a hand-built
 * object. That property is worth as much as any assertion below: the alternative
 * is a mapping that can only be checked by running two applications.
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - THE ID ROUND TRIP. The node id IS the (job, step) pair; it is what comes
 *    back on an invoke, and it is the whole of how chaining onto work that has
 *    not run yet is expressed without a registry to keep in sync. A ledger step
 *    id must never decode to one of ours.
 *  - NO LINEAGE, NO ROWS. A narration started from the versions page belongs on
 *    nobody's tree, and the gate is the absence of one field.
 *  - A CANCELLED STEP LEAVES. Whole-set semantics make removal free, and the
 *    thing that must not happen is litter left in another app's window. A
 *    FAILURE is the deliberate exception — it is news the user has not seen.
 *  - THE EMPTY PUSH. A project whose last job is cleared has to be pushed once
 *    more, holding nothing; without it the rows would sit there until Foundry
 *    restarted.
 *  - AN ETA IS MEASURED OR IT IS NOT CLAIMED. The rate window is what stops a
 *    batched engine's first burst being reported as a speed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-host-nodes.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const nodes = require(path.join(DIST, 'foundry-host-nodes.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROJECT = 'E:\\Bookforge\\foundry\\projects\\Twain-a1b2';
const LEDGER_STEP = 'step-7f3a';

/** A step, with only what the mapping reads. */
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
    addedAt: '2026-08-17T00:00:00.000Z',
    ...over,
  };
}

function job(steps, over = {}) {
  return {
    id: 'job_a1',
    title: 'Twain',
    steps,
    createdAt: '2026-08-17T00:00:00.000Z',
    foundry: { projectDir: PROJECT, parentStepId: LEDGER_STEP },
    ...over,
  };
}

const snap = (jobs) => ({ running: true, jobs });

// ── The id scheme ───────────────────────────────────────────────────────────

test('a node id carries the job and step, and gives them back', () => {
  const id = nodes.encodeNodeId('job_a1', 'step_b2');
  assert.deepStrictEqual(nodes.decodeNodeId(id), { jobId: 'job_a1', stepId: 'step_b2' });
});

test('a ledger step id is not one of ours, and says so rather than half-parsing', () => {
  // What Foundry's own ids look like, and what a hand-typed one looks like.
  assert.strictEqual(nodes.decodeNodeId('step-7f3a'), null);
  assert.strictEqual(nodes.decodeNodeId('bf-node:only-one-part'), null);
  assert.strictEqual(nodes.decodeNodeId('other:job_a1:step_b2'), null);
  assert.strictEqual(nodes.decodeNodeId('bf-node::step_b2'), null);
});

test('an id with a colon in it is refused when it is minted, not when it is read', () => {
  assert.throws(() => nodes.encodeNodeId('job:a1', 'step_b2'), /cannot be put in a host node id/);
});

// ── What becomes a row ──────────────────────────────────────────────────────

test('a run with no foundry lineage is on nobody\'s tree', () => {
  const sets = nodes.hostNodeSets(snap([job([step()], { foundry: undefined })]));
  assert.strictEqual(sets.size, 0);
});

test('one row per audio step, hung on the ledger step the press came from', () => {
  const sets = nodes.hostNodeSets(snap([job([
    step({ id: 's1', type: 'tts-conversion', label: 'Narrate', status: 'done' }),
    step({ id: 's2', type: 'rvc-enhancement', label: 'Enhance', status: 'queued' }),
    step({ id: 's3', type: 'reassembly', label: 'Assemble', status: 'waiting', parentStepId: 's2' }),
  ])]));
  const rows = sets.get(PROJECT);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map((r) => r.kind), ['narrate', 'enhance', 'assemble']);
  assert.ok(rows.every((r) => r.parentStepId === LEDGER_STEP),
    'every row hangs on the ledger step, not on the row above it');
  assert.deepStrictEqual(rows.map((r) => r.state), ['done', 'queued', 'queued']);
});

test('work that is not audio work is never mirrored back onto the tree', () => {
  // A pass or a conversion is Foundry's own act and has a ledger step of its own.
  const sets = nodes.hostNodeSets(snap([job([
    step({ id: 's1', type: 'vlm-convert', label: 'Convert to EPUB' }),
    step({ id: 's2', type: 'translate-pass', label: 'Translate' }),
  ])]));
  assert.deepStrictEqual(sets.get(PROJECT), []);
});

test('a cancelled step draws nothing; a failed one stays, with its reason', () => {
  const sets = nodes.hostNodeSets(snap([job([
    step({ id: 's1', status: 'cancelled' }),
    step({
      id: 's2', type: 'reassembly', label: 'Assemble', status: 'failed',
      error: 'ffmpeg could not read chapter 12.',
    }),
  ])]));
  const rows = sets.get(PROJECT);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].state, 'failed');
  assert.strictEqual(rows[0].detail, 'ffmpeg could not read chapter 12.');
});

// ── The words ───────────────────────────────────────────────────────────────

test('a narration is named by its voice, and says nothing when none is named', () => {
  const withVoice = nodes.hostNodeSets(snap([job([step({ config: { voice: 'leah' } })])]));
  assert.strictEqual(withVoice.get(PROJECT)[0].title, 'Narrate with leah');
  const without = nodes.hostNodeSets(snap([job([step()])]));
  assert.strictEqual(without.get(PROJECT)[0].title, 'Narrate');
});

test('held, waiting and queued are one word to Foundry and three sentences to us', () => {
  const sets = nodes.hostNodeSets(snap([job([
    step({ id: 's1', status: 'held' }),
    step({
      id: 's2', type: 'reassembly', label: 'Assemble', status: 'waiting', parentStepId: 's1',
    }),
  ])]));
  const rows = sets.get(PROJECT);
  assert.ok(rows.every((r) => r.state === 'queued'));
  assert.strictEqual(rows[0].detail, 'not started · press Start in BookForge');
  assert.strictEqual(rows[1].detail, 'starts when Narrate finishes');
});

test('a stopped step says it was stopped, not that it never started', () => {
  const sets = nodes.hostNodeSets(snap([job([step({ status: 'held', wasInterrupted: true })])]));
  assert.match(sets.get(PROJECT)[0].detail, /stopped part-way/);
});

test('a queued row says where it is in the line, per pool', () => {
  const other = job([step({ id: 'q1', status: 'queued' })], { id: 'job_first' });
  const mine = job([
    step({ id: 'q2', status: 'queued' }),
    step({ id: 'q3', type: 'reassembly', label: 'Assemble', status: 'queued' }),
  ]);
  const rows = nodes.hostNodeSets(snap([other, mine])).get(PROJECT);
  // Both jobs are the same project here, so the first job's row is 1st.
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].detail, 'queued · 1st in line');
  assert.strictEqual(rows[1].detail, 'queued · 2nd in line');
  assert.strictEqual(rows[2].detail, 'queued · 3rd in line');
});

test('a finished row names what it produced', () => {
  const sets = nodes.hostNodeSets(snap([job([step({
    status: 'done', outputPath: 'E:\\Books\\Twain\\output\\Roughing It.m4b',
  })])]));
  assert.strictEqual(sets.get(PROJECT)[0].detail, 'finished · Roughing It.m4b');
});

// ── Progress ────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;

test('nothing that is not running claims a bar', () => {
  const sets = nodes.hostNodeSets(snap([job([step({
    status: 'queued', progress: { percent: 40, message: 'sentence 4 of 10' },
  })])]), NOW);
  assert.strictEqual(sets.get(PROJECT)[0].progress, undefined);
});

test('a running step with nothing to say draws the state word instead of an empty meter', () => {
  const sets = nodes.hostNodeSets(snap([job([step({ status: 'running', progress: {} })])]), NOW);
  assert.strictEqual(sets.get(PROJECT)[0].progress, undefined);
});

test('a measured ETA is reported; an unmeasured one says so rather than guessing', () => {
  const running = (metrics) => nodes.hostNodeSets(snap([job([step({
    status: 'running',
    progress: { percent: 62, message: 'sentence 1,842 of 2,970' },
    metrics,
  })])]), NOW).get(PROJECT)[0].progress;

  // 100 chunks in 100 seconds, 100 to go ⇒ 100 s.
  const measured = running({
    firstChunkCompletedAt: NOW - 100_000,
    chunksAtFirstStamp: 0,
    chunksCompletedInJob: 100,
    totalChunksInJob: 200,
  });
  assert.deepStrictEqual(measured, {
    percent: 62,
    message: 'sentence 1,842 of 2,970',
    eta: '2 m left',
  });

  // The window is shorter than one batch cycle: a rate off it would be noise.
  const tooSoon = running({
    firstChunkCompletedAt: NOW - 10_000,
    chunksAtFirstStamp: 0,
    chunksCompletedInJob: 100,
    totalChunksInJob: 200,
  });
  assert.strictEqual(tooSoon.eta, 'estimating…');
  // No anchor at all — a resume that has not completed a chunk this session.
  assert.strictEqual(running({}).eta, 'estimating…');
});

// ── The push ────────────────────────────────────────────────────────────────

test('a project whose last run is cleared is pushed once more, holding nothing', () => {
  nodes.resetPushedProjects();
  const pushes = [];
  const push = (dir, list) => pushes.push({ dir, count: list.length });

  nodes.publishHostNodes(snap([job([step()])]), push);
  assert.deepStrictEqual(pushes, [{ dir: PROJECT, count: 1 }]);

  // The run was cleared. Nothing names the project any more, so the emptiness
  // has to be said out loud — an absent push is not a statement.
  nodes.publishHostNodes(snap([]), push);
  assert.deepStrictEqual(pushes[1], { dir: PROJECT, count: 0 });

  // And it is said ONCE. A project nobody has mentioned for a while must not be
  // pushed an empty list on every progress line.
  nodes.publishHostNodes(snap([]), push);
  assert.strictEqual(pushes.length, 2);
});

test('two projects are two sets, and neither sees the other\'s rows', () => {
  nodes.resetPushedProjects();
  const sets = nodes.hostNodeSets(snap([
    job([step()], { id: 'job_a' }),
    job([step({ type: 'reassembly', label: 'Assemble' })], {
      id: 'job_b',
      foundry: { projectDir: 'E:\\p\\Other-9z', parentStepId: 'step-0001' },
    }),
  ]));
  assert.strictEqual(sets.size, 2);
  assert.strictEqual(sets.get(PROJECT).length, 1);
  assert.strictEqual(sets.get('E:\\p\\Other-9z')[0].kind, 'assemble');
});

// ── Chaining ────────────────────────────────────────────────────────────────

test('a step that will never produce anything cannot be chained onto', () => {
  assert.strictEqual(nodes.isChainable(step({ status: 'running' })), true);
  assert.strictEqual(nodes.isChainable(step({ status: 'queued' })), true);
  assert.strictEqual(nodes.isChainable(step({ status: 'done' })), true);
  assert.strictEqual(nodes.isChainable(step({ status: 'failed' })), false);
  assert.strictEqual(nodes.isChainable(step({ status: 'cancelled' })), false);
});

// ── Retry and Dismiss ───────────────────────────────────────────────────────
//
// The pair Foundry draws on a failed card, which only exist because this host
// registered `onNodeAction`. What is worth defending here is the ASYMMETRY —
// retry targets the step, dismiss takes the whole run — and that both refusals
// are whole sentences naming the id, because they are said AT THE BUTTON in
// another application's window.

test('retry targets the STEP the card is, not the run it belongs to', () => {
  const live = snap([job([
    step({ id: 'step_narr', type: 'tts-conversion', status: 'done' }),
    step({ id: 'step_asm', type: 'reassembly', status: 'failed', parentStepId: 'step_narr' }),
  ])]);
  const plan = nodes.planNodeAction(
    nodes.encodeNodeId('job_a1', 'step_asm'), 'retry', live);
  // The engine resets this step and everything downstream of it and leaves the
  // narration alone — which is what stops a failed assembly re-reading the book.
  assert.deepStrictEqual(plan, { call: 'retry', stepId: 'step_asm' });
});

test('dismiss takes the RUN, because a queue has no way to forget one step', () => {
  const live = snap([job([step({ id: 'step_asm', status: 'failed' })])]);
  const plan = nodes.planNodeAction(
    nodes.encodeNodeId('job_a1', 'step_asm'), 'dismiss', live);
  assert.deepStrictEqual(plan, { call: 'remove', jobId: 'job_a1' });
});

test('an id that is not ours is refused by name, in both verbs', () => {
  const live = snap([job([step()])]);
  // A LEDGER step id — what a press on one of Foundry's own rows would carry.
  assert.throws(
    () => nodes.planNodeAction(LEDGER_STEP, 'retry', live),
    (err) => err.message.includes(LEDGER_STEP) && /cannot retry/.test(err.message));
  assert.throws(
    () => nodes.planNodeAction('bf-node:only-one-part', 'dismiss', live),
    (err) => err.message.includes('bf-node:only-one-part') && /cannot dismiss/.test(err.message));
});

test('a row the queue has moved on from names the run and the step it looked for', () => {
  const live = snap([job([step({ id: 'step_here' })])]);
  assert.throws(
    () => nodes.planNodeAction(
      nodes.encodeNodeId('job_gone', 'step_gone'), 'retry', live),
    (err) => err.message.includes('job_gone') && err.message.includes('step_gone'));
  // The run is right and the step is not: still a refusal, because the card is
  // about a step and half a match is not the row somebody pressed.
  assert.throws(
    () => nodes.planNodeAction(
      nodes.encodeNodeId('job_a1', 'step_gone'), 'dismiss', live),
    (err) => err.message.includes('step_gone'));
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
  console.log(`\nfoundry-host-nodes: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});

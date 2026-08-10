#!/usr/bin/env node
/**
 * Tests for the two pure decisions behind the picker's recovery from a failed
 * save — shared/document/autosave-retry.ts and shared/document/session-notices.ts.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-picker-session-state.js
 *
 * RD-C5, 2026-08-10: the autosave effect is EDGE-triggered on
 * `hasUnsavedChanges`, so a write that failed left the flag true, the effect
 * never fired again, and the window silently stopped autosaving for the rest of
 * the session. The fix re-arms from the failure itself, which is only safe if
 * the ladder terminates — an unwritable project must end in a sentence, not in
 * a permanent retry loop — and if the sentence can actually be shown, which is
 * what the notice QUEUE is for: the banner is one slot, and it already had a
 * layout-migration notice in it half the time.
 *
 * What is asserted here is the decision and only the decision. Whether the timer
 * is armed, and whether the window is allowed to write at all (an erase in
 * flight, a book on screen, a session that declined to load the project's
 * edits), belongs to the component and to `saveProjectToPath`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RETRY = path.join(REPO, 'dist', 'shared', 'document', 'autosave-retry.js');
const NOTICES = path.join(REPO, 'dist', 'shared', 'document', 'session-notices.js');
for (const mod of [RETRY, NOTICES]) {
  if (!fs.existsSync(mod)) {
    console.error(`Build first: npx tsc -p tsconfig.electron.json (missing ${mod})`);
    process.exit(1);
  }
}

const { autosaveRetryDelay, MAX_AUTOSAVE_RETRIES } = require(RETRY);
const { queueSessionNotice, dropFrontNotice, frontNotice } = require(NOTICES);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ── The retry ladder ───────────────────────────────────────────────────────

test('the first retry waits longer than the debounce, so it is a retry and not a spin', () => {
  const delay = autosaveRetryDelay(1, 1000);
  assert.ok(delay !== null, 'the first failure must be retried');
  assert.ok(delay > 1000, `expected more than the 1000ms debounce, got ${delay}`);
});

test('each rung waits longer than the one before it', () => {
  let previous = 0;
  for (let attempt = 1; attempt <= MAX_AUTOSAVE_RETRIES; attempt++) {
    const delay = autosaveRetryDelay(attempt, 1000);
    assert.ok(delay !== null, `attempt ${attempt} must still be retried`);
    assert.ok(delay > previous, `attempt ${attempt}: ${delay} is not longer than ${previous}`);
    previous = delay;
  }
});

test('the ladder ENDS — an unwritable project stops being hammered', () => {
  assert.strictEqual(autosaveRetryDelay(MAX_AUTOSAVE_RETRIES + 1, 1000), null);
  assert.strictEqual(autosaveRetryDelay(MAX_AUTOSAVE_RETRIES + 50, 1000), null);
});

test('the whole ladder is minutes, not hours — the user is still in the session', () => {
  let total = 0;
  for (let attempt = 1; attempt <= MAX_AUTOSAVE_RETRIES; attempt++) {
    total += autosaveRetryDelay(attempt, 1000);
  }
  assert.ok(total < 45 * 60 * 1000, `the ladder spans ${Math.round(total / 60000)} minutes`);
});

test('a nonsense attempt number is an error, not a silent zero delay', () => {
  assert.throws(() => autosaveRetryDelay(0, 1000), /positive integer/);
  assert.throws(() => autosaveRetryDelay(-1, 1000), /positive integer/);
  assert.throws(() => autosaveRetryDelay(1.5, 1000), /positive integer/);
});

// ── The banner queue ───────────────────────────────────────────────────────

test('an empty queue says nothing', () => {
  assert.strictEqual(frontNotice([]), null);
});

test('a second notice does not delete the first', () => {
  const queue = queueSessionNotice(queueSessionNotice([], 'layout migrated'), 'save failed');
  assert.strictEqual(frontNotice(queue), 'layout migrated');
  assert.strictEqual(frontNotice(dropFrontNotice(queue)), 'save failed');
});

test('the same sentence twice is said once', () => {
  let queue = queueSessionNotice([], 'save failed');
  queue = queueSessionNotice(queue, 'save failed');
  queue = queueSessionNotice(queue, 'save failed');
  assert.deepStrictEqual(queue, ['save failed']);
});

test('dismissing the last notice leaves nothing to say', () => {
  const queue = queueSessionNotice([], 'save failed');
  assert.deepStrictEqual(dropFrontNotice(queue), []);
  assert.strictEqual(frontNotice(dropFrontNotice(queue)), null);
});

test('dismissing an empty queue is not an error', () => {
  assert.deepStrictEqual(dropFrontNotice([]), []);
});

test('the input queue is never mutated (signal updates must produce a new array)', () => {
  const original = ['first'];
  const next = queueSessionNotice(original, 'second');
  assert.deepStrictEqual(original, ['first']);
  assert.notStrictEqual(next, original);
});

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);

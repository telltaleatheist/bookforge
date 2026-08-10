#!/usr/bin/env node
/**
 * Tests for the pure decision behind the picker's recovery from a failed
 * save — shared/document/autosave-retry.ts.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-picker-session-state.js
 *
 * RD-C5, 2026-08-10: the autosave effect is EDGE-triggered on
 * `hasUnsavedChanges`, so a write that failed left the flag true, the effect
 * never fired again, and the window silently stopped autosaving for the rest of
 * the session. The fix re-arms from the failure itself, which is only safe if
 * the ladder terminates — an unwritable project must end in a sentence, not in
 * a permanent retry loop. (The banner queue the sentence lands on lives inline
 * in the picker — the stacked form with per-row dismissal won over the pure
 * front-only module this suite once covered.)
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
if (!fs.existsSync(RETRY)) {
  console.error(`Build first: npx tsc -p tsconfig.electron.json (missing ${RETRY})`);
  process.exit(1);
}

const { autosaveRetryDelay, MAX_AUTOSAVE_RETRIES } = require(RETRY);

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

console.log(`${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);

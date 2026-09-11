#!/usr/bin/env node
/**
 * Tests for electron/mlx-batch-progress.ts — the one thing that knows anything
 * about what is happening INSIDE an MLX decode.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-mlx-batch-progress.js
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - THE HEARTBEAT'S SHAPE IS AN AGREEMENT WITH A PYTHON FILE nothing here can
 *    typecheck. Every field after the token count is optional, because an older
 *    engine printed fewer of them and the prefix is byte-identical.
 *  - A MISSING BASIS IS ABSENT, NOT ZERO. A bar pinned at 0 reads as a stall.
 *  - `rowsRetiredInCall` IS A CHUNK COUNT THE BRIDGE ADDS TO A USER-VISIBLE
 *    TALLY (parallel-tts-bridge emitProgress, 2026-09-11). Over-carrying it
 *    counts the same chunks twice, so the carry only survives a PROVEN next
 *    sub-batch of the same call — same batchCount, batchNo exactly one higher —
 *    and a fresh call starts at 0. Both directions are asserted here because
 *    neither is visible from the call site.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MOD = path.join(REPO, 'dist', 'electron', 'mlx-batch-progress.js');
if (!fs.existsSync(MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { parseMlxHeartbeat, advanceBatch, toActiveBatchProgress } = require(MOD);

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** A heartbeat line in the engine's exact wording (orpheus/higgs mlx_backend). */
function line({ rows = 95, tokens = 1259, step, cap, done, batchNo, batchCount }) {
  let s = `[ORPHEUS] MLX batch generating: ${rows} rows, ~${tokens} tokens`;
  if (step !== undefined) s += cap !== undefined ? ` (step ${step}/${cap})` : ` (step ${step})`;
  if (done !== undefined) s += `, ${done}/${rows} rows done`;
  if (batchNo !== undefined) s += `, batch ${batchNo}/${batchCount}`;
  return s;
}

const beat = (o) => {
  const hb = parseMlxHeartbeat(line(o));
  assert.ok(hb, `line did not parse: ${line(o)}`);
  return hb;
};

// ── Parsing ─────────────────────────────────────────────────────────────────

test('the full modern heartbeat parses every field', () => {
  const hb = beat({ rows: 95, tokens: 1259, step: 1260, cap: 3400, done: 12, batchNo: 1, batchCount: 2 });
  assert.strictEqual(hb.rowsTotal, 95);
  assert.strictEqual(hb.maxTokens, 1259);
  assert.strictEqual(hb.step, 1260);
  assert.strictEqual(hb.tokenCap, 3400);
  assert.strictEqual(hb.rowsDone, 12);
  assert.strictEqual(hb.batchNo, 1);
  assert.strictEqual(hb.batchCount, 2);
});

test('the OLD token-only heartbeat still parses, with the later fields absent', () => {
  const hb = beat({ rows: 95, tokens: 1259, step: 1260 });
  assert.strictEqual(hb.rowsTotal, 95);
  assert.strictEqual(hb.rowsDone, undefined);
  assert.strictEqual(hb.batchNo, undefined);
});

test('a line that is not a heartbeat is null, not a zeroed object', () => {
  assert.strictEqual(parseMlxHeartbeat('[ORPHEUS] Converting sentence 812'), null);
});

// ── The fraction (the bar the Bookshelf queue view still draws) ─────────────

test('no row count and no token cap yields NO fraction, rather than zero', () => {
  const st = advanceBatch(undefined, beat({ step: 1260 }));
  assert.strictEqual(st.fraction, undefined);
});

test('the fraction never steps backwards within a batch', () => {
  let st = advanceBatch(undefined, beat({ step: 1200, cap: 3400, done: 0, batchNo: 1, batchCount: 1 }));
  const early = st.fraction;
  st = advanceBatch(st, beat({ step: 1300, cap: 3400, done: 1, batchNo: 1, batchCount: 1 }));
  assert.ok(st.fraction >= early, `${st.fraction} < ${early}`);
});

// ── rowsRetiredInCall: what the chunk count is folded from ──────────────────

test('within one batch, rowsRetiredInCall IS rowsDone', () => {
  let st = advanceBatch(undefined, beat({ step: 100, cap: 3400, done: 0, batchNo: 1, batchCount: 1 }));
  assert.strictEqual(st.rowsRetiredInCall, 0);
  st = advanceBatch(st, beat({ step: 900, cap: 3400, done: 12, batchNo: 1, batchCount: 1 }));
  assert.strictEqual(st.rowsRetiredInCall, 12);
  st = advanceBatch(st, beat({ step: 1800, cap: 3400, done: 60, batchNo: 1, batchCount: 1 }));
  assert.strictEqual(st.rowsRetiredInCall, 60);
});

test('sub-batch 2 of a 2-part call carries part 1\'s retired rows', () => {
  let st = advanceBatch(undefined, beat({ rows: 64, step: 900, cap: 3400, done: 40, batchNo: 1, batchCount: 2 }));
  st = advanceBatch(st, beat({ rows: 64, step: 1800, cap: 3400, done: 64, batchNo: 1, batchCount: 2 }));
  assert.strictEqual(st.rowsRetiredInCall, 64);
  // The next sub-batch restarts the engine's own `rows done` at 0 — the call's
  // total must NOT.
  st = advanceBatch(st, beat({ rows: 64, step: 90, cap: 3400, done: 0, batchNo: 2, batchCount: 2 }));
  assert.strictEqual(st.retiredBefore, 64);
  assert.strictEqual(st.rowsRetiredInCall, 64);
  st = advanceBatch(st, beat({ rows: 64, step: 900, cap: 3400, done: 9, batchNo: 2, batchCount: 2 }));
  assert.strictEqual(st.rowsRetiredInCall, 73);
});

test('a sub-batch whose predecessor never reported rows done carries its full width', () => {
  // The batch ENDED, so every row in it retired — crediting fewer would make the
  // count fall back when the next sub-batch opens.
  let st = advanceBatch(undefined, beat({ rows: 48, step: 900, cap: 3400, batchNo: 1, batchCount: 3 }));
  assert.strictEqual(st.rowsRetiredInCall, 0);
  st = advanceBatch(st, beat({ rows: 48, step: 80, cap: 3400, done: 0, batchNo: 2, batchCount: 3 }));
  assert.strictEqual(st.rowsRetiredInCall, 48);
});

test('a NEW engine call resets the carry to zero', () => {
  let st = advanceBatch(undefined, beat({ rows: 64, step: 1800, cap: 3400, done: 64, batchNo: 1, batchCount: 1 }));
  assert.strictEqual(st.rowsRetiredInCall, 64);
  // Same width, same cap, same "batch 1/1" — only the step reset says it is a new
  // call, and the carry must not survive it.
  st = advanceBatch(st, beat({ rows: 64, step: 60, cap: 3400, done: 0, batchNo: 1, batchCount: 1 }));
  assert.strictEqual(st.retiredBefore, 0);
  assert.strictEqual(st.rowsRetiredInCall, 0);
});

test('a batch count that does not match the previous call does NOT carry', () => {
  let st = advanceBatch(undefined, beat({ rows: 64, step: 1800, cap: 3400, done: 64, batchNo: 1, batchCount: 2 }));
  // "batch 2/3" is a different call's second batch, not this call's.
  st = advanceBatch(st, beat({ rows: 48, step: 90, cap: 3400, done: 3, batchNo: 2, batchCount: 3 }));
  assert.strictEqual(st.retiredBefore, 0);
  assert.strictEqual(st.rowsRetiredInCall, 3);
});

test('a jump of more than one sub-batch does NOT carry', () => {
  let st = advanceBatch(undefined, beat({ rows: 64, step: 1800, cap: 3400, done: 64, batchNo: 1, batchCount: 3 }));
  st = advanceBatch(st, beat({ rows: 64, step: 90, cap: 3400, done: 2, batchNo: 3, batchCount: 3 }));
  assert.strictEqual(st.retiredBefore, 0);
  assert.strictEqual(st.rowsRetiredInCall, 2);
});

test('a heartbeat with no rows-done clause carries nothing and folds nothing', () => {
  // The old token-only format: no row count anywhere, so the chunk count must
  // receive 0 — not a guess derived from the token depth.
  let st = advanceBatch(undefined, beat({ step: 1200 }));
  assert.strictEqual(st.rowsRetiredInCall, 0);
  assert.strictEqual(st.retiredBefore, 0);
  st = advanceBatch(st, beat({ step: 2400 }));
  assert.strictEqual(st.rowsRetiredInCall, 0);
  assert.strictEqual(st.retiredBefore, 0);
});

test('the published object carries rowsRetiredInCall and drops the bookkeeping', () => {
  let st = advanceBatch(undefined, beat({ rows: 64, step: 900, cap: 3400, done: 40, batchNo: 1, batchCount: 2 }));
  st = advanceBatch(st, beat({ rows: 64, step: 90, cap: 3400, done: 5, batchNo: 2, batchCount: 2 }));
  const pub = toActiveBatchProgress(st);
  assert.strictEqual(pub.rowsRetiredInCall, 45);
  assert.strictEqual(pub.key, undefined);
  assert.strictEqual(pub.lastStep, undefined);
  assert.strictEqual(pub.retiredBefore, undefined);
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
  console.log(`\nmlx-batch-progress: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});

/**
 * Tests for the conversion ETA — how fast the pages are being read, and how long
 * is left.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-vlm-eta.js
 *
 * Pure arithmetic (shared/vlm/eta.ts), so the cases that actually matter are the
 * ones a real run makes hardest to observe: a rate that changes halfway through,
 * a readout ticking between page completions, and a run whose page count is not
 * known yet.
 *
 * THE HOLDING is the point of most of this. A page takes seconds and the UI ticks
 * every second, so a measurement that divided a frozen page count by a growing
 * elapsed would slide downwards four ticks out of five and jump on the fifth.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'vlm', 'eta.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  sampleConversionRate,
  conversionEtaSeconds,
  formatEta,
  formatPageRate,
} = require(MODULE);

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

const T0 = 1_000_000;
const sec = (n) => T0 + n * 1000;

// ── nothing to say yet ──────────────────────────────────────────────────────

test('no completed page means no rate at all', () => {
  assert.strictEqual(sampleConversionRate(null, 0, 300, T0), null);
  assert.strictEqual(conversionEtaSeconds(null, T0), null);
  assert.strictEqual(formatEta(null), null);
  assert.strictEqual(formatPageRate(null), null);
});

test('the first completed page starts the clock and reports no ETA yet', () => {
  // Everything before this is loading the model — 56 s for vLLM in WSL, ~10 s
  // for MLX. Counting it would make the first estimate wrong by a minute.
  const s = sampleConversionRate(null, 1, 300, sec(56));
  assert.strictEqual(s.done, 1);
  assert.strictEqual(s.firstDoneAt, sec(56));
  assert.strictEqual(s.etaSeconds, null);
  assert.strictEqual(formatPageRate(s), null);
});

// ── measuring ───────────────────────────────────────────────────────────────

test('the model-load time is excluded from the rate', () => {
  // Page 1 lands at 56 s (after the load); pages 2-11 take 4.8 s each.
  let s = sampleConversionRate(null, 1, 300, sec(56));
  s = sampleConversionRate(s, 11, 300, sec(56 + 48));
  // 10 pages in 48 s = 12.5 pages/min. If the 56 s load were counted it would
  // read 5.8 pages/min and the ETA would be more than double.
  assert.ok(Math.abs(s.pagesPerMin - 12.5) < 0.01, `got ${s.pagesPerMin}`);
  assert.ok(Math.abs(s.etaSeconds - 289 * 4.8) < 0.5, `got ${s.etaSeconds}`);
});

test('a held sample does not move while the page count stands still', () => {
  let s = sampleConversionRate(null, 1, 300, sec(0));
  s = sampleConversionRate(s, 11, 300, sec(48));
  const held = s;
  // Four one-second ticks with no page landing.
  for (const t of [49, 50, 51, 52]) {
    s = sampleConversionRate(s, 11, 300, sec(t));
    assert.strictEqual(s, held, 'the sample was re-measured between completions');
    assert.strictEqual(s.pagesPerMin, held.pagesPerMin);
  }
});

test('the ETA counts DOWN between completions instead of standing still', () => {
  let s = sampleConversionRate(null, 1, 300, sec(0));
  s = sampleConversionRate(s, 11, 300, sec(48));
  const at48 = conversionEtaSeconds(s, sec(48));
  const at52 = conversionEtaSeconds(s, sec(52));
  assert.ok(Math.abs((at48 - at52) - 4) < 0.001, `${at48} -> ${at52} is not a 4 s countdown`);
});

test('the countdown floors at zero rather than going negative', () => {
  let s = sampleConversionRate(null, 1, 10, sec(0));
  s = sampleConversionRate(s, 9, 10, sec(8));
  // Far past the predicted finish: a page slower than predicted is normal.
  assert.strictEqual(conversionEtaSeconds(s, sec(600)), 0);
});

test('a rate that changes halfway through is followed, not averaged away', () => {
  // 100 pages fast (1 s each), then the GPU gets busy and pages take 4 s.
  let s = sampleConversionRate(null, 1, 200, sec(0));
  s = sampleConversionRate(s, 101, 200, sec(100));
  const fast = s.pagesPerMin;
  s = sampleConversionRate(s, 151, 200, sec(300));
  assert.ok(s.pagesPerMin < fast, 'the slowdown did not move the rate');
  // 150 pages in 300 s = 30 pages/min overall, which is what an anchored
  // measurement reports — it is a running average, and it is SUPPOSED to be:
  // a per-interval rate on a 4.8 s page would jitter with every page.
  assert.ok(Math.abs(s.pagesPerMin - 30) < 0.01, `got ${s.pagesPerMin}`);
});

test('an unknown page count gives a rate but no ETA', () => {
  // foundry states the total on its first progress line; until then a
  // percentage or a remaining time would be invented.
  let s = sampleConversionRate(null, 1, 0, sec(0));
  s = sampleConversionRate(s, 11, 0, sec(48));
  assert.ok(s.pagesPerMin > 0);
  assert.strictEqual(s.etaSeconds, null);
  assert.strictEqual(conversionEtaSeconds(s, sec(50)), null);
});

test('a restarted run re-anchors instead of inheriting the old rate', () => {
  let s = sampleConversionRate(null, 1, 300, sec(0));
  s = sampleConversionRate(s, 200, 300, sec(400));
  // A resumed run reports page 1 again. It must not be read as 199 pages lost.
  const fresh = sampleConversionRate(s, 1, 300, sec(900));
  assert.strictEqual(fresh.done, 1);
  assert.strictEqual(fresh.firstDoneAt, sec(900));
  assert.strictEqual(fresh.etaSeconds, null);
});

// ── the sentences a person reads ────────────────────────────────────────────

test('the ETA is at most two units, and rounds rather than truncates', () => {
  assert.strictEqual(formatEta(45), '45s');
  assert.strictEqual(formatEta(90), '1m 30s');
  assert.strictEqual(formatEta(3600), '1h 0m');
  assert.strictEqual(formatEta(8069), '2h 14m');
  assert.strictEqual(formatEta(0), '0s');
  // Not a thing to show anybody.
  assert.strictEqual(formatEta(-5), '0s');
  assert.strictEqual(formatEta(Infinity), null);
});

test('the rate is stated in the unit that reads naturally at that speed', () => {
  // vLLM on a 3090 Ti: 4.8 s a page.
  let s = sampleConversionRate(null, 1, 300, sec(0));
  s = sampleConversionRate(s, 11, 300, sec(48));
  assert.strictEqual(formatPageRate(s), '4.8s/page');

  // Faster than a page a second flips the unit rather than printing '0.5s/page'.
  let f = sampleConversionRate(null, 1, 300, sec(0));
  f = sampleConversionRate(f, 101, 300, sec(50));
  assert.match(formatPageRate(f), /pages\/min$/);

  // An M1 Ultra at 4-bit MLX: ~27 s a page.
  let m = sampleConversionRate(null, 1, 300, sec(0));
  m = sampleConversionRate(m, 11, 300, sec(270));
  assert.strictEqual(formatPageRate(m), '27.0s/page');
});

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(` FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}
console.log(`\n${passed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

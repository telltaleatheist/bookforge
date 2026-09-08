/**
 * The throughput window the queue's speed and ETA are measured over.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-rate-window.js
 *
 * Pure arithmetic (shared/queue/rate-window.ts), which is the point: the readouts
 * that used to do this inline could only be checked by watching a live job, and the
 * bug below survived months of watching because the number it printed was plausible.
 *
 * THE BUG (Owen, 2026-09-08). The window used to run [firstChunkCompletedAt, now]
 * and was then HELD until the chunk count changed. That assumes chunks land one at a
 * time on a steady cadence — Orpheus MLX. Higgs retires a batch of 32 rows at once
 * and then reads in silence for minutes, so the first window to clear the 45s minimum
 * closed in the middle of the FIRST burst and credited a whole batch to ~45 seconds:
 * 84 chunks/min, "63.3x realtime (8,918 words/min · 901 sent/min)", for work actually
 * running at 5.7 chunks/min and 4.4x realtime. The fix is to close the window at the
 * LAST LANDING instead of at `now`, so both ends are instants at which work was
 * observed to complete.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'queue', 'rate-window.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { RATE_WINDOW_MIN_SECONDS, landingSpanRate, throughputSample } = require(MODULE);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: expected ~${expected} (±${tol}), got ${actual}`);

const T = 1_788_909_942_243;   // the anchor of Owen's live Higgs job

/**
 * The live job, as the metrics file held it, parameterised by the landing being
 * reported. Ratios are the ones that run measured: 608.06 chars, 106.5 words and
 * 10.76 raw sentences per chunk.
 */
function higgs(chunksDone, lastLandingAt) {
  return {
    anchorAt: T,
    anchorChunks: 1,
    lastLandingAt,
    chunksDone,
    totalChunks: 1439,
    totalRawSentences: 14210,
    rawSentencesDone: Math.round(chunksDone * 10.76),
    rawWordsDone: Math.round(chunksDone * 106.5),
    rawCharsDone: Math.round(chunksDone * 608.06),
    audioSecondsPerChar: 0.0759,
    totalRawChars: 835430,
    charsDoneInJob: Math.round(chunksDone * 608.06),
    chunksCompletedInJob: chunksDone,
  };
}

// ── The burst engine ────────────────────────────────────────────────────────

test('a burst engine\'s FIRST batch reports nothing — it spans seconds, not minutes', () => {
  // 63 chunks land 40s after the anchor. The old window would have been 40s wide too,
  // but only because it ended at `now`; the honest span is the same 40s and it is
  // under the minimum, so there is no rate yet. The card says 'Calculating…'.
  assert.strictEqual(throughputSample(higgs(64, T + 40_000)), null);
});

test('the first honest number arrives with the SECOND batch, at the batch cadence', () => {
  const s = throughputSample(higgs(96, T + 340_000));
  assert.ok(s, 'a 5m40s span between landings is measurable');
  assert.strictEqual(s.chunksInWindow, 95);
  near(s.spanSeconds, 340, 0.001, 'span');
  near(s.chunksPerMin, 16.76, 0.01, 'chunks/min');       // 95 / 5.667 min
  near(s.wordsPerMin, 1785, 1, 'words/min');             // × 106.5 words per chunk
  near(s.sentencesPerMin, 180, 1, 'sentences/min');      // × 10.76 sentences per chunk
  near(s.charsPerMin, 10194, 5, 'chars/min');            // × 608.06 chars per chunk
  near(s.realtimeFactor, 12.9, 0.05, 'realtime factor'); // chars/min × 0.0759 s/char / 60
  // (835,430 - 58,374) chars left at 10,194 chars/min.
  near(s.etaSeconds, 4573, 5, 'eta seconds');
});

test('the burst that produced 63.3x realtime cannot be reported at that rate again', () => {
  // The regression itself: the same 64 landings, but with the window closed at the
  // last landing 11 minutes in rather than 45 seconds in.
  const honest = throughputSample(higgs(64, T + 663_000));
  assert.ok(honest);
  near(honest.chunksPerMin, 5.7, 0.05, 'chunks/min');
  near(honest.realtimeFactor, 4.4, 0.05, 'realtime factor');
  near(honest.wordsPerMin, 606, 2, 'words/min');

  // What the old [anchor, now] window said at the 45s mark, computed the old way, for
  // the size of the error: 63 chunks over 45 seconds.
  const old = 63 / (45 / 60);
  near(old, 84, 0.5, 'the old number');
  assert.ok(old / honest.chunksPerMin > 14, 'the old window overstated the rate ~15x');
});

// ── The steady engine (Orpheus MLX): nothing may change ─────────────────────

test('a steady engine measures exactly what it always did', () => {
  // One chunk per landing: the last landing is at most one chunk-time behind `now`,
  // so the landing span and the old elapsed-to-now agree.
  const landing = T + 60_000;
  const s = throughputSample({
    anchorAt: T, anchorChunks: 100, lastLandingAt: landing, chunksDone: 160,
    totalChunks: 2000, chunksCompletedInJob: 160,
  });
  const oldWay = (160 - 100) / ((landing - T) / 60000);
  assert.strictEqual(s.chunksPerMin, oldWay);
  assert.strictEqual(s.chunksPerMin, 60);
  // No per-chunk counts → chunk-priced ETA: 1,840 chunks at 60/min.
  assert.strictEqual(s.etaSeconds, 1840);
});

test('between landings the sample cannot move, because no input does', () => {
  const input = higgs(96, T + 340_000);
  assert.deepStrictEqual(throughputSample(input), throughputSample(input));
});

// ── The window's own rules ──────────────────────────────────────────────────

test('the minimum span is a floor, not a rounding', () => {
  const at = (span) => landingSpanRate({
    anchorAt: T, anchorChunks: 1, lastLandingAt: T + span * 1000, chunksDone: 40,
  });
  assert.strictEqual(at(RATE_WINDOW_MIN_SECONDS - 0.001), null);
  assert.ok(at(RATE_WINDOW_MIN_SECONDS), 'exactly the minimum is measurable');
});

test('nothing completed since the anchor is not a rate of zero', () => {
  assert.strictEqual(landingSpanRate({
    anchorAt: T, anchorChunks: 64, lastLandingAt: T + 600_000, chunksDone: 64,
  }), null);
});

test('a job with no landing stamp has no window — never a rate to now', () => {
  assert.strictEqual(landingSpanRate({
    anchorAt: T, anchorChunks: 1, chunksDone: 64,
  }), null);
  assert.strictEqual(landingSpanRate({
    anchorChunks: 1, lastLandingAt: T + 600_000, chunksDone: 64,
  }), null);
  // An anchor with no count came from a build that didn't record one: batched
  // progress makes (chunksDone - 1) a fiction, so there is nothing honest to say.
  assert.strictEqual(landingSpanRate({
    anchorAt: T, lastLandingAt: T + 600_000, chunksDone: 64,
  }), null);
});

test('a 1:1 engine reports no sentences/min — it would duplicate chunks/min', () => {
  const s = throughputSample({
    anchorAt: T, anchorChunks: 0, lastLandingAt: T + 120_000, chunksDone: 100,
    totalChunks: 1000, totalRawSentences: 1000, rawSentencesDone: 100,
  });
  assert.strictEqual(s.sentencesPerMin, null);
  assert.strictEqual(s.wordsPerMin, null);
  assert.strictEqual(s.realtimeFactor, null);
});

let passed = 0, failed = 0;
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
console.log(`rate-window: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);

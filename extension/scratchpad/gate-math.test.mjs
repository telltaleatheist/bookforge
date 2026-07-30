/**
 * Exercises the adaptive start gate's pure math (offscreen.ts::startThresholdSeconds)
 * against the delivery shapes it actually sees. Run: node scratchpad/gate-math.test.mjs
 *
 * The function is copied here rather than imported — offscreen.ts is a bundled
 * extension module with chrome.* at the top level. Keep the two in step.
 */

const START_MIN_SECONDS = 12;
const SAFETY_MARGIN_SECONDS = 4;
const DEFAULT_SECONDS_PER_SENTENCE = 7.5;

function startThresholdSeconds(gen) {
  if (gen.arrivedSeconds <= 0) return Infinity;
  const perSentence = gen.arrivedSentences > 0
    ? gen.arrivedSeconds / gen.arrivedSentences
    : DEFAULT_SECONDS_PER_SENTENCE;
  const remainingAudio = Math.max(0, gen.remainingSentences) * perSentence;
  if (remainingAudio <= 0) return START_MIN_SECONDS;
  const rate = gen.steadyWallSeconds > 0 && gen.steadySeconds > 0
    ? gen.steadySeconds / gen.steadyWallSeconds
    : 0;
  if (rate <= 0) return Infinity;
  const deficit = remainingAudio * Math.max(0, 1 / rate - 1);
  const gapCover = gen.maxGapSeconds + SAFETY_MARGIN_SECONDS;
  return Math.max(START_MIN_SECONDS, deficit + SAFETY_MARGIN_SECONDS, gapCover);
}

/** The old math, for comparison: rate measured from the REQUEST. */
function oldThreshold(gen) {
  if (gen.arrivedSeconds <= 0 || gen.wallSeconds <= 0) return Infinity;
  const rate = gen.arrivedSeconds / gen.wallSeconds;
  if (rate <= 0) return Infinity;
  const perSentence = gen.arrivedSentences > 0
    ? gen.arrivedSeconds / gen.arrivedSentences
    : DEFAULT_SECONDS_PER_SENTENCE;
  const remainingAudio = Math.max(0, gen.remainingSentences) * perSentence;
  const deficit = remainingAudio * Math.max(0, 1 / rate - 1);
  return Math.max(START_MIN_SECONDS, deficit + SAFETY_MARGIN_SECONDS);
}

/**
 * Replay a delivery timeline and report when each gate opens.
 * arrivals: [{t, sentences}] cumulative sentence count at wall time t (seconds).
 */
function simulate(name, { totalSentences, secondsPerSentence, arrivals, coldStart = 0, genStart = 0 }) {
  let firstAt = null, firstSec = 0, lastAt = null, lastSec = 0, maxGap = 0;
  let openNew = null, openOld = null;
  for (const a of arrivals) {
    const seconds = a.sentences * secondsPerSentence;
    const quiet = a.t - (lastAt ?? genStart);
    if (quiet > maxGap) maxGap = quiet;
    if (firstAt === null) { firstAt = a.t; firstSec = seconds; }
    lastAt = a.t; lastSec = seconds;
    const remaining = totalSentences - a.sentences;

    if (openNew === null) {
      const th = startThresholdSeconds({
        arrivedSeconds: seconds,
        steadySeconds: seconds - firstSec,
        steadyWallSeconds: a.t - firstAt,
        maxGapSeconds: maxGap,
        arrivedSentences: a.sentences,
        remainingSentences: remaining
      });
      if (remaining === 0 || seconds >= th) openNew = a.t;
    }
    if (openOld === null) {
      const th = oldThreshold({
        arrivedSeconds: seconds,
        wallSeconds: a.t,
        arrivedSentences: a.sentences,
        remainingSentences: remaining
      });
      if (remaining === 0 || seconds >= th) openOld = a.t;
    }
  }
  const fmt = (v) => (v === null ? 'never' : `${v.toFixed(1)}s`);
  console.log(`${name}\n  old gate opens ${fmt(openOld)}   new gate opens ${fmt(openNew)}   (cold-start ${coldStart}s of that)`);
  return { openOld, openNew };
}

// ── Orpheus/MLX, warm engine. One 16-wide batch: silence, then rows retire in a
//    burst from ~70% of the batch depth (30s) to the end (40s).
const warmBurst = [];
for (let i = 1; i <= 16; i++) warmBurst.push({ t: 28 + i * 0.8, sentences: i });

simulate('MLX warm, short block (16 sentences = one batch)', {
  totalSentences: 16, secondsPerSentence: 7.5, arrivals: warmBurst
});

// A long block: batch 2 follows after another ~40s of silence.
const longBurst = [...warmBurst];
for (let i = 1; i <= 16; i++) longBurst.push({ t: 41 + 40 + i * 0.8, sentences: 16 + i });
simulate('MLX warm, long block (40 sentences = 3 batches)', {
  totalSentences: 40, secondsPerSentence: 7.5, arrivals: longBurst
});

// ── Cold engine: 45s of model load before the same batch. The client restarts the
//    clock when the server reports 'running' (the model is warm), so the gap the
//    gate has to cover is one BATCH, not the model load — that's genStart = 45.
const cold = warmBurst.map((a) => ({ ...a, t: a.t + 45 }));
const coldLong = longBurst.map((a) => ({ ...a, t: a.t + 45 }));
simulate('MLX cold (45s model load), short block', {
  totalSentences: 16, secondsPerSentence: 7.5, arrivals: cold, coldStart: 45, genStart: 45
});
simulate('MLX cold (45s model load), long block', {
  totalSentences: 40, secondsPerSentence: 7.5, arrivals: coldLong, coldStart: 45, genStart: 45
});

// ── XTTS: a genuinely below-realtime generator must still be held back.
const slow = [];
for (let i = 1; i <= 20; i++) slow.push({ t: i * 15, sentences: i }); // 7.5s audio per 15s wall = 0.5x
const r = simulate('Below-realtime generator (0.5x) — must NOT start early', {
  totalSentences: 20, secondsPerSentence: 7.5, arrivals: slow
});
const openedAt = r.openNew;
const bufferAtOpen = slow.find((a) => a.t === openedAt)?.sentences * 7.5;
const remainingAtOpen = 20 - slow.find((a) => a.t === openedAt).sentences;
console.log(`  buffer at open ${bufferAtOpen.toFixed(1)}s vs ${(remainingAtOpen * 7.5).toFixed(1)}s still to generate at 0.5x`
  + ` → ${bufferAtOpen >= remainingAtOpen * 7.5 ? 'covered ✓' : 'WOULD STALL ✗'}`);

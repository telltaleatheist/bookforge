/**
 * The throughput window every chunk-rate readout measures over.
 *
 * The window is [firstChunkCompletedAt, chunkCompletedAt] — ANCHOR LANDING to
 * LATEST LANDING — and never runs up to "now". Both ends are instants at which
 * work was observed to complete, so the span and the count it divides describe
 * the same interval.
 *
 * Why that matters (Owen, 2026-09-08): measuring to `now` assumes chunks land
 * one at a time on a steady cadence, which is true of Orpheus MLX and false of
 * Higgs, which retires a batch of 32 rows at once and then reads for minutes in
 * silence. A window ending at `now` first clears the 45s minimum in the middle
 * of the very first burst, so it credits a whole batch to ~45 seconds: a live
 * job measured 84 chunks/min (63.3x realtime, 8,918 words/min) while actually
 * running at 5.7 chunks/min. Holding that sample until the chunk count changed
 * then froze the wrong number on screen for minutes at a time.
 *
 * With both ends at landings the arithmetic is honest for both engine shapes:
 *   - Steady engine (one chunk per landing): the latest landing is at most one
 *     chunk-time behind `now`, so the number is the same as before.
 *   - Burst engine: the first burst spans seconds, fails the minimum, and shows
 *     nothing; the second burst opens a window a full batch cycle wide, which is
 *     the real cadence. The first rate therefore appears only after the SECOND
 *     batch lands — later than before, and true rather than 15x fast.
 */

/**
 * Minimum span, in seconds, before a chunk-rate window is reported at all.
 *
 * Batched engines emit progress in bursts, and consecutive bursts can land only
 * ~25s apart when two batches' emits coalesce — timing that single gap gives 143
 * chunks/min for a job actually running at ~70. A window shorter than roughly
 * one batch cycle cannot average out that quantization, so it is not shown. The
 * window only ever widens after that, so the estimate tightens as the job runs.
 */
export const RATE_WINDOW_MIN_SECONDS = 45;

/** The two landings and the counts at them — whatever the caller has of them. */
export interface LandingWindow {
  /** `firstChunkCompletedAt`: the first completion OF THIS RUN. */
  anchorAt?: number;
  /** `chunksAtFirstStamp`: the session chunk count at that instant. */
  anchorChunks?: number;
  /** `chunkCompletedAt`: the most recent completion. Closes the window. */
  lastLandingAt?: number;
  /** Session chunk count as of the most recent landing. */
  chunksDone?: number;
  /** Defaults to RATE_WINDOW_MIN_SECONDS. */
  minWindowSeconds?: number;
}

export interface LandingRate {
  /** Completions inside the window — never (chunksDone - 1). */
  chunksInWindow: number;
  /** Seconds between the two landings. */
  spanSeconds: number;
  chunksPerMin: number;
}

/**
 * Chunks per minute over the landing span, or null when there isn't yet an
 * honest window: no anchor, nothing completed since it, or a span too short to
 * average out one batch cycle.
 *
 * Between landings this is CONSTANT by construction — neither end moves — so
 * nothing needs to hold it to stop it sliding on the UI's one-second tick.
 */
export function landingSpanRate(w: LandingWindow): LandingRate | null {
  const { anchorAt, anchorChunks, lastLandingAt, chunksDone } = w;
  // Both ends or nothing. A job carrying only the timestamp came from a build
  // that didn't record the count — there is no honest rate to derive from it.
  if (anchorAt === undefined || anchorChunks === undefined) return null;
  if (lastLandingAt === undefined || chunksDone === undefined) return null;

  const chunksInWindow = chunksDone - anchorChunks;
  if (chunksInWindow <= 0) return null;          // still inside the anchoring batch

  const spanSeconds = (lastLandingAt - anchorAt) / 1000;
  const minSeconds = w.minWindowSeconds ?? RATE_WINDOW_MIN_SECONDS;
  if (spanSeconds < minSeconds) return null;

  return { chunksInWindow, spanSeconds, chunksPerMin: chunksInWindow / (spanSeconds / 60) };
}

/** Everything the readouts divide, as one measurement's worth of facts. */
export interface ThroughputInput extends LandingWindow {
  /** Chunks in the whole book — the sentences-per-chunk ratio's denominator guard. */
  totalChunks?: number;
  totalRawSentences?: number;
  rawSentencesDone?: number;
  rawWordsDone?: number;
  rawCharsDone?: number;
  /** Seconds of audio per character, sampled from this session's rendered FLACs. */
  audioSecondsPerChar?: number;
  /** Whole-book characters, and the characters done across the WHOLE job (null when
   *  earlier sessions banked work whose characters were never counted). */
  totalRawChars?: number;
  charsDoneInJob?: number | null;
  /** The chunk-priced ETA's fallback pair, used only when characters are unknown.
   *  `totalChunksForEta` exists because a job can know a chunk total for pricing
   *  (`totalChunks`) that is not the book-wide count the sentence ratio is gated on. */
  chunksCompletedInJob?: number;
  totalChunksForEta?: number;
}

export interface ThroughputSample extends LandingRate {
  sentencesPerMin: number | null;
  wordsPerMin: number | null;
  charsPerMin: number | null;
  realtimeFactor: number | null;
  /** Seconds remaining as of the latest landing. */
  etaSeconds: number;
}

/**
 * The whole readout — chunk rate and everything derived from it — or null when the
 * landing window isn't measurable yet.
 *
 * Every derived rate is the SAME chunk rate scaled by a ratio counted THIS session,
 * so speed, sentences, words, characters and the ETA can never disagree with each
 * other. Where a per-chunk count is absent the rate is null rather than estimated from
 * the book average: a missing exact count means the per-chunk accrual broke, and a
 * book-average stand-in would hide exactly that while looking like a measurement.
 */
export function throughputSample(input: ThroughputInput): ThroughputSample | null {
  const window = landingSpanRate(input);
  if (!window) return null;
  const chunksPerMin = window.chunksPerMin;
  const chunksDone = input.chunksDone as number;   // landingSpanRate proved it present

  // Absent for 1:1 engines (XTTS), where sentences/min would just duplicate chunks/min.
  const totalChunks = input.totalChunks || 0;
  const rawTotal = input.totalRawSentences || 0;
  const rawDone = input.rawSentencesDone;
  const sentencesPerMin =
    totalChunks > 0 && rawTotal > totalChunks && typeof rawDone === 'number' && rawDone > 0
      ? chunksPerMin * (rawDone / chunksDone)
      : null;

  const wordsDone = input.rawWordsDone;
  const charsDone = input.rawCharsDone;
  const wordsPerMin = typeof wordsDone === 'number' && wordsDone > 0
    ? chunksPerMin * (wordsDone / chunksDone)
    : null;
  const charsPerMin = typeof charsDone === 'number' && charsDone > 0
    ? chunksPerMin * (charsDone / chunksDone)
    : null;

  // Audio seconds produced per wall second — both factors measured on this run.
  const secondsPerChar = input.audioSecondsPerChar;
  const realtimeFactor = charsPerMin !== null && typeof secondsPerChar === 'number' && secondsPerChar > 0
    ? (charsPerMin * secondsPerChar) / 60
    : null;

  // Remaining uses the CUMULATIVE counts (a resume has work banked from earlier
  // sessions) while the rate came from this session only. Priced in CHARACTERS when
  // they are known: chunks are packed to a character budget, so a chunk-count ETA
  // charges full price for every short chunk at a chapter seam.
  const totalCharsForEta = input.totalRawChars || 0;
  const charsDoneForEta = input.charsDoneInJob;
  let etaSeconds = 0;
  if (charsPerMin !== null && charsPerMin > 0 && totalCharsForEta > 0
      && typeof charsDoneForEta === 'number') {
    etaSeconds = Math.round((Math.max(0, totalCharsForEta - charsDoneForEta) / charsPerMin) * 60);
  } else {
    const totalForEta = input.totalChunksForEta || totalChunks;
    const remainingChunks = Math.max(0, totalForEta - (input.chunksCompletedInJob || 0));
    etaSeconds = chunksPerMin > 0 && totalForEta > 0
      ? Math.round((remainingChunks / chunksPerMin) * 60)
      : 0;
  }

  return { ...window, sentencesPerMin, wordsPerMin, charsPerMin, realtimeFactor, etaSeconds };
}

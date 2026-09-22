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

/**
 * How close two landings have to be to be the SAME landing.
 *
 * ── The finding (Owen, 2026-09-20) ────────────────────────────────────────
 *
 * Two books started within two seconds of each other: *Shift* on the PC and
 * *Wool* on the Mac. Eleven minutes in, the PC was at 34% and the Mac at 7% —
 * nearly five times the work — while the two Rate readouts differed by only
 * 1.76x. *"seems like the speed doesnt quite add up here."*
 *
 * Measured off the two live sessions' own FLAC mtimes:
 *
 *   PC   61 landings of 4–12 chunks, ~3.8 s apart      → 58 chunks/min
 *   Mac   3 landings of ~60 chunks, 5 s wide, 200 s apart → 18.6 chunks/min
 *
 * A Higgs MLX batch retires ~62 rows at once, and the artifacts then arrive one
 * per chunk about a tenth of a second apart. The anchor recorded the count at
 * the FIRST of those — 1 — so the other 56, generated over the three minutes
 * BEFORE the window opened, were credited to the window as if they had cost
 * nothing. That is the same defect the landing window was built to fix, at the
 * other end of it: the fix of 2026-09-08 stopped the window closing mid-burst,
 * and this stops it OPENING mid-burst. The Mac read 25.8 chunks/min for work
 * running at 18.6 — 20.7x realtime for 11.6x, and an ETA a third short.
 *
 * The value has to sit above a burst's internal spacing and below the gap
 * between bursts. Both shapes above clear it by a wide margin: ~0.1 s and
 * ~0.7 s inside a burst, 3.8 s and 200 s between them.
 */
export const ANCHOR_BURST_GAP_MS = 2_000;

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

/**
 * HAS THIS STEP STARTED A NEW COUNTED SERIES?
 *
 * The anchor never re-opens once its burst has closed, and that rule is about
 * BURSTS WITHIN ONE SERIES: everything that landed together was generated
 * together, so a later batch must not throw away what has been measured since.
 * It says nothing about a step that starts COUNTING SOMETHING ELSE.
 *
 * A Crucible alignment does exactly that. It is two passes over one book — the
 * server places every word, then this machine measures the book from the items
 * it placed — and the second pass counts the SAME chunks from zero against the
 * same total. Measured 2026-09-21 on a 1,697-chunk book: 5.4 min on the card
 * (≈314 chunk/min), 2.3 min here (≈735 chunk/min). With one anchor across both,
 * the row divided the second pass's count by the elapsed since the FIRST pass's
 * first chunk and showed "75.9 chunks/min, ETA 16m 18s" at 460/1,697 — on a step
 * that finished 1.7 minutes later.
 *
 * So a report that NAMES a series different from the stored one drops the anchor
 * and the landing with it, and the new series anchors on its own first burst.
 *
 * A report that names NO series is every other step in the queue: it keeps
 * whatever is stored, which is how each of them has always behaved.
 */
export function rateSeriesChanged(
  stored: string | undefined, reported: string | undefined,
): boolean {
  if (reported === undefined) return false;
  return stored !== reported;
}

/** What the caller knows when a progress report arrives. */
export interface AnchorInput {
  /** The anchor already stamped for this run, if any. */
  readonly stampedAt?: number;
  /** The chunk count recorded at that stamp. */
  readonly anchorChunks?: number;
  /** The most recent landing BEFORE this report — never this one. */
  readonly lastLandingAt?: number;
  /** The session chunk count this report carries. */
  readonly chunksDone: number;
  /** The session chunk count the previous report carried. */
  readonly previousChunksDone?: number;
  /**
   * When the anchoring burst began — and, by its presence, that it is still
   * open. Absent means a gap has already been seen and the anchor is fixed.
   */
  readonly burstOpenSince?: number;
  /** When this report arrived. */
  readonly now: number;
  /** When the RUN started; an anchor older than this belongs to a previous one. */
  readonly runStartedAt?: number | null;
}

/** An anchor, or nothing when there is not yet anything to anchor to. */
export interface RateAnchor {
  firstChunkCompletedAt?: number;
  chunksAtFirstStamp?: number;
  /** See {@link AnchorInput.burstOpenSince}. Absent once the anchor is fixed. */
  anchorBurstOpenSince?: number;
}

/**
 * THE ANCHOR THE WINDOW OPENS AT: the END of the first burst of landings.
 *
 * Both halves are required, and each answers a different way of being wrong:
 *
 *  - The TIME, because measuring from the step's start folds in the model load
 *    and the planning — the Mac spent 4 m 53 s of an 11-minute step loading the
 *    voice before its first chunk landed, the PC 1 m 43 s.
 *  - The COUNT, because a batched engine's first observation is already deep
 *    into the book (a local Orpheus flush arrives 128 chunks in), and crediting
 *    those to an instant overstates the rate several-fold.
 *
 * And the anchor SLIDES while the landings keep arriving with no gap, which is
 * the half that was missing until 2026-09-20: over the Crucible seam a batch
 * arrives as one artifact per chunk, a tenth of a second apart, so recording
 * the count at the first of them recorded 1 when the batch was 57. It stops
 * sliding at the first real gap — {@link ANCHOR_BURST_GAP_MS} — and in any case
 * once the window is old enough to be measurable, so a steady engine whose
 * chunks land faster than the gap cannot slide it forever. The cost of the rule
 * is that the anchoring burst is never measured, which is correct: it was
 * generated before anyone was watching.
 *
 * Consequence, unchanged: no rate exists until a SECOND burst lands. One
 * observation cannot time anything.
 */
export function rateAnchor(input: AnchorInput): RateAnchor {
  const { stampedAt, anchorChunks, lastLandingAt, chunksDone, now } = input;
  const stampIsThisRun = stampedAt !== undefined
    && (input.runStartedAt === null || input.runStartedAt === undefined
      || stampedAt >= input.runStartedAt);

  if (!stampIsThisRun) {
    // No anchor, or one left by a previous run — a chunk cannot have completed
    // before the run that rendered it started. The burst opens here.
    return chunksDone > 0
      ? { firstChunkCompletedAt: now, chunksAtFirstStamp: chunksDone, anchorBurstOpenSince: now }
      : {};
  }

  const openSince = input.burstOpenSince;
  const kept: RateAnchor = {
    firstChunkCompletedAt: stampedAt,
    chunksAtFirstStamp: anchorChunks,
    ...(openSince === undefined ? {} : { anchorBurstOpenSince: openSince }),
  };
  // The burst is closed: the anchor is fixed for the rest of the run. A later
  // batch must never re-open the window — that would throw away everything
  // measured since and start the job's speed over from nothing.
  if (openSince === undefined) return kept;
  // A report that landed nothing times nothing: it can neither move the anchor
  // nor close the burst it is sitting in.
  if (input.previousChunksDone !== undefined && chunksDone <= input.previousChunksDone) return kept;

  const sinceLastLanding = now - (lastLandingAt ?? (stampedAt as number));
  const burstAge = now - openSince;
  if (sinceLastLanding < ANCHOR_BURST_GAP_MS && burstAge < RATE_WINDOW_MIN_SECONDS * 1000) {
    // Still the same burst: everything so far was generated before the window
    // opened, so the anchor moves to this landing and takes its count with it.
    return { firstChunkCompletedAt: now, chunksAtFirstStamp: chunksDone, anchorBurstOpenSince: openSince };
  }
  // A gap — or a "burst" so long it is really a stream. Either way the anchor
  // is now fixed: drop the marker.
  return { firstChunkCompletedAt: stampedAt, chunksAtFirstStamp: anchorChunks };
}

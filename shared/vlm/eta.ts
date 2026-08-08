/**
 * How fast the pages are being read, and how long is left.
 *
 * One measurement, shared by every readout. The modal and the queue row must
 * never state different numbers for the same run, so both take their speed and
 * their remaining time from {@link sampleConversionRate} rather than each doing
 * arithmetic on the progress line.
 *
 * ── The rule this exists to keep: measure on COMPLETIONS, hold between them ──
 *
 * A page takes seconds (4.8 on a 3090 Ti through vLLM, ~27 on an M1 Ultra at
 * 4-bit MLX), and the UI ticks every second. Dividing a frozen page count by a
 * growing elapsed on every tick makes the rate slide downwards and the ETA creep
 * UPWARDS between completions, then both jump when a page lands — a readout that
 * is visibly wrong four times out of five. So the rate is measured when `done`
 * INCREASES and held until it increases again, and the ETA counts down from that
 * sample. This is the same lesson `JobEtaService` records for TTS chunks; the
 * unit differs, the mistake does not.
 *
 * ── Why the first page is not counted ───────────────────────────────────────
 *
 * The clock starts at the FIRST COMPLETED PAGE, not when the run was asked for.
 * Before that comes loading the vision model — measured at 56 s for vLLM in WSL
 * including CUDA-graph capture, and about ten seconds for MLX — which is real
 * time the user waits but is not per-page work. Including it makes the estimate
 * of a 300-page book roughly a minute long in the wrong direction for the first
 * few pages and then slowly correct itself, which reads as an ETA that cannot
 * make up its mind. Held out, the first sample is honest the moment there are
 * two pages to compare.
 *
 * Everything here is PURE. It takes counts and timestamps and returns numbers,
 * so the arithmetic can be tested without a GPU, a server or a book — which is
 * the only way to test the case that actually matters, a rate that changes
 * halfway through.
 */

/** What a caller carries between progress lines. Opaque; start with `null`. */
export interface ConversionRateSample {
  /** Pages completed when this sample was measured. */
  done: number;
  /** When the FIRST page completed — the anchor everything is measured from. */
  firstDoneAt: number;
  /** When this sample was taken. */
  stampedAt: number;
  /** Pages per minute at the last completion. */
  pagesPerMin: number;
  /** Seconds remaining as of `stampedAt`, or null when the total is unknown. */
  etaSeconds: number | null;
}

/**
 * Fold one progress reading into the running measurement.
 *
 * Returns the previous sample UNCHANGED while `done` has not moved — that is the
 * holding, and it is why this returns the sample rather than a fresh reading.
 * `now` is passed in rather than read so the behaviour is testable.
 *
 * `total` of 0 means "not known yet": foundry states the page count on its first
 * progress line, and until then a percentage would be invented.
 */
export function sampleConversionRate(
  previous: ConversionRateSample | null,
  done: number,
  total: number,
  now: number
): ConversionRateSample | null {
  // Nothing has finished. There is no rate, and saying "calculating…" is the
  // honest readout — not a zero, which would render as an infinite ETA.
  if (done <= 0) return null;

  // The first completed page starts the clock; it cannot also be measured by it,
  // because the time before it includes loading the model.
  if (previous === null || done < previous.done) {
    return { done, firstDoneAt: now, stampedAt: now, pagesPerMin: 0, etaSeconds: null };
  }

  // Held: same page count, so the previous measurement still stands.
  if (done === previous.done) return previous;

  const elapsedSec = (now - previous.firstDoneAt) / 1000;
  const pagesSinceAnchor = done - 1;
  if (elapsedSec <= 0 || pagesSinceAnchor <= 0) {
    return { ...previous, done, stampedAt: now };
  }

  const pagesPerSec = pagesSinceAnchor / elapsedSec;
  const remaining = total > 0 ? Math.max(total - done, 0) : null;
  return {
    done,
    firstDoneAt: previous.firstDoneAt,
    stampedAt: now,
    pagesPerMin: pagesPerSec * 60,
    etaSeconds: remaining === null ? null : remaining / pagesPerSec,
  };
}

/**
 * Seconds left as of `now`, counting DOWN from the last sample.
 *
 * Between completions the estimate shrinks with the clock instead of standing
 * still, which is what makes it read as a countdown rather than a stale number.
 * It floors at zero rather than going negative: a page taking longer than
 * predicted is normal, and "-12s remaining" is not a thing to show anybody.
 */
export function conversionEtaSeconds(
  sample: ConversionRateSample | null,
  now: number
): number | null {
  if (sample === null || sample.etaSeconds === null) return null;
  return Math.max(sample.etaSeconds - (now - sample.stampedAt) / 1000, 0);
}

/**
 * `2h 14m`, `14m 30s`, `45s` — or null when there is nothing to say yet.
 *
 * Two units at most: a third is noise at every scale a book conversion reaches,
 * and "2h 14m 09s" invites reading precision that a rate measured over a few
 * pages does not have.
 */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const total = Math.max(Math.round(seconds), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** `4.8s/page`, or `12.5 pages/min` when a page takes under a second. */
export function formatPageRate(sample: ConversionRateSample | null): string | null {
  if (sample === null || sample.pagesPerMin <= 0) return null;
  const secondsPerPage = 60 / sample.pagesPerMin;
  return secondsPerPage >= 1
    ? `${secondsPerPage.toFixed(1)}s/page`
    : `${sample.pagesPerMin.toFixed(1)} pages/min`;
}

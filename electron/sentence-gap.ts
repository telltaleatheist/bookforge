/**
 * THE INTER-SENTENCE GAP PASS — one authority, because two passes can now be the
 * one that runs it.
 *
 * ── What the pass is ────────────────────────────────────────────────────────
 *
 * e2a leaves an artificial trailing pad on every rendered sentence, and this
 * strips it and re-applies a chosen amount of silence. It detects that pad by its
 * EXACTLY-zero samples, which means it can only ever run on the RAW cached
 * sentences: a roformer turns those zeros into dithered near-zeros and an RVC
 * pass re-synthesises them, and after either the pad is no longer findable. The
 * gap is therefore BAKED IN by whichever pass reads the raw sentences first, and
 * is part of that set's identity (see derived-sentences.ts).
 *
 * ── Why it left denoise-job.ts ──────────────────────────────────────────────
 *
 * It lived inside `planDenoisedSentences`, because the denoise was always the
 * first pass: a conversion that wanted a gap got it by denoising first. Owen's
 * ruling of 2026-08-29 made the ORDER the user's choice, so a conversion can now
 * be the first thing that touches the raw sentences — and then IT is the pass
 * that must bake the gap. Leaving the machinery inside the denoise would have
 * meant either an RVC-first run silently losing the gap (which is what the code
 * did before this split: the flag was threaded but no gap pass ever ran when
 * `finalDenoise` was off) or a second copy of the resolution rules in rvc-job.
 *
 * The rule this file states, once, for both callers: THE GAP IS APPLIED EXACTLY
 * ONCE, ON RAW SENTENCES, BY WHICHEVER PASS TOUCHES THEM FIRST.
 */

import * as fs from 'fs';

import { normalizeSentenceGaps } from './denoise-bridge';
import { resolveSessionSentenceGap } from './reassembly-bridge';
import { resolveOrpheusMinChunkGap } from './orpheus-models';

export interface SentenceGapPlan {
  /**
   * The gap to leave between sentences, in seconds — or UNDEFINED for "no gap
   * pass at all", which is a real answer and the ordinary one for a non-Orpheus
   * session: the pad this strips is one only Orpheus bakes.
   */
  readonly gapSeconds: number | undefined;
  /** The per-voice floor a chunk's own trailing silence may not fall below. */
  readonly minGapSeconds: number;
  /** The session's rendering voice, as its provenance recorded it. */
  readonly voice: string | null;
}

/**
 * The plan for a pass that does NOT read the raw sentences.
 *
 * A second pass in a chain never runs a gap pass — the first one already baked
 * it in, and the pad it would look for is gone. Stated as a value rather than as
 * an `if` at each call site, so "this pass applies no gap" is one thing said in
 * one way and lands in the manifest params identically both times.
 */
export const NO_SENTENCE_GAP: SentenceGapPlan = {
  gapSeconds: undefined,
  minGapSeconds: 0,
  voice: null,
};

/**
 * What gap this session's raw sentences should be normalized to.
 *
 * `explicit` is the number the user moved a control to. Absent leaves the
 * session's own provenance in charge — an Orpheus session normalizes to its
 * voice's tuned value, and a non-Orpheus session normalizes not at all.
 */
export async function planSentenceGap(
  processDir: string,
  explicit?: number,
): Promise<SentenceGapPlan> {
  // Assembly always runs `--tts_engine xtts`, so the Orpheus voice — and every
  // per-voice value keyed off it — can only come from the session's provenance.
  const provenance = await resolveSessionSentenceGap(processDir);
  const gapSeconds = typeof explicit === 'number'
    ? explicit
    : (provenance.isOrpheus ? provenance.gap : undefined);
  return {
    gapSeconds,
    minGapSeconds: resolveOrpheusMinChunkGap(provenance.voice) ?? 0,
    voice: provenance.voice ?? null,
  };
}

/**
 * The gap's contribution to a derived set's identity.
 *
 * `null` rather than absent for "no gap pass ran": it is an ANSWER, and it must
 * be distinguishable from a set derived before the field existed. Every set
 * derived from the raw sentences carries these, so moving the gap slider
 * re-derives whichever pass baked it — the denoise or the conversion.
 */
export function sentenceGapParams(plan: SentenceGapPlan): Record<string, unknown> {
  return {
    gapSeconds: plan.gapSeconds ?? null,
    minGapSeconds: plan.minGapSeconds,
  };
}

/**
 * Run the gap pass from `sourceDir` into `outDir`. CPU-only (soundfile/numpy
 * array work, no torch device) — the caller's GPU lease covers it, and it takes
 * no lease of its own.
 *
 * Refuses a plan with no gap in it rather than quietly copying the directory:
 * "should this run at all" is the caller's question and it is answered by
 * `gapSeconds === undefined`, so reaching here without one is a composition bug.
 */
export async function applySentenceGap(
  plan: SentenceGapPlan,
  sourceDir: string,
  outDir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  if (plan.gapSeconds === undefined) {
    throw new Error(
      'The sentence-gap pass was started for a session that normalizes no gap, so there is no '
      + 'value for it to apply. This is a bug in the job that called it.',
    );
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  await normalizeSentenceGaps({
    sentencesDir: sourceDir,
    outputDir: outDir,
    gapSeconds: plan.gapSeconds,
    minGapSeconds: plan.minGapSeconds,
    signal: opts.signal,
  });
}

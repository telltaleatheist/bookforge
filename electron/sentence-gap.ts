/**
 * THE INTER-SENTENCE GAP IN A DERIVED SET'S IDENTITY — and nothing that applies one any more.
 *
 * ── What the gap pass was ───────────────────────────────────────────────────
 *
 * Orpheus left an artificial trailing pad on every rendered sentence, and a gap pass
 * (`normalize_gaps.py`) stripped it by its exactly-zero samples and re-applied a chosen
 * silence. It had to run on the RAW sentences, so whichever of the denoise or the
 * conversion read them first baked it in, and the gap was part of that set's identity.
 *
 * ── Step 8 (2026-11-05): Orpheus is retired, and its gap pass went with it ──
 *
 * Owen: "orpheus is done, yes. deprecated". No other engine's sentences carry that pad,
 * and the app never offered the gap for a non-Orpheus session. So:
 *
 *  - A non-Orpheus session plans exactly what it always got: no gap pass, and the params
 *    `{gapSeconds: null, minGapSeconds: 0}` with no voice. Its derived sets keep their
 *    identity byte for byte (`tools/test-sentence-gap-identity.js`).
 *  - An Orpheus session is REFUSED by name. Its denoise or conversion depended on a pass
 *    that is not ported, and running it without one would be a quietly different output.
 *
 * The params stay in the shape they had, because they are part of the name every
 * existing derived set was filed under.
 */

import { sessionProvenance } from './reassembly-bridge';

export interface SentenceGapPlan {
  /** Always undefined now: no pass applies a gap. Kept for the identity's shape. */
  readonly gapSeconds: undefined;
  /** Always 0 now, for the same reason. */
  readonly minGapSeconds: 0;
  /** Always null now: only an Orpheus session ever recorded one here. */
  readonly voice: null;
}

/** The only plan there is. */
export const NO_SENTENCE_GAP: SentenceGapPlan = {
  gapSeconds: undefined,
  minGapSeconds: 0,
  voice: null,
};

/**
 * The plan for a pass that reads this session's raw sentences, or a refusal for an
 * Orpheus session (see the header).
 */
export async function planSentenceGap(processDir: string): Promise<SentenceGapPlan> {
  const provenance = await sessionProvenance(processDir);
  if (provenance?.ttsEngine?.toLowerCase() === 'orpheus') {
    throw new Error(
      'This session was rendered by Orpheus, which is retired. Its denoise or voice conversion '
      + 'depended on a sentence-gap pass that is not ported, so it is refused rather than run '
      + 'without it. Its finished audiobook is untouched.',
    );
  }
  return NO_SENTENCE_GAP;
}

/**
 * The gap's contribution to a derived set's identity: `null` rather than absent for "no gap
 * pass ran", as every set derived since the field existed records it.
 */
export function sentenceGapParams(plan: SentenceGapPlan): Record<string, unknown> {
  return {
    gapSeconds: plan.gapSeconds ?? null,
    minGapSeconds: plan.minGapSeconds,
  };
}

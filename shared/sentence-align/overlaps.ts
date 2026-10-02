/**
 * A SENTENCE ENDS BEFORE THE NEXT ONE BEGINS (training-pc, 2026-10-02).
 *
 * The Coming of the Third Reich, cue 1610: the aligner placed the sentence's first words right and stretched its
 * tail - "these or even higher numerical values ... that it would cause" - across the next nine seconds, past the
 * first words of the three sentences after it ("At its height", "Money lost", "Printing presses"), which were
 * placed in order and agree with the ASR. Most of those tail words were zero-length or stacked on one instant: the
 * signature of a forced alignment that lost its anchor (here on "(1,000,000,000,000,000,000)", six digit groups the
 * reader never said as printed). The edge stage takes placements in START order and never lets a cue begin before
 * the last one ended, so the one overshooting end pushed the next two cues to 0.05 s each, and the correction then
 * wrote their words into cue 1610 as the reader's.
 *
 * So a placement whose end runs past the start of the next placement is the one in the wrong, and its end comes
 * back to the last of its own words that ends by then. The words after that point are not dropped from anything -
 * they were never credibly placed - and the cue is flagged, so the repair is visible. A placement that has no word
 * ending before the next one starts is left as it is: there is nothing to trim it to, and the edge stage's own
 * collapse flag says so.
 */

import type { SentencePlacement } from './book-diff';

/** No sentence is read in less than this; a cue shorter is one whose audio went to a neighbour (training-pc, 2026-10-02). */
export const MIN_CUE_S = 0.15;

export interface OverlapRepair {
  /** The placements, in the order given, each ending no later than the next one starts where that was possible. */
  readonly placed: SentencePlacement[];
  /** Sentence indices whose end was brought back, with where it was and where it is now. */
  readonly trimmed: { readonly index: number; readonly from: number; readonly to: number }[];
}

/** `placed` must be sorted by start - the order the edge stage walks them in. */
export function trimOverlaps(placed: readonly SentencePlacement[]): OverlapRepair {
  const out = placed.slice();
  const trimmed: { index: number; from: number; to: number }[] = [];
  for (let i = 0; i + 1 < out.length; i++) {
    const p = out[i];
    const nextStart = out[i + 1].start;
    if (p.start === null || p.end === null || nextStart === null || p.end <= nextStart) continue;
    let to: number | null = null;
    for (const w of p.words) {
      if (w.end !== null && w.end <= nextStart && w.end > p.start && (to === null || w.end > to)) to = w.end;
    }
    if (to === null) continue;
    trimmed.push({ index: p.index, from: p.end, to });
    out[i] = { ...p, end: to };
  }
  return { placed: out, trimmed };
}

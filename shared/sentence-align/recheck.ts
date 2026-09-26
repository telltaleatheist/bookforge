/**
 * RE-HEAR A CORRECTED CUE ON ITS OWN AUDIO (2026-09-26).
 *
 * The book-length ASR pass dropped a sentence's opening words, and the correction then DELETED words the clip's audio
 * contains: The Coming of the Third Reich, cue 4302 - the book says "The pathetic decline of the former Democrats...",
 * the long pass heard "decline of the former Democrats...", so the cue became "Decline of the former Democrats...";
 * a 17 s clip of the same audio, transcribed alone, hears "The@7.28 pathetic@7.44 decline@7.84" inside the cue's
 * span, and Owen heard the reader say it. 327 of the book's 6,532 cues opened with such a deletion. Crucible's Qwen
 * ASR cuts long audio into 180 s pieces at the QUIETEST point near each boundary - the pause before a sentence - so a
 * sentence's first words sit at a piece's start, where they get dropped.
 *
 * So every cue the correction would change is transcribed again on its own audio before its correction is trusted.
 * The re-heard spans are sent in one job, but each carries PAD_S of its real neighbouring audio on both sides: joined
 * by silence alone, the splitter would cut on the silences and put every cue's first word back at a piece start.
 * Only the words inside the cue's own edges are used.
 */
import type { KeptPiece } from './silence-compact';
import { KEEP_GAP_S } from './silence-compact';

/** Real audio kept on each side of a re-heard cue, as lead-in and tail (never read, only heard through). */
export const RECHECK_PAD_S = 1.5;

/**
 * Pieces for the re-hearing audio: every span padded by `pad` (clamped to the recording), overlapping or touching
 * padded spans merged, laid end to end with `gap` seconds of silence between them.
 */
export function recheckPieces(spans: readonly { start: number; end: number }[], durationS: number,
  pad: number = RECHECK_PAD_S, gap: number = KEEP_GAP_S): KeptPiece[] {
  const padded = spans.filter((s) => s.end > s.start)
    .map((s) => ({ a: Math.max(0, s.start - pad), b: Math.min(durationS, s.end + pad) }))
    .filter((s) => s.b > s.a)
    .sort((x, y) => x.a - y.a);
  const merged: { a: number; b: number }[] = [];
  for (const s of padded) {
    const last = merged[merged.length - 1];
    if (last && s.a <= last.b) last.b = Math.max(last.b, s.b); else merged.push({ ...s });
  }
  const out: KeptPiece[] = []; let dst = 0;
  for (const m of merged) {
    out.push({ srcStart: m.a, srcEnd: m.b, dstStart: dst });
    dst += (m.b - m.a) + gap;
  }
  return out;
}

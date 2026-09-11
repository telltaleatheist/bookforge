/**
 * IS THE AUDIOBOOK AND ITS OWN TRANSCRIPT THE SAME LENGTH? — the verdict, pure.
 *
 * An assembled m4b and the sentence VTT sealed into it as its subtitle track are
 * two measurements of ONE book, and they have to agree. Two ways they do not:
 *
 *  - THE TRANSCRIPT ENDS AFTER THE AUDIO ('transcript-long'). A truncated export:
 *    ffmpeg can lose its parent mid-encode and still finalize a valid,
 *    moov-carrying, short m4b (Nuremberg, 2026-08-11: 14.72 h of a 20.12 h book,
 *    promoted by hand because everything about the file looked done).
 *  - THE TRANSCRIPT ENDS BEFORE THE AUDIO ('transcript-short'). The two were
 *    measured on DIFFERENT RULERS. The cause we have actually shipped is the
 *    chapter gap: `narrator align` writes the cues, `narrator assemble` inserts
 *    the silence, and from 2026-09-09 to 2026-09-11 the app passed the gap to the
 *    assembler and not to the aligner — so the cues drifted earlier by the gap at
 *    every chapter boundary (a 15-chapter book, 3 s each, ends 45 s short) and
 *    assembly sealed the file exactly as it found it.
 *
 * A MEASUREMENT THAT COULD NOT BE MADE IS A VERDICT TOO ('unmeasurable'), never a
 * shrug: promoting an unverifiable file is how the truncation defect shipped the
 * first time.
 *
 * Pure and shared so the gate's arithmetic can be tested without an m4b, an
 * ffmpeg or a queue — see `tools/test-chapter-gap.js`.
 */

/**
 * Seconds of disagreement the gate tolerates, in EITHER direction.
 *
 * The legitimate tail after the last cue is under a second (the sentence's own
 * trailing silence), and the legitimate shortfall is zero — so 5 s is slack for
 * rounding and a container's padding, not for a missing chapter gap.
 */
export const TRANSCRIPT_LENGTH_TOLERANCE = 5;

/** What the transcript says about the audio it was sealed into. */
export type TranscriptLengthVerdict =
  /** They agree inside the tolerance. */
  | 'ok'
  /** The transcript ends well BEFORE the audio — different rulers. */
  | 'transcript-short'
  /** The transcript ends well AFTER the audio — a truncated export. */
  | 'transcript-long'
  /** The audio's duration could not be measured at all. */
  | 'unmeasurable';

/**
 * Compare a finished audiobook against its own sentence transcript.
 *
 * `m4bSeconds` is null when the probe failed — which is 'unmeasurable', not
 * 'ok'. `lastCueEnd` is the end of the transcript's LAST cue; a transcript with
 * no cues has no verdict to give and must not reach here.
 */
export function transcriptLengthVerdict(
  m4bSeconds: number | null,
  lastCueEnd: number,
  tolerance: number = TRANSCRIPT_LENGTH_TOLERANCE,
): TranscriptLengthVerdict {
  if (m4bSeconds === null || !Number.isFinite(m4bSeconds)) return 'unmeasurable';
  const difference = lastCueEnd - m4bSeconds;
  if (difference > tolerance) return 'transcript-long';
  if (difference < -tolerance) return 'transcript-short';
  return 'ok';
}

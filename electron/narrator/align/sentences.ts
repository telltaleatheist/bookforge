/**
 * Sentence cues inside a chunk's span, from the chunk's alignment. A port of
 * `narrator/align/sentences.py`. The first sentence starts at the chunk's start and the last ends at
 * its end, because the span is exact (sample counts) and the aligner's edges are not. Interior seams
 * snap onto the middle of the pause between the words. Every measured cue carries its report card.
 */

import { pyFixed, pyRepr, pyStrip } from '../py-compat';
import { splitChunkSentences, type SentenceCue } from '../assemble/sentence-vtt';
import { AlignerError, isTimed, type AlignedWord, type Alignment, type Silence } from './aligner';

/** How far a seam may move to land in a pause. Inside one chunk it only has to cover the frame's slop. */
const SNAP_WINDOW_S = 0.3;
/** A floor, so a snap can never collapse a cue to zero or invert two. */
const MIN_CUE_S = 0.05;
/** The manifest and the decoded audio are one file, so a larger difference means they came apart. */
const SPAN_TOLERANCE_S = 0.05;

const firstCodePoints = (text: string, n: number): string => [...text].slice(0, n).join('');

function sentenceWordRanges(sentences: readonly string[], wordCount: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const n = sentence.split(' ').filter((w) => w !== '').length;
    if (n === 0) throw new AlignerError(`the splitter produced an empty sentence in ${pyRepr(sentences)}`);
    ranges.push([cursor, cursor + n - 1]);
    cursor += n;
  }
  if (cursor !== wordCount) {
    throw new AlignerError(`the chunk splits into ${cursor} sentence word(s) but the alignment carries ${wordCount}; the splitter and the aligner disagree about the text`);
  }
  return ranges;
}

/** Only silences overlapping the window count, each by its midpoint clipped to the window; the nearest wins. */
function snap(raw: number, low: number, high: number, silences: readonly Silence[]): number {
  if (high < low) throw new AlignerError(`_snap: no room for a seam between ${pyFixed(low, 3)}s and ${pyFixed(high, 3)}s`);
  if (high === low) return low;
  const windowLo = Math.max(low, raw - SNAP_WINDOW_S);
  const windowHi = Math.min(high, raw + SNAP_WINDOW_S);
  if (windowHi <= windowLo) return Math.min(Math.max(raw, low), high);
  let bestDistance: number | null = null;
  let best = 0;
  for (const [a, b] of silences) {
    const overlapLo = Math.max(a, windowLo);
    const overlapHi = Math.min(b, windowHi);
    if (overlapHi <= overlapLo) continue;
    const middle = 0.5 * (overlapLo + overlapHi);
    const distance = Math.abs(middle - raw);
    if (bestDistance === null || distance < bestDistance) {
      bestDistance = distance;
      best = middle;
    }
  }
  return bestDistance === null ? Math.min(Math.max(raw, low), high) : best;
}

function boundarySilence(start: number, silences: readonly Silence[]): number {
  for (const [a, b] of silences) if (a <= start && start <= b) return b - a;
  return 0;
}

function cueQuality(alignment: Alignment, words: readonly AlignedWord[], start: number, end: number, sentence: string, monotonic: boolean): Record<string, unknown> {
  const span = end - start;
  const chars = [...pyStrip(sentence)].length;
  const cps = span > 0 ? chars / span : 0;
  const scores = words.map((w) => w.score).filter((s): s is number => s !== null);
  return {
    monotonic,
    chars_per_sec: cps,
    pace_ratio: alignment.pace > 0 ? cps / alignment.pace : null,
    boundary_silence_s: boundarySilence(start, alignment.silences),
    worst_word_score: scores.length > 0 ? Math.min(...scores) : null,
    score_source: 'derived',
  };
}

/** One chunk's alignment as sentence cues, in the book's timeline. A sentence with no placed word is refused. */
export function sentenceCues(alignment: Alignment, chunkIndex: number, chunkStart: number, chunkEnd: number, isHeading: boolean, text: string): SentenceCue[] {
  const span = chunkEnd - chunkStart;
  if (span <= 0) throw new AlignerError(`chunk ${chunkIndex}: the manifest gives it a ${pyFixed(span, 3)}s cue span`);
  if (Math.abs(span - alignment.duration) > SPAN_TOLERANCE_S) {
    throw new AlignerError(
      `chunk ${chunkIndex}: the manifest says ${pyFixed(span, 3)}s but ${alignment.audioPath} decodes to ${pyFixed(alignment.duration, 3)}s. `
      + 'The manifest and the audio have come apart; re-derive the manifest from the sentences dir that was actually rendered.',
    );
  }
  const sentences = splitChunkSentences(text);
  const ranges = sentenceWordRanges(sentences, alignment.words.length);

  const needed = MIN_CUE_S * sentences.length;
  if (span < needed) {
    throw new AlignerError(
      `chunk ${chunkIndex} is ${pyFixed(span, 3)}s and splits into ${sentences.length} sentence(s); at a ${MIN_CUE_S}s floor per cue that needs ${pyFixed(needed, 3)}s. `
      + 'The chunk and its text do not match: check the render before trusting either.',
    );
  }

  const bounds = ranges.map(([first, last], position): [number, number] => {
    const timed = alignment.words.slice(first, last + 1).filter(isTimed);
    if (timed.length === 0) {
      throw new AlignerError(`chunk ${chunkIndex}: sentence ${position} (${pyRepr(firstCodePoints(sentences[position], 60))}) has no placed word, so its cue would be invented rather than measured`);
    }
    return [timed[0].start as number, timed[timed.length - 1].end as number];
  });

  // Bounded by the manifest's span rather than the decoded duration, so the last cue cannot end a
  // millisecond past its chunk's. The tolerance check above is what makes that safe.
  const seams: number[] = [];
  for (let position = 0; position < bounds.length - 1; position += 1) {
    const leftEnd = bounds[position][1];
    const rightStart = bounds[position + 1][0];
    const raw = rightStart >= leftEnd ? 0.5 * (leftEnd + rightStart) : Math.max(leftEnd, rightStart);
    const low = (seams.length > 0 ? seams[seams.length - 1] : 0) + MIN_CUE_S;
    const high = span - MIN_CUE_S * (bounds.length - position - 1);
    seams.push(snap(raw, low, high, alignment.silences));
  }

  const cues: SentenceCue[] = [];
  let previousEnd: number | null = null;
  sentences.forEach((sentence, position) => {
    const start = position === 0 ? 0 : seams[position - 1];
    const end = position === sentences.length - 1 ? span : seams[position];
    const [first, last] = ranges[position];
    const words = alignment.words.slice(first, last + 1);
    const starts = words.filter(isTimed).map((w) => w.start as number);
    const inOrder = starts.every((s, i) => i === 0 || starts[i - 1] <= s);
    const monotonic = inOrder && (previousEnd === null || start >= previousEnd - 1e-9);
    previousEnd = end;
    cues.push({
      chunkIndex,
      sentenceIndex: position,
      start: chunkStart + start,
      end: chunkStart + end,
      text: sentence,
      isHeading: isHeading && position === 0,
      estimated: false,
      quality: cueQuality(alignment, words, start, end, sentence, monotonic),
    });
  });
  return cues;
}

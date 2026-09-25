/**
 * GENERATE SENTENCES FOR CLIPS — the pure half: where in the book is each clip?
 *
 * Owen, 2026-09-25: "if we had 500 small one-sentence clips of audio spread
 * throughout the entire book, we would be able to run generate-sentences for it
 * and match up the book text to each individual clip?" The whole-book diff
 * (book-diff.ts) assumes ONE recording read in book order — its anchors are kept
 * by a longest increasing subsequence — so clips cannot simply be stitched and
 * diffed: one clip out of order would be dropped as unmatched. So each clip is
 * LOCATED on its own first, by the runs of its heard words that occur exactly
 * once in the book, and then diffed against only that stretch of the book.
 * Clip order therefore does not matter.
 *
 * The ASR still runs ONCE: the clips are stitched with a silence gap between
 * them (stitchPlan) and the heard words are dealt back to their clips by time
 * (splitHeardByClip). Everything here is pure; the Crucible calls and the audio
 * live in electron/crucible/clip-sentence-align.ts.
 */

import { normalizeWords, type BookSentence, type HeardWord } from './book-diff';

/** Digital silence between stitched clips: long enough that no ASR segment spans two clips. */
export const STITCH_GAP_S = 1.5;

/** Where one clip sits in the stitched audio. */
export interface StitchedClip {
  readonly offset: number;
  readonly duration: number;
}

/** Clip i starts after every clip before it and a gap after each. */
export function stitchPlan(durations: readonly number[], gapS = STITCH_GAP_S): StitchedClip[] {
  const out: StitchedClip[] = [];
  let t = 0;
  for (const d of durations) {
    out.push({ offset: t, duration: d });
    t += d + gapS;
  }
  return out;
}

/**
 * Deal the stitched transcript's words back to their clips, in clip-local seconds.
 * A word belongs to the clip its MIDPOINT falls in; a word in a gap (a hallucinated
 * word over silence) belongs to nobody and is counted, never guessed at.
 */
export function splitHeardByClip(
  words: readonly HeardWord[], plan: readonly StitchedClip[],
): { perClip: HeardWord[][]; inGaps: number } {
  const perClip: HeardWord[][] = plan.map(() => []);
  let inGaps = 0;
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    // binary search: the last clip whose offset <= mid
    let lo = 0; let hi = plan.length - 1; let k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (plan[m].offset <= mid) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0 || mid > plan[k].offset + plan[k].duration) { inGaps++; continue; }
    const c = plan[k];
    perClip[k].push({
      word: w.word,
      start: Math.min(c.duration, Math.max(0, w.start - c.offset)),
      end: Math.min(c.duration, Math.max(0, w.end - c.offset)),
    });
  }
  return { perClip, inGaps };
}

/** The book as one token stream, each token knowing its sentence. */
export interface BookIndex {
  readonly tokens: readonly string[];
  readonly sentenceOf: readonly number[];
  /** n -> n-gram -> its token position, or -1 when it occurs more than once. */
  readonly grams: ReadonlyMap<number, ReadonlyMap<string, number>>;
}

/** Anchor sizes tried in order: a 4-word run is almost always unique in a book, a 2-word run rarely. */
export const LOCATE_NS = [4, 3, 2] as const;

export function buildBookIndex(sentences: readonly BookSentence[]): BookIndex {
  const tokens: string[] = []; const sentenceOf: number[] = [];
  sentences.forEach((s, si) => { for (const w of normalizeWords(s.text)) { tokens.push(w); sentenceOf.push(si); } });
  const grams = new Map<number, Map<string, number>>();
  for (const n of LOCATE_NS) {
    const m = new Map<string, number>();
    for (let i = 0; i + n <= tokens.length; i++) {
      const g = tokens.slice(i, i + n).join(' ');
      m.set(g, m.has(g) ? -1 : i);
    }
    grams.set(n, m);
  }
  return { tokens, sentenceOf, grams };
}

/** How far outside its anchored words a clip's book stretch reaches, in tokens (a clip edge cuts mid-sentence). */
export const LOCATE_SLACK_TOKENS = 40;

export interface ClipLocation {
  /** Inclusive sentence range of the book stretch the clip is diffed against. */
  readonly sentenceFrom: number;
  readonly sentenceTo: number;
  /** Which anchor size located it, and how many anchors agreed. */
  readonly n: number;
  readonly anchors: number;
}

/**
 * Where in the book a clip was read. Every unique n-gram of its heard words votes
 * for a book position; the votes near their median are kept (a stray unique
 * 2-gram elsewhere in the book is an outlier, not a second location), and the
 * clip's stretch is the kept anchors widened by the clip's own length and a slack.
 * Null when no heard run is unique in the book - a clip too short or too garbled
 * to place, which the caller reports rather than guesses.
 */
export function locateClip(book: BookIndex, heard: readonly HeardWord[]): ClipLocation | null {
  const h: string[] = [];
  for (const w of heard) for (const p of normalizeWords(w.word)) h.push(p);
  if (h.length === 0) return null;
  for (const n of LOCATE_NS) {
    const m = book.grams.get(n)!;
    const votes: number[] = [];
    for (let i = 0; i + n <= h.length; i++) {
      const p = m.get(h.slice(i, i + n).join(' '));
      // the vote is where the clip's FIRST word would be, so all of one clip's votes agree
      if (p !== undefined && p >= 0) votes.push(p - i);
    }
    // a lone 2-gram is too weak to trust on its own
    if (votes.length === 0 || (n === 2 && votes.length < 2)) continue;
    const sorted = votes.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const reach = h.length + LOCATE_SLACK_TOKENS;
    const kept = sorted.filter((v) => Math.abs(v - med) <= reach);
    if (kept.length === 0) continue;
    const lo = Math.max(0, kept[0] - LOCATE_SLACK_TOKENS);
    const hi = Math.min(book.tokens.length - 1, kept[kept.length - 1] + h.length + LOCATE_SLACK_TOKENS);
    return { sentenceFrom: book.sentenceOf[lo], sentenceTo: book.sentenceOf[hi], n, anchors: kept.length };
  }
  return null;
}

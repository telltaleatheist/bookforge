/**
 * WHERE THE AUDIO AND THE BOOK DISAGREE — the record a person reads after a run.
 *
 * Owen, 2026-09-25: "we need some way to tell when audio contains content that isnt
 * found in the text, and cases where text doesnt exist in the audio ... like cases
 * where the reader paraphrased the book. and maybe we ASR the book and measure the
 * reader's characters per minute for a given section, and if it dramatically deviates
 * ... throw up a warning in the json file." And: music at the start of a book, and
 * intros read by somebody else.
 *
 * Pure: everything comes from what a run already has (the book's sentences, the
 * final placements, the ASR's words, the diff's extra-audio runs and the level
 * envelope). Categories, each with times and both texts where there are two:
 *
 *   audio_not_in_text   runs of heard words the book does not contain (>= 5 words, the
 *                       diff's extraAudio), and INSERTS: heard words inside a placed
 *                       cue beyond the ones its own words claimed (>= INSERT_MIN_WORDS)
 *   text_not_in_audio   runs of book sentences never placed, and OMISSIONS: book words
 *                       inside a placed sentence the ASR never heard as themselves
 *   paraphrase          a sentence the aligner placed (it was told the book's text)
 *                       where the ASR agreed with < PARAPHRASE_MAX_COVERAGE of its
 *                       words: the reader said something else there
 *   pace_outlier        a cue whose characters per second is more than PACE_BAND off
 *                       the rolling median of the PACE_NEIGHBOURS cues around it -
 *                       stretched (audio the text does not account for) or squeezed
 *                       (text the audio does not hold)
 *   non_speech_audio    loud audio (> NONSPEECH_OVER_FLOOR_DB over the pause floor)
 *                       for >= NONSPEECH_MIN_S with no heard word in it: music, a
 *                       sting, sound effects - never narration
 *   music_under_speech  Owen's pause-map rule (2026-09-25): "if theres no silence in
 *                       speech it might have background music". A narrator's pause
 *                       between sentences falls to the room's floor; a bed under the
 *                       voice never lets it. BED_MIN_PAUSES consecutive sentence pauses
 *                       whose quietest frame stays > BED_OVER_FLOOR_DB over the book's
 *                       floor are flagged as one stretch.
 *
 * Not here yet: a different READER needs speaker embeddings, and a confident music
 * label an AudioSet classifier - Crucible verbs, not signal rules.
 */

import { normalizeWords, type BookSentence, type HeardWord, type SentencePlacement } from './book-diff';
import { FRAME_S, type LevelEnvelope } from './cue-edges';

export const INSERT_MIN_WORDS = 2;
export const OMISSION_MIN_WORDS = 2;
export const PARAPHRASE_MAX_COVERAGE = 0.85;
export const PACE_NEIGHBOURS = 20;          // each side
export const PACE_BAND = 0.35;              // +-35 % of the local median
export const PACE_MIN_S = 2.0;              // shorter cues are too noisy to judge
export const PACE_MIN_CHARS = 40;          // ... and so are short lines ("Wax said.")
export const NONSPEECH_MIN_S = 2.0;
export const NONSPEECH_OVER_FLOOR_DB = 25;
export const BED_MIN_PAUSES = 5;
export const BED_OVER_FLOOR_DB = 15;
export const BED_MIN_GAP_S = 0.25;

export interface DiscrepancyCue { readonly index: number; readonly start: number; readonly end: number }

export interface Discrepancy {
  readonly kind: 'audio_not_in_text' | 'text_not_in_audio' | 'paraphrase' | 'pace_outlier' | 'non_speech_audio' | 'music_under_speech';
  readonly what: string;               // insert / extra_run / omission / unplaced_run / ...
  readonly start: number | null;
  readonly end: number | null;
  readonly severity: 'high' | 'medium' | 'low';
  readonly sentences?: readonly number[];
  readonly book?: string;
  readonly heard?: string;
  readonly detail?: string;
}

export interface DiscrepancyReport {
  readonly summary: Record<string, { count: number; seconds: number }>;
  readonly localPace: { readonly medianCharsPerSec: number | null };
  readonly items: readonly Discrepancy[];
}

const heardIn = (heard: readonly HeardWord[], a: number, b: number): HeardWord[] =>
  heard.filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 <= b);

function median(xs: number[]): number { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; }

/**
 * Words compared hyphen-JOINED on both sides: the book's "warmth-giving" and the ASR's
 * "warmthgiving" are the same word read correctly (the first live run flagged 18
 * "paraphrases" that were all hyphenation).
 */
const joined = (t: string): string[] => t.toLowerCase()
  .replace(/[‘’ʼ'`]/g, '')          // apostrophes: "wasn't" == "wasnt" == the book's curly form
  .replace(/[‐-―-]/g, '')                 // hyphens and dashes: "warmth-giving" == "warmthgiving"
  .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
/** Longest common subsequence of two word lists - how many of the book's words the reader said, in order. */
function lcs(a: string[], b: string[]): number {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = tmp; }
  }
  return dp[b.length];
}

export function findDiscrepancies(o: {
  sentences: readonly BookSentence[];
  /** Final placement per sentence index (after the aligner). */
  placements: readonly SentencePlacement[];
  /** Which sentences the DIFF placed on its own (the rest of `placed` came from the aligner). */
  placedByDiff: ReadonlySet<number>;
  cues: readonly DiscrepancyCue[];
  heard: readonly HeardWord[];
  extraAudio: readonly { start: number; end: number; words: number; text: string }[];
  env?: LevelEnvelope;
}): DiscrepancyReport {
  const items: Discrepancy[] = [];
  const P = o.placements;
  const text = (i: number): string => o.sentences[i].text.replace(/\s+/g, ' ').trim();

  // audio_not_in_text: the diff's runs
  for (const x of o.extraAudio) {
    items.push({ kind: 'audio_not_in_text', what: 'extra_run', start: x.start, end: x.end, severity: x.words >= 15 ? 'high' : 'medium', heard: x.text });
  }
  // per placed cue: inserts, omissions, paraphrase
  for (const c of o.cues) {
    const p = P[c.index];
    if (!p || p.status !== 'placed' || p.start === null || p.end === null) continue;
    const own = p.words.filter((w) => w.match === 'exact' || w.match === 'fuzzy').length;
    const inSpan = heardIn(o.heard, p.start, p.end);
    // an INSERT is the reader saying MORE words than the book has there; a word said
    // differently is a substitution (paraphrase / omission below), not an insert
    const extra = joined(inSpan.map((w) => w.word).join(' ')).length - joined(text(c.index)).length;
    if (extra >= INSERT_MIN_WORDS) {
      items.push({ kind: 'audio_not_in_text', what: 'insert', start: p.start, end: p.end, severity: extra >= 5 ? 'high' : 'low',
        sentences: [c.index], book: text(c.index), heard: inSpan.map((w) => w.word).join(' '), detail: `${extra} heard word(s) beyond the sentence's own` });
    }
    const bw = joined(text(c.index)); const hw = joined(inSpan.map((w) => w.word).join(' '));
    const said = lcs(bw, hw); const agree = bw.length ? said / bw.length : 1;
    const missing = bw.length - said;
    const byAligner = !o.placedByDiff.has(c.index);
    if (byAligner && agree < PARAPHRASE_MAX_COVERAGE && bw.length >= 4) {
      items.push({ kind: 'paraphrase', what: 'reworded', start: p.start, end: p.end, severity: agree < 0.6 ? 'high' : 'medium',
        sentences: [c.index], book: text(c.index), heard: inSpan.map((w) => w.word).join(' '),
        detail: `the reader said ${Math.round(agree * 100)}% of the book's words, in order` });
    } else if (missing >= OMISSION_MIN_WORDS) {
      items.push({ kind: 'text_not_in_audio', what: 'omission', start: p.start, end: p.end, severity: missing >= 5 ? 'high' : 'low',
        sentences: [c.index], book: text(c.index), heard: inSpan.map((w) => w.word).join(' '), detail: `${missing} book word(s) not heard as written` });
    }
  }
  // text_not_in_audio: runs of unplaced sentences, with the placed neighbours' times
  for (let i = 0; i < P.length;) {
    if (P[i].status === 'placed') { i++; continue; }
    let k = i; while (k < P.length && P[k].status !== 'placed') k++;
    const prev = i > 0 ? P[i - 1] : null; const next = k < P.length ? P[k] : null;
    const run = Array.from({ length: k - i }, (_, t) => i + t);
    const words = run.reduce((n, s) => n + normalizeWords(o.sentences[s].text).length, 0);
    items.push({ kind: 'text_not_in_audio', what: 'unplaced_run', start: prev?.end ?? null, end: next?.start ?? null,
      severity: words >= 40 ? 'high' : words >= 8 ? 'medium' : 'low', sentences: run,
      book: run.map(text).join(' ').slice(0, 400), detail: `${run.length} sentence(s), ${words} word(s): ${P[i].reason ?? P[i].status}` });
    i = k;
  }
  // pace_outlier: chars per second of the READ span (word times, not the pause-centred edges)
  const paced = o.cues.map((c) => {
    const p = P[c.index]; const d = p && p.start !== null && p.end !== null ? p.end - p.start : 0;
    return { c, d, cps: d > 0 ? text(c.index).length / d : 0 };
  });
  const cpsAll: number[] = [];
  for (let i = 0; i < paced.length; i++) {
    const q = paced[i]; const long = (x: typeof q): boolean => x.d >= PACE_MIN_S && text(x.c.index).length >= PACE_MIN_CHARS;
    if (!long(q)) continue;
    const around = paced.slice(Math.max(0, i - PACE_NEIGHBOURS), i + PACE_NEIGHBOURS + 1).filter((x) => long(x) && x !== q).map((x) => x.cps);
    if (around.length < 8) continue;
    const m = median(around); cpsAll.push(q.cps);
    const r = q.cps / m;
    if (r < 1 - PACE_BAND || r > 1 + PACE_BAND) {
      items.push({ kind: 'pace_outlier', what: r < 1 ? 'stretched' : 'squeezed', start: P[q.c.index].start, end: P[q.c.index].end,
        severity: r < 0.5 || r > 1.8 ? 'high' : 'medium', sentences: [q.c.index], book: text(q.c.index),
        detail: `${q.cps.toFixed(1)} chars/s against ${m.toFixed(1)} around it (${r < 1 ? 'slower' : 'faster'} by ${Math.round(Math.abs(1 - r) * 100)}%)` });
    }
  }
  // non_speech_audio: loud frames with no heard word near them
  if (o.env && o.env.db.length > 0) {
    const db = Array.from(o.env.db);
    const sorted = db.filter((v) => v > -150).sort((a, b) => a - b);
    const floor = sorted.length ? sorted[Math.floor(sorted.length * 0.05)] : -100;
    const words = o.heard.slice().sort((a, b) => a.start - b.start); let wi = 0;
    let runStart = -1;
    const flush = (endFrame: number): void => {
      if (runStart < 0) return;
      const a = runStart * FRAME_S; const b = endFrame * FRAME_S;
      if (b - a >= NONSPEECH_MIN_S) items.push({ kind: 'non_speech_audio', what: 'loud_without_words', start: a, end: b,
        severity: b - a >= 8 ? 'high' : 'medium', detail: 'loud audio with no heard word: music, a sting or sound effects' });
      runStart = -1;
    };
    for (let f = 0; f < db.length; f++) {
      const t = f * FRAME_S;
      while (wi < words.length && words[wi].end < t - 0.5) wi++;
      const nearWord = wi < words.length && words[wi].start <= t + 0.5;
      const loud = db[f] > floor + NONSPEECH_OVER_FLOOR_DB;
      if (loud && !nearWord) { if (runStart < 0) runStart = f; } else flush(f);
    }
    flush(db.length);

    // music_under_speech: the pauses between consecutive placed sentences, by their quietest frame
    const read = o.cues.map((c) => P[c.index]).filter((p) => p && p.status === 'placed' && p.start !== null && p.end !== null)
      .sort((a, b) => a.start! - b.start!);
    let bed: { a: number; b: number; n: number; lift: number[] } | null = null;
    const closeBed = (): void => {
      if (bed && bed.n >= BED_MIN_PAUSES) items.push({ kind: 'music_under_speech', what: 'no_silent_pauses', start: bed.a, end: bed.b,
        severity: bed.n >= 15 ? 'high' : 'medium',
        detail: `${bed.n} consecutive sentence pauses never fell within ${BED_OVER_FLOOR_DB} dB of the floor (quietest ${Math.min(...bed.lift).toFixed(0)} dB over it): a bed under the voice` });
      bed = null;
    };
    for (let i = 1; i < read.length; i++) {
      const g0 = read[i - 1].end!; const g1 = read[i].start!;
      if (g1 - g0 < BED_MIN_GAP_S) continue;
      const f0 = Math.max(0, Math.floor(g0 / FRAME_S)); const f1 = Math.min(db.length, Math.ceil(g1 / FRAME_S));
      if (f1 <= f0) continue;
      const q = Math.min(...db.slice(f0, f1));
      if (q <= -150) { closeBed(); continue; }                 // digital silence: a seam, not a pause
      const lift = q - floor;
      if (lift > BED_OVER_FLOOR_DB) {
        if (!bed) bed = { a: read[i - 1].start!, b: read[i].end!, n: 0, lift: [] };
        bed.b = read[i].end!; bed.n++; bed.lift.push(lift);
      } else closeBed();
    }
    closeBed();
  }
  const summary: Record<string, { count: number; seconds: number }> = {};
  for (const x of items) {
    const s = (summary[x.kind] ??= { count: 0, seconds: 0 });
    s.count++; if (x.start !== null && x.end !== null) s.seconds += Math.max(0, x.end - x.start);
  }
  for (const k of Object.keys(summary)) summary[k].seconds = +summary[k].seconds.toFixed(1);
  items.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  return { summary, localPace: { medianCharsPerSec: cpsAll.length ? +median(cpsAll).toFixed(2) : null }, items };
}

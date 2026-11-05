/**
 * One chunk's words, from a forced aligner's items and the chunk's own audio. A port of the half of
 * `narrator/align/aligner.py` that runs here: the model's half is a Crucible `align` job, whose items
 * arrive as a file. Its scores are DERIVED, because that model publishes no confidence.
 *
 * The audio is decoded for what the items do not carry: the duration, the silences and the scores.
 */

import { pyCasefold } from '../text/casefold';
import { pyCollapseSpace, pyFixed, pyFloatRepr, pyInt, pyRepr, pyStrip } from '../py-compat';
import { FfmpegError, run } from '../assemble/ffmpeg-tools';

const SAMPLE_RATE = 16000;

/** Silence map: windows under -45 dBFS, merged into runs of at least 0.15 s. 20 ms frames, 10 ms hop. */
const SILENCE_NOISE_DB = -45;
const SILENCE_MIN_S = 0.15;
const SILENCE_HOP = 160;
const SILENCE_WINDOW = 320;

/** Below about a quarter second, a gap is a breath or a plosive rather than an insertion. */
const MIN_AUDIO_SPAN_S = 0.25;

/** A forced alignment's adjacent words touch: 50 ms is one CTC frame of slop, not a reordering. */
const DERIVED_ORDER_SLACK_S = 0.05;
/** A word between pace/3 and pace*3 scores 1 on rate, falling linearly to 0 at pace/6 and pace*6. */
const DERIVED_RATE_INNER = 3;
const DERIVED_RATE_OUTER = 6;

/** At or above this a word counts as placed, for drawing spans. The coverage threshold is the policy's. */
const SPAN_SCORE_FLOOR = 0.4;

export const ALNUM = /[\p{L}\p{N}]/u;
export const SCORE_SOURCE = 'derived';

export class AlignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlignerError';
  }
}

export interface AlignedWord {
  readonly index: number;
  readonly word: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly score: number | null;
}

export interface TextSpan {
  readonly firstWord: number;
  readonly lastWord: number;
  readonly words: number;
  readonly text: string;
  readonly audioStart: number | null;
  readonly audioEnd: number | null;
  readonly worstScore: number | null;
}

export interface AudioSpan {
  readonly start: number;
  readonly end: number;
  readonly speechFraction: number;
  readonly where: 'head' | 'interior' | 'tail';
}

export type Silence = readonly [number, number];

export interface Alignment {
  readonly audioPath: string;
  readonly text: string;
  readonly duration: number;
  readonly words: readonly AlignedWord[];
  readonly unalignedTextSpans: readonly TextSpan[];
  readonly unalignedAudioSpans: readonly AudioSpan[];
  readonly silences: readonly Silence[];
  readonly elapsed: number;
  readonly pace: number;
}

export interface PrecomputedItem {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export const isTimed = (word: AlignedWord): boolean => word.start !== null && word.end !== null;

const codePoints = (text: string): number => {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
};

/** `float(value)` as the Python read an artifact's times, with its own words when it could not. */
function pyFloatOf(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const clean = pyStrip(value).replace(/(?<=\d)_(?=\d)/g, '');
    if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(clean)) return Number(clean);
    const named = /^([+-]?)(inf(inity)?|nan)$/i.exec(clean);
    if (named) {
      if (named[2].toLowerCase() === 'nan') return Number.NaN;
      return named[1] === '-' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    throw new TypeError(`could not convert string to float: ${pyRepr(value)}`);
  }
  const type = value === null || value === undefined ? 'NoneType' : Array.isArray(value) ? 'list' : 'dict';
  throw new TypeError(`float() argument must be a string or a real number, not '${type}'`);
}

const pyTypeName = (value: unknown): string => {
  if (value === null) return 'NoneType';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return Array.isArray(value) ? 'list' : 'dict';
};

/** Every field is required: a producer that stopped sending `start` must not place a word at 0. */
export function precomputedItems(rows: readonly unknown[], chunkIndex: number): PrecomputedItem[] {
  return rows.map((row, position) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new AlignerError(`chunk ${chunkIndex}: item ${position} is ${pyTypeName(row)}, not an object with text/start/end`);
    }
    const fields = row as Record<string, unknown>;
    const missing = ['text', 'start', 'end'].filter((f) => !Object.prototype.hasOwnProperty.call(fields, f));
    if (missing.length > 0) {
      throw new AlignerError(`chunk ${chunkIndex}: item ${position} is missing ${missing.join(', ')}; a precomputed item carries all three`);
    }
    let start: number;
    let end: number;
    try {
      start = pyFloatOf(fields['start']);
      end = pyFloatOf(fields['end']);
    } catch (bad) {
      throw new AlignerError(`chunk ${chunkIndex}: item ${position} (${pyRepr(fields['text'])}) has times that are not numbers: ${(bad as Error).message}`);
    }
    const text = typeof fields['text'] === 'string' ? fields['text'] : pyRepr(fields['text']);
    return { text, start, end };
  });
}

/** `int(chunk['index'])` as the Python read it. Null when it is not a number. */
export function pyIntOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return pyInt(value);
  return null;
}

async function decodeAudio(file: string, ffmpeg: string, signal?: AbortSignal): Promise<Float32Array> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    await run([ffmpeg, '-v', 'error', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], `decoding ${file}`, {
      signal,
      onData: (data) => {
        parts.push(data);
        size += data.length;
      },
    });
  } catch (err) {
    if (err instanceof FfmpegError) throw new AlignerError(`ffmpeg could not decode ${file}: ${err.stderr.slice(-400)}`);
    throw err;
  }
  if (size === 0) throw new AlignerError(`${file} decoded to zero samples`);
  const audio = new Float32Array(size >> 2);
  const bytes = new Uint8Array(audio.buffer);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return audio;
}

/**
 * The chunk's pauses, in its own timeline. Summed in order rather than numpy's pairwise order: the
 * two differ in the last bits of a mean, and only a window within that distance of -45 dB could tell.
 */
export function detectSilences(audio: Float32Array): Silence[] {
  if (audio.length < SILENCE_WINDOW) return [];
  const frames = 1 + Math.floor((audio.length - SILENCE_WINDOW) / SILENCE_HOP);
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    const from = i * SILENCE_HOP;
    for (let j = from; j < from + SILENCE_WINDOW; j += 1) sum += audio[j] * audio[j];
    const rms = Math.sqrt(Math.max(sum / SILENCE_WINDOW, 1e-20));
    const quiet = 20 * Math.log10(rms) < SILENCE_NOISE_DB;
    if (quiet && start === null) {
      start = i;
    } else if (!quiet && start !== null) {
      runs.push([start, i]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, frames]);
  const spans: Silence[] = [];
  for (const [a, b] of runs) {
    const t0 = (a * SILENCE_HOP) / SAMPLE_RATE;
    const t1 = Math.min((b * SILENCE_HOP + SILENCE_WINDOW) / SAMPLE_RATE, audio.length / SAMPLE_RATE);
    if (t1 - t0 >= SILENCE_MIN_S) spans.push([t0, t1]);
  }
  return spans;
}

/** How much of `[start, end)` is not in the silence map, 0..1. */
export function speechFraction(start: number, end: number, silences: readonly Silence[]): number {
  const span = end - start;
  if (span <= 0) return 0;
  let quiet = 0;
  for (const [a, b] of silences) quiet += Math.max(0, Math.min(b, end) - Math.max(a, start));
  return Math.max(0, 1 - quiet / span);
}

/**
 * Casefolded, everything but letters and digits removed: the one thing our words and the model's
 * items agree about. A Unicode class, because a literal [a-z0-9] normalizes all of Japanese to nothing.
 */
export function normalized(text: string): string {
  let out = '';
  for (const ch of pyCasefold(text)) if (ALNUM.test(ch)) out += ch;
  return out;
}

function offsets(pieces: readonly string[]): Array<[number, number]> {
  let cursor = 0;
  return pieces.map((piece) => {
    const size = codePoints(normalized(piece));
    const span: [number, number] = [cursor, cursor + size];
    cursor += size;
    return span;
  });
}

const firstCodePoints = (text: string, n: number): string => [...text].slice(0, n).join('');

type RawWord = readonly [string, number | null, number | null];

/**
 * The model's items onto OUR words, walking both in normalized-character space. A word takes the
 * times of every item it overlaps, so an item that merges two words gives both its span. A word no
 * item overlaps has no letters and stays untimed.
 */
export function mapItemsOntoWords(items: readonly PrecomputedItem[], expected: readonly string[]): RawWord[] {
  if (items.length === 0) {
    throw new AlignerError(`backend 'qwen3' returned no items for ${expected.length} word(s). The model was given audio it could not place this text in at all.`);
  }
  const texts = items.map((item) => item.text);
  const ours = expected.map(normalized).join('');
  const theirs = texts.map(normalized).join('');
  if (ours !== theirs) {
    throw new AlignerError(
      `backend 'qwen3' returned text that is not the text it was given: ${codePoints(theirs)} normalized character(s) against our ${codePoints(ours)}. `
      + `Ours starts ${pyRepr(firstCodePoints(ours, 60))}, its ${pyRepr(firstCodePoints(theirs, 60))}.`,
    );
  }
  const wordSpans = offsets(expected);
  const itemSpans = offsets(texts);
  let cursor = 0;
  return expected.map((mine, position): RawWord => {
    const [lo, hi] = wordSpans[position];
    while (cursor < itemSpans.length && itemSpans[cursor][1] <= lo) cursor += 1;
    let first: number | null = null;
    let last: number | null = null;
    for (let probe = cursor; probe < itemSpans.length && itemSpans[probe][0] < hi; probe += 1) {
      if (itemSpans[probe][1] > lo) {
        first ??= probe;
        last = probe;
      }
    }
    if (first === null || last === null) return [mine, null, null];
    return [mine, items[first].start, items[last].end];
  });
}

/** Is this many characters in this many seconds a placement, or a word the model had nowhere to put? */
function ratePlausibility(chars: number, duration: number, pace: number): number {
  if (duration <= 0 || chars <= 0) return 0;
  const cps = chars / duration;
  const low = pace / DERIVED_RATE_INNER;
  const high = pace * DERIVED_RATE_INNER;
  if (low <= cps && cps <= high) return 1;
  if (cps < low) {
    const floor = pace / DERIVED_RATE_OUTER;
    return Math.max(0, (cps - floor) / (low - floor));
  }
  const ceiling = pace * DERIVED_RATE_OUTER;
  return Math.max(0, (ceiling - cps) / (ceiling - high));
}

/** Speech presence × rate plausibility × order. First estimates, not measurements. An untimed word stays None. */
function deriveScores(words: readonly AlignedWord[], silences: readonly Silence[], pace: number): AlignedWord[] {
  if (pace <= 0) {
    throw new AlignerError(`a derived score needs a pace in characters per second and was given ${pyFloatRepr(pace)}; pass pace_chars_per_sec, or align a chunk whose text and audio are both non-empty`);
  }
  let previousEnd: number | null = null;
  return words.map((word) => {
    if (word.start === null || word.end === null) return word;
    const presence = speechFraction(word.start, word.end, silences);
    const rate = ratePlausibility(codePoints(normalized(word.word)), Math.max(0, word.end - word.start), pace);
    const inOrder = previousEnd === null || word.start >= previousEnd - DERIVED_ORDER_SLACK_S ? 1 : 0;
    previousEnd = word.end;
    return { ...word, score: presence * rate * inOrder };
  });
}

function textSpan(run: readonly AlignedWord[]): TextSpan {
  const timed = run.filter(isTimed);
  const scores = run.map((w) => w.score).filter((s): s is number => s !== null);
  const firstWord = run[0].index;
  const lastWord = run[run.length - 1].index;
  return {
    firstWord,
    lastWord,
    words: lastWord - firstWord + 1,
    text: run.map((w) => w.word).join(' '),
    audioStart: timed.length > 0 ? timed[0].start : null,
    audioEnd: timed.length > 0 ? timed[timed.length - 1].end : null,
    worstScore: scores.length > 0 ? Math.min(...scores) : null,
  };
}

/** Maximal runs of words the audio does not credibly contain, and the audio no placed word covers. */
function spans(words: readonly AlignedWord[], silences: readonly Silence[], duration: number): [TextSpan[], AudioSpan[]] {
  const text: TextSpan[] = [];
  let run: AlignedWord[] = [];
  for (const word of words) {
    if (!isTimed(word) || word.score === null || word.score < SPAN_SCORE_FLOOR) {
      run.push(word);
    } else if (run.length > 0) {
      text.push(textSpan(run));
      run = [];
    }
  }
  if (run.length > 0) text.push(textSpan(run));

  // Timed, not credible: a weak word still claims its audio, so one defect is not reported twice.
  const placed = words.filter(isTimed);
  const audio: AudioSpan[] = [];
  const audioSpan = (start: number, end: number, where: AudioSpan['where']): AudioSpan => ({ start, end, speechFraction: speechFraction(start, end, silences), where });
  let cursor = 0;
  for (const word of placed) {
    if ((word.start as number) - cursor >= MIN_AUDIO_SPAN_S) {
      audio.push(audioSpan(cursor, word.start as number, cursor === 0 ? 'head' : 'interior'));
    }
    cursor = Math.max(cursor, word.end as number);
  }
  if (duration - cursor >= MIN_AUDIO_SPAN_S) audio.push(audioSpan(cursor, duration, placed.length > 0 ? 'tail' : 'head'));
  return [text, audio];
}

/** One of a word's numbers: NaN means nothing was placed here, and infinity means nothing at all. */
function wordNumber(value: number | null, field: string, index: number, word: string, audioPath: string): number | null {
  if (value === null || Number.isNaN(value)) return null;
  if (!Number.isFinite(value)) {
    throw new AlignerError(`${audioPath}: backend 'qwen3' returned ${field}=${value > 0 ? 'inf' : '-inf'} for word ${index} (${pyRepr(word)})`);
  }
  return value;
}

/** Align one chunk's audio against its SPOKEN text. A refusal names the chunk's file. */
export async function alignChunk(
  audioPath: string,
  text: string,
  items: readonly PrecomputedItem[],
  ffmpeg: string,
  signal?: AbortSignal,
): Promise<Alignment> {
  const spoken = pyStrip(pyCollapseSpace(text));
  if (spoken === '') throw new AlignerError(`${audioPath}: the chunk text is empty, so there is nothing to align the audio against`);
  const audio = await decodeAudio(audioPath, ffmpeg, signal);
  const duration = audio.length / SAMPLE_RATE;
  const expected = spoken.split(' ').filter((w) => w !== '');

  const started = performance.now();
  let raw: RawWord[];
  try {
    raw = mapItemsOntoWords(items, expected);
  } catch (refused) {
    if (refused instanceof AlignerError) throw new AlignerError(`${audioPath}: ${refused.message}`);
    throw refused;
  }
  const elapsed = (performance.now() - started) / 1000;

  const placed = raw.map(([word, rawStart, rawEnd], index): AlignedWord => {
    const start = wordNumber(rawStart, 'start', index, word, audioPath);
    const end = wordNumber(rawEnd, 'end', index, word, audioPath);
    if (start !== null && end !== null && end < start) {
      throw new AlignerError(`${audioPath}: backend 'qwen3' placed word ${index} (${pyRepr(word)}) ending ${pyFixed(end, 3)}s before it starts ${pyFixed(start, 3)}s`);
    }
    return { index, word, start, end, score: null };
  });

  const silences = detectSilences(audio);
  // The chunk's own rate: a weaker instrument than a voice's measured pace, measured on the thing scored.
  const pace = duration > 0 ? codePoints(spoken) / duration : 0;
  const words = deriveScores(placed, silences, pace);
  const [unalignedTextSpans, unalignedAudioSpans] = spans(words, silences, duration);
  return { audioPath, text: spoken, duration, words, unalignedTextSpans, unalignedAudioSpans, silences, elapsed, pace };
}

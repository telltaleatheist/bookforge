/**
 * The sentence transcript: the cue, the writer, and the ESTIMATED cue. A port of
 * `narrator/assemble/sentence_vtt.py`.
 *
 * Owen, 2026-09-05: "we need to base assembly on the expected text and the actual real length of
 * the audio." So a chunk nobody aligned still gets cues, laid over its real span in proportion to
 * each sentence's share of its characters, and marked as an estimate in the file itself:
 *
 *     NOTE estimated chunk 41 - the aligner did not place this chunk, so these cue times are ...
 *
 * A NOTE carries no timing, so a reader that scans blocks for `-->` skips it.
 */

import * as fs from 'fs';
import * as path from 'path';

import { pyFixed, pyStrip } from '../py-compat';
import type { Manifest } from '../session/manifest';
import { splitSentences } from '../text/sentences';
import { spoken } from '../text/spoken';
import { chunkSpans, formatTimestamp } from './vtt';

export const SENTENCE_VTT_SUFFIX = '.sentences.vtt';
export const ESTIMATED_NOTE_PREFIX = 'NOTE estimated chunk';
export const QUALITY_NOTE_PREFIX = 'NOTE quality';

export class SentenceVttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SentenceVttError';
  }
}

export interface SentenceCue {
  readonly chunkIndex: number;
  readonly sentenceIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly isHeading: boolean;
  /** Laid proportionally over real audio, because no alignment placed it. */
  readonly estimated: boolean;
  /** A measured cue's report card. Null on an estimate, which measured nothing. */
  readonly quality: Readonly<Record<string, unknown>> | null;
}

export function splitChunkSentences(text: string): string[] {
  return splitSentences(spoken(text));
}

/** Estimated cues for one chunk. Characters, not words: duration tracks them more closely. */
export function proportionalCues(chunkIndex: number, chunkStart: number, chunkEnd: number, text: string, isHeading: boolean): SentenceCue[] {
  const span = chunkEnd - chunkStart;
  if (span <= 0) throw new SentenceVttError(`chunk ${chunkIndex}: the manifest gives it a ${pyFixed(span, 3)}s cue span, so there is no audio to lay cues over`);
  const sentences = splitChunkSentences(text);
  if (sentences.length === 0) return [];
  const weights = sentences.map((s) => Math.max(1, [...pyStrip(s)].length));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const cues: SentenceCue[] = [];
  let elapsed = 0;
  sentences.forEach((sentence, position) => {
    const start = elapsed;
    elapsed += span * (weights[position] / total);
    // The last cue ends on the chunk's own end, or the divisions leave it a microsecond past.
    const end = position === sentences.length - 1 ? span : elapsed;
    cues.push({
      chunkIndex,
      sentenceIndex: position,
      start: chunkStart + start,
      end: chunkStart + end,
      text: sentence,
      // The heading is the first sentence, not the chunk: a merged heading once bolded whole paragraphs.
      isHeading: isHeading && position === 0,
      estimated: true,
      quality: null,
    });
  });
  return cues;
}

export function estimatedCuesForManifest(manifest: Manifest, where = 'estimated_cues_for_manifest', chapterGap = 0): SentenceCue[] {
  return chunkSpans(manifest, where, chapterGap).flatMap(({ chunk, start, end }) => (
    proportionalCues(chunk.index, start, end, chunk.text, chunk.kind === 'heading')
  ));
}

const estimatedNote = (chunkIndex: number): string => (
  `${ESTIMATED_NOTE_PREFIX} ${chunkIndex} - the aligner did not place this chunk, so these cue times are proportional to sentence length over the chunk's real audio.`
);

/** One line, these keys, this order, immediately before the cue: the training side reads it positionally. */
const QUALITY_NOTE_KEYS: ReadonlyArray<readonly [string, string, 'flag' | 'text' | number]> = [
  ['monotonic', 'monotonic', 'flag'],
  ['cps', 'chars_per_sec', 1],
  ['pace_ratio', 'pace_ratio', 2],
  ['boundary_silence', 'boundary_silence_s', 2],
  ['worst', 'worst_word_score', 2],
  ['source', 'score_source', 'text'],
];

function qualityNote(quality: Readonly<Record<string, unknown>>): string {
  const parts = QUALITY_NOTE_KEYS.map(([name, field, how]) => {
    if (!(field in quality)) {
      throw new SentenceVttError(`a cue quality dict is missing '${field}'; the quality NOTE is a fixed set of keys in a fixed order (${QUALITY_NOTE_KEYS.map(([k]) => k).join(', ')})`);
    }
    const value = quality[field];
    if (value === null || value === undefined) return `${name}=none`;
    if (how === 'flag') return `${name}=${value ? 1 : 0}`;
    if (how === 'text') return `${name}=${String(value)}`;
    return `${name}=${pyFixed(value as number, how)}`;
  });
  return `${QUALITY_NOTE_PREFIX} ${parts.join(' ')}`;
}

export function buildSentenceVtt(cues: readonly SentenceCue[]): string {
  if (cues.length === 0) throw new SentenceVttError('build_sentence_vtt(): no cues to write');
  let previousEnd: number | null = null;
  let previousNote: number | null = null;
  const blocks: string[] = [];
  for (const cue of cues) {
    if (cue.end < cue.start) {
      throw new SentenceVttError(`chunk ${cue.chunkIndex} sentence ${cue.sentenceIndex}: cue ends ${pyFixed(cue.end, 3)}s before it starts ${pyFixed(cue.start, 3)}s`);
    }
    if (previousEnd !== null && cue.start < previousEnd - 1e-6) {
      throw new SentenceVttError(`chunk ${cue.chunkIndex} sentence ${cue.sentenceIndex}: cue starts ${pyFixed(cue.start, 3)}s, before the previous cue ended ${pyFixed(previousEnd, 3)}s`);
    }
    previousEnd = cue.end;
    if (cue.estimated && previousNote !== cue.chunkIndex) {
      blocks.push(`${estimatedNote(cue.chunkIndex)}\n`);
      previousNote = cue.chunkIndex;
    } else if (!cue.estimated) {
      previousNote = null;
    }
    if (cue.quality !== null) {
      if (cue.estimated) throw new SentenceVttError(`chunk ${cue.chunkIndex} sentence ${cue.sentenceIndex} is marked estimated AND carries a quality measurement`);
      blocks.push(`${qualityNote(cue.quality)}\n`);
    }
    const text = cue.isHeading && cue.text ? `<b>${cue.text}</b>` : cue.text;
    blocks.push(`${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${text}\n`);
  }
  return `WEBVTT\n\n${blocks.join('\n')}`;
}

export async function writeSentenceVtt(cues: readonly SentenceCue[], file: string): Promise<string> {
  const content = buildSentenceVtt(cues);
  const parent = path.dirname(path.resolve(file));
  const stat = await fs.promises.stat(parent).catch(() => null);
  if (stat === null || !stat.isDirectory()) throw new SentenceVttError(`write_sentence_vtt(): ${parent} is not a directory`);
  await fs.promises.writeFile(file, content, 'utf8');
  return file;
}

const CUE_TIMES = /^(\d+):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d+):(\d{2}):(\d{2})\.(\d{3})\s*$/;

/**
 * The end of the last cue, or null when the file does not answer the question. Never raises, and
 * reads line by line: this is a transcript of a whole book.
 */
export async function lastCueEndSeconds(file: string): Promise<number | null> {
  let last: number | null = null;
  try {
    let partial = '';
    const take = (line: string): void => {
      const m = CUE_TIMES.exec(line.trim());
      if (m) last = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    };
    for await (const piece of fs.createReadStream(file, { encoding: 'utf8' })) {
      const lines = (partial + (piece as string)).split('\n');
      partial = lines.pop() as string;
      lines.forEach(take);
    }
    take(partial);
    return last;
  } catch {
    return null;
  }
}

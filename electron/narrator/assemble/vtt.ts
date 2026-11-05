/**
 * The chunk-level transcript. A port of `narrator/assemble/vtt.py`.
 *
 * The float arithmetic is reproduced rather than improved: a computation from integer samples
 * would be marginally more accurate and would differ in the last digit on some cues. So this is
 * the Python's own floor-division and fixed-point rounding, including its quirk that 59.9996
 * prints as `60.000`.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

import { pyCollapseSpace, pyFixed, pyFloorDiv, pyStrip } from '../py-compat';
import { flatChunks, type Chunk, type Manifest } from '../session/manifest';
import { smlUnspokenPattern } from '../text/sml';

const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');

export function formatTimestamp(seconds: number): string {
  const h = pyFloorDiv(seconds, 3600);
  const m = pyFloorDiv(seconds % 3600, 60);
  const s = seconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pyFixed(s, 3).padStart(6, '0')}`;
}

/** The payload of one cue. The stripping here is the stdlib `re` reading, not the `regex` one. */
export function cueText(text: string, isHeading: boolean): string {
  const stripped = pyStrip(pyCollapseSpace(text.replace(smlUnspokenPattern(), '')));
  return isHeading && stripped ? `<b>${stripped}</b>` : stripped;
}

export interface ChunkSpan {
  readonly chunk: Chunk;
  readonly start: number;
  readonly end: number;
}

/**
 * Every chunk's cue span, in order. THE ONE PLACE the running sum lives, so a sentence cue
 * cannot sit outside its own chunk's cue. The chapter gap has to be in the sum: this file is
 * sealed into the m4b, and a gap missing here slides every later cue early by one per chapter.
 */
export function chunkSpans(manifest: Manifest, where = 'chunk_spans', chapterGap = 0): ChunkSpan[] {
  if (flatChunks(manifest).length === 0) throw new Error(`${where}(): the manifest has no chunks`);
  if (chapterGap < 0) throw new Error(`${where}(): chapter_gap must be >= 0 seconds, got ${chapterGap}`);
  const rate = manifest.sampleRate;
  const spans: ChunkSpan[] = [];
  let current = 0;
  const last = manifest.chapters.length - 1;
  manifest.chapters.forEach((chapter, position) => {
    for (const chunk of chapter.chunks) {
      if (chunk.samples === null) {
        throw new Error(`${where}(): chunk ${chunk.index} has no sample count (${chunk.file}); the book is not fully rendered`);
      }
      const start = current + chunk.gapBefore;
      const end = start + chunk.samples / rate;
      current = end + chunk.gapAfter;
      spans.push({ chunk, start, end });
    }
    if (position !== last) current += chapterGap;
  });
  return spans;
}

export function buildVtt(manifest: Manifest, chapterGap = 0): string {
  const blocks = chunkSpans(manifest, 'build_vtt', chapterGap).map(({ chunk, start, end }) => (
    `${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${cueText(chunk.text, chunk.kind === 'heading')}\n`
  ));
  return `WEBVTT\n\n${blocks.join('\n')}`;
}

/** UTF-8, LF on every platform. */
export async function writeVtt(manifest: Manifest, file: string, chapterGap = 0): Promise<string> {
  const content = buildVtt(manifest, chapterGap);
  const parent = path.dirname(path.resolve(file));
  const stat = await fsp.stat(parent).catch(() => null);
  if (stat === null || !stat.isDirectory()) throw new Error(`write_vtt(): ${parent} is not a directory`);
  await fsp.writeFile(file, content, 'utf8');
  return file;
}

/** The end of the last cue. The gaps count; the last cue does not end after one. */
export function vttDuration(manifest: Manifest, chapterGap = 0): number {
  const rate = manifest.sampleRate;
  let total = 0;
  for (const chunk of flatChunks(manifest)) {
    if (chunk.samples === null) throw new Error(`vtt_duration(): chunk ${chunk.index} has no sample count (${chunk.file})`);
    total += chunk.gapBefore + chunk.samples / rate + chunk.gapAfter;
  }
  if (chapterGap > 0) total += chapterGap * Math.max(0, manifest.chapters.length - 1);
  return total;
}

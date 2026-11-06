/**
 * Per-chapter audio: which chunks, in what order, how long, and the guards. A port of
 * `narrator/assemble/chapters.py`, for an engine that does not pad.
 *
 * Every chunk is faded and every gap realized into the assembly's own work dir, written by one
 * writer, so the concat list is homogeneous by construction. The guard still runs on what goes in:
 * ffmpeg's concat demuxer drops every FLAC frame whose blocksize exceeds the first entry's maximum
 * AND STILL EXITS 0 (Witnesses, 2026: sentences silently missing from a finished book).
 *
 * THE PADDED PATH IS NOT HERE, on the lead's ruling of 2026-11-05: Orpheus is retired and not
 * ported. Every session comes here, and this refuses an Orpheus one by name rather than treating it
 * as anything else.
 *
 * Preparing is I/O, so it runs on a pool bounded by the encoder's `workers`. The order is the
 * serial order: each unit returns its own list, stitched back in chunk order.
 *
 * The chapter gap is not a gap rule. It is silence BETWEEN chapters, recorded on each plan and
 * realized where chapters are joined.
 */

import * as fs from 'fs';
import * as path from 'path';

import { pyFixed } from '../py-compat';
import { assertConcatHomogeneous, checkExpected, readStreaminfo, type StreamInfo } from '../session/flac-header';
import { chunkPath, type Chapter, type Chunk, type Manifest } from '../session/manifest';
import { gapFrames, writeFadedChunk, writeSilence } from './edges';
import { profileFor } from './engine-profiles';
import { AssemblyCancelled } from './ffmpeg-tools';

export interface ChapterPlan {
  readonly index: number;
  readonly title: string;
  readonly doc: string | null;
  readonly paths: string[];
  readonly infos: StreamInfo[];
  readonly firstChunk: number;
  readonly lastChunk: number;
  /** Seconds of silence after this chapter. Zero on the last: a book ends at its last word. */
  gapAfter: number;
  /** `gapAfter` in samples, rounded once so the audio, the markers and the VTT agree. */
  gapSamples: number;
}

/** The chapter's audio. Its concat list already holds the inter-chunk silence; the chapter gap is not in it. */
export const audioSamples = (plan: ChapterPlan): number => plan.infos.reduce((sum, info) => sum + info.samples, 0);
/** Everything a listener moves through: what the markers and the export guard are built from. */
export const planSamples = (plan: ChapterPlan): number => audioSamples(plan) + plan.gapSamples;
export const audioDuration = (plan: ChapterPlan, rate: number): number => audioSamples(plan) / rate;
export const planDuration = (plan: ChapterPlan, rate: number): number => planSamples(plan) / rate;

export const chunkTotal = (manifest: Manifest): number => manifest.chapters.reduce((sum, chapter) => sum + chapter.chunks.length, 0);

export const totalDuration = (plans: readonly ChapterPlan[], rate: number): number => plans.reduce((sum, plan) => sum + planSamples(plan), 0) / rate;

/** `0.5 + 0.01 * n`: the concat demuxer can drop inputs and exit 0, so the output is held to the input's length. */
export const concatTolerance = (fileCount: number): number => 0.5 + 0.01 * fileCount;

/** Nuremberg, 2026-08-11: a 20.12 h source exported as a valid, playable 14.72 h m4b. */
export const EXPORT_TOLERANCE_S = 2.0;

export function checkDuration(actual: number, expected: number, tolerance: number, what: string, file: string): void {
  const delta = actual - expected;
  if (Math.abs(delta) > tolerance) {
    const signed = `${delta >= 0 ? '+' : ''}${pyFixed(delta, 2)}`;
    throw new Error(`${what} duration mismatch -> ${file}: expected ${pyFixed(expected, 2)}s, got ${pyFixed(actual, 2)}s (delta ${signed}s, tolerance +/-${pyFixed(tolerance, 2)}s). ffmpeg exited 0 but the output does not carry all of its input.`);
  }
}

const PREPARE_LOG_INTERVAL_MS = 1000;

type Log = (line: string) => void;

/** `[fn(i) for i in items]` on `workers` at once, results in order, the first failure in order re-raised. */
async function mapOrdered<T, R>(items: readonly T[], workers: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures = new Map<number, unknown>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && failures.size === 0) {
      if (signal?.aborted) return;
      const i = next;
      next += 1;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failures.set(i, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, Math.max(items.length, 1)) }, worker));
  if (signal?.aborted) throw new AssemblyCancelled();
  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}

export interface PlanOptions {
  readonly workDir: string;
  readonly ffmpeg: string;
  readonly log: Log;
  readonly workers: number;
  readonly chapterGap: number;
  readonly signal?: AbortSignal;
}

async function checkChunk(manifest: Manifest, chapter: Chapter, chunk: Chunk): Promise<string> {
  const file = chunkPath(manifest, chunk);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (stat === null || !stat.isFile()) throw new Error(`chapter ${chapter.index} is missing chunk ${chunk.index}: ${file}`);
  if (stat.size === 0) throw new Error(`chapter ${chapter.index} chunk ${chunk.index} is 0 bytes: ${file}`);
  return file;
}

export async function planChapters(manifest: Manifest, options: PlanOptions): Promise<ChapterPlan[]> {
  const { workDir, ffmpeg, log, workers, chapterGap, signal } = options;
  if (manifest.chapters.length === 0) throw new Error('plan_chapters(): the manifest has no chapters');
  if (workers < 1) throw new Error(`plan_chapters(): workers must be >= 1, got ${workers}`);
  if (chapterGap < 0) throw new Error(`plan_chapters(): chapter_gap must be >= 0 seconds, got ${chapterGap}`);
  if (manifest.engine === null || manifest.engine.pads) {
    throw new Error(`this session's engine (${manifest.engine?.id ?? manifest.voice.engine}) pads its own chunks, and that path is not ported: Orpheus is retired. Its finished audiobook is untouched.`);
  }
  profileFor(manifest.engine.id);
  const { in: fadeInMs, out: fadeOutMs } = manifest.engine.edgeFadeMs;
  const rate = manifest.sampleRate;
  const total = chunkTotal(manifest);

  let done = 0;
  let lastLine = Date.now();
  log(`[ASSEMBLE] Preparing sentences 0/${total}`);
  const step = (): void => {
    done += 1;
    const now = Date.now();
    if (done < total && now - lastLine < PREPARE_LOG_INTERVAL_MS) return;
    lastLine = now;
    log(`[ASSEMBLE] Preparing sentences ${done}/${total}`);
  };

  // One silence per length, not one per gap: a book's gaps are nearly all the same length, so
  // listing the one file over and over is thousands of small writes that never happen.
  const silenceDir = path.join(workDir, 's');
  await fs.promises.mkdir(silenceDir, { recursive: true });
  const silences = new Map<number, Promise<{ file: string; info: StreamInfo }>>();
  const silence = async (seconds: number): Promise<{ file: string; info: StreamInfo } | null> => {
    const frames = gapFrames(seconds, rate);
    if (frames <= 0) return null;
    let made = silences.get(frames);
    if (made === undefined) {
      made = (async () => {
        const file = path.join(silenceDir, `${frames}.flac`);
        await writeSilence(file, frames, rate);
        const info = await readStreaminfo(file);
        if (info.samples !== frames) throw new Error(`silence file ${file} holds ${info.samples} samples, expected ${frames}`);
        return { file, info };
      })();
      silences.set(frames, made);
    }
    return made;
  };

  const plans: ChapterPlan[] = [];
  for (const chapter of manifest.chapters) {
    const outDir = path.join(workDir, `e${chapter.index}`);
    await fs.promises.mkdir(outDir, { recursive: true });
    const units = await mapOrdered(chapter.chunks, workers, async (chunk): Promise<Array<{ file: string; info: StreamInfo }>> => {
      const src = await checkChunk(manifest, chapter, chunk);
      const source = checkExpected(await readStreaminfo(src), rate, 1);
      if (chunk.samples !== null && source.samples !== chunk.samples) {
        throw new Error(`chapter ${chapter.index} chunk ${chunk.index}: the manifest records ${chunk.samples} samples but the file holds ${source.samples} - the audio changed after the manifest was built (${src})`);
      }
      const unit: Array<{ file: string; info: StreamInfo }> = [];
      const before = await silence(chunk.gapBefore);
      if (before !== null) unit.push(before);
      const dst = path.join(outDir, `${chunk.index}.flac`);
      const written = await writeFadedChunk(src, dst, rate, source.bitsPerSample, fadeInMs, fadeOutMs, ffmpeg, signal);
      if (written !== source.samples) throw new Error(`edge fade changed chunk ${chunk.index} from ${source.samples} to ${written} samples`);
      const faded = await readStreaminfo(dst);
      if (faded.samples !== source.samples) throw new Error(`faded chunk ${chunk.index} holds ${faded.samples} samples, the source held ${source.samples}`);
      unit.push({ file: dst, info: faded });
      const after = await silence(chunk.gapAfter);
      if (after !== null) unit.push(after);
      step();
      return unit;
    }, signal);
    const paths = units.flat().map((u) => u.file);
    const infos = units.flat().map((u) => u.info);
    assertConcatHomogeneous(infos);
    plans.push({
      index: chapter.index,
      title: chapter.title,
      doc: chapter.doc,
      paths,
      infos,
      firstChunk: chapter.chunks[0].index,
      lastChunk: chapter.chunks[chapter.chunks.length - 1].index,
      gapAfter: 0,
      gapSamples: 0,
    });
  }
  if (chapterGap > 0) {
    const gapSamples = gapFrames(chapterGap, rate);
    // A gap after the last chapter is not a boundary; it is a book that ends in dead air.
    for (const plan of plans.slice(0, -1)) {
      plan.gapAfter = chapterGap;
      plan.gapSamples = gapSamples;
    }
    log(`[assembly] Chapter gap: ${pyFixed(chapterGap, 3)}s (${gapSamples} samples) after each of the first ${plans.length - 1} chapter(s)`);
  }
  return plans;
}

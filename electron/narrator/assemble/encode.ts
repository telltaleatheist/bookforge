/**
 * AAC encoding, chapter atoms, cover art and tags. A port of `narrator/assemble/encode.py`.
 *
 * Codec parameters are part of the contract. A different bitrate is a silent parity failure, so
 * every one is copied: `-c:a aac -b:a 192k -ar 44100 -ac N`, `+faststart+use_metadata_tags`.
 *
 * Two encode paths, one gate. Under 2 hours one serial encode applies loudnorm, which measures the
 * whole file and cannot be split. Above it each chapter encodes alone, and a stream copy joins them.
 *
 * `+use_metadata_tags` carries `year` and `language` into freeform atoms, and it also means the
 * cover cannot be attached by the same ffmpeg call: that muxer path writes no `covr`. So the cover
 * is a second pass over the finished file, through the one tag writer that cannot lose the book.
 */

import * as fs from 'fs';
import * as path from 'path';

import { pyFixed, pyRepr, pyStrip } from '../py-compat';
import { readStreaminfo, type StreamInfo } from '../session/flac-header';
import type { Manifest } from '../session/manifest';
import { smlUnspokenPattern } from '../text/sml';
import { audioDuration, checkDuration, concatTolerance, EXPORT_TOLERANCE_S, type ChapterPlan } from './chapters';
import { gapFrames } from './edges';
import { AssemblyCancelled, FfmpegError, probeDuration, run, writeConcatList } from './ffmpeg-tools';
import { coverItem, ffmpegM4bProbe, setM4bItems } from './m4b-tags';

const FINAL_DENOISE_FILTER = 'afftdn=nr=12:nf=-50:tn=1';
const LOUDNORM_FILTER = 'loudnorm=I=-16:LRA=11:TP=-1.5:linear=true,afftdn=nf=-70';
export const LOUDNORM_CUTOFF_S = 7200;
export const MP4_FAMILY: readonly string[] = ['m4b', 'm4a', 'mp4', 'mov'];
const MOVFLAGS = '+faststart+use_metadata_tags';
const FLAC_SAMPLE_FMT: Readonly<Record<number, string>> = { 16: 's16', 24: 's32' };
const CHANNEL_LAYOUT: Readonly<Record<number, string>> = { 1: 'mono', 2: 'stereo' };

type Log = (line: string) => void;

export function ellipsizeUtf8Bytes(s: string, maxBytes: number, ellipsis = '…'): string {
  if (maxBytes <= 0) return '';
  const raw = Buffer.from(s, 'utf8');
  const e = Buffer.from(ellipsis, 'utf8');
  if (raw.length <= maxBytes) return s;
  // Python decodes with errors='ignore', so a cut character is dropped rather than replaced.
  if (e.length >= maxBytes) return new TextDecoder('utf-8', { fatal: false }).decode(e.subarray(0, maxBytes)).replace(/\ufffd/g, '');
  const budget = maxBytes - e.length;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + ellipsis;
}

export function sanitizeMetaChapterTitle(title: string | null | undefined, maxBytes = 140): string {
  const clean = pyStrip((title ?? '').replace(/\x00/g, '').replace(smlUnspokenPattern(), ''));
  return ellipsizeUtf8Bytes(clean, maxBytes);
}

/** A newline or `;` would end the ffmetadata record and corrupt every chapter after it. */
function escapeMetaValue(value: string, where: string): string {
  if (value.includes('\n') || value.includes('\r') || value.includes(';')) {
    throw new Error(`${where} contains a newline or a ';', which would terminate the ffmetadata record and corrupt every chapter after it: ${pyRepr(value)}`);
  }
  return value.replace(/(^#)|[=\\]|(-$)/g, (m) => `\\${m}`);
}

/** A free-text tag: a publisher's blurb carries both, and refusing would fail a book over a tag. */
function escapeMetaText(value: string, where: string): string {
  if (value.includes('\x00')) throw new Error(`${where} contains a NUL byte: ${pyRepr(value)}`);
  return value.replace(/[=;#\\\n\r]/g, (m) => `\\${m}`);
}

/** The `;FFMETADATA1` document. Boundaries are a running sum of each chapter's whole milliseconds. */
export async function generateFfmpegMetadata(manifest: Manifest, chapterDurationsMs: readonly number[], outputPath: string): Promise<string> {
  if (chapterDurationsMs.length !== manifest.chapters.length) {
    throw new Error(`generate_ffmpeg_metadata(): ${chapterDurationsMs.length} durations for ${manifest.chapters.length} chapters`);
  }
  const { book } = manifest;
  const lines = [';FFMETADATA1'];
  if (book.title) lines.push(`title=${escapeMetaValue(book.title, 'book title')}`);
  if (book.author) lines.push(`artist=${escapeMetaValue(book.author, 'book author')}`);
  if (book.language) lines.push(`language=${escapeMetaValue(book.language, 'language')}`);
  if (book.description) lines.push(`description=${escapeMetaText(book.description, 'book description')}`);
  if (book.publisher) lines.push(`publisher=${escapeMetaText(book.publisher, 'book publisher')}`);
  if (book.year) lines.push(`year=${escapeMetaValue(String(book.year), 'year')}`);
  let start = 0;
  manifest.chapters.forEach((chapter, i) => {
    const title = escapeMetaValue(sanitizeMetaChapterTitle(chapter.title), `chapter ${chapter.index} title`);
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${start + chapterDurationsMs[i]}`, `title=${title}`);
    start += chapterDurationsMs[i];
  });
  await fs.promises.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return outputPath;
}

/** Why the per-chapter encode may NOT stand in for the serial one, or null when it may. */
export function parallelExportUnsupportedReason(outputFormat: string, sourceDuration: number, finalDenoise: boolean): string | null {
  if (!MP4_FAMILY.includes(outputFormat)) return `output format ${outputFormat} is not MP4-family (a naive concat is not gapless there)`;
  if (finalDenoise) return 'FINAL_DENOISE is active and must run once over the whole stream';
  if (!sourceDuration) return 'the total duration is unknown';
  if (sourceDuration <= LOUDNORM_CUTOFF_S) {
    return `the book is ${pyFixed(sourceDuration, 0)}s, at or under the ${LOUDNORM_CUTOFF_S}s cutoff below which loudnorm(linear=true) measures the whole file and cannot be split`;
  }
  return null;
}

const aacArgs = (channels: number): string[] => ['-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', String(channels)];

/** `f'{seconds:.9f}'`, for `-t`. */
const seconds9 = (seconds: number): string => pyFixed(seconds, 9);

/** Silence in the exact FLAC shape `like` is written in, read back field by field: the demuxer takes the stream's parameters from the first entry, and a mismatch costs the gap without a word. */
export async function chapterGapFlac(seconds: number, like: StreamInfo, outPath: string, ffmpeg: string, signal?: AbortSignal): Promise<string> {
  if (seconds <= 0) throw new FfmpegError(`chapter_gap_flac(): ${seconds}s is not a gap`);
  const sampleFmt = FLAC_SAMPLE_FMT[like.bitsPerSample];
  if (sampleFmt === undefined) throw new FfmpegError(`the rendered set is ${like.bitsPerSample} bits per sample (${like.path}) and narrator has no ffmpeg sample format that writes a FLAC at that depth, so the chapter gap cannot be made to match it`);
  const layout = CHANNEL_LAYOUT[like.channels];
  if (layout === undefined) throw new FfmpegError(`the rendered set has ${like.channels} channels (${like.path}); this pipeline renders mono or stereo and the chapter gap has no layout to write for anything else`);
  await run([
    ffmpeg, '-hide_banner', '-nostats', '-v', 'error',
    '-f', 'lavfi', '-i', `anullsrc=r=${like.sampleRate}:cl=${layout}`,
    '-t', seconds9(seconds), '-c:a', 'flac', '-sample_fmt', sampleFmt, '-frame_size', String(like.maxBlocksize),
    '-y', outPath,
  ], `chapter gap -> ${path.basename(outPath)}`, { signal });
  const written = await readStreaminfo(outPath);
  const fields: ReadonlyArray<readonly [keyof StreamInfo, string]> = [['maxBlocksize', 'max blocksize'], ['sampleRate', 'sample rate'], ['channels', 'channel count'], ['bitsPerSample', 'bit depth']];
  for (const [field, label] of fields) {
    if (written[field] !== like[field]) {
      throw new FfmpegError(`the chapter gap was written with a ${label} of ${written[field]} but the rendered set it joins is ${like[field]} (${like.path}). ffmpeg's concat demuxer reads the stream's parameters off the first entry, so this gap would silently not be in the book.`);
    }
  }
  const wanted = gapFrames(seconds, like.sampleRate);
  if (written.samples !== wanted) throw new FfmpegError(`the chapter gap holds ${written.samples} samples, not the ${wanted} that ${seconds}s is at ${like.sampleRate} Hz - the audio and the transcript would disagree`);
  return outPath;
}

export async function chapterGapM4a(seconds: number, outPath: string, channels: number, ffmpeg: string, signal?: AbortSignal): Promise<string> {
  if (seconds <= 0) throw new FfmpegError(`chapter_gap_m4a(): ${seconds}s is not a gap`);
  const layout = CHANNEL_LAYOUT[channels];
  if (layout === undefined) throw new FfmpegError(`the chapters are being encoded with ${channels} channels; this pipeline encodes mono or stereo and the chapter gap has no layout to write for anything else`);
  await run([
    ffmpeg, '-hide_banner', '-nostats', '-v', 'error',
    '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=${layout}`,
    '-t', seconds9(seconds), ...aacArgs(channels), '-movflags', MOVFLAGS,
    '-y', outPath,
  ], `chapter gap -> ${path.basename(outPath)}`, { signal });
  const stat = await fs.promises.stat(outPath).catch(() => null);
  if (stat === null || stat.size === 0) throw new FfmpegError(`the chapter gap encode exited 0 but produced no output: ${outPath}`);
  return outPath;
}

/** `paths` with the gap after every chapter whose plan asks for one, so the list cannot disagree with the numbers. */
export function interleaveGaps(paths: readonly string[], plans: readonly ChapterPlan[], gapPath: string): string[] {
  if (paths.length !== plans.length) throw new FfmpegError(`interleave_gaps(): ${paths.length} chapter file(s) for ${plans.length} chapter plan(s)`);
  return paths.flatMap((file, i) => (plans[i].gapAfter > 0 ? [file, gapPath] : [file]));
}

/** The finished file's cover. Through the tag writer, so a crash here cannot cost the book. */
async function attachCover(outPath: string, cover: string | null, ffmpeg: string, ffprobe: string, log: Log, signal?: AbortSignal): Promise<void> {
  if (!cover) return;
  const data = await fs.promises.readFile(cover).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') throw new FfmpegError(`cover image not found: ${cover}`);
    throw err;
  });
  log(`[assembly] Adding cover ${cover} into the final audiobook file`);
  await setM4bItems(outPath, [coverItem(data, cover)], { probe: ffmpegM4bProbe(ffmpeg, ffprobe), signal });
}

/** ffmpeg's `out_time_us`, or its `out_time_ms`, which is microseconds despite the name. */
function positionOf(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
  return m === null ? null : Number(m[1]) / 1_000_000;
}

async function encodeChapter(ffmpeg: string, concatList: string, outPath: string, channels: number, onPosition: (seconds: number) => void, signal?: AbortSignal): Promise<void> {
  await run([
    ffmpeg, '-hide_banner', '-nostats', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', concatList,
    ...aacArgs(channels),
    '-progress', 'pipe:1', '-y', outPath,
  ], `chapter encode -> ${path.basename(outPath)}`, {
    signal,
    onLine: (line) => {
      const position = positionOf(line);
      if (position !== null) onPosition(position);
    },
  });
  const stat = await fs.promises.stat(outPath).catch(() => null);
  if (stat === null || stat.size === 0) throw new FfmpegError(`chapter encode exited 0 but produced no output: ${outPath}`);
}

export interface EncodeTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly log: Log;
  readonly signal?: AbortSignal;
}

/** Every chapter, concurrently. Returns the audio paths in chapter order. */
export async function encodeChaptersParallel(plans: readonly ChapterPlan[], workDir: string, rate: number, channels: number, workers: number, tools: EncodeTools): Promise<string[]> {
  const { ffmpeg, ffprobe, log, signal } = tools;
  const outputs = new Array<string | null>(plans.length).fill(null);
  const todo = plans.map((plan, i): [number, ChapterPlan] => [i, plan]);
  log(`[assembly] Parallel encode: ${todo.length} chapters across ${workers} workers`);

  // Where the encode is, in audio, summed across workers: a row that moved only when a whole
  // chapter finished had nothing to time between them (Owen, 2026-09-22).
  const lengths = new Map(todo.map(([i, plan]) => [i, audioDuration(plan, rate)]));
  const totalSeconds = [...lengths.values()].reduce((sum, v) => sum + v, 0);
  const written = new Map(todo.map(([i]) => [i, 0]));
  let lastPct = -1;
  const report = (i: number, seconds: number): void => {
    if (totalSeconds <= 0) return;
    written.set(i, Math.min(seconds, lengths.get(i) as number));
    const pct = Math.min(100, ([...written.values()].reduce((sum, v) => sum + v, 0) / totalSeconds) * 100);
    if (pct - lastPct < 0.5) return;
    lastPct = pct;
    log(`Export - ${pyFixed(pct, 1)}%`);
  };

  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      if (signal?.aborted) throw new AssemblyCancelled();
      const [i, plan] = todo[next];
      next += 1;
      const listPath = path.join(workDir, `${plan.index}.txt`);
      const outPath = path.join(workDir, `${plan.index}.m4a`);
      try {
        await writeConcatList(plan.paths, listPath);
        await encodeChapter(ffmpeg, listPath, outPath, channels, (seconds) => report(i, seconds), signal);
        const actual = await probeDuration(outPath, ffprobe, signal);
        // concat_tolerance: the question is whether all N files reached the encoder, which scales with N.
        checkDuration(actual, audioDuration(plan, rate), concatTolerance(plan.paths.length), `chapter ${plan.index} encode`, outPath);
        outputs[i] = outPath;
        report(i, lengths.get(i) as number);
      } catch (err) {
        if (err instanceof AssemblyCancelled) throw err;
        failures.push(`chapter ${plan.index}: ${(err as Error).message}`);
      }
    }
  };
  // Settled, not raced: a cancel must wait for every ffmpeg to die before anything touches their files.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, Math.max(todo.length, 1)) }, worker));
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  if (failures.length === 0) log('Export - 100.0%');
  if (failures.length > 0) throw new FfmpegError(`${failures.length} chapter encode(s) failed:\n  ${failures.slice(0, 10).join('\n  ')}`);
  const missing = plans.filter((_, i) => outputs[i] === null).map((plan) => plan.index);
  if (missing.length > 0) throw new FfmpegError(`no encoded audio for chapter(s) [${missing.join(', ')}]`);
  return outputs as string[];
}

/** Stream-copy the encoded chapters together with the chapter atoms and tags, then the cover. */
export async function concatEncoded(chapterPaths: readonly string[], plans: readonly ChapterPlan[], metadataFile: string, cover: string | null, outPath: string, workDir: string, channels: number, tools: EncodeTools): Promise<void> {
  const { ffmpeg, ffprobe, log, signal } = tools;
  let entries = [...chapterPaths];
  const gapPlan = plans.find((plan) => plan.gapAfter > 0);
  if (gapPlan !== undefined) {
    const gapPath = await chapterGapM4a(gapPlan.gapAfter, path.join(workDir, 'chapter-gap.m4a'), channels, ffmpeg, signal);
    entries = interleaveGaps(chapterPaths, plans, gapPath);
    log(`[assembly] ${entries.length - chapterPaths.length} chapter gap(s) of ${pyFixed(gapPlan.gapAfter, 3)}s between the encoded chapters`);
  }
  const list = await writeConcatList(entries, path.join(workDir, 'concat_list_encoded.txt'));
  log('[assembly] Concatenating encoded chapters (stream copy)');
  await run([
    ffmpeg, '-hide_banner', '-nostats', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-f', 'ffmetadata', '-i', metadataFile,
    '-map', '0:a', '-c:a', 'copy',
    '-map_metadata', '1',
    '-movflags', MOVFLAGS,
    '-threads', '0',
    '-y', outPath,
  ], 'final concat', { signal });
  await attachCover(outPath, cover, ffmpeg, ffprobe, log, signal);
}

/** One encode of the whole book, with e2a's filter chain. The silence between chapters has to be one of the FLACs, in the set's own shape. */
export async function encodeSerial(plans: readonly ChapterPlan[], metadataFile: string, cover: string | null, outPath: string, workDir: string, channels: number, sourceDuration: number, finalDenoise: boolean, tools: EncodeTools): Promise<void> {
  const { ffmpeg, ffprobe, log, signal } = tools;
  let gapPath: string | null = null;
  const gapPlan = plans.find((plan) => plan.gapAfter > 0);
  if (gapPlan !== undefined) {
    gapPath = await chapterGapFlac(gapPlan.gapAfter, plans[0].infos[0], path.join(workDir, 'chapter-gap.flac'), ffmpeg, signal);
    log(`[assembly] Chapter gap: ${pyFixed(gapPlan.gapAfter, 3)}s of silence between chapters, written at blocksize ${plans[0].infos[0].maxBlocksize}`);
  }
  const allPaths: string[] = [];
  for (const plan of plans) {
    allPaths.push(...plan.paths);
    if (gapPath !== null && plan.gapAfter > 0) allPaths.push(gapPath);
  }
  const list = await writeConcatList(allPaths, path.join(workDir, 'concat_list_sentences.txt'));

  const preFilters: string[] = [];
  if (finalDenoise) {
    log(`[assembly] FINAL_DENOISE active: ${FINAL_DENOISE_FILTER}`);
    preFilters.push(FINAL_DENOISE_FILTER);
  }
  let filters = preFilters;
  if (sourceDuration > LOUDNORM_CUTOFF_S) {
    log(`[assembly] Skipping loudnorm for a long audiobook (${pyFixed(sourceDuration / 3600, 1)} hours) to avoid measuring it in memory`);
  } else {
    filters = [...preFilters, LOUDNORM_FILTER];
  }
  const cmd = [
    ffmpeg, '-hide_banner', '-nostats',
    '-thread_queue_size', '1024',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-f', 'ffmetadata', '-i', metadataFile,
    '-map', '0:a',
    ...aacArgs(channels),
    '-movflags', MOVFLAGS,
    '-map_metadata', '1',
    ...(filters.length > 0 ? ['-filter_threads', '0', '-af', filters.join(',')] : []),
    '-threads', '0', '-progress', 'pipe:1', '-y', outPath,
  ];
  let lastPct = -1;
  await run(cmd, 'serial encode', {
    signal,
    onLine: (line) => {
      const position = positionOf(line);
      if (position === null || sourceDuration <= 0) return;
      const pct = Math.min(100, (position / sourceDuration) * 100);
      if (pct - lastPct >= 0.5) {
        lastPct = pct;
        log(`Export - ${pyFixed(pct, 1)}%`);
      }
    },
  });
  log('Export - 100.0%');
  await attachCover(outPath, cover, ffmpeg, ffprobe, log, signal);
}

/** Exit 0 and a file prove nothing: ffmpeg can finalize a valid, playable, truncated m4b. */
export async function verifyExport(outPath: string, sourceDuration: number, ffprobe: string, signal?: AbortSignal): Promise<number> {
  const stat = await fs.promises.stat(outPath).catch(() => null);
  if (stat === null || stat.size === 0) throw new FfmpegError(`${path.basename(outPath)} is missing or empty: ${outPath}`);
  const actual = await probeDuration(outPath, ffprobe, signal);
  checkDuration(actual, sourceDuration, EXPORT_TOLERANCE_S, 'export', outPath);
  return actual;
}

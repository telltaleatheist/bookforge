/**
 * `assemble()`: a manifest in, one m4b and one VTT in `outputDir`. A port of
 * `narrator/assemble/run.py`.
 *
 * What lands in `outputDir` is exactly `<final_name>.m4b` and `<final_name>.vtt`. The shared stem
 * is load-bearing: the bridge pairs the sidecar to the book by it, and promotes every regular file
 * there into the user's folder. So the sentence transcript goes beside the session instead.
 *
 * The working directory is local scratch: every small write over SMB is a round trip, and building
 * the book on the share makes faststart's second pass crawl (Pursuit of Power, 2.7 GB, 1.4 MB/s,
 * half an hour saying nothing). Removed on success, kept on failure because then it is the evidence.
 *
 * The log lines are the ones the bridges already parse.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { renameWithRetry } from '../../fs-retry';
import { pyCollapseSpace, pyFixed, pyRoundHalfEven } from '../py-compat';
import { validate, type Manifest } from '../session/manifest';
import { chunkTotal, planChapters, planDuration, totalDuration, type ChapterPlan } from './chapters';
import { checkCoverage } from './coverage-gate';
import {
  concatEncoded, encodeChaptersParallel, encodeSerial, generateFfmpegMetadata, MP4_FAMILY,
  parallelExportUnsupportedReason, verifyExport,
} from './encode';
import { FfmpegError } from './ffmpeg-tools';
import {
  estimatedCuesForManifest, lastCueEndSeconds, SENTENCE_VTT_SUFFIX, SentenceVttError, writeSentenceVtt,
} from './sentence-vtt';
import { vttDuration, writeVtt } from './vtt';

const WORK_DIR_PREFIX = 'narrator-asm-';
const HAND_OVER_BLOCK_BYTES = 8 * 1024 * 1024;
/** A genuine measurement differs from this assembly's length only by the aligner's rounding of the last word. */
const STALE_TRANSCRIPT_EPSILON_S = 1.0;

type Log = (line: string) => void;

export interface AssembleOptions {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly workers?: number;
  readonly log: Log;
  readonly outputFormat?: string;
  readonly channels?: number;
  readonly coverageReport?: string | null;
  readonly chapterGap?: number;
  /** `FINAL_DENOISE=1` in the Python. */
  readonly finalDenoise?: boolean;
  readonly signal?: AbortSignal;
}

export interface AssembleResult {
  readonly m4bPath: string;
  readonly vttPath: string;
  readonly durationS: number;
  readonly chapterCount: number;
}

/** `Working Towards The Fuhrer. Ian Kershaw. (1993).m4b` to `Working_Towards_The_Fuhrer._Ian_Kershaw._1993_.m4b`. */
export function getSanitized(value: string, replacement = '_'): string {
  const spaced = pyCollapseSpace(value.replace(/&/g, 'And'), replacement);
  const clean = spaced.replace(/[<>:"/\\|?*\x00-\x1F ()]/g, replacement);
  return clean.replace(/^_+|_+$/g, '');
}

/** The session's own `final_name` is not used: assembly recomputes it from the metadata. */
export function finalName(manifest: Manifest, outputFormat = 'm4b'): string {
  const title = manifest.book.title || 'Untitled';
  const author = manifest.book.author || '';
  const year = manifest.book.year || '';
  let base = title;
  if (author && year) base = `${title}. ${author}. (${year})`;
  else if (author) base = `${title}. ${author}`;
  return getSanitized(`${base}.${outputFormat}`);
}

/** A rename on one volume, otherwise one sequential copy under a temporary name, checked whole and renamed into place. */
async function handOver(localPath: string, finalPath: string, log: Log, signal?: AbortSignal): Promise<void> {
  try {
    await renameWithRetry(localPath, finalPath);
    log('[assembly] The audiobook is in the output folder');
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  const total = (await fs.promises.stat(localPath)).size;
  const partial = `${finalPath}.partial`;
  log(`[assembly] Copying the finished audiobook to the output folder (${pyFixed(total / 1e9, 2)} GB)`);
  let copied = 0;
  let nextReport = 0.05;
  const source = await fs.promises.open(localPath, 'r');
  const target = await fs.promises.open(partial, 'w');
  try {
    const block = Buffer.allocUnsafe(HAND_OVER_BLOCK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(block, 0, HAND_OVER_BLOCK_BYTES);
      if (bytesRead === 0) break;
      await target.write(block, 0, bytesRead);
      copied += bytesRead;
      if (total > 0 && copied / total >= nextReport) {
        log(`[assembly] Copying to the output folder: ${pyFixed((copied / total) * 100, 0)}% (${pyFixed(copied / 1e9, 2)} of ${pyFixed(total / 1e9, 2)} GB)`);
        nextReport += 0.05;
      }
    }
  } finally {
    await source.close();
    await target.close();
  }
  const landed = (await fs.promises.stat(partial)).size;
  if (landed !== total) {
    throw new FfmpegError(`the finished audiobook did not copy to the output folder whole: ${landed} of ${total} bytes at ${partial}. The complete file is still at ${localPath}.`);
  }
  await renameWithRetry(partial, finalPath);
  log('[assembly] The audiobook is in the output folder');
}

/** A cleanup failure is not an assembly failure: the book is already written and verified. */
async function removeWorkDir(workDir: string, log: Log): Promise<void> {
  try {
    await fs.promises.rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch {
    log(`[assembly] Note: could not remove the working directory ${workDir} (a file in it is still held open). The audiobook is complete and verified; the directory can be deleted by hand.`);
  }
}

/**
 * The transcript for a book nobody aligned, beside the session. It never replaces a measurement OF
 * THIS AUDIO, and a cue cannot end after the audio does: Shift re-assembled from a trimmed set
 * (18.47 h to 16.36 h) once kept the 18.47 h transcript. It never stops the assembly.
 */
export async function writeEstimatedSentenceVtt(manifest: Manifest, stem: string, log: Log, chapterGap = 0): Promise<string | null> {
  const file = path.join(manifest.source.processDir, stem + SENTENCE_VTT_SUFFIX);
  const present = await fs.promises.stat(file).catch(() => null);
  if (present?.isFile()) {
    const bookSeconds = vttDuration(manifest, chapterGap);
    const lastCue = await lastCueEndSeconds(file);
    if (lastCue === null || lastCue <= bookSeconds + STALE_TRANSCRIPT_EPSILON_S) {
      log(`[coverage] a sentence transcript is already beside the session (${file}); leaving the measured one alone`);
      return null;
    }
    log(`[coverage] the sentence transcript beside the session (${file}) ends at ${pyFixed(lastCue, 2)}s, and this assembly is ${pyFixed(bookSeconds, 2)}s long - it measured DIFFERENT audio (a --sentences_dir override changes chunk durations), so it is being replaced with an estimate for the audio actually being assembled. The measured file is not recoverable from here; re-run \`narrator align\` against the finished book to measure this one.`);
  }
  try {
    const cues = estimatedCuesForManifest(manifest, 'assemble', chapterGap);
    if (cues.length === 0) {
      log('[coverage] this book has no spoken chunk to cue, so no sentence transcript was written');
      return null;
    }
    await writeSentenceVtt(cues, file);
    log(`[coverage] ${cues.length} ESTIMATED sentence cue(s) -> ${file} (expected text over each chunk's real audio; nothing aligned this book)`);
    return file;
  } catch (refused) {
    if (!(refused instanceof SentenceVttError)) throw refused;
    log(`[coverage] the estimated sentence transcript could not be written (${refused.message}). The audiobook is unaffected.`);
    return null;
  }
}

export async function assemble(manifest: Manifest, outputDirIn: string, options: AssembleOptions): Promise<AssembleResult> {
  const { log, signal } = options;
  const outputFormat = options.outputFormat ?? 'm4b';
  const chapterGap = options.chapterGap ?? 0;

  validate(manifest);
  // Before a single ffmpeg, so the audit is at the top of the job log rather than an hour down.
  const coverage = await checkCoverage(manifest, options.coverageReport ?? null, log);
  if (!MP4_FAMILY.includes(outputFormat)) {
    throw new FfmpegError(`narrator assembles the MP4 family only (${MP4_FAMILY.join(', ')}); '${outputFormat}' was e2a's serial-only path and is not ported`);
  }
  const workers = options.workers ?? Math.max(1, Math.min(os.cpus().length, 16));
  if (workers < 1) throw new Error(`workers must be >= 1, got ${workers}`);
  if (chapterGap < 0) throw new Error(`chapter_gap must be >= 0 seconds, got ${chapterGap}`);

  const outputDir = path.resolve(outputDirIn);
  await fs.promises.mkdir(outputDir, { recursive: true });
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), WORK_DIR_PREFIX));
  log(`[assembly] Working directory: ${workDir}`);
  try {
    return await assembleInto(manifest, outputDir, workDir, options, coverage !== null);
  } catch (err) {
    // A failure's work dir is the evidence. A cancel's is only a book's worth of scratch.
    if (signal?.aborted) await removeWorkDir(workDir, log);
    throw err;
  }
}

async function assembleInto(manifest: Manifest, outputDir: string, workDir: string, options: AssembleOptions, measured: boolean): Promise<AssembleResult> {
  const { ffmpeg, ffprobe, log, signal } = options;
  const outputFormat = options.outputFormat ?? 'm4b';
  const channels = options.channels ?? 1;
  const chapterGap = options.chapterGap ?? 0;
  const finalDenoise = options.finalDenoise ?? false;
  const workers = options.workers ?? Math.max(1, Math.min(os.cpus().length, 16));

  log(`[ASSEMBLE] Assembling all ${manifest.chapters.length} chapters...`);
  const prepareStarted = Date.now();
  const plans = await planChapters(manifest, { workDir, ffmpeg, log, workers, chapterGap, signal });
  log(`[ASSEMBLE] Prepared ${chunkTotal(manifest)} sentences in ${pyFixed((Date.now() - prepareStarted) / 1000, 1)}s`);
  for (const plan of plans) log(`[ASSEMBLE] Chapter ${plan.index}: sentences ${plan.firstChunk}-${plan.lastChunk}`);
  const rate = manifest.sampleRate;
  const sourceDuration = totalDuration(plans, rate);
  log('Assemble completed!');

  const reason = parallelExportUnsupportedReason(outputFormat, sourceDuration, finalDenoise);

  const name = finalName(manifest, outputFormat);
  const stem = name.slice(0, name.length - path.extname(name).length);
  const m4bPath = path.join(outputDir, name);
  const vttPath = path.join(outputDir, `${stem}.vtt`);
  const localM4b = path.join(workDir, name);

  log('[ASSEMBLE] Creating VTT subtitle file...');
  await writeVtt(manifest, vttPath, chapterGap);
  if (!measured) {
    await writeEstimatedSentenceVtt(manifest, stem, log, chapterGap);
  } else if (chapterGap > 0) {
    log(`[coverage] this book has a MEASURED sentence transcript; it is used as written. This assembly leaves ${pyFixed(chapterGap, 3)}s between chapters, so the transcript is correct only if \`narrator align\` was given the same --chapter-gap.`);
  }

  const metadataFile = await generateFfmpegMetadata(
    manifest,
    // The chapter gap belongs to the chapter it follows, so seeking to a chapter never starts on silence.
    plans.map((plan) => pyRoundHalfEven(planDuration(plan, rate) * 1000)),
    path.join(workDir, 'metadata.txt'),
  );

  log('[ASSEMBLE] Combining chapters into final audiobook...');
  const tools = { ffmpeg, ffprobe, log, signal };
  if (reason === null) {
    const chapterPaths = await encodeChaptersParallel(plans, workDir, rate, channels, workers, tools);
    await concatEncoded(chapterPaths, plans, metadataFile, manifest.book.cover, localM4b, workDir, channels, tools);
  } else {
    log(`[assembly] Serial encode: ${reason}`);
    await encodeSerial(plans, metadataFile, manifest.book.cover, localM4b, workDir, channels, sourceDuration, finalDenoise, tools);
  }

  const durationS = await verifyExport(localM4b, sourceDuration, ffprobe, signal);
  await handOver(localM4b, m4bPath, log, signal);
  // Only once the result has passed the guard: if it failed, these are the evidence.
  await removeWorkDir(workDir, log);
  return { m4bPath, vttPath, durationS, chapterCount: plans.length };
}


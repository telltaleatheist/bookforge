/**
 * Measure a rendered session from a Crucible `align` artifact, and write the sentence VTT and the
 * coverage report. A port of the `--alignment` half of `narrator/align/run.py`: the model ran on a
 * server's card, so nothing is loaded here and the audio is decoded for silences and scores.
 *
 * THE RUN ALWAYS AUDITS THE WHOLE BOOK (Owen, 2026-09-05). A chunk that cannot be placed is recorded
 * by name and cued by the proportional estimate, marked as one in the VTT. It does not stop the pass.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';

import { pyFixed, pyJsonDumpsAscii, pyRepr } from '../py-compat';
import { profileFor } from '../assemble/engine-profiles';
import { proportionalCues, SentenceVttError, writeSentenceVtt, type SentenceCue } from '../assemble/sentence-vtt';
import { chunkSpans } from '../assemble/vtt';
import type { Chunk, Manifest } from '../session/manifest';
import { spoken } from '../text/spoken';
import { alignChunk, AlignerError, precomputedItems, pyIntOf, SCORE_SOURCE, type Alignment } from './aligner';
import { coverageDocument, evaluateChunk, type AlignError, type ChunkCoverage, type CoverageDocument, type SkippedChunk } from './coverage';
import { sentenceCues } from './sentences';

/** A remote aligner's declared engine, and the backend whose scoring rules its items are read under. */
const BACKEND_BY_REMOTE_ENGINE: Readonly<Record<string, string>> = { 'qwen3-forced-aligner': 'qwen3' };
/** Where the pass says it runs. The items say where they were made; this decode is on the CPU. */
const DEVICE = 'cpu';
const PROGRESS_EVERY = 10;

type Log = (line: string) => void;
type AlignmentDocument = Record<string, unknown>;

export interface AlignOptions {
  readonly language: string;
  readonly ffmpeg: string;
  readonly chapterGap: number;
  readonly alignment: AlignmentDocument;
  readonly log: Log;
  readonly signal?: AbortSignal;
}

export interface AlignResult {
  readonly document: CoverageDocument;
  readonly cues: SentenceCue[];
}

export function backendForAlignment(document: AlignmentDocument): string {
  const engine = document['engine'];
  if (typeof engine !== 'string' || engine === '') {
    throw new AlignerError('this alignment document names no `engine`, so there is no way to know how its items are scored. It is not an artifact this build can read.');
  }
  if (!Object.prototype.hasOwnProperty.call(BACKEND_BY_REMOTE_ENGINE, engine)) {
    throw new AlignerError(
      `this alignment document was made by ${pyRepr(engine)}, which this build has no scoring rule for (known: ${Object.keys(BACKEND_BY_REMOTE_ENGINE).sort().join(', ')}). `
      + "Reading it under another backend's rules would label its scores wrongly.",
    );
  }
  return BACKEND_BY_REMOTE_ENGINE[engine];
}

function itemsByIndex(document: AlignmentDocument): Map<number, unknown> {
  const chunks = document['chunks'];
  if (!Array.isArray(chunks)) throw new AlignerError('this alignment document has no `chunks` list, so it holds no items to align with.');
  const out = new Map<number, unknown>();
  chunks.forEach((chunk: unknown, position) => {
    const row = chunk as Record<string, unknown> | null;
    if (typeof row !== 'object' || row === null || Array.isArray(row) || !Object.prototype.hasOwnProperty.call(row, 'index')) {
      throw new AlignerError(`chunk ${position} of this alignment document carries no \`index\`, so there is no saying which of the session's chunks it is about.`);
    }
    const index = pyIntOf(row['index']);
    if (index === null) throw new AlignerError(`chunk ${position} of this alignment document has index ${pyRepr(row['index'])}, which is not a number.`);
    if (out.has(index)) throw new AlignerError(`this alignment document holds chunk ${index} twice; there is no saying which of the two the audio was placed against.`);
    out.set(index, Object.prototype.hasOwnProperty.call(row, 'items') ? row['items'] : null);
  });
  return out;
}

interface Job {
  readonly chunk: Chunk;
  readonly start: number;
  readonly end: number;
  readonly audioPath: string;
  readonly text: string;
}

type JobResult = { readonly ok: true; readonly alignment: Alignment } | { readonly ok: false; readonly error: string };

/** A document with none of this session's chunks was written about a different book, and is refused. */
async function fromAlignment(jobs: readonly Job[], document: AlignmentDocument, options: AlignOptions): Promise<JobResult[]> {
  const { log, ffmpeg, signal } = options;
  const items = itemsByIndex(document);
  const device = document['device'];
  const wanted = jobs.map((job) => job.chunk.index);
  const present = wanted.filter((index) => items.has(index));
  if (wanted.length > 0 && present.length === 0) {
    throw new AlignerError(`this alignment document holds ${items.size} chunk(s) and not one of them is a chunk of this session (it wants ${wanted[0]}..${wanted[wanted.length - 1]}). It was made for a different render.`);
  }
  const engineName = Object.prototype.hasOwnProperty.call(document, 'engine') ? document['engine'] : '?';
  log(`[align] reading items from a ${engineName} alignment made on ${typeof device === 'string' && device !== '' ? device : 'an unnamed device'} — ${present.length}/${wanted.length} chunk(s) covered; the audio is decoded here for silences and scores`);

  const out: JobResult[] = [];
  for (const job of jobs) {
    const index = job.chunk.index;
    try {
      if (!items.has(index)) throw new AlignerError(`the alignment document carries no chunk ${index}, so this chunk was never placed against its audio.`);
      const rows = items.get(index);
      if (!Array.isArray(rows)) throw new AlignerError(`chunk ${index} of the alignment document carries no items list, so there is nothing to place its words with.`);
      out.push({ ok: true, alignment: await alignChunk(job.audioPath, job.text, precomputedItems(rows, index), ffmpeg, signal) });
    } catch (refused) {
      if (!(refused instanceof AlignerError)) throw refused;
      out.push({ ok: false, error: refused.message });
    }
    // The wording is a contract: `electron/coverage-align-job.ts` reads it to move the row's bar.
    if (out.length % PROGRESS_EVERY === 0 || out.length === jobs.length) log(`[align] aligned ${out.length}/${jobs.length} chunk(s)`);
  }
  return out;
}

/**
 * Do this chunk's measured cues survive a sanity check? Null means yes. The model never refuses: it
 * PLACES a window whose text differs from the speech, so this looks at what it was handed.
 */
export function gateRefusal(measured: readonly SentenceCue[], chunkIndex: number): string | null {
  for (let position = 1; position < measured.length; position += 1) {
    if (measured[position].start === measured[position - 1].start) {
      return `gate/collapse: sentences ${position - 1} and ${position} of chunk ${chunkIndex} were both placed at ${pyFixed(measured[position].start, 3)}s, so one of them has no audio of its own`;
    }
  }
  for (const cue of measured) {
    if (cue.quality === null) return `gate/order: chunk ${chunkIndex} sentence ${cue.sentenceIndex} carries no quality measurement, so nothing here can judge it`;
    if (!cue.quality['monotonic']) {
      return `gate/order: chunk ${chunkIndex} sentence ${cue.sentenceIndex} has words the aligner placed out of order, so its cue is not a reading of this sentence`;
    }
  }
  return null;
}

/** Record one chunk's failure by name, and cue it from its own audio anyway. */
function estimate(chunk: Chunk, start: number, end: number, stage: string, message: string, cues: SentenceCue[], errors: AlignError[], log: Log): void {
  errors.push({ index: chunk.index, stage, error: message });
  log(`[align] chunk ${chunk.index} FAILED at ${stage}: ${message}`);
  try {
    const estimated = proportionalCues(chunk.index, start, end, chunk.text, chunk.kind === 'heading');
    cues.push(...estimated);
    log(`[align] chunk ${chunk.index}: ${estimated.length} ESTIMATED cue(s) over its ${pyFixed(end - start, 2)}s of audio`);
  } catch (refused) {
    if (!(refused instanceof SentenceVttError)) throw refused;
    errors.push({ index: chunk.index, stage: 'estimate', error: refused.message });
    log(`[align] chunk ${chunk.index} could not even be estimated: ${refused.message}`);
  }
}

export async function alignSession(manifest: Manifest, options: AlignOptions): Promise<AlignResult> {
  const { log, alignment, language, chapterGap } = options;
  const backend = backendForAlignment(alignment);
  const engine = manifest.engine !== null ? manifest.engine.id : manifest.voice.engine;
  const policy = profileFor(engine).coverage;
  const spans = chunkSpans(manifest, 'align', chapterGap);

  // A marker-only chunk carries silence by design. It is counted, and it is not a failure.
  const jobs: Job[] = [];
  const skipped: SkippedChunk[] = [];
  for (const { chunk, start, end } of spans) {
    const text = spoken(chunk.text);
    if (text === '') {
      skipped.push({ index: chunk.index, reason: 'no spoken text', text: chunk.text });
      continue;
    }
    // os.path.join's spelling, because the report and the refusals quote this path.
    const processDir = manifest.source.processDir;
    const audioPath = path.isAbsolute(chunk.file) ? chunk.file : /[\\/]$/.test(processDir) ? processDir + chunk.file : `${processDir}${path.sep}${chunk.file}`;
    jobs.push({ chunk, start, end, audioPath, text });
  }
  log(`[align] ${jobs.length} chunk(s) to align, ${skipped.length} marker-only chunk(s) skipped; engine ${engine}, backend ${backend}, device ${DEVICE}, scores ${SCORE_SOURCE}, audited=${policy.audited ? 'True' : 'False'}`);
  if (jobs.length === 0) throw new AlignerError('every selected chunk is marker-only; there is nothing to align');

  const results = await fromAlignment(jobs, alignment, options);

  const cues: SentenceCue[] = [];
  const coverages: ChunkCoverage[] = [];
  const errors: AlignError[] = [];
  jobs.forEach(({ chunk, start, end }, position) => {
    const result = results[position];
    if (!result.ok) {
      estimate(chunk, start, end, 'align', result.error, cues, errors, log);
      return;
    }
    coverages.push(evaluateChunk(result.alignment, policy, chunk.index));
    let measured: SentenceCue[];
    try {
      measured = sentenceCues(result.alignment, chunk.index, start, end, chunk.kind === 'heading', chunk.text);
    } catch (refused) {
      if (!(refused instanceof AlignerError)) throw refused;
      estimate(chunk, start, end, 'cues', refused.message, cues, errors, log);
      return;
    }
    const refusal = gateRefusal(measured, chunk.index);
    if (refusal !== null) {
      estimate(chunk, start, end, 'gate', refusal, cues, errors, log);
      return;
    }
    cues.push(...measured);
  });
  cues.sort((a, b) => a.start - b.start || a.chunkIndex - b.chunkIndex || a.sentenceIndex - b.sentenceIndex);

  const document = coverageDocument(coverages, {
    engineId: engine,
    policy,
    backend,
    language,
    sessionId: manifest.source.sessionId,
    processDir: manifest.source.processDir,
    chunksInManifest: manifest.chapters.reduce((sum, c) => sum + c.chunks.length, 0),
    errors,
    skipped,
  });
  const { summary } = document;
  log(`[align] ${summary.chunksAligned} aligned, ${summary.chunksFailed} failed coverage, ${summary.errors} error(s); median ratio ${pyRepr(summary.alignedRatioMedian)}, median ${pyRepr(summary.secondsPerChunkMedian)}s/chunk`);
  const estimated = cues.filter((c) => c.estimated).length;
  if (estimated > 0) log(`[align] ${estimated} of ${cues.length} sentence cue(s) are ESTIMATES - expected text over the chunk's real audio, marked in the VTT`);
  return { document, cues };
}

export async function writeOutputs(result: AlignResult, vttPath: string, reportPath: string, log: Log): Promise<void> {
  if (result.cues.length === 0) {
    throw new AlignerError(`no chunk produced a sentence cue, not even an estimated one, so ${vttPath} would be an empty transcript; see the report's "errors" for why`);
  }
  try {
    await writeSentenceVtt(result.cues, vttPath);
  } catch (bad) {
    if (bad instanceof SentenceVttError) throw new AlignerError(bad.message);
    throw bad;
  }
  log(`[align] ${result.cues.length} sentence cue(s) -> ${vttPath}`);
  await fsp.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
  await fsp.writeFile(reportPath, `${pyJsonDumpsAscii(result.document)}\n`, 'utf8');
  log(`[align] coverage report -> ${reportPath}`);
}

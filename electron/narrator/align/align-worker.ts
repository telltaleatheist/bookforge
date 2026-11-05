/**
 * One alignment, in a worker thread. A port of `_run_align` in `narrator/cli.py`.
 *
 * THE EXIT CODE SAYS WHETHER THE RUN HAPPENED, not whether the book was perfect (Owen, 2026-09-05).
 * A pass that audited every chunk exits 0, whatever the chunks said: that is in the report.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import { AssemblyCancelled } from '../assemble/ffmpeg-tools';
import { SENTENCE_VTT_SUFFIX } from '../assemble/sentence-vtt';
import { finalName } from '../assemble/run';
import { buildManifest } from '../session/session-v1';
import { AlignerError } from './aligner';
import type { AlignRequest } from './align-door';
import { alignSession, writeOutputs } from './run';

const port = parentPort!;
const request = workerData as AlignRequest;
const abort = new AbortController();
port.on('message', (message: unknown) => {
  if (message === 'cancel') abort.abort();
});
const log = (line: string): void => port.postMessage({ stream: 'stdout', text: `${line}\n` });

const pyTypeName = (value: unknown): string => {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  return Number.isInteger(value) ? 'int' : 'float';
};

async function readDocument(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new AlignerError(`--alignment ${file} cannot be read (${(err as Error).message}).`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    throw new AlignerError(`--alignment ${file} is not JSON (${(err as Error).message}). It is the artifact a Crucible \`align\` job lands.`);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new AlignerError(`--alignment ${file} holds a ${pyTypeName(document)}, not an alignment document.`);
  }
  return document as Record<string, unknown>;
}

(async () => {
  try {
    const manifest = await buildManifest(request.processDir, { sentencesDir: null, chapters: null, log });
    const alignment = await readDocument(request.alignmentPath);
    const result = await alignSession(manifest, {
      language: request.language,
      ffmpeg: request.ffmpeg,
      chapterGap: request.chapterGap,
      alignment,
      log,
      signal: abort.signal,
    });
    const stem = finalName(manifest).replace(/\.[^.]*$/, '');
    const vttPath = request.vttPath ?? path.join(manifest.source.processDir, stem + SENTENCE_VTT_SUFFIX);
    await writeOutputs(result, vttPath, request.reportPath, log);
    const { summary } = result.document;
    log(`[align] ${summary.chunksAligned} chunk(s) aligned, ${summary.chunksFailed} failed coverage, ${summary.errors} could not be placed`);
    const retake = [...new Set([...summary.failedIndices, ...summary.errorIndices])].sort((a, b) => a - b);
    if (retake.length > 0) log(`[align] retake: ${retake.join(',')}`);
    port.postMessage({ exit: 0 });
  } catch (err) {
    if (err instanceof AssemblyCancelled) {
      port.postMessage({ exit: 1 });
      return;
    }
    log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    if (!(err instanceof AlignerError)) port.postMessage({ stream: 'stderr', text: `${err instanceof Error ? err.stack : String(err)}\n` });
    port.postMessage({ exit: 1 });
  }
})();

/**
 * The coverage AUDIT: assembly says what the alignment found, and assembles. A port of
 * `narrator/assemble/coverage_gate.py`.
 *
 * It is not a gate. Owen, 2026-09-05: "assembly will never function, ever, if we expect it to come
 * out the other side flawless." A failed chunk is reported with the text the audio did not say and
 * the retake that fixes it, and the book is assembled. A missing report is reported too.
 *
 * What is still refused is the whole list: a report that cannot be read, of an unknown schema, or
 * about another book. Those mean "this document does not describe what you are assembling".
 */

import * as fs from 'fs';
import * as path from 'path';

import { pyRepr } from '../py-compat';
import type { Manifest } from '../session/manifest';

export const DEFAULT_REPORT_NAME = 'coverage.json';
const SUPPORTED_REPORT_VERSION = 1;
const REQUIRED_REPORT_KEYS = ['engine', 'summary', 'chunks'] as const;

export class CoverageRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageRefusal';
  }
}

type Doc = Record<string, any>;
type Log = (line: string) => void;

const isObject = (value: unknown): value is Doc => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeName = (value: unknown): string => (Array.isArray(value) ? 'list' : value === null ? 'NoneType' : typeof value === 'string' ? 'str' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : typeof value === 'boolean' ? 'bool' : 'dict');
const firstPoints = (text: string, count: number): string => [...text].slice(0, count).join('');

const engineIdOf = (manifest: Manifest): string => (manifest.engine === null ? manifest.voice.engine : manifest.engine.id);

export const defaultReportPath = (manifest: Manifest): string => path.join(manifest.source.processDir, DEFAULT_REPORT_NAME);

export async function loadReport(file: string): Promise<Doc> {
  const stat = await fs.promises.stat(file).catch(() => null);
  if (stat === null || !stat.isFile()) throw new CoverageRefusal(`no coverage report at ${file}`);
  let document: unknown;
  try {
    document = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (bad) {
    throw new CoverageRefusal(`coverage report ${file} is unreadable: ${(bad as Error).message}`);
  }
  if (!isObject(document)) throw new CoverageRefusal(`coverage report ${file} is a ${typeName(document)}, not an object`);
  const version = document['version'] ?? null;
  if (version !== SUPPORTED_REPORT_VERSION) {
    throw new CoverageRefusal(`coverage report ${file} is version ${pyRepr(version)}; this assembler understands version ${SUPPORTED_REPORT_VERSION}. Re-run \`narrator align --report ${file}\`.`);
  }
  for (const key of REQUIRED_REPORT_KEYS) {
    if (!(key in document)) {
      throw new CoverageRefusal(`coverage report ${file} has no ${pyRepr(key)} block, so it is a malformed report - not a report of zero aligned chunks. Re-run \`narrator align --report ${file}\`.`);
    }
  }
  if (!isObject(document['summary'])) throw new CoverageRefusal(`coverage report ${file}: "summary" is a ${typeName(document['summary'])}, not an object`);
  return document;
}

export function verifyReport(document: Doc, manifest: Manifest, file: string): void {
  const engine = engineIdOf(manifest);
  if ((document['engine'] ?? null) !== engine) {
    throw new CoverageRefusal(`coverage report ${file} covers engine ${pyRepr(document['engine'] ?? null)} but this book was rendered by ${pyRepr(engine)}`);
  }
  const session = manifest.source.sessionId;
  const sessionId = document['sessionId'] ?? null;
  if (sessionId !== null && sessionId !== session) {
    throw new CoverageRefusal(`coverage report ${file} covers session ${pyRepr(sessionId)}, not ${pyRepr(session)}`);
  }
  const chunks = manifest.chapters.reduce((sum, chapter) => sum + chapter.chunks.length, 0);
  if ((document['chunksInManifest'] ?? null) !== chunks) {
    throw new CoverageRefusal(`coverage report ${file} was written for a manifest of ${pyRepr(document['chunksInManifest'] ?? null)} chunk(s); this one has ${chunks}. Align again after the render changed.`);
  }
}

export function retakeIndices(document: Doc): number[] {
  const failed = ((document['chunks'] ?? []) as Doc[]).filter((c) => c['failed']).map((c) => c['index'] as number);
  const errored = ((document['errors'] ?? []) as unknown[]).filter((e): e is Doc => isObject(e) && 'index' in e).map((e) => e['index'] as number);
  return [...new Set([...failed, ...errored])].sort((a, b) => a - b);
}

/** Never raises. What an operator needs is the indices, the missing text and the command. */
export function reportFailures(document: Doc, where: string, log: Log): number[] {
  const failed = ((document['chunks'] ?? []) as Doc[]).filter((c) => c['failed']);
  const errors = ((document['errors'] ?? []) as unknown[]).filter(isObject);
  const summary: Doc = document['summary'] ?? {};
  const aligned = summary['chunksAligned'] ?? null;
  const skipped = summary['chunksSkipped'] ?? null;
  const total = document['chunksInManifest'] ?? null;
  const show = (value: unknown): string => (value === null ? 'None' : String(value));
  log(`[coverage] ${where}: ${show(aligned)} chunk(s) aligned, ${failed.length} failed coverage, ${errors.length} could not be placed, ${show(skipped)} marker-only, of ${show(total)} chunk(s) in the manifest`);
  const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
  const accounted = [aligned, skipped].filter(isInt).reduce((sum: number, v: number) => sum + v, 0);
  if (isInt(total) && accounted + errors.length < total) {
    log(`[coverage] ${where}: ${total - accounted - errors.length} chunk(s) were never measured (a partial --indices run, or an align that was stopped). Their cues are estimates.`);
  }
  for (const chunk of failed) {
    const reasons = chunk['reasons'] as string[] | undefined;
    log(`[coverage]   chunk ${chunk['index']}: ${(reasons && reasons.length ? reasons : ['no reason recorded']).join('; ')}`);
    for (const span of (chunk['droppedText'] ?? []) as Doc[]) {
      log(`[coverage]     dropped ${span['words']} word(s): ${pyRepr(firstPoints(span['text'] as string, 120))}`);
    }
  }
  for (const error of errors) {
    log(`[coverage]   chunk ${show(error['index'] ?? null)}: not placed at ${show(error['stage'] ?? null)} - ${firstPoints(show(error['error'] ?? null), 160)}`);
  }
  const indices = retakeIndices(document);
  if (indices.length > 0) {
    log(`[coverage] The audiobook is assembled from what was rendered. To fix those chunks: narrator retake --indices ${indices.join(',')}  (in BookForge: Correct sentences), then align and assemble again.`);
  }
  return indices;
}

/** The whole audit. A report the caller named is the caller's claim and refuses; one found beside the session is a find, and a stale find must not cost a book. */
export async function checkCoverage(manifest: Manifest, reportPath: string | null, log: Log): Promise<Doc | null> {
  const file = reportPath || defaultReportPath(manifest);
  const stat = await fs.promises.stat(file).catch(() => null);
  if (stat === null || !stat.isFile()) {
    if (reportPath) {
      log(`[coverage] no coverage report at ${reportPath}, which this assembly was told to read. Assembling anyway; the sentence cues will be estimates rather than measurements.`);
    } else {
      log(`[coverage] no coverage report beside the session (${file}), so nothing has checked that this render said its text. Assembling anyway; run the Align step to measure it.`);
    }
    return null;
  }
  if (!reportPath) {
    let document: Doc;
    try {
      document = await loadReport(file);
      verifyReport(document, manifest, file);
    } catch (stale) {
      if (!(stale instanceof CoverageRefusal)) throw stale;
      log(`[coverage] the report beside the session is not about this book, so it is ignored: ${stale.message}`);
      return null;
    }
    reportFailures(document, file, log);
    return document;
  }
  const document = await loadReport(file);
  verifyReport(document, manifest, file);
  reportFailures(document, file, log);
  return document;
}

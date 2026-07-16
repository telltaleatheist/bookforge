import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  atomicWriteFile,
  getManifest,
  getProjectPath,
  getVariants,
  modifyManifest,
} from './manifest-service.js';
import { resolveReadableVtt } from './metadata-tools.js';
import type {
  AudiobookAnalysisManifestEntry,
  ProjectVariant,
} from './manifest-types.js';
import {
  digestAudiobookCues,
  normalizeAudiobookCueText,
  parseAudiobookVttStrict,
  type AudiobookAnalysisCue,
} from './audiobook-analysis-canonical.js';
export {
  canonicalizeAudiobookCues,
  digestAudiobookCues,
  parseAudiobookVttStrict,
} from './audiobook-analysis-canonical.js';
export type { AudiobookAnalysisCue } from './audiobook-analysis-canonical.js';

export const AUDIOBOOK_ANALYSIS_PROTOCOL_VERSION = 1 as const;
export const TRANSCRIPT_DIGEST_ALGORITHM = 'bookforge-vtt-cues-v1' as const;

export interface AudiobookAnalysisBinding {
  protocolVersion: 1;
  analysisId: string;
  projectId: string;
  variantId: string;
  m4bPath: string;
  m4bHashAlgorithm: 'sha256';
  m4bSha256: string;
  m4bSizeBytes: number;
  transcriptDigestAlgorithm: 'bookforge-vtt-cues-v1';
  transcriptSha256: string;
  cueCount: number;
}

export interface AudiobookAnalysisReportEnvelope<T = unknown> {
  protocolVersion: 1;
  kind: 'audiobook-analysis';
  binding: AudiobookAnalysisBinding;
  payload: T;
}

export interface ResolvedAudiobookAnalysisSource {
  projectId: string;
  projectDir: string;
  variant: ProjectVariant;
  m4bPath: string;
  m4bRelativePath: string;
  vttPath: string;
  vttContent: string;
  viaTemp: boolean;
  cues: AudiobookAnalysisCue[];
  m4bSha256: string;
  m4bSizeBytes: number;
  transcriptSha256: string;
}

export type AudiobookAnalysisVerification<T = unknown> =
  | { status: 'missing' }
  | { status: 'stale'; reason: string }
  | {
      status: 'valid';
      report: AudiobookAnalysisReportEnvelope<T>;
      reportPath: string;
      manifestEntry: AudiobookAnalysisManifestEntry;
      transcriptVtt: string;
    };

function assertSafeProjectId(projectId: string): void {
  if (!projectId || projectId === '.' || projectId === '..'
    || projectId.includes('/') || projectId.includes('\\') || path.basename(projectId) !== projectId) {
    throw new Error('Invalid projectId');
  }
}

async function sha256File(filePath: string): Promise<{ sha256: string; size: number }> {
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error(`Audiobook is not a file: ${filePath}`);
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  const after = await fs.promises.stat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('Audiobook changed while its identity was being hashed');
  }
  const sha256 = hash.digest('hex');
  return { sha256, size: after.size };
}

function resolveWithinProject(projectDir: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`${label} must be a project-relative path`);
  const resolved = path.resolve(projectDir, relativePath);
  const rel = path.relative(projectDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} escapes the project directory`);
  }
  return resolved;
}

async function assertExistingRealPathWithinProject(projectDir: string, filePath: string, label: string): Promise<void> {
  const [realProjectDir, realFilePath] = await Promise.all([
    fs.promises.realpath(projectDir),
    fs.promises.realpath(filePath),
  ]);
  const rel = path.relative(realProjectDir, realFilePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the project directory`);
  }
}

async function assertFutureRealPathWithinProject(projectDir: string, filePath: string, label: string): Promise<void> {
  const realProjectDir = await fs.promises.realpath(projectDir);
  let existingParent = path.dirname(filePath);
  while (true) {
    try {
      existingParent = await fs.promises.realpath(existingParent);
      break;
    } catch (err) {
      const parent = path.dirname(existingParent);
      if (parent === existingParent) throw err;
      existingParent = parent;
    }
  }
  const rel = path.relative(realProjectDir, existingParent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the project directory`);
  }
}

export async function resolveAudiobookAnalysisSource(
  projectId: string,
  variantId: string,
): Promise<ResolvedAudiobookAnalysisSource> {
  if (!projectId || !variantId) throw new Error('projectId and variantId are required');
  assertSafeProjectId(projectId);
  const result = await getManifest(projectId);
  if (!result.success || !result.manifest) throw new Error(result.error || `Project not found: ${projectId}`);
  if (result.manifest.projectId !== projectId) {
    throw new Error(`Manifest project identity mismatch: requested ${projectId}, found ${result.manifest.projectId}`);
  }
  const matches = getVariants(result.manifest).variants.filter(v => v.id === variantId);
  if (matches.length !== 1) throw new Error(`Audiobook variant identity is not unique: ${variantId}`);
  const variant = matches[0];
  if (variant.kind !== 'audiobook' || variant.format.toLowerCase() !== 'm4b') {
    throw new Error(`Variant is not an M4B audiobook: ${variantId}`);
  }
  const projectDir = getProjectPath(projectId);
  const m4bPath = resolveWithinProject(projectDir, variant.path, 'Audiobook path');
  await assertExistingRealPathWithinProject(projectDir, m4bPath, 'Audiobook path');
  const vttPath = variant.vttPath
    ? resolveWithinProject(projectDir, variant.vttPath, 'Transcript path')
    : undefined;
  const readable = await resolveReadableVtt({ m4bPath, vttPath });
  if (!readable) throw new Error(`Audiobook variant has no authoritative transcript: ${variantId}`);
  try {
    if (!readable.viaTemp) {
      await assertExistingRealPathWithinProject(projectDir, readable.path, 'Transcript path');
    }
    const vttContent = await fs.promises.readFile(readable.path, 'utf8');
    const cues = parseAudiobookVttStrict(vttContent);
    const m4b = await sha256File(m4bPath);
    return {
      projectId,
      projectDir,
      variant,
      m4bPath,
      m4bRelativePath: variant.path.replace(/\\/g, '/'),
      vttPath: readable.path,
      vttContent,
      viaTemp: readable.viaTemp,
      cues,
      m4bSha256: m4b.sha256,
      m4bSizeBytes: m4b.size,
      transcriptSha256: digestAudiobookCues(cues),
    };
  } finally {
    if (readable.viaTemp) {
      try { await fs.promises.unlink(readable.path); } catch { /* OS cleanup remains safe */ }
    }
  }
}

export async function createAudiobookAnalysisBinding(
  source: ResolvedAudiobookAnalysisSource,
  analysisId: string = crypto.randomUUID(),
): Promise<AudiobookAnalysisBinding> {
  return {
    protocolVersion: AUDIOBOOK_ANALYSIS_PROTOCOL_VERSION,
    analysisId,
    projectId: source.projectId,
    variantId: source.variant.id,
    m4bPath: source.m4bRelativePath,
    m4bHashAlgorithm: 'sha256',
    m4bSha256: source.m4bSha256,
    m4bSizeBytes: source.m4bSizeBytes,
    transcriptDigestAlgorithm: TRANSCRIPT_DIGEST_ALGORITHM,
    transcriptSha256: source.transcriptSha256,
    cueCount: source.cues.length,
  };
}

export function audiobookAnalysisBindingsEqual(a: AudiobookAnalysisBinding, b: AudiobookAnalysisBinding): boolean {
  return a.protocolVersion === b.protocolVersion
    && a.analysisId === b.analysisId
    && a.projectId === b.projectId
    && a.variantId === b.variantId
    && a.m4bPath === b.m4bPath
    && a.m4bHashAlgorithm === b.m4bHashAlgorithm
    && a.m4bSha256 === b.m4bSha256
    && a.m4bSizeBytes === b.m4bSizeBytes
    && a.transcriptDigestAlgorithm === b.transcriptDigestAlgorithm
    && a.transcriptSha256 === b.transcriptSha256
    && a.cueCount === b.cueCount;
}

function manifestEntryFor(
  binding: AudiobookAnalysisBinding,
  reportPath: string,
  reportSha256: string,
  analyzedAt: string,
): AudiobookAnalysisManifestEntry {
  return {
    protocolVersion: 1,
    analysisId: binding.analysisId,
    variantId: binding.variantId,
    reportPath,
    reportHashAlgorithm: 'sha256',
    reportSha256,
    m4bHashAlgorithm: 'sha256',
    m4bSha256: binding.m4bSha256,
    m4bSizeBytes: binding.m4bSizeBytes,
    transcriptDigestAlgorithm: TRANSCRIPT_DIGEST_ALGORITHM,
    transcriptSha256: binding.transcriptSha256,
    cueCount: binding.cueCount,
    analyzedAt,
  };
}

function entryMatchesBinding(entry: AudiobookAnalysisManifestEntry, binding: AudiobookAnalysisBinding): boolean {
  return entry.protocolVersion === binding.protocolVersion
    && entry.analysisId === binding.analysisId
    && entry.variantId === binding.variantId
    && entry.m4bHashAlgorithm === binding.m4bHashAlgorithm
    && entry.m4bSha256 === binding.m4bSha256
    && entry.m4bSizeBytes === binding.m4bSizeBytes
    && entry.transcriptDigestAlgorithm === binding.transcriptDigestAlgorithm
    && entry.transcriptSha256 === binding.transcriptSha256
    && entry.cueCount === binding.cueCount;
}

export async function commitAudiobookAnalysisReport<T>(options: {
  projectId: string;
  variantId: string;
  expectedBinding: AudiobookAnalysisBinding;
  payload: T;
}): Promise<{ report: AudiobookAnalysisReportEnvelope<T>; binding: AudiobookAnalysisBinding; reportPath: string; outputPath: string }> {
  const current = await resolveAudiobookAnalysisSource(options.projectId, options.variantId);
  const currentBinding = await createAudiobookAnalysisBinding(current, options.expectedBinding.analysisId);
  if (!audiobookAnalysisBindingsEqual(options.expectedBinding, currentBinding)) {
    throw new Error('Audiobook or authoritative transcript changed during analysis; report was not committed');
  }
  const analyzedAt = new Date().toISOString();
  const reportPath = `stages/04-analysis/audiobooks/${currentBinding.analysisId}/analysis.json`;
  const outputPath = resolveWithinProject(current.projectDir, reportPath, 'Analysis report path');
  await assertFutureRealPathWithinProject(current.projectDir, outputPath, 'Analysis report path');
  const report: AudiobookAnalysisReportEnvelope<T> = {
    protocolVersion: 1,
    kind: 'audiobook-analysis',
    binding: currentBinding,
    payload: options.payload,
  };
  const reportJson = JSON.stringify(report, null, 2);
  const reportSha256 = crypto.createHash('sha256').update(reportJson, 'utf8').digest('hex');
  await atomicWriteFile(outputPath, reportJson);
  const entry = manifestEntryFor(currentBinding, reportPath, reportSha256, analyzedAt);
  let previousEntry: AudiobookAnalysisManifestEntry | undefined;
  const saved = await modifyManifest(options.projectId, manifest => {
    if (manifest.projectId !== options.projectId) {
      throw new Error(`Manifest project identity mismatch before commit: ${manifest.projectId}`);
    }
    const live = getVariants(manifest).variants.filter(v => v.id === options.variantId);
    if (live.length !== 1 || live[0].kind !== 'audiobook' || live[0].path.replace(/\\/g, '/') !== currentBinding.m4bPath) {
      throw new Error('Audiobook variant changed before manifest commit');
    }
    const existing = manifest.audiobookAnalyses?.[options.variantId];
    previousEntry = existing ? { ...existing } : undefined;
    manifest.audiobookAnalyses = { ...(manifest.audiobookAnalyses || {}), [options.variantId]: entry };
  });
  if (!saved.success) throw new Error(saved.error || 'Failed to commit audiobook analysis manifest pointer');
  const verified = await verifyAudiobookAnalysis<T>(options.projectId, options.variantId);
  if (verified.status !== 'valid' || verified.report.binding.analysisId !== currentBinding.analysisId) {
    await modifyManifest(options.projectId, manifest => {
      if (manifest.audiobookAnalyses?.[options.variantId]?.analysisId === currentBinding.analysisId) {
        if (previousEntry) manifest.audiobookAnalyses[options.variantId] = previousEntry;
        else delete manifest.audiobookAnalyses[options.variantId];
      }
    });
    throw new Error(`Audiobook analysis became stale during commit${verified.status === 'stale' ? `: ${verified.reason}` : ''}`);
  }
  return { report, binding: currentBinding, reportPath, outputPath };
}

function isEnvelope(value: unknown): value is AudiobookAnalysisReportEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Record<string, unknown>;
  if (envelope['protocolVersion'] !== 1 || envelope['kind'] !== 'audiobook-analysis') return false;
  const binding = envelope['binding'] as Record<string, unknown> | undefined;
  return !!binding
    && binding['protocolVersion'] === 1
    && typeof binding['analysisId'] === 'string'
    && typeof binding['projectId'] === 'string'
    && typeof binding['variantId'] === 'string'
    && typeof binding['m4bPath'] === 'string'
    && binding['m4bHashAlgorithm'] === 'sha256'
    && typeof binding['m4bSha256'] === 'string' && /^[a-f0-9]{64}$/.test(binding['m4bSha256'])
    && Number.isInteger(binding['m4bSizeBytes'])
    && binding['transcriptDigestAlgorithm'] === TRANSCRIPT_DIGEST_ALGORITHM
    && typeof binding['transcriptSha256'] === 'string' && /^[a-f0-9]{64}$/.test(binding['transcriptSha256'])
    && Number.isInteger(binding['cueCount'])
    && 'payload' in envelope;
}

export function validateAudiobookAnalysisPayload(
  payload: unknown,
  cues: AudiobookAnalysisCue[],
): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Analysis payload is not an object';
  const p = payload as Record<string, unknown>;
  if (typeof p['analyzedAt'] !== 'string' || !Number.isFinite(Date.parse(p['analyzedAt']))) {
    return 'Analysis payload has an invalid analyzedAt value';
  }
  if (!Array.isArray(p['categories']) || !Array.isArray(p['flags']) || !Array.isArray(p['skippedChunks'])) {
    return 'Analysis payload categories, flags, or skipped chunks are missing';
  }
  const categoryIds = new Set<string>();
  for (const raw of p['categories']) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Analysis category is invalid';
    const category = raw as Record<string, unknown>;
    if (typeof category['id'] !== 'string' || !category['id']
      || typeof category['name'] !== 'string' || !category['name']
      || typeof category['description'] !== 'string'
      || typeof category['color'] !== 'string'
      || category['enabled'] !== true
      || categoryIds.has(category['id'])) {
      return 'Analysis category schema is invalid';
    }
    categoryIds.add(category['id']);
  }
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0 };
  const flagRanges: Array<{ start: number; end: number }> = [];
  for (const raw of p['flags']) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Analysis finding is invalid';
    const flag = raw as Record<string, unknown>;
    const start = flag['cueStartIndex'];
    const end = flag['cueEndIndex'];
    const severity = flag['severity'];
    const categoryId = flag['categoryId'];
    if (typeof categoryId !== 'string' || !categoryIds.has(categoryId)
      || typeof flag['quote'] !== 'string' || !flag['quote'].trim()
      || typeof flag['description'] !== 'string' || !flag['description'].trim()
      || (severity !== 'low' && severity !== 'medium' && severity !== 'high')
      || !Number.isInteger(start) || !Number.isInteger(end)
      || (start as number) < 0 || (end as number) < (start as number) || (end as number) >= cues.length) {
      return 'Analysis finding schema or cue range is invalid';
    }
    const anchored = cues.slice(start as number, (end as number) + 1);
    if (flag['startTime'] !== anchored[0].startTime || flag['endTime'] !== anchored[anchored.length - 1].endTime) {
      return 'Analysis finding timestamps do not match the bound cues';
    }
    const spoken = normalizeAudiobookCueText(anchored.map(cue => cue.text).join(' '));
    if (!spoken.includes(normalizeAudiobookCueText(flag['quote'] as string))) {
      return 'Analysis finding quote does not occur in the bound cues';
    }
    byCategory[categoryId] = (byCategory[categoryId] || 0) + 1;
    bySeverity[severity]++;
    flagRanges.push({ start: start as number, end: end as number });
  }
  const validSkipReasons = new Set([
    'ai-refusal', 'copyright', 'empty-response', 'output-limit', 'invalid-response', 'request-error',
  ]);
  const skippedRanges: Array<{ start: number; end: number }> = [];
  const skippedTopLevelTotals: number[] = [];
  for (const raw of p['skippedChunks']) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Skipped analysis chunk is invalid';
    const skipped = raw as Record<string, unknown>;
    const start = skipped['cueStartIndex'];
    const end = skipped['cueEndIndex'];
    if (!Number.isInteger(skipped['topLevelChunkNumber']) || (skipped['topLevelChunkNumber'] as number) < 1
      || !Number.isInteger(skipped['totalTopLevelChunks']) || (skipped['totalTopLevelChunks'] as number) < 1
      || (skipped['topLevelChunkNumber'] as number) > (skipped['totalTopLevelChunks'] as number)
      || !Number.isInteger(start) || !Number.isInteger(end)
      || (start as number) < 0 || (end as number) < (start as number) || (end as number) >= cues.length
      || typeof skipped['reason'] !== 'string' || !validSkipReasons.has(skipped['reason'] as string)
      || typeof skipped['error'] !== 'string' || !skipped['error']
      || typeof skipped['text'] !== 'string'
      || !Number.isInteger(skipped['attempts']) || (skipped['attempts'] as number) < 1
      || !Number.isInteger(skipped['splitDepth']) || (skipped['splitDepth'] as number) < 0) {
      return 'Skipped analysis chunk schema or cue range is invalid';
    }
    const anchored = cues.slice(start as number, (end as number) + 1);
    if (skipped['startTime'] !== anchored[0].startTime || skipped['endTime'] !== anchored[anchored.length - 1].endTime
      || normalizeAudiobookCueText(skipped['text'] as string)
        !== normalizeAudiobookCueText(anchored.map(cue => cue.text).join(' '))) {
      return 'Skipped analysis chunk does not match its bound cues';
    }
    skippedTopLevelTotals.push(skipped['totalTopLevelChunks'] as number);
    skippedRanges.push({ start: start as number, end: end as number });
  }
  skippedRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < skippedRanges.length; index++) {
    if (skippedRanges[index].start <= skippedRanges[index - 1].end) {
      return 'Skipped analysis cue ranges overlap';
    }
  }
  for (const flag of flagRanges) {
    if (skippedRanges.some(skipped => flag.start <= skipped.end && skipped.start <= flag.end)) {
      return 'Analysis finding overlaps a skipped cue range';
    }
  }
  const stats = p['statistics'];
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return 'Analysis statistics are missing';
  const s = stats as Record<string, unknown>;
  const skippedCueCount = skippedRanges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
  if (s['totalFlags'] !== p['flags'].length
    || JSON.stringify(s['byCategory']) !== JSON.stringify(byCategory)
    || JSON.stringify(s['bySeverity']) !== JSON.stringify(bySeverity)
    || !Number.isInteger(s['topLevelChunks']) || (s['topLevelChunks'] as number) < 1
    || skippedTopLevelTotals.some(total => total !== s['topLevelChunks'])
    || s['skippedChunks'] !== skippedRanges.length
    || s['skippedCueCount'] !== skippedCueCount
    || s['analyzedCueCount'] !== cues.length - skippedCueCount) {
    return 'Analysis statistics do not match the findings';
  }
  return null;
}

export async function verifyAudiobookAnalysis<T = unknown>(
  projectId: string,
  variantId: string,
): Promise<AudiobookAnalysisVerification<T>> {
  assertSafeProjectId(projectId);
  const manifestResult = await getManifest(projectId);
  if (!manifestResult.success || !manifestResult.manifest) return { status: 'missing' };
  if (manifestResult.manifest.projectId !== projectId) {
    return { status: 'stale', reason: 'Manifest project identity does not match its directory' };
  }
  const entry = manifestResult.manifest.audiobookAnalyses?.[variantId];
  if (!entry) return { status: 'missing' };
  try {
    const projectDir = getProjectPath(projectId);
    const expectedReportPath = `stages/04-analysis/audiobooks/${entry.analysisId}/analysis.json`;
    if (entry.reportPath !== expectedReportPath) return { status: 'stale', reason: 'Manifest report path is not canonical' };
    const reportPath = resolveWithinProject(projectDir, entry.reportPath, 'Analysis report path');
    await assertExistingRealPathWithinProject(projectDir, reportPath, 'Analysis report path');
    const reportJson = await fs.promises.readFile(reportPath, 'utf8');
    if (entry.reportHashAlgorithm !== 'sha256'
      || !/^[a-f0-9]{64}$/.test(entry.reportSha256)
      || crypto.createHash('sha256').update(reportJson, 'utf8').digest('hex') !== entry.reportSha256) {
      return { status: 'stale', reason: 'Analysis report bytes do not match the manifest digest' };
    }
    const parsed: unknown = JSON.parse(reportJson);
    if (!isEnvelope(parsed)) return { status: 'stale', reason: 'Analysis report schema is invalid' };
    const report = parsed as AudiobookAnalysisReportEnvelope<T>;
    if (report.binding.projectId !== projectId || report.binding.variantId !== variantId) {
      return { status: 'stale', reason: 'Analysis report targets another project or variant' };
    }
    if (!entryMatchesBinding(entry, report.binding)) {
      return { status: 'stale', reason: 'Manifest pointer and analysis report binding disagree' };
    }
    const current = await resolveAudiobookAnalysisSource(projectId, variantId);
    const currentBinding = await createAudiobookAnalysisBinding(current, entry.analysisId);
    if (!audiobookAnalysisBindingsEqual(report.binding, currentBinding)) {
      return { status: 'stale', reason: 'Current audiobook bytes or transcript do not match the analysis binding' };
    }
    const payloadError = validateAudiobookAnalysisPayload(report.payload, current.cues);
    if (payloadError) return { status: 'stale', reason: payloadError };
    return { status: 'valid', report, reportPath, manifestEntry: entry, transcriptVtt: current.vttContent };
  } catch (err) {
    return { status: 'stale', reason: (err as Error).message };
  }
}

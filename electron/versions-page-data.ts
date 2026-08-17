/**
 * Everything a book's Versions page needs to draw itself, in one main-side pass.
 *
 * ── The problem this is the answer to ───────────────────────────────────────
 *
 * Owen, 2026-08-17: opening any book's versions page takes 5–10 seconds. The
 * page fired five IPCs in sequence, and measured against the real library (ten
 * projects at E:\Bookforge, 386 projects, audiobooks up to 3 GB) four of them
 * cost under 30 ms between them and one cost everything:
 *
 *   editor:get-versions          2 – 9 ms
 *   variant:list                 0 – 1 ms
 *   pass:list-diffs              0 – 1 ms  (86 ms once, minting a legacy chain)
 *   reset (preview)              3 – 8 ms
 *   analysis:list-audiobooks  4000 – 9636 ms
 *
 * `analysis:list-audiobooks` asked, per m4b, per visit, uncached: extract the
 * embedded transcript with ffmpeg (0.5–1.3 s), parse every cue (6–33 ms), and
 * SHA-256 the entire audiobook (3.7–8.3 s) — all to answer "should the Generate
 * sentences button be enabled". The hash was never part of that question.
 *
 * ── What this module does about it ──────────────────────────────────────────
 *
 * Two functions, and the difference between them is the whole design:
 *
 *   {@link readVersionsPageData} is CHEAP — stat-level, and nothing else. It
 *   reads the manifest, resolves every variant's path, reads the analysis
 *   report's own small JSON, and looks up the expensive audiobook facts in the
 *   derivation cache. It never derives. A fact that is not cached comes back as
 *   `deriving`, and the page draws that honestly.
 *
 *   {@link deriveAudiobookFacts} is the SLOW half, run in the background by the
 *   handler and pushed to the window when it lands. It derives only what the
 *   cache was missing, and what it derives is remembered against the file's
 *   (mtime, size) so the next visit — and every visit after — is cheap.
 *
 * ── unknown is not ineligible ───────────────────────────────────────────────
 *
 * The page's Generate/Regenerate sentences button must never be offered for an
 * audiobook whose transcript has not been checked: offering it there risks
 * replacing a transcript that is already inside the file. So the answer has
 * THREE states, not two, and `deriving` disables the button while saying why —
 * exactly as the un-cached page does today, but for a second rather than ten.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  getManifest,
  getProjectPath,
  getVariants,
  getLibraryBasePath,
} from './manifest-service.js';
import { normalizeFsPath } from './path-utils.js';
import {
  resolveAudiobookTranscriptSource,
  verifyAudiobookAnalysis,
} from './audiobook-analysis-protocol.js';
import {
  getDerived,
  putDerived,
  readFileIdentity,
  type FileIdentity,
} from './derivation-cache.js';
import type { ProjectVariant, ResolvedProjectVariant } from './manifest-types.js';

/** Cache namespace: does this m4b carry an authoritative, strictly-parseable transcript. */
const NS_TRANSCRIPT = 'audiobook-transcript-v1';
/** Cache namespace: does this analysis report still verify against its audiobook. */
const NS_REPORT = 'audiobook-analysis-report-v1';

/**
 * What was found inside one audiobook. `cueCount` is null only when the file
 * has no transcript at all — when it has one, counting the cues is free (they
 * were just parsed to prove the transcript is readable).
 */
interface TranscriptFact {
  eligible: boolean;
  cueCount: number | null;
  /** Why an audiobook is not eligible, for the log. Null when it is. */
  refusal: string | null;
}

/** A stored verdict on an analysis report, and the audiobook it was reached against. */
interface ReportFact {
  status: 'valid' | 'stale' | 'missing';
  /** The audiobook's identity when this verdict was reached — see below. */
  m4bMtimeMs: number;
  m4bSize: number;
  analyzedAt: string | null;
  flagCount: number | null;
}

/** One audiobook's slow facts, as the page and its background push carry them. */
export interface AudiobookFacts {
  variantId: string;
  /** `deriving` means NOT YET KNOWN — never draw it as ineligible. */
  transcript: 'eligible' | 'ineligible' | 'deriving';
  cueCount: number | null;
  /** The recorded analysis report's standing, or `deriving`/`missing`. */
  reportStatus: 'valid' | 'stale' | 'missing' | 'deriving';
  analyzedAt: string | null;
  flagCount: number | null;
}

/** The content-analysis report row, as the flat page draws it. */
export interface VersionsAnalysisEntry {
  /** The analyzed file, absolute. Empty when the report is orphaned. */
  path: string;
  modifiedAt: string;
  flagCount: number;
  isCheckpoint: boolean;
  /** The durable version the report is pinned to. `versionId: null` is orphaned. */
  target: { versionId: string | null; versionType: string; versionLabel: string };
}

export interface VersionsPageData {
  variants: ResolvedProjectVariant[];
  primaryVariantId?: string;
  ttsVariantId?: string;
  analysis: VersionsAnalysisEntry | null;
  /** One entry per m4b variant, in manifest order. Empty for a book with no audio. */
  audiobooks: AudiobookFacts[];
  /**
   * True when no audiobook fact is still `deriving` — i.e. the answer above is
   * final and the page's Generate buttons can be drawn live. False means a
   * background derivation is running and a push is coming.
   */
  audiobookFactsComplete: boolean;
}

/**
 * Translate a library path recorded on another machine to this one.
 *
 * A twin of main.ts's `translateLibraryPath`, which is a closure inside
 * `registerHandlers` and cannot be imported. The rule is the same and so is the
 * reason for it: analysis reports written on the Mac record `/Volumes/Callisto/
 * …/projects/<book>/…`, and a report that cannot find its own EPUB on this
 * machine would be drawn as orphaned when it is nothing of the kind.
 */
function translateLibraryPath(storedPath: string): string | null {
  if (!storedPath) return null;
  const normalized = storedPath.replace(/\\/g, '/');
  for (const subdir of ['/projects/', '/files/', '/media/', '/cache/', '/logs/']) {
    const idx = normalized.indexOf(subdir);
    if (idx === -1) continue;
    return path.join(getLibraryBasePath(), ...normalized.substring(idx + 1).split('/'));
  }
  return null;
}

function resolveRecordedPath(stored: string | undefined): string {
  if (!stored) return '';
  if (fs.existsSync(stored)) return stored;
  const translated = translateLibraryPath(stored);
  if (translated && fs.existsSync(translated)) return translated;
  return '';
}

function samePath(a: string, b: string): boolean {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** The m4b variants of a project, in manifest order. */
function audiobookVariants(variants: ProjectVariant[]): ProjectVariant[] {
  return variants.filter(v => v.kind === 'audiobook' && v.format.toLowerCase() === 'm4b');
}

/**
 * Every variant with its path resolved against THIS project's directory.
 *
 * Lifted verbatim from `variant:list`, which this replaces for the Versions
 * page: the join happens here, in the call that produces the row, so nothing in
 * the renderer ever crosses one book's directory with another book's record.
 */
async function resolveVariants(
  projectDir: string,
  variants: ProjectVariant[],
): Promise<ResolvedProjectVariant[]> {
  return Promise.all(variants.map(async (v) => {
    const resolveRel = async (rel: string): Promise<{ abs: string; isFile: boolean }> => {
      const abs = normalizeFsPath(path.join(projectDir, ...rel.split('/')));
      try {
        return { abs, isFile: (await fs.promises.stat(abs)).isFile() };
      } catch {
        // Missing or unreadable is a legitimate answer — a deleted or not-yet-
        // synced file — reported as exists:false. Callers decide what to do.
        return { abs, isFile: false };
      }
    };
    const file = await resolveRel(v.path);
    const vtt = v.vttPath ? await resolveRel(v.vttPath) : null;
    return {
      ...v,
      absPath: file.abs,
      exists: file.isFile,
      vttAbsPath: vtt ? vtt.abs : null,
      vttExists: vtt ? vtt.isFile : false,
    };
  }));
}

/**
 * The content-analysis report row, from the project's own stage folder.
 *
 * Ported out of `editor:get-versions`, which produced this as one entry among
 * a dozen document rows the flat page stopped drawing in Wave 1. This is the
 * only one it still reads, so it is the only one that survived the move.
 *
 * The legacy reconciliation is the one deliberate change. A report with no
 * `target` used to be matched against the CHAIN rows that handler built, whose
 * ids ('generated', 'translated-de', `archive:…`) no button on the flat page can
 * act on — the match produced an id the page could only ever draw as orphaned.
 * It is matched against the VARIANTS instead: the rows the page actually draws,
 * by exact path, with no fallback. Nothing matching is still `versionId: null`,
 * and the page still says "analyzed version no longer available".
 */
async function readAnalysisEntry(
  projectDir: string,
  variants: ResolvedProjectVariant[],
): Promise<VersionsAnalysisEntry | null> {
  const analysisDir = path.join(projectDir, 'stages', '04-analysis');
  const reportPath = path.join(analysisDir, 'analysis.json');
  const checkpointPath = path.join(analysisDir, 'analysis-progress.json');
  const activePath = fs.existsSync(reportPath)
    ? reportPath
    : fs.existsSync(checkpointPath) ? checkpointPath : null;
  if (!activePath) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(activePath, 'utf-8'));
    const isCheckpoint = activePath === checkpointPath;
    const flagCount: number = isCheckpoint
      ? data.flags?.length ?? 0
      : data.statistics?.totalFlags ?? data.flags?.length ?? 0;
    const storedEpubPath = resolveRecordedPath(
      (isCheckpoint ? data.sourceEpubPath : data.epubPath) || '');

    // A report written after the per-version feature carries its target
    // verbatim. Use it and never re-point — a report that has said which
    // version it is about is not up for reinterpretation.
    const storedTarget = !isCheckpoint ? data.target : null;
    let target: VersionsAnalysisEntry['target'];
    if (storedTarget?.versionId) {
      target = {
        versionId: storedTarget.versionId,
        versionType: storedTarget.versionType || '',
        versionLabel: storedTarget.versionLabel || '',
      };
    } else {
      const match = variants.find(v => samePath(v.absPath, storedEpubPath));
      target = match
        ? {
          versionId: match.id,
          versionType: match.kind,
          versionLabel: (match.metadata?.title || match.descriptor || '').trim(),
        }
        : { versionId: null, versionType: '', versionLabel: '' };
    }

    const targetRow = target.versionId ? variants.find(v => v.id === target.versionId) : undefined;
    const analyzedFilePath = targetRow?.absPath ?? storedEpubPath;
    const stat = await fs.promises.stat(activePath);
    return {
      path: analyzedFilePath,
      modifiedAt: stat.mtime.toISOString(),
      flagCount,
      isCheckpoint,
      target,
    };
  } catch (err) {
    // Said, not swallowed: a report that exists and will not parse is a fact the
    // user is entitled to, and returning null here would draw the page as though
    // no analysis had ever been run.
    console.warn(
      `[versions-page-data] ${path.basename(projectDir)}: the content-analysis report at `
      + `${activePath} could not be read (${(err as Error).message}); no analysis row is drawn.`);
    return null;
  }
}

/**
 * The Versions page's whole entry payload, cheap.
 *
 * Every read below is a manifest parse, a stat, or a small JSON. Nothing here
 * opens an audiobook.
 */
export async function readVersionsPageData(projectId: string): Promise<VersionsPageData> {
  const got = await getManifest(projectId);
  if (!got.success || !got.manifest) {
    throw new Error(got.error || `Project not found: ${projectId}`);
  }
  const projectDir = getProjectPath(projectId);
  const { variants, primaryVariantId } = getVariants(got.manifest);
  const resolved = await resolveVariants(projectDir, variants);
  const analysis = await readAnalysisEntry(projectDir, resolved);

  const audiobooks: AudiobookFacts[] = [];
  for (const variant of audiobookVariants(variants)) {
    const row = resolved.find(r => r.id === variant.id);
    if (!row) throw new Error(`Variant ${variant.id} was resolved out of its own project`);
    audiobooks.push(await readCachedAudiobookFacts(got.manifest, projectDir, variant, row.absPath));
  }

  return {
    variants: resolved,
    primaryVariantId,
    ttsVariantId: got.manifest.ttsVariantId,
    analysis,
    audiobooks,
    audiobookFactsComplete: audiobooks.every(
      f => f.transcript !== 'deriving' && f.reportStatus !== 'deriving'),
  };
}

/** Where a variant's recorded analysis report is, absolute — or null when none is recorded. */
function recordedReportPath(
  manifest: { audiobookAnalyses?: Record<string, { reportPath: string }> },
  projectDir: string,
  variantId: string,
): string | null {
  const entry = manifest.audiobookAnalyses?.[variantId];
  if (!entry?.reportPath) return null;
  return path.join(projectDir, ...entry.reportPath.split('/'));
}

/** {@link cachedFacts}, with the report path this variant's manifest records. */
async function readCachedAudiobookFacts(
  manifest: { audiobookAnalyses?: Record<string, { reportPath: string }> },
  projectDir: string,
  variant: ProjectVariant,
  m4bAbsPath: string,
): Promise<AudiobookFacts> {
  const m4bIdentity = await readFileIdentity(m4bAbsPath);
  if (!m4bIdentity) {
    return {
      variantId: variant.id,
      transcript: 'ineligible',
      cueCount: null,
      reportStatus: 'missing',
      analyzedAt: null,
      flagCount: null,
    };
  }
  const transcript = getDerived<TranscriptFact>(NS_TRANSCRIPT, m4bAbsPath, m4bIdentity);
  const reportPath = recordedReportPath(manifest, projectDir, variant.id);
  const report = await readCachedReport(reportPath, m4bIdentity);
  return {
    variantId: variant.id,
    transcript: transcript ? (transcript.eligible ? 'eligible' : 'ineligible') : 'deriving',
    cueCount: transcript ? transcript.cueCount : null,
    ...report,
  };
}

/**
 * The report verdict, when one is remembered against BOTH files it is about.
 *
 * A verification asks whether the report's binding still matches the current
 * audiobook AND the current report bytes. If neither file has moved since the
 * verdict was reached, the verdict is still the answer — which is exactly a
 * (mtime, size) key on each. The report file's identity is the cache key; the
 * audiobook's is stored inside the value and re-checked here, because one entry
 * cannot be keyed on two files.
 *
 * No recorded report at all is `missing` and is not a derivation: the manifest
 * saying nothing about this variant IS the final answer.
 */
async function readCachedReport(
  reportAbsPath: string | null,
  m4b: FileIdentity,
): Promise<Pick<AudiobookFacts, 'reportStatus' | 'analyzedAt' | 'flagCount'>> {
  if (!reportAbsPath) {
    return { reportStatus: 'missing', analyzedAt: null, flagCount: null };
  }
  const reportIdentity = await readFileIdentity(reportAbsPath);
  if (!reportIdentity) {
    // The manifest points at a report that is not there. `verifyAudiobookAnalysis`
    // calls that stale, and so does this — no derivation needed to see it.
    return { reportStatus: 'stale', analyzedAt: null, flagCount: null };
  }
  const fact = getDerived<ReportFact>(NS_REPORT, reportAbsPath, reportIdentity);
  if (!fact) return { reportStatus: 'deriving', analyzedAt: null, flagCount: null };
  if (fact.m4bMtimeMs !== m4b.mtimeMs || fact.m4bSize !== m4b.size) {
    return { reportStatus: 'deriving', analyzedAt: null, flagCount: null };
  }
  return { reportStatus: fact.status, analyzedAt: fact.analyzedAt, flagCount: fact.flagCount };
}

/**
 * Derive what the cache was missing, remember it, and hand back the finished facts.
 *
 * The SLOW half. Run in the background by the `versions:page-data` handler and
 * pushed to the window when it lands; run directly by anything headless that
 * wants the answers rather than the page.
 *
 * A derivation that throws is a REFUSAL for that one audiobook — recorded as
 * ineligible with the reason on the console, exactly as the handler this
 * replaces did — and never a refusal for the book. One unreadable m4b among
 * three must not cost the other two their buttons.
 */
export async function deriveAudiobookFacts(projectId: string): Promise<AudiobookFacts[]> {
  const got = await getManifest(projectId);
  if (!got.success || !got.manifest) {
    throw new Error(got.error || `Project not found: ${projectId}`);
  }
  const manifest = got.manifest;
  const projectDir = getProjectPath(projectId);
  const { variants } = getVariants(manifest);
  const out: AudiobookFacts[] = [];

  for (const variant of audiobookVariants(variants)) {
    const m4bAbsPath = normalizeFsPath(path.join(projectDir, ...variant.path.split('/')));
    const m4bIdentity = await readFileIdentity(m4bAbsPath);
    if (!m4bIdentity) {
      out.push({
        variantId: variant.id,
        transcript: 'ineligible',
        cueCount: null,
        reportStatus: 'missing',
        analyzedAt: null,
        flagCount: null,
      });
      continue;
    }

    // ── Is there an authoritative transcript ────────────────────────────────
    let transcript = getDerived<TranscriptFact>(NS_TRANSCRIPT, m4bAbsPath, m4bIdentity);
    if (!transcript) {
      try {
        const source = await resolveAudiobookTranscriptSource(projectId, variant.id);
        transcript = { eligible: true, cueCount: source.cues.length, refusal: null };
      } catch (err) {
        const refusal = (err as Error).message;
        console.warn(
          `[versions-page-data] ${projectId}: audiobook ${variant.id} carries no analyzable `
          + `transcript — ${refusal}`);
        transcript = { eligible: false, cueCount: null, refusal };
      }
      // Re-stat before remembering: the ffmpeg extract above takes a second or
      // more, and a fact remembered against bytes that changed underneath it is
      // the one wrong answer this cache must never give.
      const after = await readFileIdentity(m4bAbsPath);
      if (after && after.mtimeMs === m4bIdentity.mtimeMs && after.size === m4bIdentity.size) {
        putDerived<TranscriptFact>(NS_TRANSCRIPT, m4bAbsPath, m4bIdentity, transcript);
      } else {
        console.warn(
          `[versions-page-data] ${projectId}: ${path.basename(m4bAbsPath)} changed while its `
          + 'transcript was being read; the answer is used once and not remembered.');
      }
    }

    // ── Does its recorded analysis report still stand ───────────────────────
    const reportAbsPath = recordedReportPath(manifest, projectDir, variant.id);
    let report = await readCachedReport(reportAbsPath, m4bIdentity);
    if (report.reportStatus === 'deriving' && reportAbsPath) {
      const reportIdentity = await readFileIdentity(reportAbsPath);
      if (!reportIdentity) {
        report = { reportStatus: 'stale', analyzedAt: null, flagCount: null };
      } else {
        const verified = await verifyAudiobookAnalysis<{
          analyzedAt?: string;
          statistics?: { totalFlags?: number };
        }>(projectId, variant.id);
        const fact: ReportFact = {
          status: verified.status,
          m4bMtimeMs: m4bIdentity.mtimeMs,
          m4bSize: m4bIdentity.size,
          analyzedAt: verified.status === 'valid'
            ? verified.report.payload.analyzedAt || verified.manifestEntry.analyzedAt
            : null,
          flagCount: verified.status === 'valid'
            ? verified.report.payload.statistics?.totalFlags ?? null
            : null,
        };
        putDerived<ReportFact>(NS_REPORT, reportAbsPath, reportIdentity, fact);
        report = {
          reportStatus: fact.status, analyzedAt: fact.analyzedAt, flagCount: fact.flagCount,
        };
      }
    }

    out.push({
      variantId: variant.id,
      transcript: transcript.eligible ? 'eligible' : 'ineligible',
      cueCount: transcript.cueCount,
      ...report,
    });
  }
  return out;
}

/**
 * The derivations currently running, one per project.
 *
 * A user clicking between two books and back would otherwise start ffmpeg over
 * the same 3 GB audiobook twice, and the second run would win a race with the
 * first over the same cache entry. One run per project, and every waiter gets
 * its answer.
 */
const inFlight = new Map<string, Promise<AudiobookFacts[]>>();

/**
 * Derive this project's audiobook facts off the page's critical path.
 *
 * `onDerived` is called with the finished facts — once, and only on success.
 * A failure is SAID and then dropped: the page is already drawn, its Generate
 * buttons are already disabled saying the check is still running, and a book
 * whose manifest cannot be read has nothing to push. The next visit retries.
 */
export function deriveAudiobookFactsInBackground(
  projectId: string,
  onDerived: (facts: AudiobookFacts[]) => void,
): void {
  const running = inFlight.get(projectId);
  if (running) {
    void running.then(onDerived, () => { /* the first caller already said why */ });
    return;
  }
  const work = deriveAudiobookFacts(projectId);
  inFlight.set(projectId, work);
  void work.then(
    (facts) => { inFlight.delete(projectId); onDerived(facts); },
    (err: Error) => {
      inFlight.delete(projectId);
      console.warn(
        `[versions-page-data] ${projectId}: its audiobooks could not be checked for transcripts `
        + `(${err.message}); the Versions page keeps its Generate buttons disabled until a `
        + 'later visit succeeds.');
    });
}

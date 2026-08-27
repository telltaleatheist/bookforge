/**
 * Reassembly Bridge - Scans e2a tmp folder for incomplete sessions and handles reassembly
 */

import { publishBridgeEvent } from './bridge-events';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { getDefaultE2aPath, getDefaultE2aTmpPath, getPythonInvocation, getWslDistro, getWslCondaPath, getWslE2aPath, windowsToWslPath, wslToWindowsPath, buildCondaSpawnEnv, shellEscapeArgs } from './e2a-paths';
import * as os from 'os';
import { getMetadataToolPath, applyMetadata, AudiobookMetadata, optimizeCoverForM4b, embedAndVerifyVtt, deleteSidecarsForM4b, probeAudio, isEmbedTempFileName } from './metadata-tools';
import { renameWithRetry, unlinkWithRetry, isTransientFsError } from './fs-retry';
import { getReassemblyLogger } from './rolling-logger';
import * as manifestService from './manifest-service';
import { enhanceSentences, rvcEnhancementReady } from './rvc-bridge';
import { denoiseSentences, finalDenoiseReady, normalizeSentenceGaps } from './denoise-bridge';
import { getRvcVoiceById, resolveRvcIndexRate } from './rvc-models';
import { registerRvcAudiobookVariant, resolveRvcVariantFiling } from './audiobook-variant-filing';
import { sumFlacDurationsSeconds } from './flac-duration';
import { resolveOrpheusPostRenderFilter, resolveOrpheusSentenceGap, resolveOrpheusMinChunkGap, DEFAULT_SENTENCE_GAP } from './orpheus-models';
import { regenerateBoundSidecars } from './sidecar-migration';
import { resolveClosedSession } from './chapter-closer';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { StageTracker, type StageSpec, type JobStageProgress } from './job-stages';

/**
 * The end timestamp of the LAST cue in a VTT, in seconds — or null when the text
 * carries no cue. The assembly that writes the m4b writes this VTT from the same
 * sentence set in the same pass, so its final cue end IS the length the audio is
 * supposed to have, including partial (excluded-chapter) assemblies.
 */
function lastVttCueEndSeconds(vttText: string): number | null {
  let last: number | null = null;
  const cueRe = /-->\s+(\d{2,}):(\d{2}):(\d{2})\.(\d{3})/g;
  let m: RegExpExecArray | null;
  while ((m = cueRe.exec(vttText)) !== null) {
    last = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }
  return last;
}

const MAX_STDERR_BYTES = 10 * 1024;
function appendCapped(buf: string, chunk: string): string {
  buf += chunk;
  if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(-MAX_STDERR_BYTES);
  return buf;
}

/**
 * Check if a path is a WSL UNC path (\\wsl$\... or \\wsl.localhost\...)
 */
function isWslPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return /^\/\/wsl[\$.](?:localhost)?\//.test(normalized);
}

/**
 * Convert UNC WSL paths back to native WSL paths.
 * Handles any distro name and both \\wsl$ and \\wsl.localhost forms.
 */
function uncToWslPath(p: string): string {
  const uncMatch = p.replace(/\\/g, '/').match(/^\/\/wsl[\$.](?:localhost)?\/[^/]+\/(.*)/);
  if (uncMatch) {
    return '/' + uncMatch[1];
  }
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    return windowsToWslPath(p);
  }
  return p;
}

/** Shell-quote a string for safe use in a bash -c command */
function shellQuoteArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build WSL bash command for assembly
 * First argument in appArgs is the Windows app.py path - we skip it and use WSL native path
 */
function buildWslAssemblyCommand(
  appArgs: string[],
  outputDir: string
): string {
  const wslCondaPath = getWslCondaPath();
  const wslE2aPath = getWslE2aPath();

  // Skip the first argument (Windows app.py path) - we'll use WSL native path
  const argsWithoutAppPath = appArgs.slice(1);

  // Convert remaining args - replace Windows paths with WSL paths
  const wslArgs = argsWithoutAppPath.map(arg => {
    // Convert Windows drive paths (C:\...) to WSL paths (/mnt/c/...)
    if (arg.match(/^[A-Za-z]:\\/)) {
      return windowsToWslPath(arg);
    }
    // Convert UNC WSL paths (\\wsl$\..., \\wsl.localhost\...) to native WSL paths
    if (isWslPath(arg)) {
      return uncToWslPath(arg);
    }
    // Already a WSL path or flag - pass through
    return arg;
  });

  const q = shellQuoteArg;
  const cdCommand = `cd ${q(wslE2aPath)}`;
  // Use WSL native app.py path
  const wslAppPath = `${wslE2aPath}/app.py`;
  const quotedArgs = wslArgs.map(a => q(a)).join(' ');
  const condaCommand = `${q(wslCondaPath)} run --no-capture-output -p ${q(`${wslE2aPath}/python_env`)} python ${q(wslAppPath)} ${quotedArgs}`;

  return `${cdCommand} && ${condaCommand}`;
}

// The e2a app path (uses cross-platform detection)
const E2A_APP_PATH = getDefaultE2aPath();

/**
 * project.json metadata that can be linked to e2a sessions
 */
interface ProjectJsonMetadata {
  projectJsonPath: string;          // Path to project.json
  title?: string;
  author?: string;
  year?: string;
  coverPath?: string;
  narrator?: string;
  series?: string;
  seriesNumber?: string;
  genre?: string;
  description?: string;
  outputFilename?: string;
}

/**
 * Get project.json metadata from source_epub_path
 * The session's source_epub_path points directly to the project output folder (e.g., .../projects/Book_Name/output/cleaned.epub)
 * Metadata comes from project.json - if it doesn't exist, there is no metadata
 */
async function getProjectJsonMetadataFromSourcePath(sourceEpubPath: string | undefined): Promise<ProjectJsonMetadata | null> {
  if (!sourceEpubPath) return null;

  // Convert WSL path to Windows if needed
  let windowsPath = sourceEpubPath;
  if (sourceEpubPath.startsWith('/mnt/')) {
    windowsPath = wslToWindowsPath(sourceEpubPath);
  }

  // Get the project folder (parent of the EPUB this session was rendered from)
  const projectFolder = path.dirname(windowsPath);

  // project.json is the single source of truth for this metadata
  const projectJsonPath = path.join(projectFolder, 'project.json');

  try {
    const content = await fs.promises.readFile(projectJsonPath, 'utf-8');
    const project = JSON.parse(content);

    const projectJsonMetadata: ProjectJsonMetadata = {
      projectJsonPath: projectJsonPath,
      title: project.metadata?.title,
      author: project.metadata?.author,
      year: project.metadata?.year,
      coverPath: project.metadata?.coverPath,
      narrator: project.metadata?.narrator,
      series: project.metadata?.series,
      seriesNumber: project.metadata?.seriesNumber,
      genre: project.metadata?.genre,
      description: project.metadata?.description,
      outputFilename: project.metadata?.outputFilename
    };

    // Resolve relative cover path to absolute
    if (projectJsonMetadata.coverPath && !path.isAbsolute(projectJsonMetadata.coverPath)) {
      const absoluteCoverPath = path.join(projectFolder, projectJsonMetadata.coverPath);
      try {
        await fs.promises.access(absoluteCoverPath);
        projectJsonMetadata.coverPath = absoluteCoverPath;
      } catch {
        // Relative path doesn't exist — clear it so manifest fallback can kick in
        projectJsonMetadata.coverPath = undefined;
      }
    } else if (projectJsonMetadata.coverPath && path.isAbsolute(projectJsonMetadata.coverPath)) {
      // Absolute path — verify it exists (may be from another platform)
      try {
        await fs.promises.access(projectJsonMetadata.coverPath);
      } catch {
        console.warn(`[REASSEMBLY] project.json cover path not found (cross-platform?): ${projectJsonMetadata.coverPath}`);
        projectJsonMetadata.coverPath = undefined;
      }
    }

    return projectJsonMetadata;
  } catch {
    return null;
  }
}

// Derive the e2a app path from the tmp path (parent directory)
// Falls back to E2A_APP_PATH if the derived path doesn't have the assembly features
function getE2aAppPath(tmpPath: string): string {
  // Always use the app path that supports --title/--author/--cover
  // The tmp path may be different (e.g., ebook2audiobook-latest/tmp)
  return E2A_APP_PATH;
}

// Format seconds as human-readable ETA (e.g., "2m 30s")
function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

// Escape a string for safe use as a shell argument (wrap in quotes, escape internal quotes)
function escapeShellArg(arg: string): string {
  // Wrap in double quotes and escape internal double quotes and backslashes
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Types
export interface E2aSession {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  metadata: {
    title?: string;
    author?: string;
    language?: string;
    epubPath?: string;
    coverPath?: string;
    // Extended metadata (saved by BookForge)
    year?: string;
    narrator?: string;
    series?: string;
    seriesNumber?: string;
    genre?: string;
    description?: string;
    outputFilename?: string;
  };
  totalSentences: number;
  completedSentences: number;
  percentComplete: number;
  chapters: E2aChapter[];
  createdAt: string;  // ISO string for IPC serialization
  modifiedAt: string; // ISO string for IPC serialization
  projectJsonPath?: string;   // Path to the linked project.json (if found)
  source?: 'e2a-tmp' | 'project-cache';  // Where this session was found
  /** What originally produced these cached sentences — TTS engine + voice —
   *  read from BookForge's session_state.json (underscore). Undefined for
   *  sessions generated before provenance was recorded. Shown in the assemble
   *  step so the user knows the source of the cached files they're reassembling. */
  provenance?: { ttsEngine?: string; voice?: string };
}

export interface E2aChapter {
  chapterNum: number;
  title?: string;
  sentenceStart: number;
  sentenceEnd: number;
  sentenceCount: number;
  completedCount: number;
  excluded: boolean;
}

export interface ReassemblyConfig {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  outputDir: string;
  e2aTmpPath?: string;  // Path to e2a tmp folder from settings - app path is derived from this
  totalChapters?: number;  // Total chapters for progress display (excluding excluded ones)
  metadata: {
    title: string;
    author: string;
    year?: string;
    coverPath?: string;
    outputFilename?: string;
    // Extended metadata for m4b-tool
    narrator?: string;
    series?: string;
    seriesNumber?: string;
    genre?: string;
    description?: string;
  };
  excludedChapters: number[];
  /** Optional RVC voice-enhancement pass run BEFORE assembly: convert the cached
   *  XTTS sentences through an RVC voice into a tmp dir, then assemble THAT set.
   *  The cached XTTS sentences are left untouched, so the same session can be
   *  re-enhanced later with a different voice. voiceId is the RVC asset id. */
  rvcEnhancement?: {
    voiceId: string;
    indexRate?: number;
    /** INVERTED — lower protects more, 0.5 is off. See PROTECT_RATE_NOTE. */
    protectRate?: number;
    nSemitones?: number;
    /** Both absent = urvc's own default. */
    f0Method?: string;
    hopLength?: number;
  };
  /** A pre-rendered set of sentence files (produced by an upstream
   *  'rvc-enhancement' queue job, under [library]/tmp). When set, assemble THIS
   *  set via --sentences_dir and delete it afterward (merge-and-delete). Takes
   *  precedence over the inline `rvcEnhancement` pass, which then doesn't run. */
  sentencesDir?: string;
  /** Final-audio denoise: run the block-based roformer pass (denoise-bridge) over
   *  the session's sentences BEFORE assembly (and before any inline RVC pass —
   *  denoise first, then RVC). When `sentencesDir` is set, the upstream
   *  rvc-enhancement job already applied it (it receives the same flag), so it's
   *  not re-run here. false/absent = zero behavioral change. */
  finalDenoise?: boolean;
  /** De-ring: apply the session voice's per-voice post-render ffmpeg filter chain
   *  (the notch/comb that removes SNAC tonal ringing) at e2a's final encode. OPT-IN
   *  — resolved from session provenance ONLY when this is true. Absent/false → no
   *  filter is passed and assembly encodes the raw sentences unchanged. (Was
   *  previously auto-applied from provenance for every Orpheus session; now gated.) */
  applyDeRing?: boolean;
  /** Assembly-time inter-sentence gap in seconds. Normalizes the silence between
   *  sentences on the RAW cached set BEFORE denoise: strips e2a's artificial trailing
   *  exact-zero pad and re-applies exactly this much silence. When set, this value wins.
   *  When absent, provenance decides: an ORPHEUS session always normalizes — using the
   *  voice's tuned model value (resolveOrpheusSentenceGap) or, when the model is untested,
   *  the visible DEFAULT_SENTENCE_GAP (0.6s, which reproduces the historical baked gap).
   *  A NON-Orpheus session yields no value → the gap step is skipped (raw sentences
   *  unchanged; gap normalization is Orpheus-specific and strips a pad only Orpheus bakes). */
  sentenceGap?: number;
  /**
   * FILE THE RESULT AS A SECOND AUDIOBOOK, beside the project's own, instead of
   * replacing it.
   *
   * True only for a run that converted sentences it did NOT render (see
   * `registerAsNewVariant` in shared/queue/narration-run.ts). Three things
   * change: the M4B is written under a name carrying the voice, the promotion
   * step does not sweep away the audiobooks already in the output folder, and
   * the result is recorded as a manifest VARIANT rather than overwriting
   * `outputs.audiobook`.
   */
  registerAsNewVariant?: boolean;
  /**
   * The RVC voice that run converted through — REQUIRED when
   * `registerAsNewVariant` is set, because it is what the second audiobook is
   * NAMED: its variant id, its filename and its narrator tag all come from here.
   */
  rvcVoiceId?: string;
}

export interface ReassemblyProgress {
  phase: 'preparing' | 'combining' | 'encoding' | 'metadata' | 'complete' | 'error';
  percentage: number;
  currentChapter?: number;
  totalChapters?: number;
  message?: string;
  error?: string;
  /**
   * Per-stage bars for THIS run. Absent on the terminal error events (there is no
   * meaningful stage state to report once the run has failed) — the renderer keeps
   * whatever it last received rather than blanking the bars.
   */
  stages?: JobStageProgress[];
}

/**
 * Reassembly's stage plan.
 *
 * Weights are RELATIVE shares of wall-clock time, normalized by StageTracker — a
 * 3,000-sentence RVC pass genuinely dwarfs writing chapter markers, and the old
 * fixed 0-50/50-65/65-90/90-100 percentage bands didn't say so. The three optional
 * pre-passes are only declared when the run actually performs them, so a plain
 * assembly shows four bars and an RVC+denoise assembly shows seven.
 */
const STAGE_GAP: StageSpec = { name: 'gap', label: 'Normalizing sentence gaps', weight: 7 };
const STAGE_DENOISE: StageSpec = { name: 'denoise', label: 'Denoising audio', weight: 18 };
const STAGE_RVC: StageSpec = { name: 'rvc', label: 'Enhancing voice', weight: 25 };
/** H:MM for progress messages — "0:41 of 34:29" reads as movement even between ticks. */
function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

/**
 * Weights MEASURED, not guessed — from a 35.85-hour, 6,034-chunk assembly, timed off
 * the landmark files each phase writes:
 *
 *   normalize gaps        157 s    combine 28 chapters   151 s
 *   build subtitles       306 s    concat -> 2.8 GB FLAC  51 s
 *   encode -> M4B      ~1680 s     metadata             ~100 s
 *
 * The old weights described a different job. `combine` claimed 40 of 78 — half the bar
 * for 6% of the work — so the headline leapt to ~54% in the first four minutes and then
 * crawled, which is exactly the "it's frozen" report. `encode` dominates and was priced
 * at under a third.
 *
 * Two structural changes for the same reason:
 *  - `concat` LOSES its bar. 51 seconds on the largest book there is (8 s on a 6-hour
 *    one) is not a stage, it is a moment; a bar that appears and completes before it can
 *    be read is noise. Its lines now report under `encode`, which is the phase they
 *    belong to.
 *  - `subtitles` GAINS one. Building the VTT is 5 minutes on this book — the third most
 *    expensive phase — and it had no bar at all: it happened while `combine` sat at 100%
 *    and `concat` sat at 0%, so the whole time read as a stall between two stages.
 *
 * Shares are relative and normalized, so these need not sum to anything in particular.
 */
const STAGE_ALWAYS: StageSpec[] = [
  { name: 'combine', label: 'Combining chapters', weight: 6 },
  { name: 'subtitles', label: 'Building subtitles', weight: 13 },
  { name: 'encode', label: 'Encoding M4B', weight: 70 },
  { name: 'metadata', label: 'Chapter markers & metadata', weight: 5 },
];

/**
 * Which coarse `phase` each stage reports. The phase field predates the stage bars
 * and is still what the queue service watches for terminal transitions, so every
 * stage must map onto one.
 */
const STAGE_PHASE: Record<string, ReassemblyProgress['phase']> = {
  gap: 'preparing',
  denoise: 'preparing',
  rvc: 'preparing',
  combine: 'combining',
  subtitles: 'combining',
  encode: 'encoding',
  metadata: 'metadata',
};

// Active reassembly processes
const activeReassemblies = new Map<string, ChildProcess>();

// Active metadata AbortControllers (so stopReassembly can cancel metadata)
const activeMetadataAborts = new Map<string, AbortController>();

// Active heartbeat intervals (so stopReassembly can clear them)
const activeHeartbeats = new Map<string, NodeJS.Timeout>();

// Active staging directories (so stopReassembly and error handlers can clean up)
const activeStagingDirs = new Map<string, string>();

// Active RVC scratch directories (the merge-and-delete enhanced-sentence sets,
// under [library]/tmp). Cleaned alongside the staging dir at every terminal point.
const activeRvcDirs = new Map<string, string>();
/** jobId → the `closed-<sessionId>` dir this assembly is consuming, for cleanup. */
const activeClosedDirs = new Map<string, string>();

/**
 * Does the e2a we are about to run understand --encoded_chapters_dir?
 *
 * BookForge and ebook2audiobook are separate repos on separate release cadences,
 * and e2a exists as THREE checkouts (Windows, the WSL one Orpheus renders in, the
 * Mac one) that routinely sit at different commits. app.py parses with
 * parse_args(), so handing an older checkout a flag it does not know is not a
 * degraded run — it is an immediate exit 2 with the whole assembly lost.
 *
 * So this is checked, not assumed. When the answer is no, the pre-closed chapters
 * are simply not used and assembly does the work itself, which is the same thing
 * that happens for a session the closer never touched.
 */
function e2aSupportsEncodedChapters(): boolean {
  const argsFile = path.join(getDefaultE2aPath(), 'bookforge_ext', 'parallel', 'args.py');
  try {
    return fs.readFileSync(argsFile, 'utf8').includes('--encoded_chapters_dir');
  } catch {
    return false;
  }
}

/**
 * Remove a job's staging dir AND its RVC scratch dir (if any), and clear the map
 * entries. Logs but does not throw on failure. Called at every reassembly
 * terminal point (success / error / stop), so the RVC-enhanced sentences are
 * merged into the M4B and then deleted — never left behind in the project.
 */
function cleanupStagingDir(jobId: string): void {
  const stagingDir = activeStagingDirs.get(jobId);
  if (stagingDir) {
    activeStagingDirs.delete(jobId);
    try {
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        console.log(`[REASSEMBLY] Cleaned up staging dir: ${stagingDir}`);
      }
    } catch (err) {
      console.warn('[REASSEMBLY] Failed to clean up staging dir (non-fatal):', err);
    }
  }

  const rvcDir = activeRvcDirs.get(jobId);
  if (rvcDir) {
    activeRvcDirs.delete(jobId);
    try {
      if (fs.existsSync(rvcDir)) {
        fs.rmSync(rvcDir, { recursive: true, force: true });
        console.log(`[REASSEMBLY] Cleaned up RVC scratch dir: ${rvcDir}`);
      }
    } catch (err) {
      console.warn('[REASSEMBLY] Failed to clean up RVC scratch dir (non-fatal):', err);
    }
  }

  // What the chapter closer produced for this session: a full normalized sentence
  // set plus every encoded chapter, ~2.9 GB on a 20-hour book. It is consumed by
  // exactly one assembly, so it goes when that assembly ends — on ANY terminal path,
  // success or not. A retry re-does the work rather than inheriting a set nobody
  // re-verified. Cleaning it here rather than at each exit means it cannot be missed
  // by whichever return an error happens to take.
  const closedDir = activeClosedDirs.get(jobId);
  if (closedDir) {
    activeClosedDirs.delete(jobId);
    try {
      if (fs.existsSync(closedDir)) {
        fs.rmSync(closedDir, { recursive: true, force: true });
        console.log(`[REASSEMBLY] Cleaned up pre-closed chapter dir: ${closedDir}`);
      }
    } catch (err) {
      console.warn('[REASSEMBLY] Failed to clean up pre-closed chapter dir (non-fatal):', err);
    }
  }
}

/**
 * Scan the e2a tmp folder for incomplete sessions
 * project.json metadata is extracted from each session's source_epub_path
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function scanE2aTmpFolder(customTmpPath?: string): Promise<{ sessions: E2aSession[]; tmpPath: string }> {
  const sessions: E2aSession[] = [];
  const tmpPath = customTmpPath || getDefaultE2aTmpPath();

  // Scan e2a tmp folder for active sessions (async I/O to avoid blocking main process)
  try {
    const entries = await fs.promises.readdir(tmpPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('ebook-')) continue;
      const sessionDir = path.join(tmpPath, entry.name);
      const sessionId = entry.name.replace('ebook-', '');
      try {
        const session = await parseSession(sessionId, sessionDir);
        if (session) {
          session.source = 'e2a-tmp';
          sessions.push(session);
        }
      } catch (err) {
        console.error(`[REASSEMBLY] Error parsing session ${sessionId}:`, err);
      }
    }
  } catch {
    // tmp folder doesn't exist — that's fine
  }

  // Sort by modification date, newest first
  sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  return { sessions, tmpPath };
}

/**
 * Parse a single session directory
 * project.json metadata is extracted from source_epub_path in the session state
 */
async function parseSession(sessionId: string, sessionDir: string): Promise<E2aSession | null> {
  // Find the hash subfolder (async)
  const subEntries = await fs.promises.readdir(sessionDir, { withFileTypes: true });
  const hashDir = subEntries.find(e => e.isDirectory());

  if (!hashDir) {
    return null;
  }

  const processDir = path.join(sessionDir, hashDir.name);
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');

  // Check if sentences folder exists (async)
  try {
    await fs.promises.access(sentencesDir);
  } catch {
    return null;
  }

  // Parse session state + chapter sentences + read sentence files — all async, in parallel
  const [sessionState, chapterSentences, sentenceFiles, stats, provenance] = await Promise.all([
    parseSessionState(processDir),
    parseChapterSentences(processDir),
    fs.promises.readdir(sentencesDir).catch(() => [] as string[]),
    fs.promises.stat(sessionDir),
    parseSessionProvenance(processDir)
  ]);

  // Single pass over sentence files: count completed, estimate total, build sets for chapters
  const completedSetNew = new Set<number>();
  const completedSetOld = new Set<number>();
  let hasNewFormat = false;
  let hasOldFormat = false;
  let maxNumNew = -1;
  let maxNumOld = 0;

  for (const file of sentenceFiles) {
    const matchNew = file.match(/^(\d+)\.flac$/);
    if (matchNew) {
      hasNewFormat = true;
      const num = parseInt(matchNew[1], 10);
      completedSetNew.add(num);
      if (num > maxNumNew) maxNumNew = num;
    }
    const matchOld = file.match(/^sentence_(\d+)\.flac$/);
    if (matchOld) {
      hasOldFormat = true;
      const num = parseInt(matchOld[1], 10);
      completedSetOld.add(num);
      if (num > maxNumOld) maxNumOld = num;
    }
  }

  const completedSentences = completedSetNew.size + completedSetOld.size;

  // Determine total sentences
  let totalSentences = sessionState?.total_sentences || chapterSentences?.total_sentences || 0;
  if (totalSentences === 0) {
    totalSentences = maxNumNew >= 0 ? maxNumNew + 1 : maxNumOld;
  }

  // Build chapter info from the already-read file list (no additional readdir)
  const chapterTitles: string[] = sessionState?.chapter_titles || [];
  const chaptersData = sessionState?.chapters || chapterSentences?.chapters || [];
  const chapters: E2aChapter[] = chaptersData.map((ch: any, index: number) => {
    let completedCount = 0;
    for (let i = ch.sentence_start; i <= ch.sentence_end; i++) {
      if (hasNewFormat && completedSetNew.has(i)) completedCount++;
      else if (hasOldFormat && completedSetOld.has(i + 1)) completedCount++;
    }
    return {
      chapterNum: ch.chapter_num,
      title: chapterTitles[index] || ch.title,
      sentenceStart: ch.sentence_start,
      sentenceEnd: ch.sentence_end,
      sentenceCount: ch.sentence_count,
      completedCount,
      excluded: false
    };
  });

  // Get project.json metadata from source_epub_path
  const projectJsonMetadata = await getProjectJsonMetadataFromSourcePath(sessionState?.source_epub_path);

  let metadata: E2aSession['metadata'];
  if (projectJsonMetadata) {
    metadata = {
      title: projectJsonMetadata.title,
      author: projectJsonMetadata.author,
      language: sessionState?.metadata?.language,
      epubPath: sessionState?.source_epub_path,
      coverPath: projectJsonMetadata.coverPath,
      year: projectJsonMetadata.year,
      narrator: projectJsonMetadata.narrator,
      series: projectJsonMetadata.series,
      seriesNumber: projectJsonMetadata.seriesNumber,
      genre: projectJsonMetadata.genre,
      description: projectJsonMetadata.description,
      outputFilename: projectJsonMetadata.outputFilename
    };
  } else {
    metadata = {
      title: sessionState?.metadata?.title,
      author: sessionState?.metadata?.creator,
      language: sessionState?.metadata?.language,
      epubPath: sessionState?.epub_path,
      coverPath: findCoverImage(processDir),
      year: undefined, narrator: undefined, series: undefined,
      seriesNumber: undefined, genre: undefined, description: undefined,
      outputFilename: undefined
    };
  }

  return {
    sessionId,
    sessionDir,
    processDir,
    metadata,
    totalSentences,
    completedSentences,
    percentComplete: totalSentences > 0 ? Math.round((completedSentences / totalSentences) * 100) : 0,
    chapters,
    createdAt: stats.birthtime.toISOString() as any,
    modifiedAt: stats.mtime.toISOString() as any,
    projectJsonPath: projectJsonMetadata?.projectJsonPath,
    provenance: provenance ?? undefined
  };
}

/**
 * Parse session-state.json if it exists (async)
 */
async function parseSessionState(processDir: string): Promise<any | null> {
  const statePath = path.join(processDir, 'session-state.json');
  try {
    const content = await fs.promises.readFile(statePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read TTS-engine/voice provenance from BookForge's session_state.json (the
 * underscore file — NOT e2a's session-state.json, which omits this). Returns the
 * engine + voice that produced the cached sentences, or null when absent (older
 * sessions, or e2a-only). `fineTuned` is e2a's term for the voice.
 */
async function parseSessionProvenance(
  processDir: string
): Promise<{ ttsEngine?: string; voice?: string } | null> {
  const statePath = path.join(processDir, 'session_state.json');
  try {
    const content = await fs.promises.readFile(statePath, 'utf-8');
    const settings = JSON.parse(content)?.settings;
    if (!settings) return null;
    const ttsEngine = settings.ttsEngine || undefined;
    const voice = settings.fineTuned || undefined;
    if (!ttsEngine && !voice) return null;
    return { ttsEngine, voice };
  } catch {
    return null;
  }
}

/**
 * Resolve the assembly-page inter-sentence gap for a session from its provenance.
 * Used by the `reassembly:resolve-sentence-gap` IPC to pre-fill (and gate) the gap field:
 *  - Orpheus session → field is shown, pre-filled with the voice's tuned model value or,
 *    when the model is untested (no manifest value), the visible DEFAULT_SENTENCE_GAP.
 *    `hasModelValue` lets the UI say "tuned for X" vs "untested — using the 0.6s default".
 *  - Non-Orpheus session → field is hidden (gap normalization is Orpheus-specific); `gap`
 *    is returned as DEFAULT_SENTENCE_GAP but the caller ignores it when `isOrpheus` is false.
 */
export async function resolveSessionSentenceGap(
  processDir: string
): Promise<{ isOrpheus: boolean; voice?: string; gap: number; hasModelValue: boolean }> {
  const provenance = await parseSessionProvenance(processDir);
  if (provenance?.ttsEngine?.toLowerCase() === 'orpheus') {
    const model = resolveOrpheusSentenceGap(provenance.voice);
    return {
      isOrpheus: true,
      voice: provenance.voice,
      hasModelValue: model !== undefined,
      gap: model ?? DEFAULT_SENTENCE_GAP,
    };
  }
  return { isOrpheus: false, gap: DEFAULT_SENTENCE_GAP, hasModelValue: false };
}

/**
 * Find cover image in processDir
 */
function findCoverImage(processDir: string): string | undefined {
  const coverNames = [
    'cleaned.jpg', 'cleaned.png', 'cover.jpg',
    'cover.jpeg', 'cover.png', 'cover.webp'
  ];
  for (const name of coverNames) {
    const coverPath = path.join(processDir, name);
    if (fs.existsSync(coverPath)) return coverPath;
  }
  return undefined;
}

/**
 * Parse chapter_sentences.json if it exists (async)
 */
async function parseChapterSentences(processDir: string): Promise<any | null> {
  const chapterPath = path.join(processDir, 'chapter_sentences.json');
  try {
    const content = await fs.promises.readFile(chapterPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get full details for a specific session
 * project.json metadata is extracted from the session's source_epub_path
 * @param sessionId - The session ID (UUID part after ebook-)
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function getSession(sessionId: string, customTmpPath?: string): Promise<E2aSession | null> {
  const tmpPath = customTmpPath || getDefaultE2aTmpPath();
  const sessionDir = path.join(tmpPath, `ebook-${sessionId}`);

  try {
    await fs.promises.access(sessionDir);
  } catch {
    return null;
  }

  return parseSession(sessionId, sessionDir);
}

/**
 * Delete a session's tmp folder.
 * If the directory doesn't exist, returns true (already gone = success).
 */
export async function deleteSession(sessionId: string, customTmpPath?: string): Promise<boolean> {
  const targetDir = path.join(customTmpPath || getDefaultE2aTmpPath(), `ebook-${sessionId}`);

  try {
    await fs.promises.access(targetDir);
  } catch {
    // Directory doesn't exist — already gone, treat as success
    console.log(`[REASSEMBLY] Session folder already removed: ${targetDir}`);
    return true;
  }

  try {
    console.log(`[REASSEMBLY] Deleting session folder (async): ${targetDir}`);
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    console.log(`[REASSEMBLY] Deleted session folder: ${targetDir}`);
    return true;
  } catch (err) {
    console.error(`[REASSEMBLY] Error deleting session folder:`, err);
    return false;
  }
}

/**
 * Save/update session metadata including cover image
 * @param sessionId - The session ID
 * @param processDir - Path to the process directory containing session-state.json
 * @param metadata - Metadata to save
 * @param coverData - Optional cover image data (base64 or file path)
 */
export async function saveSessionMetadata(
  sessionId: string,
  processDir: string,
  metadata: {
    title?: string;
    author?: string;
    year?: string;
    narrator?: string;
    series?: string;
    seriesNumber?: string;
    genre?: string;
    description?: string;
    outputFilename?: string;
  },
  coverData?: {
    type: 'base64' | 'path';
    data: string;  // base64 string or file path
    mimeType?: string;  // e.g., 'image/jpeg'
  }
): Promise<{ success: boolean; error?: string; coverPath?: string }> {
  console.log('[REASSEMBLY] Saving metadata for session:', sessionId);

  if (!fs.existsSync(processDir)) {
    return { success: false, error: 'Process directory not found' };
  }

  const statePath = path.join(processDir, 'session-state.json');

  try {
    // Read existing session state
    let sessionState: any = {};
    if (fs.existsSync(statePath)) {
      const content = fs.readFileSync(statePath, 'utf-8');
      sessionState = JSON.parse(content);
    }

    // Update metadata section
    if (!sessionState.metadata) {
      sessionState.metadata = {};
    }

    // Map our metadata fields to e2a's expected format
    if (metadata.title !== undefined) sessionState.metadata.title = metadata.title;
    if (metadata.author !== undefined) sessionState.metadata.creator = metadata.author;

    // Store extended metadata in a custom section (e2a may not use these, but we preserve them)
    if (!sessionState.bookforge_metadata) {
      sessionState.bookforge_metadata = {};
    }
    if (metadata.year !== undefined) sessionState.bookforge_metadata.year = metadata.year;
    if (metadata.narrator !== undefined) sessionState.bookforge_metadata.narrator = metadata.narrator;
    if (metadata.series !== undefined) sessionState.bookforge_metadata.series = metadata.series;
    if (metadata.seriesNumber !== undefined) sessionState.bookforge_metadata.seriesNumber = metadata.seriesNumber;
    if (metadata.genre !== undefined) sessionState.bookforge_metadata.genre = metadata.genre;
    if (metadata.description !== undefined) sessionState.bookforge_metadata.description = metadata.description;
    if (metadata.outputFilename !== undefined) sessionState.bookforge_metadata.outputFilename = metadata.outputFilename;

    // Handle cover image
    let savedCoverPath: string | undefined;
    if (coverData) {
      // Determine extension from mime type
      let ext = 'jpg';
      if (coverData.mimeType === 'image/png') ext = 'png';
      else if (coverData.mimeType === 'image/webp') ext = 'webp';

      const coverFilename = `cover.${ext}`;
      const coverPath = path.join(processDir, coverFilename);

      if (coverData.type === 'base64') {
        // Write base64 data to file
        const base64Data = coverData.data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(coverPath, buffer);
        savedCoverPath = coverPath;
        console.log('[REASSEMBLY] Saved cover image:', coverPath);
      } else if (coverData.type === 'path' && fs.existsSync(coverData.data)) {
        // Copy file to process directory
        fs.copyFileSync(coverData.data, coverPath);
        savedCoverPath = coverPath;
        console.log('[REASSEMBLY] Copied cover image:', coverPath);
      }

      // Store cover path in session state
      if (savedCoverPath) {
        sessionState.bookforge_metadata.coverPath = savedCoverPath;
      }
    }

    // Write updated session state
    fs.writeFileSync(statePath, JSON.stringify(sessionState, null, 2), 'utf-8');
    console.log('[REASSEMBLY] Saved session state:', statePath);

    return { success: true, coverPath: savedCoverPath };
  } catch (err) {
    console.error('[REASSEMBLY] Error saving metadata:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Start reassembly process using e2a's --assemble_only flag
 * Matches the assembly logic from parallel-tts-bridge.ts
 */
export async function startReassembly(
  /**
   * A STEP id, whatever this parameter is called.
   *
   * The live caller is queue-steps/reassembly.ts, which passes `ctx.stepId`,
   * and the scratch directories named from it (`.gap-<id>`, `denoise-<id>`) are
   * therefore step-named — which is exactly what lets the startup sweep spare
   * them by matching against the queue's non-terminal STEP ids
   * (`liveStepIds` in main.ts). Not renamed to `stepId` because the name also
   * appears as the `jobId` key in every reassembly log record and in the job
   * analytics, and changing a persisted field name to make a parameter read
   * better is a cost paid by everything that reads those records.
   *
   * The other caller — the `reassembly:start` IPC — passes an unconstrained id,
   * and its renderer wrapper has no callers, so nothing live goes through it.
   * If that door is ever wired back up, it must pass a step id or the sweep
   * will not recognise its scratch (bookforge-mac-2's review, 2026-08-20).
   */
  jobId: string,
  config: ReassemblyConfig,
  mainWindow: BrowserWindow | null
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const reassemblyLog = getReassemblyLogger();

  /*
   * IS THIS RUN MAKING A SECOND AUDIOBOOK, and if so what is it called —
   * answered HERE, at the top, because both of its refusals ("which voice?",
   * "no filename to derive one from") are things this run can never learn later,
   * and the alternative is raising them after an encode has already happened.
   *
   * Null is the ordinary case and means every rule below is the one it always
   * was: one audiobook per project, in the base slot, replacing what was there.
   */
  const variantFiling = config.registerAsNewVariant
    ? resolveRvcVariantFiling(config.rvcVoiceId, config.metadata?.outputFilename)
    : null;
  if (variantFiling) {
    reassemblyLog.info('Assembling a NEW audiobook version rather than replacing the project\'s', {
      jobId, variantId: variantFiling.variantId, file: variantFiling.outputFilename,
    });
  }

  // Derive e2a app path from tmp path (parent directory)
  const tmpPath = config.e2aTmpPath || getDefaultE2aTmpPath();
  const e2aPath = getE2aAppPath(tmpPath);

  reassemblyLog.info('Starting reassembly', {
    jobId,
    sessionId: config.sessionId,
    outputDir: config.outputDir,
    title: config.metadata?.title,
    excludedChapters: config.excludedChapters?.length || 0
  });

  console.log('[REASSEMBLY] Starting reassembly:', {
    jobId,
    sessionId: config.sessionId,
    outputDir: config.outputDir,
    e2aPath,
    tmpPath,
    excludedChapters: config.excludedChapters
  });

  // Verify session exists
  if (!fs.existsSync(config.processDir)) {
    return { success: false, error: 'Session process directory not found' };
  }

  // No symlink needed - we pass --session_dir to e2a to tell it where the session is

  // Always resolve cover from manifest as authoritative source,
  // then allow config.metadata.coverPath to override if valid on this machine
  if (config.outputDir) {
    const projectDir = path.dirname(config.outputDir); // outputDir is {projectDir}/output
    const projectId = path.basename(projectDir);
    try {
      const mResult = await manifestService.getManifest(projectId);
      if (mResult.success && mResult.manifest?.metadata?.coverPath) {
        const libRoot = manifestService.getLibraryBasePath();
        const absCover = path.join(libRoot, mResult.manifest.metadata.coverPath);
        if (fs.existsSync(absCover)) {
          if (!config.metadata) config.metadata = { title: '', author: '' };
          // Use manifest cover as baseline
          if (!config.metadata.coverPath || !fs.existsSync(config.metadata.coverPath)) {
            config.metadata.coverPath = absCover;
            console.log(`[REASSEMBLY] Resolved cover from manifest: ${absCover}`);
          } else {
            console.log(`[REASSEMBLY] Using provided cover (manifest available as fallback): ${config.metadata.coverPath}`);
          }
        }
      }
    } catch {
      // Non-fatal — continue without manifest cover
    }
  }

  // Validate cover path exists on this machine — cross-platform synced projects may
  // have paths from another OS (e.g., /Volumes/... from Mac when running on Windows)
  if (config.metadata?.coverPath && !fs.existsSync(config.metadata.coverPath)) {
    console.warn(`[REASSEMBLY] Cover path does not exist (cross-platform?): ${config.metadata.coverPath}`);
    config.metadata.coverPath = undefined;
  }

  // Copy optimized project cover to session directory, replacing any e2a-extracted cover.
  // e2a uses covers from the processDir (cleaned.jpg, cover.jpg, etc.) during assembly.
  // Covers are optimized to JPEG ≤1400px to ensure player compatibility.
  if (config.metadata?.coverPath && fs.existsSync(config.metadata.coverPath)) {
    try {
      const optimized = optimizeCoverForM4b(config.metadata.coverPath);
      const targetCoverPath = path.join(config.processDir, 'cover.jpg');
      fs.copyFileSync(optimized, targetCoverPath);
      console.log(`[REASSEMBLY] Copied optimized cover to session: ${config.metadata.coverPath} -> ${targetCoverPath}`);
      if (optimized !== config.metadata.coverPath) {
        try { fs.unlinkSync(optimized); } catch { /* non-critical */ }
      }
    } catch (err) {
      console.error('[REASSEMBLY] Failed to copy project cover to session:', err);
    }
  }

  // Find the epub path from session state
  let sessionState = await parseSessionState(config.processDir);

  // Update session metadata with user-provided values before reassembly
  // This allows user to override epub's built-in metadata
  if (sessionState && config.metadata) {
    const statePath = path.join(config.processDir, 'session-state.json');
    let metadataUpdated = false;

    if (!sessionState.metadata) {
      sessionState.metadata = {};
    }

    // Initialize bookforge_metadata if not present
    if (!sessionState.bookforge_metadata) {
      sessionState.bookforge_metadata = {};
    }

    // Override with user-provided metadata (only if provided)
    // Save to both standard metadata and bookforge_metadata for e2a compatibility
    if (config.metadata.title) {
      sessionState.metadata.title = config.metadata.title;
      sessionState.bookforge_metadata.title = config.metadata.title;
      metadataUpdated = true;
    }
    if (config.metadata.author) {
      sessionState.metadata.creator = config.metadata.author;
      sessionState.bookforge_metadata.author = config.metadata.author;
      metadataUpdated = true;
    }
    if (config.metadata.year) {
      // e2a expects 'published' in ISO format for year extraction
      sessionState.metadata.published = `${config.metadata.year}-01-01T00:00:00.000Z`;
      sessionState.bookforge_metadata.year = config.metadata.year;
      metadataUpdated = true;
    }
    if (config.metadata.description) {
      sessionState.metadata.description = config.metadata.description;
      metadataUpdated = true;
    }

    // Write updated session state back if we made changes
    if (metadataUpdated) {
      try {
        fs.writeFileSync(statePath, JSON.stringify(sessionState, null, 2), 'utf-8');
        console.log('[REASSEMBLY] Updated session metadata with user values:', {
          title: sessionState.metadata.title,
          creator: sessionState.metadata.creator,
          year: config.metadata.year
        });
      } catch (err) {
        console.error('[REASSEMBLY] Failed to update session metadata:', err);
      }
    }
  }

  let epubPath = sessionState?.epubPath;

  // Try to find an epub file in the process directory if not in state
  if (!epubPath) {
    const files = fs.readdirSync(config.processDir);
    const epubFile = files.find(f => f.endsWith('.epub'));
    if (epubFile) {
      epubPath = path.join(config.processDir, epubFile);
    }
  }

  if (!epubPath || !fs.existsSync(epubPath)) {
    // Create a dummy epub path - e2a might be able to work without it for assembly
    epubPath = path.join(config.processDir, 'book.epub');
    console.log('[REASSEMBLY] No epub found, using dummy path:', epubPath);
  }

  // Get language from session state
  const language = sessionState?.metadata?.language || 'en';

  // Pre-validate sentence files: check that all expected sentences exist before spawning e2a.
  // This catches TTS gaps early with a clear error instead of a cryptic "conda run failed."
  if (sessionState?.chapters && sessionState.total_sentences) {
    const sentencesDir = path.join(config.processDir, 'chapters', 'sentences');
    if (fs.existsSync(sentencesDir)) {
      const existingFiles = new Set(fs.readdirSync(sentencesDir));
      const missing: number[] = [];
      for (let i = 0; i < sessionState.total_sentences; i++) {
        // Check for both .flac and .wav extensions
        if (!existingFiles.has(`${i}.flac`) && !existingFiles.has(`${i}.wav`)) {
          missing.push(i);
        }
      }
      if (missing.length > 0) {
        const total = sessionState.total_sentences;
        const present = total - missing.length;
        const rangeStr = missing.length <= 10
          ? missing.join(', ')
          : `${missing[0]}-${missing[missing.length - 1]}`;
        const errorMsg = `TTS incomplete: ${missing.length} of ${total} sentence files missing (${present}/${total} present). Missing: ${rangeStr}. Please re-run TTS to generate the missing files.`;
        console.error(`[REASSEMBLY] ${errorMsg}`);
        reassemblyLog.error('Pre-validation failed', { jobId, missing: missing.length, total });
        return { success: false, error: errorMsg };
      }
      console.log(`[REASSEMBLY] Sentence validation passed: ${sessionState.total_sentences} files found`);
    }
  }

  // ── Optional RVC voice enhancement (post-TTS, pre-assembly) ──────────────────
  // Convert the cached XTTS sentences through an RVC voice into a SCRATCH dir under
  // [library]/tmp, then assemble THAT set (via e2a's --sentences_dir) and delete
  // the scratch afterward (cleanupStagingDir). "Merge and delete": the enhanced
  // sentences only ever exist to feed this one assembly. The cached source
  // sentences are never mutated, so a session can be re-enhanced with a different
  // voice later. Writing to [library]/tmp (not inside the cached session) keeps
  // RVC output out of the project — and the startup tmp-wipe is a backstop if
  // cleanup ever misses. Runs here so it works whether assembly is chained from
  // TTS or run standalone on a cached session.
  let rvcSentencesDir: string | null = null;

  // ── Optional assembly-time sentence-gap normalization (RAW cache, BEFORE denoise) ──
  // e2a bakes an artificial trailing pad of EXACTLY-zero samples onto every rendered
  // sentence (orpheus.py trail_gap). The model's own trained tail is never exactly 0, so
  // we can losslessly strip just that pad (trailing exact-zero frames) and re-apply a
  // chosen amount of silence — making the effective inter-sentence gap match the human
  // source. This MUST run on the RAW cached sentences and BEFORE denoise: denoise turns
  // those exact zeros into tiny non-zero values that no longer trim cleanly. The
  // gap-normalized set becomes the BASE source for the rest of the chain (denoise reads
  // it, else inline-RVC reads it, else assembly reads it). Skipped when an upstream
  // rvc-enhancement job already supplied the final set (`config.sentencesDir`).
  // Resolved FIRST — before anything reports progress — because whether this run
  // normalizes gaps decides whether the stage plan below declares a gap bar.
  // Assembly always runs --tts_engine xtts, so the Orpheus voice — and every per-voice
  // value keyed off it (the gap default, the min-chunk-gap floor) — can only come from
  // provenance. Read ONCE at function scope: an explicit config.sentenceGap skips the gap
  // resolution below but the normalization step still needs the voice, so making this read
  // conditional on that branch would leave the voice unknown exactly when it's asked for.
  const provenance = config.sentencesDir ? null : await parseSessionProvenance(config.processDir);

  let resolvedGap: number | undefined;
  if (!config.sentencesDir) {
    if (typeof config.sentenceGap === 'number') {
      resolvedGap = config.sentenceGap;
    } else if (provenance?.ttsEngine?.toLowerCase() === 'orpheus') {
      // Orpheus sessions ALWAYS normalize: a tuned model value (e.g. 0 → tight gap) when
      // the manifest declares one, else the visible DEFAULT_SENTENCE_GAP (untested model →
      // 0.6s, reproducing today's baked ~0.6 behavior). Non-orpheus stays undefined below.
      resolvedGap = resolveOrpheusSentenceGap(provenance.voice) ?? DEFAULT_SENTENCE_GAP;
    }
  }

  // ── Stage plan for THIS run ─────────────────────────────────────────────────
  // Declared before the first progress event so the bars never appear mid-flight.
  // The optional pre-passes each cost real minutes and used to report a flat 0%,
  // leaving the whole UI frozen at zero through the slowest part of the job.
  const willDenoise = !!config.finalDenoise && !config.sentencesDir;
  const willRvc = !!config.rvcEnhancement?.voiceId && !config.sentencesDir;
  const stages = new StageTracker([
    ...(resolvedGap !== undefined ? [STAGE_GAP] : []),
    ...(willDenoise ? [STAGE_DENOISE] : []),
    ...(willRvc ? [STAGE_RVC] : []),
    ...STAGE_ALWAYS,
  ]);

  /**
   * Advance a stage and publish. `pct === null` marks the stage running without
   * claiming a fraction — for steps whose progress isn't measurable yet, where a
   * made-up number would be worse than an honest empty bar plus a live message.
   */
  const emitStage = (
    name: string,
    pct: number | null,
    message: string,
    extra?: { currentChapter?: number; totalChapters?: number },
  ): void => {
    if (pct === null) stages.start(name);
    else stages.set(name, pct);
    sendProgress(mainWindow, jobId, {
      phase: STAGE_PHASE[name],
      percentage: stages.master(),
      message,
      stages: stages.snapshot(),
      ...extra,
    });
  };

  let gapDir: string | null = null;
  // Chapters the TTS job already normalized AND encoded while the GPU was busy (see
  // chapter-closer). Accepting them skips this whole gap pass and, further down,
  // hands e2a the finished chapters so it re-encodes nothing.
  let encodedChaptersDir: string | null = null;
  if (resolvedGap !== undefined) {
    const srcSentences = path.join(config.processDir, 'chapters', 'sentences');
    if (!fs.existsSync(srcSentences)) {
      return { success: false, error: 'Sentence-gap normalization: cached sentences not found for this session.' };
    }
    const minChunkGapForCloser = resolveOrpheusMinChunkGap(provenance?.voice) ?? 0;
    const closed = !e2aSupportsEncodedChapters()
      ? (reassemblyLog.info('Pre-closed chapters not used', {
          jobId, reason: `the e2a at ${getDefaultE2aPath()} does not support --encoded_chapters_dir`,
        }), null)
      : await resolveClosedSession({
      tmpRoot: getDefaultE2aTmpPath(),
      sessionId: config.sessionId,
      sentencesDir: srcSentences,
      gapSeconds: resolvedGap,
      minGapSeconds: minChunkGapForCloser,
      // Every rejection is worth a line: it costs only the time the closer saved,
      // but a rejection nobody sees looks exactly like the feature not working.
      onReject: (reason) => reassemblyLog.info('Pre-closed chapters not used', { jobId, reason }),
    });
    if (closed) {
      gapDir = closed.gapDir;
      encodedChaptersDir = closed.encodedDir;
      rvcSentencesDir = closed.gapDir;
      activeClosedDirs.set(jobId, path.dirname(closed.gapDir));
      reassemblyLog.info('Using pre-closed chapters from the TTS job', {
        jobId, chapters: closed.chapters.length, gapDir: closed.gapDir, encodedDir: closed.encodedDir,
      });
      emitStage('gap', 100, 'Sentence gaps already normalized during rendering');
    }
  }
  if (resolvedGap !== undefined && !gapDir) {
    const srcSentences = path.join(config.processDir, 'chapters', 'sentences');
    /*
     * BESIDE THE STAGING DIR, not in the shared scratch.
     *
     * This used to be `<e2a tmp>/gap-<jobId>` — the same directory the startup
     * sweep empties wholesale. On 2026-08-19 that sweep deleted a live
     * assembly's gap-normalised sentences 90 seconds after they were written,
     * and e2a answered "Sentences directory not found" for a path we had just
     * built. The sweep now spares work the queue still wants, but the deeper
     * point stands: this set belongs to ONE step of ONE assembly, is consumed
     * by that assembly alone, and is cleaned with it at every terminal point —
     * which is exactly the discipline the staging dir already has. Shared
     * scratch was never the right shelf for it.
     */
    gapDir = path.join(config.outputDir, `.gap-${jobId}`);
    // Track for merge-and-delete NOW; a later stage that consumes it re-points the
    // tracker and deletes this dir itself (mirrors the denoise scratch handling).
    activeRvcDirs.set(jobId, gapDir);
    try {
      // The voice's FLOOR on chunk trailing silence. With sentenceGap 0 the join IS
      // the model's own trained tail, and that tail varies enough that some joins
      // collide (measured min 0.00 s over 1151 chunks); the floor lifts only those.
      const minChunkGap = resolveOrpheusMinChunkGap(provenance?.voice);
      reassemblyLog.info('Sentence-gap normalization starting',
        { jobId, gapSeconds: resolvedGap, minChunkGap: minChunkGap ?? 0, src: srcSentences });
      emitStage('gap', null, 'Normalizing sentence gaps…');
      // CPU-only (soundfile/numpy array work, no torch device) — no GPU lease.
      await normalizeSentenceGaps({
        sentencesDir: srcSentences, outputDir: gapDir,
        gapSeconds: resolvedGap, minGapSeconds: minChunkGap,
      });
      rvcSentencesDir = gapDir;
      emitStage('gap', 100, 'Sentence gaps normalized');
      reassemblyLog.info('Sentence-gap normalization complete', { jobId, dir: gapDir });
    } catch (err) {
      // Delete the partial scratch set — this early return skips the assembly
      // completion handler where cleanupStagingDir normally runs.
      cleanupStagingDir(jobId);
      return { success: false, error: `Sentence-gap normalization failed: ${(err as Error).message || err}` };
    }
  }

  // ── Optional final denoise (post-TTS, pre-assembly; runs BEFORE any RVC) ─────
  // Block-based roformer pass over the session's cached sentences (denoise-bridge)
  // into a SCRATCH dir under [library]/tmp — merge-and-delete like the RVC scratch.
  // Ordering: denoise FIRST, then RVC — RVC extracts f0/content features from its
  // input and input noise corrupts that extraction; the roformer is proven
  // zero-change on clean audio, so the compose is always safe. When an upstream
  // 'rvc-enhancement' job supplied `sentencesDir`, that job received the same
  // finalDenoise flag and already denoised before converting — not re-run here.
  let denoisedTmpDir: string | null = null;
  if (config.finalDenoise) {
    if (!willDenoise) {
      reassemblyLog.info('Final denoise: pre-enhanced set supplied — denoise already ran upstream of RVC', { jobId });
    } else {
      const dnReady = finalDenoiseReady();
      if (!dnReady.ok) {
        return { success: false, error: `Final denoise unavailable: ${dnReady.reason}` };
      }
      // Denoise the GAP-normalized set when the gap step above ran (gap → denoise),
      // else the session's raw cached sentences.
      const srcSentences = gapDir ?? path.join(config.processDir, 'chapters', 'sentences');
      if (!fs.existsSync(srcSentences)) {
        return { success: false, error: 'Final denoise: cached sentences not found for this session.' };
      }
      denoisedTmpDir = path.join(getDefaultE2aTmpPath(), `denoise-${jobId}`);
      // Track it for merge-and-delete NOW; if an inline RVC pass follows, that pass
      // re-points the tracker at ITS scratch and deletes this one itself.
      activeRvcDirs.set(jobId, denoisedTmpDir);
      // Same shared GPU lease as the RVC pass — the roformer runs on the env's
      // torch device and must not co-reside with a running TTS/LLM job.
      const dnGpuOwner = `denoise:reassembly:${jobId}`;
      emitStage('denoise', null, 'Waiting for the GPU…');
      await acquireGpu(dnGpuOwner, { timeoutMs: 10 * 60_000 });
      try {
        reassemblyLog.info('Final denoise starting', { jobId, src: srcSentences });
        emitStage('denoise', null, 'Denoising audio…');
        await denoiseSentences({
          sentencesDir: srcSentences,
          outputDir: denoisedTmpDir,
          onProgress: (done, total) => emitStage(
            'denoise',
            total ? (done / total) * 100 : null,
            `Denoising audio… (block ${done}/${total})`,
          ),
        });
        rvcSentencesDir = denoisedTmpDir;
        emitStage('denoise', 100, 'Denoise complete');
        reassemblyLog.info('Final denoise complete', { jobId, dir: denoisedTmpDir });
      } catch (err) {
        // Delete the partial scratch set — this early return skips the assembly
        // completion handler where cleanupStagingDir normally runs.
        cleanupStagingDir(jobId);
        return { success: false, error: `Final denoise failed: ${(err as Error).message || err}` };
      } finally {
        releaseGpu(dnGpuOwner);
        // The gap scratch has served its purpose (denoise read from it) — drop it now;
        // the tracker points at the denoise scratch (success and failure alike), so
        // cleanupStagingDir would otherwise leave the gap dir behind.
        if (gapDir) {
          try { fs.rmSync(gapDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      }
    }
  }

  // Preferred path: a separate 'rvc-enhancement' queue job already rendered the
  // enhanced sentences into [library]/tmp and handed us the dir. Assemble that
  // set and delete it after (track it in activeRvcDirs so cleanupStagingDir
  // removes it at every terminal point). This takes precedence over the inline
  // pass below, so RVC never runs twice.
  if (config.sentencesDir) {
    if (!fs.existsSync(config.sentencesDir)) {
      return { success: false, error: `RVC enhancement: enhanced sentences not found at ${config.sentencesDir}.` };
    }
    rvcSentencesDir = config.sentencesDir;
    activeRvcDirs.set(jobId, config.sentencesDir);
    reassemblyLog.info('Assembling pre-enhanced sentence set', { jobId, dir: config.sentencesDir });
  } else if (config.rvcEnhancement?.voiceId) {
    const voice = getRvcVoiceById(config.rvcEnhancement.voiceId);
    if (!voice) {
      return { success: false, error: `RVC enhancement: unknown voice "${config.rvcEnhancement.voiceId}".` };
    }
    const ready = rvcEnhancementReady();
    if (!ready.ok) {
      return { success: false, error: `RVC enhancement unavailable: ${ready.reason}` };
    }
    // Convert the DENOISED set when the denoise pass above ran (denoise → RVC), else
    // the GAP-normalized set when only the gap step ran, else the raw cached sentences.
    const srcSentences = denoisedTmpDir ?? gapDir ?? path.join(config.processDir, 'chapters', 'sentences');
    if (!fs.existsSync(srcSentences)) {
      return { success: false, error: 'RVC enhancement: cached sentences not found for this session.' };
    }
    const tmpDir = path.join(getDefaultE2aTmpPath(), `rvc-${jobId}`);
    // Re-points the merge-and-delete tracker at the RVC scratch; the denoise
    // scratch (if any) is deleted below once RVC has consumed it.
    activeRvcDirs.set(jobId, tmpDir);
    // Take the shared GPU lease for the RVC pass: without it this co-resides with a
    // running/loading Orpheus or XTTS job (or the cleanup LLM) and the pair OOMs the
    // card. Parallel-TTS jobs hold this same lease across their whole run, so this
    // waits its turn instead of colliding.
    const gpuOwner = `rvc:reassembly:${jobId}`;
    emitStage('rvc', null, 'Waiting for the GPU…');
    await acquireGpu(gpuOwner, { timeoutMs: 10 * 60_000 });
    try {
      reassemblyLog.info('RVC enhancement starting', { jobId, voice: voice.label, model: voice.modelName });
      emitStage('rvc', null, `Enhancing voice with ${voice.label}…`);
      await enhanceSentences({
        sentencesDir: srcSentences,
        outputDir: tmpDir,
        modelName: voice.modelName,
        indexRate: resolveRvcIndexRate(voice, config.rvcEnhancement.indexRate),
        protectRate: config.rvcEnhancement.protectRate ?? 0.5,
        nSemitones: config.rvcEnhancement.nSemitones ?? 0,
        // Absent stays absent — that is what leaves urvc on its own default.
        f0Method: config.rvcEnhancement.f0Method,
        hopLength: config.rvcEnhancement.hopLength,
        onProgress: (done, total) => emitStage(
          'rvc',
          total ? (done / total) * 100 : null,
          `Enhancing voice with ${voice.label}… (${done}/${total})`,
        ),
      });
      rvcSentencesDir = tmpDir;
      emitStage('rvc', 100, 'Voice enhancement complete');
      reassemblyLog.info('RVC enhancement complete', { jobId, dir: tmpDir });
    } catch (err) {
      // Delete the partial scratch set — this early return skips the assembly
      // completion handler where cleanupStagingDir normally runs.
      cleanupStagingDir(jobId);
      return { success: false, error: `RVC enhancement failed: ${(err as Error).message || err}` };
    } finally {
      releaseGpu(gpuOwner);
      // The upstream scratch(es) have served their purpose (RVC read from whichever
      // was its source) — drop them now; the tracker points at the RVC scratch
      // (success and failure alike). When denoise ran it already deleted gapDir in its
      // own finally, so this is the no-denoise case (gap → RVC directly).
      if (denoisedTmpDir) {
        try { fs.rmSync(denoisedTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (gapDir) {
        try { fs.rmSync(gapDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // Create staging directory inside output/ so e2a writes there (same filesystem = atomic rename).
  // Dot-prefix makes Syncthing unlikely to index partial files.
  const stagingDir = path.join(config.outputDir, `.staging-${jobId}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  activeStagingDirs.set(jobId, stagingDir);
  console.log(`[REASSEMBLY] Created staging dir: ${stagingDir}`);

  // Send initial progress
  emitStage('combine', null, 'Preparing reassembly...');

  // De-ring (OPT-IN): the per-voice post-render ffmpeg filter chain (notch/comb that
  // strips SNAC tonal ringing), resolved from the session's PROVENANCE (the engine +
  // voice that produced these cached sentences, recorded in session_state.json).
  // Assembly always runs --tts_engine xtts (engine-agnostic), so the original Orpheus
  // voice — and thus its filter — can only come from provenance, not the assembly args.
  // Resolved ONLY when the caller ticked de-ring (config.applyDeRing); absent/false →
  // arg omitted → assembly encodes the raw sentences unchanged. (Previously auto-applied
  // for every Orpheus session; that silent-apply is now the explicit opt-in below.)
  let postRenderFilter: string | undefined;
  if (config.applyDeRing) {
    const provenance = await parseSessionProvenance(config.processDir);
    if (provenance?.ttsEngine?.toLowerCase() === 'orpheus') {
      postRenderFilter = resolveOrpheusPostRenderFilter(provenance.voice);
    }
  }

  return new Promise((resolve) => {
    const appPath = path.join(e2aPath, 'app.py');
    const platform = os.platform();

    // Check if session is in WSL - if so, we need to run assembly through WSL
    const sessionInWsl = isWslPath(config.sessionDir);

    // Build arguments for app.py
    const appArgs = [
      appPath,
      '--headless',
      '--ebook', epubPath,
      '--output_dir', stagingDir,
      '--session', config.sessionId,
      '--session_dir', config.sessionDir,
      '--device', 'CPU',
      '--language', language,
      '--tts_engine', 'xtts',
      '--assemble_only',
      '--no_split',
      // When an RVC pass ran, assemble the ENHANCED sentence set from the tmp dir
      // instead of the cached XTTS sentences.
      ...(rvcSentencesDir ? ['--sentences_dir', rvcSentencesDir] : []),
      // Chapters already encoded during the render. e2a skips both the sentence
      // concat and the AAC encode for these and drops them straight into the final
      // concat; it validates and errors on anything it cannot use, and ignores the
      // flag entirely on the modes where pre-encoded chunks are not equivalent.
      ...(encodedChaptersDir ? ['--encoded_chapters_dir', encodedChaptersDir] : []),
      // Per-voice post-render filter (Orpheus provenance only) — applied at e2a's
      // final encode. The native branch shell-escapes each arg (shellEscapeArgs) and
      // the WSL branch shell-quotes each (buildWslAssemblyCommand); both are safe for
      // the `|`, `:`, `/`, single-quote chars a filter chain may contain.
      ...(postRenderFilter ? ['--post_render_filter', postRenderFilter] : []),
    ];

    // Note: --output_filename, --title, --author, --cover are not supported by all e2a versions
    // Metadata will be applied after assembly using m4b-tool if available

    let proc: ChildProcess;

    if (sessionInWsl && platform === 'win32') {
      // Session is in WSL filesystem - run assembly through WSL
      const wslE2aPath = getWslE2aPath();
      const wslBashCommand = buildWslAssemblyCommand(appArgs, config.outputDir);
      console.log('[REASSEMBLY] Session in WSL, running through WSL:', wslBashCommand.substring(0, 200) + '...');

      const distro = getWslDistro();
      // Use bash -c (non-interactive) to avoid .bashrc issues blocking stdout
      const wslArgs = distro
        ? ['-d', distro, 'bash', '-c', wslBashCommand]
        : ['bash', '-c', wslBashCommand];

      proc = spawn('wsl.exe', wslArgs, {
        cwd: e2aPath,
        env: buildCondaSpawnEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
        shell: false
      });
    } else {
      // Standard Windows/macOS/Linux spawn
      // Use shell: true + shellEscapeArgs to handle paths with apostrophes/quotes
      // (conda run re-invokes through a shell, so paths must be properly escaped).
      // The command is escaped too: a bundled relocatable python lives under
      // "Application Support" on macOS.
      const py = getPythonInvocation(e2aPath);
      const escapedArgs = shellEscapeArgs([...py.args, ...appArgs]);
      const escapedCommand = shellEscapeArgs([py.command])[0];
      console.log('[REASSEMBLY] Running command:', escapedCommand, escapedArgs.join(' '));

      // buildCondaSpawnEnv enriches PATH with the resolved ffmpeg dir so e2a's
      // Python (pydub) finds ffmpeg/ffprobe even under a packaged app's minimal PATH.
      proc = spawn(escapedCommand, escapedArgs, {
        cwd: e2aPath,
        env: buildCondaSpawnEnv({
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        }),
        shell: true,
      });
    }

    activeReassemblies.set(jobId, proc);

    let stderr = '';
    // Rolling tail of stdout. e2a prints its real assembly errors to STDOUT
    // (e.g. "Export failed: …", the final '"success": false' JSON, Python
    // tracebacks), NOT stderr. Without this, a failed assembly surfaces only a
    // bare "Process exited with code 1" — the actual cause is lost. Capped like
    // stderr so high-frequency progress can't grow it unbounded.
    let stdoutTail = '';
    let outputPath = '';
    // Use totalChapters from config if provided (allows UI to show progress immediately)
    let totalChapters = config.totalChapters || 0;
    let chaptersCompleted = 0;
    /** Chapters whose combine has STARTED. Counted, not read from e2a's book-wide index. */
    let chaptersStarted = 0;
    let currentChapter = 0;  // The chapter currently being processed (1-indexed)
    let currentChapterProgress = 0;  // 0-100 progress within current chapter
    let currentPhase: 'combining' | 'concatenating' | 'encoding' | 'metadata' = 'combining';
    let lastProgressUpdate = Date.now();
    let encodingStartTime = 0;
    let exportStartTime = 0;
    let exportStartPct = 0;
    let lastExportPct = 0;
    /**
     * Total playable length in seconds. This is what turns the concat and encode bars
     * into REAL measurements: ffmpeg reports the audio position it has written
     * (time=HH:MM:SS), and position ÷ total is the honest fraction.
     *
     * Learned from e2a's "N.Nh of audio" line when it appears, and otherwise MEASURED
     * off the chapter FLACs e2a has just written (see measureTotalAudio). Depending on
     * the log line alone left this at zero on any run that didn't print it — and a
     * 34-hour book then spent the better part of an hour on two bars that never moved,
     * which reads as frozen. The chapters are on disk by then either way, so the length
     * is a fact available for the asking rather than something to wait for.
     */
    let totalAudioSeconds = 0;

    /**
     * Total the chapter FLACs once, the first time a stage needs a denominator. Cheap
     * (a 42-byte header read per chapter, a few dozen files) and idempotent — but not
     * free over a network/9p path, so it runs at most once per job and only on demand.
     */
    let totalAudioMeasureStarted = false;
    const measureTotalAudio = (): void => {
      if (totalAudioSeconds > 0 || totalAudioMeasureStarted) return;
      totalAudioMeasureStarted = true;
      const chaptersDir = path.join(config.processDir, 'chapters');
      void sumFlacDurationsSeconds(chaptersDir).then(seconds => {
        if (seconds === null) {
          console.warn(`[REASSEMBLY] Could not measure chapter audio in ${chaptersDir} — `
            + `concat/encode bars will wait for e2a's own progress lines`);
          return;
        }
        // e2a's own figure wins if it landed while this was in flight: it describes the
        // exact stream being written, whereas this totals what is on disk.
        if (totalAudioSeconds > 0) return;
        totalAudioSeconds = seconds;
        console.log(`[REASSEMBLY] Measured ${(seconds / 3600).toFixed(2)}h of chapter audio`
          + ` — concat/encode progress is now a real fraction`);
      });
    };

    // Send initial progress with totalChapters if known
    if (totalChapters > 0) {
      emitStage('combine', null, `Preparing to combine ${totalChapters} chapters...`, {
        currentChapter: 0,
        totalChapters,
      });
    }

    // Heartbeat timer to keep the UI alive during long encodes. It refreshes the
    // MESSAGE only — the encode bar holds its last measured fraction rather than
    // creeping upward on a timer, so the bar never claims progress ffmpeg hasn't made.
    const heartbeatInterval = setInterval(() => {
      const now = Date.now();
      if (currentPhase === 'encoding' && encodingStartTime > 0) {
        // Only send heartbeat if no progress for 5+ seconds
        if (now - lastProgressUpdate > 5000) {
          const mins = Math.floor((now - encodingStartTime) / 60000);
          emitStage('encode', null, mins > 0 ? `Encoding M4B… (${mins}m elapsed)` : 'Encoding M4B…');
          lastProgressUpdate = now;
        }
      }
    }, 5000);
    activeHeartbeats.set(jobId, heartbeatInterval);

    // Every phase now owns its OWN bar (see STAGE_ALWAYS) instead of being squeezed
    // into a band of one shared 0-100 range, so these updates set a fraction WITHIN
    // a stage — "chapter 14 of 31" is 45% of `combine`, not 22% of the whole job.

    // Throttle stdout progress (Assemble/Export %) to avoid flooding renderer.
    // The stage tracker is updated IMMEDIATELY (it's just arithmetic, and keeping it
    // current is what makes the fractions monotonic); only the IPC send is deferred,
    // and it always publishes the tracker's latest state.
    const STDOUT_THROTTLE_MS = 500;
    let lastStdoutProgressTime = 0;
    let pendingStdoutProgress: { name: string; message: string; currentChapter?: number; totalChapters?: number } | null = null;

    /** Advance a stage now; publish on the next throttle window. */
    const queueStage = (
      name: string,
      pct: number | null,
      message: string,
      extra?: { currentChapter?: number; totalChapters?: number },
    ): void => {
      if (pct === null) stages.start(name);
      else stages.set(name, pct);
      pendingStdoutProgress = { name, message, ...extra };
    };

    /** Publish a deferred stage update using the tracker's CURRENT state. */
    const flushStage = (
      pending: { name: string; message: string; currentChapter?: number; totalChapters?: number },
    ): void => {
      sendProgress(mainWindow, jobId, {
        phase: STAGE_PHASE[pending.name],
        percentage: stages.master(),
        message: pending.message,
        stages: stages.snapshot(),
        currentChapter: pending.currentChapter,
        totalChapters: pending.totalChapters,
      });
    };

    proc.stdout?.on('data', (data: Buffer) => {
      const now = Date.now();
      const throttleExpired = now - lastStdoutProgressTime >= STDOUT_THROTTLE_MS;

      // Error-looking chunks must ALWAYS be stringified + captured, even mid-throttle.
      // e2a's failure text ("Export failed: …", tracebacks, '"success": false') is
      // infrequent, so this can't cause the OOM the fast-path guards against — but it
      // IS the one thing we can't afford to drop when diagnosing a failed assembly.
      // (Note "Export failed" contains "Export", so without this it would be skipped
      // by the high-freq guard below during an export-progress burst.)
      const looksLikeError = data.includes('Traceback') || data.includes('Error') ||
        data.includes('error') || data.includes('Exception') || data.includes('failed') ||
        data.includes('Failed') || data.includes('corrupted') || data.includes('false');

      // ── Fast path: skip high-frequency progress lines during throttle window ──
      // "Assemble - XX%" and "Export - XX%" fire hundreds of times per second.
      // Calling data.toString() + regex on each creates V8 string objects faster
      // than GC can collect them, causing OOM on large books (30+ chapters).
      // Buffer.includes() searches raw bytes without allocating JS strings.
      if (!throttleExpired && !looksLikeError) {
        const hasHighFreq = data.includes('Assemble') || data.includes('Export') || data.includes('speed=');
        if (hasHighFreq) {
          // Check if the chunk ALSO contains a rare phase-transition pattern.
          // These are infrequent (per-chapter / per-phase) and must be processed.
          const hasRare =
            data.includes('completed!') ||   // "Assemble completed!"
            data.includes('Assembling') ||   // "Assembling all N chapters"
            data.includes('[ASSEMBLE]') ||   // "[ASSEMBLE] Chapter N"
            data.includes('Combining') ||    // "Combining chapter N" / "Combining chapters into final"
            data.includes('Combined') ||     // "Combined block audio file saved"
            data.includes('Concatenat') ||   // "Concatenating"
            data.includes('Splitting') ||    // "Splitting disabled"
            data.includes('Creating') ||     // "Creating subtitles" / "Creating single file"
            data.includes('flac') ||         // "flac (native) -> aac"
            data.includes('Output #0') ||    // "Output #0, ipod"
            data.includes('Adding') ||       // "Adding metadata"
            data.includes('success') ||      // '"success": true'
            data.includes('saved to');       // "Audiobook saved to:"
          if (!hasRare) return; // Pure progress line — skip toString() entirely
        }
        // Lines with no known pattern at all: still skip during throttle to avoid
        // toString() on unknown high-frequency output (ffmpeg stats, debug logs).
        if (!hasHighFreq && !data.includes('Chapter') && !data.includes('success') &&
            !data.includes('saved to') && !data.includes('Output') && !data.includes('metadata') &&
            !data.includes('Adding') && !data.includes('Creating') && !data.includes('.m4b')) {
          return;
        }
      }

      const line = data.toString();
      stdoutTail = appendCapped(stdoutTail, line);

      // Parse progress from e2a output
      // Parse "Assemble - XX%" progress lines (per-chapter sentence combining progress)
      const assembleMatch = line.match(/Assemble\s*-\s*([\d.]+)%/);
      if (assembleMatch) {
        currentChapterProgress = parseFloat(assembleMatch[1]);
        currentPhase = 'combining';

        // Fraction WITHIN the combine stage: chapters finished, plus how far into the
        // current one. Counted from chapters actually STARTED, never from e2a's chapter
        // number — that number indexes the whole book, so a run with excluded chapters
        // reaches "chapter 19" while only 12 are being assembled, which reads as >100%
        // and retires the stage early.
        const combinePct = totalChapters > 0 && chaptersStarted > 0
          ? ((chaptersStarted - 1 + currentChapterProgress / 100) / totalChapters) * 100
          : null;

        queueStage('combine', combinePct,
          chaptersStarted > 0 && totalChapters > 0
            ? `Combining chapter ${chaptersStarted}/${totalChapters}`
            : 'Combining sentences',
          { currentChapter: chaptersStarted || undefined, totalChapters: totalChapters || undefined });
      }

      // Parse "Export - XX%" progress lines (encoding to M4B)
      const exportMatch = line.match(/Export\s*-\s*([\d.]+)%/);
      if (exportMatch) {
        const pct = parseFloat(exportMatch[1]);
        currentPhase = 'encoding';
        if (!encodingStartTime) encodingStartTime = now;
        queueStage('encode', pct, `Encoding M4B (${pct.toFixed(0)}%)`);
      }

      // Flush pending progress at most every STDOUT_THROTTLE_MS
      if (pendingStdoutProgress) {
        if (throttleExpired) {
          lastStdoutProgressTime = now;
          lastProgressUpdate = now;
          flushStage(pendingStdoutProgress);
          pendingStdoutProgress = null;
        }
      }

      // "Assemble completed!" indicates chapter combining is done, moving to concatenation
      if (line.includes('Assemble completed!')) {
        currentPhase = 'concatenating';
        emitStage('combine', 100, 'Chapters combined, preparing export...');
      }

      // Phase 1: Get total chapters from "Assembling all N chapters..." or "Assembling audiobook from X chapters..."
      if (line.includes('Assembling all') || line.includes('Assembling audiobook from')) {
        const totalMatch = line.match(/Assembling (?:all |audiobook from )(\d+) chapters/);
        if (totalMatch) {
          totalChapters = parseInt(totalMatch[1], 10);
          currentPhase = 'combining';
          emitStage('combine', null, `Combining sentences into ${totalChapters} chapters...`, {
            currentChapter: 0,
            totalChapters,
          });
        }
      } else if ((line.includes('[ASSEMBLE] Chapter') || line.includes('Combining chapter')) && !line.includes('Combining chapters into final')) {
        // Phase 1: "[ASSEMBLE] Chapter N: sentences X-Y" or "Combining chapter N:" - combining sentences into chapter FLACs
        const match = line.match(/(?:\[ASSEMBLE\] Chapter|Combining chapter)\s*(\d+)/);
        if (match) {
          // e2a's number is the chapter's index in the WHOLE book; what the bar needs is
          // how many of the SELECTED chapters have been started, which is just a count.
          currentChapter = parseInt(match[1], 10);
          chaptersStarted++;
          currentChapterProgress = 0;  // Reset progress for new chapter
          currentPhase = 'combining';
          // No chapter total yet → no honest fraction. The count in the message still
          // tells the user work is happening.
          emitStage('combine', totalChapters > 0 ? ((chaptersStarted - 1) / totalChapters) * 100 : null,
            `Combining chapter ${chaptersStarted}${totalChapters > 0 ? `/${totalChapters}` : ''}...`,
            { currentChapter: chaptersStarted, totalChapters: totalChapters || undefined });
        }
      } else if (line.includes('Combined block audio file saved')) {
        // Chapter FLAC saved - update progress based on chapters completed
        // Note: e2a also prints "Completed →" for the same event, only count one
        chaptersCompleted++;
        currentChapterProgress = 100;  // Mark current chapter as done
        emitStage('combine', totalChapters > 0 ? (chaptersCompleted / totalChapters) * 100 : null,
          `Chapter ${chaptersCompleted}${totalChapters > 0 ? `/${totalChapters}` : ''} complete`,
          { currentChapter: chaptersCompleted, totalChapters: totalChapters || undefined });
      } else if (line.includes('Creating VTT subtitle file')) {
        // e2a builds the VTT immediately AFTER the last chapter FLAC and before the final
        // concat — the one unambiguous marker that chapter combining is genuinely done,
        // and therefore the earliest point the chapter files can be totalled.
        currentPhase = 'concatenating';
        measureTotalAudio();
        // Its own stage now: five minutes on a large book, and it used to happen in the
        // dead space between combine=100% and concat=0%.
        emitStage('subtitles', null, 'Building subtitle track...');
      } else if (line.includes('Combining chapters into final') || line.includes('Concatenating')) {
        // Concatenating the chapter FLACs into one big FLAC. Reported under `encode`:
        // it is under a minute even on a 35-hour book, so it earns a message, not a bar.
        currentPhase = 'concatenating';
        measureTotalAudio();
        emitStage('encode', null, 'Concatenating chapters into final audio...', {
          currentChapter: totalChapters,
          totalChapters,
        });
      } else if (line.includes('Splitting disabled') || line.includes('Creating single file')) {
        // Still in concatenation phase — and the one line that reveals the book's
        // total length, which the encode stage later divides ffmpeg's position by.
        const hourMatch = line.match(/([\d.]+)h of audio/);
        const duration = hourMatch ? hourMatch[1] : '';
        if (hourMatch) totalAudioSeconds = parseFloat(hourMatch[1]) * 3600;
        emitStage('encode', null,
          duration ? `Concatenating ${duration} hours of audio...` : 'Concatenating chapters...');
      } else if (currentPhase === 'concatenating' && line.includes('time=')) {
        // ffmpeg progress during concatenation. Same arithmetic as the encode stage:
        // time= is the audio POSITION written so far, so position ÷ total length is a
        // real fraction. This used to pin the bar at a fixed 60 on every one of these
        // lines, so the longer the book the longer it sat still — 34 hours of audio
        // concatenates for tens of minutes, all of it at "60%", which is exactly when a
        // user concludes it has hung. Falls back to no fraction (not a made-up one) when
        // the total is unknown; the message still says what is happening.
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          const written = parseInt(timeMatch[1], 10) * 3600
            + parseInt(timeMatch[2], 10) * 60
            + parseInt(timeMatch[3], 10);
          // No fraction: this is the sub-minute concat, reported inside `encode` whose
          // own bar starts when the AAC pass does. The position still shows it moving.
          emitStage('encode', null,
            totalAudioSeconds > 0
              ? `Concatenating audio — ${formatClock(written)} of ${formatClock(totalAudioSeconds)}`
              : 'Concatenating chapter audio files...');
        }
      } else if (line.includes('Creating subtitles')) {
        emitStage('subtitles', null, 'Creating subtitles...');
      } else if (line.includes('-> #0:0 (flac (native) -> aac')) {
        // Phase 3: AAC encoding started (FLAC to M4B)
        currentPhase = 'encoding';
        encodingStartTime = Date.now();
        lastProgressUpdate = Date.now();
        // Also measured here, not only on the concat lines: a run that reaches encoding
        // without printing a recognised concat line would otherwise encode a whole book
        // with no denominator and no moving bar.
        measureTotalAudio();
        emitStage('encode', 0, 'Encoding to M4B audiobook...');
      } else if (line.includes('Output #0, ipod') || line.includes('to \'') && line.includes('.m4b')) {
        // M4B encoding in progress
        currentPhase = 'encoding';
        if (!encodingStartTime) {
          encodingStartTime = Date.now();
          lastProgressUpdate = Date.now();
        }
        emitStage('encode', null, 'Encoding M4B audiobook...');
      } else if (currentPhase === 'encoding' && line.includes('size=') && line.includes('time=')) {
        // ffmpeg progress during encoding. time= is the audio POSITION written so far,
        // so position ÷ total length is a real fraction — no estimate needed once the
        // total is known.
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          const written = parseInt(timeMatch[1], 10) * 3600
            + parseInt(timeMatch[2], 10) * 60
            + parseInt(timeMatch[3], 10);
          emitStage('encode',
            totalAudioSeconds > 0 ? Math.min(100, (written / totalAudioSeconds) * 100) : null,
            totalAudioSeconds > 0
              ? `Encoding to AAC — ${formatClock(written)} of ${formatClock(totalAudioSeconds)}`
              : 'Encoding audio to AAC...');
        }
      } else if (line.includes('Adding metadata') || line.includes('chapter markers') || line.includes('Chapter #')) {
        // Phase 4: Metadata
        currentPhase = 'metadata';
        emitStage('metadata', 20, 'Adding chapter markers and metadata...');
      } else if (line.includes('"success": true') || line.includes('"success":true')) {
        // Parse JSON success output from e2a
        try {
          const jsonMatch = line.match(/\{.*"success":\s*true.*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.output_files && result.output_files[0]) {
              outputPath = result.output_files[0];
              // e2a running in WSL emits /mnt/... paths — convert to Windows
              if (sessionInWsl) outputPath = wslToWindowsPath(outputPath);
              console.log('[REASSEMBLY] Output path from JSON:', outputPath);
            }
          }
        } catch (e) {
          // Not valid JSON, try regex
        }
        emitStage('metadata', 40, 'Finalizing audiobook...');
      } else if (line.includes('Audiobook saved to:') || line.includes('Output:')) {
        // Extract output path from text
        const pathMatch = line.match(/(?:Audiobook saved to:|Output:)\s*(.+\.m4b)/i);
        if (pathMatch) {
          outputPath = pathMatch[1].trim();
          // e2a running in WSL emits /mnt/... paths — convert to Windows
          if (sessionInWsl) outputPath = wslToWindowsPath(outputPath);
        }
      }
    });

    // Throttle stderr progress to avoid flooding the renderer with IPC messages.
    // FFmpeg emits progress lines many times per second; each sendProgress triggers
    // Angular change detection, which can freeze the UI.
    const STDERR_THROTTLE_MS = 1000;
    let lastStderrProgressTime = 0;
    let pendingStderrProgress: { name: string; message: string } | null = null;

    proc.stderr?.on('data', (data: Buffer) => {
      const now = Date.now();
      const stderrThrottleExpired = now - lastStderrProgressTime >= STDERR_THROTTLE_MS;

      // ── Fast path: skip high-frequency FFmpeg progress during throttle window ──
      // FFmpeg emits size=/time=/speed= lines many times per second. Same OOM risk
      // as stdout Assemble/Export lines. Only convert to string when throttle expires
      // or when the chunk contains a rare pattern (VTT, cover, Export start).
      if (!stderrThrottleExpired) {
        const hasFFmpegProgress = data.includes('size=') || data.includes('time=') || data.includes('speed=');
        const hasExport = data.includes('Export');
        if (hasFFmpegProgress || hasExport) {
          const hasRare = data.includes('VTT') || data.includes('cover') || data.includes('Adding');
          if (!hasRare) return;
        }
      }

      const line = data.toString();
      stderr = appendCapped(stderr, line);

      // FFmpeg progress (stderr) — ONLY while the job is actually encoding.
      //
      // ffmpeg does not run once: e2a shells out to it for every chapter's sentence
      // concat too, so `time=`/`size=` lines stream all through chapter combining. The
      // old condition was `currentPhase === 'encoding' || line.includes('size=') || …`,
      // where the `||` made the phase check meaningless and every per-chapter ffmpeg
      // line was read as encoding progress. That was survivable when progress was a
      // single free-running percentage, but stages are ORDERED — touching `encode`
      // completes every stage before it — so the first chapter's concat slammed
      // "Combining chapters" to 100% while the chapter counter underneath still read
      // 6/12. Stage ADVANCEMENT now comes only from unambiguous stdout markers; stderr
      // may refine the stage those markers established, never jump ahead of them.
      if (currentPhase === 'encoding') {
        // Parse time=HH:MM:SS.mm format for progress estimation
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const seconds = parseInt(timeMatch[3], 10);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;

          if (!encodingStartTime) encodingStartTime = now;
          // Real fraction when the book's length is known (from the "Nh of audio"
          // line); otherwise the message alone carries the news.
          if (totalAudioSeconds > 0) stages.set('encode', (totalSeconds / totalAudioSeconds) * 100);
          pendingStderrProgress = {
            name: 'encode',
            message: `Encoding: ${hours}h ${minutes}m ${seconds}s processed...`
          };
        }

        // Parse size for additional feedback
        const sizeMatch = line.match(/size=\s*(\d+)kB/);
        if (sizeMatch && !timeMatch) {
          const sizeMB = Math.round(parseInt(sizeMatch[1], 10) / 1024);
          if (!encodingStartTime) encodingStartTime = now;
          pendingStderrProgress = {
            name: 'encode',
            message: `Encoding: ${sizeMB}MB written...`
          };
        }
      }

      // Also check for Export progress in stderr (some versions output here)
      const exportMatchStderr = line.match(/Export\s*-\s*([\d.]+)%/);
      if (exportMatchStderr) {
        const pct = parseFloat(exportMatchStderr[1]);

        // Track export start for ETA calculation
        if (exportStartTime === 0 || pct < lastExportPct) {
          exportStartTime = now;
          exportStartPct = pct;
        }
        lastExportPct = pct;

        // Calculate ETA
        let etaDisplay = '';
        const elapsed = (now - exportStartTime) / 1000;
        const pctDone = pct - exportStartPct;
        if (elapsed > 5 && pctDone > 0.5) {
          const pctRemaining = 100 - pct;
          const secondsPerPct = elapsed / pctDone;
          const etaSeconds = pctRemaining * secondsPerPct;
          etaDisplay = ` — ETA: ${formatEta(etaSeconds)}`;
        }

        currentPhase = 'encoding';
        if (!encodingStartTime) encodingStartTime = now;
        stages.set('encode', pct);
        pendingStderrProgress = {
          name: 'encode',
          message: `Encoding M4B (${pct.toFixed(1)}%)${etaDisplay}`
        };
      }

      // Flush pending progress at most once per second
      if (pendingStderrProgress) {
        if (stderrThrottleExpired) {
          lastStderrProgressTime = now;
          lastProgressUpdate = now;
          flushStage(pendingStderrProgress);
          pendingStderrProgress = null;
        }
      }

      // Subtitle / cover chatter. These are bare substring matches on arbitrary stderr —
      // "VTT" and "cover" show up in ffmpeg banners and file paths long before either
      // step runs — so they only refresh the MESSAGE of the stage the stdout markers
      // have already reached. Letting them set a stage was what allowed a stray line to
      // declare chapter combining finished.
      if (line.includes('VTT')) {
        emitStage(stages.current()?.name ?? 'metadata', null, 'Creating subtitle file...');
      }
      if (line.includes('cover') || line.includes('Adding cover')) {
        emitStage(stages.current()?.name ?? 'metadata', null, 'Adding cover image...');
      }
    });

    // ── The finalize keys off 'close' OR 'exit'-plus-drain, whichever first ──
    //
    // 'close' fires when the stdio STREAMS close, and e2a's app.py spawns
    // multiprocessing children that inherit stdout. A parent that dies leaving
    // such a child leaves the pipe open, and 'close' then never fires at all —
    // which stranded a COMPLETE Nuremberg m4b in staging, unregistered, with no
    // error said anywhere (2026-08-11: the parent died of STATUS_HEAP_CORRUPTION
    // right after finishing the m4b; the orphan held the pipe for an hour until
    // it was reaped by hand). 'exit' always fires when the process ends, so it
    // arms a bounded wait for whatever the pipes still owe, and the finalize
    // runs once from whichever event reaches it first.
    let finalized = false;
    const finalizeOnce = async (code: number | null): Promise<void> => {
      if (finalized) return;
      finalized = true;
      clearInterval(heartbeatInterval);
      activeHeartbeats.delete(jobId);

      // If stopReassembly() already removed this job, the close event is a ghost — clean up and bail
      if (!activeReassemblies.has(jobId)) {
        console.log('[REASSEMBLY] Close event after stop, ignoring (ghost prevention)');
        resolve({ success: false, error: 'Cancelled by user' });
        return;
      }
      activeReassemblies.delete(jobId);

      // Flush any pending throttled progress
      if (pendingStdoutProgress) {
        flushStage(pendingStdoutProgress);
        pendingStdoutProgress = null;
      }
      if (pendingStderrProgress) {
        flushStage(pendingStderrProgress);
        pendingStderrProgress = null;
      }

      if (code === 0) {
        // Find the output file if we don't have it yet
        if (!outputPath && stagingDir) {
          // Try to find the output file in the staging directory
          // Exclude macOS resource forks (._* files)
          const outputFiles = fs.readdirSync(stagingDir).filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
          if (outputFiles.length > 0) {
            // Find the most recently modified m4b
            const sortedFiles = outputFiles
              .map(f => ({ name: f, path: path.join(stagingDir, f), mtime: fs.statSync(path.join(stagingDir, f)).mtime }))
              .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            outputPath = sortedFiles[0].path;
          }
        }

        // Rename output file if a custom filename was requested in project.json.
        // A run filing a SECOND version uses the name that carries its voice, so
        // the two readings sit beside each other instead of one overwriting the
        // other on the way in.
        const wantedFilename = variantFiling
          ? variantFiling.outputFilename
          : config.metadata?.outputFilename;
        if (outputPath && fs.existsSync(outputPath) && wantedFilename) {
          const customFilename = wantedFilename;
          // Ensure it has .m4b extension
          const filenameWithExt = customFilename.endsWith('.m4b') ? customFilename : `${customFilename}.m4b`;
          // Sanitize filename (remove invalid characters)
          const sanitized = filenameWithExt.replace(/[<>:"/\\|?*]/g, '_');
          const newPath = path.join(path.dirname(outputPath), sanitized);

          if (newPath !== outputPath) {
            try {
              emitStage('metadata', 70, `Renaming to ${sanitized}...`);
              fs.renameSync(outputPath, newPath);
              console.log(`[REASSEMBLY] Renamed output file: ${outputPath} -> ${newPath}`);
              outputPath = newPath;
            } catch (renameErr) {
              console.error('[REASSEMBLY] Failed to rename output file:', renameErr);
              // Continue without renaming - not a critical failure
            }
          }
        }

        // Locate the transcript produced in THIS reassembly run so we can SEAL it into
        // the m4b below.
        //
        // e2a's export MOVES the VTT out of process_dir into its --output_dir (our
        // staging dir) as its final act — lib/core.py `shutil.move(proc_vtt_path,
        // final_vtt_path)`, in place since 2025-12-20. So scanning ONLY processDir
        // found nothing on every standalone reassembly, and an empty scan is
        // indistinguishable from "this book has no transcript": the embed below was
        // skipped in total silence, the sidecar binder then had no embedded track to
        // extract and recorded `vtt: skipped-none`, and e2a's raw-named VTT rode the
        // promotion into output/ as an unbound stray no player looks for. Search
        // staging FIRST (where a completed export leaves it), then processDir (where
        // it remains if export never reached the move).
        let sealVttSource: string | undefined;
        if (outputPath) {
          const vttSearchDirs = [stagingDir, config.processDir].filter((d): d is string => !!d);
          for (const dir of vttSearchDirs) {
            let found: string[];
            try {
              found = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.vtt') && !f.startsWith('._'));
            } catch (vttErr) {
              console.warn(`[REASSEMBLY] Could not scan ${dir} for the transcript:`, vttErr);
              continue;
            }
            if (found.length > 0) {
              sealVttSource = path.join(dir, found[0]);
              break;
            }
          }
          if (!sealVttSource) {
            reassemblyLog.error('No transcript produced by this reassembly', {
              jobId, outputPath, searched: vttSearchDirs,
            });
            console.error(
              '[REASSEMBLY] No transcript found — searched:', vttSearchDirs.join(', '),
              '\n  The audiobook will have NO transcript and the sidecar binder will record vtt: skipped-none.'
            );
          }
        }

        // ── Completeness gate: the m4b must be as long as its own transcript ──
        //
        // exit-0 from e2a and a playable file prove NOTHING about completeness:
        // ffmpeg can lose its parent mid-encode and still finalize a valid,
        // moov-carrying, TRUNCATED m4b (Nuremberg 2026-08-11: 14.72h of a 20.12h
        // book, promoted by hand because everything about the file looked done).
        // The VTT written by the same assembly pass ends where the audio must
        // end, so a file materially shorter than its transcript is a truncated
        // export and is refused here — staging is kept for diagnosis, nothing is
        // promoted or registered. A measurement that cannot be made is a refusal
        // too, not a shrug: promoting an unverifiable file is how this defect
        // shipped the first time.
        if (outputPath && fs.existsSync(outputPath) && sealVttSource && fs.existsSync(sealVttSource)) {
          const lastCueEnd = lastVttCueEndSeconds(fs.readFileSync(sealVttSource, 'utf8'));
          if (lastCueEnd !== null) {
            let m4bSeconds: number | null = null;
            let probeError: string | null = null;
            try {
              m4bSeconds = (await probeAudio(outputPath)).durationSec;
            } catch (probeErr) {
              probeError = (probeErr as Error).message;
            }
            const shortfall = m4bSeconds === null ? null : lastCueEnd - m4bSeconds;
            if (m4bSeconds === null || (shortfall as number) > 5) {
              const detail = m4bSeconds === null
                ? `its duration could not be measured (${probeError})`
                : `it carries ${(m4bSeconds / 3600).toFixed(2)}h of audio but its own transcript `
                  + `ends at ${(lastCueEnd / 3600).toFixed(2)}h — ${((shortfall as number) / 60).toFixed(1)} `
                  + 'minutes of narration are missing from the file';
              const error = `Assembly produced an incomplete audiobook: ${detail}. `
                + 'The file was NOT promoted; it remains in the staging directory for diagnosis.';
              reassemblyLog.error('Truncated/unverifiable m4b refused at finalize', {
                jobId, outputPath, m4bSeconds, lastCueEnd, probeError,
              });
              console.error(`[REASSEMBLY] ${error}`);
              resolve({ success: false, error });
              return;
            }
          }
        }

        // Apply extended metadata with m4b-tool if output file exists
        if (outputPath && fs.existsSync(outputPath)) {
          await applyM4bMetadata(outputPath, config.metadata, jobId,
            (pct, message) => emitStage('metadata', pct, message));
        }

        // Seal the transcript INTO the m4b as a subtitle track — the single source of
        // truth (embed-only). Runs AFTER metadata (that remux doesn't carry subtitles,
        // so embedding must be last). The staging sidecar is ALWAYS removed afterward so
        // none promotes to output/; on embed FAILURE the audiobook simply has no
        // transcript (loud error) — there is no sidecar fallback.
        if (outputPath && sealVttSource && fs.existsSync(outputPath) && fs.existsSync(sealVttSource)) {
          emitStage('metadata', 90, 'Embedding transcript…');
          let embedded = false;
          try {
            embedded = await embedAndVerifyVtt(outputPath, sealVttSource, { language });
          } catch (embedErr) {
            reassemblyLog.error('Transcript embed threw', {
              jobId, outputPath, sealVttSource, error: (embedErr as Error).message,
            });
            console.error('[REASSEMBLY] Failed to embed transcript:', embedErr);
          }
          if (embedded) {
            console.log('[REASSEMBLY] Embedded transcript into m4b:', outputPath);
            // Only NOW is the staging copy redundant — the m4b carries the transcript
            // and regenerateBoundSidecars re-extracts it into the bound sidecar below.
            deleteSidecarsForM4b(outputPath);
            // …and it is gone, so it is no longer a transcript this run can hand to
            // the sidecar binder. Clearing it keeps `sealVttSource` meaning exactly
            // one thing: "the loose transcript this run still owns, wherever it is".
            sealVttSource = undefined;
          } else {
            // KEEP the staging .vtt. With no embedded track it is the only transcript
            // this run produced, and deleting it (as the old embed-only rule did)
            // destroys the only thing a repair could be built from. It rides the
            // promotion into output/ below and is then BOUND to the m4b as a
            // hash-verified sidecar — the audiobook keeps its transcript even when
            // the embed could not be written.
            reassemblyLog.error('Transcript NOT embedded — falling back to a bound sidecar', {
              jobId, outputPath, sealVttSource,
            });
            console.error('[REASSEMBLY] Transcript NOT embedded; the staging .vtt will be bound as a sidecar instead:', sealVttSource);
          }
        }

        // ── Promote: staging → output dir ──
        // All post-processing happened in staging. Move the finished files to
        // config.outputDir, then VERIFY the M4B actually landed there before
        // declaring success.
        //
        // CRITICAL invariant: a promotion failure must NEVER (a) report success
        // — the queue would lie and the project page would show nothing — nor
        // (b) delete the staging dir, which holds the ONLY copy of the freshly
        // built M4B + VTT. Losing it is unrecoverable (the prior code deleted
        // staging in its catch/else and still resolved success — e.g. when the
        // old output M4B was open in a player, unlinking it threw EBUSY, the
        // catch wiped staging, and the new files were gone forever). On any
        // failure we keep staging intact for salvage/retry and report the error.
        const promotionFailed = (msg: string, err?: unknown): void => {
          if (err) console.error('[REASSEMBLY] Promotion failed:', err);
          else console.error('[REASSEMBLY] Promotion failed:', msg);
          // Do NOT cleanupStagingDir — preserve the built files in stagingDir.
          activeStagingDirs.delete(jobId);
          sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error: msg });
          reassemblyLog.error('Reassembly promotion failed', { jobId, stagingDir, outputPath, error: msg });
          resolve({ success: false, error: msg });
        };

        // The rename/unlink retries that this promotion needs on a synced volume
        // live in ./fs-retry — the same policy the transcript embed uses, so a
        // locked file behaves identically wherever we replace one.

        if (outputPath && fs.existsSync(outputPath)) {
          try {
            // 1. Move the freshly built files into the output dir under UNIQUE TEMP
            //    names FIRST — before touching the old output. This is the core fix:
            //    the old output is never deleted until the new files are confirmed on
            //    disk, so a failed move can't leave the project with no audiobook (the
            //    previous delete-old-then-move order did exactly that when the move hit
            //    EBUSY on the synced drive). staging lives under outputDir, so these are
            //    same-filesystem renames (no EXDEV).
            const staged: { tmp: string; dest: string; isOutput: boolean; isSealVtt: boolean }[] = [];
            const stagingFiles = fs.readdirSync(stagingDir);
            for (const file of stagingFiles) {
              const src = path.join(stagingDir, file);
              if (!fs.statSync(src).isFile()) continue;
              // A transcript embed that could not replace the m4b leaves its scratch
              // mux behind — a FULL-SIZE copy of the audiobook. It is not an output:
              // promoting it stranded two 1.4 GB `.embed-*.m4b` files in the Nuremberg
              // output folder (2026-08-14). Delete it here so no exit path leaks it.
              if (isEmbedTempFileName(file)) {
                try {
                  await unlinkWithRetry(src);
                  reassemblyLog.warn('Removed a leftover transcript-embed temp file', { jobId, file });
                } catch (tmpErr) {
                  reassemblyLog.error('Could not remove a leftover transcript-embed temp file', {
                    jobId, file, error: (tmpErr as Error).message,
                  });
                }
                continue;
              }
              /*
               * A SECOND VERSION'S FILES ALL CARRY ITS OWN STEM.
               *
               * The M4B was already renamed in staging, but everything else this
               * run produced — the transcript, a video if one was made — still
               * carries the name e2a derived from the BOOK, which is the base
               * audiobook's stem. Promoted unchanged, this run's transcript
               * would land on top of the other version's, and the folder would
               * hold two readings with one set of sidecars between them.
               *
               * Staging contains only what THIS run built, so renaming
               * everything in it is exactly right and needs no per-extension
               * rule.
               */
              const promotedName = variantFiling
                ? `${path.basename(
                  variantFiling.outputFilename,
                  path.extname(variantFiling.outputFilename),
                )}${path.extname(file)}`
                : file;
              const dest = path.join(config.outputDir, promotedName);
              const tmp = `${dest}.promote-${jobId}.tmp`;
              await renameWithRetry(src, tmp);
              staged.push({ tmp, dest, isOutput: src === outputPath, isSealVtt: src === sealVttSource });
            }

            // 2. New files are safe in the output dir now — remove the OLD audiobook
            //    files. Each unlink is isolated + retried so a briefly-locked file
            //    doesn't abort promotion; genuinely stuck ones are collected for the
            //    hint. (Our just-moved temps end in .tmp, so the m4b/vtt/mp4 filter
            //    below never touches them.)
            //
            //    A run filing a SECOND version sweeps NOTHING. The audiobooks
            //    already in this folder are other readings of the same book —
            //    the very thing it was started to sit beside — and the sweep
            //    would delete the original on the way to filing its
            //    alternative. Its own previous file, if this voice has been run
            //    before, is replaced by name in step 3 like any other output.
            const lockedOld: string[] = [];
            if (!variantFiling && fs.existsSync(config.outputDir)) {
              for (const file of fs.readdirSync(config.outputDir)) {
                if (file.startsWith('bilingual-') || file === 'session' || file.startsWith('.staging-')) continue;
                if (file.endsWith('.m4b') || file.endsWith('.vtt') || file.endsWith('.mp4')) {
                  const filePath = path.join(config.outputDir, file);
                  try {
                    if (fs.statSync(filePath).isFile()) {
                      await unlinkWithRetry(filePath);
                      console.log(`[REASSEMBLY] Cleaned up old output file: ${file}`);
                    }
                  } catch (unlinkErr) {
                    console.warn(`[REASSEMBLY] Could not remove old output file ${file} (in use?):`, unlinkErr);
                    lockedOld.push(file);
                  }
                }
              }
            }

            // 3. Put the new files at their final names. If an old file with the same
            //    name survived step 2 (still locked), replace it: remove then rename,
            //    both retried.
            for (const s of staged) {
              if (fs.existsSync(s.dest)) await unlinkWithRetry(s.dest);
              await renameWithRetry(s.tmp, s.dest);
              console.log(`[REASSEMBLY] Promoted ${path.basename(s.dest)} to output`);
              if (s.isOutput) outputPath = s.dest;
              // Follow the un-embedded transcript to its new home so the sidecar
              // binder below is handed a path that still exists.
              if (s.isSealVtt) sealVttSource = s.dest;
            }

            // Only clean staging once everything moved out cleanly.
            cleanupStagingDir(jobId);

            // Verify the M4B is now at its final name in the output dir (not still in
            // staging, nor left as a temp).
            if (!outputPath || !fs.existsSync(outputPath) || outputPath.includes('.staging-') || outputPath.endsWith('.tmp')) {
              const hint = lockedOld.length
                ? ` A previous output file may be open in another app: ${lockedOld.join(', ')}. Close it and re-run Assemble.`
                : '';
              promotionFailed(`The finished audiobook was assembled but couldn't be moved into the output folder.${hint}`);
              return;
            }
          } catch (moveErr) {
            const busy = isTransientFsError(moveErr);
            const hint = busy ? ' A previous output file is likely open in another app (e.g. a player); it stayed locked through several retries. Close it and re-run Assemble.' : '';
            promotionFailed(`Failed to move the finished audiobook from staging to the output folder.${hint} Your audio is preserved in: ${stagingDir}`, moveErr);
            return;
          }
        } else {
          // The finished M4B is missing before promotion (an earlier step lost
          // it). Preserve staging for salvage and report failure — never succeed.
          promotionFailed(`Assembly finished but the output audiobook was missing before it could be saved. Anything produced is preserved in: ${stagingDir}`);
          return;
        }

        // Register the finished audiobook in the project manifest HERE in the main
        // process, so it's deterministic. The renderer-side link (queue.service →
        // audiobook:link-audio) silently skips when this reassembly job carries no
        // project directory (or the renderer misses the completion event), which left the m4b on
        // disk but absent from the library (outputs.audiobook stayed empty).
        //
        // A run filing a SECOND version writes a manifest VARIANT instead —
        // `registerAudiobookOutput` overwrites `outputs.audiobook`, which is the
        // pointer at the book's own audiobook and belongs to the reading this
        // run was started to sit beside. See electron/audiobook-variant-filing.ts.
        try {
          const reg = variantFiling
            ? await registerRvcAudiobookVariant(outputPath, variantFiling, {
              title: config.metadata?.title,
              author: config.metadata?.author,
              year: config.metadata?.year,
              coverPath: config.metadata?.coverPath,
            })
            : await manifestService.registerAudiobookOutput(outputPath, { professionallyRead: false });
          if (reg.skipped) {
            reassemblyLog.warn('Audiobook not registered in manifest (outside library)', { jobId, outputPath });
          } else if (!reg.success) {
            reassemblyLog.error('Failed to register audiobook in manifest', { jobId, outputPath, error: reg.error });
          } else {
            reassemblyLog.info('Registered audiobook in manifest', {
              jobId, outputPath, ...(variantFiling ? { variantId: variantFiling.variantId } : {}),
            });
          }
        } catch (regErr) {
          reassemblyLog.error('Manifest registration threw', { jobId, error: (regErr as Error).message });
        }

        // Re-bind the transcript/cover sidecars to the NEW m4b bytes.
        //
        // The sidecar binding is hash-bound ON PURPOSE (bookforge-sidecar-binding-v1):
        // a reader serves a sidecar only when the m4b still hashes to the recorded
        // value, so a transcript can never spill onto the wrong audio. Reassembly
        // rewrites the m4b, which invalidates that hash — and until now nothing
        // refreshed it here, so after any reassembly the binding pointed at the
        // PREVIOUS file and the book read as having no transcript.
        //
        // This was invisible before 2026-07-27 because reassembly reproduced
        // byte-identical audio, so the stale hash still matched. The chunk-gap floor
        // changes the bytes, so it surfaced immediately (The Mysterious Stranger).
        //
        // The VTT itself is NOT stale: e2a's build_vtt_file ffprobes each sentence
        // file it concatenates, and we point it at the gap-normalised dir, so cue
        // times already track the floored audio (verified to the millisecond —
        // last cue 03:52:41.378 against a 13961.378 s m4b). Only the binding needed
        // refreshing. regenerateBoundSidecars is best-effort and never throws.
        //
        // When the embed FAILED, `sealVttSource` still names the transcript this run
        // produced (now promoted next to the m4b) and it is handed over explicitly.
        // The binder used to read only the embedded track and the manifest, so a
        // failed embed produced `vtt: skipped-none` — the safety net reporting "no
        // transcript" while the transcript sat in the same folder (Nuremberg,
        // 2026-08-14). Naming the file is not a guess: this code built it.
        try {
          const bound = await regenerateBoundSidecars(
            outputPath,
            sealVttSource ? { vttPath: sealVttSource } : undefined,
          );
          const vttAction = bound?.vtt.action ?? 'none';
          const coverAction = bound?.cover.action ?? 'none';
          // A mono audiobook always has a transcript, so 'skipped-none' here means the
          // chain upstream broke — it is a defect, not a normal outcome. Reporting it
          // at INFO is exactly how it slipped through two rounds of "fixed".
          if (vttAction === 'written' || vttAction === 'would-write') {
            reassemblyLog.info('Sidecar binding refreshed', {
              jobId, outputPath, vtt: vttAction, vttSource: bound?.vtt.source, cover: coverAction,
            });
            // The transcript is now bound to these exact m4b bytes at `<m4b>.vtt`.
            // The loose `<stem>.vtt` it was built from is a stray no player looks
            // for; deleteSidecarsForM4b removes strays and PROTECTS bound sidecars
            // (it refuses any .vtt that has a `.sidecars.json` beside it).
            deleteSidecarsForM4b(outputPath);
          } else {
            reassemblyLog.error('Sidecar binding produced NO transcript', { jobId, outputPath, vtt: vttAction, cover: coverAction });
            console.error(`[REASSEMBLY] Sidecar binding produced NO transcript (vtt: ${vttAction}) — players will show none for:`, outputPath);
          }
        } catch (bindErr) {
          reassemblyLog.warn('Sidecar rebind threw (non-fatal)', { jobId, error: (bindErr as Error).message });
        }

        stages.completeAll();
        sendProgress(mainWindow, jobId, {
          phase: 'complete',
          percentage: 100,
          message: 'Reassembly complete!',
          stages: stages.snapshot()
        });
        reassemblyLog.info('Reassembly complete', { jobId, outputPath });
        resolve({ success: true, outputPath });
      } else {
        cleanupStagingDir(jobId);
        // e2a reports failures on stdout, ffmpeg on stderr — prefer whichever we
        // captured so the user/log sees the real cause, not a bare exit code.
        const stderrTrim = stderr.trim();
        const stdoutTrim = stdoutTail.trim();
        const detail = stderrTrim || stdoutTrim;
        const errorMsg = detail
          ? `Assembly failed (exit ${code}): ${detail.slice(-1200)}`
          : `Process exited with code ${code}`;
        sendProgress(mainWindow, jobId, {
          phase: 'error',
          percentage: 0,
          error: errorMsg
        });
        // Log the full captured tails so a post-mortem has everything, even when
        // the UI message is truncated.
        reassemblyLog.error('Reassembly failed', {
          jobId,
          code,
          error: errorMsg,
          stderrTail: stderrTrim.slice(-4000),
          stdoutTail: stdoutTrim.slice(-4000),
        });
        resolve({ success: false, error: errorMsg });
      }
    };

    proc.on('close', (code) => { void finalizeOnce(code); });
    proc.on('exit', (code) => {
      setTimeout(() => {
        if (!finalized) {
          console.warn(
            '[REASSEMBLY] Process exited but its pipes stayed open (an orphaned child holding '
            + 'stdout?) — finalizing from the exit code after the drain timeout.'
          );
          void finalizeOnce(code);
        }
      }, 30_000);
    });

    proc.on('error', (err) => {
      clearInterval(heartbeatInterval);
      activeHeartbeats.delete(jobId);
      activeReassemblies.delete(jobId);
      cleanupStagingDir(jobId);
      sendProgress(mainWindow, jobId, {
        phase: 'error',
        percentage: 0,
        error: err.message
      });
      reassemblyLog.error('Reassembly process error', { jobId, error: err.message });
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Stop an active reassembly process
 */
export function stopReassembly(jobId: string): boolean {
  const proc = activeReassemblies.get(jobId);
  if (!proc) {
    // Even if the main process is gone, there may be a stuck metadata subprocess
    const metadataAbort = activeMetadataAborts.get(jobId);
    if (metadataAbort) {
      metadataAbort.abort();
      activeMetadataAborts.delete(jobId);
      return true;
    }
    return false;
  }

  // Abort any in-flight metadata subprocess
  activeMetadataAborts.get(jobId)?.abort();
  activeMetadataAborts.delete(jobId);

  // Clear heartbeat interval
  const hb = activeHeartbeats.get(jobId);
  if (hb) {
    clearInterval(hb);
    activeHeartbeats.delete(jobId);
  }

  // Remove from active map BEFORE killing so the close handler knows it was cancelled
  activeReassemblies.delete(jobId);
  cleanupStagingDir(jobId);
  proc.kill('SIGTERM');

  // Send cancellation progress so the UI cleans up the progress bar
  const mainWindow = BrowserWindow.getAllWindows()[0] ?? null;
  sendProgress(mainWindow, jobId, {
    phase: 'error',
    percentage: 0,
    error: 'Cancelled by user'
  });

  return true;
}

/**
 * Send progress update to renderer
 */
function sendProgress(
  mainWindow: BrowserWindow | null,
  jobId: string,
  progress: ReassemblyProgress
): void {
  publishBridgeEvent('reassembly:progress', { jobId, progress });
  if (!mainWindow) return;

  mainWindow.webContents.send('reassembly:progress', { jobId, progress });
}

/**
 * Check if e2a is available
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export function isE2aAvailable(customTmpPath?: string): boolean {
  const tmpPath = customTmpPath || getDefaultE2aTmpPath();
  const e2aPath = getE2aAppPath(tmpPath);
  return fs.existsSync(e2aPath) && fs.existsSync(path.join(e2aPath, 'app.py'));
}

/**
 * Get a cached TTS session from a single project's audiobook folder.
 * Much faster than scanE2aTmpFolder() since it only checks one book.
 * @param projectDir - Absolute project directory
 */
export async function getBfpCachedSession(projectDir: string): Promise<E2aSession | null> {
  // Canonical location: stages/03-tts/sessions/{lang}/ebook-{uuid}/
  const stagesSessionDir = path.join(projectDir, 'stages', '03-tts', 'sessions');
  try {
    await fs.promises.access(stagesSessionDir);
  } catch {
    return null;
  }

  const langDirs = await fs.promises.readdir(stagesSessionDir, { withFileTypes: true });
  for (const langEntry of langDirs) {
    if (!langEntry.isDirectory()) continue;
    const langDir = path.join(stagesSessionDir, langEntry.name);
    const entries = await fs.promises.readdir(langDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('ebook-')) continue;
      const sessionDir = path.join(langDir, entry.name);
      const sessionId = entry.name.replace('ebook-', '');
      try {
        const session = await parseSession(sessionId, sessionDir);
        if (session) {
          session.source = 'project-cache';
          return session;
        }
      } catch (err) {
        console.error(`[REASSEMBLY] Error parsing cached session ${sessionId}:`, err);
      }
    }
  }

  return null;
}

/**
 * Apply extended metadata to M4B using the shared metadata-tools module
 * (bundled ffmpeg — no third-party tagger)
 */
async function applyM4bMetadata(
  m4bPath: string,
  metadata: ReassemblyConfig['metadata'],
  jobId: string,
  /** Reports into the caller's `metadata` stage — this helper owns no tracker of its own. */
  reportProgress: (pct: number, message: string) => void
): Promise<{ success: boolean; error?: string }> {
  // Check if a metadata tool is available
  const toolInfo = getMetadataToolPath();
  if (!toolInfo) {
    console.log('[REASSEMBLY] No metadata tool found, skipping metadata application');
    return { success: true };  // Not an error - just skip if not available
  }

  console.log(`[REASSEMBLY] Using metadata tool: ${toolInfo.tool} at ${toolInfo.path}`);

  if (!fs.existsSync(m4bPath)) {
    return { success: false, error: 'M4B file not found for metadata application' };
  }

  // Build metadata object for the shared module
  const metadataToApply: AudiobookMetadata = {};

  if (metadata.title) {
    metadataToApply.title = metadata.title;
  }
  if (metadata.author) {
    metadataToApply.author = metadata.author;
  }
  if (metadata.year) {
    metadataToApply.year = metadata.year;
  }
  if (metadata.narrator) {
    metadataToApply.narrator = metadata.narrator;
  }
  if (metadata.series) {
    metadataToApply.series = metadata.series;
    if (metadata.seriesNumber) {
      metadataToApply.seriesNumber = metadata.seriesNumber;
    }
  }
  if (metadata.genre) {
    metadataToApply.genre = metadata.genre;
  }
  if (metadata.description) {
    metadataToApply.description = metadata.description;
  }
  if (metadata.coverPath && fs.existsSync(metadata.coverPath)) {
    metadataToApply.coverPath = metadata.coverPath;
  }

  // If no metadata to apply, skip
  if (Object.keys(metadataToApply).length === 0) {
    console.log('[REASSEMBLY] No extended metadata to apply');
    return { success: true };
  }

  console.log('[REASSEMBLY] Applying metadata:', metadataToApply);

  reportProgress(50, `Applying extended metadata with ${toolInfo.tool}...`);

  const controller = new AbortController();
  activeMetadataAborts.set(jobId, controller);

  try {
    // applyMetadata maps only the chosen cover (any existing/Calibre-generated
    // cover is dropped) in a single lossless `-c copy` remux, so no separate
    // cover-strip pass is needed. Timeout is generous — a remux rewrites the
    // whole file, which is seconds for a normal book but longer for multi-GB ones.
    await applyMetadata(m4bPath, metadataToApply, {
      timeoutMs: 300_000,
      signal: controller.signal
    });
    console.log('[REASSEMBLY] Metadata applied successfully');
    return { success: true };
  } catch (err) {
    console.error('[REASSEMBLY] Metadata application failed:', err);
    // Don't fail the whole job - metadata is non-critical
    return { success: true };
  } finally {
    activeMetadataAborts.delete(jobId);
  }
}

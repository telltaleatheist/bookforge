/**
 * Reassembly Bridge - Scans e2a tmp folder for incomplete sessions and handles reassembly
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { getDefaultE2aPath, getDefaultE2aTmpPath, getCondaActivation, getCondaRunArgs, getCondaPath, getWslDistro, getWslCondaPath, getWslE2aPath, windowsToWslPath, wslToWindowsPath } from './e2a-paths';
import * as os from 'os';
import { getMetadataToolPath, removeCover, applyMetadata, AudiobookMetadata } from './metadata-tools';
import { getReassemblyLogger } from './rolling-logger';
import * as manifestService from './manifest-service';

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

// Default E2A tmp path (uses cross-platform detection)
const DEFAULT_E2A_TMP_PATH = getDefaultE2aTmpPath();

// The e2a app path (uses cross-platform detection)
const E2A_APP_PATH = getDefaultE2aPath();

/**
 * BFP metadata that can be linked to e2a sessions
 */
interface BfpMetadata {
  bfpPath: string;          // Path to project.json
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
 * Get BFP metadata from source_epub_path
 * The session's source_epub_path points directly to the project output folder (e.g., .../projects/Book_Name/output/cleaned.epub)
 * Metadata comes from project.json - if it doesn't exist, there's no BFP metadata
 */
async function getBfpMetadataFromSourcePath(sourceEpubPath: string | undefined): Promise<BfpMetadata | null> {
  if (!sourceEpubPath) return null;

  // Convert WSL path to Windows if needed
  let windowsPath = sourceEpubPath;
  if (sourceEpubPath.startsWith('/mnt/')) {
    windowsPath = wslToWindowsPath(sourceEpubPath);
  }

  // Get the BFP folder (parent of cleaned.epub, simplified.epub, or exported.epub)
  const bfpFolder = path.dirname(windowsPath);

  // project.json is the single source of truth for BFP metadata
  const projectJsonPath = path.join(bfpFolder, 'project.json');

  try {
    const content = await fs.promises.readFile(projectJsonPath, 'utf-8');
    const project = JSON.parse(content);

    const bfpMetadata: BfpMetadata = {
      bfpPath: projectJsonPath,
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
    if (bfpMetadata.coverPath && !path.isAbsolute(bfpMetadata.coverPath)) {
      const absoluteCoverPath = path.join(bfpFolder, bfpMetadata.coverPath);
      try {
        await fs.promises.access(absoluteCoverPath);
        bfpMetadata.coverPath = absoluteCoverPath;
      } catch {
        // Relative path doesn't exist — clear it so manifest fallback can kick in
        bfpMetadata.coverPath = undefined;
      }
    } else if (bfpMetadata.coverPath && path.isAbsolute(bfpMetadata.coverPath)) {
      // Absolute path — verify it exists (may be from another platform)
      try {
        await fs.promises.access(bfpMetadata.coverPath);
      } catch {
        console.warn(`[REASSEMBLY] BFP cover path not found (cross-platform?): ${bfpMetadata.coverPath}`);
        bfpMetadata.coverPath = undefined;
      }
    }

    return bfpMetadata;
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
  bfpPath?: string;   // Path to linked BFP project.json (if found)
  source?: 'e2a-tmp' | 'bfp-cache';  // Where this session was found
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
}

export interface ReassemblyProgress {
  phase: 'preparing' | 'combining' | 'encoding' | 'metadata' | 'complete' | 'error';
  percentage: number;
  currentChapter?: number;
  totalChapters?: number;
  message?: string;
  error?: string;
}

// Active reassembly processes
const activeReassemblies = new Map<string, ChildProcess>();

// Active metadata AbortControllers (so stopReassembly can cancel metadata)
const activeMetadataAborts = new Map<string, AbortController>();

// Active heartbeat intervals (so stopReassembly can clear them)
const activeHeartbeats = new Map<string, NodeJS.Timeout>();

// Active staging directories (so stopReassembly and error handlers can clean up)
const activeStagingDirs = new Map<string, string>();

/**
 * Remove a staging directory and clean up the map entry.
 * Logs but does not throw on failure.
 */
function cleanupStagingDir(jobId: string): void {
  const stagingDir = activeStagingDirs.get(jobId);
  if (!stagingDir) return;
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

/**
 * Scan the e2a tmp folder for incomplete sessions
 * BFP metadata is extracted from each session's source_epub_path
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function scanE2aTmpFolder(customTmpPath?: string, libraryPath?: string): Promise<{ sessions: E2aSession[]; tmpPath: string }> {
  const sessions: E2aSession[] = [];
  const tmpPath = customTmpPath || DEFAULT_E2A_TMP_PATH;

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

  // Scan project folders for cached sessions in stages/03-tts/sessions/{lang}/
  if (libraryPath) {
    const projectsDir = path.join(libraryPath, 'projects');
    try {
      const projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      for (const projectEntry of projectDirs) {
        if (!projectEntry.isDirectory()) continue;
        const stagesSessionDir = path.join(projectsDir, projectEntry.name, 'stages', '03-tts', 'sessions');
        let langDirs;
        try {
          langDirs = await fs.promises.readdir(stagesSessionDir, { withFileTypes: true });
        } catch { continue; }
        for (const langEntry of langDirs) {
          if (!langEntry.isDirectory()) continue;
          const langDir = path.join(stagesSessionDir, langEntry.name);
          const langEntries = await fs.promises.readdir(langDir, { withFileTypes: true });
          for (const entry of langEntries) {
            if (!entry.isDirectory() || !entry.name.startsWith('ebook-')) continue;
            const sessionDir = path.join(langDir, entry.name);
            const sessionId = entry.name.replace('ebook-', '');
            if (sessions.some(s => s.sessionId === sessionId)) continue;
            try {
              const session = await parseSession(sessionId, sessionDir);
              if (session) {
                session.source = 'bfp-cache';
                sessions.push(session);
              }
            } catch (err) {
              console.error(`[REASSEMBLY] Error parsing cached session ${sessionId}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error('[REASSEMBLY] Error scanning project session folders:', err);
    }
  }

  // Sort by modification date, newest first
  sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  return { sessions, tmpPath };
}

/**
 * Parse a single session directory
 * BFP metadata is extracted from source_epub_path in the session state
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
  const [sessionState, chapterSentences, sentenceFiles, stats] = await Promise.all([
    parseSessionState(processDir),
    parseChapterSentences(processDir),
    fs.promises.readdir(sentencesDir).catch(() => [] as string[]),
    fs.promises.stat(sessionDir)
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

  // Get BFP metadata from source_epub_path
  const bfpMetadata = await getBfpMetadataFromSourcePath(sessionState?.source_epub_path);

  let metadata: E2aSession['metadata'];
  if (bfpMetadata) {
    metadata = {
      title: bfpMetadata.title,
      author: bfpMetadata.author,
      language: sessionState?.metadata?.language,
      epubPath: sessionState?.source_epub_path,
      coverPath: bfpMetadata.coverPath,
      year: bfpMetadata.year,
      narrator: bfpMetadata.narrator,
      series: bfpMetadata.series,
      seriesNumber: bfpMetadata.seriesNumber,
      genre: bfpMetadata.genre,
      description: bfpMetadata.description,
      outputFilename: bfpMetadata.outputFilename
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
    bfpPath: bfpMetadata?.bfpPath
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
 * BFP metadata is extracted from the session's source_epub_path
 * @param sessionId - The session ID (UUID part after ebook-)
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function getSession(sessionId: string, customTmpPath?: string): Promise<E2aSession | null> {
  const tmpPath = customTmpPath || DEFAULT_E2A_TMP_PATH;
  const sessionDir = path.join(tmpPath, `ebook-${sessionId}`);

  try {
    await fs.promises.access(sessionDir);
  } catch {
    return null;
  }

  return parseSession(sessionId, sessionDir);
}

/**
 * Delete a session's tmp folder
 * @param sessionId - The session ID (UUID part after ebook-)
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function deleteSession(sessionId: string, customTmpPath?: string): Promise<boolean> {
  const tmpPath = customTmpPath || DEFAULT_E2A_TMP_PATH;
  const sessionDir = path.join(tmpPath, `ebook-${sessionId}`);

  try {
    await fs.promises.access(sessionDir);
  } catch {
    // Directory doesn't exist
    return false;
  }

  try {
    console.log(`[REASSEMBLY] Deleting session folder (async): ${sessionDir}`);
    await fs.promises.rm(sessionDir, { recursive: true, force: true });
    console.log(`[REASSEMBLY] Deleted session folder: ${sessionDir}`);
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
  jobId: string,
  config: ReassemblyConfig,
  mainWindow: BrowserWindow | null
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const reassemblyLog = getReassemblyLogger();

  // Derive e2a app path from tmp path (parent directory)
  const tmpPath = config.e2aTmpPath || DEFAULT_E2A_TMP_PATH;
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

  // Validate cover path exists on this machine — cross-platform synced projects may
  // have paths from another OS (e.g., /Volumes/... from Mac when running on Windows)
  if (config.metadata?.coverPath && !fs.existsSync(config.metadata.coverPath)) {
    console.warn(`[REASSEMBLY] Cover path does not exist (cross-platform?): ${config.metadata.coverPath}`);
    config.metadata.coverPath = undefined;
  }

  // Resolve cover from manifest if not provided or invalid
  if (!config.metadata?.coverPath && config.outputDir) {
    const projectDir = path.dirname(config.outputDir); // outputDir is {projectDir}/output
    const projectId = path.basename(projectDir);
    try {
      const mResult = await manifestService.getManifest(projectId);
      if (mResult.success && mResult.manifest?.metadata?.coverPath) {
        const libRoot = manifestService.getLibraryBasePath();
        const absCover = path.join(libRoot, mResult.manifest.metadata.coverPath);
        if (fs.existsSync(absCover)) {
          if (!config.metadata) config.metadata = { title: '', author: '' };
          config.metadata.coverPath = absCover;
          console.log(`[REASSEMBLY] Resolved cover from manifest: ${absCover}`);
        }
      }
    } catch {
      // Non-fatal — continue without cover
    }
  }

  // Copy project cover to session directory, replacing any e2a-extracted cover
  // e2a uses covers from the processDir (cleaned.jpg, cover.jpg, etc.) during assembly
  if (config.metadata?.coverPath && fs.existsSync(config.metadata.coverPath)) {
    try {
      const ext = path.extname(config.metadata.coverPath).toLowerCase() || '.jpg';
      const targetCoverPath = path.join(config.processDir, `cover${ext}`);
      fs.copyFileSync(config.metadata.coverPath, targetCoverPath);
      console.log(`[REASSEMBLY] Copied project cover to session: ${config.metadata.coverPath} -> ${targetCoverPath}`);
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

  // Create staging directory inside output/ so e2a writes there (same filesystem = atomic rename).
  // Dot-prefix makes Syncthing unlikely to index partial files.
  const stagingDir = path.join(config.outputDir, `.staging-${jobId}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  activeStagingDirs.set(jobId, stagingDir);
  console.log(`[REASSEMBLY] Created staging dir: ${stagingDir}`);

  // Send initial progress
  sendProgress(mainWindow, jobId, {
    phase: 'preparing',
    percentage: 0,
    message: 'Preparing reassembly...'
  });

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
      '--no_split'
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
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        shell: false
      });
    } else {
      // Standard Windows/macOS/Linux spawn
      // Insert --cwd before 'python' so conda explicitly sets the working directory.
      // e2a's lib/conf.py uses open('VERSION.txt') with a relative path, which requires
      // cwd to be the e2a root. spawn's cwd option doesn't reliably propagate through
      // conda run in packaged Electron apps.
      const baseCondaArgs = getCondaRunArgs(e2aPath);
      const pythonIdx = baseCondaArgs.indexOf('python');
      const condaArgs = pythonIdx >= 0
        ? [...baseCondaArgs.slice(0, pythonIdx), '--cwd', e2aPath, ...baseCondaArgs.slice(pythonIdx), ...appArgs]
        : [...baseCondaArgs, '--cwd', e2aPath, ...appArgs];
      console.log('[REASSEMBLY] Running command: conda', condaArgs.join(' '));

      proc = spawn(getCondaPath(), condaArgs, {
        cwd: e2aPath,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      });
    }

    activeReassemblies.set(jobId, proc);

    let stderr = '';
    let outputPath = '';
    // Use totalChapters from config if provided (allows UI to show progress immediately)
    let totalChapters = config.totalChapters || 0;
    let chaptersCompleted = 0;
    let currentChapter = 0;  // The chapter currently being processed (1-indexed)
    let currentChapterProgress = 0;  // 0-100 progress within current chapter
    let currentPhase: 'combining' | 'concatenating' | 'encoding' | 'metadata' = 'combining';
    let lastProgressUpdate = Date.now();
    let encodingStartTime = 0;
    let exportStartTime = 0;
    let exportStartPct = 0;
    let lastExportPct = 0;

    // Send initial progress with totalChapters if known
    if (totalChapters > 0) {
      sendProgress(mainWindow, jobId, {
        phase: 'combining',
        percentage: 1,
        currentChapter: 0,
        totalChapters,
        message: `Preparing to combine ${totalChapters} chapters...`
      });
    }

    // Heartbeat timer to keep UI responsive during long encoding
    // Sends periodic updates even if FFmpeg isn't producing parseable progress
    const heartbeatInterval = setInterval(() => {
      const now = Date.now();
      if (currentPhase === 'encoding' && encodingStartTime > 0) {
        // Only send heartbeat if no progress for 5+ seconds
        if (now - lastProgressUpdate > 5000) {
          sendProgress(mainWindow, jobId, {
            phase: 'encoding',
            percentage: Math.min(89, 65 + Math.floor((now - encodingStartTime) / 60000)), // Slowly increment to show activity
            message: 'Encoding M4B...'
          });
          lastProgressUpdate = now;
        }
      }
    }, 5000);
    activeHeartbeats.set(jobId, heartbeatInterval);

    // Progress ranges for each phase:
    // Combining chapters: 0-50% (sentences into chapter FLACs)
    // Concatenating: 50-65% (chapter FLACs into one FLAC)
    // Encoding: 65-90% (FLAC to M4B with AAC)
    // Metadata: 90-100% (chapter markers, tags, m4b-tool)

    // Throttle stdout progress (Assemble/Export %) to avoid flooding renderer
    const STDOUT_THROTTLE_MS = 500;
    let lastStdoutProgressTime = 0;
    let pendingStdoutProgress: any = null;

    proc.stdout?.on('data', (data: Buffer) => {
      const now = Date.now();
      const throttleExpired = now - lastStdoutProgressTime >= STDOUT_THROTTLE_MS;

      // ── Fast path: skip high-frequency progress lines during throttle window ──
      // "Assemble - XX%" and "Export - XX%" fire hundreds of times per second.
      // Calling data.toString() + regex on each creates V8 string objects faster
      // than GC can collect them, causing OOM on large books (30+ chapters).
      // Buffer.includes() searches raw bytes without allocating JS strings.
      if (!throttleExpired) {
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

      // Parse progress from e2a output
      // Parse "Assemble - XX%" progress lines (per-chapter sentence combining progress)
      const assembleMatch = line.match(/Assemble\s*-\s*([\d.]+)%/);
      if (assembleMatch) {
        currentChapterProgress = parseFloat(assembleMatch[1]);
        currentPhase = 'combining';

        // Calculate overall progress: combining phase is 0-50% of total
        let overallPct: number;
        if (totalChapters > 0 && currentChapter > 0) {
          const completedChapters = currentChapter - 1;
          overallPct = Math.round(((completedChapters + currentChapterProgress / 100) / totalChapters) * 50);
        } else {
          overallPct = Math.round(currentChapterProgress * 0.4);
        }

        pendingStdoutProgress = {
          phase: 'combining',
          percentage: overallPct,
          currentChapter: currentChapter || undefined,
          totalChapters: totalChapters || undefined,
          message: currentChapter > 0 && totalChapters > 0
            ? `Combining chapter ${currentChapter}/${totalChapters}`
            : `Combining sentences`
        };
      }

      // Parse "Export - XX%" progress lines (encoding to M4B)
      const exportMatch = line.match(/Export\s*-\s*([\d.]+)%/);
      if (exportMatch) {
        const pct = parseFloat(exportMatch[1]);

        const totalPct = Math.round(50 + pct * 0.45);
        currentPhase = 'encoding';
        pendingStdoutProgress = {
          phase: 'encoding',
          percentage: totalPct,
          message: `Encoding M4B (${pct.toFixed(0)}%)`
        };
      }

      // Flush pending progress at most every STDOUT_THROTTLE_MS
      if (pendingStdoutProgress) {
        if (throttleExpired) {
          lastStdoutProgressTime = now;
          lastProgressUpdate = now;
          sendProgress(mainWindow, jobId, pendingStdoutProgress);
          pendingStdoutProgress = null;
        }
      }

      // "Assemble completed!" indicates chapter combining is done, moving to concatenation
      if (line.includes('Assemble completed!')) {
        currentPhase = 'concatenating';
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: 45,
          message: 'Chapters combined, preparing export...'
        });
      }

      // Phase 1: Get total chapters from "Assembling all N chapters..." or "Assembling audiobook from X chapters..."
      if (line.includes('Assembling all') || line.includes('Assembling audiobook from')) {
        const totalMatch = line.match(/Assembling (?:all |audiobook from )(\d+) chapters/);
        if (totalMatch) {
          totalChapters = parseInt(totalMatch[1], 10);
          currentPhase = 'combining';
          sendProgress(mainWindow, jobId, {
            phase: 'combining',
            percentage: 1,
            currentChapter: 0,
            totalChapters,
            message: `Combining sentences into ${totalChapters} chapters...`
          });
        }
      } else if ((line.includes('[ASSEMBLE] Chapter') || line.includes('Combining chapter')) && !line.includes('Combining chapters into final')) {
        // Phase 1: "[ASSEMBLE] Chapter N: sentences X-Y" or "Combining chapter N:" - combining sentences into chapter FLACs
        const match = line.match(/(?:\[ASSEMBLE\] Chapter|Combining chapter)\s*(\d+)/);
        if (match) {
          currentChapter = parseInt(match[1], 10);
          currentChapterProgress = 0;  // Reset progress for new chapter
          const total = totalChapters || currentChapter;  // Use current as fallback (we know at least this many exist)
          currentPhase = 'combining';
          // Progress: completed chapters / total * 50%
          const completedChapters = currentChapter - 1;
          const pct = total > 0 ? Math.round((completedChapters / total) * 50) : 0;
          sendProgress(mainWindow, jobId, {
            phase: 'combining',
            percentage: pct,
            currentChapter,
            totalChapters: total,
            message: `Combining chapter ${currentChapter}/${total}...`
          });
        }
      } else if (line.includes('Combined block audio file saved')) {
        // Chapter FLAC saved - update progress based on chapters completed
        // Note: e2a also prints "Completed →" for the same event, only count one
        chaptersCompleted++;
        currentChapterProgress = 100;  // Mark current chapter as done
        const total = totalChapters || chaptersCompleted;
        const pct = total > 0 ? Math.round((chaptersCompleted / total) * 50) : 0;
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: pct,
          currentChapter: chaptersCompleted,
          totalChapters: total,
          message: `Chapter ${chaptersCompleted}/${total} complete`
        });
      } else if (line.includes('Combining chapters into final') || line.includes('Concatenating')) {
        // Phase 2: Concatenating all chapter FLACs into one big FLAC
        currentPhase = 'concatenating';
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: 50,
          currentChapter: totalChapters,
          totalChapters,
          message: 'Concatenating chapters into final audio...'
        });
      } else if (line.includes('Splitting disabled') || line.includes('Creating single file')) {
        // Still in concatenation phase
        const hourMatch = line.match(/([\d.]+)h of audio/);
        const duration = hourMatch ? hourMatch[1] : '';
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: 52,
          message: duration ? `Concatenating ${duration} hours of audio...` : 'Concatenating chapters...'
        });
      } else if (currentPhase === 'concatenating' && line.includes('speed=')) {
        // ffmpeg progress during concatenation - parse speed
        const speedMatch = line.match(/speed=([\d.]+)e?\+?(\d+)?x/);
        if (speedMatch) {
          // Still concatenating
          sendProgress(mainWindow, jobId, {
            phase: 'combining',
            percentage: 55,
            message: 'Concatenating chapter audio files...'
          });
        }
      } else if (line.includes('Creating subtitles')) {
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: 60,
          message: 'Creating subtitles...'
        });
      } else if (line.includes('-> #0:0 (flac (native) -> aac')) {
        // Phase 3: AAC encoding started (FLAC to M4B)
        currentPhase = 'encoding';
        encodingStartTime = Date.now();
        lastProgressUpdate = Date.now();
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: 65,
          message: 'Encoding to M4B audiobook...'
        });
      } else if (line.includes('Output #0, ipod') || line.includes('to \'') && line.includes('.m4b')) {
        // M4B encoding in progress
        currentPhase = 'encoding';
        if (!encodingStartTime) {
          encodingStartTime = Date.now();
          lastProgressUpdate = Date.now();
        }
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: 70,
          message: 'Encoding M4B audiobook...'
        });
      } else if (currentPhase === 'encoding' && line.includes('size=') && line.includes('time=')) {
        // ffmpeg progress during encoding - parse time for progress estimate
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          // Rough estimate: 65-90% range for encoding
          sendProgress(mainWindow, jobId, {
            phase: 'encoding',
            percentage: 75,
            message: 'Encoding audio to AAC...'
          });
        }
      } else if (line.includes('Adding metadata') || line.includes('chapter markers') || line.includes('Chapter #')) {
        // Phase 4: Metadata
        currentPhase = 'metadata';
        sendProgress(mainWindow, jobId, {
          phase: 'metadata',
          percentage: 90,
          message: 'Adding chapter markers and metadata...'
        });
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
        sendProgress(mainWindow, jobId, {
          phase: 'metadata',
          percentage: 95,
          message: 'Finalizing audiobook...'
        });
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
    let pendingStderrProgress: { phase: string; percentage: number; message: string } | null = null;

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

      // FFmpeg outputs progress to stderr, not stdout
      // Parse FFmpeg progress during encoding phase
      if (currentPhase === 'encoding' || line.includes('size=') || line.includes('time=') || line.includes('speed=')) {
        // Parse time=HH:MM:SS.mm format for progress estimation
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1], 10);
          const minutes = parseInt(timeMatch[2], 10);
          const seconds = parseInt(timeMatch[3], 10);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;

          const estimatedProgress = Math.min(85, 50 + Math.floor(totalSeconds / 600) * 5);

          currentPhase = 'encoding';
          if (!encodingStartTime) encodingStartTime = now;
          pendingStderrProgress = {
            phase: 'encoding',
            percentage: estimatedProgress,
            message: `Encoding: ${hours}h ${minutes}m ${seconds}s processed...`
          };
        }

        // Parse size for additional feedback
        const sizeMatch = line.match(/size=\s*(\d+)kB/);
        if (sizeMatch && !timeMatch) {
          const sizeMB = Math.round(parseInt(sizeMatch[1], 10) / 1024);
          currentPhase = 'encoding';
          if (!encodingStartTime) encodingStartTime = now;
          pendingStderrProgress = {
            phase: 'encoding',
            percentage: 70,
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

        const totalPct = Math.round(50 + pct * 0.45);
        currentPhase = 'encoding';
        if (!encodingStartTime) encodingStartTime = now;
        pendingStderrProgress = {
          phase: 'encoding',
          percentage: totalPct,
          message: `Encoding M4B (${pct.toFixed(1)}%)${etaDisplay}`
        };
      }

      // Flush pending progress at most once per second
      if (pendingStderrProgress) {
        if (stderrThrottleExpired) {
          lastStderrProgressTime = now;
          lastProgressUpdate = now;
          sendProgress(mainWindow, jobId, pendingStderrProgress as any);
          pendingStderrProgress = null;
        }
      }

      // Check for VTT/subtitle creation progress
      if (line.includes('[VTT]') || line.includes('VTT')) {
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: 48,
          message: 'Creating subtitle file...'
        });
      }

      // Check for cover embedding
      if (line.includes('cover') || line.includes('Adding cover')) {
        sendProgress(mainWindow, jobId, {
          phase: 'metadata',
          percentage: 95,
          message: 'Adding cover image...'
        });
      }
    });

    proc.on('close', async (code) => {
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
        sendProgress(mainWindow, jobId, pendingStdoutProgress);
        pendingStdoutProgress = null;
      }
      if (pendingStderrProgress) {
        sendProgress(mainWindow, jobId, pendingStderrProgress as any);
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

        // Rename output file if custom filename requested from BFP
        if (outputPath && fs.existsSync(outputPath) && config.metadata?.outputFilename) {
          const customFilename = config.metadata.outputFilename;
          // Ensure it has .m4b extension
          const filenameWithExt = customFilename.endsWith('.m4b') ? customFilename : `${customFilename}.m4b`;
          // Sanitize filename (remove invalid characters)
          const sanitized = filenameWithExt.replace(/[<>:"/\\|?*]/g, '_');
          const newPath = path.join(path.dirname(outputPath), sanitized);

          if (newPath !== outputPath) {
            try {
              sendProgress(mainWindow, jobId, {
                phase: 'metadata',
                percentage: 96,
                message: `Renaming to ${sanitized}...`
              });
              fs.renameSync(outputPath, newPath);
              console.log(`[REASSEMBLY] Renamed output file: ${outputPath} -> ${newPath}`);
              outputPath = newPath;
            } catch (renameErr) {
              console.error('[REASSEMBLY] Failed to rename output file:', renameErr);
              // Continue without renaming - not a critical failure
            }
          }
        }

        // Copy VTT subtitle file from processDir to output directory as audiobook.vtt
        if (outputPath && config.processDir) {
          try {
            const vttFiles = fs.readdirSync(config.processDir).filter(f => f.toLowerCase().endsWith('.vtt') && !f.startsWith('._'));
            if (vttFiles.length > 0) {
              const vttSource = path.join(config.processDir, vttFiles[0]);
              const outputDir = path.dirname(outputPath);
              const vttDest = path.join(outputDir, 'audiobook.vtt');
              fs.copyFileSync(vttSource, vttDest);
              console.log(`[REASSEMBLY] Copied VTT to output directory: ${vttSource} -> ${vttDest}`);
            }
          } catch (vttErr) {
            console.warn('[REASSEMBLY] Failed to copy VTT to output directory (non-fatal):', vttErr);
          }
        }

        // Apply extended metadata with m4b-tool if output file exists
        if (outputPath && fs.existsSync(outputPath)) {
          await applyMetadataWithM4bTool(outputPath, config.metadata, mainWindow, jobId);
        }

        // ── Atomic move: staging → output dir ──
        // All post-processing is done in staging. Now atomically move files to
        // config.outputDir so Syncthing only ever sees complete files.
        if (outputPath && fs.existsSync(outputPath)) {
          try {
            // Delete old standard audiobook files from outputDir (same logic as the removed pre-cleanup)
            if (fs.existsSync(config.outputDir)) {
              const existing = fs.readdirSync(config.outputDir);
              for (const file of existing) {
                if (file.startsWith('bilingual-') || file === 'session' || file.startsWith('.staging-')) continue;
                if (file.endsWith('.m4b') || file.endsWith('.vtt') || file.endsWith('.mp4')) {
                  const filePath = path.join(config.outputDir, file);
                  const stat = fs.statSync(filePath);
                  if (stat.isFile()) {
                    fs.unlinkSync(filePath);
                    console.log(`[REASSEMBLY] Cleaned up old output file: ${file}`);
                  }
                }
              }
            }

            // Move all files from staging to output dir
            const stagingFiles = fs.readdirSync(stagingDir);
            for (const file of stagingFiles) {
              const src = path.join(stagingDir, file);
              const dest = path.join(config.outputDir, file);
              if (fs.statSync(src).isFile()) {
                fs.renameSync(src, dest);
                console.log(`[REASSEMBLY] Moved ${file} from staging to output`);
                // Update outputPath if this is the M4B we're tracking
                if (src === outputPath) {
                  outputPath = dest;
                }
              }
            }

            // Clean up empty staging dir
            cleanupStagingDir(jobId);
          } catch (moveErr) {
            console.error('[REASSEMBLY] Failed to move files from staging (falling back):', moveErr);
            // Files are still in staging — try to salvage by updating outputPath
            cleanupStagingDir(jobId);
          }
        } else {
          // No output file found — clean up staging
          cleanupStagingDir(jobId);
        }

        sendProgress(mainWindow, jobId, {
          phase: 'complete',
          percentage: 100,
          message: 'Reassembly complete!'
        });
        reassemblyLog.info('Reassembly complete', { jobId, outputPath });
        resolve({ success: true, outputPath });
      } else {
        cleanupStagingDir(jobId);
        const errorMsg = stderr || `Process exited with code ${code}`;
        sendProgress(mainWindow, jobId, {
          phase: 'error',
          percentage: 0,
          error: errorMsg
        });
        reassemblyLog.error('Reassembly failed', { jobId, error: errorMsg });
        resolve({ success: false, error: errorMsg });
      }
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
  if (!mainWindow) return;

  mainWindow.webContents.send('reassembly:progress', { jobId, progress });
}

/**
 * Check if e2a is available
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export function isE2aAvailable(customTmpPath?: string): boolean {
  const tmpPath = customTmpPath || DEFAULT_E2A_TMP_PATH;
  const e2aPath = getE2aAppPath(tmpPath);
  return fs.existsSync(e2aPath) && fs.existsSync(path.join(e2aPath, 'app.py'));
}

/**
 * Get a cached TTS session from a single BFP project's audiobook folder.
 * Much faster than scanE2aTmpFolder() since it only checks one book.
 * @param bfpPath - Path to the .bfp file or project directory
 */
export async function getBfpCachedSession(bfpPath: string): Promise<E2aSession | null> {
  // Canonical location: stages/03-tts/sessions/{lang}/ebook-{uuid}/
  const stagesSessionDir = path.join(bfpPath, 'stages', '03-tts', 'sessions');
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
          session.source = 'bfp-cache';
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
 * Apply extended metadata to M4B using shared metadata-tools module
 * (uses tone on Windows, m4b-tool on macOS/Linux)
 */
async function applyMetadataWithM4bTool(
  m4bPath: string,
  metadata: ReassemblyConfig['metadata'],
  mainWindow: BrowserWindow | null,
  jobId: string
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

  sendProgress(mainWindow, jobId, {
    phase: 'metadata',
    percentage: 95,
    message: `Applying extended metadata with ${toolInfo.tool}...`
  });

  const controller = new AbortController();
  activeMetadataAborts.set(jobId, controller);

  try {
    await applyMetadata(m4bPath, metadataToApply, {
      timeoutMs: 60_000,
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

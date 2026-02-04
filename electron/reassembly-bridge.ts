/**
 * Reassembly Bridge - Scans e2a tmp folder for incomplete sessions and handles reassembly
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import { getDefaultE2aPath, getDefaultE2aTmpPath, getCondaActivation, getCondaRunArgs, getCondaPath, getWslDistro, getWslCondaPath, getWslE2aPath, windowsToWslPath } from './e2a-paths';
import * as os from 'os';
import { getMetadataToolPath, removeCover, applyMetadata, AudiobookMetadata } from './metadata-tools';
import { getReassemblyLogger } from './rolling-logger';

/**
 * Check if a path is a WSL path (starts with \\wsl$)
 */
function isWslPath(p: string): boolean {
  return p.startsWith('\\\\wsl$') || p.startsWith('//wsl$');
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
    // Convert UNC WSL paths (\\wsl$\Ubuntu\...) to native WSL paths (/...)
    if (arg.startsWith('\\\\wsl$\\Ubuntu\\') || arg.startsWith('//wsl$/Ubuntu/')) {
      return arg.replace(/^(\\\\wsl\$\\Ubuntu\\|\/\/wsl\$\/Ubuntu\/)/, '/').replace(/\\/g, '/');
    }
    // Also handle already-converted /mnt/c/ style paths that should stay as-is
    return arg;
  });

  const cdCommand = `cd "${wslE2aPath}"`;
  // Use WSL native app.py path
  const wslAppPath = `${wslE2aPath}/app.py`;
  const condaCommand = `"${wslCondaPath}" run --no-capture-output -p ${wslE2aPath}/python_env python ${wslAppPath} ${wslArgs.join(' ')}`;

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
 * The session's source_epub_path points directly to the BFP folder (e.g., .../audiobooks/Book_Name/cleaned.epub)
 * Metadata comes from project.json - if it doesn't exist, there's no BFP metadata
 */
function getBfpMetadataFromSourcePath(sourceEpubPath: string | undefined): BfpMetadata | null {
  if (!sourceEpubPath) return null;

  // Convert WSL path to Windows if needed
  let windowsPath = sourceEpubPath;
  if (sourceEpubPath.startsWith('/mnt/')) {
    // /mnt/e/... → E:/...
    const match = sourceEpubPath.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (match) {
      windowsPath = `${match[1].toUpperCase()}:/${match[2]}`;
    }
  }

  // Get the BFP folder (parent of cleaned.epub or exported.epub)
  const bfpFolder = path.dirname(windowsPath);
  if (!fs.existsSync(bfpFolder)) return null;

  // project.json is the single source of truth for BFP metadata
  const projectJsonPath = path.join(bfpFolder, 'project.json');
  if (!fs.existsSync(projectJsonPath)) return null;

  try {
    const content = fs.readFileSync(projectJsonPath, 'utf-8');
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
      if (fs.existsSync(absoluteCoverPath)) {
        bfpMetadata.coverPath = absoluteCoverPath;
      }
    }

    return bfpMetadata;
  } catch (err) {
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

/**
 * Scan the e2a tmp folder for incomplete sessions
 * BFP metadata is extracted from each session's source_epub_path
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function scanE2aTmpFolder(customTmpPath?: string): Promise<{ sessions: E2aSession[]; tmpPath: string }> {
  const sessions: E2aSession[] = [];
  const tmpPath = customTmpPath || DEFAULT_E2A_TMP_PATH;

  if (!fs.existsSync(tmpPath)) {
    return { sessions: [], tmpPath };
  }

  const entries = fs.readdirSync(tmpPath, { withFileTypes: true });

  for (const entry of entries) {
    // Look for ebook-* directories
    if (!entry.isDirectory() || !entry.name.startsWith('ebook-')) {
      continue;
    }

    const sessionDir = path.join(tmpPath, entry.name);
    const sessionId = entry.name.replace('ebook-', '');

    try {
      const session = await parseSession(sessionId, sessionDir);
      if (session) {
        sessions.push(session);
      }
    } catch (err) {
      console.error(`[REASSEMBLY] Error parsing session ${sessionId}:`, err);
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
  // Find the hash subfolder
  const subEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
  const hashDir = subEntries.find(e => e.isDirectory());

  if (!hashDir) {
    return null;
  }

  const processDir = path.join(sessionDir, hashDir.name);
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');

  // Check if sentences folder exists
  if (!fs.existsSync(sentencesDir)) {
    return null;
  }

  // Parse session state
  const sessionState = parseSessionState(processDir);
  const chapterSentences = parseChapterSentences(processDir);

  // Count completed sentences
  const completedSentences = countCompletedSentences(sentencesDir);

  // Determine total sentences (session-state.json uses snake_case)
  let totalSentences = sessionState?.total_sentences || chapterSentences?.total_sentences || 0;

  // If still no total, estimate from highest sentence file number
  if (totalSentences === 0) {
    totalSentences = estimateTotalFromFiles(sentencesDir);
  }

  // Build chapter info (chapter_titles is a separate array in session-state.json)
  const chapterTitles: string[] = sessionState?.chapter_titles || [];
  const chapters = buildChapterInfo(
    sessionState?.chapters || chapterSentences?.chapters || [],
    sentencesDir,
    chapterTitles
  );

  // Get folder stats for dates
  const stats = fs.statSync(sessionDir);

  // Get BFP metadata from source_epub_path (the single source of truth when available)
  const bfpMetadata = getBfpMetadataFromSourcePath(sessionState?.source_epub_path);

  // Build metadata: use BFP when available, otherwise use e2a session data
  // No mixing - one source or the other
  let metadata: E2aSession['metadata'];

  if (bfpMetadata) {
    // BFP is the source of truth
    metadata = {
      title: bfpMetadata.title,
      author: bfpMetadata.author,
      language: sessionState?.metadata?.language,  // Language only from epub
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
    // No BFP - use e2a session data
    metadata = {
      title: sessionState?.metadata?.title,
      author: sessionState?.metadata?.creator,
      language: sessionState?.metadata?.language,
      epubPath: sessionState?.epub_path,
      coverPath: findCoverImage(processDir),
      year: undefined,
      narrator: undefined,
      series: undefined,
      seriesNumber: undefined,
      genre: undefined,
      description: undefined,
      outputFilename: undefined
    };
  }

  const session: E2aSession = {
    sessionId,
    sessionDir,
    processDir,
    metadata,
    totalSentences,
    completedSentences,
    percentComplete: totalSentences > 0 ? Math.round((completedSentences / totalSentences) * 100) : 0,
    chapters,
    // Convert dates to strings for IPC serialization
    createdAt: stats.birthtime.toISOString() as any,
    modifiedAt: stats.mtime.toISOString() as any,
    // Store BFP path if linked
    bfpPath: bfpMetadata?.bfpPath
  };

  return session;
}

/**
 * Parse session-state.json if it exists
 */
function parseSessionState(processDir: string): any | null {
  const statePath = path.join(processDir, 'session-state.json');

  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[REASSEMBLY] Error parsing session-state.json:`, err);
    return null;
  }
}

/**
 * Find cover image in processDir
 * e2a saves covers as cleaned.jpg, or it could be cover.jpg, cover.png, etc.
 */
function findCoverImage(processDir: string): string | undefined {
  const coverNames = [
    'cleaned.jpg',
    'cleaned.png',
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'cover.webp'
  ];

  for (const name of coverNames) {
    const coverPath = path.join(processDir, name);
    if (fs.existsSync(coverPath)) {
      return coverPath;
    }
  }

  return undefined;
}

/**
 * Parse chapter_sentences.json if it exists
 */
function parseChapterSentences(processDir: string): any | null {
  const chapterPath = path.join(processDir, 'chapter_sentences.json');

  if (!fs.existsSync(chapterPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(chapterPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[REASSEMBLY] Error parsing chapter_sentences.json:`, err);
    return null;
  }
}

/**
 * Count completed FLAC files in the sentences folder
 * Supports both formats:
 * - New format: 0.flac, 1.flac, 2.flac, ... (0-indexed)
 * - Old format: sentence_0001.flac, sentence_0002.flac, ... (1-indexed)
 */
function countCompletedSentences(sentencesDir: string): number {
  if (!fs.existsSync(sentencesDir)) {
    return 0;
  }

  const files = fs.readdirSync(sentencesDir);
  // Count files matching either format
  return files.filter(f => /^\d+\.flac$/.test(f) || /^sentence_\d+\.flac$/.test(f)).length;
}

/**
 * Estimate total sentences from the highest numbered sentence file
 * Supports both formats:
 * - New format: 0.flac, 1.flac (0-indexed, so total = max + 1)
 * - Old format: sentence_0001.flac (1-indexed, so total = max)
 */
function estimateTotalFromFiles(sentencesDir: string): number {
  if (!fs.existsSync(sentencesDir)) {
    return 0;
  }

  const files = fs.readdirSync(sentencesDir);
  let maxNumNew = -1;  // For new format (0-indexed)
  let maxNumOld = 0;   // For old format (1-indexed)

  for (const file of files) {
    // New format: 0.flac, 1.flac, etc.
    const matchNew = file.match(/^(\d+)\.flac$/);
    if (matchNew) {
      const num = parseInt(matchNew[1], 10);
      if (num > maxNumNew) {
        maxNumNew = num;
      }
    }

    // Old format: sentence_0001.flac, etc.
    const matchOld = file.match(/^sentence_(\d+)\.flac$/);
    if (matchOld) {
      const num = parseInt(matchOld[1], 10);
      if (num > maxNumOld) {
        maxNumOld = num;
      }
    }
  }

  // Return whichever format was found
  if (maxNumNew >= 0) {
    return maxNumNew + 1;  // 0-indexed, so total = max + 1
  }
  return maxNumOld;  // 1-indexed, so total = max
}

/**
 * Build chapter info with completion counts
 * Supports both file naming formats:
 * - New format: 0.flac, 1.flac (0-indexed, matching sentence_start/end directly)
 * - Old format: sentence_0001.flac (1-indexed, so sentence_start 0 = file sentence_0001)
 */
function buildChapterInfo(
  chaptersData: Array<{
    chapter_num: number;
    title?: string;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>,
  sentencesDir: string,
  chapterTitles: string[] = []
): E2aChapter[] {
  if (!chaptersData || chaptersData.length === 0) {
    return [];
  }

  // Detect which format is in use and build completed set
  const completedSetNew = new Set<number>();  // 0-indexed
  const completedSetOld = new Set<number>();  // 1-indexed
  let hasNewFormat = false;
  let hasOldFormat = false;

  if (fs.existsSync(sentencesDir)) {
    const files = fs.readdirSync(sentencesDir);
    for (const file of files) {
      // New format: 0.flac, 1.flac, etc. (0-indexed)
      const matchNew = file.match(/^(\d+)\.flac$/);
      if (matchNew) {
        hasNewFormat = true;
        completedSetNew.add(parseInt(matchNew[1], 10));
      }

      // Old format: sentence_0001.flac, etc. (1-indexed)
      const matchOld = file.match(/^sentence_(\d+)\.flac$/);
      if (matchOld) {
        hasOldFormat = true;
        completedSetOld.add(parseInt(matchOld[1], 10));
      }
    }
  }

  return chaptersData.map((ch, index) => {
    // Count completed sentences in this chapter's range
    let completedCount = 0;
    for (let i = ch.sentence_start; i <= ch.sentence_end; i++) {
      if (hasNewFormat) {
        // New format: direct match (0-indexed)
        if (completedSetNew.has(i)) {
          completedCount++;
        }
      } else if (hasOldFormat) {
        // Old format: offset by 1 (sentence_start 0 = sentence_0001.flac)
        if (completedSetOld.has(i + 1)) {
          completedCount++;
        }
      }
    }

    // Get title from chapterTitles array (0-indexed) or from chapter object
    const title = chapterTitles[index] || ch.title;

    return {
      chapterNum: ch.chapter_num,
      title,
      sentenceStart: ch.sentence_start,
      sentenceEnd: ch.sentence_end,
      sentenceCount: ch.sentence_count,
      completedCount,
      excluded: false
    };
  });
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

  if (!fs.existsSync(sessionDir)) {
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

  // Create symlink if session is in a different tmp folder than e2a expects
  // e2a looks for sessions in <e2aPath>/tmp/ebook-<sessionId>
  const e2aExpectedTmp = path.join(e2aPath, 'tmp');
  const e2aExpectedSessionDir = path.join(e2aExpectedTmp, `ebook-${config.sessionId}`);

  if (config.sessionDir !== e2aExpectedSessionDir && !fs.existsSync(e2aExpectedSessionDir)) {
    try {
      // Ensure the e2a tmp folder exists
      if (!fs.existsSync(e2aExpectedTmp)) {
        fs.mkdirSync(e2aExpectedTmp, { recursive: true });
      }
      // Create symlink to actual session location
      fs.symlinkSync(config.sessionDir, e2aExpectedSessionDir);
      console.log(`[REASSEMBLY] Created symlink: ${e2aExpectedSessionDir} -> ${config.sessionDir}`);
    } catch (err) {
      console.log(`[REASSEMBLY] Symlink exists or failed: ${err}`);
    }
  }

  // Copy BFP cover to session directory if provided and not already there
  // e2a uses covers from the processDir (cleaned.jpg, cover.jpg, etc.) during assembly
  if (config.metadata?.coverPath && fs.existsSync(config.metadata.coverPath)) {
    const existingCover = findCoverImage(config.processDir);
    if (!existingCover) {
      try {
        // Determine extension
        const ext = path.extname(config.metadata.coverPath).toLowerCase() || '.jpg';
        const targetCoverPath = path.join(config.processDir, `cover${ext}`);
        fs.copyFileSync(config.metadata.coverPath, targetCoverPath);
        console.log(`[REASSEMBLY] Copied BFP cover to session: ${config.metadata.coverPath} -> ${targetCoverPath}`);
      } catch (err) {
        console.error('[REASSEMBLY] Failed to copy BFP cover to session:', err);
      }
    } else {
      console.log('[REASSEMBLY] Session already has cover:', existingCover);
    }
  }

  // Find the epub path from session state
  let sessionState = parseSessionState(config.processDir);

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
      '--output_dir', config.outputDir,
      '--session', config.sessionId,
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
      const condaArgs = [...getCondaRunArgs(e2aPath), ...appArgs];
      console.log('[REASSEMBLY] Running command: conda', condaArgs.join(' '));

      proc = spawn(getCondaPath(), condaArgs, {
        cwd: e2aPath,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        shell: true
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
        const elapsedMinutes = Math.floor((now - encodingStartTime) / 60000);
        // Only send heartbeat if no progress for 5+ seconds
        if (now - lastProgressUpdate > 5000) {
          sendProgress(mainWindow, jobId, {
            phase: 'encoding',
            percentage: Math.min(89, 65 + elapsedMinutes), // Slowly increment to show activity
            message: `Encoding M4B audiobook... (${elapsedMinutes} min elapsed)`
          });
          lastProgressUpdate = now;
        }
      }
    }, 5000);

    // Progress ranges for each phase:
    // Combining chapters: 0-50% (sentences into chapter FLACs)
    // Concatenating: 50-65% (chapter FLACs into one FLAC)
    // Encoding: 65-90% (FLAC to M4B with AAC)
    // Metadata: 90-100% (chapter markers, tags, m4b-tool)

    proc.stdout?.on('data', (data) => {
      const line = data.toString();
      console.log('[REASSEMBLY] stdout:', line);

      // Parse progress from e2a output
      // Parse "Assemble - XX%" progress lines (per-chapter sentence combining progress)
      const assembleMatch = line.match(/Assemble\s*-\s*([\d.]+)%/);
      if (assembleMatch) {
        currentChapterProgress = parseFloat(assembleMatch[1]);
        currentPhase = 'combining';

        // Calculate overall progress: combining phase is 0-50% of total
        // Formula: ((chaptersCompleted) + currentChapterProgress/100) / totalChapters * 50
        let overallPct: number;
        if (totalChapters > 0 && currentChapter > 0) {
          // chaptersCompleted = currentChapter - 1 (since currentChapter is being processed)
          const completedChapters = currentChapter - 1;
          overallPct = Math.round(((completedChapters + currentChapterProgress / 100) / totalChapters) * 50);
        } else {
          // Fallback if we don't know totals yet - just show current chapter progress scaled
          overallPct = Math.round(currentChapterProgress * 0.4);
        }

        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: overallPct,
          currentChapter: currentChapter || undefined,
          totalChapters: totalChapters || undefined,
          message: currentChapter > 0 && totalChapters > 0
            ? `Chapter ${currentChapter}/${totalChapters} (${currentChapterProgress.toFixed(0)}%)`
            : `Combining sentences (${currentChapterProgress.toFixed(0)}%)`
        });
      }

      // Parse "Export - XX%" progress lines (encoding to M4B)
      const exportMatch = line.match(/Export\s*-\s*([\d.]+)%/);
      if (exportMatch) {
        const pct = parseFloat(exportMatch[1]);
        // Export phase is 50-95% of total progress
        const totalPct = Math.round(50 + pct * 0.45);
        currentPhase = 'encoding';
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: totalPct,
          message: `Encoding M4B (${pct.toFixed(0)}%)`
        });
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
      } else if (line.includes('Combined block audio file saved') || line.includes('Completed →')) {
        // Chapter FLAC saved - update progress based on chapters completed
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
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      console.log('[REASSEMBLY] stderr:', line);

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

          // Use time to estimate progress - typical audiobooks are 5-20 hours
          // We'll cap at 90% since we don't know total duration
          const estimatedProgress = Math.min(85, 50 + Math.floor(totalSeconds / 600) * 5);

          currentPhase = 'encoding';
          if (!encodingStartTime) encodingStartTime = Date.now();
          lastProgressUpdate = Date.now();
          sendProgress(mainWindow, jobId, {
            phase: 'encoding',
            percentage: estimatedProgress,
            message: `Encoding: ${hours}h ${minutes}m ${seconds}s processed...`
          });
        }

        // Parse size for additional feedback
        const sizeMatch = line.match(/size=\s*(\d+)kB/);
        if (sizeMatch && !timeMatch) {
          const sizeMB = Math.round(parseInt(sizeMatch[1], 10) / 1024);
          currentPhase = 'encoding';
          if (!encodingStartTime) encodingStartTime = Date.now();
          lastProgressUpdate = Date.now();
          sendProgress(mainWindow, jobId, {
            phase: 'encoding',
            percentage: 70,
            message: `Encoding: ${sizeMB}MB written...`
          });
        }
      }

      // Also check for Export progress in stderr (some versions output here)
      const exportMatch = line.match(/Export\s*-\s*([\d.]+)%/);
      if (exportMatch) {
        const pct = parseFloat(exportMatch[1]);
        const totalPct = Math.round(50 + pct * 0.45);
        currentPhase = 'encoding';
        if (!encodingStartTime) encodingStartTime = Date.now();
        lastProgressUpdate = Date.now();
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: totalPct,
          message: `Encoding M4B (${pct.toFixed(0)}%)`
        });
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
      activeReassemblies.delete(jobId);

      if (code === 0) {
        // Find the output file if we don't have it yet
        if (!outputPath && config.outputDir) {
          // Try to find the output file in the output directory
          // Exclude macOS resource forks (._* files)
          const outputFiles = fs.readdirSync(config.outputDir).filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
          if (outputFiles.length > 0) {
            // Find the most recently modified m4b
            const sortedFiles = outputFiles
              .map(f => ({ name: f, path: path.join(config.outputDir, f), mtime: fs.statSync(path.join(config.outputDir, f)).mtime }))
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

        // Apply extended metadata with m4b-tool if output file exists
        if (outputPath && fs.existsSync(outputPath)) {
          await applyMetadataWithM4bTool(outputPath, config.metadata, mainWindow, jobId);
        }

        sendProgress(mainWindow, jobId, {
          phase: 'complete',
          percentage: 100,
          message: 'Reassembly complete!'
        });
        reassemblyLog.info('Reassembly complete', { jobId, outputPath });
        resolve({ success: true, outputPath });
      } else {
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
      activeReassemblies.delete(jobId);
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
    return false;
  }

  proc.kill('SIGTERM');
  activeReassemblies.delete(jobId);
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

  try {
    await applyMetadata(m4bPath, metadataToApply);
    console.log('[REASSEMBLY] Metadata applied successfully');
    return { success: true };
  } catch (err) {
    console.error('[REASSEMBLY] Metadata application failed:', err);
    // Don't fail the whole job - metadata is non-critical
    return { success: true };
  }
}

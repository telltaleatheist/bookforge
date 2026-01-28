/**
 * Reassembly Bridge - Scans e2a tmp folder for incomplete sessions and handles reassembly
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';

// Default E2A tmp path (should be overridden via settings)
const DEFAULT_E2A_TMP_PATH = '/Users/telltale/Projects/ebook2audiobook/tmp';

// The e2a app path that supports --title/--author/--cover options
// Note: ebook2audiobook-latest doesn't support these, so we use the non-latest version
const E2A_APP_PATH = '/Users/telltale/Projects/ebook2audiobook';

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
 * @param customTmpPath - Optional custom path to the e2a tmp folder
 */
export async function scanE2aTmpFolder(customTmpPath?: string): Promise<{ sessions: E2aSession[]; tmpPath: string }> {
  const sessions: E2aSession[] = [];
  const tmpPath = customTmpPath || DEFAULT_E2A_TMP_PATH;

  if (!fs.existsSync(tmpPath)) {
    console.log('[REASSEMBLY] E2A tmp folder does not exist:', tmpPath);
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

  console.log(`[REASSEMBLY] Found ${sessions.length} sessions in ${tmpPath}`);
  return { sessions, tmpPath };
}

/**
 * Parse a single session directory
 */
async function parseSession(sessionId: string, sessionDir: string): Promise<E2aSession | null> {
  // Find the hash subfolder
  const subEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
  const hashDir = subEntries.find(e => e.isDirectory());

  if (!hashDir) {
    console.log(`[REASSEMBLY] No hash subfolder in ${sessionDir}`);
    return null;
  }

  const processDir = path.join(sessionDir, hashDir.name);
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');

  // Check if sentences folder exists
  if (!fs.existsSync(sentencesDir)) {
    console.log(`[REASSEMBLY] No sentences folder in ${processDir}`);
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

  // Look for cover image in processDir
  // Check bookforge_metadata.coverPath first, then find in directory
  let coverPath = sessionState?.bookforge_metadata?.coverPath;
  if (!coverPath || !fs.existsSync(coverPath)) {
    coverPath = findCoverImage(processDir);
  }

  // Get extended metadata from bookforge_metadata if saved
  const bookforgeMetadata = sessionState?.bookforge_metadata || {};

  const session: E2aSession = {
    sessionId,
    sessionDir,
    processDir,
    metadata: {
      title: sessionState?.metadata?.title,
      author: sessionState?.metadata?.creator,
      language: sessionState?.metadata?.language,
      epubPath: sessionState?.epubPath,
      coverPath,
      // Extended metadata from bookforge_metadata
      year: bookforgeMetadata.year,
      narrator: bookforgeMetadata.narrator,
      series: bookforgeMetadata.series,
      seriesNumber: bookforgeMetadata.seriesNumber,
      genre: bookforgeMetadata.genre,
      description: bookforgeMetadata.description,
      outputFilename: bookforgeMetadata.outputFilename
    },
    totalSentences,
    completedSentences,
    percentComplete: totalSentences > 0 ? Math.round((completedSentences / totalSentences) * 100) : 0,
    chapters,
    // Convert dates to strings for IPC serialization
    createdAt: stats.birthtime.toISOString() as any,
    modifiedAt: stats.mtime.toISOString() as any
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

  if (!fs.existsSync(sessionDir)) {
    return false;
  }

  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
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
  // Derive e2a app path from tmp path (parent directory)
  const tmpPath = config.e2aTmpPath || DEFAULT_E2A_TMP_PATH;
  const e2aPath = getE2aAppPath(tmpPath);

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

  // Find the epub path from session state
  const sessionState = parseSessionState(config.processDir);
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

    // Build command parts - need to run as a single bash command for proper argument handling
    const cmdParts = [
      'source /opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh &&',
      `cd ${escapeShellArg(e2aPath)} &&`,
      'conda run --no-capture-output -n ebook2audiobook python app.py',
      '--headless',
      '--ebook', escapeShellArg(epubPath),
      '--output_dir', escapeShellArg(config.outputDir),
      '--session', config.sessionId,
      '--device', 'cpu',
      '--language', language,
      '--tts_engine', 'xtts',
      '--assemble_only',
      '--no_split'
    ];

    // Add output filename - use provided or generate "Title - Author (Year)"
    let outputFilename = config.metadata.outputFilename;
    if (!outputFilename && config.metadata.title) {
      // Generate filename: "Title - Author (Year)" or "Title - Author"
      const sanitize = (s: string) => s.replace(/[<>:"/\\|?*]/g, '').trim();
      const title = sanitize(config.metadata.title);
      const author = config.metadata.author ? sanitize(config.metadata.author) : '';
      const year = config.metadata.year || '';

      if (author && year) {
        outputFilename = `${title} - ${author} (${year})`;
      } else if (author) {
        outputFilename = `${title} - ${author}`;
      } else {
        outputFilename = title;
      }
    }
    if (outputFilename) {
      cmdParts.push('--output_filename', escapeShellArg(outputFilename));
    }

    // Add metadata if provided (for m4b tagging)
    if (config.metadata.title) {
      cmdParts.push('--title', escapeShellArg(config.metadata.title));
    }
    if (config.metadata.author) {
      cmdParts.push('--author', escapeShellArg(config.metadata.author));
    }
    if (config.metadata.coverPath) {
      cmdParts.push('--cover', escapeShellArg(config.metadata.coverPath));
    }

    const fullCommand = cmdParts.join(' ');
    console.log('[REASSEMBLY] Running command:', fullCommand);

    const proc = spawn('/bin/bash', ['-c', fullCommand], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    activeReassemblies.set(jobId, proc);

    let stderr = '';
    let outputPath = '';
    let totalChapters = 0;

    proc.stdout?.on('data', (data) => {
      const line = data.toString();
      console.log('[REASSEMBLY] stdout:', line);

      // Parse progress from e2a output
      // First, get total chapters from "Assembling audiobook from X chapters..."
      if (line.includes('Assembling audiobook from')) {
        const totalMatch = line.match(/Assembling audiobook from (\d+) chapters/);
        if (totalMatch) {
          totalChapters = parseInt(totalMatch[1], 10);
          sendProgress(mainWindow, jobId, {
            phase: 'combining',
            percentage: 5,
            currentChapter: 0,
            totalChapters,
            message: `Assembling ${totalChapters} chapters...`
          });
        }
      } else if (line.includes('Combining chapter')) {
        // Parse "Combining chapter N: sentences X-Y"
        const match = line.match(/Combining chapter (\d+):/);
        if (match) {
          const current = parseInt(match[1], 10);
          const total = totalChapters || 19; // fallback
          sendProgress(mainWindow, jobId, {
            phase: 'combining',
            percentage: Math.round(5 + (current / total) * 55),
            currentChapter: current,
            totalChapters: total,
            message: `Combining chapter ${current}/${total}`
          });
        }
      } else if (line.includes('Combined block audio file saved')) {
        // Chapter complete - could track this too
      } else if (line.includes('Creating subtitles')) {
        sendProgress(mainWindow, jobId, {
          phase: 'combining',
          percentage: 65,
          message: 'Creating subtitles...'
        });
      } else if (line.includes('Output #0, ipod') || line.includes('.m4b')) {
        // Encoding to M4B started
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: 70,
          message: 'Encoding M4B audiobook...'
        });
      } else if (line.includes('flac (native) -> aac')) {
        // AAC encoding in progress
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: 75,
          message: 'Encoding audio to AAC...'
        });
      } else if (line.includes('Encoding') || line.includes('encoding')) {
        sendProgress(mainWindow, jobId, {
          phase: 'encoding',
          percentage: 75,
          message: 'Encoding M4B audiobook...'
        });
      } else if (line.includes('Adding metadata') || line.includes('chapter markers') || line.includes('Chapter #')) {
        sendProgress(mainWindow, jobId, {
          phase: 'metadata',
          percentage: 85,
          message: 'Adding metadata and chapter markers...'
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
      stderr += data.toString();
      console.log('[REASSEMBLY] stderr:', data.toString());
    });

    proc.on('close', async (code) => {
      activeReassemblies.delete(jobId);

      if (code === 0) {
        // Apply extended metadata with m4b-tool if output file exists
        if (outputPath && fs.existsSync(outputPath)) {
          await applyMetadataWithM4bTool(outputPath, config.metadata, mainWindow, jobId);
        } else if (config.outputDir) {
          // Try to find the output file in the output directory
          const outputFiles = fs.readdirSync(config.outputDir).filter(f => f.endsWith('.m4b'));
          if (outputFiles.length > 0) {
            // Find the most recently modified m4b
            const sortedFiles = outputFiles
              .map(f => ({ name: f, path: path.join(config.outputDir, f), mtime: fs.statSync(path.join(config.outputDir, f)).mtime }))
              .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            outputPath = sortedFiles[0].path;
            await applyMetadataWithM4bTool(outputPath, config.metadata, mainWindow, jobId);
          }
        }

        sendProgress(mainWindow, jobId, {
          phase: 'complete',
          percentage: 100,
          message: 'Reassembly complete!'
        });
        resolve({ success: true, outputPath });
      } else {
        sendProgress(mainWindow, jobId, {
          phase: 'error',
          percentage: 0,
          error: stderr || `Process exited with code ${code}`
        });
        resolve({ success: false, error: stderr || `Process exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      activeReassemblies.delete(jobId);
      sendProgress(mainWindow, jobId, {
        phase: 'error',
        percentage: 0,
        error: err.message
      });
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
 * Apply extended metadata to M4B using m4b-tool
 */
async function applyMetadataWithM4bTool(
  m4bPath: string,
  metadata: ReassemblyConfig['metadata'],
  mainWindow: BrowserWindow | null,
  jobId: string
): Promise<{ success: boolean; error?: string }> {
  // Check if m4b-tool is available
  const m4bToolPath = '/opt/homebrew/bin/m4b-tool';
  if (!fs.existsSync(m4bToolPath)) {
    console.log('[REASSEMBLY] m4b-tool not found, skipping metadata application');
    return { success: true };  // Not an error - just skip if not available
  }

  if (!fs.existsSync(m4bPath)) {
    return { success: false, error: 'M4B file not found for metadata application' };
  }

  // Build m4b-tool meta command arguments
  const args = ['meta', m4bPath];

  // Add metadata flags
  if (metadata.title) {
    args.push('--name', metadata.title);
  }
  if (metadata.author) {
    args.push('--artist', metadata.author);
    args.push('--albumartist', metadata.author);  // Also set album artist
  }
  if (metadata.year) {
    args.push('--year', metadata.year);
  }
  if (metadata.narrator) {
    args.push('--writer', metadata.narrator);  // Use writer tag for narrator
  }
  if (metadata.series) {
    let album = metadata.series;
    if (metadata.seriesNumber) {
      album += `, Book ${metadata.seriesNumber}`;
    }
    args.push('--album', album);
  }
  if (metadata.genre) {
    args.push('--genre', metadata.genre);
  }
  if (metadata.description) {
    args.push('--description', metadata.description);
    args.push('--longdesc', metadata.description);
  }
  if (metadata.coverPath && fs.existsSync(metadata.coverPath)) {
    args.push('--cover', metadata.coverPath);
  }

  // If no metadata to apply, skip
  if (args.length <= 2) {
    console.log('[REASSEMBLY] No extended metadata to apply');
    return { success: true };
  }

  console.log('[REASSEMBLY] Applying metadata with m4b-tool:', args.join(' '));

  sendProgress(mainWindow, jobId, {
    phase: 'metadata',
    percentage: 95,
    message: 'Applying extended metadata with m4b-tool...'
  });

  return new Promise((resolve) => {
    const proc = spawn(m4bToolPath, args, {
      env: { ...process.env },
      shell: false
    });

    let stderr = '';

    proc.stdout?.on('data', (data) => {
      console.log('[REASSEMBLY] m4b-tool stdout:', data.toString());
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      console.log('[REASSEMBLY] m4b-tool stderr:', data.toString());
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[REASSEMBLY] m4b-tool metadata applied successfully');
        resolve({ success: true });
      } else {
        console.error('[REASSEMBLY] m4b-tool failed:', stderr);
        // Don't fail the whole job - metadata is non-critical
        resolve({ success: true });
      }
    });

    proc.on('error', (err) => {
      console.error('[REASSEMBLY] m4b-tool error:', err);
      // Don't fail the whole job
      resolve({ success: true });
    });
  });
}

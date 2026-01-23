/**
 * Parallel TTS Bridge - Worker pool coordinator for parallel audiobook conversion
 *
 * Coordinates multiple ebook2audiobook worker processes to convert EPUBs to audiobooks
 * in parallel. Each worker processes an assigned sentence range, writing audio files
 * to a shared session directory. After all workers complete, the bridge triggers
 * final assembly.
 *
 * Integration with ebook2audiobook's parallel-workers branch:
 * - --prep_only: Get sentence counts without conversion
 * - --worker_mode: Process assigned range, skip assembly
 * - --sentence_start / --sentence_end: Define worker's sentence range
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerStatus = 'pending' | 'running' | 'complete' | 'error';

export interface WorkerState {
  id: number;
  process: ChildProcess | null;
  sentenceStart: number;
  sentenceEnd: number;
  currentSentence: number;
  completedSentences: number;
  status: WorkerStatus;
  error?: string;
  pid?: number;
  retryCount: number;  // Track number of retry attempts
  // Chapter mode
  chapterStart?: number;  // 1-indexed (for chapter mode)
  chapterEnd?: number;    // 1-indexed (for chapter mode)
}

export interface PrepInfo {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  chaptersDir: string;
  chaptersDirSentences: string;
  totalChapters: number;
  totalSentences: number;
  chapters: Array<{
    chapterNum: number;
    sentenceCount: number;
    sentenceStart: number;
    sentenceEnd: number;
  }>;
  metadata: {
    title?: string;
    creator?: string;
    language?: string;
  };
}

export type ParallelMode = 'sentences' | 'chapters';

export interface ParallelConversionConfig {
  workerCount: number;
  epubPath: string;
  outputDir: string;
  settings: ParallelTtsSettings;
  parallelMode: ParallelMode; // 'sentences' = fine-grained, 'chapters' = natural boundaries
  // Metadata for final audiobook (applied after assembly via m4b-tool)
  metadata?: {
    title?: string;
    author?: string;
    year?: string;
    coverPath?: string;  // Path to cover image file
    outputFilename?: string;  // Custom filename (without path)
  };
}

export interface ParallelTtsSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;
  fineTuned: string;
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
}

export interface AggregatedProgress {
  phase: 'preparing' | 'converting' | 'assembling' | 'complete' | 'error';
  totalSentences: number;
  completedSentences: number;
  percentage: number;
  activeWorkers: number;
  workers: WorkerState[];
  estimatedRemaining: number;
  message?: string;
  error?: string;
}

export interface ParallelConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_E2A_PATH = '/Users/telltale/Projects/ebook2audiobook';
let e2aPath = DEFAULT_E2A_PATH;
let mainWindow: BrowserWindow | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface ConversionSession {
  jobId: string;
  config: ParallelConversionConfig;
  prepInfo: PrepInfo | null;
  workers: WorkerState[];
  startTime: number;
  cancelled: boolean;
  assemblyProcess: ChildProcess | null;
}

const activeSessions: Map<string, ConversionSession> = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Functions
// ─────────────────────────────────────────────────────────────────────────────

export function setE2aPath(newPath: string): void {
  e2aPath = newPath;
}

export function getE2aPath(): string {
  return e2aPath;
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hardware Detection
// ─────────────────────────────────────────────────────────────────────────────

export function detectRecommendedWorkerCount(): { count: number; reason: string } {
  const platform = os.platform();
  const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);

  // Get AVAILABLE memory (not total) - user might be running other apps
  let availableMemGB = totalMemGB; // Fallback to total if we can't detect available

  if (platform === 'darwin') {
    try {
      // macOS: Use vm_stat to get free + inactive pages (available for use)
      const vmStat = execSync('vm_stat', { encoding: 'utf-8' });
      const pageSize = 16384; // Apple Silicon uses 16KB pages

      const freeMatch = vmStat.match(/Pages free:\s+(\d+)/);
      const inactiveMatch = vmStat.match(/Pages inactive:\s+(\d+)/);
      const purgableMatch = vmStat.match(/Pages purgeable:\s+(\d+)/);

      if (freeMatch && inactiveMatch) {
        const freePages = parseInt(freeMatch[1]);
        const inactivePages = parseInt(inactiveMatch[1]);
        const purgablePages = purgableMatch ? parseInt(purgableMatch[1]) : 0;

        // Available = free + inactive + purgable (memory that can be reclaimed)
        const availableBytes = (freePages + inactivePages + purgablePages) * pageSize;
        availableMemGB = availableBytes / (1024 * 1024 * 1024);
      }
    } catch {
      // Fall through to using free memory from os module
      availableMemGB = os.freemem() / (1024 * 1024 * 1024);
    }
  } else {
    // Linux/Windows: Use os.freemem()
    availableMemGB = os.freemem() / (1024 * 1024 * 1024);
  }

  // Each TTS worker needs roughly 14-18GB for the model + audio buffers + overhead
  // This is conservative to prevent memory pressure crashes
  const memPerWorker = 16; // Conservative estimate in GB
  const maxByMemory = Math.floor(availableMemGB / memPerWorker);

  // Apple Silicon with unified memory - still be conservative as TTS is memory-intensive
  if (platform === 'darwin') {
    try {
      const cpuInfo = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf-8' });
      const isAppleSilicon = cpuInfo.toLowerCase().includes('apple');

      if (isAppleSilicon) {
        // Conservative recommendations - 4 workers was causing crashes even on 64GB
        // Each XTTS worker loads full model + generates audio, causing memory pressure
        const recommendedByTotal = totalMemGB >= 128 ? 4 : totalMemGB >= 64 ? 2 : totalMemGB >= 32 ? 2 : 1;
        const count = Math.min(recommendedByTotal, Math.max(1, maxByMemory));
        return {
          count,
          reason: `Apple Silicon - ${Math.round(availableMemGB)}GB available of ${Math.round(totalMemGB)}GB`
        };
      }
    } catch {
      // Fall through to generic detection
    }
  }

  // Generic detection based on available RAM
  const count = Math.min(2, Math.max(1, maxByMemory));
  return { count, reason: `${Math.round(availableMemGB)}GB RAM available` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Preparation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run e2a with --prep_only to get total sentence count and session info
 */
export async function prepareSession(
  epubPath: string,
  settings: ParallelTtsSettings
): Promise<PrepInfo> {
  const appPath = path.join(e2aPath, 'app.py');

  const args = [
    'run', '--no-capture-output', '-n', 'ebook2audiobook', 'python',
    appPath,
    '--headless',
    '--ebook', epubPath,
    '--language', settings.language,
    '--device', settings.device === 'gpu' ? 'cuda' : settings.device,
    '--prep_only'
  ];

  console.log('[PARALLEL-TTS] Running prep with:', args.join(' '));

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const prepProcess = spawn('conda', args, {
      cwd: e2aPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      shell: true
    });

    prepProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    prepProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    prepProcess.on('close', (code: number | null) => {
      if (code === 0) {
        try {
          // Find the JSON output in stdout (it should be the last valid JSON line)
          const lines = stdout.split('\n').filter(l => l.trim());
          let prepInfo: PrepInfo | null = null;

          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              if (parsed.session_id && parsed.total_sentences !== undefined) {
                prepInfo = {
                  sessionId: parsed.session_id,
                  sessionDir: parsed.session_dir,
                  processDir: parsed.process_dir,
                  chaptersDir: parsed.chapters_dir,
                  chaptersDirSentences: parsed.chapters_dir_sentences,
                  totalChapters: parsed.total_chapters,
                  totalSentences: parsed.total_sentences,
                  chapters: parsed.chapters.map((c: any) => ({
                    chapterNum: c.chapter_num,
                    sentenceCount: c.sentence_count,
                    sentenceStart: c.sentence_start,
                    sentenceEnd: c.sentence_end
                  })),
                  metadata: parsed.metadata
                };
                break;
              }
            } catch {
              continue;
            }
          }

          if (prepInfo) {
            console.log('[PARALLEL-TTS] Prep complete:', prepInfo.totalSentences, 'sentences');
            resolve(prepInfo);
          } else {
            reject(new Error('Failed to parse prep output'));
          }
        } catch (err) {
          reject(new Error(`Failed to parse prep output: ${err}`));
        }
      } else {
        reject(new Error(`Prep failed with code ${code}: ${stderr}`));
      }
    });

    prepProcess.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate sentence ranges for each worker (sentence mode)
 */
function calculateSentenceRanges(
  totalSentences: number,
  workerCount: number
): Array<{ start: number; end: number }> {
  const sentencesPerWorker = Math.ceil(totalSentences / workerCount);
  const ranges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < workerCount; i++) {
    const start = i * sentencesPerWorker;
    const end = Math.min((i + 1) * sentencesPerWorker - 1, totalSentences - 1);

    if (start <= totalSentences - 1) {
      ranges.push({ start, end });
    }
  }

  return ranges;
}

/**
 * Calculate chapter ranges for each worker (chapter mode)
 * Returns 1-indexed chapter numbers to match ebook2audiobook convention
 */
function calculateChapterRanges(
  totalChapters: number,
  workerCount: number,
  chapters: PrepInfo['chapters']
): Array<{ chapterStart: number; chapterEnd: number; sentenceCount: number }> {
  // If fewer chapters than workers, just give one chapter per worker
  const effectiveWorkers = Math.min(workerCount, totalChapters);
  const chaptersPerWorker = Math.ceil(totalChapters / effectiveWorkers);
  const ranges: Array<{ chapterStart: number; chapterEnd: number; sentenceCount: number }> = [];

  for (let i = 0; i < effectiveWorkers; i++) {
    const chapterStart = i * chaptersPerWorker + 1; // 1-indexed
    const chapterEnd = Math.min((i + 1) * chaptersPerWorker, totalChapters);

    if (chapterStart <= totalChapters) {
      // Calculate sentence count for this range
      const sentenceCount = chapters
        .filter(ch => ch.chapterNum >= chapterStart && ch.chapterNum <= chapterEnd)
        .reduce((sum, ch) => sum + ch.sentenceCount, 0);

      ranges.push({ chapterStart, chapterEnd, sentenceCount });
    }
  }

  return ranges;
}

interface WorkerRange {
  sentenceStart?: number;
  sentenceEnd?: number;
  chapterStart?: number;  // 1-indexed
  chapterEnd?: number;    // 1-indexed
}

/**
 * Start a single worker process
 */
function startWorker(
  session: ConversionSession,
  workerId: number,
  range: WorkerRange
): ChildProcess {
  const { config, prepInfo } = session;
  if (!prepInfo) throw new Error('Session not prepared');

  const appPath = path.join(e2aPath, 'app.py');
  const settings = config.settings;
  const isChapterMode = config.parallelMode === 'chapters';

  const args = [
    'run', '--no-capture-output', '-n', 'ebook2audiobook', 'python',
    appPath,
    '--headless',
    '--ebook', config.epubPath,
    '--output_dir', config.outputDir,
    '--session', prepInfo.sessionId,
    '--device', settings.device === 'gpu' ? 'cuda' : settings.device,
    '--language', settings.language,
    '--tts_engine', settings.ttsEngine,
    '--fine_tuned', settings.fineTuned,
    '--temperature', settings.temperature.toString(),
    '--top_p', settings.topP.toString(),
    '--top_k', settings.topK.toString(),
    '--repetition_penalty', settings.repetitionPenalty.toString(),
    '--speed', settings.speed.toString(),
    '--worker_mode'
  ];

  // Add range args based on mode
  if (isChapterMode && range.chapterStart !== undefined && range.chapterEnd !== undefined) {
    args.push('--chapter_start', range.chapterStart.toString());
    args.push('--chapter_end', range.chapterEnd.toString());
  } else if (range.sentenceStart !== undefined && range.sentenceEnd !== undefined) {
    args.push('--sentence_start', range.sentenceStart.toString());
    args.push('--sentence_end', range.sentenceEnd.toString());
  }

  if (settings.enableTextSplitting) {
    args.push('--enable_text_splitting');
  }

  const rangeDesc = isChapterMode
    ? `chapters ${range.chapterStart}-${range.chapterEnd}`
    : `sentences ${range.sentenceStart}-${range.sentenceEnd}`;
  console.log(`[PARALLEL-TTS] Worker ${workerId} starting: ${rangeDesc}`);
  console.log(`[PARALLEL-TTS] Worker ${workerId} settings: engine=${settings.ttsEngine}, voice=${settings.fineTuned}, device=${settings.device}`);

  const workerProcess = spawn('conda', args, {
    cwd: e2aPath,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    shell: true
  });

  // Update worker state with PID
  const worker = session.workers[workerId];
  worker.process = workerProcess;
  worker.pid = workerProcess.pid;
  worker.status = 'running';

  // Parse worker progress from stdout
  workerProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[WORKER ${workerId}]`, line.trim());

      // Parse progress: "Converting X.XX%: : Y/Z"
      const progressMatch = line.match(/Converting\s+([\d.]+)%.*?(\d+)\/(\d+)/i);
      if (progressMatch) {
        const current = parseInt(progressMatch[2]);
        worker.currentSentence = worker.sentenceStart + current;
        worker.completedSentences = current;
        emitProgress(session);
      }
    }
  });

  workerProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[WORKER ${workerId} STDERR]`, line.trim());

      // Parse progress from stderr too - e2a often outputs progress to stderr
      const progressMatch = line.match(/Converting\s+([\d.]+)%.*?(\d+)\/(\d+)/i);
      if (progressMatch) {
        const current = parseInt(progressMatch[2]);
        worker.currentSentence = worker.sentenceStart + current;
        worker.completedSentences = current;
        emitProgress(session);
      }
    }
  });

  workerProcess.on('close', (code) => {
    console.log(`[PARALLEL-TTS] Worker ${workerId} exited with code ${code}`);
    worker.process = null;

    if (session.cancelled) {
      worker.status = 'error';
      worker.error = 'Cancelled';
      return;
    }

    if (code === 0) {
      worker.status = 'complete';
      worker.completedSentences = worker.sentenceEnd - worker.sentenceStart + 1;
      emitProgress(session);
      checkAllWorkersComplete(session);
    } else {
      worker.status = 'error';
      worker.error = `Worker exited with code ${code}`;
      emitProgress(session);
    }
  });

  workerProcess.on('error', (err) => {
    worker.status = 'error';
    worker.error = err.message;
    worker.process = null;
    emitProgress(session);
  });

  return workerProcess;
}

const MAX_WORKER_RETRIES = 2;  // Maximum retry attempts per worker

/**
 * Check if all workers are complete and trigger assembly
 */
async function checkAllWorkersComplete(session: ConversionSession): Promise<void> {
  if (session.cancelled) return;

  const allComplete = session.workers.every(w => w.status === 'complete');
  const failedWorkers = session.workers.filter(w => w.status === 'error');

  // Handle failed workers - retry if under max attempts
  for (const worker of failedWorkers) {
    if (worker.retryCount < MAX_WORKER_RETRIES) {
      console.log(`[PARALLEL-TTS] Worker ${worker.id} failed (attempt ${worker.retryCount + 1}/${MAX_WORKER_RETRIES}), retrying...`);
      retryWorker(session, worker);
    }
  }

  // Check if any workers have exceeded retry limit
  const permanentlyFailed = failedWorkers.filter(w => w.retryCount >= MAX_WORKER_RETRIES);
  if (permanentlyFailed.length > 0) {
    const errors = permanentlyFailed
      .map(w => `Worker ${w.id} (sentences ${w.sentenceStart}-${w.sentenceEnd}): ${w.error}`)
      .join('; ');

    console.error(`[PARALLEL-TTS] Workers permanently failed after ${MAX_WORKER_RETRIES} retries:`, errors);
    emitComplete(session, false, undefined, `Workers failed after retries: ${errors}`);
    activeSessions.delete(session.jobId);
    return;
  }

  // Check if all workers are complete (including any that just started retrying)
  const stillRunning = session.workers.some(w => w.status === 'running' || w.status === 'pending');
  const retriesInProgress = failedWorkers.some(w => w.retryCount < MAX_WORKER_RETRIES);

  if (!stillRunning && !retriesInProgress && allComplete) {
    // All workers done - run assembly
    console.log('[PARALLEL-TTS] All workers complete, starting assembly');
    try {
      const outputPath = await runAssembly(session);
      emitComplete(session, true, outputPath);
    } catch (err) {
      emitComplete(session, false, undefined, `Assembly failed: ${err}`);
    }
    activeSessions.delete(session.jobId);
  }
}

/**
 * Retry a failed worker with the same sentence range
 */
function retryWorker(session: ConversionSession, worker: WorkerState): void {
  const { config } = session;
  const isChapterMode = config.parallelMode === 'chapters';

  // Reset worker state for retry
  worker.retryCount++;
  worker.status = 'pending';
  worker.error = undefined;
  worker.completedSentences = 0;
  worker.currentSentence = worker.sentenceStart;

  console.log(`[PARALLEL-TTS] Retrying worker ${worker.id} (attempt ${worker.retryCount}): ${
    isChapterMode
      ? `chapters ${worker.chapterStart}-${worker.chapterEnd}`
      : `sentences ${worker.sentenceStart}-${worker.sentenceEnd}`
  }`);

  // Start the worker with the same range
  const range: WorkerRange = isChapterMode
    ? { chapterStart: worker.chapterStart, chapterEnd: worker.chapterEnd }
    : { sentenceStart: worker.sentenceStart, sentenceEnd: worker.sentenceEnd };

  startWorker(session, worker.id, range);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the final assembly phase to combine all sentence audio into the final audiobook
 */
async function runAssembly(session: ConversionSession): Promise<string> {
  const { config, prepInfo } = session;
  if (!prepInfo) throw new Error('Session not prepared');

  // Emit assembling phase
  if (mainWindow) {
    const progress: AggregatedProgress = {
      phase: 'assembling',
      totalSentences: prepInfo.totalSentences,
      completedSentences: prepInfo.totalSentences,
      percentage: 95,
      activeWorkers: 0,
      workers: session.workers,
      estimatedRemaining: 60, // Estimate 1 minute for assembly
      message: 'Assembling final audiobook...'
    };
    mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });
  }

  // Run e2a with --assemble_only to combine sentence audio files into final audiobook
  const appPath = path.join(e2aPath, 'app.py');
  const settings = config.settings;

  const args = [
    'run', '--no-capture-output', '-n', 'ebook2audiobook', 'python',
    appPath,
    '--headless',
    '--ebook', config.epubPath,
    '--output_dir', config.outputDir,
    '--session', prepInfo.sessionId,
    '--device', settings.device === 'gpu' ? 'cuda' : settings.device,
    '--language', settings.language,
    '--tts_engine', settings.ttsEngine,  // Required for session setup even in assembly mode
    '--assemble_only'  // Skip TTS, just combine existing sentence audio files
  ];

  console.log('[PARALLEL-TTS] Running assembly:', args.join(' '));

  return new Promise((resolve, reject) => {
    let stderr = '';
    let outputPath = '';

    session.assemblyProcess = spawn('conda', args, {
      cwd: e2aPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      shell: true
    });

    session.assemblyProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      console.log('[ASSEMBLY]', output.trim());

      // Look for output file path
      const outputMatch = output.match(/(?:output|saved to|created|wrote)[:\s]+(['"]?)([\/~][\w\s\-\/.,'()]+\.m4b)\1/i);
      if (outputMatch) {
        outputPath = outputMatch[2].trim();
      }
    });

    session.assemblyProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.log('[ASSEMBLY STDERR]', data.toString().trim());
    });

    session.assemblyProcess.on('close', async (code) => {
      session.assemblyProcess = null;

      if (code === 0) {
        // Find the output file if not detected from logs
        if (!outputPath) {
          try {
            const files = await fs.readdir(config.outputDir);
            const m4bFiles = files.filter(f => f.endsWith('.m4b'));
            if (m4bFiles.length > 0) {
              // Get most recent
              let mostRecent = { file: m4bFiles[0], mtime: 0 };
              for (const file of m4bFiles) {
                const filePath = path.join(config.outputDir, file);
                const stat = await fs.stat(filePath);
                if (stat.mtimeMs > mostRecent.mtime) {
                  mostRecent = { file, mtime: stat.mtimeMs };
                }
              }
              outputPath = path.join(config.outputDir, mostRecent.file);
            }
          } catch (err) {
            console.error('[PARALLEL-TTS] Error finding output file:', err);
          }
        }

        const finalPath = outputPath || path.join(config.outputDir, 'audiobook.m4b');

        // Apply metadata and rename using m4b-tool if metadata was provided
        if (config.metadata && finalPath) {
          try {
            const processedPath = await applyMetadataWithM4bTool(finalPath, config.metadata, config.outputDir);
            resolve(processedPath);
          } catch (metaErr) {
            console.error('[PARALLEL-TTS] Metadata processing failed, using original file:', metaErr);
            resolve(finalPath);
          }
        } else {
          resolve(finalPath);
        }
      } else {
        reject(new Error(`Assembly failed with code ${code}: ${stderr}`));
      }
    });

    session.assemblyProcess.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Post-Processing with m4b-tool
// ─────────────────────────────────────────────────────────────────────────────

const M4B_TOOL_PATH = '/opt/homebrew/bin/m4b-tool';

interface MetadataConfig {
  title?: string;
  author?: string;
  year?: string;
  coverPath?: string;
  outputFilename?: string;
}

/**
 * Apply metadata to m4b file using m4b-tool and optionally rename
 */
async function applyMetadataWithM4bTool(
  inputPath: string,
  metadata: MetadataConfig,
  outputDir: string
): Promise<string> {
  const hasMetadataChanges = metadata.title || metadata.author || metadata.year || metadata.coverPath;
  const hasRename = metadata.outputFilename;

  if (!hasMetadataChanges && !hasRename) {
    return inputPath;
  }

  console.log('[PARALLEL-TTS] Applying metadata with m4b-tool:', metadata);

  // If we have a cover to apply, first remove the existing cover
  if (metadata.coverPath) {
    console.log('[PARALLEL-TTS] Removing existing cover...');
    await runM4bToolCommand(inputPath, ['--skip-cover', '-f']);
  }

  // Build m4b-tool meta command arguments
  const args: string[] = [];

  if (metadata.title) {
    args.push('--name', metadata.title);
  }
  if (metadata.author) {
    args.push('--artist', metadata.author);
  }
  if (metadata.year) {
    args.push('--year', metadata.year);
  }
  if (metadata.coverPath) {
    args.push('--cover', metadata.coverPath);
  }

  // Apply metadata if we have any changes
  if (args.length > 0) {
    args.push('-f'); // Force overwrite
    console.log('[PARALLEL-TTS] Applying metadata:', args.join(' '));
    await runM4bToolCommand(inputPath, args);
  }

  // Rename if custom filename specified
  if (metadata.outputFilename) {
    let newPath = path.join(outputDir, metadata.outputFilename);

    // Check if file already exists - if so, add a number suffix
    if (newPath !== inputPath) {
      newPath = await getUniqueFilePath(newPath);
      console.log(`[PARALLEL-TTS] Renaming to: ${newPath}`);
      await fs.rename(inputPath, newPath);
      return newPath;
    }
  }

  return inputPath;
}

/**
 * Get a unique file path by adding a number suffix if the file already exists
 * e.g., "My Book.m4b" -> "My Book 2.m4b" -> "My Book 3.m4b"
 */
async function getUniqueFilePath(filePath: string): Promise<string> {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);

  let counter = 1;
  let uniquePath = filePath;

  while (true) {
    try {
      await fs.access(uniquePath);
      // File exists, try next number
      counter++;
      uniquePath = path.join(dir, `${baseName} ${counter}${ext}`);
    } catch {
      // File doesn't exist, we can use this path
      return uniquePath;
    }
  }
}

/**
 * Run m4b-tool meta command
 */
function runM4bToolCommand(filePath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['meta', ...args, filePath];
    console.log(`[M4B-TOOL] ${M4B_TOOL_PATH} ${fullArgs.join(' ')}`);

    const proc = spawn(M4B_TOOL_PATH, fullArgs, {
      shell: false
    });

    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      console.log('[M4B-TOOL]', data.toString().trim());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.log('[M4B-TOOL STDERR]', data.toString().trim());
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`m4b-tool failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Emission
// ─────────────────────────────────────────────────────────────────────────────

// Helper to strip non-serializable fields from workers for IPC
function serializeWorkers(workers: WorkerState[]): Omit<WorkerState, 'process'>[] {
  return workers.map(w => ({
    id: w.id,
    sentenceStart: w.sentenceStart,
    sentenceEnd: w.sentenceEnd,
    currentSentence: w.currentSentence,
    completedSentences: w.completedSentences,
    status: w.status,
    error: w.error,
    pid: w.pid,
    retryCount: w.retryCount,
    chapterStart: w.chapterStart,
    chapterEnd: w.chapterEnd
  }));
}

// Track last progress for smoothing estimates
const progressHistory: Map<string, { completedSentences: number; timestamp: number }[]> = new Map();
const ETA_SAMPLE_WINDOW = 30000; // Use last 30 seconds of data for ETA calculation
const MIN_SAMPLES_FOR_ETA = 3; // Need at least 3 data points before showing ETA

function emitProgress(session: ConversionSession): void {
  if (!mainWindow || !session.prepInfo) return;

  const totalCompleted = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);
  const activeWorkers = session.workers.filter(w => w.status === 'running').length;
  const percentage = (totalCompleted / session.prepInfo.totalSentences) * 100;

  // Track progress history for this session
  const now = Date.now();
  if (!progressHistory.has(session.jobId)) {
    progressHistory.set(session.jobId, []);
  }
  const history = progressHistory.get(session.jobId)!;
  history.push({ completedSentences: totalCompleted, timestamp: now });

  // Remove old samples outside the window
  const windowStart = now - ETA_SAMPLE_WINDOW;
  while (history.length > 0 && history[0].timestamp < windowStart) {
    history.shift();
  }

  // Calculate ETA using sentence completion rate over the sample window
  let estimatedRemaining = 0;
  if (history.length >= MIN_SAMPLES_FOR_ETA && totalCompleted > 0) {
    const oldestSample = history[0];
    const sentencesInWindow = totalCompleted - oldestSample.completedSentences;
    const timeInWindow = (now - oldestSample.timestamp) / 1000; // seconds

    if (sentencesInWindow > 0 && timeInWindow > 0) {
      const sentencesPerSecond = sentencesInWindow / timeInWindow;
      const remainingSentences = session.prepInfo.totalSentences - totalCompleted;
      estimatedRemaining = Math.round(remainingSentences / sentencesPerSecond);
    }
  }

  const progress: AggregatedProgress = {
    phase: 'converting',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: totalCompleted,
    percentage: Math.round(percentage),
    activeWorkers,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining,
    message: `Processing with ${activeWorkers} workers (${percentage.toFixed(1)}%)`
  };

  mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });
}

function emitComplete(
  session: ConversionSession,
  success: boolean,
  outputPath?: string,
  error?: string
): void {
  if (!mainWindow || !session.prepInfo) return;

  // Clean up progress history for this session
  progressHistory.delete(session.jobId);

  const duration = Math.round((Date.now() - session.startTime) / 1000);

  const progress: AggregatedProgress = {
    phase: success ? 'complete' : 'error',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: success ? session.prepInfo.totalSentences : 0,
    percentage: success ? 100 : 0,
    activeWorkers: 0,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining: 0,
    message: success ? 'Conversion complete!' : error,
    error
  };

  mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });
  mainWindow.webContents.send('parallel-tts:complete', {
    jobId: session.jobId,
    success,
    outputPath,
    error,
    duration
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a parallel conversion
 */
export async function startParallelConversion(
  jobId: string,
  config: ParallelConversionConfig,
  onProgress?: (progress: AggregatedProgress) => void
): Promise<ParallelConversionResult> {
  console.log(`[PARALLEL-TTS] Starting conversion for job ${jobId} with ${config.workerCount} workers`);
  console.log(`[PARALLEL-TTS] Metadata received:`, JSON.stringify(config.metadata, null, 2));

  // Prepare the session first
  let prepInfo: PrepInfo;
  try {
    prepInfo = await prepareSession(config.epubPath, config.settings);
  } catch (err) {
    const error = `Preparation failed: ${err}`;
    console.error('[PARALLEL-TTS]', error);
    return { success: false, error };
  }

  // Calculate ranges for workers based on mode
  const isChapterMode = config.parallelMode === 'chapters';
  let workers: WorkerState[];

  if (isChapterMode) {
    const chapterRanges = calculateChapterRanges(prepInfo.totalChapters, config.workerCount, prepInfo.chapters);
    console.log('[PARALLEL-TTS] Chapter mode - Worker ranges:', chapterRanges);

    workers = chapterRanges.map((range, i) => {
      // For progress tracking, we still need sentence boundaries
      const firstChapter = prepInfo.chapters.find(ch => ch.chapterNum === range.chapterStart);
      const lastChapter = prepInfo.chapters.find(ch => ch.chapterNum === range.chapterEnd);
      const sentenceStart = firstChapter?.sentenceStart ?? 0;
      const sentenceEnd = lastChapter?.sentenceEnd ?? 0;

      return {
        id: i,
        process: null,
        sentenceStart,
        sentenceEnd,
        currentSentence: sentenceStart,
        completedSentences: 0,
        status: 'pending' as WorkerStatus,
        retryCount: 0,
        chapterStart: range.chapterStart,
        chapterEnd: range.chapterEnd
      };
    });
  } else {
    const sentenceRanges = calculateSentenceRanges(prepInfo.totalSentences, config.workerCount);
    console.log('[PARALLEL-TTS] Sentence mode - Worker ranges:', sentenceRanges);

    workers = sentenceRanges.map((range, i) => ({
      id: i,
      process: null,
      sentenceStart: range.start,
      sentenceEnd: range.end,
      currentSentence: range.start,
      completedSentences: 0,
      status: 'pending' as WorkerStatus,
      retryCount: 0
    }));
  }

  // Create session
  const session: ConversionSession = {
    jobId,
    config,
    prepInfo,
    workers,
    startTime: Date.now(),
    cancelled: false,
    assemblyProcess: null
  };

  activeSessions.set(jobId, session);

  // Emit initial progress
  if (mainWindow) {
    const progress: AggregatedProgress = {
      phase: 'preparing',
      totalSentences: prepInfo.totalSentences,
      completedSentences: 0,
      percentage: 0,
      activeWorkers: 0,
      workers,
      estimatedRemaining: 0,
      message: 'Starting workers...'
    };
    mainWindow.webContents.send('parallel-tts:progress', { jobId, progress });
  }

  // Start all workers
  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const range: WorkerRange = isChapterMode
      ? { chapterStart: worker.chapterStart, chapterEnd: worker.chapterEnd }
      : { sentenceStart: worker.sentenceStart, sentenceEnd: worker.sentenceEnd };
    startWorker(session, i, range);
  }

  // Return immediately - completion is handled via events
  return new Promise((resolve) => {
    // Set up a listener for completion
    const checkComplete = setInterval(() => {
      if (!activeSessions.has(jobId)) {
        clearInterval(checkComplete);
        // Get the result from the last emitted event
        // For now, just return success - the actual result is sent via IPC
        resolve({ success: true });
      }
    }, 1000);
  });
}

/**
 * Stop a parallel conversion
 */
export function stopParallelConversion(jobId: string): boolean {
  const session = activeSessions.get(jobId);
  if (!session) return false;

  console.log(`[PARALLEL-TTS] Stopping conversion for job ${jobId}`);
  session.cancelled = true;

  // Kill all worker processes
  for (const worker of session.workers) {
    if (worker.process) {
      worker.process.kill('SIGTERM');
      worker.status = 'error';
      worker.error = 'Cancelled';
    }
  }

  // Kill assembly process if running
  if (session.assemblyProcess) {
    session.assemblyProcess.kill('SIGTERM');
  }

  // Clean up progress history
  progressHistory.delete(jobId);

  activeSessions.delete(jobId);
  return true;
}

/**
 * Get progress for a conversion
 */
export function getConversionProgress(jobId: string): AggregatedProgress | null {
  const session = activeSessions.get(jobId);
  if (!session || !session.prepInfo) return null;

  const totalCompleted = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);
  const activeWorkers = session.workers.filter(w => w.status === 'running').length;
  const percentage = Math.round((totalCompleted / session.prepInfo.totalSentences) * 100);

  const elapsed = (Date.now() - session.startTime) / 1000;
  let estimatedRemaining = 0;
  if (percentage > 0) {
    const rate = percentage / elapsed;
    estimatedRemaining = Math.round((100 - percentage) / rate);
  }

  return {
    phase: 'converting',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: totalCompleted,
    percentage,
    activeWorkers,
    workers: session.workers,
    estimatedRemaining
  };
}

/**
 * Check if a conversion is active
 */
export function isConversionActive(jobId: string): boolean {
  return activeSessions.has(jobId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const parallelTtsBridge = {
  setE2aPath,
  getE2aPath,
  setMainWindow,
  detectRecommendedWorkerCount,
  prepareSession,
  startParallelConversion,
  stopParallelConversion,
  getConversionProgress,
  isConversionActive
};

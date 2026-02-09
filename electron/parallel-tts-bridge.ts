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

import { spawn, ChildProcess, execSync, exec } from 'child_process';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as logger from './audiobook-logger';
import { getTTSLogger } from './rolling-logger';

// Worker log file for debugging - captures ALL worker output
let workerLogPath: string | null = null;
let workerLogStream: fsSync.WriteStream | null = null;

function initWorkerLog(libraryPath: string): void {
  if (!workerLogStream) {
    const logsDir = path.join(os.homedir(), 'Library', 'Logs', 'BookForgeApp');
    fsSync.mkdirSync(logsDir, { recursive: true });
    workerLogPath = path.join(logsDir, 'worker-output.log');
    // Truncate on start
    workerLogStream = fsSync.createWriteStream(workerLogPath, { flags: 'w' });
    workerLogStream.write(`=== Worker Log Started ${new Date().toISOString()} ===\n`);
  }
}

function writeWorkerLog(line: string): void {
  if (workerLogStream) {
    workerLogStream.write(`${new Date().toISOString()} ${line}\n`);
  }
}
import { getMetadataToolPath, removeCover, applyMetadata, AudiobookMetadata } from './metadata-tools';
import { checkResembleAvailable, enhanceFile, initResembleBridge } from './resemble-bridge';

/**
 * Kill a process and all its children (process tree)
 * On Windows, uses taskkill /F /T to force kill the entire tree
 * On Unix, uses process.kill with SIGKILL
 */
function killProcessTree(process: ChildProcess, label: string): void {
  if (!process || process.killed) return;

  const pid = process.pid;
  if (!pid) {
    console.log(`[PARALLEL-TTS] ${label}: No PID, using SIGTERM`);
    try {
      process.kill('SIGTERM');
    } catch (err) {
      console.error(`[PARALLEL-TTS] Failed to kill ${label}:`, err);
    }
    return;
  }

  if (os.platform() === 'win32') {
    // Windows: use taskkill to kill entire process tree
    console.log(`[PARALLEL-TTS] Killing ${label} process tree (PID: ${pid})`);
    try {
      // /F = force, /T = tree (kill child processes)
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[PARALLEL-TTS] Killed ${label} process tree`);
    } catch (err) {
      // Process may have already exited
      console.log(`[PARALLEL-TTS] ${label} process tree kill returned (may have already exited)`);
    }
  } else {
    // Unix: SIGKILL for forceful termination
    console.log(`[PARALLEL-TTS] Killing ${label} (PID: ${pid})`);
    try {
      process.kill('SIGKILL');
    } catch (err) {
      console.error(`[PARALLEL-TTS] Failed to kill ${label}:`, err);
    }
  }
}

/**
 * Clean up orphaned vLLM processes on Windows
 * vLLM uses ZMQ sockets for inter-process communication on ports 29500-29600
 * These processes can escape the normal process tree kill, so we find and kill them by port
 */
function cleanupOrphanedVllmProcesses(): void {
  if (os.platform() !== 'win32') return;

  console.log('[PARALLEL-TTS] Cleaning up orphaned vLLM processes...');

  try {
    // Find processes listening on vLLM's typical ZMQ port range (29500-29600)
    const netstatOutput = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 });
    const lines = netstatOutput.split('\n');
    const pidsToKill = new Set<string>();

    for (const line of lines) {
      // Look for LISTENING connections on ports 29500-29600
      const match = line.match(/TCP\s+127\.0\.0\.1:(295\d{2})\s+.*LISTENING\s+(\d+)/);
      if (match) {
        const port = match[1];
        const pid = match[2];
        console.log(`[PARALLEL-TTS] Found process ${pid} on vLLM port ${port}`);
        pidsToKill.add(pid);
      }
    }

    // Kill each orphaned process
    for (const pid of pidsToKill) {
      try {
        console.log(`[PARALLEL-TTS] Killing orphaned vLLM process (PID: ${pid})`);
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
        console.log(`[PARALLEL-TTS] Killed orphaned process ${pid}`);
      } catch (err) {
        // Process may have already exited
        console.log(`[PARALLEL-TTS] Orphaned process ${pid} kill returned (may have already exited)`);
      }
    }

    if (pidsToKill.size > 0) {
      console.log(`[PARALLEL-TTS] Cleaned up ${pidsToKill.size} orphaned vLLM process(es)`);
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Error cleaning up orphaned vLLM processes:', err);
  }
}

/**
 * Aggressively kill ALL Python processes related to ebook2audiobook
 * This is the nuclear option - used on app exit to ensure no orphans
 * Uses WMIC to find python processes by command line pattern
 */
export function forceKillAllE2aProcesses(): void {
  console.log('[PARALLEL-TTS] Force killing all e2a-related processes...');

  if (os.platform() === 'win32') {
    try {
      // Use WMIC to find python processes with app.py in command line
      // This catches vLLM worker processes that escape normal tree kill
      const wmicOutput = execSync(
        'wmic process where "commandline like \'%app.py%\' and name like \'%python%\'" get processid',
        { encoding: 'utf8', timeout: 10000 }
      );

      const pids = wmicOutput
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^\d+$/.test(line));

      for (const pid of pids) {
        try {
          console.log(`[PARALLEL-TTS] Force killing Python process (PID: ${pid})`);
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
        } catch {
          // Process may have already exited
        }
      }

      if (pids.length > 0) {
        console.log(`[PARALLEL-TTS] Force killed ${pids.length} e2a Python process(es)`);
      }
    } catch (err) {
      // WMIC may fail or return empty, that's OK
      console.log('[PARALLEL-TTS] WMIC process search completed');
    }

    // Also try to kill any vllm processes directly
    try {
      execSync('taskkill /F /IM "python.exe" /FI "WINDOWTITLE eq *vllm*"', {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      // May not find any, that's OK
    }
  }

  // Also clean up WSL processes if applicable
  if (os.platform() === 'win32') {
    cleanupWslOrphanedProcesses();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Temp Folder Management
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_TTS_BASE_DIR = 'bookforge-tts';

/**
 * Get temp output directory for a TTS job
 * Uses /tmp/bookforge-tts/{jobId}/ on Unix, %TEMP%\bookforge-tts\{jobId}\ on Windows
 */
export function getTempOutputDir(jobId: string): string {
  return path.join(os.tmpdir(), TEMP_TTS_BASE_DIR, jobId);
}

/**
 * Copy completed TTS output to final destinations
 *
 * @param tempDir - Temp folder containing m4b and vtt files
 * @param bfpPath - BFP project folder (copies to {bfp}/audiobook/)
 * @param externalAudiobooksDir - External folder for books (optional, not used for articles)
 * @param isArticle - If true, skip external copy (articles stay in BFP only)
 * @returns Final paths for audio and VTT
 */
export async function copyToFinalDestination(
  tempDir: string,
  bfpPath: string | undefined,
  externalAudiobooksDir: string | undefined,
  isArticle: boolean = false
): Promise<{ audioPath: string; vttPath: string | undefined }> {
  console.log('[PARALLEL-TTS] copyToFinalDestination:', { tempDir, bfpPath, externalAudiobooksDir, isArticle });

  // Find m4b and vtt files in temp dir
  const files = await fs.readdir(tempDir);
  const m4bFile = files.find(f => f.endsWith('.m4b') && !f.startsWith('._'));
  const vttFile = files.find(f => f.endsWith('.vtt') && !f.startsWith('._'));

  if (!m4bFile) {
    throw new Error(`No m4b file found in temp directory: ${tempDir}`);
  }

  const tempM4bPath = path.join(tempDir, m4bFile);
  const tempVttPath = vttFile ? path.join(tempDir, vttFile) : undefined;

  let finalAudioPath: string;
  let finalVttPath: string | undefined;

  // Step 1: Copy to BFP audiobook/ folder (always, for both books and articles)
  if (bfpPath) {
    const bfpAudiobookDir = path.join(bfpPath, 'audiobook');
    await fs.mkdir(bfpAudiobookDir, { recursive: true });

    finalAudioPath = path.join(bfpAudiobookDir, 'output.m4b');
    await fs.copyFile(tempM4bPath, finalAudioPath);
    console.log(`[PARALLEL-TTS] Copied m4b to BFP: ${finalAudioPath}`);

    if (tempVttPath) {
      finalVttPath = path.join(bfpAudiobookDir, 'subtitles.vtt');
      await fs.copyFile(tempVttPath, finalVttPath);
      console.log(`[PARALLEL-TTS] Copied vtt to BFP: ${finalVttPath}`);
    }
  } else {
    // No BFP path - just use temp path (will be cleaned up separately)
    finalAudioPath = tempM4bPath;
    finalVttPath = tempVttPath;
    console.log('[PARALLEL-TTS] No bfpPath provided, keeping files in temp location');
  }

  // Step 2: Copy to external audiobooks folder (for books only, not articles)
  if (!isArticle && externalAudiobooksDir && bfpPath) {
    try {
      await fs.mkdir(externalAudiobooksDir, { recursive: true });
      const externalPath = path.join(externalAudiobooksDir, m4bFile);
      await fs.copyFile(tempM4bPath, externalPath);
      console.log(`[PARALLEL-TTS] Copied m4b to external: ${externalPath}`);
    } catch (err) {
      // Don't fail the job if external copy fails (e.g., network drive unavailable)
      console.error('[PARALLEL-TTS] Failed to copy to external audiobooks folder:', err);
    }
  }

  // Step 3: Clean up temp folder
  if (bfpPath) {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[PARALLEL-TTS] Cleaned up temp folder: ${tempDir}`);
    } catch (err) {
      console.error('[PARALLEL-TTS] Failed to clean up temp folder:', err);
    }
  }

  return { audioPath: finalAudioPath, vttPath: finalVttPath };
}

/**
 * Clean up stale temp folders older than maxAgeHours
 * Called on app startup to prevent tmp folder buildup
 */
export async function cleanupStaleTempFolders(maxAgeHours: number = 24): Promise<void> {
  const baseTempDir = path.join(os.tmpdir(), TEMP_TTS_BASE_DIR);

  try {
    await fs.access(baseTempDir);
  } catch {
    // Directory doesn't exist, nothing to clean
    return;
  }

  console.log(`[PARALLEL-TTS] Checking for stale temp folders in ${baseTempDir}...`);

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const entries = await fs.readdir(baseTempDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const folderPath = path.join(baseTempDir, entry.name);
      try {
        const stat = await fs.stat(folderPath);
        const age = now - stat.mtimeMs;

        if (age > maxAgeMs) {
          console.log(`[PARALLEL-TTS] Removing stale temp folder: ${entry.name} (age: ${Math.round(age / 3600000)}h)`);
          await fs.rm(folderPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.error(`[PARALLEL-TTS] Failed to check/remove folder ${entry.name}:`, err);
      }
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Failed to scan temp directory:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WSL2 Spawn Support (Windows only, for Orpheus TTS)
// ─────────────────────────────────────────────────────────────────────────────

interface WslSpawnConfig {
  condaArgs: string[];       // Conda run args (without conda executable)
  cwd: string;               // Working directory (Windows path)
  env?: Record<string, string>;  // Environment variables
  ttsEngine?: string;        // TTS engine name
}

/**
 * Check if we should use WSL for this spawn
 * Returns true if:
 * - useWsl2ForAllTts is enabled (uses WSL for all TTS engines), OR
 * - Engine is Orpheus AND useWsl2ForOrpheus is enabled
 */
function shouldUseWslForSpawn(ttsEngine?: string): boolean {
  if (os.platform() !== 'win32') return false;
  // Check if all TTS should use WSL
  if (shouldUseWsl2ForAllTts()) return true;
  // Otherwise, only use WSL for Orpheus
  if (ttsEngine?.toLowerCase() !== 'orpheus') return false;
  return shouldUseWsl2ForOrpheus();
}

/**
 * Build bash command for WSL execution
 * Converts Windows paths and builds the full conda activation command
 */
function buildWslBashCommand(config: WslSpawnConfig): string {
  const wslCondaPath = getWslCondaPath();
  const wslE2aPath = getWslE2aPath();

  // Don't export Windows env vars to WSL - they contain paths with parentheses
  // that break bash syntax. WSL has its own environment and doesn't need these.
  // Only export specific safe variables if needed in the future.

  // Convert condaArgs paths from Windows to WSL format
  // Also replace Windows conda env path with WSL native orpheus_tts conda env
  // And replace Windows e2a path with WSL native e2a path
  const wslArgs: string[] = [];
  let skipNext = false;
  const orpheusCondaEnv = getWslOrpheusCondaEnv();

  for (let i = 0; i < config.condaArgs.length; i++) {
    const arg = config.condaArgs[i];

    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Replace -p <windows_env_path> with appropriate WSL path
    if (arg === '-p' && config.condaArgs[i + 1]) {
      const envPath = config.condaArgs[i + 1];
      if (envPath.includes('orpheus')) {
        // Orpheus uses its own conda env
        wslArgs.push('-n', orpheusCondaEnv);
      } else if (envPath.includes('python_env') || envPath.includes('ebook2audiobook')) {
        // e2a's python_env - use WSL native path
        wslArgs.push('-p', `${wslE2aPath}/python_env`);
      } else {
        // Other conda env - convert Windows path to WSL
        wslArgs.push('-p', windowsToWslPath(envPath));
      }
      skipNext = true;  // Skip the next arg (the Windows path)
      continue;
    }

    // Replace Windows e2a paths with WSL native e2a path
    // This is critical - running Python code from /mnt/c/ causes multiprocessing issues
    if (/^[A-Za-z]:[\\/]/.test(arg) && arg.includes('ebook2audiobook')) {
      // Extract the relative path after ebook2audiobook
      const match = arg.match(/ebook2audiobook[\\\/]?(.*)/i);
      if (match) {
        const relativePath = match[1].replace(/\\/g, '/');
        wslArgs.push(`${wslE2aPath}/${relativePath}`);
      } else {
        wslArgs.push(wslE2aPath);
      }
    }
    // Convert other Windows paths (epub, output dir) to /mnt/... format
    else if (/^[A-Za-z]:[\\/]/.test(arg)) {
      wslArgs.push(windowsToWslPath(arg));
    } else {
      wslArgs.push(arg);
    }
  }

  // Build the full command:
  // 1. Export Python env vars so output isn't buffered (critical for subprocess stdout capture)
  // 2. cd to e2a directory
  // 3. Run conda with converted args
  const exportCommand = `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8`;
  const cdCommand = `cd "${wslE2aPath}"`;
  const condaCommand = `"${wslCondaPath}" ${wslArgs.join(' ')}`;

  return `${exportCommand} && ${cdCommand} && ${condaCommand}`;
}

/**
 * Spawn a process, routing to WSL if configured for Orpheus
 * On macOS/Linux or non-Orpheus: uses regular spawn
 * On Windows with Orpheus + WSL enabled: spawns via wsl.exe
 */
function spawnWithWslSupport(
  condaPath: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
  },
  ttsEngine?: string
): ChildProcess {
  // Check if we should use WSL
  if (shouldUseWslForSpawn(ttsEngine)) {
    console.log('[PARALLEL-TTS] Using WSL2 for Orpheus TTS spawn');

    const wslBashCommand = buildWslBashCommand({
      condaArgs: args,
      cwd: options.cwd,
      env: options.env as Record<string, string>,
      ttsEngine,
    });

    console.log('[PARALLEL-TTS] WSL full command:', wslBashCommand);

    const distro = getWslDistro();
    // Use bash -c (non-interactive) to avoid .bashrc issues blocking stdout
    const wslArgs = distro
      ? ['-d', distro, 'bash', '-c', wslBashCommand]
      : ['bash', '-c', wslBashCommand];

    return spawn('wsl.exe', wslArgs, {
      env: process.env,  // Pass through Windows env (WSL inherits these)
      shell: false,      // Don't use shell, wsl.exe handles it
    });
  }

  // Regular Windows/Mac/Linux spawn
  return spawn(condaPath, args, options);
}

/**
 * Kill a WSL process tree
 * WSL processes need special handling: kill Python in WSL, then kill wsl.exe
 */
function killWslProcessTree(process: ChildProcess, label: string, ttsEngine?: string): void {
  if (!process || process.killed) return;

  const pid = process.pid;
  if (!pid) {
    console.log(`[PARALLEL-TTS] ${label}: No PID, using SIGTERM`);
    try {
      process.kill('SIGTERM');
    } catch (err) {
      console.error(`[PARALLEL-TTS] Failed to kill ${label}:`, err);
    }
    return;
  }

  if (shouldUseWslForSpawn(ttsEngine)) {
    // WSL process: kill Python processes inside WSL first
    console.log(`[PARALLEL-TTS] Killing WSL ${label} process tree (PID: ${pid})`);
    const distro = getWslDistro();
    const distroArg = distro ? `-d ${distro}` : '';

    try {
      // Kill Python processes matching e2a patterns inside WSL
      execSync(`wsl.exe ${distroArg} pkill -f "python.*app.py"`, {
        timeout: 5000,
        stdio: 'ignore',
      });
      console.log(`[PARALLEL-TTS] Killed Python processes in WSL`);
    } catch (err) {
      // pkill may return non-zero if no processes found
      console.log(`[PARALLEL-TTS] WSL pkill returned (may be no matching processes)`);
    }

    try {
      // Kill the wsl.exe wrapper process on Windows
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
      console.log(`[PARALLEL-TTS] Killed wsl.exe wrapper process`);
    } catch (err) {
      console.log(`[PARALLEL-TTS] wsl.exe process may have already exited`);
    }
  } else {
    // Regular process tree kill
    killProcessTree(process, label);
  }
}

/**
 * Clean up orphaned vLLM processes in WSL
 * Similar to cleanupOrphanedVllmProcesses but for WSL
 */
function cleanupWslOrphanedProcesses(): void {
  if (os.platform() !== 'win32') return;
  if (!shouldUseWsl2ForOrpheus()) return;

  console.log('[PARALLEL-TTS] Cleaning up orphaned processes in WSL...');
  const distro = getWslDistro();
  const distroArg = distro ? `-d ${distro}` : '';

  try {
    // Kill any orphaned Python processes running e2a in WSL
    execSync(`wsl.exe ${distroArg} pkill -f "python.*app.py"`, {
      timeout: 5000,
      stdio: 'ignore',
    });
    // Kill any orphaned vLLM processes in WSL
    execSync(`wsl.exe ${distroArg} pkill -f "vllm"`, {
      timeout: 5000,
      stdio: 'ignore',
    });
    console.log('[PARALLEL-TTS] WSL orphaned process cleanup complete');
  } catch (err) {
    // pkill returns non-zero if no processes found, that's OK
    console.log('[PARALLEL-TTS] WSL orphaned process cleanup returned (may be no processes)');
  }
}

// Power save blocker ID - prevents system sleep during TTS conversion
let powerBlockerId: number | null = null;

/**
 * Start preventing system sleep (call when TTS conversion starts)
 */
function startPowerBlock(): void {
  if (powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[PARALLEL-TTS] Power save blocker started (ID:', powerBlockerId, ')');
  }
}

/**
 * Stop preventing system sleep (call when all TTS conversions complete)
 */
function stopPowerBlock(): void {
  if (powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    console.log('[PARALLEL-TTS] Power save blocker stopped');
    powerBlockerId = null;
  }
}

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
  // Resume mode - specific indices this worker should process
  assignedIndices?: number[];  // For scattered missing sentences
  // Total sentences assigned to this worker (for accurate progress calculation)
  // For regular jobs: sentenceEnd - sentenceStart + 1
  // For resume jobs: assignedIndices.length (may be less than the range)
  totalAssigned?: number;
  // Watchdog tracking
  startedAt?: number;          // Timestamp when worker started
  lastProgressAt?: number;     // Timestamp of last progress update
  hasShownProgress?: boolean;  // Has worker shown any converting progress
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
  // Bilingual mode for language learning audiobooks
  bilingual?: {
    enabled: boolean;
    pauseDuration?: number;  // Seconds between source and target (default 0.3)
    gapDuration?: number;    // Seconds between pairs (default 1.0)
  };
  // Skip assembly phase - returns sentences directory path for external assembly
  // Used for dual-voice bilingual workflows where assembly happens after both
  // source and target TTS jobs complete
  skipAssembly?: boolean;
  // Clean session - delete any existing e2a sessions for this epub before starting
  // Used for language learning jobs which should always start fresh (no resume)
  cleanSession?: boolean;
  // BFP project path - for copying final audio to {bfp}/audiobook/ folder
  bfpPath?: string;
  // Is this an article (language learning) vs a book?
  // Articles: copy to BFP audiobook/ only
  // Books: also copy to externalAudiobooksDir
  isArticle?: boolean;
  // External audiobooks directory - for books, final m4b is also copied here
  externalAudiobooksDir?: string;
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
  // For language learning: treat each <p> as a sentence, skip e2a's sentence splitting
  sentencePerParagraph?: boolean;
  // For bilingual TTS: skip reading heading tags (h1-h4) as chapter titles
  skipHeadings?: boolean;
}

export interface AggregatedProgress {
  phase: 'preparing' | 'converting' | 'assembling' | 'enhancing' | 'complete' | 'error';
  totalSentences: number;
  completedSentences: number;
  completedInSession: number;  // Sentences completed in THIS session (for ETA calculation)
  percentage: number;
  activeWorkers: number;
  workers: WorkerState[];
  estimatedRemaining: number;
  message?: string;
  error?: string;
  // Assembly phase details
  assemblySubPhase?: 'combining' | 'vtt' | 'encoding' | 'metadata';
  assemblyProgress?: number;  // 0-100 for current sub-phase
  assemblyChapter?: number;   // Current chapter being processed
  assemblyTotalChapters?: number;
  // Historical data for accurate elapsed time across runs
  totalElapsedSeconds?: number;  // Total elapsed across all runs (for resume jobs)
  historicalRate?: number;       // Historical sentences per minute average
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

import {
  getDefaultE2aPath,
  getCondaRunArgs,
  getCondaPath,
  shouldUseWsl2ForAllTts,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  windowsToWslPath,
  wslPathToWindows,
} from './e2a-paths';

// Helper to get conda run args - always uses fresh e2aPath from centralized config
// Pass ttsEngine to use the correct environment (orpheus_tts for Orpheus in WSL, python_env for others)
function condaRunArgs(ttsEngine?: string): string[] {
  return getCondaRunArgs(getDefaultE2aPath(), ttsEngine);
}

/**
 * Convert a path to Windows-accessible format for reading files
 * Only converts WSL paths on Windows - Mac/Linux paths starting with / are normal Unix paths
 */
function toReadablePath(p: string): string {
  // Only convert on Windows when it looks like a WSL path
  if (process.platform === 'win32' && p && p.startsWith('/') && !p.startsWith('/mnt/')) {
    // This is a native WSL path, convert to Windows UNC
    return wslPathToWindows(p);
  }
  return p;
}

let mainWindow: BrowserWindow | null = null;
let loggerInitialized = false;

// Use lightweight worker.py for lower memory usage (~3GB vs ~25GB)
// Set to false to use app.py with --headless --session (full imports)
// worker.py imports from bookforge_ext.parallel.worker_core (minimal deps)
// app.py imports everything (~25GB) - only use for debugging
let useLightweightWorker = true;

// Watchdog configuration - detect stuck workers
const WORKER_STARTUP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to start showing progress
const WORKER_PROGRESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes without progress = stuck

/**
 * Initialize the logger for parallel TTS bridge
 */
export async function initializeLogger(libraryPath: string): Promise<void> {
  if (!loggerInitialized) {
    await logger.initializeLogger(libraryPath);
    initWorkerLog(libraryPath);
    loggerInitialized = true;
    await logger.log('INFO', 'system', 'Parallel TTS bridge logger initialized');
  }
}

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
  // Resume job tracking
  isResumeJob?: boolean;
  baselineCompleted?: number;  // Sentences already done before resume started
  totalMissing?: number;       // Sentences to process in this resume session
  // Watchdog
  watchdogTimer?: NodeJS.Timeout;
  // ETA calculation - exclude model setup time
  firstSentenceCompletedTime?: number;  // When first sentence actually completed (excludes model loading)
  // Persistent state - loaded from previous runs
  persistentState?: PersistentSessionState;
  // State save timer
  stateSaveTimer?: NodeJS.Timeout;
  // Temp output directory - used when bfpPath is set, for Syncthing compatibility
  tempOutputDir?: string;
}

// Persistent session state - saved to disk for resume capability
interface SessionRunRecord {
  runId: string;
  startTime: string;           // ISO timestamp
  endTime?: string;            // ISO timestamp
  elapsedSeconds: number;
  sentencesProcessedInRun: number;
  sentencesPerMinute: number;
  workerCount: number;
  status: 'running' | 'completed' | 'cancelled' | 'error';
  error?: string;
}

interface PersistentSessionState {
  sessionId: string;
  processDir: string;
  originalStartTime: string;   // When the book was first started
  runs: SessionRunRecord[];
  // Aggregated totals
  totalElapsedSeconds: number;
  totalSentencesProcessed: number;
  // For ETA calculation on resume
  historicalSentencesPerMinute: number;
  // Book info
  totalSentences: number;
  totalChapters: number;
  // Settings used
  settings: {
    device: string;
    language: string;
    ttsEngine: string;
    fineTuned?: string;
  };
  // Metadata
  metadata?: {
    title?: string;
    author?: string;
  };
}

const activeSessions: Map<string, ConversionSession> = new Map();
const STATE_SAVE_INTERVAL = 30000; // Save state every 30 seconds

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Session State Functions
// ─────────────────────────────────────────────────────────────────────────────

function getStateFilePath(processDir: string): string {
  return path.join(processDir, 'session_state.json');
}

async function loadPersistentState(processDir: string): Promise<PersistentSessionState | null> {
  try {
    const stateFile = getStateFilePath(processDir);
    if (fsSync.existsSync(stateFile)) {
      const data = fsSync.readFileSync(stateFile, 'utf8');
      const state = JSON.parse(data) as PersistentSessionState;
      console.log(`[PARALLEL-TTS] Loaded persistent state: ${state.runs.length} previous runs, ${state.totalElapsedSeconds}s total elapsed`);
      return state;
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Failed to load persistent state:', err);
  }
  return null;
}

async function savePersistentState(session: ConversionSession): Promise<void> {
  if (!session.prepInfo?.processDir) return;

  try {
    const now = Date.now();
    const currentRunElapsed = Math.round((now - session.startTime) / 1000);
    // completedSentences tracks actual TTS conversions (each "Converting sentence" line = 1 conversion)
    const sessionDone = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

    // Calculate current run's rate
    const durationMinutes = currentRunElapsed / 60;
    const currentSentencesPerMinute = durationMinutes > 0 && sessionDone > 0
      ? Math.round((sessionDone / durationMinutes) * 10) / 10
      : 0;

    // Get or create state
    let state = session.persistentState;
    if (!state) {
      state = {
        sessionId: session.prepInfo.sessionId,
        processDir: session.prepInfo.processDir,
        originalStartTime: new Date(session.startTime).toISOString(),
        runs: [],
        totalElapsedSeconds: 0,
        totalSentencesProcessed: 0,
        historicalSentencesPerMinute: 0,
        totalSentences: session.prepInfo.totalSentences,
        totalChapters: session.prepInfo.totalChapters,
        settings: {
          device: session.config.settings.device,
          language: session.config.settings.language,
          ttsEngine: session.config.settings.ttsEngine,
          fineTuned: session.config.settings.fineTuned
        },
        metadata: session.config.metadata ? {
          title: session.config.metadata.title,
          author: session.config.metadata.author
        } : undefined
      };
      session.persistentState = state;
    }

    // Find or create current run record
    const currentRunId = session.jobId;
    let currentRun = state.runs.find(r => r.runId === currentRunId);
    if (!currentRun) {
      currentRun = {
        runId: currentRunId,
        startTime: new Date(session.startTime).toISOString(),
        elapsedSeconds: 0,
        sentencesProcessedInRun: 0,
        sentencesPerMinute: 0,
        workerCount: session.config.workerCount,
        status: 'running'
      };
      state.runs.push(currentRun);
    }

    // Update current run
    currentRun.elapsedSeconds = currentRunElapsed;
    currentRun.sentencesProcessedInRun = sessionDone;
    currentRun.sentencesPerMinute = currentSentencesPerMinute;

    // Calculate totals (sum of all completed runs + current run)
    const completedRuns = state.runs.filter(r => r.runId !== currentRunId);
    const completedElapsed = completedRuns.reduce((sum, r) => sum + r.elapsedSeconds, 0);
    const completedSentences = completedRuns.reduce((sum, r) => sum + r.sentencesProcessedInRun, 0);

    state.totalElapsedSeconds = completedElapsed + currentRunElapsed;
    state.totalSentencesProcessed = completedSentences + sessionDone;

    // Calculate historical rate (weighted average)
    if (state.totalElapsedSeconds > 0 && state.totalSentencesProcessed > 0) {
      state.historicalSentencesPerMinute = Math.round(
        (state.totalSentencesProcessed / (state.totalElapsedSeconds / 60)) * 10
      ) / 10;
    }

    // Save to disk
    const stateFile = getStateFilePath(session.prepInfo.processDir);
    fsSync.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[PARALLEL-TTS] Failed to save persistent state:', err);
  }
}

async function finalizeRunState(
  session: ConversionSession,
  status: 'completed' | 'cancelled' | 'error',
  error?: string
): Promise<void> {
  if (!session.prepInfo?.processDir || !session.persistentState) return;

  try {
    const state = session.persistentState;
    const currentRun = state.runs.find(r => r.runId === session.jobId);
    if (currentRun) {
      currentRun.endTime = new Date().toISOString();
      currentRun.status = status;
      if (error) currentRun.error = error;
    }

    // Recalculate totals
    state.totalElapsedSeconds = state.runs.reduce((sum, r) => sum + r.elapsedSeconds, 0);
    state.totalSentencesProcessed = state.runs.reduce((sum, r) => sum + r.sentencesProcessedInRun, 0);

    if (state.totalElapsedSeconds > 0 && state.totalSentencesProcessed > 0) {
      state.historicalSentencesPerMinute = Math.round(
        (state.totalSentencesProcessed / (state.totalElapsedSeconds / 60)) * 10
      ) / 10;
    }

    // Save final state
    const stateFile = getStateFilePath(session.prepInfo.processDir);
    fsSync.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log(`[PARALLEL-TTS] Finalized run state: ${status}, total ${state.totalElapsedSeconds}s, ${state.totalSentencesProcessed} sentences`);
  } catch (err) {
    console.error('[PARALLEL-TTS] Failed to finalize run state:', err);
  }
}

function startStateSaveTimer(session: ConversionSession): void {
  if (session.stateSaveTimer) return;
  session.stateSaveTimer = setInterval(() => {
    savePersistentState(session).catch(err => {
      console.error('[PARALLEL-TTS] Periodic state save failed:', err);
    });
  }, STATE_SAVE_INTERVAL);
}

function stopStateSaveTimer(session: ConversionSession): void {
  if (session.stateSaveTimer) {
    clearInterval(session.stateSaveTimer);
    session.stateSaveTimer = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Functions
// ─────────────────────────────────────────────────────────────────────────────

export function setE2aPath(newPath: string): void {
  // Delegate to centralized e2a-paths module
  const { setE2aPath: setCentralE2aPath } = require('./e2a-paths');
  setCentralE2aPath(newPath);
}

export function getE2aPath(): string {
  // Always get fresh from centralized config
  return getDefaultE2aPath();
}

export function setUseLightweightWorker(useLight: boolean): void {
  useLightweightWorker = useLight;
  console.log(`[PARALLEL-TTS] Lightweight worker mode: ${useLightweightWorker ? 'enabled' : 'disabled'}`);
}

export function getUseLightweightWorker(): boolean {
  return useLightweightWorker;
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

/**
 * Kill all active worker processes (called on app quit)
 */
export function killAllWorkers(): void {
  console.log('[PARALLEL-TTS] Killing all workers on app shutdown...');
  stopPowerBlock();

  for (const [jobId, session] of activeSessions) {
    console.log(`[PARALLEL-TTS] Killing workers for job ${jobId}`);
    const ttsEngine = session.config?.settings?.ttsEngine;

    // Clear watchdog timer
    if (session.watchdogTimer) {
      clearInterval(session.watchdogTimer);
    }

    // Kill all worker processes (including child process trees)
    // Use WSL-aware kill for Orpheus on Windows with WSL enabled
    for (const worker of session.workers) {
      if (worker.process && !worker.process.killed) {
        killWslProcessTree(worker.process, `worker ${worker.id}`, ttsEngine);
      }
    }

    // Kill assembly process if running
    if (session.assemblyProcess && !session.assemblyProcess.killed) {
      killWslProcessTree(session.assemblyProcess, 'assembly', ttsEngine);
    }
  }

  // Clean up any orphaned vLLM processes that escaped the process tree
  cleanupOrphanedVllmProcesses();
  // Also clean up orphaned processes in WSL if applicable
  cleanupWslOrphanedProcesses();

  activeSessions.clear();
  console.log('[PARALLEL-TTS] All workers killed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Hardware Detection
// ─────────────────────────────────────────────────────────────────────────────

export function detectRecommendedWorkerCount(): { count: number; reason: string } {
  const platform = os.platform();
  const totalMemGB = os.totalmem() / (1024 * 1024 * 1024);

  // Platform-specific max workers:
  // - macOS (MPS): 4 workers - Apple Silicon handles parallel TTS well with unified memory
  // - Windows/Linux (CUDA): 1 worker - GPU memory contention limits parallel benefit
  const platformMaxWorkers = platform === 'darwin' ? 4 : 1;

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

  // Each TTS worker uses ~3GB memory
  // Reserve 2GB overhead for OOM protection
  // Formula: floor((available - 2) / 3), capped by platform max, minimum 1
  const memPerWorker = 3;
  const overheadGB = 2;
  const maxByMemory = Math.floor((availableMemGB - overheadGB) / memPerWorker);
  const count = Math.min(platformMaxWorkers, Math.max(1, maxByMemory));

  const deviceType = platform === 'darwin' ? 'MPS' : 'CUDA';
  return {
    count,
    reason: `${Math.round(availableMemGB)}GB available (${deviceType})`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Preparation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run e2a with --prep_only to get total sentence count and session info
 * We generate our own session ID and read the session-state.json file after completion
 * (avoids fragile stdout parsing)
 */
export async function prepareSession(
  epubPath: string,
  settings: ParallelTtsSettings
): Promise<PrepInfo> {
  const appPath = path.join(getDefaultE2aPath(), 'app.py');
  const sessionId = crypto.randomUUID();

  // When using WSL for Orpheus, the session is created in WSL's filesystem
  // We need to use the WSL path for session directory and convert to Windows UNC for reading
  const useWsl = shouldUseWslForSpawn(settings.ttsEngine);
  let sessionDir: string;
  let sessionDirForReading: string;

  if (useWsl) {
    // Session will be created in WSL's e2a path
    const wslE2aPath = getWslE2aPath();
    sessionDir = `${wslE2aPath}/tmp/ebook-${sessionId}`;
    // Convert to Windows UNC path for reading from Node.js
    sessionDirForReading = wslPathToWindows(sessionDir);
    console.log(`[PARALLEL-TTS] WSL session dir: ${sessionDir} -> ${sessionDirForReading}`);
  } else {
    // Session in Windows e2a path
    sessionDir = path.join(getDefaultE2aPath(), 'tmp', `ebook-${sessionId}`);
    sessionDirForReading = sessionDir;
  }

  // Map UI device names to e2a CLI device names (app.py expects uppercase)
  const deviceMap: Record<string, string> = { 'gpu': 'CUDA', 'mps': 'MPS', 'cpu': 'CPU' };
  const deviceArg = deviceMap[settings.device] || settings.device.toUpperCase();

  const args = [
    ...condaRunArgs(settings.ttsEngine),
    appPath,
    '--headless',
    '--ebook', epubPath,
    '--session', sessionId,
    '--language', settings.language,
    '--tts_engine', settings.ttsEngine,
    '--device', deviceArg,
    '--prep_only'
  ];

  if (settings.fineTuned) {
    args.push('--fine_tuned', settings.fineTuned);
  }

  // Pass XTTS settings explicitly (stored in session-state.json for workers)
  if (settings.ttsEngine === 'xtts') {
    if (settings.temperature !== undefined) {
      args.push('--temperature', settings.temperature.toString());
    }
    if (settings.topP !== undefined) {
      args.push('--top_p', settings.topP.toString());
    }
    if (settings.topK !== undefined) {
      args.push('--top_k', settings.topK.toString());
    }
    if (settings.repetitionPenalty !== undefined) {
      args.push('--repetition_penalty', settings.repetitionPenalty.toString());
    }
    if (settings.speed !== undefined) {
      args.push('--speed', settings.speed.toString());
    }
    if (settings.enableTextSplitting) {
      args.push('--enable_text_splitting');
    }
  }

  // Language learning mode: preserve paragraph boundaries as sentences
  if (settings.sentencePerParagraph) {
    args.push('--sentence_per_paragraph');
  }

  console.log('[PARALLEL-TTS] Running prep with:', args.join(' '));

  // Run the prep command
  await new Promise<void>((resolve, reject) => {
    let stderr = '';

    const prepProcess = spawnWithWslSupport(
      getCondaPath(),
      args,
      {
        cwd: getDefaultE2aPath(),
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' },
        shell: true
      },
      settings.ttsEngine
    );

    // Log stdout for visibility (but don't parse it)
    prepProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        // Only log non-JSON lines (skip the massive prep info JSON)
        if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) {
          const logLine = `[PREP] ${text.substring(0, 500)}`;
          console.log('[PARALLEL-TTS] Prep:', text.substring(0, 200));
          writeWorkerLog(logLine);
        }
      }
    });

    prepProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      // Log stderr for visibility
      const text = data.toString().trim();
      if (text && !text.includes('━')) {  // Skip progress bars
        const logLine = `[PREP STDERR] ${text.substring(0, 500)}`;
        console.log('[PARALLEL-TTS] Prep stderr:', text.substring(0, 200));
        writeWorkerLog(logLine);
      }
    });

    prepProcess.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Prep failed with code ${code}: ${stderr}`));
      }
    });

    prepProcess.on('error', reject);
  });

  // Read the session-state.json file from the process subdirectory
  // Use sessionDirForReading which is a Windows-accessible path (UNC for WSL paths)
  const entries = await fs.readdir(sessionDirForReading, { withFileTypes: true });
  const processDir = entries.find(e => e.isDirectory());
  if (!processDir) {
    throw new Error(`No process directory found in ${sessionDirForReading}`);
  }

  // Build Windows-accessible paths from sessionDirForReading
  // The session-state.json contains WSL-native paths, but we need Windows UNC paths for file operations
  const processDirForReading = path.join(sessionDirForReading, processDir.name);
  const statePath = path.join(processDirForReading, 'session-state.json');
  const stateContent = await fs.readFile(statePath, 'utf-8');
  const state = JSON.parse(stateContent);

  const prepInfo: PrepInfo = {
    sessionId: state.session_id,
    // Use Windows-accessible paths for file operations, not WSL-native paths from state
    sessionDir: sessionDirForReading,
    processDir: processDirForReading,
    chaptersDir: path.join(processDirForReading, 'chapters'),
    chaptersDirSentences: path.join(processDirForReading, 'chapters', 'sentences'),
    totalChapters: state.total_chapters,
    totalSentences: state.total_sentences,
    chapters: state.chapters.map((c: any) => ({
      chapterNum: c.chapter_num,
      sentenceCount: c.sentence_count,
      sentenceStart: c.sentence_start,
      sentenceEnd: c.sentence_end
    })),
    metadata: state.metadata
  };

  console.log('[PARALLEL-TTS] Prep complete:', prepInfo.totalSentences, 'sentences');
  return prepInfo;
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

  const settings = config.settings;
  const isChapterMode = config.parallelMode === 'chapters';

  // Choose between lightweight worker.py (~8GB memory) or full app.py (~25GB memory)
  // worker.py only imports TTS dependencies, avoiding gradio/stanza/pytesseract
  let args: string[];

  if (useLightweightWorker) {
    // Use worker.py - lightweight entry point with minimal imports
    const workerPath = path.join(getDefaultE2aPath(), 'worker.py');
    // worker.py argparser expects uppercase device names: CPU, MPS, CUDA
    const deviceMap: Record<string, string> = { 'gpu': 'CUDA', 'mps': 'MPS', 'cpu': 'CPU' };
    const deviceArg = deviceMap[settings.device] || settings.device.toUpperCase();
    args = [
      ...condaRunArgs(settings.ttsEngine),
      workerPath,
      '--session', prepInfo.sessionId,
      '--device', deviceArg,
      '--tts_engine', settings.ttsEngine
    ];

    // Always pass fine_tuned (voice) to ensure current UI selection is used
    // This is critical for resume jobs where session-state.json has the original voice
    if (settings.fineTuned) {
      args.push('--fine_tuned', settings.fineTuned);
    }

    // Pass speed setting (XTTS only)
    if (settings.speed !== undefined && settings.speed !== 1.0) {
      args.push('--speed', settings.speed.toString());
    }

    // Add output_dir if specified
    if (config.outputDir) {
      args.push('--output_dir', config.outputDir);
    }

    // Add range args based on mode
    if (isChapterMode && range.chapterStart !== undefined && range.chapterEnd !== undefined) {
      args.push('--chapter_start', range.chapterStart.toString());
      args.push('--chapter_end', range.chapterEnd.toString());
    } else if (range.sentenceStart !== undefined && range.sentenceEnd !== undefined) {
      args.push('--sentence_start', range.sentenceStart.toString());
      args.push('--sentence_end', range.sentenceEnd.toString());
    }
  } else {
    // Use app.py with --worker_mode - full imports but same functionality
    const appPath = path.join(getDefaultE2aPath(), 'app.py');
    // Map UI device names to e2a CLI device names (app.py expects uppercase)
    const appDeviceMap: Record<string, string> = { 'gpu': 'CUDA', 'mps': 'MPS', 'cpu': 'CPU' };
    const appDeviceArg = appDeviceMap[settings.device] || settings.device.toUpperCase();
    args = [
      ...condaRunArgs(settings.ttsEngine),
      appPath,
      '--headless',
      '--session', prepInfo.sessionId,
      '--device', appDeviceArg,
      '--output_dir', config.outputDir,
      '--worker_mode',
      '--skip_deps',  // Deps already verified during prep phase
      '--tts_engine', settings.ttsEngine
    ];

    // Always pass fine_tuned (voice) to ensure current UI selection is used
    if (settings.fineTuned) {
      args.push('--fine_tuned', settings.fineTuned);
    }

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

    // Pass speed setting (XTTS only)
    if (settings.speed !== undefined && settings.speed !== 1.0) {
      args.push('--speed', settings.speed.toString());
    }
  }

  const rangeDesc = isChapterMode
    ? `chapters ${range.chapterStart}-${range.chapterEnd}`
    : `sentences ${range.sentenceStart}-${range.sentenceEnd}`;
  const workerType = useLightweightWorker ? 'lightweight (worker.py)' : 'full (app.py)';
  const startMsg = `[PARALLEL-TTS] Worker ${workerId} starting [${workerType}]: ${rangeDesc}`;
  const settingsMsg = `[PARALLEL-TTS] Worker ${workerId} settings: engine=${settings.ttsEngine}, voice=${settings.fineTuned}, device=${settings.device}, speed=${settings.speed}`;
  console.log(startMsg);
  console.log(settingsMsg);
  writeWorkerLog(startMsg);
  writeWorkerLog(settingsMsg);

  // Log to file
  logger.log('INFO', session.jobId, `Worker ${workerId} starting`, {
    range: rangeDesc,
    workerType: useLightweightWorker ? 'lightweight' : 'full',
    engine: settings.ttsEngine,
    voice: settings.fineTuned,
    device: settings.device
  }).catch(() => {}); // Don't fail if logging fails

  const workerProcess = spawnWithWslSupport(
    getCondaPath(),
    args,
    {
      cwd: getDefaultE2aPath(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' },
      shell: true
    },
    settings.ttsEngine
  );

  // Update worker state with PID and timestamps
  const worker = session.workers[workerId];
  worker.process = workerProcess;
  worker.pid = workerProcess.pid;
  worker.status = 'running';
  worker.startedAt = Date.now();
  worker.hasShownProgress = false;

  // Emit progress immediately so UI shows worker is running (important after retry)
  emitProgress(session);

  logger.log('INFO', session.jobId, `Worker ${workerId} spawned`, { pid: workerProcess.pid, usingWsl: shouldUseWslForSpawn(settings.ttsEngine) }).catch(() => {});

  // Parse worker progress from stdout
  workerProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const logLine = `[WORKER ${workerId}] ${line.trim()}`;
      console.log(logLine);
      writeWorkerLog(logLine);

      // Parse progress - support both output formats:
      // Format 1 (Windows e2a): "Converting sentence 49 - 0.53%: 49/9248"
      // Format 2 (Mac e2a):     "Converting sentence 996/3954 (0.1%)"
      // Each line = 1 actual conversion (skipped sentences don't print progress)
      const progressMatch = line.match(/Converting sentence (\d+) - ([\d.]+)%: (\d+)\/(\d+)/i)
        || line.match(/Converting sentence (\d+)\/(\d+)\s*\(([\d.]+)%\)/i);
      if (progressMatch) {
        const currentSentence = parseInt(progressMatch[1]);
        worker.currentSentence = currentSentence;
        // Count each progress line as 1 completed sentence (works for both regular and resume jobs)
        worker.completedSentences = (worker.completedSentences || 0) + 1;
        // Update watchdog tracking
        worker.lastProgressAt = Date.now();
        if (!worker.hasShownProgress) {
          worker.hasShownProgress = true;
          logger.log('INFO', session.jobId, `Worker ${workerId} started converting`, {
            startupTime: Math.round((Date.now() - (worker.startedAt || Date.now())) / 1000)
          }).catch(() => {});
        }
        emitProgress(session);
      }
    }
  });

  workerProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const logLine = `[WORKER ${workerId} STDERR] ${line.trim()}`;
      console.log(logLine);
      writeWorkerLog(logLine);

      // Parse progress from stderr too (both formats)
      const progressMatch = line.match(/Converting sentence (\d+) - ([\d.]+)%: (\d+)\/(\d+)/i)
        || line.match(/Converting sentence (\d+)\/(\d+)\s*\(([\d.]+)%\)/i);
      if (progressMatch) {
        const currentSentence = parseInt(progressMatch[1]);
        worker.currentSentence = currentSentence;
        worker.completedSentences = (worker.completedSentences || 0) + 1;
        worker.lastProgressAt = Date.now();
        if (!worker.hasShownProgress) {
          worker.hasShownProgress = true;
          logger.log('INFO', session.jobId, `Worker ${workerId} started converting`, {
            startupTime: Math.round((Date.now() - (worker.startedAt || Date.now())) / 1000)
          }).catch(() => {});
        }
        emitProgress(session);
      }
    }
  });

  workerProcess.on('close', (code) => {
    const duration = worker.startedAt ? Math.round((Date.now() - worker.startedAt) / 1000) : 0;
    const exitMsg = `[PARALLEL-TTS] Worker ${workerId} exited with code ${code} after ${duration}s`;
    console.log(exitMsg);
    writeWorkerLog(exitMsg);
    worker.process = null;

    if (session.cancelled) {
      worker.status = 'error';
      worker.error = 'Cancelled';
      logger.log('INFO', session.jobId, `Worker ${workerId} cancelled`, { duration }).catch(() => {});
      return;
    }

    if (code === 0) {
      worker.status = 'complete';
      worker.completedSentences = worker.sentenceEnd - worker.sentenceStart + 1;
      logger.log('INFO', session.jobId, `Worker ${workerId} completed`, {
        duration,
        sentences: worker.completedSentences
      }).catch(() => {});
      emitProgress(session);
      checkAllWorkersComplete(session);
    } else {
      worker.status = 'error';
      worker.error = `Worker exited with code ${code}`;
      logger.logError(session.jobId, `Worker ${workerId} failed`, new Error(`Exit code ${code}`), {
        duration,
        hadProgress: worker.hasShownProgress,
        lastSentence: worker.currentSentence
      }).catch(() => {});
      emitProgress(session);
      // checkAllWorkersComplete will handle retries
      checkAllWorkersComplete(session);
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
    console.warn(`[PARALLEL-TTS] Workers permanently failed after ${MAX_WORKER_RETRIES} retries:`, errors);
    // Don't abort immediately - continue to check if we can still assemble with partial results
  }

  // Check if all workers are done (complete, failed, or permanently failed)
  const stillRunning = session.workers.some(w => w.status === 'running' || w.status === 'pending');
  const retriesInProgress = failedWorkers.some(w => w.retryCount < MAX_WORKER_RETRIES);

  // All workers finished (success or permanent failure)
  if (!stillRunning && !retriesInProgress) {
    stopWatchdog(session);

    const completedWorkers = session.workers.filter(w => w.status === 'complete');
    const failedWorkersList = permanentlyFailed.length > 0 ? permanentlyFailed : [];

    // If ALL workers failed, abort
    if (completedWorkers.length === 0 && failedWorkersList.length > 0) {
      const errors = failedWorkersList
        .map(w => `Worker ${w.id} (sentences ${w.sentenceStart}-${w.sentenceEnd}): ${w.error}`)
        .join('; ');
      console.error(`[PARALLEL-TTS] All workers failed, cannot proceed`);
      emitComplete(session, false, undefined, `All workers failed: ${errors}`);
      activeSessions.delete(session.jobId);
      return;
    }

    // Some workers completed - attempt assembly (may work with partial results)
    if (failedWorkersList.length > 0) {
      console.warn(`[PARALLEL-TTS] ${failedWorkersList.length} worker(s) failed, but ${completedWorkers.length} succeeded. Attempting assembly with available sentences...`);
      await logger.log('WARN', session.jobId, `Partial completion: ${completedWorkers.length}/${session.workers.length} workers succeeded`);
    } else {
      console.log('[PARALLEL-TTS] All workers complete, starting assembly');
      await logger.log('INFO', session.jobId, 'All workers complete, starting assembly');
    }

    // Check if we should skip assembly (for dual-voice bilingual workflows)
    console.log(`[PARALLEL-TTS] Checking skipAssembly: session.config.skipAssembly = ${session.config.skipAssembly}`);
    if (session.config.skipAssembly) {
      const sentencesDir = session.prepInfo?.chaptersDirSentences || session.prepInfo?.chaptersDir;
      console.log(`[PARALLEL-TTS] skipAssembly=true, returning sentences directory: ${sentencesDir}`);
      await logger.log('INFO', session.jobId, `skipAssembly mode - sentences at: ${sentencesDir}`);
      // Emit completion with sentences directory as the "output path" for downstream assembly
      emitComplete(session, true, sentencesDir);
      activeSessions.delete(session.jobId);
      return;
    }

    try {
      const outputPath = await runAssembly(session);
      // Mark as success even with partial worker failures if assembly succeeded
      if (failedWorkersList.length > 0) {
        console.log(`[PARALLEL-TTS] Assembly succeeded despite ${failedWorkersList.length} worker failure(s)`);
      }
      emitComplete(session, true, outputPath);
    } catch (err) {
      const workerErrors = failedWorkersList.length > 0
        ? ` (${failedWorkersList.length} worker(s) also failed)`
        : '';
      emitComplete(session, false, undefined, `Assembly failed: ${err}${workerErrors}`);
    }
    activeSessions.delete(session.jobId);
  }
}

/**
 * Start the watchdog timer for a session
 * Checks every 30 seconds for stuck workers
 */
function startWatchdog(session: ConversionSession): void {
  if (session.watchdogTimer) return;

  console.log(`[PARALLEL-TTS] Watchdog started for job ${session.jobId} (checking every 30s, timeout: ${WORKER_STARTUP_TIMEOUT_MS / 1000 / 60}min)`);

  session.watchdogTimer = setInterval(() => {
    const runningWorkers = session.workers.filter(w => w.status === 'running');
    const elapsed = runningWorkers.map(w => w.startedAt ? Math.round((Date.now() - w.startedAt) / 1000) : 0);
    console.log(`[WATCHDOG] Checking ${runningWorkers.length} workers, elapsed: ${elapsed.map(e => `${e}s`).join(', ')}`);
    checkForStuckWorkers(session);
  }, 30000); // Check every 30 seconds
}

/**
 * Stop the watchdog timer
 */
function stopWatchdog(session: ConversionSession): void {
  if (session.watchdogTimer) {
    clearInterval(session.watchdogTimer);
    session.watchdogTimer = undefined;
  }
}

/**
 * Check for workers that appear stuck (no progress for too long)
 */
async function checkForStuckWorkers(session: ConversionSession): Promise<void> {
  if (session.cancelled) return;

  const now = Date.now();
  const stuckWorkers: WorkerState[] = [];

  for (const worker of session.workers) {
    if (worker.status !== 'running') continue;

    // Check if worker has been running but never showed progress
    if (!worker.hasShownProgress && worker.startedAt) {
      const timeSinceStart = now - worker.startedAt;
      const minutesElapsed = Math.round(timeSinceStart / 1000 / 60);
      const timeoutMinutes = Math.round(WORKER_STARTUP_TIMEOUT_MS / 1000 / 60);
      if (timeSinceStart > WORKER_STARTUP_TIMEOUT_MS) {
        console.error(`[WATCHDOG] Worker ${worker.id} STUCK - ${minutesElapsed}min > ${timeoutMinutes}min timeout, killing...`);
        await logger.logError(session.jobId, `Worker ${worker.id} stuck - no progress after startup`,
          new Error(`No progress for ${Math.round(timeSinceStart / 1000 / 60)} minutes`),
          { workerId: worker.id, pid: worker.pid, sentenceRange: `${worker.sentenceStart}-${worker.sentenceEnd}` });
        stuckWorkers.push(worker);
      }
    }
    // Check if worker was making progress but stopped
    else if (worker.hasShownProgress && worker.lastProgressAt) {
      const timeSinceProgress = now - worker.lastProgressAt;
      if (timeSinceProgress > WORKER_PROGRESS_TIMEOUT_MS) {
        console.error(`[PARALLEL-TTS] Worker ${worker.id} stuck - no progress for ${Math.round(timeSinceProgress / 1000 / 60)} minutes`);
        await logger.logError(session.jobId, `Worker ${worker.id} stuck - stopped making progress`,
          new Error(`No progress for ${Math.round(timeSinceProgress / 1000 / 60)} minutes`),
          { workerId: worker.id, pid: worker.pid, lastProgress: worker.completedSentences });
        stuckWorkers.push(worker);
      }
    }
  }

  // Kill stuck workers so they can be retried
  const ttsEngine = session.config?.settings?.ttsEngine;
  for (const worker of stuckWorkers) {
    if (worker.process) {
      console.log(`[PARALLEL-TTS] Killing stuck worker ${worker.id} (PID: ${worker.pid})`);
      await logger.log('WARN', session.jobId, `Killing stuck worker ${worker.id}`, { pid: worker.pid });
      killWslProcessTree(worker.process, `stuck worker ${worker.id}`, ttsEngine);
      worker.status = 'error';
      worker.error = 'Worker stuck - no progress';
      // The process close handler will trigger retry logic
    }
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

  // Emit progress immediately to clear error state from UI
  emitProgress(session);

  console.log(`[PARALLEL-TTS] Retrying worker ${worker.id} (attempt ${worker.retryCount}): ${
    isChapterMode
      ? `chapters ${worker.chapterStart}-${worker.chapterEnd}`
      : `sentences ${worker.sentenceStart}-${worker.sentenceEnd}`
  }`);

  // Clean up any orphaned vLLM processes before retry (the failed worker may have left them)
  cleanupOrphanedVllmProcesses();

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
 * Finalize output path by copying to final destinations if using temp folder
 *
 * @param processedPath - The path to the processed m4b file (in temp or output dir)
 * @param session - The conversion session
 * @returns The final output path (BFP audiobook path if using temp, otherwise processedPath)
 */
async function finalizeOutputPath(processedPath: string, session: ConversionSession): Promise<string> {
  // If not using temp folder, return the processed path as-is
  if (!session.tempOutputDir) {
    return processedPath;
  }

  const config = session.config;
  console.log('[PARALLEL-TTS] Finalizing output from temp folder to destinations...');

  try {
    const result = await copyToFinalDestination(
      session.tempOutputDir,
      config.bfpPath,
      config.externalAudiobooksDir,
      config.isArticle || false
    );

    console.log('[PARALLEL-TTS] Files copied to final destinations:', result);
    return result.audioPath;
  } catch (err) {
    // If copy fails, log the error but don't fail the job
    // The files are still in the temp folder
    console.error('[PARALLEL-TTS] Failed to copy to final destinations:', err);
    console.log('[PARALLEL-TTS] Files remain in temp folder:', session.tempOutputDir);
    return processedPath;
  }
}

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
      completedInSession: session.isResumeJob ? (session.totalMissing || 0) : prepInfo.totalSentences,
      percentage: 95,
      activeWorkers: 0,
      workers: session.workers,
      estimatedRemaining: 60, // Estimate 1 minute for assembly
      message: 'Assembling final audiobook...'
    };
    mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });
  }

  // Run e2a with --assemble_only to combine sentence audio files into final audiobook
  const appPath = path.join(getDefaultE2aPath(), 'app.py');
  const settings = config.settings;

  // Map UI device names to e2a CLI device names (app.py expects uppercase)
  const asmDeviceMap: Record<string, string> = { 'gpu': 'CUDA', 'mps': 'MPS', 'cpu': 'CPU' };
  const asmDeviceArg = asmDeviceMap[settings.device] || settings.device.toUpperCase();

  const args = [
    ...condaRunArgs(settings.ttsEngine),
    appPath,
    '--headless',
    // Only include --ebook if we have a path (assembly_only doesn't require it)
    ...(config.epubPath ? ['--ebook', config.epubPath] : []),
    '--output_dir', config.outputDir,
    '--session', prepInfo.sessionId,
    '--device', asmDeviceArg,
    '--language', settings.language,
    '--tts_engine', settings.ttsEngine,  // Required for session setup even in assembly mode
    '--assemble_only',  // Skip TTS, just combine existing sentence audio files
    '--skip_deps',      // Deps already verified during prep phase
    '--no_split',       // Don't split into multiple parts - create single file
    // Bilingual mode for language learning audiobooks
    ...(config.bilingual?.enabled ? [
      '--bilingual',
      '--bilingual_pause', String(config.bilingual.pauseDuration ?? 0.3),
      '--bilingual_gap', String(config.bilingual.gapDuration ?? 1.0)
    ] : [])
  ];

  console.log('[PARALLEL-TTS] Running assembly:', args.join(' '));

  return new Promise((resolve, reject) => {
    let stderr = '';
    let outputPath = '';

    // Use WSL-aware spawn for Orpheus to ensure session files are found in WSL filesystem
    session.assemblyProcess = spawnWithWslSupport(
      getCondaPath(),
      args,
      {
        cwd: getDefaultE2aPath(),
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' },
        shell: true
      },
      settings.ttsEngine  // Pass TTS engine to check if WSL should be used
    );

    // Track assembly state for progress reporting
    let assemblySubPhase: 'combining' | 'vtt' | 'encoding' | 'metadata' = 'combining';
    let currentChapter = 0;
    const totalChapters = prepInfo.totalChapters;

    const sendAssemblyProgress = (subPhase: typeof assemblySubPhase, subProgress: number, message?: string) => {
      if (!mainWindow) return;

      // Calculate overall percentage: combining 0-60%, vtt 60-70%, encoding 70-95%, metadata 95-100%
      let overallPercent: number;
      switch (subPhase) {
        case 'combining':
          overallPercent = Math.round(subProgress * 0.6);
          break;
        case 'vtt':
          overallPercent = 60 + Math.round(subProgress * 0.1);
          break;
        case 'encoding':
          overallPercent = 70 + Math.round(subProgress * 0.25);
          break;
        case 'metadata':
          overallPercent = 95 + Math.round(subProgress * 0.05);
          break;
      }

      const progress: AggregatedProgress = {
        phase: 'assembling',
        totalSentences: prepInfo.totalSentences,
        completedSentences: prepInfo.totalSentences,
        completedInSession: session.isResumeJob ? (session.totalMissing || 0) : prepInfo.totalSentences,
        percentage: overallPercent,
        activeWorkers: 0,
        workers: session.workers,
        estimatedRemaining: Math.max(10, Math.round((100 - overallPercent) * 0.6)), // Rough estimate
        message: message || getAssemblyMessage(subPhase, subProgress, currentChapter, totalChapters),
        assemblySubPhase: subPhase,
        assemblyProgress: subProgress,
        assemblyChapter: currentChapter,
        assemblyTotalChapters: totalChapters
      };
      mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });
    };

    const getAssemblyMessage = (
      subPhase: 'combining' | 'vtt' | 'encoding' | 'metadata',
      _progress: number,
      chapter: number,
      total: number
    ): string => {
      // Don't include percentage in message - the progress bar already shows it
      switch (subPhase) {
        case 'combining':
          return chapter > 0
            ? `Combining chapter ${chapter}/${total}`
            : `Combining chapters...`;
        case 'vtt':
          return `Creating subtitles...`;
        case 'encoding':
          return `Encoding M4B audiobook...`;
        case 'metadata':
          return `Applying metadata...`;
      }
    };

    // Send initial progress
    sendAssemblyProgress('combining', 0, 'Starting assembly...');

    session.assemblyProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      console.log('[ASSEMBLY]', output.trim());

      // Parse chapter number: "[ASSEMBLE] Chapter N: sentences X-Y"
      const chapterMatch = output.match(/\[ASSEMBLE\] Chapter (\d+):/);
      if (chapterMatch) {
        currentChapter = parseInt(chapterMatch[1]);
        sendAssemblyProgress('combining', Math.round((currentChapter / totalChapters) * 100));
      }

      // Parse combining progress: "Assemble - XX.X%"
      const assembleMatch = output.match(/Assemble - ([\d.]+)%/);
      if (assembleMatch && assemblySubPhase === 'combining') {
        // This is per-chapter progress, combine with chapter progress
        const chapterProgress = parseFloat(assembleMatch[1]);
        const overallCombineProgress = ((currentChapter - 1) / totalChapters * 100) + (chapterProgress / totalChapters);
        sendAssemblyProgress('combining', Math.min(100, Math.round(overallCombineProgress)));
      }

      // Detect VTT phase: "[ASSEMBLE] Creating VTT subtitle file..."
      if (output.includes('Creating VTT') || output.includes('[VTT]')) {
        if (assemblySubPhase !== 'vtt') {
          assemblySubPhase = 'vtt';
          sendAssemblyProgress('vtt', 0);
        }
        // VTT doesn't have granular progress, estimate based on messages
        if (output.includes('Building VTT')) sendAssemblyProgress('vtt', 20);
        if (output.includes('Getting audio durations')) sendAssemblyProgress('vtt', 40);
        if (output.includes('Creating VTT blocks')) sendAssemblyProgress('vtt', 60);
        if (output.includes('Writing')) sendAssemblyProgress('vtt', 80);
        if (output.includes('VTT file created')) sendAssemblyProgress('vtt', 100);
      }

      // Detect encoding phase: "Export - XX.X%"
      const exportMatch = output.match(/Export - ([\d.]+)%/);
      if (exportMatch) {
        if (assemblySubPhase !== 'encoding') {
          assemblySubPhase = 'encoding';
        }
        sendAssemblyProgress('encoding', Math.round(parseFloat(exportMatch[1])));
      }

      // Detect combining chapters into final (after all individual chapters done)
      if (output.includes('Combining chapters into final')) {
        sendAssemblyProgress('combining', 95, 'Combining chapters into final audiobook...');
      }

      // Look for output file path in various formats
      // Format 1: "Output #0, ipod, to '/path/file.m4b':"
      // Format 2: "saved to /path/file.m4b"
      // Format 3: "created: /path/file.m4b"
      const outputMatch = output.match(/(?:output[^']*to|saved to|created|wrote)[:\s]+(['"]?)([\/~][^'":\n]+\.m4b)\1/i);
      if (outputMatch) {
        let detectedPath = outputMatch[2].trim();
        // If running via WSL, convert WSL path (/mnt/c/...) back to Windows path
        if (shouldUseWslForSpawn(settings.ttsEngine) && detectedPath.startsWith('/mnt/')) {
          detectedPath = wslPathToWindows(detectedPath);
          console.log('[PARALLEL-TTS] Converted WSL output path to Windows:', detectedPath);
        }
        outputPath = detectedPath;
      }
    });

    session.assemblyProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.log('[ASSEMBLY STDERR]', data.toString().trim());
    });

    session.assemblyProcess.on('close', async (code) => {
      session.assemblyProcess = null;
      console.log('[PARALLEL-TTS] Assembly process exited with code:', code);

      if (code === 0) {
        // Find the output file if not detected from logs
        if (!outputPath) {
          try {
            const files = await fs.readdir(config.outputDir);
            // Filter for .m4b files, excluding macOS resource forks (._* files)
            const m4bFiles = files.filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
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

        const finalPath = outputPath || path.join(config.outputDir || '.', 'audiobook.m4b');

        // Apply metadata and rename using m4b-tool if metadata was provided
        console.log('[PARALLEL-TTS] Assembly complete. Checking metadata for rename...');
        console.log('[PARALLEL-TTS] config.outputDir:', config.outputDir);
        console.log('[PARALLEL-TTS] config.metadata:', JSON.stringify(config.metadata, null, 2));
        console.log('[PARALLEL-TTS] finalPath:', finalPath);

        // Verify the output file exists
        try {
          await fs.access(finalPath);
        } catch {
          console.error('[PARALLEL-TTS] Output file not found at:', finalPath);
          reject(new Error(`Output file not found: ${finalPath}`));
          return;
        }

        if (config.metadata && finalPath && config.outputDir) {
          try {
            console.log('[PARALLEL-TTS] Calling applyMetadataWithM4bTool...');
            let processedPath = await applyMetadataWithM4bTool(finalPath, config.metadata, config.outputDir);
            console.log('[PARALLEL-TTS] After metadata, path:', processedPath);

            // Run Resemble Enhance for Orpheus TTS output (removes reverb)
            processedPath = await runResembleEnhance(processedPath, settings.ttsEngine, session.jobId);
            console.log('[PARALLEL-TTS] Final processed path:', processedPath);
            resolve(await finalizeOutputPath(processedPath, session));
          } catch (metaErr) {
            console.error('[PARALLEL-TTS] Metadata processing failed, using original file:', metaErr);
            resolve(await finalizeOutputPath(finalPath, session));
          }
        } else {
          if (!config.outputDir) {
            console.error('[PARALLEL-TTS] Cannot apply metadata/rename - outputDir is empty');
          }
          console.log('[PARALLEL-TTS] Skipping metadata - config.metadata is:', config.metadata);

          // Still run Resemble Enhance for Orpheus even without metadata
          let resultPath = finalPath;
          try {
            resultPath = await runResembleEnhance(finalPath, settings.ttsEngine, session.jobId);
          } catch (err) {
            console.error('[PARALLEL-TTS] Resemble Enhance failed:', err);
          }
          resolve(await finalizeOutputPath(resultPath, session));
        }
      } else {
        // Even if e2a exited with error, the m4b file might have been created
        // Try to find and post-process it anyway
        console.log('[PARALLEL-TTS] Assembly exited with non-zero code, checking for output file anyway...');
        try {
          const files = await fs.readdir(config.outputDir);
          // Filter for .m4b files, excluding macOS resource forks (._* files)
          const m4bFiles = files.filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
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
            const foundPath = path.join(config.outputDir, mostRecent.file);
            console.log('[PARALLEL-TTS] Found output file despite error:', foundPath);

            // Try to apply metadata anyway
            if (config.metadata && config.outputDir) {
              try {
                console.log('[PARALLEL-TTS] Attempting post-processing despite assembly error...');
                let processedPath = await applyMetadataWithM4bTool(foundPath, config.metadata, config.outputDir);

                // Run Resemble Enhance for Orpheus
                processedPath = await runResembleEnhance(processedPath, settings.ttsEngine, session.jobId);
                console.log('[PARALLEL-TTS] Post-processing succeeded:', processedPath);
                resolve(await finalizeOutputPath(processedPath, session));
                return;
              } catch (metaErr) {
                console.error('[PARALLEL-TTS] Post-processing failed:', metaErr);
                resolve(await finalizeOutputPath(foundPath, session));
                return;
              }
            }

            // Still run Resemble Enhance for Orpheus even without metadata
            try {
              const enhancedPath = await runResembleEnhance(foundPath, settings.ttsEngine, session.jobId);
              resolve(await finalizeOutputPath(enhancedPath, session));
            } catch (err) {
              resolve(await finalizeOutputPath(foundPath, session));
            }
            return;
          }
        } catch (findErr) {
          console.error('[PARALLEL-TTS] Could not find output file after error:', findErr);
        }
        reject(new Error(`Assembly failed with code ${code}: ${stderr}`));
      }
    });

    session.assemblyProcess.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Post-Processing (uses shared metadata-tools module)
// ─────────────────────────────────────────────────────────────────────────────

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

  console.log('[PARALLEL-TTS] applyMetadataWithM4bTool called with:');
  console.log('[PARALLEL-TTS]   inputPath:', inputPath);
  console.log('[PARALLEL-TTS]   outputDir:', outputDir);
  console.log('[PARALLEL-TTS]   metadata:', JSON.stringify(metadata, null, 2));
  console.log('[PARALLEL-TTS]   hasMetadataChanges:', hasMetadataChanges);
  console.log('[PARALLEL-TTS]   hasRename:', hasRename);

  if (!hasMetadataChanges && !hasRename) {
    console.log('[PARALLEL-TTS] No metadata changes or rename needed, returning input path');
    return inputPath;
  }

  if (!outputDir) {
    console.error('[PARALLEL-TTS] outputDir is empty - cannot rename file to destination folder');
    // Still try to apply metadata in place
  }

  console.log('[PARALLEL-TTS] Applying metadata:', metadata);

  // ALWAYS remove e2a's default cover - we don't want auto-extracted covers
  // Only apply our own cover if coverPath is provided
  console.log('[PARALLEL-TTS] Removing e2a default cover...');
  try {
    await removeCover(inputPath);
  } catch (err) {
    console.warn('[PARALLEL-TTS] Failed to remove cover (may not exist):', err);
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
  if (metadata.coverPath) {
    console.log('[PARALLEL-TTS] Will apply cover from:', metadata.coverPath);
    try {
      await fs.access(metadata.coverPath);
      metadataToApply.coverPath = metadata.coverPath;
    } catch {
      console.error('[PARALLEL-TTS] Cover file not found:', metadata.coverPath);
    }
  } else {
    console.log('[PARALLEL-TTS] No coverPath provided - leaving cover blank');
  }

  // Apply metadata if we have any changes
  if (Object.keys(metadataToApply).length > 0) {
    console.log('[PARALLEL-TTS] Applying metadata:', metadataToApply);
    await applyMetadata(inputPath, metadataToApply);
  }

  // Rename and move if custom filename specified and outputDir is valid
  if (metadata.outputFilename && outputDir) {
    let newPath = path.join(outputDir, metadata.outputFilename);

    // Ensure the filename ends with .m4b
    if (!newPath.toLowerCase().endsWith('.m4b')) {
      newPath += '.m4b';
    }

    // Check if file already exists - if so, add a number suffix
    if (newPath !== inputPath) {
      newPath = await getUniqueFilePath(newPath);
      console.log(`[PARALLEL-TTS] Moving and renaming to: ${newPath}`);

      // Ensure output directory exists
      await fs.mkdir(path.dirname(newPath), { recursive: true });

      // Move the file (works across filesystems unlike rename)
      await fs.copyFile(inputPath, newPath);
      await fs.unlink(inputPath);

      // Also move VTT file if it exists (rename to match m4b filename)
      await moveVttFile(inputPath, newPath);

      console.log(`[PARALLEL-TTS] Successfully moved to: ${newPath}`);
      return newPath;
    }
  } else if (metadata.outputFilename && !outputDir) {
    console.error('[PARALLEL-TTS] Cannot rename - outputDir is not set');
  }

  return inputPath;
}

/**
 * Move VTT file to a vtt subfolder, renaming to match the M4B filename
 * Searches for VTT files in the original M4B's directory
 */
async function moveVttFile(originalM4bPath: string, newM4bPath: string): Promise<void> {
  try {
    const originalDir = path.dirname(originalM4bPath);
    const originalBasename = path.basename(originalM4bPath, '.m4b');
    const newDir = path.dirname(newM4bPath);
    const newBasename = path.basename(newM4bPath, '.m4b');

    // VTT files go in a 'vtt' subfolder
    const vttDir = path.join(newDir, 'vtt');

    // Look for VTT file with similar name in the original directory
    // ebook2audiobook often uses underscores instead of spaces
    const entries = await fs.readdir(originalDir);
    const vttFiles = entries.filter(f => f.toLowerCase().endsWith('.vtt'));

    for (const vttFile of vttFiles) {
      const vttBasename = path.basename(vttFile, '.vtt');
      // Check if the VTT filename is related to the M4B (contains similar words)
      const originalWords = originalBasename.toLowerCase().replace(/[_\-.]/g, ' ').split(' ').filter(w => w.length > 2);
      const vttWords = vttBasename.toLowerCase().replace(/[_\-.]/g, ' ').split(' ').filter(w => w.length > 2);

      // If most words match, it's likely the same book's VTT
      const matchingWords = originalWords.filter(w => vttWords.includes(w));
      const matchRatio = matchingWords.length / Math.max(originalWords.length, 1);

      if (matchRatio >= 0.5 || vttBasename.includes(originalBasename.replace(/ /g, '_'))) {
        const originalVttPath = path.join(originalDir, vttFile);

        // Create vtt subfolder if it doesn't exist
        await fs.mkdir(vttDir, { recursive: true });

        const newVttPath = path.join(vttDir, `${newBasename}.vtt`);

        console.log(`[PARALLEL-TTS] Moving VTT file to vtt folder: ${vttFile} -> vtt/${path.basename(newVttPath)}`);

        await fs.copyFile(originalVttPath, newVttPath);
        await fs.unlink(originalVttPath);
        break; // Only move one VTT file
      }
    }
  } catch (err) {
    console.warn('[PARALLEL-TTS] Failed to move VTT file (non-fatal):', err);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Resemble Enhance Post-Processing (for Orpheus TTS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run Resemble Enhance on the audiobook file to remove reverb/echo
 * Only runs automatically for Orpheus TTS output (which has baked-in reverb)
 *
 * @param inputPath - Path to the M4B file to enhance
 * @param ttsEngine - The TTS engine used (only 'orpheus' triggers auto-enhance)
 * @param jobId - Job ID for progress reporting
 * @returns The path to the enhanced file (same as input, file is modified in-place)
 */
async function runResembleEnhance(
  inputPath: string,
  ttsEngine: string,
  jobId: string
): Promise<string> {
  // DISABLED: Auto-enhancement takes ~19 hours for 8-hour book on CPU
  // Use Post-Processing tab to enhance manually when convenient
  console.log('[PARALLEL-TTS] Auto-enhancement disabled - use Post-Processing tab');
  return inputPath;

  // Only run for Orpheus TTS
  if (ttsEngine !== 'orpheus') {
    console.log('[PARALLEL-TTS] Skipping Resemble Enhance - not using Orpheus TTS');
    return inputPath;
  }

  // Check if Resemble Enhance is available
  const available = await checkResembleAvailable();
  if (!available.available) {
    console.log('[PARALLEL-TTS] Resemble Enhance not available, skipping post-processing');
    console.log('[PARALLEL-TTS] Setup instructions in AUDIO_ENHANCEMENT.md');
    return inputPath;
  }

  console.log('[PARALLEL-TTS] Running Resemble Enhance on Orpheus output...');

  // Initialize the bridge with mainWindow for progress updates
  if (mainWindow) {
    initResembleBridge(mainWindow!);

    // Emit enhancing phase progress
    const progress: AggregatedProgress = {
      phase: 'enhancing',
      totalSentences: 0,
      completedSentences: 0,
      completedInSession: 0,
      percentage: 98,
      activeWorkers: 0,
      workers: [],
      estimatedRemaining: 300, // Estimate 5 minutes for enhancement
      message: 'Enhancing audio quality (removing reverb)...'
    };
    mainWindow!.webContents.send('parallel-tts:progress', { jobId, progress });
  }

  try {
    const result = await enhanceFile(inputPath);
    if (result.success) {
      console.log('[PARALLEL-TTS] Resemble Enhance completed successfully');
      return result.outputPath || inputPath;
    } else {
      console.error('[PARALLEL-TTS] Resemble Enhance failed:', result.error);
      // Non-fatal - return original file
      return inputPath;
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Resemble Enhance error:', err);
    // Non-fatal - return original file
    return inputPath;
  }
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
    chapterEnd: w.chapterEnd,
    totalAssigned: w.totalAssigned
  }));
}

// Track last progress for smoothing estimates
const progressHistory: Map<string, { completedSentences: number; timestamp: number }[]> = new Map();
const ETA_SAMPLE_WINDOW = 30000; // Use last 30 seconds of data for ETA calculation
const MIN_SAMPLES_FOR_ETA = 3; // Need at least 3 data points before showing ETA
const MIN_SESSION_TIME_FOR_ETA = 10; // Wait at least 10 seconds before showing ETA
// Track last save for incremental state saving
const lastStateSave: Map<string, { sentences: number; time: number }> = new Map();
const STATE_SAVE_SENTENCE_INTERVAL = 10; // Save state every 10 sentences

function emitProgress(session: ConversionSession): void {
  if (!mainWindow || !session.prepInfo) return;

  const activeWorkers = session.workers.filter(w => w.status === 'running').length;
  const now = Date.now();

  // Count completedSentences from all workers (each progress line = 1 conversion)
  // This works for both regular and resume jobs since skipped sentences don't emit progress
  const sentencesDoneInSession = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

  // For resume jobs, add baseline (already completed before this session)
  const totalCompleted = session.isResumeJob && session.baselineCompleted !== undefined
    ? session.baselineCompleted + sentencesDoneInSession
    : sentencesDoneInSession;

  const percentage = Math.min(100, (totalCompleted / session.prepInfo.totalSentences) * 100);
  const remainingSentences = session.prepInfo.totalSentences - totalCompleted;

  // Track when first sentence completes (excludes model loading time from ETA)
  if (sentencesDoneInSession > 0 && !session.firstSentenceCompletedTime) {
    session.firstSentenceCompletedTime = now;
    console.log(`[PARALLEL-TTS] First sentence completed - ETA timing starts now (setup took ${Math.round((now - session.startTime) / 1000)}s)`);
  }

  // For ETA calculation, use time since first sentence completed (excludes model setup)
  // This gives much more accurate ETAs since model loading can take 30-60+ seconds
  const etaBaseTime = session.firstSentenceCompletedTime || session.startTime;
  const workElapsedSeconds = (now - etaBaseTime) / 1000;

  // Track progress history for this session (for sliding window ETA calculation)
  if (!progressHistory.has(session.jobId)) {
    progressHistory.set(session.jobId, []);
  }
  const history = progressHistory.get(session.jobId)!;
  // Store sentencesDoneInSession (not totalCompleted) so window-based rate is correct
  history.push({ completedSentences: sentencesDoneInSession, timestamp: now });

  // Remove old samples outside the window
  const windowStart = now - ETA_SAMPLE_WINDOW;
  while (history.length > 0 && history[0].timestamp < windowStart) {
    history.shift();
  }

  // Calculate ETA using the better of two methods:
  // 1. Work rate: sentencesDoneInSession / workElapsedSeconds (excludes model setup)
  // 2. Window-based rate: sentences in last 30 seconds / 30 seconds
  // Use work rate for stability, window-based for responsiveness once we have enough data
  let estimatedRemaining = 0;

  // For ETA, we need at least 1 sentence done and some time elapsed since first completion
  // Use > 1 because when firstSentenceCompletedTime is set, sentencesDoneInSession is 1
  // and workElapsedSeconds is 0, which would cause division issues
  if (sentencesDoneInSession > 1 && workElapsedSeconds >= MIN_SESSION_TIME_FOR_ETA) {
    // Primary: Use work rate (excludes model setup time for accuracy)
    const workRate = sentencesDoneInSession / workElapsedSeconds;
    estimatedRemaining = Math.round(remainingSentences / workRate);

    // If we have enough window data, blend with window rate for responsiveness
    if (history.length >= MIN_SAMPLES_FOR_ETA) {
      const oldestSample = history[0];
      const sentencesInWindow = sentencesDoneInSession - oldestSample.completedSentences;
      const timeInWindow = (now - oldestSample.timestamp) / 1000;

      if (sentencesInWindow > 0 && timeInWindow > 5) {
        const windowRate = sentencesInWindow / timeInWindow;
        // Blend: 70% work rate, 30% recent window (prefer stability)
        const blendedRate = workRate * 0.7 + windowRate * 0.3;
        estimatedRemaining = Math.round(remainingSentences / blendedRate);
      }
    }
  }

  // Calculate rate for display (use work time, not total session time)
  // Always show sentences per minute for consistency
  let rateDisplay = '';
  if (sentencesDoneInSession > 1 && workElapsedSeconds >= MIN_SESSION_TIME_FOR_ETA) {
    const sentencesPerMinute = (sentencesDoneInSession / workElapsedSeconds) * 60;
    rateDisplay = ` (${sentencesPerMinute.toFixed(1)}/min)`;
  }

  // Calculate total elapsed including previous runs
  const currentRunElapsed = Math.round((now - session.startTime) / 1000);
  const previousRunsElapsed = session.persistentState
    ? session.persistentState.runs
        .filter(r => r.runId !== session.jobId)
        .reduce((sum, r) => sum + r.elapsedSeconds, 0)
    : 0;
  const totalElapsedSeconds = previousRunsElapsed + currentRunElapsed;

  const progress: AggregatedProgress = {
    phase: 'converting',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: totalCompleted,
    completedInSession: sentencesDoneInSession, // For accurate ETA calculation
    percentage: Math.round(percentage),
    activeWorkers,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining,
    message: session.isResumeJob
      ? `Resuming: ${sentencesDoneInSession} new${rateDisplay}`
      : `${activeWorkers} workers${rateDisplay}`,
    // Historical data for accurate elapsed time display
    totalElapsedSeconds,
    historicalRate: session.persistentState?.historicalSentencesPerMinute
  };

  mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });

  // Save state incrementally (every N sentences)
  const lastSave = lastStateSave.get(session.jobId) || { sentences: 0, time: 0 };
  if (sentencesDoneInSession - lastSave.sentences >= STATE_SAVE_SENTENCE_INTERVAL) {
    lastStateSave.set(session.jobId, { sentences: sentencesDoneInSession, time: now });
    savePersistentState(session).catch(err => {
      console.error('[PARALLEL-TTS] Incremental state save failed:', err);
    });
  }
}

function emitComplete(
  session: ConversionSession,
  success: boolean,
  outputPath?: string,
  error?: string
): void {
  if (!mainWindow || !session.prepInfo) return;

  // Clean up
  progressHistory.delete(session.jobId);
  lastStateSave.delete(session.jobId);
  stopWatchdog(session);
  stopStateSaveTimer(session);

  // Finalize persistent state
  finalizeRunState(session, success ? 'completed' : 'error', error).catch(err => {
    console.error('[PARALLEL-TTS] Failed to finalize state:', err);
  });

  const completedAt = new Date().toISOString();
  const duration = Math.round((Date.now() - session.startTime) / 1000);

  // Log completion
  const ttsLog = getTTSLogger();
  if (success) {
    logger.completeJob(session.jobId, outputPath).catch(() => {});
    logger.log('INFO', session.jobId, 'Conversion complete', { duration, outputPath }).catch(() => {});
    ttsLog.info('TTS conversion complete', {
      jobId: session.jobId,
      duration,
      outputPath,
      totalSentences: session.prepInfo.totalSentences,
      workerCount: session.config.workerCount
    });
  } else {
    logger.failJob(session.jobId, error || 'Unknown error').catch(() => {});
    ttsLog.error('TTS conversion failed', {
      jobId: session.jobId,
      duration,
      error: error || 'Unknown error'
    });
  }

  // Calculate total done in this session (completedSentences tracks actual TTS conversions)
  const sessionDone = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

  // Calculate sentences per minute (based on actual processing time)
  const durationMinutes = duration / 60;
  const sentencesPerMinute = durationMinutes > 0
    ? Math.round((sessionDone / durationMinutes) * 10) / 10
    : 0;

  // Get persistent state for comprehensive analytics
  const persistentState = session.persistentState;
  const totalElapsedAcrossRuns = persistentState
    ? persistentState.totalElapsedSeconds
    : duration;
  const totalSentencesAcrossRuns = persistentState
    ? persistentState.totalSentencesProcessed
    : sessionDone;
  const historicalRate = persistentState?.historicalSentencesPerMinute || sentencesPerMinute;

  // Build analytics data (includes both session and historical data)
  const analytics = {
    jobId: session.jobId,
    startedAt: new Date(session.startTime).toISOString(),
    completedAt,
    durationSeconds: duration,
    totalSentences: session.prepInfo.totalSentences,
    totalChapters: session.prepInfo.totalChapters,
    workerCount: session.config.workerCount,
    sentencesPerMinute,
    settings: {
      device: session.config.settings.device,
      language: session.config.settings.language,
      ttsEngine: session.config.settings.ttsEngine,
      fineTuned: session.config.settings.fineTuned || undefined
    },
    success,
    outputPath,
    error,
    isResumeJob: session.isResumeJob || false,
    sentencesProcessedInSession: sessionDone,
    // Historical data from all runs
    totalElapsedSecondsAllRuns: totalElapsedAcrossRuns,
    totalSentencesProcessedAllRuns: totalSentencesAcrossRuns,
    averageSentencesPerMinuteAllRuns: historicalRate,
    numberOfRuns: persistentState?.runs.length || 1,
    originalStartTime: persistentState?.originalStartTime || new Date(session.startTime).toISOString(),
    runs: persistentState?.runs || []
  };

  const progress: AggregatedProgress = {
    phase: success ? 'complete' : 'error',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: success ? session.prepInfo.totalSentences : 0,
    completedInSession: success ? sessionDone : 0,
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
    duration,
    analytics
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
  const ttsLog = getTTSLogger();
  ttsLog.info('Starting TTS conversion', {
    jobId,
    workerCount: config.workerCount,
    outputDir: config.outputDir,
    ttsEngine: config.settings.ttsEngine,
    voice: config.settings.fineTuned,
    device: config.settings.device,
    title: config.metadata?.title
  });

  console.log(`[PARALLEL-TTS] Starting conversion for job ${jobId} with ${config.workerCount} workers`);
  console.log(`[PARALLEL-TTS] Output dir from config:`, config.outputDir);
  console.log(`[PARALLEL-TTS] skipAssembly from config:`, config.skipAssembly);
  console.log(`[PARALLEL-TTS] Metadata received:`, JSON.stringify(config.metadata, null, 2));

  // Prevent system sleep during conversion
  startPowerBlock();

  // Log job start
  const bookTitle = config.metadata?.title || path.basename(config.epubPath, '.epub');
  const author = config.metadata?.author || 'Unknown';
  await logger.startJob(jobId, bookTitle, author, {
    workerCount: config.workerCount,
    parallelMode: config.parallelMode,
    ttsEngine: config.settings.ttsEngine,
    voice: config.settings.fineTuned,
    device: config.settings.device
  });

  // Determine effective output directory:
  // - If bfpPath is set, use temp folder (for Syncthing compatibility)
  // - Otherwise, require outputDir to be set
  let effectiveOutputDir: string;
  let tempOutputDir: string | undefined;

  if (config.bfpPath) {
    // Use temp folder - files will be copied to BFP on completion
    tempOutputDir = getTempOutputDir(jobId);
    await fs.mkdir(tempOutputDir, { recursive: true });
    effectiveOutputDir = tempOutputDir;
    console.log(`[PARALLEL-TTS] Using temp folder for output: ${tempOutputDir}`);
    console.log(`[PARALLEL-TTS] Will copy to BFP on completion: ${config.bfpPath}`);
    if (config.externalAudiobooksDir && !config.isArticle) {
      console.log(`[PARALLEL-TTS] Will also copy to external: ${config.externalAudiobooksDir}`);
    }
  } else if (config.outputDir && config.outputDir.trim() !== '') {
    // Legacy mode: output directly to outputDir
    effectiveOutputDir = config.outputDir;
  } else {
    const error = 'Output directory not configured. Please set the audiobook output folder in Settings.';
    console.error('[PARALLEL-TTS]', error);
    await logger.failJob(jobId, error);
    stopPowerBlock();
    return { success: false, error };
  }

  // Clean any existing sessions for this epub if requested
  // Used for language learning jobs which should always start fresh
  if (config.cleanSession) {
    console.log(`[PARALLEL-TTS] cleanSession=true, deleting existing sessions for ${config.epubPath}`);
    await deleteSessionsForEpub(config.epubPath);
  }

  // NOTE: We intentionally do NOT auto-skip to assembly for complete sessions.
  // Users who want to assemble an existing session should use the Reassembly feature.
  // TTS jobs always run prep to create a fresh session with the current settings.

  // Prepare the session first
  let prepInfo: PrepInfo;
  try {
    prepInfo = await prepareSession(config.epubPath, config.settings);
    await logger.log('INFO', jobId, 'Prep complete', {
      totalSentences: prepInfo.totalSentences,
      totalChapters: prepInfo.totalChapters,
      sessionId: prepInfo.sessionId
    });
  } catch (err) {
    const error = `Preparation failed: ${err}`;
    console.error('[PARALLEL-TTS]', error);
    await logger.failJob(jobId, error);
    stopPowerBlock();
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
        chapterEnd: range.chapterEnd,
        totalAssigned: sentenceEnd - sentenceStart + 1
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
      retryCount: 0,
      totalAssigned: range.end - range.start + 1
    }));
  }

  // Create internal config with effective output directory
  const internalConfig: ParallelConversionConfig = {
    ...config,
    outputDir: effectiveOutputDir
  };

  // Create session
  const session: ConversionSession = {
    jobId,
    config: internalConfig,
    prepInfo,
    workers,
    startTime: Date.now(),
    cancelled: false,
    assemblyProcess: null,
    tempOutputDir
  };

  activeSessions.set(jobId, session);

  // Load any existing persistent state (for tracking across restarts)
  const existingState = await loadPersistentState(prepInfo.processDir);
  if (existingState) {
    session.persistentState = existingState;
    console.log(`[PARALLEL-TTS] Loaded persistent state from previous runs: ${existingState.totalElapsedSeconds}s elapsed`);
  }

  // Start periodic state saving
  startStateSaveTimer(session);
  await savePersistentState(session); // Save initial state

  // Emit initial progress
  if (mainWindow) {
    const progress: AggregatedProgress = {
      phase: 'preparing',
      totalSentences: prepInfo.totalSentences,
      completedSentences: 0,
      completedInSession: 0,
      percentage: 0,
      activeWorkers: 0,
      workers,
      estimatedRemaining: 0,
      message: 'Starting workers...'
    };
    mainWindow.webContents.send('parallel-tts:progress', { jobId, progress });

    // Emit session-created event so frontend can save sessionId to BFP for pause/resume
    mainWindow.webContents.send('parallel-tts:session-created', {
      jobId,
      sessionId: prepInfo.sessionId,
      sessionDir: prepInfo.sessionDir,
      processDir: prepInfo.processDir,
      totalSentences: prepInfo.totalSentences,
      totalChapters: prepInfo.totalChapters
    });
  }

  // Start workers - stagger on Windows to avoid conda temp file race condition
  // On Windows, conda uses temp files that conflict when multiple processes start simultaneously
  // On Mac/Linux, we can start all workers immediately
  const isWindows = process.platform === 'win32';
  const WINDOWS_WORKER_STAGGER_MS = 2000; // 2 seconds between worker starts on Windows

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const range: WorkerRange = isChapterMode
      ? { chapterStart: worker.chapterStart, chapterEnd: worker.chapterEnd }
      : { sentenceStart: worker.sentenceStart, sentenceEnd: worker.sentenceEnd };

    if (isWindows && i > 0) {
      // Stagger worker starts on Windows to avoid conda temp file conflicts
      await new Promise(resolve => setTimeout(resolve, WINDOWS_WORKER_STAGGER_MS));
    }
    startWorker(session, i, range);
  }

  // Start the watchdog to detect stuck workers
  startWatchdog(session);
  await logger.log('INFO', jobId, `Started ${workers.length} workers with watchdog`);

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
  logger.log('WARN', jobId, 'Conversion stopped by user').catch(() => {});

  session.cancelled = true;
  stopWatchdog(session);
  const ttsEngine = session.config?.settings?.ttsEngine;

  // Kill all worker processes (including child process trees like vLLM)
  // Use WSL-aware kill for Orpheus on Windows with WSL enabled
  for (const worker of session.workers) {
    if (worker.process) {
      killWslProcessTree(worker.process, `worker ${worker.id}`, ttsEngine);
      worker.status = 'error';
      worker.error = 'Cancelled';
    }
  }

  // Kill assembly process if running
  if (session.assemblyProcess) {
    killWslProcessTree(session.assemblyProcess, 'assembly', ttsEngine);
  }

  // Clean up any orphaned vLLM processes that escaped the process tree
  cleanupOrphanedVllmProcesses();
  // Also clean up orphaned processes in WSL if applicable
  cleanupWslOrphanedProcesses();

  // Emit cancelled analytics before cleanup
  emitCancelledAnalytics(session);

  // Clean up progress history
  progressHistory.delete(jobId);

  activeSessions.delete(jobId);
  return true;
}

/**
 * Emit analytics for a cancelled job
 */
function emitCancelledAnalytics(session: ConversionSession): void {
  if (!mainWindow || !session.prepInfo) return;

  // Stop state save timer and finalize state
  stopStateSaveTimer(session);
  finalizeRunState(session, 'cancelled', 'Cancelled by user').catch(err => {
    console.error('[PARALLEL-TTS] Failed to finalize cancelled state:', err);
  });

  const cancelledAt = new Date().toISOString();
  const duration = Math.round((Date.now() - session.startTime) / 1000);

  // Calculate sentences completed before cancellation
  // completedSentences tracks actual TTS conversions for both regular and resume jobs
  const sessionDone = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);
  const completedSentences = session.isResumeJob
    ? (session.baselineCompleted || 0) + sessionDone
    : sessionDone;

  // Calculate sentences per minute
  const durationMinutes = duration / 60;
  const sentencesPerMinute = durationMinutes > 0 && sessionDone > 0
    ? Math.round((sessionDone / durationMinutes) * 10) / 10
    : 0;

  // Get persistent state for comprehensive analytics
  const persistentState = session.persistentState;
  const totalElapsedAcrossRuns = persistentState
    ? persistentState.totalElapsedSeconds
    : duration;
  const totalSentencesAcrossRuns = persistentState
    ? persistentState.totalSentencesProcessed
    : sessionDone;
  const historicalRate = persistentState?.historicalSentencesPerMinute || sentencesPerMinute;

  // Build analytics for cancelled job (includes historical data)
  const analytics = {
    jobId: session.jobId,
    startedAt: new Date(session.startTime).toISOString(),
    completedAt: cancelledAt,
    durationSeconds: duration,
    totalSentences: session.prepInfo.totalSentences,
    totalChapters: session.prepInfo.totalChapters,
    workerCount: session.config.workerCount,
    sentencesPerMinute,
    settings: {
      device: session.config.settings.device,
      language: session.config.settings.language,
      ttsEngine: session.config.settings.ttsEngine,
      fineTuned: session.config.settings.fineTuned || undefined
    },
    success: false,
    error: 'Cancelled by user',
    isResumeJob: session.isResumeJob || false,
    sentencesProcessedInSession: sessionDone,
    wasCancelled: true,
    completedSentencesAtCancel: completedSentences,
    // Historical data from all runs
    totalElapsedSecondsAllRuns: totalElapsedAcrossRuns,
    totalSentencesProcessedAllRuns: totalSentencesAcrossRuns,
    averageSentencesPerMinuteAllRuns: historicalRate,
    numberOfRuns: persistentState?.runs.length || 1,
    originalStartTime: persistentState?.originalStartTime || new Date(session.startTime).toISOString(),
    runs: persistentState?.runs || []
  };

  const progress: AggregatedProgress = {
    phase: 'error',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences,
    completedInSession: sessionDone,
    percentage: Math.round((completedSentences / session.prepInfo.totalSentences) * 100),
    activeWorkers: 0,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining: 0,
    message: 'Cancelled by user',
    error: 'Cancelled by user'
  };

  mainWindow.webContents.send('parallel-tts:progress', { jobId: session.jobId, progress });
  mainWindow.webContents.send('parallel-tts:complete', {
    jobId: session.jobId,
    success: false,
    error: 'Stopped by user',
    duration,
    analytics,
    // Flag to indicate this was a user-initiated stop (can be resumed)
    // The session files remain on disk and can be continued later
    wasStopped: true,
    stopInfo: {
      sessionId: session.prepInfo?.sessionId,
      sessionDir: session.prepInfo?.sessionDir,
      processDir: session.prepInfo?.processDir,
      completedSentences,
      totalSentences: session.prepInfo?.totalSentences,
      stoppedAt: new Date().toISOString()
    }
  });
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

  // For this on-demand query, estimate session work from workers
  // completedSentences tracks actual TTS conversions for both regular and resume jobs
  const sessionCompleted = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

  return {
    phase: 'converting',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: totalCompleted,
    completedInSession: sessionCompleted,
    percentage,
    activeWorkers,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining
  };
}

/**
 * Check if a conversion is active
 */
export function isConversionActive(jobId: string): boolean {
  return activeSessions.has(jobId);
}

/**
 * List all active conversion sessions with their current progress.
 * Used to re-sync UI after app rebuild.
 */
export function listActiveSessions(): Array<{
  jobId: string;
  progress: AggregatedProgress;
  epubPath: string;
  startTime: number;
}> {
  const result: Array<{
    jobId: string;
    progress: AggregatedProgress;
    epubPath: string;
    startTime: number;
  }> = [];

  for (const [jobId, session] of activeSessions) {
    const progress = getConversionProgress(jobId);
    if (progress) {
      result.push({
        jobId,
        progress,
        epubPath: session.config.epubPath,
        startTime: session.startTime
      });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume Support
// ─────────────────────────────────────────────────────────────────────────────

export interface ResumeCheckResult {
  success: boolean;
  complete?: boolean;          // All sentences already done
  error?: string;
  sessionId?: string;
  sessionDir?: string;
  sessionPath?: string;        // Full path to session directory (for fast check)
  processDir?: string;
  sourceEpubPath?: string;     // Original epub path stored in session (useful for directory matches)
  totalSentences?: number;
  totalChapters?: number;
  completedSentences?: number;
  missingSentences?: number;
  missingIndices?: number[];
  missingRanges?: Array<{ start: number; end: number; count: number }>;
  progressPercent?: number;
  canResume?: boolean;         // Has partial progress to resume
  chapters?: Array<{
    chapter_num: number;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>;
  metadata?: { title?: string; creator?: string; language?: string };
  warnings?: string[];
}

/**
 * Normalize a book title for fuzzy matching
 * Removes punctuation, extra spaces, and converts to lowercase
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[''"""\-–—:,\.!?]/g, ' ')  // Replace punctuation with spaces
    .replace(/\s+/g, ' ')                 // Collapse multiple spaces
    .trim();
}

/**
 * Extract likely book title from folder path
 * e.g., "Hitler_Redux_-_The_Incredible_History..." -> "hitler redux the incredible history"
 */
function extractTitleFromPath(folderPath: string): string {
  const folderName = path.basename(folderPath);
  // Remove date suffix and random ID (e.g., "_cleaned_2026-01-23_mkrducfg")
  const withoutSuffix = folderName.replace(/_cleaned_\d{4}-\d{2}-\d{2}_[a-z0-9]+$/i, '');
  // Replace underscores with spaces and normalize
  return normalizeTitle(withoutSuffix.replace(/_/g, ' '));
}

/**
 * Find session directory for an epub by scanning e2a's tmp folder
 * Returns the session directory path if found, or null
 * Matches by exact epub path only (epub_path or source_epub_path in session state)
 *
 * When multiple sessions match the same epub:
 * - Prefers incomplete sessions over complete ones (for resume functionality)
 * - Among incomplete sessions, prefers the most recent (by folder modification time)
 */
async function findSessionForEpub(epubPath: string): Promise<string | null> {
  const tmpDir = path.join(getDefaultE2aPath(), 'tmp');

  console.log(`[PARALLEL-TTS] e2aPath: ${getDefaultE2aPath()}`);
  console.log(`[PARALLEL-TTS] tmpDir: ${tmpDir}`);
  console.log(`[PARALLEL-TTS] Quick search for session matching: ${epubPath}`);

  try {
    // Check if tmp dir exists
    try {
      await fs.access(tmpDir);
    } catch {
      console.log(`[PARALLEL-TTS] No tmp directory - no sessions to check`);
      return null;
    }

    // List all session directories (ebook-{UUID})
    const sessionDirs = await fs.readdir(tmpDir);
    const ebookDirs = sessionDirs.filter(d => d.startsWith('ebook-'));

    if (ebookDirs.length === 0) {
      console.log(`[PARALLEL-TTS] No session directories found`);
      return null;
    }

    console.log(`[PARALLEL-TTS] Checking ${ebookDirs.length} session(s) for exact match`);

    // Collect ALL matching sessions with their completion status
    interface SessionMatch {
      sessionPath: string;
      processPath: string;
      totalSentences: number;
      completedSentences: number;
      isComplete: boolean;
      mtime: number;
    }
    const matches: SessionMatch[] = [];

    for (const sessionDir of ebookDirs) {
      const sessionPath = path.join(tmpDir, sessionDir);

      try {
        const sessionStat = await fs.stat(sessionPath);
        if (!sessionStat.isDirectory()) continue;

        // List process directories (hash folders)
        const processDirs = await fs.readdir(sessionPath);

        for (const processDir of processDirs) {
          const processPath = path.join(sessionPath, processDir);
          const statePath = path.join(processPath, 'session-state.json');

          try {
            const stateContent = await fs.readFile(statePath, 'utf-8');
            const state = JSON.parse(stateContent);

            // Check if this session matches the epub path
            const matches_epub = state.epub_path === epubPath;
            const matches_source = state.source_epub_path === epubPath;

            if (matches_epub || matches_source) {
              console.log(`[PARALLEL-TTS] Found matching session ${sessionDir}:`);
              console.log(`[PARALLEL-TTS]   total_sentences: ${state.total_sentences}`);

              // Quick count of completed sentences
              const sentencesDir = state.chapters_dir_sentences;
              let completedCount = 0;
              if (sentencesDir) {
                const sentencesDirReadable = toReadablePath(sentencesDir);
                try {
                  const files = await fs.readdir(sentencesDirReadable);
                  completedCount = files.filter(f => f.endsWith('.flac')).length;
                } catch {
                  // Can't read sentences dir
                }
              }

              const totalSentences = state.total_sentences || 0;
              const isComplete = completedCount >= totalSentences && totalSentences > 0;

              console.log(`[PARALLEL-TTS]   completed: ${completedCount}/${totalSentences} (${isComplete ? 'COMPLETE' : 'INCOMPLETE'})`);

              matches.push({
                sessionPath,
                processPath,
                totalSentences,
                completedSentences: completedCount,
                isComplete,
                mtime: sessionStat.mtimeMs
              });
            }
          } catch {
            // No session-state.json or invalid JSON - skip
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    if (matches.length === 0) {
      console.log(`[PARALLEL-TTS] No matching session found`);
      return null;
    }

    // Always return the most recent session (by folder modification time)
    matches.sort((a, b) => b.mtime - a.mtime);
    const best = matches[0];
    console.log(`[PARALLEL-TTS] Selected most recent session: ${best.sessionPath} (${best.completedSentences}/${best.totalSentences}, ${best.isComplete ? 'complete' : 'incomplete'})`);
    return best.sessionPath;

  } catch (err) {
    console.error('[PARALLEL-TTS] Error scanning for sessions:', err);
  }

  console.log(`[PARALLEL-TTS] No matching session found`);
  return null;
}

/**
 * Delete all session folders that match a specific epub path
 * Used for language learning jobs which should always start fresh (no resume)
 * @param epubPath - Path to the epub file
 * @returns Number of sessions deleted
 */
export async function deleteSessionsForEpub(epubPath: string): Promise<number> {
  const tmpDir = path.join(getDefaultE2aPath(), 'tmp');

  console.log(`[PARALLEL-TTS] Deleting sessions for: ${epubPath}`);

  try {
    // Check if tmp dir exists
    try {
      await fs.access(tmpDir);
    } catch {
      console.log(`[PARALLEL-TTS] No tmp directory - nothing to delete`);
      return 0;
    }

    // List all session directories (ebook-{UUID})
    const sessionDirs = await fs.readdir(tmpDir);
    const ebookDirs = sessionDirs.filter(d => d.startsWith('ebook-'));

    if (ebookDirs.length === 0) {
      return 0;
    }

    let deletedCount = 0;

    for (const sessionDir of ebookDirs) {
      const sessionPath = path.join(tmpDir, sessionDir);

      try {
        const sessionStat = await fs.stat(sessionPath);
        if (!sessionStat.isDirectory()) continue;

        // List process directories (hash folders)
        const processDirs = await fs.readdir(sessionPath);

        for (const processDir of processDirs) {
          const processPath = path.join(sessionPath, processDir);
          const statePath = path.join(processPath, 'session-state.json');

          try {
            const stateContent = await fs.readFile(statePath, 'utf-8');
            const state = JSON.parse(stateContent);

            // Check if this session matches the epub path
            const matchesEpub = state.epub_path === epubPath;
            const matchesSource = state.source_epub_path === epubPath;

            if (matchesEpub || matchesSource) {
              console.log(`[PARALLEL-TTS] Deleting session: ${sessionPath}`);
              await fs.rm(sessionPath, { recursive: true, force: true });
              deletedCount++;
              break; // Session folder deleted, move to next
            }
          } catch {
            // No session-state.json or invalid - skip
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    console.log(`[PARALLEL-TTS] Deleted ${deletedCount} session(s) for ${epubPath}`);
    return deletedCount;
  } catch (err) {
    console.error('[PARALLEL-TTS] Error deleting sessions:', err);
    return 0;
  }
}

/**
 * Fast check if a session can be resumed (no subprocess spawn)
 * Reads session-state.json and counts completed sentence files directly
 * Now also extracts all required info for resumeConversion (sessionId, chapters, missingRanges)
 */
export async function checkResumeStatusFast(epubPath: string): Promise<ResumeCheckResult> {
  const sessionPath = await findSessionForEpub(epubPath);
  if (!sessionPath) {
    return { success: false, error: 'No session found for this epub' };
  }

  try {
    // Find process dir and read session state
    const processDirs = await fs.readdir(sessionPath);
    for (const processDirName of processDirs) {
      const fullProcessDir = path.join(sessionPath, processDirName);
      const statePath = path.join(fullProcessDir, 'session-state.json');
      try {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const state = JSON.parse(stateContent);

        const totalSentences = state.total_sentences || 0;
        const sentencesDir = state.chapters_dir_sentences;

        if (!sentencesDir || totalSentences === 0) {
          return { success: false, error: 'Invalid session state' };
        }

        // Extract session ID from path (e.g., "ebook-97ccf8f4-3a89-4edd-a0f7-78fe95a4160d")
        // Worker expects just the UUID part, not the "ebook-" prefix
        const folderName = path.basename(sessionPath);
        const sessionId = folderName.startsWith('ebook-') ? folderName.slice(6) : folderName;

        // Scan completed sentence files and find missing indices
        // Convert to readable path if it's a WSL path
        const sentencesDirReadable = toReadablePath(sentencesDir);
        let completedIndices: Set<number> = new Set();
        let missingIndices: number[] = [];
        try {
          const files = await fs.readdir(sentencesDirReadable);
          // Parse sentence indices from filenames (0.flac, 1.flac, etc.)
          for (const f of files) {
            if (f.endsWith('.flac')) {
              const match = f.match(/^(\d+)\.flac$/);
              if (match) {
                completedIndices.add(parseInt(match[1], 10));
              }
            }
          }

          // Find missing indices
          for (let i = 0; i < totalSentences; i++) {
            if (!completedIndices.has(i)) {
              missingIndices.push(i);
            }
          }
        } catch {
          // If we can't read the directory, assume all sentences are missing
          missingIndices = Array.from({ length: totalSentences }, (_, i) => i);
        }

        const completedSentences = completedIndices.size;
        const isComplete = completedSentences >= totalSentences;

        // Calculate missing ranges (consecutive groups of missing indices)
        const missingRanges: Array<{ start: number; end: number; count: number }> = [];
        if (missingIndices.length > 0) {
          let rangeStart = missingIndices[0];
          let rangeEnd = missingIndices[0];

          for (let i = 1; i < missingIndices.length; i++) {
            if (missingIndices[i] === rangeEnd + 1) {
              // Consecutive - extend current range
              rangeEnd = missingIndices[i];
            } else {
              // Gap found - save current range and start new one
              missingRanges.push({
                start: rangeStart,
                end: rangeEnd,
                count: rangeEnd - rangeStart + 1
              });
              rangeStart = missingIndices[i];
              rangeEnd = missingIndices[i];
            }
          }
          // Don't forget the last range
          missingRanges.push({
            start: rangeStart,
            end: rangeEnd,
            count: rangeEnd - rangeStart + 1
          });
        }

        // Extract chapter info from state
        const chapters = (state.chapters || []).map((ch: any) => ({
          chapter_num: ch.chapter_num,
          sentence_start: ch.sentence_start,
          sentence_end: ch.sentence_end,
          sentence_count: ch.sentence_count
        }));

        console.log(`[PARALLEL-TTS] Fast resume check: ${completedSentences}/${totalSentences} sentences complete`);
        console.log(`[PARALLEL-TTS] Missing ranges: ${missingRanges.length} (${missingIndices.length} sentences)`);

        return {
          success: true,
          complete: isComplete,
          // Session info required for resumeConversion
          sessionId,
          sessionDir: sessionPath,
          processDir: fullProcessDir,
          sourceEpubPath: state.source_epub_path,  // Original epub path stored in session
          // Counts
          totalSentences,
          totalChapters: state.total_chapters || chapters.length,
          completedSentences,
          missingSentences: missingIndices.length,
          // Missing info for worker assignment
          missingIndices,
          missingRanges,
          // Chapter info
          chapters,
          // Metadata
          metadata: state.metadata || {},
          // Flags
          sessionPath,
          canResume: !isComplete && completedSentences > 0
        };
      } catch {
        continue;
      }
    }
    return { success: false, error: 'No valid session state found' };
  } catch (err) {
    return { success: false, error: `Failed to check session: ${err}` };
  }
}

/**
 * Check resume status directly from a processDir path
 * Used when continuing from Past Sessions where we already know the session location
 */
export async function checkResumeStatusFromProcessDir(processDir: string): Promise<ResumeCheckResult> {
  console.log('[PARALLEL-TTS] Checking resume status from processDir:', processDir);

  try {
    // Convert to readable path if it's a WSL path
    const processDirReadable = toReadablePath(processDir);
    const statePath = path.join(processDirReadable, 'session-state.json');

    const stateContent = await fs.readFile(statePath, 'utf-8');
    const state = JSON.parse(stateContent);

    const totalSentences = state.total_sentences || 0;
    const sentencesDir = state.chapters_dir_sentences;

    if (!sentencesDir || totalSentences === 0) {
      return { success: false, error: 'Invalid session state' };
    }

    // Extract session ID from the session dir path
    const sessionDir = path.dirname(processDirReadable);
    const folderName = path.basename(sessionDir);
    const sessionId = folderName.startsWith('ebook-') ? folderName.slice(6) : folderName;

    // Scan completed sentence files and find missing indices
    const sentencesDirReadable = toReadablePath(sentencesDir);
    let completedIndices: Set<number> = new Set();
    let missingIndices: number[] = [];
    try {
      const files = await fs.readdir(sentencesDirReadable);
      // Parse sentence indices from filenames (0.flac, 1.flac, etc.)
      for (const f of files) {
        if (f.endsWith('.flac')) {
          const match = f.match(/^(\d+)\.flac$/);
          if (match) {
            completedIndices.add(parseInt(match[1], 10));
          }
        }
      }

      // Find missing indices
      for (let i = 0; i < totalSentences; i++) {
        if (!completedIndices.has(i)) {
          missingIndices.push(i);
        }
      }
    } catch {
      // If we can't read the directory, assume all sentences are missing
      missingIndices = Array.from({ length: totalSentences }, (_, i) => i);
    }

    const completedSentences = completedIndices.size;
    const isComplete = completedSentences >= totalSentences;

    // Calculate missing ranges (consecutive groups of missing indices)
    const missingRanges: Array<{ start: number; end: number; count: number }> = [];
    if (missingIndices.length > 0) {
      let rangeStart = missingIndices[0];
      let rangeEnd = missingIndices[0];

      for (let i = 1; i < missingIndices.length; i++) {
        if (missingIndices[i] === rangeEnd + 1) {
          rangeEnd = missingIndices[i];
        } else {
          missingRanges.push({
            start: rangeStart,
            end: rangeEnd,
            count: rangeEnd - rangeStart + 1
          });
          rangeStart = missingIndices[i];
          rangeEnd = missingIndices[i];
        }
      }
      missingRanges.push({
        start: rangeStart,
        end: rangeEnd,
        count: rangeEnd - rangeStart + 1
      });
    }

    // Extract chapter info from state
    const chapters = (state.chapters || []).map((ch: any) => ({
      chapter_num: ch.chapter_num,
      sentence_start: ch.sentence_start,
      sentence_end: ch.sentence_end,
      sentence_count: ch.sentence_count
    }));

    console.log(`[PARALLEL-TTS] FromProcessDir: ${completedSentences}/${totalSentences} sentences complete`);
    console.log(`[PARALLEL-TTS] Missing ranges: ${missingRanges.length} (${missingIndices.length} sentences)`);

    return {
      success: true,
      complete: isComplete,
      sessionId,
      sessionDir,
      processDir: processDirReadable,
      sourceEpubPath: state.source_epub_path,
      totalSentences,
      totalChapters: state.total_chapters || chapters.length,
      completedSentences,
      missingSentences: missingIndices.length,
      missingIndices,
      missingRanges,
      chapters,
      metadata: state.metadata || {},
      sessionPath: sessionDir,
      canResume: !isComplete && completedSentences > 0,
      progressPercent: totalSentences > 0 ? (completedSentences / totalSentences) * 100 : 0
    };
  } catch (err) {
    console.error('[PARALLEL-TTS] Failed to check resume from processDir:', err);
    return { success: false, error: `Failed to check session: ${err}` };
  }
}

/**
 * Check if a session can be resumed (detailed check with subprocess)
 * Accepts either an epub path (will search for matching session) or a session path
 * Calls e2a's --resume_session to scan for completed sentences
 */
export async function checkResumeStatus(sessionOrEpubPath: string): Promise<ResumeCheckResult> {
  // If the path looks like an epub, find the session first
  let sessionPath = sessionOrEpubPath;
  if (sessionOrEpubPath.toLowerCase().endsWith('.epub')) {
    const foundSession = await findSessionForEpub(sessionOrEpubPath);
    if (!foundSession) {
      console.log('[PARALLEL-TTS] No session found for epub:', sessionOrEpubPath);
      return { success: false, error: 'No session found for this epub' };
    }
    sessionPath = foundSession;
  }

  const appPath = path.join(getDefaultE2aPath(), 'app.py');

  const args = [
    ...condaRunArgs(),
    appPath,
    '--headless',
    '--resume_session', sessionPath
  ];

  console.log('[PARALLEL-TTS] Checking resume status:', sessionPath);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const resumeCheckProcess = spawn(getCondaPath(), args, {
      cwd: getDefaultE2aPath(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' },
      shell: true
    });

    resumeCheckProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    resumeCheckProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    resumeCheckProcess.on('close', (code: number | null) => {
      if (code === 0) {
        try {
          // Find the JSON output in stdout
          const lines = stdout.split('\n').filter(l => l.trim());
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              if (parsed.success !== undefined) {
                // Map e2a's snake_case to camelCase
                const result: ResumeCheckResult = {
                  success: parsed.success,
                  complete: parsed.complete,
                  error: parsed.error,
                  sessionId: parsed.session_id,
                  sessionDir: parsed.session_dir,
                  processDir: parsed.process_dir,
                  totalSentences: parsed.total_sentences,
                  totalChapters: parsed.total_chapters,
                  completedSentences: parsed.completed_sentences,
                  missingSentences: parsed.missing_sentences,
                  missingIndices: parsed.missing_indices,
                  missingRanges: parsed.missing_ranges,
                  progressPercent: parsed.progress_percent,
                  chapters: parsed.chapters,
                  metadata: parsed.metadata,
                  warnings: parsed.warnings
                };
                console.log('[PARALLEL-TTS] Resume check result:',
                  result.completedSentences, '/', result.totalSentences, 'complete');
                resolve(result);
                return;
              }
            } catch {
              continue;
            }
          }
          resolve({ success: false, error: 'Failed to parse resume check output' });
        } catch (err) {
          resolve({ success: false, error: `Failed to parse resume check output: ${err}` });
        }
      } else {
        resolve({ success: false, error: `Resume check failed with code ${code}: ${stderr}` });
      }
    });

    resumeCheckProcess.on('error', (err: Error) => {
      resolve({ success: false, error: `Resume check process error: ${err.message}` });
    });
  });
}

/**
 * List all resumable sessions
 * Calls e2a's --list_sessions
 */
export async function listResumableSessions(): Promise<Array<{
  sessionId: string;
  sessionDir: string;
  title: string;
  totalSentences: number;
  completedSentences: number;
  missingSentences: number;
  progressPercent: number;
  createdAt?: string;
  language?: string;
  voice?: string;
}>> {
  const appPath = path.join(getDefaultE2aPath(), 'app.py');

  const args = [
    ...condaRunArgs(),
    appPath,
    '--headless',
    '--list_sessions'
  ];

  console.log('[PARALLEL-TTS] Listing resumable sessions');

  return new Promise((resolve) => {
    let stdout = '';

    const listProcess = spawn(getCondaPath(), args, {
      cwd: getDefaultE2aPath(),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' },
      shell: true
    });

    listProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    listProcess.on('close', () => {
      // Parse the human-readable output (not JSON for --list_sessions)
      // For now, return empty - this is optional functionality
      console.log('[PARALLEL-TTS] List sessions output:', stdout);
      resolve([]);
    });

    listProcess.on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Resume a partially completed conversion
 * Uses missing ranges from checkResumeStatus to only process incomplete sentences
 */
export async function resumeParallelConversion(
  jobId: string,
  config: ParallelConversionConfig,
  resumeInfo: ResumeCheckResult
): Promise<ParallelConversionResult> {
  console.log(`[PARALLEL-TTS] Resuming conversion for job ${jobId}`);
  console.log(`[PARALLEL-TTS] Missing ${resumeInfo.missingSentences} of ${resumeInfo.totalSentences} sentences`);

  if (!resumeInfo.success) {
    return { success: false, error: resumeInfo.error || 'Resume info invalid' };
  }

  // Check if we have all required fields - if not, re-fetch from fast check
  // This handles jobs that were added before the fix to checkResumeStatusFast
  // Always re-fetch to get fresh missingIndices for accurate re-splitting
  if (!resumeInfo.sessionId || !resumeInfo.processDir || !resumeInfo.missingIndices || resumeInfo.missingIndices.length === 0) {
    console.log('[PARALLEL-TTS] Resume info missing critical fields, re-fetching...');

    let freshInfo: ResumeCheckResult;
    if (resumeInfo.processDir) {
      // We have processDir (e.g., from Past Sessions) - use it directly
      console.log('[PARALLEL-TTS] Re-fetching from processDir:', resumeInfo.processDir);
      freshInfo = await checkResumeStatusFromProcessDir(resumeInfo.processDir);
    } else if (config.epubPath) {
      // Fall back to epubPath search
      console.log('[PARALLEL-TTS] Re-fetching from epubPath:', config.epubPath);
      freshInfo = await checkResumeStatusFast(config.epubPath);
    } else {
      return { success: false, error: 'Cannot re-fetch resume info: no processDir or epubPath available' };
    }

    if (!freshInfo.success) {
      return { success: false, error: freshInfo.error || 'Failed to re-fetch resume info' };
    }
    // Merge fresh info into resumeInfo
    resumeInfo = { ...resumeInfo, ...freshInfo };
    console.log(`[PARALLEL-TTS] Re-fetched: sessionId=${resumeInfo.sessionId}, missingIndices=${resumeInfo.missingIndices?.length}`);
  }

  // Determine effective output directory (same logic as startParallelConversion)
  // Do this BEFORE the complete check so runAssemblyOnly also gets temp folder support
  let effectiveOutputDir: string;
  let tempOutputDir: string | undefined;

  if (config.bfpPath) {
    tempOutputDir = getTempOutputDir(jobId);
    await fs.mkdir(tempOutputDir, { recursive: true });
    effectiveOutputDir = tempOutputDir;
    console.log(`[PARALLEL-TTS] Resume: Using temp folder for output: ${tempOutputDir}`);
  } else if (config.outputDir && config.outputDir.trim() !== '') {
    effectiveOutputDir = config.outputDir;
  } else {
    const error = 'Output directory not configured. Please set the audiobook output folder in Settings.';
    console.error('[PARALLEL-TTS]', error);
    return { success: false, error };
  }

  // Create internal config with effective output directory
  const internalConfig: ParallelConversionConfig = {
    ...config,
    outputDir: effectiveOutputDir
  };

  if (resumeInfo.complete) {
    console.log('[PARALLEL-TTS] All sentences already complete, proceeding to assembly');
    // Go directly to assembly - pass internalConfig and tempOutputDir for Syncthing compatibility
    return runAssemblyOnly(jobId, internalConfig, resumeInfo.sessionId!, tempOutputDir);
  }

  // Create PrepInfo-like structure from resume info
  const prepInfo: PrepInfo = {
    sessionId: resumeInfo.sessionId!,
    sessionDir: resumeInfo.sessionDir!,
    processDir: resumeInfo.processDir!,
    chaptersDir: path.join(resumeInfo.processDir!, 'chapters'),
    chaptersDirSentences: path.join(resumeInfo.processDir!, 'chapters', 'sentences'),
    totalChapters: resumeInfo.totalChapters!,
    totalSentences: resumeInfo.totalSentences!,
    chapters: (resumeInfo.chapters || []).map(c => ({
      chapterNum: c.chapter_num,
      sentenceCount: c.sentence_count,
      sentenceStart: c.sentence_start,
      sentenceEnd: c.sentence_end
    })),
    metadata: resumeInfo.metadata || {}
  };

  // Re-split missing sentences evenly among all available workers
  // This ensures we always use all workers, regardless of how the missing sentences are distributed
  const missingIndices = resumeInfo.missingIndices || [];
  const totalMissing = missingIndices.length;

  let workers: WorkerState[];

  if (totalMissing === 0) {
    // No missing sentences - shouldn't happen but handle gracefully
    workers = [];
  } else {
    // Split missing indices evenly among workers
    const actualWorkerCount = Math.min(config.workerCount, totalMissing);
    const indicesPerWorker = Math.ceil(totalMissing / actualWorkerCount);

    workers = [];
    for (let workerId = 0; workerId < actualWorkerCount; workerId++) {
      const startIdx = workerId * indicesPerWorker;
      const endIdx = Math.min(startIdx + indicesPerWorker - 1, totalMissing - 1);

      if (startIdx <= endIdx) {
        // Get the actual sentence indices for this worker
        const workerIndices = missingIndices.slice(startIdx, endIdx + 1);
        const sentenceStart = workerIndices[0];
        const sentenceEnd = workerIndices[workerIndices.length - 1];

        workers.push({
          id: workerId,
          process: null,
          sentenceStart,
          sentenceEnd,
          currentSentence: sentenceStart,
          completedSentences: 0,
          status: 'pending' as WorkerStatus,
          retryCount: 0,
          // Store the actual indices this worker should process
          assignedIndices: workerIndices,
          // For resume jobs, totalAssigned is the actual missing sentences (not the range)
          totalAssigned: workerIndices.length
        });
      }
    }
  }

  console.log('[PARALLEL-TTS] Resume: Re-splitting', totalMissing, 'missing sentences among', workers.length, 'workers');
  console.log('[PARALLEL-TTS] Resume workers:', workers.map(w =>
    `${w.id}: sentences ${w.sentenceStart}-${w.sentenceEnd} (${(w as any).assignedIndices?.length || 0} total)`
  ));

  // Create session with resume tracking info
  const session: ConversionSession = {
    jobId,
    config: internalConfig,
    prepInfo,
    workers,
    startTime: Date.now(),
    cancelled: false,
    assemblyProcess: null,
    // Resume job tracking
    isResumeJob: true,
    baselineCompleted: resumeInfo.completedSentences || 0,
    totalMissing: resumeInfo.missingSentences || 0,
    tempOutputDir
  };

  activeSessions.set(jobId, session);

  // Load persistent state from previous runs
  const existingState = await loadPersistentState(prepInfo.processDir);
  if (existingState) {
    session.persistentState = existingState;
    console.log(`[PARALLEL-TTS] Resume: Loaded persistent state - ${existingState.runs.length} previous runs, ${existingState.totalElapsedSeconds}s total elapsed, ${existingState.historicalSentencesPerMinute} sent/min avg`);
  }

  // Start periodic state saving
  startStateSaveTimer(session);
  await savePersistentState(session); // Save initial state for this run

  console.log(`[PARALLEL-TTS] Resume session created: baseline=${session.baselineCompleted}, missing=${session.totalMissing}`);

  // Emit initial progress (accounting for already completed sentences)
  if (mainWindow) {
    const progress: AggregatedProgress = {
      phase: 'converting',
      totalSentences: prepInfo.totalSentences,
      completedSentences: resumeInfo.completedSentences || 0,
      completedInSession: 0, // Starting resume, 0 new conversions yet
      percentage: resumeInfo.progressPercent || 0,
      activeWorkers: 0,
      workers,
      estimatedRemaining: 0,
      message: `Resuming - ${resumeInfo.completedSentences} sentences already complete...`
    };
    mainWindow.webContents.send('parallel-tts:progress', { jobId, progress });

    // Emit session-created event so frontend can update BFP with session info
    mainWindow.webContents.send('parallel-tts:session-created', {
      jobId,
      sessionId: prepInfo.sessionId,
      sessionDir: prepInfo.sessionDir,
      processDir: prepInfo.processDir,
      totalSentences: prepInfo.totalSentences,
      totalChapters: prepInfo.totalChapters
    });
  }

  // Start workers for missing ranges - stagger on Windows to avoid conda temp file race condition
  const isWindows = process.platform === 'win32';
  const WINDOWS_WORKER_STAGGER_MS = 2000; // 2 seconds between worker starts on Windows

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];
    const range: WorkerRange = { sentenceStart: worker.sentenceStart, sentenceEnd: worker.sentenceEnd };

    if (isWindows && i > 0) {
      // Stagger worker starts on Windows to avoid conda temp file conflicts
      await new Promise(resolve => setTimeout(resolve, WINDOWS_WORKER_STAGGER_MS));
    }
    startWorker(session, i, range);
  }

  // Return immediately - completion is handled via events
  return new Promise((resolve) => {
    const checkComplete = setInterval(() => {
      if (!activeSessions.has(jobId)) {
        clearInterval(checkComplete);
        resolve({ success: true });
      }
    }, 1000);
  });
}

/**
 * Run assembly only (when all sentences are already complete)
 */
async function runAssemblyOnly(
  jobId: string,
  config: ParallelConversionConfig,
  sessionId: string,
  tempOutputDir?: string
): Promise<ParallelConversionResult> {
  console.log(`[PARALLEL-TTS] Running assembly only for session ${sessionId}`);

  // Create a session with minimal prepInfo (just need sessionId for assembly)
  const minimalPrepInfo: PrepInfo = {
    sessionId,
    sessionDir: '',  // Not needed for assembly
    processDir: '',
    chaptersDir: '',
    chaptersDirSentences: '',
    totalChapters: 0,
    totalSentences: 0,
    chapters: [],
    metadata: {}
  };

  const session: ConversionSession = {
    jobId,
    config,
    prepInfo: minimalPrepInfo,
    workers: [],
    startTime: Date.now(),
    cancelled: false,
    assemblyProcess: null,
    tempOutputDir
  };

  activeSessions.set(jobId, session);

  // Emit assembling progress
  if (mainWindow) {
    const progress: AggregatedProgress = {
      phase: 'assembling',
      totalSentences: 0,
      completedSentences: 0,
      completedInSession: 0, // Assembly only, no TTS work in this session
      percentage: 100,
      activeWorkers: 0,
      workers: [],
      estimatedRemaining: 0,
      message: 'All sentences complete, assembling audiobook...'
    };
    mainWindow.webContents.send('parallel-tts:progress', { jobId, progress });
  }

  try {
    // Run assembly - runAssembly uses session.prepInfo.sessionId
    const outputPath = await runAssembly(session);

    activeSessions.delete(jobId);

    // Emit complete
    if (mainWindow) {
      mainWindow.webContents.send('parallel-tts:complete', {
        jobId,
        success: true,
        outputPath,
        duration: (Date.now() - session.startTime) / 1000
      });
    }

    stopPowerBlock();
    return { success: true, outputPath };
  } catch (err) {
    activeSessions.delete(jobId);
    const error = `Assembly failed: ${err}`;
    console.error('[PARALLEL-TTS]', error);

    // Emit error
    if (mainWindow) {
      mainWindow.webContents.send('parallel-tts:complete', {
        jobId,
        success: false,
        error
      });
    }

    stopPowerBlock();
    return { success: false, error };
  }
}

/**
 * Build TtsResumeInfo from PrepInfo for saving to job
 */
export function buildResumeInfo(prepInfo: PrepInfo, settings: ParallelTtsSettings): {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  totalSentences: number;
  totalChapters: number;
  chapters: Array<{
    chapter_num: number;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>;
  language: string;
  voice?: string;
  ttsEngine?: string;
  createdAt: string;
} {
  return {
    sessionId: prepInfo.sessionId,
    sessionDir: prepInfo.sessionDir,
    processDir: prepInfo.processDir,
    totalSentences: prepInfo.totalSentences,
    totalChapters: prepInfo.totalChapters,
    chapters: prepInfo.chapters.map(c => ({
      chapter_num: c.chapterNum,
      sentence_start: c.sentenceStart,
      sentence_end: c.sentenceEnd,
      sentence_count: c.sentenceCount
    })),
    language: settings.language,
    voice: settings.fineTuned,
    ttsEngine: settings.ttsEngine,
    createdAt: new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const parallelTtsBridge = {
  setE2aPath,
  getE2aPath,
  setUseLightweightWorker,
  getUseLightweightWorker,
  setMainWindow,
  initializeLogger,
  detectRecommendedWorkerCount,
  prepareSession,
  startParallelConversion,
  stopParallelConversion,
  getConversionProgress,
  isConversionActive,
  listActiveSessions,
  // Resume support
  checkResumeStatus,
  checkResumeStatusFast,
  checkResumeStatusFromProcessDir,
  listResumableSessions,
  resumeParallelConversion,
  buildResumeInfo,
  // Temp folder management
  getTempOutputDir,
  cleanupStaleTempFolders
};

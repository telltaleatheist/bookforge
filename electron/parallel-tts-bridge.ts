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

import { spawn, ChildProcess, execSync, exec, spawnSync } from 'child_process';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as logger from './audiobook-logger';
import { getTTSLogger } from './rolling-logger';

// Cap stderr buffers to prevent OOM on large books (e.g. 7983 sentences producing
// megabytes of FFmpeg output). Only the tail is needed for error diagnostics.
const MAX_STDERR_BYTES = 10 * 1024; // 10 KB
// Smaller per-worker cap for stderr tails surfaced in error messages — keeps
// per-progress-event payloads small and the UI message readable.
const MAX_WORKER_STDERR_TAIL_BYTES = 2 * 1024; // 2 KB
function appendCapped(buf: string, chunk: string, maxBytes: number = MAX_STDERR_BYTES): string {
  buf += chunk;
  if (buf.length > maxBytes) {
    buf = buf.slice(-maxBytes);
  }
  return buf;
}

// Worker log file for debugging - captures ALL worker output
let workerLogPath: string | null = null;
let workerLogStream: fsSync.WriteStream | null = null;

function initWorkerLog(libraryPath: string): void {
  if (!workerLogStream) {
    let logsDir: string;
    const platform = os.platform();
    if (platform === 'darwin') {
      logsDir = path.join(os.homedir(), 'Library', 'Logs', 'BookForge');
    } else if (platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      logsDir = path.join(appData, 'BookForge', 'logs');
    } else {
      logsDir = path.join(os.homedir(), '.local', 'share', 'BookForge', 'logs');
    }
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
import { getMetadataToolPath, applyMetadata, AudiobookMetadata, embedAndVerifyVtt, deleteSidecarsForM4b } from './metadata-tools';
import * as manifestService from './manifest-service';
import { isCudaTtsInstalled } from './components/cuda-tts';
import { enhanceSentences, rvcEnhancementReady } from './rvc-bridge';
import { getRvcVoiceById } from './rvc-models';
import { defaultOrpheusBatchSize } from './orpheus-batch';
import { orpheusMemoryProfile, resolveConcreteOrpheusTier, fitOrpheusTier, orpheusTierLabel, getOrpheusMemoryTier, noteOrpheusOom, type ConcreteOrpheusTier } from './orpheus-memory';

/**
 * Map a UI device ('auto'|'gpu'|'mps'|'cpu') to e2a's CLI device (CUDA/MPS/CPU).
 *
 * 'auto' is the explicit default and resolves TRANSPARENTLY to the best device
 * present — CUDA when the GPU pack (cuda-tts) is installed, Metal (MPS) on Apple
 * Silicon, otherwise CPU. This is a stated "auto" choice the UI surfaces, NOT a
 * hidden upgrade. An explicit 'cpu' / 'gpu' / 'mps' choice is honored EXACTLY as
 * set — no silent override (a user who picks CPU gets CPU). When an explicit
 * 'gpu' can't actually run (no GPU pack), the job fails loudly with guidance via
 * {@link assertDeviceUsable} rather than quietly downgrading.
 */
function resolveTtsDeviceArg(uiDevice: string, engine?: string): string {
  if (uiDevice === 'auto') {
    // Orpheus brings its OWN CUDA runtime (WSL's orpheus_tts conda env on Windows),
    // independent of the native "Faster Voice Narration" pack that isCudaTtsInstalled()
    // tracks. So Orpheus-via-WSL runs on the GPU even when that native pack is absent.
    // Resolve to CUDA in that case so the GPU arbiter LOCKS + VRAM-sizes the job (see
    // acquireGpuForJob) instead of treating it as CPU — the CPU misclassification is
    // what skipped computeSafeGpuUtil and let vLLM reserve 0.70×total and OOM-crash.
    if (engine === 'orpheus' && process.platform === 'win32' && shouldUseWsl2ForOrpheus()) return 'CUDA';
    if (isCudaTtsInstalled()) return 'CUDA';
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'MPS';
    return 'CPU';
  }
  return ({ gpu: 'CUDA', mps: 'MPS', cpu: 'CPU' } as Record<string, string>)[uiDevice]
    || uiDevice.toUpperCase();
}

/**
 * Guard against an unrunnable device choice BEFORE spawning workers, so the user
 * gets a clear reason instead of a deep torch/CUDA crash or a silent CPU
 * downgrade. Only an EXPLICIT 'gpu' without the GPU pack is unrunnable — 'auto'
 * already resolves to CPU when no pack is present, and 'mps'/'cpu' are always
 * available on their platforms.
 */
function assertDeviceUsable(uiDevice: string, resolved: string): void {
  if (uiDevice === 'gpu' && resolved === 'CUDA' && !isCudaTtsInstalled()) {
    throw new Error(
      'GPU (CUDA) is selected but the "Faster Voice Narration" GPU pack is not installed, ' +
      'so PyTorch has no CUDA support. Install it in Settings → Add-ons, or switch the ' +
      'processing device to CPU (or Auto) in Settings → Pipeline Defaults.'
    );
  }
}
import { ensureCustomVoiceStaged, isCustomVoiceId } from './custom-voices';
import { resolveOrpheusModel } from './orpheus-models';
import { acquireGpu, releaseGpu, waitForFreeVram, getGpuMemMB, gpuOwnerForTts, gpuHolder, GPU_OWNER_LLAMA, computeSafeGpuUtil, ORPHEUS_MIN_VRAM_MB, DESKTOP_VRAM_MARGIN_MB, unloadOllamaModels } from './gpu-arbiter';
import { destroyWslGuestProcesses, wslPkillGraceful, waitForGuestExit, isWslWedged, wslWedgedMessage, isWslAliveCached, type WslPkillOutcome } from './wsl-lifecycle';

/**
 * Append the voice/fine-tune CLI args for the selected voice. Centralizes the
 * three cases so prep, the lightweight worker, and the app.py worker stay in sync:
 *
 *  1. Folder-discovered custom Orpheus model → --orpheus_model_dir + the folder's
 *     voice token (orpheus.py points every backend at the dir and skips the
 *     built-in allowlist that otherwise drops it to leah).
 *  2. User-added XTTS custom voice → pre-stage its checkpoint, pass --custom_model*.
 *  3. Catalog fine-tune / built-in voice → pass --fine_tuned verbatim.
 */
// Mirrors VALID_VOICES in the fork's orpheus.py (and ORPHEUS_VOICES in
// orpheus-worker-pool.ts) — the only ids allowed through as a bare --fine_tuned.
const ORPHEUS_STOCK_VOICES = ['leah', 'tara', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'];

function pushVoiceArgs(args: string[], settings: ParallelTtsSettings): void {
  if (settings.ttsEngine === 'orpheus') {
    // Explicit --model-dir (CLI) wins over registry resolution: point the backend at
    // this dir and use fineTuned as the voice token (orpheus.py skips the built-in
    // allowlist when --orpheus_model_dir is set, so the token isn't dropped to leah).
    if (settings.orpheusModelDir) {
      args.push('--orpheus_model_dir', settings.orpheusModelDir);
      args.push('--fine_tuned', settings.fineTuned);
      return;
    }
    const model = resolveOrpheusModel(settings.fineTuned);
    if (model) {
      args.push('--orpheus_model_dir', model.dir);
      args.push('--fine_tuned', model.voice);
      return;
    }
    // Unresolvable non-stock voice: a bare --fine_tuned would hit the fork's
    // unknown-voice fallback and render the ENTIRE book in the default voice
    // with only a console warning. Fail the job instead (the streaming path
    // already refuses this case for the same reason).
    const requested = (settings.fineTuned || '').toLowerCase();
    if (requested && !ORPHEUS_STOCK_VOICES.includes(requested)) {
      throw new Error(
        `Orpheus voice "${settings.fineTuned}" is not installed (model folder missing or invalid). ` +
        `Reinstall it from Settings → Orpheus Voices or pick another voice — ` +
        `refusing to silently fall back to the default voice.`
      );
    }
  }
  if (isCustomVoiceId(settings.fineTuned)) {
    const staged = ensureCustomVoiceStaged(settings.fineTuned!);
    if (staged) {
      args.push('--custom_model', staged.customModel);
      args.push('--custom_model_dir', staged.customModelDir);
      args.push('--voice', staged.voicePath);
      args.push('--fine_tuned', 'internal');
      return;
    }
  }
  if (settings.fineTuned) {
    args.push('--fine_tuned', settings.fineTuned);
  }
}

/**
 * Kill a process and all its children (process tree)
 * On Windows, uses taskkill /F /T to force kill the entire tree
 * On Unix, uses process.kill with SIGKILL
 */
function killProcessTree(process: ChildProcess, label: string): void {
  // NOTE: do NOT early-return on process.killed — that flag only means a signal was
  // *sent*, not that the process died. A worker wedged in native MLX/torch code (or
  // uninterruptible I/O on a slow volume) can survive an earlier signal; re-issuing
  // SIGKILL is harmless and necessary to actually reap it.
  if (!process) return;

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
 * @returns Final paths for audio and VTT
 */
export async function copyToFinalDestination(
  tempDir: string,
  bfpPath: string | undefined,
): Promise<{ audioPath: string; vttPath: string | undefined }> {
  console.log('[PARALLEL-TTS] copyToFinalDestination:', { tempDir, bfpPath });

  // Find m4b and vtt files in temp dir
  const files = await fs.readdir(tempDir);
  const m4bFile = files.find(f => f.endsWith('.m4b') && !f.startsWith('._'));
  let vttFile = files.find(f => f.endsWith('.vtt') && !f.startsWith('._'));

  // VTT may have been moved to vtt/ subfolder during rename step
  let vttSubdir = false;
  if (!vttFile) {
    try {
      const vttDir = path.join(tempDir, 'vtt');
      const vttFiles = await fs.readdir(vttDir);
      const found = vttFiles.find(f => f.endsWith('.vtt') && !f.startsWith('._'));
      if (found) {
        vttFile = path.join('vtt', found);
        vttSubdir = true;
      }
    } catch {
      // No vtt subfolder
    }
  }

  if (!m4bFile) {
    throw new Error(`No m4b file found in temp directory: ${tempDir}`);
  }

  const tempM4bPath = path.join(tempDir, m4bFile);
  const tempVttPath = vttFile ? path.join(tempDir, vttFile) : undefined;

  let finalAudioPath: string;
  let finalVttPath: string | undefined;

  // Step 1: Copy to project output/ folder (always, for both books and articles)
  if (bfpPath) {
    // Derive output dir from bfpPath
    // BFP files: .../projects/occult_test.bfp → .../projects/occult_test/output/
    // Project dirs: .../projects/myproject/ → .../projects/myproject/output/
    const bfpAudiobookDir = getAudiobookDirFromBfp(bfpPath);
    await fs.mkdir(bfpAudiobookDir, { recursive: true });

    finalAudioPath = path.join(bfpAudiobookDir, m4bFile);
    await fs.copyFile(tempM4bPath, finalAudioPath);
    console.log(`[PARALLEL-TTS] Copied m4b to project output: ${finalAudioPath}`);

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

  // Step 2: Clean up temp folder
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
 * Get the audiobook output directory for a project.
 */
export function getAudiobookDirFromBfp(bfpPath: string): string {
  return path.join(bfpPath, 'output');
}

/**
 * Cache the full TTS session folder from e2a tmp to BFP for permanent storage.
 * After caching, the original session in e2a tmp is removed.
 *
 * For WSL sessions (paths containing \\wsl$), uses wsl.exe to copy.
 * For native sessions, uses Node.js fs.cp.
 *
 * Layout: {audiobookDir}/session/ebook-{sessionId}/{processHash}/...
 */
export async function cacheSessionToBfp(
  sessionDir: string,
  bfpPath: string
): Promise<{ success: boolean; cachedPath?: string; error?: string }> {
  console.log(`[PARALLEL-TTS] Caching session to BFP`);
  console.log(`[PARALLEL-TTS]   sessionDir: ${sessionDir}`);
  console.log(`[PARALLEL-TTS]   bfpPath: ${bfpPath}`);

  try {
    const audiobookDir = getAudiobookDirFromBfp(bfpPath);
    const sessionFolderName = path.basename(sessionDir); // e.g. "ebook-{id}"
    const sessionParent = path.join(audiobookDir, 'session');
    const destDir = path.join(sessionParent, sessionFolderName);
    // Write to a temp name first, then atomically rename into place.
    // This prevents Syncthing from seeing a partially-written session folder.
    const tempDestDir = path.join(sessionParent, `.tmp-${sessionFolderName}`);

    await fs.mkdir(sessionParent, { recursive: true });

    // Clean up any leftover temp dir from a previous failed attempt
    try { await fs.rm(tempDestDir, { recursive: true, force: true }); } catch { /* may not exist */ }

    // Determine if the session is in WSL filesystem (handles \\wsl$\ and \\wsl.localhost\)
    const isWslSession = isWslUncPath(sessionDir);

    if (isWslSession && process.platform === 'win32') {
      // WSL session: use wsl.exe to copy within WSL filesystem to /mnt/ destination
      const wslSourcePath = uncToWslPath(sessionDir);
      const wslTempDestPath = windowsToWslPath(tempDestDir);

      // Ensure parent exists in WSL
      const wslDestParent = windowsToWslPath(sessionParent);
      const mkdirCmd = `mkdir -p ${shellQuote(wslDestParent)}`;
      const copyCmd = `cp -r ${shellQuote(wslSourcePath)} ${shellQuote(wslTempDestPath)}`;
      const distro = getWslDistro();
      const wslArgs = distro
        ? ['-d', distro, 'bash', '-c', `${mkdirCmd} && ${copyCmd}`]
        : ['bash', '-c', `${mkdirCmd} && ${copyCmd}`];

      console.log(`[PARALLEL-TTS] WSL copy: wsl.exe ${wslArgs.join(' ')}`);

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('wsl.exe', wslArgs, { shell: false });
        let stderr = '';
        proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`WSL copy failed (code ${code}): ${stderr}`));
        });
        proc.on('error', reject);
      });
    } else {
      // Native session: use Node.js recursive copy
      await fs.cp(sessionDir, tempDestDir, { recursive: true });
    }

    // Atomic swap: remove old session(s), rename temp into place.
    // Only one session should exist per BFP audiobook folder.
    try {
      const existingEntries = await fs.readdir(sessionParent, { withFileTypes: true });
      for (const entry of existingEntries) {
        if (entry.isDirectory() && entry.name.startsWith('ebook-')) {
          const oldDir = path.join(sessionParent, entry.name);
          await fs.rm(oldDir, { recursive: true, force: true });
          console.log(`[PARALLEL-TTS] Removed old session: ${entry.name}`);
        }
      }
    } catch (err) {
      console.error('[PARALLEL-TTS] Failed to clean old sessions (non-fatal):', err);
    }

    // Rename temp dir to final name (atomic on same filesystem)
    await fs.rename(tempDestDir, destDir);
    console.log(`[PARALLEL-TTS] Session cached to: ${destDir}`);

    // Rewrite session-state.json paths to point to the cached location.
    // The original paths reference the e2a tmp dir (possibly on another OS/WSL).
    await rewriteSessionStatePaths(destDir);

    // Remove original from e2a tmp
    try {
      if (isWslSession && process.platform === 'win32') {
        const wslSourcePath = uncToWslPath(sessionDir);
        const distro = getWslDistro();
        const rmArgs = distro
          ? ['-d', distro, 'bash', '-c', `rm -rf "${wslSourcePath}"`]
          : ['bash', '-c', `rm -rf "${wslSourcePath}"`];
        await new Promise<void>((resolve) => {
          const proc = spawn('wsl.exe', rmArgs, { shell: false });
          proc.on('close', () => resolve());
          proc.on('error', () => resolve()); // Don't fail if cleanup fails
        });
      } else {
        await fs.rm(sessionDir, { recursive: true, force: true });
      }
      console.log(`[PARALLEL-TTS] Removed original session from e2a tmp`);
    } catch (err) {
      console.error('[PARALLEL-TTS] Failed to remove original session (non-fatal):', err);
    }

    return { success: true, cachedPath: destDir };
  } catch (err) {
    const error = `Failed to cache session to BFP: ${err}`;
    console.error(`[PARALLEL-TTS] ${error}`);
    return { success: false, error };
  }
}

/**
 * Cache TTS session to an LL project directory, keyed by language.
 * Unlike cacheSessionToBfp, this supports multiple sessions (one per language)
 * and does NOT delete the original (the chaining handler still needs it).
 *
 * Destination: ${projectDir}/stages/03-tts/sessions/${language}/ebook-{uuid}/
 * Returns the cached sentences path for use in assembly chaining.
 */
export async function cacheSessionToProject(
  sessionDir: string,
  projectDir: string,
  language: string
): Promise<{ success: boolean; cachedSentencesDir?: string; error?: string }> {
  console.log(`[PARALLEL-TTS] Caching LL session to project`);
  console.log(`[PARALLEL-TTS]   sessionDir: ${sessionDir}`);
  console.log(`[PARALLEL-TTS]   projectDir: ${projectDir}`);
  console.log(`[PARALLEL-TTS]   language: ${language}`);

  try {
    const sessionFolderName = path.basename(sessionDir); // e.g. "ebook-{id}"
    const langSessionParent = path.join(projectDir, 'stages', '03-tts', 'sessions', language);
    const destDir = path.join(langSessionParent, sessionFolderName);
    const tempDestDir = path.join(langSessionParent, `.tmp-${sessionFolderName}`);

    // Idempotency: if the destination already has a valid cached session, return early.
    // This prevents a second call from deleting the just-cached session and failing mid-copy.
    try {
      await fs.access(destDir);
      // destDir exists — check if it contains a valid session (chapters/sentences/ somewhere)
      let existingSentencesDir: string | null = null;
      const directSentences = path.join(destDir, 'chapters', 'sentences');
      try {
        await fs.access(directSentences);
        existingSentencesDir = directSentences;
      } catch {
        // Check hash subdir: ebook-{uuid}/{hash}/chapters/sentences/
        const entries = await fs.readdir(destDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const hashSentences = path.join(destDir, entry.name, 'chapters', 'sentences');
            try {
              await fs.access(hashSentences);
              existingSentencesDir = hashSentences;
              break;
            } catch { /* not this subdir */ }
          }
        }
      }
      if (existingSentencesDir) {
        console.log(`[PARALLEL-TTS] Session already cached at ${destDir}, skipping re-copy`);
        return { success: true, cachedSentencesDir: existingSentencesDir };
      }
    } catch { /* destDir doesn't exist — proceed with caching */ }

    await fs.mkdir(langSessionParent, { recursive: true });

    // Clean up any leftover temp dir from a previous failed attempt
    try { await fs.rm(tempDestDir, { recursive: true, force: true }); } catch { /* may not exist */ }

    // Remove old session for this language only (keeps other languages intact)
    try {
      const existingEntries = await fs.readdir(langSessionParent, { withFileTypes: true });
      for (const entry of existingEntries) {
        if (entry.isDirectory() && entry.name.startsWith('ebook-')) {
          const oldDir = path.join(langSessionParent, entry.name);
          // Never delete the directory we are about to copy FROM. A resume job's
          // session lives in this cache already (source == destination); if the
          // idempotency check above ever misses it, deleting oldDir here would
          // destroy the source mid-cache.
          if (path.resolve(oldDir).toLowerCase() === path.resolve(sessionDir).toLowerCase()) {
            continue;
          }
          await fs.rm(oldDir, { recursive: true, force: true });
          console.log(`[PARALLEL-TTS] Removed old ${language} session: ${entry.name}`);
        }
      }
    } catch (err) {
      console.error('[PARALLEL-TTS] Failed to clean old sessions (non-fatal):', err);
    }

    // Determine if the session is in WSL filesystem (handles \\wsl$\ and \\wsl.localhost\)
    const isWslSession = isWslUncPath(sessionDir);

    if (isWslSession && process.platform === 'win32') {
      const wslSourcePath = uncToWslPath(sessionDir);
      const wslTempDestPath = windowsToWslPath(tempDestDir);
      const wslDestParent = windowsToWslPath(langSessionParent);
      const mkdirCmd = `mkdir -p ${shellQuote(wslDestParent)}`;
      const copyCmd = `cp -r ${shellQuote(wslSourcePath)} ${shellQuote(wslTempDestPath)}`;
      const distro = getWslDistro();
      const wslArgs = distro
        ? ['-d', distro, 'bash', '-c', `${mkdirCmd} && ${copyCmd}`]
        : ['bash', '-c', `${mkdirCmd} && ${copyCmd}`];

      console.log(`[PARALLEL-TTS] WSL copy: wsl.exe ${wslArgs.join(' ')}`);

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('wsl.exe', wslArgs, { shell: false });
        let stderr = '';
        proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`WSL copy failed (code ${code}): ${stderr}`));
        });
        proc.on('error', reject);
      });
    } else {
      // Clone-on-write where the filesystem supports it (APFS/ReFS) — with the
      // scratch dir on the library volume this is near-instant regardless of
      // session size. Falls back to a regular copy automatically elsewhere.
      await fs.cp(sessionDir, tempDestDir, {
        recursive: true,
        mode: fsSync.constants.COPYFILE_FICLONE,
      });
    }

    // Rename temp dir to final name
    await fs.rename(tempDestDir, destDir);

    // Find the sentences directory within the cached session.
    // e2a structure: ebook-{uuid}/{hash}/chapters/sentences/
    let cachedSentencesDir = destDir;

    // Check direct path first: ebook-{uuid}/chapters/sentences/
    const directSentences = path.join(destDir, 'chapters', 'sentences');
    try {
      await fs.access(directSentences);
      cachedSentencesDir = directSentences;
    } catch {
      // Check for hash subdirectory: ebook-{uuid}/{hash}/chapters/sentences/
      try {
        const entries = await fs.readdir(destDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const hashSentences = path.join(destDir, entry.name, 'chapters', 'sentences');
            try {
              await fs.access(hashSentences);
              cachedSentencesDir = hashSentences;
              break;
            } catch { /* not this subdir */ }
          }
        }
      } catch { /* readdir failed */ }
    }

    // Rewrite session-state.json paths to point to the cached location.
    await rewriteSessionStatePaths(destDir);

    console.log(`[PARALLEL-TTS] LL session cached: ${destDir}`);
    console.log(`[PARALLEL-TTS] Cached sentences dir: ${cachedSentencesDir}`);

    return { success: true, cachedSentencesDir };
  } catch (err) {
    const error = `Failed to cache LL session to project: ${err}`;
    console.error(`[PARALLEL-TTS] ${error}`);
    return { success: false, error };
  }
}

/**
 * Remove a scratch TTS session directory after it has been cached into the
 * project AND assembled into the final audiobook — at which point the scratch
 * copy is a redundant duplicate (a full copy, not a CoW clone, on an ExFAT
 * library volume). Handles native paths and WSL UNC paths (Orpheus on Windows).
 * Best-effort: logs but never throws, so a failed cleanup can't fail the job —
 * the stale-session sweep at startup is the backstop.
 */
async function removeScratchSession(sessionDir: string): Promise<void> {
  // Hard safety: a resume job's prepInfo.sessionDir IS the durable project cache
  // (workers write into it directly), and normalizeWslSessionToWindows repoints a
  // fresh Orpheus run's prepInfo at the cache copy. Deleting that path would
  // destroy the only durable copy of the rendered sentences — refuse, whatever
  // the caller believes it is passing.
  if (/[\\/]stages[\\/]03-tts[\\/]sessions[\\/]/i.test(sessionDir)) {
    console.log(`[PARALLEL-TTS] Session lives in the project cache — keeping it: ${sessionDir}`);
    return;
  }
  try {
    if (isWslUncPath(sessionDir) && process.platform === 'win32') {
      const wslSourcePath = uncToWslPath(sessionDir);
      const distro = getWslDistro();
      const rmArgs = distro
        ? ['-d', distro, 'bash', '-c', `rm -rf "${wslSourcePath}"`]
        : ['bash', '-c', `rm -rf "${wslSourcePath}"`];
      await new Promise<void>((resolve) => {
        const proc = spawn('wsl.exe', rmArgs, { shell: false });
        proc.on('close', () => resolve());
        proc.on('error', () => resolve());
      });
    } else {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
    console.log(`[PARALLEL-TTS] Removed scratch session after assembly: ${sessionDir}`);
  } catch (err) {
    console.error('[PARALLEL-TTS] Failed to remove scratch session (non-fatal):', err);
  }
}

/**
 * Rewrite absolute paths in session-state.json to match the current cached location.
 * e2a writes paths that reference the original tmp dir (e.g., /home/user/.../tmp/ebook-xxx/hash/).
 * When the session is cached to a project folder (and synced across Mac/Windows/WSL via Syncthing),
 * those paths become stale. This rewrites them to the actual on-disk location.
 *
 * @param sessionDir - The ebook-{uuid} directory (may contain a hash subdirectory)
 */
async function rewriteSessionStatePaths(sessionDir: string): Promise<void> {
  // Find processDir: either sessionDir itself or a hash subdirectory
  let processDir = sessionDir;
  const directState = path.join(sessionDir, 'session-state.json');
  try {
    await fs.access(directState);
  } catch {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('ebook-')) {
        const candidatePath = path.join(sessionDir, entry.name, 'session-state.json');
        try {
          await fs.access(candidatePath);
          processDir = path.join(sessionDir, entry.name);
          break;
        } catch { /* not this subdir */ }
      }
    }
  }

  const statePath = path.join(processDir, 'session-state.json');
  const stateContent = await fs.readFile(statePath, 'utf-8');
  const state = JSON.parse(stateContent);

  state.chapters_dir_sentences = path.join(processDir, 'chapters', 'sentences');
  state.chapters_dir = path.join(processDir, 'chapters');
  if (state.epub_path) {
    state.epub_path = path.join(processDir, path.basename(state.epub_path));
  }

  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  console.log(`[PARALLEL-TTS] Rewrote session-state.json paths → ${processDir}`);
}

/**
 * Scan an LL project's stages/03-tts/sessions/ directory for cached TTS sessions.
 * Returns one entry per language with sentence count and sentences path.
 */
export async function scanProjectSessions(
  projectDir: string
): Promise<{ language: string; sessionDir: string; sentencesDir: string; sentenceCount: number; createdAt: string }[]> {
  const sessionsRoot = path.join(projectDir, 'stages', '03-tts', 'sessions');
  const results: { language: string; sessionDir: string; sentencesDir: string; sentenceCount: number; createdAt: string }[] = [];

  try {
    await fs.access(sessionsRoot);
  } catch {
    return results; // No sessions directory
  }

  try {
    const langEntries = await fs.readdir(sessionsRoot, { withFileTypes: true });
    for (const langEntry of langEntries) {
      if (!langEntry.isDirectory()) continue;
      const language = langEntry.name;
      const langDir = path.join(sessionsRoot, language);

      // Find ebook-{uuid} directory
      const sessionEntries = await fs.readdir(langDir, { withFileTypes: true });
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory() || !sessionEntry.name.startsWith('ebook-')) continue;
        const sessionDir = path.join(langDir, sessionEntry.name);

        // Find sentences: direct or via hash subdirectory
        let sentencesDir = '';

        // Check direct: ebook-{uuid}/chapters/sentences/
        const directPath = path.join(sessionDir, 'chapters', 'sentences');
        try {
          await fs.access(directPath);
          sentencesDir = directPath;
        } catch {
          // Check hash subdir: ebook-{uuid}/{hash}/chapters/sentences/
          try {
            const subEntries = await fs.readdir(sessionDir, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.isDirectory() && !sub.name.startsWith('.') && !sub.name.startsWith('ebook-')) {
                const hashPath = path.join(sessionDir, sub.name, 'chapters', 'sentences');
                try {
                  await fs.access(hashPath);
                  sentencesDir = hashPath;
                  break;
                } catch { /* not this one */ }
              }
            }
          } catch { /* readdir failed */ }
        }

        if (!sentencesDir) continue;

        // Count sentence files
        let sentenceCount = 0;
        try {
          const files = await fs.readdir(sentencesDir);
          sentenceCount = files.filter(f => f.endsWith('.flac') || f.endsWith('.wav')).length;
        } catch { /* count failed */ }

        // Get creation time from the session dir
        let createdAt = new Date().toISOString();
        try {
          const stat = await fs.stat(sessionDir);
          createdAt = stat.mtime.toISOString();
        } catch { /* stat failed */ }

        results.push({ language, sessionDir, sentencesDir, sentenceCount, createdAt });
        break; // Only one session per language
      }
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Error scanning project sessions:', err);
  }

  return results;
}

/**
 * Post-process output after e2a writes directly to the BFP audiobook folder.
 * Renames VTT to standard name.
 */
async function postProcessOutput(
  outputDir: string,
): Promise<{ audioPath: string; vttPath?: string }> {
  const files = await fs.readdir(outputDir);
  const m4bFile = files.find(f => f.endsWith('.m4b') && !f.startsWith('._'));
  let vttFile = files.find(f => f.endsWith('.vtt') && !f.startsWith('._'));

  // VTT may be in vtt/ subfolder
  if (!vttFile) {
    try {
      const vttDir = path.join(outputDir, 'vtt');
      const vttFiles = await fs.readdir(vttDir);
      const found = vttFiles.find(f => f.endsWith('.vtt') && !f.startsWith('._'));
      if (found) {
        // Move from subfolder to output dir
        await fs.rename(path.join(vttDir, found), path.join(outputDir, 'subtitles.vtt'));
        vttFile = 'subtitles.vtt';
      }
    } catch {
      // No vtt subfolder
    }
  }

  // Rename VTT to standard name
  if (vttFile && vttFile !== 'subtitles.vtt') {
    await fs.rename(path.join(outputDir, vttFile), path.join(outputDir, 'subtitles.vtt'));
    vttFile = 'subtitles.vtt';
  }

  return {
    audioPath: m4bFile ? path.join(outputDir, m4bFile) : path.join(outputDir, 'audiobook.m4b'),
    vttPath: vttFile ? path.join(outputDir, vttFile) : undefined
  };
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
 * Check if a path is a WSL UNC path (\\wsl$\... or \\wsl.localhost\...)
 */
function isWslUncPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return /^\/\/wsl[\$.](?:localhost)?\//.test(normalized);
}

/**
 * Convert UNC WSL paths (\\wsl$\<distro>\...) back to native WSL paths (/...).
 * Also handles Windows drive paths by converting via windowsToWslPath.
 * Matches any distro name and both \\wsl$ and \\wsl.localhost forms.
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
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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

  // Map a Windows path that lives UNDER the e2a install (app.py, worker.py, the
  // staged session/tmp tree, etc.) onto the WSL-native e2a at wslE2aPath. This is
  // critical: BookForge's e2a root varies (dev: ...\ebook2audiobook ; packaged:
  // <userData>\runtime\e2a), and only the dev path contains the literal
  // "ebook2audiobook". Without a root-prefix rewrite the packaged build ran e2a
  // from /mnt/c (the bundled copy) and wrote sessions to the Windows tmp, while
  // BookForge read the \\wsl$ WSL-native tmp → "no usable session". Matching the
  // real root makes e2a run WSL-native and write where BookForge reads, and keeps
  // Python off the slow /mnt 9p mount (avoids multiprocessing issues).
  const winE2aRootNorm = getDefaultE2aPath().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const rewriteUnderE2aRoot = (p: string): string | null => {
    const norm = p.replace(/\\/g, '/');
    if (norm.toLowerCase().startsWith(winE2aRootNorm + '/') || norm.toLowerCase() === winE2aRootNorm) {
      const rel = norm.slice(winE2aRootNorm.length).replace(/^\/+/, '');
      return rel ? `${wslE2aPath}/${rel}` : wslE2aPath;
    }
    // Fallback for any stray path that names the dev repo dir explicitly.
    if (/ebook2audiobook/i.test(norm)) {
      const m = norm.match(/ebook2audiobook\/?(.*)/i);
      return m && m[1] ? `${wslE2aPath}/${m[1]}` : wslE2aPath;
    }
    return null;
  };

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

    // Replace Windows e2a paths (app.py, worker.py, session/tmp tree) with the
    // WSL-native e2a path so e2a runs WSL-native and writes where BookForge reads.
    const e2aRewritten = /^[A-Za-z]:[\\/]/.test(arg) ? rewriteUnderE2aRoot(arg) : null;
    if (e2aRewritten) {
      wslArgs.push(e2aRewritten);
    }
    // Convert other Windows paths (epub, output dir) to /mnt/... format
    else if (/^[A-Za-z]:[\\/]/.test(arg)) {
      wslArgs.push(windowsToWslPath(arg));
    }
    // Convert UNC WSL paths (\\wsl$\..., \\wsl.localhost\...) to native WSL paths
    else if (isWslUncPath(arg)) {
      wslArgs.push(uncToWslPath(arg));
    } else {
      wslArgs.push(arg);
    }
  }

  // Build the full command:
  // 1. Export Python env vars so output isn't buffered (critical for subprocess stdout capture)
  // 2. cd to e2a directory
  // 3. Run conda with converted args (shell-quoted to handle spaces/special chars)
  // ORPHEUS_DISABLE_EAGER=1 forces vLLM CUDA graphs ON inside WSL (Linux), where
  // they capture correctly — the whole reason Orpheus routes through WSL. e2a's
  // orpheus.py honors this env var (see lib/classes/tts_engines/orpheus.py).
  // The WSL subshell only sees vars we export here (Windows env does NOT cross into
  // `wsl.exe bash -c`). Forward the per-job Orpheus tuning vars (set in config.env by
  // the worker spawn) so vLLM honors them inside WSL instead of falling back to
  // orpheus.py's defaults — gpu_memory_utilization (VRAM-sized per job) and the batch
  // width. Without this forwarding the worker ignored both.
  const forwardKeys = ['ORPHEUS_GPU_MEM_UTIL', 'ORPHEUS_BATCH_SIZE', 'ORPHEUS_SENTENCE_GAP', 'ORPHEUS_MAX_CHARS'];
  const forwarded = forwardKeys
    .filter((k) => config.env?.[k])
    .map((k) => ` ${k}=${shellQuote(String(config.env![k]))}`)
    .join('');
  const exportCommand = `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 ORPHEUS_DISABLE_EAGER=1${forwarded}`;
  const cdCommand = `cd ${shellQuote(wslE2aPath)}`;
  const quotedArgs = wslArgs.map(a => shellQuote(a)).join(' ');
  const condaCommand = `${shellQuote(wslCondaPath)} ${quotedArgs}`;

  return `${exportCommand} && ${cdCommand} && ${condaCommand}`;
}

/**
 * Spawn a process, routing to WSL if configured for Orpheus
 * On macOS/Linux or non-Orpheus: uses regular spawn
 * On Windows with Orpheus + WSL enabled: spawns via wsl.exe
 */
function spawnWithWslSupport(
  command: string,
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

  // Shell-escape args when using shell: true to handle paths with
  // special characters (e.g., apostrophes in "Aesop's Fables")
  const safeArgs = options.shell ? shellEscapeArgs(args) : args;

  // Regular Windows/Mac/Linux spawn
  return spawn(command, safeArgs, options);
}

/**
 * WSL guest teardown — all the actual signalling/escalation lives in wsl-lifecycle.ts.
 * The rules that keep the VM alive:
 *   - NEVER SIGKILL a guest GPU process (force-killing a process kernel-stuck in a dxg
 *     GPU wait is what wedges the whole WSL VM until a reboot).
 *   - Escalation past SIGTERM is `wsl.exe -t <distro>` — VM terminate releases the GPU
 *     at the hypervisor level and cannot leave a half-dead process behind.
 *   - Kills are SESSION-SCOPED: the old global "ebook2audiobook.*\.py" pattern once
 *     caught a freshly resumed job's worker 7s into vLLM init (the wedge trigger).
 *   - The wsl.exe wrapper on Windows is only taskkilled AFTER the guest process is
 *     confirmed dead (killing the wrapper first severed the in-guest pkill mid-flight).
 */

/** Session-scoped guest kill pattern: matches this job's worker.py/app.py (their argv
 *  contains `--session <id>`), never another session's worker and never the persistent
 *  Listen server (orpheus_stream.py carries no session id). Falls back to the global
 *  e2a pattern only when the session id is missing/unsafe. */
function wslSessionPattern(sessionId: string | undefined | null): string {
  if (sessionId && /^[\w-]+$/.test(sessionId)) return `(worker|app)\\.py.*${sessionId}`;
  return 'ebook2audiobook.*\\.py';
}

/**
 * Tear down ONE session's guest workers: cooperative SIGTERM (worker.py installs a
 * handler and exits itself, releasing the GPU from inside) → verified wait →
 * VM terminate if anything refuses to die. AWAITED by callers so the outcome is real,
 * not fire-and-forget. Default 60s grace: during vLLM init/graph capture Python defers
 * signal delivery until native code returns, which can take tens of seconds.
 */
async function destroyWslSessionWorkers(session: ConversionSession, label: string, graceMs = 60000): Promise<void> {
  await destroyWslGuestProcesses(wslSessionPattern(session.prepInfo?.sessionId), { graceMs, label });
}

/** Close the Windows-side wsl.exe wrapper. Only call AFTER the guest process is
 *  confirmed dead (or the VM terminated) — then it's just closing a pipe host. */
function killWslWrapper(proc: ChildProcess, label: string): void {
  const pid = proc?.pid;
  if (!pid) return;
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
    console.log(`[PARALLEL-TTS] ${label}: closed wsl.exe wrapper (PID ${pid})`);
  } catch {
    // already exited with the guest — the normal case
  }
}

/**
 * App-quit teardown for WSL-hosted e2a workers: cooperative SIGTERM, VERIFIED, then
 * VM terminate for any survivor (never SIGKILL). Called from main.ts before-quit so
 * closing BookForge can never strand a vLLM worker mid-CUDA-work inside the guest.
 * Shorter 10s grace — the user is quitting; a VM cold start next launch is fine.
 */
export async function gracefulWslShutdown(): Promise<WslPkillOutcome> {
  if (process.platform !== 'win32' || !shouldUseWsl2ForOrpheus()) return 'none';
  return destroyWslGuestProcesses('ebook2audiobook.*\\.py', { graceMs: 10000, label: 'app-quit' });
}

/**
 * Safety-net reaper for orphaned BATCH audiobook workers (worker.py / app.py) of a
 * single job. Runs after the tracked-handle kills in stopParallelConversion /
 * killAllWorkers to catch workers whose ChildProcess handle was lost — a retry/resume
 * race, or an earlier signal that didn't take on a wedged (uninterruptible) process —
 * which the handle-based kill can no longer reach.
 *
 * Scoped to the per-job e2a session id (a UUID present ONLY in batch worker argv, as
 * `--session <id>`). The persistent Listen/extension server (orpheus_stream.py, managed
 * by orpheus-worker-pool.ts) carries NO session id, and the match additionally requires
 * worker.py/app.py and explicitly excludes orpheus_stream.py — so the streaming server
 * can never be reaped here. Best-effort and non-fatal.
 */
function reapOrphanedSessionWorkers(sessionId: string | undefined | null): void {
  // Guard: only a clean UUID-ish token may reach the shell (prevents injection and an
  // over-broad match). e2a session ids are [0-9a-f-].
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return;
  try {
    if (os.platform() === 'win32') {
      // Native Windows python workers: match worker.py/app.py + this session id,
      // never orpheus_stream.py.
      try {
        execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | ` +
          `Where-Object { $_.CommandLine -match '${sessionId}' -and ` +
          `($_.CommandLine -match 'worker\\.py' -or $_.CommandLine -match 'app\\.py') -and ` +
          `$_.CommandLine -notmatch 'orpheus_stream\\.py' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
          { stdio: 'ignore', timeout: 8000 }
        );
      } catch { /* none matched */ }
      // WSL-hosted workers are handled by destroyWslSessionWorkers (session-scoped
      // SIGTERM → verify → VM terminate) — NEVER pkill -9 in the guest: force-killing
      // a process kernel-stuck in a dxg GPU wait is what wedges the entire WSL VM.
      return;
    }
    // macOS / Linux: find candidate PIDs by session id, then SIGKILL only those whose
    // command line is a batch worker (worker.py / app.py) and NOT the persistent server.
    let pids: string[] = [];
    try {
      pids = execSync(`pgrep -f ${sessionId}`, { encoding: 'utf8', timeout: 5000 })
        .split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* pgrep exits 1 when nothing matches */ }
    for (const pid of pids) {
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 5000 });
        if (/orpheus_stream\.py/.test(cmd)) continue;     // never the persistent Listen/extension server
        if (!/\b(worker|app)\.py\b/.test(cmd)) continue;  // only batch audiobook workers
        process.kill(Number(pid), 'SIGKILL');
        console.log(`[PARALLEL-TTS] Reaped orphaned worker PID ${pid} (session ${sessionId})`);
      } catch { /* already gone, or not ours */ }
    }
  } catch (err) {
    console.warn('[PARALLEL-TTS] Orphan reap sweep failed (non-fatal):', err);
  }
}

/**
 * Clean up orphaned vLLM/e2a processes in WSL (SIGTERM only — workers exit themselves
 * and release the GPU; anything that refuses SIGTERM is handled by the session
 * teardown ladder, never SIGKILL).
 *
 * SCOPING: pass the calling job's e2a session id whenever one exists. The old global
 * "ebook2audiobook.*\.py" + "vllm" patterns killed OTHER live sessions' workers too —
 * a retry of job A once SIGTERM'd job B's freshly spawned worker. The global sweep is
 * only allowed when no session is active (app-level cleanup / quit).
 */
function cleanupWslOrphanedProcesses(sessionId?: string | null): void {
  if (os.platform() !== 'win32') return;
  if (!shouldUseWsl2ForOrpheus()) return;

  const scoped = !!(sessionId && /^[\w-]+$/.test(sessionId));
  if (!scoped && activeSessions.size > 0) {
    console.warn(`[PARALLEL-TTS] Skipping GLOBAL WSL orphan cleanup — ${activeSessions.size} session(s) still active (a global pkill would hit their workers)`);
    return;
  }

  const pattern = scoped ? wslSessionPattern(sessionId) : 'ebook2audiobook.*\\.py|vllm';
  console.log(`[PARALLEL-TTS] Cleaning up orphaned WSL processes (${scoped ? `session ${sessionId}` : 'global'})...`);
  // Fire-and-forget async SIGTERM: best-effort reap of zombies from a crashed worker.
  // Verification that the guest/VRAM is actually clear happens in the spawn preflight.
  void wslPkillGraceful(pattern, { graceMs: 8000, label: scoped ? `orphan-cleanup ${sessionId}` : 'orphan-cleanup global' })
    .catch((err) => console.warn('[PARALLEL-TTS] WSL orphan cleanup failed:', err));
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
  // EXACT real-sentence count this worker has rendered THIS session — the sum of
  // rawSentenceCounts over the chunk indices it has actually converted. Reset with
  // completedSentences on retry. Optional (only accrues when rawSentenceCounts is known).
  rawCompletedSentences?: number;
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
  // Diagnostics — NOT serialized to the renderer (see serializeWorkers); only
  // appended to worker.error on non-zero exit. Capped at MAX_WORKER_STDERR_TAIL_BYTES.
  stderrTail?: string;         // Tail of non-progress stderr lines for crash diagnosis
  // Timestamp of last HuggingFace model-download activity. Used by the startup
  // watchdog so an actively-downloading worker isn't killed at the startup timeout.
  lastDownloadActivityAt?: number;
}

// Port of bookforge_ext/parallel/session.py `_SENTENCE_END_RE` / `count_real_sentences`.
// A generation chunk packs 2-3 real sentences for Orpheus/Voxtral; count terminal .!?…
// (optionally closed by quotes/brackets) followed by whitespace/end. A chunk with no
// terminal punctuation (heading) still counts as 1. KEEP IN SYNC with the Python regex —
// buildPrepInfo cross-checks the sum against the authoritative total_raw_sentences and
// warns on drift.
function countRealSentences(chunk: string): number {
  if (!chunk) return 1;
  const m = chunk.match(/[.!?…]+["'”’)\]]*(?:\s|$)/g);
  return Math.max(1, m ? m.length : 0);
}

// Flatten chapter_sentences (chapters → chunks) into a per-global-chunk-index real-sentence
// count array, matching the worker's `all_sentences` flatten order (worker_core.py). Lets
// live progress sum EXACT sentences rendered (not chunks × book-average ratio).
function buildRawSentenceCounts(chapterSentences: unknown): number[] {
  if (!Array.isArray(chapterSentences)) return [];
  const out: number[] = [];
  for (const chapter of chapterSentences) {
    if (!Array.isArray(chapter)) continue;
    for (const chunk of chapter) out.push(countRealSentences(typeof chunk === 'string' ? chunk : ''));
  }
  return out;
}

// Add the EXACT real-sentence count of a just-rendered chunk (global 0-based index, from the
// worker's "Converting sentence {i}/{total}" line) to the worker's session tally, when
// per-chunk counts are known. Bounds-guarded so a stray/legacy index never corrupts the sum.
function accrueRawCompleted(session: ConversionSession, worker: WorkerState, chunkIndex: number): void {
  const counts = session.prepInfo?.rawSentenceCounts;
  if (counts && chunkIndex >= 0 && chunkIndex < counts.length) {
    worker.rawCompletedSentences = (worker.rawCompletedSentences || 0) + counts[chunkIndex];
  }
}

export interface PrepInfo {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  chaptersDir: string;
  chaptersDirSentences: string;
  totalChapters: number;
  /** Number of GENERATION CHUNKS (the scheduling unit). For Orpheus/Voxtral a chunk
   *  packs 2-3 real sentences, so this is NOT the real sentence count. */
  totalSentences: number;
  /** Real sentence count across all chunks (for a true sentences/min analytics rate).
   *  Optional: absent on resume/minimal prep builds and old session-state.json files;
   *  readers fall back to totalSentences (chunk count). */
  totalRawSentences?: number;
  /** Per-global-chunk-index real-sentence count (0-based, aligned to the worker's flattened
   *  all_sentences). Lets live progress sum the EXACT sentences rendered so far (not
   *  chunks × book-average ratio) for a precise sentences/min. Absent → readers use the
   *  average-ratio estimate. Derived in the bridge from chapter_sentences. */
  rawSentenceCounts?: number[];
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
  isArticle?: boolean;
  // Optional RVC voice-enhancement pass. When enabled, each rendered TTS sentence
  // is re-rendered through an RVC voice model (warm-model batch) BEFORE assembly,
  // and the enhanced set is assembled via e2a's --sentences_dir. The original XTTS
  // sentences are left cached/untouched so either version can be (re)assembled.
  rvcEnhancement?: {
    enabled: boolean;
    voiceId: string;     // enhancement-voice asset id (resolved to model name in the backend)
    indexRate?: number;  // 0–1; default 0.5
    protectRate?: number; // 0–0.5; default 0.5
    nSemitones?: number; // pitch shift; 0 = none, negative = lower
  };
}

export interface ParallelTtsSettings {
  device: 'auto' | 'gpu' | 'mps' | 'cpu';
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
  // Test mode: only process first N sentences
  testMode?: boolean;
  testSentences?: number;
  // Orpheus: point every backend at an EXPLICIT model directory (the CLI --model-dir),
  // bypassing models.json/folder resolution. fineTuned is used as the voice token.
  orpheusModelDir?: string;
}

export interface AggregatedProgress {
  phase: 'preparing' | 'converting' | 'assembling' | 'enhancing' | 'complete' | 'error';
  /** GENERATION CHUNKS (scheduling unit; a chunk packs 2-3 real sentences for Orpheus/Voxtral). */
  totalSentences: number;
  /** Real sentence count across all chunks — for a true sentences/min analytics rate.
   *  Optional: only the live conversion-progress path populates it. */
  totalRawSentences?: number;
  completedSentences: number;
  completedInSession: number;  // Sentences completed in THIS session (for ETA calculation)
  /** EXACT real sentences rendered THIS session (sum of per-chunk counts over the chunks
   *  actually converted — resume-safe, since skipped/empty chunks never emit progress).
   *  Present only when rawSentenceCounts is known; enables a precise (non-~) sentences/min.
   *  Falls back to the chunk×average estimate on the frontend when absent. */
  rawCompletedInSession?: number;
  percentage: number;
  activeWorkers: number;
  workers: WorkerState[];
  estimatedRemaining: number;
  message?: string;
  error?: string;
  // Orpheus memory level the job resolved to (e.g. 'Light'), for a queue badge.
  orpheusMemoryLevel?: string;
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
  getDefaultE2aTmpPath,
  getPythonInvocation,
  PythonInvocation,
  shouldUseWsl2ForAllTts,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  windowsToWslPath,
  wslPathToWindows,
  wslToWindowsPath,
  shellEscapeArgs,
  buildCondaSpawnEnv,
} from './e2a-paths';

// Helper to resolve the Python invocation - always uses fresh e2aPath from centralized config
// Pass ttsEngine to use the correct environment (orpheus_tts for Orpheus in WSL, python_env for others)
function pythonInvocation(ttsEngine?: string): PythonInvocation {
  return getPythonInvocation(getDefaultE2aPath(), ttsEngine);
}

// DeepSpeed accelerates XTTS's GPT decoder ~1.5x, but it must be installed (with a
// GPU-arch-matched, prebuilt transformer_inference op) in the XTTS env — which it
// is NOT on a stock install (the prebuilt kernel is machine-specific). So we
// auto-enable e2a's XTTS_USE_DEEPSPEED gate ONLY when the package is actually
// present in the resolved XTTS env. Everywhere else the gate stays off and XTTS
// runs exactly as before (e2a's _load_checkpoint also try/excepts the import). The
// check derives the env from the interpreter path, so it's correct wherever the
// env lives; result is cached (the env doesn't change mid-run). win32-only for now
// (the only platform we've built/verified the op on).
// The prebuilt transformer_inference op ships cubins for these compute capabilities
// (+PTX for forward-compat to newer cards). The GPU must be >= the lowest. Keep in
// sync with TORCH_CUDA_ARCH_LIST used to build the shipped op (packaging).
const DEEPSPEED_MIN_CC = 75; // sm_75 (Turing). Built: 7.5;8.0;8.6;8.9;9.0+PTX.

/**
 * Decide whether to auto-enable DeepSpeed for an XTTS render. True only when ALL of:
 *  - Windows + engine is XTTS,
 *  - deepspeed is installed in the resolved XTTS env, AND
 *  - the GPU is actually compatible (CUDA present + compute capability in range).
 * The GPU probe (a one-shot `python -c`) is cached in a marker beside the env and
 * keyed on the deepspeed install's mtime, so it runs once per env build. This is the
 * "only use DeepSpeed if the system is compatible" gate; e2a's _load_checkpoint also
 * falls back to standard XTTS if the op fails at load, as a final safety net.
 */
let _xttsDeepspeedAvail: boolean | null = null;
function xttsDeepspeedAvailable(ttsEngine?: string): boolean {
  if (process.platform !== 'win32') return false;
  if (ttsEngine?.toLowerCase() !== 'xtts') return false;
  if (_xttsDeepspeedAvail !== null) return _xttsDeepspeedAvail;
  _xttsDeepspeedAvail = false;
  try {
    const inv = pythonInvocation('xtts');
    const envRoot = path.dirname(inv.command);
    const dsInit = path.join(envRoot, 'Lib', 'site-packages', 'deepspeed', '__init__.py');
    if (!fsSync.existsSync(dsInit)) {
      console.log(`[PARALLEL-TTS] XTTS DeepSpeed not installed — using standard XTTS (${envRoot})`);
      return false;
    }
    _xttsDeepspeedAvail = probeDeepspeedCompat(inv, envRoot, dsInit);
  } catch (e) {
    console.warn(`[PARALLEL-TTS] DeepSpeed compatibility probe errored; using standard XTTS: ${e instanceof Error ? e.message : String(e)}`);
    _xttsDeepspeedAvail = false;
  }
  return _xttsDeepspeedAvail;
}

/** One-shot GPU compatibility probe for DeepSpeed, cached beside the env. */
function probeDeepspeedCompat(inv: PythonInvocation, envRoot: string, dsInit: string): boolean {
  const marker = path.join(envRoot, '.bookforge-deepspeed-compat.json');
  let dsMtime = '';
  try { dsMtime = String(fsSync.statSync(dsInit).mtimeMs); } catch { /* ignore */ }

  // Reuse a cached verdict for this exact deepspeed install.
  try {
    const cached = JSON.parse(fsSync.readFileSync(marker, 'utf8'));
    if (cached && cached.dsMtime === dsMtime && typeof cached.compatible === 'boolean') {
      console.log(`[PARALLEL-TTS] XTTS DeepSpeed ${cached.compatible ? 'compatible (cached) — auto-enabling' : 'incompatible (cached) — standard XTTS'}: ${cached.detail || ''}`);
      return cached.compatible;
    }
  } catch { /* no/stale marker — probe */ }

  // Probe: CUDA present? deepspeed imports? GPU compute capability in range?
  const py =
    'import sys\n' +
    'try:\n' +
    ' import torch\n' +
    ' if not torch.cuda.is_available():\n' +
    "  print('RESULT NOCUDA'); sys.exit(0)\n" +
    ' import deepspeed  # noqa\n' +
    ' cc = torch.cuda.get_device_capability(0)\n' +
    " print('RESULT CC %d%d %s' % (cc[0], cc[1], torch.cuda.get_device_name(0)))\n" +
    'except Exception as e:\n' +
    " print('RESULT ERR %s' % e)\n";
  const res = spawnSync(inv.command, [...inv.args, '-c', py], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: envRoot,
  });
  const out = `${res.stdout || ''}`;
  const line = out.split('\n').map(s => s.trim()).find(s => s.startsWith('RESULT ')) || 'RESULT ERR no-output';
  const payload = line.slice('RESULT '.length).trim();

  let compatible = false;
  let detail = payload;
  const ccMatch = payload.match(/^CC\s+(\d+)\s*(.*)$/);
  if (ccMatch) {
    const ccNum = parseInt(ccMatch[1], 10);
    compatible = ccNum >= DEEPSPEED_MIN_CC;
    detail = `${ccMatch[2]} cc=${ccMatch[1]}${compatible ? '' : ` (< ${DEEPSPEED_MIN_CC}, unsupported)`}`;
  } else {
    detail = `not compatible: ${payload}`;
  }

  try {
    fsSync.writeFileSync(marker, JSON.stringify({ dsMtime, compatible, detail, ts: new Date().toISOString() }, null, 2));
  } catch { /* best-effort cache */ }

  console.log(`[PARALLEL-TTS] XTTS DeepSpeed ${compatible ? 'compatible — auto-enabling' : 'incompatible — standard XTTS'}: ${detail}`);
  return compatible;
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

/**
 * Indices in [0, totalSentences) that require audio but have no rendered file
 * on disk — the pre-assembly completeness gate's ground truth.
 *
 * Mirrors the worker's own rules so the gate and a later Continue agree:
 * a sentence is rendered iff `{i}.flac` exists (same test as checkResumeFast),
 * and indices whose source text is empty/whitespace are exempt because the
 * worker skips those without ever writing a file (worker_core: `if not
 * sentence or not sentence.strip(): skip`).
 *
 * Throws if the sentences dir (when it should exist) or session-state.json is
 * unreadable — the caller must treat "can't verify" as a failure, not proceed.
 */
async function findMissingSentenceFiles(prepInfo: PrepInfo): Promise<number[]> {
  const sentencesDir = toReadablePath(prepInfo.chaptersDirSentences);
  const present = new Set<number>();
  let files: string[];
  try {
    files = await fs.readdir(sentencesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      files = []; // nothing rendered at all — every non-empty sentence is missing
    } else {
      throw err;
    }
  }
  for (const f of files) {
    const m = /^(\d+)\.flac$/.exec(f);
    if (m) present.add(parseInt(m[1], 10));
  }

  // Flatten chapter_sentences exactly like the worker does, to know which
  // indices legitimately have no file (empty text → worker writes nothing).
  const statePath = path.join(toReadablePath(prepInfo.processDir), 'session-state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));
  if (!Array.isArray(state.chapter_sentences)) {
    throw new Error(`session-state.json has no chapter_sentences: ${statePath}`);
  }
  const allSentences: string[] = state.chapter_sentences.flat();

  const missing: number[] = [];
  for (let i = 0; i < prepInfo.totalSentences; i++) {
    if (present.has(i)) continue;
    const text = allSentences[i];
    if (!text || !text.trim()) continue; // worker skips empties without a file
    missing.push(i);
  }
  return missing;
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
// Prep watchdog — kill prep if it emits no output for this long (likely a hung
// model download). Generous because first-run downloads can legitimately stall briefly.
const PREP_STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes of silence = stalled

// Model-loading activity (download OR cache load): lines like
//   "Fetching 17 files: 100%|..."  /  "Loading safetensors checkpoint shards..."  /
//   "model.safetensors: 34%|..."  /  "huggingface ...". Matching ANY of these keeps the
// watchdog from killing a slow-but-alive worker while it loads the model.
const MODEL_ACTIVITY_RE = /downloading|\.safetensors|\.bin(?:\s|:|$)|huggingface|fetching \d+ files/i;
// A worker mid-GENERATION is alive even when no sentence has completed for a while: a
// batch of chunks (several hitting the slow ~35s token-cap re-render) can generate for
// minutes between "Converting sentence" lines. Counting these as a watchdog heartbeat —
// exactly as MODEL_ACTIVITY_RE does for model loading — stops the hang-detector from
// TERMing a working worker mid-batch (the false-kill that broke long-book renders).
const GENERATION_ACTIVITY_RE = /audio-token cap|re-rendering split|Processed prompts|Adding requests/i;
// GENUINE network download only — NOT a cache hit or disk load. huggingface_hub's tqdm
// shows a byte-rate ("124MB/s") only while actually transferring bytes; a cache hit shows
// "it/s" and shard-loading from disk shows "s/it". So require a byte-rate (or the explicit
// "Downloading" verb) before telling the user it's downloading — otherwise the note fired
// on every cached run (e.g. vLLM's "Loading safetensors checkpoint shards"), which looked
// like a re-download that wasn't happening.
const MODEL_DOWNLOAD_RE = /\bdownloading\b|\b\d+(?:\.\d+)?\s?[KMG]?B\/s\b/i;
const MODEL_DOWNLOAD_NOTE = 'Downloading TTS model (first run — this can take a while)…';

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

// Mirrors src/app/core/models/analytics.types.ts RvcJobAnalytics. The main
// process defines its own copy (electron tsconfig doesn't compile src/), same
// pattern as ai-bridge.ts's CleanupJobAnalytics. The renderer persists it as-is.
interface RvcJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  totalSentences: number;
  sentencesPerMinute: number;
  modelName: string;
  voiceLabel?: string;
  indexRate: number;
  protectRate?: number;
  success: boolean;
  outputPath?: string;
  error?: string;
}

interface ConversionSession {
  jobId: string;
  config: ParallelConversionConfig;
  prepInfo: PrepInfo | null;
  workers: WorkerState[];
  startTime: number;
  cancelled: boolean;
  assemblyProcess: ChildProcess | null;
  // RVC enhancement: when an enhancement pass runs, the enhanced sentence files
  // land here and assembly is pointed at them via e2a's --sentences_dir.
  rvcSentencesDir?: string;
  // Performance record for the RVC pass (surfaced on the complete event so the
  // renderer can persist it as its own 'rvc' analytics entry). RVC is a sub-pass
  // of the TTS job, not a separate queue job, so it rides along here.
  rvcAnalytics?: RvcJobAnalytics;
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
  // First-run model download note — surfaced as the progress message while
  // workers download the TTS model and no sentences have completed yet.
  downloadNote?: string;
  // GPU arbitration: true once this job holds the shared GPU lock (so the local
  // AI-cleanup LLM stays off the GPU while TTS runs). Released on every terminal
  // path. See gpu-arbiter.
  holdsGpu?: boolean;
  // Orpheus vLLM gpu_memory_utilization, sized from FREE VRAM at acquire time so the
  // reservation never over-commits the shared desktop GPU (see acquireGpuForJob).
  // Exported into the Orpheus worker (WSL) via ORPHEUS_GPU_MEM_UTIL.
  orpheusGpuMemUtil?: number;
  // The concrete Orpheus memory tier this job resolved to (from the user's choice,
  // or auto-sized to free VRAM). Used to lower the auto ceiling if the job OOMs.
  orpheusTier?: ConcreteOrpheusTier;
  // Display label for the resolved tier (e.g. 'Light') — shown as a queue badge.
  orpheusMemLevel?: string;
  // vLLM submission batch matched to the level's KV cache (win/linux), so it doesn't
  // over-admit and thrash on preemption. Set alongside the tier at sizing time.
  orpheusVllmBatch?: number;
  // One-line "what it's using and why" note, shown in the queue until sentences start.
  orpheusMemNote?: string;
  // Set by the GPU preflight when there isn't enough free VRAM to run safely; the
  // run loop aborts the job with this message instead of spilling into a freeze.
  gpuPreflightError?: string;
  // Terminal failure reason (e.g. "All workers failed: ... <stderr tail>"). emitComplete
  // no-ops headless (no mainWindow), so renderRangeHeadless reads THIS to throw the real
  // cause instead of the downstream "N sentence files missing" symptom.
  completionError?: string;
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
  // Settings used. The FULL render settings (sampling, speed, splitting, …) are
  // persisted — not just engine/voice — so a Continue/resume re-renders the missing
  // sentences identically and they don't drift from the ones already cached. Older
  // state files only have {device,language,ttsEngine,fineTuned}; readers must treat
  // the extra fields as optional.
  settings: ParallelTtsSettings;
  // RVC voice-enhancement config used for this render, if any (so a resume applies the
  // same enhancement pass). Mirrors ParallelConversionConfig.rvcEnhancement.
  rvcEnhancement?: ParallelConversionConfig['rvcEnhancement'];
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
        // Persist the FULL settings (not just engine/voice) so a later Continue
        // re-renders the missing sentences with identical sampling/speed/splitting.
        settings: { ...session.config.settings },
        rvcEnhancement: session.config.rvcEnhancement,
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
 * Send an IPC message to the renderer, but only if the window is still alive.
 * During app quit the BrowserWindow object outlives its webContents for a beat, so
 * a raw `mainWindow.webContents.send()` fired from a worker's exit handler throws
 * "TypeError: Object has been destroyed" (an uncaught exception seen when a job is
 * killed mid-flight). Guarding centrally makes every progress/complete emit a clean
 * no-op once teardown has begun.
 */
function rendererSend(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

/**
 * Kill all active worker processes (called on app quit)
 */
export async function killAllWorkers(clearSessions = true): Promise<void> {
  console.log('[PARALLEL-TTS] Killing all workers on app shutdown...');
  stopPowerBlock();

  for (const [jobId, session] of activeSessions) {
    console.log(`[PARALLEL-TTS] Killing workers for job ${jobId}`);
    const ttsEngine = session.config?.settings?.ttsEngine;

    // Clear watchdog timer
    if (session.watchdogTimer) {
      clearInterval(session.watchdogTimer);
    }

    if (shouldUseWslForSpawn(ttsEngine)) {
      // ONE session-scoped guest teardown covers every worker of this session:
      // cooperative SIGTERM → verified wait → VM terminate for a survivor (never
      // SIGKILL — that's the WSL wedge trigger). Shorter grace: the app is quitting.
      await destroyWslSessionWorkers(session, `quit ${jobId}`, 10000);
      // Only now close the Windows-side wsl.exe wrappers (harmless post-exit).
      for (const worker of session.workers) {
        if (worker.process) killWslWrapper(worker.process, `worker ${worker.id}`);
      }
      // Assembly runs NATIVELY on Windows for WSL sessions (see runAssembly) — a
      // normal process-tree kill both covers it and closes any legacy WSL wrapper.
      if (session.assemblyProcess && !session.assemblyProcess.killed) {
        killProcessTree(session.assemblyProcess, 'assembly');
      }
    } else {
      // Kill all worker processes (including child process trees)
      for (const worker of session.workers) {
        if (worker.process && !worker.process.killed) {
          killProcessTree(worker.process, `worker ${worker.id}`);
        }
      }
      // Kill assembly process if running
      if (session.assemblyProcess && !session.assemblyProcess.killed) {
        killProcessTree(session.assemblyProcess, 'assembly');
      }
    }

    // Safety net: reap any leftover NATIVE batch workers for this job (handle lost /
    // signal didn't take). Session-id-scoped, so the persistent Listen server is never
    // hit. The WSL side is already covered by the pattern-based teardown above.
    reapOrphanedSessionWorkers(session.prepInfo?.sessionId);
  }

  // Clean up any orphaned vLLM processes that escaped the process tree
  cleanupOrphanedVllmProcesses();
  // Also clean up orphaned processes in WSL if applicable (global — sessions are dead)
  cleanupWslOrphanedProcesses();

  // Keep the session map when the caller wants to flush partial progress to the cache
  // AFTER the worker processes are dead (files stable) — clearing here would leave
  // flushActiveSessionsToCache with nothing to promote, losing the checkpoint on quit.
  if (clearSessions) activeSessions.clear();
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
  settings: ParallelTtsSettings,
  prepJobId?: string  // Used only to address first-run model-download progress notes
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
    // Native session dir — the configured scratch, or <e2a>/tmp by default.
    // Must match where the spawned e2a writes it (buildCondaSpawnEnv passes
    // the same resolution as E2A_TMP_DIR).
    sessionDir = path.join(getDefaultE2aTmpPath(), `ebook-${sessionId}`);
    sessionDirForReading = sessionDir;
  }

  // Map UI device names to e2a CLI device names (app.py expects uppercase).
  // 'auto' → best present device; explicit cpu/gpu/mps honored exactly. Guard an
  // unrunnable explicit 'gpu' (no GPU pack) here so the user gets a clear reason
  // up front instead of a deep CUDA crash mid-conversion.
  const deviceArg = resolveTtsDeviceArg(settings.device);
  assertDeviceUsable(settings.device, deviceArg);
  console.log(`[PARALLEL-TTS] Device: requested='${settings.device}' → running on ${deviceArg}`);

  const args = [
    ...pythonInvocation(settings.ttsEngine).args,
    appPath,
    '--headless',
    '--ebook', epubPath,
    '--session', sessionId,
    '--language', settings.language,
    '--tts_engine', settings.ttsEngine,
    '--device', deviceArg,
    '--prep_only'
  ];

  pushVoiceArgs(args, settings);

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

  // Skip heading text in TTS (headings parsed for chapter detection but not spoken)
  if (settings.skipHeadings) {
    args.push('--skip_headings');
  }

  console.log('[PARALLEL-TTS] Running prep with:', args.join(' '));

  // Hoisted OUTSIDE the promise so the tails remain visible after it settles —
  // needed for the exit-0 validation below and the stall-timeout reject message.
  let stderr = '';
  let lastStdoutTail = '';
  let downloadNoteEmitted = false;

  // Run the prep command
  await new Promise<void>((resolve, reject) => {
    let lastOutputAt = Date.now();
    let stallTimer: NodeJS.Timeout | null = null;
    const clearStallTimer = () => { if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } };

    const prepProcess = spawnWithWslSupport(
      pythonInvocation(settings.ttsEngine).command,
      args,
      {
        cwd: getDefaultE2aPath(),
        // ORPHEUS_MAX_CHARS is consumed HERE (prep packs sentences via core.py get_sentences),
        // not in the worker. Inject it so buildWslBashCommand forwards it into the WSL prep.
        env: buildCondaSpawnEnv({
          PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
          VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0',
          ...(settings.ttsEngine === 'orpheus' && process.env.ORPHEUS_MAX_CHARS?.trim()
            ? { ORPHEUS_MAX_CHARS: process.env.ORPHEUS_MAX_CHARS.trim() }
            : {}),
        }),
        shell: false
      },
      settings.ttsEngine
    );

    // Log stdout for visibility (but don't parse it)
    prepProcess.stdout?.on('data', (data: Buffer) => {
      lastOutputAt = Date.now();
      const text = data.toString().trim();
      if (text) {
        // Only log non-JSON lines (skip the massive prep info JSON)
        if (!text.startsWith('{') && !text.startsWith('[') && !text.startsWith('"')) {
          const logLine = `[PREP] ${text.substring(0, 500)}`;
          console.log('[PARALLEL-TTS] Prep:', text.substring(0, 200));
          writeWorkerLog(logLine);
          lastStdoutTail = appendCapped(lastStdoutTail, text + '\n', MAX_WORKER_STDERR_TAIL_BYTES);
        }
      }
    });

    prepProcess.stderr?.on('data', (data: Buffer) => {
      lastOutputAt = Date.now();
      stderr = appendCapped(stderr, data.toString());
      // Log stderr for visibility
      const text = data.toString().trim();
      if (text && !text.includes('━')) {  // Skip progress bars
        const logLine = `[PREP STDERR] ${text.substring(0, 500)}`;
        console.log('[PARALLEL-TTS] Prep stderr:', text.substring(0, 200));
        writeWorkerLog(logLine);
      }
      // First-run model download visibility: emit a 'preparing' note once when the
      // download starts (throttled — only on the unset→set transition).
      if (!downloadNoteEmitted && prepJobId && MODEL_DOWNLOAD_RE.test(text) && mainWindow) {
        downloadNoteEmitted = true;
        const progress: AggregatedProgress = {
          phase: 'preparing',
          totalSentences: 0,
          completedSentences: 0,
          completedInSession: 0,
          percentage: 0,
          activeWorkers: 0,
          workers: [],
          estimatedRemaining: 0,
          message: MODEL_DOWNLOAD_NOTE
        };
        rendererSend('parallel-tts:progress', { jobId: prepJobId, progress });
      }
    });

    // Stall watchdog: kill prep if it goes silent (likely a hung model download).
    stallTimer = setInterval(() => {
      if (Date.now() - lastOutputAt > PREP_STALL_TIMEOUT_MS) {
        clearStallTimer();
        console.error('[PARALLEL-TTS] Prep stalled — no output for 10 minutes, killing prep process');
        if (shouldUseWslForSpawn(settings.ttsEngine)) {
          // Session-scoped graceful teardown (prep argv carries --session <id>); prep
          // is CPU text work / a hung download, so a short grace suffices. Wrapper is
          // closed only after the guest process is gone.
          void destroyWslGuestProcesses(`app\\.py.*${sessionId}`, { graceMs: 10000, label: 'prep-stall' })
            .then(() => killWslWrapper(prepProcess, 'prep'))
            .catch((err) => console.error('[PARALLEL-TTS] prep-stall teardown failed:', err));
        } else {
          killProcessTree(prepProcess, 'prep');
        }
        const tail = stderr.trim().slice(-500);
        reject(new Error(
          `Prep stalled — no output for 10 minutes (possibly a hung model download). Last stderr: ${tail}`
        ));
      }
    }, 30 * 1000);

    prepProcess.on('close', (code: number | null) => {
      clearStallTimer();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Prep failed with code ${code}: ${stderr}`));
      }
    });

    prepProcess.on('error', (err) => {
      clearStallTimer();
      reject(err);
    });
  });

  // Prep exited 0 — validate it actually produced a usable session. Calibre can die
  // silently on some filesystems (e.g. ExFAT) yet leave exit code 0, producing no
  // session dir / empty state. Surface a clear error instead of a cryptic ENOENT.
  let state: any;
  let processDirForReading: string;
  try {
    // Read the session-state.json file from the process subdirectory
    // Use sessionDirForReading which is a Windows-accessible path (UNC for WSL paths)
    const entries = await fs.readdir(sessionDirForReading, { withFileTypes: true });
    const processDir = entries.find(e => e.isDirectory());
    if (!processDir) {
      throw new Error(`No process directory found in ${sessionDirForReading}`);
    }

    // Build Windows-accessible paths from sessionDirForReading
    // The session-state.json contains WSL-native paths, but we need Windows UNC paths for file operations
    processDirForReading = path.join(sessionDirForReading, processDir.name);
    const statePath = path.join(processDirForReading, 'session-state.json');
    const stateContent = await fs.readFile(statePath, 'utf-8');
    state = JSON.parse(stateContent);

    if (!state || state.total_sentences === 0 || !Array.isArray(state.chapters) || state.chapters.length === 0) {
      throw new Error(`session-state.json has no sentences/chapters (total_sentences=${state?.total_sentences})`);
    }
  } catch (err) {
    const stdoutTail = lastStdoutTail.trim().slice(-300);
    const stderrTail = stderr.trim().slice(-300);
    throw new Error(
      `Prep exited successfully but produced no usable session — the ebook conversion step ` +
      `(Calibre) may have failed silently. Underlying error: ${err instanceof Error ? err.message : String(err)}. ` +
      `Last prep output: ${stdoutTail} | stderr: ${stderrTail}`
    );
  }

  // Per-global-chunk-index real-sentence counts, for an EXACT sentences/min (vs the
  // chunk×average estimate). Cross-check the sum against Python's authoritative
  // total_raw_sentences to catch any drift between this TS regex and session.py's.
  const rawSentenceCounts = buildRawSentenceCounts(state.chapter_sentences);
  const rawCountsSum = rawSentenceCounts.reduce((a, b) => a + b, 0);
  if (typeof state.total_raw_sentences === 'number' && rawCountsSum > 0 && rawCountsSum !== state.total_raw_sentences) {
    console.warn(`[PARALLEL-TTS] raw-sentence count mismatch: bridge=${rawCountsSum} vs prep=${state.total_raw_sentences} — the TS sentence regex may have drifted from session.py's _SENTENCE_END_RE`);
  }

  const prepInfo: PrepInfo = {
    sessionId: state.session_id,
    // Use Windows-accessible paths for file operations, not WSL-native paths from state
    sessionDir: sessionDirForReading,
    processDir: processDirForReading,
    chaptersDir: path.join(processDirForReading, 'chapters'),
    chaptersDirSentences: path.join(processDirForReading, 'chapters', 'sentences'),
    totalChapters: state.total_chapters,
    totalSentences: state.total_sentences,
    // Real sentence count (chunks pack 2-3 sentences). Prefer prep's authoritative value;
    // else the bridge-computed sum; else fall back to the chunk count (old sessions).
    totalRawSentences: state.total_raw_sentences ?? (rawCountsSum > 0 ? rawCountsSum : state.total_sentences),
    rawSentenceCounts: rawSentenceCounts.length > 0 ? rawSentenceCounts : undefined,
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
    // worker.py argparser expects uppercase device names: CPU, MPS, CUDA;
    // upgrades default-CPU to CUDA when the GPU TTS pack is installed (or, for
    // Orpheus, when it runs on its own WSL CUDA env). Pass the engine so Orpheus-via-
    // WSL resolves to CUDA and the GPU arbiter VRAM-sizes it.
    const deviceArg = resolveTtsDeviceArg(settings.device, settings.ttsEngine);
    args = [
      ...pythonInvocation(settings.ttsEngine).args,
      workerPath,
      '--session', prepInfo.sessionId,
      '--session_dir', prepInfo.sessionDir,
      // The single authoritative sentence store: the worker writes new sentences here
      // and skips ones already present (resume). For a resume this is the durable
      // Windows project cache; buildWslBashCommand translates it to /mnt/c for Orpheus.
      '--sentences_dir', prepInfo.chaptersDirSentences,
      '--device', deviceArg,
      '--tts_engine', settings.ttsEngine
    ];

    // Always pass the voice so the current UI selection wins over the original in
    // session-state.json (critical for resume jobs).
    pushVoiceArgs(args, settings);

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
    // Map UI device names to e2a CLI device names (app.py expects uppercase);
    // upgrades default-CPU to CUDA when the GPU TTS pack is installed (or, for
    // Orpheus, when it runs on its own WSL CUDA env).
    const appDeviceArg = resolveTtsDeviceArg(settings.device, settings.ttsEngine);
    args = [
      ...pythonInvocation(settings.ttsEngine).args,
      appPath,
      '--headless',
      '--session', prepInfo.sessionId,
      '--session_dir', prepInfo.sessionDir,
      // Single authoritative sentence store (write + skip-on-resume). For a resume
      // this is the durable Windows project cache; translated to /mnt/c for Orpheus.
      '--sentences_dir', prepInfo.chaptersDirSentences,
      '--device', appDeviceArg,
      '--output_dir', config.outputDir,
      '--worker_mode',
      '--skip_deps',  // Deps already verified during prep phase
      '--tts_engine', settings.ttsEngine
    ];

    // Always pass the voice so the current UI selection wins over session-state.json.
    pushVoiceArgs(args, settings);

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
    pythonInvocation(settings.ttsEngine).command,
    args,
    {
      cwd: getDefaultE2aPath(),
      env: buildCondaSpawnEnv({
        PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8',
        VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0',
        // VRAM-sized gpu_memory_utilization for Orpheus (see acquireGpuForJob). Must be
        // set here so buildWslBashCommand can export it INTO the WSL worker — without
        // this the worker always falls back to orpheus.py's hardcoded 0.70 of total.
        ...(settings.ttsEngine === 'orpheus' && session.orpheusGpuMemUtil
          ? { ORPHEUS_GPU_MEM_UTIL: String(session.orpheusGpuMemUtil) }
          : {}),
        // Orpheus batch width: how many sentences to submit at once. On Mac (MLX unified
        // memory) this IS the memory lever, so the tier sets it. On NVIDIA/vLLM the batch
        // doesn't change VRAM (KV pool is fixed by gpu_memory_utilization), but submitting
        // MORE than the KV cache can hold makes vLLM admit-then-evict (RECOMPUTE
        // preemption) — wasted work. So match the submission batch to the level's KV
        // cache (session.orpheusVllmBatch, set at sizing time). Explicit env still wins.
        ...(settings.ttsEngine === 'orpheus'
          ? {
              ORPHEUS_BATCH_SIZE: process.platform === 'darwin'
                ? (process.env.ORPHEUS_BATCH_SIZE?.trim()
                    || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).batchSize))
                : (process.env.ORPHEUS_BATCH_SIZE?.trim()
                    || (session.orpheusVllmBatch ? String(session.orpheusVllmBatch) : defaultOrpheusBatchSize())),
            }
          : {}),
        // Mac/MLX only: bound the MLX allocator's freed-buffer cache (it grows to
        // ~46 GB per batched chunk unbounded — the real memory-pressure source on
        // unified memory). orpheus.py reads this at engine load → mx.set_cache_limit.
        ...(settings.ttsEngine === 'orpheus' && process.platform === 'darwin'
          ? {
              ORPHEUS_MLX_CACHE_LIMIT_GB: process.env.ORPHEUS_MLX_CACHE_LIMIT_GB?.trim()
                || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).mlxCacheLimitGB),
            }
          : {}),
        // Orpheus deterministic inter-clip gap (CLI --sentence-gap). orpheus.py
        // _classify_gap reads ORPHEUS_SENTENCE_GAP; forwarded into WSL via forwardKeys so
        // the worker honors it instead of the 0.75s default. Explicit env only.
        ...(settings.ttsEngine === 'orpheus' && process.env.ORPHEUS_SENTENCE_GAP?.trim()
          ? { ORPHEUS_SENTENCE_GAP: process.env.ORPHEUS_SENTENCE_GAP.trim() }
          : {}),
        // Auto-enable DeepSpeed for XTTS only when it's actually installed in the env.
        ...(xttsDeepspeedAvailable(settings.ttsEngine) ? { XTTS_USE_DEEPSPEED: '1' } : {}),
      }),
      shell: false
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
        // …and the EXACT real-sentence count of that chunk, for a precise sentences/min.
        accrueRawCompleted(session, worker, currentSentence);
        // Update watchdog tracking
        worker.lastProgressAt = Date.now();
        if (!worker.hasShownProgress) {
          worker.hasShownProgress = true;
          logger.log('INFO', session.jobId, `Worker ${workerId} started converting`, {
            startupTime: Math.round((Date.now() - (worker.startedAt || Date.now())) / 1000)
          }).catch(() => {});
        }
        // Real sentence progress arrived — clear any first-run download note.
        if (session.downloadNote) session.downloadNote = undefined;
        emitProgress(session);
        continue;
      }

      // Model-loading activity on stdout keeps the watchdog alive; only a genuine
      // download (byte-rate) shows the user-facing "downloading" note.
      if (MODEL_ACTIVITY_RE.test(line)) {
        worker.lastProgressAt = Date.now();
        worker.lastDownloadActivityAt = Date.now();
        if (!session.downloadNote && MODEL_DOWNLOAD_RE.test(line)) {
          session.downloadNote = MODEL_DOWNLOAD_NOTE;
          emitProgress(session);
        }
      }

      // Active-generation heartbeat (re-render / batch generation). A worker grinding
      // through a slow batch hasn't stalled — keep the watchdog from false-killing it.
      if (GENERATION_ACTIVITY_RE.test(line)) {
        worker.lastProgressAt = Date.now();
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
        accrueRawCompleted(session, worker, currentSentence);
        worker.lastProgressAt = Date.now();
        if (!worker.hasShownProgress) {
          worker.hasShownProgress = true;
          logger.log('INFO', session.jobId, `Worker ${workerId} started converting`, {
            startupTime: Math.round((Date.now() - (worker.startedAt || Date.now())) / 1000)
          }).catch(() => {});
        }
        // Real sentence progress arrived — clear any first-run download note.
        if (session.downloadNote) session.downloadNote = undefined;
        emitProgress(session);
        continue;
      }

      // Model-loading activity (download or cache load) keeps the watchdog from
      // killing a slow-but-alive worker; only a genuine download (byte-rate) shows
      // the user-facing "downloading" note.
      if (MODEL_ACTIVITY_RE.test(line)) {
        worker.lastProgressAt = Date.now();
        worker.lastDownloadActivityAt = Date.now();
        if (!session.downloadNote && MODEL_DOWNLOAD_RE.test(line)) {
          session.downloadNote = MODEL_DOWNLOAD_NOTE;
          emitProgress(session);
        }
        continue;
      }

      // Active-generation heartbeat: vLLM's batch progress (tqdm "Processed prompts" /
      // "Adding requests") lands on stderr. A worker mid-batch is alive even when no
      // sentence has completed for minutes — don't let the watchdog false-kill it.
      if (GENERATION_ACTIVITY_RE.test(line)) {
        worker.lastProgressAt = Date.now();
      }

      // Capture non-progress stderr for crash diagnosis (surfaced in worker.error
      // on non-zero exit). Skip progress-bar lines to keep the tail signal-dense.
      const trimmed = line.trim();
      if (!trimmed.includes('━') && !/^\s*\d+%\|/.test(line)) {
        worker.stderrTail = appendCapped(worker.stderrTail || '', trimmed + '\n', MAX_WORKER_STDERR_TAIL_BYTES);
      }
    }
  });

  workerProcess.on('close', (code) => {
    const duration = worker.startedAt ? Math.round((Date.now() - worker.startedAt) / 1000) : 0;
    const exitMsg = `[PARALLEL-TTS] Worker ${workerId} exited with code ${code} after ${duration}s`;
    console.log(exitMsg);
    writeWorkerLog(exitMsg);
    // Only clear the handle if it still points at THIS process. A retry (retryWorker)
    // reuses the same worker object and may have already swapped in a new process; a
    // blind null here would orphan that live replacement (its handle becomes
    // unreachable, so stop/cancel can't kill it).
    if (worker.process === workerProcess) worker.process = null;

    if (session.cancelled) {
      worker.status = 'error';
      worker.error = 'Cancelled';
      logger.log('INFO', session.jobId, `Worker ${workerId} cancelled`, { duration }).catch(() => {});
      return;
    }

    if (code === 0) {
      worker.status = 'complete';
      // For non-resume jobs, set completedSentences to the full range (safety net
      // in case progress lines were missed). For resume jobs, keep the incremental
      // count from progress lines — setting it to the full range would double-count
      // sentences that were already done before the resume.
      if (!session.isResumeJob) {
        worker.completedSentences = worker.sentenceEnd - worker.sentenceStart + 1;
      }
      logger.log('INFO', session.jobId, `Worker ${workerId} completed`, {
        duration,
        sentences: worker.completedSentences
      }).catch(() => {});
      emitProgress(session);
      checkAllWorkersComplete(session);
    } else {
      worker.status = 'error';
      worker.error = `Worker exited with code ${code}`;
      // Append the tail of recent stderr so "All workers failed: ..." is actually
      // diagnosable (AF_UNIX crashes, Python tracebacks, etc.).
      if (worker.stderrTail && worker.stderrTail.trim()) {
        const tail = worker.stderrTail.trim().slice(-500).replace(/\s*\n+\s*/g, ' | ').trim();
        if (tail) worker.error += `. Last output: ${tail}`;
      }
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
    // Same guard as the close handler: don't null a replacement process a retry installed.
    if (worker.process === workerProcess) worker.process = null;
    emitProgress(session);
    // Drive completion like the close handler does: a spawn-failure class that emits
    // 'error' without 'close' would otherwise leave the session alive forever (the
    // headless poll would spin; the watchdog ignores already-'error' workers).
    checkAllWorkersComplete(session);
  });

  return workerProcess;
}

const MAX_WORKER_RETRIES = 2;  // Maximum retry attempts per worker

/** Does a worker's error text look like a GPU/host out-of-memory failure? Used to
 *  ratchet the Orpheus auto tier down (see noteOrpheusOom). Matches CUDA OOM, the
 *  Windows 0xe0000008 spill dialog, and generic allocator failures. */
function isOomError(err: string | undefined | null): boolean {
  if (!err) return false;
  return /out of memory|cuda error|0xe0000008|outofmemory|cudamalloc|failed to allocate|memoryerror|not enough memory/i.test(err);
}

/**
 * Check if all workers are complete and trigger assembly
 */
async function checkAllWorkersComplete(session: ConversionSession): Promise<void> {
  if (session.cancelled) return;

  const allComplete = session.workers.every(w => w.status === 'complete');
  const failedWorkers = session.workers.filter(w => w.status === 'error');

  // Learn from OOM failures: if an Orpheus worker died out-of-memory, ratchet the
  // auto ceiling down one tier so the next run (auto mode) picks a lighter, more
  // reliable tier. Recorded once per job (the tier can't change mid-job).
  if (session.orpheusTier && failedWorkers.some(w => isOomError(w.error))) {
    noteOrpheusOom(session.orpheusTier);
  }

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
      session.completionError = `All workers failed: ${errors}`;
      emitComplete(session, false, undefined, session.completionError);
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

    // Cache TTS session to project BEFORE assembly or skipAssembly return,
    // because e2a's headless mode deletes the process dir (sentence files)
    // after successful assembly, and skipAssembly callers still need cached sessions.
    //
    // Capture the pre-caching session location NOW: cacheSessionToProject (via a
    // cache-bound resume's prepInfo) and normalizeWslSessionToWindows (below) can
    // leave prepInfo.sessionDir pointing INTO the durable project cache. The
    // post-assembly scratch cleanup must target this original location only —
    // deleting prepInfo.sessionDir at that point deleted the cache itself.
    const scratchSessionDir = session.prepInfo?.sessionDir;
    let cachedSentencesDir: string | undefined;
    if (session.config.bfpPath && session.prepInfo?.sessionDir) {
      const language = session.config.settings.language || 'en';
      try {
        const cacheResult = await cacheSessionToProject(
          session.prepInfo.sessionDir, session.config.bfpPath, language
        );
        if (cacheResult.success) {
          cachedSentencesDir = cacheResult.cachedSentencesDir;
          console.log(`[PARALLEL-TTS] Session cached: ${cacheResult.cachedSentencesDir}`);
        } else {
          console.error(`[PARALLEL-TTS] Session cache failed: ${cacheResult.error}`);
        }
      } catch (err) {
        console.error('[PARALLEL-TTS] Session cache error:', err);
      }
    }

    // Orpheus runs in WSL; move its output onto Windows so RVC + assembly run
    // natively (off the slow \\wsl$ 9p mount, and on the up-to-date Windows e2a
    // that supports --sentences_dir). Reuses the Windows copy the project cache
    // just made when available. No-op for native engines or a failed copy.
    await normalizeWslSessionToWindows(session, cachedSentencesDir);

    // Check if we should skip assembly (for dual-voice bilingual workflows)
    if (session.config.skipAssembly) {
      const sentencesDir = session.prepInfo?.chaptersDirSentences || session.prepInfo?.chaptersDir;
      await logger.log('INFO', session.jobId, `skipAssembly mode - sentences at: ${sentencesDir}`);
      // Emit completion with sentences directory as the "output path" for downstream assembly
      emitComplete(session, true, sentencesDir);
      activeSessions.delete(session.jobId);
      return;
    }

    // Completeness gate: workers deliberately tolerate individual sentence
    // failures ("warn and continue"), which is right for one flaky sentence but
    // means a worker can report success with holes — 2026-07-05, a poisoned CUDA
    // context fast-failed ~1200 sentences in seconds and this path would have
    // assembled the last two-thirds of the book as a gap and called it success.
    // Verify every required sentence file exists on disk BEFORE spending time on
    // RVC/assembly. On failure the session is already cached above, so Continue
    // re-renders exactly the missing sentences. A gate that can't verify is a
    // failure too — never assemble unverified. (NO FALLBACKS.)
    try {
      const missing = await findMissingSentenceFiles(session.prepInfo!);
      if (missing.length > 0) {
        const preview = missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', …' : '');
        const msg = `${missing.length} of ${session.prepInfo!.totalSentences} sentences failed to render ` +
          `(missing: ${preview}). Refusing to assemble an audiobook with gaps — ` +
          `use Continue on this book to re-render just the missing sentences.`;
        console.error(`[PARALLEL-TTS] ${msg}`);
        await logger.log('ERROR', session.jobId, msg);
        emitComplete(session, false, undefined, msg);
        activeSessions.delete(session.jobId);
        return;
      }
      console.log(`[PARALLEL-TTS] Completeness gate passed: all ${session.prepInfo!.totalSentences} sentences on disk`);
    } catch (gateErr) {
      const msg = `Could not verify rendered sentences before assembly: ${gateErr}`;
      console.error(`[PARALLEL-TTS] ${msg}`);
      await logger.log('ERROR', session.jobId, msg);
      emitComplete(session, false, undefined, msg);
      activeSessions.delete(session.jobId);
      return;
    }

    // RVC voice enhancement (optional): re-render every sentence through an RVC
    // model with a single warm model load, then assemble the ENHANCED set via
    // --sentences_dir. The original XTTS sentences stay cached and untouched.
    if (session.config.rvcEnhancement?.enabled) {
      const rvc = session.config.rvcEnhancement;
      const voice = getRvcVoiceById(rvc.voiceId);
      const sentencesDir = session.prepInfo?.chaptersDirSentences;
      if (!voice) {
        emitComplete(session, false, undefined, `RVC enhancement: unknown voice "${rvc.voiceId}".`);
        activeSessions.delete(session.jobId);
        return;
      }
      if (!sentencesDir) {
        emitComplete(session, false, undefined, 'RVC enhancement: sentences directory unknown.');
        activeSessions.delete(session.jobId);
        return;
      }
      const ready = rvcEnhancementReady();
      if (!ready.ok) {
        emitComplete(session, false, undefined, `RVC enhancement unavailable: ${ready.reason}`);
        activeSessions.delete(session.jobId);
        return;
      }
      const rvcOutDir = path.join(path.dirname(sentencesDir), 'sentences_rvc');
      const rvcIndexRate = voice.forceIndexRate0 ? 0 : (voice.defaultIndexRate ?? rvc.indexRate ?? 0.5);
      const rvcStart = Date.now();
      let rvcTotal = 0;  // captured from progress; total sentences enhanced
      try {
        await logger.log('INFO', session.jobId, `RVC enhancement starting (voice: ${voice.label}, model: ${voice.modelName})`);
        await enhanceSentences({
          sentencesDir,
          outputDir: rvcOutDir,
          modelName: voice.modelName,
          indexRate: rvcIndexRate,
          protectRate: rvc.protectRate ?? 0.5,
          nSemitones: rvc.nSemitones ?? 0,
          onProgress: (done, total) => {
            rvcTotal = total;
            if (!mainWindow) return;
            const progress: AggregatedProgress = {
              phase: 'enhancing',
              totalSentences: session.prepInfo!.totalSentences,
              completedSentences: session.prepInfo!.totalSentences,
              completedInSession: session.isResumeJob ? (session.totalMissing || 0) : session.prepInfo!.totalSentences,
              percentage: 95,
              activeWorkers: 0,
              workers: session.workers,
              estimatedRemaining: 0,
              message: `Enhancing voice with ${voice.label}… (${done}/${total})`,
            };
            rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
          },
        });
        session.rvcSentencesDir = rvcOutDir;
        // Record RVC performance — surfaced on the complete event, persisted by
        // the renderer as its own 'rvc' analytics entry.
        const rvcDuration = Math.round((Date.now() - rvcStart) / 1000);
        const rvcSentences = rvcTotal || session.prepInfo?.totalSentences || 0;
        const rvcMinutes = rvcDuration / 60;
        session.rvcAnalytics = {
          jobId: session.jobId,
          startedAt: new Date(rvcStart).toISOString(),
          completedAt: new Date().toISOString(),
          durationSeconds: rvcDuration,
          totalSentences: rvcSentences,
          sentencesPerMinute: rvcMinutes > 0 ? Math.round((rvcSentences / rvcMinutes) * 10) / 10 : 0,
          modelName: voice.modelName,
          voiceLabel: voice.label,
          indexRate: rvcIndexRate,
          protectRate: rvc.protectRate ?? 0.5,
          success: true,
          outputPath: rvcOutDir,
        };
        await logger.log('INFO', session.jobId, `RVC enhancement complete: ${rvcOutDir} (${session.rvcAnalytics.sentencesPerMinute} sent/min)`);
      } catch (err) {
        emitComplete(session, false, undefined, `RVC enhancement failed: ${err}`);
        activeSessions.delete(session.jobId);
        return;
      }
    }

    try {
      const outputPath = await runAssembly(session);
      // Mark as success even with partial worker failures if assembly succeeded
      if (failedWorkersList.length > 0) {
        console.log(`[PARALLEL-TTS] Assembly succeeded despite ${failedWorkersList.length} worker failure(s)`);
      }
      emitComplete(session, true, outputPath);
      // The session has now been cached into the project AND assembled into the
      // final audiobook (which lands in config.outputDir, not the scratch dir) —
      // so the scratch session is a redundant duplicate. Remove it now instead of
      // letting it linger until the stale sweep. Guard on cachedSentencesDir so we
      // never delete the only surviving copy if caching was skipped or failed.
      // Use the ORIGINAL scratch location captured before caching/normalization —
      // prepInfo.sessionDir may point at the project cache by now (resume jobs,
      // normalized Orpheus sessions), and removeScratchSession refuses cache
      // paths as a second layer of protection.
      if (cachedSentencesDir && scratchSessionDir) {
        await removeScratchSession(scratchSessionDir);
      }
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
      // An actively-downloading worker (first run) is alive even without sentence
      // progress — measure the startup timeout from its last download activity so
      // a slow 3GB HuggingFace download isn't killed at the 10-minute mark.
      const effectiveStart = worker.lastDownloadActivityAt
        ? Math.max(worker.startedAt, worker.lastDownloadActivityAt)
        : worker.startedAt;
      const timeSinceStart = now - effectiveStart;
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
      if (shouldUseWslForSpawn(ttsEngine)) {
        // Session-scoped graceful teardown (Orpheus-WSL runs a single worker, so
        // "the session's workers" IS this worker). Never SIGKILL in the guest.
        await destroyWslSessionWorkers(session, `stuck worker ${worker.id}`);
        killWslWrapper(worker.process, `stuck worker ${worker.id}`);
      } else {
        killProcessTree(worker.process, `stuck worker ${worker.id}`);
      }
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

  // Re-check cancellation at the retry boundary: a user Stop can land in the async
  // gap between the close handler and this call. The old code respawned a stopping
  // job's worker (twice) against a card the dying worker still occupied.
  if (session.cancelled) {
    console.log(`[PARALLEL-TTS] Not retrying worker ${worker.id} — session cancelled`);
    return;
  }
  // Never retry into a wedged WSL VM — mark the worker permanently failed so the
  // session resolves loudly instead of spawning more doomed GPU work.
  if (isWslWedged() && shouldUseWslForSpawn(config.settings.ttsEngine)) {
    worker.retryCount = MAX_WORKER_RETRIES;
    worker.status = 'error';
    worker.error = wslWedgedMessage();
    console.error(`[PARALLEL-TTS] Not retrying worker ${worker.id} — ${worker.error}`);
    emitProgress(session);
    return;
  }

  // Capture the failure class BEFORE resetting: an OOM-class death means the dead
  // worker's VRAM may not be back yet — the retry must wait for it below.
  const failedWithOom = isOomError(worker.error);

  // Reset worker state for retry
  worker.retryCount++;
  worker.status = 'pending';
  worker.error = undefined;
  worker.completedSentences = 0;
  worker.rawCompletedSentences = 0;
  worker.currentSentence = worker.sentenceStart;
  worker.stderrTail = undefined;

  // Emit progress immediately to clear error state from UI
  emitProgress(session);

  console.log(`[PARALLEL-TTS] Retrying worker ${worker.id} (attempt ${worker.retryCount}): ${
    isChapterMode
      ? `chapters ${worker.chapterStart}-${worker.chapterEnd}`
      : `sentences ${worker.sentenceStart}-${worker.sentenceEnd}`
  }`);

  // Clean up any orphaned vLLM processes before retry (the failed worker may have left them).
  // Both the Windows-native path AND the WSL path — a failed WSL Orpheus worker leaves a
  // vLLM process holding ~19 GiB of VRAM, so the immediate retry would CUDA-OOM unless we
  // reap it first (this was the 3-attempt OOM cascade). SCOPED to this job's session —
  // the old global sweep SIGTERM'd other live sessions' workers. No-op off-Windows /
  // when WSL Orpheus is disabled.
  cleanupOrphanedVllmProcesses();
  cleanupWslOrphanedProcesses(session.prepInfo?.sessionId);

  // Start the worker with the same range
  const range: WorkerRange = isChapterMode
    ? { chapterStart: worker.chapterStart, chapterEnd: worker.chapterEnd }
    : { sentenceStart: worker.sentenceStart, sentenceEnd: worker.sentenceEnd };

  const engine = config.settings.ttsEngine;
  const gpuEngine = engine === 'orpheus' || engine === 'xtts';
  if (failedWithOom && gpuEngine) {
    // Wait for the dead worker's VRAM to actually come back before respawning —
    // blind immediate respawns were the 3-attempt OOM cascade. Async on purpose:
    // worker.status is already 'pending', so checkAllWorkersComplete keeps the
    // session open while we wait.
    void waitForFreeVram(ORPHEUS_MIN_VRAM_MB, {
      timeoutMs: 90_000,
      onWait: (freeMB, neededMB) =>
        console.log(`[PARALLEL-TTS] Retry of worker ${worker.id} waiting for VRAM: ${freeMB} MB free, need ~${neededMB} MB`),
    }).then((r) => {
      if (session.cancelled) {
        console.log(`[PARALLEL-TTS] Not retrying worker ${worker.id} — session cancelled during VRAM wait`);
        return;
      }
      if (!r.ok) {
        worker.retryCount = MAX_WORKER_RETRIES;
        worker.status = 'error';
        worker.error = `Retry aborted: GPU memory never freed up (${((r.freeMB ?? 0) / 1024).toFixed(1)} GB free after 90s)`;
        console.error(`[PARALLEL-TTS] ${worker.error}`);
        emitProgress(session);
        void checkAllWorkersComplete(session);
        return;
      }
      startWorker(session, worker.id, range);
    });
    return;
  }

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
  const config = session.config;

  // If outputting to BFP audiobook folder, run post-processing (rename VTT, copy to external)
  if (config.bfpPath) {
    console.log('[PARALLEL-TTS] Post-processing output in BFP audiobook folder...');
    try {
      const result = await postProcessOutput(
        config.outputDir,
      );
      console.log('[PARALLEL-TTS] Post-processing complete:', result);
      // Seal the transcript INTO the m4b as a subtitle track — the single source of
      // truth (embed-only model). The sidecar is ALWAYS removed afterward: redundant
      // on success, untrusted on failure. On embed failure the audiobook simply has
      // no transcript (loud error) — there is no sidecar fallback. bilingual-*.vtt
      // are skipped by deleteSidecarsForM4b.
      if (result.audioPath && result.vttPath) {
        try {
          // Language tag on the subtitle stream is cosmetic; the persisted settings
          // hold it when available, else 'und' (embed default).
          const lang = session.persistentState?.settings?.language;
          const embedded = await embedAndVerifyVtt(result.audioPath, result.vttPath, lang ? { language: lang } : undefined);
          if (embedded) console.log('[PARALLEL-TTS] Embedded transcript into m4b:', result.audioPath);
          else console.error('[PARALLEL-TTS] Embed verify failed — audiobook has NO transcript (embed-only, no sidecar fallback):', result.audioPath);
        } catch (embedErr) {
          console.error('[PARALLEL-TTS] Failed to embed transcript — audiobook has NO transcript:', embedErr);
        }
        deleteSidecarsForM4b(result.audioPath);
      }
      return result.audioPath;
    } catch (err) {
      console.error('[PARALLEL-TTS] Post-processing failed, using original path:', err);
      return processedPath;
    }
  }

  return processedPath;
}

/** Walk up from a sentences dir to the enclosing `ebook-{id}` session dir. */
function sessionDirFromCachedSentences(sentencesDir: string): string {
  let d = sentencesDir;
  for (let i = 0; i < 6; i++) {
    if (path.basename(d).startsWith('ebook-')) return d;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // Fallback for a non-standard layout: sentences → chapters → hash → ebook.
  return path.dirname(path.dirname(path.dirname(sentencesDir)));
}

/** Locate the e2a process dir (the one holding session-state.json) under a session
 *  dir. e2a nests it under a hash subdir (ebook-{id}/{hash}/session-state.json) but
 *  some layouts put it directly under ebook-{id}. Returns null if neither is found. */
function findE2aProcessDir(sessionDir: string): string | null {
  if (fsSync.existsSync(path.join(sessionDir, 'session-state.json'))) return sessionDir;
  let entries: fsSync.Dirent[];
  try { entries = fsSync.readdirSync(sessionDir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('ebook-')) {
      const cand = path.join(sessionDir, e.name);
      if (fsSync.existsSync(path.join(cand, 'session-state.json'))) return cand;
    }
  }
  return null;
}

/**
 * Move an Orpheus session's files from WSL onto Windows after generation.
 *
 * Orpheus generates inside WSL (vLLM CUDA graphs only capture on Linux), but RVC
 * and assembly run on Windows. Two problems if they reach into WSL: (1) a native
 * Windows process crawling thousands of FLACs over the \\wsl$ 9p bridge is slow,
 * and (2) assembly would run on the WSL e2a, which is a stale manual mirror that
 * lacks --sentences_dir (so RVC-enhanced assembly fails there). Copying the
 * session onto a Windows-native path lets RVC + assembly run on the up-to-date
 * Windows e2a, leaving Orpheus generation as the ONLY thing that touches WSL.
 *
 * The copy is fast: it runs INSIDE WSL (ext4 → /mnt), not Node over 9p. When the
 * caller already produced a Windows copy (the project cache, which also rewrote
 * session-state.json), pass it as `windowsSentencesDir` to skip a second copy.
 *
 * Best-effort: on any failure we leave prepInfo on the WSL paths, so the existing
 * WSL assembly path still runs — no regression.
 */
async function normalizeWslSessionToWindows(
  session: ConversionSession,
  windowsSentencesDir?: string,
): Promise<void> {
  const prep = session.prepInfo;
  if (!prep || process.platform !== 'win32') return;
  if (!isWslUncPath(prep.sessionDir)) return; // already native — nothing to do

  try {
    let winSessionDir: string;
    let winSentences: string;

    if (windowsSentencesDir && fsSync.existsSync(windowsSentencesDir)) {
      // Reuse the project cache: it already copied the session to Windows AND
      // rewrote its session-state.json (cacheSessionToProject), so just repoint.
      winSentences = windowsSentencesDir;
      winSessionDir = sessionDirFromCachedSentences(windowsSentencesDir);
    } else {
      // No reusable Windows copy — make one in the Windows e2a tmp cache.
      const folderName = path.basename(prep.sessionDir); // ebook-{id}
      const destParent = getDefaultE2aTmpPath();          // Windows NTFS
      winSessionDir = path.join(destParent, folderName);
      const wslSrc = uncToWslPath(prep.sessionDir);
      const wslDest = windowsToWslPath(winSessionDir);
      const wslDestParent = windowsToWslPath(destParent);
      await fs.rm(winSessionDir, { recursive: true, force: true }).catch(() => {});
      const cmd = `mkdir -p ${shellQuote(wslDestParent)} && cp -r ${shellQuote(wslSrc)} ${shellQuote(wslDest)}`;
      const distro = getWslDistro();
      const wslArgs = distro ? ['-d', distro, 'bash', '-c', cmd] : ['bash', '-c', cmd];
      console.log(`[PARALLEL-TTS] Normalizing Orpheus session WSL→Windows: wsl.exe ${wslArgs.join(' ')}`);
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('wsl.exe', wslArgs, { shell: false });
        let stderr = '';
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`WSL copy failed (${code}): ${stderr}`)));
        proc.on('error', reject);
      });
      // Point e2a's session-state.json at the new Windows location.
      await rewriteSessionStatePaths(winSessionDir);
      const winProcessDir = findE2aProcessDir(winSessionDir);
      if (!winProcessDir) throw new Error(`No process dir under ${winSessionDir}`);
      winSentences = path.join(winProcessDir, 'chapters', 'sentences');
    }

    if (!fsSync.existsSync(winSentences)) throw new Error(`No sentences at ${winSentences}`);

    prep.sessionDir = winSessionDir;
    prep.chaptersDir = path.dirname(winSentences);
    prep.chaptersDirSentences = winSentences;
    console.log(`[PARALLEL-TTS] Orpheus session normalized to Windows: ${winSessionDir} (RVC + assembly run native)`);
    await logger.log('INFO', session.jobId, `Orpheus session normalized to Windows; RVC + assembly run native: ${winSessionDir}`);
  } catch (err) {
    console.error('[PARALLEL-TTS] WSL→Windows normalization failed; keeping WSL paths (assembly will use WSL):', err);
    await logger.log('WARN', session.jobId, `WSL→Windows normalization failed (assembly via WSL): ${err instanceof Error ? err.message : String(err)}`);
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
    rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
  }

  // Run e2a with --assemble_only to combine sentence audio files into final audiobook
  const appPath = path.join(getDefaultE2aPath(), 'app.py');
  const settings = config.settings;

  // Assembly only concatenates sentence audio — it loads no TTS model and is
  // engine-agnostic. This block is WINDOWS-ONLY: it handles Orpheus, which runs in
  // WSL on Windows but is normalized onto Windows after generation
  // (normalizeWslSessionToWindows), so assembly runs NATIVELY here. We can't use
  // the engine's real env for that: pythonInvocation('orpheus') returns a fake
  // orpheus_wsl_env prefix that only resolves after buildWslBashCommand rewrites it
  // to `-n orpheus_tts` inside WSL. So for a Windows-native Orpheus session,
  // assemble through the generic bundled env with --tts_engine xtts (as
  // reassembly-bridge does), on CPU. If normalization failed (session still
  // WSL-resident), fall back to the original WSL spawn with the real engine.
  // On macOS/Linux Orpheus runs natively (no WSL) — leave its assembly untouched
  // (gated by platform === 'win32'), as are all non-Orpheus engines everywhere.
  const isWindows = process.platform === 'win32';
  const isOrpheus = settings.ttsEngine?.toLowerCase() === 'orpheus';
  const sessionStillInWsl = isWslUncPath(prepInfo.sessionDir);
  const assembleOrpheusNative = isWindows && isOrpheus && !sessionStillInWsl;
  const asmInvocation = assembleOrpheusNative ? pythonInvocation(undefined) : pythonInvocation(settings.ttsEngine);
  const asmEngineArg = assembleOrpheusNative ? 'xtts' : settings.ttsEngine;
  // Route through WSL only for a Windows Orpheus session that's still WSL-resident.
  const asmRoutingEngine = (isWindows && isOrpheus && sessionStillInWsl) ? settings.ttsEngine
    : (assembleOrpheusNative ? undefined : settings.ttsEngine);

  // Map UI device names to e2a CLI device names (app.py expects uppercase).
  // Same resolver as the worker/prep paths so 'auto' resolves identically and
  // assembly runs on the same device the audio was synthesized on. Native Orpheus
  // assembly forces CPU (no GPU work; avoids any CUDA init in the bundled env).
  const asmDeviceArg = assembleOrpheusNative ? 'CPU' : resolveTtsDeviceArg(settings.device);

  const args = [
    ...asmInvocation.args,
    appPath,
    '--headless',
    // Only include --ebook if we have a path (assembly_only doesn't require it)
    ...(config.epubPath ? ['--ebook', config.epubPath] : []),
    '--output_dir', config.outputDir,
    '--session', prepInfo.sessionId,
    // Pass --session_dir when session may not be in default e2a tmp location
    // (e.g., cached sessions in BFP audiobook folder)
    ...(prepInfo.sessionDir ? ['--session_dir', prepInfo.sessionDir] : []),
    // When an RVC enhancement pass ran, assemble the ENHANCED sentence set
    // (chapter mapping / metadata / VTT still come from the session state).
    ...(session.rvcSentencesDir ? ['--sentences_dir', session.rvcSentencesDir] : []),
    '--device', asmDeviceArg,
    '--language', settings.language,
    '--tts_engine', asmEngineArg,  // Required for session setup even in assembly mode
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

    // Freshness watermark: only an m4b modified at/after this instant counts as
    // THIS run's output. The session is normalized to Windows BEFORE assembly, so
    // in the normal (native) case e2a writes to config.outputDir through the
    // Windows filesystem and mtimes share this clock. In the WSL fallback
    // (session still \\wsl$), config.outputDir is still a Windows path reached
    // via /mnt/<drive> (drvfs), so the mtime is stamped by the Windows filesystem
    // too. A 2s slack absorbs coarse timestamp granularity — a stale m4b from a
    // previous run is minutes/hours older, never within 2s.
    const assemblyStartMs = Date.now();
    const FRESHNESS_SLACK_MS = 2000;

    // Orpheus generation ran in WSL, but after normalization the session lives on
    // Windows, so assembly runs natively here (asmRoutingEngine is undefined →
    // native spawn). Only a failed normalization keeps it on the WSL path.
    session.assemblyProcess = spawnWithWslSupport(
      asmInvocation.command,
      args,
      {
        cwd: getDefaultE2aPath(),
        env: buildCondaSpawnEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' }),
        shell: false
      },
      asmRoutingEngine  // WSL only if the session is still WSL-resident
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
      rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
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
      writeWorkerLog(`[ASSEMBLY] ${output.trim()}`);

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
          detectedPath = wslToWindowsPath(detectedPath);
          console.log('[PARALLEL-TTS] Converted WSL output path to Windows:', detectedPath);
        }
        outputPath = detectedPath;
      }
    });

    session.assemblyProcess.stderr?.on('data', (data: Buffer) => {
      stderr = appendCapped(stderr, data.toString());
      writeWorkerLog(`[ASSEMBLY STDERR] ${data.toString().trim()}`);
    });

    session.assemblyProcess.on('close', async (code) => {
      session.assemblyProcess = null;
      console.log('[PARALLEL-TTS] Assembly process exited with code:', code);

      if (code === 0) {
        // Find the output file if not detected from logs. Only an m4b written
        // DURING this assembly run qualifies — a most-recent scan with no
        // freshness gate could adopt a previous run's audiobook as this run's
        // output.
        if (!outputPath) {
          try {
            const files = await fs.readdir(config.outputDir);
            // Filter for .m4b files, excluding macOS resource forks (._* files)
            const m4bFiles = files.filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
            let mostRecent: { file: string; mtime: number } | null = null;
            for (const file of m4bFiles) {
              const filePath = path.join(config.outputDir, file);
              const stat = await fs.stat(filePath);
              if (stat.mtimeMs < assemblyStartMs - FRESHNESS_SLACK_MS) continue; // stale — predates this run
              if (!mostRecent || stat.mtimeMs > mostRecent.mtime) {
                mostRecent = { file, mtime: stat.mtimeMs };
              }
            }
            if (mostRecent) {
              outputPath = path.join(config.outputDir, mostRecent.file);
            }
          } catch (err) {
            console.error('[PARALLEL-TTS] Error finding output file:', err);
          }
        }

        if (!outputPath) {
          // Zero exit but nothing fresh on disk: e2a claims success yet produced
          // no audiobook in this run. Something is deeply wrong (wrong output
          // dir, silent e2a failure) — refuse to adopt any pre-existing m4b.
          reject(new Error(
            `Assembly exited successfully but no audiobook created during this run was found in ${config.outputDir} ` +
            `(started ${new Date(assemblyStartMs).toISOString()}). Any existing .m4b files there predate this run and were not adopted. ` +
            `This indicates a deeper problem with the assembly step — check the worker log.`
          ));
          return;
        }

        const finalPath = outputPath;

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
            console.log('[PARALLEL-TTS] Calling applyM4bMetadata...');
            const processedPath = await applyM4bMetadata(finalPath, config.metadata, config.outputDir, config.bfpPath);
            console.log('[PARALLEL-TTS] After metadata, path:', processedPath);
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
          resolve(await finalizeOutputPath(finalPath, session));
        }
      } else {
        // Assembly FAILED. Do NOT scan the output dir for an m4b to adopt — the
        // most-recently-modified file there is very likely a PREVIOUS run's
        // audiobook, and resolving with it silently reports success on a failed
        // assembly. Fail loudly with the captured stderr tail instead.
        const stderrTail = stderr.trim().slice(-4000);
        console.error(`[PARALLEL-TTS] Assembly failed with code ${code}. Stderr tail:\n${stderrTail}`);
        reject(new Error(
          `Assembly failed with exit code ${code}.` +
          (stderrTail ? ` Stderr tail:\n${stderrTail}` : ' (no stderr captured — see the worker log)')
        ));
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
 * Apply metadata to m4b file (bundled ffmpeg via metadata-tools) and optionally rename
 */
async function applyM4bMetadata(
  inputPath: string,
  metadata: MetadataConfig,
  outputDir: string,
  bfpPath?: string
): Promise<string> {
  const hasMetadataChanges = metadata.title || metadata.author || metadata.year || metadata.coverPath;
  const hasRename = metadata.outputFilename;

  console.log('[PARALLEL-TTS] applyM4bMetadata called with:');
  console.log('[PARALLEL-TTS]   inputPath:', inputPath);
  console.log('[PARALLEL-TTS]   outputDir:', outputDir);
  console.log('[PARALLEL-TTS]   bfpPath:', bfpPath);
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

  // Always resolve cover from manifest as authoritative source,
  // then allow provided metadata.coverPath to override if valid
  {
    const libRoot = manifestService.getLibraryBasePath();
    const candidates: string[] = [];
    if (bfpPath) candidates.push(path.basename(bfpPath));
    if (outputDir) {
      const parent = path.basename(path.dirname(outputDir));
      if (parent !== 'projects') candidates.push(parent);
    }

    let manifestCoverPath: string | undefined;
    for (const projectId of candidates) {
      try {
        const mResult = await manifestService.getManifest(projectId);
        if (mResult.success && mResult.manifest?.metadata?.coverPath) {
          const absCover = path.join(libRoot, mResult.manifest.metadata.coverPath);
          if (fsSync.existsSync(absCover)) {
            manifestCoverPath = absCover;
            break;
          }
        }
      } catch { /* ignore */ }
    }

    if (metadata.coverPath && fsSync.existsSync(metadata.coverPath)) {
      console.log('[PARALLEL-TTS] Using provided coverPath:', metadata.coverPath);
    } else if (manifestCoverPath) {
      metadata.coverPath = manifestCoverPath;
      console.log('[PARALLEL-TTS] Resolved cover from manifest:', manifestCoverPath);
    } else {
      console.warn('[PARALLEL-TTS] Could not resolve cover from any source');
    }
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
      console.error('[PARALLEL-TTS] Cover file not found at:', metadata.coverPath);
    }
  } else {
    console.log('[PARALLEL-TTS] No coverPath available - M4B will have no custom cover');
  }

  // Apply metadata if we have any changes. applyMetadata swaps the cover and
  // drops any existing/Calibre cover in a single lossless remux — no separate
  // cover-strip pass needed.
  if (Object.keys(metadataToApply).length > 0) {
    console.log('[PARALLEL-TTS] Applying metadata to M4B:', JSON.stringify(metadataToApply, null, 2));
    await applyMetadata(inputPath, metadataToApply, { timeoutMs: 300_000 });
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

/**
 * Emit a terminal failure for a job that fails BEFORE a ConversionSession with
 * prepInfo exists (e.g. missing outputDir, prep crash, bad resume info). These
 * early-return paths can't use emitComplete (which requires session.prepInfo), so
 * the renderer's event-based completion listener would otherwise never fire and
 * the job would hang in "running" forever.
 */
function emitJobFailure(jobId: string, error: string): void {
  if (!mainWindow) return;
  const progress: AggregatedProgress = {
    phase: 'error',
    totalSentences: 0,
    completedSentences: 0,
    completedInSession: 0,
    percentage: 0,
    activeWorkers: 0,
    workers: [],
    estimatedRemaining: 0,
    message: error,
    error
  };
  rendererSend('parallel-tts:progress', { jobId, progress });
  rendererSend('parallel-tts:complete', { jobId, success: false, error });
}

function emitProgress(session: ConversionSession): void {
  if (!mainWindow || !session.prepInfo) return;

  const activeWorkers = session.workers.filter(w => w.status === 'running').length;
  const now = Date.now();

  // Count completedSentences from all workers (each progress line = 1 conversion)
  // This works for both regular and resume jobs since skipped sentences don't emit progress
  const sentencesDoneInSession = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

  // EXACT real sentences rendered this session (sum of per-chunk counts over the chunks
  // actually converted). Present only when rawSentenceCounts is known; the frontend uses
  // it for a precise sentences/min and falls back to the chunk×average estimate otherwise.
  const rawSentencesDoneInSession = session.prepInfo.rawSentenceCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedSentences || 0), 0)
    : undefined;

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

  // The throughput rate (chunks/min + true sentences/min) is NOT put in this status
  // message anymore — it lives solely in the job-progress "Speed" stat, which derives
  // both numbers from the chunk→sentence ratio (totalRawSentencesInJob/totalChunksInJob)
  // and formats them as "X chunks/min (~Y sentences/min)". Duplicating it in the worker
  // message showed the number in two places (and only chunks/min there), so it's gone.

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
    totalRawSentences: session.prepInfo.totalRawSentences ?? session.prepInfo.totalSentences,
    completedSentences: totalCompleted,
    completedInSession: sentencesDoneInSession, // For accurate ETA calculation
    rawCompletedInSession: rawSentencesDoneInSession, // EXACT real sentences this session (precise sentences/min)
    percentage: Math.round(percentage),
    activeWorkers,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining,
    message: (session.downloadNote && sentencesDoneInSession === 0)
      ? session.downloadNote
      : (session.orpheusMemNote && sentencesDoneInSession === 0)
        ? session.orpheusMemNote
        : session.isResumeJob
          ? `Resuming: ${sentencesDoneInSession} new`
          : `${activeWorkers} ${activeWorkers === 1 ? 'worker' : 'workers'}`,
    // The resolved Orpheus memory level, for a persistent queue badge.
    orpheusMemoryLevel: session.orpheusMemLevel,
    // Historical data for accurate elapsed time display
    totalElapsedSeconds,
    historicalRate: session.persistentState?.historicalSentencesPerMinute
  };

  rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });

  // Save state incrementally (every N sentences)
  const lastSave = lastStateSave.get(session.jobId) || { sentences: 0, time: 0 };
  if (sentencesDoneInSession - lastSave.sentences >= STATE_SAVE_SENTENCE_INTERVAL) {
    lastStateSave.set(session.jobId, { sentences: sentencesDoneInSession, time: now });
    savePersistentState(session).catch(err => {
      console.error('[PARALLEL-TTS] Incremental state save failed:', err);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU arbitration (keep the AI-cleanup LLM and the TTS engine off the GPU at once)
// ─────────────────────────────────────────────────────────────────────────────

/** Release the GPU lock this job holds, if any. Idempotent — invoked from every
 *  terminal path (completion, failure, cancel) so the lock can never leak. */
function releaseSessionGpu(session: ConversionSession): void {
  if (session.holdsGpu) {
    session.holdsGpu = false;
    releaseGpu(gpuOwnerForTts(session.jobId));
    console.log(`[PARALLEL-TTS] Released GPU lock for job ${session.jobId}`);
  }
}

/** Emit a 'preparing'-phase progress message (used while a job waits for the GPU). */
function emitGpuWaitProgress(session: ConversionSession, message: string): void {
  if (!mainWindow || !session.prepInfo) return;
  const progress: AggregatedProgress = {
    phase: 'preparing',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences: 0,
    completedInSession: 0,
    percentage: 0,
    activeWorkers: 0,
    workers: session.workers,
    estimatedRemaining: 0,
    message,
  };
  rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
}

/** Approximate free VRAM (MB) a job's engine needs to load without OOM, for the
 *  external-process preflight. Orpheus (vLLM) pre-reserves gpu_memory_utilization ×
 *  TOTAL VRAM, so that much must actually be free; other engines need roughly a
 *  model + CUDA context + working set. Returns 0 when there's no NVIDIA GPU. */
async function requiredVramMB(ttsEngine: string): Promise<number> {
  const mem = await getGpuMemMB();
  if (!mem) return 0; // no NVIDIA GPU → nothing to gate on
  if (ttsEngine === 'orpheus') {
    // Orpheus now takes a BOUNDED slice (the tier cap), not a fraction of total, so the
    // gate only needs the weights+KV floor free — computeSafeGpuUtil then sizes the
    // reservation within whatever is actually free at spawn.
    return ORPHEUS_MIN_VRAM_MB;
  }
  return 4500; // XTTS / F5 / Voxtral conservative floor
}

/**
 * Take the shared GPU before a job loads its TTS model.
 *
 * (1) Acquire the in-process mutex — this asks the local AI-cleanup LLM (a
 *     separate, long-lived GPU server) to step off so the two never co-reside in
 *     VRAM (the cause of the model-load CUDA-OOM). A 10-minute timeout is a
 *     deadlock backstop: a stuck holder can't wedge TTS forever.
 * (2) Best-effort VRAM preflight — wait until enough memory is actually free, to
 *     ride out GPU users OUTSIDE this process (a training run, ollama, another
 *     app) that the mutex can't see. Never fails the job; on timeout it proceeds
 *     and the worker's own OOM-retry is the backstop.
 *
 * No-op for CPU jobs.
 */
async function acquireGpuForJob(session: ConversionSession): Promise<void> {
  const engine = session.config.settings.ttsEngine;
  const deviceArg = resolveTtsDeviceArg(session.config.settings.device, engine);
  // Orpheus via WSL brings its OWN CUDA runtime and ALWAYS loads vLLM on the GPU, even
  // if the device resolved to CPU (old build / explicit CPU pick). So it must still be
  // VRAM-sized here — otherwise vLLM falls back to orpheus.py's 0.70-of-total default
  // (~17 GiB on a 24 GiB card) and maxes the GPU regardless of the chosen level.
  const orpheusOnGpu = engine === 'orpheus'
    && (deviceArg === 'CUDA' || (process.platform === 'win32' && shouldUseWsl2ForOrpheus()));
  if (deviceArg === 'CPU' && !orpheusOnGpu) return;
  const jobId = session.jobId;
  const orpheusViaWsl = engine === 'orpheus' && process.platform === 'win32' && shouldUseWsl2ForOrpheus();

  // Never spawn into a wedged VM — it can only deepen the wedge. Fail loudly instead.
  if (orpheusViaWsl && isWslWedged()) {
    session.gpuPreflightError = wslWedgedMessage();
    console.error(`[PARALLEL-TTS] Job ${jobId}: ${session.gpuPreflightError}`);
    return;
  }

  const held = gpuHolder();
  if (held) {
    const who = held === GPU_OWNER_LLAMA ? 'AI cleanup' : held;
    console.log(`[PARALLEL-TTS] Job ${jobId} waiting for GPU (held by ${who})...`);
    emitGpuWaitProgress(session, `Waiting for the GPU (in use by ${who})…`);
  }
  await acquireGpu(gpuOwnerForTts(jobId), { timeoutMs: 10 * 60_000 });
  session.holdsGpu = true;
  console.log(`[PARALLEL-TTS] Job ${jobId} acquired GPU lock`);

  // Evict any model the AI-cleanup step left resident in Ollama. Ollama is a SEPARATE
  // process the mutex can't coordinate; it pins the cleanup model in VRAM for its 5-min
  // keep_alive window, so a cleanup→TTS handoff otherwise finds ~9 GB still held and
  // Orpheus/vLLM OOM-crashes at load. Holding the mutex here, we actively unload it so
  // the VRAM floor gate below measures a GPU that's actually free. Best-effort.
  const evicted = await unloadOllamaModels();
  if (evicted > 0) {
    console.log(`[PARALLEL-TTS] Job ${jobId} evicted ${evicted} resident Ollama model(s) to free VRAM for TTS`);
  }

  // Orpheus (vLLM) reserves gpu_memory_utilization × TOTAL VRAM up front. A fixed
  // fraction over-commits a desktop-shared GPU and WDDM spills the overflow into
  // system RAM → whole-machine freeze. Now that the cleanup LLM has stepped off (we
  // hold the mutex), size the fraction to what is ACTUALLY FREE minus a desktop
  // margin, so vLLM never allocates past physical VRAM. Below the weights+KV floor we
  // abort with a clear message rather than spilling into a freeze.
  if (engine === 'orpheus') {
    // Mac/MPS (MLX backend): there is no vLLM reservation to size and no nvidia-smi to
    // read — memory is governed by the tier's batch width + MLX cache limit, resolved
    // from unified-RAM bands (resolveConcreteOrpheusTier(null, null)) at spawn env
    // build. Everything below is CUDA-only sizing; running it here aborted every Mac
    // job with "nvidia-smi didn't respond". Just record the tier for OOM learning and
    // the queue note.
    if (!orpheusOnGpu) {
      const tier = resolveConcreteOrpheusTier(null, null);
      const profile = orpheusMemoryProfile(tier);
      session.orpheusTier = tier; // remembered so an OOM can lower the auto ceiling
      session.orpheusMemLevel = orpheusTierLabel(tier);
      session.orpheusMemNote =
        `Orpheus memory level: ${orpheusTierLabel(tier)} — batch ${profile.batchSize}, ` +
        `MLX cache limit ${profile.mlxCacheLimitGB} GB.`;
      console.log(`[PARALLEL-TTS] Job ${jobId} Orpheus memory '${getOrpheusMemoryTier()}' → '${tier}' (MLX: batch ${profile.batchSize}, cache ${profile.mlxCacheLimitGB} GB)`);
      emitGpuWaitProgress(session, session.orpheusMemNote);
      return;
    }

    // CLEAR-GUEST GATE: a previous worker can still be tearing down inside WSL (its
    // vLLM holds ~13-18 GB until it fully exits). Spawning alongside it both doomed
    // the new worker (sized against a transiently full card → util=0.07 → "No
    // available memory for cache blocks") and set up the kill-collision that wedged
    // the VM. Wait for the guest to actually clear before sizing.
    if (orpheusViaWsl) {
      const clear = await waitForGuestExit('ebook2audiobook.*\\.py', 60_000, `job ${jobId} preflight`);
      if (!clear) {
        if (isWslWedged()) {
          session.gpuPreflightError = wslWedgedMessage();
        } else {
          session.gpuPreflightError =
            `A previous TTS worker is still running inside WSL and didn't exit within 60s. ` +
            `Wait for it to finish (or run \`wsl --shutdown\`) and try again.`;
        }
        console.error(`[PARALLEL-TTS] Job ${jobId}: ${session.gpuPreflightError}`);
        return;
      }
    }

    // VRAM-FLOOR GATE: the dying worker's VRAM can take a few more seconds to come
    // back even after the process is gone. Wait for the weights+KV floor rather than
    // sizing a doomed job against a transiently full card.
    //
    // The gate must require the engine floor PLUS the desktop margin, because the sizing
    // below (computeSafeGpuUtil) subtracts that margin from free before reserving. Gating
    // on the bare floor let a GPU with ORPHEUS_MIN_VRAM_MB free through, after which sizing
    // took off the margin and reserved BELOW the weights+KV floor → vLLM OOM at load
    // (observed with the AI-cleanup model still resident: ~9 GB free passed an 8.2 GB gate,
    // then reserved only ~6 GB and couldn't fit the 6.6 GB weights).
    const orpheusFreeFloorMB = ORPHEUS_MIN_VRAM_MB + DESKTOP_VRAM_MARGIN_MB;
    const floorWait = await waitForFreeVram(orpheusFreeFloorMB, {
      timeoutMs: 90_000,
      onWait: (freeMB, neededMB) => {
        console.log(`[PARALLEL-TTS] Job ${jobId} waiting for VRAM floor: ${freeMB} MB free, need ~${neededMB} MB`);
        emitGpuWaitProgress(
          session,
          `Waiting for GPU memory to free up (${(freeMB / 1024).toFixed(1)} GB free, need ~${(neededMB / 1024).toFixed(1)} GB)…`,
        );
      },
    });
    if (!floorWait.ok) {
      session.gpuPreflightError =
        `Not enough free GPU memory for Orpheus (${((floorWait.freeMB ?? 0) / 1024).toFixed(1)} GB free, ` +
        `needs ~${(orpheusFreeFloorMB / 1024).toFixed(1)} GB) after waiting 90s. ` +
        `Close GPU-heavy apps and try again, or run on CPU.`;
      console.error(`[PARALLEL-TTS] Job ${jobId}: ${session.gpuPreflightError}`);
      return;
    }

    // The memory tier is an ABSOLUTE cap on how much VRAM Orpheus may take, so it
    // leaves the rest of the card free for the browser/desktop — however empty the GPU
    // looks at launch. If the wanted level doesn't fit right now, STEP DOWN to the
    // highest level the free VRAM can manage rather than failing the job.
    const mem = await getGpuMemMB();
    const free = mem?.freeMB ?? null;
    const total = mem?.totalMB ?? null;
    const wanted = resolveConcreteOrpheusTier(free, total);
    const fit = fitOrpheusTier(wanted, free, total);
    const tier = fit.tier;
    session.orpheusTier = tier; // remembered so an OOM can lower the auto ceiling
    session.orpheusMemLevel = orpheusTierLabel(tier);
    const profile = orpheusMemoryProfile(tier);
    session.orpheusVllmBatch = profile.vllmBatch; // match submission batch to KV cache
    const ceiling = Number(process.env.ORPHEUS_GPU_MEM_UTIL) || profile.ceiling;
    const sized = await computeSafeGpuUtil(profile.capMB, profile.marginMB, ceiling);
    console.log(`[PARALLEL-TTS] Job ${jobId} Orpheus memory '${getOrpheusMemoryTier()}' → wanted '${wanted}', using '${tier}'${fit.steppedDown ? ' (stepped down)' : ''} (cap ${profile.capMB} MB, ceiling ${ceiling})`);
    if (sized.totalMB !== null && sized.freeMB !== null) {
      session.orpheusGpuMemUtil = sized.util;
      const reserveGB = ((sized.reserveMB ?? 0) / 1024).toFixed(1);
      const freeGB = (sized.freeMB / 1024).toFixed(1);
      const leftGB = ((sized.freeMB - (sized.reserveMB ?? 0)) / 1024).toFixed(1);
      console.log(
        `[PARALLEL-TTS] Job ${jobId} Orpheus VRAM sizing: ${sized.freeMB} MB free / ` +
        `${sized.totalMB} MB total → reserve ~${reserveGB} GB (util=${sized.util}), leaving ~${leftGB} GB free` +
        (sized.sufficient ? '' : ' (LOW)'),
      );
      // Build the "what it's using and why" note (shown in the queue). Never abort —
      // step down and run at the best level the machine can manage.
      const lvl = orpheusTierLabel(tier);
      if (!fit.fits) {
        session.orpheusMemNote =
          `Very low GPU memory (${freeGB} GB free) — running at the lowest level (${lvl}, ~${reserveGB} GB). ` +
          `It may run out; close GPU-heavy apps or run on CPU if it fails.`;
      } else if (fit.steppedDown) {
        session.orpheusMemNote =
          `Only ${freeGB} GB of GPU memory is free, so Orpheus dropped to the ${lvl} level ` +
          `(using ~${reserveGB} GB, leaving ~${leftGB} GB free). Close GPU-heavy apps for a faster level.`;
      } else {
        session.orpheusMemNote =
          `Orpheus memory level: ${lvl} — using ~${reserveGB} GB, leaving ~${leftGB} GB free.`;
      }
      emitGpuWaitProgress(session, session.orpheusMemNote);
    } else {
      // VRAM unreadable (nvidia-smi didn't respond). We have NO basis to size vLLM, and
      // guessing a limit could still crash — so fail loudly with an actionable message
      // instead of silently picking a number. The run loop aborts on gpuPreflightError.
      session.gpuPreflightError =
        `Couldn't read your GPU's memory (nvidia-smi didn't respond), so Orpheus can't be ` +
        `sized safely and could crash the machine. Check your NVIDIA drivers, or run this ` +
        `job on the CPU (Settings → Pipeline Defaults).`;
      console.warn(`[PARALLEL-TTS] Job ${jobId} Orpheus: VRAM unreadable — aborting rather than guessing a util`);
    }
    return;
  }

  // Other engines (XTTS / F5 / Voxtral): best-effort preflight against a conservative
  // floor, to ride out GPU users outside this process. Never fails the job.
  const requiredMB = await requiredVramMB(engine);
  if (requiredMB > 0) {
    const r = await waitForFreeVram(requiredMB, {
      timeoutMs: 180_000,
      onWait: (freeMB, neededMB) => {
        console.log(`[PARALLEL-TTS] Job ${jobId} waiting for VRAM: ${freeMB} MB free, need ~${neededMB} MB`);
        emitGpuWaitProgress(
          session,
          `Waiting for GPU memory (${(freeMB / 1024).toFixed(1)} GB free, need ~${(neededMB / 1024).toFixed(1)} GB)…`,
        );
      },
    });
    if (!r.ok) {
      console.warn(
        `[PARALLEL-TTS] Job ${jobId} proceeding with low VRAM ` +
        `(${r.freeMB} MB free, wanted ${requiredMB} MB) after preflight timeout`,
      );
    }
  }
}

function emitComplete(
  session: ConversionSession,
  success: boolean,
  outputPath?: string,
  error?: string
): void {
  // Free the GPU as soon as the job ends so AI cleanup can resume promptly.
  releaseSessionGpu(session);

  if (!mainWindow || !session.prepInfo) {
    return;
  }

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

  // Register the assembled audiobook in the project manifest from the MAIN process,
  // so a completed m4b ALWAYS lands in the library — even if the renderer misses this
  // completion event or the job lacks a bfpPath (the renderer-side auto-link in
  // queue.service silently skips in those cases). Fire-and-forget; never blocks the
  // completion. Only fires when the output is the finished m4b (not a sentences dir).
  if (success && outputPath && outputPath.toLowerCase().endsWith('.m4b')) {
    // Carry the TTS voice through as the narrator (e2a's `fineTuned` is the voice).
    // Strip any directory for custom-voice paths; a bare voice name passes through.
    const rawVoice = session.config?.settings?.fineTuned;
    const narrator = rawVoice
      ? (rawVoice.includes('/') || rawVoice.includes('\\') ? path.basename(rawVoice) : rawVoice)
      : undefined;
    manifestService.registerAudiobookOutput(outputPath, { narrator })
      .then((reg) => {
        if (reg.skipped) console.warn('[PARALLEL-TTS] Audiobook not registered (outside library):', outputPath);
        else if (!reg.success) console.error('[PARALLEL-TTS] Failed to register audiobook in manifest:', reg.error);
        else console.log('[PARALLEL-TTS] Registered audiobook in manifest:', outputPath);
      })
      .catch((err) => console.error('[PARALLEL-TTS] Manifest registration threw:', err));
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
    // Real sentence count across all chunks (chunks pack 2-3). Additive/optional — lets the
    // analytics panel derive a true sentences/min from the chunk-based sentencesPerMinute.
    totalRawSentences: session.prepInfo.totalRawSentences,
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

  rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
  rendererSend('parallel-tts:complete', {
    jobId: session.jobId,
    success,
    outputPath,
    error,
    duration,
    analytics,
    // Present only when an RVC enhancement pass ran; persisted as a separate
    // 'rvc' analytics entry by the renderer.
    rvcAnalytics: session.rvcAnalytics,
    sessionId: session.prepInfo?.sessionId,
    sessionDir: session.prepInfo?.sessionDir
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
  // - If bfpPath is set, output directly to BFP audiobook folder
  // - Otherwise, require outputDir to be set
  let effectiveOutputDir: string;

  if (config.bfpPath) {
    // Output directly to BFP audiobook folder (no temp dir needed)
    effectiveOutputDir = getAudiobookDirFromBfp(config.bfpPath);
    await fs.mkdir(effectiveOutputDir, { recursive: true });
    console.log(`[PARALLEL-TTS] Outputting directly to BFP audiobook folder: ${effectiveOutputDir}`);
  } else if (config.outputDir && config.outputDir.trim() !== '') {
    // No BFP: output directly to outputDir
    effectiveOutputDir = config.outputDir;
  } else {
    const error = 'Output directory not configured. Please set the audiobook output folder in Settings.';
    console.error('[PARALLEL-TTS]', error);
    await logger.failJob(jobId, error);
    stopPowerBlock();
    emitJobFailure(jobId, error);
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
    prepInfo = await prepareSession(config.epubPath, config.settings, jobId);
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
    emitJobFailure(jobId, error);
    return { success: false, error };
  }

  // Test mode: cap total sentences to process
  if (config.settings.testMode && config.settings.testSentences && config.settings.testSentences > 0) {
    const originalTotal = prepInfo.totalSentences;
    prepInfo.totalSentences = Math.min(prepInfo.totalSentences, config.settings.testSentences);
    console.log(`[PARALLEL-TTS] Test mode: limiting to ${prepInfo.totalSentences} of ${originalTotal} sentences`);
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
    assemblyProcess: null
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
    rendererSend('parallel-tts:progress', { jobId, progress });

    // Emit session-created event so frontend can save sessionId to BFP for pause/resume
    rendererSend('parallel-tts:session-created', {
      jobId,
      sessionId: prepInfo.sessionId,
      sessionDir: prepInfo.sessionDir,
      processDir: prepInfo.processDir,
      totalSentences: prepInfo.totalSentences,
      totalChapters: prepInfo.totalChapters
    });
  }

  // Take the GPU before any worker loads a TTS model, so the local AI-cleanup LLM
  // steps off and the two never co-reside in VRAM (the model-load CUDA-OOM cause).
  // Blocks until the GPU is free; no-op for CPU jobs. See gpu-arbiter.
  await acquireGpuForJob(session);

  // Not enough free VRAM to load the engine without spilling into system RAM (which
  // freezes the machine) — abort cleanly with a message instead of starting workers.
  if (session.gpuPreflightError) {
    releaseSessionGpu(session);
    const msg = session.gpuPreflightError;
    session.gpuPreflightError = undefined;
    console.warn(`[PARALLEL-TTS] Job ${jobId} aborted before workers: ${msg}`);
    return { success: false, error: msg };
  }

  // The GPU wait can be long (a previous job, or the VRAM preflight). If the user
  // cancelled in the meantime, don't start workers — just release and bail.
  if (session.cancelled || !activeSessions.has(jobId)) {
    releaseSessionGpu(session);
    console.log(`[PARALLEL-TTS] Job ${jobId} cancelled while waiting for the GPU`);
    return { success: false, error: 'Cancelled' };
  }

  // Start workers - stagger on Windows to avoid conda temp file race condition
  // On Windows, conda uses temp files that conflict when multiple processes start simultaneously
  // On Mac/Linux, we can start all workers immediately
  const isWindows = process.platform === 'win32';
  const WINDOWS_WORKER_STAGGER_MS = 2000; // 2 seconds between worker starts on Windows

  try {
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
  } catch (err) {
    // A throw between acquiring the GPU and the workers running would leak the
    // lock (the completion poll below never starts). Release it before bailing.
    releaseSessionGpu(session);
    throw err;
  }

  // Return immediately - completion is handled via events
  return new Promise((resolve) => {
    // Set up a listener for completion
    const checkComplete = setInterval(() => {
      if (!activeSessions.has(jobId)) {
        clearInterval(checkComplete);
        // Backstop GPU release: covers any terminal path that deletes the session
        // without going through emitComplete()/stopParallelConversion().
        releaseSessionGpu(session);
        // Get the result from the last emitted event
        // For now, just return success - the actual result is sent via IPC
        resolve({ success: true });
      }
    }, 1000);
  });
}

/**
 * Headless single-range batch render for the CLI (`bookforge-tts --mode tts`).
 *
 * Drives the REAL audiobook path with zero reimplementation: `prepareSession` packs
 * the text into generation chunks (~300 chars for Orpheus) and creates the e2a
 * session; a single `worker.py` renders every chunk (WSL-safe for Orpheus, VRAM-tier
 * sized by `acquireGpuForJob`); each worker's own close handler drives
 * `checkAllWorkersComplete`, whose `skipAssembly` branch runs
 * `normalizeWslSessionToWindows` (moves the WSL output onto a Windows-native path) and
 * then deletes the session. We stop there — the caller concatenates the per-sentence
 * FLACs. Every inter-clip gap is already baked into each `{i}.flac` by orpheus.py
 * `_save_audio`, so a plain numeric-order concat is byte-faithful to what assembly
 * would join.
 *
 * NO IPC (mainWindow stays null → every `rendererSend` no-ops; `emitComplete` releases
 * the GPU and returns early), NO assembly, NO powerSaveBlocker, NO persistent state.
 * Fails loud on every missing precondition (NO FALLBACKS): 0 chunks, GPU preflight
 * shortfall, or an incomplete sentence set all throw with a naming message.
 *
 * Returns the directory holding the per-sentence FLACs and the chunk count.
 */
export async function renderRangeHeadless(
  inputPath: string,
  settings: ParallelTtsSettings,
  opts?: { jobId?: string }
): Promise<{
  sentencesDir: string;
  totalSentences: number;
  scratchSessionDir: string;
  normalizedSessionDir: string;
}> {
  const jobId = opts?.jobId || `cli-${crypto.randomUUID()}`;

  // Real e2a prep — identical packing/session-creation to a UI job.
  const prepInfo = await prepareSession(inputPath, settings, jobId);
  if (!prepInfo.totalSentences || prepInfo.totalSentences < 1) {
    throw new Error(`renderRangeHeadless: prep produced 0 generation chunks for ${inputPath}`);
  }
  // The ORIGINAL scratch session location (WSL-native for Orpheus-via-WSL). Captured
  // NOW because normalizeWslSessionToWindows repoints prepInfo.sessionDir later; the
  // caller needs both locations to clean up after a successful concat.
  const scratchSessionDir = prepInfo.sessionDir;

  // One worker over the whole range.
  const ranges = calculateSentenceRanges(prepInfo.totalSentences, 1);
  const workers: WorkerState[] = ranges.map((range, i) => ({
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

  const config: ParallelConversionConfig = {
    workerCount: 1,
    epubPath: inputPath,
    outputDir: '',           // unused on the skipAssembly path (returns the sentences dir)
    settings,
    parallelMode: 'sentences',
    skipAssembly: true       // stop after generation; caller concatenates the FLACs
  };

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

  // Take the GPU (mutex + VRAM-tier sizing + WSL clear-guest / VRAM-floor gates).
  await acquireGpuForJob(session);
  if (session.gpuPreflightError) {
    const msg = session.gpuPreflightError;
    releaseSessionGpu(session);
    activeSessions.delete(jobId);
    throw new Error(`renderRangeHeadless: GPU preflight failed: ${msg}`);
  }

  // Spawn the worker (WSL-safe for Orpheus) + the stuck-worker watchdog. The worker's
  // close handler drives checkAllWorkersComplete → skipAssembly branch → session delete.
  try {
    startWorker(session, 0, {
      sentenceStart: workers[0].sentenceStart,
      sentenceEnd: workers[0].sentenceEnd
    });
    startWatchdog(session);
  } catch (err) {
    releaseSessionGpu(session);
    activeSessions.delete(jobId);
    throw err;
  }

  // Wait for the machinery to finish and drop the session, then backstop-release the
  // GPU (idempotent — guarded by session.holdsGpu), mirroring startParallelConversion.
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (!activeSessions.has(jobId)) {
        clearInterval(poll);
        releaseSessionGpu(session);
        resolve();
      }
    }, 1000);
  });

  // Terminal failure? Throw the REAL cause (worker error incl. stderr tail) — headless,
  // emitComplete was a no-op, so completionError is the only carrier. Without this the
  // caller would see the downstream "N files missing" symptom instead of the OOM/crash.
  if (session.completionError) {
    throw new Error(`renderRangeHeadless: ${session.completionError}`);
  }

  // normalizeWslSessionToWindows has repointed prepInfo.chaptersDirSentences at the
  // Windows-native FLAC dir. The skipAssembly path SKIPS the completeness gate, so we
  // enforce it here: every non-empty sentence must have a file, or we throw rather than
  // concatenate a hole-y set (NO FALLBACKS).
  const missing = await findMissingSentenceFiles(prepInfo);
  if (missing.length > 0) {
    const preview = missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', …' : '');
    throw new Error(
      `renderRangeHeadless: ${missing.length}/${prepInfo.totalSentences} sentence files missing (indices ${preview})`
    );
  }

  return {
    sentencesDir: toReadablePath(prepInfo.chaptersDirSentences),
    totalSentences: prepInfo.totalSentences,
    // Scratch locations for post-concat cleanup: the ORIGINAL session (WSL-native for
    // Orpheus-via-WSL) and the normalized Windows copy (== sessionDir when native).
    scratchSessionDir,
    normalizedSessionDir: prepInfo.sessionDir,
  };
}

/**
 * Stop a parallel conversion
 */
export async function stopParallelConversion(jobId: string): Promise<boolean> {
  const session = activeSessions.get(jobId);
  if (!session) return false;

  console.log(`[PARALLEL-TTS] Stopping conversion for job ${jobId}`);
  logger.log('WARN', jobId, 'Conversion stopped by user').catch(() => {});

  // Flag FIRST: close handlers fire as workers exit, and checkAllWorkersComplete must
  // see cancelled=true so the retry loop can never fight the stop (it once respawned a
  // stopping job's worker twice against a full GPU).
  session.cancelled = true;
  stopWatchdog(session);
  const ttsEngine = session.config?.settings?.ttsEngine;

  // Mark workers cancelled up front so the UI reflects the stop while the graceful
  // teardown below runs.
  for (const worker of session.workers) {
    if (worker.process) {
      worker.status = 'error';
      worker.error = 'Cancelled';
    }
  }

  if (shouldUseWslForSpawn(ttsEngine)) {
    // ONE session-scoped guest teardown, AWAITED: cooperative SIGTERM (the worker
    // exits itself between sentences, releasing the GPU) → verified wait → VM
    // terminate for a survivor. Never SIGKILL (the WSL wedge trigger). Awaiting also
    // means stopAndCacheParallelConversion flushes the cache only after files are
    // stable — the old fire-and-forget kill raced the flush.
    await destroyWslSessionWorkers(session, `stop ${jobId}`);
    for (const worker of session.workers) {
      if (worker.process) killWslWrapper(worker.process, `worker ${worker.id}`);
    }
    // Assembly runs NATIVELY on Windows for WSL sessions — normal tree kill.
    if (session.assemblyProcess) {
      killProcessTree(session.assemblyProcess, 'assembly');
    }
  } else {
    // Kill all worker processes (including child process trees like vLLM)
    for (const worker of session.workers) {
      if (worker.process) {
        killProcessTree(worker.process, `worker ${worker.id}`);
      }
    }
    // Kill assembly process if running
    if (session.assemblyProcess) {
      killProcessTree(session.assemblyProcess, 'assembly');
    }
  }

  // Safety net: reap any NATIVE batch workers for THIS job whose handle was lost
  // (retry/resume race, or a signal that didn't take), which the loop above couldn't
  // reach. Scoped to this job's session id — never touches the persistent
  // Listen/extension server. The WSL side is covered by the pattern teardown above.
  reapOrphanedSessionWorkers(session.prepInfo?.sessionId);

  // Clean up any orphaned vLLM processes that escaped the process tree
  cleanupOrphanedVllmProcesses();
  // Also clean up orphaned WSL processes — scoped to THIS session so a concurrent
  // job's worker can never be hit.
  cleanupWslOrphanedProcesses(session.prepInfo?.sessionId);

  // Emit cancelled analytics before cleanup
  emitCancelledAnalytics(session);

  // Clean up progress history
  progressHistory.delete(jobId);

  // Free the GPU so AI cleanup can resume.
  releaseSessionGpu(session);

  activeSessions.delete(jobId);
  return true;
}

/**
 * Promote an interrupted session's already-rendered sentences into the durable
 * project cache, so a later run can resume from them (the queue's auto-resume reads
 * the project cache, not the tmp session — and a fresh run's cleanSession deletes the
 * tmp). Best-effort and never throws.
 *
 * Guards against DOWNGRADING: cacheSessionToProject REPLACES the per-language cache,
 * so we only promote when our session has at least as many rendered sentences as the
 * cache already holds — never overwrite a more-complete cache with a partial one.
 */
async function flushPartialSessionToCache(session: ConversionSession): Promise<void> {
  try {
    const bfpPath = session.config.bfpPath;
    const sessionDir = session.prepInfo?.sessionDir;
    if (!bfpPath || !sessionDir) return;

    // Sentences actually on disk for this session = prior-run baseline (resume) + this run.
    const thisRun = session.workers.reduce((s, w) => s + w.completedSentences, 0);
    const ours = (session.isResumeJob ? (session.baselineCompleted || 0) : 0) + thisRun;
    if (ours <= 0) return; // nothing rendered → nothing to preserve

    const language = session.config.settings.language || 'en';
    let existing = 0;
    try {
      const sessions = await scanProjectSessions(bfpPath);
      existing = sessions.find(s => s.language === language)?.sentenceCount ?? 0;
    } catch { /* no cache yet */ }
    if (existing >= ours) {
      console.log(`[PARALLEL-TTS] Skip interrupt-cache for ${session.jobId}: cache already has ${existing} ≥ ${ours}`);
      return;
    }

    const r = await cacheSessionToProject(sessionDir, bfpPath, language);
    if (r.success) {
      console.log(`[PARALLEL-TTS] Interrupted session cached (${ours} sentences) → ${r.cachedSentencesDir}`);
    } else {
      console.warn(`[PARALLEL-TTS] Interrupt-cache failed for ${session.jobId}: ${r.error}`);
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Interrupt-cache error:', err);
  }
}

/**
 * Stop a job AND preserve its rendered sentences to the project cache.
 * stopParallelConversion is AWAITED — the workers are verifiably dead (files stable)
 * before the flush runs — and it drops the session from activeSessions, so we capture
 * the session ref first. Used by the stop IPC handler so a user-stopped job can be
 * resumed later.
 */
export async function stopAndCacheParallelConversion(jobId: string): Promise<boolean> {
  const session = activeSessions.get(jobId);
  const stopped = await stopParallelConversion(jobId);
  if (session) await flushPartialSessionToCache(session);
  return stopped;
}

/**
 * Flush every active session to the project cache (best-effort, time-bounded) — for
 * app shutdown, so quitting mid-render doesn't lose progress. Call AFTER killAllWorkers
 * so worker files are stable. Bounded so a slow WSL copy can't hang the quit.
 */
export async function flushActiveSessionsToCache(timeoutMs = 25000): Promise<void> {
  const sessions = Array.from(activeSessions.values());
  if (sessions.length === 0) return;
  const work = Promise.all(sessions.map(s => flushPartialSessionToCache(s)));
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([work, bound]);
  if (timer) clearTimeout(timer);
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
    // Real sentence count across all chunks (chunks pack 2-3). Additive/optional — lets the
    // analytics panel derive a true sentences/min from the chunk-based sentencesPerMinute.
    totalRawSentences: session.prepInfo.totalRawSentences,
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

  rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
  rendererSend('parallel-tts:complete', {
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
    totalRawSentences: session.prepInfo.totalRawSentences ?? session.prepInfo.totalSentences,
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

// The original render settings the partial session was produced with, read back from
// BookForge's session_state.json so a Continue can pre-fill the wizard with exactly
// what the user ran before (engine, voice, sampling, device). All optional — sessions
// created before settings-persistence, or e2a-only sessions, won't have them.
export interface ResumeRenderSettings {
  ttsEngine?: string;
  fineTuned?: string;          // e2a's term for the voice
  device?: string;
  language?: string;
  speed?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  enableTextSplitting?: boolean;
}

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
  // Original render settings + RVC-enhancement config from the previous run, so a
  // Continue pre-fills the wizard with what the user actually used (not xtts/Scarlett).
  renderSettings?: ResumeRenderSettings;
  rvcEnhancement?: ParallelConversionConfig['rvcEnhancement'];
  warnings?: string[];
}

/**
 * Read the original render settings + RVC-enhancement config from BookForge's
 * session_state.json (the underscore file written by savePersistentState). Returns
 * undefined when the file/settings are absent (older or e2a-only sessions). Used to
 * pre-fill the Continue wizard with the engine/voice/sampling the run actually used.
 */
function readResumeRenderSettings(
  processDir: string
): { renderSettings?: ResumeRenderSettings; rvcEnhancement?: ParallelConversionConfig['rvcEnhancement'] } {
  try {
    const stateFile = getStateFilePath(processDir);
    if (!fsSync.existsSync(stateFile)) return {};
    const parsed = JSON.parse(fsSync.readFileSync(stateFile, 'utf8'));
    const s = parsed?.settings;
    const renderSettings: ResumeRenderSettings | undefined = s
      ? {
          ttsEngine: s.ttsEngine || undefined,
          fineTuned: s.fineTuned || undefined,
          device: s.device || undefined,
          language: s.language || undefined,
          speed: s.speed,
          temperature: s.temperature,
          topP: s.topP,
          topK: s.topK,
          repetitionPenalty: s.repetitionPenalty,
          enableTextSplitting: s.enableTextSplitting,
        }
      : undefined;
    return { renderSettings, rvcEnhancement: parsed?.rvcEnhancement };
  } catch (err) {
    console.warn('[PARALLEL-TTS] readResumeRenderSettings failed:', err);
    return {};
  }
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
 * Normalize a file path to a canonical form for comparison.
 * Converts Windows paths, WSL /mnt/ paths, and UNC \\wsl$\ paths
 * all to lowercase forward-slash Windows-style (e.g. c:/users/...).
 * On Mac/Linux, just lowercases and normalizes slashes.
 */
function normalizePathForComparison(p: string): string {
  if (!p) return '';
  let normalized = p.replace(/\\/g, '/').toLowerCase();

  // WSL /mnt/c/... → c:/...
  const mntMatch = normalized.match(/^\/mnt\/([a-z])(\/.*)?$/);
  if (mntMatch) {
    normalized = `${mntMatch[1]}:${mntMatch[2] || '/'}`;
  }

  // UNC \\wsl$\distro\... or //wsl$/distro/... → strip to WSL-native, then leave as-is
  // These are WSL-internal paths, not Windows drive paths — just normalize slashes
  const uncMatch = normalized.match(/^\/\/wsl[\$.](?:localhost)?\/[^/]+\/(.*)/);
  if (uncMatch) {
    normalized = `/${uncMatch[1]}`;
  }

  return normalized;
}

/**
 * Get all e2a tmp directories to search for sessions.
 * Returns the Windows e2a tmp dir, plus the WSL e2a tmp dir (via UNC) when WSL is enabled.
 */
function getSessionTmpDirs(): string[] {
  const dirs: string[] = [];

  // The active tmp dir (configured scratch, or <e2a>/tmp)
  const nativeTmp = getDefaultE2aTmpPath();
  dirs.push(nativeTmp);

  // Also search the legacy <e2a>/tmp so sessions created before the scratch
  // dir was configured stay resumable
  const legacyTmp = path.join(getDefaultE2aPath(), 'tmp');
  if (legacyTmp !== nativeTmp) {
    dirs.push(legacyTmp);
  }

  // On Windows, also include the WSL e2a tmp dir if WSL TTS is enabled — but only
  // when WSL is actually responding: async fs against \\wsl$ with a wedged VM never
  // settles (strands the resume-check promises + libuv threadpool slots). When WSL is
  // down, resume checks degrade to the durable Windows project cache, which is the
  // primary resume source anyway.
  if (os.platform() === 'win32' && (shouldUseWsl2ForAllTts() || shouldUseWsl2ForOrpheus())) {
    if (isWslAliveCached()) {
      const wslE2aPath = getWslE2aPath();
      const wslTmpDir = `${wslE2aPath}/tmp`;
      // Convert WSL path to Windows UNC so Node.js can read it
      const uncTmpDir = wslPathToWindows(wslTmpDir);
      // Only add if it's a different path than the native one
      if (uncTmpDir !== nativeTmp) {
        dirs.push(uncTmpDir);
      }
    } else {
      console.warn('[PARALLEL-TTS] Skipping WSL tmp dir in session scan — WSL is not responding');
    }
  }

  return dirs;
}

/**
 * Check if a session's stored epub path matches the search epub path.
 * Handles cross-platform path format differences (Windows vs WSL vs UNC).
 */
function epubPathsMatch(storedPath: string, searchPath: string): boolean {
  return normalizePathForComparison(storedPath) === normalizePathForComparison(searchPath);
}

/**
 * Find session directory for an epub by scanning e2a's tmp folder(s)
 * Returns the session directory path if found, or null
 * Matches by normalized epub path (epub_path or source_epub_path in session state)
 * Searches both Windows and WSL tmp directories when WSL is enabled.
 *
 * When multiple sessions match the same epub, the most recent one (by folder
 * modification time) wins — complete or not. Resume callers re-bind to the
 * durable project cache afterwards, so this pick is only a tmp-dir tiebreak.
 */
async function findSessionForEpub(epubPath: string): Promise<string | null> {
  const tmpDirs = getSessionTmpDirs();

  console.log(`[PARALLEL-TTS] Searching ${tmpDirs.length} tmp dir(s) for session matching: ${epubPath}`);
  for (const d of tmpDirs) console.log(`[PARALLEL-TTS]   tmpDir: ${d}`);

  // Collect ALL matching sessions across all tmp dirs
  interface SessionMatch {
    sessionPath: string;
    processPath: string;
    totalSentences: number;
    completedSentences: number;
    isComplete: boolean;
    mtime: number;
  }
  const matches: SessionMatch[] = [];

  for (const tmpDir of tmpDirs) {
    try {
      // Check if tmp dir exists
      try {
        await fs.access(tmpDir);
      } catch {
        console.log(`[PARALLEL-TTS] Tmp dir not accessible: ${tmpDir}`);
        continue;
      }

      // List all session directories (ebook-{UUID})
      const sessionDirs = await fs.readdir(tmpDir);
      const ebookDirs = sessionDirs.filter(d => d.startsWith('ebook-'));

      if (ebookDirs.length === 0) continue;

      console.log(`[PARALLEL-TTS] Checking ${ebookDirs.length} session(s) in ${tmpDir}`);

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

              // Check if this session matches the epub path (normalized comparison)
              if (epubPathsMatch(state.epub_path || '', epubPath) ||
                  epubPathsMatch(state.source_epub_path || '', epubPath)) {
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
    } catch (err) {
      console.error(`[PARALLEL-TTS] Error scanning tmp dir ${tmpDir}:`, err);
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
}

/**
 * Delete all session folders that match a specific epub path
 * Used for language learning jobs which should always start fresh (no resume)
 * @param epubPath - Path to the epub file
 * @returns Number of sessions deleted
 */
export async function deleteSessionsForEpub(epubPath: string): Promise<number> {
  const tmpDirs = getSessionTmpDirs();

  console.log(`[PARALLEL-TTS] Deleting sessions for: ${epubPath}`);

  let deletedCount = 0;

  for (const tmpDir of tmpDirs) {
    try {
      // Check if tmp dir exists
      try {
        await fs.access(tmpDir);
      } catch {
        continue;
      }

      // List all session directories (ebook-{UUID})
      const sessionDirs = await fs.readdir(tmpDir);
      const ebookDirs = sessionDirs.filter(d => d.startsWith('ebook-'));

      if (ebookDirs.length === 0) continue;

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

              // Check if this session matches the epub path (normalized comparison)
              if (epubPathsMatch(state.epub_path || '', epubPath) ||
                  epubPathsMatch(state.source_epub_path || '', epubPath)) {
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
    } catch (err) {
      console.error(`[PARALLEL-TTS] Error scanning tmp dir ${tmpDir} for deletion:`, err);
    }
  }

  console.log(`[PARALLEL-TTS] Deleted ${deletedCount} session(s) for ${epubPath}`);
  return deletedCount;
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
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            // Sentences dir not created yet → genuinely nothing rendered.
            missingIndices = Array.from({ length: totalSentences }, (_, i) => i);
          } else {
            // Dir exists but is unreadable (e.g. a \\wsl$ path while WSL is down). Do
            // NOT silently claim all-missing — that regenerates from 0 over audio that
            // is actually present. Fail loudly; the caller resolves the durable Windows
            // cache instead. (NO FALLBACKS.)
            const error = `Sentences dir unreadable (${code}): ${sentencesDirReadable}`;
            console.error(`[PARALLEL-TTS] ${error}`);
            return { success: false, error };
          }
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

        // Original engine/voice/sampling from the previous run (for Continue pre-fill)
        const { renderSettings, rvcEnhancement } = readResumeRenderSettings(fullProcessDir);

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
          // Original render settings for Continue pre-fill
          renderSettings,
          rvcEnhancement,
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
    let processDirReadable = toReadablePath(processDir);
    let statePath = path.join(processDirReadable, 'session-state.json');

    // If session-state.json isn't here, look in subdirectories
    // (handles ebook-{uuid} dirs where processDir is a hash subdir inside)
    try {
      await fs.access(statePath);
    } catch {
      const entries = await fs.readdir(processDirReadable, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const candidatePath = path.join(processDirReadable, entry.name, 'session-state.json');
          try {
            await fs.access(candidatePath);
            processDirReadable = path.join(processDirReadable, entry.name);
            statePath = candidatePath;
            break;
          } catch { /* not this subdir */ }
        }
      }
    }

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
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Sentences dir not created yet → genuinely nothing rendered.
        missingIndices = Array.from({ length: totalSentences }, (_, i) => i);
      } else {
        // Dir exists but is unreadable (e.g. a \\wsl$ path while WSL is down). Do NOT
        // silently claim all-missing — that regenerates from 0 over audio that is
        // actually present. Fail loudly; the caller resolves the durable Windows cache
        // instead. (NO FALLBACKS.)
        const error = `Sentences dir unreadable (${code}): ${sentencesDirReadable}`;
        console.error(`[PARALLEL-TTS] ${error}`);
        return { success: false, error };
      }
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

    // Original engine/voice/sampling from the previous run (for Continue pre-fill)
    const { renderSettings, rvcEnhancement } = readResumeRenderSettings(processDirReadable);

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
      renderSettings,
      rvcEnhancement,
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
    ...pythonInvocation().args,
    appPath,
    '--headless',
    '--resume_session', sessionPath
  ];

  console.log('[PARALLEL-TTS] Checking resume status:', sessionPath);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const resumeCheckProcess = spawn(pythonInvocation().command, args, {
      cwd: getDefaultE2aPath(),
      env: buildCondaSpawnEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' }),
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
    ...pythonInvocation().args,
    appPath,
    '--headless',
    '--list_sessions'
  ];

  console.log('[PARALLEL-TTS] Listing resumable sessions');

  return new Promise((resolve) => {
    let stdout = '';

    const listProcess = spawn(pythonInvocation().command, args, {
      cwd: getDefaultE2aPath(),
      env: buildCondaSpawnEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1', VLLM_USE_V1: '0' }),
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
 * Resolve a resumable session from the durable project cache
 * (${bfpPath}/stages/03-tts/sessions/{lang}/ebook-{uuid}/). This is the authoritative
 * sentence store written by cacheSessionToProject on stop/completion, always on
 * Windows NTFS. Preferred over the persisted tmp/WSL processDir, which may have been
 * removed (completion) or be unreachable when WSL isn't running (Orpheus) — the exact
 * condition that made Orpheus resumes silently restart at 0 while native XTTS worked.
 * Returns null (caller keeps its existing resolution) when there's no usable cache.
 */
async function resolveResumeFromProjectCache(
  bfpPath: string,
  language?: string
): Promise<ResumeCheckResult | null> {
  try {
    const sessions = await scanProjectSessions(bfpPath);
    if (!sessions.length) return null;
    const lang = (language || '').toLowerCase();
    const match = sessions.find(s => s.language.toLowerCase() === lang)
      || (sessions.length === 1 ? sessions[0] : null);
    if (!match) return null;
    return await checkResumeStatusFromProcessDir(match.sessionDir);
  } catch (err) {
    console.warn('[PARALLEL-TTS] resolveResumeFromProjectCache failed (keeping existing resolution):', err);
    return null;
  }
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
    const error = resumeInfo.error || 'Resume info invalid';
    emitJobFailure(jobId, error);
    return { success: false, error };
  }

  // Bind the resume to the durable project cache (stages/03-tts/sessions/{lang}) — the
  // single authoritative sentence store. The persisted resumeInfo.processDir may point
  // at a tmp/WSL session that was removed on completion or is inaccessible when WSL
  // isn't running; scanning THAT (and the old silent all-missing fallback) is what made
  // Orpheus resumes restart at 0 while native XTTS worked. The cache is always readable
  // Windows NTFS, and the worker writes new sentences straight back into it via
  // --sentences_dir (translated to /mnt/c for Orpheus).
  if (config.bfpPath) {
    const fromCache = await resolveResumeFromProjectCache(config.bfpPath, config.settings?.language);
    if (fromCache?.success && (fromCache.completedSentences ?? 0) > 0) {
      resumeInfo = { ...resumeInfo, ...fromCache };
      console.log(`[PARALLEL-TTS] Resume bound to durable cache: ${fromCache.completedSentences}/${fromCache.totalSentences} complete at ${fromCache.processDir}`);
    }
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
      const error = 'Cannot re-fetch resume info: no processDir or epubPath available';
      emitJobFailure(jobId, error);
      return { success: false, error };
    }

    if (!freshInfo.success) {
      const error = freshInfo.error || 'Failed to re-fetch resume info';
      emitJobFailure(jobId, error);
      return { success: false, error };
    }
    // Merge fresh info into resumeInfo
    resumeInfo = { ...resumeInfo, ...freshInfo };
    console.log(`[PARALLEL-TTS] Re-fetched: sessionId=${resumeInfo.sessionId}, missingIndices=${resumeInfo.missingIndices?.length}`);
  }

  // Determine effective output directory (same logic as startParallelConversion)
  // Do this BEFORE the complete check so runAssemblyOnly also uses BFP folder
  let effectiveOutputDir: string;

  if (config.bfpPath) {
    effectiveOutputDir = getAudiobookDirFromBfp(config.bfpPath);
    await fs.mkdir(effectiveOutputDir, { recursive: true });
    console.log(`[PARALLEL-TTS] Resume: Outputting directly to BFP audiobook folder: ${effectiveOutputDir}`);
  } else if (config.outputDir && config.outputDir.trim() !== '') {
    effectiveOutputDir = config.outputDir;
  } else {
    const error = 'Output directory not configured. Please set the audiobook output folder in Settings.';
    console.error('[PARALLEL-TTS]', error);
    emitJobFailure(jobId, error);
    return { success: false, error };
  }

  // Create internal config with effective output directory
  const internalConfig: ParallelConversionConfig = {
    ...config,
    outputDir: effectiveOutputDir
  };

  if (resumeInfo.complete) {
    // If skipAssembly is set (chained workflow), skip assembly and return sentences dir
    if (internalConfig.skipAssembly) {
      console.log('[PARALLEL-TTS] All sentences already complete, skipAssembly=true, returning sentences dir');
      const sentencesDir = resumeInfo.processDir
        ? path.join(resumeInfo.processDir, 'chapters', 'sentences')
        : '';
      // Emit complete event for event-based listeners
      if (mainWindow) {
        rendererSend('parallel-tts:complete', {
          jobId,
          success: true,
          outputPath: sentencesDir,
          sessionId: resumeInfo.sessionId,
          sessionDir: resumeInfo.sessionDir,
        });
      }
      return { success: true, outputPath: sentencesDir };
    }
    console.log('[PARALLEL-TTS] All sentences already complete, proceeding to assembly');
    return runAssemblyOnly(jobId, internalConfig, resumeInfo.sessionId!, resumeInfo.sessionDir);
  }

  // Per-global-chunk-index real-sentence counts for an EXACT sentences/min on resume too.
  // session-state.json is guaranteed present here (resume depends on it) and carries
  // chapter_sentences. A read failure is non-fatal to generation — it only degrades the
  // rate to the chunk×average estimate — so log it (surface, don't hide) and continue.
  let resumeRawCounts: number[] = [];
  try {
    const statePath = path.join(resumeInfo.processDir!, 'session-state.json');
    const st = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    resumeRawCounts = buildRawSentenceCounts(st.chapter_sentences);
  } catch (err) {
    console.warn(`[PARALLEL-TTS] Resume: could not build raw-sentence counts (sentences/min falls back to estimate): ${err}`);
  }
  const resumeRawSum = resumeRawCounts.reduce((a, b) => a + b, 0);

  // Create PrepInfo-like structure from resume info
  const prepInfo: PrepInfo = {
    sessionId: resumeInfo.sessionId!,
    sessionDir: resumeInfo.sessionDir!,
    processDir: resumeInfo.processDir!,
    chaptersDir: path.join(resumeInfo.processDir!, 'chapters'),
    chaptersDirSentences: path.join(resumeInfo.processDir!, 'chapters', 'sentences'),
    totalChapters: resumeInfo.totalChapters!,
    totalSentences: resumeInfo.totalSentences!,
    totalRawSentences: resumeRawSum > 0 ? resumeRawSum : undefined,
    rawSentenceCounts: resumeRawCounts.length > 0 ? resumeRawCounts : undefined,
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
    totalMissing: resumeInfo.missingSentences || 0
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
    rendererSend('parallel-tts:progress', { jobId, progress });

    // Emit session-created event so frontend can update BFP with session info
    rendererSend('parallel-tts:session-created', {
      jobId,
      sessionId: prepInfo.sessionId,
      sessionDir: prepInfo.sessionDir,
      processDir: prepInfo.processDir,
      totalSentences: prepInfo.totalSentences,
      totalChapters: prepInfo.totalChapters
    });
  }

  // Take the GPU before the resumed workers load a TTS model, so the AI-cleanup
  // LLM steps off and they never co-reside in VRAM. No-op for CPU jobs.
  await acquireGpuForJob(session);
  if (session.gpuPreflightError) {
    releaseSessionGpu(session);
    const msg = session.gpuPreflightError;
    session.gpuPreflightError = undefined;
    console.warn(`[PARALLEL-TTS] Resume job ${jobId} aborted before workers: ${msg}`);
    return { success: false, error: msg };
  }
  if (session.cancelled || !activeSessions.has(jobId)) {
    releaseSessionGpu(session);
    console.log(`[PARALLEL-TTS] Resume job ${jobId} cancelled while waiting for the GPU`);
    return { success: false, error: 'Cancelled' };
  }

  // Start workers for missing ranges - stagger on Windows to avoid conda temp file race condition
  const isWindows = process.platform === 'win32';
  const WINDOWS_WORKER_STAGGER_MS = 2000; // 2 seconds between worker starts on Windows

  try {
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i];
      const range: WorkerRange = { sentenceStart: worker.sentenceStart, sentenceEnd: worker.sentenceEnd };

      if (isWindows && i > 0) {
        // Stagger worker starts on Windows to avoid conda temp file conflicts
        await new Promise(resolve => setTimeout(resolve, WINDOWS_WORKER_STAGGER_MS));
      }
      startWorker(session, i, range);
    }
  } catch (err) {
    releaseSessionGpu(session);
    throw err;
  }

  // Return immediately - completion is handled via events
  return new Promise((resolve) => {
    const checkComplete = setInterval(() => {
      if (!activeSessions.has(jobId)) {
        clearInterval(checkComplete);
        releaseSessionGpu(session); // backstop GPU release for the resume path
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
  sessionDir?: string
): Promise<ParallelConversionResult> {
  console.log(`[PARALLEL-TTS] Running assembly only for session ${sessionId}`);

  // Create a session with minimal prepInfo (just need sessionId for assembly)
  const minimalPrepInfo: PrepInfo = {
    sessionId,
    sessionDir: sessionDir || '',  // Used for --session_dir when session is cached outside e2a tmp
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
    assemblyProcess: null
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
    rendererSend('parallel-tts:progress', { jobId, progress });
  }

  try {
    // Run assembly - runAssembly uses session.prepInfo.sessionId
    const outputPath = await runAssembly(session);

    activeSessions.delete(jobId);

    // Emit complete
    if (mainWindow) {
      rendererSend('parallel-tts:complete', {
        jobId,
        success: true,
        outputPath,
        duration: (Date.now() - session.startTime) / 1000,
        sessionId
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
      rendererSend('parallel-tts:complete', {
        jobId,
        success: false,
        error,
        sessionId
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
// Session Caching (for Language Learning pipeline)
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
  stopAndCacheParallelConversion,
  flushActiveSessionsToCache,
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
  cleanupStaleTempFolders,
  // Session caching
  cacheSessionToBfp,
  getAudiobookDirFromBfp,
};

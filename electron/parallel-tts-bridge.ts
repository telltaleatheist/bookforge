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

import { publishBridgeEvent } from './bridge-events';
import { spawn, ChildProcess, execSync, exec, spawnSync } from 'child_process';
import { BrowserWindow, powerSaveBlocker } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { flacDurationSeconds } from './flac-duration';
import * as os from 'os';
import * as crypto from 'crypto';
import * as logger from './audiobook-logger';
import { getTTSLogger } from './rolling-logger';
import type { JobStageProgress } from './job-stages';
// The model behind the number pass is INJECTED into the door below, so this is a
// type-only import: nothing here ever dials Ollama.
import type { NumberNormalizerRunner } from './tts-number-normalizer';
import type { NarrationTextGate } from './narration-text-pass';

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
// Where the worker log lives, kept so per-job diagnostics can sit beside it.
let workerLogsDir: string | null = null;

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
    workerLogsDir = logsDir;
    workerLogPath = path.join(logsDir, 'worker-output.log');
    // Truncate on start
    workerLogStream = fsSync.createWriteStream(workerLogPath, { flags: 'w' });
    workerLogStream.write(`=== Worker Log Started ${new Date().toISOString()} ===\n`);
  }
}

/**
 * Per-job directory where Orpheus keeps the renders its guards threw away
 * (→ ORPHEUS_REJECT_DIR). One directory per job so the evidence carries the
 * identity of the run that produced it.
 *
 * It sits beside the worker log rather than in the project for one measured
 * reason: on Windows the worker runs inside WSL, and a library on a network
 * drive (\\TITAN\iO → /mnt/z) is NOT writable from there. e2a swallows a failed
 * write by design — diagnostics must never take down a book — so pointing it at
 * an unwritable path would silently destroy the evidence instead of saving it.
 * The log directory is local on every platform, and the worker can write it.
 *
 * Unlike worker-output.log, which is truncated on every start, these persist.
 */
function orpheusRejectDir(jobId: string): string | null {
  if (!workerLogsDir) return null;
  const dir = path.join(workerLogsDir, 'tts-rejects', jobId);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  return dir;
}

function writeWorkerLog(line: string): void {
  if (workerLogStream) {
    workerLogStream.write(`${new Date().toISOString()} ${line}\n`);
  }
}

/**
 * A guard fire from orpheus.py: a truncation, a cap runaway, an empty render, or
 * a short chunk that spoke for too long. One tag, one JSON object, one line.
 *
 * Returned so it can reach the JOB log. worker-output.log is truncated on every
 * start, so it is not where a defect count for a finished book can live.
 */
function parseOrpheusGuardEvent(line: string): Record<string, unknown> | null {
  const at = line.indexOf('[ORPHEUS][ORPHEUS_GUARD_EVENT]');
  if (at < 0) return null;
  const json = line.slice(at + '[ORPHEUS][ORPHEUS_GUARD_EVENT]'.length).trim();
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;   // a torn line across two stdout chunks; the file still has it
  }
}

/**
 * vLLM's per-preemption scheduler warning ("Sequence group N is preempted by
 * PreemptionMode.RECOMPUTE … not enough KV cache space"). Recompute-mode
 * preemption is lossless — the output is bit-identical, only wall-clock is
 * spent — so the line is kept out of the console (which is read live for
 * runaways and truncations) and kept IN the worker log file, where the
 * cumulative count is the evidence of KV pressure.
 */
function isKvPreemptionNote(line: string): boolean {
  return /is preempted by PreemptionMode|not enough KV cache space/.test(line);
}
import { getMetadataToolPath, applyMetadata, AudiobookMetadata, embedAndVerifyVtt, deleteSidecarsForM4b } from './metadata-tools';
import * as manifestService from './manifest-service';
import { isCudaTtsInstalled } from './components/cuda-tts';
import { enhanceSentences, rvcEnhancementReady } from './rvc-bridge';
import { denoiseSentences, finalDenoiseReady } from './denoise-bridge';
import { getRvcVoiceById, resolveRvcIndexRate } from './rvc-models';
import { defaultOrpheusBatchSize } from './orpheus-batch';
import {
  ActiveBatchProgress,
  ActiveBatchState,
  advanceBatch,
  parseMlxHeartbeat,
  toActiveBatchProgress,
} from './mlx-batch-progress';
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
import { resolveOrpheusModel, orpheusVoiceCapsForModel, OrpheusVoiceCaps, resolveOrpheusSentenceGap, resolveOrpheusMinChunkGap, DEFAULT_SENTENCE_GAP } from './orpheus-models';
import { startChapterCloser, stopChapterCloser } from './chapter-closer';
import { ensureWslDrivesFor } from './wsl-mounts';
import { acquireGpu, releaseGpu, waitForFreeVram, getGpuMemMB, gpuOwnerForTts, gpuHolder, GPU_OWNER_LLAMA, computeSafeGpuUtil, ORPHEUS_MIN_VRAM_MB, orpheusMinFreeVramMB, DESKTOP_VRAM_MARGIN_MB, unloadOllamaModels, type OrpheusServeArtifact } from './gpu-arbiter';
import { uniqueOutputPath, uniqueOutputStem } from './output-naming';
import { destroyWslGuestProcesses, wslPkillGraceful, waitForGuestExit, isWslWedged, wslWedgedMessage, isWslAliveCached, type WslPkillOutcome } from './wsl-lifecycle';
import { assertRunnableTtsEngine } from '../shared/tts/engine-caps';
import {
  HIGGS_VOICE_FLAG,
  buildHiggsSpawn,
  higgsEnvironmentRefusal,
  higgsPreflight,
  higgsRunsInWsl,
} from './higgs-spawn';
import {
  NARRATOR_APP_RE,
  NARRATOR_BATCH_RE,
  NARRATOR_WORKER_RE,
  SERVE_PROCESS_RE,
  buildNarratorSpawn,
  narratorEngineId,
  narratorRunsInWsl,
  type NarratorEngineId,
  type NarratorPhase,
  type NarratorSpawnPlan,
} from './narrator-spawn';
import {
  findForeignRenders,
  gpuOwnershipRefusal,
  gpuOwnershipOverrideNote,
  ALLOW_SHARED_GPU_ENV,
} from '../shared/tts/gpu-ownership';

/**
 * Append the voice/fine-tune CLI args for the selected voice. Centralizes the
 * cases so prep, the lightweight worker, and the app.py worker stay in sync:
 *
 *  1. Folder-discovered custom Orpheus model. This is the BATCH path, so it resolves
 *     with `purpose: 'batch'` — a voice with both artifact forms installed renders from
 *     its MERGED copy here, while the resident streaming server takes the adapter (see
 *     OrpheusServePurpose in orpheus-models.ts). A worker renders one voice for hours and
 *     never switches, so it has nothing to gain from the shared base and everything to
 *     gain from skipping vLLM's per-token LoRA GEMMs.
 *     - MERGED  → --orpheus_model_dir + the folder's voice token (orpheus.py points
 *       every backend at the dir and skips the built-in allowlist that otherwise
 *       drops it to leah).
 *     - ADAPTER → --orpheus_base_dir + --orpheus_adapter_dir + the voice token. Still
 *       reached for a voice installed ONLY as an adapter (nothing else to serve).
 *       e2a loads the shared base and serves the LoRA per request; it hard-errors on
 *       a missing base, a malformed adapter, or a missing/'internal' voice, so the
 *       three flags always travel together.
 *  2. User-added XTTS custom voice → pre-stage its checkpoint, pass --custom_model*.
 *  3. Catalog fine-tune / built-in voice → pass --fine_tuned verbatim.
 *
 * PATHS ARE PUSHED IN THEIR NATIVE WINDOWS FORM. Every arg later passes through
 * buildWslBashCommand, which rewrites `\\wsl$\…` and `C:\…` args to WSL-native paths
 * for an Orpheus-via-WSL spawn (see its loop over condaArgs). Translating here as
 * well would be redundant, and pre-translating would break the NON-WSL spawn, which
 * gets the same array untouched.
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
    // resolveOrpheusModel THROWS for an adapter voice whose shared base is missing —
    // that propagates out of here as a job failure, which is the point: we never fall
    // back to a merged copy of the same voice that happens to still be on disk.
    const model = resolveOrpheusModel(settings.fineTuned, 'batch');
    if (model) {
      if (model.artifact === 'adapter') {
        // Belt-and-braces: resolveOrpheusModel guarantees baseDir for an adapter, so
        // this can only fire if that contract is ever broken. Loud, never silent.
        if (!model.baseDir) {
          throw new Error(
            `Orpheus voice "${settings.fineTuned}" is a LoRA adapter but resolved without a base model directory. ` +
            `Install the Orpheus base model from Settings → Orpheus Voices — refusing to render without it.`
          );
        }
        args.push('--orpheus_base_dir', model.baseDir);
        args.push('--orpheus_adapter_dir', model.dir);
        args.push('--fine_tuned', model.voice);
        return;
      }
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
 * The optional per-voice Orpheus tuning caps declared on the SELECTED voice's
 * manifest entry, resolved for the backend that will actually render:
 *  - maxChars       → the PREP packing cap (ORPHEUS_MAX_CHARS), for EOS-weak
 *                     fine-tunes that run away on long chunks.
 *  - maxCharsPerSec → the GENERATION truncation-guard rate (ORPHEUS_MAX_CHARS_PER_SEC),
 *                     for genuinely fast-reading voices.
 *  - repPenalty     → the repetition penalty (ORPHEUS_REP_PENALTY); usually declared
 *                     per-backend (vLLM-only silence-loop fix — see below).
 *
 * A voice can declare caps flat (all backends) AND under a per-backend overlay
 * (`model.backends.{vllm,mlx}`) whose fields override the flat ones for that backend.
 * We merge flat + the active backend's overlay here so the spawn-env injection sites
 * stay backend-agnostic (same return shape as before). Absent fields stay absent (NO
 * FALLBACK) so callers can distinguish "voice declares nothing" (→ let e2a default)
 * from a real value. Returns {} for non-Orpheus jobs, for the explicit
 * --orpheus_model_dir CLI path (no manifest to read), and for stock/unresolvable
 * voices. Mirrors pushVoiceArgs' registry resolution so the caps track the exact
 * fine-tune that will render.
 */
/**
 * Which artifact form THIS job's Orpheus voice will be served from — the input to
 * VRAM sizing, because an adapter spawn allocates the resident LoRA and the punica
 * workspace OUTSIDE vLLM's reservation (see ORPHEUS_ADAPTER_HEADROOM_MB).
 *
 * Mirrors pushVoiceArgs' resolution exactly, so sizing and the spawn can never
 * disagree about what is being loaded. A non-Orpheus job, an explicit
 * --orpheus_model_dir (a merged folder by definition), and a stock/unresolvable voice
 * are all 'merged' — i.e. every pre-adapter path keeps its exact previous sizing.
 * Propagates the base-missing throw: the preflight is the right place to surface it.
 */
function orpheusServeArtifact(settings: ParallelTtsSettings): OrpheusServeArtifact {
  if (settings.ttsEngine !== 'orpheus') return 'merged';
  if (settings.orpheusModelDir) return 'merged';
  return resolveOrpheusModel(settings.fineTuned, 'batch')?.artifact ?? 'merged';
}

function orpheusVoiceCaps(settings: ParallelTtsSettings): OrpheusVoiceCaps {
  if (settings.ttsEngine !== 'orpheus') return {};
  // Explicit CLI --model-dir bypasses models.json, so there's no manifest entry to
  // read caps from (mirrors pushVoiceArgs' first branch).
  if (settings.orpheusModelDir) return {};
  const model = resolveOrpheusModel(settings.fineTuned, 'batch');
  if (!model) return {};
  // The flat + per-backend merge lives in orpheus-models.ts so the resident
  // streaming server resolves caps through the EXACT same channel (it used to
  // resolve none at all — see orpheusVoiceCapsForModel's docstring).
  return orpheusVoiceCapsForModel(model);
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
 * External-GPU-job guard. Training chains, CLI renders, and other processes
 * OUTSIDE this Electron instance share the same WSL VM and process patterns
 * as our workers — a "global orphan sweep" cannot tell them apart and has
 * nearly killed an active training chain (2026-07-20). Any external job may
 * create %APPDATA%\BookForge\external-gpu-job.lock (content = free-text
 * description); while it exists, ALL global pattern-based sweeps are skipped
 * loudly. Session-scoped kills (our own tracked workers) are unaffected.
 */
function externalGpuJobLock(): string | null {
  if (os.platform() !== 'win32') return null;
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const p = path.join(appData, 'BookForge', 'external-gpu-job.lock');
  if (!fsSync.existsSync(p)) return null;
  try {
    return fsSync.readFileSync(p, 'utf-8').trim() || '(empty lock file)';
  } catch {
    return '(unreadable lock file)';
  }
}

/**
 * Clean up orphaned vLLM processes on Windows
 * vLLM uses ZMQ sockets for inter-process communication on ports 29500-29600
 * These processes can escape the normal process tree kill, so we find and kill them by port
 */
function cleanupOrphanedVllmProcesses(): void {
  if (os.platform() !== 'win32') return;
  const extLock = externalGpuJobLock();
  if (extLock) {
    console.warn(`[PARALLEL-TTS] SKIPPING global vLLM-port sweep — external GPU job lock present: ${extLock}`);
    return;
  }

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

  const extLock = externalGpuJobLock();
  if (extLock) {
    console.warn(`[PARALLEL-TTS] SKIPPING global e2a/WSL kill sweep — external GPU job lock present: ${extLock}`);
    return;
  }

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
 * @param bfpPath - project directory (copies to {projectDir}/audiobook/)
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
    // Derive output dir from the project directory
    // Output lands in the project's own output/ folder.
    // Project dirs: .../projects/myproject/ → .../projects/myproject/output/
    const projectAudiobookDir = getAudiobookDirFromBfp(bfpPath);
    await fs.mkdir(projectAudiobookDir, { recursive: true });

    finalAudioPath = path.join(projectAudiobookDir, m4bFile);
    await fs.copyFile(tempM4bPath, finalAudioPath);
    console.log(`[PARALLEL-TTS] Copied m4b to project output: ${finalAudioPath}`);

    if (tempVttPath) {
      finalVttPath = path.join(projectAudiobookDir, 'subtitles.vtt');
      await fs.copyFile(tempVttPath, finalVttPath);
      console.log(`[PARALLEL-TTS] Copied vtt to project output: ${finalVttPath}`);
    }
  } else {
    // No project directory - just use temp path (will be cleaned up separately)
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
 * Whether WSL can see this Windows drive under /mnt.
 *
 * WSL auto-mounts FIXED drives only: C: is /mnt/c the moment the distro boots,
 * but a NETWORK drive — the titan library at Z: — has no /mnt entry at all, and
 * `mkdir -p /mnt/z` inside the guest is "Permission denied", not a mount (hit
 * live 2026-08-18, the first titan narration's copy-out; the same asymmetry the
 * INPUT side hit first, which is why prepareSession stages the ebook INTO WSL).
 */
async function wslSeesDrive(driveLetter: string): Promise<boolean> {
  const distro = getWslDistro();
  const probe = `test -d /mnt/${driveLetter.toLowerCase()}`;
  const args = distro ? ['-d', distro, 'bash', '-c', probe] : ['bash', '-c', probe];
  return await new Promise<boolean>((resolve) => {
    const proc = spawn('wsl.exe', args, { shell: false });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * COPY A DIRECTORY OUT OF WSL onto a Windows path, choosing the road by what
 * WSL can actually reach.
 *
 * The ext4 → /mnt/<letter> copy inside the guest is much faster than reading
 * the session through the \\wsl$ 9p mount, so it is taken exactly when the
 * destination's drive IS mounted in WSL. A destination WSL cannot see — any
 * network drive — is copied by WINDOWS instead: read through \\wsl$, written
 * to the share natively. Nothing is lost on that road: both sides of a
 * network destination cross the wire regardless of who drives the copy.
 *
 * This is a ROUTING DECISION on a probed fact, not a fallback — the wrong road
 * fails loudly (the guest's mkdir cannot create /mnt/z), it never substitutes.
 */
async function copyDirOutOfWsl(sourceUnc: string, destDir: string): Promise<void> {
  const drive = /^([A-Za-z]):[\\/]/.exec(destDir);
  const mounted = drive !== null && await wslSeesDrive(drive[1]!);
  if (!mounted) {
    console.log(
      `[PARALLEL-TTS] WSL cannot see the destination drive (no /mnt entry); Windows copies `
      + `through \\\\wsl$ instead: ${sourceUnc} -> ${destDir}`);
    await fs.mkdir(path.dirname(destDir), { recursive: true });
    await fs.cp(sourceUnc, destDir, { recursive: true });
    return;
  }
  const wslSrc = uncToWslPath(sourceUnc);
  const wslDest = windowsToWslPath(destDir);
  const wslDestParent = windowsToWslPath(path.dirname(destDir));
  const cmd = `mkdir -p ${shellQuote(wslDestParent)} && cp -r ${shellQuote(wslSrc)} ${shellQuote(wslDest)}`;
  const distro = getWslDistro();
  const wslArgs = distro ? ['-d', distro, 'bash', '-c', cmd] : ['bash', '-c', cmd];
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
}

/**
 * Give a WSL-spawned worker a session dir it can actually READ, and say where to
 * delete the staging afterwards.
 *
 * A drive letter maps to /mnt/<letter> unconditionally, but WSL
 * auto-mounts FIXED drives only. With the library on the mapped titan share there is
 * no /mnt/z at all, so `--session_dir Z:\…` reached the guest as a path that does not
 * exist and every Correct Sentences re-roll died on e2a's "Session directory not
 * found" (hit live 2026-08-19, on a book whose own render had worked — generation
 * builds its session INSIDE WSL, so only work that points the guest back at the
 * Windows-side cache was ever exposed).
 *
 * The worker READS session-state.json out of this dir and nothing else — the audio it
 * produces goes to --sentences_dir, and the Orpheus model comes from the voice args —
 * so staging just that file is sufficient. It goes through the \\wsl$ UNC, which works
 * for EVERY source the host can read (fixed, mapped, or UNC), so this needs no mount
 * probe to be correct — the same reasoning that makes prepareSession stage the ebook
 * unconditionally rather than testing for /mnt.
 */
async function stageSessionStateForWsl(
  sessionDir: string
): Promise<{ guestSessionDir: string; stagedUnc: string | null }> {
  // Already on WSL's own filesystem: the guest reads it natively, nothing to stage.
  if (isWslUncPath(sessionDir)) {
    return { guestSessionDir: uncToWslPath(sessionDir), stagedUnc: null };
  }

  const processDir = findE2aProcessDir(sessionDir);
  if (!processDir) {
    throw new Error(
      `No session-state.json under ${sessionDir}, so this session cannot be staged for WSL.`
    );
  }

  const guestSessionDir = `${getWslE2aPath()}/tmp/staged-session-${crypto.randomUUID()}`;
  const stagedUnc = wslPathToWindows(guestSessionDir);
  // load_session_state looks for <session_dir>/<process>/session-state.json — one level
  // down, always — so the state is staged under a process dir even when the source kept
  // it at the top level.
  const stagedProcessDir = path.join(stagedUnc, path.basename(processDir));
  await fs.mkdir(stagedProcessDir, { recursive: true });
  await fs.copyFile(
    path.join(processDir, 'session-state.json'),
    path.join(stagedProcessDir, 'session-state.json')
  );
  console.log(`[PARALLEL-TTS] Staged session state for WSL: ${processDir} -> ${guestSessionDir}`);
  return { guestSessionDir, stagedUnc };
}

/**
 * Cache the full TTS session folder from e2a tmp into the project for permanent storage.
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
  console.log(`[PARALLEL-TTS] Caching session to the project`);
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
      // WSL session: routed copy-out — inside the guest when the destination
      // drive is mounted there, through \\wsl$ on the Windows side when it is
      // not (network drives never are).
      await copyDirOutOfWsl(sessionDir, tempDestDir);
    } else {
      // Native session: use Node.js recursive copy
      await fs.cp(sessionDir, tempDestDir, { recursive: true });
    }

    // Atomic swap: remove old session(s), rename temp into place.
    // Only one session should exist per project audiobook folder.
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
    const error = `Failed to cache session to the project: ${err}`;
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
      // Routed copy-out: guest-side to a mounted drive, \\wsl$ read on the
      // Windows side to a drive the guest cannot see (network drives never
      // appear under /mnt — the titan library's Z: is the live case).
      await copyDirOutOfWsl(sessionDir, tempDestDir);
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

// ─────────────────────────────────────────────────────────────────────────────
// Scratch-session ownership + crash rescue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ownership sidecar written into every scratch session dir (<scratch>/ebook-{uuid}/).
 * The scratch dir is swept on every app start, so a run that ended by CRASH (jetsam,
 * force-quit, power loss) never got its before-quit / stop flush — and its rendered
 * sentences were deleted before anything could read them. e2a's own session-state.json
 * has no idea which BookForge project owns the run, so the sweep had nowhere to put
 * the work. This file closes that gap: it names the owning project + language so the
 * startup rescue can promote the sentences into the durable project cache first.
 */
const SESSION_OWNER_FILE = 'bookforge-session.json';

interface SessionOwnerInfo {
  jobId: string;
  bfpPath?: string;
  language: string;
  epubPath: string;
  createdAt: string;
}

/** Write (or refresh) the ownership sidecar for a session. Best-effort, never throws. */
async function writeSessionOwner(session: ConversionSession): Promise<void> {
  const sessionDir = session.prepInfo?.sessionDir;
  if (!sessionDir) return;
  const owner: SessionOwnerInfo = {
    jobId: session.jobId,
    bfpPath: session.config.bfpPath,
    language: session.config.settings.language || 'en',
    epubPath: session.config.epubPath,
    createdAt: new Date().toISOString(),
  };
  try {
    await fs.writeFile(path.join(sessionDir, SESSION_OWNER_FILE), JSON.stringify(owner, null, 2));
  } catch (err) {
    console.warn('[PARALLEL-TTS] Could not write session ownership sidecar (non-fatal):', err);
  }
}

/** Read the ownership sidecar from a scratch session dir. Returns null when absent/unreadable. */
async function readSessionOwner(sessionDir: string): Promise<SessionOwnerInfo | null> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, SESSION_OWNER_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as SessionOwnerInfo;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Count rendered sentence files inside a session dir (ebook-{uuid}), handling both
 * the direct chapters/sentences layout and e2a's ebook-{uuid}/{hash}/chapters/sentences.
 * Returns 0 when there is nothing rendered.
 */
async function countRenderedSentencesInSessionDir(sessionDir: string): Promise<number> {
  const candidates: string[] = [path.join(sessionDir, 'chapters', 'sentences')];
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('ebook-')) {
        candidates.push(path.join(sessionDir, entry.name, 'chapters', 'sentences'));
      }
    }
  } catch { /* unreadable session dir */ }

  for (const dir of candidates) {
    try {
      const files = await fs.readdir(dir);
      const count = files.filter(f => (f.endsWith('.flac') || f.endsWith('.wav')) && !f.startsWith('.')).length;
      if (count > 0) return count;
    } catch { /* not this one */ }
  }
  return 0;
}

/**
 * Rescue rendered sentences from orphaned scratch sessions into the durable project
 * cache, BEFORE the scratch dir is swept.
 *
 * This is the fix for the destructive resume: the startup sweep used to wipe
 * <library>/tmp unconditionally on the premise that "nothing is converting yet, so any
 * leftovers are from prior/failed/interrupted runs" — but an INTERRUPTED run's leftovers
 * are precisely the resume checkpoint. A jetsam/force kill skips before-quit's
 * flushActiveSessionsToCache, so the only copy of the work lived in that scratch dir and
 * died at the next launch; the queue's auto-resume then found nothing and restarted at 0.
 *
 * Downgrade-guarded exactly like flushPartialSessionToCache: never replace a cache that
 * already holds at least as many sentences. Best-effort — a failure here must never
 * block startup, and the caller sweeps regardless.
 */
export async function rescueOrphanedScratchSessions(scratchDir: string): Promise<{ rescued: number; skipped: number }> {
  const ttsLog = getTTSLogger();
  let rescued = 0;
  let skipped = 0;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(scratchDir, { withFileTypes: true });
  } catch {
    return { rescued, skipped }; // dir doesn't exist / volume offline
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('ebook-')) continue;
    const sessionDir = path.join(scratchDir, entry.name);

    try {
      const owner = await readSessionOwner(sessionDir);
      const ours = await countRenderedSentencesInSessionDir(sessionDir);

      if (!owner?.bfpPath) {
        // No owner recorded (pre-sidecar session, or a run that never reached prep).
        // Nothing we can safely promote — log it so a lost checkpoint is at least visible.
        if (ours > 0) {
          skipped++;
          ttsLog.warn('Scratch session has rendered sentences but no owning project — cannot rescue', {
            sessionDir, renderedSentences: ours,
          });
        }
        continue;
      }

      if (ours <= 0) continue; // nothing rendered → nothing to preserve

      const language = owner.language || 'en';
      let existing = 0;
      try {
        const cached = await scanProjectSessions(owner.bfpPath);
        existing = cached.find(s => s.language === language)?.sentenceCount ?? 0;
      } catch { /* no cache yet */ }

      if (existing >= ours) {
        skipped++;
        ttsLog.info('Scratch rescue skipped — project cache is already at least as complete', {
          jobId: owner.jobId, bfpPath: owner.bfpPath, language, scratchSentences: ours, cachedSentences: existing,
        });
        continue;
      }

      const result = await cacheSessionToProject(sessionDir, owner.bfpPath, language);
      if (result.success) {
        rescued++;
        ttsLog.info('Rescued orphaned scratch session into the project cache', {
          jobId: owner.jobId, bfpPath: owner.bfpPath, language,
          renderedSentences: ours, replacedCachedSentences: existing,
          cachedPath: result.cachedSentencesDir,
        });
      } else {
        skipped++;
        ttsLog.error('Scratch rescue FAILED — rendered sentences will be lost by the sweep', {
          jobId: owner.jobId, bfpPath: owner.bfpPath, language, renderedSentences: ours, error: result.error,
        });
      }
    } catch (err) {
      skipped++;
      ttsLog.error('Scratch rescue errored', { sessionDir, error: (err as Error).message });
    }
  }

  if (rescued > 0 || skipped > 0) {
    ttsLog.info('Scratch rescue sweep complete', { scratchDir, rescued, skipped });
  }
  return { rescued, skipped };
}

/**
 * Post-process output after e2a writes directly to the project audiobook folder.
 * Renames VTT to standard name.
 */
/**
 * THIS run's audiobook and its transcript, by path — never "the first .m4b in
 * the folder", which was what this answered until 2026-09-03. With one
 * audiobook per project that was the same thing; with the folder now keeping
 * every render and any human recording filed there, it was a coin toss.
 *
 * The transcript is looked for under the audiobook's own stem: beside it, or
 * in the `vtt/` subfolder `moveVttFile` files it under after a rename. It is
 * moved beside the audiobook as `<stem>.vtt` so the embed that follows and the
 * stem-matching sidecar cleanup both find it. It is no longer renamed to a
 * shared `subtitles.vtt`, which two runs in one folder would have fought over.
 */
async function postProcessOutput(
  outputDir: string,
  m4bPath: string,
): Promise<{ audioPath: string; vttPath?: string }> {
  const stem = path.basename(m4bPath, path.extname(m4bPath));
  const beside = path.join(path.dirname(m4bPath), `${stem}.vtt`);
  if (fsSync.existsSync(beside)) return { audioPath: m4bPath, vttPath: beside };
  const inSubfolder = path.join(outputDir, 'vtt', `${stem}.vtt`);
  if (fsSync.existsSync(inSubfolder)) {
    await fs.rename(inSubfolder, beside);
    return { audioPath: m4bPath, vttPath: beside };
  }
  return { audioPath: m4bPath };
}

/**
 * Move an assembled audiobook — and everything else e2a left in the per-run
 * staging folder — into the output folder under FREE names, then drop the
 * staging folder. `p` is the audiobook's current path: still inside `asmDir`
 * when nothing renamed it, or already in `outputDir` when applyM4bMetadata
 * filed it under the custom name (in which case only the leftovers move).
 *
 * The audiobook's stem is resolved ONCE across every staged file sharing it, so
 * a numbered rename keeps the audio and its transcript together. Returns the
 * audiobook's final path. Never deletes or replaces an existing file.
 */
async function promoteFromAssemblyDir(p: string, asmDir: string, outputDir: string): Promise<string> {
  let finalM4b = p;
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(asmDir)).filter((f) => !f.startsWith('._'));
  } catch {
    return finalM4b; // staging already gone — nothing to promote
  }
  const files: string[] = [];
  for (const name of entries) {
    const full = path.join(asmDir, name);
    if ((await fs.stat(full)).isFile()) files.push(name);
  }
  const m4bName = path.resolve(path.dirname(p)) === path.resolve(asmDir) ? path.basename(p) : undefined;
  const stemOf = (name: string): string => path.basename(name, path.extname(name));
  const m4bStem = m4bName ? stemOf(m4bName) : undefined;
  const sharedExts = m4bStem === undefined
    ? []
    : files.filter((f) => stemOf(f) === m4bStem).map((f) => path.extname(f));
  const finalStem = m4bStem === undefined ? undefined : uniqueOutputStem(outputDir, m4bStem, sharedExts);
  if (m4bStem !== undefined && finalStem !== m4bStem) {
    console.log(`[PARALLEL-TTS] "${m4bName}" already exists in the output folder; filing this render as "${finalStem}${path.extname(m4bName!)}" beside it`);
  }
  for (const name of files) {
    const src = path.join(asmDir, name);
    const dest = m4bStem !== undefined && stemOf(name) === m4bStem
      ? path.join(outputDir, `${finalStem}${path.extname(name)}`)
      : uniqueOutputPath(path.join(outputDir, name));
    await fs.rename(src, dest);
    if (name === m4bName) finalM4b = dest;
  }
  try {
    await fs.rmdir(asmDir);
  } catch (err) {
    console.warn(`[PARALLEL-TTS] Assembly staging folder not removed (left as is): ${asmDir}`, err);
  }
  return finalM4b;
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

/**
 * DOES THIS JOB'S PYTHON RUN INSIDE THE WSL GUEST?
 *
 * Asked by everything that is NOT the spawn: where the session directory lives,
 * whether the EPUB has to be staged, which teardown ladder a kill uses, whether a
 * detected output path needs translating back to Windows, and whether a wedged VM
 * means "do not retry".
 *
 * ── It used to lie about Higgs, and the reason expired ───────────────────────
 *
 * This was `shouldUseWslForSpawn` and it returned FALSE for Higgs on purpose:
 * every caller was also the gate in front of `spawnWithWslSupport`, and a Higgs
 * command through that function came out an Orpheus command (it rewrote argv by
 * pattern). So the lie kept Higgs away from it, and each site that genuinely
 * needed the truth had to say `|| (isHiggsJob(...) && higgsRunsInWsl())` and
 * remember to.
 *
 * `spawnWithWslSupport` is gone, so the lie has no beneficiary and several sites
 * were quietly wrong for Higgs: a Higgs job's guest workers were not
 * session-torn-down, its retake did not stage session state into the guest, and a
 * wedged VM did not stop it retrying. It now answers the question it asks.
 *
 * Delegates to `narratorRunsInWsl`, so the answer the app acts on and the arm the
 * spawn actually takes are the same computation rather than two that agree today.
 */
function jobRunsInWsl(ttsEngine?: string): boolean {
  const id = ttsEngine?.toLowerCase();
  if (id !== 'orpheus' && id !== 'higgs') return false;
  // 'worker' stands for every GPU phase: prep, worker and retake all take the
  // same arm, and the tools phases (assembly/resume/list) never ask this.
  return narratorRunsInWsl(id, 'worker');
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

/** Session-scoped guest kill pattern: matches this job's narrator batch doors
 *  (their argv contains `--session <id>`), never another session's worker and never
 *  the persistent Listen server, which carries no session id and is a different
 *  module. Falls back to the global narrator pattern only when the session id is
 *  missing or unsafe to put in a shell.
 *
 *  THE OLD PATTERNS MATCHED NOTHING after the cut-over: `(worker|app)\.py` does not
 *  appear in `python -u -m narrator.compat.worker`, and neither does
 *  `ebook2audiobook.*\.py`. A kill pattern that matches nothing does not fail — the
 *  sweep reports success and leaves a vLLM process holding ~6 GB of VRAM, which is
 *  the shape that wedges the WSL VM and the shape that makes the next job refuse to
 *  start for lack of memory. */
function wslSessionPattern(sessionId: string | undefined | null): string {
  if (sessionId && /^[\w-]+$/.test(sessionId)) return `${NARRATOR_BATCH_RE}.*${sessionId}`;
  return NARRATOR_BATCH_RE;
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
 * `--session <id>`). The persistent Listen/extension server (`python -m narrator.serve`,
 * managed by orpheus-worker-pool.ts) carries NO session id, and the match additionally
 * requires a narrator BATCH door and explicitly excludes the serve process — so the
 * streaming server can never be reaped here. Best-effort and non-fatal.
 *
 * ALL THREE PATTERNS COME FROM `narrator-spawn.ts`, beside the code that builds the
 * command lines they match. Neither half fails loudly when it goes stale: a batch
 * pattern that matches nothing leaves a vLLM process on the GPU and reports success,
 * and an exclusion that matches nothing kills the server a user is listening to.
 */
function reapOrphanedSessionWorkers(sessionId: string | undefined | null): void {
  // Guard: only a clean UUID-ish token may reach the shell (prevents injection and an
  // over-broad match). e2a session ids are [0-9a-f-].
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return;
  try {
    if (os.platform() === 'win32') {
      // Native Windows python workers: match a narrator batch door + this session
      // id, never the resident Listen server.
      try {
        execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | ` +
          `Where-Object { $_.CommandLine -match '${sessionId}' -and ` +
          `($_.CommandLine -match '${NARRATOR_WORKER_RE}' -or $_.CommandLine -match '${NARRATOR_APP_RE}') -and ` +
          `$_.CommandLine -notmatch '${SERVE_PROCESS_RE}' } | ` +
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
        if (new RegExp(SERVE_PROCESS_RE).test(cmd)) continue;  // never the persistent Listen/extension server
        if (!new RegExp(NARRATOR_BATCH_RE).test(cmd)) continue;  // only batch audiobook workers
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
  if (!scoped) {
    const extLock = externalGpuJobLock();
    if (extLock) {
      console.warn(`[PARALLEL-TTS] SKIPPING global WSL orphan cleanup — external GPU job lock present: ${extLock}`);
      return;
    }
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
  // Same accrual, in the two units that survive comparison across books: words (for the
  // readout) and characters (for the ETA). Accrued together with rawCompletedSentences
  // from the same chunk index, so all three describe exactly the same rendered chunks.
  rawCompletedWords?: number;
  rawCompletedChars?: number;
  // The chunk indices this worker has rendered THIS session, as a SET rather than a
  // counter, so two independent progress sources can feed the same tally without
  // double-counting: the worker's "Converting sentence N" stdout line, and (on
  // Mac/MLX) the rendered-file poller that sees a bucket land minutes earlier.
  // See noteRendered. NOT serialized to the renderer (serializeWorkers whitelists).
  renderedIndices?: Set<number>;
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
  // Model-load lifecycle, read off the worker's own stdout announcements. Drives the
  // "Loading voice model" stage bar, which otherwise hides inside a 0% converting bar.
  modelLoadStartedAt?: number;
  modelLoadedAt?: number;
  // Diagnostics — NOT serialized to the renderer (see serializeWorkers); only
  // appended to worker.error on non-zero exit. Capped at MAX_WORKER_STDERR_TAIL_BYTES.
  stderrTail?: string;         // Tail of non-progress stderr lines for crash diagnosis
  // Timestamp of last HuggingFace model-download activity. Used by the startup
  // watchdog so an actively-downloading worker isn't killed at the startup timeout.
  lastDownloadActivityAt?: number;
  // The MLX batch this worker is decoding RIGHT NOW, folded from the engine's
  // heartbeat (see mlx-batch-progress). Per-worker rather than per-session so two
  // workers can't interleave their batches into one non-monotone fraction. Cleared
  // the moment the batch lands (its sentences start reporting) or the worker exits.
  // NOT serialized to the renderer — it rides on AggregatedProgress.activeBatch
  // instead (see serializeWorkers, which whitelists).
  activeBatch?: ActiveBatchState;
}

// Port of bookforge_ext/parallel/session.py `_SENTENCE_END_RE` / `count_real_sentences`.
// A generation chunk holds however many sentences fit the packer's character budget —
// measured at ~1.5-2.7 on average across real books, individual chunks 1 to 9. Count terminal .!?…
// (optionally closed by quotes/brackets) followed by whitespace/end. A chunk with no
// terminal punctuation (heading) still counts as 1. KEEP IN SYNC with the Python regex —
// buildPrepInfo cross-checks the sum against the authoritative total_raw_sentences and
// warns on drift.
function countRealSentences(chunk: string): number {
  if (!chunk) return 1;
  const m = chunk.match(/[.!?…]+["'”’)\]]*(?:\s|$)/g);
  return Math.max(1, m ? m.length : 0);
}

// Words in a chunk: whitespace-delimited runs. Deliberately naive — it has to agree with
// nothing but itself, since it is only ever divided by a time to make a rate.
function countWords(chunk: string): number {
  const m = chunk.match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Per-global-chunk-index text measurements, flattened in the worker's `all_sentences`
 * order (worker_core.py) so index i here is the chunk that renders to {i}.flac.
 *
 * Three units because they answer three different questions, and only one of them is
 * comparable across books:
 *  - sentences: what the user reads in the progress line. Confounded — a chunk holds
 *    however many sentences fit ~310 characters, so a dense author's chunk holds 1.9
 *    where a sparse one holds 4.4, and the rate halves with no change in throughput.
 *  - chars: what the ETA divides. Chunk char-size is near-uniform WITHIN a book, so this
 *    mostly corrects the short trailing chunk at each chapter end, but it is also the
 *    unit that predicts audio duration best (measured across three books: seconds-per-char
 *    varied ±6%, seconds-per-word ±11%).
 *  - words: what the readout shows, because "2,040 words/min" is legible and
 *    "12,597 chars/min" is not. Same accuracy as chars for display purposes.
 */
interface ChunkTextMetrics {
  sentences: number[];
  words: number[];
  chars: number[];
}

function buildChunkTextMetrics(chapterSentences: unknown): ChunkTextMetrics {
  const metrics: ChunkTextMetrics = { sentences: [], words: [], chars: [] };
  if (!Array.isArray(chapterSentences)) return metrics;
  for (const chapter of chapterSentences) {
    if (!Array.isArray(chapter)) continue;
    for (const chunk of chapter) {
      const text = typeof chunk === 'string' ? chunk : '';
      metrics.sentences.push(countRealSentences(text));
      metrics.words.push(countWords(text));
      metrics.chars.push(text.length);
    }
  }
  return metrics;
}

// Add the EXACT real-sentence count of a just-rendered chunk (global 0-based index, from the
// worker's "Converting sentence {i}/{total}" line) to the worker's session tally, when
// per-chunk counts are known. Bounds-guarded so a stray/legacy index never corrupts the sum.
function accrueRawCompleted(session: ConversionSession, worker: WorkerState, chunkIndex: number): void {
  if (chunkIndex < 0) return;
  const prep = session.prepInfo;
  const counts = prep?.rawSentenceCounts;
  if (counts && chunkIndex < counts.length) {
    worker.rawCompletedSentences = (worker.rawCompletedSentences || 0) + counts[chunkIndex];
  }
  // Words and chars accrue from their own arrays rather than being derived from the
  // sentence tally — the whole point of these units is that the ratio between them is
  // a property of the book, not a constant to multiply by.
  const words = prep?.wordCounts;
  if (words && chunkIndex < words.length) {
    worker.rawCompletedWords = (worker.rawCompletedWords || 0) + words[chunkIndex];
  }
  const chars = prep?.charCounts;
  if (chars && chunkIndex < chars.length) {
    worker.rawCompletedChars = (worker.rawCompletedChars || 0) + chars[chunkIndex];
  }
}

/**
 * Record that chunk `chunkIndex` finished rendering, from EITHER progress source.
 *
 * Two sources report the same completions at very different times:
 *  - the worker's "Converting sentence N/M" stdout line, and
 *  - (Mac/MLX) the rendered-file poller, which sees the flac land 1-4 minutes earlier
 *    because worker_core buffers a whole 96-chunk batch before printing any of them.
 *
 * A plain counter would double every completion. An index SET makes the second report
 * a no-op, so the two sources compose: whichever sees a chunk first moves the bar, and
 * the tally is correct no matter how they interleave. This is also why the raw-sentence
 * accrual lives here — it must happen exactly once per chunk.
 *
 * Returns true when this was a NEW completion.
 */
function noteRendered(session: ConversionSession, worker: WorkerState, chunkIndex: number): boolean {
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return false;
  if (!worker.renderedIndices) worker.renderedIndices = new Set<number>();
  if (worker.renderedIndices.has(chunkIndex)) return false;
  worker.renderedIndices.add(chunkIndex);
  worker.completedSentences = worker.renderedIndices.size;
  accrueRawCompleted(session, worker, chunkIndex);
  worker.lastProgressAt = Date.now();
  return true;
}

export interface PrepInfo {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  chaptersDir: string;
  chaptersDirSentences: string;
  totalChapters: number;
  /** Number of GENERATION CHUNKS (the scheduling unit). For Orpheus/Voxtral a chunk
   *  packs a variable number of real sentences, so this is NOT the real sentence count. */
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
  /** Per-global-chunk-index word and character counts, same order as rawSentenceCounts.
   *  Words drive the speed readout, characters the ETA — see ChunkTextMetrics for why
   *  neither is derived from the other. Absent together with rawSentenceCounts. */
  wordCounts?: number[];
  charCounts?: number[];
  /** Whole-book word/character totals, for the remaining-work half of the ETA. */
  totalRawWords?: number;
  totalRawChars?: number;
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
  // Absolute project DIRECTORY - final audio is copied to {projectDir}/audiobook/.
  // Still named bfpPath because that is the key persisted in queue.json.
  bfpPath?: string;
  // Is this an article (language learning) vs a book?
  // Articles: copy to the project's audiobook/ only
  isArticle?: boolean;
  // Optional RVC voice-enhancement pass. When enabled, each rendered TTS sentence
  // is re-rendered through an RVC voice model (warm-model batch) BEFORE assembly,
  // and the enhanced set is assembled via e2a's --sentences_dir. The original XTTS
  // sentences are left cached/untouched so either version can be (re)assembled.
  rvcEnhancement?: {
    enabled: boolean;
    voiceId: string;     // enhancement-voice asset id (resolved to model name in the backend)
    indexRate?: number;  // 0–1; absent = the voice's own tuned value, else 0.5
    protectRate?: number; // INVERTED — lower protects more, 0.5 is off (PROTECT_RATE_NOTE)
    nSemitones?: number; // pitch shift; 0 = none, negative = lower
    f0Method?: string;   // rmvpe|crepe|crepe-tiny; absent = urvc's own default
    hopLength?: number;  // crepe-family only; absent = urvc's own default
  };
  // Final-audio denoise: run the block-based roformer denoise pass (denoise-bridge)
  // over the rendered sentences after generation, BEFORE any RVC pass and before
  // assembly. Orpheus voices are trained on a deliberate faint room-hiss bed
  // (~-65 dBFS; load-bearing for reliable end-of-audio), so raw renders carry a
  // hiss during speech that cuts out at the digitally-silent assembly gaps — this
  // strips it once, over the sentence set. false/absent = zero behavioral change.
  finalDenoise?: boolean;
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
  /**
   * 'stopped' is deliberately NOT 'error'. A user stop leaves a complete, resumable
   * session on disk; an error does not. Reporting the stop as an error made the renderer
   * write a terminal 'error' status from this progress event, which then tripped
   * handleJobComplete's double-processing guard — so the authoritative completion, the
   * only message carrying wasStopped, returned before it could mark the job resumable.
   * The job stuck in 'error', which nothing revives: Start only revives 'stopped', and
   * loadQueueState only revives 'processing'. Stopping a job made it unresumable.
   */
  phase: 'preparing' | 'converting' | 'assembling' | 'enhancing' | 'complete' | 'error' | 'stopped';
  /** GENERATION CHUNKS (the scheduling unit; each packs a variable number of real sentences). */
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
  /** Words and characters rendered THIS session, accrued over the same chunks as
   *  rawCompletedInSession. Words are what the speed readout shows; characters are what
   *  the ETA divides. Present exactly when prep supplied the per-chunk counts. */
  rawWordsCompletedInSession?: number;
  rawCharsCompletedInSession?: number;
  /** Whole-book word/character totals — the remaining-work half of the ETA. */
  totalRawWords?: number;
  totalRawChars?: number;
  /** Seconds of AUDIO produced per character of text, sampled from the rendered FLACs
   *  (probeAudioSeconds). Turns a text rate into the realtime factor, which is the only
   *  throughput figure comparable across books AND voices. Absent until sampled. */
  audioSecondsPerChar?: number;
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
  // Ordered stage bars for this run (prepare → load model → convert → assemble).
  // Replaces the renderer's guess-from-phase derivation: the bridge is the only
  // thing that knows the model spent 40 s loading before conversion began.
  stages?: JobStageProgress[];
  // One line of "what is happening RIGHT NOW inside the running stage" — the MLX
  // bucket heartbeat, or which chunk is being repaired. A bucket can run 4 minutes
  // with no completion, and without this the bar is indistinguishable from a hang.
  stageDetail?: string;
  // Progress WITHIN the MLX batch currently decoding (Mac/Orpheus only). The chunk
  // bar cannot move during a batch — all ~96 sentence files land at once when it
  // ends — so this is the only thing that moves for 5-7 minutes. ABSENT whenever no
  // batch is generating (vLLM, XTTS, between batches): absent means absent, never a
  // fabricated zero. See mlx-batch-progress.ts.
  activeBatch?: ActiveBatchProgress;
  // Progress WITHIN the preparing stage, when prep is doing counted work before
  // e2a is even spawned — today the number-normalization pass, which walks the
  // book paragraph by paragraph through a local model and can run for minutes.
  // The 'preparing' stage bar cannot move during it (nothing has been prepped
  // yet), so this is the only thing that moves. ABSENT means absent: a job with
  // no counted prep work reports no bar rather than a fabricated zero.
  prep?: PrepSubProgress;
}

/** Counted work inside the preparing stage: what it is, and how far along. */
export interface PrepSubProgress {
  label: string;
  done: number;
  total: number;
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

/**
 * Is this job a Higgs job? The single predicate every Higgs branch in this file
 * is written against, so "what did the Higgs change touch" is one grep.
 *
 * Everything gated on it is additive: an Orpheus job takes the same branch it
 * always did, with the same argv (asserted by tools/test-orpheus-argv-snapshot.js).
 */
export /** Drop `flag` and the value after it from an argv array. */
function stripFlagWithValue(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at < 0) return args;
  return [...args.slice(0, at), ...args.slice(at + 2)];
}

export function isHiggsJob(settings: ParallelTtsSettings): boolean {
  return settings.ttsEngine === 'higgs';
}

/**
 * Which narrator engine this job runs on.
 *
 * REFUSES a retired id rather than coercing it. `assertRunnableTtsEngine` already
 * guards the queue boundary and the retake door, but a session-state.json written
 * by an XTTS-era build reaches some of these functions with no UI in between, and
 * an engine that silently became Orpheus would render a whole book in a voice
 * nobody chose and report success.
 */
function narratorEngineFor(settings: ParallelTtsSettings): NarratorEngineId {
  if (settings.ttsEngine === 'higgs') return 'higgs';
  if (settings.ttsEngine === 'orpheus') return 'orpheus';
  throw new Error(
    `TTS engine '${settings.ttsEngine}' cannot render: narrator serves orpheus and higgs. ` +
      'XTTS was retired 2026-09-04 and its sessions load read-only.',
  );
}

/**
 * THE spawn door for every batch phase, for every engine.
 *
 * One argv, one environment, one plan — the point of Phase 3. Before it, each of
 * prep / worker / retake / assembly carried an `if (isHiggsJob)` that built a
 * SECOND command line beside the e2a one, sliced the first at an anchor flag and
 * substituted the engine name in place. Four copies of that, each able to drift
 * from the others; the retake copy already had.
 *
 * The Higgs branch here is not a second command line. It is the same argv with
 * the voice document written for it (`higgsEnvExtras`), which is the one thing
 * that is genuinely about Higgs and not about spawning.
 */
function buildJobSpawn(opts: {
  settings: ParallelTtsSettings;
  phase: NarratorPhase;
  args: string[];
  envExtras: Record<string, string>;
  /** Names the Higgs voice document written for this run; ignored for Orpheus. */
  jobId: string;
  cwdHint?: string;
}): NarratorSpawnPlan {
  const engine = narratorEngineFor(opts.settings);
  if (engine === 'higgs') {
    return buildHiggsSpawn(opts.phase, {
      model: higgsPreflight(opts.settings.fineTuned),
      args: opts.args,
      cwd: opts.cwdHint ?? getDefaultE2aPath(),
      jobId: opts.jobId,
      envExtras: opts.envExtras,
    });
  }
  return buildNarratorSpawn({
    engine,
    phase: opts.phase,
    args: opts.args,
    envExtras: opts.envExtras,
    cwdHint: opts.cwdHint,
  });
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
/**
 * Start closing chapters in the background, if this job's shape allows it.
 *
 * A chapter can only be finished early when nothing downstream is still going to
 * rewrite its sentences, so this deliberately declines more often than it accepts:
 *
 *  - Orpheus only. The closer has to reproduce assembly's gap normalization exactly,
 *    and the gap plus the min-chunk floor are per-voice Orpheus values; for other
 *    engines assembly may not normalize at all, and guessing wrong changes the audio.
 *  - No final-denoise and no RVC pass. Both re-render the WHOLE sentence set after
 *    generation, which would make every pre-encoded chapter stale by definition.
 *  - MP4-family output only, matching e2a's parallel-export gate — an m4a chunk's
 *    edit list is what makes the concatenation gapless.
 *
 * Failing to start is never fatal: assembly just does the work itself, as today.
 */
function maybeStartChapterCloser(session: ConversionSession): void {
  const { config, prepInfo } = session;
  const settings = config.settings;

  // Every reason to decline is REPORTED. The first version of this returned bare,
  // and when the closer then did not run on its first real book there was no way to
  // tell which condition had rejected it — the feature and a silently-skipped
  // feature look identical from the outside. Declining is fine; declining without
  // saying so is not.
  const decline = (reason: string): void => {
    writeWorkerLog(`[CLOSER] not started: ${reason}`);
    logger.log('INFO', session.jobId, `Chapter closer not started: ${reason}`).catch(() => {});
  };

  if (!prepInfo) return decline('prep info is not available');
  if (settings.ttsEngine?.toLowerCase() !== 'orpheus') {
    return decline(`engine is ${settings.ttsEngine ?? 'unset'}, not orpheus`);
  }
  if (config.finalDenoise) return decline('a final-denoise pass is scheduled, which re-renders every sentence afterwards');
  if (config.rvcEnhancement?.enabled) return decline('an RVC pass is scheduled, which re-renders every sentence afterwards');
  if (config.skipAssembly) return decline('skipAssembly is set — the caller concatenates the sentences itself');
  if (!prepInfo.chapters?.length) return decline('prep reported no chapter ranges');
  // The output format is deliberately NOT checked here: BookForge never passes one,
  // so e2a's own default governs, and e2a is the authority anyway — its
  // parallel_export_supported() gate ignores the pre-encoded chapters outright on
  // any mode where they are not equivalent (non-MP4 container, active pre-loudnorm
  // filter, or a book short enough that loudnorm must measure it whole). Guessing
  // that here would only add a second, less-informed copy of the same rule.

  // The same per-voice values reassembly-bridge resolves from provenance. They are
  // part of the AUDIO — a different floor means different trailing silence — so the
  // closer records them and assembly refuses the output if they no longer match.
  const voice = settings.fineTuned;
  const gapSeconds = resolveOrpheusSentenceGap(voice) ?? DEFAULT_SENTENCE_GAP;
  const minGapSeconds = resolveOrpheusMinChunkGap(voice) ?? 0;

  startChapterCloser({
    jobId: session.jobId,
    sessionId: prepInfo.sessionId,
    sentencesDir: toReadablePath(prepInfo.chaptersDirSentences),
    chapters: prepInfo.chapters.map((c) => ({
      chapterNum: c.chapterNum,
      sentenceStart: c.sentenceStart,
      sentenceEnd: c.sentenceEnd,
    })),
    tmpRoot: getDefaultE2aTmpPath(),
    gapSeconds,
    minGapSeconds,
    // Mono, because e2a's default_output_channel is 'mono' and BookForge never
    // overrides it — grep confirms no output_channel arg is passed from here. The
    // chunks must match what export_audio_parallel would have produced; if that
    // setting ever becomes configurable, this has to follow it.
    outputChannels: 1,
    onLog: (message) => {
      writeWorkerLog(`[CLOSER] ${message}`);
      logger.log('INFO', session.jobId, `Chapter closer: ${message}`).catch(() => {});
    },
  }).catch((err) => {
    writeWorkerLog(`[CLOSER] failed to start: ${err}`);
    logger.log('WARN', session.jobId, `Chapter closer failed to start: ${err}`).catch(() => {});
  });
}

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
// A live MLX batch now emits a ~15s heartbeat (orpheus.py _convert_mlx_batch ->
// GENERATION_ACTIVITY_RE), so a healthy worker refreshes this timer continuously.
// 12 min is the backstop for a GENUINE hang (no heartbeat at all), widened from 5 min
// because a legit MLX batch on a slow voice under GPU contention can run several
// minutes between per-sentence lines and the old 5 min false-killed it.
const WORKER_PROGRESS_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes without ANY heartbeat = stuck
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
const GENERATION_ACTIVITY_RE = /audio-token cap|re-rendering split|Processed prompts|Adding requests|MLX batch generating/i;
// GENUINE network download only — NOT a cache hit or disk load. huggingface_hub's tqdm
// shows a byte-rate ("124MB/s") only while actually transferring bytes; a cache hit shows
// "it/s" and shard-loading from disk shows "s/it". So require a byte-rate (or the explicit
// "Downloading" verb) before telling the user it's downloading — otherwise the note fired
// on every cached run (e.g. vLLM's "Loading safetensors checkpoint shards"), which looked
// like a re-download that wasn't happening.
const MODEL_DOWNLOAD_RE = /\bdownloading\b|\b\d+(?:\.\d+)?\s?[KMG]?B\/s\b/i;
const MODEL_DOWNLOAD_NOTE = 'Downloading TTS model (first run — this can take a while)…';

// ─── Stage / liveness markers on worker stdout ───────────────────────────────
// The worker announces its own lifecycle; we just never read it. These turn the
// silent gap between "worker spawned" and "first sentence" into two honest bars.
const MODEL_LOAD_START_RE = /Loading .*TTS with voice|Loading Orpheus model with|Loading .* model\b/i;
const MODEL_LOAD_DONE_RE = /TTS Loaded!|model loaded!/i;
// The MLX batch heartbeat (orpheus.py _convert_mlx_batch) — the ONLY signal inside a
// batch that can run for minutes. Parsing lives in mlx-batch-progress.ts, which reads
// the bucket width, the longest row's token count, the retired-row count, the token
// depth bound and the batch ordinal, and tolerates the older token-only line.
// A chunk that overran the token cap is being repaired by the serial re-split ladder
// (_generate_mlx_safe). Minutes long, and otherwise indistinguishable from a stall.
/**
 * The render progress line: `Converting sentence <i>/<total> (<pct>%)`.
 *
 * ONE shape. Groups are (index, total, percent) IN THAT ORDER, which is why the
 * e2a-era alternative that used to be tried first — `Converting sentence 49 -
 * 0.53%: 49/9248`, groups (index, percent, done, total) — could not simply be
 * left in place: a line matching it fills the same four variables from different
 * positions. narrator emits only this one and asserts it emits nothing matching
 * the other (render/PORT_NOTES.md section 6).
 */
const PROGRESS_LINE_RE = /Converting sentence (\d+)\/(\d+)\s*\(([\d.]+)%\)/i;

const REPAIR_START_RE = /sentence (\d+) (?:hit the MLX audio-token cap|produced no audio|audio too short for text)/i;

/**
 * How often the rendered-file poller re-reads the sentences dir (Mac/MLX only —
 * see startRenderedPoller). A bucket takes 1-4 minutes, so 4 s costs one cheap
 * readdir per tick and never misses a bucket boundary by more than that.
 */
const RENDERED_POLL_INTERVAL_MS = 4000;

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
  // Final-audio denoise: when the denoise pass runs, the denoised sentence files
  // land here. It runs BEFORE any RVC pass (which then reads from here), and when
  // no RVC pass follows, assembly is pointed at it via --sentences_dir.
  denoisedSentencesDir?: string;
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
  // Rendered-file poller (Mac/MLX only — see startRenderedPoller). MLX buckets land
  // on disk 1-4 minutes before the worker's stdout reports them, so the filesystem is
  // the fresher progress source there.
  renderedPollTimer?: NodeJS.Timeout;
  // Chunk indices already on disk when the poller started. Excluded from this
  // session's tally so resume progress means "rendered NOW", matching the stdout
  // semantics (a skipped/pre-existing chunk never prints a progress line).
  preexistingRendered?: Set<number>;
  // Stage timeline. prepDoneAt marks the prepare→load boundary; the model-load
  // boundary comes from the workers' own modelLoadedAt.
  prepStartedAt?: number;
  prepDoneAt?: number;
  // Live "what's happening inside the current stage" text (MLX bucket heartbeat, or
  // the chunk currently being repaired). Overwritten on every marker line.
  stageDetail?: string;
  // ETA calculation - exclude model setup time
  firstSentenceCompletedTime?: number;  // When first sentence actually completed (excludes model loading)
  // Rolling sample of how much AUDIO the rendered chunks actually contain — the only
  // measurement that makes the realtime factor a measurement rather than an estimate.
  // See probeAudioSeconds.
  audioProbe?: AudioProbeState;
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
  // Which artifact form this job's Orpheus voice is served from ('merged' or
  // 'adapter'), resolved ONCE in the GPU preflight (acquireGpuForJob) and reused by
  // the OOM-retry VRAM wait so the retry can't ask for a smaller floor than the
  // preflight required — an adapter spawn needs ~1.8 GiB more than a merged one.
  // Absent on a job whose preflight never ran (CPU / non-Orpheus engines).
  orpheusServeArtifact?: OrpheusServeArtifact;
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
  // True once assertGpuIsOurs has run for this session. The guard answers "is
  // someone ELSE rendering", so it belongs to the session, not the worker: an
  // OOM-retry respawn (retryWorker) and workers 1..n are the same render as
  // worker 0 and must not re-ask.
  gpuOwnershipChecked?: boolean;
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
  /**
   * ── Real-sentence measurements (optional) ─────────────────────────────────
   *
   * The two fields above count GENERATION CHUNKS, whose sentence content depends on
   * this book's packing (~1.5-3.5 sentences each, individual chunks 1 to 9). These two
   * count real sentences and the time actually spent rendering them, which is what
   * makes a rate comparable across books.
   *
   * Both are absent on runs recorded before they existed, and absent on runs where the
   * figure genuinely isn't known (no per-chunk counts from prep, or no first-chunk
   * stamp). They are never backfilled or estimated — absence is the honest answer, and
   * the aggregate below simply skips any run missing either one.
   */
  /** EXACT real sentences rendered in this run — summed per chunk, never chunks × average. */
  rawSentencesProcessedInRun?: number;
  /** Seconds spent rendering: measured from the first completed chunk, so model load and prep are excluded. */
  workSeconds?: number;
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
  /**
   * ── Real-sentence aggregates (optional) ───────────────────────────────────
   *
   * The chunk-based totals above are the ETA priors and stay as they are. These two are
   * the analytics figure: real sentences per minute across every run that recorded both
   * a raw count and a work-time span.
   *
   * The denominators DIFFER on purpose. historicalSentencesPerMinute divides by
   * totalElapsedSeconds — wall clock, model load and prep included — because a resume
   * ETA has to re-pay those costs. This one divides by summed workSeconds, because model
   * load is not rendering throughput: a job whose engine took 90s to load did not render
   * more slowly, and folding that in makes two identical renders look different.
   *
   * Absent when no run qualifies (all legacy, or none had per-chunk counts). Never
   * estimated from the chunk figures.
   */
  totalRawSentencesProcessed?: number;
  historicalRawSentencesPerMinute?: number;
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

/**
 * This run's real-sentence measurements, for the run record.
 *
 * Each field is present only when it is genuinely known, and is left undefined
 * otherwise — a run without per-chunk counts from prep, or without a first-chunk
 * stamp, contributes nothing to the cross-run rate rather than contributing a guess.
 */
function measureRunForState(session: ConversionSession, now: number): {
  rawSentencesProcessedInRun?: number;
  workSeconds?: number;
} {
  const rawSentencesProcessedInRun = session.prepInfo?.rawSentenceCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedSentences || 0), 0)
    : undefined;

  // Work time, not wall clock: the span since the first chunk landed, so model load and
  // prep are excluded (see historicalRawSentencesPerMinute).
  const renderStartedAt = session.firstSentenceCompletedTime;
  const workSeconds = renderStartedAt
    ? Math.round((now - renderStartedAt) / 1000)
    : undefined;

  return { rawSentencesProcessedInRun, workSeconds };
}

/**
 * Recompute the cross-run real-sentence aggregates over the runs that recorded BOTH a
 * raw sentence count and a work-time span.
 *
 * Runs missing either are skipped entirely — not treated as zero, and not backfilled
 * from their chunk figures — so legacy state files simply contribute nothing and the
 * rate stays a measurement of the runs that actually measured. When no run qualifies,
 * both aggregates stay undefined rather than becoming 0.
 */
function applyRawAggregates(state: PersistentSessionState): void {
  const qualifying = state.runs.filter(
    r => r.rawSentencesProcessedInRun !== undefined && r.workSeconds !== undefined
  );
  if (qualifying.length === 0) {
    state.totalRawSentencesProcessed = undefined;
    state.historicalRawSentencesPerMinute = undefined;
    return;
  }

  const totalRaw = qualifying.reduce((sum, r) => sum + (r.rawSentencesProcessedInRun || 0), 0);
  const totalWorkSeconds = qualifying.reduce((sum, r) => sum + (r.workSeconds || 0), 0);

  state.totalRawSentencesProcessed = totalRaw;
  state.historicalRawSentencesPerMinute = totalWorkSeconds > 0
    ? Math.round((totalRaw / (totalWorkSeconds / 60)) * 10) / 10
    : undefined;
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

    // Real-sentence measurements for this run (absent when unknown — never estimated).
    const runMeasurement = measureRunForState(session, now);
    currentRun.rawSentencesProcessedInRun = runMeasurement.rawSentencesProcessedInRun;
    currentRun.workSeconds = runMeasurement.workSeconds;

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

    // Real sentences per minute of RENDER time — the comparable-across-books figure.
    applyRawAggregates(state);

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
    const endedAt = Date.now();
    const currentRun = state.runs.find(r => r.runId === session.jobId);
    if (currentRun) {
      currentRun.endTime = new Date(endedAt).toISOString();
      currentRun.status = status;
      if (error) currentRun.error = error;

      // Final real-sentence measurements for this run (absent when unknown).
      const runMeasurement = measureRunForState(session, endedAt);
      currentRun.rawSentencesProcessedInRun = runMeasurement.rawSentencesProcessedInRun;
      currentRun.workSeconds = runMeasurement.workSeconds;
    }

    // Recalculate totals
    state.totalElapsedSeconds = state.runs.reduce((sum, r) => sum + r.elapsedSeconds, 0);
    state.totalSentencesProcessed = state.runs.reduce((sum, r) => sum + r.sentencesProcessedInRun, 0);

    if (state.totalElapsedSeconds > 0 && state.totalSentencesProcessed > 0) {
      state.historicalSentencesPerMinute = Math.round(
        (state.totalSentencesProcessed / (state.totalElapsedSeconds / 60)) * 10
      ) / 10;
    }

    // Real sentences per minute of RENDER time — the comparable-across-books figure.
    applyRawAggregates(state);

    // Save final state
    const stateFile = getStateFilePath(session.prepInfo.processDir);
    fsSync.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const rawNote = state.historicalRawSentencesPerMinute !== undefined
      ? `, ${state.totalRawSentencesProcessed} raw sentences @ ${state.historicalRawSentencesPerMinute} sent/min`
      : '';
    console.log(`[PARALLEL-TTS] Finalized run state: ${status}, total ${state.totalElapsedSeconds}s, ${state.totalSentencesProcessed} sentences${rawNote}`);
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
  // Main hears it too: the queue engine lives on THIS side now, and a
  // webContents.send cannot be heard here. Published first so a torn-down window
  // does not cost the scheduler its progress. See electron/bridge-events.ts.
  publishBridgeEvent(channel, payload);
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

    if (jobRunsInWsl(ttsEngine)) {
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
  const sessionId = crypto.randomUUID();

  // The Higgs ENVIRONMENT, checked ONCE for this job — not once per worker.
  // The doctor is a WSL round trip; running it per range put a ~1 s blocking
  // call on the main thread (the one the bookshelf server shares) for a resource
  // that cannot change between the workers of one job. Here it is awaited, in an
  // async context, before anything spawns.
  if (isHiggsJob(settings)) {
    const envRefusal = await higgsEnvironmentRefusal();
    if (envRefusal) throw new Error(envRefusal);
  }

  // When using WSL for Orpheus, the session is created in WSL's filesystem
  // We need to use the WSL path for session directory and convert to Windows UNC for reading
  // WHERE THE SESSION LIVES: the guest's filesystem for a guest prep, so the
  // session dir and the staged EPUB are somewhere the spawned python can open.
  //
  // The `|| (isHiggsJob(...) && higgsRunsInWsl())` that used to be needed here is
  // gone: `jobRunsInWsl` answers for Higgs now. It did not before, because every
  // caller was also the gate in front of `spawnWithWslSupport`, and a Higgs command
  // through that function came out an Orpheus command. See jobRunsInWsl's header.
  const useWsl = jobRunsInWsl(settings.ttsEngine);
  let sessionDir: string;
  let sessionDirForReading: string;
  // The --ebook path as the spawned e2a will see it. For a WSL prep the file is
  // STAGED into WSL's own filesystem first: buildWslBashCommand maps drive
  // letters to /mnt/<letter>, but WSL auto-mounts only fixed drives — a library
  // on a mapped network drive (Z: → titan since 2026-08-17) has no /mnt/z, and
  // prep died in prepare_dirs' shutil.copy on exactly that. Staging through the
  // \\wsl$ UNC works for EVERY source the host can read — local, mapped, or UNC
  // — so it is done unconditionally for WSL preps rather than by probing mounts.
  let ebookArgPath = epubPath;
  let stagedEbookUnc: string | null = null;

  if (useWsl) {
    // Session will be created in WSL's e2a path
    const wslE2aPath = getWslE2aPath();
    sessionDir = `${wslE2aPath}/tmp/ebook-${sessionId}`;
    // Convert to Windows UNC path for reading from Node.js
    sessionDirForReading = wslPathToWindows(sessionDir);
    console.log(`[PARALLEL-TTS] WSL session dir: ${sessionDir} -> ${sessionDirForReading}`);

    // Stage the ebook where WSL can read it. Prep copies it into the session
    // dir immediately (prepare_dirs), so the staged file is deleted again the
    // moment prep settles — see the finally below.
    const stagedWsl = `${wslE2aPath}/tmp/staged-${sessionId}${path.extname(epubPath)}`;
    stagedEbookUnc = wslPathToWindows(stagedWsl);
    await fs.mkdir(path.dirname(stagedEbookUnc), { recursive: true });
    await fs.copyFile(epubPath, stagedEbookUnc);
    ebookArgPath = stagedWsl;
    console.log(`[PARALLEL-TTS] Staged ebook for WSL: ${epubPath} -> ${stagedWsl}`);
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

  // narrator's prep flags. One array for every engine — the Higgs branch below
  // only substitutes the voice flag, because `--fine_tuned` carries an Orpheus
  // prompt TOKEN and `--higgs_voice` a CATALOG ID and neither stands in for the
  // other.
  //
  // `--session_dir` IS MANDATORY, and it is the one flag that was NOT here
  // before. e2a survived without it because `lib/conf.py` fell back to
  // `<e2a_root>/tmp`, which happened to be the directory this function had
  // already computed. narrator has no e2a root: `session_store.sessions_root()`
  // reads `$E2A_TMP_DIR` and otherwise refuses to guess. Forwarding E2A_TMP_DIR
  // is NOT an alternative — it holds a WINDOWS path while a WSL prep derives its
  // session dir from the guest's filesystem, so the two would disagree exactly
  // where it matters.
  const args = [
    '--headless',
    '--ebook', ebookArgPath,
    '--session', sessionId,
    '--session_dir', sessionDir,
    '--language', settings.language,
    '--tts_engine', narratorEngineId(narratorEngineFor(settings)),
    '--device', deviceArg,
    '--prep_only'
  ];

  if (isHiggsJob(settings)) {
    args.push(HIGGS_VOICE_FLAG, higgsPreflight(settings.fineTuned).id);
  } else {
    pushVoiceArgs(args, settings);
  }

  // The XTTS sampling block that stood here (--temperature / --top_p / --top_k /
  // --repetition_penalty / --speed / --enable_text_splitting) is GONE. narrator
  // parses all six and honours none of them: compat/FLAGS.md files them under
  // IGNORE, "XTTS only", and Orpheus's equivalents arrive as ORPHEUS_TEMPERATURE
  // / ORPHEUS_TOP_P / ORPHEUS_REP_PENALTY env vars or as registered per-voice
  // caps. Sending them anyway would suggest a book's sampling had been honoured
  // when nothing read it.

  // Language learning mode: preserve paragraph boundaries as sentences
  if (settings.sentencePerParagraph) {
    args.push('--sentence_per_paragraph');
  }

  // Skip heading text in TTS (headings parsed for chapter detection but not spoken)
  if (settings.skipHeadings) {
    args.push('--skip_headings');
  }

  console.log('[PARALLEL-TTS] Running prep with:', args.join(' '));

  // The staged copy's whole job is done once prep settles: prepare_dirs copies
  // the ebook into the session dir in its first act, and nothing after prep
  // reads --ebook through WSL again (assembly runs natively on the original).
  const removeStagedEbook = async (): Promise<void> => {
    if (stagedEbookUnc === null) return;
    const staged = stagedEbookUnc;
    stagedEbookUnc = null;
    try {
      await fs.unlink(staged);
    } catch (err) {
      console.error(`[PARALLEL-TTS] Staged ebook could not be removed (${staged}): ${(err as Error).message}`);
    }
  };

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

    // Per-voice caps for the selected fine-tune (maxChars is the one prep consumes).
    const voiceCaps = orpheusVoiceCaps(settings);
    // ── ONE PREP ROUTE, for every engine ────────────────────────────────────
    //
    // narrator, not ebook2audiobook. For Higgs that was already true and the
    // reason was specific: `text/paragraph_packer.py` IS the Higgs chunking rule,
    // `compat/app.py` forces `chunking = 'paragraph'` for `higgs-v3`, and the
    // session it writes records the engine and the voice where the render route
    // will look for them. For Orpheus it is now true for the plainer reason —
    // there is nothing else left to prep with.
    //
    // The Higgs-only branch that stood here is gone with it. It existed because
    // the e2a route could not be made to write a correct Higgs session; a second
    // spawn shape is not something to keep once the first one is right.
    const prepPlan = buildJobSpawn({
      settings,
      phase: 'prep',
      args,
      jobId: prepJobId || sessionId,
      // ORPHEUS_MAX_CHARS is consumed HERE (prep packs sentences), not in the
      // worker. Precedence: an explicit user env override wins, else the selected
      // voice's declared packing cap, else nothing — NO invented default.
      envExtras: {
        ...(settings.ttsEngine === 'orpheus'
          && (process.env.ORPHEUS_MAX_CHARS?.trim() || voiceCaps.maxChars !== undefined)
          ? { ORPHEUS_MAX_CHARS: process.env.ORPHEUS_MAX_CHARS?.trim() || String(voiceCaps.maxChars) }
          : {}),
        // Native-arm only: these are Windows belt-and-braces guards against vLLM
        // touching CUDA graphs in an env that cannot capture them. Sending them
        // into WSL would fight ORPHEUS_DISABLE_EAGER, which is the whole reason
        // Orpheus runs there — and under buildNarratorSpawn every value in
        // envExtras DOES cross, where the old forwardKeys allowlist silently
        // dropped them.
        ...(narratorRunsInWsl(narratorEngineFor(settings), 'prep')
          ? { ORPHEUS_DISABLE_EAGER: '1' }
          : { VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1' }),
        VLLM_USE_V1: '0',
      },
      cwdHint: getDefaultE2aPath(),
    });
    console.log('[PARALLEL-TTS] Prep → narrator:', prepPlan.describe());

    const prepProcess = spawn(prepPlan.command, prepPlan.args, {
      cwd: prepPlan.cwd,
      env: prepPlan.env,
      shell: false,
    });

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
        if (prepPlan.viaWsl) {
          // Session-scoped graceful teardown (prep argv carries --session <id>); prep
          // is CPU text work / a hung download, so a short grace suffices. Wrapper is
          // closed only after the guest process is gone.
          //
          // THE PATTERN IS NARRATOR'S MODULE NAME. `app\.py` matches nothing in
          // `python -u -m narrator.compat.app`, so a stalled prep would have been
          // reported as killed and left running in the guest, holding the session.
          void destroyWslGuestProcesses(`${NARRATOR_APP_RE}.*${sessionId}`, { graceMs: 10000, label: 'prep-stall' })
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
  }).finally(removeStagedEbook);

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
  const chunkMetrics = buildChunkTextMetrics(state.chapter_sentences);
  const rawSentenceCounts = chunkMetrics.sentences;
  const rawCountsSum = rawSentenceCounts.reduce((a, b) => a + b, 0);
  const rawWordsSum = chunkMetrics.words.reduce((a, b) => a + b, 0);
  const rawCharsSum = chunkMetrics.chars.reduce((a, b) => a + b, 0);
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
    // Real sentence count, COUNTED from the chunk text. Undefined when there is no chunk
    // text to count — never the chunk count standing in for it. That substitution made the
    // sentences-per-chunk ratio exactly 1.0, so every reader downstream reported chunks as
    // though they were sentences, with nothing to indicate the count had failed.
    // (e2a does not currently write total_raw_sentences at all; when it starts, its value
    // wins and the cross-check above reports any drift from this count.)
    totalRawSentences: state.total_raw_sentences ?? (rawCountsSum > 0 ? rawCountsSum : undefined),
    rawSentenceCounts: rawSentenceCounts.length > 0 ? rawSentenceCounts : undefined,
    wordCounts: chunkMetrics.words.length > 0 ? chunkMetrics.words : undefined,
    charCounts: chunkMetrics.chars.length > 0 ? chunkMetrics.chars : undefined,
    totalRawWords: rawWordsSum > 0 ? rawWordsSum : undefined,
    totalRawChars: rawCharsSum > 0 ? rawCharsSum : undefined,
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
// ─────────────────────────────────────────────────────────────────────────────
// Discrete-index regeneration (BookForge "Correct Sentences")
// ─────────────────────────────────────────────────────────────────────────────

export interface RegenerateIndicesParams {
  /** Session UUID (the part after "ebook-"). */
  sessionId: string;
  /** The ebook-{uuid} directory (parent of the {hash} processDir). The worker's
   *  load_session_state scans its subdirs for session-state.json. */
  sessionDir: string;
  /** Cached render settings (session_state.json → settings) so regenerated audio
   *  matches the original render exactly — same engine, voice, model, speed. */
  settings: ParallelTtsSettings;
  /** Discrete sentence indices to (re)generate. */
  indices: number[];
  /** Scratch directory to write {i}.flac into (NOT the live cache). When numTakes > 1
   *  the worker writes each take to a take{k}/ subdir of this dir. */
  targetSentencesDir: string;
  /** Generate each index this many times in ONE model load (default 1). >1 writes
   *  take{k}/{i}.flac subdirs; each take is a different (unseeded) reading. */
  numTakes?: number;
  /** Per-take sampling temperatures (Orpheus). When set, its length is the take count
   *  and each take renders at its own temperature in one model load — for varied re-rolls. */
  takeTemperatures?: number[];
  /** Path to a JSON file mapping index -> replacement text (edited sentences). Those
   *  indices render the edited text; the engine splits + re-merges overlong edits into
   *  one {i} file. */
  sentenceOverridesPath?: string;
  /** Called as each sentence completes (converted count, batch total incl. takes). */
  onProgress?: (converted: number, total: number) => void;
  /** Abort to kill the worker mid-run. */
  signal?: AbortSignal;
}

export interface RegenerateIndicesResult {
  success: boolean;
  converted: number;
  failedIndices: number[];
  error?: string;
}

/**
 * Regenerate a scattered set of sentence indices into a scratch dir, reusing the
 * SAME lightweight worker (worker.py --sentence_indices) and arg/env assembly as a
 * normal book render (startWorker). Each output FLAC is therefore a true drop-in:
 * identical engine/voice/model, and the worker's own _save_audio applies the normal
 * peak-normalize + _classify_gap inter-clip gaps. The worker reads the sentence TEXT
 * (and its gap classification) from the session's own session-state.json, so nothing
 * about the audio drifts from the original render except the (intentionally) fresh,
 * unseeded sampling — a different take of the same sentence, which is the point.
 *
 * Backend primitive for the "Correct Sentences" feature: the caller runs it once per
 * take into take{k}/ dirs, then swaps the approved candidate into the live cache.
 *
 * Fidelity notes: this forwards the audio-affecting env (voice caps, ORPHEUS_SENTENCE_GAP,
 * any ORPHEUS_TEMPERATURE/TOP_P overrides). It does NOT go through the GPU arbiter (session
 * VRAM sizing) — batch-size/cache are memory/throughput knobs, not audio content, so a small
 * regen uses the memory-tier defaults. Don't run it concurrently with a full book render on
 * the same GPU.
 */
export async function regenerateSentenceIndices(
  params: RegenerateIndicesParams
): Promise<RegenerateIndicesResult> {
  const { sessionId, sessionDir, settings, indices, targetSentencesDir, onProgress, signal } = params;
  const takeTemperatures = params.takeTemperatures?.length ? params.takeTemperatures : undefined;
  const numTakes = takeTemperatures ? takeTemperatures.length : Math.max(1, params.numTakes ?? 1);

  if (!indices.length) return { success: true, converted: 0, failedIndices: [] };

  fsSync.mkdirSync(targetSentencesDir, { recursive: true });

  // A WSL worker cannot read the session from wherever WE hold it — a library on a
  // mapped network drive has no /mnt entry in the guest at all. Stage the state it
  // needs onto WSL's own filesystem and hand it that path instead.
  let sessionDirArg = sessionDir;
  let stagedSessionUnc: string | null = null;
  if (jobRunsInWsl(settings.ttsEngine)) {
    try {
      const staged = await stageSessionStateForWsl(sessionDir);
      sessionDirArg = staged.guestSessionDir;
      stagedSessionUnc = staged.stagedUnc;
    } catch (err: any) {
      return { success: false, converted: 0, failedIndices: indices, error: err?.message || String(err) };
    }
  }

  // ── The retake door routes by ENGINE, like every other door ───────────────
  //
  // This is the Studio sentence-retake / take-picker path, and it was the one
  // spawn site the Higgs work missed — visible at the time, because the argv
  // snapshot deliberately pins it as one of five doors. Left alone, a Higgs
  // retake called `pythonInvocation('higgs')`, which returns the MARKER path
  // `<e2a>/higgs_wsl_env` (a string the spawn layer resolves by name, not a
  // directory), and handed it e2a's worker.py — which has no Higgs engine
  // regardless. Every retake on a Higgs book failed with a path error.
  //
  // A retired engine is refused BY NAME here for the same reason it is at the
  // queue boundary: this door reads `settings.ttsEngine` straight out of
  // `session_state.json`, so an old XTTS book reaches it with no UI in between.
  try {
    assertRunnableTtsEngine(settings.ttsEngine);
  } catch (err: any) {
    return { success: false, converted: 0, failedIndices: indices, error: err?.message || String(err) };
  }

  // Build args mirroring startWorker's lightweight (worker.py) branch, but for a
  // discrete index list writing into a scratch sentences dir.
  let args: string[];
  try {
    const deviceArg = resolveTtsDeviceArg(settings.device, settings.ttsEngine);
    args = [
      '--session', sessionId,
      '--session_dir', sessionDirArg,
      '--sentences_dir', targetSentencesDir,
      '--device', deviceArg,
      '--tts_engine', narratorEngineId(narratorEngineFor(settings)),
    ];
    // Same voice/model resolution the original render used (may throw on an
    // uninstalled Orpheus voice — surfaced as an error below, not a silent
    // fallback). Not for Higgs: `--fine_tuned` is a prompt TOKEN and the Higgs
    // voice is a CATALOG ID, appended as `--higgs_voice` in the Higgs branch.
    if (isHiggsJob(settings)) {
      args.push(HIGGS_VOICE_FLAG, higgsPreflight(settings.fineTuned).id);
    } else {
      pushVoiceArgs(args, settings);
    }
    // `--speed` is gone: compat/FLAGS.md files it under IGNORE, "XTTS only".
    // A retake carrying it claimed a speed change nothing applied.
    args.push('--sentence_indices', indices.join(','));
    if (takeTemperatures) {
      args.push('--take_temperatures', takeTemperatures.join(','));
    } else if (numTakes > 1) {
      args.push('--num_takes', String(numTakes));
    }
    if (params.sentenceOverridesPath) {
      args.push('--sentence_overrides', params.sentenceOverridesPath);
    }
  } catch (err: any) {
    return { success: false, converted: 0, failedIndices: indices, error: err?.message || String(err) };
  }

  const voiceCaps = orpheusVoiceCaps(settings);
  // The door's environment, as a plain record: buildNarratorSpawn applies
  // buildCondaSpawnEnv on the native arm and writes an explicit export line on the
  // WSL one, so building the merged process env here would have it merged twice
  // natively and dropped entirely in the guest.
  const env: Record<string, string> = {
    // Same worker, same wrapper, same orphan risk — see startWorker.
    BOOKFORGE_OWNER_PID: String(process.pid),
    BOOKFORGE_OWNER_PLATFORM: process.platform,
    VLLM_USE_V1: '0',
    ...(narratorRunsInWsl(narratorEngineFor(settings), 'worker')
      ? { ORPHEUS_DISABLE_EAGER: '1' }
      : { VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1' }),
    // Orpheus batch width / MLX cache: memory-tier defaults (not GPU-arbiter sized —
    // see the fidelity note above). Explicit env still wins.
    ...(settings.ttsEngine === 'orpheus'
      ? {
          ORPHEUS_BATCH_SIZE: process.platform === 'darwin'
            ? (process.env.ORPHEUS_BATCH_SIZE?.trim()
                || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).batchSize))
            : (process.env.ORPHEUS_BATCH_SIZE?.trim() || defaultOrpheusBatchSize()),
        }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && process.platform === 'darwin'
      ? {
          ORPHEUS_MLX_CACHE_LIMIT_GB: process.env.ORPHEUS_MLX_CACHE_LIMIT_GB?.trim()
            || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).mlxCacheLimitGB),
          // Total unified-memory budget a batch may occupy; orpheus.py narrows
          // batch WIDTH from the batch's token depth to stay inside it.
          ORPHEUS_MLX_MEM_BUDGET_GB: process.env.ORPHEUS_MLX_MEM_BUDGET_GB?.trim()
            || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).mlxMemBudgetGB),
        }
      : {}),
    // Audio-affecting Orpheus env: the deterministic inter-clip gap and the per-voice
    // caps the original render used, so regenerated gaps/guards match.
    ...(settings.ttsEngine === 'orpheus'
      && (process.env.ORPHEUS_SENTENCE_GAP?.trim() || voiceCaps.sentenceGap !== undefined)
      ? { ORPHEUS_SENTENCE_GAP: process.env.ORPHEUS_SENTENCE_GAP?.trim() || String(voiceCaps.sentenceGap) }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_MAX_CHARS_PER_SEC?.trim() || voiceCaps.maxCharsPerSec !== undefined)
      ? { ORPHEUS_MAX_CHARS_PER_SEC: process.env.ORPHEUS_MAX_CHARS_PER_SEC?.trim() || String(voiceCaps.maxCharsPerSec) }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_REP_PENALTY?.trim() || voiceCaps.repPenalty !== undefined)
      ? { ORPHEUS_REP_PENALTY: process.env.ORPHEUS_REP_PENALTY?.trim() || String(voiceCaps.repPenalty) }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_BOOST?.trim() || voiceCaps.eosBoost !== undefined)
      ? { ORPHEUS_EOS_BOOST: process.env.ORPHEUS_EOS_BOOST?.trim() || String(voiceCaps.eosBoost) }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_BOOST_START?.trim() || voiceCaps.eosBoostStart !== undefined)
      ? { ORPHEUS_EOS_BOOST_START: process.env.ORPHEUS_EOS_BOOST_START?.trim() || String(voiceCaps.eosBoostStart) }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_FLOOR?.trim() || voiceCaps.eosFloor !== undefined)
      ? { ORPHEUS_EOS_FLOOR: process.env.ORPHEUS_EOS_FLOOR?.trim() || String(voiceCaps.eosFloor) }
      : {}),
    ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_FLOOR_RATE?.trim() || voiceCaps.eosFloorRate !== undefined)
      ? { ORPHEUS_EOS_FLOOR_RATE: process.env.ORPHEUS_EOS_FLOOR_RATE?.trim() || String(voiceCaps.eosFloorRate) }
      : {}),
    ...(settings.ttsEngine === 'orpheus'
      ? Object.fromEntries(
          (['ORPHEUS_TEMPERATURE', 'ORPHEUS_TOP_P', 'ORPHEUS_MIN_P', 'ORPHEUS_VLLM_DTYPE'] as const)
            .filter((k) => process.env[k]?.trim())
            .map((k) => [k, process.env[k]!.trim()])
        )
      : {}),
    ...(xttsDeepspeedAvailable(settings.ttsEngine) ? { XTTS_USE_DEEPSPEED: '1' } : {}),
  };

  const runWorker = () => new Promise<RegenerateIndicesResult>((resolve) => {
    let converted = 0;
    let resultJson: any = null;
    let stderrTail = '';

    // ONE RETAKE DOOR: `narrator.compat.worker` with the discrete-index flags.
    // narrator's worker route accepts --sentence_indices / --num_takes /
    // --take_temperatures / --sentence_overrides exactly as e2a's worker.py did
    // (compat/FLAGS.md lists all four under ACCEPT), so the argv above is the
    // whole difference between a retake and a range render.
    const retakePlan = buildJobSpawn({
      settings,
      phase: 'worker',
      args,
      jobId: sessionId,
      cwdHint: getDefaultE2aPath(),
      envExtras: env,
    });
    console.log('[PARALLEL-TTS] Retake → narrator:', retakePlan.describe());

    const proc = spawn(retakePlan.command, retakePlan.args, {
      cwd: retakePlan.cwd,
      env: retakePlan.env,
      shell: false,
    });

    const onAbort = () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        writeWorkerLog(`[REGEN] ${t}`);
        // Progress: count our own converted lines against the batch total (the
        // worker's printed "/N" is the BOOK total, not our subset).
        if (PROGRESS_LINE_RE.test(t)) {
          converted += 1;
          onProgress?.(converted, indices.length * numTakes);
        }
        // The worker prints its result dict as a JSON line at the end.
        if (t.startsWith('{') && t.includes('"success"')) {
          try { resultJson = JSON.parse(t); } catch { /* not the result line */ }
        }
      }
    });
    proc.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

    proc.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ success: false, converted, failedIndices: indices, error: err.message });
    });
    proc.on('exit', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (resultJson) {
        resolve({
          success: !!resultJson.success,
          converted: resultJson.sentences_converted ?? converted,
          failedIndices: resultJson.failed_indices ?? [],
          error: resultJson.error,
        });
      } else {
        resolve({
          success: code === 0,
          converted,
          failedIndices: code === 0 ? [] : indices,
          error: code === 0 ? undefined : (stderrTail || `worker exited with code ${code}`),
        });
      }
    });
  });

  try {
    return await runWorker();
  } finally {
    // The staged state is scratch: it exists only for the life of this worker. A
    // failed sweep is said out loud but never fails the regeneration — the audio
    // is already made, and losing it over a leftover 200 kB of JSON would be the
    // cleanup deciding the verdict.
    if (stagedSessionUnc) {
      try {
        await fs.rm(stagedSessionUnc, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[PARALLEL-TTS] Could not remove staged session state at ${stagedSessionUnc}:`, err);
      }
    }
  }
}

/**
 * REFUSE TO PUT A SECOND ORPHEUS RENDER ON THIS MAC'S GPU.
 *
 * One GPU, one pool of memory, and it is the same memory the desktop draws
 * from. Two MLX renders do not each get half — they each take ~7 GB of weights
 * plus a KV cache and a batch, and the machine starts swapping. Sep 1 2026:
 * an ORPHANED worker.py (Electron was Ctrl-C'd, so `before-quit` never fired
 * and `killAllWorkers` never ran) rendered on for 1h31m; the app then started a
 * worker on top of it, and a CLI run over ssh started a third. 55-60 GB wired,
 * the renderer OOM-killed, every number measured that night void.
 *
 * WHY A REFUSAL AND NOT A WARNING. The run that follows is wrong twice: it is
 * slow, and it takes the desktop with it — and its timings are the reason
 * someone started it. There is nothing to salvage by proceeding.
 *
 * WHERE IT SITS, AND WHY HERE. In `startWorker`, which is the ONE place a batch
 * worker is spawned: `startParallelConversion` (queue/UI), `resumeParallelConversion`
 * (resume), `renderRangeHeadless` (the CLI — `cli/orpheus-batch-render.js` calls
 * it, and `cli/bookforge-tts.py` calls that) and `retryWorker` (OOM respawn) all
 * come through here. A guard in any one caller is a guard the other three
 * routes walk around.
 *
 * ONCE PER SESSION (`session.gpuOwnershipChecked`): workers 1..n and an OOM
 * respawn are the SAME render as worker 0. Re-asking would refuse our own job.
 *
 * The selection rules — what counts, what is excluded, and why the CLI's own
 * parent chain must not count — are in `shared/tts/gpu-ownership.ts`, tested by
 * `npm run test:gpu-ownership`. This side is the `ps` call and the throw.
 */
function assertGpuIsOurs(session: ConversionSession): void {
  if (process.platform !== 'darwin') return;                       // one MLX GPU is a Mac problem
  if (session.config.settings.ttsEngine !== 'orpheus') return;      // XTTS on Mac runs on the CPU
  if (session.gpuOwnershipChecked) return;
  session.gpuOwnershipChecked = true;

  let psOutput: string;
  try {
    // pid,ppid,etime,command: ppid is here so the ancestor chain comes from the
    // SAME snapshot as the selection — a chain read a moment later can disagree
    // with the list it is filtering.
    psOutput = execSync('ps -Ao pid,ppid,etime,command', { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err: any) {
    // No process list, no evidence. Refusing on a broken `ps` would ground the
    // app over a diagnostic; say so and carry on.
    console.warn(`[PARALLEL-TTS] GPU ownership check skipped — could not read the process list: ${err?.message || err}`);
    return;
  }

  const found = findForeignRenders(psOutput, {
    selfPid: process.pid,
    sessionId: session.prepInfo?.sessionId ?? null,
  });
  if (found.length === 0) return;

  if (process.env[ALLOW_SHARED_GPU_ENV]?.trim()) {
    const note = gpuOwnershipOverrideNote(found);
    console.warn(`[PARALLEL-TTS] ${note}`);
    writeWorkerLog(note);
    return;
  }

  const refusal = gpuOwnershipRefusal(found);
  console.error(`[PARALLEL-TTS] ${refusal}`);
  writeWorkerLog(refusal);
  throw new Error(refusal);
}

function startWorker(
  session: ConversionSession,
  workerId: number,
  range: WorkerRange
): ChildProcess {
  const { config, prepInfo } = session;
  if (!prepInfo) throw new Error('Session not prepared');

  // Before the first worker of this session touches the GPU: is anyone else on it?
  assertGpuIsOurs(session);

  const settings = config.settings;
  const isChapterMode = config.parallelMode === 'chapters';

  // ── ONE WORKER DOOR ───────────────────────────────────────────────
  //
  // `narrator.compat.worker`, which answers the same command line e2a's
  // worker.py answered — that is what `compat/` is for.
  //
  // THE `app.py --worker_mode` BRANCH IS GONE, along with the
  // `useLightweightWorker` switch that chose between them. It was a memory
  // trade-off INSIDE e2a: worker.py imported only the TTS stack (~8 GB) while
  // app.py dragged in gradio, stanza and pytesseract (~25 GB). narrator has no
  // gradio, no stanza and no pytesseract, so there is nothing for a second door
  // to avoid importing — and the switch had been pinned on since it was added,
  // which left the app.py branch as code nobody had run in months while it went
  // on collecting flags (`--skip_deps`, `--enable_text_splitting`, `--speed`) as
  // if it did.
  //
  // Those flags go with it. compat/FLAGS.md files `--speed` and
  // `--enable_text_splitting` under IGNORE, "XTTS only", and `--skip_deps` under
  // IGNORE because narrator installs nothing. Passing a flag nothing reads is a
  // claim that a setting was honoured.
  //
  // narrator's argparser expects uppercase device names: CPU, MPS, CUDA;
  // resolveTtsDeviceArg upgrades default-CPU to CUDA when the GPU TTS pack is
  // installed (or, for Orpheus, when it runs on its own WSL CUDA env). The engine
  // is passed so Orpheus-via-WSL resolves to CUDA and the GPU arbiter sizes it.
  const deviceArg = resolveTtsDeviceArg(settings.device, settings.ttsEngine);
  const args: string[] = [
    '--session', prepInfo.sessionId,
    '--session_dir', prepInfo.sessionDir,
    // The single authoritative sentence store: the worker writes new sentences here
    // and skips ones already present (resume). For a resume this is the durable
    // Windows project cache; buildNarratorSpawn translates it to /mnt/c for a WSL
    // worker — explicitly, because it is an argument that IS a path, rather than by
    // pattern-matching the string as buildWslBashCommand used to.
    '--sentences_dir', prepInfo.chaptersDirSentences,
    '--device', deviceArg,
    '--tts_engine', narratorEngineId(narratorEngineFor(settings)),
  ];

  // Always pass the voice so the current UI selection wins over the original in
  // session-state.json (critical for resume jobs).
  //
  // The two flags are NOT interchangeable and never both: `--fine_tuned` is an
  // Orpheus prompt TOKEN, `--higgs_voice` a CATALOG ID indexing the voice document
  // NARRATOR_HIGGS_VOICES names. `pushVoiceArgs` falls through to `--fine_tuned`
  // for any engine it does not recognise, which is how a Higgs worker once carried
  // both — naming something the engine has no use for and leaving the real voice
  // unsaid.
  if (isHiggsJob(settings)) {
    args.push(HIGGS_VOICE_FLAG, higgsPreflight(settings.fineTuned).id);
  } else {
    pushVoiceArgs(args, settings);
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

  const rangeDesc = isChapterMode
    ? `chapters ${range.chapterStart}-${range.chapterEnd}`
    : `sentences ${range.sentenceStart}-${range.sentenceEnd}`;
  const workerType = 'narrator.compat.worker';
  const startMsg = `[PARALLEL-TTS] Worker ${workerId} starting [${workerType}]: ${rangeDesc}`;
  const settingsMsg = `[PARALLEL-TTS] Worker ${workerId} settings: engine=${settings.ttsEngine}, voice=${settings.fineTuned}, device=${settings.device}, speed=${settings.speed}`;
  console.log(startMsg);
  console.log(settingsMsg);
  writeWorkerLog(startMsg);
  writeWorkerLog(settingsMsg);

  // Log to file
  logger.log('INFO', session.jobId, `Worker ${workerId} starting`, {
    range: rangeDesc,
    workerType,
    engine: settings.ttsEngine,
    voice: settings.fineTuned,
    device: settings.device
  }).catch(() => {}); // Don't fail if logging fails

  // Per-voice caps for the selected fine-tune (maxCharsPerSec is the guard the worker consumes).
  const voiceCaps = orpheusVoiceCaps(settings);
  // Where the worker keeps a runaway or a truncation it threw away.
  //
  // NOT TRANSLATED HERE ANY MORE. buildNarratorSpawn puts EVERY env value through
  // the same guest-path translation it puts argv through, so a Windows reject dir
  // becomes /mnt/... on the WSL arm without this call site knowing which arm it is
  // on. Translating it here as well was harmless (the translation is idempotent)
  // but it was the pattern that let the argv guard's bug hide: two translations,
  // one correct, and a log that looked right either way.
  const rejectDir = settings.ttsEngine === 'orpheus' ? orpheusRejectDir(session.jobId) : null;
  // ── ONE SPAWN, for every engine ─────────────────────────────────────
  //
  // The Higgs branch that stood here built a SECOND command line, sliced the e2a
  // one at its `--session` anchor and substituted the engine name in place. It is
  // gone because there is no longer an e2a command line for it to differ from:
  // `args` above is narrator's, for both engines, and the only thing the Higgs
  // route still needs is its voice document — which arrives as environment,
  // through buildJobSpawn.
  //
  // `spawnWithWslSupport` is gone with it, and that is the bigger removal. It
  // rewrote argv BY PATTERN: any argument containing the string 'orpheus' became
  // `-n <orpheusEnv>`, any path under the e2a root was remapped onto the WSL e2a
  // checkout, and a fixed `forwardKeys` allowlist decided which environment
  // variables crossed. Every one of those rules was a guess about intent made
  // from a string, and the allowlist in particular was a list of variables
  // somebody remembered — the ones that matter are the ones nobody did.
  // buildNarratorSpawn translates paths because they ARE paths and forwards
  // envExtras because that is what envExtras means.
  const workerPlan = buildJobSpawn({
    settings,
    phase: 'worker',
    args,
    jobId: session.jobId,
    cwdHint: getDefaultE2aPath(),
    envExtras: {
      // PYTHONUNBUFFERED / PYTHONIOENCODING are set by buildNarratorSpawn for
      // every narrator spawn; they were repeated here when this call site built
      // its own environment.
      // WHO THIS WORKER BELONGS TO — and why ppid is not enough.
      //
      // On darwin, Orpheus resolves to a `prefix` env unconditionally
      // (e2a-paths.ts resolveCondaEnv returns early for orpheus/voxtral/f5), so
      // pythonInvocation gives us `conda run --no-capture-output -p <env> python`.
      // Measured chain from a real spawn: node -> Miniforge3/bin/python (`conda
      // run`) -> /bin/bash (activation) -> python worker.py. The worker's PARENT
      // IS THAT BASH, not us. When Electron dies, `conda run` and its bash are
      // reparented to launchd and go on waiting for the worker, so the worker's
      // ppid never changes and its parent-death watchdog never fires — which is
      // exactly how the Sep 1 2026 zombie rendered on for 1h31m.
      //
      // So we name ourselves. The worker polls this pid directly (existence +
      // start time, against pid reuse) and stops itself when we are gone,
      // wrapper or no wrapper. The platform rides along because a Windows pid
      // means nothing inside a WSL guest: the worker refuses to arm the rule
      // across that boundary rather than watch a coincidentally-equal guest pid.
      BOOKFORGE_OWNER_PID: String(process.pid),
      BOOKFORGE_OWNER_PLATFORM: process.platform,
      // VLLM_USE_V1=0 pins vLLM's V0 engine: the per-request logits processors
      // that carry the EOS boost and the EOS floor are a V0-only feature, and a
      // future vLLM bump defaulting to V1 would drop both silently — every
      // runaway guard off, and nothing in the log to say so.
      //
      // THE OTHER TWO ARE NATIVE-ONLY, and that is the whole point of the WSL
      // route. ORPHEUS_DISABLE_EAGER=1 turns CUDA graphs ON inside Linux, which
      // is ~6x; the DISABLE/NO_CUDA_GRAPH pair are the Windows-native guards
      // against vLLM trying to capture graphs where it cannot. Sending both sets
      // into the guest would have them fight. buildWslBashCommand hard-coded
      // ORPHEUS_DISABLE_EAGER into its export line and dropped the other two
      // through forwardKeys; now the arm decides, in the open.
      VLLM_USE_V1: '0',
      ...(narratorRunsInWsl(narratorEngineFor(settings), 'worker')
        ? { ORPHEUS_DISABLE_EAGER: '1' }
        : { VLLM_DISABLE_CUDA_GRAPH: '1', VLLM_NO_CUDA_GRAPH: '1' }),
      // Keep guard rejects for this job somewhere durable and identifiable. Without
      // this e2a falls back to its own tmp, where the evidence is anonymous (keyed
      // by session uuid) and shares the lifetime of a scratch directory.
      ...(rejectDir ? { ORPHEUS_REJECT_DIR: rejectDir } : {}),
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
            // Total unified-memory budget a batch may occupy; orpheus.py narrows
            // batch WIDTH from the batch's token depth to stay inside it.
            ORPHEUS_MLX_MEM_BUDGET_GB: process.env.ORPHEUS_MLX_MEM_BUDGET_GB?.trim()
              || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).mlxMemBudgetGB),
          }
        : {}),
      // Orpheus deterministic inter-clip gap. orpheus.py _classify_gap reads
      // ORPHEUS_SENTENCE_GAP; forwarded into WSL via forwardKeys.
      //
      // NOW DERIVED FROM THE VOICE'S `sentenceGap` (2026-07-27), env still wins.
      // Previously this was explicit-env-only, so every render baked e2a's 0.6 s
      // default pad regardless of the voice's tuning — and assembly then DETECTED
      // and STRIPPED it (normalize_gaps.py finds the exactly-zero pad) before
      // appending the real gap. That round trip is pointless work and it is
      // fragile: the strip only works because the pad is bit-exact zero, so it
      // MUST run before any denoise pass or the pad becomes indistinguishable
      // from the model's tail and survives into every join.
      // The original reason for a floor is also gone: _classify_gap's docstring
      // says one is needed because "each chunk's trailing silence is trimmed",
      // but that trim was REMOVED from _save_audio on 2026-07-11 as a
      // no-fallback fix. The model's own trained tail is preserved verbatim
      // (measured 0.42-1.44 s on thirdreich ep248), so a 0 floor concatenates
      // clips on the narrator's own pauses rather than a stamped uniform gap.
      // An explicit [pause:X] is still honored at 0.
      ...(settings.ttsEngine === 'orpheus'
        && (process.env.ORPHEUS_SENTENCE_GAP?.trim() || voiceCaps.sentenceGap !== undefined)
        ? { ORPHEUS_SENTENCE_GAP: process.env.ORPHEUS_SENTENCE_GAP?.trim() || String(voiceCaps.sentenceGap) }
        : {}),
      // Orpheus per-voice generation truncation-guard rate (chars/sec). orpheus.py
      // trips a truncation-retry when a chunk exceeds ORPHEUS_MAX_CHARS_PER_SEC
      // (default 19.0); a genuinely fast-reading fine-tune needs a higher threshold.
      // Forwarded into WSL via forwardKeys. Precedence: explicit user env override
      // wins, else the selected voice's declared threshold, else nothing (e2a default).
      ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_MAX_CHARS_PER_SEC?.trim() || voiceCaps.maxCharsPerSec !== undefined)
        ? { ORPHEUS_MAX_CHARS_PER_SEC: process.env.ORPHEUS_MAX_CHARS_PER_SEC?.trim() || String(voiceCaps.maxCharsPerSec) }
        : {}),
      // Orpheus per-voice repetition penalty. PROVEN 2026-07-14 (probe_runaway):
      // vLLM's whole-sequence rep penalty at the 1.1 default lets an EOS-weak
      // fine-tune lock into an infinite silence-frame loop (token-cap runaway) on
      // long chunks; 1.15 broke the loop 12/12 for the CoD deathstalker while 1.2+
      // overshoots into early-EOS truncation. Same precedence as the caps above:
      // explicit env wins, else the voice's declared value, else nothing.
      ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_REP_PENALTY?.trim() || voiceCaps.repPenalty !== undefined)
        ? { ORPHEUS_REP_PENALTY: process.env.ORPHEUS_REP_PENALTY?.trim() || String(voiceCaps.repPenalty) }
        : {}),
      ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_BOOST?.trim() || voiceCaps.eosBoost !== undefined)
        ? { ORPHEUS_EOS_BOOST: process.env.ORPHEUS_EOS_BOOST?.trim() || String(voiceCaps.eosBoost) }
        : {}),
      ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_BOOST_START?.trim() || voiceCaps.eosBoostStart !== undefined)
        ? { ORPHEUS_EOS_BOOST_START: process.env.ORPHEUS_EOS_BOOST_START?.trim() || String(voiceCaps.eosBoostStart) }
        : {}),
      // EOS minimum-length floor (the boost's mirror, for early stops): same
      // precedence — explicit env, else the voice's declared value, else nothing.
      ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_FLOOR?.trim() || voiceCaps.eosFloor !== undefined)
        ? { ORPHEUS_EOS_FLOOR: process.env.ORPHEUS_EOS_FLOOR?.trim() || String(voiceCaps.eosFloor) }
        : {}),
      ...(settings.ttsEngine === 'orpheus' && (process.env.ORPHEUS_EOS_FLOOR_RATE?.trim() || voiceCaps.eosFloorRate !== undefined)
        ? { ORPHEUS_EOS_FLOOR_RATE: process.env.ORPHEUS_EOS_FLOOR_RATE?.trim() || String(voiceCaps.eosFloorRate) }
        : {}),
      // Orpheus sampling + engine overrides (CLI --temperature/--top-p;
      // ORPHEUS_VLLM_DTYPE is env-only). orpheus.py reads these at engine init;
      // forwarded into WSL via forwardKeys. Explicit env only — orpheus.py's
      // defaults rule otherwise. (ORPHEUS_REP_PENALTY moved above: it now also
      // has a per-voice source.)
      ...(settings.ttsEngine === 'orpheus'
        ? Object.fromEntries(
            (['ORPHEUS_TEMPERATURE', 'ORPHEUS_TOP_P', 'ORPHEUS_MIN_P', 'ORPHEUS_VLLM_DTYPE'] as const)
              .filter((k) => process.env[k]?.trim())
              .map((k) => [k, process.env[k]!.trim()])
          )
        : {}),
      // Auto-enable DeepSpeed for XTTS only when it's actually installed in the env.
      ...(xttsDeepspeedAvailable(settings.ttsEngine) ? { XTTS_USE_DEEPSPEED: '1' } : {}),
        },
  });

  {
    const msg = `[PARALLEL-TTS] Worker ${workerId} → ${workerPlan.describe()}`;
    console.log(msg);
    writeWorkerLog(msg);
  }

  const workerProcess = spawn(workerPlan.command, workerPlan.args, {
    cwd: workerPlan.cwd,
    env: workerPlan.env,
    shell: false,
  });

  // Update worker state with PID and timestamps
  const worker = session.workers[workerId];
  worker.process = workerProcess;
  worker.pid = workerProcess.pid;
  worker.status = 'running';
  worker.startedAt = Date.now();
  worker.hasShownProgress = false;

  // Emit progress immediately so UI shows worker is running (important after retry)
  emitProgress(session);

  logger.log('INFO', session.jobId, `Worker ${workerId} spawned`, { pid: workerProcess.pid, usingWsl: workerPlan.viaWsl }).catch(() => {});

  // Parse worker progress from stdout
  workerProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const logLine = `[WORKER ${workerId}] ${line.trim()}`;
      // vLLM warns on every KV-cache preemption. That is a performance note about
      // scheduling, not a defect in any sentence — the console is watched for
      // runaways and truncations, and this line lands between them looking like
      // one. It still goes to the worker log file, where the preemption count is
      // real diagnostic data; it just doesn't interrupt a person reading along.
      if (!isKvPreemptionNote(line)) console.log(logLine);
      writeWorkerLog(logLine);

      // Guard fires are why this job log gets read after the fact. The audio and
      // the full record live in ORPHEUS_REJECT_DIR; this is the index into them,
      // and unlike worker-output.log it is not truncated on the next run.
      const guardEvent = parseOrpheusGuardEvent(line);
      if (guardEvent) {
        logger.log('WARN', session.jobId,
          `Orpheus guard: ${String(guardEvent.reason ?? 'unknown')} on sentence ${String(guardEvent.sentence_index ?? '?')}`,
          guardEvent).catch(() => {});
      }

      // Parse progress - support both output formats:
      // THE PROGRESS LINE, and there is only one shape of it now.
      //
      // e2a had two: an older `Converting sentence 49 - 0.53%: 49/9248` and
      // `Converting sentence 996/3954 (0.1%)`. The first was tried FIRST, and its
      // capture groups are in a different ORDER (index, pct, done, total vs index,
      // total, pct) — so a line matching the wrong one is not a miss, it is four
      // fields read off the wrong positions and a progress bar that lies.
      //
      // narrator emits only the second, and its own test asserts it never emits
      // anything matching the first (render/PORT_NOTES.md section 6). Keeping the
      // dead alternative would leave that trap armed for a future log line.
      // Each line = 1 actual conversion (skipped sentences don't print progress)
      const progressMatch = line.match(PROGRESS_LINE_RE);
      if (progressMatch) {
        const currentSentence = parseInt(progressMatch[1]);
        worker.currentSentence = currentSentence;
        // Fold into the shared index set. On Mac/MLX the rendered-file poller has
        // usually banked this chunk already (worker_core prints a whole batch's lines
        // only after the batch returns), in which case this is a no-op — see
        // noteRendered. Everywhere else this line IS the first report.
        const isNew = noteRendered(session, worker, currentSentence);
        if (!worker.hasShownProgress) {
          worker.hasShownProgress = true;
          logger.log('INFO', session.jobId, `Worker ${workerId} started converting`, {
            startupTime: Math.round((Date.now() - (worker.startedAt || Date.now())) / 1000)
          }).catch(() => {});
        }
        // Real sentence progress arrived — clear any first-run download note, and any
        // stale "rendering…"/"repairing…" detail from the batch that just landed.
        if (session.downloadNote) session.downloadNote = undefined;
        session.stageDetail = undefined;
        // The batch that was decoding has LANDED (these lines are the engine reporting
        // its rows). Absent means absent — drop it rather than leaving a full bar
        // pinned under the chunk bar until the next batch starts.
        worker.activeBatch = undefined;
        // A no-op line still refreshes the watchdog (lastProgressAt is set above only
        // for new indices), but re-emitting 96 identical progress events in one tick
        // is pure churn — the poller already moved the bar.
        worker.lastProgressAt = Date.now();
        if (isNew) emitProgress(session);
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

      // ── Stage / liveness markers ──────────────────────────────────────────
      // The worker narrates its own lifecycle; reading it is what turns the long
      // silent gap before the first sentence into two honest bars instead of one
      // bar stuck at 0%.
      if (!worker.modelLoadedAt && MODEL_LOAD_START_RE.test(line)) {
        worker.modelLoadStartedAt = worker.modelLoadStartedAt ?? Date.now();
        session.stageDetail = 'Loading model weights…';
        emitProgress(session);
      } else if (!worker.modelLoadedAt && MODEL_LOAD_DONE_RE.test(line)) {
        worker.modelLoadedAt = Date.now();
        const secs = worker.modelLoadStartedAt
          ? Math.round((worker.modelLoadedAt - worker.modelLoadStartedAt) / 1000)
          : undefined;
        session.stageDetail = undefined;
        console.log(`[PARALLEL-TTS] Worker ${workerId} model loaded${secs !== undefined ? ` in ${secs}s` : ''}`);
        emitProgress(session);
      }

      // A cap-hit / too-short chunk goes through the serial re-split ladder, which on
      // MLX can run for minutes with no completions (the vLLM ladder pools its parts
      // into one call; _generate_mlx_safe does not). Say so, or it reads as a stall.
      const repairMatch = line.match(REPAIR_START_RE);
      if (repairMatch) {
        session.stageDetail = `Repairing over-long chunk ${repairMatch[1]}…`;
        emitProgress(session);
      }

      // The only signal that exists INSIDE an MLX batch. A batch is atomic — all its
      // rows land together — so this is the sole proof of life for 5-7 minutes, and
      // now the sole source of movement for the UI's within-batch bar.
      const beat = parseMlxHeartbeat(line);
      if (beat) {
        worker.activeBatch = advanceBatch(worker.activeBatch, beat);
        session.stageDetail = `Rendering ${beat.rowsTotal} chunks together · ${beat.maxTokens.toLocaleString()} tokens`;
        // Unlike the old code this EMITS: the heartbeat is throttled to ~10 s by the
        // engine, so one progress event per beat is cheap, and without it the batch
        // bar would only reach the renderer when some unrelated event happened to
        // emit — i.e. never, for the whole batch.
        emitProgress(session);
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
      // Same KV-preemption note as on stdout — vLLM's logger can land on either
      // stream depending on how the env wires it up.
      if (!isKvPreemptionNote(line)) console.log(logLine);
      writeWorkerLog(logLine);

      // Parse progress from stderr too (both formats)
      const progressMatch = line.match(PROGRESS_LINE_RE);
      if (progressMatch) {
        const currentSentence = parseInt(progressMatch[1]);
        worker.currentSentence = currentSentence;
        // Same shared index set as the stdout path — see noteRendered.
        const isNew = noteRendered(session, worker, currentSentence);
        worker.lastProgressAt = Date.now();
        if (!worker.hasShownProgress) {
          worker.hasShownProgress = true;
          logger.log('INFO', session.jobId, `Worker ${workerId} started converting`, {
            startupTime: Math.round((Date.now() - (worker.startedAt || Date.now())) / 1000)
          }).catch(() => {});
        }
        // Real sentence progress arrived — clear any first-run download note.
        if (session.downloadNote) session.downloadNote = undefined;
        session.stageDetail = undefined;
        // The decoding batch has landed — see the stdout path.
        worker.activeBatch = undefined;
        if (isNew) emitProgress(session);
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
    // Whatever batch this worker was decoding is over (landed, or died with it).
    worker.activeBatch = undefined;

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
    stopRenderedPoller(session);

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
    const completionTtsLog = getTTSLogger();
    if (session.config.bfpPath && session.prepInfo?.sessionDir) {
      const language = session.config.settings.language || 'en';
      try {
        const cacheResult = await cacheSessionToProject(
          session.prepInfo.sessionDir, session.config.bfpPath, language
        );
        if (cacheResult.success) {
          cachedSentencesDir = cacheResult.cachedSentencesDir;
          console.log(`[PARALLEL-TTS] Session cached: ${cacheResult.cachedSentencesDir}`);
          completionTtsLog.info('Session cached to project on completion', {
            jobId: session.jobId, bfpPath: session.config.bfpPath, language,
            sessionDir: session.prepInfo.sessionDir, cachedPath: cacheResult.cachedSentencesDir,
          });
        } else {
          console.error(`[PARALLEL-TTS] Session cache failed: ${cacheResult.error}`);
          completionTtsLog.error('Session cache FAILED on completion — no resume checkpoint written', {
            jobId: session.jobId, bfpPath: session.config.bfpPath, language,
            sessionDir: session.prepInfo.sessionDir, error: cacheResult.error,
          });
        }
      } catch (err) {
        console.error('[PARALLEL-TTS] Session cache error:', err);
        completionTtsLog.error('Session cache errored on completion', {
          jobId: session.jobId, bfpPath: session.config.bfpPath, error: (err as Error).message,
        });
      }
    } else {
      // No bfpPath means nothing durable is written — the render lives only in scratch,
      // which the next startup sweeps. Make that visible instead of silent.
      completionTtsLog.warn('No project cache written after completion', {
        jobId: session.jobId,
        reason: session.config.bfpPath ? 'no session dir' : 'job config has no bfpPath',
        sessionDir: session.prepInfo?.sessionDir || null,
      });
    }

    // Finish closing chapters BEFORE the session moves. The closer has been reading
    // the sentences at their render-time location, and its last sweep picks up the
    // chapters that only completed in the final minutes; running it here means the
    // work happens once, on the paths it was already watching.
    const closerManifest = await stopChapterCloser(session.jobId);
    if (closerManifest) {
      await logger.log('INFO', session.jobId, 'Chapter closer finished', {
        complete: closerManifest.complete,
        closed: closerManifest.closedChapters.length,
        totalChapters: closerManifest.totalChapters,
      });
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

    // Final-audio denoise (optional): block-based roformer pass over the rendered
    // sentences (see denoise-bridge). Runs FIRST — before any RVC pass — because
    // RVC extracts f0/content features from its input and input noise corrupts
    // that extraction; the roformer is proven zero-change on clean audio, so the
    // compose is always safe. The original sentences stay cached and untouched.
    if (session.config.finalDenoise) {
      const sentencesDir = session.prepInfo?.chaptersDirSentences;
      if (!sentencesDir) {
        emitComplete(session, false, undefined, 'Final denoise: sentences directory unknown.');
        activeSessions.delete(session.jobId);
        return;
      }
      const dnReady = finalDenoiseReady();
      if (!dnReady.ok) {
        emitComplete(session, false, undefined, `Final denoise unavailable: ${dnReady.reason}`);
        activeSessions.delete(session.jobId);
        return;
      }
      const dnOutDir = path.join(path.dirname(sentencesDir), 'sentences_denoised');
      try {
        await logger.log('INFO', session.jobId, 'Final denoise starting (block-based roformer)');
        await denoiseSentences({
          sentencesDir,
          outputDir: dnOutDir,
          onLog: (message) => { void logger.log('INFO', session.jobId, message); },
          onProgress: (done, total) => {
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
              message: `Denoising audio… (block ${done}/${total})`,
            };
            rendererSend('parallel-tts:progress', { jobId: session.jobId, progress });
          },
        });
        session.denoisedSentencesDir = dnOutDir;
        await logger.log('INFO', session.jobId, `Final denoise complete: ${dnOutDir}`);
      } catch (err) {
        emitComplete(session, false, undefined, `Final denoise failed: ${err}`);
        activeSessions.delete(session.jobId);
        return;
      }
    }

    // RVC voice enhancement (optional): re-render every sentence through an RVC
    // model with a single warm model load, then assemble the ENHANCED set via
    // --sentences_dir. The original XTTS sentences stay cached and untouched.
    // Reads the DENOISED set when the denoise pass above ran (denoise → RVC).
    if (session.config.rvcEnhancement?.enabled) {
      const rvc = session.config.rvcEnhancement;
      const voice = getRvcVoiceById(rvc.voiceId);
      const sentencesDir = session.denoisedSentencesDir ?? session.prepInfo?.chaptersDirSentences;
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
      const rvcIndexRate = resolveRvcIndexRate(voice, rvc.indexRate);
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
          // Absent stays absent — that is what leaves urvc on its own default.
          f0Method: rvc.f0Method,
          hopLength: rvc.hopLength,
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
      //
      // Same reasoning for GENERATION activity: with batched inference the FIRST
      // "Converting sentence" line only lands when the whole batch (64) completes, so
      // a worker whose opening batch contains several ~35s token-cap re-renders is
      // hard at work with hasShownProgress still false. GENERATION_ACTIVITY_RE already
      // refreshes lastProgressAt for those lines, but this branch ignored it and killed
      // on raw wall-clock — TERMing a healthy worker at exactly 10 min (Ghostworld,
      // 2026-07-19: 11 cap re-renders in the first 51 sentences, 0 chunks emitted,
      // killed at 630s, and the retries then raced the dying vLLM for the GPU).
      const effectiveStart = Math.max(
        worker.startedAt,
        worker.lastDownloadActivityAt ?? 0,
        worker.lastProgressAt ?? 0,
      );
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
      if (jobRunsInWsl(ttsEngine)) {
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
  if (isWslWedged() && jobRunsInWsl(config.settings.ttsEngine)) {
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

  // Reset worker state for retry.
  //
  // completedSentences / rawCompletedSentences are deliberately NOT zeroed any more.
  // They used to be, because the restarted worker re-printed "Converting sentence"
  // lines and a raw counter would have double-counted them. Completions are now a
  // SET of chunk indices (noteRendered), so a re-print of an already-banked chunk is
  // inherently a no-op — and zeroing would instead throw away real, on-disk work,
  // dropping the bar backwards before it climbed back to where it already was.
  worker.retryCount++;
  worker.status = 'pending';
  worker.error = undefined;
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
    //
    // The floor must be the one THIS job's preflight enforced. An adapter spawn needs
    // the LoRA + punica workspace on top of vLLM's (higher) reservation floor, so
    // waiting on the merged number would respawn ~1.8 GiB short of what acquireGpuForJob
    // demanded — i.e. straight back into the OOM cascade this wait exists to break.
    // A job with no recorded artifact never went through the Orpheus GPU preflight
    // (XTTS, or Orpheus pinned to CPU) and keeps the floor it has always waited on.
    const retryFloorMB = engine === 'orpheus' && session.orpheusServeArtifact
      ? orpheusMinFreeVramMB(session.orpheusServeArtifact)
      : ORPHEUS_MIN_VRAM_MB;
    void waitForFreeVram(retryFloorMB, {
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
 * @returns The final output path (project audiobook path if using temp, otherwise processedPath)
 */
async function finalizeOutputPath(processedPath: string, session: ConversionSession): Promise<string> {
  const config = session.config;

  // If outputting to the project audiobook folder, run post-processing (rename VTT, copy to external)
  if (config.bfpPath) {
    console.log('[PARALLEL-TTS] Post-processing output in the project audiobook folder...');
    try {
      const result = await postProcessOutput(
        config.outputDir,
        processedPath,
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
      await fs.rm(winSessionDir, { recursive: true, force: true }).catch(() => {});
      console.log(`[PARALLEL-TTS] Normalizing Orpheus session WSL→Windows: ${prep.sessionDir} -> ${winSessionDir}`);
      // Routed copy-out — with the library (and so the e2a tmp cache) on a
      // network drive, the guest has no /mnt for it and Windows drives the copy.
      await copyDirOutOfWsl(prep.sessionDir, winSessionDir);
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

  // e2a writes the assembled audiobook under a name it derives from the BOOK, and
  // it writes it wherever --output_dir points. Pointed straight at the project's
  // output folder, a second run under the same derived name replaced the first,
  // and the post-processing below then picked "the first .m4b in the folder" as
  // this run's result — which, with more than one audiobook there, was anyone's.
  // So e2a assembles into a per-run staging folder INSIDE output/ (same
  // filesystem, so the promotion is a rename), and the finished files are moved
  // beside the folder's existing audiobooks under names that are free — see
  // promoteFromAssemblyDir and electron/output-naming.ts. Nothing already in
  // output/ is deleted or replaced (Owen, 2026-09-03).
  const asmOutputDir = path.join(config.outputDir, `.staging-${session.jobId}`);
  await fs.mkdir(asmOutputDir, { recursive: true });

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

  // ── ASSEMBLY IS NATIVE, ON EVERY PLATFORM, FOR EVERY ENGINE ───────────────
  //
  // It concatenates sentence audio and encodes one m4b. It loads no model, it
  // touches no GPU, and narrator does not gate it on an engine: `compat/app.py`
  // routes `--assemble_only` BEFORE any engine resolution and `check_engine`
  // never runs on it. So it belongs in the tools env — the bundled relocatable
  // python that already holds numpy/soundfile/mutagen and ffmpeg on PATH — and
  // nowhere else.
  //
  // WHAT WAS HERE. Four variables (`assembleOrpheusNative`, `asmInvocation`,
  // `asmEngineArg`, `asmRoutingEngine`) computed which of THREE routes to take:
  // native-with-the-generic-env-and-a-lie (`--tts_engine xtts`, because
  // `pythonInvocation('orpheus')` returns the marker path `<e2a>/orpheus_wsl_env`
  // that only resolves after buildWslBashCommand rewrites it inside WSL), native
  // with the engine's own env, or back through WSL when normalization had failed.
  // All three are gone. The one that mattered is preserved as the DEFAULT rather
  // than as a special case.
  //
  // AND `normalizeWslSessionToWindows` STAYS — it is what makes this possible.
  // Orpheus prep and render still run in WSL, so the session is written to ext4;
  // that function copies it onto a Windows path after generation and repoints
  // prepInfo. Without it a native assembly would be reading the \\wsl$ 9p mount,
  // which is slow enough to dominate the job, or nothing at all when WSL is down.
  const settings = config.settings;

  // The device flag is scaffolding on this door — narrator's assembly reads no
  // device — but it is passed as CPU rather than omitted, because that is what it
  // truthfully does and a session dump that says CUDA on an assembly is a lie a
  // reader has to disprove.
  const asmDeviceArg = 'CPU';

  // De-ring is OPT-IN and lives on the reassembly path (see reassembly-bridge:
  // config.applyDeRing). This inline TTS→assemble path never auto-applies a per-voice
  // post-render filter — silently applying it here is exactly what dulled sibilants on
  // books that had no ringing. Left undefined so the raw sentences encode unchanged;
  // if de-ring is ever wanted on an inline-assembled job it must be threaded as an
  // explicit flag, never resolved by default.
  const postRenderFilter: string | undefined = undefined;

  const args = [
    '--headless',
    // Only include --ebook if we have a path (assembly_only doesn't require it)
    ...(config.epubPath ? ['--ebook', config.epubPath] : []),
    '--output_dir', asmOutputDir,
    '--session', prepInfo.sessionId,
    // Pass --session_dir when session may not be in default e2a tmp location
    // (e.g., cached sessions in the project audiobook folder)
    ...(prepInfo.sessionDir ? ['--session_dir', prepInfo.sessionDir] : []),
    // When an enhancement pass ran, assemble the ENHANCED sentence set (chapter
    // mapping / metadata / VTT still come from the session state). RVC output
    // wins when both passes ran — it was rendered FROM the denoised set.
    ...(session.rvcSentencesDir
      ? ['--sentences_dir', session.rvcSentencesDir]
      : session.denoisedSentencesDir
        ? ['--sentences_dir', session.denoisedSentencesDir]
        : []),
    '--device', asmDeviceArg,
    '--language', settings.language,
    // THE JOB'S OWN ENGINE, in narrator's spelling. Not the literal 'xtts' this
    // door used to send when it ran natively, and not omitted as the Higgs door
    // used to. narrator does not gate assembly on the engine, so any of the three
    // works today — but only this one is still right if it ever does, and only
    // this one never names an ENGINE_NEAR_MISS ('higgs' is one; 'higgs-v3' is the
    // id). A session's own record of what rendered it should agree with the flag.
    '--tts_engine', narratorEngineId(narratorEngineFor(settings)),
    '--assemble_only',  // Skip TTS, just combine existing sentence audio files
    '--no_split',       // Don't split into multiple parts - create single file
    // Per-voice post-render filter (Orpheus voices only) — applied at e2a's final encode.
    ...(postRenderFilter ? ['--post_render_filter', postRenderFilter] : []),
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

    // ONE ASSEMBLY SPAWN. `buildNarratorSpawn` with NO engine is the tools env on
    // every platform — see its PHASE_ENGINE table, where `assembly` is the single
    // 'optional' entry and passing no engine is what selects the engine-agnostic
    // route. The Higgs branch that stood here is gone with the Orpheus one: a
    // Higgs session is a narrator session and its assembly is the same door.
    //
    // narrator's assembler reads the manifest's engine profile for the things
    // that ARE engine-specific — `engine_profiles.py` (higgs-v3: pads=false,
    // 10/25 ms raised-cosine fades), `edges.py`, and `_plan_unpadded` realizing
    // gapBefore/gapAfter as generated silence through one FLAC writer. Prep writes
    // the `gaps.json` those read and `session_v1` refuses a pads=false session
    // without it. So the door is engine-agnostic and the AUDIO is not, which is
    // the correct division: the profile travels in the session, not in the argv.
    const asmPlan = buildNarratorSpawn({
      phase: 'assembly',
      args,
      envExtras: {
        // No ORPHEUS_* and no CUDA pins: nothing here loads vLLM or MLX.
        VLLM_USE_V1: '0',
      },
      cwdHint: getDefaultE2aPath(),
    });
    console.log('[PARALLEL-TTS] Assembly → narrator:', asmPlan.describe());

    session.assemblyProcess = spawn(asmPlan.command, asmPlan.args, {
      cwd: asmPlan.cwd,
      env: asmPlan.env,
      shell: false,
    });

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
        assemblyTotalChapters: totalChapters,
        // Conversion is finished by definition once assembly is running, so its bar
        // reads 100 rather than whatever the last live sample happened to be.
        stages: buildTtsStages(session, { convertPct: 100, assemblyPct: overallPercent }),
        stageDetail: getAssemblyMessage(subPhase, subProgress, currentChapter, totalChapters)
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
        if (jobRunsInWsl(settings.ttsEngine) && detectedPath.startsWith('/mnt/')) {
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
            const files = await fs.readdir(asmOutputDir);
            // Filter for .m4b files, excluding macOS resource forks (._* files)
            const m4bFiles = files.filter(f => f.endsWith('.m4b') && !f.startsWith('._'));
            let mostRecent: { file: string; mtime: number } | null = null;
            for (const file of m4bFiles) {
              const filePath = path.join(asmOutputDir, file);
              const stat = await fs.stat(filePath);
              if (stat.mtimeMs < assemblyStartMs - FRESHNESS_SLACK_MS) continue; // stale — predates this run
              if (!mostRecent || stat.mtimeMs > mostRecent.mtime) {
                mostRecent = { file, mtime: stat.mtimeMs };
              }
            }
            if (mostRecent) {
              outputPath = path.join(asmOutputDir, mostRecent.file);
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
            `Assembly exited successfully but no audiobook created during this run was found in ${asmOutputDir} ` +
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

        // Whatever metadata/rename does, the audiobook leaves the staging folder
        // here, beside the folder's existing audiobooks, under a free name.
        const settle = async (p: string): Promise<string> =>
          finalizeOutputPath(await promoteFromAssemblyDir(p, asmOutputDir, config.outputDir), session);

        if (config.metadata && finalPath && config.outputDir) {
          try {
            console.log('[PARALLEL-TTS] Calling applyM4bMetadata...');
            const processedPath = await applyM4bMetadata(finalPath, config.metadata, config.outputDir, config.bfpPath);
            console.log('[PARALLEL-TTS] After metadata, path:', processedPath);
            resolve(await settle(processedPath));
          } catch (metaErr) {
            console.error('[PARALLEL-TTS] Metadata processing failed, using original file:', metaErr);
            resolve(await settle(finalPath));
          }
        } else {
          if (!config.outputDir) {
            console.error('[PARALLEL-TTS] Cannot apply metadata/rename - outputDir is empty');
          }
          console.log('[PARALLEL-TTS] Skipping metadata - config.metadata is:', config.metadata);
          resolve(await settle(finalPath));
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
  // One naming rule for every door that files an output — see output-naming.ts.
  return uniqueOutputPath(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage bars
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ordered stage bars for a TTS run.
 *
 * A TTS job is four phases with wildly different shapes, and until now the renderer
 * derived them from `phase` alone — which meant "Preparing" flipped to 100% the
 * instant a worker spawned, and everything genuinely slow (extracting the book,
 * loading 6.9 GB of weights, then rendering) collapsed into one bar that read 0%
 * for its first fifteen minutes.
 *
 * Built fresh from session state on every emit rather than mutated through a
 * StageTracker: each input is already monotonic (prep finishes once, each worker
 * loads once, the rendered set only grows), so there is no accumulated state worth
 * keeping — and a rebuilt list can't drift out of sync with the session it describes.
 */
/**
 * Each TTS stage's NORMALIZED share of the run (sums to 1). The renderer uses these
 * to price stages it has not reached yet — without them the only assumption available
 * is that every remaining stage costs what the current one does, which badly
 * misestimates a run whose setup is fixed but whose conversion scales with the book.
 *
 * Converting dominates for that reason: on the 750-word probe setup took 82 s against
 * 42 s of generation, but setup is a constant while conversion grows with the text.
 *
 * Defined ONCE and shared by both builders (the initial stage list and buildTtsStages)
 * so the two can never drift apart.
 */
function ttsStageWeights(skipAssembly: boolean): Record<string, number> {
  return skipAssembly
    ? { preparing: 0.05, loading: 0.10, converting: 0.85 }
    : { preparing: 0.04, loading: 0.08, converting: 0.73, assembling: 0.15 };
}

function buildTtsStages(
  session: ConversionSession,
  opts: { convertPct: number; assemblyPct?: number; done?: boolean }
): JobStageProgress[] {
  const weights = ttsStageWeights(session.config.skipAssembly === true);
  const stage = (
    name: string,
    label: string,
    pct: number,
    status: JobStageProgress['status']
  ): JobStageProgress => ({ name, label, pct, status, weight: weights[name] ?? 0.01 });

  if (opts.done) {
    const all: JobStageProgress[] = [
      stage('preparing', 'Preparing book', 100, 'complete'),
      stage('loading', 'Loading voice model', 100, 'complete'),
      stage('converting', 'Converting sentences', 100, 'complete'),
    ];
    if (!session.config.skipAssembly) all.push(stage('assembling', 'Assembling audiobook', 100, 'complete'));
    return all;
  }

  const prepDone = session.prepDoneAt !== undefined;
  const workers = session.workers;
  // A worker that is already converting has obviously finished loading, even if its
  // "TTS Loaded!" line was swallowed by a buffer boundary — completions are the
  // stronger evidence, so they override the marker.
  const loaded = workers.filter(w =>
    w.modelLoadedAt !== undefined || (w.renderedIndices?.size ?? 0) > 0
  ).length;
  const spawned = workers.filter(w => w.startedAt !== undefined).length;
  const loadPct = spawned === 0 ? 0 : Math.round((loaded / spawned) * 100);
  const converting = opts.convertPct > 0 || loaded > 0;
  const assembling = opts.assemblyPct !== undefined;

  const stages: JobStageProgress[] = [
    stage('preparing', 'Preparing book',
      prepDone ? 100 : 0,
      prepDone ? 'complete' : 'running'),
    stage('loading', 'Loading voice model',
      // Once conversion is under way the load is done by definition, whatever the
      // per-worker markers said (a retried worker reloading mid-run must not drag
      // this bar back down — stage bars only ever move forward).
      converting ? 100 : loadPct,
      converting ? 'complete' : (prepDone && spawned > 0 ? 'running' : 'pending')),
    stage('converting', 'Converting sentences',
      opts.convertPct,
      assembling || opts.convertPct >= 100 ? 'complete' : (converting ? 'running' : 'pending')),
  ];

  // Dual-voice bilingual workflows hand assembly to a separate bilingual-assembly
  // job, so showing a bar that can only ever read 0% would be a lie.
  if (!session.config.skipAssembly) {
    const pct = opts.assemblyPct ?? 0;
    stages.push(stage('assembling', 'Assembling audiobook', pct,
      assembling ? (pct >= 100 ? 'complete' : 'running') : 'pending'));
  }

  return stages;
}

/**
 * Stage bars for the window BEFORE a ConversionSession exists.
 *
 * Prep (extract the epub, split and pack it into chunks) runs for up to a minute
 * with no session to hang state off, so it used to emit nothing at all and the job
 * sat at a blank 0%. This is the same four-bar shape with only the first one live.
 */
function emitPrepStageProgress(
  jobId: string,
  message: string,
  skipAssembly: boolean,
  // Counted work inside prep, when there is any. Passed through rather than
  // derived: the only thing that knows how many paragraphs a normalization pass
  // has left is the pass.
  prep?: PrepSubProgress,
): void {
  if (!mainWindow) return;
  // Weights are each stage's NORMALIZED share of the run (they sum to 1), so the
  // renderer can price stages it hasn't reached yet instead of assuming every
  // remaining stage costs what the current one does. Converting dominates: on the
  // 750-word probe, setup was 82 s against 42 s of generation, but that setup is a
  // fixed cost while conversion scales with the book — on a full render it is the
  // overwhelming majority.
  const stageWeights = ttsStageWeights(skipAssembly);
  const stages: JobStageProgress[] = [
    { name: 'preparing', label: 'Preparing book', pct: 0, status: 'running', weight: stageWeights.preparing },
    { name: 'loading', label: 'Loading voice model', pct: 0, status: 'pending', weight: stageWeights.loading },
    { name: 'converting', label: 'Converting sentences', pct: 0, status: 'pending', weight: stageWeights.converting },
  ];
  if (!skipAssembly) {
    stages.push({
      name: 'assembling', label: 'Assembling audiobook', pct: 0, status: 'pending',
      weight: stageWeights.assembling,
    });
  }
  const progress: AggregatedProgress = {
    phase: 'preparing',
    totalSentences: 0,
    completedSentences: 0,
    completedInSession: 0,
    percentage: 0,
    activeWorkers: 0,
    workers: [],
    estimatedRemaining: 0,
    message,
    stages,
    stageDetail: message,
    ...(prep === undefined ? {} : { prep }),
  };
  rendererSend('parallel-tts:progress', { jobId, progress });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendered-file progress poller (Mac / MLX)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Should this session read progress off the filesystem instead of waiting for stdout?
 *
 * ONLY on Mac/Orpheus, where MLX batching creates the gap this exists to close:
 * worker_core's `_flush_batch` buffers a whole batch (96 chunks) and prints all of
 * their progress lines only once `convert_sentences_batch` returns, but the engine
 * writes each flac as its length-bucket (7-23 chunks) completes — so the disk is
 * ~5x finer-grained than stdout AND updates DURING a batch instead of only at its end.
 *
 * vLLM on Windows/WSL clears a batch fast enough that its stdout cadence is fine, and
 * that path is working; gating here keeps this off it entirely rather than changing a
 * progress source that has no problem.
 */
function shouldPollRenderedFiles(session: ConversionSession): boolean {
  return process.platform === 'darwin' && session.config.settings.ttsEngine === 'orpheus';
}

/** Read the chunk indices currently on disk in the session's sentences dir. */
async function readRenderedIndices(sentencesDir: string): Promise<Set<number> | null> {
  try {
    const files = await fs.readdir(toReadablePath(sentencesDir));
    const out = new Set<number>();
    for (const f of files) {
      const m = f.match(/^(\d+)\.(?:flac|wav)$/);
      if (m) out.add(parseInt(m[1], 10));
    }
    return out;
  } catch (err) {
    // ENOENT just means the worker hasn't written anything yet. Anything else is a
    // real read failure — report null so the caller leaves the tally alone rather
    // than silently claiming zero progress over audio that exists.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set<number>();
    return null;
  }
}

/**
 * Poll the sentences dir and fold anything new into the workers' tallies.
 *
 * Progress still flows through the same noteRendered set the stdout parser uses, so
 * when worker_core finally prints its 96-line burst those indices are already known
 * and the burst is a no-op. Nothing double-counts and nothing is lost if the poller
 * misses a tick.
 */
function startRenderedPoller(session: ConversionSession): void {
  if (session.renderedPollTimer || !shouldPollRenderedFiles(session)) return;
  const sentencesDir = session.prepInfo?.chaptersDirSentences;
  if (!sentencesDir) return;

  console.log(`[PARALLEL-TTS] Rendered-file progress poller started for ${session.jobId} (MLX batches land on disk before stdout reports them)`);

  let priming = true;
  session.renderedPollTimer = setInterval(async () => {
    if (session.cancelled) return;
    const onDisk = await readRenderedIndices(sentencesDir);
    if (!onDisk) return;

    // First tick establishes the baseline: files already present belong to a previous
    // run (resume), not to this session's throughput. The stdout counter has the same
    // semantics — a skipped chunk never prints a progress line.
    if (priming) {
      priming = false;
      session.preexistingRendered = onDisk;
      return;
    }

    const baseline = session.preexistingRendered;
    let added = 0;
    for (const idx of onDisk) {
      if (baseline?.has(idx)) continue;
      const worker = workerForChunk(session, idx);
      if (!worker) continue;
      if (noteRendered(session, worker, idx)) {
        added++;
        if (idx > (worker.currentSentence ?? -1)) worker.currentSentence = idx;
      }
    }
    if (added > 0) emitProgress(session);
  }, RENDERED_POLL_INTERVAL_MS);
}

function stopRenderedPoller(session: ConversionSession): void {
  if (session.renderedPollTimer) {
    clearInterval(session.renderedPollTimer);
    session.renderedPollTimer = undefined;
  }
}

/**
 * Which worker owns a chunk index. Resume jobs carry explicit scattered assignments;
 * everything else splits the book into contiguous ranges. Returns undefined for an
 * index no worker claims, which must not be counted against anyone.
 */
function workerForChunk(session: ConversionSession, chunkIndex: number): WorkerState | undefined {
  const assigned = session.workers.find(w => w.assignedIndices?.includes(chunkIndex));
  if (assigned) return assigned;
  if (session.workers.some(w => w.assignedIndices?.length)) return undefined;
  return session.workers.find(w => chunkIndex >= w.sentenceStart && chunkIndex <= w.sentenceEnd);
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

// ─────────────────────────────────────────────────────────────────────────────
// Audio probe — how much audio the rendered chunks actually contain
// ─────────────────────────────────────────────────────────────────────────────

/** How often to sample newly-rendered chunks. Rare on purpose: see probeAudioSeconds. */
const AUDIO_PROBE_INTERVAL_MS = 30_000;
/** Files read per sample. 32 headers measured at ~290 ms over the WSL 9p mount. */
const AUDIO_PROBE_BATCH = 24;
/** Below this, seconds-per-char is still noise — a few chunks is one author's paragraph. */
const AUDIO_PROBE_MIN_CHARS = 4_000;

interface AudioProbeState {
  /** Chunk indices already measured. A file is read once, ever. */
  measured: Set<number>;
  audioSeconds: number;
  chars: number;
  lastProbeAt: number;
  inFlight: boolean;
  /** Undefined until enough has been sampled to mean anything. Never 0 — absent instead. */
  secondsPerChar?: number;
}

/**
 * Keep `session.audioProbe.secondsPerChar` current by measuring a few newly-rendered
 * chunks, so the speed readout can report a REALTIME FACTOR.
 *
 * Why this exists at all: every text-derived rate answers "how fast is it reading the
 * book", which is not the question. A dense book packs 1.9 sentences into the same
 * ~310-character chunk a sparse one packs 4.4 into, so sentences/min halves between two
 * books running at identical throughput — measured 92 vs 150 on jobs whose actual
 * audio output per wall-minute was within 0.3% of each other. Audio seconds per wall
 * minute is the invariant, and only the rendered files know it.
 *
 * Sampled, not totalled: seconds-per-char converges in a few dozen chunks, and reading
 * every file would mean 6,000 round trips over a 9p mount to refine a display figure.
 * Fire-and-forget — the result is read on a later tick, never awaited by progress.
 */
function probeAudioSeconds(session: ConversionSession): void {
  const prep = session.prepInfo;
  if (!prep?.charCounts) return;                       // no chars to divide by

  if (!session.audioProbe) {
    session.audioProbe = { measured: new Set(), audioSeconds: 0, chars: 0, lastProbeAt: 0, inFlight: false };
  }
  const probe = session.audioProbe;
  const now = Date.now();
  if (probe.inFlight || now - probe.lastProbeAt < AUDIO_PROBE_INTERVAL_MS) return;

  // Newest first: a resumed job has thousands of pre-existing files, and the ones this
  // run produced are the ones whose pace we are reporting.
  const candidates: number[] = [];
  for (const worker of session.workers) {
    for (const index of worker.renderedIndices ?? []) {
      if (!probe.measured.has(index)) candidates.push(index);
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b - a);
  const batch = candidates.slice(0, AUDIO_PROBE_BATCH);

  probe.inFlight = true;
  probe.lastProbeAt = now;
  void (async () => {
    try {
      for (const index of batch) {
        const chars = prep.charCounts![index];
        if (chars === undefined || chars <= 0) { probe.measured.add(index); continue; }
        const seconds = await flacDurationSeconds(path.join(prep.chaptersDirSentences, `${index}.flac`));
        if (seconds === null) continue;                // mid-write; retry on a later pass
        probe.measured.add(index);
        probe.audioSeconds += seconds;
        probe.chars += chars;
      }
      if (probe.chars >= AUDIO_PROBE_MIN_CHARS) {
        probe.secondsPerChar = probe.audioSeconds / probe.chars;
      }
    } finally {
      probe.inFlight = false;
    }
  })();
}

/**
 * Measured throughput for a finished (or cancelled) session.
 *
 * Every number here is COUNTED from the run, never scaled by an assumed
 * sentences-per-chunk figure. That ratio is not a constant — it is whatever the packer
 * produced for this book at this character budget, which has ranged from ~1.5 to ~2.7
 * across real runs with individual chunks holding 1 to 9 sentences. Anything derived
 * from a fixed guess silently goes stale the next time the packing changes; a count
 * cannot.
 *
 * The per-chunk sentence counts come from prep (rawSentenceCounts) and are accrued as
 * each chunk is rendered, so `rawSentences` is the exact total for the chunks this
 * session actually converted — not the book average applied to a partial run, which is
 * what a resumed or cancelled job would otherwise report.
 *
 * Rates use workSeconds — the span since the FIRST chunk landed — because the wall
 * clock also contains model load and prep. Those can be a minute or more, and dividing
 * by them reports a throughput the job never ran at.
 */
function measureThroughput(session: ConversionSession, prepInfo: PrepInfo, endedAt: number): {
  chunksInSession: number;
  rawSentencesInSession?: number;
  rawWordsInSession?: number;
  rawCharsInSession?: number;
  workSeconds?: number;
  chunksPerMinute?: number;
  rawSentencesPerMinute?: number;
  wordsPerMinute?: number;
  charsPerMinute?: number;
  audioSecondsPerChar?: number;
  realtimeFactor?: number;
} {
  // ALWAYS present — it is a count, and zero is a real answer (a run that rendered
  // nothing). Its presence is what tells a reader this record carries measurements at
  // all, so nothing downstream has to guess whether a missing rate means "old record"
  // or "this run failed to produce one".
  const chunksInSession = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

  // Present exactly when prep supplied per-chunk sentence counts. Absent is the honest
  // answer when they weren't; an estimate here would be indistinguishable from a count.
  const accrued = prepInfo.rawSentenceCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedSentences || 0), 0)
    : undefined;

  // Every chunk holds at least one sentence, so rendering chunks and accruing zero
  // sentences is impossible — it means the per-chunk accrual didn't run. Report the
  // count as unknown and say so, rather than publishing a 0 that would read as a real
  // measurement and drag every sentences/min figure to zero.
  let rawSentencesInSession = accrued;
  if (accrued === 0 && chunksInSession > 0) {
    console.error(
      `[PARALLEL-TTS] raw-sentence accrual produced 0 across ${chunksInSession} rendered ` +
      `chunks (job ${session.jobId}) — per-chunk counts exist but were never accrued; ` +
      `omitting the sentence figures from this run's analytics`,
    );
    rawSentencesInSession = undefined;
  }

  // No first-chunk stamp, or no elapsed time since it, means nothing measurable ran.
  // Report no rate rather than one divided by the wall clock, which would quietly
  // attribute model-load time to rendering.
  // Words and chars over the same rendered chunks. Present exactly when prep supplied
  // the per-chunk arrays; absent is the honest answer, never a ratio-derived stand-in.
  const rawWordsInSession = prepInfo.wordCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedWords || 0), 0)
    : undefined;
  const rawCharsInSession = prepInfo.charCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedChars || 0), 0)
    : undefined;

  const renderStartedAt = session.firstSentenceCompletedTime;
  const workSeconds = renderStartedAt ? (endedAt - renderStartedAt) / 1000 : 0;
  if (workSeconds <= 0) {
    return { chunksInSession, rawSentencesInSession, rawWordsInSession, rawCharsInSession };
  }

  const perMin = (n: number) => Math.round((n / (workSeconds / 60)) * 10) / 10;
  const charsPerMinute = rawCharsInSession !== undefined ? perMin(rawCharsInSession) : undefined;

  // Realtime factor: a measured rate (chars/min) times a measured conversion (audio
  // seconds per char, sampled from this run's own FLACs). Both halves come from this
  // run, so it is comparable to any other run — which none of the text rates are, since
  // they move with the author's sentence length and the voice's speaking pace.
  const audioSecondsPerChar = session.audioProbe?.secondsPerChar;
  const realtimeFactor = charsPerMinute !== undefined && audioSecondsPerChar !== undefined
    ? Math.round((charsPerMinute * audioSecondsPerChar / 60) * 100) / 100
    : undefined;

  return {
    chunksInSession,
    rawSentencesInSession,
    rawWordsInSession,
    rawCharsInSession,
    workSeconds: Math.round(workSeconds),
    chunksPerMinute: perMin(chunksInSession),
    rawSentencesPerMinute: rawSentencesInSession !== undefined ? perMin(rawSentencesInSession) : undefined,
    wordsPerMinute: rawWordsInSession !== undefined ? perMin(rawWordsInSession) : undefined,
    charsPerMinute,
    audioSecondsPerChar,
    realtimeFactor,
  };
}

/**
 * The MLX batch to show under the chunk bar, or undefined when none is decoding.
 *
 * Batch state is per-worker (each worker drives its own BatchGenerator) but the
 * payload carries one, so the freshest heartbeat wins. In practice Orpheus/MLX
 * runs single-worker — it gets no benefit from parallelism — so "freshest" is
 * "the only one"; with several it stays truthful (some batch really is at that
 * point) rather than averaging two unrelated decodes into a number that describes
 * neither.
 */
function currentBatch(session: ConversionSession): ActiveBatchProgress | undefined {
  let newest: ActiveBatchState | undefined;
  for (const w of session.workers) {
    const b = w.activeBatch;
    if (!b) continue;
    if (!newest || b.updatedAt > newest.updatedAt) newest = b;
  }
  return newest ? toActiveBatchProgress(newest) : undefined;
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

  // The two comparable units, accrued over exactly the same chunks. Words feed the
  // readout, chars the ETA; neither is derived from the sentence tally.
  const rawWordsDoneInSession = session.prepInfo.wordCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedWords || 0), 0)
    : undefined;
  const rawCharsDoneInSession = session.prepInfo.charCounts
    ? session.workers.reduce((sum, w) => sum + (w.rawCompletedChars || 0), 0)
    : undefined;

  // Refresh the audio sample (throttled internally, never awaited — this tick reports
  // whatever the last completed probe found).
  probeAudioSeconds(session);

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
    // Absent when the sentence count is unknown. Deliberately NOT defaulted to the chunk
    // count — a reader seeing chunks labelled as sentences cannot tell the difference.
    totalRawSentences: session.prepInfo.totalRawSentences,
    completedSentences: totalCompleted,
    completedInSession: sentencesDoneInSession, // For accurate ETA calculation
    rawCompletedInSession: rawSentencesDoneInSession, // EXACT real sentences this session (precise sentences/min)
    rawWordsCompletedInSession: rawWordsDoneInSession,
    rawCharsCompletedInSession: rawCharsDoneInSession,
    totalRawWords: session.prepInfo.totalRawWords,
    totalRawChars: session.prepInfo.totalRawChars,
    // Measured on this run's own output — see probeAudioSeconds. Absent until enough
    // has been sampled, which is why the renderer must treat "no realtime factor yet"
    // as a real state rather than showing a zero.
    audioSecondsPerChar: session.audioProbe?.secondsPerChar,
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
    historicalRate: session.persistentState?.historicalSentencesPerMinute,
    stages: buildTtsStages(session, { convertPct: Math.round(percentage) }),
    stageDetail: session.stageDetail,
    activeBatch: currentBatch(session)
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
    // NOT REACHED from acquireGpuForJob: the Orpheus branch there does its own
    // artifact-aware floor gate + tier sizing and returns before this call. Kept as the
    // correct answer for any other caller, and deliberately NOT artifact-parameterised —
    // a second, uninformed sizing path is exactly how the two halves drift apart.
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
/**
 * Make every drive this run names reachable INSIDE the guest, before a worker
 * is asked to open one.
 *
 * Orpheus is the engine that runs in WSL, and WSL auto-mounts fixed drives
 * only. A fresh render never noticed, because its session lives in the guest
 * and is copied out afterwards — but a RESUME binds to the durable project
 * cache, and when the library is on a mapped network drive (Owen's is: Z: is
 * \TITAN\iO) the guest was handed `/mnt/z/...`, which does not exist. e2a
 * then failed with `Session directory not found` naming a path nobody chose.
 *
 * Both halves of the run are covered because both are drives: `--session_dir`
 * (read) and `--sentences_dir` (WRITE — which is why mounting is the fix and
 * staging is not; see electron/wsl-mounts.ts).
 *
 * Refuses out loud rather than letting the spawn proceed into a path that is
 * not there. A WSL-hosted session (`\wsl$\...`) names no drive letter, so it
 * asks for nothing.
 */
async function ensureGuestCanReachSession(session: ConversionSession): Promise<void> {
  if (!jobRunsInWsl(session.config.settings.ttsEngine)) return;
  const prep = session.prepInfo;
  await ensureWslDrivesFor([
    prep?.sessionDir,
    prep?.processDir,
    prep?.chaptersDirSentences,
    session.config.outputDir,
  ]);
}

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

  // MERGED or ADAPTER? An adapter spawn needs ~1 GiB more free VRAM than the merged
  // equivalent, because vLLM does not account for the resident LoRA or the punica
  // workspace in its reservation. Resolve it once, here, and thread it through every
  // sizing call below. A voice that can't resolve (e.g. an adapter whose base isn't
  // installed) fails the job here rather than at spawn — same error, earlier and with
  // the GPU not yet reserved.
  let serveArtifact: OrpheusServeArtifact;
  try {
    serveArtifact = orpheusServeArtifact(session.config.settings);
  } catch (err) {
    session.gpuPreflightError = err instanceof Error ? err.message : String(err);
    console.error(`[PARALLEL-TTS] Job ${jobId}: ${session.gpuPreflightError}`);
    return;
  }
  // Remembered for the whole job: a worker that dies OOM re-waits for VRAM before
  // respawning, and that wait must ask for the SAME floor this preflight enforced.
  session.orpheusServeArtifact = serveArtifact;

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
    const orpheusFreeFloorMB = orpheusMinFreeVramMB(serveArtifact) + DESKTOP_VRAM_MARGIN_MB;
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
    const wanted = resolveConcreteOrpheusTier(free, total, serveArtifact);
    const fit = fitOrpheusTier(wanted, free, total, serveArtifact);
    const tier = fit.tier;
    session.orpheusTier = tier; // remembered so an OOM can lower the auto ceiling
    session.orpheusMemLevel = orpheusTierLabel(tier);
    const profile = orpheusMemoryProfile(tier, serveArtifact);
    session.orpheusVllmBatch = profile.vllmBatch; // match submission batch to KV cache
    const ceiling = Number(process.env.ORPHEUS_GPU_MEM_UTIL) || profile.ceiling;
    const sized = await computeSafeGpuUtil(profile.capMB, profile.marginMB, ceiling, serveArtifact);
    console.log(`[PARALLEL-TTS] Job ${jobId} Orpheus memory '${getOrpheusMemoryTier()}' → wanted '${wanted}', using '${tier}'${fit.steppedDown ? ' (stepped down)' : ''} (cap ${profile.capMB} MB, ceiling ${ceiling}, artifact ${serveArtifact})`);
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
  stopRenderedPoller(session);
  stopStateSaveTimer(session);

  // Finalize persistent state
  finalizeRunState(session, success ? 'completed' : 'error', error).catch(err => {
    console.error('[PARALLEL-TTS] Failed to finalize state:', err);
  });

  const completedTime = Date.now();
  const completedAt = new Date(completedTime).toISOString();
  const duration = Math.round((completedTime - session.startTime) / 1000);

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
    manifestService.registerAudiobookOutput(outputPath, { narrator, professionallyRead: false })
      .then((reg) => {
        if (reg.skipped) console.warn('[PARALLEL-TTS] Audiobook not registered (outside library):', outputPath);
        else if (!reg.success) console.error('[PARALLEL-TTS] Failed to register audiobook in manifest:', reg.error);
        else console.log('[PARALLEL-TTS] Registered audiobook in manifest:', outputPath);
      })
      .catch((err) => console.error('[PARALLEL-TTS] Manifest registration threw:', err));
  }

  // Calculate total done in this session (completedSentences tracks actual TTS conversions)
  const sessionDone = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);

  // CHUNKS per minute over the whole job — setup included, which is why it reads lower
  // than the rate the queue showed while running (that one divides by workSeconds).
  // Named for what it holds: it was called sentencesPerMinute for a long time while
  // holding chunks, and every reader that trusted the name reported chunks as sentences.
  const durationMinutes = duration / 60;
  const chunksPerMinuteOverall = durationMinutes > 0
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
  const historicalRate = persistentState?.historicalSentencesPerMinute || chunksPerMinuteOverall;

  // Counted from this run — no assumed sentences-per-chunk anywhere in them.
  const throughput = measureThroughput(session, session.prepInfo, completedTime);
  // Cross-run REAL sentences/min, over render time only. Mirrors the historicalRate
  // fallback above: this run's measured figure when no cross-run one exists — and
  // undefined when neither does, never a chunk-based stand-in.
  const historicalRawRate = persistentState?.historicalRawSentencesPerMinute || throughput.rawSentencesPerMinute;

  // Build analytics data (includes both session and historical data)
  const analytics = {
    jobId: session.jobId,
    startedAt: new Date(session.startTime).toISOString(),
    completedAt,
    durationSeconds: duration,
    totalSentences: session.prepInfo.totalSentences,
    // Whole-book real sentence count. Kept for context and for older readers; the
    // per-run measurements below are what the throughput figures are built from.
    totalRawSentences: session.prepInfo.totalRawSentences,
    totalChapters: session.prepInfo.totalChapters,
    workerCount: session.config.workerCount,
    chunksPerMinuteOverall,
    // Counted from this run — no assumed sentences-per-chunk anywhere in them.
    ...throughput,
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
    // Chunks/min over wall clock — legacy, and not comparable between books.
    averageSentencesPerMinuteAllRuns: historicalRate,
    // Real sentences/min over render time — the definitive, comparable speed figure.
    averageRawSentencesPerMinuteAllRuns: historicalRawRate,
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
    error,
    // A terminal success has to SAY every stage finished, because nothing downstream
    // can infer it: the renderer nullish-keeps `stages` (a one-off event carrying none
    // must not blank the bars mid-run), so a completion without them leaves whatever
    // the last APPLIED live tick reported frozen on screen. And the last live tick is
    // routinely not the last one SENT — parallel TTS progress is rAF-coalesced in the
    // renderer, and this event's own terminal handler drops the pending frame on
    // purpose so a stale tick can't overwrite the completion. That is how a finished
    // 925/925 run kept showing "Converting sentences · 90% · running" with a stale
    // "Repairing over-long chunk 860…" beneath it while assembly was already encoding.
    //
    // Failure keeps the live list instead: how far the run actually got is the honest
    // record of a failed run, and a bar reading 100% would be a lie about it.
    ...(success
      ? {
          stages: buildTtsStages(session, { convertPct: 100, done: true }),
          // Whatever the running stage was last doing is over. Empty, not undefined:
          // the renderer nullish-keeps this field too, so undefined would preserve it.
          stageDetail: '',
        }
      : {}),
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

/** What the narration door is asked for. */
export interface NarrationPrepOptions {
  /** The job's own flag, so the prep progress bars match the job's shape. */
  skipAssembly: boolean;
  /**
   * The model, INJECTED — `tts-number-normalizer.ts`'s own doctrine, one level
   * up. Production omits it and the door builds the Ollama runner from the
   * Settings tag; a test passes a scripted runner and reaches both branches of
   * the format routing with no GPU and no model loaded.
   */
  numberRunner?: NumberNormalizerRunner;
}

/** What the door produced, and what to say about it in one line. */
export interface NarrationPrepResult {
  /**
   * The file the render must read from here on — the input itself, same bytes,
   * when it carried no captions, no notes and no digits.
   */
  inputPath: string;
  /** The `.edits.json` beside the copy, or null when nothing was written. */
  recordPath: string | null;
  /** The model tag that did the reading — in the log, and in every error. */
  model: string;
  /** How many spans the voice now reads as words. */
  appliedSpans: number;
  /** Of those, how many a deterministic rule read before the model was asked. */
  appliedByRules: number;
  /** And how many the model read. The two sum to `appliedSpans`. */
  appliedByModel: number;
  /** True when a copy already on disk was reused: no model call was made. */
  reused: boolean;
  /** The disposition tally, for the record and the CLI's one line. */
  dispositions: Record<string, number>;
}

/**
 * The file a narration should actually read: the book, or a cut of it with the
 * photo captions, the note apparatus and the reference numbers left out.
 *
 * ── The rulings ─────────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-29, after God's People narrated all 37 of its photo captions:
 * *"ideally it wont read caption text at all. those are unintentionally
 * included. if we can find a fix for those then we should."* And 2026-08-30,
 * on the 675 endnotes the same render read at every chapter's end: *"Ideally I
 * will never include endnotes for my purposes… Reference numbers should never
 * make it to TTS. They aren't read in a real audiobook, they shouldn't be read
 * in TTS."* Both are words the listener was never meant to hear, and the skip
 * census ranks the citation apparatus the most defect-prone text in a book
 * besides (dense digits, foreign titles).
 *
 * ── Why the substitution happens HERE ───────────────────────────────────────
 *
 * This is the one door every queued narration walks through, and the evidence
 * is on the file itself: foundry's conversion stamps say `data-bf-cat="caption"`
 * and `"footnote"` on the elements they mean, book by book. A book with neither
 * stamp — every publisher EPUB never converted, every book with no pictures and
 * no notes — passes through UNTOUCHED, same path, same bytes, so nothing
 * changes for a file that carries no evidence. The cut itself is `writeNarrationEpub`, the one verified door
 * that is allowed to write a narration copy: it proves every excluded element
 * left the file or destroys the output.
 *
 * ── Why the cut is content-addressed ────────────────────────────────────────
 *
 * e2a's sessions remember the `--ebook` path they were prepped from, and the
 * resume and clean-session flows match on it. A cut named by the SOURCE's
 * sha256 gives the same book the same path on every submission — so a resumed
 * render matches the session its first run made — and a book that changed gets
 * a new path, which is exactly a session that must not be resumed. (`.v1`
 * versions the cut rule itself: a future change to what the cut removes must
 * not reuse a stale file.)
 *
 * NOT applied to `renderRangeHeadless`: its resume seeds FLACs by sentence
 * INDEX from a prior run's directory, and changing the input text under a
 * seeded campaign would land every cached sentence after the first caption on
 * the wrong words. The campaign tool keeps reading exactly what it is handed.
 *
 * A cut that fails is a job that fails, in the cut's own sentence — falling
 * back to the uncut book would quietly narrate the captions this exists to
 * keep out, which is the silence the ruling ended.
 *
 * ── Why this is EXPORTED ────────────────────────────────────────────────────
 *
 * Owen, 2026-09-02: *"lets also add access to the cleanup step in the cli. high
 * level so it runs the same code the app would, so we can catch bugs that way."*
 * So this is one function, called by `startParallelConversion` (the app's queue)
 * and by the CLI's render adapters and `--prep` alike. A second implementation
 * in `cli/` would be a second thing to keep true, and a CLI that ran a different
 * prep from the app could not catch the app's bugs, which is the whole point of
 * having it.
 *
 * NOT called by `renderRangeHeadless`, still: its resume seeds FLACs by sentence
 * INDEX from a prior run's directory, and changing the input text under a seeded
 * campaign would land every cached sentence after the first caption on the wrong
 * words. The CLI adapters call this door and hand the RESULT to
 * `renderRangeHeadless`, which keeps reading exactly what it is given.
 *
 * ── The two formats it reads ────────────────────────────────────────────────
 *
 * An `.epub` is cut and then normalized. A `.txt` — what `--tts --text` and
 * `--tts --input passage.txt` render — has no captions and no note apparatus to
 * cut, so it goes straight to the number pass in its block form. Anything else
 * is REFUSED by name: silently skipping the prep for a format this door has no
 * reader for would narrate the digits it exists to convert while the log said
 * nothing at all.
 */
export async function prepareNarrationInput(
  inputPath: string,
  jobId: string,
  opts: NarrationPrepOptions,
): Promise<NarrationPrepResult> {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.txt') {
    return normalizeTextNumbersFor(inputPath, jobId, opts);
  }
  if (ext !== '.epub') {
    throw new Error(
      `The narration prep has no reader for '${ext || path.basename(inputPath)}' `
      + `(${inputPath}). It reads .epub and .txt.`);
  }
  // ── The CHECK that replaced the transform (2026-09-04) ────────────────────
  //
  // The punctuation and the numbers are now a PASS the user runs on the book —
  // `electron/narration-text-pass.ts`, recorded in the ledger, stamped into the
  // OPF. This door reads that stamp and REFUSES a book that has not been through
  // it. It does not run the pass itself: an hour of model time inside a render's
  // prep is exactly what Owen's ruling moved out of here, and a door that
  // silently did the work again would make the persisted pass pointless.
  //
  // Refused by NAME, never skipped. e2a has no number transform of its own any
  // more (permanently disabled, 2026-09-02), so a book that reached the voice
  // unstamped would be narrated as printed digits with nothing to say so.
  const gate = await narrationTextGate(inputPath);
  if (!gate.ok) {
    throw new Error(
      `${gate.reason} (Narration was asked to read ${path.basename(inputPath)}; nothing was `
      + 'rendered.)');
  }
  const cut = await cutCaptionsAndNotes(inputPath, jobId);
  console.log(
    `[PARALLEL-TTS] ${path.basename(inputPath)} carries a current narration-text stamp `
    + `(${gate.stamp.normalizerVersion}/${gate.stamp.punctuationSpec}, ${gate.stamp.model}) — `
    + 'its punctuation is canonical and its numbers are already words.');
  await logger.log('INFO', jobId,
    'the book carries a current narration-text stamp; the render reads it as cleaned', {
      normalizerVersion: gate.stamp.normalizerVersion,
      punctuationSpec: gate.stamp.punctuationSpec,
      model: gate.stamp.model,
    });
  return {
    inputPath: cut,
    // The record is the PASS's, not this door's: it sits beside the cleaned book
    // (`<stem>.narration.narration-text.json`) and in the project's ledger.
    recordPath: null,
    model: gate.stamp.model,
    appliedSpans: 0,
    appliedByRules: 0,
    appliedByModel: 0,
    reused: true,
    dispositions: {},
  };
}

/** The stamp check, imported here so the door has one line and one meaning. */
async function narrationTextGate(bookPath: string): Promise<NarrationTextGate> {
  const pass = await import('./narration-text-pass.js');
  return pass.narrationTextGate(bookPath);
}

/** The caption/footnote cut — the first half of the door. */
async function cutCaptionsAndNotes(epubPath: string, jobId: string): Promise<string> {
  const { readEpubConversionUnits, writeNarrationEpub } = await import('./epub-processor.js');

  const units = await readEpubConversionUnits(epubPath);
  const captions = units.filter((u) => u.category === 'caption').length;
  const footnotes = units.filter((u) => u.category === 'footnote').length;
  if (captions === 0 && footnotes === 0) return epubPath;

  const bytes = await fs.readFile(epubPath);
  const sha16 = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const cutDir = path.join(getDefaultE2aTmpPath(), 'narration-cuts');
  // `.v2`: the rule grew (footnote asides out, sup markers stripped — Owen's
  // 2026-08-30 ruling), so a v1 cut on disk describes a rule this door no
  // longer applies and must not be reused.
  const cutPath = path.join(cutDir, `${sha16}.v2.tts.epub`);

  try {
    await fs.access(cutPath);
    // Same source sha ⇒ the same cut, made by this same rule. Reused so a
    // resubmission of a half-finished render preps against the identical file.
    console.log(
      `[PARALLEL-TTS] ${captions} caption(s) and ${footnotes} note(s) excluded from narration `
      + `(cut on disk reused): ${cutPath}`);
    return cutPath;
  } catch { /* not cut yet */ }

  await fs.mkdir(cutDir, { recursive: true });
  // Cut to a staging name and renamed into place, so a process that dies
  // mid-write cannot leave a truncated file under the name the reuse branch
  // above trusts.
  const staging = path.join(cutDir, `${sha16}.staging-${crypto.randomUUID()}.epub`);
  const written = await writeNarrationEpub(epubPath, staging, [], {
    excludeCaptions: true,
    excludeFootnotes: true,
    // The writer's own default, taken deliberately since 2026-08-30: *"Reference
    // numbers should never make it to TTS. They aren't read in a real
    // audiobook."* A digits-only <sup> that survived the compile is exactly one.
    stripSupMarkers: true,
  });
  await fs.rename(staging, cutPath);
  await logger.log('INFO', jobId,
    `${written.excludedCaptions} caption(s), ${written.excludedFootnotes} note(s) and `
    + `${written.removedSupMarkers} reference number(s) excluded from the narration`, {
      cutPath, source: epubPath,
    });
  console.log(
    `[PARALLEL-TTS] excluded from narration: ${written.excludedCaptions} caption(s), `
    + `${written.excludedFootnotes} note(s), ${written.removedSupMarkers} reference number(s) — `
    + `the book keeps them; the cut is ${cutPath}`);
  return cutPath;
}

/**
 * The numbers of a PLAIN-TEXT input, read as words — the whole door for a `.txt`.
 *
 * There is no caption cut here and there is nothing missing: a text file has no
 * `data-bf-cat` stamps, no `<sup>` markers and no note apparatus, so the cut
 * would have nothing to name. What it has is paragraphs, which
 * `normalizeTextBlocks` asks about through the SAME loop the book pass uses.
 */
async function normalizeTextNumbersFor(
  inputPath: string,
  jobId: string,
  opts: NarrationPrepOptions,
): Promise<NarrationPrepResult> {
  const { loadNumberNormalizePrompt } = await import('./ai-bridge.js');
  const { normalizeTextBlocks, splitTextBlocks } = await import('./tts-number-normalizer.js');
  const { canonicalizePunctuationText } = await import('./tts-punctuation.js');

  const runner = await narrationNumberRunner(opts);
  // Punctuation FIRST, exactly as the book pass runs it — a `.txt` has no
  // document chain to carry a stamp, so this door is where the audition's text
  // gets the same canonical ellipsis and the same quotes the shipped audiobook
  // has. An audition that measured a different pipeline than it claims to is the
  // whole reason this path exists.
  const blocks = splitTextBlocks(await fs.readFile(inputPath, 'utf8'))
    .map((block) => canonicalizePunctuationText(block));
  const outcome = await normalizeTextBlocks(blocks, runner, {
    systemPrompt: await loadNumberNormalizePrompt(),
    outDir: narrationCutsDir(),
    source: inputPath,
    onProgress: prepProgressSink(jobId, opts.skipAssembly),
  });

  if (outcome === null) {
    console.log(
      `[PARALLEL-TTS] ${path.basename(inputPath)} prints no digits a narrator would read — `
      + 'no number normalization was needed.');
    return {
      inputPath, recordPath: null, model: runner.model,
      appliedSpans: 0, appliedByRules: 0, appliedByModel: 0, reused: false, dispositions: {},
    };
  }

  await logger.log('INFO', jobId,
    `${outcome.record.appliedByRules} number(s) read as words by rule and `
    + `${outcome.record.appliedByModel} by ${runner.model}, across `
    + `${outcome.record.targetsSelected} block(s)`, {
      copy: outcome.textPath, record: outcome.recordPath, reused: outcome.reused,
      dispositions: outcome.record.dispositions,
    });
  return {
    inputPath: outcome.textPath,
    recordPath: outcome.recordPath,
    model: runner.model,
    appliedSpans: outcome.record.appliedSpans,
    appliedByRules: outcome.record.appliedByRules,
    appliedByModel: outcome.record.appliedByModel,
    reused: outcome.reused,
    dispositions: outcome.record.dispositions,
  };
}

/**
 * Where every narration copy this door makes lives — cut and normalized alike.
 *
 * EXPORTED so the narration text pass and its CLI stage put their intermediates
 * in the SAME place the render door looks. Two scratch directories would mean a
 * pass paying for a model call the door had already paid for.
 */
export function narrationCutsDir(): string {
  return path.join(getDefaultE2aTmpPath(), 'narration-cuts');
}

/** The caller's runner, or the live Ollama one built from the Settings tag. */
async function narrationNumberRunner(
  opts: NarrationPrepOptions,
): Promise<NumberNormalizerRunner> {
  if (opts.numberRunner !== undefined) return opts.numberRunner;
  const { createOllamaNormalizerRunner, numberNormalizerModel } =
    await import('./tts-number-normalizer-runner.js');
  // Read ONCE and carried, because the tag is part of the cache path — a run that
  // read it twice could name the copy after one model and make it with another.
  return createOllamaNormalizerRunner(numberNormalizerModel());
}

/** The prep bar, throttled — the same sink for a book and for a text file. */
function prepProgressSink(
  jobId: string, skipAssembly: boolean,
): (done: number, total: number, label: string) => void {
  // At most ~4 updates a second: a paragraph can settle in well under 250 ms and
  // the renderer redraws a lane on every one of these.
  const MIN_INTERVAL_MS = 250;
  let lastEmit = 0;
  return (done, total, label) => {
    const now = Date.now();
    // The last tick always goes out — it is the one that says the model is being
    // released, and a throttle that swallowed it would leave the bar stopped
    // short of the end for the rest of the job.
    if (done < total && now - lastEmit < MIN_INTERVAL_MS) return;
    lastEmit = now;
    emitPrepStageProgress(jobId, `${label}…`, skipAssembly, { label, done, total });
  };
}

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

  // The captions out, before anything downstream sees the path: the session,
  // its resume matching and the clean-session sweep all key on `epubPath`, so
  // one substitution here keeps every one of them speaking about one file.
  // After the title above, which should read as the book and not as a sha.
  try {
    const prepared = await prepareNarrationInput(
      config.epubPath, jobId, { skipAssembly: config.skipAssembly === true });
    if (prepared.inputPath !== config.epubPath) {
      config = { ...config, epubPath: prepared.inputPath };
    }
  } catch (err) {
    const error = `The narration copy could not be cut: ${err instanceof Error ? err.message : err}`;
    console.error('[PARALLEL-TTS]', error);
    await logger.failJob(jobId, error);
    stopPowerBlock();
    emitJobFailure(jobId, error);
    return { success: false, error };
  }

  // Determine effective output directory:
  // - If bfpPath is set, output directly to the project audiobook folder
  // - Otherwise, require outputDir to be set
  let effectiveOutputDir: string;

  if (config.bfpPath) {
    // Output directly to the project audiobook folder (no temp dir needed)
    effectiveOutputDir = getAudiobookDirFromBfp(config.bfpPath);
    await fs.mkdir(effectiveOutputDir, { recursive: true });
    console.log(`[PARALLEL-TTS] Outputting directly to the project audiobook folder: ${effectiveOutputDir}`);
  } else if (config.outputDir && config.outputDir.trim() !== '') {
    // No project directory: output directly to outputDir
    effectiveOutputDir = config.outputDir;
  } else {
    const error = 'Output directory not configured. Please set the audiobook output folder in Settings.';
    console.error('[PARALLEL-TTS]', error);
    await logger.failJob(jobId, error);
    stopPowerBlock();
    emitJobFailure(jobId, error);
    return { success: false, error };
  }

  // Clean any existing sessions for this epub if requested.
  // ONLY set when the submission explicitly intended a fresh render (the wizard's
  // "Start fresh" over "Continue") — see queue.service.ts. Anything else must leave
  // scratch sessions alone: they are the crash-resume checkpoint.
  if (config.cleanSession) {
    console.log(`[PARALLEL-TTS] cleanSession=true, deleting existing sessions for ${config.epubPath}`);
    const deleted = await deleteSessionsForEpub(config.epubPath);
    ttsLog.warn('cleanSession: deleted scratch sessions for this EPUB', {
      jobId, epubPath: config.epubPath, bfpPath: config.bfpPath, deletedSessions: deleted,
    });
  }

  // NOTE: We intentionally do NOT auto-skip to assembly for complete sessions.
  // Users who want to assemble an existing session should use the Reassembly feature.
  // TTS jobs always run prep to create a fresh session with the current settings.

  // Prepare the session first. Prep is a real, minute-scale stage (extract the epub,
  // split it, pack chunks) that used to emit nothing — so announce it before starting,
  // or the job shows a blank 0% until the first worker spawns.
  let prepInfo: PrepInfo;
  emitPrepStageProgress(jobId, 'Extracting text and splitting sentences…', config.skipAssembly === true);
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
    // The session only exists once prep has returned (or, for assembly-only runs,
    // never runs at all), so prep is finished by construction — this is what flips
    // the "Preparing book" bar to complete.
    prepDoneAt: Date.now(),
    cancelled: false,
    assemblyProcess: null
  };

  activeSessions.set(jobId, session);

  // Record which project owns this scratch session, so a crash-killed run (no
  // before-quit flush) can still be rescued into the durable cache at next startup
  // instead of being swept away with the rest of <library>/tmp.
  await writeSessionOwner(session);
  ttsLog.info('TTS session prepared (fresh)', {
    jobId,
    sessionId: prepInfo.sessionId,
    sessionDir: prepInfo.sessionDir,
    bfpPath: config.bfpPath || null,
    language: config.settings.language || 'en',
    epubPath: config.epubPath,
    totalSentences: prepInfo.totalSentences,
    cleanSession: !!config.cleanSession,
  });

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

    // Emit session-created event so the renderer can log the session
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
  await ensureGuestCanReachSession(session);
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

  // Chapters finish long before the render does; start closing them now so the gap
  // normalization and the AAC encode happen on idle cores instead of after the GPU
  // is done. Declines quietly when the job's shape makes it unsafe.
  maybeStartChapterCloser(session);

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

    // Start the watchdog to detect stuck workers, plus (Mac/MLX) the rendered-file
    // poller that reports bucket completions stdout won't mention for minutes.
    startWatchdog(session);
    startRenderedPoller(session);
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
/** Copy already-rendered {i}.flac (i < total, >1 KB) from a prior session's cache into
 *  a fresh session's sentences dir, so the worker SKIPS them and renders only what's
 *  missing (resume). Prep is deterministic for the same input+settings, so the sentence
 *  index lines up. Copying (vs pointing) keeps assembly reading one dir. Returns the
 *  number seeded. */
async function seedResumeSentences(fromDir: string, toDir: string, total: number): Promise<number> {
  let entries: string[];
  try { entries = await fs.readdir(fromDir); } catch { return 0; }
  await fs.mkdir(toDir, { recursive: true });
  let n = 0;
  for (const name of entries) {
    const m = /^(\d+)\.flac$/.exec(name);
    if (!m || parseInt(m[1], 10) >= total) continue;   // not a sentence file, or out of range
    const src = path.join(fromDir, name);
    const dst = path.join(toDir, name);
    try {
      if ((await fs.stat(src)).size <= 1024) continue;  // truncated — let it re-render
      try { await fs.access(dst); continue; } catch { /* absent — copy it */ }
      await fs.copyFile(src, dst);
      n++;
    } catch { /* skip unreadable */ }
  }
  return n;
}

export async function renderRangeHeadless(
  inputPath: string,
  settings: ParallelTtsSettings,
  opts?: {
    jobId?: string;
    /** Prior session's sentences dir to seed from (resume — skip already-rendered). */
    resumeFromSentencesDir?: string;
    /** Fired once the session is on disk (before generation) so the caller can persist
     *  partial progress on interrupt. */
    onSessionReady?: (info: { sessionDir: string; sentencesDir: string; totalSentences: number }) => void;
  }
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

  // Session is on disk now (state + empty sentences dir); hand its location to the
  // caller BEFORE generation so an interrupt can persist partial progress (resume).
  opts?.onSessionReady?.({
    sessionDir: scratchSessionDir,
    sentencesDir: prepInfo.chaptersDirSentences,
    totalSentences: prepInfo.totalSentences,
  });

  // Resume: seed the fresh sentences dir with already-rendered FLACs from a prior run.
  if (opts?.resumeFromSentencesDir) {
    const seeded = await seedResumeSentences(
      opts.resumeFromSentencesDir, prepInfo.chaptersDirSentences, prepInfo.totalSentences
    );
    console.log(`[renderRangeHeadless] resume: seeded ${seeded}/${prepInfo.totalSentences} cached sentence(s)`);
  }

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
    // The session only exists once prep has returned (or, for assembly-only runs,
    // never runs at all), so prep is finished by construction — this is what flips
    // the "Preparing book" bar to complete.
    prepDoneAt: Date.now(),
    cancelled: false,
    assemblyProcess: null
  };
  activeSessions.set(jobId, session);

  // Take the GPU (mutex + VRAM-tier sizing + WSL clear-guest / VRAM-floor gates).
  await ensureGuestCanReachSession(session);
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
    startRenderedPoller(session);
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
  stopRenderedPoller(session);
  // The closer polls on a timer of its own; without this it would outlive the
  // cancelled job and keep reading a session that is being torn down. Its partial
  // output stays on disk and is simply never marked complete, so assembly ignores it.
  stopChapterCloser(jobId).catch((err) => {
    logger.log('WARN', jobId, `Chapter closer stop failed during cancel: ${err}`).catch(() => {});
  });
  const ttsEngine = session.config?.settings?.ttsEngine;

  // Mark workers cancelled up front so the UI reflects the stop while the graceful
  // teardown below runs.
  for (const worker of session.workers) {
    if (worker.process) {
      worker.status = 'error';
      worker.error = 'Cancelled';
    }
  }

  if (jobRunsInWsl(ttsEngine)) {
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
  const ttsLog = getTTSLogger();
  try {
    const bfpPath = session.config.bfpPath;
    const sessionDir = session.prepInfo?.sessionDir;
    if (!bfpPath || !sessionDir) {
      ttsLog.warn('Interrupt-cache skipped — nowhere durable to write', {
        jobId: session.jobId, bfpPath: bfpPath || null, sessionDir: sessionDir || null,
      });
      return;
    }

    // Sentences actually on disk for this session = prior-run baseline (resume) + this run.
    const thisRun = session.workers.reduce((s, w) => s + w.completedSentences, 0);
    const ours = (session.isResumeJob ? (session.baselineCompleted || 0) : 0) + thisRun;
    if (ours <= 0) {
      ttsLog.info('Interrupt-cache skipped — nothing rendered yet', { jobId: session.jobId, sessionDir });
      return; // nothing rendered → nothing to preserve
    }

    const language = session.config.settings.language || 'en';
    let existing = 0;
    try {
      const sessions = await scanProjectSessions(bfpPath);
      existing = sessions.find(s => s.language === language)?.sentenceCount ?? 0;
    } catch { /* no cache yet */ }
    if (existing >= ours) {
      console.log(`[PARALLEL-TTS] Skip interrupt-cache for ${session.jobId}: cache already has ${existing} ≥ ${ours}`);
      ttsLog.info('Interrupt-cache skipped — cache already at least as complete', {
        jobId: session.jobId, bfpPath, language, cachedSentences: existing, ourSentences: ours,
      });
      return;
    }

    const r = await cacheSessionToProject(sessionDir, bfpPath, language);
    if (r.success) {
      console.log(`[PARALLEL-TTS] Interrupted session cached (${ours} sentences) → ${r.cachedSentencesDir}`);
      ttsLog.info('Interrupted session cached to project', {
        jobId: session.jobId, bfpPath, language, sentences: ours,
        replacedCachedSentences: existing, cachedPath: r.cachedSentencesDir,
      });
    } else {
      console.warn(`[PARALLEL-TTS] Interrupt-cache failed for ${session.jobId}: ${r.error}`);
      ttsLog.error('Interrupt-cache FAILED — partial render is only in scratch', {
        jobId: session.jobId, bfpPath, language, sentences: ours, error: r.error,
      });
    }
  } catch (err) {
    console.error('[PARALLEL-TTS] Interrupt-cache error:', err);
    ttsLog.error('Interrupt-cache errored', { jobId: session.jobId, error: (err as Error).message });
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

  const cancelledTime = Date.now();
  const cancelledAt = new Date(cancelledTime).toISOString();
  const duration = Math.round((cancelledTime - session.startTime) / 1000);

  // Calculate sentences completed before cancellation
  // completedSentences tracks actual TTS conversions for both regular and resume jobs
  const sessionDone = session.workers.reduce((sum, w) => sum + w.completedSentences, 0);
  const completedSentences = session.isResumeJob
    ? (session.baselineCompleted || 0) + sessionDone
    : sessionDone;

  // CHUNKS per minute over the whole job (setup included) — see the same computation on
  // the success path for why this is no longer called sentencesPerMinute.
  const durationMinutes = duration / 60;
  const chunksPerMinuteOverall = durationMinutes > 0 && sessionDone > 0
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
  const historicalRate = persistentState?.historicalSentencesPerMinute || chunksPerMinuteOverall;

  // Counted from this run — no assumed sentences-per-chunk anywhere in them.
  const throughput = measureThroughput(session, session.prepInfo, cancelledTime);
  // Cross-run REAL sentences/min, over render time only. Mirrors the historicalRate
  // fallback above: this run's measured figure when no cross-run one exists — and
  // undefined when neither does, never a chunk-based stand-in.
  const historicalRawRate = persistentState?.historicalRawSentencesPerMinute || throughput.rawSentencesPerMinute;

  // Build analytics for cancelled job (includes historical data)
  const analytics = {
    jobId: session.jobId,
    startedAt: new Date(session.startTime).toISOString(),
    completedAt: cancelledAt,
    durationSeconds: duration,
    totalSentences: session.prepInfo.totalSentences,
    // Whole-book real sentence count. Kept for context and for older readers; the
    // per-run measurements below are what the throughput figures are built from.
    totalRawSentences: session.prepInfo.totalRawSentences,
    totalChapters: session.prepInfo.totalChapters,
    workerCount: session.config.workerCount,
    chunksPerMinuteOverall,
    // Counted from this run — no assumed sentences-per-chunk anywhere in them.
    ...throughput,
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
    // Chunks/min over wall clock — legacy, and not comparable between books.
    averageSentencesPerMinuteAllRuns: historicalRate,
    // Real sentences/min over render time — the definitive, comparable speed figure.
    averageRawSentencesPerMinuteAllRuns: historicalRawRate,
    numberOfRuns: persistentState?.runs.length || 1,
    originalStartTime: persistentState?.originalStartTime || new Date(session.startTime).toISOString(),
    runs: persistentState?.runs || []
  };

  // 'stopped', not 'error' — see AggregatedProgress.phase. And no `error` field: a stop
  // is a state, not a failure, and a job carrying an error string reads as broken in
  // every surface that shows one.
  const progress: AggregatedProgress = {
    phase: 'stopped',
    totalSentences: session.prepInfo.totalSentences,
    completedSentences,
    completedInSession: sessionDone,
    percentage: Math.round((completedSentences / session.prepInfo.totalSentences) * 100),
    activeWorkers: 0,
    workers: serializeWorkers(session.workers) as WorkerState[],
    estimatedRemaining: 0,
    message: 'Stopped by user — press Start to resume'
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
    // Absent when the sentence count is unknown. Deliberately NOT defaulted to the chunk
    // count — a reader seeing chunks labelled as sentences cannot tell the difference.
    totalRawSentences: session.prepInfo.totalRawSentences,
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
 * THE LAST BRACE-BALANCED JSON VALUE IN A STDOUT BUFFER.
 *
 * narrator's `app.py` door prints its result as `json.dumps(result, indent=2)` —
 * pretty-printed, so it spans lines — and e2a's `app.py:278` did the same. The
 * readers here used to scan stdout LINE BY LINE calling `JSON.parse` on each and
 * taking the first that parsed. Against an indented object no line is valid JSON
 * on its own, so `--resume_session` always fell through to "Failed to parse
 * resume check output" and `--list_sessions` was documented as "human-readable
 * (not JSON)" and hard-coded to return an empty list.
 *
 * Scanning for balance instead reads either shape, and reads the LAST value
 * rather than the first because a route may print warnings — `resume_session`
 * prints `Warning: <compat>` lines before its result — and a warning that happens
 * to contain a brace must not become the answer.
 *
 * Strings are tracked so a `{` or `]` inside a title or a path cannot unbalance
 * the scan; escapes are honoured so a title ending in a backslash cannot swallow
 * the closing quote.
 */
function lastJsonValue(stdout: string, open: '{' | '['): any {
  const close = open === '{' ? '}' : ']';
  for (let start = stdout.lastIndexOf(open); start >= 0; start = stdout.lastIndexOf(open, start - 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < stdout.length; i++) {
      const ch = stdout[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(stdout.slice(start, i + 1));
          } catch {
            // A balanced span that is not JSON (a Python repr in a log line, say).
            // Keep walking left rather than giving up on the whole buffer.
          }
          break;
        }
      }
    }
    if (start === 0) break;
  }
  return null;
}

/** The last complete JSON OBJECT printed on stdout, or null. */
function lastJsonObject(stdout: string): any {
  return lastJsonValue(stdout, '{');
}

/** The last complete JSON ARRAY printed on stdout, or null. */
function lastJsonArray(stdout: string): any[] | null {
  const v = lastJsonValue(stdout, '[');
  return Array.isArray(v) ? v : null;
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

  // Engine-agnostic, like assembly: it reads session-state.json and counts files
  // on disk. `compat/app.py` routes `--resume_session` before any engine
  // resolution, so passing an engine would only decide which multi-gigabyte
  // environment to start a filesystem scan in — which is why buildNarratorSpawn
  // REFUSES one on this phase rather than ignoring it.
  const plan = buildNarratorSpawn({
    phase: 'resume',
    args: ['--headless', '--resume_session', sessionPath],
    envExtras: {},
    cwdHint: getDefaultE2aPath(),
  });

  console.log('[PARALLEL-TTS] Checking resume status:', sessionPath, '→', plan.describe());

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const resumeCheckProcess = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
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
          // THE RESULT IS PRETTY-PRINTED, so it is not on one line.
          //
          // This used to walk the lines backwards calling JSON.parse on each and
          // taking the first that parsed with a `success` key. Against
          // `json.dumps(result, indent=2)` — which is what both e2a's app.py:278
          // and narrator's `_print_app_result` write — NO line is valid JSON on
          // its own, so the loop always fell through to "Failed to parse resume
          // check output". `lastJsonObject` scans for a brace-balanced object
          // instead, which reads either shape.
          const parsed = lastJsonObject(stdout);
          {
            {
              if (parsed && parsed.success !== undefined) {
                // Map narrator's snake_case to camelCase
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
  const plan = buildNarratorSpawn({
    phase: 'list',
    args: ['--headless', '--list_sessions'],
    envExtras: {},
    cwdHint: getDefaultE2aPath(),
  });

  console.log('[PARALLEL-TTS] Listing resumable sessions');

  return new Promise((resolve) => {
    let stdout = '';

    const listProcess = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
    });

    listProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    listProcess.on('close', () => {
      // IT IS JSON, and it always was. This said "human-readable output (not
      // JSON for --list_sessions)", logged the stdout and resolved `[]` — so the
      // list has been empty for as long as the comment has been wrong.
      // `session_store.list_resumable_sessions` returns a list of dicts and
      // `route_list_sessions` prints `json.dumps(sessions, indent=2)`, exactly as
      // e2a's handlers.py:31-34 did.
      const rows = lastJsonArray(stdout);
      if (!rows) {
        console.warn('[PARALLEL-TTS] list_sessions produced no JSON array:', stdout.slice(0, 400));
        resolve([]);
        return;
      }
      resolve(rows.map((r: any) => ({
        sessionId: r.session_id,
        sessionDir: r.session_dir,
        title: r.title,
        totalSentences: r.total_sentences,
        completedSentences: r.completed_sentences,
        missingSentences: r.missing_sentences,
        progressPercent: r.progress_percent,
        createdAt: r.created_at,
        language: r.language,
        voice: r.voice,
      })));
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
/**
 * IS THERE A PARTIAL RENDER CACHED UNDER THIS PROJECT, and how far did it get?
 *
 * The ONE answer to that question. The queue step's auto-resume (mode 2.5) asks
 * it to decide, and the narration dialog asks it to OFFER — and those two must
 * not be able to disagree, or the dialog says "resume 127 sentences" and the
 * step starts fresh, or worse the reverse.
 *
 * The gate is the step's own: a session that failed to read, one that is already
 * complete, and one with nothing rendered are all "nothing to resume". Language
 * is matched exactly, and a lone session of any language is taken — the same
 * fallback the step uses, because a book usually has one.
 */
export interface CachedRenderSummary {
  sessionDir: string;
  language: string;
  completedSentences: number;
  totalSentences: number;
}

export async function findResumableProjectSession(
  bfpPath: string,
  language?: string,
): Promise<CachedRenderSummary | null> {
  if (!bfpPath) return null;
  try {
    const sessions = await scanProjectSessions(bfpPath);
    if (!sessions.length) return null;
    const wanted = (language || '').toLowerCase();
    const match = sessions.find((s) => s.language.toLowerCase() === wanted)
      ?? (sessions.length === 1 ? sessions[0] : undefined);
    if (!match) return null;
    const check = await checkResumeStatusFromProcessDir(match.sessionDir);
    if (!check.success || check.complete || (check.completedSentences ?? 0) <= 0) return null;
    return {
      sessionDir: match.sessionDir,
      language: match.language,
      completedSentences: check.completedSentences ?? 0,
      totalSentences: check.totalSentences ?? 0,
    };
  } catch (err) {
    getTTSLogger().warn('Cached-render lookup failed', {
      bfpPath, error: (err as Error)?.message || String(err),
    });
    return null;
  }
}

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
      getTTSLogger().info('Resume bound to durable project cache', {
        jobId, bfpPath: config.bfpPath, language: config.settings?.language || 'en',
        completedSentences: fromCache.completedSentences, totalSentences: fromCache.totalSentences,
        processDir: fromCache.processDir,
      });
    } else {
      getTTSLogger().warn('Resume could NOT bind to the project cache — using the persisted resume info', {
        jobId, bfpPath: config.bfpPath, language: config.settings?.language || 'en',
        cacheResult: fromCache ? `success=${fromCache.success}, completed=${fromCache.completedSentences ?? 0}` : 'no cached session',
        persistedProcessDir: resumeInfo.processDir || null,
      });
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
  // Do this BEFORE the complete check so runAssemblyOnly also uses the project folder
  let effectiveOutputDir: string;

  if (config.bfpPath) {
    effectiveOutputDir = getAudiobookDirFromBfp(config.bfpPath);
    await fs.mkdir(effectiveOutputDir, { recursive: true });
    console.log(`[PARALLEL-TTS] Resume: Outputting directly to the project audiobook folder: ${effectiveOutputDir}`);
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
  let resumeMetrics: ChunkTextMetrics = { sentences: [], words: [], chars: [] };
  try {
    const statePath = path.join(resumeInfo.processDir!, 'session-state.json');
    const st = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    resumeMetrics = buildChunkTextMetrics(st.chapter_sentences);
  } catch (err) {
    console.warn(`[PARALLEL-TTS] Resume: could not build raw-sentence counts (sentences/min falls back to estimate): ${err}`);
  }
  const resumeRawCounts = resumeMetrics.sentences;
  const resumeRawSum = resumeRawCounts.reduce((a, b) => a + b, 0);
  const resumeWordSum = resumeMetrics.words.reduce((a, b) => a + b, 0);
  const resumeCharSum = resumeMetrics.chars.reduce((a, b) => a + b, 0);

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
    wordCounts: resumeMetrics.words.length > 0 ? resumeMetrics.words : undefined,
    charCounts: resumeMetrics.chars.length > 0 ? resumeMetrics.chars : undefined,
    totalRawWords: resumeWordSum > 0 ? resumeWordSum : undefined,
    totalRawChars: resumeCharSum > 0 ? resumeCharSum : undefined,
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
    // The session only exists once prep has returned (or, for assembly-only runs,
    // never runs at all), so prep is finished by construction — this is what flips
    // the "Preparing book" bar to complete.
    prepDoneAt: Date.now(),
    cancelled: false,
    assemblyProcess: null,
    // Resume job tracking
    isResumeJob: true,
    baselineCompleted: resumeInfo.completedSentences || 0,
    totalMissing: resumeInfo.missingSentences || 0
  };

  activeSessions.set(jobId, session);

  // Same ownership sidecar as a fresh run — a resume whose sentences are being written
  // into a scratch dir (rather than straight into the cache) must be rescuable too.
  await writeSessionOwner(session);
  getTTSLogger().info('TTS session prepared (resume)', {
    jobId,
    sessionId: prepInfo.sessionId,
    sessionDir: prepInfo.sessionDir,
    bfpPath: config.bfpPath || null,
    language: config.settings?.language || 'en',
    baselineCompleted: session.baselineCompleted,
    missingSentences: session.totalMissing,
    totalSentences: prepInfo.totalSentences,
  });

  // Load persistent state from previous runs
  const existingState = await loadPersistentState(prepInfo.processDir);
  if (existingState) {
    session.persistentState = existingState;
    // The chunk rate is what the resume ETA is priced in; the raw rate (when earlier runs
    // recorded one) is the comparable speed figure, so log both and label them.
    const rawNote = existingState.historicalRawSentencesPerMinute !== undefined
      ? `, ${existingState.historicalRawSentencesPerMinute} real sentences/min avg`
      : '';
    console.log(`[PARALLEL-TTS] Resume: Loaded persistent state - ${existingState.runs.length} previous runs, ${existingState.totalElapsedSeconds}s total elapsed, ${existingState.historicalSentencesPerMinute} chunks/min avg${rawNote}`);
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

    // Emit session-created event so the renderer can log the session
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
  await ensureGuestCanReachSession(session);
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

  // Same as the fresh path. On a resume the already-rendered chapters close almost
  // immediately, and the ones being re-rendered close as their sentences land — the
  // stamp is what keeps a re-rendered sentence from being served from an old close.
  maybeStartChapterCloser(session);

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
    // The session only exists once prep has returned (or, for assembly-only runs,
    // never runs at all), so prep is finished by construction — this is what flips
    // the "Preparing book" bar to complete.
    prepDoneAt: Date.now(),
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
  findResumableProjectSession,
  checkResumeStatusFromProcessDir,
  listResumableSessions,
  resumeParallelConversion,
  buildResumeInfo,
  // Temp folder management
  getTempOutputDir,
  cleanupStaleTempFolders,
  rescueOrphanedScratchSessions,
  // Session caching
  cacheSessionToBfp,
  getAudiobookDirFromBfp,
};

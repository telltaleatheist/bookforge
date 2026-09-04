/**
 * Orpheus Worker Pool — single-process streaming engine for the Listen feature.
 *
 * The Orpheus counterpart to xtts-worker-pool.ts, exposing the SAME StreamingEngine
 * surface (start/load/generate/stream/cancel/end + state/voice accessors) so the
 * stream-scheduler and TTS API server drive it identically. Differences from XTTS:
 *
 *   - ONE worker, always. Orpheus uses vLLM (CUDA) or MLX (Apple Silicon), both of
 *     which saturate the single GPU and have built-in batching — extra processes
 *     just duplicate the ~6 GB model and fight over the device. So no device probe,
 *     no multi-worker topology; getWorkerCount() is 1 once ready.
 *   - The worker (orpheus_stream.py) is spawned EXACTLY like a batch Orpheus job:
 *     natively via the resolved Orpheus conda env on Mac/Linux (and Windows when the
 *     WSL toggle is off), or through `wsl.exe … conda run -n <orpheus_tts> python`
 *     on Windows when "WSL2 for Orpheus" is enabled (vLLM CUDA graphs need Linux).
 *     "If Orpheus audiobooks work on this machine, Orpheus listen works."
 *   - Voice switching is free: Orpheus encodes the voice as a prompt prefix, so the
 *     model loads once and load(voice) only changes that prefix.
 *
 * Requests are serialized onto the single worker via a small FIFO (priority tier for
 * the playing session, normal tier for read-ahead) so two concurrent sessions never
 * clobber the one stdin pipe.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import {
  getDefaultE2aPath,
  getPythonInvocation,
  buildCondaSpawnEnv,
  toUnpackedPath,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  windowsToWslPath,
} from './e2a-paths';
import { computeSafeGpuUtil, getGpuMemMB } from './gpu-arbiter';
import { orpheusMemoryProfile, resolveConcreteOrpheusTier, fitOrpheusTier } from './orpheus-memory';
import {
  PlaySettings,
  AudioChunk,
  StreamChunk,
  StreamResult,
  StreamWorkerConfig,
  EngineState,
  LoadVoiceOptions,
} from './xtts-worker-pool';
import {
  resolveOrpheusModel,
  listOrpheusModels,
  orpheusVoiceCapsForModel,
  resolveOrpheusStockBase,
} from './orpheus-models';
import { destroyWslGuestProcesses, waitForGuestExit, isWslWedged, wslWedgedMessage } from './wsl-lifecycle';
import { getIdleTimeoutMs } from './stream-idle';

const E2A_PATH = getDefaultE2aPath();

// Orpheus's built-in voices (the model is voice-conditioned by a prompt prefix).
// leah has the best quality; tara has echo artifacts. Mirrors VALID_VOICES in
// e2a's orpheus.py / orpheus_stream.py. Folder-discovered custom voices
// (orpheus-models.ts) are appended at runtime by getAvailableVoices(); selecting
// one sends its model dir to the worker (orpheus_stream.py now accepts it).
const ORPHEUS_VOICES = ['leah', 'tara', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'];
const ORPHEUS_DEFAULT_VOICE = 'leah';

/**
 * Translate a model dir into the path the worker process will see. The
 * streaming worker runs in WSL on Windows when the Orpheus WSL toggle is on, so its
 * args must be WSL paths: a \\wsl$\<distro>\… dir maps to its native /home/… path
 * (fast ext4), a C:\… dir maps to /mnt/c/…. Native (Mac/Linux) spawns are untouched.
 * Mirrors the batch bridge's isWslUncPath/uncToWslPath + windowsToWslPath.
 *
 * Applies to EVERY dir that crosses to the worker — a merged model dir, an adapter
 * dir and the shared base dir alike. An untranslated base would leave the engine
 * looking for Windows weights from inside the guest.
 */
function translateModelDirForSpawn(dir: string): string {
  if (!(process.platform === 'win32' && shouldUseWsl2ForOrpheus())) return dir;
  const norm = dir.replace(/\\/g, '/');
  const unc = norm.match(/^\/\/wsl[$.](?:localhost)?\/[^/]+\/(.*)/);
  if (unc) return '/' + unc[1];
  return windowsToWslPath(dir);
}

// Streaming batch width (Listen / extension). FIXED, and now WIDE — measured on an
// M1 Ultra 64 GB (deathstalker, ~135-char sentences ≈ 7.5s of audio each), driving
// this exact worker:
//
//     width   steady-state realtime factor (audio seconds / wall second)
//       4                 0.84x      <- LOSES to playback
//       8                 1.53x
//      12                 2.15x
//      16                 2.80x
//
// The physics behind the table: a row decodes at ~17-20 steps/s NO MATTER how wide
// the batch is, so one batch takes ~30-43s of wall clock at ANY width. Width buys
// aggregate throughput, not latency — a batch of 4 and a batch of 16 finish at
// roughly the same moment, the 16 just carries 4x the audio. That makes narrow the
// worst of both worlds: the same wait, a quarter of the cushion.
//
// 4 was chosen when we believed a small batch's first item "pops out fast" and that
// MLX needed one narrow warmed graph. Both were wrong. At 0.84x, generation runs
// SLOWER than playback, so every listening session was guaranteed to stall the
// moment the playhead caught the generator — the mid-block gap this whole redesign
// chased. And mlx-lm 0.31.3 right-pads batch prefills, so a shape it hasn't seen
// compiles lazily (~10s, once) instead of corrupting rows; the worker now pre-warms
// only width 1 and this full width (orpheus_stream.py::_warmup).
//
// Passed to the worker as ORPHEUS_STREAM_BATCH (grouping cap + warmup shape); also
// reported as deviceWorkers so the extension read-ahead dispatches this many blocks
// concurrently, which is what keeps a 16-wide batch actually full.
// The CEILING a streaming batch ramps up to — not the width every batch runs at.
//
// MLX throughput is bought almost entirely with width, and 16 is the SLOWEST point of
// the measured curve: 12.4 sent/min at 16, 22.8 at 48, 27-29 at 96 (M1 Ultra, the same
// curve MLX_TIERS is built on; the rep-window fix lifts the whole thing to ~35-42).
// Pinning the resident stream server at 16 while the audiobook path ran the tier's 96
// is why read-ahead could not stay ahead of playback. On darwin the ceiling is now the
// machine's own MLX tier width; every other backend keeps 16, which is where it was
// measured. The engine narrows further on its own when a batch is deep (orpheus.py
// _mlx_batch_groups / _mlx_width_for_depth against ORPHEUS_MLX_MEM_BUDGET_GB), so this
// is a ceiling to ask for, never a promise to allocate.
const STREAM_BATCH_CEILING_DEFAULT = 16;
let streamBatchCeilingCache: number | null = null;

function streamBatchCeiling(): number {
  if (streamBatchCeilingCache !== null) return streamBatchCeilingCache;
  let ceiling = STREAM_BATCH_CEILING_DEFAULT;
  if (process.platform === 'darwin') {
    try {
      ceiling = Math.max(
        STREAM_BATCH_CEILING_DEFAULT,
        orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).batchSize,
      );
    } catch {
      // Tier resolution reads config/electron state; if it is not ready yet, the
      // measured-safe 16 is the right answer and the next call re-resolves.
      return STREAM_BATCH_CEILING_DEFAULT;
    }
  }
  streamBatchCeilingCache = ceiling;
  return ceiling;
}

// ─── Batch width ─────────────────────────────────────────────────────────────
//
// EVERY streaming batch goes out at STREAM_RAMP_WIDTH. Flat — not a ramp, and
// deliberately not the ceiling.
//
// Width buys throughput (12.7 chars/sec at 1 row, 30-33 at 8, 41.8 at 32 — measured
// 2026-08-31, M1 Ultra, deathstalker, MLX), so widening looks free. It is not, because
// a batch is ATOMIC to the listener: nothing in it can be played until it retires, and
// its WALL CLOCK grows with width just as fast as its output does.
//
//     width  8 -> ~48s wall, ~75s of audio     (1.57x speech)
//     width 16 -> ~83s wall, ~150s of audio    (1.80x speech)
//     width 32 -> ~150s wall
//
// The buffer must cover the wall clock of the batch being generated. At width 8 the
// buffer grows by ~27s per batch and every batch is ~48s, so it can never be caught.
// Doubling toward the ceiling breaks that: a ~150s batch against a ~75s buffer starves
// it, and playback stops dead mid-article until the whole batch lands at once — which
// is exactly what a doubling ladder (8 -> 16 -> 32 -> ...) did on its first real
// article, about halfway through. More total throughput, delivered too late to hear.
//
// So the useful width is the SMALLEST one that clearly beats speech rate, and 8 is it:
// 1.57x is enough for the buffer to run away from the playhead, and the batch is short
// enough to always land before the listener reaches it. The ceiling below is NOT a
// batch width — it is how deep the queue is allowed to get (see getMaxConcurrentSentences),
// which is what keeps every one of these batches full.
function batchWidth(): number {
  return Math.min(STREAM_RAMP_WIDTH, streamBatchCeiling());
}

// The FIRST dispatch wave of a session that is being listened to right now goes out
// this wide instead of the full width, and only that one (stream-scheduler.ts pump).
// Everything after it — and every background read-ahead session, where full batches
// are the entire point — ramps up toward streamBatchCeiling().
//
// The trade is cushion against how long the listener stares at a spinner. A batch's
// wall clock is roughly flat in width but not perfectly: 8 rows land ~60s of audio in
// ~28s, where 16 rows land ~120s in ~40s. The client's gate opens once the buffer
// covers the projected next silence, so the narrower first burst opens it ~15s
// sooner, and the ~60s it opens on still covers the FOLLOWING full-width batch's ~40s
// of silence with ~20s to spare. 6 would open marginally sooner and leave that
// second-batch cover too thin; 16 buys cushion nobody is awake to enjoy.
//
// Passed to the worker as ORPHEUS_STREAM_RAMP so _warmup pre-compiles this width too
// (an unwarmed width lazily compiles ~10s, once — which is precisely the 10s this
// ramp exists to avoid paying in front of the first sentence).
export const STREAM_RAMP_WIDTH = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Worker process state
// ─────────────────────────────────────────────────────────────────────────────

interface OrpheusResponse {
  type: 'ready' | 'status' | 'loaded' | 'audio' | 'chunk' | 'done' | 'error' | 'stopped'
      | 'batch_item' | 'batch_chunk' | 'batch_done';
  device?: string;
  /** e2a's detected backend, on 'ready' (probe) and 'loaded' (the built engine). */
  backend?: string;
  voice?: string;
  message?: string;
  data?: string;
  duration?: number;
  sampleRate?: number;
  seq?: number;
  chunks?: number;
  cancelled?: boolean;
  /** batch_item / batch_chunk: the caller-supplied index of this item in the batch */
  i?: number;
  /** batch_item: this row's audio ALREADY went out as batch_chunks (fast start), so
   *  the item carries no `data` — only the totals. See BatchItem.onChunk. */
  streamed?: boolean;
  /** batch_done: how many items the batch contained */
  count?: number;
}

/** A batch row's result. `streamed` rows carry no `audio`: every byte of it was
 *  already delivered through the row's onChunk while it generated (fast start), and
 *  `duration` is the total the worker sent. */
type GenResult = {
  success: boolean;
  audio?: AudioChunk;
  streamed?: boolean;
  duration?: number;
  error?: string;
};

interface PendingRequest {
  resolve: (result: GenResult) => void;
  sentenceIndex: number;
  onChunk?: (chunk: StreamChunk) => void;
  resolveStream?: (result: StreamResult) => void;
}

/** An in-flight batch: each item's index maps to the resolver of its
 *  generateSentence() promise. */
interface PendingBatch {
  resolvers: Map<number, (r: GenResult) => void>;
  timeout: NodeJS.Timeout;
  /** Where a row's fast-start chunks go, by the same index — present only for rows
   *  that asked to stream (BatchItem.onChunk). A 'batch_chunk' whose index has no
   *  sink is a protocol break, not a race to swallow: the worker only streams rows
   *  the pool marked `stream:true`. */
  chunkSinks: Map<number, (chunk: StreamChunk) => void>;
  /** Each row's staleness predicate, by the same index. Kept for the life of the
   *  batch so a preempt can ask whether EVERY row is now dead — which is the only
   *  condition under which the batch may be cancelled (see
   *  cancelPendingBatchIfStale). Rows that never supplied one count as live. */
  cancels: Map<number, () => boolean>;
  /** A 'cancel' has already gone out for this batch; don't send a second one. */
  cancelSent?: boolean;
}

interface Worker {
  process: ChildProcess;
  isReady: boolean;
  /** Single-op slot for load + the streamed first sentence (worker is serial). */
  pendingRequest: PendingRequest | null;
  /** Batched generate in flight (read-ahead sentences). */
  pendingBatch: PendingBatch | null;
  /** Set when a stream/batch generation TIMED OUT while the serial worker was
   *  still rendering. While tainted the worker takes no new work — dispatching
   *  would cross-wire the late results onto the next request/batch (a stale
   *  batch_item {i:0} would resolve index 0 of the NEXT batch). Cleared when
   *  the stale request's terminal message (done/audio/error/batch_done)
   *  arrives and is discarded. */
  tainted?: boolean;
}

let worker: Worker | null = null;
let mainWindow: BrowserWindow | null = null;
let currentVoice: string | null = null;
let lastVoice: string | null = null;
let detectedDevice: 'cuda' | 'mlx' | 'cpu' | null = null;

// ── The worker's BACKEND ─────────────────────────────────────────────────────
// e2a's own detected backend, reported by the worker on 'ready' (a probe, before any
// model loads) and again on 'loaded' (ground truth from the engine it just built).
// null = not reported / unknown.
//
// This is a CORRECTNESS gate, not a status field. Everything the adapter migration
// added — per-request voices, mixed-voice batches, serving stock voices from the
// local base — is vLLM-only: multi-LoRA is a vLLM feature, and MLX builds one sampler
// per batch bucket from the engine's own caps, so even a stock per-row prompt token
// would carry another voice's tuning. Deriving it from process.platform would be a
// second implementation of e2a's _detect_backend, free to drift from the first (an
// ORPHEUS_BACKEND override, a Linux box with no vLLM installed); asking the process
// that will actually render cannot drift.
//
// Unknown is NOT a waiver: every consumer treats null as "not vLLM".
type OrpheusBackend = 'vllm' | 'mlx' | 'transformers';
let workerBackend: OrpheusBackend | null = null;

function noteBackend(reported: string | undefined): void {
  if (reported === 'vllm' || reported === 'mlx' || reported === 'transformers') {
    if (workerBackend !== reported) console.log(`[Orpheus Pool] Backend: ${reported}`);
    workerBackend = reported;
  }
}

// ── Per-request voices ───────────────────────────────────────────────────────
// The worker holds ONE engine but can serve several voices from it: built-ins are a
// prompt prefix, and LoRA-adapter voices are a per-request LoRARequest over a shared
// base. So a generate item may name a voice other than the one loaded last, and two
// clients on different voices no longer have to evict each other.
//
// The engine's identity is (merged model dir, shared base dir) — exactly e2a's own
// engine cache key. A load that keeps that pair keeps the engine (adapter↔adapter on
// one base, built-in↔built-in); a load that changes it rebuilds. `loadedEngineKey`
// is what the worker currently holds, so a load can tell "register a voice on a warm
// engine" (seconds) from "construct an engine" (minutes) and time out accordingly.
let loadedEngineKey: string | null = null;
// Voice id -> the PROMPT TOKEN the worker knows it by (they differ whenever a
// catalog entry declares a token), for every voice loaded against the live engine.
// Cleared whenever the engine is (worker death, endSession, engine rebuild) — an
// entry that outlived its engine would let a per-request voice be accepted and
// rendered by weights that never knew it.
const voiceTokens = new Map<string, string>();

function forgetEngineVoices(): void {
  loadedEngineKey = null;
  voiceTokens.clear();
}

// ── The load in flight ───────────────────────────────────────────────────────
// The `currentVoice === v` short-circuit at the top of loadVoice only fires once a
// load has RESOLVED, and a load is a worker round-trip on a serial worker. The
// extension answers a voice switch with a burst of speaks — one per read-ahead block
// — and every one of them calls ensureEngine → loadVoice before the first has come
// back, so the same voice was loaded once per block: N round-trips queued nose to
// tail, each one delaying the speak behind it (the API server awaits ITS load before
// starting ITS session). The user's log showed 'Voice loaded: deathstalker' printed
// once per prefetch block.
//
// So a load for a voice already loading JOINS that load instead of queueing another:
// N concurrent speaks for one voice cost exactly one round-trip. A load for a
// DIFFERENT voice still proceeds and still serializes on the worker — two voices are
// two engines' worth of intent, and collapsing them would be the wrong narrator.
let inFlightLoad:
  | { voice: string; engineKey: string; promise: Promise<{ success: boolean; error?: string }> }
  | null = null;

/**
 * Forget ONE voice's registration, so its next use re-sends a full load.
 *
 * Called when a voice's files change under the running engine — an install or
 * re-install from the catalog, or a removal. The engine itself is untouched (it still
 * holds the same base and every other voice), but this voice's bookkeeping is no
 * longer trustworthy: without this, loadVoice short-circuits on `currentVoice === v`
 * and resolveRequestVoice keeps stamping the cached token, so a RETRAINED voice would
 * be served by the engine's cached copy of the previous training run for the rest of
 * the session — audio that sounds finished and is a model old.
 *
 * Dropping the token is what forces the re-load; the re-load is what makes the worker
 * re-fingerprint the adapter and mint a fresh lora id (e2a `_register_lora`).
 */
export function forgetVoice(id: string): void {
  const v = (id || '').toLowerCase();
  if (!v) return;
  const had = voiceTokens.delete(v);
  const wasCurrent = currentVoice === v;
  if (wasCurrent) currentVoice = null;
  if (had || wasCurrent) {
    console.log(`[Orpheus Pool] Forgetting voice '${v}' — its files changed, so the next use re-loads it`);
    broadcastServiceState();
  }
}

let startingSession = false;
// True while endSession() is deliberately killing the worker, so the close
// handler doesn't ALSO fire the crash-path state broadcast (double event).
let endingSession = false;
let startSessionPromise: Promise<{ success: boolean; voices?: string[]; error?: string }> | null = null;

let serviceMode = false;

// Idle shutdown: kill the worker if nothing was generated for a while (and not
// pinned as a resident service). Frees ~6 GB of VRAM the vLLM engine holds. The
// window is a user setting (stream-idle.ts) — read per sweep so a change applies
// to the running engine without a restart.
let lastActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast helpers (same channels XTTS uses so the existing UI just works)
// ─────────────────────────────────────────────────────────────────────────────

function broadcast(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  }
}

type EngineStateListener = (state: EngineState, isServiceMode: boolean) => void;
const engineStateListeners = new Set<EngineStateListener>();

export function onEngineState(listener: EngineStateListener): () => void {
  engineStateListeners.add(listener);
  return () => engineStateListeners.delete(listener);
}

function broadcastServiceState(): void {
  broadcast('tts-service:state', { state: getEngineState(), serviceMode });
  for (const listener of engineStateListeners) {
    try {
      listener(getEngineState(), serviceMode);
    } catch (err) {
      console.error('[Orpheus Pool] Engine state listener failed:', err);
    }
  }
}

let warmupPct = 0;
function warmupPctFor(message?: string): number | null {
  if (!message) return null;
  if (message.includes('Loading Orpheus model')) return 15;
  if (message === 'Model loaded') return 55;
  // The warmup generations (first-load only) are the slow tail before truly ready.
  if (message.includes('Warming up')) return 70;
  if (message === 'Warmup complete') return 95;
  if (message.startsWith('Voice loaded')) return 100;
  return null;
}
function reportWarmup(message?: string): void {
  const pct = warmupPctFor(message);
  if (pct === null || pct < warmupPct) return;
  warmupPct = pct;
  broadcast('tts-service:warmup', { pct, message });
}

function touchActivity(): void {
  lastActivityAt = Date.now();
}
function startIdleWatch(): void {
  stopIdleWatch();
  touchActivity();
  idleTimer = setInterval(() => {
    const timeoutMs = getIdleTimeoutMs();
    if (timeoutMs === null) return; // set to never
    if (isSessionActive() && Date.now() - lastActivityAt > timeoutMs) {
      const minutes = Math.round(timeoutMs / 60000);
      // Service mode is not exempt: the weights come down either way. It just
      // PARKS — the service stays armed and the next speak cold-starts a worker.
      if (serviceMode) {
        console.log(`[Orpheus Pool] Idle for ${minutes} min — parking the engine (service stays armed)`);
        void endSession({ keepServiceArmed: true });
      } else {
        console.log(`[Orpheus Pool] Idle for ${minutes} min — shutting down`);
        void endSession();
      }
    }
  }, 60_000);
  idleTimer.unref?.();
}
function stopIdleWatch(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine state
// ─────────────────────────────────────────────────────────────────────────────

export type { EngineState };

export function getEngineState(): EngineState {
  if (startingSession) return 'starting';
  if (!isSessionActive()) return 'stopped';
  // The Python process reports 'ready' before the heavy model load; only after a
  // voice is actually warm (currentVoice set) is the engine 'running'.
  return currentVoice ? 'running' : 'warming';
}

export function isServiceMode(): boolean {
  return serviceMode;
}
export function setServiceMode(on: boolean): void {
  if (serviceMode === on) return;
  serviceMode = on;
  broadcastServiceState();
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
  void mainWindow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn (native or WSL) — mirrors batch Orpheus exactly
// ─────────────────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveScriptPath(): string {
  const appPath = app.getAppPath();
  let scriptPath = path.join(appPath, 'electron', 'scripts', 'orpheus_stream.py');
  if (!fs.existsSync(scriptPath)) {
    scriptPath = path.join(__dirname, '..', '..', 'electron', 'scripts', 'orpheus_stream.py');
  }
  if (!fs.existsSync(scriptPath)) {
    scriptPath = path.join(__dirname, 'scripts', 'orpheus_stream.py');
  }
  // Packaged: redirect from inside app.asar to the asarUnpack'd real file.
  return toUnpackedPath(scriptPath);
}

interface SpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  viaWsl: boolean;
}

/** Build the spawn for the persistent Orpheus worker. `gpuUtil`, when set, is the
 *  free-VRAM-sized vLLM gpu_memory_utilization (see doStartSession) — forwarded so the
 *  Listen server can't over-commit a shared desktop GPU into a WDDM spill / freeze. */
function buildSpawnPlan(scriptPath: string, gpuUtil?: number): SpawnPlan {
  const utilExport = gpuUtil ? ` ORPHEUS_GPU_MEM_UTIL=${shellQuote(String(gpuUtil))}` : '';
  if (process.platform === 'win32' && shouldUseWsl2ForOrpheus()) {
    // WSL: run orpheus_stream.py inside the WSL orpheus_tts conda env. The script
    // lives in the BookForge app on the Windows side, so it's reached via /mnt/c;
    // its heavy imports come from the WSL env + WSL-native e2a (set via
    // EBOOK2AUDIOBOOK_PATH). ORPHEUS_DISABLE_EAGER=1 turns vLLM CUDA graphs ON in
    // Linux — the whole reason Orpheus uses WSL. (Mirrors parallel-tts-bridge.)
    const distro = getWslDistro();
    const wslConda = getWslCondaPath();
    const wslE2a = getWslE2aPath();
    const orpheusEnv = getWslOrpheusCondaEnv();
    const scriptWsl = windowsToWslPath(scriptPath);
    // VLLM_USE_V1=0: streaming now applies per-request logits processors (the
    // EOS boost), a V0-only feature — every other Orpheus spawn already pins
    // this; without it a future vLLM bump (V1 default-on) breaks only streaming.
    const exportCmd =
      `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 ORPHEUS_DISABLE_EAGER=1 VLLM_USE_V1=0${utilExport} ` +
      `ORPHEUS_STREAM_BATCH=${streamBatchCeiling()} ORPHEUS_STREAM_RAMP=${STREAM_RAMP_WIDTH} ` +
      `ORPHEUS_STREAM_WARM_MAX=${STREAM_BATCH_CEILING_DEFAULT} ` +
      `EBOOK2AUDIOBOOK_PATH=${shellQuote(wslE2a)}`;
    const cd = `cd ${shellQuote(wslE2a)}`;
    const run =
      `${shellQuote(wslConda)} run --no-capture-output -n ${shellQuote(orpheusEnv)} ` +
      `python -u ${shellQuote(scriptWsl)}`;
    const bash = `${exportCmd} && ${cd} && ${run}`;
    const wslArgs = distro ? ['-d', distro, 'bash', '-c', bash] : ['bash', '-c', bash];
    return { command: 'wsl.exe', args: wslArgs, env: process.env, cwd: process.cwd(), viaWsl: true };
  }

  // Native: resolve the Orpheus conda env (Mac → e2a/MLX; Windows-no-WSL/Linux →
  // the managed/external Orpheus env). Throws with a clear message if not installed.
  const py = getPythonInvocation(E2A_PATH, 'orpheus');
  return {
    command: py.command,
    args: [...py.args, '-u', scriptPath],
    env: buildCondaSpawnEnv({
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      // Same V0 pin as the WSL arm — streaming's EOS boost is a V0-only feature.
      VLLM_USE_V1: '0',
      EBOOK2AUDIOBOOK_PATH: E2A_PATH,
      ORPHEUS_STREAM_BATCH: String(streamBatchCeiling()),
      // Warm the narrow rungs only. Warming every width measured 176s of a 184s load,
      // and load time is visible on EVERY server start; the ladder's wide rungs are
      // reached behind a buffer many sentences deep, where a one-off ~10s lazy compile
      // is invisible. The ramp width is warmed for the opposite reason — its compile
      // would land in front of the first sentence.
      ORPHEUS_STREAM_WARM_MAX: String(STREAM_BATCH_CEILING_DEFAULT),
      // The scheduler's first-wave width for a playing session — warmed alongside
      // the full width so the ramp doesn't pay a lazy compile it exists to avoid.
      ORPHEUS_STREAM_RAMP: String(STREAM_RAMP_WIDTH),
      // Mac/MLX: bound the MLX freed-buffer cache for the resident stream server
      // (unbounded it balloons to tens of GB and STAYS — worse for a pinned
      // long-lived process than for a batch worker). orpheus.py reads this at
      // engine load → mx.set_cache_limit.
      ...(process.platform === 'darwin'
        ? {
            ORPHEUS_MLX_CACHE_LIMIT_GB: process.env.ORPHEUS_MLX_CACHE_LIMIT_GB?.trim()
              || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).mlxCacheLimitGB),
            // Total unified-memory budget a read-ahead batch may occupy; orpheus.py
            // narrows batch WIDTH from the batch's token depth to stay inside it.
            ORPHEUS_MLX_MEM_BUDGET_GB: process.env.ORPHEUS_MLX_MEM_BUDGET_GB?.trim()
              || String(orpheusMemoryProfile(resolveConcreteOrpheusTier(null, null)).mlxMemBudgetGB),
          }
        : {}),
      ...(gpuUtil ? { ORPHEUS_GPU_MEM_UTIL: String(gpuUtil) } : {}),
    }),
    cwd: E2A_PATH,
    viaWsl: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function startSession(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
  if (worker && worker.isReady && !startingSession) {
    return { success: true, voices: getAvailableVoices() };
  }
  if (startSessionPromise) return startSessionPromise;
  startSessionPromise = doStartSession().finally(() => {
    startSessionPromise = null;
  });
  return startSessionPromise;
}

async function doStartSession(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
  startingSession = true;
  broadcastServiceState();
  try {
    // Never spawn into a wedged WSL VM — it can only deepen the wedge.
    if (process.platform === 'win32' && shouldUseWsl2ForOrpheus() && isWslWedged()) {
      startingSession = false;
      broadcastServiceState();
      return { success: false, error: wslWedgedMessage() };
    }
    // Bound the Listen server to an ABSOLUTE VRAM cap (the memory tier) so it leaves
    // the rest of the card free for the browser/desktop, however empty the GPU looks
    // at start. If the wanted level doesn't fit, step DOWN to the highest one the free
    // VRAM can manage rather than refusing — the reservation is always ≤ free, so it
    // can't over-commit and freeze the machine.
    const mem = await getGpuMemMB();
    const wanted = resolveConcreteOrpheusTier(mem?.freeMB ?? null, mem?.totalMB ?? null);
    // Step down to the highest level the free VRAM can manage instead of refusing.
    const fit = fitOrpheusTier(wanted, mem?.freeMB ?? null, mem?.totalMB ?? null);
    const memProfile = orpheusMemoryProfile(fit.tier);
    const ceiling = Number(process.env.ORPHEUS_GPU_MEM_UTIL) || memProfile.ceiling;
    const sized = await computeSafeGpuUtil(memProfile.capMB, memProfile.marginMB, ceiling);
    const gpuUtil = sized.totalMB !== null ? sized.util : undefined;
    if (gpuUtil) {
      const reserveGB = ((sized.reserveMB ?? 0) / 1024).toFixed(1);
      console.log(`[Orpheus Pool] Memory level '${fit.tier}'${fit.steppedDown ? ' (stepped down)' : ''}: ${sized.freeMB} MB free → reserve ~${reserveGB} GB (gpu_memory_utilization=${gpuUtil})`);
    }

    const result = await startWorker(gpuUtil);
    if (!result.success) {
      startingSession = false;
      await endSession();
      return { success: false, error: result.error };
    }
    startIdleWatch();
    startingSession = false;
    broadcast('play:session-started');
    broadcastServiceState();
    return { success: true, voices: getAvailableVoices() };
  } catch (err) {
    startingSession = false;
    await endSession();
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

function startWorker(gpuUtil?: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let plan: SpawnPlan;
    try {
      plan = buildSpawnPlan(resolveScriptPath(), gpuUtil);
    } catch (err) {
      resolve({ success: false, error: err instanceof Error ? err.message : 'Failed to resolve Orpheus env' });
      return;
    }

    console.log(`[Orpheus Pool] Starting worker${plan.viaWsl ? ' (WSL)' : ''}: ${plan.command}`);
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const w: Worker = { process: child, isReady: false, pendingRequest: null, pendingBatch: null };
    worker = w;

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line: string) => {
        line = line.trim();
        if (!line || !line.startsWith('{')) {
          if (line) console.log('[Orpheus Pool] Non-JSON output:', line.substring(0, 120));
          return;
        }
        try {
          const response: OrpheusResponse = JSON.parse(line);
          handleWorkerResponse(w, response);
          if (response.type === 'ready') {
            w.isReady = true;
            if (response.device === 'cuda' || response.device === 'mlx' || response.device === 'cpu') {
              detectedDevice = response.device;
            }
            noteBackend(response.backend);
            resolve({ success: true });
          }
        } catch (err) {
          console.error('[Orpheus Pool] JSON parse error:', err instanceof Error ? err.message : err);
        }
      });
    }

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) console.log('[Orpheus Pool stderr]', msg);
    });

    child.on('close', (code) => {
      console.log('[Orpheus Pool] Process exited with code:', code);
      if (!w.isReady) resolve({ success: false, error: 'Worker stopped during startup' });
      if (w.pendingRequest) {
        if (w.pendingRequest.resolveStream) w.pendingRequest.resolveStream({ success: false, error: 'Worker died' });
        else w.pendingRequest.resolve({ success: false, error: 'Worker died' });
        w.pendingRequest = null;
      }
      if (w.pendingBatch) {
        clearTimeout(w.pendingBatch.timeout);
        for (const r of w.pendingBatch.resolvers.values()) r({ success: false, error: 'Worker died' });
        w.pendingBatch = null;
      }
      const wasLiveWorker = worker === w;
      if (wasLiveWorker) {
        worker = null;
        // The loaded voice died with the process. Leaving currentVoice set makes
        // the next loadVoice() short-circuit ("already loaded") so the freshly
        // spawned worker never receives a load command — every generation then
        // fails "Model not loaded" until the user switches voices or restarts.
        // (lastVoice is kept: it's only the default-voice hint, not load state.)
        currentVoice = null;
        forgetEngineVoices();
        workerBackend = null;
      }
      drainWaiters();
      failBatchQueue('Worker died');
      // CRASH path (not a deliberate endSession): the single worker just died
      // on its own (OOM, WSL wedge). Without this broadcast the UI keeps
      // showing a running service and the idle watch ticks against no worker.
      if (wasLiveWorker && !endingSession) {
        console.error(`[Orpheus Pool] Worker died unexpectedly (code ${code}) — broadcasting stopped state`);
        stopIdleWatch();
        serviceMode = false;
        currentVoice = null;
        broadcast('play:session-ended', { code: code ?? 1 });
        broadcastServiceState();
      }
    });

    child.on('error', (error) => {
      console.error('[Orpheus Pool] Process error:', error);
      resolve({ success: false, error: error.message });
    });

    // vLLM CUDA-graph capture + ~6 GB weight load is slow on first boot; allow
    // generous time for the 'ready' line (the model itself loads later on load()).
    setTimeout(() => {
      if (!w.isReady) resolve({ success: false, error: 'Orpheus worker timeout' });
    }, 120000);
  });
}

/** What a 'load' for one voice puts on the wire, plus the engine it needs. */
interface LoadPlan {
  /** The catalog id, so the worker can detect two ids claiming one prompt token. */
  id: string;
  /** The PROMPT TOKEN the worker knows the voice by (may differ from the id). */
  token: string;
  modelDir?: string;
  adapterDir?: string;
  baseDir?: string;
  caps: ReturnType<typeof orpheusVoiceCapsForModel>;
  /** The worker's engine identity for this load: (merged dir, base dir). */
  engineKey: string;
}

/**
 * Resolve a voice id into the exact load message and the engine it needs, or throw
 * with the reason it cannot be served.
 *
 * Shared by loadVoice (which sends it) and wouldRebuildEngine (which only wants the
 * key), so the "will this evict the engine?" answer is computed by the same code that
 * decides what to send — two implementations of the key would eventually disagree,
 * and the disagreement would be silent.
 */
function resolveLoadPlan(voice: string): LoadPlan {
  const v = (voice || ORPHEUS_DEFAULT_VOICE).toLowerCase();
  // A folder-discovered custom voice loads its OWN weights — a merged model dir, or
  // an adapter dir over the shared base dir — and uses its verbatim prompt token;
  // built-ins send no model dir (they are a prompt prefix over the base checkpoint).
  // Changing which WEIGHTS are served triggers a reload in the worker; registering
  // another voice over the same base does not (see loadedEngineKey).
  // resolveOrpheusModel THROWS when the \\wsl$ models dir is unreachable (WSL down).
  // 'stream' routes a voice with BOTH artifacts installed through the
  // `orpheusStreamingArtifact` setting — 'merged' by default since 2026-08-10, when the
  // ~10-20% per-token cost of the LoRA path was judged to outweigh the warm voice
  // switch it bought. Set "adapter" in tool-paths.json to get warm switches back; the
  // batch workers always take the merged copy (see OrpheusServePurpose).
  const model = resolveOrpheusModel(v, 'stream');
  // A null model means "not a resolvable custom model folder". That's correct for a
  // built-in voice (loads token-only) or any voice the pool advertises, but for an
  // UNKNOWN id the Python worker's allowlist would silently downgrade it to the
  // default voice (wrong voice, no error). Reject it loudly instead.
  if (!model && !getAvailableVoices().some((a) => a.toLowerCase() === v)) {
    throw new Error(
      `Orpheus voice '${voice}' is not a built-in voice and has no valid model folder under the Orpheus models directory — refusing to silently fall back to the default voice.`
    );
  }
  // An ADAPTER voice sends its adapter dir AND the shared base; a MERGED voice sends
  // the one model dir it is. resolveOrpheusModel guarantees baseDir is present for an
  // adapter (it throws when the base is not installed), so a missing one here would
  // be a contract break — assert rather than send half an adapter, which the worker
  // would (correctly) reject anyway.
  //
  // BACKEND-INDEPENDENT, deliberately. Since stage B2 MLX serves an adapter too (it
  // wraps the resident model's projections instead of taking a per-request
  // LoRARequest), and either way the pair that decides which WEIGHTS are loaded is
  // (modelDir, baseDir). So an adapter voice keys as `|<base>` on every platform and
  // adapter↔adapter is a warm switch on every platform. The only thing still gated on
  // vLLM here is the STOCK baseDir below — and canServeVoicePerRequest, which asks the
  // different question of whether two voices can share one BATCH.
  const isAdapter = model?.artifact === 'adapter';
  if (isAdapter && !model!.baseDir) {
    throw new Error(
      `Orpheus voice '${voice}' resolved as a LoRA adapter with no base model dir — refusing to load an adapter with nothing to apply it to.`
    );
  }
  const modelDir = model && !isAdapter ? translateModelDirForSpawn(model.dir) : undefined;
  const adapterDir = isAdapter ? translateModelDirForSpawn(model!.dir) : undefined;
  // A STOCK voice carries the shared base too, whenever one is installed. Stock voices
  // ARE that checkpoint (e2a loads unsloth/orpheus-3b-0.1-ft for them), so this changes
  // nothing about the audio — it changes the engine's IDENTITY, collapsing stock and
  // adapter onto one key so switching between them is a registration instead of a 6 GB
  // teardown that could also trigger a mid-session HuggingFace download on a cold
  // cache. Gated on the vLLM backend: MLX serves stock from a different repo
  // (mlx-community/…-bf16) and has no LoRA concept, so on Mac this stays undefined and
  // stock keeps the (null, null) key it always had. Same on a machine with no base
  // installed — resolveOrpheusStockBase returns null and nothing changes.
  const baseDir = isAdapter
    ? translateModelDirForSpawn(model!.baseDir!)
    : (!model && workerBackend === 'vllm'
        ? stockBaseDirForSpawn()
        : undefined);
  // Per-voice tuning caps from the SAME catalog the audiobook worker reads
  // (orpheus-models.ts). They cannot ride the spawn env: this worker is RESIDENT
  // and switches voices without respawning, so the caps travel with the load
  // message and the Python side applies them per voice. Without this, streaming
  // ran on e2a's built-in defaults — a fast fine-tune (deathstalker measures
  // ~20.4 ch/s p99, catalogued at 23.5) tripped the 19.0 truncation guard on
  // healthy audio in previews while the book render did not.
  return {
    id: v,
    token: model ? model.voice : v,
    modelDir,
    adapterDir,
    baseDir,
    caps: model ? orpheusVoiceCapsForModel(model) : {},
    engineKey: `${modelDir ?? ''}|${baseDir ?? ''}`,
  };
}

/** The installed shared base, as the WORKER will see the path — or undefined when no
 *  base is installed. Never throws: an unreachable models dir means "no base", which
 *  degrades to the pre-collapse behaviour rather than failing a stock load that has
 *  no need of a base at all. */
function stockBaseDirForSpawn(): string | undefined {
  let base: ReturnType<typeof resolveOrpheusStockBase>;
  try {
    base = resolveOrpheusStockBase();
  } catch (err) {
    console.warn('[Orpheus Pool] Could not resolve the shared Orpheus base for a stock voice — loading stock from the HuggingFace cache:', err instanceof Error ? err.message : err);
    return undefined;
  }
  return base ? translateModelDirForSpawn(base.dir) : undefined;
}

/**
 * Would loading `voice` tear down and rebuild the engine (a ~6 GB load plus CUDA-graph
 * capture), rather than registering a voice on the warm one?
 *
 * False when no engine is loaded yet — there is nothing to evict, so the first load of
 * a session is never "a rebuild" in the sense callers care about (they are guarding
 * OTHER sessions' engines, and there aren't any).
 *
 * Unresolvable voices report false: the load will fail on its own terms with a real
 * reason, and reporting "this would rebuild" for a voice that will never load would
 * turn a clear error into a confusing conflict message.
 */
export function wouldRebuildEngine(voice: string): boolean {
  if (loadedEngineKey === null) return false;
  try {
    return resolveLoadPlan(voice).engineKey !== loadedEngineKey;
  } catch {
    return false;
  }
}

/**
 * Load `voice` on the resident worker.
 *
 * `opts.warm` (default true) decides whether a FIRST load may spend ~40s on the
 * worker's discarded warm-up renders before it reports ready. Every path where no
 * one is waiting on audio — the extension's engine.start prewarm, a settings voice
 * change, the app's own warm-on-start — leaves it true and buys a fully compiled
 * generate path. A load a pending SPEAK triggered passes false: the user is waiting,
 * and the first real batch absorbs the same lazy compile (~10s, once) instead of
 * queueing behind ~40s of audio nobody hears. See LoadVoiceOptions.
 */
export async function loadVoice(
  voice: string,
  opts: LoadVoiceOptions = {}
): Promise<{ success: boolean; error?: string }> {
  if (!worker || !worker.isReady) return { success: false, error: 'No Orpheus worker' };
  touchActivity();

  const v = (voice || ORPHEUS_DEFAULT_VOICE).toLowerCase();
  if (currentVoice === v) return { success: true };
  // Already loading this exact voice — wait on THAT load rather than sending a second
  // one. See inFlightLoad.
  if (inFlightLoad && inFlightLoad.voice === v) {
    console.log(`[Orpheus Pool] Voice '${v}' is already loading — joining that load`);
    return inFlightLoad.promise;
  }

  let plan: LoadPlan;
  try {
    plan = resolveLoadPlan(v);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const loadToken = plan.token;

  // The engine this load needs, as the worker identifies it. Matching what the worker
  // already holds means the load only REGISTERS a voice (adapter registration or a
  // prompt-prefix switch) — seconds, not the minutes an engine construction takes.
  const engineKey = plan.engineKey;
  const warmEngine = loadedEngineKey !== null && loadedEngineKey === engineKey;
  // A construction pays the ~6 GB weight load, CUDA-graph capture and the warmup
  // renders. A registration is a dict write plus a caps update; if THAT hasn't
  // answered in 15s the worker is wedged and pretending otherwise only makes the
  // engine look alive while every request behind it stalls.
  const loadTimeoutMs = warmEngine ? 15000 : 180000;

  // The Python worker is serial: route the load through the same serialization the
  // stream path uses (priority tier) so it never clobbers an in-flight stream's
  // pendingRequest. Inside the job the worker is guaranteed free.
  const loading = runOnWorker<{ success: boolean; error?: string }>(
    (w) =>
      new Promise((resolve) => {
        let resolved = false;
        const finish = (result: { success: boolean; error?: string }) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          w.pendingRequest = null;
          afterWorkerFree(); // let any queued read-ahead / next load flush
          resolve(result);
        };
        const timeout = setTimeout(
          () => {
            // A timed-out load leaves the worker in an UNKNOWN state, and the
            // per-request-voice contract makes stale bookkeeping fatal rather than
            // merely untidy: leaving currentVoice set would short-circuit the next
            // loadVoice ("already loaded"), so nothing would ever re-send the load,
            // while resolveRequestVoice happily stamped the token onto every item and
            // _row_voice rejected it — every sentence failing forever, with no way
            // back short of restarting the engine. So forget what we thought was
            // loaded, exactly as the failure branch below does.
            forgetEngineVoices();
            currentVoice = null;
            // The worker may still be INSIDE that load. Taint it: a late 'loaded'
            // would otherwise resolve the NEXT load early (both match on
            // sentenceIndex === -1), reporting a voice as ready that the worker never
            // registered. handleWorkerResponse clears the taint when the stale
            // terminal message arrives and is discarded.
            w.tainted = true;
            broadcastServiceState();
            finish({ success: false, error: 'Orpheus voice load timeout' });
          },
          loadTimeoutMs
        );
        // Only a load that will CONSTRUCT an engine has a warmup to report. A warm
        // registration returns in well under a second, and zeroing the meter for it
        // made the UI drop from 100% to 0 and back for a voice switch that never
        // touched the model.
        if (!warmEngine) warmupPct = 0;
        w.pendingRequest = {
          sentenceIndex: -1,
          resolve: (result) => {
            if (result.success || result.audio) {
              // A load that changed the engine invalidated every voice registered
              // against the old one — the worker cleared its own set on teardown, so
              // mirror that here or a stale id would be forwarded as a per-request
              // voice the engine cannot serve.
              if (!warmEngine) voiceTokens.clear();
              loadedEngineKey = engineKey;
              voiceTokens.set(v, loadToken);
              currentVoice = v;
              lastVoice = v;
              warmupPct = 100;
              broadcast('tts-service:warmup', { pct: 100, message: 'Ready' });
              broadcastServiceState();
              finish({ success: true });
            } else {
              // A failed load leaves the worker's engine in an unknown state — a
              // validation rejection changed nothing, but a failure DURING a switch
              // tore the old engine down first. Forget what we thought was loaded
              // rather than guess: the cost is one full reload, the cost of guessing
              // wrong is a per-request voice served by an engine that no longer has
              // it. currentVoice goes too, so the next loadVoice actually SENDS a
              // load instead of short-circuiting on a voice we can no longer prove is
              // there — which would otherwise fail every sentence forever, because
              // nothing would ever re-register it.
              forgetEngineVoices();
              currentVoice = null;
              broadcastServiceState();
              finish({ success: false, error: result.error });
            }
          },
        };
        send({
          action: 'load',
          // The catalog id rides alongside the token so the worker can refuse a load
          // whose token another id already claimed (they collapse to one slot there).
          id: plan.id,
          voice: loadToken,
          modelDir: plan.modelDir,
          adapterDir: plan.adapterDir,
          baseDir: plan.baseDir,
          caps: plan.caps,
          // Only a FIRST load has a warmup to skip; the worker ignores this on a
          // registration. Sent explicitly on every load so the worker never has to
          // infer intent from an absent field.
          warm: opts.warm !== false,
        });
      }),
    () => ({ success: false, error: 'No Orpheus worker' }),
    true
  );

  // Published only for the window this load is actually in flight — including while
  // it merely SITS in the worker's priority queue, which is most of the window that
  // matters. Cleared on settle (success, failure, timeout, worker death: every one of
  // those resolves the promise), and only if this record is still the current one, so
  // a load for another voice that started meanwhile isn't cleared by ours.
  const record = { voice: v, engineKey, promise: loading };
  inFlightLoad = record;
  void loading.finally(() => {
    if (inFlightLoad === record) inFlightLoad = null;
  });
  return loading;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-worker request serialization (priority tier first, FIFO within a tier)
// ─────────────────────────────────────────────────────────────────────────────

interface Waiter {
  run: (w: Worker | null) => void;
  isCancelled?: () => boolean;
}
const priorityWaiters: Waiter[] = [];
const normalWaiters: Waiter[] = [];

/** The single worker is busy when it has a load/stream op OR a batch in flight
 *  (the Python process handles one request at a time). */
function workerBusy(): boolean {
  // tainted = a timed-out generation is still rendering inside the serial
  // worker; new work would cross-wire its late results onto the new request.
  return !!worker && (!!worker.pendingRequest || !!worker.pendingBatch || !!worker.tainted);
}

function workerFree(): boolean {
  return !!worker && worker.isReady && !workerBusy();
}

/** Called whenever the worker frees (load/stream/batch completed). Runs queued
 *  stream/load waiters FIRST (the playing sentence has priority), then flushes the
 *  batched read-ahead queue onto whatever capacity remains. */
function afterWorkerFree(): void {
  // Completing work IS activity. Without this, a caller that enqueues a large text in
  // one shot (the headless CLI does; Listen paces requests so it never noticed) makes
  // no NEW calls for >10 min and the idle sweep killed the session MID-render.
  touchActivity();
  releaseSlot();
  scheduleBatchFlush();
}

function releaseSlot(): void {
  while (workerFree()) {
    const waiter = priorityWaiters.shift() ?? normalWaiters.shift();
    if (!waiter) return;
    if (waiter.isCancelled?.()) {
      waiter.run(null);
      continue;
    }
    waiter.run(worker);
    return; // job reserved the worker synchronously
  }
}

function drainWaiters(): void {
  while (priorityWaiters.length) priorityWaiters.shift()!.run(null);
  while (normalWaiters.length) normalWaiters.shift()!.run(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched read-ahead: coalesce queued generateSentence() calls into one vLLM/MLX
// generate_batch request. The streamed opening sentences and voice-load stay on
// the single-op path above; everything else (lookahead + background prefetch) flows
// through here so a whole article converts at batch throughput, not one-at-a-time.
// ─────────────────────────────────────────────────────────────────────────────

interface BatchItem {
  text: string;
  resolve: (r: GenResult) => void;
  isCancelled?: () => boolean;
  priority: boolean;
  /** The worker-side PROMPT TOKEN this sentence must be rendered in, set only when
   *  it differs from the loaded voice. Undefined = the loaded voice, which keeps the
   *  wire message byte-identical to the single-voice case. */
  voice?: string;
  /** FAST START (Owen 2026-09-04). Present when the caller wants this sentence's
   *  audio delivered in sub-sentence chunks WHILE IT GENERATES rather than as one
   *  payload when the batch retires. Its presence is what puts `stream:true` on the
   *  wire item; absent, the item is byte-identical to what it always was, which is
   *  what keeps the extension's "Buffer before playing" switch a no-change path. */
  onChunk?: (chunk: StreamChunk) => void;
}
const batchQueue: BatchItem[] = [];
let flushScheduled = false;

function enqueueBatchItem(item: BatchItem): void {
  batchQueue.push(item);
  scheduleBatchFlush();
}

/** How long a scheduled flush waits before it fires. See scheduleBatchFlush. */
const FLUSH_GRACE_MS = 25;

/** Defer the flush so all sentences the scheduler dispatches in one synchronous pump
 *  are collected into the same batch.
 *
 *  It must be a MACROTASK, not a microtask. The queue is refilled from PROMISE
 *  CONTINUATIONS, and a microtask flush runs before them: when a streamed (solo)
 *  sentence finishes, streamOnWorker's resolveStream calls afterWorkerFree() —
 *  queueing the flush — and only THEN resolves its promise, which queues the
 *  scheduler's .then(pump) continuation behind it. pump() is what dispatches the next
 *  sentences into batchQueue, so a microtask flush fired one microtask EARLY, on a
 *  queue that was still one item short: every streaming batch went out at
 *  one row short of the width it meant to send. A macrotask runs after ALL pending microtasks — including
 *  every .then(pump) refill — so the flush sees the fully refilled queue.
 *
 *  It waits FLUSH_GRACE_MS rather than 0 because on a WARM engine the sessions do not
 *  all exist yet when the first one pumps: the extension sends the playing speak and
 *  its read-ahead speaks as SEPARATE WebSocket messages a few ms apart, each landing in
 *  its own macrotask. A 0 ms flush races them and ships the playing session's ramp
 *  alone, and a ramp-fill row that misses the ramp flush then waits out the entire ~28s
 *  batch it existed to ride — the gap it was meant to cover. 25 ms is long enough for
 *  those messages to land in the same batch and, against 20-40 s renders, is noise.
 *  (A COLD start needs none of this: every session pre-exists the model load, so they
 *  are all queued long before the first flush can fire.) */
function scheduleBatchFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    flushBatch();
  }, FLUSH_GRACE_MS);
}

function failBatchQueue(error: string): void {
  for (const it of batchQueue.splice(0)) it.resolve({ success: false, error });
}

function flushBatch(): void {
  if (batchQueue.length === 0) return;
  if (!worker || !worker.isReady) {
    failBatchQueue('No workers available');
    return;
  }
  if (workerBusy()) return; // a later afterWorkerFree() will retry

  // Drop cancelled items (resolve them so callers don't hang); keep order stable.
  const live = batchQueue.filter((it) => {
    if (it.isCancelled?.()) {
      it.resolve({ success: false, error: 'cancelled' });
      return false;
    }
    return true;
  });
  batchQueue.length = 0;
  batchQueue.push(...live);
  if (batchQueue.length === 0) return;

  // Priority items (the playing session's lookahead) first; stable within a tier.
  batchQueue.sort((a, b) => (a.priority === b.priority ? 0 : a.priority ? -1 : 1));

  // Items are NOT regrouped by voice. vLLM takes a per-prompt LoRA list, so a batch
  // that mixes voices runs as one call with each row on its own adapter — regrouping
  // would only break the read-ahead's reading order and shrink the batches that pay
  // for themselves by being full.
  // Ramping width (see the batch-width ramp note above): narrow now, wider each
  // flush, so the first word is fast and the pipeline still reaches full throughput.
  const picked = batchQueue.splice(0, batchWidth());
  const resolvers = new Map<number, (r: GenResult) => void>();
  const cancels = new Map<number, () => boolean>();
  const chunkSinks = new Map<number, (chunk: StreamChunk) => void>();
  const items = picked.map((it, i) => {
    resolvers.set(i, it.resolve);
    if (it.isCancelled) cancels.set(i, it.isCancelled);
    // FAST START: a row carrying a chunk sink is marked for the worker. Only the
    // rows that asked stream — a batch mixes the block being listened to with
    // read-ahead behind it, and read-ahead has nobody waiting on its first second.
    if (it.onChunk) chunkSinks.set(i, it.onChunk);
    return {
      i,
      text: it.text,
      ...(it.voice ? { voice: it.voice } : {}),
      ...(it.onChunk ? { stream: true } : {}),
    };
  });

  const timeout = setTimeout(() => {
    if (worker?.pendingBatch?.resolvers === resolvers) {
      for (const r of resolvers.values()) r({ success: false, error: 'Batch generation timeout' });
      // The worker is STILL rendering this batch — taint it so flushBatch/
      // workerFree won't hand it new work until the stale batch's batch_done
      // arrives and is discarded (handleWorkerResponse clears the taint).
      worker.tainted = true;
      worker.pendingBatch = null;
      afterWorkerFree();
    }
  }, 180000);

  worker.pendingBatch = { resolvers, timeout, cancels, chunkSinks };
  send({ action: 'generate_batch', items });
}

/**
 * Free the serial worker when the batch it is rendering has become entirely stale.
 *
 * The worker renders ONE thing at a time and a read-ahead batch is 30-43s deep, so a
 * preempting play — or a voice switch — used to wait out the whole batch before the
 * new voice's load could even be sent, and the results it waited for were discarded
 * on arrival. This tells the worker to stop: un-rendered rows come back as ordinary
 * per-item failures ('cancelled') and 'batch_done' fires as always, so the batch
 * closes through the NORMAL path — its timeout is cleared, nothing is tainted.
 *
 * EVERY remaining row must be stale. One batch mixes sessions (the pool fills it from
 * a single queue, priority first), so a batch cancelled on behalf of one dead session
 * would take a live session's sentences with it — and those sentences would have to be
 * asked for again, which is exactly the cost this exists to avoid. A row that supplied
 * no isCancelled predicate can never be proven dead and therefore counts as live.
 *
 * Called by the scheduler when a session ends, AFTER it is marked stopped and removed
 * from the map — the predicates read that state, so calling earlier proves nothing.
 */
export function cancelPendingBatchIfStale(): void {
  const w = worker;
  const pb = w?.pendingBatch;
  if (!w || !pb || pb.cancelSent) return;
  // No rows left un-emitted: the batch is already ending on its own.
  if (pb.resolvers.size === 0) return;
  for (const idx of pb.resolvers.keys()) {
    const isCancelled = pb.cancels.get(idx);
    if (!isCancelled || !isCancelled()) return;
  }
  pb.cancelSent = true;
  console.log(`[Orpheus Pool] All ${pb.resolvers.size} un-rendered rows of the in-flight batch are stale — cancelling it to free the worker`);
  send({ action: 'cancel' });
}

function runOnWorker<T>(
  job: (w: Worker) => Promise<T>,
  onNoWorker: () => T,
  priority: boolean,
  isCancelled?: () => boolean
): Promise<T> {
  if (workerFree()) return job(worker!);
  if (!worker) return Promise.resolve(onNoWorker());
  return new Promise<T>((resolve) => {
    const run = (w: Worker | null) => {
      if (!w) {
        resolve(onNoWorker());
        return;
      }
      void job(w).then(resolve);
    };
    (priority ? priorityWaiters : normalWaiters).push({ run, isCancelled });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `onChunk` is FAST START (Owen 2026-09-04): give it and this sentence's audio is
 * delivered in sub-sentence chunks as the row generates, and the promise resolves
 * `{success:true, streamed:true, duration}` with NO `audio` — it has all already
 * been handed over. Omit it and nothing about this call changes.
 */
export async function generateSentence(
  text: string,
  _sentenceIndex: number,
  settings: PlaySettings,
  priority = false,
  isCancelled?: () => boolean,
  onChunk?: (chunk: StreamChunk) => void
): Promise<GenResult> {
  touchActivity();
  if (!worker) return { success: false, error: 'No workers available' };
  // The sentence's OWN voice, honoured per request. `settings` used to be discarded
  // here on the grounds that "voice is the warm prefix" — true only while one voice
  // was loaded at a time. Now two clients (or the app plus a client) can hold
  // different voices against one engine, and the last load would otherwise decide
  // what everyone's in-flight sentences sound like.
  const resolved = resolveRequestVoice(settings);
  if (!resolved.ok) return { success: false, error: resolved.error };
  // Coalesced into a vLLM/MLX batch with sibling read-ahead sentences rather than
  // run one-at-a-time. (Sampling is per-voice catalog tuning applied at load, so the
  // remaining per-sentence settings still don't apply to Orpheus.)
  return new Promise<GenResult>((resolve) => {
    enqueueBatchItem({ text, resolve, isCancelled, priority, voice: resolved.voice, onChunk });
  });
}

type VoiceResolution = { ok: true; voice?: string } | { ok: false; error: string };

/**
 * The PROMPT TOKEN a request's `settings.voice` must render in, or a failure when the
 * engine cannot serve it. `{ok: true, voice: undefined}` means the request named no
 * voice and inherits the engine's default — the pre-per-request-voice behaviour.
 *
 * The token is resolved and SENT EXPLICITLY even when it matches the currently
 * loaded voice, rather than being left implicit. "Currently loaded" is evaluated on
 * the worker at RENDER time, and a concurrent load (a second client, the Listen tab)
 * can land between a sentence being queued and its batch going out — so an implicit
 * voice is a race whose losing side is a silently different narrator. Naming it costs
 * a few bytes per item and removes the race entirely.
 *
 * Voices cross the wire as prompt tokens, which a catalog entry may declare
 * differently from its id, and only voices registered against the LIVE engine can be
 * served. An unknown one fails the sentence rather than rendering it in whatever is
 * loaded: the wrong narrator delivered as a success is exactly what this prevents.
 */
function resolveRequestVoice(settings: PlaySettings): VoiceResolution {
  const requested = settings?.voice?.trim().toLowerCase();
  if (!requested) return { ok: true };
  const token = voiceTokens.get(requested);
  if (!token) {
    return {
      ok: false,
      error: `Orpheus voice '${settings.voice}' is not loaded on the streaming engine (loaded: ${[...voiceTokens.keys()].join(', ') || 'none'}) — load it before generating in it.`,
    };
  }
  return { ok: true, voice: token };
}

export async function generateSentenceStream(
  text: string,
  settings: PlaySettings,
  onChunk: (chunk: StreamChunk) => void,
  isCancelled?: () => boolean
): Promise<StreamResult> {
  touchActivity();
  return runOnWorker<StreamResult>(
    (w) => streamOnWorker(w, text, settings, onChunk),
    () => ({ success: false, error: 'No workers available' }),
    true,
    isCancelled
  );
}

function streamOnWorker(
  w: Worker,
  text: string,
  settings: PlaySettings,
  onChunk: (chunk: StreamChunk) => void
): Promise<StreamResult> {
  if (w.pendingRequest) {
    return Promise.resolve({ success: false, error: 'Worker already busy (dispatch bug)' });
  }
  // Same per-request voice contract as generateSentence. (The scheduler never
  // streams on Orpheus — it reports getMaxConcurrentSentences, which routes
  // everything through the batch — but the engine interface exposes this entry
  // point, and it must not be the one place that ignores the requested voice.)
  const resolved = resolveRequestVoice(settings);
  if (!resolved.ok) return Promise.resolve({ success: false, error: resolved.error });
  const voice = resolved.voice;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Still rendering — taint until the stale terminal response is discarded.
      w.tainted = true;
      w.pendingRequest = null;
      afterWorkerFree();
      resolve({ success: false, error: 'Streaming generation timeout' });
    }, 120000);
    w.pendingRequest = {
      sentenceIndex: -2,
      resolve: () => { /* unused for stream */ },
      onChunk,
      resolveStream: (result) => {
        clearTimeout(timeout);
        w.pendingRequest = null;
        afterWorkerFree();
        resolve(result);
      },
    };
    send({ action: 'generate', text, language: 'en', stream: true, ...(voice ? { voice } : {}) });
  });
}

/** Orpheus generation isn't interruptible mid-sentence (vLLM/MLX generate whole);
 *  the scheduler drops stale results. We still send 'cancel' so the worker can
 *  acknowledge and stay in sync. */
export function cancelStreaming(): void {
  if (worker?.pendingRequest?.resolveStream) send({ action: 'cancel' });
}

export function stop(): void {
  if (worker?.isReady) send({ action: 'stop' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Teardown
// ─────────────────────────────────────────────────────────────────────────────

/** Kill the worker and free the weights.
 *
 *  `keepServiceArmed` is idle PARKING: it ends the ENGINE but leaves the service
 *  armed — serviceMode stays true, the TTS API server keeps listening, and the
 *  next speak cold-starts a fresh worker (reloading `lastVoice`). Clients see
 *  state 'stopped' with serviceMode still on, which is exactly what happened. */
export async function endSession(opts?: { keepServiceArmed?: boolean }): Promise<void> {
  console.log('[Orpheus Pool] Ending session...');
  // Suppress the close handler's crash-path broadcast while WE kill the
  // worker — endSession does its own single broadcast at the end.
  endingSession = true;
  stopIdleWatch();
  startingSession = false;
  drainWaiters();
  failBatchQueue('Session ended');
  const w = worker;
  const hadWorker = !!w;
  if (w) {
    // Cooperative first: 'quit' breaks the stdin loop → normal interpreter exit →
    // atexit CUDA cleanup releases the GPU from inside the guest.
    send({ action: 'quit' });
    await killWorkerTree(w);
  }
  worker = null;
  currentVoice = null;
  forgetEngineVoices();
  // The backend is a fact about the PROCESS that just died; the next spawn re-reports
  // it on 'ready'. Keeping a stale 'vllm' would waive the per-request-voice guard for
  // a worker that hasn't said what it is yet.
  workerBackend = null;
  if (!opts?.keepServiceArmed) serviceMode = false;
  if (hadWorker) broadcast('play:session-ended', { code: 0 });
  broadcastServiceState();
  endingSession = false;
}

/** Kill the worker process tree. On Windows+WSL the child is wsl.exe wrapping a
 *  Linux python + vLLM. Teardown discipline (see wsl-lifecycle.ts): wait for the
 *  cooperative 'quit' to land, SIGTERM if it doesn't, escalate to VM terminate for a
 *  survivor — NEVER SIGKILL in the guest (force-killing a process kernel-stuck in a
 *  dxg GPU wait is what wedges the whole WSL VM), and never taskkill the wsl.exe
 *  wrapper while the guest process is still alive (it severs control mid-teardown). */
async function killWorkerTree(w: Worker): Promise<void> {
  const child = w.process;
  if (!child || child.killed) return;
  if (process.platform === 'win32' && shouldUseWsl2ForOrpheus()) {
    // Give the stdin 'quit' a moment to land before signalling.
    const quitLanded = await waitForGuestExit('orpheus_stream\\.py', 5000, 'orpheus-pool quit');
    if (!quitLanded) {
      // SIGTERM (orpheus_stream.py installs a handler → SystemExit → atexit CUDA
      // cleanup) → verified wait → VM terminate if it refuses. No global "pkill vllm"
      // — that pattern used to hit BATCH workers' vLLM too.
      await destroyWslGuestProcesses('orpheus_stream\\.py', { graceMs: 20000, label: 'orpheus-pool' });
    }
  }
  // Guest confirmed gone (or VM terminated) — closing the wrapper is now harmless.
  if (process.platform === 'win32' && child.pid) {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore', timeout: 5000 });
    } catch { /* already exited */ }
  } else {
    child.kill('SIGTERM');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────

export function isSessionActive(): boolean {
  return !!worker && worker.isReady;
}

export function getAvailableVoices(): string[] {
  // Built-ins + folder-discovered custom voices (each custom id is its folder name;
  // selecting one routes through resolveOrpheusModel in loadVoice). Failures in
  // discovery (e.g. WSL down for a \\wsl$ dir) just yield the built-ins.
  let custom: string[] = [];
  try {
    custom = listOrpheusModels().map((m) => m.id);
  } catch {
    custom = [];
  }
  return [...ORPHEUS_VOICES, ...custom];
}

export function getCurrentVoice(): string | null {
  return currentVoice;
}

/**
 * Can `voice` be rendered per REQUEST, alongside whatever else the engine has
 * loaded — or is loading it an exclusive act?
 *
 * Consumed by the TTS API server's post-load mismatch guard, which must not reject
 * concurrent clients on voices that can happily share the engine. Every answer here
 * is a WAIVER of that guard, so the rule is: say true only for what is provably
 * shareable, and treat every other case — including "I don't know" — as exclusive.
 *
 * FALSE unless the worker reports the vLLM backend. Per-request voices are a vLLM
 * capability end to end: multi-LoRA is vLLM's, and MLX builds one sampler per batch
 * bucket from the engine's own caps, so even a stock per-row prompt token would carry
 * another voice's tuning. On MLX the worker refuses such a row outright — so waiving
 * the guard there does not produce a wrong voice, it produces a FAILED one: the
 * background block in voice X and the foreground block in voice Y land in one batch
 * and the mismatched rows die. An unreported/unknown backend counts as not-vLLM.
 *
 * On vLLM:
 *   - a built-in voice        → true  (a prompt prefix over the shared base weights)
 *   - an installed ADAPTER    → true  (a per-request LoRARequest over that same base)
 *   - an installed MERGED     → false (the voice IS the weights; one can be resident)
 *   - anything else           → false. That last line is the point: a voice that is
 *     neither built in nor installed, or one we could not resolve at all (an
 *     unreachable \\wsl$ models dir throws), is UNKNOWN — and unknown must leave the
 *     guard armed. Returning true for it would waive the guard for precisely the ids
 *     nothing can vouch for.
 */
export function canServeVoicePerRequest(voice: string): boolean {
  if (workerBackend !== 'vllm') return false;
  const v = (voice || '').toLowerCase();
  if (ORPHEUS_VOICES.includes(v)) return true;
  try {
    // 'stream' to match resolveLoadPlan: this guard asks what the STREAMING path will
    // serve, so it must resolve through the same setting that path does. With the
    // default `orpheusStreamingArtifact: 'merged'` this now returns FALSE for custom
    // voices — correctly: fused voices are separate weights and genuinely cannot share
    // one batch, so per-request casting is off until the setting is flipped back to
    // 'adapter'. That is the known cost of the fused streaming default, not a bug.
    return resolveOrpheusModel(v, 'stream')?.artifact === 'adapter';
  } catch {
    return false;
  }
}

export function getLastVoice(): string | null {
  return lastVoice;
}

export function getDefaultVoice(): string {
  return currentVoice || lastVoice || ORPHEUS_DEFAULT_VOICE;
}

export function getWorkerCount(): number {
  return worker && worker.isReady ? 1 : 0;
}

/** How many sentences the scheduler may keep in flight per session. One Orpheus
 *  process serves them, but it batches a whole window into a single vLLM/MLX call,
 *  so the scheduler should dispatch a batch's worth at once (not one-at-a-time as
 *  getWorkerCount()=1 would imply). Reporting the CEILING rather than the ramp's
 *  current rung is deliberate: the pool decides how wide each batch actually goes out
 *  (takeBatchWidth), and it can only reach the widest rung if the scheduler has kept
 *  the queue that deep. Anything short of a full batch is throughput thrown away. */
export function getMaxConcurrentSentences(): number {
  return worker && worker.isReady ? streamBatchCeiling() : 1;
}

/** Orpheus is single-worker by nature; report a fixed topology so the TTS Server
 *  UI shows sensible (non-editable) values. The worker-count/device controls are
 *  XTTS concepts and are no-ops here. */
export function getStreamWorkerConfig(): StreamWorkerConfig {
  return {
    enabled: false,
    count: 1,
    defaultCount: 1,
    minWorkers: 1,
    maxWorkers: 1,
    devicePref: 'auto',
    device: detectedDevice === 'mlx' ? 'mps' : (detectedDevice as 'cpu' | 'cuda' | null),
    // deviceWorkers doubles as the client's prefetch depth (the extension reads it
    // as prefetchConcurrency). Report the batch size so the extension pipelines a
    // batch's worth of blocks ahead — keeping the vLLM/MLX batch fed — even though
    // there's physically one worker (activeWorkers stays 1).
    deviceWorkers: worker && worker.isReady ? streamBatchCeiling() : 1,
    activeWorkers: getWorkerCount(),
  };
}

export function setStreamWorkerConfig(_updates: {
  enabled?: boolean;
  count?: number;
  devicePref?: StreamWorkerConfig['devicePref'];
}): StreamWorkerConfig {
  // No-op: Orpheus always runs a single worker on its fixed device. (The 'engine'
  // selection itself is owned by streaming-engine.ts, not here.)
  return getStreamWorkerConfig();
}

// ─────────────────────────────────────────────────────────────────────────────
// stdin/stdout plumbing
// ─────────────────────────────────────────────────────────────────────────────

function send(command: Record<string, unknown>): void {
  if (worker?.process?.stdin) {
    worker.process.stdin.write(JSON.stringify(command) + '\n');
  }
}

function handleWorkerResponse(w: Worker, response: OrpheusResponse): void {
  if (response.type !== 'chunk' && response.type !== 'batch_chunk') {
    console.log('[Orpheus Pool] Response:', response.type, response.message || '');
  }

  if (response.type === 'status') {
    reportWarmup(response.message);
    return;
  }

  // FAST START: a sub-sentence payload of a row that is still generating. Routed to
  // that row's sink and NOT to its resolver — the row stays outstanding until its
  // 'batch_item' arrives, exactly like every other row in the batch.
  //
  // A chunk with nowhere to go is logged LOUDLY rather than dropped quietly: the
  // worker only streams rows flushBatch marked `stream:true`, so an unmatched index
  // means the two sides disagree about which rows those are, and silence would turn
  // that into a sentence of missing audio nobody can trace.
  if (response.type === 'batch_chunk') {
    const idx = response.i ?? -1;
    const sink = w.pendingBatch?.chunkSinks.get(idx);
    if (!sink) {
      console.error(
        `[Orpheus Pool] batch_chunk for item i=${idx} seq=${response.seq} has no chunk sink` +
        `${w.pendingBatch ? '' : ' (no batch in flight — stale from a timed-out batch)'} — dropping it`
      );
      return;
    }
    if (!response.data) {
      console.error(`[Orpheus Pool] batch_chunk for item i=${idx} seq=${response.seq} carried no data — dropping it`);
      return;
    }
    sink({
      seq: response.seq ?? 0,
      data: response.data,
      duration: response.duration || 0,
      sampleRate: response.sampleRate || 24000,
    });
    return;
  }

  // Batched read-ahead results route through pendingBatch, keyed by item index.
  if (response.type === 'batch_item') {
    if (!w.pendingBatch) {
      // Stale item from a timed-out batch. Before the taint mechanism this could
      // only happen transiently; the dangerous case was a NEW batch being in
      // flight, where {i:0} would resolve the wrong sentence — taint prevents a
      // new batch from being dispatched, so stale items always land here.
      console.log(`[Orpheus Pool] Dropping stale batch_item i=${response.i} from a timed-out batch`);
      return;
    }
    const idx = response.i ?? -1;
    const r = w.pendingBatch.resolvers.get(idx);
    if (r) {
      w.pendingBatch.resolvers.delete(idx);
      w.pendingBatch.chunkSinks.delete(idx);
      if (response.streamed === true) {
        // FAST START terminal: this row's audio left as batch_chunks. There is no
        // payload to hand back — only the totals — and the caller must not treat a
        // missing `audio` as a failure. Same staleness/timeout accounting as any
        // other batch_item: it resolves the row and nothing else.
        r({ success: true, streamed: true, duration: response.duration || 0 });
      } else if (response.data) {
        r({ success: true, audio: { data: response.data, duration: response.duration || 0, sampleRate: response.sampleRate || 24000 } });
      } else {
        r({ success: false, error: response.message || 'No audio generated' });
      }
    }
    return;
  }
  if (response.type === 'batch_done') {
    if (!w.pendingBatch) {
      // Terminal message of the timed-out batch: the worker is provably idle
      // again — clear the taint and let queued work flow.
      if (w.tainted) {
        console.log('[Orpheus Pool] Stale timed-out batch completed — worker un-tainted and returned to service');
        w.tainted = false;
        afterWorkerFree();
      }
      return;
    }
    clearTimeout(w.pendingBatch.timeout);
    // Any item the worker didn't report (shouldn't happen) fails rather than hangs.
    for (const r of w.pendingBatch.resolvers.values()) r({ success: false, error: 'No audio generated' });
    w.pendingBatch = null;
    afterWorkerFree();
    return;
  }

  // Ground truth from the engine the worker just built — corrects a startup probe
  // that couldn't import e2a. Recorded before the dispatch below so it lands even
  // when the 'loaded' is stale (a timed-out load).
  if (response.type === 'loaded') noteBackend(response.backend);

  if (response.type === 'loaded' && w.pendingRequest?.sentenceIndex === -1) {
    w.pendingRequest.resolve({ success: true });
  } else if (response.type === 'chunk' && response.data && w.pendingRequest?.onChunk) {
    w.pendingRequest.onChunk({
      seq: response.seq ?? 0,
      data: response.data,
      duration: response.duration || 0,
      sampleRate: response.sampleRate || 24000,
    });
  } else if (response.type === 'done' && w.pendingRequest?.resolveStream) {
    w.pendingRequest.resolveStream({
      success: true,
      duration: response.duration || 0,
      cancelled: response.cancelled === true,
    });
  } else if (response.type === 'audio' && response.data && w.pendingRequest) {
    w.pendingRequest.resolve({
      success: true,
      audio: {
        data: response.data,
        duration: response.duration || 0,
        sampleRate: response.sampleRate || 24000,
      },
    });
  } else if ((response.type === 'audio' || response.type === 'chunk' || response.type === 'done'
              || response.type === 'error' || response.type === 'loaded') && !w.pendingRequest) {
    console.log(`[Orpheus Pool] Ignoring orphaned ${response.type} response`);
    // Terminal message of a timed-out STREAM or LOAD request — worker idle again.
    // 'loaded' MUST be in that list: a timed-out load taints the worker, and if its
    // late 'loaded' didn't clear the taint the worker would refuse all work forever.
    if (w.tainted && response.type !== 'chunk') {
      console.log('[Orpheus Pool] Stale timed-out request completed — worker un-tainted and returned to service');
      w.tainted = false;
      afterWorkerFree();
    }
  } else if (response.type === 'error' && w.pendingRequest) {
    if (w.pendingRequest.resolveStream) w.pendingRequest.resolveStream({ success: false, error: response.message });
    else w.pendingRequest.resolve({ success: false, error: response.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const orpheusWorkerPool = {
  setMainWindow,
  startSession,
  loadVoice,
  generateSentence,
  generateSentenceStream,
  cancelStreaming,
  cancelPendingBatchIfStale,
  stop,
  endSession,
  isSessionActive,
  getAvailableVoices,
  getCurrentVoice,
  canServeVoicePerRequest,
  wouldRebuildEngine,
  forgetVoice,
  getDefaultVoice,
  getLastVoice,
  getWorkerCount,
  getMaxConcurrentSentences,
  getEngineState,
  isServiceMode,
  setServiceMode,
  onEngineState,
  getStreamWorkerConfig,
  setStreamWorkerConfig,
};

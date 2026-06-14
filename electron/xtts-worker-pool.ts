/**
 * XTTS Worker Pool - Parallel TTS generation using multiple Python processes
 *
 * Spawns N worker processes, each loading the XTTS model independently.
 * Sentences are distributed round-robin across workers for parallel generation.
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { getDefaultE2aPath, getPythonInvocation, buildCondaSpawnEnv, toUnpackedPath } from './e2a-paths';
import { getStreamVoices, resolveStreamVoice, StreamVoice } from './xtts-voices';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaySettings {
  voice: string;
  speed: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

export interface AudioChunk {
  data: string;  // Base64 WAV
  duration: number;
  sampleRate: number;
}

interface XTTSResponse {
  type: 'ready' | 'status' | 'loaded' | 'audio' | 'chunk' | 'done' | 'error' | 'stopped';
  device?: string;
  voice?: string;
  message?: string;
  data?: string;
  duration?: number;
  sampleRate?: number;
  seq?: number;
  format?: string;
  chunks?: number;
  cancelled?: boolean;
}

export interface StreamChunk {
  seq: number;
  data: string;  // Base64 PCM16 (24kHz mono)
  duration: number;
  sampleRate: number;
}

export interface StreamResult {
  success: boolean;
  duration?: number;
  cancelled?: boolean;
  error?: string;
}

interface PendingRequest {
  resolve: (result: { success: boolean; audio?: AudioChunk; error?: string }) => void;
  sentenceIndex: number;
  /** Set for streaming requests: receives chunks as they generate */
  onChunk?: (chunk: StreamChunk) => void;
  /** Set for streaming requests: resolves on the final 'done' message */
  resolveStream?: (result: StreamResult) => void;
}

interface Worker {
  process: ChildProcess;
  isReady: boolean;
  currentVoice: string | null;
  pendingRequest: PendingRequest | null;
  id: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const E2A_PATH = getDefaultE2aPath();

// Per-device topology:
// - CPU: XTTS GPT decode is sequential and gains nothing past ~4 threads,
//   while pinned workers barely contend with each other (M1 Ultra bench,
//   June 2026: 4 workers x 4 threads -> RTF ~1.9 each, ~2.1x realtime
//   aggregate; the old 3 unpinned workers oversubscribed the cores to ~0.4x
//   realtime).
// - CUDA: decode is autoregressive and serializes on the one GPU, so extra
//   workers just fight over it and cost ~4 GB VRAM each. One worker
//   saturates the device.
const CPU_NUM_WORKERS = 4;
const CUDA_NUM_WORKERS = 1;
const THREADS_PER_WORKER = 4;

// User override for the CPU worker count (Settings → TTS Server). Persisted in
// userData/tts-stream.json. CUDA always runs 1 worker — the GPU serializes
// autoregressive decode, so extra workers only cost VRAM. Changes apply the
// next time the engine starts; a running pool is never resized.
const MIN_CPU_WORKERS = 1;
const MAX_CPU_WORKERS = 8;
let configuredCpuWorkers: number | null = null;

function streamConfigPath(): string {
  return path.join(app.getPath('userData'), 'tts-stream.json');
}

function clampCpuWorkers(n: number): number {
  return Math.min(MAX_CPU_WORKERS, Math.max(MIN_CPU_WORKERS, Math.round(n)));
}

function cpuWorkerCount(): number {
  if (configuredCpuWorkers === null) {
    let n = CPU_NUM_WORKERS;
    try {
      const cfg = JSON.parse(fs.readFileSync(streamConfigPath(), 'utf-8'));
      if (typeof cfg.cpuWorkers === 'number') n = cfg.cpuWorkers;
    } catch {
      // No config yet — default topology
    }
    configuredCpuWorkers = clampCpuWorkers(n);
  }
  return configuredCpuWorkers;
}

export interface StreamWorkerConfig {
  /** Configured worker count for CPU mode (the only tunable) */
  cpuWorkers: number;
  defaultCpuWorkers: number;
  minWorkers: number;
  maxWorkers: number;
  /** null until the first engine start probes torch (non-mac) */
  device: 'cpu' | 'cuda' | null;
  /** Workers the active device will actually run (cpuWorkers on CPU, 1 on CUDA) */
  deviceWorkers: number;
  /** Workers currently alive — 0 when the engine is stopped */
  activeWorkers: number;
}

export function getStreamWorkerConfig(): StreamWorkerConfig {
  return {
    cpuWorkers: cpuWorkerCount(),
    defaultCpuWorkers: CPU_NUM_WORKERS,
    minWorkers: MIN_CPU_WORKERS,
    maxWorkers: MAX_CPU_WORKERS,
    device: detectedDevice,
    deviceWorkers: targetWorkerCount(),
    activeWorkers: workers.filter(w => w.isReady).length
  };
}

export function setStreamCpuWorkers(n: number): StreamWorkerConfig {
  configuredCpuWorkers = clampCpuWorkers(n);
  fs.writeFileSync(streamConfigPath(), JSON.stringify({ cpuWorkers: configuredCpuWorkers }, null, 2));
  console.log(`[XTTS Pool] CPU worker count set to ${configuredCpuWorkers} (applies on next engine start)`);
  return getStreamWorkerConfig();
}

// Device the Python workers run XTTS on, reported in the first worker's
// 'ready' message (torch.cuda.is_available() in xtts_stream.py). macOS never
// has CUDA and deliberately runs XTTS on CPU (MPS gives no speedup), so only
// Windows/Linux need the worker-0 probe. Cached for the rest of the app run
// so later sessions spawn the whole pool in one wave.
let detectedDevice: 'cuda' | 'cpu' | null =
  process.platform === 'darwin' ? 'cpu' : null;

function targetWorkerCount(): number {
  return detectedDevice === 'cuda' ? CUDA_NUM_WORKERS : cpuWorkerCount();
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let workers: Worker[] = [];
let mainWindow: BrowserWindow | null = null;
let currentVoice: string | null = null;

// Idle shutdown: kill the pool if nothing was generated for this long
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
let lastActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;

// Service mode: the user explicitly started the engine as a resident service
// (nav rail / play-screen "Start server"). Pins the pool alive — no idle
// shutdown, no shutdown when the last listen window closes. Cleared whenever
// the engine actually stops, so no window can ever show a running service
// that is dead.
let serviceMode = false;
let startingSession = false;
let startSessionPromise: Promise<{ success: boolean; voices?: string[]; error?: string }> | null = null;
// Last voice the user listened with — used to warm the service on start
let lastVoice: string | null = null;

export type EngineState = 'stopped' | 'starting' | 'warming' | 'running';

export function getEngineState(): EngineState {
  if (startingSession) return 'starting';
  if (!isSessionActive()) return 'stopped';
  // Workers are up, but a worker reports 'ready' as soon as its Python process
  // boots — the heavy XTTS checkpoint (~1.8 GB) is only loaded lazily on the
  // first load_voice(). So "ready to generate" means a voice is actually warm
  // (currentVoice set), not merely that the subprocess is alive. Until then the
  // engine is 'warming', so no UI shows green / enables play prematurely.
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

export function getLastVoice(): string | null {
  return lastVoice;
}

// External observers of engine state (e.g. the TTS API server pushing state
// to WebSocket clients). Windows are notified separately via broadcast().
type EngineStateListener = (state: EngineState, isServiceMode: boolean) => void;
const engineStateListeners = new Set<EngineStateListener>();

export function onEngineState(listener: EngineStateListener): () => void {
  engineStateListeners.add(listener);
  return () => engineStateListeners.delete(listener);
}

/** Engine state goes to every window so all start/stop controls stay in sync. */
function broadcastServiceState(): void {
  broadcast('tts-service:state', { state: getEngineState(), serviceMode });
  for (const listener of engineStateListeners) {
    try {
      listener(getEngineState(), serviceMode);
    } catch (err) {
      console.error('[XTTS Pool] Engine state listener failed:', err);
    }
  }
}

// Warm-up progress (checkpoint load + first voice latents). The workers emit
// status lines during load_voice(); we map them to a coarse but honest percent
// and push it to every window, so the play screen can show a real progress bar
// during the ~minute model load instead of a frozen, already-"green" button.
let warmupPct = 0;

function warmupPctFor(message?: string): number | null {
  if (!message) return null;
  if (message.includes('Loading XTTS model')) return 15;
  if (message === 'Model loaded') return 70;
  if (message.startsWith('Loading voice')) return 85;
  if (message.startsWith('Voice loaded')) return 100;
  return null;
}

function reportWarmup(message?: string): void {
  const pct = warmupPctFor(message);
  if (pct === null) return;
  // Monotonic within one warm cycle so the bar never jumps backwards when
  // several CPU workers report the same phase out of order.
  if (pct < warmupPct) return;
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
    if (!serviceMode && isSessionActive() && Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
      console.log(`[XTTS Pool] Idle for ${Math.round(IDLE_TIMEOUT_MS / 60000)} min — shutting down`);
      void endSession();
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

/** Session lifecycle events go to every window (main app + listen windows) */
function broadcast(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

/**
 * Start the worker pool. Concurrent callers (e.g. nav-rail service start and
 * a play button pressed in another window) share the same in-flight startup.
 */
export async function startSession(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
  if (workers.length > 0 && !startingSession) {
    return { success: true, voices: getAvailableVoices() };
  }
  if (startSessionPromise) {
    return startSessionPromise;
  }
  startSessionPromise = doStartSession().finally(() => {
    startSessionPromise = null;
  });
  return startSessionPromise;
}

async function doStartSession(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
  startingSession = true;
  broadcastServiceState();

  try {
    if (detectedDevice === null) {
      // First start on Windows/Linux: bring up worker 0 alone to learn the
      // device from its 'ready' message, then top the pool up to the
      // device-appropriate size.
      console.log('[XTTS Pool] Starting worker 0 (device probe)...');
      const first = await startWorker(0);
      if (!first.success) {
        return await failStartSession(first.error || 'Worker 0 failed to start');
      }
      if (detectedDevice === null) {
        return await failStartSession('Worker 0 did not report its device');
      }
    }

    const target = targetWorkerCount();
    console.log(`[XTTS Pool] Starting ${target} worker(s) on ${detectedDevice}...`);

    const startPromises = [];
    for (let i = workers.length; i < target; i++) {
      startPromises.push(startWorker(i));
    }
    const results = await Promise.all(startPromises);
    const errors = results.filter(r => !r.success).map(r => r.error);
    if (errors.length > 0) {
      return await failStartSession(errors.join(', '));
    }

    console.log('[XTTS Pool] All workers started successfully');
    startIdleWatch();
    startingSession = false;
    broadcast('play:session-started');
    broadcastServiceState();
    return { success: true, voices: getAvailableVoices() };
  } catch (err) {
    return await failStartSession(err instanceof Error ? err.message : 'Unknown error');
  }
}

async function failStartSession(error: string): Promise<{ success: boolean; error: string }> {
  startingSession = false;
  await endSession();
  return { success: false, error };
}

/**
 * Start a single worker process
 */
async function startWorker(id: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    try {
      const appPath = app.getAppPath();
      let scriptPath = path.join(appPath, 'electron', 'scripts', 'xtts_stream.py');

      if (!fs.existsSync(scriptPath)) {
        scriptPath = path.join(__dirname, '..', '..', 'electron', 'scripts', 'xtts_stream.py');
      }
      if (!fs.existsSync(scriptPath)) {
        scriptPath = path.join(__dirname, 'scripts', 'xtts_stream.py');
      }
      // Packaged: redirect from inside app.asar to the asarUnpack'd real file
      // (a spawned Python can't read inside the archive).
      scriptPath = toUnpackedPath(scriptPath);

      console.log(`[XTTS Pool] Starting worker ${id}...`);

      // Resolve the env layout (bundled relocatable python or conda run);
      // -u for unbuffered output.
      const py = getPythonInvocation(E2A_PATH);
      const condaArgs = [...py.args, '-u', scriptPath];

      // shell: false like every other native conda spawn (parallel-tts-bridge):
      // the command is an executable on all platforms, and skipping the shell
      // avoids cmd.exe quoting rules on Windows. buildCondaSpawnEnv keeps
      // System32 on PATH, which conda's env activation needs (chcp) and can
      // otherwise drop.
      const child = spawn(py.command, condaArgs, {
        cwd: E2A_PATH,
        env: buildCondaSpawnEnv({
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          EBOOK2AUDIOBOOK_PATH: E2A_PATH,
          XTTS_THREADS: String(THREADS_PER_WORKER),
          OMP_NUM_THREADS: String(THREADS_PER_WORKER),
          MKL_NUM_THREADS: String(THREADS_PER_WORKER)
        }),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const worker: Worker = {
        process: child,
        isReady: false,
        currentVoice: null,
        pendingRequest: null,
        id
      };

      workers.push(worker);

      // Use readline for line-based JSON parsing
      // Python sends one JSON object per line (using print() with newline)
      if (child.stdout) {
        const rl = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity
        });

        rl.on('line', (line: string) => {
          // Skip empty lines
          line = line.trim();
          if (!line) return;

          // Skip lines that don't look like JSON
          if (!line.startsWith('{')) {
            console.log(`[XTTS Pool ${id}] Non-JSON output:`, line.substring(0, 100));
            return;
          }

          try {
            const response: XTTSResponse = JSON.parse(line);
            handleWorkerResponse(worker, response);

            if (response.type === 'ready') {
              worker.isReady = true;
              // The worker reports which device torch picked - this decides
              // the pool topology (1 worker on CUDA, CPU_NUM_WORKERS on CPU)
              if (response.device === 'cuda' || response.device === 'cpu') {
                if (detectedDevice !== null && detectedDevice !== response.device) {
                  console.warn(`[XTTS Pool ${id}] Device mismatch: expected ${detectedDevice}, got ${response.device}`);
                }
                detectedDevice = response.device;
              }
              resolve({ success: true });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[XTTS Pool ${id}] JSON parse error: ${errMsg}`);
            console.error(`[XTTS Pool ${id}] Line length: ${line.length}, starts: ${line.substring(0, 50)}...`);
          }
        });
      }

      child.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[XTTS Pool ${id} stderr]`, msg);
        }
      });

      child.on('close', (code) => {
        console.log(`[XTTS Pool ${id}] Process exited with code:`, code);
        workers = workers.filter(w => w.id !== id);

        if (worker.pendingRequest) {
          if (worker.pendingRequest.resolveStream) {
            worker.pendingRequest.resolveStream({ success: false, error: 'Worker died' });
          } else {
            worker.pendingRequest.resolve({ success: false, error: 'Worker died' });
          }
        }
        if (workers.length === 0) {
          drainWorkerWaiters();
        }
      });

      child.on('error', (error) => {
        console.error(`[XTTS Pool ${id}] Process error:`, error);
        resolve({ success: false, error: error.message });
      });

      // Timeout
      setTimeout(() => {
        if (!worker.isReady) {
          resolve({ success: false, error: `Worker ${id} timeout` });
        }
      }, 60000);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      resolve({ success: false, error: message });
    }
  });
}

/**
 * Load voice on all workers
 */
export async function loadVoice(voice: string): Promise<{ success: boolean; error?: string }> {
  if (workers.length === 0) {
    return { success: false, error: 'No workers available' };
  }
  touchActivity();

  if (currentVoice === voice) {
    return { success: true };
  }

  // Resolve the catalog entry here so the worker stays a generic executor:
  // it just loads (repo, sub) and clones refPath.
  const descriptor = resolveStreamVoice(voice);
  if (!descriptor) {
    return { success: false, error: `Unknown voice: ${voice}` };
  }

  console.log(`[XTTS Pool] Loading voice ${voice} on ${workers.length} workers...`);

  // New warm cycle: progress restarts from 0 so the bar reflects this load.
  warmupPct = 0;

  // Load voice on all workers in parallel
  const loadPromises = workers.map(worker => loadVoiceOnWorker(worker, descriptor));
  const results = await Promise.all(loadPromises);

  const allSuccess = results.every(r => r.success);
  if (allSuccess) {
    currentVoice = voice;
    lastVoice = voice;
    // Model is now in memory: warm-up done, engine flips warming → running.
    warmupPct = 100;
    broadcast('tts-service:warmup', { pct: 100, message: 'Ready' });
    broadcastServiceState();
    return { success: true };
  } else {
    const errors = results.filter(r => !r.success).map(r => r.error);
    return { success: false, error: errors.join(', ') };
  }
}

async function loadVoiceOnWorker(worker: Worker, descriptor: StreamVoice): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: `Worker ${worker.id} voice load timeout` });
      }
    }, 120000);

    // Store a temporary handler
    const originalPending = worker.pendingRequest;
    worker.pendingRequest = {
      resolve: (result) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          worker.pendingRequest = originalPending;
          if (!worker.pendingRequest) {
            releaseWorkerSlot();
          }
          if (result.success || result.audio) {
            worker.currentVoice = descriptor.id;
            resolve({ success: true });
          } else {
            resolve({ success: false, error: result.error });
          }
        }
      },
      sentenceIndex: -1  // Special marker for voice load
    };

    sendToWorker(worker, {
      action: 'load',
      voice: descriptor.id,
      repo: descriptor.repo,
      sub: descriptor.sub,
      ref_path: descriptor.refPath,
      // Set for user-added custom voices: load from this local folder instead
      // of fetching the checkpoint from HuggingFace.
      local_checkpoint_dir: descriptor.localCheckpointDir ?? null
    });
  });
}

// Waiters for a free worker, in two FIFO tiers: the playing session's sentences
// (priority) are served strictly before background read-ahead (normal). Each tier
// is FIFO so a session's sentences run in DISPATCH order — the streamed playhead
// sentence is dispatched first and must get the first free worker, not the last.
// (An unshift-based queue jump once reversed this: the playing block's lookahead
// sentences piled in front of its own first sentence, and since the client drains
// PCM strictly in order, playback start waited ~3 extra sentence generations.)
// A waiter's run() MUST set worker.pendingRequest synchronously when invoked, so
// only one waiter is released per freed worker (no polling race).
interface WorkerWaiter {
  run: (worker: Worker | null) => void;
  /** Stale check — a cancelled session's queued jobs are skipped at release time
   *  instead of burning a worker on a sentence nobody will hear. */
  isCancelled?: () => boolean;
}
const priorityWaiters: WorkerWaiter[] = [];
const normalWaiters: WorkerWaiter[] = [];

function findFreeWorker(): Worker | undefined {
  return workers.find(w => w.isReady && !w.pendingRequest);
}

/** Called whenever a worker's pendingRequest is cleared. */
function releaseWorkerSlot(): void {
  let worker = findFreeWorker();
  while (worker) {
    const waiter = priorityWaiters.shift() ?? normalWaiters.shift();
    if (!waiter) return;
    if (waiter.isCancelled?.()) {
      waiter.run(null);  // resolves as no-worker; the caller drops it as stale
      continue;          // the worker is still free — try the next waiter
    }
    waiter.run(worker);  // reserves the worker synchronously
    worker = findFreeWorker();
  }
}

/**
 * Run `job` on a free worker, waiting if all are busy. The job MUST set
 * worker.pendingRequest synchronously when invoked - that reservation is what
 * prevents two callers from claiming the same worker. There must be NO await
 * between picking a free worker and running the job (an async gap here once
 * let 4 concurrent dispatches pile onto one worker while 3 sat idle).
 * `priority` selects the tier: the playing session's sentences (priority) are
 * served before read-ahead (normal), FIFO within each tier. `isCancelled` lets
 * a queued job be discarded at release time if its session was cancelled.
 */
function runOnFreeWorker<T>(
  job: (worker: Worker) => Promise<T>,
  onNoWorkers: () => T,
  priority = false,
  isCancelled?: () => boolean
): Promise<T> {
  const worker = findFreeWorker();
  if (worker) return job(worker);
  if (workers.length === 0) return Promise.resolve(onNoWorkers());
  return new Promise<T>(resolve => {
    const run = (w: Worker | null) => {
      if (!w) {
        resolve(onNoWorkers());
        return;
      }
      void job(w).then(resolve);
    };
    (priority ? priorityWaiters : normalWaiters).push({ run, isCancelled });
  });
}

/** Wake all waiters with null (session ending / all workers gone). */
function drainWorkerWaiters(): void {
  while (priorityWaiters.length > 0) {
    priorityWaiters.shift()!.run(null);
  }
  while (normalWaiters.length > 0) {
    normalWaiters.shift()!.run(null);
  }
}

/**
 * Generate audio for a sentence using the next available worker
 */
export async function generateSentence(
  text: string,
  sentenceIndex: number,
  settings: PlaySettings,
  priority = false,
  isCancelled?: () => boolean
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  touchActivity();
  return runOnFreeWorker<{ success: boolean; audio?: AudioChunk; error?: string }>(
    worker => generateOnWorker(worker, text, sentenceIndex, settings),
    () => ({ success: false, error: 'No workers available' }),
    priority,
    isCancelled
  );
}

async function generateOnWorker(
  worker: Worker,
  text: string,
  sentenceIndex: number,
  settings: PlaySettings
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  if (worker.pendingRequest) {
    console.error(`[XTTS Pool ${worker.id}] BUG: dispatch to a busy worker - request would be clobbered`);
    return Promise.resolve({ success: false, error: 'Worker already busy (dispatch bug)' });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.pendingRequest = null;
      releaseWorkerSlot();
      resolve({ success: false, error: 'Generation timeout' });
    }, 60000);

    worker.pendingRequest = {
      resolve: (result) => {
        clearTimeout(timeout);
        worker.pendingRequest = null;
        releaseWorkerSlot();
        resolve(result);
      },
      sentenceIndex
    };

    sendToWorker(worker, {
      action: 'generate',
      text,
      language: 'en',
      speed: settings.speed,
      temperature: settings.temperature || 0.65,
      top_p: settings.topP || 0.85,
      repetition_penalty: settings.repetitionPenalty || 2.0,
      stream: false
    });
  });
}

/**
 * Generate a sentence with chunked streaming on the first free worker.
 * Chunks arrive via onChunk as they generate (~1s of audio each, first one
 * in ~2-3s); resolves when the sentence finishes or is cancelled.
 */
export async function generateSentenceStream(
  text: string,
  settings: PlaySettings,
  onChunk: (chunk: StreamChunk) => void,
  isCancelled?: () => boolean
): Promise<StreamResult> {
  touchActivity();
  return runOnFreeWorker<StreamResult>(
    worker => streamOnWorker(worker, text, settings, onChunk),
    () => ({ success: false, error: 'No workers available' }),
    true,
    isCancelled
  );
}

function streamOnWorker(
  worker: Worker,
  text: string,
  settings: PlaySettings,
  onChunk: (chunk: StreamChunk) => void
): Promise<StreamResult> {
  if (worker.pendingRequest) {
    console.error(`[XTTS Pool ${worker.id}] BUG: stream dispatch to a busy worker - request would be clobbered`);
    return Promise.resolve({ success: false, error: 'Worker already busy (dispatch bug)' });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.pendingRequest = null;
      releaseWorkerSlot();
      resolve({ success: false, error: 'Streaming generation timeout' });
    }, 120000);

    worker.pendingRequest = {
      resolve: () => { /* batch path unused for stream requests */ },
      sentenceIndex: -2,
      onChunk,
      resolveStream: (result) => {
        clearTimeout(timeout);
        worker.pendingRequest = null;
        releaseWorkerSlot();
        resolve(result);
      }
    };

    sendToWorker(worker, {
      action: 'generate',
      text,
      language: 'en',
      speed: settings.speed,
      temperature: settings.temperature || 0.65,
      top_p: settings.topP || 0.85,
      repetition_penalty: settings.repetitionPenalty || 2.0,
      stream: true
    });
  });
}

/**
 * Cancel any in-flight streaming generation (checked between chunks in the
 * Python worker). Batch generations cannot be interrupted; callers drop
 * stale results instead.
 */
export function cancelStreaming(): void {
  for (const worker of workers) {
    if (worker.pendingRequest?.resolveStream) {
      sendToWorker(worker, { action: 'cancel' });
    }
  }
}

/**
 * Stop all workers
 */
export function stop(): void {
  workers.forEach(worker => {
    if (worker.isReady) {
      sendToWorker(worker, { action: 'stop' });
    }
  });
}

/**
 * End the session - kill all workers
 */
export async function endSession(): Promise<void> {
  console.log('[XTTS Pool] Ending session...');
  stopIdleWatch();
  drainWorkerWaiters();
  const hadWorkers = workers.length > 0;

  for (const worker of workers) {
    sendToWorker(worker, { action: 'quit' });
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  for (const worker of workers) {
    killWorkerTree(worker);
  }

  workers = [];
  currentVoice = null;
  serviceMode = false;  // engine off ⇒ service off

  if (hadWorkers) {
    broadcast('play:session-ended', { code: 0 });
  }
  broadcastServiceState();
}

/**
 * Check if session is active
 */
export function isSessionActive(): boolean {
  return workers.length > 0 && workers.some(w => w.isReady);
}

/**
 * Voice ids available to stream. Sourced from the catalog (the e2a voices
 * folder), so it works before the engine starts. Kept as string[] for the TTS
 * API server / browser-extension protocol.
 */
export function getAvailableVoices(): string[] {
  return getStreamVoices().map(v => v.id);
}

/**
 * Full voice catalog (id, display name, group, model paths) for the UI dropdown.
 */
export function getVoiceCatalog(): StreamVoice[] {
  return getStreamVoices();
}

/**
 * Get current voice
 */
export function getCurrentVoice(): string | null {
  return currentVoice;
}

/**
 * Get number of active workers
 */
export function getWorkerCount(): number {
  return workers.filter(w => w.isReady).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kill a worker and its children. On Windows the spawn chain is
 * conda.exe -> python.exe; killing only conda.exe orphans the Python process
 * (and its GPU memory), so use taskkill /T like parallel-tts-bridge does.
 */
function killWorkerTree(worker: Worker): void {
  const child = worker.process;
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore', timeout: 5000 });
    } catch {
      // Process tree already exited (normal after a clean 'quit')
    }
  } else {
    child.kill('SIGTERM');
  }
}

function sendToWorker(worker: Worker, command: Record<string, unknown>): void {
  if (worker.process?.stdin) {
    const line = JSON.stringify(command) + '\n';
    worker.process.stdin.write(line);
  }
}

function handleWorkerResponse(worker: Worker, response: XTTSResponse): void {
  if (response.type !== 'chunk') {
    console.log(`[XTTS Pool ${worker.id}] Response:`, response.type, response.message || '');
  }

  if (response.type === 'status') {
    // Phase updates during the checkpoint load — drive the warm-up progress bar.
    reportWarmup(response.message);
    return;
  }

  if (response.type === 'loaded' && worker.pendingRequest?.sentenceIndex === -1) {
    // Voice load complete
    worker.pendingRequest?.resolve({ success: true });
  } else if (response.type === 'chunk' && response.data && worker.pendingRequest?.onChunk) {
    worker.pendingRequest.onChunk({
      seq: response.seq ?? 0,
      data: response.data,
      duration: response.duration || 0,
      sampleRate: response.sampleRate || 24000
    });
  } else if (response.type === 'done' && worker.pendingRequest?.resolveStream) {
    worker.pendingRequest.resolveStream({
      success: true,
      duration: response.duration || 0,
      cancelled: response.cancelled === true
    });
  } else if (response.type === 'audio' && response.data && worker.pendingRequest) {
    const audio: AudioChunk = {
      data: response.data,
      duration: response.duration || 0,
      sampleRate: response.sampleRate || 24000
    };
    worker.pendingRequest.resolve({ success: true, audio });
  } else if ((response.type === 'audio' || response.type === 'chunk' || response.type === 'done') && !worker.pendingRequest) {
    // Result arrived but request was cancelled/timed out - just ignore
    console.log(`[XTTS Pool ${worker.id}] Ignoring orphaned ${response.type} response`);
  } else if (response.type === 'error' && worker.pendingRequest) {
    if (worker.pendingRequest.resolveStream) {
      worker.pendingRequest.resolveStream({ success: false, error: response.message });
    } else {
      worker.pendingRequest.resolve({ success: false, error: response.message });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const xttsWorkerPool = {
  setMainWindow,
  startSession,
  loadVoice,
  generateSentence,
  generateSentenceStream,
  cancelStreaming,
  stop,
  endSession,
  isSessionActive,
  getAvailableVoices,
  getVoiceCatalog,
  getCurrentVoice,
  getWorkerCount,
  getEngineState,
  isServiceMode,
  setServiceMode,
  getLastVoice,
  onEngineState,
  getStreamWorkerConfig,
  setStreamCpuWorkers
};

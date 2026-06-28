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
import {
  PlaySettings,
  AudioChunk,
  StreamChunk,
  StreamResult,
  StreamWorkerConfig,
  EngineState,
} from './xtts-worker-pool';

const E2A_PATH = getDefaultE2aPath();

// Orpheus's built-in voices (the model is voice-conditioned by a prompt prefix).
// leah has the best quality; tara has echo artifacts. Mirrors VALID_VOICES in
// e2a's orpheus.py / orpheus_stream.py.
// 'owen' is a custom fine-tune that loads its own merged model (CUSTOM_VOICE_MODELS
// in orpheus.py); listed here so it's an offerable Orpheus voice.
const ORPHEUS_VOICES = ['leah', 'tara', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe', 'owen'];
const ORPHEUS_DEFAULT_VOICE = 'leah';

// Read-ahead batch size. Orpheus runs ONE process, but vLLM/MLX batch many
// sequences in a single generate() call (the audiobook pipeline's convert_batch
// uses the same 16). We coalesce queued read-ahead sentences into batches of this
// size — one vLLM call runs them concurrently on the GPU instead of trickling one
// at a time. Also reported as deviceWorkers so the extension prefetches this many
// blocks ahead, keeping the batch fed. Matches e2a's ORPHEUS_BATCH_SIZE default.
const ORPHEUS_BATCH_SIZE = Math.max(1, parseInt(process.env.ORPHEUS_BATCH_SIZE || '16', 10) || 16);

// ─────────────────────────────────────────────────────────────────────────────
// Worker process state
// ─────────────────────────────────────────────────────────────────────────────

interface OrpheusResponse {
  type: 'ready' | 'status' | 'loaded' | 'audio' | 'chunk' | 'done' | 'error' | 'stopped'
      | 'batch_item' | 'batch_done';
  device?: string;
  voice?: string;
  message?: string;
  data?: string;
  duration?: number;
  sampleRate?: number;
  seq?: number;
  chunks?: number;
  cancelled?: boolean;
  /** batch_item: the caller-supplied index of this item within the batch */
  i?: number;
  /** batch_done: how many items the batch contained */
  count?: number;
}

type GenResult = { success: boolean; audio?: AudioChunk; error?: string };

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
}

interface Worker {
  process: ChildProcess;
  isReady: boolean;
  /** Single-op slot for load + the streamed first sentence (worker is serial). */
  pendingRequest: PendingRequest | null;
  /** Batched generate in flight (read-ahead sentences). */
  pendingBatch: PendingBatch | null;
}

let worker: Worker | null = null;
let mainWindow: BrowserWindow | null = null;
let currentVoice: string | null = null;
let lastVoice: string | null = null;
let detectedDevice: 'cuda' | 'mlx' | 'cpu' | null = null;

let startingSession = false;
let startSessionPromise: Promise<{ success: boolean; voices?: string[]; error?: string }> | null = null;

let serviceMode = false;

// Idle shutdown: kill the worker if nothing was generated for this long (and not
// pinned as a resident service). Frees ~6 GB of VRAM the vLLM engine holds.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
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
    if (!serviceMode && isSessionActive() && Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
      console.log('[Orpheus Pool] Idle — shutting down');
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

/** Build the spawn for the persistent Orpheus worker. */
function buildSpawnPlan(scriptPath: string): SpawnPlan {
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
    const exportCmd =
      `export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 ORPHEUS_DISABLE_EAGER=1 ` +
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
      EBOOK2AUDIOBOOK_PATH: E2A_PATH,
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
    const result = await startWorker();
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

function startWorker(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let plan: SpawnPlan;
    try {
      plan = buildSpawnPlan(resolveScriptPath());
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
      if (worker === w) worker = null;
      drainWaiters();
      failBatchQueue('Worker died');
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

export async function loadVoice(voice: string): Promise<{ success: boolean; error?: string }> {
  if (!worker || !worker.isReady) return { success: false, error: 'No Orpheus worker' };
  touchActivity();

  const v = (voice || ORPHEUS_DEFAULT_VOICE).toLowerCase();
  if (currentVoice === v) return { success: true };

  warmupPct = 0;
  return new Promise((resolve) => {
    let resolved = false;
    // First load includes the ~12s CUDA-graph capture + weight load; later voice
    // switches are instant (prompt-prefix only).
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: 'Orpheus voice load timeout' });
      }
    }, 180000);

    const prev = worker!.pendingRequest;
    worker!.pendingRequest = {
      sentenceIndex: -1,
      resolve: (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        worker!.pendingRequest = prev;
        afterWorkerFree();  // let any queued read-ahead flush now the worker's free
        if (result.success || result.audio) {
          currentVoice = v;
          lastVoice = v;
          warmupPct = 100;
          broadcast('tts-service:warmup', { pct: 100, message: 'Ready' });
          broadcastServiceState();
          resolve({ success: true });
        } else {
          resolve({ success: false, error: result.error });
        }
      },
    };
    send({ action: 'load', voice: v });
  });
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
  return !!worker && (!!worker.pendingRequest || !!worker.pendingBatch);
}

function workerFree(): boolean {
  return !!worker && worker.isReady && !workerBusy();
}

/** Called whenever the worker frees (load/stream/batch completed). Runs queued
 *  stream/load waiters FIRST (the playing sentence has priority), then flushes the
 *  batched read-ahead queue onto whatever capacity remains. */
function afterWorkerFree(): void {
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
// generate_batch request. The streamed first sentence and voice-load stay on the
// single-op path above; everything else (lookahead + background prefetch) flows
// through here so a whole article converts at batch throughput, not one-at-a-time.
// ─────────────────────────────────────────────────────────────────────────────

interface BatchItem {
  text: string;
  resolve: (r: GenResult) => void;
  isCancelled?: () => boolean;
  priority: boolean;
}
const batchQueue: BatchItem[] = [];
let flushScheduled = false;

function enqueueBatchItem(item: BatchItem): void {
  batchQueue.push(item);
  scheduleBatchFlush();
}

/** Defer the flush to a microtask so all sentences the scheduler dispatches in one
 *  synchronous pump are collected into the same batch. */
function scheduleBatchFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    flushBatch();
  });
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

  const picked = batchQueue.splice(0, ORPHEUS_BATCH_SIZE);
  const resolvers = new Map<number, (r: GenResult) => void>();
  const items = picked.map((it, i) => {
    resolvers.set(i, it.resolve);
    return { i, text: it.text };
  });

  const timeout = setTimeout(() => {
    if (worker?.pendingBatch?.resolvers === resolvers) {
      for (const r of resolvers.values()) r({ success: false, error: 'Batch generation timeout' });
      worker.pendingBatch = null;
      afterWorkerFree();
    }
  }, 180000);

  worker.pendingBatch = { resolvers, timeout };
  send({ action: 'generate_batch', items });
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

export async function generateSentence(
  text: string,
  _sentenceIndex: number,
  _settings: PlaySettings,
  priority = false,
  isCancelled?: () => boolean
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  touchActivity();
  if (!worker) return { success: false, error: 'No workers available' };
  // Coalesced into a vLLM/MLX batch with sibling read-ahead sentences rather than
  // run one-at-a-time. (Orpheus ignores per-sentence settings — voice is the warm
  // prefix, sampling is fixed — so only the text matters here.)
  return new Promise<GenResult>((resolve) => {
    enqueueBatchItem({ text, resolve, isCancelled, priority });
  });
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
  _settings: PlaySettings,
  onChunk: (chunk: StreamChunk) => void
): Promise<StreamResult> {
  if (w.pendingRequest) {
    return Promise.resolve({ success: false, error: 'Worker already busy (dispatch bug)' });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
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
    send({ action: 'generate', text, language: 'en', stream: true });
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

export async function endSession(): Promise<void> {
  console.log('[Orpheus Pool] Ending session...');
  stopIdleWatch();
  startingSession = false;
  drainWaiters();
  failBatchQueue('Session ended');
  const w = worker;
  const hadWorker = !!w;
  if (w) {
    send({ action: 'quit' });
    await new Promise((r) => setTimeout(r, 500));
    killWorkerTree(w);
  }
  worker = null;
  currentVoice = null;
  serviceMode = false;
  if (hadWorker) broadcast('play:session-ended', { code: 0 });
  broadcastServiceState();
}

/** Kill the worker process tree. On Windows+WSL the child is wsl.exe wrapping a
 *  Linux python + vLLM — killing wsl.exe orphans them (and their VRAM), so pkill
 *  inside WSL first (mirrors parallel-tts-bridge.killWslProcessTree). */
function killWorkerTree(w: Worker): void {
  const child = w.process;
  if (!child || child.killed) return;
  if (process.platform === 'win32' && shouldUseWsl2ForOrpheus()) {
    const distro = getWslDistro();
    const distroArg = distro ? `-d ${distro}` : '';
    try {
      execSync(`wsl.exe ${distroArg} pkill -f "orpheus_stream\\.py"`, { stdio: 'ignore', timeout: 5000 });
    } catch { /* nothing matched / already gone */ }
    try {
      execSync(`wsl.exe ${distroArg} pkill -f "vllm"`, { stdio: 'ignore', timeout: 5000 });
    } catch { /* nothing matched */ }
  }
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
  return [...ORPHEUS_VOICES];
}

export function getCurrentVoice(): string | null {
  return currentVoice;
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
 *  getWorkerCount()=1 would imply). */
export function getMaxConcurrentSentences(): number {
  return worker && worker.isReady ? ORPHEUS_BATCH_SIZE : 1;
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
    deviceWorkers: worker && worker.isReady ? ORPHEUS_BATCH_SIZE : 1,
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
  if (response.type !== 'chunk') {
    console.log('[Orpheus Pool] Response:', response.type, response.message || '');
  }

  if (response.type === 'status') {
    reportWarmup(response.message);
    return;
  }

  // Batched read-ahead results route through pendingBatch, keyed by item index.
  if (response.type === 'batch_item' && w.pendingBatch) {
    const idx = response.i ?? -1;
    const r = w.pendingBatch.resolvers.get(idx);
    if (r) {
      w.pendingBatch.resolvers.delete(idx);
      if (response.data) {
        r({ success: true, audio: { data: response.data, duration: response.duration || 0, sampleRate: response.sampleRate || 24000 } });
      } else {
        r({ success: false, error: response.message || 'No audio generated' });
      }
    }
    return;
  }
  if (response.type === 'batch_done' && w.pendingBatch) {
    clearTimeout(w.pendingBatch.timeout);
    // Any item the worker didn't report (shouldn't happen) fails rather than hangs.
    for (const r of w.pendingBatch.resolvers.values()) r({ success: false, error: 'No audio generated' });
    w.pendingBatch = null;
    afterWorkerFree();
    return;
  }

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
  } else if ((response.type === 'audio' || response.type === 'chunk' || response.type === 'done') && !w.pendingRequest) {
    console.log(`[Orpheus Pool] Ignoring orphaned ${response.type} response`);
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
  stop,
  endSession,
  isSessionActive,
  getAvailableVoices,
  getCurrentVoice,
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

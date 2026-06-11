/**
 * XTTS Worker Pool - Parallel TTS generation using multiple Python processes
 *
 * Spawns N worker processes, each loading the XTTS model independently.
 * Sentences are distributed round-robin across workers for parallel generation.
 */

import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { getDefaultE2aPath, getCondaRunArgs, getCondaPath } from './e2a-paths';

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
  voices?: string[];
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

// XTTS GPT decode is sequential and gains nothing past ~4 threads, while
// pinned workers barely contend with each other (M1 Ultra bench, June 2026:
// 4 workers x 4 threads -> RTF ~1.9 each, ~2.1x realtime aggregate; the old
// 3 unpinned workers oversubscribed the cores to ~0.4x realtime).
const NUM_WORKERS = 4;
const THREADS_PER_WORKER = 4;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let workers: Worker[] = [];
let mainWindow: BrowserWindow | null = null;
let currentVoice: string | null = null;
let discoveredVoices: string[] = [];

// Idle shutdown: kill the pool if nothing was generated for this long
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
let lastActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;

function touchActivity(): void {
  lastActivityAt = Date.now();
}

function startIdleWatch(): void {
  stopIdleWatch();
  touchActivity();
  idleTimer = setInterval(() => {
    if (isSessionActive() && Date.now() - lastActivityAt > IDLE_TIMEOUT_MS) {
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
 * Start the worker pool
 */
export async function startSession(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
  if (workers.length > 0) {
    return { success: true, voices: getAvailableVoices() };
  }

  console.log(`[XTTS Pool] Starting ${NUM_WORKERS} workers...`);

  const startPromises = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    startPromises.push(startWorker(i));
  }

  try {
    const results = await Promise.all(startPromises);
    const allSuccess = results.every(r => r.success);

    if (allSuccess) {
      console.log('[XTTS Pool] All workers started successfully');
      startIdleWatch();
      broadcast('play:session-started');
      return { success: true, voices: getAvailableVoices() };
    } else {
      const errors = results.filter(r => !r.success).map(r => r.error);
      await endSession();
      return { success: false, error: errors.join(', ') };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await endSession();
    return { success: false, error: message };
  }
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

      console.log(`[XTTS Pool] Starting worker ${id}...`);

      // Get conda run args dynamically (handles prefix vs named env)
      const condaArgs = [...getCondaRunArgs(E2A_PATH)];
      // Replace 'python' with 'python -u' for unbuffered output, add script path
      condaArgs[condaArgs.length - 1] = 'python';
      condaArgs.push('-u', scriptPath);

      const process = spawn(getCondaPath(), condaArgs, {
        cwd: E2A_PATH,
        env: {
          ...global.process.env,
          PYTHONUNBUFFERED: '1',
          XTTS_THREADS: String(THREADS_PER_WORKER),
          OMP_NUM_THREADS: String(THREADS_PER_WORKER),
          MKL_NUM_THREADS: String(THREADS_PER_WORKER)
        },
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const worker: Worker = {
        process,
        isReady: false,
        currentVoice: null,
        pendingRequest: null,
        id
      };

      workers.push(worker);

      // Use readline for line-based JSON parsing
      // Python sends one JSON object per line (using print() with newline)
      if (process.stdout) {
        const rl = readline.createInterface({
          input: process.stdout,
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
              // Store discovered voices from the first worker
              if (response.voices && response.voices.length > 0 && discoveredVoices.length === 0) {
                discoveredVoices = response.voices;
                console.log(`[XTTS Pool] Discovered ${discoveredVoices.length} voices`);
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

      process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[XTTS Pool ${id} stderr]`, msg);
        }
      });

      process.on('close', (code) => {
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

      process.on('error', (error) => {
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

  console.log(`[XTTS Pool] Loading voice ${voice} on ${workers.length} workers...`);

  // Load voice on all workers in parallel
  const loadPromises = workers.map(worker => loadVoiceOnWorker(worker, voice));
  const results = await Promise.all(loadPromises);

  const allSuccess = results.every(r => r.success);
  if (allSuccess) {
    currentVoice = voice;
    return { success: true };
  } else {
    const errors = results.filter(r => !r.success).map(r => r.error);
    return { success: false, error: errors.join(', ') };
  }
}

async function loadVoiceOnWorker(worker: Worker, voice: string): Promise<{ success: boolean; error?: string }> {
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
            worker.currentVoice = voice;
            resolve({ success: true });
          } else {
            resolve({ success: false, error: result.error });
          }
        }
      },
      sentenceIndex: -1  // Special marker for voice load
    };

    sendToWorker(worker, { action: 'load', voice });
  });
}

// FIFO queue of callers waiting for a free worker. A waiter MUST set
// worker.pendingRequest synchronously when invoked, so only one waiter is
// released per freed worker (no polling race).
const workerWaiters: Array<(worker: Worker | null) => void> = [];

function findFreeWorker(): Worker | undefined {
  return workers.find(w => w.isReady && !w.pendingRequest);
}

/** Called whenever a worker's pendingRequest is cleared. */
function releaseWorkerSlot(): void {
  const worker = findFreeWorker();
  if (!worker) return;
  const waiter = workerWaiters.shift();
  if (waiter) {
    waiter(worker);
  }
}

/**
 * Run `job` on a free worker, waiting FIFO if all are busy. The job MUST set
 * worker.pendingRequest synchronously when invoked - that reservation is what
 * prevents two callers from claiming the same worker. There must be NO await
 * between picking a free worker and running the job (an async gap here once
 * let 4 concurrent dispatches pile onto one worker while 3 sat idle).
 * Priority callers (the streamed playhead sentence) jump the queue so seeks
 * aren't stuck behind stale lookahead jobs.
 */
function runOnFreeWorker<T>(
  job: (worker: Worker) => Promise<T>,
  onNoWorkers: () => T,
  priority = false
): Promise<T> {
  const worker = findFreeWorker();
  if (worker) return job(worker);
  if (workers.length === 0) return Promise.resolve(onNoWorkers());
  return new Promise<T>(resolve => {
    const waiter = (w: Worker | null) => {
      if (!w) {
        resolve(onNoWorkers());
        return;
      }
      void job(w).then(resolve);
    };
    if (priority) {
      workerWaiters.unshift(waiter);
    } else {
      workerWaiters.push(waiter);
    }
  });
}

/** Wake all waiters with null (session ending / all workers gone). */
function drainWorkerWaiters(): void {
  while (workerWaiters.length > 0) {
    workerWaiters.shift()!(null);
  }
}

/**
 * Generate audio for a sentence using the next available worker
 */
export async function generateSentence(
  text: string,
  sentenceIndex: number,
  settings: PlaySettings
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  touchActivity();
  return runOnFreeWorker<{ success: boolean; audio?: AudioChunk; error?: string }>(
    worker => generateOnWorker(worker, text, sentenceIndex, settings),
    () => ({ success: false, error: 'No workers available' })
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
  onChunk: (chunk: StreamChunk) => void
): Promise<StreamResult> {
  touchActivity();
  return runOnFreeWorker<StreamResult>(
    worker => streamOnWorker(worker, text, settings, onChunk),
    () => ({ success: false, error: 'No workers available' }),
    true
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
    if (worker.process) {
      worker.process.kill('SIGTERM');
    }
  }

  workers = [];
  currentVoice = null;
  discoveredVoices = [];

  if (hadWorkers) {
    broadcast('play:session-ended', { code: 0 });
  }
}

/**
 * Check if session is active
 */
export function isSessionActive(): boolean {
  return workers.length > 0 && workers.some(w => w.isReady);
}

/**
 * Get available voices (discovered from e2a voices directory)
 */
export function getAvailableVoices(): string[] {
  // Return discovered voices, or empty if not yet discovered
  return discoveredVoices;
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
  getCurrentVoice,
  getWorkerCount
};

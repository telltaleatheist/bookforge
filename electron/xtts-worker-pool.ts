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
  type: 'ready' | 'status' | 'loaded' | 'audio' | 'error' | 'stopped';
  voices?: string[];
  voice?: string;
  message?: string;
  data?: string;
  duration?: number;
  sampleRate?: number;
}

interface PendingRequest {
  resolve: (result: { success: boolean; audio?: AudioChunk; error?: string }) => void;
  sentenceIndex: number;
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
const NUM_WORKERS = 3;  // Number of parallel workers

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let workers: Worker[] = [];
let mainWindow: BrowserWindow | null = null;
let currentVoice: string | null = null;
let nextWorkerIndex = 0;
let discoveredVoices: string[] = [];

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
        env: { ...global.process.env, PYTHONUNBUFFERED: '1' },
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
          worker.pendingRequest.resolve({ success: false, error: 'Worker died' });
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

/**
 * Generate audio for a sentence using the next available worker
 */
export async function generateSentence(
  text: string,
  sentenceIndex: number,
  settings: PlaySettings
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  const availableWorkers = workers.filter(w => w.isReady && !w.pendingRequest);

  if (availableWorkers.length === 0) {
    // All workers busy - wait for one to become available
    const worker = workers[nextWorkerIndex % workers.length];
    nextWorkerIndex++;

    // Wait for current request to complete
    if (worker.pendingRequest) {
      await new Promise<void>(resolve => {
        const checkInterval = setInterval(() => {
          if (!worker.pendingRequest) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);
      });
    }

    return generateOnWorker(worker, text, sentenceIndex, settings);
  }

  // Use round-robin for available workers
  const worker = availableWorkers[nextWorkerIndex % availableWorkers.length];
  nextWorkerIndex++;

  return generateOnWorker(worker, text, sentenceIndex, settings);
}

async function generateOnWorker(
  worker: Worker,
  text: string,
  sentenceIndex: number,
  settings: PlaySettings
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.pendingRequest = null;
      resolve({ success: false, error: 'Generation timeout' });
    }, 60000);

    worker.pendingRequest = {
      resolve: (result) => {
        clearTimeout(timeout);
        worker.pendingRequest = null;
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
      stream: true
    });
  });
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
  nextWorkerIndex = 0;
  discoveredVoices = [];
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
  console.log(`[XTTS Pool ${worker.id}] Response:`, response.type, response.message || '');

  if (response.type === 'loaded' && worker.pendingRequest?.sentenceIndex === -1) {
    // Voice load complete
    worker.pendingRequest?.resolve({ success: true });
  } else if (response.type === 'audio' && response.data && worker.pendingRequest) {
    const audio: AudioChunk = {
      data: response.data,
      duration: response.duration || 0,
      sampleRate: response.sampleRate || 24000
    };
    // Save sentenceIndex before resolve (which clears pendingRequest)
    const sentenceIndex = worker.pendingRequest.sentenceIndex;
    worker.pendingRequest.resolve({ success: true, audio });

    // Send IPC event
    if (mainWindow && sentenceIndex >= 0) {
      mainWindow.webContents.send('play:audio-generated', {
        sentenceIndex,
        audio
      });
    }
  } else if (response.type === 'audio' && response.data && !worker.pendingRequest) {
    // Audio arrived but request was cancelled - just ignore
    console.log(`[XTTS Pool ${worker.id}] Ignoring orphaned audio response`);
  } else if (response.type === 'error' && worker.pendingRequest) {
    worker.pendingRequest.resolve({ success: false, error: response.message });
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
  stop,
  endSession,
  isSessionActive,
  getAvailableVoices,
  getCurrentVoice,
  getWorkerCount
};

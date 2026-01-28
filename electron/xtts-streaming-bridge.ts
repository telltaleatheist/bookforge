/**
 * XTTS Streaming Bridge - Manages Python subprocess for TTS streaming
 *
 * This bridge spawns a Python process that loads the XTTS model once,
 * then accepts sentence requests and streams back audio.
 */

import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
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

export interface XTTSResponse {
  type: 'ready' | 'status' | 'loaded' | 'audio' | 'error' | 'stopped';
  voices?: string[];
  voice?: string;
  message?: string;
  data?: string;
  duration?: number;
  sampleRate?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const E2A_PATH = getDefaultE2aPath();

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let pythonProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let currentVoice: string | null = null;
let isReady = false;
let pendingCallback: ((response: XTTSResponse) => void) | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

/**
 * Start the XTTS streaming server subprocess
 */
export async function startSession(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
  if (pythonProcess) {
    return { success: true, voices: getAvailableVoices() };
  }

  return new Promise((resolve) => {
    try {
      // Find the Python script - it's in electron/scripts relative to app root
      const appPath = app.getAppPath();
      let scriptPath = path.join(appPath, 'electron', 'scripts', 'xtts_stream.py');

      // In development, the script is in the source folder
      // In production, it might be in resources
      if (!fs.existsSync(scriptPath)) {
        // Try relative to __dirname (dist/electron)
        scriptPath = path.join(__dirname, '..', '..', 'electron', 'scripts', 'xtts_stream.py');
      }

      if (!fs.existsSync(scriptPath)) {
        // Last resort: try the dist folder
        scriptPath = path.join(__dirname, 'scripts', 'xtts_stream.py');
      }

      console.log('[XTTS] Starting Python subprocess...');
      console.log('[XTTS] App path:', appPath);
      console.log('[XTTS] Script path:', scriptPath);
      console.log('[XTTS] Script exists:', fs.existsSync(scriptPath));

      // Spawn Python process using conda environment
      // getCondaRunArgs() handles prefix vs named env detection
      const condaArgs = [...getCondaRunArgs(E2A_PATH), scriptPath];
      pythonProcess = spawn(getCondaPath(), condaArgs, {
        cwd: E2A_PATH,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      console.log('[XTTS] Process spawned with PID:', pythonProcess.pid);

      // Set up readline for stdout
      if (pythonProcess.stdout) {
        const rl = readline.createInterface({
          input: pythonProcess.stdout,
          crlfDelay: Infinity
        });

        rl.on('line', (line: string) => {
          try {
            const response: XTTSResponse = JSON.parse(line);
            handleResponse(response);

            // Handle ready response
            if (response.type === 'ready') {
              isReady = true;
              resolve({ success: true, voices: response.voices });
            }
          } catch (err) {
            console.error('[XTTS] Failed to parse response:', line);
          }
        });
      }

      // Handle stderr
      pythonProcess.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log('[XTTS stderr]', msg);
        }
      });

      // Handle process exit
      pythonProcess.on('close', (code) => {
        console.log('[XTTS] Process exited with code:', code);
        pythonProcess = null;
        isReady = false;
        currentVoice = null;

        if (mainWindow) {
          mainWindow.webContents.send('play:session-ended', { code });
        }
      });

      pythonProcess.on('error', (error) => {
        console.error('[XTTS] Process error:', error);
        pythonProcess = null;
        isReady = false;
        resolve({ success: false, error: error.message });
      });

      // Timeout for startup
      setTimeout(() => {
        if (!isReady) {
          resolve({ success: false, error: 'Timeout waiting for XTTS to start' });
        }
      }, 60000); // 60 second timeout for model loading

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      resolve({ success: false, error: message });
    }
  });
}

/**
 * Load a voice model
 */
export async function loadVoice(voice: string): Promise<{ success: boolean; error?: string }> {
  if (!pythonProcess || !isReady) {
    return { success: false, error: 'Session not started' };
  }

  if (currentVoice === voice) {
    return { success: true };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let lastError: string | undefined;

    // Timeout after 120 seconds (model loading can be slow)
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        pendingCallback = null;
        resolve({ success: false, error: lastError || 'Timeout loading voice model' });
      }
    }, 120000);

    pendingCallback = (response) => {
      if (resolved) return;

      if (response.type === 'loaded') {
        resolved = true;
        clearTimeout(timeout);
        pendingCallback = null;
        currentVoice = response.voice || voice;
        resolve({ success: true });
      } else if (response.type === 'error') {
        // Store error but don't resolve yet - voice loading might still succeed
        lastError = response.message;
        console.log('[XTTS] Error during load (may recover):', response.message);
      }
    };

    sendCommand({ action: 'load', voice });
  });
}

/**
 * Generate audio for a sentence
 */
export async function generateSentence(
  text: string,
  sentenceIndex: number,
  settings: PlaySettings
): Promise<{ success: boolean; audio?: AudioChunk; error?: string }> {
  if (!pythonProcess || !isReady) {
    return { success: false, error: 'Session not started' };
  }

  // Load voice if needed
  if (currentVoice !== settings.voice) {
    const loadResult = await loadVoice(settings.voice);
    if (!loadResult.success) {
      return { success: false, error: loadResult.error };
    }
  }

  return new Promise((resolve) => {
    let resolved = false;

    // Timeout after 60 seconds per sentence
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        pendingCallback = null;
        resolve({ success: false, error: 'Timeout generating audio' });
      }
    }, 60000);

    pendingCallback = (response) => {
      if (resolved) return;

      if (response.type === 'audio' && response.data) {
        resolved = true;
        clearTimeout(timeout);
        pendingCallback = null;

        const audio = {
          data: response.data,
          duration: response.duration || 0,
          sampleRate: response.sampleRate || 24000
        };

        resolve({ success: true, audio });

        // Also send IPC event (for potential streaming use)
        if (mainWindow) {
          mainWindow.webContents.send('play:audio-generated', { sentenceIndex, audio });
        }
      } else if (response.type === 'error') {
        resolved = true;
        clearTimeout(timeout);
        pendingCallback = null;
        resolve({ success: false, error: response.message });
      }
    };

    sendCommand({
      action: 'generate',
      text,
      language: 'en',
      speed: settings.speed,
      temperature: settings.temperature || 0.65,  // Lower temperature for faster inference
      top_p: settings.topP || 0.85,
      repetition_penalty: settings.repetitionPenalty || 2.0,  // Lower penalty for faster inference
      stream: true  // Use streaming inference
    });
  });
}

/**
 * Stop current generation
 */
export function stop(): void {
  if (pythonProcess && isReady) {
    sendCommand({ action: 'stop' });
  }
}

/**
 * End the XTTS session
 */
export async function endSession(): Promise<void> {
  if (pythonProcess) {
    sendCommand({ action: 'quit' });

    // Give it a moment to exit gracefully
    await new Promise(resolve => setTimeout(resolve, 500));

    if (pythonProcess) {
      pythonProcess.kill('SIGTERM');
      pythonProcess = null;
    }
  }

  isReady = false;
  currentVoice = null;
}

/**
 * Check if session is active
 */
export function isSessionActive(): boolean {
  return pythonProcess !== null && isReady;
}

/**
 * Get available voices
 */
export function getAvailableVoices(): string[] {
  return [
    'ScarlettJohansson',
    'DavidAttenborough',
    'MorganFreeman',
    'NeilGaiman',
    'RayPorter',
    'RosamundPike',
    'internal'
  ];
}

/**
 * Get current voice
 */
export function getCurrentVoice(): string | null {
  return currentVoice;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendCommand(command: Record<string, unknown>): void {
  if (pythonProcess?.stdin) {
    const line = JSON.stringify(command) + '\n';
    pythonProcess.stdin.write(line);
  }
}

function handleResponse(response: XTTSResponse): void {
  console.log('[XTTS] Response:', response.type, response.message || '');

  // Send status updates to renderer
  if (response.type === 'status' && mainWindow) {
    mainWindow.webContents.send('play:status', { message: response.message });
  }

  // Handle pending callback - don't clear it here, let the callback clear itself
  // when it's done (callbacks now set pendingCallback = null when they resolve)
  if (pendingCallback) {
    pendingCallback(response);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export singleton-style interface
// ─────────────────────────────────────────────────────────────────────────────

export const xttsStreamingBridge = {
  setMainWindow,
  startSession,
  loadVoice,
  generateSentence,
  stop,
  endSession,
  isSessionActive,
  getAvailableVoices,
  getCurrentVoice
};

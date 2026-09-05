/**
 * TTS Bridge - ebook2audiobook subprocess management
 *
 * Manages the ebook2audiobook Python process for converting EPUBs to audiobooks.
 * Parses progress from stdout and emits events via IPC.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as logger from './audiobook-logger';
import { getDefaultE2aPath, getPythonInvocation, buildCondaSpawnEnv } from './e2a-paths';
import { isCudaTtsInstalled } from './components/cuda-tts';

const MAX_STDERR_BYTES = 10 * 1024;
function appendCapped(buf: string, chunk: string): string {
  buf += chunk;
  if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(-MAX_STDERR_BYTES);
  return buf;
}

/**
 * Kill a process and all its children (process tree)
 * On Windows, uses taskkill /F /T to force kill the entire tree
 * On Unix, uses process.kill with SIGKILL
 */
function killProcessTree(process: ChildProcess, label: string): void {
  if (!process || process.killed) return;

  const pid = process.pid;
  if (!pid) {
    console.log(`[TTS] ${label}: No PID, using SIGTERM`);
    try {
      process.kill('SIGTERM');
    } catch (err) {
      console.error(`[TTS] Failed to kill ${label}:`, err);
    }
    return;
  }

  if (os.platform() === 'win32') {
    // Windows: use taskkill to kill entire process tree
    console.log(`[TTS] Killing ${label} process tree (PID: ${pid})`);
    try {
      // /F = force, /T = tree (kill child processes)
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[TTS] Killed ${label} process tree`);
    } catch (err) {
      // Process may have already exited
      console.log(`[TTS] ${label} process tree kill returned (may have already exited)`);
    }
  } else {
    // Unix: SIGKILL for forceful termination
    console.log(`[TTS] Killing ${label} (PID: ${pid})`);
    try {
      process.kill('SIGKILL');
    } catch (err) {
      console.error(`[TTS] Failed to kill ${label}:`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionPhase = 'preparing' | 'converting' | 'merging' | 'complete' | 'error';

export interface TTSSettings {
  device: 'auto' | 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;        // e.g., 'xtts'
  fineTuned: string;        // voice model e.g., 'ScarlettJohansson'
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
}

export interface TTSProgress {
  phase: ConversionPhase;
  currentChapter: number;
  totalChapters: number;
  percentage: number;
  estimatedRemaining: number; // seconds
  message?: string;
  error?: string;
}

export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration?: number; // seconds
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let currentProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let startTime: number = 0;

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

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CAN THIS MACHINE RENDER? Answers `tts:check-available` (main.ts -> preload ->
 * audiobook.service.ts).
 *
 * It used to answer "does `<e2a>/app.py` exist", which stopped being a question
 * about anything at the cut-over: nothing spawns app.py, and after Phase 6 there
 * is no e2a checkout for the file to be in — so a working machine would report
 * itself unavailable, and a machine with the file and a broken environment would
 * report itself fine.
 *
 * `narratorReady()` asks the two things that decide it: the narrator package is in
 * this checkout, and the tools env's python can import `narrator.assemble`. It
 * caches, so this stays cheap to call from a status poll.
 */
export async function checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  const { narratorReady } = await import('./reassembly-bridge.js');
  if (narratorReady()) return { available: true, version: '1.0.0' };
  return {
    available: false,
    error: 'narrator is not ready on this machine: either python/narrator is missing from '
      + 'this checkout, or the tools environment cannot import narrator.assemble. '
      + 'The main-process log names which.',
  };
}

/**
 * Get available voice models
 */
export async function getVoices(): Promise<VoiceInfo[]> {
  // Default XTTS voices
  return [
    { id: 'en_default', name: 'English Default', language: 'en' },
    { id: 'en_male', name: 'English Male', language: 'en' },
    { id: 'en_female', name: 'English Female', language: 'en' },
    { id: 'es_default', name: 'Spanish Default', language: 'es' },
    { id: 'fr_default', name: 'French Default', language: 'fr' },
    { id: 'de_default', name: 'German Default', language: 'de' }
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseProgressLine(line: string, currentProgress: TTSProgress): TTSProgress {
  const trimmed = line.trim();

  // ebook2audiobook progress pattern: "Converting 0.50%: : 27/5223"
  const e2aMatch = trimmed.match(/Converting\s+([\d.]+)%.*?(\d+)\/(\d+)/i);
  if (e2aMatch) {
    const percent = parseFloat(e2aMatch[1]);
    const current = parseInt(e2aMatch[2]);
    const total = parseInt(e2aMatch[3]);
    return {
      ...currentProgress,
      phase: 'converting',
      currentChapter: current,
      totalChapters: total,
      percentage: percent, // Keep decimal precision for accurate progress
      message: `Converting sentence ${current} of ${total} (${percent.toFixed(1)}%)`
    };
  }

  // Simpler ebook2audiobook pattern: just "Converting X.XX%"
  const e2aSimpleMatch = trimmed.match(/Converting\s+([\d.]+)%/i);
  if (e2aSimpleMatch) {
    const percent = parseFloat(e2aSimpleMatch[1]);
    return {
      ...currentProgress,
      phase: 'converting',
      percentage: percent, // Keep decimal precision
      message: `Converting... ${percent.toFixed(1)}%`
    };
  }

  // Sentence progress pattern from e2a stderr: "4.00%: : 1/25" or "4.00%: 1/25"
  const sentenceMatch = trimmed.match(/^([\d.]+)%:\s*:?\s*(\d+)\/(\d+)/);
  if (sentenceMatch) {
    const percent = parseFloat(sentenceMatch[1]);
    const current = parseInt(sentenceMatch[2]);
    const total = parseInt(sentenceMatch[3]);
    return {
      ...currentProgress,
      phase: 'converting',
      currentChapter: current,
      totalChapters: total,
      percentage: percent,
      message: `Converting sentence ${current} of ${total} (${percent.toFixed(1)}%)`
    };
  }

  // Chapter progress pattern: "Processing chapter X of Y"
  const chapterMatch = trimmed.match(/chapter\s+(\d+)\s+of\s+(\d+)/i);
  if (chapterMatch) {
    const current = parseInt(chapterMatch[1]);
    const total = parseInt(chapterMatch[2]);
    return {
      ...currentProgress,
      phase: 'converting',
      currentChapter: current,
      totalChapters: total,
      percentage: Math.round((current / total) * 100),
      message: `Converting chapter ${current} of ${total}`
    };
  }

  // tqdm progress bar pattern: "XX%|" or "X/Y [XX:XX"
  // Exclude download progress (Fetching, Downloading) which shouldn't affect overall progress
  const tqdmMatch = trimmed.match(/(\d+)%\|/);
  if (tqdmMatch && !trimmed.toLowerCase().includes('fetching') && !trimmed.toLowerCase().includes('downloading')) {
    const percent = parseInt(tqdmMatch[1]);
    return {
      ...currentProgress,
      percentage: percent
    };
  }

  // Merging phase
  if (trimmed.toLowerCase().includes('merging') || trimmed.toLowerCase().includes('combining')) {
    return {
      ...currentProgress,
      phase: 'merging',
      percentage: 95,
      message: 'Merging chapters into final audiobook...'
    };
  }

  // Preparing phase
  if (trimmed.toLowerCase().includes('loading') || trimmed.toLowerCase().includes('initializing')) {
    return {
      ...currentProgress,
      phase: 'preparing',
      message: trimmed
    };
  }

  return currentProgress;
}

function estimateRemaining(progress: TTSProgress): number {
  if (progress.percentage <= 0 || startTime === 0) return 0;

  const elapsed = (Date.now() - startTime) / 1000;
  const rate = progress.percentage / elapsed;
  if (rate <= 0) return 0;

  const remaining = (100 - progress.percentage) / rate;
  return Math.round(remaining);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the logger when setting library path
 */
export async function initializeLogger(libraryPath: string): Promise<void> {
  await logger.initializeLogger(libraryPath);
}

// startConversion / stopConversion / isConverting stood here until 2026-09-05.
//
// THEY WERE THE LAST LIVE e2a DOOR. `startConversion` built
// `<e2a>/app.py --headless --tts_engine xtts --fine_tuned ScarlettJohansson`
// with the six XTTS sampling flags and `--skip_deps`, and it was reachable:
// `tts:start-conversion` -> preload -> `AudiobookService.startConversion`.
//
// What kept it from ever firing was an accident. `checkAvailable()` guarded it by
// asking "does <e2a>/app.py exist", so on a machine without the checkout the door
// refused itself. Re-pointing that guard at `narratorReady()` — the right fix for
// the guard — made it answer TRUE, which turned a dead door into a one-call path
// to spawning a file that is not there.
//
// The door is deleted rather than re-guarded, because `AudiobookService` had ZERO
// injectors in `src/app`: the whole `electron.tts.*` surface, its five IPC
// channels and its preload types were orphan wiring. Every real render goes
// through `parallel-tts:*` and `parallel-tts-bridge.ts`.
//
// `tools/test-no-e2a-doors.js` fails if any of it comes back.

// ─────────────────────────────────────────────────────────────────────────────
// Output Naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format contributors for filename:
 * 1 author: "Last, First"
 * 2 authors: "Last, First and Last, First"
 * 3+: "Last, First et al."
 */
function formatContributorsForFilename(contributors: Array<{ first: string; last: string }>): string {
  const valid = contributors.filter(c => c.first || c.last);
  if (valid.length === 0) return '';

  const fmt = (c: { first: string; last: string }) => {
    if (c.last && c.first) return `${c.last}, ${c.first}`;
    return c.last || c.first;
  };

  if (valid.length === 1) return fmt(valid[0]);
  if (valid.length === 2) return `${fmt(valid[0])} and ${fmt(valid[1])}`;
  return `${fmt(valid[0])} et al.`;
}

/**
 * Generate output filename from metadata
 * Format: [Title] - [Subtitle]. [Author Last], [Author First]. (year).m4b
 */
export function generateOutputFilename(
  title: string,
  subtitle?: string,
  author?: string,
  authorFileAs?: string,
  year?: string,
  contributors?: Array<{ first: string; last: string }>
): string {
  let filename = title.trim();

  if (subtitle?.trim()) {
    filename += ` - ${subtitle.trim()}`;
  }

  filename += '.';

  if (contributors && contributors.length > 0) {
    const authorStr = formatContributorsForFilename(contributors);
    if (authorStr) {
      filename += ` ${authorStr}.`;
    }
  } else if (authorFileAs?.trim()) {
    filename += ` ${authorFileAs.trim()}.`;
  } else if (author?.trim()) {
    // Auto-convert "First Last" to "Last, First"
    const parts = author.trim().split(' ');
    if (parts.length >= 2) {
      const last = parts.pop();
      filename += ` ${last}, ${parts.join(' ')}.`;
    } else {
      filename += ` ${author.trim()}.`;
    }
  }

  if (year?.trim()) {
    filename += ` (${year.trim()})`;
  }

  filename += '.m4b';

  // Clean up the filename: remove invalid characters, double spaces, etc.
  filename = filename
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename characters
    .replace(/\s+/g, ' ')         // Collapse multiple spaces
    .replace(/\.\s*\./g, '.')     // Remove double dots
    .trim();

  return filename;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export singleton-style interface
// ─────────────────────────────────────────────────────────────────────────────

export const ttsBridge = {
  setE2aPath,
  getE2aPath,
  setMainWindow,
  getVoices,
  generateOutputFilename,
  initializeLogger
};

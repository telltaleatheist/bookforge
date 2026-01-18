/**
 * TTS Bridge - ebook2audiobook subprocess management
 *
 * Manages the ebook2audiobook Python process for converting EPUBs to audiobooks.
 * Parses progress from stdout and emits events via IPC.
 */

import { spawn, ChildProcess } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionPhase = 'preparing' | 'converting' | 'merging' | 'complete' | 'error';

export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  voice: string;
  temperature: number;
  speed: number;
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

// Default path to ebook2audiobook - can be overridden in settings
const DEFAULT_E2A_PATH = '/Users/telltale/Projects/ebook2audiobook';
let e2aPath = DEFAULT_E2A_PATH;

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
  e2aPath = newPath;
}

export function getE2aPath(): string {
  return e2aPath;
}

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if ebook2audiobook is available
 */
export async function checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    // Check if the app.py exists
    const appPath = path.join(e2aPath, 'app.py');
    await fs.access(appPath);

    // Try to get version by running with --help or checking requirements
    // For now, just check existence
    return { available: true, version: '1.0.0' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { available: false, error: `ebook2audiobook not found at ${e2aPath}: ${message}` };
  }
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
  const tqdmMatch = trimmed.match(/(\d+)%\|/);
  if (tqdmMatch) {
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
 * Start TTS conversion
 */
export async function startConversion(
  epubPath: string,
  outputDir: string,
  settings: TTSSettings
): Promise<ConversionResult> {
  // Check availability first
  const available = await checkAvailable();
  if (!available.available) {
    return { success: false, error: available.error };
  }

  // Build command arguments
  const args = [
    'app.py',
    '--headless',
    '--ebook', epubPath,
    '--output_folder', outputDir,
    '--language', settings.language,
    '--device', settings.device
  ];

  if (settings.voice) {
    args.push('--voice', settings.voice);
  }

  if (settings.temperature !== 0.75) {
    args.push('--temperature', settings.temperature.toString());
  }

  if (settings.speed !== 1.0) {
    args.push('--length_scale', (1 / settings.speed).toString());
  }

  startTime = Date.now();

  return new Promise((resolve) => {
    let progress: TTSProgress = {
      phase: 'preparing',
      currentChapter: 0,
      totalChapters: 0,
      percentage: 0,
      estimatedRemaining: 0,
      message: 'Starting conversion...'
    };

    let stderr = '';
    let outputFile = '';

    currentProcess = spawn('python3', args, {
      cwd: e2aPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    currentProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          progress = parseProgressLine(line, progress);
          progress.estimatedRemaining = estimateRemaining(progress);

          // Look for output file path
          const outputMatch = line.match(/output[:\s]+(.+\.m4b)/i);
          if (outputMatch) {
            outputFile = outputMatch[1];
          }

          // Send progress update
          if (mainWindow) {
            mainWindow.webContents.send('tts:progress', progress);
          }
        }
      }
    });

    currentProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      // Also parse stderr for progress (some tools output there)
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          progress = parseProgressLine(line, progress);
          progress.estimatedRemaining = estimateRemaining(progress);

          if (mainWindow) {
            mainWindow.webContents.send('tts:progress', progress);
          }
        }
      }
    });

    currentProcess.on('close', (code) => {
      currentProcess = null;
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (code === 0) {
        // Send completion progress
        if (mainWindow) {
          mainWindow.webContents.send('tts:progress', {
            phase: 'complete',
            currentChapter: progress.totalChapters,
            totalChapters: progress.totalChapters,
            percentage: 100,
            estimatedRemaining: 0,
            message: 'Conversion complete!'
          });
        }

        resolve({
          success: true,
          outputPath: outputFile || path.join(outputDir, 'audiobook.m4b'),
          duration
        });
      } else {
        // Send error progress
        if (mainWindow) {
          mainWindow.webContents.send('tts:progress', {
            phase: 'error',
            currentChapter: progress.currentChapter,
            totalChapters: progress.totalChapters,
            percentage: progress.percentage,
            estimatedRemaining: 0,
            error: stderr || `Process exited with code ${code}`
          });
        }

        resolve({
          success: false,
          error: stderr || `Process exited with code ${code}`,
          duration
        });
      }
    });

    currentProcess.on('error', (error) => {
      currentProcess = null;

      if (mainWindow) {
        mainWindow.webContents.send('tts:progress', {
          phase: 'error',
          currentChapter: 0,
          totalChapters: 0,
          percentage: 0,
          estimatedRemaining: 0,
          error: error.message
        });
      }

      resolve({
        success: false,
        error: error.message
      });
    });
  });
}

/**
 * Stop the current conversion
 */
export function stopConversion(): boolean {
  if (currentProcess) {
    currentProcess.kill('SIGTERM');
    currentProcess = null;
    return true;
  }
  return false;
}

/**
 * Check if a conversion is in progress
 */
export function isConverting(): boolean {
  return currentProcess !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate output filename from metadata
 * Format: [Title] - [Subtitle]. [Author Last], [Author First]. (year).m4b
 */
export function generateOutputFilename(
  title: string,
  subtitle?: string,
  author?: string,
  authorFileAs?: string,
  year?: string
): string {
  let filename = title.trim();

  if (subtitle?.trim()) {
    filename += ` - ${subtitle.trim()}`;
  }

  filename += '.';

  if (authorFileAs?.trim()) {
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
  checkAvailable,
  getVoices,
  startConversion,
  stopConversion,
  isConverting,
  generateOutputFilename
};

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
  settings: TTSSettings,
  onProgress?: (progress: TTSProgress) => void,
  desiredFilename?: string
): Promise<ConversionResult> {
  // Check availability first
  const available = await checkAvailable();
  if (!available.available) {
    return { success: false, error: available.error };
  }

  // Build command arguments - matching BookForge's _build_tts_command
  const appPath = path.join(e2aPath, 'app.py');
  const args = [
    appPath,
    '--headless',
    '--ebook', epubPath,
    '--output_dir', outputDir,
    '--device', settings.device,
    '--language', settings.language,
    '--tts_engine', settings.ttsEngine || 'xtts',
    '--fine_tuned', settings.fineTuned || 'ScarlettJohansson',
    '--temperature', settings.temperature.toString(),
    '--top_p', settings.topP.toString(),
    '--top_k', settings.topK.toString(),
    '--repetition_penalty', settings.repetitionPenalty.toString(),
    '--speed', settings.speed.toString()
  ];

  if (settings.enableTextSplitting) {
    args.push('--enable_text_splitting');
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

    // Use conda run to activate the ebook2audiobook environment
    // --no-capture-output prevents conda from buffering all stdout/stderr
    const fullArgs = ['run', '--no-capture-output', '-n', 'ebook2audiobook', 'python', ...args];
    console.log('[TTS] Starting ebook2audiobook with command:');
    console.log('[TTS]   conda', fullArgs.join(' '));
    console.log('[TTS]   cwd:', e2aPath);

    currentProcess = spawn('conda', fullArgs, {
      cwd: e2aPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      shell: true
    });

    console.log('[TTS] Process spawned with PID:', currentProcess.pid);

    currentProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log('[TTS stdout]', line.trim());
          progress = parseProgressLine(line, progress);
          progress.estimatedRemaining = estimateRemaining(progress);

          // Look for output file path - must be an actual file path, not part of ffmpeg command
          // Match patterns like "Output: /path/to/file.m4b" or "Saved to /path/to/file.m4b"
          // The path must start with / (absolute) or a drive letter
          const outputMatch = line.match(/(?:output|saved to|created|wrote)[:\s]+(['"]?)([\/~][\w\s\-\/.,'()]+\.m4b)\1/i) ||
                              line.match(/(?:output|saved to|created|wrote)[:\s]+(['"]?)([A-Z]:[\\\/][\w\s\-\\.,'()]+\.m4b)\1/i);
          if (outputMatch) {
            outputFile = outputMatch[2].trim();
            console.log('[TTS] Detected output file from log:', outputFile);
          }

          // Send progress update
          if (mainWindow) {
            mainWindow.webContents.send('tts:progress', progress);
          }
          // Also call the progress callback if provided
          if (onProgress) {
            onProgress(progress);
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
          console.log('[TTS stderr]', line.trim());
          progress = parseProgressLine(line, progress);
          progress.estimatedRemaining = estimateRemaining(progress);

          if (mainWindow) {
            mainWindow.webContents.send('tts:progress', progress);
          }
          // Also call the progress callback if provided
          if (onProgress) {
            onProgress(progress);
          }
        }
      }
    });

    currentProcess.on('close', async (code) => {
      console.log('[TTS] Process closed with code:', code);
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

        // Find the actual output file
        // First verify if detected path exists, otherwise search the output directory
        let finalOutputPath = '';

        // Check if detected output file actually exists
        if (outputFile) {
          try {
            await fs.access(outputFile);
            finalOutputPath = outputFile;
            console.log('[TTS] Verified detected output file exists:', finalOutputPath);
          } catch {
            console.log('[TTS] Detected output path does not exist, will search directory');
          }
        }

        // If no valid path found, search the output directory for the most recent .m4b file
        if (!finalOutputPath) {
          try {
            const files = await fs.readdir(outputDir);
            const m4bFiles = files.filter(f => f.endsWith('.m4b'));

            if (m4bFiles.length > 0) {
              // If multiple files, find the most recently modified one
              let mostRecent = { file: m4bFiles[0], mtime: 0 };
              for (const file of m4bFiles) {
                const filePath = path.join(outputDir, file);
                const stat = await fs.stat(filePath);
                if (stat.mtimeMs > mostRecent.mtime) {
                  mostRecent = { file, mtime: stat.mtimeMs };
                }
              }
              finalOutputPath = path.join(outputDir, mostRecent.file);
              console.log('[TTS] Found most recent output file:', finalOutputPath);
            }
          } catch (err) {
            console.error('[TTS] Error finding output file:', err);
          }
        }

        // Rename to desired filename if provided
        if (finalOutputPath && desiredFilename) {
          try {
            const desiredPath = path.join(outputDir, desiredFilename);
            if (finalOutputPath !== desiredPath) {
              // Verify source file exists before renaming
              await fs.access(finalOutputPath);
              await fs.rename(finalOutputPath, desiredPath);
              console.log('[TTS] Renamed output file to:', desiredPath);
              finalOutputPath = desiredPath;
            }
          } catch (err) {
            console.error('[TTS] Error renaming output file:', err);
            console.error('[TTS] Source path was:', finalOutputPath);
            console.error('[TTS] Desired path was:', path.join(outputDir, desiredFilename));
            // Continue with original filename if rename fails
          }
        }

        resolve({
          success: true,
          outputPath: finalOutputPath || path.join(outputDir, 'audiobook.m4b'),
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

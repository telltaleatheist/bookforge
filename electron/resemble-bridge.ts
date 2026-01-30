/**
 * Resemble Enhance Bridge
 *
 * Handles audio enhancement via Resemble Enhance for post-processing TTS output.
 * Resemble Enhance removes reverb, echo, and enhances speech quality.
 * Works better than DeepFilterNet for TTS artifacts like Orpheus's baked-in reverb.
 *
 * Setup:
 * - Requires 'resemble' conda environment with patched resemble-enhance
 * - See AUDIO_ENHANCEMENT.md for detailed setup instructions
 * - CPU mode is recommended for stability (MPS has issues on Mac)
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { getCondaPath, getFfmpegPath, getResembleCondaEnv } from './tool-paths';

// Supported audio formats
const SUPPORTED_FORMATS = ['.m4b', '.m4a', '.mp3', '.wav', '.flac', '.ogg', '.opus'];

interface AudioFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  format: string;
}

interface EnhanceProgress {
  phase: 'starting' | 'converting' | 'enhancing' | 'finalizing' | 'complete' | 'error';
  percentage: number;
  message: string;
  error?: string;
}

interface EnhanceResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let activeProcess: ChildProcess | null = null;

/**
 * Initialize the bridge with the main window reference
 */
export function initResembleBridge(window: BrowserWindow): void {
  mainWindow = window;
}

/**
 * List audio files in the audiobooks output directory
 */
export async function listAudioFiles(audiobooksDir: string): Promise<AudioFile[]> {
  const files: AudioFile[] = [];

  if (!audiobooksDir || !fs.existsSync(audiobooksDir)) {
    return files;
  }

  const entries = fs.readdirSync(audiobooksDir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files and macOS resource forks
    if (entry.name.startsWith('.') || entry.name.startsWith('._')) {
      continue;
    }

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_FORMATS.includes(ext)) {
        const filePath = path.join(audiobooksDir, entry.name);
        const stats = fs.statSync(filePath);
        files.push({
          name: entry.name,
          path: filePath,
          size: stats.size,
          modifiedAt: stats.mtime,
          format: ext.slice(1).toUpperCase()
        });
      }
    }
  }

  // Sort by modified date, newest first
  files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  return files;
}

/**
 * Emit progress to the renderer
 */
function emitProgress(progress: EnhanceProgress): void {
  if (mainWindow) {
    mainWindow.webContents.send('resemble:progress', progress);
  }
}

/**
 * Run Resemble Enhance on an audio file
 *
 * For M4B/M4A files:
 * 1. Extract audio to WAV using ffmpeg (44100Hz for resemble-enhance)
 * 2. Run resemble-enhance on the WAV
 * 3. Re-encode back to original format with ffmpeg
 * 4. Replace original file
 */
export async function enhanceFile(inputPath: string): Promise<EnhanceResult> {
  const ext = path.extname(inputPath).toLowerCase();
  const dir = path.dirname(inputPath);
  const basename = path.basename(inputPath, ext);

  // Temp directories and files
  const tempInputDir = path.join(dir, `${basename}_enhance_input`);
  const tempOutputDir = path.join(dir, `${basename}_enhance_output`);
  const tempWav = path.join(tempInputDir, 'audio.wav');
  const enhancedWav = path.join(tempOutputDir, 'audio.wav');
  const tempOutput = path.join(dir, `${basename}_temp_output${ext}`);
  const backupPath = path.join(dir, `${basename}_backup${ext}`);

  const condaPath = getCondaPath();
  const ffmpegPath = getFfmpegPath();
  const condaEnv = getResembleCondaEnv();

  try {
    // Create temp directories
    if (!fs.existsSync(tempInputDir)) {
      fs.mkdirSync(tempInputDir, { recursive: true });
    }
    if (!fs.existsSync(tempOutputDir)) {
      fs.mkdirSync(tempOutputDir, { recursive: true });
    }

    // Step 1: Convert to WAV if needed (44100Hz for resemble-enhance)
    if (ext !== '.wav') {
      emitProgress({ phase: 'converting', percentage: 10, message: 'Extracting audio to WAV...' });

      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
          '-y', '-i', inputPath,
          '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '1',
          tempWav
        ], {
          windowsHide: true
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg extraction failed with code ${code}`));
        });

        ffmpeg.on('error', reject);
      });
    } else {
      // Copy WAV to temp input dir
      fs.copyFileSync(inputPath, tempWav);
    }

    // Step 2: Run Resemble Enhance
    emitProgress({ phase: 'enhancing', percentage: 20, message: 'Running Resemble Enhance (this may take a while)...' });

    await new Promise<void>((resolve, reject) => {
      // Use conda run to execute resemble-enhance in the correct environment
      // CPU mode is more stable than MPS on Mac
      activeProcess = spawn(condaPath, [
        'run', '-n', condaEnv, '--no-capture-output',
        'resemble-enhance', tempInputDir, tempOutputDir, '--device', 'cpu'
      ], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true
      });

      let stderr = '';

      activeProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log('[RESEMBLE]', output.trim());

        // Parse progress from tqdm-style output
        const progressMatch = output.match(/(\d+)%\|/);
        if (progressMatch) {
          const pct = parseInt(progressMatch[1]);
          emitProgress({
            phase: 'enhancing',
            percentage: 20 + (pct * 0.6), // 20-80% range
            message: `Enhancing audio: ${pct}%`
          });
        }
      });

      activeProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        const output = data.toString();
        console.log('[RESEMBLE STDERR]', output.trim());

        // Progress also comes through stderr for tqdm
        const progressMatch = output.match(/(\d+)%\|/);
        if (progressMatch) {
          const pct = parseInt(progressMatch[1]);
          emitProgress({
            phase: 'enhancing',
            percentage: 20 + (pct * 0.6),
            message: `Enhancing audio: ${pct}%`
          });
        }
      });

      activeProcess.on('close', (code) => {
        activeProcess = null;
        if (code === 0) resolve();
        else reject(new Error(`Resemble Enhance failed with code ${code}: ${stderr}`));
      });

      activeProcess.on('error', (err) => {
        activeProcess = null;
        reject(err);
      });
    });

    // Verify enhanced file exists
    if (!fs.existsSync(enhancedWav)) {
      throw new Error('Resemble Enhance did not produce output file');
    }

    // Step 3: Convert back to original format if needed
    if (ext !== '.wav') {
      emitProgress({ phase: 'finalizing', percentage: 85, message: 'Re-encoding to original format...' });

      // Use appropriate codec based on format
      let codecArgs: string[];
      if (ext === '.m4b') {
        // M4B is an audiobook format using MPEG-4 container with AAC audio
        codecArgs = ['-c:a', 'aac', '-b:a', '128k', '-f', 'mp4'];
      } else if (ext === '.m4a') {
        codecArgs = ['-c:a', 'aac', '-b:a', '128k', '-f', 'ipod'];
      } else if (ext === '.mp3') {
        codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
      } else if (ext === '.flac') {
        codecArgs = ['-c:a', 'flac'];
      } else if (ext === '.ogg' || ext === '.opus') {
        codecArgs = ['-c:a', 'libopus', '-b:a', '128k'];
      } else {
        codecArgs = ['-c:a', 'copy'];
      }

      // Run FFmpeg encoding
      await new Promise<void>((resolve, reject) => {
        console.log('[RESEMBLE] Re-encoding with ffmpeg:', ffmpegPath);
        console.log('[RESEMBLE] Input:', enhancedWav);
        console.log('[RESEMBLE] Output:', tempOutput);

        const ffmpeg = spawn(ffmpegPath, [
          '-y', '-i', enhancedWav,
          ...codecArgs,
          tempOutput
        ], {
          windowsHide: true
        });

        let ffmpegStderr = '';
        ffmpeg.stderr?.on('data', (data) => {
          ffmpegStderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else {
            console.error('[RESEMBLE] FFmpeg stderr:', ffmpegStderr);
            reject(new Error(`FFmpeg encoding failed with code ${code}`));
          }
        });

        ffmpeg.on('error', reject);
      });
    }

    const finalOutput = ext === '.wav' ? enhancedWav : tempOutput;

    // Step 4: Replace original file
    emitProgress({ phase: 'finalizing', percentage: 95, message: 'Replacing original file...' });

    // Backup original
    fs.copyFileSync(inputPath, backupPath);

    // Replace with enhanced version
    fs.copyFileSync(finalOutput, inputPath);

    // Clean up temp files and directories
    const tempItems = [tempInputDir, tempOutputDir, tempOutput, backupPath];
    for (const item of tempItems) {
      if (fs.existsSync(item)) {
        try {
          if (fs.statSync(item).isDirectory()) {
            fs.rmSync(item, { recursive: true, force: true });
          } else {
            fs.unlinkSync(item);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    emitProgress({ phase: 'complete', percentage: 100, message: 'Enhancement complete!' });

    return { success: true, outputPath: inputPath };

  } catch (error) {
    // Clean up temp files on error
    const tempItems = [tempInputDir, tempOutputDir, tempOutput];
    for (const item of tempItems) {
      if (fs.existsSync(item)) {
        try {
          if (fs.statSync(item).isDirectory()) {
            fs.rmSync(item, { recursive: true, force: true });
          } else {
            fs.unlinkSync(item);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    emitProgress({ phase: 'error', percentage: 0, message: 'Enhancement failed', error: errorMessage });

    return { success: false, error: errorMessage };
  }
}

/**
 * Cancel the current enhancement operation
 */
export function cancelEnhance(): boolean {
  if (activeProcess) {
    // On Windows, use SIGKILL as SIGTERM may not work properly
    const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
    activeProcess.kill(signal);
    activeProcess = null;
    return true;
  }
  return false;
}

/**
 * Check if Resemble Enhance is available
 */
export async function checkResembleAvailable(): Promise<{ available: boolean; error?: string }> {
  const condaPath = getCondaPath();
  const condaEnv = getResembleCondaEnv();

  return new Promise((resolve) => {
    const check = spawn(condaPath, [
      'run', '-n', condaEnv, '--no-capture-output',
      'resemble-enhance', '--help'
    ], {
      windowsHide: true
    });

    let stderr = '';

    check.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    check.on('close', (code) => {
      if (code === 0) {
        resolve({ available: true });
      } else {
        resolve({ available: false, error: stderr || 'Resemble Enhance not found. See AUDIO_ENHANCEMENT.md for setup.' });
      }
    });

    check.on('error', (err) => {
      resolve({ available: false, error: err.message });
    });

    // Timeout after 15 seconds
    setTimeout(() => {
      check.kill();
      resolve({ available: false, error: 'Timeout checking Resemble Enhance' });
    }, 15000);
  });
}

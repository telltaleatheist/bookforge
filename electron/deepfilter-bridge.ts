/**
 * DeepFilterNet Bridge
 *
 * Handles audio denoising via DeepFilterNet for post-processing TTS output.
 * DeepFilterNet removes background noise, echo, and static from speech audio.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';

// Conda environment that has DeepFilterNet installed
const CONDA_ENV = 'ebook2audiobook';

// Supported audio formats
const SUPPORTED_FORMATS = ['.m4b', '.m4a', '.mp3', '.wav', '.flac', '.ogg', '.opus'];

interface AudioFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  format: string;
}

interface DenoiseProgress {
  phase: 'starting' | 'converting' | 'denoising' | 'finalizing' | 'complete' | 'error';
  percentage: number;
  message: string;
  error?: string;
}

interface DenoiseResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let activeProcess: ReturnType<typeof spawn> | null = null;

/**
 * Initialize the bridge with the main window reference
 */
export function initDeepFilterBridge(window: BrowserWindow): void {
  mainWindow = window;
}

/**
 * Get conda executable path
 */
function getCondaPath(): string {
  const possiblePaths = [
    '/opt/homebrew/Caskroom/miniconda/base/condabin/conda',
    '/opt/homebrew/bin/conda',
    '/usr/local/bin/conda',
    path.join(process.env.HOME || '', 'miniconda3/bin/conda'),
    path.join(process.env.HOME || '', 'anaconda3/bin/conda'),
    'conda'
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return 'conda';
}

/**
 * Get ffmpeg path
 */
function getFfmpegPath(): string {
  const possiblePaths = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg'
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return 'ffmpeg';
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
function emitProgress(progress: DenoiseProgress): void {
  if (mainWindow) {
    mainWindow.webContents.send('deepfilter:progress', progress);
  }
}

/**
 * Run DeepFilterNet on an audio file
 *
 * For M4B/M4A files:
 * 1. Extract audio to WAV using ffmpeg
 * 2. Run deepFilter on the WAV
 * 3. Re-encode back to original format with ffmpeg
 * 4. Replace original file
 */
export async function denoiseFile(inputPath: string): Promise<DenoiseResult> {
  const ext = path.extname(inputPath).toLowerCase();
  const dir = path.dirname(inputPath);
  const basename = path.basename(inputPath, ext);

  // Temp files
  const tempWav = path.join(dir, `${basename}_temp_input.wav`);
  const denoisedWav = path.join(dir, `${basename}_temp_denoised.wav`);
  const tempOutput = path.join(dir, `${basename}_temp_output${ext}`);
  const backupPath = path.join(dir, `${basename}_backup${ext}`);

  const condaPath = getCondaPath();
  const ffmpegPath = getFfmpegPath();

  try {
    // Step 1: Convert to WAV if needed
    if (ext !== '.wav') {
      emitProgress({ phase: 'converting', percentage: 10, message: 'Extracting audio to WAV...' });

      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
          '-y', '-i', inputPath,
          '-vn', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1',
          tempWav
        ]);

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg extraction failed with code ${code}`));
        });

        ffmpeg.on('error', reject);
      });
    }

    const inputWav = ext === '.wav' ? inputPath : tempWav;

    // Step 2: Run DeepFilterNet
    emitProgress({ phase: 'denoising', percentage: 30, message: 'Running DeepFilterNet...' });

    await new Promise<void>((resolve, reject) => {
      // Use conda run to execute deepFilter in the correct environment
      activeProcess = spawn(condaPath, [
        'run', '-n', CONDA_ENV, '--no-capture-output',
        'deepFilter', inputWav, '-o', denoisedWav
      ], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      let stderr = '';

      activeProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log('[DEEPFILTER]', output.trim());

        // Try to parse progress from output
        const progressMatch = output.match(/(\d+)%/);
        if (progressMatch) {
          const pct = parseInt(progressMatch[1]);
          emitProgress({
            phase: 'denoising',
            percentage: 30 + (pct * 0.5), // 30-80% range
            message: `Denoising: ${pct}%`
          });
        }
      });

      activeProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
        console.log('[DEEPFILTER STDERR]', data.toString().trim());
      });

      activeProcess.on('close', (code) => {
        activeProcess = null;
        if (code === 0) resolve();
        else reject(new Error(`DeepFilter failed with code ${code}: ${stderr}`));
      });

      activeProcess.on('error', (err) => {
        activeProcess = null;
        reject(err);
      });
    });

    // Verify denoised file exists
    if (!fs.existsSync(denoisedWav)) {
      // DeepFilter might output with different naming - check for alternatives
      const possibleOutputs = [
        denoisedWav,
        path.join(dir, `${basename}_temp_input_DeepFilterNet3.wav`),
        path.join(dir, `${path.basename(tempWav, '.wav')}_DeepFilterNet3.wav`)
      ];

      let foundOutput: string | null = null;
      for (const p of possibleOutputs) {
        if (fs.existsSync(p)) {
          foundOutput = p;
          break;
        }
      }

      if (!foundOutput) {
        throw new Error('DeepFilter did not produce output file');
      }

      // Rename to expected path
      fs.renameSync(foundOutput, denoisedWav);
    }

    // Step 3: Convert back to original format if needed
    if (ext !== '.wav') {
      emitProgress({ phase: 'finalizing', percentage: 85, message: 'Re-encoding to original format...' });

      await new Promise<void>((resolve, reject) => {
        // Use appropriate codec based on format
        let codecArgs: string[];
        if (ext === '.m4b' || ext === '.m4a') {
          codecArgs = ['-c:a', 'aac', '-b:a', '128k'];
        } else if (ext === '.mp3') {
          codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
        } else if (ext === '.flac') {
          codecArgs = ['-c:a', 'flac'];
        } else if (ext === '.ogg' || ext === '.opus') {
          codecArgs = ['-c:a', 'libopus', '-b:a', '128k'];
        } else {
          codecArgs = ['-c:a', 'copy'];
        }

        const ffmpeg = spawn(ffmpegPath, [
          '-y', '-i', denoisedWav,
          ...codecArgs,
          tempOutput
        ]);

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg encoding failed with code ${code}`));
        });

        ffmpeg.on('error', reject);
      });
    }

    const finalOutput = ext === '.wav' ? denoisedWav : tempOutput;

    // Step 4: Replace original file
    emitProgress({ phase: 'finalizing', percentage: 95, message: 'Replacing original file...' });

    // Backup original
    fs.copyFileSync(inputPath, backupPath);

    // Replace with denoised version
    fs.copyFileSync(finalOutput, inputPath);

    // Clean up temp files
    const tempFiles = [tempWav, denoisedWav, tempOutput, backupPath];
    for (const f of tempFiles) {
      if (fs.existsSync(f) && f !== inputPath) {
        try {
          fs.unlinkSync(f);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    emitProgress({ phase: 'complete', percentage: 100, message: 'Denoising complete!' });

    return { success: true, outputPath: inputPath };

  } catch (error) {
    // Clean up temp files on error
    const tempFiles = [tempWav, denoisedWav, tempOutput];
    for (const f of tempFiles) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    emitProgress({ phase: 'error', percentage: 0, message: 'Denoising failed', error: errorMessage });

    return { success: false, error: errorMessage };
  }
}

/**
 * Cancel the current denoising operation
 */
export function cancelDenoise(): boolean {
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    activeProcess = null;
    return true;
  }
  return false;
}

/**
 * Check if DeepFilterNet is available
 */
export async function checkDeepFilterAvailable(): Promise<{ available: boolean; error?: string }> {
  const condaPath = getCondaPath();

  return new Promise((resolve) => {
    const check = spawn(condaPath, [
      'run', '-n', CONDA_ENV, '--no-capture-output',
      'deepFilter', '--help'
    ]);

    let stderr = '';

    check.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    check.on('close', (code) => {
      if (code === 0) {
        resolve({ available: true });
      } else {
        resolve({ available: false, error: stderr || 'DeepFilterNet not found' });
      }
    });

    check.on('error', (err) => {
      resolve({ available: false, error: err.message });
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      check.kill();
      resolve({ available: false, error: 'Timeout checking DeepFilterNet' });
    }, 10000);
  });
}

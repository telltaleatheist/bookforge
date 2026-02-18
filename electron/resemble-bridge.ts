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
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import {
  getCondaPath,
  getFfmpegPath,
  getResembleCondaEnv,
  getResembleDevice,
  shouldUseWsl2ForResemble,
  getWslCondaPath,
  getWslResembleCondaEnv,
  getWslDistro,
  windowsToWslPath
} from './tool-paths';

const MAX_STDERR_BYTES = 10 * 1024;
function appendCapped(buf: string, chunk: string): string {
  buf += chunk;
  if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(-MAX_STDERR_BYTES);
  return buf;
}

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

interface TqdmProgress {
  percentage: number;
  current: number;
  total: number;
  elapsed?: string;
  remaining?: string;
  rate?: string;
}

interface EnhanceResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let activeProcess: ChildProcess | null = null;

/**
 * Parse tqdm-style progress output
 * Example: "33%|███▎      | 2/6 [00:07<00:14, 3.59s/it]"
 */
function parseTqdmProgress(output: string): TqdmProgress | null {
  // Match pattern: percentage|bar| current/total [elapsed<remaining, rate]
  const match = output.match(/(\d+)%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[([^\]<]*)<([^,\]]*),?\s*([^\]]*)\]/);
  if (match) {
    return {
      percentage: parseInt(match[1]),
      current: parseInt(match[2]),
      total: parseInt(match[3]),
      elapsed: match[4].trim() || undefined,
      remaining: match[5].trim() || undefined,
      rate: match[6].trim() || undefined
    };
  }

  // Simpler fallback: just percentage
  const simpleMatch = output.match(/(\d+)%\|/);
  if (simpleMatch) {
    return {
      percentage: parseInt(simpleMatch[1]),
      current: 0,
      total: 0
    };
  }

  return null;
}

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
    // Clean up any leftover temp directories from previous cancelled/failed jobs
    for (const tempDir of [tempInputDir, tempOutputDir]) {
      if (fs.existsSync(tempDir)) {
        console.log(`[RESEMBLE] Cleaning up leftover temp directory: ${tempDir}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
    if (fs.existsSync(tempOutput)) {
      console.log(`[RESEMBLE] Cleaning up leftover temp file: ${tempOutput}`);
      fs.unlinkSync(tempOutput);
    }

    // Create temp directories
    fs.mkdirSync(tempInputDir, { recursive: true });
    fs.mkdirSync(tempOutputDir, { recursive: true });

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
    const device = getResembleDevice();
    const useWsl = shouldUseWsl2ForResemble();

    emitProgress({ phase: 'enhancing', percentage: 20, message: `Running Resemble Enhance on ${device.toUpperCase()}${useWsl ? ' (WSL)' : ''} (this may take a while)...` });

    console.log(`[RESEMBLE] Using device: ${device}, WSL: ${useWsl}`);

    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      // Build environment with device-specific settings
      const envVars: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      };

      if (useWsl) {
        // Use WSL for Resemble Enhance on Windows
        const wslCondaPath = getWslCondaPath();
        const wslCondaEnv = getWslResembleCondaEnv();
        const wslInputDir = windowsToWslPath(tempInputDir);
        const wslOutputDir = windowsToWslPath(tempOutputDir);
        const distro = getWslDistro();

        // Build the bash command to run in WSL
        const condaBase = wslCondaPath.replace(/\/bin\/conda$/, '');
        const bashCommand = `source ${condaBase}/etc/profile.d/conda.sh && conda activate ${wslCondaEnv} && resemble-enhance "${wslInputDir}" "${wslOutputDir}" --device ${device}`;

        console.log(`[RESEMBLE] WSL command: ${bashCommand}`);

        const wslArgs = distro
          ? ['-d', distro, 'bash', '-c', bashCommand]
          : ['bash', '-c', bashCommand];

        activeProcess = spawn('wsl.exe', wslArgs, {
          env: envVars,
          windowsHide: true
        });
      } else {
        // Direct spawn (macOS/Linux or Windows without WSL)
        activeProcess = spawn(condaPath, [
          'run', '-n', condaEnv, '--no-capture-output',
          'resemble-enhance', tempInputDir, tempOutputDir, '--device', device
        ], {
          env: envVars,
          windowsHide: true
        });
      }

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
        const output = data.toString();
        stderr = appendCapped(stderr, output);

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
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`[RESEMBLE] Enhancement completed in ${elapsed}s`);
          resolve();
        } else {
          reject(new Error(`Resemble Enhance failed with code ${code}: ${stderr}`));
        }
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
      // Note: -movflags +faststart moves moov atom to beginning, making files
      // more resilient to truncation and better for streaming
      let ffmpegArgs: string[];
      if (ext === '.m4b' || ext === '.m4a') {
        // M4B/M4A: Use original file as second input to copy metadata, chapters, and cover art
        // -i enhancedWav: audio source (input 0)
        // -i inputPath: metadata/chapters/cover source (input 1)
        // -map 0:a: take audio from input 0
        // -map 1:v?: take video (cover art) from input 1 if present
        // -map_metadata 1: copy metadata from input 1
        // -map_chapters 1: copy chapters from input 1
        // -c:v copy: copy video stream without re-encoding
        ffmpegArgs = [
          '-y',
          '-i', enhancedWav,
          '-i', inputPath,
          '-map', '0:a',
          '-map', '1:v?',
          '-map_metadata', '1',
          '-map_chapters', '1',
          '-c:a', 'aac', '-b:a', '128k',
          '-c:v', 'copy',
          '-f', 'ipod', '-movflags', '+faststart',
          tempOutput
        ];
      } else if (ext === '.mp3') {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'libmp3lame', '-b:a', '192k', tempOutput];
      } else if (ext === '.flac') {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'flac', tempOutput];
      } else if (ext === '.ogg' || ext === '.opus') {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'libopus', '-b:a', '128k', tempOutput];
      } else {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'copy', tempOutput];
      }

      // Run FFmpeg encoding
      await new Promise<void>((resolve, reject) => {
        console.log('[RESEMBLE] Re-encoding with ffmpeg:', ffmpegPath);
        console.log('[RESEMBLE] Args:', ffmpegArgs.join(' '));

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
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

    // Verify the re-encoded file exists and has content
    if (!fs.existsSync(finalOutput)) {
      throw new Error(`Re-encoded file not found: ${finalOutput}`);
    }
    const finalOutputStats = fs.statSync(finalOutput);
    if (finalOutputStats.size === 0) {
      throw new Error(`Re-encoded file is empty: ${finalOutput}`);
    }
    console.log(`[RESEMBLE] Re-encoded file size: ${(finalOutputStats.size / 1024 / 1024).toFixed(1)} MB`);

    // For MP4/M4B/M4A files, verify the container is valid using ffprobe
    if (['.m4b', '.m4a', '.mp4'].includes(ext)) {
      console.log('[RESEMBLE] Validating MP4 container...');
      await new Promise<void>((resolve, reject) => {
        const ffprobe = spawn(ffmpegPath.replace('ffmpeg', 'ffprobe'), [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          finalOutput
        ], { windowsHide: true });

        let output = '';
        let errorOutput = '';

        ffprobe.stdout?.on('data', (data) => {
          output += data.toString();
        });

        ffprobe.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        ffprobe.on('close', (code) => {
          if (code === 0 && output.trim()) {
            const duration = parseFloat(output.trim());
            console.log(`[RESEMBLE] Validated - duration: ${(duration / 60).toFixed(1)} minutes`);
            resolve();
          } else {
            console.error('[RESEMBLE] FFprobe validation failed:', errorOutput);
            reject(new Error(`Output file is invalid or corrupted: ${errorOutput || 'ffprobe returned no duration'}`));
          }
        });

        ffprobe.on('error', (err) => {
          // If ffprobe is not available, just warn but don't fail
          console.warn(`[RESEMBLE] Could not validate with ffprobe: ${err.message}`);
          resolve();
        });
      });
    }

    // Step 4: Replace original file
    emitProgress({ phase: 'finalizing', percentage: 95, message: 'Replacing original file...' });

    // Backup original
    console.log(`[RESEMBLE] Backing up original to ${backupPath}`);
    fs.copyFileSync(inputPath, backupPath);

    // Replace with enhanced version
    console.log('[RESEMBLE] Replacing original with enhanced file');
    fs.copyFileSync(finalOutput, inputPath);

    // Verify replacement
    const replacedStats = fs.statSync(inputPath);
    console.log(`[RESEMBLE] Replaced file size: ${(replacedStats.size / 1024 / 1024).toFixed(1)} MB`);

    if (replacedStats.size !== finalOutputStats.size) {
      console.warn('[RESEMBLE] Warning - file sizes don\'t match after copy');
    }

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
export async function checkResembleAvailable(): Promise<{ available: boolean; device?: string; usingWsl?: boolean; error?: string }> {
  const device = getResembleDevice();
  const useWsl = shouldUseWsl2ForResemble();

  return new Promise((resolve) => {
    let check: ReturnType<typeof spawn>;

    if (useWsl) {
      // Check in WSL
      const wslCondaPath = getWslCondaPath();
      const wslCondaEnv = getWslResembleCondaEnv();
      const distro = getWslDistro();
      const condaBase = wslCondaPath.replace(/\/bin\/conda$/, '');
      const bashCommand = `source ${condaBase}/etc/profile.d/conda.sh && conda activate ${wslCondaEnv} && resemble-enhance --help`;

      const wslArgs = distro
        ? ['-d', distro, 'bash', '-c', bashCommand]
        : ['bash', '-c', bashCommand];

      check = spawn('wsl.exe', wslArgs, { windowsHide: true });
    } else {
      // Check directly
      const condaPath = getCondaPath();
      const condaEnv = getResembleCondaEnv();
      check = spawn(condaPath, [
        'run', '-n', condaEnv, '--no-capture-output',
        'resemble-enhance', '--help'
      ], { windowsHide: true });
    }

    let stderr = '';

    check.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    check.on('close', (code) => {
      if (code === 0) {
        console.log(`[RESEMBLE] Available with device: ${device}, WSL: ${useWsl}`);
        resolve({ available: true, device, usingWsl: useWsl });
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

/**
 * Queue-compatible enhancement function
 * Emits queue:progress events instead of resemble:progress
 * Supports outputPath for non-destructive mode
 */
export async function enhanceFileForQueue(
  jobId: string,
  inputPath: string,
  outputPath?: string,
  projectId?: string,
  onProgress?: (progress: {
    jobId: string;
    type: 'resemble-enhance';
    phase: string;
    progress: number;
    message?: string;
  }) => void
): Promise<EnhanceResult> {
  // Normalize path separators for Windows (may have mixed / and \)
  const normalizedInput = inputPath.replace(/\//g, path.sep);
  const normalizedOutput = outputPath?.replace(/\//g, path.sep);

  const ext = path.extname(normalizedInput).toLowerCase();
  const dir = path.dirname(normalizedInput);
  const basename = path.basename(normalizedInput, ext);

  // Determine final output location
  const finalOutputPath = normalizedOutput || normalizedInput;
  const replaceOriginal = !normalizedOutput || normalizedOutput === normalizedInput;

  // Temp directories and files
  const tempInputDir = path.join(dir, `${basename}_enhance_input`);
  const tempOutputDir = path.join(dir, `${basename}_enhance_output`);
  const tempWav = path.join(tempInputDir, 'audio.wav');
  const enhancedWav = path.join(tempOutputDir, 'audio.wav');
  const tempOutput = path.join(dir, `${basename}_temp_output${ext}`);
  const backupPath = replaceOriginal ? path.join(dir, `${basename}_backup${ext}`) : null;

  const condaPath = getCondaPath();
  const ffmpegPath = getFfmpegPath();
  const condaEnv = getResembleCondaEnv();

  const emitProgress = (phase: string, progress: number, message?: string) => {
    if (onProgress) {
      onProgress({
        jobId,
        type: 'resemble-enhance',
        phase,
        progress,
        message
      });
    }
    // Also emit to mainWindow for existing listeners
    if (mainWindow) {
      mainWindow.webContents.send('resemble:progress', {
        phase,
        percentage: progress,
        message: message || phase
      });
    }
  };

  try {
    // Clean up any leftover temp directories from previous cancelled/failed jobs
    for (const tempDir of [tempInputDir, tempOutputDir]) {
      if (fs.existsSync(tempDir)) {
        console.log(`[RESEMBLE-QUEUE] Cleaning up leftover temp directory: ${tempDir}`);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
    if (fs.existsSync(tempOutput)) {
      console.log(`[RESEMBLE-QUEUE] Cleaning up leftover temp file: ${tempOutput}`);
      fs.unlinkSync(tempOutput);
    }

    // Create temp directories
    fs.mkdirSync(tempInputDir, { recursive: true });
    fs.mkdirSync(tempOutputDir, { recursive: true });

    // Step 1: Convert to WAV if needed (44100Hz for resemble-enhance)
    if (ext !== '.wav') {
      emitProgress('converting', 2, 'Extracting audio to WAV...');

      await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, [
          '-y', '-i', normalizedInput,
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
      fs.copyFileSync(normalizedInput, tempWav);
    }

    // Step 2: Run Resemble Enhance
    const device = getResembleDevice();
    const useWsl = shouldUseWsl2ForResemble();

    emitProgress('enhancing', 3, `Running Resemble Enhance on ${device.toUpperCase()}${useWsl ? ' (WSL)' : ''}...`);

    console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Using device: ${device}, WSL: ${useWsl}`);

    const startTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      // Build environment with device-specific settings
      const envVars: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      };

      if (useWsl) {
        // Use WSL for Resemble Enhance on Windows
        const wslCondaPath = getWslCondaPath();
        const wslCondaEnv = getWslResembleCondaEnv();
        const wslInputDir = windowsToWslPath(tempInputDir);
        const wslOutputDir = windowsToWslPath(tempOutputDir);
        const distro = getWslDistro();

        // Build the bash command to run in WSL
        const condaBase = wslCondaPath.replace(/\/bin\/conda$/, '');
        const bashCommand = `source ${condaBase}/etc/profile.d/conda.sh && conda activate ${wslCondaEnv} && resemble-enhance "${wslInputDir}" "${wslOutputDir}" --device ${device}`;

        console.log(`[RESEMBLE-QUEUE] WSL command: ${bashCommand}`);

        const wslArgs = distro
          ? ['-d', distro, 'bash', '-c', bashCommand]
          : ['bash', '-c', bashCommand];

        activeProcess = spawn('wsl.exe', wslArgs, {
          env: envVars,
          windowsHide: true
        });
      } else {
        // Direct spawn (macOS/Linux or Windows without WSL)
        activeProcess = spawn(condaPath, [
          'run', '-n', condaEnv, '--no-capture-output',
          'resemble-enhance', tempInputDir, tempOutputDir, '--device', device
        ], {
          env: envVars,
          windowsHide: true
        });
      }

      let stderr = '';

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        console.log('[RESEMBLE-QUEUE]', output.trim());

        // Parse progress from tqdm-style output
        const tqdmProgress = parseTqdmProgress(output);
        if (tqdmProgress) {
          const pct = tqdmProgress.percentage;
          let message = `Enhancing: ${pct}%`;
          if (tqdmProgress.remaining) {
            message += ` (${tqdmProgress.remaining} remaining)`;
          }
          // Emit raw progress (0-95% range, leaving 5% for finalization)
          emitProgress('enhancing', Math.min(pct * 0.95, 95), message);
        }
      };

      activeProcess.stdout?.on('data', handleOutput);

      activeProcess.stderr?.on('data', (data) => {
        stderr = appendCapped(stderr, data.toString());
        handleOutput(data);
      });

      activeProcess.on('close', (code) => {
        activeProcess = null;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (code === 0) {
          console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Enhancement completed in ${elapsed}s`);
          resolve();
        } else {
          reject(new Error(`Resemble Enhance failed with code ${code}: ${stderr}`));
        }
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
      emitProgress('finalizing', 96, 'Re-encoding to original format...');

      // Use appropriate codec based on format
      // Note: -movflags +faststart moves moov atom to beginning, making files
      // more resilient to truncation and better for streaming
      let ffmpegArgs: string[];
      if (ext === '.m4b' || ext === '.m4a') {
        // M4B/M4A: Use original file as second input to copy metadata, chapters, and cover art
        // -i enhancedWav: audio source (input 0)
        // -i normalizedInput: metadata/chapters/cover source (input 1)
        // -map 0:a: take audio from input 0
        // -map 1:v?: take video (cover art) from input 1 if present
        // -map_metadata 1: copy metadata from input 1
        // -map_chapters 1: copy chapters from input 1
        // -c:v copy: copy video stream without re-encoding
        ffmpegArgs = [
          '-y',
          '-i', enhancedWav,
          '-i', normalizedInput,
          '-map', '0:a',
          '-map', '1:v?',
          '-map_metadata', '1',
          '-map_chapters', '1',
          '-c:a', 'aac', '-b:a', '128k',
          '-c:v', 'copy',
          '-f', 'ipod', '-movflags', '+faststart',
          tempOutput
        ];
      } else if (ext === '.mp3') {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'libmp3lame', '-b:a', '192k', tempOutput];
      } else if (ext === '.flac') {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'flac', tempOutput];
      } else if (ext === '.ogg' || ext === '.opus') {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'libopus', '-b:a', '128k', tempOutput];
      } else {
        ffmpegArgs = ['-y', '-i', enhancedWav, '-c:a', 'copy', tempOutput];
      }

      // Run FFmpeg encoding
      await new Promise<void>((resolve, reject) => {
        console.log('[RESEMBLE-QUEUE] Re-encoding with ffmpeg:', ffmpegPath);
        console.log('[RESEMBLE-QUEUE] Args:', ffmpegArgs.join(' '));

        const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
          windowsHide: true
        });

        let ffmpegStderr = '';
        ffmpeg.stderr?.on('data', (data) => {
          ffmpegStderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else {
            console.error('[RESEMBLE-QUEUE] FFmpeg stderr:', ffmpegStderr);
            reject(new Error(`FFmpeg encoding failed with code ${code}`));
          }
        });

        ffmpeg.on('error', reject);
      });
    }

    const finalOutput = ext === '.wav' ? enhancedWav : tempOutput;

    // Verify the re-encoded file exists and has content
    if (!fs.existsSync(finalOutput)) {
      throw new Error(`Re-encoded file not found: ${finalOutput}`);
    }
    const finalOutputStats = fs.statSync(finalOutput);
    if (finalOutputStats.size === 0) {
      throw new Error(`Re-encoded file is empty: ${finalOutput}`);
    }
    console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Re-encoded file size: ${(finalOutputStats.size / 1024 / 1024).toFixed(1)} MB`);

    // For MP4/M4B/M4A files, verify the container is valid using ffprobe
    if (['.m4b', '.m4a', '.mp4'].includes(ext)) {
      console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Validating MP4 container...`);
      await new Promise<void>((resolve, reject) => {
        const ffprobe = spawn(ffmpegPath.replace('ffmpeg', 'ffprobe'), [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          finalOutput
        ], { windowsHide: true });

        let output = '';
        let errorOutput = '';

        ffprobe.stdout?.on('data', (data) => {
          output += data.toString();
        });

        ffprobe.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        ffprobe.on('close', (code) => {
          if (code === 0 && output.trim()) {
            const duration = parseFloat(output.trim());
            console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Validated - duration: ${(duration / 60).toFixed(1)} minutes`);
            resolve();
          } else {
            console.error(`[RESEMBLE-QUEUE] Job ${jobId}: FFprobe validation failed:`, errorOutput);
            reject(new Error(`Output file is invalid or corrupted: ${errorOutput || 'ffprobe returned no duration'}`));
          }
        });

        ffprobe.on('error', (err) => {
          // If ffprobe is not available, just warn but don't fail
          console.warn(`[RESEMBLE-QUEUE] Job ${jobId}: Could not validate with ffprobe: ${err.message}`);
          resolve();
        });
      });
    }

    // Step 4: Move to final output location
    emitProgress('finalizing', 98, 'Saving enhanced file...');

    console.log(`[RESEMBLE-QUEUE] Job ${jobId}: replaceOriginal=${replaceOriginal}, backupPath=${backupPath}`);
    console.log(`[RESEMBLE-QUEUE] Job ${jobId}: finalOutput=${finalOutput}`);
    console.log(`[RESEMBLE-QUEUE] Job ${jobId}: normalizedInput=${normalizedInput}`);

    if (replaceOriginal && backupPath) {
      // Backup original
      console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Backing up original to ${backupPath}`);
      fs.copyFileSync(normalizedInput, backupPath);

      // Verify backup
      if (!fs.existsSync(backupPath)) {
        throw new Error(`Failed to create backup at ${backupPath}`);
      }

      // Replace with enhanced version
      console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Replacing original with enhanced file`);
      fs.copyFileSync(finalOutput, normalizedInput);

      // Verify replacement
      const replacedStats = fs.statSync(normalizedInput);
      console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Replaced file size: ${(replacedStats.size / 1024 / 1024).toFixed(1)} MB`);

      if (replacedStats.size !== finalOutputStats.size) {
        console.warn(`[RESEMBLE-QUEUE] Job ${jobId}: Warning - file sizes don't match after copy`);
      }
    } else if (normalizedOutput && normalizedOutput !== normalizedInput) {
      // Ensure output directory exists
      const outputDir = path.dirname(normalizedOutput);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      // Copy to output path
      console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Copying to separate output: ${normalizedOutput}`);
      fs.copyFileSync(finalOutput, normalizedOutput);

      // Verify copy
      if (!fs.existsSync(normalizedOutput)) {
        throw new Error(`Failed to copy to output path: ${normalizedOutput}`);
      }
    } else {
      console.warn(`[RESEMBLE-QUEUE] Job ${jobId}: No copy operation performed - replaceOriginal=${replaceOriginal}, normalizedOutput=${normalizedOutput}`);
    }

    // Clean up temp files and directories
    const tempItems = [tempInputDir, tempOutputDir, tempOutput];
    if (backupPath) tempItems.push(backupPath);
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

    emitProgress('complete', 100, 'Enhancement complete!');

    return { success: true, outputPath: finalOutputPath };

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
    emitProgress('error', 0, `Enhancement failed: ${errorMessage}`);

    return { success: false, error: errorMessage };
  }
}

/**
 * Bilingual Assembly Bridge
 *
 * Orchestrates the bilingual assembly step after both source and target
 * TTS jobs complete. Calls the Python bilingual.py script to:
 * 1. Combine audio files with pauses and gaps
 * 2. Generate VTT subtitles with accurate timing
 * 3. Convert to M4B format
 */

import { spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getCondaRunArgs, getCondaPath, getDefaultE2aPath } from './e2a-paths';

export interface BilingualAssemblyConfig {
  projectId: string;
  sourceSentencesDir: string;  // From source TTS job
  targetSentencesDir: string;  // From target TTS job
  sentencePairsPath: string;   // Path to sentence_pairs.json
  outputDir: string;           // Where to save M4B and VTT
  pauseDuration?: number;      // Seconds between source and target (default 0.3)
  gapDuration?: number;        // Seconds between pairs (default 1.0)
  audioFormat?: string;        // Audio file format (default 'flac')
}

export interface BilingualAssemblyResult {
  success: boolean;
  audioPath?: string;
  vttPath?: string;
  error?: string;
}

export interface BilingualAssemblyProgress {
  phase: 'preparing' | 'combining' | 'vtt' | 'encoding' | 'complete' | 'error';
  percentage: number;
  message: string;
}

let mainWindow: BrowserWindow | null = null;

export function initBilingualAssemblyBridge(window: BrowserWindow): void {
  mainWindow = window;
}

function emitProgress(jobId: string, progress: BilingualAssemblyProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bilingual-assembly:progress', { jobId, progress });
  }
}

function emitComplete(jobId: string, result: BilingualAssemblyResult): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bilingual-assembly:complete', { jobId, ...result });
  }
}

/**
 * Run the bilingual assembly process
 */
export async function runBilingualAssembly(
  jobId: string,
  config: BilingualAssemblyConfig
): Promise<BilingualAssemblyResult> {
  console.log(`[BILINGUAL-ASSEMBLY] Starting job ${jobId}`);
  console.log('[BILINGUAL-ASSEMBLY] Config:', {
    projectId: config.projectId,
    sourceSentencesDir: config.sourceSentencesDir,
    targetSentencesDir: config.targetSentencesDir,
    outputDir: config.outputDir
  });

  emitProgress(jobId, {
    phase: 'preparing',
    percentage: 0,
    message: 'Preparing bilingual assembly...'
  });

  // Validate inputs exist
  try {
    await fs.access(config.sourceSentencesDir);
    await fs.access(config.targetSentencesDir);
    await fs.access(config.sentencePairsPath);
  } catch (err) {
    const error = `Input validation failed: ${err}`;
    console.error('[BILINGUAL-ASSEMBLY]', error);
    emitComplete(jobId, { success: false, error });
    return { success: false, error };
  }

  // Ensure output directory exists
  await fs.mkdir(config.outputDir, { recursive: true });

  // Build Python script path
  const e2aPath = getDefaultE2aPath();
  const scriptPath = path.join(e2aPath, 'bookforge_ext', 'parallel', 'bilingual.py');

  // Check if script exists
  try {
    await fs.access(scriptPath);
  } catch {
    const error = `Bilingual assembly script not found: ${scriptPath}`;
    console.error('[BILINGUAL-ASSEMBLY]', error);
    emitComplete(jobId, { success: false, error });
    return { success: false, error };
  }

  // Get conda environment
  const condaPath = getCondaPath();
  const condaEnv = 'ebook2audiobook';

  emitProgress(jobId, {
    phase: 'combining',
    percentage: 10,
    message: 'Combining audio files...'
  });

  return new Promise((resolve) => {
    // Build command arguments
    const args = [
      'run', '-n', condaEnv, '--no-capture-output',
      'python', scriptPath,
      '--mode', 'dual',
      '--source-dir', config.sourceSentencesDir,
      '--target-dir', config.targetSentencesDir,
      '--pairs', config.sentencePairsPath,
      '--output-dir', config.outputDir,
      '--output-name', config.projectId,
      '--pause', String(config.pauseDuration ?? 0.3),
      '--gap', String(config.gapDuration ?? 1.0),
      '--format', config.audioFormat ?? 'flac'
    ];

    console.log(`[BILINGUAL-ASSEMBLY] Running: ${condaPath} ${args.join(' ')}`);

    const proc = spawn(condaPath, args, {
      cwd: e2aPath,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';
    let lastProgress = 10;

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      console.log('[BILINGUAL-ASSEMBLY]', output.trim());

      // Update progress based on log messages
      if (output.includes('[BILINGUAL-DUAL] Combining')) {
        emitProgress(jobId, { phase: 'combining', percentage: 30, message: 'Combining audio...' });
        lastProgress = 30;
      } else if (output.includes('[BILINGUAL-DUAL] Running ffmpeg')) {
        emitProgress(jobId, { phase: 'combining', percentage: 50, message: 'Running ffmpeg concat...' });
        lastProgress = 50;
      } else if (output.includes('[BILINGUAL-VTT-DUAL]')) {
        emitProgress(jobId, { phase: 'vtt', percentage: 70, message: 'Generating subtitles...' });
        lastProgress = 70;
      } else if (output.includes('Converting to M4B')) {
        emitProgress(jobId, { phase: 'encoding', percentage: 85, message: 'Converting to M4B...' });
        lastProgress = 85;
      } else if (output.includes('[BILINGUAL-ASSEMBLY] Complete')) {
        emitProgress(jobId, { phase: 'complete', percentage: 100, message: 'Complete!' });
        lastProgress = 100;
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error('[BILINGUAL-ASSEMBLY STDERR]', data.toString().trim());
    });

    proc.on('close', (code) => {
      console.log(`[BILINGUAL-ASSEMBLY] Process exited with code ${code}`);

      if (code !== 0) {
        const error = `Assembly failed with code ${code}: ${stderr}`;
        emitComplete(jobId, { success: false, error });
        resolve({ success: false, error });
        return;
      }

      // Parse JSON result from stdout
      const jsonMarker = '---JSON_RESULT---';
      const jsonStart = stdout.indexOf(jsonMarker);
      if (jsonStart === -1) {
        const error = 'No JSON result in output';
        emitComplete(jobId, { success: false, error });
        resolve({ success: false, error });
        return;
      }

      try {
        const jsonStr = stdout.slice(jsonStart + jsonMarker.length).trim();
        const result = JSON.parse(jsonStr) as BilingualAssemblyResult;

        console.log('[BILINGUAL-ASSEMBLY] Result:', result);
        emitProgress(jobId, { phase: 'complete', percentage: 100, message: 'Assembly complete!' });
        emitComplete(jobId, result);
        resolve(result);
      } catch (err) {
        const error = `Failed to parse result: ${err}`;
        emitComplete(jobId, { success: false, error });
        resolve({ success: false, error });
      }
    });

    proc.on('error', (err) => {
      const error = `Failed to spawn process: ${err}`;
      console.error('[BILINGUAL-ASSEMBLY]', error);
      emitComplete(jobId, { success: false, error });
      resolve({ success: false, error });
    });
  });
}

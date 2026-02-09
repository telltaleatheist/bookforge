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
import * as os from 'os';
import { getCondaRunArgs, getCondaPath, getDefaultE2aPath } from './e2a-paths';

// ─────────────────────────────────────────────────────────────────────────────
// Temp Folder Management (for Syncthing compatibility)
// ─────────────────────────────────────────────────────────────────────────────

const TEMP_BILINGUAL_BASE_DIR = 'bookforge-bilingual';

/**
 * Get temp output directory for a bilingual assembly job
 */
function getTempOutputDir(jobId: string): string {
  return path.join(os.tmpdir(), TEMP_BILINGUAL_BASE_DIR, jobId);
}

/**
 * Copy completed bilingual assembly output to final destination
 */
async function copyToFinalDestination(
  tempDir: string,
  bfpPath: string
): Promise<{ audioPath: string; vttPath: string | undefined }> {
  console.log('[BILINGUAL-ASSEMBLY] Copying to final destination:', { tempDir, bfpPath });

  // Find m4b and vtt files in temp dir
  const files = await fs.readdir(tempDir);
  const m4bFile = files.find(f => f.endsWith('.m4b') && !f.startsWith('._'));
  const vttFile = files.find(f => f.endsWith('.vtt') && !f.startsWith('._'));

  if (!m4bFile) {
    throw new Error(`No m4b file found in temp directory: ${tempDir}`);
  }

  const tempM4bPath = path.join(tempDir, m4bFile);
  const tempVttPath = vttFile ? path.join(tempDir, vttFile) : undefined;

  // Create audiobook/ subfolder in BFP
  const bfpAudiobookDir = path.join(bfpPath, 'audiobook');
  await fs.mkdir(bfpAudiobookDir, { recursive: true });

  // Copy to BFP audiobook folder
  const finalAudioPath = path.join(bfpAudiobookDir, 'output.m4b');
  await fs.copyFile(tempM4bPath, finalAudioPath);
  console.log(`[BILINGUAL-ASSEMBLY] Copied m4b to BFP: ${finalAudioPath}`);

  let finalVttPath: string | undefined;
  if (tempVttPath) {
    finalVttPath = path.join(bfpAudiobookDir, 'subtitles.vtt');
    await fs.copyFile(tempVttPath, finalVttPath);
    console.log(`[BILINGUAL-ASSEMBLY] Copied vtt to BFP: ${finalVttPath}`);
  }

  // Clean up temp folder
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(`[BILINGUAL-ASSEMBLY] Cleaned up temp folder: ${tempDir}`);
  } catch (err) {
    console.error('[BILINGUAL-ASSEMBLY] Failed to clean up temp folder:', err);
  }

  return { audioPath: finalAudioPath, vttPath: finalVttPath };
}

export interface BilingualAssemblyConfig {
  projectId: string;
  sourceSentencesDir: string;  // From source TTS job
  targetSentencesDir: string;  // From target TTS job
  sentencePairsPath: string;   // Path to sentence_pairs.json
  outputDir: string;           // Where to save M4B and VTT
  pauseDuration?: number;      // Seconds between source and target (default 0.3)
  gapDuration?: number;        // Seconds between pairs (default 1.0)
  audioFormat?: string;        // Audio file format (default 'flac')
  // Custom output naming with language suffix
  outputName?: string;         // Custom filename (e.g., "My Book [Bilingual EN-DE]")
  title?: string;              // Book/article title
  sourceLang?: string;         // Source language code (e.g., 'en')
  targetLang?: string;         // Target language code (e.g., 'de')
  // BFP path for saving bilingual audio path
  bfpPath?: string;
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
    outputDir: config.outputDir,
    bfpPath: config.bfpPath
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

  // Determine effective output directory - use temp folder for Syncthing compatibility
  let effectiveOutputDir: string;
  let tempOutputDir: string | undefined;

  if (config.bfpPath) {
    // Use temp folder, will copy to BFP on completion
    tempOutputDir = getTempOutputDir(jobId);
    effectiveOutputDir = tempOutputDir;
    console.log(`[BILINGUAL-ASSEMBLY] Using temp folder: ${tempOutputDir}`);
    console.log(`[BILINGUAL-ASSEMBLY] Will copy to BFP on completion: ${config.bfpPath}`);
  } else {
    // Legacy mode: output directly to specified dir
    effectiveOutputDir = config.outputDir;
  }

  // Ensure output directory exists
  await fs.mkdir(effectiveOutputDir, { recursive: true });

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
    // Generate output name with language suffix if not explicitly provided
    let outputName = config.outputName;
    if (!outputName) {
      // Build output name from title and languages
      const baseTitle = config.title || config.projectId;
      const sourceLang = (config.sourceLang || 'en').toUpperCase();
      const targetLang = (config.targetLang || 'de').toUpperCase();
      outputName = `${baseTitle} [Bilingual ${sourceLang}-${targetLang}]`;
    }

    // Build command arguments - use effectiveOutputDir for Syncthing compatibility
    const args = [
      'run', '-n', condaEnv, '--no-capture-output',
      'python', scriptPath,
      '--mode', 'dual',
      '--source-dir', config.sourceSentencesDir,
      '--target-dir', config.targetSentencesDir,
      '--pairs', config.sentencePairsPath,
      '--output-dir', effectiveOutputDir,
      '--output-name', outputName,
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
        const rawResult = JSON.parse(jsonStr);

        // Convert snake_case from Python to camelCase for TypeScript
        let result: BilingualAssemblyResult = {
          success: rawResult.success,
          audioPath: rawResult.audio_path || rawResult.audioPath,
          vttPath: rawResult.vtt_path || rawResult.vttPath,
          error: rawResult.error
        };

        console.log('[BILINGUAL-ASSEMBLY] Raw result:', result);

        // If using temp folder, copy to final destination
        if (tempOutputDir && config.bfpPath && result.success) {
          try {
            const finalPaths = await copyToFinalDestination(tempOutputDir, config.bfpPath);
            result = {
              success: true,
              audioPath: finalPaths.audioPath,
              vttPath: finalPaths.vttPath
            };
            console.log('[BILINGUAL-ASSEMBLY] Final result after copy:', result);
          } catch (copyErr) {
            console.error('[BILINGUAL-ASSEMBLY] Failed to copy to final destination:', copyErr);
            // Keep the temp paths as fallback
          }
        }

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

/**
 * Generate-sentences bridge — transcribes an audiobook variant into a synced VTT
 * and links that VTT to the ONE variant it describes.
 *
 * Runs as a queue job ('generate-sentences'). Mirrors the video-assembly bridge's
 * shape: `startGenerateSentences(jobId, mainWindow, config)` returns immediately;
 * progress and completion ride 'generate-sentences:progress' / ':complete' events
 * keyed by jobId. The heavy lifting is transcribe-bridge (faster-whisper); this
 * bridge resolves the model + output path, then writes the variant's vttPath so the
 * bookshelf reader syncs text against THIS audiobook (never bleeding a TTS variant's
 * transcript onto an independently-recorded one — the bug this feature closes).
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import { transcribeAudiobook } from './transcribe-bridge.js';
import { whisperModelDir, getWhisperModelDef, isWhisperModelPresent, downloadWhisperModel } from './whisper-models.js';
import { isWhisperEnvInstalled, WHISPER_ENV_ID } from './components/whisper-env.js';
import { componentManager } from './components/component-manager.js';
import * as manifestService from './manifest-service.js';
import { normalizeFsPath } from './path-utils.js';

export interface GenerateSentencesConfig {
  projectId: string;
  variantId: string;
  /** Absolute path to the audiobook m4b. */
  m4bPath: string;
  /** Whisper model id (small | medium | large-v3 | distil-large-v3). */
  modelId: string;
  /** ISO language code, or 'auto'. */
  language?: string;
}

interface ActiveJob {
  controller: AbortController;
  cancelled: boolean;
}

const activeJobs = new Map<string, ActiveJob>();

function sendProgress(win: BrowserWindow, jobId: string, percentage: number, message: string): void {
  if (win.isDestroyed()) return;
  win.webContents.send('generate-sentences:progress', { jobId, percentage, message });
}

function sendComplete(
  win: BrowserWindow,
  jobId: string,
  success: boolean,
  outputPath?: string,
  error?: string,
): void {
  if (win.isDestroyed()) return;
  win.webContents.send('generate-sentences:complete', { jobId, success, outputPath, error });
}

export async function startGenerateSentences(
  jobId: string,
  mainWindow: BrowserWindow,
  config: GenerateSentencesConfig,
): Promise<void> {
  const controller = new AbortController();
  activeJobs.set(jobId, { controller, cancelled: false });

  try {
    const modelDef = getWhisperModelDef(config.modelId);
    if (!modelDef) throw new Error(`Unknown Whisper model: ${config.modelId}`);
    const modelDir = whisperModelDir(config.modelId);

    // Engine overlay not installed yet → install it as part of the job (~35 MB
    // pip overlay into the runtime env). This is the ONLY place the engine is
    // required, so the picker never blocks on it — the queue owns the install,
    // where progress and failures are visible and logged.
    if (!isWhisperEnvInstalled()) {
      sendProgress(mainWindow, jobId, 0, 'Installing the speech-to-text engine…');
      const inst = await componentManager.install(WHISPER_ENV_ID, (p) => {
        if (p.message) sendProgress(mainWindow, jobId, 0, p.message);
      });
      if (!inst.ok) throw new Error(inst.error || 'Failed to install the speech-to-text engine');
      if (activeJobs.get(jobId)?.cancelled) {
        sendComplete(mainWindow, jobId, false, undefined, 'Cancelled');
        return;
      }
    }

    // Model not on disk yet → download it first (deduped inside whisper-models,
    // so if the download dock already started it we join that run instead of
    // racing a second snapshot into the same dir). The job's bar stays at 0 with
    // the download percent in the message, so transcription owns the 0–100 range.
    if (!isWhisperModelPresent(config.modelId)) {
      sendProgress(mainWindow, jobId, 0, `Downloading the ${modelDef.label} model…`);
      const dl = await downloadWhisperModel(config.modelId, (p) => {
        sendProgress(mainWindow, jobId, 0, `Downloading the ${modelDef.label} model… ${p.pct}%`);
      });
      if (!dl.ok) throw new Error(dl.error || `Failed to download the ${modelDef.label} model`);
      if (activeJobs.get(jobId)?.cancelled) {
        sendComplete(mainWindow, jobId, false, undefined, 'Cancelled');
        return;
      }
    }
    if (!fs.existsSync(path.join(modelDir, 'model.bin'))) {
      throw new Error(`The ${modelDef.label} model isn’t downloaded yet.`);
    }

    const m4bPath = normalizeFsPath(config.m4bPath);
    if (!fs.existsSync(m4bPath)) throw new Error(`Audiobook not found: ${m4bPath}`);

    // VTT lands next to the m4b (same basename, .vtt).
    const outVtt = path.join(path.dirname(m4bPath), `${path.parse(m4bPath).name}.vtt`);

    sendProgress(mainWindow, jobId, 0, `Transcribing with ${modelDef.label}…`);

    const result = await transcribeAudiobook({
      audioPath: m4bPath,
      modelDir,
      outPath: outVtt,
      language: config.language || 'auto',
      device: 'auto',
      signal: controller.signal,
      onProgress: (frac) => {
        sendProgress(mainWindow, jobId, Math.round(frac * 100), 'Transcribing audiobook…');
      },
    });

    if (activeJobs.get(jobId)?.cancelled) {
      sendComplete(mainWindow, jobId, false, undefined, 'Cancelled');
      return;
    }
    if (!result.ok) throw new Error(result.error || 'Transcription failed');

    // Link the VTT to the variant it describes (relative to the project dir).
    const projectDir = manifestService.getProjectPath(config.projectId);
    const vttRel = path.relative(projectDir, outVtt).split(path.sep).join('/');

    const saved = await manifestService.modifyManifest(config.projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants.map((v) => v.id === config.variantId ? { ...v, vttPath: vttRel } : v);
      if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
      // Keep the legacy outputs.audiobook.vttPath in sync when this is the primary
      // audiobook output, so older readers resolve it too.
      const v = mf.variants.find((x) => x.id === config.variantId);
      if (v && v.kind === 'audiobook' && mf.outputs?.audiobook
          && normalizeFsPath(path.resolve(path.join(projectDir, mf.outputs.audiobook.path)))
             === normalizeFsPath(path.resolve(m4bPath))) {
        mf.outputs.audiobook.vttPath = vttRel;
      }
    });
    if (!saved?.success) throw new Error(saved?.error || 'Failed to link transcript to the version');

    sendProgress(mainWindow, jobId, 100, 'Transcript ready');
    sendComplete(mainWindow, jobId, true, outVtt);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generate sentences failed';
    if (message !== 'Cancelled') console.error('[GenerateSentences] Error:', message);
    sendComplete(mainWindow, jobId, false, undefined, message);
  } finally {
    activeJobs.delete(jobId);
  }
}

export function cancelGenerateSentences(jobId: string): void {
  const job = activeJobs.get(jobId);
  if (!job) return;
  job.cancelled = true;
  try { job.controller.abort(); } catch { /* already gone */ }
}

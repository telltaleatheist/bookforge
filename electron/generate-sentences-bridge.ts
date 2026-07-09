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
import { getMainLogger } from './rolling-logger.js';
import * as manifestService from './manifest-service.js';
import { embedAndVerifyVtt, deleteSidecarsForM4b } from './metadata-tools.js';
import { normalizeFsPath } from './path-utils.js';
import { runEpubAlign } from './whisperx-align-bridge.js';

// A packaged app discards stdout, so console-only logs were invisible when a
// transcription job silently stalled. Route every step through the file logger
// (bookforge.log) so a stuck job leaves a trail of exactly where it stopped.
export function glog(msg: string, data?: unknown): void {
  data !== undefined ? console.log(msg, data) : console.log(msg);
  try { getMainLogger().info(msg, data); } catch { /* logger not ready */ }
}
export function gerror(msg: string, data?: unknown): void {
  data !== undefined ? console.error(msg, data) : console.error(msg);
  try { getMainLogger().error(msg, data); } catch { /* logger not ready */ }
}

export interface GenerateSentencesConfig {
  projectId: string;
  variantId: string;
  /** Absolute path to the audiobook m4b. */
  m4bPath: string;
  /** Whisper model id (small | medium | large-v3 | distil-large-v3). */
  modelId: string;
  /** ISO language code, or 'auto'. */
  language?: string;
  /**
   * Alignment method: 'whisper' transcribes the audio; 'epub-align' force-aligns
   * the project's ebook text to the audio for accurate read-along subtitles.
   * Absent = 'whisper'.
   */
  method?: 'whisper' | 'epub-align';
  /** When method='epub-align', the ebook ProjectVariant.id to align against. */
  epubVariantId?: string;
}

interface ActiveJob {
  controller: AbortController;
  cancelled: boolean;
}

const activeJobs = new Map<string, ActiveJob>();

export function sendProgress(win: BrowserWindow, jobId: string, percentage: number, message: string): void {
  if (win.isDestroyed()) return;
  win.webContents.send('generate-sentences:progress', { jobId, percentage, message });
}

/** Compact H:MM:SS for an audio position (e.g. 3:07:42). */
function fmtDur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
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
  glog(`[generate-sentences] START job=${jobId}`, {
    modelId: config.modelId, m4bPath: config.m4bPath, language: config.language,
  });

  try {
    // epub-align: force-align the project's own ebook text to the audio for
    // accurate read-along subtitles (the ebook is the ground truth — no ASR
    // spelling/word errors). Degrades gracefully to whisper transcription on ANY
    // failure so a missing engine or a stubborn book never leaves a book with no
    // synced text.
    if (config.method === 'epub-align' && config.epubVariantId) {
      try {
        const m4bPath = normalizeFsPath(config.m4bPath);
        if (!fs.existsSync(m4bPath)) throw new Error(`Audiobook not found: ${m4bPath}`);

        const { vttPath, cues } = await runEpubAlign(jobId, mainWindow, config);
        if (activeJobs.get(jobId)?.cancelled) {
          sendComplete(mainWindow, jobId, false, undefined, 'Cancelled');
          return;
        }

        // Seal the aligned transcript INTO the m4b (same embed-only model as the
        // whisper path below — the m4b becomes the single source of truth).
        try {
          const lang = config.language && config.language !== 'auto' ? { language: config.language } : undefined;
          const embedded = await embedAndVerifyVtt(m4bPath, vttPath, lang);
          if (embedded) glog('[generate-sentences] embedded aligned transcript into m4b');
          else gerror('[generate-sentences] embed verify failed (epub-align) — audiobook has NO transcript');
        } catch (embedErr) {
          gerror('[generate-sentences] embed aligned transcript failed', { error: (embedErr as Error).message });
        }
        deleteSidecarsForM4b(m4bPath);

        // Link to the variant. Embed-only: clear vttPath (the m4b IS the source).
        const projectDir = manifestService.getProjectPath(config.projectId);
        const saved = await manifestService.modifyManifest(config.projectId, (mf) => {
          const cur = manifestService.getVariants(mf);
          mf.variants = cur.variants.map((v) => v.id === config.variantId ? { ...v, vttPath: undefined } : v);
          if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
          const v = mf.variants.find((x) => x.id === config.variantId);
          if (v && v.kind === 'audiobook' && mf.outputs?.audiobook
              && normalizeFsPath(path.resolve(path.join(projectDir, mf.outputs.audiobook.path)))
                 === normalizeFsPath(path.resolve(m4bPath))) {
            mf.outputs.audiobook.vttPath = undefined;
          }
        });
        if (!saved?.success) throw new Error(saved?.error || 'Failed to link transcript to the version');

        glog(`[generate-sentences] epub-align DONE job=${jobId} out=${vttPath} cues=${cues}`);
        sendProgress(mainWindow, jobId, 100, 'Subtitles ready');
        sendComplete(mainWindow, jobId, true, vttPath);
        return;
      } catch (err) {
        gerror('[generate-sentences] epub-align failed, falling back to whisper', {
          error: err instanceof Error ? err.message : String(err),
        });
        // fall through to the whisper transcription path (do NOT return)
      }
    }

    const modelDef = getWhisperModelDef(config.modelId);
    if (!modelDef) throw new Error(`Unknown Whisper model: ${config.modelId}`);
    const modelDir = whisperModelDir(config.modelId);

    // Engine overlay not installed yet → install it as part of the job (~35 MB
    // pip overlay into the runtime env). This is the ONLY place the engine is
    // required, so the picker never blocks on it — the queue owns the install,
    // where progress and failures are visible and logged.
    const engineInstalled = isWhisperEnvInstalled();
    glog(`[generate-sentences] engine installed=${engineInstalled}`);
    if (!engineInstalled) {
      sendProgress(mainWindow, jobId, 0, 'Installing the speech-to-text engine…');
      glog('[generate-sentences] installing engine overlay…');
      const inst = await componentManager.install(WHISPER_ENV_ID, (p) => {
        if (p.message) sendProgress(mainWindow, jobId, 0, p.message);
      });
      glog(`[generate-sentences] engine install result ok=${inst.ok}`, { error: inst.error });
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
    const modelPresent = isWhisperModelPresent(config.modelId);
    glog(`[generate-sentences] model ${config.modelId} present=${modelPresent} dir=${modelDir}`);
    if (!modelPresent) {
      sendProgress(mainWindow, jobId, 0, `Downloading the ${modelDef.label} model…`);
      glog(`[generate-sentences] downloading model ${config.modelId}…`);
      const dl = await downloadWhisperModel(config.modelId, (p) => {
        // Drive the bar with the real download percent (this is its own 0–100
        // phase; transcription re-drives 0–100 after, distinguished by message)
        // so a multi-GB download never looks like a frozen 0%.
        sendProgress(mainWindow, jobId, p.pct, `Downloading the ${modelDef.label} model… ${p.pct}%`);
      });
      glog(`[generate-sentences] model download ok=${dl.ok}`, { error: dl.error });
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

    sendProgress(mainWindow, jobId, 0, `Loading the ${modelDef.label} model…`);
    glog(`[generate-sentences] transcribe START audio=${m4bPath} out=${outVtt}`);

    // The script narrates its phases so a long book (where the percentage rounds to
    // 0 for minutes) still shows something moving: model load → decode → a live
    // "H:MM:SS / H:MM:SS · N sentences" position that ticks every ~1.5 s.
    let deviceLabel = 'GPU';
    const result = await transcribeAudiobook({
      audioPath: m4bPath,
      modelDir,
      outPath: outVtt,
      language: config.language || 'auto',
      device: 'auto',
      signal: controller.signal,
      onDevice: (dev) => {
        deviceLabel = dev === 'cuda' ? 'GPU' : 'CPU';
        glog(`[generate-sentences] transcribing on ${dev}`);
      },
      onStage: (stage) => {
        if (stage === 'loading') sendProgress(mainWindow, jobId, 0, `Loading the ${modelDef.label} model…`);
        else if (stage === 'decoding') sendProgress(mainWindow, jobId, 0, 'Decoding the audiobook…');
        else if (stage === 'transcribing') sendProgress(mainWindow, jobId, 0, `Transcribing on the ${deviceLabel}…`);
      },
      onDecodeProgress: (processedSec, totalSec) => {
        // Decode owns its own 0–100 pass on the bar (same pattern as the model
        // download above; transcription re-drives 0–100 after, distinguished by
        // message). With no container duration, show the moving position alone.
        if (totalSec > 0) {
          const pct = Math.min(100, Math.round((processedSec / totalSec) * 100));
          sendProgress(mainWindow, jobId, pct, `Decoding the audiobook… ${fmtDur(processedSec)} / ${fmtDur(totalSec)}`);
        } else {
          sendProgress(mainWindow, jobId, 0, `Decoding the audiobook… ${fmtDur(processedSec)}`);
        }
      },
      onProgress: (frac, detail) => {
        const pct = Math.round(frac * 100);
        const message = detail && detail.totalSec > 0
          ? `Transcribing on the ${deviceLabel}… ${fmtDur(detail.processedSec)} / ${fmtDur(detail.totalSec)} · ${detail.cues} sentence${detail.cues === 1 ? '' : 's'}`
          : `Transcribing on the ${deviceLabel}…`;
        sendProgress(mainWindow, jobId, pct, message);
      },
    });

    glog(`[generate-sentences] transcribe DONE ok=${result.ok}`, { cues: result.cues, device: result.device, error: result.error });

    if (activeJobs.get(jobId)?.cancelled) {
      sendComplete(mainWindow, jobId, false, undefined, 'Cancelled');
      return;
    }
    if (!result.ok) throw new Error(result.error || 'Transcription failed');

    // Seal the freshly-generated transcript INTO the m4b as a subtitle track — the
    // guaranteed audio↔transcript link the players read directly (immune to any
    // sidecar-name mismatch). Idempotent: a re-generate replaces the prior track.
    // On VERIFIED success (embed-only model) delete the sidecar so the m4b is the
    // single source of truth. Non-fatal — on failure the sidecar is kept as fallback.
    try {
      const lang = config.language && config.language !== 'auto' ? { language: config.language } : undefined;
      const embedded = await embedAndVerifyVtt(m4bPath, outVtt, lang);
      if (embedded) glog('[generate-sentences] embedded transcript into m4b');
      else gerror('[generate-sentences] embed verify failed — audiobook has NO transcript (embed-only, no sidecar fallback)');
    } catch (embedErr) {
      gerror('[generate-sentences] embed transcript failed — audiobook has NO transcript', { error: (embedErr as Error).message });
    }
    // Embed-only: the sidecar is ALWAYS removed (redundant on success, untrusted on
    // failure). On embed failure the book has no synced text until re-generated.
    deleteSidecarsForM4b(m4bPath);

    // Link to the variant. Embed-only: the m4b IS the source of truth, so vttPath is
    // ALWAYS cleared (undefined drops the key on serialize) — never a sidecar path.
    const projectDir = manifestService.getProjectPath(config.projectId);
    const saved = await manifestService.modifyManifest(config.projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants.map((v) => v.id === config.variantId ? { ...v, vttPath: undefined } : v);
      if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
      // Keep the legacy outputs.audiobook.vttPath cleared too when this is the primary
      // audiobook output.
      const v = mf.variants.find((x) => x.id === config.variantId);
      if (v && v.kind === 'audiobook' && mf.outputs?.audiobook
          && normalizeFsPath(path.resolve(path.join(projectDir, mf.outputs.audiobook.path)))
             === normalizeFsPath(path.resolve(m4bPath))) {
        mf.outputs.audiobook.vttPath = undefined;
      }
    });
    if (!saved?.success) throw new Error(saved?.error || 'Failed to link transcript to the version');

    glog(`[generate-sentences] linked VTT to variant, DONE job=${jobId} out=${outVtt}`);
    sendProgress(mainWindow, jobId, 100, 'Transcript ready');
    sendComplete(mainWindow, jobId, true, outVtt);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generate sentences failed';
    if (message !== 'Cancelled') {
      gerror(`[generate-sentences] FAILED job=${jobId}: ${message}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
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

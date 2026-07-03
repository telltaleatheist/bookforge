/**
 * RVC enhancement as a standalone queue job.
 *
 * This is the queue-visible counterpart to the inline RVC pass that used to live
 * inside reassembly. It re-renders a session's cached sentences through an RVC
 * voice into a SCRATCH dir under [library]/tmp, reporting per-sentence progress
 * so the queue shows a real ETA (same chunk-rate machinery as TTS), then hands
 * the scratch dir back to the queue, which feeds it to a downstream reassembly
 * job (config.sentencesDir) that assembles it and deletes it (merge-and-delete).
 *
 * On success the scratch dir is LEFT in place for reassembly to consume + delete.
 * On failure/cancel it's removed here. The startup tmp-wipe backstops either way.
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import { enhanceSentences, rvcEnhancementReady } from './rvc-bridge';
import { getRvcVoiceById } from './rvc-models';
import { getDefaultE2aTmpPath } from './e2a-paths';
import { acquireGpu, releaseGpu } from './gpu-arbiter';

export interface RvcEnhancementConfig {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  /** RVC asset id; resolved to the urvc model folder name. */
  voiceId: string;
  indexRate?: number;
  protectRate?: number;
  nSemitones?: number;
}

export interface RvcProgress {
  phase: 'preparing' | 'enhancing' | 'complete' | 'error';
  percentage: number;
  /** Sentences enhanced so far / total — drive the queue's chunk-rate ETA. */
  processed?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface RvcEnhancementResult {
  success: boolean;
  /** The scratch dir of enhanced sentences (under [library]/tmp) on success. */
  scratchDir?: string;
  error?: string;
  wasStopped?: boolean;
}

// Active runs, so stopRvcEnhancement can abort the in-flight urvc process.
const activeAborts = new Map<string, AbortController>();

function sendProgress(win: BrowserWindow | null, jobId: string, progress: RvcProgress): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('rvc:progress', { jobId, progress });
}

/**
 * Run an RVC enhancement job. Resolves with the scratch dir of enhanced
 * sentences (for the downstream reassembly job) or an error. The queue awaits
 * this result; progress flows out-of-band via 'rvc:progress'.
 */
export async function runRvcEnhancement(
  jobId: string,
  config: RvcEnhancementConfig,
  mainWindow: BrowserWindow | null
): Promise<RvcEnhancementResult> {
  const voice = getRvcVoiceById(config.voiceId);
  if (!voice) {
    return { success: false, error: `RVC enhancement: unknown voice "${config.voiceId}".` };
  }
  const ready = rvcEnhancementReady();
  if (!ready.ok) {
    return { success: false, error: `RVC enhancement unavailable: ${ready.reason}` };
  }
  const srcSentences = path.join(config.processDir, 'chapters', 'sentences');
  if (!fs.existsSync(srcSentences)) {
    return { success: false, error: 'RVC enhancement: cached sentences not found for this session.' };
  }

  // Scratch under [library]/tmp, keyed by session so a reassembly job could find
  // it deterministically too; cleaned by the consumer (reassembly) or on failure.
  const outputDir = path.join(getDefaultE2aTmpPath(), `rvc-${config.sessionId || jobId}`);

  const abort = new AbortController();
  activeAborts.set(jobId, abort);

  // Take the shared GPU lease: an ungated RVC pass co-resides with a running/loading
  // Orpheus or XTTS job (or the cleanup LLM) and the pair OOMs the card. TTS jobs
  // hold this same lease for their whole run, so this waits its turn instead.
  const gpuOwner = `rvc:job:${jobId}`;
  sendProgress(mainWindow, jobId, {
    phase: 'preparing',
    percentage: 0,
    message: 'Waiting for the GPU…',
  });
  await acquireGpu(gpuOwner, { timeoutMs: 10 * 60_000 });

  sendProgress(mainWindow, jobId, {
    phase: 'preparing',
    percentage: 0,
    message: `Enhancing voice with ${voice.label}…`,
  });

  try {
    await enhanceSentences({
      sentencesDir: srcSentences,
      outputDir,
      modelName: voice.modelName,
      indexRate: voice.forceIndexRate0 ? 0 : (voice.defaultIndexRate ?? config.indexRate ?? 0.5),
      protectRate: config.protectRate ?? 0.5,
      nSemitones: config.nSemitones ?? 0,
      signal: abort.signal,
      onProgress: (done, total) => sendProgress(mainWindow, jobId, {
        phase: 'enhancing',
        percentage: total ? Math.round((done / total) * 100) : 0,
        processed: done,
        total,
        message: `Enhancing voice with ${voice.label}… (${done}/${total})`,
      }),
    });

    activeAborts.delete(jobId);
    sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Voice enhancement complete.' });
    return { success: true, scratchDir: outputDir };
  } catch (err) {
    activeAborts.delete(jobId);
    const wasStopped = abort.signal.aborted;
    // Remove the partial scratch set — on success reassembly owns deletion, but a
    // failed/cancelled run leaves a half-written dir that nothing downstream uses.
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    const error = wasStopped
      ? 'RVC enhancement cancelled'
      : `RVC enhancement failed: ${(err as Error).message || err}`;
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error, wasStopped };
  } finally {
    releaseGpu(gpuOwner);
  }
}

/** Abort an in-flight RVC enhancement job (force-kills the urvc process). */
export function stopRvcEnhancement(jobId: string): void {
  const abort = activeAborts.get(jobId);
  if (abort) {
    console.log(`[RVC-JOB] Stopping enhancement job ${jobId}`);
    abort.abort();
  }
}

/** True if an RVC enhancement job is currently running. */
export function isRvcEnhancementActive(jobId: string): boolean {
  return activeAborts.has(jobId);
}

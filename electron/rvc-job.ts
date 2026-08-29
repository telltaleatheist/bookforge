/**
 * RVC enhancement as a standalone queue job.
 *
 * This is the queue-visible counterpart to the inline RVC pass that used to live
 * inside reassembly. It re-renders a session's cached sentences through an RVC
 * voice, reporting per-sentence progress so the queue shows a real ETA (same
 * chunk-rate machinery as TTS), then hands the directory back to the queue, which
 * feeds it to a downstream reassembly job (`config.sentencesDir`).
 *
 * ── The converted set is DURABLE (Owen's ruling, 2026-08-29) ────────────────
 *
 * It used to be a scratch dir under [library]/tmp that the assembly deleted after
 * merging it. With the current models the pass costs about as much GPU wall-clock
 * as the narration itself and re-assembly is routine, so throwing it away meant
 * paying for the whole conversion again to fix a metadata field. It is now
 * `<processDir>/chapters/sentences-rvc-<voiceId>/`, a sibling of the raw cache,
 * with a manifest that says what it was derived from and with — see
 * `derived-sentences.ts`. The assembly consumes it and LEAVES it; its lifetime is
 * the session's.
 *
 * ── Denoise rides in front of it, and shares its set ────────────────────────
 *
 * RVC extracts f0/content features from its input and input noise corrupts that
 * extraction, so when `finalDenoise` is on the conversion reads the session's
 * DENOISED set rather than the raw one — the same durable set the standalone
 * `final-denoise` step produces, derived by the same code, so the two chains
 * share one copy and either can reuse what the other built. The denoise manifest
 * is recorded as this set's `upstream`, so re-denoising with a different gap
 * invalidates the conversion built on top of it too.
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow } from 'electron';

import { enhanceSentences, rvcEnhancementReady } from './rvc-bridge';
import { finalDenoiseReady } from './denoise-bridge';
import { getRvcVoiceById, resolveRvcIndexRate } from './rvc-models';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { deriveDenoisedSentences, planDenoisedSentences, type DenoisePlan } from './denoise-job';
import {
  abandonDerivedSentences,
  beginDerivedSentences,
  checkDerivedSentences,
  commitDerivedSentences,
  derivedSentencesDir,
  rawSentencesDir,
  type DerivedRequest,
} from './derived-sentences';
import * as fs from 'fs';

export interface RvcEnhancementConfig {
  /**
   * The session's process dir — the ONE thing this pass needs, because both the
   * sentences it reads and the set it writes are inside it. The session id and
   * dir the step carries are for the artifact it publishes, not for here.
   */
  processDir: string;
  /** RVC asset id; resolved to the urvc model folder name. */
  voiceId: string;
  indexRate?: number;
  /** Inverted scale — lower protects more, 0.5 is off. See PROTECT_RATE_NOTE. */
  protectRate?: number;
  nSemitones?: number;
  /** Pitch-extraction method; absent leaves urvc on its own default. */
  f0Method?: string;
  /** f0 analysis hop; crepe-family only, absent leaves urvc on its own default. */
  hopLength?: number;
  /** Final-audio denoise: convert the session's DENOISED sentences rather than
   *  its raw ones. Rides along on this job (instead of the downstream assembly)
   *  so the denoise-before-RVC ordering holds in the chained queue flow too. */
  finalDenoise?: boolean;
  /** The inter-sentence gap baked into the denoised set, when one is derived.
   *  Absent leaves the session's provenance in charge. See denoise-job.ts. */
  sentenceGap?: number;
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
  /** The durable converted set, on success. */
  scratchDir?: string;
  /** True when the set was already on disk and valid — no GPU work was done. */
  reused?: boolean;
  error?: string;
  wasStopped?: boolean;
}

// Active runs, so stopRvcEnhancement can abort the in-flight urvc process.
const activeAborts = new Map<string, AbortController>();

function sendProgress(win: BrowserWindow | null, jobId: string, progress: RvcProgress): void {
  publishBridgeEvent('rvc:progress', { jobId, progress });
  if (!win || win.isDestroyed()) return;
  win.webContents.send('rvc:progress', { jobId, progress });
}

/**
 * Run an RVC enhancement job. Resolves with the durable converted set (for the
 * downstream reassembly job) or an error. The queue awaits this result; progress
 * flows out-of-band via 'rvc:progress'.
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
  if (config.finalDenoise) {
    const dnReady = finalDenoiseReady();
    if (!dnReady.ok) {
      return { success: false, error: `Final denoise unavailable: ${dnReady.reason}` };
    }
  }
  if (!fs.existsSync(rawSentencesDir(config.processDir))) {
    return { success: false, error: 'RVC enhancement: cached sentences not found for this session.' };
  }

  const log = (message: string): void => console.log(`[RVC-JOB] ${jobId}: ${message}`);

  // What this conversion reads, and what it records having read.
  let denoisePlan: DenoisePlan | null = null;
  if (config.finalDenoise) {
    try {
      denoisePlan = await planDenoisedSentences(config.processDir, config.sentenceGap);
    } catch (err) {
      return { success: false, error: (err as Error).message || String(err) };
    }
  }

  const indexRate = resolveRvcIndexRate(voice, config.indexRate);
  const protectRate = config.protectRate ?? 0.5;
  const nSemitones = config.nSemitones ?? 0;
  const outputDir = derivedSentencesDir(config.processDir, 'rvc', config.voiceId);
  const buildRequest = (): DerivedRequest => ({
    dir: outputDir,
    kind: 'rvc',
    params: {
      voiceId: config.voiceId,
      modelName: voice.modelName,
      indexRate,
      protectRate,
      nSemitones,
      f0Method: config.f0Method ?? null,
      hopLength: config.hopLength ?? null,
    },
    sourceDir: denoisePlan ? denoisePlan.dir : rawSentencesDir(config.processDir),
    upstream: denoisePlan ? { kind: 'denoise', params: denoisePlan.request.params } : null,
  });

  // The reuse question is answered BEFORE the GPU is asked for — but only when
  // the source is settled. A denoised source that must itself be re-derived will
  // change under this set, so there is nothing to check yet.
  if (!denoisePlan || denoisePlan.verdict.reusable) {
    const verdict = checkDerivedSentences(buildRequest());
    if (verdict.reusable) {
      log(`reusing the converted sentences already derived for this session (${outputDir}) — no GPU work needed.`);
      sendProgress(mainWindow, jobId, {
        phase: 'complete', percentage: 100,
        message: `Voice ${voice.label} already rendered for this session — reused.`,
      });
      return { success: true, scratchDir: outputDir, reused: true };
    }
    log(`converted set needs deriving — ${verdict.reason}.`);
  }

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

  try {
    if (denoisePlan) {
      // The lease is already held here, which is exactly why this helper never
      // takes one of its own.
      await deriveDenoisedSentences(denoisePlan, {
        scratchKey: jobId,
        signal: abort.signal,
        log,
        onGapStart: () => sendProgress(mainWindow, jobId, {
          phase: 'preparing', percentage: 0, message: 'Normalizing sentence gaps…',
        }),
        onDenoiseProgress: (done, total) => sendProgress(mainWindow, jobId, {
          phase: 'preparing',
          percentage: total ? Math.round((done / total) * 100) : 0,
          message: `Denoising audio… (block ${done}/${total})`,
        }),
      });
    }

    // Re-asked with the source now settled: a freshly derived denoise changes
    // every source fingerprint, so the answer from before the GPU wait does not
    // carry over.
    const request = buildRequest();
    const verdict = checkDerivedSentences(request);
    if (verdict.reusable) {
      activeAborts.delete(jobId);
      log(`reusing the converted sentences already derived for this session (${outputDir}).`);
      sendProgress(mainWindow, jobId, {
        phase: 'complete', percentage: 100,
        message: `Voice ${voice.label} already rendered for this session — reused.`,
      });
      return { success: true, scratchDir: outputDir, reused: true };
    }
    log(`deriving ${outputDir} — ${verdict.reason}.`);

    sendProgress(mainWindow, jobId, {
      phase: 'preparing',
      percentage: 0,
      message: `Enhancing voice with ${voice.label}…`,
    });

    const partial = beginDerivedSentences(outputDir);
    try {
      await enhanceSentences({
        sentencesDir: request.sourceDir,
        outputDir: partial,
        modelName: voice.modelName,
        indexRate,
        protectRate,
        nSemitones,
        // Absent stays absent — that is what leaves urvc on its own default.
        f0Method: config.f0Method,
        hopLength: config.hopLength,
        signal: abort.signal,
        onProgress: (done, total) => sendProgress(mainWindow, jobId, {
          phase: 'enhancing',
          percentage: total ? Math.round((done / total) * 100) : 0,
          processed: done,
          total,
          message: `Enhancing voice with ${voice.label}… (${done}/${total})`,
        }),
      });
      commitDerivedSentences(outputDir, request);
    } catch (err) {
      abandonDerivedSentences(outputDir);
      throw err;
    }

    activeAborts.delete(jobId);
    log(`voice enhancement complete: ${outputDir}`);
    sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Voice enhancement complete.' });
    return { success: true, scratchDir: outputDir, reused: false };
  } catch (err) {
    activeAborts.delete(jobId);
    const wasStopped = abort.signal.aborted;
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

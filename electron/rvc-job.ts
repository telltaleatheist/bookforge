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
 * ── IT NO LONGER DENOISES ITS OWN INPUT (Owen's ruling, 2026-08-29) ─────────
 *
 * It used to: `finalDenoise` on this config meant "derive the session's denoised
 * set first and convert THAT", which was how the denoise-before-RVC ordering was
 * realised. The ordering is now the USER's, stated on the Enhance tab, and it is
 * realised by the chain rather than inside this job — two rows, each a clean
 * transform of its parent's output, in whichever order was chosen. So a config
 * that still carries `finalDenoise` is REFUSED by name (see `runRvcEnhancement`),
 * exactly as an assembly config carrying it is.
 *
 * What replaces it is `sentencesDir`: the set this conversion reads when a
 * denoise produced it. The source's own manifest says which chain that is, so
 * the output is named after the whole chain — `sentences-denoised-rvc-<voice>`
 * for denoise-then-convert, `sentences-rvc-<voice>` for a conversion of the raw
 * sentences — and the denoise manifest is recorded as this set's `upstream`, so
 * re-denoising with a different gap invalidates the conversion built on it.
 *
 * ── AND IT MAY BE THE PASS THAT BAKES THE GAP ───────────────────────────────
 *
 * The inter-sentence gap must be applied to RAW sentences (sentence-gap.ts). When
 * the conversion is the first pass, it is the one that reads them, so it runs the
 * gap pass itself and records it in its own params. When it is second, the
 * denoise in front of it already did, and it runs none.
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow } from 'electron';

import { enhanceSentences, rvcEnhancementReady } from './rvc-bridge';
import { getRvcVoiceById, resolveRvcIndexRate } from './rvc-models';
import { getDefaultE2aTmpPath } from './e2a-paths';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import {
  abandonDerivedSentences,
  beginDerivedSentences,
  checkDerivedSentences,
  commitDerivedSentences,
  derivedChainDir,
  derivedChainOf,
  rawSentencesDir,
  readDerivedManifest,
  type DerivedPass,
  type DerivedRequest,
} from './derived-sentences';
import {
  applySentenceGap,
  planSentenceGap,
  sentenceGapParams,
  NO_SENTENCE_GAP,
  type SentenceGapPlan,
} from './sentence-gap';
import * as fs from 'fs';
import * as path from 'path';

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
  /**
   * THE SET THIS PASS CONVERTS, when a denoise produced it — absent for the
   * ordinary case of converting the session's RAW cached sentences.
   *
   * Set exactly when this conversion is SECOND in the chain. It decides what is
   * read, what the output set is called, and what is recorded as `upstream`, all
   * from the source set's own manifest.
   */
  sentencesDir?: string;
  /**
   * The inter-sentence gap to bake in, or absent to let the session's own
   * provenance decide.
   *
   * ONLY MEANINGFUL WHEN THIS PASS READS THE RAW SENTENCES — it is then the pass
   * that runs the gap normalization, because the gap can only be detected on raw
   * audio (sentence-gap.ts). Sent alongside `sentencesDir` it is refused rather
   * than ignored.
   */
  sentenceGap?: number;
  /**
   * NOT A PASS THIS JOB RUNS ANY MORE — read only so a row queued before the
   * ordering ruling is refused BY NAME. See the header and `runRvcEnhancement`.
   */
  finalDenoise?: boolean;
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
  /*
   * THE CONVERSION DOES NOT DENOISE ANY MORE — refused loudly, never ignored.
   *
   * Since the ordering ruling (2026-08-29) the denoise is its own row in the
   * chain, in whichever position the user chose. A config that still carries the
   * flag is one of two things — a row queued before the change, or a call site
   * the conversion missed — and both must SAY so. Ignoring it would convert the
   * RAW sentences and hand back audio nobody could tell was never denoised.
   */
  if (config.finalDenoise === true) {
    return {
      success: false,
      error:
        'This voice conversion asks to denoise its own input, which the conversion no longer '
        + 'does: the denoise is its own step now, and the Enhance tab is where the two passes and '
        + 'their order are chosen. Queue the run again from the narration dialog — a row queued '
        + 'before this change cannot be retried as-is, because running it would convert '
        + 'un-denoised audio in silence.',
    };
  }

  const voice = getRvcVoiceById(config.voiceId);
  if (!voice) {
    return { success: false, error: `RVC enhancement: unknown voice "${config.voiceId}".` };
  }
  const ready = rvcEnhancementReady();
  if (!ready.ok) {
    return { success: false, error: `RVC enhancement unavailable: ${ready.reason}` };
  }
  const source = config.sentencesDir ?? rawSentencesDir(config.processDir);
  if (!fs.existsSync(source)) {
    return {
      success: false,
      error: config.sentencesDir === undefined
        ? 'RVC enhancement: cached sentences not found for this session.'
        : `RVC enhancement: the set it was told to convert is not there (${source}).`,
    };
  }

  const log = (message: string): void => console.log(`[RVC-JOB] ${jobId}: ${message}`);

  /*
   * WHICH CHAIN THIS SET BELONGS TO, and whether this pass owns the gap — both
   * decided by whether it reads the raw sentences. The source's provenance is
   * read off the SET's own manifest, never threaded through the config: a copy
   * of it here is the one that goes stale when the upstream is re-derived.
   */
  let chain: DerivedPass[];
  let upstream: DerivedRequest['upstream'];
  let gap: SentenceGapPlan;
  try {
    if (config.sentencesDir === undefined) {
      gap = await planSentenceGap(config.processDir, config.sentenceGap);
      chain = [{ kind: 'rvc', key: config.voiceId }];
      upstream = null;
    } else {
      if (config.sentenceGap !== undefined) {
        throw new Error(
          'This conversion was given both a sentence gap and a set to convert that another pass '
          + 'produced. The gap can only be applied to the raw sentences, so it belongs to '
          + 'whichever pass reads them first — never to this one. This is a bug in the run that '
          + 'composed it.',
        );
      }
      const sourceManifest = readDerivedManifest(config.sentencesDir);
      if (sourceManifest === null) {
        throw new Error(
          `RVC enhancement: ${config.sentencesDir} carries no derivation manifest, so this pass `
          + 'cannot say what it is converting or when the result would go stale. Re-run the pass '
          + 'that produced it.',
        );
      }
      const sourceChain = derivedChainOf(sourceManifest);
      if (sourceChain.some((pass) => pass.kind === 'rvc')) {
        throw new Error(
          'This run would convert a set that has already been through a voice conversion. One '
          + 'conversion per chain: converting a conversion renders a voice model against its own '
          + 'output, which is not a tuning anybody auditioned.',
        );
      }
      chain = [...sourceChain, { kind: 'rvc', key: config.voiceId }];
      upstream = { kind: sourceManifest.kind, params: sourceManifest.params };
      gap = NO_SENTENCE_GAP;
    }
  } catch (err) {
    return { success: false, error: (err as Error).message || String(err) };
  }

  const indexRate = resolveRvcIndexRate(voice, config.indexRate);
  const protectRate = config.protectRate ?? 0.5;
  const nSemitones = config.nSemitones ?? 0;
  let outputDir: string;
  try {
    outputDir = derivedChainDir(config.processDir, chain);
  } catch (err) {
    return { success: false, error: (err as Error).message || String(err) };
  }
  const request: DerivedRequest = {
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
      // Carried because this pass may be the one that bakes the gap in: moving
      // the slider must then re-derive THIS set, exactly as it re-derives a
      // denoise that ran first. Both null when the gap was baked upstream.
      ...sentenceGapParams(gap),
    },
    sourceDir: source,
    upstream,
  };

  // The reuse question is answered BEFORE the GPU is asked for: a run that has
  // nothing to compute must not queue behind a nine-hour narration to say so.
  {
    const verdict = await checkDerivedSentences(request);
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

  /*
   * The gap pass is transient: its output only ever feeds the conversion, and
   * the converted set is the deliverable. Scratch, not a derived artifact — and
   * named with the STEP ID, which is what the startup tmp sweep spares while the
   * queue still has work in that step (`liveStepIds`, main.ts).
   */
  const gapDir = path.join(getDefaultE2aTmpPath(), `gap-${jobId}`);
  try {
    let enhanceSource = source;
    if (gap.gapSeconds !== undefined) {
      // THIS pass reads the raw sentences, so THIS pass bakes the gap in — see
      // sentence-gap.ts. CPU work, covered by the lease already held.
      sendProgress(mainWindow, jobId, {
        phase: 'preparing', percentage: 0, message: 'Normalizing sentence gaps…',
      });
      log(`Sentence-gap normalization starting (gap ${gap.gapSeconds}s, floor ${gap.minGapSeconds}s).`);
      await applySentenceGap(gap, source, gapDir, { signal: abort.signal });
      enhanceSource = gapDir;
      log('Sentence-gap normalization complete.');
    }

    sendProgress(mainWindow, jobId, {
      phase: 'preparing',
      percentage: 0,
      message: `Enhancing voice with ${voice.label}…`,
    });

    const partial = beginDerivedSentences(outputDir);
    try {
      await enhanceSentences({
        sentencesDir: enhanceSource,
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
      await commitDerivedSentences(outputDir, request);
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
    try { fs.rmSync(gapDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

/**
 * FINAL DENOISE AS A STANDALONE QUEUE JOB.
 *
 * ── Why it left the assembly ────────────────────────────────────────────────
 *
 * The denoise used to run inside `startReassembly`, which meant the reassembly
 * step declared itself a GPU step whenever it was on — and then held the one GPU
 * slot for its ENTIRE run: three minutes of gap normalization (CPU), an hour of
 * roformer (GPU), and then chapter combine plus AAC encode, which are pure CPU and
 * are the long tail. A nine-hour narration sat behind an encode that never touches
 * the card. Owen, 2026-08-29: split it out, so assembly runs in the CPU lane and
 * the GPU frees the moment the denoise finishes.
 *
 * So this is the same shape as `rvc-job.ts`: a bridge the queue's own step module
 * (`queue-steps/final-denoise.ts`) calls, reporting per-block progress, handing
 * back a DIRECTORY of sentences that the assembly behind it consumes via e2a's
 * `--sentences_dir`.
 *
 * ── Gap normalization comes with it, and must ───────────────────────────────
 *
 * Gap normalization strips e2a's artificial trailing pad by detecting its
 * EXACTLY-zero samples, and the roformer turns those zeros into dithered
 * near-zeros. Gap therefore has to run on the RAW cached sentences and BEFORE the
 * denoise — it cannot be left behind in the assembly, which now sees only the
 * denoised set. It is CPU work and holds no GPU lease of its own; the step's slot
 * covers it.
 *
 * ── The output is DURABLE ───────────────────────────────────────────────────
 *
 * It is not a scratch dir the assembly deletes. It is
 * `<processDir>/chapters/sentences-denoised/`, a sibling of the raw cache, with a
 * manifest that says what it was derived from and with — see
 * `derived-sentences.ts` for the whole reasoning. A second assembly of the same
 * session REUSES it and costs minutes instead of an hour.
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { denoiseSentences, finalDenoiseReady, normalizeSentenceGaps } from './denoise-bridge';
import { resolveSessionSentenceGap } from './reassembly-bridge';
import { resolveOrpheusMinChunkGap } from './orpheus-models';
import { getDefaultE2aTmpPath } from './e2a-paths';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import {
  abandonDerivedSentences,
  beginDerivedSentences,
  checkDerivedSentences,
  commitDerivedSentences,
  derivedSentencesDir,
  rawSentencesDir,
  type DerivedManifest,
  type DerivedRequest,
  type DerivedVerdict,
} from './derived-sentences';

export interface FinalDenoiseConfig {
  /**
   * The session's process dir — the ONE thing this pass needs, because both the
   * sentences it reads and the set it writes are inside it. There is deliberately
   * no session id or session dir here: the step resolves those for its artifact,
   * and a copy of them down here would be two answers to which session this is.
   */
  processDir: string;
  /**
   * The inter-sentence gap to bake in, in seconds, or absent to let the
   * session's own provenance decide (an Orpheus voice's tuned value, else the
   * visible default; a non-Orpheus session normalizes not at all).
   *
   * It lives on THIS step now rather than on the assembly, because this is where
   * the gap pass runs. It is also part of the derived set's identity: changing it
   * re-derives the denoised sentences, which is inherent to baking the gap in
   * before the roformer sees the audio.
   */
  sentenceGap?: number;
}

export interface FinalDenoiseProgress {
  phase: 'preparing' | 'denoising' | 'complete' | 'error';
  percentage: number;
  /** Blocks denoised so far / total — drives the queue's rate-based ETA. */
  processed?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface FinalDenoiseResult {
  success: boolean;
  /** The durable denoised set, on success. */
  outputDir?: string;
  /** True when the set was already on disk and valid — no GPU work was done. */
  reused?: boolean;
  error?: string;
  wasStopped?: boolean;
}

const activeAborts = new Map<string, AbortController>();

function sendProgress(win: BrowserWindow | null, jobId: string, progress: FinalDenoiseProgress): void {
  publishBridgeEvent('final-denoise:progress', { jobId, progress });
  if (!win || win.isDestroyed()) return;
  win.webContents.send('final-denoise:progress', { jobId, progress });
}

/** What a denoise derivation for this session would be, and whether the set
 *  already on disk answers it. Pure: reads the session, writes nothing. */
export interface DenoisePlan {
  dir: string;
  request: DerivedRequest;
  verdict: DerivedVerdict;
  /** Undefined = no gap pass at all (a non-Orpheus session with no explicit knob). */
  gapSeconds: number | undefined;
  minGapSeconds: number;
}

export async function planDenoisedSentences(
  processDir: string,
  sentenceGap?: number,
): Promise<DenoisePlan> {
  const source = rawSentencesDir(processDir);
  if (!fs.existsSync(source)) {
    throw new Error(`Final denoise: cached sentences not found for this session (${source}).`);
  }
  // Assembly always runs `--tts_engine xtts`, so the Orpheus voice — and every
  // per-voice value keyed off it — can only come from the session's provenance.
  const provenance = await resolveSessionSentenceGap(processDir);
  const gapSeconds = typeof sentenceGap === 'number'
    ? sentenceGap
    : (provenance.isOrpheus ? provenance.gap : undefined);
  const minGapSeconds = resolveOrpheusMinChunkGap(provenance.voice) ?? 0;

  const dir = derivedSentencesDir(processDir, 'denoise');
  const request: DerivedRequest = {
    dir,
    kind: 'denoise',
    params: {
      // `null` rather than absent: "no gap pass ran" is an answer, and it must
      // be distinguishable from a set derived before the field existed.
      gapSeconds: gapSeconds ?? null,
      minGapSeconds,
      voice: provenance.voice ?? null,
    },
    sourceDir: source,
  };
  return { dir, request, verdict: checkDerivedSentences(request), gapSeconds, minGapSeconds };
}

export interface DeriveHooks {
  /** Job-log line. Every reuse and every staleness reason goes through it. */
  log: (message: string) => void;
  onGapStart?: () => void;
  onDenoiseProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * Names the transient gap scratch dir, so two jobs never collide in it.
   *
   * PASS THE STEP ID. The startup tmp sweep spares scratch whose NAME contains
   * the id of a step the queue has not finished with (`liveStepIds`, main.ts) —
   * a rule written after that sweep deleted a live assembly's gap-normalised
   * sentences — and a name keyed on anything else is outside that protection.
   */
  scratchKey: string;
}

export interface DerivedSet {
  dir: string;
  manifest: DerivedManifest;
  reused: boolean;
}

/**
 * Produce (or reuse) the session's denoised sentence set.
 *
 * THE CALLER OWNS THE GPU LEASE. Both callers already hold one for their own
 * reasons — the queue step because it IS the GPU step, `rvc-job` because its
 * conversion needs the card straight afterwards — and taking a second one here
 * would be a deadlock against a non-reentrant arbiter.
 */
export async function deriveDenoisedSentences(
  plan: DenoisePlan,
  hooks: DeriveHooks,
): Promise<DerivedSet> {
  if (plan.verdict.reusable) {
    hooks.log(`Final denoise: reusing the denoised sentences already derived for this session (${plan.dir}) — no GPU work needed.`);
    return { dir: plan.dir, manifest: plan.verdict.manifest, reused: true };
  }
  hooks.log(`Final denoise: deriving ${plan.dir} — ${plan.verdict.reason}.`);

  const ready = finalDenoiseReady();
  if (!ready.ok) throw new Error(`Final denoise unavailable: ${ready.reason}`);

  // The gap pass is transient: its output only ever feeds the roformer, and the
  // denoised set is the deliverable. Scratch, not a derived artifact.
  const gapDir = path.join(getDefaultE2aTmpPath(), `gap-${hooks.scratchKey}`);
  const partial = beginDerivedSentences(plan.dir);
  try {
    let denoiseSource = plan.request.sourceDir;
    if (plan.gapSeconds !== undefined) {
      hooks.onGapStart?.();
      hooks.log(`Sentence-gap normalization starting (gap ${plan.gapSeconds}s, floor ${plan.minGapSeconds}s).`);
      fs.rmSync(gapDir, { recursive: true, force: true });
      // CPU-only (soundfile/numpy array work, no torch device).
      await normalizeSentenceGaps({
        sentencesDir: plan.request.sourceDir,
        outputDir: gapDir,
        gapSeconds: plan.gapSeconds,
        minGapSeconds: plan.minGapSeconds,
        signal: hooks.signal,
      });
      denoiseSource = gapDir;
      hooks.log('Sentence-gap normalization complete.');
    }

    await denoiseSentences({
      sentencesDir: denoiseSource,
      outputDir: partial,
      signal: hooks.signal,
      onProgress: hooks.onDenoiseProgress,
    });

    const manifest = commitDerivedSentences(plan.dir, plan.request);
    hooks.log(`Final denoise complete: ${plan.dir} (${manifest.outputCount} sentences).`);
    return { dir: plan.dir, manifest, reused: false };
  } catch (err) {
    abandonDerivedSentences(plan.dir);
    throw err;
  } finally {
    try { fs.rmSync(gapDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Run a final-denoise job. Resolves with the durable denoised set for the
 * assembly behind it. Progress flows out-of-band via 'final-denoise:progress'.
 */
export async function runFinalDenoise(
  jobId: string,
  config: FinalDenoiseConfig,
  mainWindow: BrowserWindow | null,
): Promise<FinalDenoiseResult> {
  let plan: DenoisePlan;
  try {
    plan = await planDenoisedSentences(config.processDir, config.sentenceGap);
  } catch (err) {
    const error = (err as Error).message || String(err);
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  // The reuse question is answered BEFORE the GPU is asked for: a run that has
  // nothing to compute must not queue behind a nine-hour narration to say so.
  if (plan.verdict.reusable) {
    console.log(`[DENOISE-JOB] Reusing derived set for ${jobId}: ${plan.dir}`);
    sendProgress(mainWindow, jobId, {
      phase: 'complete', percentage: 100,
      message: 'Denoised sentences already derived for this session — reused.',
    });
    return { success: true, outputDir: plan.dir, reused: true };
  }

  const abort = new AbortController();
  activeAborts.set(jobId, abort);

  // The same shared lease every model pass takes: the roformer runs on the env's
  // torch device and must not co-reside with a running TTS/LLM job.
  const gpuOwner = `denoise:job:${jobId}`;
  sendProgress(mainWindow, jobId, { phase: 'preparing', percentage: 0, message: 'Waiting for the GPU…' });
  await acquireGpu(gpuOwner, { timeoutMs: 10 * 60_000 });

  try {
    const set = await deriveDenoisedSentences(plan, {
      scratchKey: jobId,
      signal: abort.signal,
      log: (message) => console.log(`[DENOISE-JOB] ${jobId}: ${message}`),
      onGapStart: () => sendProgress(mainWindow, jobId, {
        phase: 'preparing', percentage: 0, message: 'Normalizing sentence gaps…',
      }),
      onDenoiseProgress: (done, total) => sendProgress(mainWindow, jobId, {
        phase: 'denoising',
        percentage: total ? Math.round((done / total) * 100) : 0,
        processed: done,
        total,
        message: `Denoising audio… (block ${done}/${total})`,
      }),
    });
    activeAborts.delete(jobId);
    sendProgress(mainWindow, jobId, { phase: 'complete', percentage: 100, message: 'Denoise complete.' });
    return { success: true, outputDir: set.dir, reused: set.reused };
  } catch (err) {
    activeAborts.delete(jobId);
    const wasStopped = abort.signal.aborted;
    const error = wasStopped
      ? 'Final denoise cancelled'
      : `Final denoise failed: ${(err as Error).message || err}`;
    sendProgress(mainWindow, jobId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error, wasStopped };
  } finally {
    releaseGpu(gpuOwner);
  }
}

/** Abort an in-flight final-denoise job (kills the separator/ffmpeg child). */
export function stopFinalDenoise(jobId: string): void {
  const abort = activeAborts.get(jobId);
  if (abort) {
    console.log(`[DENOISE-JOB] Stopping denoise job ${jobId}`);
    abort.abort();
  }
}

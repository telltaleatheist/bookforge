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
 * ── Gap normalization comes with it, WHEN THIS PASS READS THE RAW SENTENCES ─
 *
 * Gap normalization strips e2a's artificial trailing pad by detecting its
 * EXACTLY-zero samples, and the roformer turns those zeros into dithered
 * near-zeros. Gap therefore has to run on the RAW cached sentences and BEFORE the
 * denoise — it cannot be left behind in the assembly, which now sees only the
 * derived set. It is CPU work and holds no GPU lease of its own; the step's slot
 * covers it. The rules live in `sentence-gap.ts`, because since Owen's ordering
 * ruling the conversion can be the pass that reads the raw sentences instead.
 *
 * ── IT MAY DENOISE ANOTHER PASS'S OUTPUT ────────────────────────────────────
 *
 * `config.sentencesDir` is the set this pass reads when it is SECOND in the
 * chain — the user chose "convert first, then denoise". Then it runs no gap pass
 * (the conversion already baked it), and it names its output after the whole
 * chain: `sentences-rvc-<voice>-denoised` rather than `sentences-denoised`. The
 * source's own manifest is what says which chain that is; it is read off the set
 * rather than threaded through the config, so it cannot disagree with the set.
 *
 * ── The output is DURABLE ───────────────────────────────────────────────────
 *
 * It is not a scratch dir the assembly deletes. It is a sibling of the raw cache
 * with a manifest that says what it was derived from and with — see
 * `derived-sentences.ts` for the whole reasoning. A second assembly of the same
 * session REUSES it and costs minutes instead of an hour.
 *
 * ── …AND THE ONLY THING THAT TOUCHES THE LIBRARY SHARE ──────────────────────
 *
 * Sessions live on `Z:`, ~25 MB/s of SMB away. The pass used to cross that wire
 * four times for one book: read the raw sentences, write the gap-normalized set
 * back (the e2a scratch dir sits on the library volume), read that set again to
 * build the blocks, and then write the denoised sentences one ffmpeg spawn at a
 * time straight into the `.partial`. About 7 GB of traffic and two rounds of
 * per-file write latency for a 1,500-sentence book — enough that a denoise and
 * an assembly sharing the pipe looked to the user like a stall.
 *
 * Every transient byte is now local: the gap set and the sliced-back set are both
 * `os.tmpdir()` staging (the same `bf-` mkdtemp idiom `denoise-bridge` already
 * uses for its blocks), and the share sees exactly one bulk read of the source
 * and one bulk copy of the finished set. The DURABLE home is unchanged — the set
 * still lands inside the session on `Z:`, and the atomic `.partial` → rename
 * commit is what makes the extra hop free (`commitDerivedSentences`).
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { denoiseSentences, finalDenoiseReady } from './denoise-bridge';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import {
  abandonDerivedSentences,
  assertStagingSpace,
  beginDerivedSentences,
  checkDerivedSentences,
  commitDerivedSentences,
  copySentenceSetInto,
  derivedChainDir,
  derivedChainOf,
  fingerprintSentences,
  rawSentencesDir,
  readDerivedManifest,
  sentenceSetBytes,
  type DerivedManifest,
  type DerivedPass,
  type DerivedRequest,
  type DerivedVerdict,
} from './derived-sentences';
import {
  applySentenceGap,
  planSentenceGap,
  sentenceGapParams,
  NO_SENTENCE_GAP,
  type SentenceGapPlan,
} from './sentence-gap';

export interface FinalDenoiseConfig {
  /**
   * The session's process dir — the ONE thing this pass needs, because both the
   * sentences it reads and the set it writes are inside it. There is deliberately
   * no session id or session dir here: the step resolves those for its artifact,
   * and a copy of them down here would be two answers to which session this is.
   */
  processDir: string;
  /**
   * THE SET THIS PASS READS, when another enhancement pass produced it — absent
   * for the ordinary case of denoising the session's RAW cached sentences.
   *
   * Set exactly when this denoise is SECOND in the chain (the user chose
   * "convert first, then denoise"). It changes three things at once, all of them
   * from the source's own manifest: what is read, what the output set is called,
   * and what is recorded as `upstream` so a re-derivation of the conversion
   * invalidates this set too.
   */
  sentencesDir?: string;
  /**
   * The inter-sentence gap to bake in, in seconds, or absent to let the
   * session's own provenance decide (an Orpheus voice's tuned value, else the
   * visible default; a non-Orpheus session normalizes not at all).
   *
   * ONLY MEANINGFUL WHEN THIS PASS READS THE RAW SENTENCES. Sent alongside
   * `sentencesDir` it is refused rather than ignored: the gap can only be applied
   * to raw audio, so a config that states both is a composition bug, and
   * swallowing it would silently drop a value the user moved a slider to.
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
  /** How the gap is handled by THIS pass. `gapSeconds` undefined = no gap pass
   *  at all — a non-Orpheus session, or a denoise that runs second. */
  gap: SentenceGapPlan;
}

export async function planDenoisedSentences(
  processDir: string,
  sentenceGap?: number,
  /** The set to denoise, when a conversion produced it. See `FinalDenoiseConfig`. */
  sentencesDir?: string,
): Promise<DenoisePlan> {
  const source = sentencesDir ?? rawSentencesDir(processDir);
  if (!fs.existsSync(source)) {
    throw new Error(
      sentencesDir === undefined
        ? `Final denoise: cached sentences not found for this session (${source}).`
        : `Final denoise: the set it was told to denoise is not there (${source}).`,
    );
  }

  /*
   * WHICH CHAIN THIS SET BELONGS TO — asked of the SOURCE, never of the config.
   *
   * A pass that derives from another pass's output learns its provenance by
   * reading that set's manifest. Threading it through the step config instead
   * would be a second copy of a fact the set already carries, and the copy is
   * the one that goes stale when the upstream is re-derived.
   */
  let chain: DerivedPass[];
  let upstream: DerivedRequest['upstream'];
  let gap: SentenceGapPlan;
  if (sentencesDir === undefined) {
    gap = await planSentenceGap(processDir, sentenceGap);
    chain = [{ kind: 'denoise' }];
    upstream = null;
  } else {
    if (sentenceGap !== undefined) {
      throw new Error(
        'This denoise was given both a sentence gap and a set to denoise that another pass '
        + 'produced. The gap can only be applied to the raw sentences, so it belongs to whichever '
        + 'pass reads them first — never to this one. This is a bug in the run that composed it.',
      );
    }
    const sourceManifest = readDerivedManifest(sentencesDir);
    if (sourceManifest === null) {
      throw new Error(
        `Final denoise: ${sentencesDir} carries no derivation manifest, so this pass cannot say `
        + 'what it is denoising or when the result would go stale. Re-run the pass that produced '
        + 'it.',
      );
    }
    const sourceChain = derivedChainOf(sourceManifest);
    if (sourceChain.some((pass) => pass.kind === 'denoise')) {
      throw new Error(
        'This run would denoise a set that has already been denoised. One denoise per chain: a '
        + 'second roformer pass over its own output is GPU spent making the audio worse.',
      );
    }
    chain = [...sourceChain, { kind: 'denoise' }];
    upstream = { kind: sourceManifest.kind, params: sourceManifest.params };
    gap = NO_SENTENCE_GAP;
  }

  const dir = derivedChainDir(processDir, chain);
  const request: DerivedRequest = {
    dir,
    kind: 'denoise',
    params: {
      ...sentenceGapParams(gap),
      voice: gap.voice,
    },
    sourceDir: source,
    upstream,
  };
  return { dir, request, verdict: await checkDerivedSentences(request), gap };
}

export interface DeriveHooks {
  /** Job-log line. Every reuse and every staleness reason goes through it. */
  log: (message: string) => void;
  onGapStart?: () => void;
  onDenoiseProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DerivedSet {
  dir: string;
  manifest: DerivedManifest;
  reused: boolean;
}

/**
 * Produce (or reuse) the session's denoised sentence set.
 *
 * THE CALLER OWNS THE GPU LEASE. `runFinalDenoise` below holds one because it IS
 * the GPU step; taking a second one here would be a deadlock against a
 * non-reentrant arbiter.
 *
 * `rvc-job` used to call this too — the conversion denoised its own input, which
 * is how "denoise before RVC" was realised before the order became the user's
 * choice. It does not any more: the two passes are two rows, each a clean
 * transform of its parent's output, and this is the denoise's own machinery.
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

  /*
   * THE STAGING BUDGET, CHECKED BEFORE THE GPU IS SPENT.
   *
   * Two full copies of the sentence set live on local disk at once — the
   * gap-normalized input and the sliced-back output — because the roformer is
   * still reading the first while the slicer writes the second. Sized from the
   * source's own bytes, which the fingerprint has already measured.
   *
   * This is the floor, not the ceiling: `denoise-bridge` also stages the 44.1 kHz
   * stereo PCM segments and blocks it feeds the separator, which is bigger again
   * and predates this staging. Bounding THAT needs the audio's duration rather
   * than its compressed size, so it is not claimed here.
   */
  const sourceFiles = await fingerprintSentences(plan.request.sourceDir);
  const setBytes = sentenceSetBytes(sourceFiles);
  await assertStagingSpace(os.tmpdir(), setBytes * 2, 'The final denoise');

  /*
   * BOTH WORKING SETS ARE LOCAL. The gap set only ever feeds the roformer, and
   * the sliced-back set is copied to the session in one bulk pass below — so
   * neither belongs on the library share, which is SMB and pays per file.
   *
   * The `.partial` on the share is claimed HERE rather than at copy time on
   * purpose: it is one mkdir, and it proves the session is writable before an
   * hour of GPU goes into a set that could not be published.
   */
  const gapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-gap-'));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-dn-out-'));
  const partial = beginDerivedSentences(plan.dir);
  try {
    let denoiseSource = plan.request.sourceDir;
    if (plan.gap.gapSeconds !== undefined) {
      hooks.onGapStart?.();
      hooks.log(`Sentence-gap normalization starting (gap ${plan.gap.gapSeconds}s, floor ${plan.gap.minGapSeconds}s).`);
      await applySentenceGap(plan.gap, plan.request.sourceDir, gapDir, { signal: hooks.signal });
      denoiseSource = gapDir;
      hooks.log('Sentence-gap normalization complete.');
    }

    await denoiseSentences({
      sentencesDir: denoiseSource,
      outputDir: stageDir,
      signal: hooks.signal,
      onProgress: hooks.onDenoiseProgress,
      onLog: hooks.log,
    });

    // The denoise has read the gap set for the last time; drop it before the copy
    // so the two full sets never coexist with a third on the way out.
    try { fs.rmSync(gapDir, { recursive: true, force: true }); } catch { /* best-effort */ }

    // THE ONE BULK WRITE. Every invariant `denoiseSentences` enforces has already
    // held on the staged set, and `commitDerivedSentences` re-counts what actually
    // landed against the source before it writes a manifest, so a copy that fails
    // part-way can only leave an unreadable `.partial`.
    hooks.log(`Final denoise: copying ${sourceFiles.length} denoised sentences to ${plan.dir}…`);
    const copied = await copySentenceSetInto(stageDir, partial, {
      signal: hooks.signal,
      cancelledMessage: 'Final denoise cancelled',
    });

    const manifest = await commitDerivedSentences(plan.dir, plan.request);
    hooks.log(`Final denoise complete: ${plan.dir} (${manifest.outputCount} sentences, ${copied} copied).`);
    return { dir: plan.dir, manifest, reused: false };
  } catch (err) {
    abandonDerivedSentences(plan.dir);
    throw err;
  } finally {
    try { fs.rmSync(gapDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    plan = await planDenoisedSentences(config.processDir, config.sentenceGap, config.sentencesDir);
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

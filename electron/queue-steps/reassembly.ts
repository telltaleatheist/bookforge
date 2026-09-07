/**
 * reassembly — turn a rendered session into the audiobook.
 *
 * What it assembles is what its PARENT wrote, and the two shapes its parent can
 * be are the two RVC arrangements:
 *
 *  - parent is a narration (`audio-session`) → assemble the session's own
 *    sentences, optionally running the inline RVC pass;
 *  - parent is a denoise or an enhancement (`sentences`) → assemble THAT
 *    directory instead, via e2a's `--sentences_dir`, and LEAVE it: those are
 *    durable sets inside the session (electron/derived-sentences.ts), reused by
 *    the next assembly rather than re-derived at an hour of GPU apiece.
 *
 * The old row had to work this out from a sibling search plus a renderer-side Map
 * keyed by workflow id, with a "does this workflow have an rvc-enhancement job?"
 * lookup to stop RVC running twice. Both arrangements are now just what the
 * parent's output KIND says, so double-processing is not expressible.
 */
import { onBridgeEvent } from '../bridge-events';
import { coverageReportPath, summarizeCoverageReport } from '../coverage-align-job';
import { getBfpCachedSession, startReassembly, stopReassembly } from '../reassembly-bridge';
import { peekStep } from '../queue-engine';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

/** How often the tail asks the align row whether it has settled. */
const ALIGN_POLL_MS = 2_000;

/**
 * How long the tail will wait for an align row that has not STARTED.
 *
 * The two rows are released together and the cpu pool has two slots, so in the
 * ordinary run the align is already running when the assembly reaches its tail
 * and this timer is never consulted. It exists because a waiting assembly HOLDS
 * a cpu slot: if the pool were full of assemblies each waiting on an align that
 * cannot get a slot, none of them would ever move. Giving up after five minutes
 * of a never-started align is what makes that shape impossible — and it is said
 * out loud on the row, because the book then ships the estimated cues.
 */
const ALIGN_START_GRACE_MS = 5 * 60_000;

type CoverageWait = 'done' | 'failed' | 'cancelled' | 'none';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * WAIT FOR THE SIBLING ALIGN TO SETTLE — the join that makes the side branch safe.
 *
 * The align row hangs off the narration and nothing hangs off it, so it and this
 * assembly run at the same time (Owen, 2026-09-07). The audio work needs nothing
 * from it. The TAIL does: `narrator align` rewrites `<stem>.sentences.vtt` with
 * MEASURED word timings over the estimated one assembly wrote at its start, and
 * whichever file is on disk when the tail seals is the one the audiobook carries
 * forever. So the tail joins here, once, right after the rename.
 *
 * IT NEVER BLOCKS THE BOOK. Owen's ruling of 2026-09-05 — the align reports, it
 * does not gate — so every terminal answer proceeds to seal whatever transcript
 * exists; the only thing this decides is how long to wait first.
 */
async function awaitAlign(
  ctx: StepRunContext,
  alignStepId: string,
  onWait: (message: string) => void,
): Promise<CoverageWait> {
  const openedAt = Date.now();
  let everRan = false;
  for (;;) {
    if (ctx.signal.aborted) return 'cancelled';
    const peek = peekStep(alignStepId);
    // Gone from the queue entirely: there is nothing left to wait for, and a
    // waiter that kept waiting on a removed row would never return.
    if (peek === null) return 'none';
    if (peek.status === 'done') return 'done';
    if (peek.status === 'failed') return 'failed';
    // 'held' is a user stop on a resumable row. It is terminal for THIS wait:
    // the run has been paused by a person, and holding an assembly against a
    // decision they made is not a thing to do quietly.
    if (peek.status === 'cancelled' || peek.status === 'held') return 'cancelled';
    if (peek.status === 'running') everRan = true;
    else if (!everRan && Date.now() - openedAt > ALIGN_START_GRACE_MS) {
      onWait(
        'The alignment has not started; sealing the estimated transcript. Re-assemble once it '
        + 'has run to get the measured one.',
      );
      return 'none';
    }
    onWait(peek.percent === undefined || !everRan
      ? `Waiting for ${peek.label}…`
      : `Waiting for ${peek.label}… ${Math.round(peek.percent)}%`);
    await sleep(ALIGN_POLL_MS, ctx.signal);
  }
}

interface ReassemblyProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number;
    currentChapter?: number; totalChapters?: number;
    message?: string; error?: string; stages?: unknown;
  };
}

interface ReassemblyStepConfig {
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  outputDir: string;
  totalChapters?: number;
  metadata: {
    title: string; author: string; year?: string; coverPath?: string;
    outputFilename?: string; narrator?: string; series?: string;
    seriesNumber?: string; genre?: string; description?: string;
  };
  excludedChapters: number[];
  rvcEnhancement?: {
    voiceId: string; indexRate?: number; protectRate?: number; nSemitones?: number;
    f0Method?: string; hopLength?: number;
  };
  sentencesDir?: string;
  /** Delete `sentencesDir` after assembling it. Absence means KEEP — see the
   *  bridge's own note; the derived sets belong to the session, not to this row. */
  disposeSentencesDir?: boolean;
  /**
   * NOT A PASS THIS STEP RUNS ANY MORE — read only so a row queued before the
   * split is refused BY NAME. The bridge fails immediately on `true`.
   */
  finalDenoise?: boolean;
  applyDeRing?: boolean;
  sentenceGap?: number;
  /** File the result beside the project's audiobook instead of replacing it —
   *  set by the run description for a conversion of sentences it did not render. */
  registerAsNewVariant?: boolean;
  /** The voice that second version is named after. Required with the flag above. */
  rvcVoiceId?: string;
}

export const reassemblyStep: StepModule = {
  type: 'reassembly',
  // Either an audio-session or an enhanced sentence set is legitimate input, and
  // saying "a session" would refuse the enhanced chain. The step reads whichever
  // it is given, and says so below when given neither.
  consumes: null,
  produces: 'm4b',
  /*
   * THE RESOURCE FOLLOWS THE CONFIG — Owen's observation, 2026-08-19: "as soon
   * as the GPU is freed and a job moves to assembly, assembly can be done on
   * the CPU, so the next job in line can take the GPU slot".
   *
   * A plain assembly is ffmpeg: concat, encode, chapter markers — CPU work
   * (the Orpheus-only-WSL refactor runs it natively on CPU by design). It was
   * declared 'gpu' wholesale, which had a nine-hour narration waiting behind
   * an encode that never touches the card. What genuinely needs the card is
   * declared ON the config. De-ring is an ffmpeg filter and does not count.
   *
   * THE DENOISE NO LONGER APPEARS HERE. It was the second GPU condition, and
   * satisfying it made the WHOLE assembly a GPU step — the card held through the
   * combine and the encode, which are the long tail. It is its own step now
   * ('final-denoise'), so what is left on this config that needs the card is the
   * inline RVC pass alone.
   *
   * Same shape as foundry-job's resourceFor: the type is one, the resource is
   * the config's.
   */
  resource: (config: Record<string, unknown>) =>
    config['rvcEnhancement'] ? 'gpu' : 'cpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as ReassemblyStepConfig;
    if (!config) throw new Error('This assembly row has no settings, so it cannot run.');

    let sessionId = config.sessionId || ctx.input.sessionId;
    let sessionDir = config.sessionDir || ctx.input.sessionDir;
    let processDir = config.processDir || ctx.input.processDir;
    let totalChapters = config.totalChapters;

    if (!sessionId || !sessionDir || !processDir) {
      const projectDir = ctx.job.projectId;
      if (!projectDir) {
        throw new Error(
          'This assembly row names no narration session and no project, so there is nothing '
          + 'for it to assemble.',
        );
      }
      const cached = await getBfpCachedSession(projectDir);
      if (!cached) {
        throw new Error('No narration session was found in this project — narrate it first.');
      }
      sessionId = cached.sessionId;
      sessionDir = cached.sessionDir;
      processDir = cached.processDir;
      totalChapters = totalChapters
        ?? cached.chapters.filter((ch) => !ch.excluded).length;
    }

    // The enhanced set, when the step behind this one produced one. It takes
    // precedence over the inline pass, which then does not run at all.
    const enhanced = ctx.input.kind === 'sentences' ? ctx.input.path : config.sentencesDir;

    /*
     * THE ALIGN ROW OF THIS RUN, when it has one. Found by TYPE among the run's
     * own steps: a run holds at most one (`chainCoverageAlign` is idempotent by
     * inspection, and the run description queues exactly one).
     *
     * `ctx.job` is the live job object the engine launched this step with; the
     * id is all that is taken from it, and the STATUS is read through the engine
     * at every poll (`peekStep`), so nothing here can be reading a snapshot.
     */
    const alignStepId = ctx.job.steps.find((s) => s.type === 'align')?.id;

    const unsubscribe = onBridgeEvent<ReassemblyProgressEvent>('reassembly:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      ctx.report({
        percent: p.percentage,
        message: p.message ?? p.phase,
        // Nullish-kept: the terminal error event carries no bars, and blanking
        // them would erase the record of how far the run got.
        ...(p.stages !== undefined ? { stages: p.stages as never } : {}),
        metrics: {
          currentChapter: p.currentChapter,
          totalChapters: p.totalChapters,
        },
      });
    });

    try {
      const result = await startReassembly(ctx.stepId, {
        sessionId,
        sessionDir,
        processDir,
        outputDir: config.outputDir,
        totalChapters,
        metadata: config.metadata,
        excludedChapters: config.excludedChapters ?? [],
        // Only ONE of these is ever set. `sentencesDir` wins by construction.
        ...(enhanced
          ? {
              sentencesDir: enhanced,
              // Absence means KEEP, and that is the answer for every set an
              // upstream STEP produced: those are durable artifacts of the
              // session. Only a config that says so gets disposal.
              ...(config.disposeSentencesDir === true ? { disposeSentencesDir: true } : {}),
            }
          : { rvcEnhancement: config.rvcEnhancement }),
        // Passed through so a stale row still carrying it is REFUSED by the
        // bridge, by name, rather than assembling un-denoised audio in silence.
        finalDenoise: config.finalDenoise,
        applyDeRing: config.applyDeRing,
        sentenceGap: config.sentenceGap,
        registerAsNewVariant: config.registerAsNewVariant,
        rvcVoiceId: config.rvcVoiceId,
        // The join. Handed over as a function rather than a step id so the
        // bridge — which is also the CLI's assembly door, with no queue behind
        // it — asks the queue nothing it cannot answer.
        ...(alignStepId === undefined
          ? {}
          : { awaitCoverage: (onWait: (message: string) => void) => awaitAlign(ctx, alignStepId, onWait) }),
      }, queueMainWindow());

      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'Assembly failed and gave no reason.');
      }
      /*
       * THE AUDIT, ONCE MORE ON THE FINISHED BOOK.
       *
       * The Align row said this hours ago on a card the operator has scrolled
       * past. Owen's ruling (2026-09-05) assembles the book whatever the audit
       * found, which only works if what it found stays visible — so the row that
       * produced the m4b repeats the retake list. Reported AFTER the assembly
       * rather than before it, so it lands as the row's resting message instead
       * of being overwritten by the next progress event.
       */
      const audit = summarizeCoverageReport(coverageReportPath(processDir));
      if (audit && audit.retakeIndices.length > 0) {
        ctx.report({ percent: 100, message: `Assembled. Coverage audit: ${audit.line}` });
      }
      return { kind: 'm4b', path: result.outputPath, detail: { sessionId, sessionDir } };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    stopReassembly(stepId);
  },
};

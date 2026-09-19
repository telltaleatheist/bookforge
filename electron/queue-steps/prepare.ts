/**
 * prepare — pack the book into generation chunks, on this machine's CPU, before
 * any card is asked for.
 *
 * ── The ruling (Owen, 2026-09-19) ──────────────────────────────────────────
 *
 * *"Prepare can be its own CPU step… we could start the CPU prep the moment a
 * free CPU slot is open and an item enters the active (and unpaused) queue."*
 *
 * It was the first minutes of `tts-conversion` until that evening, and both of
 * its costs were real:
 *
 *  - A GPU SLOT HELD FOR CPU WORK. Extracting an EPUB, cutting the narration
 *    copy, splitting it and packing it into chunks touches no card at all, and
 *    on a long book it is minutes of the single GPU lane spent on none of the
 *    work that lane exists for.
 *  - A PREP PAID TWICE. `startParallelConversion` ran the whole prep and THEN
 *    submitted; a server answering `409 server_busy` sent the row back to
 *    `queued` with a brand-new scratch session on disk that the next attempt
 *    did not match (`prepareSession` mints a fresh `crypto.randomUUID()` per
 *    call), so the next launch packed the book again (bug hunt 2026-09-19,
 *    finding A2).
 *
 * ── It travels nowhere, and that is the whole scheduling property ──────────
 *
 * `machines()` is ABSENT, so the module's default stands: this step is local
 * work. The pump therefore never asks `crucibleAdmission` for it — a `cpu` step
 * takes a `local-work` slot the moment one is free and its parent is done, with
 * no venue decided, no lease reserved and no server polled. Nothing special
 * makes that happen; it is what the pump already does with a non-GPU step, and
 * `tools/test-queue-narration-plan.js` pins it so a future change to the pump
 * cannot quietly take it away.
 *
 * ── The one thing it DOES ask a server ─────────────────────────────────────
 *
 * The chunk boundaries are the rendering machine's numbers — `max_chars` and
 * the pace block off `GET /v1/voices`, never this machine's catalog
 * (`electron/crucible/voice-band.ts`). So the prep door reads ONE band from ONE
 * server and refuses by name when no enabled server will state it. That is not
 * waiting for a free server: a busy one answers `/v1/voices` in milliseconds.
 * Which server's band it read is recorded on the session and travels to the
 * render, which refuses by name if it is admitted somewhere with a tighter
 * ceiling (`parallel-tts-bridge.packingTravelsTo`).
 */
import { onBridgeEvent } from '../bridge-events';
import {
  prepareNarrationSession,
  setMainWindow,
  detectRecommendedWorkerCount,
} from '../parallel-tts-bridge';
import type { StepModule, StepRunContext, StepReport } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { projectDirForStep, queueMainWindow, stepFailure } from './runtime';

/** The bridge's prep frames, as they arrive on the bus. */
interface PrepProgressEvent {
  jobId: string;
  progress: Record<string, unknown>;
}

interface PrepareConfig {
  language: string;
  ttsEngine: string;
  fineTuned: string;
  speed: number;
  enableTextSplitting: boolean;
  parallelMode?: 'sentences' | 'chapters';
  /**
   * WHETHER THE NARRATION TEXT CLEANUP IS REQUIRED OF THIS RUN. Not defaulted
   * — the door refuses a run that does not say, because the two answers are two
   * different things to write in the log about an hour of GPU, and it is PREP
   * that cuts the copy the answer decides the shape of.
   */
  textCleanup?: 'required' | 'skipped';
  /** "Start fresh" over "Continue": the ONE answer that may delete a checkpoint. */
  startFresh?: boolean;
  sentencePerParagraph?: boolean;
  skipHeadings?: boolean;
  testMode?: boolean;
  testSentences?: number;
  /**
   * THE PROJECT THIS ROW IS ABOUT — `bfpPath` for a BOOK, `projectDir` for an
   * ARTICLE, exactly one set. Read through `projectDirForStep`, never here.
   */
  bfpPath?: string;
  projectDir?: string;
  isArticle?: boolean;
}

export const prepareStep: StepModule = {
  type: 'prepare',
  consumes: 'epub',
  produces: 'prepared-session',
  /*
   * CPU, unconditionally. There is no config that makes packing a book GPU
   * work, so this is a literal rather than a question — which is the difference
   * between this and `align.ts`, where the row genuinely carries the answer.
   */
  resource: () => 'cpu',
  /*
   * NO `machines()`, AND ITS ABSENCE IS THE STATEMENT — see the header. The
   * default is `local`, the pump admits a local CPU step with no venue decided,
   * and that is precisely what makes this row start "the moment a free CPU slot
   * is open".
   */

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = (ctx.step.config ?? {}) as unknown as PrepareConfig;
    setMainWindow(queueMainWindow());

    const epubPath = ctx.input.path;
    if (!epubPath) {
      throw new Error('There is no book to prepare: this row was pointed at nothing.');
    }
    const projectDir = projectDirForStep(ctx, config) ?? '';

    /*
     * The worker count is not a fact about the prep — it packs the same chunks
     * however many workers read them — but `ParallelConversionConfig` requires
     * one, and a zero there would reach the render's own resolution as a number
     * somebody chose. The recommendation is what an unstated count has always
     * meant.
     */
    const conversionConfig = {
      workerCount: detectRecommendedWorkerCount().count,
      epubPath,
      outputDir: '',
      parallelMode: config.parallelMode || 'sentences',
      settings: {
        language: config.language,
        ttsEngine: config.ttsEngine,
        fineTuned: config.fineTuned,
        speed: config.speed,
        enableTextSplitting: config.enableTextSplitting,
        sentencePerParagraph: config.sentencePerParagraph,
        skipHeadings: config.skipHeadings,
        testMode: config.testMode,
        testSentences: config.testSentences,
      },
      // Carried, never invented: absent reaches the door as absent and is
      // refused by name rather than read as either answer.
      textCleanup: config.textCleanup,
      bfpPath: projectDir || undefined,
      isArticle: config.isArticle,
      /*
       * "Start fresh" deletes this book's scratch checkpoints, and it is the
       * ONE submission that may. It belongs to PREP because deleting them is
       * what makes the pack that follows a fresh one; the render behind this
       * row finds exactly the session this row wrote.
       */
      cleanSession: config.startFresh === true,
      // Prep never assembles. Stated so the stage bars it emits are the
      // chained shape the render row's bars continue.
      skipAssembly: true,
    };

    const unsubscribe = onBridgeEvent<PrepProgressEvent>('parallel-tts:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      /*
       * THE BRIDGE'S `stages` ARE NOT FORWARDED, and that is the one thing
       * worth saying about this listener.
       *
       * `emitPrepStageProgress` builds the whole RENDER's stage list —
       * "Preparing book", "Loading voice model", "Converting sentences",
       * "Assembling audiobook" — because it was written for a step that does
       * all four. This row does the first one and stops, so three of those bars
       * would sit at 0 % under a row that is never going to reach them. One
       * act, one bar.
       *
       * `prep` DOES ride, because it is this act's own sub-bar (the narration
       * number normalization counts paragraphs), and it is replaced rather than
       * kept — a landed sub-bar must not sit full under a line that has moved
       * on, the same discipline the render row's bars use.
       */
      const report: StepReport = {
        percent: typeof p['percentage'] === 'number' ? (p['percentage'] as number) : undefined,
        message: (p['message'] as string | undefined) ?? 'Preparing the book…',
        prep: (p['prep'] as never) ?? null,
      };
      ctx.report(report);
    });

    try {
      const result = await prepareNarrationSession(ctx.stepId, conversionConfig as never);
      if (!result.success || !result.prepared) {
        // A refusal that named a holder is a WAIT, not a failure — the same one
        // road every module's refusal takes since 2026-09-19 (A5).
        throw stepFailure(
          result.error || 'The book could not be prepared and no reason was given.',
          result.busyLine);
      }
      const prepared = result.prepared;
      ctx.report({
        percent: 100,
        message: `${prepared.totalSentences} chunk(s) in ${prepared.totalChapters} chapter(s)`
          + (prepared.packedFor === undefined
            ? ''
            : ` — packed to ${prepared.packedFor.ceilingChars} characters, `
              + `crucible "${prepared.packedFor.server}"'s number for this voice`),
      });
      return {
        kind: 'prepared-session',
        // The chunk texts, which is what the render reads. Named by the session
        // the prep wrote, never guessed from a project.
        path: prepared.processDir,
        sessionId: prepared.sessionId,
        sessionDir: prepared.sessionDir,
        processDir: prepared.processDir,
        detail: {
          projectDir,
          language: config.language,
          /*
           * THE DOCUMENT THAT WAS ACTUALLY PACKED — the narration copy when one
           * was cut, never the book the row names. Every resume match, the
           * clean-session sweep and the persisted state key on this path, so
           * the render has to be handed the same one.
           */
          epubPath: prepared.epubPath,
          totalSentences: prepared.totalSentences,
          totalChapters: prepared.totalChapters,
          ...(prepared.packedFor === undefined ? {} : {
            packedForServer: prepared.packedFor.server,
            packedCeilingChars: prepared.packedFor.ceilingChars,
          }),
        },
      };
    } finally {
      unsubscribe();
    }
  },

  /**
   * THERE IS NOTHING HERE TO STOP, AND SAYING SO IS THE POINT.
   *
   * `prepareSession` spawns narrator's prep and waits on it; the spawn is not
   * registered anywhere a stop can reach — `activeSessions` is written by the
   * RENDER door, after prep has returned — so a stop cannot kill the python.
   * That has always been true: prep ran inside `startParallelConversion` before
   * the session existed, and `stopParallelConversion` answered `false` for the
   * whole of it. Moving prep to its own row did not change it, and pretending
   * otherwise by calling a door that is a no-op here would be worse than
   * stating it.
   *
   * What DOES happen: the engine aborts the step, the row stops waiting, and
   * the prep process finishes into a scratch session nothing reads. The next
   * launch packs the book again — which is the behaviour, not a leak.
   *
   * RULING OWED: a cancellable prep means `prepareSession` keeping a handle by
   * job id, the way the render keeps `crucibleCancel`. Worth doing; not done
   * here, because it is a change to the spawn and this packet is about the row.
   */
  cancel(): void {
    // Deliberately empty. See above.
  },
};

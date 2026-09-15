/**
 * generate-sentences — a synced transcript for an audiobook.
 *
 * Two methods, and the choice is explicit rather than a preference with a
 * fallback: `whisper` transcribes the audio, `epub-align` force-aligns the
 * project's own ebook text to it (the book is ground truth — no ASR spelling
 * errors). An alignment failure FAILS the step; it must never quietly become a
 * Whisper transcription of the same book.
 */
import { onBridgeEvent, waitForBridgeEvent } from '../bridge-events';
import { cancelGenerateSentences, startGenerateSentences } from '../generate-sentences-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';
import { runVenueOfRow } from '../crucible/step-venue';

interface GsProgressEvent {
  jobId: string;
  percentage: number;
  message: string;
  stages?: unknown;
}

interface GsCompleteEvent {
  jobId: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  warning?: string;
  /** Where the whisper transcription ran: `crucible:<server>`. */
  venue?: string;
  /** A Crucible `server_busy`: the holder line. A wait, never a failure. */
  busyLine?: string;
}

interface GsStepConfig {
  projectId: string;
  variantId: string;
  m4bPath: string;
  modelId: string;
  modelLabel?: string;
  language?: string;
  method?: 'whisper' | 'epub-align';
  epubVariantId?: string;
  /** The caller's own Crucible server name for the whisper method; absent, the routing record decides. */
  crucible?: { server: string };
}

export const generateSentencesStep: StepModule = {
  type: 'generate-sentences',
  // It reads an audiobook the PROJECT holds, addressed by variant id.
  consumes: null,
  produces: 'vtt',
  resource: () => 'gpu',
  /**
   * THE WHISPER METHOD TRAVELS; `epub-align` DOES NOT (crucible
   * `docs/PHASE7-LANES.md` §4).
   *
   * Transcription is a Crucible `asr` job — `electron/crucible/asr.ts`, taken
   * through `transcribeAtVenue` below — so a book assigned to the Mac has its
   * transcript made on the Mac. `epub-align` is a different act entirely: it
   * reads the project's EPUB off this machine's disk and aligns against it with
   * a local aligner, and Crucible has no job type for it. Declaring `any` for
   * that method would hand it a machine that cannot see the book.
   *
   * ── "NO JOB TYPE FOR IT" IS A SHAPE, NOT AN OMISSION (measured 2026-09-15) ─
   *
   * Crucible's `align` job is
   * `{type:"align", model:"qwen3-aligner", params:{language, chunks:[{index,text}]},
   * inputs:{"<index>.flac":{blob_id}}}` — one audio input PER chunk, matched by
   * index. That is a caller who ALREADY KNOWS which seconds of audio go with
   * which sentences, which is true of a render (narrator wrote the chunks) and
   * is exactly what this act has to DISCOVER. `align_audiobook.py`'s stages are
   * `transcribe` (faster-whisper over the whole m4b, CPU env) → `coarse-align`
   * (a DTW of the ebook's sentences onto that rough transcript, which is what
   * produces the chunk spans) → `align` (Qwen3 per chunk, on the card) →
   * whisper-authority gate, monotonic clamps, drift correction, silence snap,
   * `write`. Only the third stage has the shape Crucible offers, and the two
   * before it are most of the wall clock and all of the knowledge.
   *
   * So this cannot be flipped to `any` by routing it through
   * `electron/crucible/align.ts`; it needs a Crucible job of a different shape
   * (`align-longform`), which is a RULING in `docs/CRUCIBLE_ROLLOUT_PLAN.md`
   * §B7 and not something to invent here. `electron/crucible/align.ts`'s own
   * header already says the same thing from the other side: *"that bridge keeps
   * its local CPU spawn until it is deleted, not moved."* Until then this
   * method is one of the reasons the bench still draws a legacy GPU row
   * (`shared/queue/slot-sets.ts`).
   *
   * Asked of the CONFIG rather than answered unconditionally because the two
   * methods are one row type, and §4's safety default is per step: a step that
   * has not been taught to travel does not travel.
   */
  machines: (config: Record<string, unknown>): 'local' | 'any' =>
    (config as unknown as GsStepConfig).method === 'epub-align' ? 'local' : 'any',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as GsStepConfig;
    if (!config?.m4bPath) {
      throw new Error('This transcript row names no audiobook, so there is nothing to transcribe.');
    }
    const win = queueMainWindow();
    if (!win) {
      throw new Error(
        'Transcription reports through a window and BookForge has none open, so it cannot run.',
      );
    }

    const unsubscribe = onBridgeEvent<GsProgressEvent>('generate-sentences:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      ctx.report({
        percent: event.percentage,
        message: event.message,
        // The whisper path reports no stages; nullish-kept so a reload does not
        // blank bars an epub-align run already filled in.
        ...(event.stages !== undefined ? { stages: event.stages as never } : {}),
      });
    });
    const finished = waitForBridgeEvent<GsCompleteEvent>(
      'generate-sentences:complete', (e) => e.jobId === ctx.stepId,
    );

    // THE RUN'S VENUE, NOT A NEW DECISION: the server the queue admitted this
    // run to, or the legacy marker (PHASE7-LANES.md §4.4). Absent — a standalone
    // press — the bridge decides through the routing record.
    const runVenue = runVenueOfRow(ctx.job.waitForResolved);
    try {
      await startGenerateSentences(ctx.stepId, win, {
        projectId: config.projectId,
        variantId: config.variantId,
        m4bPath: config.m4bPath,
        modelId: config.modelId,
        language: config.language || 'auto',
        method: config.method,
        epubVariantId: config.epubVariantId,
        ...(config.crucible === undefined ? {} : { crucible: config.crucible }),
        ...(runVenue === undefined ? {} : { runVenue }),
      } as never);

      const result = await finished;
      if (!result.success || !result.outputPath) {
        if (result.busyLine !== undefined) {
          // The server is running somebody else's job: the row goes back to
          // `queued` carrying the holder's own line and is tried again on the
          // admission tick — the same hold the render seam asks for.
          const { noteStepBusy } = await import('../queue-engine.js');
          noteStepBusy(ctx.stepId, result.busyLine);
        }
        throw new Error(result.error || 'Transcription failed and gave no reason.');
      }
      if (result.warning) ctx.step.completionNotes = [result.warning];
      return {
        kind: 'vtt',
        path: result.outputPath,
        // `venue` is recorded on the row's artifact the way a render's saved
        // state records its server: which machine transcribed this book.
        detail: { projectId: config.projectId, variantId: config.variantId, venue: result.venue },
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    cancelGenerateSentences(stepId);
  },
};

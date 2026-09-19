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
import { queueMainWindow, stepFailure } from './runtime';
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
   * BOTH METHODS TRAVEL, since 2026-09-15.
   *
   * `whisper` always did — it is a Crucible `asr` job, taken through
   * `transcribeAtVenue`. `epub-align` did not, and the reason was real: Crucible
   * had no job of that shape. Its `align` job takes
   * `{chunks:[{index,text}], inputs:{"<index>.flac"}}` — a caller who ALREADY
   * KNOWS which seconds hold which sentences, which is true of a render and is
   * precisely what this act must DISCOVER.
   *
   * Crucible now has `align-longform` (crucible `jobs/alignlongform/`), which is
   * that discovery: transcribe -> coarse-align -> align -> write, all four on
   * the server. Owen ruled it on 2026-09-15 — *"align longform, is that the
   * generate-sentences logic? that should be a gpu job"* — and the WHOLE step
   * travels, CPU stages included, by the same ruling that sends a whole TTS step
   * (*"even if it's cpu"*). One slot, its own, for the duration.
   *
   * IT IS THE SAME ALIGNMENT AND NOT A SECOND ONE. The server's two heavy stages
   * are `coarse_align` and `snap_boundaries`, ported verbatim from
   * `electron/scripts/align_audiobook.py` and held to it by a differential test
   * over 27 books and 200 seam layouts. Only the sentences and the audio cross;
   * the EPUB stays here, because what the server needs from it is text this app
   * has already extracted with its headings stamped.
   *
   * ANSWERED UNCONDITIONALLY NOW, where it used to be asked of the config. The
   * per-method question is gone because the answer stopped differing — and a
   * ternary whose arms agree is a reader's invitation to look for a difference
   * that is not there.
   *
   * WHAT THIS EMPTIES. `LONGFORM_ALIGN_SET` was the bench's last GPU row that is
   * not a registered server, and `epub-align` was its only remaining tenant
   * (`video-assembly` left when it was measured as CPU; the legacy render venue
   * is deleted). With this, no GPU row is drawn for anything but a Crucible
   * engine — which is Owen's *"without a crucible server, there is no gpu slot"*
   * reached completely rather than conditionally. The set and its migration stay
   * readable for queues written before today; `tools/test-queue-slot-sets.js`
   * pins both halves.
   */
  machines: (): 'local' | 'any' => 'any',

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
        // The server is running somebody else's job, or another client holds
        // the model: the row goes back to `queued` carrying the holder's own
        // line and is tried again on the admission tick. `stepFailure` is the
        // one road that fact travels since 2026-09-19 (A5) — no side call into
        // the engine, and an ordinary failure when no holder was named.
        throw stepFailure(
          result.error || 'Transcription failed and gave no reason.', result.busyLine);
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

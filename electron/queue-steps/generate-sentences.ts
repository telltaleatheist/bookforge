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
  /** Where the whisper transcription ran: `crucible:<server>` or `legacy-local-narrator`. */
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

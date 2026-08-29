/**
 * final-denoise — the roformer pass over a session's sentences, as its own row.
 *
 * It is the same shape as `rvc-enhancement`: it reads a narration's SESSION, does
 * GPU work, and produces a DIRECTORY of sentences that the assembly behind it
 * consumes through e2a's `--sentences_dir`.
 *
 * ── Why it is a step at all ─────────────────────────────────────────────────
 *
 * It used to be a flag on the assembly, and the assembly declared itself a GPU
 * step whenever the flag was set — holding the one GPU slot through the gap pass,
 * the denoise, AND the chapter combine and AAC encode that follow, which are pure
 * CPU and are the long tail of the job. Splitting it out is what lets the
 * assembly sit in the CPU lane and the card go to the next run the moment the
 * denoise lands.
 *
 * ── Its output is durable, and the assembly does not delete it ──────────────
 *
 * `<processDir>/chapters/sentences-denoised/`, beside the raw cache, with a
 * manifest that says what it was derived from and with (derived-sentences.ts).
 * A re-assembly of the same session REUSES it — which is the point: with the
 * current Orpheus models the pass costs about as much wall-clock as the
 * narration, and re-assembly is routine.
 */
import { onBridgeEvent } from '../bridge-events';
import { runFinalDenoise, stopFinalDenoise } from '../denoise-job';
import { getBfpCachedSession } from '../reassembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

interface DenoiseProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number;
    processed?: number; total?: number; message?: string; error?: string;
  };
}

interface FinalDenoiseStepConfig {
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  /** The inter-sentence gap, which is baked in HERE — see denoise-job.ts. */
  sentenceGap?: number;
}

export const finalDenoiseStep: StepModule = {
  type: 'final-denoise',
  consumes: 'audio-session',
  produces: 'sentences',
  // Always the card: the roformer runs on the env's torch device. The gap pass
  // in front of it is CPU, but it is minutes against the denoise's hour and
  // cannot be moved — it must see the RAW sentences, before the roformer does.
  resource: () => 'gpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = (ctx.step.config ?? {}) as unknown as FinalDenoiseStepConfig;

    let sessionId = config.sessionId || ctx.input.sessionId;
    let sessionDir = config.sessionDir || ctx.input.sessionDir;
    let processDir = config.processDir || ctx.input.processDir;

    if (!sessionId || !sessionDir || !processDir) {
      // A row queued before its narration existed and pointed at a project
      // rather than a step. The project's cached session is the answer.
      const projectDir = ctx.job.projectId;
      if (!projectDir) {
        throw new Error(
          'This denoise row names no narration session and no project, so there is nothing '
          + 'for it to denoise.',
        );
      }
      const cached = await getBfpCachedSession(projectDir);
      if (!cached) {
        throw new Error('No narration session was found in this project — narrate it first.');
      }
      sessionId = cached.sessionId;
      sessionDir = cached.sessionDir;
      processDir = cached.processDir;
    }

    const unsubscribe = onBridgeEvent<DenoiseProgressEvent>('final-denoise:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      ctx.report({
        percent: p.percentage,
        message: p.message,
        metrics: {
          // Blocks mapped onto the chunk fields, so the row shows a real ETA the
          // same way narration and enhancement do — no bridge-side ETA math.
          chunksCompletedInJob: p.processed,
          totalChunksInJob: p.total,
          chunksDoneInSession: p.processed,
        },
      });
    });

    try {
      const result = await runFinalDenoise(ctx.stepId, {
        processDir,
        ...(config.sentenceGap === undefined ? {} : { sentenceGap: config.sentenceGap }),
      }, queueMainWindow());

      if (!result.success || !result.outputDir) {
        throw new Error(result.error || 'The denoise pass failed and gave no reason.');
      }
      return {
        kind: 'sentences',
        path: result.outputDir,
        sessionId,
        sessionDir,
        processDir,
        detail: { reused: result.reused === true },
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    stopFinalDenoise(stepId);
  },
};

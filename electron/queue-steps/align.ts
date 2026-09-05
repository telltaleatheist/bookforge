/**
 * align — force-align the rendered chunks and write the coverage report.
 *
 * The row that was missing. `assemble/coverage_gate.py` refuses an ENFORCED
 * engine's book without a report — Higgs v3 has no duration guard worth the
 * name — and until this step existed nothing in BookForge produced one, so every
 * app-driven v3 book ended at assembly quoting a command line by hand.
 *
 * ── It reads a SESSION and it writes a SESSION ──────────────────────────────
 *
 * `consumes: 'audio-session'`, `produces: 'audio-session'`, and `run` hands back
 * `ctx.input` verbatim. That is not a placeholder — it is the whole shape of the
 * step. It measures the chunk FLACs the render wrote and leaves them exactly as
 * they are; the thing it produces (`coverage.json`) is read by ASSEMBLY through
 * an argv flag, not by the next step through the chain. So the artifact that
 * flows on is the one that flowed in, and whatever follows — a denoise, a
 * conversion, the assembly — is handed precisely what it would have been handed
 * had this row not been there.
 *
 * A SINGLE consumed kind rather than the `['audio-session', 'sentences']` pair
 * the enhancement passes declare, and that is deliberate: this measures the
 * RENDER. Its thresholds were calibrated on raw engine output (`align/README.md`),
 * a voice conversion re-times and re-timbres every phone, and a guard applied to
 * that audio would refuse books that were read perfectly. Declaring one kind is
 * what makes an Align chained behind an enhancement a COMPOSE-time refusal
 * instead of a plausible-looking wrong answer.
 *
 * ── CPU, one of two slots ───────────────────────────────────────────────────
 *
 * `align/aligner.py` refuses CUDA by name while BookForge's external-gpu-job.lock
 * exists, and the measurement says it does not want it: RTF 0.082 on CPU, a book
 * in minutes. Declaring 'gpu' would make every guarded book wait for a card it
 * will not use.
 */
import { onBridgeEvent } from '../bridge-events';
import { runCoverageAlign, stopCoverageAlign } from '../coverage-align-job';
import { getBfpCachedSession } from '../reassembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

interface AlignProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number;
    processed?: number; total?: number; message?: string; error?: string;
  };
}

interface AlignStepConfig {
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  /** The language the aligner loads its checkpoint for. See the refusal below. */
  language?: string;
}

export const alignStep: StepModule = {
  type: 'align',
  consumes: 'audio-session',
  /*
   * THE SAME KIND IT READ. `checkLineage` validates a child against its parent's
   * STATIC `produces`, so this is what lets a denoise, a conversion or an
   * assembly sit behind an Align exactly as it sits behind the narration itself.
   * `run` returns the input ref unchanged so the runtime half agrees with it.
   */
  produces: 'audio-session',
  resource: () => 'cpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = (ctx.step.config ?? {}) as unknown as AlignStepConfig;

    let sessionId = config.sessionId || ctx.input.sessionId;
    let sessionDir = config.sessionDir || ctx.input.sessionDir;
    let processDir = config.processDir || ctx.input.processDir;

    if (!sessionId || !sessionDir || !processDir) {
      // A row queued against a project rather than behind a render — the
      // cache-only shape, same as the denoise and the assembly.
      const projectDir = ctx.job.projectId;
      if (!projectDir) {
        throw new Error(
          'This alignment row names no narration session and no project, so there is nothing '
          + 'for it to check.',
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

    /*
     * NOT DEFAULTED TO 'en'. The aligner loads a per-language wav2vec2 checkpoint,
     * and one pointed at the wrong language scores every word badly — which this
     * guard reads as "the audio did not say the text" and refuses a book that was
     * read correctly. The run description states it on every align config
     * (`NarrationAlignConfig.language`), so an absent one is a composition bug and
     * says so.
     */
    const language = config.language;
    if (!language) {
      throw new Error(
        'This alignment row does not say which language the book was rendered in, and the '
        + 'aligner loads a different acoustic model for each. A guess here would score every '
        + 'word badly and refuse a book that was read correctly. This is a bug in the run that '
        + 'composed it.',
      );
    }

    const unsubscribe = onBridgeEvent<AlignProgressEvent>('coverage-align:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      ctx.report({
        percent: p.percentage,
        message: p.message,
        metrics: {
          // Chunks mapped onto the chunk fields, so the row gets the same
          // rate-based ETA every other counted step does.
          chunksCompletedInJob: p.processed,
          totalChunksInJob: p.total,
          chunksDoneInSession: p.processed,
        },
      });
    });

    try {
      const result = await runCoverageAlign(
        ctx.stepId, { processDir, language }, queueMainWindow(),
      );
      if (!result.success) {
        throw new Error(result.error || 'The alignment failed and gave no reason.');
      }
      /*
       * THE PARENT'S ARTIFACT, PASSED THROUGH — this step changes no audio.
       *
       * Spread from `ctx.input` so nothing a producer declared is dropped on the
       * way past (the narration's `detail` carries its project dir, its language
       * and whether it skipped assembly), and then OVERWRITTEN with the session
       * identity this step resolved: `tts-conversion` returns no `processDir`,
       * and the steps behind this one would otherwise each re-resolve it from the
       * project's cache. What this row adds of its own is the report it wrote,
       * which nothing reads today and is the one fact about this step worth
       * carrying if anything ever does.
       */
      return {
        ...ctx.input,
        kind: 'audio-session',
        sessionId,
        sessionDir,
        processDir,
        detail: {
          ...(ctx.input.detail ?? {}),
          coverageReport: result.reportPath,
          chunksAligned: result.chunksAligned,
        },
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    stopCoverageAlign(stepId);
  },
};

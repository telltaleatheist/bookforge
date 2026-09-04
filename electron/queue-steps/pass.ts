/**
 * The processing passes — simplify, translate, footnote references.
 *
 * ONE module, registered under three job types, because they ARE one act: every
 * pass runs through `runProcessingPass` with the plan the chain already resolved.
 * The config is passed through untouched — a config re-derived here could
 * disagree with the plan the user was shown, and re-planning at run time is what
 * the planner exists to prevent.
 *
 * A pass rewrites the project's BOOK in place. That is why `consumes` is null:
 * what it reads is the project's book, which the project owns, not something the
 * step before it handed over. A chain of passes is still a chain — each must wait
 * for the one before it, because each rewrites the text the next one reads — and
 * lineage is what expresses that.
 */
import { cancelCleanupJob } from '../ai-bridge';
import { passResultNotes } from '../../shared/processing/pass-notes';
import { broadcastToAllWindows } from '../document-stage-run';
import { onBridgeEvent } from '../bridge-events';
import { runProcessingPass } from '../processing-passes';
import type { PassJobConfig } from '../../shared/processing/pass-types';
import type { JobType } from '../../shared/queue/engine-types';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow, resourceForProvider } from './runtime';

interface PassProgressEvent {
  jobId: string;
  phase?: string;
  progress?: number;
  message?: string;
  stages?: unknown;
  currentChunk?: number;
  totalChunks?: number;
  currentChapter?: number;
  totalChapters?: number;
  chunksCompletedInJob?: number;
  totalChunksInJob?: number;
  completedInSession?: number;
  outputPath?: string;
}

function passModule(type: JobType): StepModule {
  return {
    type,
    consumes: null,
    produces: 'epub',
    resource: resourceForProvider,

    async run(ctx: StepRunContext): Promise<ArtifactRef> {
      const config = ctx.step.config as unknown as PassJobConfig;
      if (!config?.kind || !config.projectDir || !config.stageRelDir) {
        throw new Error(
          `This ${type} row was queued without a planned config. Pass rows come from the `
          + 'Process tab; nothing else may build one. Remove it and plan the run again.',
        );
      }

      const unsubscribe = onBridgeEvent<PassProgressEvent>('queue:progress', (event) => {
        if (event.jobId !== ctx.stepId) return;
        ctx.report({
          percent: event.progress,
          message: event.message,
          ...(event.stages !== undefined ? { stages: event.stages as never } : {}),
          metrics: {
            currentChunk: event.currentChunk,
            totalChunks: event.totalChunks,
            currentChapter: event.currentChapter,
            totalChapters: event.totalChapters,
            chunksCompletedInJob: event.chunksCompletedInJob ?? event.currentChunk,
            totalChunksInJob: event.totalChunksInJob ?? event.totalChunks,
            chunksDoneInSession: event.completedInSession
              ?? event.chunksCompletedInJob ?? event.currentChunk,
            cleanupPhase: event.phase as never,
          },
        });
      });

      try {
        const result = await runProcessingPass(ctx.stepId, config, queueMainWindow());
        if (!result.success) {
          throw new Error(result.error || `${ctx.step.label} failed and gave no reason.`);
        }
        // What the pass has to SAY carries onto the row, not just whether it
        // worked. A pass that could record no ledger row succeeded and still
        // owes the user that sentence; dropping it is what made a correct
        // refusal look like a missing button.
        const notes = passResultNotes(result);
        if (notes.length > 0) ctx.step.completionNotes = notes;
        broadcastToAllWindows('project:files-changed', config.projectDir);
        // WHAT A CHAINED STEP READS. A pass that named a narration input meant
        // it: the queue resolves a chained step's input from its parent's
        // artifact and from nothing else, so this is the only place the file a
        // follow-on narration reads can be chosen (the adversarial review,
        // 2026-09-04). Everything else reads the book the pass wrote.
        const produced = result.narrationInputPath ?? result.outputPath;
        if (produced === undefined) {
          throw new Error(
            `${ctx.step.label} finished without saying which file it wrote, so anything queued `
            + 'behind it would have nothing to read.');
        }
        return { kind: 'epub', path: produced };
      } finally {
        unsubscribe();
      }
    },

    cancel(stepId: string): void {
      // A simplify or translate pass is `cleanupEpub` underneath, and ai-bridge
      // keeps its abort controller keyed by the job id it was handed — which is
      // this step id. footnote-refs is a string replace over a zip that finishes
      // in seconds and registers nothing; `cancelCleanupJob` answers false for
      // it, which is the truthful answer rather than a failure.
      cancelCleanupJob(stepId);
    },
  };
}

export const simplifyStep = passModule('simplify');
export const translatePassStep = passModule('translate-pass');
export const footnoteRefsStep = passModule('footnote-refs');
/**
 * The narration text cleanup, on the same module for the same reason.
 *
 * It is not a string replace like footnote-refs — it loads a model and reads the
 * residue — but nothing about the ROW differs: it takes the planned
 * `PassJobConfig`, ends in `runProcessingPass`, reports through the same bridge
 * events, and `resourceForProvider` puts it on the same pool a simplify uses so
 * it cannot run beside a render that wants the card.
 */
export const narrationTextStep = passModule('narration-text');

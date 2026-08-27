/**
 * rvc-enhancement — re-render a session's sentences through an RVC voice.
 *
 * It writes a scratch set under [library]/tmp and hands that DIRECTORY to the
 * assembly step behind it. Under the old queue the two were siblings in a
 * workflow and the directory travelled between them through a Map in the
 * renderer keyed by workflow id (`rvcScratchByWorkflow`), consumed by whichever
 * reassembly row ran next. Here it is simply this step's OUTPUT, which is what it
 * always was.
 *
 * The session it reads comes from its parent's output. The old row carried an
 * empty `sessionId` at enqueue time and discovered it at run time with a
 * four-attempt retry ladder against the project cache, because the session did
 * not exist when the row was built. Lineage removes the question.
 */
import { onBridgeEvent } from '../bridge-events';
import { runRvcEnhancement, stopRvcEnhancement } from '../rvc-job';
import { getBfpCachedSession } from '../reassembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

interface RvcProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number;
    processed?: number; total?: number; message?: string; error?: string;
  };
}

interface RvcConfig {
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  voiceId: string;
  indexRate?: number;
  protectRate?: number;
  nSemitones?: number;
  /** Both absent = urvc's own default. Named in shared/queue/narration-run.ts. */
  f0Method?: string;
  hopLength?: number;
  finalDenoise?: boolean;
}

export const rvcEnhancementStep: StepModule = {
  type: 'rvc-enhancement',
  consumes: 'audio-session',
  produces: 'sentences',
  resource: () => 'gpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as RvcConfig;
    if (!config?.voiceId) {
      throw new Error('This enhancement row names no voice, so there is nothing to render through.');
    }

    let sessionId = config.sessionId || ctx.input.sessionId;
    let sessionDir = config.sessionDir || ctx.input.sessionDir;
    let processDir = config.processDir || ctx.input.processDir;

    if (!sessionId || !sessionDir || !processDir) {
      // A row queued before its narration existed and pointed at a project
      // rather than a step. The project's cached session is the answer.
      const projectDir = ctx.job.projectId;
      if (!projectDir) {
        throw new Error(
          'This enhancement row names no narration session and no project, so there is nothing '
          + 'for it to enhance.',
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

    const unsubscribe = onBridgeEvent<RvcProgressEvent>('rvc:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      ctx.report({
        percent: p.percentage,
        message: p.message,
        metrics: {
          // Mapped onto the chunk fields so the row shows a real ETA and a
          // "Chunks X/Y" the same way narration does — no bridge-side ETA math.
          chunksCompletedInJob: p.processed,
          totalChunksInJob: p.total,
          chunksDoneInSession: p.processed,
        },
      });
    });

    try {
      const result = await runRvcEnhancement(ctx.stepId, {
        sessionId,
        sessionDir,
        processDir,
        voiceId: config.voiceId,
        indexRate: config.indexRate,
        protectRate: config.protectRate,
        nSemitones: config.nSemitones,
        f0Method: config.f0Method,
        hopLength: config.hopLength,
        finalDenoise: config.finalDenoise,
      }, queueMainWindow());

      if (!result.success || !result.scratchDir) {
        throw new Error(result.error || 'Voice enhancement failed and gave no reason.');
      }
      return {
        kind: 'sentences',
        path: result.scratchDir,
        sessionId,
        sessionDir,
        processDir,
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    stopRvcEnhancement(stepId);
  },
};

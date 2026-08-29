/**
 * rvc-enhancement — re-render a session's sentences through an RVC voice.
 *
 * It writes a DURABLE set inside the session — `chapters/sentences-rvc-<voice>`,
 * with a manifest saying what it was derived from and with (derived-sentences.ts)
 * — and hands that DIRECTORY to the assembly step behind it, which assembles it
 * and leaves it. It used to be a scratch dir under [library]/tmp that the
 * assembly deleted; with the current models the pass costs about as much GPU as
 * the narration, so a re-assembly to fix a metadata field paid for it all again.
 *
 * Under the old queue the two were siblings in a
 * workflow and the directory travelled between them through a Map in the
 * renderer keyed by workflow id (`rvcScratchByWorkflow`), consumed by whichever
 * reassembly row ran next. Here it is simply this step's OUTPUT, which is what it
 * always was.
 *
 * ── IT MAY CONVERT ANOTHER PASS'S OUTPUT ────────────────────────────────────
 *
 * Since Owen's ordering ruling (2026-08-29) the user chooses whether the denoise
 * runs before or after this pass, so its input is either the session's raw
 * sentences or the denoise's set — whichever its parent wrote. It no longer
 * denoises its own input; a config that still says so is refused by name.
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
  /**
   * NOT A PASS THIS STEP RUNS ANY MORE — passed through so a row queued before
   * the ordering ruling is refused BY NAME by the job (electron/rvc-job.ts),
   * rather than silently converting un-denoised audio.
   */
  finalDenoise?: boolean;
  hopLength?: number;
  /**
   * The set to convert, when this pass is SECOND in the chain and no parent step
   * hands it over. Ordinarily absent: the parent's output says it.
   */
  sentencesDir?: string;
  /** Baked in HERE when this pass reads the RAW sentences — it is then the first
   *  thing that touches them. See electron/sentence-gap.ts. */
  sentenceGap?: number;
}

export const rvcEnhancementStep: StepModule = {
  type: 'rvc-enhancement',
  /*
   * EITHER a narration's session (convert the raw sentences) OR another pass's
   * sentence set (convert what the denoise produced) — the same pair the denoise
   * step declares, and for the same reason: the user picks which of the two
   * enhancement passes goes first.
   */
  consumes: ['audio-session', 'sentences'],
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

    // What this pass converts — the parent's output when the parent produced a
    // sentence set, and otherwise the session's raw cache. Same rule as the
    // denoise step and the assembly.
    const upstreamSentences = ctx.input.kind === 'sentences'
      ? ctx.input.path
      : config.sentencesDir;

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
        processDir,
        voiceId: config.voiceId,
        indexRate: config.indexRate,
        protectRate: config.protectRate,
        nSemitones: config.nSemitones,
        f0Method: config.f0Method,
        hopLength: config.hopLength,
        // Carried so the job can REFUSE it by name. See the field's note above.
        finalDenoise: config.finalDenoise,
        ...(upstreamSentences === undefined ? {} : { sentencesDir: upstreamSentences }),
        ...(config.sentenceGap === undefined ? {} : { sentenceGap: config.sentenceGap }),
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

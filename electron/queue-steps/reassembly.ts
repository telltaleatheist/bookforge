/**
 * reassembly — turn a rendered session into the audiobook.
 *
 * What it assembles is what its PARENT wrote, and the two shapes its parent can
 * be are the two RVC arrangements:
 *
 *  - parent is a narration (`audio-session`) → assemble the session's own
 *    sentences, optionally running the inline RVC pass;
 *  - parent is an enhancement (`sentences`) → assemble THAT directory instead,
 *    via e2a's `--sentences_dir`, and the bridge deletes it afterwards.
 *
 * The old row had to work this out from a sibling search plus a renderer-side Map
 * keyed by workflow id, with a "does this workflow have an rvc-enhancement job?"
 * lookup to stop RVC running twice. Both arrangements are now just what the
 * parent's output KIND says, so double-processing is not expressible.
 */
import { onBridgeEvent } from '../bridge-events';
import { getBfpCachedSession, startReassembly, stopReassembly } from '../reassembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

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
  e2aTmpPath?: string;
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
  finalDenoise?: boolean;
  applyDeRing?: boolean;
  sentenceGap?: number;
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
   * declared ON the config: RVC enhancement and the final denoise both run
   * models. De-ring is an ffmpeg filter and does not count.
   *
   * Same shape as foundry-job's resourceFor: the type is one, the resource is
   * the config's.
   */
  resource: (config: Record<string, unknown>) =>
    (config['rvcEnhancement'] || config['finalDenoise'] === true) ? 'gpu' : 'cpu',

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
        e2aTmpPath: config.e2aTmpPath,
        totalChapters,
        metadata: config.metadata,
        excludedChapters: config.excludedChapters ?? [],
        // Only ONE of these is ever set. `sentencesDir` wins by construction.
        ...(enhanced ? { sentencesDir: enhanced } : { rvcEnhancement: config.rvcEnhancement }),
        finalDenoise: config.finalDenoise,
        applyDeRing: config.applyDeRing,
        sentenceGap: config.sentenceGap,
      }, queueMainWindow());

      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'Assembly failed and gave no reason.');
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

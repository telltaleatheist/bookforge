/**
 * The language-learning chain: clean, translate, assemble.
 *
 * Three steps that were three job types in one flat workflow, held in order by an
 * array-position rule. They are a chain, and saying so is what removes the two
 * guards the old code needed:
 *
 *  - translation had to ask "did this workflow include a cleanup job?" and refuse
 *    if it had no cleaned EPUB, because a missing path could equally mean "no
 *    cleanup step ran" or "cleanup silently produced nothing". Its parent's
 *    OUTPUT answers that: if there is a cleanup step, its output is the file;
 *    if there is not, the step reads the source and the question never arises.
 *  - assembly had to be created as a PLACEHOLDER row with an empty config, then
 *    filled in from the completion handler of the TTS that preceded it, because
 *    the sentence directories did not exist when the row was built. It reads its
 *    parent's output now.
 */
import { onBridgeEvent } from '../bridge-events';
import { cancelCleanupJob } from '../ai-bridge';
import { runBilingualAssembly } from '../bilingual-assembly-bridge';
import { runLLCleanup, runLLTranslation } from '../ll-jobs';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow, resourceForProvider } from './runtime';
import type { AiJobConfig } from './ai-provider';

interface LlProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number; message?: string;
    currentChunk?: number; totalChunks?: number;
    currentSentence?: number; totalSentences?: number;
    error?: string;
  };
}

/** The ll-jobs progress shape, mapped onto the row's chunk fields for the ETA. */
function subscribeLlProgress(ctx: StepRunContext): () => void {
  return onBridgeEvent<LlProgressEvent>('ll-job:progress', (event) => {
    if (event.jobId !== ctx.stepId) return;
    const p = event.progress;
    const current = p.currentChunk ?? p.currentSentence ?? 0;
    const total = p.totalChunks ?? p.totalSentences ?? 0;
    ctx.report({
      percent: p.percentage,
      message: p.message ?? p.phase,
      metrics: {
        currentChunk: current,
        totalChunks: total,
        chunksCompletedInJob: current,
        totalChunksInJob: total,
        chunksDoneInSession: current,
        cleanupPhase: p.phase as never,
      },
    });
  });
}

interface CleanupStepConfig extends AiJobConfig {
  projectId: string;
  projectDir: string;
  sourceEpubPath?: string;
  sourceLang: string;
  cleanupPrompt?: string;
  customInstructions?: string;
  simplifyForLearning?: boolean;
  simplifyMode?: 'dejargon' | 'destiffen' | 'learner' | 'learning' | 'plain';
  testMode?: boolean;
  testModeChunks?: number;
}

export const bilingualCleanupStep: StepModule = {
  type: 'bilingual-cleanup',
  consumes: 'epub',
  produces: 'epub',
  resource: resourceForProvider,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as CleanupStepConfig;
    if (!config?.projectDir) {
      throw new Error('This cleanup row names no project, so there is nothing to clean.');
    }
    const unsubscribe = subscribeLlProgress(ctx);
    try {
      const result = await runLLCleanup(ctx.stepId, {
        projectId: config.projectId,
        projectDir: config.projectDir,
        sourceEpubPath: config.sourceEpubPath ?? ctx.input.path,
        sourceLang: config.sourceLang,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        cleanupPrompt: config.cleanupPrompt,
        customInstructions: config.customInstructions,
        simplifyForLearning: config.simplifyForLearning,
        simplifyMode: config.simplifyMode,
        testMode: config.testMode,
        testModeChunks: config.testModeChunks,
      } as never, queueMainWindow());

      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'Cleanup failed and gave no reason.');
      }
      return { kind: 'epub', path: result.outputPath };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    // ll-jobs runs the AI through ai-bridge's own abort registry, keyed by the
    // job id it was handed — which is this step id.
    cancelCleanupJob(stepId);
  },
};

interface TranslationStepConfig extends AiJobConfig {
  projectId?: string;
  projectDir?: string;
  cleanedEpubPath?: string;
  sourceLang: string;
  targetLang: string;
  title?: string;
  translationPrompt?: string;
  customInstructions?: string;
  autoApproveAlignment?: boolean;
  splitGranularity?: 'sentence' | 'paragraph';
  testMode?: boolean;
  testModeChunks?: number;
}

export const bilingualTranslationStep: StepModule = {
  type: 'bilingual-translation',
  consumes: 'epub',
  produces: 'bilingual-epubs',
  resource: resourceForProvider,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as TranslationStepConfig;
    // Its parent's output IS the book to translate: the cleaned copy when a
    // cleanup step ran, the source when none did. There is no third possibility
    // to guard against.
    const source = ctx.input.path ?? config.cleanedEpubPath;
    if (!source) {
      throw new Error('This translation row was given no book to translate.');
    }
    const unsubscribe = subscribeLlProgress(ctx);
    try {
      const result = await runLLTranslation(ctx.stepId, {
        projectId: config.projectId,
        projectDir: config.projectDir,
        cleanedEpubPath: source,
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        title: config.title,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        translationPrompt: config.translationPrompt,
        customInstructions: config.customInstructions,
        testMode: config.testMode,
        testModeChunks: config.testModeChunks,
      } as never, queueMainWindow());

      if (!result.success) {
        throw new Error(result.error || 'Translation failed and gave no reason.');
      }
      const next = (result as { nextJobConfig?: Record<string, unknown>; data?: Record<string, unknown> });
      const paths = next.nextJobConfig ?? next.data ?? {};
      ctx.step.analytics = (result as { analytics?: unknown }).analytics;
      return {
        kind: 'bilingual-epubs',
        path: result.outputPath,
        detail: {
          sourceEpubPath: paths['sourceEpubPath'],
          targetEpubPath: paths['targetEpubPath'],
          sentencePairsPath: paths['sentencePairsPath'],
        },
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    // See bilingualCleanupStep.cancel — the same registry, the same key.
    cancelCleanupJob(stepId);
  },
};

interface AssemblyStepConfig {
  projectId: string;
  sourceSentencesDir?: string;
  targetSentencesDir?: string;
  sentencePairsPath: string;
  outputDir: string;
  pauseDuration?: number;
  gapDuration?: number;
  outputName?: string;
  sourceLang?: string;
  targetLang?: string;
  title?: string;
  bfpPath?: string;
  pattern?: 'interleaved' | 'sequential';
}

interface AssemblyProgressEvent {
  jobId: string;
  progress: { phase: string; percentage: number; message: string };
}

export const bilingualAssemblyStep: StepModule = {
  type: 'bilingual-assembly',
  // It reads TWO sentence directories, which no single artifact expresses; the
  // pairing is on the config, written there by whoever composed the run.
  consumes: null,
  produces: 'm4b',
  resource: () => 'gpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as AssemblyStepConfig;
    if (!config?.sourceSentencesDir || !config.targetSentencesDir) {
      throw new Error(
        'This bilingual assembly row is missing one of its two sentence sets, so it has '
        + 'nothing to interleave.',
      );
    }
    const unsubscribe = onBridgeEvent<AssemblyProgressEvent>(
      'bilingual-assembly:progress', (event) => {
        if (event.jobId !== ctx.stepId) return;
        const p = event.progress;
        ctx.report({
          percent: p.percentage,
          message: p.message,
          metrics: {
            assemblyProgress: p.percentage,
            assemblySubPhase: p.phase as never,
          },
        });
      },
    );

    try {
      const result = await runBilingualAssembly(ctx.stepId, {
        projectId: config.projectId,
        sourceSentencesDir: config.sourceSentencesDir,
        targetSentencesDir: config.targetSentencesDir,
        sentencePairsPath: config.sentencePairsPath,
        outputDir: config.outputDir,
        pauseDuration: config.pauseDuration,
        gapDuration: config.gapDuration,
        outputName: config.outputName,
        title: config.title,
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        bfpPath: config.bfpPath,
      } as never);

      const audioPath = (result as { audioPath?: string }).audioPath;
      if (!result.success || !audioPath) {
        throw new Error(result.error || 'Bilingual assembly failed and gave no reason.');
      }
      return {
        kind: 'm4b',
        path: audioPath,
        detail: { vttPath: (result as { vttPath?: string }).vttPath },
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(): void {
    // The assembler is ffmpeg work in this process with no cancel handle of its
    // own. The engine's abort signal unwinds the await; saying so is better than
    // a call that would do nothing.
  },
};

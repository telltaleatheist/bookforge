/**
 * translation — translate a book with an AI provider.
 *
 * `translateEpub` already takes an `onProgress` callback, so this step needs no
 * bus subscription: it is handed the reports directly. That callback existed and
 * was passed a no-op by `queue:run-translation`, which then relied on the bridge
 * ALSO firing `queue:progress` at the window — the renderer being the only
 * possible listener. Now the caller is main, and the callback is simply used.
 */
import { translationBridge } from '../translation-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow, resourceForProvider } from './runtime';
import { providerConfigOf, type AiJobConfig } from './ai-provider';

interface TranslationStepConfig extends AiJobConfig {
  chunkSize?: number;
}

export const translationStep: StepModule = {
  type: 'translation',
  consumes: 'epub',
  produces: 'epub',
  resource: resourceForProvider,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as TranslationStepConfig;
    const epubPath = ctx.input.path;
    if (!epubPath) throw new Error('Translation was given no book to read.');

    const result = await translationBridge.translateEpub(
      epubPath,
      ctx.stepId,
      queueMainWindow(),
      (progress) => {
        ctx.report({
          percent: progress.percentage,
          message: progress.message,
          metrics: {
            currentChunk: progress.currentChunk,
            totalChunks: progress.totalChunks,
            currentChapter: progress.currentChapter,
            totalChapters: progress.totalChapters,
            chunksCompletedInJob: progress.chunksCompletedInJob,
            totalChunksInJob: progress.totalChunksInJob,
            // The bridge counts one session only, so its cumulative count IS the
            // session count. Nullish, not `||`: a legitimate 0 must not collapse
            // to undefined and leave the rate dividing by a window it never had.
            chunksDoneInSession: progress.chunksCompletedInJob,
            cleanupPhase: progress.phase as never,
          },
        });
      },
      providerConfigOf(config),
      { chunkSize: config.chunkSize },
    );

    if (!result.success || !result.outputPath) {
      throw new Error(result.error || 'Translation failed and gave no reason.');
    }
    ctx.step.analytics = (result as { analytics?: unknown }).analytics;
    ctx.report({ metrics: {
      translationFailedChunks: (result as { failedChunkCount?: number }).failedChunkCount,
      skippedChunksPath: (result as { skippedChunksPath?: string }).skippedChunksPath,
    } });
    return { kind: 'epub', path: result.outputPath };
  },

  cancel(stepId: string): void {
    translationBridge.cancelTranslationJob(stepId);
  },
};

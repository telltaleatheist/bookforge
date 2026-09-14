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
import {
  crucibleModelForAiStep, machinesForAiStep, providerConfigOf, type AiJobConfig,
} from './ai-provider';

interface TranslationStepConfig extends AiJobConfig {
  chunkSize?: number;
}

export const translationStep: StepModule = {
  type: 'translation',
  consumes: 'epub',
  produces: 'epub',
  resource: resourceForProvider,
  /**
   * IT TRAVELS WHEN ITS PROVIDER IS A CRUCIBLE (crucible
   * `docs/PHASE7-LANES.md` §4, §4.4).
   *
   * A translation against `crucible` is hundreds of chat completions on
   * another machine's card, so the row belongs to that machine's slot set and
   * to the run's venue. Against Ollama, the bundled llama, Claude or OpenAI it
   * travels nowhere — see `machinesForAiStep`, which owns the rule for both AI
   * steps so a new provider cannot be taught to one and forgotten by the other.
   */
  machines: machinesForAiStep,
  /**
   * IT LEASES ITS MODEL when its provider is a Crucible.
   *
   * A translation against `crucible` is a run of chat completions against one
   * resident model, and between any two of them the card is unprotected — the
   * server unloads the moment nothing holds it. The scheduler reads this to
   * decide whether the RUN's lease survives the step in front of it, so a row
   * that translates and then does another act against the same model holds one
   * lease across both (`electron/crucible/lease.ts`, ONE LEASE PER ROW).
   *
   * False for every other provider, and that is the truth rather than caution:
   * Ollama and the bundled llama keep their own VRAM through `keep_alive`, and
   * a cloud provider has no card to hold.
   */
  leasesModel: (config: Record<string, unknown>): boolean =>
    config['aiProvider'] === 'crucible',

  /**
   * WHICH model it leases — the row's own `aiModel`, through the one owner.
   *
   * `leasesModel` above says a lease MAY be held; this says on what, and the
   * scheduler keeps the run's lease across the seam only when the two acts
   * name the same id. A lease is per model and a server holds one, so keeping
   * the 9B's lease into a step that must load the 27B is a `leased` refusal
   * this app hands itself (Foundry, 2026-09-14).
   */
  leasedModel: crucibleModelForAiStep,

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
      // THE RUN'S VENUE, NOT A NEW DECISION — the machine the queue assigned
      // this book. Only the `crucible` provider reads it, and it REFUSES by
      // name rather than guessing when the row was never assigned one.
      providerConfigOf(config, ctx.job.waitForResolved),
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

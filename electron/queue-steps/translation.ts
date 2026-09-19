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
import { queueMainWindow, resourceForProvider, stepFailure } from './runtime';
import {
  machinesForAiStep, providerConfigOf, type AiJobConfig,
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
   * THE CAPABILITY CLASS THIS STEP IS (crucible PHASE15 §5.3).
   *
   * Read by the pump at the one moment both facts exist — the class, which is
   * the step's, and the engine, which is the row's — to ask whether that
   * engine ROUTES this class to an upstream. If it does, the run holds no card
   * and takes the engine's `[cloud]` lane instead of its GPU slot.
   *
   * It is the same name `providerConfigOf` is handed below, which is not a
   * coincidence: the act the engine is told (`X-Crucible-Act`) and the class
   * the queue reasons about are one fact.
   */
  crucibleClass: (): string => 'translate',
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
   * WHICH model it leases — and the answer is NULL BY CONSTRUCTION now.
   *
   * `leasesModel` above says a lease MAY be held; this says on what, and the
   * scheduler keeps the run's lease across the seam only when the two acts
   * name the same id. A lease is per model and a server holds one, so keeping
   * the 9B's lease into a step that must load the 27B is a `leased` refusal
   * this app hands itself (Foundry, 2026-09-14).
   *
   * The id used to be the row's own `aiModel`. Since phase 15 a text door
   * sends `capability.selected` for its class (crucible PHASE15 §5.3), which
   * is the SERVER's answer and needs a server name and a round trip — and this
   * hook is synchronous and asked before the step is placed. `pass.ts` had
   * already reached exactly this answer for `narration-text`; it is now true
   * of every act, and the argument lives once, in `ai-provider.ts`.
   *
   * Null never equals an open lease's subject, so the lease is given back at
   * the seam: the behaviour before one-lease-per-row existed. Nothing is
   * swallowed — the act raises its own named refusal when it runs.
   */
  leasedModel: (): string | null => null,

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
      providerConfigOf(config, 'translate', ctx.job.waitForResolved),
      { chunkSize: config.chunkSize },
    );

    if (!result.success || !result.outputPath) {
      /*
       * A 409 IS A WAIT, AND THE TRANSLATION NOW TAKES IT (A5, 2026-09-19).
       *
       * `mono-translation-job.ts` has carried the holder's line on its result
       * since 2026-09-18 — `crucible_model_leased` and `crucible_server_busy`
       * both arrive with one — and this module dropped it on the floor, so a
       * translate against a held card reddened in *Needs you* while a simplify
       * against the same card parked. `stepFailure` is the one road: a park
       * when a holder was named, an ordinary failure when none was.
       */
      throw stepFailure(
        result.error || 'Translation failed and gave no reason.', result.busyLine);
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

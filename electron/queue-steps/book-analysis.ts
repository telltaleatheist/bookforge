/**
 * book-analysis — read a book (or an audiobook) for flagged content.
 *
 * Two sources and they are genuinely different acts: a document is analysed from
 * its EPUB text, an audiobook from its transcript, and which one is not inferred
 * from a path. The source identity travels on the config exactly as it did.
 */
import { onBridgeEvent } from '../bridge-events';
import { analyzeAudiobook, analyzeBook, cancelAnalysisJob } from '../book-analysis';
import { broadcastToAllWindows } from '../document-stage-run';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow, resourceForProvider } from './runtime';
import {
  crucibleModelForAiStep, machinesForAiStep, providerConfigOf, type AiJobConfig,
} from './ai-provider';

interface AnalysisProgressEvent {
  jobId: string;
  type?: string;
  phase?: string;
  progress?: number;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
  currentChapter?: number;
  totalChapters?: number;
}

type AnalysisSource =
  | { kind: 'document'; epubPath: string }
  | { kind: 'audiobook'; projectId: string; variantId: string };

interface AnalysisStepConfig extends AiJobConfig {
  projectDir: string;
  source: AnalysisSource;
  categories: Array<{ id: string; name: string; description: string; color: string; enabled: boolean }>;
  testMode?: boolean;
  testModeChunks?: number;
  target?: { versionId: string; versionType: string; versionLabel: string };
  /** Resolved by main when the source is an audiobook. */
  outputDir?: string;
}

export const bookAnalysisStep: StepModule = {
  type: 'book-analysis',
  // It reads a book OR an audiobook variant, and which is on the config. Naming
  // one kind here would refuse the other.
  consumes: null,
  produces: 'report',
  resource: resourceForProvider,
  /**
   * IT TRAVELS WHEN ITS PROVIDER IS A CRUCIBLE (crucible
   * `docs/PHASE7-LANES.md` §4, §4.4) — an analysis is a run of chat
   * completions, and against `crucible` they happen on another machine's card.
   * `machinesForAiStep` owns the rule for both AI steps; see `translation.ts`.
   */
  machines: machinesForAiStep,
  /**
   * IT LEASES ITS MODEL when its provider is a Crucible.
   *
   * A analysis against `crucible` is a run of chat completions against one
   * resident model, and between any two of them the card is unprotected — the
   * server unloads the moment nothing holds it. The scheduler reads this to
   * decide whether the RUN's lease survives the step in front of it, so a row
   * that analyses and then does another act against the same model holds one
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
    const config = ctx.step.config as unknown as AnalysisStepConfig;
    if (!config?.source?.kind) {
      throw new Error('This analysis row does not say what it is analysing.');
    }
    if (!Array.isArray(config.categories) || config.categories.length === 0) {
      throw new Error('This analysis row has no categories, so it would flag nothing.');
    }
    // THE RUN'S VENUE, NOT A NEW DECISION — the machine the queue assigned
    // this book. Only the `crucible` provider reads it, and it refuses by name
    // rather than guessing when the row was never assigned one.
    const provider = providerConfigOf(config, ctx.job.waitForResolved);

    const unsubscribe = onBridgeEvent<AnalysisProgressEvent>('queue:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      ctx.report({
        percent: event.progress,
        message: event.message,
        metrics: {
          currentChunk: event.currentChunk,
          totalChunks: event.totalChunks,
          currentChapter: event.currentChapter,
          totalChapters: event.totalChapters,
          chunksCompletedInJob: event.currentChunk,
          totalChunksInJob: event.totalChunks,
          chunksDoneInSession: event.currentChunk,
        },
      });
    });

    try {
      const options = {
        categories: config.categories,
        testMode: config.testMode,
        testModeChunks: config.testModeChunks,
      };
      const result = config.source.kind === 'audiobook'
        ? await analyzeAudiobook(
          config.source.projectId, config.source.variantId,
          ctx.stepId, queueMainWindow(), provider, options,
        )
        : await analyzeBook(
          config.source.epubPath, ctx.stepId, queueMainWindow(), provider,
          { ...options, outputDir: config.outputDir, target: config.target },
        );

      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'The analysis failed and gave no reason.');
      }
      ctx.step.analytics = (result as { analytics?: unknown }).analytics;
      ctx.report({ metrics: {
        contentSkipsDetected: (result as { contentSkipsDetected?: boolean }).contentSkipsDetected,
        contentSkipsAffected: (result as { contentSkipsAffected?: number }).contentSkipsAffected,
        skippedChunksPath: (result as { skippedChunksPath?: string }).skippedChunksPath,
      } });
      if (config.projectDir) broadcastToAllWindows('project:files-changed', config.projectDir);
      return { kind: 'report', path: result.outputPath };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    cancelAnalysisJob(stepId);
  },
};

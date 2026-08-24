/**
 * tts-conversion — narrate a book, in main.
 *
 * This is the step the whole refactor is about. It is the longest job the app
 * runs (nine hours is ordinary), it holds the GPU for all of it, and until now
 * the thing deciding when it started, watching it, and deciding it had finished
 * lived in a window that a reload could destroy.
 *
 * The bridge is UNCHANGED. `startParallelConversion` / `resumeParallelConversion`
 * spawn the same workers through the same WSL/Orpheus path; this module only
 * calls them from the side of the wire that owns them, and listens for the
 * bridge's own `parallel-tts:*` events on the main-side bus instead of through
 * the renderer.
 *
 * ── Resume, which is the delicate part ──────────────────────────────────────
 *
 * The rendered sentences on disk are the asset. Every branch below exists to
 * avoid destroying them, and the ordering is the one the renderer had, moved
 * verbatim rather than re-derived:
 *
 *  1. an EXPLICIT resume — the wizard's Continue, carrying the session it found;
 *  2. an INTERRUPTED step — a stop, or an app exit — scan e2a's scratch for a
 *     session against this EPUB;
 *  2.5. a CACHED session for this language under the project;
 *  3. fresh.
 *
 * `cleanSession` (which deletes the scratch checkpoints) is set by exactly ONE
 * of those: an explicit "Start fresh" chosen over "Continue". It used to be set
 * for every non-resuming job, which is how a resume that merely failed to FIND
 * its checkpoint went on to destroy it.
 */
import { onBridgeEvent, waitForBridgeEvent } from '../bridge-events';
import {
  checkResumeStatusFast,
  checkResumeStatusFromProcessDir,
  findResumableProjectSession,
  resumeParallelConversion,
  startParallelConversion,
  stopAndCacheParallelConversion,
  cacheSessionToProject,
  detectRecommendedWorkerCount,
  setMainWindow,
} from '../parallel-tts-bridge';
import { getTTSLogger } from '../rolling-logger';
import type { StepModule, StepRunContext, StepReport } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

/** The bridge's AggregatedProgress, as it arrives on the bus. */
interface TtsProgressEvent {
  jobId: string;
  progress: Record<string, unknown>;
}

interface TtsCompleteEvent {
  jobId: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  analytics?: unknown;
  rvcAnalytics?: unknown;
  wasStopped?: boolean;
  sessionId?: string;
  sessionDir?: string;
}

/** What the row shows, from what the bridge measured. */
function mapProgress(p: Record<string, unknown>): StepReport {
  const num = (k: string): number | undefined =>
    typeof p[k] === 'number' ? (p[k] as number) : undefined;
  const phase = p['phase'] as string | undefined;
  const completed = num('completedSentences') ?? 0;
  const total = num('totalSentences') ?? 0;
  const activeWorkers = num('activeWorkers') ?? 0;
  const workerWord = activeWorkers === 1 ? 'worker' : 'workers';

  const report: StepReport = {
    percent: phase === 'assembling' && typeof p['assemblyProgress'] === 'number'
      ? (p['assemblyProgress'] as number)
      : num('percentage'),
    message: (p['message'] as string | undefined)
      ?? `${activeWorkers} ${workerWord} active (${completed}/${total} chunks)`,
    // Replaced, never kept: a landed batch must not leave a full secondary bar
    // sitting under a chunk bar that is moving again.
    activeBatch: (p['activeBatch'] as never) ?? null,
    metrics: {
      chunksCompletedInJob: completed,
      totalChunksInJob: total,
      chunksDoneInSession: num('completedInSession') ?? completed,
      totalRawSentencesInJob: num('totalRawSentences'),
      rawSentencesDoneInSession: num('rawCompletedInSession'),
      totalRawWordsInJob: num('totalRawWords'),
      totalRawCharsInJob: num('totalRawChars'),
      rawWordsDoneInSession: num('rawWordsCompletedInSession'),
      rawCharsDoneInSession: num('rawCharsCompletedInSession'),
      audioSecondsPerChar: num('audioSecondsPerChar'),
      currentChapter: num('assemblyChapter'),
      totalChapters: num('assemblyTotalChapters'),
      parallelWorkers: p['workers'] as never,
      ttsPhase: phase === 'enhancing' ? 'converting' : (phase as never),
      ttsConversionProgress: phase === 'converting'
        ? (total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0)
        : (phase === 'assembling' || phase === 'complete' ? 100 : undefined),
      assemblyProgress: num('assemblyProgress'),
      assemblySubPhase: p['assemblySubPhase'] as never,
      orpheusMemoryLevel: (p['orpheusMemoryLevel'] as string | undefined) || undefined,
    },
  };
  if (p['stages'] !== undefined) report.stages = p['stages'] as never;
  // ALWAYS sent, null when the bridge has none. The bridge sets a detail when a
  // worker starts loading its model and CLEARS it when the model is loaded; a
  // guard that only forwarded a present value dropped every clear, so the line
  // it set was permanent. Same discipline as activeBatch above.
  report.detail = (p['stageDetail'] as string | undefined) ?? null;
  return report;
}

interface TtsConfig {
  device: 'auto' | 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;
  fineTuned: string;
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
  outputFilename?: string;
  outputDir?: string;
  parallelWorkers?: number;
  parallelMode?: 'sentences' | 'chapters';
  bilingual?: { enabled: boolean; pauseDuration?: number; gapDuration?: number };
  skipAssembly?: boolean;
  resumeInfo?: Record<string, unknown>;
  missingRanges?: unknown;
  startFresh?: boolean;
  sentencePerParagraph?: boolean;
  skipHeadings?: boolean;
  testMode?: boolean;
  testSentences?: number;
  finalDenoise?: boolean;
  rvcEnhancement?: {
    enabled: boolean; voiceId: string;
    indexRate?: number; protectRate?: number; nSemitones?: number;
  };
  metadata?: {
    title?: string; bookTitle?: string; author?: string; year?: string;
    coverPath?: string; outputFilename?: string;
  };
  /** Absolute project directory. Named bfpPath for the key it has always had. */
  bfpPath?: string;
  isArticle?: boolean;
}

/**
 * Every branch of the resume decision, written to the PERSISTED tts.log.
 *
 * These lines used to be renderer console.logs, which vanish with the window —
 * which is why the July 2026 destructive-resume incident could not be
 * reconstructed from files. Running in main, the log is simply there.
 */
function ttsDecision(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  data?: Record<string, unknown>,
): void {
  const log = getTTSLogger();
  if (level === 'ERROR') log.error(message, data);
  else if (level === 'WARN') log.warn(message, data);
  else log.info(message, data);
}

export const ttsConversionStep: StepModule = {
  type: 'tts-conversion',
  consumes: 'epub',
  produces: 'audio-session',
  resource: () => 'gpu',
  // The rendered sentences survive a stop, and a resume skips them. That is the
  // whole reason a stopped narration must land HELD rather than cancelled.
  stopIsResumable: true,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as TtsConfig;
    setMainWindow(queueMainWindow());

    const epubPath = ctx.input.path;
    if (!epubPath) {
      throw new Error('Narration was given no book to read.');
    }

    let workerCount = config.parallelWorkers;
    if (!workerCount || workerCount <= 0) {
      workerCount = detectRecommendedWorkerCount().count;
    }

    const projectDir = config.bfpPath ?? ctx.job.projectId ?? '';
    const conversionConfig: Record<string, unknown> = {
      workerCount,
      epubPath,
      outputDir: config.outputDir || '',
      parallelMode: config.parallelMode || 'sentences',
      settings: {
        device: config.device,
        language: config.language,
        ttsEngine: config.ttsEngine,
        fineTuned: config.fineTuned,
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        repetitionPenalty: config.repetitionPenalty,
        speed: config.speed,
        enableTextSplitting: config.enableTextSplitting,
        sentencePerParagraph: config.sentencePerParagraph,
        skipHeadings: config.skipHeadings,
        testMode: config.testMode,
        testSentences: config.testSentences,
      },
      metadata: {
        title: config.metadata?.bookTitle || config.metadata?.title,
        author: config.metadata?.author,
        year: config.metadata?.year,
        coverPath: config.metadata?.coverPath,
        outputFilename: config.metadata?.outputFilename || config.outputFilename,
      },
      bilingual: config.bilingual,
      skipAssembly: config.skipAssembly,
      bfpPath: projectDir || undefined,
      isArticle: config.isArticle,
      rvcEnhancement: config.rvcEnhancement,
      finalDenoise: config.finalDenoise,
    };

    // ── Which session, if any, this run picks up ────────────────────────────
    const interrupted = ctx.step.wasInterrupted === true;
    let resumeInfo: Record<string, unknown> | null = null;

    ttsDecision('INFO', 'TTS resume decision: evaluating', {
      stepId: ctx.stepId,
      hasResumeInfo: !!config.resumeInfo,
      wasInterrupted: interrupted,
      startFresh: !!config.startFresh,
      language: config.language || null,
      projectDir: projectDir || null,
      epubPath,
    });

    if (config.resumeInfo) {
      // Mode 1: the wizard's Continue, carrying the session it found.
      resumeInfo = {
        success: true,
        sessionId: config.resumeInfo['sessionId'],
        sessionDir: config.resumeInfo['sessionDir'],
        processDir: config.resumeInfo['processDir'],
        totalSentences: config.resumeInfo['totalSentences'],
        totalChapters: config.resumeInfo['totalChapters'],
        completedSentences: ctx.step.metrics.resumeCompletedSentences,
        missingSentences: ctx.step.metrics.resumeMissingSentences,
        missingRanges: config.missingRanges,
        chapters: config.resumeInfo['chapters'],
      };
      ttsDecision('INFO', 'TTS resume mode 1: explicit resume from the wizard', {
        stepId: ctx.stepId, sessionDir: config.resumeInfo['sessionDir'],
      });
    } else if (interrupted) {
      // Mode 2: this step's own work was cut short. Look for its scratch session.
      const found = await checkResumeStatusFast(epubPath);
      if (found.success && !found.complete && (found.completedSentences ?? 0) > 0) {
        resumeInfo = found as unknown as Record<string, unknown>;
        ctx.report({ metrics: {
          resumeCompletedSentences: found.completedSentences,
          resumeMissingSentences: found.missingSentences,
        } });
        ttsDecision('INFO', 'TTS resume mode 2: auto-resuming an interrupted run', {
          stepId: ctx.stepId,
          completedSentences: found.completedSentences ?? null,
          totalSentences: found.totalSentences ?? null,
        });
      } else {
        ttsDecision('WARN', 'TTS resume mode 2 did not match: no resumable scratch session', {
          stepId: ctx.stepId, epubPath, reason: found.error ?? (found.complete ? 'already complete' : 'no progress'),
        });
      }
    }

    // "Start fresh": the user chose New over Continue while a cached session
    // existed. It suppresses the cached-session auto-resume AND authorises
    // deleting the scratch checkpoints — the ONE submission that may.
    const explicitFresh = config.startFresh === true && !interrupted && !config.resumeInfo;

    if (!resumeInfo && !explicitFresh && projectDir) {
      // Mode 2.5: a partial session cached under the project for this language.
      try {
        // The SAME lookup the narration dialog shows the user, so the offer and
        // the decision cannot disagree — see findResumableProjectSession.
        const found = await findResumableProjectSession(projectDir, config.language);
        if (found) {
          const check = await checkResumeStatusFromProcessDir(found.sessionDir);
          if (check.success && !check.complete && (check.completedSentences ?? 0) > 0) {
            resumeInfo = check as unknown as Record<string, unknown>;
            ctx.report({ metrics: {
              resumeCompletedSentences: check.completedSentences,
              resumeMissingSentences: check.missingSentences,
            } });
            ttsDecision('INFO', 'TTS resume mode 2.5: resuming the project-cached session', {
              stepId: ctx.stepId, language: found.language, sessionDir: found.sessionDir,
            });
          }
        }
      } catch (err) {
        ttsDecision('ERROR', 'TTS resume mode 2.5 errored while checking the cache', {
          stepId: ctx.stepId, error: (err as Error)?.message || String(err),
        });
      }
    }

    if (!resumeInfo && explicitFresh) {
      conversionConfig['cleanSession'] = true;
      ttsDecision('WARN', 'TTS mode 3: starting fresh, cleanSession=true (explicit Start fresh)', {
        stepId: ctx.stepId, epubPath, language: config.language || null,
      });
    } else if (!resumeInfo) {
      ttsDecision('WARN', 'TTS mode 3: starting fresh WITHOUT cleanSession (keeping any checkpoint)', {
        stepId: ctx.stepId, epubPath,
      });
    }

    // ── Run it ──────────────────────────────────────────────────────────────
    const unsubscribe = onBridgeEvent<TtsProgressEvent>('parallel-tts:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      ctx.report(mapProgress(event.progress));
    });
    // Subscribed BEFORE the bridge is called: `startParallelConversion` can fail
    // and emit its completion before it returns, and a listener attached after
    // that would wait forever for a message already sent.
    const finished = waitForBridgeEvent<TtsCompleteEvent>(
      'parallel-tts:complete', (e) => e.jobId === ctx.stepId,
    );

    try {
      const invoked = resumeInfo
        ? await resumeParallelConversion(ctx.stepId, conversionConfig as never, resumeInfo as never)
        : await startParallelConversion(ctx.stepId, conversionConfig as never);

      if (invoked && invoked.success === false) {
        // The bridge normally emits a completion for these too. Wait a beat for
        // it — it carries the reason — and fail with the invoke's reason if it
        // never comes.
        const settled = await Promise.race([
          finished,
          new Promise<null>((r) => setTimeout(() => r(null), 3000)),
        ]);
        if (!settled) throw new Error(invoked.error || 'Narration failed to start.');
      }

      const result = await finished;
      if (result.wasStopped) {
        // A stop, not a failure. The engine reads `stopIsResumable` and leaves
        // the step held; throwing is how the run is unwound.
        throw new Error('Stopped by the user.');
      }
      if (!result.success) {
        throw new Error(result.error || 'Narration failed and gave no reason.');
      }

      // The session is promoted to the project cache so a later step reads a
      // durable path rather than e2a's scratch, which the startup sweep clears.
      // Idempotent: the bridge does this too on its own success path.
      const sessionDir = result.sessionDir;
      let sentencesDir = result.outputPath;
      if (sessionDir && projectDir) {
        try {
          const cached = await cacheSessionToProject(
            sessionDir, projectDir, config.language || 'en',
          );
          if (cached.success && cached.cachedSentencesDir) sentencesDir = cached.cachedSentencesDir;
        } catch (err) {
          console.error('[QUEUE-STEP tts] could not cache the session to the project:', err);
        }
      }

      if (result.analytics) ctx.step.analytics = result.analytics;

      return {
        kind: 'audio-session',
        path: sentencesDir,
        sessionId: result.sessionId,
        sessionDir,
        detail: {
          projectDir,
          language: config.language,
          skipAssembly: config.skipAssembly === true,
          rvcAnalytics: result.rvcAnalytics,
        },
      };
    } finally {
      unsubscribe();
    }
  },

  async cancel(stepId: string): Promise<void> {
    // The CACHING stop, deliberately: it promotes the sentences rendered so far
    // to the durable project cache, which is what makes the step resumable. The
    // plain stop would leave them in scratch for the next sweep to delete.
    await stopAndCacheParallelConversion(stepId);
  },
};

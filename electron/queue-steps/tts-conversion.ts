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
  TTS_GPU_PHASE_OVER,
  type PreparedSessionRef,
} from '../parallel-tts-bridge';
import { getTTSLogger } from '../rolling-logger';
import type { StepModule, StepRunContext, StepReport } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import type { StopReason } from '../../shared/queue/stop-reason';
import { projectDirForStep, queueMainWindow, stepFailure } from './runtime';
import { runVenueOfRow } from '../crucible/step-venue';

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
  /**
   * THE SERVER WOULD NOT TAKE THE RENDER, and said who holds the card.
   *
   * Present exactly on a `409 server_busy` / `409 leased` (crucible
   * `docs/ARCHITECTURE.md` §3), carried from the refusal by the bridge
   * (`ConversionSession.crucibleBusyLine`). Handed to the seam below, it makes
   * the row WAIT with that sentence on it rather than fail.
   */
  busyLine?: string;
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
    // The same discipline, one stage earlier: the normalization bar is blanked
    // the moment prep stops reporting one, or it would sit full under a
    // "Preparing book" bar that has moved on.
    prep: (p['prep'] as never) ?? null,
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
      /*
       * WHEN THIS ROW STOPPED RENDERING. From here the row's Elapsed is the
       * RENDER's, not the step's — the publish and the assembly are different
       * acts and the row says which one it is doing (Owen, 2026-09-20). It is
       * carried as a metric rather than inferred from the stage bars because
       * the analytics record and the readout must agree on one instant.
       */
      renderSettledAt: num('renderSettledAt'),
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
  /*
   * NO `device` SINCE 2026-09-19 (Owen: *"we don't need device as an option —
   * that's decided by crucible configuration. we can just cut it. it will
   * always be auto"*). A restored queue.json whose rows still carry the key
   * loads unchanged — this reads the fields it declares, and an undeclared one
   * is never looked at, so no persisted row is failed over it.
   */
  language: string;
  ttsEngine: string;
  fineTuned: string;
  speed: number;
  enableTextSplitting: boolean;
  outputFilename?: string;
  outputDir?: string;
  parallelWorkers?: number;
  parallelMode?: 'sentences' | 'chapters';
  skipAssembly?: boolean;
  resumeInfo?: Record<string, unknown>;
  missingRanges?: unknown;
  startFresh?: boolean;
  /**
   * WHETHER THE NARRATION TEXT CLEANUP IS REQUIRED OF THIS RUN — 'required' or
   * 'skipped', stated by whoever queued the row (the Narrate button asks the
   * user when the file it is about to read carries no current stamp).
   *
   * Optional HERE because this interface also describes rows persisted in
   * queue.json by builds that had no such question. It is not defaulted: the
   * bridge refuses a conversion that does not say, in its own sentence, because
   * the two values are two different things to write in the log about an hour
   * of GPU.
   */
  textCleanup?: 'required' | 'skipped';
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
  /**
   * Absolute project directory. Named bfpPath for the key it has always had;
   * `projectDir` is the ARTICLE spelling of the same fact, and exactly one of
   * the two is set (shared/queue/narration-run.ts § NarrationStepPlan). Read
   * through `projectDirForStep`, which also reads what the artifact in front of
   * this step said, so a narration chained under a Foundry export knows its
   * project even though the RUN has no `projectId`.
   */
  bfpPath?: string;
  projectDir?: string;
  isArticle?: boolean;
}

/**
 * Every branch of the resume decision, written to the PERSISTED tts.log.
 *
 * These lines used to be renderer console.logs, which vanish with the window —
 * which is why the July 2026 destructive-resume incident could not be
 * reconstructed from files. Running in main, the log is simply there.
 */
/**
 * THE PACKED SESSION THIS RENDER WAS HANDED, or undefined when it was handed a
 * book.
 *
 * Structural rather than a cast: the artifact's KIND is the fact that decides
 * the arm, and a `prepared-session` that is missing any of the four names it
 * must carry is a bug in the prepare step, not an epub row. Refused there
 * (`run`, by name) rather than quietly falling into the inline arm, which would
 * pack a book a second time and throw the first pack away.
 */
function preparedSessionOf(input: ArtifactRef): PreparedSessionRef | undefined {
  if (input.kind !== 'prepared-session') return undefined;
  const detail = (input.detail ?? {}) as Record<string, unknown>;
  const said = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const epubPath = said(detail['epubPath']);
  const num = (key: string): number =>
    typeof detail[key] === 'number' ? (detail[key] as number) : 0;
  const server = said(detail['packedForServer']);
  const ceiling = detail['packedCeilingChars'];
  return {
    sessionId: input.sessionId ?? '',
    sessionDir: input.sessionDir ?? '',
    processDir: input.processDir ?? '',
    epubPath: epubPath ?? '',
    totalSentences: num('totalSentences'),
    totalChapters: num('totalChapters'),
    ...(server !== undefined && typeof ceiling === 'number'
      ? { packedFor: { server, ceilingChars: ceiling } } : {}),
  };
}

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
  /**
   * A PACKED SESSION, OR THE BOOK ITSELF — and the pair is not a widening for
   * convenience.
   *
   * `prepared-session` is what a run composed since 2026-09-19 hands it: the
   * `prepare` row in front packed the book on a CPU slot, and this row is the
   * render and nothing else (Owen: *"Prepare can be its own CPU step"*).
   *
   * `epub` is THE COMPATIBILITY ARM. A queue.json restored from before that
   * date holds `tts-conversion` rows rooted at the document with no prepare
   * step in front of them, and the language-learning wizard composes its own
   * chain the same way. Such a row preps INLINE, exactly as this step always
   * did — announced in the log, never a silent default. Declaring one kind
   * would fail every one of those rows at compose time for a reason that has
   * nothing to do with them.
   */
  consumes: ['prepared-session', 'epub'],
  produces: 'audio-session',
  resource: () => 'gpu',
  /*
   * NO `leasesModel` HERE, AND THE ABSENCE IS THE
   * STATEMENT (Owen, 2026-09-19: *"as soon as the GPU finishes, it releases the
   * lease"*).
   *
   * A render takes NO Crucible lease in the first place: it is one `tts` job on
   * the lane, which already holds everything a lease would hold, and `tts` is
   * in crucible's `EVICTS_THE_RESIDENT_MODEL`, so a lease taken around one
   * would have the server refuse `409 leased` to the very run that took it
   * (`electron/crucible/render.ts`). What the absence decides is the OTHER
   * half: if this row is carrying a lease taken by an earlier text act,
   * `leaseWantedAfter` asks the children of this step whether the same card is
   * wanted next, `align` declares nothing either — it loads the ALIGNER, a
   * different model — and `settleStep` gives the card back. Declaring anything
   * here would keep somebody's model resident across a render that has no use
   * for it. `tools/test-queue-narration-plan.js` pins both directions.
   */
  /**
   * THE ONE STEP THAT TRAVELS (crucible `docs/PHASE7-LANES.md` §4).
   *
   * The generation step can run on a Crucible server — one `tts` job per book,
   * `electron/crucible/render.ts` — so the queue asks this row's `waitFor`
   * before it starts it, and hands the answer to the bridge below. Everything
   * else in `queue-steps/` keeps the default `local`, because nothing else has
   * been taught to send its work anywhere.
   *
   * Unconditional on the config: whether a given render actually goes to a
   * server is the ROUTING RECORD's answer (the legacy switch, the enable
   * flags), and re-deciding it here from the config would be a second owner of
   * that question.
   */
  machines: () => 'any',
  // The rendered sentences survive a stop, and a resume skips them. That is the
  // whole reason a stopped narration must land HELD rather than cancelled.
  stopIsResumable: true,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as TtsConfig;
    setMainWindow(queueMainWindow());

    /*
     * ── WHICH ARM: A PACKED SESSION, OR THE BOOK ─────────────────────────────
     *
     * See `consumes` above. The prepared arm is what every run composed since
     * 2026-09-19 takes; the epub arm is the compatibility one, and it is said
     * out loud in the persisted TTS log rather than inferred from a silence.
     */
    const prepared = preparedSessionOf(ctx.input);
    if (prepared !== undefined) {
      /*
       * A PREPARED SESSION THAT IS MISSING A NAME IS A BUG IN THE PREPARE STEP,
       * and it is refused as one rather than falling through to the inline arm
       * — which would pack the book a second time and throw away the pack this
       * row's parent already paid minutes for.
       */
      const missing = (['sessionId', 'sessionDir', 'processDir', 'epubPath'] as const)
        .filter((key) => prepared[key] === '');
      if (missing.length > 0) {
        throw new Error(
          `The prepared session this render was handed names no ${missing.join(', no ')}. The `
          + 'prepare step records all four; a session missing any of them cannot be rendered or '
          + 'matched to a book. Remove this book from the queue and add it again.');
      }
    }
    const epubPath = prepared?.epubPath ?? ctx.input.path;
    if (!epubPath) {
      throw new Error('Narration was given no book to read.');
    }

    let workerCount = config.parallelWorkers;
    if (!workerCount || workerCount <= 0) {
      workerCount = detectRecommendedWorkerCount().count;
    }

    const projectDir = projectDirForStep(ctx, config) ?? '';

    /*
     * WHERE THIS BOOK'S GENERATION RUNS — the row's decision, handed on.
     *
     * The engine resolved it at admission and wrote it on the run
     * (`waitForResolved`, crucible `docs/PHASE7-LANES.md` §4.3/§4.4: one book,
     * one GPU, recorded so a resume goes back to the same machine). Passing it
     * as `settings.crucible` takes the CALLER-NAMED path in
     * `generation-venue.ts`, which is the one answer nothing second-guesses —
     * so the venue the queue page shows and the venue the render uses are the
     * same fact rather than two lookups that can disagree.
     *
     * An UNASSIGNED row passes nothing and the bridge decides for itself
     * (`generation-venue.ts`), which is what a standalone CLI render does.
     *
     * ── THROUGH `runVenueOfRow`, NOT RAW (bug hunt 2026-09-20, C6) ──────────
     *
     * `waitForResolved` is a string with THREE shapes and this door read it as
     * one, spelling the conversion inline where `align.ts` and every other
     * travelling step ask `crucible/step-venue.ts` — "the ONE reader of
     * `waitForResolved`'s three shapes". The consequence was a row carrying
     * `RETIRED_LOCAL_NARRATOR_VENUE` (admitted while the legacy local narrator
     * existed) dying deep in `crucibleClientFor` as an unknown registry entry
     * instead of the named `legacy_venue_retired` refusal that tells the
     * operator to queue the book again; `any` was latent here only because
     * `assignRunVenue` happens never to write it.
     */
    const runVenue = runVenueOfRow(ctx.job.waitForResolved);

    const conversionConfig: Record<string, unknown> = {
      workerCount,
      epubPath,
      outputDir: config.outputDir || '',
      parallelMode: config.parallelMode || 'sentences',
      settings: {
        language: config.language,
        ttsEngine: config.ttsEngine,
        fineTuned: config.fineTuned,
        speed: config.speed,
        enableTextSplitting: config.enableTextSplitting,
        sentencePerParagraph: config.sentencePerParagraph,
        skipHeadings: config.skipHeadings,
        testMode: config.testMode,
        testSentences: config.testSentences,
        // Spread, never sent as undefined: `generation-venue.ts` refuses a
        // `crucible` block that names no server rather than reading it as
        // "render here", so an explicit absence is the only honest way to say
        // "the record decides". Same shape as `align.ts`'s.
        ...(runVenue === undefined ? {} : { crucible: { server: runVenue.server } }),
      },
      metadata: {
        title: config.metadata?.bookTitle || config.metadata?.title,
        author: config.metadata?.author,
        year: config.metadata?.year,
        coverPath: config.metadata?.coverPath,
        outputFilename: config.metadata?.outputFilename || config.outputFilename,
      },
      skipAssembly: config.skipAssembly,
      // Carried, never invented: absent here reaches the bridge as absent, and
      // the bridge refuses it by name rather than reading it as either answer.
      textCleanup: config.textCleanup,
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
      // WHICH ARM — the first thing a person reconstructing a run needs, because
      // it says whether the chunks in the session were packed by the row in
      // front of this one or by this one.
      packedBy: prepared ? 'the prepare row' : 'this row (no prepare step in front of it)',
      preparedSession: prepared?.sessionDir ?? null,
      hasResumeInfo: !!config.resumeInfo,
      wasInterrupted: interrupted,
      startFresh: !!config.startFresh,
      language: config.language || null,
      projectDir: projectDir || null,
      epubPath,
    });

    /*
     * A PREPARED SESSION IS NOT A RESUME, and none of the three resume modes
     * below may claim it.
     *
     * They all answer the same question — "is there a session on disk with
     * audio in it that this render should pick up?" — and a session this run's
     * own prepare row wrote has none: it was minted minutes ago and holds
     * `session-state.json` and nothing else. Letting mode 2.5 match it against
     * the PROJECT CACHE would be worse than useless: it would find the previous
     * render's cached session, resume that, and silently throw away the pack
     * this run just paid for — including a pack made with different settings.
     *
     * The wizard's explicit Continue (mode 1) is the one case that can still
     * arrive alongside a prepare row, because the user named a session; it is
     * honoured, and the prepared one is not used. Said in the log, because two
     * sessions in one run is exactly the shape a person will be reconstructing.
     */
    if (prepared && config.resumeInfo) {
      ttsDecision('WARN', 'A prepared session AND an explicit resume: the resume wins', {
        stepId: ctx.stepId,
        preparedSession: prepared.sessionDir,
        resumingSession: config.resumeInfo['sessionDir'] ?? null,
      });
    }

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
    } else if (interrupted && prepared === undefined) {
      // Mode 2: this step's own work was cut short. Look for its scratch session.
      //
      // NOT WHEN A PREPARE ROW IS IN FRONT OF IT. An interrupted render whose
      // chunks were packed by its own parent resumes THAT session by rendering
      // it again — every `.flac` already on disk is skipped by the worker's own
      // `--sentences_dir` — and scanning the scratch for a session matching the
      // epub would find the same directory by a slower road, or a different
      // one packed with other settings.
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

    if (!resumeInfo && !explicitFresh && projectDir && prepared === undefined) {
      // Mode 2.5: a partial session cached under the project for this language.
      //
      // NEVER WHEN A PREPARE ROW PACKED THIS RUN — see the note above the modes.
      // The chunks this render is about are the ones its parent just wrote, and
      // resuming the project's PREVIOUS cached session instead would discard
      // them along with whatever settings they were packed with.
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

    if (prepared !== undefined && !resumeInfo) {
      /*
       * THE CHUNKS ARE THE PREPARE ROW'S, and `cleanSession` is not this row's
       * to set even on a "Start fresh" run: that answer was honoured by the
       * prepare row, which deleted the scratch checkpoints BEFORE it packed.
       * Setting it here would delete the session this render is about.
       */
      ttsDecision('INFO', 'TTS: rendering the session the prepare row packed', {
        stepId: ctx.stepId,
        sessionId: prepared.sessionId,
        totalSentences: prepared.totalSentences,
        packedFor: prepared.packedFor?.server ?? null,
      });
    } else if (!resumeInfo && explicitFresh) {
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
    /*
     * THE ROW IS RECHARGED TO THE CPU POOL MID-STEP — see
     * `StepRunContext.releaseGpu` for the 7 m 38 s Owen measured on 2026-09-19.
     *
     * This row is a GPU row because the RENDER is, and the render is over well
     * before the row is: the bridge still has a session to publish into the
     * project, which is minutes of file copy and no card at all. The bridge is
     * the only thing that knows when its last GPU act settled, so it says so and
     * this listens — the queue is told by the work, never by a guess about how
     * long a tail lasts.
     *
     * IT DOES NOT HAND THE CARD TO THE NEXT BOOK (Owen, 2026-09-20: *"i want
     * books to be atomic actions … they shouldnt lose their GPU slot because
     * theyre doing a quick step"*). The run keeps this machine's slot until its
     * last GPU step is terminal — `gpuHoldOf`, `shared/queue/slot-sets.ts` —
     * because the alignment that follows this copy is a GPU act of the same
     * book, and a book that gave the card away here queued behind its own
     * render's activity line to get it back. What this hand-over settles is
     * the POOL: the copy is CPU work, and the bench and the CPU count say so.
     *
     * THE STEP BOUNDARY IS NOT A SUBSTITUTE FOR THIS, and that is a
     * measurement. Taking the alignment out of this step (2026-09-19) shortened
     * the tail by ten minutes but did not remove it: on Owen's *Letter to the
     * American Church* `cacheSessionToProject` alone spent 458 s copying the
     * rendered session onto the library volume, every second of it after the
     * card went quiet. So the hand-over stays, and it now fires the moment the
     * last chunk lands.
     *
     * The reason is passed through verbatim rather than restated here: two
     * sentences for one fact is the shape that drifts.
     */
    const unsubscribeGpu = onBridgeEvent<{ jobId: string; reason: string }>(
      TTS_GPU_PHASE_OVER,
      (event) => {
        if (event.jobId !== ctx.stepId) return;
        ctx.releaseGpu(event.reason);
      },
    );
    // Subscribed BEFORE the bridge is called: `startParallelConversion` can fail
    // and emit its completion before it returns, and a listener attached after
    // that would wait forever for a message already sent.
    const finished = waitForBridgeEvent<TtsCompleteEvent>(
      'parallel-tts:complete', (e) => e.jobId === ctx.stepId,
    );

    try {
      const invoked = resumeInfo
        ? await resumeParallelConversion(ctx.stepId, conversionConfig as never, resumeInfo as never)
        // The packed session when a prepare row wrote one; `undefined` takes
        // the door's own inline prep, which is the compatibility arm.
        : await startParallelConversion(ctx.stepId, conversionConfig as never, prepared);

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
        // A 409 is a WAIT: `stepFailure` mints the refusal that parks this row
        // when the server named a holder, and an ordinary failure when it did
        // not. One road, and the module remembers no side call (A5, 2026-09-19).
        throw stepFailure(result.error || 'Narration failed and gave no reason.', result.busyLine);
      }

      /*
       * THE SESSION IS PROMOTED TO THE PROJECT CACHE — and the artifact NAMES
       * THE CACHED ONE. Idempotent: the bridge does this too on its own success
       * path.
       *
       * It reported the cached SENTENCES and e2a's SCRATCH session until
       * 2026-09-12, with no `processDir` at all — so the assembly chained behind
       * it read `sessionId`/`sessionDir`/`processDir` off its input, found the
       * third missing, and went looking for a project to ask instead. On a
       * Foundry-ordered run there is none (see `projectDirForStep`) and Owen's
       * Starcraft narration failed at the assembly with an hour of good audio on
       * disk. A chained assembly now reads the whole session straight off its
       * input; the project route stays for rows queued AGAINST a project —
       * Studio → Versions → Assemble — which have no step in front of them.
       *
       * The three names come from the cache itself rather than from surgery on
       * the sentences path (`cacheSessionToProject`, session-cache-layout.ts).
       */
      let sessionDir = result.sessionDir;
      let processDir: string | undefined;
      let sentencesDir = result.outputPath;
      if (sessionDir && projectDir) {
        /*
         * A FAILED PUBLISH FAILS THE STEP, and it did not until 2026-09-20.
         *
         * Both arms were swallowed: a throw went to `console.error` and a
         * `success: false` fell through the `if`, and either way the step
         * RETURNED — naming the scratch sentences as its artifact — so the
         * alignment and the assembly behind it read a cache that did not hold
         * the render. On *Hitler's People* that is exactly what happened: the
         * publish returned a five-chunk cache as success, the row went green,
         * and the book stopped two steps later on "chapter 1 is missing chunk
         * audio" with nothing anywhere naming the publish.
         *
         * The audio is not lost when this throws — it is in the scratch session
         * the message names, and the next run resumes from it — so failing here
         * costs a retry and buys a reason.
         */
        const cached = await cacheSessionToProject(
          sessionDir, projectDir, config.language || 'en',
          {
            /*
             * THIS ONE IS NORMALLY THE FAST HALF — the bridge published on
             * completion and what reaches here is the merge that finds the
             * cache already holding the render. It reports anyway, because the
             * case where it is NOT fast (a first publish that failed, a resume
             * whose cache is behind) is exactly the case where a row sitting
             * silently is the thing that gets reported as a hang.
             */
            onProgress: ({ copied, total, waiting }) => ctx.report({
              message: 'Publishing to the library',
              detail: waiting ?? `${copied.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} `
                + 'rendered chunk(s) copied into the library',
            }),
          },
        ).catch((err: unknown) => ({
          success: false as const,
          error: `${(err as Error)?.message ?? String(err)}`,
        }));
        if (!cached.success) {
          throw new Error(
            'The narration rendered but publishing it into the project cache did not: '
            + `${cached.error} The rendered chunks are intact in the scratch session on this `
            + `machine (${sessionDir}) — nothing has to be rendered again, and a Retry `
            + 'publishes the same session. This step stops here because '
            + 'the alignment and the assembly read the project cache, '
            + 'and letting them run would fail them on audio that is missing.');
        }
        if (cached.cachedSentencesDir) {
          sentencesDir = cached.cachedSentencesDir;
          // Only what the cache STATED. A publish that answered the sentences
          // and nothing else is an older answer, not a licence to guess.
          if (cached.cachedSessionDir) sessionDir = cached.cachedSessionDir;
          processDir = cached.cachedProcessDir;
        }
      }

      if (result.analytics) ctx.step.analytics = result.analytics;

      return {
        kind: 'audio-session',
        path: sentencesDir,
        sessionId: result.sessionId,
        sessionDir,
        // Spread, not sent as undefined: absent means "this run did not cache a
        // session", which a reading step answers by asking the project.
        ...(processDir === undefined ? {} : { processDir }),
        detail: {
          projectDir,
          language: config.language,
          skipAssembly: config.skipAssembly === true,
          rvcAnalytics: result.rvcAnalytics,
        },
      };
    } finally {
      unsubscribe();
      unsubscribeGpu();
    }
  },

  async cancel(stepId: string, _step, opts?: { reason: StopReason }): Promise<void> {
    // The CACHING stop, deliberately: it promotes the sentences rendered so far
    // to the durable project cache, which is what makes the step resumable. The
    // plain stop would leave them in scratch for the next sweep to delete.
    //
    // AND IT IS TOLD WHOSE GESTURE IT IS. This bridge words the stop for the
    // user — the progress line it emits is what the row keeps — so a quit that
    // did not say so had the bridge telling Owen he had stopped two renders he
    // never touched (bug hunt 2026-09-20, S12). Forwarded, never re-derived:
    // the engine is the only thing that knows which door was pressed.
    await stopAndCacheParallelConversion(stepId, opts === undefined ? undefined : { reason: opts.reason });
  },
};

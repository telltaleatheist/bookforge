/**
 * reassembly — turn a rendered session into the audiobook.
 *
 * What it assembles is what its PARENT wrote, and the two shapes its parent can
 * be are the two RVC arrangements:
 *
 *  - parent is a narration (`audio-session`) → assemble the session's own
 *    sentences, optionally running the inline RVC pass;
 *  - parent is a denoise or an enhancement (`sentences`) → assemble THAT
 *    directory instead, via e2a's `--sentences_dir`, and LEAVE it: those are
 *    durable sets inside the session (electron/derived-sentences.ts), reused by
 *    the next assembly rather than re-derived at an hour of GPU apiece.
 *
 * The old row had to work this out from a sibling search plus a renderer-side Map
 * keyed by workflow id, with a "does this workflow have an rvc-enhancement job?"
 * lookup to stop RVC running twice. Both arrangements are now just what the
 * parent's output KIND says, so double-processing is not expressible.
 */
import { onBridgeEvent } from '../bridge-events';
import { coverageReportPath, summarizeCoverageReport } from '../coverage-align-job';
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
  /** Delete `sentencesDir` after assembling it. Absence means KEEP — see the
   *  bridge's own note; the derived sets belong to the session, not to this row. */
  disposeSentencesDir?: boolean;
  /**
   * NOT A PASS THIS STEP RUNS ANY MORE — read only so a row queued before the
   * split is refused BY NAME. The bridge fails immediately on `true`.
   */
  finalDenoise?: boolean;
  applyDeRing?: boolean;
  sentenceGap?: number;
  /** Seconds of silence between chapters. Absent = BookForge's default
   *  (`DEFAULT_CHAPTER_GAP`, shared/audio/chapter-gap.ts), not zero. */
  chapterGap?: number;
  /** File the result beside the project's audiobook instead of replacing it —
   *  set by the run description for a conversion of sentences it did not render. */
  registerAsNewVariant?: boolean;
  /** The voice that second version is named after. Required with the flag above. */
  rvcVoiceId?: string;
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
   * declared ON the config. De-ring is an ffmpeg filter and does not count.
   *
   * THE DENOISE NO LONGER APPEARS HERE. It was the second GPU condition, and
   * satisfying it made the WHOLE assembly a GPU step — the card held through the
   * combine and the encode, which are the long tail. It is its own step now
   * ('final-denoise'), so what is left on this config that needs the card is the
   * inline RVC pass alone.
   *
   * Same shape as foundry-job's resourceFor: the type is one, the resource is
   * the config's.
   */
  resource: (config: Record<string, unknown>) =>
    config['rvcEnhancement'] ? 'gpu' : 'cpu',

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

    /*
     * NO JOIN ON A SIBLING ALIGN ANY MORE (Owen, 2026-09-08): "remove the align
     * the narration checkbox. lets just have it permanently do it that way."
     *
     * This step used to find the run's align row and hand the bridge a wait, so
     * the tail sealed the MEASURED `<stem>.sentences.vtt` rather than the
     * estimate. On Shift (mistborn, 1,313 chunks, 16.4 h) that wait held the
     * second CPU slot for two hours with the m4b already on disk, and Owen read
     * the 99 % row as a freeze twice. The transcript sealed below is now
     * whatever is beside the session — narrator's proportional estimate on every
     * ordinary run, and a measured file if somebody aligned the session by hand.
     */

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
        totalChapters,
        metadata: config.metadata,
        excludedChapters: config.excludedChapters ?? [],
        // Only ONE of these is ever set. `sentencesDir` wins by construction.
        ...(enhanced
          ? {
              sentencesDir: enhanced,
              // Absence means KEEP, and that is the answer for every set an
              // upstream STEP produced: those are durable artifacts of the
              // session. Only a config that says so gets disposal.
              ...(config.disposeSentencesDir === true ? { disposeSentencesDir: true } : {}),
            }
          : { rvcEnhancement: config.rvcEnhancement }),
        // Passed through so a stale row still carrying it is REFUSED by the
        // bridge, by name, rather than assembling un-denoised audio in silence.
        finalDenoise: config.finalDenoise,
        applyDeRing: config.applyDeRing,
        sentenceGap: config.sentenceGap,
        chapterGap: config.chapterGap,
        registerAsNewVariant: config.registerAsNewVariant,
        rvcVoiceId: config.rvcVoiceId,
      }, queueMainWindow());

      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'Assembly failed and gave no reason.');
      }
      /*
       * THE AUDIT, ON THE FINISHED BOOK — WHEN SOMEBODY MEASURED THIS SESSION.
       *
       * A narration run composes no Align row any more (Owen, 2026-09-08), so
       * this is no longer a repeat of what a sibling row said hours ago. It is
       * the only place the audit is read out: a `coverage.json` beside the
       * session means someone aligned it — the CLI's `narrator align` door — and
       * a report that exists should be said out loud rather than left on disk.
       * Owen's ruling (2026-09-05) assembles the book whatever the audit found,
       * which only works if what it found stays visible. Reported AFTER the
       * assembly rather than before it, so it lands as the row's resting message
       * instead of being overwritten by the next progress event.
       */
      const audit = summarizeCoverageReport(coverageReportPath(processDir));
      if (audit && audit.retakeIndices.length > 0) {
        ctx.report({ percent: 100, message: `Assembled. Coverage audit: ${audit.line}` });
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

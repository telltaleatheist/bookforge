/**
 * align — force-align the rendered chunks and write the coverage report.
 *
 * The row that measures the render. Higgs v3 has no duration guard worth the
 * name — a chunk scored a duration ratio of 0.99 while dropping 22 % of its
 * text — so without this nobody knows which chunks came out wrong.
 *
 * IT REPORTS AND SUCCEEDS. Owen, 2026-09-05: an imperfect render is the nature
 * of TTS and must not stop an assembly. So a pass that found fourteen doubtful
 * chunks and five it could not place is a SUCCESSFUL row that says so — counts
 * and retake list on the card and in the artifact detail — and the assembly runs
 * behind it. Only a run that could not happen fails the row.
 *
 * ── It reads a SESSION and it writes a SESSION ──────────────────────────────
 *
 * `consumes: 'audio-session'`, `produces: 'audio-session'`, and `run` hands back
 * `ctx.input` verbatim. That is not a placeholder — it is the whole shape of the
 * step. It measures the chunk FLACs the render wrote and leaves them exactly as
 * they are; the thing it produces (`coverage.json`) is read by ASSEMBLY through
 * an argv flag, not by the next step through the chain. So the artifact that
 * flows on is the one that flowed in, and whatever follows — a denoise, a
 * conversion, the assembly — is handed precisely what it would have been handed
 * had this row not been there.
 *
 * A SINGLE consumed kind rather than the `['audio-session', 'sentences']` pair
 * the enhancement passes declare, and that is deliberate: this measures the
 * RENDER. Its thresholds were calibrated on raw engine output (`align/README.md`),
 * a voice conversion re-times and re-timbres every phone, and a guard applied to
 * that audio would refuse books that were read perfectly. Declaring one kind is
 * what makes an Align chained behind an enhancement a COMPOSE-time refusal
 * instead of a plausible-looking wrong answer.
 *
 * ── CPU OR GPU, AND THE ROW SAYS WHICH ─────────────────────────────────────
 *
 * Owen, 2026-09-07: "make it an option the user can pick when adding it to the
 * queue. GPU or CPU? defaults to CPU."
 *
 * CPU is the default and the ordinary answer: RTF 0.082, a book in minutes, in
 * the second cpu slot BESIDE the assembly it belongs to. A row that asks for the
 * GPU claims the single gpu slot and goes through `gpuAdmission` exactly as a
 * render does — never beside a render, never under BookForge's own
 * external-gpu-job.lock (`align/aligner.py` refuses cuda and mps by name while
 * that file exists, which is the second half of the same rule).
 *
 * So the resource is the CONFIG's, not this module's, the same shape
 * `queue-steps/reassembly.ts` uses. A row restored from a queue file written
 * before tonight has no `device` and is CPU, which is what it was.
 *
 * ── NOTHING COMPOSES THIS ROW ANY MORE, AND IT IS STILL HERE ────────────────
 *
 * Owen, 2026-09-08: *"remove the align the narration checkbox. lets just have it
 * permanently do it that way. if the user wants an exact alignment they can hit
 * generate sentences on the bookforge library."* The narration run's Align row
 * and the Foundry doors' unconditional one both went with that ruling — a
 * two-hour CPU align was holding a finished 16-hour book's assembly at 99 %.
 *
 * The MODULE stays, because rows do. A queue file saved before the ruling can
 * still hold an align row (one was running on Owen's PC when it landed), and the
 * CLI still queues one against a session on purpose (`cli/coverage-align.js`,
 * `bookforge-tts.py --align`). A step type the engine could not run would fail
 * every one of those by name for a reason that has nothing to do with them.
 */
import { onBridgeEvent } from '../bridge-events';
import { runCoverageAlign, stopCoverageAlign } from '../coverage-align-job';
import { getBfpCachedSession } from '../reassembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

interface AlignProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number;
    processed?: number; total?: number; message?: string; error?: string;
  };
}

interface AlignStepConfig {
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  /** The language the aligner loads its checkpoint for. See the refusal below. */
  language?: string;
  /**
   * 'cpu' (the default) or 'gpu' — the user's choice at queue time.
   *
   * OPTIONAL ON THE TYPE, and every source of a row now leaves it out or says
   * 'cpu': the run description that used to write it went with the checkbox
   * (Owen, 2026-09-08), and what is left composing align rows is the CLI. Absent
   * also means a row queued before 2026-09-07, when every align was CPU by
   * construction. Both are real answers rather than missing ones, so absent is
   * read as 'cpu' — and the row says so on the card, once, rather than quietly.
   */
  device?: 'cpu' | 'gpu';
  /** The chain's act metadata: `title` is the ACT label ("Align"); the book is `bookTitle`. */
  metadata?: { title?: string; bookTitle?: string; author?: string; year?: string };
}

export const alignStep: StepModule = {
  type: 'align',
  consumes: 'audio-session',
  /*
   * THE SAME KIND IT READ. `checkLineage` validates a child against its parent's
   * STATIC `produces`, so this is what lets a denoise, a conversion or an
   * assembly sit behind an Align exactly as it sits behind the narration itself.
   * `run` returns the input ref unchanged so the runtime half agrees with it.
   */
  produces: 'audio-session',
  /*
   * THE ROW'S OWN ANSWER, read off the config at compose time and stored on the
   * step — so a queue restored later claims the slot it was queued for. Anything
   * that is not 'gpu' is cpu, which is what makes a pre-2026-09-07 row (no
   * `device` at all) the CPU row it has always been.
   */
  resource: (config: Record<string, unknown>) => (config['device'] === 'gpu' ? 'gpu' : 'cpu'),

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = (ctx.step.config ?? {}) as unknown as AlignStepConfig;

    let sessionId = config.sessionId || ctx.input.sessionId;
    let sessionDir = config.sessionDir || ctx.input.sessionDir;
    let processDir = config.processDir || ctx.input.processDir;

    if (!sessionId || !sessionDir || !processDir) {
      // A row queued against a project rather than behind a render — the
      // cache-only shape, same as the denoise and the assembly.
      const projectDir = ctx.job.projectId;
      if (!projectDir) {
        throw new Error(
          'This alignment row names no narration session and no project, so there is nothing '
          + 'for it to check.',
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

    /*
     * NOT DEFAULTED TO 'en'. The aligner loads a per-language wav2vec2 checkpoint,
     * and one pointed at the wrong language scores every word badly — which this
     * guard reads as "the audio did not say the text" and refuses a book that was
     * read correctly. Every door that composes an align row states it — the CLI
     * demands `--align-language` and refuses without it — so an absent one is a
     * composition bug and says so.
     */
    const language = config.language;
    if (!language) {
      throw new Error(
        'This alignment row does not say which language the book was rendered in, and the '
        + 'aligner loads a different acoustic model for each. A guess here would score every '
        + 'word badly and refuse a book that was read correctly. This is a bug in the run that '
        + 'composed it.',
      );
    }

    /*
     * WHERE IT RUNS. The row was queued for a slot (`resource` above) and this
     * has to agree with that, so it reads the same field the same way. A row
     * with no `device` is one the queue has carried since before the choice
     * existed: it is CPU, and the card says so once rather than leaving an
     * operator to wonder which processor measured the book.
     */
    const device: 'cpu' | 'gpu' = config.device === 'gpu' ? 'gpu' : 'cpu';
    if (config.device === undefined) {
      ctx.report({
        percent: 0,
        message: 'Aligning on CPU — this row was queued before the processor was a choice.',
      });
    }

    const unsubscribe = onBridgeEvent<AlignProgressEvent>('coverage-align:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      ctx.report({
        percent: p.percentage,
        message: p.message,
        metrics: {
          // Chunks mapped onto the chunk fields, so the row gets the same
          // rate-based ETA every other counted step does.
          chunksCompletedInJob: p.processed,
          totalChunksInJob: p.total,
          chunksDoneInSession: p.processed,
        },
      });
    });

    try {
      const result = await runCoverageAlign(
        ctx.stepId,
        {
          processDir,
          language,
          device,
          // The BOOK's title, never the act label the row also carries.
          metadata: {
            title: config.metadata?.bookTitle,
            author: config.metadata?.author,
            year: config.metadata?.year,
          },
        },
        queueMainWindow(),
      );
      /*
       * THE ROW FAILS ONLY WHEN THE RUN COULD NOT HAPPEN — no session, no
       * aligner, a dead worker. A pass that measured every chunk and doubted
       * fourteen of them did its job; failing on that skipped the assembly and
       * left an operator with 36 minutes of good audio and no audiobook, which
       * is the thing Owen's 2026-09-05 ruling forbids.
       */
      if (!result.success) {
        throw new Error(result.error || 'The alignment failed and gave no reason.');
      }
      /*
       * WHAT IT FOUND, SAID ONCE ON THE ROW. The card's live message is the
       * bar's; this is the sentence that stays after the row completes, and it
       * is the same sentence the assembly repeats on the finished book.
       */
      const retake = result.retakeIndices ?? [];
      const summary = `${result.chunksAligned ?? 0} aligned, ${result.chunksFailed ?? 0} failed `
        + `coverage, ${result.chunksErrored ?? 0} could not be placed`
        + (retake.length > 0 ? ` — retake: ${retake.join(',')}` : '');
      ctx.report({ percent: 100, message: summary });
      /*
       * THE PARENT'S ARTIFACT, PASSED THROUGH — this step changes no audio.
       *
       * Spread from `ctx.input` so nothing a producer declared is dropped on the
       * way past (the narration's `detail` carries its project dir, its language
       * and whether it skipped assembly), and then OVERWRITTEN with the session
       * identity this step resolved: `tts-conversion` returns no `processDir`,
       * and the steps behind this one would otherwise each re-resolve it from the
       * project's cache. What this row adds of its own is the report it wrote,
       * which nothing reads today and is the one fact about this step worth
       * carrying if anything ever does.
       */
      return {
        ...ctx.input,
        kind: 'audio-session',
        sessionId,
        sessionDir,
        processDir,
        detail: {
          ...(ctx.input.detail ?? {}),
          coverageReport: result.reportPath,
          chunksAligned: result.chunksAligned,
          chunksFailedCoverage: result.chunksFailed,
          chunksNotPlaced: result.chunksErrored,
          retakeIndices: retake,
        },
      };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    stopCoverageAlign(stepId);
  },
};

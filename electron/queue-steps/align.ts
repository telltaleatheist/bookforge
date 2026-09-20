/**
 * align — force-align the rendered chunks and write the coverage report.
 *
 * The row that measures the render. Higgs v3 has no duration guard worth the
 * name — a chunk scored a duration ratio of 0.99 while dropping 22 % of its
 * text — so without this nobody knows which chunks came out wrong.
 *
 * IT REPORTS AND SUCCEEDS — about the BOOK. Owen, 2026-09-05: an imperfect
 * render is the nature of TTS and must not stop an assembly. So a pass that
 * found fourteen doubtful chunks and five it could not place is a SUCCESSFUL
 * row that says so — counts and retake list on the card and in the artifact
 * detail — and the assembly runs behind it.
 *
 * IT FAILS — and STOPS THE BOOK — about ITSELF. Owen, 2026-09-19: *"If
 * alignment fails it should stop. But we need to fix it so it doesn't fail. It
 * should only fail because of a misconfiguration, which can be repaired."* The
 * two halves are not in tension: what the chunks said is a measurement, and a
 * run that could not happen is a broken machine. Until this row existed the
 * second one was swallowed — the alignment was a phase inside the render
 * (`parallel-tts-bridge.runPostRenderAlignment`), it announced its own failure
 * and the book was sealed with the proportional ESTIMATE, so an operator
 * learned that the aligner had been misconfigured for a month by reading a log.
 * Now the row lands in *Needs you* with the reason on it and the assembly waits
 * behind it, which is the one arrangement in which the reason gets read.
 *
 * ── EVERY FAILURE NAMES SOMETHING A PERSON CAN REPAIR ──────────────────────
 *
 * The session is not on disk; the row says no language; the server would not
 * take the job; the server has no aligner; the chunks are marker-only; the
 * chapter gap is not a number the assembler can realize; this machine could not
 * measure the book from the items the server placed. Each is a sentence naming
 * the thing. There is NO "skipped" outcome left: the dead gate that refused the
 * whole pass unless THIS machine had a local `qwen-align` conda env — while the
 * model ran on a server — went with the phase (finding B2).
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
 * ── IT IS COMPOSED AGAIN, AND THE ROW IT IS IS NOT THE ROW THAT WENT ───────
 *
 * Owen, 2026-09-08: *"remove the align the narration checkbox. lets just have it
 * permanently do it that way. if the user wants an exact alignment they can hit
 * generate sentences on the bookforge library."* The narration run's Align row
 * and the Foundry doors' unconditional one both went with that ruling — a
 * two-hour CPU align was holding a finished 16-hour book's assembly at 99 %.
 * The MODULE stayed, because rows do: a saved queue file could still hold one,
 * and the CLI queues one on purpose (`cli/coverage-align.js`).
 *
 * What came back later the same day was the ALIGNMENT, on a different backend:
 * *"good. go ahead and wire it up to alignment so itll be used to align the
 * chunks in app"* — qwen3, 151 s for a 16.5 h book against the two hours that
 * killed the checkbox. It was built as the final PHASE of the `tts-conversion`
 * step, and that is what was wrong with it.
 *
 * Owen, 2026-09-19: alignment *"is its own queue step"*, and *"as soon as the
 * GPU finishes, it releases the lease"*. So `shared/queue/narration-run.ts`
 * composes THIS ROW directly behind the render again — not the deleted
 * checkbox, which was a user choice about a two-hour CPU pass, but the
 * alignment that has been happening on every render since 2026-09-08 anyway,
 * given the row, the bar, the Stop and the failure it always deserved.
 * `runCoverageAlign` is the single door behind this and the CLI both.
 */
import { onBridgeEvent } from '../bridge-events';
import { runCoverageAlign, stopCoverageAlign } from '../coverage-align-job';
import { getBfpCachedSession } from '../reassembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { projectDirForStep, queueMainWindow, stepFailure } from './runtime';
import {
  RETIRED_LOCAL_NARRATOR_VENUE, WAIT_FOR_ANY, retiredVenueReason,
} from '../../shared/queue/wait-for';
import {
} from '../crucible/align';
import { runVenueOfRow } from '../crucible/step-venue';

interface AlignProgressEvent {
  jobId: string;
  progress: {
    phase: string; percentage: number;
    processed?: number; total?: number; message?: string; error?: string;
  };
}

interface AlignStepConfig {
  /**
   * THE PROJECT THIS ROW IS ABOUT — `bfpPath` for a BOOK, `projectDir` for an
   * ARTICLE, exactly one of them set. The pair and the reason are declared once
   * in `shared/queue/narration-run.ts` (§ NarrationStepPlan), and every row of a
   * narration plan carries one; read through `projectDirForStep`, never here.
   */
  bfpPath?: string;
  projectDir?: string;
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  /** The language the aligner loads its checkpoint for. See the refusal below. */
  language?: string;
  /**
   * 'cpu' (the default) or 'gpu' — the user's choice at queue time.
   *
   * OPTIONAL ON THE TYPE. A row composed by a narration run says 'gpu' since
   * 2026-09-19: the alignment is a Crucible `align` job and a Crucible has only
   * the card, so `runCoverageAlignOnCrucible` refuses a CPU row by name. The
   * headless door says 'gpu' too since later that day (`cli/coverage-align.js`
   * — it queued 'cpu' from the local-spawn era and therefore could not run at
   * all). Absent means a row queued before 2026-09-07, when every align was CPU
   * by construction: a real answer rather than a missing one, so absent is read
   * as 'cpu' — and the row says so on the card, once, rather than quietly.
   */
  device?: 'cpu' | 'gpu';
  /** The chain's act metadata: `title` is the ACT label ("Align"); the book is `bookTitle`. */
  metadata?: { title?: string; bookTitle?: string; author?: string; year?: string };
  /**
   * The gap the ASSEMBLY of this session will leave between chapters, so the
   * transcript this row measures is measured on the assembly's ruler.
   *
   * ABSENT IS NOT ZERO — it means the run that composed this row did not choose,
   * and `resolveChapterGap` (shared/audio/chapter-gap.ts) answers with
   * `DEFAULT_CHAPTER_GAP`, which is what the assembly doors do with an unstated
   * gap too. Nothing composes this field today (the narration run stopped
   * composing align rows on 2026-09-08; what is left is the CLI and a restored
   * queue file), so it is threaded rather than invented: a row that states a gap
   * is aligned for it, and a row that states none is aligned for the default the
   * assembly behind it will use.
   */
  chapterGap?: number;
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
  /**
   * IT TRAVELS, AND IT REFUSES WHEN IT GETS THERE (crucible
   * `docs/PHASE7-LANES.md` §4, §4.4).
   *
   * Alignment is a Crucible `align` job and `electron/crucible/align.ts` is
   * built to its seam, so this row must FOLLOW its book: the incident this
   * exists to prevent is the one at 00:50 on 2026-09-14, when a post-render
   * alignment decided its own venue, read the top-ranked server, and loaded the
   * aligner on a card a fine-tune owned. Declaring `local` would leave that
   * re-decision in place; declaring `any` puts the row under the run's venue
   * and under `local`'s slot set.
   *
   * It then refuses by name, because a remote alignment CANNOT FINISH: narrator
   * has no items-in door (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §0b B5), so the
   * server would make the model's items and nothing could turn them into
   * coverage.json and the VTT. The refusal is in `run`, before anything is
   * submitted, and it names the legacy switch as what aligns today. A "maybe"
   * — quietly aligning here while the book is on the Mac — is the thing §4.4
   * and R3 both forbid.
   */
  machines: (): 'local' | 'any' => 'any',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = (ctx.step.config ?? {}) as unknown as AlignStepConfig;

    /*
     * THE RUN'S VENUE DECIDES WHETHER THIS ROW CAN RUN AT ALL, and it is asked
     * FIRST — before the session is resolved, before the language is checked,
     * and long before a card is touched. See `machines()` above and
     * `narratorDoorOwedBeforeSubmit`.
     *
     * `any` is not a server: it means the queue had no assignment to make
     * because nothing travelled, and the local path below is what a standalone
     * CLI align has always taken.
     */
    const assigned = ctx.job.waitForResolved;
    if (assigned === RETIRED_LOCAL_NARRATOR_VENUE) {
      throw new Error(`legacy_venue_retired: ${retiredVenueReason()}`);
    }
    /*
     * A SERVER ASSIGNMENT USED TO BE REFUSED HERE, and is not any more
     * (2026-09-18). The refusal was honest while it stood: narrator had no door
     * that took precomputed items, so a remote run would have spent GPU minutes
     * producing an artifact nothing could read, and R3 forbids telling anybody
     * "maybe". The door exists now — `narrator align --alignment` — so a routed
     * row runs the model on the server and MEASURES THE BOOK HERE from what it
     * placed (`runCoverageAlignOnCrucible`, electron/coverage-align-job.ts).
     *
     * Nothing replaces the check, because there is nothing left to check: the
     * venue decision belongs to `runCoverageAlign`, which reads it from the
     * run's own record and refuses a disagreement by name. A second gate here
     * would be this step forming an opinion about a decision it does not own.
     */

    let sessionId = config.sessionId || ctx.input.sessionId;
    let sessionDir = config.sessionDir || ctx.input.sessionDir;
    let processDir = config.processDir || ctx.input.processDir;

    if (!sessionId || !sessionDir || !processDir) {
      // A row queued against a project rather than behind a render — the
      // cache-only shape, same as the denoise and the assembly, and WHICH
      // project is their shared rule (`projectDirForStep`, after the
      // 2026-09-12 Starcraft incident).
      const projectDir = projectDirForStep(ctx, config);
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
      /*
       * THE RUN'S VENUE, NOT A NEW DECISION. `waitForResolved` is the server the
       * queue admitted this run to — the one its render went to — or the legacy
       * marker; a step follows it (PHASE7-LANES.md §4.4, one book = one GPU).
       * Absent (a standalone row, or a job whose steps do not travel), the job
       * reads the session's own record and only then decides.
       */
      const runVenue = runVenueOfRow(ctx.job.waitForResolved);
      const result = await runCoverageAlign(
        ctx.stepId,
        {
          processDir,
          language,
          device,
          ...(runVenue === undefined ? {} : { runVenue }),
          // The assembly's ruler, passed through rather than defaulted here —
          // see the field's own note. Absent resolves to the house gap inside
          // the job, which is what the assembly behind this row will use.
          chapterGap: config.chapterGap,
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
       *
       * AND WHEN IT DOES FAIL, THE BOOK STOPS (Owen, 2026-09-19): the row lands
       * in *Needs you* with the reason on it and the assembly waits behind it,
       * because every one of those reasons names a misconfiguration somebody
       * can repair and then press Retry on. The rendered audio is intact
       * through all of them — every refusal below says so — so nothing is lost
       * by stopping, and the alternative (the estimate, silently) is how a
       * broken aligner went a month unnoticed.
       */
      if (!result.success) {
        // A Crucible `server_busy` or `leased`: the row goes back to `queued`
        // carrying the holder's own line and is tried again on the admission
        // tick. A wait, never a failure — and since 2026-09-19 (A5) it travels
        // on the throw, so this module makes no side call into the engine.
        throw stepFailure(
          result.error || 'The alignment failed and gave no reason.', result.busyLine,
          result.transient === true ? (result.transientLine ?? result.error) : undefined);
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
          // WHICH MACHINE measured the book — recorded on the row the way a
          // render's saved state records its server.
          alignVenue: result.venue?.where === 'crucible' ? `crucible:${result.venue.server}` : result.venue?.where,
          alignVenueOrigin: result.venue?.origin,
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

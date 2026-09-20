/**
 * prepare — pack the book into generation chunks, on this machine's CPU, before
 * any card is asked for.
 *
 * ── The ruling (Owen, 2026-09-19) ──────────────────────────────────────────
 *
 * *"Prepare can be its own CPU step… we could start the CPU prep the moment a
 * free CPU slot is open and an item enters the active (and unpaused) queue."*
 *
 * It was the first minutes of `tts-conversion` until that evening, and both of
 * its costs were real:
 *
 *  - A GPU SLOT HELD FOR CPU WORK. Extracting an EPUB, cutting the narration
 *    copy, splitting it and packing it into chunks touches no card at all, and
 *    on a long book it is minutes of the single GPU lane spent on none of the
 *    work that lane exists for.
 *  - A PREP PAID TWICE. `startParallelConversion` ran the whole prep and THEN
 *    submitted; a server answering `409 server_busy` sent the row back to
 *    `queued` with a brand-new scratch session on disk that the next attempt
 *    did not match (`prepareSession` mints a fresh `crypto.randomUUID()` per
 *    call), so the next launch packed the book again (bug hunt 2026-09-19,
 *    finding A2).
 *
 * ── It travels nowhere, and that is the whole scheduling property ──────────
 *
 * `machines()` is ABSENT, so the module's default stands: this step is local
 * work. The pump therefore never asks `crucibleAdmission` for it — a `cpu` step
 * takes a `local-work` slot the moment one is free and its parent is done, with
 * no venue decided, no lease reserved and no server polled. Nothing special
 * makes that happen; it is what the pump already does with a non-GPU step, and
 * `tools/test-queue-narration-plan.js` pins it so a future change to the pump
 * cannot quietly take it away.
 *
 * ── The one thing it DOES ask a server, and it WAITS for the answer ────────
 *
 * The chunk boundaries are the rendering machine's numbers — `max_chars` and
 * the pace block off `GET /v1/voices`, never this machine's catalog
 * (`electron/crucible/voice-band.ts`). So the prep door reads a band off a
 * server before it packs anything. A busy server answers in milliseconds, so
 * this is not waiting for a free card — but a server that is asleep or switched
 * off answers nothing, and until 2026-09-19 that FAILED the row. Owen: a book
 * *"would just sit there in the queue until it's free"*, and *"it should only
 * fail because of a misconfiguration, which can be repaired."* So this row PARKS
 * on availability and fails only on something a person repairs; the line between
 * the two is `electron/crucible/prep-band.ts`.
 *
 * WHICH server's is {@link assignedServerOf}'s half of that rule: the card this
 * book already holds, the server its row named, or — for a row bound to nothing
 * — the tightest band among the enabled machines. Whichever it was is recorded
 * on the session and travels to the render, which refuses by name if it is
 * admitted somewhere with a tighter ceiling
 * (`parallel-tts-bridge.packingTravelsTo`).
 *
 * ── A PARKED CPU ROW IS RE-ADMITTED AT ONCE, so the cool-off is HERE ───────
 *
 * Measured while building this (2026-09-19): `settleStep` parks a step by
 * putting it back to `queued` and calling `pump()` in the same breath, and the
 * pump's CPU branch asks NOTHING about admission — `busyHolds`, the cool-off
 * that keeps a GPU row off a server it just met a 409 on, is read by
 * `decideWaitFor`, which is only asked for a travelling step, and
 * `admissionBlocked`/`admissionRecheckTimer` are only armed there too. So a
 * parked prepare row relaunches on the very next tick, and a park that cost
 * nothing (every server switched off refuses before a socket is opened) would
 * spin the main process flat out, firing a renderer update per turn.
 *
 * The cadence therefore lives where the asking does: this module remembers when
 * this step last parked and waits out the remainder of {@link PARK_RECHECK_MS}
 * before it asks again. The row holds its `local-work` slot while it waits,
 * which is the honest cost of not touching the engine for it — and it is a slot
 * held by a book that genuinely cannot proceed, not one stolen from a book that
 * can.
 */
import { onBridgeEvent } from '../bridge-events';
import {
  prepareNarrationSession,
  setMainWindow,
  detectRecommendedWorkerCount,
} from '../parallel-tts-bridge';
import { beginPrepare, cancelPrepare, waitUnlessStopped } from '../prep-handles';
import { runVenueOfRow } from '../crucible/step-venue';
import type { PrepAssignedServer } from '../crucible/prep-band';
import type { StepModule, StepRunContext, StepReport } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { projectDirForStep, queueMainWindow, stepFailure } from './runtime';

/**
 * How long a parked prepare row waits before it asks the servers again.
 *
 * The engine's own admission cadence (`queue-engine.ts`, `admissionRecheckMs`,
 * 15 s) written down a second time, and the duplication is deliberate: that one
 * is not applied to a CPU step at all (see the header), so this is not a copy of
 * a value being used — it is the same CHOICE of cadence, made where it is
 * actually enforced. If the engine ever gates CPU parks, this goes.
 */
const PARK_RECHECK_MS = 15_000;

/**
 * When each prepare step last parked and what it said, by STEP id — two books
 * waiting on the same absent machine are two rows, each on its own clock.
 *
 * THE SENTENCE IS KEPT HERE BECAUSE THE ROW CANNOT KEEP IT. `settleStep` writes
 * the park sentence into `progress.admissionHold`, and `launch` — which the
 * park's own `pump()` reaches on the very next turn for a CPU step — resets
 * `step.progress` to `{ percent: 0 }`. So the hold is a state the queue passes
 * THROUGH rather than one it rests in, and an operator watching a prepare row
 * that is not moving would see nothing at all. This row reports the line back
 * while it waits out the cool-off, which is where it spends almost all of its
 * time.
 */
const parkedAt = new Map<string, { readonly at: number; readonly line: string }>();

/** The bridge's prep frames, as they arrive on the bus. */
interface PrepProgressEvent {
  jobId: string;
  progress: Record<string, unknown>;
}

interface PrepareConfig {
  language: string;
  ttsEngine: string;
  fineTuned: string;
  speed: number;
  enableTextSplitting: boolean;
  parallelMode?: 'sentences' | 'chapters';
  /**
   * WHETHER THE NARRATION TEXT CLEANUP IS REQUIRED OF THIS RUN. Not defaulted
   * — the door refuses a run that does not say, because the two answers are two
   * different things to write in the log about an hour of GPU, and it is PREP
   * that cuts the copy the answer decides the shape of.
   */
  textCleanup?: 'required' | 'skipped';
  /** "Start fresh" over "Continue": the ONE answer that may delete a checkpoint. */
  startFresh?: boolean;
  sentencePerParagraph?: boolean;
  skipHeadings?: boolean;
  testMode?: boolean;
  testSentences?: number;
  /**
   * THE PROJECT THIS ROW IS ABOUT — `bfpPath` for a BOOK, `projectDir` for an
   * ARTICLE, exactly one set. Read through `projectDirForStep`, never here.
   */
  bfpPath?: string;
  projectDir?: string;
  isArticle?: boolean;
}

/**
 * THE MACHINE THIS BOOK IS ALREADY BOUND TO, read off the row — or `undefined`
 * for a book that is free to run anywhere.
 *
 * ── The bug (measured 2026-09-19) ──────────────────────────────────────────
 *
 * A row whose foundry step resolved the job's venue to one machine held THAT
 * card for the rest of the chain (ruling 9: a book is atomic on the card,
 * `shared/queue/slot-sets.ts`). Prepare packed it for a DIFFERENT one — because
 * it asked the venue DECISION, whose rule is "the first enabled server that
 * answers, in rank order", a rule about work that has not been placed yet. The
 * render then ran on the held card against chunks cut to the other machine's
 * band: an over-cap refusal on one book that night, and on another the quiet
 * version — a whole book rendered in chunks half the size the card would have
 * taken.
 *
 * So the ROW is asked, not the decision:
 *
 *  - `waitForResolved` names the card this book HOLDS. It is taken with no
 *    reachability poll and no thought about whether the server is busy: the book
 *    holds this card, and a 409 from its own server during the hold is the
 *    hold's own tail rule.
 *  - `waitFor` names the server the OPERATOR chose, for a row not yet admitted
 *    anywhere. Naming a machine means waiting for it.
 *  - `any` with no card held is `undefined`, and `crucible/prep-band.ts` packs
 *    to the TIGHTEST enabled band so the chunks fit whichever machine the pump
 *    later admits the render to.
 *
 * `runVenueOfRow` is the one reader of those two fields
 * (`crucible/step-venue.ts`): it answers `undefined` for `any` and REFUSES BY
 * NAME for a row assigned to the deleted local narrator, which is the answer
 * every other step gives such a row rather than re-deciding it.
 *
 * Nothing here WRITES a venue. Admission is the pump's (ruling 7) and a 409
 * releases it; a prep that pinned an `any` book to the machine it packed for
 * would be a second scheduler with less information than the first.
 */
function assignedServerOf(ctx: StepRunContext): PrepAssignedServer | undefined {
  const held = runVenueOfRow(ctx.job.waitForResolved);
  if (held !== undefined) return { server: held.server, because: 'the card this book holds' };
  const named = runVenueOfRow(ctx.job.waitFor);
  if (named !== undefined) return { server: named.server, because: 'the server this row named' };
  return undefined;
}

export const prepareStep: StepModule = {
  type: 'prepare',
  consumes: 'epub',
  produces: 'prepared-session',
  /*
   * CPU, unconditionally. There is no config that makes packing a book GPU
   * work, so this is a literal rather than a question — which is the difference
   * between this and `align.ts`, where the row genuinely carries the answer.
   */
  resource: () => 'cpu',
  /*
   * NO `machines()`, AND ITS ABSENCE IS THE STATEMENT — see the header. The
   * default is `local`, the pump admits a local CPU step with no venue decided,
   * and that is precisely what makes this row start "the moment a free CPU slot
   * is open".
   */

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = (ctx.step.config ?? {}) as unknown as PrepareConfig;
    const packFor = assignedServerOf(ctx);
    setMainWindow(queueMainWindow());

    const epubPath = ctx.input.path;
    if (!epubPath) {
      throw new Error('There is no book to prepare: this row was pointed at nothing.');
    }
    const projectDir = projectDirForStep(ctx, config) ?? '';

    /*
     * The worker count is not a fact about the prep — it packs the same chunks
     * however many workers read them — but `ParallelConversionConfig` requires
     * one, and a zero there would reach the render's own resolution as a number
     * somebody chose. The recommendation is what an unstated count has always
     * meant.
     */
    const conversionConfig = {
      workerCount: detectRecommendedWorkerCount().count,
      epubPath,
      outputDir: '',
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
      },
      // Carried, never invented: absent reaches the door as absent and is
      // refused by name rather than read as either answer.
      textCleanup: config.textCleanup,
      /*
       * WHOSE BAND THIS BOOK IS PACKED TO, when the row has already settled it
       * — see {@link assignedServerOf}. Spread rather than sent as `undefined`,
       * because absent means "this book is free to run anywhere" and the packer
       * answers that case by taking the TIGHTEST enabled band; a field that
       * carried `undefined` as an answer would be a third state nobody reads.
       */
      ...(packFor === undefined ? {} : { packFor }),
      bfpPath: projectDir || undefined,
      isArticle: config.isArticle,
      /*
       * "Start fresh" deletes this book's scratch checkpoints, and it is the
       * ONE submission that may. It belongs to PREP because deleting them is
       * what makes the pack that follows a fresh one; the render behind this
       * row finds exactly the session this row wrote.
       */
      cleanSession: config.startFresh === true,
      // Prep never assembles. Stated so the stage bars it emits are the
      // chained shape the render row's bars continue.
      skipAssembly: true,
    };

    const unsubscribe = onBridgeEvent<PrepProgressEvent>('parallel-tts:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      const p = event.progress;
      /*
       * THE BRIDGE'S `stages` ARE NOT FORWARDED, and that is the one thing
       * worth saying about this listener.
       *
       * `emitPrepStageProgress` builds the whole RENDER's stage list —
       * "Preparing book", "Loading voice model", "Converting sentences",
       * "Assembling audiobook" — because it was written for a step that does
       * all four. This row does the first one and stops, so three of those bars
       * would sit at 0 % under a row that is never going to reach them. One
       * act, one bar.
       *
       * `prep` DOES ride, because it is this act's own sub-bar (the narration
       * number normalization counts paragraphs), and it is replaced rather than
       * kept — a landed sub-bar must not sit full under a line that has moved
       * on, the same discipline the render row's bars use.
       */
      const report: StepReport = {
        percent: typeof p['percentage'] === 'number' ? (p['percentage'] as number) : undefined,
        message: (p['message'] as string | undefined) ?? 'Preparing the book…',
        prep: (p['prep'] as never) ?? null,
      };
      ctx.report(report);
    });

    /*
     * OPENED HERE, not by the bridge, because the cool-off above is part of
     * this row's life and a Stop pressed during it has no process to kill —
     * only this handle to break. The bridge's own `beginPrepare` takes a second
     * reference on the same entry and both are released, so the registry is
     * empty again the moment this step settles (`electron/prep-handles.ts`).
     */
    const handle = beginPrepare(ctx.stepId);
    try {
      const parked = parkedAt.get(ctx.stepId);
      if (parked !== undefined) {
        const left = PARK_RECHECK_MS - (Date.now() - parked.at);
        if (left > 0) {
          ctx.report({
            percent: 0,
            message: `Waiting for a machine to answer — ${parked.line}`,
          });
          await waitUnlessStopped(handle, left, 'while it was waiting to ask again');
        }
      }
      const result = await prepareNarrationSession(ctx.stepId, conversionConfig as never);
      if (!result.success || !result.prepared) {
        // A refusal that named a holder is a WAIT, not a failure — the same one
        // road every module's refusal takes since 2026-09-19 (A5). For this row
        // the holder may be nobody at all: a band no enabled server would state
        // is availability, and the sentence names every machine that was asked
        // and every one that is switched off (`crucible/prep-band.ts`).
        if (result.busyLine === undefined) {
          // A real failure ends the row; nothing is waiting, so nothing is
          // remembered about waiting.
          parkedAt.delete(ctx.stepId);
        } else {
          parkedAt.set(ctx.stepId, { at: Date.now(), line: result.busyLine });
        }
        throw stepFailure(
          result.error || 'The book could not be prepared and no reason was given.',
          result.busyLine);
      }
      parkedAt.delete(ctx.stepId);
      const prepared = result.prepared;
      /*
       * WHAT THIS RUN KEPT OF THE LAST ONE, said on the row.
       *
       * The prep seeds the session it just packed with the chunks the project's
       * part-finished render already holds, unless the user chose "Start over"
       * or the pack no longer matches
       * (`electron/render-carryover.ts` for the rule). Either answer is a
       * sentence and both belong here: Owen pressed Continue on 2026-09-20 and
       * watched a book start from the beginning with nothing anywhere saying
       * why, and a refusal that names what changed — the voice, the language,
       * the chunk count, the text — is the difference between a bug and a fact.
       */
      const carryOver = result.carryOver;
      ctx.report({
        percent: 100,
        message: `${prepared.totalSentences} chunk(s) in ${prepared.totalChapters} chapter(s)`
          + (prepared.packedFor === undefined
            ? ''
            : ` — packed to ${prepared.packedFor.ceilingChars} characters, `
              + `crucible "${prepared.packedFor.server}"'s number for this voice`
              // WHY that machine: the card the book holds, the server its row
              // named, or the tightest of the enabled ones.
              + `${prepared.packedFor.because === undefined
                ? '' : ` — ${prepared.packedFor.because}`}`)
          + (carryOver === undefined ? '' : ` — ${carryOver.line}`),
      });
      return {
        kind: 'prepared-session',
        // The chunk texts, which is what the render reads. Named by the session
        // the prep wrote, never guessed from a project.
        path: prepared.processDir,
        sessionId: prepared.sessionId,
        sessionDir: prepared.sessionDir,
        processDir: prepared.processDir,
        detail: {
          projectDir,
          language: config.language,
          /*
           * THE DOCUMENT THAT WAS ACTUALLY PACKED — the narration copy when one
           * was cut, never the book the row names. Every resume match, the
           * clean-session sweep and the persisted state key on this path, so
           * the render has to be handed the same one.
           */
          epubPath: prepared.epubPath,
          totalSentences: prepared.totalSentences,
          totalChapters: prepared.totalChapters,
          ...(prepared.packedFor === undefined ? {} : {
            packedForServer: prepared.packedFor.server,
            packedCeilingChars: prepared.packedFor.ceilingChars,
            /*
             * WHY THAT MACHINE'S NUMBERS — provenance, beside the numbers. The
             * render reads the other two (`packingTravelsTo`); this one is for
             * the person asking six weeks later why a book is in 700-character
             * chunks, and the three answers are three different bugs.
             */
            ...(prepared.packedFor.because === undefined
              ? {} : { packedForBecause: prepared.packedFor.because }),
          }),
        },
      };
    } finally {
      handle.release();
      unsubscribe();
    }
  },

  /**
   * STOP THE PACK, AND TAKE THE HALF-WRITTEN SESSION WITH IT (2026-09-19).
   *
   * This was deliberately EMPTY until tonight, and it said so: `prepareSession`
   * spawned narrator's prep and registered the spawn nowhere a stop could reach
   * — `activeSessions` is written by the RENDER door, after prep has returned —
   * so `stopParallelConversion` answered `false` for the whole of prep. The
   * engine aborted the step, the row stopped waiting, and the python ran on,
   * writing into a scratch session nothing would ever read.
   *
   * `electron/prep-handles.ts` is the handle the render's `crucibleCancel`
   * already had: keyed by THIS STEP'S id (which is the `jobId` the bridge is
   * given), it holds how to kill the spawn — a process tree here, a guest
   * process and its wsl.exe wrapper over there — and the session directory the
   * prep is writing.
   *
   * IT WAITS FOR THE PROCESS AND THEN DELETES THE DIRECTORY, in that order,
   * because `session-state.json` is exactly what a resume and the clean-session
   * sweep read a session back from: a prep killed half-way must not leave one
   * behind for a later run to mistake for a session that was packed. If the
   * removal fails it is named in the log rather than left to be discovered.
   *
   * The step then settles `cancelled` — this module declares no
   * `stopIsResumable`, and it must not: there is nothing left on disk to resume
   * from, which is the whole point of the paragraph above.
   */
  async cancel(stepId: string): Promise<void> {
    parkedAt.delete(stepId);
    await cancelPrepare(stepId);
  },
};

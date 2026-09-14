/**
 * A LATER STEP OF A RUN FOLLOWS THE RUN — it does not decide again.
 *
 * Its own module, beside `generation-venue.ts` rather than inside it, on
 * purpose: that file has exactly ONE producer of the legacy venue (the switch)
 * and `tools/test-crucible-render.js` counts it, because a second producer
 * there would be a second fallback. Nothing here PRODUCES a venue — it carries
 * the run's answer through, or asks the one decision for one.
 */

import {
  CrucibleVenueError,
  decideWhereGenerationRuns,
  type VenueHost,
} from './generation-venue';
import { LEGACY_LOCAL_NARRATOR, WAIT_FOR_ANY } from '../../shared/queue/wait-for';

/**
 * The venue a run has ALREADY been given: the server its render went to
 * (`settings.crucible.server`, persisted into the session's
 * `session_state.json` by `decideAndRememberVenue`; the queue row's
 * `waitForResolved`), or the legacy local narrator.
 */
export type RunVenue =
  | { where: 'crucible'; server: string }
  | { where: 'legacy-local-narrator' };

/**
 * Where one step of a run runs, and whether that was the run's answer or one
 * made here. `origin` is what a log line has to say: "the run's venue" and
 * "decided here" are different news, and only one of them is a bug when the
 * step lands on the wrong card.
 */
export type StepVenue =
  | { where: 'crucible'; server: string; origin: 'the run' | 'decided here'; because: string }
  | { where: 'legacy-local-narrator'; origin: 'the run' | 'decided here'; because: string };

/**
 * DO TWO RECORDS OF ONE RUN'S VENUE AGREE?
 *
 * A step behind a render can learn its machine twice — from the session's own
 * `session_state.json` (where the render went) and from the queue row's
 * `waitForResolved` (where the queue assigned the run). They are the same fact
 * with two owners, and the rule for that is R1's: compare, never rank. Every
 * caller refuses by name on a disagreement rather than picking one.
 */
export function sameRunVenue(a: RunVenue, b: RunVenue): boolean {
  if (a.where !== b.where) return false;
  return a.where === 'crucible' && b.where === 'crucible' ? a.server === b.server : true;
}

/** How a venue reads in a refusal. One spelling, so two jobs cannot differ. */
export function describeRunVenue(v: RunVenue): string {
  return v.where === 'crucible' ? `crucible "${v.server}"` : 'the legacy local narrator';
}

/**
 * THE ROW'S ANSWER AS A `RunVenue` — one owner for a conversion five step
 * modules were each doing inline.
 *
 * `QueueJob.waitForResolved` is a string with three shapes and each means
 * something different, which is exactly the kind of fact that drifts when it is
 * spelled in five files (crucible `docs/ARCHITECTURE.md` R1):
 *
 *  - a SERVER's name — the machine the queue admitted this run to;
 *  - {@link LEGACY_LOCAL_NARRATOR} — the dated local spawn;
 *  - `any`, or absent — the run was never assigned, because nothing in it
 *    travelled or it has not been admitted yet. `undefined` then, so
 *    {@link venueForRunStep} decides rather than being handed a non-answer.
 *
 * `any` is NOT a venue and must never reach `venueForRunStep` as one: it is the
 * row saying it does not mind, and the decision is still to be made.
 */
export function runVenueOfRow(waitForResolved: string | undefined): RunVenue | undefined {
  if (waitForResolved === undefined || waitForResolved === WAIT_FOR_ANY) return undefined;
  if (waitForResolved === LEGACY_LOCAL_NARRATOR) return { where: 'legacy-local-narrator' };
  return { where: 'crucible', server: waitForResolved };
}

/**
 * The venue for a step that comes AFTER a run's generation — align, asr, and
 * whatever follows.
 *
 * ── The rule (2026-09-14, from a live CLI render) ──────────────────────────
 *
 * A render sent to `mac` with `--crucible-server mac` was followed by its
 * post-render alignment deciding its own venue — top-ranked → `local` — and
 * loading the aligner on the PC's card, which somebody else owned. So:
 *
 * **A run's later GPU steps take the run's ALREADY-RESOLVED venue** — the
 * server the render went to — and re-decide ONLY when the run has no resolved
 * venue yet (a standalone Generate-sentences press, an align row on a session
 * rendered before venues were recorded). PHASE7-LANES.md §4.4: one book = one
 * GPU; §4.3: a job that started on a machine finishes on that machine. A
 * caller-named `--crucible-server mac` therefore carries every step to `mac`.
 *
 * `runVenue` is that answer when the caller has it; `runVenueSource` names
 * where it was read from, for the log. `callerNamed` is the caller's own
 * instruction (the CLI's `--crucible-server`), which may only AGREE with a run
 * venue: two answers for one run is the defect this exists to refuse, not a
 * precedence to invent.
 */
export async function venueForRunStep(options: {
  runVenue?: RunVenue;
  runVenueSource?: string;
  callerNamed?: { server: string };
  host: VenueHost;
}): Promise<StepVenue> {
  const { runVenue, callerNamed } = options;
  if (runVenue !== undefined) {
    const source = options.runVenueSource ?? 'the run';
    if (callerNamed !== undefined) {
      const named = callerNamed.server.trim();
      const runs = runVenue.where === 'crucible' ? `crucible "${runVenue.server}"` : 'the legacy local narrator';
      if (runVenue.where !== 'crucible' || runVenue.server !== named) {
        throw new CrucibleVenueError(
          'run_venue_disagrees',
          `this step was told to run on crucible "${named}", but its run already went to ${runs} `
          + `(${source}). One book, one GPU (PHASE7-LANES.md §4.4): a step follows its run, and two `
          + 'answers for one run are refused rather than ranked.',
        );
      }
    }
    return runVenue.where === 'crucible'
      ? { where: 'crucible', server: runVenue.server, origin: 'the run', because: `the run's venue (${source})` }
      : { where: 'legacy-local-narrator', origin: 'the run', because: `the run's venue (${source})` };
  }
  const decided = await decideWhereGenerationRuns(
    callerNamed === undefined ? undefined : { crucible: callerNamed },
    options.host,
  );
  return { ...decided, origin: 'decided here' };
}

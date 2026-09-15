/**
 * A LATER STEP OF A RUN FOLLOWS THE RUN — it does not decide again.
 *
 * Its own module, beside `generation-venue.ts` rather than inside it, on
 * purpose: nothing here PRODUCES a venue — it carries the run's answer through,
 * or asks the one decision for one. `generation-venue.ts` is the only thing that
 * decides, and it has exactly one answer to give (a Crucible server); the legacy
 * local narrator that used to be the other one is deleted
 * (docs/LEGACY-REMOVAL.md).
 */

import {
  CrucibleVenueError,
  decideWhereGenerationRuns,
  type VenueHost,
} from './generation-venue';
import {
  RETIRED_LOCAL_NARRATOR_VENUE, WAIT_FOR_ANY, retiredVenueReason,
} from '../../shared/queue/wait-for';

/**
 * The venue a run has ALREADY been given: the server its render went to
 * (`settings.crucible.server`, persisted into the session's
 * `session_state.json` by `decideAndRememberVenue`; the queue row's
 * `waitForResolved`).
 *
 * ONE MEMBER. A run went to a machine, or it has no venue yet — there is no
 * third state now that the legacy local narrator is deleted.
 */
export type RunVenue = { where: 'crucible'; server: string };

/**
 * Where one step of a run runs, and whether that was the run's answer or one
 * made here. `origin` is what a log line has to say: "the run's venue" and
 * "decided here" are different news, and only one of them is a bug when the
 * step lands on the wrong card.
 */
export type StepVenue =
  { where: 'crucible'; server: string; origin: 'the run' | 'decided here'; because: string };

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
  return a.server === b.server;
}

/** How a venue reads in a refusal. One spelling, so two jobs cannot differ. */
export function describeRunVenue(v: RunVenue): string {
  return `crucible "${v.server}"`;
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
 *  - `any`, or absent — the run was never assigned, because nothing in it
 *    travelled or it has not been admitted yet. `undefined` then, so
 *    {@link venueForRunStep} decides rather than being handed a non-answer.
 *  - {@link RETIRED_LOCAL_NARRATOR_VENUE} — an OLD row, admitted while the
 *    legacy local narrator existed. REFUSED BY NAME rather than re-decided:
 *    §4.3 says a book finishes on the machine it started on, and quietly
 *    continuing a half-rendered book on a different card is exactly what that
 *    rule forbids. The operator queues it again.
 *
 * `any` is NOT a venue and must never reach `venueForRunStep` as one: it is the
 * row saying it does not mind, and the decision is still to be made.
 */
export function runVenueOfRow(waitForResolved: string | undefined): RunVenue | undefined {
  if (waitForResolved === undefined || waitForResolved === WAIT_FOR_ANY) return undefined;
  if (waitForResolved === RETIRED_LOCAL_NARRATOR_VENUE) {
    throw new CrucibleVenueError('legacy_venue_retired', retiredVenueReason());
  }
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
      if (runVenue.server !== named) {
        throw new CrucibleVenueError(
          'run_venue_disagrees',
          `this step was told to run on crucible "${named}", but its run already went to `
          + `${describeRunVenue(runVenue)} (${source}). One book, one GPU (PHASE7-LANES.md §4.4): a `
          + 'step follows its run, and two answers for one run are refused rather than ranked.',
        );
      }
    }
    return {
      where: 'crucible',
      server: runVenue.server,
      origin: 'the run',
      because: `the run's venue (${source})`,
    };
  }
  const decided = await decideWhereGenerationRuns(
    callerNamed === undefined ? undefined : { crucible: callerNamed },
    options.host,
  );
  return { ...decided, origin: 'decided here' };
}

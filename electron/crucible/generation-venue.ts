/**
 * WHERE THE GENERATION STEP RUNS — decided once, at the start of a render.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * Item 2.4 built the seam: `parallel-tts-bridge.ts` sends the whole book to a
 * Crucible `tts` job when `settings.crucible.server` names one, and spawns
 * narrator here when it does not. Nothing in the app ever set that field — only
 * the CLI's `--crucible-server` did — so every in-app render still took the
 * local spawn. This is the half that decides, and it decides from the record
 * the Servers settings row writes (`routing.ts`), which is the only thing on
 * this machine that knows which servers the operator wants used and in what
 * order.
 *
 * ── The rule lives NEXT DOOR (2026-09-19) ──────────────────────────────────
 *
 * `venue-decision.ts` owns it, because `text-venue.ts` was carrying a second
 * copy of the same body and two copies of a rule are two chances to disagree
 * about it (bug hunt A8; crucible `docs/ARCHITECTURE.md` R1). What is left here
 * is this door's TYPES, its error class, and the two sentences that are its own:
 * what a render has instead of a local fallback.
 *
 * The two answers, in the order they are asked:
 *
 * 1. **The caller named a server.** `settings.crucible.server` wins, unchanged
 *    and unconditionally — it is the CLI's `--crucible-server`, a resumed
 *    render's persisted choice, and — because the bridge writes the resolved
 *    name back onto the session's settings — the machine an in-flight book is
 *    already rendering on. An explicit instruction is
 *    never second-guessed by a record.
 * 2. **The first ENABLED server, in rank order, that ANSWERS.** Never a
 *    disabled one, never one that does not answer — and `newJobsWaitFor` is not
 *    consulted, because it is the default written onto a NEW QUEUE ROW and
 *    nothing else (Owen, 2026-09-19; see `venue-decision.ts`'s header for the
 *    ruling and the Listen case that forced it).
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * **No fallback to the local card, and no switch that would make one.** The
 * legacy local-render switch and the narrator spawn behind it are DELETED
 * (docs/LEGACY-REMOVAL.md), so a render that cannot be placed FAILS —
 * `no_enabled_server` in routing's own words, or
 * {@link CrucibleVenueError} `no_reachable_server` naming every server it tried
 * and what each one said. Quietly spawning narrator instead would take a GPU
 * somebody else is using and finish the book in whatever voice this machine
 * happens to have, and report success (`crucible/render.ts`'s header, and
 * ARCHITECTURE.md R3: nothing is ever told "maybe").
 *
 * **No admission decision.** A `ping` that answers is not a promise of a free
 * lane; the door settles that with `409 server_busy`. This picks a machine to
 * ASK.
 *
 * **No second toggle.** There is no per-render "not this one": the venue is the
 * caller's field or the record, and the record has one owner.
 */
import type { RankedServerRow } from '../../shared/crucible/settings-wire';
import { rankedServers } from './routing';
import { pingServer, type CruciblePingResult } from './probe';
import {
  VenueDecisionRefusal,
  decideVenueAmongEnabled,
  type VenueBecause,
  type VenueWords,
} from './venue-decision';

/**
 * Where one render's generation step runs, and why it is there.
 *
 * ONE MEMBER, deliberately: a render runs on a Crucible server or it does not
 * run. The union's second arm was the legacy local narrator, and it is gone with
 * the spawn layer (docs/LEGACY-REMOVAL.md) — the type is what makes "there is no
 * local venue" checkable rather than remembered.
 */
export type GenerationVenue = {
  where: 'crucible';
  /** A registered server's name. Never a URL.  */
  server: string;
  /**
   * Which of the two answers this was. Goes on the render's log, because
   * "why is this book on the Mac" must be answerable six weeks later.
   */
  because: VenueBecause;
};

export type CrucibleVenueErrorCode =
  /** `settings.crucible` is present and names no server. */
  | 'crucible_server_not_named'
  /** Not one enabled server answered. Names each one tried. */
  | 'no_reachable_server'
  /** A later step was named a server its run did not go to. See {@link venueForRunStep}. */
  | 'run_venue_disagrees'
  /**
   * An OLD queue row assigned to the deleted local narrator
   * (`RETIRED_LOCAL_NARRATOR_VENUE`). Refused by name, never re-decided — see
   * `step-venue.ts`'s `runVenueOfRow`.
   */
  | 'legacy_venue_retired';

export class CrucibleVenueError extends Error {
  readonly code: CrucibleVenueErrorCode;

  constructor(code: CrucibleVenueErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleVenueError';
    this.code = code;
  }
}

/**
 * The only two things this decision reads from the world, so a keeper can drive
 * every branch with no registry, no record on disk and no network — the same
 * shape `discovery.ts`'s `DiscoveryHost` uses for the same reason.
 */
export interface VenueHost {
  /** Enabled servers, best first. Refuses `no_enabled_server` when there are none. */
  enabled(): RankedServerRow[];
  /** One unauthenticated reachability check. */
  ping(name: string): Promise<CruciblePingResult>;
}

/**
 * The real one: the app's routing record and real HTTP.
 *
 * `view()` USED TO BE HERE and is gone (2026-09-19): the only thing that read
 * it was the `top-ranked` rung of the decision, and that rung is gone with it.
 * `newJobsWaitFor` is the queue's default for a NEW ROW and nothing else, so a
 * venue decision that read it was reaching into a setting that is not about it.
 */
export function processVenueHost(): VenueHost {
  return { enabled: rankedServers, ping: pingServer };
}

/**
 * What a RENDER has instead of a local fallback — the half of the refusals that
 * is this door's own. See `venue-decision.ts` for the half that is shared.
 */
const RENDER_WORDS: VenueWords = {
  notNamed:
    'settings.crucible is set but names no server. It takes the NAME of an entry in '
    + '<userData>/crucible-servers.json (bookforge-tts --crucible-list); there is no default '
    + 'and no fallback to this machine.',
  noneAnswered:
    'There is no local narrator to fall back to: BookForge renders on a Crucible server or '
    + 'not at all.',
};

/**
 * Decide where this render's generation step runs. The RULE is
 * `venue-decision.ts`'s and is asked once; what happens here is the translation
 * of its refusal into {@link CrucibleVenueError}, which is the class every
 * render door's `catch` is written against.
 *
 * `settings` is narrowed to the one field this reads on purpose: the decision
 * is about a server name, and handing it the whole of `ParallelTtsSettings`
 * would invite it to start reading the engine, the voice or the speed — none of
 * which is its business.
 */
export async function decideWhereGenerationRuns(
  settings: { crucible?: { server: string } } | undefined,
  host: VenueHost,
): Promise<GenerationVenue> {
  try {
    const decided = await decideVenueAmongEnabled(settings?.crucible?.server, host, RENDER_WORDS);
    return { where: 'crucible', ...decided };
  } catch (err) {
    // routing's `no_enabled_server` passes through in its own words; only the
    // decision's own two refusals are re-dressed.
    if (err instanceof VenueDecisionRefusal) {
      throw new CrucibleVenueError(err.code, err.message);
    }
    throw err;
  }
}

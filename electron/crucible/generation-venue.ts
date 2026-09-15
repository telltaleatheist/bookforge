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
 * ── The three answers, in the order they are asked ─────────────────────────
 *
 * 1. **The caller named a server.** `settings.crucible.server` wins, unchanged
 *    and unconditionally — it is the CLI's `--crucible-server`, a resumed
 *    render's persisted choice, and — because the bridge writes the resolved
 *    name back onto the session's settings — the machine an in-flight book is
 *    already rendering on. An explicit instruction is
 *    never second-guessed by a record.
 * 2. **`newJobsWaitFor: 'top-ranked'`** — the top of the enabled list
 *    (crucible `docs/PHASE7-LANES.md` §4.2.1). Its reachability is NOT checked:
 *    naming a machine is an instruction, and a row that names one waits for it
 *    rather than being re-routed. The render fails against that server, by that
 *    server's name, which is the answer an operator can act on.
 * 3. **`newJobsWaitFor: 'any'`** — the first enabled server, in rank order,
 *    whose `ping` answers. §4.2.1: "the first server that will take it,
 *    preferring rank order; unreachable servers are simply not candidates".
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
import type { RankedServerRow, RoutingView } from '../../shared/crucible/settings-wire';
import { rankedServers, readRouting } from './routing';
import { pingServer, type CruciblePingResult } from './probe';

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
   * Which of the three answers this was. Goes on the render's log, because
   * "why is this book on the Mac" must be answerable six weeks later.
   */
  because: 'the caller named it' | 'the top-ranked server' | 'any: the first that answered';
};

export type CrucibleVenueErrorCode =
  /** `settings.crucible` is present and names no server. */
  | 'crucible_server_not_named'
  /** `any`, and not one enabled server answered. Names each one tried. */
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
  /** The routing record resolved against the servers that exist. */
  view(): RoutingView;
  /** Enabled servers, best first. Refuses `no_enabled_server` when there are none. */
  enabled(): RankedServerRow[];
  /** One unauthenticated reachability check. */
  ping(name: string): Promise<CruciblePingResult>;
}

/** The real one: the app's routing record and real HTTP. */
export function processVenueHost(): VenueHost {
  return { view: readRouting, enabled: rankedServers, ping: pingServer };
}

/**
 * Decide where this render's generation step runs. See the header for the three
 * answers and the order they are asked in.
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
  const named = settings?.crucible?.server;
  if (named !== undefined) {
    if (typeof named !== 'string' || named.trim() === '') {
      // Present and empty is a caller that meant to name a server and did not.
      // Rendering locally instead would be the silent downgrade this whole seam
      // exists to refuse.
      throw new CrucibleVenueError(
        'crucible_server_not_named',
        'settings.crucible is set but names no server. It takes the NAME of an entry in '
          + '<userData>/crucible-servers.json (bookforge-tts --crucible-list), or the reserved '
          + 'a registered server; there is no default and no fallback to this machine.',
      );
    }
    return { where: 'crucible', server: named.trim(), because: 'the caller named it' };
  }

  const view = host.view();

  // Throws CrucibleRoutingError `no_enabled_server` — in routing's own words,
  // which already distinguish "you have none" from "you disabled them all" and
  // name the settings page that fixes each.
  const enabled = host.enabled();

  if (view.newJobsWaitFor === 'top-ranked') {
    return {
      where: 'crucible',
      server: (enabled[0] as RankedServerRow).name,
      because: 'the top-ranked server',
    };
  }

  const tried: string[] = [];
  for (const row of enabled) {
    const pong = await host.ping(row.name);
    if (pong.outcome === 'ok') {
      return { where: 'crucible', server: row.name, because: 'any: the first that answered' };
    }
    tried.push(`${row.name} (${pong.outcome}: ${pong.message})`);
  }
  throw new CrucibleVenueError(
    'no_reachable_server',
    'new jobs are set to wait for ANY server, and none of the enabled ones answered: '
      + `${tried.join('; ')}. Start one, or add one in Settings → Crucible Servers. There is no `
      + 'local narrator to fall back to: BookForge renders on a Crucible server or not at all.',
  );
}

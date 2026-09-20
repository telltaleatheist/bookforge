/**
 * WHERE UNASSIGNED WORK GOES — ONE RULE, ONE PLACE.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * "Which machine does this machine's work go to" is one question, and until
 * 2026-09-19 it had two identical bodies: `generation-venue.ts`'s
 * `decideWhereGenerationRuns` (renders, Listen, the CLI, every standalone GPU
 * step through `step-venue.ts`) and `text-venue.ts`'s `decideWhereTextActRuns`
 * (clean, simplify, translate, analysis). Two copies of a rule are two chances
 * to disagree about it (crucible `docs/ARCHITECTURE.md` R1), and the bug hunt
 * (`docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md` A8) found them already drifting
 * in their refusal wording. The rule lives here now; both of those functions are
 * thin wrappers that re-throw in their own error class.
 *
 * `pages.ts` was never a third copy — `decideWherePagesRun` goes through
 * `step-venue.ts`'s `venueForRunStep`, which asks this decision once.
 *
 * ── The rule, in the order it is asked ─────────────────────────────────────
 *
 * 1. **The caller named a server.** It wins, unchanged and unconditionally —
 *    the CLI's `--crucible-server`, a resumed render's persisted choice, the
 *    queue row's resolved venue. An explicit instruction is never
 *    second-guessed by a record, and it is never pinged: naming a machine means
 *    waiting for it.
 * 2. **Otherwise: the first ENABLED server, in rank order, that ANSWERS.**
 *    Nothing else. A disabled server is not a candidate; a server that does not
 *    answer is not a candidate; when none is left this refuses by name.
 *
 * ── Why `newJobsWaitFor` is not read here (Owen, 2026-09-19) ───────────────
 *
 * There used to be a middle rung: with `newJobsWaitFor: 'top-ranked'` the top
 * enabled server was taken WITHOUT a reachability check, on the argument that
 * naming a machine is an instruction. But nobody named it — the RECORD did —
 * and the cost was real: on this machine, set to `top-ranked` with the Mac
 * asleep, pressing Play on Listen failed by name while the PC sat awake and
 * idle.
 *
 * Owen's ruling: *"WSL is always preferred for me, but I often stream on it. It
 * should never take next available unless the user is aware of which ones are
 * enabled… the user just needs control over which one is used and when, but
 * should be able to feed into the next available at will."* The per-server
 * ENABLE SWITCHES are that awareness, and they are already on the bench. So an
 * unassigned decision takes the first enabled server that answers, and rank
 * order is how "preferred" is expressed — a preference, not a wall.
 *
 * `newJobsWaitFor` did not go away; it went back to being one thing only — the
 * default written onto a NEW QUEUE ROW (`shared/queue/wait-for.ts`,
 * `queue-ipc.ts`), where `top-ranked` writes the top server's NAME visibly onto
 * the row and `any` writes `any`. A row that carries a name arrives here as a
 * caller-named server and is waited for, which is the instruction. That is the
 * setting's whole job, and it is not this module's business.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * **No fallback to this machine, and no switch that would make one.** The
 * legacy local narrator and the local text engines are DELETED
 * (docs/LEGACY-REMOVAL.md), so work that cannot be placed FAILS — by name, with
 * every server it tried and what each one said.
 *
 * **No admission decision.** A `ping` that answers is not a promise of a free
 * lane; the door settles that with `409 server_busy`, and the queue settles it
 * by polling activity before it takes a slot. This picks a machine to ASK.
 */
import type { RankedServerRow } from '../../shared/crucible/settings-wire';
import type { CruciblePingResult } from './probe';

/**
 * Which of the two answers this was. Goes on the run's log, because "why is
 * this book on the Mac" must be answerable six weeks later.
 */
export type VenueBecause = 'the caller named it' | 'the first enabled server that answered';

/** A server's name and why it was chosen. Never a URL. */
export type VenueDecision = { server: string; because: VenueBecause };

export type VenueDecisionCode =
  /** A caller asked for a Crucible server and named none. */
  | 'crucible_server_not_named'
  /** Not one enabled server answered. Names each one tried and what it said. */
  | 'no_reachable_server';

/**
 * The refusal this module throws, and the ONLY thing its callers translate.
 *
 * Each caller re-throws it in its own class (`CrucibleVenueError`,
 * `CrucibleTextActError`) carrying the same code and the same sentence, because
 * a CLI and a queue row show `err.message` and the class is what the rest of
 * that door's `catch` blocks are written against. A refusal from
 * `host.enabled()` — routing's own `no_enabled_server` — passes through
 * UNTOUCHED: routing already distinguishes "you have none" from "you disabled
 * them all" and names the settings page that fixes each.
 */
export class VenueDecisionRefusal extends Error {
  readonly code: VenueDecisionCode;
  /**
   * EVERY SERVER THAT WAS PINGED AND WHAT EACH ONE SAID — the same list the
   * message spells out, kept as data beside the prose.
   *
   * Added 2026-09-19 for the `prepare` row, which PARKS on `no_reachable_server`
   * rather than failing (Owen: a book *"would just sit there in the queue until
   * it's free"*) and has to compose a sentence of its own for a waiting row —
   * "this row asks again on every queue pass" instead of "queue the book
   * again". Reading the list back out of this message with a regex would be a
   * second parser of a sentence written for a person; it is a list, so it
   * travels as one. Empty for `crucible_server_not_named`, which pinged
   * nothing.
   */
  readonly tried: readonly string[];

  constructor(code: VenueDecisionCode, message: string, tried: readonly string[] = []) {
    super(message);
    this.name = 'VenueDecisionRefusal';
    this.code = code;
    this.tried = tried;
  }
}

/**
 * The only two things this decision reads from the world, so a keeper can drive
 * every branch with no registry, no record on disk and no network — the same
 * shape `discovery.ts`'s `DiscoveryHost` uses for the same reason.
 */
export interface VenueDecisionHost {
  /** Enabled servers, best first. Refuses `no_enabled_server` when there are none. */
  enabled(): RankedServerRow[];
  /** One unauthenticated reachability check. */
  ping(name: string): Promise<CruciblePingResult>;
}

/**
 * The two sentences that differ between the doors: what each has instead of a
 * local fallback. Required, never defaulted — a door that cannot say what it
 * refuses to do instead is a door whose refusal does not help anybody.
 */
export interface VenueWords {
  /** Tail of `crucible_server_not_named`. */
  readonly notNamed: string;
  /** Tail of `no_reachable_server`, after the list of what each server said. */
  readonly noneAnswered: string;
}

/**
 * Decide where unassigned work runs. See the header for the rule and the order
 * it is asked in.
 *
 * `named` is the caller's instruction and `undefined` means the caller did not
 * say. An empty string is a caller that MEANT to name one and did not, which is
 * refused rather than read as "did not say" — running on whatever the record
 * points at instead would be the silent downgrade this whole seam exists to
 * refuse.
 */
export async function decideVenueAmongEnabled(
  named: string | undefined,
  host: VenueDecisionHost,
  words: VenueWords,
): Promise<VenueDecision> {
  if (named !== undefined) {
    if (typeof named !== 'string' || (named as string).trim() === '') {
      throw new VenueDecisionRefusal('crucible_server_not_named', words.notNamed);
    }
    return { server: named.trim(), because: 'the caller named it' };
  }

  // Throws CrucibleRoutingError `no_enabled_server` — in routing's own words,
  // which already distinguish "you have none" from "you disabled them all" and
  // name the settings page that fixes each.
  const enabled = host.enabled();

  const tried: string[] = [];
  for (const row of enabled) {
    const pong = await host.ping(row.name);
    if (pong.outcome === 'ok') {
      return { server: row.name, because: 'the first enabled server that answered' };
    }
    tried.push(`${row.name} (${pong.outcome}: ${pong.message})`);
  }
  throw new VenueDecisionRefusal(
    'no_reachable_server',
    `not one enabled Crucible server answered: ${tried.join('; ')}. Start one, or enable one `
      + 'in Settings → Crucible Servers — a server that is switched off is never tried. '
      + words.noneAnswered,
    tried,
  );
}

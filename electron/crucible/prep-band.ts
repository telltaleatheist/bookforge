/**
 * WHOSE NUMBERS THIS BOOK IS PACKED TO — and what happens when nobody will say.
 *
 * ── Which machine's band (Owen, ruling 9, and the case that forced it) ─────
 *
 * Measured 2026-09-19: "Clean text — Hitler's People" was an `any` row whose
 * foundry step resolved the job's venue to the PC, so under ruling 9 — a book is
 * atomic on the card, `gpuHoldOf` in `shared/queue/slot-sets.ts` — the book held
 * the PC's card through the rest of the chain. Prepare then asked the venue
 * DECISION which machine to pack for, and that rule answers "the first enabled
 * server that answers, in rank order": the Mac. The book was packed to the Mac's
 * 700-character band and rendered on the PC, judged against the PC's. That
 * evening it surfaced as an over-cap refusal; the quiet version of the same bug
 * is a book rendered in chunks half the size the card would have taken.
 *
 * The venue decision was never the wrong RULE — it answers "where does
 * unassigned work go", and this book's work was not unassigned. So:
 *
 *  1. **The book holds a card → pack for it.** {@link PrepAssignedServer} with
 *     `'the card this book holds'`: the row's `waitForResolved`. No poll and no
 *     "is it busy" — the book holds this card, and a 409 from its own server
 *     during the hold is the hold's own tail rule (`queue-engine.ts`), not this
 *     one's. A server that does not state the voice is still the misconfiguration
 *     refusal by name: there is no second machine to try, because the book is
 *     not free to go to one.
 *  2. **The row named a server → pack for that one.** `'the server this row
 *     named'`: the row's `waitFor`, or a CLI `--crucible-server`, which is the
 *     same instruction arriving through another door. Naming a machine means
 *     waiting for it, so an unreachable one parks exactly as it always did.
 *  3. **`any`, with no card held → pack to the TIGHTEST band.** Every ENABLED
 *     server is asked for the voice's band and the SMALLEST packing ceiling
 *     wins, ties by rank order. Chunks then fit whichever server the `any` rung
 *     later admits the render to (`packingTravelsTo`: a render may only be
 *     admitted to a ceiling at least as high as the one the book was packed to),
 *     so the book is never refused for arriving somewhere tighter. It is NOT
 *     shrunk below the tightest server's own numbers — a ceiling nobody stated
 *     is a number nobody measured.
 *
 * And prepare does NOT pin an `any` job to the server it packed for. Venue
 * admission is the pump's (ruling 7: every server takes the same road) and a 409
 * releases the venue; a prep that wrote `waitForResolved` would be a second
 * scheduler with less information than the first.
 *
 * ── PREPARE WAITS FOR A MACHINE TO STATE THE BAND; IT DOES NOT FAIL FOR WANT OF ONE ──
 *
 * ── The ruling (Owen, 2026-09-19) ──────────────────────────────────────────
 *
 * A book *"would just sit there in the queue until it's free, maybe retrying
 * every so often"*, and *"it should only fail because of a misconfiguration,
 * which can be repaired."*
 *
 * Prep packs the book to the RENDERING machine's numbers — `max_chars` and the
 * pace block off `GET /v1/voices`, never this machine's catalog
 * (`voice-band.ts`) — so it asks for a band before it packs anything. Until this
 * file existed, an evening with the Mac asleep and the PC switched off FAILED
 * the row: a red line in *Needs you*, waiting on a Retry press, for a machine
 * that was simply not on yet. **Nobody misconfigured anything.** A server that is
 * off, asleep or unplugged is AVAILABILITY, and availability is what the queue
 * is for.
 *
 * ── The line between the two answers ───────────────────────────────────────
 *
 * PARK (wait, and ask again on the next admission pass):
 *
 *  - not one enabled server stated a band — the park sentence names each one
 *    that was asked and each one whose switch is off, and that list IS the
 *    sentence;
 *  - every registered server is switched off (`no_enabled_server` with a
 *    roster) — `docs/PENDING-QUEUE-AND-GPU-DIAL.md` files a disabled server
 *    under "a parked row says what would unblock it", and the switch is the act
 *    that unblocks it;
 *  - the server the book holds, or the one the row named, stopped answering
 *    (`crucible_unreachable`);
 *  - anything carrying a `busyLine` — a held lane or a leased card is already a
 *    wait on the road every other module takes (`queue-steps/runtime.ts`), and
 *    it is re-thrown untouched so the holder's own line reaches the row.
 *
 * FAIL (name it; somebody repairs it and presses Retry):
 *
 *  - **there is no server registered at all** (`no_enabled_server`, empty
 *    roster). Nothing is coming; parking would be a row waiting forever on an
 *    act nobody is going to perform. Routing's own sentence names the settings
 *    page that fixes it.
 *  - the servers ANSWERED and none serves this voice (`crucible_unknown_voice`),
 *    the voice has no Crucible id at all (`crucible_voice_unmapped`), the row
 *    states no cap or no pace (`crucible_voice_states_no_cap`,
 *    `crucible_voice_states_no_pace`), the engine is not one a Crucible speaks
 *    (`crucible_engine_unsupported`), the catalog is corrupt
 *    (`corrupt_routing`). Every one of these is repairable and none of them
 *    gets better by waiting.
 *
 * A wrong token or a not-a-crucible on the far end arrives as that server
 * refusing the voices call, which is counted here as "did not state the band":
 * the row waits, and the operator fixes the token. That is a better answer than
 * failing four other books because one server's token is stale.
 */
import type { RankedServerRow } from '../../shared/crucible/settings-wire';
import type { CrucibleStatedBand } from '../higgs-models';
import type { VenueBecause } from './venue-decision';

/**
 * WHY THE BOOK WAS PACKED TO THIS MACHINE'S NUMBERS — written onto the session
 * and onto the prepare row, because "why is this book in 700-character chunks"
 * has to be answerable six weeks later, and the three answers are three
 * different bugs when the chunks turn out wrong.
 *
 * The last member is the CLI's: `renderRangeHeadless` decides the plain way
 * (`decideGenerationVenue`) because there is no queue row behind it, and it
 * carries that decision's own words rather than borrowing one of the queue's.
 */
export type PrepPackedBecause =
  | 'the card this book holds'
  | 'the server this row named'
  | 'the only enabled server that stated a band'
  | `the tightest of ${number} enabled servers`
  | VenueBecause;

/**
 * A SERVER THIS BOOK IS NOT FREE TO LEAVE — the held card or the named one.
 *
 * `undefined` at the call site is the third rung: an `any` row with no card
 * held, which is the only case that gets to compare machines.
 */
export interface PrepAssignedServer {
  readonly server: string;
  readonly because: 'the card this book holds' | 'the server this row named';
}

/** What {@link bandForPrep} answers: the numbers, and whose they are and why. */
export interface PrepPacking<V extends { readonly server: string }> {
  readonly venue: V;
  readonly band: CrucibleStatedBand;
  readonly because: PrepPackedBecause;
}

/**
 * A band nobody can state YET — the refusal that parks a prepare row.
 *
 * It carries `busyLine` under that exact name because `busyLineOf`
 * (`electron/queue-steps/runtime.ts`) is the ONE rule that decides whether a
 * step parks or fails, and it is duck-typed on this field. A park with no line
 * is not a park: `settleStep` fails a row whose refusal names nothing.
 */
export class PrepBandUnavailable extends Error {
  readonly busyLine: string;

  constructor(line: string) {
    super(line);
    this.name = 'PrepBandUnavailable';
    this.busyLine = line;
  }
}

/**
 * The four things this rule reads from the world. See {@link bandForPrep}.
 *
 * Generic in the VENUE, because the caller needs the whole of it —
 * `prepareSession` derives the session's home and which python preps it from
 * `GenerationVenue`, not from a name — while this rule needs only the `server`
 * on it. A keeper drives it with `{ server }` and nothing else, which is the
 * point of the constraint.
 *
 * THERE IS NO `decide()` HERE, and its absence is the fix (see the header):
 * every rung names its own server, so the venue DECISION — "where does
 * unassigned work go" — is never asked about a book whose machine is already
 * settled.
 */
export interface PrepBandHost<V extends { readonly server: string }> {
  /**
   * Enabled servers, best first. Refuses routing's `no_enabled_server` when
   * there are none — in routing's own words, which distinguish "you have none"
   * from "you disabled them all".
   */
  enabled(): readonly RankedServerRow[];
  /**
   * The venue for a server THIS rule has chosen — minted, not decided: no ping,
   * no ranking, no second opinion about a machine already named.
   */
  venueFor(server: string): Promise<V>;
  /** That server's stated band for this voice. Refuses by name (`voice-band.ts`). */
  band(server: string): Promise<CrucibleStatedBand>;
  /**
   * Every REGISTERED server and whether its switch is on — including the ones
   * that were never asked, because "3090 Ti is switched off" is half of why
   * nothing answered and the operator cannot see it in a list of what was tried.
   */
  roster(): readonly RankedServerRow[];
}

/** A refusal's `code`, whatever class it arrived in. */
function codeOf(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The holder's line a refusal carries — the same duck-type the step seam uses. */
function busyLineOf(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const said = (err as { busyLine?: unknown }).busyLine;
  return typeof said === 'string' && said !== '' ? said : undefined;
}

/**
 * THE SENTENCE A PARKED PREPARE ROW SAYS.
 *
 * Pure, and exported, because it is the thing a person reads off a row that is
 * not moving: it has to name the voice (so the answer "that voice is only on
 * the Mac" is visible), every server that was asked with what it said, and
 * every server that was never asked because its switch is off.
 *
 * It is a CLAUSE, not a paragraph: `settleStep` composes the row's message as
 * `holdBusy(server, line)` — "Waiting for <server>: <line> …" — so this reads
 * after a colon.
 */
export function prepBandParkLine(
  voice: string,
  asked: readonly string[],
  off: readonly string[],
): string {
  const parts: string[] = [];
  parts.push(asked.length === 0
    ? `no Crucible server has stated the chunk lengths for voice "${voice}" yet`
    : `no Crucible server will state the chunk lengths for voice "${voice}" — ${asked.join('; ')}`);
  if (off.length > 0) parts.push(`switched off: ${off.join(', ')}`);
  return `${parts.join('. ')}. The book is packed to the rendering machine's own numbers, so `
    + 'nothing is packed until one answers; this row asks again on every queue pass.';
}

/** The registered servers whose switch is off, in rank order. */
function switchedOff(roster: readonly RankedServerRow[]): string[] {
  return roster.filter((row) => !row.enabled).map((row) => row.name);
}

/** How one server that would not state the band reads in the park sentence. */
function didNotAnswer(server: string): string {
  return `${server} did not answer when it was asked for the voice's band`;
}

/**
 * THE BAND PREP PACKS TO — or a refusal that has already decided whether this
 * row waits or stops.
 *
 * `assigned` is the machine the book is not free to leave (the held card, or
 * the named server); `undefined` is an `any` row, which packs to the tightest
 * band among the enabled servers. The three rungs are the header's.
 *
 * Every refusal reaches the caller as a throw, and the caller does not classify
 * it: a {@link PrepBandUnavailable} (or anything else carrying a `busyLine`)
 * parks the row, and everything else fails it by name. That is the whole
 * division, and it lives here so there is one place to read it and one place a
 * keeper drives (`tools/test-queue-narration-plan.js` §7).
 */
export async function bandForPrep<V extends { readonly server: string }>(
  voice: string,
  assigned: PrepAssignedServer | undefined,
  host: PrepBandHost<V>,
): Promise<PrepPacking<V>> {
  if (assigned !== undefined) {
    return packedFor(voice, assigned.server, assigned.because, host);
  }
  return tightestAmongEnabled(voice, host);
}

/** Rungs 1 and 2: one machine, no comparison, no poll. */
async function packedFor<V extends { readonly server: string }>(
  voice: string,
  server: string,
  because: PrepPackedBecause,
  host: PrepBandHost<V>,
): Promise<PrepPacking<V>> {
  let band: CrucibleStatedBand;
  try {
    band = await host.band(server);
  } catch (err) {
    throw statedNothing(err, voice, server, host);
  }
  return { venue: await host.venueFor(server), band, because };
}

/**
 * Rung 3: the smallest packing ceiling among the enabled servers that state
 * one, ties by rank order.
 *
 * ASKED OF EVERY ENABLED SERVER, not of the first that answers a ping: the
 * question here is not "who will take this book" — nobody has been admitted yet
 * — but "what length fits them all", and one machine cannot answer that. Each
 * ask is the voices call the old rung made anyway, so the reachability ping it
 * used to pay for is gone rather than doubled.
 */
async function tightestAmongEnabled<V extends { readonly server: string }>(
  voice: string,
  host: PrepBandHost<V>,
): Promise<PrepPacking<V>> {
  let enabled: readonly RankedServerRow[];
  try {
    enabled = host.enabled();
  } catch (err) {
    throw noneEnabled(err, voice, host);
  }

  const silent: string[] = [];
  let held: unknown;
  let refused: unknown;
  let best: { server: string; band: CrucibleStatedBand } | undefined;
  let stated = 0;
  for (const row of enabled) {
    let band: CrucibleStatedBand;
    try {
      band = await host.band(row.name);
    } catch (err) {
      /*
       * A machine that would not answer is not an answer ABOUT the other
       * machines, so the loop goes on and the failure is remembered in the one
       * bucket that decides what is thrown if nothing states a band at all.
       */
      if (busyLineOf(err) !== undefined) held ??= err;
      else if (codeOf(err) === 'crucible_unreachable') silent.push(didNotAnswer(row.name));
      // A server that ANSWERED and refused by name is not in the park sentence:
      // its refusal is thrown instead of that sentence when nothing states a
      // band, and "did not answer" would be a false thing to say about it.
      else refused ??= err;
      continue;
    }
    stated += 1;
    // Ties go to rank order, which is what a strict `<` gives: the earlier row
    // is already in hand when an equal ceiling arrives.
    if (best === undefined || band.ceilingChars < best.band.ceilingChars) {
      best = { server: row.name, band };
    }
  }

  if (best !== undefined) {
    return {
      venue: await host.venueFor(best.server),
      band: best.band,
      because: stated === 1
        ? 'the only enabled server that stated a band'
        : `the tightest of ${stated} enabled servers`,
    };
  }
  /*
   * NOTHING STATED A BAND, and the three reasons are three different rows.
   *
   * A HELD lane first: it is the one refusal that waiting genuinely fixes, and
   * the holder's own line is the sentence the operator wants. Then a machine
   * that ANSWERED and refused by name — a voice nobody serves does not get
   * better by asking again. Then silence, which is availability and parks.
   */
  if (held !== undefined) throw held;
  if (refused !== undefined) throw refused;
  throw new PrepBandUnavailable(prepBandParkLine(voice, silent, switchedOff(host.roster())));
}

/** No machine could even be asked: wait, unless there is nothing to wait FOR. */
function noneEnabled(
  err: unknown,
  voice: string,
  host: PrepBandHost<{ readonly server: string }>,
): unknown {
  if (busyLineOf(err) !== undefined) return err;
  if (codeOf(err) !== 'no_enabled_server') return err;
  /*
   * NONE REGISTERED IS NOT THE SAME FACT AS ALL SWITCHED OFF, and routing
   * spells them with one code. An empty roster is the misconfiguration:
   * nothing is on its way, so a park would be a row waiting on an act nobody
   * is going to perform. Routing's own sentence already names the page that
   * adds one, so it is re-thrown untouched.
   */
  const roster = host.roster();
  if (roster.length === 0) return err;
  return new PrepBandUnavailable(prepBandParkLine(voice, [], switchedOff(roster)));
}

/** The machine this book is bound to stopped answering: wait. Anything else: stop. */
function statedNothing(
  err: unknown,
  voice: string,
  server: string,
  host: PrepBandHost<{ readonly server: string }>,
): unknown {
  if (busyLineOf(err) !== undefined) return err;
  if (codeOf(err) !== 'crucible_unreachable') return err;
  /*
   * This book holds this card, or the row named this machine — either way it is
   * an instruction to wait for it. The refusal's own prose is a RENDER's —
   * "start the server and queue the book again" — which is advice about a thing
   * the queue is already doing, so the clause is composed here instead. What it
   * said is in the log, at the door that caught it.
   */
  return new PrepBandUnavailable(prepBandParkLine(
    voice,
    [didNotAnswer(server)],
    switchedOff(host.roster()),
  ));
}

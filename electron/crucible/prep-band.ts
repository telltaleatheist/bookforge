/**
 * PREPARE WAITS FOR A MACHINE TO STATE THE BAND; IT DOES NOT FAIL FOR WANT OF ONE.
 *
 * ── The ruling (Owen, 2026-09-19) ──────────────────────────────────────────
 *
 * A book *"would just sit there in the queue until it's free, maybe retrying
 * every so often"*, and *"it should only fail because of a misconfiguration,
 * which can be repaired."*
 *
 * Prep packs the book to the RENDERING machine's numbers — `max_chars` and the
 * pace block off `GET /v1/voices`, never this machine's catalog
 * (`voice-band.ts`) — so it asks one enabled server for one band before it
 * packs anything. Until this file existed, an evening with the Mac asleep and
 * the PC switched off FAILED the row: a red line in *Needs you*, waiting on a
 * Retry press, for a machine that was simply not on yet. **Nobody
 * misconfigured anything.** A server that is off, asleep or unplugged is
 * AVAILABILITY, and availability is what the queue is for.
 *
 * ── The line between the two answers ───────────────────────────────────────
 *
 * PARK (wait, and ask again on the next admission pass):
 *
 *  - not one enabled server answered (`no_reachable_server`) — the decision
 *    names each one it pinged and what it said, and that list IS the sentence;
 *  - every registered server is switched off (`no_enabled_server` with a
 *    roster) — `docs/PENDING-QUEUE-AND-GPU-DIAL.md` files a disabled server
 *    under "a parked row says what would unblock it", and the switch is the act
 *    that unblocks it;
 *  - the server that was chosen stopped answering between the ping and the
 *    voices call (`crucible_unreachable`);
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
 * A wrong token or a not-a-crucible on the far end arrives folded into
 * `no_reachable_server`'s list — the decision asks every enabled server the
 * same question and records what each said, and it does not rank their
 * failures. The park sentence therefore NAMES the misconfiguration ("wrong
 * token: …") even though the row waits; the operator reads the row, fixes the
 * token, and the next pass preps. That is a better answer than failing four
 * other books because one server's token is stale.
 */
import type { RankedServerRow } from '../../shared/crucible/settings-wire';
import type { CrucibleStatedBand } from '../higgs-models';

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
 * The three things this rule reads from the world. See {@link bandForPrep}.
 *
 * Generic in the VENUE the decision hands back, because the caller needs the
 * whole of it — `prepareSession` derives the session's home and which python
 * preps it from `GenerationVenue`, not from a name — while this rule needs
 * only the `server` on it. A keeper drives it with `{ server }` and nothing
 * else, which is the point of the constraint.
 */
export interface PrepBandHost<V extends { readonly server: string }> {
  /**
   * Which server to ask — the row's named one, or the first enabled one that
   * answers. Refuses by name (`venue-decision.ts`).
   */
  decide(): Promise<V>;
  /** That server's stated band for this voice. Refuses by name (`voice-band.ts`). */
  band(server: string): Promise<CrucibleStatedBand>;
  /**
   * Every REGISTERED server and whether its switch is on — including the ones
   * the decision never asked, because "3090 Ti is switched off" is half of why
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

/** What the venue decision pinged and what each one said, when it kept the list. */
function triedOf(err: unknown): readonly string[] {
  if (err === null || typeof err !== 'object') return [];
  const tried = (err as { tried?: unknown }).tried;
  if (!Array.isArray(tried)) return [];
  return tried.filter((entry): entry is string => typeof entry === 'string');
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

/**
 * THE BAND PREP PACKS TO — or a refusal that has already decided whether this
 * row waits or stops.
 *
 * Every refusal reaches the caller as a throw, and the caller does not classify
 * it: a {@link PrepBandUnavailable} (or anything else carrying a `busyLine`)
 * parks the row, and everything else fails it by name. That is the whole
 * division, and it lives here so there is one place to read it and one place a
 * keeper drives (`tools/test-queue-narration-plan.js` §7).
 */
export async function bandForPrep<V extends { readonly server: string }>(
  voice: string,
  host: PrepBandHost<V>,
): Promise<{ readonly venue: V; readonly band: CrucibleStatedBand }> {
  let venue: V;
  try {
    venue = await host.decide();
  } catch (err) {
    throw decidedNothing(err, voice, host);
  }
  try {
    return { venue, band: await host.band(venue.server) };
  } catch (err) {
    throw statedNothing(err, voice, venue.server, host);
  }
}

/** No machine could be chosen: wait, unless there is nothing to wait FOR. */
function decidedNothing(
  err: unknown,
  voice: string,
  host: PrepBandHost<{ readonly server: string }>,
): unknown {
  if (busyLineOf(err) !== undefined) return err;
  const code = codeOf(err);
  const roster = host.roster();
  if (code === 'no_reachable_server') {
    return new PrepBandUnavailable(prepBandParkLine(voice, triedOf(err), switchedOff(roster)));
  }
  if (code === 'no_enabled_server') {
    /*
     * NONE REGISTERED IS NOT THE SAME FACT AS ALL SWITCHED OFF, and routing
     * spells them with one code. An empty roster is the misconfiguration:
     * nothing is on its way, so a park would be a row waiting on an act nobody
     * is going to perform. Routing's own sentence already names the page that
     * adds one, so it is re-thrown untouched.
     */
    if (roster.length === 0) return err;
    return new PrepBandUnavailable(prepBandParkLine(voice, [], switchedOff(roster)));
  }
  return err;
}

/** The chosen machine stopped answering: wait. Anything else it said: stop. */
function statedNothing(
  err: unknown,
  voice: string,
  server: string,
  host: PrepBandHost<{ readonly server: string }>,
): unknown {
  if (busyLineOf(err) !== undefined) return err;
  if (codeOf(err) !== 'crucible_unreachable') return err;
  /*
   * The decision pinged this machine moments ago (or the row NAMED it, which is
   * an instruction to wait for it). Either way the refusal's own prose is a
   * RENDER's — "start the server and queue the book again" — which is advice
   * about a thing the queue is already doing, so the clause is composed here
   * instead. What it said is in the log, at the door that caught it.
   */
  return new PrepBandUnavailable(prepBandParkLine(
    voice,
    [`${server} did not answer when it was asked for the voice's band`],
    switchedOff(host.roster()),
  ));
}

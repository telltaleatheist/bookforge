/**
 * HOW MANY READINGS A VOICE CAN OFFER — its take ladder, read off the server.
 *
 * ── The question, and who owns the answer ──────────────────────────────────
 *
 * Correct Sentences renders N fresh candidates of a sentence so a person can
 * audition them and approve one. N used to be the literal `3`
 * (`correct-sentences-bridge.ts`, `params.takes ?? 3`), chosen when every take
 * was take 0 at a different sampling temperature and any number of them was
 * therefore expressible.
 *
 * It is not any more. A rung is *(sampling deltas, seed offset)* and narrator
 * renders take N in that take's own lane — `seed + index + TAKE_SEED_STRIDE *
 * take` (crucible `docs/PHASE3-TTS.md` §2, "THE SEED HALF"). Two renders of one
 * chunk at the SAME take are byte-identical by design, so candidates are only
 * different readings if they sit on different rungs; and a `take` past the end
 * of the ladder is refused `unknown_take` and never clamped. The number of
 * candidates a voice can offer is therefore its ladder length minus one — take
 * 0 is the reading already in the book — and that number is the SERVER's, in
 * `VoiceInfo.takes`, not this app's to guess.
 *
 * ── One `GET /v1/voices`, and the one that is still owed ───────────────────
 *
 * This asks the server once per correction pass, before any job is submitted.
 * `runCrucibleReroll` then asks a second time for its own question — can this
 * server load that voice (`reroll.ts`'s `assertCrucibleVoiceAvailable` call,
 * one GET for the whole pass). Two reads of one document, which is one more
 * than the fact needs: the collapse is for `assertCrucibleVoiceAvailable` to
 * hand its row BACK, so the ladder and the loadable check come off the same
 * response. That change lives in `render.ts` and `reroll.ts` and is deliberately
 * not made here.
 *
 * ── The venue is decided ONCE, here, and handed on ─────────────────────────
 *
 * The ladder is a property of a voice ON A SERVER, so this has to know which
 * server before it can ask — and deciding the venue twice is how two halves of
 * one pass end up on two machines. So this returns the venue it decided, and
 * the caller names that server to `rerollAtVenue`, which then agrees with it by
 * construction rather than by luck.
 */

import type { VenueHost } from './generation-venue';
import { crucibleClientFor, CRUCIBLE_CLIENT_NAME } from './servers';
import { CrucibleRenderRefused, crucibleVoiceFor, describeCrucibleRefusal } from './render';
import { venueForRunStep, type RunVenue } from './step-venue';

/** What a voice's ladder says, and where it was read. */
export interface CrucibleVoiceLadder {
  /** The server this pass runs on — decided here, so the caller can name it. */
  readonly server: string;
  /** The Crucible voice id the ladder belongs to. */
  readonly voice: string;
  /**
   * How many rungs the ladder has, as the server's own row says. Never below 1:
   * take 0 exists whether or not a manifest declares it.
   */
  readonly rungs: number;
}

export interface CrucibleVoiceLadderOptions {
  /** The run's already-resolved venue, when the session recorded one. */
  readonly runVenue?: RunVenue;
  /** Where `runVenue` was read from, for the refusal's sentence. */
  readonly runVenueSource?: string;
  /** The routing record and the network — `processVenueHost()` in the app. */
  readonly host: VenueHost;
  /** The session's engine. Refused by name inside `crucibleVoiceFor` if not Higgs. */
  readonly ttsEngine: string;
  /** BookForge's own voice id, mapped to Crucible's by `crucibleVoiceFor`. */
  readonly voiceId: string;
}

export async function crucibleVoiceLadder(
  options: CrucibleVoiceLadderOptions,
): Promise<CrucibleVoiceLadder> {
  const venue = await venueForRunStep({
    ...(options.runVenue === undefined ? {} : { runVenue: options.runVenue }),
    ...(options.runVenueSource === undefined ? {} : { runVenueSource: options.runVenueSource }),
    host: options.host,
  });
  // Throws CrucibleRenderRefused by name for a non-Higgs engine, a local-only
  // override checkpoint and a zero-shot voice — the same door the re-roll goes
  // through, so a voice this app cannot send is refused before the ask.
  const voice = crucibleVoiceFor(options.ttsEngine, options.voiceId);
  const client = await crucibleClientFor(venue.server, CRUCIBLE_CLIENT_NAME);
  let rows;
  try {
    rows = await client.voices();
  } catch (err) {
    throw describeCrucibleRefusal(err, venue.server);
  }
  const row = rows.find((v) => v.id === voice);
  if (!row) {
    const known = rows.map((v) => v.id).join(', ');
    throw new CrucibleRenderRefused(
      'crucible_unknown_voice',
      `crucible "${venue.server}" has no voice "${voice}", so there is no take ladder to read `
      + `(${rows.length === 0 ? 'it advertises none' : `known: ${known}`}).`,
    );
  }
  if (!Number.isInteger(row.takes) || row.takes < 1) {
    // A row that states no ladder is a server this build cannot reason about:
    // take 0 always exists, so `0` or a non-integer is a malformed document
    // rather than "no takes", and guessing a 3 here is how the count became a
    // literal in the first place.
    throw new CrucibleRenderRefused(
      'crucible_voice_ladder_unreadable',
      `crucible "${venue.server}" says voice "${voice}" has ${JSON.stringify(row.takes)} take `
      + 'rungs. Every voice has at least one (take 0), so this row is malformed — the number of '
      + 'candidates a correction can offer cannot be derived from it, and it is not guessed.',
    );
  }
  return { server: venue.server, voice, rungs: row.takes };
}

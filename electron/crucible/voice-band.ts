/**
 * THE LENGTH A CHUNK MAY BE, ASKED OF THE MACHINE THAT WILL RENDER IT.
 *
 * ── The ruling this file is ────────────────────────────────────────────────
 *
 * Phase 15's division of knowledge: **the engine owns the voice's facts, the
 * client owns the chunking.** A client still decides where one chunk ends and
 * the next begins — Crucible refuses an over-long chunk rather than re-splitting
 * it (`crucible/jobs/tts/render.py`: "Chunking is the client's, so this is a
 * refusal and not a re-split") — but the NUMBERS it packs to belong to the
 * server that will speak them, and they arrive on `GET /v1/voices`:
 * `max_chars` (the cap certificate for this (voice, backend)) and the `pace`
 * block (`safe_min_chars` / `safe_max_chars` / `target_chars` and the three
 * rates).
 *
 * Until 2026-09-15 every BookForge door packed from THIS MACHINE'S catalog
 * (`electron/data/higgs-models.json`) and, on Windows, from the `served` arm's
 * block whatever machine the render was bound for — so a book prepped here for
 * the Mac was packed against the PC's numbers. `electron/crucible/stream.ts`
 * carried the gap as a RULING OWED. This module is that ruling.
 *
 * ── The rules, exactly ─────────────────────────────────────────────────────
 *
 *  - **The ceiling is the venue's.** `safe_max_chars` when the row states one,
 *    else `max_chars`; never above `max_chars`, which is the cap the server
 *    enforces on the bytes it receives.
 *  - **The floor is the venue's** (`safe_min_chars`), or none.
 *  - **The target is the venue's when it states one** (`target_chars`). It is
 *    null on the wire today for every voice, and when the server states none the
 *    LOCAL catalog's `targetChars` stands, CLAMPED to the venue's ceiling. That
 *    is not a fallback: the server stated no preference, and the ceiling — the
 *    one number it did state — is still honoured. A voice for which neither side
 *    states a target and which declares no band is refused by whoever needs one,
 *    by name, exactly as it is today; nothing here invents one.
 *  - **The local catalog is never consulted for the CEILING on a Crucible
 *    render.** The two disagree today: the catalog's `_targetCharsNote` still
 *    reads "MLX 900" while Owen's 2026-09-09 family ruling put every fine-tune
 *    at 800 and the Mac advertises 800. The engine wins — it is the thing that
 *    will refuse, and it is the thing that measured the weights it is holding.
 *  - **A voice the venue does not advertise, or a row with no `max_chars`, is
 *    refused by name before anything is packed.** `max_chars` is null exactly
 *    when `backendSupported` is false — this host has no backend block for that
 *    voice — and a packer given `null` would either crash deep or invent a
 *    number, which is a book rendered to a cap nobody measured.
 */

import type { CrucibleClient, VoiceInfo } from '@crucible/client';
import { CrucibleRenderRefused, describeCrucibleRefusal } from './render';

/**
 * What one Crucible says about one voice's chunk length — the whole of it,
 * because a client that packs needs all of it (the SDK's own words about
 * `VoiceInfo.pace`).
 *
 * Structural rather than the SDK's row so the consumers — the voice document
 * writer in `higgs-models.ts` among them — can take it without importing the
 * SDK, and so a keeper can build one without a server.
 */
export interface CrucibleVoiceBand {
  /** The registered server name this was asked of. */
  readonly server: string;
  /** Crucible's voice id (`CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE`'s right-hand side). */
  readonly voice: string;
  /** The cap certificate: the most characters this voice may be handed in one chunk. */
  readonly maxChars: number;
  /** The measured band's floor, or null when the row states none. */
  readonly safeMinChars: number | null;
  /** The measured band's ceiling, or null when the row states none. */
  readonly safeMaxChars: number | null;
  /** The server's stated target, or null — null for every voice on the wire today. */
  readonly targetChars: number | null;
  /** The pace the guard is centred on, verbatim from the row. */
  readonly paceCharsPerSec: number;
  readonly maxCharsPerSec: number;
  readonly minCharsPerSec: number;
}

/** The band the SDK's row states, or a refusal by name. Never a guess. */
export function bandFromVoiceRow(
  server: string,
  voice: string,
  row: VoiceInfo,
): CrucibleVoiceBand {
  if (typeof row.maxChars !== 'number' || !(row.maxChars > 0)) {
    throw new CrucibleRenderRefused(
      'crucible_voice_states_no_cap',
      `crucible "${server}" advertises voice "${voice}" but states no character cap for it `
      + `(max_chars ${JSON.stringify(row.maxChars ?? null)}${row.backendSupported ? '' : '; its backend '
        + 'does not support this voice, which is when the whole backend block — cap, revision, '
        + 'fingerprint — is null'}). Chunking is this client's and the cap is that server's, so there `
      + 'is nothing to pack against. Nothing is packed to the local catalog instead: the two '
      + 'disagree, and the engine is the one that refuses.',
    );
  }
  const pace = row.pace;
  if (pace === undefined || pace === null) {
    throw new CrucibleRenderRefused(
      'crucible_voice_states_no_pace',
      `crucible "${server}" advertises voice "${voice}" with no pace block. API v1 says the block `
      + 'is never null ("the whole block, because a client that packs needs all of it"), so a row '
      + 'without one is a protocol disagreement rather than a voice this client can pack for.',
    );
  }
  return {
    server,
    voice,
    maxChars: row.maxChars,
    safeMinChars: pace.safeMinChars,
    safeMaxChars: pace.safeMaxChars,
    targetChars: pace.targetChars,
    paceCharsPerSec: pace.paceCharsPerSec,
    maxCharsPerSec: pace.maxCharsPerSec,
    minCharsPerSec: pace.minCharsPerSec,
  };
}

/**
 * One `GET /v1/voices`, and the band for this voice out of it.
 *
 * The row is also the place `loadable` lives, so the caller gets the SAME
 * refusals `assertCrucibleVoiceAvailable` gives — this returns the row beside
 * the band rather than making a second round trip for it.
 */
export async function crucibleVoiceBand(
  client: Pick<CrucibleClient, 'voices'>,
  server: string,
  voice: string,
): Promise<{ readonly row: VoiceInfo; readonly band: CrucibleVoiceBand }> {
  let rows: readonly VoiceInfo[];
  try {
    rows = await client.voices();
  } catch (err) {
    throw describeCrucibleRefusal(err, server);
  }
  const row = rows.find((v) => v.id === voice);
  if (!row) {
    const known = rows.map((v) => v.id).join(', ');
    throw new CrucibleRenderRefused(
      'crucible_unknown_voice',
      `crucible "${server}" has no voice "${voice}" `
      + `(${rows.length === 0 ? 'it advertises none' : `known: ${known}`}). BookForge's catalog and `
      + 'the server\'s are two catalogs; see CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE.',
    );
  }
  return { row, band: bandFromVoiceRow(server, voice, row) };
}

/**
 * The longest chunk a packer may build for this venue.
 *
 * `safe_max_chars` when the row states one — the measured band is INSIDE the
 * cap and is what the model reads best — else the cap itself. Never above
 * `max_chars`: a server that advertised a safe ceiling above its own cap would
 * be refusing its own advice, and this clamps rather than trusting it, because
 * the cap is the number the render door actually enforces.
 */
export function venuePackingCeiling(band: CrucibleVoiceBand): number {
  const stated = band.safeMaxChars;
  if (typeof stated === 'number' && stated > 0) return Math.min(stated, band.maxChars);
  return band.maxChars;
}

/**
 * The target a packer aims at, given what the LOCAL catalog wanted.
 *
 * The server's `target_chars` when it states one. When it does not — every
 * voice on the wire today — the local catalog's target stands, clamped to the
 * venue's ceiling. `null` in and nothing stated by the server means `null` out:
 * no target is invented here, and the caller refuses by name if it needs one.
 */
export function venuePackingTarget(
  band: CrucibleVoiceBand,
  localTargetChars: number | null | undefined,
): number | null {
  const ceiling = venuePackingCeiling(band);
  if (typeof band.targetChars === 'number' && band.targetChars > 0) {
    return Math.min(band.targetChars, ceiling);
  }
  if (typeof localTargetChars === 'number' && localTargetChars > 0) {
    return Math.min(localTargetChars, ceiling);
  }
  return null;
}

/**
 * The band as a VOICE DOCUMENT carries it — the two packing rules above applied
 * once, here, so the document writer transcribes an answer instead of re-deriving
 * it (`electron/higgs-models.ts`'s `CrucibleStatedBand`, which is the same shape
 * declared where no SDK import may reach).
 *
 * `localTargetChars` is this machine's catalog row for the same voice, and it is
 * used for ONE field and only when the server states no target of its own; the
 * ceiling, the floor and the cap never come from it.
 */
export function statedBandForDocument(
  band: CrucibleVoiceBand,
  localTargetChars: number | null | undefined,
): {
  server: string;
  voice: string;
  maxChars: number;
  ceilingChars: number;
  floorChars: number | null;
  targetChars: number | null;
  paceCharsPerSec: number;
  maxCharsPerSec: number;
  minCharsPerSec: number;
} {
  return {
    server: band.server,
    voice: band.voice,
    maxChars: band.maxChars,
    ceilingChars: venuePackingCeiling(band),
    floorChars: band.safeMinChars,
    targetChars: venuePackingTarget(band, localTargetChars),
    paceCharsPerSec: band.paceCharsPerSec,
    maxCharsPerSec: band.maxCharsPerSec,
    minCharsPerSec: band.minCharsPerSec,
  };
}

/** One line for a log, so a render says which numbers it packed to and whose they are. */
export function describeVenueBand(band: CrucibleVoiceBand): string {
  const floor = band.safeMinChars === null ? 'none' : String(band.safeMinChars);
  const target = band.targetChars === null ? 'none stated' : String(band.targetChars);
  return `crucible "${band.server}" states voice "${band.voice}": cap ${band.maxChars}, `
    + `band ${floor}-${venuePackingCeiling(band)}, target ${target}, pace ${band.paceCharsPerSec} ch/s `
    + `(${band.minCharsPerSec}-${band.maxCharsPerSec})`;
}

/**
 * THE CHUNKS THIS VENUE WILL REFUSE, NAMED HERE FIRST.
 *
 * The server measures `len(chunk.text)` — the bytes it is handed, markers and
 * all — against `max_chars`, and refuses the WHOLE job for one over-long row
 * (`chunk_too_long`, HTTP 400). Asked here, before the submit, the same fact
 * arrives as a local refusal that names the chunk, its length, and what packed
 * it, instead of a 400 the operator has to go read a server log to understand.
 *
 * It measures the cap and NOT the safe ceiling on purpose: the ceiling is where
 * the packer aims, the cap is what the server enforces, and refusing a book for
 * being inside the cap but outside the band would be this door overruling the
 * engine's own certificate.
 */
export function refuseChunksOverVenueCap(
  band: CrucibleVoiceBand,
  chunks: readonly { readonly index: number; readonly text: string }[],
): void {
  const over = chunks
    .filter((c) => c.text.length > band.maxChars)
    .map((c) => ({ index: c.index, chars: c.text.length }));
  if (over.length === 0) return;
  const named = over.slice(0, 8).map((o) => `${o.index} is ${o.chars}`).join(', ');
  throw new CrucibleRenderRefused(
    'crucible_chunk_over_venue_cap',
    `${over.length} chunk(s) are longer than the ${band.maxChars}-character cap crucible `
    + `"${band.server}" states for "${band.voice}": index ${named}`
    + (over.length > 8 ? `, and ${over.length - 8} more` : '')
    + '. The chunks were packed by prep (python/narrator/text/paragraph_packer.py) from the '
    + 'numbers this venue advertised; a row still over the cap is one the packer could not split '
    + 'without breaking a sentence, and nothing here re-splits it — chunking is the client\'s, so '
    + 'a silent re-split would be two files where the session expects one. Re-prep the book after '
    + 'the text pass, or render it on a server whose cap covers it.',
  );
}

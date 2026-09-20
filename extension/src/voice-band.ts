/**
 * What ONE `/v1/voices` row says about length, and whether this extension can
 * read a web page with that voice at all.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * Two surfaces need the same answer and used to reach it separately: the popup
 * decides whether a voice is offerable, and the offscreen document decides what
 * band to pack rows to. That is one fact with two owners — the shape
 * `crucible/docs/ARCHITECTURE.md` names as the recurring defect in this
 * system — so both now ask HERE, and a voice the picker offers is exactly a
 * voice `bandFromVoiceRow` can answer for.
 *
 * It is pure: no DOM, no `chrome.*`, no SDK client. That is deliberate so
 * `tools/test-extension-voice-band.js` can EXECUTE it rather than grep for it
 * (the pattern `tools/test-extension-pairing.js` set for `pair.ts`).
 *
 * ── A row may state no length at all, from Crucible 1.0.7 ──────────────────
 *
 * `max_chars` is a RESULT — the longest chunk a sweep on these weights on this
 * arm came back whole from — so a checkpoint being screened has none, and not
 * having one is the reason it is on the card. Crucible made the key optional on
 * 2026-09-19 (`crucible/docs/PHASE18-UNCERTIFIED.md` §4, on
 * `feat/phase18-retake-flag`, shipping as 1.0.7) and retired `chunk_too_long`
 * with it: the render door no longer refuses a chunk by length, THE CLIENT
 * PACKS, and a row reporting `maxChars: null` means NOT MEASURED — never the
 * other arm's number, never a sibling's.
 *
 * The 1.0.6 server on this PC still states a cap for all six of its voices, so
 * the null arm is not reachable against it TODAY. That is why the first four
 * checks in `tools/test-extension-voice-band.js` are the record of what this
 * answers rather than a live probe: the day a screening checkpoint appears in
 * `/v1/voices` is the day this path runs for the first time in anger, and it
 * must not be the day it is written.
 *
 * So "no ceiling" is a real state a real server will report, and this extension
 * has to have an answer for it that is not a crash at the moment somebody
 * presses play. The answer is: that voice is listed, is not offered for
 * reading, and says why — because packing a web page to a length nobody
 * measured is how you find out the hard way, one truncated paragraph at a time.
 *
 * ── Both ceilings, from the row the server actually sent ────────────────────
 *
 * The ceiling has two spellings and the safe one wins: `pace.safe_max_chars` is
 * the MEASURED band (the training-clip IQR — chunks outside it early-stop more
 * often) and `max_chars` is the truncation cap, and Crucible refuses a manifest
 * whose band exceeds its own cap (`crucible/voices.py`, *"the band may never
 * exceed the arm's max_chars"*), so `safeMaxChars ?? maxChars` is well defined
 * and is what `listenBandFromCaps` takes. Until 2026-09-19 this extension sent
 * only `maxChars` and a comment claiming there was "no `safeMaxChars` on the
 * wire" — there is, and has been since 2026-09-15: it is `pace` on the voice
 * row, `VoicePace` in the SDK, and `electron/crucible/voice-band.ts` has been
 * reading it on the app's side of the same session all along. Two clients
 * packing the same voice on the same server to different bands is the same
 * two-owner defect one level down.
 */

import { listenBandFromCaps, type ListenChunkBand } from '../../shared/listen-text/index';

/**
 * The length facts one voice row states, verbatim, nulls included.
 *
 * `null` is an ANSWER here — "nobody measured this" — and is never the absence
 * of a key. Every field is the server's; nothing in this extension derives one.
 */
export interface VoiceLengths {
  /** `VoiceInfo.maxChars` — the truncation cap, or null for not measured. */
  readonly maxChars: number | null;
  /** `VoiceInfo.pace.safeMinChars` — advisory floor, or null. */
  readonly safeMinChars: number | null;
  /** `VoiceInfo.pace.safeMaxChars` — the measured ceiling, or null. */
  readonly safeMaxChars: number | null;
}

/**
 * Can a page be read with this voice HERE?
 *
 * One question, one answer, both surfaces. False means the row states no
 * ceiling in either spelling, which is a screening checkpoint: loadable,
 * renderable by a sweep that wants exactly its uncertified numbers, and not
 * something a web page should be packed against.
 */
export function isReadable(lengths: VoiceLengths): boolean {
  return lengths.safeMaxChars !== null || lengths.maxChars !== null;
}

/**
 * Why not, in one sentence a person with a web page open can act on.
 *
 * Null when it IS readable. It names the voice and the server because the
 * popup's tooltip and the transport bar's error are read a long way from the
 * row they came off.
 */
export function unreadableBecause(
  voice: string,
  serverName: string,
  lengths: VoiceLengths,
): string | null {
  if (isReadable(lengths)) return null;
  return `Crucible "${serverName}" states no measured chunk length for "${voice}" — neither a `
    + 'safe band nor a cap. That is a voice being screened, not one that has been measured, and '
    + 'this extension will not pack a page to a length nobody has measured. Pick a voice whose '
    + 'row states one.';
}

/**
 * The band rows for this voice are packed to, or a throw that says why not.
 *
 * `listenBandFromCaps` refuses a capless voice too, but in the APP's words —
 * it points at `electron/data/higgs-models.json` and at the Orpheus cap for a
 * same-named voice, and neither exists in a browser extension (Orpheus left it
 * in Phase 16, and there is no local catalog here at all). So the refusal is
 * made here first, in this client's own words, and the shared helper's stays
 * underneath as the belt it has always been.
 */
export function bandFromVoiceRow(
  voice: string,
  serverName: string,
  lengths: VoiceLengths,
): ListenChunkBand {
  const refusal = unreadableBecause(voice, serverName, lengths);
  if (refusal !== null) throw new Error(refusal);
  return listenBandFromCaps(voice, {
    safeMinChars: lengths.safeMinChars,
    safeMaxChars: lengths.safeMaxChars,
    maxChars: lengths.maxChars,
  });
}

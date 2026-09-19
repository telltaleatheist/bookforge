/**
 * ONE LIST ANSWERS BOTH QUESTIONS — what the narration modal OFFERS, and what it
 * ACCEPTS.
 *
 * ── The defect this file is ────────────────────────────────────────────────
 *
 * The modal drew its dropdown from the SERVERS' picker (`VoicePickerDto` —
 * "which machines can speak which voice", asked over the tailnet on every open)
 * and then validated the choice against the flat LOCAL catalog
 * (`narrationVoicesFor`, a shipped file plus what `higgs-models.json` names).
 * Two lists, two authorities, and the gap between them is visible to a user in
 * both directions:
 *
 *   - a voice a SERVER serves that this machine's catalog does not list was
 *     OFFERED in the dropdown and then refused, in a sentence that named the
 *     wrong place — *"is not a Higgs voice on this machine"* — about a render
 *     that was never going to happen on this machine;
 *   - a voice the PICKER marks unavailable (the 3090 has it, the weights are
 *     not pulled) was judged by the CATALOG's `unavailable`, which knows only
 *     about this disk — so the refusal named a local reference clip when the
 *     server's own sentence said to pull weights, and the person went to the
 *     wrong machine.
 *
 * So the offer is made ONCE, here, and the validator reads the same object the
 * dropdown was drawn from. A voice that can be picked is a voice that is
 * accepted; a voice that is refused says so in the words of whoever refused it.
 *
 * ── Why the catalog is still in here ───────────────────────────────────────
 *
 * It is not a fallback in the banned sense. `voicePicker()` is `null` until the
 * servers answer, and a modal that showed NO voices at all until a sleeping Mac
 * timed out would be a worse bug than the one this fixes. The catalog is a real,
 * shipped roster; the offer says which of the two it is (`source`), and the
 * modal draws the "no server answered" warning beside it. What must never
 * happen is presenting the catalog's answer AS the machines' answer, and
 * `source` is what stops that: every refusal below is worded from it.
 *
 * Pure — no Angular, no IPC, no `window` — so both the renderer and a keeper
 * can drive it (`tools/test-narration-voice-choice.js`).
 */

import type { VoicePickerDto } from './voice-picker-dto';
import type { NarrationVoice } from './narration-voices';

/** One row of the offer. `unavailable` is a SENTENCE or null, never ''. */
export interface OfferedVoice {
  readonly value: string;
  readonly label: string;
  readonly unavailable: string | null;
}

/**
 * One group of rows.
 *
 * The picker's sections are "the set of machines that can render everything
 * inside this", and `locks` says choosing here pins the venue (Owen's rule,
 * 2026-09-15). The catalog has no sections and no servers, so it answers one
 * unlabelled group that locks nothing — which is the truthful shape for a list
 * that cannot see a machine at all.
 */
export interface OfferedVoiceSection {
  readonly label: string;
  readonly locks: boolean;
  readonly voices: readonly OfferedVoice[];
}

/**
 * WHO MADE THIS OFFER. Read by every refusal below, because "this machine's
 * catalog does not list it" and "no server that answered serves it" send a
 * person to two different places.
 */
export type VoiceOfferSource = 'servers' | 'catalog';

export interface VoiceOffer {
  readonly source: VoiceOfferSource;
  readonly sections: readonly OfferedVoiceSection[];
}

/**
 * The offer: the servers' answer when there is one, the shipped catalog until
 * then.
 *
 * `picker === null` is "nobody has asked the servers yet, or they could not be
 * asked" — a real state, distinct from a picker that answered with nothing.
 */
export function voiceOffer(
  picker: VoicePickerDto | null,
  catalog: readonly NarrationVoice[],
): VoiceOffer {
  if (picker !== null) {
    return {
      source: 'servers',
      sections: picker.sections.map((section) => ({
        label: section.label,
        locks: section.locks,
        voices: section.voices.map((v) => ({
          value: v.value,
          label: v.label,
          unavailable: v.unavailable,
        })),
      })),
    };
  }
  return {
    source: 'catalog',
    sections: [{
      label: '',
      locks: false,
      voices: catalog.map((v) => ({
        value: v.value,
        label: v.label,
        unavailable: v.unavailable ?? null,
      })),
    }],
  };
}

/** Every row of the offer, flat — the set a choice is checked against. */
export function offeredVoices(offer: VoiceOffer): readonly OfferedVoice[] {
  return offer.sections.flatMap((section) => section.voices);
}

/** The row this value is, or null when the offer does not carry it. */
export function offeredVoice(offer: VoiceOffer, value: string): OfferedVoice | null {
  return offeredVoices(offer).find((v) => v.value === value) ?? null;
}

/**
 * Is this value one the offer carries at all? (Not "can it render" — see
 * {@link refuseVoiceChoice}.)
 */
export function offerCarries(offer: VoiceOffer, value: string): boolean {
  return offeredVoice(offer, value) !== null;
}

/**
 * Why this choice cannot be run, in the words of whoever refused it — or null.
 *
 * THE CHOICE IS NEVER REPLACED. Owen's rule after the 2026-09-06 render of
 * *Working Towards the Fuhrer* in the base speaker: a voice that does not belong
 * is refused BY NAME, never resolved to some list's first entry.
 *
 * AN EMPTY OFFER IS NOT EVIDENCE. The servers are asked on every open and the
 * catalog loads asynchronously, so "the list has nothing in it" means the answer
 * has not arrived — refusing on it would block the button for the second the
 * modal takes to fill.
 */
export function refuseVoiceChoice(
  offer: VoiceOffer,
  chosen: string,
  engineName: string,
): string | null {
  if (chosen === '') {
    return `No ${engineName} voice is chosen. Pick one on the Reading tab.`;
  }
  const rows = offeredVoices(offer);
  if (rows.length === 0) return null;

  const found = rows.find((v) => v.value === chosen);
  if (found === undefined) {
    return offer.source === 'servers'
      ? `"${chosen}" is not a voice any Crucible server that answered can speak. Pick one on the `
        + 'Reading tab — the choice is never replaced with another voice.'
      : `"${chosen}" is not a ${engineName} voice in this machine's catalog. Pick one on the `
        + 'Reading tab — the choice is never replaced with another voice.';
  }
  if (found.unavailable !== null) {
    /*
     * THE REFUSER'S OWN FIRST SENTENCE. The picker's reason is the SERVER's
     * words and may name two machines refusing for two different reasons
     * ("3090 Ti: pull the weights · M1 Ultra: install the env"); the catalog's
     * is about this disk. Either way it is quoted, not paraphrased, because it
     * is the only thing that says where to go.
     */
    return `The voice "${cleanVoiceLabel(found.label)}" cannot render yet: `
      + `${firstSentence(found.unavailable)}. Pick another voice on the Reading tab.`;
  }
  return null;
}

/**
 * The label without the picker's own "not installed yet" tail, which the
 * refusal restates in full a few words later.
 */
function cleanVoiceLabel(label: string): string {
  return label.replace(/ — not installed yet$/, '');
}

/** The first sentence of a reason, so a multi-machine refusal does not run on. */
function firstSentence(reason: string): string {
  return reason.split('.')[0] ?? reason;
}

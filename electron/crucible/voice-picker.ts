/**
 * THE NARRATION VOICE PICKER'S LIST — the catalog and the machines, composed.
 *
 * ── What each side owns ────────────────────────────────────────────────────
 *
 * `voice-inventory.ts` asks the servers which voices they can speak, in THEIR
 * ids. `higgs-models.ts` owns BookForge's catalog, in ITS ids, and owns the two
 * facts no server can answer: what a voice is CALLED in this app, and whether
 * the reference clip for a carried zero-shot voice is on this disk.
 *
 * Neither is the picker. This file is, and it exists so that neither of the
 * other two grows a half-copy of the other's job — the shape that produced the
 * defect in the first place (a catalog answering a question about a machine).
 *
 * ── The two kinds of voice, and why they are not one kind ──────────────────
 *
 * A CHECKPOINT voice's speaker is in weights that live on the server. Whether
 * it can render is entirely the server's answer, and this machine's disk has
 * nothing to say about it. `CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE` maps the ids
 * (mostly the same word; `default` is Crucible's `higgs-default`, because on a
 * server "default" would have to mean something about the server).
 *
 * A CARRIED voice — the four `zeroshot-*` entries — is the base weights plus a
 * clip THIS APP uploads, because `crucible/voices/zeroshot.toml` is
 * `clips = "from-request"`: the wavs were never published, and Crucible can only
 * pull a published artifact at a pinned revision. So there is one server-side id
 * standing in for four, the servers say only whether they will TAKE a clip, and
 * this machine says whether it HAS one. Both are needed; see
 * `placeCarriedVoices`.
 *
 * ── One approximation, stated rather than hidden ───────────────────────────
 *
 * The local check for a carried voice includes `refuseOversizedReference`, whose
 * seconds cap comes from THIS machine's arm rather than the venue's. It is not
 * binding today — the four clips are ~15 s against narrator's 30 s budget — and
 * it is not the enforcement either: `shared/crucible/voice-reference.ts` checks
 * the wav against the SERVER's own codes before anything is sent, and the server
 * decides. It is written down here because an arm-derived number in a
 * venue-derived answer is exactly the thing this module was built to end, and
 * the next person to widen a clip past 30 s should find this paragraph rather
 * than a surprise.
 */

import {
  listHiggsModels,
  higgsVoiceUnavailableReason,
  PICKER_HIDDEN_VOICE_KINDS,
  SELECTABLE_VOICE_KINDS,
} from '../higgs-models';
import { CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE } from './render';
import type {
  VoicePickerDto,
  VoicePickerSection,
} from '../../shared/tts/voice-picker-dto';
import {
  readVoiceInventory,
  placeVoices,
  placeCarriedVoices,
  sectionVoices,
  narratorEnginesServed,
  type CarriedVoice,
  type VoiceInventory,
  type VoicePlacement,
  type VoiceSection,
} from './voice-inventory';
import { bookforgeEngineForNarrator } from '../narrator-spawn';

/*
 * THE WIRE SHAPE IS `shared/tts/voice-picker-dto.ts` AND IS NOT RESTATED HERE.
 *
 * Three sides read it — this builder, preload's door, the renderer's service —
 * and a second declaration is a second answer to "what does the picker return".
 * The import is RELATIVE because this is a main-process module: `@shared/*`
 * resolves at compile time and breaks at runtime in `electron/` (see the
 * memory note of the same name).
 */

/**
 * Turn the catalog's carried (zero-shot) entries into what the placer needs.
 *
 * `higgsVoiceUnavailableReason` is the LOCAL question and, for these four, the
 * right one: this app holds the bytes, so its disk decides. Kept as the single
 * call rather than reaching for `refuseMissingReferenceClip` directly, because
 * the catalog's other local refusals — a malformed voice, an untranscribed clip
 * — are equally this machine's to make and equally fatal, and splitting them
 * would be two lists that can disagree.
 */
function carriedVoicesOf(userDataDir: string): CarriedVoice[] {
  return listHiggsModels()
    .filter((m) => m.kind === 'clips' && SELECTABLE_VOICE_KINDS.has(m.kind))
    .map((m) => {
      const reason = higgsVoiceUnavailableReason(m, userDataDir);
      return { id: m.id, display: m.label, clipPresent: reason === null, reason };
    });
}

/**
 * Server placements, re-keyed from Crucible's voice ids to BookForge's.
 *
 * A Crucible voice this app has no id for is DROPPED rather than shown under its
 * server-side name. The picker's `value` has to be something `resolveHiggsModel`
 * can resolve — an unmapped id would be a row that cannot be selected into a
 * render — and `zeroshot` in particular must not appear here: it is the stand-in
 * for the four carried entries and is placed by `placeCarriedVoices` instead,
 * so listing it as well would offer the base model's OWN speaker as a fifth
 * voice under a name nobody chose.
 */
function reKeyToCatalog(placements: readonly VoicePlacement[]): VoicePlacement[] {
  const bookforgeIdOf = new Map<string, string>();
  for (const [ours, theirs] of Object.entries(CRUCIBLE_VOICE_BY_BOOKFORGE_VOICE)) {
    bookforgeIdOf.set(theirs, ours);
  }
  const labelOf = new Map(listHiggsModels().map((m) => [m.id, m.label]));
  // The base model is never offered (Owen, 2026-09-25) — see PICKER_HIDDEN_VOICE_KINDS.
  const hidden = new Set(listHiggsModels().filter((m) => PICKER_HIDDEN_VOICE_KINDS.has(m.kind)).map((m) => m.id));

  return placements.flatMap((placement) => {
    const ours = bookforgeIdOf.get(placement.id);
    if (ours === undefined) return [];
    if (hidden.has(ours)) return [];
    const label = labelOf.get(ours);
    if (label === undefined) {
      throw new Error(
        `Crucible voice "${placement.id}" maps to BookForge voice "${ours}", which is not in the `
        + 'catalog. The mapping and the catalog are two halves of one fact and they disagree; '
        + 'a render would resolve the id and fail after the venue was chosen.',
      );
    }
    return [{ ...placement, id: ours, display: label }];
  });
}

/** Why a voice cannot be chosen — the servers' own words, or none. */
function unavailableSentence(placement: VoicePlacement, inventory: VoiceInventory): string | null {
  if (placement.servedBy.length > 0) return null;
  if (placement.blocked.length > 0) {
    /*
     * The SERVERS' reasons, each named with the machine that gave it. Two
     * machines refusing for two different reasons is two sentences: "pull the
     * weights on the 3090" and "install the env on the Mac" send a person to
     * different places, and one merged sentence would send them to neither.
     */
    return placement.blocked.map((b) => `${b.server}: ${b.reason}`).join(' · ');
  }
  const answered = inventory.servers.filter((s) => s.state === 'answered').length;
  return answered === 0
    ? 'No Crucible server answered, so nothing is known about this voice.'
    : 'No server that answered serves this voice.';
}

/**
 * The whole list, asked of the machines.
 *
 * One `GET /v1/voices` per enabled server, in parallel, per call. NOT cached:
 * the answer changes when a server is switched on, when weights finish pulling
 * and when a machine wakes up, and a picker showing a stale list is the defect
 * this replaces wearing newer clothes. It is one round trip against a person
 * opening a dropdown.
 */
export async function narrationVoicePicker(userDataDir: string): Promise<VoicePickerDto> {
  const inventory = await readVoiceInventory();
  const placements = [
    ...reKeyToCatalog(placeVoices(inventory)),
    ...placeCarriedVoices(inventory, carriedVoicesOf(userDataDir)),
  ];

  const sections: VoicePickerSection[] = sectionVoices(inventory, placements).map(
    (section: VoiceSection) => ({
      label: section.label,
      /*
       * COPIED, not aliased. Everything above this line is readonly on purpose;
       * the DTO is a structured-clone payload and must be plain. Spreading here
       * is the one place the two conventions meet, and it also means nothing
       * downstream can mutate the inventory's own arrays through the reply.
       */
      servers: [...section.servers],
      locks: section.locks,
      voices: section.voices.map((placement) => ({
        value: placement.id,
        label: placement.display,
        servers: [...placement.servedBy],
        unavailable: unavailableSentence(placement, inventory),
      })),
    }),
  );

  const missing = inventory.servers.flatMap((entry) => {
    if (entry.state === 'answered') return [];
    return [{
      server: entry.server,
      why: entry.state === 'disabled'
        ? 'switched off in Settings, so its voices are not listed'
        : entry.reason,
    }];
  });

  /*
   * THE ENGINE STRIP'S LIST, from the machines rather than from this disk.
   *
   * An engine narrator names and BookForge has no word for is DROPPED rather
   * than passed through under its server-side spelling: the modal's strip is
   * keyed by BookForge's own engine ids and a row nothing can resolve would be
   * a button that refuses itself when pressed. `bookforgeEngineForNarrator`
   * reads the ONE table both directions, so `higgs-v3` cannot come to mean two
   * things in two files.
   */
  const engines = [...new Set(
    narratorEnginesServed(inventory)
      .map((id) => bookforgeEngineForNarrator(id))
      .filter((id): id is NonNullable<typeof id> => id !== null),
  )];

  return { sections, engines, missing, complete: inventory.complete, askedAt: new Date().toISOString() };
}

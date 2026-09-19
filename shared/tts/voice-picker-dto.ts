/**
 * THE NARRATION PICKER'S GROUPED LIST, as it crosses the IPC boundary.
 *
 * Shared because three sides read it and there must be one definition: main
 * builds it (`electron/crucible/voice-picker.ts`), preload declares the door,
 * and the renderer draws it. Structural — no SDK types, no main-process imports
 * — so declaring it costs the browser bundle nothing.
 *
 * ── What the shape is protecting ───────────────────────────────────────────
 *
 * Owen's rulings, 2026-09-15: voices are grouped by the SET of Crucible servers
 * that can render them, and *"if the user picks a voice that exists on the 3090
 * but not on m1 ultra, the server selection is locked to the 3090."*
 *
 * That makes the list a ROUTING surface, not a cosmetic one, and it is why
 * {@link VoicePickerDto.missing} is carried rather than left for the caller to
 * infer. A server that is asleep, unreachable or switched off contributes no
 * voices; if that were read as "it does not have them", a voice BOTH machines
 * serve would present as 3090-only the moment the Mac slept and the lock would
 * pin a book to the PC with nobody choosing it — every screen healthy. So the
 * servers that did not answer travel WITH the list that is missing them.
 */

/** One row of the dropdown. `value` is the voice id a render resolves. */
export interface VoicePickerVoice {
  value: string;
  label: string;
  /** The machines that can render it. Empty means none can, and `unavailable` says why. */
  servers: string[];
  /**
   * Why it cannot be chosen, in the refusing machine's own words, or `null`.
   *
   * Never an empty string, and never merged across machines when they refuse for
   * different reasons: "pull the weights on the 3090" and "install the env on
   * the Mac" send a person to different places.
   */
  unavailable: string | null;
}

/** One section: the set of machines that can render everything inside it. */
export interface VoicePickerSection {
  /** "Every server", "3090 Ti", "3090 Ti + M1 Ultra". */
  label: string;
  servers: string[];
  /**
   * Choosing any voice here PINS the venue to `servers`.
   *
   * False on a one-server setup even though every section has one server: a
   * lock is about losing a choice, and there is no choice to lose. A warning
   * there would warn about an alternative that does not exist.
   */
  locks: boolean;
  voices: VoicePickerVoice[];
}

export interface VoicePickerDto {
  /** Widest set first, so the options that cost no routing freedom come first. */
  sections: VoicePickerSection[];
  /**
   * THE ENGINES THE ANSWERING MACHINES RUN, as BOOKFORGE spells them (`higgs`).
   *
   * Carried for the same reason the voices are, and it is the same defect one
   * level up: the narration modal's Engine strip was built from
   * `selectableEngines(isInstalled)` — whether the engine's component was
   * installed on the box DRAWING the dialog — while the render happens on a
   * Crucible server. BookForge deciding from its own disk about another
   * machine's card, exactly as the voice list did before `voice-inventory.ts`.
   *
   * Derived from each server's `/v1/voices` rows (`narratorEngine`, re-keyed
   * through `bookforgeEngineForNarrator`), so a machine that serves a Higgs
   * voice is a machine that runs Higgs. A server that did not answer
   * contributes nothing — read it beside {@link VoicePickerDto.missing}, never
   * as "that machine cannot".
   *
   * EMPTY IS A REAL STATE and is not "no engines exist": it means no server
   * that answered named one. The modal offers the catalog's engines then, with
   * the missing-server warning beside them — never an empty strip with no
   * sentence.
   */
  engines: string[];
  /** Registered servers whose voices are UNKNOWN, and why. Drawn, never hidden. */
  missing: Array<{ server: string; why: string }>;
  /** False when any registered server did not answer. */
  complete: boolean;
  /**
   * WHEN THE MACHINES WERE ASKED — ISO 8601, minted by the builder.
   *
   * The picker is a SNAPSHOT: it is taken once when the modal opens and a
   * server that wakes while the dialog is up stays in `missing` until somebody
   * asks again. The modal draws this as "as of <time>" beside a Re-check
   * button, so the list is read as a moment rather than as a standing fact.
   */
  askedAt: string;
}

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
  /** Registered servers whose voices are UNKNOWN, and why. Drawn, never hidden. */
  missing: Array<{ server: string; why: string }>;
  /** False when any registered server did not answer. */
  complete: boolean;
}

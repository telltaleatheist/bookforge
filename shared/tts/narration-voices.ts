/**
 * WHICH VOICES A NARRATION MAY BE RENDERED IN — the catalog rule, declared once
 * for every process that has to offer the choice.
 *
 * ── Why this is in `shared/` ────────────────────────────────────────────────
 *
 * It used to be entirely inside `NarrationVoicesService` (the renderer), which
 * was the right home while the only door that asked was a modal in this window.
 * The narrate operation Foundry draws in ITS window changed that: the field
 * description crossing the seam has to carry a list of options, it is built in
 * BookForge's MAIN process, and there is no renderer in the conversation
 * (`bookforge.narrate`, electron/main.ts).
 *
 * A second list in main would be a second answer to "what voices are there" —
 * the exact bug the runtime load replaced a hardcoded list to fix, since a voice
 * offered from a stale copy is a run that fails an hour in with a reference clip
 * that is not on disk. So the two things that are NOT a live disk read — the
 * built-in Orpheus roster and the rule for folding custom models into it — live
 * here, and both processes read them.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * The reads themselves. `getAudiobookVoiceOptions()` (installed XTTS voices) and
 * `listOrpheusModels()` (custom Orpheus folders) are main-process functions that
 * touch disk and the component registry; the renderer reaches them over
 * `voices:list-audiobook` and `orpheus:list-models`, and main calls them
 * directly. This module takes their ANSWERS and says what to do with them.
 */

/** One choosable voice: what travels in a run's config, and what a person reads. */
export interface NarrationVoice {
  readonly value: string;
  readonly label: string;
}

/**
 * The Orpheus voices this build ships, ordered best → worst prosody
 * (user-ranked), accent in the label.
 *
 * NOT A FALLBACK. They are voices the Orpheus engine genuinely has — there is no
 * disk read that could discover or contradict them — which is why the list is
 * stated rather than fetched. What IS discovered is the custom models a user has
 * put in the models folder, and `mergeOrpheusVoices` says how the two meet.
 */
export const ORPHEUS_BUILTIN_VOICES: readonly NarrationVoice[] = [
  { value: 'leah', label: 'Leah (Female, American)' },
  { value: 'tara', label: 'Tara (Female, American)' },
  { value: 'zoe', label: 'Zoe (Female, American)' },
  { value: 'mia', label: 'Mia (Female, American)' },
  { value: 'jess', label: 'Jess (Female, American)' },
  { value: 'zac', label: 'Zac (Male, American)' },
  { value: 'dan', label: 'Dan (Male, Cockney)' },
  { value: 'leo', label: 'Leo (Male, American)' },
];

/**
 * The built-ins plus whatever custom models were discovered, with collisions
 * resolved in the custom model's favour.
 *
 * A CUSTOM FOLDER OF THE SAME NAME *IS* THAT VOICE NOW — the built-in it collides
 * with is dropped rather than listed twice, because two rows spelled `leah` are
 * two rows the user cannot tell apart and only one of them is what the engine
 * would load.
 */
export function mergeOrpheusVoices(
  custom: readonly NarrationVoice[],
): readonly NarrationVoice[] {
  const claimed = new Set(custom.map((one) => one.value));
  return [...ORPHEUS_BUILTIN_VOICES.filter((one) => !claimed.has(one.value)), ...custom];
}

/**
 * The voices THIS engine can be asked for.
 *
 * Orpheus has a roster of its own; everything else (XTTS, F5, Voxtral) renders
 * from the XTTS-family reference clips, which is what the installed-voice list
 * describes. One function so the modal and the host operation cannot disagree
 * about which list belongs to which engine.
 */
export function narrationVoicesFor(
  engine: string,
  catalog: { readonly xtts: readonly NarrationVoice[]; readonly orpheus: readonly NarrationVoice[] },
): readonly NarrationVoice[] {
  return engine === 'orpheus' ? catalog.orpheus : catalog.xtts;
}

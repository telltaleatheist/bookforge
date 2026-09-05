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
 * The reads themselves. `listOrpheusModels()` (custom Orpheus folders) is a
 * main-process function that touches disk and the component registry; the
 * renderer reaches it over `orpheus:list-models`, and main calls it directly.
 * This module takes those ANSWERS and says what to do with them. (There was a
 * second such read — `getAudiobookVoiceOptions()`, the installed XTTS voices,
 * over `voices:list-audiobook`. Both went with the engine on 2026-09-05.)
 */

/** One choosable voice: what travels in a run's config, and what a person reads. */
export interface NarrationVoice {
  readonly value: string;
  readonly label: string;
  /**
   * Why this voice cannot be chosen, or absent when it can.
   *
   * A voice that is LISTED but not RENDERABLE is a real state — a Higgs catalog
   * entry whose artifact has not landed is the case this exists for. Omitting it
   * from the list would leave nothing anywhere saying the voice exists; offering
   * it as though it worked queues a run that dies at preflight. So it is listed,
   * disabled, and carries the reason as its tooltip.
   *
   * Present on the option means the picker must render it `disabled`; a caller
   * that ignores this is offering a voice it will then refuse.
   */
  readonly unavailable?: string;
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
 * ── Why this is a switch and no longer a ternary ────────────────────────────
 *
 * It used to read `engine === 'orpheus' ? catalog.orpheus : catalog.xtts`, i.e.
 * every engine that was not Orpheus was ASSUMED to render from the XTTS-family
 * reference clips. That was true while the other engines were XTTS, F5 and
 * Voxtral, and it is a trap the moment a fourth engine exists: adding Higgs
 * without touching this line would have offered the Higgs picker a list of XTTS
 * reference clips, every one of which is a voice Higgs cannot be asked for — and
 * nothing would have failed until a render came back in the wrong voice.
 *
 * So the mapping is now explicit per engine and an unknown engine THROWS rather
 * than defaulting into somebody else's roster. That is the same rule the rest of
 * this module already follows: never offer a voice that is not there.
 */
export function narrationVoicesFor(
  engine: string,
  catalog: {
    readonly orpheus: readonly NarrationVoice[];
    readonly higgs: readonly NarrationVoice[];
  },
): readonly NarrationVoice[] {
  switch (engine) {
    case 'orpheus':
      return catalog.orpheus;
    case 'higgs':
      return catalog.higgs;
    // Retired, but still reachable from a saved setting or an old job record
    // being displayed. EMPTY, and that is the only honest answer left: these
    // engines' voice catalogs were removed from the build on 2026-09-05 (the
    // XTTS list was a live read of installed checkpoints, and there is nothing
    // to read), so there is no list to show. A record that names one of these
    // still LOADS and still displays its voice string; what no longer exists is
    // a set of alternatives to offer. The refusal to RENDER lives in
    // `assertRunnableTtsEngine`, not here.
    case 'xtts':
    case 'f5':
    case 'voxtral':
      return [];
    default:
      throw new Error(
        `No voice catalog is defined for TTS engine "${engine}" — refusing to offer another ` +
          `engine's voices. Add a case here when the engine is added.`,
      );
  }
}

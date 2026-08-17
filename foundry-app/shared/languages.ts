/**
 * shared/languages — the app's mirror of `src/translate/languages.ts`.
 *
 * THE TWO TABLES GROW TOGETHER, in the same commit, always — the same
 * arrangement `app/shared/book.ts` has with the engine's writer. The engine
 * owns the rule (a model is told a LANGUAGE, never a code; the tag goes into
 * `dc:language`; the name goes into the prompt) and this side owns the asking:
 * the Translate dialog offers these languages by their names, and what it sends
 * across the boundary is only ever the TAG. A name the user types by hand is
 * resolved to a tag HERE and travels as that tag or not at all, which is what
 * makes the free-text box safe by construction — no typed text ever reaches a
 * prompt, a filename or a package; the engine names the tag again for itself
 * from its own table or from ICU.
 *
 * ── Why the long tail is ICU on both sides ───────────────────────────────────
 *
 * The curated list is the engine's own: languages whose prompt wording was
 * chosen on purpose, plus the regional pairs where naming the region is the
 * difference between right and wrong (Brazilian Portuguese is not European
 * Portuguese). Everything else — Swahili, Georgian, Tamil — lives in the ISO
 * registry that ships inside the runtime, reachable through
 * `Intl.DisplayNames`, and the engine consults the same registry before it
 * refuses a tag. Two processes, one registry, no second list to drift.
 */

export interface LanguageChoice {
  /** What crosses every boundary: BCP-47, exactly as the engine takes it. */
  tag: string;
  /** What a person is shown and may type. */
  name: string;
}

/**
 * Mirror of the engine's `LANGUAGES` map — primary subtag → English name.
 * One entry added there is one entry added here, same commit.
 */
const LANGUAGES: ReadonlyMap<string, string> = new Map(Object.entries({
  ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan', cs: 'Czech',
  da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish',
  et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew',
  hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', id: 'Indonesian', is: 'Icelandic',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', la: 'Latin', lt: 'Lithuanian',
  lv: 'Latvian', ms: 'Malay', nl: 'Dutch', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sl: 'Slovenian',
  sr: 'Serbian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
  ur: 'Urdu', vi: 'Vietnamese', yi: 'Yiddish', zh: 'Chinese',
}));

/** Mirror of the engine's `REGIONAL` map — whole tag → the name that matters. */
const REGIONAL: ReadonlyMap<string, string> = new Map(Object.entries({
  'pt-BR': 'Brazilian Portuguese',
  'pt-PT': 'European Portuguese',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  'en-GB': 'British English',
  'en-US': 'American English',
  'es-419': 'Latin American Spanish',
  'nb-NO': 'Norwegian Bokmål',
  'sr-Latn': 'Serbian (Latin script)',
}));

/** The engine's own shape test for a tag, verbatim. */
const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * What the dropdowns list: every curated language and regional pair, by name.
 *
 * The regional spellings the engine also accepts (`zh-CN`, `zh-TW`, `zh-HK`)
 * are deliberately not rows — they are alternate tags for names already listed,
 * and a list is for choosing a language, not for enumerating its spellings.
 */
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  ...[...LANGUAGES.entries()].map(([tag, name]) => ({ tag, name })),
  ...[...REGIONAL.entries()].map(([tag, name]) => ({ tag, name })),
].sort((a, b) => a.name.localeCompare(b.name, 'en'));

/**
 * The name a tag is shown under — for the read-only field a chained
 * translation fixes. The curated tables answer first for the engine's reason
 * (their wordings are chosen), ICU answers the tail, and a tag neither knows
 * is shown as itself, which for a read-only fact is honest enough.
 */
export function languageNameFor(tag: string): string {
  const trimmed = tag.trim();
  const regional = [...REGIONAL.entries()]
    .find(([spelled]) => spelled.toLowerCase() === trimmed.toLowerCase());
  if (regional !== undefined) return regional[1];
  const primary = LANGUAGES.get((trimmed.split('-')[0] ?? trimmed).toLowerCase());
  if (primary !== undefined) return trimmed.includes('-') ? `${primary} (${trimmed})` : primary;
  return intlNameOf(trimmed) ?? trimmed;
}

/** One ICU lookup; undefined-or-echo means the registry has no name for it. */
function intlNameOf(tag: string): string | null {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return name !== undefined && name.toLowerCase() !== tag.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

/**
 * name → tag over the whole ISO registry, built once and only when the
 * free-text box is first used.
 *
 * BUILT BY ENUMERATION because the registry cannot be walked: `Intl` answers
 * "what is `sw` called" and never "what languages exist", so the index tries
 * every two-letter code and then every three-letter code and keeps the ones
 * the registry names. Two-letter codes go in first and are never displaced —
 * where ISO 639 has both spellings for one language, the two-letter one is
 * the tag everything else (fonts, dictionaries, readers) expects.
 */
let nameIndex: Map<string, string> | null = null;

function indexOfNames(): Map<string, string> {
  if (nameIndex !== null) return nameIndex;
  const index = new Map<string, string>();
  const claim = (name: string, tag: string): void => {
    const key = name.toLowerCase();
    if (!index.has(key)) index.set(key, tag);
  };
  // The curated names claim their tags first, so "Chinese" is `zh` here for
  // the same reason it is `zh` in the dropdown, whatever ICU would prefer.
  for (const [tag, name] of REGIONAL) claim(name, tag);
  for (const [tag, name] of LANGUAGES) claim(name, tag);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const display = new Intl.DisplayNames(['en'], { type: 'language' });
  const consider = (tag: string): void => {
    try {
      const name = display.of(tag);
      if (name !== undefined && name.toLowerCase() !== tag) claim(name, tag);
    } catch {
      // A code the registry rejects outright is simply not a language.
    }
  };
  for (const a of letters) for (const b of letters) consider(a + b);
  for (const a of letters) for (const b of letters) for (const c of letters) consider(a + b + c);
  nameIndex = index;
  return index;
}

/**
 * Resolve what a person TYPED into a tag, or null.
 *
 * Accepts a language name in any casing ("swahili", "Swahili") and, as a
 * courtesy to the person who does know tags, a well-formed tag whose language
 * the registry or the tables can name. Everything else is null, and null never
 * leaves the dialog — which is the entire security argument: the typed string
 * is a lookup key here and is never itself sent, stored, or prompted with.
 */
export function tagForLanguageName(typed: string): string | null {
  const folded = typed.trim().replace(/\s+/g, ' ');
  if (folded.length === 0 || folded.length > 60) return null;
  const byName = indexOfNames().get(folded.toLowerCase());
  if (byName !== undefined) return byName;
  if (TAG.test(folded)) {
    const primary = (folded.split('-')[0] ?? folded).toLowerCase();
    if (LANGUAGES.has(primary) || intlNameOf(primary) !== null) return folded;
  }
  return null;
}

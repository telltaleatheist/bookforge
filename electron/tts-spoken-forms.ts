/**
 * tts-spoken-forms.ts — what a printed token is ALLOWED to be read as.
 *
 * ── The ruling this file exists for ─────────────────────────────────────────
 *
 * The one-token law (electron/tts-number-normalizer.ts) checks WHICH token of a
 * span changed. It did not check that what replaced it is a READING of it, and
 * the second adversarial review of 2026-09-04 measured the hole:
 *
 *     FBI      -> Gestapo      APPLIED
 *     SAID     -> whispered    APPLIED
 *     St.      -> Moscow       APPLIED
 *     Part IV  -> Part Nine    APPLIED
 *
 * Every one is a one-token edit of a class token, and every one is a different
 * book. So the division of labour is explicit: THE MODEL DECIDES WHETHER to
 * change a token; THIS FILE DECIDES WHAT IT MAY BECOME.
 *
 * The third review found three more, and they are what the tables below are
 * shaped by rather than merely extended for:
 *
 *  - A reading could DELETE PUNCTUATION. "Dr. Kempner; they" -> "Doctor Kempner
 *    they" and "Oxford St. The rain" -> "Oxford Street The rain" both passed,
 *    fusing two sentences in the user's own working copy.
 *  - A key that is also an ENGLISH WORD was read as an abbreviation anywhere:
 *    "a flat no. The committee" -> "a flat number The committee".
 *  - Any all-caps word over IVXLCDM was forced through the ROMAN table, so "MIX"
 *    could only be read "one thousand nine" and never "M I X".
 *
 * ── The doctrine of the tables ──────────────────────────────────────────────
 *
 * AN UNKNOWN ABBREVIATION IS REFUSED, NEVER GUESSED. There is no fallback that
 * expands "Ptre." to something plausible: a reading nobody wrote down is a
 * reading nobody checked. A refusal is recorded by name (`NOT_A_READING`) with
 * the token in it, so the tokens real books print arrive as a review list and
 * grow this table deliberately.
 *
 * ── This file is a LEAF ─────────────────────────────────────────────────────
 *
 * It imports NOTHING — not even from this repo. The training side vendors the
 * compiled `dist/electron/*.js` and loads them under plain node, and
 * `tts-number-normalizer.js` now requires this one, so it is an eighth vendored
 * file and must not drag `number-expansion.js` or `tts-number-rules.js` behind
 * it. The number WORDS a roman numeral may be read as are therefore passed IN
 * by the caller, which already has them — one definition, no second copy.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Abbreviations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When a table key is ALSO an ordinary English word, what has to stand around it
 * before it counts as an abbreviation at all.
 *
 * "no", "co", "am" and "st" are the measured ones: without a context rule, "a
 * flat no. The committee" read "a flat number The committee" — the wrong word
 * AND a fused sentence. The context is checked against the block, not the span,
 * because that is where the evidence is.
 */
export type AbbreviationContext =
  /** A digit must follow it: "no. 5", never "a flat no." */
  | 'followed-by-digit'
  /** A capitalized word must stand on one side: "St. Petersburg", "Baker St." */
  | 'beside-a-proper-noun'
  /** A number word or digit must precede it: "two a.m.", never "I am." */
  | 'after-a-number';

export interface AbbreviationEntry {
  /**
   * The readings allowed, spelled EXACTLY as they must be written.
   *
   * The replacement must match one of them in case — as written, all lower, or
   * with only the first letter capitalized. Nothing else: "at SAINT Petersburg"
   * was applied and written into a book before this was checked.
   */
  readonly readings: readonly string[];
  /** What must stand around it, when the key is also an English word. */
  readonly context?: AbbreviationContext;
}

/**
 * How a printed abbreviation may be read.
 *
 * Keyed by the token with its periods and its case removed, so "Dr.", "DR." and
 * "dr" are one key. "St." is Saint or Street and only the sentence says which,
 * so both are legal and the model picks.
 *
 * "Mr.", "Mrs." and "Ms." are DELIBERATELY ABSENT: the prompt tells the model to
 * leave them exactly as printed, so an edit naming one is a mistake and is
 * refused rather than quietly allowed.
 */
export const ABBREVIATION_READINGS: ReadonlyMap<string, AbbreviationEntry> = new Map([
  ['dr', { readings: ['Doctor'] }],
  ['prof', { readings: ['Professor'] }],
  ['mt', { readings: ['Mount', 'Mountain'] }],
  ['ave', { readings: ['Avenue'] }],
  ['blvd', { readings: ['Boulevard'] }],
  ['rd', { readings: ['Road'] }],
  ['jr', { readings: ['Junior'] }],
  ['sr', { readings: ['Senior'] }],
  ['nos', { readings: ['numbers'], context: 'followed-by-digit' }],
  ['eg', { readings: ['for example'] }],
  ['ie', { readings: ['that is'] }],
  ['etc', { readings: ['et cetera'] }],
  ['vs', { readings: ['versus'] }],
  ['viz', { readings: ['namely'] }],
  ['cf', { readings: ['compare'] }],
  ['approx', { readings: ['approximately'] }],
  ['dept', { readings: ['department'] }],
  ['govt', { readings: ['government'] }],
  ['univ', { readings: ['university'] }],
  ['corp', { readings: ['corporation'] }],
  ['inc', { readings: ['incorporated'] }],
  ['ltd', { readings: ['limited'] }],
  // ── The keys that are also English words ────────────────────────────────
  ['st', { readings: ['Saint', 'Street'], context: 'beside-a-proper-noun' }],
  ['no', { readings: ['number'], context: 'followed-by-digit' }],
  ['co', { readings: ['company'], context: 'beside-a-proper-noun' }],
  // The meridiems. The clock rule keeps them as printed because they are already
  // said as letters; a model that spells them out is not wrong, and nothing else
  // is. "am" is the verb everywhere else, so it needs the number in front of it.
  ['am', { readings: ['a m'], context: 'after-a-number' }],
  ['pm', { readings: ['p m'] }],
]);

/** The key a printed abbreviation token is looked up by. */
export function abbreviationKey(token: string): string {
  return token.toLowerCase().replace(/[^a-zà-ÿ]/g, '');
}

/** The number words a context rule counts as a number standing before a token. */
const NUMBER_WORD =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|noon|midnight)\s*$/i;

/**
 * Does the block satisfy this key's context rule?
 *
 * `before` and `after` are the block's text either side of the TOKEN, not either
 * side of the edit: a model that extended its find to make it unique must not
 * thereby change what the words around the token are.
 */
export function abbreviationContextRefusal(
  token: string, before: string, after: string,
): ReadingRefusal {
  const entry = ABBREVIATION_READINGS.get(abbreviationKey(token));
  if (entry === undefined || entry.context === undefined) return null;
  switch (entry.context) {
    case 'followed-by-digit':
      if (/^\s*\d/.test(after)) return null;
      return `"${token}" is also an ordinary word, so it is only an abbreviation when a number `
        + 'follows it — and here nothing does';
    case 'after-a-number':
      if (/\d\s*$/.test(before) || NUMBER_WORD.test(before)) return null;
      return `"${token}" is also an ordinary word, so it is only an abbreviation when a number `
        + 'stands in front of it — and here none does';
    case 'beside-a-proper-noun':
      if (/[A-ZÀ-Þ][A-Za-zÀ-ÿ]*[\s,]*$/.test(before) || /^\s*[A-ZÀ-Þ]/.test(after)) return null;
      return `"${token}" is also an ordinary word, so it is only an abbreviation beside a name — `
        + 'and here there is none on either side';
    default:
      return `"${token}" carries a context rule this build does not know`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runs of capitals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The acronyms a person decided are said as a WORD, not as letters.
 *
 * The prompt says so ("NASA, NATO, UNESCO, laser, radar") and the validator has
 * to agree: an edit that spells one of these out is refused, because it is a
 * change nobody asked for in the direction the prompt forbids.
 */
export const SPOKEN_AS_WORD: ReadonlySet<string> = new Set([
  'nasa', 'nato', 'unesco', 'unicef', 'opec', 'aids', 'laser', 'radar', 'scuba', 'nafta',
  'ascii', 'gestapo', 'gulag', 'interpol',
]);

/** Why a proposed reading is not one, or null when it is. */
export type ReadingRefusal = string | null;

/** The letters of a word, spaced and upper-cased — "FBI" -> "F B I". */
export function spacedLetters(token: string): string {
  return [...token.replace(/[^A-Za-zÀ-ÿ]/g, '')].join(' ');
}

/**
 * Is `reading` an allowed reading of the ALL-CAPS token `token`?
 *
 * Two shapes, and no third: the letters of THAT word, spaced ("FBI" -> "F B I"),
 * or the same word in ordinary case, which is the emphasis rule ("SAID" ->
 * "said"). CASE IS PART OF IT — "The f b i had" was applied and written verbatim
 * before this checked it.
 */
export function capsReadingRefusal(token: string, reading: readonly string[]): ReadingRefusal {
  const bare = token.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const said = reading.join(' ');
  if (SPOKEN_AS_WORD.has(bare.toLowerCase())) {
    return `"${token}" is an acronym said as a word, so it is read exactly as printed`;
  }
  if (said === spacedLetters(bare)) return null;
  if (said === bare.toLowerCase()) return null;
  const wrongCase = said.toLowerCase() === spacedLetters(bare).toLowerCase()
    || said.toLowerCase() === bare.toLowerCase();
  return wrongCase
    ? `"${said}" reads "${token}" correctly but in the wrong case — the letters keep the case `
      + `they were printed in ("${spacedLetters(bare)}"), and the emphasis reading is exactly `
      + `lower case ("${bare.toLowerCase()}")`
    : `"${said}" is not a reading of "${token}" — a run of capitals is read as its own letters, `
      + 'spaced, or as the same word in ordinary case';
}

// ─────────────────────────────────────────────────────────────────────────────
// Roman numerals
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical spelling of a value, for the round-trip in `romanValue`. */
function toRoman(n: number): string {
  const PAIRS: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let rest = n;
  let out = '';
  for (const [value, letters] of PAIRS) {
    while (rest >= value) { out += letters; rest -= value; }
  }
  return out;
}

/** The value of a roman-numeral token, or null when it is not one. */
export function romanValue(token: string): number | null {
  const bare = token.toUpperCase().replace(/\./g, '');
  if (bare === '' || !/^[IVXLCDM]+$/.test(bare)) return null;
  const VALUE: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < bare.length; i++) {
    const here = VALUE[bare[i]!]!;
    const next = i + 1 < bare.length ? VALUE[bare[i + 1]!]! : 0;
    total += here < next ? -here : here;
  }
  // Round-trip: a string of legal letters is not necessarily a legal numeral
  // ("IIII", "VV"), and a numeral this cannot re-print is one nobody should read.
  return total > 0 && total < 4000 && toRoman(total) === bare ? total : null;
}

/**
 * The words that make a roman numeral a roman numeral in this sentence.
 *
 * MD, CD, DC, MC, CV, MM, XL, DI, LI, IX, CIV and MIX are all legal numerals AND
 * ordinary acronyms, and the third adversarial review of 2026-09-04 measured what
 * happens when the numeral wins by default: "MIX" could only be read "one
 * thousand nine", and "M I X" was refused. So the numeral reading is offered
 * only where a numeral is what a book prints — after a part word, after a
 * capitalized name (a regnal number), or before a century.
 */
const PART_WORD =
  /\b(?:part|chapter|book|volume|vol|act|section|article|canto|scene|appendix|table|figure|fig|plate|phase|stage|class|type|mark|war)\.?\s*$/i;
/** A capitalized name immediately before it: "Henry VIII", "Pius XII". */
const REGNAL_NAME = /\b[A-ZÀ-Þ][a-zà-ÿ]+\s*$/;
/** A century immediately after it: "XIX century". */
const CENTURY_AFTER = /^\s*(?:century|centuries)\b/i;

/** Is a roman numeral what this block is printing here? */
export function isRomanContext(before: string, after: string): boolean {
  return PART_WORD.test(before) || REGNAL_NAME.test(before) || CENTURY_AFTER.test(after);
}

/**
 * Is `reading` an allowed reading of the ROMAN-NUMERAL token `token`?
 *
 * Exactly the words of its value, cardinal or ordinal, with or without a leading
 * "the". The words are passed IN because this file is a leaf and the one
 * definition of them lives with the number rules.
 */
export function romanReadingRefusal(
  token: string,
  reading: readonly string[],
  words: { cardinal: string | null; ordinal: string | null },
): ReadingRefusal {
  const value = romanValue(token);
  if (value === null) return `"${token}" is not a roman numeral this build can read`;
  const allowed = new Set<string>();
  for (const form of [words.cardinal, words.ordinal]) {
    if (form === null) continue;
    for (const plain of [form.toLowerCase(), form.toLowerCase().replace(/-/g, ' ')]) {
      allowed.add(plain);
      allowed.add(`the ${plain}`);
    }
  }
  const said = reading.join(' ').toLowerCase();
  if (allowed.has(said)) return null;
  return `"${reading.join(' ')}" is not a reading of "${token}" — ${token} is ${value}, which `
    + `reads "${words.cardinal}" or "${words.ordinal}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Brackets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shapes a ROUND-bracketed insertion may have and still be apparatus.
 *
 * PATTERNS, not lead words. A lead-word list deleted the book's own asides —
 * "(note she wept)", "(see he lied)", "(source of evil)", "(cited by him)" all
 * went, measured by the third adversarial review of 2026-09-04 — because "see"
 * and "note" and "source" open ordinary prose too. Every pattern here requires
 * something apparatus has and prose does not: a digit, a citation abbreviation,
 * or a fixed editorial term.
 *
 * The page-reference forms admit the READ spellings as well as the printed ones
 * ("see page twelve"), because the deterministic page rule has already run by
 * the time the model sees the block.
 */
const NUMBER_WORDS_RE =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen'
  + '|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty'
  + '|ninety|hundred|thousand|and|to|through|[\\s-])+';

const ROUND_APPARATUS: readonly RegExp[] = [
  /^sic$/i,
  /^eds?\.$/i,
  /^trans\.$/i,
  /^(?:emphasis|italics)\s+(?:added|original|mine|in\s+the\s+original)$/i,
  /^ibid\.$/i,
  /^(?:op|loc)\.\s*cit\.$/i,
  /^cf\.\s+\S+/i,
  // "see p. 12", "see page twelve", "cf. note 4", "see figure three"
  new RegExp('^(?:see|cf\\.?)\\s+(?:pp?\\.|pages?|nn?\\.|notes?|figs?\\.|figures?|tables?'
    + '|chaps?\\.|chapters?|vols?\\.|volumes?)\\s+(?:\\d|' + NUMBER_WORDS_RE + ')', 'i'),
  // A bare page or note reference with no lead word: "p. 23", "page twenty three"
  new RegExp('^(?:pp?\\.|pages?|nn?\\.|notes?)\\s+(?:\\d|' + NUMBER_WORDS_RE + ')$', 'i'),
  /^\d+[a-z]?$/i,
  // A citation: "Kershaw 1993", "Kershaw and Wurm 1993", "Kershaw, 1993"
  /^[A-ZÀ-Þ][A-Za-zÀ-ÿ.'-]+(?:\s+(?:and|&)\s+[A-ZÀ-Þ][A-Za-zÀ-ÿ.'-]+)?,?\s+\d{4}[a-z]?$/,
];

/**
 * The shapes a SQUARE-bracketed insertion may have and still be DELETED.
 *
 * Square brackets are editorial by convention, but an interpolation of WORDS is
 * still something a narrator reads — "[he said]", "[the Fuhrer]", "[God help
 * us]" were all deleted outright before this list existed. What may go is
 * apparatus: a marker, an ellipsis, an editorial abbreviation.
 *
 * The other permitted edit on a square-bracketed span is to DROP THE BRACKETS
 * and keep the words, which the validator handles directly.
 */
const SQUARE_APPARATUS: readonly RegExp[] = [
  /^sic$/i,
  /^eds?\.$/i,
  /^trans\.$/i,
  /^(?:emphasis|italics)\s+(?:added|original|mine|in\s+the\s+original)$/i,
  /^\d+[a-z]?$/i,
  /^\.\.\.$/,
  /^…$/,
  /^[?!*†‡§¶]+$/,
];

/** Why this bracketed insertion may not be removed outright, or null when it may. */
export function bracketRemovalRefusal(find: string): ReadingRefusal {
  const trimmed = find.trim();
  if (trimmed.length < 2) return 'an empty bracket is nothing to remove';
  const open = trimmed[0];
  const inner = trimmed.slice(1, -1).trim();
  const shapes = open === '[' ? SQUARE_APPARATUS : ROUND_APPARATUS;
  if (shapes.some((shape) => shape.test(inner))) return null;
  return open === '['
    ? `"${trimmed}" is an editorial interpolation of words, which a narrator READS. Drop the `
      + 'brackets and keep the words, or leave it; only a marker, an ellipsis or an editorial '
      + 'abbreviation is deleted outright'
    : `"${trimmed}" is in round brackets and is not one of the apparatus shapes — it is the `
      + 'book\'s own aside and is read aloud';
}

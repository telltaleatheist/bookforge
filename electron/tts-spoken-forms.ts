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
 *     SS       -> Gestapo      APPLIED
 *     SAID     -> whispered    APPLIED
 *     St.      -> Moscow       APPLIED
 *     a.m.     -> midnight     APPLIED
 *     Part IV  -> Part Nine    APPLIED
 *
 * Every one of those is a one-token edit of a class token, and every one is a
 * different book. So the division of labour is now explicit: THE MODEL DECIDES
 * WHETHER to change a token; THIS FILE DECIDES WHAT IT MAY BECOME.
 *
 * ── The doctrine of the tables ──────────────────────────────────────────────
 *
 * AN UNKNOWN ABBREVIATION IS REFUSED, NEVER GUESSED. There is no fallback that
 * expands "Ptre." to something plausible: a reading nobody wrote down is a
 * reading nobody checked, and the whole point of the pass is that what the voice
 * says was decided by a person once rather than by a model per book. A refusal
 * is recorded by name (`NOT_A_READING`) with the token in it, so the tokens a
 * real book actually prints arrive as a review list and grow this table
 * deliberately.
 *
 * The tables are built from `electron/prompts/tts-narration-text.txt`'s own
 * classes and from the abbreviations the reviewer named. They are ENGLISH and
 * they are small on purpose.
 */
import { ordinalToWords } from './number-expansion.js';
import { cardinalWords } from './tts-number-rules.js';

/**
 * How a printed abbreviation may be read.
 *
 * Keyed by the token with its periods and its case removed, so "Dr.", "DR." and
 * "dr" are one key. Each entry lists EVERY reading allowed for it — "St." is
 * Saint or Street and only the sentence says which, so both are legal and the
 * model picks.
 *
 * "Mr.", "Mrs." and "Ms." are DELIBERATELY ABSENT: the prompt tells the model to
 * leave them exactly as printed, because every voice already says them
 * correctly, so an edit naming one is a mistake and must be refused rather than
 * quietly allowed.
 */
export const ABBREVIATION_READINGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['dr', ['doctor']],
  ['prof', ['professor']],
  ['st', ['saint', 'street']],
  ['mt', ['mount', 'mountain']],
  ['ave', ['avenue']],
  ['blvd', ['boulevard']],
  ['rd', ['road']],
  ['jr', ['junior']],
  ['sr', ['senior']],
  ['no', ['number']],
  ['nos', ['numbers']],
  ['eg', ['for example']],
  ['ie', ['that is']],
  ['etc', ['et cetera']],
  ['vs', ['versus']],
  ['viz', ['namely']],
  ['cf', ['compare']],
  ['approx', ['approximately']],
  ['dept', ['department']],
  ['govt', ['government']],
  ['univ', ['university']],
  ['co', ['company']],
  ['corp', ['corporation']],
  ['inc', ['incorporated']],
  ['ltd', ['limited']],
  // The meridiems. The clock rule keeps them as printed because they are already
  // said as letters; a model that spells them out is not wrong, and nothing else
  // is allowed.
  ['am', ['a m']],
  ['pm', ['p m']],
]);

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
    const here = VALUE[bare[i]];
    const next = i + 1 < bare.length ? VALUE[bare[i + 1]] : 0;
    total += here < next ? -here : here;
  }
  // Round-trip: a string of legal letters is not necessarily a legal numeral
  // ("IIII", "VV"), and a numeral this cannot re-print is one nobody should read.
  return total > 0 && total < 4000 && toRoman(total) === bare ? total : null;
}

/** One token's allowed readings, as lower-case word sequences. */
function normalizeReading(words: readonly string[]): string {
  return words.map((w) => w.toLowerCase()).join(' ');
}

/** Why a proposed reading is not one, or null when it is. */
export type ReadingRefusal = string | null;

/**
 * Is `reading` an allowed reading of the ALL-CAPS token `token`?
 *
 * Two shapes, and no third: the letters of THAT word, spaced ("FBI" -> "F B I"),
 * or the same word in ordinary case, which is the emphasis rule ("SAID" ->
 * "said"). A different word is a different word.
 */
export function capsReadingRefusal(token: string, reading: readonly string[]): ReadingRefusal {
  const bare = token.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const said = normalizeReading(reading);
  if (SPOKEN_AS_WORD.has(bare.toLowerCase())) {
    return `"${token}" is an acronym said as a word, so it is read exactly as printed`;
  }
  if (said === [...bare.toLowerCase()].join(' ')) return null;
  if (said === bare.toLowerCase()) return null;
  return `"${said}" is not a reading of "${token}" — a run of capitals is read as its own `
    + 'letters, spaced, or as the same word in ordinary case';
}

/**
 * Is `reading` an allowed reading of the ABBREVIATION token `token`?
 *
 * From the table, and from nowhere else. A token the table does not know is
 * REFUSED and named, so it can be reviewed and added on purpose.
 */
export function abbreviationReadingRefusal(
  token: string, reading: readonly string[],
): ReadingRefusal {
  const key = token.toLowerCase().replace(/[^a-zà-ÿ]/g, '');
  const allowed = ABBREVIATION_READINGS.get(key);
  if (allowed === undefined) {
    return `"${token}" is not an abbreviation this build has a reading for. Unknown `
      + 'abbreviations are left exactly as printed and listed for review, never guessed';
  }
  const said = normalizeReading(reading);
  if (allowed.includes(said)) return null;
  return `"${said}" is not a reading of "${token}" — this build reads it `
    + `${allowed.map((a) => `"${a}"`).join(' or ')}`;
}

/**
 * Is `reading` an allowed reading of the ROMAN-NUMERAL token `token`?
 *
 * Exactly the words of its value, cardinal or ordinal, with or without a leading
 * "the" — "VIII" is "eight", "eighth" or "the eighth", and nothing else. "Part
 * IV" -> "Part Nine" is a different part of a different book.
 */
export function romanReadingRefusal(token: string, reading: readonly string[]): ReadingRefusal {
  const value = romanValue(token);
  if (value === null) return `"${token}" is not a roman numeral this build can read`;
  const cardinal = cardinalWords(value);
  const ordinal = ordinalToWords(value);
  const allowed = new Set<string>();
  for (const words of [cardinal, ordinal]) {
    if (words === null) continue;
    const plain = words.toLowerCase();
    allowed.add(plain);
    allowed.add(`the ${plain}`);
    // number-expansion hyphenates ("twenty-first"); a reading that spaces it is
    // the same words and the same sound.
    allowed.add(plain.replace(/-/g, ' '));
    allowed.add(`the ${plain.replace(/-/g, ' ')}`);
  }
  const said = normalizeReading(reading);
  if (allowed.has(said)) return null;
  return `"${said}" is not a reading of "${token}" — ${token} is ${value}, which reads `
    + `"${cardinal}" or "${ordinal}"`;
}

/**
 * The bracketed insertions a narrator does not read, and which may therefore be
 * removed outright.
 *
 * SQUARE BRACKETS ARE EDITORIAL BY CONVENTION — "[sic]", "[1]", "[ed.]",
 * "[emphasis added]" — so a short square-bracketed insertion is apparatus.
 * ROUND BRACKETS ARE THE AUTHOR'S until proved otherwise: "(he was lying)" is
 * the book, and deleting it for wearing parentheses is what the shape test alone
 * did. A round-bracketed insertion is apparatus only when it opens with one of
 * the words apparatus opens with, or holds no letters at all.
 */
const APPARATUS_LEAD: ReadonlySet<string> = new Set([
  'see', 'cf', 'compare', 'ibid', 'sic', 'ed', 'eds', 'trans', 'translated', 'emphasis',
  'italics', 'note', 'cited', 'quoted', 'source',
]);

/** Why this bracketed insertion may not be removed, or null when it may. */
export function bracketRemovalRefusal(find: string): ReadingRefusal {
  const trimmed = find.trim();
  if (trimmed.length < 2) return 'an empty bracket is nothing to remove';
  const open = trimmed[0];
  const inner = trimmed.slice(1, -1).trim();
  const words = inner.match(/[A-Za-zÀ-ÿ]+/g) ?? [];
  if (open === '[') return null;
  const lead = words[0];
  if (lead === undefined) return null;
  if (APPARATUS_LEAD.has(lead.toLowerCase())) return null;
  return `"${trimmed}" is in round brackets and does not open like apparatus, so it is the `
    + 'book\'s own aside and is read aloud. Square brackets are editorial; parentheses are the '
    + 'author\'s';
}

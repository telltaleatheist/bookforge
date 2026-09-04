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
  /**
   * It must be NUMBERING something: a digit after it AND a thing before it.
   *
   * "The answer was no. 12 men voted" read "The answer was number 12 men voted"
   * — the word "no" ending a sentence, with the next sentence's number taken as
   * its own (the fourth adversarial review, 2026-09-04). A digit after it is not
   * enough, because a sentence can end on "no." and the next one open on a
   * number. What is enough is a thing being numbered in front of it.
   */
  | 'numbers-a-thing'
  /** A capitalized word must stand on one side: "St. Petersburg", "Baker St." */
  | 'beside-a-proper-noun'
  /** A number word or digit must precede it: "two a.m.", never "I am." */
  | 'after-a-number';

export interface AbbreviationEntry {
  /**
   * This abbreviation PREFIXES a name: "Dr. Kempner", "Mt. Everest",
   * "St. Petersburg".
   *
   * It changes what a following capital MEANS. For every other abbreviation a
   * capital after the period is the next sentence — that is the whole of the
   * "Oxford St. The rain" rule — but after a title the capital is the name the
   * title belongs to, and treating it as a sentence end refused the prompt's own
   * "Dr. Kempner" -> "Doctor Kempner" (the fourth adversarial review,
   * 2026-09-04).
   *
   * "St." is both: SAINT prefixes a name and STREET follows one, so the
   * exemption applies only when no capitalized word already stands in front of
   * it. "Oxford St. The" is a street and a sentence end; "St. Petersburg" is a
   * saint and is not.
   */
  readonly takesFollowingName?: boolean;
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
  ['dr', { readings: ['Doctor'], takesFollowingName: true }],
  ['prof', { readings: ['Professor'], takesFollowingName: true }],
  ['mt', { readings: ['Mount', 'Mountain'], takesFollowingName: true }],
  ['ave', { readings: ['Avenue'] }],
  ['blvd', { readings: ['Boulevard'] }],
  ['rd', { readings: ['Road'] }],
  ['jr', { readings: ['Junior'] }],
  ['sr', { readings: ['Senior'] }],
  ['nos', { readings: ['numbers'], context: 'numbers-a-thing' }],
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
  ['st', {
    readings: ['Saint', 'Street'],
    context: 'beside-a-proper-noun',
    takesFollowingName: true,
  }],
  ['no', { readings: ['number'], context: 'numbers-a-thing' }],
  ['co', { readings: ['company'], context: 'beside-a-proper-noun' }],
  // The meridiems. The clock rule keeps them as printed because they are already
  // said as letters; a model that spells them out is not wrong, and nothing else
  // is. "am" is the verb everywhere else, so it needs the number in front of it.
  ['am', { readings: ['a m'], context: 'after-a-number' }],
  ['pm', { readings: ['p m'] }],
]);

/**
 * Is this abbreviation PREFIXING the capitalized word after it, rather than
 * ending a sentence in front of one?
 *
 * Only for the titles that take a name, and only when nothing capitalized
 * already stands in front of the token — which is what tells "St. Petersburg"
 * (a saint, prefixing) from "Oxford St. The rain" (a street, followed by a new
 * sentence).
 */
export function prefixesAName(token: string, before: string, after: string): boolean {
  const entry = ABBREVIATION_READINGS.get(abbreviationKey(token));
  if (entry === undefined || entry.takesFollowingName !== true) return false;
  // A quote or a bracket after it is never a name.
  if (!/^\s*[A-ZÀ-Þ]/.test(after)) return false;
  return !/[A-ZÀ-Þ][A-Za-zÀ-ÿ]*[\s,]*$/.test(before);
}

/** The key a printed abbreviation token is looked up by. */
export function abbreviationKey(token: string): string {
  return token.toLowerCase().replace(/[^a-zà-ÿ]/g, '');
}

/**
 * The words that are followed by a NUMBER of something, so that "no." after one
 * of them is numbering rather than refusing.
 *
 * A capitalized word counts too (a title or a proper noun: "Doc. no. 5"), and so
 * does the start of the block ("No. 5 on the list"). Everything else — "was",
 * "said", "answered" — is a sentence ending on the word "no".
 */
const NUMBERS_A_THING: ReadonlySet<string> = new Set([
  'file', 'doc', 'document', 'ref', 'reference', 'item', 'serial', 'part', 'model', 'catalogue',
  'catalog', 'lot', 'batch', 'order', 'invoice', 'patent', 'case', 'act', 'decree', 'law',
  'volume', 'vol', 'chapter', 'chap', 'section', 'article', 'page', 'plate', 'figure', 'fig',
  'table', 'entry', 'record', 'issue', 'edition', 'room', 'flat', 'apartment', 'unit', 'plot',
  'registration', 'licence', 'license', 'passport', 'account',
]);

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
    case 'numbers-a-thing': {
      if (!/^\s*\d/.test(after)) {
        return `"${token}" is also an ordinary word, so it is only an abbreviation when a number `
          + 'follows it — and here nothing does';
      }
      const lead = /([A-Za-zÀ-ÿ]+)\.?[\s,(\[]*$/.exec(before);
      if (lead === null) return null;
      const word = lead[1]!;
      if (/^[A-ZÀ-Þ]/.test(word)) return null;
      if (NUMBERS_A_THING.has(word.toLowerCase())) return null;
      return `"${token}" here follows "${word}", so it reads as the word "no" ending a sentence `
        + 'and the number after it belongs to the next one. It is only an abbreviation when it '
        + 'is numbering something';
    }
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

/**
 * A GLUED AMPERSAND — "AT&T", "R&D", "S&P", "Smith&Jones".
 *
 * One token, not three: `ampersandToAnd` was a bare replace with no word
 * boundary, so "AT&T" read "ATandT" and was written into a book, while the
 * readings a person would give it were refused (the fifth adversarial review,
 * 2026-09-04).
 *
 * Its only permitted reading is the two sides read as class-3 tokens — a run of
 * capitals gives its own spaced letters, or its own word when the word test
 * allows; anything else stands as printed — joined by " and ". So "AT&T" is
 * "A T and T", "R&D" is "R and D", "Smith&Jones" is "Smith and Jones".
 */
const GLUED_AMPERSAND =
  /(?<![A-Za-zÀ-ÿ0-9&])([A-Za-zÀ-ÿ0-9]+)&([A-Za-zÀ-ÿ0-9]+)(?![A-Za-zÀ-ÿ0-9&])/g;

/** How one side of a glued ampersand may be read. */
function ampersandSideReadings(side: string): string[] {
  if (/^[A-ZÀ-Þ]{2,}$/.test(side)) {
    const out = [spacedLetters(side)];
    if (isEmphasisWord(side)) out.push(side.toLowerCase());
    return out;
  }
  return [side];
}

/**
 * Every reading a span carrying ONE glued ampersand may have, or an empty list
 * when it carries none or more than one.
 *
 * More than one is refused rather than combined: two glued ampersands in a span
 * is a table row or a company list, not a reading, and a rule that guessed at
 * the cross product would be guessing.
 */
export function gluedAmpersandReadings(find: string): string[] {
  GLUED_AMPERSAND.lastIndex = 0;
  const found = [...find.matchAll(GLUED_AMPERSAND)];
  if (found.length !== 1) return [];
  const m = found[0]!;
  const whole = m[0];
  const left = m[1]!;
  const right = m[2]!;
  const at = m.index!;
  const out: string[] = [];
  for (const l of ampersandSideReadings(left)) {
    for (const r of ampersandSideReadings(right)) {
      out.push(`${find.slice(0, at)}${l} and ${r}${find.slice(at + whole.length)}`);
    }
  }
  return out;
}

/** Does this span carry an ampersand pressed between letters or digits? */
export function hasGluedAmpersand(find: string): boolean {
  GLUED_AMPERSAND.lastIndex = 0;
  return GLUED_AMPERSAND.test(find);
}

/** Why a proposed reading is not one, or null when it is. */
export type ReadingRefusal = string | null;

/**
 * The English words this build knows, loaded once from `electron/data/`.
 *
 * ── Why a list and not a shape ──────────────────────────────────────────────
 *
 * A DENYLIST of initialisms cannot bound an open class, and the fifth
 * adversarial review of 2026-09-04 measured the hole by naming fifteen more:
 * OSCE, RSHA, SHAEF, BOAC, ICAO, IATA, ASEAN, SWAPO, UNITA, FRELIMO, COMECON,
 * UNPROFOR, ELAS, EOKA, ODESSA — every one of them four letters with a vowel,
 * every one of them accepted the lower-cased reading. There is no shape that
 * separates "SHAEF" from "SHOUT"; only a word list does.
 *
 * Read lazily and cached, through `fs` and `path` alone, so this module stays a
 * LEAF the training side can vendor without dragging the repo behind it. A
 * missing file is a NAMED failure rather than a silent "no words".
 */
let englishWords: ReadonlySet<string> | null = null;

function loadEnglishWords(): ReadonlySet<string> {
  if (englishWords !== null) return englishWords;
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const file = path.join(__dirname, 'data', 'english-words.json');
  let parsed: { words?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { words?: unknown };
  } catch (err) {
    throw new Error(
      `The narration text pass needs its English word list at ${file} to tell a word printed in `
      + `capitals from an initialism, and could not read it: ${(err as Error).message}. `
      + 'Build with `npm run build:electron`, which copies electron/data into dist.');
  }
  if (!Array.isArray(parsed.words) || parsed.words.length === 0) {
    throw new Error(`${file} carries no words array, so nothing can say whether a run of `
      + 'capitals is a word. Nothing was read.');
  }
  englishWords = new Set((parsed.words as string[]).map((w) => w.toLowerCase()));
  return englishWords;
}

/** The word list, for a keeper that wants to measure it. */
export function englishWordCount(): number {
  return loadEnglishWords().size;
}

/**
 * Is this run of capitals a WORD the author shouted, rather than an initialism?
 *
 * Four letters or more — a two- or three-letter run is an initialism whatever it
 * spells, so "US", "WHO", "FBI" and "SS" get the spaced-letters reading only —
 * AND the lower-cased form has to be an English word this build knows.
 *
 * A word the list does not carry is REFUSED the lower-cased reading and offered
 * the letters reading instead, which is the safe direction: a miss costs an
 * unconverted emphasis, a false accept writes a wrong word into the user's book.
 * An acronym that happens to be an English word (ARMS, MASH) keeps both readings
 * by this test, and that is accepted — both are real readings of those letters.
 */
export function isEmphasisWord(bare: string): boolean {
  if (bare.length < 4) return false;
  return loadEnglishWords().has(bare.toLowerCase());
}

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
  if (said === bare.toLowerCase()) {
    return isEmphasisWord(bare)
      ? null
      : `"${token}" is an initialism, not a word printed in capitals, so it is read as its own `
        + `letters ("${spacedLetters(bare)}") rather than lower-cased`;
  }
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
/**
 * The names a roman numeral follows as a REGNAL number.
 *
 * A curated list, because "any capitalized word" offered the numeral reading to
 * every acronym standing after a name: "Doctor Smith MD" read "Smith one
 * thousand five hundred", "the London CD" read "London four hundred" (the fourth
 * adversarial review, 2026-09-04). Monarchs, popes and emperors are a closed set
 * in practice, and a book that prints a numeral after some other name still has
 * the part-word and century contexts.
 */
const REGNAL_NAMES: ReadonlySet<string> = new Set([
  'henry', 'louis', 'charles', 'george', 'edward', 'william', 'richard', 'james', 'stephen',
  'harold', 'anne', 'elizabeth', 'mary', 'victoria', 'catherine', 'christina', 'margaret',
  'pius', 'leo', 'gregory', 'john', 'paul', 'benedict', 'innocent', 'clement', 'urban',
  'alexander', 'sixtus', 'boniface', 'nicholas', 'celestine', 'honorius', 'martin', 'eugene',
  'adrian', 'hadrian', 'sylvester', 'francis',
  'frederick', 'friedrich', 'wilhelm', 'ludwig', 'otto', 'maximilian', 'joseph', 'franz',
  'ivan', 'peter', 'alexis', 'napoleon', 'philip', 'philippe', 'ferdinand',
  'alfonso', 'carlos', 'pedro', 'gustav', 'christian', 'frederik', 'olav', 'haakon',
  'constantine', 'justinian', 'theodosius', 'leopold', 'albert', 'rudolf', 'sigismund',
  'casimir', 'suleiman', 'mehmed', 'selim', 'ramesses',
  'ptolemy', 'seti', 'thutmose', 'amenhotep', 'darius', 'xerxes', 'artaxerxes', 'antiochus',
  'tiberius', 'claudius', 'vespasian', 'trajan',
]);

/** A regnal name immediately before it: "Henry VIII", "Pius XII". */
const REGNAL_NAME = /\b([A-ZÀ-Þ][a-zà-ÿ]+)\s*$/;
/** A century immediately after it: "XIX century". */
const CENTURY_AFTER = /^\s*(?:century|centuries)\b/i;

/** Is a roman numeral what this block is printing here? */
export function isRomanContext(before: string, after: string): boolean {
  if (PART_WORD.test(before) || CENTURY_AFTER.test(after)) return true;
  const name = REGNAL_NAME.exec(before);
  return name !== null && REGNAL_NAMES.has(name[1]!.toLowerCase());
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

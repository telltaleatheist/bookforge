/**
 * listen-text.ts — the ONE deterministic normalizer every Listen sentence passes
 * through before it reaches the render server.
 *
 * ── The ruling this file exists for ─────────────────────────────────────────
 *
 * Owen, 2026-09-06, listening to an article through the extension on Higgs:
 * *"we need deterministic normalizing logic for this type of text. any <sup>
 * reference numbers should be pulled out. numbers should be converted to text.
 * like 'project 2025' should be converted to 'project twenty twenty five' before
 * it goes to the render server"* — and, a chunk later, *"it choked on '(TPUSA)'.
 * any way we can help it pronounce acronyms more effectively?"*
 *
 * The book path already had all of this: the Clean text pass runs the number
 * RULES (tts-number-rules), the number EXPANDER (number-expansion) and a model
 * behind them, and the TTS export strips footnote-marker `<sup>`s with the shared
 * predicate. The LISTEN path — the TTS API server (extension), the reader bridge
 * (the in-app Play tab) and the book render service — ran none of it: raw page
 * text went to `canonicalizePunctuationText` and straight to the engine, so the
 * engine was handed "Project 2025" and "(TPUSA)" as digits and capitals and read
 * them however that voice's corpus taught it.
 *
 * ── What this is, and is not ────────────────────────────────────────────────
 *
 * DETERMINISTIC ONLY. No model, no fs at call time, no Electron. Every stage is
 * a pure string→string rewrite that either knows a shape or leaves it byte for
 * byte; the reasons each stage refuses are its own file's. The order matters:
 *
 *   1. punctuation canonicalization (tts-punctuation) — quotes, ellipses, runs.
 *   2. the GUARANTEED number shapes (tts-number-rules) — clocks, pages, dates,
 *      money, percents, decades, ordinals, grouped and bare integers — with the
 *      one-segment contract, because Listen text has no element boundaries.
 *   3. the number EXPANDER (number-expansion) for what the rules left: years
 *      read as years ("2025" → "twenty twenty-five"), the ambiguous shapes
 *      (5:30, 1914-1918, COVID-19) left as printed.
 *   4. a CAPS HEADING folded to Title Case (a mirror of narrator's packer fold,
 *      below), acronyms kept as printed for the next stage.
 *   5. ACRONYMS spelled out (below) — after the numbers, so "MI5" is never seen
 *      as letters.
 *
 * Scripture references with a book name ("Jeremiah 44:17-19") are the one shape
 * that stays as digits here: the rules close them for the MODEL, and Listen has
 * no model. That is a known gap, stated, not a fallback.
 *
 * The `<sup>` reference numbers are NOT stripped here — by the time text is a
 * string, a superscript is just a digit glued to a word. They come out where
 * the element still exists: the extension's `blockText` (DOM) with the same
 * shared predicate (`shared/text/sup-markers.ts`) the TTS export applies.
 */

import { canonicalizePunctuationText } from './tts-punctuation';
import { applyNumberRules } from './tts-number-rules';
import { expandNumbersEn } from './number-expansion';
import { SPOKEN_AS_WORD, loadEnglishWords, spacedLetters } from './tts-spoken-forms';
// THE ONE ACRONYM LIST, narrator's file (python/narrator/text/caps_acronyms.json):
// a relative import so tsc emits the JSON into dist beside the compiled module
// and the packaged app carries it; narrator loads the same file standalone.
import capsAcronyms from '../python/narrator/text/caps_acronyms.json';

/**
 * Capitalized tokens that are read as LETTERS despite carrying a vowel — the
 * `lettered` half of THE ONE acronym list (python/narrator/text/
 * caps_acronyms.json), which narrator's caps fold reads too. It was a second
 * copy for one day (2026-09-06) and diverged that day. A miss reads "USA" as a
 * word: fix it in the JSON, and both readers move together.
 */
export const LETTERED_ACRONYMS: ReadonlySet<string> = new Set(capsAcronyms.lettered);

/** Capitalized tokens with their own spoken reading, neither letters nor a word. */
const READ_AS: ReadonlyMap<string, string> = new Map([
  ['WWI', 'World War One'],
  ['WWII', 'World War Two'],
]);

const ROMAN = /^[IVXLCDM]+$/;
const VOWEL = /[AEIOUY]/;
/** A standalone run of 2–8 capitals; digits or letters on either side disqualify it. */
const CAPS_TOKEN = /(?<![A-Za-z0-9])([A-Z]{2,8})(?![A-Za-z0-9])/g;

/**
 * How a standalone ALL-CAPS token is read, or null to leave it as printed.
 *
 * In order: a listed reading ("WWII"); the lettered allowlist; the spoken-as-word
 * set (NASA, NATO); a roman numeral (II, XIV) stays; no vowel (Y included, as
 * narrator counts it) is letters (CNN, TPUSA has vowels — see next); an English
 * WORD printed in capitals stays ("GOD", "PARENTS" in a heading); anything else
 * is an initialism nobody has a word for, and is spelled ("TPUSA" → "T P U S A").
 */
export function acronymReading(token: string): string | null {
  const listed = READ_AS.get(token);
  if (listed) return listed;
  if (LETTERED_ACRONYMS.has(token)) return spacedLetters(token);
  if (SPOKEN_AS_WORD.has(token.toLowerCase())) return null;
  if (ROMAN.test(token)) return null;
  if (!VOWEL.test(token)) return spacedLetters(token);
  if (isCapitalizedWord(token)) return null;
  return spacedLetters(token);
}

/**
 * Is this capitalised token an English WORD printed in capitals? The word list
 * carries base forms, so a regular plural is tried too: "PARENTS" is a word
 * because "parent" is, and a heading that shouts it must not be spelled.
 */
function isCapitalizedWord(token: string): boolean {
  const words = loadEnglishWords();
  const lower = token.toLowerCase();
  if (words.has(lower)) return true;
  if (lower.endsWith('es') && words.has(lower.slice(0, -2))) return true;
  if (lower.endsWith('s') && words.has(lower.slice(0, -1))) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Caps headings — a mirror of narrator's `fold_caps_run` (paragraph_packer.py)
// ─────────────────────────────────────────────────────────────────────────────
//
// A caps heading is a WORD problem, not an acronym problem: "DOES GOD HOLD
// CHILDREN RESPONSIBLE" reached the book model in capitals and came back "dues"
// (Owen's ruling behind main fcb3c95e, the packer's fold). Listen text never
// passes through the packer, and `acronymReading` rightly leaves each of those
// tokens alone — they are English words — so the heading shape stayed untreated
// here until the PC pointed at it (2026-09-06). Same rule, same guard: the whole
// text when every word is caps, or a LEADING RUN of two or more caps words, is
// folded word by word to Title Case; a word that reads as letters (the acronym
// tests above) is kept as printed for `spellAcronyms` to take next.

const HAS_UPPER = /\p{Lu}/u;
const HAS_LOWER = /\p{Ll}/u;

/** All the token's letters are capitals; punctuation and digits ride along. */
function isCapsWord(token: string): boolean {
  return HAS_UPPER.test(token) && !HAS_LOWER.test(token);
}

/** The token's letters, as the acronym tests read them. */
function lettersOf(token: string): string {
  return token.replace(/[^A-Za-z]/g, '');
}

/** Lower the token and capitalise its first LETTER: `KELSIER'S,` → `Kelsier's,`. */
function titleCase(token: string): string {
  const lowered = token.toLowerCase();
  const i = lowered.search(/\p{L}/u);
  return i < 0 ? lowered : lowered.slice(0, i) + lowered[i].toUpperCase() + lowered.slice(i + 1);
}

/**
 * `text` with its leading run of caps words (or all of it) folded to Title
 * Case, acronyms kept. A run of ONE caps word is folded only when it is the
 * whole text (a one-word heading such as `INTRODUCTION.`); one caps word at the
 * head of a longer sentence ("I", "A", a shouted word) is left alone.
 */
export function foldCapsRun(text: string): string {
  const tokens = (text || '').split(' ');
  let run = 0;
  while (run < tokens.length && (tokens[run] === '' || isCapsWord(tokens[run]))) run++;
  const capsWords = tokens.slice(0, run).filter((t) => t).length;
  if (capsWords === 0) return text;
  const whole = run === tokens.length;
  if (capsWords < 2 && !whole) return text;
  const keep = (t: string): boolean => {
    const letters = lettersOf(t);
    if (!letters) return true;
    const upper = letters.toUpperCase();
    return READ_AS.has(upper) || LETTERED_ACRONYMS.has(upper) || !VOWEL.test(upper);
  };
  const folded = tokens.slice(0, run).map((t) => (!t || keep(t) ? t : titleCase(t)));
  return [...folded, ...tokens.slice(run)].join(' ');
}

/** Spell out every standalone initialism in a span of text. */
export function spellAcronyms(text: string): string {
  return text.replace(CAPS_TOKEN, (whole, token: string) => acronymReading(token) ?? whole);
}

/** The text a Listen client sent, as the render server should be handed it. */
export function speakableListenText(raw: string): string {
  const collapsed = (raw || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const punctuated = canonicalizePunctuationText(collapsed);
  const ruled = applyNumberRules(punctuated, [punctuated.length]).text;
  return spellAcronyms(foldCapsRun(expandNumbersEn(ruled)));
}

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
 *   4. ACRONYMS spelled out (below) — after the numbers, so "MI5" is never seen
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

/**
 * Capitalized tokens that are read as LETTERS despite carrying a vowel — the
 * same list narrator's packer keeps (`paragraph_packer.CAPS_ACRONYMS`), for the
 * same reason: stated rather than dictionary-backed, extended when a text
 * teaches us one. A miss reads "USA" as a word, which is a defect to fix HERE.
 */
export const LETTERED_ACRONYMS: ReadonlySet<string> = new Set([
  'USA', 'UK', 'EU', 'UN', 'US', 'CIA', 'DNA', 'RNA', 'TV', 'DVD', 'CD', 'PC',
  'AI', 'IQ', 'UFO', 'FAQ', 'AM', 'PM', 'AD', 'BC', 'BCE', 'CE',
  'IBM', 'CEO', 'CFO', 'MBA', 'PHD', 'ESPN', 'NBA', 'NFL', 'MLB', 'NCAA', 'ROTC',
  'IRS', 'ATM', 'GPS', 'HIV', 'EPA', 'FDA', 'NRA', 'ACLU', 'PTA', 'GPA',
  'OK', 'USSR', 'UAE', 'RSVP', 'ASAP', 'DIY', 'IOU', 'UPS', 'AOL', 'ABC',
  'FBI', 'KGB', 'CBI', 'NYPD', 'LAPD', 'NYC', 'CID', 'ID', 'IT',
  'NBC', 'CBS', 'BBC', 'PBS', 'HBO', 'MTV', 'CNN', 'ESP', 'ER', 'ICU', 'EMT',
  'GOP', 'DNC', 'RNC', 'DOJ', 'DOD', 'DHS', 'ICE', 'SCOTUS', 'POTUS', 'AOC', 'DEI',
]);

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
  return spellAcronyms(expandNumbersEn(ruled));
}

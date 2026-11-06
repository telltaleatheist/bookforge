/**
 * ALL-CAPS runs to Title Case, a TTS-only fold, and THE ONE ACRONYM LIST it guards with.
 * The book path and Listen both read this file, so a heading cannot be read two ways.
 *
 * Measured 2026-09-06 (witches, Higgs): `DOES GOD HOLD CHILDREN ACCOUNTABLE?` came out "dues"
 * for "does", then a stall. The corpus carries caps only as chapter-opening lead-ins, never as
 * a chunk of its own, and speech does not encode case. Owen's ruling: fold to Title Case; guard
 * acronyms.
 *
 * A block whose every word is caps, or a leading run of two or more caps words, is folded word
 * by word. A caps word is kept as printed when it is an acronym by one of two tests:
 *   - it has no vowel letter, Y included (CNN, NHS, MTV). Y counts because WHY, MY and SKY are
 *     words, so a Y-only token is one too; or
 *   - it is on the list (USA, CIA, NASA): vowelled tokens that are not read as words.
 *
 * `shared/text/caps_acronyms.json` is the list. The packer kept for `cli/align_book_chapters.py` keeps its own
 * copy, held equal by `tools/test-one-fact-one-owner.js`.
 */

import capsAcronyms from '../../../shared/text/caps_acronyms.json';

const ACRONYMS_FILE = 'shared/text/caps_acronyms.json';

/** Malformed refuses by name: an empty set would title-case every acronym and say nothing. */
function category(key: 'lettered' | 'spokenAsWord'): readonly string[] {
  const rows = (capsAcronyms as Record<string, unknown>)[key];
  if (!Array.isArray(rows) || rows.length === 0
      || !rows.every((r) => typeof r === 'string' && r && r === r.toUpperCase())) {
    throw new Error(
      `${ACRONYMS_FILE}: "${key}" must be a non-empty list of upper-case tokens; this is the one `
      + 'acronym list three code paths read, and a malformed entry would silently change what a '
      + 'caps run folds to.',
    );
  }
  return rows as string[];
}

/**
 * Tokens read as LETTERS. This half alone is what Listen spells ("F B I"): a `spokenAsWord`
 * entry must never be spelled, which is why WWII is not here.
 */
export const LETTERED_ACRONYMS: ReadonlySet<string> = new Set(category('lettered'));

/**
 * What the fold keeps as printed. Both categories, because a lettered one (FBI) and a word-like
 * one (NASA) are both kept. Listen read `lettered` alone until 2026-09-13, so "Nasa" went
 * through the extension and "NASA" into the m4b, from one file and one stated rule.
 */
export const CAPS_ACRONYMS: ReadonlySet<string> = new Set([
  ...category('lettered'),
  ...category('spokenAsWord'),
]);

const HAS_UPPER = /\p{Lu}/u;
const HAS_LOWER = /\p{Ll}/u;
const IS_LETTER = /^\p{L}$/u;
const VOWEL = /[AEIOUY]/;

/** All the token's letters are capitals. Punctuation and digits ride along: `KELSIER'S,` is caps. */
function isCapsWord(token: string): boolean {
  return HAS_UPPER.test(token) && !HAS_LOWER.test(token);
}

function isAcronym(token: string): boolean {
  const upper = [...token].filter((ch) => IS_LETTER.test(ch)).join('').toUpperCase();
  return CAPS_ACRONYMS.has(upper) || !VOWEL.test(upper);
}

/** Lower the token and capitalise its first letter: `KELSIER'S,` to `Kelsier's,`. */
function titleCase(token: string): string {
  const lowered = token.toLowerCase();
  let at = 0;
  for (const ch of lowered) {
    if (IS_LETTER.test(ch)) return lowered.slice(0, at) + ch.toUpperCase() + lowered.slice(at + ch.length);
    at += ch.length;
  }
  return lowered;
}

/**
 * `text` with its leading run of caps words (or all of it) folded, acronyms kept. A run of ONE
 * caps word is folded only when it is the whole text (`INTRODUCTION.`): one caps word at the
 * head of a longer sentence ("I", "A", a shouted word) is left alone.
 */
export function foldCapsRun(text: string): string {
  const tokens = (text || '').split(' ');
  let run = 0;
  while (run < tokens.length && (tokens[run] === '' || isCapsWord(tokens[run]))) run += 1;
  const capsWords = tokens.slice(0, run).filter((t) => t).length;
  if (capsWords === 0) return text;
  const whole = run === tokens.length;
  if (capsWords < 2 && !whole) return text;
  const folded = tokens.slice(0, run).map((t) => (!t || isAcronym(t) ? t : titleCase(t)));
  return [...folded, ...tokens.slice(run)].join(' ');
}

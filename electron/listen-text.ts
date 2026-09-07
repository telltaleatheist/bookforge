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
 *   0. UNSPOKEN GLYPHS dropped (below) — asterisks, bullets, daggers, arrows,
 *      box drawing, emoji: the decoration a web page carries that no narrator
 *      reads and an LLM-TTS tries to pronounce.
 *   1. punctuation canonicalization (tts-punctuation) — quotes, ellipses, runs.
 *   2. the GUARANTEED number shapes (tts-number-rules) — clocks, pages, dates,
 *      money, percents, decades, ordinals, grouped and bare integers — with the
 *      one-segment contract, because Listen text has no element boundaries.
 *   3. the number EXPANDER (number-expansion) for what the rules left: years
 *      read as years ("2025" → "twenty twenty-five"), the ambiguous shapes
 *      (5:30, 1914-1918, COVID-19) left as printed.
 *   4. a CAPS HEADING folded to Title Case (a mirror of narrator's packer fold,
 *      below), acronyms kept as printed.
 *
 * ACRONYMS ARE NOT SPELLED OUT. There was a stage 5 for one evening
 * (2026-09-06): "TPUSA" → "T P U S A", with an allowlist, a word test and a
 * length rule behind it. It was removed the same evening on Owen's ruling —
 * "i think lowering temperature resolved the tpusa problem. lets remove the
 * deterministic fixes for acronyms like tpusa. just let the system read it as
 * is and see how it does" — after the sampling change (0.8/0.95/50, the Boson
 * default) landed. A capitalised token now reaches the engine as printed; the
 * one thing the caps fold still needs to know is which caps words NOT to
 * title-case, and that is the shared list below.
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

/** Capitalised tokens the caps fold keeps as printed although they carry a vowel
 *  and are not on the lettered list — their spoken reading is their own. */
const KEEP_AS_PRINTED: ReadonlySet<string> = new Set(['WWI', 'WWII']);

const VOWEL = /[AEIOUY]/;

// ─────────────────────────────────────────────────────────────────────────────
// Caps headings — a mirror of narrator's `fold_caps_run` (paragraph_packer.py)
// ─────────────────────────────────────────────────────────────────────────────
//
// A caps heading is a WORD problem, not an acronym problem: "DOES GOD HOLD
// CHILDREN RESPONSIBLE" reached the book model in capitals and came back "dues"
// (Owen's ruling behind main fcb3c95e, the packer's fold). Listen text never
// passes through the packer, and a word test rightly leaves each of those
// tokens alone — they are English words — so the heading shape stayed untreated
// here until the PC pointed at it (2026-09-06). Same rule, same guard: the whole
// text when every word is caps, or a LEADING RUN of two or more caps words, is
// folded word by word to Title Case; a word that reads as letters (the acronym
// tests) is kept as printed.

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
    return KEEP_AS_PRINTED.has(upper) || LETTERED_ACRONYMS.has(upper) || !VOWEL.test(upper);
  };
  const folded = tokens.slice(0, run).map((t) => (!t || keep(t) ? t : titleCase(t)));
  return [...folded, ...tokens.slice(run)].join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Unspoken glyphs — narrator's `strip_unspoken_glyphs`, widened for web pages
// ─────────────────────────────────────────────────────────────────────────────
//
// Owen, 2026-09-06, listening to an article: "lets also remove asterisks or
// other special characters you sometimes find in website text. it doesnt know
// how to read asterisks and tries to pronounce it." The book path already drops
// e2a's `chars_remove` set at extraction (narrator paragraph_packer
// .strip_unspoken_glyphs, main 39316c35, after a VLM `<li>*` was read as a
// stray syllable). Listen text is a web page, which carries more decoration
// than a book does, so that set is the FIRST half of this one and the second
// half is what pages add: list bullets, daggers, arrows, box drawing, the
// pilcrow, backticks and carets, and emoji (narrator's `normalize_text` strips
// those on its path too). Every one maps to a SPACE, never to nothing, so
// "word*word" cannot fuse; the pipeline's whitespace collapse takes the rest.
//
// NOT here, on purpose: anything a narrator does read — `%`, `$`, `&`, `°`,
// `§`, `/`, brackets, quotes, hyphens and dashes — and the digits/letters
// themselves. Stripping is a loss, so the set is enumerated, not "everything
// odd".

/** e2a `chars_remove` (python/narrator/text/lang.py) — the book path's set. */
const NARRATOR_CHARS_REMOVE = '\\|©®™*`\u00a0';
/** What web pages add: bullets, geometric markers, daggers, arrows, pilcrow, box drawing. */
const WEB_DECORATION = '\u2022\u25e6\u25aa\u25ab\u25a0\u25a1\u25cf\u25cb\u2605\u2606\u25ba\u25b6\u25c4\u25c0\u25b2\u25bc'
  + '\u2192\u2190\u2191\u2193\u21d2\u21d0\u2020\u2021\u00b6\u2500-\u257f\u2580-\u259f^~_#';
const UNSPOKEN_GLYPHS = new RegExp(`[${NARRATOR_CHARS_REMOVE}${WEB_DECORATION}]`, 'g');
/** Emoji, with the joiners and selectors that ride with them. */
const EMOJI = /\p{Extended_Pictographic}[\ufe0e\ufe0f]?|\u200d|[\u{1F3FB}-\u{1F3FF}]/gu;

/** `text` with every unspoken glyph replaced by a space (the caller collapses). */
export function stripUnspokenGlyphs(text: string): string {
  return (text || '').replace(EMOJI, ' ').replace(UNSPOKEN_GLYPHS, ' ');
}

/** The text a Listen client sent, as the render server should be handed it. */
export function speakableListenText(raw: string): string {
  const collapsed = stripUnspokenGlyphs(raw).replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const punctuated = canonicalizePunctuationText(collapsed);
  const ruled = applyNumberRules(punctuated, [punctuated.length]).text;
  return foldCapsRun(expandNumbersEn(ruled));
}

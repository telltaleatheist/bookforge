/**
 * tts-punctuation.ts — the PUNCTUATION half of the shared normalization, spec s1.
 *
 * ── What this file is ───────────────────────────────────────────────────────
 *
 * The Orpheus training corpora and this app's narration path are meant to run
 * ONE text-normalization definition, so that what a fine-tune learned is what it
 * is handed. The number half of that definition is `tts-number-rules.ts` +
 * `tts-number-normalizer.ts`, which the training side vendors byte-for-byte out
 * of our compiled `dist/electron/`. This file is the other half, and it is the
 * BookForge-side port of `pipeline/normalization/punctuation.js` from the
 * orpheus-finetune checkout — same exported names, same rules, same order.
 *
 * The gap it closes (their "Ask 1"): `normalizeQuotes` was only ever reached
 * from the AI-CLEANUP (EPUB repair) job, so a book that was never `--ai-cleanup`ed
 * reached the voice with its curly quotes and its printed ellipses intact.
 * Mutineer's Moon prints the spaced ellipsis `. . .` 173 times; the deathstalker
 * training transcripts carry the same form 107 times. `. . .` is period, space,
 * period, space, period — to a token-level TTS, three sentence terminators with a
 * reset between each, which is the flat, mispronounced reading measured on
 * `"You mean . . . ?" "Precisely, Commander:`.
 *
 * ── Doctrine ────────────────────────────────────────────────────────────────
 *
 * Canonicalization is LOSSY ON PURPOSE and it runs BEFORE the number rules.
 * Every rule here either (a) removes a distinction the voice cannot hear, or
 * (b) replaces a printed form with the one form the corpora and the renders will
 * both use. A rule that would remove a distinction the voice CAN hear — a dash,
 * a comma, a paragraph break — is not in this file.
 *
 * ── Vendoring contract ──────────────────────────────────────────────────────
 *
 * This module imports NOTHING but `./ai-cleanup-prepass.js`, on purpose: the
 * training side loads our compiled `dist/electron/tts-punctuation.js` under plain
 * node with no Electron stub, exactly as it already loads
 * `dist/electron/tts-number-rules.js`. Keep it that way — no fs, no model, no
 * Electron, no config. `ai-cleanup-prepass.js` itself requires only
 * `../shared/text/line-join.js`, which requires nothing at all.
 *
 * Changing a rule here is a CHANGE TO THE TRAINING CORPORA'S TEXT TRANSFORM.
 * Bump `PUNCTUATION_SPEC_VERSION` and `NORMALIZER_VERSION`, and tell the
 * orpheus-finetune side to re-vendor — see docs/NARRATION_TEXT_PASS.md.
 */
import { normalizeQuotes } from './ai-cleanup-prepass.js';

// The quote half is BookForge's own, and this module is where the narration path
// reaches it. Re-exported so a caller that wants only the quote rule (the
// streaming door) has one import, and so the training side's vendored copy of
// this file cannot drift from the app's quote map.
export { normalizeQuotes };

/** The spec this file implements. Bumped whenever a rule below changes. */
export const PUNCTUATION_SPEC_VERSION = 's1';

/**
 * THE CANONICAL ELLIPSIS.
 *
 * Three ASCII periods, no interior spaces. The evidence, from the training
 * side's NORMALIZATION_SPEC.md §A2:
 *
 *  - The printed corpus is split. Mutineer's Moon prints ". . ." 173 times; the
 *    deathstalker transcripts carry the same spaced form 107 times; other books
 *    print U+2026 or "...". The four served corpora split 294 spaced against 217
 *    unspaced BY VOICE, not by frequency (fe_dn2 is 100% unspaced), so "follow
 *    the corpora" does not decide it — the decision is made on what the VOICE
 *    does with each form instead.
 *  - ". . ." is a period, a space, a period, a space, a period. To a token-level
 *    TTS that is three sentence terminators in a row with resets between them.
 *  - "..." is one unbroken token run with no interior space, so it cannot be
 *    mistaken for a sentence boundary followed by a new sentence.
 *  - It is also what BookForge's own `normalizeQuotes` already produces for
 *    U+2026, so adopting it makes existing behaviour canonical rather than
 *    adding a third form.
 */
export const CANONICAL_ELLIPSIS = '...';

// ─────────────────────────────────────────────────────────────────────────────
// The rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * C0 control characters that are not tab, newline or carriage return.
 *
 * These reach a corpus through PDF and OCR extraction (form feed U+000C at page
 * breaks, vertical tab, the odd U+0007). They are invisible in every editor, they
 * are not speech, and a tokenizer either drops them or emits a byte-fallback
 * token that was never in the training data. Deleted outright — there is no
 * spoken form to preserve.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Zero-width and formatting characters: BOM/ZWNBSP, ZWSP, ZWJ/ZWNJ, the LTR/RTL
 * marks and the soft hyphen.
 *
 * A soft hyphen (U+00AD) is a typesetter's permission to break a word, not a
 * hyphen; left in, it splits a word in the middle for the tokenizer. Deleted with
 * the rest: none of them is a sound.
 */
const INVISIBLES = /[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\ufeff]/g;

/**
 * Every space that is not U+0020, mapped TO U+0020.
 *
 * Non-breaking space (U+00A0) is the common one — it is what an EPUB prints
 * between "p." and a page number, and inside "Mr. Smith" in a carefully set book.
 * Also the en/em/thin/hair/figure spaces and the ideographic space. They are all
 * a word gap to a narrator and a distinct token to a tokenizer.
 */
const SPACE_VARIANTS = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/**
 * A printed ellipsis in every form a book uses, as ONE match.
 *
 * Three or more periods, each pair optionally separated by horizontal whitespace:
 * "...", ". . .", ".. .", "....", ". . . .". Runs of exactly two periods are NOT
 * matched — ".." is a typo or an abbreviation collision, never an ellipsis, and
 * converting it would invent a pause the book did not print.
 *
 * U+2026 does not appear here because `normalizeQuotes` has already turned it
 * into "..." by the time this runs; a lone U+2026 that somehow reached this rule
 * would be left alone, which is why the ORDER in `canonicalizePunctuation` is not
 * optional.
 *
 * FOUR-DOT RUNS COLLAPSE TO THREE, and that is a deliberate loss. English style
 * prints a sentence-ending period plus an ellipsis as four dots; the voice has no
 * fourth reading of it, and Owen's stated aim is to make the text less
 * complicated. The sentence boundary survives in the capital letter that follows.
 */
const ELLIPSIS_RUN = /\.[ \t]*\.[ \t]*\.(?:[ \t]*\.)*/g;

/**
 * THE CANONICAL DASH — U+2014, the em dash.
 *
 * The spec keeps every dash the book printed, because dashes carry prosody. This
 * constant is NOT a contradiction of that: it is the target a form that is
 * unambiguously a *typewriter substitute* for an em dash resolves to. `--` has
 * exactly one correct reading — it is what a keyboard without an em dash types.
 *
 * A single hyphen, an en dash and a SPACED hyphen are all left alone: those have
 * more than one reading (compound, range, em-dash substitute).
 */
export const CANONICAL_DASH = '\u2014';

/**
 * A typewriter em dash: two or more hyphens with a real character either side.
 *
 * The lookarounds keep this off an ASCII rule (`-----`, which has nothing but
 * hyphens and line ends around it) and off a run at the start or end of a line.
 * Any spaces the book set around the dash are absorbed, which is the em-dash
 * convention — so `word -- word` and `word--word` both come out `word—word`.
 *
 * NOTE ON THE UPSTREAM COMMENT: `punctuation.js` says these lookarounds also keep
 * the rule off a command-line flag. They do not — the lookbehind sits BEFORE the
 * optional space run, so "run --file" matches and becomes "run—file". Measured
 * here, 2026-09-04. The regex is left exactly as the shared spec defines it
 * (this file is the port, not a second opinion), because a book does not print
 * command-line flags and diverging by one character would break the byte-identity
 * the training side drift-checks. Reported back to the orpheus-finetune side.
 *
 * Measured: ZERO occurrences in the four served corpora. This rule is insurance
 * for future ingestion and costs nothing to adopt today.
 */
const DOUBLE_HYPHEN = /(?<=[^\s-])[ \t]*--+[ \t]*(?=[^\s-])/g;

/**
 * A run of two or more terminal marks — `?!`, `!!!`, `!?`, `?!?`.
 *
 * ONE MARK SURVIVES, and which one is not arbitrary: if the run contains a
 * question mark the result is `?`, otherwise `!`. A question read as an
 * exclamation loses its rising contour, and that is the one thing a listener
 * cannot reconstruct from the words; an exclamation read as a question is the
 * cheaper error, so `?` wins whenever both are present.
 *
 * Measured: 4 occurrences, all in tr_dn3 (`younger!!! Oh!!!` in a quoted diary,
 * plus two `?!`). Adopted despite the low count because the reading is
 * unambiguous — a narrator has no third intonation for `!!!`.
 */
const TERMINAL_RUN = /[?!]{2,}/g;

/** Two or more spaces or tabs in a row — a layout artifact, never a pause. */
const REPEATED_SPACE = /[ \t]{2,}/g;

/** Trailing horizontal whitespace at the end of a line. */
const TRAILING_SPACE = /[ \t]+$/gm;

/** The glyphs `normalizeQuotes` consumes, counted on the text it was handed. */
const QUOTE_GLYPHS = /[\u2018\u2019\u201a\u201c\u201d\u201e\u00ab\u00bb]/g;
const ELLIPSIS_CHAR = /\u2026/g;

// ─────────────────────────────────────────────────────────────────────────────
// The pass
// ─────────────────────────────────────────────────────────────────────────────

/** How many times each rule fired. Absent means zero. */
export type PunctuationCounts = Record<string, number>;

/** The text a canonicalization produced, and which rules produced it. */
export interface PunctuationOutcome {
  text: string;
  counts: PunctuationCounts;
}

/**
 * Canonicalize one span of text's punctuation.
 *
 * Returns the text and a per-rule count, because the corpus audit and the render
 * record both need to say WHICH rule changed a row, not merely that one did.
 *
 * ORDER IS LOAD-BEARING:
 *   1. controls and invisibles go first, so a NBSP hiding inside a ". . ." or a
 *      soft hyphen inside a word cannot survive into a later match;
 *   2. space variants become U+0020, so the ellipsis and repeated-space rules
 *      only ever have to know about one space character;
 *   3. `normalizeQuotes` — which is also where U+2026 becomes "..." — so the
 *      ellipsis rule sees every printed form as dots;
 *   4. repeated spaces collapse, which turns ".  .  ." into ". . ." and takes
 *      one variant off the ellipsis rule's plate;
 *   5. the ellipsis rule unifies what is left;
 *   6. the typewriter dash, AFTER the ellipsis rule, so a book that prints
 *      "word--..." has its dots read as an ellipsis rather than reached across;
 *   7. terminal runs collapse;
 *   8. trailing line whitespace goes last, because steps 3-7 can create it.
 *
 * DASHES THE BOOK PRINTED ARE NOT TOUCHED. BookForge keeps em and en dashes
 * deliberately (they carry prosody, and the number validator's `spokenWords`
 * explicitly admits a dash the book printed), so the shared spec keeps them too.
 *
 * Idempotent: `canonicalizePunctuation(canonicalizePunctuation(x).text).text`
 * equals `canonicalizePunctuation(x).text`, which the keeper suite proves over
 * every shared fixture.
 */
export function canonicalizePunctuation(text: string): PunctuationOutcome {
  const counts: PunctuationCounts = {};
  const bump = (rule: string, n: number): void => {
    if (n > 0) counts[rule] = (counts[rule] ?? 0) + n;
  };
  const countOf = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

  let t = text;

  bump('control', countOf(t, CONTROL_CHARS));
  t = t.replace(CONTROL_CHARS, '');

  bump('invisible', countOf(t, INVISIBLES));
  t = t.replace(INVISIBLES, '');

  bump('space-variant', countOf(t, SPACE_VARIANTS));
  t = t.replace(SPACE_VARIANTS, ' ');

  const beforeQuotes = t;
  t = normalizeQuotes(t);
  if (t !== beforeQuotes) {
    // normalizeQuotes is a single pass with no counter of its own, so the glyphs
    // it consumed are counted on the text it was handed.
    bump('quote', countOf(beforeQuotes, QUOTE_GLYPHS));
    bump('ellipsis-char', countOf(beforeQuotes, ELLIPSIS_CHAR));
  }

  bump('repeated-space', countOf(t, REPEATED_SPACE));
  t = t.replace(REPEATED_SPACE, ' ');

  // Counted only where the match is not ALREADY the canonical form, so a text
  // that already prints "..." is not reported as changed.
  let ellipsisChanged = 0;
  t = t.replace(ELLIPSIS_RUN, (m) => {
    if (m !== CANONICAL_ELLIPSIS) ellipsisChanged += 1;
    return CANONICAL_ELLIPSIS;
  });
  bump('ellipsis-run', ellipsisChanged);

  bump('double-hyphen', countOf(t, DOUBLE_HYPHEN));
  t = t.replace(DOUBLE_HYPHEN, CANONICAL_DASH);

  let runsCollapsed = 0;
  t = t.replace(TERMINAL_RUN, (m) => {
    runsCollapsed += 1;
    return m.includes('?') ? '?' : '!';
  });
  bump('terminal-run', runsCollapsed);

  bump('trailing-space', countOf(t, TRAILING_SPACE));
  t = t.replace(TRAILING_SPACE, '');

  return { text: t, counts };
}

/** The text alone. */
export function canonicalizePunctuationText(text: string): string {
  return canonicalizePunctuation(text).text;
}

/** Every rule name `canonicalizePunctuation` can report, in the order it applies them. */
export const PUNCTUATION_RULES: readonly string[] = Object.freeze([
  'control', 'invisible', 'space-variant', 'quote', 'ellipsis-char',
  'repeated-space', 'ellipsis-run', 'double-hyphen', 'terminal-run', 'trailing-space',
]);

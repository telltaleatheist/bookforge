/**
 * line-join — how the laid-out lines of one text block become flowing prose.
 *
 * A "line" from mutool/mupdf/OCR is where the PAGE broke the text, not where the
 * author did. Carrying those breaks into exported.epub carries page geometry into
 * TTS, which reads the ragged wrap as if it were meant. So lines join with a
 * single space.
 *
 * The one break worth keeping is a WRAP HYPHEN. `word-\nword` is the exact shape
 * the cleanup hyphen pre-pass matches (HYPHEN_SPLIT in
 * `electron/ai-cleanup-prepass.ts`), and that pre-pass decides the pair from the
 * book's own corpus — "inter-\nests" → interests, but "seven-\nyear" → seven-year.
 *
 * Deciding it HERE is guesswork, and the obvious guess is wrong often: "next char
 * is lowercase ⇒ dehyphenate" welds real compounds shut — far-right → farright,
 * self-defense → selfdefense, anti-Communist → antiCommunist. Measured on one book
 * (Hanebrink, *A Specter Haunting Europe*), all 37 pairs the pre-pass could prove
 * were genuine compounds followed by a lowercase letter. Keep the break and let
 * the pre-pass prove it; once the break is gone the word is unrecoverable.
 *
 * MIRROR of `isWrapHyphenBreak` in `electron/ai-cleanup-prepass.ts`. The renderer
 * cannot import from `electron/`, so this is duplicated deliberately — if one
 * changes, change both, or extraction stops feeding the pre-pass.
 */

const WRAP_HYPHEN_END = /[A-Za-zÀ-ÿ]-[ \t]*$/;
const WRAP_HYPHEN_CONT = /^[ \t]*[A-Za-zÀ-ÿ]/;

/** Does the break between these two laid-out lines split a hyphenated word? */
export function isWrapHyphenBreak(prevLine: string, nextLine: string): boolean {
  return WRAP_HYPHEN_END.test(prevLine) && WRAP_HYPHEN_CONT.test(nextLine);
}

/** The separator to place between two stacked lines of the same block. */
export function lineSeparator(prevLine: string, nextLine: string): '\n' | ' ' {
  return isWrapHyphenBreak(prevLine, nextLine) ? '\n' : ' ';
}

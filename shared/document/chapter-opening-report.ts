/**
 * What a rename has to say about the chapter's OPENING — the heading printed on
 * the page.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A chapter's name lives in the book's table of contents and NOWHERE else
 * (electron/book-chapters.ts). The heading printed at the top of the chapter is
 * DERIVED from it: after every rename, and on every project open, the naming
 * pass rewrites each chapter's opening to read its stored name
 * (`nameChapterOpenings`). One authority, one derivation.
 *
 * The derivation can decline, per chapter, and always for a reason it can state:
 * the book's markup marks no chapter opening in that document, or the opening
 * holds a picture that writing text into would delete. When it declines, the
 * table of contents says the new name and the page still prints the old heading
 * — and until Aug 2026 the picker said nothing at all about that, because the
 * only thing it was told was a book-wide COUNT of openings rewritten. Owen,
 * 2026-08-10: "when i finally did manage to change the chapter title, it didnt
 * change the text of the chapter block. i expected it to."
 *
 * So this is the one place that turns the naming pass's per-chapter outcome into
 * the sentence the window owes the user. It is pure and lives in `shared/` so
 * main can compute it from the pass's own report and the picker can be handed
 * the answer rather than re-deriving a second opinion about it.
 */

/** Why the naming pass left one chapter's opening alone. Never a failure. */
export type UnnamedChapterOpeningKind = 'no-chapter-element' | 'already-named' | 'holds-image';

/** One chapter the naming pass left alone, and the sentence it said about it. */
export interface SkippedChapterOpening {
  /** The chapter document's zip entry. */
  file: string;
  kind: UnnamedChapterOpeningKind;
  /** The pass's own words, which are the words the user is owed. */
  reason: string;
}

/**
 * The naming pass's outcome, in the only two parts a caller here reads.
 *
 * Structural rather than the pass's own interfaces, so this file — and the test
 * that covers it — stands on nothing that imports electron.
 */
export interface ChapterOpeningNamingReport {
  /** The openings that were rewritten, by chapter document. */
  named: readonly { file: string }[];
  /** The chapters left alone, with the reason each was. */
  skipped: readonly SkippedChapterOpening[];
}

/**
 * Why this chapter's opening does NOT read its new name, or null when it does.
 *
 * Null is the whole of "the page followed the rename", and it covers two ways of
 * getting there that are the same fact to a reader: the opening was rewritten,
 * or it already read the name and there was nothing to write.
 *
 * A chapter the report mentions in NEITHER list is its own answer and not a
 * silent pass: the pass ran over the whole book and did not reach this document
 * at all, which is a state the user has to be told about because the contents
 * and the page now disagree.
 */
export function chapterOpeningRefusal(
  report: ChapterOpeningNamingReport,
  file: string,
): string | null {
  if (report.named.some(entry => entry.file === file)) return null;

  const skipped = report.skipped.find(entry => entry.file === file);
  if (skipped === undefined) {
    return `The pass that writes a chapter's name into its opening did not reach ${file}, so the `
      + 'heading on the page still prints what it printed before. The name in the book\'s table of '
      + 'contents is the new one.';
  }
  if (skipped.kind === 'already-named') return null;
  return skipped.reason;
}

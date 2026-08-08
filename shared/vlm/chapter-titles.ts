/**
 * chapter-titles — what the project's book calls its chapters, as a wire shape.
 *
 * The book `foundry vlm-convert` writes is one XHTML document per chapter, and
 * the EPUB 3 navigation document is where each of them is NAMED. That name is
 * not decoration: ebook2audiobook takes its chapter titles from the book's own
 * nav.xhtml, matched to spine documents by identity, so the nav entry is
 * literally what a listener hears announced.
 *
 * Declared under `shared/` beside the narration deletions, for the same reason
 * those are: main reads the book and the picker draws what came back, and a
 * shape declared on one side of the process boundary is a shape the other side
 * re-declares slightly differently. The BEHAVIOUR — reading the nav, splicing a
 * new title into it — is main's alone and lives in electron/book-chapters.ts;
 * this file is only the vocabulary the two share.
 */

/** One chapter document of the book, and the two places it is named. */
export interface BookChapterTitle {
  /**
   * The document's zip entry name, normalized — `EPUB/text/c0011.xhtml`.
   *
   * The SAME identity a narration strike is recorded under
   * (`<zip entry>#<index>`, shared/vlm/narration-deletions.ts), which is what
   * lets the picker say which chapter a block on screen belongs to: the block
   * already carries the element it was laid out from, and the entry name is the
   * first half of that key. No page arithmetic, no range matching.
   */
  file: string;
  /** The nav entry's link text: THE title, the one the audiobook is built from. */
  navTitle: string;
  /** The document's own `<head><title>`, which should say the same thing. */
  docTitle: string;
}

export interface BookChapterTitles {
  /** Absolute path to the book these came out of. */
  bookPath: string;
  /** The navigation document's zip entry name. */
  navFile: string;
  /** Every document the table of contents lists, in the order it lists them. */
  chapters: BookChapterTitle[];
}

/**
 * What became of the narration copy when the book was retitled.
 *
 * `none` — the project has never exported one. `updated` — it was cut from the
 * book as it stood and now carries the new title too. `already-stale` — it was
 * cut from some other version of this book and was NOT touched, which the caller
 * must say out loud rather than absorb: an audiobook made from it would announce
 * the old chapter title, and nothing on screen would explain why.
 *
 * `chapter-pruned` — the copy is current, but this chapter is NOT IN IT: the
 * strikes emptied that document, so the export removed it from the copy along
 * with its table-of-contents entry (electron/epub-processor.ts,
 * `writeNarrationEpub`). Nothing is wrong and nothing needs re-exporting — the
 * book carries the new title and the narration has no chapter to carry it on.
 * It is its own outcome rather than folded into `none` because the two are
 * opposite facts: `none` is "there is no copy", this is "there is one, and you
 * deleted this chapter out of it".
 */
export type NarrationCopyOutcome = 'none' | 'updated' | 'already-stale' | 'chapter-pruned';

export interface BookChapterRenameResult {
  /** The chapter document that was renamed, as a zip entry name. */
  file: string;
  /** What it is called now. */
  title: string;
  /** What the nav called it before. */
  previousTitle: string;
  /** The book's sha256 after the rewrite. */
  bookSha256: string;
  narrationCopy: NarrationCopyOutcome;
}

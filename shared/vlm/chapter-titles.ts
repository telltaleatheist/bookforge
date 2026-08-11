/**
 * chapter-titles — what the project's book calls its chapters, as a wire shape.
 *
 * The book `foundry vlm-convert` writes is one XHTML document per chapter, and
 * the book's table of contents is where each of them is NAMED. That name is not
 * decoration: ebook2audiobook takes its chapter titles from the book's own
 * navigation, matched to spine documents by identity, so the entry is literally
 * what a listener hears announced.
 *
 * A book states that list in an EPUB 3 navigation document, in an EPUB 2 NCX, or
 * in both, and a chapter has ONE name whichever way it is written down — so
 * these shapes speak of documents and titles rather than of navs, and a rename
 * lands in every list the book carries (electron/book-chapters.ts).
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
  /**
   * The table-of-contents entry's text: THE title, the one the audiobook is
   * built from. Named for the EPUB 3 nav it is usually read out of; a book with
   * only an NCX answers with its `navLabel`, which is the same fact.
   */
  navTitle: string;
  /** The document's own `<head><title>`, which should say the same thing. */
  docTitle: string;
}

export interface BookChapterTitles {
  /** Absolute path to the book these came out of. */
  bookPath: string;
  /**
   * Every table of contents the book carries, as zip entry names — the nav
   * document first where there is one, then the NCX. A rename rewrites the
   * chapter's entry in all of them, so this is also the list of files an edit
   * will touch.
   */
  tocFiles: string[];
  /** Every document the tables of contents list, in the order they list them. */
  chapters: BookChapterTitle[];
  /**
   * The book's own spine documents that NO table of contents names, in reading
   * order.
   *
   * The other half of the same question `chapters` answers, and it has to be
   * asked out loud because an unlisted document is not a document without a
   * chapter — it is a chapter the audiobook will never announce and a reader
   * cannot navigate to. Until Aug 2026 the picker could only say so: promoting a
   * block to `chapter` in one of these documents produced "Rename the chapter to
   * give it one", and the rename refused every document the contents did not
   * already list. `addBookChapter` is the operation that advice needs, and this
   * is the list of documents it can be asked for.
   */
  unlistedDocuments: string[];
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
  /** What the book's first table of contents called it before. */
  previousTitle: string;
  /** The book's sha256 after the rewrite. */
  bookSha256: string;
  /**
   * The tables of contents the new title was written into, as zip entry names.
   * A book carrying both a nav document and an NCX lists both: the rename that
   * updated only one of them is the bug this field is evidence against.
   */
  rewrittenTocs: string[];
  /**
   * EVERY zip entry of the book whose bytes this rename changed — the tables of
   * contents and the chapter document whose `<head><title>` was refilled.
   *
   * Stated rather than left to be worked out, because a window showing this book
   * has it paginated and has to lay the changed documents out again
   * (`quire:relayout-entries`). Deriving that list from `rewrittenTocs` plus a
   * guess at which document was meant would be a guess about which chapter to
   * re-paginate, and a book paginated for markup it does not have is worse than
   * one that was never re-paginated at all.
   */
  rewrittenEntries: string[];
  narrationCopy: NarrationCopyOutcome;
}

/**
 * What became of the book when a spine document GAINED a table-of-contents
 * entry.
 *
 * The same shape as a rename bar the one field a rename has and an add cannot:
 * `previousTitle`. There was no previous title — the book said nothing about
 * this document at all, which is the whole reason the operation exists — and
 * carrying a blank `titleBefore` through the manifest would record a rename from
 * "" rather than the act that happened.
 *
 * `openingsNamed` and `openingUnnamed` are here rather than on the IPC answer
 * because the naming pass is PART of the add: a chapter that has just been given
 * a name whose opening still prints the scan's heading is a half-finished
 * gesture, and both callers (the Chapter tab and the relabel-to-chapter flow)
 * need the same completion. See electron/book-chapters.ts, `addBookChapter`.
 */
export interface BookChapterAddResult {
  /** The chapter document that was listed, as a zip entry name. */
  file: string;
  /** What every table of contents calls it now. */
  title: string;
  /** The book's sha256 after the rewrite. */
  bookSha256: string;
  /** The tables of contents the entry was inserted into, as zip entry names. */
  rewrittenTocs: string[];
  /**
   * EVERY zip entry of the book whose bytes this add changed — the tables of
   * contents, the chapter document whose `<head><title>` was filled in, and any
   * document the naming pass rewrote an opening in. Stated rather than derived,
   * for the reason {@link BookChapterRenameResult.rewrittenEntries} gives.
   */
  rewrittenEntries: string[];
  narrationCopy: NarrationCopyOutcome;
  /** How many chapter openings the naming pass rewrote across the whole book. */
  openingsNamed: number;
  /**
   * Why THIS chapter's opening does not print its new name, or null when it
   * does (shared/document/chapter-opening-report.ts).
   */
  openingUnnamed: string | null;
}

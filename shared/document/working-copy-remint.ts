/**
 * working-copy-remint — the working copy was made AGAIN, and that has to be said.
 *
 * ── The failure this exists to end (measured live, 2026-08-08) ──────────────
 *
 * A project's working copy is `source/<archive basename>.working.epub`, and the
 * edits made to it are RECORDS in the manifest rather than bytes in the file:
 * `source.deletedBlockIds` and `source.deletedPages` say which blocks and pages
 * the user struck out, `manifest.editor` holds everything else, and
 * `outputs.epub.narrationDeletions` holds the narration strikes.
 *
 * A user who wanted to start a book over DELETED that file, which is the obvious
 * reading of "the working copy is the thing I have been editing". The next time
 * anything asked for the book, `ensureBookEpub` minted a new copy from the
 * archive original — byte-identical, silently — and every one of those records
 * still described those bytes exactly, so they all applied again. The user then
 * spent a session editing a book they believed was fresh and exported a
 * narration copy cut by the deletions they thought they had thrown away.
 *
 * ── The answer, changed 2026-08-09 ─────────────────────────────────────────
 *
 * The first fix kept the records and said so. Owen: "if i delete the working
 * copy, all of its deletions and changes should go with it. thats how it works
 * right." So the reading the user had was not the wrong one — it was the
 * contract, and the code was what disagreed with it.
 *
 * A re-mint now CLEARS before it mints, through the same wholesale reset the
 * "Erase all changes and start over" button performs (`pipeline:reset-editor-state`
 * → `resetEditorRecords`), and the fresh copy is a fresh book in every sense:
 * no editor state, no page or block deletions, no chapter markers, no narration
 * strikes, no book edits. This module is the sentence that says so, kept here —
 * pure, with no fs and no manifest — so main's console line and the picker's
 * notice are the same words, and so it can be tested without a project
 * (`tools/test-working-copy-remint.js`).
 *
 * It is INFORMATION, not a warning. Nothing has to be corrected any more: the
 * user did the thing, the thing happened. What they are owed is the receipt —
 * which file came back, and how much work went with the one that did not.
 *
 * ── FIRST mint is not this ──────────────────────────────────────────────────
 *
 * A project imported as an EPUB has no working copy until something asks for
 * one, and making it then is the ordinary, invisible first act of opening the
 * book. There are no earlier edits, nothing is cleared, and there is nothing to
 * tell anybody. Only a RE-mint — a record naming a file that is not on disk —
 * is evidence that a file somebody was editing has gone, and only that is said.
 */

/**
 * What a re-mint threw away, counted from the manifest at the moment the copy
 * was made again.
 *
 * Every count is taken BEFORE the reset runs. It is the only instant at which
 * they exist: the reset clears `manifest.editor`, the `manifest.source` deletion
 * keys and the chapter markers, and `registerEpubExport` then replaces
 * `outputs.epub` wholesale.
 */
export interface WorkingCopyRemint {
  /** The book the record named, project-relative — the file that was missing. */
  relPath: string;
  /**
   * WHICH archive-grade book the fresh copy was made from.
   *
   * Two kinds of project and two true sentences, and only one of them can be
   * said about a given book: an EPUB-native project's copy is the file the user
   * handed us, and a PDF-origin project's is the book a page reader cast out of
   * their pages (`outputs.generatedEpub`, archive-grade since 2026-08-09).
   *
   * It is on the receipt because the receipt's last line tells the user what
   * they are now looking at, and telling somebody they are looking at "the
   * archive original" when their archive is a PDF is a sentence they cannot
   * make sense of.
   */
  source: 'archive-epub' | 'generated-epub';
  /** Block deletions that were recorded in `manifest.source`, and are gone. */
  deletedBlockIds: number;
  /** Page deletions in `manifest.source`, gone with them. */
  deletedPages: number;
  /**
   * Elements that were struck out for narration, as the old record held them.
   *
   * Counted and said out loud because it is usually the largest number on the
   * receipt — a user who struck four hundred footnotes out of a book is owed a
   * plain statement that those four hundred strikes went with the file.
   */
  narrationStrikes: number;
  /**
   * The ledger entries the fresh copy STILL CARRIES, oldest first, by label.
   *
   * Empty is the ordinary case and the one this receipt was written for: a book
   * nothing has been run over comes back as the archive-grade original exactly.
   *
   * A non-empty list changes what the last line of the receipt can truthfully
   * say. A pass rewrote the book's bytes and its snapshot is what the fresh copy
   * was derived from (shared/document/book-ledger.ts), so the user is NOT
   * looking at the unedited original — they are looking at the book those passes
   * produced, with their own edits gone. Deleting the working copy means "start
   * my edits over"; it has never meant "throw away the hour of model time too",
   * and a receipt that claimed the original was back would be describing a file
   * the project does not have.
   */
  kept: readonly string[];
}

/** `n thing(s)`, the plural spelling this codebase uses everywhere. */
function count(n: number, noun: string): string {
  return `${n} ${noun}(s)`;
}

/**
 * What to tell the user, in one paragraph.
 *
 * It states three things in this order, because that is the order they matter
 * in: the file was made again (so the book they are about to look at is not the
 * one they were editing), that deleting it did exactly what they meant by it,
 * and what that cost — named in counts, because "your edits were cleared" with
 * no number behind it is the kind of sentence a user has to go and verify.
 *
 * The rail's "Erase all changes and start over" button is deliberately NOT named
 * any more. It was the way out of a re-mint that kept the records; there is no
 * longer anything to get out of.
 */
export function describeWorkingCopyRemint(remint: WorkingCopyRemint): string {
  const cleared = [
    count(remint.deletedBlockIds, 'deleted block'),
    count(remint.deletedPages, 'deleted page'),
    ...(remint.narrationStrikes > 0
      ? [`${count(remint.narrationStrikes, 'element')} struck out for narration`]
      : []),
  ];
  const list = cleared.length === 2
    ? `${cleared[0]} and ${cleared[1]}`
    : `${cleared[0]}, ${cleared[1]} and ${cleared[2]}`;
  // The book it came from, named as the user knows it. A PDF-origin project has
  // no archive EPUB to have been copied — its archive is the PDF — so calling
  // the source "the archive original" there would describe a file that does not
  // exist.
  const from = remint.source === 'archive-epub'
    ? { made: 'this project\'s archive original', now: 'the archive original, unedited' }
    : {
      made: 'the book read out of this project\'s pages',
      now: 'that book exactly as it was read, with none of your edits',
    };
  // A book with recorded passes was NOT copied from the archive-grade book: it
  // was derived from the snapshot the last of those passes left, which is the
  // only file that has them applied. Both halves of the sentence change, because
  // both would otherwise be false.
  if (remint.kept.length > 0) {
    const list = remint.kept.length === 1
      ? remint.kept[0]
      : `${remint.kept.slice(0, -1).join(', ')} and ${remint.kept[remint.kept.length - 1]}`;
    return (
      `${remint.relPath} was not on disk, so it has been made again from ${from.made} with `
      + `${list} applied. Deleting the working copy is how a book's EDITS are started over, and it `
      + 'was taken that way: your edits are recorded in the project rather than written into the '
      + `file, and every record made against the copy that is gone was cleared with it — ${cleared
        .join(', ')
        .replace(/, ([^,]*)$/, ' and $1')}. The pass${remint.kept.length === 1 ? '' : 'es'} `
      + `rewrote the book itself and ${remint.kept.length === 1 ? 'is' : 'are'} recorded in its `
      + `ledger, so ${remint.kept.length === 1 ? 'it was' : 'they were'} kept — delete the ledger `
      + 'entr(y/ies) to go back further.'
    );
  }
  return (
    `${remint.relPath} was not on disk, so it has been made again from ${from.made}. Deleting the `
    + 'working copy is how a book is started over, and it was taken that way: your edits are '
    + 'recorded in the project rather than written into the file, and every record made against '
    + `the copy that is gone was cleared with it — ${list}. The copy you are looking at now is `
    + `${from.now}.`
  );
}

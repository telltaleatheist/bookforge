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
 * reading of "the working copy is the thing I have been editing". It is the
 * wrong one. The next time anything asked for the book, `ensureBookEpub` minted
 * a new copy from the archive original — byte-identical, silently — and every
 * one of those records still described those bytes exactly, so they all applied
 * again. The user then spent a session editing a book they believed was fresh
 * and exported a narration copy cut by the deletions they thought they had
 * thrown away.
 *
 * The re-mint itself is correct and must stay: the records ARE keyed to the
 * archive's bytes, so carrying them over is the only honest thing to do with
 * them. What was wrong is that it happened in silence. This module is the
 * sentence that ends the silence, kept here — pure, with no fs and no manifest —
 * so main's console line and the picker's alert are the same words, and so it
 * can be tested without a project (`tools/test-working-copy-remint.js`).
 *
 * ── FIRST mint is not this ──────────────────────────────────────────────────
 *
 * A project imported as an EPUB has no working copy until something asks for
 * one, and making it then is the ordinary, invisible first act of opening the
 * book. There are no earlier edits, nothing carries over, and there is nothing
 * to tell anybody. Only a RE-mint — a record naming a file that is not on disk —
 * is evidence that a file somebody was editing has gone, and only that is said.
 */

/**
 * What a re-mint carried over, counted from the manifest at the moment the copy
 * was made again.
 *
 * Every count is taken BEFORE the record is rewritten. `registerEpubExport`
 * replaces `outputs.epub` wholesale — that call means "the book has been
 * rebuilt" — so the strikes are only readable up to that instant.
 */
export interface WorkingCopyRemint {
  /** The book the record named, project-relative — the file that was missing. */
  relPath: string;
  /**
   * Block deletions recorded in `manifest.source`. These SURVIVE the re-mint and
   * apply to the new copy: they are md5s of the laid-out content, and the
   * content is the archive's, which is what was copied.
   */
  deletedBlockIds: number;
  /** Page deletions in `manifest.source`. They survive for the same reason. */
  deletedPages: number;
  /**
   * Elements that were struck out for narration, as the old record held them.
   *
   * These do NOT survive: they live inside `outputs.epub`, which the re-mint
   * replaces. Counted anyway and said out loud, because a user who struck four
   * hundred footnotes out of a book needs to be told they are gone as much as
   * they need to be told the page deletions are not.
   */
  narrationStrikes: number;
}

/** `n thing(s)`, the plural spelling this codebase uses everywhere. */
function count(n: number, noun: string): string {
  return `${n} ${noun}(s)`;
}

/**
 * What to tell the user, in one paragraph.
 *
 * It states three things in this order, because that is the order the confusion
 * happens in: the file was made again (so deleting it did not do what they
 * thought), what carried over into it, and what to press to actually start
 * fresh. The rail's button is named in the words on the button, so there is
 * nothing to hunt for.
 */
export function describeWorkingCopyRemint(remint: WorkingCopyRemint): string {
  const carried = `${count(remint.deletedBlockIds, 'deleted block')} and `
    + `${count(remint.deletedPages, 'deleted page')}`;
  const strikes = remint.narrationStrikes > 0
    ? ` The ${count(remint.narrationStrikes, 'element')} you had struck out for narration belonged `
      + 'to the copy that is gone, and went with it.'
    : '';
  return (
    `${remint.relPath} was not on disk, so it has been made again from this project's archive `
    + 'original. Deleting that file does not start the book over: your edits are recorded in the '
    + `project rather than written into the file, and ${carried} recorded earlier still apply to `
    + `the new copy.${strikes} To actually start fresh, use "Erase all changes and start over" at `
    + 'the foot of the task rail.'
  );
}

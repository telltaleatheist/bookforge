import type { ProjectDocument } from './types';

/**
 * WHICH ROW IS THE BOOK — the rule, shared by both sides.
 *
 * ── What this used to be, and why it changed shape ──────────────────────────
 *
 * It used to pick a FILE out of a project by an ordering of roles: the archived
 * scan first, then an imported book, then a cast one. That was the right answer
 * to the wrong question, and the question was wrong because a project's rows
 * were files. Now a row is a FILE TYPE with a chain behind it, and the question
 * has a direct answer: the book is the row whose chain STARTS with the file the
 * user handed over.
 *
 * `ProjectDocument.origin` carries that, decided in `summarise` from the step's
 * own recorded cost — the origin step of the imported type is the one marked
 * irreplaceable, because it came from outside this program and there may be no
 * other copy of it anywhere. So the ordering is gone and with it the chance of
 * the two sides ordering differently.
 *
 * ── Why both sides need it ──────────────────────────────────────────────────
 *
 * The renderer decides which warning to show; MAIN decides what may actually be
 * erased. Two copies of this rule that drifted would let the renderer offer
 * "delete this file" over the document every other document was made FROM — or,
 * far worse, show a file-sized warning for something that takes the whole folder
 * with it.
 */
export function bookRow(documents: readonly ProjectDocument[]): ProjectDocument | null {
  return documents.find((document) => document.origin) ?? null;
}

/**
 * The row a click on a project opens, and what a delete of it would mean.
 *
 * The book itself where there is one; otherwise whatever the project does have,
 * because a project that lost its import is still a folder with work in it and
 * a row that opens nothing is worse than a row that opens something.
 *
 * MISSING ROWS ARE SKIPPED rather than preferred and then failed on: a click
 * that lands on a dead path produces an error about bookkeeping the user never
 * saw. `.txt` is skipped for the older reason — there is no text tab in this
 * app, so it cannot be what a click lands on.
 */
export function originalOf(documents: readonly ProjectDocument[]): ProjectDocument | null {
  const openable = documents.filter(
    (document) => !document.missing && document.kind !== 'txt');
  return openable.find((document) => document.origin) ?? openable[0] ?? null;
}

/**
 * Is this row the book — the one whose delete is the project's delete?
 *
 * ── THE BASENAME MATCH THAT LIVED HERE WAS A LOADED GUN ─────────────────────
 *
 * It compared the TAIL of each step's project-relative path against the BASENAME
 * of the absolute path being deleted:
 *
 *   step.file.endsWith(basename(filePath))
 *
 * which is true for `generated/archived-1748…/book.epub` and `book.epub` — so
 * after ANY rotation (and a rotation happens every time a rendering is made
 * again) the ✕ on a perfectly ordinary document reported itself as the BOOK's
 * delete, and the app erased the entire project: the readings bank, the
 * overlays, the archived original, everything. A curation and hours of GPU, for
 * a click on a row that said it would remove one file.
 *
 * IT IS THE HOUSE RULE WE ALREADY WROTE DOWN — never match by basename across
 * directories — broken in the one function where breaking it is most expensive.
 * A project's layers are FULL OF files that share a name: `archive/book.pdf`,
 * `working/book.pdf` and `generated/archived-…/book.pdf` are three different
 * documents, and telling them apart is the entire job of the directory they are
 * in.
 *
 * ── What it compares now ────────────────────────────────────────────────────
 *
 * PROJECT-RELATIVE AGAINST PROJECT-RELATIVE, both folded, with the project's own
 * directory supplied by the caller. A step's `file` only means anything as a
 * path when it is resolved against the folder it is relative TO, and inferring
 * that folder from the row's own path is a guess this function does not have to
 * make: every caller is already holding `project.dir`, because it got the
 * documents out of the same summary.
 *
 * WITHOUT IT, only the live path can match — which is safe (a delete is never
 * escalated on a guess) and is the honest limit of what can be known from a
 * document list alone.
 *
 * The steps are consulted at all — rather than only `book.path` — because a
 * delete can name an EARLIER step of the book's chain (the archived original, a
 * previous version), and those are the book too.
 */
export function isBook(
  documents: readonly ProjectDocument[],
  filePath: string,
  projectDir?: string,
): boolean {
  const book = bookRow(documents);
  if (book === null) return false;
  const target = fold(filePath);
  if (fold(book.path) === target) return true;
  if (projectDir === undefined) return false;
  const root = fold(projectDir);
  return book.steps.some((step) => `${root}/${fold(step.file)}` === target);
}

/** One spelling for a path, so Windows' three become one. */
export function fold(target: string): string {
  return target.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

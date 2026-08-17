/**
 * book-headings — a chapter heading the pages never had, put INTO the book, and
 * the one edit that takes it back out.
 *
 * ── Why this exists (Owen, 2026-08-12) ──────────────────────────────────────
 *
 * "theres a book that lost the chapter headers but kept the body text. i have
 * ot insert chapter headers in where they belong for this book." A relabel
 * cannot answer that — `data-bf-user-cat` says what an element IS, and this
 * book has no element to say it about. So the heading is ADDED: an edit of the
 * BOOK, written into the working copy's own markup, one authority and one
 * derivation, exactly as a relabel is (electron/book-categories.ts) and for the
 * same reason — the naming pass, the Chapter tab, the narration cut and the
 * viewer all read the book, and an overlay would be invisible to every one of
 * them.
 *
 * ── Why this is more dangerous than a relabel, and what pays for it ────────
 *
 * A relabel moves nothing, so the strike record is re-stamped with its keys
 * untouched. An insert ADDS a text unit, so every narration key at or after
 * the insertion point in that file names the element one further on — the same
 * class of edit as the chapter-opening fold, run the other way. The record is
 * therefore CARRIED, `+1` on insert and `-1` on removal, fingerprints
 * travelling with their keys, in the ONE manifest transaction that logs the
 * edit (electron/manifest-service.ts, `recordChapterHeadingInsert` /
 * `recordInsertedHeadingRemoval`). A strike that cannot be carried refuses the
 * whole gesture BEFORE any byte is written — never a dropped strike.
 *
 * ── What is never touched ───────────────────────────────────────────────────
 *
 * The ARCHIVE. `manifest.outputs.epub` is the working copy and is the only
 * file opened for writing (memory: pipeline-source-model-archive-as-source).
 * The narration copy is DERIVED; the next cut re-reads the edited book.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  insertChapterHeadingInBookFile,
  removeInsertedHeadingFromBookFile,
} from './epub-processor';
import { bookDigest } from './sidecar-binding';
import * as manifestService from './manifest-service';
import { enumerateNarrationElements } from './quire-stamp';
import {
  migrateNarrationDeletionsForHeadingInsert,
  migrateNarrationDeletionsForHeadingRemoval,
  narrationDeletionsStaleReason,
  parseNarrationElementKey,
  type NarrationDeletions,
  type NarrationElementKey,
} from '../shared/vlm/narration-deletions';

/** What inserting a heading did, in the terms the picker says out loud. */
export interface BookChapterHeadingInsertResult {
  /** The zip entry the heading was inserted into. */
  file: string;
  /** The element it sits before — a position in the book BEFORE this edit. */
  beforeElementKey: string;
  /** The heading's own key in the book now: the position it took over. */
  insertedKey: string;
  /** What the heading says, whitespace collapsed. */
  title: string;
  /** Strike keys that now name their element under a new index. */
  renumberedStrikes: number;
  /** The zip entries this gesture rewrote — what the window lays out again. */
  rewrittenEntries: string[];
  /** The working copy's sha256 before the edit and after it. */
  fromSha256: string;
  toSha256: string;
}

/** What removing an inserted heading did. */
export interface BookInsertedHeadingRemovalResult {
  file: string;
  /** The heading's key — a position in the book BEFORE this edit. */
  elementKey: string;
  /** What the heading said when it was removed. */
  textBefore: string;
  renumberedStrikes: number;
  rewrittenEntries: string[];
  fromSha256: string;
  toSha256: string;
}

/**
 * Can every strike be carried across the edit? Asked BEFORE the book is
 * touched.
 *
 * The same arithmetic the manifest transaction will run is run here as a dry
 * run, against the same walk that mints the keys (`enumerateNarrationElements`,
 * narrowed to the one document — sound because an element's key is a function
 * of its own document alone). A strike naming nothing, or naming the element
 * being removed, THROWS here, while "nothing was written" is still true — the
 * transaction's own guard is then unreachable in the ordinary case and exists
 * for the record that changed while the write ran.
 *
 * A document the walk does not have is not judged here: the writer refuses it
 * BY NAME before writing anything, and the carry has nothing to say about a
 * document that is not there.
 */
async function dryRunStrikeCarry(
  bookPath: string,
  record: NarrationDeletions,
  file: string,
  whatFor: string,
  carry: (record: NarrationDeletions, unitsInFile: number) => void,
): Promise<void> {
  const walked = await enumerateNarrationElements(bookPath, whatFor, new Set([file]));
  const docWalk = walked.find((w) => w.file === file);
  if (docWalk === undefined) return;
  carry(record, docWalk.entries.filter((e) => e.kind === 'text').length);
}

/**
 * Insert a chapter heading into the project's book, immediately before one of
 * its elements.
 *
 * `beforeElementKey` is the block's `bf_element` — `<zip entry>#<index>`, a
 * position in the one enumeration walk everything shares — and the heading
 * takes that position: the new element's key IS `beforeElementKey`, and the
 * element it displaced (with everything after it) is one index further on.
 *
 * Every refusal names what was missing and leaves the project exactly as it
 * was found: a project with no working copy, a book that is not
 * conversion-stamped, a key naming a picture or a document the book does not
 * have, a stale strike record, a strike that cannot be carried. See
 * `insertChapterHeadingInBookFile`, which owns the refusals about the FILE;
 * this one owns the refusals about the PROJECT.
 *
 * `familyId` says which chain's book gains the heading. Absent is the ordinary
 * case, a project with a single chain; a project with several refuses rather
 * than guessing which book the user is looking at.
 */
export async function insertBookChapterHeading(
  projectDir: string,
  beforeElementKey: NarrationElementKey,
  title: string,
  familyId?: string,
): Promise<BookChapterHeadingInsertResult> {
  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to insert a `
      + 'chapter heading into. Open the book from Studio — an EPUB gets its working copy the '
      + 'moment it opens, and a PDF gets one from Generate EPUB, which reads its pages.'
    );
  }
  const target = parseNarrationElementKey(beforeElementKey);
  // Non-unit keys go straight to the writer, which owns that refusal and says
  // it by name before writing anything — the carry has nothing to dry-run for
  // a key that names no position in the text walk.
  const insertIndex = target.kind === 'unit' ? target.index : null;
  const whatFor = `the chapter-heading insert in ${path.basename(projectDir)}`;

  // The book as it stands, measured BEFORE anything is written: it is what says
  // whether the strike record was describing this book a moment ago, and what
  // the edit log records this insert as having started from.
  const { digest: fromSha256 } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);
  if (stale !== null) {
    // NOT cleared here: clearing is a write, and an insert that refuses must
    // leave the project exactly as it found it — the same rule the fold and
    // the relabel follow.
    throw new Error(
      'The heading was not inserted, because the strikes recorded against this book cannot be '
      + `carried across the edit.\n\n${stale}`
    );
  }
  if (insertIndex !== null && recorded !== null) {
    await dryRunStrikeCarry(
      book.absPath, recorded, target.file, whatFor,
      (record, units) =>
        void migrateNarrationDeletionsForHeadingInsert(record, target.file, insertIndex, units));
  }

  // ── Written INTO the book, not staged and landed on it ────────────────────
  //
  // In place for the same measured reasons as the relabel (see
  // electron/book-categories.ts): `DirectoryEpubSink` writes only the one
  // touched document, and an in-place verification that fails puts its
  // original bytes back before it throws.
  const written = await insertChapterHeadingInBookFile(
    book.absPath, book.absPath, beforeElementKey, title);
  if (insertIndex === null) {
    // Unreachable: the writer refuses a picture or document key by name before
    // it writes. Named all the same, because reaching it would mean the writer
    // inserted on a key the carry below has no arithmetic for.
    throw new Error(
      `${beforeElementKey} names no text element, yet the heading was written — this is a bug. `
      + 'The edit was not recorded; re-open the book.'
    );
  }

  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  const carried = await manifestService.recordChapterHeadingInsert(projectDir, {
    kind: 'insert-chapter-heading',
    at,
    file: written.file,
    beforeElementKey,
    insertedKey: written.insertedKey,
    title: written.title,
    sourcePage: written.sourcePage,
    fromSha256,
    toSha256,
  }, insertIndex, written.unitsBefore, familyId);

  console.log(
    `[book-headings] ${path.basename(projectDir)}: inserted <h1> "${written.title}" as `
    + `${written.insertedKey} (page ${written.sourcePage}), carrying `
    + `${carried.renumberedStrikes} strike key(s) +1.`
  );

  return {
    file: written.file,
    beforeElementKey,
    insertedKey: written.insertedKey,
    title: written.title,
    renumberedStrikes: carried.renumberedStrikes,
    rewrittenEntries: [written.file],
    fromSha256,
    toSha256,
  };
}

/**
 * Remove an inserted chapter heading from the project's book — the insert's
 * exact inverse, for undo.
 *
 * The strikes are carried `-1` in the same transaction that logs the edit, and
 * a strike ON the heading refuses the removal by name (unstrike first) before
 * any byte is written — an undo must never eat a user decision. Everything the
 * file-level remover refuses (`removeInsertedHeadingFromBookFile` — anything
 * that is not the shape the insert writes) refuses here untouched.
 */
export async function removeBookInsertedHeading(
  projectDir: string,
  elementKey: NarrationElementKey,
  familyId?: string,
): Promise<BookInsertedHeadingRemovalResult> {
  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to remove a `
      + 'chapter heading from. Open the book from Studio — an EPUB gets its working copy the '
      + 'moment it opens, and a PDF gets one from Generate EPUB, which reads its pages.'
    );
  }
  const target = parseNarrationElementKey(elementKey);
  // Same shape as the insert: the writer owns the non-unit refusal.
  const removedIndex = target.kind === 'unit' ? target.index : null;
  const whatFor = `the chapter-heading removal in ${path.basename(projectDir)}`;

  const { digest: fromSha256 } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);
  if (stale !== null) {
    throw new Error(
      'The heading was not removed, because the strikes recorded against this book cannot be '
      + `carried across the edit.\n\n${stale}`
    );
  }
  if (removedIndex !== null && recorded !== null) {
    await dryRunStrikeCarry(
      book.absPath, recorded, target.file, whatFor,
      (record, units) =>
        void migrateNarrationDeletionsForHeadingRemoval(record, target.file, removedIndex, units));
  }

  const written = await removeInsertedHeadingFromBookFile(book.absPath, book.absPath, elementKey);
  if (removedIndex === null) {
    // Unreachable: the writer refuses a picture or document key by name before
    // it writes — see the insert's twin guard.
    throw new Error(
      `${elementKey} names no text element, yet the heading was removed — this is a bug. `
      + 'The edit was not recorded; re-open the book.'
    );
  }

  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  const carried = await manifestService.recordInsertedHeadingRemoval(projectDir, {
    kind: 'remove-inserted-heading',
    at,
    file: written.file,
    elementKey,
    textBefore: written.textBefore,
    fromSha256,
    toSha256,
  }, removedIndex, written.unitsBefore, familyId);

  console.log(
    `[book-headings] ${path.basename(projectDir)}: removed the heading ${elementKey} `
    + `("${written.textBefore}"), carrying ${carried.renumberedStrikes} strike key(s) -1.`
  );

  return {
    file: written.file,
    elementKey,
    textBefore: written.textBefore,
    renumberedStrikes: carried.renumberedStrikes,
    rewrittenEntries: [written.file],
    fromSha256,
    toSha256,
  };
}

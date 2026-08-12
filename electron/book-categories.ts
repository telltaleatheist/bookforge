/**
 * book-categories — what the book says each of its elements IS, and the one
 * edit that changes it.
 *
 * ── Why a relabel is an edit to the BOOK ────────────────────────────────────
 *
 * Owen, 2026-08-10, having promoted a `title` block to `chapter` in the picker
 * and then found the chapter's own heading would not follow its new name: "it
 * apparently didnt actually change it to chapter, just visually?"
 *
 * It had not. For a book, the picker recorded that relabel in its editor state
 * (`categoryCorrections`) — a record about a SESSION, saved beside the project
 * and read by the picker window and nothing else. Every real derivation reads
 * the BOOK: the unattended naming pass that re-runs at every project open
 * (electron/narration-export.ts), the Chapter tab's rows, the narration cut, the
 * preserving export, the viewer. All of them still saw a `title`, and the
 * overlay was invisible to every one of them.
 *
 * So a category change on a book block is an EDIT OF THE BOOK, and it is written
 * into the working copy's own markup — `data-bf-user-cat` on the one element
 * (electron/epub-processor.ts, `USER_CATEGORY_ATTR`). ONE authority, one
 * derivation, which is the same rule a chapter's NAME already follows: it lives
 * in the book's table of contents and nowhere else (electron/book-chapters.ts).
 *
 * The alternative — hand the picker's correction to the naming pass as a
 * parameter — was considered and rejected before this was built: the pass also
 * runs unattended at every project open, that run carries no parameter, and it
 * would then name the element the book's own markup calls the opening. The book
 * would print the chapter's name twice, in two places, depending on who asked.
 *
 * ── What is never touched ───────────────────────────────────────────────────
 *
 * The ARCHIVE. `manifest.outputs.epub` is the working copy and is the only file
 * opened for writing (memory: pipeline-source-model-archive-as-source). The
 * narration copy is not touched either and does not need to be: it is DERIVED,
 * so the next cut re-reads the relabelled book — exactly as it does after a
 * chapter-opening fold.
 *
 * ── The record ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-09, on the fold: "as long as we have a record of what it was
 * before and what it was changed to, it can be changed." The record here is
 * `outputs.epub.bookEdits`, one `set-block-category` entry per relabelled
 * element, written in the same manifest transaction that re-stamps the
 * positional strike record onto the book's new bytes.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  setElementCategoriesInBookFile,
  type BookElementCategoryRequest,
} from './epub-processor';
import { bookDigest } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  narrationDeletionsStaleReason,
  type NarrationElementKey,
} from '../shared/vlm/narration-deletions';

/** What a relabel did, in the terms the picker says out loud. */
export interface BookBlockCategoryResult {
  /** The zip entry the relabelled element lives in. */
  file: string;
  /** `<zip entry>#<index>` — the element, unmoved by this edit. */
  elementKey: string;
  /** What the book said it was, or null when the book stated nothing about it. */
  categoryBefore: string | null;
  /** What the book says it is now. */
  categoryAfter: string;
  /**
   * False when the book ALREADY answered with this category and no byte was
   * written — the same idempotence the naming pass keeps, and for the same
   * reason: the book's bytes stamp the narration strikes and key the analysis
   * cache, so rewriting them to say what they already said is work that
   * invalidates both for nothing.
   */
  written: boolean;
  /** The working copy's sha256 before the edit and after it. Equal when nothing was written. */
  fromSha256: string;
  toSha256: string;
}

/** What a whole relabel did — every block it named, and to which book. */
export interface BookBlockCategoriesResult {
  /** One per element asked about, in the order asked. */
  results: BookBlockCategoryResult[];
  /**
   * The zip entries whose bytes this gesture rewrote, deduped.
   *
   * What the window lays out again instead of re-opening the book. Named by the
   * code that rewrote them and never inferred from a count or a timestamp — a
   * guess at "which documents changed" relayouts the wrong chapter.
   */
  rewrittenEntries: string[];
  /** The working copy's sha256 before the gesture and after it. Equal when nothing was written. */
  fromSha256: string;
  toSha256: string;
}

/**
 * Say, in the project's book, what a RUN of its elements are.
 *
 * Each `elementKey` is the block's `bf_element` — `<zip entry>#<index>`, a
 * position in the one enumeration walk everything shares
 * (shared/vlm/narration-deletions.ts), which is the same identity a narration
 * strike is recorded under and the same one a chapter rename is addressed by.
 * That is exact where a page number would be a guess: an EPUB's pages are the
 * paginator's invention, not the paper's.
 *
 * Every refusal names what was missing — a project with no working copy, a
 * category outside the palette, a key naming a picture or a document the book
 * does not have — and nothing is written, for any element in the batch. See
 * `setElementCategoriesInBookFile`, which owns the refusals about the FILE; this
 * one owns the refusals about the PROJECT.
 *
 * `familyId` says which chain's book is being relabelled. Absent is the ordinary
 * case, a project with a single chain; a project with several refuses rather
 * than guessing which book the user is looking at.
 *
 * ── One gesture, one write, one identity ──────────────────────────────────
 *
 * A person relabels a run of blocks. Sending them one at a time made the whole
 * project-level ceremony happen per block: the book measured before and after,
 * the strike record checked, the manifest transaction, and behind each of them
 * the chapter-naming pass. Measured 2026-08-11 on the migrated Nuremberg
 * project, that was ~500 ms per element and almost all of it fixed cost.
 *
 * So the book is measured ONCE before, written ONCE, measured ONCE after, and
 * the whole batch's edits reach the manifest in ONE transaction — which is not
 * only faster but the only correct shape: the strike record is re-stamped from
 * `fromSha256` to `toSha256`, and recording the edits one at a time would move
 * that stamp on the first and then refuse the second for not matching it
 * (electron/manifest-service.ts, `recordBlockCategoryChanges`).
 */
export async function setBookBlockCategories(
  projectDir: string,
  requests: readonly BookElementCategoryRequest[],
  familyId?: string,
): Promise<BookBlockCategoriesResult> {
  const book = await manifestService.readExportEpub(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to say what `
      + `${requests.length === 1 ? 'this block is' : 'these blocks are'} in. Open the book from `
      + 'Studio — an EPUB gets its working copy the moment it opens, and a PDF gets one from '
      + 'Generate EPUB, which reads its pages.'
    );
  }

  // The book as it stands, measured BEFORE anything is written: it is what says
  // whether the strike record was describing this book a moment ago, and what
  // the edit log records this relabel as having started from.
  const { digest: fromSha256 } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);
  if (stale !== null) {
    // NOT cleared here: clearing is a write, and a relabel that refuses must
    // leave the project exactly as it found it — the same rule the fold follows.
    throw new Error(
      `${requests.length === 1 ? 'This block was' : 'These blocks were'} not relabelled, because `
      + `the strikes recorded against this book cannot be carried across the edit.\n\n${stale}`
    );
  }

  // ── Written INTO the book, not staged and landed on it ────────────────────
  //
  // This used to write the edited book into `%TEMP%\bookforge-staging` and land
  // it with `moveIntoPlace`. That shape came from the days when a book was one
  // zip file, where landing it was a single rename; against an exploded working
  // copy it means the whole tree is written out and then copied back — 84
  // entries and 32.5 MB of page images for one attribute on one `<p>`.
  //
  // The cost was not only the copying. `moveIntoPlace` lands a tree by copying
  // it beside the destination and renaming, so EVERY entry came back with a new
  // inode and a new mtime, and the `bookDigest` below then had to SHA-256 all
  // 32.5 MB again — as did the one at the top of the next relabel, and the one
  // inside the naming pass that runs behind this one. Measured on the migrated
  // Nuremberg project, 2026-08-11: 1500 ms for one click on the palette, of
  // which ~1050 ms was that copy and the re-hashing it forced.
  //
  // In place, `DirectoryEpubSink` writes only the entries whose bytes moved —
  // the touched documents — so every other entry keeps the identity the digest
  // cache knows it by (electron/sidecar-binding.ts, `treeEntrySha256`). Nothing
  // about the refusals changes: `setElementCategoriesInBookFile` verifies the
  // written book exactly as it did, and an in-place verification that fails puts
  // every touched document's original bytes back before it throws.
  const written = await setElementCategoriesInBookFile(book.absPath, book.absPath, requests);
  const changed = written.filter((w) => w.written);

  if (changed.length === 0) {
    // The book already says all of this, and not one byte of it was touched.
    return {
      results: written.map((w) => ({
        file: w.edit.file,
        elementKey: w.edit.elementKey,
        categoryBefore: w.edit.categoryBefore,
        categoryAfter: w.edit.categoryAfter,
        written: false,
        fromSha256,
        toSha256: fromSha256,
      })),
      rewrittenEntries: [],
      fromSha256,
      toSha256: fromSha256,
    };
  }

  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  await manifestService.recordBlockCategoryChanges(projectDir, changed.map((w) => ({
    kind: 'set-block-category' as const,
    at,
    file: w.edit.file,
    elementKey: w.edit.elementKey,
    tag: w.edit.tag,
    categoryBefore: w.edit.categoryBefore,
    categoryAfter: w.edit.categoryAfter,
    excerpt: w.edit.excerpt,
    fromSha256,
    toSha256,
  })), familyId);

  for (const w of changed) {
    console.log(
      `[book-categories] ${path.basename(projectDir)}: ${w.edit.elementKey} (<${w.edit.tag}> "`
      + `${w.edit.excerpt}") is now ${w.edit.categoryAfter}, was `
      + `${w.edit.categoryBefore === null ? 'unstated' : w.edit.categoryBefore}.`
    );
  }

  return {
    results: written.map((w) => ({
      file: w.edit.file,
      elementKey: w.edit.elementKey,
      categoryBefore: w.edit.categoryBefore,
      categoryAfter: w.edit.categoryAfter,
      written: w.written,
      fromSha256,
      // An element the book already labelled this way sat in a document that may
      // still have been rewritten around it, so the book it is in DID move. The
      // pair it reports is the gesture's, because that is the book it now
      // describes — claiming otherwise would name a file nobody has.
      toSha256,
    })),
    rewrittenEntries: [...new Set(changed.map((w) => w.edit.file))],
    fromSha256,
    toSha256,
  };
}

/**
 * Say, in the project's book, what ONE of its elements is.
 *
 * The batch of one, kept as its own name because a single result rather than a
 * list of them is what a single relabel means. Every rule and refusal is
 * `setBookBlockCategories`'s.
 */
export async function setBookBlockCategory(
  projectDir: string,
  elementKey: NarrationElementKey,
  categoryId: string,
  familyId?: string,
): Promise<BookBlockCategoryResult> {
  const { results } = await setBookBlockCategories(
    projectDir, [{ elementKey, categoryId }], familyId);
  return results[0];
}

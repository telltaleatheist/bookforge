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
import * as os from 'os';
import * as path from 'path';

import { setElementCategoryInBookFile } from './epub-processor';
import { moveIntoPlace } from './processing-passes';
import { bookDigest } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  narrationDeletionsStaleReason,
  type NarrationElementKey,
} from '../shared/vlm/narration-deletions';

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

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

/**
 * Say, in the project's book, what one of its elements is.
 *
 * `elementKey` is the block's `bf_element` — `<zip entry>#<index>`, a position
 * in the one enumeration walk everything shares
 * (shared/vlm/narration-deletions.ts), which is the same identity a narration
 * strike is recorded under and the same one a chapter rename is addressed by.
 * That is exact where a page number would be a guess: an EPUB's pages are the
 * paginator's invention, not the paper's.
 *
 * Every refusal names what was missing — a project with no working copy, a
 * category outside the palette, a key naming a picture or a document the book
 * does not have — and nothing is written. See `setElementCategoryInBookFile`,
 * which owns the refusals about the FILE; this one owns the refusals about the
 * PROJECT.
 *
 * `familyId` says which chain's book is being relabelled. Absent is the ordinary
 * case, a project with a single chain; a project with several refuses rather
 * than guessing which book the user is looking at.
 */
export async function setBookBlockCategory(
  projectDir: string,
  elementKey: NarrationElementKey,
  categoryId: string,
  familyId?: string,
): Promise<BookBlockCategoryResult> {
  const book = await manifestService.readExportEpub(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to say what `
      + 'this block is in. Open the book from Studio — an EPUB gets its working copy the moment it '
      + 'opens, and a PDF gets one from Generate EPUB, which reads its pages.'
    );
  }

  // The book as it stands, measured BEFORE anything is written: it is what says
  // whether the strike record was describing this book a moment ago, and what
  // the edit log records this relabel as having started from.
  const { digest: fromSha256, hex: fromHex } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);
  if (stale !== null) {
    // NOT cleared here: clearing is a write, and a relabel that refuses must
    // leave the project exactly as it found it — the same rule the fold follows.
    throw new Error(
      'This block was not relabelled, because the strikes recorded against this book cannot be '
      + `carried across the edit.\n\n${stale}`
    );
  }

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  // Named from the HEX, not from the recorded digest: an exploded book's digest
  // carries an algorithm tag, and slicing that would give every book in the
  // project the same staging name (shared/book-digest.ts, `bookDigestHex`).
  const staged = path.join(STAGING_DIR, `relabel-${fromHex.slice(0, 16)}.epub`);
  const { written, edit } = await setElementCategoryInBookFile(
    book.absPath, staged, elementKey, categoryId);

  if (!written) {
    // The book already says this. Nothing was staged, and the `rm` is for the
    // case where something below the write refused after one had been.
    await fs.promises.rm(staged, { force: true });
    return {
      file: edit.file,
      elementKey: edit.elementKey,
      categoryBefore: edit.categoryBefore,
      categoryAfter: edit.categoryAfter,
      written: false,
      fromSha256,
      toSha256: fromSha256,
    };
  }

  await moveIntoPlace(staged, book.absPath);
  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  await manifestService.recordBlockCategoryChange(projectDir, {
    kind: 'set-block-category',
    at,
    file: edit.file,
    elementKey: edit.elementKey,
    tag: edit.tag,
    categoryBefore: edit.categoryBefore,
    categoryAfter: edit.categoryAfter,
    excerpt: edit.excerpt,
    fromSha256,
    toSha256,
  }, familyId);

  console.log(
    `[book-categories] ${path.basename(projectDir)}: ${edit.elementKey} (<${edit.tag}> "`
    + `${edit.excerpt}") is now ${edit.categoryAfter}, was `
    + `${edit.categoryBefore === null ? 'unstated' : edit.categoryBefore}.`
  );

  return {
    file: edit.file,
    elementKey: edit.elementKey,
    categoryBefore: edit.categoryBefore,
    categoryAfter: edit.categoryAfter,
    written: true,
    fromSha256,
    toSha256,
  };
}

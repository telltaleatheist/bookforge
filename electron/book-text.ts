/**
 * book-text — what the book SAYS, and the one edit that changes it.
 *
 * ── Why a text fix is an edit of the BOOK ──────────────────────────────────
 *
 * The same argument `book-categories.ts` makes about a category, one step
 * further along. The picker has always let a reader double-click a block and
 * retype it. For a book, that correction went into editor state as
 * `textCorrections`, keyed by BLOCK ID — and it was read by the picker's own
 * export service and by nothing else. Every real derivation reads the BOOK: the
 * narration cut, the preserving export, the Chapter tab, the naming pass, the
 * viewer. So a reader who fixed a wrong chapter title saw it fixed on screen
 * and heard the old one in the audiobook.
 *
 * A block id was also the wrong identity to hang it on. `blockId(elementKey,
 * page)` is a function of the PAGE the element landed on, which means a text
 * correction was bound to a pagination: `shared/document/editor-layout.ts`
 * counts `textCorrections` among the layout-keyed records, so every one of them
 * was refused wholesale the moment the layout moved. Written into the book
 * against the element key, a fix is bound to the element and to nothing else,
 * and it outlives every relayout.
 *
 * ── What is never touched ───────────────────────────────────────────────────
 *
 * The ARCHIVE. The working copy is the only artifact opened for writing (memory:
 * pipeline-source-model-archive-as-source). The narration copy is not touched
 * either and does not need to be: it is DERIVED, so the next cut re-reads the
 * corrected book.
 *
 * ── The record ──────────────────────────────────────────────────────────────
 *
 * `outputs.epub.bookEdits`, one `set-block-text` entry per edited element,
 * carrying what it said before and what it says now — so the change is
 * recoverable by reading, which is the standing rule for edits to a book (Owen,
 * 2026-08-09: "as long as we have a record of what it was before and what it was
 * changed to, it can be changed").
 *
 * This edit is alone in the union in changing WORDS, and that is why the
 * transaction it lands in does one thing more than the relabel's: a narration
 * strike on the edited element is re-fingerprinted, because a fingerprint is the
 * opening of the text the strike was made against and that text is what just
 * changed. See `manifestService.recordBlockTextChange`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { setElementTextInBookFile } from './epub-processor';
import { moveIntoPlace } from './processing-passes';
import { bookDigest } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  narrationDeletionsStaleReason,
  type NarrationElementKey,
} from '../shared/vlm/narration-deletions';

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/** What a text fix did, in the terms the picker says out loud. */
export interface BookBlockTextResult {
  /** The zip entry the edited element lives in. */
  file: string;
  /** `<zip entry>#<index>` — the element, unmoved by this edit. */
  elementKey: NarrationElementKey;
  /** What the element read before, whitespace collapsed. */
  textBefore: string;
  /** What it reads now. */
  textAfter: string;
  /**
   * False when the element ALREADY read this way and no byte was written — a
   * retype that changed only whitespace the reader cannot see counts as this.
   */
  written: boolean;
  /**
   * True when a narration strike on this element was carried onto the new words.
   * Worth saying out loud: the user's strike now describes a different sentence
   * than the one they struck.
   */
  refingerprinted: boolean;
  fromSha256: string;
  toSha256: string;
}

/**
 * Make the book say what the reader typed, for one element.
 *
 * `elementKey` is the block's `bf_element` — a position in the one enumeration
 * walk everything shares, which is the same identity a narration strike is
 * recorded under and a relabel is addressed by.
 *
 * `newText` is the element's WHOLE text as it should now read, collapsed the way
 * the reader was shown it. Not the text of one page's fragment of it: an element
 * that spans a page break is one element, and giving this the fragment would
 * delete the rest of the paragraph. The caller is responsible for handing over
 * the whole thing, and `readBookBlockText` is how it gets it.
 *
 * `familyId` says which chain's book is being edited. Absent is the ordinary
 * case; a project with several chains refuses rather than guessing.
 */
export async function setBookBlockText(
  projectDir: string,
  elementKey: NarrationElementKey,
  newText: string,
  familyId?: string,
): Promise<BookBlockTextResult> {
  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to correct. `
      + 'Open the book from Studio — an EPUB gets its working copy the moment it opens, and a PDF '
      + 'gets one from Generate EPUB, which reads its pages.'
    );
  }

  const { digest: fromSha256, hex: fromHex } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);
  if (stale !== null) {
    // NOT cleared here: clearing is a write, and an edit that refuses must leave
    // the project exactly as it found it — the rule every book edit follows.
    throw new Error(
      'This text was not corrected, because the strikes recorded against this book cannot be '
      + `carried across the edit.\n\n${stale}`
    );
  }

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  // Named from the HEX, not from the recorded digest: an exploded book's digest
  // carries an algorithm tag, and slicing that would give every book in the
  // project the same staging name (shared/book-digest.ts, `bookDigestHex`).
  const staged = path.join(STAGING_DIR, `text-${fromHex.slice(0, 16)}.epub`);
  const { written, edit } = await setElementTextInBookFile(
    book.absPath, staged, elementKey, newText);

  if (!written) {
    // The book already reads that way. Nothing was staged, and the `rm` is for
    // the case where something below the write refused after one had been.
    await fs.promises.rm(staged, { force: true });
    return {
      file: edit.file,
      elementKey: edit.elementKey,
      textBefore: edit.textBefore,
      textAfter: edit.textAfter,
      written: false,
      refingerprinted: false,
      fromSha256,
      toSha256: fromSha256,
    };
  }

  await moveIntoPlace(staged, book.absPath);
  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  const { refingerprinted } = await manifestService.recordBlockTextChange(projectDir, {
    kind: 'set-block-text',
    at,
    file: edit.file,
    elementKey: edit.elementKey,
    tag: edit.tag,
    textBefore: edit.textBefore,
    textAfter: edit.textAfter,
    fromSha256,
    toSha256,
  }, familyId);

  console.log(
    `[book-text] ${path.basename(projectDir)}: ${edit.elementKey} (<${edit.tag}>) now reads "`
    + `${edit.textAfter.slice(0, 80)}", was "${edit.textBefore.slice(0, 80)}"`
    + `${refingerprinted ? '; a narration strike on it was carried onto the new words' : ''}.`
  );

  return {
    file: edit.file,
    elementKey: edit.elementKey,
    textBefore: edit.textBefore,
    textAfter: edit.textAfter,
    written: true,
    refingerprinted,
    fromSha256,
    toSha256,
  };
}

/**
 * What one element of the book says RIGHT NOW, whole and collapsed.
 *
 * The editor has to open on this rather than on the block it was double-clicked
 * from. A block is a page's worth of an element: quire reports an element that
 * spans a page break once per page it touches, each with only the words on that
 * page. Opening the editor on one of those and saving it would tell
 * {@link setBookBlockText} that the paragraph's whole text is its first half,
 * and the second half would be deleted.
 */
export async function readBookBlockText(
  projectDir: string,
  elementKey: NarrationElementKey,
  familyId?: string,
): Promise<{ text: string; tag: string; file: string }> {
  const book = await manifestService.readExportEpub(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to read this `
      + 'block out of.'
    );
  }
  // Through the enumeration walk everything shares, so "this element" means here
  // exactly what it means to the strike record and to the export.
  const { enumerateNarrationElements } = await import('./quire-stamp.js');
  const { unitTextContent } = await import('./epub-processor.js');
  for (const doc of await enumerateNarrationElements(book.absPath, path.basename(book.absPath))) {
    for (const entry of doc.entries) {
      if (entry.key !== elementKey) continue;
      if (entry.kind !== 'text') {
        throw new Error(`${elementKey} names a picture, which has no text to correct.`);
      }
      return {
        text: unitTextContent(entry.el).replace(/\s+/g, ' ').trim(),
        tag: entry.tag,
        file: doc.file,
      };
    }
  }
  throw new Error(
    `${elementKey} names no element in ${path.basename(book.absPath)}. The book has been rewritten `
    + 'since these blocks were laid out; re-open it and try again.'
  );
}

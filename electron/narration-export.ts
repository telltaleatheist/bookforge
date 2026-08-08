/**
 * narration-export — the SECOND file, cut from the book by what the user struck.
 *
 * The book `foundry vlm-convert` writes is complete: footnotes at the end of
 * their chapter, figures, captions, tables. That is the right thing to keep and
 * the wrong thing to narrate. So the picker lets the user strike elements out of
 * it, the strikes are recorded against the book (`outputs.epub.narrationDeletions`),
 * and this module writes what falls out — `outputs.ttsEpub`.
 *
 * **The official book is never rewritten.** That is the whole contract, and it
 * is enforced by construction: `writeNarrationEpub` copies every zip entry of
 * the input and writes somewhere else entirely. There is no code path here that
 * opens the book for writing.
 *
 * ── The staleness gate ──────────────────────────────────────────────────────
 *
 * A strike is a POSITION inside a specific file (shared/vlm/narration-deletions.ts),
 * and a pass that rewrites the book in place — simplify, translate — moves every
 * position after the first change. The record carries the book's sha256 so that
 * case is a refusal naming the book rather than a narration copy with the wrong
 * paragraphs missing. Same rule, same reason, as the editor's block deletions
 * being refused at foundry export when their `scanId` no longer matches.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeNarrationEpub, epubCarriesConversionStamps } from './epub-processor';
import { moveIntoPlace } from './processing-passes';
import { sha256File } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  narrationDeletionsStaleReason,
  type NarrationDeletions,
  type NarrationElementKey,
  type NarrationState,
} from '../shared/vlm/narration-deletions';

export type { NarrationState };

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * Everything the picker needs to open a converted book, in one call.
 *
 * A STALE record is CLEARED here rather than returned, and the reason travels
 * with the answer. Leaving it would make every later write a merge with strikes
 * about a book nobody has; returning it unaltered would put the user's strikes
 * on screen over paragraphs they do not name.
 */
export async function readNarrationState(projectDir: string): Promise<NarrationState> {
  const book = await manifestService.readExportEpub(projectDir);
  if (!book || !fs.existsSync(book.absPath)) {
    return {
      bookPath: null, bookRelPath: null, bookSha256: null, converted: false,
      deletions: null, staleReason: null, narrationPath: null, narrationRelPath: null,
    };
  }

  const { sha256 } = await sha256File(book.absPath);
  const converted = await epubCarriesConversionStamps(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir);
  const staleReason = narrationDeletionsStaleReason(recorded, sha256);
  if (staleReason !== null) await manifestService.clearNarrationDeletions(projectDir);

  const narration = await manifestService.readNarrationEpub(projectDir);

  return {
    bookPath: book.absPath,
    bookRelPath: book.relPath,
    bookSha256: sha256,
    converted,
    deletions: staleReason === null ? recorded : null,
    staleReason,
    narrationPath: narration?.absPath ?? null,
    narrationRelPath: narration?.relPath ?? null,
  };
}

/**
 * Record what the user has struck out, stamped with the book on disk now.
 *
 * The sha is measured HERE rather than taken from the caller: the renderer's
 * copy of it is as old as the last time it asked, and a stamp that says
 * "the book as the picker remembered it" would pass the staleness gate on a
 * book that had moved on.
 */
export async function saveNarrationDeletions(
  projectDir: string,
  elements: readonly NarrationElementKey[]
): Promise<NarrationDeletions> {
  // `ensureBookEpub`, not `readExportEpub`: a project imported AS an EPUB has no
  // book until something needs one, and the first strike is exactly that moment.
  // The archive original is copied to `source/<Book Title>.epub` and recorded,
  // so the strikes are positions inside a file this app owns — the archive stays
  // untouched, which is what it is for. The same call is what a Simplify or
  // Translate pass makes (processing-passes `requireBookEpub`), so both routes
  // mint the same one book.
  const book = await manifestService.ensureBookEpub(projectDir);
  const { sha256 } = await sha256File(book.absPath);
  const deletions: NarrationDeletions = {
    epubSha256: sha256,
    elements: [...new Set(elements)].sort(),
    updatedAt: new Date().toISOString(),
  };
  await manifestService.writeNarrationDeletions(projectDir, deletions);
  return deletions;
}

export interface NarrationExportResult {
  /** Absolute path to the narration copy. */
  epubPath: string;
  /** Project-relative, forward slashes. */
  relPath: string;
  removedElements: number;
  totalElements: number;
  /** Digits-only `<sup>` footnote references removed on the way out. */
  removedSupMarkers: number;
}

/**
 * Write the narration copy from the strikes as recorded, and record it.
 *
 * Deliberately takes NO deletion list: the manifest is the state, and an export
 * that could be handed a different list than the one on record would produce a
 * file whose contents no record explains. The caller saves first, then exports.
 *
 * A book with NOTHING struck still exports, and that is not a special case: the
 * narration copy is "the book as it should be read aloud", and for some books
 * that is all of it. The TTS step then has a file to point at either way, and
 * the two records never disagree about whether one exists.
 */
export async function exportNarrationEpub(projectDir: string): Promise<NarrationExportResult> {
  const book = await manifestService.readExportEpub(projectDir);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no book EPUB on disk, so there is nothing to cut a `
      + 'narration copy from.'
    );
  }
  const { sha256 } = await sha256File(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir);
  const stale = narrationDeletionsStaleReason(recorded, sha256);
  if (stale !== null) {
    await manifestService.clearNarrationDeletions(projectDir);
    throw new Error(stale);
  }

  const target = await manifestService.narrationEpubTarget(projectDir);
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `narration-${sha256.slice(0, 16)}.epub`);

  // The footnote-marker strip is ON, and it is not a choice made here: it is
  // `writeNarrationEpub`'s default, because a narration copy that keeps
  // `<sup>55</sup>` is a copy the narrator reads "fifty-five" out of. This is
  // also the ONLY place those markers are removed — no pass edits the book.
  const written = await writeNarrationEpub(book.absPath, staged, recorded?.elements ?? []);
  await moveIntoPlace(staged, target.absPath);

  await manifestService.registerNarrationEpub(projectDir, {
    path: target.relPath,
    modifiedAt: new Date().toISOString(),
    fromEpubSha256: sha256,
    removedElements: written.removedElements,
    removedSupMarkers: written.removedSupMarkers,
  });

  return {
    epubPath: target.absPath,
    relPath: target.relPath,
    removedElements: written.removedElements,
    totalElements: written.totalElements,
    removedSupMarkers: written.removedSupMarkers,
  };
}

/**
 * legacy-epub-layout — carrying a project's deletions across the change of
 * paginator, or saying, by name, that they cannot be carried.
 *
 * ── What happened ──────────────────────────────────────────────────────────
 *
 * Until August 2026 an EPUB was laid out for the picker by mupdf, which reflows
 * the book and rasterizes it at 600×900×18. Since quire it is paginated from the
 * book's own DOM. The two disagree about the only two things the picker's edit
 * set is written in: *Killing America* is 218 pages to mupdf and 183 to quire,
 * and a block id is `md5("<page>:<index>:<text>")` in one and
 * `md5("quire:<element key>:<page>")` in the other — disjoint sets, by
 * construction.
 *
 * So every saved EPUB project holds records that describe a layout this build
 * does not produce. Applying them anyway is the one thing that must never
 * happen: page 140 exists in both paginations and holds different paragraphs in
 * each, so a replay strikes out text the user never touched, silently, in a book
 * they have no reason to re-read.
 *
 * ── Why they are MIGRATED and not simply refused ───────────────────────────
 *
 * Measured across the library, 2026-08-09: of 378 projects, 163 were made from
 * an EPUB, and 49 of those carry page or block deletions — 613 deleted pages on
 * one Himmler biography, 962 deleted blocks on another book, 310 and 228 and 236
 * on others. NONE of the 163 carries a single element-keyed narration strike, so
 * for every one of them the page and block records are the ONLY record of the
 * curation. Refusing them outright throws away 49 evenings of work.
 *
 * And the mapping is derivable, exactly once. A deletion means "leave this text
 * out"; the layout is only how it was pointed at. Lay the book out the way the
 * records were written — the same mupdf, the same 600×900×18, the same bytes
 * (`ensureBookEpub` verifies the working copy is byte-identical to the archive
 * original) — and the ids reproduce. Join those blocks to the book's own
 * elements with the aligner, and the deletions come out as ELEMENT KEYS, which
 * no pagination can invalidate. Then read those keys back against quire's
 * layout, and the same text is struck out in the new page numbering.
 *
 * ── All or nothing ─────────────────────────────────────────────────────────
 *
 * The translation refuses if ANY deletion reaches nothing — the same rule and
 * the same words `refuseUnresolvedDeletions` already holds the narration export
 * to, and for the same reason Owen gave for that one: "if one is deleted, it
 * should be matched to a block and removed on reflow. if it isn't, it should
 * fail." A migration that carried 610 of 613 pages and said nothing would be
 * three paragraphs of a book read aloud that the user had struck out.
 *
 * If a mupdf upgrade has moved a line break since the records were written, the
 * old ids will not reproduce, the deletions will name no block, and this refuses
 * by name. That is the mechanism working, not failing.
 *
 * ── Measured on real projects, 2026-08-09 ──────────────────────────────────
 *
 * `PDFAnalyzer.layOutEpubTheLegacyWay` run against two of the library's own
 * books, and the two answers are exactly the two answers this is for:
 *
 *   Bonhoeffer the Assassin — 352 pages, 9,045 blocks, all 9,045 carrying an
 *   element key, 0 unaligned. Its 69 recorded page deletions resolved to 136
 *   element keys with NOTHING unresolved. That project's curation is carried
 *   over in full.
 *
 *   Apocalypse Delayed — 634 pages, 14,827 blocks, 0 unaligned. But 0 of its
 *   228 recorded block ids named a block, and 8 of its 157 recorded pages were
 *   BEYOND the layout's last page (635–639 of a 634-page book). Its records were
 *   made against a state of that file which is not the state on disk, so this
 *   refuses and says so. That staleness predates quire entirely.
 *
 * ── What the library actually looks like ───────────────────────────────────
 *
 * Only 2 of the 163 EPUB projects record an `outputs.epub` at all. The other 161
 * are older than the working-copy model and hold an UNRECORDED
 * `source/exported.epub` instead, which nothing adopts — so for most of them the
 * refusal below is the "no recorded book" one, and its cause is that earlier
 * change rather than this one. Said plainly in the message, because a user
 * reading "your deletions were not carried over" deserves the real reason.
 *
 * ── What is NOT migrated, and why ──────────────────────────────────────────
 *
 * Only the two records that hold the user's curation cross over. Everything else
 * keyed to the old layout is RETIRED with the migration and named in the report:
 *
 *  - `source.pageOrder` — a permutation of 218 page indices is not a permutation
 *    of 183 pages. (Measured: zero projects in the library carry one.)
 *  - `editor.undoStack` / `redoStack` — a history of gestures over page numbers
 *    and block ids that no longer exist. Half a history is worse than none: an
 *    undo that restores the wrong page is a silent edit.
 *  - `manifest.chapters` — 783 of the 942 chapter markers on EPUB projects carry
 *    only a `page`, with no `blockId` to re-key through. A chapter list where a
 *    fifth of the markers moved and the rest did not is a table of contents that
 *    points at the wrong chapters. They are dropped, and the ones that matter
 *    come back: a `toc`-sourced marker is DERIVED from the book's own table of
 *    contents on the next open.
 *  - the block-keyed `editor` fields (`blockEdits`, `categoryCorrections`,
 *    `learnedCategories`, `paragraphBreaks`, `blockMerges`, `ocrBlocks`, …) —
 *    each names blocks by an id from the old layout, and a category correction
 *    landing on a different paragraph is a wrong label nobody would look for.
 *
 * Every one of those is stated in the migration's own sentence, because a record
 * that disappears without being named is indistinguishable from one that was
 * never there.
 *
 * ── PDFs are not any of this ───────────────────────────────────────────────
 *
 * mupdf's pagination of a PDF is the PDF's own pages and did not change. A PDF
 * project reads `not-an-epub` here and every function returns without touching
 * it.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  readEditorLayoutState,
  type EditorLayoutIdentity,
  type EditorLayoutReading,
} from './editor-layout';
import { describeEditorLayout, describeLayoutMigration } from '../shared/document/editor-layout';
import * as manifestService from './manifest-service';
import { peekEditorState } from './editor-state-store';
import { readBookBlockLayer } from './narration-editor-state';
import { bookDigest } from './sidecar-binding';
import {
  deriveNarrationStrikes,
  describeUnstruckDeletions,
  narrationDeletedBlockIds,
  narrationDeletedPages,
  parseNarrationElementKey,
  type NarrationElementKey,
  type NarrationLaidOutBlock,
} from '../shared/vlm/narration-deletions';

/** What became of a project's legacy records. */
export type LegacyLayoutOutcome =
  /** Not an EPUB project — the question does not apply. */
  | { kind: 'not-an-epub' }
  /** Already stamped with this build's layout; the records are current. */
  | { kind: 'current' }
  /** An EPUB with no stamp and no layout-keyed records. Nothing to carry. */
  | { kind: 'clean' }
  /** The deletions were carried over. `message` is what to tell the user. */
  | { kind: 'migrated'; message: string }
  /**
   * They could not be, and this says why. Nothing on disk was changed.
   *
   * `message` is the USER's sentence and is held to Owen's rule (2026-08-10:
   * "warnings and errors should be short. very short. like, 3 sentences"):
   * what happened, what was not changed, what to do. `detail` is the full
   * reasoning — the census of the records, the layout identities, why the
   * carry is impossible — and goes to the LOG, never a dialog.
   */
  | { kind: 'refused'; message: string; detail?: string };

/**
 * The book this project's records were made against, or null.
 *
 * The WORKING COPY, which is what the picker lays out and therefore what the
 * records describe — and which `ensureBookEpub` keeps byte-identical to the
 * archive original, the fact the whole reproduction argument rests on.
 */
async function bookOf(projectDir: string): Promise<string | null> {
  const book = await manifestService.readExportEpub(projectDir);
  if (!book) return null;
  return fs.existsSync(book.absPath) ? book.absPath : null;
}

/**
 * The same book laid out the way the records were written — mupdf's reflow at
 * 600×900×18 — with the element key every block came from.
 *
 * Through the worker for the reason every mupdf call goes that way: the WASM
 * heap stays out of the main process. See `PDFAnalyzer.layOutEpubTheLegacyWay`.
 */
async function legacyBlockLayer(bookAbsPath: string): Promise<NarrationLaidOutBlock[]> {
  // Lazily, so requiring this module does not pull in the worker proxy and,
  // through it, Electron's `app` — the same reason narration-editor-state does.
  const proxy = require('./pdf-worker-proxy') as typeof import('./pdf-worker-proxy');
  const blocks = await proxy.call('layOutEpubTheLegacyWay', [bookAbsPath]);
  if (!Array.isArray(blocks)) {
    throw new Error(
      `Laying ${path.basename(bookAbsPath)} out the way its deletions were recorded answered no `
      + 'block list, so there is nothing to resolve them against. Nothing was changed.',
    );
  }
  return blocks as NarrationLaidOutBlock[];
}

/**
 * Which of these element keys nothing in the NEW layout accounts for.
 *
 * A key survives the change of paginator as a NAME — it names an element of the
 * book's markup, and the markup did not move — but the picker draws strikes on
 * BLOCKS, so an element quire placed no block for is a strike the user would not
 * see. That is a silent partial migration, so it is refused: the book's markup
 * is the same markup both paginators read, and an element in one and not the
 * other means the two disagree about what is in the book.
 */
function elementsWithNoBlock(
  elements: readonly NarrationElementKey[],
  newBlocks: readonly NarrationLaidOutBlock[],
): NarrationElementKey[] {
  const placed = new Set<NarrationElementKey>();
  const documents = new Set<string>();
  for (const block of newBlocks) {
    if (block.element === undefined) continue;
    placed.add(block.element);
    documents.add(parseNarrationElementKey(block.element).file);
  }
  return elements.filter((key) => {
    const parsed = parseNarrationElementKey(key);
    // A whole-document key is accounted for by the document existing at all: it
    // strikes the document by name, and the cut removes it whole.
    return parsed.kind === 'doc' ? !documents.has(parsed.file) : !placed.has(key);
  });
}

/**
 * Carry this project's legacy deletions into the current layout, or say why
 * they cannot be carried.
 *
 * Idempotent and cheap on everything that does not need it: a project already
 * stamped with this build's layout, or made from a PDF, returns after one
 * manifest read. The expensive half — two layouts of the book — happens once per
 * project, ever, and only for a project that has records to carry.
 */
export async function migrateLegacyEpubEditorRecords(
  projectDir: string,
  onProgress: (message: string) => void = () => {},
): Promise<LegacyLayoutOutcome> {
  const manifest = await manifestService.readProjectManifest(projectDir);
  const bookName = path.basename(projectDir);
  // The census counts editor records, and those live in the project's sidecar
  // now (electron/editor-state-store.ts) rather than under `manifest.editor` —
  // reading the manifest alone would count a legacy project's undo stack as
  // zero and call it `clean`, which is the one answer that must not be given
  // about a project whose deletions were made in a layout this build cannot
  // produce.
  //
  // PEEKED, not read: this function must leave a project it declines to touch
  // byte-identical, and a PDF project is declined one line below.
  const editor = await peekEditorState(projectDir);
  const reading = readEditorLayoutState(
    bookName,
    manifest.source?.type ?? '',
    { source: manifest.source, editor, chapters: manifest.chapters },
  );

  if (reading.status === 'not-an-epub') return { kind: 'not-an-epub' };
  if (reading.status === 'current') return { kind: 'current' };
  if (reading.status === 'clean') return { kind: 'clean' };

  // ── Records that can NEVER apply are REMOVED, once, quietly ───────────────
  //
  // Owen, 2026-08-10: "Get rid of the deletions from the old stuff. We should
  // be left with only the bare PDFs for those projects." A foreign layout has
  // no paginator to translate through, and a project with no recorded book has
  // no file to reproduce any layout from — in both, the records are dead by
  // construction and keeping them meant announcing them on EVERY open, forever
  // (a refusal writes no stamp). They are retired in one transaction and the
  // project is stamped, so this happens once and is said once, in the banner.
  //
  // (Why an unrecorded `source/exported.epub` is not adopted as the book
  // instead: nothing proves it is the file the records describe, and positional
  // keys read out of the wrong file strike the wrong text while appearing to
  // work. So the records go, rather than being guessed at.)
  if (reading.status === 'foreign') {
    console.warn(`[legacy-epub-layout] ${bookName}: removing dead records. ${reading.refusal!}`);
    await retireAndStamp(projectDir, reading.current, null, null);
    return {
      kind: 'migrated',
      message:
        `${bookName}'s saved deletions were from a page layout this build cannot reproduce and `
        + 'were removed. Strike what you want left out again.',
    };
  }

  const bookAbsPath = await bookOf(projectDir);
  if (bookAbsPath === null) {
    console.warn(
      `[legacy-epub-layout] ${bookName}: no recorded book to reproduce the old layout from — `
      + `removing dead records. ${reading.refusal!}`);
    await retireAndStamp(projectDir, reading.current, null, null);
    return {
      kind: 'migrated',
      message:
        `${bookName}'s old page and block deletions described a book this project no longer `
        + 'records and were removed. The project is back to its source; strike again once the '
        + 'book is rebuilt.',
    };
  }

  // The values, off the SAME manifest snapshot the census was taken from — a
  // second read here would be a second snapshot of a project that may have been
  // written between the two.
  const oldPages = [...(manifest.source?.deletedPages ?? [])];
  const oldBlockIds = [...(manifest.source?.deletedBlockIds ?? [])];
  return carryDeletionsOver(
    projectDir, bookName, bookAbsPath, reading, oldPages, oldBlockIds, onProgress,
  );
}

async function carryDeletionsOver(
  projectDir: string,
  bookName: string,
  bookAbsPath: string,
  reading: EditorLayoutReading,
  oldPages: number[],
  oldBlockIds: string[],
  onProgress: (message: string) => void,
): Promise<LegacyLayoutOutcome> {

  // ── Nothing to carry ──────────────────────────────────────────────────────
  //
  // A project whose only stale records are an undo stack or a chapter list has
  // no curation to preserve. It is still retired and stamped, so it stops being
  // asked about — and the sentence still names what went.
  if (oldPages.length === 0 && oldBlockIds.length === 0) {
    await retireAndStamp(projectDir, reading.current, null, null);
    return {
      kind: 'migrated',
      message:
        `${bookName} carried no page or block deletions into the new layout — it had none. `
        + 'Its undo history, chapter markers and any block-keyed editor records were recorded '
        + 'against the old pagination and have been retired; a table of contents re-reads itself '
        + 'from the book when you open it.',
    };
  }

  // ── The old layout, and what the deletions meant in it ────────────────────
  //
  // Announced, because this is the one slow thing in opening a book and it
  // happens exactly once per project: two full paginations of it, one by mupdf
  // to read the records and one by quire to write them back. A user watching a
  // 600-page biography sit there for a minute deserves a line in the log that
  // says which book and why.
  console.log(
    `[legacy-epub-layout] ${bookName}: carrying ${oldPages.length} deleted page(s) and `
    + `${oldBlockIds.length} deleted block(s) across from ${describeEditorLayout(reading.recorded)}`
    + `. This lays the book out twice and happens once, ever, for this project.`,
  );
  // Said on screen as well as in the log, in the two halves the user waits
  // through, because the log is not where somebody watching a window looks.
  onProgress(
    `Carrying ${bookName}'s saved deletions into the new page layout — reading the old one. `
    + 'This happens once for this project.',
  );
  const oldBlocks = await legacyBlockLayer(bookAbsPath);
  const strikes = deriveNarrationStrikes(
    oldBlocks, new Set(oldBlockIds), new Set(oldPages),
  );
  const unresolved = describeUnstruckDeletions(strikes);
  if (unresolved !== null) {
    // The carry is deterministic — it will fail identically on every open — so
    // per Owen's ruling these records are dead too: removed once, said once.
    console.warn(`[legacy-epub-layout] ${bookName}: carry failed — removing dead records. ${unresolved}`);
    await retireAndStamp(projectDir, reading.current, null, null);
    return {
      kind: 'migrated',
      message:
        `${bookName}'s ${oldPages.length} deleted page(s) and ${oldBlockIds.length} deleted `
        + 'block(s) could not be carried into the new page layout and were removed. Strike what '
        + 'you want left out again.',
    };
  }

  // ── The new layout, and the same text struck in it ────────────────────────
  onProgress(
    `Carrying ${bookName}'s saved deletions into the new page layout — laying the book out again.`,
  );
  const newBlocks = await readBookBlockLayer(bookAbsPath);
  const missing = elementsWithNoBlock(strikes.elements, newBlocks);
  if (missing.length > 0) {
    // Same ruling as the unresolved case above: deterministic failure, dead
    // records, removed once. The disagreement itself still goes to the log.
    console.warn(
      `[legacy-epub-layout] ${bookName}: ${missing.length} of ${strikes.elements.length} struck `
      + `element(s) are not in this build's layout (first: ${missing[0]}) — removing dead records.`);
    await retireAndStamp(projectDir, reading.current, null, null);
    return {
      kind: 'migrated',
      message:
        `${bookName}'s old deletions named text this build's layout of the book does not have, `
        + 'and were removed. Strike what you want left out again.',
    };
  }

  const struckBlockIds = narrationDeletedBlockIds(newBlocks, strikes.elements);
  const struckPages = narrationDeletedPages(newBlocks, new Set(struckBlockIds));
  // A page shown as deleted must not ALSO have its blocks listed individually —
  // restoring the page has to be ONE gesture that puts the whole page back, not
  // one that leaves several hundred block deletions the user never made. That is
  // `narrationDeletedPages`'s own stated contract for its caller.
  const blockIdsOffDeletedPages = new Set(
    newBlocks.filter((b) => struckPages.has(b.page)).map((b) => b.id),
  );
  const newBlockIds = struckBlockIds.filter((id) => !blockIdsOffDeletedPages.has(id)).sort();
  const newPages = [...struckPages].sort((a, b) => a - b);

  const { digest: sha256 } = await bookDigest(bookAbsPath);
  await retireAndStamp(
    projectDir,
    reading.current,
    { deletedPages: newPages, deletedBlockIds: newBlockIds },
    { epubSha256: sha256, elements: [...strikes.elements] },
  );

  return {
    kind: 'migrated',
    message: describeLayoutMigration(
      bookName,
      { deletedPages: oldPages.length, deletedBlockIds: oldBlockIds.length },
      {
        deletedPages: newPages.length,
        deletedBlockIds: newBlockIds.length,
        elements: strikes.elements.length,
      },
      reading.recorded,
      reading.current,
    ) + ' The undo history, the chapter markers and any block-keyed editor records could not come '
      + 'with them and have been retired; a table of contents re-reads itself from the book when '
      + 'you open it.',
  };
}

/**
 * The one write: the new deletions, the new stamp, and the retirement of every
 * record the old layout explained.
 *
 * ONE transaction, through `modifyManifest`, for the reason
 * `clearProcessingRecords` gives: a reader (or Syncthing) must never see a
 * manifest that has taken the old records out but not put the new ones in, which
 * would be a project with a stamp saying its deletions are current and no
 * deletions in it.
 */
async function retireAndStamp(
  projectDir: string,
  layout: EditorLayoutIdentity,
  deletions: { deletedPages: number[]; deletedBlockIds: string[] } | null,
  narration: { epubSha256: string; elements: NarrationElementKey[] } | null,
): Promise<void> {
  await manifestService.applyEditorLayoutMigration(projectDir, {
    layout,
    deletions,
    narration,
  });
}

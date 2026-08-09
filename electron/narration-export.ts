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
import {
  editorStateTranslationRefusal,
  translateEditorStateDeletions,
} from './narration-editor-state';
import { moveIntoPlace } from './processing-passes';
import { sha256File } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  describeUnstruckDeletions,
  narrationDeletionsStaleReason,
  type NarrationDeletions,
  type NarrationElementKey,
  type NarrationState,
  type NarrationStrikes,
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
 * Apply ONE EDIT to the record: strike these, unstrike those.
 *
 * ── Why the picker sends a difference and not a set ─────────────────────────
 *
 * Because the set it would send is derived from its VIEW, and the view is not
 * durable. Page deletions on a book tab have no home outside the window; any
 * document reload — an app restart, a chapter rename, an artifact swap — resets
 * the editor's signals; and the restore that repopulates them races the
 * progressive block load. A snapshot save turns every one of those into a
 * legitimate-looking record with strikes missing from it, and that is exactly
 * what was measured on a real book in Aug 2026: a document whose text aligns
 * perfectly ended with ZERO strikes for pages the user had deleted, and 359 of
 * 668 footnote elements silently came back.
 *
 * A difference cannot do that. A window with a stale or empty view produces an
 * empty difference, which is no write at all. Two windows editing one project
 * compose instead of overwriting. And the read-modify-write happens HERE, in one
 * `modifyManifest` transaction, so the record on disk is the only accumulator.
 *
 * ── The staleness contract is the existing one ─────────────────────────────
 *
 * An edit against a record stamped with a DIFFERENT book is refused by name and
 * the record is cleared, exactly as `readNarrationState` and `exportNarrationEpub`
 * do — a positional record whose file moved under it cannot be merged into,
 * because the elements the edit names and the elements already on record are
 * positions in two different books.
 *
 * The sha is measured HERE for the same reason `saveNarrationDeletions` measures
 * it: the renderer's copy is as old as the last time it asked.
 */
export async function editNarrationDeletions(
  projectDir: string,
  edit: { strike: readonly NarrationElementKey[]; unstrike: readonly NarrationElementKey[] }
): Promise<NarrationDeletions> {
  // `ensureBookEpub`, not `readExportEpub`, for the reason spelled out in
  // `saveNarrationDeletions` below: a project imported AS an EPUB has no book
  // until something needs one, and the first strike is that moment.
  const book = await manifestService.ensureBookEpub(projectDir);
  const { sha256 } = await sha256File(book.absPath);
  // The read, the merge and the write are ONE locked transaction in
  // manifest-service — an accumulator read outside the lock loses whatever
  // landed between the read and the write.
  const answer = await manifestService.editNarrationDeletions(projectDir, sha256, edit);
  if (answer.staleReason !== null) throw new Error(answer.staleReason);
  return answer.deletions;
}

/**
 * Record what the user has struck out, stamped with the book on disk now.
 *
 * The sha is measured HERE rather than taken from the caller: the renderer's
 * copy of it is as old as the last time it asked, and a stamp that says
 * "the book as the picker remembered it" would pass the staleness gate on a
 * book that had moved on.
 *
 * WHOLESALE, which is why the picker no longer calls it: it replaces the record
 * with the caller's set, so a caller whose set is a view snapshot can erase
 * strikes it merely does not know about. `editNarrationDeletions` above is the
 * gesture path. This remains for callers that legitimately own the whole answer
 * — the export's own merge of a legacy editor-state translation, and tests.
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
  /**
   * The spine documents the strikes emptied, which were taken out of the copy
   * entirely rather than left as blank pages.
   *
   * NAMED, not counted: the user opens this file to check that what they deleted
   * is gone, and "2 emptied document(s) removed" is a number they cannot act on
   * while "copy.xhtml, toc.xhtml" is a sentence they can recognize.
   */
  removedDocuments: string[];
  /**
   * How the removed elements were arrived at — the two records, counted apart.
   *
   * `fromStrikes` is what was on record before this export; `translated` is what
   * the editor's own page and block deletions added to it that the record did
   * not already name. They sum to `removedElements`, and they are reported
   * rather than merged silently because "your 122 edits are in this file" and
   * "your 122 edits were already in the record" are different facts and the
   * user has spent an evening being told the first when the second was false.
   */
  fromStrikes: number;
  translated: number;
  /**
   * Why some of the editor's deletions reached nothing, or null when they all
   * did.
   *
   * ALWAYS NULL on a successful export, and it is kept in the shape because the
   * field is what a caller reads to find that out. An export whose deletions do
   * not all resolve does not return — it throws, and no file is written
   * (`refuseUnresolvedDeletions`). A warning string beside a finished audiobook
   * is a sentence nobody reads; a refusal is a thing the user can act on.
   */
  unresolved: string | null;
}

/**
 * The refusal a deletion that reached NOTHING earns, or null when they all
 * reached something.
 *
 * ── Why this is a refusal and not the warning it used to be ─────────────────
 *
 * Owen, 2026-08-09: "it should just delete the blocks we tell it to delete,
 * without fail. a guarantee; a promise. if one is deleted, it should be matched
 * to a block and removed on reflow. if it isn't, it should fail."
 *
 * It used to write the file and return the sentence. The file was then narrated,
 * because a `.tts.epub` on disk is what the TTS step reads and nothing about it
 * says it is incomplete — so the user found out by hearing 43 footnotes read
 * aloud in a finished audiobook. There is no version of "some of what you struck
 * is still in here" that is worth more than not writing the file.
 *
 * The sentence ends with what the user can DO, because both remedies are real
 * and neither is obvious: a block whose markup cannot be identified is still
 * removable by striking the whole page or the whole document (the identity of a
 * spine document is never in doubt — shared/vlm/narration-deletions.ts), and a
 * deletion the user no longer wants can simply be restored.
 */
export function refuseUnresolvedDeletions(
  strikes: NarrationStrikes,
  whence: string,
): string | null {
  const report = describeUnstruckDeletions(strikes);
  if (report === null) return null;
  return (
    `The narration copy was not written, because ${whence} could not be carried out in full.\n\n`
    + report
    + '\n\nNothing was written and your deletions are intact. Either strike the whole page or the '
    + 'whole document those blocks are in — a document is removed by name, so everything in it goes '
    + 'whether or not each piece could be identified — or restore the blocks you no longer want '
    + 'left out, and export again.'
  );
}

export interface NarrationExportOptions {
  /**
   * Remove digits-only `<sup>` footnote references as the copy is written.
   *
   * The ONE thing the copy does that the strikes do not describe — a
   * `<sup>55</sup>` left in the markup is read aloud as "fifty-five", and that
   * is not something a user can see struck through on the page. Defaults ON
   * (`writeNarrationEpub`'s own default) because every audiobook wants it; the
   * picker asks anyway, because a book of numbered chapter epigraphs is a real
   * book and the strip cannot tell one from a footnote reference.
   */
  stripSupMarkers?: boolean;
}

/** The file TTS reads, and how it came to be there. */
export interface NarrationEpubForTts {
  /** Absolute path to the narration copy. */
  epubPath: string;
  /** Project-relative, forward slashes. */
  relPath: string;
  /** How many elements it leaves out of the book. */
  removedElements: number;
  /**
   * Why it had to be cut now, or null when the one on record already described
   * the book as it is.
   *
   * Reported rather than swallowed because "your narration copy was rebuilt just
   * now" and "the one from Tuesday is still correct" are different facts about
   * the file about to be narrated, and only one of them is worth the user
   * checking the Open button over.
   */
  cutReason: string | null;
}

/**
 * The narration copy for this project, CUT IF THERE IS NOT A CURRENT ONE.
 *
 * ── Why the TTS page no longer asks which file to narrate ───────────────────
 *
 * Owen, 2026-08-08: "it isn't a pipeline anymore really. The user is just
 * defining tts and assembly instructions… by that time the system will know
 * which one." And it does: the artifact chain has one answer at every link —
 * the archive is the file you handed us, the working copy is the one file you
 * edit, and the narration copy is the cut of that working copy with what you
 * struck out removed. TTS reads the last of those. There is no choice to offer
 * because there is no second candidate; offering one only ever let a user
 * narrate the wrong file.
 *
 * ── Cutting it here is not a hidden side effect ─────────────────────────────
 *
 * The narration copy is DERIVED — `outputs.ttsEpub` is a function of the book
 * and the strikes, and `exportNarrationEpub` rewrites it from scratch every
 * time. So "there isn't one yet" and "the one there was cut from an older book"
 * are not questions to put to the user; they are work with exactly one correct
 * answer, which is to cut it. That is the same reasoning the working copy is
 * made under, and it is what "fully seamless" means: the system does the part
 * that has one answer.
 *
 * Staleness is measured as `fromEpubSha256` against the book's sha256 on disk —
 * the record's own claim about which bytes it was cut from, against the bytes
 * that are there. A Simplify or Translate pass rewrites the book, and a
 * narration copy cut before it describes a book nobody has any more.
 *
 * ── The one thing it will NOT do ────────────────────────────────────────────
 *
 * Make a working copy. A project with none has nothing to cut from, and the
 * answer is a sentence naming the act that produces one — open the book, or
 * read the pages of a PDF — rather than a file picker offering whatever EPUBs
 * happen to be lying about. That refusal is the whole of the model: there is one
 * editable file, and if it does not exist yet the thing to do is make it, not
 * pick a substitute.
 */
export async function ensureNarrationEpub(
  projectDir: string,
  options?: NarrationExportOptions
): Promise<NarrationEpubForTts> {
  const book = await manifestService.readExportEpub(projectDir);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy, so there is nothing to narrate yet. Open `
      + 'the book from Studio — an EPUB gets its working copy the moment it opens, and a PDF gets '
      + 'one from Generate EPUB, which reads its pages.'
    );
  }

  const { sha256 } = await sha256File(book.absPath);
  const record = await manifestService.readNarrationEpubRecord(projectDir);
  if (record) {
    const abs = path.join(projectDir, record.path.split('/').join(path.sep));
    if (fs.existsSync(abs) && record.fromEpubSha256 === sha256) {
      return {
        epubPath: abs,
        relPath: record.path,
        removedElements: record.removedElements,
        cutReason: null,
      };
    }
  }

  // Three states, one act, and the state is SAID because the sentence is what
  // tells the user whether to look at the file again before narrating it.
  const cutReason = record === null
    ? 'This book had no narration copy yet, so one was cut from your working copy.'
    : !fs.existsSync(path.join(projectDir, record.path.split('/').join(path.sep)))
      ? 'The narration copy this project recorded is not on disk any more, so it was cut again.'
      : 'The book has changed since the narration copy was cut, so it was cut again from the '
        + 'working copy as it is now.';

  const written = await exportNarrationEpub(projectDir, options);
  return {
    epubPath: written.epubPath,
    relPath: written.relPath,
    removedElements: written.removedElements,
    cutReason,
  };
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
export async function exportNarrationEpub(
  projectDir: string,
  options?: NarrationExportOptions
): Promise<NarrationExportResult> {
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

  // The OTHER deletion record, folded in before anything is cut. Everything
  // about why there are two, and why this one has to be translated rather than
  // read, is in electron/narration-editor-state.ts.
  const merged = await mergeEditorStateDeletions(projectDir, book.absPath, sha256, recorded);

  const target = await manifestService.narrationEpubTarget(projectDir);
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `narration-${sha256.slice(0, 16)}.epub`);

  // The footnote-marker strip is ON unless the caller says otherwise, because a
  // narration copy that keeps `<sup>55</sup>` is a copy the narrator reads
  // "fifty-five" out of. This is also the ONLY place those markers are removed —
  // no pass edits the book.
  const written = await writeNarrationEpub(
    book.absPath, staged, merged.elements,
    options?.stripSupMarkers === undefined ? undefined : { stripSupMarkers: options.stripSupMarkers });
  await moveIntoPlace(staged, target.absPath);

  await manifestService.registerNarrationEpub(projectDir, {
    path: target.relPath,
    modifiedAt: new Date().toISOString(),
    fromEpubSha256: sha256,
    removedElements: written.removedElements,
    removedSupMarkers: written.removedSupMarkers,
    removedDocuments: written.removedDocuments,
  });

  return {
    epubPath: target.absPath,
    relPath: target.relPath,
    removedElements: written.removedElements,
    totalElements: written.totalElements,
    removedSupMarkers: written.removedSupMarkers,
    removedDocuments: written.removedDocuments,
    fromStrikes: merged.fromStrikes,
    translated: merged.translated,
    unresolved: merged.unresolved,
  };
}

interface MergedNarrationDeletions {
  /** What the copy is cut by: the strikes plus whatever the editor added. */
  elements: readonly NarrationElementKey[];
  /** How many of them were already on record. */
  fromStrikes: number;
  /** How many the editor's page and block deletions added. */
  translated: number;
  /** Why some of the editor's deletions reached nothing, or null. */
  unresolved: string | null;
}

/**
 * The strikes on record, plus what the picker's editor state says was deleted.
 *
 * ── Why this is at EXPORT time and not a one-off script ─────────────────────
 *
 * Because the file is what has to be right. Every project in the library that
 * was curated before the picker recorded page deletions has intent stranded in
 * `manifest.source`, and the only moment we can be sure it matters is the moment
 * somebody asks for the book it feeds. Doing it here means the next export of
 * every one of those projects carries the user's work, with nothing to run and
 * nothing to remember.
 *
 * ── The merged set is WRITTEN BACK, and that is not optional ────────────────
 *
 * `exportNarrationEpub` deliberately takes no deletion list: the manifest is the
 * state, so the file that lands is always explained by a record. Cutting by a
 * set that only existed inside this function would break exactly that — the
 * `.tts.epub` would be missing 418 elements and the record would say 46. So the
 * merge is recorded first and the cut reads the recorded answer.
 *
 * A project whose record already names everything the editor deleted gets an
 * identical set, nothing is written, and the only cost is the book's block layer
 * — an analysis-cache hit, because the picker laid the same book out to show it.
 */
async function mergeEditorStateDeletions(
  projectDir: string,
  bookAbsPath: string,
  bookSha256: string,
  recorded: NarrationDeletions | null,
): Promise<MergedNarrationDeletions> {
  const onRecord = recorded?.elements ?? [];
  const editor = await manifestService.readEditorStateDeletions(projectDir);

  if (editor.blockIds.length === 0 && editor.pages.length === 0) {
    return { elements: onRecord, fromStrikes: onRecord.length, translated: 0, unresolved: null };
  }

  // The legacy record cannot be read as strikes against this book at all. That
  // used to be logged and the export continued, which wrote a copy explained by
  // the strike record alone while the user's page and block deletions — the only
  // record of an evening's curation, for every project made before the picker
  // recorded strikes — stayed in the file. Same rule as below: refuse.
  const refusal = editorStateTranslationRefusal(editor, projectDir);
  if (refusal !== null) {
    throw new Error(
      'The narration copy was not written, because this project\'s editor deletions cannot be '
      + `read as strikes against its book.\n\n${refusal}`
    );
  }

  const translation = await translateEditorStateDeletions(editor, bookAbsPath);
  // Every deletion resolves, or nothing is written. The check is here rather
  // than after the cut because the cut is what must not happen.
  const unresolved = refuseUnresolvedDeletions(
    translation.strikes,
    `the ${editor.pages.length} page(s) and ${editor.blockIds.length} block(s) this project's `
    + 'editor has deleted'
  );
  if (unresolved !== null) throw new Error(unresolved);

  const struck = new Set(onRecord);
  const added = translation.elements.filter((key) => !struck.has(key));
  console.log(
    `[narration-export] ${path.basename(projectDir)}: ${onRecord.length} element(s) on record, `
    + `${editor.pages.length} deleted page(s) and ${editor.blockIds.length} deleted block(s) resolve `
    + `to ${translation.elements.length} element(s) (${translation.strikes.fromBlocks} from blocks, `
    + `${translation.strikes.fromPages} from pages alone), of which ${added.length} were not already `
    + 'struck.'
  );
  if (added.length === 0) {
    return { elements: onRecord, fromStrikes: onRecord.length, translated: 0, unresolved: null };
  }

  const elements = [...struck, ...added].sort();
  await manifestService.writeNarrationDeletions(projectDir, {
    epubSha256: bookSha256,
    elements,
    updatedAt: new Date().toISOString(),
  });
  return { elements, fromStrikes: onRecord.length, translated: added.length, unresolved: null };
}

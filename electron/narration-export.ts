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

import {
  writeNarrationEpub, epubCarriesConversionStamps, foldChapterOpeningInBookFile,
  markupCategoriesForUnits, readEpubTocTargets, type MarkupUnit,
} from './epub-processor';
import { enumerateNarrationElements } from './quire-stamp';
import { readChapterTitlesOfBook } from './book-chapters';
import { parseNarrationElementKey } from '../shared/vlm/narration-deletions';
import {
  editorStateTranslationRefusal,
  translateEditorStateDeletions,
} from './narration-editor-state';
import { migrateLegacyEpubEditorRecords } from './legacy-epub-layout';
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
  /** Chapter openings written as their stored chapter names, single line. */
  overriddenChapterOpenings: number;
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

  // ── A chapter opening speaks its chapter's NAME ───────────────────────────
  //
  // Derived from the book itself at every cut — the book's own markup says
  // which element opens each chapter, the book's own table of contents says
  // what that chapter is called — so the rule holds across the whole
  // collection with no record to maintain and nothing that can drift. The
  // opener that prints "2" over a subhead is read as
  // "Chapter 2: An Opportunity to Hope", single line, because that is the name
  // stored in the book and the name a listener should hear.
  const chapterSpeech = await chapterSpeechOverrides(book.absPath);

  // The footnote-marker strip is ON unless the caller says otherwise, because a
  // narration copy that keeps `<sup>55</sup>` is a copy the narrator reads
  // "fifty-five" out of. This is also the ONLY place those markers are removed —
  // no pass edits the book.
  const written = await writeNarrationEpub(
    book.absPath, staged, merged.elements,
    {
      ...(options?.stripSupMarkers === undefined ? {} : { stripSupMarkers: options.stripSupMarkers }),
      ...(Object.keys(chapterSpeech).length > 0 ? { textOverrides: chapterSpeech } : {}),
    });
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
    overriddenChapterOpenings: written.overriddenElements,
    removedDocuments: written.removedDocuments,
    fromStrikes: merged.fromStrikes,
    translated: merged.translated,
    unresolved: merged.unresolved,
  };
}

/**
 * Which elements must speak their chapter's stored name, and that name.
 *
 * One entry per spine document that (a) the book's table of contents gives a
 * title and (b) the book's own markup marks a chapter opening in — the FIRST
 * chapter element of the document, the same one the picker's chapter list
 * shows under that title. Books that fail either condition contribute nothing:
 * an opener with no stored name keeps its printed text (its print IS its
 * name), and a titled document with no chapter element has nothing safe to
 * rewrite. Both are per-document facts, so one odd chapter never blocks the
 * rest of the book.
 */
async function chapterSpeechOverrides(bookPath: string): Promise<Record<string, string>> {
  const walked = await enumerateNarrationElements(bookPath, path.basename(bookPath));
  const units: MarkupUnit[] = [];
  for (const doc of walked) {
    for (const entry of doc.entries) {
      if (entry.unit) units.push(entry.unit);
    }
  }
  const { categoryByKey } = markupCategoriesForUnits(units, await readEpubTocTargets(bookPath));

  const titleByFile = new Map<string, string>();
  for (const chapter of (await readChapterTitlesOfBook(bookPath)).chapters) {
    const title = chapter.navTitle.replace(/\s+/g, ' ').trim();
    if (title.length > 0 && !titleByFile.has(chapter.file)) titleByFile.set(chapter.file, title);
  }

  const overrides: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const doc of walked) {
    for (const entry of doc.entries) {
      if (categoryByKey.get(entry.key) !== 'chapter') continue;
      const file = parseNarrationElementKey(entry.key).file;
      if (claimed.has(file)) continue;
      claimed.add(file);
      const title = titleByFile.get(file);
      if (title === undefined) continue;
      overrides[entry.key] = title;
    }
  }
  return overrides;
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

  // ── The layout the editor's numbers belong to ─────────────────────────────
  //
  // Since quire, a page number recorded before August 2026 belongs to a
  // pagination this build does not produce, and resolving it against a fresh
  // analysis would strike out paragraphs the user never touched. So the records
  // are carried into the current layout FIRST, once, through the layout they
  // were written in — or the export refuses, naming what could not come across.
  // Either way nothing is resolved against the wrong pagination.
  //
  // Cheap on everything that does not need it: a project already stamped with
  // this build's layout, or made from a PDF, returns after one manifest read.
  const carried = await migrateLegacyEpubEditorRecords(projectDir);
  if (carried.kind === 'refused') {
    throw new Error(
      'The narration copy was not written, because this project\'s editor deletions were recorded '
      + `against a different layout of the book and could not be carried over.\n\n${carried.message}`
    );
  }
  if (carried.kind === 'migrated') console.log(`[narration-export] ${carried.message}`);

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

// ─────────────────────────────────────────────────────────────────────────────
// The chapter-opening fold
// ─────────────────────────────────────────────────────────────────────────────

/** What a fold did, in the terms the picker says out loud. */
export interface ChapterOpeningMergeResult {
  /** The chapter's stored name, which the opening now says. */
  name: string;
  /** The zip entry the fold rewrote. */
  file: string;
  /** How many elements were folded into the opening and are gone from the book. */
  foldedCount: number;
  /** The working copy's sha256 before the fold and after it. */
  fromSha256: string;
  toSha256: string;
  /** Strikes the fold left naming nothing, so the record dropped them. */
  droppedStrikes: string[];
  /** Strikes that name the same element under a new index. */
  renumberedStrikes: number;
}

/**
 * Fold a chapter's opening IN THE WORKING COPY: the opening is rewritten to say
 * the chapter's stored name, and the elements folded into it are removed from
 * the markup.
 *
 * ── Why the book itself, and not an override at narration time ─────────────
 *
 * Because the correction is about the BOOK. A chapter that prints "2" over an
 * "An Opportunity to Hope" subhead is called "Chapter 2: An Opportunity to
 * Hope" in its own table of contents, and after this the working copy says so
 * once, in one element, to every reader of it — the viewer, the aligner, the
 * narration cut, a phone. Owen, 2026-08-09: "as long as we have a record of
 * what it was before and what it was changed to, it can be changed." The record
 * is `outputs.epub.bookEdits`, written in the same transaction that carries the
 * strikes.
 *
 * ── What is never touched ──────────────────────────────────────────────────
 *
 * The ARCHIVE. `manifest.outputs.epub` is the working copy and is the only file
 * this opens for writing — the archive original beside it is the file the user
 * handed us, and nothing in this app writes to it (memory:
 * pipeline-source-model-archive-as-source). The narration copy is not touched
 * either, and does not need to be: it is DERIVED, so the next cut re-reads the
 * folded book (`ensureNarrationEpub` re-cuts when `fromEpubSha256` no longer
 * matches).
 *
 * ── All or nothing ─────────────────────────────────────────────────────────
 *
 * Every refusal below happens before a byte is written, and the fold itself is
 * staged and verified before it is moved into place
 * (`foldChapterOpeningInBookFile`). A fold that cannot be RECORDED throws with
 * the manifest's own sentence — and that is the one case where the file has
 * already changed, which is why the sentence says what to do about it rather
 * than pretending nothing happened.
 */
export async function mergeChapterOpening(
  projectDir: string,
  openerKey: NarrationElementKey,
  foldedKeys: readonly NarrationElementKey[],
): Promise<ChapterOpeningMergeResult> {
  const book = await manifestService.readExportEpub(projectDir);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so there is no book to fold a `
      + 'chapter opening in. Open the book from Studio — an EPUB gets its working copy the moment '
      + 'it opens, and a PDF gets one from Generate EPUB, which reads its pages.'
    );
  }

  // The book as it stands, measured BEFORE the rewrite: it is what says whether
  // the strike record was describing this book a moment ago, and it is what the
  // edit log records the fold as having started from.
  const { sha256: fromSha256 } = await sha256File(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);
  if (stale !== null) {
    // NOT cleared here, unlike `readNarrationState`: clearing is a write, and a
    // fold that refuses must leave the project exactly as it found it.
    throw new Error(
      'This chapter opening was not folded, because the strikes recorded against this book cannot '
      + `be carried across the edit.\n\n${stale}`
    );
  }

  const opener = parseNarrationElementKey(openerKey);
  if (opener.kind !== 'unit') {
    throw new Error(
      `${openerKey} names ${opener.kind === 'image' ? 'a picture' : 'a whole document'}, and a `
      + 'chapter opening is a text element. Nothing was written.'
    );
  }

  // ── The name the opening will say ─────────────────────────────────────────
  //
  // The book's own table of contents, which is where a chapter's name lives and
  // the only place it lives (electron/book-chapters.ts). Not the print on the
  // page: the print is what this fold is replacing.
  const titles = await readChapterTitlesOfBook(book.absPath);
  const row = titles.chapters.find((c) => c.file === opener.file);
  if (row === undefined) {
    throw new Error(
      `${path.basename(book.absPath)}'s table of contents does not list ${opener.file}, so that `
      + 'document is not a chapter of this book and has no stored name to give its opening. '
      + 'Nothing was written.'
    );
  }
  const name = row.navTitle.replace(/\s+/g, ' ').trim();
  if (name.length === 0) {
    throw new Error(
      `This chapter has no stored name to give its opening — ${opener.file} is listed in `
      + `${path.basename(book.absPath)}'s table of contents under an empty title. Rename the `
      + 'chapter first, then fold.'
    );
  }

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `fold-${fromSha256.slice(0, 16)}.epub`);
  const folded = await foldChapterOpeningInBookFile(
    book.absPath, staged, openerKey, foldedKeys, name);
  await moveIntoPlace(staged, book.absPath);

  const { sha256: toSha256 } = await sha256File(book.absPath);
  const at = new Date().toISOString();

  const record = await manifestService.recordChapterOpeningFold(
    projectDir,
    {
      kind: 'merge-chapter-opening',
      at,
      file: folded.file,
      openerKey: folded.openerKey,
      openerTextBefore: folded.openerTextBefore,
      openerTextAfter: folded.openerTextAfter,
      folded: folded.folded.map((f) => ({ key: f.key, textBefore: f.textBefore })),
      fromSha256,
      toSha256,
    },
    folded.removedIndices,
  );

  console.log(
    `[narration-export] ${path.basename(projectDir)}: folded ${folded.folded.length} element(s) `
    + `into ${folded.openerKey}, which now reads "${name}". ${folded.file} held `
    + `${folded.unitsBefore} text element(s) and holds ${folded.unitsAfter}; `
    + `${record.droppedStrikes.length} strike(s) dropped, ${record.renumberedStrikes} renumbered.`
  );

  return {
    name,
    file: folded.file,
    foldedCount: folded.folded.length,
    fromSha256,
    toSha256,
    droppedStrikes: record.droppedStrikes,
    renumberedStrikes: record.renumberedStrikes,
  };
}

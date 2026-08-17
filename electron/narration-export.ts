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
 * ── What happens when the book moves under the record ───────────────────────
 *
 * A strike is a POSITION inside a specific file (shared/vlm/narration-deletions.ts),
 * and a rewrite that inserts or removes an element moves every position after
 * it. The record carries the book's sha256, and until 2026-08-10 a mismatch was
 * a GUILLOTINE: three functions in this file deleted the record and said so.
 * Owen killed that after it threw away an evening of strikes for a pass that had
 * moved nothing at all.
 *
 * What stands in its place:
 *
 *   - The stamp still decides, but only HOW the strikes are checked. Matching,
 *     every key was minted against these bytes and the cut proceeds. Not
 *     matching, each strike is checked against the text it remembers striking,
 *     and one that no longer matches REFUSES the cut by name and prints both
 *     texts — a copy with the wrong paragraphs missing is still the thing this
 *     module must never write.
 *   - No path here deletes a strike. `readNarrationState` reports, the cut
 *     refuses, the fold and the opening-naming pass decline to edit the book.
 *     Only the user takes a strike back.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  writeNarrationEpub, epubCarriesConversionStamps, foldChapterOpeningInBookFile,
  nameChapterOpeningsInBookFile, readEpubConversionUnits, stampElementIdsInBookFile,
  markupCategoriesForUnits, readEpubTocTargets, signNarrationElements,
  type MarkupUnit, type NamedChapterOpening, type UnnamedChapterOpening,
  type NarrationSignedUnit,
} from './epub-processor';
import { enumerateNarrationElements, narrationFingerprintsOfBook } from './quire-stamp';
import { readChapterTitlesOfBook } from './book-chapters';
import {
  parseNarrationElementKey, splitNarrationDeletions,
} from '../shared/vlm/narration-deletions';
import {
  bookKeysForCopyKeys, pairNarrationCopyToBook,
} from '../shared/vlm/narration-pairing';
import {
  editorStateTranslationRefusal,
  translateEditorStateDeletions,
} from './narration-editor-state';
import { migrateLegacyEpubEditorRecords } from './legacy-epub-layout';
import { moveIntoPlace } from './processing-passes';
import { bookDigest } from './sidecar-binding';
import { bookDigestAlgorithmChange } from '../shared/book-digest';
import * as manifestService from './manifest-service';
import {
  describeUnstruckDeletions,
  narrationDeletionsStaleReason,
  narrationFingerprintsFor,
  verifyNarrationStrikes,
  type NarrationDeletions,
  type NarrationElementKey,
  type NarrationState,
  type NarrationStrikeMismatch,
  type NarrationStrikes,
} from '../shared/vlm/narration-deletions';

export type { NarrationState };

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * Everything the picker needs to open a converted book, in one call.
 *
 * ── The record comes back WHOLE, always ─────────────────────────────────────
 *
 * This call used to CLEAR a record whose stamp did not name the book, and it is
 * the clear Owen killed on 2026-08-10: opening the picker after a
 * footnote-reference pass threw away an evening of strikes and told the user so
 * in the past tense. Nothing here writes to the record now. The user's strikes
 * are the user's.
 *
 * What replaces the clear is EVIDENCE. When the stamp does not name this book,
 * the book is walked once and every strike is checked against the text it
 * remembers striking (shared/vlm/narration-deletions.ts). The ones that no
 * longer match travel back as `mismatched`, by name and with both texts, so the
 * window can show them instead of painting them over paragraphs the user never
 * chose. The ones recorded before fingerprints existed travel back as
 * `unverifiable`, which is the honest answer about them and the only one.
 *
 * The walk costs a parse of the book, and it is paid ONLY on that path: a
 * record stamped with the book in front of it needs no evidence, because it was
 * made from these very bytes.
 *
 * `familyId` says which chain of the project this is about. Left out, a
 * project with one chain is understood; a project with several refuses rather
 * than guessing which book the caller meant.
 */
export async function readNarrationState(
  projectDir: string,
  familyId?: string,
): Promise<NarrationState> {
  const book = await manifestService.readExportEpub(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    return {
      bookPath: null, bookRelPath: null, bookSha256: null, converted: false,
      deletions: null, staleReason: null, mismatched: [], unverifiable: [],
      narrationPath: null, narrationRelPath: null,
      narrationCutFromSha256: null, narrationCopyStale: false,
    };
  }

  const { digest: sha256 } = await bookDigest(book.absPath);
  const converted = await epubCarriesConversionStamps(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const staleReason = narrationDeletionsStaleReason(recorded, sha256);

  let mismatched: NarrationStrikeMismatch[] = [];
  let unverifiable: NarrationElementKey[] = [];
  if (staleReason !== null && recorded !== null) {
    const units = await readEpubConversionUnits(book.absPath);
    const checked = verifyNarrationStrikes(units, recorded.elements, recorded.fingerprints);
    mismatched = checked.mismatched;
    unverifiable = checked.unverifiable;
  }

  const narration = await manifestService.readNarrationEpub(projectDir, familyId);

  // The copy's WHOLE record, for the one fact the location cannot state: which
  // book it was cut from. The comparison here is the durable form of the
  // `already-stale` answer each write reports (electron/book-chapters.ts) — the
  // picker's badge reads it on open, so an edit made in one session is still
  // said in the next. Digests measured under DIFFERENT algorithms (the zip →
  // exploded migration) are incomparable, not evidence of an edit, so they do
  // not raise the badge — the same ruling `narrationDeletionsStaleReason`
  // applies to strike stamps, for the same reason: "your copy is stale" must
  // not be said about a migration that changed no words.
  const copyRecord = narration === null
    ? null
    : await manifestService.readNarrationEpubRecord(projectDir, familyId);
  const cutFrom = copyRecord?.fromEpubSha256 ?? null;
  const narrationCopyStale = narration !== null && cutFrom !== null
    && cutFrom !== sha256
    && bookDigestAlgorithmChange(cutFrom, sha256) === null;

  return {
    bookPath: book.absPath,
    bookRelPath: book.relPath,
    bookSha256: sha256,
    converted,
    deletions: recorded,
    staleReason,
    mismatched,
    unverifiable,
    narrationPath: narration?.absPath ?? null,
    narrationRelPath: narration?.relPath ?? null,
    narrationCutFromSha256: cutFrom,
    narrationCopyStale,
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
 * An edit against a record stamped with a DIFFERENT book MERGES — it used to
 * clear the record and refuse, and that clear is gone (2026-08-10). What makes
 * merging safe is that every key this gesture adds is fingerprinted from the
 * book the gesture was made on, so it can prove itself at use whatever the
 * record's stamp says. See `manifestService.editNarrationDeletions`.
 *
 * The sha is measured HERE for the same reason `saveNarrationDeletions` measures
 * it: the renderer's copy is as old as the last time it asked.
 *
 * `familyId` names the chain being struck. Omitted, a project with one chain
 * needs no telling apart; a project with several must say which book the
 * strikes belong to.
 */
export async function editNarrationDeletions(
  projectDir: string,
  edit: { strike: readonly NarrationElementKey[]; unstrike: readonly NarrationElementKey[] },
  familyId?: string,
): Promise<NarrationDeletions> {
  // `ensureBookEpub`, not `readExportEpub`, for the reason spelled out in
  // `saveNarrationDeletions` below: a project imported AS an EPUB has no book
  // until something needs one, and the first strike is that moment.
  const book = await manifestService.ensureBookEpub(projectDir, familyId);
  const { digest: sha256 } = await bookDigest(book.absPath);
  const fingerprints = edit.strike.length === 0
    ? {}
    : narrationFingerprintsFor(await bookFingerprints(book.absPath, sha256), edit.strike);
  // The read, the merge and the write are ONE locked transaction in
  // manifest-service — an accumulator read outside the lock loses whatever
  // landed between the read and the write.
  const answer = await manifestService.editNarrationDeletions(
    projectDir, sha256, { ...edit, fingerprints }, familyId);
  if (answer.staleWarning !== null) {
    console.warn(
      `[narration] ${path.basename(projectDir)}: ${answer.staleWarning} The strikes made now are `
      + 'fingerprinted against the book on disk; nothing was cleared.');
  }
  return answer.deletions;
}

/**
 * Every text element of a book, fingerprinted — with the last book remembered.
 *
 * ── Why there is a cache at all ─────────────────────────────────────────────
 *
 * Because striking is a GESTURE. The picker sends one message per click, and
 * fingerprinting the keys in it means knowing what those elements say, which
 * means walking the book — a parse of every spine document, seconds on a real
 * one. Doing that per click would make striking unusable.
 *
 * ONE entry, keyed by path AND sha256. The sha is what makes it safe rather
 * than merely fast: any rewrite of the book — a pass, a chapter rename, a file
 * synced in from another machine — changes it, and the walk is redone. A cache
 * keyed on the path alone would hand a gesture the old book's text and
 * fingerprint the new strike with a paragraph that is not there.
 */
let fingerprintCache: { path: string; sha256: string;
  prints: Readonly<Record<NarrationElementKey, string>> } | null = null;

async function bookFingerprints(
  absPath: string,
  sha256: string,
): Promise<Readonly<Record<NarrationElementKey, string>>> {
  if (fingerprintCache !== null
    && fingerprintCache.path === absPath && fingerprintCache.sha256 === sha256) {
    return fingerprintCache.prints;
  }
  const prints = await narrationFingerprintsOfBook(absPath, path.basename(absPath));
  fingerprintCache = { path: absPath, sha256, prints };
  return prints;
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
 *
 * `familyId` picks the chain, the ordinary case being none — a project with
 * one chain has nothing to pick between.
 */
export async function saveNarrationDeletions(
  projectDir: string,
  elements: readonly NarrationElementKey[],
  familyId?: string,
): Promise<NarrationDeletions> {
  // `ensureBookEpub`, not `readExportEpub`: a project imported AS an EPUB has no
  // book until something needs one, and the first strike is exactly that moment.
  // The archive original is copied to `source/<Book Title>.epub` and recorded,
  // so the strikes are positions inside a file this app owns — the archive stays
  // untouched, which is what it is for. The same call is what a Simplify or
  // Translate pass makes (processing-passes `requireBookEpub`), so both routes
  // mint the same one book.
  const book = await manifestService.ensureBookEpub(projectDir, familyId);
  const { digest: sha256 } = await bookDigest(book.absPath);
  const kept = [...new Set(elements)].sort();
  // Fingerprinted like any other strike: this writer owns the whole answer, so
  // the whole answer is made self-describing rather than half of it.
  const fingerprints = kept.length === 0
    ? {}
    : narrationFingerprintsFor(await bookFingerprints(book.absPath, sha256), kept);
  const deletions: NarrationDeletions = {
    epubSha256: sha256,
    elements: kept,
    updatedAt: new Date().toISOString(),
    ...(Object.keys(fingerprints).length > 0 ? { fingerprints } : {}),
  };
  await manifestService.writeNarrationDeletions(projectDir, deletions, familyId);
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
   * Strikes this cut applied that nothing could check: recorded before
   * BookForge remembered what each strike struck, on a book whose sha256 does
   * not certify them.
   *
   * Empty on the fast path and on every record made since Aug 2026. It is
   * REPORTED rather than swallowed because it is the one class of strike this
   * cut has no evidence about — the alternative to saying so is a silent
   * "probably fine", which is what the old sha guillotine was built to avoid
   * and then over-corrected into deleting the record instead.
   */
  unverifiableStrikes: string[];
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
 *
 * `familyId` says which of the project's chains to narrate. Absent is the
 * ordinary case, meaning the project's only one; a project with several
 * refuses rather than guessing.
 */
export async function ensureNarrationEpub(
  projectDir: string,
  options?: NarrationExportOptions,
  familyId?: string,
): Promise<NarrationEpubForTts> {
  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy, so there is nothing to narrate yet. Open `
      + 'the book from Studio — an EPUB gets its working copy the moment it opens, and a PDF gets '
      + 'one from Generate EPUB, which reads its pages.'
    );
  }

  const { digest: sha256 } = await bookDigest(book.absPath);
  const record = await manifestService.readNarrationEpubRecord(projectDir, familyId);
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

  // FOUR states, one act, and the state is SAID because the sentence is what
  // tells the user whether to look at the file again before narrating it.
  //
  // The fourth is the migration boundary: a copy cut when the book was a single
  // archived file, read now that the book is a folder of its parts. The two
  // stamps disagree because they are not the same kind of value, and saying
  // "the book has changed" there would be false about a book nobody edited.
  // The copy IS re-cut — the record cannot prove the copy current and a
  // narration copy that might be a version behind is not one to narrate from —
  // but the user is told the true reason for the minutes it costs.
  const recut = record === null ? null : bookDigestAlgorithmChange(record.fromEpubSha256, sha256);
  const cutReason = record === null
    ? 'This book had no narration copy yet, so one was cut from your working copy.'
    : !fs.existsSync(path.join(projectDir, record.path.split('/').join(path.sep)))
      ? 'The narration copy this project recorded is not on disk any more, so it was cut again.'
      : recut !== null
        ? `${recut} So the narration copy was cut again from your working copy as it is now.`
        : 'The book has changed since the narration copy was cut, so it was cut again from the '
          + 'working copy as it is now.';

  // The re-cut keeps the choice the copy on record was cut under, unless this
  // caller states one. `strippedSupMarkers` is the one thing about that file no
  // other record describes, and a re-cut that quietly flipped it would make the
  // copy Process narrates differ from the copy the Export TTS copy button
  // writes — the same divergence `strikeInNarrationCopy` refuses by name when it
  // re-cuts (it reads the record too, narration-export.ts ~879). A record from
  // before the field existed leaves it undefined, which is the first-cut default
  // and stays the first-cut default: strip.
  const carried: NarrationExportOptions | undefined =
    options !== undefined ? options
      : record?.strippedSupMarkers === undefined ? undefined
        : { stripSupMarkers: record.strippedSupMarkers };

  const written = await exportNarrationEpub(projectDir, carried, familyId);
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
 *
 * `familyId` names the chain to cut from. Leave it out for a project with one
 * chain — a project with several refuses instead of picking one for you.
 */
export async function exportNarrationEpub(
  projectDir: string,
  options?: NarrationExportOptions,
  familyId?: string,
): Promise<NarrationExportResult> {
  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no book EPUB on disk, so there is nothing to cut a `
      + 'narration copy from.'
    );
  }
  const { digest: sha256, hex: bookHex } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  // ── The stamp decides HOW the strikes are checked, not WHETHER they live ──
  //
  // Matching, every key was minted against these bytes and nothing is owed.
  // Not matching, each strike is checked against the text it remembers striking
  // as the copy is planned (`planNarrationRemoval`), and a mismatch refuses the
  // cut by name. Neither branch writes to the record: it used to be cleared
  // here, and that clear is gone (2026-08-10).
  const stale = narrationDeletionsStaleReason(recorded, sha256);
  const verifyStrikes = stale === null ? undefined : (recorded?.fingerprints ?? {});
  if (stale !== null) {
    console.warn(`[narration] ${path.basename(projectDir)}: ${stale} Checking each strike instead.`);
  }

  // The OTHER deletion record, folded in before anything is cut. Everything
  // about why there are two, and why this one has to be translated rather than
  // read, is in electron/narration-editor-state.ts.
  const merged = await mergeEditorStateDeletions(projectDir, book.absPath, sha256, recorded, familyId);

  const target = await manifestService.narrationEpubTarget(projectDir, familyId);
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  // Named from the HEX, not from the recorded digest: an exploded book's digest
  // carries an algorithm tag, and slicing that would give every book in the
  // project the same staging name (shared/book-digest.ts, `bookDigestHex`).
  const staged = path.join(STAGING_DIR, `narration-${bookHex.slice(0, 16)}.epub`);

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
      ...(verifyStrikes === undefined ? {} : { verifyStrikes }),
    });
  // A viewer previewing the old copy holds its zip open, and on Windows that
  // hold makes the landing rename EPERM out past its retries. The writer closes
  // the reader (see closeViewerDocumentsFor); the window re-opens the fresh
  // file through its ordinary unknown-handle refusal. Lazy import: this module
  // also loads where BrowserWindow does not exist.
  const viewer = await import('./quire-viewer-bridge.js');
  const closed = await viewer.closeViewerDocumentsFor(target.absPath);
  if (closed > 0) {
    console.log(`[narration] closed ${closed} viewer document(s) holding ${target.relPath} so the `
      + 'new copy can land.');
  }
  await moveIntoPlace(staged, target.absPath);

  await manifestService.registerNarrationEpub(projectDir, {
    path: target.relPath,
    modifiedAt: new Date().toISOString(),
    fromEpubSha256: sha256,
    removedElements: written.removedElements,
    removedSupMarkers: written.removedSupMarkers,
    // The one choice about this file that no other record describes. Kept so a
    // re-cut made by a deletion on the copy itself reproduces it rather than
    // quietly reverting to the default — see `strikeInNarrationCopy`.
    strippedSupMarkers: options?.stripSupMarkers !== false,
    removedDocuments: written.removedDocuments,
  }, familyId);

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
    unverifiableStrikes: written.unverifiableStrikes,
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

// ─────────────────────────────────────────────────────────────────────────────
// Deleting on the TTS copy itself
// ─────────────────────────────────────────────────────────────────────────────

/** What one deletion made on the narration copy did. */
export interface NarrationCopyStrikeResult {
  /** The BOOK keys the gesture struck — what actually went on record. */
  struckInBook: NarrationElementKey[];
  /** The re-cut copy, absolute. */
  epubPath: string;
  relPath: string;
  removedElements: number;
  /** How long the re-cut took, so the UI can say whether this is an inline act. */
  recutMs: number;
}

/**
 * Every element of a book, signed the way the CUT will spell it.
 *
 * `overrides` is the chapter-speech map for the BOOK side and empty for the copy
 * — the copy already says the overridden text, because the cut that wrote it put
 * it there. Applied by mutating the in-memory tree exactly as `writeNarrationEpub`
 * does, so the signature comes out of the same rule rather than a restatement of
 * it. Nothing is written: this DOM is parsed here and thrown away.
 */
async function signBookElements(
  epubPath: string,
  struck: ReadonlySet<NarrationElementKey>,
  stripSups: boolean,
  overrides: Record<string, string>,
): Promise<NarrationSignedUnit[]> {
  const walked = await enumerateNarrationElements(epubPath, path.basename(epubPath));
  const perFile = new Map<string, Array<{ key: string; el: any }>>();
  for (const doc of walked) {
    perFile.set(doc.file, doc.entries.map((entry) => ({ key: entry.key, el: entry.el })));
    for (const entry of doc.entries) {
      const spoken = overrides[entry.key];
      if (spoken === undefined) continue;
      // The same three lines the writer runs (epub-processor.ts, `textOverrides`):
      // the override IS the whole utterance, one text node, single line.
      const text = spoken.replace(/\s+/g, ' ').trim();
      if (text.length === 0) continue;
      while (entry.el.firstChild) entry.el.removeChild(entry.el.firstChild);
      entry.el.appendChild(entry.el.ownerDocument.createTextNode(text));
    }
  }
  return [...signNarrationElements(perFile, struck, stripSups).values()].flat();
}

/**
 * Strike elements out of the book by pointing at them IN THE TTS COPY, and cut
 * the copy again so the file matches.
 *
 * ── Why the gesture cannot just edit the copy ───────────────────────────────
 *
 * Owen ratified the rule on 2026-08-09: a delete made on the TTS copy must write
 * a RECORD as well as change the file. The copy is derived — `exportNarrationEpub`
 * rewrites it from scratch from the book and the record every time — so an edit
 * that only touched the file would be undone by the very next export, silently,
 * some days later. The record is the durable thing; the file is a consequence.
 *
 * ── Why the file is re-cut rather than patched ──────────────────────────────
 *
 * Because a second, partial file-editing path would be a second answer to "what
 * is in the TTS copy", and the two would drift. `writeNarrationEpub` already
 * verifies every cut it makes against the record it made it from, and it is the
 * only thing allowed to write this file. So the strike goes on record and the
 * copy is cut again through that one verified door. `recutMs` is reported so the
 * caller can say honestly whether that felt like an inline edit.
 *
 * ── The three refusals ──────────────────────────────────────────────────────
 *
 * A gesture is refused, with nothing written, when there is no copy to point at,
 * when the copy on disk was not cut from the book that is there now, and when
 * the record does not say whether that cut removed the footnote numbers — the
 * one thing about the file no other record describes, and a re-cut that guessed
 * it would flip a choice the user made. All three name the act that fixes them.
 *
 * `familyId` says which chain's copy is being struck. Omitted, a project with
 * one chain is meant; a project with several must be told.
 */
export async function strikeInNarrationCopy(
  projectDir: string,
  copyKeys: readonly NarrationElementKey[],
  familyId?: string,
): Promise<NarrationCopyStrikeResult> {
  if (copyKeys.length === 0) {
    throw new Error(
      'A deletion on the TTS copy named no elements, so there is nothing to strike. This is a bug '
      + 'in the window that sent it, not something you did.'
    );
  }

  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)} has no working copy on disk, so a deletion made on its TTS copy `
      + 'has no book to be recorded against.'
    );
  }
  const { digest: sha256 } = await bookDigest(book.absPath);

  const record = await manifestService.readNarrationEpubRecord(projectDir, familyId);
  if (record === null) {
    throw new Error(
      'This project has no TTS copy on record, so there is nothing to have deleted from. Generate '
      + 'it from your book first.'
    );
  }
  const copyPath = path.join(projectDir, record.path.split('/').join(path.sep));
  if (!fs.existsSync(copyPath)) {
    throw new Error(
      `The TTS copy this project recorded (${record.path}) is not on disk any more. Generate it `
      + 'again from your book, then make the deletion.'
    );
  }
  if (record.fromEpubSha256 !== sha256) {
    // The refusal is the same either way — nothing here can pair a copy against
    // a book it cannot prove the copy was cut from — but the REASON is not, and
    // at the migration boundary "an earlier version of your book" would be a
    // sentence about an edit that never happened.
    const measured = bookDigestAlgorithmChange(record.fromEpubSha256, sha256);
    throw new Error(
      measured === null
        ? 'The TTS copy on disk was cut from an earlier version of your book, so a deletion made on '
          + 'it would land on a different paragraph. Generate the TTS copy again from your book, '
          + 'then make the deletion.'
        : `${measured} So this deletion cannot be paired against the TTS copy on disk. Generate the `
          + 'TTS copy again from your book — the new record is stamped the new way — then make the '
          + 'deletion.'
    );
  }
  if (record.strippedSupMarkers === undefined) {
    throw new Error(
      'This TTS copy was written before BookForge recorded whether the footnote reference numbers '
      + 'were taken out of it, so cutting it again would have to guess that choice. Generate the '
      + 'TTS copy again from your book — the new record answers it — then make the deletion.'
    );
  }

  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, sha256);
  if (stale !== null) {
    // A refusal, and NOT a clear. This gesture pairs the copy against the book
    // element for element, which needs the record to describe the book it is
    // being paired with; it does not need — and has no business — throwing the
    // record away to say so. The copy's own `fromEpubSha256` gate above has
    // already established that the copy matches the book, so the only way here
    // is a record older than both.
    throw new Error(
      'This deletion was not recorded, because the strikes on file were made against a different '
      + `version of your book. ${stale} Nothing has been cleared — open the book in the editor, `
      + 'where every strike is shown and the ones that no longer match are named, and make the '
      + 'deletion there.'
    );
  }
  const onRecord = recorded?.elements ?? [];
  const split = splitNarrationDeletions(onRecord);

  // BOTH sides signed with the strip applied, whatever the cut chose — on the
  // book it removes the markers, on the copy it finds none to remove, and the
  // two meet either way (shared/vlm/narration-pairing.ts).
  const struck = new Set(split.elements);
  const signedBook = await signBookElements(
    book.absPath, struck, true, await chapterSpeechOverrides(book.absPath));
  const signedCopy = await signBookElements(copyPath, new Set(), true, {});

  const pairing = pairNarrationCopyToBook({
    book: signedBook,
    copy: signedCopy,
    struckDocuments: split.documents,
  });
  const translated = bookKeysForCopyKeys(pairing, copyKeys);
  if (!translated.ok) throw new Error(translated.reason);

  await editNarrationDeletions(projectDir, { strike: translated.keys, unstrike: [] }, familyId);

  const startedAt = Date.now();
  const written = await exportNarrationEpub(projectDir, {
    stripSupMarkers: record.strippedSupMarkers,
  }, familyId);
  const recutMs = Date.now() - startedAt;

  return {
    struckInBook: translated.keys,
    epubPath: written.epubPath,
    relPath: written.relPath,
    removedElements: written.removedElements,
    recutMs,
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
 *
 * `familyId` is threaded straight from `exportNarrationEpub`'s caller — this
 * helper does not resolve the chain itself, it writes back to the one already
 * chosen.
 */
async function mergeEditorStateDeletions(
  projectDir: string,
  bookAbsPath: string,
  bookSha256: string,
  recorded: NarrationDeletions | null,
  familyId?: string,
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

  // Through the ordinary edit door, not a wholesale write. Two reasons, both
  // learned the hard way: the door fingerprints what it strikes (a wholesale
  // write here dropped every print the record already held), and it advances
  // the stamp only when the stamp was already right — a translation of legacy
  // page deletions is not evidence that the strikes made against some other
  // version of this book describe this one.
  const fingerprints = narrationFingerprintsFor(
    await bookFingerprints(bookAbsPath, bookSha256), added);
  const answer = await manifestService.editNarrationDeletions(
    projectDir, bookSha256, { strike: added, unstrike: [], fingerprints }, familyId);
  return {
    elements: answer.deletions.elements,
    fromStrikes: onRecord.length,
    translated: added.length,
    unresolved: null,
  };
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
 *
 * `familyId` names which chain's book is being folded. Left out, a project
 * with a single chain is meant; a project with several refuses rather than
 * guessing which one.
 */
export async function mergeChapterOpening(
  projectDir: string,
  openerKey: NarrationElementKey,
  foldedKeys: readonly NarrationElementKey[],
  familyId?: string,
): Promise<ChapterOpeningMergeResult> {
  const book = await manifestService.bookForAct(projectDir, familyId);
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
  const { digest: fromSha256, hex: fromHex } = await bookDigest(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
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
  const staged = path.join(STAGING_DIR, `fold-${fromHex.slice(0, 16)}.epub`);
  const folded = await foldChapterOpeningInBookFile(
    book.absPath, staged, openerKey, foldedKeys, name);
  await moveIntoPlace(staged, book.absPath);

  const { digest: toSha256 } = await bookDigest(book.absPath);
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
    familyId,
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

// ─────────────────────────────────────────────────────────────────────────────
// Naming the chapter openings — the normalization a book gets at open
// ─────────────────────────────────────────────────────────────────────────────

/** What the naming pass did to a project's book. */
export interface ChapterOpeningNamingSummary {
  /** How many openings were rewritten. Zero means the book was already right. */
  edited: number;
  /** Each one, with what it printed before — the same list the manifest keeps. */
  named: NamedChapterOpening[];
  /** Chapters left alone, and why. Never a failure; see below. */
  skipped: UnnamedChapterOpening[];
}

/** What the element-id stamp did to a project's working copy. */
export interface ElementIdStampSummary {
  /** How many elements were given an id they did not have. Zero is the norm. */
  stamped: number;
  /** How many elements the book's walk produces in total. */
  total: number;
  /** How many synthesized wrappers became real markup. First stamp only. */
  wrappersPersisted: number;
}

/**
 * Give every element of the project's working copy a stable id, in the book.
 *
 * ── Where this sits ────────────────────────────────────────────────────────
 *
 * Immediately BEFORE `nameChapterOpenings`, at every door that opens or re-mints
 * a working copy. An element's identity has to exist before anything writes to
 * the element, and the naming pass is the first thing that does.
 *
 * IDEMPOTENT, and that is the contract that makes running it on every open safe:
 * the second open finds every element already carrying its id, writes no byte,
 * and touches neither the book nor the manifest by so much as a timestamp. A
 * book whose bytes changed on every open would void the narration copy, the
 * analysis cache and the strike record for nothing.
 *
 * ── What is never touched ──────────────────────────────────────────────────
 *
 * The ARCHIVE. `outputs.epub` is the working copy and is the only file opened
 * for writing (memory: pipeline-source-model-archive-as-source). A project with
 * no working copy at all is normal — a PDF before Generate EPUB — and returns
 * "nothing stamped" rather than an error.
 *
 * ── Why the strike record is re-stamped and not migrated ───────────────────
 *
 * Because NO element moves: the stamp writes an attribute onto elements that
 * were already there, and the synthesized wrappers it makes real were already in
 * the walk every reader performs. `stampElementIdsInBookFile` measures that
 * against the written file. A record stamped with some OTHER book cannot be
 * followed, so this REFUSES rather than forging agreement — and the refusal is
 * only reachable when there is something to stamp, which keeps a void record
 * from making an already-stamped project unopenable.
 *
 * The user is told NOTHING. Identity is plumbing; the console says what
 * happened and the screen says nothing at all.
 */
export async function stampElementIds(
  projectDir: string,
  familyId?: string,
): Promise<ElementIdStampSummary> {
  const nothing: ElementIdStampSummary = { stamped: 0, total: 0, wrappersPersisted: 0 };

  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) return nothing;

  const { digest: fromSha256, hex: fromHex } = await bookDigest(book.absPath);

  // Read now, judged after the pass has said whether it has anything to do — an
  // already-stamped book must open even when its strikes are void.
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `stamp-uids-${fromHex.slice(0, 16)}.epub`);
  const result = await stampElementIdsInBookFile(book.absPath, staged);

  if (result.files.length === 0) {
    // Every element already carries its id. Idempotence is the contract, so the
    // working copy is not replaced by bytes that would differ only in their zip
    // timestamps — and no staged copy was written to have to move. The `rm` is
    // for the case where it was and something below refused.
    await fs.promises.rm(staged, { force: true });
    return { stamped: 0, total: result.total, wrappersPersisted: 0 };
  }

  if (stale !== null) {
    await fs.promises.rm(staged, { force: true });
    throw new Error(
      `${result.stamped} element(s) of ${path.basename(book.absPath)} still have no stable id, and `
      + 'they were NOT given one, because the narration strikes recorded against this book cannot '
      + `be carried onto the edit.\n\n${stale}`
    );
  }

  await moveIntoPlace(staged, book.absPath);
  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  await manifestService.recordElementIdStamping(projectDir, {
    kind: 'stamp-element-ids',
    at,
    stamped: result.stamped,
    total: result.total,
    files: result.files,
    wrappersPersisted: result.wrappersPersisted,
    fromSha256,
    toSha256,
  }, familyId);

  console.log(
    `[narration-export] ${path.basename(projectDir)}: gave ${result.stamped} of ${result.total} `
    + `element(s) in ${path.basename(book.absPath)} a stable id across ${result.files.length} `
    + `document(s)`
    + (result.wrappersPersisted === 0
      ? '.'
      : `, and made ${result.wrappersPersisted} synthesized text wrapper(s) real markup.`)
  );

  return {
    stamped: result.stamped,
    total: result.total,
    wrappersPersisted: result.wrappersPersisted,
  };
}

/**
 * Name every chapter opening of the project's working copy, in the book.
 *
 * ── The contract ──────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-09: "from the moment the book opens, the chapter openers
 * contain the chapter's text. period. the user will delete surrounding blocks
 * if they're unnecessary." So this runs on the project's OPEN
 * (`projects:load-from-path`) and again after a chapter RENAME, and it is
 * IDEMPOTENT — the second open finds every opening already reading its name,
 * makes no edit, and does not touch the book or the manifest by so much as a
 * timestamp. That is not an optimization; it is what makes running it on every
 * open safe, because a book whose bytes changed on every open would invalidate
 * the narration copy, the analysis cache and the strike record for nothing.
 *
 * ── What is never touched ─────────────────────────────────────────────────
 *
 * The ARCHIVE. `manifest.outputs.epub` is the working copy and is the only
 * file opened for writing (memory: pipeline-source-model-archive-as-source).
 * A project with no working copy at all is normal — a PDF before Generate
 * EPUB — and returns "nothing edited" rather than an error.
 *
 * ── Why the strike record is re-stamped and not migrated ──────────────────
 *
 * Because NO element is removed: every edit is text inside one element, so
 * every text-unit index and every image ordinal is exactly where it was and
 * each strike still names the element it named. The record follows the book's
 * new bytes; its keys are not touched. A record stamped with some OTHER book
 * cannot be followed — its positions are in a file nobody has — so this
 * REFUSES, before the book is written, rather than forging agreement. The
 * refusal is only reachable when there is something to name: a book already
 * normalized is a no-op no matter what the record says, which is what keeps a
 * void record from making a project unopenable.
 *
 * `familyId` picks the chain to normalize. Absent, a project with one chain
 * is meant; a project with several refuses rather than guessing which book
 * just opened.
 */
export async function nameChapterOpenings(
  projectDir: string,
  familyId?: string,
): Promise<ChapterOpeningNamingSummary> {
  const nothing: ChapterOpeningNamingSummary = { edited: 0, named: [], skipped: [] };

  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) return nothing;

  // The book as it stands, measured BEFORE anything is written: it is what says
  // whether the strike record was describing this book a moment ago, and what
  // the edit log records this pass as having started from.
  // The HEX is not taken any more: it named the staging file this pass used to
  // write, and the pass now edits the book in place.
  const { digest: fromSha256 } = await bookDigest(book.absPath);

  // ── The names ─────────────────────────────────────────────────────────────
  //
  // The book's own table of contents, which is where a chapter's name lives and
  // the only place it lives (electron/book-chapters.ts). A chapter listed under
  // an empty title contributes nothing — an opening with no stored name keeps
  // what it prints, because its print IS its name.
  const namesByFile = new Map<string, string>();
  for (const chapter of (await readChapterTitlesOfBook(book.absPath)).chapters) {
    const name = chapter.navTitle.replace(/\s+/g, ' ').trim();
    if (name.length === 0) continue;
    if (!namesByFile.has(chapter.file)) namesByFile.set(chapter.file, name);
  }
  if (namesByFile.size === 0) return nothing;

  // Read now, judged after the pass has said whether it has anything to do. A
  // book that is already named must open even when its strikes are void.
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const stale = narrationDeletionsStaleReason(recorded, fromSha256);

  // ── Written INTO the book, not staged and landed on it ────────────────────
  //
  // This ran behind every relabel that promotes a block to `chapter`, and it
  // used to write the whole named book into `%TEMP%\bookforge-staging` and land
  // it with `moveIntoPlace`. Against an exploded working copy that re-creates
  // every entry — on the migrated Nuremberg project, 84 entries and 32.5 MB of
  // page images copied twice to rewrite one heading — and leaves all of them
  // with a new inode and mtime, so the `bookDigest` below then re-hashed the
  // whole 32.5 MB as well. Measured 2026-08-11: ~1.3 s of that click.
  //
  // The ORDERING that staging bought is kept exactly, through `beforeWriting`:
  // the staleness judgement below is made in the one window where this pass
  // knows what it would write and has not written it. That is why it cannot
  // simply move above the call — a book with NOTHING to name must still open
  // when its strikes are void, and this runs at every project open.
  const named = await nameChapterOpeningsInBookFile(
    book.absPath, book.absPath, namesByFile,
    (edits) => {
      if (stale === null) return;
      throw new Error(
        `${edits.length} chapter opening(s) in ${path.basename(book.absPath)} still print `
        + 'something other than their stored name, and they were NOT rewritten, because the '
        + `narration strikes recorded against this book cannot be carried onto the edit.\n\n${stale}`
      );
    });

  if (named.edits.length === 0) {
    // The book already says what it says. Idempotence is the contract, so the
    // working copy is not rewritten by bytes that would differ only in their
    // zip timestamps — and nothing was written to have to take back.
    return { edited: 0, named: [], skipped: named.skipped };
  }

  const { digest: toSha256 } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  await manifestService.recordChapterOpeningNaming(projectDir, {
    kind: 'name-chapter-openers',
    at,
    named: named.edits.map((e) => ({
      file: e.file, openerKey: e.openerKey, textBefore: e.textBefore, textAfter: e.textAfter,
    })),
    fromSha256,
    toSha256,
  }, familyId);

  const blocked = named.skipped.filter((s) => s.kind === 'holds-image');
  console.log(
    `[narration-export] ${path.basename(projectDir)}: named ${named.edits.length} chapter `
    + `opening(s) in ${path.basename(book.absPath)} — `
    + named.edits.map((e) => `${e.openerKey} "${e.textBefore}" → "${e.textAfter}"`).join('; ')
    + (blocked.length === 0
      ? '.'
      : `. ${blocked.length} opening(s) hold a picture and were left alone: `
        + `${blocked.map((s) => s.file).join(', ')}.`)
  );

  return { edited: named.edits.length, named: named.edits, skipped: named.skipped };
}

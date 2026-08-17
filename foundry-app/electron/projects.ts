/**
 * projects — one folder per book, in four layers.
 *
 * A conversion used to write `<libraryDir>/workspace/<slug>-<key>.epub`, the
 * readings bank lived a continent away in `<userData>/readings/<key>.jsonl`, and
 * nothing on disk tied a translation to the book it came from. You could not ask
 * "what has been made from this PDF?" because the answer was spread across two
 * directories and encoded only in a filename prefix.
 *
 * A PROJECT is the answer, and it is one directory:
 *
 *   <libraryDir>/projects/<slug>-<contentkey>/
 *     project.json            the catalogue — see ProjectManifest
 *     archive/                the imported originals. NEVER written.
 *     generated/              the model's cast EPUB, or the imported EPUB, or
 *                             the book reprinted as a real-text PDF. NEVER
 *                             written.
 *     working/                what the user edits: the unpacked EPUB tree, and
 *                             the live PDF.
 *     final/                  what Save and Export produce, named for the book.
 *     readings/<key>.jsonl    the bank of the model's per-page answers
 *     history/<tree>.json     the undo ledger of the working copy of that name,
 *                             bound to the generation that made it
 *
 * ── The rule the layout exists for ───────────────────────────────────────────
 *
 * EVERY DOCUMENT HAS TWO LAYERS: an origin that is never written, and a live
 * copy that is what the user means by "the PDF" or "the EPUB". Saving writes the
 * live copy. The origin is what makes stepping back, or starting over, possible
 * at all — and for a scanned book the imported file may be the only copy of that
 * scan that will ever exist.
 *
 * `generated/` is the second origin and it is sacrosanct on its own argument: it
 * is the single record of what the model ACTUALLY READ, every curation decision
 * downstream is measured against it, and "start over" means throwing the working
 * tree away and unpacking it again from there.
 *
 * ── And the user never sees any of this ──────────────────────────────────────
 *
 * ONE DOCUMENT PER KIND. `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf`
 * and the matching `.epub`, as one unit. No `.generated`, no `.archive`, no
 * suffixes, no layer names anywhere a person can read them: every file in a
 * project is named from `manifest.stem`, which is the imported document's own
 * name with its extension taken off. The SLUG is for the directory and nothing
 * else, and `final/` is named for the book like everything else.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * `<slug>-<8 hex of the import's sha256>`, unchanged from the flat workspace it
 * replaces, and the reason it is unchanged is worth the paragraph:
 *
 *   - the hash is of the document's CONTENT, not of its path, so the same book
 *     lands in the same project no matter where the user dragged it from — a
 *     second run REPLACES the first rather than accumulating `book (1).epub`;
 *   - the READINGS bank keeps that key, so an interrupted run of a book that has
 *     since been moved or renamed still resumes. That bank is GPU-hours; a key
 *     a rename could break would silently cost them;
 *   - and the flat files this migrates FROM already carry it, which is what
 *     makes adoption a regrouping rather than a re-hash of everything on disk.
 *
 * ── Nothing is deleted ───────────────────────────────────────────────────────
 *
 * Re-running a conversion does not clobber the origin it replaces — it rotates
 * it into `generated/archived-<timestamp>/` (`rotateGenerated`), and the working
 * tree unpacked from it goes into the same folder so the next open unpacks the
 * NEW book rather than reopening the old one's edits.
 *
 * A GENERATED BOOK IS ARCHIVED AND A READINGS BANK IS NOT, and the difference is
 * deliberate rather than an inconsistency (docs/BANK-LIFECYCLE.md §5). A
 * generated EPUB can carry a working tree with a person's text edits in it, and
 * labour is kept forever. A bank is a machine's answers: the engine writes the
 * replacement beside the old one and renames it into place only when the run has
 * succeeded, so nothing is destroyed until its successor exists and `readings/`
 * grows no `archived-<stamp>/` hoards.
 *
 * ── Except when the user says so ─────────────────────────────────────────────
 *
 * `deleteProject` is the single exception and the rule survives it intact, because
 * the rule was never "these bytes are sacred" — it is that THIS APP does not get
 * to decide a person's work is finished with. Every rotation above is Foundry
 * choosing, on its own, what to do with something it was not asked about; a
 * delete from Home is the user choosing, about their own folder, having been told
 * in words what is in it. Archiving instead would leave a directory they would
 * then have to go and delete by hand, which is not a kindness, it is a lie about
 * what the button did.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsconst, createReadStream, promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { readAppSettings } from './app-settings';
// An imported EPUB is stamped on the way in, by the engine — see `stampImported`.
import { stampEpub } from './engine';
import { openedAtFor } from './recents';
import type {
  ConversionKind,
  ImportLanding,
  LedgerParams,
  LedgerStep,
  MetadataPatch,
  ProjectDocument,
  ProjectDocumentKind,
  ProjectFacsimile,
  ProjectFinal,
  ProjectGenerated,
  ProjectGeneratedRole,
  ProjectLedger,
  ProjectManifest,
  ProjectReading,
  ProjectSummary,
  ProjectStep,
  ProjectTypeRecord,
  ProjectWorkingFile,
  RewriteMode,
  StepCasualty,
  StepDeletion,
  StepRow,
} from '../shared/types';
import { WHY_HANDMADE, WHY_IMPORTED, WHY_MODEL_PASS } from '../shared/types';
import { spokenStem } from '../shared/documents';
import { readJson } from '../shared/json';
import { STEP_LABELS, migrateToSteps, readTypeRecords } from '../shared/steps';
import {
  A_BOOK_OF_ITS_OWN,
  askedOf,
  chainsWithout,
  chronological,
  deleteCost,
  deleteSubtree,
  destroyedBy,
  emptyLedger,
  facsimileFile,
  generationForLanding,
  id8,
  mergedMetadata,
  metadataInEffect,
  migrateLedger,
  orphanedBanks,
  originOf,
  originStep,
  parseLedger,
  pendingBeside,
  positionOf,
  positionView,
  reRunTarget,
  readingInEffect,
  recordLanding,
  stepOf,
  subtree,
  translatedInto,
  translationBankOf,
  translationInEffect,
  translationFileFor,
  translationRecordsOf,
  translationTarget,
  type LandedRun,
  type Landing,
  type ReadAsk,
} from '../shared/ledger';
import { GENERATED_ROLE_FOR } from '../shared/documents';
// The records `parts` grammar is the overlay's target grammar — one spelling,
// three readers — so the validator is the same function the curation uses.
// One spelling for a path, so Windows' three become one — and the same one the
// renderer compares with, which is the point of it living in `shared`.
import { fold } from '../shared/original';
import { writeAtomically } from './atomic';

/**
 * Somebody has to be told when the library changes, and this is how.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * The renderer's project list had exactly three reasons to re-read: it was
 * constructed, Home came on screen, or a queue job landed. A BACKGROUND IMPORT
 * IS NONE OF THOSE. So a user who dropped a scan on the window got a tab
 * immediately, a project on the disk a few seconds later, and a library screen
 * that went on insisting the book was not there until something unrelated
 * happened to refresh it. Everything downstream that asks "which project is this
 * document in?" — the Generate dialog, the dock's waiting light, the nav's
 * grouping — was reading that same empty list.
 *
 * ONE LISTENER, SET BY MAIN, exactly as `onQueueChanged` is. This module knows
 * when a project changed and knows nothing about windows; main knows about
 * windows and would otherwise have to guess at the moments. A no-op default
 * means the tests and any other importer of this file are unaffected.
 */
let notifyProjects: () => void = () => { /* set by main */ };

export function onProjectsChanged(listener: () => void): void {
  notifyProjects = listener;
}

/**
 * The library changed — said after the change has LANDED, never before.
 *
 * Every caller announces once its own write is on the disk, so a listener that
 * re-reads the directory the moment it hears this cannot see the state the
 * change was made from. It is deliberately not called from `writeManifest`,
 * which would be the one place impossible to forget and also the one that fires
 * three times for a single conversion recording its output.
 */
function announceProjects(): void {
  notifyProjects();
}

/** Refusals from this module, named so a caller can tell them from an fs error. */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** The manifest schema this app writes and the only one it reads. */
/**
 * 2 — `generated` became `documents`, a list of file types with step chains.
 *
 * A v1 reader handed a v2 file would find no `generated` array and conclude
 * nothing had ever been made from the book, which is why this moved. `readDocuments`
 * migrates v1 in memory on every read, so an old project opens without ceremony
 * and reaches disk in the new shape the next time anything edits it.
 */
const MANIFEST_VERSION = 2;

const MANIFEST = 'project.json';

/** The four layers, spelled once. */
const ARCHIVE = 'archive';
const GENERATED = 'generated';
const WORKING = 'working';
const FINAL = 'final';
/**
 * The fifth: frozen curations — the snapshots old `curate` steps retain.
 *
 * NOTHING WRITES ONE AND THE FOLDER IS NEVER SWEPT. A curation is a person's
 * judgement about four hundred blocks, it is `irreplaceable` by the retention
 * rule, and `shared/curate-bridge.ts` is the reader that turns one into ops when
 * the book is opened. See `curationsDir`.
 *
 * TWO SIBLINGS WENT WITH THE OVERLAY SYSTEM (docs/RENDERER.md §7): `overlays/`,
 * the live curation and its undo ledger, and `history/`, the block editor's
 * per-working-copy undo. Neither is read or written any more; a project that has
 * them keeps them, because deleting somebody's records to tidy a folder is not a
 * thing this app does.
 */
const CURATIONS = 'curations';
/**
 * The sixth: the metadata patches, one per Apply. See `metadataDir`.
 */
const METADATA = 'metadata';
/**
 * The seventh: the book's ops, one file per Apply. See `opsDir`.
 */
const OPS = 'ops';
/**
 * And the bank of the model's answers — hours of GPU, the thing every rendering
 * is made from, and the product of the one job in this app that costs anything.
 */
const READINGS = 'readings';

/**
 * `<libraryDir>/projects` — under the user's library, not under userData.
 *
 * A finished book is the user's property. userData is where an app keeps its own
 * bookkeeping and is not a folder anybody backs up on purpose; the library is
 * `~/Documents/Foundry` by default and is exactly the kind of folder a person
 * syncs. The readings bank moved in here WITH the book for the same reason it
 * once stayed out: it is only bookkeeping in the abstract — in practice it is
 * hours of GPU that belong to the book it was read from.
 *
 * Read on EVERY call rather than cached: the setting is editable while the app
 * is running, and a cached answer would keep writing into the folder the user
 * just moved away from.
 */
export function projectsDir(): string {
  return path.join(readAppSettings().libraryDir, 'projects');
}

/**
 * The project directory a path lives in, or null when it lives outside them all.
 *
 * ONE segment deep, deliberately: `…/projects/<key>/generated/book.epub` and
 * `…/projects/<key>/working/<tree>/EPUB/c0003.xhtml` both answer `<key>`,
 * because everything under a project belongs to it however deep it sits.
 */
export function projectDirOf(filePath: string): string | null {
  const root = projectsDir();
  const inside = path.relative(root, path.resolve(filePath));
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const first = inside.split(path.sep)[0];
  if (first === undefined || first.length === 0) return null;
  return path.join(root, first);
}

/**
 * True while `filePath` lives inside a project — inside anything this app owns.
 *
 * The one test both main (the recents flag, the unsaved dot, whether Save may
 * write straight through) and the epub reader apply, so it lives beside the
 * directory it measures against. It answers TRUE for `archive/` and `generated/`
 * too, and that is the point: those layers are never written, so Save must go
 * through the dialog rather than silently rewriting one of them.
 */
export function isManaged(filePath: string): boolean {
  return projectDirOf(filePath) !== null;
}

/**
 * True while `filePath` is the UNTOUCHED ORIGINAL — the copy in a project's
 * `archive/`, which nothing in this app may write.
 *
 * ── Why this became a question worth asking out loud ────────────────────────
 *
 * `archive/` has always been write-only-once by convention: it is copied at import
 * and then never named by anything that writes. The convention held because
 * nothing ever put that path in front of a writer — every surface was handed the
 * live copy. `documentAtPosition` changed that: standing on the origin row now
 * shows the archived scan, so the metadata dialog's `tab.path` can BE the untouched
 * original, and `isManaged` says true of it (deliberately — see above), so the one
 * guard that stood between a write and a project layer would have let it through.
 *
 * The invariant is worth more than the convenience: `archive/` is the only copy of
 * that scan this program knows of, and the revert row's whole meaning is that it
 * is the file as it came in.
 */
export function isArchived(filePath: string): boolean {
  const dir = projectDirOf(filePath);
  if (dir === null) return false;
  // The whole first segment, compared as a segment — never a `startsWith` on the
  // string, which would claim `archived-2026/` and any other folder that happens
  // to begin with the word.
  return path.relative(dir, path.resolve(filePath)).split(path.sep)[0] === ARCHIVE;
}

/**
 * A DIRECTORY name a filesystem, a URL and a person can all live with.
 *
 * The real test document is `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf`
 * — spaces, a comma, parentheses and two dots. Everything outside
 * `[A-Za-z0-9._-]` becomes a hyphen, runs collapse, and the result is capped at
 * 64 characters because Windows' 260-character path limit is measured against a
 * project path that already carries `working/<tree>/EPUB/<chapter>.xhtml`.
 *
 * FOR THE DIRECTORY ONLY. The files inside a project keep the document's real
 * name (`manifest.stem`) — a person opening the folder should find their book,
 * not a slug.
 */
export function slugify(name: string): string {
  const slug = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const capped = slug.slice(0, 64);
  // A name made entirely of punctuation would slug to nothing, and a folder
  // called `-a1b2c3d4` is a folder nobody can identify. The hash still follows.
  return capped.length > 0 ? capped : 'document';
}

/**
 * The document's own name, without its extension, fit to be a filename again.
 *
 * This is what every file in the project is called, so it is the one string that
 * reaches a person. Only the characters Windows refuses outright are removed —
 * a colon is common in a book's name and would fail on write — and everything
 * else, including the spaces, commas and parentheses that make a real title
 * readable, is kept exactly as the user's own file spelled it.
 */
export function stemOf(fileName: string): string {
  return sanitiseStem(fileName.replace(/\.[^.]*$/, ''));
}

/**
 * The same cleaning, for a string that is ALREADY extensionless.
 *
 * Split out because `stemOf` would maul one. A slug carries dots — `slugify`
 * keeps them — so `Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993` run through
 * an extension stripper comes out as `…-Kershaw-Ian`, which is a book named
 * after two thirds of itself. Adoption takes this route; an imported file takes
 * the other.
 *
 * Capped at 80 because the name reaches a path: `<library>/projects/<key up to
 * 73>/generated/<stem> (pt-BR).epub` has to stay inside Windows' 260.
 */
function sanitiseStem(text: string): string {
  const stem = text
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    // A trailing dot or space is legal in the string and illegal in a Windows
    // filename, and the failure arrives from the OS rather than from us.
    .replace(/[. ]+$/, '');
  return stem.length > 0 ? stem : 'document';
}

/**
 * The first 8 hex characters of the file's sha256.
 *
 * STREAMED, so a 400 MB scan costs one sequential pass and no resident memory.
 * Eight characters is 4 bytes of collision space — plenty against the tens of
 * books one person converts, and short enough that the folder still reads as the
 * book's name with a suffix rather than as a hash.
 */
export function contentKey(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err: Error) => reject(
      new Error(`${filePath} could not be read to key its project: ${err.message}`),
    ));
    stream.on('end', () => resolve(hash.digest('hex').slice(0, 8)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read `project.json`, or say by name why it could not be read.
 *
 * NEVER falls back to an empty manifest. A project whose catalogue does not
 * parse has a member order this app cannot know, and packing a book from a
 * guessed order is how `mimetype` ends up in the middle of an archive that some
 * readers open and others silently reject (ARCHITECTURE §8).
 */
export async function readManifest(dir: string): Promise<ProjectManifest> {
  const file = path.join(dir, MANIFEST);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new ProjectError(`${file} could not be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = readJson(text);
  } catch (err) {
    throw new ProjectError(`${file} is not JSON (${(err as Error).message}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProjectError(`${file} is not an object, so it is not a project catalogue.`);
  }
  const row = parsed as Record<string, unknown>;
  /*
   * VERSION 1 IS ADMITTED, NOT JUST VERSION 2. The migration lives two screens
   * down (`readDocuments` builds type records from a v1 file's flat lists), and
   * this gate once refused v1 before that code could run — which locked the
   * user's own library behind "catalogue unreadable" while the function built
   * to open it sat unreachable below. The gate's job is to refuse shapes this
   * app does NOT know, and it knows exactly two.
   */
  if (row['version'] !== MANIFEST_VERSION && row['version'] !== 1) {
    throw new ProjectError(
      `${file} is version ${String(row['version'])} and this app reads versions 1 and ${MANIFEST_VERSION}. `
      + 'Refusing to read a catalogue whose shape it does not know.',
    );
  }
  const key = row['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new ProjectError(`${file} names no key, so nothing says which book this folder is.`);
  }
  const working = typeof row['working'] === 'object' && row['working'] !== null
    ? row['working'] as Record<string, unknown>
    : {};
  const stem = typeof row['stem'] === 'string' && row['stem'].length > 0 ? row['stem'] : key;
  const title = typeof row['title'] === 'string' && row['title'].length > 0 ? row['title'] : stem;
  const manifest: ProjectManifest = {
    version: MANIFEST_VERSION,
    key,
    /*
     * A title that still IS the stem is a title nothing ever chose — imports
     * write the stem as a placeholder and `noteProjectTitle` replaces it the
     * first time a real one is seen. Only the placeholder is said aloud
     * (`spokenStem`); a chosen title, even a strange one, is repeated exactly.
     */
    title: title === stem ? spokenStem(stem) : title,
    stem,
    createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : 0,
    archive: readArchive(row['archive']),
    documents: readDocuments(row, readArchive(row['archive'])),
    working: { files: readWorkingFiles(working['files']) },
    final: readFinal(row['final']),
    reading: readReading(row['reading']),
  };
  // LAST, because it is the only field built from the manifest rather than from
  // one of its rows: an un-migrated project's ledger is reconstructed out of the
  // archive, the reading and the chains that were read above it.
  manifest.ledger = readLedger(row['ledger'], manifest, file);
  return manifest;
}

/**
 * The step ledger — parsed from the catalogue, or reconstructed for one that
 * predates the whole idea.
 *
 * HEAL ON READ, PERSIST ON NEXT WRITE, which is `healImport`'s pattern a few
 * lines up and `readDocuments`'s before it, for their reason: every project on
 * every disk predates this field, and a migration that only ran on write could
 * half-finish across a crash, while one that rewrote the file on read would make
 * opening Home a write across the user's whole library. `migrateLedger` is
 * deterministic — its ids are ordinal and its times come from the catalogue — so
 * reading a project twice produces the same history byte for byte, and the ids
 * the pointer and the parent chain point at do not move between Tuesday and
 * Wednesday. It reaches disk the next time anything edits the project.
 *
 * A STORED LEDGER THAT WILL NOT PARSE TAKES THE CATALOGUE DOWN, by name, and is
 * not quietly replaced with a migrated one. Both halves of that matter. Refusing
 * is what `readManifest` already does for a catalogue that is not JSON, and it
 * surfaces the same way — `summarise` lists the project with the reason on it, so
 * Home is still the door back to the book. Rebuilding instead would be worse than
 * useless: the reconstruction cannot know about a curation step or a second
 * translation, so a project with a typo in one row would silently lose the
 * history of everything the migration cannot see, and the payloads those steps
 * named would sit in the folder with nothing in the app aware that they exist.
 */
function readLedger(stored: unknown, manifest: ProjectManifest, file: string): ProjectLedger {
  if (stored === undefined) return migrateLedger(manifest);
  try {
    return parseLedger(stored);
  } catch (err) {
    throw new ProjectError(
      `${file} holds a step ledger this app cannot read: ${(err as Error).message}. The ledger is `
      + 'this project\'s account of everything that has been done to the book and of which file each '
      + 'of those left behind, so it is not something to guess at or to rebuild around.',
    );
  }
}

/**
 * The reading generation, or null for a catalogue written before there were any.
 *
 * NULL RATHER THAN A MINTED ONE, and the difference is the whole safety of the
 * backfill: a project with no record here has no overlay that could be bound to a
 * generation — there was nothing writing one — so whatever id it is given first
 * cannot disagree with a file already on disk. Read leniently for the same
 * reason `readTrees` is: a half-written field is treated as absent, which lands
 * on the same safe path.
 */
function readReading(value: unknown): ProjectReading | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const generation = row['generation'];
  if (typeof generation !== 'string' || generation.length === 0) return null;
  const completedAt = row['completedAt'];
  return {
    generation,
    readAt: typeof row['readAt'] === 'number' ? row['readAt'] : 0,
    pages: typeof row['pages'] === 'number' ? row['pages'] : 0,
    /*
     * ABSENT AND ZERO ARE NOT THE SAME STATEMENT here, which is why this is
     * spread rather than defaulted. Absent means nobody recorded which completion
     * this generation was minted against, and `readingGeneration` ADOPTS the
     * marker it finds rather than treating it as a change — the safe direction. A
     * recorded 0 would be a claim about an epoch nothing ever completed at, and
     * every marker on disk would disagree with it forever.
     *
     * `passes` IS NOT READ AND IS NOT CARRIED. It counted archived banks, nothing
     * archives one any more, and a number whose meaning has been deleted is worse
     * kept than dropped — see `ProjectReading.passes`. A catalogue holding one is
     * not refused; the field simply goes the next time this project is written.
     */
    ...(typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0
      ? { completedAt }
      : {}),
  };
}

/**
 * The type records — read from a v2 catalogue, or built from a v1 one.
 *
 * MIGRATION HAPPENS ON EVERY READ AND IS NOT WRITTEN BACK BY ITSELF. A v1 file
 * is turned into type records in memory here; the new shape reaches disk the
 * next time anything edits the project through `withManifest`, which writes the
 * whole file. That ordering is deliberate: reading somebody's library must not
 * rewrite it, and a migration that only runs on write cannot half-finish across
 * a crash — either the old file is still there and is migrated again on the next
 * read, or the new one is complete.
 */
function readDocuments(
  row: Record<string, unknown>,
  archive: ProjectManifest['archive'],
): ProjectTypeRecord[] {
  const layers = { archive: ARCHIVE, generated: GENERATED };
  if (Array.isArray(row['documents'])) {
    return healImport(readTypeRecords(row['documents']), archive, layers);
  }
  return migrateToSteps(readGenerated(row['generated']), archive, layers);
}

/**
 * The origin step a v2 catalogue is missing, put back on read.
 *
 * ── The bug, and why the migration hid it ───────────────────────────────────
 *
 * `importDocument` wrote `working.files` for a PDF and never recorded a STEP —
 * only the EPUB branch did. So every project imported as a scan carried
 * `documents: []`, and nobody noticed for one reason: `summarise` has a fallback
 * that lists the archived original when a project has no documents at all, so
 * the row appeared and the book opened. V1 PROJECTS WERE CORRECT THE WHOLE TIME
 * BECAUSE THE MIGRATION DID WHAT THE WRITER FORGOT.
 *
 * It came apart the moment anything else was made. The fallback is gated on
 * `documents.length === 0`; generate an EPUB and the EPUB's record appears, so
 * the fallback stops firing and THE PDF ROW SIMPLY VANISHES — the scan becomes
 * unopenable, un-Blockable, `originalOf` falls to the EPUB, and a delete aimed
 * at the project's only remaining row is treated as an ordinary file.
 *
 * ── The heal ────────────────────────────────────────────────────────────────
 *
 * A catalogue that records an archive and has no chain for that archive's KIND
 * is missing its origin, full stop: the archive is the origin, and that is the
 * generalisation this whole model turns on. So the step is synthesised — BY
 * CALLING THE MIGRATION with an empty `generated` list, so the shape is not
 * merely "the same as" what the migration produces, it IS what the migration
 * produces. Two functions building one step is how they come to differ.
 *
 * ON READ, and not written back by itself, exactly as the v1 migration is: it
 * reaches disk the next time anything edits the project. So the live projects
 * this was written for heal without a re-import and without a repair pass
 * anybody has to remember to run.
 */
function healImport(
  records: ProjectTypeRecord[],
  archive: ProjectManifest['archive'],
  layers: { archive: string; generated: string },
): ProjectTypeRecord[] {
  if (archive === null) return records;
  if (records.some((record) => record.kind === archive.kind)) return records;
  return [...migrateToSteps([], archive, layers), ...records];
}

function readArchive(value: unknown): ProjectManifest['archive'] {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const file = row['file'];
  const kind = row['kind'];
  if (typeof file !== 'string' || (kind !== 'pdf' && kind !== 'epub')) return null;
  return {
    file,
    kind,
    contentKey: typeof row['contentKey'] === 'string' ? row['contentKey'] : '',
    originPath: typeof row['originPath'] === 'string' ? row['originPath'] : null,
  };
}

function readGenerated(value: unknown): ProjectGenerated[] {
  if (!Array.isArray(value)) return [];
  const rows: ProjectGenerated[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const kind = row['kind'];
    const role = row['role'];
    if (typeof file !== 'string') continue;
    if (kind !== 'epub' && kind !== 'pdf' && kind !== 'txt') continue;
    if (!isGeneratedRole(role)) continue;
    rows.push({ file, kind, role, madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0 });
  }
  return rows;
}

function isGeneratedRole(value: unknown): value is ProjectGeneratedRole {
  return value === 'cast' || value === 'imported' || value === 'translation'
    || value === 'searchable' || value === 'text';
}

/*
 * `readTrees` IS GONE, AND AN OLD CATALOGUE'S `working.trees` IS SIMPLY NOT READ.
 *
 * The unpacked-EPUB working tree is deleted (docs/RENDERER.md §7): nothing
 * unpacks, nothing holds a tree, nothing sweeps one. The parser is a whitelist
 * rebuild rather than a mutation, so a field it stops naming never reaches the
 * in-memory catalogue and is dropped from disk the next time anything writes for
 * a reason of its own — exactly the precedent `ProjectReading.passes` set. NO
 * VERSION BUMP: a v2 catalogue carrying `working.trees` still parses, because the
 * version gate names versions and never keys.
 *
 * What stays under `working/` is the PDF's live copy — a different tenant of the
 * same folder, and the one the metadata dialog writes into.
 */
function readWorkingFiles(value: unknown): ProjectManifest['working']['files'] {
  if (!Array.isArray(value)) return [];
  const files: ProjectManifest['working']['files'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const from = row['from'];
    if (typeof file !== 'string' || typeof from !== 'string' || row['kind'] !== 'pdf') continue;
    files.push({ file, kind: 'pdf', from, madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0 });
  }
  return files;
}

function readFinal(value: unknown): ProjectManifest['final'] {
  if (!Array.isArray(value)) return [];
  const files: ProjectManifest['final'] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = row['file'];
    const kind = row['kind'];
    if (typeof file !== 'string') continue;
    if (kind !== 'epub' && kind !== 'pdf' && kind !== 'txt') continue;
    /*
     * THE STEP THIS EXPORT WAS MADE FROM, where a row has one. Rows written
     * before the field existed simply do not, and nothing is invented for them:
     * an unknown provenance is a true statement (`ProjectFinal.stepId`), and a
     * guess here would be this parser asserting a history the catalogue never
     * recorded. Spread conditionally so an old row round-trips byte for byte
     * rather than gaining an `undefined` the writer would then serialise away.
     */
    const stepId = row['stepId'];
    files.push({
      file,
      kind,
      madeAt: typeof row['madeAt'] === 'number' ? row['madeAt'] : 0,
      ...(typeof stepId === 'string' && stepId.length > 0 ? { stepId } : {}),
    });
  }
  return files;
}

/** Write the catalogue. Whole-file, small, and the only writer of this shape. */
async function writeManifest(dir: string, manifest: ProjectManifest): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Every read-modify-write of one project's catalogue, one at a time.
 *
 * `project.json` is rewritten whole, so two edits in flight for the same project
 * — a conversion recording its output while a book records the tree it just
 * unpacked — would have the second overwrite the first's field with the value it
 * read before the first landed. A promise chain per directory is the smallest
 * thing that makes that impossible, and projects are edited perhaps twice a
 * minute, so serialising them costs nothing measurable.
 */
const edits = new Map<string, Promise<unknown>>();

function withManifest<T>(dir: string, work: (manifest: ProjectManifest) => Promise<T>): Promise<T> {
  const key = path.resolve(dir).toLowerCase();
  const previous = edits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed edit must not poison the ones queued behind it */ })
    .then(async () => work(await readManifest(dir)));
  edits.set(key, next);
  return next;
}

/**
 * Make the project if it is not there, then run one edit against its catalogue.
 *
 * The create and the edit are in ONE serialised step because two documents
 * adopted at the same instant — main's background adoption of a dropped file and
 * the `epub:open` that follows it — would otherwise both find no `project.json`
 * and both write a fresh one, and the second would erase whatever the first had
 * just recorded.
 */
function withCreatedProject<T>(
  dir: string,
  key: string,
  stem: string,
  work: (manifest: ProjectManifest) => Promise<T>,
): Promise<T> {
  const mapKey = path.resolve(dir).toLowerCase();
  const previous = edits.get(mapKey) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* see withManifest */ })
    .then(async () => {
      let manifest: ProjectManifest;
      try {
        manifest = await readManifest(dir);
      } catch (err) {
        // Absent is the ordinary case — this is where a project is born. A
        // catalogue that EXISTS and will not parse is not: overwriting it would
        // throw away a member order that a book on disk still depends on.
        if (await exists(path.join(dir, MANIFEST))) throw err;
        manifest = {
          version: MANIFEST_VERSION,
          key,
          // The display title starts as the document's own name. It becomes the
          // book's `dc:title` the first time anything reads one — see
          // `noteProjectTitle` — and the stem never changes after this, because
          // renaming files under somebody is not a thing a catalogue does.
          title: stem,
          stem,
          createdAt: Date.now(),
          archive: null,
          documents: [],
          working: { files: [] },
          final: [],
          // Nothing has been read and nothing has been corrected. The reading's
          // generation is minted by the first amendment, not by the import —
          // see `readingGeneration`.
          reading: null,
          // No history yet, and not even an origin: the import that is about to
          // happen is what mints one, and it does so knowing which file it
          // copied. A project directory can also be created by an adoption that
          // never imports anything, and an empty ledger is the honest record of
          // that.
          ledger: emptyLedger(),
        };
        await writeManifest(dir, manifest);
      }
      return work(manifest);
    });
  edits.set(mapKey, next);
  return next;
}

/**
 * Copy, and refuse rather than overwrite.
 *
 * `COPYFILE_EXCL` makes "is it already there?" and "put it there" one operation
 * the filesystem decides, which is what keeps adoption idempotent under two app
 * instances started together. An existing destination is not an error here: it
 * means this document was adopted already, which is the answer we wanted.
 */
async function copyNewOnly(from: string, to: string): Promise<boolean> {
  try {
    await fsp.copyFile(from, to, fsconst.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Importing a document
// ─────────────────────────────────────────────────────────────────────────────

/** The extension a conversion's origin carries. See `ProjectGeneratedRole`. */
const GENERATED_EXTENSIONS: Readonly<Record<ConversionKind, string>> = {
  epub: '.epub',
  pdf: '.pdf',
  txt: '.txt',
};

/**
 * Moved to `shared/documents.ts` and re-exported under its old name here.
 *
 * The OCR dialog needs this table to know whether the source somebody picked is
 * the file their own run would write over, and a second copy in the renderer
 * would be a second opinion about what a conversion produces.
 */
const GENERATED_ROLES = GENERATED_ROLE_FOR;

/** `Working Towards The Fuhrer. Kershaw, Ian. (1993).epub` — the book's own name. */
export function generatedFileFor(stem: string, kind: ConversionKind): string {
  return `${stem}${GENERATED_EXTENSIONS[kind]}`;
}

export function generatedRoleFor(kind: ConversionKind): ProjectGeneratedRole {
  return GENERATED_ROLES[kind];
}

/*
 * `translationFileFor` MOVED TO shared/ledger.ts, and the move is the point rather
 * than tidying. That name is now composed in two places for one run — here, and by
 * the pure decision that says whether this translation is a branch and therefore
 * carries an `<id8>` before its extension — and a second copy of the rule is a
 * second answer about where a person's book went. It is imported above and used
 * unchanged by the legacy adoption below, which is the one caller that has a bare
 * tag rather than a step to ask.
 */

/** Where an imported document ended up, and the project it now belongs to. */
export interface ImportedDocument {
  /** The project directory. */
  dir: string;
  /** The document's path RELATIVE to it — `generated/x.epub`, `working/x.pdf`. */
  entry: string;
  key: string;
  stem: string;
  /**
   * What could not be done while importing, in words a person can read, or null.
   *
   * Today there is exactly one: an EPUB the engine would not stamp. It is a
   * NOTICE and not a failure — the document is imported, it opens, it reads —
   * and it reaches the notice strip through `EpubBook.notice` so that a book
   * whose select mode will not work says why on the way in rather than by
   * doing nothing when somebody presses the button.
   */
  notice: string | null;
}

/**
 * Give a freshly imported EPUB foundry's stamps, once, at the moment of import.
 *
 * WHY HERE. This is the one door a book comes through, and everything past it
 * assumes the stamps: `readFoundryBook` refuses a book without them BY NAME, so
 * `translate` and `epub-final` refuse an imported publisher's EPUB outright;
 * select mode outlines `data-bf-cat` and finds nothing; the inspector shows no
 * categories. Stamping later — when a person presses Select, say — means every
 * other door stays shut until they happen to press it.
 *
 * WHY WRITING `generated/` IS NOT A VIOLATION OF "generated/ IS NEVER WRITTEN".
 * That rule is about EDITING an origin after the fact, because the origin is the
 * record every curation decision downstream is measured against. This runs
 * INSIDE the copy that makes the origin, before anything has read it, exactly
 * once, and it adds attributes rather than changing a word — and `archive/`
 * holds the user's file byte for byte whatever happens here. The book that
 * lands in `generated/` is the book this app works from, and a book nothing can
 * address is not one.
 *
 * The engine refuses to write over an input, so the stamped book is written
 * beside the copy and renamed onto it: the file at the catalogued path is
 * either the plain copy or the stamped one, never half of either.
 */
async function stampImported(file: string): Promise<string | null> {
  const staged = `${file}.stamping`;
  const failed = async (reason: string): Promise<string> => {
    await fsp.rm(staged, { force: true }).catch(() => { /* best effort */ });
    return `${path.basename(file)} could not be given Foundry's block stamps, so select mode and `
      + `translation will not open it. ${reason}`;
  };
  try {
    const outcome = await stampEpub(file, staged);
    if (!outcome.ok) return await failed(outcome.reason ?? 'The engine said nothing.');
    await fsp.rename(staged, file);
    return null;
  } catch (err) {
    return await failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Find or make the project this document belongs to, and return where it sits.
 *
 * ALREADY INSIDE ONE — a conversion's origin, a document opened again from Home
 * — and the project is simply named: nothing is copied, nothing is re-hashed,
 * and a translation planned from the cast EPUB lands in the same folder as the
 * book it was made from. That last one is the whole reason this function exists
 * rather than a bare `contentKey` call at each site: keying the translation off
 * the CAST EPUB's bytes would file it under a project of its own, and the book
 * and its translation would be two unrelated folders.
 *
 * OUTSIDE — a file the user dropped, opened or named on the command line — and
 * it is IMPORTED, into both layers that matter for its kind:
 *
 *   a PDF is copied to `archive/` (the untouched original, possibly the only
 *   copy of that scan there will ever be) and again to `working/`, which is the
 *   live PDF: the one the user sees, and the one metadata edits will land in
 *   when they are implemented;
 *
 *   an EPUB is copied to `archive/` and again to `generated/` with the role
 *   `imported`, because an imported book plays exactly the part a cast one does
 *   — an origin that is never written, with a working tree unpacked from it —
 *   and that second copy is STAMPED as it is made, so the origin every later
 *   pass reads is one those passes will admit (`stampImported`);
 *
 * Copied and never moved, because it is the user's file and it stays where they
 * put it. Copied and never written, because from here on the working copy is
 * what this app edits.
 */
/**
 * What an import from outside the library announces, the moment it lands —
 * `onQueueChanged`'s shape for `onQueueChanged`'s reason: this module's business
 * is the projects on disk, not who is hosting the app, and the one place that
 * knows whether anybody is listening (electron/mount.ts) wires it. One listener,
 * replaced rather than appended, exactly like the queue's pair.
 *
 * Fired for the OUTSIDE branch of `importDocument` only: a path already inside a
 * project is the app noticing its own file, and there is no first contact to
 * witness.
 */
let importLanded: (landing: ImportLanding) => void = () => { /* set by mount */ };

export function onImportLanded(listener: (landing: ImportLanding) => void): void {
  importLanded = listener;
}

export async function importDocument(
  filePath: string,
  kind: 'pdf' | 'epub',
): Promise<ImportedDocument> {
  const resolved = path.resolve(filePath);
  const inside = projectDirOf(resolved);
  if (inside !== null) {
    const manifest = await readManifest(inside);
    const entry = path.relative(inside, resolved).split(path.sep).join('/');
    // Nothing is imported and nothing is stamped: this document is already the
    // app's own, and it was stamped when it became one.
    return { dir: inside, entry, key: manifest.key, stem: manifest.stem, notice: null };
  }

  const name = path.basename(resolved);
  const key = `${slugify(name)}-${await contentKey(resolved)}`;
  const dir = path.join(projectsDir(), key);
  const live = kind === 'pdf' ? WORKING : GENERATED;

  const imported = await withCreatedProject(dir, key, stemOf(name), async (manifest) => {
    // `manifest.stem` and NOT the name this call computed. A project adopted
    // from the flat workspace was named after a slug, and every file already in
    // it carries that name; a second name arriving with a later import would put
    // two spellings of one book in one folder and two rows for it on Home.
    const liveFile = kind === 'pdf' ? `${manifest.stem}.pdf` : `${manifest.stem}.epub`;
    if (manifest.archive === null) {
      await fsp.mkdir(path.join(dir, ARCHIVE), { recursive: true });
      await copyNewOnly(resolved, path.join(dir, ARCHIVE, name));
      manifest.archive = { file: name, kind, contentKey: key.slice(-8), originPath: resolved };
    }
    // The live layer, made from the archive copy rather than from the user's
    // file: the archive is now the origin of record, and reading the original
    // twice would make two copies that could differ if it changed underneath.
    const archived = path.join(dir, ARCHIVE, manifest.archive.file);
    await fsp.mkdir(path.join(dir, live), { recursive: true });
    const made = await copyNewOnly(archived, path.join(dir, live, liveFile));
    let notice: string | null = null;
    /*
     * CATALOGUED WHETHER OR NOT THIS CALL MADE THE COPY, and the two used to be
     * one condition. `copyNewOnly` answers false when the file is already there,
     * which is the ordinary outcome of importing the same book twice and the
     * inevitable outcome of a crash between the copy and the manifest write —
     * and skipping the catalogue on false left the live document ON DISK and
     * UNLISTED. Home reads the catalogue, so the project drew as a book nothing
     * had been made from, with the user's own scan sitting in `working/` a
     * folder away and no row anywhere that would open it. The copy existing is
     * exactly the condition under which the row has to be there.
     *
     * The STAMP is still gated on `made`, and that gate is the real one: it runs
     * inside the copy that makes an origin, once, before anything has read it
     * (see `stampImported`), and re-stamping a book somebody has been editing
     * would be this app rewriting an origin after the fact.
     */
    if (kind === 'pdf') {
      const already = manifest.working.files.find((row) => row.file === liveFile);
      manifest.working.files = [
        ...manifest.working.files.filter((row) => row.file !== liveFile),
        {
          file: liveFile,
          kind: 'pdf',
          from: `${ARCHIVE}/${manifest.archive.file}`,
          // The copy's own age, not this import's. A row written now for a file
          // copied last week would date the document by when it was noticed.
          madeAt: already?.madeAt ?? Date.now(),
        },
      ];
      /*
       * THE SCAN'S ORIGIN, which this branch never recorded and should have from
       * the day the step model existed.
       *
       * The working row above says which file is live; it says nothing about
       * what the PDF IS or where it came from, and `documents` is what every
       * reader of a project asks. Without this a scanned project carried
       * `documents: []` — invisible for as long as nothing else had been made
       * from it (`summarise`'s fallback covered it) and then, the moment an EPUB
       * was generated, the PDF row disappeared entirely. See `healImport`, which
       * puts this back for the catalogues written before this line existed.
       *
       * `archive/<file>` AND NOT the working copy, which is the same choice
       * `migrateToSteps` makes and for the model's own reason: a chain records
       * what was APPLIED, and the copy in `working/` is not a step, it is the
       * thing the steps are about (`summarise` resolves it from `working.files`).
       *
       * `onlyIfEmpty` for the EPUB branch's reason exactly: importing the same
       * book twice must not write a second account of where it came from.
       */
      recordStep(manifest, 'pdf', {
        file: `${ARCHIVE}/${manifest.archive.file}`,
        label: 'The scan you imported',
        appliedAt: manifest.createdAt > 0 ? manifest.createdAt : Date.now(),
        kind: 'origin',
        // The most expensive thing in the project: it came from outside this
        // program and there may be no other copy of that scan anywhere.
        retention: 'irreplaceable',
        why: WHY_IMPORTED,
      }, { onlyIfEmpty: true });
    } else {
      // A refusal from the stamp is a sentence and not a throw: the copy stands,
      // the book opens, and the person is told which of its doors is shut.
      if (made) notice = await stampImported(path.join(dir, live, liveFile));
      /*
       * THE EPUB'S ORIGIN, which is what an imported book is.
       *
       * Recorded only when the type has no chain yet: `<stem>.epub` is also the
       * name a CAST writes, and a second import-shaped origin arriving over a
       * cast one would rewrite this project's account of where its book came
       * from. The first step wins, which is the same rule the old `role` field
       * was protecting with the same comment.
       */
      recordStep(manifest, 'epub', {
        file: `${live}/${liveFile}`,
        label: 'The book you imported',
        appliedAt: Date.now(),
        kind: 'origin',
        // The most expensive thing in the project: it came from outside this
        // program and there may be no other copy of it anywhere.
        retention: 'irreplaceable',
        why: WHY_IMPORTED,
      }, { onlyIfEmpty: true });
    }
    /*
     * ── THE ORIGIN OF THE STEP LEDGER ─────────────────────────────────────────
     *
     * The one step in a project whose parent is null, and the only one that is
     * not produced by a queue job: importing is a file copy, and what it retains
     * is the untouched original — irreplaceable for the reason nothing else in a
     * project is, which is that some of these are scans of documents that exist
     * nowhere else and only the user knows where the file came from.
     *
     * ONLY INTO AN EMPTY LEDGER, which is `recordStep`'s `onlyIfEmpty` for the
     * same reason: importing the same book twice is the app noticing something it
     * already knew, and a second origin would be a second account of where this
     * project's document came from. A project that reached here with a MIGRATED
     * ledger already has an origin reconstructed from this very archive row, so
     * this is correctly skipped for it too — the ids stay the ones `migrateLedger`
     * mints deterministically, and the pointer keeps pointing at something.
     *
     * THE LABEL IS THE CHAIN'S, verbatim, and that is not a coincidence to be
     * cleaned up later: `migrateLedger` reads the origin step's label out of the
     * per-type chain, so a project that arrived by migration and one that arrived
     * by import must say the same words about the same file or the two look like
     * different books.
     */
    if (ledgerOf(manifest).steps.length === 0) {
      manifest.ledger = originLedger(
        `${ARCHIVE}/${manifest.archive.file}`,
        kind === 'pdf' ? 'The scan you imported' : 'The book you imported',
        manifest.createdAt > 0 ? manifest.createdAt : Date.now(),
      );
    }
    await writeManifest(dir, manifest);
    // A project was made or grown. The library screen has no other way to hear
    // about a drop that landed while somebody was looking at something else.
    announceProjects();
    return { dir, entry: `${live}/${liveFile}`, key, stem: manifest.stem, notice };
  });
  /*
   * AFTER the manifest is durably written — a host that goes looking at the
   * folder this names must find a catalogue in it. Caught here for the queue's
   * reason at its own settle: the import has landed whatever a listener does
   * with the news.
   */
  try {
    importLanded({ projectDir: dir, originalPath: resolved, kind });
  } catch (err) {
    console.error(
      `[projects] the import-landed listener threw for ${resolved}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return imported;
}

// ─────────────────────────────────────────────────────────────────────────────
// The step ledger, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A manifest's ledger, never undefined.
 *
 * `readManifest` sets the field on every project it returns — migrated when the
 * file has none — so the optional in `ProjectManifest` describes the FILE FORMAT
 * rather than anything a caller in this process can be handed. This is the one
 * place that says so, instead of `?? emptyLedger()` at every call site, where the
 * fallback would eventually be read as "a ledger is sometimes absent" and
 * somebody would write a branch for it.
 */
export function ledgerOf(manifest: ProjectManifest): ProjectLedger {
  return manifest.ledger ?? emptyLedger();
}

/**
 * The origin, with a uuid: this module has the clock and the randomness
 * `shared/ledger.ts` deliberately does without.
 *
 * NO POINTER, which means the newest step — and with one step in the ledger that
 * is this one. Writing it out would be recording a fact the array already
 * implies, in a folder people sync.
 */
function originLedger(payload: string, label: string, createdAt: number): ProjectLedger {
  return { steps: [originStep(randomUUID(), payload, Math.max(0, Math.trunc(createdAt)), label)] };
}

/**
 * `<project>/curations/` — the frozen snapshots of the block editor's overlay.
 *
 * A SEVENTH SIBLING, on `overlays/`'s precedent and NOT inside it, which is the
 * decision worth writing down. `overlays/` held the live pair and its archive
 * folders, and everything that walked it treated what it found there as one
 * book's current curation and its discarded predecessors — the
 * archive-on-generation-mismatch machinery went with the overlay system
 * (docs/RENDERER.md §7), and `countAmendments` still walks the legacy folder so
 * the delete card counts a v1 project's work. A snapshot is neither of those
 * things: it is a RETAINED PAYLOAD, named by a step, deleted only when that step
 * is, and never archived aside because it was never bound to the live file's
 * fate. Filing it under `overlays/` would have put it in the path of a sweep
 * whose entire premise was that what it finds there is disposable.
 *
 * `<uuid>.json` rather than a name anybody reads: the step's LABEL is what a
 * person sees ("Applied changes (23)"), and a filename that tried to say the
 * same thing would be a second place for it to be said differently.
 */
export function curationsDir(dir: string): string {
  return path.join(dir, CURATIONS);
}

/**
 * `<project>/metadata/` — the patches a metadata step retained, one per Apply.
 *
 * AN EIGHTH SIBLING, on `curations/`'s precedent and for the identical argument.
 * A patch is a RETAINED PAYLOAD: named by a step, deleted only when that step is,
 * never archived aside, and — the part that decides the folder — READ AGAIN LONG
 * AFTER IT WAS WRITTEN, because every export replays the chain of them
 * (`metadataInEffect`). Nothing in this app may treat what it finds here as
 * disposable, which is exactly what a sweep of `working/` or `overlays/` assumes
 * about its contents.
 *
 * `<uuid>.json` rather than a name anybody reads, for `curationsDir`'s reason:
 * the step's LABEL is what a person sees ("Metadata (title, author)"), and a
 * filename that tried to say the same thing would be a second place for it to be
 * said differently.
 */
export function metadataDir(dir: string): string {
  return path.join(dir, METADATA);
}

/**
 * `<project>/ops/` — the changes each Apply on the book wrote, one file per step.
 *
 * A NINTH SIBLING, on `curations/`' and `metadata/`'s precedent and for the
 * identical argument, with one clause of it sharper than either. An ops file is a
 * RETAINED PAYLOAD: named by a step, deleted only when that step is, never
 * archived aside — and READ AGAIN EVERY TIME THE BOOK IS OPENED, because standing
 * anywhere means replaying the ops of every edit step on the path
 * (docs/RENDERER.md §3). Nothing in this app may treat what it finds here as
 * disposable, which is exactly what a sweep of `working/` or `overlays/` assumes
 * about its contents.
 *
 * `<id8>.jsonl` — the front of the step's own uuid, which is the scheme a branch
 * read and a branch translation already name their files with (`id8`,
 * shared/ledger.ts). Not a name anybody reads, for `curationsDir`'s reason: the
 * step's LABEL is what a person sees ("Applied changes (5)"), and a filename
 * trying to say the same thing would be a second place for it to be said
 * differently. Not the whole uuid either, because these sit beside each other in
 * one folder and eight hex is already how this project distinguishes a branch's
 * files from the trunk's.
 */
export function opsDir(dir: string): string {
  return path.join(dir, OPS);
}

/**
 * The PROJECT-RELATIVE payload an edit step names, composed in the ONE place that
 * knows the spelling.
 *
 * Forward slashes, as every payload is (`LedgerStep.payload`): the ledger's
 * spelling of a path is not this platform's, and a row carrying a backslash is a
 * row no other machine could resolve. The step id is minted before the file is
 * written — the reading's arrangement (`ReadRequest.stepId`), for its reason: the
 * file is named after a row that does not exist yet, and minting a second id at
 * the landing would leave it named after a step nobody created.
 */
export function opsPayloadFor(stepId: string): string {
  return `${OPS}/${id8(stepId)}.jsonl`;
}

/**
 * A finished action, recorded against an OPEN manifest. The caller writes.
 *
 * ── The parent, and the two ways it can be wrong ────────────────────────────
 *
 * `parent` is the position captured when the job was ENQUEUED (`Job.parentStep`),
 * which is the whole reason it is an argument rather than something read here: a
 * pointer move while a job sits held must not silently retarget it. Null means
 * nobody captured one — a curation commit, which happens now and therefore has no
 * gap to be wrong across, or a job from a build that predates the field — and
 * then the position at this instant is the honest answer.
 *
 * A CAPTURED PARENT THAT IS NO LONGER THERE FALLS BACK TO THE POSITION rather
 * than refusing. The step it named was deleted while the run was going, and the
 * alternative to falling back is throwing away the payload of a job that has
 * already finished in order to protect the shape of a list. The list is
 * recoverable; three hours of GPU are not — the same call `appendStep` makes when
 * a clock steps backwards, for the same reason.
 *
 * RETURNS NULL FOR A LEDGER WITH NO STEPS, which is not an error either. A
 * project adopted out of the old flat workspace can have outputs and no import,
 * so there is no origin for anything to hang from, and inventing a parentless
 * `read` would give that project a history whose first act was reading a book
 * nobody can see was imported.
 */
async function landStep(
  manifest: ProjectManifest,
  run: Omit<LandedRun, 'id' | 'parent'> & {
    parent: string | null;
    /**
     * THE ID, WHEN THE CALLER ALREADY SPENT IT ON SOMETHING. A reading's bank is
     * named after the step it belongs to (`bankForReading`), so that id was minted
     * hours ago at the plan and has been written into a filename since — minting a
     * second one here would leave the file named after a step nobody created. Every
     * other landing has nothing riding on the id and lets this mint one.
     *
     * It is spent only on an append either way, which is `LandedRun.id`'s own rule.
     */
    id?: string;
  },
): Promise<Landing | null> {
  const ledger = ledgerOf(manifest);
  const standing = positionOf(ledger);
  if (standing === null) return null;
  const captured = run.parent !== null && ledger.steps.some((step) => step.id === run.parent)
    ? run.parent
    : standing.id;
  const landing = recordLanding(ledger, { ...run, parent: captured, id: run.id ?? randomUUID() });
  manifest.ledger = landing.ledger;
  return landing;
}

/**
 * Destroy a payload the ledger no longer names. After the write, never before.
 *
 * `force` so a payload that is already gone — a bank the user deleted by hand, a
 * rendering that never landed — finishes the delete rather than refusing it: what
 * is being removed is the app's claim to own the file, and being generous about a
 * file that has already left is not being generous about which file this is. The
 * path is composed from the project directory and the step's own PROJECT-RELATIVE
 * payload, split on the forward slashes the format stores, so nothing here ever
 * matches a file by its basename.
 */
async function destroyPayload(dir: string, payload: string): Promise<void> {
  const target = path.join(dir, ...payload.split('/'));
  await fsp.rm(target, { force: true, recursive: false });
}

/**
 * The steps and the flat list the accordion draws, in one answer.
 *
 * EVERY CALL THAT CHANGES A LEDGER ANSWERS WITH THIS, and that is a correction
 * rather than a convenience. Three of them used to hand back a bare
 * `ProjectLedger` — the pointer move, the delete and the commit — and the rows
 * are MAIN'S TO COMPOSE (`chronological`, and the "from …" annotation is the one
 * concession this design makes to the tree), so the renderer had to ask again
 * after every one of them. A second round trip is a second answer, composed a
 * moment later, about a catalogue that may have moved: the window either drew a
 * list from before its own gesture or painted twice. What a caller gets back now
 * is the whole answer to what it just did.
 */
export interface LedgerView {
  ledger: ProjectLedger;
  /**
   * `chronological`'s rows, composed HERE rather than in the renderer.
   *
   * The ordering and the quiet "from Read" annotation are the two things the flat
   * list gets wrong if anybody re-derives them, and the renderer re-deriving them
   * would be a second implementation of the one concession this design makes to
   * the tree. Main holds the ledger; main says what the list looks like.
   */
  rows: StepRow[];
}

/**
 * One project's history, as the library needs it.
 *
 * The path is PROVEN to be a project before a byte is read — `deletableProjectDir`
 * — because every call in this family takes a directory named by the renderer and
 * one of them unlinks files. The gate is the same one on every member so that none
 * of them is the lenient way in.
 *
 * NULL FOR A PROJECT THAT IS GONE, and only for gone. The window re-reads every
 * ledger it holds on `projects:changed`, and a delete IS a `projects:changed` —
 * so the one guaranteed reader of a just-deleted project is this function, asked
 * in good faith by a mirror that has not yet heard. That read used to throw
 * ENOENT into the console on every announce for the rest of the session. "It no
 * longer exists" is a state, not an exception; the caller drops its holding and
 * stops asking. A manifest that EXISTS but will not parse still throws — that is
 * a book somebody needs to fix a file for, and silence would bury it.
 */
export async function readStepLedger(dir: string): Promise<LedgerView | null> {
  const proven = deletableProjectDir(dir);
  if (!await exists(path.join(proven, MANIFEST))) return null;
  const manifest = await readManifest(proven);
  const ledger = ledgerOf(manifest);
  return { ledger, rows: chronological(ledger) };
}

/**
 * Stand on a different step.
 *
 * FREE, AND THE FREENESS IS THE FEATURE. Clicking a row in a history panel is a
 * gesture every user of every history panel believes costs nothing, and here it
 * genuinely does: one manifest write, no job, no rendering, no file touched. What
 * it changes is what the viewers show and what the next action is made from.
 *
 * `stepOf` refuses an id this ledger does not hold, by name. A pointer that has
 * come loose is not something to fall back from quietly — the caller named a row
 * the app drew, so an id that is not there means the two are looking at different
 * ledgers, and the honest answer is to say so.
 */
export async function goToStep(dir: string, stepId: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
    const standing = stepOf(ledgerOf(manifest), stepId);
    const next: ProjectLedger = { ...ledgerOf(manifest), position: standing.id };
    manifest.ledger = next;
    await writeManifest(resolved, manifest);
    return next;
  });
  // The tabs of this project repaint from the position, and Home's rows are
  // derived from what the ledger calls current. Both hear about it the one way
  // anything in this app hears that a project moved.
  announceProjects();
  // The rows are the same rows — a pointer move changes no step and no order —
  // and they are composed again anyway, because a caller that had to know which
  // of these answers is worth redrawing would be a caller deriving the list.
  return { ledger, rows: chronological(ledger) };
}

/**
 * What deleting this step would take, and whether it is allowed at all.
 *
 * DESCRIBE AND DELETE ARE TWO CALLS, exactly as they are for a document, and this
 * one owes the refusals as well as the facts: a card must never be put on screen
 * for something the delete would refuse a click later. `deleteSubtree` refuses the
 * origin by name — deleting the import is deleting the project, and the project ✕
 * does that with its own ceremony and its own accounting of what it costs.
 *
 * EVERY CASUALTY IS NAMED WITH ITS OWN COST, in the retention rule's own terms,
 * because the three retentions are three genuinely different losses. A confirm
 * that said "Are you sure?" over a list of four would train somebody to click
 * through the one that was about their curation.
 */
export async function describeStepDelete(dir: string, stepId: string): Promise<StepDeletion> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  const named = stepOf(ledger, stepId);
  // Run for its REFUSAL as much as for its list: this is the one place that can
  // say no before the user has agreed to anything.
  const deletion = deleteSubtree(ledger, stepId);
  const banks = new Set(orphanedBanks(deletion, manifest.key));
  const destroyed = destroyedBy(deletion, manifest.key);
  const sweeps = await planStepSweep(resolved, destroyed, banks, manifest, deletion.removed);
  return {
    belongings: sweptBelongings(sweeps),
    stepId: named.id,
    label: named.label,
    casualties: subtree(ledger, stepId).map((step): StepCasualty => ({
      id: step.id,
      label: step.label,
      cost: deleteCost(step),
      stale: step.stale === true,
    })),
    /*
     * THE PAYLOADS, AND THE FACSIMILES THE DOOMED READINGS MADE FOR THEMSELVES.
     *
     * This list is what the window LETS GO OF before main unlinks anything, and a
     * read step's facsimile is a document a person can have open in a tab — it is
     * the terminal row drawn under the import. Leaving it out would meet main's own
     * refusal one line after the user said yes, which is a dialog that asks a
     * question and then declines to act on the answer. `castsAmong` is the same
     * function the sweep above composed its paths with, so the card and the delete
     * cannot come to two lists.
     */
    files: [
      ...destroyed.map((payload) => path.join(resolved, ...payload.split('/'))),
      ...await castsAmong(resolved, manifest, deletion.removed),
    ],
  };
}

/**
 * Refuse while this window is still reading one of the doomed payloads.
 *
 * ── WHICH MODEL WON, and it is the document delete's ────────────────────────
 *
 * There were two in the app and they did not agree. The PROJECT delete refuses in
 * main by asking `openBookIn` — it looks at what is open and says no. The DOCUMENT
 * delete refuses in main too, by a narrower test (`workingTreeHeld`, the count the
 * epub reader holds from open to close), AND the renderer closes the file's own
 * tab between the confirm and the call. The step delete had neither, so deleting a
 * translate step whose EPUB was open left a tab serving a working copy that had
 * just been erased: every image a 404, every save a failure, and nothing on screen
 * saying why.
 *
 * THE DOCUMENT DELETE'S MODEL IS THE ONE ADOPTED HERE, whole: main refuses, and
 * the renderer closes first so the refusal is almost never reached. The narrower
 * test is the right one for the same reason it is right there — a step delete
 * takes ONE payload out of a project, and refusing it because some other book in
 * the same folder happens to be open would make the ✕ useless exactly when it is
 * wanted (throw away the English translation while reading the scan). The project
 * delete keeps `openBookIn` because it erases the folder, which is a different
 * act and says so in its own sentence.
 */
/**
 * Everything on disk that goes with the payloads a step delete destroys.
 *
 * ── The state this was leaving behind ───────────────────────────────────────
 *
 * A step delete used to unlink the payload and nothing else, and a payload is not
 * the only file that belongs to it. Deleting a translation whose EPUB had been
 * unpacked left `working/<tree>/` — a whole book's markup — in the folder, a
 * `working.trees` row whose `from` named a file that no longer existed, and
 * `history/<tree>.json`, an undo ledger for a book that is gone. None of it is
 * reachable from anything in the app afterwards: the row it hung off is off the
 * ledger, so it is bytes nothing will ever mention again, which is precisely the
 * outcome `deleteDocument` was written to avoid.
 *
 * `planSweep` IS THAT ANSWER AND IT IS REUSED RATHER THAN RESTATED. It is the one
 * place that knows what belongs to a file alone — the tree, the ledgers live and
 * archived, the rotated predecessors — and its docstring is the argument for each.
 * Two functions deciding that would be two answers to "what is this file's", and
 * the delete card and the delete would eventually describe different things.
 *
 * ONE SWEEP PER PAYLOAD, over `orphanedPayloads` rather than the removed steps:
 * a file another step still names is still on disk and still has a working tree
 * serving it. See that function for the re-read that leaves two steps naming one
 * bank.
 */
async function planStepSweep(
  dir: string,
  payloads: readonly string[],
  /**
   * Which of those files are BANKS, so the engine's in-flight debris beside them
   * goes too. See `pendingBeside` for what that debris is and why no step will
   * ever name it.
   *
   * Both kinds are in here (`orphanedBanks`): a reading's bank, which is also its
   * step's payload, and a translation's, which is a file beside its step's payload
   * and reaches this list only because `destroyedBy` put it there. The translate
   * engine writes `<bank>.pending` and no request sidecar, and an absent sidecar
   * simply fails the existence test below — one rule, two callers, no `if`.
   */
  banks: ReadonlySet<string>,
  manifest: ProjectManifest,
  /**
   * THE ROWS THIS DELETE TAKES OFF THE LEDGER, for the files that belong to a step
   * and are nobody's payload: the books a save and a translation cast for
   * themselves.
   *
   * It is a rendering — free, regenerable, never catalogued
   * (`facsimileForReadStep` says why not) — which is exactly what makes it
   * unreachable from every other mechanism in here. `orphanedPayloads` reasons
   * over payloads and this is not one; `manifest.documents` has no row for it; the
   * name is composed from the step's own uuid, so once the row is gone nothing on
   * this disk could ever work out what the file was. Left behind it would be a
   * whole PDF in `generated/` that no screen in this app will ever mention again,
   * which is the same failure a translation's abandoned bank was.
   *
   * THE STEPS AND NOT A LIST OF PATHS, because composing the name needs the
   * project's stem and the step's id together, and a caller that composed it would
   * be the second place that decides what a reading's reprint is called.
   */
  removed: readonly LedgerStep[] = [],
): Promise<Sweep[]> {
  const sweeps: Sweep[] = [];
  for (const cast of await castsAmong(dir, manifest, removed)) {
    /*
     * THROUGH `planSweep`, which is what makes this more than an unlink: a re-read
     * that replaced this same step rotated its earlier reprints aside, and those
     * belong to this file and to nothing else.
     */
    const sweep = await planSweep(dir, cast, manifest);
    sweep.files.push(cast);
    sweeps.push(sweep);
  }
  for (const payload of payloads) {
    const resolved = path.join(dir, ...payload.split('/'));
    const sweep = await planSweep(dir, resolved, manifest);
    /*
     * ADDED HERE RATHER THAN INSIDE `planSweep`, deliberately: that function is
     * shared with the DOCUMENT delete, which is about EPUBs and PDFs and has no
     * business knowing what a readings bank is. This is the step delete's own
     * rule, so it is applied where the step delete composes its sweeps.
     *
     * The existence test is `planSweep`'s own idiom, and it earns its stat: the
     * card counts and lists what a sweep holds, and a path in there for a file
     * that was never on disk would be this app naming debris it invented.
     */
    if (banks.has(payload)) {
      for (const debris of pendingBeside(resolved)) {
        if (await exists(debris)) sweep.files.push(debris);
      }
    }
    sweeps.push(sweep);
  }
  return sweeps;
}

/**
 * The facsimiles the doomed readings made for themselves, absolute, and only the
 * ones that are actually there.
 *
 * ONE COMPOSITION FOR TWO CALLERS — the sweep that removes them and the card that
 * names them — because a card may not destroy something it did not name, and two
 * places composing `<stem>.<id8>.pdf` is exactly how it ends up doing that.
 *
 * ONE KIND OF LANDING PRODUCES A DOCUMENT NOBODY ASKED FOR, and since R6b it is
 * the reading's facsimile alone: the per-step cast EPUBs a save and a translation
 * used to leave behind are deleted, and both rows are answered by the proof sheet
 * (docs/RENDERER.md §7). Deleting a read step
 * already destroys the bank it was made of — this is the reprint of that bank,
 * uncatalogued for `facsimileForReadStep`'s reasons, and left behind it would be
 * a whole PDF in `generated/` describing pages nothing in this project reads any
 * more. `planSweep` takes its rotated predecessors with it, which is where a
 * re-read that replaced this same step left its earlier reprints.
 *
 * THE EXISTENCE TEST EARNS ITS STAT. A reading from before the facsimile landed
 * automatically, one whose facsimile failed, one whose facsimile was rotated
 * aside: all of them are rows with no reprint at this name, and a path in either
 * list for a file that was never made would be this app naming debris it invented.
 */
async function castsAmong(
  dir: string,
  manifest: ProjectManifest,
  removed: readonly LedgerStep[],
): Promise<string[]> {
  const casts: string[] = [];
  for (const step of removed) {
    const named = step.action === 'read' ? facsimileForReadStep(manifest, step) : null;
    if (named === null) continue;
    const cast = path.join(dir, ...named.split('/'));
    if (await exists(cast)) casts.push(cast);
  }
  return casts;
}

/*
 * `banksAmong` MOVED TO shared/ledger.ts AS `orphanedBanks`, beside
 * `orphanedPayloads`, whose question it is a second half of: what does this delete
 * actually take off the disk? It is a pure map from a decided deletion to a list
 * of paths — no directory, no filesystem — and it decides whether hours of GPU are
 * destroyed, which is exactly the code this app keeps where a test can reach it
 * (see that module's header). `destroyedBy` went with it for the same reason.
 */

/**
 * What the sweep will take besides the payloads, as one sentence — or null.
 *
 * A CONFIRM MAY NOT DESTROY SOMETHING IT DID NOT NAME. What is left in here after
 * the working trees went (docs/RENDERER.md §7) is the versions earlier runs
 * rotated aside — they belong to a payload above and to nothing else (`planSweep`
 * is the argument), so leaving them would leave bytes nothing in the app can
 * reach, and taking them silently would be the app erasing an earlier reprint
 * while asking about a row in a list.
 *
 * NULL FOR THE ORDINARY CASE, which is most of them: a curation snapshot is one
 * file, and a reading nobody re-read has nothing beside it. A sentence that
 * appeared every time and usually said "and nothing else" is a line people learn
 * to skip.
 */
function sweptBelongings(sweeps: readonly Sweep[]): string | null {
  let versions = 0;
  for (const sweep of sweeps) versions += sweep.archivedVersions;
  if (versions === 0) return null;
  const said = versions === 1
    ? 'one earlier version an earlier run rotated aside'
    : `${versions} earlier versions earlier runs rotated aside`;
  return `It also takes ${said}. Those belong to the files above and nothing else in this project `
    + 'names them.';
}

/** The two names a refusal about one step has to be able to say out loud. */
export interface StepSubject {
  /** The directory, resolved and PROVEN to be one this app may delete inside. */
  dir: string;
  /** The project as its owner knows it — the book's title, never the key. */
  title: string;
  /** The step as the row on screen says it: "Read (317 pages)". Never a file. */
  label: string;
}

/**
 * Who a step delete is about — for a caller with a refusal of its own to compose.
 *
 * ── Why this is not `inspectProject` ────────────────────────────────────────
 *
 * The delete card's inventory measures every byte under the project and streams
 * every bank in it to count pages, which is right for a dialog somebody opened on
 * purpose and absurd for composing one sentence about a job in the shelf. This is
 * the cheap half: one catalogue read, which is a few kilobytes.
 *
 * ── And why the two names travel together ───────────────────────────────────
 *
 * A refusal has to be actionable, and "a job is running, so this cannot be
 * deleted" is not — the person is looking at a list of steps and a shelf of jobs
 * and has to be told which of each. Both facts come out of the one manifest read
 * that proves the directory, so there is no arrangement where a caller has one
 * and has to go back for the other.
 *
 * ── THE PERMANENT REFUSAL IS RUN FIRST, AND THAT IS THE POINT OF THE NAME ───
 *
 * `deleteSubtree` is called for its refusal and its answer thrown away, exactly as
 * `describeStepDelete` calls it. The order matters to the person reading the
 * sentence: the origin can NEVER be deleted, and telling somebody to cancel a job
 * and come back — about a step that will refuse them just as firmly in an hour —
 * is a sentence that wastes their afternoon. A transient refusal must never be
 * said in front of a permanent one.
 *
 * `stepOf` refuses an id this project does not hold, by name, which is the right
 * answer for a renderer naming a row nobody drew.
 */
export async function deletableStep(dir: string, stepId: string): Promise<StepSubject> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  deleteSubtree(ledger, stepId);
  return { dir: resolved, title: manifest.title, label: stepOf(ledger, stepId).label };
}

/**
 * Take a step and everything made from it, off the ledger and off the disk.
 *
 * ── The order, which is the only interesting decision here ──────────────────
 *
 * THE MANIFEST GOES FIRST. Between the two writes there is a window, and it can
 * only fall one of two ways: files on disk that nothing names, or rows naming
 * files that are gone. The second is the survivable one — `summarise` already
 * draws a document whose file is missing, marked missing, so a person can see
 * what happened and act — while the first is a folder quietly holding hours of
 * GPU that no screen in this app will ever mention again. So the record of the
 * decision lands first, and the unlinking follows it.
 *
 * A FILE THAT WILL NOT DELETE IS A NAMED CONSOLE LINE AND NOT A THROW, for the
 * same reason: by the time it is reached the delete has happened as far as this
 * app's own bookkeeping is concerned, and rejecting the call would tell the user
 * their delete failed while leaving it done. What is left behind is one stray
 * file, named, in a folder they can open.
 *
 * WHAT IS DESTROYED IS `orphanedPayloads` AND NOT "the removed steps' payloads".
 * Two steps are allowed to name one file and in this app routinely do — see that
 * function for the re-read that leaves two `read` steps pointing at one bank.
 *
 * ── AND THE PER-TYPE ROW GOES IN THE SAME BREATH ────────────────────────────
 *
 * `manifest.documents` is the other record of the same files — the chains Home's
 * document rows are drawn from — and a delete that struck the ledger and left
 * those alone gave the user a row for a file it had just erased, drawn as
 * `missing`: the app's way of saying "something happened to a file you still
 * have" about the one thing they had deliberately thrown away. So `chainsWithout`
 * strikes them, from `orphanedPayloads` for the same reason the unlinking is —
 * what a surviving step still names is still on disk and is still a true row.
 *
 * IN THIS TRANSACTION, not a second one. Both edits are made against the open
 * manifest and land in ONE `writeManifest`, so there is no window where a crash
 * could leave the two records disagreeing about what this project has. The window
 * that does remain is the one below — rows written, files not yet unlinked — and
 * it falls the survivable way on purpose.
 *
 * ── AND THE PAYLOAD'S OWN BELONGINGS GO WITH IT ─────────────────────────────
 *
 * `planStepSweep` is the rest of the delete, and its comment is the argument: a
 * translation's EPUB has a working tree unpacked from it and an undo ledger named
 * after that tree, and a delete that took the row and the file and left those
 * behind left a directory of somebody's markup that nothing in the app can reach.
 * The tree's manifest row goes in the same transaction as the ledger surgery, for
 * the reason the chains do — a row naming a directory that is not there is the
 * exact state `rotateGenerated` is careful never to leave.
 *
 * ── AND A BANK'S HALF-FINISHED REPLACEMENT GOES WITH THE BANK ───────────────
 *
 * A re-read writes into `<bank>.pending` and swaps it over the real file only on
 * success, so a run that died leaves that pending file and its request sidecar
 * beside the bank as resumable debris (docs/BANK-LIFECYCLE.md §2). NO STEP NAMES
 * THEM — steps are minted on success and success is when the pending file stops
 * existing — so `orphanedPayloads` cannot find them and they would sit in
 * `readings/` forever after the bank they were replacing was deleted. Debris whose
 * bank is gone is debris about nothing. `orphanedBanks` decides which files are
 * banks, from the step's own action, and `planStepSweep` adds the pair.
 *
 * ── AND A TRANSLATION'S BANK IS THE SAME ARGUMENT ABOUT A DIFFERENT FILE ────
 *
 * A translate step's payload is the EPUB; the answers it was assembled from are in
 * the bank beside it, named by `params.bank` and by no step's payload anywhere. So
 * `orphanedPayloads` cannot find that either, and deleting the English translation
 * used to leave its whole per-block record in `readings/` — the same hours of GPU,
 * kept for a row that no longer exists. It is destroyed with the step, guarded by
 * the same whole-path check against what every surviving step MEANS by its bank
 * (recorded, or composed from its language for a translation that predates the
 * record), and its own pending file goes with it.
 *
 * A QUEUED JOB ABOUT TO RESUME ONE CANNOT LOSE IT TO THIS, and there is no new
 * mechanism for that: `refuseBusyStepDelete` (electron/ipc.ts) already refuses a
 * step delete while ANY held, queued or running job writes into this project —
 * deliberately coarse, on `refuseBusyJob`'s own argument that a narrower test
 * would have to predict where a run that has not started will write. Both IPC
 * doors ask it, the describe and the delete, so the card is never drawn for
 * something the click would refuse.
 */
export async function deleteStep(dir: string, stepId: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const { ledger, orphans, sweeps } = await withManifest(resolved, async (manifest) => {
    const deletion = deleteSubtree(ledgerOf(manifest), stepId);
    const banks = new Set(orphanedBanks(deletion, manifest.key));
    const destroyed = destroyedBy(deletion, manifest.key);
    const planned = await planStepSweep(resolved, destroyed, banks, manifest, deletion.removed);
    manifest.ledger = deletion.ledger;
    manifest.documents = chainsWithout(manifest.documents, destroyed);
    await writeManifest(resolved, manifest);
    return { ledger: deletion.ledger, orphans: destroyed, sweeps: planned };
  });
  for (const payload of orphans) {
    try {
      await destroyPayload(resolved, payload);
    } catch (err) {
      console.error(
        `[projects] ${path.basename(resolved)}: ${payload} was deleted from this project's history `
        + `and could not be removed from the disk (${(err as Error).message}). Nothing in Foundry `
        + 'names that file any more; it is still in the project folder.',
      );
    }
  }
  // `force: true` throughout and no throw, for `deleteDocument`'s reason and this
  // function's own: by the time this runs the delete has happened as far as the
  // catalogue is concerned, and failing the call would tell the user their delete
  // did not work while leaving it done.
  for (const sweep of sweeps) {
    for (const target of sweep.files) await fsp.rm(target, { force: true });
    // An `archived-<stamp>/` folder that held nothing but this payload's past goes
    // with it. Emptiness is the test rather than "we emptied it", because one
    // rotation folder can hold several documents stamped in the same second.
    for (const archive of sweep.archives) {
      try {
        const left = await fsp.readdir(archive);
        if (left.length === 0) await fsp.rmdir(archive);
      } catch { /* already gone, or not ours to force */ }
    }
  }
  announceProjects();
  return { ledger, rows: chronological(ledger) };
}

/**
 * A curation commit: the snapshot is already written, this is the step for it.
 *
 * The file work is `electron/overlays.ts`'s, which owns every other write to a
 * curation and its per-file serialisation; the manifest surgery is this module's,
 * because all of it happens behind `withManifest`. The split is the same one
 * `recordGenerated` draws — the engine writes the file, the catalogue learns
 * about it here.
 *
 * NO CAPTURED PARENT, and none is possible: a commit is not a queue job. It
 * happens the instant the user presses Save, so there is no gap between the
 * gesture and the recording for a pointer move to slip through, and the position
 * now IS the position they pressed it from.
 *
 * AND THE POSITION IS STILL THAT ONE AFTERWARDS. A save is retained beside where
 * you are standing rather than under it (`RETAINED_BESIDE_YOU`, shared/ledger.ts),
 * so nothing here has to remember not to move the pointer: `appendStep` already
 * knows what a curate step does to it, which is the point of putting the rule in
 * the ledger rather than at this call site.
 */
export async function recordCuration(
  dir: string,
  payload: string,
  params: LedgerParams,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
    const landing = await landStep(manifest, {
      action: 'curate',
      parent: null,
      payload,
      params,
      createdAt: Date.now(),
    });
    if (landing === null) {
      throw new ProjectError(
        `${path.basename(resolved)} has no recorded history for a save to be made from — this app `
        + 'has no record of the document it was built on, so there is no step to hang a curation off. '
        + 'Opening the book from Home imports it and gives this project an origin.',
      );
    }
    await writeManifest(resolved, manifest);
    return landing.ledger;
  });
  announceProjects();
  return { ledger, rows: chronological(ledger) };
}

/**
 * A metadata edit: the patch is already written, this is the step for it.
 *
 * ── What was missing, in one sentence ───────────────────────────────────────
 *
 * The dialog wrote a title into the open document and nothing else learned it had
 * happened — no row, no announce, and an export that silently lost the edit,
 * because an export is cast fresh from the bank and a working tree's package is
 * not one of its inputs. This is the durable half. The write to the live document
 * STAYS exactly where it was: the user has to see the correction at once, and the
 * step is what makes it survive into everything made afterwards.
 *
 * THE SAME SHAPE AS `recordCuration` ABOVE, down to the reasons. The file work is
 * the caller's (main writes the patch, then calls this — file before step, the
 * rule `commitOverlay` states in full); the manifest surgery is this module's,
 * because all of it happens behind `withManifest`.
 *
 * NO CAPTURED PARENT, and none is possible: an Apply is not a queue job. It
 * happens the instant the user presses the button, so there is no gap between the
 * gesture and the recording for a pointer move to slip through.
 *
 * AND THE POSITION IS STILL THAT ONE AFTERWARDS (`RETAINED_BESIDE_YOU`), for the
 * reason a save is: the document in front of the user already carries the new
 * values, so there is no new state to go and stand in, and a pointer that moved
 * would take the block editor read-only as the reward for correcting a name.
 */
export async function recordMetadata(
  dir: string,
  payload: string,
  params: LedgerParams,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
    const landing = await landStep(manifest, {
      action: 'metadata',
      parent: null,
      payload,
      params,
      createdAt: Date.now(),
    });
    if (landing === null) {
      throw new ProjectError(
        `${path.basename(resolved)} has no recorded history for a metadata edit to be filed against `
        + '— this app has no record of the document it was built on, so there is no step to hang one '
        + 'off. Opening the book from Home imports it and gives this project an origin.',
      );
    }
    await writeManifest(resolved, manifest);
    return landing.ledger;
  });
  announceProjects();
  return { ledger, rows: chronological(ledger) };
}

/**
 * An Apply on the book: the ops file is already written, this is the step for it.
 *
 * THE SAME SHAPE AS `recordCuration` AND `recordMetadata` ABOVE, down to the
 * reasons. The file work is the caller's (electron/book.ts writes the ops
 * atomically and then calls this — file before step, always, because a row naming
 * a payload that failed to write is a row describing nothing); the manifest
 * surgery is this module's, because all of it happens behind `withManifest`.
 *
 * NO CAPTURED PARENT, and none is possible: an Apply is not a queue job. It
 * happens the instant the button is pressed, so there is no gap between the
 * gesture and the recording for a pointer move to slip through — and the position
 * now IS the position they pressed it from. Which is also the whole of
 * "branch-on-edit-at-old-step": `landStep` parents the row at the position and
 * `appendStep` appends, so editing while standing three rows back mints a child of
 * THAT row and leaves everything below it exactly where it was. Nothing here does
 * anything about branching, because branching is what appending already is.
 *
 * AND THE POSITION MOVES ONTO IT AFTERWARDS, which is where this parts company
 * with the two functions above it. `RETAINED_BESIDE_YOU` says so once, in the
 * ledger, and `appendStep` obeys it — see that table's `edit` entry for why the
 * pointer must follow here where it must not follow a save.
 *
 * THE STEP ID IS AN ARGUMENT because the caller has already spent it: the ops file
 * is named after this step (`opsPayloadFor`), so minting a second one here would
 * leave the file named after a row nobody created. `ReadRequest.stepId`'s
 * arrangement exactly, and `landStep` spends it only on an append — which is every
 * time, since `reRunTarget` cannot reach an irreplaceable step.
 */
export async function recordBookEdit(
  dir: string,
  payload: string,
  params: LedgerParams,
  stepId: string,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
    const landing = await landStep(manifest, {
      action: 'edit',
      parent: null,
      payload,
      params,
      createdAt: Date.now(),
      id: stepId,
    });
    if (landing === null) {
      throw new ProjectError(
        `${path.basename(resolved)} has no recorded history for these changes to be filed against — `
        + 'this app has no record of the document it was built on, so there is no step to hang them '
        + 'off. Opening the book from Home imports it and gives this project an origin.',
      );
    }
    await writeManifest(resolved, manifest);
    return landing.ledger;
  });
  announceProjects();
  return { ledger, rows: chronological(ledger) };
}

/**
 * AMEND the tip edit step's own file to a new list — the manifest half of
 * `amendBookOps` (electron/book.ts, which owns the ruling and the refusals'
 * argument).
 *
 * THE TIP IS PROVED INSIDE THE MANIFEST LOCK, which is the whole reason this is
 * here rather than in book.ts: whether the position is still an amendable tip is
 * a fact that can change between a pane's load and its Apply (a translate
 * landing makes a child), and the only place the answer cannot move again before
 * the write is under `withManifest`. The ops file is rewritten atomically FIRST,
 * then the count on the step — a crash between the two leaves a file that says
 * more or less than the label counts, which the next open reads correctly
 * anyway, because the file is the truth and the count is a label.
 */
export async function recordBookEditAmend(
  dir: string,
  bytes: string,
  count: number,
): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const ledger = await withManifest(resolved, async (manifest) => {
    const held = ledgerOf(manifest);
    const standing = positionOf(held);
    if (standing === null || standing.action !== 'edit') {
      throw new ProjectError(
        'The changes could not be added to the step you are standing on — it is not a row of '
        + 'applied changes. Press Apply again and they land as a step of their own.',
      );
    }
    if (held.steps.some((step) => step.parent === standing.id)) {
      throw new ProjectError(
        'Something has been made from the step you are standing on since the book was opened, so '
        + 'its changes are history now and cannot be rewritten. Press Apply again and the new '
        + 'changes land as a step of their own.',
      );
    }
    await writeAtomically(
      path.join(resolved, ...standing.payload.split('/')),
      Buffer.from(bytes, 'utf8'),
    );
    const row = manifest.ledger?.steps.find((step) => step.id === standing.id);
    if (row !== undefined) row.params = { ...row.params, ops: count };
    await writeManifest(resolved, manifest);
    return ledgerOf(manifest);
  });
  announceProjects();
  return { ledger, rows: chronological(ledger) };
}

/**
 * THE PATCH EVERY PRODUCT MADE FROM THIS POSITION CARRIES — the chain, read off
 * the disk and merged.
 *
 * ── Where the split falls, and why it falls there ───────────────────────────
 *
 * The WALK and the MERGE are pure and live in shared/ledger.ts, where a test can
 * reach the rule that decides whose title a book ends up with. What is here is
 * the part that cannot be: opening the payload files. Each one is a few hundred
 * bytes and a project holds a handful, so this is cheap enough to ask on the way
 * into every export.
 *
 * A PATCH THAT WILL NOT READ IS A NAMED CONSOLE LINE AND NOT A THROW. The step
 * says an edit happened and the file behind it is unreadable — that is worth
 * seeing in a terminal, and it is not worth failing an export somebody is waiting
 * on: the book comes out carrying every other correction, which is strictly more
 * of what they asked for than no book at all.
 */
export async function metadataForProduct(
  dir: string,
  kind: MetadataPatch['kind'],
  /** The step the job captured at enqueue, or null for the position now. */
  from: string | null = null,
): Promise<Record<string, string>> {
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    // A catalogue that will not parse says nothing about metadata either. The
    // run that is about to happen has its own reasons to fail or not; this is not
    // one of them.
    return {};
  }
  const patches: MetadataPatch[] = [];
  for (const step of metadataInEffect(ledgerOf(manifest), from)) {
    // Project-relative with forward slashes, split on its own separator and
    // joined for this platform — never matched by basename, which is the rule a
    // project holding several `<uuid>.json` files under different folders makes
    // load-bearing.
    const file = path.join(dir, ...step.payload.split('/'));
    try {
      // `readJson` for the byte-order mark, which is what it is for: a patch
      // file a person opened in an editor and saved again comes back with one,
      // and `JSON.parse` on those bytes fails on the first character.
      const read = readJson(await fsp.readFile(file, 'utf8')) as MetadataPatch | null;
      if (read === null || (read.kind !== 'epub' && read.kind !== 'pdf')
        || typeof read.fields !== 'object' || read.fields === null) {
        console.error(
          `[projects] ${path.basename(dir)}: the record behind “${step.label}” is not a metadata `
          + 'patch, so that edit is not being applied to what is being made.',
        );
        continue;
      }
      patches.push({ kind: read.kind, fields: read.fields });
    } catch (err) {
      console.error(
        `[projects] ${path.basename(dir)}: the record behind “${step.label}” could not be read `
        + `(${(err as Error).message}), so that edit is not being applied to what is being made.`,
      );
    }
  }
  return mergedMetadata(patches, kind);
}

/**
 * The position of this project, or null when it has no history — the fact a job
 * captures at ENQUEUE.
 *
 * NEVER THROWS. A catalogue that will not parse is a project whose next action
 * cannot be filed against anything, and refusing to queue a three-hour reading
 * because a JSON file is malformed would be this bookkeeping deciding whether the
 * user gets to read their book. Null lands on `landStep`'s fallback, which is the
 * position at the moment the run comes home.
 */
export async function positionStepId(dir: string): Promise<string | null> {
  try {
    return positionOf(ledgerOf(await readManifest(dir)))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The bank a rendering AT THE POSITION is made from — the step's own file.
 *
 * ── The row that rendered somebody else's reading ───────────────────────────
 *
 * `readings/<key>.jsonl` was composed from the project key at every call site, on
 * the belief that a project has one bank. It does not: a re-read asking for a
 * different page range BRANCHES by design (`MINTED_BY_THE_RUN`), so a project can
 * hold two `read` steps — and while both composed the same path, standing on the
 * older one and pressing Generate rendered the newer reading. The row named a
 * bank that had been written over from under it and nothing on screen said so.
 *
 * So the plan asks the row: `readingInEffect` walks up from the position to the
 * reading this branch of the story is about, and its payload is the answer. The
 * exact shape `renderingOverlay` above already has, for the same reason — the
 * pointer decides which of several files a run is handed, and composing one from
 * the key is a second opinion about a question the ledger has already answered.
 *
 * THE COMPOSED PATH IS THE FALLBACK AND IT IS NOT A LEGACY BRANCH. Every project
 * that existed before per-step paths has one read step whose payload IS
 * `readings/<key>.jsonl`, so those go through the ledger like everything else and
 * no file on any disk moves. What falls back here is a project with no reading at
 * all — and a position standing on the import, the revert row, which is about the
 * untouched original rather than about any bank.
 */
export function readingBank(
  dir: string,
  manifest: ProjectManifest,
  /**
   * THE STEP TO WALK UP FROM, when a plan is about one step rather than about the
   * position — a save's own book, a translation's own book.
   *
   * Both of those are cast by a LANDING, and a landing runs while the pointer is
   * wherever the person happens to be standing. In practice the answer is nearly
   * always the same bank, because a project holds one reading; it stops being the
   * same one the moment a re-read branches, and then a cast keyed to a step under
   * one reading would replay the other one's pages. The argument is
   * `planFacsimile`'s, in full.
   */
  at: LedgerStep | null = null,
): string {
  const reading = readingInEffect(ledgerOf(manifest), at);
  return reading === null
    ? path.join(dir, READINGS, `${manifest.key}.jsonl`)
    : path.join(dir, ...reading.payload.split('/'));
}

/** The same answer for a caller that has not read the catalogue yet. */
export async function bankForPosition(dir: string): Promise<string> {
  return readingBank(dir, await readManifest(dir));
}

/**
 * WHERE THE BOOK FILE IS — the bank's own path with `.book` in front of its
 * extension, and the whole of the app's knowledge of that spelling.
 *
 * ── Why it is derived from the bank and not composed from the key ───────────
 *
 * For `readingBank`'s reason exactly, one layer up: a project can hold two banks
 * (a re-read asking for a different page range branches by design), and a book
 * file composed from the project key would be the reflow of whichever reading
 * happened to be newest, filed under the row somebody is standing on. The bank at
 * the position is the answer to "which reading is this branch of the story
 * about"; the book file is that bank, reflowed, so it is named after it and can
 * never drift from it.
 *
 * IT REFUSES A BANK THAT IS NOT A `.jsonl` rather than appending to whatever it
 * was given. There is no second spelling to fall back to and guessing one would
 * put the reflow of somebody's reading in a file nothing will ever look for
 * again — the engine writes banks as JSONL and nothing else does.
 */
export function bookFileFor(bank: string): string {
  if (!bank.toLowerCase().endsWith('.jsonl')) {
    throw new ProjectError(
      `${bank} is not a readings bank — those are the .jsonl files the engine writes, and the `
      + 'book file is named after one. Refusing to guess at where the book would live.',
    );
  }
  return `${bank.slice(0, -'.jsonl'.length)}.book.jsonl`;
}

/**
 * WHERE A TRANSLATION'S OWN BOOK FILE IS — its records file with `.book` where
 * `.records` was, and the whole of the app's knowledge of THAT spelling.
 *
 * ── Why it is named after the records and not after the bank ────────────────
 *
 * `bookFileFor` above names the reading's reflow after the bank it is a pure
 * function of. This one is the same idea one transform along: when a translate
 * lands, main materialises `parent book file + chain ops + records` into a
 * DERIVED book file (docs/RENDERER.md §4), and the one input of those three that
 * is unique to this step is the records file — which is also the step's payload,
 * so the file is named after the row that owns it and can never drift from it.
 * `readings/<key>.hu.records.jsonl` becomes `readings/<key>.hu.book.jsonl`, and a
 * branch's `<key>.hu.<id8>.records.jsonl` becomes `<key>.hu.<id8>.book.jsonl`:
 * one translation, one book, no collision with the reading's own `<key>.book.jsonl`
 * because the language tag is always between them.
 *
 * IT REFUSES ANY OTHER SPELLING, on `bookFileFor`'s rule and for its reason. A
 * translate step made before records kept its words inside an EPUB in
 * `generated/` (`translationRecordsOf` answers null for one), and appending
 * `.book.jsonl` to whatever it was handed would put a derived book beside a book,
 * named after nothing, that no sweep would ever find again.
 */
export function translationBookFileFor(records: string): string {
  const suffix = '.records.jsonl';
  if (!records.toLowerCase().endsWith(suffix)) {
    throw new ProjectError(
      `${records} is not a translation's records file — those are the .records.jsonl files the `
      + 'engine writes, and the derived book is named after one. Refusing to guess at where the '
      + 'translated book would live.',
    );
  }
  return `${records.slice(0, -suffix.length)}.book.jsonl`;
}

/**
 * WHERE THE BOOK'S CUT FIGURES ARE — the bank's own path with `.images` in place
 * of its extension, and the whole of the app's knowledge of that spelling.
 *
 * A MIRROR OF THE ENGINE'S `imagesDir` (src/vlm/book-run.ts), on shared/book.ts's
 * grow-together rule: the engine cuts the figures beside the bank they were cut
 * out of the answers of, a book row names its crop by NAME and never by path
 * (docs/BOOK-FILE.md §6), and this is where the app turns the name back into a
 * file. Derived from the bank for `bookFileFor`'s reason exactly — a project can
 * hold two banks, and each reading's figures belong to it.
 */
export function imagesDirFor(bank: string): string {
  if (!bank.toLowerCase().endsWith('.jsonl')) {
    throw new ProjectError(
      `${bank} is not a readings bank — those are the .jsonl files the engine writes, and the `
      + 'figure directory is named after one. Refusing to guess at where the images would live.',
    );
  }
  return `${bank.slice(0, -'.jsonl'.length)}.images`;
}

/**
 * The bank at the position and the book file made from it, with the directory
 * PROVEN to be one of Home's projects first.
 *
 * THE GATE IS `deletableProjectDir`'s, on the step-ledger family's rule: every
 * call that takes a directory named by the renderer asks the same question, so
 * that none of them is the lenient way in. This one only reads — but what it
 * reads is handed to a SPAWN of the engine with `--out` pointed at the answer
 * (electron/book.ts), and a path this process never agreed to is not a path
 * anything gets to write into.
 *
 * The manifest rides back with it because every caller needs it anyway — the
 * project's title is the only thing the book file itself cannot say.
 *
 * THE PDF AND THE LANGUAGE RIDE BACK TOO, because the reflow takes both
 * (`vlm-book --pdf --language`) and both are this module's facts: the archived
 * original is `archive/<manifest.archive.file>` — named only where the archive
 * IS a PDF, because the figure crops are cut out of pages and an archived EPUB
 * has none — and the language is what the reading in effect at the position
 * declared when it ran. Null for either is an ordinary answer the engine has a
 * documented behaviour for (no figures cut and says so; language defaults),
 * not a hole this side papers over.
 *
 * AND SO DOES THE READING ITSELF, which is one line here and stops a second
 * opinion elsewhere. Everything above is derived from that one step — the bank
 * is its payload and the language is its param — so a caller that needs the ROW
 * as well (the read landing, which names that reading's facsimile after it) must
 * not go and ask the ledger a second time for the step these answers came out
 * of. Two reads of one catalogue is two answers the moment anything lands in
 * between. Null is the honest answer for a project with no reading on the path,
 * and it is what makes `bank` above a composed fallback rather than a payload —
 * a caller that must be sure it is holding a real reading tests for it.
 *
 * `at` IS `readingBank`'s OWN PARAMETER, PASSED THROUGH, and it exists here for
 * its reason: a landing works on ONE STEP while the pointer is wherever the
 * person happens to be standing. A translation's derived book file is
 * materialised at the moment the run lands (docs/RENDERER.md §4), by which time
 * somebody may have clicked onto a branch under a different reading — and a book
 * built for that step out of this position's bank would be the other reading's
 * pages under that step's name. Null and absent both mean the position, which is
 * what every viewer asks.
 */
export async function bookAtPosition(dir: string, at: LedgerStep | null = null): Promise<{
  dir: string;
  manifest: ProjectManifest;
  reading: LedgerStep | null;
  bank: string;
  book: string;
  pdf: string | null;
  language: string | null;
  epub: string | null;
  receipt: string;
}> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const bank = readingBank(resolved, manifest, at);
  const reading = readingInEffect(ledgerOf(manifest), at);
  const language = reading?.params?.language ?? null;
  const pdf = manifest.archive !== null && manifest.archive.kind === 'pdf'
    ? path.join(resolved, ARCHIVE, manifest.archive.file)
    : null;
  /*
   * THE ARCHIVED EPUB, WHEN THERE IS ONE AND NOTHING HAS BEEN READ — the other
   * thing a book can be made of (docs/RENDERER.md §6, the refinement paragraph:
   * an EPUB is never OCR'd into a bank, `book = f(epub)`).
   *
   * `reading === null` IS PART OF THE TEST AND IS NOT DEFENSIVE. A project's
   * origin never changes, so `archive.kind === 'epub'` alone would answer "explode
   * the container" for every position in the project, including one standing under
   * a reading somebody had made of it — and that reading's bank is the receipt of
   * ITS book. The two routes are decided by which record the position is about,
   * which is exactly what `readingInEffect` answers.
   */
  const epub = reading === null && manifest.archive !== null && manifest.archive.kind === 'epub'
    ? path.join(resolved, ARCHIVE, manifest.archive.file)
    : null;
  return {
    dir: resolved,
    manifest,
    reading,
    bank,
    /*
     * THE BOOK FILE IS `readings/<key>.book.jsonl` EITHER WAY, and that is not a
     * coincidence to be tidied up. `readingBank` composes `readings/<key>.jsonl`
     * for a project with no reading on the path — a file that never exists for an
     * EPUB project — and `bookFileFor` turns it into the name the book wears. So
     * an exploded book lands in `readings/` beside where a reflowed one would,
     * `imagesDirFor` finds its figures at `readings/<key>.images/` by the same
     * derivation, and the engine reaches the same directory from `--out`
     * (`epubImagesDir`, src/vlm/epub-explode.ts). One spelling, three readers.
     */
    book: bookFileFor(bank),
    pdf,
    language: typeof language === 'string' && language.length > 0 ? language : null,
    epub,
    /*
     * WHAT THE BOOK FILE'S `source.bankSha` IS A HASH OF — the receipt, named, so
     * that the one integrity check in the app has one thing to open. For a read
     * project that is the bank; for an imported EPUB it is the container itself,
     * which is the receipt in exactly the bank's sense: immutable, archived, and
     * the thing the book is a pure function of (docs/BOOK-FILE.md §2).
     */
    receipt: epub ?? bank,
  };
}

/**
 * WHICH DOCUMENT THE PANES SHOW AT THE POSITION — the last third of the pointer's
 * promise, and the one that was never built.
 *
 * ── What clicking a row did, and what the user said about it ────────────────
 *
 * `positionView` already decided the block editor's MODE and which corrections
 * are drawn, and `b61bfab` wired both of those to a pointer move. What it never
 * touched was WHICH FILE was under them: `Tab.path` is fixed when a document is
 * opened from the documents panel and nothing else ever moved it. So a project
 * holding both `archive/<scan>.pdf` and the reprint made from its reading showed
 * exactly one of them however many rows the user clicked — *"switching between
 * steps doesnt switch between the original pdf and the rendered facsimile like i
 * expected"* — and when the app had nothing it could change it said so, which is
 * the other half of the same complaint: *"instead of showing the document, it gave
 * me an error saying it couldnt show the document… it should be showing me
 * document"*.
 *
 * ── Why the resolution is HERE and not in the renderer ──────────────────────
 *
 * Because composing a project path in the renderer is how a branch read ends up
 * answering for the original reading's file. It is the same rule that put
 * `readingBank` and `renderingOverlay` in this file rather than at their call
 * sites: the pointer decides which of several files a surface is handed, and a
 * second opinion composed from the project key is a lie the moment a project holds
 * two of anything. Main also has to ADMIT the path to the viewer's allow-list
 * (electron/documents.ts, `admit`), which the renderer cannot do for itself and must
 * not be
 * able to.
 *
 * ── The four rows ───────────────────────────────────────────────────────────
 *
 * A ROW THAT RETAINED A DOCUMENT SHOWS IT (`PositionView.own`): the import shows
 * the untouched original, a translation shows the book in the other language.
 * Nothing is walked and nothing is composed — the step's own payload, resolved
 * against the project directory.
 *
 * A READ OR A SAVE SHOWS THE BOOK CAST FROM THAT READING — the flowing document,
 * which is `generated/<stem>.epub`. That is a rendering rather than a payload
 * (renderings are deliberately not steps — STEP-LEDGER.md "Decided" #4), so it is
 * answered by asking the project what it holds.
 *
 * ── This is the seam moving, exactly where it was said it would ─────────────
 *
 * It used to answer the live PDF — `working/<stem>.pdf` — and that was the honest
 * answer while the PDF was the only surface anything could edit. It stopped being
 * honest the moment a reading landed with a book beside it: the user clicked the
 * OCR row expecting the thing the reading MADE and got the photograph it was made
 * from. Their own words for the whole shape of it: "from that bank, we create an
 * html page of the document - a proto epub. that's the step that appears
 * automatically the moment i OCR something. i can now either click back to step 1,
 * which shows the original pdf, or i can click the ocr step, which shows the PDF
 * in html/epub form."
 *
 * The proto-epub is not a new artefact this had to wait for. It is
 * `vlm-convert --format epub` over the bank — deterministic, every block stamped,
 * already the thing select mode strikes and relabels — and the queue now casts one
 * the instant a reading lands (electron/job-queue.ts). This function is where that
 * cast becomes what a row SHOWS. The PDF keeps the import row and nothing else:
 * facsimile and stop (docs/DERIVED-BOOK.md §1).
 *
 * ── `generated/` and not a working copy, which is the opposite of the old rule ─
 *
 * A PDF has a live copy in `working/` and an EPUB does not: a book's working copy
 * is the TREE unpacked from its origin, made on open by the epub reader, and the
 * file a pane is pointed at is the origin the tree comes from
 * (`liveCopyOf` already says this for the import row). So aiming at `generated/`
 * here is aiming at the same layer every EPUB in this app is opened from, not at a
 * layer nothing edits — and there is no second document with the same basename to
 * collide with, because the book and the scan differ by extension.
 *
 * ── Two limitations, named rather than engineered around ────────────────────
 *
 * NOTHING RECORDS WHICH READING A CAST WAS MADE FROM. Renderings are not steps and
 * are not going to become steps, so a project with two `read` rows (a re-read
 * asking for a different page range branches — `MINTED_BY_THE_RUN`) has one cast
 * book and two rows that would both claim it. Both get it — the newest cast, which
 * is the one the newest reading left. That is wrong for at most one of them, and
 * the alternative is provenance bookkeeping for a file phase B replaces
 * (docs/DERIVED-BOOK.md §6).
 *
 * AND A CURATE ROW SHOWS ITS OWN CAST, WHICH IS THE DEFERRAL ABOVE, BUILT. It
 * used to show the project's ONE cast — so every save in a book's history showed
 * the same document, the live tree wearing today's marks, and clicking an old save
 * showed you the present. A curate landing now casts its own book
 * (`curateCastFile`, shared/ledger.ts; the job is fired at the commit in main.ts)
 * and this is where that book becomes what the row shows.
 *
 * THE FALLBACK TO `castBook` IS NOT A LEGACY BRANCH. Every project curated before
 * this unit has saves with no cast of their own, and they go on showing the
 * project's cast exactly as they did — which is the honest answer for them, since
 * nothing else about that save was ever recorded. So does a save whose cast has
 * not landed yet: the job takes seconds, and a pane that showed nothing while it
 * ran would be worse than one showing the book it is about to replace.
 *
 * ── The fallback is the old answer, and it is not a legacy branch ───────────
 *
 * The cast is a queued job: it is planned the moment the reading lands and it
 * takes seconds, but there is a window where the row exists and the book does not,
 * and there are projects on disk read before anything cast automatically. Both get
 * the live PDF, which is what this function has always answered — the pages are
 * the same pages, and a pane showing the scan is the app doing its job while the
 * book is on its way.
 *
 * ── Null is an ordinary answer ──────────────────────────────────────────────
 *
 * A project with no reading yet, a row whose payload has been swept off the disk,
 * an EPUB-only project standing where a scan would be: all of them mean "this
 * position names no document of its own", and the panes correctly keep the one
 * they have rather than being sent somewhere. Proved to exist before it is
 * returned, because a path handed to a viewer for a file that is not there is a
 * blank pane with nothing on screen saying why.
 */
export async function documentAtPosition(dir: string): Promise<string | null> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const view = positionView(ledgerOf(manifest));
  if (view.step === null) return null;
  return await documentOfStep(resolved, manifest, view.step);
}

/**
 * THE SAME QUESTION ASKED OF A NAMED STEP — Compare's half of the resolve.
 *
 * ── Why a second door and not a second implementation ───────────────────────
 *
 * Compare (docs/PLAN.md §4, unit 8d) puts a READ-ONLY column beside the live one,
 * locked to a step the person picked out of the ledger's own rows. For a row whose
 * picture is the proof sheet that column asks `book:load-at`; for a row that has a
 * DOCUMENT — the import, a rendering — it needs the path, which is exactly what
 * `documentAtPosition` answers for the position. So the two share `documentOfStep`
 * below and differ only in how they name the row: one reads the pointer, one is
 * handed an id. A second copy of that table would be two answers to "what does
 * this row show", and the way that goes wrong is that Compare draws a different
 * document from the one clicking the row would have opened.
 *
 * A STEP THIS PROJECT DOES NOT HOLD IS NULL rather than a throw, and the
 * difference from `deletableStep` is deliberate. That gate is for a call that
 * DESTROYS something and refuses the origin by name; this one is a read, and an id
 * that has gone stale is the ordinary consequence of a delete landing between the
 * picker being drawn and the answer being asked for. Null is what the renderer
 * already treats as "this row names no document of its own", so a vanished step
 * and a sheet-shaped one take the same path and neither is a failure to report.
 *
 * THE ORIGIN IS ANSWERABLE HERE, which `deletableStep` would have refused: the
 * import row is the single most useful thing to compare a later step against —
 * *"is this what the scan actually said?"* — and it is a read, so nothing about
 * the retention rule is in question.
 */
export async function documentAtStep(dir: string, stepId: string): Promise<string | null> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const step = ledgerOf(manifest).steps.find((row) => row.id === stepId) ?? null;
  if (step === null) return null;
  return await documentOfStep(resolved, manifest, step);
}

/**
 * WHAT THIS ROW SHOWS, when it shows a file at all.
 *
 * The body `documentAtPosition` grew, lifted out whole when Compare needed to ask
 * it about a row nobody is standing on. Every branch below was written for the
 * position and every word of its reasoning survives the move unchanged, because
 * none of it was ever about the POINTER: it is about what a row of this action,
 * with this payload, in this project, is a picture of.
 *
 * `A_BOOK_OF_ITS_OWN` IS THE TEST, read here rather than taken off `positionView`.
 * That is the same table `view.own` is composed from (shared/ledger.ts), asked
 * directly because this function is handed a step and has no position to compose a
 * view around — and asking the table is what keeps the two doors from drifting
 * apart the day an action changes sides.
 */
async function documentOfStep(
  resolved: string,
  manifest: ProjectManifest,
  step: LedgerStep,
): Promise<string | null> {
  const view = { step, own: A_BOOK_OF_ITS_OWN[step.action] };

  if (view.own) {
    /*
     * ── A TRANSLATION'S BOOK IS CAST, BECAUSE THE RUN DID NOT WRITE ONE ───────
     *
     * A translate step retains its RECORDS — per-block answers in `readings/`,
     * the same shape and the same layer as a reading's bank — and nobody reads a
     * `.jsonl`. What the row shows is the book cast from those records
     * (`translationCastFile`, cast by the queue the moment the run lands), which
     * is a rendering: free, made again at any time, nobody's payload.
     *
     * ITS OWN PAYLOAD IS THE FALLBACK, AND ONLY FOR A ROW THAT PREDATES RECORDS —
     * which is what the `translationRecordsOf` test is doing and why it is not
     * merely an `onDisk` away. Those steps retain the EPUB the old EPUB→EPUB
     * translator wrote, so the payload is exactly the answer this function has
     * always given them and nothing about those projects changes. A RECORDS ROW'S
     * PAYLOAD IS ON DISK TOO, and it is a `.jsonl`: falling back to it would hand
     * a pane a file of sentences to open as a book, and `onDisk`'s existence test
     * would cheerfully agree that it is there.
     *
     * AND THE ANSWER IS NEVER THE PROJECT'S OWN FLOWING BOOK. Falling back to
     * `castBook` here would show the German book to somebody standing on the row
     * labelled *Translated (hu)* — which is the exact failure this table's own
     * history is about (`A_BOOK_OF_ITS_OWN`). Null is the honest answer and it is
     * now the ONLY answer this arm can give: a translate row is drawn on the proof
     * sheet out of the derived book its landing wrote, so there is no document at
     * this position for a viewer to be pointed at (docs/RENDERER.md §7).
     */
    if (view.step.action === 'translate') {
      return translationRecordsOf(view.step) === null
        ? await onDisk(resolved, view.step.payload)
        : null;
    }
    /*
     * THE ORIGIN IS THE ONE ROW WHOSE ANSWER CAN BE A COPY OF ITSELF, and saying
     * so here is what stops a pointless swap. A project nobody has generated
     * anything from has `working/<stem>.pdf` copied from `archive/<file>.pdf`
     * byte for byte, and an EPUB project works from the stamped copy in
     * `generated/` precisely because `archive/` is never addressed. Sending the
     * pane to the archive in either case would reload the viewer to show the same
     * pages, and for the EPUB it would show a book without the stamps every later
     * pass needs. Where the live copy is NOT the original's own copy — a reprint
     * has replaced it — the archive is the only place the untouched scan still is,
     * and that is what the revert row is for.
     */
    const live = view.step.action === 'import' ? await liveCopyOf(resolved, manifest, view.step.payload) : null;
    return await onDisk(resolved, live ?? view.step.payload);
  }

  /*
   * ── AND EVERY OTHER ROW NAMES NO DOCUMENT, WHICH IS THE WAVE LANDING ───────
   *
   * A read, a save, an edit: all three are drawn on the PROOF SHEET, out of the
   * book file and the ops chain that reaches this position (docs/RENDERER.md §3).
   * There is no file for a viewer to be pointed at, and there has not been one
   * since the per-step casts were deleted — this used to answer the save's own
   * cast, then the project's flowing book, then the live PDF, and all three of
   * those were the same claim: that the book is a document sitting in a folder.
   * It is not. `positionView.sheet` is what routes these rows, and null here is
   * how this side says so.
   */
  return null;
}

/**
 * STAND WHERE THIS DOCUMENT BELONGS — `documentAtPosition` run backwards, and the
 * two have to agree about every path either of them can name.
 *
 * ── The two selectors pretending to be one ──────────────────────────────────
 *
 * The library picked a FILE and the steps list picked a STEP, and the user found
 * the hole between them: *"i could have a document open, the epub, but have the
 * pdf import step selected, and id never know that i just ran translate against
 * the original pdf rather than the generated epub because i had the wrong step
 * selected, since the right document was open."* Every action in this app is made
 * from the POSITION — a reading's parent, a translation's source, what Export is
 * offered — so a pane showing one thing while the pointer stands on another is an
 * app that will quietly act on the file the person is not looking at. There is one
 * selection now, and focusing a document is one of the gestures that moves it.
 *
 * ── Why the mapping is HERE, beside the forward direction ───────────────────
 *
 * Because these are one fact read in two directions, and the day they disagree is
 * the day clicking a tab moves the pointer somewhere that then shows a different
 * file — a selection that fights the user. `documentAtPosition` is directly above;
 * everything this consults (`castBook`, `liveCopyOf`, the origin's payload) is
 * what that function consults, so a change to what a row SHOWS lands in the same
 * screen as what a document STANDS FOR.
 *
 * ── The four answers ────────────────────────────────────────────────────────
 *
 * AN EXPORT MOVES NOTHING. `final/` is where Save and Export write, and an export
 * is terminal by ruling — nothing is ever made from one (docs/WORKBENCH.md §1,
 * "it wont go into the working files as a step because it isnt the base for new
 * steps"). It has no step, so there is nowhere to stand, and yanking the pointer
 * to some plausible row because somebody glanced at a facsimile would be the app
 * inventing a selection out of a look.
 *
 * THE ORIGINAL STANDS ON THE IMPORT — its archived payload and the working copy
 * made from it, which are the two paths `documentAtPosition` answers for that row
 * and therefore the two that must come back to it. The live copy is asked for by
 * `liveCopyOf` rather than composed from `working/` and the stem: a working PDF
 * that came from somewhere else is a reprint that replaced the scan, and calling
 * that the import would stand the pointer on the untouched original for a document
 * the original is not.
 *
 * THE BOOK STANDS ON THE NEWEST STEP OF ITS CHAIN, and the newest is the point.
 * The cast in `generated/` is shown by the reading AND by every curate save under
 * it — one file, many rows — so the reverse direction has to choose, and the only
 * honest choice is the one you can act from: standing on an old save and then
 * translating would translate the book as of that save, which is not the book on
 * screen. (`castBook` records which cast is live; nothing records which READING
 * cast it, and `documentAtPosition` names that limitation rather than engineering
 * around it. The newest reading is the one that left it, so that is the chain
 * walked here — the same answer, from the same missing fact.)
 *
 * A TRANSLATION IS A BOOK OF ITS OWN and walks its own chain, from the translate
 * step that retained it down through its saves. That is why the walk stops at any
 * descendant that is a book of its own (`A_BOOK_OF_ITS_OWN`): a translation made
 * from a reading is emphatically not the newest step "of" that reading for the
 * purpose of deciding where the reading's own book stands.
 *
 * AND ANYTHING ELSE MOVES NOTHING. A loose file, a bank, a curation snapshot, a
 * rotated predecessor still on disk, a document from another project: none of them
 * is a row in this ledger, and the caller's tab is none the worse for the pointer
 * staying where the user put it. A READING'S FACSIMILE IS IN THAT LIST BY
 * DESIGN, and it is the one member of it that has a row in the left nav: it is
 * terminal, exactly as an export is (docs/RENDERER.md §0 A3), so looking at the
 * page-for-page record must not move the pointer onto the reading and make the
 * next thing somebody does be made from a glance.
 *
 * ── Standing still is not a write ───────────────────────────────────────────
 *
 * This runs on every focus gesture — a tab click, a Ctrl+Tab, a pane pointerdown —
 * where the answer is nearly always the row the pointer is already on. A manifest
 * rewritten on each of those would be a folder people sync churning for a fact
 * that did not change, so the write is skipped when nothing moves, and the answer
 * is composed from the catalogue as it already stands. `positionOf` and not
 * `ledger.position` for the comparison: an absent pointer MEANS the newest step
 * (shared/types.ts, `ProjectLedger.position`), so a project that has never written
 * one and is standing on its newest row must recognise itself and stay quiet.
 *
 * Where it does move it is `goToStep` and nothing else — the same write, the same
 * announcement, the same rows — because two ways to move the pointer is two
 * accounts of what moving it costs.
 */
export async function standForDocument(dir: string, absolutePath: string): Promise<LedgerView> {
  const resolved = deletableProjectDir(dir);
  const manifest = await readManifest(resolved);
  const ledger = ledgerOf(manifest);
  const wanted = await stepStandingFor(resolved, manifest, absolutePath);
  if (wanted === null || wanted === positionOf(ledger)?.id) {
    return { ledger, rows: chronological(ledger) };
  }
  return goToStep(resolved, wanted);
}

/**
 * The step a document in this project belongs to, or null for one that belongs to
 * none.
 *
 * COMPARED PROJECT-RELATIVE AND FOLDED, whole path against whole path, with
 * `fold` — the same spelling-flattener both sides of the app already compare
 * paths with (shared/original.ts). Never by basename: a project holds
 * `archive/Book.pdf`, `working/Book.pdf` and `generated/archived-…/Book.pdf` at
 * once, and the layer is the entire difference between the untouched scan, the
 * copy being edited and a rotated predecessor nobody is standing on.
 *
 * THE PATH IS RESOLVED BEFORE IT IS FOLDED, because the caller's path came in
 * over the wire and `..` in the middle of it is a spelling of somewhere else.
 * A path outside this project's directory answers null: it is a document of some
 * other book, and moving THIS project's pointer for it would be a selection made
 * about a folder nobody clicked in.
 */
async function stepStandingFor(
  dir: string,
  manifest: ProjectManifest,
  absolutePath: string,
): Promise<string | null> {
  const ledger = ledgerOf(manifest);
  const origin = originOf(ledger);
  if (origin === null) return null;

  const root = fold(path.resolve(dir));
  const target = fold(path.resolve(absolutePath));
  if (!target.startsWith(`${root}/`)) return null;
  const relative = target.slice(root.length + 1);

  // Terminal, and terminal means it is not a place to be standing.
  if (relative.startsWith(`${FINAL}/`)) return null;

  if (relative === fold(origin.payload)) return origin.id;
  const live = await liveCopyOf(dir, manifest, origin.payload);
  if (live !== null && relative === fold(live)) return origin.id;

  /*
   * A TRANSLATION IS FOUND BY ITS PAYLOAD, and only for a row that predates
   * records. Those steps retain the EPUB the old EPUB-to-EPUB translator wrote, so
   * the payload is a real document somebody can focus. A records translation has
   * no document at all — its row is drawn on the sheet — so there is nothing here
   * to find it by, which is `documentAtPosition` read backwards and is why the two
   * cannot disagree.
   */
  const translated = newestWhere(
    ledger,
    (step) => step.action === 'translate' && fold(step.payload) === relative,
  );
  if (translated !== null) return newestOfChain(ledger, translated).id;

  return null;
}

/**
 * In-flight appends per records file, so two corrections a second apart cannot
 * both read the file and write back over each other.
 *
 * Serialised per file, because two edits half a second apart are the ordinary
 * gesture stream and a read-modify-write that overlapped would drop the first.
 */
const recordEditWrites = new Map<string, Promise<void>>();

/**
 * THE CORRECTION ITSELF — one keyless human row, appended to a translate step's
 * records file.
 *
 * ── Why this is a function of a STEP and not of a document ──────────────────
 *
 * Because the door that had one is deleted. The EPUB pane resolved a step from a
 * cast's path (`recordTranslationEdit`, gone with the iframe reader); the
 * renderer's aligned view starts from THE POSITION — there is no file on disk it
 * is editing, only the book file main materialised and the ops chain over it — and
 * resolves the step through `translationInEffect` (electron/book.ts,
 * `correctBookBlock`). One step, one append, one serialisation lock, and now one
 * door: a translation's words live in exactly one file and are written from
 * exactly one place.
 *
 * ── `parts` IS A BLOCK ID, AND THE OLD SPELLING IS STILL READ BACK ─────────
 *
 * The pane writes a BLOCK ID, which is what the book file names its rows. Records
 * written by the deleted EPUB door spell `page:order[:part]`, and the lookup still
 * tries the book's ids first and that spelling second (`translationWords`,
 * shared/records.ts) — nothing writes the old vocabulary any more, and every file
 * that already holds it goes on being read.
 *
 * The word checks below are common to both because they are about the WORDS:
 * empty is not a correction, and control characters are not text a book can hold.
 */
export async function recordCorrection(
  dir: string,
  step: LedgerStep,
  parts: string,
  text: string,
  busy: (recordsFile: string) => string | null = () => null,
): Promise<string> {
  const records = translationRecordsOf(step);
  if (records === null) {
    // D2's export refusal, continued at the third door: the legacy row's words
    // exist only inside the book its run wrote.
    throw new ProjectError(
      `“${step.label}” was made before Foundry kept a translation as records, so a corrected `
      + 'sentence has nowhere durable to be recorded — the edit is in this copy of the book and '
      + 'will not survive it being cast again. To make corrections that keep, translate again from '
      + 'the step it was made from; everything after that is free.',
    );
  }
  if (text.trim().length === 0) {
    throw new ProjectError(
      'A correction with no words in it is not a correction. Removing a block is a strike, made on '
      + 'the source book.',
    );
  }
  // Newlines are legal — the dialect keeps a poem's line breaks — and every
  // other control character is refused: JSON.stringify would carry one
  // faithfully into the file, and from there into somebody's book.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    throw new ProjectError('That correction contains control characters, which no book\'s text can hold.');
  }

  const file = path.join(deletableProjectDir(dir), ...records.split('/'));
  const held = busy(file);
  if (held !== null) throw new ProjectError(held);
  const key = fold(file);
  const previous = recordEditWrites.get(key) ?? Promise.resolve();
  const write = previous.then(
    () => appendHumanRow(file, parts, text),
    () => appendHumanRow(file, parts, text),
  );
  const settled = write.then(() => { /* kept */ }, () => { /* kept */ }).then(() => {
    if (recordEditWrites.get(key) === settled) recordEditWrites.delete(key);
  });
  recordEditWrites.set(key, settled);
  return write.then(() => file);
}

async function appendHumanRow(file: string, parts: string, text: string): Promise<void> {
  let existing: string;
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    // A missing records file is not an empty one — the step's payload has been
    // swept or moved, and inventing a file here would put one paragraph of
    // Hungarian where a whole translation is supposed to be.
    throw new ProjectError(
      'The translation\'s records file is not where this project says it is, so the correction '
      + 'cannot be recorded. Translate again from the step this book was made from.',
    );
  }
  const row = `${JSON.stringify({ parts, text, author: 'user' })}\n`;
  const joined = existing.length === 0 || existing.endsWith('\n')
    ? existing + row
    : `${existing}\n${row}`;
  await writeAtomically(file, Buffer.from(joined, 'utf8'));
}

/**
 * The last step this ledger holds that answers a question, or null for none.
 *
 * THE ARRAY'S ORDER IS THE CHRONOLOGY, which is the ledger's own rule rather than
 * a convenience taken here: `parseLedger` refuses a file whose rows run backwards
 * and `chronological` draws the list in this order, so "the last one matching" and
 * "the newest one matching" are the same sentence. Re-sorting by `createdAt`
 * instead would let two rows stamped in one millisecond swap places between
 * repaints, and the pointer would land on a different row for the same click.
 */
function newestWhere(
  ledger: ProjectLedger,
  wanted: (step: LedgerStep) => boolean,
): LedgerStep | null {
  let newest: LedgerStep | null = null;
  for (const step of ledger.steps) if (wanted(step)) newest = step;
  return newest;
}

/**
 * The newest step of the chain that shows one book: this step, and the descendants
 * that are still about the same document.
 *
 * WALKED DOWNWARD THROUGH A CHILDREN MAP, on `subtree`'s reasoning and not merely
 * in imitation of it: a single forward pass over the array assumes every parent is
 * listed before its child, which is an invariant `appendStep` happens to produce
 * and the file format does not promise, and a grandchild missed here is a pointer
 * that lands one row short of where the user is looking.
 *
 * THE WALK STOPS AT A STEP THAT RETAINED A DOCUMENT. A translation hangs off the
 * reading it was made from and is a different book at a different path; including
 * it would make "the newest step of the reading's chain" answer with a row whose
 * own document is not the one that was handed in.
 */
function newestOfChain(ledger: ProjectLedger, from: LedgerStep): LedgerStep {
  const children = new Map<string, LedgerStep[]>();
  for (const step of ledger.steps) {
    if (step.parent === null) continue;
    children.set(step.parent, [...(children.get(step.parent) ?? []), step]);
  }
  const kept = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const step = pending.pop()!;
    if (kept.has(step.id)) continue;
    kept.add(step.id);
    for (const child of children.get(step.id) ?? []) {
      if (A_BOOK_OF_ITS_OWN[child.action]) continue;
      pending.push(child);
    }
  }
  return newestWhere(ledger, (step) => kept.has(step.id)) ?? from;
}

/**
 * The flowing book this project holds — `generated/<stem>.epub`, project-relative
 * — or null for a project that has none.
 *
 * ── What "the cast" is, among four things that share a chain ────────────────
 *
 * The EPUB's chain can hold four kinds of row and only one of them is the book the
 * reading made. A `translate` step is the book in another language. An `origin`
 * marked `irreplaceable` is a book the USER imported, which no reading produced
 * and which a read row must never claim. And a rotated predecessor is still in the
 * chain, at the path it was moved to (`rotateGenerated`) — it is a previous cast,
 * it is on disk, and it is not what a person standing on the reading means.
 *
 * So the test is all three of those said out loud: an `origin` row, not
 * irreplaceable, and sitting DIRECTLY in `generated/` rather than in an archive
 * folder under it. The last clause is the house rule doing real work — a rotated
 * cast's payload is `generated/archived-<stamp>/<name>.epub`, which starts with
 * `generated/` and is emphatically not the live one, so the segment count is
 * checked rather than the prefix alone.
 *
 * NEWEST WINS where a chain somehow holds two, by `appliedAt` and not by array
 * order: `recordStep` appends, which makes the array chronological in every
 * ordinary life of a project, and `summarise` sorts the same way for the same
 * reason — a chain read out of a catalogue somebody edited or a migration composed
 * is not guaranteed to be.
 */
/**
 * The page-for-page reprint ONE READ STEP made of its own pages,
 * project-relative — a name, never a promise that the file is there.
 *
 * THE ONE ACTION LEFT THAT PRODUCES A DOCUMENT NOBODY ASKED FOR — the per-step
 * casts a save and a translation used to leave are deleted (docs/RENDERER.md §7)
 * and both rows are answered by the proof sheet. It is a RENDERING: `vlm-convert --format pdf` over
 * a bank that is already complete, free, offline, made again at any time, and
 * emphatically NOT a row in `manifest.documents`. Cataloguing it would do the
 * same active harm cataloguing a save's book would, one type over — the PDF
 * chain is where the SCAN lives, and a facsimile filed onto it would put the
 * reprint where Home means "the book you imported" and would offer it as the
 * document this app edits.
 *
 * WHICH LEAVES THE SAME OBLIGATION, discharged in the same place: a file nothing
 * catalogues is a file nothing would ever remove, so `castsAmong` composes this
 * name when a read step is deleted and the sweep takes it — along with any
 * predecessor a re-read rotated aside, which `planSweep` finds beside it.
 */
function facsimileForReadStep(manifest: ProjectManifest, step: LedgerStep): string {
  return `${GENERATED}/${facsimileFile(manifest.stem, step.id)}`;
}

/**
 * Every facsimile this project's readings actually have on disk —
 * `ProjectSummary.facsimiles`.
 *
 * THE ONE PLACE THAT STATS. It draws a ROW, and a row for a file that is not
 * there is a nav offering something to click that opens nothing. Every project read before facsimiles existed is in exactly that
 * state, and it is the ordinary state rather than an error — the reading is
 * complete, the bank is on disk, and a facsimile of it is one export away.
 */
async function facsimilesOf(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectFacsimile[]> {
  const made: ProjectFacsimile[] = [];
  for (const step of ledgerOf(manifest).steps) {
    if (step.action !== 'read') continue;
    const file = facsimileForReadStep(manifest, step);
    if (!await exists(path.join(dir, ...file.split('/')))) continue;
    // The READING's own moment. See `ProjectSummary.facsimiles`: the file is the
    // reading's product and is remade whenever the reading is, so its date is
    // that reading's, and an mtime here would be a second opinion about when
    // something in this book's history happened.
    made.push({ file, madeAt: step.createdAt });
  }
  return made;
}

/**
 * The project's own working copy of an archived file, project-relative, or null
 * when the archive is all there is.
 *
 * COMPARED BY THE WHOLE PROJECT-RELATIVE PATH and never by basename, which is this
 * codebase's oldest house rule and is load-bearing here of all places: a project
 * holds `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf` at once,
 * and matching on the last segment would call the reprint a copy of the scan.
 *
 * The two kinds keep their copies in different layers because they are different
 * arrangements, not because anything is inconsistent: a PDF's live copy is
 * `working/<stem>.pdf`, catalogued in `working.files` with the layer it came from
 * — the one thing under `working/` that outlived the unpacked trees, because it is
 * the copy the metadata dialog writes into; an EPUB's is the STAMPED copy in
 * `generated/`, recorded as that type's own origin step (`importDocument`).
 */
async function liveCopyOf(
  dir: string,
  manifest: ProjectManifest,
  archived: string,
): Promise<string | null> {
  if (manifest.archive?.kind === 'epub') {
    const origin = stepsOf(manifest, 'epub')[0];
    return origin !== undefined
      && origin.retention === 'irreplaceable'
      && origin.file.startsWith(`${GENERATED}/`)
      ? origin.file
      : null;
  }
  const live = await reconcileLivePdf(dir, manifest);
  return live !== null && live.from === archived ? `${WORKING}/${live.file}` : null;
}

/** A project-relative payload as an absolute path, or null when it is not there. */
async function onDisk(dir: string, relative: string): Promise<string | null> {
  const resolved = path.join(dir, ...relative.split('/'));
  return await exists(resolved) ? resolved : null;
}

/**
 * Whether the bank AT THE POSITION carries the engine's completion marker — the
 * one fact that makes a rendering free.
 *
 * ── What a caller is actually asking ────────────────────────────────────────
 *
 * `replaysCompletedBank` (src/vlm/read.ts) is true for `--reuse-readings` over a
 * marked bank and false for everything else, and it is what the engine's own argv
 * layer asks before it refuses a run for having no reading backend. So a marker
 * beside the bank is exactly "this run will read no pages and needs no server",
 * and its absence is "this run intends to read whatever is missing" — a resume,
 * which needs a vLLM the pipeline has no business standing up in the middle of a
 * two-stage Generate.
 *
 * EXISTENCE AND NOT THE STAMP, which `markerStamp` below answers for a different
 * question. That one parses `completedAt` because the generation ruling compares
 * instants; this one must agree with the ENGINE's test, and the engine's test is
 * whether the marker is there. A marker this app could not parse would otherwise
 * refuse a Generate the engine would have run perfectly well.
 *
 * `completionMarkerFor` rather than the name composed a second time here: two
 * spellings of one file is two answers the day either of them changes.
 */
export async function readingIsComplete(
  dir: string,
  manifest: ProjectManifest,
  /**
   * THE STEP TO ASK ABOUT, when the question is about one rather than about the
   * position — see `readingBank`, whose argument this is passed straight through
   * to, and `planFacsimile`, which is why either of them takes one.
   *
   * A test that asked the POSITION while its caller named the STEP'S bank would be
   * the two disagreeing in the one window where a project holds two readings: the
   * plan cleared by a marker beside bank B and then replaying bank A. One argument,
   * one bank, one answer.
   */
  at: LedgerStep | null = null,
): Promise<boolean> {
  return exists(completionMarkerFor(readingBank(dir, manifest, at)));
}

/** A bank an OCR run will fill, and the step it belongs to. See `planReading`. */
export interface PlannedBank {
  /** Absolute. What the engine is handed as `--readings`. */
  readingsPath: string;
  /** `LandedRun.id` for this run: an existing step on a replace, minted on a branch. */
  stepId: string;
}

/**
 * WHERE THIS READING'S ANSWERS GO, decided before the job is enqueued.
 *
 * ── Why the path cannot wait for the landing ────────────────────────────────
 *
 * The engine is handed one path and writes into it for three hours. By the time
 * anything lands there is nothing left to decide — so the question "is this
 * reading the one that already exists, or a new one beside it?" has to be
 * answered here, at the plan, and answered the SAME WAY the landing will answer
 * it or the file and the row will describe different readings.
 *
 * It is the same question, asked of the same function, with the same three
 * arguments the landing uses:
 *
 *   THE ACTION is `read`, obviously.
 *
 *   THE PARENT IS THE ORIGIN, never the position. A reading reads the PIXELS,
 *   which live in `archive/` however far through their own history the person
 *   pressing OCR happens to be standing — the reading-parents-at-origin rule, and
 *   `recordReading` obeys it too (see `originOf` in shared/ledger.ts for what
 *   parenting it at the position would cost).
 *
 *   THE PARAMS ARE WHAT THE DIALOG ASKED, normalised by `askedOf` rather than
 *   trimmed here, precisely so the two askings cannot come to disagree about
 *   whether a blank box is a page range.
 *
 * ── The three answers ───────────────────────────────────────────────────────
 *
 * A REPLACE aims at the target step's existing payload. Same step, same path, new
 * contents — which is what `recordLanding` already says about the row, now true
 * of the file as well. The engine writes a pending bank beside it and swaps on
 * success (docs/BANK-LIFECYCLE.md §2), so the old answers survive a failed run.
 *
 * A FIRST READING keeps `readings/<key>.jsonl`. That is what every project on
 * every disk already has, and the whole reason this scheme needs no migration.
 *
 * A BRANCH mints `readings/<key>.<id8>.jsonl`, `id8` being the front of the
 * step's own uuid. Deterministic, collision-free, and never shown to a person —
 * filenames are out of the UI, the row's name comes from `labelFor`. An ordinal
 * would read better in Explorer and would be a second counter to keep consistent
 * with the ledger; the uuid is already minted and already unique.
 *
 * THE ID IS MINTED HERE AND ONLY HERE, and travels on the request to the landing
 * (`ReadRequest.stepId`). Minting it at the landing instead would mean composing
 * a filename from an id the filename could not know; minting it twice would mean
 * a bank named after a step nobody created.
 */
export async function bankForReading(dir: string, asked: ReadAsk): Promise<PlannedBank> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const target = reRunTarget(ledger, {
    action: 'read',
    parent: originOf(ledger)?.id ?? null,
    params: askedOf(asked),
  });
  if (target !== null) {
    return { readingsPath: path.join(dir, ...target.payload.split('/')), stepId: target.id };
  }
  const minted = randomUUID();
  // A project with no reading yet takes the plain name — including one whose only
  // read step was deleted, which destroyed that bank and left the name free.
  const first = !ledger.steps.some((step) => step.action === 'read');
  const file = first ? `${manifest.key}.jsonl` : `${manifest.key}.${id8(minted)}.jsonl`;
  return { readingsPath: path.join(dir, READINGS, file), stepId: minted };
}

/** A translation's file, and the step it belongs to. See `recordsForTranslation`. */
export interface PlannedTranslation {
  /** Absolute. What the engine is handed as `--records`, and the run's whole product. */
  recordsPath: string;
  /** The same file, project-relative — `LedgerStep.payload` when this lands. */
  records: string;
  /** `LandedRun.id` for this run: an existing step on a replace, minted on a branch. */
  stepId: string;
}

/**
 * WHERE THIS TRANSLATION'S ANSWERS GO, decided before the job is enqueued.
 *
 * `bankForReading` above, in the same folder and for the identical reason: the
 * engine is handed a path and writes into it for hours, so "is this the translation
 * that already exists, or a new one beside it?" has to be answered at the plan and
 * answered the SAME WAY the landing will answer it. `translationTarget` is that one
 * answer, and it is pure so that both askings are the same code rather than the
 * same intention.
 *
 * ONE PATH WHERE THERE USED TO BE TWO, and the name says which. This was
 * `bankForTranslation` and it composed an EPUB and a bank beside it, because a
 * translation wrote a book and banked its answers separately. It writes records and
 * nothing else now, that file is the step's payload, and the book is cast from it
 * afterwards under a name composed from the step (`translationCastFile`).
 *
 * ── The parent is the POSITION, which is where a translation differs from a read ─
 *
 * A reading reads the pixels and is parented at the origin however far through
 * their history the person pressing OCR is standing (`originOf`). A translation
 * reads a BOOK — the rendering of wherever the user is standing — so its parent is
 * the position, and that is the whole of why translating the reading and
 * translating a curation of it are two rows rather than one overwritten twice.
 *
 * ── The window between this and the enqueue, stated rather than discovered ──
 *
 * `Job.parentStep` is captured at the press, a moment after this runs, and a
 * pointer move in between would let the plan and the landing disagree about the
 * parent — a branch planned and a replace landed, or the reverse. Both fall safely
 * and neither invents a rule: a replace that lands on minted paths keeps its row
 * and takes them, and `Landing.displaced` destroys what it left behind only after
 * proving no surviving row names it; a branch that lands on an existing row's paths
 * is the two-steps-one-payload state `orphanedPayloads` has always guarded. The
 * alternative — trusting the renderer to hand back the parent this plan used — is a
 * fact about a person's history taken from outside main.
 */
export async function recordsForTranslation(
  dir: string,
  language: string,
  /**
   * The rewrite, when the button pressed was Simplify — absent for a translation.
   *
   * A PARAMETER RATHER THAN A SECOND FUNCTION BESIDE THIS ONE, because everything
   * this decides is decided the same way for both: the parent is still the
   * position, the answer is still `translationTarget`'s, and the mode is simply
   * part of the ask it is given. A `recordsForSimplification` would be this
   * function with one field spread in, and the day the parent rule changed it
   * would change in one of the two.
   */
  rewrite?: RewriteMode,
): Promise<PlannedTranslation> {
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  /*
   * THE PARENT IS THE POSITION, FULL STOP — and it used to be an argument.
   *
   * A Generate standing ON a translation needed the other answer: the user was
   * asking for that row again, so the run had to be filed against the row's own
   * parent or it would append a translation whose parent was a translation.
   * Nothing renders a translation that way any more (the book is cast from the
   * records this run writes, and a cast lands no step at all), so the only door
   * left is the Translate dialog — which asks for a translation OF what is on
   * screen. That is the position, and standing on a translation and asking for a
   * DIFFERENT language is exactly the chain the user asked for, filed under the
   * row it was made from.
   */
  const target = translationTarget(
    ledger,
    {
      parent: positionOf(ledger)?.id ?? null,
      language,
      key: manifest.key,
      ...(rewrite !== undefined ? { rewrite } : {}),
    },
    randomUUID(),
  );
  return {
    recordsPath: path.join(dir, ...target.records.split('/')),
    records: target.records,
    stepId: target.stepId,
  };
}

/**
 * Append a step to one file type's chain, making the chain if it is the first.
 *
 * THE ONLY WRITER OF A CHAIN, so that "the live file is the last step" is true
 * by construction rather than by everybody remembering to append. A step is
 * never inserted, never reordered and never replaced: the array is a history,
 * and the one thing a history may not do is change.
 *
 * `onlyIfEmpty` is for an ORIGIN that may be recorded twice — importing a book
 * that is already this project's, most of all. The first origin is the true one;
 * a later import of the same file is the app noticing something it already knew.
 */
function recordStep(
  manifest: ProjectManifest,
  kind: ProjectDocumentKind,
  step: ProjectStep,
  options: { onlyIfEmpty?: boolean } = {},
): void {
  const record = manifest.documents.find((row) => row.kind === kind);
  if (record === undefined) {
    manifest.documents = [...manifest.documents, { kind, steps: [step] }];
    return;
  }
  if (options.onlyIfEmpty === true) return;
  // The same file applied twice is one step. A rerun that lands on a path
  // already at the top of the chain has replaced its contents, not added a
  // version — and two identical rows would make "step back" a no-op.
  if (record.steps[record.steps.length - 1]?.file === step.file) {
    record.steps = [...record.steps.slice(0, -1), step];
    return;
  }
  record.steps = [...record.steps, step];
}

/** The chain for one type, or an empty one. Never null, so callers stay flat. */
function stepsOf(manifest: ProjectManifest, kind: ProjectDocumentKind): ProjectStep[] {
  return manifest.documents.find((row) => row.kind === kind)?.steps ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// The generated layer
// ─────────────────────────────────────────────────────────────────────────────

/** `archived-2026-08-14T00-31-02-114Z` — the engine's shape, colons removed. */
function stampedArchive(parent: string): string {
  return path.join(parent, `archived-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

/**
 * Move an origin aside, if it is there.
 *
 * Called before a conversion writes, so a second run of the same book replaces
 * the first WITHOUT destroying it. `generated/` is never overwritten, ever: it
 * is the record of what the model read, and the previous read is still a record
 * of something.
 */
/**
 * A rotation that happened, and everything needed to put it back.
 *
 * IT IS A RECEIPT, and it exists because a rotation is now made at the moment
 * the engine is about to write rather than when a job is planned — so there is a
 * window, however short, in which the run can fail and the previous output has to
 * come home. See `restoreRotation`.
 */
export interface Rotation {
  /** `<stem>.epub` — the name in `generated/` that was moved out of the way. */
  file: string;
  /** Where it went: `generated/archived-<stamp>/<file>`. */
  movedTo: string;
}

export async function rotateGenerated(dir: string, file: string): Promise<Rotation | null> {
  const target = path.join(dir, GENERATED, file);
  if (!await exists(target)) return null;

  let movedTo: string | null = null;
  await withManifest(dir, async (manifest) => {
    const from = `${GENERATED}/${file}`;
    const archive = stampedArchive(path.join(dir, GENERATED));
    if (await exists(archive)) {
      // The engine's rule, for the engine's reason: two runs' outputs under one
      // folder name is two books' worth of work filed as one.
      throw new ProjectError(
        `${archive} already exists, so the previous ${file} cannot be moved aside without mixing `
        + "two runs' work into one folder. Move it away and run again.",
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    movedTo = path.join(archive, file);
    await fsp.rename(target, movedTo);

    /*
     * THE ROTATED COPY STAYS IN THE CHAIN, at the path it was moved to.
     *
     * It used to be struck out of the catalogue entirely, which was right when a
     * catalogue listed live files and wrong now that it records a history: the
     * file this just moved aside is a previous version of this type, it is on
     * disk, and it is exactly what "step back to an earlier one" reaches for.
     * Only its location changed, so only its location is rewritten — the label,
     * the cost and the time it was applied are what they always were.
     */
    const record = manifest.documents.find((row) => row.steps.some((s) => s.file === from));
    if (record !== undefined && movedTo !== null) {
      const moved = path.relative(dir, movedTo).split(path.sep).join('/');
      record.steps = record.steps.map(
        (step) => (step.file === from ? { ...step, file: moved } : step));
    }
    await writeManifest(dir, manifest);
  });
  // A document moved out of the live layer and into an archive folder, which is
  // a listing that has changed even though nothing was made.
  announceProjects();
  // The receipt: where it went, so a run whose own input is the copy being
  // replaced can read it there (see `planTranslation`) and a run that never
  // writes can put it back (see `restoreRotation`).
  return movedTo === null ? null : { file, movedTo };
}

/**
 * Put a rotation back, because the run it was made for never wrote anything.
 *
 * ── The invariant this exists to keep ───────────────────────────────────────
 *
 * A GENERATE THAT FAILS OR IS CANCELLED LEAVES THE CATALOGUE EXACTLY AS IT WAS.
 *
 * It used not to. The rotation happened when the job was PLANNED — before it was
 * even enqueued, let alone run — and the new file was recorded only on success.
 * So a run that failed at the first page, or one the user cancelled, or one that
 * sat held and was removed, left the previous output sitting in
 * `generated/archived-<stamp>/` with the chain pointing at it and nothing in
 * `generated/` at all. Home went on listing the document, opening it went on
 * working, and the file it opened was silently the PREVIOUS run's output,
 * forever, with nothing anywhere saying a rotation had happened for a run that
 * never produced anything.
 *
 * ── What it puts back ───────────────────────────────────────────────────────
 *
 * The file, and the step's location in the chain.
 *
 * NOTHING IS DELETED BY A RESTORE, and the empty archive folder is removed only
 * if it IS empty — a stamp is per second and a sibling rotated in the same
 * instant is somebody else's record.
 *
 * A failure here is a console line rather than a throw. It runs on the way out
 * of a job that has already failed, and the second failure worth reporting is
 * the one the user asked about; this one is named in full in the terminal.
 */
export async function restoreRotation(dir: string, rotation: Rotation): Promise<void> {
  try {
    const back = path.join(dir, GENERATED, rotation.file);
    if (await exists(back)) {
      // Something is in the live slot. That can only be the very output this
      // rotation was making room for, which means the run DID write — so there
      // is nothing to undo and putting the old copy over it would destroy the
      // new one.
      return;
    }
    if (await exists(rotation.movedTo)) await fsp.rename(rotation.movedTo, back);

    const archive = path.dirname(rotation.movedTo);

    await withManifest(dir, async (manifest) => {
      const from = `${GENERATED}/${rotation.file}`;
      const moved = path.relative(dir, rotation.movedTo).split(path.sep).join('/');
      const record = manifest.documents.find((row) => row.steps.some((s) => s.file === moved));
      if (record !== undefined) {
        record.steps = record.steps.map(
          (step) => (step.file === moved ? { ...step, file: from } : step));
      }
      await writeManifest(dir, manifest);
    });

    try {
      if ((await fsp.readdir(archive)).length === 0) await fsp.rmdir(archive);
    } catch { /* somebody else's rotation shares the folder, or it is already gone */ }
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${rotation.file} was moved aside for a run that did not write, and could not be `
      + `put back (${(err as Error).message}). It is in ${rotation.movedTo}; nothing was deleted.`,
    );
  }
}

/**
 * A rotation of a FILED document, and everything needed to put it back.
 *
 * The `generated/` receipt one folder over (`Rotation`) and deliberately not the
 * same shape: an origin has a step in a type's chain, and that has to travel in
 * the receipt. A filed document has none — nothing is ever made from an export —
 * so what a restore owes is the file and the catalogue row that named it.
 */
export interface FinalRotation {
  /** `<stem>.epub` — the name in `final/` that was moved out of the way. */
  file: string;
  /** Where it went: `final/archived-<stamp>/<file>`. */
  movedTo: string;
  /** The row the rotation struck out of `manifest.final`, if there was one. */
  row: ProjectFinal | null;
}

/**
 * Move a filed document aside, if there is one, so an export can take its name.
 *
 * ── Why `final/` rotates at all, when it is the user's own tray ─────────────
 *
 * Because the name is composed rather than chosen. An export is called after the
 * BOOK — `<stem>.epub` — like everything else in a project, so exporting the same
 * format twice names one path twice, and the second run would write over the first
 * with nothing anywhere saying it had. That is the exact failure `rotateGenerated`
 * exists to prevent one folder over, and the fact that a person could have gone and
 * renamed the file themselves is not a reason for this app to destroy it while they
 * did not.
 *
 * AT THE MOMENT THE ENGINE IS ABOUT TO WRITE, never at the plan — the whole of
 * `restoreRotation`'s argument, applied to the same window: a run that fails, is
 * cancelled, or is removed from the shelf must leave the tray exactly as it found
 * it, and the only way that is true is if the rotation is undoable and undone.
 *
 * ── And there is no open-file refusal here, which is the difference ─────────
 *
 * `rotateGenerated` refuses when the book it would move has a working tree open in
 * a tab, because moving that tree is what breaks a reader mid-chapter. An export
 * has no tree: a filed EPUB opened in a tab was unpacked into `working/` under its
 * own name and the tab reads the tree, not this file; a filed PDF's bytes were read
 * once. So there is nothing being read out from under anybody, and a refusal here
 * would stop somebody re-exporting the book they are looking at — which is the most
 * ordinary reason to export twice.
 */
export async function rotateFinal(dir: string, file: string): Promise<FinalRotation | null> {
  const target = path.join(dir, FINAL, file);
  if (!await exists(target)) return null;

  let movedTo: string | null = null;
  let row: ProjectFinal | null = null;
  await withManifest(dir, async (manifest) => {
    const archive = stampedArchive(path.join(dir, FINAL));
    if (await exists(archive)) {
      // `rotateGenerated`'s rule, for its reason: two runs' outputs under one
      // folder name is two exports filed as one.
      throw new ProjectError(
        `${archive} already exists, so the ${file} you filed earlier cannot be moved aside without `
        + "mixing two exports into one folder. Move it away and run again.",
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    movedTo = path.join(archive, file);
    await fsp.rename(target, movedTo);
    /*
     * THE ROW GOES, rather than being rewritten to point into the archive.
     *
     * This is where a filed document parts company with a generated one. A rotated
     * ORIGIN stays in its chain at its new path, because the chain is a history and
     * an earlier version of the book is exactly what "step back" reaches for. The
     * `final` list is not a history — it is what the project currently offers, one
     * row per file the user can open — so a row pointing into an archive folder
     * would put a stamped directory name in the left nav for a document nobody
     * asked to keep. The bytes are still there; the claim that they are on offer
     * is what the rotation withdraws.
     */
    row = manifest.final.find((entry) => entry.file === file) ?? null;
    manifest.final = manifest.final.filter((entry) => entry.file !== file);
    await writeManifest(dir, manifest);
  });
  // A document left the tray, which is a listing that has changed even though
  // nothing has been made yet.
  announceProjects();
  return movedTo === null ? null : { file, movedTo, row };
}

/**
 * Put a filed document back, because the export it was moved for never wrote.
 *
 * `restoreRotation`'s invariant, said about the other folder: AN EXPORT THAT FAILS
 * OR IS CANCELLED LEAVES THE TRAY EXACTLY AS IT WAS. Nothing is deleted, the empty
 * archive folder goes only if it IS empty (a stamp is per second, and a sibling
 * rotated in the same instant is somebody else's record), and a failure here is a
 * console line rather than a throw — it runs on the way out of a job that has
 * already failed, and the failure worth reporting is the one the user asked about.
 */
export async function restoreFinalRotation(dir: string, rotation: FinalRotation): Promise<void> {
  try {
    const back = path.join(dir, FINAL, rotation.file);
    if (await exists(back)) {
      // Something is in the live slot, which can only be the export this rotation
      // made room for — so the run DID write, and putting the old copy over it
      // would destroy the new one.
      return;
    }
    if (await exists(rotation.movedTo)) await fsp.rename(rotation.movedTo, back);

    const row = rotation.row;
    if (row !== null) {
      await withManifest(dir, async (manifest) => {
        if (manifest.final.some((entry) => entry.file === row.file)) return;
        manifest.final = [...manifest.final, row];
        await writeManifest(dir, manifest);
      });
    }

    try {
      const archive = path.dirname(rotation.movedTo);
      if ((await fsp.readdir(archive)).length === 0) await fsp.rmdir(archive);
    } catch { /* somebody else's rotation shares the folder, or it is already gone */ }
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${rotation.file} was moved aside for an export that did not write, and could not be `
      + `put back (${(err as Error).message}). It is in ${rotation.movedTo}; nothing was deleted.`,
    );
  }
}

/**
 * A TRANSLATION LANDED — the step that keeps what it cost, and the one landing in
 * this app whose product is not a document.
 *
 * ── Why this is not `recordGenerated` with another role ─────────────────────
 *
 * Because nothing was generated. `recordGenerated` files a finished ORIGIN: it
 * puts a row on that type's chain in `manifest.documents`, it can promote the
 * result to the project's live PDF, and it refuses anything that is not directly
 * in `generated/` — every line of it is about a document somebody will open. A
 * records translation writes `readings/<key>.<tag>[.<id8>].records.jsonl` and no
 * document at all; the book comes later, cast from this file, as a rendering that
 * is nobody's payload (`castForTranslateStep`).
 *
 * So this is `recordReading`'s shape rather than `recordGenerated`'s, which is the
 * right family for a much better reason than convenience: both actions run a model
 * over a whole book, both leave a `.jsonl` of per-position answers in `readings/`,
 * and for both of them the payload IS that file. A read step's bank has been its
 * payload since docs/BANK-LIFECYCLE.md §4.1; this is the same sentence about the
 * other model pass, and it means `orphanedPayloads` protects and destroys a
 * translation's answers by a rule nobody had to teach it.
 *
 * ── The two facts the job hands over, and why neither is read off the disk ──
 *
 * THE LANGUAGE, because the alternative is reading a fact out of a filename. It
 * decides whether the next translation from this step replaces this row or
 * branches beside it (`MINTED_BY_THE_RUN` keeps every other param out of that
 * comparison), it is what a cast is declared as, and it is what the row says.
 *
 * THE SOURCE LANGUAGE, WHEN THIS RUN WAS A CHAIN. `params.from` is written by
 * nothing else, and it exists so a row in a two-hop chain can say both ends —
 * "Translated (en → hu)" — where the target alone would leave two rows looking
 * alike and the interesting fact legible only by walking parents.
 *
 * ── And the bank a replaced row used to name ────────────────────────────────
 *
 * Re-translating a row that predates records swaps its payload from an EPUB in
 * `generated/` to a records file in `readings/`. `Landing.displaced` destroys the
 * book — it is a payload, no surviving row names it — and the BANK beside it is
 * not a payload at all, so nothing else in this app would ever mention it again.
 * It goes here, guarded the way the ledger guards a payload: by the whole
 * project-relative path, against what every surviving step MEANS by its bank.
 *
 * A failure is a console line and never a throw, exactly as `recordReading`'s is.
 * This runs after a run that may have taken hours; a catalogue row that could not
 * be written is not a reason to report those hours as a failure, and the records
 * are on disk either way.
 */
export async function recordTranslation(
  recordsPath: string,
  landed: {
    /** The position when the job was ENQUEUED. See `Job.parentStep`. */
    parentStep?: string | null;
    /** `TranslateRequest.to`, as the dialog named it. */
    language?: string;
    /**
     * `TranslateRequest.stepId` — the step the records file was named after,
     * minted at the plan (`recordsForTranslation`).
     *
     * A branching translation writes `readings/<key>.<tag>.<id8>.records.jsonl`,
     * and the `id8` is the front of this uuid. Landing under a freshly minted id
     * would leave the file named after a row nobody created. Spent only on an
     * append, which is `LandedRun.id`'s own rule.
     */
    stepId?: string;
    /**
     * `TranslateRequest.rewrite` — which rewrite this was, for a run that said the
     * book again in its own language.
     *
     * IT COMES FROM THE JOB FOR THE LANGUAGE'S OWN REASON, and it is the second
     * fact nothing on disk can answer afterwards. The mode is in the records file's
     * NAME, and reading it back out of one is what this codebase's oldest house
     * rule forbids — so the run that asked says which, exactly as it says which
     * language it asked for. Absent for every translation, which is what keeps
     * `translatedInto` composing the params it has always composed.
     */
    rewrite?: RewriteMode;
  } = {},
): Promise<void> {
  const resolved = path.resolve(recordsPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} is outside any project, so no translation was recorded.`);
    return;
  }
  try {
    await withManifest(dir, async (manifest) => {
      const before = ledgerOf(manifest);
      /*
       * ── WHETHER THIS IS A CHAIN IS A FACT ABOUT THE TREE, ASKED HERE ─────────
       *
       * A run is a chain exactly when the row it hangs off is itself a
       * translation — *"german to english to hungarian"* — and that is knowable
       * from the ledger without anybody asserting it over the wire. The job DOES
       * carry a `--from`, and it is deliberately not read for this: that field is
       * a command line, and it also holds the language a person typed into an
       * optional box for a book nobody has translated yet. Recording that as the
       * step's `from` would put "(de → en)" on the ordinary single-hop row of
       * everybody who fills the field in, which is the wording the ruling says
       * those rows keep.
       *
       * THE PARENT IS RESOLVED THE WAY `landStep` RESOLVES IT — the captured row
       * if this ledger still holds it, the position if it was deleted while the
       * run went — because the answer has to be about the row this step is
       * actually going to hang from. That rule is stated in one place and asked
       * in two, which is worth one line here rather than a landing that describes
       * a parent it did not use.
       */
      const under = before.steps.find((step) => step.id === landed.parentStep)
        ?? positionOf(before);
      const from = under?.action === 'translate' ? under.params?.language?.trim() ?? '' : '';
      const landing = await landStep(manifest, {
        action: 'translate',
        parent: landed.parentStep ?? null,
        /*
         * WHERE THE ENGINE ACTUALLY WROTE, spelled project-relative with forward
         * slashes — which is what `LedgerStep.payload` is and what `destroyPayload`
         * splits again to reach the file, so nothing here ever matches by basename.
         */
        payload: path.relative(dir, resolved).split(path.sep).join('/'),
        params: {
          ...translatedInto(landed.language, landed.rewrite),
          ...(from.length > 0 ? { from } : {}),
        },
        createdAt: Date.now(),
        // Minted at the plan and written into a filename since; spent here, and
        // only if this appends.
        ...(landed.stepId !== undefined ? { id: landed.stepId } : {}),
      });
      /** The bank the step named BEFORE this landing, for the displacement below. */
      const bankWas = landing?.replaced === true
        ? translationBankOf(
          before.steps.find((step) => step.id === landing.step.id) ?? landing.step,
          manifest.key,
        )
        : null;
      await writeManifest(dir, manifest);
      // After the write, never before: the replacement is on disk and recorded, so
      // whatever the swap displaced is now a file nothing in this project names.
      // Null on every ordinary re-translation, because a replace was AIMED at the
      // target step's own records before the job was enqueued.
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
      if (
        bankWas !== null
        && !ledgerOf(manifest).steps.some((step) => translationBankOf(step, manifest.key) === bankWas)
      ) {
        await destroyPayload(dir, bankWas);
        for (const debris of pendingBeside(bankWas)) await destroyPayload(dir, debris);
      }
    });
    // The tree draws from the ledger and the panes repaint from the position, and
    // both hear about it the one way anything in this app hears that a project
    // moved.
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${path.basename(dir)} could not record its translation (${(err as Error).message}). `
      + 'The records are on disk, so casting the book from them is free whenever it is asked for.',
    );
  }
}

/**
 * Put a finished origin in the catalogue, and refresh the live copy it feeds.
 *
 * Called when the JOB SUCCEEDS rather than when it is planned, because a plan is
 * an intention: a run that fails at page 200 would otherwise leave a row in the
 * catalogue for a file that does not exist, and Home would offer it.
 *
 * A PDF-PRODUCING CONVERSION REPLACES THE LIVE PDF. There is ONE PDF per
 * project — "the PDF", the working document — and applying a change to it
 * produces a new version of it rather than a second document beside it.
 *
 * ── This was got wrong once, and the reasoning is worth keeping ─────────────
 *
 * When the reprint stopped being the scan-with-a-layer and became type on blank
 * paper, this promotion was removed and the reprint was given a row of its own.
 * The fear was real: promoting it would file the user's SCAN into
 * `working/archived-<stamp>/` and hand them a text-only document under the name
 * of the photograph they imported. Nobody asked for their scan to be replaced.
 *
 * That was the right worry solved in the wrong place. The scan is protected by
 * `archive/` BEING IMMUTABLE — it is copied in once at import and no path in
 * this app is ever composed into it — not by making the user keep track of two
 * PDFs with the same filename. Solving it here cost exactly what a wrong
 * abstraction costs: two identical rows in the document list, two identical
 * options in the OCR picker, and a refusal that told somebody to go and convert
 * "the original instead" — an instruction about this app's filing, given to the
 * person the filing is supposed to be invisible to.
 *
 * So the promotion is back and the user sees one PDF. The one they see is the
 * working copy, it carries whatever has been applied to it, the previous version
 * is rotated aside rather than lost, and the original they imported is still on
 * disk untouched — reachable by exporting it or reverting to it, which are
 * deliberate gestures rather than a row in a list.
 *
 * A failure here is LOGGED and not thrown. This runs at the end of a run that
 * may have taken three hours, and losing a row in a catalogue is not a reason to
 * report the conversion itself as failed — but it is named, in full, so the line
 * says which file went unrecorded and why.
 */
export async function recordGenerated(
  outputPath: string,
  role: ProjectGeneratedRole,
): Promise<string | null> {
  const resolved = path.resolve(outputPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} finished outside any project, so nothing catalogued it.`);
    return null;
  }
  const inside = path.relative(dir, resolved).split(path.sep);
  const file = inside.length === 2 && inside[0] === GENERATED ? inside[1] : undefined;
  if (file === undefined) {
    console.error(`[projects] ${resolved} is not directly in a project's ${GENERATED}/, so nothing catalogued it.`);
    return null;
  }
  const kind = kindOf(file);
  if (kind === null) {
    console.error(`[projects] ${resolved} has an extension no project catalogue describes.`);
    return null;
  }
  try {
    return await withManifest(dir, async (manifest) => {
      /*
       * A STEP ON THAT TYPE'S CHAIN, and the cost is recorded with it.
       *
       * Every role that reaches here is the product of a model pass — a cast, a
       * reprint, a text emission all run the engine over the book — so the file is
       * frozen the moment it exists and later work happens on a copy of it. The
       * reason travels with the step so that the sweep, the rotation and the
       * delete warning can all ask one question of one place.
       */
      recordStep(manifest, kind, {
        file: `${GENERATED}/${file}`,
        label: STEP_LABELS[role],
        appliedAt: Date.now(),
        kind: role === 'translation' ? 'translate' : role === 'cast' ? 'origin' : 'convert',
        retention: 'expensive',
          why: WHY_MODEL_PASS,
      });
      /*
       * ── AND NO LEDGER STEP, WHICH IS THE WHOLE OF WHAT MOVED OUT OF HERE ─────
       *
       * This function used to land a `translate` step for one of its roles, and the
       * rule it stated was the settled one: translations become steps, renderings do
       * not. That rule is unchanged — what changed is that a translation is no longer
       * a rendering this function ever sees. `translate --records` writes per-block
       * answers into `readings/` and no document at all, so the step lands where the
       * answers land (`recordTranslation`, above), and what eventually arrives HERE
       * from a translated position is the BOOK CAST FROM those records: free, remade
       * on demand, and carrying `forStep`, which makes the queue file it nowhere at
       * all (`GenerateRequest.forStep`).
       *
       * So every role that reaches this function is a rendering now, and the four of
       * them are four ways of writing out one bank of answers. Minting a step for
       * any of them would put a filename where an action belongs and offer the user
       * a delete button for something that costs nothing to have back.
       */
      // WRITTEN BEFORE the live copy is refreshed, and that ordering is the
      // whole reason these are two writes. Refreshing can refuse — an archive
      // folder from this same second already exists — and a refusal that took
      // the origin's own catalogue row down with it would leave the engine's
      // output on disk, uncatalogued, invisible to Home.
      await writeManifest(dir, manifest);
      if (role !== 'searchable') return null;
      const live = await refreshLivePdf(dir, manifest, file);
      await writeManifest(dir, manifest);
      return live;
    }).finally(announceProjects);
  } catch (err) {
    console.error(`[projects] ${path.join(dir, MANIFEST)} could not record ${file}: ${(err as Error).message}`);
    return null;
  }
}
/**
 * Install a `generated/` PDF as the project's live one.
 *
 * `recordGenerated` above is the one caller: a searchable conversion's output
 * becomes the copy the tabs open. The flat-layout adoption that also needed
 * this is gone — the ruling of 2026-08-16 was that nothing is kept for legacy's
 * sake, and the machines that held a flat workspace have been regrouped or
 * wiped by their owners.
 *
 * The old live copy is rotated into `working/archived-<stamp>/` rather than
 * overwritten, because it is the only thing that can answer "what did this look
 * like before?" — and because a metadata edit made against it (once those exist)
 * would otherwise vanish without a trace.
 */
async function refreshLivePdf(
  dir: string,
  manifest: ProjectManifest,
  generatedFile: string,
): Promise<string> {
  const liveFile = `${manifest.stem}.pdf`;
  const live = path.join(dir, WORKING, liveFile);
  await fsp.mkdir(path.join(dir, WORKING), { recursive: true });
  if (await exists(live)) {
    const archive = stampedArchive(path.join(dir, WORKING));
    if (await exists(archive)) {
      throw new ProjectError(
        `${archive} already exists, so the previous ${liveFile} cannot be moved aside. Move it away.`,
      );
    }
    await fsp.mkdir(archive, { recursive: true });
    await fsp.rename(live, path.join(archive, liveFile));
  }
  await fsp.copyFile(path.join(dir, GENERATED, generatedFile), live);
  manifest.working.files = [
    ...manifest.working.files.filter((row) => row.file !== liveFile),
    { file: liveFile, kind: 'pdf', from: `${GENERATED}/${generatedFile}`, madeAt: Date.now() },
  ];
  return live;
}

/**
 * Note that a finished document is sitting in the project's own `final/`.
 *
 * Only when it landed THERE. Save As to a USB stick or to somebody's Desktop is
 * the user's business and is already in recents; the catalogue records the
 * project's own filing tray so Home can say a book has been filed at all.
 * Silent about anything else, and never fatal — a save that happened must not
 * report a failure because a catalogue line did not.
 *
 * ── AND IT IS NOW THE WHOLE LANDING OF AN EXPORT ────────────────────────────
 *
 * This used to have one caller: a person pressing Save As and choosing the folder
 * the dialog opened in. The queue is the second, and it is the reason the tray has
 * a name in the model at all — an export is a run of the engine that lands here
 * INSTEAD of going through `recordGenerated` (docs/WORKBENCH.md §3). Nothing about
 * this function had to change to take it, which is the point rather than luck: a
 * row in `manifest.final` says "this file exists, it is finished, and it is yours",
 * and that sentence is equally true whichever gesture put the bytes there.
 *
 * WHAT IT DELIBERATELY STILL DOES NOT DO is everything a generated origin gets. No
 * step on a type's chain, because an export is not a version of the project's EPUB
 * — it is a copy somebody asked for. No ledger step, because nothing is ever made
 * from it: "it wont go into the working files as a step because it isnt the base
 * for new steps. its a terminal step." No live-PDF refresh, because a facsimile
 * exported to the tray is not the document this app works on. One row, and stop.
 *
 * ONE ROW PER NAME, replaced rather than appended: exporting the same format twice
 * writes the same path twice (the predecessor having been rotated aside first —
 * `rotateFinal`), and two rows for one file is a left nav that offers a document it
 * cannot tell apart from itself.
 */
export async function recordFinal(
  destination: string,
  /**
   * THE LEDGER STEP THIS EXPORT REPLAYED TO, when the caller is the queue and
   * therefore knows — see `ProjectFinal.stepId`.
   *
   * OPTIONAL BECAUSE THE OTHER CALLER CANNOT KNOW IT. Save As is a person
   * choosing a folder in a dialog, and the file they are filing has no step
   * behind it at all; passing a position from there would be recording where
   * somebody happened to be standing as though it were where the bytes came
   * from. Absent is the honest answer and it is the pre-existing behaviour.
   */
  stepId: string | null = null,
): Promise<void> {
  const resolved = path.resolve(destination);
  const dir = projectDirOf(resolved);
  if (dir === null) return;
  const inside = path.relative(dir, resolved).split(path.sep);
  const file = inside.length === 2 && inside[0] === FINAL ? inside[1] : undefined;
  if (file === undefined) return;
  const kind = kindOf(file);
  if (kind === null) return;
  try {
    await withManifest(dir, async (manifest) => {
      manifest.final = [
        ...manifest.final.filter((entry) => entry.file !== file),
        {
          file,
          kind,
          madeAt: Date.now(),
          ...(stepId !== null && stepId.length > 0 ? { stepId } : {}),
        },
      ];
      await writeManifest(dir, manifest);
    });
    announceProjects();
  } catch (err) {
    console.error(`[projects] ${path.join(dir, MANIFEST)} could not record ${file}: ${(err as Error).message}`);
  }
}

/** Where Save opens for a book in this project. Created so the dialog lands in it. */
export async function finalDir(dir: string): Promise<string> {
  const target = path.join(dir, FINAL);
  await fsp.mkdir(target, { recursive: true });
  return target;
}

function kindOf(file: string): ProjectDocumentKind | null {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.epub') return 'epub';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.txt') return 'txt';
  return null;
}

/**
 * A reading FINISHED — the one moment anything can honestly say a bank is done.
 *
 * WHERE THE GENERATION IS MINTED, and it is the natural place: a landing is a
 * bank that is on disk and was not before, so it is the event a generation is
 * about. `generationForLanding` states the rule and its one exception — a first
 * read adopts a generation somebody's first touch minted while it was still
 * running, so corrections made against the pages already read survive the run
 * finishing. Everything else mints: a re-read swapped in over the old bank, a
 * branch beside it, and a first read nobody watched.
 *
 * IT IS THE ONLY PLACE THAT MINTS ONE NOW. `readingGeneration` — the block
 * editor's first-touch minting, which asked where the user was STANDING rather
 * than what had just landed — is deleted with the overlay system that was the
 * only thing bound to it (docs/RENDERER.md §7). What the id is still for is the
 * records: a translate run is handed `--generation` and stamps it into every row
 * it writes, so a set of answers can say which reading of the pages it is about.
 *
 * A failure is a console line and never a throw. This runs after a job that may
 * have taken three hours, and a catalogue row that could not be written is not a
 * reason to report those hours as a failure — the bank is on disk either way, and
 * the completion marker beside it is what a listing falls back to.
 */
export async function recordReading(
  readingsPath: string,
  /**
   * WHAT THE RUN WAS ASKED FOR — the two fields of `ReadRequest` the person
   * filled in — handed over rather than inferred from what came back.
   *
   * It is what decides whether the next reading of this book REPLACES this step
   * or branches beside it (`MINTED_BY_THE_RUN`), and nothing on disk can answer
   * it afterwards: a bank does not record which pages it was told to leave out,
   * and working that out from the gaps in a file would be the same species of
   * guess as reading a language out of a filename. The job knows what it asked;
   * it says so, exactly as the translation hands over its `--to`.
   *
   * Defaulted so that a caller with nothing to say — a reading recorded by a
   * build that predates this, or one adopted from outside the queue — records a
   * reading of the whole book with no language declared, which is the plain
   * question and the one a migrated project asks too.
   */
  asked: ReadAsk = {},
  /**
   * THE STEP THIS BANK WAS NAMED AFTER, when the plan minted one.
   *
   * A branching re-read writes `readings/<key>.<id8>.jsonl`, and the `id8` in that
   * filename is the front of the step's uuid — decided at the plan, hours before
   * this runs (`bankForReading`). Landing under a freshly minted id would leave the
   * file named after a row that does not exist, so the id travels with the job
   * (`ReadRequest.stepId`) and is spent here.
   *
   * Absent for a job from a build that predates the field, and unused whenever
   * this landing turns out to be a replace: `LandedRun.id` is spent only on an
   * append, and a replace swaps a payload into the step that is already there.
   */
  stepId?: string,
): Promise<void> {
  const resolved = path.resolve(readingsPath);
  const dir = projectDirOf(resolved);
  if (dir === null) {
    console.error(`[projects] ${resolved} is outside any project, so no reading was recorded.`);
    return;
  }
  try {
    const pages = await countLines(resolved);
    /*
     * THE MARKER FOR THE BANK THIS RUN WROTE, and not for the position's. They
     * are usually one file and are not always: a branch lands beside the reading
     * somebody is standing on. The step records the completion of its OWN bank,
     * which is the only thing a later "has this been read again behind our back?"
     * can honestly compare against.
     */
    const completedAt = await markerStamp(resolved);
    await withManifest(dir, async (manifest) => {
      const generation = generationForLanding(
        ledgerOf(manifest),
        manifest.reading,
        completedAt,
        randomUUID(),
      );
      manifest.reading = {
        generation,
        readAt: Date.now(),
        pages,
        ...(completedAt !== null ? { completedAt } : {}),
      };
      /*
       * ── AND THE READ STEP, WHICH IS THE SAME FACT IN THE OTHER RECORD ────────
       *
       * `manifest.reading` above says which reading the block editor's live
       * corrections are bound to — one per project, replaced in place, a fact
       * about NOW. The ledger says what has been done to this book and what each
       * of those left behind, and it keeps every one of them. Both are written
       * from the same values in the same instant precisely so they cannot come to
       * disagree about a book. (`readingGeneration` reads the STEP first, and the
       * project record only for a project that has no read step at all — but a
       * step can be deleted, and the record left behind should still be about the
       * reading that happened rather than about one before it.)
       *
       * ITS PARENT IS THE IMPORT AND NOT THE POSITION, which is the one action
       * where those differ — see `originOf`. A reading reads the PIXELS, and the
       * pixels are in `archive/` however far through their own history the person
       * pressing OCR happens to be standing. Parented at the position it would
       * append a reading made FROM a reading the moment anybody re-read a book
       * while looking at it, and every one of those steps would name the single
       * bank file the engine writes.
       *
       * WHAT WAS ASKED FOR IS RECORDED SEPARATELY FROM WHAT CAME BACK, and the
       * two piles decide different things. `generation`, `pages` and `completedAt`
       * are the run's own answer — one minted by the pass, one counted off the
       * finished bank, one read off the marker the engine left beside it — and all
       * three are excluded from the re-run comparison (`MINTED_BY_THE_RUN`): a
       * re-read mints a new generation by design, so comparing it would make every
       * re-read look like a new question and leave the project holding two banks
       * where the user asked for one. The page skips and the language are the
       * QUESTION, so they are what decides append-or-replace, and a re-read of the
       * same request replaces while one asking for a different range branches.
       *
       * A REPLACE STALES EVERYTHING DOWNSTREAM, which `recordLanding` does: the
       * saves made against the previous bank name blocks by numbers that mean
       * different blocks now, and the translations of those saves were of blocks
       * that have moved. They stay in the list, dimmed and clickable, because each
       * still has its own payload and that payload is still a true record of
       * something.
       */
      const landing = await landStep(manifest, {
        action: 'read',
        parent: originOf(ledgerOf(manifest))?.id ?? null,
        /*
         * WHERE THE ENGINE ACTUALLY WROTE, and not a path composed from the key.
         *
         * It used to be `readings/<key>.jsonl` spelled out here, which was true
         * while a project had one bank and became a lie the moment a re-read could
         * branch into a bank of its own. The run was handed a path
         * (`bankForReading`) and filled that file; the step is the record of what
         * that run produced, so it names the file the run produced. A composed path
         * would be this function's second opinion about a decision made hours ago.
         *
         * Spelled with forward slashes and relative to the project, which is what
         * `LedgerStep.payload` is and what `destroyPayload` splits again to reach
         * the file — so nothing here ever matches by basename.
         */
        payload: path.relative(dir, resolved).split(path.sep).join('/'),
        // `askedOf` trims and drops, so that "asked for nothing" has ONE spelling
        // here and at the plan that named the bank. Two spellings would be two
        // questions to `reRunTarget` — the same book read twice, branching because
        // one of them recorded the empty string somebody's cursor left behind.
        params: {
          generation,
          pages,
          // Absent rather than 0 for a run whose marker could not be read: see
          // `readReading` for why those two are different statements, and
          // `generationInEffect` for what an absent one means to the next reader.
          ...(completedAt !== null ? { completedAt } : {}),
          ...askedOf(asked),
        },
        createdAt: Date.now(),
        ...(stepId !== undefined ? { id: stepId } : {}),
      });
      await writeManifest(dir, manifest);
      /*
       * The swap has landed, so the file the old step named may go — and only now.
       *
       * NULL IS STILL THE ORDINARY ANSWER and now for the right reason. It used to
       * be null because every reading composed one path, so a re-read wrote where
       * the previous one had and there was nothing left to unlink; it is null today
       * because a replace was AIMED at the target step's own payload before the job
       * was enqueued (`bankForReading`), so the path genuinely did not move.
       *
       * WHAT MAKES IT DO REAL WORK is the one case where a path can drift between
       * the plan and the landing: a run planned as a branch — its bank minted as
       * `readings/<key>.<id8>.jsonl` — landing as a replace, because the step it
       * would have branched beside was deleted while it ran, or because another
       * reading of the same question landed first. The step keeps its place and
       * takes the new path, and the bank it used to name is now a file no row in
       * this project points at. `namesPayload` is what proves that, by the whole
       * project-relative path, before a byte is destroyed.
       */
      if (landing?.displaced != null) await destroyPayload(dir, landing.displaced);
    });
    // The one that puts the waiting light out. Home and the dock are drawn from
    // the listing, and until this is heard they both go on asking for a step
    // that has just been taken.
    announceProjects();
  } catch (err) {
    console.error(
      `[projects] ${path.basename(dir)} could not record its reading (${(err as Error).message}). `
      + 'The bank is on disk and the engine\'s completion marker is beside it, which is what the '
      + 'library screen falls back to.',
    );
  }
}

/**
 * The engine's completion marker for one bank: `<bank>.completed.json`, beside it
 * and named for it.
 *
 * SPELLED HERE RATHER THAN IMPORTED, and that is the rule rather than an
 * oversight — this app never imports the engine, it spawns it. The engine's own
 * `completionMarkerPath` (src/vlm/readings.ts) composes exactly this, and the
 * paragraph above it says why the name has to come off the BANK rather than off
 * its directory: one `readings/` folder held two books' banks once, one marker
 * sat in it, and the run asked about the other book archived a finished bank and
 * paid for a hundred pages again.
 */
function completionMarkerFor(bankPath: string): string {
  return `${path.resolve(bankPath).replace(/\.jsonl$/i, '')}.completed.json`;
}

/**
 * When the run that filled this bank said it finished — epoch milliseconds — or
 * null when nothing beside the bank says.
 *
 * ── What this is for, and why a number ──────────────────────────────────────
 *
 * It is the only fact on disk that moves when a bank is READ AGAIN and stays put
 * when one is merely re-rendered, now that no bank is ever archived. A run swaps
 * its finished pending bank into place and writes a fresh marker; a Generate
 * touches neither. So the stamp recorded beside a generation and the stamp on
 * disk disagreeing is exactly "these are different answers about the same pages",
 * which is what the generation exists to notice (`generationInEffect`).
 *
 * `completedAt` IS AN ISO STRING IN THE FILE and a number here. The engine writes
 * an instant, and an instant compared as text is a comparison that a change of
 * timezone spelling or of trailing zeros could break — `Date.parse` gives the
 * milliseconds back exactly, and epoch milliseconds is what every other time in
 * this catalogue already is.
 *
 * NULL FOR EVERY KIND OF SILENCE: no marker, unreadable, not JSON, no
 * `completedAt`, or one that is not a date. All of them mean the same thing to
 * the caller — there is no evidence here — and the caller's answer to no evidence
 * is to leave the generation exactly as it stands. A marker this app cannot read
 * must never be allowed to invent a re-read that did not happen.
 */
async function markerStamp(bankPath: string): Promise<number | null> {
  let parsed: unknown;
  try {
    parsed = readJson(await fsp.readFile(completionMarkerFor(bankPath), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const said = (parsed as Record<string, unknown>)['completedAt'];
  if (typeof said !== 'string') return null;
  const at = Date.parse(said);
  return Number.isNaN(at) ? null : at;
}

/**
 * The name of the file in `archive/`, or null when this project has none.
 *
 * The one accessor for the source of record. `workspace.ts` turns it into a path
 * to hand the engine; nothing else needs it, and nothing at all writes there.
 */
export async function archiveFileOf(dir: string): Promise<string | null> {
  try {
    return (await readManifest(dir)).archive?.file ?? null;
  } catch {
    // A catalogue that will not parse cannot name its archive. The caller falls
    // back to the document it was given, which is what that project has.
    return null;
  }
}

/**
 * Give the project the book's own title, once something can read one.
 *
 * A project is born named after a filename, because that is all a scan offers
 * before it has been read. The cast EPUB carries a `dc:title`, and a library
 * whose rows read "Working Towards The Fuhrer. Kershaw, Ian. (1993)" is worse
 * than one whose rows read "Working Towards the Führer". Written only when it
 * CHANGES, so opening a book is not a manifest write.
 *
 * THE STEM DOES NOT MOVE WITH IT. Files keep the names they were written under —
 * a catalogue that renamed a book's files behind the user is a catalogue that
 * breaks every path anything else is holding.
 */
export async function noteProjectTitle(dir: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return;
  try {
    await withManifest(dir, async (manifest) => {
      if (manifest.title === trimmed) return;
      manifest.title = trimmed;
      await writeManifest(dir, manifest);
      // Only when it MOVED. This is called on every open of every book, and a
      // listing re-read per open would be a directory walk for a title that was
      // already right.
      announceProjects();
    });
  } catch (err) {
    // A display name is not worth failing an open over; it is still named.
    console.error(`[projects] ${dir} could not record its title: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// What Home lists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every project, newest-opened first, each with the documents inside it.
 *
 * ONE ROW PER DOCUMENT, not one per file. The scan the user imported is one row
 * — the live copy in `working/` — and the archive behind it is this app's
 * bookkeeping, reachable through Reveal. What has been MADE from that scan is a
 * row each: the cast EPUB, a translation, the plain text, and the book reprinted
 * as real text in a PDF. That last one used to be folded into the scan's row,
 * back when it WAS the scan with a layer over it; it is a different document
 * now, and a document a person cannot see is a document they cannot open.
 *
 * THE BOOK ITSELF IS ONE OF THE DOCUMENTS. What a project has been used to make
 * is the interesting question, but it is not the only one, and a project that
 * has only ever been imported still has something to open. See the fallback at
 * the end of `summarise`.
 *
 * A project whose catalogue will not parse is STILL LISTED, carrying the reason
 * — Home is the only door back to a book, and a row that silently disappears
 * leaves a person hunting for something that "was there yesterday". It offers no
 * documents, because enumerating them would mean guessing at roles the catalogue
 * was the only record of.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsDir();
  let entries: string[];
  try {
    entries = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No projects directory yet is the ordinary state of a fresh install.
    return [];
  }

  const summaries = await Promise.all(entries.map((name) => summarise(path.join(root, name), name)));
  return summaries.sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * The live PDF the catalogue names — or the one on disk that it forgot.
 *
 * ── Why a listing reconciles instead of trusting itself ─────────────────────
 *
 * A project on this machine came up with `working.files: []` and a perfectly
 * good `working/<book>.pdf` sitting beside it, because a bug in the document
 * delete struck the row out without removing the file (see `deleteDocument`).
 * Under the step model the PDF row is built FROM that entry, so the catalogue's
 * answer to "what does this project have" was: nothing. A user whose book had
 * vanished from an app that was still storing every byte of it.
 *
 * The bug is fixed. This exists because fixing a bug does not repair the data it
 * already wrote, and because it is not the only way to reach that state — a
 * crash between the manifest write and the file copy, a file restored by hand
 * from a backup, and a folder synced from another machine all land there too.
 *
 * SO THE DISK IS THE AUTHORITY ABOUT WHAT EXISTS and the catalogue is the
 * authority about what it MEANS. A working copy present with no row is adopted
 * with the only provenance that can be inferred — the archive, which is where an
 * unrecorded working PDF must have come from — and the repair is logged, because
 * an app that silently papers over a hole in its own bookkeeping is an app whose
 * bookkeeping nobody can ever trust again.
 *
 * ── Why here, and why it does not write ─────────────────────────────────────
 *
 * IN `summarise`, not in the migration: the migration only ever runs on a v1
 * catalogue, and this hole is reachable at any version. Not in a repair pass
 * either, because a repair pass is a thing somebody has to remember to run, and
 * the failure it prevents is a book that is invisible RIGHT NOW.
 *
 * It returns the row rather than writing it, so a listing stays a read. The
 * repair is re-derived on every list — which costs one `exists` — and reaches
 * disk the next time anything edits the project for a reason of its own. A read
 * path that rewrote every catalogue it inspected would make opening Home a
 * write across the whole library.
 */
async function reconcileLivePdf(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectWorkingFile | null> {
  const recorded = manifest.working.files.find((row) => row.kind === 'pdf') ?? null;
  if (recorded !== null) return recorded;
  if (manifest.archive === null || manifest.archive.kind !== 'pdf') return null;

  const file = `${manifest.stem}.pdf`;
  if (!await exists(path.join(dir, WORKING, file))) return null;

  console.warn(
    `[projects] ${path.basename(dir)}: ${WORKING}/${file} is on disk with no catalogue row. `
    + 'Listing it anyway — a document this app is storing must not be one it will not show.',
  );
  return {
    file,
    kind: 'pdf',
    // The only provenance that can be inferred. An unrecorded working PDF came
    // from the import: a promoted one would have been recorded by the promotion.
    from: `${ARCHIVE}/${manifest.archive.file}`,
    madeAt: manifest.createdAt,
  };
}

async function summarise(dir: string, name: string): Promise<ProjectSummary> {
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(dir);
  } catch (err) {
    return {
      key: name,
      dir,
      title: name,
      createdAt: 0,
      openedAt: 0,
      documents: [],
      // Nothing can be said about the reading of a project whose catalogue will
      // not parse, and "OCR this" is a suggestion — lighting it here would be
      // offering a next step for a folder this app cannot describe.
      reading: { done: false, needed: false, pages: 0 },
      filed: false,
      // Nothing can be listed out of a catalogue that will not parse, and guessing
      // at a tray by reading the directory would offer files this app cannot say
      // it made. The row offers Reveal, which is the honest door into a folder.
      exports: [],
      // No ledger was read, so no reading can be named, and nothing can say which
      // reprint belongs to which pass.
      facsimiles: [],
      problem: (err as Error).message,
    };
  }

  /*
   * ── ONE ROW PER FILE TYPE ─────────────────────────────────────────────────
   *
   * This is where a project stops being a folder of files and becomes what the
   * user described: "each file type has its own row in the system… all they see
   * is the different available file types."
   *
   * A row is a KIND — the PDF, the EPUB, the text — and everything underneath it
   * is the chain that produced it. The chain is on disk already; what was
   * missing was a record of which file was which. A converted project holds the
   * archived original, the live PDF, the generated origin it was promoted from
   * and several rotated predecessors, and the person who asked for a searchable
   * book is owed "the PDF", once.
   *
   * WHAT THE ROW OPENS is the WORKING COPY where a type has one, and the latest
   * step's file otherwise. That distinction is the model's other half: the
   * chain records what was applied, the working copy is what the user touches,
   * and edits go to the copy rather than to any step. Only the PDF has a
   * separate working file today; an EPUB's working copy is the tree unpacked
   * from its latest step, which the reader makes on open.
   */
  const documents: ProjectDocument[] = [];
  const livePdf = await reconcileLivePdf(dir, manifest);

  for (const record of manifest.documents) {
    const steps = [...record.steps].sort((a, b) => a.appliedAt - b.appliedAt);
    const latest = steps[steps.length - 1];
    if (latest === undefined) continue;

    const working = record.kind === 'pdf' && livePdf !== null
      ? path.join(dir, WORKING, livePdf.file)
      : path.join(dir, ...latest.file.split('/'));
    documents.push({
      kind: record.kind,
      path: working,
      label: path.basename(working),
      at: latest.appliedAt,
      missing: !await exists(working),
      /*
       * `managed` asks whether losing this costs the user something they cannot
       * get back from their own folders, which is now a question the chain
       * answers directly: a row whose origin came from outside this program is
       * theirs and sits somewhere they chose. Everything else this app made.
       */
      managed: steps[0]?.retention !== 'irreplaceable',
      steps,
      // The book itself — deleting this row is deleting the project. See
      // `shared/original.ts`, where the rule it generalises lives.
      origin: steps[0]?.retention === 'irreplaceable',
    });
  }

  /*
   * ── THE SOURCE IS A DOCUMENT TOO ──────────────────────────────────────────
   *
   * The two loops above list what has been MADE from a book. That is the right
   * emphasis and it was the whole answer for exactly as long as every project
   * had a catalogued live copy — and then Owen clicked a book on Home and was
   * told "nothing has been made from this book yet" about a project whose PDF
   * was sitting in it. A row that offers nothing to open is a row that has
   * nothing to say: the one thing a person wants from a book they imported is
   * to open it.
   *
   * ONLY WHEN NOTHING ELSE REPRESENTS IT. A properly catalogued project already
   * lists its live PDF (from `working.files`) and its imported EPUB (from
   * `generated`, role `imported`), and a second row for the same book is the
   * confusion this file's "ONE ROW PER DOCUMENT" note exists to prevent.
   *
   * THE LIVE COPY IF THERE IS ONE, the archived original otherwise. The live
   * copy is what the user means by "the PDF" and is the layer this app edits;
   * the archive is never written, and offering it is a last resort — but a book
   * you can only open read-only is still infinitely more use than a row that
   * says the project is empty. Either way the label is a filename and the layer
   * it came out of is never named on screen.
   *
   * `managed` is false: this document is the user's own file, and it is in
   * `archive/` precisely because they still have it.
   */
  if (documents.length === 0 && manifest.archive !== null) {
    const liveFile = `${manifest.stem}${manifest.archive.kind === 'pdf' ? '.pdf' : '.epub'}`;
    const liveLayer = manifest.archive.kind === 'pdf' ? WORKING : GENERATED;
    const live = path.join(dir, liveLayer, liveFile);
    const origin = path.join(dir, ARCHIVE, manifest.archive.file);
    const onDisk = await exists(live);
    const step: ProjectStep = {
      file: `${ARCHIVE}/${manifest.archive.file}`,
      label: manifest.archive.kind === 'pdf' ? 'The scan you imported' : 'The book you imported',
      appliedAt: manifest.createdAt,
      kind: 'origin',
      retention: 'irreplaceable',
        why: WHY_IMPORTED,
    };
    documents.push({
      kind: manifest.archive.kind,
      path: onDisk ? live : origin,
      label: onDisk ? liveFile : manifest.archive.file,
      // The project's own age. Nothing recorded when this file arrived, because
      // until now nothing listed it.
      at: manifest.createdAt,
      missing: !onDisk && !await exists(origin),
      managed: false,
      steps: [step],
      origin: true,
    });
  }

  const openedAt = documents.reduce(
    (newest, row) => Math.max(newest, openedAtFor(row.path) ?? 0),
    0,
  );

  return {
    key: manifest.key,
    dir,
    title: manifest.title,
    createdAt: manifest.createdAt,
    openedAt: openedAt > 0 ? openedAt : manifest.createdAt,
    documents,
    reading: await readingState(dir, manifest),
    filed: manifest.final.length > 0,
    exports: await filedDocuments(dir, manifest),
    facsimiles: await facsimilesOf(dir, manifest),
    problem: null,
  };
}

/**
 * What this project has FINISHED — the rows the left nav lists under it.
 *
 * ── Why the paths come out project-relative ─────────────────────────────────
 *
 * `manifest.final` stores a bare NAME, because the folder is implied by the field
 * it is in. That is right for a catalogue and wrong for something crossing a wire:
 * a project holds `archive/Book.pdf`, `working/Book.pdf`, `generated/Book.pdf` and
 * now `final/Book.pdf`, and a renderer handed four bare names would have to compose
 * the layer back on — which is the same thing as matching by basename, one process
 * further out. So the layer travels WITH the name and the renderer joins it to the
 * project directory it already has.
 *
 * ── Why a row whose file has gone is not listed ─────────────────────────────
 *
 * `final/` is the user's own tray. They may move a book onto a reader, hand it to
 * somebody, or delete it, and none of those is this app's business to prevent or to
 * notice — but a nav row that opens nothing is the app asking somebody to click a
 * thing it knows is not there. `documents` above already pays one `exists` per row
 * for the same reason; exports are few, and the stat is what makes the list true.
 *
 * NEWEST FIRST, because the export somebody is looking for is nearly always the one
 * they just made.
 */
async function filedDocuments(dir: string, manifest: ProjectManifest): Promise<ProjectFinal[]> {
  const rows = [...manifest.final].sort((a, b) => b.madeAt - a.madeAt);
  const listed: ProjectFinal[] = [];
  for (const row of rows) {
    if (!await exists(path.join(dir, FINAL, row.file))) continue;
    listed.push({ ...row, file: `${FINAL}/${row.file}` });
  }
  return listed;
}

/**
 * Has this book been read, and does it still need to be?
 *
 * ── Two sources, and neither is enough on its own ───────────────────────────
 *
 * THE CATALOGUE says when a reading landed, because `recordReading` wrote it
 * there when the job finished. It is the cheap answer and the one with a page
 * count in it. It is also blind to every bank this app did not fill: a `foundry
 * vlm-read` run from a terminal, a project folder copied from another machine, a
 * library adopted from the old flat layout.
 *
 * THE ENGINE'S MARKER — `readings/<key>.completed.json` — is the other half. It
 * is the engine's own statement that it read every page it was asked for, it
 * sits beside the bank, and it is written by whatever ran the reading and
 * wherever it ran. One `exists` per project, which is what makes this affordable
 * on a screen that redraws whenever it comes back.
 *
 * NOT `countBankPages`. That streams every `.jsonl` under `readings/` counting
 * newlines, which is right for a delete confirmation somebody opened on purpose
 * and wrong for a library listing — it would make Home slower the more books a
 * person owned, which is the opposite of what a library is for.
 *
 * ── And `needed` is narrower than "not done" ────────────────────────────────
 *
 * A project started from an EPUB has no pages to photograph and never wanted
 * this step. Lighting OCR on it would be the app naming a next step that does
 * not exist for that book.
 */
async function readingState(
  dir: string,
  manifest: ProjectManifest,
): Promise<ProjectSummary['reading']> {
  const recorded = manifest.reading !== null && manifest.reading.readAt > 0;
  /*
   * THE POSITION'S BANK, ASKED FOR RATHER THAN COMPOSED. This line spelled
   * `readings/<key>.jsonl` out of the project key — the exact composition
   * `readingBank`'s header forbids and for its exact reason: a re-read of a
   * different page range branches into a bank of its own, so a project can hold
   * two readings, and while this composed the first one's path a position
   * standing on a BRANCH that never finished answered "done" out of the original
   * reading's marker. The dialog it opens is the one with the Generate button in
   * it, so the composition was an offer to render a book from a bank the plan was
   * never going to name.
   */
  const banked = readingBank(dir, manifest);
  const done = recorded
    // `completionMarkerFor` rather than the name composed a second time here: two
    // spellings of one file is two answers the day either of them changes.
    || await exists(completionMarkerFor(banked))
    /*
     * AND A BANK WITH ANSWERS IN IT, which is the third source: a bank can
     * arrive without a completion marker — a copy somebody moved in by hand,
     * an interrupted run — and a marker's absence must not make paid-for
     * pages read as "not read yet", with an OCR light asking the user to buy
     * them again.
     *
     * So the bank itself is asked. A file with bytes in it is a file the model
     * put page answers into, and NEVER RE-PAYING for those is the rule that
     * outranks knowing whether the last page was reached. A bank with a hole in
     * it renders a book with that hole named in the run's own log, which is the
     * behaviour the engine already has and the right one.
     *
     * BY SIZE AND NOT BY LINE COUNT: this runs for every project every time the
     * library is listed, and streaming every bank to count newlines would make
     * Home slower the more books somebody owns. The page count in a row comes
     * from the catalogue, which is where a number belongs.
     *
     * A bank being filled RIGHT NOW reads as done. That is deliberate: the queue
     * is what says a reading is in progress, and it is on screen while it is.
     */
    || await hasBytes(banked);
  return {
    done,
    needed: !done && manifest.archive?.kind === 'pdf',
    pages: recorded ? manifest.reading?.pages ?? 0 : 0,
  };
}

/** Is there a file there with anything in it? Missing and empty are one answer. */
async function hasBytes(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).size > 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deleting one — the only place in this app where something really goes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prove `dir` is a project directory, and hand it back resolved. Or refuse.
 *
 * THIS IS A SECURITY BOUNDARY, not a tidiness check, and it is worth being blunt
 * about why. `deleteProject` calls `fsp.rm(dir, { recursive: true })`. The `dir`
 * it is given came across IPC from the renderer — a page that runs a book's own
 * markup in an iframe and an OpenAI-compatible endpoint's answers through a
 * parser. Every other door in this app that touches a path the renderer named
 * asks main's own allow-list first (`admitted`, electron/documents.ts) precisely
 * because a
 * renderer's word is not an authorization. This function is the whole of that
 * gate for the one call that erases directories, so if it is wrong, an argument
 * of `C:\Users\tellt` is a recursive delete of a home folder.
 *
 * A DIRECT CHILD, not a descendant. `projectDirOf` above answers "which project
 * is this path in", which is the right question for reading and the wrong one
 * here: it maps `…/projects/<key>/working/<tree>/EPUB` to the project, and a
 * containment test built on it would happily accept a path that is not a project
 * at all. What may be deleted is exactly the thing Home lists — one segment
 * under `projectsDir()` — so the test is that `path.relative` from the root
 * yields exactly ONE segment. That rejects the root itself (empty), anything
 * above it (`..`), anything on another drive (`path.relative` returns an absolute
 * path across Windows volumes), and every path deeper than a project.
 *
 * `path.resolve` first, so `.` and `..` inside the argument are spent before the
 * comparison rather than after it — a string test against an unresolved path is
 * the classic way this check gets defeated.
 *
 * NO EXCEPTIONS. If something ever needs to erase a directory that is not a
 * project, it does not get to reach it through here.
 *
 * THE STEP-LEDGER CALLS ASK IT TOO, and that is the check being used for exactly
 * what it is rather than being widened. `deleteStep` unlinks payload files inside
 * a directory the renderer named, which is the same authorization problem one
 * level down, and its describe/read/go siblings ask the same question so that no
 * member of that family is the lenient way in — a gate that only guards the
 * destructive call is a gate somebody routes around by reading first.
 */
function deletableProjectDir(dir: string): string {
  const root = projectsDir();
  const resolved = path.resolve(dir);
  const inside = path.relative(root, resolved);
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside)
    || inside.split(path.sep).length !== 1) {
    throw new ProjectError(
      `${resolved} is not one of Foundry's projects — those are the directories directly inside `
      + `${root}, and nothing else may be deleted. Refusing to erase it.`,
    );
  }
  return resolved;
}

/** What is in a project, for the sentence that asks whether to erase it. */
export interface ProjectInventory {
  /** The directory, resolved and PROVEN to be one this app may delete. */
  dir: string;
  /** The book's own title where anything has read one, the key otherwise. */
  title: string;
  /**
   * Pages the model has already read and answered for, across every bank in
   * `readings/` — including the ones a re-cast rotated into `archived-<stamp>/`.
   *
   * THE ONE NUMBER THE DIALOG EXISTS TO SAY. Everything else in a project can be
   * made again from something: the archive is a copy of a file the user still
   * has, the working tree unpacks from the origin, the final edition rebuilds
   * from the working tree. A bank is GPU-hours and there is no second source for
   * it anywhere on disk, so a person deleting one should be told how many.
   */
  readings: number;
  /**
   * How many documents this project has — the scan, the book, translations.
   *
   * COUNTED BY ASKING `summarise`, which is the function Home's rows come from,
   * because the two numbers have to be the same number. It used to count
   * `manifest.documents` directly and was wrong for every PDF-only project in the
   * library: those carried an empty `documents` list (see `healImport`) and were
   * drawn from `summarise`'s archive fallback, so Home showed a book and the
   * delete card, one click later, said "nothing has been made from it yet" about
   * the same folder.
   *
   * A second count is how two screens come to disagree about one directory. This
   * costs a manifest read and a handful of `exists` calls on a path somebody
   * opened a confirmation dialog on, which is nothing.
   */
  documents: number;
  /** True once anything has been filed into `final/`. That copy is in here too. */
  filed: boolean;
  /** Everything under the directory, in bytes. A scan is most of it. */
  bytes: number;
  /**
   * Corrections a PERSON made about the blocks on the pages — every amendment in
   * every overlay under `overlays/`, archived ones included.
   *
   * THE SECOND NUMBER THIS DIALOG EXISTS TO SAY, and by the retention rule
   * (`ProjectStep.retention`) it is the more expensive of the two. A readings
   * bank is `expensive`: hours of GPU, and a machine can make it again. A
   * curation is `irreplaceable` — somebody looked at four hundred pages and said
   * what was on them, and nothing on this disk or any other can reproduce that.
   */
  amendments: number;
}

/**
 * Read a project for the delete confirmation, without touching a thing.
 *
 * Checks the path FIRST, before it reads a byte, so a caller that named
 * something that is not a project is refused by the same sentence whether it got
 * as far as the dialog or not.
 *
 * A CATALOGUE THAT WILL NOT PARSE IS NOT FATAL HERE, and that is the one place
 * in this file where that is true. Everywhere else a bad `project.json` stops
 * the operation because the operation depends on knowing what is in the folder;
 * delete depends on nothing but the folder existing, and a project whose
 * catalogue is broken is exactly the project a person most wants to be rid of.
 * The row on Home already carries the reason, and the title falls back to the
 * directory's own key.
 */
export async function inspectProject(dir: string): Promise<ProjectInventory> {
  const resolved = deletableProjectDir(dir);
  let manifest: ProjectManifest | null = null;
  try {
    manifest = await readManifest(resolved);
  } catch {
    manifest = null;
  }
  return {
    dir: resolved,
    title: manifest?.title ?? path.basename(resolved),
    readings: await countBankPages(path.join(resolved, 'readings')),
    // THE ROWS HOME DREW, from the function that drew them. See the field's own
    // note: counting the catalogue instead said "nothing has been made from it"
    // about every project the user had ever imported a scan into.
    documents: manifest === null
      ? 0
      : (await summarise(resolved, path.basename(resolved))).documents.length,
    filed: (manifest?.final.length ?? 0) > 0,
    bytes: await measure(resolved),
    /*
     * BOTH FOLDERS, because a project delete destroys both.
     *
     * `curations/` did not exist when this number was written and it holds the
     * same thing `overlays/` does — a person's decisions about the blocks on the
     * pages — frozen, retained, and named by a step. A card that counted only the
     * live pair would quietly under-report the irreplaceable half of what is about
     * to be erased, which is the one direction this sentence must never be wrong
     * in.
     *
     * A SNAPSHOT'S DECISIONS OVERLAP THE LIVE FILE'S and are counted anyway, which
     * is what this number has always been: every amendment in every curation file
     * under the project, not a count of distinct decisions. What the figure
     * conveys is how much recorded judgement is in this folder, and every one of
     * those snapshots is a separate thing that will not exist afterwards.
     */
    amendments: await countAmendments(curationsDir(resolved)),
  };
}

/**
 * Amendments in every overlay under `dir`, by counting them.
 *
 * PARSED RATHER THAN LINE-COUNTED, which is the opposite of `countBankPages` and
 * for the opposite reason: a bank is one JSON object per line so its newlines ARE
 * its pages, while an overlay is one JSON document whose lines are formatting. It
 * is also small — a heavily curated book is a few hundred amendments — so reading
 * it whole costs nothing worth avoiding.
 *
 * A file that will not parse counts as nothing. The number informs a question,
 * and a delete button that does not work because a count failed is worse than a
 * count that is low.
 */
async function countAmendments(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // No overlays: nobody has corrected this book.
  }
  let amendments = 0;
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    // Recursive, because `archived-<stamp>/` overlays are somebody's work too —
    // they are kept precisely because a re-read must never destroy a curation,
    // and a project delete is about to destroy every one of them.
    if (entry.isDirectory()) {
      amendments += await countAmendments(here);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      try {
        const parsed: unknown = readJson(await fsp.readFile(here, 'utf8'));
        const list = (parsed as { amendments?: unknown })?.amendments;
        if (Array.isArray(list)) amendments += list.length;
      } catch { /* not an overlay this app can read; not a reason to fail a dialog */ }
    }
  }
  return amendments;
}

/**
 * Erase the whole project directory. There is no undo and nothing is kept.
 *
 * THROUGH THE EDIT CHAIN (`edits`), not around it. A background
 * `noteProjectTitle` or a job recording its output can be mid-write when this
 * runs, and a manifest write that lands after the `rm` would recreate the
 * directory with a lone `project.json` in it — a ghost project on Home naming a
 * book with no files. Queuing behind whatever is in flight costs nothing;
 * projects are edited perhaps twice a minute.
 *
 * It reads no manifest to get there, deliberately: `withManifest` would refuse a
 * project whose catalogue does not parse, and those are deletable too.
 *
 * `force: true` so a directory that is already half gone — an earlier delete
 * that hit a locked file — finishes rather than refusing. The path check has
 * already run and runs again here; being generous about a missing file is not
 * being generous about which directory this is.
 *
 * RETRIED, AND THEN LOUD, because Windows makes deletion a race against
 * whoever is READING. `rm` walks the tree and dies at the first file some
 * process holds open without delete-sharing — this app's own window showing a
 * figure was enough — and a delete that dies mid-walk leaves a partial
 * directory that LOOKS deleted from Home. The same book imported again then
 * lands on this exact name-keyed path, on top of the debris, and the leftovers
 * resurface inside a project that believes itself fresh. The retries ride out
 * the transient holds; a hold that outlasts them is a real answer, and it is
 * thrown as a sentence naming the directory rather than as a bare errno,
 * because the fix is on the other end of a window somebody has open.
 */
export async function deleteProject(dir: string): Promise<void> {
  const resolved = deletableProjectDir(dir);
  const key = resolved.toLowerCase();
  const previous = edits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* see withManifest — a failed edit must not block this */ })
    .then(async () => {
      try {
        await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (err) {
        throw new ProjectError(
          `${resolved} could not be fully deleted (${(err as Error).message}). Something on this `
          + 'machine is holding one of its files open — a window showing it, a sync client, an '
          + 'antivirus scan. Close it and delete the project again; what was already removed '
          + 'stays removed.',
        );
      }
      // The rm resolving is not the directory being gone — `force` swallows
      // whole classes of per-file refusals — and a delete that reports success
      // over a surviving directory is how debris ends up inside the next
      // import of the same book.
      if (await exists(resolved)) {
        throw new ProjectError(
          `${resolved} is still there after the delete — something on this machine is holding one `
          + 'of its files open (a window showing it, a sync client, an antivirus scan). Close it '
          + 'and delete the project again; what was already removed stays removed.',
        );
      }
    });
  edits.set(key, next);
  await next;
  // Nothing may queue behind a directory that is gone: the same book imported
  // again lands on this exact path (the key is of its content), and a fresh
  // project chained after this promise would be waiting on a delete for no
  // reason anybody could find later.
  if (edits.get(key) === next) edits.delete(key);
}

/**
 * The project a FILE belongs to, proven rather than assumed.
 *
 * `deletableProjectDir`'s gate, one level out: what may be deleted here is a file
 * strictly INSIDE one of Home's projects, so the test is that `path.relative`
 * from `projectsDir()` yields two segments or more and the first of them is a
 * project. That rejects the root, anything above it, anything on another volume,
 * a project directory itself (which is `deleteProject`'s business and not this
 * one's), and every arbitrary path a renderer might name.
 *
 * THE SAME REASONING AS `deletableProjectDir`, AND FOR THE SAME REASON. This is
 * the whole of the gate on a call that unlinks a file whose path came across IPC
 * from a page that runs a book's own markup in an iframe. A renderer's word is
 * not an authorization here either.
 */
function deletableDocumentPath(filePath: string): { dir: string; resolved: string } {
  const root = projectsDir();
  const resolved = path.resolve(filePath);
  const inside = path.relative(root, resolved);
  const parts = inside.split(path.sep);
  if (inside.length === 0 || inside.startsWith('..') || path.isAbsolute(inside) || parts.length < 2) {
    throw new ProjectError(
      `${resolved} is not a document inside one of Foundry's projects — those live under `
      + `${root}, and nothing else may be deleted. Refusing to erase it.`,
    );
  }
  return { dir: path.join(root, parts[0]!), resolved };
}

/**
 * What ELSE goes when one document is deleted — counted, so the card can say so.
 *
 * ── What is in here, and the evidence for each ──────────────────────────────
 *
 * ARCHIVED PREDECESSORS. `rotateGenerated` moves `generated/<file>` aside into
 * `generated/archived-<stamp>/<file>` before a rerun writes, so those are
 * previous versions of THE VERY FILE being deleted — five of them in the
 * Kershaw project from one evening's reruns. Matched by basename inside the
 * file's own parent directory, which is exact rather than approximate: an output
 * name is derived from the project's stem and its format (`generatedFileFor`),
 * so at most one live document can carry a given basename, and every archived
 * copy of that name is a former life of it.
 *
 * AND THAT IS THE WHOLE LIST NOW. Two other things used to be in it and both went
 * with the surfaces that made them (docs/RENDERER.md §7): the unpacked working
 * TREE a rotation parked beside the file, and `history/<tree>.json`, the block
 * editor's undo ledger keyed to that tree. Nothing writes either any more; a
 * project that still holds one keeps it, because sweeping somebody's records to
 * tidy a folder is not a thing this app does.
 *
 * ── What is NOT in here, and these are decisions ────────────────────────────
 *
 * THE READINGS BANK, above all — and it is the COST RULE in its purest form
 * (`ProjectStep.retention`). `readings/` is the stored result of the expensive
 * pass: it belongs to the source book rather than to any output made from it,
 * it is hours of GPU, it cannot be remade from anything else on the disk, and it
 * is the entire reason a conversion can be run again for nothing. Deleting the
 * EPUB must never cost the bank — the whole point of throwing an output away is
 * usually to make a better one from the same readings. (Deleting the book's own
 * row is a different act: that is a project delete, it takes the bank with
 * everything else, and it says so in those words.)
 *
 * THE FILED COPY. `final/` is where the user themself put a copy on purpose
 * (`recordFinal`), which makes it theirs rather than the workspace's. A delete
 * of the working document that also went and destroyed the copy somebody
 * deliberately filed would be reaching outside what was asked for — the same
 * reason a Save As to a USB stick is left alone.
 *
 * THE OPS AND THE FROZEN CURATIONS (`ops/`, `curations/`), and this is the bank's
 * rule carried one step further. A decision about the book is not about the EPUB —
 * it is about the READING, keyed by block id rather than by any output: the two
 * hundred running heads somebody struck are struck for every future rendering as
 * much as for the one being deleted. And deleting an output in order to make a
 * better one is the ordinary reason to delete an output, which is exactly the case
 * where destroying the decisions would be worst. By the retention rule they are
 * `irreplaceable` where the bank is merely `expensive`; a project delete takes
 * them, says so in those words, and nothing else does.
 */
export interface DocumentAssets {
  /** Previous versions of this same file, rotated aside by earlier runs. */
  archivedVersions: number;
}

/** What became of a document that was asked to be deleted. */
export interface DocumentRemoval {
  /** The project's own title, for the sentence the notice strip shows. */
  title: string;
  /** The file's name, as the catalogue spelled it. */
  label: string;
  /** True when the bytes were already gone and only the row was cleared. */
  wasMissing: boolean;
  /** What went with it, so the notice can account for more than the one file. */
  assets: DocumentAssets;
}

/**
 * Erase one document out of a project: the file, and its row in the catalogue.
 *
 * BOTH, OR THE PROJECT LIES ABOUT ITSELF. A file removed without its row leaves
 * Home and the side nav listing a document that is not there — which is exactly
 * the "not there any more" state, and it is the right state for a file somebody
 * moved behind the app's back, but it is a silly thing to CREATE on purpose. A
 * row removed without the file leaves bytes in the folder nothing can reach.
 *
 * A FILE THAT IS ALREADY MISSING IS STILL REMOVABLE, and that is the decision
 * worth recording. Its row is the only thing left of it, the row is what the
 * user is looking at and asking to be rid of, and refusing on the grounds that
 * the file is already gone would leave them with a listing they cannot clean and
 * no way to understand why. `force: true` on the unlink makes the two cases one
 * code path; `wasMissing` is carried back so the sentence can say which happened.
 *
 * THROUGH THE EDIT CHAIN, like every other manifest write: a job recording its
 * output can be mid-write, and a manifest read here that lands between another
 * writer's read and its write would be lost with it.
 */
export async function deleteDocument(filePath: string): Promise<DocumentRemoval> {
  const { dir, resolved } = deletableDocumentPath(filePath);
  const wasMissing = !await exists(resolved);

  const label = path.basename(resolved);
  let title = path.basename(dir);
  let sweep: Sweep = emptySweep();

  await withManifest(dir, async (manifest) => {
    title = manifest.title ?? title;
    sweep = await planSweep(dir, resolved, manifest);

    /*
     * A ROW IS MATCHED IN ITS OWN LAYER, AND THIS IS A BUG FIX WITH A CASUALTY.
     *
     * It used to resolve a row's basename against `generated/`, `working/` AND
     * `final/` and delete the row if ANY of them equalled the path being
     * removed. Every list was tested against every layer, so a name that appears
     * in two layers — which is the ordinary case, since the live PDF is a COPY
     * of the generated one and carries the same filename — matched twice.
     *
     * Deleting `generated/<book>.pdf` therefore struck the `working/<book>.pdf`
     * row out of the catalogue as well, while `fsp.rm` removed only the file it
     * was actually given. That is exactly what happened to the Kershaw project
     * on this machine: `working.files` came back `[]` with the working PDF still
     * sitting on disk, and the app then had a book it was storing every byte of
     * and would not list. Item 2's reconciliation exists because of this, and
     * this is why it must never happen again.
     *
     * Each list now asks only about its own directory.
     */
    const inLayer = (layer: string) => (file: string): boolean =>
      path.resolve(dir, layer, file).toLowerCase() === resolved.toLowerCase();
    /*
     * THE WHOLE TYPE GOES, not one file out of it. A row is a file type and its
     * chain, so deleting the row deletes the type — every step in it, which is
     * exactly the set `planSweep` is about to remove from the disk. A chain with
     * a hole in it would be a history that lies.
     */
    const relative = path.relative(dir, resolved).split(path.sep).join('/');
    manifest.documents = manifest.documents.filter(
      (record) => !record.steps.some((step) => step.file === relative));
    manifest.working.files = manifest.working.files.filter((row) => !inLayer(WORKING)(row.file));
    manifest.final = manifest.final.filter((row) => !inLayer(FINAL)(row.file));
    await writeManifest(dir, manifest);
  });

  /*
   * The catalogue first, the bytes second. A manifest that still lists a file
   * this is about to remove is a recoverable inconsistency — the row shows as
   * "not there any more" and can be cleared; bytes with no row are a folder
   * nothing can account for.
   *
   * `force: true` throughout, so a file somebody moved behind the app's back and
   * a directory that is already half gone both finish quietly rather than
   * failing a delete the user has already confirmed.
   */
  await fsp.rm(resolved, { force: true });
  for (const target of sweep.files) await fsp.rm(target, { force: true });

  /*
   * An `archived-<stamp>/` folder that held nothing but this document's past
   * goes with it. Emptiness is the test rather than "we made it empty", because
   * one rotation folder can hold several documents archived in the same second
   * (`rotateGenerated` shares a stamp) — and one that still has a sibling's work
   * in it is somebody else's record, which this has no business removing.
   */
  for (const archive of sweep.archives) {
    try {
      const left = await fsp.readdir(archive);
      if (left.length === 0) await fsp.rmdir(archive);
    } catch { /* already gone, or not readable — either way not ours to force */ }
  }

  return { title, label, wasMissing, assets: countSweep(sweep) };
}

/** The paths one document's delete takes with it, resolved and ready to remove. */
interface Sweep {
  /** Archived copies of this same output. */
  files: string[];
  /** `archived-<stamp>/` folders to remove IF this emptied them. */
  archives: string[];
  /**
   * The count the card quotes, tallied AS THE PATHS ARE FOUND rather than
   * re-derived from them afterwards. Reading "is this a version?" back out of a
   * string is a guess about a filename; counting at the moment the thing is
   * identified is a fact, and the card is quoting this number to somebody about
   * to destroy it.
   */
  archivedVersions: number;
}

function emptySweep(): Sweep {
  return { files: [], archives: [], archivedVersions: 0 };
}

function countSweep(sweep: Sweep): DocumentAssets {
  return { archivedVersions: sweep.archivedVersions };
}

/**
 * Everything that belongs to this document alone, found rather than assumed.
 *
 * Nothing here deletes; it only looks. `documentAssets` uses it to tell the user
 * what a delete would take, and `deleteDocument` uses the same answer to take
 * it — so the card and the act cannot describe different things.
 */
async function planSweep(
  dir: string,
  resolved: string,
  manifest: ProjectManifest,
): Promise<Sweep> {
  const sweep = emptySweep();

  /*
   * THE PREDECESSORS, in the file's own directory. `generated/archived-<stamp>/`
   * for an output and `working/archived-<stamp>/` for a live copy are the same
   * convention in two places, so this looks beside the file rather than in a
   * named folder — whichever layer the document lives in, its past is rotated
   * into a sibling of it.
   */
  const label = path.basename(resolved);
  for (const archive of await archivesIn(path.dirname(resolved))) {
    let touched = false;
    const past = path.join(archive, label);
    if (await exists(past)) {
      sweep.files.push(past);
      sweep.archivedVersions += 1;
      touched = true;
    }
    if (touched) sweep.archives.push(archive);
  }
  return sweep;
}

/** The `archived-<stamp>/` directories directly inside `parent`. */
async function archivesIn(parent: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('archived-'))
    .map((entry) => path.join(parent, entry.name));
}

/**
 * What a delete of this document would take with it, for the card that asks.
 *
 * Reads the manifest directly rather than through the edit chain: this is a
 * question, it writes nothing, and a describe that queued behind a conversion
 * recording its output would leave the confirmation waiting on a job.
 */
export async function documentAssets(filePath: string): Promise<DocumentAssets> {
  const { dir, resolved } = deletableDocumentPath(filePath);
  try {
    return countSweep(await planSweep(dir, resolved, await readManifest(dir)));
  } catch {
    // A catalogue that will not parse still deletes; it just cannot promise
    // what else is in there. Saying "nothing extra" is the honest answer to a
    // question this project cannot be asked.
    return { archivedVersions: 0 };
  }
}

/** Every byte under `dir`, counted by walking it. Missing is zero, never a throw. */
async function measure(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let bytes = 0;
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      bytes += await measure(here);
    } else if (entry.isFile()) {
      // A file that vanished between the readdir and the stat is a file whose
      // size is no longer part of the answer, not a reason to fail a dialog.
      try {
        bytes += (await fsp.stat(here)).size;
      } catch { /* it went away */ }
    }
  }
  return bytes;
}

/**
 * Pages in every readings bank under `dir`, by counting the lines in them.
 *
 * A bank is one JSON object per line, one line per page (src/vlm/readings.ts), so
 * the newline count IS the page count. Counted by STREAMING and looking for
 * `\n` bytes rather than by parsing: a bank for a long book is megabytes, this
 * runs to put a number in a dialog, and nothing here cares what the answers say.
 *
 * Recursive, because `archived-<stamp>/` banks are hours of GPU too — a person
 * who re-cast a book twice has paid for those pages twice and is about to lose
 * both.
 */
async function countBankPages(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // No bank: this book has never been read by the model.
  }
  let pages = 0;
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      pages += await countBankPages(here);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      pages += await countLines(here);
    }
  }
  return pages;
}

function countLines(file: string): Promise<number> {
  return new Promise<number>((resolve) => {
    let lines = 0;
    const stream = createReadStream(file);
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const byte of bytes) if (byte === 0x0a) lines += 1;
    });
    // An unreadable bank is reported as no pages rather than as a failure. The
    // number is there to inform a question, and a dialog that will not open
    // because a count failed is a delete button that does nothing.
    stream.on('error', () => resolve(lines));
    stream.on('end', () => resolve(lines));
  });
}


/**
 * book-ledger (main process) — a pass takes a snapshot, or it is not undoable.
 *
 * ── One act with the rewrite ────────────────────────────────────────────────
 *
 * A pass rewrites the book IN PLACE (electron/processing-passes.ts): it moves
 * its output onto `outputs.epub` and appends an `appliedPasses` record. From
 * that instant the text it replaced exists nowhere, so if the user is ever to
 * take that pass back on its own, the copy has to be made THEN. This module is
 * that copy, plus the frozen diff and the manifest entry, done as one call
 * beside the rewrite — a snapshot taken later would be a snapshot of a book the
 * user has since edited.
 *
 * The pure part — what a ledger is, how deletion cascades, what to say about it
 * — is `shared/document/book-ledger.ts`. What is here is the part that needs a
 * filesystem and an EPUB parser.
 *
 * ── The guard, and why a refusal is RETURNED rather than thrown ─────────────
 *
 * The invariant the whole ledger rests on is that a ledger pass changes TEXT and
 * never element STRUCTURE, because the user's working changes are records keyed
 * to positions in the base's enumeration walk and they have to survive every
 * re-derivation. So the snapshot and the base are both walked, and an entry
 * whose snapshot enumerates a different number of elements in any file is
 * REFUSED: registering it would mean that deleting it, or deleting the working
 * changes, silently re-pointed every strike the user made at a different
 * paragraph.
 *
 * The refusal comes back as a sentence instead of an exception because by the
 * time it can be detected the pass HAS run and the book HAS been rewritten. The
 * user's simplify succeeded; what failed is the promise that it can be undone in
 * isolation. Throwing here would report a successful pass as a failed one and
 * send the user to re-run an hour of model time. The caller says the sentence
 * out loud instead — the pass appears in `appliedPasses` with no ledger row,
 * which is exactly the honest state every pass that ran before the ledger
 * existed is in.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import { enumerateNarrationElements } from './quire-stamp';
import { epubTreeSha256 } from './sidecar-binding';
import { ledgerEntryRelDir } from '../shared/document/book-ledger';
import type { AppliedPass, AppliedPassKind, LedgerEntry } from './manifest-types';

/** What a pass hands over: what it is called, and what it recorded. */
export interface LedgerPassRegistration {
  /** The pass kind, as `appliedPasses` spells it. */
  kind: AppliedPassKind;
  /** What the ledger row says, e.g. "Simplify". */
  label: string;
  /** The record the pass appended a moment ago, verbatim. */
  pass: AppliedPass;
}

/** Registered, or refused with the sentence that says why. */
export type LedgerRegistration =
  | { entry: LedgerEntry; refusal: null }
  | { entry: null; refusal: string };

/**
 * How many elements each spine document holds, in the ONE enumeration walk
 * everything in this app shares.
 *
 * Per FILE rather than a single total on purpose: two files that gained and lost
 * the same number of paragraphs would agree on a total and disagree about every
 * key after the change, which is the failure the guard exists to catch.
 */
async function elementCountsByFile(epubPath: string, whatFor: string): Promise<Map<string, number>> {
  const walked = await enumerateNarrationElements(epubPath, whatFor);
  return new Map(walked.map((doc) => [doc.file, doc.entries.length]));
}

/**
 * The first way the snapshot's enumeration differs from the base's, said in
 * full — or null when they agree.
 */
function enumerationDifference(base: Map<string, number>, snapshot: Map<string, number>): string | null {
  for (const [file, count] of base) {
    if (!snapshot.has(file)) return `${file} is not in the book any more`;
    const after = snapshot.get(file)!;
    if (after !== count) {
      return `${file} held ${count} element(s) before the pass and holds ${after} after it`;
    }
  }
  for (const file of snapshot.keys()) {
    if (!base.has(file)) return `${file} is a document the base book does not have`;
  }
  return null;
}

/** `01-simplify-3f2a9c11` — readable in a directory listing, unique on disk. */
function ledgerEntryId(position: number, kind: AppliedPassKind): string {
  return `${String(position).padStart(2, '0')}-${kind}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Record a pass in the book's ledger: snapshot the book it just produced, freeze
 * its diff beside the snapshot, and append the entry.
 *
 * Called immediately after the pass has replaced the book and appended its
 * `appliedPasses` record, and it reads the book from the manifest rather than
 * being handed a path — the snapshot must be the file the project CALLS its
 * book, not whatever the pass happened to write.
 *
 * FILES first, record last. An interrupt leaves a directory under
 * `source/ledger/` that nothing names, which is invisible and is swept away by
 * the next thing that supersedes the book; the other order would leave an entry
 * offering the user a way back to a snapshot that was never written.
 */
export async function registerLedgerPass(
  projectDir: string,
  registration: LedgerPassRegistration
): Promise<LedgerRegistration> {
  const book = await manifestService.readExportEpub(projectDir);
  if (book === null || !fs.existsSync(book.absPath)) {
    return {
      entry: null,
      refusal:
        `${registration.label} finished, but ${path.basename(projectDir)} records no book on disk `
        + 'for it to have been applied to, so no snapshot could be taken and the pass cannot be '
        + 'taken back on its own.',
    };
  }

  const base = await manifestService.workingCopySource(projectDir);
  if (base === null) {
    return {
      entry: null,
      refusal:
        `${registration.label} finished, but ${path.basename(projectDir)} has no archive-grade book `
        + 'behind its working copy, so there is nothing to check the pass against and no state for '
        + 'a deletion to go back to. The pass is recorded in the book\'s provenance; it cannot be '
        + 'taken back on its own.',
    };
  }

  // ── The invariant, measured against the BASE ──────────────────────────────
  //
  // Against the base rather than against the book as it stood a moment ago,
  // because the records that have to survive are keyed to the base's walk. A
  // structural edit made BEFORE this pass — a chapter-opening fold — is caught
  // here for the same reason and by the same comparison: the snapshot would
  // carry it in its bytes while the record that describes it can be cleared,
  // and a "go back to this" that silently reinstated a fold is not one.
  let difference: string | null;
  try {
    const [beforeCounts, afterCounts] = await Promise.all([
      elementCountsByFile(base.absPath, `${path.basename(projectDir)} base`),
      elementCountsByFile(book.absPath, `${path.basename(projectDir)} after ${registration.kind}`),
    ]);
    difference = enumerationDifference(beforeCounts, afterCounts);
  } catch (err) {
    return {
      entry: null,
      refusal:
        `${registration.label} finished, but its result could not be walked to check that it left `
        + `the book's structure alone: ${(err as Error).message}. No ledger entry was recorded — `
        + 'an entry that has not been checked is a promise this code cannot keep.',
    };
  }
  if (difference !== null) {
    return {
      entry: null,
      refusal:
        `${registration.label} finished, but it changed the book's STRUCTURE and not only its text `
        + `(${difference}). No ledger entry was recorded, so this pass cannot be taken back on its `
        + 'own: your deletions, strikes and chapter markers name elements by position, and a copy '
        + 'derived from a snapshot with a different set of elements would apply every one of them '
        + 'to the wrong paragraph. The pass itself is recorded in the book\'s provenance and its '
        + 'diff is where it always is.',
    };
  }

  const existing = await manifestService.readBookLedger(projectDir);
  const id = ledgerEntryId(existing.length + 1, registration.kind);
  const relDir = ledgerEntryRelDir(id);
  const absDir = manifestService.ledgerEntryDir(projectDir, id);
  await fs.promises.mkdir(absDir, { recursive: true });

  // ── The snapshot, of whichever container this book is in ──────────────────
  //
  // A book is a ZIP today and the working copy becomes an exploded DIRECTORY
  // (source/<base>.working/) so that editing one chapter writes one entry. The
  // snapshot is the same snapshot either way — a copy, proved to be the book it
  // was copied from — but a directory needs a recursive copy and a TREE digest
  // (`epubTreeSha256`: sha256 over `<name>\0<sha256 of its bytes>` for every
  // entry, sorted), because a directory has no bytes of its own to stream.
  //
  // The two digests are never compared to each other, only to another digest of
  // the SAME kind: a snapshot is proved against the book it was copied from, and
  // the two are always the same container. A tree snapshot is not named
  // `snapshot.epub` — a directory wearing a file's extension is the masquerade
  // this whole change is getting rid of.
  const bookIsTree = (await fs.promises.stat(book.absPath)).isDirectory();
  const snapshotName = bookIsTree ? 'snapshot' : 'snapshot.epub';
  const snapshotRel = `${relDir}/${snapshotName}`;
  const snapshotAbs = path.join(absDir, snapshotName);
  const digestOf = (target: string): Promise<string> => bookIsTree
    ? epubTreeSha256(target).then((identity) => identity.sha256)
    : manifestService.sha256OfFile(target);
  if (bookIsTree) {
    await fs.promises.cp(book.absPath, snapshotAbs, { recursive: true });
  } else {
    await fs.promises.copyFile(book.absPath, snapshotAbs);
  }
  const [bookDigest, snapshotDigest] = await Promise.all([
    digestOf(book.absPath),
    digestOf(snapshotAbs),
  ]);
  if (bookDigest !== snapshotDigest) {
    await fs.promises.rm(absDir, { recursive: true, force: true });
    return {
      entry: null,
      refusal:
        `${registration.label} finished, but its snapshot did not come out identical to the book it `
        + `was copied from (${bookDigest.slice(0, 12)} vs ${snapshotDigest.slice(0, 12)}). The `
        + 'snapshot has been removed and no entry was recorded — a snapshot that is not those bytes '
        + 'is not what this pass produced.',
    };
  }

  // ── The diff, frozen ──────────────────────────────────────────────────────
  //
  // Owen: "the diff is frozen in time when the [pass] ran". The pass writes it
  // into its stage directory, which every later rebuild of the book clears, so
  // the copy that belongs to this entry lives with the snapshot it describes. A
  // pass that recorded no diff — translate does not, deliberately — has none to
  // freeze, and null says exactly that rather than standing in for a file.
  let receipt: string | null = null;
  if (registration.pass.diff) {
    const fromAbs = path.resolve(projectDir, registration.pass.diff.split('/').join(path.sep));
    if (fs.existsSync(fromAbs)) {
      await fs.promises.copyFile(fromAbs, path.join(absDir, 'receipt.json'));
      receipt = `${relDir}/receipt.json`;
    } else {
      console.warn(
        `[book-ledger] ${path.basename(projectDir)}: ${registration.label} recorded its diff at `
        + `${registration.pass.diff}, and that file is not there, so the ledger entry has no frozen `
        + 'diff to offer for review.'
      );
    }
  }

  const entry: LedgerEntry = {
    id,
    kind: registration.kind,
    label: registration.label,
    createdAt: registration.pass.at,
    dir: relDir,
    snapshot: snapshotRel,
    snapshotSha256: snapshotDigest,
    receipt,
    // The provenance these bytes carry, pointed at the FROZEN diff: a derivation
    // from this snapshot puts this record back, and by then the stage directory
    // the pass wrote in has been cleared by the same act.
    pass: { ...registration.pass, ...(receipt === null ? {} : { diff: receipt }) },
  };
  await manifestService.appendLedgerEntry(projectDir, entry);
  console.log(
    `[book-ledger] ${path.basename(projectDir)}: ${registration.label} is entry ${id} in this `
    + `book's ledger — snapshot ${snapshotRel} (${snapshotDigest.slice(0, 12)})`
    + `${receipt === null ? ', no diff recorded' : `, diff frozen at ${receipt}`}.`
  );
  return { entry, refusal: null };
}

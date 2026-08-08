/**
 * working-copy — minting `<Original>.working.pdf` from the archive original.
 *
 * A project's archive original is IMMUTABLE, and curation has to write
 * somewhere: the picker's block annotations, page deletions and crops are PDF
 * incremental updates (working-document-writer.ts), and appending them to the
 * file the user imported would edit the thing the whole archive exists to
 * preserve. So there is a second file, and this is where it comes from.
 *
 * ── IT IS A COPY, AND NOTHING ELSE HAPPENS TO IT ────────────────────────────
 *
 * `cp` plus one small incremental update carrying the marker below. No foundry,
 * no Tesseract, no model, no text layer: the working copy is the original's
 * bytes, and everything that ever appears in it after this is something a person
 * did in the picker.
 *
 * This replaces the Get Text "cast", which read every page with Tesseract and
 * wrote the recognized lines back as an invisible text layer — minutes of GPU
 * before a user could draw a single box. Reading the pages is `foundry
 * vlm-convert`'s job now (electron/vlm-convert.ts), and it produces a BOOK
 * rather than a document to curate. The two are separate acts on separate files,
 * which is why neither one is a step of the other.
 *
 * ── WHY THE MARKER ──────────────────────────────────────────────────────────
 *
 * `readMarker` (working-document.ts) is what tells a working document apart from
 * somebody's book, and every reader and writer of curation goes through it — a
 * PDF with no marker is refused, by design, because appending annotations to an
 * arbitrary PDF is exactly the accident the marker exists to prevent. So the
 * copy carries one, and what it states is the truth about this file: which
 * original it was copied from (by sha256), which class that original is, and
 * what made it. It is written as an incremental update so the copied bytes stay
 * byte-for-byte the original's.
 *
 * ── ONE PER ORIGINAL, AND IT IS NEVER SILENTLY REPLACED ─────────────────────
 *
 * A working copy holds a person's curation. Re-minting it would throw that away
 * instantly, looking exactly like success, so an existing one is a refusal
 * naming the file — the caller offers to open it instead. Discarding it is a
 * separate, explicit act (`document:discard`).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
} from '@cantoo/pdf-lib';

import {
  createDocumentBinding,
  writeDocumentBinding,
  type DocumentBinding,
} from './document-binding';
import {
  FOUNDRY_DPI,
  bindingAbsPath,
  measureDocumentClass,
  primaryAbsPath,
  workingAbsPath,
  type DocumentProject,
} from './document-stages';
import { FOUNDRY_MARKER_VERSION } from './working-document';
import { sha256File } from './sidecar-binding';

/**
 * What made this working copy, recorded in the marker's `/Producer`.
 *
 * Deliberately NOT a foundry version string: no foundry ran. A marker that
 * claimed one would make a file this app wrote look like a file foundry wrote,
 * which is the one thing the producer field is there to distinguish.
 */
const PRODUCER = 'bookforge-working-copy/1';

export interface WorkingCopyResult {
  /** Absolute path to the working copy. */
  workingPath: string;
  /** Project-relative, forward slashes. */
  workingRelPath: string;
  binding: DocumentBinding;
}

/**
 * Write the `/Foundry` marker into a freshly copied PDF as an incremental
 * update.
 *
 * The whole point of an incremental update here is that the copied bytes are not
 * rewritten: a re-serialized 300 MB scan would differ from its original in ways
 * nobody asked for (object numbering, stream filters, compression), and the
 * archive original is the thing this file is supposed to be a copy of.
 *
 * The catalog is MARKED, which is the pdf-lib rule that is easy to get wrong:
 * `saveIncremental` writes an existing object only when it has been marked, so
 * an unmarked mutation produces a perfectly valid update that silently does not
 * contain the change. See working-document-writer.ts for what that cost foundry.
 */
async function stampMarker(
  file: string,
  documentClass: 'scanned' | 'text',
  sourceSha256: string
): Promise<void> {
  const bytes = fs.readFileSync(file);
  const doc = await PDFDocument.load(new Uint8Array(bytes), {
    forIncrementalUpdate: true,
    // The Info dictionary is the document's, not ours.
    updateMetadata: false,
  });
  const snapshot = doc.takeSnapshot();

  const marker = doc.context.obj({}) as PDFDict;
  marker.set(PDFName.of('Version'), PDFNumber.of(FOUNDRY_MARKER_VERSION));
  marker.set(PDFName.of('Class'), PDFName.of(documentClass));
  // The dpi geometry in this document would be placed at. Nothing has measured
  // any yet — a fresh copy carries no blocks — but the marker declares the frame
  // the picker's boxes are recorded in, and it has to be the same number every
  // reader of this file assumes.
  marker.set(PDFName.of('Dpi'), PDFNumber.of(FOUNDRY_DPI));
  marker.set(PDFName.of('SourceSHA256'), PDFHexString.fromText(sourceSha256));
  marker.set(PDFName.of('Producer'), PDFHexString.fromText(PRODUCER));
  doc.catalog.set(PDFName.of('Foundry'), marker);
  snapshot.markObjForSave(doc.catalog);

  const diff = await doc.saveIncremental(snapshot);
  if (diff.length === 0) {
    throw new Error(
      `The marker update computed for ${file} is empty, so the copy would carry no marker and `
      + 'nothing would recognize it as a working document.'
    );
  }
  const fd = fs.openSync(file, 'r+');
  try {
    const written = fs.writeSync(fd, diff, 0, diff.length, bytes.length);
    if (written !== diff.length) {
      throw new Error(`only ${written} of ${diff.length} marker bytes reached ${file}`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Mint this book's working copy.
 *
 * Refuses when one already exists, because the existing one holds curation and
 * replacing it is not something to do on the way to something else.
 */
export async function createWorkingCopy(project: DocumentProject): Promise<WorkingCopyResult> {
  const primary = primaryAbsPath(project);
  if (!fs.existsSync(primary)) {
    throw new Error(
      `The archive original is not at ${primary}, so there is nothing to copy. Re-import the book.`
    );
  }

  const workingPath = workingAbsPath(project);
  if (fs.existsSync(workingPath)) {
    throw new Error(
      `${path.basename(workingPath)} already exists, and it holds whatever has been marked up in `
      + 'this book. Open it, or discard it first — minting a new one would throw that away.'
    );
  }

  const { sha256 } = await sha256File(primary);
  const documentClass = await measureDocumentClass(primary);

  // Staged beside the destination — same filesystem, so the rename is atomic —
  // and removed on any failure. A half-copied PDF at the working document's name
  // would be adopted by the next open as though it were one.
  const staged = `${workingPath}.bookforge-tmp`;
  await fs.promises.rm(staged, { force: true });
  try {
    await fs.promises.mkdir(path.dirname(workingPath), { recursive: true });
    await fs.promises.copyFile(primary, staged);
    await stampMarker(staged, documentClass, sha256);
    await fs.promises.rename(staged, workingPath);
  } catch (err) {
    await fs.promises.rm(staged, { force: true });
    throw err;
  }

  const binding = await createDocumentBinding({
    projectId: project.projectId,
    projectDir: project.projectDir,
    primaryRelPath: project.primaryRelPath,
    workingAbsPath: workingPath,
    documentClass,
    // What made the copy. The binding's field is named for the era when foundry
    // made every one of them; it records the producer, and this one is us.
    foundryVersion: PRODUCER,
  });
  await writeDocumentBinding(bindingAbsPath(project), binding);
  console.log(
    `[working-copy] ${workingPath} (${binding.working.bytes} bytes, class ${documentClass})`
  );

  return {
    workingPath,
    workingRelPath: binding.working.path,
    binding,
  };
}

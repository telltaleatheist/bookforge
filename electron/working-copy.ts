/**
 * working-copy — minting `<Original>.working.pdf` from the archive original.
 *
 * A project's archive original is IMMUTABLE, and curation has to write
 * somewhere: the picker's block annotations, page deletions and crops are PDF
 * incremental updates (working-document-writer.ts), and appending them to the
 * file the user imported would edit the thing the whole archive exists to
 * preserve. So there is a second file, and this is where it comes from.
 *
 * ── NO MODEL RUNS, AND THE COPY IS BORN CURATABLE ───────────────────────────
 *
 * `cp`, one small incremental update carrying the marker below, and one more
 * carrying the BLOCK LAYER. No foundry, no Tesseract, no model, no rewritten
 * text layer: the working copy is the original's bytes, and everything that ever
 * happens to it after this is something a person did in the picker.
 *
 * The block layer is seeded here because curation cannot invent one. Every
 * edit — relabel, retitle, delete, restore, merge — names a block id, and
 * `applyWorkingDocumentEdits` refuses an id the document does not carry; there
 * is no `add` edit and there should not be one. So a copy minted without blocks
 * refused every gesture by name and the whole flow was unusable. The blocks come
 * from `pdf-analyzer` — the same analysis the picker displays, keyed by the
 * file's sha256 and cached, so the picker's own `analyzeQuick` on the next open
 * is a cache hit and the work is paid for once. That analysis is the slow part
 * of the mint now: on a long book it is minutes, not seconds, and it says so as
 * it goes.
 *
 * A document with NO text layer yields few blocks or none, and that is the
 * honest answer rather than an error: its pages can still be deleted, and
 * reading its pages is `foundry vlm-convert`'s job (electron/vlm-convert.ts),
 * which produces a BOOK rather than a document to curate. The two are separate
 * acts on separate files, which is why neither one is a step of the other.
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
  type DocumentStageProgress,
} from './document-stages';
import { FOUNDRY_MARKER_VERSION } from './working-document';
import {
  seedWorkingDocumentBlocks,
  type BlockSeedSource,
} from './working-document-writer';
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
  /** How many block annotations the copy was born with. Zero on a document with no text. */
  seededBlocks: number;
}

export interface WorkingCopyOptions {
  /** The mint's own progress, on the `document:stage-*` channels. */
  onProgress?: (progress: DocumentStageProgress) => void;
}

/**
 * Read the archive original's blocks — the same analysis the picker shows.
 *
 * Through the worker proxy rather than by calling `pdfAnalyzer` here, for the
 * two reasons every other analysis goes that way: mupdf's WASM heap stays out of
 * the main process, and the result lands in the analysis cache under the file's
 * sha256, which is the cache the picker's own `analyzeQuick` reads on the next
 * open. Analysing here and again there would read one book twice.
 */
async function analyzeBlocks(pdfPath: string): Promise<BlockSeedSource[]> {
  // Lazily, so requiring this module does not drag in the worker proxy — and
  // through it Electron's `app` — for anything that only wants the marker shape.
  const proxy = require('./pdf-worker-proxy') as typeof import('./pdf-worker-proxy');
  const result = await proxy.call('analyze', [pdfPath]);
  const blocks = (result as { blocks?: BlockSeedSource[] } | null)?.blocks;
  if (!Array.isArray(blocks)) {
    throw new Error(
      `Analyzing ${path.basename(pdfPath)} answered no block list, so there is nothing to seed the `
      + 'working copy with. The working copy is not made — try again.'
    );
  }
  return blocks;
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
 * Mint this book's working copy: the bytes, the marker, and the block layer.
 *
 * Refuses when one already exists, because the existing one holds curation and
 * replacing it is not something to do on the way to something else.
 *
 * ORDER, and it is the failure discipline the rest of the document code uses:
 * the ANALYSIS runs first, before a byte is copied, so a document that cannot be
 * read costs nothing and leaves nothing. The copy, the marker and the seed all
 * happen on a staged file beside the destination and only a complete one is
 * renamed into place — so a failure anywhere leaves NO working copy at all,
 * rather than a marked one with no blocks, which is exactly the state that made
 * every curation gesture refuse.
 */
export async function createWorkingCopy(
  project: DocumentProject,
  options: WorkingCopyOptions = {}
): Promise<WorkingCopyResult> {
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

  const report = options.onProgress ?? (() => { });
  report({ stage: 'blocks', message: `Reading the blocks of ${path.basename(primary)}…`, done: 0, total: 2 });
  const sources = await analyzeBlocks(primary);
  report({ stage: 'blocks', message: `Copying the original and writing ${sources.length} blocks…`, done: 1, total: 2 });

  // Staged beside the destination — same filesystem, so the rename is atomic —
  // and removed on any failure. A half-copied PDF at the working document's name
  // would be adopted by the next open as though it were one.
  const staged = `${workingPath}.bookforge-tmp`;
  await fs.promises.rm(staged, { force: true });
  let seeded: number;
  try {
    await fs.promises.mkdir(path.dirname(workingPath), { recursive: true });
    await fs.promises.copyFile(primary, staged);
    await stampMarker(staged, documentClass, sha256);
    const seed = await seedWorkingDocumentBlocks(staged, sources);
    seeded = seed.seeded;
    for (const [category, count] of Object.entries(seed.projected)) {
      console.warn(
        `[working-copy] ${count} block(s) the analysis called "${category}" were written as `
        + 'body — it is not one of the thirteen block categories (shared/ocr/block-categories.ts).'
      );
    }
    await fs.promises.rename(staged, workingPath);
  } catch (err) {
    await fs.promises.rm(staged, { force: true });
    throw err;
  }
  report({ stage: 'blocks', message: `${seeded} blocks`, done: 2, total: 2 });

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
    `[working-copy] ${workingPath} (${binding.working.bytes} bytes, class ${documentClass}, `
    + `${seeded} blocks)`
  );

  return {
    workingPath,
    workingRelPath: binding.working.path,
    binding,
    seededBlocks: seeded,
  };
}

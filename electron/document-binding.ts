/**
 * document-binding — the working document and the book, bound to the archive
 * original that neither of them may touch.
 *
 * A project directory holds three documents, all named after the original
 * (docs/DOCUMENT_PIPELINE.md):
 *
 *   archive/<Original>.pdf       the immutable primary. NEVER written. Its sha256
 *                                is the identity everything else is bound to.
 *   <Original>.working.pdf       the mutable working document, in the project
 *                                ROOT. Stages write INTO it. A system file: no
 *                                item line in the versions page, ever.
 *   <Original>.epub              the book, written by Reflow with this name from
 *                                birth. `book.epub` never exists on disk.
 *
 * Both of the last two are SIDECARS of the primary under the existing
 * `bookforge-sidecar-binding-v1` protocol (`sidecar-binding.ts`), and this module
 * is that protocol's document reading. Two things follow from binding them, and
 * they are the reason the record exists at all:
 *
 *  - **Archive immutability is a CHECKED invariant.** Every stage that consults
 *    the binding re-proves the archive was never touched, by hashing it. A
 *    mismatch is refused by name; nothing is regenerated, and nothing is served
 *    from a working document that belongs to different bytes.
 *  - **Reset to stage costs nothing.** Stage writes land as PDF incremental
 *    updates, so every stage completion is a BYTE OFFSET in `working.pdf`.
 *    "Reset to Blocks" is `truncate(working.pdf, offset)` — an exact restoration
 *    of the document as it stood when that stage finished, no GPU, no re-run.
 *
 * ── The deviation from the m4b protocol, and why ────────────────────────────
 *
 * A cover or transcript binding sits BESIDE its m4b. This one cannot: its primary
 * is in `archive/`, and writing a byte into `archive/` is the one thing the
 * pipeline is not allowed to do. So the record lives in the project root, named
 * after the primary's basename through `boundedSidecarName` — the same 255-byte
 * hashed-tail rule, called rather than copied.
 *
 * ── What is NOT in here ─────────────────────────────────────────────────────
 *
 * No stage status. No error. No "current stage". Which stages have run is read
 * from the DOCUMENT (`working-document.ts`: the marker, the block annotations)
 * and from the boundaries below, which are measurements of the file rather than
 * claims about it. The run-directory-as-state model this replaces is what put a
 * failed stage's record on disk to be tripped over for the rest of a book's life.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  SIDECAR_BINDING_VERSION,
  boundedSidecarName,
  sha256File,
  writeFileAtomic,
} from './sidecar-binding';
import {
  DOCUMENT_STAGES as STAGES,
  type DocumentClass,
  type DocumentStage,
  type ResetTarget,
} from '../shared/document/pipeline-types';

/** The binding shape's own version, inside the shared protocol envelope. */
export const DOCUMENT_BINDING_KIND = 'document-pipeline-v1' as const;

const GENERATOR = 'bookforge-document-pipeline/1';

/**
 * The stages that WRITE INTO the working document, in pipeline order.
 *
 * Reflow is deliberately absent: it reads the working document and writes the
 * EPUB, so it moves no byte of `working.pdf` and has no boundary. Its output is
 * recorded as the binding's `epub` instead, which is the thing "reset past
 * Reflow" would remove.
 *
 * Declared in `shared/document/pipeline-types.ts` because the picker's Reset
 * menu names the same stages, and two lists of them would be two answers to
 * "what can this book be reset to".
 */
export { DOCUMENT_STAGES } from '../shared/document/pipeline-types';
export type { DocumentStage, ResetTarget } from '../shared/document/pipeline-types';

export interface DocumentStageBoundary {
  stage: DocumentStage;
  /**
   * `working.pdf`'s length in bytes when the stage finished — which is the
   * boundary, because an incremental update only ever appends and foundry
   * fsyncs before it exits (foundry `src/pdf/document.ts`, `appendUpdate`).
   */
  offset: number;
  finishedAt: string;
  /** The foundry build that wrote it, for audit when a boundary looks wrong. */
  foundryVersion: string;
}

export interface DocumentFileRecord {
  /** Project-relative, slash-separated. Recorded for audit; identity is the hash. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface DocumentBinding {
  protocol: typeof SIDECAR_BINDING_VERSION;
  kind: typeof DOCUMENT_BINDING_KIND;
  /** The manifest project that owns these documents (folder slug). */
  projectId: string;
  /** The archive original. Hashed, never written. */
  primary: DocumentFileRecord;
  /** The working document. Its hash is refreshed at stage boundaries only. */
  working: DocumentFileRecord;
  /** Read from the working document's own marker at the cast; recorded for audit. */
  documentClass: DocumentClass;
  /** In pipeline order, earliest first. Never more than one entry per stage. */
  boundaries: DocumentStageBoundary[];
  /** The book, once Reflow has written it. */
  epub?: DocumentFileRecord & { writtenAt: string };
  createdAt: string;
  updatedAt: string;
  generator: string;
}

export class DocumentBindingError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'DocumentBindingError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/** `archive/Kershaw. Hitler.pdf` → `Kershaw. Hitler` — the `<Original>` in the table. */
export function originalStem(primaryRelPath: string): string {
  const base = path.basename(primaryRelPath.split('/').join(path.sep));
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  // A stem that is empty or begins with a dot would name the working document
  // `.working.pdf` and the book `.epub` — hidden files on every platform, and
  // two different books colliding on both names in the same project.
  if (stem.length === 0 || stem.startsWith('.')) {
    throw new Error(
      `"${primaryRelPath}" has no filename to name the working document and the book after. `
      + 'Every document in a project is named after the archive original; there is nothing to name '
      + 'these ones.'
    );
  }
  return stem;
}

/**
 * The working document's absolute path: `<projectDir>/<Original>.working.pdf`.
 *
 * Derived, never scanned for and never recorded as the authority — a reader
 * derives the same name the writer did, which is what makes a working document
 * findable after a restart with nothing consulted but the primary's name.
 */
export function workingDocumentPath(projectDir: string, primaryRelPath: string): string {
  return path.join(projectDir, boundedSidecarName(`${originalStem(primaryRelPath)}.working.pdf`));
}

/** The binding record: `<projectDir>/<Original>.pdf.documents.json`. */
export function documentBindingPath(projectDir: string, primaryRelPath: string): string {
  const base = path.basename(primaryRelPath.split('/').join(path.sep));
  return path.join(projectDir, boundedSidecarName(`${base}.documents.json`));
}

/** Project-relative, slash-separated — the form every record in the binding uses. */
export function toProjectRelative(projectDir: string, absPath: string): string {
  const rel = path.relative(projectDir, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `${absPath} is not inside the project at ${projectDir}, so it cannot be recorded in that `
      + "project's binding. A binding names only the project's own documents."
    );
  }
  return rel.split(path.sep).join('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / write
// ─────────────────────────────────────────────────────────────────────────────

function isDocumentBinding(value: unknown): value is DocumentBinding {
  if (!value || typeof value !== 'object') return false;
  const b = value as Record<string, unknown>;
  if (b['protocol'] !== SIDECAR_BINDING_VERSION) return false;
  if (b['kind'] !== DOCUMENT_BINDING_KIND) return false;
  if (typeof b['projectId'] !== 'string') return false;
  for (const key of ['primary', 'working'] as const) {
    const record = b[key] as Record<string, unknown> | undefined;
    if (!record || typeof record['path'] !== 'string' || typeof record['bytes'] !== 'number') return false;
    if (typeof record['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['sha256'])) return false;
  }
  if (b['documentClass'] !== 'scanned' && b['documentClass'] !== 'text') return false;
  if (!Array.isArray(b['boundaries'])) return false;
  for (const entry of b['boundaries'] as unknown[]) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') return false;
    if (!(STAGES as readonly string[]).includes(e['stage'] as string)) return false;
    if (typeof e['offset'] !== 'number' || !Number.isInteger(e['offset']) || e['offset'] < 0) return false;
  }
  return true;
}

/**
 * The binding for these documents, or null when there is none yet.
 *
 * The two answers are kept apart on purpose, and this is where this reading
 * diverges from the m4b one (which returns null for both):
 *
 *  - **Absent** is null, and it means exactly "the Get Text stage has not cast a
 *    working document for this book". That is an ordinary state and the caller's
 *    job is to run the stage.
 *  - **Present and unreadable** THROWS, naming the file. A corrupt binding
 *    silently answering "no binding" would send a caller off to re-cast a working
 *    document that is sitting right there and re-run every model over it. The
 *    record is small, it is written atomically, and the honest response to one
 *    that will not parse is to say so and to say what it is for.
 */
export function readDocumentBinding(bindingPath: string): DocumentBinding | null {
  let raw: string;
  try {
    raw = fs.readFileSync(bindingPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DocumentBindingError(
      bindingPath,
      `could not be read — ${(err as Error).message}. This file binds the working document and the `
      + 'book to the archive original; without it neither can be trusted to belong to this book.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DocumentBindingError(
      bindingPath,
      `is not valid JSON — ${(err as Error).message}. It binds the working document and the book to `
      + 'the archive original. It is not regenerated behind your back: delete it to start this '
      + "book's document pipeline again from the archive original, which is untouched."
    );
  }
  if (!isDocumentBinding(parsed)) {
    throw new DocumentBindingError(
      bindingPath,
      'is not a document binding record this build understands. It binds the working document and '
      + 'the book to the archive original. It is not regenerated behind your back: delete it to '
      + "start this book's document pipeline again from the archive original, which is untouched."
    );
  }
  return parsed;
}

export async function writeDocumentBinding(
  bindingPath: string,
  binding: DocumentBinding
): Promise<void> {
  await writeFileAtomic(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The invariant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-prove that the archive original is the bytes this binding was built on.
 *
 * Every stage calls this. archive/ is never written to by anything in this app,
 * so the check should never fire — and that is precisely why it is worth making:
 * it turns "we don't write there" from a convention into a measurement, and it
 * catches the cases a convention cannot (a re-import over the top, a sync
 * conflict, a user replacing the file by hand).
 *
 * Streams every byte. Deliberately NOT the delivery-tier size+mtime cache: this
 * is the authoritative reading, and it runs once per stage — beside a stage that
 * costs minutes of GPU, hashing the source is free.
 */
export async function verifyPrimary(
  binding: DocumentBinding,
  projectDir: string
): Promise<void> {
  const abs = path.join(projectDir, binding.primary.path.split('/').join(path.sep));
  let actual: { sha256: string; size: number };
  try {
    actual = await sha256File(abs);
  } catch (err) {
    throw new Error(
      `The archive original this book's documents are bound to could not be read at ${abs} — `
      + `${(err as Error).message}. Nothing downstream can be trusted without it: the working `
      + "document and the book are only valid for those exact bytes."
    );
  }
  if (actual.sha256 !== binding.primary.sha256) {
    throw new Error(
      `The archive original at ${abs} is not the file this book's documents were built from.\n`
      + `  bound to  ${binding.primary.sha256} (${binding.primary.bytes} bytes)\n`
      + `  on disk   ${actual.sha256} (${actual.size} bytes)\n`
      + 'archive/ is never written to by BookForge, so this file was replaced from outside the app. '
      + 'The working document and any book already exported belong to the OLD bytes and are being '
      + 'refused rather than mixed with the new ones. Reset this book to before Get Text to start '
      + 'from the original that is there now.'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundaries
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_ORDER = new Map<DocumentStage, number>(
  STAGES.map((stage, index) => [stage, index])
);

function stageIndex(stage: DocumentStage): number {
  const index = STAGE_ORDER.get(stage);
  if (index === undefined) {
    throw new Error(`"${stage}" is not a stage that writes into the working document.`);
  }
  return index;
}

/** The recorded boundary for a stage, or null when that stage has not finished. */
export function boundaryFor(
  binding: DocumentBinding,
  stage: DocumentStage
): DocumentStageBoundary | null {
  return binding.boundaries.find((b) => b.stage === stage) ?? null;
}

/**
 * Create the binding a freshly cast working document deserves.
 *
 * The cast is the one full rewrite, so its boundary is simply the file's length —
 * there is no earlier boundary for it to have been appended to.
 */
export async function createDocumentBinding(args: {
  projectId: string;
  projectDir: string;
  primaryRelPath: string;
  workingAbsPath: string;
  documentClass: DocumentClass;
  foundryVersion: string;
}): Promise<DocumentBinding> {
  const primaryAbs = path.join(args.projectDir, args.primaryRelPath.split('/').join(path.sep));
  const primary = await sha256File(primaryAbs);
  const working = await sha256File(args.workingAbsPath);
  const now = new Date().toISOString();
  return {
    protocol: SIDECAR_BINDING_VERSION,
    kind: DOCUMENT_BINDING_KIND,
    projectId: args.projectId,
    primary: { path: args.primaryRelPath, sha256: primary.sha256, bytes: primary.size },
    working: {
      path: toProjectRelative(args.projectDir, args.workingAbsPath),
      sha256: working.sha256,
      bytes: working.size,
    },
    documentClass: args.documentClass,
    boundaries: [
      {
        stage: 'get-text',
        offset: working.size,
        finishedAt: now,
        foundryVersion: args.foundryVersion,
      },
    ],
    createdAt: now,
    updatedAt: now,
    generator: GENERATOR,
  };
}

/**
 * Record where a stage finished, and refresh the working document's hash.
 *
 * The offset is MEASURED, not passed in from a caller's bookkeeping: the file's
 * length after the stage exited IS the boundary, because the stage's last act is
 * an fsynced append and a stage that fails truncates back to where it started.
 * A stage cannot leave the file shorter than the boundary before it, and one
 * that did is a corrupt working document rather than a new boundary — so that is
 * refused here rather than recorded.
 *
 * Recording a stage also DROPS every boundary after it. Re-running Blocks
 * invalidates a footnotes pass that was applied on top of the old block layer,
 * and a boundary for it would name an offset in bytes that no longer mean the
 * same thing.
 */
export async function recordStageBoundary(args: {
  binding: DocumentBinding;
  projectDir: string;
  stage: DocumentStage;
  foundryVersion: string;
}): Promise<DocumentBinding> {
  const { binding, projectDir, stage } = args;
  const workingAbs = path.join(projectDir, binding.working.path.split('/').join(path.sep));
  const working = await sha256File(workingAbs);

  const index = stageIndex(stage);
  const kept = binding.boundaries.filter((b) => stageIndex(b.stage) < index);
  const previous = kept.length > 0 ? kept[kept.length - 1] : null;
  if (previous && working.size < previous.offset) {
    throw new Error(
      `The ${stage} stage left ${workingAbs} at ${working.size} bytes, which is SHORTER than the `
      + `${previous.stage} boundary at ${previous.offset}. A stage only ever appends to the working `
      + 'document, so this file is no longer the document those earlier stages wrote. Nothing has '
      + 'been recorded. Reset this book to before Get Text and run it again.'
    );
  }

  return {
    ...binding,
    working: {
      path: binding.working.path,
      sha256: working.sha256,
      bytes: working.size,
    },
    boundaries: [
      ...kept,
      {
        stage,
        offset: working.size,
        finishedAt: new Date().toISOString(),
        foundryVersion: args.foundryVersion,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

/** Record the book Reflow wrote. Replaces any earlier one — there is one book. */
export async function recordExportedEpub(
  binding: DocumentBinding,
  projectDir: string,
  epubAbsPath: string
): Promise<DocumentBinding> {
  const { sha256, size } = await sha256File(epubAbsPath);
  return {
    ...binding,
    epub: {
      path: toProjectRelative(projectDir, epubAbsPath),
      sha256,
      bytes: size,
      writtenAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop boundaries the working document can no longer support.
 *
 * A reset TRUNCATES first and rewrites the record second, because the document
 * is the authority and the record follows it. Between those two steps — a crash,
 * a pulled plug — the record names a boundary past the end of the file, and this
 * is what notices and says so. It removes nothing from the document and
 * regenerates nothing; it brings a stale record into line with the file that
 * outranks it, out loud.
 */
export function reconcileBoundaries(
  binding: DocumentBinding,
  workingSizeBytes: number
): { binding: DocumentBinding; dropped: DocumentStageBoundary[] } {
  const dropped = binding.boundaries.filter((b) => b.offset > workingSizeBytes);
  if (dropped.length === 0) return { binding, dropped };
  console.warn(
    `[document-binding] ${binding.working.path} is ${workingSizeBytes} bytes, which is before the `
    + `recorded ${dropped.map((d) => `${d.stage} boundary (${d.offset})`).join(', ')}. The document `
    + 'is the authority, so those stages are being read as not having run — most likely a reset that '
    + 'was interrupted after the file was cut and before the record was rewritten.'
  );
  return {
    binding: {
      ...binding,
      boundaries: binding.boundaries.filter((b) => b.offset <= workingSizeBytes),
      updatedAt: new Date().toISOString(),
    },
    dropped,
  };
}

/**
 * Reset the working document to the end of a stage — or, for `none`, to nothing.
 *
 * `truncate(working.pdf, offset)` and that is the whole undo: an incremental
 * update only appends, so every recorded boundary is still a complete PDF with
 * its own trailer sitting inside the file. Resetting past Get Text deletes the
 * working document outright; the next Get Text re-casts it from the archive
 * primary, which is what "re-copies the archive primary" means when the cast is
 * also what writes the text layer.
 *
 * Order matters and is the opposite of the intuitive one: the FILE is cut first,
 * then the record is rewritten. The document outranks the record, so a crash
 * between them leaves a record that overclaims — which `reconcileBoundaries`
 * detects on the next read — rather than a record that underclaims while the
 * document still carries a stage's work.
 */
export async function resetToStage(args: {
  binding: DocumentBinding;
  projectDir: string;
  target: ResetTarget;
}): Promise<DocumentBinding> {
  const { binding, projectDir, target } = args;
  const workingAbs = path.join(projectDir, binding.working.path.split('/').join(path.sep));

  if (target === 'none') {
    await fs.promises.rm(workingAbs, { force: true });
    return {
      ...binding,
      working: { path: binding.working.path, sha256: EMPTY_SHA256, bytes: 0 },
      boundaries: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const boundary = boundaryFor(binding, target);
  if (!boundary) {
    throw new Error(
      `This book has no recorded ${target} boundary, so there is no point in the working document to `
      + `reset to. The stages that have run are: ${binding.boundaries.map((b) => b.stage).join(', ') || 'none'}.`
    );
  }

  let size: number;
  try {
    size = (await fs.promises.stat(workingAbs)).size;
  } catch (err) {
    throw new Error(
      `The working document is not at ${workingAbs} — ${(err as Error).message}. There is nothing to `
      + 'reset. Run Get Text to cast it again from the archive original.'
    );
  }
  if (boundary.offset > size) {
    throw new Error(
      `Cannot reset ${workingAbs} to the ${target} boundary at ${boundary.offset}: the file is `
      + `${size} bytes. That boundary was recorded against a different document.`
    );
  }

  await fs.promises.truncate(workingAbs, boundary.offset);
  const { sha256, size: after } = await sha256File(workingAbs);
  const index = stageIndex(target);
  return {
    ...binding,
    working: { path: binding.working.path, sha256, bytes: after },
    boundaries: binding.boundaries.filter((b) => stageIndex(b.stage) <= index),
    // The book was built from a document that no longer exists in that shape.
    // Leaving the record would have the binding vouch for an EPUB whose blocks
    // and text came from bytes that have just been cut off the end of the file.
    epub: undefined,
    updatedAt: new Date().toISOString(),
  };
}

/** sha256 of zero bytes — what "there is no working document" hashes to. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

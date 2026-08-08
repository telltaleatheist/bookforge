/**
 * document-stages — what a project's DOCUMENTS are, and what can be read off them.
 *
 * A project keeps two PDFs: `archive/<Original>.pdf`, which is immutable and is
 * what everything is rebuilt from, and `<Original>.working.pdf`, which is a copy
 * of it that carries the picker's curation — block annotations, page deletions,
 * crops — as PDF incremental updates. This module owns where those files are,
 * what state they are in, and how to put the working one back.
 *
 * ── THERE ARE NO STAGES HERE ANY MORE ───────────────────────────────────────
 *
 * There were four, and all four are gone (Aug 2026, when `foundry vlm-convert`
 * became the only PDF→EPUB conversion): Get Text cast the working document with
 * Tesseract, Blocks labelled it with a 4B model, Footnotes rewrote its text
 * layer, and Reflow exported the book out of it. Reading the pages is one act
 * now — electron/vlm-convert.ts — and it produces a BOOK, not a document to
 * curate. The working copy is minted by electron/working-copy.ts, which is a
 * file copy and a marker, and nothing else ever writes to it except the picker.
 *
 * ── WHAT THE STATE FIELDS MEAN NOW ──────────────────────────────────────────
 *
 * `DocumentPipelineState.stages` keeps the names the binding records use, and
 * they are the names in files users already have on disk. Read them as facts
 * about documents rather than as passes that ran:
 *
 *   getText    a working copy exists, carries a marker, and it names THIS original
 *   blocks     it carries block annotations (drawn by hand now, not by a model)
 *   footnotes  a footnotes boundary is recorded — only ever true for a book
 *              processed before Aug 2026
 *   reflow     the binding vouches for a book EPUB that is still on disk — again,
 *              only for a book built by the old exporter; a converted book is
 *              recorded in the manifest (`outputs.epub`) instead
 *
 * ── The scratch run directory ───────────────────────────────────────────────
 *
 * `documentScratchDir` is where the retired scan stages put hundreds of MB of
 * machine-local artifacts. Nothing writes one now; the name survives because
 * "Start over" (processing-reset.ts) is the only thing that ever has to find the
 * ones an older build left behind, and they are worth removing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  boundaryFor,
  documentBindingPath,
  reconcileBoundaries,
  readDocumentBinding,
  resetToStage,
  workingDocumentPath,
  writeDocumentBinding,
  type DocumentBinding,
  type DocumentStage,
  type ResetTarget,
} from './document-binding';
import {
  readWorkingDocumentState,
  type DocumentClass,
  type WorkingDocumentState,
} from './working-document';

/**
 * The dpi a working document's geometry is expressed in.
 *
 * Not configurable: it is stamped into every working copy's marker, and the
 * picker places every box it draws against it. A file whose marker says one
 * number and whose boxes were placed at another has boxes in the wrong place,
 * silently, so there is one number and it never moves.
 */
export const FOUNDRY_DPI = 200;

/** The documents of one book, and where they live. */
export interface DocumentProject {
  /** The manifest project's folder slug. */
  projectId: string;
  /** Absolute path to the project directory. */
  projectDir: string;
  /**
   * The archive original, project-relative and slash-separated —
   * `archive/<Original>.pdf`. Immutable: nothing writes to it, and the binding
   * re-proves it has not moved.
   */
  primaryRelPath: string;
}

/**
 * Progress from a long-running act on a project's documents, as broadcast on the
 * `document:stage-*` channels.
 *
 * The `stage` names that are not `vlm-convert` are the retired pipeline's, kept
 * because `DocumentStage` is the persisted boundary vocabulary in binding files.
 * Only `vlm-convert` is ever reported now.
 */
export interface DocumentStageProgress {
  stage: DocumentStage | 'reflow' | 'render' | 'vlm-convert';
  /** foundry's own most recent line, verbatim. */
  message: string;
  done: number;
  total: number;
  /**
   * Pages RASTERISED, when the run has a rasterising pass of its own.
   *
   * Only a conversion through an endpoint does: it draws every page first and
   * posts them afterwards, so the two counts move at wildly different rates
   * (a fifth of a second a page against several seconds) and belong on separate
   * bars. `done`/`total` above stay the READING count throughout — that is the
   * work the ETA is measured from, and mixing a 15x-faster phase into the same
   * series would make the estimate wrong in both directions.
   *
   * Absent on the MLX route, which renders and reads each page in one pass and
   * therefore has one phase to show. Absent is a real answer, not a gap.
   */
  render?: { done: number; total: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

export function primaryAbsPath(project: DocumentProject): string {
  return path.join(project.projectDir, project.primaryRelPath.split('/').join(path.sep));
}

export function workingAbsPath(project: DocumentProject): string {
  return workingDocumentPath(project.projectDir, project.primaryRelPath);
}

export function bindingAbsPath(project: DocumentProject): string {
  return documentBindingPath(project.projectDir, project.primaryRelPath);
}

/**
 * Where foundry's scan artifacts go — MACHINE-LOCAL, like the page render cache
 * and for the same reason: the library folder is Syncthing-synced and this is
 * hundreds of megabytes of page rasters and intermediate JSON that mean nothing
 * on another machine. Only the working document and the book go in the project.
 *
 * Keyed by the ORIGINAL's hash, so the name is derived rather than recorded and
 * two books can never share one.
 */
export function documentScratchDir(primarySha256: string): string {
  return path.join(
    os.homedir(), 'Documents', 'BookForge', 'foundry-runs', `doc-${primarySha256.slice(0, 16)}`
  );
}

function scratchPagesDir(scratchDir: string): string {
  return path.join(scratchDir, 'pages');
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the state — off the document, never off a record of it
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentPipelineState {
  binding: DocumentBinding | null;
  /** Null when no working document has been cast. */
  working: WorkingDocumentState | null;
  /** From the working document's own marker. Null before the cast. */
  documentClass: DocumentClass | null;
  stages: {
    /** A working document exists, carries a marker, and it names THIS original. */
    getText: boolean;
    /** It carries a block layer. */
    blocks: boolean;
    /** A footnotes boundary is recorded — the only stage whose work is invisible. */
    footnotes: boolean;
    /** The binding vouches for a book that is still on disk. */
    reflow: boolean;
  };
}

/**
 * What has happened to this book's documents, read off the documents.
 *
 * Three of the four stages are answered by the file itself: a marker means Get
 * Text has run, block annotations mean Blocks has, and a book on disk that the
 * binding vouches for means Reflow has. Only Footnotes needs the binding, and it
 * needs it because its work is a rewrite of an invisible text layer — there is
 * nothing to count. That is the one place a recorded boundary is the evidence
 * rather than a convenience.
 *
 * A working document whose marker names a DIFFERENT original is not this book's
 * working document, and every stage reads as un-run rather than as done. Silently
 * reflowing it would build one book out of another one's pages.
 */
export async function readDocumentPipelineState(
  project: DocumentProject
): Promise<DocumentPipelineState> {
  const workingPath = workingAbsPath(project);
  const bindingPath = bindingAbsPath(project);
  // Throws when the record is there and unreadable — see readDocumentBinding.
  let binding = readDocumentBinding(bindingPath);

  if (!fs.existsSync(workingPath)) {
    return {
      binding,
      working: null,
      documentClass: null,
      stages: { getText: false, blocks: false, footnotes: false, reflow: false },
    };
  }

  const working = await readWorkingDocumentState(workingPath);
  if (binding) {
    const reconciled = reconcileBoundaries(binding, working.bytes);
    if (reconciled.dropped.length > 0) {
      binding = reconciled.binding;
      await writeDocumentBinding(bindingPath, binding);
    }
  }

  const castMatchesThisBook =
    binding !== null && binding.primary.sha256 === working.marker.sourceSha256;
  if (binding !== null && !castMatchesThisBook) {
    console.warn(
      `[document-stages] ${workingPath} was cast from ${working.marker.sourceSha256}, and this `
      + `project's archive original is ${binding.primary.sha256}. Reading every stage as not having `
      + 'run: it is a working document, but not this book\'s.'
    );
  }

  const epubAbs = binding?.epub
    ? path.join(project.projectDir, binding.epub.path.split('/').join(path.sep))
    : null;

  return {
    binding,
    working,
    documentClass: working.marker.documentClass,
    stages: {
      getText: castMatchesThisBook,
      blocks: castMatchesThisBook && working.blockCount > 0,
      footnotes: castMatchesThisBook && binding !== null && boundaryFor(binding, 'footnotes') !== null,
      reflow: castMatchesThisBook && epubAbs !== null && fs.existsSync(epubAbs),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What kind of PDF this is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether this PDF carries its own text, MEASURED.
 *
 * `pdf-analyzer` samples pages and counts the characters the document's own text
 * layer yields. Nothing is assumed from the filename, the producer string or how
 * the file got here: it is a fact about the bytes, so it is measured. Stamped
 * into a working copy's marker, and shown in the picker — a reader who can
 * select the text of a `text` document and cannot select the text of a `scanned`
 * one is seeing the same answer this returns.
 */
export async function measureDocumentClass(pdfPath: string): Promise<DocumentClass> {
  const { pdfAnalyzer } = require('./pdf-analyzer') as typeof import('./pdf-analyzer');
  const report = await pdfAnalyzer.measureTextLayer(pdfPath);
  return report.hasTextLayer ? 'text' : 'scanned';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Put the working document back to how it stood at the end of a stage.
 *
 * Costs one truncate: zero GPU, no re-run, and the result is not an
 * approximation of that document but that document. `none` removes the working
 * document outright, and the next Get Text casts it again from the archive
 * original — which is what "re-copies the archive primary" means when the cast
 * is also what writes the text layer.
 */
export async function resetDocumentTo(
  project: DocumentProject,
  target: ResetTarget
): Promise<DocumentBinding | null> {
  const bindingPath = bindingAbsPath(project);
  const binding = readDocumentBinding(bindingPath);
  if (!binding) {
    throw new Error(
      'This book has no working document to reset — nothing has been cast for it yet. Run Get Text '
      + 'to cast one from the archive original.'
    );
  }
  const updated = await resetToStage({ binding, projectDir: project.projectDir, target });
  await writeDocumentBinding(bindingPath, updated);
  return updated;
}

/**
 * Everything this book's document pipeline put on disk, gone — including the
 * machine-local scratch, which is the whole of its recovery model.
 *
 * The archive original is not touched, and it is what everything is rebuilt
 * from.
 */
export async function discardDocumentPipeline(project: DocumentProject): Promise<void> {
  const bindingPath = bindingAbsPath(project);
  const binding = readDocumentBinding(bindingPath);
  await fs.promises.rm(workingAbsPath(project), { force: true });
  await fs.promises.rm(bindingPath, { force: true });
  if (binding) {
    await fs.promises.rm(documentScratchDir(binding.primary.sha256), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * document-ipc — the renderer's whole view of the document pipeline.
 *
 * Five things a window can ask about a book's documents: what has happened to
 * them, what blocks they carry, a curation edit, a stage, and a reset. There is
 * nothing else, and in particular there is nothing that hands back a "run" — the
 * document on disk IS the result (docs/DOCUMENT_PIPELINE.md), so a reader asks
 * the document and gets the answer as it stands rather than as some earlier
 * process recorded it.
 *
 * ── Errors are not state ────────────────────────────────────────────────────
 *
 * A stage that fails answers `{ success: false, error }` and leaves NOTHING
 * behind: foundry's staged-temp discipline means the document is untouched, and
 * the scratch directory a stage used is deleted on failure and on success alike.
 * The message reaches the user once, where they asked for the stage. There is no
 * persistent error record to attach, clear, or trip over for the rest of a
 * book's life — that model is what this replaces, and re-running the stage is
 * the whole recovery story.
 *
 * ── Why the renderer never holds a path ─────────────────────────────────────
 *
 * Every handler takes a project directory and resolves the document itself
 * (`document-project.ts`). The working document's name is DERIVED from the
 * original's, so a renderer that passed one could pass a stale one — and a
 * window that has been open across a re-import would then curate a working
 * document belonging to different bytes. Deriving it per call costs a path join
 * and makes that unreachable.
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';

import { resolveDocumentProject, reflowOutputPath } from './document-project';
import {
  discardDocumentPipeline,
  measureDocumentClass,
  primaryAbsPath,
  readDocumentPipelineState,
  resetDocumentTo,
  runBlocksStage,
  runGetTextStage,
  runReflowStage,
  type DocumentProject,
  type DocumentStageProgress,
} from './document-stages';
import { readWorkingDocumentBlocks } from './working-document';
import { applyWorkingDocumentEdits, type WorkingDocumentEdit } from './working-document-writer';
import { abortStageFor, beginStage } from './document-stage-registry';
import { noteDocumentStageFinished } from './document-open-when-finished';
import {
  documentBindingPath,
  workingDocumentPath,
  writeDocumentBinding,
} from './document-binding';
import type {
  DocumentBlocksPayload,
  DocumentRef,
  ResetTarget,
} from '../shared/document/pipeline-types';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Stop every one of this project's bindings from vouching for a book EPUB.
 *
 * Matched by the RECORDED path, not by "has an epub": a project can hold two
 * PDFs and therefore two working documents, and only the one whose reflow wrote
 * this file should forget it. Returns how many were cleared so the caller can
 * say it; zero is an ordinary answer (the book was written by an exporter that
 * does not go through a binding at all).
 */
async function forgetBoundEpub(projectDir: string, epubRelPath: string): Promise<number> {
  const { listWorkingDocuments } = await import('./document-project.js');
  const target = epubRelPath.toLowerCase();
  let cleared = 0;
  for (const doc of await listWorkingDocuments(projectDir)) {
    if (doc.binding.epub?.path.toLowerCase() !== target) continue;
    const { epub: _gone, ...rest } = doc.binding;
    await writeDocumentBinding(
      documentBindingPath(projectDir, doc.primaryRelPath),
      { ...rest, updatedAt: new Date().toISOString() });
    cleared++;
  }
  return cleared;
}

async function projectOf(ref: DocumentRef): Promise<DocumentProject> {
  return resolveDocumentProject({
    projectDir: ref.projectDir,
    ...(ref.variantId ? { variantId: ref.variantId } : {}),
    ...(ref.sourcePath ? { sourcePath: ref.sourcePath } : {}),
  });
}

/**
 * Run a stage, with its progress on the wire and its abort registered.
 *
 * The stage name travels with every progress line and with the failure, because
 * "which stage said this" is the whole of what makes foundry's own message
 * actionable — and foundry's message is passed through verbatim rather than
 * summarized (see `invokeFoundry`).
 */
async function withStage<T>(
  project: DocumentProject,
  stage: string,
  run: (opts: {
    project: DocumentProject;
    signal: AbortSignal;
    onProgress: (progress: DocumentStageProgress) => void;
  }) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  // Claimed in the shared registry rather than a map private to this module: a
  // reset has to be able to see a stage the QUEUE started, and quit has to be
  // able to stop one either of us started.
  const release = beginStage(project.projectDir, stage, controller);
  broadcast('document:stage-started', { projectDir: project.projectDir, stage });
  try {
    return await run({
      project,
      signal: controller.signal,
      onProgress: (progress) => {
        broadcast('document:stage-progress', { projectDir: project.projectDir, ...progress });
      },
    });
  } finally {
    release();
    broadcast('document:stage-finished', { projectDir: project.projectDir, stage });
    // The app's half of "open when finished" — see document-open-when-finished.
    // It fires from the same `finally` as the broadcast and for the same reason:
    // a stage that failed still STOPPED, and the promise is settled by measuring
    // the documents afterwards rather than by trusting that this line was
    // reached.
    noteDocumentStageFinished(project.projectDir, stage);
  }
}


let registered = false;

export function registerDocumentIpc(): void {
  if (registered) return;
  registered = true;

  /**
   * What has happened to this book's documents, read off the documents.
   *
   * The picker's Reset menu and the queue's row both come from here, and both
   * are showing a measurement rather than a record: a marker means Get Text has
   * run, annotations mean Blocks has, a book on disk means Reflow has.
   */
  ipcMain.handle('document:state', async (_event, ref: DocumentRef) => {
    try {
      const project = await projectOf(ref);
      const state = await readDocumentPipelineState(project);
      return {
        success: true,
        state: {
          stages: state.stages,
          documentClass: state.documentClass,
          blockCount: state.working?.blockCount ?? 0,
          deletedBlockCount: state.working?.deletedBlockCount ?? 0,
          // The stages a reset can land on: only those with a recorded boundary.
          // `none` is always offered — it is "before Get Text", and it needs no
          // boundary because it removes the working document outright.
          resetTargets: state.binding ? state.binding.boundaries.map((b) => b.stage) : [],
          workingPath: workingDocumentPath(project.projectDir, project.primaryRelPath),
          primaryRelPath: project.primaryRelPath,
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Which pipeline this book's ORIGINAL belongs to, measured — before anything
   * has been cast.
   *
   * `document:state` reports a document class too, but only the one recorded in
   * the working document's marker, which by definition does not exist until the
   * cast has run. That is the wrong side of the question the picker has to answer
   * the instant a book is opened: a **text** PDF is cast on arrival because
   * `foundry scan --pdf` reads the publisher's own layer in seconds, while a
   * **scanned** one means rendering every page at 200 dpi (~1.4 GB) and running
   * Tesseract over all of them — minutes, and never behind the user's back.
   *
   * So this measures the archive original itself (`pdf-analyzer` samples pages
   * and counts what the text layer yields). It writes nothing and casts nothing.
   * Its refusal is main's own sentence, and a renderer that gets one must NOT
   * guess a class: guessing `text` spends a book's worth of GPU on the wrong
   * pipeline, and guessing `scanned` puts a modal in front of a book that would
   * have been ready in thirty seconds.
   */
  ipcMain.handle('document:measure-class', async (_event, ref: DocumentRef) => {
    try {
      const project = await projectOf(ref);
      const primary = primaryAbsPath(project);
      if (!fs.existsSync(primary)) {
        throw new Error(
          `The archive original is not at ${primary}, so there is nothing to measure. Every `
          + 'document stage reads it; re-import the book.'
        );
      }
      return { success: true, documentClass: await measureDocumentClass(primary) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * The block layer, for the picker to paint.
   *
   * Read with pdf-lib, in the main process, and shipped whole. pdf.js — this
   * app's renderer — parses annotations against a fixed key whitelist and
   * SILENTLY DROPS custom dictionary keys, so every `/FoundryCategory` read
   * through it would come back as nothing at all: a book that reads as "no
   * blocks yet" rather than as an error. The picker therefore renders the PAGE
   * with pdf.js and gets the blocks from here.
   *
   * Rects are PDF user space, verbatim, with each page's crop box beside them.
   * The conversion into the picker's frame carries the crop-box origin (a
   * trimmed scanner margin is the common case) and belongs with the painter.
   */
  ipcMain.handle('document:read-blocks', async (_event, ref: DocumentRef) => {
    try {
      const project = await projectOf(ref);
      const working = workingDocumentPath(project.projectDir, project.primaryRelPath);
      const { marker, pages, blocks } = await readWorkingDocumentBlocks(working);
      const payload: DocumentBlocksPayload = {
        documentClass: marker.documentClass,
        dpi: marker.dpi,
        pages: pages.map((p) => ({ index: p.index, cropBox: p.cropBox, deleted: p.deleted })),
        blocks,
      };
      return { success: true, ...payload };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Curation: a batch of edits, landed as ONE incremental update.
   *
   * The renderer batches; this does not re-batch, debounce or coalesce. A caller
   * that sends two edits sent two edits, and the order they arrive in is the
   * order the user made them.
   */
  ipcMain.handle('document:apply-edits', async (
    _event, ref: DocumentRef, edits: WorkingDocumentEdit[]
  ) => {
    try {
      const project = await projectOf(ref);
      const working = workingDocumentPath(project.projectDir, project.primaryRelPath);
      const result = await applyWorkingDocumentEdits(working, edits);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Get Text — the cast. Every page, always.
   *
   * The picker's "read the pages again from scratch": casting REPLACES whatever
   * working document was there, because handing back this morning's document
   * would answer a different question than the one that was asked, silently and
   * instantly, which reads as success.
   */
  ipcMain.handle('document:get-text', async (_event, ref: DocumentRef) => {
    try {
      const project = await projectOf(ref);
      const { documentClass } = await withStage(project, 'Get Text', (opts) =>
        runGetTextStage(opts));
      broadcast('project:files-changed', project.projectDir);
      return { success: true, documentClass };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Detect. One of these, and it writes into the document.
   *
   * The confirmation belongs to the picker — this is where a user's hand
   * curation is overwritten — and there is none here, because a caller reaching
   * this handler has already decided. Results are never staged, previewed or
   * held: if it ran, the annotations in the PDF are the new truth.
   */
  ipcMain.handle('document:blocks', async (_event, ref: DocumentRef) => {
    try {
      const project = await projectOf(ref);
      await withStage(project, 'Blocks', (opts) => runBlocksStage(opts));
      broadcast('project:files-changed', project.projectDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Reflow — the working document in, the book out. The one exporter. */
  ipcMain.handle('document:reflow', async (
    _event, ref: DocumentRef, options?: { excludeCategories?: string[]; coverPath?: string }
  ) => {
    try {
      const project = await projectOf(ref);
      const outputPath = await reflowOutputPath(project.projectDir);
      const { epubPath } = await withStage(project, 'Reflow', (opts) => runReflowStage({
        ...opts,
        outputPath,
        ...(options?.excludeCategories ? { excludeCategories: options.excludeCategories } : {}),
        ...(options?.coverPath ? { coverPath: options.coverPath } : {}),
      }));
      const manifestService = await import('./manifest-service.js');
      await manifestService.registerEpubExport(project.projectDir, epubPath);
      broadcast('project:files-changed', project.projectDir);
      return { success: true, epubPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('document:cancel-stage', async (_event, projectDir: string) => {
    return { success: true, stopped: abortStageFor(projectDir) };
  });

  /**
   * Reset to the end of a stage — one truncate, no GPU, no re-run.
   *
   * The only user-facing affordance the working documents power. `none` removes
   * the working document outright and the next Get Text casts it again from the
   * archive original, which is untouched throughout.
   */
  ipcMain.handle('document:reset-to', async (_event, ref: DocumentRef, target: ResetTarget) => {
    try {
      const project = await projectOf(ref);
      await resetDocumentTo(project, target);
      broadcast('project:files-changed', project.projectDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Delete the project's book EPUB — the file, its record, and its diffs.
   *
   * Owen, third real session: "if that file is removed, so is the diff and its
   * viewing button." So this is one act, not a file delete with tidying bolted
   * on: the record goes, the passes recorded against the file go, the
   * `stages/NN-<kind>/` directories those passes wrote go, the binding stops
   * vouching for a book that is not there, and only then is the file unlinked.
   *
   * ORDERING, and it is the same ordering "Start over" uses (processing-reset.ts)
   * for the same reason: records first, file last. A failure part-way leaves an
   * unrecorded stray — invisible to every consumer, and overwritten by the next
   * export — rather than a record pointing at a file that is gone, which is the
   * state that makes a versions page offer a review of nothing.
   *
   * `document:discard` is NOT what this is. That one removes the working PDF and
   * its binding; the book is a separate artifact and survives it.
   */
  ipcMain.handle('document:delete-book', async (_event, projectDir: string) => {
    try {
      const manifestService = await import('./manifest-service.js');
      const forgotten = await manifestService.forgetEpubExport(projectDir);

      // The binding records the book too (`binding.epub`), and it is what the
      // versions page reads `builtAt` from. A binding still naming a deleted
      // book would report a build time for a file nobody has.
      const bindingsCleared = await forgetBoundEpub(projectDir, forgotten.relPath);

      let fileRemoved = false;
      if (fs.existsSync(forgotten.absPath)) {
        await fs.promises.unlink(forgotten.absPath);
        fileRemoved = true;
      }
      broadcast('project:files-changed', projectDir);
      return {
        success: true,
        removed: {
          relPath: forgotten.relPath,
          fileRemoved,
          droppedPasses: forgotten.droppedPasses,
          removedPaths: forgotten.removedPaths,
          bindingsCleared,
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Everything this book's document pipeline put on disk, gone. */
  ipcMain.handle('document:discard', async (_event, ref: DocumentRef) => {
    try {
      const project = await projectOf(ref);
      await discardDocumentPipeline(project);
      broadcast('project:files-changed', project.projectDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}

/**
 * processing-reset — put a book back the way it was imported.
 *
 * A project accretes state as it is processed: a foundry run directory holding
 * the page renders, the scan, the repaired lines and the labelled blocks; a
 * numbered stage directory per pass with its diff; the exported book EPUB and
 * the `appliedPasses` provenance that says what was done to it; and the editor's
 * deletions, recorded against the scan they were made against.
 *
 * Every one of those is DERIVED from the source document. When a run went wrong
 * — a bad OCR model, footnote removal that ate the wrong markers, a book that
 * simply needs redoing — the user's question is "start this book over", and the
 * honest answer is to delete all of it and let the next run rebuild from the
 * pages. That is what this module does, and nothing else: the source document,
 * the cover, the metadata, the finished audiobooks, the TTS sentence cache and
 * the language-learning pipeline's files are not its business.
 *
 * ── WHY THIS DELETES A BOOK, WHEN NOTHING ELSE MAY ───────────────────────────
 *
 * The codebase rule is that nothing deletes a user's book: no migration, no
 * sweep, no adoption of a stray. That rule governs AUTOMATIC behaviour — code
 * deciding on the user's behalf that a file has outlived its usefulness. This is
 * the opposite: the user pressed a button labelled "Start over", read a dialog
 * naming the file, and confirmed. Leaving the book behind would leave the
 * project in a state it can never reach on its own — provenance-less, with a
 * book nothing knows the history of — which is worse than the deletion.
 *
 * ── PREVIEW AND EXECUTE ARE ONE FUNCTION ─────────────────────────────────────
 *
 * The dialog must list what will actually go, and the disabled state must know
 * whether there is anything to go at all. Both are answered by running the same
 * code with `preview: true`, so the sentence the user reads and the act they
 * confirm cannot drift apart.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import { attachFoundryRun, foundryRunDir } from './foundry-run';
import { normalizeFsPath } from './path-utils';
import type { ProjectManifest } from './manifest-types';
import {
  selectPassStageDirs,
  type BookResetItem,
  type BookResetSummary,
} from '../shared/processing/reset-book';

export type { BookResetItem, BookResetSummary };

/**
 * Every run identity this project's documents could have been scanned under.
 *
 * A run is keyed by the PATH of the document it reads (`resolveBookKey` in
 * processing-passes: `config.bookKey || config.pdfPath`), and the picker may pin
 * it to the document's file hash instead. Neither is recorded in the manifest,
 * so the keys are re-derived HERE THE SAME WAY the planner derives them — every
 * variant's absolute path, plus `source/original.pdf`, plus the recorded file
 * hash — and each is turned into a directory by `foundryRunDir`, which is the
 * one implementation of that name (`boundedRunKey`). None of it is guessed at
 * with string surgery: a key that maps to no directory simply finds nothing.
 */
function candidateRunDirs(projectDir: string, manifest: ProjectManifest): Array<{ bookKey: string; runDir: string }> {
  const keys: string[] = [];
  const { variants } = manifestService.getVariants(manifest);
  for (const variant of variants) {
    if (!variant.path) continue;
    keys.push(path.join(projectDir, variant.path.split('/').join(path.sep)));
  }
  keys.push(path.join(projectDir, 'source', 'original.pdf'));
  if (manifest.source?.fileHash) keys.push(manifest.source.fileHash);

  const seen = new Set<string>();
  const out: Array<{ bookKey: string; runDir: string }> = [];
  for (const bookKey of keys) {
    const runDir = foundryRunDir(bookKey);
    if (seen.has(runDir)) continue;
    seen.add(runDir);
    out.push({ bookKey, runDir });
  }
  return out;
}

/**
 * Refuse while foundry is still working on one of this project's documents.
 *
 * The queue is the renderer's, and the renderer gates on it before it ever calls
 * here — but a run is owned by MAIN and outlives an ng-serve reload, so main is
 * the only side that can answer "is something writing into that directory right
 * now?". Wiping a live run's directory under it produces a foundry failure whose
 * message names a missing file, which is a lie about what happened.
 */
function refuseWhileRunning(candidates: Array<{ bookKey: string; runDir: string }>): void {
  for (const { bookKey, runDir } of candidates) {
    const state = attachFoundryRun(bookKey);
    if (state?.live && state.status === 'running') {
      throw new Error(
        `A foundry run is working on this book right now (${runDir}). Stop it from the Queue, `
        + 'then start the book over.'
      );
    }
  }
}

function statDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Plan the reset — and, unless `preview`, carry it out.
 *
 * ORDER MATTERS. The manifest records go first: if a later unlink fails, the
 * project is left with an unrecorded stray EPUB, which every consumer already
 * treats as invisible (see §The export EPUB). The reverse order would leave a
 * record pointing at a file that is gone, which `requireBookEpub` reports as a
 * corrupt project.
 *
 * Any failure throws NAMING THE PATH. There is no partial-success return: a
 * reset that could not remove the run directory has not started the book over,
 * and saying so is the only useful answer.
 */
export async function resetBookProcessing(
  rawProjectDir: string,
  options: { preview?: boolean } = {}
): Promise<BookResetSummary> {
  const preview = options.preview === true;
  const projectDir = normalizeFsPath(rawProjectDir);
  const manifestPath = path.join(projectDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${projectDir} is not a BookForge project — it has no manifest.json.`);
  }
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')) as ProjectManifest;

  const candidates = candidateRunDirs(projectDir, manifest);
  if (!preview) refuseWhileRunning(candidates);

  const items: BookResetItem[] = [];

  // ── The foundry run directory ───────────────────────────────────────────────
  // Machine-local, so a book scanned on another machine has none HERE. That is
  // reported as "not present", never as a deletion that did nothing.
  const liveRunDirs = candidates.filter((c) => statDir(c.runDir));
  if (liveRunDirs.length === 0) {
    items.push({
      kind: 'run-dir',
      label: 'Scan / OCR working files (nothing on this machine)',
      path: candidates[0]?.runDir,
      present: false,
      removed: false,
    });
  } else {
    for (const { runDir } of liveRunDirs) {
      items.push({
        kind: 'run-dir',
        label: 'Scan / OCR working files (page images, scan, corrections, block labels)',
        path: runDir,
        present: true,
        removed: false,
      });
    }
  }

  // ── The pass stage directories ─────────────────────────────────────────────
  const stagesDir = path.join(projectDir, 'stages');
  let stageNames: string[] = [];
  try {
    stageNames = (await fs.promises.readdir(stagesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* a project that has never been processed has no stages/ */ }
  const passStageDirs = selectPassStageDirs(stageNames).sort();
  for (const name of passStageDirs) {
    items.push({
      kind: 'stage-dir',
      label: `Pass working files and diff — stages/${name}`,
      path: path.join(stagesDir, name),
      present: true,
      removed: false,
    });
  }

  // ── The book EPUB and its provenance ───────────────────────────────────────
  // Located through the RECORD, never by filename pattern: the export is named
  // after the book and `outputs.epub` is the one authority on where it is.
  const record = await manifestService.readExportEpub(projectDir);
  const bookExists = !!record && fs.existsSync(record.absPath);
  items.push({
    kind: 'book-epub',
    label: record
      ? `The book EPUB — ${record.relPath}${bookExists ? '' : ' (recorded, but not on disk)'}`
      : 'The book EPUB (this project has none)',
    path: record?.absPath,
    present: bookExists,
    removed: false,
  });

  const passCount = manifest.outputs?.epub?.appliedPasses?.length ?? 0;
  items.push({
    kind: 'provenance',
    label: passCount > 0
      ? `The record of what was done to the book (${passCount} pass${passCount === 1 ? '' : 'es'})`
      : 'The record of what was done to the book (nothing recorded)',
    present: !!record || passCount > 0,
    removed: false,
  });

  // ── The per-source records the editor wrote against this scan ──────────────
  const sourceKeys = manifestService.foundrySourceRecordKeys(manifest);
  items.push({
    kind: 'source-records',
    label: sourceKeys.length > 0
      ? `Your block deletions in the PDF editor (${sourceKeys.join(', ')})`
      : 'Your block deletions in the PDF editor (none recorded)',
    present: sourceKeys.length > 0,
    removed: false,
  });

  const empty = !items.some((i) => i.present);
  if (preview || empty) {
    return { projectDir, preview: true, items, empty };
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  const cleared = await manifestService.clearProcessingRecords(projectDir);
  for (const item of items) {
    if (item.kind === 'provenance') item.removed = cleared.hadEpubRecord || cleared.appliedPasses > 0;
    if (item.kind === 'source-records') item.removed = cleared.clearedSourceKeys.length > 0;
  }

  for (const item of items) {
    if (!item.present || !item.path) continue;
    try {
      if (item.kind === 'book-epub') {
        // THE USER'S OWN DELETION. Nothing in this app removes a book on its own
        // — no migration, no sweep, no stray adoption — and that rule is about
        // code deciding for the user. Here the user pressed "Start over", read
        // this file's name in the confirmation, and said yes; the record has
        // already been cleared above, so leaving the file would leave a stray
        // that no consumer can see and the next export would not overwrite if
        // the book were ever retitled.
        await fs.promises.unlink(item.path);
      } else {
        await fs.promises.rm(item.path, { recursive: true, force: true });
      }
      item.removed = true;
    } catch (err) {
      throw new Error(
        `Starting the book over stopped at ${item.path}: ${(err as Error).message}. `
        + 'Nothing further was removed; the project is part-way reset.'
      );
    }
  }

  // An empty `stages/` left behind is not tidied: the LL pipeline and the TTS
  // cache create it too, and removing a directory this reset did not create is
  // exactly the kind of helpfulness that deletes someone's work.

  console.log(
    `[processing-reset] ${path.basename(projectDir)}: removed `
    + `${items.filter((i) => i.removed).length} of ${items.length} items`
  );
  return { projectDir, preview: false, items, empty: false };
}

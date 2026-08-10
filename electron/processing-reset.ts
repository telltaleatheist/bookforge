/**
 * processing-reset — put a book back the way it was imported.
 *
 * A project accretes state as it is processed: the working PDF the stages read
 * and write, its binding record, and the machine-local scratch foundry scanned
 * into; a numbered stage directory per pass with its diff; the exported book
 * EPUB and the `appliedPasses` provenance that says what was done to it; and the
 * editor's deletions, recorded against the scan they were made against.
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
 *
 * ── THERE IS NO LONGER ANYTHING HERE TO REFUSE ON ────────────────────────────
 *
 * This module refuses while a stage is working on the book, and the refusal is
 * not a nicety. foundry's failure discipline is a staged temp renamed into place
 * at the very end, so a stage that started before a reset and lands after it
 * puts back the working document the user asked to be gone — silently, seconds
 * later, looking for all the world like the reset simply did not work.
 *
 * The old run model answered this by accident: a run was an object in main's
 * memory, so "is something writing into that directory right now?" was a
 * question main could already answer. A stage is a function call owned by
 * whoever started it — the picker's handler (document-ipc.ts) or the queue job
 * (processing-passes.ts) — so the two of them publish their claim in
 * `document-stage-registry.ts` and this reads it. That registry is the one piece
 * of the document pipeline that is state in memory, and deliberately so: it says
 * nothing about what has HAPPENED to a book (that is read off the documents),
 * only about what is happening to it this instant, which is precisely what a
 * file on disk cannot tell you.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as manifestService from './manifest-service';
import { readDocumentBinding } from './document-binding';
import { stageRunningFor } from './document-stage-registry';
import {
  bindingAbsPath,
  discardDocumentPipeline,
  documentScratchDir,
  workingAbsPath,
  type DocumentProject,
} from './document-stages';
import { boundedRunKey, normalizeFsPath } from './path-utils';
import type { ProjectManifest } from './manifest-types';
import {
  selectPassStageDirs,
  type BookResetItem,
  type BookResetSummary,
} from '../shared/processing/reset-book';

export type { BookResetItem, BookResetSummary };

/**
 * A run directory as builds before the document pipeline named one.
 *
 * Nothing in this app writes one any more — the working PDF carries the text
 * layer and the block annotations now, and what is left machine-local is
 * `documentScratchDir`, keyed by the original's hash. But a book processed by an
 * older build still has hundreds of megabytes of page rasters and intermediate
 * JSON sitting under `foundry-runs/<key>`, and "start this book over" is the one
 * place that is asked to go and remove it. So the naming rule survives HERE,
 * where its only remaining purpose — finding old directories in order to delete
 * them — is plain, rather than in a module about running stages.
 *
 * The key is the PATH of the document the run read, sanitized and bounded by
 * `boundedRunKey`, which is the one implementation of that name. Byte-identical
 * to what the old `foundryRunDir` produced, because a directory this cannot name
 * is a directory this cannot delete.
 */
function legacyRunDir(bookKey: string): string {
  return path.join(os.homedir(), 'Documents', 'BookForge', 'foundry-runs', boundedRunKey(bookKey));
}

/**
 * Every run directory this project's documents could have been scanned into by
 * an older build.
 *
 * A run was keyed by the path of the document it read, and the picker could pin
 * it to the document's file hash instead. Neither was ever recorded in the
 * manifest, so the keys are re-derived HERE THE SAME WAY they were minted —
 * every variant's absolute path, plus `source/original.pdf`, plus the recorded
 * file hash. None of it is guessed at with string surgery: a key that maps to no
 * directory simply finds nothing.
 */
function candidateRunDirs(projectDir: string, manifest: ProjectManifest): string[] {
  const keys: string[] = [];
  const { variants } = manifestService.getVariants(manifest);
  for (const variant of variants) {
    if (!variant.path) continue;
    keys.push(path.join(projectDir, variant.path.split('/').join(path.sep)));
  }
  keys.push(path.join(projectDir, 'source', 'original.pdf'));
  if (manifest.source?.fileHash) keys.push(manifest.source.fileHash);

  return [...new Set(keys.map(legacyRunDir))];
}

/**
 * Every document pipeline this project could have started — one per PDF version.
 *
 * `resolveDocumentProject` is deliberately not used, and the difference is the
 * whole point of it: that function CHOOSES a document and refuses when a project
 * holds several, because a stage that guessed would cast a working document from
 * a book nobody picked. A reset chooses nothing. Every PDF the project holds may
 * have been cast and curated, so every one of them is swept; a project that was
 * imported as a book has no PDF and yields none, which is "nothing to remove"
 * rather than a refusal.
 */
function documentPipelines(projectDir: string, manifest: ProjectManifest): DocumentProject[] {
  const { variants } = manifestService.getVariants(manifest);
  return variants
    .filter((v) => v.path && v.format.toLowerCase() === 'pdf')
    .map((v) => ({ projectId: manifest.projectId, projectDir, primaryRelPath: v.path }));
}

function statDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function statFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
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
 * reset that could not remove the working document has not started the book
 * over, and saying so is the only useful answer.
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

  // Checked on the preview too. A preview that listed a working document as
  // "will be removed" while a stage was about to rewrite it would be describing
  // a book that will not exist by the time the user reads the list.
  const busy = stageRunningFor(projectDir);
  if (busy) {
    throw new Error(
      `${busy} is working on this book right now, so it cannot be started over. That stage finishes `
      + 'by renaming a file into place, which would put back the very documents this removes — stop '
      + 'it, or wait for it, and reset then.'
    );
  }

  const candidates = candidateRunDirs(projectDir, manifest);

  const items: BookResetItem[] = [];

  // ── The documents the pipeline made ────────────────────────────────────────
  // The working PDF, its binding record and the machine-local scan scratch, one
  // set per PDF version. They go together because they only mean anything
  // together: the binding is what says the working PDF was cast from THIS
  // archive original, and the scratch is named after that original's hash.
  //

  const pipelines = documentPipelines(projectDir, manifest);
  const documentItems = new Map<BookResetItem, DocumentProject>();
  for (const project of pipelines) {
    const working = workingAbsPath(project);
    const bindingPath = bindingAbsPath(project);
    // Throws when a binding record is there and unreadable, and that is the
    // right answer even here: the message names the file and says to delete it,
    // and a reset that swallowed it would be removing documents it could not
    // prove belong to this book.
    const binding = readDocumentBinding(bindingPath);
    const scratch = binding ? documentScratchDir(binding.primary.sha256) : null;
    const item: BookResetItem = {
      kind: 'working-document',
      label: 'The working PDF, its binding record and the scan working files — '
        + path.basename(working),
      path: working,
      present: statFile(working) || statFile(bindingPath) || (scratch !== null && statDir(scratch)),
      removed: false,
    };
    items.push(item);
    documentItems.set(item, project);
  }

  // ── A run directory an older build left behind ─────────────────────────────
  // Machine-local, and no longer written by anything, so most books have none:
  // only one processed before the document pipeline does. Listed only when it is
  // actually there — an absent line for a directory this build cannot create
  // would be a sentence about the app's history, not about the user's book.
  for (const runDir of candidates.filter(statDir)) {
    items.push({
      kind: 'run-dir',
      label: 'Scan / OCR working files from an earlier version (page images, scan, corrections, block labels)',
      path: runDir,
      present: true,
      removed: false,
    });
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

  // The narration copy is cut from that book, so it dies with it — same kind,
  // same rule: the user reads its name in the confirmation before it goes.
  const narration = await manifestService.readNarrationEpub(projectDir);
  const narrationExists = !!narration && fs.existsSync(narration.absPath);
  if (narration) {
    items.push({
      kind: 'book-epub',
      label: `The narration copy — ${narration.relPath}`
        + `${narrationExists ? '' : ' (recorded, but not on disk)'}`,
      path: narration.absPath,
      present: narrationExists,
      removed: false,
    });
  }

  // Through the chain resolver, like the two records above it: a reset preview
  // that counted one version's passes beside another version's book would name a
  // cost the act does not have.
  const passCount = (await manifestService.readAppliedPasses(projectDir)).length;
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

  // The document pipeline goes through its own discard rather than this loop's
  // `rm`, and it has to: the three files it removes are one act — the working
  // PDF in the project, the binding record beside it, and a machine-local
  // scratch whose name is only knowable by reading that record first. Unpicking
  // that here would be a second implementation of it, drifting the day the
  // pipeline grows a fourth file.
  for (const [item, project] of documentItems) {
    if (!item.present) continue;
    try {
      await discardDocumentPipeline(project);
      item.removed = true;
    } catch (err) {
      throw new Error(
        `Starting the book over stopped at ${project.primaryRelPath}'s working document: `
        + `${(err as Error).message}. Nothing further was removed; the project is part-way reset.`
      );
    }
  }

  for (const item of items) {
    if (!item.present || !item.path || documentItems.has(item)) continue;
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

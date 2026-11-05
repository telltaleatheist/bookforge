/**
 * ipc-projects — the project list, deleting, and a document's and a project's metadata.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { readEpubMetadata, stampMintMetadata, readPdfMetadata } from '@owen/foundry-core/node/engine';
import { hostMintMeta } from '@owen/foundry-core/node/host';
import { listProjects, readManifest, recordMintMeta } from '@owen/foundry-core/node/projects';
import { describeProjectDelete, deleteProjectFolder, describeDocumentDelete, openExportDeleteDoor, deleteDocumentFile } from '@owen/foundry-core/node/doors-delete';
import { admittedPdf, mintSeedFor, writePdfMetadataFor, exportedBook, writeEpubMetadataFor } from '@owen/foundry-core/node/doors-meta';
import type { DocumentDeletion, MetadataWriteOutcome, MintMeta } from '@owen/foundry-core/shared/types';

export function registerProjectDoors(): void {
  /** Home's primary listing: one row per book, expanding to what is in it. */
  ipcMain.handle('projects:list', () => listProjects());

  /**
   * Delete a project — the whole folder, off the disk, for real.
   *
   * THE ONE PLACE IN THIS APP WHERE SOMETHING IS REALLY DESTROYED. Everywhere
   * else "nothing is ever deleted" holds (electron/projects.ts), because
   * everywhere else it is FOUNDRY deciding that a person is finished with
   * something it made. Here it is the person, about their own folder, having
   * been told in words what is in it. A Delete button that quietly rotated the
   * project into `archived-<stamp>/` would be a lie twice over: the library
   * would go on filling up, and the folder the user pressed a button to be rid
   * of would still be there for them to find and remove by hand.
   *
   * THREE THINGS ARE REFUSED BEFORE THE QUESTION IS EVEN ASKED, all of them BY
   * NAME (ARCHITECTURE §8):
   *
   *   1. a path that is not a project directory — `inspectProject` proves it is
   *      a DIRECT CHILD of `projectsDir()` before it reads a byte, and
   *      `deleteProject` proves it again at the `rm`. That check is the whole
   *      security boundary here and its reasoning is written down where it
   *      lives; this handler must never be the thing that decides a path is
   *      safe;
   *
   *   2. a book from this project open in a tab. The renderer checks its own tab
   *      list first, because it is the side that knows the tab's title and can
   *      say a sentence worth reading — but a renderer's word is not an
   *      authorization (the `admitted` precedent, above), so main asks its OWN
   *      record of what is unpacked. Deleting a working tree out from under a
   *      live book leaves the protocol handler serving chapters that are gone,
   *      and on Windows the delete stops halfway on the first locked file and
   *      leaves a project that is neither there nor erased — worse than either;
   *
   *   3. the user themself, at the dialog, which defaults to Cancel.
   *
   * MAIN'S NATIVE BOX, like `confirmClose` and like every other question this
   * app asks: modal to the window, so the next gesture cannot race it, and not a
   * rectangle drawn over a page that can scroll out from under it.
   *
   * The sentence names the book, names the directory, and says what is inside —
   * above all the READINGS BANK, because that is the only thing in a project
   * that cost GPU-hours and cannot be rebuilt from anything else on disk. A
   * scan re-imports, a working tree re-unpacks, an edition rebuilds; a page the
   * model read is read again or not at all.
   *
   * Returns the sentence for the notice strip, or null when the user said no.
   * A refusal THROWS, so it reaches the same strip through the renderer's
   * ordinary catch and is never mistaken for a cancel.
   */
  /*
   * DESCRIBE, THEN DELETE — two calls where there used to be one.
   *
   * The question moved to the renderer, and the split is what makes that safe.
   * `projects:describe` composes the warning and PROVES the delete is currently
   * allowed; `projects:delete` proves it again and does the work. Nothing about
   * the second call trusts the first: a renderer that skipped straight to the
   * delete meets exactly the same refusals, because the checks live in the
   * function that erases rather than in the one that asks.
   *
   * The sentences stay HERE, whole. Main is the only side that knows the size on
   * disk, the readings bank's page count and whether a copy was filed, and those
   * are what make the warning worth reading — a renderer composing its own would
   * arrive at "Are you sure?" within a month.
   */

  ipcMain.handle('projects:describe', (_event, dir: string) => describeProjectDelete(dir));

  ipcMain.handle('projects:delete', (_event, dir: string) => deleteProjectFolder(dir));


  ipcMain.handle('documents:describe', (_event, filePath: string): Promise<DocumentDeletion> =>
    describeDocumentDelete(filePath));


  openExportDeleteDoor();

  ipcMain.handle('documents:delete', (_event, filePath: string) => deleteDocumentFile(filePath));

  /*
   * ── A document's own record ──────────────────────────────────────────────
   *
   * `foundry epub-meta` and `foundry pdf-meta`, spawned exactly as `doctor` and
   * `epub-stamp` are: the engine owns the file format and this app owns the
   * question. Reading and writing are one pair of handlers rather than four,
   * because the dialog does both against the same document and a patch with no
   * fields in it IS a read.
   *
   * WHICH FILE IS MAIN'S DECISION, and the two formats prove it two different
   * ways because they arrive by two different doors. For a PDF the renderer names
   * the path it already has open, which is the WORKING PDF; it is resolved through
   * the same allow-list every other read goes through, so a renderer cannot ask
   * main to rewrite a file nobody opened. For an EPUB the renderer names a
   * FINISHED EXPORT, and an export was never opened at all — it is a file this
   * process wrote into `<project>/final/` and the renderer learned about off a row
   * in the history — so the allow-list has nothing to say about it and membership
   * in the tray is the claim being exercised instead (`exportInTray`, which
   * `export:save-copy` and `book:view` are gated on for the same reason).
   */

  ipcMain.handle('meta:read-pdf', (_event, filePath: string) =>
    readPdfMetadata(admittedPdf(filePath)));
  ipcMain.handle(
    'meta:write-pdf',
    (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> =>
      writePdfMetadataFor(filePath, patch),
  );

  ipcMain.handle('meta:read-epub', (_event, filePath: string) =>
    readEpubMetadata(exportedBook(filePath)));
  ipcMain.handle(
    'meta:write-epub',
    (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> =>
      writeEpubMetadataFor(filePath, patch),
  );
  /*
   * ── The mint metadata — who the book says it is, per project ──────────────
   *
   * The block the mint modal edits (shared/mint-meta.ts carries the shape and
   * Owen's ruling). READ answers null rather than a seed: the SEEDING is the
   * dialog's decision — it composes a first guess out of the manifest title,
   * the scan's Info author and the position's language, three facts the
   * renderer already holds — and main inventing one here would be two seeders
   * with two opinions. WRITE replaces the whole block; the directory is proved
   * the way every project door proves it, by reading the manifest of the
   * folder named and nothing else.
   */
  ipcMain.handle('meta:mint-read', async (_event, projectDir: string) =>
    (await readManifest(projectDir)).meta ?? null);
  ipcMain.handle('meta:mint-write', async (_event, projectDir: string, meta: MintMeta) => {
    await recordMintMeta(projectDir, meta);
  });
  /*
   * The whole block onto ONE finished export, in place — the metadata tile's
   * Save over an EPUB somebody is looking at. Gated exactly as the flat
   * writer above (`exportedBook`): only a file this app filed answers, and
   * the language written is the FORM'S here, deliberately — an edit of a
   * finished file is a person correcting that file's record, not a mint
   * whose chain outranks them.
   */
  ipcMain.handle('meta:mint-stamp', (_event, filePath: string, meta: MintMeta) =>
    stampMintMetadata(exportedBook(filePath), meta, undefined));
  /*
   * The HOST's answer for who this book is — the hosted modal's seed (Owen:
   * "it should inherit the parent document's metadata. ill fill out whatever
   * is missing"). Null standalone; a host that THROWS rejects here in the
   * host's own words, so the form can say so (2026-09-07); the DIALOG
   * merges, because the precedence (stored block wins per-field, host fills
   * the gaps, the position feeds the language) reads two other facts only the
   * renderer holds.
   */
  ipcMain.handle('meta:mint-host', (_event, projectDir: string) => hostMintMeta(projectDir));
  // The card's empty fields: the scan's Info and the project's name, read by main (doors-meta.ts).
  ipcMain.handle('meta:mint-seed', (_event, projectDir: string) => mintSeedFor(projectDir));
}

/**
 * ipc-capture — the capture stage: intake, the recipe, and the mint.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { ensureCapture, intakePhotos, mintAbort, mintBegin, mintCommit, mintPage, openCapture, pdfStageBegin, pdfStagePage, pdfStageRelease, removePhotos, writeRecipe } from '@owen/foundry-core/node/capture';
import { createCaptureProject } from '@owen/foundry-core/node/projects';
import type { CaptureRecipe } from '@owen/foundry-core/shared/types';

export function registerCaptureDoors(): void {
  // ── The step ledger ──────────────────────────────────────────────────────
  /*
   * ONE FAMILY, AND MAIN PROVES THE DIRECTORY ON EVERY MEMBER OF IT.
   *
   * The renderer names a project directory, exactly as it names a PDF above, and
   * `deleteStep` unlinks files inside whatever it was handed — which is the same
   * authorization problem `deletableProjectDir` exists for and is gated by the
   * same check (electron/projects.ts). The read and the pointer move ask it too,
   * deliberately: a gate that only guards the destructive call is a gate somebody
   * routes around by reading first.
   *
   * DESCRIBE, THEN DELETE, on the document delete's precedent and for its reason.
   * `describe-delete` composes the facts AND proves the delete is currently
   * allowed, so a card is never drawn for something that would be refused a click
   * later; `delete` proves it again, because a renderer that skipped the question
   * meets the same refusal. The origin is refused by name in both — deleting the
   * import is deleting the project, and the project ✕ does that with its own
   * ceremony and its own accounting of what it costs.
   */

  /*
   * ── THE CAPTURE STAGE, REGISTERED AND NOT YET ANSWERING ───────────────────
   *
   * Merge 1 is the CONTRACT and nothing else: these seven exist so the renderer
   * can be written and typechecked against real declarations while main is
   * still being filled in (docs/CAPTURE.md, work packages). They refuse by name
   * rather than by silence, because a door that resolves undefined is a bug
   * report about the renderer and a door that throws is a true sentence about
   * the app.
   *
   * REGISTERED HERE AND NOT BEHIND A FLAG. A channel that appears later is a
   * channel `docs/IPC-CHANNELS.md` cannot enumerate and the audit cannot see;
   * the seven names are the contract, and the contract is what ships first.
   */

  /*
   * `capture:create` MAKES A PROJECT, which no other door here does. It answers
   * with the directory because that directory is the only handle anything has
   * on a project keyed from a random id rather than from a document — and with
   * the recipe and token beside it, so the light table opens in one round trip
   * rather than creating and then immediately loading.
   */
  ipcMain.handle('capture:create', async (_event, title: string) => {
    const made = await createCaptureProject(title);
    return { projectDir: made.dir, ...(await ensureCapture(made.dir)) };
  });
  /*
   * INTAKE IS THE LONG ONE. Every photograph is copied, hashed, decoded, encoded
   * to a lossless working copy and thumbnailed, one at a time — seconds each,
   * and the acceptance shoot is twenty-seven of them. It is an `invoke` like the
   * others because the contract says so; a person watching a spinner for a
   * minute is a surface problem, and inventing a progress channel here would
   * make it a protocol one.
   */
  ipcMain.handle('capture:intake', (_event, projectDir: string, paths: string[]) =>
    intakePhotos(projectDir, paths));
  ipcMain.handle('capture:recipe-load', (_event, projectDir: string) => openCapture(projectDir));
  /*
   * ── GRAVESTONE: `capture:pages-load` (Wave 41) ────────────────────────────
   *
   * A door stood here that listed the page images a mint had made and handed
   * back a token to serve them, because the mint wrote pictures and no
   * container. It admitted nothing — the token was the whole authorisation —
   * and it read the POSITION to decide which mint, so a re-mint's older row
   * still opened its own book.
   *
   * The mint writes a PDF (`recordMint`) and the minted row resolves to it
   * through `ledger:document-at` like every other document in the app, so
   * pdf.js draws the pages and this door has nothing to answer. Removing it
   * moves the handle count in docs/IPC-CHANNELS.md, which BookForge's keeper
   * test reads — the table is regenerated in the same commit.
   */
  /*
   * REMOVAL, WHICH IS THE ONE DOOR THAT DELETES ANYTHING IRREPLACEABLE. It is
   * allowed to because the bank holds copies of files that still exist where
   * the person dragged them from, and because the surface has already asked
   * them, by name and by count. Refused while this project is being minted.
   */
  ipcMain.handle('capture:remove', (_event, projectDir: string, photoIds: string[]) =>
    removePhotos(projectDir, photoIds));
  /*
   * SAVED WHOLE AND VALIDATED WHOLE. The renderer debounces; this does not, and
   * it refuses a recipe it cannot read rather than writing it — a malformed
   * recipe on disk is not a bug that throws, it is a project that will not open
   * tomorrow, holding photographs nobody can remake.
   */
  ipcMain.handle('capture:recipe-save', (_event, projectDir: string, recipe: CaptureRecipe) =>
    writeRecipe(projectDir, recipe));
  /*
   * THE MINT IS A SESSION AND NOT A CALL, which is why there are four of these.
   * Main decides the list, the renderer sends back one finished page at a time,
   * and the commit is the single point at which a document appears. Nothing is
   * written into the project until then: a mint given up on halfway leaves the
   * catalogue exactly as it found it.
   */
  ipcMain.handle('capture:mint-begin', (_event, projectDir: string) => mintBegin(projectDir));
  ipcMain.handle('capture:mint-page', (_event, mintId: string, index: number, jpeg: ArrayBuffer) =>
    mintPage(mintId, index, jpeg));
  ipcMain.handle('capture:mint-commit', (_event, mintId: string) => mintCommit(mintId));
  ipcMain.handle('capture:mint-abort', (_event, mintId: string) => mintAbort(mintId));
  /*
   * THE PDF EXPLOSION IS A SESSION TOO, AND FOR THE MINT'S REASON REVERSED.
   *
   * A dropped PDF becomes one PNG per page. The renderer rasterizes — pdf.js is
   * over there — and these three doors are main putting the pages on disk so
   * that `capture:intake` above can copy them in exactly as it copies a
   * photograph. One page per call, because a 300-page scan is gigabytes and a
   * call that carried the book would hold all of it in one heap.
   *
   * NOTHING HERE ADMITS ANYTHING, because nothing here is a path the renderer
   * named: main chooses the directory, the renderer supplies bytes and a
   * basename, and the basename is checked rather than trusted (`pdfStagePage`).
   * The release is separate from the last page because the two callers let go at
   * different moments — see the function's own note.
   */
  ipcMain.handle('capture:pdf-stage-begin', () => pdfStageBegin());
  ipcMain.handle('capture:pdf-stage-page', (_event, stageId: string, name: string, png: ArrayBuffer) =>
    pdfStagePage(stageId, name, png));
  ipcMain.handle('capture:pdf-stage-release', (_event, stageId: string) => pdfStageRelease(stageId));
}

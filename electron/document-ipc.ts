/**
 * document-ipc — what a window may ask about a project's long-running stages.
 *
 * Two questions: what is running right now, and stop it. That is the whole
 * surface, and it is deliberately about STAGES rather than documents — the
 * document on disk IS the result, so anything that wants to know what a book
 * says reads the book.
 *
 * ── What used to live here ──────────────────────────────────────────────────
 *
 * The four foundry stages (Get Text, Blocks, Reflow, footnote removal by a 4B
 * adapter) went in Aug 2026 with the Tesseract pipeline they belonged to.
 * Reading the pages is `vlm:convert` now — one act, producing a book — and
 * footnote references come out as the NARRATION COPY is written
 * (electron/narration-export.ts), which edits no book at all.
 *
 * The document-curation half (`document:state`, `read-blocks`, `apply-edits`,
 * `create-working-copy`, `reset-to`, `discard`, `delete-book`, and the
 * `measure-class` probe) went with the pdf-picker in the chain-deletion wave:
 * the picker was their only caller, and curating a working PDF is not something
 * this app does any more. `electron/working-copy.ts` and
 * `electron/working-document-writer.ts` were deleted with them.
 *
 * ── Errors are not state ────────────────────────────────────────────────────
 *
 * Anything that fails here answers `{ success: false, error }` and leaves
 * NOTHING behind. The message reaches the user once, where they asked. There is
 * no persistent error record to attach, clear, or trip over for the rest of a
 * book's life — that model is what this replaced, and trying again is the whole
 * recovery story.
 */

import { ipcMain } from 'electron';

import { abortStageFor, activeStages, unclaimedStageIntents } from './document-stage-registry';



let registered = false;

export function registerDocumentIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('document:cancel-stage', async (_event, projectDir: string) => {
    return { success: true, stopped: abortStageFor(projectDir) };
  });

  /**
   * Every stage running right now, with where it has got to.
   *
   * The answer a window asks for when it STARTS, because a renderer reload does
   * not stop a stage — main owns it — but it does lose every broadcast the stage
   * has already made. Without this a reloaded window can only wait for the next
   * line, which is a whole page away, so its queue row sits frozen while the
   * elapsed timer keeps counting and the run looks hung.
   *
   * The AbortController is not sent: it is a handle on a process in this
   * process, and the way a window stops a stage is `document:cancel-stage`.
   *
   * ── "Running" here means ORDERED, not CLAIMED (2026-08-10) ────────────────
   *
   * A conversion spends up to a minute waiting on the GPU arbiter and loading a
   * model before it claims its project, and for that whole window this handler
   * used to answer "nothing is running" about a book that plainly was being
   * converted. Every caller asks this question to decide whether to START a
   * second run or to FOLLOW the one in flight, and both of those decisions are
   * wrong when the answer is a minute early: a queue row told the stage was gone
   * declares a ninety-minute conversion finished on the spot.
   *
   * So the listing is the union of the claims and the orders that have not
   * reached their claim (`unclaimedStageIntents`). `claimed` says which a row is,
   * because they are not the same fact and a caller that needs the difference —
   * anything about writing to the working document — must not have to infer it
   * from a null progress line. An unclaimed order has no progress yet, and
   * `lastProgress: null` is the honest reading of a model that is still loading,
   * exactly as it is for a claim whose first page has not landed.
   */
  ipcMain.handle('document:active-stages', async () => {
    return {
      success: true,
      stages: [
        ...activeStages().map((s) => ({
          projectDir: s.projectDir,
          label: s.label,
          startedAt: s.startedAt,
          lastProgress: s.lastProgress,
          claimed: true,
        })),
        ...unclaimedStageIntents().map((s) => ({
          projectDir: s.projectDir,
          label: s.label,
          startedAt: s.startedAt,
          lastProgress: null,
          claimed: false,
        })),
      ],
    };
  });

}

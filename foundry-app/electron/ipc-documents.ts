/**
 * ipc-documents — opening, reading and saving a document, and the questions asked before a window lets go.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readAppSettings } from '@owen/foundry-core/node/app-settings';
import { admitted, openDocument, promptForDocument } from './documents';
import { exportInTray } from '@owen/foundry-core/node/projects';
import { answerLetGo, foundryWindow } from './window';
import { confirmClose, confirmReRead } from '@owen/foundry-core/node/doors-questions';
import { readDocumentBytes } from '@owen/foundry-core/node/doors-library';
import { onPdfNotice } from '@owen/foundry-core/node/pdf-repair';
import type { ReReadPrompt } from '@owen/foundry-core/shared/reread';
import type { Asked, CloseAnswer, CloseWarning, ReReadAnswer } from '@owen/foundry-core/shared/types';

export function registerDocumentDoors(): void {
  ipcMain.handle('dialog:open-document', () => promptForDocument());

  // A drop hands the renderer a path (webUtils, in the preload); main decides
  // whether it is openable. The renderer never gets to assert that a file is.
  ipcMain.handle('document:open-path', (_event, candidate: string) => openDocument(candidate));

  /**
   * A whole open document's bytes, for the app's own PDF viewer.
   *
   * IPC RATHER THAN `fetch` ON `foundry-file://`, and it is the renderer's own
   * policy that decides it: the page is served under `connect-src 'self'`, which
   * refuses a fetch to any other scheme — and widening the document's policy so
   * it may connect to a scheme that serves whole files off disk is a bigger
   * hole than this handler is, for a viewer that has to hold the file in memory
   * anyway. (The scheme once had a whole-file route for Chromium's viewer; it
   * went with the viewer.) The gate is `admitted`, the same one everything that
   * serves a document asks — a second DOOR, not a second rule.
   *
   * BUFFERED, WHOLE, deliberately: pdf.js is handed a buffer and searches every
   * page of it, so the scan is resident regardless and streaming would only add
   * a second copy.
   */
  ipcMain.handle('document:read-bytes', (_event, target: string) => readDocumentBytes(target));

  // A working PDF rebuilt (or found past rebuilding) on import or on open is told
  // to every window's notice strip, the way a person hears it (pdf-repair.ts).
  onPdfNotice((sentence) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('document:notice', sentence);
    }
  });

  /**
   * Save a copy of an open document where the user says — the PDF tab's Save.
   *
   * DIALOG AND COPY IN ONE HANDLER, where the EPUB flow splits them. A book is
   * repacked from a working copy that can still be changing, so its grant and
   * its write are separate steps with a grant list between them; a PDF is one
   * finished file this app never edits, and the dialog's answer can be spent on
   * the spot. The source is still gated by `admitted` — the dialog authorizes
   * the DESTINATION, and only the user's own choice of one, but what may be
   * read out of the workspace remains the allow-list's question.
   */
  /**
   * SAVE A COPY OF AN EXPORT — the door the finished shelf row presses.
   *
   * Gated on the FINAL TRAY rather than the opened-documents allow-list,
   * because an export was never "opened": it is a file this app just wrote
   * into `<project>/final/`, and membership in a project's tray is exactly the
   * claim being exercised. Anything else — a path outside every project, or
   * inside one but not in its tray — is refused; this door copies exports and
   * copies nothing else.
   */
  ipcMain.handle('export:save-copy', async (_event, target: string) => {
    const resolved = path.resolve(target);
    if (exportInTray(resolved) === null) {
      throw new Error('That file is not one of this library’s exports.');
    }
    const extension = path.extname(resolved).replace('.', '').toLowerCase();
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Save a copy of this export',
      defaultPath: path.join(app.getPath('downloads'), path.basename(resolved)),
      filters: extension.length > 0
        ? [{ name: extension.toUpperCase(), extensions: [extension] }]
        : [],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) === resolved) {
      throw new Error('That is the file itself. Pick somewhere else to put the copy.');
    }
    await fsp.copyFile(resolved, result.filePath);
    return result.filePath;
  });

  ipcMain.handle('document:save-copy', async (_event, source: string, suggestedName: string) => {
    const resolved = admitted(source);
    if (resolved === null) {
      throw new Error(`${source} was never opened in this app.`);
    }
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    // The library, same as the book pickers: the folder the user pointed this
    // app at is where its outputs go unless they steer elsewhere.
    const library = readAppSettings().libraryDir;
    await fsp.mkdir(library, { recursive: true });
    const options = {
      title: 'Save a copy of this PDF',
      defaultPath: path.join(library, suggestedName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) === resolved) {
      // Copying a file onto itself truncates it before it can be read. The
      // dialog makes this easy to do by accident — it opens on the library —
      // and the answer is a refusal, not a clever in-place no-op.
      throw new Error('That is the file itself. Pick somewhere else to put the copy.');
    }
    await fsp.copyFile(resolved, result.filePath);
    return result.filePath;
  });

  /**
   * The renderer's answer to `window:closing` — the one reply, spent once.
   *
   * `handle` rather than `on` so the renderer knows the answer arrived: without
   * it, a reply sent into a main process that had already given up waiting would
   * be indistinguishable from one that landed, and the renderer's own "the window
   * is going" state would never clear.
   */
  ipcMain.handle('window:let-go', (_event, go: boolean) => {
    answerLetGo(go === true);
  });

  /**
   * The window, closed from inside it — the ✕ pressed by the page rather than
   * by a person.
   *
   * ── Why the renderer needs a door at all ────────────────────────────────────
   *
   * Because HOSTED, RUNNING OUT OF TABS IS THE END OF THE WINDOW. Standalone,
   * closing the last document leaves the workbench standing in the project it
   * was in, and Home under that is where the app legitimately begins; hosted,
   * the book list is BookForge's and falling through to a second project picker
   * is the workbench turning into a copy of the app around it (user ruling,
   * 2026-08-16). The moment is the renderer's — main knows which files were ever
   * opened, not which documents are open NOW, the same asymmetry `window:closing`
   * exists for — and the act is main's, because a page cannot close the window
   * it is drawn in.
   *
   * IT IS THE ✕'S OWN PATH AND NOT A SHORTCUT PAST IT. `close()` re-enters the
   * window's `close` handler, which runs `letTheWindowGo` and asks the documents
   * through `window:closing` exactly as a pointer on the ✕ would. With nothing
   * open that answer is yes and arrives immediately; if something is still open
   * — anything that ever calls this with tabs left — the question is asked, and
   * a person who says keep it keeps their window.
   *
   * NO WINDOW IS NOT AN ERROR HERE. A page invoking this during teardown, after
   * the window it was drawn in has already gone, is asking for a state that has
   * arrived; `foundryWindow()` is null in exactly that case and the door is a
   * no-op rather than a throw into a renderer that is being destroyed.
   */
  ipcMain.handle('window:close', () => {
    foundryWindow()?.close();
  });

  /**
   * The warning before a tab with something to lose closes.
   *
   * Worded around what is ACTUALLY at risk. Closing a tab deletes nothing on
   * disk — the project keeps every byte of the book and Home still lists it — so
   * what a close can cost is a stack of changes nobody applied, and nothing
   * else. Telling a user their work is
   * about to be destroyed when it is not would teach them to distrust the next
   * warning that matters.
   *
   * ── TWO REASONS, ONE QUESTION ───────────────────────────────────────────────
   *
   * A book pane can hold changes nobody applied, and a book's filed copy can be
   * out of date. They are two different states and this app has already ruled that
   * a closing document is asked about once (`closeShowing`,
   * core/documents.service.ts): a second card on top of the first is the app
   * arguing with an answer it already has.
   *
   * NEITHER IS A LOSS ANY MORE, and the first one used to be. Closing over a
   * stack destroyed it until 2026-08-22; it is now written to a sidecar as it is
   * made and comes back at the same step, so this card asks whether to RECORD the
   * work rather than warning that it is about to go. See `aboutTheEdits` for the
   * whole of that reversal.
   *
   * IT WAS THREE. The third — "no copy of this exists anywhere you chose" — went
   * with the user's own ruling (*"only pop up a confirmation alert if changes have
   * been made"*), and the fourth, the block editor's uncommitted CURATION, went
   * with the block editor itself: there is one editing surface now and its
   * unapplied work is the stack, which is the first arm below.
   */
  ipcMain.handle(
    'document:confirm-close',
    (_event, warning: CloseWarning): Asked<CloseAnswer> => confirmClose(warning),
  );


  /**
   * "Read this book again?" — the queue confirm, `BANK-LIFECYCLE.md` §3.
   *
   * MAIN'S QUESTION AND THE APP'S OWN CARD, like `confirmClose` and like every
   * other question this app asks. It was a native box, and the box's own defence
   * was that it is modal to the window — the next thing that happens after a yes
   * is an enqueue, and a question the user can click behind is a question they
   * can answer twice. The card is modal to the window in the only sense that
   * matters here: it is a full-window scrim at the top of the stack, so the Add
   * button under it cannot be reached while it is up.
   *
   * ONE CARD FOR THE WHOLE QUESTION. The replaced reading and every step that goes
   * stale with it are one cost and are asked about once; a second question listing
   * the casualties would be this app arguing with an answer it already has, which
   * is the rule `closeShowing` established for a closing document.
   *
   * THE SENTENCES ARE THE RENDERER'S, and this is the only question here where
   * that is true. They are read off the step ledger, the renderer already mirrors
   * it, and the composition is a pure shared function held down by tests
   * (`reReadAhead`, shared/reread.ts) — so main asking the disk again would be a
   * round trip for a decision that is already made and already checked. What stays
   * main's is what has always been main's: the shape of the question, the buttons,
   * and what a press of one of them means.
   *
   * ANYTHING UNRECOGNISED IS A NO. A yes here spends hours of GPU and replaces a
   * bank; a card somebody dismissed is not somebody agreeing to that — which is
   * why `dismissed` names the leave-it answer rather than the proceed one.
   *
   * THE CARD DOES NOT CLOSE THE OCR DIALOG IT IS ASKED FROM. That is the
   * renderer's rule and it is written down where it is enforced
   * (`ConfirmService.put`), but it is this question that needed it: the ask comes
   * from inside the OCR card, and a "no" that took the OCR card away with it would
   * answer a question nobody asked.
   */
  ipcMain.handle(
    'reading:confirm-re-read',
    (_event, prompt: ReReadPrompt): Asked<ReReadAnswer> => confirmReRead(prompt),
  );
}

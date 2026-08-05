/**
 * document-open-when-finished — the app's half of the "open when finished"
 * promise.
 *
 * See `shared/document/open-when-finished.ts` for what the promise IS and why it
 * cannot live in a component. This module is the part that needs the main
 * process: the ledger's one instance, the two IPC handlers a renderer uses to
 * make and withdraw a request, and the hook every document stage calls when it
 * stops.
 *
 * ── How a promise is paid ────────────────────────────────────────────────────
 *
 * The stage finishing is NOT the payout. `document:stage-finished` is broadcast
 * from a `finally`, so it fires for a stage that failed and for one the user
 * cancelled, and opening a station on either would show the user a document the
 * run did not write. So the payout is in two halves, and the second half is
 * measured:
 *
 *  1. When a stage that this project is waiting on ends, main makes sure an
 *     editor window is OPEN on the book — creating one if the user closed it,
 *     focusing the existing one otherwise. It does not consume the request.
 *  2. That window's picker re-measures the documents (it does that anyway,
 *     because a stage landed) and then TAKES the request. Taking is atomic, so a
 *     book open in two windows pays out once. If the station it asked for is not
 *     actually present — the stage failed, or was cancelled — the picker has the
 *     measurement in hand and simply does not open it.
 *
 * The window is opened by a callback handed in at registration rather than by
 * importing main.ts, which imports this.
 */

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { OpenWhenFinishedLedger } from '../shared/document/open-when-finished';
import { STATIONS, type StationId } from '../shared/document/stations';

const ledger = new OpenWhenFinishedLedger();

/** Opens or focuses the editor window for a project. Supplied by main. */
export type EditorOpener = (projectDir: string) => void;

let openEditor: EditorOpener | null = null;

function requireOpener(): EditorOpener {
  if (!openEditor) {
    throw new Error(
      'The "open when finished" promise has nothing to open with: registerOpenWhenFinishedIpc was '
      + 'never given an editor opener. That is a wiring bug in main, not a user state.'
    );
  }
  return openEditor;
}

function isStationId(value: unknown): value is StationId {
  return typeof value === 'string' && (STATIONS as readonly string[]).includes(value);
}

/**
 * A stage over this project stopped.
 *
 * Called from BOTH places that broadcast `document:stage-finished` — the
 * picker-initiated path (`document-ipc.ts`) and the queue path
 * (`processing-passes.ts`) — because the whole point of the promise is that it
 * does not care which of them ran the work.
 */
export function noteDocumentStageFinished(projectDir: string, stage: string): void {
  if (!ledger.awaits(projectDir, stage)) return;

  // A project the user has since deleted is a real state, not a fault: the
  // promise is dropped with a line saying so, and nothing is opened. Checked
  // against the manifest rather than the directory, because an empty folder left
  // behind by a delete is not a project either.
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    ledger.cancel(projectDir);
    console.log(
      `[open-when-finished] dropping the promise for ${projectDir}: it is not a BookForge project `
      + 'any more (no manifest.json), so there is nothing to open.'
    );
    return;
  }

  console.log(
    `[open-when-finished] ${stage} finished for ${projectDir}; opening its editor so the promise `
    + 'can be paid there.'
  );
  try {
    requireOpener()(projectDir);
  } catch (err) {
    // The promise stands. A window that could not be opened this second is not
    // evidence the user stopped wanting the artifact, and the request is taken
    // by whichever window does open on this book.
    console.error('[open-when-finished] could not open the editor window:', err);
  }
}

let registered = false;

export function registerOpenWhenFinishedIpc(opener: EditorOpener): void {
  openEditor = opener;
  if (registered) return;
  registered = true;

  /**
   * "When the run I am about to submit lands, open this station."
   *
   * Made BEFORE the submission, so a run that starts and finishes inside the
   * round trip still finds the promise waiting.
   */
  ipcMain.handle('document:request-open-when-finished', (
    _event, projectDir: string, station: unknown
  ) => {
    try {
      if (!isStationId(station)) {
        throw new Error(
          `"${String(station)}" is not a station this pipeline has. An open-when-finished request `
          + `names one of: ${STATIONS.join(', ')}.`
        );
      }
      ledger.request(projectDir, station);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Withdraw it — a run that was refused will never finish. */
  ipcMain.handle('document:cancel-open-when-finished', (_event, projectDir: string) => {
    ledger.cancel(projectDir);
    return { success: true };
  });

  /**
   * Take the promise for this project: the station, once, or null.
   *
   * The window that takes it is the window that pays it. Whether the station is
   * actually THERE is the caller's question — it has just measured the
   * documents, and this module never has.
   */
  ipcMain.handle('document:take-open-when-finished', (_event, projectDir: string) => {
    return { success: true, station: ledger.take(projectDir) };
  });
}

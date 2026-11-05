/**
 * documents — the one door a file comes in through, and the list of what came.
 *
 * Split out of main.ts with the mount seam, because opening a document is not a
 * standalone-shell concern and not an IPC concern either: the menu, a drop, the
 * command line, `open-file` and a finished conversion all reach it, and the
 * allow-list it keeps is what every read gate in the app asks. It sits below
 * both so that neither can grow a second copy of the rule.
 */
import { BrowserWindow, dialog } from 'electron';

import { openDocumentWith } from '@owen/foundry-core/node/document-intake';
import { foundryWindow } from './window';

/*
 * THE ALLOW-LIST LIVES IN openable.ts (2026-11-04), so the work code can admit a
 * path without importing this file's window half. Re-exported here because this
 * is still the door every open passes through, and ipc.ts asks it for both.
 */
export { admit, admitted } from '@owen/foundry-core/node/openable';
/*
 * WHAT AN OPEN DOES lives in document-intake.ts (2026-11-04, FOUNDRY-CORE-PLAN
 * step 2); the argv reader went with the extension list it reads.
 */
export { documentFromArgv } from '@owen/foundry-core/node/document-intake';

/**
 * Admit a path and tell every window about it — the single door every open
 * passes through (document-intake.ts, `openDocumentWith`, holds the whole of
 * what it does). The two pushes are this file's because they are the half that
 * needs BrowserWindow, sent exactly as they always were: to every window, one
 * `webContents.send` each.
 */
export async function openDocument(candidate: string): Promise<string | null> {
  return openDocumentWith(candidate, {
    opened: (resolved) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('document:opened', resolved);
      }
    },
    relocated: (move) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('document:relocated', move);
      }
    },
  });
}

export async function promptForDocument(): Promise<string | null> {
  const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: 'Open a document',
    properties: ['openFile' as const],
    filters: [
      { name: 'Books and scans', extensions: ['pdf', 'epub'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'EPUB', extensions: ['epub'] },
    ],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;
  return openDocument(chosen);
}

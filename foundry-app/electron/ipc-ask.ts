/**
 * ipc-ask — analysis categories, Ask the document, and the library folder.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { readAppSettings, writeAppSettings } from '@owen/foundry-core/node/app-settings';
import { cancelAsk, deleteAskConversation, readAskConversations, readAskSessions, renameAskConversation, saveAskSession, startAsk } from '@owen/foundry-core/node/ask-document';
import { cancelSuggest, startSuggest } from '@owen/foundry-core/node/suggest-categories';
import type { SuggestCategoriesRequest } from '@owen/foundry-core/shared/category-suggestions';
import type { AskRequest, AskSession } from '@owen/foundry-core/shared/ask';
import type { AskPresetsKept } from '@owen/foundry-core/shared/ask-presets';
import { admitted } from './documents';
import { broadcast, foundryWindow } from './window';
import { refuseHostedLibraryMove, readAskPresets, saveAskPresets } from '@owen/foundry-core/node/doors-library';
import { type CustomAnalysisCategory } from '@owen/foundry-core/shared/analysis-categories';

export function registerAskDoors(): void {
  // ── The library folder ───────────────────────────────────────────────────
  /*
   * ── THE USER'S OWN ANALYSIS CATEGORIES ────────────────────────────────────
   *
   * Owen, 2026-08-25: *"maybe the user can add more categories - even
   * one-sentence descriptive ones."* They are the USER'S and not one project's,
   * so they live in `app-settings.json` beside the library folder and reach every
   * book that machine ever opens (`AppSettings.analysisCategories`).
   *
   * TWO DOORS AND NOT ONE, and the write takes the WHOLE LIST rather than a
   * single add or remove. A per-item door would need an id from the renderer to
   * say which item, and ids here are DERIVED from names by main — so "remove the
   * one called X" would be main re-deriving a name the renderer had already
   * derived, and the two derivations would be the thing that had to agree. The
   * whole list is one fact with one owner, and `clampAnalysisCategories` re-mints
   * every id on the way in, so what the file holds is always main's own spelling
   * whatever the window sent.
   *
   * IT IS NOT REFUSED WHEN HOSTED. A library move is refused there because the
   * books belong to the host; a list of claims somebody wants hunted for belongs
   * to the person, and BookForge has no opinion about it.
   */
  ipcMain.handle('analysis:read-categories', () => readAppSettings().analysisCategories);
  ipcMain.handle(
    'analysis:write-categories',
    (_event, categories: CustomAnalysisCategory[]) =>
      writeAppSettings({
        analysisCategories: Array.isArray(categories) ? categories : [],
      }).analysisCategories,
  );
  /*
   * SUGGEST CATEGORIES FROM THE BOOK — one streamed chat over excerpts
   * (electron/suggest-categories.ts). Ask's shape: start answers with the run's
   * id at once, the run arrives on `analysis:suggest-progress`, and each
   * suggestion is saved into the user's categories as it arrives. The book must
   * be one this window opened, the plan door's own gate.
   */
  ipcMain.handle('analysis:suggest-start', (_event, request: SuggestCategoriesRequest) => {
    const source = admitted(request.inputPath);
    if (source === null) throw new Error(`${request.inputPath} was never opened in this app.`);
    return startSuggest(request, source, (frame) => { broadcast('analysis:suggest-progress', frame); });
  });
  ipcMain.handle('analysis:suggest-cancel', (_event, runId: string) => { cancelSuggest(runId); });

  /*
   * ── ASK THE DOCUMENT — a model works through the book with tools ──────────
   *
   * `ask:start` ANSWERS WITH THE RUN'S ID AT ONCE and the run arrives on
   * `ask:progress` — a run is minutes of a model's work, and an invoke held that
   * long is one the renderer cannot even be told about (the pull door's rule).
   * Every frame carries the project, so a pane that was closed and opened again
   * still knows which frames are its own. NOTHING HERE WRITES THE BOOK: the
   * marks come back as a list and the renderer lands them on its own stack
   * (electron/ask-document.ts says why).
   *
   * THE SESSIONS ARE THE RECORD THE REVIEW CARD READS after a reload, written
   * by the renderer once a run has landed, with only what landed.
   */
  ipcMain.handle('ask:start', (_event, request: AskRequest) =>
    startAsk(request, (frame) => { broadcast('ask:progress', frame); }));
  ipcMain.handle('ask:cancel', (_event, runId: string) => { cancelAsk(runId); });
  ipcMain.handle('ask:sessions', (_event, projectDir: string) => readAskSessions(projectDir));
  ipcMain.handle('ask:save-session', (_event, projectDir: string, session: AskSession) =>
    saveAskSession(projectDir, session));
  // A book's conversations (shared/ask-conversations.ts), newest first; the first read migrates the old thread.
  ipcMain.handle('ask:conversations', (_event, projectDir: string) => readAskConversations(projectDir));
  ipcMain.handle('ask:delete-conversation', (_event, projectDir: string, id: string) => deleteAskConversation(projectDir, id));
  ipcMain.handle('ask:rename-conversation', (_event, projectDir: string, id: string, title: string) =>
    renameAskConversation(projectDir, id, title));
  // Ask's presets are the app's, kept in app-settings.json (shared/ask-presets.ts).
  ipcMain.handle('ask:presets', (): AskPresetsKept => readAskPresets());
  ipcMain.handle('ask:save-presets', (_event, patch: Partial<AskPresetsKept>): AskPresetsKept =>
    saveAskPresets(patch));

  ipcMain.handle('library:dir', () => readAppSettings().libraryDir);
  ipcMain.handle('library:set', (_event, dir: string) => {
    refuseHostedLibraryMove();
    return writeAppSettings({ libraryDir: dir }).libraryDir;
  });
  ipcMain.handle('library:choose', async (_event, current: string) => {
    refuseHostedLibraryMove();
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Where should Foundry keep your books?',
      defaultPath: current,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

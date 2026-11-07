/**
 * quit-gate — whether a quit has to ask the book window before it may go on.
 *
 * Foundry's window (foundry-app/electron/window.ts) asks its open documents on its
 * first `close`, prevents that close, and closes itself on a yes. Electron cancels
 * `app.quit()` when a window prevents its close, so a quit that reached the window
 * that way only closed it, and the app stayed in the tray (Owen, 2026-11-07). The
 * quit therefore asks first, while the window is open and has not been let go, and
 * quits again from the answer (main.ts `before-quit`).
 */

/** The part of a window this asks about. */
export interface QuitGateWindow {
  isDestroyed(): boolean;
}

/** True when `before-quit` must stop and ask the book window before shutting anything down. */
export function quitWaitsForBookWindow(bookWindow: QuitGateWindow | null, letGo: boolean): boolean {
  return bookWindow !== null && !bookWindow.isDestroyed() && !letGo;
}

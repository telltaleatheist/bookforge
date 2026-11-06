/**
 * An export Foundry filed without metadata is said in the book window's notice
 * tray (`ExportLanding.problem`, foundry-core 0.1.1).
 *
 * The book is made and filed, so this is news and never a failure. It uses the
 * channel the Narrate overlay already says things through (`host-ops:notice`,
 * read by `bookforgeWindow.onHostNotice` in the window's preload).
 *
 * With no book window open there is no tray to say it in, and BookForge has no
 * main-window notice path, so it is a named console line rather than nothing.
 */

/** The parts of a BrowserWindow this needs. */
export interface NoticeWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, text: string): void };
}

export function sayLandingProblem(
  landing: { readonly problem?: string },
  bookWindow: NoticeWindow | null,
): void {
  if (landing.problem === undefined) return;
  if (bookWindow === null || bookWindow.isDestroyed()) {
    console.error(`[foundry] no book window to say this in: ${landing.problem}`);
    return;
  }
  bookWindow.webContents.send('host-ops:notice', landing.problem);
}

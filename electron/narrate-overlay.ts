/**
 * narrate-overlay — BookForge's Narrate dialog, drawn inside the book window.
 *
 * Owen's ruling (docs/REORG-PLAN.md, B5): Narrate opens as a modal inside the
 * Foundry window. Pressing it used to raise BookForge's main window and ask
 * there; now nothing switches windows.
 *
 * ── Why it is BookForge's renderer in a view, not a copy of the dialog ───────
 *
 * The dialog is `NarrationModalComponent`, and what it queues is built out of
 * BookForge's settings and library, which live in BookForge's renderer
 * `localStorage`. A copy compiled into the window's own renderer would read a
 * different origin's storage and could queue a different job. So the overlay IS
 * BookForge's renderer: a `WebContentsView` laid over the book window, on
 * BookForge's preload, in the default session, loaded the way the main window
 * loads (`load` is main.ts's `loadBookForgeRenderer`), at the standalone route
 * `#/narrate`, which draws the one dialog on a transparent page. Same component,
 * same services, same storage, same preload: the same job, by construction.
 *
 * ── Lifecycle (main owns the view) ───────────────────────────────────────────
 *
 * - One at a time. A second press while one is up focuses the one that is up.
 * - Removed on the dialog's cancel and on its queued (`narrate-overlay:done`),
 *   when its renderer is gone, and when the book window closes. Every exit runs
 *   `remove`, which detaches the view, drops the resize listener and closes the
 *   view's page, so nothing is left attached.
 * - Queued: the overlay goes and the book window says so in its notice tray,
 *   pointing at its queue shelf. BookForge's main window is not navigated.
 */
import { BrowserWindow, ipcMain, WebContentsView, type WebContents } from 'electron';

/** What main.ts hands this module: the parts of a BookForge window it does not own. */
export interface NarrateOverlayDeps {
  /** BookForge's preload, the main window's own. */
  preload: string;
  /** Load BookForge's renderer at `#/narrate`, exactly as the main window loads it. */
  load(contents: WebContents, hash: string): void;
  /** The zoom every BookForge page is drawn at. */
  zoomLevel(): number;
  /** Say one line in the book window's notice tray. */
  sayInWindow(host: BrowserWindow, text: string): void;
}

interface Overlay {
  host: BrowserWindow;
  view: WebContentsView;
  /** The target the dialog asks for when it starts (`narrate-overlay:target`). */
  target: unknown;
  remove(): void;
}

let current: Overlay | null = null;

/** Open the overlay over `host`, or focus the one already up. */
export function openNarrateOverlay(host: BrowserWindow, target: unknown, deps: NarrateOverlayDeps): void {
  if (current !== null) {
    if (!current.host.isDestroyed()) current.host.focus();
    if (!current.view.webContents.isDestroyed()) current.view.webContents.focus();
    return;
  }

  const view = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: deps.preload },
  });
  // The page is transparent; the dialog draws its own dimmed backdrop over the window.
  view.setBackgroundColor('#00000000');

  const fit = (): void => {
    if (host.isDestroyed()) return;
    const [width, height] = host.getContentSize();
    view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
  };

  const overlay: Overlay = {
    host,
    view,
    target,
    remove: () => {
      if (current !== overlay) return;
      current = null;
      host.removeListener('resize', fit);
      host.removeListener('closed', onHostClosed);
      if (!host.isDestroyed()) host.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    },
  };
  const onHostClosed = (): void => overlay.remove();

  current = overlay;
  host.contentView.addChildView(view);
  fit();
  host.on('resize', fit);
  host.once('closed', onHostClosed);
  view.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[narrate-overlay] its renderer is gone (${details.reason}); the overlay is removed`);
    overlay.remove();
  });
  view.webContents.on('did-finish-load', () => {
    view.webContents.setZoomLevel(deps.zoomLevel());
    view.webContents.focus();
  });
  deps.load(view.webContents, '/narrate');
}

/** The overlay `contents` belongs to, or a refusal: these doors answer only the overlay. */
function overlayOf(contents: WebContents): Overlay {
  if (current === null || current.view.webContents !== contents) {
    throw new Error('Only the Narrate overlay asks this, and this page is not it.');
  }
  return current;
}

/** Register the overlay's two doors. Once, at startup. */
export function registerNarrateOverlayDoors(deps: NarrateOverlayDeps): void {
  // The dialog's target, asked for when the page has started rather than pushed at
  // load, so it cannot arrive before Angular is listening.
  ipcMain.handle('narrate-overlay:target', (event) => overlayOf(event.sender).target);

  // The dialog closed: cancelled, or queued `jobs` runs.
  ipcMain.handle('narrate-overlay:done', (event, outcome: { queued: boolean; jobs: number }) => {
    const overlay = overlayOf(event.sender);
    const host = overlay.host;
    overlay.remove();
    if (outcome.queued && !host.isDestroyed()) {
      deps.sayInWindow(host, outcome.jobs === 1
        ? 'The narration is queued. It is on the queue shelf.'
        : `${outcome.jobs} narration runs are queued. They are on the queue shelf.`);
    }
  });
}

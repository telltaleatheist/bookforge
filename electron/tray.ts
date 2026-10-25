/**
 * BOOKFORGE LIVES IN THE TRAY (Owen, 2026-10-25).
 *
 * Verbatim: *"i accidentally closed the wrong window on bookforge. i closed the
 * main window. foundry was still open. i closed foundry to reopen the main
 * window but it killed the whole app. lets make bookforge run in the
 * background. maybe the task bar. on windows and on mac"*
 *
 * Closing a window is not quitting. The queue runs books overnight, the
 * bookshelf server answers phones, and a Crucible render holds a card — none of
 * that should end because the last visible window was closed. So:
 *
 * - the main window's ✕ HIDES it (main.ts, `createWindow`), on every platform
 *   that has a tray;
 * - closing every window leaves the app running here;
 * - QUITTING is a deliberate act: this icon's "Quit BookForge", or Ctrl/Cmd+Q.
 *
 * The icon is the notification area on Windows and the menu bar on a Mac.
 * Left-click on Windows opens the main window (that is what a tray click means
 * there); on a Mac a click opens the menu, which is what a menu-bar item does.
 */
import { Tray, Menu, nativeImage } from 'electron';

export interface TrayActions {
  showMain(): void;
  openClipforge(): void;
  quit(): void;
}

let tray: Tray | null = null;
let toldAboutTray = false;

export function installTray(iconPath: string, actions: TrayActions): void {
  if (tray) return;
  const size = process.platform === 'darwin' ? 18 : 16;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // Misconfiguration, and the window-close rule depends on this icon existing
    // (`hasTray`), so say so — the app then keeps the old close-quits behaviour.
    console.error(`[Tray] the icon at ${iconPath} could not be read — no tray icon, closing the last window will quit`);
    return;
  }
  tray = new Tray(icon.resize({ height: size }));
  tray.setToolTip('BookForge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open BookForge', click: () => actions.showMain() },
    ...(process.platform === 'win32'
      ? [{ label: 'Open ClipForge', click: () => actions.openClipforge() }]
      : []),
    { type: 'separator' },
    { label: 'Quit BookForge', click: () => actions.quit() },
  ]));
  if (process.platform !== 'darwin') {
    tray.on('click', () => actions.showMain());
  }
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed();
}

/**
 * The first time a close only hides the window, say where the app went — once
 * per run. Without it the ✕ looks like it quit, and the person who wanted it
 * gone does not know it is still holding the queue.
 */
export function noteHiddenToTray(): void {
  if (toldAboutTray || !hasTray() || process.platform !== 'win32') return;
  toldAboutTray = true;
  tray!.displayBalloon({
    title: 'BookForge is still running',
    content: 'It is in the tray. Click the icon to open it; right-click it to quit.',
    iconType: 'info',
  });
}

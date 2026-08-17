/**
 * window — the Foundry window itself, and the question asked before it goes.
 *
 * Split out of main.ts when the app learned to be hosted: a window is something
 * BookForge OPENS, while a menu, an argv document and the process's own quit are
 * things only a standalone shell has (docs/BOOKFORGE-HANDOFF.md §8). What is in
 * here is everything about the window that is the same whoever opened it — how
 * it is built, what it may navigate to, and the close question every open
 * document is owed.
 *
 * ONE WINDOW, held in a module-level reference, because that is what this app is:
 * a workbench with tabs in it rather than a document-per-window editor. A host
 * that opens Foundry twice gets the window it already had, raised.
 */
import * as path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

/**
 * `--dev` on the command line, and where `ng serve` answers.
 *
 * HOSTED, THE FLAG IS THE HOST'S. BookForge running its own renderer from a dev
 * server does not mean Foundry's page is on one — the window loads the bundle
 * that was built beside this file either way — so a host that passes `--dev`
 * gets Foundry's dev behaviour too. That is the honest reading of a process-wide
 * switch, and the alternative (a second flag nobody would remember to pass)
 * would be worse.
 */
export const isDev = process.argv.includes('--dev');
export const DEV_SERVER = 'http://localhost:4260';

let mainWindow: BrowserWindow | null = null;

/**
 * The window, for anything that has to put a modal dialog over it or send it a
 * message. Null before it is opened and after it is closed — both are ordinary
 * states, and every caller here already has an answer for "there is no window".
 */
export function foundryWindow(): BrowserWindow | null {
  return mainWindow;
}

/** One push to every window. The renderer holds mirrors; main holds the truth. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * The window is allowed to go — every open document has been asked what closing
 * it costs, and answered.
 *
 * ── Why quitting needs a flag at all ────────────────────────────────────────
 *
 * Quit used to bypass per-tab closing entirely: the window was destroyed, the
 * tabs went with it, and none of them was ever asked the question the ✕ on a tab
 * asks. That was survivable while the only thing at stake was a file copy, and it
 * is not now — closing a scan is the moment a session's undo history stops
 * existing, so a quit was a silent conversion of "undoable" into "permanent" for
 * every book in the window at once.
 *
 * The ask has to happen BEFORE `before-quit`'s own body, not after it, and that
 * is the reason this is one flag consulted in two places rather than a guard in
 * the window's `close` alone. `before-quit` aborts every running job and stops the
 * reading server; a person who answered "keep it open" to a dialog raised after
 * all that would have kept their window and lost the three-hour run in it.
 */
let letGo = false;

/** Whether the documents have been asked and said yes — `before-quit`'s gate. */
export function windowLetGo(): boolean {
  return letGo;
}

/**
 * The renderer's promised answer to `window:closing`, held while the dialogs are
 * up — or null when nothing has been asked.
 *
 * ONE AT A TIME, because a second ✕ pressed while the first question is on screen
 * is the same question, and answering it twice would resolve a promise that has
 * already decided the window's fate.
 */
let letGoAnswer: ((go: boolean) => void) | null = null;

/**
 * Whether there is a renderer to ask. Set when the window has actually loaded.
 *
 * WITHOUT THIS THE APP CANNOT BE QUIT after a renderer that failed to load. The
 * question goes out over `webContents.send`, and a page that never ran subscribes
 * to nothing and answers nothing — so the quit would be prevented forever by a
 * dialog nobody could see. A window with no renderer has no open documents, and
 * therefore nothing to ask about.
 */
let rendererLoaded = false;

/** The renderer's one reply, spent once. See the `window:let-go` door. */
export function answerLetGo(go: boolean): void {
  const answer = letGoAnswer;
  letGoAnswer = null;
  answer?.(go);
}

/**
 * Do something to the page once there is a page to do it to — NOW, if there
 * already is one.
 *
 * ── The dropped message this exists to prevent ──────────────────────────────
 *
 * Everything main pushes at the renderer is a push: `document:opened` sent
 * before the page is listening is sent to nobody, and so is the hosted deep link
 * (`project:open`). Both used to be plain `once('did-finish-load')` handlers,
 * which is exactly right for a window that was just built and exactly wrong for
 * one that was already open — the event has fired, it will not fire again, and
 * the message is lost with nothing on screen saying so. Standalone that never
 * happened, because the window is built once; hosted, "Edit in Foundry" is a
 * button somebody presses for a second book while the first is still open, and
 * that press is the case.
 *
 * A RELOAD IS NOT "ALREADY LOADED", which is why the load state is asked as well
 * as the flag: the flag stays true across a refresh the user asked for, and a
 * message sent into a page that is mid-navigation goes to the document that is
 * about to be thrown away.
 */
export function whenRendererReady(win: BrowserWindow, then: () => void): void {
  if (rendererLoaded && !win.webContents.isLoading()) {
    then();
    return;
  }
  win.webContents.once('did-finish-load', then);
}

/**
 * Ask the window's documents, then do the thing that was interrupted.
 *
 * The renderer runs the per-document question — it is the side that knows what is
 * open — and answers once through `window:let-go`. False is the user saying keep
 * it open, and then nothing happens at all: no close, no quit, and whatever
 * `before-quit` was about to shut down is still running.
 */
export function letTheWindowGo(then: () => void): void {
  const contents = mainWindow?.webContents;
  const answer = !rendererLoaded || contents === undefined || contents.isDestroyed()
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
      if (letGoAnswer !== null) {
        // Already asking. The second press is the same question, and it waits for
        // the first one's answer rather than raising a second stack of dialogs.
        resolve(false);
        return;
      }
      letGoAnswer = resolve;
      contents.send('window:closing');
    });
  void answer.then((go) => {
    if (!go) return;
    letGo = true;
    then();
  });
}

/**
 * Build the window, or raise the one that is already up.
 *
 * THE RAISE IS THE HOSTED CASE MADE HARMLESS. Standalone this is called once at
 * startup and again only when macOS reactivates an app with no windows, so the
 * early return never fires; hosted, "Edit in Foundry" is a button somebody can
 * press twice, and the second press must be the first window coming forward
 * rather than a second workbench with its own tabs over the same folders.
 */
export function openWindow(): BrowserWindow {
  const existing = mainWindow;
  if (existing !== null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  // A window built after the last one was closed starts owing the question again.
  letGo = false;
  rendererLoaded = false;
  letGoAnswer = null;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    // --bg-base in app/src/styles.scss. A mismatch here is the colour the
    // window flashes for the frame before the renderer paints.
    backgroundColor: '#181715',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  /*
   * The APP does not zoom. Chromium persists page zoom per origin across
   * launches, so one accidental Ctrl+- used to leave the whole interface at a
   * fraction of itself forever — toolbar, tabs, everything — with nothing in
   * the app able to explain why. The zoom roles are gone from the View menu
   * (electron/main.ts) so it cannot happen again; this line clears whatever zoom
   * a previous launch already recorded. Pinch is pinned too: the PDF viewer
   * turns pinch and Ctrl+wheel into DOCUMENT zoom, which is the one kind of
   * bigger this app means.
   */
  mainWindow.webContents.on('did-finish-load', () => {
    rendererLoaded = true;
    mainWindow?.webContents.setZoomFactor(1);
    void mainWindow?.webContents.setVisualZoomLevelLimits(1, 1);
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER);
  } else {
    // dist/electron -> dist -> app; the renderer build lands in dist/renderer.
    const index = path.join(__dirname, '..', 'renderer', 'browser', 'index.html');
    mainWindow.loadFile(index).catch((err: Error) => {
      void mainWindow?.loadURL(
        'data:text/html,'
        + encodeURIComponent(
          `<body style="background:#181715;color:#faf9f7;font:13px 'Segoe UI',system-ui;padding:40px">
           <h1>The renderer did not load</h1><p>${err.message}</p><p>${index}</p>
           <p>Run <code>npm run build</code> first, or <code>npm start</code> for the dev server.</p>
           </body>`,
        ),
      );
    });
  }

  // A dropped file must not NAVIGATE the window to itself — the drop is handled
  // in the renderer and answered over IPC.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(DEV_SERVER) && !url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // A run from source forwards the renderer's console and its title to the
  // terminal that started it. Not a debug flag: without it, a renderer that
  // threw during bootstrap is a black window and a silent terminal, and the
  // title line is the one signal that says Angular actually ran.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    mainWindow.on('page-title-updated', (_event, title) => {
      console.log(`[renderer] title: ${title}`);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
    });
  }

  /**
   * The ✕ on the window, and the OS asking it to go.
   *
   * Prevented ONCE, so that the documents in it can be asked what closing them
   * costs, and then let through on the second pass. On Windows and Linux this is
   * also the front half of a quit: closing the last window fires
   * `window-all-closed`, which quits — so the question reaches a person who never
   * touched a tab's ✕ and never opened the File menu.
   *
   * HOSTED, IT IS THE FRONT HALF OF NOTHING. Closing the Foundry window leaves
   * BookForge — and the job queue in its main process — running, so this stops
   * being a quit guard and goes back to being what it reads as: the documents in
   * this window, asked what closing them costs.
   */
  mainWindow.on('close', (event) => {
    if (letGo) return;
    event.preventDefault();
    letTheWindowGo(() => mainWindow?.close());
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

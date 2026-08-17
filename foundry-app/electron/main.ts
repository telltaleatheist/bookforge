/**
 * main — the standalone shell: Foundry running as its own program.
 *
 * ── What is left here, and why it is only this ──────────────────────────────
 *
 * This file used to be the whole main process — the protocol, the window, the
 * IPC surface, the queue's wiring and the lifecycle in one place. Then the
 * integration was ruled (docs/BOOKFORGE-HANDOFF.md §8): BookForge hosts the
 * Foundry window, `app/` is copied across nearly verbatim, and a host cannot
 * import an entrypoint — importing this file would register a second app's
 * lifecycle inside its own. So everything a host also needs moved behind
 * `mountFoundry` (electron/mount.ts), and what stayed is exactly what a host
 * ALREADY HAS ITS OWN OF:
 *
 *   the menu           `Menu.setApplicationMenu` is process-global
 *   the command line   `book.pdf` on argv, and macOS's `open-file`
 *   provisioning       the environments this machine is missing
 *   the lifecycle      ready → mount → window; all windows closed → quit;
 *                      quit → ask the documents, then `stopFoundry`
 *
 * Every line of it behaves exactly as it did before the split: same window, same
 * menu, same open-with, same teardown. The seam is a place the code was cut, not
 * a place it was rewritten.
 *
 * Everything with a lifetime still lives in main — the job queue
 * (electron/job-queue.ts) because a renderer reload must not be able to kill an
 * hour of GPU, and the engine's identity (electron/engine.ts) because the
 * renderer is not allowed to name a program to run.
 */
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron';

import { documentFromArgv, openDocument, promptForDocument } from './documents';
import { planProvisioning } from './env-provision';
import * as queue from './job-queue';
import { mountFoundry, openFoundryWindow, stopFoundry } from './mount';
import * as vllm from './vllm-server';
import { foundryWindow, letTheWindowGo, whenRendererReady, windowLetGo } from './window';
import type { MenuAction } from '../shared/api';

// ─────────────────────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A menu item the RENDERER has to carry out, because the thing it acts on is a
 * tab and tabs are renderer state.
 *
 * On the menu rather than as a `keydown` in the renderer: both would fire for
 * one keypress, and only one of the two is discoverable by a person who has
 * never used this app. Ctrl+Tab is the exception and stays in the renderer — a
 * menu item labelled "Next tab" is noise, and cycling is not a File operation.
 */
function sendMenuAction(action: MenuAction): void {
  foundryWindow()?.webContents.send('menu:action', action);
}

/**
 * THE MENU IS THE SHELL'S AND IS NOT PART OF THE MOUNT, because
 * `Menu.setApplicationMenu` replaces the menu of whatever app is running. A host
 * that called this would lose its own File menu to Foundry's; the hosted window
 * inherits the host's menu instead, and the accelerators below are the host's to
 * offer or to leave out (electron/mount.ts says the same from the other side).
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => { void promptForDocument(); },
        },
        {
          /**
           * ── ONE MATERIALISING VERB, WHERE THERE WERE TWO SAVES ──────────────
           *
           * This was Save and Save As. Save wrote the book back to the file the
           * user had already chosen and Save As asked for a new one — the pair
           * every editor has, and the right pair for an app whose document IS a
           * file. It is not that app any more. What a pane shows is a projection of
           * a bank, and there is no version of "write this back" that means
           * anything about a projection: the durable thing is the bank and the
           * ledger, both of which are written the moment anything changes.
           *
           * So the gesture people actually want from here is the one they always
           * meant by Save — GIVE ME THE FINISHED THING — and the user ruled where
           * it lives: "there will be no 'save a copy' or 'save' buttons along the
           * top of panels. those buttons are reserved for the export modal that
           * pops up when you click the export button on the nav rail." One item,
           * one modal, and it asks the only question that is left: which format.
           *
           * IT KEEPS CTRL+S, deliberately. The chord is where a person's hand goes
           * when they want their work out of an app, it is now free, and pointing
           * it anywhere else would leave the most-pressed shortcut in software
           * doing nothing in a document application.
           *
           * MAIN CANNOT OPEN THE MODAL — which pane, which project and which step
           * are renderer state — so it says `export` and the renderer routes it,
           * exactly as `save` was routed before it.
           */
          label: 'Export…',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('export'),
        },
        {
          label: 'Close tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendMenuAction('close-tab'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          // `app:navigate` — namespaced like every other channel this app owns,
          // because hosted these names share a process with BookForge's and a
          // bare `navigate` is a collision waiting for a version bump
          // (docs/IPC-CHANNELS.md).
          click: () => foundryWindow()?.webContents.send('app:navigate', '/settings'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      /**
       * THE EDIT MENU IS OURS NOW, and only because of Undo.
       *
       * It was `{ role: 'editMenu' }` — the platform's own, whose Undo is
       * `webContents.undo()`, which means the focused text field's undo and
       * nothing else. There is a DOCUMENT history now (TabsService), and
       * Ctrl/Cmd+Z has to be able to reach it, so the two items are ours and
       * the renderer decides which of the two things the chord meant: a caret
       * in a text box gets the box's own undo, a caret in a block gets the
       * frame's, and anything else gets the book's.
       *
       * ON THE MENU RATHER THAN AS A RENDERER `keydown`, for the reason every
       * other chord in this file is: a menu item with the accelerator on it and
       * a keydown listener for the same chord BOTH fire, and only the menu is
       * discoverable by somebody who has never used this app. The label is also
       * the only place "undo" is promised, which matters more here than for
       * Save — an editor whose undo does nothing is worse than one with none.
       *
       * The clipboard roles below are kept verbatim from the role menu, because
       * they are the platform's and there is no reason for this app to have an
       * opinion about Copy.
       */
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendMenuAction('undo'),
        },
        {
          label: 'Redo',
          // Ctrl+Shift+Z on both, rather than the Ctrl+Y some Windows apps use:
          // one chord, said one way, and it is the one the editors this app
          // sits beside all take.
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => sendMenuAction('redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      // No zoom roles, on purpose: they scale the APPLICATION — every button
      // and tab, persisted by Chromium across launches — which is never what
      // anybody meant in a document app. Zooming a DOCUMENT is the PDF
      // viewer's own Ctrl+wheel/pinch and +/− buttons.
      submenu: [
        {
          /**
           * The one place the split is DISCOVERABLE.
           *
           * A single-pane workspace is meant to look exactly like the app that
           * had no panes at all — no divider, no split button, nothing hinting
           * at a second column — so a person who has never used the feature
           * would never find it on screen. They find it here. (Ctrl+\ is VS
           * Code's chord for the same operation.) It opens an EMPTY column
           * beside the focused one, which the user then fills from the document
           * list; main owns none of that and only says "split".
           */
          label: 'Split right',
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendMenuAction('split-right'),
        },
        {
          /**
           * The open-documents panel, hidden and brought back.
           *
           * NOT A CHECKBOX ITEM, though it toggles: whether the panel is up is
           * renderer state (it also depends on whether anything is open at all),
           * and a menu that drew its own tick from a value main is guessing at
           * would be wrong the first time the two disagreed. Ctrl+B is the chord
           * every editor with a side panel uses.
           */
          label: 'Documents',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-documents'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch what this machine is missing, once, after the window can show it.
 *
 * AFTER `did-finish-load`, not at `whenReady`: the first thing this does is run
 * `foundry doctor --json`, which takes seconds, and the rows it produces go into
 * the queue shelf — a job enqueued before there is a renderer to push to is a
 * download nobody can see or cancel.
 *
 * Only ONCE per launch. doctor is re-run after every install (the settings page
 * does it, and the shelf row's completion is what prompts it), so a second
 * automatic sweep would only ever find the same answer more slowly.
 *
 * `FOUNDRY_NO_AUTO_PROVISION=1` turns it off, for developing against a machine
 * that is deliberately missing something.
 *
 * THE SHELL'S, NOT THE MOUNT'S. A host has its own idea of when it is willing to
 * download twenty gigabytes of Python, and doing it behind a window it opened
 * for a book would be this app spending somebody else's bandwidth on their
 * startup.
 */
let provisioned = false;

async function provision(): Promise<void> {
  if (provisioned) return;
  provisioned = true;
  if (process.env['FOUNDRY_NO_AUTO_PROVISION'] === '1') {
    console.log('[provision] skipped: FOUNDRY_NO_AUTO_PROVISION=1');
    return;
  }
  try {
    const { needs, note } = await planProvisioning();
    console.log(`[provision] ${note}`);
    for (const need of needs) {
      // No `dest`, no `distro`: the defaults, silently, which is the whole point
      // of provisioning. Anything genuinely ambiguous — several WSL distros —
      // comes back out of the installer as a failed row saying how to choose,
      // rather than as a guess.
      queue.enqueueEnvInstall({ target: need.target }, need.reason);
    }
  } catch (err) {
    // Never fatal. An app that will not open a PDF because it could not decide
    // whether to download a Python is worse than one that simply did not.
    console.error(`[provision] gave up: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The window, plus the two things only this program does with a fresh one.
 *
 * Both hang off `did-finish-load` and both did before the split, inside
 * `createWindow` itself: a document named on the command line is handed over
 * once there is a renderer listening, because `document:opened` is a push and
 * sending it earlier sends it to nobody; and the environments this machine is
 * missing are fetched as shelf rows, not awaited, because the window is already
 * usable and a doctor run is seconds.
 *
 * They are attached HERE rather than in `openWindow` because they are the
 * shell's: a hosted window has no argv of its own and is not the place to start
 * downloading a Python.
 */
function openTheWindow(): void {
  openFoundryWindow();
  const win = foundryWindow();
  if (win === null) return;
  whenRendererReady(win, () => {
    const named = documentFromArgv(process.argv);
    if (named) void openDocument(named);
    void provision();
  });
}

/*
 * Animated wheel scrolling, which Chromium has and Electron ships turned OFF.
 * In a browser a wheel notch glides; in a default Electron app it teleports
 * ~100px, which reads as the page "jumping" under the reader — most visible in
 * the PDF viewer, where the thing being scrolled is a page of a book. Must be
 * set before the app is ready or it is silently ignored.
 */
app.commandLine.appendSwitch('enable-smooth-scrolling');

void app.whenReady().then(async () => {
  /*
   * THE STANDALONE MOUNT — the same call BookForge makes, with no host to name.
   * The protocol, the policy and every IPC door are registered by it, in the
   * order they were registered in when this file did it inline.
   *
   * The startup migrations that used to run here — regrouping the pre-project
   * flat workspace into projects, promoting stranded reprints — are gone, on
   * the ruling that nothing is kept for legacy's sake (2026-08-16): every
   * machine that held the old layouts has been regrouped or deliberately
   * wiped, and a scan of two directories on every launch forever is a tax
   * paid to a past no install has.
   */
  mountFoundry();
  buildMenu();
  openTheWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openTheWindow();
  });
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  void openDocument(filePath);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Quit aborts the run. A conversion that outlived its window would hold a GPU
 * with nothing left to report to — and so would the reading server, which is
 * ~20 GB of VRAM held by a process nothing is left to talk to. Both of those are
 * `stopFoundry`'s now, because a host's quit owes them exactly as this one does.
 *
 * The quit is DEFERRED once when there is a server of ours to stop, because
 * that stop is a SIGTERM inside the distro followed by waiting for the CUDA
 * device to come back, and an Electron that exited underneath it would leave
 * the guest process orphaned holding the card. A server this app merely FOUND
 * running is not ours and the quit is immediate — which is why the question is
 * asked BEFORE the teardown starts: afterwards there is no server left to own.
 */
let quitting = false;
app.on('before-quit', (event) => {
  /*
   * THE DOCUMENTS ARE ASKED BEFORE ANYTHING IS SHUT DOWN, and the order is the
   * whole reason this is here rather than only on the window's `close`. Cmd+Q,
   * File→Quit and the app being asked to exit all reach this event FIRST, before
   * any window is told to close — so a guard that lived only on the window would
   * raise its dialog after the lines below had already aborted every running job
   * and stopped the reading server. Somebody who then answered "keep it open"
   * would have kept their window and lost the three-hour run in it.
   */
  if (!windowLetGo()) {
    event.preventDefault();
    letTheWindowGo(() => app.quit());
    return;
  }
  const ours = !quitting && vllm.ownsServer();
  const stopped = stopFoundry();
  if (!ours) return;
  event.preventDefault();
  quitting = true;
  void stopped.finally(() => app.quit());
});

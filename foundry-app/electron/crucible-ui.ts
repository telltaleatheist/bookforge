/**
 * crucible-ui — opening a server's own operator page, in a window that can do
 * nothing to this application.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A Crucible ships its own operator interface (their PHASE13-OPERATOR.md), and
 * Owen's ruling of 2026-09-14 is that Foundry stops printing install steps and
 * pull lists: administering a server belongs to the server. What is left on
 * this side is one button per registered server that opens that page with the
 * token already in it, so nobody is asked to paste a credential they have
 * already given us.
 *
 * ── EVERY ONE OF THESE SETTINGS IS LOAD-BEARING ─────────────────────────────
 *
 * The page is code this application did not write, fetched over the network,
 * from a machine somebody else may administer. `app/electron/window.ts` — the
 * only other `BrowserWindow` in this app — attaches `preload.js`, which exposes
 * the whole `window.api` surface: settings writes, the registry AND ITS TOKENS,
 * the job queue, the file-system doors. Opening a remote page through that
 * helper would hand a server's web page the keys to the desktop app. So this
 * window is built from nothing:
 *
 *   · **no `preload`** — there is no bridge to reach, which is the whole point;
 *   · `contextIsolation` and `sandbox` ON, `nodeIntegration` OFF;
 *   · **its own `partition`**, so cookies, storage and service workers from a
 *     server never touch this app's session or another server's;
 *   · `will-navigate` and `will-redirect` REFUSED off-origin, so a page cannot
 *     walk the window somewhere else and keep the window's trust;
 *   · `setWindowOpenHandler` denies everything: a popup would be a window with
 *     none of these rules, opened by the page rather than by a person;
 *   · `webSecurity` left ON, and permission requests denied, because a page
 *     that wants the microphone is a page that is not an operator console.
 *
 * ── AND NOT AN EXTERNAL BROWSER ─────────────────────────────────────────────
 *
 * The obvious alternative — `shell.openExternal` — is worse for one specific
 * reason: the token rides in the URL FRAGMENT, and a browser writes every URL
 * it visits into a history file, an autocomplete index and (signed in) a
 * synced profile. A credential in someone's synced browser history is a
 * credential in more places than they know. This window keeps it in a process
 * that ends when they close it.
 */
import { BrowserWindow, session, shell } from 'electron';

import { crucibleServerNamed } from './crucible-registry';

/**
 * One window per server, reused — pressing Open twice focuses the first rather
 * than opening a second console onto one machine.
 */
const open = new Map<string, BrowserWindow>();

/** Same-origin in the strict sense: protocol, host and port all three. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const one = new URL(a);
    const two = new URL(b);
    return one.protocol === two.protocol && one.host === two.host;
  } catch {
    return false;
  }
}

/**
 * Open the operator page for a REGISTERED server, by name.
 *
 * By name and never by URL, deliberately: the address and the token come from
 * the registry in main, so the renderer never holds a credential and a caller
 * cannot ask this to open something that is not a server we know.
 *
 * Throws by name when there is no such entry — the button is drawn from the
 * same list, so this is the state where somebody removed a server in another
 * window between the draw and the press.
 *
 * ── IT OPENS THE REGISTERED ADDRESS, NEVER THE RESOLVED ENGINE — RULED HERE ─
 *
 * crucible docs/PHASE17-ORCHESTRATOR.md §6 makes every WORKING call in this app
 * follow one hop to the engine (`engineClientFor`, crucible-registry.ts). This
 * door deliberately does NOT, and the difference is what the two are for. A
 * placement is asking a machine to do work, and only an engine can; a console
 * is a person going to LOOK at the process they named, and after Phase 17 the
 * orchestrator's console is the one that has the buttons this hop exists
 * because of — install an engine, restart it, quit the tray (§4). Opening the
 * engine's page from a row that says `:7101` would take somebody to a different
 * port than the one they typed, with none of the controls they pressed the
 * button for, and no sentence anywhere saying why.
 *
 * Test connection says the other half out loud: an orchestrator fronting an
 * engine probes as a SUCCESS naming both (`probeEntry`), so the row already
 * tells a person that the address here is a tray and the work is happening
 * behind it. The button under that sentence opens the tray.
 */
export function openCrucibleUi(name: string): void {
  const existing = open.get(name.toLowerCase());
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const entry = crucibleServerNamed(name);
  if (entry === null) {
    throw new Error(`"${name}" is not one of the servers this app knows, so there is nothing to open.`);
  }

  /*
   * THE TOKEN IS IN THE FRAGMENT, which is the server's own contract
   * (PHASE13-OPERATOR.md §5.3) and is the half of a URL that is never sent to
   * the server in a request line and never written to its access log. It is
   * encoded because a token is opaque bytes and a bare `#` or `&` in one would
   * otherwise cut it in half.
   */
  const base = entry.url.replace(/\/+$/, '');
  const target = `${base}/#token=${encodeURIComponent(entry.token)}`;

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    title: `${entry.name} — Crucible`,
    webPreferences: {
      // No preload. See this file's header: the bridge is the whole risk.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // One partition per server, so two servers cannot read each other's
      // storage and neither can read this app's.
      partition: `crucible:${entry.name.toLowerCase()}`,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    /*
     * A page may not open windows. A link somebody deliberately clicks that
     * points somewhere else goes to their real browser, where it belongs —
     * and only ever an http(s) one, because `openExternal` will happily hand
     * a `file:` or a custom scheme to the operating system.
     */
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const refuseOffOrigin = (event: { preventDefault(): void }, url: string): void => {
    if (sameOrigin(url, base)) return;
    event.preventDefault();
    console.error(`[crucible-ui] ${entry.name} tried to navigate to ${url}; refused.`);
  };
  win.webContents.on('will-navigate', (event, url) => refuseOffOrigin(event, url));
  win.webContents.on('will-redirect', (event, url) => refuseOffOrigin(event, url));

  /*
   * A console does not need the camera, the microphone, the clipboard or a
   * notification. Denying by default is the honest posture for a page this
   * app is merely hosting, and `session.fromPartition` is where it is decided
   * because the handler belongs to the partition rather than to the window.
   */
  session.fromPartition(`crucible:${entry.name.toLowerCase()}`)
    .setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { open.delete(name.toLowerCase()); });
  open.set(name.toLowerCase(), win);
  void win.loadURL(target);
}

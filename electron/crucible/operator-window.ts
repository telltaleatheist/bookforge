/**
 * OPEN CRUCIBLE — the one door BookForge keeps onto a server it does not own.
 *
 * PHASE13-OPERATOR.md §0 and §5.2/§5.3. Everything a person does to a Crucible
 * after it exists — install a job type, pull weights, watch a task, read the
 * token — happens on the server's OWN page, served at `http://<server>:<port>/`.
 * What that deletes in this app is the install story's step list, the printed
 * pull list and the host probe's second career as a stocking screen. What it
 * adds is this: a window at `<url>/#token=<token>`, for a NAMED registry entry,
 * with the token read here and never typed.
 *
 * ── WHY THE FRAGMENT, AND WHY NOT THE BROWSER ──────────────────────────────
 *
 * The page keeps its token in `localStorage` for its origin and accepts
 * `#token=<t>` once, storing it and REPLACING the URL without the fragment
 * (§1). A fragment never reaches the server, which is why the token rides
 * there and not in a query string. And it is an Electron window rather than
 * `shell.openExternal`, because a browser would write that fragment into its
 * history and its address bar — a secret in somebody's autocomplete for the
 * life of the profile.
 *
 * ── WHY THE WINDOW HAS NO BRIDGE, WHICH IS A CONTRACT AND NOT A PREFERENCE ──
 *
 * §5.3, and it is worth restating because every default in Electron points the
 * other way. A Crucible's page is CODE THIS APP DOES NOT OWN. The server may be
 * the Mac Studio, a friend's box, or a machine whose address somebody pasted
 * into a field an hour ago. Handing that page a window inside an Electron
 * process that has a preload, an IPC bridge to the filesystem and a session
 * holding the user's cookies is handing it the app.
 *
 * So, exactly as the phase doc specifies:
 *
 *   - **no preload at all** — not a minimal one, none;
 *   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
 *   - **its own `session.fromPartition('crucible-ui:<name>')`**, so nothing it
 *     stores can reach the app's storage or be reached from it, and two servers
 *     cannot read each other's token out of one origin's localStorage either;
 *   - navigation PINNED to the server's origin: `will-navigate` AND
 *     `will-redirect` are denied for any URL whose origin differs — a redirect
 *     is the half a `will-navigate`-only guard misses, and it is the half an
 *     attacker controls;
 *   - `setWindowOpenHandler` denies every `window.open`, handing `http(s)`
 *     links to the user's own browser instead;
 *   - every permission request denied. The page needs no camera, no clipboard
 *     read, no notifications; it talks to its own server over HTTP.
 *
 * None of this is a response to distrusting Crucible. It is that "the page is
 * served by the thing it administers" stops being a safe sentence the moment
 * the thing is on another machine, and a window with no bridge costs nothing
 * because the page needs none.
 *
 * ── THE TOKEN COMES FROM THE REGISTRY, NEVER FROM THE RENDERER ─────────────
 *
 * The IPC channel takes a NAME. `getServer()` resolves it — the reserved
 * `local` out of that server's own `config.toml` (through `wsl.exe` on
 * Windows), a remote out of `<userData>/crucible-servers.json` — and the
 * plaintext token exists in this module for the length of one URL. A channel
 * that took a URL and a token would let any renderer bug point a window
 * anywhere with anything, and would put a credential on an IPC message for no
 * reason: the renderer already cannot see one (every listing masks it).
 */
import { BrowserWindow, session, shell } from 'electron';

import { getServer } from './servers';

/**
 * A named refusal from this door. Prefixed onto the message like every other
 * Crucible refusal in this app, because a settings row shows `err.message` and
 * nothing else.
 */
export type CrucibleOperatorWindowErrorCode =
  /** The name is empty or not a string — a caller that meant to name one and did not. */
  | 'server_not_named'
  /** The resolved URL is not http(s), so there is no origin to pin a window to. */
  | 'operator_url_unusable';

export class CrucibleOperatorWindowError extends Error {
  readonly code: CrucibleOperatorWindowErrorCode;

  constructor(code: CrucibleOperatorWindowErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleOperatorWindowError';
    this.code = code;
  }
}

/**
 * The partition a server's page gets. One per NAME, so `local` and `mac` never
 * share an origin's storage — and `persist:` is deliberately absent: the page
 * stores the token it was handed in the fragment, and it is handed it again
 * every time this door opens. Nothing is worth keeping across a close.
 */
export function operatorPartition(name: string): string {
  return `crucible-ui:${name}`;
}

/**
 * `<base>/#token=<token>` — the page's sign-in URL, §1's spelling.
 *
 * The token is percent-encoded for the reason `parsePairing` encodes it: today's
 * `secrets.token_urlsafe` emits only unreserved characters, so encoding changes
 * nothing today, which is exactly why the rule is written down before a token
 * contains something else.
 */
export function operatorUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/#token=${encodeURIComponent(token)}`;
}

/** Two URLs' origins agree. A parse failure is a NO, never a maybe. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** One open window per server name, so pressing Open twice focuses rather than duplicates. */
const open = new Map<string, BrowserWindow>();

/**
 * Open (or focus) the operator page for a NAMED server.
 *
 * Answers the window's own title-bar name so the caller can say what it opened;
 * the URL it answers with carries NO fragment, for the reason the page strips
 * its own: a token in a log line is a token.
 */
export function openCrucibleOperatorWindow(name: string): { name: string; url: string } {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new CrucibleOperatorWindowError(
      'server_not_named',
      'Open Crucible takes the NAME of a server — a registry entry, or the reserved `local` '
      + 'for the one this machine\'s config.toml describes. It never takes a URL and a token: '
      + 'the token is read here, from the one owner of it, and is not something a window may '
      + 'be pointed at with.',
    );
  }
  const asked = name.trim();

  const existing = open.get(asked);
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.focus();
    return { name: asked, url: existing.webContents.getURL().split('#')[0] };
  }

  // Resolves `local` from its own config.toml and a remote from the registry.
  // Its refusals — unknown_server, corrupt_registry — are the
  // ones the row already shows, and they travel unchanged.
  const server = getServer(asked);

  let origin: string;
  try {
    const parsed = new URL(server.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`scheme ${parsed.protocol}`);
    }
    origin = parsed.origin;
  } catch (err) {
    throw new CrucibleOperatorWindowError(
      'operator_url_unusable',
      `crucible "${asked}" is recorded at ${server.url}, which is not an http(s) address `
      + `(${(err as Error).message}). The operator page is served by the server itself, so `
      + 'there is no origin to open and none to pin a window to.',
    );
  }

  /*
   * ITS OWN SESSION. Not the app's, not the default one — a partition named for
   * this server, so the page's localStorage (which is where it keeps the token
   * after the first visit) is reachable only from that server's own origin
   * inside this partition.
   */
  const partition = session.fromPartition(operatorPartition(asked));

  /*
   * EVERY PERMISSION DENIED, both doors. `setPermissionRequestHandler` is what
   * an asking API goes through and `setPermissionCheckHandler` is what a
   * synchronous `navigator.permissions.query` goes through; a page told "denied"
   * by one and "granted" by the other is a page that has found a way in.
   */
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);

  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 520,
    minHeight: 420,
    title: `Crucible — ${asked}`,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      // The whole of §5.3, and the absence of `preload` is the load-bearing line.
      session: partition,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  /*
   * PINNED TO THE ORIGIN, on BOTH events. `will-navigate` catches a link and a
   * script-driven location change; `will-redirect` catches the server answering
   * a 302 to somewhere else, which `will-navigate` does not see — and which is
   * the half somebody who controls the page controls.
   */
  const pin = (event: { preventDefault(): void }, url: string): void => {
    if (!sameOrigin(url, origin)) {
      event.preventDefault();
      console.warn(`[crucible ui] refused an off-origin navigation from "${asked}" to ${url}`);
    }
  };
  win.webContents.on('will-navigate', (event, url) => pin(event, url));
  win.webContents.on('will-redirect', (event, url) => pin(event, url));

  /*
   * NO NEW WINDOWS, EVER. An http(s) link a person clicked is handed to their
   * own browser — which is safe precisely because the URL it opens is the link
   * the page showed and carries no fragment of ours. Anything else is dropped:
   * a `file:` or a custom scheme from somebody else's page is not a thing this
   * app forwards to the operating system.
   */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  open.set(asked, win);
  win.on('closed', () => {
    if (open.get(asked) === win) open.delete(asked);
  });

  void win.loadURL(operatorUrl(server.url, server.token));
  return { name: asked, url: origin };
}

/** Close every operator window. Called on quit, so none outlives the app. */
export function closeCrucibleOperatorWindows(): void {
  for (const win of open.values()) {
    if (!win.isDestroyed()) win.close();
  }
  open.clear();
}

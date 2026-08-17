/**
 * mount — the seam another Electron app imports to run Foundry inside itself.
 *
 * ── What this file is for ───────────────────────────────────────────────────
 *
 * The user ruled it (docs/BOOKFORGE-HANDOFF.md §8): BookForge hosts the Foundry
 * window. Everything about making the text of a book happens in a window
 * BookForge opens, over projects that live inside BookForge's own data, and the
 * two stay separate codebases with `app/` copied across nearly verbatim. That
 * copy is only mechanical if there is exactly ONE thing a host has to call, so
 * this is it: four functions, and nothing about them assumes whose process this
 * is.
 *
 *     mountFoundry({ libraryDir, onExport })   register everything
 *     openFoundryWindow(projectDir?)           open (or raise) the window
 *     stopFoundry()                            on the HOST's quit
 *
 * Called with no host at all, `mountFoundry()` is the standalone mount, and
 * electron/main.ts — Foundry's own shell — calls exactly these functions in
 * exactly the same order. One path, two callers: the standalone app cannot drift
 * from the hosted one, because there is no second path for it to drift along.
 *
 * ── What is NOT here, deliberately ──────────────────────────────────────────
 *
 * THE MENU. `Menu.setApplicationMenu` is process-global — it replaces the menu of
 * whatever app is running — so a host that imported Foundry's menu would find its
 * own File menu gone the moment a book was opened. The hosted window inherits the
 * HOST's menu on purpose, and the accelerators Foundry's menu carries (Ctrl+S for
 * export, Ctrl+Z for the document's undo) are the host's to offer or to leave
 * out. Standalone, the menu stays in main.ts where the rest of the shell is.
 *
 * THE PROCESS LIFECYCLE. `whenReady`, `activate`, `window-all-closed` and
 * `before-quit` all belong to whoever owns the process. What a host needs out of
 * the quit is `stopFoundry`, and that is a function rather than a listener for
 * the same reason: the host decides WHEN its app is going.
 *
 * ── One import-time requirement ─────────────────────────────────────────────
 *
 * `protocol.registerSchemesAsPrivileged` must run before the app is ready, so
 * this module has to be IMPORTED at the top of the host's main file — not
 * required lazily from inside a click handler. Importing it is free; nothing runs
 * until `mountFoundry`.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { net, protocol, session } from 'electron';

import { bookFigureFile } from './book';
import { type FoundryHost, recordHost } from './host';
import { registerIpc } from './ipc';
import * as queue from './job-queue';
import { listProjects, onImportLanded } from './projects';
import * as vllm from './vllm-server';
import { foundryWindow, isDev, openWindow, whenRendererReady } from './window';
import { originalOf } from '../shared/original';

export type { FoundryHost };
export { hostedLibraryDir } from './host';

// ─────────────────────────────────────────────────────────────────────────────
// foundry-file:// — how a book's figures reach the page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The renderer is a page on http://localhost:4260 (dev) or file:// (packaged),
 * and neither may load an arbitrary `file://` URL as an image. So the app serves
 * the bytes itself, on a scheme of its own.
 *
 * ONE HOST, AND IT IS THE LAST ONE: `foundry-file://book/<token>/<figure name>`
 * — a crop the engine cut beside the bank, for an open book's proof sheet. Two
 * others have been retired and both for the same reason, which is that a serving
 * route with no consumer is a door into files on disk kept open for nobody:
 * `open` served whole PDFs to Chromium's viewer (PDFs go to the app's own pdf.js
 * through `document:read-bytes` now), and `epub` served chapters out of an
 * unpacked working tree to an <iframe> that no longer exists (docs/RENDERER.md
 * §7). What survives is allow-listed rather than path-checked: `bookFigureFile`
 * answers only for a token a successful `book:load` minted, so a renderer that
 * was talked into asking for `C:\Users\…\id_rsa` gets a 403 rather than meeting
 * a cleverer path check that has to stay right forever.
 *
 * THE SCHEME NAME IS FOUNDRY'S AND STAYS FOUNDRY'S when hosted. A host that
 * serves its own pictures does it on its own scheme; this one is registered by
 * importing this module, and two apps in one process can hold two schemes as
 * easily as they hold two IPC namespaces.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'foundry-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * Extension -> content type, for the pictures a book file's figures can be.
 *
 * Chromium decides what to DO with a response from this header and nothing else,
 * and there is no sniffing fallback on purpose: an unknown extension is served
 * as a download rather than guessed into being executable. The list is the image
 * formats a crop can come out as, because the one surviving host serves crops.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Stream a file as a response, or say why not. */
async function serveFile(
  resolved: string,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<Response> {
  try {
    const stat = await fsp.stat(resolved);
    // Streamed rather than buffered: a scanned book is hundreds of megabytes
    // and the whole point of handing it to Chromium's viewer is not holding it.
    const body = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
    return new Response(body, {
      headers: {
        'content-type': contentTypeFor(resolved),
        'content-length': String(stat.size),
        'content-disposition': `inline; filename="${path.basename(resolved)}"`,
        ...extraHeaders,
      },
    });
  } catch (err) {
    // The one case worth a second opinion: a file that vanished between the
    // open and the read. net.fetch reports it in file:// terms.
    try {
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      return new Response(`Could not read ${resolved}: ${(err as Error).message}`, { status: 404 });
    }
  }
}

function registerFileProtocol(): void {
  protocol.handle('foundry-file', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('That is not a URL this app serves.', { status: 400 });
    }

    if (url.host === 'book') {
      /*
       * `/<token>/<figure name>` — a cut figure of an OPEN book, and nothing
       * else. The token is minted by a successful `book:load` and looked up in
       * an allow-list (`bookFigureFile`, electron/book.ts), which is the same
       * decision the epub host makes one branch down: a URL the renderer
       * composed for a directory nothing registered is a refusal, not a read.
       * These are app-cut PNGs served to the app's own page — never into a
       * book's sandboxed frame — so they carry the no-store/nosniff pair and
       * no CSP of their own.
       */
      const segments = url.pathname.split('/').filter((part) => part.length > 0);
      const token = segments.shift();
      if (token === undefined || segments.length !== 1) {
        return new Response('No book and figure were named.', { status: 400 });
      }
      const figure = bookFigureFile(token, decodeURIComponent(segments[0]!));
      if (figure === null) {
        return new Response('That book\'s figures are not open in this app.', { status: 403 });
      }
      return serveFile(figure, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    }

    // The old `open` and `epub` hosts are both gone — the first with Chromium's
    // PDF viewer, the second with the iframe reader. 404 rather than silence, so
    // a stale URL says what happened to it.
    return new Response('This app no longer serves whole files; a book\u2019s figures only.', { status: 404 });
  });
}

/**
 * The renderer's Content-Security-Policy, on the DOCUMENT only.
 *
 * `img-src foundry-file:` is the whole reason this is written by hand: a book
 * file's figure crops are the one cross-scheme thing the page is allowed to load,
 * and there is no `frame-src` at all any more because there is no frame.
 * `'unsafe-inline'` is on styles alone — Angular emits component styles inline —
 * and never on scripts.
 *
 * Not applied to the PDF's own response: Chromium's PDF viewer is an extension
 * frame with its own requirements, and a policy written for the app's page has
 * no business being imposed on it. Not applied in dev either, where the page is
 * served by ng serve over a websocket the policy would have to name.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // `foundry-file:` for the book pane's figures — the crops the engine cut
  // beside the bank, served through the allow-listed `book` host and nothing
  // else on that scheme reachable as an image.
  "img-src 'self' data: blob: foundry-file:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * ── ON THE DEFAULT SESSION, WHICH A HOST ALSO USES ─────────────────────────
 *
 * The header is added to `file://` responses and to nothing else, so a host
 * whose own page is served over http keeps whatever policy it sets for itself
 * and Foundry's packaged page keeps this one. Two apps, one session, one
 * predicate deciding which is which.
 */
function applyContentSecurityPolicy(): void {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith('file://')) {
      callback({});
      return;
    }
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register everything Foundry owns in a main process. Called once, before the
 * window is opened, after the app is ready.
 *
 * With a host it records who that is — the library moves under the host's data
 * (`readAppSettings`), the settings screen stops offering to move it, and every
 * export that lands is announced to `onExport`. With no host at all it is the
 * standalone mount and nothing above changes.
 *
 * IDEMPOTENT IT IS NOT, and it does not pretend to be: `ipcMain.handle` throws on
 * a second registration of the same channel, which is the right failure — a
 * second mount is a bug in the host's startup, and a silent no-op would hide it
 * until two Foundries were fighting over one queue.
 */
export function mountFoundry(host?: FoundryHost): void {
  if (host !== undefined) {
    recordHost(host);
    /*
     * The export announcement is wired HERE rather than inside the queue,
     * because the queue must not know what a host is: it registers a listener in
     * the same shape as `onQueueChanged`, and this is the one place that knows
     * there is somebody to tell. Wrapped, because a host's handler throwing is a
     * host's problem and a landed export is already on disk — see the call.
     */
    queue.onExportLanded((landing) => {
      try {
        host.onExport(landing);
      } catch (err) {
        console.error(
          `[mount] the host's onExport threw for ${landing.path}: `
          + `${err instanceof Error ? err.message : String(err)}. The export itself landed.`,
        );
      }
    });
    // First contact, for the host that asked to hear it — how the bare-window
    // import door (Import via Foundry) tells the host which project key its
    // book was given. Optional where onExport is not; see FoundryHost.
    const heardImport = host.onImport?.bind(host);
    if (heardImport !== undefined) {
      onImportLanded((landing) => {
        try {
          heardImport(landing);
        } catch (err) {
          console.error(
            `[mount] the host's onImport threw for ${landing.originalPath}: `
            + `${err instanceof Error ? err.message : String(err)}. The import itself landed.`,
          );
        }
      });
    }
  }
  applyContentSecurityPolicy();
  registerFileProtocol();
  registerIpc();
}

/**
 * Open the Foundry window, or raise the one that is already open.
 *
 * ── The project argument, and why the window is told rather than asked ──────
 *
 * Hosted, this is pressed from a book's page in BookForge — "Edit in Foundry" —
 * and the window has to come up STANDING IN that book: hosted, BookForge's book
 * list is the library, and a Foundry Home listing the same books from the other
 * side would be two answers to "what books do I have" (§8). So the deep link is
 * a push, sent when the renderer is listening, carrying exactly what a click on
 * Home's own row carries — the project, the document that click would open, and
 * whether Foundry made it.
 *
 * RESOLVED HERE RATHER THAN IN THE RENDERER, from `originalOf` — the same
 * function Home's own row calls (shared/original.ts) — so the hosted door and the
 * standalone door open the same file for the same book. A host naming a project
 * that is not in the library gets a console line and a plain window: it opened
 * something, which is better than a host press that appears to do nothing.
 */
export function openFoundryWindow(projectDir?: string): void {
  const win = openWindow();
  if (projectDir === undefined) return;
  // `whenRendererReady` rather than `once('did-finish-load')`, because the
  // second press of Edit-in-Foundry finds a window that loaded minutes ago and
  // an event that has already fired — see that function.
  whenRendererReady(win, () => {
    void listProjects().then((projects) => {
      const wanted = path.resolve(projectDir).toLowerCase();
      const project = projects.find((row) => path.resolve(row.dir).toLowerCase() === wanted);
      const original = project === undefined ? null : originalOf(project.documents);
      if (project === undefined || original === null) {
        console.error(`[mount] ${projectDir} is not a project with anything openable in it.`);
        return;
      }
      win.webContents.send('project:open', {
        dir: project.dir,
        originalPath: original.path,
        managed: original.managed,
      });
    }).catch((err: Error) => {
      console.error(`[mount] ${projectDir} could not be opened: ${err.message}`);
    });
  });
}

/**
 * Everything with a lifetime, stopped — for the HOST's quit, and for Foundry's
 * own.
 *
 * A conversion that outlived the app would hold a GPU with nothing left to
 * report to, and so would the reading server, which is ~20 GB of VRAM held by a
 * process nothing is left to talk to. Neither of those is tied to the WINDOW:
 * closing the Foundry window inside BookForge leaves the queue running, exactly
 * as closing a tab does, and it is the host going away that ends them.
 *
 * ── Why it answers with a promise when the sketch said void ─────────────────
 *
 * Because stopping the reading server is a SIGTERM inside the WSL distro
 * followed by waiting for the CUDA device to come back, and an Electron that
 * exited underneath it leaves the guest process orphaned holding the card. That
 * hazard is the host's now as much as it was ever Foundry's, so the host is
 * given the one thing it needs to avoid it: something to wait on before it lets
 * its own quit finish. A caller with nothing to defer can ignore it.
 *
 * IDEMPOTENT, because a quit is a sequence of events rather than one: whoever
 * asks second gets the same promise the first ask made, and the SIGTERM is sent
 * once.
 */
/**
 * Whether Foundry is in the middle of something — the probe a host's own
 * dangerous doors gate on.
 *
 * The concrete hazard that asked for it: the host's `libraryDir` may be a live
 * value, and a queued or running job resolved its output paths against the OLD
 * root at enqueue time — so a host about to move its library needs one honest
 * answer to "is now safe", and every fact in that answer lives on this side of
 * the seam (`queue:list` is renderer-facing IPC a host's main process cannot
 * invoke).
 *
 * `jobsPending` counts held jobs too, deliberately: a held read has not started,
 * but its paths are already minted, and a root that moves between enqueue and
 * Start tears it exactly as a move mid-run would. Done, failed and cancelled
 * rows are history and count for nothing.
 */
export function foundryBusy(): { windowOpen: boolean; jobsPending: number } {
  const win = foundryWindow();
  return {
    windowOpen: win !== null && !win.isDestroyed(),
    jobsPending: queue.listJobs()
      .filter((job) => job.state === 'held' || job.state === 'queued' || job.state === 'running')
      .length,
  };
}

let stopping: Promise<void> | null = null;

export function stopFoundry(): Promise<void> {
  if (stopping !== null) return stopping;
  queue.shutdown();
  stopping = vllm.ownsServer()
    // A server this app merely FOUND running is not ours to stop, and the wait
    // would be a wait for somebody else's process to die.
    ? vllm.stopServer('the app is quitting').then(() => undefined)
    : Promise.resolve();
  return stopping;
}

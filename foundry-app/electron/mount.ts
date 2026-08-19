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
 * ── The host-operations socket, which is the fourth and fifth things ────────
 *
 *     mountFoundry({ …, hostOperations })      acts the host contributes
 *     setHostNodes(projectDir, nodes)          what the host is making, now
 *
 * The user ruled that audio work — narrate, enhance, assemble — belongs ON the
 * provenance tree rather than on a page beside it, because "translate this, then
 * narrate the translation" is one pipeline and the tree is where a person is
 * standing when they decide it. Foundry does none of that work and knows nothing
 * about it: a host REGISTERS operations at mount, and the tree offers them from
 * the nodes they apply to; the host PUSHES nodes, and the tree draws them as
 * children of the ledger step they were ordered from, in the same card grammar
 * as everything else.
 *
 * THE LEDGER IS NOT PART OF THIS. A host node is a display row with the lifetime
 * of the host's own queue — never a step, never on disk, never anybody's parent
 * in this app's own record of what happened to the words. shared/host-ops.ts and
 * electron/host-ops.ts carry the whole argument; the socket's channels are the
 * `host-ops:` family, which BookForge owns nothing in, so the full-name rule that
 * makes hosting additive holds by construction.
 *
 * REGISTERED OR NOT, IT COSTS THE STANDALONE APP NOTHING: with no host there are
 * no operations and nobody pushing, both doors answer empty, and the tree is
 * exactly the tree.
 *
 * ── The queue socket, which is the sixth thing ──────────────────────────────
 *
 *     mountFoundry({ …, hostQueue })           the host schedules
 *     runJob(request, opts)                    …and Foundry does the work
 *     setHostQueueRows(projectDir, rows)       …and the shelf draws the host's
 *     hostQueueDrained()                       …and the host says when it is over
 *
 * One machine's GPU needs one owner, and hosted there were two schedulers: this
 * app's `pump()` and the host's engine, neither able to see the other's list. So
 * a host may take the deciding over. It never takes the WORK: the ledger writes,
 * the bank, the rotations and the export landings stay here, because two copies
 * of that bookkeeping is how two apps start disagreeing about what a book is.
 *
 * ONLY WHAT A PERSON PRESSED IN THIS WINDOW ROUTES. An export the host itself
 * ordered (`exportEpubFromStep`, below) stays on Foundry's internal queue, and
 * the essay at that call is the most important paragraph in the socket.
 *
 * REGISTERED OR NOT, IT COSTS THE STANDALONE APP NOTHING: with no host queue,
 * every door in electron/job-queue.ts behaves exactly as it did before this
 * existed, and `runJob` is a function nobody calls.
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
import { openDocument } from './documents';
import { type FoundryHost, recordHost } from './host';
import {
  type HostOperation, recordHostNodeActions, recordHostOperations, recordHostStatusOpen,
} from './host-ops';
import { registerIpc } from './ipc';
import * as queue from './job-queue';
import { ledgerOf, listProjects, onImportLanded, readManifest } from './projects';
import * as vllm from './vllm-server';
import { planExport } from './workspace';
import { foundryWindow, isDev, openWindow, whenRendererReady } from './window';
import { stepOf } from '../shared/ledger';
import { fold, originalOf } from '../shared/original';
import type { ExportLanding, Job, JobRequest } from '../shared/types';

export type { FoundryHost, HostOperation };
/*
 * THE LANDING'S OWN SHAPE, through the seam a host imports. It is declared in
 * `shared/types.ts` with every other announcement, and re-exported here so that a
 * host typing the answer to `exportEpubFromStep` — or its own `onExport` — has one
 * import for the whole contract rather than a reach past this file into modules
 * that are Foundry's business.
 */
export type { ExportLanding };
export { hostedLibraryDir } from './host';
/*
 * THE HOST-OPERATIONS SOCKET, re-exported through the seam a host actually
 * imports. `setHostNodes` is the push door — see electron/host-ops.ts — and the
 * types are here so a host can declare its operations array without reaching
 * past `mount.ts` into modules that are Foundry's own business.
 */
export { setHostNodes } from './host-ops';
/*
 * AND THE CHIP IN THE CHROME, which is the socket's second push door.
 * `setHostNodes` says what the host is making OF A PARTICULAR BOOK and lands on
 * that book's tree; this says what the host is doing AT ALL and lands in the
 * window's top corner, once, whichever book is open. Null clears it and the
 * chrome goes back to being Foundry's alone — see electron/host-ops.ts, and
 * `FoundryHost.onStatusOpen` for what a click on it asks.
 */
export { setHostStatus } from './host-ops';
export type { HostStatus } from '../shared/host-ops';
/*
 * AND THE THIRD PUSH DOOR: THE ACTS THEMSELVES, REVISED.
 *
 * `hostOperations` on the mount seam is the host's FIRST word about what it
 * offers, not its last one. A host whose own form changes while the window is up
 * — a voice installed since, a setting changed since, an operation it can no
 * longer honour — calls this with the whole list it now offers, and every
 * Foundry window replaces its copy. Same mechanics as `setHostNodes` and
 * `setHostStatus`: the whole value, no diffs, nothing validated on this side.
 *
 * A HOST THAT NEVER CALLS IT IS UNCHANGED. The mount-time declaration stands for
 * the life of the process, which is what every host does today, and the ask the
 * renderer already makes at startup answers exactly what it always answered.
 */
export { setHostOperations } from './host-ops';
export type { HostNode, HostNodeProgress, HostNodeState, HostOperationKind, NodeOutput } from '../shared/types';
/*
 * ── AND THE QUEUE SOCKET: ONE MACHINE'S GPU HAS ONE OWNER ───────────────────
 *
 * Owen ruled it (docs/PLAN.md, Wave 16): *"we need to centralize the queue in
 * bookforge."* A host that registers `hostQueue` on the mount does the DECIDING;
 * these three are what Foundry offers back.
 *
 *     runJob(request, {parentStep, onProgress, signal})   execute one, now
 *     setHostQueueRows(projectDir, rows)                  what your queue holds
 *     hostQueueDrained()                                  and when it is empty
 *
 * `runJob` resolves with the settled `Job` ROW — `state` says `done`, `failed` or
 * `cancelled` and `error` carries the engine's own words. The row rather than a
 * result type, because a result type cannot say cancelled, and a cancel filed as
 * a failure is how a host's retry restarts work a person just stopped.
 *
 * `setHostQueueRows` is in the `setHost*` family by shape and by purpose, and it
 * comes from the queue rather than from `host-ops.ts` because the module that
 * publishes the shelf's mirror must be the module that holds what the shelf
 * draws — two modules answering "what is in the queue" is the one thing this
 * whole wave exists to prevent.
 *
 * ABSENT, ALL THREE ARE UNREACHED and Foundry queues exactly as it always has.
 */
export { hostQueueDrained, runJob, setHostQueueRows } from './job-queue';
export type { FoundryHostQueue } from './host';
export type { FoundryJobRow, Job, JobRequest, TranslateRequest } from '../shared/types';

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
  /*
   * ── EVERY EXPORT THAT LANDS, HEARD ONCE AND PASSED ON TWICE ────────────────
   *
   * The queue publishes a landing into ONE slot (`onExportLanded`) and there are
   * two things in this process that want it: the HOST, whose versions list gains a
   * row, and any unattended export this seam is in the middle of making
   * (`exportEpubFromStep`). So the slot is taken here, once, and the fan-out lives
   * on this side of it — a second `queue.onExportLanded` would silently replace
   * the first, which is exactly the failure a single slot is meant to make loud.
   *
   * THE HOST IS TOLD FIRST. A waiter's continuation is where the host is asked to
   * do something ABOUT the export it has just been told exists, so the order that
   * cannot surprise anybody is announcement before answer. Both are asynchronous
   * on the far side and the exact interleaving after that is the host's own
   * business; what this guarantees is which of them was OFFERED first.
   *
   * WIRED HERE RATHER THAN INSIDE THE QUEUE, because the queue must not know what
   * a host is: it publishes in `onQueueChanged`'s shape, and this is the one place
   * that knows there is somebody to tell. The host's call is wrapped, because a
   * host's handler throwing is a host's problem and a landed export is already on
   * disk — see the call.
   *
   * REGISTERED WITH OR WITHOUT A HOST. Standalone nothing waits and nobody is
   * told, so the listener runs, matches nothing and returns — which is cheaper
   * than a second registration path to keep in step with this one.
   */
  queue.onExportLanded((landing) => {
    if (host !== undefined) {
      try {
        host.onExport(landing);
      } catch (err) {
        console.error(
          `[mount] the host's onExport threw for ${landing.path}: `
          + `${err instanceof Error ? err.message : String(err)}. The export itself landed.`,
        );
      }
    }
    for (const waiting of [...awaitingExports]) {
      if (fold(waiting.path) === fold(landing.path)) waiting.landed(landing);
    }
  });
  if (host !== undefined) {
    recordHost(host);
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
    /*
     * THE ACTS THE HOST CONTRIBUTES, taken as declared and not wrapped.
     *
     * Unlike the two announcements above, an operation is not something Foundry
     * TELLS the host — it is something the user presses, so nothing here is
     * caught: a rejection travels back over `host-ops:invoke` to the tree that
     * asked, which says the host's sentence where the button was. A button that
     * silently does nothing is the one outcome this socket must not have.
     */
    if (host.hostOperations !== undefined) recordHostOperations(host.hostOperations);
    /*
     * AND WHAT MAY BE DONE TO A NODE THAT FAILED — Retry and Dismiss.
     *
     * Bound rather than stored raw, for `onImport`'s reason: a host that wrote
     * its handler as a method is entitled to its own `this`. Registered only when
     * the host has one, because the tree asks whether it exists before it draws
     * the pair (`hostTakesNodeActions`) — an absent callback means no buttons
     * rather than buttons that refuse.
     *
     * NOT WRAPPED IN A CATCH, which puts it with the operations above rather than
     * with the two announcements: this is a button somebody pressed, and its
     * rejection travels back over `host-ops:node-action` to be said where the
     * button was.
     */
    const nodeAction = host.onNodeAction?.bind(host);
    if (nodeAction !== undefined) recordHostNodeActions(nodeAction);
    /*
     * AND WHERE A CLICK ON THE STATUS CHIP GOES.
     *
     * Bound and registered exactly as the pair above, and OPTIONAL in the same
     * drawn way: without it the chrome's chip is a readout rather than a button
     * (`hostOpensStatus` is the probe the renderer asks). A host that pushes a
     * status and registers nothing here has said "here is what I am doing" and
     * not "here is where to see more", which is a complete thing to say.
     */
    const statusOpen = host.onStatusOpen?.bind(host);
    if (statusOpen !== undefined) recordHostStatusOpen(statusOpen);
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
export function openFoundryWindow(
  projectDir?: string,
  opts?: { document?: string },
): void {
  const win = openWindow();
  /*
   * ── A DOCUMENT NAMED IS THE LANDING ─────────────────────────────────────────
   *
   * The host's other button: not "edit this book" but "open THIS file" — a
   * version row's Open, pointing at an export in some project's `final/`. It
   * goes through `openDocument`, THE single door (documents.ts): the same
   * admission the menu, a drop and argv get, announced to the renderer as
   * `document:opened` exactly as theirs are — so a host can never open a file
   * a drop would have refused. The project context comes free, because a file
   * inside a project adopts into it; `project:open` is not also sent, since a
   * button named Open should land on the file and not on the proof sheet
   * beside it. A refusal is a console line, not a throw: the host pressed a
   * button about a file, and the file said no.
   */
  const document = opts?.document;
  if (document !== undefined) {
    whenRendererReady(win, () => {
      void openDocument(document).then((opened) => {
        if (opened === null) {
          console.error(`[mount] ${document} is not a file this app opens.`);
        }
      });
    });
    return;
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// The EPUB a host's act needs, made without anybody pressing anything
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE EXPORT THIS PROCESS IS WAITING ON — a path, and what to do when it lands.
 *
 * The path is the identity because it is the queue's own: `enqueue` refuses to
 * hold two live jobs writing one file and hands back the pending one instead
 * (`pendingFor`), so at any moment at most one run in this app is going to
 * produce this name. Matching on it therefore matches OUR job even when the
 * queue answered our enqueue with somebody else's — which is the ordinary case
 * when a person pressed Export on the same row a second earlier.
 */
interface AwaitedExport {
  path: string;
  landed(landing: ExportLanding): void;
}

const awaitingExports = new Set<AwaitedExport>();

/**
 * MAKE THE EPUB OF ONE STEP, unattended, and answer with the landing.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, on finding narrate offered only where a file already existed: *"i dont
 * think its intuitive to know you have to create an epub before you can narrate.
 * i think we should make any of the steps possible to narrate. if they arent
 * doing it from an epub then we export the epub automatically and then run the
 * task they assigned."*
 *
 * A host's act consumes a FINISHED FILE, and a person standing on a translation
 * three rows into their history has words rather than a file. The old answer was
 * to offer the act only on `final/` rows and let them go and make one; this is
 * the other answer, and it is the one that matches what somebody means when they
 * press Narrate on a step. THE HOST DECIDES WHEN TO ASK: it declares its act on
 * both currencies (`HostOperationOffer.appliesTo`), and when an invoke arrives
 * naming a step it has no export for, it calls this.
 *
 * ── What it is, and what it deliberately is not ─────────────────────────────
 *
 * IT IS THE EXPORT DIALOG'S OWN PATH WITH NOBODY IN FRONT OF IT. The same
 * `planExport`, the same `JobRequest` the dialog composes, the same queue, the
 * same landing — because an export made for a host must be indistinguishable
 * from an export somebody pressed for: same name in `final/`, same rotation of
 * the predecessor, same row in the tray, same announcement to whoever is
 * listening. A second, quieter route to a filed document would be a second truth
 * about what an export is.
 *
 * IT ASKS NOTHING, and it can afford not to. The dialog has exactly one question
 * — the format — and this one is an EPUB by definition: it exists because a host
 * act wants the book as a file, and `epub` is what that means. Every other
 * decision an export makes is main's already (the pixels, the bank, the
 * translation's words, the derived book with the changes replayed into it).
 *
 * IT IS NOT HELD. A rendering never is (electron/job-queue.ts): it is arithmetic
 * over a bank already on the disk, seconds, no model — so nothing waits for
 * anybody to find the shelf and press Start, which would be the one way an
 * unattended call could hang forever.
 *
 * ── The answer, and the two ways it ends ────────────────────────────────────
 *
 * The promise settles when the JOB does, never on a timer. It resolves with the
 * landing — the same `ExportLanding` the host's `onExport` was handed a moment
 * earlier, path included, so the caller can run its act against the file without
 * composing a path of its own. It rejects when the run ends without filing
 * anything: the engine's own stderr for a failure, a sentence for a cancel or for
 * a row somebody removed from the shelf while it waited.
 *
 * A REFUSAL AT PLAN TIME IS THROWN BEFORE ANY OF THAT, in main's own words —
 * the book nobody has read, the reading that was interrupted, the changes that
 * would not replay. Those sentences are written to be shown to a person, and the
 * host is expected to put them in front of one rather than paraphrase them.
 */
export async function exportEpubFromStep(
  projectDir: string,
  stepId: string,
): Promise<ExportLanding> {
  /*
   * THE PROJECT AND ITS BOOK, resolved the way the deep link resolves them one
   * function up: `listProjects` and `originalOf`, so a host naming a project gets
   * the same document a click on that book's row would open. The plan only needs
   * the path to find the project — it resolves the pixels out of `archive/` for
   * itself — but it must be a path this app actually holds, which is precisely
   * what a project summary is the record of.
   */
  const project = (await listProjects()).find((row) => fold(row.dir) === fold(projectDir));
  if (project === undefined) {
    throw new Error(`${projectDir} is not a project in this app's library.`);
  }
  const original = originalOf(project.documents);
  if (original === null) {
    throw new Error(`${projectDir} holds no document to export from.`);
  }
  /*
   * AND THE ROW, PROVED AGAINST THE LEDGER. `stepOf` refuses by name for an id
   * this project's history does not have, which is the honest answer to a host
   * that has held a step id since before somebody deleted the step — and it is
   * the same refusal every other door in this app gives for the same mistake.
   */
  const step = stepOf(ledgerOf(await readManifest(project.dir)), stepId);
  const plan = await planExport(original.path, 'epub', step);
  const request: JobRequest = {
    kind: 'epub',
    // The pixels, as always: the plan resolved the archived original rather than
    // trusting whatever document anybody was looking at.
    inputPath: plan.sourcePath,
    outputPath: plan.outputPath,
    readingsPath: plan.readingsPath,
    // TERMINAL. Without it the landing files the result as a rendering of the
    // project — a documents row, a live file something later could be built on —
    // which is precisely what an export is not.
    export: true,
    // The translation's words, the language to declare the book as, and the book
    // with this step's changes already replayed into it: carried from the plan,
    // never composed, exactly as the dialog carries them.
    ...(plan.records !== undefined ? { records: plan.records } : {}),
    ...(plan.language !== undefined ? { language: plan.language } : {}),
    ...(plan.bookPath !== undefined ? { bookPath: plan.bookPath } : {}),
  };

  return new Promise<ExportLanding>((resolve, reject) => {
    let over = false;
    const waiting: AwaitedExport = {
      path: plan.outputPath,
      landed: (landing) => {
        if (over) return;
        over = true;
        awaitingExports.delete(waiting);
        stopWatching();
        resolve(landing);
      },
    };
    /*
     * BOTH HALVES ARE ARMED BEFORE THE ENQUEUE, and the order is load-bearing
     * rather than tidy. `enqueue` is synchronous and pumps the queue on the way
     * out — a job that loses its request settles inside that call, before this
     * function has resumed — so a listener registered afterwards would miss the
     * one ending it exists to catch.
     */
    awaitingExports.add(waiting);
    const stopWatching = queue.onJobSettled((row) => {
      if (over || fold(row.outputPath) !== fold(plan.outputPath)) return;
      over = true;
      awaitingExports.delete(waiting);
      stopWatching();
      reject(unfiled(row));
    });
    /*
     * THE STEP IS THE PARENT, which is what makes the tray row and the landing
     * both say where this export came from (`ProjectFinal.stepId`,
     * `ExportLanding.stepId`). The IPC door resolves that from the project's
     * POSITION because a person pressing Export is standing on what they mean;
     * here the ask names its own row, and passing the position instead would file
     * a host's export against wherever the window happened to be pointing.
     */
    /*
     * ── `enqueueHere`, AND THIS IS THE LEAST OBVIOUS LINE IN THE WAVE ─────────
     *
     * Wave 16 gave a host the option of owning the queue: `queue.enqueue` hands
     * the request to `hostQueue.enqueue` when one is registered, and the host's
     * pump calls `runJob` when it decides. That is right for everything a PERSON
     * presses in this window — a reading, a generate, an export from the dialog —
     * because those are the jobs that compete for the GPU the host is scheduling.
     *
     * IT IS EXACTLY WRONG HERE, AND THE FAILURE IS A DEADLOCK RATHER THAN AN
     * INEFFICIENCY. This function exists because the host asked for it: an act
     * declared on `'book'` was pressed on a step with no export, so the host
     * called `exportEpubFromStep` and is AWAITING the promise this returns. By
     * making that call the host has already made the scheduling decision — it
     * knows what it is running and it is running it now. Routing this enqueue
     * would push the export back into the host's own queue from inside a call
     * that queue is blocked on: their scheduler would be waiting for a landing
     * that cannot happen until their scheduler runs the row it has just been
     * handed. Two correct-looking rules, one hang, and it would look like a
     * Foundry export that never finishes.
     *
     * SO THE RULE IS ABOUT THE DOOR SOMEBODY CAME THROUGH, not about the kind of
     * job: work ordered through the mount seam is Foundry's own, runs on
     * Foundry's own queue, and is invisible to the host's scheduler by design.
     * The same reasoning makes environment installs unroutable
     * (`enqueueEnvInstall`) — an install is a precondition of the engine running
     * at all, and filing one behind a queue is filing it behind the job that
     * needs it.
     *
     * EVERYTHING ELSE ABOUT THIS EXPORT IS UNCHANGED, which is the whole promise
     * one function up: same plan, same request, same rotation, same `final/` name,
     * same tray row, same landing, same announcement. A host cannot tell this
     * export from one somebody pressed for, and neither can the tray.
     */
    queue.enqueueHere(request, step.id);
  });
}

/**
 * WHY THIS JOB FILED NOTHING — the sentence a waiter is rejected with.
 *
 * The engine's own stderr where there is one, never paraphrased: it names the
 * missing Python, the block it choked on, the page it could not read, and a
 * summary written here would be this app editing the only account of what
 * happened. The other three arms are states the queue can end in with nothing on
 * disk to point at, and each says which one it was — including `done`, which
 * would mean the run succeeded and the landing never came, and which is worth an
 * astonished sentence rather than a silent wait.
 */
function unfiled(row: Job): Error {
  const file = path.basename(row.outputPath);
  if (row.state === 'failed') {
    return new Error(row.error === undefined
      ? `Making ${file} failed, and the run said nothing about why.`
      : row.error);
  }
  if (row.state === 'cancelled') {
    return new Error(`Making ${file} was cancelled before it finished.`);
  }
  if (row.state === 'done') {
    return new Error(
      `${file} was made, but nothing filed it into the project's tray — so there is no export to `
      + 'hand back.',
    );
  }
  return new Error(`Making ${file} was taken out of the queue before it ran.`);
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

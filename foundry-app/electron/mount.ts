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

import { app, nativeImage, net, protocol, session } from 'electron';

import { bookFigureFile } from '@owen/foundry-core/node/book';
import { captureServedFile } from '@owen/foundry-core/node/capture';
import { openDocument } from './documents';
import { type FoundryHost, recordHost } from '@owen/foundry-core/node/host';
import {
  type HostOperation, recordHostNodeActions, recordHostOperations, recordHostStatusOpen,
} from '@owen/foundry-core/node/host-ops';
import { connectLocalEngine } from '@owen/foundry-core/node/doors-crucible';
import { registerIpc } from './ipc';
import { jobsPending, settleAwaitedExports } from '@owen/foundry-core/node/mount-work';
import * as queue from '@owen/foundry-core/node/job-queue';
import { setPlatform } from '@owen/foundry-core/node/platform';
import { retireSettingsKeys } from '@owen/foundry-core/node/settings';
import { listProjects, onImportLanded } from '@owen/foundry-core/node/projects';
import { broadcast, foundryWindow, isDev, openWindow, whenRendererReady } from './window';
import { originalOf } from '@owen/foundry-core/shared/original';
import type { ExportLanding } from '@owen/foundry-core/shared/types';

export type { FoundryHost, HostOperation };
/*
 * THE LANDING'S OWN SHAPE, through the seam a host imports. It is declared in
 * `shared/types.ts` with every other announcement, and re-exported here so that a
 * host typing the answer to `exportEpubFromStep` — or its own `onExport` — has one
 * import for the whole contract rather than a reach past this file into modules
 * that are Foundry's business.
 */
export type { ExportLanding };
export { hostedLibraryDir } from '@owen/foundry-core/node/host';
/*
 * THE WINDOW ITSELF, for a host that has to know whether the focused window is
 * this one. BookForge's Edit menu on a Mac routes Cmd+Z to `menu:action` when
 * Foundry's window is focused and to the platform undo otherwise (2026-09-07,
 * the hosted-Mac half of the undo chord), and it was recognising the window by
 * capturing `browser-window-created` during `openFoundryWindow` — a capture
 * that is right today because this app opens exactly one window, and would be
 * silently wrong the day it opens two. An accessor is the fact; a capture is
 * an inference about it. Null before the window is opened and after it closes,
 * which every caller already has an answer for.
 */
export { foundryWindow } from './window';
/**
 * THE WINDOW'S QUIT GATE, for the host that owns the process. Its `close` asks the
 * open documents once and closes on a yes — and a close prevented during
 * `app.quit()` cancels the quit, so a host that let the window be asked THEN
 * quit only closed the window (Owen, 2026-11-07: "i have to … hit quit bookforge
 * twice"). The host asks first (`letTheWindowGo`), quits from the yes, and reads
 * `windowLetGo` so the second pass goes straight through.
 */
export { letTheWindowGo, windowLetGo } from './window';
/*
 * THE HOST-OPERATIONS SOCKET, re-exported through the seam a host actually
 * imports. `setHostNodes` is the push door — see electron/host-ops.ts — and the
 * types are here so a host can declare its operations array without reaching
 * past `mount.ts` into modules that are Foundry's own business.
 */
export { setHostNodes } from '@owen/foundry-core/node/host-ops';
/*
 * THE MINT SEED'S SHAPE, through the seam a host imports — what
 * `FoundryHost.mintMetaFor` answers with (Owen's inheritance ruling,
 * 2026-08-24; the shape and the precedence are argued where it is declared).
 */
export type { HostMintMeta } from '@owen/foundry-core/shared/host-ops';
/*
 * AND THE CHIP IN THE CHROME, which is the socket's second push door.
 * `setHostNodes` says what the host is making OF A PARTICULAR BOOK and lands on
 * that book's tree; this says what the host is doing AT ALL and lands in the
 * window's top corner, once, whichever book is open. Null clears it and the
 * chrome goes back to being Foundry's alone — see electron/host-ops.ts, and
 * `FoundryHost.onStatusOpen` for what a click on it asks.
 */
export { setHostStatus } from '@owen/foundry-core/node/host-ops';
export type { HostStatus } from '@owen/foundry-core/shared/host-ops';
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
export { setHostOperations } from '@owen/foundry-core/node/host-ops';
/*
 * DROPPING A STEP, FOR A HOST THAT LISTS ITS EXPORTS.
 *
 * BookForge shows a Foundry export as a version nested under its parent book,
 * and Owen ruled on 2026-09-17 that the two are one item: delete the version
 * there and the step goes here, delete the step here and the version goes there.
 * The second half is already the host's own work — its tray reconcile withdraws
 * a row whose file has left `final/` — and this is the first half.
 *
 * IT IS THE HANDLER'S OWN BODY, reached through `deleteLedgerStep`'s holder in
 * electron/ipc.ts rather than copied: the ghost branch, both busy proofs and the
 * subtree cascade are conditions a second implementation would drift from, and
 * two apps deleting different things from one press is the disagreement about
 * "what a book is" that this file's header exists to prevent.
 *
 * ITS REFUSALS ARE THROWN AND ARE MEANT TO BE SHOWN. A step with a run about to
 * write into it, a queued job, a payload this window has open — each is a
 * sentence written for a person, and the host is expected to put it in front of
 * one rather than paraphrase it or swallow it into a silent no-op.
 *
 * A SUBTREE GOES WITH IT, which the caller must expect: a step chained behind
 * the one named is destroyed too. Owen: *"epubs shouldnt have any sub-steps.
 * theyre final pieces … but if there do happen to be sub-steps, remove them."*
 */
export { deleteLedgerStep } from '@owen/foundry-core/node/doors-delete';
/*
 * DELETING ONE EXPORT, FOR A HOST THAT LISTS IT AS A VERSION. Owen, 2026-09-28:
 * deleting the EPUB there deletes the EPUB — its file in `final/` and its row in
 * the catalogue — and NOT the step it was cast from. Hand it the absolute path
 * of the file under `<project>/final/`. Refusals (a job busy on the project, a
 * path outside the library) are thrown sentences, as `deleteLedgerStep`'s are.
 * The windows re-read on the `projects:changed` the delete announces.
 */
export { deleteExport } from '@owen/foundry-core/node/doors-delete';
/*
 * DELETING A WHOLE PROJECT, FOR A HOST WHOSE BOOK IS BEING DELETED (BookForge's
 * electron/book-delete.ts, 2026-11-08). Hand it the project's absolute folder.
 * A job writing into it, or a file held open, is a thrown sentence; on success
 * the folder is gone and every recents row under it with it.
 */
export { deleteProjectFolder } from '@owen/foundry-core/node/doors-delete';
export type { HostNode, HostNodeProgress, HostNodeState, HostOperationKind, NodeOutput } from '@owen/foundry-core/shared/types';
/*
 * HOW A HOST SAYS ITS STOP IS NOT ITS CANCEL — re-exported here because this file
 * IS the host-facing surface, and a constant a host has to reach past the mount to
 * import is a constant it will retype instead. Pass it as the abort's reason:
 *
 *     controller.abort(RESUMABLE_STOP)   // Stop — the reading's pages are kept
 *     controller.abort()                 // Cancel — the reading keeps nothing
 *
 * The whole argument, including why it rides on the abort rather than on
 * `RunOptions`, is on the constant itself in shared/types.ts.
 */
export { RESUMABLE_STOP } from '@owen/foundry-core/shared/types';
/*
 * ── AND THE QUEUE SOCKET: ONE MACHINE'S GPU HAS ONE OWNER ───────────────────
 *
 * Owen ruled it (docs/PLAN.md, Wave 16): *"we need to centralize the queue in
 * bookforge."* A host that registers `hostQueue` on the mount does the DECIDING;
 * these three are what Foundry offers back.
 *
 *     runJob(request, {parentStep, signal, venue, onLine, onProgress, onPlaced})
 *     setHostQueueRows(projectDir, rows)                  what your queue holds
 *     hostQueueDrained()                                  and when it is empty
 *
 * `runJob` resolves with a typed {@link RunOutcome} — `done`, `failed`, `wait`,
 * `parked` or `cancelled`. The three that landed or were stopped carry the
 * settled `Job` ROW, because a result type that could not say CANCELLED was the
 * first thing this seam got wrong: a cancel filed as a failure is how a host's
 * retry restarts work a person just stopped. `wait` carries no row, because
 * nothing ran — it is the holder's own sentence plus whether time alone will
 * ever clear it, and the host parks. `parked` carries no row either: the engine
 * ran, the model server's weather outlasted its retry budget, and it exited
 * `ENGINE_PARKED_EXIT` with the pages it read banked — the host re-queues the
 * same request and the resume is free (see `ENGINE_PARKED_EXIT` in
 * shared/types.ts, and the arm in the queue that answers exit 75).
 *
 * THE REQUEST THAT CROSSES IS IDENTITY ONLY. It names the row this work is made
 * from (`at`, or `deferred.from`) and never a path under `derived/`: the book, the
 * seed and the generation are made when the run starts, because a derived book is
 * swept at every settle and a request outlives its row's first attempt. A host may
 * therefore persist a request, restore it after a restart and hand it back, which
 * is exactly what BookForge's Retry and Start do.
 *
 * `setHostQueueRows` is in the `setHost*` family by shape and by purpose, and it
 * comes from the queue rather than from `host-ops.ts` because the module that
 * publishes the shelf's mirror must be the module that holds what the shelf
 * draws — two modules answering "what is in the queue" is the one thing this
 * whole wave exists to prevent.
 *
 * ABSENT, ALL THREE ARE UNREACHED and Foundry queues exactly as it always has.
 */
export { hostQueueDrained, printedFormsAt, printedFormsForRun, runJob, setHostQueueRows } from '@owen/foundry-core/node/job-queue';
export type { FoundryHostQueue } from '@owen/foundry-core/node/host';
export type {
  CleanRequest, FoundryJobRow, Job, JobRequest, RunOutcome, RunPlacement, RunVenue, SimplifyRequest,
  TextPassRequest, TranslateRequest,
} from '@owen/foundry-core/shared/types';

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

    if (url.host === 'capture') {
      /*
       * `/<token>/<name>` — one picture of ONE capture project, out of the
       * single directory that token was minted for (`captureServedFile`,
       * electron/capture.ts). The shape is the book host’s above,
       * deliberately: allow-list, plain basename, 403 for anything else, and
       * no path check anybody has to keep right.
       *
       * TWO KINDS OF PICTURE COME THROUGH IT: the working copies and
       * thumbnails under `capture/derived/`, which the light table draws, and
       * the rectified pages a mint wrote into `archive/`, which the page view
       * draws. One host rather than two, because the decision they need is the
       * same decision — did this process register that directory — and a
       * second host would be a second copy of it to keep right.
       *
       * THE ORIGINALS HAVE NO HOST AND CANNOT BE GIVEN ONE FROM HERE. Every
       * file either token reaches is one this app MADE, and remakes on demand
       * from the photographs plus the recipe. The photographs themselves —
       * which for an archive shoot may be the only copies that exist — are not
       * addressable through this scheme at all.
       */
      const segments = url.pathname.split('/').filter((part) => part.length > 0);
      const token = segments.shift();
      if (token === undefined || segments.length !== 1) {
        return new Response('No project and picture were named.', { status: 400 });
      }
      const picture = captureServedFile(token, decodeURIComponent(segments[0]!));
      if (picture === null) {
        return new Response('That project\u2019s photographs are not open in this app.', { status: 403 });
      }
      return serveFile(picture, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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
   * ── THE PLATFORM FIRST, before anything below can reach it ─────────────────
   *
   * The work code asks `platform.ts` for userData, temp, the window push and the
   * image codec instead of importing Electron (2026-11-04, FOUNDRY-CORE-PLAN
   * step 1). This is where the Electron answers are handed over, for the
   * standalone shell and a host alike — both mount through here, so neither can
   * forget. The paths stay functions so they are asked when used, as before.
   */
  setPlatform({
    userDataDir: () => app.getPath('userData'),
    tempDir: () => app.getPath('temp'),
    broadcast,
    image: nativeImage,
  });
  /*
   * ── SETTINGS KEYS THE ENGINE NO LONGER READS, DROPPED ONCE ────────────────
   *
   * `backend.python` and `backend.mode: "mlx"` went with Foundry's Python
   * (2026-11-04), and the engine refuses an unknown mode. Here, for the shell
   * and a host alike, before anything spawns the engine: the file is written
   * back without them and the one sentence says what went and where the
   * downloaded environments are left. A no-op on every later start.
   */
  const retired = retireSettingsKeys();
  if (retired !== null) console.log(`[settings] ${retired}`);
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
    // AN UNFILED LANDING IS NOT THE HOST'S SHELF'S BUSINESS: the file went to
    // the path the host itself named (`exportEpubFromStep`'s `to`), and the
    // caller awaiting it below is the one who wanted to hear. Announcing it
    // through onExport would file the host's own scratch as a version.
    if (host !== undefined && landing.unfiled !== true) {
      try {
        host.onExport(landing);
      } catch (err) {
        console.error(
          `[mount] the host's onExport threw for ${landing.path}: `
          + `${err instanceof Error ? err.message : String(err)}. The export itself landed.`,
        );
      }
    }
    settleAwaitedExports(landing);
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
  /*
   * ── THE ENGINE ON THIS MACHINE, FOUND WITHOUT ANYBODY BEING ASKED ──────────
   *
   * crucible `docs/PHASE15-HOST.md` §5.1, way 1: `<CRUCIBLE_HOME>/pairing` is
   * read and, unless its ADDRESS is already registered, the server is added
   * under the name the line itself carries. Owen's whole sentence for this phase
   * is *"the user shouldn't have to interact with crucible almost at all"* — a
   * machine whose installer already wrote a token has nothing left to type.
   *
   * Discovery and the pairing path belong to the Crucible SDK. Foundry does
   * not guess credentials or inspect WSL: a published connection is registered
   * even on the first run, when Foundry's own registry is empty.
   *
   * NO RESERVED NAME AND NO LOCALITY TEST, per Owen's ruling (*"a local crucible
   * server shouldnt be treated any differently than a remote crucible server"*):
   * see `adoptPairingFile`, which argues both.
   *
   * STANDALONE ONLY, hence the guard rather than a `hosted()` check inside: a
   * hosted window's registry is the HOST's and is read-only from here (the door
   * refuses anyway, which is why this is a skip and not a safety), so a call
   * would be this app trying to add a server to somebody else's list on every
   * BookForge launch.
   *
   * AFTER `registerIpc`, because the write ends in `afterRegistryChanged` — the
   * capability re-measure and docs/SLOTS.md §5b's page-reader pass — which lives
   * behind the IPC module. And NOT AWAITED, because `mountFoundry` is what runs
   * before the window opens: this reads a small file and then probes servers over
   * the network, and a window that waited for a probe would be a window that did
   * not appear because an engine was slow. Nothing on screen depends on it having
   * finished; the wizard re-reads the registry when main announces gate changes,
   * so discovery finishing after its first read still appears automatically.
   *
   * IT CANNOT REJECT — every arm answers a `LocalCrucibleAdd`, including "there
   * is no file", which is a FACT and not a fallback — so there is no catch here
   * to swallow one.
   */
  if (host === undefined) void connectLocalEngine();
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
      /*
       * ── A CAPTURE PROJECT HAS NOTHING TO OPEN AND IS STILL OPENABLE ────────
       *
       * `originalOf` answers null for one, and it always did between New Project
       * and the first mint — but a mint used to file a PDF and that null became
       * a document. It no longer does: the mint writes a folder of page images,
       * which is deliberately not a catalogued document (`documentArchive`,
       * electron/projects.ts). So the refusal below, left alone, would have
       * turned Edit-in-Foundry on a FINISHED captured book into a console line
       * and an empty window — a door that worked yesterday, for the one kind of
       * book this app was photographing all week.
       *
       * The opening carries no document rather than a fabricated one. What
       * stands in for it is the light table, which is what a click on that
       * project's row opens standalone (`openProject`, home.component.ts) — the
       * same rule through both doors, which is the promise this function's own
       * docblock makes.
       */
      if (project === undefined || (original === null && !project.capture)) {
        console.error(`[mount] ${projectDir} is not a project with anything openable in it.`);
        return;
      }
      win.webContents.send('project:open', {
        dir: project.dir,
        originalPath: original?.path ?? null,
        managed: original?.managed ?? false,
      });
    }).catch((err: Error) => {
      console.error(`[mount] ${projectDir} could not be opened: ${err.message}`);
    });
  });
}

/*
 * THE EPUB A HOST'S ACT NEEDS, THE READINGS PASS AND THE QUIT live in
 * electron/mount-work.ts (FOUNDRY-CORE-PLAN step 2) and are this seam's by the
 * same names they always had.
 */
export { exportEpubFromStep, planReadingsPass, stopFoundry } from '@owen/foundry-core/node/mount-work';

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
    jobsPending: jobsPending(),
  };
}

/** The host calls this after committing its first-run model/upstream choices. */
export { prepareFoundryForUse as resumeModelPreparation } from '@owen/foundry-core/node/crucible-coordinate';

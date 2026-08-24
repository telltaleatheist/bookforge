/**
 * serve-bookshelf.js — the REAL bookshelf server, headless, in standalone mode.
 *
 * Nothing here is a reimplementation. It starts the same compiled
 * `dist/electron/bookshelf-server.js` the Electron app starts, with
 * `mode: 'standalone'` — the library-only mirror: browse, stream, download and
 * read the library, keep reader state under `<library>/.bookshelf/`, and refuse
 * (501, naming the capability) everything that needs the TTS engine, ingests a
 * document, or mutates the library. See electron/bookshelf-server.ts.
 *
 * The point is a copy that stays up when BookForge is down on both machines:
 * the library lives on the NAS, so the NAS can serve it. Reader state is
 * per-device files under the library share merged on read, so this server and
 * the app's converge by construction — no coordination, no primary.
 *
 * Requires BookForge to be BUILT and NOT running:
 *   npx tsc -p tsconfig.electron.json     # dist/electron/*.js
 *   npm run build:bookshelf               # dist/electron/bookshelf-ui (the web app)
 *   node -e "require('fs').cpSync('electron/data','dist/electron/data',{recursive:true})"
 *
 * Usage:
 *   node cli/serve-bookshelf.js --library /mnt/library/bookforge
 *   node cli/serve-bookshelf.js --library Z:\bookforge --port 8765 --state-dir /var/lib/bookforge
 *
 * Options:
 *   --library <path>     REQUIRED. The library root (the folder holding
 *                        projects/ and bookshelf.json). No default: guessing it
 *                        would serve, or write reader state into, the wrong tree.
 *   --port <n>           Default 8765 — the same port electron/main.ts uses, so
 *                        a client paired with the app finds the mirror unchanged.
 *   --state-dir <path>   Per-machine state (duration cache, cover thumbnails,
 *                        reader tokens, bookshelf-device-id). Default:
 *                        <userData>/bookshelf-server, where <userData> is the
 *                        platform config root the app itself uses —
 *                        %APPDATA%\BookForge on Windows, ~/Library/Application
 *                        Support/BookForge on macOS, $XDG_CONFIG_HOME/BookForge
 *                        (else ~/.config/BookForge) on Linux. NOT on the library
 *                        share: these are this machine's, never synced.
 */
'use strict';
require('./electron-stub.js'); // intercept require('electron') for the compiled modules

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { USER_DATA } = require('./electron-stub.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'electron');

const USAGE = `
Usage:  node cli/serve-bookshelf.js --library <path> [--port <n>] [--state-dir <path>]

  --library <path>     REQUIRED — the library root (holds projects/, bookshelf.json)
  --port <n>           default 8765 (the port the app serves on)
  --state-dir <path>   default ${path.join(USER_DATA, 'bookshelf-server')}
`.trim();

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; continue; }
    a[body] = true;
  }
  return a;
}

/**
 * Prove ffprobe and ffmpeg actually RUN before we take the first request.
 *
 * tool-paths.js ends its resolution ladder at the bare names 'ffprobe'/'ffmpeg'
 * — fine when they are on PATH, and a silent time bomb when they are not: the
 * failure would surface later as a chapter list that is quietly empty and a
 * transcript that never appears. So it is checked once, loudly, at startup,
 * naming what was resolved and how to override it.
 */
function preflightMediaTools(toolPaths) {
  for (const [name, resolve, env] of [
    ['ffprobe', toolPaths.getFfprobePath, 'FFPROBE_PATH'],
    ['ffmpeg', toolPaths.getFfmpegPath, 'FFMPEG_PATH'],
  ]) {
    const resolved = resolve();
    try {
      execFileSync(resolved, ['-version'], { stdio: 'ignore' });
    } catch (err) {
      throw new Error(
        `${name} does not run. tool-paths resolved it to "${resolved}", and executing it failed `
        + `(${err.message}). Chapters, transcripts and durations all go through it. Install ${name} `
        + `or point ${env} at the binary.`);
    }
    console.log(`[serve-bookshelf] ${name}: ${resolved}`);
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) { console.log(USAGE); return; }

  if (!args.library || args.library === true) {
    throw new Error(`--library is required (no default — the library root must be named).\n\n${USAGE}`);
  }
  const library = path.resolve(args.library);
  if (!fs.existsSync(library)) throw new Error(`No such library root: ${library}`);
  if (!fs.statSync(library).isDirectory()) throw new Error(`Not a directory: ${library}`);

  const port = args.port === undefined ? 8765 : Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be a port number, got "${args.port}"`);
  }

  const stateDir = args['state-dir'] && args['state-dir'] !== true
    ? path.resolve(args['state-dir'])
    : path.join(USER_DATA, 'bookshelf-server');
  fs.mkdirSync(stateDir, { recursive: true });

  if (!fs.existsSync(DIST)) {
    throw new Error(`dist/electron missing — build first:  npx tsc -p tsconfig.electron.json`);
  }
  // The server serves the Angular bundle out of dist/electron/bookshelf-ui. A
  // missing bundle is an API-only server whose every page is a 404 — say so now.
  const uiIndex = path.join(DIST, 'bookshelf-ui', 'index.html');
  if (!fs.existsSync(uiIndex)) {
    throw new Error(`The bookshelf web app is not built (${uiIndex} missing) — run:  npm run build:bookshelf`);
  }

  const manifestService = require(path.join(DIST, 'manifest-service.js'));
  const toolPaths = require(path.join(DIST, 'tool-paths.js'));
  const { bookshelfServer } = require(path.join(DIST, 'bookshelf-server.js'));

  preflightMediaTools(toolPaths);

  // Manifests store library-RELATIVE forward-slash paths resolved against this,
  // so a Linux root works the same as the Windows one the manifests were written
  // under. This is the whole of the "the library moved" problem.
  manifestService.setLibraryBasePath(library);
  console.log(`[serve-bookshelf] library:   ${library}`);
  console.log(`[serve-bookshelf] state dir: ${stateDir}`);

  await bookshelfServer.start({ port, userDataPath: stateDir, mode: 'standalone' });
  // getStatus().addresses are already full http://host:port URLs.
  for (const addr of bookshelfServer.getStatus().addresses) console.log(`[serve-bookshelf] ${addr}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[serve-bookshelf] ${signal} — stopping`);
    bookshelfServer.stop().then(
      () => process.exit(0),
      (err) => { console.error(`[serve-bookshelf] stop failed: ${err.message}`); process.exit(1); },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch((err) => {
  console.error(`[serve-bookshelf] ${err.message}`);
  process.exit(1);
});

import { app, BrowserWindow, ipcMain, dialog, Menu, protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as pdfWorkerProxy from './pdf-worker-proxy.js';
import { getOcrService } from './ocr-service';
import { getPluginRegistry } from './plugins/plugin-registry';
import { loadBuiltinPlugins } from './plugins/plugin-loader';
import { bookshelfServer } from './bookshelf-server';
import * as ebookLibrary from './ebook-library';
import { getHeadlessOcrService } from './headless-ocr';
import { initializeLoggers, getMainLogger, closeLoggers } from './rolling-logger';
import { setupAlignmentIpc } from './sentence-alignment-window.js';
import * as manifestService from './manifest-service';
import * as manifestMigration from './manifest-migration';
import { findEbookConvert } from './ebook-convert-bridge';
import { applyMetadata } from './metadata-tools';
import { normalizeFsPath, toAsciiSlug } from './path-utils';
import { setE2aScratchDir, getDefaultE2aTmpPath } from './e2a-paths';
import { loadConfig as loadToolPathsConfig } from './tool-paths';
import { mergeEpubParagraphs } from './epub-paragraph-merger';
import { componentManager, runInstaller as runExternalInstaller, listInstallableIds, installerNote } from './components/component-manager';
import { systemProbe } from './components/system-probe';
import { markBootOk } from './launcher/boot-state';
import { checkAndStageCodeUpdate, getCodeUpdateStatus } from './update/code-updater';
import { listManagedComponents, checkComponentUpdates, installComponent } from './update/component-updater';
import { getStarterStatus, installStarterLibrary } from './update/starter-library';

// Normalize the app's data directory. Electron derives userData from the app
// name, which defaults to package.json `name` ("bookforge-app") — inconsistent
// with the product ("BookForge") and the logger dir, which made uninstall /
// "remove all data" target the wrong folder. Pin it to "BookForge" so EVERYTHING
// (env, settings, localStorage, logs, caches) lives under one predictable folder.
// MUST run before the first app.getPath('userData') (next at line ~225).
app.setName('BookForge');

let mainWindow: BrowserWindow | null = null;

// First-run runtime readiness. Packaged builds unpack the bundled Python env +
// e2a snapshot on first launch (~40 s); during that window the UI looks ready
// but jobs would hit a half-ready runtime / conda fallback. We track the state
// here and broadcast it so the renderer can show a blocking "Setting up…"
// overlay and gate job submission. Buffered so a late-loading renderer can
// query the current state via `runtime:get-status` instead of missing events.
export type RuntimeReadyState = 'preparing' | 'ready' | 'error';
export interface RuntimeStatus {
  state: RuntimeReadyState;
  message: string;
  error?: string;
  // Live mandatory-download progress during first-run setup (for the ETA UI).
  download?: { downloadedBytes: number; totalBytes: number; etaSeconds: number | null };
}
let runtimeStatus: RuntimeStatus = { state: 'preparing', message: 'Starting the audiobook engine…' };
// True when the bundled environment had to be unpacked from scratch this launch
// (fresh install or post-"Remove all data"). Set in the first-run setup block.
let runtimeWasFresh = false;

function setRuntimeStatus(next: RuntimeStatus): void {
  runtimeStatus = next;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('runtime:status', next);
  }
}

// Nudge the TTS API server to recompute its installed-voice list and push it to
// connected external clients (e.g. after a voice download/uninstall). No-op if
// the server hasn't started yet — start() builds the list itself.
async function refreshTtsApiVoices(): Promise<void> {
  try {
    const { ttsApiServer } = await import('./tts-api-server.js');
    await ttsApiServer.refreshInstalledVoices();
  } catch (err) {
    console.error('[Startup] Failed to refresh TTS API voices:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// First-run "update": download + install the mandatory runtime components
// (Python env, default voice, English language pack) in the background, then
// start the TTS API server. Gated behind the library-location step so the user
// can quit before any large download begins; triggered from startup (when a
// library is already set) and from the library:set-root handler (first run).
// Idempotent — the ensure* calls are no-ops once their assets are installed.
// ─────────────────────────────────────────────────────────────────────────────

let runtimeSetupInFlight: Promise<void> | null = null;
let runtimeSetupDone = false;
let ttsApiStarted = false;

async function startTtsApiServerOnce(): Promise<void> {
  if (ttsApiStarted) return;
  ttsApiStarted = true;
  try {
    const { ttsApiServer } = await import('./tts-api-server.js');
    const status = await ttsApiServer.start(app.getPath('userData'));
    console.log(`[Startup] TTS API server on port ${status.port} (host ${status.host})`);
  } catch (err) {
    ttsApiStarted = false; // allow a later retry
    console.error('[Startup] TTS API server failed to start:', err);
  }
}

async function doRuntimeSetup(): Promise<boolean> {
  const {
    ensureBundledEnv, ensureBundledE2a, ensureDefaultVoice, ensureEnglishStanza,
    ensureLibraryVoices, beginSetupDownload, setupDownloadProgress,
  } = await import('./e2a-env-bootstrap.js');

  const logger = getMainLogger();
  beginSetupDownload();
  const emit = (message: string) => {
    logger.info(message);
    setRuntimeStatus({ state: 'preparing', message, download: setupDownloadProgress() ?? undefined });
  };

  setRuntimeStatus({ state: 'preparing', message: 'Updating BookForge — installing components…' });

  // Independent steps: a failure in one must not block the others; the first
  // error is surfaced at the end. Order matters — the e2a code snapshot creates
  // the runtime dir the voice + language pack extract into.
  let firstError: string | null = null;
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      const message = (err as Error).message;
      if (firstError === null) firstError = message;
      logger.error(`${label} failed`, { error: message });
    }
  };

  await step('Bundled e2a code setup', () => ensureBundledE2a(emit));
  await step('Python env setup', () => ensureBundledEnv(emit));
  await step('Default voice setup', () => ensureDefaultVoice(emit));
  await step('English language pack setup', () => ensureEnglishStanza(emit));

  if (firstError) {
    setRuntimeStatus({ state: 'error', message: 'Setup of the audiobook engine failed.', error: firstError });
    return false;
  }

  setRuntimeStatus({ state: 'ready', message: 'Ready' });
  await startTtsApiServerOnce();

  // The Voice Library clips are an OPTIONAL background pull — not bundled in the
  // installer and not gating readiness. Fire-and-forget after the app is ready;
  // the library voices appear in the pickers once it lands. A failure is logged
  // and retried on the next launch (the ready-marker isn't written on failure).
  void ensureLibraryVoices((message) => logger.info(message))
    .then(async () => {
      // New clips on disk — drop the scan cache so they show in the pickers now,
      // and refresh the TTS API server's exposed voice list.
      const { invalidateVoiceScanCache } = await import('./xtts-voices.js');
      invalidateVoiceScanCache();
      void refreshTtsApiVoices();
    })
    .catch((err) => {
      logger.warn('Voice library download failed (will retry next launch)', { error: (err as Error).message });
    });

  return true;
}

/**
 * Kick off the first-run "update" (idempotent). Safe to call from startup (when a
 * library is already set) and from library:set-root (first run). Resets on failure
 * so a re-trigger retries; succeeds once and then no-ops.
 */
function startRuntimeSetup(): Promise<void> {
  if (runtimeSetupDone) return Promise.resolve();
  if (runtimeSetupInFlight) return runtimeSetupInFlight;
  runtimeSetupInFlight = doRuntimeSetup()
    .then((ok) => { if (ok) runtimeSetupDone = true; })
    .catch((err) => { getMainLogger().error('Runtime setup crashed', { error: (err as Error).message }); })
    .finally(() => { runtimeSetupInFlight = null; });
  return runtimeSetupInFlight;
}

// Suppress benign mupdf WASM FinalizationRegistry errors.
// These fire asynchronously during GC when mupdf tries to free stale page/pixmap/annotation
// objects. They don't affect functionality — the resources are already freed by mupdf internally.
process.on('uncaughtException', (err) => {
  if (err instanceof WebAssembly.RuntimeError && err.stack?.includes('FinalizationRegistry')) {
    return;
  }
  console.error('Uncaught exception:', err);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Discovery
// ─────────────────────────────────────────────────────────────────────────────

let cachedPdftotextPath: string | null | undefined = undefined;

/**
 * Find the pdftotext executable (from poppler-utils or Xpdf)
 */
async function findPdftotext(): Promise<string | null> {
  if (cachedPdftotextPath !== undefined) {
    return cachedPdftotextPath;
  }

  const homeDir = os.homedir();
  const candidates: string[] = process.platform === 'win32'
    ? [
        path.join(homeDir, 'scoop', 'shims', 'pdftotext.exe'),
        'C:\\Program Files\\poppler\\bin\\pdftotext.exe',
        'C:\\Program Files\\poppler\\Library\\bin\\pdftotext.exe',
        'C:\\Program Files (x86)\\poppler\\bin\\pdftotext.exe',
        'C:\\ProgramData\\chocolatey\\bin\\pdftotext.exe',
        path.join(homeDir, 'poppler', 'bin', 'pdftotext.exe'),
      ]
    : [
        '/opt/homebrew/bin/pdftotext',
        '/usr/local/bin/pdftotext',
        '/usr/bin/pdftotext',
      ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      cachedPdftotextPath = candidate;
      console.log('[Tool Discovery] pdftotext found at:', candidate);
      return candidate;
    } catch {
      // Not found at this path
    }
  }

  // Try PATH lookup
  try {
    const { exec: execCb } = require('child_process');
    const { promisify } = require('util');
    const execP = promisify(execCb);
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execP(`${cmd} pdftotext`);
    if (stdout && stdout.trim()) {
      const foundPath = stdout.trim().split('\n')[0].trim();
      cachedPdftotextPath = foundPath;
      console.log('[Tool Discovery] pdftotext found in PATH:', foundPath);
      return foundPath;
    }
  } catch {
    // Not in PATH
  }

  console.log('[Tool Discovery] pdftotext not found');
  cachedPdftotextPath = null;
  return null;
}

// Custom library root (set via IPC from renderer settings)
// Module-level so all path functions can use it
let customLibraryRoot: string | null = null;

// Persist library root so the main process can read it at startup (before renderer loads)
const libraryRootConfigPath = path.join(app.getPath('userData'), 'library-root.json');

function loadPersistedLibraryRoot(): string | null {
  try {
    const data = fsSync.readFileSync(libraryRootConfigPath, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.libraryRoot) {
      // Return the saved path even if it is not currently present on disk.
      // The library often lives on an external/network drive that mounts a few
      // seconds after launch; discarding the path here (and silently falling
      // back to the default ~/Documents/BookForge) is what caused the saved
      // library to be lost on every "drive not mounted yet" launch.
      if (!fsSync.existsSync(parsed.libraryRoot)) {
        console.warn('[Startup] Persisted library root not currently present (drive offline?), keeping it anyway:', parsed.libraryRoot);
      }
      return parsed.libraryRoot;
    }
  } catch { /* no persisted root */ }
  return null;
}

function persistLibraryRoot(libraryRoot: string | null): void {
  try {
    fsSync.writeFileSync(libraryRootConfigPath, JSON.stringify({ libraryRoot }));
  } catch { /* ignore */ }
}

// Tracks whether the app is actually quitting (vs just hiding the window)
let isQuitting = false;

// Zoom level persistence
const zoomConfigPath = path.join(app.getPath('userData'), 'zoom-level.json');

function loadZoomLevel(): number {
  try {
    const data = fsSync.readFileSync(zoomConfigPath, 'utf-8');
    return JSON.parse(data).zoomLevel ?? 0;
  } catch { return 0; }
}

function saveZoomLevel(level: number): void {
  try { fsSync.writeFileSync(zoomConfigPath, JSON.stringify({ zoomLevel: level })); }
  catch { /* ignore */ }
}

function getLibraryRoot(): string {
  if (customLibraryRoot) {
    return customLibraryRoot;
  }
  return path.join(app.getPath('documents'), 'BookForge');
}

/**
 * Point e2a's temp/session storage at <library>/tmp — a plain tmp folder INSIDE
 * the library (not a separate sibling). It's on the library volume (so caching a
 * finished session into the library is a same-volume clone) and is swept
 * religiously (cleanE2aTmpDir at startup; sessions also removed once cached), so
 * it never accumulates. Called at startup and whenever the library root changes.
 *
 * NOTE: if the library is Syncthing-synced, add `tmp/` to its .stignore so the
 * transient per-sentence churn isn't synced.
 */
function applyE2aScratchDir(): void {
  // A user-configured scratch path wins; otherwise use <library>/tmp. loadConfig()
  // is safe before app-ready (it only reads a JSON file under userData).
  const override = loadToolPathsConfig().ttsScratchPath;
  if (typeof override === 'string' && override.trim()) {
    setE2aScratchDir(override.trim());
    return;
  }
  setE2aScratchDir(path.join(getLibraryRoot(), 'tmp'));
}

/**
 * Religiously empty the e2a tmp dir. Called at startup (nothing is converting yet,
 * so it's always safe to wipe leftovers from prior/failed/interrupted runs) and
 * after the library root changes. Finished sessions are already removed once cached
 * (cacheSessionToBfp/Project); this catches everything else so tmp never grows.
 */
async function sweepDirContents(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map((e) =>
        fs.rm(path.join(dir, e.name), { recursive: true, force: true }).catch(() => {})
      )
    );
    if (entries.length) console.log(`[MAIN] Cleaned ${entries.length} item(s) from e2a tmp: ${dir}`);
  } catch {
    /* dir doesn't exist yet / volume offline — nothing to clean */
  }
}

async function cleanE2aTmpDir(): Promise<void> {
  await sweepDirContents(getDefaultE2aTmpPath());

  // WSL Orpheus runs the WSL-native e2a, which writes sessions to its own
  // <wslE2a>/tmp (not <library>/tmp) — sweep that too so it doesn't accumulate.
  try {
    const { shouldUseWsl2ForOrpheus, getWslE2aPath, wslPathToWindows } = await import('./tool-paths.js');
    if (shouldUseWsl2ForOrpheus()) {
      await sweepDirContents(wslPathToWindows(`${getWslE2aPath()}/tmp`));
    }
  } catch {
    /* tool-paths import / WSL access failed — skip WSL sweep */
  }
}

// Bookshelf config file path
function getBookshelfConfigPath(): string {
  return path.join(getLibraryRoot(), 'bookshelf.json');
}

// One-time migration: rename legacy config file
async function migrateBookshelfConfig(): Promise<void> {
  const newPath = getBookshelfConfigPath();
  if (fsSync.existsSync(newPath)) return;
  const legacyPath = path.join(getLibraryRoot(), 'library-server.json');
  if (fsSync.existsSync(legacyPath)) {
    try {
      await fs.rename(legacyPath, newPath);
      console.log('[BookshelfServer] Migrated config from library-server.json to bookshelf.json');
    } catch (err) {
      console.error('[BookshelfServer] Config migration failed:', err);
    }
  }
}

// Load bookshelf config from file
async function loadBookshelfConfig(): Promise<{ enabled: boolean; port: number; externalAudiobooksDir?: string } | null> {
  try {
    await migrateBookshelfConfig();
    const configPath = getBookshelfConfigPath();
    if (!fsSync.existsSync(configPath)) {
      return null;
    }
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Save bookshelf config to file
async function saveBookshelfConfig(config: { enabled: boolean; port: number; externalAudiobooksDir?: string }): Promise<void> {
  const configPath = getBookshelfConfigPath();
  const dir = path.dirname(configPath);
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// Auto-start bookshelf server. Default ON: a fresh install (no bookshelf.json
// yet) starts the server and persists the config, so the library is immediately
// browsable on the network. An explicit user opt-out (enabled:false, written by
// the stop handler) is respected on subsequent launches.
async function autoStartBookshelf(): Promise<void> {
  const config = await loadBookshelfConfig();
  const port = config?.port ?? 8765;
  const enabled = config ? config.enabled : true;
  if (!enabled) return;
  try {
    console.log('[BookshelfServer] Auto-starting on port', port);
    await bookshelfServer.start({ port, userDataPath: app.getPath('userData') });
    // Persist the default on first launch so the stop handler has a config to
    // flip to disabled (it only saves when a config already exists).
    if (!config) {
      await saveBookshelfConfig({ enabled: true, port });
    }
  } catch (err) {
    console.error('[BookshelfServer] Auto-start failed:', err);
  }
}

// Register custom protocol for serving page images from temp files
// This avoids file:// security restrictions
function registerPageProtocol(): void {
  protocol.handle('bookforge-page', async (request) => {
    // URL format: bookforge-page:///path
    // On Mac: bookforge-page:///Users/name/...
    // On Windows: bookforge-page:///C:/Users/name/... or bookforge-page://C:/Users/name/...
    let filePath: string;

    const urlStr = request.url;

    // Extract path after protocol
    if (urlStr.startsWith('bookforge-page:///')) {
      filePath = urlStr.substring('bookforge-page:///'.length);
    } else if (urlStr.startsWith('bookforge-page://')) {
      filePath = urlStr.substring('bookforge-page://'.length);
    } else {
      filePath = urlStr.replace('bookforge-page:', '');
    }

    // Strip query string (cache-buster) before resolving file path
    const qIdx = filePath.indexOf('?');
    if (qIdx !== -1) {
      filePath = filePath.substring(0, qIdx);
    }

    filePath = decodeURIComponent(filePath);

    // Handle Windows paths
    if (process.platform === 'win32') {
      // Case 1: Path like "c/Users/..." (Unix-style drive letter, no colon) -> "C:/Users/..."
      if (/^[a-zA-Z]\/[^:]/.test(filePath)) {
        filePath = filePath[0].toUpperCase() + ':' + filePath.substring(1);
      }
      // Case 2: Path like "C:/Users/..." is already correct, just normalize slashes
    }

    // On Mac/Linux, ensure absolute path starts with /
    if (process.platform !== 'win32' && !filePath.startsWith('/')) {
      filePath = '/' + filePath;
    }

    // Normalize to platform-specific separators
    filePath = filePath.split('/').join(path.sep);

    // Debug first few requests
    if (!(registerPageProtocol as any).logged) {
      (registerPageProtocol as any).logged = 0;
    }
    if ((registerPageProtocol as any).logged < 3) {
      console.log('[Protocol] URL:', urlStr);
      console.log('[Protocol] Resolved path:', filePath);
      (registerPageProtocol as any).logged++;
    }

    // Cache holds JPEGs (new) and PNGs (pre-June-2026)
    const contentType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    try {
      // Use async readFile — libuv retries on EINTR automatically,
      // unlike readFileSync which throws on interrupted system calls
      // during heavy I/O (e.g. rendering 300+ page PDFs)
      const data = await fs.readFile(filePath);
      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'max-age=31536000' // Cache for 1 year
        }
      });
    } catch (err) {
      // Retry once on EINTR (belt-and-suspenders — libuv should handle this)
      if ((err as NodeJS.ErrnoException).code === 'EINTR') {
        try {
          const data = await fs.readFile(filePath);
          return new Response(data, {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'max-age=31536000'
            }
          });
        } catch (retryErr) {
          console.error('[Protocol] Failed to load page image (retry):', filePath, retryErr);
          return new Response('File not found', { status: 404 });
        }
      }
      console.error('[Protocol] Failed to load page image:', filePath, err);
      return new Response('File not found', { status: 404 });
    }
  });
}

// Register custom protocol for serving audio files with streaming support
// This avoids file:// security restrictions and handles large files efficiently
function registerAudioProtocol(): void {
  console.log('[Audio Protocol] Registering bookforge-audio protocol handler');

  protocol.handle('bookforge-audio', async (request) => {
    // Log to main process console AND send to renderer if window exists
    const logToAll = (msg: string) => {
      console.log(msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`console.log('[MAIN] ${msg.replace(/'/g, "\\'")}')`).catch(() => {});
      }
    };

    logToAll('[Audio Protocol] Request received');

    // URL format: bookforge-audio:///path
    let filePath: string;

    const urlStr = request.url;
    logToAll(`[Audio Protocol] URL: ${urlStr}`);

    // Extract path after protocol
    if (urlStr.startsWith('bookforge-audio:///')) {
      filePath = urlStr.substring('bookforge-audio:///'.length);
    } else if (urlStr.startsWith('bookforge-audio://')) {
      filePath = urlStr.substring('bookforge-audio://'.length);
    } else {
      filePath = urlStr.replace('bookforge-audio:', '');
    }

    filePath = decodeURIComponent(filePath);

    // Handle Windows paths
    if (process.platform === 'win32') {
      if (/^[a-zA-Z]\/[^:]/.test(filePath)) {
        filePath = filePath[0].toUpperCase() + ':' + filePath.substring(1);
      }
    }

    // On Mac/Linux, ensure absolute path starts with /
    if (process.platform !== 'win32' && !filePath.startsWith('/')) {
      filePath = '/' + filePath;
    }

    // Normalize to platform-specific separators
    filePath = filePath.split('/').join(path.sep);

    logToAll(`[Audio Protocol] Resolved path: ${filePath}`);

    try {
      // Get file stats for size and content-length
      const stats = fsSync.statSync(filePath);
      const fileSize = stats.size;

      // Determine content type based on extension
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'audio/mp4'; // Default for M4B/M4A
      if (ext === '.mp3') contentType = 'audio/mpeg';
      else if (ext === '.wav') contentType = 'audio/wav';
      else if (ext === '.flac') contentType = 'audio/flac';
      else if (ext === '.ogg') contentType = 'audio/ogg';

      // Parse Range header for partial content requests (seeking)
      const rangeHeader = request.headers.get('Range');
      let start = 0;
      let end = fileSize - 1;
      let statusCode = 200;

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (match) {
          start = match[1] ? parseInt(match[1], 10) : 0;
          end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
          statusCode = 206; // Partial Content
          console.log(`[Audio Protocol] Range request: ${start}-${end}/${fileSize}`);
        }
      }

      // Validate range
      if (start >= fileSize || end >= fileSize) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}` }
        });
      }

      const contentLength = end - start + 1;

      // Create a readable stream for the requested range
      const stream = fsSync.createReadStream(filePath, { start, end });

      // Convert Node.js stream to Web ReadableStream
      const webStream = new ReadableStream({
        start(controller) {
          stream.on('data', (chunk) => {
            controller.enqueue(new Uint8Array(Buffer.from(chunk)));
          });
          stream.on('end', () => {
            controller.close();
          });
          stream.on('error', (err) => {
            console.error('[Audio Protocol] Stream error:', err);
            controller.error(err);
          });
        },
        cancel() {
          stream.destroy();
        }
      });

      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(contentLength),
      };

      if (statusCode === 206) {
        headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
      }

      return new Response(webStream, { status: statusCode, headers });
    } catch (err) {
      console.error('[Audio Protocol] Failed to load audio:', filePath, err);
      return new Response('File not found', { status: 404 });
    }
  });
}

// Atomic file write - writes to temp file then renames to prevent corruption
// Uses temp file in same directory to avoid cross-device link issues
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  // Create temp file in the same directory as target to ensure same filesystem
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.bookforge-${Date.now()}-${Math.random().toString(36).substr(2)}.tmp`);

  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err: any) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

const isDev = !app.isPackaged;

// Root of the app code bundle — the directory that contains dist/ (and bookforge-icon.png).
// Derived from __dirname (dist/electron -> code root) instead of Electron's app.getAppPath()
// so the app self-locates when its code bundle is loaded from userData by the launcher (see
// the app-update-system design). In the current monolithic build this resolves identically to
// app.getAppPath() in both dev and packaged (asar) layouts.
const codeRoot = path.join(__dirname, '..', '..');

function createWindow(): void {
  // Get icon path - in dev it's in project root, in prod it's in app resources
  const iconPath = isDev
    ? path.join(__dirname, '..', '..', 'bookforge-icon.png')  // dist/electron -> project root
    : path.join(codeRoot, 'bookforge-icon.png');

  mainWindow = new BrowserWindow({
    width: 2100,
    height: 1350,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,  // Enable <webview> for article preview
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
  });

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }

  // Clear window title to prevent tooltip on macOS drag region
  mainWindow.setTitle(' ');

  // Prevent Backspace from triggering browser back navigation
  // The keydown event still reaches the renderer for Angular to handle
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Prevent all navigation except initial load
    // This stops Backspace from going "back" in history
    const currentUrl = mainWindow?.webContents.getURL() || '';
    if (url !== currentUrl && !url.startsWith('http://localhost:') && !url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  // Load Angular app
  if (isDev) {
    mainWindow.loadURL('http://localhost:4250');
    // mainWindow.webContents.openDevTools();  // Uncomment to debug
  } else {
    // Use codeRoot for reliable path resolution in packaged apps
    const appPath = codeRoot;
    const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');

    mainWindow.loadFile(indexPath).catch(err => {
      // Show error in window if file not found
      mainWindow?.loadURL(`data:text/html,
        <html><body style="background:#1a1a1a;color:#fff;font-family:system-ui;padding:40px;">
        <h1>Failed to load app</h1>
        <p>Error: ${err.message}</p>
        <p>App path: ${appPath}</p>
        <p>Index path: ${indexPath}</p>
        </body></html>`);
    });
  }

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomLevel(loadZoomLevel());
    // Confirm this code bundle booted healthily so the launcher won't roll it back next launch.
    // No-op when running without the launcher (dev, or current monolithic packaged build).
    markBootOk();

    // Background: check for a newer code bundle and stage it for the next launch. Only under the
    // packaged launcher (it's a no-op without a pointer). Failures are non-fatal.
    if (app.isPackaged) {
      checkAndStageCodeUpdate({
        onProgress: (s) => mainWindow?.webContents.send('update:code-status', s),
      }).catch((err) => console.warn('[update] code update check failed:', err));

      // Surface (don't auto-install) available updates for our managed binaries.
      checkComponentUpdates()
        .then((updates) => {
          if (updates.length) {
            console.log('[update] managed component updates available:', updates.map((u) => `${u.id} ${u.state}`).join(', '));
            mainWindow?.webContents.send('update:components-available', updates);
          }
        })
        .catch((err) => console.warn('[update] component update check failed:', err));
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupIpcHandlers(): void {
  // App self-update (code bundle). The launcher applies a staged update on next launch.
  ipcMain.handle('update:get-code-status', () => getCodeUpdateStatus());
  ipcMain.handle('update:check-code', () =>
    checkAndStageCodeUpdate({
      onProgress: (s) => mainWindow?.webContents.send('update:code-status', s),
    })
  );
  // Apply a staged update: relaunch so the launcher boots the pending version.
  ipcMain.handle('update:restart', () => {
    app.relaunch();
    app.quit();
  });
  // Managed binaries (ffmpeg, yt-dlp, …) — OUR server-hosted, watched components.
  ipcMain.handle('update:list-components', (_e, force?: boolean) => listManagedComponents(force));
  ipcMain.handle('update:install-component', (_e, id: string) =>
    installComponent(id, {
      onProgress: (s) => mainWindow?.webContents.send('update:component-status', s),
    })
  );

  // PDF Analyzer handlers — delegated to worker thread via pdf-worker-proxy.
  // Progress events are forwarded to event.sender automatically by the proxy.
  ipcMain.handle('pdf:analyze', async (event, pdfPath: string, maxPages?: number) => {
    try {
      const result = await pdfWorkerProxy.call('analyze', [pdfPath, maxPages], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:analyze-quick', async (event, pdfPath: string, maxPages?: number) => {
    try {
      const result = await pdfWorkerProxy.call('analyzeQuick', [pdfPath, maxPages], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:analyze-text', async (event, pdfPath: string, maxPages?: number) => {
    try {
      const result = await pdfWorkerProxy.call('analyzeText', [pdfPath, maxPages], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-page', async (event, pageNum: number, scale: number = 2.0, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>, removeBackground?: boolean) => {
    try {
      const image = await pdfWorkerProxy.call('renderPage', [pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground], event.sender);
      return { success: true, data: { image } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-blank-page', async (event, pageNum: number, scale: number = 2.0) => {
    try {
      const image = await pdfWorkerProxy.call('renderBlankPage', [pageNum, scale], event.sender);
      return { success: true, data: { image } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-all-pages', async (event, pdfPath: string, scale: number = 2.0, concurrency: number = 4) => {
    try {
      const paths = await pdfWorkerProxy.call('renderAllPagesToFiles', [pdfPath, scale, concurrency], event.sender);
      return { success: true, data: { paths } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:get-rendered-page-path', async (event, pageNum: number) => {
    try {
      const filePath = await pdfWorkerProxy.call('getRenderedPagePath', [pageNum], event.sender);
      return { success: true, data: { path: filePath } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:cleanup-temp-files', async () => {
    try {
      await pdfWorkerProxy.call('cleanupTempFiles', []);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-with-previews', async (event, pdfPath: string, concurrency: number = 4) => {
    try {
      const result = await pdfWorkerProxy.call('renderAllPagesWithPreviews', [pdfPath, concurrency], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-pages', async (event, pdfPath: string, pageNumbers: number[], quality: 'preview' | 'full' = 'preview') => {
    try {
      // Split across the render pool — each pool worker has its own mupdf
      // WASM instance, so the batch renders in parallel.
      const result = await pdfWorkerProxy.callRenderPages(pdfPath, pageNumbers, quality, event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:close-render-doc', async () => {
    try {
      // Every worker (main + render pool) holds its own cached doc handle
      await pdfWorkerProxy.broadcast('closeRenderDoc', []);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:close', async () => {
    try {
      await pdfWorkerProxy.broadcast('close', []);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:clear-cache', async (_event, fileHash: string) => {
    try {
      await pdfWorkerProxy.call('clearCache', [fileHash]);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:clear-all-cache', async () => {
    try {
      const result = await pdfWorkerProxy.call('clearAllCache', []);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:get-cache-size', async (_event, fileHash: string) => {
    try {
      const size = await pdfWorkerProxy.call('getCacheSize', [fileHash]);
      return { success: true, data: { size } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:get-total-cache-size', async () => {
    try {
      const size = await pdfWorkerProxy.call('getTotalCacheSize', []);
      return { success: true, data: { size } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-text', async (event, enabledCategories: string[]) => {
    try {
      const result = await pdfWorkerProxy.call('exportText', [enabledCategories], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Text-only EPUB export (uses pdftotext for PDFs, ebook-convert for EPUBs)
  ipcMain.handle('pdf:export-text-only-epub', async (_event, filePath: string, metadata?: { title?: string; author?: string }) => {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const fsLocal = require('fs').promises;
      const execAsync = promisify(exec);

      // Create temp directory for intermediate files
      const tempDir = await fsLocal.mkdtemp(path.join(os.tmpdir(), 'bookforge-epub-'));
      const tempTextFile = path.join(tempDir, 'extracted.txt');
      const tempEpubFile = path.join(tempDir, 'output.epub');

      // Detect file type
      const ext = path.extname(filePath).toLowerCase();
      const isEpub = ext === '.epub';

      // Find ebook-convert using cross-platform discovery
      const ebookConvertPath = await findEbookConvert();
      if (!ebookConvertPath) {
        throw new Error('Calibre ebook-convert not found. Please install Calibre from https://calibre-ebook.com');
      }

      try {
        // Step 1: Extract text based on file type
        if (isEpub) {
          // For EPUB: use ebook-convert to extract text
          console.log('[Text-only EPUB] Extracting text from EPUB...');
          await execAsync(`"${ebookConvertPath}" "${filePath}" "${tempTextFile}"`);
        } else {
          // For PDF: use pdftotext
          console.log('[Text-only EPUB] Extracting text from PDF...');
          const pdftotextPath = await findPdftotext();
          if (!pdftotextPath) {
            throw new Error('pdftotext not found. Please install poppler-utils (Linux/Mac) or poppler (Windows via scoop/chocolatey).');
          }
          await execAsync(`"${pdftotextPath}" -layout "${filePath}" "${tempTextFile}"`);
        }

        // Check if text was extracted
        const stats = await fsLocal.stat(tempTextFile);
        if (stats.size === 0) {
          throw new Error(`No text extracted from ${isEpub ? 'EPUB' : 'PDF'}`);
        }

        // Step 2: Convert text to EPUB using ebook-convert
        console.log('[Text-only EPUB] Converting to EPUB...');
        let convertCmd = `"${ebookConvertPath}" "${tempTextFile}" "${tempEpubFile}"`;

        // Add metadata if provided (escape shell metacharacters for safe interpolation)
        const escapeShellMeta = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        if (metadata?.title) {
          convertCmd += ` --title "${escapeShellMeta(metadata.title)}"`;
        }
        if (metadata?.author) {
          convertCmd += ` --authors "${escapeShellMeta(metadata.author)}"`;
        }

        // Add formatting options
        convertCmd += ' --formatting-type=markdown --paragraph-type=auto --page-breaks-before="/"';

        await execAsync(convertCmd);

        // Step 3: Read the EPUB file and return as base64
        const epubBuffer = await fsLocal.readFile(tempEpubFile);
        const epubBase64 = epubBuffer.toString('base64');

        // Clean up temp files
        await fsLocal.unlink(tempTextFile).catch(() => {});
        await fsLocal.unlink(tempEpubFile).catch(() => {});
        await fsLocal.rmdir(tempDir).catch(() => {});

        return { success: true, data: epubBase64 };
      } catch (error) {
        // Clean up on error
        await fsLocal.unlink(tempTextFile).catch(() => {});
        await fsLocal.unlink(tempEpubFile).catch(() => {});
        await fsLocal.rmdir(tempDir).catch(() => {});
        throw error;
      }
    } catch (err) {
      console.error('[Text-only EPUB] Export failed:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-pdf', async (event, pdfPath: string, deletedRegions: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>, ocrBlocks?: Array<{page: number; x: number; y: number; width: number; height: number; text: string; font_size: number}>, deletedPages?: number[], chapters?: Array<{title: string; page: number; level: number}>) => {
    try {
      const pdfBase64 = await pdfWorkerProxy.call('exportPdf', [pdfPath, deletedRegions, ocrBlocks, deletedPages, chapters], event.sender);
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-pdf-no-backgrounds', async (event, scale: number = 2.0, deletedRegions?: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>, ocrBlocks?: Array<{page: number; x: number; y: number; width: number; height: number; text: string; font_size: number}>, deletedPages?: number[]) => {
    try {
      const pdfBase64 = await pdfWorkerProxy.call('exportPdfWithBackgroundsRemoved', [scale, deletedRegions, ocrBlocks, deletedPages], event.sender);
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-pdf-wysiwyg', async (event, deletedRegions?: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>, deletedPages?: number[], scale: number = 2.0, ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>) => {
    try {
      const pdfBase64 = await pdfWorkerProxy.call('exportPdfWysiwyg', [deletedRegions, deletedPages, scale, ocrPages], event.sender);
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-similar', async (event, blockId: string) => {
    try {
      const result = await pdfWorkerProxy.call('findSimilar', [blockId], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-spans-in-rect', async (event, page: number, x: number, y: number, width: number, height: number) => {
    try {
      const spans = await pdfWorkerProxy.call('findSpansInRect', [page, x, y, width, height], event.sender);
      return { success: true, data: spans };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:analyze-samples', async (event, sampleSpans: any[]) => {
    try {
      const pattern = await pdfWorkerProxy.call('analyzesamples', [sampleSpans], event.sender);
      return { success: true, data: pattern };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-matching-spans', async (event, pattern: any) => {
    try {
      const matches = await pdfWorkerProxy.call('findMatchingSpans', [pattern], event.sender);
      return { success: true, data: matches };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-spans-by-regex', async (event, pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) => {
    try {
      const matches = await pdfWorkerProxy.call('findSpansByRegex', [pattern, minFontSize, maxFontSize, minBaseline, maxBaseline, caseSensitive], event.sender);
      return { success: true, data: matches };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:get-spans', async (event) => {
    try {
      const spans = await pdfWorkerProxy.call('getSpans', [], event.sender);
      return { success: true, data: spans };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:get-spans-for-block', async (event, blockId: string) => {
    try {
      const spans = await pdfWorkerProxy.call('getSpans', [], event.sender);
      if (!spans || spans.length === 0) {
        console.warn('[pdf:get-spans-for-block] No spans available (worker may have been recycled)');
        return { success: true, data: [] };
      }
      const blockSpans = (spans as any[]).filter((s: any) => s.block_id === blockId);
      if (blockSpans.length === 0) {
        // Log a sample of block_ids to help diagnose mismatches
        const sampleIds = [...new Set((spans as any[]).slice(0, 20).map((s: any) => s.block_id))];
        console.warn(`[pdf:get-spans-for-block] No spans match block_id="${blockId}". Total spans: ${spans.length}. Sample block_ids:`, sampleIds);
      }
      return { success: true, data: blockSpans };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:update-spans-for-ocr', async (event, pageNum: number, ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>) => {
    try {
      await pdfWorkerProxy.call('updateSpansForOcrPage', [pageNum, ocrBlocks], event.sender);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:extract-outline', async (event) => {
    try {
      const outline = await pdfWorkerProxy.call('extractOutline', [], event.sender);
      return { success: true, data: outline };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:outline-to-chapters', async (event, outline: any[], deletedPages?: number[]) => {
    try {
      const chapters = await pdfWorkerProxy.call('outlineToChapters', [outline, deletedPages], event.sender);
      return { success: true, data: chapters };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:detect-chapters', async (event, deletedPages?: number[]) => {
    try {
      const chapters = await pdfWorkerProxy.call('detectChaptersHeuristic', [deletedPages], event.sender);
      return { success: true, data: chapters };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:detect-chapters-from-examples', async (event, exampleBlockIds: string[], deletedPages?: number[]) => {
    try {
      const chapters = await pdfWorkerProxy.call('detectChaptersFromExamples', [exampleBlockIds, deletedPages], event.sender);
      return { success: true, data: chapters };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:map-toc-entries', async (event, tocBlockIds: string[], deletedPages?: number[]) => {
    try {
      const result = await pdfWorkerProxy.call('mapTocEntriesToChapters', [tocBlockIds, deletedPages], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:split-toc-blocks', async (event, tocBlockIds: string[]) => {
    try {
      const lines = await pdfWorkerProxy.call('splitTocBlocks', [tocBlockIds], event.sender);
      return { success: true, data: lines };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:map-titles-to-chapters', async (event, titles: string[], tocPages: number[], deletedPages?: number[]) => {
    try {
      const result = await pdfWorkerProxy.call('mapTitlesToChapters', [titles, tocPages, deletedPages], event.sender);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:add-bookmarks', async (event, pdfBase64: string, chapters: any[]) => {
    try {
      const base64Result = await pdfWorkerProxy.call('addBookmarksToPdf', [pdfBase64, chapters], event.sender);
      return { success: true, data: base64Result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:assemble-from-images', async (event, pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>, chapters?: any[]) => {
    try {
      const result = await pdfWorkerProxy.call('assembleFromImages', [pages, chapters], event.sender);
      return result;
    } catch (err) {
      console.error('[pdf:assemble-from-images] Error:', err);
      return null;
    }
  });

  // File system handlers
  ipcMain.handle('fs:browse', async (_event, dirPath: string) => {
    const fs = await import('fs/promises');
    dirPath = normalizeFsPath(dirPath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const items = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // Skip Syncthing conflict files
      if (entry.name.includes('.sync-conflict-')) continue;

      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();

      let size = null;
      if (!isDir) {
        const stat = await fs.stat(fullPath);
        size = stat.size;
      }
      items.push({
        name: entry.name,
        path: fullPath,
        type: isDir ? 'directory' : 'file',
        size,
      });
    }

    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      path: dirPath,
      parent: path.dirname(dirPath),
      items: items.slice(0, 100),
    };
  });

  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    const fs = await import('fs/promises');
    try {
      await fs.access(normalizeFsPath(filePath));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:batch-exists', async (_event, filePaths: string[]) => {
    const fs = await import('fs/promises');
    const results: Record<string, boolean> = {};
    await Promise.all(filePaths.map(async (original) => {
      const p = normalizeFsPath(original);
      try {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          // Empty directories don't count as "existing" for stage detection
          const entries = await fs.readdir(p);
          results[original] = entries.length > 0;
        } else {
          results[original] = true;
        }
      } catch {
        results[original] = false;
      }
    }));
    return results;
  });

  ipcMain.handle('fs:batch-stat', async (_event, filePaths: string[]) => {
    const fs = await import('fs/promises');
    const results: Record<string, { mtimeMs: number } | null> = {};
    await Promise.all(filePaths.map(async (original) => {
      const p = normalizeFsPath(original);
      try {
        const stat = await fs.stat(p);
        results[original] = { mtimeMs: stat.mtimeMs };
      } catch {
        results[original] = null;
      }
    }));
    return results;
  });

  ipcMain.handle('fs:write-text', async (_event, filePath: string, content: string) => {
    const fs = await import('fs/promises');
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:delete-file', async (_event, filePath: string) => {
    const fs = await import('fs/promises');
    try {
      await fs.unlink(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:delete-directory', async (_event, dirPath: string) => {
    const fs = await import('fs/promises');
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // List files in a directory
  ipcMain.handle('fs:list-directory', async (_event, dirPath: string): Promise<string[]> => {
    const fsPromises = await import('fs/promises');
    try {
      const entries = await fsPromises.readdir(dirPath);
      return entries;
    } catch {
      return [];
    }
  });

  // Read audio file and return as data URL (for playback in renderer)
  // For large files (>100MB), returns a streaming URL via BookshelfServer instead
  ipcMain.handle('fs:read-audio', async (_event, audioPath: string) => {
    try {
      console.log('[fs:read-audio] Loading:', audioPath);

      // Check file size first
      const stats = await fs.stat(audioPath);
      const MAX_SIZE_FOR_BASE64 = 100 * 1024 * 1024; // 100MB - base64 inflates ~33%, V8 string limit is 512MB

      const ext = audioPath.toLowerCase().split('.').pop();
      const mimeType = ext === 'm4b' || ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';

      if (stats.size > MAX_SIZE_FOR_BASE64) {
        // For large files, use the bookforge-audio:// custom protocol for streaming
        // Normalize to forward slashes for URL path
        const normalizedPath = audioPath.replace(/\\/g, '/');
        const streamUrl = `bookforge-audio:///${normalizedPath}`;
        console.log(`[fs:read-audio] File too large (${stats.size} bytes), using streaming protocol`);
        return { success: true, dataUrl: streamUrl, size: stats.size, isStreamUrl: true };
      }

      // For smaller files, load and convert to base64
      const buffer = await fs.readFile(audioPath);
      const base64 = buffer.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;
      console.log(`[fs:read-audio] Loaded ${buffer.length} bytes`);
      return { success: true, dataUrl, size: buffer.length };
    } catch (err) {
      console.error('[fs:read-audio] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:read-text', async (_event, filePath: string) => {
    const fs = await import('fs/promises');
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:write-temp-file', async (_event, filename: string, data: Uint8Array | number[] | { [key: string]: number }) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    try {
      const tempDir = path.join(os.tmpdir(), 'bookforge-covers');
      await fs.mkdir(tempDir, { recursive: true });
      const filePath = path.join(tempDir, filename);

      // Handle different data formats from IPC serialization
      let buffer: Buffer;
      if (Buffer.isBuffer(data)) {
        buffer = data;
      } else if (data instanceof Uint8Array) {
        buffer = Buffer.from(data);
      } else if (Array.isArray(data)) {
        buffer = Buffer.from(data);
      } else if (typeof data === 'object') {
        // IPC might serialize Uint8Array as { 0: byte, 1: byte, ... }
        const values = Object.values(data) as number[];
        buffer = Buffer.from(values);
      } else {
        throw new Error('Invalid data format');
      }

      console.log('[MAIN] Writing temp file:', filePath, 'size:', buffer.length);
      await fs.writeFile(filePath, buffer);
      console.log('[MAIN] Temp file written successfully');

      // Also return base64 data URL for display (renderer can't load file:// URLs)
      const ext = path.extname(filename).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;

      return { success: true, path: filePath, dataUrl };
    } catch (err) {
      console.error('[MAIN] Error writing temp file:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:generate-unique-filename', async (_event, originalPath: string, suffix: string) => {
    try {
      const dir = path.dirname(originalPath);
      const ext = path.extname(originalPath);
      const base = path.basename(originalPath, ext);
      let candidate = path.join(dir, `${base} (${suffix})${ext}`);
      let counter = 2;
      while (fsSync.existsSync(candidate)) {
        candidate = path.join(dir, `${base} (${suffix} ${counter})${ext}`);
        counter++;
      }
      return { success: true, data: { path: candidate } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Project file handlers
  ipcMain.handle('project:save', async (_event, projectData: unknown, suggestedName?: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save BookForge Project',
      defaultPath: suggestedName || 'untitled.bfp',
      filters: [
        { name: 'BookForge Project', extensions: ['bfp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    try {
      // Extract any embedded images to external files
      await extractEmbeddedImages(projectData as Record<string, unknown>);

      await atomicWriteFile(result.filePath, JSON.stringify(projectData, null, 2));
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('project:load', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open BookForge Project',
      filters: [
        { name: 'BookForge Project', extensions: ['bfp'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    try {
      const content = await fs.readFile(result.filePaths[0], 'utf-8');
      const data = JSON.parse(content);
      return { success: true, data, filePath: result.filePaths[0] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Save to specific path (for "Save" vs "Save As")
  // IMPORTANT: This merges with existing data to preserve fields like 'audiobook' that the editor doesn't manage
  ipcMain.handle('project:save-to-path', async (_event, filePath: string, projectData: unknown) => {
    try {
      let mergedData = projectData as Record<string, unknown>;

      // Check if filePath is a manifest project directory
      const isDir = fsSync.existsSync(filePath) && fsSync.statSync(filePath).isDirectory();
      if (isDir) {
        // Save editor state back to manifest.json
        const manifestPath = path.join(filePath, 'manifest.json');
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);

        // Update manifest with editor state
        if (!manifest.source) manifest.source = {};
        manifest.source.deletedBlockIds = mergedData.deleted_block_ids || [];
        manifest.source.deletedHighlightIds = mergedData.deleted_highlight_ids || [];
        manifest.source.pageOrder = mergedData.page_order || [];
        manifest.source.deletedPages = mergedData.deleted_pages || [];
        manifest.source.removeBackgrounds = mergedData.remove_backgrounds || false;

        if (!manifest.editor) manifest.editor = {};
        manifest.editor.undoStack = mergedData.undo_stack || [];
        manifest.editor.redoStack = mergedData.redo_stack || [];
        manifest.editor.blockEdits = mergedData.block_edits || undefined;
        manifest.editor.customCategories = mergedData.custom_categories || undefined;
        manifest.editor.ocrBlocks = mergedData.ocr_blocks || undefined;
        manifest.editor.ocrCategories = mergedData.ocr_categories || undefined;
        manifest.editor.categoryCorrections = mergedData.category_corrections || undefined;
        manifest.editor.learnedCategories = mergedData.learned_categories || undefined;
        manifest.editor.paragraphBreaks = mergedData.paragraph_breaks || undefined;

        // Chapters
        manifest.chapters = mergedData.chapters || [];
        manifest.chaptersSource = mergedData.chapters_source || 'manual';

        // Metadata from editor (title, author, etc.)
        if (mergedData.metadata) {
          if (!manifest.metadata) manifest.metadata = {};
          const meta = mergedData.metadata as Record<string, unknown>;
          if (meta.title !== undefined) manifest.metadata.title = meta.title;
          if (meta.author !== undefined) manifest.metadata.author = meta.author;
          if (meta.year !== undefined) manifest.metadata.year = meta.year;
          if (meta.language !== undefined) manifest.metadata.language = meta.language;
        }

        manifest.modifiedAt = new Date().toISOString();

        const catCount = Array.isArray(mergedData.category_corrections) ? mergedData.category_corrections.length : 0;
        const learnedCount = Array.isArray(mergedData.learned_categories) ? mergedData.learned_categories.length : 0;
        const paraCount = Array.isArray(mergedData.paragraph_breaks) ? mergedData.paragraph_breaks.length : 0;
        if (catCount > 0 || learnedCount > 0 || paraCount > 0) {
          console.log(`[project:save] Writing to manifest: ${catCount} corrections, ${learnedCount} learned, ${paraCount} paragraph breaks`);
        }

        await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
        return { success: true, filePath };
      }

      // Legacy BFP file save
      // If BFP file exists, merge with existing data to preserve fields we don't manage
      if (filePath.endsWith('.bfp') && fsSync.existsSync(filePath)) {
        const stat = await fs.stat(filePath);

        // Only backup if file has meaningful content (>500 bytes = has edits/chapters)
        if (stat.size > 500) {
          const backupPath = filePath + '.bak';
          await fs.copyFile(filePath, backupPath);
          console.log(`[project:save-to-path] Created backup: ${backupPath}`);
        }

        // Load existing data and merge to preserve fields like 'audiobook', 'metadata', etc.
        try {
          const existingContent = await fs.readFile(filePath, 'utf-8');
          const existingData = JSON.parse(existingContent) as Record<string, unknown>;

          // Fields that should be preserved from existing file if not in new data
          const preserveFields = ['audiobook', 'audiobookFolder'];

          for (const field of preserveFields) {
            if (existingData[field] !== undefined && mergedData[field] === undefined) {
              mergedData[field] = existingData[field];
              console.log(`[project:save-to-path] Preserved field: ${field}`);
            }
          }

          // Keep original created_at if it exists
          if (existingData.created_at) {
            mergedData.created_at = existingData.created_at;
          }
        } catch (parseErr) {
          console.warn(`[project:save-to-path] Could not parse existing file for merge:`, parseErr);
        }
      }

      // Extract any embedded images to external files
      await extractEmbeddedImages(mergedData);

      await atomicWriteFile(filePath, JSON.stringify(mergedData, null, 2));
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Update just the metadata in a BFP file or manifest project (for audiobook producer)
  ipcMain.handle('project:update-metadata', async (_event, bfpPath: string, metadata: unknown) => {
    try {
      const meta = metadata as Record<string, unknown>;

      // Handle cover image - save to media folder if it's base64 data
      if (meta.coverData && typeof meta.coverData === 'string' && meta.coverData.startsWith('data:')) {
        const relativePath = await saveImageToMedia(meta.coverData as string, 'cover');
        meta.coverImagePath = relativePath;
        delete meta.coverData;
      }

      // Check if bfpPath is a manifest project directory
      const isDir = fsSync.existsSync(bfpPath) && fsSync.statSync(bfpPath).isDirectory();
      if (isDir) {
        const manifestPath = path.join(bfpPath, 'manifest.json');
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);

        // Map BFP metadata fields to manifest metadata fields
        if (!manifest.metadata) manifest.metadata = {};
        if (meta.title !== undefined) manifest.metadata.title = meta.title;
        if (meta.author !== undefined) manifest.metadata.author = meta.author;
        if (meta.year !== undefined) manifest.metadata.year = meta.year;
        if (meta.language !== undefined) manifest.metadata.language = meta.language;
        if (meta.narrator !== undefined) manifest.metadata.narrator = meta.narrator;
        if (meta.series !== undefined) manifest.metadata.series = meta.series;
        if (meta.description !== undefined) manifest.metadata.description = meta.description;
        if (meta.contributors !== undefined) manifest.metadata.contributors = meta.contributors;
        if (meta.tags !== undefined) manifest.metadata.tags = meta.tags;
        if (meta.coverImagePath !== undefined) manifest.metadata.coverPath = meta.coverImagePath;

        // Output filename: the renderer sends the effective name (live-generated or
        // a manual override). Use it when provided; otherwise derive from metadata.
        if (typeof meta.outputFilename === 'string' && meta.outputFilename.trim()) {
          manifest.metadata.outputFilename = meta.outputFilename.trim();
        } else {
          manifest.metadata.outputFilename = manifestService.computeDescriptiveFilename({
            title: manifest.metadata.title,
            author: manifest.metadata.author,
            authorFileAs: manifest.metadata.authorFileAs,
            year: manifest.metadata.year,
          }, '.m4b');
        }

        manifest.modifiedAt = new Date().toISOString();
        await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));

        // Build list of all project EPUBs (used for both cover and metadata propagation)
        const epubCandidates = [
          path.join(bfpPath, 'source', 'exported.epub'),
          path.join(bfpPath, 'source', 'original.epub'),
          path.join(bfpPath, 'stages', '01-cleanup', 'cleaned.epub'),
          path.join(bfpPath, 'stages', '01-cleanup', 'simplified.epub'),
          path.join(bfpPath, 'stages', '02-translate', 'translated.epub'),
        ];
        // Also scan for language EPUBs (e.g., de.epub, ko.epub) in translate dir
        const translateDir = path.join(bfpPath, 'stages', '02-translate');
        if (fsSync.existsSync(translateDir)) {
          try {
            const translateFiles = await fs.readdir(translateDir);
            for (const f of translateFiles) {
              if (f.endsWith('.epub') && f !== 'translated.epub') {
                epubCandidates.push(path.join(translateDir, f));
              }
            }
          } catch { /* ignore */ }
        }

        // Propagate cover to all project EPUBs when a cover is set
        if (meta.coverImagePath && typeof meta.coverImagePath === 'string') {
          const absCoverPath = path.join(getLibraryRoot(), meta.coverImagePath as string);
          if (fsSync.existsSync(absCoverPath)) {
            const { embedCoverInEpub } = await import('./epub-processor.js');
            for (const epubPath of epubCandidates) {
              if (fsSync.existsSync(epubPath)) {
                try {
                  await embedCoverInEpub(epubPath, absCoverPath);
                  console.log(`[project:update-metadata] Embedded cover in ${epubPath}`);
                } catch (embedErr) {
                  console.warn(`[project:update-metadata] Failed to embed cover in ${epubPath}:`, embedErr);
                }
              }
            }
          }
        }

        // Propagate metadata (title/author/year/language) to all project EPUBs
        const hasMetadataChange = meta.title !== undefined || meta.author !== undefined
          || meta.year !== undefined || meta.language !== undefined
          || meta.contributors !== undefined;
        if (hasMetadataChange) {
          const { updateEpubMetadataStandalone } = await import('./epub-processor.js');
          const epubMeta: Record<string, unknown> = {};
          if (meta.title !== undefined) epubMeta.title = meta.title;
          if (meta.author !== undefined) epubMeta.author = meta.author;
          if (meta.year !== undefined) epubMeta.year = meta.year;
          if (meta.language !== undefined) epubMeta.language = meta.language;
          if (meta.contributors !== undefined) epubMeta.contributors = meta.contributors;

          for (const epubPath of epubCandidates) {
            if (fsSync.existsSync(epubPath)) {
              try {
                await updateEpubMetadataStandalone(epubPath, epubMeta as any);
                console.log(`[project:update-metadata] Updated EPUB metadata in ${path.basename(epubPath)}`);
              } catch (epubErr) {
                console.warn(`[project:update-metadata] Failed to update EPUB metadata in ${epubPath}:`, epubErr);
              }
            }
          }
        }

        // Update M4B metadata if output exists
        const outputDir = path.join(bfpPath, 'output');
        if (fsSync.existsSync(outputDir)) {
          try {
            const outputFiles = await fs.readdir(outputDir);
            const m4bFiles = outputFiles.filter(f => f.toLowerCase().endsWith('.m4b'));

            for (const m4bFile of m4bFiles) {
              const m4bPath = path.join(outputDir, m4bFile);

              // Apply updated metadata tags to M4B
              if (hasMetadataChange || meta.narrator !== undefined || meta.series !== undefined) {
                try {
                  const m4bMeta: Record<string, unknown> = {};
                  if (meta.title !== undefined) m4bMeta.title = meta.title;
                  if (meta.author !== undefined) m4bMeta.author = meta.author;
                  if (meta.year !== undefined) m4bMeta.year = meta.year;
                  if (meta.narrator !== undefined) m4bMeta.narrator = meta.narrator;
                  if (meta.series !== undefined) m4bMeta.series = meta.series;
                  if (meta.contributors !== undefined) m4bMeta.contributors = meta.contributors;
                  await applyMetadata(m4bPath, m4bMeta as any);
                  console.log(`[project:update-metadata] Updated M4B metadata in ${m4bFile}`);
                } catch (m4bErr) {
                  console.warn(`[project:update-metadata] Failed to update M4B metadata in ${m4bFile}:`, m4bErr);
                }
              }

              // Rename M4B file if outputFilename changed or title/author changed
              const desiredFilename = meta.outputFilename
                ? (String(meta.outputFilename).endsWith('.m4b') ? String(meta.outputFilename) : `${meta.outputFilename}.m4b`)
                : (meta.title || meta.author)
                  ? `${meta.title || manifest.metadata.title || 'Audiobook'} - ${meta.author || manifest.metadata.author || 'Unknown'}.m4b`
                  : null;

              if (desiredFilename) {
                const sanitized = desiredFilename.replace(/[<>:"/\\|?*]/g, '_');
                const newM4bPath = path.join(outputDir, sanitized);
                if (newM4bPath !== m4bPath) {
                  try {
                    await fs.rename(m4bPath, newM4bPath);
                    console.log(`[project:update-metadata] Renamed M4B: ${m4bFile} → ${sanitized}`);
                  } catch (renameErr) {
                    console.warn(`[project:update-metadata] Failed to rename M4B:`, renameErr);
                  }
                }
              }
            }
          } catch { /* output dir read failed, skip */ }
        }

        // Rename project folder if title/author/year changed
        let newBfpPath: string | undefined;
        if (meta.title !== undefined || meta.author !== undefined || meta.year !== undefined) {
          const { renameProjectFolder, computeProjectSlug } = await import('./manifest-service.js');
          const newSlug = computeProjectSlug(
            (meta.title as string) || manifest.metadata.title || 'Untitled',
            (meta.author as string) || manifest.metadata.author || 'Unknown',
            (meta.year as string | undefined) || manifest.metadata.year
          );
          const currentSlug = path.basename(bfpPath);
          if (newSlug !== currentSlug) {
            try {
              newBfpPath = await renameProjectFolder(bfpPath, newSlug);
              console.log(`[project:update-metadata] Renamed project folder → ${path.basename(newBfpPath)}`);
            } catch (renameErr) {
              console.warn(`[project:update-metadata] Failed to rename project folder:`, renameErr);
            }
          }
        }

        // Invalidate bookshelf server cache so changes appear immediately
        const projectSlug = path.basename(newBfpPath || bfpPath);
        bookshelfServer.invalidateCache(projectSlug);

        return { success: true, newBfpPath };
      }

      // Legacy BFP file
      const content = await fs.readFile(bfpPath, 'utf-8');
      const project = JSON.parse(content);

      // Merge metadata
      project.metadata = { ...project.metadata, ...meta };
      project.modified_at = new Date().toISOString();

      // Write back
      await atomicWriteFile(bfpPath, JSON.stringify(project, null, 2));
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Open PDF file using native dialog
  ipcMain.handle('dialog:open-pdf', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    // Calibre (optional) is what converts the exotic input formats to EPUB.
    // When it isn't installed, only offer formats BookForge handles natively so
    // the picker never presents a file we can't actually open.
    const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
    const calibreAvailable = await ebookConvertBridge.isAvailable();
    const filters = calibreAvailable
      ? [
          { name: 'Ebooks', extensions: ['pdf', 'epub', 'jwpub', 'azw3', 'azw', 'mobi', 'kfx', 'prc', 'fb2'] },
          { name: 'Documents', extensions: ['docx', 'odt', 'rtf', 'txt', 'html', 'htm'] },
          { name: 'All Files', extensions: ['*'] },
        ]
      : [
          { name: 'Ebooks', extensions: ['pdf', 'epub', 'jwpub'] },
          { name: 'All Files', extensions: ['*'] },
        ];

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Document',
      filters,
      properties: ['openFile', 'multiSelections']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    // Return both single (backward compat) and multi-file results
    return { success: true, filePath: result.filePaths[0], filePaths: result.filePaths };
  });

  // Open audio file picker dialog
  ipcMain.handle('dialog:open-audio', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Audio File',
      filters: [
        { name: 'Audio Files', extensions: ['m4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'aac'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePaths[0] };
  });

  // Open folder picker dialog
  ipcMain.handle('dialog:open-folder', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Folder',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, folderPath: result.filePaths[0] };
  });

  ipcMain.handle('dialog:save-epub', async (_event, defaultName?: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export EPUB',
      defaultPath: defaultName || 'book.epub',
      filters: [
        { name: 'EPUB', extensions: ['epub'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePath };
  });

  ipcMain.handle('dialog:save-text', async (_event, defaultName?: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Text',
      defaultPath: defaultName || 'export.txt',
      filters: [
        { name: 'Text', extensions: ['txt'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePath };
  });

  ipcMain.handle('dialog:save-m4b', async (_event, defaultName?: string, defaultDir?: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export M4B',
      defaultPath: defaultDir ? path.join(defaultDir, defaultName || 'audiobook.m4b') : (defaultName || 'audiobook.m4b'),
      filters: [
        { name: 'M4B Audiobook', extensions: ['m4b'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePath };
  });

  ipcMain.handle('audiobook:copy-to-path', async (_event, source: string, dest: string) => {
    try {
      await fs.copyFile(source, dest);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Native confirmation dialog
  ipcMain.handle('dialog:confirm', async (_event, options: {
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  }) => {
    if (!mainWindow) return { confirmed: false };

    const result = await dialog.showMessageBox(mainWindow, {
      type: options.type || 'question',
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [options.cancelLabel || 'Cancel', options.confirmLabel || 'OK'],
      defaultId: 1,
      cancelId: 0
    });

    return { confirmed: result.response === 1 };
  });

  // Native single-button message box — the app's replacement for window.alert().
  ipcMain.handle('dialog:message', async (_event, options: {
    title?: string;
    message: string;
    detail?: string;
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  }) => {
    if (!mainWindow) return;
    await dialog.showMessageBox(mainWindow, {
      type: options.type || 'info',
      title: options.title || 'BookForge',
      message: options.message,
      detail: options.detail,
      buttons: ['OK'],
      defaultId: 0,
    });
  });

  // Path to the bundled default book (public-domain "The Mysterious Stranger"),
  // seeded into the library on first run. null if it isn't shipped (dev without
  // the file, or stripped builds).
  ipcMain.handle('app:seed-book-path', () => {
    const candidates = [
      path.join((process as { resourcesPath?: string }).resourcesPath || '', 'seed-books', 'the-mysterious-stranger.epub'),
      path.join(__dirname, '..', '..', 'packaging', 'seed-books', 'the-mysterious-stranger.epub'),
    ];
    for (const p of candidates) {
      try { if (fsSync.existsSync(p)) return p; } catch { /* try next */ }
    }
    return null;
  });

  // Starter library — the finished public-domain sample downloaded ONCE into a brand-new, EMPTY
  // library on first run. Always operates on the current persisted library root; never overwrites
  // an existing library (the installer hard-guards on emptiness).
  ipcMain.handle('starter-library:status', async () => {
    return getStarterStatus(getLibraryRoot());
  });

  ipcMain.handle('starter-library:install', async () => {
    return installStarterLibrary(getLibraryRoot(), {
      onProgress: (s) => mainWindow?.webContents.send('starter-library:progress', s),
    });
  });

  // Remove ALL of BookForge's data — everything it downloaded/unpacked into the
  // per-user userData dir (the audiobook engine, voice & AI models, language
  // packs, GPU components, caches, settings). The user's library/books live in
  // Documents\BookForge (outside userData) and are deliberately left untouched.
  // The OS can't let an app delete itself, so the renderer then tells the user
  // to drag the app to the Trash (mac) / run the uninstaller (win).
  ipcMain.handle('app:remove-all-data', async () => {
    // Stop the streaming engine first so the bundled env isn't locked.
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      await xttsWorkerPool.endSession();
    } catch { /* engine wasn't running */ }

    const dirSizeBytes = (p: string): number => {
      let total = 0;
      let stat: fsSync.Stats;
      try { stat = fsSync.lstatSync(p); } catch { return 0; }
      if (stat.isSymbolicLink()) return 0;        // don't follow/double-count HF blob links
      if (stat.isFile()) return stat.size;
      if (stat.isDirectory()) {
        let entries: string[] = [];
        try { entries = fsSync.readdirSync(p); } catch { return total; }
        for (const e of entries) total += dirSizeBytes(path.join(p, e));
      }
      return total;
    };

    const userData = app.getPath('userData');
    let freedBytes = 0;
    let entries: string[] = [];
    try { entries = fsSync.readdirSync(userData); } catch { /* nothing there */ }
    for (const entry of entries) {
      const p = path.join(userData, entry);
      try {
        freedBytes += dirSizeBytes(p);
        fsSync.rmSync(p, { recursive: true, force: true });
      } catch { /* in-use file (logs/leveldb) — best effort; uninstaller mops up */ }
    }

    // Clean up locations OUTSIDE userData: the macOS logs dir (convention puts it
    // in ~/Library/Logs, not Application Support), updater caches, and any
    // PRE-NORMALIZATION dirs left by an upgrade (old "bookforge-app" userData and
    // "BookForgeApp" logs). On Windows the logs now live inside userData, so the
    // loop above already removed them.
    const extras: string[] = [];
    if (process.platform === 'win32') {
      extras.push(path.join(app.getPath('appData'), 'BookForgeApp'));   // old logs dir
      extras.push(path.join(app.getPath('appData'), 'bookforge-app'));  // old userData
      if (process.env.LOCALAPPDATA) {
        extras.push(path.join(process.env.LOCALAPPDATA, 'bookforge-app'));
        extras.push(path.join(process.env.LOCALAPPDATA, 'BookForge-updater'));
      }
    } else if (process.platform === 'darwin') {
      const home = app.getPath('home');
      extras.push(path.join(home, 'Library', 'Logs', 'BookForge'));
      extras.push(path.join(home, 'Library', 'Logs', 'BookForgeApp')); // old logs
      // Old pre-normalization userData (named after package "bookforge-app"), now
      // orphaned by app.setName('BookForge') — same cleanup Windows does.
      extras.push(path.join(app.getPath('appData'), 'bookforge-app'));
      extras.push(path.join(home, 'Library', 'Caches', 'BookForge-updater'));
    }
    for (const p of extras) {
      try {
        freedBytes += dirSizeBytes(p);
        fsSync.rmSync(p, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    return { ok: true, freedBytes, userData, platform: process.platform };
  });

  // Projects folder management
  // Library folder structure - uses module-level getLibraryRoot()

  // IPC handler to set custom library root (uses module-level customLibraryRoot)
  ipcMain.handle('library:set-root', async (_event, libraryPath: string | null) => {
    console.log('[library:set-root] Setting library root to:', libraryPath);

    // Validate path exists if provided
    if (libraryPath) {
      try {
        await fs.access(libraryPath);
      } catch {
        console.error('[library:set-root] Path does not exist:', libraryPath);
        return { success: false, error: `Path does not exist: ${libraryPath}` };
      }
    }

    customLibraryRoot = libraryPath;
    persistLibraryRoot(libraryPath);
    applyE2aScratchDir();
    // Sync to manifest service
    manifestService.setLibraryBasePath(libraryPath);
    // The bookshelf server resolves the library root dynamically but caches its
    // scanned book/ebook lists — drop those so it serves the new library on the
    // next request instead of the previous location.
    bookshelfServer.invalidateCache();
    // Now that a library location is set, begin the first-run "update": download +
    // install the mandatory runtime components (env + default voice + English pack)
    // in the background. Idempotent — a no-op once installed; skipped when the
    // library is being cleared (null).
    if (libraryPath) void startRuntimeSetup();
    return { success: true };
  });

  // IPC handler to get current library root
  ipcMain.handle('library:get-root', async () => {
    return { path: getLibraryRoot() };
  });

  const getProjectsFolder = () => path.join(getLibraryRoot(), 'projects');
  const getFilesFolder = () => path.join(getLibraryRoot(), 'files');
  const getMediaFolder = () => path.join(getLibraryRoot(), 'media');
  const getDiffCacheFolder = () => path.join(getLibraryRoot(), 'cache', 'diff');

  // Save base64 image to media folder, return relative path
  const saveImageToMedia = async (base64Data: string, prefix: string = 'cover'): Promise<string> => {
    const mediaFolder = getMediaFolder();
    await fs.mkdir(mediaFolder, { recursive: true });

    // Extract actual base64 content and determine extension
    let data: Buffer;
    let ext = '.jpg';
    if (base64Data.startsWith('data:')) {
      const match = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        ext = '.' + (match[1] === 'jpeg' ? 'jpg' : match[1]);
        data = Buffer.from(match[2], 'base64');
      } else {
        // Fallback: strip data URL prefix
        const base64Content = base64Data.split(',')[1] || base64Data;
        data = Buffer.from(base64Content, 'base64');
      }
    } else {
      data = Buffer.from(base64Data, 'base64');
    }

    // Hash the content for deduplication
    const hash = crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
    const filename = `${prefix}_${hash}${ext}`;
    const filePath = path.join(mediaFolder, filename);

    // Only write if file doesn't exist (deduplication)
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, data);
    }

    // Return relative path from library root
    return `media/${filename}`;
  };

  // Load image from media folder, return base64 data URL
  const loadImageFromMedia = async (relativePath: string): Promise<string | null> => {
    try {
      const fullPath = path.join(getLibraryRoot(), relativePath);
      const data = await fs.readFile(fullPath);
      const ext = path.extname(relativePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      return `data:${mimeType};base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  };

  // Extract embedded images from project data and save to media folder
  const extractEmbeddedImages = async (projectData: Record<string, unknown>): Promise<boolean> => {
    let modified = false;
    const metadata = projectData.metadata as Record<string, unknown> | undefined;

    if (metadata?.coverImage && typeof metadata.coverImage === 'string') {
      const coverImage = metadata.coverImage;
      // Check if it's embedded base64 (starts with data: or is very long)
      if (coverImage.startsWith('data:') || coverImage.length > 1000) {
        const relativePath = await saveImageToMedia(coverImage, 'cover');
        metadata.coverImage = undefined;
        metadata.coverImagePath = relativePath;
        modified = true;
        console.log(`[Project] Extracted embedded cover to: ${relativePath}`);
      }
    }

    return modified;
  };

  // Compute file hash for duplicate detection
  const computeFileHash = async (filePath: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fsSync.createReadStream(filePath);
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  };

  // Find existing file in library by hash
  const findFileByHash = async (targetHash: string): Promise<string | null> => {
    const filesFolder = getFilesFolder();
    try {
      const entries = await fs.readdir(filesFolder, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(filesFolder, entry.name);
        try {
          const hash = await computeFileHash(filePath);
          if (hash === targetHash) {
            return filePath;
          }
        } catch {
          // Skip files we can't read
        }
      }
    } catch {
      // Folder doesn't exist yet
    }
    return null;
  };

  // Ensure library folders exist
  ipcMain.handle('projects:ensure-folder', async () => {
    try {
      const projectsFolder = getProjectsFolder();
      const filesFolder = getFilesFolder();
      await fs.mkdir(projectsFolder, { recursive: true });
      await fs.mkdir(filesFolder, { recursive: true });
      return { success: true, path: getLibraryRoot() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get projects folder path
  ipcMain.handle('projects:get-folder', () => {
    return { path: getProjectsFolder() };
  });

  // Import file to library - copies file and returns library path
  ipcMain.handle('library:import-file', async (_event, sourcePath: string) => {
    console.log('[library:import-file] Starting import for:', sourcePath);
    try {
      const filesFolder = getFilesFolder();
      console.log('[library:import-file] Files folder:', filesFolder);
      await fs.mkdir(filesFolder, { recursive: true });

      // Compute hash of source file
      console.log('[library:import-file] Computing hash...');
      const sourceHash = await computeFileHash(sourcePath);
      console.log('[library:import-file] Hash:', sourceHash);

      // Check if file with same hash already exists
      const existingPath = await findFileByHash(sourceHash);
      if (existingPath) {
        console.log('[library:import-file] File already in library:', existingPath);
        const result = { success: true, libraryPath: existingPath, hash: sourceHash, alreadyExists: true };
        console.log('[library:import-file] Returning:', JSON.stringify(result));
        return result;
      }

      // File doesn't exist, copy it
      const baseName = path.basename(sourcePath);
      let destPath = path.join(filesFolder, baseName);

      // If same name exists but different content, add hash suffix
      try {
        await fs.access(destPath);
        // File with same name exists but different hash - add short hash to name
        const ext = path.extname(baseName);
        const nameWithoutExt = path.basename(baseName, ext);
        const shortHash = sourceHash.substring(0, 8);
        destPath = path.join(filesFolder, `${nameWithoutExt}_${shortHash}${ext}`);
      } catch {
        // File doesn't exist, use original name
      }

      await fs.copyFile(sourcePath, destPath);
      console.log('[library:import-file] Copied file to library:', destPath);

      const result = { success: true, libraryPath: destPath, hash: sourceHash, alreadyExists: false };
      console.log('[library:import-file] Returning:', JSON.stringify(result));
      return result;
    } catch (err) {
      console.error('[library:import-file] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Resolve project source file - finds file in current library by hash or filename
  // Used when opening projects from another machine where paths don't match
  /**
   * Translate a cross-platform library path to the current platform.
   * Handles BFP files synced between Mac and Windows (e.g., via Syncthing).
   *
   * Detects known library subdirectories (projects/, files/, media/, cache/, logs/)
   * in the stored path, extracts the relative portion, and resolves against
   * the current library root.
   *
   * Example:
   *   Stored (Mac):  /Volumes/Callisto/Shared/BookForge/projects/MyBook/output/source.epub
   *   Current root:  E:\Shared\BookForge
   *   Result:        E:\Shared\BookForge\projects\MyBook\output\source.epub
   */
  const translateLibraryPath = (storedPath: string): string | null => {
    if (!storedPath) return null;

    // Normalize to forward slashes for matching
    const normalized = storedPath.replace(/\\/g, '/');

    // Known library subdirectories
    const knownSubdirs = ['/projects/', '/files/', '/media/', '/cache/', '/logs/'];

    for (const subdir of knownSubdirs) {
      const idx = normalized.indexOf(subdir);
      if (idx !== -1) {
        // Extract relative path from the subdir onwards (e.g., "projects/MyBook/output/source.epub")
        const relativePart = normalized.substring(idx + 1); // Skip leading /
        const translated = path.join(getLibraryRoot(), ...relativePart.split('/'));
        return translated;
      }
    }

    return null;
  };

  ipcMain.handle('library:resolve-source', async (_event, options: {
    libraryPath?: string;
    sourcePath?: string;
    fileHash?: string;
    sourceName?: string;
  }) => {
    console.log('[library:resolve-source] Resolving:', options);
    const filesFolder = getFilesFolder();

    // 1. Try the stored library_path directly
    if (options.libraryPath) {
      try {
        await fs.access(options.libraryPath);
        console.log('[library:resolve-source] Found at libraryPath:', options.libraryPath);
        return { success: true, resolvedPath: options.libraryPath };
      } catch {
        console.log('[library:resolve-source] libraryPath not found:', options.libraryPath);
      }

      // 1b. Try cross-platform translation of library_path
      const translated = translateLibraryPath(options.libraryPath);
      if (translated) {
        try {
          await fs.access(translated);
          console.log('[library:resolve-source] Found via cross-platform translation:', translated);
          return { success: true, resolvedPath: translated };
        } catch {
          console.log('[library:resolve-source] Cross-platform translated path not found:', translated);
        }
      }
    }

    // 2. Try finding by hash in current library
    if (options.fileHash) {
      const byHash = await findFileByHash(options.fileHash);
      if (byHash) {
        console.log('[library:resolve-source] Found by hash:', byHash);
        return { success: true, resolvedPath: byHash };
      }
    }

    // 3. Try finding by filename in current library files folder
    const filename = options.sourceName || (options.sourcePath ? path.basename(options.sourcePath) : null);
    if (filename) {
      const byName = path.join(filesFolder, filename);
      try {
        await fs.access(byName);
        console.log('[library:resolve-source] Found by name:', byName);
        return { success: true, resolvedPath: byName };
      } catch {
        console.log('[library:resolve-source] Not found by name:', byName);
      }
    }

    // 4. Try the original source_path as last resort
    if (options.sourcePath) {
      try {
        await fs.access(options.sourcePath);
        console.log('[library:resolve-source] Found at sourcePath:', options.sourcePath);
        return { success: true, resolvedPath: options.sourcePath };
      } catch {
        console.log('[library:resolve-source] sourcePath not found:', options.sourcePath);
      }

      // 4b. Try cross-platform translation of source_path
      const translated = translateLibraryPath(options.sourcePath);
      if (translated) {
        try {
          await fs.access(translated);
          console.log('[library:resolve-source] Found source via cross-platform translation:', translated);
          return { success: true, resolvedPath: translated };
        } catch {
          console.log('[library:resolve-source] Cross-platform translated source not found:', translated);
        }
      }
    }

    return { success: false, error: 'Source file not found in library' };
  });

  // Translate a cross-platform library path to the current platform
  // Used by renderer when BFP files contain paths from another OS (e.g., Mac path on Windows)
  ipcMain.handle('library:translate-path', async (_event, inputPath: string) => {
    if (!inputPath) return { success: false, translated: null };

    // First check if the path works as-is
    try {
      await fs.access(inputPath);
      return { success: true, translated: inputPath };
    } catch {
      // Try cross-platform translation
    }

    const translated = translateLibraryPath(inputPath);
    if (translated) {
      try {
        await fs.access(translated);
        return { success: true, translated };
      } catch {
        return { success: false, translated };
      }
    }

    return { success: false, translated: null };
  });

  // List all projects in the folder (checks both root and projects/ for backward compat)
  ipcMain.handle('projects:list', async () => {
    try {
      const projectsFolder = getProjectsFolder();
      const rootFolder = getLibraryRoot();

      // Ensure folders exist
      await fs.mkdir(projectsFolder, { recursive: true });

      const projects: Array<{
        name: string;
        path: string;
        sourcePath: string;
        sourceName: string;
        libraryPath?: string;
        fileHash?: string;
        deletedCount: number;
        createdAt: string;
        modifiedAt: string;
        size: number;
        coverImagePath?: string;  // Relative path to cover in media folder
      }> = [];

      // Helper to scan a folder for .bfp files
      const scanFolder = async (folder: string) => {
        try {
          const entries = await fs.readdir(folder, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.bfp')) continue;

            const filePath = path.join(folder, entry.name);
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              const data = JSON.parse(content);
              const stat = await fs.stat(filePath);

              // Determine the actual file path - prefer library_path, fall back to source_path
              const actualSourcePath = data.library_path || data.source_path;

              // Get cover image path - either from new coverImagePath or migrate old embedded coverImage
              let coverImagePath = data.metadata?.coverImagePath;
              if (!coverImagePath && data.metadata?.coverImage) {
                // Old project with embedded image - migrate it now
                try {
                  coverImagePath = await saveImageToMedia(data.metadata.coverImage, 'cover');
                  data.metadata.coverImagePath = coverImagePath;
                  delete data.metadata.coverImage;
                  await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
                  console.log(`[projects:list] Migrated embedded cover for ${entry.name}`);
                } catch (e) {
                  console.error(`[projects:list] Failed to migrate cover for ${entry.name}:`, e);
                }
              }

              projects.push({
                name: entry.name.replace('.bfp', ''),
                path: filePath,
                sourcePath: actualSourcePath,
                sourceName: data.source_name,
                libraryPath: data.library_path,
                fileHash: data.file_hash,
                deletedCount: data.deleted_block_ids?.length || 0,
                createdAt: data.created_at,
                modifiedAt: stat.mtime.toISOString(),
                size: stat.size,
                coverImagePath  // Return path instead of embedded data
              });
            } catch {
              // Skip invalid project files
            }
          }
        } catch {
          // Folder doesn't exist or can't be read
        }
      };

      // Scan both locations
      await scanFolder(projectsFolder);
      await scanFolder(rootFolder);

      // Sort by modification date, newest first
      projects.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

      return { success: true, projects };
    } catch (err) {
      return { success: false, error: (err as Error).message, projects: [] };
    }
  });

  // Save project to default folder
  // This will check for existing projects and update them instead of creating duplicates
  ipcMain.handle('projects:save', async (_event, projectData: unknown, name: string) => {
    try {
      const folder = getProjectsFolder();
      await fs.mkdir(folder, { recursive: true });

      const data = projectData as {
        source_path?: string;
        library_path?: string;
        file_hash?: string;
      };

      // Check for existing project with same source
      const entries = await fs.readdir(folder, { withFileTypes: true });
      let existingPath: string | null = null;

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bfp')) continue;

        const filePath = path.join(folder, entry.name);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const existing = JSON.parse(content);

          // Match by hash (most reliable)
          if (data.file_hash && existing.file_hash && data.file_hash === existing.file_hash) {
            existingPath = filePath;
            break;
          }

          // Match by library path
          if (data.library_path && existing.library_path && data.library_path === existing.library_path) {
            existingPath = filePath;
            break;
          }

          // Match by source path
          if (data.source_path && existing.source_path && data.source_path === existing.source_path) {
            existingPath = filePath;
            break;
          }
        } catch {
          // Skip invalid files
        }
      }

      // Use existing path or create new one
      let filePath: string;
      let mergedData = projectData as Record<string, unknown>;

      if (existingPath) {
        filePath = existingPath;
        console.log(`Updating existing project: ${filePath}`);

        // Safety: backup existing BFP before overwriting if it has significant content
        const stat = await fs.stat(filePath);
        if (stat.size > 500) {
          const backupPath = filePath + '.bak';
          await fs.copyFile(filePath, backupPath);
          console.log(`[projects:save] Created backup: ${backupPath}`);
        }

        // Merge with existing data to preserve fields like 'audiobook' that the editor doesn't manage
        try {
          const existingContent = await fs.readFile(filePath, 'utf-8');
          const existingData = JSON.parse(existingContent) as Record<string, unknown>;

          // Fields that should be preserved from existing file if not in new data
          const preserveFields = ['audiobook', 'audiobookFolder'];

          for (const field of preserveFields) {
            if (existingData[field] !== undefined && mergedData[field] === undefined) {
              mergedData[field] = existingData[field];
              console.log(`[projects:save] Preserved field: ${field}`);
            }
          }

          // Keep original created_at if it exists
          if (existingData.created_at) {
            mergedData.created_at = existingData.created_at;
          }
        } catch (parseErr) {
          console.warn(`[projects:save] Could not parse existing file for merge:`, parseErr);
        }
      } else {
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        filePath = path.join(folder, `${safeName}.bfp`);
        console.log(`Creating new project: ${filePath}`);
      }

      // Extract any embedded images to external files
      await extractEmbeddedImages(mergedData);

      await atomicWriteFile(filePath, JSON.stringify(mergedData, null, 2));
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete project(s) and their associated library files
  ipcMain.handle('projects:delete', async (_event, filePaths: string[]) => {
    try {
      const libraryRoot = getLibraryRoot();
      const projectsFolder = getProjectsFolder();
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      console.log(`[projects:delete] Starting deletion of ${filePaths.length} project(s)`);
      console.log(`[projects:delete] Library root: ${libraryRoot}`);

      for (const filePath of filePaths) {
        console.log(`[projects:delete] Processing: ${filePath}`);

        // Security: only allow deleting files from within the BookForge library root
        if (!filePath.startsWith(libraryRoot)) {
          console.log(`[projects:delete] REJECTED - outside library folder`);
          failed.push({ path: filePath, error: 'Invalid path - outside library folder' });
          continue;
        }

        try {
          // Read the project file to get file_hash before deleting
          let fileHash = '';
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const projectData = JSON.parse(content);
            fileHash = projectData.file_hash || '';
          } catch {
            console.log(`[projects:delete] Could not read BFP file, continuing with deletion`);
          }

          // Derive project output folder from BFP filename
          // e.g., "Aesop_s_Fables__Aesopus___2011_.bfp" -> projects/Aesop_s_Fables__Aesopus___2011_/
          const bfpFilename = path.basename(filePath);
          const projectName = bfpFilename.replace(/\.bfp$/, '');
          const projectFolder = path.join(projectsFolder, projectName);

          console.log(`[projects:delete] Derived project folder: ${projectFolder}`);

          // Delete the project folder (output/, session data, etc.) if it exists
          try {
            const folderExists = await fs.access(projectFolder).then(() => true).catch(() => false);
            if (folderExists) {
              await fs.rm(projectFolder, { recursive: true, force: true });
              console.log(`[projects:delete] Deleted project folder: ${projectFolder}`);
            } else {
              console.log(`[projects:delete] Project folder does not exist: ${projectFolder}`);
            }
          } catch (e) {
            console.log(`[projects:delete] Error deleting project folder: ${(e as Error).message}`);
          }

          // Delete the .bfp project file
          await fs.unlink(filePath);
          console.log(`[projects:delete] Deleted BFP file: ${filePath}`);
          deleted.push(filePath);

          // Delete any .bfp.bak backup file
          const backupPath = filePath + '.bak';
          try {
            await fs.unlink(backupPath);
            console.log(`[projects:delete] Deleted backup file: ${backupPath}`);
          } catch {
            // Backup doesn't exist, that's fine
          }

          // Clear cache for this project
          if (fileHash) {
            try {
              await pdfWorkerProxy.call('clearCache', [fileHash]);
              console.log(`[projects:delete] Cache cleared for hash: ${fileHash}`);
            } catch (e) {
              console.log(`[projects:delete] Could not clear cache: ${(e as Error).message}`);
            }
          }
        } catch (e) {
          console.log(`[projects:delete] FAILED: ${(e as Error).message}`);
          failed.push({ path: filePath, error: (e as Error).message });
        }
      }

      console.log(`[projects:delete] Complete. Deleted: ${deleted.length}, Failed: ${failed.length}`);
      return { success: true, deleted, failed };
    } catch (err) {
      console.error(`[projects:delete] Fatal error:`, err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Import project from external location
  ipcMain.handle('projects:import', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Project',
      filters: [
        { name: 'BookForge Project', extensions: ['bfp'] }
      ],
      properties: ['openFile', 'multiSelections']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const folder = getProjectsFolder();
    await fs.mkdir(folder, { recursive: true });

    const imported = [];
    const failed = [];

    for (const sourcePath of result.filePaths) {
      try {
        const content = await fs.readFile(sourcePath, 'utf-8');
        // Validate it's a valid project
        const data = JSON.parse(content);
        if (!data.version || !data.source_path) {
          failed.push({ path: sourcePath, error: 'Invalid project file' });
          continue;
        }

        const destName = path.basename(sourcePath);
        const destPath = path.join(folder, destName);

        // If file exists, add timestamp
        let finalPath = destPath;
        try {
          await fs.access(destPath);
          const timestamp = Date.now();
          finalPath = path.join(folder, destName.replace('.bfp', `_${timestamp}.bfp`));
        } catch {
          // File doesn't exist, use original name
        }

        await fs.copyFile(sourcePath, finalPath);
        imported.push(finalPath);
      } catch (e) {
        failed.push({ path: sourcePath, error: (e as Error).message });
      }
    }

    return { success: true, imported, failed };
  });

  // Load project from specific path - auto-imports to library if external
  ipcMain.handle('projects:load-from-path', async (_event, filePath: string) => {
    try {
      // Check if filePath is a manifest project directory
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        // Manifest project directory - read manifest.json and convert to BFP format
        const manifestPath = path.join(filePath, 'manifest.json');
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        const meta = manifest.metadata || {};
        const source = manifest.source || {};

        // Find the best source file by scanning source/ directory
        // Priority: finalized > original (any ext) > exported
        const sourceDir = path.join(filePath, 'source');
        let sourcePath = '';
        try {
          const sourceFiles = await fs.readdir(sourceDir);
          const finalized = sourceFiles.find(f => f.startsWith('finalized.'));
          const original = sourceFiles.find(f => f.startsWith('original.'));
          const exported = sourceFiles.find(f => f.startsWith('exported.'));
          const best = finalized || original || exported;
          if (best) {
            sourcePath = path.join(sourceDir, best);
          }
        } catch { /* source dir doesn't exist */ }

        // Convert manifest to BookForgeProject format expected by the editor
        const editor = manifest.editor || {};
        const data: Record<string, any> = {
          version: manifest.version || 2,
          source_path: sourcePath,
          source_name: source.originalFilename || path.basename(sourcePath),
          library_path: sourcePath,
          file_hash: source.fileHash || '',
          deleted_block_ids: source.deletedBlockIds || [],
          deleted_highlight_ids: source.deletedHighlightIds || [],
          page_order: source.pageOrder || [],
          deleted_pages: source.deletedPages || [],
          remove_backgrounds: source.removeBackgrounds || false,
          undo_stack: editor.undoStack || [],
          redo_stack: editor.redoStack || [],
          block_edits: editor.blockEdits || undefined,
          custom_categories: editor.customCategories || undefined,
          ocr_blocks: editor.ocrBlocks || undefined,
          ocr_categories: editor.ocrCategories || undefined,
          category_corrections: editor.categoryCorrections || undefined,
          learned_categories: editor.learnedCategories || undefined,
          paragraph_breaks: editor.paragraphBreaks || undefined,
          chapters: manifest.chapters || [],
          chapters_source: manifest.chaptersSource || 'manual',
          metadata: {
            title: meta.title || '',
            author: meta.author || '',
            year: meta.year != null ? String(meta.year) : '',
            language: meta.language || 'en',
          },
          created_at: manifest.createdAt || new Date().toISOString(),
          modified_at: manifest.modifiedAt || new Date().toISOString(),
        };

        const catCount = Array.isArray(data.category_corrections) ? data.category_corrections.length : 0;
        const paraCount = Array.isArray(data.paragraph_breaks) ? data.paragraph_breaks.length : 0;
        if (catCount > 0 || paraCount > 0) {
          console.log(`[project:load] Read from manifest: ${catCount} category corrections, ${paraCount} paragraph breaks`);
        }

        return { success: true, data, filePath };
      }

      // Legacy BFP file - read as JSON
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Check if this project is outside the library folder
      const projectsFolder = getProjectsFolder();
      const isInLibrary = filePath.startsWith(projectsFolder);

      if (!isInLibrary) {
        // Copy to library folder
        await fs.mkdir(projectsFolder, { recursive: true });

        // Generate unique name based on source file name
        const baseName = path.basename(filePath, '.bfp');
        let destPath = path.join(projectsFolder, `${baseName}.bfp`);

        // If file exists, add a number suffix
        let counter = 1;
        while (true) {
          try {
            await fs.access(destPath);
            destPath = path.join(projectsFolder, `${baseName}_${counter}.bfp`);
            counter++;
          } catch {
            // File doesn't exist, use this path
            break;
          }
        }

        // Copy the file
        await fs.copyFile(filePath, destPath);
        console.log(`Imported project from ${filePath} to ${destPath}`);

        return { success: true, data, filePath: destPath };
      }

      return { success: true, data, filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Export project to external location
  ipcMain.handle('projects:export', async (_event, projectPath: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const defaultName = path.basename(projectPath);

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Project',
      defaultPath: defaultName,
      filters: [
        { name: 'BookForge Project', extensions: ['bfp'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    try {
      await fs.copyFile(projectPath, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // OCR handlers
  ipcMain.handle('ocr:is-available', async () => {
    try {
      const ocr = getOcrService();
      return {
        success: true,
        available: ocr.isAvailable(),
        version: ocr.getVersion()
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ocr:get-languages', async () => {
    try {
      const ocr = getOcrService();
      const languages = await ocr.getAvailableLanguages();
      return { success: true, languages };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ocr:recognize', async (_event, imageData: string) => {
    try {
      const ocr = getOcrService();
      const result = await ocr.recognizeBase64(imageData);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ocr:detect-skew', async (_event, imageData: string) => {
    try {
      const ocr = getOcrService();
      const result = await ocr.detectSkewBase64(imageData);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Headless OCR - processes PDF directly without rendering to UI
  ipcMain.handle('ocr:process-pdf-headless', async (_event, pdfPath: string, options: {
    engine: string;
    language?: string;
    pages?: number[];
  }) => {
    try {
      const headlessOcr = getHeadlessOcrService();

      // Create progress callback that sends updates to renderer
      const onProgress = (current: number, total: number) => {
        if (mainWindow) {
          mainWindow.webContents.send('ocr:headless-progress', { current, total });
        }
      };

      const results = await headlessOcr.processPdf(pdfPath, {
        ...options,
        onProgress
      });

      return { success: true, results };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Window control handlers
  ipcMain.handle('window:hide', () => {
    if (mainWindow) {
      mainWindow.hide();
    }
    return { success: true };
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow) {
      mainWindow.close();
    }
    return { success: true };
  });

  // Plugin system handlers
  ipcMain.handle('plugins:list', async () => {
    try {
      const registry = getPluginRegistry();
      const plugins = await registry.getPlugins();
      return { success: true, data: plugins };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('plugins:get-settings', async (_event, pluginId: string) => {
    try {
      const registry = getPluginRegistry();
      const settings = registry.getSettings(pluginId);
      return { success: true, data: settings };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('plugins:update-settings', async (_event, pluginId: string, settings: Record<string, unknown>) => {
    try {
      const registry = getPluginRegistry();
      const errors = registry.updateSettings(pluginId, settings);
      if (errors.length > 0) {
        return { success: false, errors };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('plugins:check-availability', async (_event, pluginId: string) => {
    try {
      const registry = getPluginRegistry();
      const availability = await registry.checkAvailability(pluginId);
      return { success: true, data: availability };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // File System handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Read a file as binary (ArrayBuffer) - used for epub.js loading
  ipcMain.handle('file:read-binary', async (_event, filePath: string) => {
    try {
      const buffer = await fs.readFile(filePath);
      // Return as Uint8Array which can be transferred to renderer
      return { success: true, data: buffer };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // EPUB Processing handlers (for Audiobook Producer)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('epub:parse', async (_event, epubPath: string) => {
    try {
      const { parseEpub } = await import('./epub-processor.js');
      const structure = await parseEpub(epubPath);
      return { success: true, data: structure };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:get-cover', async (_event, epubPath?: string) => {
    try {
      const { getCover } = await import('./epub-processor.js');
      const coverData = await getCover(epubPath);
      return { success: true, data: coverData };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:set-cover', async (_event, coverDataUrl: string) => {
    try {
      const { setCover } = await import('./epub-processor.js');
      setCover(coverDataUrl);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:get-chapter-text', async (_event, chapterId: string) => {
    try {
      const { getChapterText } = await import('./epub-processor.js');
      const text = await getChapterText(chapterId);
      return { success: true, data: text };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:get-metadata', async () => {
    try {
      const { getMetadata } = await import('./epub-processor.js');
      const metadata = getMetadata();
      return { success: true, data: metadata };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:set-metadata', async (_event, metadata: Partial<{
    title: string;
    subtitle?: string;
    author: string;
    authorFileAs?: string;
    year?: string;
    language: string;
    identifier?: string;
    publisher?: string;
    description?: string;
  }>) => {
    try {
      const { setMetadata } = await import('./epub-processor.js');
      setMetadata(metadata);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:get-chapters', async () => {
    try {
      const { getChapters } = await import('./epub-processor.js');
      const chapters = getChapters();
      return { success: true, data: chapters };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:close', async () => {
    try {
      const { closeEpub } = await import('./epub-processor.js');
      closeEpub();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // SAFETY: Only allows writes to files inside the library folder
  ipcMain.handle('epub:save-modified', async (_event, outputPath: string) => {
    try {
      // SAFETY CHECK: Only allow writes inside the library folder
      const libraryRoot = getLibraryRoot();
      const normalizedOutputPath = path.normalize(outputPath);
      const normalizedLibraryRoot = path.normalize(libraryRoot);

      if (!normalizedOutputPath.startsWith(normalizedLibraryRoot + path.sep) &&
          normalizedOutputPath !== normalizedLibraryRoot) {
        console.error(`[epub:save-modified] BLOCKED: Attempted write outside library folder`);
        console.error(`[epub:save-modified]   outputPath: ${outputPath}`);
        console.error(`[epub:save-modified]   libraryRoot: ${libraryRoot}`);
        return {
          success: false,
          error: `Cannot write to files outside the library folder. Attempted path: ${outputPath}`
        };
      }

      const { saveModifiedEpub } = await import('./epub-processor.js');
      await saveModifiedEpub(outputPath);
      return { success: true, data: { outputPath } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // SAFETY: Only allows writes to files inside the library folder
  ipcMain.handle('epub:edit-text', async (_event, epubPath: string, chapterId: string, oldText: string, newText: string) => {
    try {
      // SAFETY CHECK: Only allow writes inside the library folder
      const libraryRoot = getLibraryRoot();
      const normalizedEpubPath = path.normalize(epubPath);
      const normalizedLibraryRoot = path.normalize(libraryRoot);

      if (!normalizedEpubPath.startsWith(normalizedLibraryRoot + path.sep) &&
          normalizedEpubPath !== normalizedLibraryRoot) {
        console.error(`[epub:edit-text] BLOCKED: Attempted write outside library folder`);
        console.error(`[epub:edit-text]   epubPath: ${epubPath}`);
        console.error(`[epub:edit-text]   libraryRoot: ${libraryRoot}`);
        return {
          success: false,
          error: `Cannot write to files outside the library folder. Attempted path: ${epubPath}`
        };
      }

      const { editEpubText } = await import('./epub-processor.js');
      const result = await editEpubText(epubPath, chapterId, oldText, newText);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // EPUB export with text removals (for EPUB editor)
  // SAFETY: Only allows writes to files inside the library folder
  ipcMain.handle('epub:export-with-removals', async (_event, inputPath: string, removals: Record<string, Array<{ chapterId: string; text: string; cfi: string }>>, outputPath?: string) => {
    try {
      const { exportEpubWithRemovals } = await import('./epub-processor.js');

      // Convert the object back to a Map
      const removalsMap = new Map<string, Array<{ chapterId: string; text: string; cfi: string }>>();
      for (const [chapterId, entries] of Object.entries(removals)) {
        removalsMap.set(chapterId, entries);
      }

      // Determine output path
      const finalOutputPath = outputPath || inputPath.replace(/\.epub$/i, '_edited.epub');

      // SAFETY CHECK: Only allow writes inside the library folder
      const libraryRoot = getLibraryRoot();
      const normalizedOutputPath = path.normalize(finalOutputPath);
      const normalizedLibraryRoot = path.normalize(libraryRoot);

      if (!normalizedOutputPath.startsWith(normalizedLibraryRoot + path.sep) &&
          normalizedOutputPath !== normalizedLibraryRoot) {
        console.error(`[epub:export-with-removals] BLOCKED: Attempted write outside library folder`);
        console.error(`[epub:export-with-removals]   outputPath: ${finalOutputPath}`);
        console.error(`[epub:export-with-removals]   libraryRoot: ${libraryRoot}`);
        return {
          success: false,
          error: `Cannot write to files outside the library folder. Attempted path: ${finalOutputPath}`
        };
      }

      const result = await exportEpubWithRemovals(inputPath, removalsMap, finalOutputPath);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Copy EPUB file
  // SAFETY: Only allows writes to files inside the library folder
  ipcMain.handle('epub:copy-file', async (_event, inputPath: string, outputPath: string) => {
    try {
      // SAFETY CHECK: Only allow writes inside the library folder
      const libraryRoot = getLibraryRoot();
      const normalizedOutputPath = path.normalize(outputPath);
      const normalizedLibraryRoot = path.normalize(libraryRoot);

      if (!normalizedOutputPath.startsWith(normalizedLibraryRoot + path.sep) &&
          normalizedOutputPath !== normalizedLibraryRoot) {
        console.error(`[epub:copy-file] BLOCKED: Attempted write outside library folder`);
        console.error(`[epub:copy-file]   outputPath: ${outputPath}`);
        console.error(`[epub:copy-file]   libraryRoot: ${libraryRoot}`);
        return {
          success: false,
          error: `Cannot write to files outside the library folder. Attempted path: ${outputPath}`
        };
      }

      const { copyEpubFile } = await import('./epub-processor.js');
      const result = await copyEpubFile(inputPath, outputPath);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // EPUB export with block deletions (for EPUB editor block-based deletion)
  ipcMain.handle('epub:export-with-deleted-blocks', async (_event, inputPath: string, deletedBlockIds: string[], outputPath?: string) => {
    try {
      const { exportEpubWithDeletedBlocks } = await import('./epub-processor.js');

      // Determine output path
      const finalOutputPath = outputPath || inputPath.replace(/\.epub$/i, '_edited.epub');

      const result = await exportEpubWithDeletedBlocks(inputPath, deletedBlockIds, finalOutputPath);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Export EPUB as a book with metadata + cover via save dialog
  ipcMain.handle('epub:export-book', async (_event, sourcePath: string, metadata: any, coverPath?: string) => {
    try {
      if (!mainWindow) return { success: false, error: 'No window' };

      // Build default filename from metadata
      const title = (metadata?.title || 'book').replace(/[/\\:*?"<>|]/g, '');
      const author = (metadata?.author || '').replace(/[/\\:*?"<>|]/g, '');
      const defaultName = author ? `${title} - ${author}.epub` : `${title}.epub`;

      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export EPUB',
        defaultPath: defaultName,
        filters: [{ name: 'EPUB', extensions: ['epub'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const { exportEpubAsBook } = await import('./epub-processor.js');
      await exportEpubAsBook(sourcePath, result.filePath, metadata, coverPath);
      return { success: true, filePath: result.filePath };
    } catch (err) {
      console.error('[IPC] epub:export-book ERROR:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Ebook Convert handlers (Calibre CLI integration for format conversion)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('ebook-convert:is-available', async () => {
    try {
      const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
      const available = await ebookConvertBridge.isAvailable();
      return { success: true, data: { available } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebook-convert:get-supported-extensions', async () => {
    try {
      const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
      const extensions = ebookConvertBridge.getSupportedExtensions();
      return { success: true, data: extensions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebook-convert:is-convertible', async (_event, filePath: string) => {
    try {
      const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
      const convertible = ebookConvertBridge.isConvertibleFormat(filePath);
      const native = ebookConvertBridge.isNativeFormat(filePath);
      return { success: true, data: { convertible, native } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebook-convert:convert', async (_event, inputPath: string, outputDir?: string) => {
    try {
      const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
      const result = await ebookConvertBridge.convertToEpub(inputPath, outputDir);
      return { success: result.success, data: { outputPath: result.outputPath }, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebook-convert:convert-to-library', async (_event, inputPath: string) => {
    try {
      const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
      const result = await ebookConvertBridge.convertToLibrary(inputPath);
      return { success: result.success, data: { outputPath: result.outputPath }, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // JWPUB Conversion handler
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('jwpub:convert', async (_event, jwpubPath: string) => {
    try {
      const { convertJwpubToEpub } = await import('./jwpub-converter.js');
      return await convertJwpubToEpub(jwpubPath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Diff Comparison handlers (for AI cleanup diff view)
  // ─────────────────────────────────────────────────────────────────────────────

  // Legacy full comparison - loads all chapters (can cause OOM on large EPUBs)
  ipcMain.handle('diff:load-comparison', async (_event, originalPath: string, cleanedPath: string) => {
    try {
      const { compareEpubs } = await import('./epub-processor.js');
      const result = await compareEpubs(originalPath, cleanedPath, (progress) => {
        // Send progress to renderer
        if (mainWindow) {
          mainWindow.webContents.send('diff:load-progress', progress);
        }
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Memory-efficient: Get only chapter metadata (no text)
  ipcMain.handle('diff:get-metadata', async (_event, originalPath: string, cleanedPath: string) => {
    try {
      const { getComparisonMetadata } = await import('./epub-processor.js');
      const result = await getComparisonMetadata(originalPath, cleanedPath, (progress) => {
        if (mainWindow) {
          mainWindow.webContents.send('diff:load-progress', progress);
        }
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Memory-efficient: Load a single chapter's text on demand
  ipcMain.handle('diff:get-chapter', async (_event, originalPath: string, cleanedPath: string, chapterId: string) => {
    try {
      console.log(`[diff:get-chapter] Loading chapter ${chapterId}`);
      console.log(`[diff:get-chapter] Original: ${originalPath}`);
      console.log(`[diff:get-chapter] Cleaned: ${cleanedPath}`);
      const { getChapterComparison } = await import('./epub-processor.js');
      const result = await getChapterComparison(originalPath, cleanedPath, chapterId);
      console.log(`[diff:get-chapter] Result - original: ${result.originalText.length} chars, cleaned: ${result.cleanedText.length} chars`);
      if (result.originalText.length === 0) {
        console.log(`[diff:get-chapter] WARNING: Original text is empty!`);
      }
      if (result.cleanedText.length === 0) {
        console.log(`[diff:get-chapter] WARNING: Cleaned text is empty!`);
      }
      return { success: true, data: result };
    } catch (err) {
      console.error(`[diff:get-chapter] ERROR for chapter ${chapterId}:`, err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Generate a cache key based on file paths and modification times
  const getDiffCacheKey = async (originalPath: string, cleanedPath: string): Promise<string> => {
    try {
      const [origStat, cleanStat] = await Promise.all([
        fs.stat(originalPath),
        fs.stat(cleanedPath)
      ]);
      const keySource = `${originalPath}|${origStat.mtimeMs}|${cleanedPath}|${cleanStat.mtimeMs}`;
      return crypto.createHash('sha256').update(keySource).digest('hex').substring(0, 16);
    } catch {
      // Fallback to path-based key if stat fails
      return crypto.createHash('sha256').update(`${originalPath}|${cleanedPath}`).digest('hex').substring(0, 16);
    }
  };

  // Save diff cache to disk
  ipcMain.handle('diff:save-cache', async (_event, originalPath: string, cleanedPath: string, chapterId: string, cacheData: unknown) => {
    try {
      const cacheFolder = getDiffCacheFolder();
      await fs.mkdir(cacheFolder, { recursive: true });

      const cacheKey = await getDiffCacheKey(originalPath, cleanedPath);
      const cacheFile = path.join(cacheFolder, `${cacheKey}_${chapterId}.json`);

      await fs.writeFile(cacheFile, JSON.stringify(cacheData), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Load diff cache from disk
  ipcMain.handle('diff:load-cache', async (_event, originalPath: string, cleanedPath: string, chapterId: string) => {
    try {
      const cacheFolder = getDiffCacheFolder();
      const cacheKey = await getDiffCacheKey(originalPath, cleanedPath);
      const cacheFile = path.join(cacheFolder, `${cacheKey}_${chapterId}.json`);

      const data = await fs.readFile(cacheFile, 'utf-8');
      return { success: true, data: JSON.parse(data) };
    } catch {
      // Cache miss is not an error
      return { success: false, notFound: true };
    }
  });

  // Clear diff cache for a specific book pair
  ipcMain.handle('diff:clear-cache', async (_event, originalPath: string, cleanedPath: string) => {
    try {
      const cacheFolder = getDiffCacheFolder();
      const cacheKey = await getDiffCacheKey(originalPath, cleanedPath);

      // Delete all cache files matching this key
      const entries = await fs.readdir(cacheFolder).catch(() => []);
      let deleted = 0;
      for (const entry of entries) {
        if (entry.startsWith(cacheKey)) {
          await fs.unlink(path.join(cacheFolder, entry)).catch(() => {});
          deleted++;
        }
      }
      return { success: true, deleted };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Load pre-computed diff cache file (created during AI cleanup)
  ipcMain.handle('diff:load-cached-file', async (_event, cleanedPath: string) => {
    try {
      const { loadDiffCacheFile } = await import('./diff-cache.js');
      const cache = await loadDiffCacheFile(cleanedPath);
      if (cache) {
        return { success: true, data: cache };
      }
      return { success: false, needsRecompute: true };
    } catch (err) {
      return { success: false, error: (err as Error).message, needsRecompute: true };
    }
  });

  // Hydrate a chapter's compact diff changes back to full DiffWord[] for rendering
  ipcMain.handle('diff:hydrate-chapter', async (_event, originalPath: string, cleanedPath: string, chapterId: string, changes: unknown[]) => {
    try {
      const { hydrateDiff } = await import('./diff-cache.js');
      const { getChapterComparison } = await import('./epub-processor.js');

      // Get BOTH the original and cleaned text for this chapter
      // We need original for display and cleaned for hydration
      const result = await getChapterComparison(originalPath, cleanedPath, chapterId);
      const { originalText, cleanedText } = result;

      // Hydrate the compact changes
      const diffWords = hydrateDiff(changes as any[], cleanedText);

      return {
        success: true,
        data: {
          diffWords,
          cleanedText,
          originalText // Now correctly includes the original text
        }
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get cache key for a book pair (used by renderer to check if cache is valid)
  ipcMain.handle('diff:get-cache-key', async (_event, originalPath: string, cleanedPath: string) => {
    try {
      const cacheKey = await getDiffCacheKey(originalPath, cleanedPath);
      return { success: true, cacheKey };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Pre-compute diff cache for an arbitrary EPUB pair (background operation)
  ipcMain.handle('diff:precompute-pair', async (_event, originalPath: string, targetPath: string) => {
    try {
      // Check if .diff.json already exists next to the target
      const diffJsonPath = targetPath.replace('.epub', '.diff.json');
      try {
        await fs.access(diffJsonPath);
        // Cache file exists — skip precomputation regardless of completed state.
        // Incomplete caches are regenerated on-demand when the user views the diff.
        // This prevents heavy CPU-bound diff work from blocking the main process
        // during normal navigation.
        return { success: true, cached: true };
      } catch {
        // No existing cache — generate it
      }

      const { EpubProcessor, extractChapterAsText } = await import('./epub-processor.js');
      const { computeCompactDiff } = await import('./diff-cache.js');

      const origProc = new EpubProcessor();
      const targetProc = new EpubProcessor();

      try {
        const origStructure = await origProc.open(originalPath);
        const targetStructure = await targetProc.open(targetPath);

        const origChapterMap = new Map(origStructure.chapters.map(c => [c.id, c]));
        const chapters: Array<{
          id: string; title: string;
          originalCharCount: number; cleanedCharCount: number;
          changeCount: number; changes: any[];
        }> = [];

        for (const chapter of targetStructure.chapters) {
          const origChapter = origChapterMap.get(chapter.id);
          if (!origChapter) continue;

          const origHref = origProc.resolvePath(origChapter.href);
          const targetHref = targetProc.resolvePath(chapter.href);
          const origXhtml = await origProc.readFile(origHref);
          const targetXhtml = await targetProc.readFile(targetHref);

          const origText = extractChapterAsText(origXhtml);
          const targetText = extractChapterAsText(targetXhtml);

          const { changes, changeCount } = computeCompactDiff(origText, targetText);

          chapters.push({
            id: chapter.id,
            title: chapter.title,
            originalCharCount: origText.length,
            cleanedCharCount: targetText.length,
            changeCount,
            changes,
          });

          // Yield the event loop between chapters so diff computation
          // doesn't block IPC handlers for seconds on large books
          await new Promise(resolve => setImmediate(resolve));
        }

        const now = new Date().toISOString();
        const cache = {
          version: 1,
          createdAt: now,
          updatedAt: now,
          ignoreWhitespace: true,
          completed: true,
          originalPath,
          chapters,
        };

        await fs.writeFile(diffJsonPath, JSON.stringify(cache, null, 2), 'utf-8');
        console.log(`[DIFF-PRECOMPUTE] Generated ${path.basename(diffJsonPath)} with ${chapters.length} chapters`);

        return { success: true, cached: false, chapters: chapters.length };
      } finally {
        origProc.close();
        targetProc.close();
      }
    } catch (err) {
      console.warn('[DIFF-PRECOMPUTE] Failed:', (err as Error).message);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // AI Bridge handlers (Ollama integration)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('ai:check-connection', async () => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      const result = await aiBridge.checkConnection();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:get-models', async () => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      const models = await aiBridge.getModels();
      return { success: true, data: models };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:cleanup-chapter', async (
    _event,
    text: string,
    options: { fixHyphenation: boolean; fixOcrArtifacts: boolean; expandAbbreviations: boolean },
    chapterId: string,
    chapterTitle: string,
    model?: string
  ) => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      const result = await aiBridge.cleanupText(text, options, chapterId, chapterTitle, model, mainWindow);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:check-provider-connection', async (
    _event,
    provider: 'ollama' | 'claude' | 'openai'
  ) => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      const result = await aiBridge.checkProviderConnection(provider);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:get-prompt', async () => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      const prompt = await aiBridge.loadPrompt();
      const filePath = aiBridge.getPromptFilePath();
      return { success: true, data: { prompt, filePath } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:save-prompt', async (_event, prompt: string) => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      await aiBridge.savePrompt(prompt);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:get-claude-models', async (_event, apiKey: string) => {
    try {
      const { getClaudeModels } = await import('./ai-bridge.js');
      return await getClaudeModels(apiKey);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:get-openai-models', async (_event, apiKey: string) => {
    try {
      const { getOpenAIModels } = await import('./ai-bridge.js');
      return await getOpenAIModels(apiKey);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:load-skipped-chunks', async (_event, jsonPath: string) => {
    try {
      const content = await fs.readFile(jsonPath, 'utf-8');
      const chunks = JSON.parse(content);
      return { success: true, chunks };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Replace text in EPUB - used for editing skipped chunks
  // SAFETY: Only allows writes to files inside the library folder
  ipcMain.handle('ai:replace-text-in-epub', async (_event, epubPath: string, oldText: string, newText: string) => {
    try {
      // SAFETY CHECK: Only allow writes inside the library folder
      const libraryRoot = getLibraryRoot();
      const normalizedEpubPath = path.normalize(epubPath);
      const normalizedLibraryRoot = path.normalize(libraryRoot);

      if (!normalizedEpubPath.startsWith(normalizedLibraryRoot + path.sep) &&
          normalizedEpubPath !== normalizedLibraryRoot) {
        console.error(`[ai:replace-text-in-epub] BLOCKED: Attempted write outside library folder`);
        console.error(`[ai:replace-text-in-epub]   epubPath: ${epubPath}`);
        console.error(`[ai:replace-text-in-epub]   libraryRoot: ${libraryRoot}`);
        return {
          success: false,
          error: `Cannot write to files outside the library folder. Attempted path: ${epubPath}`
        };
      }

      const { replaceTextInEpub } = await import('./epub-processor.js');
      const result = await replaceTextInEpub(epubPath, oldText, newText);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Update a skipped chunk's text in the JSON file
  ipcMain.handle('ai:update-skipped-chunk', async (_event, jsonPath: string, index: number, newText: string) => {
    try {
      const content = await fs.readFile(jsonPath, 'utf-8');
      const chunks = JSON.parse(content);
      if (index >= 0 && index < chunks.length) {
        chunks[index].text = newText;
        await fs.writeFile(jsonPath, JSON.stringify(chunks, null, 2), 'utf-8');
        return { success: true };
      }
      return { success: false, error: 'Invalid chunk index' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Shell handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    try {
      const { shell } = await import('electron');
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('shell:show-item-in-folder', async (_event, filePath: string) => {
    try {
      const { shell } = await import('electron');
      shell.showItemInFolder(normalizeFsPath(filePath));
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('shell:open-path', async (_event, filePath: string) => {
    try {
      const { shell } = await import('electron');
      await shell.openPath(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Bookshelf Server handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('bookshelf:start', async (_event, config: { port: number; externalAudiobooksDir?: string }) => {
    try {
      // Stop existing server if running
      if (bookshelfServer.isRunning()) {
        await bookshelfServer.stop();
      }
      await bookshelfServer.start({ ...config, userDataPath: app.getPath('userData') });
      // Save config with enabled=true for auto-start on next launch
      await saveBookshelfConfig({ ...config, enabled: true });
      return { success: true, data: bookshelfServer.getStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('bookshelf:stop', async () => {
    try {
      await bookshelfServer.stop();
      // Save config with enabled=false
      const currentConfig = await loadBookshelfConfig();
      if (currentConfig) {
        await saveBookshelfConfig({ ...currentConfig, enabled: false });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('bookshelf:status', async () => {
    try {
      return { success: true, data: bookshelfServer.getStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('bookshelf:updateConfig', async (_event, updates: { externalAudiobooksDir?: string }) => {
    try {
      const currentConfig = await loadBookshelfConfig();
      const merged = { ...currentConfig, ...updates };
      await saveBookshelfConfig(merged as any);
      // Invalidate book list cache so next request re-scans
      bookshelfServer.invalidateCache();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Ebook Library
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('ebookLibrary:init', async () => {
    try {
      const data = await ebookLibrary.initLibrary();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:scan', async () => {
    try {
      const books = await ebookLibrary.scanLibrary();
      return { success: true, data: { books } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:add-books', async (_event, paths: string[], category: string) => {
    try {
      const result = await ebookLibrary.addBooks(paths, category);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:remove-book', async (_event, relativePath: string) => {
    try {
      await ebookLibrary.removeBook(relativePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:move-books', async (_event, paths: string[], category: string) => {
    try {
      await ebookLibrary.moveBooks(paths, category);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:update-metadata', async (_event, relativePath: string, metadata: any) => {
    try {
      const result = await ebookLibrary.updateBookMetadata(relativePath, metadata);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:get-cover', async (_event, relativePath: string) => {
    try {
      const coverData = await ebookLibrary.getCoverData(relativePath);
      return { success: true, data: { coverData } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:set-cover', async (_event, relativePath: string, base64Data: string) => {
    try {
      await ebookLibrary.setBookCover(relativePath, base64Data);
      // Re-read the book entry from cache to return updated data
      const books = await ebookLibrary.scanLibrary();
      const book = books.find(b => b.relativePath === relativePath);
      return { success: true, data: { book } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:list-categories', async () => {
    try {
      const categories = await ebookLibrary.listCategories();
      return { success: true, data: { categories } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:create-category', async (_event, name: string) => {
    try {
      await ebookLibrary.createCategory(name);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:delete-category', async (_event, name: string) => {
    try {
      await ebookLibrary.deleteCategory(name);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:rename-category', async (_event, oldName: string, newName: string) => {
    try {
      await ebookLibrary.renameCategory(oldName, newName);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:get-absolute-path', async (_event, relativePath: string) => {
    try {
      const absolutePath = ebookLibrary.getAbsolutePath(relativePath);
      return { success: true, data: { absolutePath } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:reveal-book', async (_event, relativePath: string) => {
    try {
      const absolutePath = normalizeFsPath(ebookLibrary.getAbsolutePath(relativePath));
      const { shell } = await import('electron');
      // showItemInFolder is fire-and-forget and silently no-ops on bad paths on Windows,
      // so verify the file exists and surface a real error if it doesn't.
      if (!fsSync.existsSync(absolutePath)) {
        return { success: false, error: `File not found: ${absolutePath}` };
      }
      shell.showItemInFolder(absolutePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:open-category-folder', async (_event, categoryName: string) => {
    try {
      const absolutePath = ebookLibrary.getAbsolutePath(categoryName);
      const { shell } = await import('electron');
      await shell.openPath(absolutePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:update-tags', async (_event, relativePath: string, tags: string[]) => {
    try {
      await ebookLibrary.updateBookTags(relativePath, tags);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:get-all-tags', async () => {
    try {
      const tags = ebookLibrary.getAllTags();
      return { success: true, data: { tags } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ebookLibrary:import-to-studio', async (_event, relativePath: string) => {
    try {
      const absolutePath = ebookLibrary.getAbsolutePath(relativePath);
      // Metadata priority: cache (user-edited) → file (ebook-meta) → filename parsing
      let meta = ebookLibrary.getCachedMetadata(relativePath);
      if (!meta) {
        try {
          meta = await ebookLibrary.readMetadata(absolutePath);
        } catch {
          meta = ebookLibrary.parseFilename(path.basename(absolutePath));
        }
      }
      const coverData = await ebookLibrary.getCoverData(relativePath);
      const confirmedMeta = {
        title: meta.title,
        subtitle: meta.subtitle,
        author: meta.authorFull || meta.authorLast || 'Unknown',
        year: meta.year ? String(meta.year) : undefined,
        language: meta.language,
      };
      // Return the path + metadata + cover so the renderer can call audiobook:import-epub
      return { success: true, data: { absolutePath, metadata: confirmedMeta, coverData } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // E2A Path Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('e2a:configure-paths', async (_event, config: { e2aPath?: string; condaPath?: string; ttsScratchPath?: string }) => {
    try {
      const { setCondaPath, setE2aPath } = await import('./e2a-paths.js');
      if (config.e2aPath !== undefined) {
        setE2aPath(config.e2aPath || null);
      }
      if (config.condaPath !== undefined) {
        setCondaPath(config.condaPath || null);
      }
      if (config.ttsScratchPath !== undefined) {
        const { updateConfig } = await import('./tool-paths.js');
        updateConfig({ ttsScratchPath: config.ttsScratchPath || undefined });
        // Re-resolve the scratch dir so the override (or its removal) applies now.
        applyE2aScratchDir();
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Paths Configuration (centralized config for external tools)
  // ─────────────────────────────────────────────────────────────────────────────

  // First-run runtime readiness: the renderer queries this on boot to sync the
  // current state (events may have fired before the renderer subscribed), then
  // listens for `runtime:status` pushes.
  ipcMain.handle('runtime:get-status', async () => {
    return { success: true, data: runtimeStatus };
  });

  // Whether the bundled environment was created from scratch this launch (fresh
  // install / post-reset). The renderer uses this — not lingering localStorage —
  // to decide whether to show first-run setup.
  ipcMain.handle('runtime:is-fresh-install', async () => {
    return { success: true, data: runtimeWasFresh };
  });

  // Whether spawns use the bundled relocatable env (packaged) vs a conda env
  // (dev / BYO Orpheus). Lets the renderer hide the "Conda — required for TTS"
  // tool row when conda is irrelevant.
  ipcMain.handle('runtime:using-bundled-env', async () => {
    try {
      const { getActiveBundledEnvPath } = await import('./e2a-env-bootstrap.js');
      return { success: true, data: !!getActiveBundledEnvPath() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tool-paths:get-config', async () => {
    try {
      const { getConfig } = await import('./tool-paths.js');
      return { success: true, data: getConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tool-paths:update-config', async (_event, updates: Record<string, string | undefined>) => {
    try {
      const { updateConfig } = await import('./tool-paths.js');
      const newConfig = updateConfig(updates);
      return { success: true, data: newConfig };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tool-paths:get-status', async () => {
    try {
      const { getToolStatus } = await import('./tool-paths.js');
      return { success: true, data: getToolStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // WSL2 Support (Windows only, for Orpheus TTS)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('wsl:detect', async () => {
    try {
      const { detectWslAvailability } = await import('./tool-paths.js');
      return { success: true, data: detectWslAvailability() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('wsl:check-orpheus-setup', async (_event, config: {
    distro?: string;
    condaPath?: string;
    e2aPath?: string;
  }) => {
    try {
      const { checkWslOrpheusSetup } = await import('./tool-paths.js');
      return { success: true, data: checkWslOrpheusSetup(config) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TTS Bridge handlers (ebook2audiobook)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('tts:check-available', async () => {
    try {
      const { ttsBridge } = await import('./tts-bridge.js');
      const result = await ttsBridge.checkAvailable();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts:get-voices', async () => {
    try {
      const { ttsBridge } = await import('./tts-bridge.js');
      const voices = await ttsBridge.getVoices();
      return { success: true, data: voices };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts:start-conversion', async (
    _event,
    epubPath: string,
    outputDir: string,
    settings: {
      device: 'gpu' | 'mps' | 'cpu';
      language: string;
      ttsEngine: string;
      fineTuned: string;
      temperature: number;
      topP: number;
      topK: number;
      repetitionPenalty: number;
      speed: number;
      enableTextSplitting: boolean;
    }
  ) => {
    try {
      const { ttsBridge } = await import('./tts-bridge.js');
      ttsBridge.setMainWindow(mainWindow);
      const result = await ttsBridge.startConversion(epubPath, outputDir, settings);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts:stop-conversion', async () => {
    try {
      const { ttsBridge } = await import('./tts-bridge.js');
      const stopped = ttsBridge.stopConversion();
      return { success: true, data: { stopped } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts:generate-filename', async (
    _event,
    title: string,
    subtitle?: string,
    author?: string,
    authorFileAs?: string,
    year?: string
  ) => {
    try {
      const { ttsBridge } = await import('./tts-bridge.js');
      const filename = ttsBridge.generateOutputFilename(title, subtitle, author, authorFileAs, year);
      return { success: true, data: filename };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Parallel TTS handlers (multi-worker audiobook conversion)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('parallel-tts:detect-worker-count', async () => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const result = parallelTtsBridge.detectRecommendedWorkerCount();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('parallel-tts:start-conversion', async (_event, jobId: string, config: any) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      parallelTtsBridge.setMainWindow(mainWindow);
      // Initialize logger with current library path
      await parallelTtsBridge.initializeLogger(getLibraryRoot());
      const result = await parallelTtsBridge.startParallelConversion(jobId, config);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('parallel-tts:stop-conversion', async (_event, jobId: string) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const result = parallelTtsBridge.stopParallelConversion(jobId);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('parallel-tts:get-progress', async (_event, jobId: string) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const progress = parallelTtsBridge.getConversionProgress(jobId);
      return { success: true, data: progress };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('parallel-tts:is-active', async (_event, jobId: string) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const isActive = parallelTtsBridge.isConversionActive(jobId);
      return { success: true, data: isActive };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // List all active TTS sessions (for UI refresh after rebuild)
  ipcMain.handle('parallel-tts:list-active', async () => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const sessions = parallelTtsBridge.listActiveSessions();
      return { success: true, data: sessions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Check resume status from a known processDir (for cached sessions)
  ipcMain.handle('parallel-tts:check-resume-from-dir', async (_event, processDir: string) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const result = await parallelTtsBridge.checkResumeStatusFromProcessDir(processDir);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Fast resume check (no subprocess, just counts files)
  ipcMain.handle('parallel-tts:check-resume-fast', async (_event, epubPath: string) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const result = await parallelTtsBridge.checkResumeStatusFast(epubPath);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Resume support for parallel TTS (detailed check with subprocess)
  ipcMain.handle('parallel-tts:check-resume', async (_event, sessionPath: string) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const result = await parallelTtsBridge.checkResumeStatus(sessionPath);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('parallel-tts:resume-conversion', async (_event, jobId: string, config: any, resumeInfo: any) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      parallelTtsBridge.setMainWindow(mainWindow);
      // Initialize logger with current library path
      await parallelTtsBridge.initializeLogger(getLibraryRoot());
      const result = await parallelTtsBridge.resumeParallelConversion(jobId, config, resumeInfo);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('parallel-tts:build-resume-info', async (_event, prepInfo: any, settings: any) => {
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      const resumeInfo = parallelTtsBridge.buildResumeInfo(prepInfo, settings);
      return { success: true, data: resumeInfo };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Caching handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Cache full TTS session to BFP audiobook folder for permanent storage
  ipcMain.handle('session-cache:save-to-bfp', async (_event, sessionDir: string, bfpPath: string) => {
    try {
      const { cacheSessionToBfp } = await import('./parallel-tts-bridge.js');
      return await cacheSessionToBfp(sessionDir, bfpPath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('session-cache:save-to-project', async (_event, sessionDir: string, projectDir: string, language: string) => {
    try {
      const { cacheSessionToProject } = await import('./parallel-tts-bridge.js');
      return await cacheSessionToProject(sessionDir, projectDir, language);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('session-cache:scan-project', async (_event, projectDir: string) => {
    try {
      const { scanProjectSessions } = await import('./parallel-tts-bridge.js');
      return { success: true, sessions: await scanProjectSessions(projectDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message, sessions: [] };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Bilingual Assembly handlers (for dual-voice language learning audiobooks)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('bilingual-assembly:run', async (_event, jobId: string, config: {
    projectId: string;
    sourceSentencesDir: string;
    targetSentencesDir: string;
    sentencePairsPath: string;
    outputDir: string;
    pauseDuration?: number;
    gapDuration?: number;
    audioFormat?: string;
    // Output naming with language suffix
    outputName?: string;
    title?: string;
    sourceLang?: string;
    targetLang?: string;
    bfpPath?: string;
  }) => {
    try {
      const { initBilingualAssemblyBridge, runBilingualAssembly } = await import('./bilingual-assembly-bridge.js');
      initBilingualAssemblyBridge(mainWindow!);
      const result = await runBilingualAssembly(jobId, config);
      return { success: result.success, data: result, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Video Assembly handlers (render subtitle MP4 from M4B + VTT)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('video-assembly:run', async (_event, jobId: string, config: {
    projectId: string;
    bfpPath: string;
    mode: 'bilingual' | 'monolingual';
    m4bPath: string;
    vttPath: string;
    sentencePairsPath?: string;
    title: string;
    sourceLang: string;
    targetLang?: string;
    resolution: '480p' | '720p' | '1080p';
    outputFilename?: string;
  }) => {
    try {
      const { startVideoAssembly } = await import('./video-assembly-bridge.js');
      startVideoAssembly(jobId, mainWindow!, config);
      return { success: true, jobId };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('video-assembly:cancel', async (_event, jobId: string) => {
    try {
      const { cancelVideoAssembly } = await import('./video-assembly-bridge.js');
      cancelVideoAssembly(jobId);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // XTTS Worker Pool handlers (for Play tab real-time TTS with parallel generation)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('play:start-session', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      xttsWorkerPool.setMainWindow(mainWindow);
      const result = await xttsWorkerPool.startSession();
      return { success: result.success, data: { voices: result.voices }, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:load-voice', async (_event, voice: string) => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      const result = await xttsWorkerPool.loadVoice(voice);
      return { success: result.success, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:end-session', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      await xttsWorkerPool.endSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:is-session-active', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      const active = xttsWorkerPool.isSessionActive();
      return { success: true, data: { active } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── TTS service: the engine pinned as a resident service ──
  // Unlike the implicit play-button start, service mode survives listen-window
  // close and idle timeout, so external clients (e.g. a browser extension) can
  // rely on it. State changes broadcast on 'tts-service:state' to all windows;
  // the main process is the single source of truth.

  ipcMain.handle('tts-service:start', async (_event, voice?: string) => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      xttsWorkerPool.setServiceMode(true);
      const result = await xttsWorkerPool.startSession();
      if (!result.success) {
        xttsWorkerPool.setServiceMode(false);
        return { success: false, error: result.error };
      }
      // Warm a voice so the first request speaks within seconds
      const warmVoice = voice || xttsWorkerPool.getCurrentVoice() || xttsWorkerPool.getLastVoice() || 'ScarlettJohansson';
      const loaded = await xttsWorkerPool.loadVoice(warmVoice);
      if (!loaded.success) {
        console.warn('[MAIN] TTS service: voice warm-up failed:', loaded.error);
      }
      return { success: true, voices: result.voices };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts-service:stop', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      xttsWorkerPool.setServiceMode(false);
      await xttsWorkerPool.endSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts-service:status', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      return {
        success: true,
        state: xttsWorkerPool.getEngineState(),
        serviceMode: xttsWorkerPool.isServiceMode()
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── TTS API server: WebSocket access for external clients (browser extension) ──

  ipcMain.handle('tts-api:status', async () => {
    try {
      const { ttsApiServer } = await import('./tts-api-server.js');
      return { success: true, data: ttsApiServer.getStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts-api:configure', async (_event, updates: { port?: number; host?: string }) => {
    try {
      const { ttsApiServer } = await import('./tts-api-server.js');
      ttsApiServer.saveConfig(updates);
      const status = await ttsApiServer.start(app.getPath('userData'));
      return { success: true, data: status };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── Stream engine config: worker count, shared by all streaming clients ──

  ipcMain.handle('tts-stream:get-worker-config', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      return { success: true, data: xttsWorkerPool.getStreamWorkerConfig() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts-stream:set-worker-config', async (_event, updates: { enabled?: boolean; count?: number }) => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      return { success: true, data: xttsWorkerPool.setStreamWorkerConfig(updates) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── Optional Component System: catalog/probe/install bridge ──
  // These return the contract types raw (ComponentStatus[], SystemProfile, …);
  // thrown errors propagate to the renderer's promise as a rejection.

  ipcMain.handle('components:list', async () => {
    return componentManager.listStatus();
  });

  ipcMain.handle('components:get', async (_event, id: string) => {
    return componentManager.getStatus(id);
  });

  ipcMain.handle('components:probe', async (_event, force?: boolean) => {
    return systemProbe.profile(force);
  });

  ipcMain.handle('components:detect', async (_event, id: string) => {
    return componentManager.detectExternal(id);
  });

  ipcMain.handle('components:set-path', async (_event, id: string, entryPath: string) => {
    return componentManager.setExternalPath(id, entryPath);
  });

  ipcMain.handle('components:install', async (event, id: string) => {
    const result = await componentManager.install(id, (p) => {
      event.sender.send('components:progress', p);
    });
    // A newly-downloaded voice should appear in external clients (extension)
    // without a reconnect.
    void refreshTtsApiVoices();
    return result;
  });

  ipcMain.handle('components:cancel', async (_event, id: string) => {
    return componentManager.cancel(id);
  });

  // External tools (Calibre/Tesseract): download the right OS installer + launch
  // it. Progress rides the same components:progress channel as managed installs.
  ipcMain.handle('components:run-installer', async (event, id: string) => {
    return runExternalInstaller(id, (p) => {
      event.sender.send('components:progress', p);
    });
  });

  // Which components have a downloadable installer for this OS (+ any post-launch
  // note), so the renderer can show "Download & Install" instead of instructions.
  ipcMain.handle('components:installers', async () => {
    const ids = listInstallableIds();
    const notes: Record<string, string | null> = {};
    for (const id of ids) notes[id] = installerNote(id);
    return { ids, notes };
  });

  ipcMain.handle('components:uninstall', async (_event, id: string) => {
    const result = await componentManager.uninstall(id);
    void refreshTtsApiVoices();
    return result;
  });

  ipcMain.handle('components:test-env', async (_event, id: string) => {
    return componentManager.testEnv(id);
  });

  // ── RVC enhancement voices ────────────────────────────────────────────────
  // RVC voice models are first-class optional components (kind 'rvc-model') and
  // flow through the SAME components:* IPC + ComponentService as XTTS voices —
  // download, status, and removal are handled there (see rvc-voice-components.ts
  // + component-manager's fetchRvcVoice). No dedicated RVC-voice IPC remains.

  // ─────────────────────────────────────────────────────────────────────────────
  // Custom (user-added) XTTS voices — Play tab + browser extension
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('custom-voices:list', async () => {
    try {
      const { listCustomVoices } = await import('./custom-voices.js');
      return { success: true, data: listCustomVoices() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Voices selectable for full-audiobook generation — installed voices only, so
  // every option works even though BookForge no longer bundles every clip.
  ipcMain.handle('voices:list-audiobook', async () => {
    try {
      const { getAudiobookVoiceOptions } = await import('./components/installed-voices.js');
      return { success: true, data: await getAudiobookVoiceOptions() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Pick a checkpoint folder, validate it, and register it as a custom voice.
  ipcMain.handle('custom-voices:add', async () => {
    try {
      if (!mainWindow) return { success: false, error: 'No window' };
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Select a fine-tuned XTTS voice folder',
        message: 'Pick the folder containing config.json, model.pth, vocab.json and a reference .wav',
        properties: ['openDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const [{ addCustomVoiceFromFolder }, { getStreamVoices }] = await Promise.all([
        import('./custom-voices.js'),
        import('./xtts-voices.js'),
      ]);
      // Reserve existing catalog ids so a custom voice can't shadow a built-in one.
      const reserved = new Set(getStreamVoices().map((v) => v.id));
      const result = addCustomVoiceFromFolder(picked.filePaths[0], reserved);
      if (result.success) void refreshTtsApiVoices();
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('custom-voices:remove', async (_event, id: string) => {
    try {
      const { removeCustomVoice } = await import('./custom-voices.js');
      const result = removeCustomVoice(id);
      void refreshTtsApiVoices();
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Local AI (bundled llama.cpp) — AI Setup wizard + offline cleanup (WS2)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('ai:local-status', async () => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      return { success: true, data: await llamaBridge.status() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:local-system-info', async () => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      return { success: true, data: await llamaBridge.systemInfo() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:local-list-models', async () => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      return { success: true, data: await llamaBridge.listModels() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:local-download-model', async (event, modelId: string) => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      const result = await llamaBridge.downloadModel(modelId, (p) => {
        event.sender.send('ai:local-model-progress', p);
      });
      return { success: result.ok, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:local-cancel-download', async (_event, modelId: string) => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      llamaBridge.cancelDownload(modelId);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:local-delete-model', async (_event, modelId: string) => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      return llamaBridge.deleteModel(modelId);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('ai:local-set-active', async (_event, modelId: string) => {
    try {
      const { llamaBridge } = await import('./llama-bridge.js');
      return llamaBridge.setActive(modelId);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Stream scheduler: main-process generation orchestration for the Play tab.
  // The renderer sends the sentence list once; audio comes back as
  // 'stream:event' broadcasts (chunked pcm16 for the playhead sentence,
  // whole sentences for lookahead).
  ipcMain.handle('stream:start', async (
    _event,
    sentences: string[],
    startIndex: number,
    settings: { voice: string; speed: number; temperature?: number; topP?: number; repetitionPenalty?: number },
    requestId: number
  ) => {
    try {
      const { streamScheduler } = await import('./stream-scheduler.js');
      // The Play tab streams a whole book as one session, so it uses a small
      // rolling window (vs the extension's deep per-block default): 45s refills
      // faster than playback drains it, and a deep window would burn minutes of
      // compute on audio the listener may never reach.
      return streamScheduler.start(sentences, startIndex, settings, requestId, undefined, {
        lookaheadSeconds: 45
      });
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('stream:stop', async () => {
    try {
      const { streamScheduler } = await import('./stream-scheduler.js');
      streamScheduler.stop();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('stream:playhead', async (_event, requestId: number, sentenceIndex: number) => {
    try {
      const { streamScheduler } = await import('./stream-scheduler.js');
      streamScheduler.reportPlayhead(requestId, sentenceIndex);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:get-voices', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      // Full catalog (id, name, group) so the dropdown can label and group
      // voices; available before the engine starts.
      const voices = xttsWorkerPool.getVoiceCatalog();
      return { success: true, data: { voices } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Audiobook Project handlers
  // Each audiobook is a folder containing: exported.epub, cleaned.epub/simplified.epub (optional), project.json, output.m4b
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Base path for audiobook project folders.
   * These now live under projects/ alongside UUID manifest dirs and BFP files.
   */
  const getAudiobooksBasePath = () => {
    return path.join(getLibraryRoot(), 'projects');
  };

  // Helper to generate a unique project folder name (with timestamp for uniqueness)
  const generateProjectId = (filename: string): string => {
    const baseName = toAsciiSlug(filename.replace(/\.epub$/i, ''));
    const timestamp = Date.now().toString(36);
    return `${baseName}_${timestamp}`;
  };

  // Helper to find cleaned/simplified epub - checks both filenames without renaming
  const findCleanedEpub = async (folderPath: string): Promise<string | null> => {
    // Check simplified first (most processed)
    const simplifiedPath = path.join(folderPath, 'simplified.epub');
    if (await fs.access(simplifiedPath).then(() => true).catch(() => false)) {
      return simplifiedPath;
    }

    // Then cleaned
    const cleanedPath = path.join(folderPath, 'cleaned.epub');
    if (await fs.access(cleanedPath).then(() => true).catch(() => false)) {
      return cleanedPath;
    }

    return null;
  };

  // Helper to generate a stable project ID (without timestamp, for deduplication)
  const generateStableProjectId = (filename: string): string => {
    return toAsciiSlug(filename.replace(/\.epub$/i, ''));
  };

  // Helper to find existing project folder by stable ID prefix
  const findExistingProject = async (basePath: string, stableId: string): Promise<string | null> => {
    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      // Look for folders that start with the stable ID
      // This handles both old timestamped IDs and new stable IDs
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Match exact stable ID or stable ID followed by underscore and timestamp
          if (entry.name === stableId || entry.name.startsWith(stableId + '_')) {
            return path.join(basePath, entry.name);
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  // Helper to load project.json from a folder
  const loadProjectFile = async (folderPath: string): Promise<any | null> => {
    try {
      const projectJsonPath = path.join(folderPath, 'project.json');
      const content = await fs.readFile(projectJsonPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  };

  // Helper to save project.json
  const saveProjectFile = async (folderPath: string, data: any): Promise<void> => {
    const projectJsonPath = path.join(folderPath, 'project.json');
    await fs.writeFile(projectJsonPath, JSON.stringify(data, null, 2), 'utf-8');
  };

  // Create a new audiobook project from an EPUB file
  ipcMain.handle('audiobook:create-project', async (_event, sourcePath: string, originalFilename: string) => {
    try {
      const basePath = getAudiobooksBasePath();
      await fs.mkdir(basePath, { recursive: true });

      // Generate unique project ID/folder name
      const projectId = generateProjectId(originalFilename);
      const folderPath = path.join(basePath, projectId);
      await fs.mkdir(folderPath, { recursive: true });

      // Copy EPUB as exported.epub (standard name for source epub in audiobook folder)
      const originalPath = path.join(folderPath, 'exported.epub');

      if (sourcePath.startsWith('data:')) {
        // Handle base64 data URL
        const matches = sourcePath.match(/^data:[^;]+;base64,(.+)$/);
        if (!matches || !matches[1]) {
          return { success: false, error: 'Invalid data URL format' };
        }
        const buffer = Buffer.from(matches[1], 'base64');
        await fs.writeFile(originalPath, buffer);
      } else {
        // Copy from file path
        await fs.copyFile(sourcePath, originalPath);
      }

      // Create initial project.json
      const now = new Date().toISOString();
      const projectData = {
        version: 1,
        originalFilename,
        metadata: {
          title: '',
          author: '',
          language: 'en'
        },
        state: {
          cleanupStatus: 'none',
          ttsStatus: 'none'
        },
        createdAt: now,
        modifiedAt: now
      };

      await saveProjectFile(folderPath, projectData);

      return {
        success: true,
        projectId,
        folderPath,
        originalPath
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // List all audiobook projects
  ipcMain.handle('audiobook:list-projects', async () => {
    try {
      const basePath = getAudiobooksBasePath();

      try {
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        const folders = entries.filter(e => e.isDirectory());

        const projects = await Promise.all(folders.map(async (folder) => {
          const folderPath = path.join(basePath, folder.name);
          const projectData = await loadProjectFile(folderPath);

          if (!projectData) {
            return null; // Not a valid project folder
          }

          // Check which files exist (exported.epub is new name, original.epub is legacy)
          const [hasExported, hasOriginalLegacy, cleanedPath, hasOutput] = await Promise.all([
            fs.access(path.join(folderPath, 'exported.epub')).then(() => true).catch(() => false),
            fs.access(path.join(folderPath, 'original.epub')).then(() => true).catch(() => false),
            findCleanedEpub(folderPath),
            fs.access(path.join(folderPath, 'output.m4b')).then(() => true).catch(() => false)
          ]);
          const hasOriginal = hasExported || hasOriginalLegacy;
          const hasCleaned = cleanedPath !== null;
          const cleanedFilename = cleanedPath ? path.basename(cleanedPath) : null;

          return {
            id: folder.name,
            folderPath,
            originalFilename: projectData.originalFilename,
            metadata: projectData.metadata,
            state: projectData.state,
            hasOriginal,
            hasCleaned,
            cleanedFilename,
            hasOutput,
            createdAt: projectData.createdAt,
            modifiedAt: projectData.modifiedAt
          };
        }));

        // Filter out null (invalid folders) and sort by modifiedAt descending
        const validProjects = projects
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

        return { success: true, projects: validProjects };
      } catch {
        // Folder doesn't exist yet
        return { success: true, projects: [] };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get a single project's details
  ipcMain.handle('audiobook:get-project', async (_event, projectId: string) => {
    try {
      const basePath = getAudiobooksBasePath();
      const folderPath = path.join(basePath, projectId);

      const projectData = await loadProjectFile(folderPath);
      if (!projectData) {
        return { success: false, error: 'Project not found' };
      }

      const [hasExported, hasOriginalLegacy, cleanedPath, hasOutput] = await Promise.all([
        fs.access(path.join(folderPath, 'exported.epub')).then(() => true).catch(() => false),
        fs.access(path.join(folderPath, 'original.epub')).then(() => true).catch(() => false),
        findCleanedEpub(folderPath),
        fs.access(path.join(folderPath, 'output.m4b')).then(() => true).catch(() => false)
      ]);
      const hasOriginal = hasExported || hasOriginalLegacy;
      const hasCleaned = cleanedPath !== null;
      const cleanedFilename = cleanedPath ? path.basename(cleanedPath) : null;

      return {
        success: true,
        project: {
          id: projectId,
          folderPath,
          originalFilename: projectData.originalFilename,
          metadata: projectData.metadata,
          state: projectData.state,
          hasOriginal,
          hasCleaned,
          cleanedFilename,
          hasOutput,
          createdAt: projectData.createdAt,
          modifiedAt: projectData.modifiedAt
        }
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Save project metadata and state
  ipcMain.handle('audiobook:save-project', async (_event, projectId: string, updates: { metadata?: any; state?: any }) => {
    try {
      const basePath = getAudiobooksBasePath();
      const folderPath = path.join(basePath, projectId);

      const projectData = await loadProjectFile(folderPath);
      if (!projectData) {
        return { success: false, error: 'Project not found' };
      }

      // Merge updates
      if (updates.metadata) {
        projectData.metadata = { ...projectData.metadata, ...updates.metadata };
      }
      if (updates.state) {
        projectData.state = { ...projectData.state, ...updates.state };
      }
      projectData.modifiedAt = new Date().toISOString();

      await saveProjectFile(folderPath, projectData);

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete an audiobook project
  ipcMain.handle('audiobook:delete-project', async (_event, projectId: string) => {
    try {
      const basePath = getAudiobooksBasePath();
      const folderPath = path.join(basePath, projectId);

      await fs.rm(folderPath, { recursive: true, force: true });

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get paths for a project (for opening EPUBs, etc.)
  ipcMain.handle('audiobook:get-paths', async (_event, projectId: string) => {
    const basePath = getAudiobooksBasePath();
    const folderPath = path.join(basePath, projectId);

    // Check if exported.epub exists, otherwise fall back to original.epub (legacy)
    const exportedPath = path.join(folderPath, 'exported.epub');
    const legacyPath = path.join(folderPath, 'original.epub');
    const hasExported = await fs.access(exportedPath).then(() => true).catch(() => false);
    const originalPath = hasExported ? exportedPath : legacyPath;

    // Find cleaned/simplified epub (checks simplified.epub > cleaned.epub > legacy)
    const cleanedPath = await findCleanedEpub(folderPath) || path.join(folderPath, 'cleaned.epub');

    return {
      success: true,
      folderPath,
      originalPath,
      cleanedPath,
      outputPath: path.join(folderPath, 'output.m4b')
    };
  });

  // Copy EPUB to audiobook queue (accepts ArrayBuffer directly or file path)
  // If a project with the same filename already exists, it will be replaced
  ipcMain.handle('library:copy-to-queue', async (
    _event,
    data: ArrayBuffer | string,
    filename: string,
    metadata?: {
      title?: string;
      author?: string;
      language?: string;
      coverImage?: string;
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
    }
  ) => {
    try {
      const basePath = getAudiobooksBasePath();
      await fs.mkdir(basePath, { recursive: true });

      // Check if a project with this filename already exists
      const stableId = generateStableProjectId(filename);
      let folderPath = await findExistingProject(basePath, stableId);
      let isReplacing = false;

      // Track original createdAt for replacements
      let existingCreatedAt: string | null = null;

      if (folderPath) {
        // Project exists - load existing data before clearing
        console.log(`[library:copy-to-queue] Replacing existing project: ${folderPath}`);
        isReplacing = true;

        // Load existing project to preserve createdAt
        const existingProject = await loadProjectFile(folderPath);
        if (existingProject?.createdAt) {
          existingCreatedAt = existingProject.createdAt;
        }

        // Remove old files (exported.epub, original.epub (legacy), cleaned epubs, project.json)
        // Include cleaned.epub, simplified.epub, and exported_cleaned.epub for legacy cleanup
        const filesToRemove = ['exported.epub', 'original.epub', 'cleaned.epub', 'simplified.epub', 'exported_cleaned.epub', 'project.json'];
        for (const file of filesToRemove) {
          try {
            await fs.unlink(path.join(folderPath, file));
          } catch {
            // File may not exist, that's fine
          }
        }
        // Remove old cover files (cover.png, cover.jpg, etc.)
        try {
          const entries = await fs.readdir(folderPath);
          for (const entry of entries) {
            if (entry.startsWith('cover.')) {
              await fs.unlink(path.join(folderPath, entry));
            }
          }
        } catch {
          // Ignore errors
        }
      } else {
        // Create new project folder with stable ID (no timestamp for easier deduplication)
        folderPath = path.join(basePath, stableId);
        await fs.mkdir(folderPath, { recursive: true });
        console.log(`[library:copy-to-queue] Creating new project: ${folderPath}`);
      }

      const originalPath = path.join(folderPath, 'exported.epub');

      // Handle different input types
      if (data instanceof ArrayBuffer || (data && typeof data === 'object' && 'byteLength' in data)) {
        // ArrayBuffer from renderer - write directly
        const buffer = Buffer.from(data as ArrayBuffer);
        await fs.writeFile(originalPath, buffer);
      } else if (typeof data === 'string' && data.startsWith('data:')) {
        // Legacy: base64 data URL
        const matches = data.match(/^data:[^;]+;base64,(.+)$/);
        if (!matches || !matches[1]) {
          return { success: false, error: 'Invalid data URL format' };
        }
        const buffer = Buffer.from(matches[1], 'base64');
        await fs.writeFile(originalPath, buffer);
      } else if (typeof data === 'string') {
        // File path - copy the file
        await fs.copyFile(data, originalPath);
      } else {
        return { success: false, error: 'Invalid data format' };
      }

      // Save cover image if provided
      let coverPath: string | undefined;
      if (metadata?.coverImage?.startsWith('data:image/')) {
        const coverMatches = metadata.coverImage.match(/^data:image\/(\w+);base64,(.+)$/);
        if (coverMatches && coverMatches[2]) {
          const ext = coverMatches[1] === 'jpeg' ? 'jpg' : coverMatches[1];
          coverPath = path.join(folderPath, `cover.${ext}`);
          const coverBuffer = Buffer.from(coverMatches[2], 'base64');
          await fs.writeFile(coverPath, coverBuffer);
        }
      }

      const now = new Date().toISOString();
      // Use preserved createdAt if replacing, otherwise use now
      const createdAt = existingCreatedAt || now;
      const projectData = {
        version: 1,
        originalFilename: filename,
        metadata: {
          title: metadata?.title || '',
          author: metadata?.author || '',
          language: metadata?.language || 'en',
          coverPath: coverPath ? path.basename(coverPath) : undefined
        },
        state: { cleanupStatus: 'none', ttsStatus: 'none' },
        // Store deleted block examples for detailed AI cleanup
        deletedBlockExamples: metadata?.deletedBlockExamples,
        createdAt: createdAt,
        modifiedAt: now
      };
      await saveProjectFile(folderPath, projectData);

      if (metadata?.deletedBlockExamples?.length) {
        console.log(`[library:copy-to-queue] Saved ${metadata.deletedBlockExamples.length} deleted block examples for detailed cleanup`);
      }

      console.log(`[library:copy-to-queue] ${isReplacing ? 'Replaced' : 'Created'} project at: ${folderPath}`);
      return { success: true, destinationPath: originalPath, replaced: isReplacing };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('library:list-queue', async () => {
    // Redirect to list-projects, convert to old format
    const basePath = getAudiobooksBasePath();
    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const folders = entries.filter(e => e.isDirectory());

      const files = await Promise.all(folders.map(async (folder) => {
        const folderPath = path.join(basePath, folder.name);
        const projectData = await loadProjectFile(folderPath);

        try {
          // Try exported.epub first (new naming), fall back to original.epub (legacy)
          let epubPath = path.join(folderPath, 'exported.epub');
          let stats;
          try {
            stats = await fs.stat(epubPath);
          } catch {
            // Fall back to original.epub for legacy folders
            epubPath = path.join(folderPath, 'original.epub');
            stats = await fs.stat(epubPath);
          }

          const skippedChunksFile = path.join(folderPath, 'skipped-chunks.json');
          const [hasSkippedChunks, cleanedPath] = await Promise.all([
            fs.access(skippedChunksFile).then(() => true).catch(() => false),
            findCleanedEpub(folderPath)
          ]);
          return {
            path: epubPath,
            filename: projectData?.originalFilename || folder.name + '.epub',
            size: stats.size,
            addedAt: projectData?.createdAt || stats.mtime.toISOString(),
            projectId: folder.name,
            hasCleaned: cleanedPath !== null,
            cleanedFilename: cleanedPath ? path.basename(cleanedPath) : null,
            skippedChunksPath: hasSkippedChunks ? skippedChunksFile : undefined
          };
        } catch {
          return null;
        }
      }));

      return { success: true, files: files.filter((f): f is NonNullable<typeof f> => f !== null) };
    } catch {
      return { success: true, files: [] };
    }
  });

  ipcMain.handle('library:get-audiobooks-path', async () => {
    // Legacy handler - callers should scan projects/*/output/ instead
    const projectsPath = getProjectsFolder();
    return {
      success: true,
      queuePath: projectsPath,
      completedPath: projectsPath
    };
  });

  // List completed audiobooks (m4b files) from project output/ dirs or a specified folder
  ipcMain.handle('library:list-completed', async (_event, folderPath?: string) => {
    try {
      if (folderPath) {
        // External folder provided — scan it directly for m4b files
        try {
          await fs.access(folderPath);
        } catch {
          return { success: true, files: [] };
        }

        const entries = await fs.readdir(folderPath, { withFileTypes: true });
        const m4bFiles = entries.filter(e =>
          e.isFile() &&
          e.name.toLowerCase().endsWith('.m4b') &&
          !e.name.startsWith('.') &&
          !e.name.startsWith('._')
        );

        const files = await Promise.all(m4bFiles.map(async (file) => {
          const fp = path.join(folderPath, file.name);
          const stats = await fs.stat(fp);
          return {
            path: fp,
            filename: file.name,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            createdAt: stats.birthtime.toISOString()
          };
        }));

        files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
        return { success: true, files };
      }

      // No folder provided — scan projects/*/output/ for m4b files
      const projectsDir = getProjectsFolder();
      try {
        await fs.access(projectsDir);
      } catch {
        return { success: true, files: [] };
      }

      const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
      const allFiles: Array<{ path: string; filename: string; size: number; modifiedAt: string; createdAt: string }> = [];

      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue;
        const outputDir = path.join(projectsDir, entry.name, 'output');
        try {
          const outputEntries = await fs.readdir(outputDir, { withFileTypes: true });
          const m4bFiles = outputEntries.filter(e =>
            e.isFile() &&
            e.name.toLowerCase().endsWith('.m4b') &&
            !e.name.startsWith('.') &&
            !e.name.startsWith('._')
          );
          for (const m4b of m4bFiles) {
            const fp = path.join(outputDir, m4b.name);
            const stats = await fs.stat(fp);
            allFiles.push({
              path: fp,
              filename: m4b.name,
              size: stats.size,
              modifiedAt: stats.mtime.toISOString(),
              createdAt: stats.birthtime.toISOString()
            });
          }
        } catch {
          // output/ doesn't exist for this project
        }
      }

      allFiles.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
      return { success: true, files: allFiles };
    } catch (err) {
      return { success: false, error: (err as Error).message, files: [] };
    }
  });

  ipcMain.handle('library:save-metadata', async (_event, epubPath: string, metadata: unknown) => {
    // Find project by epub path and save metadata
    try {
      const basePath = getAudiobooksBasePath();
      // Extract project folder from path
      const relativePath = path.relative(basePath, epubPath);
      const projectId = relativePath.split(path.sep)[0];

      if (projectId) {
        const folderPath = path.join(basePath, projectId);
        const projectData = await loadProjectFile(folderPath);
        if (projectData) {
          projectData.metadata = { ...projectData.metadata, ...(metadata as Record<string, unknown>) };
          projectData.modifiedAt = new Date().toISOString();
          await saveProjectFile(folderPath, projectData);
          return { success: true };
        }
      }
      return { success: false, error: 'Project not found' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('library:load-metadata', async (_event, epubPath: string) => {
    try {
      const basePath = getAudiobooksBasePath();
      const relativePath = path.relative(basePath, epubPath);
      const projectId = relativePath.split(path.sep)[0];

      if (projectId) {
        const folderPath = path.join(basePath, projectId);
        const projectData = await loadProjectFile(folderPath);
        if (projectData) {
          // Include deletedBlockExamples in the returned metadata for detailed cleanup
          return {
            success: true,
            metadata: {
              ...projectData.metadata,
              deletedBlockExamples: projectData.deletedBlockExamples
            }
          };
        }
      }
      return { success: true, metadata: null };
    } catch {
      return { success: true, metadata: null };
    }
  });

  // Load cover image from project folder
  ipcMain.handle('library:load-cover-image', async (_event, projectId: string, coverFilename: string) => {
    try {
      const basePath = getAudiobooksBasePath();
      const coverPath = path.join(basePath, projectId, coverFilename);

      // Check if file exists
      try {
        await fs.access(coverPath);
      } catch {
        return { success: false, error: 'Cover file not found' };
      }

      // Read file and convert to base64 data URL
      const buffer = await fs.readFile(coverPath);
      const ext = path.extname(coverFilename).toLowerCase().slice(1);
      const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      const base64 = buffer.toString('base64');
      const coverData = `data:${mimeType};base64,${base64}`;

      return { success: true, coverData };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Load deleted block examples from a linked BFP project file
  // This allows using deletion examples from existing projects without re-exporting
  ipcMain.handle('library:load-deleted-examples-from-bfp', async (_event, epubPath: string) => {
    try {
      const audiobooksBase = getAudiobooksBasePath();
      const relativePath = path.relative(audiobooksBase, epubPath);
      const projectId = relativePath.split(path.sep)[0];

      if (!projectId) {
        return { success: true, examples: [] };
      }

      // Load audiobook project to get original filename
      const folderPath = path.join(audiobooksBase, projectId);
      const projectData = await loadProjectFile(folderPath);
      if (!projectData?.originalFilename) {
        return { success: true, examples: [] };
      }

      // Search for BFP projects with matching source name
      const projectsFolder = path.join(getLibraryRoot(), 'projects');
      try {
        await fs.access(projectsFolder);
      } catch {
        return { success: true, examples: [] };
      }

      const entries = await fs.readdir(projectsFolder, { withFileTypes: true });
      const bfpFiles = entries.filter(e => e.isFile() && e.name.endsWith('.bfp'));

      // Find BFP projects that might match
      for (const bfpFile of bfpFiles) {
        try {
          const bfpPath = path.join(projectsFolder, bfpFile.name);
          const bfpContent = await fs.readFile(bfpPath, 'utf-8');
          const bfpProject = JSON.parse(bfpContent);

          // Check if source name matches - try multiple matching strategies
          const bfpSourceBase = bfpProject.source_name?.replace(/\.(pdf|epub)$/i, '');
          const audiobookBase = projectData.originalFilename?.replace(/\.(pdf|epub)$/i, '');
          const audiobookTitle = projectData.metadata?.title;

          // Normalize strings for comparison (remove underscores, clean dates, lowercase)
          const normalize = (s: string) => s
            ?.toLowerCase()
            .replace(/_cleaned_\d{4}-\d{2}-\d{2}/g, '') // Remove _cleaned_YYYY-MM-DD suffix
            .replace(/[_\-]+/g, ' ')  // Underscores/dashes to spaces
            .replace(/\s+/g, ' ')     // Collapse multiple spaces
            .replace(/[()]/g, '')     // Remove parentheses
            .trim();

          const normalizedBfp = normalize(bfpSourceBase || '');
          const normalizedAudiobook = normalize(audiobookBase || '');
          const normalizedTitle = normalize(audiobookTitle || '');

          // Match if normalized names are similar or title contains the BFP source name
          const isMatch = (normalizedBfp && normalizedAudiobook && normalizedBfp === normalizedAudiobook) ||
                          (normalizedBfp && normalizedTitle && normalizedTitle.includes(normalizedBfp)) ||
                          (normalizedBfp && normalizedAudiobook && normalizedAudiobook.includes(normalizedBfp));

          if (isMatch) {
            console.log(`[BFP] Found matching project: ${bfpFile.name} for audiobook "${audiobookTitle || audiobookBase}"`);
            // Found matching BFP project - need to extract deleted block text
            const deletedBlockIds = new Set<string>(bfpProject.deleted_block_ids || []);
            const deletedHighlightIds = new Set<string>(bfpProject.deleted_highlight_ids || []);

            if (deletedBlockIds.size === 0 && deletedHighlightIds.size === 0) {
              continue; // No deletions in this project
            }

            // Try to analyze the source document to get block text
            const sourcePath = bfpProject.library_path || bfpProject.source_path;
            if (!sourcePath) continue;

            try {
              await fs.access(sourcePath);
            } catch {
              console.log(`[BFP] Source file not found: ${sourcePath}`);
              continue;
            }

            // Analyze document to get blocks
            const analysisResult = await pdfWorkerProxy.call('analyze', [sourcePath, undefined]);
            if (!analysisResult?.blocks) continue;

            // Collect deleted block examples
            const examples: Array<{ text: string; category: string; page?: number }> = [];
            const seenTexts = new Set<string>();
            const MAX_EXAMPLES = 30;
            const MIN_TEXT_LENGTH = 3;
            const MAX_TEXT_LENGTH = 200;

            for (const block of analysisResult.blocks) {
              if (!deletedBlockIds.has(block.id)) continue;
              if (block.is_image) continue;

              const text = block.text.trim();
              if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) continue;
              if (seenTexts.has(text.toLowerCase())) continue;
              seenTexts.add(text.toLowerCase());

              // Categorize based on position
              let category: string = 'block';
              if (/^[\d\-—–\s]+$/.test(text) && text.length < 10) {
                category = 'page_number';
              } else if (block.y < 80) {
                category = 'header';
              } else if (block.y > 700) {
                category = 'footer';
              }

              examples.push({ text, category, page: block.page });
              if (examples.length >= MAX_EXAMPLES) break;
            }

            if (examples.length > 0) {
              console.log(`[BFP] Loaded ${examples.length} deleted block examples from ${bfpFile.name}`);
              return { success: true, examples };
            }
          }
        } catch (err) {
          // Skip invalid BFP files
          continue;
        }
      }

      return { success: true, examples: [] };
    } catch (err) {
      console.error('Failed to load deleted examples from BFP:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Unified Audiobook Export - saves EPUB and updates BFP project
  // ─────────────────────────────────────────────────────────────────────────────

  // Get output folder for a BFP project (now under projects/{name}/output/)
  const getAudiobookFolderForProject = (projectName: string) => {
    return path.join(getProjectsFolder(), projectName, 'output');
  };

  // Export EPUB to audiobook folder and update BFP project with audiobook state
  ipcMain.handle('audiobook:export-from-project', async (
    _event,
    bfpPath: string,
    epubData: ArrayBuffer,
    deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>,
    savePath?: string
  ) => {
    try {
      // Check if bfpPath is a manifest project directory
      const isDir = fsSync.existsSync(bfpPath) && fsSync.statSync(bfpPath).isDirectory();

      if (isDir) {
        // Manifest project directory - save exported EPUB to source/ and update manifest
        const manifestPath = path.join(bfpPath, 'manifest.json');
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);

        // Save the exported EPUB — to savePath if provided, otherwise source/exported.epub
        let epubPath: string;
        if (savePath) {
          epubPath = savePath;
          await fs.mkdir(path.dirname(savePath), { recursive: true });
        } else {
          const sourceDir = path.join(bfpPath, 'source');
          await fs.mkdir(sourceDir, { recursive: true });
          epubPath = path.join(sourceDir, 'exported.epub');
        }
        const epubBuffer = Buffer.from(epubData);
        await fs.writeFile(epubPath, epubBuffer);

        // Merge fragmented paragraphs (line-level PDF blocks → sentence-aligned paragraphs)
        await mergeEpubParagraphs(epubPath);

        // Verify the file was written
        const stat = await fs.stat(epubPath);
        console.log(`[audiobook:export-from-project] Wrote EPUB: ${stat.size} bytes to ${epubPath}`);

        // Save deleted block examples if provided (next to the saved EPUB)
        if (deletedBlockExamples && deletedBlockExamples.length > 0) {
          const examplesPath = path.join(path.dirname(epubPath), 'deleted-examples.json');
          await fs.writeFile(examplesPath, JSON.stringify(deletedBlockExamples, null, 2));
        }

        // Update manifest
        manifest.modifiedAt = new Date().toISOString();
        await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));

        // Notify main window that project files changed
        mainWindow?.webContents.send('project:files-changed', bfpPath);

        return {
          success: true,
          audiobookFolder: bfpPath,
          epubPath
        };
      }

      // Legacy BFP file path
      // Read the BFP project
      const bfpContent = await fs.readFile(bfpPath, 'utf-8');
      const bfpProject = JSON.parse(bfpContent);

      // Create audiobook folder named after the project
      const projectName = path.basename(bfpPath, '.bfp');
      const audiobookFolder = getAudiobookFolderForProject(projectName);
      await fs.mkdir(audiobookFolder, { recursive: true });

      // Save the EPUB
      const epubPath = path.join(audiobookFolder, 'exported.epub');
      await fs.writeFile(epubPath, Buffer.from(epubData));

      // Save deleted block examples if provided
      if (deletedBlockExamples && deletedBlockExamples.length > 0) {
        const examplesPath = path.join(audiobookFolder, 'deleted-examples.json');
        await fs.writeFile(examplesPath, JSON.stringify(deletedBlockExamples, null, 2));
      }

      // Create project.json in audiobook folder with metadata from BFP
      // This is the source of truth for reassembly metadata
      const projectJsonPath = path.join(audiobookFolder, 'project.json');
      const projectJson = {
        id: bfpProject.id || projectName,
        version: 1,
        metadata: {
          title: bfpProject.metadata?.title,
          author: bfpProject.metadata?.author,
          year: bfpProject.metadata?.year,
          coverPath: bfpProject.metadata?.coverPath,
          narrator: bfpProject.metadata?.narrator,
          series: bfpProject.metadata?.series,
          seriesNumber: bfpProject.metadata?.seriesNumber,
          genre: bfpProject.metadata?.genre,
          description: bfpProject.metadata?.description,
          outputFilename: bfpProject.metadata?.outputFilename
        },
        state: {
          step: 'exported'
        },
        createdAt: new Date().toISOString()
      };
      await fs.writeFile(projectJsonPath, JSON.stringify(projectJson, null, 2));

      // Update BFP project with audiobook state
      bfpProject.audiobook = {
        status: 'pending',
        exportedEpubPath: epubPath,
        exportedAt: new Date().toISOString()
      };
      bfpProject.modified_at = new Date().toISOString();

      // Save updated BFP
      await atomicWriteFile(bfpPath, JSON.stringify(bfpProject, null, 2));

      console.log(`[audiobook:export-from-project] Exported to ${audiobookFolder}`);

      return {
        success: true,
        audiobookFolder,
        epubPath
      };
    } catch (err) {
      console.error('[audiobook:export-from-project] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Extract metadata from an EPUB file without importing it
  // Used to pre-populate the metadata confirmation modal
  ipcMain.handle('audiobook:extract-epub-metadata', async (
    _event,
    epubSourcePath: string
  ) => {
    try {
      const { EpubProcessor } = await import('./epub-processor.js');
      const processor = new EpubProcessor();
      const structure = await processor.open(epubSourcePath);

      const metadata = structure.metadata;
      let coverData: string | null = null;
      const coverBuffer = await processor.getCover();
      if (coverBuffer) {
        let mimeType = 'image/jpeg';
        if (coverBuffer[0] === 0x89 && coverBuffer[1] === 0x50) {
          mimeType = 'image/png';
        }
        coverData = `data:${mimeType};base64,${coverBuffer.toString('base64')}`;
      }
      processor.close();

      // Resolve author display name: prefer contributors (parsed from opf:file-as),
      // then detect "Last, First" in raw dc:creator and flip to "First Last"
      let authorDisplay = metadata?.author || '';
      if (metadata?.contributors && metadata.contributors.length > 0) {
        // Build "First Last" from contributors
        authorDisplay = metadata.contributors
          .map(c => [c.first, c.last].filter(Boolean).join(' '))
          .join(', ') || authorDisplay;
      } else if (authorDisplay.includes(',') && !authorDisplay.includes(' and ')) {
        // Raw dc:creator is likely "Last, First" — flip it
        const parts = authorDisplay.split(',').map(s => s.trim());
        if (parts.length === 2 && parts[1]) {
          authorDisplay = `${parts[1]} ${parts[0]}`;
        }
      }

      return {
        success: true,
        metadata: {
          title: metadata?.title || '',
          author: authorDisplay,
          year: metadata?.year || '',
          language: metadata?.language || 'en',
          coverData,
        }
      };
    } catch (err) {
      console.error('[audiobook:extract-epub-metadata] Error:', err);
      // Fall back to filename parsing using the shared library convention parser
      const parsed = ebookLibrary.parseFilename(path.basename(epubSourcePath));
      return {
        success: true,
        metadata: {
          title: parsed.title || '',
          author: parsed.authorFull || parsed.authorLast || '',
          year: parsed.year?.toString() || '',
          language: parsed.language || 'en',
          coverData: null,
        }
      };
    }
  });

  // Import an EPUB file directly - creates both BFP and audiobook folder
  // This is for adding EPUBs via drag/drop without going through the PDF editor
  ipcMain.handle('audiobook:import-epub', async (
    _event,
    epubSourcePath: string,
    confirmedMetadata?: { title: string; author: string; year?: string; language?: string; subtitle?: string; coverData?: string }
  ) => {
    try {
      const filename = path.basename(epubSourcePath);
      const ext = path.extname(filename).toLowerCase();

      // ── Duplicate guard ──────────────────────────────────────────────────
      // Never import the same source file twice. Compare a content hash against
      // every existing project's stored source.fileHash; for older projects that
      // predate hashing, fall back to hashing their source file only when its
      // size matches (cheap — avoids re-hashing the whole library each import).
      const sha256File = (p: string): Promise<string> => new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const stream = fsSync.createReadStream(p);
        stream.on('error', reject);
        stream.on('data', (d) => h.update(d));
        stream.on('end', () => resolve(h.digest('hex')));
      });
      const importHash = await sha256File(epubSourcePath);
      const importSize = (await fs.stat(epubSourcePath)).size;
      {
        const existingFolder = getProjectsFolder();
        let names: string[] = [];
        try { names = await fs.readdir(existingFolder); } catch { /* no projects yet */ }
        for (const name of names) {
          const dir = path.join(existingFolder, name);
          let mf: any;
          try { mf = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8')); }
          catch { continue; }
          let match = false;
          if (mf.source?.fileHash) {
            match = mf.source.fileHash === importHash;
          } else {
            try {
              const srcDir = path.join(dir, 'source');
              const orig = (await fs.readdir(srcDir)).find((f) => f.startsWith('original.'));
              if (orig) {
                const st = await fs.stat(path.join(srcDir, orig));
                if (st.size === importSize) {
                  match = (await sha256File(path.join(srcDir, orig))) === importHash;
                }
              }
            } catch { /* unreadable project — skip */ }
          }
          if (match) {
            const dupTitle = mf.metadata?.title || name;
            console.log(`[audiobook:import] Duplicate of existing project "${name}" — skipping import`);
            return {
              success: false,
              duplicate: true,
              existingProjectId: name,
              existingTitle: dupTitle,
              error: `“${dupTitle}” is already in your library — skipped to avoid a duplicate.`,
            };
          }
        }
      }

      let title: string;
      let author: string;
      let authorFileAs: string | undefined;
      let year: number | undefined;
      let language = 'en';
      let subtitle: string | undefined;

      if (confirmedMetadata) {
        // Use metadata confirmed by the user
        title = confirmedMetadata.title;
        author = confirmedMetadata.author;
        year = confirmedMetadata.year ? parseInt(confirmedMetadata.year) : undefined;
        language = confirmedMetadata.language || 'en';
        subtitle = confirmedMetadata.subtitle;
      } else {
        // Fall back to filename parsing using the shared library convention parser
        const parsed = ebookLibrary.parseFilename(filename);
        title = parsed.title || filename.replace(/\.[^.]+$/i, '');
        year = parsed.year;
        language = parsed.language || 'en';
        subtitle = parsed.subtitle;
        // Build display author as "First Last", preserve "Last, First" as authorFileAs
        if (parsed.authorFirst && parsed.authorLast) {
          author = `${parsed.authorFirst} ${parsed.authorLast}`;
          authorFileAs = `${parsed.authorLast}, ${parsed.authorFirst}`;
        } else {
          author = parsed.authorLast || parsed.authorFull || 'Unknown';
        }
      }

      // Generate human-readable, ASCII-only slug for folder name.
      // Non-ASCII chars (e.g. á, é, ñ) are transliterated to their base letter. This
      // sidesteps macOS/Windows Unicode normalization differences that cause fs.access
      // to fail on Windows when the stored path and on-disk folder use different forms.
      const cleanTitle = toAsciiSlug(title.replace(/\s+/g, '_'));
      const cleanAuthor = toAsciiSlug(author.replace(/\s+/g, '_'));
      const yearStr = year ? `_(${year})` : '';
      let slug = toAsciiSlug(`${cleanTitle}_-_${cleanAuthor}${yearStr}`).substring(0, 150);

      // Create project directory with human-readable name
      const projectsFolder = getProjectsFolder();
      const projectPath = path.join(projectsFolder, slug);

      // Check if project already exists
      if (fsSync.existsSync(projectPath)) {
        // Add timestamp to make unique
        const timestamp = Date.now();
        slug = `${slug}_${timestamp}`;
      }

      // Create the project structure — only source, archive, and output dirs
      // Stage dirs (01-cleanup, 02-translate, 03-tts) are created when those stages actually run
      const projectDir = path.join(projectsFolder, slug);
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(path.join(projectDir, 'source'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'archive'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'output'), { recursive: true });

      // Determine source type and copy file
      const isEpub = ext === '.epub';
      const isPdf = ext === '.pdf';
      const sourceType = isEpub ? 'epub' : isPdf ? 'pdf' : ext.replace('.', '');

      // Copy the original source file (preserving its extension)
      const originalFilename = `original${ext}`;
      const sourcePath = path.join(projectDir, 'source', originalFilename);
      await fs.copyFile(epubSourcePath, sourcePath);

      // Archive pristine copy of the original file with descriptive name
      const archiveMetadata = {
        title,
        author,
        authorFileAs,
        year: year ? String(year) : undefined,
      };
      const descriptiveFilename = manifestService.computeDescriptiveFilename(archiveMetadata, ext);
      const archivePath = path.join(projectDir, 'archive', descriptiveFilename);
      try {
        await manifestService.atomicCopyFile(epubSourcePath, archivePath);
        console.log(`[audiobook:import] Archived pristine copy: ${descriptiveFilename}`);
      } catch (archiveErr) {
        console.warn('[audiobook:import] Failed to archive pristine copy (non-fatal):', archiveErr);
      }

      // For non-EPUB formats, also convert to original.epub if an EPUB was provided alongside
      // (The add-modal handles conversion before calling this handler for convertible formats)
      let epubPath = sourcePath;
      if (isEpub) {
        // EPUB: the source IS the epub
        epubPath = sourcePath;
      } else {
        // PDF or other format: no original.epub yet — user will create exported.epub from editor
        epubPath = sourcePath;
      }

      // Compute descriptive output filename for M4B exports
      const outputFilename = manifestService.computeDescriptiveFilename(archiveMetadata, '.m4b');

      // Get archive entry info (size from original source)
      let archiveSize: number | undefined;
      try {
        const archiveStats = await fs.stat(archivePath);
        archiveSize = archiveStats.size;
      } catch { /* ignore */ }

      // Create manifest.json
      const manifest = {
        version: 1,
        projectId: slug,
        projectType: 'book',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        source: {
          type: sourceType,
          originalFilename: filename,
          fileHash: importHash,
          deletedBlockIds: []
        },
        metadata: {
          title,
          subtitle,
          author,
          authorFileAs,
          year,
          language,
          outputFilename,
          coverPath: undefined as string | undefined,
        },
        sortOrder: -1,
        chapters: [],
        pipeline: {},
        outputs: {},
        archive: [{
          path: `archive/${descriptiveFilename}`,
          role: 'original' as const,
          format: ext.replace('.', ''),
          label: `Original ${ext.replace('.', '').toUpperCase()}`,
          archivedAt: new Date().toISOString(),
          size: archiveSize,
        }],
      };

      const manifestPath = path.join(projectDir, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Save cover image to media folder and update manifest
      if (confirmedMetadata?.coverData) {
        try {
          const coverRelPath = await saveImageToMedia(confirmedMetadata.coverData, 'cover');
          manifest.metadata.coverPath = coverRelPath;
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
        } catch (coverErr) {
          console.warn('[audiobook:import] Failed to save cover:', coverErr);
        }
      }

      console.log(`[audiobook:import] Created manifest project: ${projectDir}`);
      console.log(`[audiobook:import] Copied ${sourceType} to: ${sourcePath}`);

      return {
        success: true,
        projectId: slug,
        projectPath: projectDir,
        bfpPath: projectDir,
        audiobookFolder: path.join(projectDir, 'output'),
        epubPath: sourcePath,
        projectName: title,
        sourceType
      };
    } catch (err) {
      console.error('[audiobook:import] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── Archive IPC Handlers ─────────────────────────────────────────────────

  ipcMain.handle('archive:save-to-archive', async (
    _event,
    projectId: string,
    sourcePath: string,
    options: { role: 'original' | 'translation' | 'export' | 'audiobook'; format: string; language?: string; label?: string }
  ) => {
    try {
      const result = await manifestService.getManifest(projectId);
      if (!result.success || !result.manifest) {
        return { success: false, error: result.error || 'Project not found' };
      }

      const metadata = result.manifest.metadata;
      let descriptiveFilename = manifestService.computeDescriptiveFilename(
        { title: metadata.title, author: metadata.author, authorFileAs: metadata.authorFileAs, year: metadata.year },
        options.format.startsWith('.') ? options.format : `.${options.format}`
      );

      // For translations, append language code before extension
      if (options.language) {
        const ext = path.extname(descriptiveFilename);
        const base = descriptiveFilename.slice(0, -ext.length);
        descriptiveFilename = `${base} [${options.language}]${ext}`;
      }

      return await manifestService.archiveFile(projectId, sourcePath, {
        ...options,
        descriptiveFilename,
      });
    } catch (err) {
      console.error('[archive:save-to-archive] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('archive:list', async (_event, projectId: string) => {
    try {
      return await manifestService.listArchive(projectId);
    } catch (err) {
      console.error('[archive:list] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('archive:add-file', async (_event, projectId: string) => {
    try {
      const result = await manifestService.getManifest(projectId);
      if (!result.success || !result.manifest) {
        return { success: false, error: result.error || 'Project not found' };
      }

      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Add file to archive',
        filters: [
          { name: 'Documents', extensions: ['pdf', 'epub', 'm4b', 'mp3', 'txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (canceled || !filePaths?.length) {
        return { success: false, canceled: true };
      }

      const filePath = filePaths[0];
      const ext = path.extname(filePath);
      const format = ext.replace('.', '').toLowerCase();
      const metadata = result.manifest.metadata;
      const descriptiveFilename = manifestService.computeDescriptiveFilename(
        { title: metadata.title, author: metadata.author, authorFileAs: metadata.authorFileAs, year: metadata.year },
        ext
      );

      return await manifestService.archiveFile(projectId, filePath, {
        role: 'original',
        format,
        label: `Original ${format.toUpperCase()}`,
        descriptiveFilename,
      });
    } catch (err) {
      console.error('[archive:add-file] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── Archive Migration: Populate archive/ for existing projects ────────────

  ipcMain.handle('archive:migrate-from-library', async (event) => {
    const results = {
      migrated: 0,
      skipped: 0,
      failed: [] as Array<{ title: string; error: string }>,
    };

    function normalizeForMatch(s: string): string {
      return s.trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function findLibraryMatch(
      manifest: { metadata: { title: string; author: string; year?: string } },
      libraryBooks: ebookLibrary.LibraryBookEntry[]
    ): ebookLibrary.LibraryBookEntry | undefined {
      const mTitle = normalizeForMatch(manifest.metadata.title);
      const mAuthor = normalizeForMatch(manifest.metadata.author);

      const candidates = libraryBooks.filter(book => {
        if (normalizeForMatch(book.title) !== mTitle) return false;
        const bookAuthorFull = book.authorFull ? normalizeForMatch(book.authorFull) : '';
        const bookAuthorLast = book.authorLast ? normalizeForMatch(book.authorLast) : '';
        return mAuthor === bookAuthorFull || mAuthor === bookAuthorLast
          || bookAuthorFull.includes(mAuthor) || mAuthor.includes(bookAuthorLast);
      });

      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0];

      // Multiple matches — prefer year match
      const mYear = manifest.metadata.year;
      if (mYear) {
        const yearNum = parseInt(mYear);
        const yearMatch = candidates.find(b => b.year === yearNum);
        if (yearMatch) return yearMatch;
      }
      return candidates[0];
    }

    try {
      // 1. Scan ebook library
      const libraryBooks = await ebookLibrary.scanLibrary();
      console.log(`[archive:migrate] Found ${libraryBooks.length} ebook library entries`);

      // 2. List all book projects
      const listResult = await manifestService.listProjects({ type: 'book' });
      if (!listResult.success || !listResult.projects) {
        return { success: false, migrated: 0, skipped: 0, failed: [], error: listResult.error || 'Failed to list projects' };
      }

      const projects = listResult.projects;
      console.log(`[archive:migrate] Found ${projects.length} book projects`);

      for (let i = 0; i < projects.length; i++) {
        const manifest = projects[i];
        const title = manifest.metadata.title || manifest.projectId;

        // Send progress
        event.sender.send('archive:migration-progress', {
          current: i + 1,
          total: projects.length,
          title,
        });

        // Skip if already has archive entries
        if (manifest.archive && manifest.archive.length > 0) {
          results.skipped++;
          continue;
        }

        try {
          const projectDir = manifestService.getProjectPath(manifest.projectId);
          const archiveDir = path.join(projectDir, 'archive');
          await fs.mkdir(archiveDir, { recursive: true });

          // Try to match against ebook library
          const match = findLibraryMatch(manifest, libraryBooks);

          if (match) {
            // Copy ebook library file — it already has a descriptive filename
            const ebookAbsPath = ebookLibrary.getAbsolutePath(match.relativePath);
            const descriptiveFilename = match.filename;
            const archivePath = path.join(archiveDir, descriptiveFilename);

            await manifestService.atomicCopyFile(ebookAbsPath, archivePath);

            const stats = await fs.stat(archivePath);
            const ext = path.extname(descriptiveFilename).replace('.', '').toLowerCase();

            await manifestService.modifyManifest(manifest.projectId, (m) => {
              if (!m.archive) m.archive = [];
              m.archive.push({
                path: `archive/${descriptiveFilename}`,
                role: 'original' as const,
                format: ext,
                label: `Original ${ext.toUpperCase()}`,
                archivedAt: new Date().toISOString(),
                size: stats.size,
              });
              // Set outputFilename if not already set
              if (!m.metadata.outputFilename) {
                m.metadata.outputFilename = manifestService.computeDescriptiveFilename(
                  { title: m.metadata.title, author: m.metadata.author, authorFileAs: m.metadata.authorFileAs, year: m.metadata.year },
                  '.m4b'
                );
              }
            });

            console.log(`[archive:migrate] Matched & archived: ${title} ← ${match.relativePath}`);
            results.migrated++;
          } else {
            // No library match — fall back to source/original.{ext}
            const sourceDir = path.join(projectDir, 'source');
            let originalPath: string | undefined;
            let originalExt: string | undefined;

            for (const ext of ['.epub', '.pdf']) {
              const candidate = path.join(sourceDir, `original${ext}`);
              try {
                await fs.access(candidate);
                originalPath = candidate;
                originalExt = ext;
                break;
              } catch { /* not found */ }
            }

            if (!originalPath || !originalExt) {
              results.skipped++;
              console.log(`[archive:migrate] No source found, skipping: ${title}`);
              continue;
            }

            const descriptiveFilename = manifestService.computeDescriptiveFilename(
              { title: manifest.metadata.title, author: manifest.metadata.author, authorFileAs: manifest.metadata.authorFileAs, year: manifest.metadata.year },
              originalExt
            );
            const archivePath = path.join(archiveDir, descriptiveFilename);

            await manifestService.atomicCopyFile(originalPath, archivePath);

            const stats = await fs.stat(archivePath);
            const format = originalExt.replace('.', '').toLowerCase();

            await manifestService.modifyManifest(manifest.projectId, (m) => {
              if (!m.archive) m.archive = [];
              m.archive.push({
                path: `archive/${descriptiveFilename}`,
                role: 'original' as const,
                format,
                label: `Original ${format.toUpperCase()}`,
                archivedAt: new Date().toISOString(),
                size: stats.size,
              });
              if (!m.metadata.outputFilename) {
                m.metadata.outputFilename = manifestService.computeDescriptiveFilename(
                  { title: m.metadata.title, author: m.metadata.author, authorFileAs: m.metadata.authorFileAs, year: m.metadata.year },
                  '.m4b'
                );
              }
            });

            console.log(`[archive:migrate] Fallback archived: ${title} ← source/original${originalExt}`);
            results.migrated++;
          }
        } catch (err) {
          console.error(`[archive:migrate] Failed: ${title}`, err);
          results.failed.push({ title, error: (err as Error).message });
        }
      }

      console.log(`[archive:migrate] Done — migrated: ${results.migrated}, skipped: ${results.skipped}, failed: ${results.failed.length}`);
      return { success: true, ...results };
    } catch (err) {
      console.error('[archive:migrate] Fatal error:', err);
      return { success: false, ...results, error: (err as Error).message };
    }
  });

  // Migrate all projects to current BFP format/structure
  // This ensures all projects are self-contained with source files copied locally
  ipcMain.handle('projects:migrate-all', async () => {
    const results: {
      total: number;
      migrated: number;
      skipped: number;
      failed: Array<{ name: string; error: string }>;
      details: Array<{ name: string; action: string }>;
    } = {
      total: 0,
      migrated: 0,
      skipped: 0,
      failed: [],
      details: []
    };

    try {
      const projectsFolder = getProjectsFolder();

      // Ensure projects folder exists
      await fs.mkdir(projectsFolder, { recursive: true });

      // Get all BFP files
      const entries = await fs.readdir(projectsFolder, { withFileTypes: true });
      const bfpFiles = entries.filter(e => e.isFile() && e.name.endsWith('.bfp'));

      results.total = bfpFiles.length;
      console.log(`[projects:migrate-all] Found ${bfpFiles.length} BFP files to check`);

      for (const entry of bfpFiles) {
        const bfpPath = path.join(projectsFolder, entry.name);
        const projectName = entry.name.replace('.bfp', '');

        try {
          // Read BFP file
          const content = await fs.readFile(bfpPath, 'utf-8');
          const bfp = JSON.parse(content) as Record<string, unknown>;

          // Create backup
          const backupPath = bfpPath + '.migration-backup';
          await fs.copyFile(bfpPath, backupPath);

          // Determine audiobook folder (translate cross-platform paths)
          let audiobookFolder = bfp.audiobookFolder as string | undefined;
          if (audiobookFolder) {
            // Try cross-platform translation if stored path doesn't exist
            if (!fsSync.existsSync(audiobookFolder)) {
              const translated = translateLibraryPath(audiobookFolder);
              if (translated) audiobookFolder = translated;
            }
          }
          if (!audiobookFolder || !fsSync.existsSync(audiobookFolder)) {
            audiobookFolder = path.join(projectsFolder, projectName, 'output');
          }

          // Check if migration is needed (translate source path for cross-platform)
          let sourcePath = bfp.source_path as string | undefined;
          if (sourcePath && !fsSync.existsSync(sourcePath)) {
            const translated = translateLibraryPath(sourcePath);
            if (translated && fsSync.existsSync(translated)) sourcePath = translated;
          }
          const needsMigration = sourcePath && !sourcePath.includes('/output/') && !sourcePath.includes('/source.epub');

          if (!needsMigration || !sourcePath) {
            // Already migrated or no source to migrate
            results.skipped++;
            results.details.push({ name: projectName, action: 'skipped - already migrated or no source' });
            continue;
          }

          // Ensure audiobook folder exists
          await fs.mkdir(audiobookFolder, { recursive: true });

          // Copy source file to audiobook folder
          const sourceExt = path.extname(sourcePath).toLowerCase();
          const sourceDestName = sourceExt === '.pdf' ? 'source.pdf' : 'source.epub';
          const sourceDestPath = path.join(audiobookFolder, sourceDestName);

          if (fsSync.existsSync(sourcePath)) {
            // Copy the source file
            await fs.copyFile(sourcePath, sourceDestPath);
            console.log(`[projects:migrate-all] Copied source: ${sourcePath} -> ${sourceDestPath}`);

            // Update BFP
            bfp.original_source_path = sourcePath;  // Keep reference to original location
            bfp.source_path = sourceDestPath;
            bfp.library_path = sourceDestPath;
            bfp.audiobookFolder = audiobookFolder;

            // Ensure audiobook property exists if there's an exported.epub
            const exportedPath = path.join(audiobookFolder, 'exported.epub');
            if (fsSync.existsSync(exportedPath) && !bfp.audiobook) {
              bfp.audiobook = {
                status: 'pending',
                exportedEpubPath: exportedPath,
                exportedAt: new Date().toISOString()
              };
            }

            bfp.modified_at = new Date().toISOString();

            // Save updated BFP
            await atomicWriteFile(bfpPath, JSON.stringify(bfp, null, 2));

            results.migrated++;
            results.details.push({ name: projectName, action: 'migrated - source copied to project folder' });
          } else {
            // Source file doesn't exist - check if there's an exported.epub we can use
            const exportedPath = path.join(audiobookFolder, 'exported.epub');
            if (fsSync.existsSync(exportedPath)) {
              // Use exported.epub as the source
              const sourceDestPath2 = path.join(audiobookFolder, 'source.epub');
              await fs.copyFile(exportedPath, sourceDestPath2);

              bfp.original_source_path = sourcePath;
              bfp.source_path = sourceDestPath2;
              bfp.library_path = sourceDestPath2;
              bfp.audiobookFolder = audiobookFolder;

              if (!bfp.audiobook) {
                bfp.audiobook = {
                  status: 'pending',
                  exportedEpubPath: exportedPath,
                  exportedAt: new Date().toISOString()
                };
              }

              bfp.modified_at = new Date().toISOString();
              await atomicWriteFile(bfpPath, JSON.stringify(bfp, null, 2));

              results.migrated++;
              results.details.push({ name: projectName, action: 'migrated - used exported.epub as source' });
            } else {
              results.failed.push({ name: projectName, error: 'Source file not found and no exported.epub available' });
            }
          }
        } catch (err) {
          console.error(`[projects:migrate-all] Failed to migrate ${projectName}:`, err);
          results.failed.push({ name: projectName, error: (err as Error).message });
        }
      }

      console.log(`[projects:migrate-all] Migration complete:`, results);
      return {
        success: true,
        migrated: results.details.filter(d => d.action.startsWith('migrated')).map(d => d.name),
        skipped: results.details.filter(d => d.action.startsWith('skipped')).map(d => d.name),
        failed: results.failed
      };
    } catch (err) {
      console.error('[projects:migrate-all] Migration failed:', err);
      return { success: false, error: (err as Error).message, migrated: [], skipped: [], failed: [] };
    }
  });

  // Update audiobook state in BFP project
  ipcMain.handle('audiobook:update-state', async (
    _event,
    bfpPath: string,
    audiobookState: Record<string, unknown>
  ) => {
    try {
      const bfpContent = await fs.readFile(bfpPath, 'utf-8');
      const bfpProject = JSON.parse(bfpContent);

      // Merge audiobook state
      bfpProject.audiobook = {
        ...bfpProject.audiobook,
        ...audiobookState
      };
      bfpProject.modified_at = new Date().toISOString();

      await atomicWriteFile(bfpPath, JSON.stringify(bfpProject, null, 2));

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Append job analytics (handles deduplication atomically).
  // Manifest projects (bfpPath = project directory) store them in
  // {projectDir}/job-analytics.json — separate from the LL pipeline's
  // analytics.json which has a different (stage-based) schema.
  // Legacy .bfp files keep them in audiobook.analytics.
  ipcMain.handle('audiobook:append-analytics', async (
    _event,
    bfpPath: string,
    jobType: 'tts-conversion' | 'ocr-cleanup' | 'reassembly' | 'video-assembly' | 'rvc' | 'translation',
    analytics: { jobId: string; [key: string]: unknown }
  ) => {
    const MAX_ANALYTICS_HISTORY = 10;

    // Map job type to analytics array key
    const typeToKey: Record<string, string> = {
      'tts-conversion': 'ttsJobs',
      'ocr-cleanup': 'cleanupJobs',
      'reassembly': 'reassemblyJobs',
      'video-assembly': 'videoAssemblyJobs',
      'rvc': 'rvcJobs',
      'translation': 'translationJobs'
    };

    const appendTo = (container: Record<string, any>) => {
      const key = typeToKey[jobType];
      if (key) {
        const existing = container[key] || [];
        const dedupedJobs = existing.filter(
          (j: { jobId: string }) => j.jobId !== analytics.jobId
        );
        container[key] = [...dedupedJobs, analytics].slice(-MAX_ANALYTICS_HISTORY);
      }
      return container;
    };

    try {
      const isProjectDir = fsSync.existsSync(bfpPath) &&
        fsSync.statSync(bfpPath).isDirectory() &&
        fsSync.existsSync(path.join(bfpPath, 'manifest.json'));

      if (isProjectDir) {
        const analyticsPath = path.join(bfpPath, 'job-analytics.json');
        let existing: Record<string, any> = { ttsJobs: [], cleanupJobs: [], reassemblyJobs: [], videoAssemblyJobs: [], rvcJobs: [], translationJobs: [] };
        try {
          existing = JSON.parse(await fs.readFile(analyticsPath, 'utf-8'));
        } catch { /* first write */ }
        await atomicWriteFile(analyticsPath, JSON.stringify(appendTo(existing), null, 2));
        return { success: true };
      }

      // Legacy .bfp file
      const bfpContent = await fs.readFile(bfpPath, 'utf-8');
      const bfpProject = JSON.parse(bfpContent);

      // Initialize audiobook state if needed
      if (!bfpProject.audiobook) {
        bfpProject.audiobook = {};
      }

      bfpProject.audiobook.analytics = appendTo(bfpProject.audiobook.analytics || {
        ttsJobs: [],
        cleanupJobs: [],
        reassemblyJobs: [],
        videoAssemblyJobs: []
      });

      // Also set cleanedAt timestamp for OCR cleanup
      if (jobType === 'ocr-cleanup') {
        bfpProject.audiobook.cleanedAt = new Date().toISOString();
      }

      bfpProject.modified_at = new Date().toISOString();

      await atomicWriteFile(bfpPath, JSON.stringify(bfpProject, null, 2));

      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Read job analytics for a project (manifest dir or legacy .bfp)
  ipcMain.handle('audiobook:get-analytics', async (_event, bfpPath: string) => {
    try {
      if (!bfpPath || !fsSync.existsSync(bfpPath)) {
        return { success: true, analytics: null };
      }
      if (fsSync.statSync(bfpPath).isDirectory()) {
        const analyticsPath = path.join(bfpPath, 'job-analytics.json');
        if (!fsSync.existsSync(analyticsPath)) {
          return { success: true, analytics: null };
        }
        return { success: true, analytics: JSON.parse(await fs.readFile(analyticsPath, 'utf-8')) };
      }
      const bfpProject = JSON.parse(await fs.readFile(bfpPath, 'utf-8'));
      return { success: true, analytics: bfpProject.audiobook?.analytics ?? null };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Copy VTT file to audiobook folder and update BFP with vttPath
  // Called after TTS completion to preserve subtitles for chapter recovery
  ipcMain.handle('audiobook:copy-vtt', async (
    _event,
    bfpPath: string,
    m4bOutputPath: string
  ) => {
    try {
      // Find VTT file in the M4B output directory or vtt subfolder
      const outputDir = path.dirname(m4bOutputPath);
      const m4bBasename = path.basename(m4bOutputPath, '.m4b');

      let vttSourcePath: string | null = null;

      // Check vtt subfolder first (where moveVttFile puts it)
      const vttSubfolder = path.join(outputDir, 'vtt');
      try {
        const vttEntries = await fs.readdir(vttSubfolder);
        const vttFile = vttEntries.find(f => f.toLowerCase().endsWith('.vtt'));
        if (vttFile) {
          vttSourcePath = path.join(vttSubfolder, vttFile);
        }
      } catch {
        // vtt subfolder doesn't exist, check main directory
      }

      // If not in subfolder, check main directory
      if (!vttSourcePath) {
        const mainEntries = await fs.readdir(outputDir);
        const vttFile = mainEntries.find(f => f.toLowerCase().endsWith('.vtt'));
        if (vttFile) {
          vttSourcePath = path.join(outputDir, vttFile);
        }
      }

      if (!vttSourcePath) {
        console.log('[AUDIOBOOK] No VTT file found for', m4bBasename);
        return { success: true, vttPath: null, message: 'No VTT file found' };
      }

      // Get the audiobook folder for this BFP project
      const projectName = path.basename(bfpPath, '.bfp');
      const audiobookFolder = getAudiobookFolderForProject(projectName);

      // Copy VTT to audiobook folder as subtitles.vtt
      const vttDestPath = path.join(audiobookFolder, 'subtitles.vtt');
      await fs.mkdir(audiobookFolder, { recursive: true });

      // Skip copy+delete if VTT is already at the destination (BFP workflow puts it there directly)
      const resolvedSource = path.resolve(vttSourcePath);
      const resolvedDest = path.resolve(vttDestPath);
      if (resolvedSource === resolvedDest) {
        console.log('[AUDIOBOOK] VTT already in correct location:', vttDestPath);
      } else {
        await fs.copyFile(vttSourcePath, vttDestPath);
        console.log('[AUDIOBOOK] Copied VTT to:', vttDestPath);

        // Delete the source VTT file after successful copy
        try {
          await fs.unlink(vttSourcePath);
          console.log('[AUDIOBOOK] Deleted source VTT:', vttSourcePath);

          // If source was in a vtt subfolder, try to remove the folder if empty
          const vttSubfolderPath = path.join(outputDir, 'vtt');
          if (vttSourcePath.startsWith(vttSubfolderPath)) {
            try {
              const remaining = await fs.readdir(vttSubfolderPath);
              if (remaining.length === 0) {
                await fs.rmdir(vttSubfolderPath);
                console.log('[AUDIOBOOK] Removed empty vtt folder:', vttSubfolderPath);
              }
            } catch {
              // Folder removal is best-effort
            }
          }
        } catch (deleteErr) {
          console.warn('[AUDIOBOOK] Failed to delete source VTT (non-fatal):', deleteErr);
        }
      }

      // Atomic read-modify-write with per-project lock
      const projectId = path.basename(bfpPath);
      await manifestService.modifyManifest(projectId, (manifest) => {
        if (!manifest.outputs) manifest.outputs = {};
        if (!manifest.outputs.audiobook) manifest.outputs.audiobook = { path: '' };
        manifest.outputs.audiobook.vttPath = path.relative(bfpPath, vttDestPath).replace(/\\/g, '/');
      });

      return { success: true, vttPath: vttDestPath };
    } catch (err) {
      console.error('[AUDIOBOOK] Failed to copy VTT:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Get audiobook folder path for a project
  ipcMain.handle('audiobook:get-folder', async (_event, bfpPath: string) => {
    const projectName = path.basename(bfpPath, '.bfp');
    const audiobookFolder = getAudiobookFolderForProject(projectName);
    return { success: true, folder: audiobookFolder };
  });

  // List BFP projects that have audiobook state (for audiobook producer queue)
  ipcMain.handle('audiobook:list-projects-with-audiobook', async () => {
    try {
      const projectsFolder = getProjectsFolder();
      const entries = await fs.readdir(projectsFolder, { withFileTypes: true });
      const projects: Array<{
        name: string;
        bfpPath: string;
        audiobookFolder: string;
        status: string;
        exportedAt?: string;
        cleanedAt?: string;
        completedAt?: string;
        linkedAudioPath?: string;
        linkedAudioPathValid?: boolean;  // True if linkedAudioPath exists on current system
        vttPath?: string;  // VTT subtitles path from BFP
        // Bilingual audio paths (separate from mono audiobook)
        bilingualAudioPath?: string;
        bilingualAudioPathValid?: boolean;
        bilingualVttPath?: string;
        bilingualSentencePairsPath?: string;
        metadata?: {
          title?: string;
          author?: string;
          year?: string;
          coverImagePath?: string;
          outputFilename?: string;
        };
        analytics?: {
          ttsJobs?: any[];
          cleanupJobs?: any[];
        };
      }> = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bfp')) continue;

        const bfpPath = path.join(projectsFolder, entry.name);
        try {
          const content = await fs.readFile(bfpPath, 'utf-8');
          const project = JSON.parse(content);

          // Only include projects with audiobook state
          if (project.audiobook) {
            const projectName = entry.name.replace('.bfp', '');

            // Resolve stored paths for cross-platform compatibility.
            // BFP files synced between Mac and Windows store absolute paths
            // from whichever platform created them. translateLibraryPath()
            // re-roots them under the current library root.
            const resolveStoredPath = (storedPath: string | undefined): string | undefined => {
              if (!storedPath) return undefined;
              if (fsSync.existsSync(storedPath)) return storedPath;
              const translated = translateLibraryPath(storedPath);
              if (translated && fsSync.existsSync(translated)) return translated;
              return undefined;
            };

            // Resolve linked audio path
            let resolvedLinkedAudioPath: string | undefined;
            let linkedAudioPathValid: boolean | undefined;
            if (project.audiobook.linkedAudioPath) {
              resolvedLinkedAudioPath = resolveStoredPath(project.audiobook.linkedAudioPath);
              linkedAudioPathValid = !!resolvedLinkedAudioPath;
            }

            // Resolve bilingual audio path
            let resolvedBilingualAudioPath: string | undefined;
            let bilingualAudioPathValid: boolean | undefined;
            if (project.audiobook.bilingualAudioPath) {
              resolvedBilingualAudioPath = resolveStoredPath(project.audiobook.bilingualAudioPath);
              bilingualAudioPathValid = !!resolvedBilingualAudioPath;
            }

            // Resolve VTT path
            const resolvedVttPath = resolveStoredPath(project.audiobook.vttPath);

            // Resolve bilingual VTT path
            const resolvedBilingualVttPath = resolveStoredPath(project.audiobook.bilingualVttPath);

            // If no linked audio, scan audiobook folder for any .m4b file
            // (e2a may use title-based naming instead of output.m4b)
            let detectedAudioPath: string | undefined;
            if (!resolvedLinkedAudioPath) {
              const abFolder = getAudiobookFolderForProject(projectName);
              try {
                const abFiles = fsSync.readdirSync(abFolder);
                const m4bFile = abFiles.find(f => f.endsWith('.m4b') && !f.startsWith('.') && !f.startsWith('._'));
                if (m4bFile) {
                  detectedAudioPath = path.join(abFolder, m4bFile);
                }
              } catch {
                // Folder doesn't exist
              }
            }

            projects.push({
              name: projectName,
              bfpPath,
              audiobookFolder: getAudiobookFolderForProject(projectName),
              status: project.audiobook.status || 'pending',
              exportedAt: project.audiobook.exportedAt,
              cleanedAt: project.audiobook.cleanedAt,
              completedAt: project.audiobook.completedAt,
              linkedAudioPath: resolvedLinkedAudioPath || detectedAudioPath || project.audiobook.linkedAudioPath,
              linkedAudioPathValid: !!(resolvedLinkedAudioPath || detectedAudioPath) || linkedAudioPathValid,
              vttPath: resolvedVttPath || project.audiobook.vttPath,
              // Bilingual audio paths (resolved for cross-platform)
              bilingualAudioPath: resolvedBilingualAudioPath || project.audiobook.bilingualAudioPath,
              bilingualAudioPathValid,
              bilingualVttPath: resolvedBilingualVttPath || project.audiobook.bilingualVttPath,
              bilingualSentencePairsPath: project.audiobook.bilingualSentencePairsPath,
              metadata: project.metadata ? {
                title: project.metadata.title,
                author: project.metadata.author,
                year: project.metadata.year,
                coverImagePath: project.metadata.coverImagePath,
                outputFilename: project.metadata.outputFilename
              } : undefined,
              analytics: project.audiobook.analytics || undefined
            });
          }
        } catch {
          // Skip invalid files
        }
      }

      // Sort by exportedAt, newest first
      projects.sort((a, b) => {
        const aTime = a.exportedAt ? new Date(a.exportedAt).getTime() : 0;
        const bTime = b.exportedAt ? new Date(b.exportedAt).getTime() : 0;
        return bTime - aTime;
      });

      return { success: true, projects };
    } catch (err) {
      return { success: false, error: (err as Error).message, projects: [] };
    }
  });

  // Link an audio file to a BFP project
  ipcMain.handle('audiobook:link-audio', async (_event, bfpPath: string, audioPath: string) => {
    try {
      console.log('[audiobook:link-audio] bfpPath:', bfpPath, 'audioPath:', audioPath);

      if (!bfpPath || !audioPath) {
        return { success: false, error: 'Missing bfpPath or audioPath' };
      }

      // bfpPath is the project directory — derive projectId and relative audio path
      const projectId = path.basename(bfpPath);
      const relativePath = path.relative(bfpPath, audioPath).replace(/\\/g, '/');
      console.log('[audiobook:link-audio] projectId:', projectId, 'relativePath:', relativePath);

      // Detect VTT alongside the M4B so Play button works immediately
      const audioDir = path.dirname(audioPath);
      let vttRelPath: string | undefined;
      try {
        const dirFiles = await fs.readdir(audioDir);
        const vttFile = dirFiles.find(f => f === 'subtitles.vtt')
          || dirFiles.find(f => f.endsWith('.vtt') && !f.startsWith('._'));
        if (vttFile) {
          vttRelPath = path.relative(bfpPath, path.join(audioDir, vttFile)).replace(/\\/g, '/');
        }
      } catch { /* dir read failed, skip vtt detection */ }

      // Atomic read-modify-write with per-project lock
      const saveResult = await manifestService.modifyManifest(projectId, (manifest) => {
        if (!manifest.outputs) manifest.outputs = {};
        manifest.outputs.audiobook = {
          ...manifest.outputs.audiobook,
          path: relativePath,
          completedAt: new Date().toISOString(),
          ...(vttRelPath && { vttPath: vttRelPath }),
        };
        delete manifest.sortOrder;  // Bump to top of "recent" sort
      });
      console.log('[audiobook:link-audio] Manifest saved:', saveResult.success);
      return { success: saveResult.success, error: saveResult.error };
    } catch (err) {
      console.error('[audiobook:link-audio] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Update pipeline stage data in the project manifest
  ipcMain.handle('audiobook:update-pipeline', async (_event, projectId: string, pipelineData: Record<string, unknown>) => {
    try {
      if (!projectId || !pipelineData) {
        return { success: false, error: 'Missing projectId or pipelineData' };
      }
      console.log('[audiobook:update-pipeline] projectId:', projectId, 'keys:', Object.keys(pipelineData));
      const result = await manifestService.updateManifest({
        projectId,
        pipeline: pipelineData as any,
      });
      return { success: result.success, error: result.error };
    } catch (err) {
      console.error('[audiobook:update-pipeline] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Copy standard audiobook to external audiobooks directory
  ipcMain.handle('audiobook:copy-to-external', async (_event, params: {
    m4bPath: string;
    externalDir: string;
    title?: string;
    author?: string;
    year?: string;
  }) => {
    try {
      const { m4bPath, externalDir, title, author, year } = params;
      if (!m4bPath || !externalDir) {
        return { success: false, error: 'Missing m4bPath or externalDir' };
      }

      if (!fsSync.existsSync(m4bPath)) {
        return { success: false, error: `Audio file not found: ${m4bPath}` };
      }

      await fs.mkdir(externalDir, { recursive: true });

      // Build filename using shared utility: "Title. Author. (Year).m4b"
      const { generateOutputFilename } = await import('./tts-bridge.js');
      const safeFilename = generateOutputFilename(title || 'audiobook', undefined, author, undefined, year)
        .replace(/\.m4b$/, '');
      const externalPath = path.join(externalDir, `${safeFilename}.m4b`);

      // Atomic copy: write to .tmp- file then rename, so Syncthing never sees partial files
      const tmpPath = path.join(externalDir, `.tmp-${safeFilename}.m4b`);
      await fs.copyFile(m4bPath, tmpPath);
      try {
        await fs.rename(tmpPath, externalPath);
      } catch (renameErr: any) {
        // EXDEV = cross-filesystem; rename not possible, fall back to direct copy
        if (renameErr.code === 'EXDEV') {
          await fs.copyFile(m4bPath, externalPath);
          await fs.unlink(tmpPath).catch(() => {});
        } else {
          throw renameErr;
        }
      }
      console.log('[audiobook:copy-to-external] Copied M4B to:', externalPath);

      return { success: true, externalPath };
    } catch (err) {
      console.error('[audiobook:copy-to-external] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Link bilingual audio file to BFP project (separate from mono audiobook)
  ipcMain.handle('audiobook:link-bilingual-audio', async (_event, bfpPath: string, audioPath: string, vttPath?: string, sentencePairsPath?: string) => {
    try {
      const { wslToWindowsPath, wslPathToWindows } = await import('./e2a-paths.js');
      // Convert any WSL path to Windows: /mnt/c/... → C:\..., /home/... → \\wsl$\...\...
      const toWindowsPath = (p: string): string => {
        const converted = wslToWindowsPath(p);
        if (converted !== p) return converted;  // Was a /mnt/ path, converted successfully
        if (p.startsWith('/')) return wslPathToWindows(p);  // Native WSL path → UNC
        return p;  // Already a Windows path
      };

      console.log('[audiobook:link-bilingual-audio] === LINK BILINGUAL AUDIO CALLED ===');
      console.log('[audiobook:link-bilingual-audio] bfpPath:', bfpPath);
      console.log('[audiobook:link-bilingual-audio] audioPath:', audioPath);
      console.log('[audiobook:link-bilingual-audio] vttPath:', vttPath);
      console.log('[audiobook:link-bilingual-audio] sentencePairsPath:', sentencePairsPath);

      // Validate inputs
      if (!bfpPath || !audioPath) {
        console.error('[audiobook:link-bilingual-audio] Missing required parameters');
        return { success: false, error: 'Missing bfpPath or audioPath' };
      }

      // Check if BFP file exists
      const bfpExists = fsSync.existsSync(bfpPath);
      console.log('[audiobook:link-bilingual-audio] BFP exists:', bfpExists);
      if (!bfpExists) {
        return { success: false, error: `BFP file not found: ${bfpPath}` };
      }

      // Read the BFP file
      console.log('[audiobook:link-bilingual-audio] Reading BFP file...');
      const content = await fs.readFile(bfpPath, 'utf-8');
      const project = JSON.parse(content);
      console.log('[audiobook:link-bilingual-audio] Current bilingualAudioPath:', project.audiobook?.bilingualAudioPath);

      // Ensure audiobook state exists
      if (!project.audiobook) {
        project.audiobook = {};
      }

      // Bump to top of "recent" sort
      delete project.sortOrder;

      // Convert WSL paths to Windows paths before storing
      // Handles both /mnt/c/ mount paths and native /home/ WSL paths
      project.audiobook.bilingualAudioPath = toWindowsPath(audioPath);
      if (vttPath) {
        project.audiobook.bilingualVttPath = toWindowsPath(vttPath);
      }
      if (sentencePairsPath) {
        project.audiobook.bilingualSentencePairsPath = toWindowsPath(sentencePairsPath);
      }
      console.log('[audiobook:link-bilingual-audio] New bilingualAudioPath:', project.audiobook.bilingualAudioPath);
      console.log('[audiobook:link-bilingual-audio] New bilingualVttPath:', project.audiobook.bilingualVttPath);
      console.log('[audiobook:link-bilingual-audio] New bilingualSentencePairsPath:', project.audiobook.bilingualSentencePairsPath);

      // Save the BFP file
      console.log('[audiobook:link-bilingual-audio] Writing BFP file...');
      const jsonContent = JSON.stringify(project, null, 2);
      await fs.writeFile(bfpPath, jsonContent);
      console.log('[audiobook:link-bilingual-audio] Write complete, bytes:', jsonContent.length);

      console.log('[audiobook:link-bilingual-audio] === SUCCESS ===');
      return { success: true };
    } catch (err) {
      console.error('[audiobook:link-bilingual-audio] === ERROR ===');
      console.error('[audiobook:link-bilingual-audio] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Finalize bilingual assembly output for manifest projects
  // Copies audio+VTT to project output dir, updates manifest
  ipcMain.handle('bilingual-assembly:finalize-output', async (_event, params: {
    audioPath: string;
    vttPath?: string;
    projectDir: string;
    projectId: string;
    sourceLang: string;
    targetLang: string;
    metadataFilename?: string; // e.g., "Aesop's Fables. Aesopus. (2011). Unknown (language learning)"
    sentencePairsPath?: string; // Absolute path to sentence_pairs_{lang}.json
  }) => {
    try {
      const { audioPath, vttPath, projectDir, sourceLang, targetLang, metadataFilename, sentencePairsPath } = params;
      // projectId may be a full absolute path (from StudioItem.id) — use folder name
      const projectId = path.basename(projectDir);
      console.log('[bilingual-assembly:finalize-output] Params:', { audioPath, vttPath, projectDir, projectId, sourceLang, targetLang, metadataFilename, sentencePairsPath });

      // 1. Ensure project output dir exists
      const outputDir = path.join(projectDir, 'output');
      await fs.mkdir(outputDir, { recursive: true });

      // 2. Clean up old bilingual output files for this language pair, then copy new ones
      const langKey = `${sourceLang}-${targetLang}`;
      const projectAudioPath = path.join(outputDir, `bilingual-${langKey}.m4b`);
      const projectVttPath = path.join(outputDir, `bilingual-${langKey}.vtt`);
      const projectMp4Path = path.join(outputDir, `bilingual-${langKey}.mp4`);

      // Remove old bilingual files for this language pair
      for (const oldFile of [projectAudioPath, projectVttPath, projectMp4Path]) {
        if (fsSync.existsSync(oldFile)) {
          try {
            fsSync.unlinkSync(oldFile);
            console.log('[bilingual-assembly:finalize-output] Cleaned up old file:', oldFile);
          } catch {
            // Non-fatal
          }
        }
      }

      if (audioPath && fsSync.existsSync(audioPath)) {
        // Atomic copy: write to .tmp- then rename so Syncthing never sees partial files
        const tmpAudio = path.join(outputDir, `.tmp-bilingual-${langKey}.m4b`);
        await fs.copyFile(audioPath, tmpAudio);
        await fs.rename(tmpAudio, projectAudioPath);
        console.log('[bilingual-assembly:finalize-output] Copied M4B to:', projectAudioPath);
      } else {
        return { success: false, error: `Audio file not found: ${audioPath}` };
      }

      if (vttPath && fsSync.existsSync(vttPath)) {
        const tmpVtt = path.join(outputDir, `.tmp-bilingual-${langKey}.vtt`);
        await fs.copyFile(vttPath, tmpVtt);
        await fs.rename(tmpVtt, projectVttPath);
        console.log('[bilingual-assembly:finalize-output] Copied VTT to:', projectVttPath);
      }

      // 3. Apply metadata (cover, title, author) to M4B
      try {
        const manifestResult0 = await manifestService.getManifest(projectId);
        if (manifestResult0.success && manifestResult0.manifest) {
          const meta = manifestResult0.manifest.metadata;
          let coverAbsPath: string | undefined;
          if (meta.coverPath) {
            const candidate = path.join(getLibraryRoot(), meta.coverPath);
            if (fsSync.existsSync(candidate)) {
              coverAbsPath = candidate;
              console.log('[bilingual-assembly:finalize-output] Cover resolved:', coverAbsPath);
            } else {
              console.warn('[bilingual-assembly:finalize-output] Cover in manifest but file missing:', candidate);
            }
          } else {
            console.log('[bilingual-assembly:finalize-output] No coverPath in manifest');
          }
          await applyMetadata(projectAudioPath, {
            title: meta.title,
            author: meta.author,
            year: meta.year,
            narrator: meta.narrator,
            series: meta.series,
            coverPath: coverAbsPath,
          });
          console.log('[bilingual-assembly:finalize-output] Metadata applied (cover:', coverAbsPath ? 'yes' : 'none', ')');
        }
      } catch (metaErr) {
        console.error('[bilingual-assembly:finalize-output] Failed to apply metadata (non-fatal):', metaErr);
      }

      // 4. Update manifest with bilingual output paths
      // Convert absolute sentencePairsPath to relative for manifest storage
      let relativeSentencePairsPath: string | undefined;
      if (sentencePairsPath && sentencePairsPath.startsWith(projectDir)) {
        relativeSentencePairsPath = sentencePairsPath.slice(projectDir.length).replace(/^[/\\]/, '');
      } else if (sentencePairsPath) {
        // Not under project dir — check if file exists and use as-is for logging
        console.warn('[bilingual-assembly:finalize-output] sentencePairsPath not under projectDir, storing absolute:', sentencePairsPath);
        relativeSentencePairsPath = sentencePairsPath;
      }
      const manifestUpdate = {
        projectId,
        outputs: {
          bilingualAudiobooks: {
            [langKey]: {
              path: `output/bilingual-${langKey}.m4b`,
              vttPath: `output/bilingual-${langKey}.vtt`,
              sentencePairsPath: relativeSentencePairsPath,
              completedAt: new Date().toISOString()
            }
          }
        }
      };

      const manifestResult = await manifestService.updateManifest(manifestUpdate);
      if (manifestResult.success) {
        console.log('[bilingual-assembly:finalize-output] Manifest updated with bilingual output');
      } else {
        console.error('[bilingual-assembly:finalize-output] Failed to update manifest:', manifestResult.error);
      }

      return { success: true, projectAudioPath, projectVttPath };
    } catch (err) {
      console.error('[bilingual-assembly:finalize-output] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Media handlers - for external image storage
  // ─────────────────────────────────────────────────────────────────────────────

  // Save base64 image to media folder, return relative path
  ipcMain.handle('media:save-image', async (_event, base64Data: string, prefix: string = 'cover') => {
    try {
      const relativePath = await saveImageToMedia(base64Data, prefix);
      return { success: true, path: relativePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Load image from media folder, return base64 data URL
  ipcMain.handle('media:load-image', async (_event, relativePath: string) => {
    try {
      const base64 = await loadImageFromMedia(relativePath);
      if (base64) {
        return { success: true, data: base64 };
      }
      return { success: false, error: 'Image not found' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Processing Queue handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Track running jobs for cancellation
  const runningJobs = new Map<string, { cancel: () => void; model?: string }>();

  ipcMain.handle('queue:run-ocr-cleanup', async (
    _event,
    jobId: string,
    epubPath: string,
    _model?: string, // Deprecated - use aiConfig instead
    aiConfig?: {
      provider: 'ollama' | 'claude' | 'openai';
      ollama?: { baseUrl: string; model: string };
      claude?: { apiKey: string; model: string };
      openai?: { apiKey: string; model: string };
      // Detailed cleanup mode options
      useDetailedCleanup?: boolean;
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
      // Parallel processing options (Claude/OpenAI only)
      useParallel?: boolean;
      parallelWorkers?: number;
      // Test mode: only process first N chunks
      testMode?: boolean;
      testModeChunks?: number;
      // Enable standard AI cleanup (OCR fixes, formatting)
      enableAiCleanup?: boolean;
      // Simplify for language learners (backwards compat: also accepts simplifyForChildren)
      simplifyForLearning?: boolean;
      simplifyForChildren?: boolean;  // Deprecated, use simplifyForLearning
      // Simplify mode: 'learning' (A1-B1 language learners) or 'plain' (plain language for audiobooks)
      simplifyMode?: 'learning' | 'plain';
      // Custom cleanup prompt (overrides default)
      cleanupPrompt?: string;
      // Additional instructions appended to the AI prompt
      customInstructions?: string;
    }
  ) => {
    console.log('[IPC] queue:run-ocr-cleanup received:', {
      jobId,
      useDetailedCleanup: aiConfig?.useDetailedCleanup,
      exampleCount: aiConfig?.deletedBlockExamples?.length || 0,
      useParallel: aiConfig?.useParallel,
      parallelWorkers: aiConfig?.parallelWorkers,
      testMode: aiConfig?.testMode,
      aiConfig: aiConfig ? {
        provider: aiConfig.provider,
        ollamaModel: aiConfig.ollama?.model,
        claudeModel: aiConfig.claude?.model,
        openaiModel: aiConfig.openai?.model
      } : 'MISSING - THIS IS A BUG'
    });

    // aiConfig is required - no fallbacks
    if (!aiConfig) {
      const error = 'aiConfig is required for OCR cleanup';
      console.error('[IPC] queue:run-ocr-cleanup ERROR:', error);
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: false,
          error
        });
      }
      return { success: false, error };
    }

    // Get model from the correct provider config
    let modelForCancellation: string | undefined;
    if (aiConfig.provider === 'ollama') {
      modelForCancellation = aiConfig.ollama?.model;
    } else if (aiConfig.provider === 'claude') {
      modelForCancellation = aiConfig.claude?.model;
    } else if (aiConfig.provider === 'openai') {
      modelForCancellation = aiConfig.openai?.model;
    }

    try {
      const { aiBridge } = await import('./ai-bridge.js');

      // Create cancellation token
      let cancelled = false;
      const cancelFn = () => { cancelled = true; };
      runningJobs.set(jobId, { cancel: cancelFn, model: modelForCancellation });

      // Run OCR cleanup with provider config - aiConfig is required, no model fallback
      // Cast deletedBlockExamples - category strings are validated at export time
      const cleanupOptions: {
        useDetailedCleanup?: boolean;
        deletedBlockExamples?: Array<{ text: string; category: 'header' | 'footer' | 'page_number' | 'custom' | 'block'; page?: number }>;
        useParallel?: boolean;
        parallelWorkers?: number;
        testMode?: boolean;
        testModeChunks?: number;
        enableAiCleanup?: boolean;
        simplifyForChildren?: boolean;
        simplifyMode?: 'learning' | 'plain';
        cleanupPrompt?: string;
        customInstructions?: string;
        outputDir?: string;
      } = {};

      // For manifest-based projects, write output to stages/01-cleanup/ instead of alongside source
      // Walk up the directory tree (max 5 levels) to find manifest.json — handles inputs
      // from any stage depth (e.g., stages/02-translate/translated.epub is 3 levels deep)
      let projectRoot: string | null = null;
      let searchDir = path.dirname(epubPath);
      for (let i = 0; i < 5 && searchDir !== path.dirname(searchDir); i++) {
        try {
          await fs.access(path.join(searchDir, 'manifest.json'));
          projectRoot = searchDir;
          break;
        } catch {
          searchDir = path.dirname(searchDir);
        }
      }
      if (projectRoot) {
        cleanupOptions.outputDir = path.join(projectRoot, 'stages', '01-cleanup');
        console.log('[IPC] Manifest project detected, output dir:', cleanupOptions.outputDir);
      }

      // Set test mode and test chunks
      cleanupOptions.testMode = aiConfig.testMode || false;
      if (aiConfig.testModeChunks) {
        cleanupOptions.testModeChunks = aiConfig.testModeChunks;
      }
      console.log('[IPC] Test mode:', aiConfig.testMode, 'chunks:', aiConfig.testModeChunks);

      // Pass through enableAiCleanup — if omitted, ai-bridge defaults to true
      if (aiConfig.enableAiCleanup !== undefined) {
        cleanupOptions.enableAiCleanup = aiConfig.enableAiCleanup;
      }

      // Set simplify mode (support both names for backwards compatibility)
      cleanupOptions.simplifyForChildren = aiConfig.simplifyForLearning || aiConfig.simplifyForChildren || false;
      cleanupOptions.simplifyMode = aiConfig.simplifyMode || 'learning';
      if (cleanupOptions.simplifyForChildren) {
        console.log(`[IPC] Simplify mode: ENABLED (${cleanupOptions.simplifyMode})`);
      }
      console.log('[IPC] enableAiCleanup:', cleanupOptions.enableAiCleanup, 'simplifyForChildren:', cleanupOptions.simplifyForChildren, 'simplifyMode:', cleanupOptions.simplifyMode);

      // Set custom prompt if provided
      if (aiConfig.cleanupPrompt) {
        cleanupOptions.cleanupPrompt = aiConfig.cleanupPrompt;
        console.log('[IPC] Using custom cleanup prompt');
      }

      // Pass through custom instructions
      if (aiConfig.customInstructions) {
        cleanupOptions.customInstructions = aiConfig.customInstructions;
        console.log('[IPC] Custom instructions provided');
      }

      if (aiConfig.useDetailedCleanup) {
        cleanupOptions.useDetailedCleanup = true;
        cleanupOptions.deletedBlockExamples = aiConfig.deletedBlockExamples?.map(ex => ({
          text: ex.text,
          category: ex.category as 'header' | 'footer' | 'page_number' | 'custom' | 'block',
          page: ex.page
        }));
      }

      // Parallel processing (only for Claude/OpenAI)
      if (aiConfig.useParallel && aiConfig.provider !== 'ollama') {
        cleanupOptions.useParallel = true;
        cleanupOptions.parallelWorkers = aiConfig.parallelWorkers || 3;
      }

      const result = await aiBridge.cleanupEpub(
        epubPath,
        jobId,
        mainWindow,
        (progress) => {
          if (cancelled) return;
          // Progress is sent via mainWindow.webContents.send in cleanupEpub
        },
        aiConfig,
        cleanupOptions
      );

      // Remove from running jobs
      runningJobs.delete(jobId);

      // Send completion event
      if (mainWindow && !cancelled) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: result.success,
          outputPath: result.outputPath,
          error: result.error,
          copyrightIssuesDetected: result.copyrightIssuesDetected,
          copyrightChunksAffected: result.copyrightChunksAffected,
          contentSkipsDetected: result.contentSkipsDetected,
          contentSkipsAffected: result.contentSkipsAffected,
          skippedChunksPath: result.skippedChunksPath,
          analytics: result.analytics  // Include cleanup analytics
        });

        // Notify file list so cleaned EPUB appears without manual refresh
        if (cleanupOptions.outputDir) {
          mainWindow.webContents.send('project:files-changed', projectRoot);
        }
      }

      return { success: result.success, data: result };
    } catch (err) {
      runningJobs.delete(jobId);
      const error = (err as Error).message;

      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: false,
          error
        });
      }

      return { success: false, error };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Book Analysis handler
  // ─────────────────────────────────────────────────────────────────────────
  ipcMain.handle('queue:run-book-analysis', async (
    _event,
    jobId: string,
    epubPath: string,
    aiConfig: {
      provider: 'ollama' | 'claude' | 'openai';
      ollama?: { baseUrl: string; model: string };
      claude?: { apiKey: string; model: string };
      openai?: { apiKey: string; model: string };
      categories: Array<{ id: string; name: string; description: string; color: string; enabled: boolean }>;
      testMode?: boolean;
      testModeChunks?: number;
    }
  ) => {
    console.log('[IPC] queue:run-book-analysis received:', {
      jobId,
      provider: aiConfig?.provider,
      categoryCount: aiConfig?.categories?.length || 0,
      testMode: aiConfig?.testMode,
    });

    if (!aiConfig) {
      const error = 'aiConfig is required for book analysis';
      console.error('[IPC] queue:run-book-analysis ERROR:', error);
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', { jobId, success: false, error });
      }
      return { success: false, error };
    }

    try {
      const { analyzeBook, cancelAnalysisJob } = await import('./book-analysis.js');

      // Register cancellation
      const cancelFn = () => { cancelAnalysisJob(jobId); };
      runningJobs.set(jobId, { cancel: cancelFn, model: aiConfig.ollama?.model || aiConfig.claude?.model || aiConfig.openai?.model });

      // Detect project root for output directory
      let outputDir: string | undefined;
      let projectRoot: string | null = null;
      let searchDir = path.dirname(epubPath);
      for (let i = 0; i < 5 && searchDir !== path.dirname(searchDir); i++) {
        try {
          await fs.access(path.join(searchDir, 'manifest.json'));
          projectRoot = searchDir;
          break;
        } catch {
          searchDir = path.dirname(searchDir);
        }
      }
      if (projectRoot) {
        outputDir = path.join(projectRoot, 'stages', '04-analysis');
        console.log('[IPC] Manifest project detected, analysis output dir:', outputDir);
      }

      const result = await analyzeBook(
        epubPath,
        jobId,
        mainWindow,
        aiConfig,
        {
          categories: aiConfig.categories,
          testMode: aiConfig.testMode || false,
          testModeChunks: aiConfig.testModeChunks,
          outputDir,
        }
      );

      runningJobs.delete(jobId);

      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: result.success,
          outputPath: result.outputPath,
          error: result.error,
          flagCount: result.flagCount,
          analytics: result.analytics,
        });

        if (projectRoot) {
          mainWindow.webContents.send('project:files-changed', projectRoot);
        }
      }

      return { success: result.success, data: result };
    } catch (err) {
      runningJobs.delete(jobId);
      const error = (err as Error).message;
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', { jobId, success: false, error });
      }
      return { success: false, error };
    }
  });

  // Translation handler
  ipcMain.handle('queue:run-translation', async (
    _event,
    jobId: string,
    epubPath: string,
    translationConfig: {
      chunkSize?: number;
    },
    aiConfig?: {
      provider: 'ollama' | 'claude' | 'openai';
      ollama?: { baseUrl: string; model: string };
      claude?: { apiKey: string; model: string };
      openai?: { apiKey: string; model: string };
    }
  ) => {
    console.log('[IPC] queue:run-translation received:', {
      jobId,
      aiConfig: aiConfig ? {
        provider: aiConfig.provider,
        ollamaModel: aiConfig.ollama?.model,
        claudeModel: aiConfig.claude?.model,
        openaiModel: aiConfig.openai?.model
      } : 'MISSING - THIS IS A BUG'
    });

    // aiConfig is required
    if (!aiConfig) {
      const error = 'aiConfig is required for translation';
      console.error('[IPC] queue:run-translation ERROR:', error);
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: false,
          error
        });
      }
      return { success: false, error };
    }

    try {
      const { translationBridge } = await import('./translation-bridge.js');

      // Create cancellation token
      let cancelled = false;
      const cancelFn = () => {
        cancelled = true;
        translationBridge.cancelTranslationJob(jobId);
      };
      runningJobs.set(jobId, { cancel: cancelFn });

      const result = await translationBridge.translateEpub(
        epubPath,
        jobId,
        mainWindow,
        (progress) => {
          if (cancelled) return;
          // Progress is sent via mainWindow.webContents.send in translateEpub
        },
        aiConfig,
        translationConfig
      );

      // Remove from running jobs
      runningJobs.delete(jobId);

      // Send completion event
      if (mainWindow && !cancelled) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: result.success,
          outputPath: result.outputPath,
          error: result.error
        });
      }

      return { success: result.success, data: result };
    } catch (err) {
      runningJobs.delete(jobId);
      const error = (err as Error).message;

      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: false,
          error
        });
      }

      return { success: false, error };
    }
  });

  ipcMain.handle('queue:run-tts-conversion', async (
    _event,
    jobId: string,
    epubPath: string,
    settings: {
      device: 'gpu' | 'mps' | 'cpu';
      language: string;
      ttsEngine: string;
      fineTuned: string;
      temperature: number;
      topP: number;
      topK: number;
      repetitionPenalty: number;
      speed: number;
      enableTextSplitting: boolean;
      outputFilename?: string;
      outputDir?: string;
    }
  ) => {
    try {
      const { ttsBridge } = await import('./tts-bridge.js');
      ttsBridge.setMainWindow(mainWindow);

      // Get output directory - use custom if provided, otherwise default
      let outputDir: string;
      if (settings.outputDir && settings.outputDir.trim()) {
        outputDir = settings.outputDir;
      } else {
        const documentsPath = app.getPath('documents');
        outputDir = path.join(documentsPath, 'BookForge', 'output');
      }
      await fs.mkdir(outputDir, { recursive: true });

      // Create cancellation token
      const cancelFn = () => { ttsBridge.stopConversion(); };
      runningJobs.set(jobId, { cancel: cancelFn });

      // Run TTS conversion with queue progress callback
      const result = await ttsBridge.startConversion(epubPath, outputDir, settings, (progress) => {
        console.log('[TTS->Queue] Forwarding progress:', progress.phase, progress.percentage + '%');
        if (mainWindow) {
          mainWindow.webContents.send('queue:progress', {
            jobId,
            type: 'tts-conversion',
            phase: progress.phase,
            progress: progress.percentage,
            message: progress.message,
            currentChunk: progress.currentChapter,
            totalChunks: progress.totalChapters
          });
        }
      }, settings.outputFilename);

      // Remove from running jobs
      runningJobs.delete(jobId);

      // Send completion event
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: result.success,
          outputPath: result.outputPath,
          error: result.error
        });
      }

      return { success: result.success, data: result };
    } catch (err) {
      runningJobs.delete(jobId);
      const error = (err as Error).message;

      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: false,
          error
        });
      }

      return { success: false, error };
    }
  });

  ipcMain.handle('queue:cancel-job', async (_event, jobId: string) => {
    console.log('[IPC] queue:cancel-job called for:', jobId);

    let cancelled = false;

    // Try to cancel AI cleanup job (uses abort controller for immediate cancellation)
    try {
      const { cancelCleanupJob } = await import('./ai-bridge.js');
      if (cancelCleanupJob(jobId)) {
        console.log('[IPC] AI cleanup job cancelled via abort controller:', jobId);
        cancelled = true;
      }
    } catch (err) {
      console.error('[IPC] Error cancelling AI cleanup job:', err);
    }

    // Try to cancel parallel TTS job
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      if (parallelTtsBridge.stopParallelConversion(jobId)) {
        console.log('[IPC] Parallel TTS job cancelled:', jobId);
        cancelled = true;
      }
    } catch (err) {
      console.error('[IPC] Error cancelling parallel TTS job:', err);
    }

    // Try to cancel reassembly job
    try {
      const { stopReassembly } = await import('./reassembly-bridge.js');
      if (stopReassembly(jobId)) {
        console.log('[IPC] Reassembly job cancelled:', jobId);
        cancelled = true;
      }
    } catch (err) {
      console.error('[IPC] Error cancelling reassembly job:', err);
    }

    // Try the legacy running jobs map
    const job = runningJobs.get(jobId);
    if (job) {
      job.cancel();
      runningJobs.delete(jobId);
      console.log('[IPC] Legacy job cancelled:', jobId);
      cancelled = true;

      // If this was an Ollama job, unload the model to free memory
      if (job.model) {
        try {
          await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: job.model, keep_alive: 0 })
          });
          console.log('[IPC] Ollama model unloaded after cancel:', job.model);
        } catch {
          // Ollama might not be running, or this wasn't an Ollama job - ignore
        }
      }
    }

    if (cancelled) {
      return { success: true };
    }
    return { success: false, error: 'Job not found or not running' };
  });

  // Queue persistence handlers
  // Queue is system-specific (each machine has its own jobs), so store in app userData folder
  const getQueueFilePath = () => path.join(app.getPath('userData'), 'queue.json');

  ipcMain.handle('queue:save-state', async (_event, queueState: string) => {
    try {
      const userDataPath = app.getPath('userData');
      await fs.mkdir(userDataPath, { recursive: true });
      const queueFile = getQueueFilePath();
      await atomicWriteFile(queueFile, queueState);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('queue:load-state', async () => {
    try {
      const queueFile = getQueueFilePath();
      const exists = fsSync.existsSync(queueFile);
      if (!exists) {
        return { success: true, data: null };
      }
      const content = await fs.readFile(queueFile, 'utf-8');
      return { success: true, data: JSON.parse(content) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Logger IPC Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('logger:initialize', async () => {
    try {
      const logger = await import('./audiobook-logger.js');
      const libraryPath = getLibraryRoot();
      await logger.initializeLogger(libraryPath);

      // Also initialize the TTS bridge logger
      const { ttsBridge } = await import('./tts-bridge.js');
      await ttsBridge.initializeLogger(libraryPath);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('logger:get-todays-summary', async () => {
    try {
      const logger = await import('./audiobook-logger.js');
      const summary = await logger.getTodaysSummary();
      return { success: true, data: summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('logger:get-recent-errors', async (_event, days: number = 7) => {
    try {
      const logger = await import('./audiobook-logger.js');
      const errors = await logger.getRecentErrors(days);
      return { success: true, data: errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('logger:search-logs', async (_event, searchTerm: string, days: number = 7) => {
    try {
      const logger = await import('./audiobook-logger.js');
      const results = await logger.searchLogs(searchTerm, days);
      return { success: true, data: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('logger:generate-daily-report', async () => {
    try {
      const logger = await import('./audiobook-logger.js');
      const report = await logger.generateDailySummaryReport();
      return { success: true, data: report };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Reassembly handlers - Browse incomplete e2a sessions and reassemble audiobooks
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('reassembly:scan-sessions', async (_event, customTmpPath?: string) => {
    try {
      const { scanE2aTmpFolder } = await import('./reassembly-bridge.js');
      const result = await scanE2aTmpFolder(customTmpPath);
      return { success: true, data: result };
    } catch (err) {
      console.error('[MAIN] reassembly:scan-sessions error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:get-session', async (_event, sessionId: string, customTmpPath?: string) => {
    try {
      const { getSession } = await import('./reassembly-bridge.js');
      const session = await getSession(sessionId, customTmpPath);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      return { success: true, data: session };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:start', async (_event, jobId: string, config: any) => {
    try {
      const { startReassembly } = await import('./reassembly-bridge.js');
      const result = await startReassembly(jobId, config, mainWindow);
      return { success: result.success, data: { outputPath: result.outputPath }, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:stop', async (_event, jobId: string) => {
    try {
      const { stopReassembly } = await import('./reassembly-bridge.js');
      const stopped = stopReassembly(jobId);
      return { success: stopped };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:delete-session', async (_event, sessionId: string, customTmpPath?: string) => {
    try {
      const { deleteSession } = await import('./reassembly-bridge.js');
      const deleted = await deleteSession(sessionId, customTmpPath);
      return { success: deleted, error: deleted ? undefined : 'Failed to delete session folder' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:save-metadata', async (_event, sessionId: string, processDir: string, metadata: any, coverData?: any) => {
    try {
      const { saveSessionMetadata } = await import('./reassembly-bridge.js');
      const result = await saveSessionMetadata(sessionId, processDir, metadata, coverData);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:is-available', async () => {
    try {
      const { isE2aAvailable } = await import('./reassembly-bridge.js');
      return { success: true, data: { available: isE2aAvailable() } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('reassembly:get-bfp-session', async (_event, bfpPath: string) => {
    try {
      const { getBfpCachedSession } = await import('./reassembly-bridge.js');
      const session = await getBfpCachedSession(bfpPath);
      if (!session) {
        return { success: true, data: null };
      }
      return { success: true, data: session };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Chapter Recovery handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('chapter-recovery:detect-chapters', async (
    _event,
    epubPath: string,
    vttPath: string
  ) => {
    try {
      const { detectChapters } = await import('./chapter-recovery-bridge.js');
      return await detectChapters(epubPath, vttPath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('chapter-recovery:apply-chapters', async (
    _event,
    m4bPath: string,
    chapters: Array<{ title: string; timestamp: string }>
  ) => {
    try {
      const { applyChaptersToM4b } = await import('./chapter-recovery-bridge.js');
      return await applyChaptersToM4b(m4bPath, chapters);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Debug handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('debug:log', async (_event, message: string) => {
    console.log('[RENDERER]', message);
  });

  ipcMain.handle('debug:save-logs', async (_event, content: string, filename: string) => {
    try {
      const logsDir = path.join(getLibraryRoot(), 'logs');
      await fs.mkdir(logsDir, { recursive: true });
      const logPath = path.join(logsDir, filename);
      await fs.writeFile(logPath, content, 'utf-8');
      console.log('[MAIN] ===== DEVELOPER CONSOLE LOGS SAVED TO FILE =====');
      console.log('[MAIN] LOG FILE LOCATION:', logPath);
      console.log('[MAIN] ===========================================');
      return { success: true, path: logPath };
    } catch (err) {
      console.error('[MAIN] Failed to save logs:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Language Learning handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('language-learning:fetch-url', async (_event, url: string, projectId?: string) => {
    console.log('[MAIN] language-learning:fetch-url called with:', url, 'projectId:', projectId);
    try {
      const { fetchUrlToPdf } = await import('./web-fetch-bridge.js');
      console.log('[MAIN] Calling fetchUrlToPdf...');
      const result = await fetchUrlToPdf(url, getLibraryRoot(), projectId);
      console.log('[MAIN] fetchUrlToPdf result:', JSON.stringify(result, null, 2));
      return result;
    } catch (err) {
      console.error('[MAIN] language-learning:fetch-url error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:save-project', async (_event, project: any) => {
    try {
      const { saveProject } = await import('./web-fetch-bridge.js');
      return await saveProject(project, getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:load-project', async (_event, projectId: string) => {
    try {
      const { loadProject } = await import('./web-fetch-bridge.js');
      return await loadProject(projectId, getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:list-projects', async () => {
    try {
      const { listProjects } = await import('./web-fetch-bridge.js');
      return await listProjects(getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:delete-project', async (_event, projectId: string) => {
    try {
      const { deleteProject } = await import('./web-fetch-bridge.js');
      return await deleteProject(projectId, getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:update-project', async (_event, projectId: string, updates: any) => {
    try {
      const { updateProject } = await import('./web-fetch-bridge.js');
      return await updateProject(projectId, updates, getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:confirm-delete', async (_event, title: string) => {
    const { dialog } = await import('electron');
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete Project',
      message: `Delete "${title}"?`,
      detail: 'This will permanently delete the project and any associated audiobook files.',
    });
    return { confirmed: result.response === 1 };
  });

  ipcMain.handle('language-learning:ensure-directory', async (_event, dirPath: string) => {
    try {
      const { ensureDirectory } = await import('./web-fetch-bridge.js');
      return await ensureDirectory(dirPath);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:delete-audiobooks', async (_event, projectId: string) => {
    try {
      const { deleteProjectAudiobooks } = await import('./web-fetch-bridge.js');
      return await deleteProjectAudiobooks(projectId, getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:list-completed', async () => {
    try {
      const { listCompletedAudiobooks } = await import('./web-fetch-bridge.js');
      return await listCompletedAudiobooks(getLibraryRoot());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:extract-text', async (_event, htmlPath: string, deletedSelectors: string[]) => {
    try {
      const { extractTextFromHtml } = await import('./web-fetch-bridge.js');
      return await extractTextFromHtml(htmlPath, deletedSelectors);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:write-file', async (_event, filePath: string, content: string) => {
    try {
      const fsPromises = await import('fs/promises');
      await fsPromises.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Finalize article content - filters HTML using deletedSelectors, generates EPUB
  // NOTE: We ignore the passed finalizedHtml and filter on the backend for reliability
  ipcMain.handle('language-learning:finalize-content', async (_event, projectId: string, _finalizedHtml: string) => {
    try {
      const pathMod = await import('path');
      const fsPromises = await import('fs/promises');
      const zlibMod = await import('zlib');
      const { promisify: promisifyUtil } = await import('util');
      const os = await import('os');
      const cheerio = await import('cheerio');

      const projectDir = pathMod.join(getLibraryRoot(), 'language-learning', 'projects', projectId);
      const projectFile = pathMod.join(projectDir, 'project.json');
      const finalizedFile = pathMod.join(projectDir, 'finalized.html');
      const epubPath = pathMod.join(projectDir, 'article.epub');

      // Load project data
      const projectData = JSON.parse(await fsPromises.readFile(projectFile, 'utf-8'));
      const title = projectData.title || 'Untitled Article';
      const lang = projectData.sourceLang || 'en';
      const deletedSelectors: string[] = projectData.deletedSelectors || [];
      const htmlPath = projectData.htmlPath;

      if (!htmlPath) {
        return { success: false, error: 'No htmlPath in project.json' };
      }

      console.log(`[MAIN] Finalize: projectId=${projectId}, deletedSelectors=${deletedSelectors.length}, htmlPath=${htmlPath}`);

      // Read the original HTML from htmlPath
      const sourceHtml = await fsPromises.readFile(htmlPath, 'utf-8');
      console.log(`[MAIN] Read source HTML: ${sourceHtml.length} chars from ${htmlPath}`);

      // Parse HTML and filter out deleted elements using cheerio
      const $ = cheerio.load(sourceHtml);

      // IMPORTANT: Collect all elements FIRST before removing any.
      // Removing elements shifts nth-of-type indices, breaking later selectors.
      const elementsToRemove: any[] = [];
      let matchedSelectors = 0;
      for (const selector of deletedSelectors) {
        try {
          const elements = $(selector);
          if (elements.length > 0) {
            matchedSelectors++;
            elements.each((_i: number, el: any) => {
              elementsToRemove.push(el);
            });
          }
        } catch (err) {
          console.warn(`[MAIN] Failed to match selector "${selector}":`, err);
        }
      }

      // Now remove all collected elements
      elementsToRemove.forEach(el => $(el).remove());
      console.log(`[MAIN] Removed ${elementsToRemove.length} elements from ${matchedSelectors}/${deletedSelectors.length} matched selectors`);

      // Get the filtered body content
      const filteredHtml = $('body').html() || '';
      console.log(`[MAIN] Filtered HTML: ${filteredHtml.length} chars`);

      // Write finalized HTML
      await fsPromises.writeFile(finalizedFile, filteredHtml, 'utf-8');
      console.log(`[MAIN] Wrote finalized HTML: ${finalizedFile} (${filteredHtml.length} bytes)`);

      // Generate EPUB from the finalized HTML
      const tempDir = pathMod.join(os.tmpdir(), `bookforge-epub-${projectId}`);
      await fsPromises.mkdir(tempDir, { recursive: true });
      await fsPromises.mkdir(pathMod.join(tempDir, 'META-INF'), { recursive: true });
      await fsPromises.mkdir(pathMod.join(tempDir, 'OEBPS'), { recursive: true });

      // Write mimetype (must be first, uncompressed)
      await fsPromises.writeFile(pathMod.join(tempDir, 'mimetype'), 'application/epub+zip');

      // Write container.xml
      await fsPromises.writeFile(
        pathMod.join(tempDir, 'META-INF', 'container.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
      );

      // Write content.opf
      const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      await fsPromises.writeFile(
        pathMod.join(tempDir, 'OEBPS', 'content.opf'),
        `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${projectId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`
      );

      // Write nav.xhtml
      await fsPromises.writeFile(
        pathMod.join(tempDir, 'OEBPS', 'nav.xhtml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}">
<head><title>Navigation</title></head>
<body>
  <nav epub:type="toc">
    <ol><li><a href="chapter1.xhtml">${escapeXml(title)}</a></li></ol>
  </nav>
</body>
</html>`
      );

      // Write chapter1.xhtml with the filtered HTML content
      await fsPromises.writeFile(
        pathMod.join(tempDir, 'OEBPS', 'chapter1.xhtml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; margin: 2em; }
    p { margin-bottom: 1em; }
    h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
  </style>
</head>
<body>
  ${filteredHtml}
</body>
</html>`
      );

      // Create EPUB ZIP (cross-platform, no external zip command needed)
      try { await fsPromises.unlink(epubPath); } catch { /* ignore */ }

      const deflateRawFn = promisifyUtil(zlibMod.deflateRaw);
      const epubCrc32 = (data: Buffer): number => {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < data.length; i++) {
          crc ^= data[i];
          for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
      };

      const collectEpubFiles = async (dir: string, base: string): Promise<string[]> => {
        const results: string[] = [];
        const dirEntries = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const ent of dirEntries) {
          const rel = base ? `${base}/${ent.name}` : ent.name;
          if (ent.isDirectory()) results.push(...await collectEpubFiles(pathMod.join(dir, ent.name), rel));
          else results.push(rel);
        }
        return results;
      };

      // mimetype must be first, stored uncompressed (EPUB spec)
      const epubEntries: Array<{ name: string; data: Buffer; compress: boolean }> = [];
      epubEntries.push({ name: 'mimetype', data: await fsPromises.readFile(pathMod.join(tempDir, 'mimetype')), compress: false });
      for (const sub of ['META-INF', 'OEBPS']) {
        const subPath = pathMod.join(tempDir, sub);
        try {
          const files = await collectEpubFiles(subPath, sub);
          for (const f of files) epubEntries.push({ name: f, data: await fsPromises.readFile(pathMod.join(tempDir, f)), compress: true });
        } catch { /* skip */ }
      }

      const centralDir: Buffer[] = [];
      const fileChunks: Buffer[] = [];
      let zipOffset = 0;
      for (const entry of epubEntries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const compressed = entry.compress && entry.data.length > 0 ? await deflateRawFn(entry.data) as Buffer : entry.data;
        const method = entry.compress && entry.data.length > 0 ? 8 : 0;
        const crc = epubCrc32(entry.data);
        const lh = Buffer.alloc(30 + nameBuf.length);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(compressed.length, 18);
        lh.writeUInt32LE(entry.data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28); nameBuf.copy(lh, 30);
        fileChunks.push(lh, compressed);
        const ce = Buffer.alloc(46 + nameBuf.length);
        ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6);
        ce.writeUInt16LE(0, 8); ce.writeUInt16LE(method, 10); ce.writeUInt16LE(0, 12);
        ce.writeUInt16LE(0, 14); ce.writeUInt32LE(crc, 16); ce.writeUInt32LE(compressed.length, 20);
        ce.writeUInt32LE(entry.data.length, 24); ce.writeUInt16LE(nameBuf.length, 28);
        ce.writeUInt16LE(0, 30); ce.writeUInt16LE(0, 32); ce.writeUInt16LE(0, 34);
        ce.writeUInt16LE(0, 36); ce.writeUInt32LE(0, 38); ce.writeUInt32LE(zipOffset, 42);
        nameBuf.copy(ce, 46);
        centralDir.push(ce);
        zipOffset += lh.length + compressed.length;
      }
      const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(epubEntries.length, 8); eocd.writeUInt16LE(epubEntries.length, 10);
      eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(zipOffset, 16); eocd.writeUInt16LE(0, 20);
      await fsPromises.writeFile(epubPath, Buffer.concat([...fileChunks, ...centralDir, eocd]));

      // Cleanup temp dir
      await fsPromises.rm(tempDir, { recursive: true, force: true });

      console.log(`[MAIN] Generated EPUB: ${epubPath}`);

      // Update project.json with contentFinalized flag and EPUB path
      projectData.contentFinalized = true;
      projectData.epubPath = epubPath;
      projectData.modifiedAt = new Date().toISOString();
      await fsPromises.writeFile(projectFile, JSON.stringify(projectData, null, 2), 'utf-8');

      console.log(`[MAIN] Finalized content for project ${projectId}`);
      return { success: true, epubPath };
    } catch (err) {
      console.error(`[MAIN] Failed to finalize content for ${projectId}:`, err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Player-related handlers for bilingual audiobooks
  ipcMain.handle('language-learning:get-audio-path', async (_event, projectId: string) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const audiobooksDir = path.join(getLibraryRoot(), 'language-learning', 'audiobooks');
      const audioPath = path.join(audiobooksDir, `${projectId}.m4b`);

      // Check if file exists
      try {
        await fsPromises.access(audioPath);
        return { success: true, path: audioPath };
      } catch {
        return { success: false, error: 'Audio file not found' };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get audio as base64 data URL (more reliable than custom protocols)
  ipcMain.handle('language-learning:get-audio-data', async (_event, projectId: string) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const audiobooksDir = path.join(getLibraryRoot(), 'language-learning', 'audiobooks');
      const audioPath = path.join(audiobooksDir, `${projectId}.m4b`);

      // Read file as buffer and convert to base64
      const buffer = await fsPromises.readFile(audioPath);
      const base64 = buffer.toString('base64');
      const dataUrl = `data:audio/mp4;base64,${base64}`;

      console.log(`[MAIN] Loaded audio for ${projectId}: ${buffer.length} bytes`);
      return { success: true, dataUrl, size: buffer.length };
    } catch (err) {
      console.error(`[MAIN] Failed to load audio for ${projectId}:`, err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Check if audio exists for a project (quick check without loading)
  ipcMain.handle('language-learning:has-audio', async (_event, projectId: string) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const audiobooksDir = path.join(getLibraryRoot(), 'language-learning', 'audiobooks');
      const audioPath = path.join(audiobooksDir, `${projectId}.m4b`);

      try {
        await fsPromises.access(audioPath);
        return { success: true, hasAudio: true };
      } catch {
        return { success: true, hasAudio: false };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete audio and associated data for a project (for re-generation)
  ipcMain.handle('language-learning:delete-audio', async (_event, projectId: string) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const audiobooksDir = path.join(getLibraryRoot(), 'language-learning', 'audiobooks');
      const projectsDir = path.join(getLibraryRoot(), 'language-learning', 'projects', projectId);

      // Delete audio file
      const audioPath = path.join(audiobooksDir, `${projectId}.m4b`);
      try {
        await fsPromises.unlink(audioPath);
        console.log(`[MAIN] Deleted audio: ${audioPath}`);
      } catch { /* File might not exist */ }

      // Delete VTT file
      const vttPath = path.join(audiobooksDir, `${projectId}.vtt`);
      try {
        await fsPromises.unlink(vttPath);
        console.log(`[MAIN] Deleted VTT: ${vttPath}`);
      } catch { /* File might not exist */ }

      // Delete generated EPUBs and data from project folder
      // EPUBs are named by language (e.g., en.epub, de.epub) - delete all .epub files
      const sentencePairs = path.join(projectsDir, 'sentence_pairs.json');
      const cleanedTxt = path.join(projectsDir, 'cleaned.txt');
      const analyticsJson = path.join(projectsDir, 'analytics.json');

      // Delete known data files
      for (const file of [sentencePairs, cleanedTxt, analyticsJson]) {
        try {
          await fsPromises.unlink(file);
          console.log(`[MAIN] Deleted: ${file}`);
        } catch { /* File might not exist */ }
      }

      // Delete all language-named EPUBs (en.epub, de.epub, etc.)
      try {
        const files = await fsPromises.readdir(projectsDir);
        for (const file of files) {
          if (file.endsWith('.epub') && file.length <= 7) { // e.g., "en.epub" = 7 chars
            const epubPath = path.join(projectsDir, file);
            await fsPromises.unlink(epubPath);
            console.log(`[MAIN] Deleted: ${epubPath}`);
          }
        }
      } catch { /* Directory might not exist */ }

      return { success: true };
    } catch (err) {
      console.error(`[MAIN] Failed to delete audio for ${projectId}:`, err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:read-vtt', async (_event, projectId: string) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const audiobooksDir = path.join(getLibraryRoot(), 'language-learning', 'audiobooks');
      // VTT files are stored alongside the M4B files
      const vttPath = path.join(audiobooksDir, `${projectId}.vtt`);

      const content = await fsPromises.readFile(vttPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:read-sentence-pairs', async (_event, projectId: string) => {
    try {
      const fsPromises = await import('fs/promises');

      // 1. Try manifest project: check manifest for sentencePairsPath, then scan stages/02-translate/
      const manifestProjectDir = manifestService.getProjectPath(projectId);
      if (manifestProjectDir) {
        // Check manifest outputs first
        const manifestResult = await manifestService.getManifest(projectId);
        if (manifestResult.success && manifestResult.manifest?.outputs?.bilingualAudiobooks) {
          const keys = Object.keys(manifestResult.manifest.outputs.bilingualAudiobooks);
          if (keys.length > 0) {
            const bilingual = manifestResult.manifest.outputs.bilingualAudiobooks[keys[0]];
            if (bilingual.sentencePairsPath) {
              const absPairsPath = path.join(manifestProjectDir, bilingual.sentencePairsPath);
              if (fsSync.existsSync(absPairsPath)) {
                const content = await fsPromises.readFile(absPairsPath, 'utf-8');
                return { success: true, pairs: JSON.parse(content) };
              }
            }
          }
        }

        // Scan stages/02-translate/ for sentence_pairs_*.json
        const translateDir = path.join(manifestProjectDir, 'stages', '02-translate');
        if (fsSync.existsSync(translateDir)) {
          const files = await fsPromises.readdir(translateDir);
          const pairsFile = files.find(f => f.startsWith('sentence_pairs_') && f.endsWith('.json'));
          if (pairsFile) {
            const content = await fsPromises.readFile(path.join(translateDir, pairsFile), 'utf-8');
            return { success: true, pairs: JSON.parse(content) };
          }
        }
      }

      // 2. Fallback: legacy LL article path
      const legacyDir = path.join(getLibraryRoot(), 'language-learning', 'projects', projectId);
      const pairsPath = path.join(legacyDir, 'sentence_pairs.json');
      const content = await fsPromises.readFile(pairsPath, 'utf-8');
      return { success: true, pairs: JSON.parse(content) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:get-analytics', async (_event, projectId: string) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const projectDir = path.join(getLibraryRoot(), 'language-learning', 'projects', projectId);
      const analyticsPath = path.join(projectDir, 'analytics.json');

      const content = await fsPromises.readFile(analyticsPath, 'utf-8');
      const analytics = JSON.parse(content);
      return { success: true, analytics };
    } catch (err) {
      // Analytics file may not exist yet - that's OK
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true, analytics: null };
      }
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:save-analytics', async (_event, projectId: string, analytics: any) => {
    try {
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const projectDir = path.join(getLibraryRoot(), 'language-learning', 'projects', projectId);
      const analyticsPath = path.join(projectDir, 'analytics.json');

      await fsPromises.writeFile(analyticsPath, JSON.stringify(analytics, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('language-learning:run-job', async (_event, jobId: string, config: {
    projectId: string;
    sourceUrl: string;
    sourceLang: string;
    targetLang: string;
    htmlPath: string;
    pdfPath?: string;
    deletedBlockIds: string[];
    title?: string;
    aiProvider: 'ollama' | 'claude' | 'openai';
    aiModel: string;
    ollamaBaseUrl?: string;
    claudeApiKey?: string;
    openaiApiKey?: string;
    sourceVoice: string;
    targetVoice: string;
    ttsEngine: 'xtts' | 'orpheus';
    speed: number;
    device: 'gpu' | 'mps' | 'cpu';
  }) => {
    try {
      const { runLanguageLearningJob } = await import('./language-learning-jobs.js');
      return await runLanguageLearningJob(jobId, config, mainWindow);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Bilingual Processing Pipeline Jobs
  // ─────────────────────────────────────────────────────────────────────────────

  // Job 1: AI Cleanup - reads from source EPUB, writes to cleaned.epub or simplified.epub
  ipcMain.handle('bilingual-cleanup:run', async (_event, jobId: string, config: {
    projectId: string;
    projectDir: string;
    sourceEpubPath?: string;
    sourceLang: string;
    aiProvider: 'ollama' | 'claude' | 'openai';
    aiModel: string;
    ollamaBaseUrl?: string;
    claudeApiKey?: string;
    openaiApiKey?: string;
    cleanupPrompt?: string;
    customInstructions?: string;
    simplifyForLearning?: boolean;
    testMode?: boolean;
    testModeChunks?: number;
  }) => {
    try {
      const { runLLCleanup } = await import('./ll-jobs.js');
      return await runLLCleanup(jobId, config, mainWindow);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Job 2: Translation - reads from cleaned/simplified EPUB, writes translated EPUBs
  // Also supports mono translation (full book translation to single language)
  ipcMain.handle('bilingual-translation:run', async (_event, jobId: string, config: {
    projectId?: string;
    projectDir?: string;
    cleanedEpubPath?: string;
    sourceLang: string;
    targetLang: string;
    title?: string;
    aiProvider: 'ollama' | 'claude' | 'openai';
    aiModel: string;
    ollamaBaseUrl?: string;
    claudeApiKey?: string;
    openaiApiKey?: string;
    translationPrompt?: string;
    customInstructions?: string;
    monoTranslation?: boolean;
    testMode?: boolean;
    testModeChunks?: number;
  }) => {
    try {
      const { runLLTranslation, runMonoTranslation } = await import('./ll-jobs.js');

      // For mono translation, use dedicated handler
      if (config.monoTranslation) {
        return await runMonoTranslation(jobId, config, mainWindow);
      }

      return await runLLTranslation(jobId, config, mainWindow);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Sentence Cache IPC Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Language name mapping for display
  const LANGUAGE_NAMES: Record<string, string> = {
    'en': 'English', 'de': 'German', 'es': 'Spanish', 'fr': 'French',
    'hu': 'Hungarian', 'it': 'Italian', 'pt': 'Portuguese', 'nl': 'Dutch',
    'pl': 'Polish', 'ru': 'Russian', 'ja': 'Japanese', 'zh': 'Chinese', 'ko': 'Korean',
  };

  // List cached languages for a project
  ipcMain.handle('sentence-cache:list', async (_event, audiobookFolder: string) => {
    try {
      const sentencesDir = path.join(audiobookFolder, 'sentences');

      // Check if sentences folder exists
      if (!fsSync.existsSync(sentencesDir)) {
        return { success: true, languages: [] };
      }

      const files = await fs.readdir(sentencesDir);
      const languages: Array<{
        code: string;
        name: string;
        sentenceCount: number;
        sourceLanguage: string | null;
        createdAt: string;
        hasAudio: boolean;
        ttsSettings?: { engine: string; voice: string; speed: number };
      }> = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const code = file.replace('.json', '');
        const filePath = path.join(sentencesDir, file);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const cache = JSON.parse(content);
          languages.push({
            code,
            name: LANGUAGE_NAMES[code] || code.toUpperCase(),
            sentenceCount: cache.sentenceCount || 0,
            sourceLanguage: cache.sourceLanguage,
            createdAt: cache.createdAt || new Date().toISOString(),
            hasAudio: cache.hasAudio || false,
            ttsSettings: cache.ttsSettings,
          });
        } catch {
          // Skip invalid JSON files
        }
      }

      // Sort by createdAt (newest first)
      languages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return { success: true, languages };
    } catch (err) {
      return { success: false, languages: [], error: (err as Error).message };
    }
  });

  // Get sentences for a specific language
  ipcMain.handle('sentence-cache:get', async (_event, audiobookFolder: string, language: string) => {
    try {
      const filePath = path.join(audiobookFolder, 'sentences', `${language}.json`);

      if (!fsSync.existsSync(filePath)) {
        return { success: false, error: `No cache found for language: ${language}` };
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const cache = JSON.parse(content);

      return { success: true, cache };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Save sentences for a language
  ipcMain.handle('sentence-cache:save', async (_event, audiobookFolder: string, language: string, data: {
    language: string;
    sourceLanguage: string | null;
    sentences: string[] | Array<{ source: string; target: string }>;
  }) => {
    try {
      const sentencesDir = path.join(audiobookFolder, 'sentences');

      // Ensure directory exists
      if (!fsSync.existsSync(sentencesDir)) {
        await fs.mkdir(sentencesDir, { recursive: true });
      }

      const filePath = path.join(sentencesDir, `${language}.json`);

      // Build cache object
      const cache = {
        language: data.language,
        sourceLanguage: data.sourceLanguage,
        createdAt: new Date().toISOString(),
        sentenceCount: data.sentences.length,
        sentences: data.sentences,
      };

      await fs.writeFile(filePath, JSON.stringify(cache, null, 2));

      console.log(`[SENTENCE-CACHE] Saved ${cache.sentenceCount} sentences for ${language} to ${filePath}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Clear cache for specific languages or all
  ipcMain.handle('sentence-cache:clear', async (_event, audiobookFolder: string, languages?: string[]) => {
    try {
      const sentencesDir = path.join(audiobookFolder, 'sentences');
      const cleared: string[] = [];

      if (!fsSync.existsSync(sentencesDir)) {
        return { success: true, cleared };
      }

      if (languages && languages.length > 0) {
        // Clear specific languages
        for (const lang of languages) {
          const filePath = path.join(sentencesDir, `${lang}.json`);
          if (fsSync.existsSync(filePath)) {
            await fs.unlink(filePath);
            cleared.push(lang);
          }
        }
      } else {
        // Clear all
        const files = await fs.readdir(sentencesDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            await fs.unlink(path.join(sentencesDir, file));
            cleared.push(file.replace('.json', ''));
          }
        }
      }

      console.log(`[SENTENCE-CACHE] Cleared cache for: ${cleared.join(', ')}`);
      return { success: true, cleared };
    } catch (err) {
      return { success: false, cleared: [], error: (err as Error).message };
    }
  });

  // Run TTS on a cached language's EPUB and cache the audio
  ipcMain.handle('sentence-cache:run-tts', async (_event, config: {
    audiobookFolder: string;
    language: string;
    ttsConfig: {
      engine: 'xtts' | 'orpheus';
      voice: string;
      speed: number;
      device: 'cpu' | 'mps' | 'gpu';
      workers: number;
    };
  }) => {
    const { audiobookFolder, language, ttsConfig } = config;
    console.log(`[SENTENCE-CACHE] Running TTS for ${language}`, { audiobookFolder, ttsConfig });

    try {
      // Check if the EPUB exists
      const epubPath = path.join(audiobookFolder, `${language}.epub`);
      if (!fsSync.existsSync(epubPath)) {
        return { success: false, error: `EPUB not found: ${epubPath}` };
      }

      // Generate a job ID
      const jobId = `cache-tts-${language}-${Date.now()}`;

      // Import parallel TTS bridge
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      parallelTtsBridge.setMainWindow(mainWindow);
      await parallelTtsBridge.initializeLogger(getLibraryRoot());

      // Map engine to ttsEngine name
      const ttsEngine = ttsConfig.engine === 'orpheus' ? 'orpheus' : 'xtts';

      // Build conversion config
      const conversionConfig = {
        workerCount: ttsConfig.workers,
        epubPath,
        outputDir: path.join(audiobookFolder, 'audiobook'),  // Temp, won't be used with skipAssembly
        settings: {
          device: ttsConfig.device,
          language: language,
          ttsEngine,
          fineTuned: ttsConfig.voice,
          temperature: 0.75,
          topP: 0.85,
          topK: 50,
          repetitionPenalty: 5.0,
          speed: ttsConfig.speed,
          enableTextSplitting: false,
          sentencePerParagraph: true,  // Important for chaptered EPUBs
          skipHeadings: true,
        },
        parallelMode: 'sentences' as const,
        skipAssembly: true,  // Get sentence audio, not final M4B
        cleanSession: true,  // Start fresh for cached language TTS
        metadata: {
          title: `${path.basename(audiobookFolder)} (${language})`,
        },
      };

      // Start conversion - this runs in the background
      const result = await parallelTtsBridge.startParallelConversion(jobId, conversionConfig);

      if (!result.success) {
        return { success: false, error: result.error || 'Failed to start TTS conversion' };
      }

      // Return immediately - the TTS runs in background
      // Frontend will listen for parallel-tts:complete events
      return {
        success: true,
        jobId,
        message: `TTS started for ${language}`,
        // The sentencesDir will be in the completion event outputPath
      };
    } catch (err) {
      console.error('[SENTENCE-CACHE] TTS error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Update sentence cache after TTS completes - copies audio to cache and updates JSON
  ipcMain.handle('sentence-cache:cache-audio', async (_event, config: {
    audiobookFolder: string;
    language: string;
    sentencesDir: string;  // Source directory from TTS job
    ttsSettings: {
      engine: 'xtts' | 'orpheus';
      voice: string;
      speed: number;
    };
  }) => {
    const { audiobookFolder, language, sentencesDir, ttsSettings } = config;
    console.log(`[SENTENCE-CACHE] Caching audio for ${language}`, { audiobookFolder, sentencesDir });

    try {
      // Create audio cache directory
      const audioDir = path.join(audiobookFolder, 'audio', language);
      await fs.mkdir(audioDir, { recursive: true });

      // Copy all .flac files from sentencesDir to audioDir
      const files = await fs.readdir(sentencesDir);
      const audioFiles = files.filter(f => f.endsWith('.flac'));

      for (const file of audioFiles) {
        const src = path.join(sentencesDir, file);
        const dst = path.join(audioDir, file);
        await fs.copyFile(src, dst);
      }

      console.log(`[SENTENCE-CACHE] Copied ${audioFiles.length} audio files to ${audioDir}`);

      // Update the sentence cache JSON
      const cacheFile = path.join(audiobookFolder, 'sentences', `${language}.json`);
      if (fsSync.existsSync(cacheFile)) {
        const cacheContent = await fs.readFile(cacheFile, 'utf-8');
        const cache = JSON.parse(cacheContent);
        cache.hasAudio = true;
        cache.audioDir = audioDir;
        cache.ttsSettings = ttsSettings;
        await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
        console.log(`[SENTENCE-CACHE] Updated cache JSON with hasAudio=true`);
      }

      return { success: true, audioDir, fileCount: audioFiles.length };
    } catch (err) {
      console.error('[SENTENCE-CACHE] Cache audio error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Run bilingual assembly from cached audio
  ipcMain.handle('sentence-cache:run-assembly', async (_event, config: {
    audiobookFolder: string;
    languages: string[];  // e.g., ['en', 'de'] - first is source, second is target
    pattern: 'interleaved' | 'sequential';
    pauseBetweenLanguages: number;  // milliseconds
    outputFormat: 'm4b' | 'mp3';
  }) => {
    const { audiobookFolder, languages, pattern, pauseBetweenLanguages, outputFormat } = config;
    console.log(`[SENTENCE-CACHE] Running assembly`, { audiobookFolder, languages, pattern });

    if (languages.length < 2) {
      return { success: false, error: 'Need at least 2 languages for assembly' };
    }

    try {
      // Verify all languages have cached audio
      for (const lang of languages) {
        const audioDir = path.join(audiobookFolder, 'audio', lang);
        if (!fsSync.existsSync(audioDir)) {
          return { success: false, error: `No cached audio for language: ${lang}` };
        }
      }

      // For now, use the bilingual assembly with first two languages
      // TODO: Support multi-language assembly patterns
      const [sourceLang, targetLang] = languages;
      const sourceAudioDir = path.join(audiobookFolder, 'audio', sourceLang);
      const targetAudioDir = path.join(audiobookFolder, 'audio', targetLang);
      const sentencePairsPath = path.join(audiobookFolder, 'sentence_pairs.json');

      // Generate job ID
      const jobId = `cache-assembly-${Date.now()}`;

      // Import bilingual assembly bridge
      const { runBilingualAssembly } = await import('./bilingual-assembly-bridge.js');

      // Run assembly
      const result = await runBilingualAssembly(jobId, {
        projectId: path.basename(audiobookFolder),
        sourceSentencesDir: sourceAudioDir,
        targetSentencesDir: targetAudioDir,
        sentencePairsPath,
        outputDir: path.join(audiobookFolder, 'audiobook'),
        pauseDuration: pauseBetweenLanguages / 1000,  // Convert ms to seconds
        gapDuration: pattern === 'interleaved' ? 1.0 : 0.5,
        sourceLang,
        targetLang,
        bfpPath: audiobookFolder,  // For saving output to BFP audiobook folder
      });

      return {
        success: result.success,
        audioPath: result.audioPath,
        vttPath: result.vttPath,
        error: result.error,
      };
    } catch (err) {
      console.error('[SENTENCE-CACHE] Assembly error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Manifest Service IPC Handlers (Unified Project Management)
  // ─────────────────────────────────────────────────────────────────────────────

  // Create a new project
  ipcMain.handle('manifest:create', async (_event, projectType: 'book' | 'article', source: any, metadata: any) => {
    console.log('[manifest:create] Creating project:', projectType);
    return manifestService.createProject(projectType, source, metadata);
  });

  // Get a project manifest
  ipcMain.handle('manifest:get', async (_event, projectId: string) => {
    return manifestService.getManifest(projectId);
  });

  // Save (update) a manifest
  ipcMain.handle('manifest:save', async (_event, manifest: any) => {
    return manifestService.saveManifest(manifest);
  });

  // Update specific fields in a manifest
  ipcMain.handle('manifest:update', async (_event, update: any) => {
    return manifestService.updateManifest(update);
  });

  // List all projects
  ipcMain.handle('manifest:list', async (_event, filter?: { type?: 'book' | 'article' }) => {
    return manifestService.listProjects(filter);
  });

  // List project summaries (lightweight)
  ipcMain.handle('manifest:list-summaries', async (_event, filter?: { type?: 'book' | 'article' }) => {
    return manifestService.listProjectSummaries(filter);
  });

  // Delete a project
  ipcMain.handle('manifest:delete', async (_event, projectId: string) => {
    return manifestService.deleteProject(projectId);
  });

  // Import a source file into a project
  ipcMain.handle('manifest:import-source', async (_event, projectId: string, sourcePath: string, targetFilename?: string) => {
    return manifestService.importSourceFile(projectId, sourcePath, targetFilename);
  });

  // Resolve a relative manifest path to absolute OS path
  ipcMain.handle('manifest:resolve-path', async (_event, projectId: string, relativePath: string) => {
    return { path: manifestService.resolveManifestPath(projectId, relativePath) };
  });

  // Get project folder path
  ipcMain.handle('manifest:get-project-path', async (_event, projectId: string) => {
    return { path: manifestService.getProjectPath(projectId) };
  });

  // Check if project exists
  ipcMain.handle('manifest:exists', async (_event, projectId: string) => {
    return { exists: manifestService.projectExists(projectId) };
  });

  ipcMain.handle('manifest:get-all-tags', async () => {
    const result = await manifestService.listProjects();
    if (!result.success || !result.projects) return [];
    const tagSet = new Set<string>();
    for (const p of result.projects) {
      if (p.metadata?.tags) {
        for (const t of p.metadata.tags) tagSet.add(t);
      }
    }
    return [...tagSet].sort();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Pipeline Stage Deletion Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Delete AI cleanup/simplify outputs from stages/01-cleanup/
  ipcMain.handle('pipeline:delete-cleanup', async (_event, projectPath: string) => {
    try {
      const cleanupDir = path.join(projectPath, 'stages', '01-cleanup');

      if (!fsSync.existsSync(cleanupDir)) {
        return { success: true, message: 'No cleanup stage found' };
      }

      // Only delete cleanup-specific files (cleaned.*), not simplified.*
      const cleanupFiles = ['cleaned.epub', 'cleaned.diff.json', 'skipped-chunks.json', 'cleanup-progress.json'];
      const files = await fs.readdir(cleanupDir);
      const deletedFiles: string[] = [];

      for (const file of files) {
        // Delete cleanup-progress.json only if no simplified.epub exists (shared checkpoint)
        if (file === 'cleanup-progress.json') {
          const hasSimplified = files.includes('simplified.epub');
          if (hasSimplified) continue; // Checkpoint might belong to simplify, leave it
        }
        if (cleanupFiles.includes(file)) {
          await fs.unlink(path.join(cleanupDir, file));
          deletedFiles.push(file);
        }
      }

      // Try to remove the directory if empty
      try {
        await fs.rmdir(cleanupDir);
        console.log('[PIPELINE] Removed empty cleanup directory');
      } catch {
        // Directory not empty, that's fine
      }

      console.log('[PIPELINE] Deleted cleanup stage:', deletedFiles);
      return { success: true, deletedFiles, message: `Deleted ${deletedFiles.length} files from cleanup stage` };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete cleanup stage:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete AI Simplify outputs from stages/01-cleanup/ (simplified.* only, preserves cleaned.*)
  ipcMain.handle('pipeline:delete-simplify', async (_event, projectPath: string) => {
    try {
      const cleanupDir = path.join(projectPath, 'stages', '01-cleanup');

      if (!fsSync.existsSync(cleanupDir)) {
        return { success: true, message: 'No simplify stage found' };
      }

      // Only delete simplify-specific files
      const simplifyFiles = ['simplified.epub', 'simplified.diff.json', 'cleanup-progress.json'];
      const files = await fs.readdir(cleanupDir);
      const deletedFiles: string[] = [];

      for (const file of files) {
        if (simplifyFiles.includes(file)) {
          await fs.unlink(path.join(cleanupDir, file));
          deletedFiles.push(file);
        }
      }

      // Try to remove the directory if empty
      try {
        await fs.rmdir(cleanupDir);
        console.log('[PIPELINE] Removed empty cleanup directory');
      } catch {
        // Directory not empty, that's fine
      }

      console.log('[PIPELINE] Deleted simplify stage:', deletedFiles);
      return { success: true, deletedFiles, message: `Deleted ${deletedFiles.length} files from simplify stage` };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete simplify stage:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete translation outputs from stages/02-translate/
  ipcMain.handle('pipeline:delete-translation', async (_event, projectPath: string) => {
    try {
      const translateDir = path.join(projectPath, 'stages', '02-translate');

      if (!fsSync.existsSync(translateDir)) {
        return { success: true, message: 'No translation stage found' };
      }

      // List files and subdirectories that will be deleted
      const files = await fs.readdir(translateDir);
      const deletedItems: string[] = [];

      for (const item of files) {
        const itemPath = path.join(translateDir, item);
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
          // Delete subdirectories like 'sentences'
          await fs.rm(itemPath, { recursive: true, force: true });
          deletedItems.push(`${item}/`);
        } else {
          // Delete files (.epub, .json)
          await fs.unlink(itemPath);
          deletedItems.push(item);
        }
      }

      // Remove the directory itself
      await fs.rmdir(translateDir);

      console.log('[PIPELINE] Deleted translation stage:', deletedItems);
      return { success: true, deletedItems, message: `Deleted ${deletedItems.length} items from translation stage` };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete translation stage:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete TTS caches from stages/03-tts/sessions/
  ipcMain.handle('pipeline:delete-tts-cache', async (_event, projectPath: string, language?: string) => {
    try {
      const sessionsDir = path.join(projectPath, 'stages', '03-tts', 'sessions');

      if (!fsSync.existsSync(sessionsDir)) {
        return { success: true, message: 'No TTS sessions found' };
      }

      let deletedSessions: string[] = [];

      if (language) {
        // Delete specific language session
        const langDir = path.join(sessionsDir, language);
        if (fsSync.existsSync(langDir)) {
          await fs.rm(langDir, { recursive: true, force: true });
          deletedSessions.push(language);
        }
      } else {
        // Delete all language sessions
        const langs = await fs.readdir(sessionsDir);
        for (const lang of langs) {
          const langPath = path.join(sessionsDir, lang);
          const stats = await fs.stat(langPath);
          if (stats.isDirectory()) {
            await fs.rm(langPath, { recursive: true, force: true });
            deletedSessions.push(lang);
          }
        }
      }

      // Try to clean up empty parent directories
      try {
        await fs.rmdir(sessionsDir);
        await fs.rmdir(path.join(projectPath, 'stages', '03-tts'));
      } catch {
        // Directories not empty or don't exist, that's fine
      }

      console.log('[PIPELINE] Deleted TTS sessions:', deletedSessions);
      return {
        success: true,
        deletedSessions,
        message: language
          ? `Deleted TTS session for ${language}`
          : `Deleted ${deletedSessions.length} TTS sessions`
      };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete TTS cache:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete output files (audiobook.m4b, audiobook.vtt, bilingual outputs)
  ipcMain.handle('pipeline:delete-output', async (_event, projectPath: string) => {
    try {
      const outputDir = path.join(projectPath, 'output');

      if (!fsSync.existsSync(outputDir)) {
        return { success: true, message: 'No output directory found' };
      }

      const files = await fs.readdir(outputDir);
      const deletedFiles: string[] = [];

      for (const file of files) {
        const filePath = path.join(outputDir, file);
        await fs.rm(filePath, { recursive: true, force: true });
        deletedFiles.push(file);
      }

      // Remove the directory itself
      try {
        await fs.rmdir(outputDir);
      } catch {
        // Directory not empty, that's fine
      }

      console.log('[PIPELINE] Deleted output files:', deletedFiles);
      return { success: true, deletedFiles, message: `Deleted ${deletedFiles.length} output files` };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete output:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete all pipeline stages (cleanup + translation + TTS)
  ipcMain.handle('pipeline:delete-all', async (_event, projectPath: string) => {
    try {
      const results = {
        cleanup: { success: false, message: '' },
        translation: { success: false, message: '' },
        tts: { success: false, message: '' }
      };

      // Delete cleanup stage
      try {
        const cleanupDir = path.join(projectPath, 'stages', '01-cleanup');
        if (fsSync.existsSync(cleanupDir)) {
          const files = await fs.readdir(cleanupDir);
          const deletedFiles: string[] = [];
          for (const file of files) {
            const filePath = path.join(cleanupDir, file);
            if (file.endsWith('.epub') || file.endsWith('.diff.json') || file === 'skipped-chunks.json') {
              await fs.unlink(filePath);
              deletedFiles.push(file);
            }
          }
          try {
            await fs.rmdir(cleanupDir);
          } catch {
            // Directory not empty, that's fine
          }
          results.cleanup = { success: true, message: `Deleted ${deletedFiles.length} files from cleanup stage` };
        } else {
          results.cleanup = { success: true, message: 'No cleanup stage found' };
        }
      } catch (err) {
        results.cleanup = { success: false, message: (err as Error).message };
      }

      // Delete translation stage
      try {
        const translateDir = path.join(projectPath, 'stages', '02-translate');
        if (fsSync.existsSync(translateDir)) {
          const files = await fs.readdir(translateDir);
          const deletedItems: string[] = [];
          for (const item of files) {
            const itemPath = path.join(translateDir, item);
            const stats = await fs.stat(itemPath);
            if (stats.isDirectory()) {
              await fs.rm(itemPath, { recursive: true, force: true });
              deletedItems.push(`${item}/`);
            } else {
              await fs.unlink(itemPath);
              deletedItems.push(item);
            }
          }
          await fs.rmdir(translateDir);
          results.translation = { success: true, message: `Deleted ${deletedItems.length} items from translation stage` };
        } else {
          results.translation = { success: true, message: 'No translation stage found' };
        }
      } catch (err) {
        results.translation = { success: false, message: (err as Error).message };
      }

      // Delete TTS cache
      try {
        const sessionsDir = path.join(projectPath, 'stages', '03-tts', 'sessions');
        if (fsSync.existsSync(sessionsDir)) {
          const langs = await fs.readdir(sessionsDir);
          const deletedSessions: string[] = [];
          for (const lang of langs) {
            const langPath = path.join(sessionsDir, lang);
            const stats = await fs.stat(langPath);
            if (stats.isDirectory()) {
              await fs.rm(langPath, { recursive: true, force: true });
              deletedSessions.push(lang);
            }
          }
          try {
            await fs.rmdir(sessionsDir);
            await fs.rmdir(path.join(projectPath, 'stages', '03-tts'));
          } catch {
            // Directories not empty or don't exist, that's fine
          }
          results.tts = { success: true, message: `Deleted ${deletedSessions.length} TTS sessions` };
        } else {
          results.tts = { success: true, message: 'No TTS sessions found' };
        }
      } catch (err) {
        results.tts = { success: false, message: (err as Error).message };
      }

      // Try to remove the entire stages directory if empty
      try {
        const stagesDir = path.join(projectPath, 'stages');
        if (fsSync.existsSync(stagesDir)) {
          await fs.rmdir(stagesDir);
          console.log('[PIPELINE] Removed empty stages directory');
        }
      } catch {
        // Directory not empty, that's fine
      }

      const allSuccess = results.cleanup.success && results.translation.success && results.tts.success;
      console.log('[PIPELINE] Deleted all pipeline stages:', results);

      return {
        success: allSuccess,
        results,
        message: 'Deleted all pipeline stages'
      };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete all stages:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Reset editor state (chapters, deletions, OCR blocks, etc.) in the manifest
  ipcMain.handle('pipeline:reset-editor-state', async (_event, projectPath: string) => {
    try {
      const manifestPath = path.join(projectPath, 'manifest.json');
      if (!fsSync.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found' };
      }

      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      // Clear editor state fields
      delete manifest.source?.deletedBlockIds;
      delete manifest.source?.deletedHighlightIds;
      delete manifest.source?.pageOrder;
      delete manifest.source?.deletedPages;
      delete manifest.source?.removeBackgrounds;
      if (manifest.source && Object.keys(manifest.source).length === 0) {
        delete manifest.source;
      }

      delete manifest.editor;
      delete manifest.chapters;
      delete manifest.chaptersSource;

      manifest.modifiedAt = new Date().toISOString();

      await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));

      // Delete derived files from source/ directory
      const sourceDir = path.join(projectPath, 'source');
      const filesToDelete = [
        'exported.epub', '._exported.epub',
        'load-trace.log', 'save-diagnostics.json',
        'export-diagnostics.json', 'deleted-examples.json'
      ];
      for (const file of filesToDelete) {
        const fp = path.join(sourceDir, file);
        try { await fs.unlink(fp); } catch { /* doesn't exist */ }
      }

      console.log(`[PIPELINE] Reset editor state for ${projectPath}`);

      return { success: true, message: 'Editor state reset' };
    } catch (err) {
      console.error('[PIPELINE] Failed to reset editor state:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Migration IPC Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Scan for legacy projects that need migration
  ipcMain.handle('manifest:scan-legacy', async () => {
    const result = await manifestMigration.scanLegacyProjects();
    return {
      success: true,
      bfpCount: result.bfpFiles.length,
      audiobookCount: result.audiobookFolders.length,
      articleCount: result.articleFolders.length,
      total: result.bfpFiles.length + result.audiobookFolders.length + result.articleFolders.length,
    };
  });

  // Check if migration is needed
  ipcMain.handle('manifest:needs-migration', async () => {
    const needsMigration = await manifestMigration.needsMigration();
    return { needsMigration };
  });

  // Migrate all legacy projects
  ipcMain.handle('manifest:migrate-all', async (_event) => {
    return manifestMigration.migrateAllProjects((progress) => {
      // Send progress updates to renderer
      mainWindow?.webContents.send('manifest:migration-progress', progress);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Editor Window - Opens PDF picker in a new window for editing a project
  // ─────────────────────────────────────────────────────────────────────────────

  // Track open editor windows by project path
  const editorWindows = new Map<string, BrowserWindow>();

  // ── Listen window (Play / Stream player) ──
  // The XTTS stream engine's lifetime is tied to these windows: when the last
  // listen window closes, the engine is shut down. That guarantees the engine
  // is only ever running while a player window is open.
  const listenWindows = new Map<string, BrowserWindow>();

  // Everything listenable for a project, scanned from the canonical locations.
  // M4Bs play directly; EPUBs stream via live TTS. The renderer derives the
  // player from what the user picks, so there is no separate play/stream mode.
  ipcMain.handle('listen:list-sources', async (_event, projectPath: string) => {
    const statMtime = async (p: string): Promise<number | null> => {
      try {
        return (await fs.stat(p)).mtimeMs;
      } catch {
        return null;
      }
    };

    const epubs: Array<{ kind: string; lang?: string; path: string; mtimeMs: number }> = [];
    const addEpub = async (kind: string, relPath: string, lang?: string) => {
      const abs = path.join(projectPath, relPath);
      const mtimeMs = await statMtime(abs);
      if (mtimeMs !== null) epubs.push({ kind, lang, path: abs, mtimeMs });
    };

    await addEpub('translated', path.join('stages', '02-translate', 'translated.epub'));
    // LL pipeline: per-language EPUBs (de.epub, ko.epub, ...)
    try {
      const translateDir = path.join(projectPath, 'stages', '02-translate');
      for (const name of await fs.readdir(translateDir)) {
        const m = name.match(/^([a-z]{2,3})\.epub$/);
        if (m) await addEpub('translated', path.join('stages', '02-translate', name), m[1]);
      }
    } catch { /* no translate stage */ }
    await addEpub('simplified', path.join('stages', '01-cleanup', 'simplified.epub'));
    await addEpub('cleaned', path.join('stages', '01-cleanup', 'cleaned.epub'));
    await addEpub('exported', path.join('source', 'exported.epub'));
    await addEpub('original', path.join('source', 'original.epub'));

    // M4B mtimes keyed by filename — the renderer pairs them with the manifest's
    // audio entries and flags audiobooks older than the newest EPUB as stale.
    const m4bs: Array<{ fileName: string; mtimeMs: number }> = [];
    try {
      const outputDir = path.join(projectPath, 'output');
      for (const name of await fs.readdir(outputDir)) {
        if (!name.endsWith('.m4b')) continue;
        const mtimeMs = await statMtime(path.join(outputDir, name));
        if (mtimeMs !== null) m4bs.push({ fileName: name, mtimeMs });
      }
    } catch { /* no output yet */ }

    return { success: true, epubs, m4bs };
  });

  ipcMain.handle('listen:open-window', async (_event, projectPath: string) => {
    const existing = listenWindows.get(projectPath);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return { success: true, alreadyOpen: true };
    }

    const iconPath = isDev
      ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
      : path.join(codeRoot, 'bookforge-icon.png');

    const listenWindow = new BrowserWindow({
      width: 1100,
      height: 850,
      minWidth: 600,
      minHeight: 500,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#0a0a0a',
    });

    listenWindows.set(projectPath, listenWindow);

    listenWindow.on('closed', () => {
      listenWindows.delete(projectPath);
      // Closing the player no longer shuts the engine down — the user asked it to
      // stay warm so reopening (or the browser extension) plays instantly without
      // a cold start. The engine is stopped explicitly via the TTS toggle in the
      // nav rail (or on app quit), not by closing a window.
    });

    listenWindow.webContents.on('did-finish-load', () => {
      listenWindow.webContents.setZoomLevel(loadZoomLevel());
    });

    const encodedPath = encodeURIComponent(projectPath);
    if (isDev) {
      listenWindow.loadURL(`http://localhost:4250/#/listen?project=${encodedPath}`);
    } else {
      const appPath = codeRoot;
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      listenWindow.loadFile(indexPath, {
        hash: `/listen?project=${encodedPath}`
      });
    }

    return { success: true };
  });

  ipcMain.handle('editor:open-window', async (_event, projectPath: string, options?: { mode?: string }) => {
    // Check if window already open for this project
    const existingWindow = editorWindows.get(projectPath);
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus();
      return { success: true, alreadyOpen: true };
    }

    // Get icon path
    const iconPath = isDev
      ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
      : path.join(codeRoot, 'bookforge-icon.png');

    // Create new editor window
    const editorWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 800,
      minHeight: 600,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#0a0a0a',
    });

    // Track the window
    editorWindows.set(projectPath, editorWindow);

    // Clean up when window closes
    editorWindow.on('closed', () => {
      editorWindows.delete(projectPath);
      // Notify main window that editor closed (for refresh)
      mainWindow?.webContents.send('editor:window-closed', projectPath);
    });

    // Apply saved zoom level
    editorWindow.webContents.on('did-finish-load', () => {
      editorWindow.webContents.setZoomLevel(loadZoomLevel());
    });

    // Load the editor route with project path as query param
    const encodedPath = encodeURIComponent(projectPath);
    const modeParam = options?.mode ? `&mode=${options.mode}` : '';
    if (isDev) {
      editorWindow.loadURL(`http://localhost:4250/#/editor?project=${encodedPath}${modeParam}`);
    } else {
      const appPath = codeRoot;
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      editorWindow.loadFile(indexPath, {
        hash: `/editor?project=${encodedPath}${modeParam}`
      });
    }

    return { success: true };
  });

  // Open editor window with BFP project and specific source version
  // This ensures project state (deletions, chapters) is preserved
  ipcMain.handle('editor:open-window-with-bfp', async (_event, bfpPath: string, sourcePath: string) => {
    // Use BFP path as the window key so we track by project, not by source file
    const existingWindow = editorWindows.get(bfpPath);
    if (existingWindow && !existingWindow.isDestroyed()) {
      // Navigate the existing window to the new source file
      const encodedBfp = encodeURIComponent(bfpPath);
      const encodedSource = encodeURIComponent(sourcePath);
      if (isDev) {
        existingWindow.loadURL(`http://localhost:4250/#/editor?project=${encodedBfp}&source=${encodedSource}`);
      } else {
        const appPath = codeRoot;
        const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
        existingWindow.loadFile(indexPath, {
          hash: `/editor?project=${encodedBfp}&source=${encodedSource}`
        });
      }
      existingWindow.focus();
      return { success: true, alreadyOpen: true };
    }

    // Get icon path
    const iconPath = isDev
      ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
      : path.join(codeRoot, 'bookforge-icon.png');

    // Create new editor window
    const editorWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 800,
      minHeight: 600,
      icon: iconPath,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#0a0a0a',
    });

    // Track the window by BFP path
    editorWindows.set(bfpPath, editorWindow);

    // Clean up when window closes
    editorWindow.on('closed', () => {
      editorWindows.delete(bfpPath);
      // Notify main window that editor closed (for refresh)
      mainWindow?.webContents.send('editor:window-closed', bfpPath);
    });

    // Apply saved zoom level
    editorWindow.webContents.on('did-finish-load', () => {
      editorWindow.webContents.setZoomLevel(loadZoomLevel());
    });

    // Load the editor route with both BFP path and source path as query params
    const encodedBfp = encodeURIComponent(bfpPath);
    const encodedSource = encodeURIComponent(sourcePath);
    if (isDev) {
      editorWindow.loadURL(`http://localhost:4250/#/editor?project=${encodedBfp}&source=${encodedSource}`);
    } else {
      const appPath = codeRoot;
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      editorWindow.loadFile(indexPath, {
        hash: `/editor?project=${encodedBfp}&source=${encodedSource}`
      });
    }

    return { success: true };
  });

  ipcMain.handle('editor:close-window', async (_event, projectPath: string) => {
    const window = editorWindows.get(projectPath);
    if (window && !window.isDestroyed()) {
      window.close();
    }
    return { success: true };
  });

  // Get available versions for a project
  // Accepts either a project directory path or a legacy .bfp file path
  ipcMain.handle('editor:get-versions', async (_event, projectPath: string) => {
    try {
      if (!projectPath || !fsSync.existsSync(projectPath)) {
        return { success: false, error: 'Project not found' };
      }

      const versions: Array<{
        id: string;
        type: string;
        label: string;
        description: string;
        path: string;
        extension: string;
        language?: string;
        modifiedAt?: string;
        fileSize?: number;
        editable: boolean;
        icon: string;
      }> = [];

      // Helper to resolve a path, trying cross-platform translation if needed
      const resolvePath = (p: string | undefined): string | undefined => {
        if (!p) return undefined;
        if (fsSync.existsSync(p)) return p;
        const translated = translateLibraryPath(p);
        if (translated && fsSync.existsSync(translated)) return translated;
        return undefined;
      };

      // Helper to add a version if the file exists
      const addVersion = async (
        id: string,
        type: string,
        label: string,
        description: string,
        filePath: string,
        icon: string,
        editable: boolean,
        language?: string
      ) => {
        const resolvedFilePath = resolvePath(filePath);
        if (resolvedFilePath) {
          const stats = await fs.stat(resolvedFilePath);
          const ext = path.extname(resolvedFilePath).toLowerCase().replace('.', '');
          versions.push({
            id,
            type,
            label,
            description,
            path: resolvedFilePath,
            extension: ext,
            language,
            modifiedAt: stats.mtime.toISOString(),
            fileSize: stats.size,
            editable: editable && (ext === 'epub' || ext === 'pdf'),
            icon
          });
        }
      };

      // Determine if this is a manifest project directory or a legacy .bfp file
      const isManifestProject = !projectPath.endsWith('.bfp') &&
        fsSync.statSync(projectPath).isDirectory() &&
        fsSync.existsSync(path.join(projectPath, 'manifest.json'));

      if (isManifestProject) {
        // ── Manifest-based project directory ──
        const projectDir = projectPath;

        // 1. Original source file
        const sourceDir = path.join(projectDir, 'source');
        if (fsSync.existsSync(sourceDir)) {
          const sourceFiles = await fs.readdir(sourceDir);
          for (const file of sourceFiles) {
            const ext = path.extname(file).toLowerCase();
            const baseName = path.basename(file, ext);
            if (baseName === 'original') {
              await addVersion(
                'original',
                'original',
                'Original Source',
                `The original ${ext.toUpperCase().replace('.', '')} file you imported`,
                path.join(sourceDir, file),
                ext === '.pdf' ? '📄' : '📘',
                true
              );
            } else if (baseName === 'exported') {
              await addVersion(
                'exported',
                'exported',
                'Exported EPUB',
                'The EPUB with your edits applied',
                path.join(sourceDir, file),
                '✅',
                true
              );
            }
          }
        }

        // 2. Cleaned/Simplified EPUB from stages/01-cleanup/
        const cleanupDir = path.join(projectDir, 'stages', '01-cleanup');
        if (fsSync.existsSync(cleanupDir)) {
          const simplifiedPath = path.join(cleanupDir, 'simplified.epub');
          const cleanedPath = path.join(cleanupDir, 'cleaned.epub');

          if (fsSync.existsSync(simplifiedPath)) {
            await addVersion(
              'simplified', 'simplified', 'Simplified EPUB',
              'AI-simplified for language learners',
              simplifiedPath, '📖', true
            );
          }
          if (fsSync.existsSync(cleanedPath)) {
            await addVersion(
              'cleaned', 'cleaned', 'Cleaned EPUB',
              'After AI cleanup - typos fixed, formatting improved',
              cleanedPath, '🧹', true
            );
          }
        }

        // 3. Translated EPUBs from stages/02-translate/
        const translateDir = path.join(projectDir, 'stages', '02-translate');
        if (fsSync.existsSync(translateDir)) {
          const translateFiles = await fs.readdir(translateDir);
          for (const file of translateFiles) {
            if (file === 'translated.epub') {
              // Standard pipeline whole-book translation
              await addVersion(
                'translated', 'translated', 'Translated EPUB',
                'Whole-book translation to another language',
                path.join(translateDir, file), '🌍', true
              );
            } else if (/^[a-z]{2}\.epub$/.test(file)) {
              // LL pipeline per-language translation
              const lang = file.replace('.epub', '');
              const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
              await addVersion(
                `translated-${lang}`, 'translated', `${langName} EPUB`,
                `${langName} language version for TTS`,
                path.join(translateDir, file), '🌍', true, lang
              );
            }
          }
        }

        // 4. Content Analysis results from stages/04-analysis/
        const analysisDir = path.join(projectDir, 'stages', '04-analysis');
        const analysisPath = path.join(analysisDir, 'analysis.json');
        const analysisCheckpointPath = path.join(analysisDir, 'analysis-progress.json');
        // Check for completed report first, fall back to in-progress checkpoint
        const activeAnalysisPath = fsSync.existsSync(analysisPath)
          ? analysisPath
          : fsSync.existsSync(analysisCheckpointPath) ? analysisCheckpointPath : null;

        if (activeAnalysisPath) {
          try {
            const analysisRaw = await fs.readFile(activeAnalysisPath, 'utf-8');
            const analysisData = JSON.parse(analysisRaw);
            const isCheckpoint = activeAnalysisPath === analysisCheckpointPath;
            const flagCount = isCheckpoint
              ? analysisData.flags?.length ?? 0
              : analysisData.statistics?.totalFlags ?? analysisData.flags?.length ?? 0;
            const completedChapters = isCheckpoint ? analysisData.completedChapters?.length ?? 0 : null;
            const totalChapters = isCheckpoint ? analysisData.totalChapters ?? 0 : null;

            // Resolve which EPUB was analyzed
            let analysisSourcePath = (isCheckpoint ? analysisData.sourceEpubPath : analysisData.epubPath) || '';
            // If stored path doesn't exist, fall back to best available EPUB
            if (!analysisSourcePath || !fsSync.existsSync(analysisSourcePath)) {
              const cleanedPath = path.join(projectDir, 'stages', '01-cleanup', 'cleaned.epub');
              const exportedPath = path.join(projectDir, 'source', 'exported.epub');
              const originalPath = path.join(projectDir, 'source', 'original.epub');
              if (fsSync.existsSync(cleanedPath)) analysisSourcePath = cleanedPath;
              else if (fsSync.existsSync(exportedPath)) analysisSourcePath = exportedPath;
              else if (fsSync.existsSync(originalPath)) analysisSourcePath = originalPath;
            }
            if (analysisSourcePath) {
              const stats = await fs.stat(activeAnalysisPath);
              const description = isCheckpoint
                ? `Content analysis (partial ${completedChapters}/${totalChapters} chapters): ${flagCount} flag${flagCount !== 1 ? 's' : ''} found`
                : `Content analysis: ${flagCount} flag${flagCount !== 1 ? 's' : ''} found`;
              versions.push({
                id: 'analysis',
                type: 'analysis',
                label: 'View Analysis',
                description,
                path: analysisSourcePath,
                extension: path.extname(analysisSourcePath).toLowerCase().replace('.', ''),
                modifiedAt: stats.mtime.toISOString(),
                fileSize: stats.size,
                editable: true,
                icon: '🔍'
              });
            }
          } catch (err) {
            console.warn('[editor:get-versions] Failed to read analysis data:', err);
          }
        }
      } else {
        // ── Legacy .bfp file path ──
        const bfpContent = await fs.readFile(projectPath, 'utf-8');
        const bfp = JSON.parse(bfpContent);
        const bfpDir = path.dirname(projectPath);

        // 1. Original source file
        const sourcePath = bfp.source_path || bfp.sourcePath;
        if (sourcePath) {
          const sourceExt = path.extname(sourcePath).toLowerCase();
          await addVersion(
            'original', 'original', 'Original Source',
            `The original ${sourceExt.toUpperCase().replace('.', '')} file you imported`,
            sourcePath, sourceExt === '.pdf' ? '📄' : '📘', true
          );
        }

        // 2. Exported EPUB
        const exportedPath = bfp.audiobook?.exportedEpubPath;
        if (exportedPath) {
          const rawExportedPath = path.isAbsolute(exportedPath)
            ? exportedPath
            : path.join(bfpDir, exportedPath);
          await addVersion(
            'exported', 'exported', 'Exported EPUB',
            'The exported EPUB with all your edits applied',
            rawExportedPath, '✅', true
          );
        }

        // 3. Cleaned/Simplified from audiobook folder
        const rawAudiobookFolder = bfp.audiobookFolder || bfp.audiobook?.folder;
        const audiobookFolder = resolvePath(rawAudiobookFolder);
        if (audiobookFolder) {
          const simplifiedPath = path.join(audiobookFolder, 'simplified.epub');
          const cleanedPath = path.join(audiobookFolder, 'cleaned.epub');

          if (fsSync.existsSync(simplifiedPath)) {
            await addVersion('simplified', 'simplified', 'Simplified EPUB',
              'AI-simplified for language learners', simplifiedPath, '📖', true);
          }
          if (fsSync.existsSync(cleanedPath)) {
            await addVersion('cleaned', 'cleaned', 'Cleaned EPUB',
              'After AI cleanup', cleanedPath, '🧹', true);
          }
        }
      }

      return { success: true, versions };
    } catch (err) {
      console.error('[EDITOR:GET-VERSIONS] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Save EPUB data directly to a file path
  // SAFETY: Only allows writes to files inside the library folder
  ipcMain.handle('editor:save-epub', async (_event, epubPath: string, epubData: ArrayBuffer) => {
    try {
      if (!epubPath) {
        return { success: false, error: 'No EPUB path provided' };
      }

      // SAFETY CHECK: Only allow writes inside the library folder
      const libraryRoot = getLibraryRoot();
      const normalizedEpubPath = path.normalize(epubPath);
      const normalizedLibraryRoot = path.normalize(libraryRoot);

      if (!normalizedEpubPath.startsWith(normalizedLibraryRoot + path.sep) &&
          normalizedEpubPath !== normalizedLibraryRoot) {
        console.error(`[EDITOR:SAVE-EPUB] BLOCKED: Attempted write outside library folder`);
        console.error(`[EDITOR:SAVE-EPUB]   epubPath: ${epubPath}`);
        console.error(`[EDITOR:SAVE-EPUB]   libraryRoot: ${libraryRoot}`);
        return {
          success: false,
          error: `Cannot write to files outside the library folder. Attempted path: ${epubPath}`
        };
      }

      // Ensure the directory exists
      const epubDir = path.dirname(epubPath);
      await fs.mkdir(epubDir, { recursive: true });

      // Write the EPUB data to the file
      const buffer = Buffer.from(epubData);
      await fs.writeFile(epubPath, buffer);

      // Merge fragmented paragraphs (line-level PDF blocks → sentence-aligned paragraphs)
      await mergeEpubParagraphs(epubPath);

      console.log(`[EDITOR:SAVE-EPUB] Saved EPUB to ${epubPath} (${buffer.length} bytes)`);

      // Notify main window that project files changed
      // Derive project dir from the epub path (look for projects/{slug}/ pattern)
      const projectsDir = path.join(libraryRoot, 'projects');
      if (normalizedEpubPath.startsWith(path.normalize(projectsDir) + path.sep)) {
        const relPath = path.relative(projectsDir, normalizedEpubPath);
        const projectSlug = relPath.split(path.sep)[0];
        const projectDir = path.join(projectsDir, projectSlug);
        mainWindow?.webContents.send('project:files-changed', projectDir);
      }

      return { success: true };
    } catch (err) {
      console.error('[EDITOR:SAVE-EPUB] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Save EPUB to a user-chosen location via Save As dialog
  // No library restriction — intended for exporting EPUBs for external use
  ipcMain.handle('epub:save-as-dialog', async (_event, epubData: ArrayBuffer, defaultName?: string) => {
    try {
      if (!mainWindow) return { success: false, error: 'No window' };

      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save EPUB As',
        defaultPath: defaultName || 'book.epub',
        filters: [{ name: 'EPUB', extensions: ['epub'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const buffer = Buffer.from(epubData);
      await fs.writeFile(result.filePath, buffer);
      console.log(`[EPUB:SAVE-AS] Saved EPUB to ${result.filePath} (${buffer.length} bytes)`);

      return { success: true, filePath: result.filePath };
    } catch (err) {
      console.error('[EPUB:SAVE-AS] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });
}

// Register custom protocols as privileged (must be done before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bookforge-page',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'bookforge-audio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true  // Enable streaming for audio
    }
  }
]);

// Single-instance lock: a second launch must NOT run while the first is doing
// the first-run runtime unpack — two processes extracting/copying into the same
// userData/runtime dir is a prime cause of a corrupted install. The second
// instance just focuses the existing window and exits.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (isPrimaryInstance) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!isPrimaryInstance) {
    app.quit();
    return;
  }
  // Initialize rolling logger
  await initializeLoggers();
  const logger = getMainLogger();
  logger.info('BookForge starting', { version: app.getVersion(), platform: process.platform });

  // Load the downloadable-component catalog (voices + language packs): seed from
  // the embedded bundle, load any cached catalog, and kick off a background
  // refresh from the catalog server. Non-blocking — never delays the window.
  try {
    const { catalogService } = await import('./components/catalog-service.js');
    await catalogService.init();
  } catch (err) {
    logger.warn('Catalog init failed', { error: (err as Error).message });
  }

  // Clean up stale temp folders from previous sessions (Syncthing compatibility)
  try {
    const { cleanupStaleTempFolders } = await import('./parallel-tts-bridge.js');
    await cleanupStaleTempFolders(24); // Clean folders older than 24 hours
    logger.info('Cleaned up stale TTS temp folders');
  } catch (err) {
    logger.warn('Failed to cleanup stale temp folders', { error: (err as Error).message });
  }

  // Clean up stale manifest staging files (Syncthing atomic write compatibility)
  try {
    await manifestService.cleanupStagingDir(24 * 60 * 60 * 1000); // 24 hours
    logger.info('Cleaned up stale manifest staging files');
  } catch (err) {
    logger.warn('Failed to cleanup manifest staging dir', { error: (err as Error).message });
  }

  // Evict page render caches for documents not opened in 30 days, and sweep
  // stale e2a TTS sessions (e2a never garbage-collects in headless mode, so
  // failed/cancelled sessions accumulate forever). Delayed so the sweeps' disk
  // I/O doesn't compete with app launch, which also guarantees this runs after
  // applyE2aScratchDir() below has resolved the active scratch dir.
  setTimeout(() => {
    void (async () => {
      try {
        const { evictStaleRenderCache } = await import('./render-cache.js');
        const { evicted, freedBytes } = await evictStaleRenderCache();
        if (evicted > 0) {
          logger.info('Evicted stale render caches', {
            documents: evicted,
            freedMB: Math.round(freedBytes / 1024 / 1024),
          });
        }
      } catch (err) {
        logger.warn('Render cache eviction failed', { error: (err as Error).message });
      }

      // Sweep ebook-* session folders in the active scratch dir older than 30
      // days. Matches the render-cache policy and safely exceeds the user's
      // 1-2 week book lifecycle (older sessions aren't resumable in practice).
      try {
        const tmpDir = getDefaultE2aTmpPath();
        const STALE_MS = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let entries: import('fs').Dirent[] = [];
        try {
          entries = await fs.readdir(tmpDir, { withFileTypes: true });
        } catch {
          entries = []; // tmp dir may not exist yet — nothing to sweep
        }

        const dirSize = async (dir: string): Promise<number> => {
          let total = 0;
          let kids: import('fs').Dirent[];
          try {
            kids = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return 0;
          }
          for (const kid of kids) {
            const full = path.join(dir, kid.name);
            try {
              if (kid.isDirectory()) {
                total += await dirSize(full);
              } else {
                total += (await fs.stat(full)).size;
              }
            } catch { /* file vanished mid-walk */ }
          }
          return total;
        };

        let removed = 0;
        let freedBytes = 0;
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith('ebook-')) continue;
          const full = path.join(tmpDir, entry.name);
          try {
            const stat = await fs.stat(full);
            if (now - stat.mtimeMs < STALE_MS) continue;
            freedBytes += await dirSize(full);
            await fs.rm(full, { recursive: true, force: true });
            removed++;
          } catch (err) {
            logger.warn('Failed to sweep stale TTS session', { dir: full, error: (err as Error).message });
          }
        }
        if (removed > 0) {
          logger.info('Swept stale TTS sessions', {
            sessions: removed,
            freedMB: Math.round(freedBytes / 1024 / 1024),
            scratchDir: tmpDir,
          });
        }
      } catch (err) {
        logger.warn('Stale TTS session sweep failed', { error: (err as Error).message });
      }
    })();
  }, 15_000);

  // Register the protocol handlers
  registerPageProtocol();
  registerAudioProtocol();

  setupIpcHandlers();
  setupAlignmentIpc();
  createWindow();
  if (mainWindow) {
    pdfWorkerProxy.setDefaultSender(mainWindow.webContents);
  }

  // First-run unpack of the bundled Python env + e2a snapshot (packaged builds
  // only — dev ships no tarball/snapshot and the ensure* calls return at once).
  // Runs in the background so the window isn't blocked; readiness is broadcast
  // so the renderer can show a "Setting up…" overlay and gate job submission
  // until the runtime is actually usable. The TTS API server start is folded in
  // here so external clients (browser extension) never hit a half-ready runtime.
  void (async () => {
    const { bundledRuntimeReady } = await import('./e2a-env-bootstrap.js');

    // bundledRuntimeReady() validates EVERY mandatory piece (Python env + e2a code
    // snapshot + default voice + English language pack) against its ready-marker,
    // so a half-installed or version-stale runtime STILL counts as needing setup.
    // runtimeWasFresh drives the renderer's guided first-run Setup page. False in
    // dev (nothing ships/downloads) and on a normal up-to-date launch.
    const runtimeReady = bundledRuntimeReady();
    runtimeWasFresh = !runtimeReady;

    if (runtimeReady) {
      // Already fully installed (returning launch) → ready immediately; still bring
      // up the TTS API server (startRuntimeSetup's ensure* calls are no-ops here).
      setRuntimeStatus({ state: 'ready', message: 'Ready' });
      void startRuntimeSetup();
      return;
    }

    // Not fully set up. Only begin downloading once the user has chosen a library
    // location, so they can quit before any large download starts. If a library is
    // already persisted (returning user mid-setup, or an env/asset version bump),
    // run the update now; otherwise the library:set-root handler kicks it off.
    if (loadPersistedLibraryRoot()) {
      void startRuntimeSetup();
    } else {
      setRuntimeStatus({
        state: 'preparing',
        message: 'Choose your library location to finish setting up BookForge.',
      });
    }
  })();

  // Initialize plugin system
  const registry = getPluginRegistry();
  if (mainWindow) {
    registry.setMainWindow(mainWindow);
  }
  await loadBuiltinPlugins(registry);

  // Restore persisted library root before auto-starting the bookshelf server.
  // The renderer sets this via IPC, but that happens after the window loads —
  // too late for auto-start. So we persist it to userData and read it here.
  const persistedRoot = loadPersistedLibraryRoot();
  if (persistedRoot && !customLibraryRoot) {
    customLibraryRoot = persistedRoot;
    manifestService.setLibraryBasePath(persistedRoot);
    console.log('[Startup] Restored persisted library root:', persistedRoot);
  }
  applyE2aScratchDir();
  // Religiously clear the e2a tmp dir on every startup — nothing is converting
  // yet, so any leftovers are from prior/failed/interrupted runs.
  void cleanE2aTmpDir();

  // Auto-start bookshelf server if configured
  await autoStartBookshelf();

  // Bridge bookshelf server queue control to renderer process
  bookshelfServer.setQueueControlHandler((action) => {
    mainWindow?.webContents.send('queue:remote-control', action);
  });

  // NOTE: the TTS API server is started by startRuntimeSetup() (the first-run
  // "update"), gated behind the library-location step so external clients never
  // hit a half-ready runtime.

  // ─────────────────────────────────────────────────────────────────────────────
  // Window management: Cmd+W hides, Cmd+Q double-press to quit
  // ─────────────────────────────────────────────────────────────────────────────

  // Cmd+W: hide the main window instead of closing
  mainWindow!.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Cmd+Q: Chrome-style double-press to quit
  let quitWarningTimeout: NodeJS.Timeout | null = null;
  let quitPending = false;

  const handleQuit = () => {
    if (quitPending) {
      // Second press — actually quit
      if (quitWarningTimeout) clearTimeout(quitWarningTimeout);
      quitPending = false;
      isQuitting = true;
      app.quit();
    } else {
      // First press — show toast, wait for second press
      quitPending = true;
      mainWindow?.show();
      mainWindow?.webContents.executeJavaScript(`
        (() => {
          let t = document.getElementById('bf-quit-toast');
          if (!t) {
            t = document.createElement('div');
            t.id = 'bf-quit-toast';
            t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,0.12);backdrop-filter:blur(20px);color:#fff;padding:10px 24px;border-radius:10px;font:13px/1.4 -apple-system,system-ui,sans-serif;z-index:999999;pointer-events:none;transition:opacity 0.25s;border:1px solid rgba(255,255,255,0.1);';
            document.body.appendChild(t);
          }
          t.textContent = 'Press \\u2318Q again to quit';
          t.style.opacity = '1';
        })()
      `).catch(() => {});
      quitWarningTimeout = setTimeout(() => {
        quitPending = false;
        mainWindow?.webContents.executeJavaScript(`
          (() => {
            const t = document.getElementById('bf-quit-toast');
            if (t) { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }
          })()
        `).catch(() => {});
      }, 3000);
    }
  };

  // Reload helper: re-navigate to the app instead of using webContents.reload()
  // which can fail with file:// URLs if base href doesn't match
  const reloadWindow = (win: BrowserWindow) => {
    if (isDev) {
      win.loadURL('http://localhost:4250');
    } else {
      const appPath = codeRoot;
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      win.loadFile(indexPath);
    }
  };

  // Set up application menu
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: handleQuit,
        }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac
          ? { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: (_item, focusedWindow) => {
              // Hide the main window (keeps the app alive); close any other focused window (e.g. the Listen/player window).
              if (focusedWindow && focusedWindow !== mainWindow) focusedWindow.close();
              else mainWindow?.hide();
            } }
          : { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: handleQuit }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, focusedWindow) => {
            if (focusedWindow) reloadWindow(focusedWindow);
          }
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_item, focusedWindow) => {
            if (focusedWindow) {
              focusedWindow.webContents.session.clearCache().then(() => reloadWindow(focusedWindow));
            }
          }
        },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            saveZoomLevel(0);
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.setZoomLevel(0);
            }
          }
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: (_item, focusedWindow) => {
            if (focusedWindow) {
              const newLevel = focusedWindow.webContents.getZoomLevel() + 0.5;
              saveZoomLevel(newLevel);
              for (const win of BrowserWindow.getAllWindows()) {
                win.webContents.setZoomLevel(newLevel);
              }
            }
          }
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: (_item, focusedWindow) => {
            if (focusedWindow) {
              const newLevel = focusedWindow.webContents.getZoomLevel() - 0.5;
              saveZoomLevel(newLevel);
              for (const win of BrowserWindow.getAllWindows()) {
                win.webContents.setZoomLevel(newLevel);
              }
            }
          }
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, don't quit when all windows close (app stays in dock)
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Track if we've already run cleanup to avoid duplicate work
let cleanupDone = false;

app.on('before-quit', async (event) => {
  isQuitting = true;
  if (cleanupDone) return;

  // Prevent quit until cleanup is done
  event.preventDefault();
  cleanupDone = true;

  console.log('[MAIN] Running cleanup before quit...');

  // Kill any active TTS workers
  try {
    const { killAllWorkers, forceKillAllE2aProcesses } = await import('./parallel-tts-bridge.js');
    killAllWorkers();
    // Also run aggressive cleanup to catch any orphans
    forceKillAllE2aProcesses();
  } catch (err) {
    console.error('[MAIN] Failed to kill TTS workers:', err);
  }

  // Kill the stream-preview XTTS worker pool (otherwise its Python process outlives the app)
  try {
    const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
    if (xttsWorkerPool.isSessionActive()) {
      await xttsWorkerPool.endSession();
    }
  } catch (err) {
    console.error('[MAIN] Failed to end stream TTS session:', err);
  }

  // Stop bookshelf server if running
  if (bookshelfServer.isRunning()) {
    await bookshelfServer.stop();
  }

  // Stop TTS API server if running
  try {
    const { ttsApiServer } = await import('./tts-api-server.js');
    if (ttsApiServer.isRunning()) {
      await ttsApiServer.stop();
    }
  } catch (err) {
    console.error('[MAIN] Failed to stop TTS API server:', err);
  }

  // Terminate PDF worker thread
  try {
    await pdfWorkerProxy.terminate();
  } catch (err) {
    console.error('[MAIN] Failed to terminate PDF worker:', err);
  }

  // Dispose all plugins
  const registry = getPluginRegistry();
  await registry.disposeAll();

  // Close loggers
  await closeLoggers();

  console.log('[MAIN] Cleanup complete, quitting...');
  app.quit();
});

// Synchronous backup cleanup on process exit (catches force-quit scenarios)
process.on('exit', () => {
  if (process.platform === 'win32') {
    try {
      // Synchronous last-ditch effort to kill any orphaned Python processes
      // This runs even on force-quit but has limited time
      const { execSync } = require('child_process');
      execSync('taskkill /F /IM "python.exe" /FI "WINDOWTITLE eq *ebook2audiobook*"', {
        stdio: 'ignore',
        timeout: 2000,
      });
    } catch {
      // Best effort, may fail
    }
  }
});

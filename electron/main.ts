import { app, BrowserWindow, ipcMain, dialog, Menu, protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as pdfWorkerProxy from './pdf-worker-proxy.js';
import { getPluginRegistry } from './plugins/plugin-registry';
import { loadBuiltinPlugins } from './plugins/plugin-loader';
import { bookshelfServer } from './bookshelf-server';
import * as ebookLibrary from './ebook-library';
import { importEpubProject } from './import-epub-project';
import { initializeLoggers, getMainLogger, getTTSLogger, closeLoggers } from './rolling-logger';
import { setupAlignmentIpc } from './sentence-alignment-window.js';
import { Quire } from '../packages/quire/src';
import {
  setupQuireViewerIpc, closeAllBooksForViewer, closeViewerDocumentsUnder,
} from './quire-viewer-bridge';
import { registerClipforgeIpc } from './clipforge-bridge';
import { registerDocumentIpc } from './document-ipc';
// A project's files belong to no one window: the picker is its own BrowserWindow
// and has to hear that the book changed just as much as the main one does.
import { broadcastToAllWindows } from './document-stage-run';
import { listProjectPdfs, listWorkingDocuments } from './document-project';
import * as manifestService from './manifest-service';
import {
  currentEpubEditorLayout,
  readEditorLayoutState,
  EDITOR_LAYOUT_MANIFEST_KEY,
} from './editor-layout';
import { migrateLegacyEpubEditorRecords } from './legacy-epub-layout';
import { readEditorState, sweepEditorState, writeEditorState } from './editor-state-store';
import * as manifestMigration from './manifest-migration';
import * as archiveMigration from './archive-migration';
import { findEbookConvert } from './ebook-convert-bridge';
import { applyMetadata, normalizeAudioToM4b, extractVttFromM4b, embedAndVerifyVtt, deleteSidecarsForM4b } from './metadata-tools';
import { normalizeFsPath, toAsciiSlug } from './path-utils';
// Type-only: the module itself is loaded lazily like every other epub-processor
// use here, so importing its types costs nothing at runtime.
import type { EpubPreservingEdits } from './epub-processor.js';
import type { ExportProvenance, ResolvedProjectVariant } from './manifest-types';
import type { WorkingCopyRemint } from '../shared/document/working-copy-remint';
// The listing-shaped half of the family rules: one chain is an answer, anything
// else is null, and it never throws. Everything that ACTS on a book goes through
// `manifestService.requireFamily` instead and gets the refusal sentence.
import { soleFamily } from '../shared/document/book-families';
import { samePath } from '../shared/document/same-path';
import { isBookPath } from '../shared/document/book-path';
// The one rule that turns the chapter-opening naming pass's per-chapter outcome
// into the sentence the picker owes the user after a rename.
import { chapterOpeningRefusal } from '../shared/document/chapter-opening-report';
// A block's element key says which DOCUMENT it is in, which is the identity a
// chapter is listed, renamed and struck by.
import { parseNarrationElementKey } from '../shared/vlm/narration-deletions';
import { addVariant, importAudiobookProject, saveVariantMetadata, setPrimaryVariant, setVariantProfessional, saveImageToMedia as saveImageToMediaShared } from './library-actions';
import { setE2aScratchDir, getDefaultE2aTmpPath } from './e2a-paths';
import { getOrpheusBatchConfig, setOrpheusMaxBatch } from './orpheus-batch';
import { getOrpheusMemoryTier, setOrpheusMemoryTier, orpheusMemoryProfile, resolveConcreteOrpheusTier, fitOrpheusTier, getOrpheusAutoCeiling, type OrpheusMemoryTier } from './orpheus-memory';
// TYPE ONLY — the module itself stays behind the dynamic imports in the orpheus:* IPC
// handlers (it pulls in the HF catalogue + WSL path machinery), so this import erases
// completely at build time and costs nothing at startup.
import type { OrpheusCatalogEntry } from './orpheus-hf-catalog';
import { getGpuMemMB } from './gpu-arbiter';
import { loadConfig as loadToolPathsConfig } from './tool-paths';
import { getRenderCacheBaseDir } from './render-cache';
import { mergeEpubParagraphs } from './epub-paragraph-merger';
// A book is a set of named entries; whether they live in a ZIP or in a folder is
// a fact about the path. The working copy is a folder now, so every handler here
// that removes or writes a book goes through the seam rather than through
// `unlink`/`writeFile`, which quietly mean "file" (electron/epub-container.ts).
import { removeEpubContainer, writeEpubFromArchiveBytes } from './epub-container';
import { componentManager, runInstaller as runExternalInstaller, listInstallableIds, installerNote } from './components/component-manager';
import { systemProbe } from './components/system-probe';
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

/** Report file-import progress (e.g. the ffmpeg transcode when importing a big
 *  audio file) to the renderer so it can show a determinate bar. */
function emitImportProgress(name: string, fraction: number, projectId?: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('import:progress', { name, fraction, projectId });
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

// ─────────────────────────────────────────────────────────────────────────────
// Startup upgrade check — installed components that are behind the catalog, and
// a foundry release newer than the pin. See
// electron/components/startup-upgrade-check.ts for the rules; the renderer runs
// the result through SetupDownloadService and the existing download shelf.
// ─────────────────────────────────────────────────────────────────────────────

let upgradeCheckStarted = false;

/**
 * Run the sweep once per launch and push the result to the window.
 *
 * Once, because `did-finish-load` fires again on every reload — routine in
 * `electron:dev`, where a hot reload would otherwise re-queue an upgrade that is
 * already downloading. The renderer subscribes before this can fire (the
 * listener is registered in App.ngOnInit, and the check is started from
 * did-finish-load), but the result is also cached for a subscriber that asks
 * late — see the `components:upgrades` handler.
 *
 * Fully non-fatal: nothing here can prevent the window from opening, and a
 * rejected promise is logged rather than surfaced as an unhandled rejection.
 */
async function runStartupUpgradeCheck(): Promise<void> {
  if (upgradeCheckStarted) {
    // A reload after the first check: replay what we found rather than sweeping
    // again, so the shelf repopulates without a second round of detection.
    if (lastUpgradeReport) {
      mainWindow?.webContents.send('components:upgrades-available', lastUpgradeReport);
    }
    return;
  }
  upgradeCheckStarted = true;
  try {
    const { checkForComponentUpgrades } = await import('./components/startup-upgrade-check.js');
    const report = await checkForComponentUpgrades();
    lastUpgradeReport = report;
    if (report.upgrades.length > 0 || report.problems.length > 0) {
      mainWindow?.webContents.send('components:upgrades-available', report);
    }
  } catch (err) {
    // checkForComponentUpgrades catches its own failures and reports them in
    // `problems`, so reaching here means the module itself would not load.
    console.error('[updates] the startup upgrade check could not run:', err);
    upgradeCheckStarted = false; // a later reload may succeed
  }
}

let lastUpgradeReport: import('./components/startup-upgrade-check').StartupUpgradeReport | null = null;

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
 * Empty the e2a tmp dir — but RESCUE first. Called at startup and after the library
 * root changes. Finished sessions are already removed once cached
 * (cacheSessionToBfp/Project); this catches everything else so tmp never grows.
 *
 * The rescue pass is load-bearing, not hygiene: a run killed by jetsam/force-quit/power
 * loss never reaches before-quit's flushActiveSessionsToCache, so its rendered sentences
 * exist ONLY here. Wiping unconditionally (the old behavior) destroyed the resume
 * checkpoint before the queue could ever read it, and the "resume" the user then
 * triggered restarted the book at sentence 0.
 */
async function sweepDirContents(dir: string): Promise<void> {
  // Snapshot BEFORE the rescue: promoting a large session is a real copy that can take
  // minutes, and a TTS job submitted meanwhile writes a brand-new ebook-{uuid} here.
  // Deleting only what existed at snapshot time keeps the sweep from eating a live run.
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).map((e) => e.name);
  } catch {
    return; /* dir doesn't exist yet / volume offline — nothing to clean */
  }

  try {
    const { rescueOrphanedScratchSessions } = await import('./parallel-tts-bridge.js');
    await rescueOrphanedScratchSessions(dir);
  } catch (err) {
    console.error('[MAIN] Scratch rescue failed before sweep (continuing):', err);
  }

  await Promise.all(
    names.map((name) =>
      fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
    )
  );
  if (names.length) console.log(`[MAIN] Cleaned ${names.length} item(s) from e2a tmp: ${dir}`);
}

async function cleanE2aTmpDir(): Promise<void> {
  await sweepDirContents(getDefaultE2aTmpPath());

  // WSL Orpheus runs the WSL-native e2a, which writes sessions to its own
  // <wslE2a>/tmp (not <library>/tmp) — sweep that too so it doesn't accumulate.
  // GATED on a timeout-bounded liveness probe: this runs at STARTUP, and fs against
  // \\wsl$ with a wedged VM strands the readdir/rm promises forever (and used to
  // contribute to the boot hang).
  try {
    const { shouldUseWsl2ForOrpheus, getWslE2aPath, wslPathToWindows } = await import('./tool-paths.js');
    if (shouldUseWsl2ForOrpheus()) {
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      if (await isWslAlive()) {
        await sweepDirContents(wslPathToWindows(`${getWslE2aPath()}/tmp`));
      } else {
        console.warn('[MAIN] Skipping WSL e2a tmp sweep — WSL is not responding');
      }
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
async function loadBookshelfConfig(): Promise<{ enabled: boolean; port: number } | null> {
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
async function saveBookshelfConfig(config: { enabled: boolean; port: number }): Promise<void> {
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

    // Strip any cache-busting query string (?v=...) so it isn't treated as part
    // of the file path. The renderer appends ?v=<ts> to force a fresh fetch after
    // a stem is re-rendered in place (same path, new content — e.g. re-convert).
    const qIndex = filePath.indexOf('?');
    if (qIndex !== -1) {
      filePath = filePath.substring(0, qIndex);
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

// Root of the app — the directory that contains dist/ (and bookforge-icon.png).
// Derived from __dirname (dist/electron -> root); resolves to app.getAppPath() in both
// dev and packaged (asar) layouts.
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

    // Surface (don't auto-install) available updates for our managed binaries.
    if (app.isPackaged) {
      checkComponentUpdates()
        .then((updates) => {
          if (updates.length) {
            console.log('[update] managed component updates available:', updates.map((u) => `${u.id} ${u.state}`).join(', '));
            mainWindow?.webContents.send('update:components-available', updates);
          }
        })
        .catch((err) => console.warn('[update] component update check failed:', err));
    }

    // Are any INSTALLED optional components behind what the catalog names — and
    // has foundry published a release newer than the pin? The renderer feeds the
    // answer to SetupDownloadService, which runs the upgrades through the same
    // queue and the same bottom-right shelf as every other download.
    //
    // NOT gated on app.isPackaged, unlike the managed-binary check above: a dev
    // build resolves components out of the same <userData>/components directory a
    // packaged one does, so a stale install is equally stale there — and gating it
    // would mean the path could only ever be exercised by shipping it.
    void runStartupUpgradeCheck();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ClipForge window (second app in this workspace). WINDOWS-ONLY app — no macOS
// support. Loads the clipforge Angular build in its OWN window with its OWN
// preload (window.clipforge), separate from the main BookForge window.
// ─────────────────────────────────────────────────────────────────────────────

const clipforgeWindows = new Set<BrowserWindow>();

function loadClipforge(win: BrowserWindow): void {
  if (isDev) {
    win.loadURL('http://localhost:4270');
  } else {
    const indexPath = path.join(codeRoot, 'dist', 'electron', 'clipforge-ui', 'index.html');
    win.loadFile(indexPath).catch((err) => {
      win.loadURL(`data:text/html,
        <html><body style="background:#1a1a1a;color:#fff;font-family:system-ui;padding:40px;">
        <h1>Failed to load ClipForge</h1>
        <p>Error: ${err.message}</p>
        <p>Index path: ${indexPath}</p>
        </body></html>`);
    });
  }
}

function openClipforgeWindow(): BrowserWindow {
  const existing = [...clipforgeWindows].find((w) => !w.isDestroyed());
  if (existing) {
    existing.focus();
    return existing;
  }
  const iconPath = isDev
    ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
    : path.join(codeRoot, 'bookforge-icon.png');
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'clipforge-preload.js'),
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
  });
  clipforgeWindows.add(win);
  win.on('closed', () => {
    clipforgeWindows.delete(win);
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomLevel(loadZoomLevel());
  });
  loadClipforge(win);
  return win;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor Window - Opens PDF picker in a new window for editing a project
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Track open editor windows by the path they were opened on.
 *
 * Keyed by path rather than per-caller, so the same book cannot open twice in
 * two windows that then autosave over each other.
 */
const editorWindows = new Map<string, BrowserWindow>();

/**
 * Open the editor on a path. `options.mode` travels in the ROUTE because the
 * editor is a different BrowserWindow that has not booted yet — anything sent to
 * it before `did-finish-load` lands nowhere.
 *
 *   mode=library   editing a standalone ebook file, not a manifest project
 */
function openEditorWindow(
  rawProjectPath: string,
  options?: { mode?: string },
): { success: boolean; alreadyOpen?: boolean } {
  // Manifest-derived paths can be NFD (macOS-written) while the Windows disk
  // entry is NFC — fs.* on the raw path ENOENTs. NFC-normalize so it resolves.
  const projectPath = normalizeFsPath(rawProjectPath);
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
      // The EPUB viewer shows a book's pages in <webview> frames confined to
      // the book's own session partition. Without this flag the element is
      // silently inert — no error, no load, just an empty box.
      webviewTag: true,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
  });

  // Track the window
  editorWindows.set(projectPath, editorWindow);

  // ── The close is held open for the editor's last write ────────────────────
  //
  // The editor autosaves on a one-second debounce, so an edit made just before
  // the user reaches for the X has a pending write and nothing to make it: the
  // renderer is torn down mid-debounce and the edit is gone. (This comment used
  // to be a LIE told elsewhere — `destroyEditorWindowsFor` says the window
  // "writes back on interval and on close" and uses `destroy()` specifically to
  // skip the on-close save. There was no on-close save to skip.)
  //
  // So the first close is refused, the renderer is asked to flush on a channel
  // minted for THIS window, and the window is destroyed when it answers — or
  // when the deadline passes, because a renderer that is wedged must not leave a
  // window that cannot be closed. `destroy()` at the end rather than `close()`:
  // the flush has happened, and a second `close()` would just come back here.
  const flushChannel = `editor:flush-complete:${editorWindow.webContents.id}`;
  let flushAsked = false;
  editorWindow.on('close', (event) => {
    if (flushAsked) return;   // Asked once; a second X closes it outright.
    // NEVER during a quit. `before-quit` has already prevented the default once
    // to run its cleanup chain, and a window that prevents its own close after
    // that cancels the whole quit — the user presses Quit and nothing happens.
    // The renderer's `beforeunload` still hands its pending write to main on the
    // way out; what is given up here is only the WAIT for it.
    if (isQuitting) return;
    flushAsked = true;
    event.preventDefault();

    const finish = () => {
      ipcMain.removeListener(flushChannel, onFlushed);
      clearTimeout(deadline);
      if (!editorWindow.isDestroyed()) editorWindow.destroy();
    };
    const onFlushed = () => finish();
    // Short, because the common reason for silence is a window closed before the
    // editor finished mounting, and a window that will not shut is worse than a
    // window that shuts fast. Cutting a slow save off is safe: the renderer hands
    // the whole payload to main before it answers, and main finishes what it was
    // asked to do whether or not the window that asked still exists.
    const deadline = setTimeout(() => {
      console.warn(
        `[main] ${path.basename(projectPath)}'s editor did not answer the pre-close flush in 3s; `
        + 'closing anyway.',
      );
      finish();
    }, 3000);

    ipcMain.once(flushChannel, onFlushed);
    editorWindow.webContents.send('editor:flush-before-close', flushChannel);
  });

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
}

/**
 * Name the chapter openings of a working copy that has just been made AGAIN.
 *
 * ── Why this exists at all: the ordering ────────────────────────────────────
 *
 * A book's chapter openings are made to print the name the book stores for that
 * chapter at OPEN (`projects:load-from-path` → `nameChapterOpenings`), and Owen
 * put it there so that "from the moment the book opens, the chapter openers
 * contain the chapter's text. period." But the picker asks to open the project
 * BEFORE it asks where the book is, and a user who deleted the working copy has
 * no book at the first of those calls: the naming pass finds nothing, returns
 * "nothing edited", and the copy minted a moment later by `projects:export-info`
 * is the archive original with the publisher's headings on it — unnamed until
 * some later session happens to open the project again.
 *
 * So the pass is run HERE, immediately after the mint, which puts the three acts
 * in the only order that is coherent: RESET the records, MINT the fresh copy,
 * NAME its openings. The user sees the same book a first-time open would give
 * them.
 *
 * ── Only a RE-mint ──────────────────────────────────────────────────────────
 *
 * A null remint is either a book that was already on disk (the naming pass has
 * already run over it at open, and it is idempotent — running it again would
 * change nothing) or a project's FIRST copy, which is the ordinary invisible
 * first act of opening an EPUB and is named by the next open like every book
 * before it. Neither is the case this is for.
 *
 * ── A refusal here does not fail the caller ─────────────────────────────────
 *
 * By the time this runs the copy IS made and recorded; the caller's answer —
 * "here is your book, and here is what deleting the old one cost" — is true
 * whatever the naming pass does. A book whose openings could not be rewritten is
 * a book that prints the publisher's headings, which is a cosmetic difference
 * said on the console, not a reason to tell the user their project failed to
 * open.
 */
async function nameOpeningsOfRemintedCopy(
  projectDir: string,
  remint: WorkingCopyRemint | null,
  familyId?: string,
): Promise<void> {
  if (remint === null) return;
  await nameOpeningsOfFreshCopy(projectDir, familyId);
}

/**
 * The naming pass over a working copy that has JUST been derived, whatever
 * derived it.
 *
 * Split out from the re-mint case when the ledger arrived, because deleting a
 * ledger entry also puts a fresh copy of the book on disk and its openings are
 * owed the same treatment — and the alternative was to hand
 * `nameOpeningsOfRemintedCopy` a `WorkingCopyRemint` with invented zeroes, which
 * is a record claiming an event that did not happen just to reach a call.
 *
 * Naming is IDEMPOTENT and derived from the chapter titles the project stores,
 * which is what makes it a normalization that can be re-applied after any
 * rebuild rather than a layer that has to be carried across one.
 *
 * The ELEMENT-ID STAMP runs first, for the reason it runs first at the open
 * door: an element's identity has to exist before anything writes to the
 * element, and naming an opening writes to one. It is idempotent too, so a copy
 * that arrived already stamped costs a walk and no bytes.
 */
async function nameOpeningsOfFreshCopy(projectDir: string, familyId?: string): Promise<void> {
  try {
    const { nameChapterOpenings, stampElementIds } = await import('./narration-export.js');
    const stamped = await stampElementIds(projectDir, familyId);
    if (stamped.stamped > 0) {
      console.log(
        `[main] ${path.basename(projectDir)}: ${stamped.stamped} of ${stamped.total} element(s) of `
        + 'the fresh working copy now carry a stable id.'
      );
    }
    const named = await nameChapterOpenings(projectDir, familyId);
    if (named.edited > 0) {
      console.log(
        `[main] ${path.basename(projectDir)}: ${named.edited} chapter opening(s) of the fresh `
        + 'working copy now read the name the book stores for their chapter.'
      );
    }
  } catch (err) {
    console.warn(
      `[main] ${path.basename(projectDir)}'s working copy was made again, but its elements could `
      + `not be given their ids or its chapter openings could not be rewritten to say their stored `
      + `names: ${(err as Error).message}`
    );
  }
}

/**
 * Shut any editor window open on this project — hard, without its autosave.
 *
 * The staleness guard both acts that clear a project's records need. An editor
 * window holds the edit state in signals and writes it back on interval and on
 * close, so a reset performed under an open window is undone by that window a
 * moment later. `destroy()` (NOT `close()`) is what skips the renderer's
 * on-close save, which is the whole reason this is not just a `close`.
 *
 * Both spellings of the path are looked up because the map is keyed by whatever
 * the opener passed: a manifest-derived path can be NFD (macOS-written) while
 * the disk entry is NFC, and the two are different map keys for one window.
 */
/**
 * Are these two absolute paths the same file, once both are resolved?
 *
 * `shared/document/same-path.ts` compares what it is GIVEN and says so — it is
 * for picking a view. The handlers below use the answer to authorize a write, so
 * both sides go through `path.resolve` and NFC normalization first: a manifest
 * path can be NFD (macOS-written) while the disk entry is NFC, and `..` in a
 * caller's string must not decide where a book is saved.
 */
function sameResolvedPath(a: string, b: string): boolean {
  return samePath(path.resolve(normalizeFsPath(a)), path.resolve(normalizeFsPath(b)));
}

/**
 * A path that is inside the library folder, or the sentence saying it is not.
 *
 * The guard every neighbouring write handler carries, in one place: the raw
 * `fs:*` doors below had none at all, so a renderer bug or a stale path could
 * unlink a recorded book with nothing updating the record. Returns null when the
 * path is allowed, so a caller reads `const refusal = insideLibraryRefusal(p);
 * if (refusal) return { success: false, error: refusal };`.
 */
function insideLibraryRefusal(target: string, act: string): string | null {
  const libraryRoot = path.normalize(getLibraryRoot());
  const normalized = path.normalize(path.resolve(normalizeFsPath(target)));
  if (normalized === libraryRoot || normalized.startsWith(libraryRoot + path.sep)) return null;
  console.error(`[${act}] BLOCKED: ${normalized} is outside the library folder ${libraryRoot}`);
  return `Cannot ${act} outside the library folder. Attempted path: ${target}`;
}

function destroyEditorWindowsFor(...projectPaths: string[]): void {
  for (const key of new Set(projectPaths)) {
    const win = editorWindows.get(key);
    if (win && !win.isDestroyed()) win.destroy();
    editorWindows.delete(key);
  }
}

function setupIpcHandlers(): void {
  // ClipForge: open its dedicated window (second app in this workspace).
  ipcMain.handle('clipforge:open-window', () => { openClipforgeWindow(); return { success: true }; });

  /**
   * "Run in background" — the hand-off, made visible.
   *
   * RULED 2026-08-04 (docs/PIPELINE_V2_PLAN.md): a job that moves to the queue
   * moves the USER with it. "if the user hits the process in background button,
   * it should move it to the queue and move focus from the current page (pdf
   * picker) to the main page and jump to the queue so they can see it was moved
   * there." A job that silently vanishes from one place and silently appears in
   * another is how work gets lost.
   *
   * The picker is its own BrowserWindow (`openEditorWindow`), so "move focus to
   * the main page" is literally that: raise the main window and route it. The
   * editor window is deliberately NOT closed — the user did not ask to shut the
   * book, only to stop watching the run — and the queue lives in the main window
   * regardless (`processing:submit-chain` sends the plan only there), so this is
   * the one place the row can actually be seen.
   */
  ipcMain.handle('app:show-queue', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        success: false,
        error: 'BookForge has no main window open, so there is no Queue to show the run on.',
      };
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('app:show-queue');
    return { success: true };
  });

  /**
   * The picker's Next, at the top of the ladder — the book is built, so hand the
   * user to narration.
   *
   * Same shape as `app:show-queue` above and for the same reason: the picker is
   * always its own BrowserWindow (`openEditorWindow`), so "take them to the TTS
   * page" is a main-process action — raise the MAIN window and tell it where to
   * go. The picker must never reach for the main window's router.
   *
   * It carries the PROJECT, because narration is not a route: it is Studio's
   * Process tab, which shows the wizard for whichever project is selected. A
   * bare event would land the user on somebody else's book.
   *
   * The refusal matters as much as the success. The picker waits for this answer
   * before it closes itself, so a missing main window has to come back as a
   * failure the picker can say out loud rather than as a window that shuts on a
   * hand-off nobody caught.
   */
  ipcMain.handle('app:show-narration', (_e, projectDir: string) => {
    if (typeof projectDir !== 'string' || projectDir.trim() === '') {
      return {
        success: false,
        error: 'Opening narration needs the project it is for, and none was given.',
      };
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        success: false,
        error: 'BookForge has no main window open, so there is nowhere to open narration.',
      };
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('app:show-narration', projectDir);
    return { success: true };
  });

  /**
   * A window asked for this project's pages to be read into a book.
   *
   * Same shape, same reason, as `app:show-narration` above: the picker is often
   * its own BrowserWindow with no nav rail and NO QUEUE — the queue is a
   * renderer-side scheduler that lives in the main window and persists its state
   * through main. A second window enqueueing into its own copy would write a
   * queue file over the one the user is watching. So the request is handed to
   * the main window, which starts the job through the ordinary path
   * (`BookConversionService.sendToQueue`) and shows the user the queue.
   */
  ipcMain.handle('app:show-book-conversion', (_e, projectDir: string) => {
    if (typeof projectDir !== 'string' || projectDir.trim() === '') {
      return {
        success: false,
        error: 'Reading a book\'s pages needs the project it is for, and none was given.',
      };
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        success: false,
        error: 'BookForge has no main window open, so there is no queue to put the conversion in.',
      };
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('app:show-book-conversion', projectDir);
    return { success: true };
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

  /**
   * Does this PDF carry text of its own?
   *
   * The processing wizard's question: with a text layer an OCR pass is a choice,
   * without one it is the only way the book gets any words at all. Sampled rather
   * than extracted whole — see pdf-analyzer.measureTextLayer. A failure is
   * returned as a failure; there is no "probably fine" answer, because guessing
   * "optional" on a scan is how a user queues five hours of narration of nothing.
   */
  ipcMain.handle('pdf:measure-text-layer', async (_event, pdfPath: string, maxSamples?: number) => {
    try {
      const report = await pdfWorkerProxy.callMeasureTextLayer(pdfPath, maxSamples);
      return { success: true, data: report };
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
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const fsLocal = require('fs').promises;
      // ── ARGV, never a command string ──────────────────────────────────────
      //
      // `exec` hands its string to a shell, and every argument here is a path
      // out of the user's library — a book called `Whatever `rm -rf ~`.pdf`, or
      // one carrying `$(...)`, ran as a command on macOS and Linux, and the
      // library is Mac↔Windows synced so such a name arrives from the other
      // machine. `execFile` passes the array to the process directly: there is
      // no shell, so there is nothing for a filename to escape from. Same shape
      // as chapter-recovery-bridge's `spawn(getFfmpegPath(), [...])`.
      const run = promisify(execFile) as (
        file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

      // Create temp directory for intermediate files
      const tempDir = await fsLocal.mkdtemp(path.join(os.tmpdir(), 'bookforge-epub-'));
      const tempTextFile = path.join(tempDir, 'extracted.txt');
      const tempEpubFile = path.join(tempDir, 'output.epub');

      // A book is a book — `isBookPath`, not the raw extension: the working
      // copy is `<stem>.working` (an exploded directory since Aug 2026), and
      // the extension test here silently routed it down the PDF arm, where
      // pdftotext was handed a directory.
      const isBook = isBookPath(filePath);

      // Find ebook-convert using cross-platform discovery
      const ebookConvertPath = await findEbookConvert();
      if (!ebookConvertPath) {
        throw new Error('Calibre ebook-convert not found. Please install Calibre from https://calibre-ebook.com');
      }

      try {
        // Step 1: Extract text based on file type
        if (isBook) {
          // For EPUB: use ebook-convert to extract text. ebook-convert reads a
          // ZIP epub, and the working copy may be the exploded tree (its
          // editable form) — so a directory book is packed to a temp zip
          // first, the same on-demand packing the legacy layout path uses
          // (readEpubAsArchiveBytes, measured 397 ms on a 32 MB tree). The
          // container is MEASURED, not read off the name.
          console.log('[Text-only EPUB] Extracting text from EPUB...');
          let epubFileForConvert = filePath;
          if ((await fsLocal.stat(filePath)).isDirectory()) {
            const { readEpubAsArchiveBytes } = await import('./epub-container.js');
            epubFileForConvert = path.join(tempDir, 'source.epub');
            await fsLocal.writeFile(epubFileForConvert, await readEpubAsArchiveBytes(filePath));
          }
          await run(ebookConvertPath, [epubFileForConvert, tempTextFile]);
        } else {
          // For PDF: use pdftotext
          console.log('[Text-only EPUB] Extracting text from PDF...');
          const pdftotextPath = await findPdftotext();
          if (!pdftotextPath) {
            throw new Error('pdftotext not found. Please install poppler-utils (Linux/Mac) or poppler (Windows via scoop/chocolatey).');
          }
          await run(pdftotextPath, ['-layout', filePath, tempTextFile]);
        }

        // Check if text was extracted
        const stats = await fsLocal.stat(tempTextFile);
        if (stats.size === 0) {
          throw new Error(`No text extracted from ${isBook ? 'EPUB' : 'PDF'}`);
        }

        // Step 2: Convert text to EPUB using ebook-convert
        console.log('[Text-only EPUB] Converting to EPUB...');
        // No escaping, because there is no shell to escape for. The metadata
        // used to be run through an ad-hoc shell-metacharacter escaper while the
        // PATHS beside it were interpolated raw — the escaping was on the one
        // argument that could not hurt anyone.
        const convertArgs = [tempTextFile, tempEpubFile];
        if (metadata?.title) convertArgs.push('--title', metadata.title);
        if (metadata?.author) convertArgs.push('--authors', metadata.author);
        convertArgs.push(
          '--formatting-type=markdown', '--paragraph-type=auto', '--page-breaks-before=/');

        await run(ebookConvertPath, convertArgs);

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
      const result = await pdfWorkerProxy.call('exportPdf', [pdfPath, deletedRegions, ocrBlocks, deletedPages, chapters], event.sender);
      // result carries non-fatal warnings (e.g. "exported without bookmarks") —
      // pass them through so the renderer can surface them.
      return { success: true, data: { pdf_base64: result.pdf_base64, warnings: result.warnings } };
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
        // No span cache at all means the recycled worker lost its state — that is
        // an error, NOT "this block has zero spans", and must be distinguishable.
        console.warn('[pdf:get-spans-for-block] No spans available (worker may have been recycled)');
        return { success: false, error: 'PDF worker was recycled — reopen or reload the document' };
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
      return { success: true, data: result };
    } catch (err) {
      console.error('[pdf:assemble-from-images] Error:', err);
      return { success: false, error: (err as Error).message };
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

  // ── The raw file doors, guarded like every other write handler ────────────
  //
  // These three took an absolute path from the renderer and wrote, unlinked or
  // recursively removed it with NO check at all, while every neighbouring write
  // handler (epub:save-modified, epub:copy-file, editor:save-epub) carries the
  // inside-the-library guard. That made them a live route to removing a recorded
  // book — file gone, record untouched — from a renderer bug or a stale path.
  //
  // The guard is the floor, not a licence: a file inside the library that a
  // manifest vouches for should be removed through the handler that also clears
  // its record (`variant:delete`, `book:delete-tts-copy`, `pipeline:delete-*`).
  ipcMain.handle('fs:write-text', async (_event, filePath: string, content: string) => {
    const fs = await import('fs/promises');
    const refusal = insideLibraryRefusal(filePath, 'fs:write-text');
    if (refusal) return { success: false, error: refusal };
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:delete-file', async (_event, filePath: string) => {
    const fs = await import('fs/promises');
    const refusal = insideLibraryRefusal(filePath, 'fs:delete-file');
    if (refusal) return { success: false, error: refusal };
    try {
      await fs.unlink(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('fs:delete-directory', async (_event, dirPath: string) => {
    const fs = await import('fs/promises');
    const refusal = insideLibraryRefusal(dirPath, 'fs:delete-directory');
    if (refusal) return { success: false, error: refusal };
    // The library ROOT itself is inside the library, and this call is recursive:
    // one bad path would take the whole library. Named separately because the
    // sentence a user needs there is not "outside the library folder".
    if (sameResolvedPath(dirPath, getLibraryRoot())) {
      return {
        success: false,
        error: 'Refusing to delete the library folder itself. Every book in it would go with it.',
      };
    }
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // List files in a directory.
  // Deliberately NO catch: a failed read (missing dir, permissions, offline
  // drive) must reject the invoke so callers can tell "empty directory" apart
  // from "could not read directory". Every renderer caller goes through
  // electronService.listDirectory inside its own try/catch.
  ipcMain.handle('fs:list-directory', async (_event, dirPath: string): Promise<string[]> => {
    const fsPromises = await import('fs/promises');
    return fsPromises.readdir(dirPath);
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

  // Extract the WebVTT transcript embedded inside an .m4b (by embedVttInM4b). The
  // player prefers this over a sidecar .vtt: it's guaranteed to be THIS audio's
  // transcript, immune to filename/sidecar mismatches. Returns { vtt: undefined }
  // when the file has no embedded track (older audiobooks → caller uses the sidecar).
  ipcMain.handle('audiobook:extract-embedded-vtt', async (_event, m4bPath: string) => {
    try {
      const vtt = await extractVttFromM4b(m4bPath);
      return { success: true, vtt: vtt ?? undefined };
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

  // Persist the editor's serialized state into a project directory's manifest.json.
  ipcMain.handle('project:save-to-path', async (_event, filePath: string, projectData: unknown) => {
    try {
      let mergedData = projectData as Record<string, unknown>;

      // Check if filePath is a manifest project directory
      const isDir = fsSync.existsSync(filePath) && fsSync.statSync(filePath).isDirectory();
      if (isDir) {
        // ── THROUGH THE LOCK, and only the keys this handler owns ───────────
        //
        // This used to read manifest.json raw, mutate the object for a hundred
        // and seventy lines, and write the WHOLE thing back — outside
        // `modifyManifest`'s per-project lock. Everything that landed in between
        // was silently destroyed: a chain minted by the versions page, a
        // narration strike, a ledger entry, a finished conversion's
        // `outputs.generatedEpub`. The picker autosaves on a timer, so the
        // window in which that happens is open more or less constantly.
        //
        // So the manifest half is a `modifyManifest` transaction below that
        // touches `source`, `chapters`, `chaptersSource` and `metadata` and
        // nothing else, and the sidecar half is unchanged. `modifyManifest`
        // resolves the file from the project id, so the project must be one this
        // library owns — refused by name here rather than by writing a manifest
        // somewhere else (the check `epub:export-preserving-markup` makes).
        const projectId = path.basename(filePath);
        if (!sameResolvedPath(manifestService.getProjectPath(projectId), filePath)) {
          return {
            success: false,
            error: `Cannot save ${filePath}: it is not inside the configured library `
              + `(expected ${manifestService.getProjectPath(projectId)}), so its manifest cannot be `
              + 'located. Point the library setting at the folder that owns this project.',
          };
        }

        // ── A window that was never given the records may not speak for them ──
        //
        // `projects:load-from-path` WITHHOLDS every page- and block-keyed record
        // from a project whose layout could not be reconciled with this build's
        // — so such a window holds empty sets not because the user cleared them
        // but because it was never told. Letting this save write those empties
        // back would destroy the records in the ordinary act of opening a book
        // and closing it, which is precisely the silent loss the withholding
        // exists to prevent.
        //
        // So: when the stored layout is still stale, the layout-keyed records
        // are left EXACTLY as they are and no stamp is written. The refusal
        // travels back with the result, because the other half of that rule is
        // that anything the user DID delete in such a window is not saved
        // either, and they have to be told.
        // The picker's working state, from the sidecar it lives in
        // (electron/editor-state-store.ts), migrated on contact. It is read
        // BEFORE the layout question because the census that answers that
        // question counts editor records, and it is read from the store rather
        // than off `manifest` because the manifest no longer carries them.
        const storedEditor = await readEditorState(filePath) ?? {};

        // A READ-ONLY copy, and the only thing it is for: the layout question
        // below is a classification of what is already on file, not a value this
        // handler writes. The copy that gets WRITTEN is the one `modifyManifest`
        // re-reads inside the lock — and the pre-sidecar `editor` key is that
        // transaction's to move (`adoptLegacyEditorKey`), not this one's to
        // delete off an object nothing will save.
        const onFile = await manifestService.readProjectManifest(filePath) as Record<string, any>;

        const layoutState = readEditorLayoutState(
          path.basename(filePath),
          onFile.source?.type ?? '',
          { source: onFile.source, editor: storedEditor, chapters: onFile.chapters },
        );
        const layoutIsStale = layoutState.refusal !== null;
        if (layoutIsStale) {
          console.warn(
            `[project:save] ${path.basename(filePath)}: the page and block records on file were `
            + 'recorded against a layout this build does not produce and were not loaded into this '
            + 'window, so this save leaves them untouched.',
          );
        }

        // ── The keys this handler OWNS, applied to the locked manifest ──────
        //
        // A mutator rather than a hundred and seventy lines of assignment onto an
        // object read minutes ago: `modifyManifest` re-reads inside the lock and
        // hands the callback THAT copy, so a chain minted, a strike recorded or a
        // conversion finished in between survives instead of being written back
        // out of existence by a picker autosave. Only `source`, `chapters` /
        // `chaptersSource` and `metadata` are touched; the chains, the ledger, the
        // outputs and the variants belong to other handlers and are not this
        // window's to restate.
        const applyEditorRecords = (m: Record<string, any>): void => {
          if (!m.source) m.source = {};
          if (!layoutIsStale) {
            m.source.deletedBlockIds = mergedData.deleted_block_ids || [];
            m.source.pageOrder = mergedData.page_order || [];
            m.source.deletedPages = mergedData.deleted_pages || [];
          }
          // INERT (see manifest-types.ts): nothing resolves scan-line deletions
          // any more — a deletion is `/FoundryDeleted` on the block's own
          // annotation. Carried through untouched so manifests that have the
          // field keep it until their projects go through the document pipeline.
          m.source.deletedBlockLines = mergedData.deleted_block_lines || undefined;
          // The one-title rule's "already ruled on" ledger, in the same
          // scan-stamped line identity — it was dropped on the floor here until
          // Aug 3 2026, so every reload re-deleted a part card the user had
          // restored. `foundry_auto_discarded_ids` is NOT persisted alongside it:
          // block ids are re-minted by every blocks run, and an id-keyed ledger
          // silently rules on other blocks after one.
          m.source.foundryAutoDiscardedLines =
            mergedData.foundry_auto_discarded_lines || undefined;
          m.source.deletedHighlightIds = mergedData.deleted_highlight_ids || [];
          m.source.removeBackgrounds = mergedData.remove_backgrounds || false;

          // ── Which LAYOUT these records are about ────────────────
          //
          // `deletedPages` is a page number and `deletedBlockIds` are md5s of
          // where blocks were drawn, so both mean nothing without the pagination
          // that produced them — and in August 2026 that pagination changed for
          // EPUBs (mupdf's reflow → quire's fragmentation of the book's own DOM,
          // 218 pages → 183 on Killing America). Every save from now on SAYS
          // which layout it was made in, so a later build never has to infer it.
          //
          // EPUBs only, and that is not a shortcut: a PDF's pages are the PDF's
          // own and did not change, so stamping one would record an answer to a
          // question that does not arise. `shared/document/editor-layout.ts`
          // reads an absent stamp on an EPUB as the mupdf era, which is what it
          // is — no manifest written before this line exists carries one.
          //
          // NOT written while the stored records are stale: the stamp would then
          // say "these are current" about numbers this save deliberately left as
          // they were.
          if (m.source.type === 'epub' && !layoutIsStale) {
            m.source[EDITOR_LAYOUT_MANIFEST_KEY] =
              currentEpubEditorLayout(new Date().toISOString());
          }

          // Chapters. The picker's markers carry a `page` and mostly no `blockId`,
          // so they are positions in the layout like everything above — and a
          // window that was not given them cannot restate them.
          if (!layoutIsStale) {
            m.chapters = mergedData.chapters || [];
            m.chaptersSource = mergedData.chapters_source || 'manual';
          }

          // Metadata from editor (title, author, etc.)
          if (mergedData.metadata) {
            if (!m.metadata) m.metadata = {};
            const meta = mergedData.metadata as Record<string, unknown>;
            if (meta.title !== undefined) m.metadata.title = meta.title;
            if (meta.author !== undefined) m.metadata.author = meta.author;
            if (meta.year !== undefined) m.metadata.year = meta.year;
            if (meta.language !== undefined) m.metadata.language = meta.language;
          }
          // `modifiedAt` is `saveManifestImpl`'s, stamped inside the lock.
        };

        // ── The editor state, into its own file ───────────────────
        //
        // Same sixteen keys, same withholding rule, same wholesale container the
        // reset wipes — a DIFFERENT file. `editorState` starts as what was
        // stored, so the stale-layout case still leaves the layout-keyed records
        // exactly as they were rather than writing an empty set over them.
        const editorState = storedEditor as Record<string, unknown>;
        if (!layoutIsStale) {
          editorState.undoStack = mergedData.undo_stack || [];
          editorState.redoStack = mergedData.redo_stack || [];
          // The block table the two stacks (and blockSplits/blockMerges below)
          // name their blocks in — every record there is an id, and this is
          // where the blocks themselves live. Holds only what the document
          // cannot produce again on the next open, so it is usually absent; see
          // shared/document/editor-history.ts.
          editorState.historyBlocks = mergedData.history_blocks || undefined;
          editorState.blockEdits = mergedData.block_edits || undefined;
          editorState.customCategories = mergedData.custom_categories || undefined;
          editorState.ocrBlocks = mergedData.ocr_blocks || undefined;
          // Blocks the USER authored (chapter boxes), kept apart from ocrBlocks on
          // purpose: restoring ocrBlocks calls replaceTextBlocksOnPages, which drops
          // every non-image block on the pages it touches, so a manual block riding
          // in there would take that page's native text layer with it.
          editorState.manualBlocks = mergedData.manual_blocks || undefined;
          editorState.categoryCorrections = mergedData.category_corrections || undefined;
          editorState.learnedCategories = mergedData.learned_categories || undefined;
          editorState.paragraphBreaks = mergedData.paragraph_breaks || undefined;
          // Block splits/merges, crop regions and legacy text corrections
          // previously never reached the manifest (only the retired single-file
          // .bfp projects persisted them), so text-mode splits and crops were lost
          // on reload for manifest projects. They round-trip through
          // the editor state now — the same wholesale-cleared container the reset
          // handler wipes, so reset still covers them automatically.
          // `|| undefined` omits empty keys (mirrors the fields above and the
          // renderer's own serializer), so old projects are unchanged.
          editorState.blockSplits = mergedData.block_splits || undefined;
          editorState.blockMerges = mergedData.block_merges || undefined;
          editorState.cropRegions = mergedData.crop_regions || undefined;
          editorState.textCorrections = mergedData.text_corrections || undefined;
        }
        // Keyed by CATEGORY id, and tuning numbers: neither names a position in
        // a layout, so both are written whatever the layout state is.
        editorState.ocrCategories = mergedData.ocr_categories || undefined;
        editorState.classificationThresholds = mergedData.classification_thresholds || undefined;
        // The digest of the exact file the edit set was made against. This is
        // the ONE signal the renderer's projectEditsMismatchReason gate has:
        // dropped here, the gate reads "nothing on file can prove otherwise"
        // and applies a PDF session's blocks and deletions to whatever document
        // happens to be open (the review EPUB, Aug 2 2026). Lives in editor
        // because it describes the edit set, and the wholesale editor reset
        // must clear it with the edits it vouches for.
        editorState.sourceFileSha256 = mergedData.source_file_sha256 || undefined;

        const catCount = Array.isArray(mergedData.category_corrections) ? mergedData.category_corrections.length : 0;
        const learnedCount = Array.isArray(mergedData.learned_categories) ? mergedData.learned_categories.length : 0;
        const paraCount = Array.isArray(mergedData.paragraph_breaks) ? mergedData.paragraph_breaks.length : 0;
        if (catCount > 0 || learnedCount > 0 || paraCount > 0) {
          console.log(`[project:save] Writing to manifest: ${catCount} corrections, ${learnedCount} learned, ${paraCount} paragraph breaks`);
        }

        // The sidecar first, then the manifest — the same order the migration
        // uses, and for the same reason: the manifest carries the layout stamp
        // that says which pagination the editor records above were made in, so
        // it must never land ahead of the records it vouches for.
        await writeEditorState(filePath, editorState);
        const saved = await manifestService.modifyManifest(projectId, applyEditorRecords);
        if (!saved.success) {
          return {
            success: false,
            error: `${path.basename(filePath)}'s editor state was saved, but recording it in the `
              + `project's manifest failed: ${saved.error}`,
          };
        }
        // The save SUCCEEDED — the metadata, the highlights and everything that
        // does not name a position went to disk. `staleLayoutRefusal` says what
        // did NOT, so a window can tell the user that the deletions they made in
        // this session are not on file, instead of leaving them to find out.
        return {
          success: true,
          filePath,
          staleLayoutRefusal: layoutState.refusal ?? undefined,
        };
      }

      // Every project is a manifest directory (a .bfp path could only ever be a
      // stale reference from before that format was retired). Writing this JSON
      // to a non-directory path would mint exactly the single-file project the
      // manifest layout replaced, so refuse instead of guessing.
      throw new Error(
        `Cannot save project state to "${filePath}": it is not a BookForge project ` +
        `directory. Legacy .bfp project files are no longer supported — open the ` +
        `project directory instead.`
      );
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Update just the metadata in a manifest project (for audiobook producer)
  ipcMain.handle('project:update-metadata', async (_event, projectDir: string, metadata: unknown) => {
    try {
      const meta = metadata as Record<string, unknown>;

      // Handle cover image - save to media folder if it's base64 data
      if (meta.coverData && typeof meta.coverData === 'string' && meta.coverData.startsWith('data:')) {
        const relativePath = await saveImageToMedia(meta.coverData as string, 'cover');
        meta.coverImagePath = relativePath;
        delete meta.coverData;
      }

      // Check if projectDir is a manifest project directory
      const isDir = fsSync.existsSync(projectDir) && fsSync.statSync(projectDir).isDirectory();
      if (isDir) {
        // ── THROUGH THE LOCK, both writes ───────────────────────────────────
        //
        // This handler used to read manifest.json raw, hold the object across
        // tens of seconds of EPUB and M4B rewriting, and write the WHOLE thing
        // back — twice. Anything another window recorded in that window (a chain,
        // a strike, a finished pass) was destroyed by the second write. Both
        // writes are `modifyManifest` transactions now, each mutating only the
        // keys it owns: the metadata, and the audiobook pointers a rename moved.
        const projectId = path.basename(projectDir);
        if (!sameResolvedPath(manifestService.getProjectPath(projectId), projectDir)) {
          return {
            success: false,
            error: `Cannot update ${projectDir}: it is not inside the configured library `
              + `(expected ${manifestService.getProjectPath(projectId)}), so its manifest cannot be `
              + 'located. Point the library setting at the folder that owns this project.',
          };
        }

        // Validate an explicit slug change UP FRONT so a collision fails fast
        // without half-saving. The slug (project folder name) is an internal
        // identifier — it changes ONLY when the user deliberately edits the Slug
        // field, never as a side effect of a title/author/year edit (that used to
        // move the folder mid-session and strand the open project's id, producing
        // spurious "project doesn't exist" errors on the next variant operation).
        let desiredSlug: string | undefined;
        if (typeof meta.slug === 'string' && (meta.slug as string).trim()) {
          desiredSlug = toAsciiSlug(meta.slug as string).substring(0, 150);
          if (!desiredSlug) {
            return { success: false, error: 'That slug is empty after removing unsupported characters — pick a different name.' };
          }
          const currentSlug = path.basename(projectDir);
          if (desiredSlug !== currentSlug && fsSync.existsSync(path.join(path.dirname(projectDir), desiredSlug))) {
            // Guarantee uniqueness: refuse a name already in use rather than
            // silently appending a suffix — the user chose this exact slug.
            return { success: false, error: `A project folder named "${desiredSlug}" already exists — choose a different slug.` };
          }
        }

        // Map the editor's metadata fields to manifest metadata fields.
        const savedMetadata = await manifestService.modifyManifest(projectId, (m: any) => {
          if (!m.metadata) m.metadata = {};
          if (meta.title !== undefined) m.metadata.title = meta.title;
          if (meta.author !== undefined) m.metadata.author = meta.author;
          if (meta.year !== undefined) m.metadata.year = meta.year;
          if (meta.language !== undefined) m.metadata.language = meta.language;
          if (meta.narrator !== undefined) m.metadata.narrator = meta.narrator;
          if (meta.series !== undefined) m.metadata.series = meta.series;
          if (meta.description !== undefined) m.metadata.description = meta.description;
          if (meta.contributors !== undefined) m.metadata.contributors = meta.contributors;
          if (meta.tags !== undefined) m.metadata.tags = meta.tags;
          if (meta.coverImagePath !== undefined) m.metadata.coverPath = meta.coverImagePath;

          // Output filename: the renderer sends the effective name (live-generated or
          // a manual override). Use it when provided; otherwise derive from metadata.
          if (typeof meta.outputFilename === 'string' && meta.outputFilename.trim()) {
            m.metadata.outputFilename = meta.outputFilename.trim();
          } else {
            m.metadata.outputFilename = manifestService.computeDescriptiveFilename({
              title: m.metadata.title,
              author: m.metadata.author,
              authorFileAs: m.metadata.authorFileAs,
              year: m.metadata.year,
            }, '.m4b');
          }
        });
        if (!savedMetadata.success) {
          return { success: false, error: savedMetadata.error || 'Failed to update project metadata.' };
        }

        // Read back what the transaction settled on. Everything below — which
        // EPUBs to retag, which M4B is the primary, what the desired filename is —
        // is a READ of the record that was just written, not a second copy of it
        // held across the minutes of file rewriting that follow.
        const manifest = await manifestService.readProjectManifest(projectDir) as any;

        // The export is named after the book — located by its manifest record,
        // never by a name in source/.
        const exportedEpub = (await manifestService.readExportEpub(projectDir))?.absPath;

        // Build list of all project EPUBs (used for both cover and metadata propagation)
        const epubCandidates = [
          ...(exportedEpub ? [exportedEpub] : []),
          path.join(projectDir, 'source', 'original.epub'),
          path.join(projectDir, 'stages', '01-cleanup', 'cleaned.epub'),
          path.join(projectDir, 'stages', '01-cleanup', 'simplified.epub'),
          path.join(projectDir, 'stages', '02-translate', 'translated.epub'),
        ];
        // Also scan for language EPUBs (e.g., de.epub, ko.epub) in translate dir
        const translateDir = path.join(projectDir, 'stages', '02-translate');
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

        // Cover is embedded into the PRIMARY OUTPUT ONLY — the single primary
        // source EPUB (here) and the shelf audiobook M4B (in the M4B loop below).
        // Version/pipeline EPUBs and other audiobook variants keep whatever cover
        // they were given in the per-version editor; the book-level cover is never
        // forced onto every file. The durable project cover is manifest.metadata
        // .coverPath (set above), which future renders/exports read.
        const absCoverPath = (meta.coverImagePath && typeof meta.coverImagePath === 'string')
          ? path.join(getLibraryRoot(), meta.coverImagePath as string)
          : null;
        const coverExists = !!absCoverPath && fsSync.existsSync(absCoverPath);
        const primaryEpub = [
          ...(exportedEpub ? [exportedEpub] : []),
          path.join(projectDir, 'source', 'original.epub'),
        ].find(p => fsSync.existsSync(p));

        // Per-file embed failures below are collected here and RETURNED so the
        // renderer can tell the user which files kept stale metadata/covers —
        // a console.warn alone reads as success with an old cover on disk.
        const warnings: string[] = [];
        let primaryEpubError: string | null = null;

        // Propagate metadata (title/author/year/language) to all project EPUBs,
        // and embed the cover into the PRIMARY EPUB. Each EPUB is an independent
        // ZIP rewrite; run them CONCURRENTLY (was sequential), and fold the
        // primary's cover + metadata into a SINGLE rewrite (was two).
        const hasMetadataChange = meta.title !== undefined || meta.author !== undefined
          || meta.year !== undefined || meta.language !== undefined
          || meta.contributors !== undefined;
        if (hasMetadataChange || (coverExists && primaryEpub)) {
          const { updateEpubMetadataStandalone, updateEpubCoverAndMetadata } = await import('./epub-processor.js');
          const epubMeta: Record<string, unknown> = {};
          if (meta.title !== undefined) epubMeta.title = meta.title;
          if (meta.author !== undefined) epubMeta.author = meta.author;
          if (meta.year !== undefined) epubMeta.year = meta.year;
          if (meta.language !== undefined) epubMeta.language = meta.language;
          if (meta.contributors !== undefined) epubMeta.contributors = meta.contributors;

          await Promise.all(epubCandidates
            .filter(p => fsSync.existsSync(p))
            .map(async (epubPath) => {
              const isPrimary = !!primaryEpub && epubPath === primaryEpub;
              try {
                if (isPrimary && coverExists) {
                  // One rewrite: cover + (any) metadata.
                  await updateEpubCoverAndMetadata(epubPath, epubMeta as any, absCoverPath!);
                  console.log(`[project:update-metadata] Embedded cover + metadata in primary EPUB ${path.basename(epubPath)}`);
                } else if (hasMetadataChange) {
                  await updateEpubMetadataStandalone(epubPath, epubMeta as any);
                  console.log(`[project:update-metadata] Updated EPUB metadata in ${path.basename(epubPath)}`);
                }
              } catch (epubErr) {
                console.warn(`[project:update-metadata] Failed to update EPUB ${epubPath}:`, epubErr);
                const msg = `EPUB "${path.basename(epubPath)}" was not updated: ${(epubErr as Error).message}`;
                if (isPrimary) primaryEpubError = msg;
                warnings.push(msg);
              }
            }));
        }

        // The PRIMARY EPUB is what future renders/exports read — if its
        // cover/metadata embed failed, the edit did NOT take. Fail loudly
        // instead of reporting success while the old cover persists on disk.
        if (primaryEpubError) {
          return { success: false, error: primaryEpubError };
        }

        // Update M4B metadata if output exists, and rename it to match the OUTPUT
        // FILENAME field. Every rename is recorded so the manifest can be relinked
        // below — otherwise outputs.audiobook.path / variants[].path keep pointing
        // at the old name and the library/player can no longer find the file.
        const renamedM4bPaths: Array<{ oldRel: string; newRel: string }> = [];

        // Retag/rename every M4B this project owns, resolved via the MANIFEST so an
        // archive-located audiobook (a professionally-read upload) is handled too —
        // a pure output/ scan would silently skip it. Targets = every m4b in output/
        // PLUS the manifest's primary audiobook wherever it lives (archive/ or
        // output/). Metadata/cover edits are container-level and may rewrite the
        // archive file IN PLACE (atomically, via applyMetadata); the audio content
        // is never touched and the manifest keeps pointing at the same file.
        const primaryRel = typeof manifest.outputs?.audiobook?.path === 'string'
          ? manifest.outputs.audiobook.path.replace(/\\/g, '/')
          : null;
        const m4bTargets: Array<{ abs: string; rel: string }> = [];
        const seenTargetRel = new Set<string>();
        const outputDir = path.join(projectDir, 'output');
        if (fsSync.existsSync(outputDir)) {
          try {
            for (const f of await fs.readdir(outputDir)) {
              if (!f.toLowerCase().endsWith('.m4b')) continue;
              const rel = `output/${f}`;
              m4bTargets.push({ abs: path.join(outputDir, f), rel });
              seenTargetRel.add(rel);
            }
          } catch (outputDirErr) {
            console.warn(`[project:update-metadata] Could not read output directory ${outputDir}:`, outputDirErr);
            warnings.push(`Output folder could not be read — no M4B metadata/cover was updated: ${(outputDirErr as Error).message}`);
          }
        }
        if (primaryRel && !seenTargetRel.has(primaryRel)) {
          const abs = path.join(projectDir, primaryRel.split('/').join(path.sep));
          if (fsSync.existsSync(abs)) { m4bTargets.push({ abs, rel: primaryRel }); seenTargetRel.add(primaryRel); }
        }

        if (m4bTargets.length > 0) {
          // The shelf audiobook is the primary output. Only it gets the book-level
          // cover embedded; other M4Bs keep their own. Fall back to "the only M4B"
          // when the manifest has no audiobook link.
          const primaryBasename = primaryRel
            ? path.basename(primaryRel)
            : (m4bTargets.length === 1 ? path.basename(m4bTargets[0].rel) : null);

          // The desired on-disk name comes straight from the OUTPUT FILENAME field.
          // manifest.metadata.outputFilename was normalized above (explicit override
          // or the computed descriptive name), so it is always set here.
          const desiredRaw = typeof manifest.metadata.outputFilename === 'string'
            ? manifest.metadata.outputFilename.trim()
            : '';
          const desiredFilename = desiredRaw
            ? (desiredRaw.toLowerCase().endsWith('.m4b') ? desiredRaw : `${desiredRaw}.m4b`)
            : null;
          const sanitizedDesired = desiredFilename
            ? desiredFilename.replace(/[<>:"/\\|?*]/g, '_')
            : null;

          for (const { abs, rel } of m4bTargets) {
            let m4bPath = abs;
            const fileBasename = path.basename(rel);
            const dirPrefix = rel.slice(0, rel.length - fileBasename.length); // "archive/" | "output/"

            // Apply updated metadata tags to the M4B, and embed the cover into the
            // primary output only (so a cover-only change still reaches the shelf
            // audiobook, but never the other variants).
            const embedCoverHere = coverExists && primaryBasename === fileBasename;
            if (hasMetadataChange || meta.narrator !== undefined || meta.series !== undefined || embedCoverHere) {
              try {
                const m4bMeta: Record<string, unknown> = {};
                if (meta.title !== undefined) m4bMeta.title = meta.title;
                if (meta.author !== undefined) m4bMeta.author = meta.author;
                if (meta.year !== undefined) m4bMeta.year = meta.year;
                if (meta.narrator !== undefined) m4bMeta.narrator = meta.narrator;
                if (meta.series !== undefined) m4bMeta.series = meta.series;
                if (meta.contributors !== undefined) m4bMeta.contributors = meta.contributors;
                if (embedCoverHere) m4bMeta.coverPath = absCoverPath;
                // applyMetadata rewrites atomically (temp + rename over the file); an
                // EBUSY/EPERM on the Syncthing-synced drive throws and is surfaced as
                // a warning rather than corrupting the file in place.
                await applyMetadata(m4bPath, m4bMeta as any);
                console.log(`[project:update-metadata] Updated M4B metadata in ${rel}${embedCoverHere ? ' (+cover)' : ''}`);
              } catch (m4bErr) {
                console.warn(`[project:update-metadata] Failed to update M4B metadata in ${rel}:`, m4bErr);
                warnings.push(`M4B "${fileBasename}" was not updated${embedCoverHere ? ' (cover not embedded)' : ''}: ${(m4bErr as Error).message}`);
              }
            }

            // Rename the M4B to match the OUTPUT FILENAME field — WITHIN its own
            // folder. This is a content-preserving rename, so archive files may be
            // renamed (only the metadata-derived filename changes).
            if (sanitizedDesired && sanitizedDesired !== fileBasename) {
              const newM4bPath = path.join(path.dirname(m4bPath), sanitizedDesired);
              try {
                await fs.rename(m4bPath, newM4bPath);
                renamedM4bPaths.push({ oldRel: rel, newRel: `${dirPrefix}${sanitizedDesired}` });
                m4bPath = newM4bPath;
                console.log(`[project:update-metadata] Renamed M4B: ${rel} → ${dirPrefix}${sanitizedDesired}`);
              } catch (renameErr) {
                console.warn(`[project:update-metadata] Failed to rename M4B:`, renameErr);
                warnings.push(`M4B "${fileBasename}" could not be renamed to "${sanitizedDesired}": ${(renameErr as Error).message}`);
              }
            }
          }
        }

        // Relink the manifest to the renamed M4B(s). The library reads
        // outputs.audiobook.path and each audiobook variant's path as the on-disk
        // pointer; leaving them on the old name orphans the audiobook. Re-persist
        // before any project-folder rename below moves the manifest file.
        if (renamedM4bPaths.length > 0) {
          const relinked = await manifestService.modifyManifest(projectId, (m: any) => {
            for (const { oldRel, newRel } of renamedM4bPaths) {
              if (m.outputs?.audiobook?.path === oldRel) {
                m.outputs.audiobook.path = newRel;
              }
              if (Array.isArray(m.variants)) {
                for (const v of m.variants) {
                  if (v.path === oldRel) v.path = newRel;
                }
              }
            }
          });
          if (!relinked.success) {
            // The files ARE renamed and the manifest still names the old paths —
            // said out loud rather than reported as a clean success, because the
            // audiobook is unreachable until somebody knows.
            warnings.push(
              `The audiobook file(s) were renamed, but re-pointing the project at the new `
              + `name(s) failed: ${relinked.error}. The audiobook will not be found until this is `
              + 'fixed.');
          }
        }

        // Rename the project folder ONLY when the user explicitly changed the slug
        // (validated for emptiness + collision up front). Title/author/year edits
        // no longer move the folder.
        let newProjectDir: string | undefined;
        if (desiredSlug && desiredSlug !== path.basename(projectDir)) {
          const { renameProjectFolder } = await import('./manifest-service.js');
          newProjectDir = await renameProjectFolder(projectDir, desiredSlug);
          console.log(`[project:update-metadata] Renamed project folder → ${path.basename(newProjectDir)}`);
        }

        // Invalidate bookshelf server cache so changes appear immediately
        const projectSlug = path.basename(newProjectDir || projectDir);
        bookshelfServer.invalidateCache(projectSlug);

        // Report the effective (library-relative) cover path back to the renderer.
        // A newly saved cover lands in media/ under a fresh content-hashed name, so
        // without this the renderer's StudioItem keeps its OLD coverRelPath — or
        // none at all for a book that had no cover — and the editor's full-res
        // loader, which keys off coverRelPath, blanks the preview the user just set.
        return {
          success: true,
          newProjectDir,
          coverPath: manifest.metadata.coverPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      return {
        success: false,
        error: `${projectDir} is not a BookForge project directory (no manifest.json). Open the project's folder, not a file.`,
      };
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

  // Open a picker for adding a book VERSION (variant): a finished audiobook OR
  // an ebook in any of the formats the pipeline can ingest (native + Calibre).
  ipcMain.handle('dialog:open-version', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const { ebookConvertBridge } = await import('./ebook-convert-bridge.js');
    const calibreAvailable = await ebookConvertBridge.isAvailable();
    const ebookExts = calibreAvailable
      ? ['pdf', 'epub', 'jwpub', 'azw3', 'azw', 'mobi', 'kfx', 'prc', 'fb2', 'docx', 'odt', 'rtf', 'txt', 'html', 'htm']
      : ['pdf', 'epub', 'jwpub'];

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a version',
      filters: [
        { name: 'Audiobooks & Ebooks', extensions: [...ebookExts, 'm4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'opus', 'wma', 'aiff', 'aif'] },
        { name: 'Audiobooks', extensions: ['m4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'opus', 'wma', 'aiff', 'aif'] },
        { name: 'Ebooks', extensions: ebookExts },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, filePaths: result.filePaths };
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

  // Live TTS: the rendered WAV bytes live in the renderer (assembled from the
  // streamed PCM chunks), so this handler both prompts for a location AND writes
  // the file — unlike save-text/save-m4b, which only return a chosen path.
  ipcMain.handle('dialog:save-wav', async (_event, bytesBase64: string, defaultName?: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save WAV',
      defaultPath: defaultName || 'live-tts.wav',
      filters: [
        { name: 'WAV Audio', extensions: ['wav'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    try {
      await fs.writeFile(result.filePath, Buffer.from(bytesBase64, 'base64'));
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Export = give the user a copy of a file, somewhere they chose.
   *
   * The EPUB export (`epub:export-book`) is not a copy: it re-packages the book
   * with the project's metadata and cover, which is only a meaningful act on an
   * EPUB. Every other document the versions page lists is a PDF — the archive
   * original and the working copy — and the honest export of a PDF is its bytes,
   * unchanged. That is the same act `exportM4b` already performs (a save dialog
   * and `fs.copyFile`); it is one handler here rather than two renderer calls so
   * there is no half-done state between choosing a location and writing to it.
   *
   * The source extension drives the filter, so the dialog offers the file's own
   * kind. There is no default extension: a file whose type we cannot name is
   * offered as All Files rather than silently saved as something it is not.
   *
   * archive/ is READ here. Nothing writes into it — `result.filePath` is a
   * location the user picked in a native dialog, and the copy goes there.
   */
  ipcMain.handle('dialog:save-file-copy', async (_event, sourcePath: string, defaultName?: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };
    const source = normalizeFsPath(sourcePath);
    if (!fsSync.existsSync(source)) {
      return {
        success: false,
        error: `There is nothing to export: ${source} is not on disk. It may have been moved, `
          + 'deleted, or not yet synced to this machine.',
      };
    }
    const ext = path.extname(defaultName || source).replace('.', '').toLowerCase();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export a copy',
      defaultPath: defaultName || path.basename(source),
      filters: ext
        ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }]
        : [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    try {
      await fs.copyFile(source, result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('audiobook:copy-to-path', async (_event, source: string, dest: string) => {
    try {
      await fs.copyFile(source, dest);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // The native `dialog:confirm` / `dialog:message` boxes are GONE (Aug 2026).
  // Every confirm and every one-button message in the app renders the in-app
  // DesktopDialogComponent through DialogService, so there is one look for the
  // whole vocabulary; ElectronService.showConfirmDialog/showMessageDialog were
  // routed there and these two handlers had no caller left. File-choosing
  // dialogs above are untouched — those must be the OS's.

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
    // Stop the streaming engines first so the bundled env isn't locked.
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      await xttsWorkerPool.endSession();
      const { orpheusWorkerPool } = await import('./orpheus-worker-pool.js');
      await orpheusWorkerPool.endSession();
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
    // Scaffold the drop-in audiobooks/ folder so its .m4b files surface in the
    // Bookshelf by default — created the moment a library is pointed to, no UI step.
    if (libraryPath) {
      try {
        await fs.mkdir(path.join(libraryPath, 'audiobooks'), { recursive: true });
      } catch (err) {
        console.error('[library:set-root] Failed to create audiobooks/ folder:', err);
      }
    }
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

  // Save base64 image to media folder, return relative path. The implementation
  // lives in library-actions so the headless CLI writes covers to exactly the
  // same content-hashed filenames the app does.
  const saveImageToMedia = (base64Data: string, prefix: string = 'cover'): Promise<string> =>
    saveImageToMediaShared(base64Data, prefix);

  // Resize a media image to `maxWidth` (JPEG) via sharp (libvips, in-process — no
  // per-image subprocess spawn), caching the result in the machine-local thumbnail
  // cache (alongside the render cache, NOT in the synced library). Returns the
  // absolute path to the cached JPEG. No silent fallback to full-res: if the resize
  // fails the error propagates to the caller. `withoutEnlargement` mirrors the old
  // ffmpeg `min(maxWidth,iw)` behaviour — never upscale a smaller source.
  const getThumbnailCacheDir = () => path.join(getRenderCacheBaseDir(), 'thumbnails');
  const resizeToThumbnail = async (sourcePath: string, maxWidth: number): Promise<string> => {
    const srcStat = await fs.stat(sourcePath);
    const cacheDir = getThumbnailCacheDir();
    await fs.mkdir(cacheDir, { recursive: true });
    // Cover filenames in media/ are content-hashed, so name+width is a stable key;
    // the mtime check re-generates if a same-named source is ever replaced.
    const cachePath = path.join(cacheDir, `${path.parse(sourcePath).name}-w${maxWidth}.jpg`);
    try {
      const cacheStat = await fs.stat(cachePath);
      if (cacheStat.mtimeMs >= srcStat.mtimeMs) return cachePath;
    } catch { /* not cached yet */ }

    const sharp = require('sharp');
    await sharp(sourcePath)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(cachePath);
    return cachePath;
  };

  // Load image from media folder, return base64 data URL. When `maxWidth` is given
  // the image is resized to that width (JPEG) and served from the thumbnail cache —
  // the Studio list/grid use this so full-resolution covers never sit in renderer
  // memory. The metadata editor omits maxWidth to get the full-res cover for its
  // preview (and to avoid downsizing the stored cover on save).
  const loadImageFromMedia = async (relativePath: string, maxWidth?: number): Promise<string | null> => {
    const fullPath = path.join(getLibraryRoot(), relativePath);
    if (maxWidth) {
      // Resize failures must surface loudly — never silently serve full-res.
      let thumbPath: string;
      try {
        thumbPath = await resizeToThumbnail(fullPath, maxWidth);
      } catch (err) {
        console.error(`[media] Thumbnail resize failed for ${relativePath} @${maxWidth}px:`, err);
        throw err;
      }
      const data = await fs.readFile(thumbPath);
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    }
    try {
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
      // Convention: drop-in folder whose .m4b files surface in the Bookshelf.
      await fs.mkdir(path.join(getLibraryRoot(), 'audiobooks'), { recursive: true });
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
   * Handles projects synced between Mac and Windows (e.g., via Syncthing).
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
  // Used by the renderer when a stored path came from another OS (e.g., a Mac path on Windows)
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


  // Resolve an EXISTING manifest project directory for a just-loaded source file.
  // The editor's auto-project-creation used to scan only legacy .bfp *files*
  // (projects:list), so a freshly-imported MANIFEST project (a directory) was
  // invisible — the editor then minted a phantom .bfp sibling and bound to it,
  // which broke the manifest pipeline (the project's export). This lets the editor
  // find the real project directory by content hash (primary) or original filename.
  ipcMain.handle('projects:find-manifest-by-source', async (
    _event,
    fileHash: string | undefined,
    sourcePath: string | undefined,
  ) => {
    try {
      // Directory containment is the strongest signal: any file loaded from
      // INSIDE a project (archive/*, source/*, stages/*, …) belongs to
      // that project. This also keeps review / paragraph-fix reloads of a DERIVED
      // epub bound to their project instead of spawning a new one.
      if (sourcePath) {
        const projectsRoot = manifestService.getProjectsPath();
        const rel = path.relative(projectsRoot, sourcePath);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          const slug = rel.split(/[\\/]/)[0];
          if (slug) {
            const dir = manifestService.getProjectPath(slug);
            if (fsSync.existsSync(path.join(dir, 'manifest.json'))) {
              return { found: true, projectPath: dir };
            }
          }
        }
      }

      // ── "COULD NOT LOOK" IS NOT "NOT FOUND" ────────────────────────────────
      //
      // The caller's next move on `found: false` is to MINT A PROJECT for this
      // file. A listing that failed — an unmounted library drive, a permissions
      // error — answered exactly the same way, so an offline drive produced a
      // duplicate project for a book the library already had, and the two only
      // met again when the drive came back. The two are distinguished, in the
      // spirit of `fs:list-directory`'s no-catch doctrine.
      const result = await manifestService.listProjects();
      if (!result.success) {
        return {
          found: false,
          error: `The library could not be read, so BookForge cannot say whether this file already `
            + `belongs to a project: ${result.error ?? 'no reason given'}. Nothing was imported.`,
          searchFailed: true,
        };
      }
      if (!result.projects) return { found: false };

      // Content hash is authoritative — match it across ALL projects first so a
      // weaker filename coincidence on some other project can't win.
      if (fileHash) {
        const byHash = result.projects.find(m => m.source?.fileHash === fileHash);
        if (byHash) return { found: true, projectPath: manifestService.getProjectPath(byHash.projectId) };
      }

      // Fallback: original filename (for older manifests written without a hash).
      const sourceBase = sourcePath ? path.basename(sourcePath) : '';
      if (sourceBase) {
        const byName = result.projects.find(m => m.source?.originalFilename === sourceBase);
        if (byName) return { found: true, projectPath: manifestService.getProjectPath(byName.projectId) };
      }

      return { found: false };
    } catch (err) {
      // Same distinction as the listing refusal above: this threw, so nothing
      // here can say the file has no project — only that the question was not
      // answered.
      return { found: false, error: (err as Error).message, searchFailed: true };
    }
  });




  // Load project from specific path - auto-imports to library if external
  ipcMain.handle('projects:load-from-path', async (event, filePath: string) => {
    try {
      // Check if filePath is a manifest project directory
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        // ── The layout the saved records belong to, settled BEFORE they are
        //    read ──────────────────────────────────────────────────────────
        //
        // `deleted_pages` and `deleted_block_ids` are positions in a
        // PAGINATION, and for EPUBs that pagination changed in August 2026
        // (mupdf's reflow → quire, 218 pages → 183 on Killing America). Handing
        // the old numbers to a window showing the new layout paints strikes
        // across paragraphs the user never touched — silently, in a book they
        // have no reason to re-read.
        //
        // So the records are carried across FIRST, once, through the layout
        // they were written in (electron/legacy-epub-layout.ts), and the
        // manifest is read afterwards. A project already stamped with this
        // build's layout, or made from a PDF, returns after one manifest read
        // and nothing below changes for it.
        let staleLayoutRefusal: string | null = null;
        let layoutMigrationNotice: string | null = null;
        try {
          // The window asking is the one told. This is the app's existing
          // document-analysis progress channel and the picker is already
          // listening on it around this call — a migration IS two analyses of
          // the book, so it reports where analyses report rather than opening a
          // second channel that says the same kind of thing.
          const carried = await migrateLegacyEpubEditorRecords(filePath, (message) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('pdf:analyze-progress', { phase: 'extracting', message });
            }
          });
          if (carried.kind === 'migrated') {
            layoutMigrationNotice = carried.message;
            console.warn(`[projects:load] ${carried.message}`);
          } else if (carried.kind === 'refused') {
            staleLayoutRefusal = carried.message;
            // The dialog gets the short sentence; the full reasoning is the
            // log's (Owen, 2026-08-10: "warnings and errors should be short").
            console.warn(`[projects:load] ${carried.message}${carried.detail ? `\n${carried.detail}` : ''}`);
          }
        } catch (err) {
          // The migration itself failed — mupdf ran out of memory, the book is
          // unreadable, the project is not in this library. That is a reason to
          // WITHHOLD the records, not to refuse to open the project: the file
          // on disk is untouched either way, and a book nobody can open is a
          // worse answer than a book whose old edits are not shown.
          staleLayoutRefusal =
            `${path.basename(filePath)}'s saved deletions could not be carried into this build's `
            + `layout: ${(err as Error).message}. They are not applied, and nothing was changed.`;
          console.warn(`[projects:load] ${staleLayoutRefusal}`);
        }

        // ── The elements, given their IDENTITIES, before anything writes ────
        //
        // First, because an element's id has to exist before anything edits the
        // element, and the naming pass immediately below is the first thing that
        // does. Idempotent: a book already stamped writes no byte and says
        // nothing. NOT inside the try above, for the same reason the naming pass
        // is not — a refusal fails the open with its own sentence rather than
        // handing the window a book whose identity is half written.
        const { stampElementIds } = await import('./narration-export.js');
        const stamped = await stampElementIds(filePath);
        if (stamped.stamped > 0) {
          console.log(
            `[projects:load] ${path.basename(filePath)}: ${stamped.stamped} of ${stamped.total} `
            + 'element(s) now carry a stable id.'
          );
        }

        // ── The chapter openings, NAMED, before anything reads the book ─────
        //
        // Owen, 2026-08-09: "from the moment the book opens, the chapter
        // openers contain the chapter's text. period. the user will delete
        // surrounding blocks if they're unnecessary." So it happens HERE — after
        // the layout migration, before the manifest is read and before the
        // window is handed a single page — and the analysis, the viewer, the
        // aligner and the narration cut only ever see the normalized file.
        //
        // ── A NAMING PASS IS PER CHAIN, so it asks which ────────────────────
        //
        // `nameChapterOpenings` resolves through the act chokepoint, and a
        // project with two working chains refuses to be asked without an id —
        // correctly, because "the project's book" then names two files. But
        // OPENING a project is not an act on one book: this call ran with no id
        // and the refusal came out as "Failed to open project — … has 2 working
        // chains…", so the multi-version feature made every project it created
        // impossible to open (found 2026-08-10). A pass over a project is
        // per-chain or it is skipped; it is never "the" chain. `soleFamily` is
        // that rule, and it is the same shape `listen:list-sources` uses.
        //
        // ── AND A DECLINED NAMING DOES NOT FAIL THE OPEN ────────────────────
        //
        // The pass refuses to rewrite an opening while the narration strikes
        // recorded against this book cannot be carried onto the edit — a void
        // record, which a machine-to-machine sync or an interrupted rename can
        // produce with no user action at all. Thrown from here that refusal shut
        // the project for good, because the only door to clearing those strikes
        // is opening it. So it joins `stale_layout_refusal` on the withheld-
        // notice channel, under this handler's own rule (below): the file on
        // disk is untouched either way — the pass writes a staged copy and moves
        // it into place, so a refusal leaves the book exactly as it was — and a
        // book nobody can open is a worse answer than a book whose openings
        // still print the publisher's headings.
        let chapterNamingNotice: string | null = null;
        const chains = await manifestService.readBookFamilies(filePath);
        const soleChain = soleFamily(chains);
        if (soleChain === null && chains.length > 1) {
          chapterNamingNotice =
            `${path.basename(filePath)} has ${chains.length} working chains, so the passes that `
            + 'normalize a book at open (element ids, chapter-opening names) were not run — they '
            + 'would have to be told which version. Run them from the version you mean.';
          console.warn(`[projects:load] ${chapterNamingNotice}`);
        } else {
          try {
            const { nameChapterOpenings, stampElementIds } = await import('./narration-export.js');
            // The ELEMENT-ID STAMP runs FIRST, per chain like the naming below —
            // it resolves the same book, and a multi-chain project skips both
            // above. Its failure joins the same withheld-notice channel: identity
            // is plumbing, and an unstampable book still opens — every act that
            // NEEDS ids refuses downstream in its own words.
            const stamped = await stampElementIds(
              filePath, soleChain === null ? undefined : soleChain.id);
            if (stamped.stamped > 0) {
              console.log(
                `[projects:load] ${path.basename(filePath)}: ${stamped.stamped} of `
                + `${stamped.total} element(s) given their data-bf-uid`
                + (stamped.wrappersPersisted > 0
                  ? `; ${stamped.wrappersPersisted} wrapper(s) persisted` : '') + '.');
            }
            const named = await nameChapterOpenings(
              filePath, soleChain === null ? undefined : soleChain.id);
            if (named.edited > 0) {
              console.log(
                `[projects:load] ${path.basename(filePath)}: ${named.edited} chapter opening(s) now `
                + 'read the name the book stores for their chapter.'
              );
            }
          } catch (err) {
            chapterNamingNotice =
              `${path.basename(filePath)}'s chapter openings were not rewritten to print their `
              + `stored names: ${(err as Error).message}`;
            console.warn(`[projects:load] ${chapterNamingNotice}`);
          }
        }

        // Read manifest.json and convert it to the editor's project shape
        const manifestPath = path.join(filePath, 'manifest.json');
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        const meta = manifest.metadata || {};
        const source = manifest.source || {};

        // Find the source file the editor should open. Priority:
        //   finalized.* / original.* in source/  (legacy layouts, truly originals)
        //   > the PRIMARY archive variant        (where the pristine book lives)
        //   > the project's own export           (a DERIVED OUTPUT, last resort)
        //
        // The export must never outrank the archive variant: it is the editor's
        // own product, not the document the saved edits were made against. When
        // it did (the old scan took any source/ file first, and original.* no
        // longer exists there), a PDF project that had just been exported
        // reopened ON its fresh export with the PDF session's blocks,
        // deletions and chapter marks painted over the reflowed pages
        // (Working Towards The Führer, Aug 2 2026).
        //
        // The export is named after the book, so it is located by its manifest
        // record — never by scanning source/ for a name. No record means the
        // project has no export; an unrecorded source/exported.epub from an
        // older layout is a stray file and is not adopted.
        const sourceDir = path.join(filePath, 'source');
        let sourcePath = '';
        try {
          const sourceFiles = await fs.readdir(sourceDir);
          const finalized = sourceFiles.find(f => f.startsWith('finalized.'));
          const original = sourceFiles.find(f => f.startsWith('original.'));
          const best = finalized || original;
          if (best) {
            sourcePath = path.join(sourceDir, best);
          }
        } catch { /* source dir doesn't exist */ }

        const exportRecord = await manifestService.readExportEpub(filePath);
        const exportedEpubPath = exportRecord && fsSync.existsSync(exportRecord.absPath)
          ? exportRecord.absPath
          : '';

        // There is no longer a source/original.* copy — the pristine ebook lives
        // in archive/ as a book variant, and "Open" loads the PRIMARY variant.
        // Resolve it via getVariants (honors manifest.primaryVariantId, else the
        // original ebook). Prefer the primary if it's an ebook; otherwise the
        // first ebook variant. See import-epub-project.ts + getVariants().
        if (!sourcePath) {
          const { variants, primaryVariantId } = manifestService.getVariants(manifest);
          const primary = variants.find(v => v.id === primaryVariantId);
          const chosen = (primary && primary.kind === 'ebook')
            ? primary
            : variants.find(v => v.kind === 'ebook');
          if (chosen?.path) {
            const variantPath = path.join(filePath, chosen.path);
            if (fsSync.existsSync(variantPath)) {
              sourcePath = variantPath;
            }
          }
        }

        // Only a project with no original anywhere opens its own export.
        if (!sourcePath && exportedEpubPath) {
          sourcePath = exportedEpubPath;
        }

        // Convert manifest to BookForgeProject format expected by the editor.
        //
        // The editor state comes from its sidecar (electron/editor-state-store.ts),
        // migrated on contact. An empty object is the honest reading of "this
        // project has never been edited" — it is not standing in for a value
        // that should have been there.
        const editor = (await readEditorState(filePath) ?? {}) as Record<string, any>;

        // ── What a stale layout costs the payload ──────────────────────────
        //
        // When the records could NOT be carried across, every field below that
        // names a page or a block id is withheld — not corrected, not
        // approximated, withheld — and `stale_layout_refusal` says so in words
        // the window can put on screen. Withholding is the whole safety
        // property: a picker handed `deleted_pages: [140, …]` from a
        // 218-page layout has no way to know those numbers are about a
        // different book-shape, and it will draw them.
        //
        // Nothing is deleted from the manifest. The records stay exactly as
        // they are, and the save handler refuses to overwrite them from a
        // window that was never given them (`project:save-to-path`).
        const stale = staleLayoutRefusal !== null;
        const withheld = <T>(value: T, empty: T): T => (stale ? empty : value);

        const data: Record<string, any> = {
          version: manifest.version || 2,
          source_path: sourcePath,
          // The project's own export, ABSOLUTE and resolved, or '' when it has
          // never exported. The renderer decides "is this document the project's
          // own export?" by comparing against this — the filename carries no such
          // signal any more (it is the book's title).
          exported_epub_path: exportedEpubPath,
          source_name: source.originalFilename || path.basename(sourcePath),
          library_path: sourcePath,
          file_hash: source.fileHash || '',
          deleted_block_ids: withheld(source.deletedBlockIds || [], []),
          deleted_block_lines: source.deletedBlockLines || undefined,
          foundry_auto_discarded_lines: source.foundryAutoDiscardedLines || undefined,
          deleted_highlight_ids: source.deletedHighlightIds || [],
          page_order: withheld(source.pageOrder || [], []),
          deleted_pages: withheld(source.deletedPages || [], []),
          remove_backgrounds: source.removeBackgrounds || false,
          undo_stack: withheld(editor.undoStack || [], []),
          redo_stack: withheld(editor.redoStack || [], []),
          // Keyed by block id like everything the two stacks name, so it is
          // withheld with them: a block table from another layout would resolve
          // ids that mean something else here.
          history_blocks: withheld(editor.historyBlocks || undefined, undefined),
          block_edits: withheld(editor.blockEdits || undefined, undefined),
          custom_categories: withheld(editor.customCategories || undefined, undefined),
          ocr_blocks: withheld(editor.ocrBlocks || undefined, undefined),
          manual_blocks: withheld(editor.manualBlocks || undefined, undefined),
          // Keyed by CATEGORY id ("title", "caption"), not by block — it names
          // no position in a layout and survives a change of paginator intact.
          ocr_categories: editor.ocrCategories || undefined,
          category_corrections: withheld(editor.categoryCorrections || undefined, undefined),
          learned_categories: withheld(editor.learnedCategories || undefined, undefined),
          paragraph_breaks: withheld(editor.paragraphBreaks || undefined, undefined),
          // Round-trip counterparts of the save handler above. Absent on old
          // manifests → undefined → the renderer restores exactly as before.
          block_splits: withheld(editor.blockSplits || undefined, undefined),
          block_merges: withheld(editor.blockMerges || undefined, undefined),
          crop_regions: withheld(editor.cropRegions || undefined, undefined),
          // Tuning numbers and a file digest — neither names a position.
          classification_thresholds: editor.classificationThresholds || undefined,
          text_corrections: withheld(editor.textCorrections || undefined, undefined),
          source_file_sha256: editor.sourceFileSha256 || undefined,
          // The picker's chapter markers carry a `page` (and mostly no
          // `blockId`), so they are positions in the layout too. A `toc`-sourced
          // marker re-reads itself from the book when the window detects
          // chapters, so withholding them costs nothing that is derived.
          chapters: withheld(manifest.chapters || [], []),
          chapters_source: manifest.chaptersSource || 'manual',
          /**
           * Why this project's saved page and block records were not loaded,
           * or absent when they were. A window that gets this MUST say it —
           * see the picker TODO in the Phase C report; until it does, the
           * sentence is in the main-process log.
           */
          stale_layout_refusal: staleLayoutRefusal ?? undefined,
          /** What a one-time carry-over of those records came to, when one ran. */
          layout_migration_notice: layoutMigrationNotice ?? undefined,
          /**
           * Why this book's chapter openings still print what they printed, when
           * the normalization every open performs was declined or skipped. Same
           * channel and same rule as `stale_layout_refusal`: nothing was changed,
           * the project opened, and the sentence is owed to whoever can say it.
           */
          chapter_naming_notice: chapterNamingNotice ?? undefined,
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

      // Not a directory with a manifest: refuse rather than guess. A caller
      // holding a document path must open it as a document, not a project.
      return {
        success: false,
        error: `${filePath} is not a BookForge project directory (no manifest.json). Open the project's folder, not a file.`,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Everything the renderer may need to know about a project's export EPUB:
  // where the NEXT one must be written (`target`), where the existing one IS
  // (`exported`, null when it has never exported), and the cover to embed.
  //
  // The renderer asks rather than composing a path: the name comes from the
  // manifest (the book's title) and the cover from the library root, neither of
  // which the renderer is the authority on. A project with no cover answers
  // coverPath null — that is an ordinary book, not an error.
  /**
   * `familyId` names WHICH working chain the picker is opening.
   *
   * The picker arrives here from a row on the versions page, which knows the
   * chain it drew (`editor:get-versions` puts the id on it). Absent is the
   * ordinary case and means the project's only chain; a project with several
   * refuses rather than opening whichever book it reached first — which would
   * put the user's edits into a version they were not looking at.
   */
  ipcMain.handle('projects:export-info', async (
    _event,
    projectDir: string,
    familyId?: string
  ) => {
    try {
      // ── The working copy is made here, invisibly, because this is where the
      // book is asked for ──────────────────────────────────────────────────────
      //
      // Owen's model, 2026-08-08: "the user should just know 'I'm editing the
      // book Killing America'… one working copy per archive file… fully
      // seamless." So the two acts that used to need a button are done as the
      // picker opens:
      //
      //  1. A book named before the `<archive basename>.working.epub` convention
      //     is renamed onto it and the manifest repointed, so every project
      //     declares which archive file it is the copy of.
      //  2. A project that has an archive-grade book and no working copy yet
      //     gets one — an instant byte copy. Its narration strikes and its
      //     editor deletions come with it for free, because the copy IS those
      //     bytes: the strikes are stamped with the sha256 the copy also has,
      //     and the block ids are minted from the laid-out content.
      //
      // BOTH origins get (2) now. An EPUB-native project is copied from the file
      // the user handed us; a PDF-origin one from the book a page reader cast out
      // of it, which is kept as its own archive-grade file
      // (`ensureGeneratedEpub` gives that book to the projects that predate it).
      // A PDF whose pages have NEVER been read still gets nothing, and that is
      // the same rule as before: casting one costs an hour of GPU and is never a
      // side effect of opening a window. The picker shows the archive with a
      // banner offering to start it.
      //
      // A copy made AGAIN is not invisible, and it is not silent about what it
      // cost. `ensureBookEpub` CLEARS every record made against the copy that is
      // gone — Owen's model, 2026-08-09: "if i delete the working copy, all of
      // its deletions and changes should go with it" — and answers with the
      // counts of what went. That answer travels back with the path: this is the
      // call the picker makes as the project opens, so it is the one place a
      // window is looking when the fact is discovered. Nobody downstream
      // re-derives it; there is nothing left to derive it from.
      let remint: WorkingCopyRemint | null = null;
      const adoption = await manifestService.ensureGeneratedEpub(projectDir);
      if (adoption.missing !== null) console.warn(`[projects:export-info] ${adoption.missing}`);
      // WHICH chain this ask is about — through the LISTING resolver, first: a
      // bare PDF has no chain yet, and opening it to scan its pages is not an
      // act on a book. Null here means every chain-scoped step below is skipped
      // and the answer carries no familyId — the honest shape of a project that
      // has pages and nothing else (found live 2026-08-10: "Could not open this
      // book … has no working chain yet" on a project whose PDF opens fine).
      // A caller that NAMES a familyId still gets the refusal for a chain that
      // is not there.
      const resolvedChain = await manifestService.familyForListing(projectDir, familyId);
      if (resolvedChain !== null) await manifestService.migrateWorkingEpubNaming(projectDir, familyId);
      const recordedBefore = await manifestService.readExportEpub(projectDir, familyId);
      if (!recordedBefore || !fsSync.existsSync(recordedBefore.absPath)) {
        // Asked as "is there something to copy", not as "did it work": a project
        // with nothing archive-grade behind it is an ordinary state here (a PDF
        // nobody has converted), and minting is simply not one of the things
        // opening it does.
        if (await manifestService.workingCopySource(projectDir) !== null) {
          remint = (await manifestService.ensureBookEpub(projectDir, familyId)).remint;
          await nameOpeningsOfRemintedCopy(projectDir, remint, familyId);
        }
      }

      // Null when the project has no chain: a book that cannot exist yet has no
      // place it must be written to, and inventing one would derive a name from
      // a source the project does not record.
      const target = resolvedChain === null
        ? null
        : await manifestService.exportEpubTarget(projectDir, familyId);
      const record = await manifestService.readExportEpub(projectDir, familyId);
      const exported = record && fsSync.existsSync(record.absPath) ? record : null;
      // The book cast from this project's pages, when it has one ON DISK. The
      // picker needs it to tell that artifact apart from the archive original:
      // both are read-only, and they are read-only for different reasons that a
      // user is owed in different words.
      const generatedRecord = await manifestService.readGeneratedEpub(projectDir);
      const generated = generatedRecord && fsSync.existsSync(generatedRecord.absPath)
        ? generatedRecord
        : null;
      // The file the user handed us, so the picker can RECOGNISE it. Opening a
      // project's archive original now lands on the working copy instead
      // (shared/document/artifact-open.ts), and the window cannot decide which
      // file that is by looking at its name — the manifest is where an
      // artifact's identity is settled, and this is the seam that carries it.
      // Same existence rule as the two above: a record naming a file that is not
      // there describes an original that has been moved away, and nothing should
      // be redirected on the strength of it.
      const archiveRecord = await manifestService.readArchiveOriginal(projectDir);
      const archive = archiveRecord && fsSync.existsSync(archiveRecord.absPath)
        ? archiveRecord
        : null;
      const coverPath = await manifestService.resolveProjectCover(projectDir);
      // What has been done to that book travels with where it is: the picker's
      // rail lights its pass entries from this, and asking twice — once for the
      // path, once for the provenance — is how two surfaces come to disagree
      // about the same book.
      const appliedPasses = await manifestService.readAppliedPasses(projectDir, familyId);
      // WHICH chain everything above is about, handed back so the window that
      // opened can quote it in every act it performs afterwards rather than
      // asking again and possibly being answered about a different version.
      // Null for a project with no chain yet — there is nothing to quote, and
      // every act that needs one refuses downstream in its own words.
      return {
        success: true, target, exported, generated, archive, coverPath, appliedPasses, remint,
        familyId: resolvedChain === null ? null : resolvedChain.family.id,
      };
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

  // Classify what the editor was pointed at.
  //
  // The editor can be opened two ways: `editor:open-window-with-bfp` passes a
  // PROJECT DIRECTORY, while `editor:open-window` passes a plain FILE. The
  // renderer cannot stat, so it cannot tell them apart, and assuming a directory
  // made "Open" on a loose file fail with "Project not found: <filename>".
  //
  // Walking up to the owning manifest.json is deterministic, not a guess: opening
  // `<project>/archive/Book.epub` resolves to `<project>`, so the file still gets
  // the full project treatment (its remembered selection, its export EPUB).
  //
  // Every path in the reply is ABSOLUTE and built with path.join, so the renderer
  // never does path arithmetic. It cannot: manifest entries are relative and use
  // forward slashes ("archive/Book.epub"), so string-concatenating them in the
  // renderer yields mixed separators on Windows and would not survive a move to
  // macOS. Resolution belongs on this side, once.
  ipcMain.handle('editor:classify-source', async (_event, rawPath: string) => {
    try {
      const target = normalizeFsPath(rawPath);
      const stat = await fs.stat(target);
      let dir = stat.isDirectory() ? target : path.dirname(target);

      // Bounded so a path outside the library cannot walk to the filesystem root.
      let projectDir: string | null = null;
      for (let hop = 0; hop < 6; hop++) {
        if (fsSync.existsSync(path.join(dir, 'manifest.json'))) { projectDir = dir; break; }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }

      if (!projectDir) {
        return { success: true, kind: 'loose' as const };
      }

      const manifest = JSON.parse(await fs.readFile(path.join(projectDir, 'manifest.json'), 'utf-8'));
      const original = (manifest.archive ?? []).find(
        (a: { role?: string; format?: string; path?: string }) =>
          a.role === 'original' && /epub/i.test(a.format ?? '') && a.path,
      );

      return {
        success: true,
        kind: 'project' as const,
        projectDir,
        projectId: path.basename(projectDir),
        sourceType: manifest.source?.type ?? null,
        // Manifest paths are relative and slash-separated; path.join normalizes
        // both for the host platform.
        archiveEpubPath: original ? path.join(projectDir, ...original.path.split('/')) : null,
      };
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

  // Markup-preserving EPUB export.
  //
  // The EPUB-source counterpart of 'audiobook:export-from-project'. That handler
  // takes a zip the RENDERER built out of plain text; this one takes the edit set
  // and lets the main process rewrite the book's own XHTML, so <sup>, <em>,
  // headings and lists survive. There is deliberately no mergeEpubParagraphs
  // call: paragraph fragmentation is a PDF artifact, and the source EPUB's own
  // paragraphs are authoritative here.
  //
  // Every un-honorable edit throws inside exportEpubPreservingMarkup with the
  // offending block named. Those messages are passed through verbatim — they are
  // the only way the user can find the block that blocked the export.
  ipcMain.handle('epub:export-preserving-markup', async (
    _event,
    projectDir: string | null,        // null for a loose-file Save As
    epubSourcePath: string,           // THE FILE THE PICKER ANALYZED — alignment baseline
    savePathOverride: string | null,  // absolute; null → the project's canonical export path
    edits: EpubPreservingEdits,
    deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>,
    // WHICH working chain this export belongs to. The picker holds it — the row
    // it opened from carries it and `projects:export-info` hands it back — and
    // without it a project with two versions could not export at all: both
    // `exportEpubTarget` and `registerEpubExport` resolve through the act
    // chokepoint, which refuses to be asked "the project's book" when that names
    // two files. Threaded exactly as book:erase-changes and narration:export
    // already thread it. Absent stays the ordinary single-chain case.
    familyId?: string,
  ) => {
    try {
      if (!projectDir && !savePathOverride) {
        return {
          success: false,
          error: 'Cannot export: no project directory and no save path — there is nowhere to write the EPUB.',
        };
      }

      // Everything project-mode needs is checked BEFORE the export runs, so a
      // project this handler cannot record into never gets a file written for it.
      let projectId = '';
      let sourceRelPath = '';
      if (projectDir) {
        if (!fsSync.existsSync(path.join(projectDir, 'manifest.json'))) {
          return {
            success: false,
            error: `Cannot export: ${projectDir} is not a manifest project (no manifest.json).`,
          };
        }

        // The provenance record is project-relative, so the source has to BE a
        // project file — a record pointing outside the project could not be
        // resolved later, and the edits would have no verifiable baseline.
        const relRaw = path.relative(projectDir, epubSourcePath);
        if (!relRaw || relRaw.startsWith('..') || path.isAbsolute(relRaw)) {
          return {
            success: false,
            error: `Cannot export: the source EPUB (${epubSourcePath}) lies outside the project directory (${projectDir}) — a project export must align against a project file.`,
          };
        }
        sourceRelPath = relRaw.split(path.sep).join('/');

        projectId = path.basename(projectDir);
        const expectedDir = manifestService.getProjectPath(projectId);
        if (!sameResolvedPath(expectedDir, projectDir)) {
          return {
            success: false,
            error: `Cannot export: ${projectDir} is not inside the configured library (expected ${expectedDir}), so its manifest cannot be located.`,
          };
        }
      }

      // Named after the book, and derived in ONE place (manifest-service) so the
      // renderer never builds it. A Save As names its own destination instead.
      const epubPath = savePathOverride
        ?? (await manifestService.exportEpubTarget(projectDir!, familyId)).absPath;

      // The source is the alignment baseline: every block id in `edits` was
      // resolved against these exact bytes. Writing the export over it destroys
      // the only file the edit set means anything against.
      if (sameResolvedPath(epubPath, epubSourcePath)) {
        return {
          success: false,
          error: `Cannot export onto the source EPUB itself (${epubPath}) — it is the file the edits were aligned against. Choose a different destination.`,
        };
      }

      await fs.mkdir(path.dirname(epubPath), { recursive: true });

      // ── WHICH container, said here because only here knows ──────────────────
      //
      // A Save As writes a file the user picked in a dialog and is going to hand
      // to somebody — an archive. The project's own export lands on the working
      // copy, which is a folder of the book's parts, so that editing one chapter
      // later writes one file. Nothing about `epubPath` says which of the two
      // this is; `savePathOverride` says it exactly.
      const { exportEpubPreservingMarkup } = await import('./epub-processor.js');
      const summary = await exportEpubPreservingMarkup(
        epubSourcePath, epubPath, edits, savePathOverride ? 'zip' : 'directory');

      // Measured through `bookDigest`, which is the one thing in this app that
      // knows how to size and identify a book in either container: a `fs.stat`
      // on a folder reports the folder's own entry, not the book's bytes.
      const { bookDigest } = await import('./sidecar-binding.js');
      const exported = await bookDigest(epubPath);
      console.log(`[epub:export-preserving-markup] Wrote EPUB: ${exported.size} bytes to ${epubPath} `
        + `(${summary.chapterCount} chapters, ${summary.blockCount} blocks, `
        + `${summary.unalignedUntouched} unaligned untouched)`);

      // Project-mode side effects: parity with 'audiobook:export-from-project'.
      if (projectDir) {
        // Deleted-block examples for detailed AI cleanup, next to the EPUB.
        if (deletedBlockExamples && deletedBlockExamples.length > 0) {
          const examplesPath = path.join(path.dirname(epubPath), 'deleted-examples.json');
          await fs.writeFile(examplesPath, JSON.stringify(deletedBlockExamples, null, 2));
        }

        // Provenance: bind the produced EPUB to the file the edits were aligned
        // against, by hash on both sides (the audiobookAnalyses discipline). Both
        // digests are streamed — these are whole books.
        // Both sides through `bookDigest` rather than `computeFileHash`: either
        // of them can now be a folder of a book's parts, and a digest that says
        // HOW it was taken is what keeps a later comparison from reading a
        // re-measurement as a changed book (shared/book-digest.ts).
        const provenance: ExportProvenance = {
          sourceSha256: (await bookDigest(epubSourcePath)).digest,
          sourceRelPath,
          exportedSha256: exported.digest,
          exportedAt: new Date().toISOString(),
        };

        // One locked read-modify-write: records the provenance AND bumps
        // modifiedAt (saveManifest does the timestamp).
        const saved = await manifestService.updateManifest({
          projectId,
          source: { exportProvenance: provenance },
        });
        if (!saved.success) {
          return {
            success: false,
            error: `Exported to ${epubPath}, but recording it in the manifest failed: ${saved.error}`,
          };
        }

        // The record that makes this file findable at all — nothing looks for it
        // by name. Only for the canonical destination: a savePathOverride writes
        // somewhere the caller chose, which is not the project's export.
        if (!savePathOverride) {
          await manifestService.registerEpubExport(projectDir, epubPath, undefined, familyId);
        }

        // Every window: the picker, the editor and the listen windows all draw
        // this project's files, and only one of them is the main window.
        broadcastToAllWindows('project:files-changed', projectDir);
      }

      return {
        success: true,
        epubPath,
        chapterCount: summary.chapterCount,
        blockCount: summary.blockCount,
        unalignedUntouched: summary.unalignedUntouched,
        warnings: summary.warnings,
      };
    } catch (err) {
      // The exporter's messages name the offending block — pass them through as-is.
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

  // Compute change counts for chapters that weren't part of a cleanup job, so
  // the Review Changes dropdown can show a real "N changes" for every chapter.
  ipcMain.handle('diff:get-change-counts', async (_event, originalPath: string, cleanedPath: string, chapterIds?: string[]) => {
    try {
      const { getComparisonChangeCounts } = await import('./epub-processor.js');
      const counts = await getComparisonChangeCounts(originalPath, cleanedPath, chapterIds);
      return { success: true, data: { counts } };
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
      const { hydrateDiff, computeCompactDiff } = await import('./diff-cache.js');
      const { getChapterComparison } = await import('./epub-processor.js');

      // Get BOTH the original and cleaned text for this chapter
      // We need original for display and cleaned for hydration
      const result = await getChapterComparison(originalPath, cleanedPath, chapterId);
      const { originalText, cleanedText } = result;

      // The cached compact changes store character offsets into the cleaned text
      // AS IT EXISTED when the diff was computed during cleanup. If the cleaned
      // EPUB's extracted text has since drifted (re-export, manual edit, extractor
      // change), those offsets misalign and hydrateDiff slices the wrong ranges —
      // producing duplicated/garbled text like "ninineteen sixty-ninethe". Detect
      // the drift cheaply (does each change's stored `add` actually sit at its
      // recorded offset?) and, when it doesn't, recompute the diff from the
      // authoritative original/cleaned text so the displayed diff is always
      // self-consistent with the displayed text. This also self-heals stale caches.
      let effectiveChanges = (changes as Array<{ pos: number; len: number; add?: string }>) || [];
      const aligned = effectiveChanges.every(
        c => !c.add || cleanedText.slice(c.pos, c.pos + c.len) === c.add
      );
      if (!aligned) {
        console.warn(`[diff:hydrate-chapter] cached offsets misaligned for "${chapterId}" — recomputing diff from source text`);
        effectiveChanges = computeCompactDiff(originalText, cleanedText).changes;
      }

      // Hydrate the (validated or recomputed) compact changes
      const diffWords = hydrateDiff(effectiveChanges as any[], cleanedText);

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
    provider: 'ollama' | 'claude' | 'openai',
    apiKey?: string
  ) => {
    try {
      const { aiBridge } = await import('./ai-bridge.js');
      const result = await aiBridge.checkProviderConnection(provider, apiKey);
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

  ipcMain.handle('bookshelf:start', async (_event, config: { port: number }) => {
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


  // ── Reader profiles + per-reader listening/bookmarks for the desktop player.
  // The desktop IS this server, so these go straight to the shared on-disk store
  // (no HTTP, no token) and stay in sync with the phone/web analytics. Works even
  // when the network server is toggled off.
  ipcMain.handle('reader:list', async () => {
    try { return { success: true, readers: bookshelfServer.listReaderProfiles() }; }
    catch (err) { return { success: false, error: (err as Error).message, readers: [] }; }
  });

  ipcMain.handle('reader:record-listening', async (
    _event,
    p: { readerId: string; bookPath: string; title: string; author: string; seconds: number; id?: string },
  ) => {
    try { bookshelfServer.recordListening(p.readerId, p.bookPath, p.title, p.author, p.seconds, p.id); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });

  ipcMain.handle('reader:save-position', async (
    _event, p: { readerId: string; bookPath: string; seconds: number },
  ) => {
    try { bookshelfServer.saveAudioPosition(p.readerId, p.bookPath, p.seconds); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });

  ipcMain.handle('reader:get-position', async (_event, p: { readerId: string; bookPath: string }) => {
    try { return { success: true, seconds: bookshelfServer.getAudioPosition(p.readerId, p.bookPath) }; }
    catch (err) { return { success: false, error: (err as Error).message, seconds: null }; }
  });

  ipcMain.handle('reader:list-bookmarks', async (_event, p: { readerId: string; bookPath: string }) => {
    try { return { success: true, bookmarks: bookshelfServer.listAudioBookmarks(p.readerId, p.bookPath) }; }
    catch (err) { return { success: false, error: (err as Error).message, bookmarks: [] }; }
  });

  ipcMain.handle('reader:save-bookmark', async (
    _event, p: { readerId: string; bookPath: string; op: 'add' | 'del'; bookmark: Record<string, unknown> & { id?: string } },
  ) => {
    try { bookshelfServer.saveAudioBookmark(p.readerId, p.bookPath, p.op, p.bookmark); return { success: true }; }
    catch (err) { return { success: false, error: (err as Error).message }; }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // E2A Path Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  // Orpheus max batch size (per-machine, user-configurable in Settings → Streaming
  // engine). Processing uses it directly; streaming ramps up to it. Read live by
  // both pipelines, so a change applies without restart.
  ipcMain.handle('orpheus-batch:get', () => getOrpheusBatchConfig());
  ipcMain.handle('orpheus-batch:set', (_event, value: number | null) => {
    setOrpheusMaxBatch(value);
    return getOrpheusBatchConfig();
  });

  // Orpheus memory tier (how much GPU/unified memory Orpheus may claim vs leave free).
  // 'auto' resolves to a concrete tier from live free VRAM (clamped by a learned
  // ceiling); the reply includes the resolved tier + its profile for display.
  const memoryTierReply = async () => {
    const tier = getOrpheusMemoryTier();
    const mem = await getGpuMemMB();
    const freeMB = mem?.freeMB ?? null;
    const totalMB = mem?.totalMB ?? null;
    // What the job will ACTUALLY run at: resolve the wanted tier, then step down to the
    // highest one the free VRAM can manage (same logic the spawn uses). So the UI shows
    // the real level + reserve, and `viable:false` only when even the lowest can't hold
    // the floor (it will still run, at the lowest, and might run out of memory).
    const wanted = resolveConcreteOrpheusTier(freeMB, totalMB);
    const fit = fitOrpheusTier(wanted, freeMB, totalMB);
    return {
      tier,
      resolvedTier: fit.tier,
      autoCeiling: getOrpheusAutoCeiling() ?? null,
      profile: orpheusMemoryProfile(fit.tier),
      platform: process.platform === 'darwin' ? 'mac' : 'nvidia',
      // Live GPU picture for the UI's level + low-memory note.
      viable: fit.fits,
      steppedDown: fit.steppedDown,
      freeMB,
      usedMB: mem ? Math.max(0, mem.totalMB - mem.freeMB) : null,
      totalMB,
      reserveMB: fit.reserveMB,
    };
  };
  ipcMain.handle('orpheus-memory:get', () => memoryTierReply());
  ipcMain.handle('orpheus-memory:set', (_event, tier: OrpheusMemoryTier) => {
    setOrpheusMemoryTier(tier);
    return memoryTierReply();
  });

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

  // ── Custom Orpheus voices (HF catalogue + local install) ──────────────────
  // User-managed Orpheus voice SOURCES (HF repo ids). Defaults ship built-in.
  ipcMain.handle('orpheus:sources-get', async () => {
    try {
      const { getOrpheusSources } = await import('./orpheus-hf-catalog.js');
      return { success: true, data: getOrpheusSources() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('orpheus:sources-add', async (_event, input: string) => {
    try {
      const { addOrpheusSource } = await import('./orpheus-hf-catalog.js');
      return addOrpheusSource(input);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('orpheus:sources-remove', async (_event, repoId: string) => {
    try {
      const { removeOrpheusSource } = await import('./orpheus-hf-catalog.js');
      return { success: true, data: removeOrpheusSource(repoId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // User-added RVC enhancement voice sources ({ url, name }). They join the
  // built-in RVC voices in the ComponentService catalog (rvcVoiceComponents).
  ipcMain.handle('rvc:sources-get', async () => {
    try {
      const { getRvcSources } = await import('./rvc-models.js');
      return { success: true, data: getRvcSources() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('rvc:sources-add', async (_event, url: string, name: string) => {
    try {
      const { addRvcSource } = await import('./rvc-models.js');
      return addRvcSource(url, name);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
  ipcMain.handle('rvc:sources-remove', async (_event, id: string) => {
    try {
      const { removeRvcSource } = await import('./rvc-models.js');
      removeRvcSource(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('orpheus:catalog-list', async () => {
    try {
      // Refresh the WSL liveness cache first — the catalog listing does sync fs on a
      // \\wsl$ models dir; a wedged VM would otherwise hang the main thread forever.
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      await isWslAlive();
      const { fetchOrpheusCatalog } = await import('./orpheus-hf-catalog.js');
      return { success: true, data: await fetchOrpheusCatalog() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Status of the ONE shared base model every LoRA-adapter voice rides on. Same
  // \\wsl$ sync-fs guard as catalog-list — resolving the base stats the models dir.
  //
  // `catalog` is the list the caller ALREADY fetched (the Settings panel always has
  // one by the time it asks). Which base is needed is a fact about the catalogue, so
  // without it this handler has to re-fetch every source repo — N × 2 HTTP round trips
  // duplicating the ones catalog-list just made. Omitted only by a caller that has no
  // catalogue yet, which then pays for its own fetch.
  ipcMain.handle('orpheus:base-status', async (_event, catalog?: OrpheusCatalogEntry[]) => {
    try {
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      await isWslAlive();
      const { getOrpheusBaseStatus } = await import('./orpheus-hf-catalog.js');
      return { success: true, data: await getOrpheusBaseStatus(catalog) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Install the shared base on its own (the "Base model" card in Settings / the
  // first-run wizard). Installing a voice does this implicitly too; this exists so a
  // user can pay the one-time 6.6 GB up front and then add 0.4 GB voices.
  // Takes the caller's already-fetched catalogue for the same reason base-status does.
  ipcMain.handle('orpheus:base-install', async (_event, catalog?: OrpheusCatalogEntry[]) => {
    try {
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      await isWslAlive();
      const { installOrpheusBase, getOrpheusBaseStatus } = await import('./orpheus-hf-catalog.js');
      const status = await getOrpheusBaseStatus(catalog);
      const result = await installOrpheusBase(status.base);
      // A newly installed base makes previously-unusable adapter voices resolvable —
      // refresh the live voice list for the same reason a voice install does.
      if (result?.success) {
        const { ttsApiServer } = await import('./tts-api-server.js');
        await ttsApiServer.refreshInstalledVoices();
      }
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('orpheus:catalog-install', async (event, repoId: string) => {
    try {
      // Same \\wsl$ sync-fs guard as catalog-list (install writes the manifest there).
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      await isWslAlive();
      const { installOrpheusModel } = await import('./orpheus-hf-catalog.js');
      // Two-phase progress (shared base, then the voice) rides its own channel, the
      // same shape components:progress uses.
      const result = await installOrpheusModel(repoId, (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('orpheus:install-progress', p);
      });
      // A newly installed custom voice must surface in the live voice list (Listen
      // UI + extension clients) without an app restart — otherwise it only appears
      // on next launch / engine switch. See getAvailableVoices() (orpheus).
      if (result?.success) {
        const { ttsApiServer } = await import('./tts-api-server.js');
        await ttsApiServer.refreshInstalledVoices();
        // …and a RESIDENT streaming engine must forget what it knows about this
        // voice. The install just replaced the files under a path the engine has
        // already registered, so without this a retrained voice keeps rendering from
        // the previous training run — the engine's own cached copy — until the
        // session is torn down. Forgetting it forces a fresh load, which is what
        // makes the worker re-fingerprint the adapter.
        if (result.id) {
          const { orpheusWorkerPool } = await import('./orpheus-worker-pool.js');
          orpheusWorkerPool.forgetVoice(result.id);
        }
      }
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('orpheus:remove-model', async (_event, id: string) => {
    try {
      // Same \\wsl$ sync-fs guard as catalog-list (remove rewrites the manifest +
      // rm -rf's the model folder there).
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      await isWslAlive();
      const { removeOrpheusModel } = await import('./orpheus-hf-catalog.js');
      const result = removeOrpheusModel(id);
      // Drop the removed voice from the live list too (same reasoning as install),
      // and from a resident streaming engine's registration set — its files are gone,
      // so any future request naming it must fail loudly at the load rather than be
      // accepted on the strength of stale bookkeeping.
      if (result?.success) {
        const { ttsApiServer } = await import('./tts-api-server.js');
        await ttsApiServer.refreshInstalledVoices();
        const { orpheusWorkerPool } = await import('./orpheus-worker-pool.js');
        orpheusWorkerPool.forgetVoice(id);
      }
      return result;
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

  /**
   * The book this job will read, proved to be on disk before anything starts.
   *
   * A narration run is hours of GPU. Started against a path that is not there —
   * a narration copy deleted since the job was queued, an unmounted drive, a
   * project moved on the other machine — it used to spawn its workers and die
   * inside e2a with whatever that layer says about a missing file, which names
   * the wrong thing and arrives after the queue has already reported "running".
   */
  const narrationInputRefusal = (config: any): string | null => {
    const epubPath = config?.epubPath;
    if (typeof epubPath !== 'string' || epubPath.length === 0) {
      return 'This narration run was queued without a book to read. Start it from the version you '
        + 'mean, so the run is told which document it has.';
    }
    if (!fsSync.existsSync(normalizeFsPath(epubPath))) {
      return `The book this run was queued against is not there: ${epubPath}. Nothing was started. `
        + 'Export the narration copy again, or check that the drive it lives on is mounted.';
    }
    if (fsSync.statSync(normalizeFsPath(epubPath)).isDirectory()) {
      // The working copy is an exploded DIRECTORY since Aug 2026, and a job
      // queued against the book's own line (a project with no narration copy
      // yet) used to hand that directory to e2a as `--ebook` — which dies
      // hours in, inside e2a, with a sentence about the wrong thing. It is
      // also the wrong BOOK: a narration run reads the exported TTS copy,
      // which is the file the user's deletions are applied to; reading the
      // working copy would narrate every struck footnote back in.
      return `The book this run was queued against is a folder, not a narration copy: ${epubPath}. `
        + 'That is the project\'s live working copy — a narration run reads the exported TTS '
        + 'copy, which has your deletions applied. Nothing was started. Export the TTS copy from '
        + 'the versions window and start the run from it.';
    }
    return null;
  };

  ipcMain.handle('parallel-tts:start-conversion', async (_event, jobId: string, config: any) => {
    try {
      const refusal = narrationInputRefusal(config);
      if (refusal) return { success: false, error: refusal };
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
      // Stop the workers AND promote the sentences rendered so far to the durable
      // project cache, so the job can be resumed from where it left off.
      const result = await parallelTtsBridge.stopAndCacheParallelConversion(jobId);
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
      const refusal = narrationInputRefusal(config);
      if (refusal) return { success: false, error: refusal };
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

  // Cache full TTS session into the project for permanent storage
  ipcMain.handle('session-cache:save-to-bfp', async (_event, sessionDir: string, projectDir: string) => {
    try {
      const { cacheSessionToBfp } = await import('./parallel-tts-bridge.js');
      return await cacheSessionToBfp(sessionDir, projectDir);
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
    // No m4bPath/vttPath from the caller. The renderer cannot know them: this job is
    // queued at the same time as the assembly job that WRITES them, and for the
    // monolingual pipeline the name depends on the book's title. startVideoAssembly
    // resolves both from bfpPath/output, and fails naming that directory.
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

  // Generate-sentences: transcribe an audiobook variant into a synced VTT (Whisper)
  // and link it to that variant. Progress/completion ride events keyed by jobId,
  // same shape as video-assembly.
  ipcMain.handle('generate-sentences:run', async (_event, jobId: string, config: {
    projectId: string;
    variantId: string;
    m4bPath: string;
    modelId: string;
    language?: string;
    method?: 'whisper' | 'epub-align';
    epubVariantId?: string;
  }) => {
    try {
      getMainLogger().info(`[generate-sentences:run] IPC received job=${jobId}`, { modelId: config.modelId });
      if (!mainWindow) {
        getMainLogger().error('[generate-sentences:run] no mainWindow — cannot run');
        return { success: false, error: 'Main window not available' };
      }
      const { startGenerateSentences } = await import('./generate-sentences-bridge.js');
      // Fire-and-forget: the bridge owns progress/complete events. Attach a catch
      // so an early rejection is logged instead of becoming a silent unhandled
      // rejection (the bridge's own try/catch already reports functional errors).
      void startGenerateSentences(jobId, mainWindow, config).catch((err) => {
        getMainLogger().error(`[generate-sentences:run] bridge threw job=${jobId}: ${(err as Error).message}`, {
          stack: (err as Error).stack,
        });
      });
      return { success: true, jobId };
    } catch (err) {
      getMainLogger().error(`[generate-sentences:run] failed to start job=${jobId}: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('generate-sentences:cancel', async (_event, jobId: string) => {
    try {
      const { cancelGenerateSentences } = await import('./generate-sentences-bridge.js');
      cancelGenerateSentences(jobId);
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
      const { getActiveEngine } = await import('./streaming-engine.js');
      const engine = getActiveEngine();
      engine.setMainWindow(mainWindow);
      const result = await engine.startSession();
      return { success: result.success, data: { voices: result.voices }, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:load-voice', async (_event, voice: string) => {
    try {
      const { getActiveEngine } = await import('./streaming-engine.js');
      const result = await getActiveEngine().loadVoice(voice);
      return { success: result.success, error: result.error };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:end-session', async () => {
    try {
      const { getActiveEngine } = await import('./streaming-engine.js');
      await getActiveEngine().endSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:is-session-active', async () => {
    try {
      const { getActiveEngine } = await import('./streaming-engine.js');
      const active = getActiveEngine().isSessionActive();
      return { success: true, data: { active } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── TTS service: the engine pinned as a resident service ──
  // Unlike the implicit play-button start, service mode survives listen-window
  // close. It does NOT hold the weights forever: on idle timeout the ENGINE
  // PARKS — the worker is killed and its memory freed, serviceMode stays true
  // and the API server keeps listening — so an external client (e.g. a browser
  // extension) still has a live endpoint while the machine gets its RAM back,
  // and the next speak pays the cold start. State changes broadcast on
  // 'tts-service:state' to all windows; the main process is the single source
  // of truth.

  // Live-sync the streaming voice/engine selection to the renderer: when it
  // changes from ANY source (the in-app picker, or an extension client via the
  // TTS API server), broadcast 'tts-service:config' so the Settings voice picker
  // refreshes. The browser extension is synced separately by the API server's
  // own `config` rebroadcast (both hang off the same streaming-engine event).
  void import('./streaming-engine.js').then(({ onStreamConfigChanged, onActiveEngineState }) => {
    const pushConfig = () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('tts-service:config');
      }
    };
    onStreamConfigChanged(pushConfig);
    // Engine state carries the loaded voice with it: stopping the engine (or a
    // worker crash) drops the model, so the picker's effective voice falls back to
    // the persisted default. Same reason the TTS API server pushes a config here —
    // both pickers show the same value, so both have to be told at the same moment.
    onActiveEngineState(pushConfig);
  });

  ipcMain.handle('tts-service:start', async (_event, voice?: string) => {
    try {
      const { getActiveEngine, getDefaultStreamVoice } = await import('./streaming-engine.js');
      const engine = getActiveEngine();
      engine.setMainWindow(mainWindow);
      engine.setServiceMode(true);
      const result = await engine.startSession();
      if (!result.success) {
        engine.setServiceMode(false);
        return { success: false, error: result.error };
      }
      // Warm a voice so the first request speaks within seconds
      const warmVoice = voice || engine.getCurrentVoice() || engine.getLastVoice() || getDefaultStreamVoice();
      const loaded = await engine.loadVoice(warmVoice);
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
      const { getActiveEngine } = await import('./streaming-engine.js');
      const engine = getActiveEngine();
      engine.setServiceMode(false);
      await engine.endSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts-service:status', async () => {
    try {
      const { getActiveEngine } = await import('./streaming-engine.js');
      const engine = getActiveEngine();
      return {
        success: true,
        state: engine.getEngineState(),
        serviceMode: engine.isServiceMode()
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
      const { getStreamConfigPayload } = await import('./streaming-engine.js');
      // Includes worker topology PLUS engine selection (`engine`) + availability
      // (`engines`) so the TTS Server settings UI can render the engine chooser.
      return { success: true, data: getStreamConfigPayload() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('tts-stream:set-worker-config', async (
    _event,
    updates: { engine?: 'xtts' | 'orpheus'; enabled?: boolean; count?: number; devicePref?: 'auto' | 'cpu' | 'gpu' | 'mps'; voice?: string }
  ) => {
    try {
      const { setStreamConfig, getSelectedEngineName } = await import('./streaming-engine.js');
      const before = getSelectedEngineName();
      const data = await setStreamConfig(updates);
      // Switching engines changes the available voice set (XTTS library vs
      // Orpheus's built-in voices); refresh so connected extension clients see it.
      if (data.engine !== before) {
        const { ttsApiServer } = await import('./tts-api-server.js');
        await ttsApiServer.refreshInstalledVoices();
      }
      return { success: true, data };
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

  // What the startup sweep found. Pull, for a renderer that subscribed after the
  // push already went out (a reload, or a window opened late) — the sweep is
  // async and there is no ordering guarantee worth relying on. Null until it has
  // finished; the renderer treats that as "nothing yet", not "nothing to do".
  ipcMain.handle('components:upgrades', async () => lastUpgradeReport);

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

  // ── Whisper transcription models ──────────────────────────────────────────
  // The Whisper RUNTIME (id 'whisper') installs/removes through the components:*
  // IPCs above. These handle the model WEIGHTS (small/medium/large-v3/distil),
  // downloaded from HuggingFace into <userData>/runtime/whisper-models/<id>.
  ipcMain.handle('whisper:list-models', async () => {
    try {
      const { listWhisperModels } = await import('./whisper-models.js');
      return { success: true, data: listWhisperModels() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('whisper:download-model', async (event, id: string) => {
    try {
      const { downloadWhisperModel } = await import('./whisper-models.js');
      const result = await downloadWhisperModel(id, (p) => {
        event.sender.send('whisper:download-progress', p);
      });
      return result;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('whisper:delete-model', async (_event, id: string) => {
    try {
      const { deleteWhisperModel } = await import('./whisper-models.js');
      return deleteWhisperModel(id);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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

  // Folder-discovered custom Orpheus models (runtime/orpheus-models/<voice>/) —
  // surfaced as extra Orpheus voices in the TTS dropdowns.
  ipcMain.handle('orpheus:list-models', async () => {
    try {
      // Refresh the WSL liveness cache FIRST (async, 5s-bounded): the listing does
      // sync fs on a \\wsl$ models dir, and against a wedged VM that would block the
      // main thread forever (the white-screen bug). With a fresh probe the sync gate
      // inside orpheus-models degrades to "no custom models" instead of hanging.
      const { isWslAlive } = await import('./wsl-lifecycle.js');
      await isWslAlive();
      const { listOrpheusModels } = await import('./orpheus-models.js');
      return { success: true, data: listOrpheusModels() };
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
      const { getSelectedEngineName, getActiveEngine } = await import('./streaming-engine.js');
      // Full catalog (id, name, group) so the dropdown can label and group
      // voices; available before the engine starts. Orpheus's voices are built
      // into the model — synthesize catalog entries from its voice list.
      if (getSelectedEngineName() === 'orpheus') {
        const voices = getActiveEngine().getAvailableVoices().map((id) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
          group: 'Orpheus',
          repo: '',
          sub: '',
          refPath: '',
        }));
        return { success: true, data: { voices } };
      }
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      const voices = xttsWorkerPool.getVoiceCatalog();
      return { success: true, data: { voices } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Unified Audiobook Export - saves EPUB and updates the manifest project
  // ─────────────────────────────────────────────────────────────────────────────

  // Get output folder for a project (under projects/{name}/output/)
  const getAudiobookFolderForProject = (projectName: string) => {
    return path.join(getProjectsFolder(), projectName, 'output');
  };

  // Export EPUB to the project's source folder and update the manifest
  ipcMain.handle('audiobook:export-from-project', async (
    _event,
    projectDir: string,
    epubData: ArrayBuffer,
    deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>,
    savePath?: string,
    // WHICH working chain this export belongs to — threaded for the same reason
    // `epub:export-preserving-markup` threads it: a project with two versions has
    // two books, and both the target and the record refuse to be asked without
    // saying which. Absent stays the ordinary single-chain case.
    familyId?: string
  ) => {
    try {
      // Check if projectDir is a manifest project directory
      const isDir = fsSync.existsSync(projectDir) && fsSync.statSync(projectDir).isDirectory();

      if (isDir) {
        // Save the exported EPUB — to savePath if provided, otherwise to the
        // project's canonical export path (named after the book; derived in
        // manifest-service, never here). Resolved BEFORE a byte is written, so a
        // project this handler cannot record into never gets a file.
        let epubPath: string;
        if (savePath) {
          epubPath = savePath;
          await fs.mkdir(path.dirname(savePath), { recursive: true });
        } else {
          epubPath = (await manifestService.exportEpubTarget(projectDir, familyId)).absPath;
          await fs.mkdir(path.dirname(epubPath), { recursive: true });
        }
        // Archive bytes from the renderer, landed as whichever container this
        // destination is: a `savePath` is a file the user named in a dialog, and
        // the project's own export is the working copy, which is a folder of the
        // book's parts. Same reasoning, same words, as `editor:save-epub`.
        const epubBuffer = Buffer.from(epubData);
        await writeEpubFromArchiveBytes(epubBuffer, epubPath, savePath ? 'zip' : 'directory');

        // Merge fragmented paragraphs (line-level PDF blocks → sentence-aligned paragraphs)
        await mergeEpubParagraphs(epubPath);

        // Verify the book was written
        const { bookDigest } = await import('./sidecar-binding.js');
        const written = await bookDigest(epubPath);
        console.log(`[audiobook:export-from-project] Wrote EPUB: ${written.size} bytes to ${epubPath}`);

        // Save deleted block examples if provided (next to the saved EPUB)
        if (deletedBlockExamples && deletedBlockExamples.length > 0) {
          const examplesPath = path.join(path.dirname(epubPath), 'deleted-examples.json');
          await fs.writeFile(examplesPath, JSON.stringify(deletedBlockExamples, null, 2));
        }

        // The record that makes this file findable at all — nothing looks for it
        // by name. A savePath writes where the caller chose, which is not the
        // project's export.
        //
        // ── AND IT IS THE ONLY MANIFEST WRITE HERE ────────────────────────────
        //
        // There used to be a raw read at the top of this handler and a raw
        // whole-object write here that set nothing but `modifiedAt` — with the
        // EPUB write, the paragraph merge and a stat in between. A pure clobber:
        // anything recorded during those seconds was thrown away by a write that
        // wanted a timestamp. `registerEpubExport` takes the project's own lock
        // and stamps `modifiedAt` on its way past, so it is both the record and
        // the touch. A `savePath` export records nothing and touches nothing —
        // it wrote to a place the caller named, which is not this project's book.
        if (!savePath) {
          await manifestService.registerEpubExport(projectDir, epubPath, undefined, familyId);
        }

        // Every window, not just the main one: the picker, the editor and the
        // listen windows all draw this project's files.
        broadcastToAllWindows('project:files-changed', projectDir);

        return {
          success: true,
          audiobookFolder: projectDir,
          epubPath
        };
      }

      // Not a project directory with a manifest. The only other thing this used
      // to accept was a single-file .bfp project, and exporting into one would
      // rebuild the sidecar audiobook folder the manifest layout replaced.
      throw new Error(
        `Cannot export from "${projectDir}": it is not a BookForge project directory. ` +
        `Legacy .bfp project files are no longer supported — open the project directory instead.`
      );
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
      // The EPUB could not be parsed. A filename guess is still useful to
      // pre-fill the import form, but the caller MUST be able to tell it apart
      // from real EPUB metadata — hence `degraded: true` + the parse reason.
      const parsed = ebookLibrary.parseFilename(path.basename(epubSourcePath));
      return {
        success: true,
        degraded: true,
        error: (err as Error).message,
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

  // Import an EPUB file directly - creates the project directory + output folder
  // This is for adding EPUBs via drag/drop without going through the PDF editor
  ipcMain.handle('audiobook:import-epub', async (
    _event,
    epubSourcePath: string,
    confirmedMetadata?: { title: string; author: string; year?: string; language?: string; subtitle?: string; coverData?: string }
  ) => {
    // Save the cover first (main-only helper), then hand off to the shared
    // importer. Studio imports are always 'book'; the bookshelf mobile flow calls
    // importEpubProject directly with projectType 'article'.
    let coverRelPath: string | undefined;
    if (confirmedMetadata?.coverData) {
      try { coverRelPath = await saveImageToMedia(confirmedMetadata.coverData, 'cover'); }
      catch (coverErr) { console.warn('[audiobook:import] Failed to save cover:', coverErr); }
    }
    return importEpubProject(epubSourcePath, {
      confirmedMetadata: confirmedMetadata
        ? {
            title: confirmedMetadata.title,
            author: confirmedMetadata.author,
            year: confirmedMetadata.year,
            language: confirmedMetadata.language,
            subtitle: confirmedMetadata.subtitle,
          }
        : undefined,
      projectType: 'book',
      coverRelPath,
    });
  });

  // Import an existing audio file (m4b/mp3/wav/…) as a "complete" audiobook
  // project: create the project dir, transcode/normalize the audio into
  // archive/<descriptive>.m4b (the PROTECTED folder — professionally-read uploads
  // are irreplaceable and must never sit in output/, which delete-output wipes),
  // seed metadata + cover from the file's embedded tags, and register the output
  // so it appears on the Bookshelf like any book.
  ipcMain.handle('audiobook:import-audiobook', async (_event, audioSourcePath: string) => {
    // Body lives in library-actions.importAudiobookProject so the headless CLI
    // exercises the identical path (see cli/library.js).
    return importAudiobookProject(audioSourcePath, { onProgress: emitImportProgress });
  });

  // Edit the AUDIOBOOK's metadata (independent from the ebook's). Stores the
  // overrides in manifest.metadata.audiobook and, when a completed m4b already
  // exists, embeds the effective tags + cover into it immediately. When no m4b
  // exists yet, the overrides are carried into the m4b at reassembly time.
  ipcMain.handle('audiobook:save-audiobook-metadata', async (
    _event,
    projectId: string,
    meta: { title?: string; author?: string; year?: string; narrator?: string; series?: string; seriesPosition?: number; description?: string },
    coverData?: string,
  ) => {
    try {
      let coverPath: string | undefined;
      if (coverData) {
        try { coverPath = await saveImageToMedia(coverData, 'cover'); }
        catch (e) { console.warn('[audiobook:save-meta] cover save failed:', e); }
      }

      const override: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(meta || {})) {
        if (v !== undefined && v !== null && v !== '') override[k] = v;
      }
      if (coverPath) override.coverPath = coverPath;

      const saved = await manifestService.modifyManifest(projectId, (manifest) => {
        if (!manifest.metadata) return;
        manifest.metadata.audiobook = { ...(manifest.metadata.audiobook || {}), ...override };
      });
      if (!saved?.success) return { success: false, error: saved?.error || 'Failed to update manifest' };

      // If the m4b is already built, write the tags/cover straight into it.
      const got = await manifestService.getManifest(projectId);
      const audioRel = got.manifest?.outputs?.audiobook?.path;
      if (got.manifest && audioRel) {
        const m4bAbs = path.join(manifestService.getProjectPath(projectId), audioRel);
        if (fsSync.existsSync(m4bAbs)) {
          const eff = manifestService.effectiveAudiobookMetadata(got.manifest.metadata);
          const coverAbs = eff.coverPath ? path.join(manifestService.getLibraryBasePath(), eff.coverPath) : undefined;
          await applyMetadata(m4bAbs, {
            title: eff.title,
            author: eff.author,
            year: eff.year,
            narrator: eff.narrator,
            series: eff.series,
            description: eff.description,
            coverPath: coverAbs && fsSync.existsSync(coverAbs) ? coverAbs : undefined,
          } as any);
        }
      }
      return { success: true, coverPath };
    } catch (err) {
      console.error('[audiobook:save-meta] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── Book-variant IPC Handlers ────────────────────────────────────────────
  // A project holds multiple "variants" of the same book (languages/editions/
  // formats). Audio → normalized into archive/ as m4b (a professionally-read
  // upload is irreplaceable, so it lives in the protected folder, NOT output/
  // which delete-output wipes); ebook → copied into archive/. The renderer
  // pre-converts non-epub/pdf ebooks via Calibre.
  // VARIANT_AUDIO_EXT and the content hash now live in library-actions, shared
  // with the CLI.

  /**
   * List a project's variants, each with its file ALREADY RESOLVED.
   *
   * The renderer gets `absPath` + `exists` and never joins a manifest path itself.
   * That is not a convenience: manifest paths are project-relative, and the
   * renderer's only handle on "which project" is the live selection signal, which
   * changes BEFORE the row list finishes reloading. Joining there paired book B's
   * directory with book A's still-displayed rows. Here the directory and the rows
   * come from the same `projectId`, so the pairing cannot be crossed.
   */
  ipcMain.handle('variant:list', async (_event, projectId: string) => {
    try {
      const got = await manifestService.getManifest(projectId);
      if (!got.manifest) return { success: false, error: 'Project not found' };
      const { variants, primaryVariantId } = manifestService.getVariants(got.manifest);
      const projectDir = manifestService.getProjectPath(projectId);
      const resolved: ResolvedProjectVariant[] = await Promise.all(variants.map(async (v) => {
        // Split on '/' — manifest paths are relative and slash-separated, so the
        // segments must be handed to path.join individually to come out
        // platform-native (and to stay correct on macOS, where a raw backslash
        // would be a legal filename character rather than a separator).
        const resolveRel = async (rel: string): Promise<{ abs: string; isFile: boolean }> => {
          const abs = normalizeFsPath(path.join(projectDir, ...rel.split('/')));
          try {
            return { abs, isFile: (await fs.stat(abs)).isFile() };
          } catch {
            // Missing/unreadable is a legitimate answer here (a deleted or
            // not-yet-synced file), reported as exists:false. Callers decide.
            return { abs, isFile: false };
          }
        };
        const file = await resolveRel(v.path);
        // The paired synced-text VTT gets the same treatment, for the same reason:
        // `vttPath` is project-relative too, so a renderer that wanted the file had
        // to join it against a live "selected project" signal. A variant with no
        // vttPath at all resolves to null — audio-only playback is legitimate.
        const vtt = v.vttPath ? await resolveRel(v.vttPath) : null;
        return {
          ...v,
          absPath: file.abs,
          exists: file.isFile,
          vttAbsPath: vtt ? vtt.abs : null,
          vttExists: vtt ? vtt.isFile : false,
        };
      }));
      return { success: true, variants: resolved, primaryVariantId };
    } catch (err) { console.error('[variant:list]', err); return { success: false, error: (err as Error).message }; }
  });

  ipcMain.handle('variant:add', async (_event, projectId: string, filePath: string) => {
    // Body lives in library-actions.addVariant so the headless CLI exercises the
    // identical path (see cli/library.js). This wrapper only supplies the
    // renderer progress channel.
    return addVariant(projectId, filePath, { onProgress: emitImportProgress });
  });

  ipcMain.handle('variant:save-metadata', async (_event, projectId: string, variantId: string, meta: Record<string, unknown>, coverData?: string) => {
    // Body lives in library-actions.saveVariantMetadata, shared with cli/library.js.
    return saveVariantMetadata(projectId, variantId, meta, coverData);
  });

  // Return the variant's cover as a data URL, extracting it from the variant's OWN
  // file (embedded m4b art / epub cover) and persisting `coverPath` when none is
  // stored yet. This is what makes the Versions metadata editor show a cover for
  // real ebook/audiobook variants that were never given a coverPath (e.g. imported
  // ebooks, pipeline-produced audiobooks). No fallback: we read the REAL cover from
  // the REAL file, persist it so it's durable + the shelf/browse grid benefit, and
  // return no data only when the file genuinely has no cover.
  ipcMain.handle('variant:ensure-cover', async (_event, projectId: string, variantId: string) => {
    try {
      const got = await manifestService.getManifest(projectId);
      if (!got.manifest) return { success: false, error: 'Project not found' };
      const v = manifestService.getVariants(got.manifest).variants.find((x) => x.id === variantId);
      if (!v) return { success: false, error: 'Version not found' };

      const readAsDataUrl = async (abs: string): Promise<string> => {
        const buf = await fs.readFile(abs);
        const e = path.extname(abs).slice(1).toLowerCase();
        return `data:image/${e === 'jpg' ? 'jpeg' : e};base64,${buf.toString('base64')}`;
      };

      // Already has a resolvable stored cover — hand it back as-is.
      if (v.metadata?.coverPath) {
        const abs = path.join(manifestService.getLibraryBasePath(), v.metadata.coverPath);
        if (fsSync.existsSync(abs)) return { success: true, coverPath: v.metadata.coverPath, data: await readAsDataUrl(abs) };
        // Stored path is dangling — fall through and re-extract from the file.
      }

      const fileAbs = normalizeFsPath(path.join(manifestService.getProjectPath(projectId), v.path));
      if (!fsSync.existsSync(fileAbs)) return { success: false, error: `Version file not found: ${v.path}` };

      // Extract a cover data URL from the variant's own file.
      let dataUrl: string | undefined;
      if (v.kind === 'audiobook') {
        const mm = await import('music-metadata');
        const pic = (await mm.parseFile(fileAbs)).common.picture?.[0];
        if (pic) dataUrl = `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
      } else {
        const tmpOut = path.join(os.tmpdir(), 'bookforge-covers', `${crypto.randomUUID()}.jpg`);
        if (await ebookLibrary.extractCover(fileAbs, tmpOut)) {
          // `finally`, not a trailing unlink: a read that throws (a truncated
          // extraction, a permissions error) used to leave the temp cover behind
          // for good — one per failed attempt, in the OS temp directory, named
          // after a uuid nothing will ever look up again.
          try {
            dataUrl = await readAsDataUrl(tmpOut);
          } finally {
            try { await fs.unlink(tmpOut); } catch { /* temp cleanup */ }
          }
        }
      }
      if (!dataUrl) return { success: true, coverPath: undefined }; // file genuinely has no cover

      const coverPath = await saveImageToMedia(dataUrl, 'cover');
      const saved = await manifestService.modifyManifest(projectId, (mf) => {
        const cur = manifestService.getVariants(mf);
        mf.variants = cur.variants.map((x) => x.id === variantId ? { ...x, metadata: { ...x.metadata, coverPath } } : x);
        if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
        // Surface the primary variant's cover at book level so the desktop browse
        // grid (which reads manifest.metadata.coverPath) shows it too.
        if (mf.primaryVariantId === variantId && !mf.metadata.coverPath) mf.metadata.coverPath = coverPath;
      });
      if (!saved?.success) return { success: false, error: saved?.error || 'Failed to persist cover' };
      broadcastToAllWindows('project:files-changed', manifestService.getProjectPath(projectId));
      return { success: true, coverPath, data: dataUrl };
    } catch (err) { console.error('[variant:ensure-cover]', err); return { success: false, error: (err as Error).message }; }
  });

  ipcMain.handle('variant:delete', async (_event, projectId: string, variantId: string) => {
    try {
      let removed: import('./manifest-types').ProjectVariant | null = null;
      // Set true if, after removal, some OTHER surviving reference still points at
      // the deleted variant's file — in which case we must NOT unlink it, or we'd
      // destroy a file another version/output still needs. This is the invariant
      // that makes "delete one version, lose another's file" impossible.
      let stillReferenced = false;
      // The chains this delete also removes — a chain sourced on the file being
      // deleted is a chain whose source cannot exist. Files those chains still
      // recorded come off disk after the write is confirmed, never before.
      let removedChains: import('./manifest-service').RemovedGeneratedChain[] = [];
      const projectDirForDelete = manifestService.getProjectPath(projectId);
      const saved = await manifestService.modifyManifest(projectId, (mf) => {
        const cur = manifestService.getVariants(mf);
        removed = cur.variants.find((v) => v.id === variantId) || null;
        // ── The SYNTHESIZED rows must not be persisted ──────────────────────
        //
        // `getVariants` folds the archive entries into `arch:` rows that exist
        // only in its answer, and writing the whole folded list back turned every
        // one of them into a real record — so a later archive entry could never
        // become a row again, and the ghosts outlived their files. Only rows that
        // were already ON the manifest are written back; the deleted one is
        // filtered out of both.
        const recorded = new Set((mf.variants ?? []).map((v) => v.id));
        // Every version that survives, synthesized ones included: the decisions
        // below (which is primary now, is the file still referenced) are about
        // what the project HAS, and an archive mirror is one of those.
        const survivors = cur.variants.filter((v) => v.id !== variantId);
        mf.variants = survivors.filter((v) => recorded.has(v.id));
        if (mf.primaryVariantId === variantId) mf.primaryVariantId = survivors[0]?.id;
        if (removed && mf.outputs?.audiobook?.path === removed.path) {
          const next = mf.variants.find((v) => v.kind === 'audiobook' && !v.id.startsWith('bilingual:'));
          if (next) mf.outputs.audiobook = { ...mf.outputs.audiobook, path: next.path, vttPath: next.vttPath };
          else delete mf.outputs.audiobook;
        }
        // If this was a bilingual output, clear its pointer too — otherwise
        // getVariants would re-fold a ghost row for the file we're deleting.
        if (removed && mf.outputs?.bilingualAudiobooks) {
          for (const [pair, out] of Object.entries(mf.outputs.bilingualAudiobooks)) {
            if ((out as { path?: string })?.path === removed.path) delete mf.outputs.bilingualAudiobooks[pair];
          }
        }
        // Safety: only unlink the file if NOTHING else still references it. Compare
        // by normalized project-relative path (slash/case-insensitive), against the
        // surviving variants and the remaining audiobook/bilingual output pointers.
        // (The archive entry a synthesized variant mirrors is deliberately excluded:
        // an 'arch:' variant's file IS its archive file, so deleting that version
        // should still remove it.)
        if (removed) {
          const rmPath = (removed as import('./manifest-types').ProjectVariant).path;
          const norm = (p?: string): string => (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
          const target = norm(rmPath);
          const refs: Array<string | undefined> = [
            ...survivors.map((v) => v.path),
            mf.outputs?.audiobook?.path,
            ...Object.values(mf.outputs?.bilingualAudiobooks || {}).map((o) => (o as { path?: string })?.path),
          ];
          stillReferenced = !!target && refs.some((p) => norm(p) === target);

          // ── The CHAIN of custody goes with the file it hangs off ──────────
          //
          // Deleting the archive EPUB the user handed us used to filter
          // `mf.variants` and stop there: `mf.archive` kept naming the file, so
          // the project manufactured recorded-but-absent state about its own
          // original, and every chain sourced on it refused forever
          // ("Restore it from your backup…") — killing Erase changes and any
          // future re-mint, on a confirmation that promised the book EPUB was
          // being kept. `book:delete-generated-epub` learned this for the cast
          // (`removeGeneratedBookFamilies`); this sibling never did.
          //
          // Only when the file is actually going. A version whose file another
          // record still points at is not being removed from the project, so
          // nothing sourced on it has lost its source.
          if (!stillReferenced) {
            removedChains = manifestService.dropArchiveSourcedChains(
              mf, projectDirForDelete, rmPath);
          }
        }
      });
      // CRITICAL ORDERING: only unlink the file AFTER the manifest write is
      // confirmed. If the write failed (e.g. a transient lock on a synced drive),
      // surface the error and leave the file in place — never delete a file while
      // the manifest still lists it, or you get a half-applied delete (file gone,
      // version still recorded) that reads as success and corrupts the project view.
      if (!saved?.success) {
        return { success: false, error: saved?.error || 'Failed to update project — the version was not deleted.' };
      }
      const rm = removed as import('./manifest-types').ProjectVariant | null;
      if (rm && !stillReferenced) {
        try { await fs.unlink(normalizeFsPath(path.join(manifestService.getProjectPath(projectId), rm.path))); } catch { /* already gone */ }
      }
      // The working copies and narration copies of the chains that went with it.
      // Their records died in the transaction above; the files are this side of
      // the write, per the same ordering.
      for (const chain of removedChains) {
        // Same two artifacts, same one remover — see book:delete-generated-epub.
        for (const strayPath of [chain.epubAbsPath, chain.ttsAbsPath]) {
          if (strayPath !== null) await removeEpubContainer(strayPath);
        }
      }
      broadcastToAllWindows('project:files-changed', projectDirForDelete);
      return { success: true, removedChains: removedChains.map((c) => c.sourceName) };
    } catch (err) { console.error('[variant:delete]', err); return { success: false, error: (err as Error).message }; }
  });

  // Delete a finished audiobook output (the assembled .m4b) and its paired VTT, and
  // clear it from the manifest. key='mono' → outputs.audiobook; else a bilingual
  // language-pair key → outputs.bilingualAudiobooks[key]. Mirrors variant:delete's
  // manifest bookkeeping so the shelf/versions views drop the entry immediately.
  ipcMain.handle('audiobook:delete-output', async (_event, projectId: string, key: string) => {
    try {
      let target: string | undefined;   // project-relative path of the m4b to delete
      let vtt: string | undefined;      // its paired VTT, if any
      const saved = await manifestService.modifyManifest(projectId, (mf) => {
        if (!mf.outputs) return;
        if (key === 'mono') {
          target = mf.outputs.audiobook?.path;
          vtt = mf.outputs.audiobook?.vttPath;
          // Keep the variant list consistent if this m4b is also registered as one.
          if (target && Array.isArray(mf.variants)) {
            mf.variants = mf.variants.filter((v) => v.path !== target);
            if (mf.primaryVariantId && !mf.variants.some((v) => v.id === mf.primaryVariantId)) {
              mf.primaryVariantId = mf.variants[0]?.id;
            }
          }
          delete mf.outputs.audiobook;
        } else if (mf.outputs.bilingualAudiobooks?.[key]) {
          target = mf.outputs.bilingualAudiobooks[key].path;
          vtt = mf.outputs.bilingualAudiobooks[key].vttPath;
          delete mf.outputs.bilingualAudiobooks[key];
        }
      });
      // CRITICAL ORDERING (mirrors variant:delete): only unlink AFTER the manifest
      // write is confirmed. A failed write on a synced drive would otherwise leave a
      // half-applied delete — file gone, output still recorded — that reads as success.
      // Check saved BEFORE target: if the manifest READ failed, the mutator never ran
      // and target is unset — reporting "no output found" there would mask the real error.
      if (!saved?.success) {
        return { success: false, error: saved?.error || 'Failed to update project — the output was not deleted.' };
      }
      if (!target) return { success: false, error: 'No audiobook output found to delete' };
      const projectDir = manifestService.getProjectPath(projectId);
      for (const rel of [target, vtt]) {
        if (!rel) continue;
        try { await fs.unlink(normalizeFsPath(path.join(projectDir, rel))); } catch { /* already gone */ }
      }
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true };
    } catch (err) { console.error('[audiobook:delete-output]', err); return { success: false, error: (err as Error).message }; }
  });

  ipcMain.handle('variant:set-primary', async (_event, projectId: string, variantId: string) => {
    // Body lives in library-actions.setPrimaryVariant, shared with cli/library.js.
    return setPrimaryVariant(projectId, variantId);
  });

  ipcMain.handle('variant:set-professional', async (_event, projectId: string, variantId: string, value: boolean) => {
    // Body lives in library-actions.setVariantProfessional, shared with cli/library.js.
    return setVariantProfessional(projectId, variantId, value);
  });

  ipcMain.handle('variant:pull-metadata', async (_event, projectId: string, fromId: string, toId: string, fields: string[]) => {
    try {
      let applied = false;
      const saved = await manifestService.modifyManifest(projectId, (mf) => {
        const cur = manifestService.getVariants(mf);
        mf.variants = cur.variants;
        const from = mf.variants.find((v) => v.id === fromId);
        const to = mf.variants.find((v) => v.id === toId);
        if (!from || !to) return;
        applied = true;
        for (const f of fields || []) (to.metadata as Record<string, unknown>)[f] = (from.metadata as Record<string, unknown>)[f];
      });
      // saved before applied: same reasoning as variant:set-primary above.
      if (!saved?.success) return { success: false, error: saved?.error || 'Failed to update project — metadata not copied.' };
      if (!applied) return { success: false, error: `Source or target version not found (from=${fromId}, to=${toId})` };
      broadcastToAllWindows('project:files-changed', manifestService.getProjectPath(projectId));
      return { success: true };
    } catch (err) { return { success: false, error: (err as Error).message }; }
  });

  ipcMain.handle('variant:send-to-pipeline', async (_event, projectId: string, variantId: string) => {
    try {
      const got = await manifestService.getManifest(projectId);
      if (!got.manifest) return { success: false, error: 'Project not found' };
      const v = manifestService.getVariants(got.manifest).variants.find((x) => x.id === variantId);
      if (!v) return { success: false, error: 'Version not found' };
      if (v.kind !== 'ebook') return { success: false, error: 'Only ebook versions can go into the editor/TTS pipeline' };
      const projectDir = manifestService.getProjectPath(projectId);
      const ext = path.extname(v.path).toLowerCase();
      // Point the editor at the pristine archive file itself (read-only). The editor
      // writes its own export into source/; the archive file — often a rare/old book — is
      // never modified, so nothing is copied to source/original.
      const sourceAbs = normalizeFsPath(path.join(projectDir, ...v.path.split('/')));
      // Prove the file is THERE before handing it out, and before repointing the
      // project's source at it. Without this, a stale or crossed manifest path sailed
      // straight through to the editor window and died there in fs.stat as "Unable to
      // open project: <path> ENOENT" — a message that named a path the user could not
      // place — with the source pointer already rewritten to a file that isn't there.
      let sourceIsFile = false;
      try {
        sourceIsFile = (await fs.stat(sourceAbs)).isFile();
      } catch { /* reported below with the path that was missing */ }
      if (!sourceIsFile) {
        return {
          success: false,
          error: `Version "${v.path}" of project "${projectId}" is not on disk: ${sourceAbs}`,
        };
      }
      const saved = await manifestService.modifyManifest(projectId, (mf) => {
        mf.source = { ...mf.source, type: (ext === '.pdf' ? 'pdf' : 'epub') as any, originalFilename: path.basename(v.path) };
      });
      // If the source-pointer write failed, the editor would open against a stale
      // source and a later pipeline step would read the wrong file. Surface it.
      if (!saved?.success) return { success: false, error: saved?.error || 'Failed to update project source pointer.' };
      return { success: true, sourcePath: sourceAbs, projectDir };
    } catch (err) { console.error('[variant:send-to-pipeline]', err); return { success: false, error: (err as Error).message }; }
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


  // Append job analytics (handles deduplication atomically) to
  // {projectDir}/job-analytics.json — separate from the LL pipeline's
  // analytics.json, which has a different (stage-based) schema.
  ipcMain.handle('audiobook:append-analytics', async (
    _event,
    projectDir: string,
    jobType: 'tts-conversion' | 'reassembly' | 'video-assembly' | 'rvc' | 'translation',
    analytics: { jobId: string; [key: string]: unknown }
  ) => {
    const MAX_ANALYTICS_HISTORY = 10;

    // Map job type to analytics array key
    const typeToKey: Record<string, string> = {
      'tts-conversion': 'ttsJobs',
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
      const isProjectDir = fsSync.existsSync(projectDir) &&
        fsSync.statSync(projectDir).isDirectory() &&
        fsSync.existsSync(path.join(projectDir, 'manifest.json'));

      if (isProjectDir) {
        const analyticsPath = path.join(projectDir, 'job-analytics.json');
        let existing: Record<string, any> = { ttsJobs: [], reassemblyJobs: [], videoAssemblyJobs: [], rvcJobs: [], translationJobs: [] };
        try {
          existing = JSON.parse(await fs.readFile(analyticsPath, 'utf-8'));
        } catch { /* first write */ }
        await atomicWriteFile(analyticsPath, JSON.stringify(appendTo(existing), null, 2));
        return { success: true };
      }

      throw new Error(
        `Cannot save analytics for "${projectDir}": it is not a BookForge project ` +
        `directory. Legacy .bfp project files are no longer supported.`
      );
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Read job analytics for a project directory.
  ipcMain.handle('audiobook:get-analytics', async (_event, projectDir: string) => {
    try {
      if (!projectDir || !fsSync.existsSync(projectDir)) {
        return { success: true, analytics: null };
      }
      if (fsSync.statSync(projectDir).isDirectory()) {
        const analyticsPath = path.join(projectDir, 'job-analytics.json');
        if (!fsSync.existsSync(analyticsPath)) {
          return { success: true, analytics: null };
        }
        return { success: true, analytics: JSON.parse(await fs.readFile(analyticsPath, 'utf-8')) };
      }
      throw new Error(
        `Cannot read analytics for "${projectDir}": it is not a BookForge project ` +
        `directory. Legacy .bfp project files are no longer supported.`
      );
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // audiobook:copy-vtt — RETIRED (embed-only model). Transcripts now live INSIDE the
  // m4b (sealed by every assembler surface), so this no longer copies a VTT into the
  // audiobook folder or registers a sidecar vttPath — doing so was the exact anti-
  // pattern (an untrusted, mislink-prone sidecar) we removed. Kept as a no-op stub so
  // any stale caller resolves cleanly instead of hitting an unregistered channel.
  ipcMain.handle('audiobook:copy-vtt', async () => {
    return { success: true, vttPath: null, message: 'copy-vtt retired (embed-only model)' };
  });

  // Get audiobook folder path for a project
  ipcMain.handle('audiobook:get-folder', async (_event, projectDir: string) => {
    const projectName = path.basename(projectDir);
    const audiobookFolder = getAudiobookFolderForProject(projectName);
    return { success: true, folder: audiobookFolder };
  });

  // Link an audio file to a project
  ipcMain.handle('audiobook:link-audio', async (_event, projectDir: string, audioPath: string) => {
    try {
      console.log('[audiobook:link-audio] projectDir:', projectDir, 'audioPath:', audioPath);

      if (!projectDir || !audioPath) {
        return { success: false, error: 'Missing projectDir or audioPath' };
      }

      // projectDir is the project directory — derive projectId and relative audio path
      const projectId = path.basename(projectDir);
      const relativePath = path.relative(projectDir, audioPath).replace(/\\/g, '/');
      console.log('[audiobook:link-audio] projectId:', projectId, 'relativePath:', relativePath);

      // If a transcript sits next to the linked audio, SEAL it INTO the m4b (the
      // strongest link there is) and remove the loose copy — never register a
      // sidecar vttPath.
      //
      // Two things this must NOT do, both learned the hard way on Nuremberg
      // (2026-08-14):
      //  • It must not re-do work the assembler already did. The renderer calls
      //    this the moment a reassembly completes, so when reassembly had ALREADY
      //    tried to embed and fallen back to a hash-bound sidecar, this fired a
      //    SECOND full 1.4 GB remux of the same book seconds later, which failed
      //    the same way and stranded another 1.4 GB temp. A book that already has
      //    a transcript bound to these exact bytes is done; leave it alone.
      //  • It must not GUESS which .vtt is the transcript. Picking "any .vtt in
      //    the folder" is how a transcript ends up on the wrong audio. Only an
      //    unambiguous match is used; anything else is refused out loud.
      const audioDir = path.dirname(audioPath);
      const { boundSidecarVtt } = await import('./sidecar-binding.js');
      if (audioPath.toLowerCase().endsWith('.m4b')
        && !(await extractVttFromM4b(audioPath))
        && !(await boundSidecarVtt(audioPath))) {
        const dirFiles = await fs.readdir(audioDir);
        const stem = path.parse(audioPath).name;
        const candidates = dirFiles.filter(f => f.toLowerCase().endsWith('.vtt')
          && !f.startsWith('._') && !f.startsWith('bilingual-'));
        const vttFile = candidates.find(f => path.parse(f).name === stem)
          || candidates.find(f => f === 'subtitles.vtt')
          || (candidates.length === 1 ? candidates[0] : undefined);
        if (!vttFile && candidates.length > 1) {
          console.error(
            `[audiobook:link-audio] ${candidates.length} transcripts sit next to ${path.basename(audioPath)} ` +
            `and none matches its name (${candidates.join(', ')}) — refusing to guess; the linked audiobook has NO transcript.`
          );
        } else if (vttFile) {
          const vttAbs = path.join(audioDir, vttFile);
          try {
            if (await embedAndVerifyVtt(audioPath, vttAbs)) {
              deleteSidecarsForM4b(audioPath);
              console.log('[audiobook:link-audio] embedded sibling transcript into m4b:', audioPath);
            } else {
              console.error('[audiobook:link-audio] embedded transcript did not read back — linked audiobook has NO transcript:', audioPath);
            }
          } catch (embedErr) {
            // Never swallowed: this catch used to be `.catch(() => false)`, which
            // is how a failed 1.4 GB embed left no trace anywhere.
            console.error(
              `[audiobook:link-audio] embed of ${vttFile} into ${path.basename(audioPath)} failed ` +
              `(${(embedErr as Error).message}) — linked audiobook has NO transcript.`
            );
          }
        }
      }

      // Atomic read-modify-write with per-project lock. Embed-only: never register a
      // sidecar vttPath (the transcript, if any, is inside the m4b).
      const saveResult = await manifestService.modifyManifest(projectId, (manifest) => {
        if (!manifest.outputs) manifest.outputs = {};
        manifest.outputs.audiobook = {
          ...manifest.outputs.audiobook,
          path: relativePath,
          completedAt: new Date().toISOString(),
          vttPath: undefined,
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
  ipcMain.handle('media:load-image', async (_event, relativePath: string, maxWidth?: number) => {
    try {
      const base64 = await loadImageFromMedia(relativePath, maxWidth);
      if (base64) {
        return { success: true, data: base64 };
      }
      return { success: false, error: 'Image not found' };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Load many images in ONE round-trip.
   *
   * The Studio grid needs a cover for every project in the library. Asking for them
   * one at a time meant hundreds of IPC round-trips, and the renderer awaited them in
   * fixed batches — so every batch ran at the speed of its slowest cover and the
   * whole library's covers cost hundreds of sequential hops. Here they share a
   * bounded worker pool: no barriers, and the disk sees a steady queue instead of a
   * burst that a synced library's filesystem has to fight through.
   *
   * A cover that fails to load resolves to null rather than failing its neighbours —
   * one unreadable file must not cost the other 376 their thumbnails.
   */
  ipcMain.handle('media:load-images', async (_event, relativePaths: string[], maxWidth?: number) => {
    const CONCURRENCY = 8;
    const results: Record<string, string | null> = {};
    let cursor = 0;

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, relativePaths.length) }, async () => {
      while (cursor < relativePaths.length) {
        const relativePath = relativePaths[cursor++];
        try {
          results[relativePath] = await loadImageFromMedia(relativePath, maxWidth);
        } catch (err) {
          console.warn(`[media] Batch load failed for ${relativePath}:`, (err as Error).message);
          results[relativePath] = null;
        }
      }
    }));

    return { success: true, data: results };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Processing Queue handlers
  // ─────────────────────────────────────────────────────────────────────────────

  // Track running jobs for cancellation
  const runningJobs = new Map<string, { cancel: () => void; model?: string }>();

  // ─────────────────────────────────────────────────────────────────────────
  // Book Analysis handler
  // ─────────────────────────────────────────────────────────────────────────
  ipcMain.handle('queue:run-book-analysis', async (
    _event,
    jobId: string,
    source: { kind: 'document'; epubPath: string } | { kind: 'audiobook'; projectId: string; variantId: string },
    aiConfig: {
      provider: 'ollama' | 'claude' | 'openai';
      ollama?: { baseUrl: string; model: string };
      claude?: { apiKey: string; model: string };
      openai?: { apiKey: string; model: string };
      categories: Array<{ id: string; name: string; description: string; color: string; enabled: boolean }>;
      testMode?: boolean;
      testModeChunks?: number;
      target?: { versionId: string; versionType: string; versionLabel: string };
    }
  ) => {
    console.log('[IPC] queue:run-book-analysis received:', {
      jobId,
      provider: aiConfig?.provider,
      categoryCount: aiConfig?.categories?.length || 0,
      testMode: aiConfig?.testMode,
      sourceKind: source?.kind,
    });

    if (!source || (source.kind !== 'document' && source.kind !== 'audiobook') || !aiConfig) {
      const error = 'A valid source and aiConfig are required for book analysis';
      console.error('[IPC] queue:run-book-analysis ERROR:', error);
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', { jobId, success: false, error });
      }
      return { success: false, error };
    }

    try {
      const { analyzeBook, analyzeAudiobook, cancelAnalysisJob } = await import('./book-analysis.js');

      // Register cancellation
      const cancelFn = () => { cancelAnalysisJob(jobId); };
      runningJobs.set(jobId, { cancel: cancelFn, model: aiConfig.ollama?.model || aiConfig.claude?.model || aiConfig.openai?.model });

      // Document reports retain their existing canonical path. Audiobook reports
      // resolve project + variant server-side and commit through the binding protocol.
      let outputDir: string | undefined;
      let projectRoot: string | null = null;
      let result;
      if (source.kind === 'audiobook') {
        if (aiConfig.testMode) {
          throw new Error('Test mode is not available for audiobook analysis');
        }
        projectRoot = manifestService.getProjectPath(source.projectId);
        result = await analyzeAudiobook(
          source.projectId,
          source.variantId,
          jobId,
          mainWindow,
          aiConfig,
          {
            categories: aiConfig.categories,
            testMode: aiConfig.testMode || false,
            testModeChunks: aiConfig.testModeChunks,
          },
        );
      } else {
        const epubPath = source.epubPath;
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
        result = await analyzeBook(
          epubPath,
          jobId,
          mainWindow,
          aiConfig,
          {
            categories: aiConfig.categories,
            testMode: aiConfig.testMode || false,
            testModeChunks: aiConfig.testModeChunks,
            outputDir,
            target: aiConfig.target,
          },
        );
      }

      runningJobs.delete(jobId);

      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: result.success,
          outputPath: result.outputPath,
          error: result.error,
          flagCount: result.flagCount,
          contentSkipsDetected: result.contentSkipsDetected,
          contentSkipsAffected: result.contentSkipsAffected,
          skippedChunksPath: result.skippedChunksPath,
          analytics: result.analytics,
        });

        if (projectRoot) {
          broadcastToAllWindows('project:files-changed', projectRoot);
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

  // The synchronous footnote-refs door (`book:remove-footnote-references`) is
  // gone (2026-08-10): its only caller was the picker's rail entry, and the
  // rail's text passes moved to the versions page's modal, which queues every
  // pass through `processing:submit-chain` like the others.

  // ── Processing passes ───────────────────────────────────────────────────
  // ONE run handler for all five pass types: the pass kind is in the config, and
  // every pass has the same contract (transform the project's book, leave a diff,
  // record itself). See electron/processing-passes.ts.
  ipcMain.handle('queue:run-pass', async (
    _event, jobId: string, config: import('./processing-passes.js').PassJobConfig) => {
    try {
      const { runProcessingPass } = await import('./processing-passes.js');
      const { passResultNotes } = await import('../shared/processing/pass-notes.js');
      const result = await runProcessingPass(jobId, config, mainWindow);
      // The broadcast is the FALLBACK completion signal — the renderer's awaited
      // return value is the usual one — so it carries the pass's sentences too.
      // A pass whose ledger refusal reached the user down one path and not the
      // other would make the explanation depend on which signal won the race.
      const notes = passResultNotes(result);
      mainWindow?.webContents.send('queue:job-complete', {
        jobId,
        success: result.success,
        outputPath: result.outputPath,
        error: result.error,
        ...(notes.length > 0 ? { completionNotes: notes } : {}),
      });
      if (result.success) broadcastToAllWindows('project:files-changed', config.projectDir);
      return { success: result.success, data: result };
    } catch (err) {
      const error = (err as Error).message;
      mainWindow?.webContents.send('queue:job-complete', { jobId, success: false, error });
      return { success: false, error };
    }
  });

  /**
   * Plan a run without queueing it — what these passes, in this order, would do.
   * The wizard uses it to show the plan and to refuse an impossible ordering
   * while the user is still composing it.
   */
  ipcMain.handle('processing:plan-chain', async (
    _event, request: import('./processing-chain.js').ProcessingChainRequest) => {
    try {
      const { planProcessingChain } = await import('./processing-chain.js');
      return { success: true, plan: await planProcessingChain(request) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * THE submission entry point for a processing run.
   *
   * Main plans (it is the side that knows the manifest, the run directory and the
   * page count) and the renderer enqueues, because the queue itself lives there —
   * one `queue:enqueue-chain` message carrying the whole plan, so the jobs land
   * in one batch and in order. A window that is not there is an error, not a
   * silently dropped run.
   */
  ipcMain.handle('processing:submit-chain', async (
    _event, request: import('./processing-chain.js').ProcessingChainRequest) => {
    try {
      const { planProcessingChain } = await import('./processing-chain.js');
      const plan = await planProcessingChain(request);
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('BookForge has no open window to queue this run in.');
      }
      mainWindow.webContents.send('queue:enqueue-chain', plan);
      return { success: true, plan };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Start a book over: delete every trace of processing and leave the source.
   *
   * ONE call answers both questions the UI has. `preview: true` returns exactly
   * the item list a real reset would act on, without writing anything, so the
   * confirmation dialog names the real files and the affordance can disable
   * itself when there is nothing to reset. Main resolves the run directory, the
   * stage directories and the book EPUB itself — the renderer sends a project
   * and nothing else.
   */
  ipcMain.handle('processing:reset-book', async (
    _event, request: { projectDir: string; preview?: boolean }) => {
    try {
      const { resetBookProcessing } = await import('./processing-reset.js');
      const summary = await resetBookProcessing(request.projectDir, { preview: request.preview });
      if (!summary.preview) broadcastToAllWindows('project:files-changed', summary.projectDir);
      return { success: true, summary };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** Which passes of this project left a diff, in execution order. */
  ipcMain.handle('processing:list-pass-diffs', async (
    _event, projectDir: string, familyId?: string) => {
    try {
      return { success: true, diffs: await manifestService.listPassDiffs(projectDir, familyId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** One pass diff, by its own path. Self-contained — it carries its after-text. */
  ipcMain.handle('diff:load-pass-file', async (_event, diffPath: string) => {
    try {
      const { loadDiffFileAt } = await import('./diff-cache.js');
      return { success: true, data: await loadDiffFileAt(diffPath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── Convert to EPUB, and the narration copy ─────────────────────────────
  //
  // The OTHER route to a book: `foundry vlm-convert` hands each page picture to
  // a document vision model and assembles the answers into an EPUB. What it
  // writes is the project's book, complete. What the user does not want narrated
  // is struck out of it in the picker and exported as a SECOND file — the book
  // itself is never rewritten. See electron/vlm-convert.ts and
  // electron/narration-export.ts; the deletion contract is
  // shared/vlm/narration-deletions.ts.
  //
  // A dedicated pair rather than a pass: a conversion is where a book comes
  // FROM, so it has nothing to read, nothing to diff against, and no legal
  // position in a chain. The planner never sees it.

  /**
   * Convert this project's PDF into its book. Long — ninety minutes for a
   * 300-page book on an M1 Ultra — and owned by MAIN, so a renderer reload
   * cannot kill it. Progress arrives on `document:stage-progress`; a second
   * conversion of the same project is refused by name by the stage registry.
   */
  ipcMain.handle('vlm:convert', async (
    _event, request: import('../shared/vlm/conversion').VlmConvertRequest) => {
    try {
      const { runVlmConversion } = await import('./vlm-convert.js');
      const result = await runVlmConversion(request);
      broadcastToAllWindows('project:files-changed', request.projectDir);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * What page answers are already banked for this book's PDF, and whether the
   * run that banked them FINISHED.
   *
   * Asked at the moment a conversion is committed to — added to the queue, or
   * started from the Versions page — so the user can be shown the facts and
   * choose. Answered by main because only main knows where the bank lives, what
   * the PDF hashes to, and what this project's provenance records. The whole
   * rule lives in shared/vlm/readings-bank.ts; this handler only measures.
   */
  ipcMain.handle('vlm:readings-bank', async (
    _event, request: import('../shared/vlm/conversion').VlmConvertRequest) => {
    try {
      const { inspectVlmReadingsBank } = await import('./vlm-convert.js');
      return { success: true, bank: await inspectVlmReadingsBank(request) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Is the configured VLM endpoint up, and what is it serving?
   *
   * The Test button in Settings → AI → Reading pages. It runs here rather than
   * in the renderer because a page fetching somebody's vLLM would be a
   * cross-origin request and would fail for reasons that say nothing about
   * whether the server is running.
   */
  ipcMain.handle('vlm:check-endpoint', async (
    _event, config: import('../shared/vlm/conversion').VlmEndpointConfig) => {
    try {
      const { checkVlmEndpoint } = await import('./vlm-convert.js');
      return { success: true, check: await checkVlmEndpoint(config) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Why this machine cannot serve the page reader from WSL, or null when it can.
   *
   * The renderer cannot work this out for itself: it is a question about
   * tool-paths.json and the host platform, and both live here. Every surface
   * that has to say whether a conversion is possible — the picker's Convert
   * action, the Reading pages card — asks this and feeds it to the same
   * `resolveVlmRoute` the run uses, which is what stops a card promising a route
   * the run then denies.
   */
  ipcMain.handle('vlm:reader-status', async () => {
    try {
      const { wslVlmRefusal, vlmPageServerStatus } = await import('./vlm-page-server.js');
      return { success: true, wslRefusal: wslVlmRefusal(), server: vlmPageServerStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Give me this project's working copy, making it if it does not exist.
   *
   * The banner's "Create working copy" button, and the same call the project's
   * own opening makes (`projects:export-info`) — one seam, so a copy made by
   * hand and a copy made automatically are the same act with the same name and
   * the same legacy edits carried into it.
   *
   * It REFUSES by name (`ensureBookEpub`'s own sentence) a project with nothing
   * archive-grade to copy — a PDF whose pages have never been read. Reading them
   * is what makes that book, and this is not a second, silent way to end up with
   * something to narrate. A PDF that HAS been read is minted from its generated
   * book like any other project, which is what makes erasing a PDF book's changes
   * cost a file copy rather than an hour of GPU.
   */
  ipcMain.handle('book:ensure-working-copy', async (
    _event,
    projectDir: string,
    familyId?: string
  ) => {
    try {
      const book = await manifestService.ensureBookEpub(projectDir, familyId);
      await nameOpeningsOfRemintedCopy(projectDir, book.remint, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      // The re-mint travels back from here too, for the same reason it travels
      // back from `projects:export-info`: this IS that call, reached by hand.
      // A door that made the copy again in silence would be exactly the bug the
      // other door no longer has.
      return { success: true, path: book.absPath, relPath: book.relPath, remint: book.remint };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Erase changes made to this book, ON PURPOSE, at one of two SCOPES.
   *
   * ── Why this is a button and not a new mechanism ────────────────────────────
   *
   * Deleting `source/<archive basename>.working.epub` in Explorer already does
   * this: the next thing that asks for the book finds the record naming a file
   * that is not there, clears everything recorded against it and mints a fresh
   * byte-identical copy (`ensureBookEpub`). Owen, 2026-08-09: "the thing they
   * 'delete' is actually the changes, not the working copy… if that means
   * deleting the working copy and copying over a new one, thats fine."
   *
   * So this handler does exactly that and nothing else — unlink, then the SAME
   * `ensureBookEpub` + `nameOpeningsOfRemintedCopy` the automatic path runs. A
   * second reset-and-mint written here is how the button and the file deletion
   * would come to mean two different things, which is the failure the one shared
   * reset (`resetEditorRecords`) was pulled out to prevent in the first place.
   *
   * ── The two scopes, and why the second one is ONE extra line ───────────────
   *
   * A book can carry two kinds of change (shared/document/book-ledger.ts): the
   * user's WORKING CHANGES, which are records, and the LEDGER — passes that
   * rewrote the book's bytes and each kept a snapshot. Owen's truth table: "if
   * they delete working changes but keep footnotes, the working copy will have no
   * changes except footnotes removed. if they delete footnotes AND working
   * changes, itll be byte identical to the archive copy."
   *
   *  - `working-changes` — the records go, the passes stand. `ensureBookEpub`
   *    already derives the fresh copy from the last ledger snapshot, so this is
   *    literally the unchanged code path.
   *  - `everything` — the ledger is thrown away FIRST (`clearBookLedger`:
   *    entries, then snapshots and frozen diffs), and the very same code path
   *    then finds an empty ledger and derives from the archive-grade base. One
   *    mint, one reset, one naming pass, in both scopes.
   *
   * The scope is REQUIRED. A renderer that does not send one is an older build
   * asking for an act whose meaning has changed, and guessing "everything" for it
   * would delete a user's passes on a button that no longer says it will.
   *
   * ── Refused before anything is destroyed ────────────────────────────────────
   *
   * The source is resolved FIRST. A project with nothing archive-grade behind its
   * working copy — a PDF whose pages have never been read, one whose archive EPUB
   * has been moved away — would have its only book deleted and nothing to make
   * another from, so it is refused by name with the file still on disk.
   *
   * The editor window goes the same way it goes for the rail's button, and for
   * the same reason: its autosave would put the records straight back.
   */
  ipcMain.handle('book:erase-changes', async (
    _event,
    rawProjectDir: string,
    scope: 'everything' | 'working-changes',
    familyId?: string
  ) => {
    try {
      if (scope !== 'everything' && scope !== 'working-changes') {
        return {
          success: false,
          error: 'Erase was asked for without saying how much: a book\'s working changes and the '
            + `passes recorded in its ledger are erased separately, and "${String(scope)}" is `
            + 'neither "everything" nor "working-changes". Reload the window — this is an older '
            + 'build\'s call.',
        };
      }
      const projectDir = normalizeFsPath(rawProjectDir);
      // The CHAIN's own source, not the project's: with several versions in one
      // project, "what does this erase go back to" has one answer per version.
      const source = await manifestService.requireFamilySource(projectDir, familyId);
      const existing = await manifestService.readExportEpub(projectDir, familyId);
      if (existing === null) {
        return {
          success: false,
          error: `${path.basename(projectDir)} has no working copy recorded, so there are no changes `
            + 'to erase. Open the book once and it will be made.',
        };
      }

      destroyEditorWindowsFor(rawProjectDir, projectDir);

      // Records first, files last, and the ledger before the book: with the
      // entries gone the mint below derives from the archive-grade base, which
      // is what makes "everything" mean byte-identical to the original.
      const ledger = scope === 'everything'
        ? await manifestService.clearBookLedger(projectDir, familyId)
        : {
          dropped: [],
          kept: await manifestService.readBookLedger(projectDir, familyId),
          removedPaths: [],
        };

      // Whichever container this book is in. A working copy is a FOLDER of the
      // book's parts now, and `unlink` cannot take one away — the erase would
      // fail here, or worse succeed at nothing and let the re-mint below decide
      // the copy was still there.
      await removeEpubContainer(existing.absPath);

      const book = await manifestService.ensureBookEpub(projectDir, familyId);
      if (book.remint === null) {
        // Unreachable: the record was there a moment ago and its file is not, so
        // `ensureBookEpub` re-minted. Said out loud rather than papered over —
        // a null receipt here would mean the copy came back without the records
        // being cleared, which is the exact bug this act exists to make
        // impossible.
        //
        // The BROADCAST goes first all the same: by this point the ledger has
        // been cleared and the copy re-minted, so every window drawing this
        // project is showing a book that no longer exists. Returning the refusal
        // without it left them all stale — and the state this refusal describes
        // is exactly the one where a stale window is most dangerous.
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: false,
          error: `${path.basename(projectDir)}'s working copy was replaced, but BookForge cannot `
            + 'account for what was cleared with it. Check the console before editing this book.',
        };
      }
      await nameOpeningsOfRemintedCopy(projectDir, book.remint, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true,
        path: book.absPath,
        relPath: book.relPath,
        remint: book.remint,
        // Which book the user has landed on, so the caller can name it. The two
        // are different things to have gone back to, and only this side knows
        // which this project has.
        source: source.kind,
        // What the scope cost and what it left, by label. The receipt already
        // says it in a sentence; these are for a caller that wants to list rows.
        droppedLedger: ledger.dropped.map((entry) => entry.label),
        keptLedger: ledger.kept.map((entry) => entry.label),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Delete ONE entry from this book's ledger — and everything applied after it.
   *
   * The row under the book that says "Simplify" is this. Deleting it re-derives
   * the working copy from the snapshot before it (or from the archive-grade base
   * when it is the first), and the user's WORKING CHANGES are deliberately left
   * alone: they are records keyed to element positions that a ledger pass may not
   * move, so they describe the re-derived book exactly as they described the old
   * one. Owen: "if they delete footnotes, itll only have working changes present.
   * like chapter renaming, deletions, etc."
   *
   * The CASCADE is named in the answer, entry by entry, because it is the part a
   * user cannot infer from the row they pressed: each snapshot was produced from
   * the one before it, so there is no book on this disk with a middle entry
   * removed and the later ones still applied. Owen licensed exactly that — "if it
   * isnt [possible], we can remove both, like a cascade of changes" — and the
   * confirmation is owed the list.
   *
   * The whole decision is `ledgerAfterDeleting`, pure and tested without a
   * project, so the confirmation the UI shows and the deletion that happens
   * cannot disagree about what is going.
   */
  ipcMain.handle('book:delete-ledger-entry', async (
    _event,
    rawProjectDir: string,
    entryId: string,
    familyId?: string
  ) => {
    try {
      const projectDir = normalizeFsPath(rawProjectDir);
      // The same staleness guard the erase acts take: an open editor window would
      // autosave its in-memory state over a manifest that has just been rewritten.
      destroyEditorWindowsFor(rawProjectDir, projectDir);

      const deletion = await manifestService.deleteLedgerEntry(projectDir, entryId, familyId);
      // A fresh copy of the book is a fresh set of chapter openings, exactly as
      // after any other mint — idempotent, and derived from the chapter titles
      // this project stores rather than from anything the deletion knew.
      await nameOpeningsOfFreshCopy(projectDir, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true,
        path: deletion.book.absPath,
        relPath: deletion.book.relPath,
        message: deletion.message,
        // Every entry that went, oldest first — the named one is the first of
        // them and the rest are the cascade.
        deleted: deletion.dropped.map((entry) => ({
          id: entry.id, kind: entry.kind, label: entry.label, createdAt: entry.createdAt,
        })),
        kept: deletion.kept.map((entry) => ({
          id: entry.id, kind: entry.kind, label: entry.label, createdAt: entry.createdAt,
        })),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * The two books a pass sits between, so the user can look at what it did.
   *
   * ── A READ, and the reason that is the whole design ─────────────────────────
   *
   * `manifestService.comparePassBooks` resolves two paths and proves they are on
   * disk. Nothing is minted, nothing is registered, no editor window is
   * destroyed and no project is bound to anything — deliberately unlike every
   * neighbour in this file, which is why this handler is three lines long. A
   * ledger line's Open was REMOVED because opening a snapshot bound the project
   * to a document the picker could not vouch for and destroyed an evening of
   * working changes; a surface that only reads those bytes is safe for exactly
   * the reason that one was not, and it stays safe only while both halves —
   * this handler and the window it feeds — go on writing nothing.
   *
   * WHICH two books is `deriveWorkingCopy`'s contract, argued where it can be
   * read beside the derivation itself (electron/manifest-service.ts).
   */
  ipcMain.handle('book:compare-pass', async (
    _event,
    rawProjectDir: string,
    entryId: string,
    familyId?: string
  ) => {
    try {
      const comparison = await manifestService.comparePassBooks(
        normalizeFsPath(rawProjectDir), entryId, familyId);
      return { success: true, comparison };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Delete the book cast from this project's pages — the heavy act.
   *
   * Not the same act as erasing changes, and the whole point of separating the
   * two: erasing changes costs a file copy, and this costs the hour of GPU that
   * read the pages. The generated book is what every future working copy is
   * minted from, so a working copy that outlived it would be a book the project
   * could never make again — it goes too.
   *
   * ORDERING, and it is this codebase's ordering everywhere: records first, files
   * last. A failure part-way leaves unrecorded strays (invisible to every
   * consumer) rather than records vouching for files that are gone.
   */
  ipcMain.handle('book:delete-generated-epub', async (
    _event,
    rawProjectDir: string,
    familyId?: string
  ) => {
    try {
      const projectDir = normalizeFsPath(rawProjectDir);
      const generated = await manifestService.readGeneratedEpub(projectDir);
      if (generated === null) {
        return {
          success: false,
          error: `${path.basename(projectDir)} has no generated book recorded, so there is nothing `
            + 'to delete. The record is the only thing that says a project has one.',
        };
      }

      destroyEditorWindowsFor(rawProjectDir, projectDir);

      // The working copy first, through the one path that removes a book: its
      // record, the passes applied to it, the stage directories those passes
      // wrote, and the bindings that vouch for it. A project with no book
      // recorded has none of that to drop, which is an ordinary state here.
      const book = await manifestService.readExportEpub(projectDir, familyId);
      let droppedPasses = 0;
      // The narration copy `forgetEpubExport` also drops the record of. It has
      // to come back FROM that call: the transaction deletes `ttsEpub` with the
      // book it was cut from, so anything asking the manifest afterwards — as
      // `removeGeneratedBookFamilies` below does — reads null and leaves a whole
      // book on disk that nothing records, invisible and silently overwritten by
      // the next export.
      let narrationStray: string | null = null;
      if (book !== null) {
        const forgotten = await manifestService.forgetEpubExport(projectDir, familyId);
        droppedPasses = forgotten.droppedPasses;
        narrationStray = forgotten.ttsAbsPath;
        // The book through `removeEpubContainer` — it is a folder of its parts —
        // and the narration copy through `unlink`, because a `.tts.epub` is an
        // archive and stays one (it is handed to ebook2audiobook, which parses a
        // zip).
        await removeEpubContainer(forgotten.absPath);
        if (narrationStray !== null && fsSync.existsSync(narrationStray)) {
          await fs.unlink(narrationStray);
        }
      }

      // The chains that hang off the cast go with it, BEFORE the cast's own
      // record: a family whose source is a book the project no longer records
      // is a chain whose source cannot exist, which is precisely the state the
      // versions page refuses by name (found live 2026-08-10). Their book and
      // narration records die in the same transaction; any files those records
      // still vouched for are unlinked here — the common case has none, because
      // `forgetEpubExport` above already took the working copy.
      const removedChains = await manifestService.removeGeneratedBookFamilies(projectDir);
      for (const chain of removedChains) {
        // The chain's working copy is a folder of the book's parts; its narration
        // copy is an archive. `removeEpubContainer` is honest about both.
        for (const strayPath of [chain.epubAbsPath, chain.ttsAbsPath]) {
          if (strayPath !== null) await removeEpubContainer(strayPath);
        }
      }

      const forgottenGenerated = await manifestService.forgetGeneratedEpub(projectDir);
      let fileRemoved = false;
      if (fsSync.existsSync(forgottenGenerated.absPath)) {
        await fs.unlink(forgottenGenerated.absPath);
        fileRemoved = true;
      }

      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true,
        removed: {
          relPath: forgottenGenerated.relPath,
          fileRemoved,
          workingCopyRelPath: book === null ? null : book.relPath,
          narrationCopyRemoved: narrationStray !== null,
          droppedPasses,
          removedChains: removedChains.map((chain) => chain.sourceName),
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Delete the narration copy — record first, file last.
   *
   * Owen, 2026-08-10: "if i want to delete the tts file i can." The versions
   * page used to refuse this delete because a generic file remove would have
   * left `outputs.ttsEpub` naming a path with nothing behind it; the honest
   * answer was never a refusal, it was a remover that clears the record. The
   * copy is the cheapest artifact in the project — Export TTS copy cuts it
   * again from the book and the strikes, which this does not touch.
   */
  ipcMain.handle('book:delete-tts-copy', async (
    _event,
    rawProjectDir: string,
    familyId?: string
  ) => {
    try {
      const projectDir = normalizeFsPath(rawProjectDir);
      const forgotten = await manifestService.forgetNarrationEpub(projectDir, familyId);
      // The copy may be ON SCREEN — deleting it is offered right beside
      // previewing it. An unlink under this process's own open zip reader
      // leaves the name in Windows delete-pending limbo, where even `stat`
      // answers EPERM until the app exits (Owen hit exactly that on
      // 2026-08-12: delete mid-preview, then every re-export refused). The
      // writer closes the reader first.
      const { closeViewerDocumentsFor } = await import('./quire-viewer-bridge.js');
      const closed = await closeViewerDocumentsFor(forgotten.absPath);
      if (closed > 0) {
        console.log(`[delete-tts] closed ${closed} viewer document(s) holding `
          + `${forgotten.relPath} before deleting it.`);
      }
      let fileRemoved = false;
      if (fsSync.existsSync(forgotten.absPath)) {
        await fs.unlink(forgotten.absPath);
        fileRemoved = true;
      }
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, removed: { relPath: forgotten.relPath, fileRemoved } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * The file TTS reads, cut from the working copy if there is not a current one.
   *
   * The Process flow's first act. It replaced a control asking WHICH EPUB to
   * narrate: there is one answer (`ensureNarrationEpub`), so the question was
   * only ever a way to narrate the wrong file.
   */
  ipcMain.handle('narration:ensure-copy', async (
    _event, projectDir: string, familyId?: string) => {
    try {
      const { ensureNarrationEpub } = await import('./narration-export.js');
      const answer = await ensureNarrationEpub(projectDir, undefined, familyId);
      if (answer.cutReason !== null) broadcastToAllWindows('project:files-changed', projectDir);
      // WHICH chain answered, said back. A caller that asked without naming one
      // learns which it got, and can carry it into the run it is about to queue
      // — the narration jobs have to name a chain, and the alternative is asking
      // the project again later and getting a different answer if a second
      // version has appeared in between. Resolved through the SAME chokepoint,
      // so the two answers cannot disagree.
      const { family } = await manifestService.requireFamily(projectDir, familyId);
      return { success: true, narration: answer, familyId: family.id };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /** The book, whether a VLM read it, and what has been struck out of it. */
  ipcMain.handle('narration:state', async (
    _event, projectDir: string, familyId?: string) => {
    try {
      const { readNarrationState } = await import('./narration-export.js');
      return { success: true, state: await readNarrationState(projectDir, familyId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * ONE GESTURE, applied to the record. The book on disk is not touched.
   *
   * The picker's whole strike path. It sends what a gesture CHANGED — the
   * elements it struck and the elements it put back — and this reads, modifies
   * and writes the record in one `modifyManifest` transaction. The record is the
   * state; the editor's deletion sets are a view of it.
   *
   * Deliberately not "here is what is struck now": that shape made the renderer's
   * volatile view the authority over a durable record, and a view that had just
   * been reset wrote an empty book's worth of strikes over an evening's work.
   */
  ipcMain.handle('narration:edit-deletions', async (
    _event, projectDir: string, edit: { strike: string[]; unstrike: string[] },
    familyId?: string) => {
    try {
      const { editNarrationDeletions } = await import('./narration-export.js');
      const deletions = await editNarrationDeletions(projectDir, edit, familyId);
      // A strike can MINT a working copy on its way past (the record lives on
      // the chain's book, and a chain with no copy yet gets one), and it always
      // changes what the narration cut will contain — so every window that draws
      // this project is told, not just the one that struck.
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, deletions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * ONE GESTURE, made on the TTS COPY, applied to the book's record.
   *
   * The copy is where a stray footnote is finally visible, and Owen ratified the
   * rule for deleting one there on 2026-08-09: it must write a RECORD as well as
   * change the file, because the copy is re-cut from the book and the record on
   * every export, so a file-only edit would be undone by the next one.
   *
   * `strikeInNarrationCopy` translates the copy's element keys into the book's,
   * strikes them through the same transaction the working-copy view uses, and
   * cuts the copy again through `writeNarrationEpub` — the only thing allowed to
   * write that file. It refuses BY NAME rather than guessing when the copy on
   * disk and the book have come apart.
   */
  ipcMain.handle('narration:strike-in-copy', async (
    _event, projectDir: string, copyKeys: string[], familyId?: string) => {
    try {
      const { strikeInNarrationCopy } = await import('./narration-export.js');
      const result = await strikeInNarrationCopy(projectDir, copyKeys, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Fold a chapter's opening IN THE BOOK: the opening is rewritten to say the
   * chapter's stored name, and the elements folded into it are removed from the
   * markup.
   *
   * The one gesture that EDITS the working copy's own elements rather than
   * recording something about them. It is allowed because the manifest keeps a
   * record of what each folded element said and what the opening says now
   * (`outputs.epub.bookEdits`), written in the same transaction that carries the
   * positional strike record across the renumbering the fold causes. The archive
   * original is never opened.
   */
  ipcMain.handle('book:merge-chapter-opening', async (
    _event, projectDir: string, openerKey: string, foldedKeys: string[],
    familyId?: string) => {
    try {
      const { mergeChapterOpening } = await import('./narration-export.js');
      const result = await mergeChapterOpening(projectDir, openerKey, foldedKeys, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Replace the record wholesale.
   *
   * Not the picker's path any more — see `narration:edit-deletions`. Kept for
   * callers that own the entire answer rather than a gesture's worth of it.
   */
  ipcMain.handle('narration:save-deletions', async (
    _event, projectDir: string, elements: string[], familyId?: string) => {
    try {
      const { saveNarrationDeletions } = await import('./narration-export.js');
      const deletions = await saveNarrationDeletions(projectDir, elements, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, deletions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Write the narration copy from the strikes as recorded.
   *
   * Takes no deletion list: the manifest is the state (see
   * `exportNarrationEpub`), so the file's contents are always explained by a
   * record. `options` carries the one thing the record does NOT describe —
   * whether the digits-only `<sup>` footnote references come out.
   */
  ipcMain.handle('narration:export', async (
    _event, projectDir: string, options?: { stripSupMarkers?: boolean }, familyId?: string
  ) => {
    try {
      const { exportNarrationEpub } = await import('./narration-export.js');
      const result = await exportNarrationEpub(projectDir, options, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * What the project's book calls each of its chapters.
   *
   * The picker's Chapter tab asks this for a converted book: the blocks on
   * screen are the chapter OPENINGS (`data-bf-cat="chapter"`), and the book's
   * table of contents — its EPUB 3 nav, its EPUB 2 NCX, or both — is what those
   * openings are CALLED, the title an audiobook is built from. `titles: null`
   * means the project has no book yet, which is a state and not a failure.
   */
  ipcMain.handle('book:chapter-titles', async (
    _event, projectDir: string, familyId?: string) => {
    try {
      const { readBookChapterTitles } = await import('./book-chapters.js');
      return { success: true, titles: await readBookChapterTitles(projectDir, familyId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Rename one chapter, in the book itself.
   *
   * Every table of contents the book carries, and the chapter document's
   * `<title>`; AND — since 2026-08-09 — the chapter's OPENING, which is the
   * print. Owen: "if the user changes the text of the chapter name, it updates
   * the chapter opener to reflect that accurately." That is not a second edit
   * to keep in step with the first: the naming pass derives every opening from
   * the nav titles this rename has just rewritten, so it is the same one rule
   * running again over a book that changed, with no rename-specific logic at
   * all (electron/narration-export.ts, `nameChapterOpenings`).
   *
   * ORDER matters and is the reason this is not two handlers. The rename
   * re-stamps the narration strike record onto its own new bytes; the naming
   * pass then changes those bytes again and re-stamps again. Run the other way
   * round — or concurrently — one of them would read a stamp the other had
   * already moved and refuse. The naming pass's own refusal is caught here
   * rather than reported as a rename failure, because by then the rename has
   * landed and saying otherwise would be a lie about the file on disk.
   *
   * The pass can DECLINE one chapter — its document marks no opening, or the
   * opening holds a picture — and then the contents say the new name while the
   * page still prints the old heading. That is reported per chapter, in the
   * pass's own words (`openingUnnamed`), because a count of openings rewritten
   * across the whole book cannot answer it and the window used to say nothing.
   *
   * See electron/book-chapters.ts for why the narration records move with the
   * rename, and why renaming only one of two lists is refused.
   */
  ipcMain.handle('book:rename-chapter', async (
    _event, projectDir: string, file: string, title: string, familyId?: string) => {
    try {
      const { renameBookChapter } = await import('./book-chapters.js');
      const result = await renameBookChapter(projectDir, file, title, familyId);

      let openingsNamed = 0;
      // Null once the pass has run and this chapter's own opening reads its new
      // name. The picker says this sentence and nothing else about it — see
      // shared/document/chapter-opening-report.ts for why silence was the bug.
      let openingUnnamed: string | null = null;
      // Every entry of the book these two edits between them rewrote. The
      // window lays exactly these out again rather than re-opening the book, so
      // the list has to be the WHOLE truth: the rename's tables of contents and
      // chapter document, plus every document whose opening the naming pass
      // changed — which is a different set, and can include chapters nobody
      // renamed, because the pass normalizes the whole book.
      const rewrittenEntries = new Set(result.rewrittenEntries);
      try {
        const { nameChapterOpenings } = await import('./narration-export.js');
        const summary = await nameChapterOpenings(projectDir, familyId);
        openingsNamed = summary.edited;
        openingUnnamed = chapterOpeningRefusal(summary, file);
        for (const edit of summary.named) rewrittenEntries.add(edit.file);
      } catch (err) {
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: false,
          error:
            `That chapter is now called "${title}" in the book, but its opening could not be `
            + `rewritten to match, so the page still prints the old heading: `
            + `${(err as Error).message}`,
        };
      }

      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true, result, openingsNamed, openingUnnamed,
        rewrittenEntries: [...rewrittenEntries],
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * List one of the book's documents as a chapter, under a name.
   *
   * The other half of `book:rename-chapter`, and the one that did not exist: a
   * rename replaces an entry the table of contents already carries, and a
   * document it lists nowhere has none to replace. That was a dead end wherever
   * the app told a user to "rename the chapter to give it one" — the Chapter
   * tab's unlisted rows, and the relabel below. See electron/book-chapters.ts.
   *
   * There is no naming pass to run afterwards HERE: unlike a rename, the add
   * runs it itself, because a chapter that has only just been given a name and
   * whose opening still prints the scan's heading is a half-finished act rather
   * than a normalization that can wait. So the answer already carries
   * `openingsNamed`, `openingUnnamed` and every entry the whole gesture rewrote.
   */
  ipcMain.handle('book:add-chapter', async (
    _event, projectDir: string, file: string, title: string, familyId?: string) => {
    try {
      const { addBookChapter } = await import('./book-chapters.js');
      const result = await addBookChapter(projectDir, file, title, familyId);
      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true, result,
        openingsNamed: result.openingsNamed,
        openingUnnamed: result.openingUnnamed,
        rewrittenEntries: result.rewrittenEntries,
      };
    } catch (err) {
      // The add is one transaction and its refusals all say "nothing was
      // written" — bar the one that says the entry landed and the opening did
      // not, which is the add's own sentence and is shown verbatim.
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Say what one element of the book IS — the picker's category palette, for a
   * book.
   *
   * The second gesture that edits the working copy's own markup, and it exists
   * because the first version of it did not. A relabel used to be recorded on
   * the picker's side only, so the book still said what it always said and every
   * derivation that reads the book — the naming pass most of all — kept
   * answering out of the original markup (Owen, 2026-08-10: "it apparently didnt
   * actually change it to chapter, just visually?"). It is allowed to edit the
   * book for the same reason the fold is: the manifest records what the element
   * was and what it is now (`outputs.epub.bookEdits`), and the archive original
   * is never opened. See electron/book-categories.ts.
   *
   * ORDER matters and is why this is not two handlers, exactly as with
   * `book:rename-chapter`. The relabel re-stamps the narration strike record
   * onto its own new bytes; the naming pass may then change those bytes again
   * and re-stamp again. Run the other way round — or concurrently — one would
   * read a stamp the other had already moved and refuse.
   *
   * THE NAMING PASS RUNS AFTER, and that is the point of a promotion. Naming a
   * chapter's opening is a normalization the project's open already performs
   * over every chapter (`nameChapterOpenings`); promoting a block to `chapter`
   * makes a new element the opening of its document, so the same rule has to run
   * again over the book that changed — with no relabel-specific logic at all.
   * Its refusal is caught rather than reported as a relabel failure, because by
   * then the relabel has landed and saying otherwise would be a lie about the
   * file on disk.
   *
   * `openingUnnamed` is said ONLY for a promotion to `chapter`, and only when
   * the page did not follow. For a demotion, "this document marks no chapter
   * opening" is precisely what the user just asked for, and saying it back to
   * them would be noise.
   *
   * ── `chapterName`: the promotion and the listing as ONE gesture ───────────
   *
   * Promoting a block to `chapter` in a document the table of contents does not
   * list used to end in advice nothing could follow — "Rename the chapter to
   * give it one", and the rename refused every unlisted document. With a name in
   * hand this handler does the listing too (`addBookChapter`), so the user's one
   * gesture ends with the book calling that document a chapter, naming it, and
   * printing the name on the page.
   *
   * LISTEDNESS IS RE-CHECKED HERE, off the book, before anything is written. The
   * window asks for the name because a previous answer said the document was
   * unlisted, and between the two the book may have gained an entry; acting on
   * the window's belief would insert a second entry for a chapter that already
   * has one. A name for a document that IS listed is refused, and a name at all
   * for anything but a promotion to `chapter` is refused, both before the
   * category is written — a refusal must leave the project as it found it.
   */
  ipcMain.handle('book:set-block-category', async (
    _event, projectDir: string, elementKey: string, categoryId: string,
    familyId?: string, chapterName?: string) => {
    try {
      const { addBookChapter, readBookChapterTitles } = await import('./book-chapters.js');

      /** What the BOOK says about this document's entry, asked rather than assumed. */
      const namedInContents = async (file: string): Promise<boolean> => {
        const titles = await readBookChapterTitles(projectDir, familyId);
        const row = titles?.chapters.find((c) => c.file === file);
        return row !== undefined && row.navTitle.trim().length > 0;
      };

      if (chapterName !== undefined) {
        if (categoryId !== 'chapter') {
          return {
            success: false,
            error:
              `A chapter name was given for a block being labelled ${categoryId}, and only a `
              + 'chapter opening has one — the name belongs to the chapter its document is, not to '
              + 'the block. Nothing was written.',
          };
        }
        const file = parseNarrationElementKey(elementKey).file;
        if (await namedInContents(file)) {
          return {
            success: false,
            error:
              `${file} is already listed under a name in this book's table of contents, so it `
              + 'cannot be listed again — a second entry would show the same chapter twice. '
              + 'Rename the chapter instead. Nothing was written.',
          };
        }
      }

      const { setBookBlockCategory } = await import('./book-categories.js');
      const result = await setBookBlockCategory(projectDir, elementKey, categoryId, familyId);

      // Every entry of the book this ONE gesture rewrote — the relabelled
      // document, and below it whatever the listing and the naming pass touched.
      // The window lays exactly these out again instead of re-opening the book,
      // so the list has to be the whole truth.
      const rewrittenEntries = new Set<string>(result.written ? [result.file] : []);

      if (chapterName !== undefined) {
        // The book already carries the category; what is missing is the entry.
        // The add runs the naming pass itself, so nothing below has to.
        //
        // A throw HERE is not a refusal that left the project as it found it:
        // the category write above landed, so the failure answer still says
        // which entry moved and every window is still told the project changed —
        // otherwise a half-applied gesture would leave the book relabelled and
        // every view of it stale.
        let added;
        try {
          added = await addBookChapter(projectDir, result.file, chapterName, familyId);
        } catch (err) {
          broadcastToAllWindows('project:files-changed', projectDir);
          return {
            success: false,
            error:
              `That block is now a ${categoryId} in the book, but listing its document in the `
              + `table of contents failed: ${(err as Error).message}`,
            rewrittenEntries: [...rewrittenEntries],
          };
        }
        for (const entry of added.rewrittenEntries) rewrittenEntries.add(entry);
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: true, result, added,
          openingsNamed: added.openingsNamed,
          openingUnnamed: added.openingUnnamed,
          rewrittenEntries: [...rewrittenEntries],
        };
      }

      if (!result.written) {
        // The book already said it. No bytes moved, so there is nothing for the
        // naming pass to find that it would not have found before, and nothing
        // for any window to re-read.
        return {
          success: true, result, openingsNamed: 0, openingUnnamed: null, rewrittenEntries: [],
        };
      }

      let openingsNamed = 0;
      let openingUnnamed: string | null = null;
      // Non-null when this document has no entry in the table of contents and
      // therefore no name to print: the machine-readable half of the sentence
      // below, so the window can offer to supply one instead of only saying that
      // one is missing.
      let needsChapterName: string | null = null;
      try {
        const { nameChapterOpenings } = await import('./narration-export.js');
        const summary = await nameChapterOpenings(projectDir, familyId);
        openingsNamed = summary.edited;
        for (const edit of summary.named) rewrittenEntries.add(edit.file);
        if (categoryId === 'chapter') {
          // A document the table of contents does not name has no stored name to
          // print, and the pass therefore never reaches it — which
          // `chapterOpeningRefusal` would report as a pass that fell short. It
          // did not; the book simply does not call this document a chapter, and
          // that is the sentence the user is owed.
          if (await namedInContents(result.file)) {
            openingUnnamed = chapterOpeningRefusal(summary, result.file);
          } else {
            needsChapterName = result.file;
            openingUnnamed =
              `${result.file} is not listed under a name in this book's table of contents, so `
              + 'there is no stored name for its opening to print. Give the chapter a name and it '
              + 'will be listed under it.';
          }
        }
      } catch (err) {
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: false,
          error:
            `That block is now a ${categoryId} in the book, but the pass that writes each `
            + `chapter's name into its opening could not run afterwards: ${(err as Error).message}`,
        };
      }

      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true, result, openingsNamed, openingUnnamed, needsChapterName,
        rewrittenEntries: [...rewrittenEntries],
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * A RUN of blocks, relabelled as one gesture.
   *
   * ── Why the plural exists ──────────────────────────────────────────────────
   *
   * The picker's palette labels a SELECTION, and it sent that selection one
   * block at a time, awaiting each. Every one of those calls paid the same fixed
   * cost — the book read whole to say what it currently calls its elements, the
   * write, the reading that verifies it, the two measurements that bracket it,
   * the manifest transaction, and behind all of that the chapter-naming pass.
   * Measured on the migrated Nuremberg project 2026-08-11: ~500 ms per block, of
   * which a second block in the same gesture would have added a few.
   *
   * Here the batch is one act: `setBookBlockCategories` reads, writes, measures
   * and records once, and `nameChapterOpenings` runs once behind all of it
   * rather than once per block.
   *
   * ── Refusals are about the WHOLE batch ────────────────────────────────────
   *
   * A category outside the palette, a key naming a picture or a document, a key
   * naming nothing, one element named twice: all of them refuse the gesture
   * before a byte is written, so a selection never lands half-applied. An
   * element the book ALREADY calls what was asked is not a refusal — it comes
   * back `written: false` and the rest of the batch stands.
   *
   * ── What is NOT here, and why ─────────────────────────────────────────────
   *
   * `chapterName`. The singular handler takes one because promoting a single
   * block to `chapter` can also list its document in the table of contents, and
   * a name belongs to ONE chapter. A batch has no one name to give, and the
   * per-document sentences a promotion earns are reported per element below
   * instead. A selection that includes chapter promotions gets them named the
   * ordinary way — through the naming pass — and the blocks whose documents the
   * contents does not list say so by name.
   */
  ipcMain.handle('book:set-block-categories', async (
    _event,
    projectDir: string,
    edits: Array<{ elementKey: string; categoryId: string }>,
    familyId?: string) => {
    try {
      const { readBookChapterTitles } = await import('./book-chapters.js');
      const { setBookBlockCategories } = await import('./book-categories.js');

      /** What the BOOK says about a document's entry, asked rather than assumed. */
      const namedInContents = async (file: string): Promise<boolean> => {
        const titles = await readBookChapterTitles(projectDir, familyId);
        const row = titles?.chapters.find((c) => c.file === file);
        return row !== undefined && row.navTitle.trim().length > 0;
      };

      const batch = await setBookBlockCategories(projectDir, edits, familyId);

      // Every entry of the book this ONE gesture rewrote — the relabelled
      // documents, and below them whatever the naming pass touched. The window
      // lays exactly these out again instead of re-opening the book, so the list
      // has to be the whole truth.
      const rewrittenEntries = new Set<string>(batch.rewrittenEntries);

      if (rewrittenEntries.size === 0) {
        // The book already said all of it. No bytes moved, so there is nothing
        // for the naming pass to find that it would not have found before, and
        // nothing for any window to re-read.
        return {
          success: true, ...batch, openingsNamed: 0, rewrittenEntries: [],
          results: batch.results.map((r) => ({
            ...r, openingUnnamed: null, needsChapterName: null,
          })),
        };
      }

      let openingsNamed = 0;
      let summary;
      try {
        const { nameChapterOpenings } = await import('./narration-export.js');
        summary = await nameChapterOpenings(projectDir, familyId);
        openingsNamed = summary.edited;
        for (const edit of summary.named) rewrittenEntries.add(edit.file);
      } catch (err) {
        // A throw HERE is not a refusal that left the project as it found it: the
        // category writes above landed, so the failure answer still says which
        // entries moved and every window is still told the project changed —
        // otherwise a half-applied gesture would leave the book relabelled and
        // every view of it stale.
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: false,
          error:
            `${rewrittenEntries.size} document(s) were relabelled in the book, but the pass that `
            + `writes each chapter's name into its opening could not run afterwards: `
            + `${(err as Error).message}`,
          rewrittenEntries: [...rewrittenEntries],
        };
      }

      // Per element, because the picker draws per element: a block promoted to
      // `chapter` whose document the contents does not list has no stored name
      // for its opening to print, and that is a different sentence from a pass
      // that ran and fell short.
      const results = await Promise.all(batch.results.map(async (result) => {
        if (result.categoryAfter !== 'chapter' || !result.written) {
          return { ...result, openingUnnamed: null, needsChapterName: null };
        }
        if (await namedInContents(result.file)) {
          return {
            ...result,
            openingUnnamed: chapterOpeningRefusal(summary, result.file),
            needsChapterName: null,
          };
        }
        return {
          ...result,
          openingUnnamed:
            `${result.file} is not listed under a name in this book's table of contents, so there `
            + 'is no stored name for its opening to print. Give the chapter a name and it will be '
            + 'listed under it.',
          needsChapterName: result.file,
        };
      }));

      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true,
        ...batch,
        results,
        openingsNamed,
        rewrittenEntries: [...rewrittenEntries],
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Insert a chapter heading INTO the book, immediately before one of its
   * elements.
   *
   * Owen, 2026-08-12: "theres a book that lost the chapter headers but kept
   * the body text. i have ot insert chapter headers in where they belong for
   * this book." No relabel can answer that — there is no element to promote —
   * so this ADDS one: an `<h1>` stamped `chapter`, written into the working
   * copy, with the narration strike record carried `+1` past it in the same
   * manifest transaction (electron/book-headings.ts). The archive original is
   * never opened.
   *
   * THE NAMING PASS RUNS AFTER, exactly as it runs behind a promotion to
   * `chapter` and for the same reason: the insert makes a new element the
   * opening of its document, so the same open-time rule runs again over the
   * book that changed, with no insert-specific logic at all. A document the
   * table of contents does not list comes back with `needsChapterName` — the
   * window's cue to offer the listing — and its heading keeps the title the
   * user typed; a listed document's heading is rewritten to its stored name,
   * because the table of contents is where a chapter's name lives and the only
   * place it lives.
   */
  ipcMain.handle('book:insert-chapter-heading', async (
    _event, projectDir: string, beforeElementKey: string, title: string, familyId?: string) => {
    try {
      const { readBookChapterTitles } = await import('./book-chapters.js');
      const { insertBookChapterHeading } = await import('./book-headings.js');

      /** What the BOOK says about this document's entry, asked rather than assumed. */
      const namedInContents = async (file: string): Promise<boolean> => {
        const titles = await readBookChapterTitles(projectDir, familyId);
        const row = titles?.chapters.find((c) => c.file === file);
        return row !== undefined && row.navTitle.trim().length > 0;
      };

      const result = await insertBookChapterHeading(
        projectDir, beforeElementKey, title, familyId);

      // Every entry of the book this ONE gesture rewrote — the inserted-into
      // document, and below it whatever the naming pass touched. The window
      // lays exactly these out again instead of re-opening the book.
      const rewrittenEntries = new Set<string>(result.rewrittenEntries);

      let openingsNamed = 0;
      let openingUnnamed: string | null = null;
      let needsChapterName: string | null = null;
      try {
        const { nameChapterOpenings } = await import('./narration-export.js');
        const summary = await nameChapterOpenings(projectDir, familyId);
        openingsNamed = summary.edited;
        for (const edit of summary.named) rewrittenEntries.add(edit.file);
        // The same per-document sentences a `chapter` promotion earns: a
        // document the contents does not name has no stored name for the new
        // opening to print, which is a different sentence from a pass that ran
        // and fell short.
        if (await namedInContents(result.file)) {
          openingUnnamed = chapterOpeningRefusal(summary, result.file);
        } else {
          needsChapterName = result.file;
          openingUnnamed =
            `${result.file} is not listed under a name in this book's table of contents, so `
            + 'there is no stored name for its opening to print. Give the chapter a name and it '
            + 'will be listed under it.';
        }
      } catch (err) {
        // A throw HERE is not a refusal that left the project as it found it:
        // the insert above landed, so the failure answer still says which
        // entries moved and every window is still told the project changed.
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: false,
          error:
            `The heading "${result.title}" is now in the book, but the pass that writes each `
            + `chapter's name into its opening could not run afterwards: ${(err as Error).message}`,
          rewrittenEntries: [...rewrittenEntries],
        };
      }

      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true, result, openingsNamed, openingUnnamed, needsChapterName,
        rewrittenEntries: [...rewrittenEntries],
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Remove an inserted chapter heading — the insert's exact inverse, for undo.
   *
   * It removes ONLY what the insert writes (a heading the book reads as
   * `chapter`, holding no picture, in a conversion-stamped book) and carries
   * the strike record `-1` in the same transaction; a strike on the heading
   * itself refuses the removal by name. It is deliberately NOT a general
   * delete-element — that is blocked until keys stop being positional.
   *
   * The naming pass still runs behind it — the book changed and the open-time
   * rule re-runs, exactly as after a demotion — but `openingUnnamed` stays
   * null: "this document marks no chapter opening" is precisely what removing
   * the heading asked for, and saying it back would be noise.
   */
  ipcMain.handle('book:remove-inserted-heading', async (
    _event, projectDir: string, elementKey: string, familyId?: string) => {
    try {
      const { removeBookInsertedHeading } = await import('./book-headings.js');

      const result = await removeBookInsertedHeading(projectDir, elementKey, familyId);
      const rewrittenEntries = new Set<string>(result.rewrittenEntries);

      let openingsNamed = 0;
      try {
        const { nameChapterOpenings } = await import('./narration-export.js');
        const summary = await nameChapterOpenings(projectDir, familyId);
        openingsNamed = summary.edited;
        for (const edit of summary.named) rewrittenEntries.add(edit.file);
      } catch (err) {
        broadcastToAllWindows('project:files-changed', projectDir);
        return {
          success: false,
          error:
            'The heading is now out of the book, but the pass that writes each chapter\'s name '
            + `into its opening could not run afterwards: ${(err as Error).message}`,
          rewrittenEntries: [...rewrittenEntries],
        };
      }

      broadcastToAllWindows('project:files-changed', projectDir);
      return {
        success: true, result, openingsNamed, openingUnnamed: null, needsChapterName: null,
        rewrittenEntries: [...rewrittenEntries],
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * What one element of the book says right now — what the text editor opens on.
   *
   * A block is a PAGE'S WORTH of an element, so the editor cannot open on the
   * block it was double-clicked from: a paragraph that spans a page break would
   * be shown as its first half, and saving that would delete the second.
   */
  ipcMain.handle('book:read-block-text', async (
    _event, projectDir: string, elementKey: string, familyId?: string) => {
    try {
      const { readBookBlockText } = await import('./book-text.js');
      return { success: true, data: await readBookBlockText(projectDir, elementKey, familyId) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Make the book say what the reader typed.
   *
   * Down `book-text.ts` for the same reason a relabel goes down
   * `book-categories.ts`: a correction that lives anywhere but in the book is
   * invisible to the narration cut, the export, the Chapter tab, the naming pass
   * and the viewer — which is exactly the bug this replaces.
   *
   * `rewrittenEntries` is the one document the edit touched, so the window lays
   * that out again instead of re-opening the book. Unlike a relabel, this one is
   * REAL layout: words changed, so the pages move and the document is measured.
   */
  ipcMain.handle('book:set-block-text', async (
    _event, projectDir: string, elementKey: string, newText: string, familyId?: string) => {
    try {
      const { setBookBlockText } = await import('./book-text.js');
      const result = await setBookBlockText(projectDir, elementKey, newText, familyId);
      if (!result.written) {
        // The book already reads that way — a retype that changed only
        // whitespace nobody can see. No bytes moved, so no window has anything
        // to re-read.
        return { success: true, result, rewrittenEntries: [] };
      }
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true, result, rewrittenEntries: [result.file] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── Foundry CLI ─────────────────────────────────────────────────────────
  // The standalone binary this app's page-layout model, OCR-repair contract and
  // footnote-marker remover were extracted into (github.com/telltaleatheist/
  // foundry). Every OCR run goes here and ONLY here — there is no fallback to the
  // legacy engines; a missing binary or a missing GGUF is an error that names it.
  //
  // `foundry:version` is the whole surface. There is no `foundry:run-start`,
  // `-attach`, `-cancel`, `-read`, `-progress` or `foundry:export`, and their
  // absence IS the document pipeline (docs/DOCUMENT_PIPELINE.md): a stage is a
  // transformation of a file in the project, so what a window asks about is the
  // DOCUMENT (`document:*`, electron/document-ipc.ts) and the answer it gets is
  // the document as it stands. A run object that could be attached to, swept, or
  // refused an export on was a record of work rather than the work itself, and
  // every one of its consumers was reading it to guess at something the file on
  // disk says outright.
  ipcMain.handle('foundry:version', async () => {
    const { foundryVersion } = await import('./foundry-bridge.js');
    try {
      return { ok: true as const, ...(await foundryVersion()) };
    } catch (err) {
      // Returned rather than thrown: "foundry is not installed" is the normal
      // state on most machines today, and it is an answer to the question, not
      // a crash. The message names both places that were checked.
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Delete a project's content-analysis report (report + any in-progress checkpoint).
  ipcMain.handle('analysis:delete', async (_event, projectDir: string) => {
    try {
      if (!projectDir || !fsSync.existsSync(projectDir)) {
        return { success: false, error: 'Project not found' };
      }
      const { deleteAnalysis } = await import('./book-analysis.js');
      await deleteAnalysis(path.join(projectDir, 'stages', '04-analysis'));
      broadcastToAllWindows('project:files-changed', projectDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // List only audiobook variants with an authoritative transcript. Verification
  // is performed here so Studio never labels a stale report as usable.
  ipcMain.handle('analysis:list-audiobooks', async (_event, projectId: string) => {
    try {
      if (!projectId) return { success: false, error: 'projectId is required' };
      const manifestResult = await manifestService.getManifest(projectId);
      if (!manifestResult.success || !manifestResult.manifest) {
        return { success: false, error: manifestResult.error || 'Project not found' };
      }
      const { resolveAudiobookAnalysisSource, verifyAudiobookAnalysis } =
        await import('./audiobook-analysis-protocol.js');
      const variants = manifestService.getVariants(manifestResult.manifest).variants
        .filter(v => v.kind === 'audiobook' && v.format.toLowerCase() === 'm4b');
      const targets: Array<{
        projectId: string;
        variantId: string;
        label: string;
        descriptor?: string;
        reportStatus: 'missing' | 'valid' | 'stale';
        analyzedAt?: string;
        flagCount?: number;
      }> = [];
      for (const variant of variants) {
        try {
          await resolveAudiobookAnalysisSource(projectId, variant.id);
        } catch (err) {
          console.warn(`[analysis:list-audiobooks] Variant ${variant.id} is not eligible:`, (err as Error).message);
          continue; // No authoritative transcript means this is not an eligible target.
        }
        const verified = await verifyAudiobookAnalysis<{
          analyzedAt?: string;
          statistics?: { totalFlags?: number };
        }>(projectId, variant.id);
        const label = variant.descriptor
          || variant.metadata?.title
          || manifestResult.manifest.metadata.title;
        targets.push({
          projectId,
          variantId: variant.id,
          label,
          descriptor: variant.metadata?.narrator ? `Narrated by ${variant.metadata.narrator}` : undefined,
          reportStatus: verified.status,
          analyzedAt: verified.status === 'valid'
            ? verified.report.payload.analyzedAt || verified.manifestEntry.analyzedAt
            : undefined,
          flagCount: verified.status === 'valid'
            ? verified.report.payload.statistics?.totalFlags
            : undefined,
        });
      }
      return { success: true, targets };
    } catch (err) {
      return { success: false, error: (err as Error).message };
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
          error: result.error,
          // Failed-chunk accounting: chunks that kept original (untranslated) text
          translationFailedChunks: result.failedChunkCount,
          skippedChunksPath: result.skippedChunksPath
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

    // Try to cancel parallel TTS job. Use the CACHING stop so the sentences rendered
    // so far are promoted to the durable project cache — that's the checkpoint the
    // queue's auto-resume reads to continue where the user left off. The plain
    // stopParallelConversion just kills the workers and would lose the progress.
    try {
      const { parallelTtsBridge } = await import('./parallel-tts-bridge.js');
      if (await parallelTtsBridge.stopAndCacheParallelConversion(jobId)) {
        console.log('[IPC] Parallel TTS job stopped + cached for resume:', jobId);
        cancelled = true;
      }
    } catch (err) {
      console.error('[IPC] Error stopping parallel TTS job:', err);
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

    // Try to cancel RVC enhancement job
    try {
      const { stopRvcEnhancement, isRvcEnhancementActive } = await import('./rvc-job.js');
      if (isRvcEnhancementActive(jobId)) {
        stopRvcEnhancement(jobId);
        console.log('[IPC] RVC enhancement job cancelled:', jobId);
        cancelled = true;
      }
    } catch (err) {
      console.error('[IPC] Error cancelling RVC enhancement job:', err);
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
    const queueFile = getQueueFilePath();
    if (!fsSync.existsSync(queueFile)) {
      return { success: true, data: null };
    }
    try {
      const content = await fs.readFile(queueFile, 'utf-8');
      return { success: true, data: JSON.parse(content) };
    } catch (error) {
      // The file EXISTS but couldn't be read/parsed. Preserve it BEFORE returning:
      // the renderer starts with an empty queue and its debounced auto-save would
      // overwrite this file within ~500ms, silently destroying the saved jobs
      // (including interrupted-TTS wasInterrupted flags that protect session caches).
      const message = error instanceof Error ? error.message : 'Unknown error';
      let backupPath: string | undefined;
      try {
        backupPath = `${queueFile}.corrupt-${Date.now()}`;
        await fs.rename(queueFile, backupPath);
        console.error(`[queue:load-state] queue.json is corrupt — preserved at ${backupPath}:`, message);
      } catch (renameErr) {
        console.error('[queue:load-state] queue.json is corrupt AND could not be backed up:', renameErr);
        backupPath = undefined;
      }
      return { success: false, error: message, corrupted: true, backupPath };
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

  ipcMain.handle('reassembly:resolve-sentence-gap', async (_event, processDir: string) => {
    try {
      const { resolveSessionSentenceGap } = await import('./reassembly-bridge.js');
      return { success: true, data: await resolveSessionSentenceGap(processDir) };
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

  // RVC voice-enhancement as its own queue job (produces an enhanced sentence set
  // under [library]/tmp that a downstream reassembly job assembles + deletes).
  ipcMain.handle('rvc:start-enhancement', async (_event, jobId: string, config: any) => {
    try {
      const { runRvcEnhancement } = await import('./rvc-job.js');
      const result = await runRvcEnhancement(jobId, config, mainWindow);
      return { success: result.success, data: { scratchDir: result.scratchDir }, error: result.error, wasStopped: result.wasStopped };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('rvc:stop-enhancement', async (_event, jobId: string) => {
    try {
      const { stopRvcEnhancement } = await import('./rvc-job.js');
      stopRvcEnhancement(jobId);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ── Enhance tab (local Adobe-Podcast-style speech cleanup) ──
  // Per file: decode → separate (audio-separator) → enhance (Resemble Enhance).
  // Sliders/preview/export read the per-file cache only; they never reprocess.
  ipcMain.handle('enhance:pick-files', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add audio or video files',
      filters: [
        { name: 'Audio & Video', extensions: ['wav', 'mp3', 'm4a', 'm4b', 'flac', 'ogg', 'oga', 'aac', 'opus', 'wma', 'aiff', 'aif', 'mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, filePaths: result.filePaths };
  });

  ipcMain.handle('enhance:pick-export-path', async (_event, defaultName: string) => {
    if (!mainWindow) return { success: false, error: 'No window' };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export mixed audio',
      defaultPath: defaultName,
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    return { success: true, filePath: result.filePath };
  });

  ipcMain.handle('enhance:readiness', async () => {
    try {
      const { enhanceReadiness } = await import('./enhance-bridge.js');
      return { success: true, data: enhanceReadiness() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:probe-file', async (_event, sourcePath: string) => {
    try {
      const { probeEnhanceInput } = await import('./enhance-bridge.js');
      const data = await probeEnhanceInput(sourcePath);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:get-cache', async (_event, sourcePath: string) => {
    try {
      const { getEnhanceCacheEntry } = await import('./enhance-bridge.js');
      return { success: true, data: getEnhanceCacheEntry(sourcePath) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:set-overrides', async (_event, sourcePath: string, overrides: any, key?: string) => {
    try {
      const { setEnhanceOverrides } = await import('./enhance-bridge.js');
      return { success: true, data: setEnhanceOverrides(sourcePath, overrides, key) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:process', async (_event, jobId: string, config: any) => {
    try {
      const { runEnhanceProcessing } = await import('./enhance-bridge.js');
      return await runEnhanceProcessing(jobId, config, mainWindow);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:stop', async (_event, jobId: string) => {
    try {
      const { stopEnhanceProcessing } = await import('./enhance-bridge.js');
      await stopEnhanceProcessing(jobId);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:clear-cache', async (_event, sourcePath: string) => {
    try {
      const { clearEnhanceCache } = await import('./enhance-bridge.js');
      clearEnhanceCache(sourcePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:clear-cache-by-key', async (_event, key: string) => {
    try {
      const { clearEnhanceCacheByKey } = await import('./enhance-bridge.js');
      clearEnhanceCacheByKey(key);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:list-sessions', async () => {
    try {
      const { listEnhanceSessions } = await import('./enhance-bridge.js');
      return { success: true, data: listEnhanceSessions() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:list-active', async () => {
    try {
      const { listActiveEnhanceJobs } = await import('./enhance-bridge.js');
      return { success: true, data: listActiveEnhanceJobs() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('enhance:export', async (_event, config: any) => {
    try {
      const { exportEnhanceMix } = await import('./enhance-bridge.js');
      return await exportEnhanceMix(config);
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

  ipcMain.handle('reassembly:get-bfp-session', async (_event, projectDir: string) => {
    try {
      const { getBfpCachedSession } = await import('./reassembly-bridge.js');
      const session = await getBfpCachedSession(projectDir);
      if (!session) {
        return { success: true, data: null };
      }
      return { success: true, data: session };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Correct Sentences — regenerate individual TTS sentences that sound wrong,
  // audition fresh takes in context, approve one, and reassemble.
  // ───────────────────────────────────────────────────────────────────────────
  const correctSentencesJobs = new Map<string, AbortController>();

  ipcMain.handle('correct-sentences:get-session', async (_event, projectDir: string) => {
    try {
      const { getCorrectSentencesSession } = await import('./correct-sentences-bridge.js');
      return { success: true, data: await getCorrectSentencesSession(projectDir) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('correct-sentences:generate-candidates', async (
    _event,
    jobId: string,
    params: { projectDir: string; indices: number[]; takes?: number; overrides?: Record<number, string> }
  ) => {
    try {
      const { generateCandidates } = await import('./correct-sentences-bridge.js');
      const controller = new AbortController();
      correctSentencesJobs.set(jobId, controller);
      try {
        const data = await generateCandidates({
          projectDir: params.projectDir,
          indices: params.indices,
          takes: params.takes,
          overrides: params.overrides,
          signal: controller.signal,
          onProgress: (done, total) => {
            mainWindow?.webContents.send('correct-sentences:progress', { jobId, done, total });
          },
        });
        return { success: data.success, data, error: data.error };
      } finally {
        correctSentencesJobs.delete(jobId);
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('correct-sentences:cancel', async (_event, jobId: string) => {
    correctSentencesJobs.get(jobId)?.abort();
    return { success: true };
  });

  ipcMain.handle('correct-sentences:commit', async (
    _event,
    params: { projectDir: string; index: number; sourceFlacPath: string }
  ) => {
    try {
      const { commitSentence } = await import('./correct-sentences-bridge.js');
      return await commitSentence(params);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('correct-sentences:revert', async (
    _event,
    params: { projectDir: string; index: number }
  ) => {
    try {
      const { revertSentence } = await import('./correct-sentences-bridge.js');
      return await revertSentence(params.projectDir, params.index);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('correct-sentences:cleanup', async (_event, sessionId: string) => {
    try {
      const { cleanupCandidates } = await import('./correct-sentences-bridge.js');
      await cleanupCandidates(sessionId);
      return { success: true };
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
    vttPath: string,
    m4bPath?: string
  ) => {
    try {
      const { detectChapters } = await import('./chapter-recovery-bridge.js');
      return await detectChapters(epubPath, vttPath, m4bPath);
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
      const result = await applyChaptersToM4b(m4bPath, chapters);
      // The M4B on disk was rewritten. Every window drawing the project it lives
      // in — the shelf, the versions page, an open player — is showing a file
      // whose chapters are one act old. The project is derived from the path,
      // because this handler is given a FILE and not a project.
      if (result?.success) {
        const projectsDir = path.normalize(path.join(getLibraryRoot(), 'projects'));
        const normalized = path.normalize(path.resolve(normalizeFsPath(m4bPath)));
        if (normalized.startsWith(projectsDir + path.sep)) {
          const slug = path.relative(projectsDir, normalized).split(path.sep)[0];
          broadcastToAllWindows('project:files-changed', path.join(projectsDir, slug));
        }
      }
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Read the chapter markers embedded in an audio file (ffprobe -show_chapters) —
  // the same source the bookshelf web player uses. The desktop player prefers these
  // over EPUB fuzzy-detection.
  ipcMain.handle('chapter-recovery:probe-chapters', async (_event, audioPath: string) => {
    try {
      const { probeEmbeddedChapters } = await import('./chapter-recovery-bridge.js');
      const chapters = await probeEmbeddedChapters(audioPath);
      return { success: true, chapters };
    } catch (err) {
      // A failed probe must NOT read as "chapterless file" — that silently
      // downgrades the player to fuzzy EPUB chapter detection.
      console.error('[chapter-recovery:probe-chapters] failed:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Debug handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('debug:log', async (_event, message: string) => {
    console.log('[RENDERER]', message);
  });

  // Renderer-side TTS decisions (queue resume-mode selection, start-fresh deletes) into
  // the PERSISTED tts.log. queue.service.ts runs in the renderer, so its console.logs
  // die with the dev console — which is exactly why the destructive-resume incident
  // could not be reconstructed from files afterwards.
  ipcMain.handle('tts-log:decision', async (
    _event,
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, unknown>
  ) => {
    const ttsLog = getTTSLogger();
    if (level === 'ERROR') ttsLog.error(message, data);
    else if (level === 'WARN') ttsLog.warn(message, data);
    else ttsLog.info(message, data);
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

  // Job 2: Translation — reads the cleaned/simplified EPUB, writes the per-language
  // EPUBs of the sentence-aligned pipeline. Whole-book translation is the Translate
  // PASS (processing-passes.ts), which calls runMonoTranslation directly; the
  // `monoTranslation` flag that used to fork this handler had no submitter left.
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
    testMode?: boolean;
    testModeChunks?: number;
  }) => {
    try {
      const { runLLTranslation } = await import('./ll-jobs.js');
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

      // Zero files copied is a FAILURE, not an empty success — marking the cache
      // hasAudio=true with no audio behind it silently breaks later assembly.
      if (audioFiles.length === 0) {
        console.error(`[SENTENCE-CACHE] No .flac sentence audio found in ${sentencesDir}`);
        return { success: false, error: `No sentence audio (.flac) found in ${sentencesDir}` };
      }

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

    // Reject configs this handler cannot actually honor rather than silently
    // degrading them. runBilingualAssembly only produces m4b and only consumes
    // the first two languages, so an mp3 request or a 3+ language request would
    // otherwise return the WRONG output while reporting success.
    if (languages.length > 2) {
      return { success: false, error: `Multi-language assembly is not supported yet (received ${languages.length} languages); only 2 (source + target) are supported.` };
    }
    if (outputFormat && outputFormat !== 'm4b') {
      return { success: false, error: `Output format "${outputFormat}" is not supported yet; only m4b is available.` };
    }

    try {
      // Verify all languages have cached audio
      for (const lang of languages) {
        const audioDir = path.join(audiobookFolder, 'audio', lang);
        if (!fsSync.existsSync(audioDir)) {
          return { success: false, error: `No cached audio for language: ${lang}` };
        }
      }

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

  // `manifest:save` is GONE (2026-08-10). It took a WHOLE manifest object from a
  // renderer that had fetched it at some earlier point and wrote it over the file
  // — the same wholesale clobber `project:save-to-path` was just converted away
  // from, with none of that handler's withholding rules — and nothing called it:
  // `manifest.service.saveProject` and `electronService.manifestSave` were both
  // unreferenced. Every real writer goes through `manifest:update` (a field
  // patch) or a handler that owns the keys it touches.

  // Update specific fields in a manifest
  ipcMain.handle('manifest:update', async (_event, update: any) => {
    return manifestService.updateManifest(update);
  });

  // ── One project's editor state ────────────────────────────────────────────
  //
  // Its own channel because it is its own FILE (electron/editor-state-store.ts):
  // `manifest:get` and `manifest:list` no longer carry it, and that is the whole
  // point — the catalog must not haul a book's OCR blocks around to draw a list.
  // Asked for per project, by whatever is about to edit that project.
  //
  // `null` means the project has no editor state, which is a real answer.
  ipcMain.handle('manifest:get-editor-state', async (_event, projectId: string) => {
    try {
      const state = await readEditorState(manifestService.getProjectPath(projectId));
      return { success: true, editor: state };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
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

  // The stages/01-cleanup/ directory is SHARED by the AI-cleanup pass (cleaned.*)
  // and the AI-simplify pass (simplified.*). Two classes of file live there:
  //   • pass-owned — the pass's own EPUB + its diff cache (cleaned.epub /
  //     cleaned.diff.json, or simplified.epub / simplified.diff.json).
  //   • shared     — audit + resume artifacts written to the SAME filenames by
  //     BOTH passes (they share the runAiCleanup writers, keyed only by outputDir).
  //     They reflect whichever pass ran last, so a stage delete removes them ONLY
  //     when it is deleting the LAST occupant of the directory (no sibling pass
  //     EPUB survives). Leaving them while a sibling remains keeps that pass's
  //     Review/Compare + resume honest; removing them once nothing remains is the
  //     fix for the stale cleanup-progress.json that would otherwise make the next
  //     run RESUME from old, possibly corrupted chapters instead of starting fresh.
  const CLEANUP_SHARED_STAGE_ARTIFACTS = [
    'cleanup-progress.json',        // resume checkpoint (stale-resume danger)
    'skipped-chunks.json',          // skipped-chunk record
    'edit-log.json',                // edit-list audit trail
    'cleanup-prepass-report.json',  // deterministic pre-pass report
  ];

  // After a cleanup/simplify stage delete, clear manifest.pipeline.cleanup when the
  // output it tracks (cleaned.epub or simplified.epub) is gone, so the durable
  // manifest — read by listProjects().hasCleanup — stops advertising a stage whose
  // file no longer exists. No-op for legacy projects that have no manifest.
  const reconcileCleanupStageManifest = async (projectPath: string): Promise<void> => {
    try {
      const projectId = path.basename(projectPath);
      if (!manifestService.projectExists(projectId)) return;
      await manifestService.modifyManifest(projectId, (m) => {
        const cu = m.pipeline?.cleanup;
        if (!cu) return;
        const outAbs = cu.outputPath ? path.join(projectPath, cu.outputPath) : undefined;
        if (!outAbs || !fsSync.existsSync(outAbs)) {
          delete m.pipeline.cleanup;
        }
      });
    } catch (err) {
      console.warn('[PIPELINE] cleanup manifest reconcile skipped:', (err as Error).message);
    }
  };

  // Delete AI cleanup outputs from stages/01-cleanup/ (cleaned.* + shared artifacts)
  ipcMain.handle('pipeline:delete-cleanup', async (_event, projectPath: string) => {
    try {
      const cleanupDir = path.join(projectPath, 'stages', '01-cleanup');

      if (!fsSync.existsSync(cleanupDir)) {
        return { success: true, message: 'No cleanup stage found' };
      }

      const files = await fs.readdir(cleanupDir);
      // A surviving simplified.epub still depends on this shared directory.
      const hasSimplified = files.includes('simplified.epub');
      // repaired.epub / repaired.diff.json are the OCR-repair pass-1 intermediate for
      // the edit-list cleanup path; they are owned by cleanup (not simplify) and must
      // be removed alongside cleaned.* so a re-run never resumes over a stale pass 1.
      const cleanupOwnedFiles = ['cleaned.epub', 'cleaned.diff.json', 'repaired.epub', 'repaired.diff.json'];
      const deletedFiles: string[] = [];

      for (const file of files) {
        const owned = cleanupOwnedFiles.includes(file);
        const shared = CLEANUP_SHARED_STAGE_ARTIFACTS.includes(file);
        if (!owned && !shared) continue;
        // Leave shared audit/resume files if the simplify pass still occupies the dir.
        if (shared && hasSimplified) continue;
        await fs.unlink(path.join(cleanupDir, file));
        deletedFiles.push(file);
      }

      // Try to remove the directory if empty
      try {
        await fs.rmdir(cleanupDir);
        console.log('[PIPELINE] Removed empty cleanup directory');
      } catch {
        // Directory not empty, that's fine
      }

      await reconcileCleanupStageManifest(projectPath);

      console.log('[PIPELINE] Deleted cleanup stage:', deletedFiles);
      broadcastToAllWindows('project:files-changed', projectPath);
      return { success: true, deletedFiles, message: `Deleted ${deletedFiles.length} files from cleanup stage` };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete cleanup stage:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete AI Simplify outputs from stages/01-cleanup/ (simplified.* + shared artifacts,
  // preserving cleaned.* and the shared artifacts when a cleanup pass still occupies the dir)
  ipcMain.handle('pipeline:delete-simplify', async (_event, projectPath: string) => {
    try {
      const cleanupDir = path.join(projectPath, 'stages', '01-cleanup');

      if (!fsSync.existsSync(cleanupDir)) {
        return { success: true, message: 'No simplify stage found' };
      }

      const files = await fs.readdir(cleanupDir);
      // A surviving cleaned.epub still depends on this shared directory.
      const hasCleaned = files.includes('cleaned.epub');
      const simplifyOwnedFiles = ['simplified.epub', 'simplified.diff.json'];
      const deletedFiles: string[] = [];

      for (const file of files) {
        const owned = simplifyOwnedFiles.includes(file);
        const shared = CLEANUP_SHARED_STAGE_ARTIFACTS.includes(file);
        if (!owned && !shared) continue;
        // Leave shared audit/resume files if the cleanup pass still occupies the dir.
        if (shared && hasCleaned) continue;
        await fs.unlink(path.join(cleanupDir, file));
        deletedFiles.push(file);
      }

      // Try to remove the directory if empty
      try {
        await fs.rmdir(cleanupDir);
        console.log('[PIPELINE] Removed empty cleanup directory');
      } catch {
        // Directory not empty, that's fine
      }

      await reconcileCleanupStageManifest(projectPath);

      console.log('[PIPELINE] Deleted simplify stage:', deletedFiles);
      broadcastToAllWindows('project:files-changed', projectPath);
      return { success: true, deletedFiles, message: `Deleted ${deletedFiles.length} files from simplify stage` };
    } catch (err) {
      console.error('[PIPELINE] Failed to delete simplify stage:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // The stages/02-translate/ directory can hold several INDEPENDENT translation
  // outputs at once:
  //   • the whole-book mono translation — translated.epub + translated.diff.json,
  //     resumed from translation-progress.json (the mono checkpoint) + chapter-cache/.
  //   • one or more Language-Learning per-language EPUBs — <lang>.epub, each with
  //     its own sentence-pair export (sentence_pairs_<lang>.json) and its resume
  //     cache (sentences/<lang>.json). The source-language EPUB is itself just
  //     another <lang>.epub. (Per-language ownership mirrors the writer's own
  //     stale-output list in ll-jobs.ts runLLTranslation.)
  // Passing an epubName removes ONLY that output + the files that unambiguously
  // belong to it, so deleting German leaves English intact AND — the point of this
  // handler — removes the deleted output's resume artifact so a subsequent run does
  // NOT resume from the deleted chapters. With no epubName the whole stage is
  // removed (the "delete ALL translations" meaning the Studio context menu and the
  // project-files section-delete depend on). Shared leftovers are swept only once
  // the LAST EPUB in the directory is gone.

  // Prune manifest.pipeline.translations entries whose <lang>.epub no longer exists,
  // so listProjects().hasTranslations stops advertising a language whose file is gone.
  // No-op for legacy projects without a manifest.
  const reconcileTranslationStageManifest = async (projectPath: string): Promise<void> => {
    try {
      const projectId = path.basename(projectPath);
      if (!manifestService.projectExists(projectId)) return;
      const translateDir = path.join(projectPath, 'stages', '02-translate');
      await manifestService.modifyManifest(projectId, (m) => {
        const translations = m.pipeline?.translations;
        if (!translations) return;
        for (const lang of Object.keys(translations)) {
          if (!fsSync.existsSync(path.join(translateDir, `${lang}.epub`))) {
            delete translations[lang];
          }
        }
      });
    } catch (err) {
      console.warn('[PIPELINE] translation manifest reconcile skipped:', (err as Error).message);
    }
  };

  // Delete translation outputs from stages/02-translate/.
  // epubName omitted → remove the entire stage (every language + shared files).
  // epubName given (e.g. 'translated.epub' or 'de.epub') → remove just that output
  // and the files that belong to it.
  ipcMain.handle('pipeline:delete-translation', async (_event, projectPath: string, epubName?: string) => {
    try {
      const translateDir = path.join(projectPath, 'stages', '02-translate');

      if (!fsSync.existsSync(translateDir)) {
        return { success: true, message: 'No translation stage found' };
      }

      // ── Whole-stage delete (no epubName): remove every language + shared files ──
      if (!epubName) {
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
        try {
          await fs.rmdir(translateDir);
        } catch {
          // Directory not empty or already gone, that's fine
        }
        await reconcileTranslationStageManifest(projectPath);
        console.log('[PIPELINE] Deleted translation stage (all):', deletedItems);
        broadcastToAllWindows('project:files-changed', projectPath);
        return { success: true, deletedItems, message: `Deleted ${deletedItems.length} items from translation stage` };
      }

      // ── Per-output delete: only this EPUB's own files ──
      // Guard against traversal — epubName must be a bare <name>.epub filename.
      const base = path.basename(epubName);
      if (base !== epubName || !/^[^/\\]+\.epub$/i.test(base)) {
        return { success: false, error: `Invalid translation EPUB name: ${epubName}` };
      }

      if (!fsSync.existsSync(path.join(translateDir, base))) {
        // Already gone — still reconcile so the manifest doesn't lie.
        await reconcileTranslationStageManifest(projectPath);
        return { success: true, deletedItems: [], message: `No such translation output: ${base}` };
      }

      // Files (relative to translateDir) that unambiguously belong to THIS output.
      const owned: string[] = [base];
      let monoCacheDir = false;
      if (base === 'translated.epub') {
        // Whole-book mono output: its diff + its resume artifacts.
        owned.push('translated.diff.json', 'translation-progress.json');
        monoCacheDir = true;
      } else {
        // LL per-language output (<lang>.epub): its diff, its pair export, its cache.
        const lang = base.slice(0, -'.epub'.length);
        owned.push(
          `${lang}.diff.json`,
          `sentence_pairs_${lang}.json`,
          path.join('sentences', `${lang}.json`),
        );
      }

      const deletedItems: string[] = [];
      for (const rel of owned) {
        try {
          await fs.unlink(path.join(translateDir, rel));
          deletedItems.push(rel);
        } catch {
          // Not present — nothing to remove, fine.
        }
      }
      // The mono chapter-cache/ is a directory-shaped resume artifact.
      if (monoCacheDir) {
        const cacheDir = path.join(translateDir, 'chapter-cache');
        if (fsSync.existsSync(cacheDir)) {
          await fs.rm(cacheDir, { recursive: true, force: true });
          deletedItems.push('chapter-cache/');
        }
      }

      // Last-EPUB-out sweep: once no .epub remains, the leftover shared artifacts
      // (an emptied sentences/, orphan sentence_pairs, a mono checkpoint, …) have no
      // owner — remove the whole stage directory. Otherwise just drop an emptied
      // sentences/ so it doesn't linger.
      const remaining = await fs.readdir(translateDir);
      const epubsLeft = remaining.some((f) => /\.epub$/i.test(f));
      if (!epubsLeft) {
        await fs.rm(translateDir, { recursive: true, force: true });
        deletedItems.push('(swept remaining stage files)');
      } else {
        const sentencesDir = path.join(translateDir, 'sentences');
        try {
          if ((await fs.readdir(sentencesDir)).length === 0) await fs.rmdir(sentencesDir);
        } catch {
          // Missing or not empty, that's fine
        }
      }

      await reconcileTranslationStageManifest(projectPath);
      console.log(`[PIPELINE] Deleted translation output ${base}:`, deletedItems);
      broadcastToAllWindows('project:files-changed', projectPath);
      return { success: true, deletedItems, message: `Deleted ${deletedItems.length} files for ${base}` };
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
      broadcastToAllWindows('project:files-changed', projectPath);
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

  /**
   * Forget every record that names a file in `output/`, in ONE transaction.
   *
   * The record half of emptying that folder. `audiobook:delete-output` does this
   * for one key at a time and states the rule in as many words ("CRITICAL
   * ORDERING… never delete a file while the manifest still lists it"); the two
   * handlers below deleted the whole folder first and left `outputs.audiobook`,
   * the bilingual pointers and every audiobook variant naming files that were
   * gone — the exact inversion their own sibling forbids.
   *
   * Only `output/` is cleared. A professionally-read upload lives in `archive/`
   * and is not this act's to forget.
   */
  const forgetOutputFolderRecords = async (projectPath: string): Promise<void> => {
    const projectId = path.basename(projectPath);
    if (!manifestService.projectExists(projectId)) return;
    const inOutput = (p?: string): boolean =>
      (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase().startsWith('output/');
    const saved = await manifestService.modifyManifest(projectId, (m) => {
      if (m.outputs) {
        if (inOutput(m.outputs.audiobook?.path)) delete m.outputs.audiobook;
        for (const [pair, out] of Object.entries(m.outputs.bilingualAudiobooks || {})) {
          if (inOutput((out as { path?: string })?.path)) {
            delete m.outputs.bilingualAudiobooks![pair];
          }
        }
      }
      if (Array.isArray(m.variants)) {
        m.variants = m.variants.filter((v) => !inOutput(v.path));
        if (m.primaryVariantId && !m.variants.some((v) => v.id === m.primaryVariantId)) {
          m.primaryVariantId = m.variants[0]?.id;
        }
      }
    });
    if (!saved.success) {
      throw new Error(
        `Nothing was deleted: ${path.basename(projectPath)}'s records of its output files could not `
        + `be cleared (${saved.error}), and removing the files first would leave the project naming `
        + 'an audiobook that is gone.'
      );
    }
  };

  // Delete output files (audiobook.m4b, audiobook.vtt, bilingual outputs)
  ipcMain.handle('pipeline:delete-output', async (_event, projectPath: string) => {
    try {
      const outputDir = path.join(projectPath, 'output');

      if (!fsSync.existsSync(outputDir)) {
        return { success: true, message: 'No output directory found' };
      }

      // RECORDS FIRST, FILES LAST — and it throws rather than proceeding, so a
      // failed write leaves the audiobook where it is instead of deleting it out
      // from under a manifest that still points at it.
      await forgetOutputFolderRecords(projectPath);

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
      broadcastToAllWindows('project:files-changed', projectPath);
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
            // The extension match already covers repaired.epub + repaired.diff.json
            // (the edit-list pass-1 intermediate) alongside cleaned.* / simplified.*.
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
          // The reconcile `pipeline:delete-cleanup` runs and this one skipped:
          // `manifest.pipeline.cleanup` names the stage output that has just
          // gone, and `listProjects().hasCleanup` reads it — so a project that
          // deleted everything went on advertising a cleanup stage forever.
          await reconcileCleanupStageManifest(projectPath);
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
          await reconcileTranslationStageManifest(projectPath);
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
      broadcastToAllWindows('project:files-changed', projectPath);

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
  // 'pipeline:reset-editor-state' is registered later, in the Editor Window
  // section, so it can reach the `editorWindows` map — a reset must first tear
  // down any open editor window for the project (that window holds the edit
  // state in memory and would auto-save it back, silently undoing the reset).

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

  // Relocate existing professionally-read audiobooks from the disposable output/
  // folder into the protected archive/ folder (see archive-migration.ts). One-shot,
  // user-triggered, idempotent; returns a per-book success/skip/failure report.
  ipcMain.handle('library:migrate-audiobooks-to-archive', async (_event) => {
    return archiveMigration.migrateProfessionalAudiobooksToArchive((progress) => {
      mainWindow?.webContents.send('library:archive-migration-progress', progress);
    });
  });

  // ── Listen window (Play / Stream player) ──
  // The XTTS stream engine's lifetime is tied to these windows: when the last
  // listen window closes, the engine is shut down. That guarantees the engine
  // is only ever running while a player window is open.
  const listenWindows = new Map<string, BrowserWindow>();

  // Everything listenable for a project, scanned from the canonical locations.
  // M4Bs play directly; EPUBs stream via live TTS. The renderer derives the
  // player from what the user picks, so there is no separate play/stream mode.
  ipcMain.handle('listen:list-sources', async (_event, projectPath: string) => {
    // ── "When was this book last written", for either container ──────────────
    //
    // A FILE answers with its own mtime. A FOLDER of a book's parts does NOT: a
    // directory's mtime moves when an entry is added, removed or renamed and
    // stays exactly where it was when an entry's CONTENTS are rewritten — which
    // is what every edit to the working copy does, and the only thing this
    // number is used to notice. So a tree is asked its entries' latest mtime,
    // which is the answer a file gives for the same question.
    const statMtime = async (p: string): Promise<number | null> => {
      let stat;
      try {
        stat = await fs.stat(p);
      } catch {
        return null;
      }
      if (!stat.isDirectory()) return stat.mtimeMs;
      const { listEpubTreeEntries, resolveEpubEntryPath } = await import('./epub-container.js');
      let latest = stat.mtimeMs;
      for (const name of await listEpubTreeEntries(p)) {
        const entry = await fs.stat(resolveEpubEntryPath(p, name));
        if (entry.mtimeMs > latest) latest = entry.mtimeMs;
      }
      return latest;
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
    // The book EPUB by its manifest record — it is named after the book, and an
    // unrecorded source/exported.epub is a stray this must not offer as one.
    //
    // ── A LISTING, so it uses `soleFamily` and never the resolver ────────────
    //
    // This is the same shape as StudioService's scan over the library: it is
    // showing what there IS to listen to, and a project with two working chains
    // must not make the whole list fail. `readExportEpub` goes through
    // `requireFamily`, which THROWS for such a project — and this call was not
    // even inside a try, so one project with two versions gave the listen window
    // no sources at all, not even the M4Bs already scanned.
    //
    // So the chain is resolved here, without throwing: one chain is an answer,
    // and anything else claims no book rather than picking one. The window then
    // shows a project with its audiobooks and no EPUB — visibly incomplete,
    // which is right; a guessed one would be invisibly the wrong version.
    const chains = await manifestService.readBookFamilies(projectPath);
    const soleChain = soleFamily(chains);
    if (soleChain === null && chains.length > 1) {
      console.warn(
        `[listen:list-sources] ${path.basename(projectPath)} has ${chains.length} working chains; `
        + 'no book is offered for it until this window can say which version it means.');
    }
    const exportRecord = soleChain === null
      ? null
      : await manifestService.readExportEpub(projectPath, soleChain.id);
    if (exportRecord) await addEpub('exported', exportRecord.relPath);
    await addEpub('original', path.join('source', 'original.epub'));

    // Every M4B in output/, with its absolute path. Mono audiobooks are EMBED-ONLY:
    // the transcript lives INSIDE the m4b (subtitle track), so no `vttPath` sidecar
    // is resolved or handed to the player. Any M4B with no registered variant still
    // becomes a selectable source; audiobooks older than the newest EPUB are stale.
    const m4bs: Array<{ fileName: string; path: string; vttPath?: string; mtimeMs: number }> = [];
    try {
      const outputDir = path.join(projectPath, 'output');
      for (const name of await fs.readdir(outputDir)) {
        if (!name.endsWith('.m4b')) continue;
        const abs = path.join(outputDir, name);
        const mtimeMs = await statMtime(abs);
        if (mtimeMs === null) continue;
        m4bs.push({ fileName: name, path: abs, mtimeMs });
      }
    } catch { /* no output yet */ }

    // Also list every audiobook the MANIFEST points at, wherever it lives —
    // professionally-read uploads sit in archive/, not output/, so a pure output/
    // scan would drop them from the picker. Resolve via the manifest (getVariants
    // folds outputs.audiobook + bilingual + user-added audiobook variants) and add
    // any file not already found by the output/ scan (deduped by absolute path).
    try {
      const mf = JSON.parse(await fs.readFile(path.join(projectPath, 'manifest.json'), 'utf-8'));
      const seen = new Set(m4bs.map((x) => normalizeFsPath(path.resolve(x.path)).toLowerCase()));
      const { variants } = manifestService.getVariants(mf);
      for (const v of variants) {
        if (v.kind !== 'audiobook') continue;
        const abs = normalizeFsPath(path.join(projectPath, v.path));
        const key = path.resolve(abs).toLowerCase();
        if (seen.has(key)) continue;
        const mtimeMs = await statMtime(abs);
        if (mtimeMs === null) continue; // manifest points at a missing file — skip, don't fabricate
        seen.add(key);
        m4bs.push({ fileName: path.basename(abs), path: abs, mtimeMs });
      }
    } catch { /* no manifest / unreadable — output scan already covers the common case */ }

    return { success: true, epubs, m4bs };
  });

  ipcMain.handle('listen:open-window', async (_event, projectPath: string, audioPath?: string) => {
    const existing = listenWindows.get(projectPath);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      // Ask an already-open player to switch to the clicked audiobook.
      if (audioPath) existing.webContents.send('listen:select-audio', audioPath);
      return { success: true, alreadyOpen: true };
    }

    const iconPath = isDev
      ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
      : path.join(codeRoot, 'bookforge-icon.png');

    // STARTS tablet-shaped — the same height as before, widened to an iPad's
    // portrait proportion (820:1180 points) instead of an iPhone's. Sentences are
    // now paragraph-sized chunks, and a phone-width column turned each one into a
    // tower too tall to read without scrolling. Freely resizable as before (no
    // locked aspect ratio).
    const TABLET_H = 932;
    const TABLET_W = Math.round((TABLET_H * 820) / 1180);  // 648
    const listenWindow = new BrowserWindow({
      width: TABLET_W,
      height: TABLET_H,
      minWidth: 360,
      minHeight: 480,
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
    const audioQuery = audioPath ? `&audio=${encodeURIComponent(audioPath)}` : '';
    if (isDev) {
      listenWindow.loadURL(`http://localhost:4250/#/listen?project=${encodedPath}${audioQuery}`);
    } else {
      const appPath = codeRoot;
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      listenWindow.loadFile(indexPath, {
        hash: `/listen?project=${encodedPath}${audioQuery}`
      });
    }

    return { success: true };
  });

  ipcMain.handle('editor:open-window', async (_event, rawProjectPath: string, options?: { mode?: string }) =>
    openEditorWindow(rawProjectPath, options));

  // Open editor window with a project directory and a specific source version
  // This ensures project state (deletions, chapters) is preserved
  ipcMain.handle('editor:open-window-with-bfp', async (
    _event,
    projectDir: string,
    rawSourcePath: string,
  ) => {
    // The source file may be stored NFD while the disk is NFC (Syncthing Mac↔Win).
    const sourcePath = normalizeFsPath(rawSourcePath);
    // Use the project directory as the window key so we track by project, not by source file
    const existingWindow = editorWindows.get(projectDir);
    if (existingWindow && !existingWindow.isDestroyed()) {
      // Navigate the existing window to the new source file
      const encodedProjectDir = encodeURIComponent(projectDir);
      const encodedSource = encodeURIComponent(sourcePath);
      if (isDev) {
        existingWindow.loadURL(`http://localhost:4250/#/editor?project=${encodedProjectDir}&source=${encodedSource}`);
      } else {
        const appPath = codeRoot;
        const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
        existingWindow.loadFile(indexPath, {
          hash: `/editor?project=${encodedProjectDir}&source=${encodedSource}`
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
        // The EPUB viewer shows a book's pages in <webview> frames confined to
        // the book's own session partition. Without this flag the element is
        // silently inert — no error, no load, just an empty box.
        webviewTag: true,
      },
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#0a0a0a',
    });

    // Track the window by project directory
    editorWindows.set(projectDir, editorWindow);

    // Clean up when window closes
    editorWindow.on('closed', () => {
      editorWindows.delete(projectDir);
      // Notify main window that editor closed (for refresh)
      mainWindow?.webContents.send('editor:window-closed', projectDir);
    });

    // Apply saved zoom level
    editorWindow.webContents.on('did-finish-load', () => {
      editorWindow.webContents.setZoomLevel(loadZoomLevel());
    });

    // Load the editor route with both the project directory and source path as query params
    const encodedProjectDir = encodeURIComponent(projectDir);
    const encodedSource = encodeURIComponent(sourcePath);
    if (isDev) {
      editorWindow.loadURL(`http://localhost:4250/#/editor?project=${encodedProjectDir}&source=${encodedSource}`);
    } else {
      const appPath = codeRoot;
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      editorWindow.loadFile(indexPath, {
        hash: `/editor?project=${encodedProjectDir}&source=${encodedSource}`
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

  // Reset ALL persisted editor state for a project's source so re-opening the
  // editor starts as if the archive file had just been imported. exported.epub
  // is a real deliverable — its removal is opt-in and routed by the renderer
  // through the normal deleteFile path, NEVER here.
  //
  // WHAT is cleared lives in `manifestService.resetEditorRecords`, not here,
  // because this is no longer the only way to ask for it: deleting the working
  // copy asks for the same thing (`ensureBookEpub`), and a second list living in
  // this handler is how the two would come to mean different things. What is
  // left here is the part that is only true of the BUTTON — the open editor
  // window whose autosave would put the records straight back.
  //
  // On unexpected input (missing/corrupt manifest, unknown path) this FAILS
  // LOUDLY via the returned error — it never writes a guessed structure.
  ipcMain.handle('pipeline:reset-editor-state', async (
    _event, rawProjectPath: string, familyId?: string) => {
    try {
      // Manifest-derived paths can be NFD (macOS-written) while the disk entry is
      // NFC — normalize so fs.* and the editorWindows lookup both resolve.
      const projectPath = normalizeFsPath(rawProjectPath);

      destroyEditorWindowsFor(rawProjectPath, projectPath);

      const stat = fsSync.existsSync(projectPath) ? fsSync.statSync(projectPath) : null;
      if (!stat) {
        return { success: false, error: `Project path not found: ${projectPath}` };
      }

      if (stat.isDirectory()) {
        // ── Manifest-directory project ──────────────────────────────────────
        if (!fsSync.existsSync(path.join(projectPath, 'manifest.json'))) {
          return { success: false, error: `No manifest.json in ${projectPath}` };
        }
        // WHICH chain's records are being reset. `resetEditorRecords` gates the
        // picker's own curation on `familyOwnsPickerRecords`, so naming the chain
        // is what keeps a reset of one version from clearing an evening of
        // curation done on another — and a project with NO chain (a bare PDF,
        // the state this button is most often pressed in) clears the picker's
        // records it plainly owns rather than refusing over a book it has not
        // got yet.
        await manifestService.resetEditorRecords(projectPath, familyId);
        console.log(`[PIPELINE] Reset editor state (manifest) for ${projectPath}`);
        broadcastToAllWindows('project:files-changed', projectPath);
        return { success: true, message: 'Editor state reset' };
      }

      // A .bfp path can only be a stale reference from before single-file
      // projects were retired — say so instead of failing as "unrecognized".
      if (projectPath.toLowerCase().endsWith('.bfp')) {
        return {
          success: false,
          error: `${projectPath} is a legacy .bfp project file; those are no longer supported — open the project directory instead.`,
        };
      }

      return { success: false, error: `Not a BookForge project directory (no manifest.json): ${projectPath}` };
    } catch (err) {
      console.error('[PIPELINE] Failed to reset editor state:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Get available versions for a project
  // Takes a project directory.
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
        diffRecordPath?: string;   // <name>.diff.json sitting next to this version (if any)
        diffOriginalPath?: string; // the original this diff was computed against (resolved, if it exists locally)
        // The file the EDITOR is pointed at when this row is opened, when that is
        // not the row's own file. Set on the working-copy row: opening
        // `<Original>.working.pdf` standalone would give it no project, no binding
        // and no annotations — a window that looks like the book and answers no
        // gesture. The project's PDF primary opens the PROJECT, and the picker
        // lands on the furthest station it has (which is the working copy).
        //
        // Set on the ARCHIVE and GENERATED rows too, as of 2026-08-09, and for
        // the law rather than the mechanism: opening either archive-grade file
        // lands on the working copy (Owen: "if they open an archive epub, it
        // just opens a new working copy seamlessly"). The picker redirects those
        // opens on its own (shared/document/artifact-open.ts) — that is the
        // SAFETY NET, and naming the copy here is the statement of intent, so a
        // reader of this handler can see where the button goes without having to
        // know the picker redirects at all.
        openPath?: string;
        // Present on the 'generated', 'exported' and 'narration' rows: WHICH
        // WORKING CHAIN this row belongs to.
        //
        // Owen, 2026-08-10: "having the epub listed under documents instead of
        // versions breaks the chain of custody" — and a row that cannot say
        // which chain it is on is the same break said differently. Every act a
        // row offers (erase, delete a pass, delete the TTS copy) takes this and
        // hands it back, so a project with two versions acts on the one the user
        // pressed rather than on whichever the code reached first.
        //
        // The 'generated' row carries it too, as of the per-family UI: a cast
        // book IS the book line of the chain that hangs off it, and a book line
        // that cannot name its chain is a Delete that would go to whichever
        // chain the page reached first.
        familyId?: string;
        // Present only on the 'archive' row: the manifest variant that IS this
        // file, so Delete can go through `variant:delete` — the one code path
        // that removes a version of a book (record first, file only after the
        // write is confirmed). Without it the row would have to identify the
        // variant by path, which is the guess that handler exists to avoid.
        variantId?: string;
        // Present only on the 'working' and 'archive' rows: the archive original
        // this family is bound to. It is what a delete of either one has to be
        // pointed at — the working document is DERIVED from it, so the pipeline
        // identifies the document by naming its original, never by naming the
        // working file (see document-ipc.ts, "why the renderer never holds a path").
        primaryPath?: string;
        // Present only on the 'working' row: the binding's recorded stage
        // boundaries, so the row can say which stages have landed and when.
        stageBoundaries?: Array<{ stage: string; finishedAt: string }>;
        // Present only on the 'exported' row, and only when the binding recorded a
        // build: when REFLOW wrote this book. Deliberately not the file's mtime —
        // a footnote pass rewrites the book in place and moves that.
        builtAt?: string;
        // Present only on the 'generated' row: whether these bytes are the page
        // reader's own output ('cast') or the working copy adopted when the
        // project was migrated ('adopted'). It changes what erasing changes goes
        // BACK to, so every surface that offers that act has to be able to say it.
        generatedOrigin?: 'cast' | 'adopted';
        // Present only on the 'exported' row — the book's LEDGER, oldest first:
        // the passes that rewrote it and each kept a snapshot, so each can be
        // taken back on its own (`book:delete-ledger-entry`). These are the
        // indented rows under the book that Owen described; the "working
        // changes" line beside them is VIRTUAL and is not in this list, because
        // it is a standing set of records rather than a committed pass. Absent
        // (rather than empty) for a book nothing has been run over.
        ledger?: Array<{
          id: string;
          kind: string;
          label: string;
          createdAt: string;
          hasReceipt: boolean;
          // The entry's own two files, ABSOLUTE, so the row can act on them: the
          // book exactly as that pass left it, and the diff frozen at the moment
          // it ran. `hasReceipt` stays because it is the question the button
          // asks — a `receiptPath` that names a file which is not there would be
          // a disabled button with no reason to give.
          snapshotPath: string;
          /** Whether that snapshot is on disk. Drives Compare, as `hasReceipt`
           *  drives Review changes — a different file, a different question. */
          hasSnapshot: boolean;
          receiptPath: string | null;
        }>;
        // Present only on the synthetic 'analysis' entry:
        analysisTarget?: { versionId: string | null; versionType: string; versionLabel: string };
        analysisFlagCount?: number;
        analysisIsCheckpoint?: boolean;
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
        language?: string,
        extra?: {
          openPath?: string;
          familyId?: string;
          variantId?: string;
          primaryPath?: string;
          stageBoundaries?: Array<{ stage: string; finishedAt: string }>;
          builtAt?: string;
          generatedOrigin?: 'cast' | 'adopted';
          ledger?: Array<{
            id: string;
            kind: string;
            label: string;
            createdAt: string;
            /** Whether this entry froze a diff worth offering for review. */
            hasReceipt: boolean;
            /** The book as this pass left it, absolute — the line opens it. */
            snapshotPath: string;
            /** Whether that book is where the record says. Drives Compare. */
            hasSnapshot: boolean;
            /** The frozen diff, absolute, or null when the pass recorded none. */
            receiptPath: string | null;
          }>;
        }
      ) => {
        const resolvedFilePath = resolvePath(filePath);
        if (resolvedFilePath) {
          const stats = await fs.stat(resolvedFilePath);
          const ext = path.extname(resolvedFilePath).toLowerCase().replace('.', '');

          // Detect a pre-computed diff record (produced by AI cleanup/simplify)
          // sitting next to this version: <name>.diff.json. Its presence is what
          // makes this version "comparable" — we only offer Compare when a record
          // exists. Also surface the original it was computed against (resolved
          // cross-platform if possible) so the renderer can compare in the right
          // order without a guessing/pick step.
          let diffRecordPath: string | undefined;
          let diffOriginalPath: string | undefined;
          if (ext === 'epub') {
            const recPath = resolvedFilePath.replace(/\.epub$/i, '.diff.json');
            if (fsSync.existsSync(recPath)) {
              diffRecordPath = recPath;
              try {
                const rec = JSON.parse(await fs.readFile(recPath, 'utf-8'));
                if (rec?.originalPath) {
                  const stored = String(rec.originalPath);
                  // New records store a path relative to the diff file; resolve
                  // it against the diff file's directory so it works on any
                  // machine sharing the library. Fall back to the legacy
                  // absolute-path handling (cross-platform translation) for
                  // records written before this change.
                  const relResolved = path.resolve(path.dirname(recPath), stored);
                  diffOriginalPath = fsSync.existsSync(relResolved)
                    ? relResolved
                    : resolvePath(stored);
                }
              } catch {
                // Unreadable record — still mark comparable; renderer falls back
                // to the project's original/exported EPUB as the compare source.
              }
            }
          }

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
            // A row is editable when the caller says so AND the thing is one of
            // the two the editor can open. The second half is asked through
            // `isBookPath` and not through `ext`, because a migrated project's
            // working copy is `source/<stem>.working` and `path.extname` on that
            // is `working` — so the user's OWN editable book came back
            // `editable: false` and the versions page then swallowed every click
            // on it (`rowIsClickable`/`onDocRowClick` read this field). Fixed at
            // the source so the renderer needs no `.working` special case.
            editable: editable && (isBookPath(resolvedFilePath) || ext === 'pdf'),
            icon,
            diffRecordPath,
            diffOriginalPath,
            ...(extra?.openPath ? { openPath: extra.openPath } : {}),
            ...(extra?.familyId ? { familyId: extra.familyId } : {}),
            ...(extra?.variantId ? { variantId: extra.variantId } : {}),
            ...(extra?.primaryPath ? { primaryPath: extra.primaryPath } : {}),
            ...(extra?.stageBoundaries ? { stageBoundaries: extra.stageBoundaries } : {}),
            ...(extra?.builtAt ? { builtAt: extra.builtAt } : {}),
            ...(extra?.generatedOrigin ? { generatedOrigin: extra.generatedOrigin } : {}),
            // Only when there is one. An empty array would render as a book with
            // "no passes" where the truth is a book nobody has run anything over,
            // and the versions page distinguishes the two.
            ...(extra?.ledger && extra.ledger.length > 0 ? { ledger: extra.ledger } : {}),
          });
        }
      };

      // Every project is a manifest directory. A .bfp path can only be a stale
      // reference from before single-file projects were retired; naming it beats
      // silently statting it as a directory.
      if (projectPath.toLowerCase().endsWith('.bfp')) {
        return {
          success: false,
          error: `${projectPath} is a legacy .bfp project file; those are no longer supported — open the project directory instead.`,
        };
      }
      if (!fsSync.statSync(projectPath).isDirectory() ||
          !fsSync.existsSync(path.join(projectPath, 'manifest.json'))) {
        return { success: false, error: `Not a BookForge project directory (no manifest.json): ${projectPath}` };
      }

      const projectDir = projectPath;

      // ── A PDF project's generated book, given to the ones that predate it ────
      //
      // Run HERE as well as at open, because this page is where the two acts are
      // offered: "Erase all changes" needs an archive-grade book to re-mint from,
      // and a project cast before 2026-08-09 has its cast book AS its working
      // copy. `ensureGeneratedEpub` is idempotent — a project that already has
      // one costs a manifest read and a stat — and it never guesses: the states
      // it cannot classify come back in `missing` and are said on the console
      // rather than repaired.
      //
      // A write from a listing is deliberate and has precedent here
      // (`migrateWorkingEpubNaming` runs from `ensureBookEpub` for the same
      // reason): a one-time normalization happens the next time anything asks
      // about the project, or it never happens at all.
      const adoption = await manifestService.ensureGeneratedEpub(projectDir);
      if (adoption.missing !== null) console.warn(`[editor:get-versions] ${adoption.missing}`);

      // ── The project's working chains, given to it here if it predates them ──
      //
      // Same placement and same argument as the adoption above: a one-time
      // normalization happens the next time anything asks about the project, or
      // it never happens at all. `requireFamily` also does this on its way past,
      // so this is belt and braces — but this listing is the one surface that
      // shows a project which HAS no book yet, and those never reach the
      // chokepoint.
      const chainsAdoption = await manifestService.ensureBookFamilies(projectDir);
      if (chainsAdoption.refusal !== null) {
        console.warn(`[editor:get-versions] ${chainsAdoption.refusal}`);
      }
      const families = await manifestService.readBookFamilies(projectDir);

      // ── The family: the archive original and the working copy it minted ─────
      //
      // RULED 2026-08-04 (docs/PIPELINE_V2_PLAN.md), reversing the old rule that
      // the working copy is a system file with no line item: a book was cast and
      // detected from the queue and afterwards the versions page listed only the
      // archive. The work existed on disk and had no door.
      //
      // The ARCHIVE row is listed for every PDF the project holds, whether or not
      // anything has been done with it. It used to be emitted only alongside a
      // working copy, which put the archive PDF of a freshly imported book
      // nowhere — and Convert to EPUB and Create working copy are precisely the
      // two things you do to a PDF nothing has happened to yet. The WORKING row
      // is still derived from the binding record plus the file's existence:
      // nothing scans a directory for something that looks like a working copy,
      // and no binding, or no file, means no row.
      const projectPdfs = await listProjectPdfs(projectDir);
      const workingDocs = await listWorkingDocuments(projectDir);
      const workingByPrimary = new Map(workingDocs.map((doc) => [doc.primaryRelPath, doc]));
      const familyPaths = new Set(projectPdfs.map((pdf) => pdf.absPath.toLowerCase()));

      // The export is named after the book, so it is located by its manifest
      // record — a scan of source/ cannot tell it from any other file there.
      // Read HERE, before the family rows, because two of them are opened ON it:
      // the archive and the cast are read-only, and pointing at their own file
      // would be pointing the user at a book they cannot edit.
      //
      // A project with SEVERAL chains has several — one per version — and the
      // ARCHIVE and GENERATED rows below open on the copy of the chain that
      // hangs off THEM, which for those two rows is the project's own archive
      // original. So the one asked for here is the sole chain's, and a project
      // with several leaves those rows without an open target rather than
      // pointing them at some other version's book.
      const soleChain = families.length === 1 ? families[0] : null;
      const exportRecord = soleChain === null
        ? null
        : await manifestService.readExportEpub(projectDir, soleChain.id);
      // Only a copy that is ON DISK may be named as a row's open target. A
      // record whose file has gone is a re-mint waiting to happen, and the
      // picker is where that happens and says so — sending it the archive
      // instead lets its redirect do the ensure, with the receipt.
      const workingCopyOpenPath = exportRecord && fsSync.existsSync(exportRecord.absPath)
        ? exportRecord.absPath
        : undefined;
      const archiveOriginal = await manifestService.readArchiveOriginal(projectDir);

      for (const pdf of projectPdfs) {
        await addVersion(
          `archive:${pdf.relPath}`,
          'archive',
          path.basename(pdf.absPath, path.extname(pdf.absPath)),
          'The book exactly as you imported it. Nothing is ever written to it.',
          pdf.absPath,
          '📕',
          // NOT editable, and that is a fact about the file rather than about
          // the button: nothing may ever write to the archive original. It is
          // OPENABLE all the same, and it opens ITSELF — the pages, read-only.
          //
          // This row redirected to the working copy from 2026-08-09 to
          // 2026-08-12, borrowing the ruling made for archive-grade BOOKS
          // ("instead of prompting the user to open the working copy, lets
          // just open the working copy"). For a PDF that borrowing was wrong,
          // and the shared plan always said so: `planArtifactOpen` sends a
          // book-type archive to the copy and lets PAGES open as themselves
          // ("i would like to be able to scan through them", 2026-08-10) —
          // and on 2026-08-12 Owen hit the contradiction: "opening the pdf
          // archive file just opens the epub working file. i want ot be able
          // to look at the pdf as well." A user clicking a file that is
          // visibly a PDF wants the pages; their book has rows of its own.
          // No openPath, so the row hands over its own file and the picker's
          // redirect (the safety net) agrees with it.
          false,
          undefined,
          {
            variantId: pdf.id,
            primaryPath: pdf.absPath,
          }
        );

        const doc = workingByPrimary.get(pdf.relPath);
        if (!doc) continue;
        await addVersion(
          `working:${doc.workingRelPath}`,
          'working',
          'Working copy',
          'Your copy of the original, and the curation you have done on it.',
          doc.workingAbsPath,
          '✏️',
          true,
          undefined,
          {
            // The PROJECT's primary, never the working file itself — see openPath.
            openPath: doc.primaryAbsPath,
            primaryPath: doc.primaryAbsPath,
            stageBoundaries: doc.binding.boundaries.map((b) => ({
              stage: b.stage, finishedAt: b.finishedAt,
            })),
          }
        );
      }

      // ── The book cast from the pages, between the archive and the copy ──────
      //
      // A row of its own because it is an artifact of its own: archive-grade,
      // never written to, and the thing every working copy of this book is
      // minted from. It used to have no row because it did not exist as a
      // separate file — `vlm-convert` wrote straight onto the working copy — so
      // the only way to throw the cast away was to delete the book the user was
      // editing, which is why "reset my edits" used to cost an hour of GPU.
      //
      // NOT editable, for the same reason the archive is not: this is one of the
      // two files in a project nothing may write to.
      //
      // Its Open lands on the working copy, exactly as the archive row's does.
      // It used to open the cast itself read-only so a user could tell a bad
      // reading from a bad edit; that comparison is still available — the row
      // says which file it is, and Export saves it — but an Open that puts the
      // user somewhere they cannot work is the prompt this release removed.
      const generatedRecord = await manifestService.readGeneratedEpub(projectDir);
      // WHICH chain the cast book is the source of. A cast book is archive-grade,
      // so exactly one chain hangs off it, found by the path the chain records —
      // never by "the first generated-epub chain", which is the kind of guess
      // families exist to remove. Null means the file is on disk and no chain
      // claims it; the row is still drawn (it is a real artifact) and the page
      // draws it loose, saying what it can rather than hiding it.
      const castChain = generatedRecord === null
        ? null
        : families.find(
          (f) => f.source.kind === 'generated-epub'
            && f.source.path.toLowerCase() === generatedRecord.relPath.toLowerCase()) ?? null;
      if (generatedRecord) {
        await addVersion(
          'generated',
          'generated',
          path.basename(generatedRecord.absPath, path.extname(generatedRecord.absPath)),
          // The parent is NAMED, not alluded to — Owen, 2026-08-10: a book line
          // that does not say which version it came from "breaks the chain of
          // custody". A project with several PDFs has exactly one archive
          // original, and this book came out of that one.
          generatedRecord.origin === 'cast'
            ? `The book read out of ${archiveOriginal
                ? `${path.basename(archiveOriginal.absPath)}'s`
                : 'your PDF\'s'} pages. Nothing writes to it — your working copy is made from it.`
            : `The book read out of ${archiveOriginal
                ? `${path.basename(archiveOriginal.absPath)}'s`
                : 'your PDF\'s'} pages, kept from when BookForge started preserving them — so it `
              + 'carries any edits made before that. Nothing writes to it now.',
          generatedRecord.absPath,
          '📗',
          false,
          undefined,
          {
            generatedOrigin: generatedRecord.origin,
            openPath: workingCopyOpenPath,
            ...(castChain ? { familyId: castChain.id } : {}),
          }
        );
      }

      // 1. Original source file
      //
      // Skipped when the file is already an ARCHIVE row above. `source/original.pdf`
      // is usually the project's PDF variant too, and listing one file as both
      // "Original Source" and the family's archive parent would put two rows and
      // two sets of buttons on one document — with only one of them carrying the
      // family the working copy and the book hang off.
      const sourceDir = path.join(projectDir, 'source');
      if (fsSync.existsSync(sourceDir)) {
        const sourceFiles = await fs.readdir(sourceDir);
        for (const file of sourceFiles) {
          const ext = path.extname(file).toLowerCase();
          const baseName = path.basename(file, ext);
          if (baseName === 'original' && !familyPaths.has(path.join(sourceDir, file).toLowerCase())) {
            await addVersion(
              'original',
              'original',
              'Original Source',
              `The original ${ext.toUpperCase().replace('.', '')} file you imported`,
              path.join(sourceDir, file),
              ext === '.pdf' ? '📄' : '📘',
              true
            );
          }
        }
      }

      // When REFLOW wrote this project's book, per the binding that recorded it.
      // Matched by the recorded path so a project with two working documents
      // cannot attribute one's build time to the other's book.
      const recordedEpubBuilds = new Map<string, string>();
      for (const doc of workingDocs) {
        const epub = doc.binding.epub;
        if (epub) recordedEpubBuilds.set(epub.path.toLowerCase(), epub.writtenAt);
      }

      // The ROW IS LABELLED WITH THE BOOK'S NAME, not with a fixed "Exported
      // EPUB": the fixed label kept the retired `exported.epub` alive in the
      // user's head long after the file was renamed after the book, so a correct
      // export still read as "the old exported.epub is back" (Aug 3 2026). The
      // id/type stay 'exported' — they are the contract the version consumers
      // key off. (`exportRecord` is read up with the family rows, which open on
      // it.)
      //
      // ── ONE PAIR OF ROWS PER CHAIN ────────────────────────────────────────
      //
      // A project may now hold several versions, each with its own working copy,
      // its own ledger and its own narration copy, so this walks the chains
      // rather than asking the project for "the" book. The row ID stays
      // `exported`/`narration` when there is ONE chain — that is the contract
      // every existing consumer keys off, and with one chain it names exactly
      // one row, so nothing has to change to keep working. With several, each
      // row takes its chain's id (`exported:fam-…`), because two rows sharing an
      // id are two rows nothing can tell apart.
      for (const chain of families) {
        // ── A CHAIN THAT VANISHED MID-LISTING COSTS ITS ROWS, NOT THE PAGE ───
        //
        // `families` was read once, up top; every call below names `chain.id`,
        // and a chain deleted between the two — an erase in another window, a
        // version delete — makes the resolver refuse BY NAME, which threw out of
        // this loop and painted the whole versions page red. The same rule the
        // `hasWorkingChanges` line already follows a few lines down: a listing
        // draws what it can prove and the change that raced it will broadcast
        // its own refresh.
        let chainExport: manifestService.ExportEpubLocation | null;
        let bookLedger: Awaited<ReturnType<typeof manifestService.readBookLedger>>;
        let narrationRecord: Awaited<ReturnType<typeof manifestService.readNarrationEpub>>;
        try {
          chainExport = await manifestService.readExportEpub(projectDir, chain.id);
          bookLedger = await manifestService.readBookLedger(projectDir, chain.id);
          narrationRecord = await manifestService.readNarrationEpub(projectDir, chain.id);
        } catch (err) {
          console.warn(
            `[editor:get-versions] ${path.basename(projectDir)}: chain ${chain.id} could not be `
            + `read and has no rows on this listing: ${(err as Error).message}`);
          continue;
        }
        const sole = families.length === 1;
        if (chainExport) {
        // The book's ledger, read from the manifest rather than by scanning
        // `source/ledger/`: a directory that nothing records is not this book's
        // history, exactly as a book that nothing records is not this project's
        // book. The UI pass that renders these rows owns the layout; this side
        // owes it the entries, in the order they ran, and whether each has a
        // frozen diff worth offering a review button for. (Read above, with the
        // rest of this chain's records, so one vanished chain skips one chain.)
        await addVersion(
          sole ? 'exported' : `exported:${chain.id}`,
          'exported',
          path.basename(chainExport.absPath, path.extname(chainExport.absPath)),
          // Named as what it IS rather than as an output, because the act on
          // this row is now "Erase all changes": a row calling itself "the EPUB
          // with your edits applied" beside a button that clears them is a row
          // the user has to reconcile. The PARENT is named too (Owen,
          // 2026-08-10: an epub that does not point at which version it came
          // from "breaks the chain of custody"): the generated book when the
          // project has one, else the archive original the copy was minted
          // from. A project with neither still has a true, if parentless,
          // sentence — that state is real (a legacy layout mid-migration).
          //
          // The parent is now the CHAIN'S OWN SOURCE rather than whichever
          // archive-grade file the project happens to hold: with several
          // versions in one project those are different files, and naming the
          // wrong one is precisely the broken custody Owen was describing.
          `Your copy of ${path.basename(chain.source.path)}, and every change you `
          + 'have made to it',
          chainExport.absPath,
          '✅',
          true,
          undefined,
          {
            familyId: chain.id,
            builtAt: recordedEpubBuilds.get(chainExport.relPath.toLowerCase()),
            ledger: bookLedger.map((entry) => {
              // Resolved here, once, from the project-relative paths the entry
              // records. The renderer holds no project directory to join them
              // onto and must never learn to — the same rule the rest of these
              // rows follow, which is why every one of them carries an absolute
              // `path` rather than a relative one.
              const receiptPath = entry.receipt === null
                ? null
                : path.resolve(projectDir, entry.receipt.split('/').join(path.sep));
              const snapshotPath =
                path.resolve(projectDir, entry.snapshot.split('/').join(path.sep));
              return {
                id: entry.id,
                kind: entry.kind,
                label: entry.label,
                createdAt: entry.createdAt,
                // The FILE, not the record. This used to be `entry.receipt !==
                // null` — a claim read off the manifest — while the comment on
                // the field promised "a receiptPath that names a file which is
                // not there would be a disabled button with no reason to give".
                // It was not: a receipt whose file had gone drew an ENABLED
                // Review changes that opened a viewer with nothing in it. Asked
                // of the disk, the line is drawn disabled with its sentence.
                hasReceipt: receiptPath !== null && fsSync.existsSync(receiptPath),
                snapshotPath,
                // Asked of the DISK, exactly as `hasReceipt` is and for the
                // same reason: the compare shows this book, and a record
                // naming a snapshot that is not there would draw an enabled
                // button onto an empty pane. A separate question from the
                // receipt — one is the diff, this is the book.
                hasSnapshot: fsSync.existsSync(snapshotPath),
                receiptPath,
              };
            }),
          }
        );
        }

        // The NARRATION COPY, when one has been cut: the book minus what the
        // user struck out, and the file narration prefers as its input the
        // moment it exists (ll-wizard `ttsInput`). It was written and recorded
        // here all along and simply had no row — so the one place a user looks
        // to see what versions of a book exist said the copy they had just made
        // did not, and there was no way to open, play or delete it (Aug 8 2026).
        //
        // It carries its chain's id because the Process button on this row is
        // how narration is told which document it has (Owen's law: the pipeline
        // knows the file because the user came to it FROM the button on that
        // document).
        //
        // NOT editable: it is a derived cut, remade from the book and the
        // strikes every time `Export TTS copy` runs, so an edit made here would
        // be thrown away by the next export without saying so.
        if (narrationRecord) {
          await addVersion(
            sole ? 'narration' : `narration:${chain.id}`,
            'narration',
            `${path.basename(narrationRecord.absPath, path.extname(narrationRecord.absPath))}`,
            'The book with what you struck out removed — what narration reads',
            narrationRecord.absPath,
            '🎙️',
            false,
            undefined,
            { familyId: chain.id }
          );
        }
      }

      // 2. Cleaned/Simplified EPUB from stages/01-cleanup/
      const cleanupDir = path.join(projectDir, 'stages', '01-cleanup');
      if (fsSync.existsSync(cleanupDir)) {
        const simplifiedPath = path.join(cleanupDir, 'simplified.epub');
        const repairedPath = path.join(cleanupDir, 'repaired.epub');
        const cleanedPath = path.join(cleanupDir, 'cleaned.epub');

        if (fsSync.existsSync(simplifiedPath)) {
          await addVersion(
            'simplified', 'simplified', 'Simplified EPUB',
            'AI-simplified for language learners',
            simplifiedPath, '📖', true
          );
        }
        // Pass-1 (OCR repair) intermediate: scanner damage fixed, footnote markers
        // and curly quotes still present (pass 2 handles those → cleaned.epub).
        // addVersion auto-attaches repaired.diff.json (original → repaired) as its
        // diff record. Listed before cleaned so the pipeline reads top-to-bottom.
        if (fsSync.existsSync(repairedPath)) {
          await addVersion(
            'repaired', 'repaired', 'OCR-Repaired EPUB',
            'After OCR repair - scanner damage fixed (before TTS prep)',
            repairedPath, '🔧', true
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

          // The EPUB the analyzer was pointed at (recorded in the report/checkpoint).
          // Reports generated on another machine (e.g. the Mac, /Volumes/Callisto/…)
          // record that machine's path; resolve it to THIS machine's library so the
          // reconciliation below can still find the version and View can open it.
          const rawEpubPath: string = (isCheckpoint ? analysisData.sourceEpubPath : analysisData.epubPath) || '';
          const storedEpubPath: string = resolvePath(rawEpubPath) || '';

          // Resolve the DURABLE target version this report belongs to. A report
          // written after the per-version feature carries `target` verbatim — use
          // it and never re-point. Legacy reports (no target) are reconciled ONCE
          // by matching the recorded epubPath to a collected version's exact path;
          // if nothing matches, the report is ORPHANED (versionId: null). We must
          // NOT silently re-point it to a different file (NO-FALLBACKS rule).
          const samePath = (a: string, b: string) =>
            !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
          let analysisTarget: { versionId: string | null; versionType: string; versionLabel: string };
          const storedTarget = !isCheckpoint ? analysisData.target : null;
          if (storedTarget && storedTarget.versionId) {
            analysisTarget = {
              versionId: storedTarget.versionId,
              versionType: storedTarget.versionType || '',
              versionLabel: storedTarget.versionLabel || '',
            };
          } else {
            const match = versions.find(v => samePath(v.path, storedEpubPath));
            analysisTarget = match
              ? { versionId: match.id, versionType: match.type, versionLabel: match.label }
              : { versionId: null, versionType: '', versionLabel: '' };
          }

          // Best-effort path to the analyzed file (for the View action / orphan info):
          // the matched target row's path, else the recorded epubPath if it still exists.
          const targetRow = analysisTarget.versionId
            ? versions.find(v => v.id === analysisTarget.versionId)
            : undefined;
          const analyzedFilePath = targetRow?.path
            ?? (storedEpubPath && fsSync.existsSync(storedEpubPath) ? storedEpubPath : '');

          const stats = await fs.stat(activeAnalysisPath);
          const description = isCheckpoint
            ? `Content analysis (partial ${completedChapters}/${totalChapters} chapters): ${flagCount} flag${flagCount !== 1 ? 's' : ''} found`
            : `Content analysis: ${flagCount} flag${flagCount !== 1 ? 's' : ''} found`;
          versions.push({
            id: 'analysis',
            type: 'analysis',
            label: 'View Analysis',
            description,
            path: analyzedFilePath,
            extension: analyzedFilePath ? path.extname(analyzedFilePath).toLowerCase().replace('.', '') : '',
            modifiedAt: stats.mtime.toISOString(),
            fileSize: stats.size,
            editable: true,
            icon: '🔍',
            analysisTarget,
            analysisFlagCount: flagCount,
            analysisIsCheckpoint: isCheckpoint,
          });
        } catch (err) {
          console.warn('[editor:get-versions] Failed to read analysis data:', err);
        }
      }

      // ── The chains themselves, so the page can draw one per version ─────────
      //
      // The rows say which chain each file is on; this says which chains there
      // ARE, and what each one is a chain OF. Both are needed and neither can be
      // derived from the other: a chain whose working copy is missing has no row
      // at all and would simply vanish from a page that inferred the list from
      // the rows, and the arrangement would have no way to draw the book line of
      // a chain the user can still erase and re-mint.
      //
      // `archiveRowId` is the PDF this chain's book was read out of, when it was
      // one. A project holds exactly one archive original, and a cast book is
      // the reading of THAT file — so the link is looked up rather than guessed,
      // and is null when the original is not a PDF with a row of its own.
      const archivePdfRowId = archiveOriginal !== null
        && projectPdfs.some(
          (pdf) => pdf.relPath.toLowerCase() === archiveOriginal.relPath.toLowerCase())
        ? `archive:${archiveOriginal.relPath}`
        : null;
      // Whether each chain has anything an erase would remove — what gates the
      // working-changes line. Measured against the same list the erase clears
      // (`workingChangesByFamily` mirrors `resetEditorRecords`), because a line
      // drawn for the copy's mere existence survives its own successful delete:
      // the erase re-mints the copy on the spot.
      const erasableByFamily = await manifestService.workingChangesByFamily(projectDir);
      const chains = families.map((chain) => ({
        id: chain.id,
        sourceKind: chain.source.kind,
        // The basename the user would recognise this version by. The page states
        // the chain of custody in it — with two book lines on screen it is the
        // only thing that tells them apart.
        sourceName: chain.source.path.split('/').pop() ?? chain.source.path,
        archiveRowId: chain.source.kind === 'generated-epub' ? archivePdfRowId : null,
        // `=== true` rather than a lookup with a default: the map was built from
        // the same manifest one read ago, so an absent id means the family list
        // changed between the two reads — false draws less, and the change that
        // raced us will broadcast its own refresh.
        hasWorkingChanges: erasableByFamily[chain.id] === true,
        // Whether this chain's archive-grade book is where the record says. It
        // is the "before" of the FIRST pass and of no other, so it gates that
        // one line's Compare — measured with the same `existsSync`
        // `requireFamilySource` refuses on, so the button and the act that
        // follows it cannot disagree about whether the file is there.
        hasSource: fsSync.existsSync(
          path.resolve(projectDir, chain.source.path.split('/').join(path.sep))),
      }));

      return { success: true, versions, families: chains };
    } catch (err) {
      console.error('[EDITOR:GET-VERSIONS] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * Save EPUB bytes to a path inside the library.
   *
   * ── What it may NOT land on, and why the library check was not enough ──────
   *
   * Inside-the-library was the only guard this had, and `archive/Book.epub` and
   * `source/<stem>.generated.epub` are both inside the library: the two files
   * four other places refuse to touch by name (memory:
   * pipeline-source-model-archive-as-source) were writable through this door.
   * They are refused HERE, BY RECORD — `readArchiveOriginal` and
   * `readGeneratedEpub` say which files they are — rather than by matching a
   * folder name, because the manifest is where an artifact's identity is settled
   * and a name match would be a second, weaker derivation of it.
   *
   * ── And a working copy that is written must be RE-RECORDED ──────────────
   *
   * Landing on a chain's working copy used to change the bytes and say nothing:
   * `family.epub.modifiedAt` went on describing the old file and, worse, the
   * narration strike record went on carrying the PREVIOUS book's digest — a void
   * record, which is exactly what makes the naming pass refuse and what
   * `nameChapterOpenings` then has to be told to withhold over.
   * `registerEpubExport` is the one path that records a written book, so the
   * save goes through it.
   */
  ipcMain.handle('editor:save-epub', async (_event, epubPath: string, epubData: ArrayBuffer) => {
    try {
      if (!epubPath) {
        return { success: false, error: 'No EPUB path provided' };
      }

      const outsideLibrary = insideLibraryRefusal(epubPath, 'EDITOR:SAVE-EPUB');
      if (outsideLibrary) return { success: false, error: outsideLibrary };

      const libraryRoot = getLibraryRoot();
      const normalizedEpubPath = path.normalize(path.resolve(normalizeFsPath(epubPath)));

      // Which project this path is in, when it is in one. Everything below — the
      // archive-grade refusals and the record — is about a project's files; a
      // path elsewhere in the library is written exactly as it always was.
      const projectsDir = path.normalize(path.join(libraryRoot, 'projects'));
      let projectDir: string | null = null;
      if (normalizedEpubPath.startsWith(projectsDir + path.sep)) {
        const projectSlug = path.relative(projectsDir, normalizedEpubPath).split(path.sep)[0];
        const candidate = path.join(projectsDir, projectSlug);
        if (fsSync.existsSync(path.join(candidate, 'manifest.json'))) projectDir = candidate;
      }

      let familyOfTarget: string | null = null;
      if (projectDir !== null) {
        const archiveOriginal = await manifestService.readArchiveOriginal(projectDir);
        if (archiveOriginal !== null && sameResolvedPath(archiveOriginal.absPath, epubPath)) {
          return {
            success: false,
            error: `${path.basename(epubPath)} is this project's archive original — the book exactly `
              + 'as you imported it, which nothing may ever write to. Save to the working copy.',
          };
        }
        const generated = await manifestService.readGeneratedEpub(projectDir);
        if (generated !== null && sameResolvedPath(generated.absPath, epubPath)) {
          return {
            success: false,
            error: `${path.basename(epubPath)} is the book read out of this project's pages, and every `
              + 'working copy is minted from it, so nothing may write to it. Save to the working copy.',
          };
        }
        // WHICH chain's working copy this is, when it is one. Resolved BEFORE
        // the write, so a refusal costs nothing.
        for (const chain of await manifestService.readBookFamilies(projectDir)) {
          const recorded = chain.epub?.path;
          if (recorded && sameResolvedPath(path.join(projectDir, recorded), epubPath)) {
            familyOfTarget = chain.id;
            break;
          }
        }
      }

      // Ensure the directory exists
      const epubDir = path.dirname(epubPath);
      await fs.mkdir(epubDir, { recursive: true });

      // ── The editor hands over an ARCHIVE; the book may not be one ───────────
      //
      // A renderer can build a zip and cannot build a folder, so what arrives
      // here is always archive bytes. `fs.writeFile(epubPath, buffer)` was right
      // while every book was a file and is wrong the moment one is a working
      // copy: it would be an EISDIR, or — if the tree had been removed first — a
      // zip left standing where a folder of the book's parts belongs. So the
      // bytes are landed as whichever container is already there, and a path
      // with nothing at it takes the working-copy shape when it IS one.
      const buffer = Buffer.from(epubData);
      const { epubContainerKindAt } = await import('./epub-container.js');
      const existingKind = await epubContainerKindAt(epubPath);
      const kind = existingKind ?? (familyOfTarget !== null ? 'directory' : 'zip');
      await writeEpubFromArchiveBytes(buffer, epubPath, kind);

      // Merge fragmented paragraphs (line-level PDF blocks → sentence-aligned paragraphs)
      await mergeEpubParagraphs(epubPath);

      console.log(`[EDITOR:SAVE-EPUB] Saved EPUB to ${epubPath} (${buffer.length} bytes as `
        + `${kind === 'directory' ? 'a folder of its parts' : 'an archive'})`);

      // The record follows the bytes. `registerEpubExport` re-stamps
      // `family.epub`, drops the narration copy that was cut from the book just
      // replaced, and supersedes the passes the new bytes no longer carry — all
      // of which this handler used to leave describing a file that was gone.
      if (projectDir !== null && familyOfTarget !== null) {
        await manifestService.registerEpubExport(
          projectDir, epubPath, undefined, familyOfTarget);
      }

      // Every window: the picker, the editor and the listen windows all draw
      // this project's files, and only one of them is the main window.
      if (projectDir !== null) {
        broadcastToAllWindows('project:files-changed', projectDir);
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

// quire serves an EPUB's own bytes — to the offscreen frame that paginates it
// for analysis, and to the on-screen frames that show it — out of the archive
// and through `quire://`. Registering it is a before-ready operation like the
// two above, and quire refuses to open a book at all if it was not done
// (SCHEME_NOT_REGISTERED) rather than serving a blank one.
//
// Deliberately NOT privileged the way `bookforge-page` is: `bypassCSP` is false
// on it, because the whole point is that the book's CSP applies to the book, and
// `supportFetchAPI` is false so nothing in a quire document can fetch anything.
// And quire attaches the handler to the DOCUMENT's session, never to the app's,
// so a book never shares an origin with BookForge.
Quire.registerScheme();

// Single-instance lock: a second launch must NOT run while the first is doing
// the first-run runtime unpack — two processes extracting/copying into the same
// userData/runtime dir is a prime cause of a corrupted install. The second
// instance just focuses the existing window and exits.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (isPrimaryInstance) {
  app.on('second-instance', (_event, argv) => {
    // `electron . --clipforge` while BookForge is running: the second process
    // relays its intent here and exits — WE open the ClipForge window.
    if (argv.includes('--clipforge')) {
      openClipforgeWindow();
      return;
    }
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

  // The live-DOM EPUB viewer's opening channel. The scheme it needs was
  // registered at module scope above; this is only the two handles.
  setupQuireViewerIpc();
  // And the other direction: the record-keeper is told how to close a book a
  // viewer is reading, so removing a ledger entry's directory does not race a
  // pass compare that is showing its snapshot. Registered rather than imported,
  // because manifest-service also runs in the CLI and in tools/test-*.js where
  // there are no windows and nothing to close.
  manifestService.useViewerReaderCloser(closeViewerDocumentsUnder);
  logger.info('BookForge starting', { version: app.getVersion(), platform: process.platform });

  // In development, point FOUNDRY_CLI_PATH at the locally-built binary unless
  // the developer set one. Dev only: a packaged build resolves the foundry CLI
  // from the component (or the user's own environment variable) and nothing
  // else, because "whatever binary is lying around" is precisely what both
  // programs refuse to run. Logs which binary it chose, or that it found none.
  if (isDev) {
    try {
      const { primeFoundryDevCliPath } = await import('./foundry-dev-cli.js');
      primeFoundryDevCliPath();
    } catch (err) {
      logger.warn('foundry dev binary resolution failed', { error: (err as Error).message });
    }
  }

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
        const { evictStaleRenderCache, removeRetiredStampedCopies } =
          await import('./render-cache.js');
        const { evicted, freedBytes } = await evictStaleRenderCache();
        if (evicted > 0) {
          logger.info('Evicted stale render caches', {
            documents: evicted,
            freedMB: Math.round(freedBytes / 1024 / 1024),
          });
        }
        // quire no longer keeps a stamped copy of every book it lays out, and
        // there is one of those per book AND per edit of a book. They are dead
        // the moment this build runs, so they go now rather than in thirty days.
        const stamped = await removeRetiredStampedCopies();
        if (stamped.removed > 0) {
          logger.info('Removed retired quire stamped copies', {
            files: stamped.removed,
            freedMB: Math.round(stamped.freedBytes / 1024 / 1024),
          });
        }
      } catch (err) {
        logger.warn('Render cache eviction failed', { error: (err as Error).message });
      }

      // Sweep ebook-* session folders in the active scratch dir older than 7
      // days. The chained pipeline now deletes each scratch session as soon as
      // it's cached + assembled, so this is just a backstop for sessions that
      // were abandoned mid-run or kept for bilingual assembly — a week safely
      // exceeds any in-flight job without letting duplicates pile up for a month.
      // Shared by the sweeps below (stale TTS sessions + launcher leftovers).
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

      try {
        const tmpDir = getDefaultE2aTmpPath();
        const STALE_MS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let entries: import('fs').Dirent[] = [];
        try {
          entries = await fs.readdir(tmpDir, { withFileTypes: true });
        } catch {
          entries = []; // tmp dir may not exist yet — nothing to sweep
        }

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

      // One-time sweep of the removed code-bundle launcher's leftovers:
      // userData/app held the <version>/dist bundles + current.json pointer the
      // old launcher booted from. A launcher-less build never reads them, so on
      // machines that ran the old self-updating app they're hundreds of MB of
      // dead weight. Packaged-only: in dev, a still-installed old launcher app
      // shares this userData and needs its bundle until it's replaced.
      if (app.isPackaged) {
        try {
          const launcherRoot = path.join(app.getPath('userData'), 'app');
          const pointer = path.join(launcherRoot, 'current.json');
          // Only sweep a dir that is really the launcher's (pointer present or
          // version-folder layout) — never blind-delete a same-named stranger.
          const hasPointer = await fs.stat(pointer).then(() => true, () => false);
          if (hasPointer) {
            const freed = await dirSize(launcherRoot);
            await fs.rm(launcherRoot, { recursive: true, force: true });
            logger.info('Removed the old self-update launcher\'s code bundles', {
              dir: launcherRoot,
              freedMB: Math.round(freed / 1024 / 1024),
            });
          }
        } catch (err) {
          logger.warn('Launcher-leftover sweep failed', { error: (err as Error).message });
        }
      }
    })();
  }, 15_000);

  // Register the protocol handlers
  registerPageProtocol();
  registerAudioProtocol();

  setupIpcHandlers();
  setupAlignmentIpc();
  registerClipforgeIpc();
  registerDocumentIpc();
  // `electron . --clipforge` (the clipforge:electron:dev script) opens ONLY the
  // ClipForge window for a clean single-app dev session; otherwise BookForge.
  if (process.argv.includes('--clipforge')) {
    openClipforgeWindow();
  } else {
    createWindow();
    if (mainWindow) {
      pdfWorkerProxy.setDefaultSender(mainWindow.webContents);
    }
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

  // ── Move every project's editor state out of its manifest ────────────────
  //
  // `manifest:list` reads and parses EVERY manifest on every Studio load, and
  // until this sweep has run those manifests still carry the picker's working
  // state — 146.6 MB of 148 MB of manifest content across this library, one book
  // at 26 MB. Migrate-on-contact alone would only fix a project somebody opened,
  // so the list would stay slow for months; this does the whole library once.
  //
  // BACKGROUND and NOT AWAITED: it is pure file movement, the window must not
  // wait for it, and every project it fails on is logged by name and skipped
  // (editor-state-store.ts) rather than aborting the rest. Only runs once a
  // library location is known — before that there is nothing to sweep, and
  // `library:set-root` will have swept nothing because a fresh library has no
  // pre-sidecar projects in it.
  if (customLibraryRoot) {
    void sweepEditorState(manifestService.getProjectsPath())
      .then(({ scanned, migrated, failed }) => {
        console.log(
          `[Startup] Editor state: migrated ${migrated} of ${scanned} project(s) out of `
          + `manifest.json into editor-state.json${failed > 0 ? `, ${failed} failed` : ''}.`,
        );
      })
      .catch((err) => {
        console.error(
          '[Startup] The editor-state sweep could not run at all:', (err as Error).message,
          '— projects will still migrate as they are opened.',
        );
      });
  }

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
    if (clipforgeWindows.has(win)) {
      loadClipforge(win);
      return;
    }
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
    },
    {
      label: 'ClipForge',
      submenu: [
        {
          label: 'Open ClipForge Window',
          click: () => { openClipforgeWindow(); },
        }
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

/**
 * A cleanup step that cannot hold the quit hostage.
 *
 * before-quit prevents the default and quits again only after every step below
 * resolves. Each step is try/caught, but a HANG is not an exception: one await
 * that never settles (a keep-alive socket holding a server's close, a child
 * ignoring SIGTERM, a stuck WSL copy) and app.quit() is never reached — the
 * window is gone, the user believes the app is closed, and the main process
 * plus every Electron child lives on invisibly. That is exactly the stray-
 * process pile observed on 2026-08-10 (five electron.exe with no window).
 *
 * So every step gets a DEADLINE and a NAME. On timeout the step is abandoned
 * LOUDLY — the log says which step hung, because whatever it left behind is
 * the explanation for any stray process — and the shutdown moves on. The
 * budgets are generous: the point is never to cut a healthy step short, only
 * to make "this step never finishes" mean a named log line instead of a
 * zombie.
 */
function quitStepWithDeadline(label: string, ms: number, run: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[MAIN] QUIT WATCHDOG: '${label}' did not finish within ${ms / 1000}s — abandoning it `
        + 'and continuing shutdown. If stray processes survive this quit, this step is why.');
      resolve();
    }, ms);
  });
  return Promise.race([run(), deadline]).finally(() => clearTimeout(timer));
}

app.on('before-quit', async (event) => {
  isQuitting = true;
  if (cleanupDone) return;

  // A second instance that lost the single-instance lock never owned any
  // workers — running the GLOBAL kill sweep from it would murder the primary
  // instance's (or a training chain's) WSL/vLLM processes. Quit plainly.
  if (!isPrimaryInstance) return;

  // Prevent quit until cleanup is done
  event.preventDefault();
  cleanupDone = true;

  console.log('[MAIN] Running cleanup before quit...');

  // The absolute backstop behind the per-step deadlines: if the whole chain has
  // not reached app.quit() in this long, something outside a deadline is stuck
  // (or a step's own machinery hung after its race resolved). app.exit takes
  // every Electron process with it — a logged hard exit over an invisible
  // zombie, every time. Generous on purpose: the TTS/WSL block alone is allowed
  // 60s of cooperative shutdown before its own deadline trips.
  const quitBackstop = setTimeout(() => {
    console.error(
      '[MAIN] QUIT WATCHDOG: shutdown did not complete within 120s of before-quit — forcing '
      + 'app.exit(1). The step logs above name what was reached; anything after the last one '
      + 'is what hung.');
    app.exit(1);
  }, 120_000);

  // Every open quire document owns an offscreen BrowserWindow and a session
  // partition. Neither outlives the app, so both are closed by name.
  await quitStepWithDeadline('close quire documents', 15_000, async () => {
    try {
      await closeAllBooksForViewer();
    } catch (err) {
      console.warn('[MAIN] closing quire documents failed:', (err as Error).message);
    }
  });

  // Stop whatever document stage is mid-flight. Each one owns a foundry process
  // which owns a llama-server holding several GB on the GPU; closing the window
  // without aborting leaves both running with nothing left to report to. The
  // abort is what foundry's own staged-temp discipline needs to leave the
  // working document exactly as it stood.
  try {
    const { abortAllStages } = await import('./document-stage-registry.js');
    const stopped = abortAllStages();
    if (stopped > 0) console.log(`[MAIN] Stopped ${stopped} document stage(s)`);
  } catch (err) {
    console.warn('[MAIN] Could not stop the document stages:', err);
  }

  // Kill any active TTS workers. The longest budget of the chain: cooperative
  // SIGTERM with verified waits and a WSL flush are allowed a full minute before
  // being abandoned — this is the block whose abandonment can strand a guest
  // process, so it is the last to be cut short and the loudest when it is.
  await quitStepWithDeadline('kill and flush TTS workers (incl. WSL)', 60_000, async () => {
    try {
      const { killAllWorkers, forceKillAllE2aProcesses, flushActiveSessionsToCache, gracefulWslShutdown } = await import('./parallel-tts-bridge.js');
      // Kill the worker PROCESSES but KEEP the session map — the flush below reads it to
      // promote the sentences rendered so far. (killAllWorkers used to clear the map here,
      // so the flush found nothing and quitting mid-job lost the checkpoint.)
      // AWAITED: per-session cooperative SIGTERM → verified wait → VM terminate for a
      // survivor (never SIGKILL — the WSL wedge trigger).
      await killAllWorkers(false);
      // Also run aggressive cleanup to catch any orphans
      forceKillAllE2aProcesses();
      // Global sweep for anything the session-scoped teardowns missed. Quitting without
      // this strands vLLM mid-CUDA-work inside the guest — the very thing that
      // kernel-wedges the WSL VM until a reboot. An 'unresponsive' outcome is logged
      // loudly; the quit still proceeds (holding the app open can't fix a wedged VM).
      const wslOutcome = await gracefulWslShutdown();
      if (wslOutcome === 'unresponsive') {
        console.error('[MAIN] WSL did not respond during shutdown — VM may be wedged; next launch may need a reboot to use Orpheus.');
      }
      // Now that the workers are dead (files stable) and the sessions are still present,
      // preserve any in-progress render to the durable project cache so quitting mid-job
      // doesn't lose the sentences rendered so far (bounded so a slow WSL copy can't hang).
      await flushActiveSessionsToCache();
    } catch (err) {
      console.error('[MAIN] Failed to kill/flush TTS workers:', err);
    }
  });

  // Kill the streaming worker pools (XTTS and Orpheus) so no Python — or the WSL
  // vLLM process behind Orpheus — outlives the app.
  await quitStepWithDeadline('end streaming TTS sessions', 20_000, async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      if (xttsWorkerPool.isSessionActive()) {
        await xttsWorkerPool.endSession();
      }
      const { orpheusWorkerPool } = await import('./orpheus-worker-pool.js');
      if (orpheusWorkerPool.isSessionActive()) {
        await orpheusWorkerPool.endSession();
      }
    } catch (err) {
      console.error('[MAIN] Failed to end stream TTS session:', err);
    }
  });

  // An AI job (cleanup/simplify) killed mid-flight leaves its model in VRAM for
  // the whole keep_alive window — several GB held by an app that no longer
  // exists (Owen, 2026-08-12). Abort the job's requests and evict its model by
  // name. Finished/cancelled jobs already did this themselves; this covers only
  // the ones the quit is interrupting. A hard SIGKILL still can't run this —
  // there, Ollama's own keep_alive timer is the only backstop there is.
  await quitStepWithDeadline('release AI models (Ollama/local)', 10_000, async () => {
    try {
      const { releaseActiveAiJobsForShutdown } = await import('./ai-bridge.js');
      await releaseActiveAiJobsForShutdown();
    } catch (err) {
      console.warn('[MAIN] Releasing AI models on quit failed:', (err as Error).message);
    }
  });

  // Stop bookshelf server if running. An http server's close waits for every
  // open connection — a phone paused mid-audiobook holds a keep-alive socket,
  // and that is a quit held open by a listener nobody can see.
  await quitStepWithDeadline('stop bookshelf server', 10_000, async () => {
    if (bookshelfServer.isRunning()) {
      await bookshelfServer.stop();
    }
  });

  // Stop TTS API server if running — same keep-alive hazard as the bookshelf.
  await quitStepWithDeadline('stop TTS API server', 10_000, async () => {
    try {
      const { ttsApiServer } = await import('./tts-api-server.js');
      if (ttsApiServer.isRunning()) {
        await ttsApiServer.stop();
      }
    } catch (err) {
      console.error('[MAIN] Failed to stop TTS API server:', err);
    }
  });

  // Terminate PDF worker thread
  await quitStepWithDeadline('terminate PDF worker', 10_000, async () => {
    try {
      await pdfWorkerProxy.terminate();
    } catch (err) {
      console.error('[MAIN] Failed to terminate PDF worker:', err);
    }
  });

  // Dispose all plugins
  await quitStepWithDeadline('dispose plugins', 10_000, async () => {
    const registry = getPluginRegistry();
    await registry.disposeAll();
  });

  // Close loggers
  await quitStepWithDeadline('close loggers', 5_000, async () => {
    await closeLoggers();
  });

  clearTimeout(quitBackstop);
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

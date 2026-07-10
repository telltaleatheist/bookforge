/**
 * Bookshelf Server — HTTP server for remotely browsing/downloading/playing audiobooks.
 *
 * This is the WEB-BASED UI (accessible via browser on any device on the network).
 * It is NOT the Angular Library (ebook catalog on nav rail) or Studio (TTS pipeline).
 *
 * Three distinct views in BookForge:
 *   - Library:   Angular nav rail page — original ebooks/EPUBs/PDFs (electron/ebook-library.ts)
 *   - Studio:    Angular nav rail page — TTS pipeline & project management
 *   - Bookshelf: Web UI (this file) — browse/download/play finished audiobooks remotely
 */

import express, { Request, Response, Application, NextFunction } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';

import { listProjects, getProjectPath, getLibraryBasePath, getProjectsPath, effectiveAudiobookMetadata, getVariants, modifyManifest, deleteProject } from './manifest-service';
import { scanLibrary, getCoverData, getEbooksRoot, getAbsolutePath } from './ebook-library';
import { getFfprobePath, getFfmpegPath } from './tool-paths';
import { extractVttFromM4b } from './metadata-tools';
import { getPdfInfo, renderPdfPage } from './ebook-render';
import { normalizeFsPath } from './path-utils';
import { ReaderStreamBridge } from './reader-stream-bridge';
import { readerAudioStore } from './reader-audio-store';
import { ingestFromUrl, ingestFromFile, analyzePdfPages } from './reader-ingest';
import { buildEpubBuffer, EpubChapter } from './epub-writer';
import { importEpubProject } from './import-epub-project';
import { bookRenderService, saveRenderPlan } from './book-render-service';
import { getActiveEngine, getSelectedEngineName, getDefaultStreamVoice } from './streaming-engine';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BookshelfServerConfig {
  port: number;
  userDataPath?: string;
}

export interface BookshelfServerStatus {
  running: boolean;
  port: number;
  addresses: string[];
}

/** One playable audiobook variant of a project (an edition/language/format). */
interface AudiobookVersion {
  variantId: string;         // the getVariants() id ('audiobook', 'bilingual:<pair>', or a uuid)
  descriptor?: string;       // free text ("German", "Unabridged"); blank → fall back to title/cover
  type: 'audiobook' | 'bilingual';
  langPair?: string;         // bilingual only
  downloadPath: string;      // absolute path to this variant's M4B (also the VTT/position key)
  coverPath?: string;        // absolute path to this variant's cover, if any
  size: number;
  duration?: number;         // seconds
  dateAdded?: string;        // ISO timestamp
}

interface AudiobookEntry {
  projectId: string;
  title: string;
  author: string;
  type: 'audiobook' | 'bilingual';
  langPair?: string;         // e.g. "en-de" for bilingual
  size: number;
  duration?: number;         // duration in seconds
  downloadPath: string;      // absolute path to M4B
  outputFilename?: string;   // metadata-defined display filename (e.g. "Title. Author. (Year).m4b")
  coverPath?: string;        // absolute path to cover image (from manifest)
  dateAdded?: string;        // ISO timestamp — audiobook completedAt or manifest.modifiedAt
  tags?: string[];           // user-defined tags
  source?: 'project' | 'external';  // identifies where the audiobook came from
  // Every playable audiobook variant of this project. The card shows one entry
  // (the primary/representative version); when versions.length > 1 the shelf pops
  // a picker. Always ≥1 for project books; absent for external m4b files.
  versions?: AudiobookVersion[];
}

/** One ebook variant of a project (edition/language/format), for the ebooks picker. */
interface EbookVersion {
  relativePath: string;   // __archive__/<projectId>/<filename> (resolves via getAbsolutePath)
  descriptor?: string;
  format: string;
  title: string;
  authorFull?: string;
  year?: number;
  fileSize: number;
}

interface ExternalMetaCacheEntry {
  size: number;
  mtimeMs: number;
  title: string;
  author: string;
  year?: number;
}

interface ChapterEntry {
  title: string;
  start: number;   // seconds
  end: number;     // seconds
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers (lightweight server-side profiles) + listening analytics
// ─────────────────────────────────────────────────────────────────────────────

interface ReaderProfile {
  id: string;
  name: string;
  pinSalt?: string;
  pinHash?: string;
  createdAt: string;
}

interface ListeningEvent {
  readerId: string;
  bookKey: string;    // library-relative path
  title: string;
  author: string;
  day: string;        // YYYY-MM-DD (recording machine's local day)
  seconds: number;
  at: string;         // ISO timestamp
  // Stable, client-generated id (present on newer clients). Makes the heartbeat
  // write idempotent: an id already in this device's log is ignored, so the
  // offline queue (slice 5) can replay safely without double-counting. Legacy
  // events without an id behave exactly as before.
  id?: string;
  // 'remove' tombstone: dropped into the same append-only log (Syncthing-safe) to
  // erase a book's listening up to its timestamp. Absent on normal listen events.
  type?: 'listen' | 'remove';
}

// Per-book storage unit (books/<bookId>/<deviceId>.json = { [readerId]: BookRecord }).
interface BookPosition { kind: string; value: unknown; at: string; }
interface BookHeard { intervals: number[][]; at: string; }
interface BookmarkOp { op: string; bm: Record<string, unknown> & { id?: string }; at: string; }
// `heardResetAt` is a per-book-per-reader RESET TOMBSTONE (ISO). When a reader
// resets a book's progress, this device stamps `heardResetAt = now` and clears
// its own heard. On merge, the MAX heardResetAt across all devices tombstones
// every heard snapshot written before it (from any device), so a reset wins
// cross-device while post-reset coverage from every device still unions in.
interface BookRecord { position?: BookPosition; heard?: BookHeard; bookmarks?: BookmarkOp[]; heardResetAt?: string; }

// ─────────────────────────────────────────────────────────────────────────────
// Bookshelf Server Class
// ─────────────────────────────────────────────────────────────────────────────

// Lazy-loaded music-metadata module (imported once)
let mmModule: typeof import('music-metadata') | null = null;
async function getMusicMetadata() {
  if (!mmModule) {
    mmModule = await import('music-metadata');
  }
  return mmModule;
}

// Persistent duration cache: filepath → { size, mtimeMs, duration }
interface DurationCacheEntry {
  size: number;
  mtimeMs: number;
  duration: number;
}

export class BookshelfServer {
  private app: Application;
  private server: http.Server | null = null;
  private port: number = 8765;
  private userDataPath: string | null = null;

  // Cover cache to avoid repeated extraction (capped to limit memory)
  private coverCache: Map<string, { data: string; timestamp: number }> = new Map();
  private readonly COVER_CACHE_TTL = 1000 * 60 * 60; // 1 hour
  private readonly MAX_COVER_CACHE_SIZE = 50;

  // Books/ebooks response cache to avoid re-scanning on every request
  private booksCache: { data: AudiobookEntry[]; timestamp: number } | null = null;
  private ebooksCache: { data: any[]; timestamp: number } | null = null;
  private readonly DATA_CACHE_TTL = 1000 * 60 * 5; // 5 minutes

  // Uploaded PDFs held for the page editor (docId → temp path). Swept by TTL so a
  // user who never finishes editing doesn't leak temp files.
  private editPdfCache: Map<string, { path: string; at: number }> = new Map();
  private readonly EDIT_PDF_TTL = 1000 * 60 * 60; // 1 hour

  /**
   * Invalidate caches for a specific project (or all projects).
   * Call this after metadata changes so the library serves fresh data.
   */
  invalidateCache(projectId?: string): void {
    // Always invalidate the books/ebooks list cache
    this.booksCache = null;
    this.ebooksCache = null;

    // Invalidate cover cache for specific project or all
    if (projectId) {
      this.coverCache.delete(projectId);
    } else {
      this.coverCache.clear();
    }
  }

  // Persistent duration cache to avoid re-parsing M4B headers
  private durationCache: Map<string, DurationCacheEntry> = new Map();
  private durationCacheDirty = false;
  /** Guards the background duration-enrichment pass against overlapping runs. */
  private durationEnrichRunning = false;

  // Persistent external audiobook metadata cache
  private externalMetaCache: Map<string, ExternalMetaCacheEntry> = new Map();
  private externalMetaCacheDirty = false;

  // In-memory chapter cache keyed by filepath, validated against size+mtime.
  private chapterCache: Map<string, { size: number; mtimeMs: number; chapters: ChapterEntry[] }> = new Map();

  // Reader profiles + listening analytics — stored as per-device append-only logs
  // in the shared library so Syncthing never sees a two-writer file (no conflicts).
  //   <library>/.bookshelf/readers/<id>.json   write-once profile (creator only)
  //   <library>/.bookshelf/events/<device>.jsonl  append-only, this device only
  // Tokens are per-machine (userData), never synced.
  private storeReady = false;
  private deviceId = '';
  private readerTokens: Map<string, string> = new Map(); // token -> readerId
  // Event ids already written to THIS device's log — the append-if-absent guard
  // that makes /api/analytics/heartbeat idempotent (see ListeningEvent.id).
  private seenEventIds: Set<string> = new Set();

  // Queue control callback (set by main process to bridge to renderer)
  private queueControlHandler: ((action: 'start' | 'pause') => void) | null = null;

  // bookshelf.json (library root) — read once at start. `serverAccessKey` gates
  // the whole API when set; `externalAudiobooksDir` overrides the audiobooks path.
  private bookshelfConfig: { externalAudiobooksDir?: string; serverAccessKey?: string } = {};

  // "Listen to anything" Reader: streams TTS of arbitrary text to the web app over
  // a WebSocket riding this same HTTP server (authed by the reader's bearer token).
  private readerStream = new ReaderStreamBridge();

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const uiPath = path.join(__dirname, 'bookshelf-ui');
    console.log('[BookshelfServer] UI path:', uiPath);

    // Global CORS for the whole API. The web app is same-origin (served by this
    // server), but native wrappers (the Capacitor iOS app loads from
    // capacitor://localhost) call cross-origin. The tailnet is the trust
    // boundary — auth stays the reader token, so a wildcard origin is fine.
    this.app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Reader-Token, X-Access-Key, Authorization, Range, X-File-Name');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    // Opt-in shared access key. When `serverAccessKey` is set in bookshelf.json,
    // EVERY /api request must carry the matching key (header `X-Access-Key`, or an
    // `accessKey` query param for raw <img>/<audio> src that can't set headers).
    // Absent config → wide open, exactly as before (the trusted-tailnet default).
    // See projects/bookshelf/MULTI_SERVER.md → Identity & analytics.
    this.app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      const key = this.bookshelfConfig.serverAccessKey;
      if (!key) { next(); return; } // opt-in: no key configured → unguarded
      const provided = (req.header('X-Access-Key') || req.query.accessKey || '').toString();
      if (provided === key) { next(); return; }
      // `code` lets the client distinguish "wrong key" from a plain failure and
      // prompt for it, rather than treating the server as unreachable.
      res.status(401).json({ error: 'access key required', code: 'ACCESS_KEY' });
    });

    // API Routes
    this.app.get('/api/books', this.getBooks.bind(this));
    this.app.get('/api/cover', this.getCover.bind(this));
    this.app.get('/api/download', this.downloadFile.bind(this));
    this.app.get('/api/audio', this.streamAudio.bind(this));

    this.app.get('/api/tags', this.getTags.bind(this));
    this.app.get('/api/vtt', this.getVtt.bind(this));
    this.app.get('/api/chapters', this.getChapters.bind(this));

    // Readers (profiles) + listening analytics
    this.app.use(express.json());
    this.app.get('/api/readers', this.getReaders.bind(this));
    this.app.post('/api/readers', this.createReader.bind(this));
    this.app.post('/api/readers/login', this.loginReader.bind(this));
    this.app.get('/api/readers/me', this.getMe.bind(this));
    this.app.post('/api/analytics/heartbeat', this.postHeartbeat.bind(this));
    this.app.get('/api/analytics', this.getAnalytics.bind(this));
    this.app.post('/api/analytics/remove', this.postAnalyticsRemove.bind(this));
    // Durable reading/listening position (per reader, merged across devices).
    this.app.get('/api/position', this.getPosition.bind(this));
    this.app.post('/api/position', this.postPosition.bind(this));
    // Durable bookmarks (per reader, merged across devices).
    this.app.get('/api/bookmarks', this.getBookmarks.bind(this));
    this.app.post('/api/bookmarks', this.postBookmark.bind(this));
    // Durable "listened" coverage (per reader), for the scrubber heard-color.
    this.app.get('/api/heard', this.getHeard.bind(this));
    this.app.post('/api/heard', this.postHeard.bind(this));

    // Ebook Library Routes
    this.app.get('/api/ebooks', this.getEbooks.bind(this));
    this.app.get('/api/ebook-cover', this.getEbookCover.bind(this));
    this.app.get('/api/ebook-download', this.downloadEbook.bind(this));
    // Tag a project as an ebook ('book') or an article ('article'); the bookshelf
    // lists Ebooks vs Articles by this tag. Flips the manifest's projectType.
    this.app.post('/api/ebooks/reclassify', this.postReclassifyEbook.bind(this));
    // Delete a project outright (removes its whole folder). Auth by reader token.
    this.app.delete('/api/project', this.deleteProjectRoute.bind(this));

    // In-app reader: reads the pristine archived source of an audiobook project.
    // EPUBs stream whole (epub.js renders them reflowably on the client); PDFs
    // are rasterized page-by-page via mupdf (electron/ebook-render.ts).
    this.app.get('/api/read-info', this.getReadInfo.bind(this));
    this.app.get('/api/read-file', this.getReadFile.bind(this));
    this.app.get('/api/read-page', this.getReadPage.bind(this));

    // "Listen to anything" Reader: turn a URL or an uploaded file into readable
    // blocks. JSON body {url} is parsed by the app-level express.json; a file is
    // sent as raw octet-stream bytes (X-File-Name header) — no multipart lib needed.
    this.app.post(
      '/api/reader/ingest',
      express.raw({ type: 'application/octet-stream', limit: '100mb' }),
      this.postReaderIngest.bind(this),
    );

    // Mobile import→edit finalize: turn edited blocks + chapter markers into a
    // real chaptered epub and create a persisted project (article/book tag). The
    // project's text lives in the library even if its audio is only streamed.
    this.app.post('/api/edit/finalize', this.postEditFinalize.bind(this));

    // "TTS entire book": the persistent whole-book renderer. start kicks/ resumes
    // the render; status is polled by the reader; sentence serves rendered audio;
    // playhead steers render priority (forward-from-playhead + wrap).
    this.app.post('/api/render/start', this.postRenderStart.bind(this));
    this.app.get('/api/render/status', this.getRenderStatus.bind(this));
    this.app.get('/api/render/sentence', this.getRenderSentence.bind(this));
    this.app.post('/api/render/playhead', this.postRenderPlayhead.bind(this));

    // Reader "Stream / follow-along": serve a live-generated block's audio as a WAV
    // so the native AVPlayer can play it (it can't load the client's blob: URLs).
    // The block is driven by the reader WS (/api/reader/ws); this just serves the
    // PCM the bridge teed into reader-audio-store, keyed by the client's requestId.
    this.app.get('/api/reader/audio', this.getReaderAudio.bind(this));

    // TTS engine: voice catalog + fire-and-forget warmup (skip the cold start).
    this.app.get('/api/tts/voices', this.getTtsVoices.bind(this));
    this.app.post('/api/tts/warm', this.postTtsWarm.bind(this));
    // Project reader payload (title + blocks + chapter map) for the Read&Listen view.
    this.app.get('/api/project/reader', this.getProjectReader.bind(this));

    // PDF page-crop editor: ingest a PDF into pages+block-boxes (caching the file),
    // and rasterize those cached pages for the overlay preview.
    this.app.post(
      '/api/edit/ingest-pdf',
      express.raw({ type: 'application/octet-stream', limit: '200mb' }),
      this.postEditIngestPdf.bind(this),
    );
    this.app.get('/api/edit/page', this.getEditPage.bind(this));

    // Queue status & control
    this.app.get('/api/queue', this.getQueue.bind(this));
    this.app.post('/api/queue/start', this.startQueue.bind(this));
    this.app.post('/api/queue/pause', this.pauseQueue.bind(this));

    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      // `name` is the serving machine's hostname so a client (esp. the web build,
      // whose location.hostname is just "localhost") can label the library by the
      // server it's actually on. The user can still rename it in the app.
      res.json({ status: 'ok', name: os.hostname().split('.')[0] });
    });

    // Unknown /api routes get a JSON 404 (not the SPA index.html) so the client
    // can reliably detect unsupported endpoints instead of parsing HTML as JSON.
    this.app.use('/api', (_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Serve static files at root (simpler setup)
    this.app.use(express.static(uiPath, { index: 'index.html' }));

    // Fallback to index.html for SPA routing (Express 5 syntax)
    this.app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(uiPath, 'index.html'));
    });
  }

  async start(config: BookshelfServerConfig): Promise<void> {
    this.port = config.port;
    if (config.userDataPath) {
      this.userDataPath = config.userDataPath;
    }

    // Load persistent caches + library config
    this.loadBookshelfConfig();
    await this.loadDurationCache();
    await this.loadExternalMetaCache();
    this.initReaderStore();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`[BookshelfServer] Started on port ${this.port}`);
        resolve();
      });

      // Wire the Reader TTS stream socket onto this server (WebSocket upgrades on
      // /api/reader/ws, authed by the reader token → readerId).
      this.readerStream.attach(this.server, (t) => this.readerTokens.get(t) ?? null);

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use`));
        } else {
          reject(err);
        }
      });
    });
  }

  private getDurationCachePath(): string | null {
    if (!this.userDataPath) return null;
    return path.join(this.userDataPath, 'duration-cache.json');
  }

  private async loadDurationCache(): Promise<void> {
    const cachePath = this.getDurationCachePath();
    if (!cachePath) return;
    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const entries: Record<string, DurationCacheEntry> = JSON.parse(content);
      this.durationCache = new Map(Object.entries(entries));
      console.log(`[BookshelfServer] Loaded duration cache (${this.durationCache.size} entries)`);
    } catch {
      // No cache file yet — that's fine
    }
  }

  private async saveDurationCache(): Promise<void> {
    if (!this.durationCacheDirty) return;
    const cachePath = this.getDurationCachePath();
    if (!cachePath) return;
    try {
      const obj: Record<string, DurationCacheEntry> = Object.fromEntries(this.durationCache);
      await fs.writeFile(cachePath, JSON.stringify(obj), 'utf-8');
      this.durationCacheDirty = false;
    } catch (err) {
      console.error('[BookshelfServer] Failed to save duration cache:', err);
    }
  }

  private getExternalMetaCachePath(): string | null {
    if (!this.userDataPath) return null;
    return path.join(this.userDataPath, 'external-audiobooks-cache.json');
  }

  private async loadExternalMetaCache(): Promise<void> {
    const cachePath = this.getExternalMetaCachePath();
    if (!cachePath) return;
    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const entries: Record<string, ExternalMetaCacheEntry> = JSON.parse(content);
      this.externalMetaCache = new Map(Object.entries(entries));
      console.log(`[BookshelfServer] Loaded external meta cache (${this.externalMetaCache.size} entries)`);
    } catch {
      // No cache file yet — that's fine
    }
  }

  private async saveExternalMetaCache(): Promise<void> {
    if (!this.externalMetaCacheDirty) return;
    const cachePath = this.getExternalMetaCachePath();
    if (!cachePath) return;
    try {
      const obj: Record<string, ExternalMetaCacheEntry> = Object.fromEntries(this.externalMetaCache);
      await fs.writeFile(cachePath, JSON.stringify(obj), 'utf-8');
      this.externalMetaCacheDirty = false;
    } catch (err) {
      console.error('[BookshelfServer] Failed to save external meta cache:', err);
    }
  }

  /** Read bookshelf.json (library root) once at startup. A restart picks up edits. */
  private loadBookshelfConfig(): void {
    try {
      const configPath = path.join(getLibraryBasePath(), 'bookshelf.json');
      this.bookshelfConfig = fsSync.existsSync(configPath)
        ? (JSON.parse(fsSync.readFileSync(configPath, 'utf-8')) || {})
        : {};
      if (this.bookshelfConfig.serverAccessKey) {
        console.log('[BookshelfServer] Access key configured — API is gated');
      }
    } catch (err) {
      console.error('[BookshelfServer] Failed to read bookshelf.json:', err);
      this.bookshelfConfig = {};
    }
  }

  private getExternalAudiobooksDir(): string {
    // Convention: every library has an `audiobooks/` folder whose .m4b files
    // are surfaced in the Bookshelf by default — no configuration required.
    // An optional `externalAudiobooksDir` in bookshelf.json overrides the path.
    return this.bookshelfConfig.externalAudiobooksDir || path.join(getLibraryBasePath(), 'audiobooks');
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[BookshelfServer] Stopped');
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getStatus(): BookshelfServerStatus {
    return {
      running: this.isRunning(),
      port: this.port,
      addresses: this.getNetworkAddresses(),
    };
  }

  /**
   * Set a handler for queue control actions (start/pause).
   * Called by main.ts to bridge web UI requests to the renderer process.
   */
  setQueueControlHandler(handler: (action: 'start' | 'pause') => void): void {
    this.queueControlHandler = handler;
  }

  private getNetworkAddresses(): string[] {
    const addresses: string[] = [];
    const interfaces = os.networkInterfaces();

    for (const [, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      for (const net of nets) {
        if (net.internal) continue;
        if (net.family === 'IPv4') {
          addresses.push(`http://${net.address}:${this.port}`);
        }
      }
    }

    const hostname = os.hostname();
    addresses.push(`http://${hostname}:${this.port}`);

    return addresses;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Audiobook Discovery (from manifests)
  // ─────────────────────────────────────────────────────────────────────────────

  private async getAudiobookProjects(): Promise<AudiobookEntry[]> {
    const result = await listProjects();
    if (!result.success || !result.projects) return [];

    const entries: AudiobookEntry[] = [];

    // Phase 1: Collect all entries with file stats (fast — no audio parsing)
    for (const manifest of result.projects) {
      const projectDir = getProjectPath(manifest.projectId);

      // Resolve cover image absolute path (canonical — used for bilingual entries)
      let coverAbsPath: string | undefined;
      if (manifest.metadata.coverPath) {
        const candidatePath = path.join(getLibraryBasePath(), manifest.metadata.coverPath);
        if (fsSync.existsSync(candidatePath)) {
          coverAbsPath = candidatePath;
        }
      }

      // Enumerate every audiobook VARIANT of this project (the derived set folds
      // outputs.audiobook + bilingual + any user-added audiobook variants). One
      // card per project carries them all as versions[]; the representative
      // version (primary if it's an audiobook, else the first) drives the card.
      const { variants, primaryVariantId } = getVariants(manifest);
      const resolveCover = (cp?: string): string | undefined => {
        if (!cp) return undefined;
        const c = path.join(getLibraryBasePath(), cp);
        return fsSync.existsSync(c) ? c : undefined;
      };

      const versions: AudiobookVersion[] = [];
      for (const v of variants) {
        if (v.kind !== 'audiobook') continue;
        const absPath = normalizeFsPath(path.join(projectDir, v.path));
        if (!fsSync.existsSync(absPath)) continue;
        const isBilingual = v.id.startsWith('bilingual:');
        try {
          const stats = fsSync.statSync(absPath);
          versions.push({
            variantId: v.id,
            descriptor: v.descriptor,
            type: isBilingual ? 'bilingual' : 'audiobook',
            langPair: isBilingual ? (v.descriptor || v.id.slice('bilingual:'.length)) : undefined,
            downloadPath: absPath,
            coverPath: resolveCover(v.metadata?.coverPath) ?? coverAbsPath,
            size: stats.size,
            dateAdded: v.addedAt || new Date(stats.mtimeMs).toISOString(),
          });
        } catch { /* skip unstatable variant */ }
      }

      if (versions.length === 0) continue; // no playable audiobook for this project

      // Representative: the primary variant if it's a playable audiobook, else the first.
      const rep = versions.find(v => v.variantId === primaryVariantId) ?? versions[0];
      const repIsBilingual = rep.type === 'bilingual';
      // Title/author come from the representative variant's metadata (fall back to
      // the audiobook's effective metadata, then the project).
      const repVariant = variants.find(v => v.id === rep.variantId);
      const audioMeta = effectiveAudiobookMetadata(manifest.metadata);
      entries.push({
        projectId: manifest.projectId,
        title: repVariant?.metadata?.title || audioMeta.title || manifest.metadata.title || manifest.projectId,
        author: repVariant?.metadata?.author || audioMeta.author || manifest.metadata.author || '',
        type: rep.type,
        langPair: rep.langPair,
        size: rep.size,
        downloadPath: rep.downloadPath,
        outputFilename: manifest.metadata.outputFilename,
        coverPath: rep.coverPath ?? (repIsBilingual ? coverAbsPath : undefined),
        dateAdded: rep.dateAdded,
        tags: manifest.metadata.tags || [],
        source: 'project',
        versions,
      });
    }

    // Phase 1.5: Add external audiobooks from configured folder
    const externalBooks = await this.scanExternalAudiobooks();
    entries.push(...externalBooks);

    // Phase 2: Durations from the persistent cache ONLY — no M4B parsing here.
    // Parsing every file's header is the slow part of a cold library scan, and
    // duration isn't needed to list or play a book, so uncached durations are
    // left undefined and filled in by the background pass (enrichDurations).
    for (const entry of entries) {
      entry.duration = this.getCachedDuration(entry.downloadPath);
      if (entry.versions) {
        for (const v of entry.versions) {
          v.duration = v.downloadPath === entry.downloadPath
            ? entry.duration
            : this.getCachedDuration(v.downloadPath);
        }
      }
    }

    return entries;
  }

  /**
   * Duration from the persistent cache only — never parses. Returns undefined on
   * a cache miss (or if the file changed), so the caller can defer parsing to the
   * background. Keyed by filepath + size + mtime, same as {@link getAudioDuration}.
   */
  private getCachedDuration(filePath: string): number | undefined {
    try {
      const stats = fsSync.statSync(filePath);
      const cached = this.durationCache.get(filePath);
      if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
        return cached.duration;
      }
    } catch { /* unstatable — treat as uncached */ }
    return undefined;
  }

  /**
   * Fill in durations that weren't in the cache, off the request path. The passed
   * entries are the same objects held by `booksCache.data`, so mutating them here
   * updates the cache in place — a subsequent (cache-served) /api/books returns
   * the durations. The client polls briefly after its first load to pick them up.
   */
  private async enrichDurations(entries: AudiobookEntry[]): Promise<void> {
    if (this.durationEnrichRunning) return; // a pass is already warming the cache
    this.durationEnrichRunning = true;
    try {
      await Promise.all(entries.map(async (entry) => {
        if (entry.duration === undefined) {
          entry.duration = await this.getAudioDuration(entry.downloadPath);
        }
        if (entry.versions) {
          await Promise.all(entry.versions.map(async (v) => {
            if (v.duration === undefined) {
              v.duration = v.downloadPath === entry.downloadPath
                ? entry.duration
                : await this.getAudioDuration(v.downloadPath);
            }
          }));
        }
      }));
      await this.saveDurationCache();
    } catch (err) {
      console.error('[BookshelfServer] Background duration enrichment failed:', err);
    } finally {
      this.durationEnrichRunning = false;
    }
  }

  /**
   * Get audio file duration in seconds.
   * Uses a persistent cache keyed by filepath + size + mtime to avoid re-parsing.
   */
  private async getAudioDuration(filePath: string): Promise<number | undefined> {
    try {
      const stats = fsSync.statSync(filePath);
      const cached = this.durationCache.get(filePath);

      // Cache hit: file hasn't changed
      if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
        return cached.duration;
      }

      // Cache miss: parse the file
      const mm = await getMusicMetadata();
      const metadata = await mm.parseFile(filePath, { skipCovers: true });
      const duration = metadata.format.duration;

      if (duration !== undefined) {
        this.durationCache.set(filePath, {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          duration,
        });
        this.durationCacheDirty = true;
      }

      return duration;
    } catch {
      return undefined;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // External Audiobook Discovery
  // ─────────────────────────────────────────────────────────────────────────────

  private async scanExternalAudiobooks(): Promise<AudiobookEntry[]> {
    const audiobooksDir = this.getExternalAudiobooksDir();
    if (!audiobooksDir) return [];

    try {
      await fs.access(audiobooksDir);
    } catch {
      return [];
    }

    const m4bFiles = await this.findM4bFiles(audiobooksDir);
    const entries: AudiobookEntry[] = [];

    for (const filePath of m4bFiles) {
      try {
        const stats = fsSync.statSync(filePath);
        let meta = this.externalMetaCache.get(filePath);

        if (!meta || meta.size !== stats.size || meta.mtimeMs !== stats.mtimeMs) {
          const mm = await getMusicMetadata();
          const parsed = await mm.parseFile(filePath, { skipCovers: true });
          meta = {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            title: parsed.common.title || path.basename(filePath, path.extname(filePath)),
            author: parsed.common.artist || parsed.common.albumartist || '',
            year: parsed.common.year,
          };
          this.externalMetaCache.set(filePath, meta);
          this.externalMetaCacheDirty = true;
        }

        entries.push({
          projectId: '',
          title: meta.title,
          author: meta.author,
          type: 'audiobook',
          size: stats.size,
          downloadPath: filePath,
          outputFilename: path.basename(filePath),
          dateAdded: new Date(stats.mtimeMs).toISOString(),
          tags: [],
          source: 'external',
        });
      } catch {
        // Skip unparseable files
      }
    }

    if (this.externalMetaCacheDirty) {
      await this.saveExternalMetaCache();
      this.externalMetaCacheDirty = false;
    }

    return entries;
  }

  private async findM4bFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (dirent.name.startsWith('.')) continue;
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          results.push(...await this.findM4bFiles(full));
        } else if (dirent.name.toLowerCase().endsWith('.m4b')) {
          results.push(full);
        }
      }
    } catch {
      // Skip unreadable directories
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async getBooks(req: Request, res: Response): Promise<void> {
    try {
      const forceRefresh = req.query.refresh === 'true';

      if (!forceRefresh && this.booksCache && Date.now() - this.booksCache.timestamp < this.DATA_CACHE_TTL) {
        res.json({ books: this.booksCache.data, cached: true });
        return;
      }

      // Refresh is cache-busting by nature: drop the persistent duration cache so
      // every length is recomputed from source. This is cheap to the user because
      // durations are recomputed off the request path (enrichDurations) — the list
      // still returns immediately below.
      if (forceRefresh) {
        this.durationCache.clear();
        this.durationCacheDirty = true;
      }

      const entries = await this.getAudiobookProjects();
      this.booksCache = { data: entries, timestamp: Date.now() };
      res.json({ books: entries });

      // Fill in any uncached durations in the background; they mutate the cached
      // entries in place, so the client's follow-up poll picks them up.
      if (entries.some(e => e.duration === undefined || e.versions?.some(v => v.duration === undefined))) {
        void this.enrichDurations(entries);
      }
    } catch (err) {
      console.error('[BookshelfServer] Error getting books:', err);
      res.status(500).json({ error: 'Failed to get books' });
    }
  }

  private async getTags(_req: Request, res: Response): Promise<void> {
    try {
      // Use cached books data if available, otherwise fetch fresh
      let entries: AudiobookEntry[];
      if (this.booksCache && Date.now() - this.booksCache.timestamp < this.DATA_CACHE_TTL) {
        entries = this.booksCache.data;
      } else {
        entries = await this.getAudiobookProjects();
      }
      const tagSet = new Set<string>();
      for (const entry of entries) {
        if (entry.tags) {
          for (const t of entry.tags) tagSet.add(t);
        }
      }
      res.json({ tags: [...tagSet].sort() });
    } catch (err) {
      console.error('[BookshelfServer] Error getting tags:', err);
      res.status(500).json({ error: 'Failed to get tags' });
    }
  }

  /**
   * Serve the WebVTT transcript for a project audiobook so the web player can
   * show synced text. Resolves the VTT path from the project's manifest
   * (outputs.audiobook.vttPath, or a bilingual variant when langPair is given).
   * Imported/external m4b files have no VTT — responds 204 so the player
   * degrades gracefully to audio + chapters only.
   */
  private async getVtt(req: Request, res: Response): Promise<void> {
    try {
      const projectId = req.query.projectId as string | undefined;
      const langPair = req.query.langPair as string | undefined;
      const variantPath = req.query.path as string | undefined; // absolute m4b of the opened variant

      if (!projectId) {
        res.status(204).end();
        return;
      }

      const manifestPath = path.join(getProjectPath(projectId), 'manifest.json');
      if (!fsSync.existsSync(manifestPath)) {
        res.status(204).end();
        return;
      }

      // Mono audiobooks are EMBED-ONLY: the transcript sealed in the opened m4b is
      // the single source of truth — guaranteed to be THIS audio's transcript, with
      // no sidecar fallback. A mono m4b with no embedded track has no synced text.
      if (variantPath && this.isPathWithinLibrary(variantPath) && fsSync.existsSync(variantPath)) {
        const embedded = await extractVttFromM4b(variantPath);
        if (embedded) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.send(embedded);
          return;
        }
      }

      // Bilingual audiobooks still use a sidecar VTT (interleaved source/target cues),
      // resolved from the manifest by language pair — the ONLY remaining sidecar path.
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      let vttRel: string | undefined;
      if (langPair) {
        vttRel = manifest.outputs?.bilingualAudiobooks?.[langPair]?.vttPath;
      }

      if (!vttRel) {
        res.status(204).end();
        return;
      }

      const absPath = path.join(getProjectPath(projectId), vttRel);
      if (!this.isPathWithinLibrary(absPath) || !fsSync.existsSync(absPath)) {
        res.status(204).end();
        return;
      }

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      fsSync.createReadStream(absPath).pipe(res);
    } catch (err) {
      console.error('[BookshelfServer] Error getting VTT:', err);
      res.status(500).json({ error: 'Failed to get VTT' });
    }
  }

  /**
   * Return the chapter markers embedded in an m4b (start/end seconds + title)
   * via bundled ffprobe. Works for both project and imported audiobooks.
   * Cached per file (validated by size + mtime).
   */
  private async getChapters(req: Request, res: Response): Promise<void> {
    try {
      const filePath = req.query.path as string | undefined;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }
      if (!this.isPathWithinLibrary(filePath)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      let stats: fsSync.Stats;
      try {
        stats = fsSync.statSync(filePath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const cached = this.chapterCache.get(filePath);
      if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
        res.json({ chapters: cached.chapters });
        return;
      }

      const chapters = await this.probeChapters(filePath);
      this.chapterCache.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, chapters });
      res.json({ chapters });
    } catch (err) {
      console.error('[BookshelfServer] Error getting chapters:', err);
      res.status(500).json({ error: 'Failed to get chapters' });
    }
  }

  /**
   * Run ffprobe to extract chapter markers. Returns [] when the file has none.
   */
  private async probeChapters(filePath: string): Promise<ChapterEntry[]> {
    try {
      const { stdout } = await execFileAsync(
        getFfprobePath(),
        ['-v', 'quiet', '-print_format', 'json', '-show_chapters', filePath],
        { maxBuffer: 32 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout);
      const raw: any[] = Array.isArray(parsed.chapters) ? parsed.chapters : [];
      return raw
        .map((ch, idx) => ({
          title: (ch.tags?.title || `Chapter ${idx + 1}`).trim(),
          start: parseFloat(ch.start_time),
          end: parseFloat(ch.end_time),
        }))
        .filter((ch) => Number.isFinite(ch.start) && Number.isFinite(ch.end))
        .sort((a, b) => a.start - b.start);
    } catch (err) {
      console.error('[BookshelfServer] ffprobe chapters failed:', err);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Readers + Analytics
  // ─────────────────────────────────────────────────────────────────────────────

  private bookshelfDir(): string { return path.join(getLibraryBasePath(), '.bookshelf'); }
  private readersDir(): string { return path.join(this.bookshelfDir(), 'readers'); }
  private eventsDir(): string { return path.join(this.bookshelfDir(), 'events'); }
  private eventsFile(): string { return path.join(this.eventsDir(), `${this.deviceId}.jsonl`); }
  private positionsDir(): string { return path.join(this.bookshelfDir(), 'positions'); }
  private positionsFile(): string { return path.join(this.positionsDir(), `${this.deviceId}.json`); }
  private heardDir(): string { return path.join(this.bookshelfDir(), 'heard'); }
  private heardFile(): string { return path.join(this.heardDir(), `${this.deviceId}.json`); }
  private bookmarksDir(): string { return path.join(this.bookshelfDir(), 'bookmarks'); }
  private bookmarksFile(): string { return path.join(this.bookmarksDir(), `${this.deviceId}.jsonl`); }
  private tokensPath(): string | null {
    return this.userDataPath ? path.join(this.userDataPath, 'reader-tokens.json') : null;
  }

  /** Prepare the shared per-device store. No native deps — just the filesystem.
   *  Profiles + event logs live in the shared library; tokens stay per-machine. */
  private initReaderStore(): void {
    try {
      fsSync.mkdirSync(this.readersDir(), { recursive: true });
      fsSync.mkdirSync(this.eventsDir(), { recursive: true });
      fsSync.mkdirSync(this.booksRoot(), { recursive: true });
      this.deviceId = this.resolveDeviceId();
      // Per-machine tokens (never synced).
      const tp = this.tokensPath();
      if (tp && fsSync.existsSync(tp)) {
        try { this.readerTokens = new Map(Object.entries(JSON.parse(fsSync.readFileSync(tp, 'utf-8')))); }
        catch { this.readerTokens = new Map(); }
      }
      this.loadSeenEventIds();
      this.storeReady = true;
      console.log('[BookshelfServer] Reader store ready (device', this.deviceId + ')');
    } catch (err) {
      console.error('[BookshelfServer] Failed to init reader store (analytics disabled):', err);
      this.storeReady = false;
    }
  }

  /** Seed the idempotency set from this device's existing log so a replayed event
   *  is recognised across restarts. Only our own file — the double-count case is
   *  strictly local-queue-vs-this-device's-own-log. */
  private loadSeenEventIds(): void {
    this.seenEventIds = new Set();
    try {
      const content = fsSync.readFileSync(this.eventsFile(), 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e: ListeningEvent = JSON.parse(line);
          if (e.id) this.seenEventIds.add(e.id);
        } catch { /* skip malformed */ }
      }
    } catch { /* no log yet */ }
  }

  /** Stable per-machine id, persisted in userData: sanitized hostname + suffix. */
  private resolveDeviceId(): string {
    const idPath = this.userDataPath ? path.join(this.userDataPath, 'bookshelf-device-id') : null;
    if (idPath && fsSync.existsSync(idPath)) {
      const v = fsSync.readFileSync(idPath, 'utf-8').trim();
      if (v) return v;
    }
    const host = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'device';
    const id = `${host}-${crypto.randomBytes(3).toString('hex')}`;
    if (idPath) { try { fsSync.writeFileSync(idPath, id, 'utf-8'); } catch { /* ignore */ } }
    return id;
  }

  private hashPin(pin: string, salt: string): string {
    return crypto.createHash('sha256').update(salt + pin).digest('hex');
  }

  private saveTokens(): void {
    const tp = this.tokensPath();
    if (tp) { try { fsSync.writeFileSync(tp, JSON.stringify(Object.fromEntries(this.readerTokens))); } catch { /* ignore */ } }
  }

  private issueToken(readerId: string): string {
    const token = crypto.randomBytes(24).toString('hex');
    this.readerTokens.set(token, readerId);
    this.saveTokens();
    return token;
  }

  /**
   * POST /api/reader/ingest — turn a URL (JSON {url}) or an uploaded file (raw
   * octet-stream bytes + X-File-Name header) into readable blocks for the Listen
   * surface. Ephemeral: nothing is written to the library. Auth by reader token.
   */
  private async postReaderIngest(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'not signed in' }); return; }

    try {
      // File upload: raw bytes (express.raw gave us a Buffer), name in a header.
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        const origName = (req.headers['x-file-name'] as string) || 'upload';
        const ext = path.extname(origName) || '';
        const tmp = path.join(os.tmpdir(), `bookforge-reader-${crypto.randomBytes(8).toString('hex')}${ext}`);
        await fs.writeFile(tmp, req.body);
        try {
          const result = await ingestFromFile(tmp, origName);
          res.json(result);
        } finally {
          fs.unlink(tmp).catch(() => { /* best-effort temp cleanup */ });
        }
        return;
      }

      // URL: JSON body parsed by the app-level express.json middleware.
      const url = (req.body && typeof req.body === 'object' ? (req.body as { url?: unknown }).url : undefined);
      if (typeof url === 'string' && url.trim()) {
        const result = await ingestFromUrl(url.trim());
        res.json(result);
        return;
      }

      res.status(400).json({ error: 'provide a url or upload a file' });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'ingest failed' });
    }
  }

  /**
   * POST /api/edit/finalize — the mobile import→edit flow's "Done". Takes the
   * edited blocks (with chapter-start markers) plus a title/tag, builds a real
   * chaptered epub, and creates a persisted project via the shared importer. A
   * URL article and a dropped file both land here; the projectType tag ('article'
   * vs 'book') decides which shelf tab it shows on. Auth by reader token.
   *
   * Body: { title, author?, language?, projectType?, url?, blocks: [{text, chapterStart?}] }
   * Returns: { ok, projectId, ref } — ref is `p:<projectId>` for the reader.
   */
  private async postEditFinalize(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'not signed in' }); return; }

    const body = (req.body || {}) as {
      title?: unknown; author?: unknown; language?: unknown; projectType?: unknown; url?: unknown;
      blocks?: Array<{ text?: unknown; chapterStart?: unknown }>;
    };
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Untitled';
    const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim() : undefined;
    const language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'en';
    const projectType = body.projectType === 'book' ? 'book' : 'article'; // mobile flow defaults to article
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
    const blocks = Array.isArray(body.blocks) ? body.blocks : [];
    if (blocks.length === 0) { res.status(400).json({ error: 'no blocks to finalize' }); return; }

    // Normalize once; drives BOTH the epub chapters and the render plan.
    const norm = blocks
      .map((b) => ({ text: typeof b.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '', chapterStart: !!b.chapterStart }))
      .filter((b) => b.text.length > 0);
    if (norm.length === 0) { res.status(400).json({ error: 'no readable text' }); return; }

    // Group blocks into chapters for the epub. A chapter-start block becomes that
    // chapter's heading (<h2>); everything after it (until the next marker) is its
    // body. Content before the first marker is chapter 1, titled with the doc title.
    const chapters: EpubChapter[] = [];
    let current: EpubChapter | null = null;
    for (const b of norm) {
      if (b.chapterStart) {
        current = { title: b.text.slice(0, 120), paragraphs: [] };
        chapters.push(current);
      } else {
        if (!current) { current = { title, paragraphs: [] }; chapters.push(current); }
        current.paragraphs.push(b.text);
      }
    }
    if (chapters.length === 0) { res.status(400).json({ error: 'no readable text' }); return; }

    let tmp: string | null = null;
    try {
      const epub = await buildEpubBuffer({
        title, author, language,
        modifiedAt: new Date().toISOString(),
        chapters,
      });
      // Write to a temp .epub so the shared importer can hash + archive it. The
      // filename seeds the archived copy's descriptive name.
      const safe = title.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'article';
      tmp = path.join(os.tmpdir(), `bookforge-import-${crypto.randomBytes(6).toString('hex')}-${safe}.epub`);
      await fs.writeFile(tmp, epub);

      const result = await importEpubProject(tmp, {
        confirmedMetadata: { title, author: author || 'Unknown', language },
        projectType,
        provenance: url ? { url, fetchedAt: new Date().toISOString() } : undefined,
      });
      if (result.duplicate) {
        res.status(409).json({ error: result.error, duplicate: true, projectId: result.existingProjectId });
        return;
      }
      if (!result.success || !result.projectId) {
        res.status(500).json({ error: result.error || 'import failed' });
        return;
      }
      // Seed the render plan (sentences + chapter map) so "TTS entire book" and the
      // Read&Listen view work without re-parsing the epub.
      try {
        await saveRenderPlan(result.projectId, { title, author, language, blocks: norm });
      } catch (planErr) {
        console.warn('[edit/finalize] failed to seed render plan:', planErr);
      }

      this.invalidateCache(); // a new article/book joined the shelf
      res.json({ ok: true, projectId: result.projectId, ref: `p:${result.projectId}` });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'finalize failed' });
    } finally {
      if (tmp) fs.unlink(tmp).catch(() => { /* best-effort temp cleanup */ });
    }
  }

  /** Drop cached edit-PDFs older than the TTL (best-effort temp cleanup). */
  private sweepEditPdfCache(): void {
    const now = Date.now();
    for (const [id, entry] of this.editPdfCache) {
      if (now - entry.at > this.EDIT_PDF_TTL) {
        fs.unlink(entry.path).catch(() => { /* already gone */ });
        this.editPdfCache.delete(id);
      }
    }
  }

  /** POST /api/edit/ingest-pdf — cache the PDF + return pages with block boxes. */
  private async postEditIngestPdf(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ error: 'send the PDF bytes' }); return; }
    this.sweepEditPdfCache();
    const docId = crypto.randomBytes(10).toString('hex');
    const tmp = path.join(os.tmpdir(), `bookforge-edit-${docId}.pdf`);
    try {
      await fs.writeFile(tmp, req.body);
      const analysis = await analyzePdfPages(tmp);
      this.editPdfCache.set(docId, { path: tmp, at: Date.now() });
      const origName = (req.headers['x-file-name'] as string) || 'document.pdf';
      const title = origName.replace(/\.[^.]+$/i, '');
      res.json({ docId, title, pageCount: analysis.pageCount, pages: analysis.pages });
    } catch (err) {
      fs.unlink(tmp).catch(() => { /* ignore */ });
      res.status(422).json({ error: err instanceof Error ? err.message : 'could not read that PDF' });
    }
  }

  /** GET /api/edit/page?docId&page&scale — a rasterized page of a cached edit-PDF. */
  private async getEditPage(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const docId = req.query.docId as string;
    const page = parseInt(req.query.page as string, 10);
    let scale = parseFloat(req.query.scale as string);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1.5;
    const entry = docId ? this.editPdfCache.get(docId) : undefined;
    if (!entry || !Number.isInteger(page) || page < 0) { res.status(404).json({ error: 'unknown page' }); return; }
    try {
      const png = await renderPdfPage(entry.path, page, scale);
      entry.at = Date.now(); // keep alive while actively editing
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(png);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'render failed' });
    }
  }

  /** Guard a projectId from path traversal. */
  private validProjectId(id: unknown): id is string {
    return typeof id === 'string' && !!id && !id.includes('/') && !id.includes('\\') && !id.includes('..');
  }

  /** POST /api/render/start — kick/resume the whole-book render for a project.
   *  Optional `voice` picks the TTS voice (persists on the render state). */
  private async postRenderStart(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const body = req.body as { projectId?: unknown; startIndex?: unknown; voice?: unknown };
    const projectId = body?.projectId;
    const startIndex = Number(body?.startIndex) || 0;
    const voice = typeof body?.voice === 'string' && body.voice ? body.voice : undefined;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    const r = await bookRenderService.start(projectId, startIndex, voice);
    if (!r.ok) { res.status(422).json({ error: r.error || 'render failed to start' }); return; }
    res.json({ ok: true, total: r.total });
  }

  /** GET /api/tts/voices — the voices the active streaming engine can use, plus
   *  the persisted default and the live-loaded one (mirrors the WS hello). */
  private async getTtsVoices(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    try {
      const engine = getActiveEngine();
      let voices: string[];
      if (getSelectedEngineName() === 'orpheus') {
        voices = engine.getAvailableVoices();
      } else {
        const { getInstalledVoiceIds } = await import('./components/installed-voices.js');
        voices = await getInstalledVoiceIds();
      }
      res.json({
        voices,
        current: engine.getCurrentVoice(),
        defaultVoice: getDefaultStreamVoice(),
        engine: getSelectedEngineName(),
        state: engine.getEngineState(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'voices unavailable' });
    }
  }

  /** POST /api/tts/warm — fire-and-forget engine + voice warmup. Called when a
   *  listen surface OPENS so the ~1 min cold start is paid while the user is
   *  still reading the mode picker, not after they tap play. Responds instantly
   *  with the current engine state; progress is visible via engine state. */
  private postTtsWarm(req: Request, res: Response): void {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const body = req.body as { voice?: unknown };
    const voice = typeof body?.voice === 'string' && body.voice ? body.voice : undefined;
    const engine = getActiveEngine();
    const needsStart = engine.getEngineState() === 'stopped' || engine.getEngineState() === 'starting';
    const needsVoice = voice ? engine.getCurrentVoice() !== voice : !engine.getCurrentVoice();
    if (needsStart || needsVoice) {
      void (async () => {
        const started = await engine.startSession(); // dedupes if already starting
        if (!started.success) { console.warn('[bookshelf] TTS warm: start failed:', started.error); return; }
        const warm = voice || engine.getCurrentVoice() || engine.getLastVoice() || getDefaultStreamVoice();
        const loaded = await engine.loadVoice(warm); // no-op when already loaded
        if (!loaded.success) console.warn('[bookshelf] TTS warm: voice failed:', loaded.error);
      })();
    }
    res.json({ ok: true, state: engine.getEngineState() });
  }

  /** GET /api/render/status?projectId — coverage/progress the reader polls. */
  private getRenderStatus(req: Request, res: Response): void {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    res.json(bookRenderService.status(projectId));
  }

  /** GET /api/render/sentence?projectId&index — a rendered sentence's WAV bytes. */
  private getRenderSentence(req: Request, res: Response): void {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    const index = Number(req.query.index);
    if (!this.validProjectId(projectId) || !Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: 'projectId and index required' }); return;
    }
    const p = bookRenderService.sentencePath(projectId, index);
    if (!p) { res.status(404).json({ error: 'not rendered yet' }); return; }
    res.type('wav');
    res.sendFile(p, (err) => { if (err && !res.headersSent) res.status(500).end(); });
  }

  /**
   * GET /api/reader/audio?requestId — the WAV for a "Stream / follow-along" block.
   * Buffer-then-serve: waits for the block to finish generating (it normally has by
   * the time the client points the player here, since the client only loads this
   * after the WS 'complete'), then serves the whole WAV with Range support so
   * AVPlayer can seek within the block. Auth by reader token (query/header/bearer).
   */
  private async getReaderAudio(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'not signed in' }); return; }
    const requestId = req.query.requestId;
    if (typeof requestId !== 'string' || !requestId) {
      res.status(400).json({ error: 'requestId required' }); return;
    }
    // Authorize by the AUTHENTICATED reader: the store is keyed per-reader, so a
    // block registered by another reader (or an unknown requestId) simply misses.
    const key = readerAudioStore.makeKey(readerId, requestId);
    const ready = await readerAudioStore.waitSettled(key, 30000);
    if (!ready) { res.status(404).json({ error: 'not generated' }); return; }
    const wav = readerAudioStore.wav(key);
    if (!wav) { res.status(404).json({ error: 'not generated' }); return; }

    const total = wav.length;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      let start: number;
      let end: number;
      if (parts[0] === '') {
        // Suffix range `bytes=-N` → the last N bytes (RFC 7233).
        const n = parseInt(parts[1], 10);
        if (!Number.isFinite(n) || n <= 0) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`); res.end(); return;
        }
        start = Math.max(0, total - n);
        end = total - 1;
      } else {
        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`); res.end(); return;
        }
        end = Math.min(end, total - 1); // clamp an over-large end rather than reject
        if (start >= total || start > end) {
          res.status(416).setHeader('Content-Range', `bytes */${total}`); res.end(); return;
        }
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      res.end(wav.subarray(start, end + 1));
    } else {
      res.setHeader('Content-Length', total);
      res.end(wav);
    }
  }

  /** POST /api/render/playhead — steer render priority (forward-from-playhead). */
  private postRenderPlayhead(req: Request, res: Response): void {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = (req.body as { projectId?: unknown })?.projectId;
    const index = Number((req.body as { index?: unknown })?.index) || 0;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    bookRenderService.reportPlayhead(projectId, index);
    res.json({ ok: true });
  }

  /** GET /api/project/reader?projectId — title + display blocks + chapter map for
   *  the Read&Listen view. */
  private async getProjectReader(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    const plan = await bookRenderService.getPlan(projectId);
    if (!plan) { res.status(404).json({ error: 'no readable text for this project' }); return; }
    res.json({
      projectId, title: plan.title, author: plan.author,
      blocks: plan.blocks, chapterTitles: plan.chapterTitles,
      sentenceBlock: plan.sentenceBlock, totalSentences: plan.sentences.length,
    });
  }

  /**
   * POST /api/ebooks/reclassify — tag a project as an ebook or an article. The
   * bookshelf lists Ebooks vs Articles purely by the project's `projectType`, so
   * this just flips that tag on the manifest. Auth by reader token.
   */
  private async postReclassifyEbook(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'not signed in' }); return; }

    const projectId = (req.body as { projectId?: unknown })?.projectId;
    const type = (req.body as { type?: unknown })?.type;
    if (typeof projectId !== 'string' || !projectId || (type !== 'book' && type !== 'article')) {
      res.status(400).json({ error: "projectId and type ('book' | 'article') required" });
      return;
    }

    try {
      const result = await modifyManifest(projectId, (m) => { m.projectType = type; });
      if (!result.success) { res.status(404).json({ error: result.error || 'project not found' }); return; }
      this.invalidateCache(); // the ebook/article split changed
      res.json({ ok: true, projectId, type });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'reclassify failed' });
    }
  }

  /**
   * DELETE /api/project?projectId=… — remove a project's entire folder. Used by
   * the shelf's article long-press/right-click delete affordance. Auth by reader
   * token; projectId is validated so it can't escape the projects dir.
   */
  private async deleteProjectRoute(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    try {
      const result = await deleteProject(projectId);
      if (!result.success) { res.status(404).json({ error: result.error || 'project not found' }); return; }
      this.invalidateCache(); // the shelf list changed
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'delete failed' });
    }
  }

  private readerIdFromRequest(req: Request): string | null {
    const auth = req.headers.authorization;
    const bearer = auth && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const token = (req.headers['x-reader-token'] as string) || bearer || (req.query.token as string);
    if (!token) return null;
    return this.readerTokens.get(token) ?? null;
  }

  private readProfile(id: string): ReaderProfile | null {
    try {
      const p = path.join(this.readersDir(), `${id}.json`);
      if (!fsSync.existsSync(p)) return null;
      return JSON.parse(fsSync.readFileSync(p, 'utf-8')) as ReaderProfile;
    } catch { return null; }
  }

  private allProfiles(): ReaderProfile[] {
    try {
      return fsSync.readdirSync(this.readersDir())
        .filter(f => f.endsWith('.json'))
        .map(f => { try { return JSON.parse(fsSync.readFileSync(path.join(this.readersDir(), f), 'utf-8')) as ReaderProfile; } catch { return null; } })
        .filter((r): r is ReaderProfile => !!r);
    } catch { return []; }
  }

  /** Stable, cross-machine book identifier: library-relative path, forward slashes. */
  private relBookKey(absPath: string): string {
    try {
      const rel = path.relative(getLibraryBasePath(), absPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    } catch { /* fall through */ }
    return path.basename(absPath);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Per-book storage unit
  //
  // Everything durable about a book (resume position, listened coverage,
  // bookmarks — and future per-book data) lives together under
  //   <lib>/.bookshelf/books/<bookId>/<deviceId>.json  =  { [readerId]: BookRecord }
  // One writer per file (this device) → Syncthing never conflicts; the server
  // merges every device's file on read. Legacy per-concern stores are folded in
  // on read so nothing already saved is lost.
  // ─────────────────────────────────────────────────────────────────────────────

  private booksRoot(): string { return path.join(this.bookshelfDir(), 'books'); }
  private bookDir(bookId: string): string { return path.join(this.booksRoot(), bookId); }
  private bookFile(bookId: string): string { return path.join(this.bookDir(bookId), `${this.deviceId}.json`); }
  private bookIdFromKey(key: string): string { return Buffer.from(key, 'utf-8').toString('base64url'); }

  /** Platform-independent book key: reader `ref` verbatim, or `a:<library-relative m4b>`. */
  private positionKeyFrom(ref: string, bookPath: string): string | null {
    if (ref) return ref;
    if (bookPath) return 'a:' + this.relBookKey(bookPath);
    return null;
  }

  /** Read this device's per-book record for a reader (empty if none). */
  private readBookRecord(key: string, readerId: string): BookRecord {
    try {
      const store = JSON.parse(fsSync.readFileSync(this.bookFile(this.bookIdFromKey(key)), 'utf-8'));
      return (store?.[readerId] as BookRecord) || {};
    } catch { return {}; }
  }

  /** Update this device's per-book record for a reader (atomic stage + rename). */
  private writeBookRecord(key: string, readerId: string, mutate: (rec: BookRecord) => void): void {
    const bookId = this.bookIdFromKey(key);
    const file = this.bookFile(bookId);
    let store: Record<string, BookRecord> = {};
    try { store = JSON.parse(fsSync.readFileSync(file, 'utf-8')); } catch { store = {}; }
    if (!store[readerId]) store[readerId] = {};
    mutate(store[readerId]);
    fsSync.mkdirSync(bookId ? this.bookDir(bookId) : this.booksRoot(), { recursive: true });
    const tmp = `${file}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(store), 'utf-8');
    fsSync.renameSync(tmp, file);
  }

  /** Merge every device's per-book record (+ legacy stores) for reader+key. */
  private mergeBook(key: string, readerId: string): { position: BookPosition | null; heard: number[][]; heardResetAt: string; bookmarks: Record<string, unknown>[] } {
    // Track winners via primitive timestamp holders (avoids closure-narrowing).
    let position: BookPosition | null = null;
    let positionAt = '';
    // Heard is UNIONED across every device's snapshot (not newest-wins), so two
    // devices' concurrent coverage accumulates. Reset still wins: collect every
    // snapshot + the max reset tombstone, then union only snapshots written at or
    // after the latest reset (anything older is tombstoned — resurrection-proof).
    const heardSnaps: BookHeard[] = [];
    let heardResetAt = '';
    const bmLatest = new Map<string, BookmarkOp>();
    const fold = (rec: BookRecord | undefined) => {
      if (!rec) return;
      const p = rec.position;
      if (p && p.at && p.at > positionAt) { positionAt = p.at; position = p; }
      const h = rec.heard;
      if (h && h.at) heardSnaps.push(h);
      if (rec.heardResetAt && rec.heardResetAt > heardResetAt) heardResetAt = rec.heardResetAt;
      for (const op of rec.bookmarks || []) {
        const id = op?.bm?.id;
        if (!id) continue;
        const cur = bmLatest.get(id);
        if (!cur || op.at > cur.at) bmLatest.set(id, op);
      }
    };

    const dir = this.bookDir(this.bookIdFromKey(key));
    try {
      for (const f of fsSync.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        let store: Record<string, BookRecord>;
        try { store = JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
        fold(store?.[readerId]);
      }
    } catch { /* no per-book dir yet */ }

    this.foldLegacy(key, readerId, fold, bmLatest);

    // Union of every snapshot at/after the latest reset (>= keeps the resetting
    // device's own cleared snapshot, whose at == the tombstone, in the pool).
    const heard = this.mergeIntervals(
      heardSnaps.filter(h => h.at >= heardResetAt).flatMap(h => h.intervals),
    );
    const bookmarks = [...bmLatest.values()].filter(o => o.op === 'add').map(o => o.bm);
    return { position, heard, heardResetAt, bookmarks };
  }

  /** Merge overlapping/adjacent intervals into a minimal sorted set. Mirrors the
   *  client's addHeard semantics: sort by start, join when the next start falls
   *  within 1s of the running end (tiny gaps from separate runs are stitched). */
  private mergeIntervals(intervals: number[][]): number[][] {
    const list = (intervals || [])
      .filter((iv): iv is [number, number] =>
        Array.isArray(iv) && iv.length === 2 &&
        Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
      .map(iv => [iv[0], iv[1]] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const [s, e] of list) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e); // join within 1s
      else merged.push([s, e]);
    }
    return merged;
  }

  /** Fold pre-consolidation stores (positions/, heard/, bookmarks/) into the merge. */
  private foldLegacy(
    key: string,
    readerId: string,
    fold: (rec: BookRecord) => void,
    bmLatest: Map<string, BookmarkOp>,
  ): void {
    try {
      for (const f of fsSync.readdirSync(this.positionsDir()).filter(x => x.endsWith('.json'))) {
        let store: Record<string, Record<string, BookPosition>>;
        try { store = JSON.parse(fsSync.readFileSync(path.join(this.positionsDir(), f), 'utf-8')); } catch { continue; }
        const e = store?.[readerId]?.[key];
        if (e) fold({ position: e });
      }
    } catch { /* none */ }
    try {
      for (const f of fsSync.readdirSync(this.heardDir()).filter(x => x.endsWith('.json'))) {
        let store: Record<string, Record<string, BookHeard>>;
        try { store = JSON.parse(fsSync.readFileSync(path.join(this.heardDir(), f), 'utf-8')); } catch { continue; }
        const e = store?.[readerId]?.[key];
        if (e) fold({ heard: e });
      }
    } catch { /* none */ }
    try {
      for (const f of fsSync.readdirSync(this.bookmarksDir()).filter(x => x.endsWith('.jsonl'))) {
        let content = '';
        try { content = fsSync.readFileSync(path.join(this.bookmarksDir(), f), 'utf-8'); } catch { continue; }
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          let e: { readerId: string; key: string; op: string; bm: { id?: string }; at: string };
          try { e = JSON.parse(line); } catch { continue; }
          if (e.readerId !== readerId || e.key !== key || !e.bm?.id) continue;
          const cur = bmLatest.get(e.bm.id);
          if (!cur || e.at > cur.at) bmLatest.set(e.bm.id, { op: e.op, bm: e.bm as Record<string, unknown>, at: e.at });
        }
      }
    } catch { /* none */ }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // In-process API for the DESKTOP player (called over IPC, not HTTP).
  //
  // The desktop app IS this server, so it reaches the same on-disk reader store
  // directly — no network, no auth token (IPC is trusted). Everything written
  // here lands in the identical `.bookshelf` files the phone/web read, so desktop
  // listening + bookmarks stay in sync with every other device. Audiobooks are
  // keyed by their library-relative path (the server's `bookPath` convention).
  // ───────────────────────────────────────────────────────────────────────────

  /** Reader profiles for the desktop picker (sorted by name). */
  listReaderProfiles(): Array<{ id: string; name: string; hasPin: boolean }> {
    if (!this.storeReady) return [];
    return this.allProfiles()
      .map(r => ({ id: r.id, name: r.name, hasPin: !!r.pinHash }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Credit listening seconds to a reader (same event log the analytics read). */
  recordListening(readerId: string, bookPath: string, title: string, author: string, seconds: number, id?: string): void {
    if (!this.storeReady || !readerId) return;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    seconds = Math.min(seconds, 3600);
    if (id && this.seenEventIds.has(id)) return;
    const event: ListeningEvent = {
      readerId,
      bookKey: bookPath ? this.relBookKey(bookPath) : '',
      title, author,
      day: this.localDateKey(),
      seconds,
      at: new Date().toISOString(),
      id,
    };
    fsSync.appendFileSync(this.eventsFile(), JSON.stringify(event) + '\n', 'utf-8');
    if (id) this.seenEventIds.add(id);
  }

  /** Save / read a reader's resume position for an audiobook (seconds). */
  saveAudioPosition(readerId: string, bookPath: string, seconds: number): void {
    if (!this.storeReady || !readerId) return;
    const key = this.positionKeyFrom('', bookPath);
    if (!key) return;
    this.writeBookRecord(key, readerId, (rec) => { rec.position = { kind: 'audio', value: seconds, at: new Date().toISOString() }; });
  }
  getAudioPosition(readerId: string, bookPath: string): number | null {
    if (!readerId) return null;
    const key = this.positionKeyFrom('', bookPath);
    if (!key) return null;
    const p = this.mergeBook(key, readerId).position;
    return p && typeof p.value === 'number' ? p.value : null;
  }

  /** A reader's bookmarks for an audiobook (compacted, latest-per-id). */
  listAudioBookmarks(readerId: string, bookPath: string): Array<Record<string, unknown>> {
    if (!readerId) return [];
    const key = this.positionKeyFrom('', bookPath);
    if (!key) return [];
    return this.mergeBook(key, readerId).bookmarks;
  }

  /** Add ('add') or remove ('del') a bookmark for a reader. `bm` must carry an id. */
  saveAudioBookmark(readerId: string, bookPath: string, op: 'add' | 'del', bm: Record<string, unknown> & { id?: string }): void {
    if (!this.storeReady || !readerId) return;
    const key = this.positionKeyFrom('', bookPath);
    if (!key || !bm || !bm.id) return;
    this.writeBookRecord(key, readerId, (rec) => {
      const kept = (rec.bookmarks || []).filter((o) => o.bm?.id !== bm.id);
      rec.bookmarks = [...kept, { op, bm, at: new Date().toISOString() }];
    });
  }

  // ── Position (audio time / epub CFI / pdf page) ──────────────────────────────
  private async postPosition(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId || !this.storeReady) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      const key = this.positionKeyFrom((req.body?.ref || '').toString(), (req.body?.bookPath || '').toString());
      const kind = (req.body?.kind || '').toString();
      const value = req.body?.value;
      if (!key || value === undefined || value === null || value === '') { res.json({ ok: true }); return; }
      this.writeBookRecord(key, readerId, (rec) => { rec.position = { kind, value, at: new Date().toISOString() }; });
      res.json({ ok: true });
    } catch (err) {
      console.error('[BookshelfServer] save position failed:', err);
      res.status(500).json({ error: 'Failed to save position' });
    }
  }

  private async getPosition(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    const key = this.positionKeyFrom((req.query.ref as string) || '', (req.query.bookPath as string) || '');
    if (!key) { res.json({}); return; }
    res.json(this.mergeBook(key, readerId).position || {});
  }

  // ── Listened coverage (per reader; unioned across devices; reset tombstones) ──
  private async postHeard(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId || !this.storeReady) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      const key = this.positionKeyFrom((req.body?.ref || '').toString(), (req.body?.bookPath || '').toString());
      if (!key) { res.json({ ok: true }); return; }
      // A reset drops a tombstone: stamp heardResetAt=now so every snapshot written
      // before it (from ANY device) is dropped on merge, and clear this device's
      // own heard. Post-reset coverage (at >= now, from any device) still unions in.
      if (req.body?.reset === true) {
        const now = new Date().toISOString();
        this.writeBookRecord(key, readerId, (rec) => {
          rec.heardResetAt = now;
          rec.heard = { intervals: [], at: now };
        });
        res.json({ ok: true });
        return;
      }
      const intervals = Array.isArray(req.body?.intervals) ? req.body.intervals : null;
      if (!intervals) { res.json({ ok: true }); return; }
      // Non-reset post: record this device's snapshot; do NOT touch heardResetAt.
      this.writeBookRecord(key, readerId, (rec) => { rec.heard = { intervals, at: new Date().toISOString() }; });
      res.json({ ok: true });
    } catch (err) {
      console.error('[BookshelfServer] save heard failed:', err);
      res.status(500).json({ error: 'Failed to save progress' });
    }
  }

  private async getHeard(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    const key = this.positionKeyFrom((req.query.ref as string) || '', (req.query.bookPath as string) || '');
    if (!key) { res.json({ intervals: [], resetAt: null }); return; }
    // resetAt (the merged reset tombstone) lets the client discard its own local
    // cache when that cache predates a reset done on another device — so an offline
    // device rejoining after a reset can't resurrect the erased coverage.
    const merged = this.mergeBook(key, readerId);
    res.json({ intervals: merged.heard, resetAt: merged.heardResetAt || null });
  }

  // ── Bookmarks (per-device op list, compacted to latest-per-id; LWW on merge) ──
  private async postBookmark(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId || !this.storeReady) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      const key = this.positionKeyFrom((req.body?.ref || '').toString(), (req.body?.bookPath || '').toString());
      const op = (req.body?.op || '').toString();
      const bm = req.body?.bookmark;
      if (!key || (op !== 'add' && op !== 'del') || !bm || !bm.id) { res.json({ ok: true }); return; }
      this.writeBookRecord(key, readerId, (rec) => {
        const kept = (rec.bookmarks || []).filter((o) => o.bm?.id !== bm.id);
        rec.bookmarks = [...kept, { op, bm, at: new Date().toISOString() }];
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('[BookshelfServer] save bookmark failed:', err);
      res.status(500).json({ error: 'Failed to save bookmark' });
    }
  }

  private async getBookmarks(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    const key = this.positionKeyFrom((req.query.ref as string) || '', (req.query.bookPath as string) || '');
    if (!key) { res.json({ bookmarks: [] }); return; }
    res.json({ bookmarks: this.mergeBook(key, readerId).bookmarks });
  }

  private localDateKey(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private async getReaders(_req: Request, res: Response): Promise<void> {
    if (!this.storeReady) { res.json({ readers: [] }); return; }
    const readers = this.allProfiles()
      .map(r => ({ id: r.id, name: r.name, hasPin: !!r.pinHash }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    res.json({ readers });
  }

  private async createReader(req: Request, res: Response): Promise<void> {
    if (!this.storeReady) { res.status(503).json({ error: 'Reader storage unavailable' }); return; }
    try {
      const name = (req.body?.name || '').toString().trim();
      const pin = req.body?.pin ? String(req.body.pin) : '';
      if (!name) { res.status(400).json({ error: 'Name is required' }); return; }
      if (this.allProfiles().some(r => r.name.toLowerCase() === name.toLowerCase())) {
        res.status(409).json({ error: 'A reader with that name already exists' });
        return;
      }
      const profile: ReaderProfile = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
      if (pin) {
        profile.pinSalt = crypto.randomBytes(8).toString('hex');
        profile.pinHash = this.hashPin(pin, profile.pinSalt);
      }
      // Write-once profile file (only this machine ever writes this id).
      fsSync.writeFileSync(path.join(this.readersDir(), `${profile.id}.json`), JSON.stringify(profile, null, 2), 'utf-8');

      const token = this.issueToken(profile.id);
      res.json({ token, reader: { id: profile.id, name: profile.name, hasPin: !!profile.pinHash } });
    } catch (err) {
      console.error('[BookshelfServer] createReader failed:', err);
      res.status(500).json({ error: 'Failed to create reader' });
    }
  }

  private async loginReader(req: Request, res: Response): Promise<void> {
    if (!this.storeReady) { res.status(503).json({ error: 'Reader storage unavailable' }); return; }
    try {
      const id = (req.body?.id || '').toString();
      const pin = req.body?.pin ? String(req.body.pin) : '';
      const profile = this.readProfile(id);
      if (!profile) { res.status(404).json({ error: 'Reader not found' }); return; }
      if (profile.pinHash) {
        if (!pin || this.hashPin(pin, profile.pinSalt!) !== profile.pinHash) {
          res.status(401).json({ error: 'Incorrect PIN' });
          return;
        }
      }
      const token = this.issueToken(profile.id);
      res.json({ token, reader: { id: profile.id, name: profile.name, hasPin: !!profile.pinHash } });
    } catch (err) {
      console.error('[BookshelfServer] loginReader failed:', err);
      res.status(500).json({ error: 'Failed to log in' });
    }
  }

  private async getMe(req: Request, res: Response): Promise<void> {
    const id = this.readerIdFromRequest(req);
    const profile = id ? this.readProfile(id) : null;
    if (!profile) { res.status(401).json({ error: 'Not signed in' }); return; }
    res.json({ reader: { id: profile.id, name: profile.name, hasPin: !!profile.pinHash } });
  }

  private async postHeartbeat(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId || !this.storeReady) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      const bookPath = (req.body?.bookPath || '').toString();
      const title = (req.body?.title || '').toString();
      const author = (req.body?.author || '').toString();
      let seconds = Number(req.body?.seconds);
      // Guard against bad/huge deltas. Clients credit audio-progress per ~20s
      // flush, but a backgrounded (timer-frozen) tab can legitimately catch up a
      // longer contiguous stretch — cap at 1h, generous but bounded.
      if (!Number.isFinite(seconds) || seconds <= 0) { res.json({ ok: true }); return; }
      seconds = Math.min(seconds, 3600);

      // Idempotency: a replayed event (offline queue re-flush) carries the same id
      // and is a no-op. Legacy clients send no id and are appended as before.
      const id = (req.body?.id || '').toString() || undefined;
      if (id && this.seenEventIds.has(id)) { res.json({ ok: true, duplicate: true }); return; }

      const event: ListeningEvent = {
        readerId,
        bookKey: bookPath ? this.relBookKey(bookPath) : '',
        title,
        author,
        day: this.localDateKey(),
        seconds,
        at: new Date().toISOString(),
        id,
      };
      // Append to THIS device's log only — Syncthing never sees a two-writer file.
      fsSync.appendFileSync(this.eventsFile(), JSON.stringify(event) + '\n', 'utf-8');
      if (id) this.seenEventIds.add(id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[BookshelfServer] heartbeat failed:', err);
      res.status(500).json({ error: 'Failed to record listening' });
    }
  }

  /**
   * Erase a book's listening history from analytics (the per-book ✕). Rather than
   * rewriting append-only, Syncthing-shared logs, we drop a 'remove' tombstone
   * that getAnalytics honors: all of that book's events at/before this timestamp
   * are ignored. Any later listening starts a fresh count.
   */
  private async postAnalyticsRemove(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId || !this.storeReady) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      const bookKey = (req.body?.bookKey || '').toString();
      if (!bookKey) { res.status(400).json({ error: 'Missing bookKey' }); return; }
      const tombstone: ListeningEvent = {
        readerId,
        bookKey,
        title: '',
        author: '',
        day: this.localDateKey(),
        seconds: 0,
        at: new Date().toISOString(),
        type: 'remove',
      };
      fsSync.appendFileSync(this.eventsFile(), JSON.stringify(tombstone) + '\n', 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      console.error('[BookshelfServer] analytics remove failed:', err);
      res.status(500).json({ error: 'Failed to remove book from analytics' });
    }
  }

  /** Merge every device's event log for this reader into daily + per-book totals. */
  private async getAnalytics(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    const profile = readerId ? this.readProfile(readerId) : null;
    if (!profile) { res.status(401).json({ error: 'Not signed in' }); return; }
    try {
      const daily: Record<string, number> = {};
      const books: Record<string, { title: string; author: string; seconds: number; lastAt: string }> = {};
      let totalSeconds = 0;

      let files: string[] = [];
      try {
        files = fsSync.readdirSync(this.eventsDir()).filter(f =>
          // Canonical per-device logs only. Syncthing conflict copies
          // ("<device>.sync-conflict-<...>.jsonl") are near-duplicates of a real
          // log — counting them multiplied every total (a 2h book read as 22h).
          f.endsWith('.jsonl') && !f.includes('.sync-conflict') && !f.startsWith('.'),
        );
      } catch { /* none */ }

      // Read every device's log once into memory (they're small append-only logs).
      const events: ListeningEvent[] = [];
      for (const f of files) {
        let content = '';
        try { content = fsSync.readFileSync(path.join(this.eventsDir(), f), 'utf-8'); } catch { continue; }
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const e: ListeningEvent = JSON.parse(line);
            if (e.readerId === readerId) events.push(e);
          } catch { /* skip malformed line */ }
        }
      }

      // Pass 1: latest 'remove' tombstone per book. Any listen at/before it is erased.
      const removedUntil: Record<string, string> = {};
      for (const e of events) {
        if (e.type === 'remove' && e.bookKey) {
          if (!removedUntil[e.bookKey] || e.at > removedUntil[e.bookKey]) removedUntil[e.bookKey] = e.at;
        }
      }

      // Pass 2: sum surviving listen events.
      for (const e of events) {
        if (e.type === 'remove' || !Number.isFinite(e.seconds) || e.seconds <= 0) continue;
        const cutoff = e.bookKey ? removedUntil[e.bookKey] : undefined;
        if (cutoff && e.at <= cutoff) continue; // erased by a later removal
        daily[e.day] = (daily[e.day] || 0) + e.seconds;
        totalSeconds += e.seconds;
        if (e.bookKey) {
          const b = books[e.bookKey] ?? (books[e.bookKey] = { title: e.title, author: e.author, seconds: 0, lastAt: e.at });
          b.seconds += e.seconds;
          if (e.at > b.lastAt) { b.lastAt = e.at; if (e.title) b.title = e.title; if (e.author) b.author = e.author; }
        }
      }

      const days = Object.keys(daily).sort();
      res.json({
        reader: { id: profile.id, name: profile.name },
        totalSeconds,
        firstAt: days.length ? days[0] : null,
        lastAt: days.length ? days[days.length - 1] : null,
        daily,
        books: Object.entries(books)
          .map(([bookPath, b]) => ({ bookPath, ...b }))
          .sort((x, y) => y.seconds - x.seconds),
      });
    } catch (err) {
      console.error('[BookshelfServer] getAnalytics failed:', err);
      res.status(500).json({ error: 'Failed to load analytics' });
    }
  }

  private async getCover(req: Request, res: Response): Promise<void> {
    try {
      const projectId = req.query.projectId as string;
      const downloadPath = req.query.downloadPath as string;

      if (!projectId && !downloadPath) {
        res.status(400).json({ error: 'Missing projectId or downloadPath parameter' });
        return;
      }

      // Check cache (key by projectId or downloadPath)
      const cacheKey = projectId || downloadPath;
      const cached = this.coverCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.COVER_CACHE_TTL) {
        res.json({ cover: cached.data });
        return;
      }

      let cover: string | null = null;

      // Prefer the accessible manifest cover (a plain image file) over cracking
      // the m4b. The request may omit projectId (external m4bs and some shelf
      // entries send only a downloadPath), so also derive the project from a
      // downloadPath that lives under the library's projects/ tree.
      const derivedProjectId = downloadPath ? this.projectIdFromPath(downloadPath) : null;
      const resolvedProjectId = projectId || derivedProjectId;

      if (projectId) {
        cover = await this.loadManifestCover(projectId);
      }
      // If the given projectId was missing or didn't resolve, try the derived one.
      if (!cover && derivedProjectId && derivedProjectId !== projectId) {
        cover = await this.loadManifestCover(derivedProjectId);
      }

      // Last resort: extract the cover embedded in the M4B file.
      if (!cover && downloadPath) {
        if (!this.isPathWithinLibrary(downloadPath)) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
        cover = await this.extractAudioCover(downloadPath);
        // Self-heal: materialize the extracted cover as a plain file and record
        // it in the manifest, so future loads read it from disk (and it syncs to
        // other devices) via loadManifestCover instead of re-cracking the m4b.
        // Best-effort and fire-and-forget — it never blocks serving the cover.
        if (cover && resolvedProjectId) {
          void this.persistExtractedCover(resolvedProjectId, cover);
        }
      }

      if (cover) {
        // Evict oldest entry if cache is at capacity
        if (this.coverCache.size >= this.MAX_COVER_CACHE_SIZE) {
          const oldestKey = this.coverCache.keys().next().value;
          if (oldestKey !== undefined) this.coverCache.delete(oldestKey);
        }
        this.coverCache.set(cacheKey, { data: cover, timestamp: Date.now() });
        res.json({ cover });
      } else {
        res.json({ cover: null });
      }
    } catch (err) {
      console.error('[BookshelfServer] Error getting cover:', err);
      res.status(500).json({ error: 'Failed to get cover' });
    }
  }

  private async downloadFile(req: Request, res: Response): Promise<void> {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      // Security: verify path is within library
      if (!this.isPathWithinLibrary(filePath)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Check file exists
      try {
        await fs.access(filePath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      // Use the display filename from query params if provided, otherwise fall back to on-disk name
      const displayName = req.query.filename as string | undefined;
      const filename = displayName || path.basename(filePath);

      // Always use octet-stream for downloads — Content-Disposition: attachment handles
      // the filename. Using audio/mp4 causes iOS Safari to append a duplicate .m4b extension.
      const contentType = 'application/octet-stream';

      const stats = await fs.stat(filePath);

      // Create ASCII-safe filename fallback and RFC 5987 encoded filename
      const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_');
      const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition',
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);

      const fileStream = fsSync.createReadStream(filePath);
      fileStream.pipe(res);
    } catch (err) {
      console.error('[BookshelfServer] Error downloading file:', err);
      res.status(500).json({ error: 'Failed to download file' });
    }
  }

  /**
   * Stream audio files with Range header support for seeking
   */
  private async streamAudio(req: Request, res: Response): Promise<void> {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      // Security: only allow audio file extensions
      const ext = path.extname(filePath).toLowerCase();
      if (!['.m4b', '.m4a', '.mp3', '.wav', '.flac', '.ogg'].includes(ext)) {
        res.status(400).json({ error: 'Invalid audio file type' });
        return;
      }

      // Security: verify path is within library or known system paths
      const isValidPath = this.isPathWithinLibrary(filePath) ||
                          filePath.startsWith('/Volumes/') ||
                          filePath.startsWith('/Users/') ||
                          /^[A-Z]:[\\\/]/i.test(filePath);
      if (!isValidPath) {
        res.status(403).json({ error: 'Invalid path' });
        return;
      }

      let stats: fsSync.Stats;
      try {
        stats = fsSync.statSync(filePath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const fileSize = stats.size;

      const contentTypes: Record<string, string> = {
        '.m4b': 'audio/mp4',
        '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.flac': 'audio/flac',
        '.ogg': 'audio/ogg'
      };
      const contentType = contentTypes[ext] || 'audio/mp4';

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', contentType);

        const stream = fsSync.createReadStream(filePath, { start, end });
        stream.pipe(res);
      } else {
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');

        const stream = fsSync.createReadStream(filePath);
        stream.pipe(res);
      }
    } catch (err) {
      console.error('[BookshelfServer] Error streaming audio:', err);
      res.status(500).json({ error: 'Failed to stream audio' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Ebook Library Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async getEbooks(req: Request, res: Response): Promise<void> {
    try {
      const forceRefresh = req.query.refresh === 'true';

      if (!forceRefresh && this.ebooksCache && Date.now() - this.ebooksCache.timestamp < this.DATA_CACHE_TTL) {
        res.json({ ebooks: this.ebooksCache.data, cached: true });
        return;
      }

      const books = await scanLibrary();
      await this.attachEbookVersions(books as unknown as Array<{ relativePath: string; versions?: EbookVersion[] }>);
      this.ebooksCache = { data: books, timestamp: Date.now() };
      res.json({ ebooks: books });
    } catch (err) {
      console.error('[BookshelfServer] Error getting ebooks:', err);
      res.status(500).json({ error: 'Failed to get ebooks' });
    }
  }

  /**
   * For projects that hold more than one ebook variant, attach a versions[] list
   * to the project's representative library entry (the __archive__/<projectId>/…
   * row scanLibrary already emitted) so the ebooks tab can pop a version picker.
   * Non-destructive: single-variant projects and standalone files are untouched.
   */
  private async attachEbookVersions(books: Array<{ relativePath: string; versions?: EbookVersion[] }>): Promise<void> {
    try {
      const result = await listProjects({ type: 'book' });
      if (!result.success || !result.projects) return;

      const byProject = new Map<string, EbookVersion[]>();
      for (const manifest of result.projects) {
        const ebookVariants = getVariants(manifest).variants.filter((v) => v.kind === 'ebook');
        if (ebookVariants.length < 2) continue;
        const projectDir = getProjectPath(manifest.projectId);
        const versions: EbookVersion[] = [];
        for (const v of ebookVariants) {
          const abs = normalizeFsPath(path.join(projectDir, v.path));
          if (!fsSync.existsSync(abs)) continue;
          let fileSize = 0;
          try { fileSize = fsSync.statSync(abs).size; } catch { /* leave 0 */ }
          versions.push({
            relativePath: `__archive__/${manifest.projectId}/${path.basename(v.path)}`,
            descriptor: v.descriptor,
            format: v.format,
            title: v.metadata?.title || manifest.metadata.title || manifest.projectId,
            authorFull: v.metadata?.author || manifest.metadata.author,
            year: v.metadata?.year ? parseInt(v.metadata.year, 10) : undefined,
            fileSize,
          });
        }
        if (versions.length >= 2) byProject.set(manifest.projectId, versions);
      }
      if (byProject.size === 0) return;

      for (const b of books) {
        if (!b.relativePath.startsWith('__archive__/')) continue;
        const projectId = b.relativePath.split('/')[1];
        const versions = byProject.get(projectId);
        if (versions) b.versions = versions;
      }
    } catch (err) {
      console.warn('[BookshelfServer] attachEbookVersions failed:', err);
    }
  }

  private async getEbookCover(req: Request, res: Response): Promise<void> {
    try {
      const relativePath = req.query.path as string;
      if (!relativePath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      const coverData = await getCoverData(relativePath);
      res.json({ cover: coverData });
    } catch (err) {
      console.error('[BookshelfServer] Error getting ebook cover:', err);
      res.status(500).json({ error: 'Failed to get ebook cover' });
    }
  }

  private async downloadEbook(req: Request, res: Response): Promise<void> {
    try {
      const relativePath = req.query.path as string;
      if (!relativePath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      // getAbsolutePath resolves both real ebooks-root files and the synthetic
      // __archive__/<projectId>/<file> entries (→ project archive/ folder).
      const absolutePath = path.resolve(getAbsolutePath(relativePath));

      // Security: must stay within the ebooks root or the projects root.
      if (!absolutePath.startsWith(path.resolve(getEbooksRoot())) &&
          !absolutePath.startsWith(path.resolve(getProjectsPath()))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      try {
        await fs.access(absolutePath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const filename = path.basename(absolutePath);
      const ext = path.extname(filename).toLowerCase();

      const contentTypes: Record<string, string> = {
        '.epub': 'application/epub+zip',
        '.pdf': 'application/pdf',
        '.azw3': 'application/x-mobi8-ebook',
        '.mobi': 'application/x-mobipocket-ebook',
      };

      const contentType = contentTypes[ext] || 'application/octet-stream';
      const stats = await fs.stat(absolutePath);

      const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_');
      const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition',
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);

      const fileStream = fsSync.createReadStream(absolutePath);
      fileStream.pipe(res);
    } catch (err) {
      console.error('[BookshelfServer] Error downloading ebook:', err);
      res.status(500).json({ error: 'Failed to download ebook' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // In-app reader
  //
  // A `ref` names what to read:
  //   p:<projectId>     → the project's pristine archived book (archive/ folder)
  //   e:<relativePath>  → a standalone file in the ebook library (Ebooks tab)
  // ─────────────────────────────────────────────────────────────────────────────

  private static readonly READABLE_EXTS = new Set(['.epub', '.pdf']);

  private resolveReadable(ref: string): { absolutePath: string; ext: string; filename: string } | null {
    if (!ref) return null;
    const sep = ref.indexOf(':');
    if (sep < 0) return null;
    const kind = ref.slice(0, sep);
    const rest = ref.slice(sep + 1);
    if (kind === 'p') return this.resolveArchiveFile(rest);
    if (kind === 'e') return this.resolveEbookFile(rest);
    return null;
  }

  /**
   * Resolve an Ebooks-tab entry. `getAbsolutePath` handles BOTH real files under
   * the ebooks root AND the synthetic `__archive__/<projectId>/<file>` entries
   * that map to a project's archive/ folder. Guards traversal by requiring the
   * resolved path to stay within the ebooks root or the projects root.
   */
  private resolveEbookFile(relativePath: string): { absolutePath: string; ext: string; filename: string } | null {
    if (!relativePath || relativePath.includes('..')) return null;
    const absolutePath = path.resolve(getAbsolutePath(relativePath));
    const inEbooks = absolutePath.startsWith(path.resolve(getEbooksRoot()));
    const inProjects = absolutePath.startsWith(path.resolve(getProjectsPath()));
    if (!inEbooks && !inProjects) return null;
    const ext = path.extname(absolutePath).toLowerCase();
    if (!BookshelfServer.READABLE_EXTS.has(ext)) return null;
    try { fsSync.accessSync(absolutePath); } catch { return null; }
    return { absolutePath, ext, filename: path.basename(absolutePath) };
  }

  /**
   * Resolve the pristine archived book for a project. The archive/ folder holds
   * one file: the original, unmodified book as it was imported (NOT the working
   * source/cleaned/exported variants). Returns null when there's no archive or
   * its format isn't one the reader supports.
   */
  private resolveArchiveFile(projectId: string): { absolutePath: string; ext: string; filename: string } | null {
    // Reject anything that could escape the projects root.
    if (!projectId || projectId.includes('/') || projectId.includes('\\') || projectId.includes('..')) return null;

    const projectDir = path.resolve(getProjectPath(projectId));
    if (!projectDir.startsWith(path.resolve(getProjectsPath()))) return null;

    const archiveDir = path.join(projectDir, 'archive');
    let entries: string[];
    try {
      entries = fsSync.readdirSync(archiveDir);
    } catch {
      return null; // no archive folder
    }

    // Prefer EPUB (reflowable) over PDF when both somehow exist; otherwise take
    // the first readable file.
    const readable = entries
      .filter((name) => BookshelfServer.READABLE_EXTS.has(path.extname(name).toLowerCase()))
      .sort((a, b) => {
        const ae = path.extname(a).toLowerCase() === '.epub' ? 0 : 1;
        const be = path.extname(b).toLowerCase() === '.epub' ? 0 : 1;
        return ae - be;
      });
    if (readable.length === 0) return null;

    const filename = readable[0];
    const absolutePath = path.join(archiveDir, filename);
    return { absolutePath, ext: path.extname(filename).toLowerCase(), filename };
  }

  private async getReadInfo(req: Request, res: Response): Promise<void> {
    try {
      const file = this.resolveReadable((req.query.ref as string) || '');
      if (!file) {
        res.status(404).json({ error: 'No readable book for this reference' });
        return;
      }

      if (file.ext === '.pdf') {
        const info = await getPdfInfo(file.absolutePath);
        res.json({ format: 'pdf', filename: file.filename, pages: info.pages, aspect: info.aspect, outline: info.outline });
        return;
      }
      // EPUB (rendered client-side by epub.js).
      res.json({ format: 'epub', filename: file.filename });
    } catch (err) {
      console.error('[BookshelfServer] Error getting read info:', err);
      res.status(500).json({ error: 'Failed to read book info' });
    }
  }

  /** Serve the book's bytes INLINE (epub.js fetches this as an ArrayBuffer). */
  private async getReadFile(req: Request, res: Response): Promise<void> {
    try {
      const file = this.resolveReadable((req.query.ref as string) || '');
      if (!file) {
        res.status(404).json({ error: 'No readable book for this reference' });
        return;
      }

      const contentType = file.ext === '.pdf' ? 'application/pdf' : 'application/epub+zip';
      const stats = await fs.stat(file.absolutePath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      fsSync.createReadStream(file.absolutePath).pipe(res);
    } catch (err) {
      console.error('[BookshelfServer] Error serving read file:', err);
      res.status(500).json({ error: 'Failed to serve book' });
    }
  }

  /** Render one PDF page to PNG (mupdf, server-side). */
  private async getReadPage(req: Request, res: Response): Promise<void> {
    try {
      const page = Number(req.query.page);
      const scale = Number(req.query.scale);
      if (!Number.isInteger(page) || page < 0) {
        res.status(400).json({ error: 'Invalid page' });
        return;
      }
      const file = this.resolveReadable((req.query.ref as string) || '');
      if (!file || file.ext !== '.pdf') {
        res.status(404).json({ error: 'No PDF book for this reference' });
        return;
      }

      const png = await renderPdfPage(file.absolutePath, page, Number.isFinite(scale) && scale > 0 ? scale : 2);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', png.length);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.end(png);
    } catch (err) {
      console.error('[BookshelfServer] Error rendering read page:', err);
      res.status(500).json({ error: 'Failed to render page' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Queue Status
  // ─────────────────────────────────────────────────────────────────────────────

  private async getQueue(_req: Request, res: Response): Promise<void> {
    try {
      if (!this.userDataPath) {
        res.json({ jobs: [] });
        return;
      }

      const queueFile = path.join(this.userDataPath, 'queue.json');
      if (!fsSync.existsSync(queueFile)) {
        res.json({ jobs: [] });
        return;
      }

      const content = await fs.readFile(queueFile, 'utf-8');
      const state = JSON.parse(content);
      const jobs: any[] = state.jobs || [];

      // Sanitize: strip absolute paths, keep useful display fields
      const sanitized = jobs.map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress ?? 0,
        progressMessage: job.progressMessage || null,
        title: job.metadata?.title || job.metadata?.bookTitle || null,
        author: job.metadata?.author || null,
        epubFilename: job.epubFilename || null,
        addedAt: job.addedAt,
        startedAt: job.startedAt || null,
        completedAt: job.completedAt || null,
        error: job.error || null,
        ttsPhase: job.ttsPhase || null,
        ttsConversionProgress: job.ttsConversionProgress ?? null,
        assemblyProgress: job.assemblyProgress ?? null,
        assemblySubPhase: job.assemblySubPhase || null,
        estimatedSecondsRemaining: job.estimatedSecondsRemaining ?? null,
        parallelWorkers: job.parallelWorkers
          ? job.parallelWorkers.map((w: any) => ({
              id: w.id,
              completedSentences: w.completedSentences,
              status: w.status,
              totalAssigned: w.totalAssigned,
            }))
          : null,
        parentJobId: job.parentJobId || null,
        workflowId: job.workflowId || null,
        currentChunk: job.currentChunk ?? null,
        totalChunks: job.totalChunks ?? null,
        currentChapter: job.currentChapter ?? null,
        totalChapters: job.totalChapters ?? null,
      }));

      res.json({ jobs: sanitized, isRunning: state.isRunning ?? false, currentJobId: state.currentJobId ?? null });
    } catch (err) {
      console.error('[BookshelfServer] Error reading queue:', err);
      res.status(500).json({ error: 'Failed to read queue' });
    }
  }

  private async startQueue(_req: Request, res: Response): Promise<void> {
    if (this.queueControlHandler) {
      this.queueControlHandler('start');
      res.json({ success: true });
    } else {
      res.status(503).json({ error: 'Queue control not available' });
    }
  }

  private async pauseQueue(_req: Request, res: Response): Promise<void> {
    if (this.queueControlHandler) {
      this.queueControlHandler('pause');
      res.json({ success: true });
    } else {
      res.status(503).json({ error: 'Queue control not available' });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Verify a path is within the library directory (projects or library base)
   */
  private isPathWithinLibrary(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const projectsDir = path.resolve(getProjectsPath());
    const libraryDir = path.resolve(getLibraryBasePath());
    if (resolved.startsWith(projectsDir) || resolved.startsWith(libraryDir)) return true;

    // Also allow paths within the configured external audiobooks dir
    const externalDir = this.getExternalAudiobooksDir();
    if (externalDir && resolved.startsWith(path.resolve(externalDir))) return true;

    return false;
  }

  /**
   * Load cover from the manifest's coverPath (library-relative image file)
   */
  private async loadManifestCover(projectId: string): Promise<string | null> {
    try {
      const manifestPath = path.join(getProjectPath(projectId), 'manifest.json');
      if (!fsSync.existsSync(manifestPath)) return null;

      const content = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      const coverPath = manifest.metadata?.coverPath;
      if (!coverPath) return null;

      const absPath = path.join(getLibraryBasePath(), coverPath);
      if (!fsSync.existsSync(absPath)) return null;

      const buffer = await fs.readFile(absPath);
      let mimeType = 'image/jpeg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50) {
        mimeType = 'image/png';
      }
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (err) {
      console.error('[BookshelfServer] Error loading manifest cover:', err);
      return null;
    }
  }

  /**
   * Extract cover image embedded in M4B/M4A audio files
   */
  private async extractAudioCover(filePath: string): Promise<string | null> {
    try {
      const mm = await getMusicMetadata();
      const metadata = await mm.parseFile(filePath);
      const picture = metadata.common.picture?.[0];

      if (picture) {
        const base64 = Buffer.from(picture.data).toString('base64');
        return `data:${picture.format};base64,${base64}`;
      }
      return null; // parsed cleanly — this file simply has no embedded cover
    } catch (err) {
      // music-metadata's pure-JS MP4 reader throws (RangeError in
      // parseSoundSampleDescription) on some m4b atom layouts, aborting before
      // it ever reaches the cover atom. ffmpeg reads the attached cover stream
      // directly and isn't tripped by the malformed track box, so fall back to
      // it rather than losing the cover.
      console.warn(
        '[BookshelfServer] music-metadata cover parse failed; falling back to ffmpeg:',
        (err as Error)?.message ?? err,
      );
      return this.extractAudioCoverViaFfmpeg(filePath);
    }
  }

  /**
   * Pull the embedded cover art out of an M4B/M4A with ffmpeg. Robust against the
   * malformed track atoms that break the pure-JS parser above. Returns a data URL
   * or null when the file has no cover stream.
   */
  private async extractAudioCoverViaFfmpeg(filePath: string): Promise<string | null> {
    const tmpOut = path.join(
      os.tmpdir(),
      `bookforge-cover-${crypto.randomBytes(6).toString('hex')}.jpg`,
    );
    try {
      // -map 0:v:0 grabs the attached-picture stream; re-encoding to JPEG keeps
      // the output format predictable regardless of the source picture codec.
      await execFileAsync(getFfmpegPath(), [
        '-v', 'error',
        '-i', filePath,
        '-map', '0:v:0',
        '-frames:v', '1',
        '-q:v', '2',
        '-y', tmpOut,
      ]);
      const buffer = await fs.readFile(tmpOut);
      if (buffer.length === 0) return null;
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (err) {
      // No video/cover stream (or ffmpeg failed) — the book just has no cover.
      console.warn('[BookshelfServer] ffmpeg cover extraction failed:', (err as Error)?.message ?? err);
      return null;
    } finally {
      fs.unlink(tmpOut).catch(() => {});
    }
  }

  /**
   * The project slug for a file that lives under the library's `projects/` tree
   * (e.g. an m4b at `projects/<slug>/output/…`), or null if it's outside it.
   * Lets a cover request that only carries a downloadPath still resolve the
   * project's accessible manifest cover instead of cracking the m4b.
   */
  private projectIdFromPath(filePath: string): string | null {
    try {
      const rel = path.relative(getProjectsPath(), filePath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      const slug = rel.split(path.sep)[0];
      return slug || null;
    } catch {
      return null;
    }
  }

  /**
   * Self-heal: save an extracted cover to the library `media/` folder and record
   * its path in the manifest, so subsequent loads read the plain file via
   * loadManifestCover instead of re-parsing the m4b (and it syncs to other
   * devices). Content-hash filename mirrors saveImageToMedia's dedup scheme.
   * Best-effort — logs and returns on any failure; never throws.
   */
  private async persistExtractedCover(projectId: string, dataUrl: string): Promise<void> {
    try {
      const match = /^data:image\/(\w+);base64,(.+)$/is.exec(dataUrl);
      if (!match) return;
      const ext = match[1].toLowerCase() === 'png' ? 'png' : 'jpg';
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length === 0) return;

      const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const relPath = `media/cover_${hash}.${ext}`;
      const absPath = path.join(getLibraryBasePath(), relPath);

      // Write once (dedup by content hash), atomically (temp adjacent + rename,
      // same volume) so Syncthing never sees a partial file.
      if (!fsSync.existsSync(absPath)) {
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        const tmpPath = `${absPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
          await fs.writeFile(tmpPath, bytes);
          await fs.rename(tmpPath, absPath);
        } catch (writeErr) {
          await fs.unlink(tmpPath).catch(() => {});
          throw writeErr;
        }
      }

      // Point the manifest at the file so loadManifestCover serves it next time.
      const result = await modifyManifest(projectId, (manifest) => {
        manifest.metadata.coverPath = relPath;
      });
      if (!result.success) {
        console.warn('[BookshelfServer] Could not record coverPath in manifest:', result.error);
      }
    } catch (err) {
      console.warn('[BookshelfServer] Failed to persist extracted cover:', (err as Error)?.message ?? err);
    }
  }
}

// Export singleton instance
export const bookshelfServer = new BookshelfServer();

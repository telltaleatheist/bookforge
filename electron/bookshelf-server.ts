/**
 * Bookshelf Server — HTTP server for remotely browsing/downloading/playing audiobooks.
 *
 * This is the WEB-BASED UI (accessible via browser on any device on the network).
 * It is NOT Studio, the Angular nav-rail workspace.
 *
 * Two distinct views in BookForge:
 *   - Studio:    Angular nav rail page — TTS pipeline & project management
 *   - Bookshelf: Web UI (this file) — browse/download/play/read the library remotely
 *
 * Everything it serves comes out of `{library}/projects/`: audiobooks from each
 * project's outputs/variants, reading editions from each project's archive/
 * (electron/ebook-library.ts). The old parallel `{library}/ebooks/` catalog was
 * retired in Jul 2026.
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
import { scanLibrary, extractCover, getAbsolutePath, isArchiveEntry, projectIdOfEntry } from './ebook-library';
import { getFfprobePath, getFfmpegPath } from './tool-paths';
import { extractVttFromM4b } from './metadata-tools';
import { getPdfInfo, renderPdfPage, shutdownEbookRender } from './ebook-render';
import { normalizeFsPath } from './path-utils';
// The TTS/ingest/import graph is loaded ON DEMAND, inside the handlers that need
// it (same precedent as the queue endpoints below). Those handlers are exactly
// the ones a standalone mirror refuses, so a NAS-hosted server never pulls the
// engine graph into memory at all. Types are `import type` — erased on emit.
import type { ReaderStreamBridge } from './reader-stream-bridge';
import type { EpubChapter } from './epub-writer';
import { verifyAudiobookAnalysis } from './audiobook-analysis-protocol';
import { readBinding, resolveSidecars, sidecarPathsFor } from './sidecar-binding';
import { regenerateBoundSidecars } from './sidecar-migration';
import {
  BookRecord, BookPosition, BookHeard, BookmarkOp,
  anchorForAbsolutePath, anchorForLegacyKey, currentPathOfAnchor,
  variantKey, isVariantKey, parseVariantKey, bookIdFromKey,
  legacyAudioKey, libraryRelativePath,
  readAliasMap, invertAliasMap, mergeBookRecords, mergeIntervals,
} from './bookshelf-identity';
import {
  ResolvedCover, ALLOWED_THUMBNAIL_WIDTHS, coverBytes, coverEtag, etagMatches,
  fileCoverIdentity, bytesCoverIdentity, parseThumbnailWidth, sweepThumbnailCache,
} from './cover-thumbnails';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BookshelfServerConfig {
  port: number;
  userDataPath?: string;
  /**
   * Absent — the Electron app's server: every capability, unchanged.
   * 'standalone' — a LIBRARY-ONLY MIRROR (the NAS copy, run headless by
   * `cli/serve-bookshelf.js`): the library can be browsed, streamed and read,
   * and reader state under `<library>/.bookshelf/` is written as usual, but
   * nothing that needs the TTS engine, ingests a document, or mutates the
   * library is available. Those routes answer 501 naming the capability.
   */
  mode?: 'standalone';
}

/**
 * What a server can do, as reported by `/api/health` and enforced by one gate.
 *
 *   library  browse/stream/download books, ebooks, covers, chapters, transcripts
 *   reader   profiles, sign-in, positions, bookmarks, heard coverage, analytics
 *   pdf      rasterized PDF pages for the in-app reader (mupdf; pure WASM, so a
 *            headless Linux mirror serves these exactly as the app does)
 *   render   live TTS + the whole-book renderer + the voice catalog
 *   ingest   turning a URL / uploaded file / PDF into readable blocks
 *   edit     creating a project from edited blocks
 *   queue    the processing queue (it lives in the app, not in a mirror)
 *   mutate   changing the library itself (delete a project, reclassify an ebook)
 */
export const BOOKSHELF_CAPABILITIES = ['library', 'reader', 'pdf', 'render', 'ingest', 'edit', 'queue', 'mutate'] as const;
export type BookshelfCapability = typeof BOOKSHELF_CAPABILITIES[number];

/** The subset a library-only mirror serves. Everything else answers 501. */
export const STANDALONE_CAPABILITIES: readonly BookshelfCapability[] = ['library', 'reader', 'pdf'];

/** What the 501 body says this server cannot do, per gated capability. */
const CAPABILITY_REFUSALS: Record<string, string> = {
  render: 'render audio',
  ingest: 'ingest documents',
  edit: 'create or edit projects',
  queue: 'run the processing queue',
  mutate: 'modify the library',
};

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
  professionallyRead?: boolean;  // user-settable "professionally read" flag
  // Who read it and when. Sent so the version picker can tell two PROFESSIONAL
  // editions of one book apart — without these the shelf labels both of them
  // "Audiobook" and they read as duplicates.
  narrator?: string;
  year?: string;
}

interface AudiobookEntry {
  projectId: string;
  variantId?: string;       // exact representative audiobook variant
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
  source?: 'project';  // identifies where the audiobook came from
  // "Professionally read" rollup over versions[] — drives the Professional filter.
  hasProfessional?: boolean;
  // Every playable audiobook variant of this project. The card shows one entry
  // (the primary/representative version); when versions.length > 1 the shelf pops
  // a picker. Always ≥1 for project books; absent for external m4b files.
  versions?: AudiobookVersion[];
}

interface AnalysisStreamSession {
  filePath: string;
  expectedSha256: string;
  expectedSize: number;
  transcriptVtt: string;
  handle?: fs.FileHandle;
  snapshotPath?: string;
  verifiedStat?: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  pinning?: Promise<void>;
  activeStreams: number;
  lastUsedAt: number;
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
// BookPosition / BookHeard / BookmarkOp / BookRecord and the merge that folds
// them now live in electron/bookshelf-identity.ts, next to the id grammar —
// because the id migration has to fold two books' records into one with EXACTLY
// the semantics this server reads them back with, and two copies of that rule
// would drift. `heardResetAt` is documented there.

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

  // Resolved-cover cache: which FILE (or which bytes) a book's cover is, not the
  // image itself. Skips re-walking the ladder — manifest read, sidecar check,
  // m4b crack — on every tile of every shelf load.
  private coverCache: Map<string, { cover: ResolvedCover; timestamp: number }> = new Map();
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

    // Invalidate cover cache for specific project or all. A project holds TWO
    // kinds of cover entry — its own id (audiobook covers) and one per reading
    // edition (`ebook:__archive__/<projectId>/<file>`) — and both are served from
    // the same manifest cover, so a metadata change must drop both or the Ebooks
    // tab keeps showing the old art until the TTL expires.
    if (projectId) {
      this.coverCache.delete(projectId);
      const ebookPrefix = `ebook:__archive__/${projectId}/`;
      for (const key of this.coverCache.keys()) {
        if (key.startsWith(ebookPrefix)) this.coverCache.delete(key);
      }
    } else {
      this.coverCache.clear();
    }
  }

  // Persistent duration cache to avoid re-parsing M4B headers
  private durationCache: Map<string, DurationCacheEntry> = new Map();
  private durationCacheDirty = false;
  /** Guards the background duration-enrichment pass against overlapping runs. */
  private durationEnrichRunning = false;

  // In-memory chapter cache keyed by filepath, validated against size+mtime.
  private chapterCache: Map<string, { size: number; mtimeMs: number; chapters: ChapterEntry[] }> = new Map();

  // In-memory embedded-transcript cache keyed by the m4b path, validated against
  // size+mtime. extractVttFromM4b spawns ffmpeg to stream the WHOLE subtitle track
  // out of the m4b (~1-1.5 MB, measured ~1.7s) — without this it re-ran on EVERY
  // player open and every offline sidecar refresh. `null` = the file has no
  // embedded transcript (cached too, so a bookless m4b isn't re-probed every time).
  private vttCache: Map<string, { size: number; mtimeMs: number; vtt: string | null }> = new Map();

  // A valid report issues a token that pins playback to one verified open file
  // descriptor. Every HTTP Range request then reads the same inode even if the
  // manifest path is atomically replaced while the player remains open.
  private analysisStreamSessions = new Map<string, AnalysisStreamSession>();
  private readonly ANALYSIS_STREAM_IDLE_TTL = 1000 * 60 * 60 * 6;
  private readonly MAX_ANALYSIS_STREAM_SESSIONS = 32;

  // Reader profiles + listening analytics — stored as per-device append-only logs
  // in the shared library so Syncthing never sees a two-writer file (no conflicts).
  //   <library>/.bookshelf/readers/<id>.json   write-once profile (creator only)
  //   <library>/.bookshelf/events/<device>.jsonl  append-only, this device only
  // Tokens are per-machine (userData), never synced.
  private storeReady = false;
  // Why the last attempt to open the store failed, for the sentence the client
  // is shown. Null when the store is ready or has never been tried.
  private storeInitError: string | null = null;
  private deviceId = '';
  private readerTokens: Map<string, string> = new Map(); // token -> readerId
  // Event ids already written to THIS device's log — the append-if-absent guard
  // that makes /api/analytics/heartbeat idempotent (see ListeningEvent.id).
  private seenEventIds: Set<string> = new Set();

  // Queue control callback (set by main process to bridge to renderer)
  private queueControlHandler: ((action: 'start' | 'pause') => void) | null = null;

  // bookshelf.json (library root) — read once at start. `serverAccessKey` gates
  // the whole API when set.
  private bookshelfConfig: { serverAccessKey?: string } = {};
  // True when bookshelf.json EXISTS but could not be read/parsed. We must not treat
  // that as "no key → open" (fail-open) — a corrupt config could be hiding a
  // serverAccessKey that was meant to gate the library. Fail CLOSED instead.
  private configLoadFailed = false;
  // size|mtime of the config as last read, or 'absent'. Compared per /api request
  // so a bookshelf.json that appeared (or changed) after startup takes effect
  // without a restart — see revalidateBookshelfConfig.
  private configIdentity = '';

  // "Listen to anything" Reader: streams TTS of arbitrary text to the web app over
  // a WebSocket riding this same HTTP server (authed by the reader's bearer token).
  // Built in start() from a dynamic import, so a standalone mirror never loads the
  // streaming engine graph that constructing it would pull in.
  private readerStream: ReaderStreamBridge | null = null;

  // True when this process is a library-only mirror (config.mode === 'standalone').
  // Set in start(); setupRoutes runs in the constructor, so the gate reads this
  // per request rather than at registration.
  private standalone = false;

  // ── Main-thread stall diagnostics (see the middleware in setupRoutes) ──────
  /** A request taking at least this long is worth a line. Streaming a whole m4b
   *  legitimately passes it, which is why the lag log below is the real signal. */
  private static readonly SLOW_REQUEST_MS = 500;
  /** The loop is expected to drift a few ms. This much means something ran to
   *  completion without yielding, and the desktop window was frozen for it. */
  private static readonly LAG_THRESHOLD_MS = 200;
  private static readonly LAG_SAMPLE_MS = 100;
  /** "GET /api/vtt" for every request currently open, so a stall can be blamed. */
  private readonly inFlight = new Set<string>();
  private lagTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  /**
   * Watch the main thread for stalls while the server is up.
   *
   * A setInterval that fires late by more than its period was BLOCKED — the
   * loop had no chance to run it. That is the same thread Electron uses to
   * answer the desktop window, so a stall here IS the frozen UI, measured
   * rather than inferred. Naming the in-flight requests turns "the app hangs
   * sometimes" into "GET /api/cover held the thread for 3.1s".
   *
   * Cheap enough to leave on: one timer at 10 Hz that does a subtraction.
   */
  private startLagWatch(): void {
    if (this.lagTimer) return;
    let last = Date.now();
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      const lag = now - last - BookshelfServer.LAG_SAMPLE_MS;
      last = now;
      if (lag < BookshelfServer.LAG_THRESHOLD_MS) return;
      const blamed = this.inFlight.size > 0 ? [...this.inFlight].join(', ') : 'nothing (not this server)';
      console.warn(`[BookshelfServer] MAIN THREAD STALLED ${lag}ms — in flight: ${blamed}`);
    }, BookshelfServer.LAG_SAMPLE_MS);
    // Never hold the process open for a diagnostic.
    this.lagTimer.unref?.();
  }

  private stopLagWatch(): void {
    if (!this.lagTimer) return;
    clearInterval(this.lagTimer);
    this.lagTimer = null;
  }

  /** The capabilities this server actually serves — reported by /api/health in
   *  BOTH modes so a client can degrade its controls instead of guessing. */
  capabilities(): BookshelfCapability[] {
    return this.standalone ? [...STANDALONE_CAPABILITIES] : [...BOOKSHELF_CAPABILITIES];
  }

  /**
   * The ONE standalone gate: wrap a handler so that a library-only mirror
   * refuses it, naming the capability the client asked for.
   *
   * Applied at route registration (below) rather than inside handlers, so the
   * gated set is readable in one place and a new route cannot quietly skip it.
   * The check itself is per-request because setupRoutes runs in the constructor,
   * before start() knows the mode. In app mode this costs one boolean.
   */
  private appOnly(capability: BookshelfCapability, handler: (req: Request, res: Response) => unknown) {
    const cannot = CAPABILITY_REFUSALS[capability];
    if (!cannot) throw new Error(`No refusal sentence for capability '${capability}' — add one to CAPABILITY_REFUSALS.`);
    return (req: Request, res: Response): unknown => {
      if (this.standalone) {
        res.status(501).json({ error: `This server is a library-only mirror and cannot ${cannot}`, capability });
        return undefined;
      }
      return handler(req, res);
    };
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
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, X-BookForge-Analysis-Stream-Token');
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
      // Pick up a bookshelf.json that appeared, changed or vanished since the last
      // request. One stat; see revalidateBookshelfConfig for why not a timer.
      this.revalidateBookshelfConfig();
      // Fail CLOSED if the config file existed but couldn't be parsed: we cannot
      // rule out that it carried a serverAccessKey, so serving the library would be
      // a silent security downgrade. Lock the API until the config is fixed.
      if (this.configLoadFailed) {
        res.status(503).json({ error: 'server configuration could not be read; API is locked for safety', code: 'CONFIG_ERROR' });
        return;
      }
      const key = this.bookshelfConfig.serverAccessKey;
      if (!key) { next(); return; } // opt-in: no key configured → unguarded
      const provided = (req.header('X-Access-Key') || req.query.accessKey || '').toString();
      if (provided === key) { next(); return; }
      // `code` lets the client distinguish "wrong key" from a plain failure and
      // prompt for it, rather than treating the server as unreachable.
      res.status(401).json({ error: 'access key required', code: 'ACCESS_KEY' });
    });

    // ── Who is blocking the desktop? ─────────────────────────────────────────
    //
    // Serving the phone runs in the SAME process that answers the desktop
    // window's IPC, so a handler that spends real time on the main thread
    // freezes the app on the PC. Owen hit exactly that opening an audiobook
    // (2026-08-21), and three plausible causes measured clean — the m4b sidecar
    // hash (453 MB in 1.2s, zero event-loop lag), libuv threadpool starvation
    // (20 small reads went 10ms → 13ms under a double 453 MB stream), and the
    // PDF reader (real, ~5.7s, and now moved to a worker thread — but he was
    // opening an audiobook).
    //
    // So this stops the guessing: every request is timed, and a lag sampler
    // names the requests that were IN FLIGHT while the loop stalled. A slow
    // request is not itself the bug — streaming a 453 MB m4b to the phone
    // SHOULD take a while and blocks nothing. A stalled loop is the bug, and
    // only the pairing of the two says which handler caused it.
    this.app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      const started = Date.now();
      const label = `${req.method} ${req.path}`;
      this.inFlight.add(label);
      res.on('close', () => {
        this.inFlight.delete(label);
        const ms = Date.now() - started;
        if (ms >= BookshelfServer.SLOW_REQUEST_MS) {
          console.log(`[BookshelfServer] SLOW ${label} took ${ms}ms`);
        }
      });
      next();
    });

    // API Routes
    this.app.get('/api/books', this.getBooks.bind(this));
    this.app.get('/api/cover', this.getCover.bind(this));
    this.app.get('/api/cover-image', this.getCoverImage.bind(this));
    this.app.get('/api/download', this.downloadFile.bind(this));
    this.app.get('/api/audio', this.streamAudio.bind(this));

    this.app.get('/api/tags', this.getTags.bind(this));
    this.app.get('/api/vtt', this.getVtt.bind(this));
    this.app.get('/api/audiobook-analysis', this.getAudiobookAnalysis.bind(this));
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
    this.app.post('/api/ebooks/reclassify', this.appOnly('mutate', this.postReclassifyEbook.bind(this)));
    // Delete a project outright (removes its whole folder). Auth by reader token.
    this.app.delete('/api/project', this.appOnly('mutate', this.deleteProjectRoute.bind(this)));

    // In-app reader: reads the pristine archived source of an audiobook project.
    // EPUBs stream whole (epub.js renders them reflowably on the client); PDFs
    // are rasterized page-by-page via mupdf (electron/ebook-render.ts).
    // Not gated in standalone: mupdf is a pure-WASM npm package (no native
    // binding, no spawned binary, no os/cpu restriction) rasterizing in its own
    // worker thread, so a headless Linux mirror serves pages exactly as the app
    // does. This is the `pdf` capability.
    this.app.get('/api/read-info', this.getReadInfo.bind(this));
    this.app.get('/api/read-file', this.getReadFile.bind(this));
    this.app.get('/api/read-page', this.getReadPage.bind(this));

    // "Listen to anything" Reader: turn a URL or an uploaded file into readable
    // blocks. JSON body {url} is parsed by the app-level express.json; a file is
    // sent as raw octet-stream bytes (X-File-Name header) — no multipart lib needed.
    this.app.post(
      '/api/reader/ingest',
      express.raw({ type: 'application/octet-stream', limit: '100mb' }),
      this.appOnly('ingest', this.postReaderIngest.bind(this)),
    );

    // Mobile import→edit finalize: turn edited blocks + chapter markers into a
    // real chaptered epub and create a persisted project (article/book tag). The
    // project's text lives in the library even if its audio is only streamed.
    this.app.post('/api/edit/finalize', this.appOnly('edit', this.postEditFinalize.bind(this)));

    // "TTS entire book": the persistent whole-book renderer. start kicks/ resumes
    // the render; status is polled by the reader; sentence serves rendered audio;
    // playhead steers render priority (forward-from-playhead + wrap).
    this.app.post('/api/render/start', this.appOnly('render', this.postRenderStart.bind(this)));
    this.app.get('/api/render/status', this.appOnly('render', this.getRenderStatus.bind(this)));
    this.app.get('/api/render/sentence', this.appOnly('render', this.getRenderSentence.bind(this)));
    this.app.post('/api/render/playhead', this.appOnly('render', this.postRenderPlayhead.bind(this)));

    // Reader "Stream / follow-along": serve a live-generated block's audio as a WAV
    // so the native AVPlayer can play it (it can't load the client's blob: URLs).
    // The block is driven by the reader WS (/api/reader/ws); this just serves the
    // PCM the bridge teed into reader-audio-store, keyed by the client's requestId.
    this.app.get('/api/reader/audio', this.appOnly('render', this.getReaderAudio.bind(this)));

    // TTS engine: voice catalog + fire-and-forget warmup (skip the cold start).
    this.app.get('/api/tts/voices', this.appOnly('render', this.getTtsVoices.bind(this)));
    this.app.post('/api/tts/warm', this.appOnly('render', this.postTtsWarm.bind(this)));
    // Project reader payload (title + blocks + chapter map) for the Read&Listen view.
    // Gated with `render`: it is the render plan, served only to feed that view,
    // whose playback a mirror cannot do either. Plain reading is /api/read-file.
    this.app.get('/api/project/reader', this.appOnly('render', this.getProjectReader.bind(this)));

    // PDF page-crop editor: ingest a PDF into pages+block-boxes (caching the file),
    // and rasterize those cached pages for the overlay preview.
    this.app.post(
      '/api/edit/ingest-pdf',
      express.raw({ type: 'application/octet-stream', limit: '200mb' }),
      this.appOnly('ingest', this.postEditIngestPdf.bind(this)),
    );
    // Serves pages of a PDF that only /api/edit/ingest-pdf can put in the cache,
    // so it travels with that capability rather than with `pdf`.
    this.app.get('/api/edit/page', this.appOnly('ingest', this.getEditPage.bind(this)));

    // Queue status & control.
    //
    // Two shapes deliberately: /api/queue is the legacy flat row list the older
    // web tab and any paired phone still read, and /api/queue/snapshot is the
    // engine's own snapshot, which the web queue page runs the SAME
    // shared/queue/bench.ts functions over as the desktop page. One queue must
    // not be described in two vocabularies, so the new page derives nothing here.
    this.app.get('/api/queue', this.appOnly('queue', this.getQueue.bind(this)));
    this.app.get('/api/queue/snapshot', this.appOnly('queue', this.getQueueSnapshot.bind(this)));
    this.app.post('/api/queue/start', this.appOnly('queue', this.startQueue.bind(this)));
    this.app.post('/api/queue/pause', this.appOnly('queue', this.pauseQueue.bind(this)));
    this.app.post('/api/queue/cancel', this.appOnly('queue', this.postQueueCancel.bind(this)));
    this.app.post('/api/queue/remove', this.appOnly('queue', this.postQueueRemove.bind(this)));
    this.app.post('/api/queue/retry', this.appOnly('queue', this.postQueueRetry.bind(this)));
    this.app.post('/api/queue/clear-finished', this.appOnly('queue', this.postQueueClearFinished.bind(this)));

    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      // `name` is the serving machine's hostname so a client (esp. the web build,
      // whose location.hostname is just "localhost") can label the library by the
      // server it's actually on. The user can still rename it in the app.
      // `capabilities` is present in BOTH modes so a client can disable the
      // controls a given server cannot serve instead of probing for 501s.
      res.json({ status: 'ok', name: os.hostname().split('.')[0], capabilities: this.capabilities() });
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
    this.standalone = config.mode === 'standalone';
    if (config.userDataPath) {
      this.userDataPath = config.userDataPath;
    }
    if (this.standalone) {
      console.log(`[BookshelfServer] STANDALONE (library-only mirror) — capabilities: ${this.capabilities().join(', ')}`);
    }

    // Load persistent caches + library config. The alias map is dropped rather
    // than carried across a restart: the id migration is run with the app
    // closed, so "start the server again" has to be a working way to pick its
    // work up, not something you wait out.
    this.aliasCache = null;
    this.loadBookshelfConfig();
    await this.loadDurationCache();
    this.initReaderStore();

    // A re-saved cover leaves its old thumbnail behind (the identity changed),
    // so trim the oldest once per start. 4000 is ~8 shelves' worth of covers at
    // three widths — far more than the 543 covers in Owen's library.
    const thumbs = this.thumbnailCacheDir();
    if (thumbs) sweepThumbnailCache(thumbs, 4000);
    else console.warn('[BookshelfServer] No userData path — cover thumbnails will be generated per request, not cached.');

    // The Reader TTS socket is the WebSocket half of the `render` capability, so
    // a mirror must not build it — constructing the bridge imports the streaming
    // engine. Loaded here (not at module scope) for exactly that reason.
    if (!this.standalone) {
      const { ReaderStreamBridge } = await import('./reader-stream-bridge.js');
      this.readerStream = new ReaderStreamBridge();
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`[BookshelfServer] Started on port ${this.port}`);
        this.startLagWatch();
        resolve();
      });

      if (this.readerStream) {
        // Wire the Reader TTS stream socket onto this server (WebSocket upgrades on
        // /api/reader/ws, authed by the reader token → readerId).
        this.readerStream.attach(this.server, (t) => this.readerTokens.get(t) ?? null);
      } else {
        // Standalone: answer the upgrade with the same 501 the HTTP routes give,
        // rather than letting node destroy the socket without a word — a client
        // that finds the socket closed cannot tell "unsupported" from "broken".
        this.server.on('upgrade', (_req, socket) => {
          const body = JSON.stringify({ error: `This server is a library-only mirror and cannot ${CAPABILITY_REFUSALS['render']}`, capability: 'render' });
          socket.end(
            'HTTP/1.1 501 Not Implemented\r\n'
            + 'Content-Type: application/json\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\n`
            + 'Connection: close\r\n\r\n'
            + body);
        });
      }

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

  /**
   * Re-read bookshelf.json when it has changed — checked PER /api REQUEST, not
   * on a timer.
   *
   * It used to be read once at startup, which had a failure mode nobody wants:
   * a server that started before the library root existed (or before the file
   * was synced in) served the whole library unguarded until somebody thought to
   * restart it. A timer would only narrow that window; the direction that
   * matters — a `serverAccessKey` appearing — has to take effect on the very
   * next request. The check is one `stat` of one small file, against handlers
   * that read manifests and crack m4bs, so its cost is not measurable.
   */
  private revalidateBookshelfConfig(): void {
    const configPath = path.join(getLibraryBasePath(), 'bookshelf.json');
    let identity = '';
    try {
      const st = fsSync.statSync(configPath);
      identity = `${st.size}|${Math.round(st.mtimeMs)}`;
    } catch {
      identity = 'absent';
    }
    if (identity === this.configIdentity) return;
    this.loadBookshelfConfig();
  }

  /** Read bookshelf.json (library root). Called at startup and whenever the file's
   *  size/mtime has changed since we last looked. */
  private loadBookshelfConfig(): void {
    const configPath = path.join(getLibraryBasePath(), 'bookshelf.json');
    // A genuinely ABSENT file is the trusted-tailnet default: open, not a failure.
    if (!fsSync.existsSync(configPath)) {
      this.bookshelfConfig = {};
      this.configLoadFailed = false;
      this.configIdentity = 'absent';
      return;
    }
    try {
      const st = fsSync.statSync(configPath);
      this.configIdentity = `${st.size}|${Math.round(st.mtimeMs)}`;
    } catch {
      // It existed a line ago and cannot be stat'd now — leave the identity
      // unset so the next request looks again rather than trusting this read.
      this.configIdentity = '';
    }
    // The file exists — if we can't read/parse it we do NOT know whether it gated
    // the library, so we latch a failure that makes the /api gate fail closed.
    try {
      this.bookshelfConfig = JSON.parse(fsSync.readFileSync(configPath, 'utf-8')) || {};
      this.configLoadFailed = false;
      if (this.bookshelfConfig.serverAccessKey) {
        console.log('[BookshelfServer] Access key configured — API is gated');
      }
    } catch (err) {
      console.error('[BookshelfServer] bookshelf.json exists but could not be read — locking /api (fail closed):', err);
      this.bookshelfConfig = {};
      this.configLoadFailed = true;
    }
  }

  async stop(): Promise<void> {
    this.stopLagWatch();
    await Promise.all([...this.analysisStreamSessions.values()].map(session => this.disposeAnalysisStreamSession(session)));
    this.analysisStreamSessions.clear();
    // The reader's mupdf worker exists only to serve this server; with the
    // server down it has nothing to answer, and its WASM heap should not sit
    // out the five-minute idle timer.
    await shutdownEbookRender();
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

  private async disposeAnalysisStreamSession(session: AnalysisStreamSession): Promise<void> {
    await session.handle?.close().catch(() => {});
    session.handle = undefined;
    if (session.snapshotPath) {
      await fs.rm(path.dirname(session.snapshotPath), { recursive: true, force: true }).catch(() => {});
      session.snapshotPath = undefined;
    }
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
            // The output-map key is part of the stable variant identity. Descriptor
            // is free-form display metadata and must never select a transcript.
            langPair: isBilingual ? v.id.slice('bilingual:'.length) : undefined,
            downloadPath: absPath,
            coverPath: resolveCover(v.metadata?.coverPath) ?? coverAbsPath,
            size: stats.size,
            dateAdded: v.addedAt || new Date(stats.mtimeMs).toISOString(),
            // getVariants() already stamps professionallyRead on every audiobook variant.
            professionallyRead: v.professionallyRead,
            narrator: v.metadata?.narrator,
            // The wire declares a STRING and the manifests do not agree with
            // themselves — measured on the live library, 83 variants store year
            // as a number and 108 as a string. Passed through raw, the number
            // reached versionLabel's `.trim()` and the throw killed the Audio
            // tab's whole render on any phone with a multi-edition download
            // (blip, 2026-08-26: the tab would not even light up). Normalize at
            // the boundary; the manifest keeps whatever it had.
            year: v.metadata?.year != null ? String(v.metadata.year) : undefined,
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
      // A project is "professional" if any of its audiobook variants is flagged
      // professionally read → it appears in the Professional filter.
      const hasProfessional = versions.some(v => v.professionallyRead);
      entries.push({
        projectId: manifest.projectId,
        variantId: rep.variantId,
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
        hasProfessional,
        versions,
      });
    }

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
      const analysisToken = req.query.analysisToken as string | undefined;

      if (!projectId) {
        res.status(204).end();
        return;
      }

      // When analysis is open, serve the exact transcript snapshot that was
      // digested during report verification—not a sidecar pathname that could
      // have changed between concurrent requests.
      if (analysisToken && variantPath) {
        const session = this.analysisStreamSessions.get(analysisToken);
        if (!session
          || Date.now() - session.lastUsedAt > this.ANALYSIS_STREAM_IDLE_TTL
          || path.resolve(variantPath) !== session.filePath) {
          if (session && Date.now() - session.lastUsedAt > this.ANALYSIS_STREAM_IDLE_TTL) {
            void this.disposeAnalysisStreamSession(session);
            this.analysisStreamSessions.delete(analysisToken);
          }
          res.status(409).json({ error: 'Verified analysis transcript token is missing or stale' });
          return;
        }
        session.lastUsedAt = Date.now();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send(session.transcriptVtt);
        return;
      }

      const manifestPath = path.join(getProjectPath(projectId), 'manifest.json');
      if (!fsSync.existsSync(manifestPath)) {
        res.status(204).end();
        return;
      }

      // Mono audiobooks: the transcript is bound to THIS audio's bytes. Prefer the
      // hash-bound sidecar (a plain validated file read — no per-request ffmpeg), and
      // fall back to extracting the copy still sealed in the m4b. Both are guaranteed
      // to be this audio's transcript: the sidecar by its m4bSha256 binding, the
      // embedded track by living inside the file. A mono m4b with neither has no text.
      if (variantPath && this.isPathWithinLibrary(variantPath) && fsSync.existsSync(variantPath)) {
        const bound = await this.boundSidecars(variantPath);
        if (bound.vtt) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          fsSync.createReadStream(bound.vtt).pipe(res);
          return;
        }
        const embedded = await this.extractVttCached(variantPath);
        if (embedded) {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.send(embedded);
          // No valid bound sidecar existed (new/re-aligned book) — generate it now so
          // the next load is a validated file read and downloads get a bound copy.
          this.regenerateSidecarsLazily(variantPath);
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

  /** Serve a report only after the protocol has re-verified its manifest pointer,
   *  schema, exact M4B bytes, and canonical authoritative transcript. The client
   *  supplies identities only; filesystem paths are never accepted here. */
  private async getAudiobookAnalysis(req: Request, res: Response): Promise<void> {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const variantId = typeof req.query.variantId === 'string' ? req.query.variantId : '';
    const openedPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!projectId || !variantId || !openedPath) {
      res.status(400).json({ error: 'projectId, variantId, and opened path assertion are required' });
      return;
    }

    try {
      const verified = await verifyAudiobookAnalysis(projectId, variantId);
      if (verified.status !== 'valid') {
        // Missing and stale are both "not available" to the player. In particular,
        // never leak a stale envelope and let the renderer decide whether to trust it.
        if (verified.status === 'stale') {
          console.warn(`[BookshelfServer] Refusing stale audiobook analysis for ${projectId}/${variantId}: ${verified.reason}`);
        }
        res.status(204).end();
        return;
      }
      // `openedPath` is an assertion, never a lookup path. Resolve the verified
      // binding from the manifest, then require it to be the exact catalog M4B
      // the player is about to open. This rejects a stale shelf entry after a
      // variant was regenerated or renamed.
      const boundPath = normalizeFsPath(path.join(getProjectPath(projectId), verified.report.binding.m4bPath));
      if (path.resolve(openedPath) !== path.resolve(boundPath)) {
        console.warn(`[BookshelfServer] Refusing audiobook analysis for stale opened path: ${projectId}/${variantId}`);
        res.status(409).json({ error: 'Opened audiobook does not match the verified analysis binding' });
        return;
      }
      const streamToken = this.issueAnalysisStreamSession(
        boundPath,
        verified.report.binding.m4bSha256,
        verified.report.binding.m4bSizeBytes,
        verified.transcriptVtt,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-BookForge-Analysis-Stream-Token', streamToken);
      res.json(verified.report);
    } catch (err) {
      console.error('[BookshelfServer] Error verifying audiobook analysis:', err);
      res.status(500).json({ error: 'Failed to verify audiobook analysis' });
    }
  }

  private issueAnalysisStreamSession(
    filePath: string,
    expectedSha256: string,
    expectedSize: number,
    transcriptVtt: string,
  ): string {
    const now = Date.now();
    for (const [token, session] of this.analysisStreamSessions) {
      if (!session.pinning && session.activeStreams === 0 && now - session.lastUsedAt > this.ANALYSIS_STREAM_IDLE_TTL) {
        void this.disposeAnalysisStreamSession(session);
        this.analysisStreamSessions.delete(token);
      }
    }
    while (this.analysisStreamSessions.size >= this.MAX_ANALYSIS_STREAM_SESSIONS) {
      const oldest = [...this.analysisStreamSessions.entries()]
        .filter(([, session]) => !session.pinning && session.activeStreams === 0)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!oldest) break;
      void this.disposeAnalysisStreamSession(oldest[1]);
      this.analysisStreamSessions.delete(oldest[0]);
    }
    const token = crypto.randomUUID();
    this.analysisStreamSessions.set(token, {
      filePath: path.resolve(filePath),
      expectedSha256,
      expectedSize,
      transcriptVtt,
      activeStreams: 0,
      lastUsedAt: now,
    });
    return token;
  }

  private async pinAnalysisStreamSession(token: string, requestedPath: string): Promise<AnalysisStreamSession> {
    const session = this.analysisStreamSessions.get(token);
    if (!session || Date.now() - session.lastUsedAt > this.ANALYSIS_STREAM_IDLE_TTL) {
      if (session) {
        void this.disposeAnalysisStreamSession(session);
        this.analysisStreamSessions.delete(token);
      }
      throw new Error('Verified analysis stream token is missing or expired');
    }
    if (path.resolve(requestedPath) !== session.filePath) {
      throw new Error('Verified analysis stream token targets another audiobook');
    }
    session.lastUsedAt = Date.now();
    if (session.handle) return session;
    if (!session.pinning) {
      session.pinning = (async () => {
        const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookforge-analysis-stream-'));
        const snapshotPath = path.join(snapshotDir, 'audiobook.m4b');
        let handle: fs.FileHandle | undefined;
        try {
          // APFS and other supporting filesystems make this a cheap copy-on-write
          // clone; Node falls back to a normal copy elsewhere. The private snapshot
          // removes the stat-to-read race of streaming a mutable source inode.
          await fs.copyFile(session.filePath, snapshotPath, fsSync.constants.COPYFILE_FICLONE);
          handle = await fs.open(snapshotPath, 'r');
          const openedHandle = handle;
          const before = await openedHandle.stat();
          if (!before.isFile() || before.size !== session.expectedSize) {
            throw new Error('Audiobook no longer matches the verified analysis size');
          }
          const hash = crypto.createHash('sha256');
          await new Promise<void>((resolve, reject) => {
            const input = fsSync.createReadStream(snapshotPath, { fd: openedHandle.fd, autoClose: false, start: 0 });
            input.on('data', chunk => hash.update(chunk));
            input.on('error', reject);
            input.on('end', resolve);
          });
          const after = await openedHandle.stat();
          if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || hash.digest('hex') !== session.expectedSha256) {
            throw new Error('Audiobook bytes do not match the verified analysis binding');
          }
          session.handle = openedHandle;
          session.snapshotPath = snapshotPath;
          session.verifiedStat = {
            dev: after.dev, ino: after.ino, size: after.size,
            mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs,
          };
        } catch (err) {
          await handle?.close().catch(() => {});
          await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
      })();
    }
    try {
      await session.pinning;
      return session;
    } catch (err) {
      this.analysisStreamSessions.delete(token);
      throw err;
    } finally {
      session.pinning = undefined;
    }
  }

  /** extractVttFromM4b behind a size+mtime cache (see vttCache). A re-embed changes
   *  the m4b's size/mtime, so the stale entry is discarded and the new transcript
   *  extracted once; unchanged files are served from memory without spawning ffmpeg. */
  private async extractVttCached(m4bPath: string): Promise<string | null> {
    let stats: fsSync.Stats;
    try {
      stats = fsSync.statSync(m4bPath);
    } catch {
      return null;
    }
    const cached = this.vttCache.get(m4bPath);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return cached.vtt;
    }
    const vtt = await extractVttFromM4b(m4bPath);
    this.vttCache.set(m4bPath, { size: stats.size, mtimeMs: stats.mtimeMs, vtt });
    return vtt;
  }

  /** Resolve an m4b's HASH-BOUND sidecars (bookforge-sidecar-binding-v1). The binding
   *  lives at the deterministic sibling path `<m4b>.sidecars.json`; a sidecar is only
   *  returned when its recorded m4bSha256 matches the m4b actually being served, so a
   *  cover/transcript can never spill onto the wrong audiobook. Delivery-tier: the m4b
   *  hash is cached by (path,size,mtime), so this is a cheap file read on the hot path,
   *  not a per-request ffmpeg spawn. Returns absolute sidecar paths (or nulls). */
  private async boundSidecars(m4bAbsPath: string): Promise<{ vtt: string | null; cover: string | null }> {
    try {
      const binding = await readBinding(sidecarPathsFor(m4bAbsPath).binding);
      if (!binding) return { vtt: null, cover: null };
      const r = await resolveSidecars(binding, m4bAbsPath, path.dirname(m4bAbsPath));
      return { vtt: r.vtt, cover: r.cover };
    } catch {
      return { vtt: null, cover: null };
    }
  }

  // m4bs whose bound sidecars are being (re)generated right now, so a burst of
  // cover/VTT requests for the same book triggers the ffmpeg extraction only once.
  private readonly regeneratingSidecars = new Set<string>();

  /** Lazily (re)generate an m4b's bound sidecars after we had to fall back to the
   *  embedded copy — i.e. no valid binding existed (a new book, or a re-aligned m4b
   *  whose old binding went stale when the bytes changed). Fire-and-forget: it never
   *  blocks the response and never throws. This is how books stay bound going forward
   *  without touching the production reassembly/generate-sentences bridges. */
  private regenerateSidecarsLazily(m4bAbsPath: string): void {
    if (this.regeneratingSidecars.has(m4bAbsPath)) return;
    this.regeneratingSidecars.add(m4bAbsPath);
    void regenerateBoundSidecars(m4bAbsPath)
      .catch(() => null)
      .finally(() => this.regeneratingSidecars.delete(m4bAbsPath));
  }

  /** Read a sidecar cover file into the same base64 data URL /api/cover returns
   *  (mime sniffed from magic bytes), or null. */
  private async coverFileToDataUrl(coverAbsPath: string): Promise<string | null> {
    try {
      const buffer = await fs.readFile(coverAbsPath);
      const mimeType = (buffer[0] === 0x89 && buffer[1] === 0x50) ? 'image/png' : 'image/jpeg';
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  }

  /**
   * A cover FILE described without reading it: its identity is size+mtime, so
   * the ETag and the thumbnail cache key are both known off one `stat()`. The
   * mime type is sniffed lazily by the thumbnailer, which re-encodes anyway;
   * for the full-size path we sniff the first two bytes and no more.
   */
  private async describeCoverFile(absPath: string): Promise<ResolvedCover | null> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size === 0) return null;
    let contentType = 'image/jpeg';
    try {
      const handle = await fs.open(absPath, 'r');
      try {
        const head = Buffer.alloc(2);
        await handle.read(head, 0, 2, 0);
        if (head[0] === 0x89 && head[1] === 0x50) contentType = 'image/png';
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    return { identity: fileCoverIdentity(absPath, stat), contentType, filePath: absPath };
  }

  /** A data URL turned into an in-memory cover (only the m4b-extraction rung
   *  produces one of these; everything else is already a file). */
  private describeCoverDataUrl(dataUrl: string): ResolvedCover | null {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length === 0) return null;
    return { identity: bytesCoverIdentity(buffer), contentType: m[1], buffer };
  }

  /** The project's manifest cover as a file, or null. The plain-file rung of the
   *  ladder, split out from the old data-URL loader so a request that only needs
   *  the ETag never reads a 14 MB JPEG. */
  private async manifestCoverFile(projectId: string): Promise<string | null> {
    try {
      const manifestPath = path.join(getProjectPath(projectId), 'manifest.json');
      if (!fsSync.existsSync(manifestPath)) return null;
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      const coverPath = manifest.metadata?.coverPath;
      if (!coverPath) return null;
      const absPath = path.join(getLibraryBasePath(), coverPath);
      return fsSync.existsSync(absPath) ? absPath : null;
    } catch (err) {
      console.error('[BookshelfServer] Error reading manifest cover path:', err);
      return null;
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

  /**
   * Prepare the shared per-device store. No native deps — just the filesystem.
   * Profiles + event logs live in the shared library; tokens stay per-machine.
   *
   * ── Why this can be called again ──────────────────────────────────────────
   *
   * This ran ONCE, at start. A server that started before `.bookshelf/` could be
   * made — the library root not mounted yet, a freshly-pointed library root that
   * did not exist when the window opened — latched `storeReady = false` and kept
   * it for the life of the process. Every reader endpoint then behaved as though
   * there were simply no readers: Owen opened the bookshelf on his phone and was
   * offered the create-a-profile screen for accounts that were sitting on disk.
   *
   * So the latch is now a CACHE of the last attempt, not a verdict:
   * `requireReaderStore()` retries whenever the store is not ready, and a
   * failure is reported with its reason instead of being answered with [].
   */
  private initReaderStore(): boolean {
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
      this.storeInitError = null;
      console.log('[BookshelfServer] Reader store ready (device', this.deviceId + ')');
      return true;
    } catch (err) {
      this.storeInitError = err instanceof Error ? err.message : String(err);
      console.error('[BookshelfServer] Failed to init reader store:', err);
      this.storeReady = false;
      return false;
    }
  }

  /**
   * The reader store, made if it isn't there yet. THROWS when it cannot be made,
   * naming the directory and the reason — every caller turns that into a 503 the
   * client shows. An empty answer is not available here on purpose: "there are
   * no readers" and "I could not look" are different sentences, and only one of
   * them should send somebody to the create-a-profile screen.
   */
  private requireReaderStore(): void {
    if (this.storeReady) return;
    if (this.initReaderStore()) return;
    throw new Error(
      `The reader store under ${this.bookshelfDir()} could not be opened (${this.storeInitError}). `
      + 'No reader list is given rather than an empty one, which would read as "nobody has an account '
      + 'on this library".');
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

    const { ingestFromUrl, ingestFromFile } = await import('./reader-ingest.js');
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
      const { buildEpubBuffer } = await import('./epub-writer.js');
      const { importEpubProject } = await import('./import-epub-project.js');
      const { saveRenderPlan } = await import('./book-render-service.js');
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
      const { analyzePdfPages } = await import('./reader-ingest.js');
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
    const { bookRenderService } = await import('./book-render-service.js');
    const r = await bookRenderService.start(projectId, startIndex, voice);
    if (!r.ok) { res.status(422).json({ error: r.error || 'render failed to start' }); return; }
    res.json({ ok: true, total: r.total });
  }

  /** GET /api/tts/voices — the voices the active streaming engine can use, plus
   *  the persisted default and the live-loaded one (mirrors the WS hello). */
  private async getTtsVoices(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    try {
      const { getActiveEngine, getSelectedEngineName, getDefaultStreamVoice } = await import('./streaming-engine.js');
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
  private async postTtsWarm(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const body = req.body as { voice?: unknown };
    const voice = typeof body?.voice === 'string' && body.voice ? body.voice : undefined;
    const { getActiveEngine, getDefaultStreamVoice } = await import('./streaming-engine.js');
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
  private async getRenderStatus(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    const { bookRenderService } = await import('./book-render-service.js');
    res.json(bookRenderService.status(projectId));
  }

  /** GET /api/render/sentence?projectId&index — a rendered sentence's WAV bytes. */
  private async getRenderSentence(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    const index = Number(req.query.index);
    if (!this.validProjectId(projectId) || !Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: 'projectId and index required' }); return;
    }
    const { bookRenderService } = await import('./book-render-service.js');
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
    const { readerAudioStore } = await import('./reader-audio-store.js');
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
  private async postRenderPlayhead(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = (req.body as { projectId?: unknown })?.projectId;
    const index = Number((req.body as { index?: unknown })?.index) || 0;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    const { bookRenderService } = await import('./book-render-service.js');
    bookRenderService.reportPlayhead(projectId, index);
    res.json({ ok: true });
  }

  /** GET /api/project/reader?projectId — title + display blocks + chapter map for
   *  the Read&Listen view. */
  private async getProjectReader(req: Request, res: Response): Promise<void> {
    if (!this.readerIdFromRequest(req)) { res.status(401).json({ error: 'not signed in' }); return; }
    const projectId = req.query.projectId;
    if (!this.validProjectId(projectId)) { res.status(400).json({ error: 'projectId required' }); return; }
    const { bookRenderService } = await import('./book-render-service.js');
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

  /**
   * One reader's profile, or null when this device has never seen that reader.
   *
   * ── "NOT THERE" and "CANNOT BE READ" are different answers ────────────────
   *
   * Both used to come back as null, and null means "not signed in" to every
   * caller — so a profile file that was mid-Syncthing-write, or on a share that
   * had dropped, signed the phone out and offered it the create-a-reader screen
   * for an account that exists. A file that is THERE and will not parse is an
   * error with a sentence; only its absence is an answer.
   */
  private readProfile(id: string): ReaderProfile | null {
    const p = path.join(this.readersDir(), `${id}.json`);
    if (!fsSync.existsSync(p)) return null;
    try {
      return JSON.parse(fsSync.readFileSync(p, 'utf-8')) as ReaderProfile;
    } catch (err) {
      throw new Error(
        `Reader ${id}'s profile is on this machine and could not be read `
        + `(${err instanceof Error ? err.message : String(err)}). Nobody is signed out — the store `
        + 'is unreadable, and answering "no such reader" would be a guess.');
    }
  }

  /**
   * Every reader this device knows about. An empty list means there are none;
   * a store that cannot be read THROWS, for the reason `readProfile` states.
   */
  private allProfiles(): ReaderProfile[] {
    let names: string[];
    try {
      names = fsSync.readdirSync(this.readersDir());
    } catch (err) {
      // The directory not existing yet IS "no readers" — it is made on first
      // create. Anything else is a store that cannot be read.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(
        `The reader store could not be read (${err instanceof Error ? err.message : String(err)}). `
        + 'No reader list is shown rather than an empty one, which would read as "nobody has an '
        + 'account here".');
    }
    return names
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const file = path.join(this.readersDir(), f);
        try {
          return JSON.parse(fsSync.readFileSync(file, 'utf-8')) as ReaderProfile;
        } catch (err) {
          throw new Error(
            `${f} in the reader store could not be read `
            + `(${err instanceof Error ? err.message : String(err)}). The reader it describes would `
            + 'otherwise simply vanish from the sign-in list.');
        }
      });
  }

  /** Library-relative, forward slashes — the shape a pre-anchor analytics log
   *  recorded. Kept only so those old rows can still be recognised. */
  private relBookKey(absPath: string): string {
    return libraryRelativePath(absPath) ?? path.basename(absPath);
  }

  /**
   * The analytics log's name for a book. Same variant anchor the per-book stores
   * use, so "Add to archive" no longer splits a book's listening time in two.
   * A file no variant claims keeps the library-relative path it always had.
   */
  private analyticsBookKey(absPath: string): string {
    if (!absPath) return '';
    // Same resolution the per-book stores use, stale paths and all — a replayed
    // heartbeat must credit the book, not a ghost of where it used to live.
    const key = this.positionKeyFrom('', absPath);
    if (key && isVariantKey(key)) return key;
    return this.relBookKey(absPath);
  }

  /** An analytics bookKey off any log (old bare path or new variant key) → the
   *  canonical one, so the two forms sum into a single book. */
  private analyticsKeyOf(raw: string): string {
    if (isVariantKey(raw)) return raw;
    const canonical = this.canonicalKey(`a:${raw}`);
    return isVariantKey(canonical) ? canonical : raw;
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
  //
  // The bookId is base64url of the book's KEY, and the key is anchored to the
  // VARIANT, not to the file path — see electron/bookshelf-identity.ts for why
  // (short version: "Add to archive" used to rename the book out from under the
  // reader). Old path-form keys are still read, forever; they are never written.
  // ─────────────────────────────────────────────────────────────────────────────

  private booksRoot(): string { return path.join(this.bookshelfDir(), 'books'); }
  private bookDir(bookId: string): string { return path.join(this.booksRoot(), bookId); }
  private bookFile(bookId: string): string { return path.join(this.bookDir(bookId), `${this.deviceId}.json`); }
  private bookIdFromKey(key: string): string { return bookIdFromKey(key); }

  // The alias map is read from disk and cached briefly: it changes only when the
  // id migration runs, and re-reading a directory of JSON on every position
  // heartbeat would be a silly tax. A parse failure PROPAGATES (it is a store
  // that cannot be read, not an empty one) — see readAliasMap.
  private aliasCache: { at: number; map: Map<string, string>; back: Map<string, string[]> } | null = null;
  private readonly ALIAS_CACHE_TTL = 1000 * 10;

  private aliases(): { map: Map<string, string>; back: Map<string, string[]> } {
    if (this.aliasCache && Date.now() - this.aliasCache.at < this.ALIAS_CACHE_TTL) return this.aliasCache;
    const map = readAliasMap(this.bookshelfDir());
    this.aliasCache = { at: Date.now(), map, back: invertAliasMap(map) };
    return this.aliasCache;
  }

  /**
   * The key this book is READ AND WRITTEN under: `v:<projectId>/<variantId>`.
   *
   * `ref` is whatever the client called the book — a new-form key, a path-form
   * key cached on a phone that has been offline for a month, or a reader ref
   * (`p:<projectId>`) that was never path-anchored to begin with. `bookPath` is
   * an absolute audiobook file, which is what every audio client sends.
   */
  private positionKeyFrom(ref: string, bookPath: string): string | null {
    if (ref) return this.canonicalKey(ref);
    if (!bookPath) return null;
    const anchor = anchorForAbsolutePath(bookPath);
    if (anchor) return variantKey(anchor.projectId, anchor.variantId);
    // No variant claims this file today. That is routinely a STALE PATH rather
    // than an unknown book: a phone flushing an offline queue replays the path
    // it captured, and the file has since been moved into archive/. Run it
    // through the alias map, which is exact — the migration recorded where that
    // path went. Without this, an offline replay mints a fresh orphan under the
    // very key everything else just stopped using.
    const canonical = this.canonicalKey(legacyAudioKey(bookPath));
    if (isVariantKey(canonical)) return canonical;
    // Genuinely unknown — an external m4b, or one no manifest points at. The
    // path really is all we know about it, so the path-form key stays its key.
    // That is not a fallback: there is no anchor to anchor to.
    return canonical;
  }

  /** Any id form → the canonical key. Unresolvable ids pass through verbatim so
   *  whatever is filed under them stays reachable. */
  private canonicalKey(key: string): string {
    if (isVariantKey(key)) return key;
    const aliased = this.aliases().map.get(key);
    if (aliased) return aliased;
    const anchor = anchorForLegacyKey(key);
    return anchor ? variantKey(anchor.projectId, anchor.variantId) : key;
  }

  /**
   * Every key whose stored records belong to this book, canonical first.
   *
   * Reading is a UNION; writing only ever touches the canonical key. The union
   * covers three cases at once: a migrated library (records under the canonical
   * key), a phone that wrote under an old id before the migration (records
   * under an aliased key), and a library that has never been migrated at all
   * (records under whatever path the variant's file sits at today).
   */
  private keysToFold(key: string): string[] {
    const keys = [key];
    const add = (k: string) => { if (k && !keys.includes(k)) keys.push(k); };
    for (const old of this.aliases().back.get(key) || []) add(old);
    const anchor = parseVariantKey(key);
    if (anchor) {
      const current = currentPathOfAnchor(anchor);
      if (current) {
        add(legacyAudioKey(current));
        // A reading edition's legacy key was the ebook address, not the audio one.
        const rel = libraryRelativePath(current);
        const m = rel ? /^projects\/([^/]+)\/archive\/(.+)$/.exec(rel) : null;
        if (m) add(`e:__archive__/${m[1]}/${m[2]}`);
      }
    }
    return keys;
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

  /**
   * Everything every device (and every id this book has ever had) holds for
   * reader+key, folded into one answer.
   *
   * `keysToFold` decides WHICH ids belong to this book; `mergeBookRecords`
   * decides HOW they combine — the identical function the id migration uses, so
   * a migrated store reads back exactly as the un-migrated one did.
   */
  private mergeBook(key: string, readerId: string): { position: BookPosition | null; heard: number[][]; heardResetAt: string; bookmarks: Record<string, unknown>[] } {
    const records: Array<BookRecord | undefined> = [];

    for (const k of this.keysToFold(key)) {
      const dir = this.bookDir(this.bookIdFromKey(k));
      try {
        for (const f of fsSync.readdirSync(dir).filter(x => x.endsWith('.json'))) {
          let store: Record<string, BookRecord>;
          try { store = JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf-8')); } catch { continue; }
          if (store?.[readerId]) records.push(store[readerId]);
        }
      } catch { /* no per-book dir for this id */ }
      this.foldLegacy(k, readerId, records);
    }

    const merged = mergeBookRecords(records);
    return {
      position: merged.position ?? null,
      heard: merged.heard?.intervals ?? [],
      heardResetAt: merged.heardResetAt ?? '',
      // A 'del' op is a tombstone, kept through the merge and dropped here.
      bookmarks: (merged.bookmarks || []).filter(o => o.op === 'add').map(o => o.bm),
    };
  }

  /** Add the pre-consolidation stores (positions/, heard/, bookmarks/) for one id. */
  private foldLegacy(key: string, readerId: string, records: Array<BookRecord | undefined>): void {
    try {
      for (const f of fsSync.readdirSync(this.positionsDir()).filter(x => x.endsWith('.json'))) {
        let store: Record<string, Record<string, BookPosition>>;
        try { store = JSON.parse(fsSync.readFileSync(path.join(this.positionsDir(), f), 'utf-8')); } catch { continue; }
        const e = store?.[readerId]?.[key];
        if (e) records.push({ position: e });
      }
    } catch { /* none */ }
    try {
      for (const f of fsSync.readdirSync(this.heardDir()).filter(x => x.endsWith('.json'))) {
        let store: Record<string, Record<string, BookHeard>>;
        try { store = JSON.parse(fsSync.readFileSync(path.join(this.heardDir(), f), 'utf-8')); } catch { continue; }
        const e = store?.[readerId]?.[key];
        if (e) records.push({ heard: e });
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
          records.push({ bookmarks: [{ op: e.op, bm: e.bm as Record<string, unknown>, at: e.at }] });
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

  /**
   * Reader profiles for the desktop picker (sorted by name).
   *
   * Throws when the store is unreadable — see `allProfiles`. The IPC handler
   * that calls this reports the sentence; an empty list here would read as
   * "nobody has an account on this machine" and send the user to create one.
   */
  listReaderProfiles(): Array<{ id: string; name: string; hasPin: boolean }> {
    // Was `if (!storeReady) return []` — the very fallback the doc comment above
    // forbids, which is how the desktop picker could come up blank for a library
    // full of readers. It now makes the store (or says why it cannot).
    this.requireReaderStore();
    return this.allProfiles()
      .map(r => ({ id: r.id, name: r.name, hasPin: !!r.pinHash }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Credit listening seconds to a reader (same event log the analytics read). */
  recordListening(readerId: string, bookPath: string, title: string, author: string, seconds: number, id?: string): void {
    if (!readerId) return;
    this.requireReaderStore();
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    seconds = Math.min(seconds, 3600);
    if (id && this.seenEventIds.has(id)) return;
    const event: ListeningEvent = {
      readerId,
      bookKey: this.analyticsBookKey(bookPath),
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
    if (!readerId) return;
    this.requireReaderStore();
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
    if (!readerId) return;
    this.requireReaderStore();
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
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    // The store is opened here, not assumed ready at startup; a failure below is
    // a 503 with its reason, never a 401 that would sign the reader out.
    try { this.requireReaderStore(); } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unavailable' }); return;
    }
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
    try {
      const key = this.positionKeyFrom((req.query.ref as string) || '', (req.query.bookPath as string) || '');
      if (!key) { res.json({}); return; }
      res.json(this.mergeBook(key, readerId).position || {});
    } catch (err) {
      // A store we cannot read is a said failure. `{}` here would look like "you
      // have never opened this book" and restart it from zero.
      this.sendStoreReadFailure(res, 'position', err);
    }
  }

  /** One shape for "the durable store could not be read". 503 keeps the client's
   *  own cached value in play instead of overwriting it with an empty answer. */
  private sendStoreReadFailure(res: Response, what: string, err: unknown): void {
    console.error(`[BookshelfServer] ${what} read failed:`, err);
    res.status(503).json({
      error: err instanceof Error ? err.message : `the ${what} store could not be read`,
    });
  }

  // ── Listened coverage (per reader; unioned across devices; reset tombstones) ──
  private async postHeard(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    // The store is opened here, not assumed ready at startup; a failure below is
    // a 503 with its reason, never a 401 that would sign the reader out.
    try { this.requireReaderStore(); } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unavailable' }); return;
    }
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
    try {
      const key = this.positionKeyFrom((req.query.ref as string) || '', (req.query.bookPath as string) || '');
      if (!key) { res.json({ intervals: [], resetAt: null }); return; }
      // resetAt (the merged reset tombstone) lets the client discard its own local
      // cache when that cache predates a reset done on another device — so an offline
      // device rejoining after a reset can't resurrect the erased coverage.
      const merged = this.mergeBook(key, readerId);
      res.json({ intervals: merged.heard, resetAt: merged.heardResetAt || null });
    } catch (err) {
      this.sendStoreReadFailure(res, 'listened-coverage', err);
    }
  }

  // ── Bookmarks (per-device op list, compacted to latest-per-id; LWW on merge) ──
  private async postBookmark(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    // The store is opened here, not assumed ready at startup; a failure below is
    // a 503 with its reason, never a 401 that would sign the reader out.
    try { this.requireReaderStore(); } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unavailable' }); return;
    }
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
    try {
      const key = this.positionKeyFrom((req.query.ref as string) || '', (req.query.bookPath as string) || '');
      if (!key) { res.json({ bookmarks: [] }); return; }
      res.json({ bookmarks: this.mergeBook(key, readerId).bookmarks });
    } catch (err) {
      // An empty list would look like the reader deleted their bookmarks.
      this.sendStoreReadFailure(res, 'bookmarks', err);
    }
  }

  private localDateKey(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * The sign-in list. Read FRESH off the directory on every request (allProfiles
   * does a readdir per call), and the store is opened here if the server started
   * before it existed — the ordering that once handed Owen an empty picker.
   */
  private async getReaders(_req: Request, res: Response): Promise<void> {
    try {
      this.requireReaderStore();
      const readers = this.allProfiles()
        .map(r => ({ id: r.id, name: r.name, hasPin: !!r.pinHash }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      res.json({ readers });
    } catch (err) {
      // 503, not `{ readers: [] }`: the client shows "cannot reach the reader
      // store" and keeps whoever is signed in, instead of drawing an empty
      // sign-in list that reads as every account having been deleted.
      console.error('[BookshelfServer] getReaders failed:', err);
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unreadable' });
    }
  }

  private async createReader(req: Request, res: Response): Promise<void> {
    try {
      this.requireReaderStore();
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
      // 503 when the store itself is the problem, so the client says "the
      // library's reader store can't be reached" rather than "creating failed".
      res.status(this.storeReady ? 500 : 503)
        .json({ error: err instanceof Error ? err.message : 'Failed to create reader' });
    }
  }

  private async loginReader(req: Request, res: Response): Promise<void> {
    try {
      this.requireReaderStore();
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
      res.status(this.storeReady ? 500 : 503)
        .json({ error: err instanceof Error ? err.message : 'Failed to log in' });
    }
  }

  private async getMe(req: Request, res: Response): Promise<void> {
    const id = this.readerIdFromRequest(req);
    let profile: ReaderProfile | null;
    try {
      profile = id ? this.readProfile(id) : null;
    } catch (err) {
      // A 401 here signs the client out. The profile exists and could not be
      // read, so 503 is the honest answer and the session survives it.
      console.error('[BookshelfServer] getMe failed:', err);
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unreadable' });
      return;
    }
    if (!profile) { res.status(401).json({ error: 'Not signed in' }); return; }
    res.json({ reader: { id: profile.id, name: profile.name, hasPin: !!profile.pinHash } });
  }

  private async postHeartbeat(req: Request, res: Response): Promise<void> {
    const readerId = this.readerIdFromRequest(req);
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    // The store is opened here, not assumed ready at startup; a failure below is
    // a 503 with its reason, never a 401 that would sign the reader out.
    try { this.requireReaderStore(); } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unavailable' }); return;
    }
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
        bookKey: this.analyticsBookKey(bookPath),
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
    if (!readerId) { res.status(401).json({ error: 'Not signed in' }); return; }
    // The store is opened here, not assumed ready at startup; a failure below is
    // a 503 with its reason, never a 401 that would sign the reader out.
    try { this.requireReaderStore(); } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unavailable' }); return;
    }
    try {
      const bookKey = (req.body?.bookKey || '').toString();
      if (!bookKey) { res.status(400).json({ error: 'Missing bookKey' }); return; }
      const tombstone: ListeningEvent = {
        readerId,
        // Canonicalized so a tombstone from a client still holding the old
        // path-form key erases the book the reader actually pointed at.
        bookKey: this.analyticsKeyOf(bookKey),
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
    let profile: ReaderProfile | null;
    try {
      profile = readerId ? this.readProfile(readerId) : null;
    } catch (err) {
      console.error('[BookshelfServer] analytics profile read failed:', err);
      res.status(503).json({ error: err instanceof Error ? err.message : 'reader store unreadable' });
      return;
    }
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

      // Every event's book, canonicalized. Logs written before the variant
      // anchor carry a library-relative path; logs written after carry
      // `v:<project>/<variant>`. Folding them here is what makes a book that was
      // moved into archive/ ONE row in the analytics instead of two halves.
      for (const e of events) if (e.bookKey) e.bookKey = this.analyticsKeyOf(e.bookKey);

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

  /**
   * Resolve a cover to a FILE (or, at the last rung, to bytes) plus the identity
   * that versions it. Same ladder it always was — user-editable manifest cover
   * → hash-bound sidecar → crack the m4b (self-healing the extracted art to
   * disk so the next load reads a plain file) — but it stops at the path.
   *
   * Stopping at the path is the point: `/api/cover-image` can now answer a
   * conditional request off one `stat()`, and the thumbnailer can key its cache
   * on the source's size+mtime. Reading 536 KB (the mean on Owen's library) to
   * decide it need not be sent was the old behaviour.
   *
   * Null when nothing resolves — an out-of-library path (we never read outside
   * the library) or an m4b with no embedded art.
   */
  private async resolveCoverSource(projectId?: string, downloadPath?: string): Promise<ResolvedCover | null> {
    const cacheKey = projectId || downloadPath;
    if (!cacheKey) return null;

    const cached = this.coverCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.COVER_CACHE_TTL) return cached.cover;

    let cover: ResolvedCover | null = null;

    // Prefer the accessible manifest cover (a plain image file) over cracking
    // the m4b. The request may omit projectId (external m4bs and some shelf
    // entries send only a downloadPath), so also derive the project from a
    // downloadPath that lives under the library's projects/ tree.
    const derivedProjectId = downloadPath ? this.projectIdFromPath(downloadPath) : null;
    const resolvedProjectId = projectId || derivedProjectId;

    for (const pid of [projectId, derivedProjectId]) {
      if (cover || !pid) continue;
      const file = await this.manifestCoverFile(pid);
      if (file) cover = await this.describeCoverFile(file);
    }

    // Hash-bound cover sidecar for this exact m4b — a validated plain-file read,
    // below the user-editable manifest cover but above cracking the m4b per request.
    if (!cover && downloadPath && this.isPathWithinLibrary(downloadPath) && fsSync.existsSync(downloadPath)) {
      const bound = await this.boundSidecars(downloadPath);
      if (bound.cover) cover = await this.describeCoverFile(bound.cover);
    }

    // Last resort: extract the cover embedded in the M4B file. Only for in-library
    // paths — an out-of-library downloadPath simply resolves to no cover.
    if (!cover && downloadPath && this.isPathWithinLibrary(downloadPath)) {
      const dataUrl = await this.extractAudioCover(downloadPath);
      cover = dataUrl ? this.describeCoverDataUrl(dataUrl) : null;
      // Self-heal: materialize the extracted cover as a plain file and record
      // it in the manifest, so future loads read it from disk (and it syncs to
      // other devices) via the manifest rung instead of re-cracking the m4b.
      // Best-effort and fire-and-forget — it never blocks serving the cover.
      if (dataUrl && resolvedProjectId) {
        void this.persistExtractedCover(resolvedProjectId, dataUrl);
      }
      // Also (re)generate the hash-bound sidecars for this m4b (new/re-aligned
      // book with no valid binding) so downloads get a bound cover + transcript.
      if (dataUrl) this.regenerateSidecarsLazily(downloadPath);
    }

    if (cover) {
      // Evict oldest entry if cache is at capacity. Entries are now a path + an
      // identity string rather than a megabyte of base64, so the cap is about
      // staleness, not memory.
      if (this.coverCache.size >= this.MAX_COVER_CACHE_SIZE) {
        const oldestKey = this.coverCache.keys().next().value;
        if (oldestKey !== undefined) this.coverCache.delete(oldestKey);
      }
      this.coverCache.set(cacheKey, { cover, timestamp: Date.now() });
    }
    return cover;
  }

  /** The same ladder as a base64 data URL, for /api/cover's JSON shape (which
   *  the offline downloader stores verbatim). */
  private async resolveCoverDataUrl(projectId?: string, downloadPath?: string): Promise<string | null> {
    const cover = await this.resolveCoverSource(projectId, downloadPath);
    if (!cover) return null;
    const { buffer, contentType } = await coverBytes(null, cover, null);
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  }

  /**
   * JSON cover (a data URL). Now conditional and sized like its binary sibling:
   * `?w=` picks a thumbnail, `If-None-Match` gets a 304. The offline downloader
   * asks for no width and gets the original, which is what it wants to keep.
   */
  private async getCover(req: Request, res: Response): Promise<void> {
    try {
      const projectId = req.query.projectId as string;
      const downloadPath = req.query.downloadPath as string;
      if (!projectId && !downloadPath) {
        res.status(400).json({ error: 'Missing projectId or downloadPath parameter' });
        return;
      }
      const width = parseThumbnailWidth(req.query.w);
      if (width === undefined) { res.status(400).json({ error: this.badWidthMessage() }); return; }

      const cover = await this.resolveCoverSource(projectId, downloadPath);
      if (!cover) { res.json({ cover: null }); return; }

      // The `j` distinguishes this endpoint's base64 body from the binary one's
      // bytes: same image, different representation, so they must not share a tag.
      const etag = coverEtag(`${cover.identity}|json`, width);
      if (etagMatches(req.headers['if-none-match'], etag)) { this.sendCoverValidators(res, etag); res.status(304).end(); return; }
      const { buffer, contentType } = await coverBytes(this.thumbnailCacheDir(), cover, width);
      this.sendCoverValidators(res, etag);
      res.json({ cover: `data:${contentType};base64,${buffer.toString('base64')}` });
    } catch (err) {
      console.error('[BookshelfServer] Error getting cover:', err);
      res.status(500).json({ error: 'Failed to get cover' });
    }
  }

  /** Binary cover: streams the actual image bytes so a plain <img src> renders
   *  and browser-caches it natively — no base64-through-JSON round-trip, no giant
   *  string to stuff into a JS Map or evict into a broken image.
   *
   *  `?w=<240|480|960>` serves a cached thumbnail; no `w` serves the original, so
   *  the shelf's fifty tiles cost tens of KB each while the player's full-bleed
   *  cover is still the real art. The ETag is computed from the SOURCE's identity
   *  before any image byte is read, so a repeat visit costs one `stat` and a 304.
   *  404 (not an empty 200) when there's no cover, so the client's <img (error)>
   *  falls back to the placeholder. */
  private async getCoverImage(req: Request, res: Response): Promise<void> {
    try {
      const projectId = req.query.projectId as string;
      const downloadPath = req.query.downloadPath as string;
      if (!projectId && !downloadPath) { res.status(400).end(); return; }
      const width = parseThumbnailWidth(req.query.w);
      if (width === undefined) { res.status(400).json({ error: this.badWidthMessage() }); return; }

      const cover = await this.resolveCoverSource(projectId, downloadPath);
      if (!cover) { res.status(404).end(); return; }

      const etag = coverEtag(cover.identity, width);
      if (etagMatches(req.headers['if-none-match'], etag)) { this.sendCoverValidators(res, etag); res.status(304).end(); return; }

      const { buffer, contentType } = await coverBytes(this.thumbnailCacheDir(), cover, width);
      this.sendCoverValidators(res, etag);
      res.setHeader('Content-Type', contentType);
      res.end(buffer);
    } catch (err) {
      console.error('[BookshelfServer] Error getting cover image:', err);
      if (!res.headersSent) res.status(500).end();
    }
  }

  /** ETag + Cache-Control, on the 200 and on the 304 alike (a 304 that omits the
   *  validator makes some caches drop the entry and re-download next time). */
  private sendCoverValidators(res: Response, etag: string): void {
    res.setHeader('ETag', etag);
    // A day, revalidated: the ETag is derived from the source's mtime, so a
    // re-saved cover changes the tag and the phone picks it up on the next
    // revalidation rather than being stuck with the old art for the full max-age.
    res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
  }

  private badWidthMessage(): string {
    return `w must be one of ${ALLOWED_THUMBNAIL_WIDTHS.join(', ')} — or be omitted for the full-size cover.`;
  }

  /** Where generated thumbnails live. Null when the server was started without a
   *  userData path: thumbnails are still generated, they just aren't kept. */
  private thumbnailCacheDir(): string | null {
    return this.userDataPath ? path.join(this.userDataPath, 'bookshelf-thumbnails') : null;
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

      const analysisToken = typeof req.query.analysisToken === 'string' ? req.query.analysisToken : '';
      let pinned: AnalysisStreamSession | undefined;
      let stats: fsSync.Stats;
      try {
        if (analysisToken) {
          pinned = await this.pinAnalysisStreamSession(analysisToken, filePath);
          stats = await pinned.handle!.stat() as fsSync.Stats;
          const verified = pinned.verifiedStat!;
          if (stats.dev !== verified.dev || stats.ino !== verified.ino || stats.size !== verified.size
            || stats.mtimeMs !== verified.mtimeMs || stats.ctimeMs !== verified.ctimeMs) {
            await this.disposeAnalysisStreamSession(pinned);
            this.analysisStreamSessions.delete(analysisToken);
            throw new Error('Pinned audiobook changed during playback');
          }
        } else {
          stats = fsSync.statSync(filePath);
        }
      } catch {
        res.status(analysisToken ? 409 : 404).json({
          error: analysisToken ? 'Audiobook no longer matches verified analysis' : 'File not found',
        });
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

      const pipeAudio = (stream: fsSync.ReadStream) => {
        if (pinned) {
          pinned.activeStreams++;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            pinned!.activeStreams = Math.max(0, pinned!.activeStreams - 1);
            pinned!.lastUsedAt = Date.now();
          };
          res.once('finish', release);
          res.once('close', release);
        }
        stream.pipe(res);
      };

      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match || (!match[1] && !match[2])) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
          return;
        }
        let start: number;
        let end: number;
        if (!match[1]) {
          const suffixLength = Number(match[2]);
          if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
            return;
          }
          start = Math.max(0, fileSize - suffixLength);
          end = fileSize - 1;
        } else {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start < 0 || start >= fileSize || end < start) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
          return;
        }
        const chunkSize = end - start + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', contentType);

        const stream = pinned
          ? fsSync.createReadStream(filePath, { fd: pinned.handle!.fd, autoClose: false, start, end })
          : fsSync.createReadStream(filePath, { start, end });
        pipeAudio(stream);
      } else {
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');

        const stream = pinned
          ? fsSync.createReadStream(filePath, { fd: pinned.handle!.fd, autoClose: false, start: 0 })
          : fsSync.createReadStream(filePath);
        pipeAudio(stream);
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

      const projectId = projectIdOfEntry(relativePath);
      if (!projectId) {
        res.status(400).json({ error: `Not a library ebook address: ${relativePath}` });
        return;
      }
      const width = parseThumbnailWidth(req.query.w);
      if (width === undefined) { res.status(400).json({ error: this.badWidthMessage() }); return; }

      const cover = await this.resolveEbookCoverSource(projectId, relativePath);
      if (!cover) { res.json({ cover: null }); return; }

      const etag = coverEtag(`${cover.identity}|json`, width);
      if (etagMatches(req.headers['if-none-match'], etag)) { this.sendCoverValidators(res, etag); res.status(304).end(); return; }
      const { buffer, contentType } = await coverBytes(this.thumbnailCacheDir(), cover, width);
      this.sendCoverValidators(res, etag);
      res.json({ cover: `data:${contentType};base64,${buffer.toString('base64')}` });
    } catch (err) {
      console.error('[BookshelfServer] Error getting ebook cover:', err);
      res.status(500).json({ error: 'Failed to get ebook cover' });
    }
  }

  /**
   * Cover for a reading edition, on the same project-native ladder the audiobook
   * covers use: the project's manifest cover (a plain image under media/, user
   * editable and synced) first, and only if there is none, crack the ebook file
   * with Calibre and self-heal the result back into the manifest so the next load
   * is a plain file read. Null means the book genuinely has no art.
   *
   * Deliberately NOT a sidecar cache of its own — the retired ebooks/.cache/covers
   * folder was a second place a cover could live and disagree from.
   */
  private async resolveEbookCoverSource(projectId: string, relativePath: string): Promise<ResolvedCover | null> {
    const cacheKey = `ebook:${relativePath}`;
    const cached = this.coverCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.COVER_CACHE_TTL) return cached.cover;

    const manifestFile = await this.manifestCoverFile(projectId);
    let cover: ResolvedCover | null = manifestFile ? await this.describeCoverFile(manifestFile) : null;

    if (!cover) {
      const absolutePath = getAbsolutePath(relativePath);
      if (fsSync.existsSync(absolutePath)) {
        const tmpOut = path.join(os.tmpdir(), `bookforge-ebook-cover-${crypto.randomBytes(6).toString('hex')}.jpg`);
        let dataUrl: string | null = null;
        try {
          if (await extractCover(absolutePath, tmpOut)) dataUrl = await this.coverFileToDataUrl(tmpOut);
        } finally {
          fs.unlink(tmpOut).catch(() => {});
        }
        // The temp file is already gone, so this rung yields BYTES; the
        // self-heal below turns the next request's answer back into a file.
        if (dataUrl) {
          cover = this.describeCoverDataUrl(dataUrl);
          void this.persistExtractedCover(projectId, dataUrl);
        }
      }
    }

    if (cover) {
      if (this.coverCache.size >= this.MAX_COVER_CACHE_SIZE) {
        const oldestKey = this.coverCache.keys().next().value;
        if (oldestKey !== undefined) this.coverCache.delete(oldestKey);
      }
      this.coverCache.set(cacheKey, { cover, timestamp: Date.now() });
    }
    return cover;
  }

  private async downloadEbook(req: Request, res: Response): Promise<void> {
    try {
      const relativePath = req.query.path as string;
      if (!relativePath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      if (!isArchiveEntry(relativePath)) {
        res.status(400).json({ error: `Not a library ebook address: ${relativePath}` });
        return;
      }

      // __archive__/<projectId>/<file> → the project's archive/ folder.
      const absolutePath = path.resolve(getAbsolutePath(relativePath));

      // Security: must stay within the projects root.
      if (!absolutePath.startsWith(path.resolve(getProjectsPath()))) {
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
  //   e:<relativePath>  → one Ebooks-tab entry, i.e. __archive__/<projectId>/<file>
  //                       (a specific edition, where `p:` takes the project's default)
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
   * Resolve an Ebooks-tab entry: an `__archive__/<projectId>/<file>` address that
   * maps to that project's archive/ folder. Guards traversal by requiring the
   * resolved path to stay within the projects root.
   */
  private resolveEbookFile(relativePath: string): { absolutePath: string; ext: string; filename: string } | null {
    if (!relativePath || relativePath.includes('..') || !isArchiveEntry(relativePath)) return null;
    const absolutePath = path.resolve(getAbsolutePath(relativePath));
    if (!absolutePath.startsWith(path.resolve(getProjectsPath()))) return null;
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

  /**
   * The queue, ASKED rather than read off the disk.
   *
   * This used to parse `userData/queue.json` — the renderer's persisted blob,
   * written on a ~500 ms debounce. A phone watching the shelf therefore saw a
   * queue up to half a second stale on a good day and arbitrarily stale on a bad
   * one (the file is only written when the renderer is alive to write it), and a
   * queue that had never been saved read as empty. The engine runs in THIS
   * process; the answer is simply available.
   *
   * The wire shape is unchanged for the web UI: one row per STEP, plus the run's
   * own row where a run has more than one step, exactly as the master/child list
   * looked. Absolute paths are still stripped — this is served over the tailnet.
   */
  private async getQueue(_req: Request, res: Response): Promise<void> {
    try {
      const engine = await import('./queue-engine.js');
      const { jobStatus, jobPercent } = await import('../shared/queue/engine-types.js');
      const snapshot = engine.snapshot();

      const legacyStatus = (
        step: { status: string; wasInterrupted?: boolean },
      ): string => {
        switch (step.status) {
          case 'running': return 'processing';
          case 'done': return 'complete';
          case 'failed': case 'cancelled': return 'error';
          case 'held': return step.wasInterrupted ? 'stopped' : 'pending';
          default: return 'pending';
        }
      };

      const rows: unknown[] = [];
      let currentJobId: string | null = null;
      for (const job of snapshot.jobs) {
        const multi = job.steps.length > 1;
        if (multi) {
          rows.push({
            id: job.id,
            type: 'audiobook',
            status: legacyStatus({ status: jobStatus(job) }),
            progress: jobPercent(job),
            progressMessage: null,
            title: job.title,
            author: null,
            epubFilename: job.documentLabel ?? null,
            addedAt: job.createdAt,
            startedAt: job.startedAt ?? null,
            completedAt: job.finishedAt ?? null,
            error: null,
            ttsPhase: null, ttsConversionProgress: null,
            assemblyProgress: null, assemblySubPhase: null,
            estimatedSecondsRemaining: null, parallelWorkers: null,
            parentJobId: null, workflowId: job.id,
            currentChunk: null, totalChunks: null,
            currentChapter: null, totalChapters: null,
          });
        }
        for (const step of job.steps) {
          if (step.status === 'running') currentJobId = step.id;
          rows.push({
            id: step.id,
            type: step.type,
            status: legacyStatus(step),
            progress: step.progress.percent ?? 0,
            progressMessage: step.progress.message ?? null,
            title: step.label,
            author: null,
            epubFilename: job.documentLabel ?? null,
            addedAt: step.addedAt,
            startedAt: step.startedAt ?? null,
            completedAt: step.finishedAt ?? null,
            error: step.error ?? null,
            ttsPhase: step.metrics.ttsPhase ?? null,
            ttsConversionProgress: step.metrics.ttsConversionProgress ?? null,
            assemblyProgress: step.metrics.assemblyProgress ?? null,
            assemblySubPhase: step.metrics.assemblySubPhase ?? null,
            estimatedSecondsRemaining: null,
            parallelWorkers: step.metrics.parallelWorkers
              ? step.metrics.parallelWorkers.map((w) => ({
                  id: w.id,
                  completedSentences: w.completedSentences,
                  status: w.status,
                  totalAssigned: w.totalAssigned,
                }))
              : null,
            parentJobId: multi ? job.id : null,
            workflowId: multi ? job.id : null,
            currentChunk: step.metrics.currentChunk ?? null,
            totalChunks: step.metrics.totalChunks ?? null,
            currentChapter: step.metrics.currentChapter ?? null,
            totalChapters: step.metrics.totalChapters ?? null,
          });
        }
      }

      res.json({ jobs: rows, isRunning: snapshot.running, currentJobId });
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

  /**
   * The engine's own snapshot, so the web queue page draws the bench with the
   * same pure functions the desktop page draws it with (shared/queue/bench.ts).
   *
   * `now` travels with it because the page's clock is a phone's, and half the
   * bench's vocabulary is elapsed time. A batch that started 13 minutes ago on
   * THIS machine reads as 4 hours on a phone whose clock drifted, and the reader
   * has no way to tell which number lied.
   *
   * Each step's `config` is the one thing dropped. It is the job type's verbatim
   * configuration and carries credentials — `claudeApiKey` / `openaiApiKey` live
   * there (see queue-steps/ai-provider.ts) — and nothing on the page reads it:
   * no function in bench.ts touches `config`. Serving it would put an API key on
   * the wire to satisfy nobody.
   *
   * In-memory only, on purpose: this server shares the desktop app's main
   * thread, so a handler that walked disk or read covers here would freeze the
   * UI of the machine doing the rendering. Covers come from the cover routes.
   */
  private async getQueueSnapshot(_req: Request, res: Response): Promise<void> {
    try {
      const engine = await import('./queue-engine.js');
      const snapshot = engine.snapshot();
      res.json({
        snapshot: {
          ...snapshot,
          jobs: snapshot.jobs.map((job) => ({
            ...job,
            steps: job.steps.map((step) => {
              const { config: _config, ...rest } = step;
              return rest;
            }),
          })),
        },
        now: Date.now(),
      });
    } catch (err) {
      console.error('[BookshelfServer] Error reading the queue snapshot:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'could not read the queue' });
    }
  }

  /**
   * The step or the run a control names, or null when the body names neither.
   *
   * Null is refused by the caller rather than widened into "everything": a body
   * that arrived without its id is a bug on the wire, and the gesture a guess
   * would perform here is the one nothing can undo.
   */
  private queueTargetOf(body: unknown): { jobId?: string; stepId?: string } | null {
    const b = (body ?? {}) as { jobId?: unknown; stepId?: unknown };
    const stepId = typeof b.stepId === 'string' && b.stepId.trim() !== '' ? b.stepId : undefined;
    const jobId = typeof b.jobId === 'string' && b.jobId.trim() !== '' ? b.jobId : undefined;
    if (stepId === undefined && jobId === undefined) return null;
    return {
      ...(jobId === undefined ? {} : { jobId }),
      ...(stepId === undefined ? {} : { stepId }),
    };
  }

  /**
   * The engine's refusals are whole sentences aimed at the user ('There is no
   * step "x" in the queue.'), so they are the response body verbatim. 400
   * because every one of them is the client naming something that isn't there.
   */
  private queueActionFailed(res: Response, err: unknown): void {
    console.error('[BookshelfServer] Queue control refused:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  private async postQueueCancel(req: Request, res: Response): Promise<void> {
    const target = this.queueTargetOf(req.body);
    if (!target) {
      res.status(400).json({ error: 'Say which step or which run to stop — this named neither.' });
      return;
    }
    try {
      const engine = await import('./queue-engine.js');
      await engine.cancel(target);
      res.json({ success: true });
    } catch (err) {
      this.queueActionFailed(res, err);
    }
  }

  private async postQueueRemove(req: Request, res: Response): Promise<void> {
    const target = this.queueTargetOf(req.body);
    if (!target?.jobId) {
      res.status(400).json({ error: 'Say which run to remove — removal takes a jobId.' });
      return;
    }
    try {
      const engine = await import('./queue-engine.js');
      await engine.remove(target.jobId);
      res.json({ success: true });
    } catch (err) {
      this.queueActionFailed(res, err);
    }
  }

  private async postQueueRetry(req: Request, res: Response): Promise<void> {
    const target = this.queueTargetOf(req.body);
    if (!target) {
      res.status(400).json({ error: 'Say which step or which run to retry — this named neither.' });
      return;
    }
    try {
      const engine = await import('./queue-engine.js');
      engine.retry(target);
      res.json({ success: true });
    } catch (err) {
      this.queueActionFailed(res, err);
    }
  }

  private async postQueueClearFinished(_req: Request, res: Response): Promise<void> {
    try {
      const engine = await import('./queue-engine.js');
      engine.clearFinished();
      res.json({ success: true });
    } catch (err) {
      this.queueActionFailed(res, err);
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

    return false;
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
   * the manifest rung instead of re-parsing the m4b (and it syncs to other
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

      // Point the manifest at the file so the manifest rung serves it next time.
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

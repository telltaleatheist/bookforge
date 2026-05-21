/**
 * Library Server - HTTP server for browsing and downloading audiobooks from the network
 *
 * Discovers audiobooks from BookForge manifest data (not flat file scanning).
 * Provides a mobile-friendly web interface for accessing audiobooks
 * from any device on the local network.
 */

import express, { Request, Response, Application } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';

import { listProjects, getProjectPath, getLibraryBasePath, getProjectsPath } from './manifest-service';
import { scanLibrary, getCoverData, getEbooksRoot } from './ebook-library';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LibraryServerConfig {
  port: number;
  userDataPath?: string;
}

export interface LibraryServerStatus {
  running: boolean;
  port: number;
  addresses: string[];
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Library Server Class
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

export class LibraryServer {
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

  // Queue control callback (set by main process to bridge to renderer)
  private queueControlHandler: ((action: 'start' | 'pause') => void) | null = null;

  constructor() {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const uiPath = path.join(__dirname, 'library-ui');
    console.log('[LibraryServer] UI path:', uiPath);

    // CORS preflight for audio streaming
    this.app.options('/api/audio', (_req: Request, res: Response) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      res.status(204).end();
    });

    // API Routes
    this.app.get('/api/books', this.getBooks.bind(this));
    this.app.get('/api/cover', this.getCover.bind(this));
    this.app.get('/api/download', this.downloadFile.bind(this));
    this.app.get('/api/audio', this.streamAudio.bind(this));

    this.app.get('/api/tags', this.getTags.bind(this));

    // Ebook Library Routes
    this.app.get('/api/ebooks', this.getEbooks.bind(this));
    this.app.get('/api/ebook-cover', this.getEbookCover.bind(this));
    this.app.get('/api/ebook-download', this.downloadEbook.bind(this));

    // Queue status & control
    this.app.get('/api/queue', this.getQueue.bind(this));
    this.app.post('/api/queue/start', this.startQueue.bind(this));
    this.app.post('/api/queue/pause', this.pauseQueue.bind(this));

    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    // Serve static files at root (simpler setup)
    this.app.use(express.static(uiPath, { index: 'index.html' }));

    // Fallback to index.html for SPA routing (Express 5 syntax)
    this.app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(uiPath, 'index.html'));
    });
  }

  async start(config: LibraryServerConfig): Promise<void> {
    this.port = config.port;
    if (config.userDataPath) {
      this.userDataPath = config.userDataPath;
    }

    // Load persistent duration cache
    await this.loadDurationCache();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`[LibraryServer] Started on port ${this.port}`);
        resolve();
      });

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
      console.log(`[LibraryServer] Loaded duration cache (${this.durationCache.size} entries)`);
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
      console.error('[LibraryServer] Failed to save duration cache:', err);
    }
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[LibraryServer] Stopped');
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

  getStatus(): LibraryServerStatus {
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

      // Resolve cover image absolute path
      let coverAbsPath: string | undefined;
      if (manifest.metadata.coverPath) {
        const candidatePath = path.join(getLibraryBasePath(), manifest.metadata.coverPath);
        if (fsSync.existsSync(candidatePath)) {
          coverAbsPath = candidatePath;
        }
      }

      // Check standard audiobook output
      if (manifest.outputs?.audiobook?.path) {
        const absPath = path.join(projectDir, manifest.outputs.audiobook.path);
        if (fsSync.existsSync(absPath)) {
          try {
            const stats = fsSync.statSync(absPath);
            entries.push({
              projectId: manifest.projectId,
              title: manifest.metadata.title || manifest.projectId,
              author: manifest.metadata.author || '',
              type: 'audiobook',
              size: stats.size,
              downloadPath: absPath,
              outputFilename: manifest.metadata.outputFilename,
              coverPath: coverAbsPath,
              dateAdded: manifest.outputs.audiobook.completedAt || new Date(stats.mtimeMs).toISOString(),
              tags: manifest.metadata.tags || [],
            });
          } catch { /* skip if stat fails */ }
        }
      }

      // Check bilingual audiobook outputs
      if (manifest.outputs?.bilingualAudiobooks) {
        for (const [langPair, output] of Object.entries(manifest.outputs.bilingualAudiobooks)) {
          if (!output?.path) continue;
          const absPath = path.join(projectDir, output.path);
          if (!fsSync.existsSync(absPath)) continue;
          try {
            const stats = fsSync.statSync(absPath);
            entries.push({
              projectId: manifest.projectId,
              title: manifest.metadata.title || manifest.projectId,
              author: manifest.metadata.author || '',
              type: 'bilingual',
              langPair,
              size: stats.size,
              downloadPath: absPath,
              coverPath: coverAbsPath,
              dateAdded: (output as any).completedAt || new Date(stats.mtimeMs).toISOString(),
              tags: manifest.metadata.tags || [],
            });
          } catch { /* skip */ }
        }
      }
    }

    // Phase 2: Fetch all durations in parallel (with persistent cache)
    await Promise.all(entries.map(async (entry) => {
      entry.duration = await this.getAudioDuration(entry.downloadPath);
    }));

    // Persist any new cache entries to disk
    await this.saveDurationCache();

    return entries;
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

      const entries = await this.getAudiobookProjects();
      this.booksCache = { data: entries, timestamp: Date.now() };
      res.json({ books: entries });
    } catch (err) {
      console.error('[LibraryServer] Error getting books:', err);
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
      console.error('[LibraryServer] Error getting tags:', err);
      res.status(500).json({ error: 'Failed to get tags' });
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

      // Try manifest cover image first (if projectId provided)
      if (projectId) {
        cover = await this.loadManifestCover(projectId);
      }

      // Fall back to extracting cover from the M4B file
      if (!cover && downloadPath) {
        if (!this.isPathWithinLibrary(downloadPath)) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
        cover = await this.extractAudioCover(downloadPath);
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
      console.error('[LibraryServer] Error getting cover:', err);
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
      console.error('[LibraryServer] Error downloading file:', err);
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

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');

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
      console.error('[LibraryServer] Error streaming audio:', err);
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
      this.ebooksCache = { data: books, timestamp: Date.now() };
      res.json({ ebooks: books });
    } catch (err) {
      console.error('[LibraryServer] Error getting ebooks:', err);
      res.status(500).json({ error: 'Failed to get ebooks' });
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
      console.error('[LibraryServer] Error getting ebook cover:', err);
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

      const ebooksRoot = getEbooksRoot();
      const absolutePath = path.join(ebooksRoot, relativePath);

      // Security: verify path is within ebooks directory
      const resolved = path.resolve(absolutePath);
      if (!resolved.startsWith(path.resolve(ebooksRoot))) {
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
      console.error('[LibraryServer] Error downloading ebook:', err);
      res.status(500).json({ error: 'Failed to download ebook' });
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
      console.error('[LibraryServer] Error reading queue:', err);
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
    return resolved.startsWith(projectsDir) || resolved.startsWith(libraryDir);
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
      console.error('[LibraryServer] Error loading manifest cover:', err);
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
    } catch (err) {
      console.error('[LibraryServer] Error extracting audio cover:', err);
    }
    return null;
  }
}

// Export singleton instance
export const libraryServer = new LibraryServer();

/**
 * Library Server - HTTP server for browsing and downloading books from the network
 *
 * Provides a mobile-friendly web interface for accessing the book library
 * from any device on the local network.
 */

import express, { Request, Response, Application } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';

// Import from epub-processor for cover extraction
import { EpubProcessor } from './epub-processor';
import { pdfAnalyzer } from './pdf-analyzer';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LibraryServerConfig {
  booksPath: string;
  port: number;
}

export interface LibraryServerStatus {
  running: boolean;
  port: number;
  addresses: string[];
  booksPath: string;
}

interface BookInfo {
  path: string;
  filename: string;
  title: string;
  author: string;
  type: 'epub' | 'pdf' | 'm4b' | 'unknown';
  size: number;
  modifiedAt: string;
}

interface SectionInfo {
  name: string;
  path: string;
  bookCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Library Server Class
// ─────────────────────────────────────────────────────────────────────────────

export class LibraryServer {
  private app: Application;
  private server: http.Server | null = null;
  private booksPath: string;
  private port: number = 8765;

  // Cover cache to avoid repeated extraction
  private coverCache: Map<string, { data: string; timestamp: number }> = new Map();
  private readonly COVER_CACHE_TTL = 1000 * 60 * 60; // 1 hour

  constructor() {
    this.app = express();
    this.booksPath = '';
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const uiPath = path.join(__dirname, 'library-ui');
    console.log('[LibraryServer] UI path:', uiPath);

    // API Routes
    this.app.get('/api/sections', this.getSections.bind(this));
    this.app.get('/api/books/:section', this.getBooks.bind(this));
    this.app.get('/api/cover', this.getCover.bind(this));
    this.app.get('/api/download', this.downloadFile.bind(this));
    this.app.get('/api/audio', this.streamAudio.bind(this));

    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', booksPath: this.booksPath });
    });

    // Serve static files at root (simpler setup)
    this.app.use(express.static(uiPath, { index: 'index.html' }));

    // Fallback to index.html for SPA routing (Express 5 syntax)
    this.app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(uiPath, 'index.html'));
    });
  }

  async start(config: LibraryServerConfig): Promise<void> {
    this.booksPath = config.booksPath;
    this.port = config.port;

    // Verify books path exists
    try {
      const stats = await fs.stat(this.booksPath);
      if (!stats.isDirectory()) {
        throw new Error('Books path is not a directory');
      }
    } catch (err) {
      throw new Error(`Invalid books path: ${this.booksPath}`);
    }

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        console.log(`[LibraryServer] Started on port ${this.port}`);
        console.log(`[LibraryServer] Books path: ${this.booksPath}`);
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
      booksPath: this.booksPath
    };
  }

  private getNetworkAddresses(): string[] {
    const addresses: string[] = [];
    const interfaces = os.networkInterfaces();

    for (const [, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      for (const net of nets) {
        // Skip internal (loopback) addresses
        if (net.internal) continue;
        // Only IPv4 addresses
        if (net.family === 'IPv4') {
          addresses.push(`http://${net.address}:${this.port}`);
        }
      }
    }

    // Also add hostname
    const hostname = os.hostname();
    addresses.push(`http://${hostname}:${this.port}`);

    return addresses;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // API Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async getSections(_req: Request, res: Response): Promise<void> {
    try {
      const sections: SectionInfo[] = [];

      // Recursively find all directories with books
      await this.collectSections(this.booksPath, '', sections);

      // Check for files at the root level
      const entries = await fs.readdir(this.booksPath, { withFileTypes: true });
      const files = entries.filter(e => e.isFile() && this.isBookFile(e.name));

      // If there are files at the root level, add a "Root" section
      if (files.length > 0) {
        sections.unshift({
          name: 'Books',
          path: '.',
          bookCount: files.length
        });
      }

      // Sort sections: "Books" first, then "audiobooks", then "xtts conversions", then alphabetically
      sections.sort((a, b) => {
        const order = (s: SectionInfo) => {
          const name = s.name.toLowerCase();
          if (s.path === '.') return 0;  // "Books" (root) first
          if (name === 'audiobooks') return 1;
          if (name === 'xtts conversions') return 2;
          return 3;  // Everything else
        };
        const orderA = order(a);
        const orderB = order(b);
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });

      res.json({ sections });
    } catch (err) {
      console.error('[LibraryServer] Error getting sections:', err);
      res.status(500).json({ error: 'Failed to get sections' });
    }
  }

  /**
   * Recursively collect all directories that contain books as sections
   */
  private async collectSections(basePath: string, relativePath: string, sections: SectionInfo[]): Promise<void> {
    try {
      const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
      const entries = await fs.readdir(fullPath, { withFileTypes: true });

      // Find directories (exclude hidden and vtt)
      const directories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'vtt');

      for (const dir of directories) {
        const dirRelPath = relativePath ? `${relativePath}/${dir.name}` : dir.name;
        const dirFullPath = path.join(basePath, dirRelPath);

        // Count books directly in this folder
        const bookCount = await this.countBooksInFolder(dirFullPath);

        // Add as section if it has books
        if (bookCount > 0) {
          sections.push({
            name: dir.name,
            path: dirRelPath,
            bookCount
          });
        }

        // Recursively check subdirectories
        await this.collectSections(basePath, dirRelPath, sections);
      }
    } catch (err) {
      console.error('[LibraryServer] Error collecting sections:', err);
    }
  }

  private async getBooks(req: Request, res: Response): Promise<void> {
    try {
      const sectionParam = req.params.section;
      if (typeof sectionParam !== 'string') {
        res.status(400).json({ error: 'Invalid section parameter' });
        return;
      }
      const section = decodeURIComponent(sectionParam);

      // Security: prevent directory traversal
      if (section.includes('..')) {
        res.status(400).json({ error: 'Invalid section path' });
        return;
      }

      const sectionPath = section === '.'
        ? this.booksPath
        : path.join(this.booksPath, section);

      // Verify path is within books directory
      const resolvedPath = path.resolve(sectionPath);
      if (!resolvedPath.startsWith(path.resolve(this.booksPath))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const books = await this.getBooksInFolder(sectionPath);

      res.json({ books });
    } catch (err) {
      console.error('[LibraryServer] Error getting books:', err);
      res.status(500).json({ error: 'Failed to get books' });
    }
  }

  private async getCover(req: Request, res: Response): Promise<void> {
    try {
      const bookPath = req.query.path as string;
      if (!bookPath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      // Security: prevent directory traversal
      if (bookPath.includes('..')) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      const fullPath = path.join(this.booksPath, bookPath);

      // Verify path is within books directory
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(this.booksPath))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Check cache
      const cached = this.coverCache.get(fullPath);
      if (cached && Date.now() - cached.timestamp < this.COVER_CACHE_TTL) {
        res.json({ cover: cached.data });
        return;
      }

      const cover = await this.extractCover(fullPath);
      if (cover) {
        // Cache the result
        this.coverCache.set(fullPath, { data: cover, timestamp: Date.now() });
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
      const bookPath = req.query.path as string;
      if (!bookPath) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      // Security: prevent directory traversal
      if (bookPath.includes('..')) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      const fullPath = path.join(this.booksPath, bookPath);

      // Verify path is within books directory
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(this.booksPath))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // Check file exists
      try {
        await fs.access(fullPath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const filename = path.basename(fullPath);
      const ext = path.extname(fullPath).toLowerCase();

      // Set content type based on extension
      const contentTypes: Record<string, string> = {
        '.epub': 'application/epub+zip',
        '.pdf': 'application/pdf',
        '.m4b': 'audio/mp4',
        '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg'
      };

      const contentType = contentTypes[ext] || 'application/octet-stream';

      // Get file size for Content-Length
      const stats = await fs.stat(fullPath);

      // Create ASCII-safe filename fallback and RFC 5987 encoded filename
      const safeFilename = filename.replace(/[^\x20-\x7E]/g, '_');
      const encodedFilename = encodeURIComponent(filename).replace(/'/g, '%27');

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stats.size);
      // Use both filename (ASCII fallback) and filename* (UTF-8) for maximum compatibility
      res.setHeader('Content-Disposition',
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);

      const fileStream = fsSync.createReadStream(fullPath);
      fileStream.pipe(res);
    } catch (err) {
      console.error('[LibraryServer] Error downloading file:', err);
      res.status(500).json({ error: 'Failed to download file' });
    }
  }

  /**
   * Stream audio files with Range header support for seeking
   * Accepts absolute paths (for local playback only)
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

      // Security: only allow absolute paths starting with /Volumes (Mac) or drive letter (Windows)
      const isValidPath = filePath.startsWith('/Volumes/') ||
                          filePath.startsWith('/Users/') ||
                          /^[A-Z]:\\/i.test(filePath);
      if (!isValidPath) {
        res.status(403).json({ error: 'Invalid path' });
        return;
      }

      // Check file exists
      let stats: fsSync.Stats;
      try {
        stats = fsSync.statSync(filePath);
      } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const fileSize = stats.size;

      // Content type based on extension
      const contentTypes: Record<string, string> = {
        '.m4b': 'audio/mp4',
        '.m4a': 'audio/mp4',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.flac': 'audio/flac',
        '.ogg': 'audio/ogg'
      };
      const contentType = contentTypes[ext] || 'audio/mp4';

      // Parse Range header for seeking support
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
        // No range - send entire file
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
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  private isBookFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.epub', '.pdf', '.m4b', '.m4a'].includes(ext);
  }

  private async countBooksInFolder(folderPath: string): Promise<number> {
    try {
      const entries = await fs.readdir(folderPath, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (entry.isFile() && this.isBookFile(entry.name)) {
          count++;
        }
        // Don't recurse - subdirectories are separate sections
      }

      return count;
    } catch {
      return 0;
    }
  }

  private async getBooksInFolder(folderPath: string, relativePath: string = ''): Promise<BookInfo[]> {
    const books: BookInfo[] = [];

    try {
      const entries = await fs.readdir(folderPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden files/folders and the vtt folder
        if (entry.name.startsWith('.') || entry.name === 'vtt') continue;

        const entryPath = path.join(folderPath, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.isFile() && this.isBookFile(entry.name)) {
          const stats = await fs.stat(entryPath);
          const ext = path.extname(entry.name).toLowerCase();

          books.push({
            path: relPath,
            filename: entry.name,
            title: this.extractTitleFromFilename(entry.name),
            author: '',
            type: this.getBookType(ext),
            size: stats.size,
            modifiedAt: stats.mtime.toISOString()
          });
        }
        // Don't recurse into subdirectories - they appear as separate sections
      }
    } catch (err) {
      console.error('[LibraryServer] Error reading folder:', folderPath, err);
    }

    // Sort by title
    books.sort((a, b) => a.title.localeCompare(b.title));

    return books;
  }

  private extractTitleFromFilename(filename: string): string {
    // Remove extension
    let title = path.basename(filename, path.extname(filename));

    // Replace underscores and hyphens with spaces
    title = title.replace(/[_-]/g, ' ');

    // Remove common suffixes like (1), [copy], etc.
    title = title.replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, '');

    return title.trim();
  }

  private getBookType(ext: string): 'epub' | 'pdf' | 'm4b' | 'unknown' {
    switch (ext) {
      case '.epub': return 'epub';
      case '.pdf': return 'pdf';
      case '.m4b':
      case '.m4a': return 'm4b';
      default: return 'unknown';
    }
  }

  private async extractCover(filePath: string): Promise<string | null> {
    const ext = path.extname(filePath).toLowerCase();

    try {
      switch (ext) {
        case '.epub':
          return await this.extractEpubCover(filePath);
        case '.pdf':
          return await this.extractPdfCover(filePath);
        case '.m4b':
        case '.m4a':
          return await this.extractAudioCover(filePath);
        default:
          return null;
      }
    } catch (err) {
      console.error('[LibraryServer] Error extracting cover:', filePath, err);
      return null;
    }
  }

  private async extractEpubCover(filePath: string): Promise<string | null> {
    const processor = new EpubProcessor();
    try {
      await processor.open(filePath);
      const coverBuffer = await processor.getCover();
      processor.close();

      if (coverBuffer) {
        // Detect image type from magic bytes
        let mimeType = 'image/jpeg';
        if (coverBuffer[0] === 0x89 && coverBuffer[1] === 0x50) {
          mimeType = 'image/png';
        }
        return `data:${mimeType};base64,${coverBuffer.toString('base64')}`;
      }
    } catch (err) {
      console.error('[LibraryServer] Error extracting EPUB cover:', err);
    }
    return null;
  }

  private async extractPdfCover(filePath: string): Promise<string | null> {
    try {
      // Use pdfAnalyzer to render first page at low resolution as cover
      // First analyze the PDF to load it
      await pdfAnalyzer.analyze(filePath, 1);

      // Render first page at scale 0.5 for a thumbnail
      const imageBase64 = await pdfAnalyzer.renderPage(0, 0.5, filePath);
      if (imageBase64) {
        return `data:image/png;base64,${imageBase64}`;
      }
    } catch (err) {
      console.error('[LibraryServer] Error extracting PDF cover:', err);
    }
    return null;
  }

  private async extractAudioCover(filePath: string): Promise<string | null> {
    try {
      // Dynamic import for ESM-only music-metadata package
      const mm = await import('music-metadata');
      const metadata = await mm.parseFile(filePath);
      const picture = metadata.common.picture?.[0];

      if (picture) {
        // picture.data is Uint8Array, convert to Buffer for base64 encoding
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

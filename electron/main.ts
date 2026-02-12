import { app, BrowserWindow, ipcMain, dialog, Menu, protocol } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { pdfAnalyzer } from './pdf-analyzer';
import { getOcrService } from './ocr-service';
import { getPluginRegistry } from './plugins/plugin-registry';
import { loadBuiltinPlugins } from './plugins/plugin-loader';
import { libraryServer } from './library-server';
import { getHeadlessOcrService } from './headless-ocr';
import { initializeLoggers, getMainLogger, closeLoggers } from './rolling-logger';
import { setupAlignmentIpc } from './sentence-alignment-window.js';
import * as manifestService from './manifest-service';
import * as manifestMigration from './manifest-migration';

let mainWindow: BrowserWindow | null = null;

// Custom library root (set via IPC from renderer settings)
// Module-level so all path functions can use it
let customLibraryRoot: string | null = null;

function getLibraryRoot(): string {
  if (customLibraryRoot) {
    return customLibraryRoot;
  }
  return path.join(app.getPath('documents'), 'BookForge');
}

// Library server config file path
function getLibraryServerConfigPath(): string {
  return path.join(getLibraryRoot(), 'library-server.json');
}

// Load library server config from file
async function loadLibraryServerConfig(): Promise<{ enabled: boolean; booksPath: string; port: number } | null> {
  try {
    const configPath = getLibraryServerConfigPath();
    if (!fsSync.existsSync(configPath)) {
      return null;
    }
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Save library server config to file
async function saveLibraryServerConfig(config: { enabled: boolean; booksPath: string; port: number }): Promise<void> {
  const configPath = getLibraryServerConfigPath();
  const dir = path.dirname(configPath);
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// Auto-start library server if enabled
async function autoStartLibraryServer(): Promise<void> {
  const config = await loadLibraryServerConfig();
  if (config && config.enabled && config.booksPath) {
    try {
      console.log('[LibraryServer] Auto-starting with config:', config);
      await libraryServer.start({ booksPath: config.booksPath, port: config.port });
    } catch (err) {
      console.error('[LibraryServer] Auto-start failed:', err);
    }
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

    try {
      // Read file directly from disk
      const data = fsSync.readFileSync(filePath);
      return new Response(data, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'max-age=31536000' // Cache for 1 year
        }
      });
    } catch (err) {
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

function createWindow(): void {
  // Get icon path - in dev it's in project root, in prod it's in app resources
  const iconPath = isDev
    ? path.join(__dirname, '..', '..', 'bookforge-icon.png')  // dist/electron -> project root
    : path.join(app.getAppPath(), 'bookforge-icon.png');

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
    // Use app.getAppPath() for reliable path resolution in packaged apps
    const appPath = app.getAppPath();
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupIpcHandlers(): void {
  // PDF Analyzer handlers (pure TypeScript - no Python!)
  ipcMain.handle('pdf:analyze', async (_event, pdfPath: string, maxPages?: number) => {
    try {
      // Send progress updates during analysis
      const sendProgress = (phase: string, message: string) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pdf:analyze-progress', { phase, message });
        }
      };

      const result = await pdfAnalyzer.analyze(pdfPath, maxPages, sendProgress);
      console.log('[pdf:analyze] Returning result with', result.blocks.length, 'blocks');
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-page', async (
    _event,
    pageNum: number,
    scale: number = 2.0,
    pdfPath?: string,
    redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>,
    fillRegions?: Array<{ x: number; y: number; width: number; height: number }>,
    removeBackground?: boolean
  ) => {
    try {
      const image = await pdfAnalyzer.renderPage(pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground);
      return { success: true, data: { image } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Render a blank white page (for removing background images)
  ipcMain.handle('pdf:render-blank-page', async (
    _event,
    pageNum: number,
    scale: number = 2.0
  ) => {
    try {
      const image = await pdfAnalyzer.renderBlankPage(pageNum, scale);
      return { success: true, data: { image } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Render all pages to temp files upfront (for fast grid display)
  ipcMain.handle('pdf:render-all-pages', async (
    event,
    pdfPath: string,
    scale: number = 2.0,
    concurrency: number = 4
  ) => {
    try {
      const paths = await pdfAnalyzer.renderAllPagesToFiles(
        pdfPath,
        scale,
        concurrency,
        (current, total) => {
          // Send progress updates to renderer
          event.sender.send('pdf:render-progress', { current, total });
        }
      );
      return { success: true, data: { paths } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get path for a single pre-rendered page
  ipcMain.handle('pdf:get-rendered-page-path', async (_event, pageNum: number) => {
    try {
      const path = pdfAnalyzer.getRenderedPagePath(pageNum);
      return { success: true, data: { path } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Cleanup temp files (legacy - now a no-op since cache is persistent)
  ipcMain.handle('pdf:cleanup-temp-files', async () => {
    try {
      pdfAnalyzer.cleanupTempFiles();
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Two-tier rendering: fast previews first, then high-res in background
  ipcMain.handle('pdf:render-with-previews', async (
    event,
    pdfPath: string,
    concurrency: number = 4
  ) => {
    try {
      const result = await pdfAnalyzer.renderAllPagesWithPreviews(
        pdfPath,
        concurrency,
        // Preview progress callback
        (current, total) => {
          event.sender.send('pdf:render-progress', { current, total, phase: 'preview' });
        },
        // Full render callback (per-page as they complete)
        (pageNum, pagePath) => {
          event.sender.send('pdf:page-upgraded', { pageNum, path: pagePath });
        },
        // Combined progress callback
        (current, total, phase) => {
          event.sender.send('pdf:render-progress', { current, total, phase });
        }
      );
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Clear cache for a specific file hash
  ipcMain.handle('pdf:clear-cache', async (_event, fileHash: string) => {
    try {
      pdfAnalyzer.clearCache(fileHash);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Clear all cache
  ipcMain.handle('pdf:clear-all-cache', async () => {
    try {
      const result = pdfAnalyzer.clearAllCache();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get cache size for a specific file
  ipcMain.handle('pdf:get-cache-size', async (_event, fileHash: string) => {
    try {
      const size = pdfAnalyzer.getCacheSize(fileHash);
      return { success: true, data: { size } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get total cache size
  ipcMain.handle('pdf:get-total-cache-size', async () => {
    try {
      const size = pdfAnalyzer.getTotalCacheSize();
      return { success: true, data: { size } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-text', async (_event, enabledCategories: string[]) => {
    try {
      const result = pdfAnalyzer.exportText(enabledCategories);
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
      const fs = require('fs').promises;
      const path = require('path');
      const os = require('os');
      const execAsync = promisify(exec);

      // Create temp directory for intermediate files
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookforge-epub-'));
      const tempTextFile = path.join(tempDir, 'extracted.txt');
      const tempEpubFile = path.join(tempDir, 'output.epub');

      // Detect file type
      const ext = path.extname(filePath).toLowerCase();
      const isEpub = ext === '.epub';

      try {
        // Step 1: Extract text based on file type
        if (isEpub) {
          // For EPUB: use ebook-convert to extract text
          console.log('[Text-only EPUB] Extracting text from EPUB...');
          await execAsync(`/Applications/calibre.app/Contents/MacOS/ebook-convert "${filePath}" "${tempTextFile}"`);
        } else {
          // For PDF: use pdftotext
          console.log('[Text-only EPUB] Extracting text from PDF...');
          await execAsync(`/opt/homebrew/bin/pdftotext -layout "${filePath}" "${tempTextFile}"`);
        }

        // Check if text was extracted
        const stats = await fs.stat(tempTextFile);
        if (stats.size === 0) {
          throw new Error(`No text extracted from ${isEpub ? 'EPUB' : 'PDF'}`);
        }

        // Step 2: Convert text to EPUB using ebook-convert
        console.log('[Text-only EPUB] Converting to EPUB...');
        let convertCmd = `/Applications/calibre.app/Contents/MacOS/ebook-convert "${tempTextFile}" "${tempEpubFile}"`;

        // Add metadata if provided
        if (metadata?.title) {
          convertCmd += ` --title "${metadata.title.replace(/"/g, '\\"')}"`;
        }
        if (metadata?.author) {
          convertCmd += ` --authors "${metadata.author.replace(/"/g, '\\"')}"`;
        }

        // Add formatting options
        convertCmd += ' --formatting-type=markdown --paragraph-type=auto --page-breaks-before="/"';

        await execAsync(convertCmd);

        // Step 3: Read the EPUB file and return as base64
        const epubBuffer = await fs.readFile(tempEpubFile);
        const epubBase64 = epubBuffer.toString('base64');

        // Clean up temp files
        await fs.unlink(tempTextFile).catch(() => {});
        await fs.unlink(tempEpubFile).catch(() => {});
        await fs.rmdir(tempDir).catch(() => {});

        return { success: true, data: epubBase64 };
      } catch (error) {
        // Clean up on error
        await fs.unlink(tempTextFile).catch(() => {});
        await fs.unlink(tempEpubFile).catch(() => {});
        await fs.rmdir(tempDir).catch(() => {});
        throw error;
      }
    } catch (err) {
      console.error('[Text-only EPUB] Export failed:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Simplified chapter type for export (only fields needed for bookmarks)
  type ExportChapter = {title: string; page: number; level: number};

  ipcMain.handle('pdf:export-pdf', async (
    _event,
    pdfPath: string,
    deletedRegions: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>,
    ocrBlocks?: Array<{page: number; x: number; y: number; width: number; height: number; text: string; font_size: number}>,
    deletedPages?: number[],
    chapters?: ExportChapter[]
  ) => {
    try {
      const deletedPagesSet = deletedPages ? new Set(deletedPages) : undefined;
      const pdfBase64 = await pdfAnalyzer.exportPdf(pdfPath, deletedRegions, ocrBlocks, deletedPagesSet, chapters);
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-pdf-no-backgrounds', async (
    event,
    scale: number = 2.0,
    deletedRegions?: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>,
    ocrBlocks?: Array<{page: number; x: number; y: number; width: number; height: number; text: string; font_size: number}>,
    deletedPages?: number[]
  ) => {
    try {
      const deletedPagesSet = deletedPages ? new Set(deletedPages) : undefined;
      const pdfBase64 = await pdfAnalyzer.exportPdfWithBackgroundsRemoved(
        scale,
        (current, total) => {
          event.sender.send('pdf:export-progress', { current, total });
        },
        deletedRegions,
        ocrBlocks,
        deletedPagesSet
      );
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // WYSIWYG PDF export - renders pages exactly as the viewer shows them
  // For pages with deleted background images, renders OCR text on white background
  ipcMain.handle('pdf:export-pdf-wysiwyg', async (
    event,
    deletedRegions?: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>,
    deletedPages?: number[],
    scale: number = 2.0,
    ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>
  ) => {
    try {
      const deletedPagesSet = deletedPages ? new Set(deletedPages) : undefined;
      const pdfBase64 = await pdfAnalyzer.exportPdfWysiwyg(
        deletedRegions,
        deletedPagesSet,
        scale,
        (current, total) => {
          event.sender.send('pdf:export-progress', { current, total });
        },
        ocrPages
      );
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-similar', async (_event, blockId: string) => {
    try {
      const result = pdfAnalyzer.findSimilar(blockId);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Sample picker handlers for custom category creation
  ipcMain.handle('pdf:find-spans-in-rect', async (_event, page: number, x: number, y: number, width: number, height: number) => {
    try {
      const spans = pdfAnalyzer.findSpansInRect(page, x, y, width, height);
      return { success: true, data: spans };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:analyze-samples', async (_event, sampleSpans: any[]) => {
    try {
      const pattern = pdfAnalyzer.analyzesamples(sampleSpans);
      return { success: true, data: pattern };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-matching-spans', async (_event, pattern: any) => {
    try {
      const matches = pdfAnalyzer.findMatchingSpans(pattern);
      return { success: true, data: matches };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:find-spans-by-regex', async (_event, pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) => {
    try {
      const matches = pdfAnalyzer.findSpansByRegex(pattern, minFontSize, maxFontSize, minBaseline ?? null, maxBaseline ?? null, caseSensitive ?? false);
      return { success: true, data: matches };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:get-spans', async () => {
    try {
      const spans = pdfAnalyzer.getSpans();
      return { success: true, data: spans };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Update spans for OCR pages (so custom categories can match OCR text)
  ipcMain.handle('pdf:update-spans-for-ocr', async (_event, pageNum: number, ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>) => {
    try {
      pdfAnalyzer.updateSpansForOcrPage(pageNum, ocrBlocks);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Chapter detection handlers
  ipcMain.handle('pdf:extract-outline', async () => {
    try {
      const outline = await pdfAnalyzer.extractOutline();
      return { success: true, data: outline };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:outline-to-chapters', async (_event, outline: any[]) => {
    try {
      const chapters = pdfAnalyzer.outlineToChapters(outline);
      return { success: true, data: chapters };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:detect-chapters', async () => {
    try {
      const chapters = pdfAnalyzer.detectChaptersHeuristic();
      return { success: true, data: chapters };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:add-bookmarks', async (_event, pdfBase64: string, chapters: any[]) => {
    try {
      // Convert base64 to Uint8Array
      const pdfData = Buffer.from(pdfBase64, 'base64');
      const result = await pdfAnalyzer.addBookmarksToPdf(pdfData, chapters);
      // Convert back to base64
      const base64Result = Buffer.from(result).toString('base64');
      return { success: true, data: base64Result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // WYSIWYG export: Assemble PDF from canvas-rendered images
  ipcMain.handle('pdf:assemble-from-images', async (_event, pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>, chapters?: any[]) => {
    try {
      console.log(`[pdf:assemble-from-images] Assembling PDF from ${pages.length} canvas images`);
      const result = await pdfAnalyzer.assembleFromImages(pages, chapters);
      return result;
    } catch (err) {
      console.error('[pdf:assemble-from-images] Error:', err);
      return null;
    }
  });

  // File system handlers
  ipcMain.handle('fs:browse', async (_event, dirPath: string) => {
    const fs = await import('fs/promises');
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const items = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();

      const lowerName = entry.name.toLowerCase();
      const isDocument = lowerName.endsWith('.pdf') || lowerName.endsWith('.epub');
      if (isDir || isDocument) {
        let size = null;
        if (!isDir) {
          const stat = await fs.stat(fullPath);
          size = stat.size;
        }
        const fileType = isDir ? 'directory' : (lowerName.endsWith('.epub') ? 'epub' : 'pdf');
        items.push({
          name: entry.name,
          path: fullPath,
          type: fileType,
          size,
        });
      }
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
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
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
  // For large files (>100MB), returns a streaming URL via LibraryServer instead
  ipcMain.handle('fs:read-audio', async (_event, audioPath: string) => {
    try {
      console.log('[fs:read-audio] Loading:', audioPath);

      // Check file size first
      const stats = await fs.stat(audioPath);
      const MAX_SIZE_FOR_BASE64 = 500 * 1024 * 1024; // 500MB - streaming has issues in Electron

      const ext = audioPath.toLowerCase().split('.').pop();
      const mimeType = ext === 'm4b' || ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';

      if (stats.size > MAX_SIZE_FOR_BASE64) {
        // For large files, use LibraryServer's streaming endpoint
        const streamUrl = `http://localhost:8765/api/audio?path=${encodeURIComponent(audioPath)}`;
        console.log(`[fs:read-audio] File too large (${stats.size} bytes), using streaming URL`);
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

  // Update just the metadata in a BFP file (for audiobook producer)
  ipcMain.handle('project:update-metadata', async (_event, bfpPath: string, metadata: unknown) => {
    try {
      // Read existing project
      const content = await fs.readFile(bfpPath, 'utf-8');
      const project = JSON.parse(content);

      // Handle cover image - save to media folder if it's base64 data
      const meta = metadata as Record<string, unknown>;
      if (meta.coverData && typeof meta.coverData === 'string' && meta.coverData.startsWith('data:')) {
        const relativePath = await saveImageToMedia(meta.coverData as string, 'cover');
        meta.coverImagePath = relativePath;
        delete meta.coverData;  // Don't store base64 in BFP
      }

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

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Document',
      filters: [
        { name: 'Ebooks', extensions: ['pdf', 'epub', 'azw3', 'azw', 'mobi', 'kfx', 'prc', 'fb2'] },
        { name: 'Documents', extensions: ['docx', 'odt', 'rtf', 'txt', 'html', 'htm'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePaths[0] };
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
    // Sync to manifest service
    manifestService.setLibraryBasePath(libraryPath);
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
    }

    return { success: false, error: 'Source file not found in library' };
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
      const audiobooksFolder = getAudiobooksBasePath();
      const projectsFolder = getProjectsFolder();
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      console.log(`[projects:delete] Starting deletion of ${filePaths.length} project(s)`);
      console.log(`[projects:delete] Library root: ${libraryRoot}`);
      console.log(`[projects:delete] Audiobooks folder: ${audiobooksFolder}`);

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

          // Derive audiobook folder name from BFP filename
          // e.g., "Aesop_s_Fables__Aesopus___2011_.bfp" -> "Aesop_s_Fables__Aesopus___2011_"
          const bfpFilename = path.basename(filePath);
          const projectName = bfpFilename.replace(/\.bfp$/, '');
          const audiobookFolder = path.join(audiobooksFolder, projectName);

          console.log(`[projects:delete] Derived audiobook folder: ${audiobookFolder}`);

          // Delete the audiobook folder if it exists
          try {
            const folderExists = await fs.access(audiobookFolder).then(() => true).catch(() => false);
            if (folderExists) {
              await fs.rm(audiobookFolder, { recursive: true, force: true });
              console.log(`[projects:delete] Deleted audiobook folder: ${audiobookFolder}`);
            } else {
              console.log(`[projects:delete] Audiobook folder does not exist: ${audiobookFolder}`);
            }
          } catch (e) {
            console.log(`[projects:delete] Error deleting audiobook folder: ${(e as Error).message}`);
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
              pdfAnalyzer.clearCache(fileHash);
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
    engine: 'tesseract' | 'surya';
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

  // Compute word-level diff using system diff command (much more efficient than JS LCS)
  ipcMain.handle('diff:compute-system-diff', async (_event, originalText: string, cleanedText: string) => {
    try {
      const { computeSystemDiff } = await import('./epub-processor.js');
      const segments = await computeSystemDiff(originalText, cleanedText);
      return { success: true, data: segments };
    } catch (err) {
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
      shell.showItemInFolder(filePath);
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
  // Library Server handlers
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('library-server:start', async (_event, config: { booksPath: string; port: number }) => {
    try {
      // Stop existing server if running
      if (libraryServer.isRunning()) {
        await libraryServer.stop();
      }
      await libraryServer.start(config);
      // Save config with enabled=true for auto-start on next launch
      await saveLibraryServerConfig({ ...config, enabled: true });
      return { success: true, data: libraryServer.getStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('library-server:stop', async () => {
    try {
      await libraryServer.stop();
      // Save config with enabled=false
      const currentConfig = await loadLibraryServerConfig();
      if (currentConfig) {
        await saveLibraryServerConfig({ ...currentConfig, enabled: false });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('library-server:status', async () => {
    try {
      return { success: true, data: libraryServer.getStatus() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // E2A Path Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('e2a:configure-paths', async (_event, config: { e2aPath?: string; condaPath?: string }) => {
    try {
      const { setCondaPath, setE2aPath } = await import('./e2a-paths.js');
      if (config.e2aPath !== undefined) {
        setE2aPath(config.e2aPath || null);
      }
      if (config.condaPath !== undefined) {
        setCondaPath(config.condaPath || null);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Paths Configuration (centralized config for external tools)
  // ─────────────────────────────────────────────────────────────────────────────

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
  // Session Caching handlers (for Language Learning pipeline)
  // ─────────────────────────────────────────────────────────────────────────────

  // Cache a TTS session to project folder for later assembly
  ipcMain.handle('session-cache:save', async (_event, sessionDir: string, projectDir: string, language: string) => {
    try {
      const { cacheSessionToProject } = await import('./parallel-tts-bridge.js');
      return await cacheSessionToProject(sessionDir, projectDir, language);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // List available sessions in a project
  ipcMain.handle('session-cache:list', async (_event, projectDir: string) => {
    try {
      const { listProjectSessions } = await import('./parallel-tts-bridge.js');
      const sessions = await listProjectSessions(projectDir);
      return { success: true, data: sessions };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Restore a cached session from project folder to e2a tmp
  ipcMain.handle('session-cache:restore', async (_event, projectDir: string, language: string) => {
    try {
      const { restoreSessionFromProject } = await import('./parallel-tts-bridge.js');
      return await restoreSessionFromProject(projectDir, language);
    } catch (err) {
      return { success: false, error: (err as Error).message };
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

  ipcMain.handle('play:generate-sentence', async (
    _event,
    text: string,
    sentenceIndex: number,
    settings: {
      voice: string;
      speed: number;
      temperature?: number;
      topP?: number;
      repetitionPenalty?: number;
    }
  ) => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      const result = await xttsWorkerPool.generateSentence(text, sentenceIndex, settings);
      return {
        success: result.success,
        data: result.audio,
        error: result.error
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('play:stop', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      xttsWorkerPool.stop();
      return { success: true };
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

  ipcMain.handle('play:get-voices', async () => {
    try {
      const { xttsWorkerPool } = await import('./xtts-worker-pool.js');
      const voices = xttsWorkerPool.getAvailableVoices();
      return { success: true, data: { voices } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Audiobook Project handlers
  // Each audiobook is a folder containing: exported.epub, exported_cleaned.epub (optional), project.json, output.m4b
  // ─────────────────────────────────────────────────────────────────────────────

  const getAudiobooksBasePath = () => {
    return path.join(getLibraryRoot(), 'audiobooks');
  };

  // Helper to generate a unique project folder name (with timestamp for uniqueness)
  const generateProjectId = (filename: string): string => {
    const baseName = filename.replace(/\.epub$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now().toString(36);
    return `${baseName}_${timestamp}`;
  };

  // Helper to find cleaned epub - checks for both 'exported_cleaned.epub' (new) and 'cleaned.epub' (legacy)
  const findCleanedEpub = async (folderPath: string): Promise<string | null> => {
    const newName = path.join(folderPath, 'exported_cleaned.epub');
    const legacyName = path.join(folderPath, 'cleaned.epub');

    if (await fs.access(newName).then(() => true).catch(() => false)) {
      return newName;
    }
    if (await fs.access(legacyName).then(() => true).catch(() => false)) {
      return legacyName;
    }
    return null;
  };

  // Helper to generate a stable project ID (without timestamp, for deduplication)
  const generateStableProjectId = (filename: string): string => {
    return filename.replace(/\.epub$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
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

    // Find cleaned epub (checks both 'exported_cleaned.epub' and 'cleaned.epub')
    const cleanedPath = await findCleanedEpub(folderPath) || path.join(folderPath, 'exported_cleaned.epub');

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
        const filesToRemove = ['exported.epub', 'original.epub', 'cleaned.epub', 'exported_cleaned.epub', 'project.json'];
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
    const basePath = getAudiobooksBasePath();
    return {
      success: true,
      queuePath: basePath,
      completedPath: path.join(basePath, 'completed')
    };
  });

  // List completed audiobooks (m4b files) from a specified folder
  ipcMain.handle('library:list-completed', async (_event, folderPath?: string) => {
    try {
      // Use provided path or fall back to default audiobooks folder
      const audiobooksPath = folderPath || getAudiobooksBasePath();

      // Check if folder exists
      try {
        await fs.access(audiobooksPath);
      } catch {
        return { success: true, files: [] }; // Folder doesn't exist yet
      }

      const entries = await fs.readdir(audiobooksPath, { withFileTypes: true });
      // Filter for m4b files, excluding hidden files and macOS resource forks
      const m4bFiles = entries.filter(e =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.m4b') &&
        !e.name.startsWith('.') &&
        !e.name.startsWith('._')
      );

      const files = await Promise.all(m4bFiles.map(async (file) => {
        const filePath = path.join(audiobooksPath, file.name);
        const stats = await fs.stat(filePath);
        return {
          path: filePath,
          filename: file.name,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          createdAt: stats.birthtime.toISOString()
        };
      }));

      // Sort by modification date, newest first
      files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

      return { success: true, files };
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
            const analysisResult = await pdfAnalyzer.analyze(sourcePath, undefined, () => {});
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

  // Get audiobooks folder path for a project
  const getAudiobookFolderForProject = (projectName: string) => {
    return path.join(getLibraryRoot(), 'audiobooks', projectName);
  };

  // Export EPUB to audiobook folder and update BFP project with audiobook state
  ipcMain.handle('audiobook:export-from-project', async (
    _event,
    bfpPath: string,
    epubData: ArrayBuffer,
    deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>
  ) => {
    try {
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

  // Import an EPUB file directly - creates both BFP and audiobook folder
  // This is for adding EPUBs via drag/drop without going through the PDF editor
  ipcMain.handle('audiobook:import-epub', async (
    _event,
    epubSourcePath: string
  ) => {
    try {
      const filename = path.basename(epubSourcePath);
      const projectName = filename.replace(/\.epub$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

      // Create BFP file in projects folder
      const projectsFolder = getProjectsFolder();
      await fs.mkdir(projectsFolder, { recursive: true });

      const bfpPath = path.join(projectsFolder, `${projectName}.bfp`);
      const now = new Date().toISOString();

      // Check if BFP already exists
      let bfpProject: Record<string, unknown>;
      let isReplacing = false;

      try {
        const existingContent = await fs.readFile(bfpPath, 'utf-8');
        bfpProject = JSON.parse(existingContent);
        isReplacing = true;
        console.log(`[audiobook:import-epub] Updating existing BFP: ${bfpPath}`);
      } catch {
        // Create new BFP
        bfpProject = {
          version: 1,
          source_path: epubSourcePath,
          source_name: filename,
          library_path: epubSourcePath,
          file_hash: '',
          deleted_block_ids: [],
          created_at: now,
          modified_at: now,
          metadata: {
            title: filename.replace(/\.epub$/i, '').replace(/[._]/g, ' ')
          }
        };
        console.log(`[audiobook:import-epub] Creating new BFP: ${bfpPath}`);
      }

      // Create audiobook folder
      const audiobookFolder = getAudiobookFolderForProject(projectName);
      await fs.mkdir(audiobookFolder, { recursive: true });

      // Copy original EPUB to audiobook folder as source.epub (immutable original)
      const sourceCopyPath = path.join(audiobookFolder, 'source.epub');
      await fs.copyFile(epubSourcePath, sourceCopyPath);
      console.log(`[audiobook:import-epub] Copied original to: ${sourceCopyPath}`);

      // Also create exported.epub as the working copy for the pipeline
      const epubPath = path.join(audiobookFolder, 'exported.epub');
      await fs.copyFile(epubSourcePath, epubPath);

      // Create project.json in audiobook folder
      const projectJsonPath = path.join(audiobookFolder, 'project.json');
      const projectJson = {
        id: projectName,
        version: 1,
        metadata: bfpProject.metadata || {},
        state: { step: 'exported' },
        createdAt: now
      };
      await fs.writeFile(projectJsonPath, JSON.stringify(projectJson, null, 2));

      // Update BFP paths to point to copied source (self-contained project)
      bfpProject.source_path = sourceCopyPath;
      bfpProject.library_path = sourceCopyPath;
      bfpProject.original_source_path = epubSourcePath; // Keep reference to where it came from

      // Update BFP with audiobook state
      bfpProject.audiobook = {
        status: 'pending',
        exportedEpubPath: epubPath,
        exportedAt: now
      };
      bfpProject.audiobookFolder = audiobookFolder;
      bfpProject.modified_at = now;

      // Save BFP
      await atomicWriteFile(bfpPath, JSON.stringify(bfpProject, null, 2));

      console.log(`[audiobook:import-epub] ${isReplacing ? 'Updated' : 'Created'} project: ${bfpPath}`);

      return {
        success: true,
        bfpPath,
        audiobookFolder,
        epubPath,
        projectName
      };
    } catch (err) {
      console.error('[audiobook:import-epub] Error:', err);
      return { success: false, error: (err as Error).message };
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
      const audiobooksFolder = getAudiobooksBasePath();

      // Ensure folders exist
      await fs.mkdir(projectsFolder, { recursive: true });
      await fs.mkdir(audiobooksFolder, { recursive: true });

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

          // Determine audiobook folder
          let audiobookFolder = bfp.audiobookFolder as string | undefined;
          if (!audiobookFolder) {
            audiobookFolder = path.join(audiobooksFolder, projectName);
          }

          // Check if migration is needed
          const sourcePath = bfp.source_path as string | undefined;
          const needsMigration = sourcePath && !sourcePath.includes('/audiobooks/') && !sourcePath.includes('/source.epub');

          if (!needsMigration) {
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

  // Append analytics to BFP project (handles deduplication atomically)
  ipcMain.handle('audiobook:append-analytics', async (
    _event,
    bfpPath: string,
    jobType: 'tts-conversion' | 'ocr-cleanup',
    analytics: { jobId: string; [key: string]: unknown }
  ) => {
    const MAX_ANALYTICS_HISTORY = 10;

    try {
      const bfpContent = await fs.readFile(bfpPath, 'utf-8');
      const bfpProject = JSON.parse(bfpContent);

      // Initialize audiobook state if needed
      if (!bfpProject.audiobook) {
        bfpProject.audiobook = {};
      }

      // Initialize analytics if needed
      const existingAnalytics = bfpProject.audiobook.analytics || {
        ttsJobs: [],
        cleanupJobs: []
      };

      // Deduplicate by jobId and append
      if (jobType === 'tts-conversion') {
        const dedupedJobs = (existingAnalytics.ttsJobs || []).filter(
          (j: { jobId: string }) => j.jobId !== analytics.jobId
        );
        existingAnalytics.ttsJobs = [...dedupedJobs, analytics].slice(-MAX_ANALYTICS_HISTORY);
      } else if (jobType === 'ocr-cleanup') {
        const dedupedJobs = (existingAnalytics.cleanupJobs || []).filter(
          (j: { jobId: string }) => j.jobId !== analytics.jobId
        );
        existingAnalytics.cleanupJobs = [...dedupedJobs, analytics].slice(-MAX_ANALYTICS_HISTORY);

        // Also set cleanedAt timestamp for OCR cleanup
        bfpProject.audiobook.cleanedAt = new Date().toISOString();
      }

      bfpProject.audiobook.analytics = existingAnalytics;
      bfpProject.modified_at = new Date().toISOString();

      await atomicWriteFile(bfpPath, JSON.stringify(bfpProject, null, 2));

      return { success: true };
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

      // Update BFP with vttPath
      const bfpContent = await fs.readFile(bfpPath, 'utf-8');
      const bfpProject = JSON.parse(bfpContent);

      if (!bfpProject.audiobook) {
        bfpProject.audiobook = {};
      }
      bfpProject.audiobook.vttPath = vttDestPath;
      bfpProject.modified_at = new Date().toISOString();

      await atomicWriteFile(bfpPath, JSON.stringify(bfpProject, null, 2));

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

            // Check if linked audio path exists on current system
            // (handles cross-platform scenarios like Mac path on Windows)
            let linkedAudioPathValid: boolean | undefined;
            if (project.audiobook.linkedAudioPath) {
              linkedAudioPathValid = fsSync.existsSync(project.audiobook.linkedAudioPath);
            }

            // Check if bilingual audio path exists
            let bilingualAudioPathValid: boolean | undefined;
            if (project.audiobook.bilingualAudioPath) {
              bilingualAudioPathValid = fsSync.existsSync(project.audiobook.bilingualAudioPath);
            }

            projects.push({
              name: projectName,
              bfpPath,
              audiobookFolder: getAudiobookFolderForProject(projectName),
              status: project.audiobook.status || 'pending',
              exportedAt: project.audiobook.exportedAt,
              cleanedAt: project.audiobook.cleanedAt,
              completedAt: project.audiobook.completedAt,
              linkedAudioPath: project.audiobook.linkedAudioPath,
              linkedAudioPathValid,
              vttPath: project.audiobook.vttPath,  // VTT path from BFP
              // Bilingual audio paths
              bilingualAudioPath: project.audiobook.bilingualAudioPath,
              bilingualAudioPathValid,
              bilingualVttPath: project.audiobook.bilingualVttPath,
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
      console.log('[audiobook:link-audio] === LINK AUDIO CALLED ===');
      console.log('[audiobook:link-audio] bfpPath:', bfpPath);
      console.log('[audiobook:link-audio] audioPath:', audioPath);

      // Validate inputs
      if (!bfpPath || !audioPath) {
        console.error('[audiobook:link-audio] Missing required parameters');
        return { success: false, error: 'Missing bfpPath or audioPath' };
      }

      // Check if BFP file exists
      const bfpExists = fsSync.existsSync(bfpPath);
      console.log('[audiobook:link-audio] BFP exists:', bfpExists);
      if (!bfpExists) {
        return { success: false, error: `BFP file not found: ${bfpPath}` };
      }

      // Read the BFP file
      console.log('[audiobook:link-audio] Reading BFP file...');
      const content = await fs.readFile(bfpPath, 'utf-8');
      const project = JSON.parse(content);
      console.log('[audiobook:link-audio] Current linkedAudioPath:', project.audiobook?.linkedAudioPath);

      // Ensure audiobook state exists
      if (!project.audiobook) {
        project.audiobook = {};
      }

      // Set the linked audio path
      project.audiobook.linkedAudioPath = audioPath;
      console.log('[audiobook:link-audio] New linkedAudioPath:', project.audiobook.linkedAudioPath);

      // Save the BFP file
      console.log('[audiobook:link-audio] Writing BFP file...');
      const jsonContent = JSON.stringify(project, null, 2);
      await fs.writeFile(bfpPath, jsonContent);
      console.log('[audiobook:link-audio] Write complete, bytes:', jsonContent.length);

      // Verify the write
      const verifyContent = await fs.readFile(bfpPath, 'utf-8');
      const verifyProject = JSON.parse(verifyContent);
      console.log('[audiobook:link-audio] Verified linkedAudioPath:', verifyProject.audiobook?.linkedAudioPath);

      console.log('[audiobook:link-audio] === SUCCESS ===');
      return { success: true };
    } catch (err) {
      console.error('[audiobook:link-audio] === ERROR ===');
      console.error('[audiobook:link-audio] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // Link bilingual audio file to BFP project (separate from mono audiobook)
  ipcMain.handle('audiobook:link-bilingual-audio', async (_event, bfpPath: string, audioPath: string, vttPath?: string) => {
    try {
      console.log('[audiobook:link-bilingual-audio] === LINK BILINGUAL AUDIO CALLED ===');
      console.log('[audiobook:link-bilingual-audio] bfpPath:', bfpPath);
      console.log('[audiobook:link-bilingual-audio] audioPath:', audioPath);
      console.log('[audiobook:link-bilingual-audio] vttPath:', vttPath);

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

      // Set the bilingual audio and VTT paths
      project.audiobook.bilingualAudioPath = audioPath;
      if (vttPath) {
        project.audiobook.bilingualVttPath = vttPath;
      }
      console.log('[audiobook:link-bilingual-audio] New bilingualAudioPath:', project.audiobook.bilingualAudioPath);
      console.log('[audiobook:link-bilingual-audio] New bilingualVttPath:', project.audiobook.bilingualVttPath);

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
      // Cleanup mode: 'structure' preserves HTML, 'full' sends HTML to AI
      cleanupMode?: 'structure' | 'full';
      // Test mode: only process first 5 chunks
      testMode?: boolean;
      // Simplify for children: rewrite archaic language for young readers
      simplifyForChildren?: boolean;
    }
  ) => {
    console.log('[IPC] queue:run-ocr-cleanup received:', {
      jobId,
      useDetailedCleanup: aiConfig?.useDetailedCleanup,
      exampleCount: aiConfig?.deletedBlockExamples?.length || 0,
      useParallel: aiConfig?.useParallel,
      parallelWorkers: aiConfig?.parallelWorkers,
      cleanupMode: aiConfig?.cleanupMode,
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
        cleanupMode?: 'structure' | 'full';
        testMode?: boolean;
        simplifyForChildren?: boolean;
      } = {};

      // Set cleanup mode (default to 'structure' for backwards compatibility)
      cleanupOptions.cleanupMode = aiConfig.cleanupMode || 'structure';

      // Set test mode
      cleanupOptions.testMode = aiConfig.testMode || false;
      console.log('[IPC] Test mode:', aiConfig.testMode, '-> cleanupOptions.testMode:', cleanupOptions.testMode);

      // Set simplify for children mode
      cleanupOptions.simplifyForChildren = aiConfig.simplifyForChildren || false;
      if (cleanupOptions.simplifyForChildren) {
        console.log('[IPC] Simplify for children mode: ENABLED');
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
        outputDir = path.join(documentsPath, 'BookForge', 'audiobooks', 'completed');
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
      return { success: deleted };
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Resemble Enhance Post-Processing (replaces DeepFilterNet)
  // Better for TTS artifacts like reverb/echo in Orpheus output
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('resemble:check-available', async () => {
    try {
      const { checkResembleAvailable } = await import('./resemble-bridge.js');
      const result = await checkResembleAvailable();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('resemble:list-files', async (_event, audiobooksDir: string) => {
    try {
      const { listAudioFiles } = await import('./resemble-bridge.js');
      const files = await listAudioFiles(audiobooksDir);
      return { success: true, data: files };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('resemble:enhance', async (_event, filePath: string) => {
    try {
      const { enhanceFile, initResembleBridge } = await import('./resemble-bridge.js');
      if (mainWindow) {
        initResembleBridge(mainWindow);
      }
      const result = await enhanceFile(filePath);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('resemble:cancel', async () => {
    try {
      const { cancelEnhance } = await import('./resemble-bridge.js');
      const cancelled = cancelEnhance();
      return { success: true, data: cancelled };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Open audio file picker for enhancement
  ipcMain.handle('resemble:pick-files', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Audio Files to Enhance',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio Files', extensions: ['m4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'opus'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'No files selected' };
    }

    // Get file info for each selected file
    const fs = await import('fs');
    const path = await import('path');
    const files = result.filePaths.map(filePath => {
      const stats = fs.statSync(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        size: stats.size,
        modifiedAt: stats.mtime,
        format: path.extname(filePath).slice(1).toUpperCase()
      };
    });

    return { success: true, data: files };
  });

  // Queue-based resemble enhancement
  ipcMain.handle('queue:run-resemble-enhance', async (_event, jobId: string, config: {
    inputPath: string;
    outputPath?: string;
    projectId?: string;
    bfpPath?: string;
    replaceOriginal?: boolean;
  }) => {
    try {
      const fs = await import('fs');
      const pathModule = await import('path');

      // Normalize input path for Windows (may have mixed separators)
      const normalizedInputPath = config.inputPath.replace(/\//g, pathModule.sep);

      // Check if input file exists
      if (!fs.existsSync(normalizedInputPath)) {
        const error = `Input file not found: ${normalizedInputPath}`;
        console.error('[RESEMBLE-QUEUE]', error);
        if (mainWindow) {
          mainWindow.webContents.send('queue:job-complete', {
            jobId,
            success: false,
            error
          });
        }
        return { success: false, error };
      }

      const { enhanceFileForQueue, initResembleBridge } = await import('./resemble-bridge.js');
      if (mainWindow) {
        initResembleBridge(mainWindow);
      }

      // Determine output path (normalize for Windows)
      let outputPath = config.outputPath?.replace(/\//g, pathModule.sep);
      if (config.replaceOriginal === true || (!config.outputPath && !config.bfpPath)) {
        // Replace original mode
        outputPath = undefined;
      }

      const result = await enhanceFileForQueue(
        jobId,
        normalizedInputPath,
        outputPath,
        config.projectId,
        (progress) => {
          // Emit queue progress
          if (mainWindow) {
            mainWindow.webContents.send('queue:progress', progress);
          }
        }
      );

      // Emit job completion
      console.log(`[RESEMBLE-QUEUE] Job ${jobId}: Sending queue:job-complete event, success=${result.success}`);
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: result.success,
          outputPath: result.outputPath,
          error: result.error
        });
        console.log(`[RESEMBLE-QUEUE] Job ${jobId}: queue:job-complete event sent`);
      } else {
        console.error(`[RESEMBLE-QUEUE] Job ${jobId}: mainWindow is null, cannot send queue:job-complete`);
      }

      // Update project state if bfpPath provided
      if (config.bfpPath && result.success) {
        try {
          const fs = await import('fs');
          const path = await import('path');

          // Read existing project file
          const projectData = JSON.parse(fs.readFileSync(config.bfpPath, 'utf-8'));

          // Update audiobook state
          if (!projectData.audiobookState) {
            projectData.audiobookState = {};
          }
          projectData.audiobookState.enhancementStatus = 'complete';
          projectData.audiobookState.enhancedAt = new Date().toISOString();
          projectData.audiobookState.enhancementJobId = jobId;

          // Save updated project file
          fs.writeFileSync(config.bfpPath, JSON.stringify(projectData, null, 2));
          console.log(`[RESEMBLE-QUEUE] Updated project state for ${config.bfpPath}`);
        } catch (err) {
          console.error('[RESEMBLE-QUEUE] Failed to update project state:', err);
        }
      }

      return { success: result.success, data: result, error: result.error };
    } catch (err) {
      // Emit error completion
      if (mainWindow) {
        mainWindow.webContents.send('queue:job-complete', {
          jobId,
          success: false,
          error: (err as Error).message
        });
      }
      return { success: false, error: (err as Error).message };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DeepFilterNet Post-Processing (deprecated - use Resemble Enhance instead)
  // ─────────────────────────────────────────────────────────────────────────────

  ipcMain.handle('deepfilter:check-available', async () => {
    try {
      const { checkDeepFilterAvailable } = await import('./deepfilter-bridge.js');
      const result = await checkDeepFilterAvailable();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('deepfilter:list-files', async (_event, audiobooksDir: string) => {
    try {
      const { listAudioFiles } = await import('./deepfilter-bridge.js');
      const files = await listAudioFiles(audiobooksDir);
      return { success: true, data: files };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('deepfilter:denoise', async (_event, filePath: string) => {
    try {
      const { denoiseFile, initDeepFilterBridge } = await import('./deepfilter-bridge.js');
      if (mainWindow) {
        initDeepFilterBridge(mainWindow);
      }
      const result = await denoiseFile(filePath);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('deepfilter:cancel', async () => {
    try {
      const { cancelDenoise } = await import('./deepfilter-bridge.js');
      const cancelled = cancelDenoise();
      return { success: true, data: cancelled };
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
      const path = await import('path');
      const fsPromises = await import('fs/promises');
      const projectDir = path.join(getLibraryRoot(), 'language-learning', 'projects', projectId);
      const pairsPath = path.join(projectDir, 'sentence_pairs.json');

      const content = await fsPromises.readFile(pairsPath, 'utf-8');
      const pairs = JSON.parse(content);
      return { success: true, pairs };
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

  // Job 1: AI Cleanup - reads from source EPUB, writes to cleaned.epub
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

  // Job 2: Translation - reads from cleaned.epub, writes translated.epub
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
    'it': 'Italian', 'pt': 'Portuguese', 'nl': 'Dutch', 'pl': 'Polish',
    'ru': 'Russian', 'ja': 'Japanese', 'zh': 'Chinese', 'ko': 'Korean',
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

  ipcMain.handle('editor:open-window', async (_event, projectPath: string) => {
    // Check if window already open for this project
    const existingWindow = editorWindows.get(projectPath);
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus();
      return { success: true, alreadyOpen: true };
    }

    // Get icon path
    const iconPath = isDev
      ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
      : path.join(app.getAppPath(), 'bookforge-icon.png');

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

    // Load the editor route with project path as query param
    const encodedPath = encodeURIComponent(projectPath);
    if (isDev) {
      editorWindow.loadURL(`http://localhost:4250/editor?project=${encodedPath}`);
    } else {
      const appPath = app.getAppPath();
      const indexPath = path.join(appPath, 'dist', 'renderer', 'browser', 'index.html');
      editorWindow.loadFile(indexPath, {
        hash: `/editor?project=${encodedPath}`
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
      existingWindow.focus();
      return { success: true, alreadyOpen: true };
    }

    // Get icon path
    const iconPath = isDev
      ? path.join(__dirname, '..', '..', 'bookforge-icon.png')
      : path.join(app.getAppPath(), 'bookforge-icon.png');

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

    // Load the editor route with both BFP path and source path as query params
    const encodedBfp = encodeURIComponent(bfpPath);
    const encodedSource = encodeURIComponent(sourcePath);
    if (isDev) {
      editorWindow.loadURL(`http://localhost:4250/editor?project=${encodedBfp}&source=${encodedSource}`);
    } else {
      const appPath = app.getAppPath();
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
  ipcMain.handle('editor:get-versions', async (_event, bfpPath: string) => {
    try {
      // Read the BFP project file
      if (!bfpPath || !fsSync.existsSync(bfpPath)) {
        return { success: false, error: 'BFP file not found' };
      }

      const bfpContent = await fs.readFile(bfpPath, 'utf-8');
      const bfp = JSON.parse(bfpContent);
      const bfpDir = path.dirname(bfpPath);

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
        console.log(`[EDITOR:GET-VERSIONS] addVersion called: id=${id}, path=${filePath}, exists=${filePath ? fsSync.existsSync(filePath) : 'no path'}`);
        if (filePath && fsSync.existsSync(filePath)) {
          const stats = await fs.stat(filePath);
          const ext = path.extname(filePath).toLowerCase().replace('.', '');
          console.log(`[EDITOR:GET-VERSIONS] Adding version: ${id} (${label})`);
          versions.push({
            id,
            type,
            label,
            description,
            path: filePath,
            extension: ext,
            language,
            modifiedAt: stats.mtime.toISOString(),
            fileSize: stats.size,
            editable: editable && (ext === 'epub' || ext === 'pdf'),
            icon
          });
        }
      };

      // 1. Original source file
      const sourcePath = bfp.source_path || bfp.sourcePath;
      if (sourcePath) {
        const sourceExt = path.extname(sourcePath).toLowerCase();
        await addVersion(
          'original',
          'original',
          'Original Source',
          `The original ${sourceExt.toUpperCase().replace('.', '')} file you imported`,
          sourcePath,
          sourceExt === '.pdf' ? '📄' : '📘',
          true
        );
      }

      // 2. Finalized/Exported EPUB
      // Only show if:
      // - User has made edits in the editor (deleted_block_ids or deleted_pages), OR
      // - Original source is a PDF (EPUB must have been created via editor), OR
      // - BFP has explicit editorExported flag
      const exportedPath = bfp.audiobook?.exportedEpubPath;
      const hasDeletedBlocks = bfp.deleted_block_ids && bfp.deleted_block_ids.length > 0;
      const hasDeletedPages = bfp.deleted_pages && bfp.deleted_pages.length > 0;
      const hasUserEdits = hasDeletedBlocks || hasDeletedPages || bfp.editorExported;
      const sourceIsPdf = sourcePath && sourcePath.toLowerCase().endsWith('.pdf');

      if (exportedPath) {
        const resolvedExportedPath = path.isAbsolute(exportedPath)
          ? exportedPath
          : path.join(bfpDir, exportedPath);

        // Only show finalized version if user actually edited or source is PDF
        const showFinalizedVersion = hasUserEdits || sourceIsPdf;

        if (showFinalizedVersion && fsSync.existsSync(resolvedExportedPath)) {
          await addVersion(
            'finalized',
            'finalized',
            'Finalized EPUB',
            'The exported EPUB with all your edits applied',
            resolvedExportedPath,
            '✅',
            true
          );
        }
      }

      // 3. Cleaned EPUB (after AI cleanup)
      // Check audiobook folder for cleaned version - support both naming conventions
      const audiobookFolder = bfp.audiobookFolder || bfp.audiobook?.folder;
      console.log('[EDITOR:GET-VERSIONS] audiobookFolder:', audiobookFolder);
      if (audiobookFolder && fsSync.existsSync(audiobookFolder)) {
        // Try exported_cleaned.epub (old convention) then cleaned.epub (new LL convention)
        const cleanedPathOld = path.join(audiobookFolder, 'exported_cleaned.epub');
        const cleanedPathNew = path.join(audiobookFolder, 'cleaned.epub');
        const cleanedPath = fsSync.existsSync(cleanedPathOld) ? cleanedPathOld : cleanedPathNew;
        console.log('[EDITOR:GET-VERSIONS] cleanedPath:', cleanedPath, 'exists:', fsSync.existsSync(cleanedPath));

        await addVersion(
          'cleaned',
          'cleaned',
          'Cleaned EPUB',
          'After AI cleanup - typos fixed, formatting improved',
          cleanedPath,
          '🧹',
          true
        );
        console.log('[EDITOR:GET-VERSIONS] Added cleaned version, total versions:', versions.length);

        // 4. Translated EPUBs - look for *_translated.epub and {lang}.epub files
        const files = await fs.readdir(audiobookFolder);
        for (const file of files) {
          // Old convention: exported_de_translated.epub
          if (file.endsWith('_translated.epub')) {
            const match = file.match(/exported_([a-z]{2})_translated\.epub/);
            const lang = match ? match[1] : 'unknown';
            const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
            await addVersion(
              `translated-${lang}`,
              'translated',
              `Translated (${langName})`,
              `Translated to ${langName}`,
              path.join(audiobookFolder, file),
              '🌍',
              true,
              lang
            );
          }
          // New LL convention: de.epub, es.epub, ko.epub (2-letter language code)
          else if (/^[a-z]{2}\.epub$/.test(file)) {
            const lang = file.replace('.epub', '');
            const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
            await addVersion(
              `translated-${lang}`,
              'translated',
              `${langName} EPUB`,
              `${langName} language version`,
              path.join(audiobookFolder, file),
              '🌍',
              true,
              lang
            );
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

      console.log(`[EDITOR:SAVE-EPUB] Saved EPUB to ${epubPath} (${buffer.length} bytes)`);
      return { success: true };
    } catch (err) {
      console.error('[EDITOR:SAVE-EPUB] Error:', err);
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

app.whenReady().then(async () => {
  // Initialize rolling logger
  await initializeLoggers();
  const logger = getMainLogger();
  logger.info('BookForge starting', { version: app.getVersion(), platform: process.platform });

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

  // Register the protocol handlers
  registerPageProtocol();
  registerAudioProtocol();

  setupIpcHandlers();
  setupAlignmentIpc();
  createWindow();

  // Initialize plugin system
  const registry = getPluginRegistry();
  if (mainWindow) {
    registry.setMainWindow(mainWindow);
  }
  await loadBuiltinPlugins(registry);

  // Auto-start library server if configured
  await autoStartLibraryServer();

  // Set up application menu with Quit shortcut (Cmd+Q / Ctrl+Q)
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
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
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
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Track if we've already run cleanup to avoid duplicate work
let cleanupDone = false;

app.on('before-quit', async (event) => {
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

  // Stop library server if running
  if (libraryServer.isRunning()) {
    await libraryServer.stop();
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

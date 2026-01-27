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

let mainWindow: BrowserWindow | null = null;

// Library server config file path
function getLibraryServerConfigPath(): string {
  return path.join(os.homedir(), 'Documents', 'BookForge', 'library-server.json');
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
    // URL format: bookforge-page://path or bookforge-page:///path
    // Extract path after the protocol prefix, handling various formats
    let filePath: string;

    // Simple extraction: remove protocol prefix and decode
    const urlStr = request.url;
    if (urlStr.startsWith('bookforge-page:///')) {
      // Triple slash format: bookforge-page:///Users/...
      filePath = urlStr.substring('bookforge-page://'.length);
    } else if (urlStr.startsWith('bookforge-page://')) {
      // Double slash format: bookforge-page://Users/... - add leading slash
      filePath = '/' + urlStr.substring('bookforge-page://'.length);
    } else {
      filePath = urlStr.replace('bookforge-page:', '');
    }

    filePath = decodeURIComponent(filePath);

    // Normalize to platform-specific separators
    filePath = filePath.split('/').join(path.sep);

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

// Atomic file write - writes to temp file then renames to prevent corruption
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(os.tmpdir(), `bookforge-${Date.now()}-${Math.random().toString(36).substr(2)}.tmp`);
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, filePath);
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
  ipcMain.handle('project:save-to-path', async (_event, filePath: string, projectData: unknown) => {
    try {
      // Extract any embedded images to external files
      await extractEmbeddedImages(projectData as Record<string, unknown>);

      await atomicWriteFile(filePath, JSON.stringify(projectData, null, 2));
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

  // Projects folder management
  // Library folder structure
  const getLibraryRoot = () => {
    const documentsPath = app.getPath('documents');
    return path.join(documentsPath, 'BookForge');
  };

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
      if (existingPath) {
        filePath = existingPath;
        console.log(`Updating existing project: ${filePath}`);
      } else {
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        filePath = path.join(folder, `${safeName}.bfp`);
        console.log(`Creating new project: ${filePath}`);
      }

      // Extract any embedded images to external files
      await extractEmbeddedImages(projectData as Record<string, unknown>);

      await atomicWriteFile(filePath, JSON.stringify(projectData, null, 2));
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
      const filesFolder = getFilesFolder();
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      // Collect all library file hashes that might need deletion
      const libraryFilesToDelete: Array<{ hash: string; libraryPath: string }> = [];

      for (const filePath of filePaths) {
        // Security: only allow deleting files from within the BookForge library root
        // This covers both ~/Documents/BookForge/ and ~/Documents/BookForge/projects/
        if (!filePath.startsWith(libraryRoot)) {
          failed.push({ path: filePath, error: 'Invalid path - outside library folder' });
          continue;
        }

        try {
          // Read the project file to get library_path and file_hash before deleting
          const content = await fs.readFile(filePath, 'utf-8');
          const projectData = JSON.parse(content);

          // Track library file for potential deletion
          if (projectData.library_path && projectData.file_hash) {
            libraryFilesToDelete.push({
              hash: projectData.file_hash,
              libraryPath: projectData.library_path
            });
          }

          // Delete the .bfp project file
          await fs.unlink(filePath);
          deleted.push(filePath);
        } catch (e) {
          failed.push({ path: filePath, error: (e as Error).message });
        }
      }

      // Delete library files and cache for deleted projects
      for (const { hash, libraryPath } of libraryFilesToDelete) {
        console.log(`[projects:delete] Clearing cache for hash: ${hash}`);

        // Delete the source file from library
        if (libraryPath.startsWith(filesFolder)) {
          try {
            await fs.unlink(libraryPath);
            console.log(`[projects:delete] Deleted library file: ${libraryPath}`);
          } catch (e) {
            console.log(`[projects:delete] Could not delete library file: ${(e as Error).message}`);
          }
        }

        // Clear all cache (render + analysis) for this file
        try {
          pdfAnalyzer.clearCache(hash);
          console.log(`[projects:delete] Cache cleared for hash: ${hash}`);
        } catch (e) {
          console.log(`[projects:delete] Could not clear cache: ${(e as Error).message}`);
        }
      }

      if (libraryFilesToDelete.length === 0) {
        console.log(`[projects:delete] WARNING: No library files to delete - projects may not have file_hash set`);
      }

      return { success: true, deleted, failed };
    } catch (err) {
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

  ipcMain.handle('epub:save-modified', async (_event, outputPath: string) => {
    try {
      const { saveModifiedEpub } = await import('./epub-processor.js');
      await saveModifiedEpub(outputPath);
      return { success: true, data: { outputPath } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('epub:edit-text', async (_event, epubPath: string, chapterId: string, oldText: string, newText: string) => {
    try {
      const { editEpubText } = await import('./epub-processor.js');
      const result = await editEpubText(epubPath, chapterId, oldText, newText);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // EPUB export with text removals (for EPUB editor)
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

      const result = await exportEpubWithRemovals(inputPath, removalsMap, finalOutputPath);
      return result;
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Copy EPUB file
  ipcMain.handle('epub:copy-file', async (_event, inputPath: string, outputPath: string) => {
    try {
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
      const { getChapterComparison } = await import('./epub-processor.js');
      const result = await getChapterComparison(originalPath, cleanedPath, chapterId);
      return { success: true, data: result };
    } catch (err) {
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
  ipcMain.handle('ai:replace-text-in-epub', async (_event, epubPath: string, oldText: string, newText: string) => {
    try {
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
      // Initialize logger with library path (default: ~/Documents/BookForge)
      const libraryPath = path.join(os.homedir(), 'Documents', 'BookForge');
      await parallelTtsBridge.initializeLogger(libraryPath);
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
  // Each audiobook is a folder containing: original.epub, cleaned.epub, project.json, output.m4b
  // ─────────────────────────────────────────────────────────────────────────────

  const getAudiobooksBasePath = () => {
    const documentsPath = app.getPath('documents');
    return path.join(documentsPath, 'BookForge', 'audiobooks');
  };

  // Helper to generate a unique project folder name (with timestamp for uniqueness)
  const generateProjectId = (filename: string): string => {
    const baseName = filename.replace(/\.epub$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now().toString(36);
    return `${baseName}_${timestamp}`;
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
          const [hasExported, hasOriginalLegacy, hasCleaned, hasOutput] = await Promise.all([
            fs.access(path.join(folderPath, 'exported.epub')).then(() => true).catch(() => false),
            fs.access(path.join(folderPath, 'original.epub')).then(() => true).catch(() => false),
            fs.access(path.join(folderPath, 'cleaned.epub')).then(() => true).catch(() => false),
            fs.access(path.join(folderPath, 'output.m4b')).then(() => true).catch(() => false)
          ]);
          const hasOriginal = hasExported || hasOriginalLegacy;

          return {
            id: folder.name,
            folderPath,
            originalFilename: projectData.originalFilename,
            metadata: projectData.metadata,
            state: projectData.state,
            hasOriginal,
            hasCleaned,
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

      const [hasExported, hasOriginalLegacy, hasCleaned, hasOutput] = await Promise.all([
        fs.access(path.join(folderPath, 'exported.epub')).then(() => true).catch(() => false),
        fs.access(path.join(folderPath, 'original.epub')).then(() => true).catch(() => false),
        fs.access(path.join(folderPath, 'cleaned.epub')).then(() => true).catch(() => false),
        fs.access(path.join(folderPath, 'output.m4b')).then(() => true).catch(() => false)
      ]);
      const hasOriginal = hasExported || hasOriginalLegacy;

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

    return {
      success: true,
      folderPath,
      originalPath,
      cleanedPath: path.join(folderPath, 'cleaned.epub'),
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

        // Remove old files (exported.epub, original.epub (legacy), cleaned.epub, project.json)
        const filesToRemove = ['exported.epub', 'original.epub', 'cleaned.epub', 'project.json'];
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
          const hasSkippedChunks = await fs.access(skippedChunksFile).then(() => true).catch(() => false);
          return {
            path: epubPath,
            filename: projectData?.originalFilename || folder.name + '.epub',
            size: stats.size,
            addedAt: projectData?.createdAt || stats.mtime.toISOString(),
            projectId: folder.name,
            hasCleaned: await fs.access(path.join(folderPath, 'cleaned.epub')).then(() => true).catch(() => false),
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
      const m4bFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.m4b'));

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
      const projectsFolder = path.join(os.homedir(), 'Documents', 'BookForge', 'projects');
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
            projects.push({
              name: projectName,
              bfpPath,
              audiobookFolder: getAudiobookFolderForProject(projectName),
              status: project.audiobook.status || 'pending',
              exportedAt: project.audiobook.exportedAt,
              cleanedAt: project.audiobook.cleanedAt,
              completedAt: project.audiobook.completedAt,
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
      } = {};

      // Set cleanup mode (default to 'structure' for backwards compatibility)
      cleanupOptions.cleanupMode = aiConfig.cleanupMode || 'structure';

      // Set test mode
      cleanupOptions.testMode = aiConfig.testMode || false;
      console.log('[IPC] Test mode:', aiConfig.testMode, '-> cleanupOptions.testMode:', cleanupOptions.testMode);

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
  ipcMain.handle('queue:save-state', async (_event, queueState: string) => {
    try {
      const bookforgePath = path.join(os.homedir(), 'Documents', 'BookForge');
      await fs.mkdir(bookforgePath, { recursive: true });
      const queueFile = path.join(bookforgePath, 'queue.json');
      await atomicWriteFile(queueFile, queueState);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  ipcMain.handle('queue:load-state', async () => {
    try {
      const queueFile = path.join(os.homedir(), 'Documents', 'BookForge', 'queue.json');
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
      const libraryPath = path.join(os.homedir(), 'Documents', 'BookForge');
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
      console.log('[MAIN] reassembly:scan-sessions returning', result.sessions.length, 'sessions');
      // Log first session for debugging
      if (result.sessions.length > 0) {
        console.log('[MAIN] First session:', JSON.stringify(result.sessions[0], null, 2));
      }
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

  ipcMain.handle('reassembly:is-available', async () => {
    try {
      const { isE2aAvailable } = await import('./reassembly-bridge.js');
      return { success: true, data: { available: isE2aAvailable() } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}

// Register custom protocol as privileged (must be done before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bookforge-page',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
]);

app.whenReady().then(async () => {
  // Register the protocol handler
  registerPageProtocol();

  setupIpcHandlers();
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

app.on('before-quit', async () => {
  // Kill any active TTS workers
  try {
    const { killAllWorkers } = await import('./parallel-tts-bridge.js');
    killAllWorkers();
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
});

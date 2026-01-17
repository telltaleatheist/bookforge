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

let mainWindow: BrowserWindow | null = null;

// Register custom protocol for serving page images from temp files
// This avoids file:// security restrictions
function registerPageProtocol(): void {
  protocol.handle('bookforge-page', async (request) => {
    // URL format: bookforge-page://C:/Users/... (Windows) or bookforge-page:///Users/... (Mac)
    // The URL class parses these differently:
    // - Windows: hostname="C", pathname="/Users/..."
    // - Mac: hostname="Users", pathname="/telltale/..." (first path component becomes host!)
    console.log('[Protocol] Request URL:', request.url);

    let filePath: string;
    try {
      const url = new URL(request.url);
      // On Windows, the drive letter (C:) becomes the hostname
      // pathname will be /Users/... and hostname will be C or c
      if (url.hostname && /^[A-Za-z]$/.test(url.hostname)) {
        // Windows path: reconstruct as C:/path
        filePath = `${url.hostname.toUpperCase()}:${url.pathname}`;
      } else if (url.hostname) {
        // Unix path where first component was parsed as hostname
        // e.g., bookforge-page:///Users/foo -> hostname="Users", pathname="/foo"
        // Reconstruct as /hostname/pathname
        filePath = `/${url.hostname}${url.pathname}`;
      } else {
        // Unix path with empty hostname (shouldn't normally happen but handle it)
        filePath = url.pathname;
      }
      filePath = decodeURIComponent(filePath);
    } catch {
      // Fallback to simple string parsing if URL parsing fails
      filePath = decodeURIComponent(request.url.replace('bookforge-page://', ''));
    }
    console.log('[Protocol] Parsed path:', filePath);

    // Normalize to platform-specific separators
    filePath = filePath.split('/').join(path.sep);
    console.log('[Protocol] Final path:', filePath);

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
    width: 1400,
    height: 900,
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
      const result = await pdfAnalyzer.analyze(pdfPath, maxPages);
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
    fillRegions?: Array<{ x: number; y: number; width: number; height: number }>
  ) => {
    try {
      const image = await pdfAnalyzer.renderPage(pageNum, scale, pdfPath, redactRegions, fillRegions);
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

  ipcMain.handle('pdf:export-pdf', async (
    _event,
    pdfPath: string,
    deletedRegions: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>,
    ocrBlocks?: Array<{page: number; x: number; y: number; width: number; height: number; text: string; font_size: number}>
  ) => {
    try {
      const pdfBase64 = await pdfAnalyzer.exportPdf(pdfPath, deletedRegions, ocrBlocks);
      return { success: true, data: { pdf_base64: pdfBase64 } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:export-pdf-no-backgrounds', async (
    event,
    scale: number = 2.0,
    deletedRegions?: Array<{page: number; x: number; y: number; width: number; height: number; isImage?: boolean}>,
    ocrBlocks?: Array<{page: number; x: number; y: number; width: number; height: number; text: string; font_size: number}>
  ) => {
    try {
      const pdfBase64 = await pdfAnalyzer.exportPdfWithBackgroundsRemoved(
        scale,
        (current, total) => {
          event.sender.send('pdf:export-progress', { current, total });
        },
        deletedRegions,
        ocrBlocks
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
      await atomicWriteFile(filePath, JSON.stringify(projectData, null, 2));
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Open PDF file using native dialog
  ipcMain.handle('dialog:open-pdf', async () => {
    if (!mainWindow) return { success: false, error: 'No window' };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open PDF',
      filters: [
        { name: 'Documents', extensions: ['pdf', 'epub'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, filePath: result.filePaths[0] };
  });

  // Projects folder management
  // Library folder structure
  const getLibraryRoot = () => {
    const documentsPath = app.getPath('documents');
    return path.join(documentsPath, 'BookForge');
  };

  const getProjectsFolder = () => path.join(getLibraryRoot(), 'projects');
  const getFilesFolder = () => path.join(getLibraryRoot(), 'files');

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
                size: stat.size
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

      // Now check which library files can be safely deleted
      // (i.e., no other projects reference them)
      if (libraryFilesToDelete.length > 0) {
        // Get all remaining projects to check for references
        const remainingHashes = new Set<string>();

        const scanForHashes = async (folder: string) => {
          try {
            const entries = await fs.readdir(folder, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isFile() || !entry.name.endsWith('.bfp')) continue;
              const entryPath = path.join(folder, entry.name);
              // Skip if this file was just deleted
              if (deleted.includes(entryPath)) continue;
              try {
                const content = await fs.readFile(entryPath, 'utf-8');
                const data = JSON.parse(content);
                if (data.file_hash) {
                  remainingHashes.add(data.file_hash);
                }
              } catch {
                // Skip unreadable files
              }
            }
          } catch {
            // Folder doesn't exist
          }
        };

        await scanForHashes(projectsFolder);
        await scanForHashes(libraryRoot);

        // Delete library files that are no longer referenced
        for (const { hash, libraryPath } of libraryFilesToDelete) {
          if (!remainingHashes.has(hash) && libraryPath.startsWith(filesFolder)) {
            try {
              await fs.unlink(libraryPath);
            } catch {
              // Library file may not exist or be locked - not critical
            }
          }
        }
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
  // Dispose all plugins
  const registry = getPluginRegistry();
  await registry.disposeAll();
});

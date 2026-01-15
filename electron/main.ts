import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { pdfAnalyzer } from './pdf-analyzer';
import { getOcrService } from './ocr-service';

let mainWindow: BrowserWindow | null = null;

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
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('pdf:render-page', async (_event, pageNum: number, scale: number = 2.0, pdfPath?: string) => {
    try {
      const image = await pdfAnalyzer.renderPage(pageNum, scale, pdfPath);
      return { success: true, data: { image } };
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

  ipcMain.handle('pdf:export-pdf', async (_event, pdfPath: string, deletedRegions: Array<{page: number; x: number; y: number; width: number; height: number}>) => {
    try {
      const pdfBase64 = await pdfAnalyzer.exportPdf(pdfPath, deletedRegions);
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
      await fs.writeFile(result.filePath, JSON.stringify(projectData, null, 2), 'utf-8');
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
      await fs.writeFile(filePath, JSON.stringify(projectData, null, 2), 'utf-8');
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
  const getProjectsFolder = () => {
    const documentsPath = app.getPath('documents');
    return path.join(documentsPath, 'BookForge');
  };

  // Ensure projects folder exists
  ipcMain.handle('projects:ensure-folder', async () => {
    try {
      const folder = getProjectsFolder();
      await fs.mkdir(folder, { recursive: true });
      return { success: true, path: folder };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Get projects folder path
  ipcMain.handle('projects:get-folder', () => {
    return { path: getProjectsFolder() };
  });

  // List all projects in the folder
  ipcMain.handle('projects:list', async () => {
    try {
      const folder = getProjectsFolder();

      // Ensure folder exists
      await fs.mkdir(folder, { recursive: true });

      const entries = await fs.readdir(folder, { withFileTypes: true });
      const projects = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bfp')) continue;

        const filePath = path.join(folder, entry.name);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content);
          const stat = await fs.stat(filePath);

          projects.push({
            name: entry.name.replace('.bfp', ''),
            path: filePath,
            sourcePath: data.source_path,
            sourceName: data.source_name,
            deletedCount: data.deleted_block_ids?.length || 0,
            createdAt: data.created_at,
            modifiedAt: stat.mtime.toISOString(),
            size: stat.size
          });
        } catch {
          // Skip invalid project files
        }
      }

      // Sort by modification date, newest first
      projects.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

      return { success: true, projects };
    } catch (err) {
      return { success: false, error: (err as Error).message, projects: [] };
    }
  });

  // Save project to default folder
  ipcMain.handle('projects:save', async (_event, projectData: unknown, name: string) => {
    try {
      const folder = getProjectsFolder();
      await fs.mkdir(folder, { recursive: true });

      // Sanitize name
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(folder, `${safeName}.bfp`);

      await fs.writeFile(filePath, JSON.stringify(projectData, null, 2), 'utf-8');
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Delete project(s)
  ipcMain.handle('projects:delete', async (_event, filePaths: string[]) => {
    try {
      const folder = getProjectsFolder();
      const deleted = [];
      const failed = [];

      for (const filePath of filePaths) {
        // Security: only allow deleting files from the projects folder
        if (!filePath.startsWith(folder)) {
          failed.push({ path: filePath, error: 'Invalid path' });
          continue;
        }

        try {
          await fs.unlink(filePath);
          deleted.push(filePath);
        } catch (e) {
          failed.push({ path: filePath, error: (e as Error).message });
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

  // Load project from specific path
  ipcMain.handle('projects:load-from-path', async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
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
}

app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();

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

import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script - Exposes safe IPC methods to renderer process
 */

export interface ProjectSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface ProjectLoadResult {
  success: boolean;
  canceled?: boolean;
  data?: unknown;
  filePath?: string;
  error?: string;
}

export interface OpenPdfResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  sourcePath: string;
  sourceName: string;
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
}

export interface ProjectListResult {
  success: boolean;
  projects: ProjectInfo[];
  error?: string;
}

export interface ProjectsDeleteResult {
  success: boolean;
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

export interface ProjectsImportResult {
  success: boolean;
  canceled?: boolean;
  imported: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

export interface PdfAnalyzeResult {
  success: boolean;
  data?: {
    blocks: Array<{
      id: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      font_size: number;
      font_name: string;
      char_count: number;
      region: string;
      category_id: string;
      is_bold: boolean;
      is_italic: boolean;
      is_superscript: boolean;
      is_image: boolean;
      line_count: number;
    }>;
    categories: Record<string, {
      id: string;
      name: string;
      description: string;
      color: string;
      block_count: number;
      char_count: number;
      font_size: number;
      region: string;
      sample_text: string;
      enabled: boolean;
    }>;
    page_count: number;
    page_dimensions: Array<{ width: number; height: number }>;
    pdf_name: string;
  };
  error?: string;
}

export interface OcrResult {
  text: string;
  confidence: number;
}

export interface DeskewResult {
  angle: number;
  confidence: number;
}

export interface ElectronAPI {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    renderPage: (pageNum: number, scale?: number, pdfPath?: string) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    exportText: (enabledCategories: string[]) => Promise<{ success: boolean; data?: { text: string; char_count: number }; error?: string }>;
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number }>) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    findSimilar: (blockId: string) => Promise<{ success: boolean; data?: { similar_ids: string[]; count: number }; error?: string }>;
  };
  fs: {
    browse: (dirPath: string) => Promise<{
      path: string;
      parent: string;
      items: Array<{ name: string; path: string; type: string; size: number | null }>;
    }>;
  };
  project: {
    save: (projectData: unknown, suggestedName?: string) => Promise<ProjectSaveResult>;
    load: () => Promise<ProjectLoadResult>;
    saveToPath: (filePath: string, projectData: unknown) => Promise<ProjectSaveResult>;
  };
  dialog: {
    openPdf: () => Promise<OpenPdfResult>;
  };
  projects: {
    ensureFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
    getFolder: () => Promise<{ path: string }>;
    list: () => Promise<ProjectListResult>;
    save: (projectData: unknown, name: string) => Promise<ProjectSaveResult>;
    delete: (filePaths: string[]) => Promise<ProjectsDeleteResult>;
    import: () => Promise<ProjectsImportResult>;
    export: (projectPath: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    loadFromPath: (filePath: string) => Promise<ProjectLoadResult>;
  };
  ocr: {
    isAvailable: () => Promise<{ success: boolean; available?: boolean; version?: string | null; error?: string }>;
    getLanguages: () => Promise<{ success: boolean; languages?: string[]; error?: string }>;
    recognize: (imageData: string) => Promise<{ success: boolean; data?: OcrResult; error?: string }>;
    detectSkew: (imageData: string) => Promise<{ success: boolean; data?: DeskewResult; error?: string }>;
  };
  platform: string;
}

const electronAPI: ElectronAPI = {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) =>
      ipcRenderer.invoke('pdf:analyze', pdfPath, maxPages),
    renderPage: (pageNum: number, scale: number = 2.0, pdfPath?: string) =>
      ipcRenderer.invoke('pdf:render-page', pageNum, scale, pdfPath),
    exportText: (enabledCategories: string[]) =>
      ipcRenderer.invoke('pdf:export-text', enabledCategories),
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number }>) =>
      ipcRenderer.invoke('pdf:export-pdf', pdfPath, deletedRegions),
    findSimilar: (blockId: string) =>
      ipcRenderer.invoke('pdf:find-similar', blockId),
  },
  fs: {
    browse: (dirPath: string) =>
      ipcRenderer.invoke('fs:browse', dirPath),
  },
  project: {
    save: (projectData: unknown, suggestedName?: string) =>
      ipcRenderer.invoke('project:save', projectData, suggestedName),
    load: () =>
      ipcRenderer.invoke('project:load'),
    saveToPath: (filePath: string, projectData: unknown) =>
      ipcRenderer.invoke('project:save-to-path', filePath, projectData),
  },
  dialog: {
    openPdf: () =>
      ipcRenderer.invoke('dialog:open-pdf'),
  },
  projects: {
    ensureFolder: () =>
      ipcRenderer.invoke('projects:ensure-folder'),
    getFolder: () =>
      ipcRenderer.invoke('projects:get-folder'),
    list: () =>
      ipcRenderer.invoke('projects:list'),
    save: (projectData: unknown, name: string) =>
      ipcRenderer.invoke('projects:save', projectData, name),
    delete: (filePaths: string[]) =>
      ipcRenderer.invoke('projects:delete', filePaths),
    import: () =>
      ipcRenderer.invoke('projects:import'),
    export: (projectPath: string) =>
      ipcRenderer.invoke('projects:export', projectPath),
    loadFromPath: (filePath: string) =>
      ipcRenderer.invoke('projects:load-from-path', filePath),
  },
  ocr: {
    isAvailable: () =>
      ipcRenderer.invoke('ocr:is-available'),
    getLanguages: () =>
      ipcRenderer.invoke('ocr:get-languages'),
    recognize: (imageData: string) =>
      ipcRenderer.invoke('ocr:recognize', imageData),
    detectSkew: (imageData: string) =>
      ipcRenderer.invoke('ocr:detect-skew', imageData),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// Type declaration for renderer
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

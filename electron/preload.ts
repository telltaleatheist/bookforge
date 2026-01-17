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

// Plugin system types
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  available: boolean;
  availabilityDetails?: {
    available: boolean;
    version?: string;
    path?: string;
    error?: string;
    installInstructions?: string;
  };
  settingsSchema: Array<{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'select' | 'path';
    label: string;
    description?: string;
    default: unknown;
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
    placeholder?: string;
  }>;
}

export interface PluginProgress {
  pluginId: string;
  operation: string;
  current: number;
  total: number;
  message?: string;
  percentage?: number;
}

export interface TextSpan {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
  font_name: string;
  is_bold: boolean;
  is_italic: boolean;
  baseline_offset: number;
  block_id: string;
}

// Character class for text matching
type CharClass = 'digits' | 'uppercase' | 'lowercase' | 'mixed_alpha' | 'mixed_alphanum' | 'symbols' | 'mixed';

// Learned fingerprint from sample analysis - captures all discriminating properties
export interface SamplePattern {
  // Font properties (null = don't filter)
  font_size_min: number | null;
  font_size_max: number | null;
  font_size_ratio_to_body: [number, number] | null;
  font_names: string[] | null;
  is_bold: boolean | null;
  is_italic: boolean | null;

  // Text properties
  char_class: CharClass | null;
  length_min: number | null;
  length_max: number | null;

  // Position properties
  baseline_offset_min: number | null;
  baseline_offset_max: number | null;

  // Context properties
  preceded_by: ('space' | 'punctuation' | 'letter' | 'digit' | 'line_start')[] | null;
  followed_by: ('space' | 'punctuation' | 'letter' | 'digit' | 'line_end')[] | null;

  // Metadata
  sample_count: number;
  body_font_size: number;
  description: string;
}

// Lightweight match representation (40 bytes vs 200+ for full TextBlock)
export interface MatchRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;  // Keep text for display/tooltip
}

export interface MatchingSpansResult {
  matches: MatchRect[];  // Lightweight match rects
  matchesByPage: Record<number, MatchRect[]>;  // Grouped by page for O(1) lookup
  total: number;
  pattern: string;  // The pattern that was matched
}

export interface RenderProgressCallback {
  (progress: { current: number; total: number }): void;
}

export interface RenderWithPreviewsResult {
  previewPaths: string[];
  fileHash: string;
}

export interface ElectronAPI {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    renderPage: (pageNum: number, scale?: number, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderBlankPage: (pageNum: number, scale?: number) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderAllPages: (pdfPath: string, scale?: number, concurrency?: number) => Promise<{ success: boolean; data?: { paths: string[] }; error?: string }>;
    renderWithPreviews: (pdfPath: string, concurrency?: number) => Promise<{ success: boolean; data?: RenderWithPreviewsResult; error?: string }>;
    onRenderProgress: (callback: RenderProgressCallback) => () => void;
    onPageUpgraded: (callback: (data: { pageNum: number; path: string }) => void) => () => void;
    onExportProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;
    cleanupTempFiles: () => Promise<{ success: boolean; error?: string }>;
    clearCache: (fileHash: string) => Promise<{ success: boolean; error?: string }>;
    clearAllCache: () => Promise<{ success: boolean; data?: { cleared: number; freedBytes: number }; error?: string }>;
    getCacheSize: (fileHash: string) => Promise<{ success: boolean; data?: { size: number }; error?: string }>;
    getTotalCacheSize: () => Promise<{ success: boolean; data?: { size: number }; error?: string }>;
    exportText: (enabledCategories: string[]) => Promise<{ success: boolean; data?: { text: string; char_count: number }; error?: string }>;
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    exportPdfNoBackgrounds: (scale?: number, deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    findSimilar: (blockId: string) => Promise<{ success: boolean; data?: { similar_ids: string[]; count: number }; error?: string }>;
    findSpansInRect: (page: number, x: number, y: number, width: number, height: number) => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
    analyzeSamples: (sampleSpans: TextSpan[]) => Promise<{ success: boolean; data?: SamplePattern; error?: string }>;
    findMatchingSpans: (pattern: SamplePattern) => Promise<{ success: boolean; data?: MatchingSpansResult; error?: string }>;
    findSpansByRegex: (pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) => Promise<{ success: boolean; data?: MatchingSpansResult; error?: string }>;
    getSpans: () => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
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
  library: {
    importFile: (sourcePath: string) => Promise<{
      success: boolean;
      libraryPath?: string;
      hash?: string;
      alreadyExists?: boolean;
      error?: string;
    }>;
  };
  ocr: {
    isAvailable: () => Promise<{ success: boolean; available?: boolean; version?: string | null; error?: string }>;
    getLanguages: () => Promise<{ success: boolean; languages?: string[]; error?: string }>;
    recognize: (imageData: string) => Promise<{ success: boolean; data?: OcrResult; error?: string }>;
    detectSkew: (imageData: string) => Promise<{ success: boolean; data?: DeskewResult; error?: string }>;
  };
  window: {
    hide: () => Promise<{ success: boolean }>;
    close: () => Promise<{ success: boolean }>;
  };
  plugins: {
    list: () => Promise<{ success: boolean; data?: PluginInfo[]; error?: string }>;
    getSettings: (pluginId: string) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
    updateSettings: (pluginId: string, settings: Record<string, unknown>) => Promise<{ success: boolean; errors?: string[]; error?: string }>;
    checkAvailability: (pluginId: string) => Promise<{ success: boolean; data?: { available: boolean; version?: string; path?: string; error?: string; installInstructions?: string }; error?: string }>;
    invoke: (pluginId: string, channel: string, ...args: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    onProgress: (callback: (progress: PluginProgress) => void) => () => void;
  };
  platform: string;
}

const electronAPI: ElectronAPI = {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) =>
      ipcRenderer.invoke('pdf:analyze', pdfPath, maxPages),
    renderPage: (pageNum: number, scale: number = 2.0, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>) =>
      ipcRenderer.invoke('pdf:render-page', pageNum, scale, pdfPath, redactRegions, fillRegions),
    renderBlankPage: (pageNum: number, scale: number = 2.0) =>
      ipcRenderer.invoke('pdf:render-blank-page', pageNum, scale),
    renderAllPages: (pdfPath: string, scale: number = 2.0, concurrency: number = 4) =>
      ipcRenderer.invoke('pdf:render-all-pages', pdfPath, scale, concurrency),
    renderWithPreviews: (pdfPath: string, concurrency: number = 4) =>
      ipcRenderer.invoke('pdf:render-with-previews', pdfPath, concurrency),
    onRenderProgress: (callback: RenderProgressCallback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; phase?: string }) => {
        callback(progress);
      };
      ipcRenderer.on('pdf:render-progress', listener);
      return () => {
        ipcRenderer.removeListener('pdf:render-progress', listener);
      };
    },
    onPageUpgraded: (callback: (data: { pageNum: number; path: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { pageNum: number; path: string }) => {
        callback(data);
      };
      ipcRenderer.on('pdf:page-upgraded', listener);
      return () => {
        ipcRenderer.removeListener('pdf:page-upgraded', listener);
      };
    },
    onExportProgress: (callback: (progress: { current: number; total: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number }) => {
        callback(progress);
      };
      ipcRenderer.on('pdf:export-progress', listener);
      return () => {
        ipcRenderer.removeListener('pdf:export-progress', listener);
      };
    },
    cleanupTempFiles: () =>
      ipcRenderer.invoke('pdf:cleanup-temp-files'),
    clearCache: (fileHash: string) =>
      ipcRenderer.invoke('pdf:clear-cache', fileHash),
    clearAllCache: () =>
      ipcRenderer.invoke('pdf:clear-all-cache'),
    getCacheSize: (fileHash: string) =>
      ipcRenderer.invoke('pdf:get-cache-size', fileHash),
    getTotalCacheSize: () =>
      ipcRenderer.invoke('pdf:get-total-cache-size'),
    exportText: (enabledCategories: string[]) =>
      ipcRenderer.invoke('pdf:export-text', enabledCategories),
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>) =>
      ipcRenderer.invoke('pdf:export-pdf', pdfPath, deletedRegions, ocrBlocks),
    exportPdfNoBackgrounds: (scale: number = 2.0, deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>) =>
      ipcRenderer.invoke('pdf:export-pdf-no-backgrounds', scale, deletedRegions, ocrBlocks),
    findSimilar: (blockId: string) =>
      ipcRenderer.invoke('pdf:find-similar', blockId),
    findSpansInRect: (page: number, x: number, y: number, width: number, height: number) =>
      ipcRenderer.invoke('pdf:find-spans-in-rect', page, x, y, width, height),
    analyzeSamples: (sampleSpans: TextSpan[]) =>
      ipcRenderer.invoke('pdf:analyze-samples', sampleSpans),
    findMatchingSpans: (pattern: SamplePattern) =>
      ipcRenderer.invoke('pdf:find-matching-spans', pattern),
    findSpansByRegex: (pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) =>
      ipcRenderer.invoke('pdf:find-spans-by-regex', pattern, minFontSize, maxFontSize, minBaseline, maxBaseline, caseSensitive),
    getSpans: () =>
      ipcRenderer.invoke('pdf:get-spans'),
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
  library: {
    importFile: (sourcePath: string) =>
      ipcRenderer.invoke('library:import-file', sourcePath),
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
  window: {
    hide: () =>
      ipcRenderer.invoke('window:hide'),
    close: () =>
      ipcRenderer.invoke('window:close'),
  },
  plugins: {
    list: () =>
      ipcRenderer.invoke('plugins:list'),
    getSettings: (pluginId: string) =>
      ipcRenderer.invoke('plugins:get-settings', pluginId),
    updateSettings: (pluginId: string, settings: Record<string, unknown>) =>
      ipcRenderer.invoke('plugins:update-settings', pluginId, settings),
    checkAvailability: (pluginId: string) =>
      ipcRenderer.invoke('plugins:check-availability', pluginId),
    invoke: (pluginId: string, channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(`plugin:${pluginId}:${channel}`, ...args),
    onProgress: (callback: (progress: PluginProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: PluginProgress) => {
        callback(progress);
      };
      ipcRenderer.on('plugin:progress', listener);
      // Return unsubscribe function
      return () => {
        ipcRenderer.removeListener('plugin:progress', listener);
      };
    },
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

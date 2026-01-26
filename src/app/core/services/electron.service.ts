import { Injectable } from '@angular/core';

// Lightweight match rectangle for custom category highlights
interface MatchRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

// Result from findMatchingSpans
interface MatchingSpansResult {
  matches: MatchRect[];
  matchesByPage: Record<number, MatchRect[]>;
  total: number;
  pattern: string;
}

// Chapter structure for TOC extraction and chapter marking
export interface Chapter {
  id: string;
  title: string;
  page: number;              // 0-indexed
  blockId?: string;          // Linked text block
  y?: number;                // Y position for ordering within page
  level: number;             // 1=chapter, 2=section, 3+=subsection
  source: 'toc' | 'heuristic' | 'manual';
  confidence?: number;       // 0-1 for heuristic detection
}

// Outline item from PDF TOC
export interface OutlineItem {
  title: string;
  page: number;              // 0-indexed
  down?: OutlineItem[];      // Nested children
}

interface BrowseResult {
  path: string;
  parent: string;
  items: Array<{ name: string; path: string; type: string; size: number | null }>;
}

interface PdfAnalyzeResult {
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

interface PdfRenderResult {
  success: boolean;
  data?: { image: string };
  error?: string;
}

interface PdfExportResult {
  success: boolean;
  data?: { pdf_base64: string };
  error?: string;
}

interface ProjectSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

interface ProjectLoadResult {
  success: boolean;
  canceled?: boolean;
  data?: unknown;
  filePath?: string;
  error?: string;
}

interface OpenPdfResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

interface ProjectInfo {
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
  coverImage?: string;  // Base64 cover image from project metadata
}

interface ProjectListResult {
  success: boolean;
  projects: ProjectInfo[];
  error?: string;
}

interface ProjectsDeleteResult {
  success: boolean;
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

interface ProjectsImportResult {
  success: boolean;
  canceled?: boolean;
  imported: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
}

interface OcrParagraph {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
  lineCount: number;
  blockNum: number;
  parNum: number;
}

interface OcrResult {
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];
  paragraphs?: OcrParagraph[];  // Tesseract's native paragraph grouping
}

interface DeskewResult {
  angle: number;
  confidence: number;
}

// Layout detection categories from Surya
export type LayoutLabel =
  | 'Caption'
  | 'Footnote'
  | 'Formula'
  | 'List-item'
  | 'Page-footer'
  | 'Page-header'
  | 'Picture'
  | 'Figure'
  | 'Section-header'
  | 'Table'
  | 'Form'
  | 'Table-of-contents'
  | 'Handwriting'
  | 'Text'
  | 'Text-inline-math'
  | 'Title';

export interface LayoutBlock {
  bbox: [number, number, number, number];
  polygon: number[][];
  label: LayoutLabel;
  confidence: number;
  position: number;
  text?: string;
}

/**
 * ElectronService - Provides access to Electron IPC from Angular
 *
 * In browser mode (ng serve without Electron), provides mock implementations
 * for development and testing.
 */
@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  private readonly isElectron: boolean;

  constructor() {
    this.isElectron = !!(window as any).electron;
  }

  get isRunningInElectron(): boolean {
    return this.isElectron;
  }

  get platform(): string {
    if (this.isElectron) {
      return (window as any).electron.platform;
    }
    return 'browser';
  }

  // File system operations
  async browse(dirPath: string): Promise<BrowseResult> {
    if (this.isElectron) {
      return (window as any).electron.fs.browse(dirPath);
    }

    // Mock for browser development - call HTTP API
    const response = await fetch(`http://localhost:5848/api/browse?path=${encodeURIComponent(dirPath)}`);
    return response.json();
  }

  // Read a file as binary data (ArrayBuffer)
  async readFileBinary(filePath: string): Promise<{ success: boolean; data?: ArrayBuffer; error?: string }> {
    if (this.isElectron) {
      const result = await (window as any).electron.fs.readBinary(filePath);
      if (result.success && result.data) {
        // Convert Uint8Array to ArrayBuffer
        return { success: true, data: result.data.buffer };
      }
      return result;
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // PDF operations (pure TypeScript - no Python!)
  async analyzePdf(pdfPath: string, maxPages?: number): Promise<PdfAnalyzeResult> {
    if (this.isElectron) {
      return (window as any).electron.pdf.analyze(pdfPath, maxPages);
    }

    // HTTP fallback for browser mode
    console.warn('PDF analyze not available in browser mode');
    return { success: false, error: 'Not running in Electron' };
  }

  async renderPage(
    pageNum: number,
    scale: number = 2.0,
    pdfPath?: string,
    redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>,
    fillRegions?: Array<{ x: number; y: number; width: number; height: number }>,
    removeBackground?: boolean
  ): Promise<string | null> {
    if (this.isElectron) {
      const result: PdfRenderResult = await (window as any).electron.pdf.renderPage(pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground);
      if (result.success && result.data?.image) {
        return `data:image/png;base64,${result.data.image}`;
      }
      console.error('Failed to render page:', result.error);
      return null;
    }

    // HTTP fallback for browser mode
    return `http://localhost:5848/api/page/${pageNum}?scale=${scale}`;
  }

  /**
   * Render a blank white page (for removing background images)
   */
  async renderBlankPage(pageNum: number, scale: number = 2.0): Promise<string | null> {
    if (this.isElectron) {
      const result: PdfRenderResult = await (window as any).electron.pdf.renderBlankPage(pageNum, scale);
      if (result.success && result.data?.image) {
        return `data:image/png;base64,${result.data.image}`;
      }
      console.error('Failed to render blank page:', result.error);
      return null;
    }
    return null;
  }

  /**
   * Render all pages to temp files upfront.
   * Returns array of file paths indexed by page number.
   * Use onRenderProgress to get progress updates.
   */
  async renderAllPages(
    pdfPath: string,
    scale: number = 2.0,
    concurrency: number = 4
  ): Promise<string[] | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.renderAllPages(pdfPath, scale, concurrency);
      if (result.success && result.data?.paths) {
        return result.data.paths;
      }
      console.error('Failed to render all pages:', result.error);
      return null;
    }
    return null;
  }

  /**
   * Subscribe to render progress updates.
   * Returns unsubscribe function.
   */
  onRenderProgress(callback: (progress: { current: number; total: number; phase?: string }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.pdf.onRenderProgress(callback);
    }
    return () => {};
  }

  /**
   * Subscribe to PDF analysis progress updates.
   * Returns unsubscribe function.
   */
  onAnalyzeProgress(callback: (progress: { phase: string; message: string }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.pdf.onAnalyzeProgress(callback);
    }
    return () => {};
  }

  /**
   * Subscribe to page upgrade notifications (when high-res replaces preview).
   * Returns unsubscribe function.
   */
  onPageUpgraded(callback: (data: { pageNum: number; path: string }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.pdf.onPageUpgraded(callback);
    }
    return () => {};
  }

  /**
   * Subscribe to export progress notifications.
   * Returns unsubscribe function.
   */
  onExportProgress(callback: (progress: { current: number; total: number }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.pdf.onExportProgress(callback);
    }
    return () => {};
  }

  /**
   * Render with two-tier approach: fast previews first, then high-res in background.
   * Returns preview paths immediately.
   */
  async renderWithPreviews(
    pdfPath: string,
    concurrency: number = 4
  ): Promise<{ previewPaths: string[]; fileHash: string } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.renderWithPreviews(pdfPath, concurrency);
      if (result.success && result.data) {
        return result.data;
      }
      console.error('Failed to render with previews:', result.error);
      return null;
    }
    return null;
  }

  /**
   * Clean up temp files from previous render session (legacy, now no-op).
   */
  async cleanupTempFiles(): Promise<void> {
    if (this.isElectron) {
      await (window as any).electron.pdf.cleanupTempFiles();
    }
  }

  /**
   * Clear cache for a specific file.
   */
  async clearCache(fileHash: string): Promise<void> {
    if (this.isElectron) {
      await (window as any).electron.pdf.clearCache(fileHash);
    }
  }

  /**
   * Clear all cached data.
   */
  async clearAllCache(): Promise<{ cleared: number; freedBytes: number } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.clearAllCache();
      if (result.success && result.data) {
        return result.data;
      }
    }
    return null;
  }

  /**
   * Get cache size for a specific file.
   */
  async getCacheSize(fileHash: string): Promise<number> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.getCacheSize(fileHash);
      if (result.success && result.data) {
        return result.data.size;
      }
    }
    return 0;
  }

  /**
   * Get total cache size.
   */
  async getTotalCacheSize(): Promise<number> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.getTotalCacheSize();
      if (result.success && result.data) {
        return result.data.size;
      }
    }
    return 0;
  }

  async exportPdfText(enabledCategories: string[]): Promise<{ text: string; char_count: number } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.exportText(enabledCategories);
      if (result.success && result.data) {
        return result.data;
      }
      console.error('Failed to export text:', result.error);
      return null;
    }
    return null;
  }

  async exportTextOnlyEpub(pdfPath: string, metadata?: { title?: string; author?: string }): Promise<{ success: boolean; data?: string; error?: string }> {
    if (this.isElectron) {
      return await (window as any).electron.pdf.exportTextOnlyEpub(pdfPath, metadata);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async exportCleanPdf(
    pdfPath: string,
    deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>,
    ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>,
    deletedPages?: number[],
    chapters?: Array<{ title: string; page: number; level: number }>
  ): Promise<string> {
    if (this.isElectron) {
      const result: PdfExportResult = await (window as any).electron.pdf.exportPdf(pdfPath, deletedRegions, ocrBlocks, deletedPages, chapters);
      if (result.success && result.data?.pdf_base64) {
        return result.data.pdf_base64;
      }
      const errorMsg = result.error || 'Unknown error';
      console.error('Failed to export PDF:', errorMsg);
      throw new Error(errorMsg);
    }
    throw new Error('PDF export not available in browser mode');
  }

  /**
   * Export PDF with backgrounds removed (yellowed paper -> white)
   * Creates a new PDF from processed page images
   * Optionally accepts deleted regions to apply as redactions before rendering
   * Optionally accepts OCR blocks to embed as real text (survives image deletion)
   */
  async exportPdfNoBackgrounds(
    scale: number = 2.0,
    deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>,
    ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>,
    deletedPages?: number[]
  ): Promise<string> {
    if (this.isElectron) {
      const result: PdfExportResult = await (window as any).electron.pdf.exportPdfNoBackgrounds(scale, deletedRegions, ocrBlocks, deletedPages);
      if (result.success && result.data?.pdf_base64) {
        return result.data.pdf_base64;
      }
      const errorMsg = result.error || 'Unknown error';
      console.error('Failed to export PDF with backgrounds removed:', errorMsg);
      throw new Error(errorMsg);
    }
    throw new Error('PDF export not available in browser mode');
  }

  /**
   * Export PDF with WYSIWYG rendering - exactly what the viewer shows
   * Renders each page as an image (with all deletions applied at pixel level),
   * then creates a new PDF from those images. Guarantees visual fidelity.
   * For pages with deleted background images, renders OCR text on white background.
   */
  async exportPdfWysiwyg(
    deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>,
    deletedPages?: number[],
    scale: number = 2.0,
    ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>
  ): Promise<string> {
    if (this.isElectron) {
      const result: PdfExportResult = await (window as any).electron.pdf.exportPdfWysiwyg(deletedRegions, deletedPages, scale, ocrPages);
      if (result.success && result.data?.pdf_base64) {
        return result.data.pdf_base64;
      }
      const errorMsg = result.error || 'Unknown error';
      console.error('Failed to export PDF (WYSIWYG):', errorMsg);
      throw new Error(errorMsg);
    }
    throw new Error('PDF export not available in browser mode');
  }

  async findSimilarBlocks(blockId: string): Promise<{ similar_ids: string[]; count: number } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.findSimilar(blockId);
      if (result.success && result.data) {
        return result.data;
      }
      return null;
    }
    return null;
  }

  // Sample mode operations for custom category creation
  async findSpansInRect(page: number, x: number, y: number, width: number, height: number): Promise<{ data?: any[] } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.findSpansInRect(page, x, y, width, height);
      if (result.success) {
        return { data: result.data };
      }
    }
    return null;
  }

  async analyzeSamples(sampleSpans: any[]): Promise<{ data?: any } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.analyzeSamples(sampleSpans);
      if (result.success) {
        return { data: result.data };
      }
    }
    return null;
  }

  async findMatchingSpans(pattern: any): Promise<{ data?: MatchingSpansResult } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.findMatchingSpans(pattern);
      if (result.success) {
        return { data: result.data };
      }
    }
    return null;
  }

  async findSpansByRegex(
    pattern: string,
    minFontSize: number,
    maxFontSize: number,
    minBaseline: number | null = null,
    maxBaseline: number | null = null,
    caseSensitive: boolean = false
  ): Promise<{ data?: MatchingSpansResult } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.findSpansByRegex(pattern, minFontSize, maxFontSize, minBaseline, maxBaseline, caseSensitive);
      if (result.success) {
        return { data: result.data };
      }
    }
    return null;
  }

  /**
   * Update spans for a page that has been OCR'd.
   * This allows custom category matching to search OCR text with correct coordinates.
   */
  async updateSpansForOcr(
    pageNum: number,
    ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>
  ): Promise<boolean> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.updateSpansForOcr(pageNum, ocrBlocks);
      return result.success;
    }
    return false;
  }

  // Chapter detection operations
  async extractOutline(): Promise<OutlineItem[]> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.extractOutline();
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async outlineToChapters(outline: OutlineItem[]): Promise<Chapter[]> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.outlineToChapters(outline);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async detectChapters(): Promise<Chapter[]> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.detectChapters();
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async addBookmarksToPdf(pdfBase64: string, chapters: Chapter[]): Promise<string | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.addBookmarks(pdfBase64, chapters);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return null;
  }

  // Project file operations
  async saveProject(projectData: unknown, suggestedName?: string): Promise<ProjectSaveResult> {
    if (this.isElectron) {
      return (window as any).electron.project.save(projectData, suggestedName);
    }

    // Browser fallback - download as file
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName || 'project.bfp';
    a.click();
    URL.revokeObjectURL(url);
    return { success: true, filePath: suggestedName };
  }

  async loadProject(): Promise<ProjectLoadResult> {
    if (this.isElectron) {
      return (window as any).electron.project.load();
    }

    // Browser fallback - file input
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.bfp';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ success: false, canceled: true });
          return;
        }
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          resolve({ success: true, data, filePath: file.name });
        } catch (err) {
          resolve({ success: false, error: (err as Error).message });
        }
      };
      input.oncancel = () => resolve({ success: false, canceled: true });
      input.click();
    });
  }

  async saveProjectToPath(filePath: string, projectData: unknown): Promise<ProjectSaveResult> {
    if (this.isElectron) {
      return (window as any).electron.project.saveToPath(filePath, projectData);
    }
    // Browser mode can't save to specific path
    return this.saveProject(projectData);
  }

  // Native file dialog for opening PDFs
  async openPdfDialog(): Promise<OpenPdfResult> {
    if (this.isElectron) {
      return (window as any).electron.dialog.openPdf();
    }

    // Browser fallback - file input
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ success: false, canceled: true });
          return;
        }
        // In browser mode, we can't get the actual file path
        // but we can get the file object
        const filePath = (file as any).path || file.name;
        resolve({ success: true, filePath });
      };
      input.oncancel = () => resolve({ success: false, canceled: true });
      input.click();
    });
  }

  // Native folder dialog
  async openFolderDialog(): Promise<{ success: boolean; canceled?: boolean; folderPath?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.dialog.openFolder();
    }
    return { success: false, error: 'Folder selection not available in browser mode' };
  }

  // Projects folder management
  async projectsEnsureFolder(): Promise<{ success: boolean; path?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.projects.ensureFolder();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async projectsGetFolder(): Promise<{ path: string }> {
    if (this.isElectron) {
      return (window as any).electron.projects.getFolder();
    }
    return { path: '' };
  }

  async projectsList(): Promise<ProjectListResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.list();
    }
    return { success: false, projects: [], error: 'Not running in Electron' };
  }

  async projectsSave(projectData: unknown, name: string): Promise<ProjectSaveResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.save(projectData, name);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async projectsDelete(filePaths: string[]): Promise<ProjectsDeleteResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.delete(filePaths);
    }
    return { success: false, deleted: [], failed: [], error: 'Not running in Electron' };
  }

  async projectsImport(): Promise<ProjectsImportResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.import();
    }
    return { success: false, imported: [], failed: [], error: 'Not running in Electron' };
  }

  async projectsExport(projectPath: string): Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.projects.export(projectPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async projectsLoadFromPath(filePath: string): Promise<ProjectLoadResult> {
    if (this.isElectron) {
      return (window as any).electron.projects.loadFromPath(filePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // Library operations - copy files to library folder
  async libraryImportFile(sourcePath: string): Promise<{
    success: boolean;
    libraryPath?: string;
    hash?: string;
    alreadyExists?: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.library.importFile(sourcePath);
    }
    // In browser mode, just return the original path
    return { success: true, libraryPath: sourcePath, alreadyExists: false };
  }

  /**
   * Copy a file to the audiobook producer queue folder
   */
  async copyToAudiobookQueue(sourcePath: string, filename: string): Promise<{
    success: boolean;
    destinationPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.library.copyToQueue(sourcePath, filename);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Load project metadata from the audiobook project folder.
   * Returns deleted block examples if they exist (for detailed AI cleanup).
   */
  async loadProjectMetadata(epubPath: string): Promise<{
    title?: string;
    author?: string;
    language?: string;
    coverPath?: string;
    deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
  } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.library.loadMetadata(epubPath);
      if (result.success && result.metadata) {
        return result.metadata;
      }
    }
    return null;
  }

  /**
   * Load deleted block examples from the source BFP project file.
   * This allows using deletion examples from existing projects without re-exporting.
   */
  async loadDeletedExamplesFromBfp(epubPath: string): Promise<Array<{ text: string; category: string; page?: number }> | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.library.loadDeletedExamplesFromBfp(epubPath);
      if (result.success && result.examples) {
        return result.examples;
      }
    }
    return null;
  }

  // OCR operations (Tesseract)
  async ocrIsAvailable(): Promise<{ available: boolean; version: string | null }> {
    if (this.isElectron) {
      const result = await (window as any).electron.ocr.isAvailable();
      if (result.success) {
        return { available: result.available ?? false, version: result.version ?? null };
      }
    }
    return { available: false, version: null };
  }

  async ocrGetLanguages(): Promise<string[]> {
    if (this.isElectron) {
      const result = await (window as any).electron.ocr.getLanguages();
      if (result.success && result.languages) {
        return result.languages;
      }
    }
    return ['eng'];
  }

  async ocrRecognize(imageData: string): Promise<OcrResult | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.ocr.recognize(imageData);
      if (result.success && result.data) {
        return result.data;
      }
      console.error('OCR failed:', result.error);
    }
    return null;
  }

  async ocrDetectSkew(imageData: string): Promise<DeskewResult | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.ocr.detectSkew(imageData);
      if (result.success && result.data) {
        return result.data;
      }
      console.error('Skew detection failed:', result.error);
    }
    return null;
  }

  /**
   * Process a PDF for OCR in headless mode (without rendering to UI)
   * Processes one page at a time to minimize memory usage
   */
  async ocrProcessPdfHeadless(
    pdfPath: string,
    options: {
      engine: 'tesseract' | 'surya';
      language?: string;
      pages?: number[];
    }
  ): Promise<Array<{
    page: number;
    text: string;
    confidence: number;
    textLines?: OcrTextLine[];
    layoutBlocks?: any[];
  }> | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.ocr.processPdfHeadless(pdfPath, options);
      if (result.success && result.results) {
        return result.results;
      }
      console.error('Headless OCR failed:', result.error);
    }
    return null;
  }

  /**
   * Subscribe to headless OCR progress updates
   */
  onHeadlessOcrProgress(callback: (data: { current: number; total: number }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.ocr.onHeadlessProgress(callback);
    }
    return () => {};
  }

  // Window control operations
  async windowHide(): Promise<void> {
    if (this.isElectron) {
      await (window as any).electron.window.hide();
    }
  }

  async windowClose(): Promise<void> {
    if (this.isElectron) {
      await (window as any).electron.window.close();
    }
  }

  // AI operations
  async checkAIConnection(provider: 'ollama' | 'claude' | 'openai'): Promise<{
    available: boolean;
    error?: string;
    models?: string[];
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.ai.checkProviderConnection(provider);
      if (result.success && result.data) {
        return result.data;
      }
      return { available: false, error: result.error || 'Connection failed' };
    }
    return { available: false, error: 'Not running in Electron' };
  }

  async getAIPrompt(): Promise<{ prompt: string; filePath: string } | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.ai.getPrompt();
      if (result.success && result.data) {
        return result.data;
      }
    }
    return null;
  }

  async saveAIPrompt(prompt: string): Promise<boolean> {
    if (this.isElectron) {
      const result = await (window as any).electron.ai.savePrompt(prompt);
      return result.success;
    }
    return false;
  }

  async getClaudeModels(apiKey: string): Promise<{
    success: boolean;
    models?: { value: string; label: string }[];
    error?: string;
  }> {
    if (this.isElectron) {
      return await (window as any).electron.ai.getClaudeModels(apiKey);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async loadSkippedChunks(jsonPath: string): Promise<{
    success: boolean;
    chunks?: Array<{
      chapterTitle: string;
      chunkIndex: number;
      overallChunkNumber: number;
      totalChunks: number;
      reason: 'copyright' | 'content-skip' | 'ai-refusal';
      text: string;
      aiResponse?: string;
    }>;
    error?: string;
  }> {
    if (this.isElectron) {
      return await (window as any).electron.ai.loadSkippedChunks(jsonPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async replaceTextInEpub(epubPath: string, oldText: string, newText: string): Promise<{
    success: boolean;
    chapterFound?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return await (window as any).electron.ai.replaceTextInEpub(epubPath, oldText, newText);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async updateSkippedChunk(jsonPath: string, index: number, newText: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return await (window as any).electron.ai.updateSkippedChunk(jsonPath, index, newText);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // Diff comparison operations (for AI cleanup diff view)
  // Legacy method - loads all chapters at once (can cause OOM on large EPUBs)
  async loadDiffComparison(originalPath: string, cleanedPath: string): Promise<{
    success: boolean;
    chapters?: Array<{
      id: string;
      title: string;
      originalText: string;
      cleanedText: string;
    }>;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.loadComparison(originalPath, cleanedPath);
      if (result.success && result.data) {
        return { success: true, chapters: result.data.chapters };
      }
      return { success: false, error: result.error || 'Failed to load comparison' };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Memory-efficient: Get only chapter metadata (no text content)
   * Use this instead of loadDiffComparison to avoid OOM on large EPUBs
   */
  async getDiffMetadata(originalPath: string, cleanedPath: string): Promise<{
    success: boolean;
    chapters?: Array<{
      id: string;
      title: string;
      hasOriginal: boolean;
      hasCleaned: boolean;
    }>;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.getMetadata(originalPath, cleanedPath);
      if (result.success && result.data) {
        return { success: true, chapters: result.data.chapters };
      }
      return { success: false, error: result.error || 'Failed to load diff metadata' };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Memory-efficient: Load a single chapter's text on demand
   * Call this when user selects a chapter to view
   */
  async getDiffChapter(originalPath: string, cleanedPath: string, chapterId: string): Promise<{
    success: boolean;
    originalText?: string;
    cleanedText?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.getChapter(originalPath, cleanedPath, chapterId);
      if (result.success && result.data) {
        return {
          success: true,
          originalText: result.data.originalText,
          cleanedText: result.data.cleanedText
        };
      }
      return { success: false, error: result.error || 'Failed to load chapter' };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Compute word-level diff using system diff command (much more efficient)
   * This runs in the main process using native diff, avoiding JS memory issues
   */
  async computeSystemDiff(originalText: string, cleanedText: string): Promise<{
    success: boolean;
    segments?: Array<{ text: string; type: 'unchanged' | 'added' | 'removed' }>;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.computeSystemDiff(originalText, cleanedText);
      if (result.success) {
        return { success: true, segments: result.data };
      }
      return { success: false, error: result.error || 'Failed to compute diff' };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Subscribe to diff loading progress events
   */
  onDiffLoadProgress(callback: (progress: {
    phase: 'loading-original' | 'loading-cleaned' | 'complete';
    currentChapter: number;
    totalChapters: number;
    chapterTitle?: string;
  }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.diff.onLoadProgress(callback);
    }
    return () => {}; // No-op for non-Electron
  }

  /**
   * Save diff cache to disk
   */
  async saveDiffCache(originalPath: string, cleanedPath: string, chapterId: string, cacheData: unknown): Promise<boolean> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.saveCache(originalPath, cleanedPath, chapterId, cacheData);
      return result.success;
    }
    return false;
  }

  /**
   * Load diff cache from disk
   */
  async loadDiffCache(originalPath: string, cleanedPath: string, chapterId: string): Promise<{
    success: boolean;
    data?: unknown;
    notFound?: boolean;
  }> {
    if (this.isElectron) {
      return await (window as any).electron.diff.loadCache(originalPath, cleanedPath, chapterId);
    }
    return { success: false, notFound: true };
  }

  /**
   * Clear diff cache for a book pair
   */
  async clearDiffCache(originalPath: string, cleanedPath: string): Promise<boolean> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.clearCache(originalPath, cleanedPath);
      return result.success;
    }
    return false;
  }

  /**
   * Get cache key for a book pair (to check if cache is valid)
   */
  async getDiffCacheKey(originalPath: string, cleanedPath: string): Promise<string | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.getCacheKey(originalPath, cleanedPath);
      return result.success ? result.cacheKey : null;
    }
    return null;
  }

  // Ebook conversion operations (Calibre CLI integration)
  async isEbookConvertAvailable(): Promise<boolean> {
    if (this.isElectron) {
      const result = await (window as any).electron.ebookConvert.isAvailable();
      return result.success && result.data?.available === true;
    }
    return false;
  }

  async getEbookSupportedExtensions(): Promise<string[]> {
    if (this.isElectron) {
      const result = await (window as any).electron.ebookConvert.getSupportedExtensions();
      if (result.success && result.data) {
        return result.data;
      }
    }
    return ['.epub', '.pdf']; // Fallback to native formats only
  }

  async isEbookConvertible(filePath: string): Promise<{ convertible: boolean; native: boolean }> {
    if (this.isElectron) {
      const result = await (window as any).electron.ebookConvert.isConvertible(filePath);
      if (result.success && result.data) {
        return result.data;
      }
    }
    // Fallback: check extension manually for native formats
    const ext = filePath.toLowerCase().split('.').pop();
    return {
      convertible: false,
      native: ext === 'epub' || ext === 'pdf'
    };
  }

  async convertEbook(inputPath: string, outputDir?: string): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.ebookConvert.convert(inputPath, outputDir);
      if (result.success && result.data) {
        return { success: true, outputPath: result.data.outputPath };
      }
      return { success: false, error: result.error || 'Conversion failed' };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async convertEbookToLibrary(inputPath: string): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.ebookConvert.convertToLibrary(inputPath);
      if (result.success && result.data) {
        return { success: true, outputPath: result.data.outputPath };
      }
      return { success: false, error: result.error || 'Conversion failed' };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // Audiobook project operations
  async deleteAudiobookProject(projectId: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.deleteProject(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // EPUB export operations (for EPUB editor)
  async exportEpubWithRemovals(
    inputPath: string,
    removals: Map<string, Array<{ chapterId: string; text: string; cfi: string }>>,
    outputPath?: string
  ): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      // Convert Map to plain object for IPC
      const removalsObj: Record<string, Array<{ chapterId: string; text: string; cfi: string }>> = {};
      removals.forEach((entries, chapterId) => {
        removalsObj[chapterId] = entries;
      });

      return (window as any).electron.epub.exportWithRemovals(inputPath, removalsObj, outputPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async copyFile(inputPath: string, outputPath: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.epub.copyFile(inputPath, outputPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // EPUB export with block deletions (for EPUB editor block-based deletion)
  async exportEpubWithDeletedBlocks(
    inputPath: string,
    deletedBlockIds: string[],
    outputPath?: string
  ): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.epub.exportWithDeletedBlocks(inputPath, deletedBlockIds, outputPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async showSaveEpubDialog(defaultName?: string): Promise<{
    success: boolean;
    canceled?: boolean;
    filePath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.dialog.saveEpub(defaultName);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async showSaveTextDialog(defaultName?: string): Promise<{
    success: boolean;
    canceled?: boolean;
    filePath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.dialog.saveText(defaultName);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async writeTextFile(filePath: string, content: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.fs.writeText(filePath, content);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // Shell operations
  async showItemInFolder(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.shell.showItemInFolder(filePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async openPath(filePath: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.shell.openPath(filePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Play Tab operations (XTTS Streaming)
  // ─────────────────────────────────────────────────────────────────────────────

  async playStartSession(): Promise<{
    success: boolean;
    voices?: string[];
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.play.startSession();
      if (result.success && result.data) {
        return { success: true, voices: result.data.voices };
      }
      return { success: false, error: result.error };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async playLoadVoice(voice: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.play.loadVoice(voice);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async playGenerateSentence(
    text: string,
    sentenceIndex: number,
    settings: {
      voice: string;
      speed: number;
      temperature?: number;
      topP?: number;
      repetitionPenalty?: number;
    }
  ): Promise<{
    success: boolean;
    audio?: {
      data: string;
      duration: number;
      sampleRate: number;
    };
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.play.generateSentence(text, sentenceIndex, settings);
      if (result.success && result.data) {
        return { success: true, audio: result.data };
      }
      return { success: false, error: result.error };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async playStop(): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.play.stop();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async playEndSession(): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.play.endSession();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async playIsSessionActive(): Promise<{ success: boolean; active?: boolean; error?: string }> {
    if (this.isElectron) {
      const result = await (window as any).electron.play.isSessionActive();
      if (result.success && result.data) {
        return { success: true, active: result.data.active };
      }
      return { success: false, error: result.error };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async playGetVoices(): Promise<{ success: boolean; voices?: string[]; error?: string }> {
    if (this.isElectron) {
      const result = await (window as any).electron.play.getVoices();
      if (result.success && result.data) {
        return { success: true, voices: result.data.voices };
      }
      return { success: false, error: result.error };
    }
    return { success: false, error: 'Not running in Electron' };
  }

  onPlayAudioGenerated(callback: (event: { sentenceIndex: number; audio: { data: string; duration: number; sampleRate: number } }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.play.onAudioGenerated(callback);
    }
    return () => {};
  }

  onPlayStatus(callback: (status: { message: string }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.play.onStatus(callback);
    }
    return () => {};
  }

  onPlaySessionEnded(callback: (data: { code: number }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.play.onSessionEnded(callback);
    }
    return () => {};
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Library Server
  // ─────────────────────────────────────────────────────────────────────────────

  async libraryServerStart(config: { booksPath: string; port: number }): Promise<{ success: boolean; data?: { running: boolean; port: number; addresses: string[]; booksPath: string }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.libraryServer.start(config);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async libraryServerStop(): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.libraryServer.stop();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async libraryServerGetStatus(): Promise<{ success: boolean; data?: { running: boolean; port: number; addresses: string[]; booksPath: string }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.libraryServer.getStatus();
    }
    return { success: false, error: 'Not running in Electron' };
  }
}

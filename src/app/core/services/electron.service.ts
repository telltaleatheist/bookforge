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

interface OcrResult {
  text: string;
  confidence: number;
}

interface DeskewResult {
  angle: number;
  confidence: number;
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
    redactRegions?: Array<{ x: number; y: number; width: number; height: number }>
  ): Promise<string | null> {
    if (this.isElectron) {
      const result: PdfRenderResult = await (window as any).electron.pdf.renderPage(pageNum, scale, pdfPath, redactRegions);
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

  async exportCleanPdf(pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number }>): Promise<string> {
    if (this.isElectron) {
      const result: PdfExportResult = await (window as any).electron.pdf.exportPdf(pdfPath, deletedRegions);
      if (result.success && result.data?.pdf_base64) {
        return result.data.pdf_base64;
      }
      const errorMsg = result.error || 'Unknown error';
      console.error('Failed to export PDF:', errorMsg);
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
}

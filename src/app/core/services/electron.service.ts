import { Injectable, inject } from '@angular/core';
import { DialogService } from '../../creamsicle-desktop/services/dialog.service';

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

// Event from the main-process stream scheduler ('stream:event' channel).
// 'chunk' carries base64 PCM16 audio (a piece of the streamed playhead
// sentence, or a whole lookahead sentence); 'done' marks a sentence fully
// generated; 'complete' means nothing is left to generate for this request.
export interface StreamSchedulerEvent {
  kind: 'chunk' | 'done' | 'failed' | 'complete';
  requestId: number;
  sentenceIndex?: number;
  seq?: number;
  data?: string;
  duration?: number;
  sampleRate?: number;
  error?: string;
}

/** Multi-worker capability + topology for the streaming TTS engine. */
export interface StreamWorkerConfig {
  /** Multi-worker capability toggle (off ⇒ always 1 CPU worker) */
  enabled: boolean;
  /** The chosen 1–4 count (kept even when disabled, so the slider remembers it) */
  count: number;
  defaultCount: number;
  minWorkers: number;
  maxWorkers: number;
  /** User's device preference for the streaming engine */
  devicePref: 'auto' | 'cpu' | 'gpu' | 'mps';
  device: 'cpu' | 'cuda' | 'mps' | null;
  deviceWorkers: number;
  activeWorkers: number;
  /** The streaming engine backing the Listen feature. Persisted; applies on the
   *  next engine start. */
  engine?: 'xtts' | 'orpheus';
  /** Which engines are usable on this machine (XTTS always; Orpheus when its env
   *  / WSL is set up). Drives the engine chooser's availability. */
  engines?: { id: 'xtts' | 'orpheus'; name: string; available: boolean; reason?: string }[];
  /** Voices the active engine can use (for the voice picker). */
  voices?: string[];
  /** The persisted default voice the server warms on start. */
  voice?: string;
  /** The voice currently loaded live, when a session is running. */
  currentVoice?: string | null;
}

/** Per-machine Orpheus max batch size (Settings → Streaming engine). Processing
 *  uses it directly; streaming ramps up to it. Mirrors electron/orpheus-batch.ts. */
export interface OrpheusBatchConfig {
  /** Effective max in use right now. */
  value: number;
  /** User-set max, or null when using the platform default. */
  userMax: number | null;
  /** Per-platform default (reset target / placeholder). */
  platformDefault: number;
  /** 'mac' (MLX) or 'nvidia' (vLLM). */
  platform: 'mac' | 'nvidia';
  /** True when an ORPHEUS_BATCH_SIZE env var is forcing the value. */
  envOverride: boolean;
  /** Clamp bounds for the input. */
  min: number;
  max: number;
}

// Chapter structure for TOC extraction and chapter marking
export interface Chapter {
  id: string;
  title: string;
  page: number;              // 0-indexed
  blockId?: string;          // Linked text block
  mergedBlockIds?: string[]; // All block IDs contributing to a merged multi-line title
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

export interface TocLine {
  text: string;
  blockId: string;
  blockPage: number;
  isPageNumber: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional Component System — renderer-facing types.
//
// The renderer cannot import from electron/, so these are mirrored VERBATIM from
// electron/components/component-types.ts (the locked contract). Keep them in sync
// with that file. They carry no runtime dependencies.
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = 'darwin' | 'win32' | 'linux';
export type Arch = 'arm64' | 'x64';

export type GpuKind = 'apple-silicon' | 'cuda' | 'any' | 'none';

export type ComponentKind =
  | 'binary'
  | 'conda-env'
  | 'tts-model'
  | 'rvc-model'
  | 'language-pack'
  | 'stt-model'
  | 'system';

export type AcquisitionMode = 'external' | 'managed';

export type ComponentState =
  | 'installed'
  | 'available'
  | 'incompatible'
  | 'installing'
  | 'error';

export interface ComponentRequirements {
  platforms?: Platform[];
  gpu?: GpuKind;
  minVramMB?: number;
  minRamMB?: number;
  minDiskMB?: number;
}

export interface ComponentArtifact {
  platform: Platform;
  arch: Arch;
  gpu?: GpuKind;
  url: string;
  sha256: string;
  bytes: number;
  condaUnpack?: boolean;
}

export interface VerifySpec {
  kind: 'exec' | 'python-import' | 'path-exists';
  entry?: string;
  args?: string[];
  module?: string;
  expect?: string;
}

export interface DetectSpec {
  commandNames?: string[];
  candidates?: { platform: Platform; path: string }[];
  envVar?: string;
}

export interface OptionalComponent {
  id: string;
  name: string;
  description: string;
  kind: ComponentKind;
  acquisition: AcquisitionMode[];
  sizeBytes: number;
  requirements: ComponentRequirements;
  artifacts: ComponentArtifact[];
  installTarget?: 'components' | 'e2a-hf-cache';
  hf?: { repo: string; sub: string; files: string[] };
  detect?: DetectSpec;
  verify: VerifySpec;
  version: string;
  entryPath: string;
  externalHelpUrl?: string;
}

export interface CudaInfo {
  available: boolean;
  name?: string;
  vramMB?: number;
}

export interface WslInfo {
  available: boolean;
  distros: string[];
  defaultDistro?: string;
}

export interface SystemProfile {
  platform: Platform;
  arch: Arch;
  appleSilicon: boolean;
  cuda: CudaInfo;
  ramMB: number;
  freeDiskMB: number;
  wsl?: WslInfo;
}

export interface Compatibility {
  compatible: boolean;
  degraded?: boolean;
  reasons: string[];
}

export interface InstalledRecord {
  id: string;
  version: string;
  source: AcquisitionMode;
  path: string;
  entryPath: string;
  sha256?: string;
  bytes?: number;
  installedAt: string;
}

export interface EnvDiagnosticCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint: string;
}

export interface EnvDiagnosticResult {
  ok: boolean;
  engine?: string;
  checks: EnvDiagnosticCheck[];
  error?: string;
}

export interface ComponentStatus {
  component: OptionalComponent;
  state: ComponentState;
  compatibility: Compatibility;
  installed?: InstalledRecord;
  progress?: InstallProgress;
}

export type InstallPhase =
  | 'resolve'
  | 'download'
  | 'verify'
  | 'extract'
  | 'postinstall'
  | 'verify-run'
  | 'done'
  | 'error';

export interface InstallProgress {
  id: string;
  phase: InstallPhase;
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallResult {
  id: string;
  ok: boolean;
  record?: InstalledRecord;
  error?: string;
}

/** A Whisper transcription model in the catalog, with a present/absent flag. */
export interface WhisperModelStatus {
  id: string;
  hfRepo: string;
  label: string;
  note: string;
  sizeMB: number;
  present: boolean;
}

/** Progress tick while a Whisper model downloads. */
export interface WhisperDownloadProgress {
  id: string;
  pct: number;
  receivedBytes: number;
  totalBytes: number;
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

interface PdfAnalyzeQuickResult {
  success: boolean;
  data?: {
    page_count: number;
    page_dimensions: Array<{ width: number; height: number }>;
    pdf_name: string;
    textReady: boolean;
    blocks?: any[];
    categories?: Record<string, any>;
    spans?: any[];
  };
  error?: string;
}

interface PdfAnalyzeTextResult {
  success: boolean;
  data?: {
    blocks: any[];
    categories: Record<string, any>;
    spans?: any[];
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
  coverImagePath?: string;  // Relative path to cover in media folder
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
  private readonly dialog = inject(DialogService);

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

  async analyzePdfQuick(pdfPath: string, maxPages?: number): Promise<PdfAnalyzeQuickResult> {
    if (this.isElectron) {
      return (window as any).electron.pdf.analyzeQuick(pdfPath, maxPages);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async analyzePdfText(pdfPath: string, maxPages?: number): Promise<PdfAnalyzeTextResult> {
    if (this.isElectron) {
      return (window as any).electron.pdf.analyzeText(pdfPath, maxPages);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  onTextReady(callback: (data: { blocks: any[]; categories: Record<string, any>; spans: any[]; pdfPath?: string }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.pdf.onTextReady(callback);
    }
    return () => {};
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
   * On-demand page rendering: render specific pages by number.
   * Returns a map of pageNum → filePath for the requested pages.
   */
  async renderPages(
    pdfPath: string,
    pageNumbers: number[],
    quality: 'preview' | 'full' = 'preview'
  ): Promise<Record<number, string>> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.renderPages(pdfPath, pageNumbers, quality);
      if (result.success && result.data) {
        return result.data;
      }
      console.error('Failed to render pages on demand:', result.error);
      return {};
    }
    return {};
  }

  /**
   * Close cached render document to free memory.
   */
  async closeRenderDoc(): Promise<void> {
    if (this.isElectron) {
      await (window as any).electron.pdf.closeRenderDoc();
    }
  }

  /**
   * Close the main analysis document and free all WASM memory.
   */
  async closePdf(): Promise<void> {
    if (this.isElectron) {
      await (window as any).electron.pdf.closePdf();
    }
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

  async getSpans(): Promise<Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number; font_name: string; baseline_offset: number; is_bold: boolean; is_italic: boolean; block_id: string }> | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.getSpans();
      if (result.success) {
        return result.data;
      }
    }
    return null;
  }

  async getSpansForBlock(blockId: string): Promise<Array<{
    page: number; x: number; y: number; width: number; height: number;
    text: string; font_size: number; font_name: string; baseline_offset: number;
    is_bold: boolean; is_italic: boolean; block_id: string;
  }> | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.getSpansForBlock(blockId);
      if (result.success) return result.data;
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

  async outlineToChapters(outline: OutlineItem[], deletedPages?: Set<number>): Promise<Chapter[]> {
    if (this.isElectron) {
      const deletedArr = deletedPages?.size ? Array.from(deletedPages) : undefined;
      const result = await (window as any).electron.pdf.outlineToChapters(outline, deletedArr);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async detectChapters(deletedPages?: Set<number>): Promise<Chapter[]> {
    if (this.isElectron) {
      const deletedArr = deletedPages?.size ? Array.from(deletedPages) : undefined;
      const result = await (window as any).electron.pdf.detectChapters(deletedArr);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async detectChaptersFromExamples(blockIds: string[], deletedPages?: Set<number>): Promise<Chapter[]> {
    if (this.isElectron) {
      const deletedArr = deletedPages?.size ? Array.from(deletedPages) : undefined;
      const result = await (window as any).electron.pdf.detectChaptersFromExamples(blockIds, deletedArr);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async mapTocEntries(tocBlockIds: string[], deletedPages?: Set<number>): Promise<{ chapters: Chapter[]; unmapped: Array<{ title: string; printedPage?: number; rawLine: string }> }> {
    if (this.isElectron) {
      const deletedArr = deletedPages?.size ? Array.from(deletedPages) : undefined;
      const result = await (window as any).electron.pdf.mapTocEntries(tocBlockIds, deletedArr);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return { chapters: [], unmapped: [] };
  }

  async splitTocBlocks(tocBlockIds: string[]): Promise<TocLine[]> {
    if (this.isElectron) {
      const result = await (window as any).electron.pdf.splitTocBlocks(tocBlockIds);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return [];
  }

  async mapTitlesToChapters(titles: string[], tocPages: number[], deletedPages?: Set<number>): Promise<{ chapters: Chapter[]; unmapped: Array<{ title: string; rawLine: string }> }> {
    if (this.isElectron) {
      const deletedArr = deletedPages?.size ? Array.from(deletedPages) : undefined;
      const result = await (window as any).electron.pdf.mapTitlesToChapters(titles, tocPages, deletedArr);
      if (result.success && result.data) {
        return result.data;
      }
    }
    return { chapters: [], unmapped: [] };
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

  /**
   * Finalize a project for audiobook processing.
   * Exports EPUB to the project folder and updates the BFP with audiobook state.
   *
   * @param bfpPath - Path to the BFP project file
   * @returns Result with success status, EPUB path, or error
   */
  async projectFinalize(bfpPath: string): Promise<{
    success: boolean;
    epubPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.projects.finalize(bfpPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Migrate all legacy BFP projects to the current format.
   * - Copies source files into project folders
   * - Adds audiobook property if missing
   * - Creates backups before modifying
   *
   * @returns Result with migrated projects and any failures
   */
  async projectsMigrateAll(): Promise<{
    success: boolean;
    migrated: string[];
    skipped: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    if (this.isElectron) {
      return (window as any).electron.projects.migrateAll();
    }
    return { success: false, migrated: [], skipped: [], failed: [] };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Editor Window - Opens PDF picker in a separate window for editing
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Open the editor window for a project
   */
  async editorOpenWindow(projectPath: string, options?: { mode?: string }): Promise<{
    success: boolean;
    alreadyOpen?: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.editor.openWindow(projectPath, options);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Open the editor window with a BFP project and specific source version
   * This ensures project state (deletions, chapters) is preserved
   */
  async editorOpenWindowWithBfp(bfpPath: string, sourcePath: string): Promise<{
    success: boolean;
    alreadyOpen?: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.editor.openWindowWithBfp(bfpPath, sourcePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Close the editor window for a project
   */
  async editorCloseWindow(projectPath: string): Promise<{ success: boolean }> {
    if (this.isElectron) {
      return (window as any).electron.editor.closeWindow(projectPath);
    }
    return { success: true };
  }

  /**
   * Get available versions for a project
   * Returns all versions of the source document at different pipeline stages
   */
  async editorGetVersions(bfpPath: string): Promise<{
    success: boolean;
    error?: string;
    versions?: Array<{
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
      analysisTarget?: { versionId: string | null; versionType: string; versionLabel: string };
      analysisFlagCount?: number;
      analysisIsCheckpoint?: boolean;
    }>;
  }> {
    if (this.isElectron) {
      return (window as any).electron.editor.getVersions(bfpPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Subscribe to editor window closed events
   */
  onEditorWindowClosed(callback: (projectPath: string) => void): void {
    if (this.isElectron) {
      (window as any).electron.editor.onWindowClosed(callback);
    }
  }

  /**
   * Unsubscribe from editor window closed events
   */
  offEditorWindowClosed(): void {
    if (this.isElectron) {
      (window as any).electron.editor.offWindowClosed();
    }
  }

  /**
   * Subscribe to project files changed events (fired when files are saved to a project)
   */
  onProjectFilesChanged(callback: (projectPath: string) => void): void {
    if (this.isElectron) {
      (window as any).electron.editor.onFilesChanged(callback);
    }
  }

  /**
   * Unsubscribe from project files changed events
   */
  offProjectFilesChanged(): void {
    if (this.isElectron) {
      (window as any).electron.editor.offFilesChanged();
    }
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
   * Resolve a project's source file path - finds file in current library by hash or filename
   * Used when opening projects from another machine where paths don't match
   */
  async libraryResolveSource(options: {
    libraryPath?: string;
    sourcePath?: string;
    fileHash?: string;
    sourceName?: string;
  }): Promise<{ success: boolean; resolvedPath?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.library.resolveSource(options);
    }
    // In browser mode, just return the library path or source path
    return { success: true, resolvedPath: options.libraryPath || options.sourcePath };
  }

  /**
   * Translate a cross-platform library path to the current platform.
   * Handles BFP files synced between Mac and Windows (e.g., via Syncthing).
   */
  async libraryTranslatePath(inputPath: string): Promise<{ success: boolean; translated: string | null }> {
    if (this.isElectron) {
      return (window as any).electron.library.translatePath(inputPath);
    }
    return { success: false, translated: null };
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Unified Audiobook Export (saves EPUB to BFP project's audiobook folder)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Export EPUB to audiobook folder and update BFP project with audiobook state.
   * This is the unified approach - audiobook data lives with the BFP project.
   */
  async audiobookExportFromProject(
    bfpPath: string,
    epubData: ArrayBuffer,
    deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>,
    savePath?: string
  ): Promise<{
    success: boolean;
    audiobookFolder?: string;
    epubPath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.exportFromProject(bfpPath, epubData, deletedBlockExamples, savePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Extract metadata from an EPUB file without importing it.
   * Used to pre-populate the metadata confirmation modal.
   */
  async extractEpubMetadata(epubSourcePath: string): Promise<{
    success: boolean;
    metadata?: { title: string; author: string; year: string; language: string; coverData: string | null };
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.extractMetadata(epubSourcePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Import an EPUB file directly, creating both a BFP file and audiobook folder.
   * Used for drag/drop import without going through the PDF editor.
   */
  async audiobookImportEpub(epubSourcePath: string, confirmedMetadata?: { title: string; author: string; year?: string; language?: string; subtitle?: string; coverData?: string }): Promise<{
    success: boolean;
    bfpPath?: string;
    audiobookFolder?: string;
    epubPath?: string;
    projectName?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.importEpub(epubSourcePath, confirmedMetadata);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async audiobookImportAudiobook(audioSourcePath: string): Promise<{
    success: boolean;
    projectId?: string;
    projectPath?: string;
    bfpPath?: string;
    projectName?: string;
    duplicate?: boolean;
    existingProjectId?: string;
    existingTitle?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.importAudiobook(audioSourcePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /** Subscribe to audio-import progress (0..1). Returns an unsubscribe fn. */
  onImportProgress(callback: (p: { name: string; fraction: number; projectId?: string }) => void): () => void {
    if (this.isElectron && (window as any).electron?.audiobook?.onImportProgress) {
      return (window as any).electron.audiobook.onImportProgress(callback);
    }
    return () => { /* not in Electron */ };
  }

  async audiobookSaveMetadata(
    projectId: string,
    meta: { title?: string; author?: string; year?: string; narrator?: string; series?: string; seriesPosition?: number; description?: string },
    coverData?: string,
  ): Promise<{ success: boolean; coverPath?: string; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.saveAudiobookMetadata(projectId, meta, coverData);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ── Book variants ─────────────────────────────────────────────────────────
  async openVersionDialog(): Promise<{ success: boolean; canceled?: boolean; filePaths?: string[]; error?: string }> {
    if (this.isElectron) return (window as any).electron.dialog.openVersion();
    return { success: false, error: 'Not running in Electron' };
  }
  async variantList(projectId: string): Promise<{ success: boolean; variants?: any[]; primaryVariantId?: string; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.list(projectId);
    return { success: false, error: 'Not running in Electron' };
  }
  async variantAdd(projectId: string, filePath: string): Promise<{ success: boolean; variantId?: string; variant?: any; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.add(projectId, filePath);
    return { success: false, error: 'Not running in Electron' };
  }
  async variantSaveMetadata(projectId: string, variantId: string, meta: Record<string, unknown>, coverData?: string): Promise<{ success: boolean; coverPath?: string; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.saveMetadata(projectId, variantId, meta, coverData);
    return { success: false, error: 'Not running in Electron' };
  }
  async variantDelete(projectId: string, variantId: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.delete(projectId, variantId);
    return { success: false, error: 'Not running in Electron' };
  }

  /** Delete a finished audiobook output (.m4b + paired VTT) and clear it from the
   *  manifest. key='mono' for the main audiobook, else a bilingual language-pair key. */
  async deleteAudiobookOutput(projectId: string, key: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) return (window as any).electron.audiobook.deleteOutput(projectId, key);
    return { success: false, error: 'Not running in Electron' };
  }
  async variantSetPrimary(projectId: string, variantId: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.setPrimary(projectId, variantId);
    return { success: false, error: 'Not running in Electron' };
  }
  async variantPullMetadata(projectId: string, fromId: string, toId: string, fields: string[]): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.pullMetadata(projectId, fromId, toId, fields);
    return { success: false, error: 'Not running in Electron' };
  }
  async variantSendToPipeline(projectId: string, variantId: string): Promise<{ success: boolean; sourcePath?: string; projectDir?: string; error?: string }> {
    if (this.isElectron) return (window as any).electron.variant.sendToPipeline(projectId, variantId);
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Direct EPUB Save (saves edited EPUB back to source file)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Save EPUB data directly to a file path.
   * Used when editing an EPUB file directly (not via BFP project).
   */
  async saveEpubToPath(
    epubPath: string,
    epubData: ArrayBuffer
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.editor.saveEpubToPath(epubPath, epubData);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Save EPUB data to a user-chosen location via Save As dialog.
   * No library restriction — for exporting EPUBs for external use.
   */
  async saveEpubAs(
    epubData: ArrayBuffer,
    defaultName?: string
  ): Promise<{
    success: boolean;
    canceled?: boolean;
    filePath?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.epub.saveAsDialog(epubData, defaultName);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Update audiobook state in BFP project (status, paths, progress, etc.)
   */
  async audiobookUpdateState(
    bfpPath: string,
    audiobookState: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.updateState(bfpPath, audiobookState);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Get audiobook folder path for a BFP project
   */
  async audiobookGetFolder(bfpPath: string): Promise<{
    success: boolean;
    folder?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.getFolder(bfpPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * List BFP projects that have audiobook state (for audiobook producer queue)
   */
  async audiobookListProjectsWithAudiobook(): Promise<{
    success: boolean;
    projects?: Array<{
      name: string;
      bfpPath: string;
      audiobookFolder: string;
      status: string;
      exportedAt?: string;
      cleanedAt?: string;
      completedAt?: string;
      linkedAudioPath?: string;
      linkedAudioPathValid?: boolean;
      vttPath?: string;
      // Bilingual audio paths (separate from mono audiobook)
      bilingualAudioPath?: string;
      bilingualAudioPathValid?: boolean;
      bilingualVttPath?: string;
      bilingualSentencePairsPath?: string;
      metadata?: {
        title?: string;
        author?: string;
        year?: string;
        language?: string;
        coverImagePath?: string;
        outputFilename?: string;
      };
    }>;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.listProjectsWithAudiobook();
    }
    return { success: false, error: 'Not running in Electron', projects: [] };
  }

  /**
   * Link an audio file to a BFP project
   */
  async audiobookLinkAudio(bfpPath: string, audioPath: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.linkAudio(bfpPath, audioPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Link a bilingual audio file to a BFP project (separate from mono audiobook)
   */
  async audiobookLinkBilingualAudio(bfpPath: string, audioPath: string, vttPath?: string, sentencePairsPath?: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.audiobook.linkBilingualAudio(bfpPath, audioPath, vttPath, sentencePairsPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Update project metadata in a BFP file
   */
  async projectUpdateMetadata(bfpPath: string, metadata: {
    title?: string;
    author?: string;
    year?: string;
    language?: string;
    coverPath?: string;
    coverData?: string;
    outputFilename?: string;
    contributors?: Array<{ first: string; last: string }>;
    tags?: string[];
  }): Promise<{ success: boolean; error?: string; newBfpPath?: string }> {
    if (this.isElectron) {
      return (window as any).electron.project.updateMetadata(bfpPath, metadata);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Read an audio file and return as data URL for playback
   */
  async readAudioFile(audioPath: string): Promise<{ success: boolean; dataUrl?: string; size?: number; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.fs.readAudio(audioPath);
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

  /**
   * Set custom library root path
   */
  async setLibraryRoot(libraryPath: string | null): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.library.setRoot(libraryPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Get current library root path
   */
  async getLibraryRoot(): Promise<string | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.library.getRoot();
      return result.path;
    }
    return null;
  }

  // Media operations - external image storage
  /**
   * Save a base64 image to the media folder, returns relative path
   */
  async mediaSaveImage(base64Data: string, prefix: string = 'cover'): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.media.saveImage(base64Data, prefix);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Load an image from the media folder by relative path, returns base64 data URL
   */
  async mediaLoadImage(relativePath: string): Promise<{
    success: boolean;
    data?: string;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.media.loadImage(relativePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Check if a file exists at the given path
   */
  async fsExists(filePath: string): Promise<boolean> {
    if (this.isElectron) {
      try {
        return await (window as any).electron.fs.exists(filePath);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Check multiple file paths for existence in a single IPC call
   */
  async fsBatchExists(filePaths: string[]): Promise<Record<string, boolean>> {
    if (this.isElectron) {
      try {
        return await (window as any).electron.fs.batchExists(filePaths);
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * Get file stats (mtime) for multiple paths in a single IPC call
   */
  async fsBatchStat(filePaths: string[]): Promise<Record<string, { mtimeMs: number } | null>> {
    if (this.isElectron) {
      try {
        return await (window as any).electron.fs.batchStat(filePaths);
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * Read a text file and return its contents
   */
  async readTextFile(filePath: string): Promise<string | null> {
    if (this.isElectron) {
      try {
        const result = await (window as any).electron.fs.readText(filePath);
        if (result.success && result.content) {
          return result.content;
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Extract the WebVTT transcript embedded inside an .m4b (sealed by the
   * assembler as a subtitle track). Returns the VTT text, or null when the file
   * carries no embedded track (older audiobooks) — callers then fall back to a
   * sidecar .vtt. This is the guaranteed-correct transcript for the audio, immune
   * to any filename/sidecar mismatch.
   */
  async extractEmbeddedVtt(m4bPath: string): Promise<string | null> {
    if (this.isElectron) {
      try {
        const result = await (window as any).electron.audiobook.extractEmbeddedVtt(m4bPath);
        return result?.success && result.vtt ? result.vtt : null;
      } catch {
        return null;
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
      engine: string;
      language?: string;
      pages?: number[];
    }
  ): Promise<Array<{
    page: number;
    text: string;
    confidence: number;
    textLines?: OcrTextLine[];
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

  async getOpenAIModels(apiKey: string): Promise<{
    success: boolean;
    models?: { value: string; label: string }[];
    error?: string;
  }> {
    if (this.isElectron) {
      return await (window as any).electron.ai.getOpenAIModels(apiKey);
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
   * Compute change counts for chapters that weren't part of a cleanup job's
   * pre-computed cache, so the Review Changes dropdown can show a real count
   * (including "0 changes") for every chapter. Pass the specific chapter IDs to
   * limit work; omit to count all chapters.
   */
  async getDiffChangeCounts(originalPath: string, cleanedPath: string, chapterIds?: string[]): Promise<{
    success: boolean;
    counts?: Array<{ id: string; changeCount: number }>;
    error?: string;
  }> {
    if (this.isElectron) {
      const result = await (window as any).electron.diff.getChangeCounts(originalPath, cleanedPath, chapterIds);
      if (result.success && result.data) {
        return { success: true, counts: result.data.counts };
      }
      return { success: false, error: result.error || 'Failed to compute change counts' };
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

  /**
   * Load pre-computed diff cache file (created during AI cleanup)
   * Returns the cached diff data if available, or null if cache needs recompute
   */
  async loadCachedDiffFile(cleanedPath: string): Promise<{
    success: boolean;
    data?: {
      version: number;
      createdAt: string;
      updatedAt: string;
      ignoreWhitespace: boolean;
      completed: boolean;  // True when job finished, false if still running/interrupted
      chapters: Array<{
        id: string;
        title: string;
        originalCharCount: number;
        cleanedCharCount: number;
        changeCount: number;
        changes: Array<{ pos: number; len: number; add?: string; rem?: string }>;
      }>;
    };
    needsRecompute?: boolean;
  }> {
    if (this.isElectron) {
      return (window as any).electron.diff.loadCachedFile(cleanedPath);
    }
    return { success: false, needsRecompute: true };
  }

  /**
   * Hydrate a chapter's compact diff changes back to full DiffWord[] for rendering
   */
  async hydrateChapter(originalPath: string, cleanedPath: string, chapterId: string, changes: Array<{ pos: number; len: number; add?: string; rem?: string }>): Promise<{
    success: boolean;
    data?: {
      diffWords: Array<{ text: string; type: 'unchanged' | 'added' | 'removed' }>;
      cleanedText: string;
      originalText: string;
    };
  }> {
    if (this.isElectron) {
      return (window as any).electron.diff.hydrateChapter(originalPath, cleanedPath, chapterId, changes);
    }
    return { success: false };
  }

  async precomputeDiffPair(originalPath: string, targetPath: string): Promise<{ success: boolean; cached?: boolean; chapters?: number; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.diff.precomputePair(originalPath, targetPath);
    }
    return { success: false };
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

  async convertJwpub(jwpubPath: string): Promise<{
    success: boolean;
    outputPath?: string;
    metadata?: { title: string; author: string; year: string; language: string };
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.jwpub.convert(jwpubPath);
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

  /**
   * Extract cover image from an EPUB file as a data URL
   */
  async epubGetCover(epubPath: string): Promise<{
    success: boolean;
    data?: string | null;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron?.epub?.getCover) {
      return (window as any).electron.epub.getCover(epubPath);
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

  /**
   * Show a confirmation dialog.
   *
   * Always renders the single in-app {@link DesktopDialogComponent} (via
   * DialogService) — in Electron AND on the web — so every confirm popup across
   * the app looks and behaves identically. Previously this used the native OS
   * dialog inside Electron, which is the odd-one-out "js alert" the rest of the
   * UI doesn't match; consolidating onto the Angular component fixes that.
   */
  async showConfirmDialog(options: {
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  }): Promise<{ confirmed: boolean }> {
    const confirmed = await this.dialog.confirm({
      title: options.title,
      message: options.message,
      detail: options.detail,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      type: options.type ?? 'question',
    });
    return { confirmed };
  }

  /**
   * Show a single-button message box (the app's replacement for `alert()`).
   * Always renders the in-app {@link DesktopDialogComponent} — see
   * {@link showConfirmDialog} for why we no longer use the native OS dialog.
   */
  async showMessageDialog(options: {
    message: string;
    title?: string;
    detail?: string;
    type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  }): Promise<void> {
    await this.dialog.alert({
      title: options.title,
      message: options.message,
      detail: options.detail,
      type: options.type ?? 'info',
    });
  }

  /** Path to the bundled default book to seed on first run, or null if not shipped. */
  async getSeedBookPath(): Promise<string | null> {
    if (this.isElectron) {
      return (window as any).electron.library.seedBookPath();
    }
    return null;
  }

  /** Delete all of BookForge's downloaded data (engine, models, packs, settings).
   *  Keeps the user's library/books. Returns bytes freed + platform for guidance. */
  async removeAllData(): Promise<{ ok: boolean; freedBytes: number; userData: string; platform: string }> {
    if (this.isElectron) {
      return (window as any).electron.library.removeAllData();
    }
    return { ok: false, freedBytes: 0, userData: '', platform: '' };
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

  async deleteFile(filePath: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.fs.deleteFile(filePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /** Delete a project's content-analysis report (report + in-progress checkpoint). */
  async deleteAnalysis(projectDir: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.analysis.delete(projectDir);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async deleteDirectory(dirPath: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.fs.deleteDirectory(dirPath);
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

  async playGetVoices(): Promise<{ success: boolean; voices?: Array<{ id: string; name: string; group: string }>; error?: string }> {
    if (this.isElectron) {
      const result = await (window as any).electron.play.getVoices();
      if (result.success && result.data) {
        return { success: true, voices: result.data.voices };
      }
      return { success: false, error: result.error };
    }
    return { success: false, error: 'Not running in Electron' };
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

  onPlaySessionStarted(callback: () => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.play.onSessionStarted(callback);
    }
    return () => {};
  }

  async openListenWindow(projectPath: string, audioPath?: string): Promise<{ success: boolean; alreadyOpen?: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.play.openListenWindow(projectPath, audioPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async listListenSources(projectPath: string): Promise<{
    success: boolean;
    epubs?: Array<{ kind: string; lang?: string; path: string; mtimeMs: number }>;
    m4bs?: Array<{ fileName: string; path: string; vttPath?: string; mtimeMs: number }>;
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.play.listListenSources(projectPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TTS service (engine pinned as a resident service; main process is the
  // single source of truth, state broadcasts keep every window in sync)
  // ─────────────────────────────────────────────────────────────────────────────

  async ttsServiceStart(voice?: string): Promise<{ success: boolean; voices?: string[]; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsService.start(voice);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ttsServiceStop(): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsService.stop();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ttsServiceStatus(): Promise<{ success: boolean; state?: 'stopped' | 'starting' | 'warming' | 'running'; serviceMode?: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsService.status();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  onTtsServiceState(callback: (state: { state: 'stopped' | 'starting' | 'warming' | 'running'; serviceMode: boolean }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.ttsService.onState(callback);
    }
    return () => {};
  }

  /** Warm-up progress (0–100) while the voice model loads into memory. */
  onTtsWarmup(callback: (data: { pct: number; message?: string }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.ttsService.onWarmup(callback);
    }
    return () => {};
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stream Scheduler (main-process TTS generation orchestration)
  // ─────────────────────────────────────────────────────────────────────────────

  async streamStart(
    sentences: string[],
    startIndex: number,
    settings: { voice: string; speed: number; temperature?: number; topP?: number; repetitionPenalty?: number },
    requestId: number
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.play.streamStart(sentences, startIndex, settings, requestId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async streamStop(): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.play.streamStop();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /** Fire-and-forget playback position report; drives the generation lookahead window. */
  streamReportPlayhead(requestId: number, sentenceIndex: number): void {
    if (this.isElectron) {
      void (window as any).electron.play.streamPlayhead(requestId, sentenceIndex);
    }
  }

  onStreamEvent(callback: (event: StreamSchedulerEvent) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.play.onStreamEvent(callback);
    }
    return () => {};
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bookshelf Server
  // ─────────────────────────────────────────────────────────────────────────────

  async bookshelfStart(config: { port: number; externalAudiobooksDir?: string }): Promise<{ success: boolean; data?: { running: boolean; port: number; addresses: string[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.bookshelf.start(config);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async bookshelfStop(): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.bookshelf.stop();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async bookshelfGetStatus(): Promise<{ success: boolean; data?: { running: boolean; port: number; addresses: string[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.bookshelf.getStatus();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async bookshelfUpdateConfig(updates: { externalAudiobooksDir?: string }): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.bookshelf.updateConfig(updates);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TTS API Server (WebSocket access for external clients, e.g. browser extension)
  // ─────────────────────────────────────────────────────────────────────────────

  async ttsApiStatus(): Promise<{ success: boolean; data?: { running: boolean; port: number; host: string; token: string; addresses: string[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsApi.status();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ttsApiConfigure(updates: { port?: number; host?: string }): Promise<{ success: boolean; data?: { running: boolean; port: number; host: string; token: string; addresses: string[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsApi.configure(updates);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ttsStreamWorkerConfig(): Promise<{ success: boolean; data?: StreamWorkerConfig; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsStream.getWorkerConfig();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ttsStreamSetWorkerConfig(updates: { engine?: 'xtts' | 'orpheus'; enabled?: boolean; count?: number; devicePref?: 'auto' | 'cpu' | 'gpu' | 'mps'; voice?: string }): Promise<{ success: boolean; data?: StreamWorkerConfig; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ttsStream.setWorkerConfig(updates);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Ebook Library
  // ─────────────────────────────────────────────────────────────────────────────

  async ebookLibraryInit(): Promise<{ success: boolean; data?: { ebookMetaAvailable: boolean }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.init();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryScan(): Promise<{ success: boolean; data?: { books: any[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.scan();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryAddBooks(paths: string[], category: string): Promise<{ success: boolean; data?: { added: any[]; duplicates: any[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.addBooks(paths, category);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryRemoveBook(relativePath: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.removeBook(relativePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryMoveBooks(paths: string[], category: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.moveBooks(paths, category);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryUpdateMetadata(relativePath: string, metadata: any): Promise<{ success: boolean; data?: { book: any; warning?: string }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.updateMetadata(relativePath, metadata);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryGetCover(relativePath: string): Promise<{ success: boolean; data?: { coverData: string | null }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.getCover(relativePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibrarySetCover(relativePath: string, base64Data: string): Promise<{ success: boolean; data?: { book: any }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.setCover(relativePath, base64Data);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryListCategories(): Promise<{ success: boolean; data?: { categories: any[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.listCategories();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryCreateCategory(name: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.createCategory(name);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryDeleteCategory(name: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.deleteCategory(name);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryRenameCategory(oldName: string, newName: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.renameCategory(oldName, newName);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryImportToStudio(relativePath: string): Promise<{ success: boolean; data?: { absolutePath: string; metadata: any; coverData?: string | null }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.importToStudio(relativePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryRevealBook(relativePath: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.revealBook(relativePath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryOpenCategoryFolder(categoryName: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.openCategoryFolder(categoryName);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async ebookLibraryGetAbsolutePath(relativePath: string): Promise<string | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.ebookLibrary.getAbsolutePath(relativePath);
      return result.success ? result.data.absolutePath : null;
    }
    return null;
  }

  async ebookLibraryUpdateTags(relativePath: string, tags: string[]): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.updateTags(relativePath, tags);
    }
    return { success: false, error: 'Not in Electron' };
  }

  async ebookLibraryGetAllTags(): Promise<{ success: boolean; data?: { tags: string[] }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.ebookLibrary.getAllTags();
    }
    return { success: false, error: 'Not in Electron' };
  }

  async generateUniqueFilename(originalPath: string, suffix: string): Promise<string | null> {
    if (this.isElectron) {
      const result = await (window as any).electron.fs.generateUniqueFilename(originalPath, suffix);
      return result.success ? result.data.path : null;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Paths Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  async toolPathsGetConfig(): Promise<{ success: boolean; data?: Record<string, string | undefined>; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.toolPaths.getConfig();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async toolPathsUpdateConfig(updates: Record<string, string | undefined>): Promise<{ success: boolean; data?: Record<string, string | undefined>; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.toolPaths.updateConfig(updates);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async toolPathsGetStatus(): Promise<{ success: boolean; data?: Record<string, { configured: boolean; detected: boolean; path: string }>; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.toolPaths.getStatus();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /** True when spawns use the bundled relocatable env (packaged) — conda is then irrelevant. */
  async runtimeUsingBundledEnv(): Promise<{ success: boolean; data?: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.runtime.usingBundledEnv();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WSL2 Support (Windows only, for Orpheus TTS)
  // ─────────────────────────────────────────────────────────────────────────────

  async wslDetect(): Promise<{
    success: boolean;
    data?: {
      available: boolean;
      version?: number;
      distros: string[];
      defaultDistro?: string;
      error?: string;
    };
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.wsl.detect();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async wslCheckOrpheusSetup(config: {
    distro?: string;
    condaPath?: string;
    e2aPath?: string;
  }): Promise<{
    success: boolean;
    data?: {
      valid: boolean;
      condaFound: boolean;
      e2aFound: boolean;
      orpheusEnvFound: boolean;
      errors: string[];
    };
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.wsl.checkOrpheusSetup(config);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reassembly - Browse and reassemble incomplete e2a sessions
  // ─────────────────────────────────────────────────────────────────────────────

  async reassemblyScanSessions(customTmpPath?: string): Promise<{
    success: boolean;
    data?: {
      sessions: Array<{
        sessionId: string;
        sessionDir: string;
        processDir: string;
        metadata: { title?: string; author?: string; language?: string; epubPath?: string };
        totalSentences: number;
        completedSentences: number;
        percentComplete: number;
        chapters: Array<{
          chapterNum: number;
          title?: string;
          sentenceStart: number;
          sentenceEnd: number;
          sentenceCount: number;
          completedCount: number;
          excluded: boolean;
        }>;
        createdAt: string;
        modifiedAt: string;
      }>;
      tmpPath: string;
    };
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.scanSessions(customTmpPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async reassemblyGetSession(sessionId: string, customTmpPath?: string): Promise<{
    success: boolean;
    data?: {
      sessionId: string;
      sessionDir: string;
      processDir: string;
      metadata: { title?: string; author?: string; language?: string; epubPath?: string };
      totalSentences: number;
      completedSentences: number;
      percentComplete: number;
      chapters: Array<{
        chapterNum: number;
        title?: string;
        sentenceStart: number;
        sentenceEnd: number;
        sentenceCount: number;
        completedCount: number;
        excluded: boolean;
      }>;
      createdAt: string;
      modifiedAt: string;
    };
    error?: string;
  }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.getSession(sessionId, customTmpPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async reassemblyStart(jobId: string, config: {
    sessionId: string;
    sessionDir: string;
    processDir: string;
    outputDir: string;
    totalChapters?: number;
    metadata: {
      title: string;
      author: string;
      year?: string;
      coverPath?: string;
      outputFilename?: string;
    };
    excludedChapters: number[];
  }): Promise<{ success: boolean; data?: { outputPath?: string }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.startReassembly(jobId, config);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async reassemblyStop(jobId: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.stopReassembly(jobId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async reassemblyDeleteSession(sessionId: string, customTmpPath?: string): Promise<{ success: boolean; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.deleteSession(sessionId, customTmpPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async reassemblySaveMetadata(
    sessionId: string,
    processDir: string,
    metadata: {
      title?: string;
      author?: string;
      year?: string;
      narrator?: string;
      series?: string;
      seriesNumber?: string;
      genre?: string;
      description?: string;
    },
    coverData?: {
      type: 'base64' | 'path';
      data: string;
      mimeType?: string;
    }
  ): Promise<{ success: boolean; error?: string; coverPath?: string }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.saveMetadata(sessionId, processDir, metadata, coverData);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async reassemblyIsAvailable(): Promise<{ success: boolean; data?: { available: boolean }; error?: string }> {
    if (this.isElectron) {
      return (window as any).electron.reassembly.isAvailable();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  onReassemblyProgress(callback: (data: {
    jobId: string;
    progress: {
      phase: 'preparing' | 'combining' | 'encoding' | 'metadata' | 'complete' | 'error';
      percentage: number;
      currentChapter?: number;
      totalChapters?: number;
      message?: string;
      error?: string;
    };
  }) => void): () => void {
    if (this.isElectron) {
      return (window as any).electron.reassembly.onProgress(callback);
    }
    return () => {};
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // E2A Path Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Configure ebook2audiobook paths (e2a installation and conda executable)
   * Called on app startup with values from settings
   */
  async configureE2aPaths(config: { e2aPath?: string; condaPath?: string; ttsScratchPath?: string }): Promise<boolean> {
    if (this.isElectron && (window as any).electron.e2a) {
      try {
        const result = await (window as any).electron.e2a.configurePaths(config);
        return result.success;
      } catch (err) {
        console.error('[ElectronService] Failed to configure e2a paths:', err);
        return false;
      }
    }
    return false;
  }

  /** Read the current Orpheus max batch config (Settings → Streaming engine). */
  async getOrpheusBatchConfig(): Promise<OrpheusBatchConfig | null> {
    if (this.isElectron && (window as any).electron?.orpheus) {
      try {
        return await (window as any).electron.orpheus.getBatchConfig();
      } catch (err) {
        console.error('[ElectronService] Failed to read Orpheus batch config:', err);
      }
    }
    return null;
  }

  /** Set (or reset, with null) the Orpheus max batch. Returns the updated config. */
  async setOrpheusMaxBatch(value: number | null): Promise<OrpheusBatchConfig | null> {
    if (this.isElectron && (window as any).electron?.orpheus) {
      try {
        return await (window as any).electron.orpheus.setBatchMax(value);
      } catch (err) {
        console.error('[ElectronService] Failed to set Orpheus batch max:', err);
      }
    }
    return null;
  }

  /** Read the current Orpheus memory tier (how much memory Orpheus may claim). */
  async getOrpheusMemoryTier(): Promise<{ tier: string; platform: 'mac' | 'nvidia' } | null> {
    if (this.isElectron && (window as any).electron?.orpheus?.getMemoryTier) {
      try {
        return await (window as any).electron.orpheus.getMemoryTier();
      } catch (err) {
        console.error('[ElectronService] Failed to read Orpheus memory tier:', err);
      }
    }
    return null;
  }

  /** Set the Orpheus memory tier. Returns the updated tier. */
  async setOrpheusMemoryTier(tier: string): Promise<{ tier: string; platform: 'mac' | 'nvidia' } | null> {
    if (this.isElectron && (window as any).electron?.orpheus?.setMemoryTier) {
      try {
        return await (window as any).electron.orpheus.setMemoryTier(tier);
      } catch (err) {
        console.error('[ElectronService] Failed to set Orpheus memory tier:', err);
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Language Learning
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Fetch a URL and extract article content for language learning
   * @param url The URL to fetch
   * @param projectId Optional projectId to use (if not provided, one will be generated)
   */
  async languageLearningFetchUrl(url: string, projectId?: string): Promise<{
    success: boolean;
    projectId?: string;
    htmlPath?: string;
    title?: string;
    byline?: string;
    excerpt?: string;
    content?: string;
    textContent?: string;
    wordCount?: number;
    error?: string;
  }> {
    console.log('[ELECTRON-SERVICE] languageLearningFetchUrl called, isElectron:', this.isElectron, 'projectId:', projectId);
    console.log('[ELECTRON-SERVICE] languageLearning available:', !!(window as any).electron?.languageLearning);
    if (this.isElectron && (window as any).electron.languageLearning) {
      console.log('[ELECTRON-SERVICE] Invoking IPC...');
      const result = await (window as any).electron.languageLearning.fetchUrl(url, projectId);
      console.log('[ELECTRON-SERVICE] IPC result:', result);
      return result;
    }
    console.log('[ELECTRON-SERVICE] Not in Electron, returning error');
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Save a language learning project
   */
  async languageLearningSaveProject(project: any): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.saveProject(project);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Load a language learning project
   */
  async languageLearningLoadProject(projectId: string): Promise<{
    success: boolean;
    project?: any;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.loadProject(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * List all language learning projects
   */
  async languageLearningListProjects(): Promise<{
    success: boolean;
    projects?: any[];
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.listProjects();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Delete a language learning project
   */
  async languageLearningDeleteProject(projectId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.deleteProject(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Show native confirmation dialog for deleting a project
   */
  async languageLearningConfirmDelete(title: string): Promise<{
    confirmed: boolean;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.confirmDelete(title);
    }
    return { confirmed: false };
  }

  /**
   * Ensure a directory exists
   */
  async languageLearningEnsureDirectory(dirPath: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.ensureDirectory(dirPath);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Delete existing audiobook files for a project (before re-running TTS)
   */
  async languageLearningDeleteAudiobooks(projectId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.deleteAudiobooks(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * List completed bilingual audiobooks
   */
  async languageLearningListCompleted(): Promise<{
    success: boolean;
    audiobooks?: any[];
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.listCompleted();
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Extract text from HTML file with deleted elements removed
   */
  async languageLearningExtractText(htmlPath: string, deletedSelectors: string[]): Promise<{
    success: boolean;
    text?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.extractText(htmlPath, deletedSelectors);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async languageLearningWriteFile(filePath: string, content: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.writeFile(filePath, content);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Get the audio file path for a language learning audiobook
   */
  async languageLearningGetAudioPath(projectId: string): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.getAudioPath(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Get audio file as base64 data URL for playback
   */
  async languageLearningGetAudioData(projectId: string): Promise<{
    success: boolean;
    dataUrl?: string;
    size?: number;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.getAudioData(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Check if audio file exists for a project
   */
  async languageLearningHasAudio(projectId: string): Promise<{
    success: boolean;
    hasAudio?: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.hasAudio(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Delete audio and associated data for re-generation
   */
  async languageLearningDeleteAudio(projectId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.deleteAudio(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Read VTT subtitle file for a language learning audiobook
   */
  async languageLearningReadVtt(projectId: string): Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.readVtt(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Read sentence pairs for a language learning audiobook
   */
  async languageLearningReadSentencePairs(projectId: string): Promise<{
    success: boolean;
    pairs?: Array<{
      index: number;
      source: string;
      target: string;
      sourceTimestamp?: number;
      targetTimestamp?: number;
    }>;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.readSentencePairs(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async languageLearningGetAnalytics(projectId: string): Promise<{
    success: boolean;
    analytics?: any;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.getAnalytics(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  async languageLearningSaveAnalytics(projectId: string, analytics: any): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.saveAnalytics(projectId, analytics);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Finalize article content - saves the filtered HTML for processing
   */
  async languageLearningFinalizeContent(projectId: string, finalizedHtml: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.languageLearning) {
      return (window as any).electron.languageLearning.finalizeContent(projectId, finalizedHtml);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * List files in a directory
   */
  async listDirectory(dirPath: string): Promise<string[]> {
    if (this.isElectron && (window as any).electron.fs) {
      return (window as any).electron.fs.listDirectory(dirPath);
    }
    return [];
  }

  /**
   * Show a file in the system file manager
   */
  async showInFolder(path: string): Promise<void> {
    if (this.isElectron && (window as any).electron.shell) {
      await (window as any).electron.shell.showItemInFolder(path);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Manifest Service (Unified Project Management)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new unified project
   */
  async manifestCreate(
    projectType: 'book' | 'article',
    source: any,
    metadata: any
  ): Promise<{
    success: boolean;
    projectId?: string;
    projectPath?: string;
    manifestPath?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.create(projectType, source, metadata);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Get a project manifest
   */
  async manifestGet(projectId: string): Promise<{
    success: boolean;
    manifest?: any;
    projectPath?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.get(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Save (update) a project manifest
   */
  async manifestSave(manifest: any): Promise<{
    success: boolean;
    manifestPath?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.save(manifest);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Update specific fields in a manifest
   */
  async manifestUpdate(update: any): Promise<{
    success: boolean;
    manifestPath?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.update(update);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * List all unified projects
   */
  async manifestList(filter?: { type?: 'book' | 'article' }): Promise<{
    success: boolean;
    projects?: any[];
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.list(filter);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Get all unique tags across all projects
   */
  async manifestGetAllTags(): Promise<string[]> {
    if (this.isElectron && (window as any).electron.manifest?.getAllTags) {
      return (window as any).electron.manifest.getAllTags();
    }
    return [];
  }

  /**
   * List project summaries (lightweight)
   */
  async manifestListSummaries(filter?: { type?: 'book' | 'article' }): Promise<{
    success: boolean;
    summaries?: any[];
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.listSummaries(filter);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Delete a unified project
   */
  async manifestDelete(projectId: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.delete(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Import a source file into a project
   */
  async manifestImportSource(
    projectId: string,
    sourcePath: string,
    targetFilename?: string
  ): Promise<{
    success: boolean;
    relativePath?: string;
    error?: string;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.importSource(projectId, sourcePath, targetFilename);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Resolve a relative manifest path to absolute OS path
   */
  async manifestResolvePath(projectId: string, relativePath: string): Promise<string | null> {
    if (this.isElectron && (window as any).electron.manifest) {
      const result = await (window as any).electron.manifest.resolvePath(projectId, relativePath);
      return result?.path || null;
    }
    return null;
  }

  /**
   * Get project folder path
   */
  async manifestGetProjectPath(projectId: string): Promise<string | null> {
    if (this.isElectron && (window as any).electron.manifest) {
      const result = await (window as any).electron.manifest.getProjectPath(projectId);
      return result?.path || null;
    }
    return null;
  }

  /**
   * Check if project exists
   */
  async manifestExists(projectId: string): Promise<boolean> {
    if (this.isElectron && (window as any).electron.manifest) {
      const result = await (window as any).electron.manifest.exists(projectId);
      return result?.exists || false;
    }
    return false;
  }

  /**
   * Check if migration is needed
   */
  async manifestNeedsMigration(): Promise<boolean> {
    if (this.isElectron && (window as any).electron.manifest) {
      const result = await (window as any).electron.manifest.needsMigration();
      return result?.needsMigration || false;
    }
    return false;
  }

  /**
   * Scan for legacy projects
   */
  async manifestScanLegacy(): Promise<{
    success: boolean;
    bfpCount: number;
    audiobookCount: number;
    articleCount: number;
    total: number;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.scanLegacy();
    }
    return { success: false, bfpCount: 0, audiobookCount: 0, articleCount: 0, total: 0 };
  }

  /**
   * Migrate all legacy projects
   */
  async manifestMigrateAll(): Promise<{
    success: boolean;
    migrated: string[];
    failed: Array<{ path: string; error: string }>;
  }> {
    if (this.isElectron && (window as any).electron.manifest) {
      return (window as any).electron.manifest.migrateAll();
    }
    return { success: false, migrated: [], failed: [] };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Archive Service
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Save a project file to the archive
   */
  async archiveSaveToArchive(
    projectId: string,
    sourcePath: string,
    options: { role: 'original' | 'translation' | 'export' | 'audiobook'; format: string; language?: string; label?: string }
  ): Promise<{ success: boolean; entry?: any; error?: string }> {
    if (this.isElectron && (window as any).electron.archive) {
      return (window as any).electron.archive.saveToArchive(projectId, sourcePath, options);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * List archive entries for a project
   */
  async archiveList(projectId: string): Promise<{ success: boolean; entries?: any[]; error?: string }> {
    if (this.isElectron && (window as any).electron.archive) {
      return (window as any).electron.archive.list(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Add a file to the archive via file picker
   */
  async archiveAddFile(projectId: string): Promise<{ success: boolean; canceled?: boolean; entry?: any; error?: string }> {
    if (this.isElectron && (window as any).electron.archive) {
      return (window as any).electron.archive.addFile(projectId);
    }
    return { success: false, error: 'Not running in Electron' };
  }

  /**
   * Migrate existing projects to the archive system by matching against ebook library
   */
  async archiveMigrateFromLibrary(): Promise<{
    success: boolean; migrated: number; skipped: number;
    failed: Array<{ title: string; error: string }>; error?: string;
  }> {
    if (this.isElectron && (window as any).electron.archive) {
      return (window as any).electron.archive.migrateFromLibrary();
    }
    return { success: false, migrated: 0, skipped: 0, failed: [], error: 'Not running in Electron' };
  }

  // ── Optional Component System ──────────────────────────────────────────────
  // Mirrors the locked renderer contract. The underlying IPC returns the contract
  // types raw (no { success, error } envelope), so outside Electron we reject with
  // a clear error rather than fabricate a value — except onProgress, which mirrors
  // the other subscription helpers and returns a no-op unsubscribe.
  readonly components = {
    list: (): Promise<ComponentStatus[]> => {
      if (this.isElectron) {
        return (window as any).electron.components.list();
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    get: (id: string): Promise<ComponentStatus | null> => {
      if (this.isElectron) {
        return (window as any).electron.components.get(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    probe: (force?: boolean): Promise<SystemProfile> => {
      if (this.isElectron) {
        return (window as any).electron.components.probe(force);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    detectExternal: (id: string): Promise<string | null> => {
      if (this.isElectron) {
        return (window as any).electron.components.detectExternal(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    setExternalPath: (id: string, path: string): Promise<ComponentStatus> => {
      if (this.isElectron) {
        return (window as any).electron.components.setExternalPath(id, path);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    install: (id: string): Promise<InstallResult> => {
      if (this.isElectron) {
        return (window as any).electron.components.install(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    runInstaller: (id: string): Promise<InstallResult> => {
      if (this.isElectron) {
        return (window as any).electron.components.runInstaller(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    installers: (): Promise<{ ids: string[]; notes: Record<string, string | null> }> => {
      if (this.isElectron) {
        return (window as any).electron.components.installers();
      }
      return Promise.resolve({ ids: [], notes: {} });
    },
    cancel: (id: string): Promise<void> => {
      if (this.isElectron) {
        return (window as any).electron.components.cancel(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    uninstall: (id: string): Promise<void> => {
      if (this.isElectron) {
        return (window as any).electron.components.uninstall(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    testEnv: (id: string): Promise<EnvDiagnosticResult> => {
      if (this.isElectron) {
        return (window as any).electron.components.testEnv(id);
      }
      return Promise.reject(new Error('Not running in Electron'));
    },
    onProgress: (cb: (p: InstallProgress) => void): () => void => {
      if (this.isElectron) {
        return (window as any).electron.components.onProgress(cb);
      }
      return () => {};
    },
  };

  // ── Whisper transcription models ───────────────────────────────────────────
  // The runtime (id 'whisper') installs through `components`; these manage the
  // downloadable model weights used by "Generate sentences".
  readonly whisper = {
    listModels: (): Promise<{ success: boolean; data?: WhisperModelStatus[]; error?: string }> => {
      if (this.isElectron) {
        return (window as any).electron.whisper.listModels();
      }
      return Promise.resolve({ success: false, error: 'Not running in Electron' });
    },
    downloadModel: (id: string): Promise<{ ok: boolean; error?: string }> => {
      if (this.isElectron) {
        return (window as any).electron.whisper.downloadModel(id);
      }
      return Promise.resolve({ ok: false, error: 'Not running in Electron' });
    },
    deleteModel: (id: string): Promise<{ ok: boolean; error?: string }> => {
      if (this.isElectron) {
        return (window as any).electron.whisper.deleteModel(id);
      }
      return Promise.resolve({ ok: false, error: 'Not running in Electron' });
    },
    onDownloadProgress: (cb: (p: WhisperDownloadProgress) => void): () => void => {
      if (this.isElectron) {
        return (window as any).electron.whisper.onDownloadProgress(cb);
      }
      return () => {};
    },
  };
}

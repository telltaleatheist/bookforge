/**
 * PDF Analyzer for BookForge - Pure TypeScript/mupdf.js implementation
 * Replaces the Python pdf_analyzer.py
 */
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { pdfBridgeManager, RedactionRegion, Bookmark, MupdfJsBridge } from './pdf-bridge';
import { MutoolBridge } from './mutool-bridge';

const execAsync = promisify(exec);

// Cache version - increment this when changing extraction logic to invalidate old caches
const ANALYSIS_CACHE_VERSION = 7;  // v7: improved header detection for single-line top blocks

// Dynamic import for ESM mupdf module
let mupdf: typeof import('mupdf') | null = null;

async function getMupdf() {
  if (!mupdf) {
    mupdf = await import('mupdf');
  }
  return mupdf;
}

// Types
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
  color?: string;
  baseline_offset: number;  // Offset from line baseline (positive = superscript, negative = subscript)
  block_id: string;         // Parent block ID
}

export interface TextBlock {
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
  is_footnote_marker: boolean;  // Inline footnote reference marker (¹, ², [1], etc.)
  parent_block_id?: string;     // If this is a marker extracted from a parent block
  line_count: number;
  is_ocr?: boolean;             // True if this block was generated via OCR (independent from images)
}

export interface Category {
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
}

export interface PageDimension {
  width: number;
  height: number;
  originX?: number;  // Page origin X offset (for non-zero MediaBox)
  originY?: number;  // Page origin Y offset (for non-zero MediaBox)
}

export interface AnalyzeResult {
  blocks: TextBlock[];
  categories: Record<string, Category>;
  page_count: number;
  page_dimensions: PageDimension[];
  pdf_name: string;
  spans: TextSpan[];  // All extracted spans for sample picking
}

export interface ExportTextResult {
  text: string;
  char_count: number;
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
  y?: number;                // Y position on the page (from resolved links)
  down?: OutlineItem[];      // Nested children
}

export interface DeletedRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isImage?: boolean;
  text?: string;  // Text content for matching (more reliable than position)
}

// OCR text block for embedding in exported PDF
export interface OcrTextBlock {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
}

// Semantic colors for category types
const CATEGORY_TYPE_COLORS: Record<string, string> = {
  body: '#4CAF50',        // Green
  footnote: '#2196F3',    // Blue
  footnote_ref: '#E91E63', // Pink (superscript blocks detected by mupdf)
  heading: '#FF9800',     // Orange
  subheading: '#9C27B0',  // Purple
  title: '#F44336',       // Red
  caption: '#00BCD4',     // Cyan
  quote: '#FFEB3B',       // Yellow
  header: '#795548',      // Brown
  footer: '#607D8B',      // Blue Grey
  image: '#9E9E9E',       // Grey
};

const FALLBACK_COLORS = [
  '#E91E63', '#3F51B5', '#009688', '#8BC34A',
  '#FF5722', '#673AB7', '#00E676', '#FF4081', '#536DFE',
];

// Patterns for detecting footnote markers in text (used during export)
// These patterns are used to strip markers from text when exporting, not for visual display
const FOOTNOTE_MARKER_PATTERNS = [
  /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,                    // Unicode superscript digits
  /[\u00B9\u00B2\u00B3]+/g,             // ¹²³ (superscript 1, 2, 3)
  /\[\d{1,3}\]/g,                        // [1], [2], [12] - bracketed
];

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.epub': return 'application/epub+zip';
    case '.xps': return 'application/vnd.ms-xpsdocument';
    case '.mobi': return 'application/x-mobipocket-ebook';
    case '.fb2': return 'application/x-fictionbook+xml';
    default: return ''; // Let mupdf auto-detect
  }
}

/**
 * Document Analyzer class - handles PDF/EPUB analysis, rendering, and export
 */
export class PDFAnalyzer {
  private blocks: TextBlock[] = [];
  private spans: TextSpan[] = [];
  private categories: Record<string, Category> = {};
  private pageDimensions: PageDimension[] = [];
  private doc: any = null; // mupdf.PDFDocument | mupdf.Document
  private pdfPath: string | null = null;
  private mutoolBridge: MutoolBridge = new MutoolBridge();

  /**
   * Get the base cache directory for BookForge
   */
  private getAnalysisCacheDir(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, 'Documents', 'BookForge', 'cache');
  }

  /**
   * Compute file hash for cache keying
   */
  private async computeAnalysisHash(filePath: string): Promise<string> {
    const data = await fsPromises.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Get path for cached analysis data
   * Includes version number to invalidate cache when extraction logic changes
   */
  private async getAnalysisCachePath(fileHash: string): Promise<string> {
    const cacheDir = path.join(this.getAnalysisCacheDir(), fileHash);
    try {
      await fsPromises.access(cacheDir);
    } catch {
      await fsPromises.mkdir(cacheDir, { recursive: true });
    }
    // Include version in filename to invalidate old caches
    return path.join(cacheDir, `analysis-v${ANALYSIS_CACHE_VERSION}.json`);
  }

  /**
   * Load cached analysis if available
   */
  private async loadCachedAnalysis(fileHash: string): Promise<AnalyzeResult | null> {
    const cachePath = await this.getAnalysisCachePath(fileHash);
    try {
      const data = await fsPromises.readFile(cachePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      // File doesn't exist or read failed
      return null;
    }
  }

  /**
   * Save analysis to cache
   */
  private async saveAnalysisToCache(fileHash: string, result: AnalyzeResult): Promise<void> {
    const cachePath = await this.getAnalysisCachePath(fileHash);
    try {
      await fsPromises.writeFile(cachePath, JSON.stringify(result), 'utf-8');
    } catch (err) {
      console.error('Failed to save analysis cache:', err);
    }
  }

  /**
   * Analyze a document (PDF, EPUB, etc.) and extract blocks with categories
   * Uses cached analysis if available for the same file
   */
  async analyze(
    pdfPath: string,
    maxPages?: number,
    onProgress?: (phase: string, message: string) => void
  ): Promise<AnalyzeResult> {
    const sendProgress = onProgress || (() => {});
    sendProgress('loading', 'Loading document...');

    const mupdfLib = await getMupdf();
    const fileHash = await this.computeAnalysisHash(pdfPath);

    // Check for cached analysis (only if no maxPages limit or limit matches)
    if (!maxPages) {
      const cached = await this.loadCachedAnalysis(fileHash);
      if (cached) {
        // Restore internal state from cache
        this.pdfPath = pdfPath;
        this.blocks = cached.blocks;
        this.spans = cached.spans || [];
        this.categories = cached.categories;
        this.pageDimensions = cached.page_dimensions;

        // Still need to open the document for rendering
        const data = await fsPromises.readFile(pdfPath);
        const mimeType = getMimeType(pdfPath);
        this.doc = mupdfLib.Document.openDocument(data, mimeType);

        // Layout reflowable documents (EPUBs) so page numbers are meaningful
        if (mimeType === 'application/epub+zip') {
          this.doc.layout(800, 1200, 12);
        }

        return cached;
      }
    }

    this.pdfPath = pdfPath;
    this.blocks = [];
    this.spans = [];
    this.categories = {};
    this.pageDimensions = [];

    // Read document file asynchronously to avoid blocking the main thread
    sendProgress('loading', 'Reading document file...');
    const data = await fsPromises.readFile(pdfPath);
    const mimeType = getMimeType(pdfPath);

    // Open document with error handling for WebAssembly memory issues
    try {
      this.doc = mupdfLib.Document.openDocument(data, mimeType);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('memory') || errorMsg.includes('out of bounds') || errorMsg.includes('malloc')) {
        throw new Error(`Document is too large to load. Try closing other documents first, or restart the app to free memory.`);
      }
      throw err;
    }

    // Layout reflowable documents (EPUBs) so page numbers are meaningful
    if (this.doc.isReflowable()) {
      this.doc.layout(800, 1200, 12);
    }

    let totalPages: number;
    try {
      totalPages = this.doc.countPages();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('memory') || errorMsg.includes('out of bounds')) {
        throw new Error(`Document is too large to process. The file may be corrupted or exceed memory limits.`);
      }
      throw err;
    }

    const pageCount = maxPages ? Math.min(totalPages, maxPages) : totalPages;
    sendProgress('loading', `Document has ${pageCount} pages, getting dimensions...`);

    // Get page dimensions (including origin for coordinate transformation)
    for (let pageNum = 0; pageNum < pageCount; pageNum++) {
      try {
        const page = this.doc.loadPage(pageNum);
        const bounds = page.getBounds();
        this.pageDimensions.push({
          width: bounds[2] - bounds[0],
          height: bounds[3] - bounds[1],
          originX: bounds[0],  // Store origin for coordinate transformation
          originY: bounds[1],
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes('memory') || errorMsg.includes('out of bounds')) {
          console.error(`[PDF Analyzer] Memory error loading page ${pageNum}, using default dimensions`);
          // Use default dimensions for pages that can't be loaded
          this.pageDimensions.push({
            width: 612,  // Letter size default
            height: 792,
            originX: 0,
            originY: 0,
          });
        } else {
          throw err;
        }
      }
    }

    // Determine if this is a PDF (mutool only works with PDFs, not EPUBs)
    const isPdf = mimeType === 'application/pdf' || pdfPath.toLowerCase().endsWith('.pdf');

    // Use mutool for text extraction (character-level precision, font info)
    let usedMutool = false;
    if (isPdf) {
      try {
        const mutoolAvailable = await this.mutoolBridge.isAvailable();
        if (mutoolAvailable) {
          // This is the slow part - extracting text from all pages
          sendProgress('extracting', `Extracting text from ${pageCount} pages (this may take a few minutes for large documents)...`);

          // Extract both blocks and spans in one pass (more efficient)
          const { blocks: mutoolBlocks, spans: mutoolSpans } = await this.mutoolBridge.extractAll(
            pdfPath,
            pageCount,
            this.pageDimensions
          );

          sendProgress('processing', `Processing ${mutoolBlocks.length} text blocks...`);

          // Convert MutoolTextBlock to TextBlock (compatible interfaces)
          this.blocks = mutoolBlocks.map(mb => ({
            id: mb.id,
            page: mb.page,
            x: mb.x,
            y: mb.y,
            width: mb.width,
            height: mb.height,
            text: mb.text,
            font_size: mb.font_size,
            font_name: mb.font_name,
            char_count: mb.char_count,
            region: mb.region,
            category_id: mb.category_id,
            is_bold: mb.is_bold,
            is_italic: mb.is_italic,
            is_superscript: mb.is_superscript,
            is_image: mb.is_image,
            is_footnote_marker: mb.is_footnote_marker,
            line_count: mb.line_count
          }));

          // Convert MutoolTextSpan to TextSpan
          this.spans = mutoolSpans.map(ms => ({
            id: ms.id,
            page: ms.page,
            x: ms.x,
            y: ms.y,
            width: ms.width,
            height: ms.height,
            text: ms.text,
            font_size: ms.font_size,
            font_name: ms.font_name,
            is_bold: ms.is_bold,
            is_italic: ms.is_italic,
            baseline_offset: ms.baseline_offset,
            block_id: ms.block_id
          }));

          usedMutool = true;

          // Also extract images using mupdf.js (mutool stext doesn't include images)
          const imageBlocks = await this.extractImageBlocks(pageCount);
          if (imageBlocks.length > 0) {
            this.blocks.push(...imageBlocks);
          }
        } else {
          throw new Error('mutool binary not found - run "npm run download:mupdf"');
        }
      } catch (err) {
        console.error('mutool extraction failed:', (err as Error).message);
        throw err; // Don't silently fall back - mutool is required
      }
    }

    // For non-PDF documents (EPUBs), use mupdf.js
    if (!usedMutool) {
      // Extract blocks from each page using mupdf.js
      for (let pageNum = 0; pageNum < pageCount; pageNum++) {
        await this.extractPageBlocks(pageNum);
      }

      // No span extraction for EPUBs (mutool doesn't support them)
    }

    // Generate categories
    this.generateCategories();

    const result: AnalyzeResult = {
      blocks: this.blocks,
      categories: this.categories,
      page_count: pageCount,
      page_dimensions: this.pageDimensions,
      pdf_name: path.basename(pdfPath),
      spans: this.spans,
    };

    // Cache the analysis (only for full document analysis)
    if (!maxPages) {
      await this.saveAnalysisToCache(fileHash, result);
    }

    return result;
  }

  /**
   * Extract text and image blocks from a single page
   */
  private async extractPageBlocks(pageNum: number): Promise<void> {
    if (!this.doc) return;

    const page = this.doc.loadPage(pageNum);
    const pageDims = this.pageDimensions[pageNum];
    const pageHeight = pageDims.height;

    // Get structured text with detailed info including spans for superscript detection
    const stext = page.toStructuredText('preserve-whitespace,preserve-images,preserve-spans');
    const jsonStr = stext.asJSON(1); // scale=1 for original coordinates
    const stextData = JSON.parse(jsonStr);



    // Track image rects to avoid duplicates
    const imageRects = new Set<string>();

    // Process blocks from structured text
    // mupdf.js bbox can be array [x0, y0, x1, y1] or object {x, y, w, h}
    for (let blockIdx = 0; blockIdx < stextData.blocks.length; blockIdx++) {
      const block = stextData.blocks[blockIdx];

      // Parse bbox - handle both array and object formats
      let x: number, y: number, width: number, height: number;

      if (Array.isArray(block.bbox) && block.bbox.length >= 4) {
        // Array format: [x0, y0, x1, y1]
        const [x0, y0, x1, y1] = block.bbox;
        x = x0;
        y = y0;
        width = x1 - x0;
        height = y1 - y0;
      } else if (block.bbox && typeof block.bbox.x === 'number') {
        // Object format: {x, y, w, h}
        x = block.bbox.x;
        y = block.bbox.y;
        width = block.bbox.w;
        height = block.bbox.h;
      } else {
        // Skip blocks without valid bbox
        continue;
      }


      // Handle image blocks (blocks with 'image' property or type)
      if (block.type === 'image' || block.image) {

        // Skip very small images
        if (width < 20 || height < 20) continue;

        const rectKey = `${Math.round(x)},${Math.round(y)},${Math.round(x + width)},${Math.round(y + height)}`;
        if (imageRects.has(rectKey)) continue;
        imageRects.add(rectKey);

        const blockId = this.hashId(`${pageNum}:img:${x.toFixed(0)},${y.toFixed(0)}`);

        this.blocks.push({
          id: blockId,
          page: pageNum,
          x,
          y,
          width,
          height,
          text: `[Image ${Math.round(width)}x${Math.round(height)}]`,
          font_size: 0,
          font_name: 'image',
          char_count: 0,
          region: 'body',
          category_id: '',
          is_bold: false,
          is_italic: false,
          is_superscript: false,
          is_image: true,
          is_footnote_marker: false,
          line_count: 0,
        });
        continue;
      }

      // Handle text blocks (blocks with 'lines' property)
      if (block.lines && block.lines.length > 0) {
        const allText: string[] = [];
        const fontSizes: Map<number, number> = new Map();
        const fontNames: Map<string, number> = new Map();
        let boldChars = 0;
        let italicChars = 0;
        let superscriptChars = 0;
        let totalChars = 0;
        const lineCount = block.lines.length;

        // Pre-generate block ID for span references
        const preBlockId = this.hashId(`${pageNum}:${blockIdx}:pre`);

        // Collect potential footnote marker spans to extract separately
        const footnoteMarkerSpans: Array<{
          text: string;
          bbox: number[];
          fontSize: number;
        }> = [];

        // Track spans for this block
        const blockSpans: Array<{
          text: string;
          bbox: number[];
          fontSize: number;
          fontName: string;
          isBold: boolean;
          isItalic: boolean;
          lineY: number;
        }> = [];

        for (const line of block.lines) {
          // Get line baseline Y for offset calculation
          let lineY = y;
          if (Array.isArray(line.bbox) && line.bbox.length >= 4) {
            lineY = line.bbox[3]; // Bottom of line bbox as baseline reference
          }

          // Check if line has spans (from preserve-spans option)
          if (line.spans && Array.isArray(line.spans)) {
            // Process each span separately
            for (const span of line.spans) {
              const spanText = span.text || '';
              if (!spanText.trim()) continue;

              const charLen = spanText.length;
              totalChars += charLen;
              allText.push(spanText);

              const font = span.font || {};
              const size = Math.round((font.size || 10) * 10) / 10;
              fontSizes.set(size, (fontSizes.get(size) || 0) + charLen);

              const fontName = font.name || 'unknown';
              fontNames.set(fontName, (fontNames.get(fontName) || 0) + charLen);

              // Detect bold/italic
              const fontLower = fontName.toLowerCase();
              const spanIsBold = font.weight === 'bold' || fontLower.includes('bold');
              const spanIsItalic = font.style === 'italic' || fontLower.includes('italic') || fontLower.includes('oblique');

              if (spanIsBold) boldChars += charLen;
              if (spanIsItalic) italicChars += charLen;

              // Store span for sample picking (if it has bbox)
              if (span.bbox && Array.isArray(span.bbox) && span.bbox.length >= 4) {
                blockSpans.push({
                  text: spanText,
                  bbox: span.bbox,
                  fontSize: size,
                  fontName,
                  isBold: spanIsBold,
                  isItalic: spanIsItalic,
                  lineY
                });
              }

              // Check if this span looks like a footnote marker
              const looksLikeRef = this.isFootnoteMarkerText(spanText) &&
                                   charLen <= 4 &&
                                   span.bbox;
              if (looksLikeRef) {
                let spanBbox: number[] = [];
                if (Array.isArray(span.bbox) && span.bbox.length >= 4) {
                  spanBbox = span.bbox;
                }
                if (spanBbox.length === 4) {
                  footnoteMarkerSpans.push({
                    text: spanText,
                    bbox: spanBbox,
                    fontSize: size
                  });
                }
              }
            }
          } else {
            // Fallback: no spans, use line-level text
            const text = line.text || '';
            if (text.trim()) {
              allText.push(text);
              const charLen = text.length;
              totalChars += charLen;

              const font = line.font || {};
              const size = Math.round((font.size || 10) * 10) / 10;
              fontSizes.set(size, (fontSizes.get(size) || 0) + charLen);

              const fontName = font.name || 'unknown';
              fontNames.set(fontName, (fontNames.get(fontName) || 0) + charLen);

              const fontLower = fontName.toLowerCase();
              if (font.weight === 'bold' || fontLower.includes('bold')) {
                boldChars += charLen;
              }
              if (font.style === 'italic' || fontLower.includes('italic') || fontLower.includes('oblique')) {
                italicChars += charLen;
              }

              if (line.bbox?.flags && (line.bbox.flags & 1)) {
                superscriptChars += charLen;
              }

              // Store line as a span for sample picking (fallback)
              if (line.bbox && Array.isArray(line.bbox) && line.bbox.length >= 4) {
                blockSpans.push({
                  text,
                  bbox: line.bbox,
                  fontSize: size,
                  fontName,
                  isBold: font.weight === 'bold' || fontLower.includes('bold'),
                  isItalic: font.style === 'italic' || fontLower.includes('italic'),
                  lineY
                });
              }
            }
          }
        }

        const combinedText = allText.join(' ');
        if (!combinedText.trim()) continue;

        // Get dominant font size and name
        let dominantSize = 10;
        let maxSizeCount = 0;
        for (const [size, count] of fontSizes) {
          if (count > maxSizeCount) {
            maxSizeCount = count;
            dominantSize = size;
          }
        }

        let dominantFont = 'unknown';
        let maxFontCount = 0;
        for (const [font, count] of fontNames) {
          if (count > maxFontCount) {
            maxFontCount = count;
            dominantFont = font;
          }
        }

        const isBold = totalChars > 0 && boldChars > totalChars * 0.5;
        const isItalic = totalChars > 0 && italicChars > totalChars * 0.5;
        const isSuperscript = totalChars > 0 && superscriptChars > totalChars * 0.5;

        // Determine region based on position and characteristics
        const yPct = y / pageHeight;
        const textLen = combinedText.length;
        let region = 'body';

        // Running headers: text at very top of page with specific characteristics
        // Must be careful not to catch body text that starts near the top
        const trimmedText = combinedText.trim();

        // Page number patterns: "8 Introduction", "Introduction 10", standalone "42"
        const looksLikePageNum = textLen <= 5 && /^\d+$/.test(trimmedText);
        const startsWithPageNum = /^\d{1,4}\s+\S/.test(trimmedText);  // "8 Introduction"
        const endsWithPageNum = /\S\s+\d{1,4}$/.test(trimmedText);    // "Introduction 8"
        const hasPageNumPattern = looksLikePageNum || startsWithPageNum || endsWithPageNum;

        // Body text indicators: long text, ends with sentence punctuation, has multiple sentences
        const looksLikeBodyText = textLen > 100 ||
                                   /[.!?]["']?\s+[A-Z]/.test(trimmedText) ||  // Multiple sentences
                                   (trimmedText.endsWith('.') && textLen > 60);  // Ends with period and substantial

        // Text blocks entirely within top 15% with 1-2 lines = header
        // (headers often have title + page number on separate lines)
        const bottomPct = (y + height) / pageHeight;
        if (lineCount <= 2 && bottomPct < 0.15 && !looksLikeBodyText) {
          region = 'header';
        }
        // Footer detection
        else if (yPct > 0.92 || (yPct > 0.88 && textLen < 50)) {
          region = 'footer';
        } else if (yPct > 0.70) {
          region = 'lower';
        }

        const blockId = this.hashId(`${pageNum}:${blockIdx}:${combinedText.substring(0, 50)}`);

        this.blocks.push({
          id: blockId,
          page: pageNum,
          x,
          y,
          width,
          height,
          text: combinedText,
          font_size: dominantSize,
          font_name: dominantFont,
          char_count: combinedText.length,
          region,
          category_id: '',
          is_bold: isBold,
          is_italic: isItalic,
          is_superscript: isSuperscript,
          is_image: false,
          is_footnote_marker: false,
          line_count: lineCount,
        });

        // Store all spans for sample picking
        for (let i = 0; i < blockSpans.length; i++) {
          const spanData = blockSpans[i];
          const [sx0, sy0, sx1, sy1] = spanData.bbox;
          const spanId = this.hashId(`${pageNum}:span:${sx0.toFixed(0)},${sy0.toFixed(0)}:${i}`);

          // Calculate baseline offset (positive = above baseline = superscript)
          const baselineOffset = spanData.lineY - sy1;

          this.spans.push({
            id: spanId,
            page: pageNum,
            x: sx0,
            y: sy0,
            width: sx1 - sx0,
            height: sy1 - sy0,
            text: spanData.text,
            font_size: spanData.fontSize,
            font_name: spanData.fontName,
            is_bold: spanData.isBold,
            is_italic: spanData.isItalic,
            baseline_offset: baselineOffset,
            block_id: blockId,
          });
        }

        // Create separate blocks for footnote marker spans (if significantly smaller than body)
        for (const marker of footnoteMarkerSpans) {
          // Only extract if font size is notably smaller than dominant (superscript-like)
          if (marker.fontSize < dominantSize * 0.85) {
            const [mx0, my0, mx1, my1] = marker.bbox;
            const markerId = this.hashId(`${pageNum}:ref:${mx0.toFixed(0)},${my0.toFixed(0)}:${marker.text}`);

            this.blocks.push({
              id: markerId,
              page: pageNum,
              x: mx0,
              y: my0,
              width: mx1 - mx0,
              height: my1 - my0,
              text: marker.text,
              font_size: marker.fontSize,
              font_name: dominantFont,
              char_count: marker.text.length,
              region: 'body',
              category_id: '',
              is_bold: false,
              is_italic: false,
              is_superscript: true,
              is_image: false,
              is_footnote_marker: true,
              parent_block_id: blockId,
              line_count: 1,
            });
          }
        }
      }
    }
  }

  /**
   * Extract image blocks using mupdf.js
   * Called after mutool text extraction to add image detection
   */
  private async extractImageBlocks(pageCount: number): Promise<TextBlock[]> {
    if (!this.doc) return [];

    const imageBlocks: TextBlock[] = [];
    const imageRects = new Set<string>();
    let totalBlocks = 0;
    let imageBlocksFound = 0;

    for (let pageNum = 0; pageNum < pageCount; pageNum++) {
      const page = this.doc.loadPage(pageNum);
      const stext = page.toStructuredText('preserve-whitespace,preserve-images');
      const jsonStr = stext.asJSON(1);
      const stextData = JSON.parse(jsonStr);

      for (const block of stextData.blocks || []) {
        totalBlocks++;

        // Only process image blocks
        if (block.type !== 'image' && !block.image) continue;

        imageBlocksFound++;

        // Parse bbox - raw coordinates from mupdf.js
        let rawX: number, rawY: number, width: number, height: number;
        if (Array.isArray(block.bbox) && block.bbox.length >= 4) {
          const [x0, y0, x1, y1] = block.bbox;
          rawX = x0;
          rawY = y0;
          width = x1 - x0;
          height = y1 - y0;
        } else if (block.bbox && typeof block.bbox.x === 'number') {
          rawX = block.bbox.x;
          rawY = block.bbox.y;
          width = block.bbox.w;
          height = block.bbox.h;
        } else {
          continue;
        }

        // Skip very small images
        if (width < 20 || height < 20) continue;

        // Apply origin offset (same as mutool-bridge does for text)
        // This ensures image and text coordinates are in the same coordinate system
        const pageDim = this.pageDimensions[pageNum];
        const originX = pageDim?.originX || 0;
        const originY = pageDim?.originY || 0;
        const x = rawX - originX;
        const y = rawY - originY;

        // Log if there's a significant origin adjustment
        if (originX !== 0 || originY !== 0) {
          console.log(`[extractImageBlocks] Page ${pageNum}: Adjusting image coords from raw (${rawX.toFixed(1)}, ${rawY.toFixed(1)}) to adjusted (${x.toFixed(1)}, ${y.toFixed(1)}) with origin (${originX}, ${originY})`);
        }

        // Dedupe by page + rect (must include page number!) - using adjusted coordinates
        const rectKey = `${pageNum}:${Math.round(x)},${Math.round(y)},${Math.round(x + width)},${Math.round(y + height)}`;
        if (imageRects.has(rectKey)) continue;
        imageRects.add(rectKey);

        const blockId = this.hashId(`${pageNum}:img:${x.toFixed(0)},${y.toFixed(0)}`);

        imageBlocks.push({
          id: blockId,
          page: pageNum,
          x,
          y,
          width,
          height,
          text: `[Image ${Math.round(width)}x${Math.round(height)}]`,
          font_size: 0,
          font_name: 'image',
          char_count: 0,
          region: 'body',
          category_id: '',
          is_bold: false,
          is_italic: false,
          is_superscript: false,
          is_image: true,
          is_footnote_marker: false,
          line_count: 0,
        });
      }
    }

    return imageBlocks;
  }

  /**
   * Generate categories based on block attributes
   */
  private generateCategories(): void {
    // Find body text size (most common in body region)
    const sizeChars = new Map<number, number>();
    for (const block of this.blocks) {
      if (block.region === 'body' && !block.is_bold && !block.is_image) {
        sizeChars.set(block.font_size, (sizeChars.get(block.font_size) || 0) + block.char_count);
      }
    }

    let bodySize = 10;
    let maxChars = 0;
    for (const [size, chars] of sizeChars) {
      if (chars > maxChars) {
        maxChars = chars;
        bodySize = size;
      }
    }

    // Classify blocks and group by type
    const groups = new Map<string, TextBlock[]>();
    for (const block of this.blocks) {
      const catType = this.classifyBlock(block, bodySize);
      if (!groups.has(catType)) {
        groups.set(catType, []);
      }
      groups.get(catType)!.push(block);
    }

    // Sort groups by total char count
    const sortedGroups = [...groups.entries()].sort((a, b) => {
      const aChars = a[1].reduce((sum, b) => sum + b.char_count, 0);
      const bChars = b[1].reduce((sum, b) => sum + b.char_count, 0);
      return bChars - aChars;
    });

    // Create categories
    let fallbackIdx = 0;
    for (const [catType, blocks] of sortedGroups) {
      const totalChars = blocks.reduce((sum, b) => sum + b.char_count, 0);
      const avgSize = blocks.reduce((sum, b) => sum + b.font_size, 0) / blocks.length;

      // Generate name and description
      let name: string;
      let description: string;
      switch (catType) {
        case 'body':
          name = 'Body Text';
          description = `Main content (${blocks.length} blocks)`;
          break;
        case 'footnote':
          name = 'Footnotes';
          description = `Footnotes and references (${blocks.length} blocks)`;
          break;
        case 'footnote_ref':
          name = 'Footnote Numbers';
          description = `Superscript reference numbers (${blocks.length} blocks)`;
          break;
        case 'heading':
          name = 'Section Headings';
          description = 'Bold section titles';
          break;
        case 'subheading':
          name = 'Subheadings';
          description = 'Bold subsection titles';
          break;
        case 'title':
          name = 'Titles';
          description = 'Large titles or chapter headings';
          break;
        case 'header':
          name = 'Page Headers';
          description = 'Running header text';
          break;
        case 'footer':
          name = 'Page Footers';
          description = 'Page numbers or footer text';
          break;
        case 'caption':
          name = 'Captions';
          description = 'Figure or table captions';
          break;
        case 'quote':
          name = 'Block Quotes';
          description = 'Indented quotations';
          break;
        case 'image':
          name = 'Images';
          description = `Figures and images (${blocks.length} blocks)`;
          break;
        default:
          name = `Other (${catType})`;
          description = 'Other text style';
      }

      // Get color
      let color = CATEGORY_TYPE_COLORS[catType];
      if (!color) {
        color = FALLBACK_COLORS[fallbackIdx % FALLBACK_COLORS.length];
        fallbackIdx++;
      }

      // Use the category type directly as ID for consistency with OCR categories
      const catId = catType;
      const sample = blocks[0]?.text.substring(0, 100) || '';

      this.categories[catId] = {
        id: catId,
        name,
        description,
        color,
        block_count: blocks.length,
        char_count: totalChars,
        font_size: Math.round(avgSize * 10) / 10,
        region: blocks[0]?.region || 'body',
        sample_text: sample,
        enabled: true,
      };

      // Assign category to blocks
      for (const block of blocks) {
        block.category_id = catId;
      }
    }
  }

  /**
   * Check if text is primarily a footnote reference marker
   */
  private isFootnoteMarkerText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 6) return false;

    // Unicode superscript numbers
    if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹\u00B9\u00B2\u00B3]+$/.test(trimmed)) return true;

    // Plain numbers (1-999)
    if (/^\d{1,3}$/.test(trimmed)) return true;

    // Bracketed numbers [1], (1), etc.
    if (/^[\[\(]\d{1,3}[\]\)]$/.test(trimmed)) return true;

    // Asterisk or dagger markers
    if (/^[\*†‡§¶]+$/.test(trimmed)) return true;

    return false;
  }

  /**
   * Classify a block into a semantic category
   */
  private classifyBlock(block: TextBlock, bodySize: number): string {
    if (block.is_image) return 'image';

    // Check if the block text is PRIMARILY a footnote marker
    // This catches small isolated reference numbers
    if (this.isFootnoteMarkerText(block.text)) {
      return 'footnote_ref';
    }

    // Superscript text blocks (mupdf flag detection)
    if (block.is_superscript) return 'footnote_ref';

    // Very small isolated text with small font might be footnote refs
    if (block.font_size < bodySize * 0.75 && block.char_count <= 4 && block.line_count === 1) {
      return 'footnote_ref';
    }

    // Header region blocks are headers
    if (block.region === 'header') return 'header';
    if (block.region === 'footer') return 'footer';

    // Additional header detection for blocks that slipped through region detection
    // Be conservative - body text near top of page should NOT be caught
    const pageHeight = this.pageDimensions[block.page]?.height || 800;
    const yPct = block.y / pageHeight;
    const text = block.text.trim();

    // Body text indicators - skip these
    const looksLikeBodyText = block.char_count > 100 ||
                              /[.!?]["']?\s+[A-Z]/.test(text) ||  // Multiple sentences
                              (text.endsWith('.') && block.char_count > 60);

    // Text blocks entirely within top 15% with 1-2 lines = header
    const bottomPct = (block.y + block.height) / pageHeight;
    if (block.line_count <= 2 && bottomPct < 0.15 && !looksLikeBodyText) {
      return 'header';
    }

    // Footnotes: lower region with smaller font
    if (block.region === 'lower' && block.font_size < bodySize * 0.95) {
      return 'footnote';
    }

    // Small text in body might be captions
    if (block.font_size < bodySize * 0.85 && block.region !== 'lower') {
      return 'caption';
    }

    // Large text is titles
    if (block.font_size > bodySize * 1.4) return 'title';

    // Bold text = headings
    if (block.is_bold) {
      if (block.font_size > bodySize * 1.1) return 'heading';
      if (block.line_count <= 2 && block.char_count < 200) return 'subheading';
    }

    // Italic multi-line = quotes
    if (block.is_italic && block.line_count > 2) return 'quote';

    return 'body';
  }

  // Persistent cache directory for rendered pages
  private cacheDir: string | null = null;
  private currentFileHash: string | null = null;
  private renderedPagePaths: Map<number, string> = new Map();

  // Scale constants for two-tier rendering
  private readonly PREVIEW_SCALE = 0.5;  // Fast, low quality
  private readonly FULL_SCALE = 2.5;     // Slower, high quality

  /**
   * Get the base cache directory for BookForge
   */
  private getCacheBaseDir(): string {
    const homeDir = os.homedir();
    return path.join(homeDir, 'Documents', 'BookForge', 'cache');
  }

  /**
   * Get or create cache directory for a specific file (by hash)
   */
  private getCacheDir(fileHash: string): string {
    const baseDir = this.getCacheBaseDir();
    const cacheDir = path.join(baseDir, fileHash);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
  }

  /**
   * Get cache subdirectory for a specific quality level
   */
  private getQualityCacheDir(fileHash: string, quality: 'preview' | 'full'): string {
    const cacheDir = this.getCacheDir(fileHash);
    const qualityDir = path.join(cacheDir, quality);
    if (!fs.existsSync(qualityDir)) {
      fs.mkdirSync(qualityDir, { recursive: true });
    }
    return qualityDir;
  }

  /**
   * Compute SHA256 hash of a file for cache keying
   */
  private computeFileHash(filePath: string): string {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Check if a page is already cached
   */
  private isPageCached(fileHash: string, pageNum: number, quality: 'preview' | 'full'): boolean {
    const qualityDir = this.getQualityCacheDir(fileHash, quality);
    const filePath = path.join(qualityDir, `page-${pageNum}.png`);
    return fs.existsSync(filePath);
  }

  /**
   * Get cached page path if it exists
   */
  private getCachedPagePath(fileHash: string, pageNum: number, quality: 'preview' | 'full'): string | null {
    const qualityDir = this.getQualityCacheDir(fileHash, quality);
    const filePath = path.join(qualityDir, `page-${pageNum}.png`);
    return fs.existsSync(filePath) ? filePath : null;
  }

  /**
   * Clean up cache for a specific file hash (includes render cache and analysis cache)
   */
  clearCache(fileHash: string): void {
    // Analysis cache uses truncated 16-char hash, so clear both full and truncated
    const truncatedHash = fileHash.substring(0, 16);
    const baseCacheDir = this.getCacheBaseDir();

    // Clear truncated hash directory (analysis cache)
    const truncatedCacheDir = path.join(baseCacheDir, truncatedHash);
    if (fs.existsSync(truncatedCacheDir)) {
      try {
        fs.rmSync(truncatedCacheDir, { recursive: true, force: true });
        console.log(`[clearCache] Cleared truncated hash cache: ${truncatedHash}`);
      } catch (err) {
        console.error('Failed to clear truncated cache:', err);
      }
    }

    // Also clear full hash directory (render cache) if different
    const cacheDir = path.join(baseCacheDir, fileHash);
    if (fs.existsSync(cacheDir)) {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch (err) {
        console.error('Failed to clear cache:', err);
      }
    }
    this.renderedPagePaths.clear();
  }

  /**
   * Clean up all cache (for all files)
   */
  clearAllCache(): { cleared: number; freedBytes: number } {
    const baseDir = this.getCacheBaseDir();
    let cleared = 0;
    let freedBytes = 0;

    if (fs.existsSync(baseDir)) {
      try {
        const dirs = fs.readdirSync(baseDir);
        for (const dir of dirs) {
          const dirPath = path.join(baseDir, dir);
          const stat = fs.statSync(dirPath);
          if (stat.isDirectory()) {
            freedBytes += this.getDirSize(dirPath);
            fs.rmSync(dirPath, { recursive: true, force: true });
            cleared++;
          }
        }
      } catch (err) {
        console.error('Failed to clear all cache:', err);
      }
    }

    this.renderedPagePaths.clear();
    return { cleared, freedBytes };
  }

  /**
   * Get cache size for a specific file hash
   */
  getCacheSize(fileHash: string): number {
    const cacheDir = path.join(this.getCacheBaseDir(), fileHash);
    if (!fs.existsSync(cacheDir)) return 0;
    return this.getDirSize(cacheDir);
  }

  /**
   * Get total cache size
   */
  getTotalCacheSize(): number {
    const baseDir = this.getCacheBaseDir();
    if (!fs.existsSync(baseDir)) return 0;
    return this.getDirSize(baseDir);
  }

  /**
   * Helper to calculate directory size recursively
   */
  private getDirSize(dirPath: string): number {
    let size = 0;
    try {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          size += this.getDirSize(itemPath);
        } else {
          size += stat.size;
        }
      }
    } catch {
      // Ignore errors
    }
    return size;
  }

  /**
   * Legacy method for compatibility - clears current file cache
   */
  cleanupTempFiles(): void {
    // Don't actually delete cache - it's persistent now
    this.renderedPagePaths.clear();
  }

  /**
   * Render a single page to cache
   */
  async renderPageToFile(
    pageNum: number,
    scale: number = 2.0,
    pdfPath?: string
  ): Promise<string> {
    const mupdfLib = await getMupdf();
    const targetPath = pdfPath || this.pdfPath;

    if (!targetPath) {
      throw new Error('No document path specified');
    }

    // Compute file hash for cache key
    const fileHash = this.computeFileHash(targetPath);
    const quality: 'preview' | 'full' = scale <= 1.0 ? 'preview' : 'full';

    // Check if already cached
    const cachedPath = this.getCachedPagePath(fileHash, pageNum, quality);
    if (cachedPath) {
      this.renderedPagePaths.set(pageNum, cachedPath);
      return cachedPath;
    }

    // Render the page
    let doc = this.doc;
    let tempDoc: typeof doc | null = null;
    if (pdfPath && pdfPath !== this.pdfPath) {
      const data = fs.readFileSync(pdfPath);
      const mimeType = getMimeType(pdfPath);
      tempDoc = mupdfLib.Document.openDocument(data, mimeType);
      if (mimeType === 'application/epub+zip') {
        tempDoc.layout(800, 1200, 12);
      }
      doc = tempDoc;
    }

    if (!doc) {
      throw new Error('No document loaded');
    }

    try {
      const page = doc.loadPage(pageNum);
      const matrix = mupdfLib.Matrix.scale(scale, scale);
      const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
      const pngData = pixmap.asPNG();

      // Write to cache
      const qualityDir = this.getQualityCacheDir(fileHash, quality);
      const filePath = path.join(qualityDir, `page-${pageNum}.png`);
      fs.writeFileSync(filePath, Buffer.from(pngData));

      this.renderedPagePaths.set(pageNum, filePath);
      return filePath;
    } finally {
      // Clean up temp document if we created one
      if (tempDoc) {
        tempDoc.destroy();
      }
    }
  }

  /**
   * Render all pages with two-tier approach:
   * 1. First render low-res previews quickly
   * 2. Then render high-res in background
   * Returns preview paths immediately, calls callbacks as high-res completes
   */
  async renderAllPagesWithPreviews(
    pdfPath: string,
    concurrency: number = 4,
    previewCallback?: (current: number, total: number) => void,
    fullCallback?: (pageNum: number, path: string) => void,
    progressCallback?: (current: number, total: number, phase: 'preview' | 'full') => void
  ): Promise<{ previewPaths: string[]; fileHash: string }> {
    const mupdfLib = await getMupdf();
    const fileHash = this.computeFileHash(pdfPath);
    this.currentFileHash = fileHash;

    // Open document with error handling for memory issues
    const data = fs.readFileSync(pdfPath);
    const mimeType = getMimeType(pdfPath);
    let doc;
    try {
      doc = mupdfLib.Document.openDocument(data, mimeType);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('memory') || errorMsg.includes('out of bounds') || errorMsg.includes('malloc')) {
        throw new Error(`Document is too large to render. Try closing other documents first, or restart the app.`);
      }
      throw err;
    }

    if (mimeType === 'application/epub+zip') {
      doc.layout(800, 1200, 12);
    }

    let totalPages;
    try {
      totalPages = doc.countPages();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('memory') || errorMsg.includes('out of bounds')) {
        throw new Error(`Could not read document pages. The file may be too large or corrupted.`);
      }
      throw err;
    }

    const previewPaths: string[] = new Array(totalPages);
    const previewDir = this.getQualityCacheDir(fileHash, 'preview');
    const fullDir = this.getQualityCacheDir(fileHash, 'full');

    // Phase 1: Render previews (or use cached)
    let previewCompleted = 0;
    const renderPreview = async (pageNum: number): Promise<void> => {
      const filePath = path.join(previewDir, `page-${pageNum}.png`);

      if (!fs.existsSync(filePath)) {
        try {
          const page = doc.loadPage(pageNum);
          const matrix = mupdfLib.Matrix.scale(this.PREVIEW_SCALE, this.PREVIEW_SCALE);
          const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
          const pngData = pixmap.asPNG();
          fs.writeFileSync(filePath, Buffer.from(pngData));
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[PDF Render] Error rendering preview for page ${pageNum}:`, errorMsg);
          // Continue with other pages even if one fails
        }
      }

      if (fs.existsSync(filePath)) {
        previewPaths[pageNum] = filePath;
      }
      previewCompleted++;

      if (previewCallback) {
        previewCallback(previewCompleted, totalPages);
      }
      if (progressCallback) {
        progressCallback(previewCompleted, totalPages, 'preview');
      }
    };

    // Render previews in batches
    // First batch: render initial pages immediately so user sees content fast
    const initialBatchSize = Math.min(3, totalPages);
    for (let j = 0; j < initialBatchSize; j++) {
      await renderPreview(j);
    }

    // Remaining pages: render in batches with yields to keep UI responsive
    for (let i = initialBatchSize; i < totalPages; i += concurrency * 2) {
      const batch = [];
      for (let j = i; j < Math.min(i + concurrency * 2, totalPages); j++) {
        batch.push(renderPreview(j));
      }
      await Promise.all(batch);
      // Yield control to event loop so UI can update and respond to clicks
      await new Promise(resolve => setImmediate(resolve));
    }

    // Phase 2: Render full quality in background (don't await)
    // For large documents, use reduced scale to avoid memory issues
    const effectiveScale = totalPages > 200 ? 1.5 : totalPages > 100 ? 2.0 : this.FULL_SCALE;
    if (effectiveScale !== this.FULL_SCALE) {
      console.log(`[PDF Render] Large document (${totalPages} pages), using reduced scale: ${effectiveScale}`);
    }

    let fullCompleted = 0;
    let memoryErrorLogged = false;
    const renderFull = async (pageNum: number): Promise<void> => {
      const filePath = path.join(fullDir, `page-${pageNum}.png`);

      if (!fs.existsSync(filePath)) {
        try {
          const page = doc.loadPage(pageNum);
          const matrix = mupdfLib.Matrix.scale(effectiveScale, effectiveScale);
          const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
          const pngData = pixmap.asPNG();
          fs.writeFileSync(filePath, Buffer.from(pngData));
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // Handle memory allocation errors gracefully - use preview instead
          if (errorMsg.includes('malloc') || errorMsg.includes('memory')) {
            if (!memoryErrorLogged) {
              console.warn(`[PDF Render] Memory allocation failed for page ${pageNum}, using preview quality for remaining pages`);
              memoryErrorLogged = true;
            }
            // Copy preview to full if it exists, otherwise skip
            const previewPath = path.join(previewDir, `page-${pageNum}.png`);
            if (fs.existsSync(previewPath)) {
              fs.copyFileSync(previewPath, filePath);
            }
          } else {
            console.error(`[PDF Render] Error rendering page ${pageNum}:`, errorMsg);
          }
        }
      }

      if (fs.existsSync(filePath)) {
        this.renderedPagePaths.set(pageNum, filePath);
      }
      fullCompleted++;

      if (fullCallback && fs.existsSync(filePath)) {
        fullCallback(pageNum, filePath);
      }
      if (progressCallback) {
        progressCallback(fullCompleted, totalPages, 'full');
      }
    };

    // Start full rendering in background (don't block)
    // Use lower concurrency for large documents to reduce memory pressure
    const effectiveConcurrency = totalPages > 200 ? 1 : totalPages > 100 ? 2 : concurrency;
    (async () => {
      try {
        for (let i = 0; i < totalPages; i += effectiveConcurrency) {
          const batch = [];
          for (let j = i; j < Math.min(i + effectiveConcurrency, totalPages); j++) {
            batch.push(renderFull(j));
          }
          await Promise.all(batch);
          // Yield to event loop between batches to allow GC
          await new Promise(resolve => setImmediate(resolve));
        }
      } finally {
        // Destroy document after all rendering is complete to free WebAssembly memory
        try {
          doc.destroy();
          console.log('[PDF Render] Background render complete, document destroyed');
        } catch (err) {
          console.warn('[PDF Render] Error destroying document after render:', err);
        }
      }
    })();

    return { previewPaths, fileHash };
  }

  /**
   * Original method for compatibility - renders all pages at specified scale
   */
  async renderAllPagesToFiles(
    pdfPath: string,
    scale: number = 2.0,
    concurrency: number = 4,
    progressCallback?: (current: number, total: number) => void
  ): Promise<string[]> {
    const mupdfLib = await getMupdf();
    const fileHash = this.computeFileHash(pdfPath);
    this.currentFileHash = fileHash;

    // Open document
    const data = fs.readFileSync(pdfPath);
    const mimeType = getMimeType(pdfPath);
    const doc = mupdfLib.Document.openDocument(data, mimeType);
    if (mimeType === 'application/epub+zip') {
      doc.layout(800, 1200, 12);
    }
    const totalPages = doc.countPages();

    const quality: 'preview' | 'full' = scale <= 1.0 ? 'preview' : 'full';
    const cacheDir = this.getQualityCacheDir(fileHash, quality);

    const paths: string[] = new Array(totalPages);
    let completed = 0;

    const renderPage = async (pageNum: number): Promise<void> => {
      const filePath = path.join(cacheDir, `page-${pageNum}.png`);

      // Check if already cached
      if (!fs.existsSync(filePath)) {
        const page = doc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(scale, scale);
        const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
        const pngData = pixmap.asPNG();
        fs.writeFileSync(filePath, Buffer.from(pngData));
      }

      paths[pageNum] = filePath;
      this.renderedPagePaths.set(pageNum, filePath);

      completed++;
      if (progressCallback) {
        progressCallback(completed, totalPages);
      }
    };

    // Process in batches
    try {
      for (let i = 0; i < totalPages; i += concurrency) {
        const batch = [];
        for (let j = i; j < Math.min(i + concurrency, totalPages); j++) {
          batch.push(renderPage(j));
        }
        await Promise.all(batch);
      }

      return paths;
    } finally {
      // Destroy document to free WebAssembly memory
      try {
        doc.destroy();
      } catch (err) {
        console.warn('[PDF Render] Error destroying document:', err);
      }
    }
  }

  /**
   * Get the file path for a rendered page (if already rendered)
   */
  getRenderedPagePath(pageNum: number): string | null {
    return this.renderedPagePaths.get(pageNum) || null;
  }

  /**
   * Get all rendered page paths
   */
  getAllRenderedPagePaths(): Map<number, string> {
    return new Map(this.renderedPagePaths);
  }

  /**
   * Sample background color from page margins
   * Returns [r, g, b] values (0-255)
   */
  private sampleBackgroundColor(
    samples: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    components: number
  ): [number, number, number] {
    // Sample from corners and edges to get background color
    const samplePoints = [
      [10, 10],                    // Top-left
      [width - 10, 10],            // Top-right
      [10, height - 10],           // Bottom-left
      [width - 10, height - 10],   // Bottom-right
      [Math.floor(width / 2), 10], // Top center
      [Math.floor(width / 2), height - 10], // Bottom center
      [10, Math.floor(height / 2)], // Left center
      [width - 10, Math.floor(height / 2)], // Right center
    ];

    let r = 0, g = 0, b = 0;
    let count = 0;

    for (const [x, y] of samplePoints) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = (Math.floor(y) * width + Math.floor(x)) * components;
        r += samples[idx];
        g += samples[idx + 1];
        b += samples[idx + 2];
        count++;
      }
    }

    if (count === 0) return [255, 255, 255]; // Fallback to white
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  }

  /**
   * Sample background color from around a specific rectangular region.
   * Samples pixels just outside the region to determine local background.
   */
  private sampleBackgroundColorAroundRegion(
    samples: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    components: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): { r: number; g: number; b: number } {
    const margin = 5; // How far outside the region to sample
    const sampleCount = 20; // Number of samples per edge

    let totalR = 0, totalG = 0, totalB = 0;
    let count = 0;

    const samplePixel = (x: number, y: number) => {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * components;
        totalR += samples[idx];
        totalG += samples[idx + 1];
        totalB += samples[idx + 2];
        count++;
      }
    };

    // Sample along top edge (above region)
    for (let i = 0; i < sampleCount; i++) {
      const x = x1 + (x2 - x1) * i / (sampleCount - 1);
      samplePixel(x, y1 - margin);
    }

    // Sample along bottom edge (below region)
    for (let i = 0; i < sampleCount; i++) {
      const x = x1 + (x2 - x1) * i / (sampleCount - 1);
      samplePixel(x, y2 + margin);
    }

    // Sample along left edge (left of region)
    for (let i = 0; i < sampleCount; i++) {
      const y = y1 + (y2 - y1) * i / (sampleCount - 1);
      samplePixel(x1 - margin, y);
    }

    // Sample along right edge (right of region)
    for (let i = 0; i < sampleCount; i++) {
      const y = y1 + (y2 - y1) * i / (sampleCount - 1);
      samplePixel(x2 + margin, y);
    }

    // Fallback: if no samples (region at edge), sample page corners
    if (count === 0) {
      const bgColor = this.sampleBackgroundColor(samples, width, height, components);
      return { r: bgColor[0], g: bgColor[1], b: bgColor[2] };
    }

    return {
      r: Math.round(totalR / count),
      g: Math.round(totalG / count),
      b: Math.round(totalB / count)
    };
  }

  /**
   * Fill a rectangle in pixel data with a solid color
   */
  private fillRectInPixels(
    samples: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    components: number,
    rect: { x: number; y: number; w: number; h: number },
    color: [number, number, number]
  ): void {
    const x1 = Math.max(0, Math.floor(rect.x));
    const y1 = Math.max(0, Math.floor(rect.y));
    const x2 = Math.min(width, Math.floor(rect.x + rect.w));
    const y2 = Math.min(height, Math.floor(rect.y + rect.h));

    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const idx = (y * width + x) * components;
        samples[idx] = color[0];
        samples[idx + 1] = color[1];
        samples[idx + 2] = color[2];
        // Keep alpha if present (components === 4)
      }
    }
  }

  /**
   * Apply background removal to pixel data - turns background-colored pixels to white.
   * Works on scanned pages with yellowed/gray backgrounds.
   */
  private applyBackgroundRemoval(
    samples: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    components: number
  ): void {
    // Sample background color from corners and edges
    const bgColor = this.sampleBackgroundColor(samples, width, height, components);
    const [bgR, bgG, bgB] = bgColor;

    // Replace background-like pixels with white
    const tolerance = 60; // Color distance tolerance
    const luminanceThreshold = 180; // Minimum luminance to be considered background

    for (let i = 0; i < samples.length; i += components) {
      const r = samples[i];
      const g = samples[i + 1];
      const b = samples[i + 2];

      // Calculate luminance (perceived brightness)
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

      // Calculate color distance from detected background
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);

      // If pixel is light AND close to background color, make it white
      if (luminance > luminanceThreshold && colorDist < tolerance) {
        samples[i] = 255;     // R
        samples[i + 1] = 255; // G
        samples[i + 2] = 255; // B
      }
    }
  }

  /**
   * Render a page as PNG (base64)
   * @param redactRegions - Optional regions to blank out before rendering (for deleted/edited blocks)
   * @param fillRegions - Optional regions to fill with background color (for moved blocks)
   * @param removeBackground - If true, also apply background removal (yellowed paper -> white)
   */
  async renderPage(
    pageNum: number,
    scale: number = 2.0,
    pdfPath?: string,
    redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>,
    fillRegions?: Array<{ x: number; y: number; width: number; height: number }>,
    removeBackground?: boolean
  ): Promise<string> {
    const mupdfLib = await getMupdf();

    // If we have redaction regions, always open a fresh document copy
    // to avoid corrupting the cached document
    const hasRedactions = redactRegions && redactRegions.length > 0;

    const pathToUse = pdfPath || this.pdfPath;

    // For redactions or custom path, load fresh document
    if (hasRedactions || pdfPath) {
      if (!pathToUse) {
        throw new Error('No PDF path available');
      }

      const data = fs.readFileSync(pathToUse);
      const mimeType = getMimeType(pathToUse);
      const tempDoc = mupdfLib.Document.openDocument(data, mimeType);

      // Separate image and text regions
      const imageRegions = redactRegions ? redactRegions.filter(r => r.isImage) : [];
      const textRegions = redactRegions ? redactRegions.filter(r => !r.isImage) : [];

      // Only use mupdf redaction for TEXT regions (not images)
      // For images, we'll paint over them with background color after rendering
      // This preserves the exact original text positioning
      if (textRegions.length > 0) {
        const pdfDoc = tempDoc.asPDF();
        if (pdfDoc) {
          const pdfPage = pdfDoc.loadPage(pageNum) as any;

          for (const region of textRegions) {
            const rect: [number, number, number, number] = [
              region.x,
              region.y,
              region.x + region.width,
              region.y + region.height,
            ];
            const annot = pdfPage.createAnnotation('Redact');
            annot.setRect(rect);
          }
          // Apply with: no black boxes, redact images, line art, AND text
          pdfPage.applyRedactions(false, 2, 2, 0);
        }
      }

      // Render the page (with text redactions applied if any)
      const renderPage = tempDoc.loadPage(pageNum);
      const matrix = mupdfLib.Matrix.scale(scale, scale);
      const pixmap = renderPage.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

      // Now paint over deleted images AND fill regions with background color
      // This preserves exact text positioning while removing unwanted images
      const hasImageOrFillRegions = imageRegions.length > 0 || (fillRegions && fillRegions.length > 0);
      if (hasImageOrFillRegions) {
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();
        const n = pixmap.getNumberOfComponents();
        const samples = pixmap.getPixels();

        // Sample background color from page margins (works for yellowed/scanned pages)
        const bgColor = this.sampleBackgroundColor(samples, width, height, n);

        // Paint over deleted images with background color
        for (const region of imageRegions) {
          this.fillRectInPixels(samples, width, height, n, {
            x: region.x * scale,
            y: region.y * scale,
            w: region.width * scale,
            h: region.height * scale
          }, bgColor);
        }

        // Fill regions for moved blocks
        if (fillRegions) {
          for (const region of fillRegions) {
            this.fillRectInPixels(samples, width, height, n, {
              x: region.x * scale,
              y: region.y * scale,
              w: region.width * scale,
              h: region.height * scale
            }, bgColor);
          }
        }
      }

      // Apply background removal if requested (turns yellowed paper to white)
      if (removeBackground) {
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();
        const n = pixmap.getNumberOfComponents();
        const samples = pixmap.getPixels();
        this.applyBackgroundRemoval(samples, width, height, n);
      }

      const pngData = pixmap.asPNG();
      // Destroy temp document to free WebAssembly memory
      try { tempDoc.destroy(); } catch { /* ignore */ }
      return Buffer.from(pngData).toString('base64');
    }

    // No redactions - check if we have fill regions or background removal
    const hasFillRegions = fillRegions && fillRegions.length > 0;

    if (hasFillRegions) {
      // Need to load document for fill operations
      const pathToUse = pdfPath || this.pdfPath;
      if (!pathToUse) {
        throw new Error('No PDF path available');
      }

      const data = fs.readFileSync(pathToUse);
      const mimeType = getMimeType(pathToUse);
      const tempDoc = mupdfLib.Document.openDocument(data, mimeType);
      const renderPage = tempDoc.loadPage(pageNum);
      const matrix = mupdfLib.Matrix.scale(scale, scale);
      const pixmap = renderPage.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const n = pixmap.getNumberOfComponents();
      const samples = pixmap.getPixels();

      // Sample background color from page margins
      const bgColor = this.sampleBackgroundColor(samples, width, height, n);

      // Fill each region with background color (scaled to render coordinates)
      for (const region of fillRegions) {
        this.fillRectInPixels(samples, width, height, n, {
          x: region.x * scale,
          y: region.y * scale,
          w: region.width * scale,
          h: region.height * scale
        }, bgColor);
      }

      // Apply background removal if requested (turns yellowed paper to white)
      if (removeBackground) {
        this.applyBackgroundRemoval(samples, width, height, n);
      }

      const pngData = pixmap.asPNG();
      // Destroy temp document to free WebAssembly memory
      try { tempDoc.destroy(); } catch { /* ignore */ }
      return Buffer.from(pngData).toString('base64');
    }

    // No redactions or fills - render from cached document
    if (!this.doc) {
      throw new Error('No document loaded');
    }

    const page = this.doc.loadPage(pageNum);
    const matrix = mupdfLib.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

    // Apply background removal if requested (turns yellowed paper to white)
    if (removeBackground) {
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const n = pixmap.getNumberOfComponents();
      const samples = pixmap.getPixels();
      this.applyBackgroundRemoval(samples, width, height, n);
    }

    const pngData = pixmap.asPNG();

    return Buffer.from(pngData).toString('base64');
  }

  /**
   * Render a blank white page at the correct dimensions
   * Used when "remove background images" is enabled - text will be shown via overlays
   */
  async renderBlankPage(pageNum: number, scale: number = 2.0): Promise<string> {
    // Now delegates to renderPageWithoutBackground for actual background removal
    return this.renderPageWithoutBackground(pageNum, scale);
  }

  /**
   * Render a page with background removed (yellowed paper becomes white)
   * Keeps dark content (text, images) while removing light background colors
   */
  async renderPageWithoutBackground(pageNum: number, scale: number = 2.0): Promise<string> {
    const mupdfLib = await getMupdf();

    if (!this.doc) {
      throw new Error('No document loaded');
    }

    // Render the page normally first
    const page = this.doc.loadPage(pageNum);
    const matrix = mupdfLib.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

    // Get pixel data
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const n = pixmap.getNumberOfComponents(); // Should be 3 for RGB or 4 for RGBA
    const samples = pixmap.getPixels();

    // First pass: analyze image to find background color
    // Sample pixels from corners and edges (likely to be background)
    const bgSamples: { r: number; g: number; b: number }[] = [];
    const samplePositions = [
      // Corners
      { x: 10, y: 10 },
      { x: width - 10, y: 10 },
      { x: 10, y: height - 10 },
      { x: width - 10, y: height - 10 },
      // Edge midpoints
      { x: width / 2, y: 10 },
      { x: width / 2, y: height - 10 },
      { x: 10, y: height / 2 },
      { x: width - 10, y: height / 2 },
    ];

    for (const pos of samplePositions) {
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = (y * width + x) * n;
        const r = samples[idx];
        const g = samples[idx + 1];
        const b = samples[idx + 2];
        // Only consider light pixels as potential background
        if (r > 180 && g > 180 && b > 150) {
          bgSamples.push({ r, g, b });
        }
      }
    }

    // Calculate average background color (or default to light gray if no samples)
    let bgR = 245, bgG = 240, bgB = 220; // Default yellowish paper
    if (bgSamples.length > 0) {
      bgR = Math.round(bgSamples.reduce((s, p) => s + p.r, 0) / bgSamples.length);
      bgG = Math.round(bgSamples.reduce((s, p) => s + p.g, 0) / bgSamples.length);
      bgB = Math.round(bgSamples.reduce((s, p) => s + p.b, 0) / bgSamples.length);
    }

    // Second pass: replace background-like pixels with white
    // A pixel is considered "background" if it's close to the detected background color
    // and has high luminance (is light colored)
    const tolerance = 60; // Color distance tolerance
    const luminanceThreshold = 180; // Minimum luminance to be considered background

    for (let i = 0; i < samples.length; i += n) {
      const r = samples[i];
      const g = samples[i + 1];
      const b = samples[i + 2];

      // Calculate luminance (perceived brightness)
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

      // Calculate color distance from detected background
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);

      // If pixel is light AND close to background color, make it white
      if (luminance > luminanceThreshold && colorDist < tolerance) {
        samples[i] = 255;     // R
        samples[i + 1] = 255; // G
        samples[i + 2] = 255; // B
        // Keep alpha if present (samples[i + 3])
      }
      // Also make very light pixels white (near-white areas)
      else if (r > 240 && g > 235 && b > 220) {
        samples[i] = 255;
        samples[i + 1] = 255;
        samples[i + 2] = 255;
      }
    }

    // The samples array is a view into the pixmap's data, so changes are reflected
    // Now convert to PNG
    const pngData = pixmap.asPNG();
    return Buffer.from(pngData).toString('base64');
  }

  /**
   * Export text from enabled categories
   */
  exportText(enabledCategories: string[]): ExportTextResult {
    const enabledSet = new Set(enabledCategories);

    // Sort blocks by page, then y, then x
    const sortedBlocks = [...this.blocks].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });

    const lines: string[] = [];
    let currentPage = -1;

    for (const block of sortedBlocks) {
      if (!enabledSet.has(block.category_id)) continue;

      if (block.page !== currentPage) {
        if (currentPage >= 0) lines.push('');
        currentPage = block.page;
      }

      lines.push(block.text);
    }

    const text = lines.join('\n');
    return { text, char_count: text.length };
  }

  /**
   * Find blocks similar to a given block
   */
  findSimilar(blockId: string): { similar_ids: string[]; count: number } {
    const target = this.blocks.find(b => b.id === blockId);
    if (!target) return { similar_ids: [], count: 0 };

    const similar = this.blocks
      .filter(b => b.category_id === target.category_id)
      .map(b => b.id);

    return { similar_ids: similar, count: similar.length };
  }

  /**
   * Initialize PDF bridge for redaction operations
   * Call this once at startup
   */
  async initializePdfBridge(): Promise<void> {
    // Use mupdf.js exclusively - no fallbacks (fallbacks hide bugs)
    pdfBridgeManager.register(new MupdfJsBridge());

    await pdfBridgeManager.initialize();
  }

  // Simplified chapter type for bookmarks (only fields needed for export)
  async exportPdf(
    pdfPath: string,
    deletedRegions: DeletedRegion[],
    ocrBlocks?: OcrTextBlock[],
    deletedPages?: Set<number>,
    chapters?: Array<{title: string; page: number; level: number}>
  ): Promise<string> {
    console.log(`[exportPdf] Received ${deletedRegions.length} deleted regions, ${ocrBlocks?.length || 0} OCR blocks`);
    if (ocrBlocks && ocrBlocks.length > 0) {
      console.log(`[exportPdf] First OCR block: page ${ocrBlocks[0].page}, text: "${ocrBlocks[0].text.substring(0, 50)}..."`);
    } else {
      console.log(`[exportPdf] NO OCR blocks received from Angular!`);
    }
    // Use PDF bridge for redaction (prefers mupdf.js, falls back to PyMuPDF)

    // Initialize bridge if not already done
    if (!pdfBridgeManager.isInitialized()) {
      await this.initializePdfBridge();
    }

    // Convert regions to bridge format
    const regions: RedactionRegion[] = deletedRegions.map(r => ({
      page: r.page,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      isImage: r.isImage || false
    }));

    // Convert chapters to bookmarks with remapped page numbers
    let bookmarks: Bookmark[] = [];
    if (chapters && chapters.length > 0 && deletedPages && deletedPages.size > 0) {
      // Create page mapping: original page -> new page number (after deletions)
      const pageMapping = new Map<number, number>();
      let newPageNum = 0;
      // Estimate max page from regions and chapters
      const maxPage = Math.max(
        ...regions.map(r => r.page),
        ...chapters.map(c => c.page),
        ...(deletedPages ? Array.from(deletedPages) : [])
      ) + 1;

      for (let origPage = 0; origPage < maxPage + 100; origPage++) {
        if (!deletedPages.has(origPage)) {
          pageMapping.set(origPage, newPageNum);
          newPageNum++;
        }
      }

      // Filter chapters on deleted pages and remap page numbers
      bookmarks = chapters
        .filter(c => !deletedPages.has(c.page))
        .map(c => ({
          title: c.title,
          page: pageMapping.get(c.page) ?? c.page,
          level: c.level || 1
        }));
    } else if (chapters && chapters.length > 0) {
      // No deleted pages, use chapters as-is
      bookmarks = chapters.map(c => ({
        title: c.title,
        page: c.page,
        level: c.level || 1
      }));
    }

    // Use /tmp on macOS instead of os.tmpdir() which returns /var/folders/...
    const tmpDir = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
    const outputPath = path.join(tmpDir, `bookforge-output-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);

    try {
      // Log region breakdown
      const imageRegions = regions.filter(r => r.isImage);
      const textRegions = regions.filter(r => !r.isImage);
      console.log(`[exportPdf] Total regions: ${regions.length}, Image regions: ${imageRegions.length}, Text regions: ${textRegions.length}`);

      // Use overlay method to remove content by painting over it
      // This avoids MuPDF's redaction API which corrupts fonts and text positioning
      if (regions.length > 0) {
        console.log(`[exportPdf] Using removeWithOverlay for ${regions.length} regions (avoids font corruption)`);
        await pdfBridgeManager.getBridge().removeWithOverlay(
          pdfPath,
          outputPath,
          regions,
          {
            deletedPages: deletedPages ? Array.from(deletedPages) : [],
            bookmarks: bookmarks
          }
        );
      } else {
        // No regions to remove, just handle deleted pages and bookmarks
        console.log(`[exportPdf] No regions to remove, just handling page deletions/bookmarks`);
        await pdfBridgeManager.getBridge().redact(
          pdfPath,
          outputPath,
          [],
          {
            deletedPages: deletedPages ? Array.from(deletedPages) : [],
            bookmarks: bookmarks
          }
        );
      }

      // Read the output PDF
      const outputData = await fsPromises.readFile(outputPath);
      console.log(`[exportPdf] After redaction, PDF size: ${outputData.length} bytes`);

      // If we have OCR blocks to embed, do that with mupdf.js
      // (Bridge handled redaction and bookmarks, mupdf.js can handle text addition)
      if (ocrBlocks && ocrBlocks.length > 0) {
        console.log(`[exportPdf] Embedding ${ocrBlocks.length} OCR blocks into PDF`);
        for (const block of ocrBlocks.slice(0, 3)) {
          console.log(`[exportPdf]   OCR block page ${block.page}: "${block.text.substring(0, 50)}..."`);
        }
        const finalData = await this.embedOcrText(outputData, ocrBlocks, deletedPages);
        console.log(`[exportPdf] Final PDF base64 length: ${finalData.length}`);
        return finalData;
      }

      console.log(`[exportPdf] No OCR blocks to embed, returning redacted PDF`);
      // Return base64 encoded PDF
      return outputData.toString('base64');

    } finally {
      // Clean up temp file
      try {
        await fsPromises.unlink(outputPath);
      } catch (e) { /* ignore */ }
    }
  }

  /**
   * Embed OCR text blocks into a PDF using mupdf.js
   * Called after PyMuPDF redaction to add back OCR text for scanned pages
   */
  private async embedOcrText(
    pdfData: Buffer,
    ocrBlocks: OcrTextBlock[],
    deletedPages?: Set<number>
  ): Promise<string> {
    console.log(`[embedOcrText] Starting with ${ocrBlocks.length} OCR blocks, PDF size: ${pdfData.length} bytes`);
    const mupdfLib = await getMupdf();
    const doc = mupdfLib.Document.openDocument(pdfData, 'application/pdf');
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      console.error(`[embedOcrText] Failed to open PDF document`);
      return pdfData.toString('base64');
    }
    console.log(`[embedOcrText] Opened PDF, ${pdfDoc.countPages()} pages`);

    const totalPages = pdfDoc.countPages();

    // Create page mapping (after deletions)
    const pageMapping = new Map<number, number>();
    let newPageNum = 0;
    // We need to know the original page count before deletions
    // Since PyMuPDF already deleted pages, we work with the current document
    // The ocrBlocks have original page numbers, but PyMuPDF has already remapped them
    // So we need to recalculate based on deleted pages

    // Build mapping from original page -> new page
    let origPageCount = totalPages + (deletedPages?.size || 0);
    for (let origPage = 0; origPage < origPageCount; origPage++) {
      if (!deletedPages?.has(origPage)) {
        pageMapping.set(origPage, newPageNum);
        newPageNum++;
      }
    }

    // Group OCR blocks by mapped page number
    const ocrByPage = new Map<number, OcrTextBlock[]>();
    for (const block of ocrBlocks) {
      if (deletedPages?.has(block.page)) continue;

      const mappedPage = pageMapping.get(block.page);
      if (mappedPage === undefined || mappedPage >= totalPages) continue;

      if (!ocrByPage.has(mappedPage)) {
        ocrByPage.set(mappedPage, []);
      }
      ocrByPage.get(mappedPage)!.push(block);
    }

    if (ocrByPage.size === 0) {
      return pdfData.toString('base64');
    }

    // Create font dictionary for Helvetica
    const fontDict = pdfDoc.addObject({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: 'WinAnsiEncoding'
    });

    for (const [pageNum, pageOcrBlocks] of ocrByPage) {
      if (pageOcrBlocks.length === 0) continue;

      const page = pdfDoc.loadPage(pageNum) as any;
      const bounds = page.getBounds();
      const pageHeight = bounds[3] - bounds[1];

      // Build text content stream
      let textContent = 'BT\n';

      for (const block of pageOcrBlocks) {
        const escapedText = block.text
          .replace(/\\/g, '\\\\')
          .replace(/\(/g, '\\(')
          .replace(/\)/g, '\\)');

        const fontSize = Math.max(8, Math.min(block.font_size || 12, 24));
        const x = block.x;
        const y = pageHeight - block.y - block.height;

        textContent += `/F1 ${fontSize} Tf\n`;
        textContent += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n`;
        textContent += `(${escapedText}) Tj\n`;
      }

      textContent += 'ET\n';

      // Add font to page resources
      const pageObj = pdfDoc.findPage(pageNum);
      const resources = pageObj.get('Resources');

      let fonts = resources.get('Font');
      if (!fonts || fonts.isNull()) {
        fonts = pdfDoc.addObject({});
        resources.put('Font', fonts);
      }
      fonts.put('F1', fontDict);

      // Create and append content stream
      const textStream = pdfDoc.addStream(textContent, {});
      const existingContents = pageObj.get('Contents');

      if (existingContents && !existingContents.isNull()) {
        if (existingContents.isArray()) {
          existingContents.push(textStream);
        } else {
          const newContents = pdfDoc.addObject([existingContents, textStream]);
          pageObj.put('Contents', newContents);
        }
      } else {
        pageObj.put('Contents', textStream);
      }
    }

    const buffer = pdfDoc.saveToBuffer('garbage,compress');
    const result = Buffer.from(buffer.asUint8Array());
    console.log(`[embedOcrText] Final PDF size: ${result.length} bytes`);
    return result.toString('base64');
  }

  /**
   * Export a PDF with backgrounds removed (yellowed paper -> white)
   * Creates a new PDF from processed page images
   * Optionally applies redactions for deleted content before rendering
   * Optionally embeds OCR text blocks as real PDF text (survives image deletion)
   */
  async exportPdfWithBackgroundsRemoved(
    scale: number = 2.0,
    progressCallback?: (current: number, total: number) => void,
    deletedRegions?: DeletedRegion[],
    ocrBlocks?: OcrTextBlock[],
    deletedPages?: Set<number>
  ): Promise<string> {
    const mupdfLib = await getMupdf();

    if (!this.doc) {
      throw new Error('No document loaded');
    }

    const totalPages = this.doc.countPages();

    // Calculate how many pages will be in the output (for progress reporting)
    const outputPageCount = deletedPages ? totalPages - deletedPages.size : totalPages;

    // Group deleted regions by page for efficient lookup (using original page numbers)
    const regionsByPage = new Map<number, DeletedRegion[]>();
    if (deletedRegions && deletedRegions.length > 0) {
      for (const region of deletedRegions) {
        // Skip regions on deleted pages
        if (deletedPages?.has(region.page)) continue;

        if (!regionsByPage.has(region.page)) {
          regionsByPage.set(region.page, []);
        }
        regionsByPage.get(region.page)!.push(region);
      }
    }

    // Group OCR blocks by page (using original page numbers)
    const ocrByPage = new Map<number, OcrTextBlock[]>();
    if (ocrBlocks && ocrBlocks.length > 0) {
      for (const block of ocrBlocks) {
        // Skip OCR blocks on deleted pages
        if (deletedPages?.has(block.page)) continue;

        if (!ocrByPage.has(block.page)) {
          ocrByPage.set(block.page, []);
        }
        ocrByPage.get(block.page)!.push(block);
      }
    }

    // Create a new PDF document
    const outputDoc = new mupdfLib.PDFDocument() as any;

    // Process each page (skipping deleted pages)
    let outputPageNum = 0;
    for (let pageNum = 0; pageNum < totalPages; pageNum++) {
      // Skip deleted pages
      if (deletedPages?.has(pageNum)) {
        continue;
      }

      // Report progress
      if (progressCallback) {
        progressCallback(outputPageNum, outputPageCount);
      }
      outputPageNum++;

      // Check if this page has deleted regions
      const pageRegions = regionsByPage.get(pageNum) || [];
      let pixmap;

      if (pageRegions.length > 0 && this.pdfPath) {
        // Separate image and text regions
        const imageRegions = pageRegions.filter(r => r.isImage);
        const textRegions = pageRegions.filter(r => !r.isImage);

        // Render the page first
        const page = this.doc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(scale, scale);
        pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

        // Manually paint white over ALL redaction regions (both image and text)
        // This bypasses mupdf's unreliable redaction and works at the pixel level
        const allRegions = [...imageRegions, ...textRegions];
        if (allRegions.length > 0) {
          const width = pixmap.getWidth();
          const height = pixmap.getHeight();
          const n = pixmap.getNumberOfComponents();
          const samples = pixmap.getPixels();

          for (const region of allRegions) {
            // Scale coordinates to match rendered resolution
            const x1 = Math.floor(region.x * scale);
            const y1 = Math.floor(region.y * scale);
            const x2 = Math.ceil((region.x + region.width) * scale);
            const y2 = Math.ceil((region.y + region.height) * scale);

            // Paint white pixels in the region
            for (let y = Math.max(0, y1); y < Math.min(height, y2); y++) {
              for (let x = Math.max(0, x1); x < Math.min(width, x2); x++) {
                const idx = (y * width + x) * n;
                samples[idx] = 255;     // R
                samples[idx + 1] = 255; // G
                samples[idx + 2] = 255; // B
                if (n > 3) samples[idx + 3] = 255; // A if present
              }
            }
          }
        }
      } else {
        // Render page normally (no redactions needed)
        const page = this.doc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(scale, scale);
        pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);
      }

      // Get pixel data and process to remove background
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const n = pixmap.getNumberOfComponents();
      const samples = pixmap.getPixels();

      // Sample corners/edges to detect background color
      const bgSamples: { r: number; g: number; b: number }[] = [];
      const samplePositions = [
        { x: 10, y: 10 },
        { x: width - 10, y: 10 },
        { x: 10, y: height - 10 },
        { x: width - 10, y: height - 10 },
        { x: width / 2, y: 10 },
        { x: width / 2, y: height - 10 },
        { x: 10, y: height / 2 },
        { x: width - 10, y: height / 2 },
      ];

      for (const pos of samplePositions) {
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        if (x >= 0 && x < width && y >= 0 && y < height) {
          const idx = (y * width + x) * n;
          const r = samples[idx];
          const g = samples[idx + 1];
          const b = samples[idx + 2];
          if (r > 180 && g > 180 && b > 150) {
            bgSamples.push({ r, g, b });
          }
        }
      }

      let bgR = 245, bgG = 240, bgB = 220;
      if (bgSamples.length > 0) {
        bgR = Math.round(bgSamples.reduce((s, p) => s + p.r, 0) / bgSamples.length);
        bgG = Math.round(bgSamples.reduce((s, p) => s + p.g, 0) / bgSamples.length);
        bgB = Math.round(bgSamples.reduce((s, p) => s + p.b, 0) / bgSamples.length);
      }

      const tolerance = 60;
      const luminanceThreshold = 180;

      for (let i = 0; i < samples.length; i += n) {
        const r = samples[i];
        const g = samples[i + 1];
        const b = samples[i + 2];

        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        const dr = r - bgR;
        const dg = g - bgG;
        const db = b - bgB;
        const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);

        if (luminance > luminanceThreshold && colorDist < tolerance) {
          samples[i] = 255;
          samples[i + 1] = 255;
          samples[i + 2] = 255;
        } else if (r > 240 && g > 235 && b > 220) {
          samples[i] = 255;
          samples[i + 1] = 255;
          samples[i + 2] = 255;
        }
      }

      // Create image directly from the processed pixmap
      const image = new mupdfLib.Image(pixmap, undefined);

      // Get original page dimensions (in points)
      const dims = this.pageDimensions[pageNum];
      const pageWidth = dims?.width || 612;
      const pageHeight = dims?.height || 792;

      // Create page with mediabox
      const mediaBox: [number, number, number, number] = [0, 0, pageWidth, pageHeight];

      // Start with image content
      let content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Img Do Q`;

      // Check if page has deleted images and OCR text to overlay
      // Note: pageRegions already declared above in this loop iteration
      const hasDeletedImages = pageRegions.some(r => r.isImage);
      const pageOcrBlocks = ocrByPage.get(pageNum) || [];

      // Add OCR text overlay if we have OCR blocks on pages where images were deleted
      // This ensures OCR'd text survives image deletion
      let needsFont = false;
      if (pageOcrBlocks.length > 0 && hasDeletedImages) {
        needsFont = true;
        let textContent = '\nBT\n';  // Begin text

        for (const block of pageOcrBlocks) {
          // Escape special characters in PDF string
          const escapedText = block.text
            .replace(/\\/g, '\\\\')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)');

          // Calculate position (PDF coordinates: origin at bottom-left, y increases upward)
          // OCR coordinates: origin at top-left, y increases downward
          const fontSize = Math.max(8, Math.min(block.font_size || 12, 24));
          const x = block.x;
          const y = pageHeight - block.y - block.height;  // Flip y-axis

          // Add text positioning and drawing
          textContent += `/F1 ${fontSize} Tf\n`;
          textContent += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n`;
          textContent += `(${escapedText}) Tj\n`;
        }

        textContent += 'ET\n';  // End text
        content += textContent;
      }

      // Add image reference and resources
      const imgRef = outputDoc.addImage(image);

      // Build resources object
      const resourcesObj: Record<string, unknown> = {
        XObject: { Img: imgRef }
      };

      // Add font if needed for OCR text
      if (needsFont) {
        // Create a standard Helvetica font reference
        const fontDict = outputDoc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding'
        });
        resourcesObj.Font = { F1: fontDict };
      }

      const resources = outputDoc.addObject(resourcesObj);

      // Create and insert page (addPage expects raw content buffer, not stream object)
      const pageObj = outputDoc.addPage(mediaBox, 0, resources, content);
      outputDoc.insertPage(-1, pageObj);
    }

    // Final progress update
    if (progressCallback) {
      progressCallback(totalPages, totalPages);
    }

    // Save to buffer
    const buffer = outputDoc.saveToBuffer('compress');
    const base64 = Buffer.from(buffer.asUint8Array()).toString('base64');

    return base64;
  }

  /**
   * Export PDF with WYSIWYG rendering - exactly what the viewer shows
   *
   * UNIFIED APPROACH: Every page goes through the renderer. No exceptions.
   *
   * For each page:
   * 1. Render to pixmap (same as viewer's renderPage)
   * 2. Apply deletions by painting regions white
   * 3. For pages with deleted background images, create white canvas and render OCR text as image
   * 4. Add rendered image to output PDF
   *
   * This guarantees visual fidelity because export uses the exact same rendering as the viewer.
   */
  async exportPdfWysiwyg(
    deletedRegions?: DeletedRegion[],
    deletedPages?: Set<number>,
    scale: number = 2.0,
    progressCallback?: (current: number, total: number) => void,
    ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>
  ): Promise<string> {
    const mupdfLib = await getMupdf();

    if (!this.doc) {
      throw new Error('No document loaded');
    }

    // Build set of pages that have deleted backgrounds (will render white + OCR text)
    const ocrPageSet = new Set<number>();
    const ocrPageBlocks = new Map<number, Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>>();
    if (ocrPages) {
      for (const pageData of ocrPages) {
        ocrPageSet.add(pageData.page);
        ocrPageBlocks.set(pageData.page, pageData.blocks);
      }
    }

    console.log(`[exportPdfWysiwyg] UNIFIED EXPORT: ${deletedRegions?.length || 0} deleted regions, ${deletedPages?.size || 0} deleted pages, ${ocrPageSet.size} pages with deleted backgrounds`);

    const totalPages = this.doc.countPages();
    const outputPageCount = deletedPages ? totalPages - deletedPages.size : totalPages;

    // Group deleted regions by page
    const regionsByPage = new Map<number, DeletedRegion[]>();
    if (deletedRegions && deletedRegions.length > 0) {
      for (const region of deletedRegions) {
        if (deletedPages?.has(region.page)) continue;
        if (!regionsByPage.has(region.page)) {
          regionsByPage.set(region.page, []);
        }
        regionsByPage.get(region.page)!.push(region);
      }
    }

    // Create output PDF
    const outputDoc = new mupdfLib.PDFDocument() as any;

    let processedPages = 0;
    for (let pageNum = 0; pageNum < totalPages; pageNum++) {
      if (deletedPages?.has(pageNum)) continue;

      if (progressCallback) {
        progressCallback(processedPages, outputPageCount);
      }

      const dims = this.pageDimensions[pageNum];
      const pageWidth = dims?.width || 612;
      const pageHeight = dims?.height || 792;
      const pixelWidth = Math.round(pageWidth * scale);
      const pixelHeight = Math.round(pageHeight * scale);

      let pixmap: any;

      // ========================================
      // UNIFIED PATH: Always render to pixmap
      // ========================================

      if (ocrPageSet.has(pageNum)) {
        // Page has deleted background - render white page with OCR text AS AN IMAGE
        console.log(`[exportPdfWysiwyg] Page ${pageNum}: Rendering white + OCR text as image`);

        const ocrBlocks = ocrPageBlocks.get(pageNum) || [];

        // Create a temporary PDF with white background + text, then render it
        const tempDoc = new mupdfLib.PDFDocument() as any;
        const mediaBox: [number, number, number, number] = [0, 0, pageWidth, pageHeight];

        if (ocrBlocks.length > 0) {
          // Build content stream with text
          let content = 'BT\n';

          for (const block of ocrBlocks) {
            // PDF y-coordinate (y=0 at bottom)
            const pdfY = pageHeight - block.y - block.height;
            const fontSize = Math.max(6, Math.min(72, block.font_size || 12));

            // Escape text for PDF
            const escapedText = block.text
              .replace(/\\/g, '\\\\')
              .replace(/\(/g, '\\(')
              .replace(/\)/g, '\\)')
              .replace(/\n/g, ' ');

            content += `/F1 ${fontSize} Tf\n`;
            content += `1 0 0 1 ${block.x.toFixed(2)} ${pdfY.toFixed(2)} Tm\n`;
            content += `(${escapedText}) Tj\n`;
          }

          content += 'ET\n';

          // Add Helvetica font
          const fontDict = tempDoc.addObject({
            Type: 'Font',
            Subtype: 'Type1',
            BaseFont: 'Helvetica',
            Encoding: 'WinAnsiEncoding'
          });
          const resources = tempDoc.addObject({ Font: { F1: fontDict } });
          const pageObj = tempDoc.addPage(mediaBox, 0, resources, content);
          tempDoc.insertPage(-1, pageObj);
        } else {
          // Blank white page
          const pageObj = tempDoc.addPage(mediaBox, 0, null, '');
          tempDoc.insertPage(-1, pageObj);
        }

        // RENDER the temp document to pixmap - this is the key!
        const tempPage = tempDoc.loadPage(0);
        const matrix = mupdfLib.Matrix.scale(scale, scale);
        pixmap = tempPage.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

        console.log(`[exportPdfWysiwyg] Page ${pageNum}: Rendered OCR page to ${pixmap.getWidth()}x${pixmap.getHeight()} pixmap`);

      } else {
        // Normal page - render from source document
        const page = this.doc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(scale, scale);
        pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

        // Apply deletions by painting regions
        const pageRegions = regionsByPage.get(pageNum) || [];
        if (pageRegions.length > 0) {
          const width = pixmap.getWidth();
          const height = pixmap.getHeight();
          const n = pixmap.getNumberOfComponents();
          const samples = pixmap.getPixels();

          console.log(`[exportPdfWysiwyg] Page ${pageNum}: Painting ${pageRegions.length} deleted regions`);

          for (const region of pageRegions) {
            // Flip Y-axis (PDF y=0 at bottom, pixmap y=0 at top)
            const flippedY = pageHeight - region.y - region.height;

            const x1 = Math.floor(region.x * scale);
            const y1 = Math.floor(flippedY * scale);
            const x2 = Math.ceil((region.x + region.width) * scale);
            const y2 = Math.ceil((flippedY + region.height) * scale);

            // Skip suspicious large regions
            const regionArea = (x2 - x1) * (y2 - y1);
            if (regionArea > width * height * 0.5) {
              console.warn(`[exportPdfWysiwyg] Skipping suspicious large region on page ${pageNum}`);
              continue;
            }

            // Sample background color
            const bgColor = this.sampleBackgroundColorAroundRegion(samples, width, height, n, x1, y1, x2, y2);

            // Paint the region
            for (let y = Math.max(0, y1); y < Math.min(height, y2); y++) {
              for (let x = Math.max(0, x1); x < Math.min(width, x2); x++) {
                const idx = (y * width + x) * n;
                samples[idx] = bgColor.r;
                samples[idx + 1] = bgColor.g;
                samples[idx + 2] = bgColor.b;
                if (n > 3) samples[idx + 3] = 255;
              }
            }
          }
        }
      }

      // ========================================
      // UNIFIED OUTPUT: Always add as image
      // ========================================

      const image = new mupdfLib.Image(pixmap, undefined);
      const outputMediaBox: [number, number, number, number] = [0, 0, pageWidth, pageHeight];
      const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Img Do Q`;

      const imgRef = outputDoc.addImage(image);
      const resources = outputDoc.addObject({ XObject: { Img: imgRef } });
      const pageObj = outputDoc.addPage(outputMediaBox, 0, resources, content);
      outputDoc.insertPage(-1, pageObj);

      processedPages++;
    }

    if (progressCallback) {
      progressCallback(outputPageCount, outputPageCount);
    }

    const buffer = outputDoc.saveToBuffer('compress');
    const base64 = Buffer.from(buffer.asUint8Array()).toString('base64');
    console.log(`[exportPdfWysiwyg] Exported ${processedPages} pages, ${buffer.asUint8Array().length} bytes`);
    return base64;
  }

  /**
   * Close the document and free WebAssembly memory
   */
  close(): void {
    // IMPORTANT: Must call destroy() to free WebAssembly memory
    if (this.doc) {
      try {
        this.doc.destroy();
        console.log('[PDF Analyzer] Document destroyed, WebAssembly memory freed');
      } catch (err) {
        console.warn('[PDF Analyzer] Error destroying document:', err);
      }
    }
    this.doc = null;
    this.blocks = [];
    this.spans = [];
    this.categories = {};
    this.pageDimensions = [];
    this.pdfPath = '';
  }

  /**
   * Update spans for a page that has been OCR'd.
   * This replaces the original PDF-extracted spans with OCR-derived spans,
   * so custom category matching will search the OCR text with correct coordinates.
   *
   * @param pageNum - 0-indexed page number
   * @param ocrBlocks - OCR text blocks with coordinates from Tesseract
   */
  updateSpansForOcrPage(
    pageNum: number,
    ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>
  ): void {
    console.log(`[updateSpansForOcrPage] Updating spans for page ${pageNum} with ${ocrBlocks.length} OCR blocks`);

    // Remove existing spans for this page
    this.spans = this.spans.filter(s => s.page !== pageNum);

    // Convert OCR blocks to TextSpan format
    // Each OCR block becomes one span (we don't have word-level granularity from Tesseract blocks)
    const newSpans: TextSpan[] = ocrBlocks.map((block, idx) => ({
      id: block.id || `ocr_${pageNum}_${idx}`,
      page: pageNum,
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
      text: block.text,
      font_size: block.font_size,
      font_name: 'OCR-Tesseract',  // Placeholder font name for OCR text
      is_bold: false,
      is_italic: false,
      baseline_offset: 0,
      block_id: block.id || `ocr_block_${pageNum}_${idx}`
    }));

    // Add new OCR spans
    this.spans.push(...newSpans);

    console.log(`[updateSpansForOcrPage] Page ${pageNum} now has ${newSpans.length} OCR spans, total spans: ${this.spans.length}`);
  }

  /**
   * Assemble PDF from canvas-rendered images (WYSIWYG export)
   *
   * This takes screenshots from the viewer canvas and assembles them into a PDF.
   * Guarantees exact match with what the viewer shows.
   *
   * @param pages - Array of { pageNum, imageData (data URL), width, height }
   * @param chapters - Optional chapter bookmarks to add
   * @returns Base64-encoded PDF
   */
  async assembleFromImages(
    pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>,
    chapters?: Chapter[]
  ): Promise<string> {
    const mupdfLib = await getMupdf();

    console.log(`[assembleFromImages] Creating PDF from ${pages.length} canvas images`);

    // Create output PDF
    const outputDoc = new mupdfLib.PDFDocument() as any;

    for (const page of pages) {
      // Extract base64 from data URL
      const base64Match = page.imageData.match(/^data:image\/\w+;base64,(.+)$/);
      if (!base64Match) {
        console.error(`[assembleFromImages] Invalid data URL for page ${page.pageNum}`);
        continue;
      }

      const base64Data = base64Match[1];
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Create image from PNG data
      const image = new mupdfLib.Image(imageBuffer);

      // Create page with the image
      const mediaBox: [number, number, number, number] = [0, 0, page.width, page.height];
      const content = `q ${page.width} 0 0 ${page.height} 0 0 cm /Img Do Q`;

      const imgRef = outputDoc.addImage(image);
      const resources = outputDoc.addObject({ XObject: { Img: imgRef } });
      const pageObj = outputDoc.addPage(mediaBox, 0, resources, content);
      outputDoc.insertPage(-1, pageObj);
    }

    // Save to buffer
    let buffer = outputDoc.saveToBuffer('compress');
    let base64 = Buffer.from(buffer.asUint8Array()).toString('base64');

    // Add bookmarks if chapters provided
    if (chapters && chapters.length > 0) {
      try {
        const pdfData = Buffer.from(base64, 'base64');
        const withBookmarks = await this.addBookmarksToPdf(pdfData, chapters);
        base64 = Buffer.from(withBookmarks).toString('base64');
        console.log(`[assembleFromImages] Added ${chapters.length} bookmarks`);
      } catch (err) {
        console.warn(`[assembleFromImages] Failed to add bookmarks:`, err);
      }
    }

    console.log(`[assembleFromImages] Created PDF with ${pages.length} pages`);
    return base64;
  }

  /**
   * Find blocks within or near a given rectangle on a page
   * Falls back to spans if available, otherwise uses blocks
   */
  findSpansInRect(page: number, x: number, y: number, width: number, height: number): TextSpan[] {
    // First try spans if we have them
    const pageSpans = this.spans.filter(s => s.page === page);

    if (pageSpans.length > 0) {
      return this.findSpansInRectFromSpans(page, x, y, width, height, pageSpans);
    }

    // Fall back to blocks - convert matching blocks to "pseudo-spans"
    const pageBlocks = this.blocks.filter(b => b.page === page);

    const centerX = x + width / 2;
    const centerY = y + height / 2;

    // Helper to check overlap with margin
    const findOverlapping = (margin: number) => {
      const rectLeft = x - margin;
      const rectTop = y - margin;
      const rectRight = x + width + margin;
      const rectBottom = y + height + margin;

      return pageBlocks.filter(block => {
        const blockRight = block.x + block.width;
        const blockBottom = block.y + block.height;
        return !(block.x > rectRight || blockRight < rectLeft || block.y > rectBottom || blockBottom < rectTop);
      });
    };

    // Try exact match, then with margins
    let matchingBlocks = findOverlapping(0);
    if (matchingBlocks.length === 0) {
      for (const margin of [10, 20, 40]) {
        matchingBlocks = findOverlapping(margin);
        if (matchingBlocks.length > 0) break;
      }
    }

    // If still nothing, find nearest block
    if (matchingBlocks.length === 0) {
      const nearest = pageBlocks
        .map(block => {
          const bx = block.x + block.width / 2;
          const by = block.y + block.height / 2;
          const dist = Math.sqrt(Math.pow(centerX - bx, 2) + Math.pow(centerY - by, 2));
          return { block, dist };
        })
        .sort((a, b) => a.dist - b.dist)[0];

      if (nearest && nearest.dist < 100) {
        matchingBlocks = [nearest.block];
      }
    }

    // Convert blocks to TextSpan format for compatibility
    return matchingBlocks.map(block => ({
      id: block.id,
      page: block.page,
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
      text: block.text,
      font_size: block.font_size,
      font_name: block.font_name,
      is_bold: block.is_bold,
      is_italic: block.is_italic,
      baseline_offset: 0,
      block_id: block.id,
    }));
  }

  private findSpansInRectFromSpans(page: number, x: number, y: number, width: number, height: number, pageSpans: TextSpan[]): TextSpan[] {
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    const findOverlapping = (margin: number): TextSpan[] => {
      const rectLeft = x - margin;
      const rectTop = y - margin;
      const rectRight = x + width + margin;
      const rectBottom = y + height + margin;

      return pageSpans.filter(span => {
        const spanRight = span.x + span.width;
        const spanBottom = span.y + span.height;
        return !(span.x > rectRight || spanRight < rectLeft || span.y > rectBottom || spanBottom < rectTop);
      });
    };

    let result = findOverlapping(0);
    if (result.length === 0) {
      for (const margin of [5, 10, 20, 30]) {
        result = findOverlapping(margin);
        if (result.length > 0) break;
      }
    }

    if (result.length === 0) {
      const closest = pageSpans
        .map(span => ({
          span,
          dist: Math.sqrt(Math.pow(centerX - (span.x + span.width/2), 2) + Math.pow(centerY - (span.y + span.height/2), 2))
        }))
        .sort((a, b) => a.dist - b.dist)[0];

      if (closest && closest.dist < 50) {
        result = [closest.span];
      }
    }

    // Group adjacent character spans into tokens (e.g., "1","3" -> "13")
    return this.groupAdjacentSpans(result);
  }

  /**
   * Group adjacent character spans into token spans.
   * This merges chars like "1", "3" into "13" when they're horizontally adjacent.
   */
  private groupAdjacentSpans(spans: TextSpan[]): TextSpan[] {
    if (spans.length <= 1) return spans;

    // Sort by page, then Y (line), then X (position in line)
    const sorted = [...spans].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      // Group by approximate Y (within 5px = same line)
      const yDiff = Math.abs(a.y - b.y);
      if (yDiff > 5) return a.y - b.y;
      return a.x - b.x;
    });

    const grouped: TextSpan[] = [];
    let current: TextSpan | null = null;

    for (const span of sorted) {
      if (!current) {
        // Start new group
        current = { ...span };
        continue;
      }

      // Check if this span is adjacent to current (same line, close horizontally)
      const sameLine = Math.abs(span.y - current.y) < 5;
      const sameFont = span.font_name === current.font_name &&
                       Math.abs(span.font_size - current.font_size) < 0.5;
      const adjacent = span.x <= current.x + current.width + 3; // 3px gap tolerance

      if (sameLine && sameFont && adjacent) {
        // Merge into current
        current.text += span.text;
        current.width = (span.x + span.width) - current.x;
        current.height = Math.max(current.height, span.height);
      } else {
        // Finish current group, start new one
        grouped.push(current);
        current = { ...span };
      }
    }

    if (current) {
      grouped.push(current);
    }

    return grouped;
  }

  /**
   * Analyze sample spans and learn a fingerprint from their properties.
   * Instead of hardcoding patterns, we detect what makes these samples unique.
   */
  analyzesamples(sampleSpans: TextSpan[]): SpanFingerprint | null {
    if (sampleSpans.length === 0) return null;

    // Filter samples to only include spans with similar properties.
    // When user draws boxes, they might accidentally catch body text too.
    // Use the most common font size to filter out accidentally-selected body text.
    const filteredSpans = this.filterSimilarSpans(sampleSpans);

    if (filteredSpans.length === 0) {
      return null;
    }

    const texts = filteredSpans.map(s => s.text.trim()).filter(t => t.length > 0);
    if (texts.length === 0) {
      return null;
    }

    const bodyFontSize = this.getBodyFontSize();
    const descriptions: string[] = [];

    // Analyze font sizes (using filtered spans)
    const fontSizes = filteredSpans.map(s => s.font_size);
    const minFontSize = Math.min(...fontSizes);
    const maxFontSize = Math.max(...fontSizes);
    const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;
    const fontSizeRange = maxFontSize - minFontSize;

    // Only filter by font size if samples are consistent (small range)
    const useFontSize = fontSizeRange < 2;
    const fontSizeRatioToBody = avgFontSize / bodyFontSize;

    if (useFontSize && fontSizeRatioToBody < 0.85) {
      descriptions.push(`smaller than body text (${(fontSizeRatioToBody * 100).toFixed(0)}%)`);
    } else if (useFontSize && fontSizeRatioToBody > 1.15) {
      descriptions.push(`larger than body text (${(fontSizeRatioToBody * 100).toFixed(0)}%)`);
    }

    // Analyze font names
    const fontNames = [...new Set(filteredSpans.map(s => s.font_name))];
    const useFontName = fontNames.length === 1;  // Only filter if all same font
    if (useFontName) {
      descriptions.push(`font: ${fontNames[0]}`);
    }

    // Analyze bold/italic
    const boldCount = filteredSpans.filter(s => s.is_bold).length;
    const italicCount = filteredSpans.filter(s => s.is_italic).length;
    const isBold = boldCount === filteredSpans.length ? true : boldCount === 0 ? false : null;
    const isItalic = italicCount === filteredSpans.length ? true : italicCount === 0 ? false : null;
    if (isBold === true) descriptions.push('bold');
    if (isItalic === true) descriptions.push('italic');

    // Analyze character class
    const charClass = this.detectCharClass(texts);
    if (charClass) {
      descriptions.push(`char class: ${charClass}`);
    }

    // Analyze text length
    const lengths = texts.map(t => t.length);
    const minLength = Math.min(...lengths);
    const maxLength = Math.max(...lengths);
    const lengthRange = maxLength - minLength;
    const useLength = lengthRange <= 2;  // Only filter if consistent length
    if (useLength) {
      descriptions.push(`length: ${minLength}-${maxLength}`);
    }

    // Analyze baseline offset (superscript/subscript detection)
    const baselineOffsets = filteredSpans.map(s => s.baseline_offset);
    const minBaseline = Math.min(...baselineOffsets);
    const maxBaseline = Math.max(...baselineOffsets);
    const baselineRange = maxBaseline - minBaseline;
    const useBaseline = baselineRange < 3;

    // Build the fingerprint
    const fingerprint: SpanFingerprint = {
      font_size_min: useFontSize ? minFontSize * 0.9 : null,
      font_size_max: useFontSize ? maxFontSize * 1.1 : null,
      font_size_ratio_to_body: useFontSize && fontSizeRatioToBody < 0.9
        ? [fontSizeRatioToBody * 0.9, fontSizeRatioToBody * 1.1]
        : null,
      font_names: useFontName ? fontNames : null,
      is_bold: isBold,
      is_italic: isItalic,
      char_class: charClass,
      length_min: useLength ? minLength : null,
      length_max: useLength ? maxLength : null,
      baseline_offset_min: useBaseline ? minBaseline - 1 : null,
      baseline_offset_max: useBaseline ? maxBaseline + 1 : null,
      preceded_by: null,  // TODO: context analysis
      followed_by: null,  // TODO: context analysis
      sample_count: filteredSpans.length,
      body_font_size: bodyFontSize,
      description: descriptions.length > 0 ? descriptions.join(', ') : 'matches sample properties'
    };

    return fingerprint;
  }

  /**
   * Detect the character class of sample texts
   */
  private detectCharClass(texts: string[]): CharClass | null {
    const allDigits = texts.every(t => /^\d+$/.test(t));
    const allUppercase = texts.every(t => /^[A-Z]+$/.test(t));
    const allLowercase = texts.every(t => /^[a-z]+$/.test(t));
    const allAlpha = texts.every(t => /^[A-Za-z]+$/.test(t));
    const allAlphanum = texts.every(t => /^[A-Za-z0-9]+$/.test(t));
    const allSymbols = texts.every(t => /^[^\w\s]+$/.test(t));

    if (allDigits) return 'digits';
    if (allUppercase) return 'uppercase';
    if (allLowercase) return 'lowercase';
    if (allAlpha) return 'mixed_alpha';
    if (allAlphanum) return 'mixed_alphanum';
    if (allSymbols) return 'symbols';

    // If no consistent class, don't filter by it
    return null;
  }

  /**
   * Filter sample spans to only include similar ones.
   * When user draws boxes, they might accidentally catch body text.
   * This finds the most common font size and filters to only those spans.
   */
  private filterSimilarSpans(spans: TextSpan[]): TextSpan[] {
    if (spans.length <= 1) return spans;

    // Group by rounded font size to find the most common size
    const sizeGroups = new Map<number, TextSpan[]>();
    for (const span of spans) {
      const roundedSize = Math.round(span.font_size * 2) / 2; // Round to 0.5
      if (!sizeGroups.has(roundedSize)) {
        sizeGroups.set(roundedSize, []);
      }
      sizeGroups.get(roundedSize)!.push(span);
    }

    // If all spans have similar size (within 1pt), keep them all
    const sizes = [...sizeGroups.keys()].sort((a, b) => a - b);
    if (sizes.length > 0 && sizes[sizes.length - 1] - sizes[0] <= 1) {
      return spans;
    }

    // Find the most common font size (by count of spans)
    let mostCommonSize = sizes[0];
    let maxCount = 0;
    for (const [size, group] of sizeGroups) {
      if (group.length > maxCount) {
        maxCount = group.length;
        mostCommonSize = size;
      }
    }

    // Filter to only spans within 1pt of the most common size
    const filtered = spans.filter(s => Math.abs(s.font_size - mostCommonSize) <= 1);

    return filtered.length > 0 ? filtered : spans;
  }

  /**
   * Get the most common body text font size
   */
  private getBodyFontSize(): number {
    const sizeChars = new Map<number, number>();
    for (const block of this.blocks) {
      if (block.region === 'body' && !block.is_bold && !block.is_image) {
        const roundedSize = Math.round(block.font_size);
        sizeChars.set(roundedSize, (sizeChars.get(roundedSize) || 0) + block.char_count);
      }
    }

    let bodySize = 10;
    let maxChars = 0;
    for (const [size, chars] of sizeChars) {
      if (chars > maxChars) {
        maxChars = chars;
        bodySize = size;
      }
    }
    return bodySize;
  }

  /**
   * Find all spans matching a learned fingerprint.
   * Uses property-based matching instead of regex patterns.
   */
  findMatchingSpans(fingerprint: SpanFingerprint): MatchingSpansResult {
    const matches: MatchRect[] = [];
    const matchesByPage: Record<number, MatchRect[]> = {};

    // Group character spans into tokens for matching
    const groupedSpans = this.groupAdjacentSpans(this.spans);

    for (const span of groupedSpans) {
      if (this.matchesFingerprint(span, fingerprint)) {
        const match: MatchRect = {
          page: span.page,
          x: span.x,
          y: span.y,
          w: span.width,
          h: span.height,
          text: span.text.trim()
        };

        matches.push(match);

        // Group by page for O(1) lookup during render
        if (!matchesByPage[span.page]) {
          matchesByPage[span.page] = [];
        }
        matchesByPage[span.page].push(match);
      }
    }

    return {
      matches,
      matchesByPage,
      total: matches.length,
      pattern: fingerprint.description
    };
  }

  /**
   * Find spans matching a regex pattern.
   * Returns lightweight MatchRect objects for just the matching text portions.
   */
  findSpansByRegex(
    pattern: string,
    minFontSize: number = 0,
    maxFontSize: number = 999,
    minBaseline: number | null = null,
    maxBaseline: number | null = null,
    caseSensitive: boolean = false
  ): MatchingSpansResult {
    const matches: MatchRect[] = [];
    const matchesByPage: Record<number, MatchRect[]> = {};

    // Build regex flags: 'g' for global, 'i' for case-insensitive (if not caseSensitive)
    const flags = caseSensitive ? 'g' : 'gi';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      console.error(`findSpansByRegex: Invalid regex pattern: ${pattern}`);
      return { matches: [], matchesByPage: {}, total: 0, pattern };
    }

    // Identify pages that have image blocks (mutool coordinates may be wrong on these)
    const pagesWithImages = new Set<number>();
    for (const block of this.blocks) {
      if (block.is_image) {
        pagesWithImages.add(block.page);
      }
    }

    // Debug: log page dimensions to check for origin offsets
    console.log('[findSpansByRegex] Searching for pattern:', pattern);
    console.log('[findSpansByRegex] Pages with images (will use mupdf.js for these):', Array.from(pagesWithImages).join(', ') || 'none');
    console.log('[findSpansByRegex] Page dimensions with non-zero origins:');
    for (let i = 0; i < this.pageDimensions.length; i++) {
      const dim = this.pageDimensions[i];
      if (dim.originX !== 0 || dim.originY !== 0) {
        console.log(`  Page ${i}: ${dim.width}x${dim.height}, origin=(${dim.originX}, ${dim.originY})${pagesWithImages.has(i) ? ' [HAS IMAGES]' : ''}`);
      }
    }

    // Group character spans into tokens for matching
    const groupedSpans = this.groupAdjacentSpans(this.spans);

    // Debug: track first few matches per page
    const debugMatchesPerPage: Record<number, number> = {};
    // Track coordinate statistics for pages with/without images
    const imagePageCoords: Array<{page: number; y: number; yRatio: number; text: string}> = [];
    const normalPageCoords: Array<{page: number; y: number; yRatio: number; text: string}> = [];

    // Helper function to process a span and check for matches
    const processSpan = (span: TextSpan, source: string) => {
      const text = span.text.trim();
      if (text.length === 0) return;

      // Font size filter
      if (span.font_size < minFontSize || span.font_size > maxFontSize) return;

      // Baseline offset filter (for superscript/subscript detection)
      if (minBaseline !== null && span.baseline_offset < minBaseline) return;
      if (maxBaseline !== null && span.baseline_offset > maxBaseline) return;

      // Check if this span's text matches the pattern
      regex.lastIndex = 0;
      if (regex.test(text)) {
        const match: MatchRect = {
          page: span.page,
          x: span.x,
          y: span.y,
          w: span.width,
          h: span.height,
          text: text
        };

        const dim = this.pageDimensions[span.page];
        const hasImages = pagesWithImages.has(span.page);
        const yRatio = dim ? span.y / dim.height : 0;

        // Track coordinate statistics
        if (hasImages) {
          imagePageCoords.push({ page: span.page, y: span.y, yRatio, text });
        } else {
          normalPageCoords.push({ page: span.page, y: span.y, yRatio, text });
        }

        // Debug: log first 5 matches per page, with source info
        const pageMatchCount = debugMatchesPerPage[span.page] || 0;
        if (pageMatchCount < 5) {
          const sourceFlag = hasImages ? ' [PAGE HAS IMAGES]' : '';
          console.log(`[findSpansByRegex] Match on page ${span.page}: "${text}" at (${span.x.toFixed(1)}, ${span.y.toFixed(1)}) size ${span.width.toFixed(1)}x${span.height.toFixed(1)}, yRatio=${yRatio.toFixed(3)}, page dim: ${dim?.width}x${dim?.height}${sourceFlag}`);
        }
        debugMatchesPerPage[span.page] = pageMatchCount + 1;

        matches.push(match);

        // Group by page for O(1) lookup during render
        if (!matchesByPage[span.page]) {
          matchesByPage[span.page] = [];
        }
        matchesByPage[span.page].push(match);
      }
    };

    // Process all mutool spans
    for (const span of groupedSpans) {
      const hasImages = pagesWithImages.has(span.page);
      processSpan(span, hasImages ? 'mutool-image-page' : 'mutool');
    }

    // Log coordinate comparison between pages with/without images
    if (imagePageCoords.length > 0 && normalPageCoords.length > 0) {
      const avgImageYRatio = imagePageCoords.reduce((sum, c) => sum + c.yRatio, 0) / imagePageCoords.length;
      const avgNormalYRatio = normalPageCoords.reduce((sum, c) => sum + c.yRatio, 0) / normalPageCoords.length;
      console.log(`[findSpansByRegex] COORDINATE ANALYSIS:`);
      console.log(`  - Pages WITH images: ${imagePageCoords.length} matches, avg yRatio=${avgImageYRatio.toFixed(3)}`);
      console.log(`  - Pages WITHOUT images: ${normalPageCoords.length} matches, avg yRatio=${avgNormalYRatio.toFixed(3)}`);
      if (Math.abs(avgImageYRatio - avgNormalYRatio) > 0.1) {
        console.log(`  - WARNING: Large yRatio difference (${Math.abs(avgImageYRatio - avgNormalYRatio).toFixed(3)}) - possible coordinate system mismatch!`);
      }
    }

    return {
      matches,
      matchesByPage,
      total: matches.length,
      pattern
    };
  }

  /**
   * Extract text spans from a specific page using mupdf.js structured text.
   * This can be used as an alternative to mutool for pages where mutool
   * reports incorrect coordinates (e.g., pages with Form XObjects).
   */
  extractSpansFromPageMupdf(pageNum: number): TextSpan[] {
    if (!this.doc) return [];

    const page = this.doc.loadPage(pageNum);
    const pageDim = this.pageDimensions[pageNum];
    const originX = pageDim?.originX || 0;
    const originY = pageDim?.originY || 0;
    const pageHeight = pageDim?.height || 792;

    console.log(`[extractSpansFromPageMupdf] Page ${pageNum}: dims=${pageDim?.width}x${pageDim?.height}, origin=(${originX}, ${originY})`);

    // Get structured text with character-level detail
    const stext = page.toStructuredText('preserve-whitespace,preserve-spans');
    const jsonStr = stext.asJSON(1);
    const stextData = JSON.parse(jsonStr);

    const spans: TextSpan[] = [];
    let spanCount = 0;
    let loggedSamples = 0;

    for (const block of stextData.blocks || []) {
      if (block.type === 'image' || block.image) continue;

      for (const line of block.lines || []) {
        for (const span of line.spans || []) {
          const text = span.text || '';
          if (!text.trim()) continue;

          // Parse bbox - mupdf.js returns [x0, y0, x1, y1] in device coordinates
          let x: number, y: number, width: number, height: number;
          let rawY0 = 0, rawY1 = 0;
          if (Array.isArray(span.bbox) && span.bbox.length >= 4) {
            const [x0, y0, x1, y1] = span.bbox;
            rawY0 = y0;
            rawY1 = y1;
            x = x0 - originX;
            y = y0 - originY;
            width = x1 - x0;
            height = y1 - y0;
          } else if (span.bbox && typeof span.bbox.x === 'number') {
            x = span.bbox.x - originX;
            rawY0 = span.bbox.y;
            rawY1 = span.bbox.y + span.bbox.h;
            y = span.bbox.y - originY;
            width = span.bbox.w;
            height = span.bbox.h;
          } else {
            continue;
          }

          // Log first 10 spans and any that look like footnote numbers
          const isFootnoteCandidate = /^\d{1,2}$/.test(text.trim());
          if (loggedSamples < 10 || isFootnoteCandidate) {
            const yRatio = y / pageHeight;
            console.log(`  [mupdf span] "${text.trim().substring(0, 20)}" rawBbox=[${span.bbox?.join(',')}] -> y=${y.toFixed(1)} yRatio=${yRatio.toFixed(3)}${isFootnoteCandidate ? ' [FOOTNOTE?]' : ''}`);
            if (!isFootnoteCandidate) loggedSamples++;
          }

          const fontName = span.font || 'unknown';
          const fontSize = span.size || 10;
          const fontLower = fontName.toLowerCase();

          spans.push({
            id: this.hashId(`mupdf:${pageNum}:${x.toFixed(0)},${y.toFixed(0)}:${spanCount++}`),
            page: pageNum,
            x,
            y,
            width,
            height,
            text,
            font_size: fontSize,
            font_name: fontName,
            is_bold: fontLower.includes('bold'),
            is_italic: fontLower.includes('italic') || fontLower.includes('oblique'),
            baseline_offset: 0,
            block_id: ''
          });
        }
      }
    }

    console.log(`[extractSpansFromPageMupdf] Page ${pageNum}: extracted ${spans.length} spans`);
    return spans;
  }

  /**
   * Compare mutool and mupdf.js coordinates for a page to detect XObject issues.
   * Returns diagnostic info about coordinate differences.
   */
  diagnosePageCoordinates(pageNum: number): {
    mutoolSpanCount: number;
    mupdfSpanCount: number;
    hasSignificantDifference: boolean;
    sampleComparisons: Array<{
      text: string;
      mutoolY: number;
      mupdfY: number;
      yDiff: number;
    }>;
  } {
    // Get mutool spans for this page
    const mutoolSpans = this.spans.filter(s => s.page === pageNum);

    // Get mupdf spans for this page
    const mupdfSpans = this.extractSpansFromPageMupdf(pageNum);

    const pageDim = this.pageDimensions[pageNum];
    const pageHeight = pageDim?.height || 792;

    // Try to match spans by text content and compare coordinates
    const comparisons: Array<{ text: string; mutoolY: number; mupdfY: number; yDiff: number }> = [];

    for (const mutoolSpan of mutoolSpans.slice(0, 20)) { // Check first 20 spans
      const text = mutoolSpan.text.trim();
      if (text.length < 2) continue;

      // Find matching mupdf span by text
      const mupdfMatch = mupdfSpans.find(s => s.text.trim() === text);
      if (mupdfMatch) {
        const yDiff = Math.abs(mutoolSpan.y - mupdfMatch.y);
        comparisons.push({
          text: text.substring(0, 20),
          mutoolY: mutoolSpan.y,
          mupdfY: mupdfMatch.y,
          yDiff
        });
      }
    }

    // Check if there's a significant coordinate difference
    const significantDiffs = comparisons.filter(c => c.yDiff > pageHeight * 0.05); // > 5% of page height
    const hasSignificantDifference = significantDiffs.length > comparisons.length * 0.3; // > 30% have big diffs

    console.log(`[diagnosePageCoordinates] Page ${pageNum}:`);
    console.log(`  mutool spans: ${mutoolSpans.length}, mupdf spans: ${mupdfSpans.length}`);
    console.log(`  Comparisons: ${comparisons.length}, significant diffs: ${significantDiffs.length}`);
    if (comparisons.length > 0) {
      console.log(`  Sample comparisons:`);
      for (const c of comparisons.slice(0, 5)) {
        console.log(`    "${c.text}": mutool Y=${c.mutoolY.toFixed(1)}, mupdf Y=${c.mupdfY.toFixed(1)}, diff=${c.yDiff.toFixed(1)}`);
      }
    }

    return {
      mutoolSpanCount: mutoolSpans.length,
      mupdfSpanCount: mupdfSpans.length,
      hasSignificantDifference,
      sampleComparisons: comparisons.slice(0, 10)
    };
  }

  /**
   * Check if a span matches the learned fingerprint
   */
  private matchesFingerprint(span: TextSpan, fp: SpanFingerprint): boolean {
    const text = span.text.trim();
    if (text.length === 0) return false;

    // Check font size (absolute)
    if (fp.font_size_min !== null && span.font_size < fp.font_size_min) return false;
    if (fp.font_size_max !== null && span.font_size > fp.font_size_max) return false;

    // Check font size ratio to body text
    if (fp.font_size_ratio_to_body !== null && fp.body_font_size > 0) {
      const ratio = span.font_size / fp.body_font_size;
      if (ratio < fp.font_size_ratio_to_body[0] || ratio > fp.font_size_ratio_to_body[1]) {
        return false;
      }
    }

    // Check font name
    if (fp.font_names !== null && !fp.font_names.includes(span.font_name)) {
      return false;
    }

    // Check bold/italic
    if (fp.is_bold !== null && span.is_bold !== fp.is_bold) return false;
    if (fp.is_italic !== null && span.is_italic !== fp.is_italic) return false;

    // Check character class
    if (fp.char_class !== null && !this.matchesCharClass(text, fp.char_class)) {
      return false;
    }

    // Check text length
    if (fp.length_min !== null && text.length < fp.length_min) return false;
    if (fp.length_max !== null && text.length > fp.length_max) return false;

    // Check baseline offset
    if (fp.baseline_offset_min !== null && span.baseline_offset < fp.baseline_offset_min) return false;
    if (fp.baseline_offset_max !== null && span.baseline_offset > fp.baseline_offset_max) return false;

    return true;
  }

  /**
   * Check if text matches a character class
   */
  private matchesCharClass(text: string, charClass: CharClass): boolean {
    switch (charClass) {
      case 'digits': return /^\d+$/.test(text);
      case 'uppercase': return /^[A-Z]+$/.test(text);
      case 'lowercase': return /^[a-z]+$/.test(text);
      case 'mixed_alpha': return /^[A-Za-z]+$/.test(text);
      case 'mixed_alphanum': return /^[A-Za-z0-9]+$/.test(text);
      case 'symbols': return /^[^\w\s]+$/.test(text);
      case 'mixed': return true;  // Match anything
      default: return true;
    }
  }

  /**
   * Extract simple search patterns from a regex.
   * For numeric patterns like ^\d{1,3}$, generates actual numbers to search.
   * For more complex patterns, returns an empty array (will fall back to span matching).
   */
  private getSimplePatternsFromRegex(pattern: string): string[] {
    const patterns: string[] = [];

    // Detect numeric-only patterns: ^\d+$, ^\d{1,2}$, ^\d{1,3}$, etc.
    const numericMatch = pattern.match(/^\^?\\d(\+|\{(\d+),?(\d+)?\})\$?$/);
    if (numericMatch) {
      let minDigits = 1;
      let maxDigits = 3; // Default max for \d+

      if (numericMatch[2]) {
        minDigits = parseInt(numericMatch[2], 10);
        maxDigits = numericMatch[3] ? parseInt(numericMatch[3], 10) : minDigits;
      }

      // Generate numbers from 1 to max for the digit range
      // For footnote numbers, we typically want 1-999
      const maxNum = Math.pow(10, maxDigits) - 1;
      const minNum = Math.pow(10, minDigits - 1);

      // Generate a reasonable set of numbers
      for (let i = Math.max(1, minNum); i <= Math.min(maxNum, 200); i++) {
        patterns.push(String(i));
      }

      console.log(`[getSimplePatternsFromRegex] Numeric pattern "${pattern}": generating ${patterns.length} numbers (${minNum}-${Math.min(maxNum, 200)})`);
      return patterns;
    }

    // For other patterns, we can't easily enumerate - return empty
    console.log(`[getSimplePatternsFromRegex] Complex pattern "${pattern}": cannot enumerate, will use span matching`);
    return patterns;
  }

  /**
   * Get all spans (for UI)
   */
  getSpans(): TextSpan[] {
    return this.spans;
  }

  /**
   * Generate a short hash ID
   */
  private hashId(input: string): string {
    return crypto.createHash('md5').update(input).digest('hex').substring(0, 12);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chapter Detection & TOC Extraction
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extract table of contents (outline) from the loaded document.
   * Returns hierarchical outline items that can be converted to chapters.
   */
  async extractOutline(): Promise<OutlineItem[]> {
    if (!this.doc) {
      throw new Error('No document loaded');
    }

    const outline = this.doc.loadOutline();
    if (!outline) {
      return [];
    }

    // Recursively convert mupdf outline to our OutlineItem format
    const convertOutline = (items: any[]): OutlineItem[] => {
      const result: OutlineItem[] = [];
      for (const item of items) {
        let pageNum = 0;
        let yPos: number | undefined;

        // Try to get page number directly
        if (typeof item.page === 'number' && !isNaN(item.page)) {
          pageNum = item.page;
        }
        // For EPUBs, mupdf may provide a URI instead - try to resolve it
        else if (item.uri && this.doc) {
          try {
            // resolveLinkDestination converts a URI to a location with page + coordinates
            const dest = this.doc.resolveLinkDestination(item.uri);
            if (dest && typeof dest.page === 'number' && !isNaN(dest.page)) {
              pageNum = dest.page;
              if (typeof dest.y === 'number' && !isNaN(dest.y)) {
                yPos = dest.y;
              }
            }
          } catch (e) {
            // resolveLink may fail for some URIs, default to 0
            console.warn(`[extractOutline] Could not resolve URI: ${item.uri}`, e);
          }
        }

        const outlineItem: OutlineItem = {
          title: item.title || '',
          page: pageNum,
          y: yPos,
        };
        if (item.down && Array.isArray(item.down) && item.down.length > 0) {
          outlineItem.down = convertOutline(item.down);
        }
        result.push(outlineItem);
      }
      return result;
    };

    return convertOutline(outline);
  }

  /**
   * Convert outline items to flat chapter list with levels
   */
  outlineToChapters(outline: OutlineItem[]): Chapter[] {
    const chapters: Chapter[] = [];
    let idCounter = 0;

    const flatten = (items: OutlineItem[], level: number) => {
      for (const item of items) {
        chapters.push({
          id: `toc-${idCounter++}`,
          title: item.title,
          page: item.page,
          y: item.y,  // Pass through y-coordinate for proper positioning
          level,
          source: 'toc',
        });
        if (item.down) {
          flatten(item.down, level + 1);
        }
      }
    };

    flatten(outline, 1);
    return chapters;
  }

  /**
   * Detect chapters using heuristics:
   * - Pattern matching for chapter/section headings
   * - Font size analysis (larger than body = potential heading)
   * - Title category blocks
   * - Bold text in top portion of page
   */
  detectChaptersHeuristic(): Chapter[] {
    if (this.blocks.length === 0) {
      return [];
    }

    const chapters: Chapter[] = [];
    const bodyFontSize = this.getBodyFontSize();

    // Chapter patterns
    const chapterPattern = /^(chapter|part|book|section|introduction|preface|foreword|epilogue|prologue|acknowledgments?|afterword|appendix|contents?|table of contents?)\s*([\dIVXLCDMivxlcdm]+)?\.?$/i;
    const numberedChapterPattern = /^(chapter|part|section)\s+[\dIVXLCDMivxlcdm]+\.?\s*[:\-]?\s*.+/i;

    for (const block of this.blocks) {
      // Skip non-text blocks and very small blocks
      if (block.is_image || block.char_count < 3) continue;

      const text = block.text.trim();
      let confidence = 0;

      // Factor 1: Title category (+0.4)
      if (block.category_id === 'title') {
        confidence += 0.4;
      }

      // Factor 2: Larger font size (+0.3)
      if (block.font_size > bodyFontSize * 1.3) {
        confidence += 0.3;
      }

      // Factor 3: Chapter pattern match (+0.5)
      if (chapterPattern.test(text) || numberedChapterPattern.test(text)) {
        confidence += 0.5;
      }

      // Factor 4: Bold in top 25% of page (+0.2)
      const pageHeight = this.pageDimensions[block.page]?.height || 800;
      const yPct = block.y / pageHeight;
      if (block.is_bold && yPct < 0.25) {
        confidence += 0.2;
      }

      // Factor 5: Short text that looks like a heading (+0.1)
      if (block.line_count <= 2 && block.char_count < 100) {
        confidence += 0.1;
      }

      // Add as chapter if confidence >= 0.4
      if (confidence >= 0.4) {
        // Find linked block to get exact position
        chapters.push({
          id: this.hashId(`heuristic-${block.page}-${block.y}-${text.substring(0, 20)}`),
          title: text.length > 80 ? text.substring(0, 77) + '...' : text,
          page: block.page,
          blockId: block.id,
          y: block.y,
          level: this.inferChapterLevel(text, block.font_size, bodyFontSize),
          source: 'heuristic',
          confidence,
        });
      }
    }

    // Sort by page, then y position
    chapters.sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    });

    // Merge multi-line chapter titles: when consecutive chapter candidates on the
    // same page are vertically adjacent with similar styling, they're likely parts
    // of the same title split across blocks (e.g. "CHAPTER ONE" / "The Beginning").
    const mergedChapters: Chapter[] = [];
    for (const chapter of chapters) {
      const prev = mergedChapters[mergedChapters.length - 1];
      if (prev && prev.page === chapter.page) {
        const prevBlock = prev.blockId ? this.blocks.find(b => b.id === prev.blockId) : null;
        const curBlock = chapter.blockId ? this.blocks.find(b => b.id === chapter.blockId) : null;

        if (prevBlock && curBlock) {
          const prevBottom = prevBlock.y + prevBlock.height;
          const gap = curBlock.y - prevBottom;
          // Merge if gap is small (within ~1.5x the font size) and fonts are similar
          const maxGap = Math.max(prevBlock.font_size, curBlock.font_size) * 1.5;
          const similarFont = Math.abs(prevBlock.font_size - curBlock.font_size) < prevBlock.font_size * 0.3;
          const similarStyle = prevBlock.is_bold === curBlock.is_bold;

          if (gap < maxGap && similarFont && similarStyle) {
            // Merge: combine titles, keep the first chapter's position and higher confidence
            const combinedTitle = `${prev.title} ${chapter.title}`.trim();
            prev.title = combinedTitle.length > 80
              ? combinedTitle.substring(0, 77) + '...'
              : combinedTitle;
            prev.confidence = Math.max(prev.confidence || 0, chapter.confidence || 0);
            continue; // Skip adding current — it's merged into prev
          }
        }
      }
      mergedChapters.push(chapter);
    }

    return mergedChapters;
  }

  /**
   * Infer chapter level from text pattern and font size
   */
  private inferChapterLevel(text: string, fontSize: number, bodyFontSize: number): number {
    const lowerText = text.toLowerCase();

    // Level 1: Major divisions (Part, Book)
    if (/^(part|book)\s+[\dIVXLCDM]+/i.test(text)) {
      return 1;
    }

    // Level 1: Chapters
    if (/^chapter\s+[\dIVXLCDM]+/i.test(text) || fontSize > bodyFontSize * 1.5) {
      return 1;
    }

    // Level 2: Sections, or moderately larger text
    if (/^section\s+[\dIVXLCDM]+/i.test(text) || fontSize > bodyFontSize * 1.2) {
      return 2;
    }

    // Level 3: Subsections or normal heading size
    return 3;
  }

  /**
   * Add bookmarks (outline) to an exported PDF.
   * Takes existing PDF data and adds chapter bookmarks using OutlineIterator.
   */
  async addBookmarksToPdf(pdfData: Uint8Array, chapters: Chapter[]): Promise<Uint8Array> {
    if (chapters.length === 0) {
      return pdfData;
    }

    const mupdfLib = await getMupdf();
    const doc = mupdfLib.Document.openDocument(pdfData, 'application/pdf');

    // Sort chapters by page and position
    const sortedChapters = [...chapters].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    });

    try {
      // Use OutlineIterator to add bookmarks
      const iterator = doc.outlineIterator();

      // Build hierarchical structure and insert using the iterator
      // The iterator uses a cursor-based approach
      const insertChaptersRecursive = (
        chaptersToInsert: Chapter[],
        parentLevel: number
      ) => {
        let i = 0;
        while (i < chaptersToInsert.length) {
          const chapter = chaptersToInsert[i];

          // Create URI for internal link to page (mupdf uses #page=N format, 1-indexed)
          const uri = `#page=${chapter.page + 1}`;

          // Insert the outline item
          const result = iterator.insert({
            title: chapter.title,
            uri: uri,
            open: chapter.level === 1, // Keep top-level chapters expanded
          });

          // Collect children (chapters with higher level numbers immediately following)
          const children: Chapter[] = [];
          let j = i + 1;
          while (j < chaptersToInsert.length && chaptersToInsert[j].level > chapter.level) {
            if (chaptersToInsert[j].level === chapter.level + 1) {
              children.push(chaptersToInsert[j]);
            }
            j++;
          }

          // If there are children, go down and insert them
          if (children.length > 0 && result >= 0) {
            iterator.down();
            insertChaptersRecursive(
              chaptersToInsert.slice(i + 1, j).filter(c => c.level > chapter.level),
              chapter.level
            );
            iterator.up();
          }

          // Move to next sibling position
          iterator.next();
          i = j > i + 1 ? j : i + 1;
        }
      };

      // Insert all chapters starting from root level
      const topLevelChapters = sortedChapters.filter(
        c => c.level === Math.min(...sortedChapters.map(ch => ch.level))
      );

      if (topLevelChapters.length > 0) {
        insertChaptersRecursive(sortedChapters, 0);
      }
    } catch (err) {
      console.error('Failed to add bookmarks:', err);
      // Return original PDF if bookmark addition fails
      return pdfData;
    }

    // Save and return - need to use asPDF() for saveToBuffer
    const pdfDoc = doc.asPDF();
    if (!pdfDoc) {
      return pdfData;
    }
    const buffer = pdfDoc.saveToBuffer('compress');
    return buffer.asUint8Array();
  }
}

// Lightweight match representation for memory efficiency (~40 bytes vs 200+ for TextBlock)
export interface MatchRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

// Result from findMatchingSpans
export interface MatchingSpansResult {
  matches: MatchRect[];
  matchesByPage: Record<number, MatchRect[]>;  // O(1) lookup by page for lazy rendering
  total: number;
  pattern: string;
}

// Character class detection
type CharClass = 'digits' | 'uppercase' | 'lowercase' | 'mixed_alpha' | 'mixed_alphanum' | 'symbols' | 'mixed';

// Learned fingerprint from sample analysis - captures ALL discriminating properties
export interface SpanFingerprint {
  // Font properties (null = don't filter on this)
  font_size_min: number | null;
  font_size_max: number | null;
  font_size_ratio_to_body: [number, number] | null;  // [min, max] ratio relative to body text
  font_names: string[] | null;  // null = any font, array = must match one
  is_bold: boolean | null;
  is_italic: boolean | null;

  // Text properties
  char_class: CharClass | null;  // Detected character class
  length_min: number | null;
  length_max: number | null;

  // Position properties
  baseline_offset_min: number | null;
  baseline_offset_max: number | null;

  // Context properties (what surrounds the text)
  preceded_by: ('space' | 'punctuation' | 'letter' | 'digit' | 'line_start')[] | null;
  followed_by: ('space' | 'punctuation' | 'letter' | 'digit' | 'line_end')[] | null;

  // Metadata
  sample_count: number;
  body_font_size: number;
  description: string;  // Human-readable description of what was detected
}

// Legacy alias for compatibility
export type SamplePattern = SpanFingerprint;

// Singleton instance
export const pdfAnalyzer = new PDFAnalyzer();

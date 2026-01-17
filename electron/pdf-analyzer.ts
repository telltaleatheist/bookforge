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

const execAsync = promisify(exec);

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
  down?: OutlineItem[];      // Nested children
}

export interface DeletedRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isImage?: boolean;
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
   */
  private async getAnalysisCachePath(fileHash: string): Promise<string> {
    const cacheDir = path.join(this.getAnalysisCacheDir(), fileHash);
    try {
      await fsPromises.access(cacheDir);
    } catch {
      await fsPromises.mkdir(cacheDir, { recursive: true });
    }
    return path.join(cacheDir, 'analysis.json');
  }

  /**
   * Load cached analysis if available
   */
  private async loadCachedAnalysis(fileHash: string): Promise<AnalyzeResult | null> {
    const cachePath = await this.getAnalysisCachePath(fileHash);
    try {
      const data = await fsPromises.readFile(cachePath, 'utf-8');
      console.log(`Loaded cached analysis for ${fileHash}`);
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
      console.log(`Saved analysis cache for ${fileHash}`);
    } catch (err) {
      console.error('Failed to save analysis cache:', err);
    }
  }

  /**
   * Analyze a document (PDF, EPUB, etc.) and extract blocks with categories
   * Uses cached analysis if available for the same file
   */
  async analyze(pdfPath: string, maxPages?: number): Promise<AnalyzeResult> {
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

        return cached;
      }
    }

    this.pdfPath = pdfPath;
    this.blocks = [];
    this.spans = [];
    this.categories = {};
    this.pageDimensions = [];

    // Read document file asynchronously to avoid blocking the main thread
    const data = await fsPromises.readFile(pdfPath);
    const mimeType = getMimeType(pdfPath);
    this.doc = mupdfLib.Document.openDocument(data, mimeType);

    const totalPages = this.doc.countPages();
    const pageCount = maxPages ? Math.min(totalPages, maxPages) : totalPages;

    // Get page dimensions
    for (let pageNum = 0; pageNum < pageCount; pageNum++) {
      const page = this.doc.loadPage(pageNum);
      const bounds = page.getBounds();
      this.pageDimensions.push({
        width: bounds[2] - bounds[0],
        height: bounds[3] - bounds[1],
      });
    }

    // Extract blocks from each page
    for (let pageNum = 0; pageNum < pageCount; pageNum++) {
      await this.extractPageBlocks(pageNum);
    }

    // Extract spans using mutool for precise character-level positions
    await this.extractSpansWithMutool(pdfPath, pageCount);

    // Generate categories
    this.generateCategories();

    console.log(`PDF analysis complete: ${this.blocks.length} blocks, ${this.spans.length} spans extracted`);

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
          // Debug: log line structure on first text block of first page
          if (pageNum === 0 && blockIdx === 0 && block.lines.indexOf(line) === 0) {
            console.log('First line keys:', Object.keys(line));
            console.log('First line structure:', JSON.stringify(line, null, 2).substring(0, 500));
          }
          if (line.spans && Array.isArray(line.spans)) {
            // Debug: log first span structure on first page
            if (pageNum === 0 && block.lines.indexOf(line) === 0 && line.spans.length > 0) {
              console.log('Sample span structure:', JSON.stringify(line.spans[0], null, 2));
            }
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

        // Very top (< 4%) with page number pattern or very short = definitely header
        if (yPct < 0.04 && (hasPageNumPattern || textLen < 80) && lineCount <= 2) {
          region = 'header';
        }
        // Top 6% with clear header signals (not body text)
        else if (yPct < 0.06 && !looksLikeBodyText && lineCount <= 2 && textLen < 120) {
          region = 'header';
        }
        // Top 8% with page number pattern = header
        else if (yPct < 0.08 && hasPageNumPattern && !looksLikeBodyText) {
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
   * Extract spans using mutool binary for precise character positions
   */
  private async extractSpansWithMutool(pdfPath: string, pageCount: number): Promise<void> {
    try {
      // Check if mutool is available
      const mutoolPath = await this.findMutool();
      if (!mutoolPath) {
        console.log('mutool not found, skipping span extraction');
        return;
      }

      console.log(`Extracting spans with mutool from ${pageCount} pages...`);

      // Use a temp file to avoid shell buffer limits on large PDFs
      const tmpFile = path.join(os.tmpdir(), `bookforge-stext-${Date.now()}.xml`);

      try {
        // Run mutool asynchronously to avoid blocking the main thread
        // Note: Don't use stderr redirection - 2>NUL creates a file named NUL in Git Bash on Windows
        await execAsync(`"${mutoolPath}" draw -F stext -o "${tmpFile}" "${pdfPath}"`, {
          maxBuffer: 10 * 1024 * 1024
        });

        // Read the temp file asynchronously
        const result = await fsPromises.readFile(tmpFile, 'utf-8');
        console.log(`  Got ${result.length} bytes of XML output`);

        // Parse the XML output
        this.parseSpansFromXml(result);

        console.log(`  Extracted ${this.spans.length} spans with mutool`);
        if (this.spans.length > 0) {
          // Log first few spans for debugging
          console.log(`  Sample spans:`);
          for (let i = 0; i < Math.min(3, this.spans.length); i++) {
            const s = this.spans[i];
            console.log(`    Page ${s.page}: "${s.text.substring(0, 30)}" at (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
          }
        }
      } finally {
        // Clean up temp file
        try {
          await fsPromises.unlink(tmpFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (err) {
      console.log('mutool span extraction failed:', (err as Error).message);
    }
  }

  private async findMutool(): Promise<string | null> {
    // Check common locations - include Windows paths
    const paths = process.platform === 'win32'
      ? [
          'mutool', // Try PATH first on Windows
          'C:\\Program Files\\MuPDF\\mutool.exe',
          'C:\\Program Files (x86)\\MuPDF\\mutool.exe'
        ]
      : [
          '/opt/homebrew/bin/mutool',
          '/usr/local/bin/mutool',
          '/usr/bin/mutool',
          'mutool' // Try PATH
        ];

    for (const p of paths) {
      try {
        await execAsync(`"${p}" -v`);
        return p;
      } catch {
        // Not found at this path
      }
    }
    return null;
  }

  private parseSpansFromXml(xml: string): void {
    // Parse mutool stext XML output to extract spans
    // Format: <page><block><line><font><char>...</font></line></block></page>

    let currentPage = -1;
    let currentFontName = '';
    let currentFontSize = 0;
    let spanChars: Array<{ char: string; x: number; y: number; x2: number; y2: number }> = [];
    let pageCount = 0;
    let fontCount = 0;
    let charCount = 0;

    const lines = xml.split('\n');
    console.log(`  Parsing ${lines.length} lines of XML...`);

    for (const line of lines) {
      // Track page
      const pageMatch = line.match(/<page id="page(\d+)"/);
      if (pageMatch) {
        // Flush previous span
        this.flushSpan(currentPage, currentFontName, currentFontSize, spanChars);
        spanChars = [];
        currentPage = parseInt(pageMatch[1]) - 1; // Convert to 0-indexed
        pageCount++;
        continue;
      }

      // Track font changes
      const fontMatch = line.match(/<font name="([^"]*)" size="([^"]*)"/);
      if (fontMatch) {
        // Flush previous span on font change
        this.flushSpan(currentPage, currentFontName, currentFontSize, spanChars);
        spanChars = [];
        currentFontName = fontMatch[1];
        currentFontSize = parseFloat(fontMatch[2]);
        fontCount++;
        continue;
      }

      // End of font section
      if (line.includes('</font>')) {
        this.flushSpan(currentPage, currentFontName, currentFontSize, spanChars);
        spanChars = [];
        continue;
      }

      // Parse character with quad coordinates
      const charMatch = line.match(/<char quad="([^"]*)"[^>]*c="([^"]*)"/);
      if (charMatch) {
        const quad = charMatch[1].split(' ').map(parseFloat);
        const char = charMatch[2];
        // quad format: x0 y0 x1 y0 x0 y1 x1 y1 (top-left, top-right, bottom-left, bottom-right)
        if (quad.length >= 8) {
          spanChars.push({
            char: char === '&amp;' ? '&' : char === '&lt;' ? '<' : char === '&gt;' ? '>' : char === '&quot;' ? '"' : char,
            x: quad[0],
            y: quad[1],
            x2: quad[2],
            y2: quad[5]
          });
          charCount++;
        }
      }
    }

    // Flush final span
    this.flushSpan(currentPage, currentFontName, currentFontSize, spanChars);
    console.log(`  XML parsing complete: ${pageCount} pages, ${fontCount} fonts, ${charCount} chars`);
  }

  private flushSpan(
    page: number,
    fontName: string,
    fontSize: number,
    chars: Array<{ char: string; x: number; y: number; x2: number; y2: number }>
  ): void {
    if (page < 0 || chars.length === 0) return;

    const fontLower = fontName.toLowerCase();
    const isBold = fontLower.includes('bold');
    const isItalic = fontLower.includes('italic') || fontLower.includes('oblique');

    // Create character-level spans for precise selection (e.g., footnote numbers)
    for (const char of chars) {
      // Skip whitespace
      if (char.char === ' ' || char.char === '\t' || char.char === '\n') continue;

      const spanId = this.hashId(`${page}:char:${char.x.toFixed(0)},${char.y.toFixed(0)}:${char.char}`);

      this.spans.push({
        id: spanId,
        page,
        x: char.x,
        y: char.y,
        width: char.x2 - char.x,
        height: char.y2 - char.y,
        text: char.char,
        font_size: fontSize,
        font_name: fontName,
        is_bold: isBold,
        is_italic: isItalic,
        baseline_offset: 0,
        block_id: '',
      });
    }
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

    if (!looksLikeBodyText && yPct < 0.08 && block.line_count <= 2) {
      // Page number patterns like "8 Introduction"
      const hasPageNumPattern = /^\d{1,4}\s+\S/.test(text) || /\S\s+\d{1,4}$/.test(text);
      if (hasPageNumPattern) {
        return 'header';
      }
      // Very short text at very top
      if (yPct < 0.05 && block.char_count < 80) {
        return 'header';
      }
      // Italic + short + top = running header
      if (block.is_italic && block.char_count < 80) {
        return 'header';
      }
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
   * Clean up cache for a specific file hash
   */
  clearCache(fileHash: string): void {
    const cacheDir = path.join(this.getCacheBaseDir(), fileHash);
    if (fs.existsSync(cacheDir)) {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        console.log(`Cleared cache for ${fileHash}`);
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
    if (pdfPath && pdfPath !== this.pdfPath) {
      const data = fs.readFileSync(pdfPath);
      const mimeType = getMimeType(pdfPath);
      doc = mupdfLib.Document.openDocument(data, mimeType);
    }

    if (!doc) {
      throw new Error('No document loaded');
    }

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

    // Open document
    const data = fs.readFileSync(pdfPath);
    const mimeType = getMimeType(pdfPath);
    const doc = mupdfLib.Document.openDocument(data, mimeType);
    const totalPages = doc.countPages();

    const previewPaths: string[] = new Array(totalPages);
    const previewDir = this.getQualityCacheDir(fileHash, 'preview');
    const fullDir = this.getQualityCacheDir(fileHash, 'full');

    // Phase 1: Render previews (or use cached)
    let previewCompleted = 0;
    const renderPreview = async (pageNum: number): Promise<void> => {
      const filePath = path.join(previewDir, `page-${pageNum}.png`);

      if (!fs.existsSync(filePath)) {
        const page = doc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(this.PREVIEW_SCALE, this.PREVIEW_SCALE);
        const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
        const pngData = pixmap.asPNG();
        fs.writeFileSync(filePath, Buffer.from(pngData));
      }

      previewPaths[pageNum] = filePath;
      previewCompleted++;

      if (previewCallback) {
        previewCallback(previewCompleted, totalPages);
      }
      if (progressCallback) {
        progressCallback(previewCompleted, totalPages, 'preview');
      }
    };

    // Render previews in batches (fast)
    for (let i = 0; i < totalPages; i += concurrency * 2) {
      const batch = [];
      for (let j = i; j < Math.min(i + concurrency * 2, totalPages); j++) {
        batch.push(renderPreview(j));
      }
      await Promise.all(batch);
    }

    // Phase 2: Render full quality in background (don't await)
    let fullCompleted = 0;
    const renderFull = async (pageNum: number): Promise<void> => {
      const filePath = path.join(fullDir, `page-${pageNum}.png`);

      if (!fs.existsSync(filePath)) {
        const page = doc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(this.FULL_SCALE, this.FULL_SCALE);
        const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
        const pngData = pixmap.asPNG();
        fs.writeFileSync(filePath, Buffer.from(pngData));
      }

      this.renderedPagePaths.set(pageNum, filePath);
      fullCompleted++;

      if (fullCallback) {
        fullCallback(pageNum, filePath);
      }
      if (progressCallback) {
        progressCallback(fullCompleted, totalPages, 'full');
      }
    };

    // Start full rendering in background (don't block)
    (async () => {
      for (let i = 0; i < totalPages; i += concurrency) {
        const batch = [];
        for (let j = i; j < Math.min(i + concurrency, totalPages); j++) {
          batch.push(renderFull(j));
        }
        await Promise.all(batch);
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
    for (let i = 0; i < totalPages; i += concurrency) {
      const batch = [];
      for (let j = i; j < Math.min(i + concurrency, totalPages); j++) {
        batch.push(renderPage(j));
      }
      await Promise.all(batch);
    }

    return paths;
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
   * Render a page as PNG (base64)
   * @param redactRegions - Optional regions to blank out before rendering (for deleted/edited blocks)
   * @param fillRegions - Optional regions to fill with background color (for moved blocks)
   * Uses the same redaction approach as exportPdfWithBackgroundsRemoved for consistency
   */
  async renderPage(
    pageNum: number,
    scale: number = 2.0,
    pdfPath?: string,
    redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>,
    fillRegions?: Array<{ x: number; y: number; width: number; height: number }>
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

      // Apply redactions using the same approach as export (which works)
      if (hasRedactions && redactRegions) {
        const pdfDoc = tempDoc.asPDF();
        if (pdfDoc) {
          const pdfPage = pdfDoc.loadPage(pageNum) as any;

          // Separate image and text regions
          const imageRegions = redactRegions.filter(r => r.isImage);
          const textRegions = redactRegions.filter(r => !r.isImage);

          // First pass: Apply image-only redactions (preserve text/line art)
          if (imageRegions.length > 0) {
            for (const region of imageRegions) {
              const rect: [number, number, number, number] = [
                region.x,
                region.y,
                region.x + region.width,
                region.y + region.height,
              ];
              const annot = pdfPage.createAnnotation('Redact');
              annot.setRect(rect);
            }
            // Apply with: no black boxes, redact images, no line art, NO text
            pdfPage.applyRedactions(false, 2, 0, 0);
          }

          // Second pass: Apply text redactions
          if (textRegions.length > 0) {
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
            pdfPage.applyRedactions(false, 2, 2, 2);
          }
        }
      }

      // Render the page with redactions applied
      const renderPage = tempDoc.loadPage(pageNum);
      const matrix = mupdfLib.Matrix.scale(scale, scale);
      const pixmap = renderPage.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);

      // Apply background-color fill for moved blocks
      if (fillRegions && fillRegions.length > 0) {
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
      }

      const pngData = pixmap.asPNG();
      return Buffer.from(pngData).toString('base64');
    }

    // No redactions - check if we have fill regions
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

      const pngData = pixmap.asPNG();
      return Buffer.from(pngData).toString('base64');
    }

    // No redactions or fills - render from cached document
    if (!this.doc) {
      throw new Error('No document loaded');
    }

    const page = this.doc.loadPage(pageNum);
    const matrix = mupdfLib.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);
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
   * Export a cleaned PDF with deleted regions removed
   * Note: Only works with PDF files (redaction is PDF-specific)
   *
   * Image regions are redacted separately with text_method=0 to preserve
   * any text that might overlap the image area.
   *
   * When ocrBlocks are provided and images are deleted, the OCR text is embedded
   * into the PDF to replace the deleted image content.
   */
  async exportPdf(
    pdfPath: string,
    deletedRegions: DeletedRegion[],
    ocrBlocks?: OcrTextBlock[]
  ): Promise<string> {
    const mupdfLib = await getMupdf();
    const data = fs.readFileSync(pdfPath);
    const mimeType = getMimeType(pdfPath);
    const doc = mupdfLib.Document.openDocument(data, mimeType);
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      throw new Error('Source must be a PDF file for PDF export with redactions');
    }

    // Separate image and text regions, grouped by page
    const imageRegionsByPage = new Map<number, DeletedRegion[]>();
    const textRegionsByPage = new Map<number, DeletedRegion[]>();

    for (const region of deletedRegions) {
      const targetMap = region.isImage ? imageRegionsByPage : textRegionsByPage;
      if (!targetMap.has(region.page)) {
        targetMap.set(region.page, []);
      }
      targetMap.get(region.page)!.push(region);
    }

    // Group OCR blocks by page
    const ocrByPage = new Map<number, OcrTextBlock[]>();
    if (ocrBlocks && ocrBlocks.length > 0) {
      for (const block of ocrBlocks) {
        if (!ocrByPage.has(block.page)) {
          ocrByPage.set(block.page, []);
        }
        ocrByPage.get(block.page)!.push(block);
      }
    }

    // Get all unique page numbers
    const allPages = new Set([...imageRegionsByPage.keys(), ...textRegionsByPage.keys()]);

    // Track pages that need OCR text added
    const pagesNeedingOcrText: number[] = [];

    // Process each page
    for (const pageNum of allPages) {
      if (pageNum >= pdfDoc.countPages()) continue;

      const page = pdfDoc.loadPage(pageNum) as any; // PDFPage type

      // First pass: Apply image-only redactions (preserve text)
      const imageRegions = imageRegionsByPage.get(pageNum) || [];
      if (imageRegions.length > 0) {
        for (const region of imageRegions) {
          const rect: [number, number, number, number] = [
            region.x,
            region.y,
            region.x + region.width,
            region.y + region.height,
          ];
          const annot = page.createAnnotation('Redact');
          annot.setRect(rect);
        }
        // Apply with: no black boxes, redact images, no line art, NO text
        // This preserves any text that overlaps the image
        page.applyRedactions(false, 2, 0, 0);

        // Mark this page as needing OCR text if OCR blocks exist for it
        if (ocrByPage.has(pageNum)) {
          pagesNeedingOcrText.push(pageNum);
        }
      }

      // Second pass: Apply text redactions (normal behavior)
      const textRegions = textRegionsByPage.get(pageNum) || [];
      if (textRegions.length > 0) {
        for (const region of textRegions) {
          const rect: [number, number, number, number] = [
            region.x,
            region.y,
            region.x + region.width,
            region.y + region.height,
          ];
          const annot = page.createAnnotation('Redact');
          annot.setRect(rect);
        }
        // Apply with: no black boxes, redact images, line art, AND text
        page.applyRedactions(false, 2, 2, 2);
      }
    }

    // Add OCR text to pages where images were deleted
    // We need to add a Helvetica font to the document first
    if (pagesNeedingOcrText.length > 0) {
      // Create font dictionary for Helvetica
      const fontDict = pdfDoc.addObject({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: 'WinAnsiEncoding'
      });

      for (const pageNum of pagesNeedingOcrText) {
        const pageOcrBlocks = ocrByPage.get(pageNum) || [];
        if (pageOcrBlocks.length === 0) continue;

        const page = pdfDoc.loadPage(pageNum) as any;
        const bounds = page.getBounds();
        const pageHeight = bounds[3] - bounds[1];

        // Build text content stream
        let textContent = 'BT\n';  // Begin text

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

        // Add the text content as a new content stream
        // First, add font to page resources
        const pageObj = pdfDoc.findPage(pageNum);
        const resources = pageObj.get('Resources');

        // Get or create Font dictionary in resources
        let fonts = resources.get('Font');
        if (!fonts || fonts.isNull()) {
          fonts = pdfDoc.addObject({});
          resources.put('Font', fonts);
        }

        // Add our font as F1
        fonts.put('F1', fontDict);

        // Create new content stream with OCR text
        const textStream = pdfDoc.addStream(textContent, {});

        // Append to existing page contents
        const existingContents = pageObj.get('Contents');
        if (existingContents && !existingContents.isNull()) {
          if (existingContents.isArray()) {
            // Contents is already an array, append to it
            existingContents.push(textStream);
          } else {
            // Contents is a single stream, convert to array
            const newContents = pdfDoc.addObject([existingContents, textStream]);
            pageObj.put('Contents', newContents);
          }
        } else {
          // No existing contents, set our stream
          pageObj.put('Contents', textStream);
        }
      }
    }

    // Save to buffer
    const buffer = pdfDoc.saveToBuffer('compress');
    const base64 = Buffer.from(buffer.asUint8Array()).toString('base64');

    return base64;
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
    ocrBlocks?: OcrTextBlock[]
  ): Promise<string> {
    const mupdfLib = await getMupdf();

    if (!this.doc) {
      throw new Error('No document loaded');
    }

    const totalPages = this.doc.countPages();

    // Group deleted regions by page for efficient lookup
    const regionsByPage = new Map<number, DeletedRegion[]>();
    if (deletedRegions && deletedRegions.length > 0) {
      for (const region of deletedRegions) {
        if (!regionsByPage.has(region.page)) {
          regionsByPage.set(region.page, []);
        }
        regionsByPage.get(region.page)!.push(region);
      }
    }

    // Group OCR blocks by page
    const ocrByPage = new Map<number, OcrTextBlock[]>();
    if (ocrBlocks && ocrBlocks.length > 0) {
      for (const block of ocrBlocks) {
        if (!ocrByPage.has(block.page)) {
          ocrByPage.set(block.page, []);
        }
        ocrByPage.get(block.page)!.push(block);
      }
    }

    // Create a new PDF document
    const outputDoc = new mupdfLib.PDFDocument() as any;

    // Process each page
    for (let pageNum = 0; pageNum < totalPages; pageNum++) {
      // Report progress
      if (progressCallback) {
        progressCallback(pageNum, totalPages);
      }

      // Check if this page has deleted regions
      const pageRegions = regionsByPage.get(pageNum) || [];
      let pixmap;

      if (pageRegions.length > 0 && this.pdfPath) {
        // Separate image and text regions
        const imageRegions = pageRegions.filter(r => r.isImage);
        const textRegions = pageRegions.filter(r => !r.isImage);

        // Load a fresh copy of the PDF and apply redactions before rendering
        const data = fs.readFileSync(this.pdfPath);
        const mimeType = getMimeType(this.pdfPath);
        const tempDoc = mupdfLib.Document.openDocument(data, mimeType);
        const pdfDoc = tempDoc.asPDF();

        if (pdfDoc) {
          const pdfPage = pdfDoc.loadPage(pageNum) as any; // PDFPage type

          // First pass: Apply image-only redactions (preserve text)
          if (imageRegions.length > 0) {
            for (const region of imageRegions) {
              const rect: [number, number, number, number] = [
                region.x,
                region.y,
                region.x + region.width,
                region.y + region.height,
              ];
              const annot = pdfPage.createAnnotation('Redact');
              annot.setRect(rect);
            }
            // Apply with: no black boxes, redact images, no line art, NO text
            // This preserves any text that overlaps the image
            pdfPage.applyRedactions(false, 2, 0, 0);
          }

          // Second pass: Apply text redactions (normal behavior)
          if (textRegions.length > 0) {
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
            pdfPage.applyRedactions(false, 2, 2, 2);
          }
        }

        // Render the page with redactions applied
        const renderPage = tempDoc.loadPage(pageNum);
        const matrix = mupdfLib.Matrix.scale(scale, scale);
        pixmap = renderPage.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);
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
   * Close the document
   */
  close(): void {
    this.doc = null;
    this.blocks = [];
    this.spans = [];
    this.categories = {};
    this.pageDimensions = [];
  }

  /**
   * Find blocks within or near a given rectangle on a page
   * Falls back to spans if available, otherwise uses blocks
   */
  findSpansInRect(page: number, x: number, y: number, width: number, height: number): TextSpan[] {
    console.log(`findSpansInRect: page=${page}, rect=(${x.toFixed(1)}, ${y.toFixed(1)}, ${width.toFixed(1)}x${height.toFixed(1)})`);
    console.log(`  Total spans in document: ${this.spans.length}`);

    // First try spans if we have them
    const pageSpans = this.spans.filter(s => s.page === page);
    console.log(`  Spans on page ${page}: ${pageSpans.length}`);

    if (pageSpans.length > 0) {
      const result = this.findSpansInRectFromSpans(page, x, y, width, height, pageSpans);
      console.log(`  Found ${result.length} matching spans`);
      if (result.length > 0) {
        console.log(`  First match: "${result[0].text}" at (${result[0].x.toFixed(1)}, ${result[0].y.toFixed(1)})`);
      }
      return result;
    }

    // Fall back to blocks - convert matching blocks to "pseudo-spans"
    console.log(`findSpansInRect: Using blocks (no spans available)`);
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

    console.log(`  Found ${matchingBlocks.length} blocks at (${x.toFixed(0)}, ${y.toFixed(0)})`);

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

    console.log(`  Grouped ${spans.length} char spans into ${grouped.length} token spans`);
    if (grouped.length > 0) {
      console.log(`  Sample tokens: ${grouped.slice(0, 5).map(s => `"${s.text}"`).join(', ')}`);
    }

    return grouped;
  }

  /**
   * Analyze sample spans and learn a fingerprint from their properties.
   * Instead of hardcoding patterns, we detect what makes these samples unique.
   */
  analyzesamples(sampleSpans: TextSpan[]): SpanFingerprint | null {
    if (sampleSpans.length === 0) return null;

    console.log(`analyzeSamples: ${sampleSpans.length} sample spans`);
    console.log(`  Raw sample texts: ${sampleSpans.map(s => `"${s.text}" (size=${s.font_size.toFixed(1)}, baseline=${s.baseline_offset.toFixed(1)})`).join(', ')}`);

    // Filter samples to only include spans with similar properties.
    // When user draws boxes, they might accidentally catch body text too.
    // Use the most common font size to filter out accidentally-selected body text.
    const filteredSpans = this.filterSimilarSpans(sampleSpans);
    console.log(`  After filtering: ${filteredSpans.length} similar spans`);
    console.log(`  Filtered texts: ${filteredSpans.map(s => `"${s.text}"`).join(', ')}`);

    if (filteredSpans.length === 0) {
      console.log('  ERROR: No similar spans after filtering');
      return null;
    }

    const texts = filteredSpans.map(s => s.text.trim()).filter(t => t.length > 0);
    if (texts.length === 0) {
      console.log('  ERROR: No non-empty text in samples');
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

    console.log(`  Fingerprint: ${fingerprint.description}`);
    console.log(`  Filters: fontSize=${useFontSize}, fontName=${useFontName}, charClass=${charClass}, length=${useLength}`);

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

    console.log(`  filterSimilarSpans: ${spans.length} spans -> ${filtered.length} (size=${mostCommonSize})`);
    console.log(`    Size groups: ${[...sizeGroups.entries()].map(([s, g]) => `${s}pt: ${g.length}`).join(', ')}`);

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
    console.log(`findMatchingSpans: Searching ${groupedSpans.length} grouped spans`);
    console.log(`  Fingerprint: ${fingerprint.description}`);

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

    console.log(`  Found ${matches.length} matches across ${Object.keys(matchesByPage).length} pages`);

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
      console.log(`findSpansByRegex: Invalid regex pattern: ${pattern}`);
      return { matches: [], matchesByPage: {}, total: 0, pattern };
    }

    // Group character spans into tokens for matching
    const groupedSpans = this.groupAdjacentSpans(this.spans);
    console.log(`findSpansByRegex: Searching ${groupedSpans.length} grouped spans with pattern: ${pattern}`);
    console.log(`  Case sensitive: ${caseSensitive}`);
    console.log(`  Font size filter: ${minFontSize} - ${maxFontSize}`);
    console.log(`  Baseline filter: ${minBaseline ?? 'any'} - ${maxBaseline ?? 'any'}`);

    for (const span of groupedSpans) {
      const text = span.text.trim();
      if (text.length === 0) continue;

      // Font size filter
      if (span.font_size < minFontSize || span.font_size > maxFontSize) continue;

      // Baseline offset filter (for superscript/subscript detection)
      if (minBaseline !== null && span.baseline_offset < minBaseline) continue;
      if (maxBaseline !== null && span.baseline_offset > maxBaseline) continue;

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

        matches.push(match);

        // Group by page for O(1) lookup during render
        if (!matchesByPage[span.page]) {
          matchesByPage[span.page] = [];
        }
        matchesByPage[span.page].push(match);
      }
    }

    console.log(`  Found ${matches.length} span matches across ${Object.keys(matchesByPage).length} pages`);

    return {
      matches,
      matchesByPage,
      total: matches.length,
      pattern
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
        const outlineItem: OutlineItem = {
          title: item.title || '',
          page: typeof item.page === 'number' ? item.page : 0,
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

    // Remove duplicates (same page and similar position)
    const dedupedChapters: Chapter[] = [];
    for (const chapter of chapters) {
      const isDuplicate = dedupedChapters.some(
        c => c.page === chapter.page && Math.abs((c.y || 0) - (chapter.y || 0)) < 20
      );
      if (!isDuplicate) {
        dedupedChapters.push(chapter);
      }
    }

    return dedupedChapters;
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
   * Takes existing PDF data and adds chapter bookmarks.
   */
  async addBookmarksToPdf(pdfData: Uint8Array, chapters: Chapter[]): Promise<Uint8Array> {
    if (chapters.length === 0) {
      return pdfData;
    }

    const mupdfLib = await getMupdf();
    const doc = mupdfLib.Document.openDocument(pdfData, 'application/pdf');
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      throw new Error('Failed to open PDF for bookmark addition');
    }

    // Sort chapters by page and position
    const sortedChapters = [...chapters].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    });

    // Build hierarchical outline structure based on levels
    const buildOutlineStructure = () => {
      const root: any[] = [];
      const stack: { level: number; children: any[] }[] = [{ level: 0, children: root }];

      for (const chapter of sortedChapters) {
        const entry = {
          title: chapter.title,
          page: chapter.page,
          down: [] as any[],
        };

        // Find the right parent based on level
        while (stack.length > 1 && stack[stack.length - 1].level >= chapter.level) {
          stack.pop();
        }

        // Add to current parent's children
        stack[stack.length - 1].children.push(entry);

        // Push this entry as potential parent for next items
        stack.push({ level: chapter.level, children: entry.down });
      }

      return root;
    };

    const outlineStructure = buildOutlineStructure();

    // Use mupdf's outline iterator to add bookmarks
    // Note: mupdf.js requires specific API for outline manipulation
    // For now, we'll use the setOutline method if available
    try {
      // mupdf-js may expose different APIs depending on version
      // Try the direct outline setting approach
      if (typeof (pdfDoc as any).setOutline === 'function') {
        (pdfDoc as any).setOutline(outlineStructure);
      } else {
        // Fallback: manually build outline using low-level PDF operations
        console.log('Note: Outline API not available, chapters will not be embedded as bookmarks');
      }
    } catch (err) {
      console.error('Failed to add bookmarks:', err);
    }

    // Save and return
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

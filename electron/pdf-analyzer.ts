/**
 * PDF Analyzer for BookForge - Pure TypeScript/mupdf.js implementation
 * Replaces the Python pdf_analyzer.py
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Dynamic import for ESM mupdf module
let mupdf: typeof import('mupdf') | null = null;

async function getMupdf() {
  if (!mupdf) {
    mupdf = await import('mupdf');
  }
  return mupdf;
}

// Types
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
  line_count: number;
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
}

export interface ExportTextResult {
  text: string;
  char_count: number;
}

export interface DeletedRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Semantic colors for category types
const CATEGORY_TYPE_COLORS: Record<string, string> = {
  body: '#4CAF50',        // Green
  footnote: '#2196F3',    // Blue
  footnote_ref: '#E91E63', // Pink
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
  private categories: Record<string, Category> = {};
  private pageDimensions: PageDimension[] = [];
  private doc: any = null; // mupdf.PDFDocument | mupdf.Document
  private pdfPath: string | null = null;

  /**
   * Analyze a document (PDF, EPUB, etc.) and extract blocks with categories
   */
  async analyze(pdfPath: string, maxPages?: number): Promise<AnalyzeResult> {
    const mupdfLib = await getMupdf();

    this.pdfPath = pdfPath;
    this.blocks = [];
    this.categories = {};
    this.pageDimensions = [];

    // Read document file
    const data = fs.readFileSync(pdfPath);
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

    // Generate categories
    this.generateCategories();

    return {
      blocks: this.blocks,
      categories: this.categories,
      page_count: pageCount,
      page_dimensions: this.pageDimensions,
      pdf_name: path.basename(pdfPath),
    };
  }

  /**
   * Extract text and image blocks from a single page
   */
  private async extractPageBlocks(pageNum: number): Promise<void> {
    if (!this.doc) return;

    const page = this.doc.loadPage(pageNum);
    const pageDims = this.pageDimensions[pageNum];
    const pageHeight = pageDims.height;

    // Get structured text with detailed info
    // Try different extraction methods
    const stext = page.toStructuredText('preserve-whitespace,preserve-images');
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

        for (const line of block.lines) {
          // mupdf.js structure: line.text and line.font (not spans)
          const text = line.text || '';
          if (text.trim()) {
            allText.push(text);
            const charLen = text.length;
            totalChars += charLen;

            // Font info is on line.font object
            const font = line.font || {};
            const size = Math.round((font.size || 10) * 10) / 10;
            fontSizes.set(size, (fontSizes.get(size) || 0) + charLen);

            const fontName = font.name || 'unknown';
            fontNames.set(fontName, (fontNames.get(fontName) || 0) + charLen);

            // Detect bold/italic from font properties or name
            const fontLower = fontName.toLowerCase();
            if (font.weight === 'bold' || fontLower.includes('bold')) {
              boldChars += charLen;
            }
            if (font.style === 'italic' || fontLower.includes('italic') || fontLower.includes('oblique')) {
              italicChars += charLen;
            }

            // Check for superscript (flags on line.bbox)
            if (line.bbox?.flags && (line.bbox.flags & 1)) {
              superscriptChars += charLen;
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

        // Determine region
        const yPct = y / pageHeight;
        const textLen = combinedText.length;
        let region = 'body';

        if (yPct < 0.05 && textLen < 150 && lineCount <= 3) {
          region = 'header';
        } else if (yPct < 0.08 && textLen < 80 && lineCount <= 2) {
          region = 'header';
        } else if (yPct > 0.92 || (yPct > 0.88 && textLen < 50)) {
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
          line_count: lineCount,
        });
      }
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

      const catId = this.hashId(catType).substring(0, 8);
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
   * Classify a block into a semantic category
   */
  private classifyBlock(block: TextBlock, bodySize: number): string {
    if (block.is_image) return 'image';
    if (block.is_superscript) return 'footnote_ref';

    // Very small isolated text might be footnote refs
    if (block.font_size < bodySize * 0.7 && block.char_count < 5) {
      return 'footnote_ref';
    }

    if (block.region === 'header') return 'header';
    if (block.region === 'footer') return 'footer';

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

  /**
   * Render a page as PNG (base64)
   */
  async renderPage(pageNum: number, scale: number = 2.0, pdfPath?: string): Promise<string> {
    const mupdfLib = await getMupdf();
    let doc = this.doc;
    let needsClose = false;

    // If pdfPath provided, open it (for stateless calls)
    if (pdfPath) {
      const data = fs.readFileSync(pdfPath);
      const mimeType = getMimeType(pdfPath);
      doc = mupdfLib.Document.openDocument(data, mimeType);
      needsClose = true;
    }

    if (!doc) {
      throw new Error('No document loaded');
    }

    try {
      const page = doc.loadPage(pageNum);
      const matrix = mupdfLib.Matrix.scale(scale, scale);
      const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false);
      const pngData = pixmap.asPNG();

      // Convert Uint8Array to base64
      const base64 = Buffer.from(pngData).toString('base64');
      return base64;
    } finally {
      if (needsClose && doc) {
        // doc.destroy() if needed
      }
    }
  }

  /**
   * Export text from enabled categories
   */
  exportText(enabledCategories: string[]): ExportTextResult {
    const enabledSet = new Set(enabledCategories);
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
   */
  async exportPdf(pdfPath: string, deletedRegions: DeletedRegion[]): Promise<string> {
    const mupdfLib = await getMupdf();
    const data = fs.readFileSync(pdfPath);
    const mimeType = getMimeType(pdfPath);
    const doc = mupdfLib.Document.openDocument(data, mimeType);
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      throw new Error('Source must be a PDF file for PDF export with redactions');
    }

    // Group regions by page
    const regionsByPage = new Map<number, DeletedRegion[]>();
    for (const region of deletedRegions) {
      if (!regionsByPage.has(region.page)) {
        regionsByPage.set(region.page, []);
      }
      regionsByPage.get(region.page)!.push(region);
    }

    // Process each page with deleted regions
    for (const [pageNum, regions] of regionsByPage) {
      if (pageNum >= pdfDoc.countPages()) continue;

      const page = pdfDoc.loadPage(pageNum) as any; // PDFPage type

      for (const region of regions) {
        // Create redaction annotation
        const rect: [number, number, number, number] = [
          region.x,
          region.y,
          region.x + region.width,
          region.y + region.height,
        ];

        const annot = page.createAnnotation('Redact');
        annot.setRect(rect);
        annot.setColor([1, 1, 1]); // White fill
      }

      // Apply all redactions on this page
      page.applyRedactions(true);
    }

    // Save to buffer
    const buffer = pdfDoc.saveToBuffer('compress');
    const base64 = Buffer.from(buffer.asUint8Array()).toString('base64');

    return base64;
  }

  /**
   * Close the document
   */
  close(): void {
    this.doc = null;
    this.blocks = [];
    this.categories = {};
    this.pageDimensions = [];
  }

  /**
   * Generate a short hash ID
   */
  private hashId(input: string): string {
    return crypto.createHash('md5').update(input).digest('hex').substring(0, 12);
  }
}

// Singleton instance
export const pdfAnalyzer = new PDFAnalyzer();

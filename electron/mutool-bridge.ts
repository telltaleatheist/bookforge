/**
 * MuTool Bridge for BookForge
 * Uses bundled mutool binary for text extraction with character-level precision
 *
 * Provides:
 * - Character-level bounding boxes (superior to word/span level)
 * - Font name and size information
 * - Bold/italic detection via font name parsing
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getManagedBinaryPath } from './update/managed-bins';
// Lines and blocks are built by the ONE builder the Reader extension's PDF view
// also uses — see shared/pdf/text-blocks.ts. This file only reads mutool's XML.
import { PageBlockBuilder, type PdfTextBlock } from '../shared/pdf/text-blocks';

const execAsync = promisify(exec);

/**
 * Decode XML character entities (both named and numeric)
 */
function decodeXmlEntities(str: string): string {
  // First handle numeric character references: &#x2018; (hex) and &#8216; (decimal)
  str = str.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  str = str.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));

  // Then handle named entities
  const namedEntities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&nbsp;': '\u00A0',
  };

  for (const [entity, char] of Object.entries(namedEntities)) {
    str = str.split(entity).join(char);
  }

  return str;
}

export interface MutoolTextBlock {
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
  is_footnote_marker: boolean;
  line_count: number;
}

export interface MutoolTextSpan {
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

interface PageDimension {
  width: number;
  height: number;
  originX?: number;  // Page origin X offset (for non-zero MediaBox)
  originY?: number;  // Page origin Y offset (for non-zero MediaBox)
}

interface CharInfo {
  char: string;
  x: number;
  y: number;
  x2: number;
  y2: number;
}

interface SpanData {
  page: number;
  fontName: string;
  fontSize: number;
  chars: CharInfo[];
}

interface LineData {
  spans: SpanData[];
  y: number;
  height: number;
  x: number;
  width: number;
}

interface BlockData {
  page: number;
  lines: LineData[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * MutoolBridge - Wrapper for bundled mutool binary
 * Uses ONLY bundled binaries, never system PATH
 */
export class MutoolBridge {
  private mutoolPath: string | null = null;

  /**
   * Check if mutool is available (bundled binary only)
   */
  async isAvailable(): Promise<boolean> {
    try {
      const binPath = await this.findMutoolPath();
      return binPath !== null;
    } catch {
      return false;
    }
  }

  /**
   * Find bundled mutool binary path
   * ONLY uses bundled binaries from resources/bin - never system PATH
   */
  async findMutoolPath(): Promise<string | null> {
    if (this.mutoolPath) {
      return this.mutoolPath;
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const isWin = process.platform === 'win32';

    // Determine resourcesPath - in production it's process.resourcesPath,
    // in development we need to construct it
    let resourcesPath = '';
    try {
      resourcesPath = (process as any).resourcesPath || '';
    } catch {
      resourcesPath = '';
    }

    const paths: string[] = [];

    // A managed (server-pushed, auto-updated) mutool, if installed, ranks above the bundled
    // resources/bin copy so binary updates we publish take effect. It still goes through the
    // same access + `-v` verification below, so a broken managed install falls back cleanly.
    const managed = getManagedBinaryPath('mutool');
    if (managed) {
      paths.push(managed);
    }

    if (isWin) {
      paths.push(
        // 1. Bundled with app (production)
        path.join(resourcesPath, 'bin', 'mutool.exe'),
        // 2. Development resources (from dist/electron, go up 2 levels to project root)
        path.join(__dirname, '..', '..', 'resources', 'bin', 'mutool.exe')
      );
    } else {
      paths.push(
        // 1. Bundled with app (production)
        path.join(resourcesPath, 'bin', `mutool-${arch}`),
        path.join(resourcesPath, 'bin', 'mutool'),
        // 2. Development (from dist/electron, go up 2 levels to project root)
        path.join(__dirname, '..', '..', 'resources', 'bin', `mutool-${arch}`),
        path.join(__dirname, '..', '..', 'resources', 'bin', 'mutool')
      );
    }

    for (const p of paths) {
      try {
        // On Windows, X_OK doesn't work properly - just check file exists
        const accessMode = isWin ? fs.constants.F_OK : fs.constants.X_OK;
        await fsPromises.access(p, accessMode);
        // Verify it runs
        await execAsync(`"${p}" -v`, { timeout: 5000 });
        this.mutoolPath = p;
        console.log(`[MuTool] Using bundled binary: ${p}`);
        return p;
      } catch (err) {
        console.log(`[MuTool] Not found or not executable: ${p}`, (err as Error).message);
        // Not found at this path, continue
      }
    }

    console.error('[MuTool] ERROR: mutool not found in bundled resources!');
    console.error('[MuTool] Run "npm run download:mupdf" to download/compile the binary');
    return null;
  }

  /**
   * Extract text blocks from PDF using mutool stext output
   */
  async extractBlocks(
    pdfPath: string,
    pageCount: number,
    pageDimensions: PageDimension[]
  ): Promise<MutoolTextBlock[]> {
    const binPath = await this.findMutoolPath();
    if (!binPath) {
      throw new Error('mutool not available');
    }

    console.log('[MuTool] Extracting blocks from PDF...');

    // Get raw structured text
    const rawData = await this.extractRawStext(binPath, pdfPath);

    // Parse into blocks
    const blocks = this.parseBlocksFromStext(rawData, pageDimensions);

    console.log(`[MuTool] Extracted ${blocks.length} blocks`);
    return blocks;
  }

  /**
   * Extract spans (character-level) from PDF
   */
  async extractSpans(
    pdfPath: string,
    pageCount: number,
    pageDimensions: PageDimension[]
  ): Promise<MutoolTextSpan[]> {
    const binPath = await this.findMutoolPath();
    if (!binPath) {
      throw new Error('mutool not available');
    }

    console.log('[MuTool] Extracting spans from PDF...');

    // Get raw structured text
    const rawData = await this.extractRawStext(binPath, pdfPath);

    // Parse into spans
    const spans = this.parseSpansFromStext(rawData, pageDimensions);

    console.log(`[MuTool] Extracted ${spans.length} spans`);
    return spans;
  }

  /**
   * Extract both blocks and spans in one pass (more efficient)
   */
  async extractAll(
    pdfPath: string,
    pageCount: number,
    pageDimensions: PageDimension[]
  ): Promise<{ blocks: MutoolTextBlock[]; spans: MutoolTextSpan[] }> {
    const binPath = await this.findMutoolPath();
    if (!binPath) {
      throw new Error('mutool not available');
    }

    console.log('[MuTool] Extracting blocks and spans from PDF...');
    // Log page dimensions from mupdf.js for comparison with mutool coordinates
    console.log('[MuTool] Page dimensions from mupdf.js:');
    for (let i = 0; i < Math.min(pageDimensions.length, 40); i++) {
      const dim = pageDimensions[i];
      const hasOrigin = (dim.originX && dim.originX !== 0) || (dim.originY && dim.originY !== 0);
      if (hasOrigin || i < 5) {
        console.log(`  Page ${i}: ${dim.width.toFixed(1)}x${dim.height.toFixed(1)}${hasOrigin ? `, origin=(${dim.originX}, ${dim.originY})` : ''}`);
      }
    }

    try {
      // Try single-pass extraction first (fastest for normal-sized PDFs)
      const rawData = await this.extractRawStext(binPath, pdfPath);
      const blocks = this.parseBlocksFromStext(rawData, pageDimensions);
      const spans = this.parseSpansFromStext(rawData, pageDimensions);
      console.log(`[MuTool] Extracted ${blocks.length} blocks, ${spans.length} spans`);
      return { blocks, spans };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('out of memory') || msg.includes('FT_New_Memory_Face') || msg.includes('ENOMEM')) {
        console.warn(`[MuTool] Single-pass extraction failed (OOM), falling back to batched extraction...`);
        return this.extractAllBatched(binPath, pdfPath, pageCount, pageDimensions);
      }
      throw err;
    }
  }

  /**
   * Batched extraction: process pages in chunks to avoid OOM on large/complex PDFs.
   * mutool supports page ranges as a positional arg (e.g. "1-50").
   */
  private async extractAllBatched(
    binPath: string,
    pdfPath: string,
    pageCount: number,
    pageDimensions: PageDimension[]
  ): Promise<{ blocks: MutoolTextBlock[]; spans: MutoolTextSpan[] }> {
    const BATCH_SIZE = 50;
    const batchCount = Math.ceil(pageCount / BATCH_SIZE);
    console.log(`[MuTool] Batched extraction: ${pageCount} pages in ${batchCount} batches of ${BATCH_SIZE}`);

    let allBlocks: MutoolTextBlock[] = [];
    let allSpans: MutoolTextSpan[] = [];

    for (let i = 0; i < batchCount; i++) {
      const startPage = i * BATCH_SIZE + 1; // mutool uses 1-based pages
      const endPage = Math.min((i + 1) * BATCH_SIZE, pageCount);
      const pageRange = `${startPage}-${endPage}`;

      console.log(`[MuTool] Batch ${i + 1}/${batchCount}: pages ${pageRange}`);

      const rawData = await this.extractRawStext(binPath, pdfPath, pageRange);
      const blocks = this.parseBlocksFromStext(rawData, pageDimensions);
      const spans = this.parseSpansFromStext(rawData, pageDimensions);

      allBlocks = allBlocks.concat(blocks);
      allSpans = allSpans.concat(spans);
    }

    console.log(`[MuTool] Batched extraction complete: ${allBlocks.length} blocks, ${allSpans.length} spans`);
    return { blocks: allBlocks, spans: allSpans };
  }

  /**
   * Run mutool and get raw stext XML output
   * @param pageRange Optional mutool page range (e.g. "1-50", "51-100")
   */
  private async extractRawStext(binPath: string, pdfPath: string, pageRange?: string): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), `bookforge-stext-${Date.now()}.xml`);

    try {
      const pageArg = pageRange ? ` ${pageRange}` : '';
      // 10 minute timeout for large documents (648 pages can take 5+ minutes)
      await execAsync(`"${binPath}" draw -F stext -o "${tmpFile}" "${pdfPath}"${pageArg}`, {
        maxBuffer: 200 * 1024 * 1024, // 200MB buffer for large docs
        timeout: 600000 // 10 minute timeout
      });

      const result = await fsPromises.readFile(tmpFile, 'utf-8');
      return result;
    } finally {
      // Cleanup temp file
      try {
        await fsPromises.unlink(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Get raw stext XML for a specific page (for debugging coordinate issues)
   * Returns the raw XML section for the specified page
   */
  async getRawStextForPage(pdfPath: string, pageNum: number): Promise<string> {
    const binPath = await this.findMutoolPath();
    if (!binPath) {
      throw new Error('mutool not available');
    }

    const rawData = await this.extractRawStext(binPath, pdfPath);

    // Extract just the page section from the XML
    const lines = rawData.split('\n');
    const result: string[] = [];
    let inTargetPage = false;
    let pageCount = -1;

    for (const line of lines) {
      const pageMatch = line.match(/<page id="page(\d+)"/);
      if (pageMatch) {
        pageCount = parseInt(pageMatch[1]) - 1;
        if (pageCount === pageNum) {
          inTargetPage = true;
          result.push(line);
        } else if (inTargetPage) {
          // We've moved past the target page
          break;
        }
        continue;
      }

      if (inTargetPage) {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  /**
   * Parse mutool stext XML into text blocks
   */
  private parseBlocksFromStext(xml: string, pageDimensions: PageDimension[]): MutoolTextBlock[] {
    const blocks: MutoolTextBlock[] = [];
    const lines = xml.split('\n');

    // Sanity counters: the char regex below REQUIRES a quad="..." attribute
    // (guaranteed by the bundled mutool, 1.27.0). If a future/managed mutool
    // build emits different geometry, the parse would silently yield ZERO text
    // — detect that and fail loudly instead.
    let rawCharCount = 0;
    let parsedCharCount = 0;

    // A font persists across lines, blocks and pages until the next <font>, as
    // the XML states it; each page's builder starts with the one in force.
    let fontName = '';
    let fontSize = 0;
    let builder: PageBlockBuilder | null = null;

    const flushPage = () => {
      if (!builder) return;
      for (const b of builder.finish()) blocks.push(this.toMutoolBlock(b));
      builder = null;
    };

    for (const line of lines) {
      const pageMatch = line.match(/<page id="page(\d+)"/);
      if (pageMatch) {
        flushPage();
        const page = parseInt(pageMatch[1]) - 1;
        builder = new PageBlockBuilder(page, pageDimensions[page] || { width: 612, height: 792, originX: 0, originY: 0 });
        builder.font(fontName, fontSize);
        continue;
      }
      if (!builder) continue;

      if (line.includes('<block ')) { builder.endBlock(); continue; }
      if (line.includes('<line ')) { builder.endLine(); continue; }

      const fontMatch = line.match(/<font name="([^"]*)" size="([^"]*)"/);
      if (fontMatch) {
        fontName = fontMatch[1];
        fontSize = parseFloat(fontMatch[2]);
        builder.font(fontName, fontSize);
        continue;
      }

      if (line.includes('<char ')) rawCharCount++;
      const charMatch = line.match(/<char quad="([^"]*)"[^>]*c="([^"]*)"/);
      if (charMatch) {
        const quad = charMatch[1].split(' ').map(parseFloat);
        if (quad.length >= 8) {
          parsedCharCount++;
          builder.char(decodeXmlEntities(charMatch[2]), quad);
        }
      }
    }
    flushPage();

    // Loud failure instead of silent zero text: chars exist in the raw stext
    // but none matched the quad-based regex — the mutool build in use emits a
    // geometry format this parser doesn't understand.
    if (rawCharCount > 0 && parsedCharCount === 0) {
      throw new Error(`[MuTool] stext parse mismatch: ${rawCharCount} <char> elements in mutool output but 0 parsed — expected quad="..." geometry attribute is missing (incompatible mutool build?)`);
    }

    return blocks;
  }

  /**
   * The app's block: the shared builder's block plus a persisted id.
   *
   * The id is hashed from the NEWLINE-JOINED form (`idText`), which is what this
   * block's text used to be. Block ids are persisted — manifest `deletedBlockIds`,
   * chapter `blockId`/`mergedBlockIds`, paragraph breaks, per-block text
   * corrections — so they must not shift when the join character changes.
   * Re-hashing on the space-joined text would silently orphan every edit a user
   * has already made to an existing project.
   */
  private toMutoolBlock(b: PdfTextBlock): MutoolTextBlock {
    const { idText, lines: _lines, ...rest } = b;
    return {
      ...rest,
      id: this.hashId(`${b.page}:${b.x.toFixed(0)},${b.y.toFixed(0)}:${idText.substring(0, 50)}`),
      category_id: '',
    };
  }

  /**
   * Parse mutool stext XML into spans (word/phrase level for practical use)
   */
  private parseSpansFromStext(xml: string, pageDimensions: PageDimension[]): MutoolTextSpan[] {
    const spans: MutoolTextSpan[] = [];
    const lines = xml.split('\n');

    // Same quad-attribute sanity check as parseBlocksFromStext — see comment there.
    let rawCharCount = 0;
    let parsedCharCount = 0;

    let currentPage = -1;
    let currentFontName = '';
    let currentFontSize = 0;
    let spanChars: CharInfo[] = [];
    let spanCount = 0;

    const flushSpan = () => {
      if (spanChars.length === 0) return;

      // Combine characters into span
      const text = spanChars.map(c => c.char).join('');
      if (!text.trim()) {
        spanChars = [];
        return;
      }

      // Get page origin offset (for non-zero MediaBox)
      const pageDim = pageDimensions[currentPage] || { width: 612, height: 792, originX: 0, originY: 0 };
      const originX = pageDim.originX || 0;
      const originY = pageDim.originY || 0;

      // Calculate raw bounding box (before origin offset)
      const rawX = Math.min(...spanChars.map(c => c.x));
      const rawY = Math.min(...spanChars.map(c => c.y));
      const rawX2 = Math.max(...spanChars.map(c => c.x2));
      const rawY2 = Math.max(...spanChars.map(c => c.y2));

      // Apply origin offset
      const x = rawX - originX;
      const y = rawY - originY;
      const x2 = rawX2 - originX;
      const y2 = rawY2 - originY;

      // Debug: log spans with unusual coordinates
      const yRatio = y / pageDim.height;
      // Log if Y ratio suggests possible coordinate flip (Y > 80% of page height for short text at "top")
      // or if x > 80% of page width for short text (potential margin notes in wrong position)
      const isUnusualX = x > pageDim.width * 0.8 && text.trim().length <= 3;
      const isUnusualY = yRatio > 0.9 && text.trim().length <= 5; // Text near bottom might be footer, but footnote numbers shouldn't be there
      if (isUnusualX || isUnusualY) {
        console.log(`[MuTool] Unusual span on page ${currentPage}: "${text.trim()}" raw=(${rawX.toFixed(1)}, ${rawY.toFixed(1)}) adjusted=(${x.toFixed(1)}, ${y.toFixed(1)}) yRatio=${yRatio.toFixed(3)} origin=(${originX}, ${originY}) pageDim=${pageDim.width}x${pageDim.height}`);
      }

      const fontLower = currentFontName.toLowerCase();
      const isBold = fontLower.includes('bold');
      const isItalic = fontLower.includes('italic') || fontLower.includes('oblique');

      const spanId = this.hashId(`span:${currentPage}:${x.toFixed(0)},${y.toFixed(0)}:${spanCount++}`);

      spans.push({
        id: spanId,
        page: currentPage,
        x,
        y,
        width: x2 - x,
        height: y2 - y,
        text,
        font_size: currentFontSize,
        font_name: currentFontName,
        is_bold: isBold,
        is_italic: isItalic,
        baseline_offset: 0,
        block_id: ''
      });

      spanChars = [];
    };

    for (const line of lines) {
      // Track page - also capture mutool's reported dimensions
      const pageMatch = line.match(/<page id="page(\d+)"[^>]*width="([^"]*)"[^>]*height="([^"]*)"/);
      if (pageMatch) {
        flushSpan();
        currentPage = parseInt(pageMatch[1]) - 1;
        // Compare mutool dimensions with mupdf.js dimensions
        const mutoolWidth = parseFloat(pageMatch[2]);
        const mutoolHeight = parseFloat(pageMatch[3]);
        const mupdfDim = pageDimensions[currentPage];
        if (mupdfDim && (Math.abs(mutoolWidth - mupdfDim.width) > 1 || Math.abs(mutoolHeight - mupdfDim.height) > 1)) {
          console.log(`[MuTool] WARNING: Page ${currentPage} dimension mismatch! mutool=${mutoolWidth}x${mutoolHeight}, mupdf.js=${mupdfDim.width}x${mupdfDim.height}`);
        }
        continue;
      }
      // Fallback: simpler page match without dimensions
      const simplePageMatch = line.match(/<page id="page(\d+)"/);
      if (simplePageMatch && !pageMatch) {
        flushSpan();
        currentPage = parseInt(simplePageMatch[1]) - 1;
        continue;
      }

      // Track font changes (start new span)
      const fontMatch = line.match(/<font name="([^"]*)" size="([^"]*)"/);
      if (fontMatch) {
        flushSpan();
        currentFontName = fontMatch[1];
        currentFontSize = parseFloat(fontMatch[2]);
        continue;
      }

      // End font section
      if (line.includes('</font>')) {
        flushSpan();
        continue;
      }

      // Parse character
      if (line.includes('<char ')) rawCharCount++;
      const charMatch = line.match(/<char quad="([^"]*)"[^>]*c="([^"]*)"/);
      if (charMatch) {
        const quad = charMatch[1].split(' ').map(parseFloat);
        const char = decodeXmlEntities(charMatch[2]);

        if (quad.length >= 8) {
          // Quad has 4 corners (8 values): compute proper bounding box from all points
          // This handles any quad orientation (rotated, skewed, etc.)
          const xCoords = [quad[0], quad[2], quad[4], quad[6]];
          const yCoords = [quad[1], quad[3], quad[5], quad[7]];
          parsedCharCount++;
          spanChars.push({
            char,
            x: Math.min(...xCoords),
            y: Math.min(...yCoords),
            x2: Math.max(...xCoords),
            y2: Math.max(...yCoords)
          });
        }
      }
    }

    // Flush final span
    flushSpan();

    // Loud failure instead of silent zero text (see parseBlocksFromStext)
    if (rawCharCount > 0 && parsedCharCount === 0) {
      throw new Error(`[MuTool] stext parse mismatch: ${rawCharCount} <char> elements in mutool output but 0 parsed — expected quad="..." geometry attribute is missing (incompatible mutool build?)`);
    }

    return spans;
  }

  /**
   * Generate a hash-based ID
   */
  private hashId(input: string): string {
    return crypto.createHash('md5').update(input).digest('hex').substring(0, 12);
  }
}

// Export singleton instance
export const mutoolBridge = new MutoolBridge();

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
        await fsPromises.access(p, fs.constants.X_OK);
        // Verify it runs
        await execAsync(`"${p}" -v`, { timeout: 5000 });
        this.mutoolPath = p;
        console.log(`[MuTool] Using bundled binary: ${p}`);
        return p;
      } catch {
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

    // Get raw structured text once
    const rawData = await this.extractRawStext(binPath, pdfPath);

    // Parse both
    const blocks = this.parseBlocksFromStext(rawData, pageDimensions);
    const spans = this.parseSpansFromStext(rawData, pageDimensions);

    console.log(`[MuTool] Extracted ${blocks.length} blocks, ${spans.length} spans`);
    return { blocks, spans };
  }

  /**
   * Run mutool and get raw stext XML output
   */
  private async extractRawStext(binPath: string, pdfPath: string): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), `bookforge-stext-${Date.now()}.xml`);

    try {
      await execAsync(`"${binPath}" draw -F stext -o "${tmpFile}" "${pdfPath}"`, {
        maxBuffer: 100 * 1024 * 1024, // 100MB buffer
        timeout: 120000 // 2 minute timeout
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

    let currentPage = -1;
    let currentBlockLines: Array<{
      text: string;
      fontName: string;
      fontSize: number;
      isBold: boolean;
      isItalic: boolean;
      y: number;
      height: number;
      x: number;
      width: number;
    }> = [];
    let blockStartX = Infinity;
    let blockStartY = Infinity;
    let blockEndX = 0;
    let blockEndY = 0;

    // Track current line data
    let lineText = '';
    let lineFontName = '';
    let lineFontSize = 0;
    let lineY = Infinity;  // Start at Infinity so first char sets the minimum
    let lineHeight = 0;
    let lineX = Infinity;
    let lineEndX = 0;
    let isBold = false;
    let isItalic = false;

    const flushLine = () => {
      if (lineText.trim()) {
        currentBlockLines.push({
          text: lineText,
          fontName: lineFontName,
          fontSize: lineFontSize,
          isBold,
          isItalic,
          y: lineY,
          height: lineHeight,
          x: lineX,
          width: lineEndX - lineX
        });

        blockStartX = Math.min(blockStartX, lineX);
        blockStartY = Math.min(blockStartY, lineY);
        blockEndX = Math.max(blockEndX, lineEndX);
        blockEndY = Math.max(blockEndY, lineY + lineHeight);
      }
      // Reset all line tracking variables for the next line
      lineText = '';
      lineX = Infinity;
      lineEndX = 0;
      lineY = Infinity;  // Reset to Infinity so first char sets the minimum
      lineHeight = 0;
    };

    const flushBlock = () => {
      if (currentBlockLines.length === 0) return;

      const pageDim = pageDimensions[currentPage] || { width: 612, height: 792, originX: 0, originY: 0 };
      const originX = pageDim.originX || 0;
      const originY = pageDim.originY || 0;

      // Apply origin offset to block coordinates
      const adjustedStartX = blockStartX - originX;
      const adjustedStartY = blockStartY - originY;
      const adjustedEndX = blockEndX - originX;
      const adjustedEndY = blockEndY - originY;

      // Combine text
      const text = currentBlockLines.map(l => l.text).join('\n');

      // Find dominant font
      const fontCounts = new Map<string, number>();
      const sizeCounts = new Map<number, number>();
      let totalBold = 0;
      let totalItalic = 0;
      let totalChars = 0;

      for (const line of currentBlockLines) {
        const len = line.text.length;
        totalChars += len;
        fontCounts.set(line.fontName, (fontCounts.get(line.fontName) || 0) + len);
        sizeCounts.set(line.fontSize, (sizeCounts.get(line.fontSize) || 0) + len);
        if (line.isBold) totalBold += len;
        if (line.isItalic) totalItalic += len;
      }

      const dominantFont = [...fontCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
      const dominantSize = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

      // Determine region (use adjusted Y for percentage calculation)
      const yPct = adjustedStartY / pageDim.height;
      let region = 'body';
      const trimmedText = text.trim();
      const textLen = trimmedText.length;

      const looksLikePageNum = textLen <= 5 && /^\d+$/.test(trimmedText);
      const startsWithPageNum = /^\d{1,4}\s+\S/.test(trimmedText);
      const endsWithPageNum = /\S\s+\d{1,4}$/.test(trimmedText);
      const hasPageNumPattern = looksLikePageNum || startsWithPageNum || endsWithPageNum;

      const looksLikeBodyText = textLen > 100 ||
        /[.!?]["']?\s+[A-Z]/.test(trimmedText) ||
        (trimmedText.endsWith('.') && textLen > 60);

      if (yPct < 0.04 && (hasPageNumPattern || textLen < 80) && currentBlockLines.length <= 2) {
        region = 'header';
      } else if (yPct < 0.06 && !looksLikeBodyText && currentBlockLines.length <= 2 && textLen < 120) {
        region = 'header';
      } else if (yPct < 0.08 && hasPageNumPattern && !looksLikeBodyText) {
        region = 'header';
      } else if (yPct > 0.92 || (yPct > 0.88 && textLen < 50)) {
        region = 'footer';
      } else if (yPct > 0.70) {
        region = 'lower';
      }

      // Use same ID format as mupdf.js extractPageBlocks for backwards compatibility
      const blockId = this.hashId(`${currentPage}:${adjustedStartX.toFixed(0)},${adjustedStartY.toFixed(0)}:${text.substring(0, 50)}`);

      blocks.push({
        id: blockId,
        page: currentPage,
        x: adjustedStartX,
        y: adjustedStartY,
        width: adjustedEndX - adjustedStartX,
        height: adjustedEndY - adjustedStartY,
        text,
        font_size: dominantSize,
        font_name: dominantFont,
        char_count: text.length,
        region,
        category_id: '',
        is_bold: totalBold > totalChars / 2,
        is_italic: totalItalic > totalChars / 2,
        is_superscript: false,
        is_image: false,
        is_footnote_marker: false,
        line_count: currentBlockLines.length
      });

      // Reset
      currentBlockLines = [];
      blockStartX = Infinity;
      blockStartY = Infinity;
      blockEndX = 0;
      blockEndY = 0;
    };

    for (const line of lines) {
      // Track page
      const pageMatch = line.match(/<page id="page(\d+)"/);
      if (pageMatch) {
        flushLine();
        flushBlock();
        currentPage = parseInt(pageMatch[1]) - 1;
        continue;
      }

      // Track blocks
      if (line.includes('<block ')) {
        flushLine();
        flushBlock();
        continue;
      }

      // Track lines
      if (line.includes('<line ')) {
        flushLine();
        continue;
      }

      // Track font
      const fontMatch = line.match(/<font name="([^"]*)" size="([^"]*)"/);
      if (fontMatch) {
        lineFontName = fontMatch[1];
        lineFontSize = parseFloat(fontMatch[2]);
        const fontLower = lineFontName.toLowerCase();
        isBold = fontLower.includes('bold');
        isItalic = fontLower.includes('italic') || fontLower.includes('oblique');
        continue;
      }

      // Parse character
      const charMatch = line.match(/<char quad="([^"]*)"[^>]*c="([^"]*)"/);
      if (charMatch) {
        const quad = charMatch[1].split(' ').map(parseFloat);
        const char = decodeXmlEntities(charMatch[2]);

        if (quad.length >= 8) {
          // Quad has 4 corners (8 values): compute proper bounding box from all points
          const xCoords = [quad[0], quad[2], quad[4], quad[6]];
          const yCoords = [quad[1], quad[3], quad[5], quad[7]];
          const x = Math.min(...xCoords);
          const y = Math.min(...yCoords);
          const x2 = Math.max(...xCoords);
          const y2 = Math.max(...yCoords);

          lineText += char;
          lineX = Math.min(lineX, x);
          lineEndX = Math.max(lineEndX, x2);
          lineY = Math.min(lineY, y);  // Track minimum Y (top of line)
          lineHeight = Math.max(lineHeight, y2 - y);
        }
      }
    }

    // Flush final data
    flushLine();
    flushBlock();

    return blocks;
  }

  /**
   * Parse mutool stext XML into spans (word/phrase level for practical use)
   */
  private parseSpansFromStext(xml: string, pageDimensions: PageDimension[]): MutoolTextSpan[] {
    const spans: MutoolTextSpan[] = [];
    const lines = xml.split('\n');

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
      const charMatch = line.match(/<char quad="([^"]*)"[^>]*c="([^"]*)"/);
      if (charMatch) {
        const quad = charMatch[1].split(' ').map(parseFloat);
        const char = decodeXmlEntities(charMatch[2]);

        if (quad.length >= 8) {
          // Quad has 4 corners (8 values): compute proper bounding box from all points
          // This handles any quad orientation (rotated, skewed, etc.)
          const xCoords = [quad[0], quad[2], quad[4], quad[6]];
          const yCoords = [quad[1], quad[3], quad[5], quad[7]];
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

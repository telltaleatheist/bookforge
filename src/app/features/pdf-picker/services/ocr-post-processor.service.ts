/**
 * OCR Post-Processor Service
 *
 * Processes raw OCR output (line-by-line text) and transforms it into
 * properly structured paragraphs with smart categorization.
 *
 * Features:
 * - Merges adjacent lines into paragraphs using content-aware logic
 * - Detects titles, headings, epigraphs, attributions, captions
 * - Estimates font sizes for categorization
 */

import { Injectable } from '@angular/core';
import { TextBlock, Category, PageDimension } from './pdf.service';
import { LayoutBlock, LayoutLabel } from '../components/ocr-settings-modal/ocr-settings-modal.component';

export interface ProcessedOcrResult {
  blocks: TextBlock[];
  categories: Record<string, Category>;
}

// Map Surya layout labels to our category system (using actual Surya output format)
const SURYA_LABEL_TO_CATEGORY: Record<LayoutLabel, string> = {
  'Title': 'ocr_title',
  'SectionHeader': 'ocr_heading',
  'Text': 'ocr_body',
  'Handwriting': 'ocr_body',
  'TextInlineMath': 'ocr_body',
  'ListItem': 'ocr_body',
  'Form': 'ocr_body',
  'Caption': 'ocr_caption',
  'Footnote': 'ocr_footer',  // Footnotes go to footer category
  'PageFooter': 'ocr_footer',
  'PageHeader': 'ocr_header',
  'Formula': 'ocr_epigraph',  // Math formulas as epigraph (indented/special)
  'Table': 'ocr_body',  // Tables as body text
  'Figure': 'ocr_body',  // Figure placeholders
  'Picture': 'ocr_body',  // Picture placeholders
  'TableOfContents': 'ocr_body',  // TOC as body text
};

interface LineBlock {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  centerX: number;  // Center X position for alignment detection
}

@Injectable({
  providedIn: 'root'
})
export class OcrPostProcessorService {

  // Category definitions
  private readonly CATEGORIES: Record<string, Omit<Category, 'block_count' | 'char_count'>> = {
    'ocr_title': {
      id: 'ocr_title',
      name: 'Title',
      description: 'Chapter titles and main headings',
      color: '#e91e63',  // Pink
      font_size: 24,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'ocr_heading': {
      id: 'ocr_heading',
      name: 'Heading',
      description: 'Section headings and subheadings',
      color: '#9c27b0',  // Purple
      font_size: 18,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'ocr_epigraph': {
      id: 'ocr_epigraph',
      name: 'Epigraph',
      description: 'Quotations and epigraphs',
      color: '#00bcd4',  // Cyan
      font_size: 14,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'ocr_attribution': {
      id: 'ocr_attribution',
      name: 'Attribution',
      description: 'Quote attributions and citations',
      color: '#607d8b',  // Blue grey
      font_size: 12,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'ocr_body': {
      id: 'ocr_body',
      name: 'Body Text',
      description: 'Main body text content',
      color: '#8bc34a',  // Light green
      font_size: 12,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'ocr_caption': {
      id: 'ocr_caption',
      name: 'Caption',
      description: 'Image captions and figure descriptions',
      color: '#ff9800',  // Orange
      font_size: 10,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'ocr_header': {
      id: 'ocr_header',
      name: 'Header',
      description: 'Page headers and running heads',
      color: '#795548',  // Brown
      font_size: 10,
      region: 'header',
      sample_text: '',
      enabled: false  // Disabled by default
    },
    'ocr_footer': {
      id: 'ocr_footer',
      name: 'Footer',
      description: 'Page footers and page numbers',
      color: '#9e9e9e',  // Grey
      font_size: 10,
      region: 'footer',
      sample_text: '',
      enabled: false  // Disabled by default
    }
  };

  /**
   * Process raw OCR blocks (line-by-line) into structured paragraphs with categories
   * If layoutBlocks are provided (from Surya), use them for categorization instead of heuristics
   */
  processOcrBlocks(
    rawBlocks: TextBlock[],
    pageDimensions: PageDimension[],
    layoutBlocksByPage?: Map<number, LayoutBlock[]>
  ): ProcessedOcrResult {
    const hasLayoutData = layoutBlocksByPage && layoutBlocksByPage.size > 0;
    console.log(`[OCR Post-Processor] Processing ${rawBlocks.length} raw blocks (layout detection: ${hasLayoutData ? 'enabled' : 'disabled'})`);

    if (rawBlocks.length === 0) {
      return { blocks: [], categories: {} };
    }

    // Group blocks by page
    const blocksByPage = new Map<number, TextBlock[]>();
    for (const block of rawBlocks) {
      if (!blocksByPage.has(block.page)) {
        blocksByPage.set(block.page, []);
      }
      blocksByPage.get(block.page)!.push(block);
    }

    // Process each page
    const processedBlocks: TextBlock[] = [];
    const categoryCounts: Record<string, { blocks: number; chars: number }> = {};

    for (const [pageNum, pageBlocks] of blocksByPage) {
      const dims = pageDimensions[pageNum] || { width: 600, height: 800 };
      const pageLayoutBlocks = layoutBlocksByPage?.get(pageNum);
      const processed = this.processPage(pageBlocks, dims, pageNum, pageLayoutBlocks);

      for (const block of processed) {
        processedBlocks.push(block);

        // Track category counts
        if (!categoryCounts[block.category_id]) {
          categoryCounts[block.category_id] = { blocks: 0, chars: 0 };
        }
        categoryCounts[block.category_id].blocks++;
        categoryCounts[block.category_id].chars += block.char_count;
      }
    }

    // Build categories object with counts and sample text
    const categories: Record<string, Category> = {};
    for (const [catId, counts] of Object.entries(categoryCounts)) {
      const baseCat = this.CATEGORIES[catId];
      if (baseCat) {
        // Find sample text from first block of this category
        const sampleBlock = processedBlocks.find(b => b.category_id === catId);
        const sampleText = sampleBlock?.text.substring(0, 100) || '';

        categories[catId] = {
          ...baseCat,
          block_count: counts.blocks,
          char_count: counts.chars,
          sample_text: sampleText
        };
      }
    }

    return { blocks: processedBlocks, categories };
  }

  /**
   * Process blocks on a single page
   */
  private processPage(
    blocks: TextBlock[],
    dims: PageDimension,
    pageNum: number,
    layoutBlocks?: LayoutBlock[]
  ): TextBlock[] {
    if (blocks.length === 0) return [];

    // Sort blocks by Y position (top to bottom)
    const sorted = [...blocks].sort((a, b) => a.y - b.y);

    // Convert to LineBlocks for easier processing
    const lines: LineBlock[] = sorted.map(b => ({
      id: b.id,
      page: b.page,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      text: b.text,
      fontSize: b.font_size,
      centerX: b.x + b.width / 2
    }));

    // Calculate page metrics
    const pageWidth = dims.width;
    const pageHeight = dims.height;
    const pageCenterX = pageWidth / 2;

    // Calculate average font size for body text detection
    const fontSizes = lines.map(l => l.fontSize).filter(s => s > 0);
    const avgFontSize = fontSizes.length > 0
      ? fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length
      : 12;

    // Calculate median line-to-line distance (more robust than average)
    const lineDistances: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const dist = lines[i].y - lines[i-1].y;
      if (dist > 0 && dist < avgFontSize * 4) {
        lineDistances.push(dist);
      }
    }
    lineDistances.sort((a, b) => a - b);
    const medianLineHeight = lineDistances.length > 0
      ? lineDistances[Math.floor(lineDistances.length / 2)]
      : avgFontSize * 1.5;

    console.log(`[OCR PostProc] Page ${pageNum}: ${lines.length} lines, avgFontSize=${avgFontSize.toFixed(1)}, medianLineHeight=${medianLineHeight.toFixed(1)}`);

    // First pass: merge lines into paragraphs (content-aware)
    const mergedLines = this.mergeLines(lines, medianLineHeight, pageWidth);

    // Second pass: categorize merged blocks
    // If we have layout data from Surya, use it; otherwise fall back to heuristics
    const categorizedBlocks = mergedLines.map(merged => {
      let category: string;

      if (layoutBlocks && layoutBlocks.length > 0) {
        // Use layout detection to find the category
        category = this.categorizeBlockWithLayout(merged, layoutBlocks);
      } else {
        // Fall back to heuristic-based categorization
        category = this.categorizeBlock(merged, dims, pageCenterX, avgFontSize);
      }

      return { ...merged, category };
    });

    // Convert back to TextBlock format
    let blockIdCounter = Date.now();
    return categorizedBlocks.map(merged => ({
      id: `ocr_proc_${blockIdCounter++}`,
      page: pageNum,
      x: merged.x,
      y: merged.y,
      width: merged.width,
      height: merged.height,
      text: merged.text,
      font_size: merged.fontSize,
      font_name: 'OCR',
      char_count: merged.text.length,
      region: this.CATEGORIES[merged.category]?.region || 'body',
      category_id: merged.category,
      is_ocr: true,
      line_count: merged.lineCount
    }));
  }

  /**
   * Categorize a merged block based on position, size, and content
   */
  private categorizeBlock(
    block: { x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number },
    dims: PageDimension,
    pageCenterX: number,
    avgFontSize: number
  ): string {
    const text = block.text.trim();
    const yPercent = block.y / dims.height;
    const blockCenterX = block.x + block.width / 2;

    // Calculate centering
    const isCentered = Math.abs(blockCenterX - pageCenterX) < dims.width * 0.15;

    // Check for ALL CAPS
    const letters = text.replace(/[^a-zA-Z]/g, '');
    const isAllCaps = letters.length > 3 && letters === letters.toUpperCase();

    // Check font size relative to average
    const isLargeFontSize = block.fontSize > avgFontSize * 1.15;
    const isSmallFontSize = block.fontSize < avgFontSize * 0.8;

    // Check if it starts with an attribution marker
    const startsWithEmDash = /^[\u2014\u2013\u2012-]/.test(text);

    // Line/character counts
    const isShort = text.length < 80;
    const isVeryShort = text.length < 30;
    const isSingleLine = block.lineCount === 1;

    // Header: top 6% of page, single very short line (like page numbers or running headers)
    // Must be very short to avoid catching real content
    if (yPercent < 0.06 && isSingleLine && isVeryShort) {
      return 'ocr_header';
    }

    // Footer: bottom 6% of page, single very short line (like page numbers)
    // Must look like a page number or very short footer text
    // Be very strict - only match things like "42" or "Page 42" or "— 42 —"
    const looksLikePageNumber = /^[\d\u2014\u2013\-\s—]+$/.test(text) ||
                                /^page\s*\d+$/i.test(text) ||
                                text.length < 15;
    if (yPercent > 0.94 && isSingleLine && looksLikePageNumber) {
      return 'ocr_footer';
    }

    // Pure attribution line: starts with em-dash (like "— Author Name")
    if (startsWithEmDash && isShort && isSingleLine) {
      return 'ocr_attribution';
    }

    // Chapter number: very short, near top, just a number or Roman numeral
    if (isVeryShort && yPercent < 0.2 && /^[\dIVXLCDM]+\.?$/.test(text) && isSingleLine) {
      return 'ocr_title';
    }

    // Title: ALL CAPS, upper portion of page, relatively short
    if (isAllCaps && yPercent < 0.35 && isShort) {
      return 'ocr_title';
    }

    // Title: Large font, short text, near top
    if (isLargeFontSize && isShort && yPercent < 0.4 && isSingleLine) {
      return 'ocr_title';
    }

    // Heading: ALL CAPS, not at top of page, short, single line
    if (isAllCaps && isShort && yPercent >= 0.35 && isSingleLine) {
      return 'ocr_heading';
    }

    // NOTE: Caption detection removed - it was too aggressive and miscategorizing body text.
    // Captions (text under images) would need image detection to work properly.

    // Default: body text (this is the safest category)
    return 'ocr_body';
  }

  /**
   * Categorize a block using Surya layout detection results
   * Finds the layout block that best overlaps with the merged text block
   */
  private categorizeBlockWithLayout(
    block: { x: number; y: number; width: number; height: number },
    layoutBlocks: LayoutBlock[]
  ): string {
    if (layoutBlocks.length === 0) {
      return 'ocr_body';
    }

    // Find the layout block with the best overlap
    let bestMatch: LayoutBlock | null = null;
    let bestOverlap = 0;

    const blockArea = block.width * block.height;
    const blockBox: [number, number, number, number] = [block.x, block.y, block.x + block.width, block.y + block.height];

    for (const layout of layoutBlocks) {
      const overlap = this.calculateOverlap(blockBox, layout.bbox);

      // Calculate overlap percentage relative to the text block
      const overlapPercent = blockArea > 0 ? overlap / blockArea : 0;

      if (overlapPercent > bestOverlap) {
        bestOverlap = overlapPercent;
        bestMatch = layout;
      }
    }

    // Debug: log the matching attempt
    console.log(`[OCR Layout] Block at (${block.x.toFixed(1)}, ${block.y.toFixed(1)}) ${block.width.toFixed(1)}x${block.height.toFixed(1)} - ` +
      `Best match: ${bestMatch?.label || 'none'} (${(bestOverlap * 100).toFixed(1)}% overlap)`);

    // Require at least 30% overlap to use the layout category
    if (bestMatch && bestOverlap > 0.3) {
      const category = SURYA_LABEL_TO_CATEGORY[bestMatch.label];
      if (category) {
        return category;
      }
    }

    // No good match found - default to body
    return 'ocr_body';
  }

  /**
   * Calculate the area of overlap between two bounding boxes
   */
  private calculateOverlap(
    boxA: [number, number, number, number],  // [x1, y1, x2, y2]
    boxB: [number, number, number, number]
  ): number {
    const xOverlap = Math.max(0, Math.min(boxA[2], boxB[2]) - Math.max(boxA[0], boxB[0]));
    const yOverlap = Math.max(0, Math.min(boxA[3], boxB[3]) - Math.max(boxA[1], boxB[1]));
    return xOverlap * yOverlap;
  }

  /**
   * Merge adjacent lines into paragraphs using content-aware logic
   */
  private mergeLines(
    lines: LineBlock[],
    medianLineHeight: number,
    pageWidth: number
  ): Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontSize: number;
    lineCount: number;
  }> {
    if (lines.length === 0) return [];

    const result: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      fontSize: number;
      lineCount: number;
      lines: LineBlock[];
    }> = [];

    let currentGroup: LineBlock[] = [lines[0]];

    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1];
      const curr = lines[i];

      const shouldMerge = this.shouldMergeLines(prev, curr, medianLineHeight, pageWidth, currentGroup);

      if (shouldMerge) {
        currentGroup.push(curr);
      } else {
        result.push(this.finalizeGroup(currentGroup));
        currentGroup = [curr];
      }
    }

    // Don't forget the last group
    if (currentGroup.length > 0) {
      result.push(this.finalizeGroup(currentGroup));
    }

    console.log(`[OCR PostProc] Merged ${lines.length} lines → ${result.length} blocks`);

    return result;
  }

  /**
   * Determine if two lines should be merged using content-aware logic
   */
  private shouldMergeLines(
    prev: LineBlock,
    curr: LineBlock,
    medianLineHeight: number,
    pageWidth: number,
    currentGroup: LineBlock[]
  ): boolean {
    const prevText = prev.text.trim();
    const currText = curr.text.trim();

    // === CONTENT-BASED CHECKS (most reliable) ===

    // Check if previous line ends with sentence-ending punctuation
    const endsWithSentencePunct = /[.!?:;][\s"'\u201d\u2019]*$/.test(prevText);

    // Check if current line starts with lowercase (continuation)
    const startsWithLowercase = /^[a-z]/.test(currText);

    // Check if current line starts with attribution marker (should NOT merge)
    const currStartsWithAttribution = /^[\u2014\u2013\u2012-]/.test(currText);
    if (currStartsWithAttribution) {
      return false;  // Attribution starts a new block
    }

    // Check if previous line ends with hyphenation (word broken across lines)
    const endsWithHyphen = /[a-zA-Z]-$/.test(prevText);
    if (endsWithHyphen) {
      return true;  // Always merge hyphenated words
    }

    // Strong signal: prev doesn't end sentence AND curr starts lowercase = merge
    if (!endsWithSentencePunct && startsWithLowercase) {
      return true;  // This is almost certainly a continuation
    }

    // === SPATIAL CHECKS ===

    // Calculate vertical distance
    const lineToLineDistance = curr.y - prev.y;

    // Be very permissive with distance - allow up to 2.5x median line height
    const maxLineDistance = medianLineHeight * 2.5;

    if (lineToLineDistance > maxLineDistance) {
      return false;  // Too far apart - definitely separate paragraphs
    }

    if (lineToLineDistance <= 0) {
      return false;  // Overlapping or same line - don't merge
    }

    // Check for significant indent (new paragraph indicator)
    // Only consider it a new paragraph if indented AND previous ended a sentence
    const firstLineX = currentGroup[0].x;
    const significantIndent = curr.x > firstLineX + medianLineHeight * 2;

    if (significantIndent && endsWithSentencePunct) {
      return false;  // Indented after sentence = new paragraph
    }

    // === PARAGRAPH BREAK DETECTION ===

    // Check if there's extra vertical space (more than 1.3x normal)
    const hasExtraSpace = lineToLineDistance > medianLineHeight * 1.3;

    // Check if previous line was short (potential end of paragraph)
    // Use page width to determine what "short" means
    const prevIsShort = prev.width < pageWidth * 0.5;

    // Only break if: previous was short AND ended sentence AND there's extra space
    if (prevIsShort && endsWithSentencePunct && hasExtraSpace) {
      return false;  // This looks like end of paragraph
    }

    // Default: merge lines that are reasonably close together
    return lineToLineDistance <= medianLineHeight * 1.8;
  }

  /**
   * Finalize a group of lines into a single merged block
   */
  private finalizeGroup(lines: LineBlock[]): {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    fontSize: number;
    lineCount: number;
    lines: LineBlock[];
  } {
    // Calculate bounding box
    const minX = Math.min(...lines.map(l => l.x));
    const minY = Math.min(...lines.map(l => l.y));
    const maxX = Math.max(...lines.map(l => l.x + l.width));
    const maxY = Math.max(...lines.map(l => l.y + l.height));

    // Combine text intelligently
    let text = '';
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i].text.trim();

      if (i === 0) {
        text = lineText;
      } else {
        // Check if previous line ended with hyphen (word broken across lines)
        if (text.endsWith('-')) {
          // Remove hyphen and join directly
          text = text.slice(0, -1) + lineText;
        } else {
          // Join with space
          text += ' ' + lineText;
        }
      }
    }

    // Use average font size
    const fontSizes = lines.map(l => l.fontSize);
    const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      text,
      fontSize: Math.round(avgFontSize),
      lineCount: lines.length,
      lines
    };
  }
}

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
  'Title': 'title',
  'SectionHeader': 'heading',
  'Text': 'body',
  'Handwriting': 'body',
  'TextInlineMath': 'body',
  'ListItem': 'body',
  'Form': 'body',
  'Caption': 'caption',
  'Footnote': 'footnote',
  'PageFooter': 'footer',
  'PageHeader': 'header',
  'Formula': 'quote',  // Math formulas as quote (indented/special)
  'Table': 'body',  // Tables as body text
  'Figure': 'body',  // Figure placeholders
  'Picture': 'body',  // Picture placeholders
  'TableOfContents': 'body',  // TOC as body text
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

/** Cross-page context computed in Pass 1, consumed by per-page Pass 2. */
interface GlobalContext {
  /** Mode font size across ALL pages — immune to title-page skew. */
  globalBodySize: number;
  /** Normalized text strings that repeat on 3+ pages at fixed Y positions. */
  repeatingTexts: Set<string>;
}

@Injectable({
  providedIn: 'root'
})
export class OcrPostProcessorService {

  // Category definitions - IDs match native PDF analyzer for consistency
  private readonly CATEGORIES: Record<string, Omit<Category, 'block_count' | 'char_count'>> = {
    'title': {
      id: 'title',
      name: 'Titles',
      description: 'Chapter titles and main headings',
      color: '#e91e63',  // Pink
      font_size: 24,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'heading': {
      id: 'heading',
      name: 'Section Headings',
      description: 'Section headings and subheadings',
      color: '#9c27b0',  // Purple
      font_size: 18,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'quote': {
      id: 'quote',
      name: 'Block Quotes',
      description: 'Quotations and epigraphs',
      color: '#00bcd4',  // Cyan
      font_size: 14,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'footnote': {
      id: 'footnote',
      name: 'Footnotes',
      description: 'Footnotes and citations',
      color: '#607d8b',  // Blue grey
      font_size: 12,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'body': {
      id: 'body',
      name: 'Body Text',
      description: 'Main body text content',
      color: '#8bc34a',  // Light green
      font_size: 12,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'caption': {
      id: 'caption',
      name: 'Captions',
      description: 'Image captions and figure descriptions',
      color: '#ff9800',  // Orange
      font_size: 10,
      region: 'body',
      sample_text: '',
      enabled: true
    },
    'header': {
      id: 'header',
      name: 'Page Headers',
      description: 'Page headers and running heads',
      color: '#795548',  // Brown
      font_size: 10,
      region: 'header',
      sample_text: '',
      enabled: false  // Disabled by default
    },
    'footer': {
      id: 'footer',
      name: 'Page Footers',
      description: 'Page footers and page numbers',
      color: '#9e9e9e',  // Grey
      font_size: 10,
      region: 'footer',
      sample_text: '',
      enabled: false  // Disabled by default
    }
  };

  /**
   * Process raw OCR blocks (line-by-line) into structured paragraphs with categories.
   *
   * Two-pass architecture:
   *   Pass 1 (global): Compute global body font size across all pages, detect
   *     cross-page repeating text at fixed Y positions (running headers/footers).
   *   Pass 2 (per-page): Merge lines into paragraphs and classify using global context.
   *
   * If layoutBlocks are provided (from Surya), use them for categorization instead of heuristics.
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

    // ── Pass 1: Global analysis ──────────────────────────────────────────
    const globalContext = this.buildGlobalContext(blocksByPage, pageDimensions);

    // ── Pass 2: Per-page processing ──────────────────────────────────────
    const processedBlocks: TextBlock[] = [];
    const categoryCounts: Record<string, { blocks: number; chars: number }> = {};

    for (const [pageNum, pageBlocks] of blocksByPage) {
      const dims = pageDimensions[pageNum] || { width: 600, height: 800 };
      const pageLayoutBlocks = layoutBlocksByPage?.get(pageNum);
      const processed = this.processPage(pageBlocks, dims, pageNum, pageLayoutBlocks, globalContext);

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
   * Pass 1: Build global context across all pages.
   *
   * 1. Global body font size — mode across all pages, so title pages with
   *    oversized text don't skew per-page body size estimation.
   * 2. Cross-page repeating text — text that appears at a similar Y position
   *    (within 2% of page height) on 3+ pages is a running header or footer.
   *    This is the single strongest signal for header/footer detection.
   */
  private buildGlobalContext(
    blocksByPage: Map<number, TextBlock[]>,
    pageDimensions: PageDimension[]
  ): GlobalContext {
    const totalPages = blocksByPage.size;

    // ── Global body font size (mode across all pages) ────────────────────
    const globalSizeFreq = new Map<number, number>();
    for (const [, pageBlocks] of blocksByPage) {
      for (const block of pageBlocks) {
        if (block.font_size > 0) {
          const rounded = Math.round(block.font_size);
          globalSizeFreq.set(rounded, (globalSizeFreq.get(rounded) || 0) + 1);
        }
      }
    }
    let globalBodySize = 12;
    let maxFreq = 0;
    for (const [size, freq] of globalSizeFreq) {
      if (freq > maxFreq) { maxFreq = freq; globalBodySize = size; }
    }

    // ── Cross-page repeating text detection ──────────────────────────────
    // Collect short text at extreme Y positions (top 12% / bottom 12%) from each page.
    // Normalize text for fuzzy matching: lowercase, collapse whitespace, strip page numbers.
    const candidates: Array<{ normalized: string; yPct: number; page: number }> = [];

    for (const [pageNum, pageBlocks] of blocksByPage) {
      const dims = pageDimensions[pageNum] || { width: 600, height: 800 };
      for (const block of pageBlocks) {
        const yPct = block.y / dims.height;
        const bottomPct = (block.y + block.height) / dims.height;
        // Only consider text in the margin zones and short enough to be a running head/foot
        if ((bottomPct < 0.12 || yPct > 0.88) && block.text.length < 200) {
          const normalized = this.normalizeForRepeatDetection(block.text);
          if (normalized.length > 0) {
            candidates.push({ normalized, yPct, page: pageNum });
          }
        }
      }
    }

    // Group candidates by normalized text + approximate Y band (within 2% of page height)
    // A "repeat" = same text appearing on 3+ different pages (or 2+ if total pages ≤ 4)
    const repeatThreshold = totalPages <= 4 ? 2 : 3;
    const repeatingTexts = new Set<string>();

    // Build a map: normalized text → set of pages it appears on
    const textPageMap = new Map<string, Set<number>>();
    for (const c of candidates) {
      if (!textPageMap.has(c.normalized)) {
        textPageMap.set(c.normalized, new Set());
      }
      textPageMap.get(c.normalized)!.add(c.page);
    }

    for (const [text, pages] of textPageMap) {
      if (pages.size >= repeatThreshold) {
        repeatingTexts.add(text);
      }
    }

    if (repeatingTexts.size > 0) {
      console.log(`[OCR PostProc] Global: Found ${repeatingTexts.size} cross-page repeating text(s) across ${totalPages} pages: ${[...repeatingTexts].map(t => `"${t}"`).join(', ')}`);
    }
    console.log(`[OCR PostProc] Global: bodySize=${globalBodySize} (from ${maxFreq} lines)`);

    return { globalBodySize, repeatingTexts };
  }

  /**
   * Normalize text for cross-page repeat detection.
   * Strips page numbers, collapses whitespace, lowercases.
   * "RICHARD J. EVANS  123" and "RICHARD J. EVANS  124" → "richard j. evans"
   */
  private normalizeForRepeatDetection(text: string): string {
    return text
      .replace(/\d+/g, '')             // Strip all numbers (page numbers, footnote refs)
      .replace(/[^\w\s]/g, '')         // Strip punctuation
      .replace(/\s+/g, ' ')           // Collapse whitespace
      .trim()
      .toLowerCase();
  }

  /**
   * Process blocks on a single page (Pass 2).
   * Uses global context from Pass 1 for body font size and cross-page repeat detection.
   */
  private processPage(
    blocks: TextBlock[],
    dims: PageDimension,
    pageNum: number,
    layoutBlocks?: LayoutBlock[],
    global?: GlobalContext
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

    // Use global body font size when available; fall back to per-page mode
    const avgFontSize = global?.globalBodySize ?? this.computePageBodySize(lines);

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

    // Detect the footnote zone dynamically per page by finding the first
    // significant gap in the lower portion. Returns null if no footnotes detected.
    const footnoteY = this.detectFootnoteZone(lines, dims, medianLineHeight);

    console.log(`[OCR PostProc] Page ${pageNum}: ${lines.length} lines, bodySize=${avgFontSize.toFixed(1)}${global ? ' (global)' : ' (page)'}, medianLineHeight=${medianLineHeight.toFixed(1)}, footnoteY=${footnoteY !== null ? (footnoteY / pageHeight * 100).toFixed(0) + '%' : 'none'}`);

    // Merge lines into paragraphs and categorize
    let categorizedBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number; category: string }>;

    if (layoutBlocks && layoutBlocks.length > 0) {
      // Layout-aware: group lines by Surya layout block, merge within each group
      categorizedBlocks = this.mergeWithLayout(lines, layoutBlocks, medianLineHeight, pageWidth, dims, pageCenterX, avgFontSize, footnoteY, global?.repeatingTexts);
    } else {
      // Heuristic: merge lines into paragraphs, then categorize by position/size
      const merged = this.mergeLines(lines, medianLineHeight, pageWidth);
      categorizedBlocks = merged.map(m => ({
        ...m,
        category: this.categorizeBlock(m, dims, pageCenterX, avgFontSize, footnoteY, global?.repeatingTexts)
      }));
    }

    // Convert back to TextBlock format
    // Use page number + random suffix + index to ensure unique IDs across all pages
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return categorizedBlocks.map((merged, index) => ({
      id: `ocr_p${pageNum}_${randomSuffix}_${index}`,
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

  /** Compute body font size for a single page (mode of line font sizes). */
  private computePageBodySize(lines: LineBlock[]): number {
    const sizeFreq = new Map<number, number>();
    for (const l of lines) {
      if (l.fontSize > 0) {
        const rounded = Math.round(l.fontSize);
        sizeFreq.set(rounded, (sizeFreq.get(rounded) || 0) + 1);
      }
    }
    let bodySize = 12;
    let maxFreq = 0;
    for (const [size, freq] of sizeFreq) {
      if (freq > maxFreq) { maxFreq = freq; bodySize = size; }
    }
    return bodySize;
  }

  /**
   * Detect the Y coordinate where footnotes begin on this page.
   * Finds the FIRST significant vertical gap in the lower portion of the page —
   * this is the body→footnote separator (horizontal rule + whitespace).
   * Returns null if no footnote zone is detected (page has no footnotes).
   */
  private detectFootnoteZone(
    lines: LineBlock[],
    dims: PageDimension,
    medianLineHeight: number
  ): number | null {
    if (lines.length < 3) return null;

    const sorted = [...lines].sort((a, b) => a.y - b.y);

    for (let i = 1; i < sorted.length; i++) {
      const gapTop = sorted[i - 1].y + sorted[i - 1].height;
      const gapBottom = sorted[i].y;
      const gapSize = gapBottom - gapTop;

      // First gap in the lower portion that's larger than normal line spacing
      // (> 2× median). medianLineHeight is baseline-to-baseline (~1.3× font
      // height), so 2× ≈ 2.5 blank lines of space — enough to catch most
      // footnote separators (horizontal rule + whitespace).
      if (gapTop > dims.height * 0.40 && gapSize > medianLineHeight * 2) {
        return gapBottom;
      }
    }

    return null;
  }

  /**
   * Categorize a merged block using a two-stage approach:
   *   Stage 1: Region detection (header / footer / lower / body)
   *   Stage 2: Semantic classification within the region
   *
   * Cross-page repeating text (from Pass 1) is the highest-priority signal
   * for headers and footers — it fires before any position/font heuristic.
   */
  private categorizeBlock(
    block: { x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number },
    dims: PageDimension,
    pageCenterX: number,
    bodySize: number,
    footnoteY: number | null,
    repeatingTexts?: Set<string>
  ): string {
    const text = block.text.trim();
    const yPct = block.y / dims.height;
    const bottomPct = (block.y + block.height) / dims.height;
    const fontRatio = block.fontSize / bodySize;

    // ── Highest priority: cross-page repeat detection ────────────────────
    // Text that repeats across 3+ pages at margin positions is a running
    // header or footer with near-100% certainty. No position/font heuristic
    // comes close to this signal strength.
    if (repeatingTexts && repeatingTexts.size > 0) {
      const normalized = this.normalizeForRepeatDetection(text);
      if (normalized.length > 0 && repeatingTexts.has(normalized)) {
        // Determine header vs footer by position
        return bottomPct < 0.50 ? 'header' : 'footer';
      }
    }

    // --- Stage 1: Region detection ---

    // Body text guard: prevents headers from swallowing real paragraph content
    const looksLikeBodyText = text.length > 100 ||
      /[.!?]["']?\s+[A-Z]/.test(text) ||  // Multiple sentences
      (text.endsWith('.') && text.length > 40) ||  // Sentence (headers don't end with periods)
      /^[a-z]/.test(text);  // Starts lowercase = continuation, never a header

    let region = 'body';

    if (block.lineCount <= 2 && bottomPct < 0.10 && !looksLikeBodyText) {
      region = 'header';
    } else if (yPct > 0.92 || (yPct > 0.88 && text.length < 50)) {
      region = 'footer';
    } else if (footnoteY !== null && block.y >= footnoteY) {
      region = 'lower';
    }

    // --- Stage 2: Classification (mirrors classifyBlock, adapted for OCR) ---

    if (region === 'header') return 'header';

    // Content-based footnote pattern: "18 Russell...", "31° See...", "* Note..."
    const looksLikeFootnote = /^(\d{1,3}[.\s°]|[*†‡§¶]\s)\s*[A-Z]/.test(text);

    // Footnote checks BEFORE footer — footnotes can sit near the very bottom
    // and get misassigned to the footer zone. Content overrides position.
    // OCR font sizes are noisier than native PDF, so use < 1.05 instead of < 0.95.
    if (region === 'lower' && fontRatio < 1.05) return 'footnote';
    if ((region === 'lower' || region === 'footer') && looksLikeFootnote) return 'footnote';

    // Footer: only after ruling out footnotes
    if (region === 'footer') return 'footer';

    // Captions: small text (< 0.85× body), NOT in lower region, and NOT in bottom half
    // (small text in the bottom half is more likely footnote than caption)
    if (fontRatio < 0.85 && region !== 'lower' && yPct < 0.50) return 'caption';

    // Titles: large text (> 1.4× body)
    if (fontRatio > 1.4) return 'title';

    // Headings: clearly larger text (> 1.25× body), short block, not body-like text.
    // Threshold raised from native's 1.1× because OCR font sizes have ~10-15% noise
    // from bounding box estimation — body text regularly hits 1.1-1.2× by accident.
    // Also guarded by looksLikeBodyText to exclude continuation fragments and sentences.
    if (fontRatio > 1.25 && block.lineCount <= 3 && !looksLikeBodyText) return 'heading';

    // Content-based caption
    if (/^(fig(ure|\.)?|table|plate|illustration|map|photo|image)\s*\.?\s*\d/i.test(text) && block.lineCount <= 3) {
      return 'caption';
    }

    // Font-based footnote with graduated thresholds: the deeper into the page,
    // the less font-size evidence we need. This is the universal footnote signal —
    // smaller font in the lower portion — independent of gap detection.
    // Three tiers compensate for OCR font noise (~10-15%):
    //   Bottom 30%: even slightly smaller (< 0.98×) is enough
    //   Bottom 40%: noticeably smaller (< 0.93×)
    //   Bottom 50%: clearly smaller (< 0.88×)
    if (yPct > 0.70 && fontRatio < 0.98) return 'footnote';
    if (yPct > 0.60 && fontRatio < 0.93) return 'footnote';
    if (yPct > 0.50 && fontRatio < 0.88) return 'footnote';

    return 'body';
  }

  /**
   * Group OCR lines by their best-overlapping Surya layout block.
   * Lines with <30% overlap go to fallback group (index -1).
   */
  private groupLinesByLayout(
    lines: LineBlock[],
    layoutBlocks: LayoutBlock[]
  ): Map<number, LineBlock[]> {
    const groups = new Map<number, LineBlock[]>();
    groups.set(-1, []);

    for (const line of lines) {
      const lineBox: [number, number, number, number] = [line.x, line.y, line.x + line.width, line.y + line.height];
      const lineArea = line.width * line.height;

      let bestIdx = -1;
      let bestOverlap = 0;

      for (let i = 0; i < layoutBlocks.length; i++) {
        const overlap = this.calculateOverlap(lineBox, layoutBlocks[i].bbox);
        const overlapPercent = lineArea > 0 ? overlap / lineArea : 0;

        if (overlapPercent > bestOverlap) {
          bestOverlap = overlapPercent;
          bestIdx = i;
        }
      }

      // Require at least 30% overlap
      if (bestOverlap < 0.3) bestIdx = -1;

      if (!groups.has(bestIdx)) groups.set(bestIdx, []);
      groups.get(bestIdx)!.push(line);
    }

    return groups;
  }

  /**
   * Merge lines using layout-aware grouping: group by Surya layout block,
   * merge within each group using heuristics, assign category from layout label.
   */
  private mergeWithLayout(
    lines: LineBlock[],
    layoutBlocks: LayoutBlock[],
    medianLineHeight: number,
    pageWidth: number,
    dims: PageDimension,
    pageCenterX: number,
    avgFontSize: number,
    footnoteY: number | null,
    repeatingTexts?: Set<string>
  ): Array<{ x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number; category: string }> {
    const groups = this.groupLinesByLayout(lines, layoutBlocks);
    const result: Array<{ x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number; category: string }> = [];

    for (const [layoutIdx, groupLines] of groups) {
      if (groupLines.length === 0) continue;

      // Sort by Y within group
      groupLines.sort((a, b) => a.y - b.y);

      // Merge lines within this layout group
      const merged = this.mergeLines(groupLines, medianLineHeight, pageWidth);

      if (layoutIdx >= 0) {
        // Known layout block — use its label for category
        const label = layoutBlocks[layoutIdx].label;
        const category = SURYA_LABEL_TO_CATEGORY[label] || 'body';
        for (const m of merged) {
          result.push({ ...m, category });
        }
      } else {
        // Fallback group — use heuristic categorization
        for (const m of merged) {
          result.push({
            ...m,
            category: this.categorizeBlock(m, dims, pageCenterX, avgFontSize, footnoteY, repeatingTexts)
          });
        }
      }
    }

    // Sort by Y to maintain reading order
    result.sort((a, b) => a.y - b.y);

    console.log(`[OCR PostProc] Layout-aware merge: ${lines.length} lines → ${result.length} blocks (${groups.size} layout groups)`);

    return result;
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
    // === HARD LIMITS (checked first — nothing overrides these) ===

    const lineToLineDistance = curr.y - prev.y;

    if (lineToLineDistance <= 0) {
      return false;  // Overlapping or same line
    }

    // Hard cutoff: lines more than 2.5x median apart are never merged,
    // even if content signals suggest continuation (prevents header→body merging)
    const maxLineDistance = medianLineHeight * 2.5;
    if (lineToLineDistance > maxLineDistance) {
      return false;
    }

    // Font size mismatch: different-sized lines are different structural elements
    // (e.g., author name vs. title, body vs. footnote). Use the smaller as denominator
    // so ratio is always >= 1.
    const fontRatio = Math.max(prev.fontSize, curr.fontSize) / Math.min(prev.fontSize, curr.fontSize);
    if (fontRatio > 1.2) {
      return false;
    }

    // === CONTENT-BASED CHECKS ===

    const prevText = prev.text.trim();
    const currText = curr.text.trim();

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

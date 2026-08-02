/**
 * OCR post-processing — raw recognized LINES in, categorized paragraph BLOCKS out.
 *
 * This is the single definition of what an OCR block IS in BookForge: how the lines
 * an engine reports become paragraphs, and which category each paragraph gets. Both
 * programs that produce OCR blocks compile this file:
 *
 *   - the renderer, via `OcrPostProcessorService` (a thin DI wrapper in
 *     `src/app/features/pdf-picker/services/ocr-post-processor.service.ts`), when
 *     you run OCR in the picker;
 *   - the main-process/CLI program, via `cli/ocr-pdf.js --project`, which writes the
 *     result into `manifest.editor.ocrBlocks` for later hand-labelling.
 *
 * That is not tidiness. Block IDs are minted here and then FROZEN: every hand label
 * (`manifest.editor.categoryCorrections`) is keyed to a block id, so a second
 * implementation that segmented "almost the same" would silently produce a
 * different set of blocks for the same page — and every label made against them
 * would be describing something the app can no longer reproduce.
 *
 * Features:
 * - Merges adjacent lines into paragraphs using content-aware logic
 * - Detects titles, headings, epigraphs, attributions, captions
 * - Estimates font sizes for categorization
 *
 * Platform-neutral by construction: no Node, no DOM, no Angular. `console.log` is
 * the only host API used, and both hosts have it.
 */

import type { TextBlock, Category, PageDimension } from './text-block';
import type { OcrPageLines, OcrTextLine } from './ocr-line';
import { OCR_RENDER_SCALE } from './ocr-render';
import { BLOCK_CATEGORIES, toCategory } from './block-categories';
import { planDisplayRuns, type DisplayRunBlock } from './display-run-merge';
import { lineSeparator } from '../text/line-join';

export interface ProcessedOcrResult {
  blocks: TextBlock[];
  categories: Record<string, Category>;
  /**
   * The pages that produced at least one recognized line, in result order.
   *
   * Callers replace existing blocks only on THESE pages: a page the engine found
   * no text on must keep whatever it already had, or running OCR over a range
   * would silently delete the analysis of every blank page in it.
   */
  pages: number[];
}

/**
 * One recognized line, in PAGE POINTS, as the merge/classify passes want it.
 *
 * Note what is NOT here: an id, and a category. Lines are an intermediate — every
 * merged paragraph gets a freshly minted id and a computed category — so carrying
 * either through would be inventing a value that is guaranteed to be discarded.
 */
interface LineBlock {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  /** Tesseract's paragraph identity ("blockNum:parNum"), when available. */
  parKey?: string;
  /** Typography from the legacy attribute pass, when available. */
  fontName?: string;
  /**
   * Bold/italic as 0 or 1, NOT the engine's per-word fraction.
   *
   * A line counts as bold when most of its words are (BOLD_THRESHOLD); a paragraph
   * counts as bold when most of its LINES are (`finalizeGroup` averages these and
   * applies the same threshold). Two majority votes, so neither one stray bold word
   * nor one stray bold line can flip a paragraph.
   */
  boldFrac?: number;
  italicFrac?: number;
  /** Recognition confidence and optical case, from hOCR line metrics. */
  confidence?: number;
  descenderRatio?: number;
}

/**
 * A paragraph: the lines `mergeLines` decided belong together, plus everything
 * derived from them. Declared once because four places used to spell it out
 * inline, and the display-run merge needs to name it.
 */
interface MergedGroup {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  lineCount: number;
  /** The member lines, kept so the final block can carry its line boxes. */
  lines: LineBlock[];
  fontName?: string;
  boldFrac: number;
  italicFrac: number;
  confidence?: number;
  descenderRatio?: number;
}

/** Cross-page context computed in Pass 1, consumed by per-page Pass 2. */
interface GlobalContext {
  /** Mode font size across ALL pages — immune to title-page skew. */
  globalBodySize: number;
  /** Normalized text strings that repeat on 3+ pages at fixed Y positions. */
  repeatingTexts: Set<string>;
  /**
   * Median gap between consecutive line BOXES inside one Tesseract paragraph,
   * across the whole book — the book's normal leading, as whitespace.
   *
   * Book-wide on purpose. The within-paragraph splitter compares each gap
   * against this, and a per-page baseline would defeat it exactly where it
   * matters most: a page that is mostly one list normalizes the list's own
   * item spacing, so nothing on it ever reads as a break. (Measured on the
   * Deliverance handbook: book-wide median 5.0pt caught the nine-item list on
   * p13; that page's own median would not have.)
   *
   * Null when the engine reported no paragraph keys or too few samples — the
   * splitter's gap rule simply stays off, matching the fallback grouping path
   * those engines take anyway.
   */
  medianLineGap: number | null;
}

/** Most of a line's words, not one stray read, decide bold or italic. */
const BOLD_THRESHOLD = 0.6;

/**
 * Within-paragraph split thresholds — how much line evidence it takes to overrule
 * a Tesseract merge.
 *
 * Tesseract's paragraph BOUNDARIES are reliable; its MERGES are not. It habitually
 * lumps a run of list items, or a heading and the paragraph under it, into one
 * `ocr_par` — and a block that merges two things has no correct label, which makes
 * under-segmentation the one direction hand-labelling cannot repair. So inside a
 * paragraph the grouping is split-only: a boundary Tesseract drew is always kept
 * (that is what guarantees every final block sits inside exactly one raw
 * paragraph, and what makes coarse→fine label transfer lossless), but a gap, a
 * font-size step, or a weight flip is allowed to cut where Tesseract did not.
 *
 * Thresholds are deliberately on the eager side: a false split costs one extra
 * block that later carries the same label, a false merge poisons a label.
 * Measured on the Deliverance handbook (574 raw paragraphs): these three signals
 * cut 36 merged blocks into ~92 — including the bulleted lists Tesseract had
 * collapsed to single blocks — while the old pass found 22.
 */
const WITHIN_PAR_GAP_RATIO = 1.6;   // × the book's median within-par line gap
const WITHIN_PAR_GAP_FLOOR = 3;     // …but at least this many points wider than it
const WITHIN_PAR_FONT_RATIO = 1.25; // size step between adjacent lines (~10-15% is OCR noise)

/**
 * Font sizes are clamped to sizes books actually use, because the last-resort
 * estimate below is derived from bounding-box height and OCR boxes include
 * whitespace. Body 10-14pt, headings 14-24pt, titles up to 48.
 */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;

/**
 * The size of a page, or a loud failure.
 *
 * Every classification threshold in this file is a fraction of page height, so a
 * page whose size is unknown cannot be classified — it can only be MIS-classified.
 * This used to substitute 600x800, which silently moved the footnote, footer and
 * caption boundaries on every page the caller failed to measure.
 */
function requirePageDimension(pageDimensions: PageDimension[], pageNum: number): PageDimension {
  const dims = pageDimensions[pageNum];
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) {
    throw new Error(
      `[OCR Post-Processor] no page dimensions for page ${pageNum}` +
      ` (have ${pageDimensions.length} entr${pageDimensions.length === 1 ? 'y' : 'ies'}).` +
      ' Every category threshold is a fraction of page height, so the page size is required.');
  }
  return dims;
}

/**
 * OCR page results → the blocks and categories the picker shows and the manifest
 * stores. THE entry point; everything below is its implementation.
 *
 * `pageDimensions` is indexed by 0-based page number and is in PAGE POINTS, while
 * the line boxes in `results` are in image pixels of an `OCR_RENDER_SCALE` raster.
 * Converting between the two is done here, once, for the same reason the rest of
 * this file is shared: the picker used to do it with a scale derived from the
 * document's page count and inflated every OCR box by up to 1.85x.
 */
export function processOcrPageResults(
  results: readonly OcrPageLines[],
  pageDimensions: PageDimension[]
): ProcessedOcrResult {
  const linesByPage = new Map<number, LineBlock[]>();
  const pages: number[] = [];

  for (const result of results) {
    const textLines = result.textLines;
    // A page with no recognized text is SKIPPED, not emptied — see
    // ProcessedOcrResult.pages.
    if (!textLines || textLines.length === 0) continue;

    // Reading the dimension here (not lazily, deeper in) so a missing page size
    // fails before any work, naming the page.
    requirePageDimension(pageDimensions, result.page);

    pages.push(result.page);
    linesByPage.set(result.page, textLines.map(line => toLineBlock(line, result.page)));
  }

  const { blocks, categories } = processLinesByPage(linesByPage, pageDimensions);
  return { blocks, categories, pages };
}

/**
 * One recognized line → one LineBlock, in page points.
 *
 * Font size, best source first:
 *   1. the legacy attribute pass's reported point size
 *   2. hOCR `x_size` / render scale — measured from x-height, free, LSTM-safe
 *   3. bounding-box height x 0.7 — a guess, and the reason 86% of a book used to
 *      pin to the 8pt clamp floor with no size signal at all
 * Only the guess is clamped; a reported size is reported, not second-guessed.
 */
function toLineBlock(line: OcrTextLine, page: number): LineBlock {
  const [x1, y1, x2, y2] = line.bbox;
  const x = x1 / OCR_RENDER_SCALE;
  const y = y1 / OCR_RENDER_SCALE;
  const width = (x2 - x1) / OCR_RENDER_SCALE;
  const height = (y2 - y1) / OCR_RENDER_SCALE;

  let estimatedFontSize = Math.round(height * 0.7);  // conservative: boxes include whitespace

  // For very short text (1-3 chars) the box is often far taller than the type.
  // Width per character is the better estimate there.
  const textLen = line.text.trim().length;
  if (textLen > 0 && textLen <= 3) {
    const widthBasedSize = Math.round(width / textLen * 0.9);
    estimatedFontSize = Math.min(estimatedFontSize, widthBasedSize);
  }
  estimatedFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, estimatedFontSize));

  const measuredSize = line.xSize && line.xSize > 0 ? line.xSize / OCR_RENDER_SCALE : null;
  const reportedSize = line.fontSize && line.fontSize > 0 ? line.fontSize : measuredSize;

  return {
    page,
    x,
    y,
    width,
    height,
    text: line.text,
    fontSize: reportedSize ?? estimatedFontSize,
    // Tesseract already grouped these lines into paragraphs; carry that through so
    // the merge pass uses its layout analysis instead of re-deriving breaks from
    // spacing alone.
    parKey: line.blockNum !== undefined && line.parNum !== undefined
      ? `${line.blockNum}:${line.parNum}`
      : undefined,
    // 'OCR' is the placeholder an engine with no font pass reports; it is not a font.
    fontName: line.fontName && line.fontName !== 'OCR' ? line.fontName : undefined,
    boldFrac: (line.boldFrac ?? 0) >= BOLD_THRESHOLD ? 1 : 0,
    italicFrac: (line.italicFrac ?? 0) >= BOLD_THRESHOLD ? 1 : 0,
    confidence: line.confidence,
    // Descender depth relative to type size; ~0 means capitals.
    descenderRatio: line.descenders !== undefined && line.xSize
      ? line.descenders / line.xSize
      : undefined,
  };
}

/**
 * Category definitions, taken from the thirteen-class contract in
 * ./block-categories.ts rather than declared here.
 *
 * This used to be its own eight-entry table with its own palette, and the
 * palette disagreed with the contract — `heading` was purple (subheading's
 * colour), `caption` was orange (heading's). Since these records land in
 * `editorState.categories`, which is what the Detect and Label palettes read,
 * OCR'ing a book silently repainted the swatches. The five classes it omitted
 * (`chapter`, `subheading`, `table`, `list`, `image`) got no record at all,
 * so blocks carrying them fell through to the viewer's orange fallback.
 *
 * The classifier below still only ASSIGNS the subset it can infer from
 * geometry; having a record for the rest is what lets a hand-set or predicted
 * category paint its own colour.
 *
 * This matters doubly for the CLI: `manifest.editor.ocrCategories` written on this
 * machine is read by the app on another, so the records have to BE the contract,
 * not a second table that agrees with it today.
 */
const CATEGORIES: Record<string, Omit<Category, 'block_count' | 'char_count'>> =
  Object.fromEntries(BLOCK_CATEGORIES.map(def => {
    const { block_count, char_count, ...rest } = toCategory(def);
    return [def.id, rest];
  }));

/**
 * Process raw OCR blocks (line-by-line) into structured paragraphs with categories.
 *
 * Two-pass architecture:
 *   Pass 1 (global): Compute global body font size across all pages, detect
 *     cross-page repeating text at fixed Y positions (running headers/footers).
 *   Pass 2 (per-page): Merge lines into paragraphs and classify using global context.
 */
function processLinesByPage(
  blocksByPage: Map<number, LineBlock[]>,
  pageDimensions: PageDimension[]
): { blocks: TextBlock[]; categories: Record<string, Category> } {
  const lineCount = [...blocksByPage.values()].reduce((n, l) => n + l.length, 0);
  console.log(`[OCR Post-Processor] Processing ${lineCount} OCR line(s)`
    + ` on ${blocksByPage.size} page(s)`);

  if (lineCount === 0) {
    return { blocks: [], categories: {} };
  }

  // ── Pass 1: Global analysis ──────────────────────────────────────────
  const globalContext = buildGlobalContext(blocksByPage, pageDimensions);

  // ── Pass 2a: Per-page grouping ───────────────────────────────────────
  const pages: PageGroups[] = [];
  for (const [pageNum, pageBlocks] of blocksByPage) {
    const dims = requirePageDimension(pageDimensions, pageNum);
    const grouped = groupPage(pageBlocks, dims, pageNum, globalContext);
    if (grouped) pages.push(grouped);
  }

  // ── Pass 2b: Display-run merge, across the whole book ────────────────
  mergeDisplayRunsInPlace(pages);

  // ── Pass 2c: Per-page categorization ─────────────────────────────────
  const processedBlocks: TextBlock[] = [];
  const categoryCounts: Record<string, { blocks: number; chars: number }> = {};

  for (const page of pages) {
    const processed = categorizePage(page, globalContext);

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
    const baseCat = CATEGORIES[catId];
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
function buildGlobalContext(
  blocksByPage: Map<number, LineBlock[]>,
  pageDimensions: PageDimension[]
): GlobalContext {
  const totalPages = blocksByPage.size;

  // ── Global body font size (mode across all pages) ────────────────────
  const globalSizeFreq = new Map<number, number>();
  for (const [, pageBlocks] of blocksByPage) {
    for (const block of pageBlocks) {
      if (block.fontSize > 0) {
        const rounded = Math.round(block.fontSize);
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
    const dims = requirePageDimension(pageDimensions, pageNum);
    for (const block of pageBlocks) {
      const yPct = block.y / dims.height;
      const bottomPct = (block.y + block.height) / dims.height;
      // Only consider text in the margin zones and short enough to be a running head/foot
      if ((bottomPct < 0.12 || yPct > 0.88) && block.text.length < 200) {
        const normalized = normalizeForRepeatDetection(block.text);
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

  // ── Book-wide median within-paragraph line gap ───────────────────────
  // Grouped BY paragraph key, not by consecutive sort order: on a multi-column
  // page, sorting by Y interleaves the columns, and box gaps between interleaved
  // lines measure nothing. Within one parKey the lines are one column's flow.
  const parGaps: number[] = [];
  for (const [, pageBlocks] of blocksByPage) {
    const byPar = new Map<string, LineBlock[]>();
    for (const line of pageBlocks) {
      if (!line.parKey) continue;
      let arr = byPar.get(line.parKey);
      if (!arr) byPar.set(line.parKey, arr = []);
      arr.push(line);
    }
    for (const [, parLines] of byPar) {
      parLines.sort((a, b) => a.y - b.y);
      for (let i = 1; i < parLines.length; i++) {
        const gap = parLines[i].y - (parLines[i - 1].y + parLines[i - 1].height);
        // Slightly-negative gaps are box overlap from descenders; big ones are
        // not leading, whatever they are.
        if (gap > -2 && gap < 60) parGaps.push(gap);
      }
    }
  }
  parGaps.sort((a, b) => a - b);
  const medianLineGap = parGaps.length >= 5 ? parGaps[Math.floor(parGaps.length / 2)] : null;

  if (repeatingTexts.size > 0) {
    console.log(`[OCR PostProc] Global: Found ${repeatingTexts.size} cross-page repeating text(s) across ${totalPages} pages: ${[...repeatingTexts].map(t => `"${t}"`).join(', ')}`);
  }
  console.log(`[OCR PostProc] Global: bodySize=${globalBodySize} (from ${maxFreq} lines), ` +
    `medianLineGap=${medianLineGap !== null ? medianLineGap.toFixed(1) + 'pt' : 'n/a'}`);

  return { globalBodySize, repeatingTexts, medianLineGap };
}

/**
 * Normalize text for cross-page repeat detection.
 * Strips page numbers, collapses whitespace, lowercases.
 * "RICHARD J. EVANS  123" and "RICHARD J. EVANS  124" → "richard j. evans"
 */
function normalizeForRepeatDetection(text: string): string {
  return text
    .replace(/\d+/g, '')             // Strip all numbers (page numbers, footnote refs)
    .replace(/[^\w\s]/g, '')         // Strip punctuation
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim()
    .toLowerCase();
}

/** One page's paragraph groups, after grouping and before categorization. */
interface PageGroups {
  pageNum: number;
  dims: PageDimension;
  groups: MergedGroup[];
  footnoteY: number | null;
  avgFontSize: number;
}

/**
 * Group a page's lines into paragraphs (Pass 2a).
 *
 * Split out from categorization so the display-run merge can run BETWEEN them:
 * that merge needs quantities from the whole book (the modal type size, the body
 * measure, which page-edge bands repeat), so it cannot live inside a per-page
 * function — and it has to happen before `categorizeBlock` sees anything, or a
 * chapter heading gets categorized one fragment at a time.
 */
function groupPage(
  pageLines: LineBlock[],
  dims: PageDimension,
  pageNum: number,
  global: GlobalContext
): PageGroups | null {
  if (pageLines.length === 0) return null;

  // Sort lines by Y position (top to bottom)
  const lines: LineBlock[] = [...pageLines].sort((a, b) => a.y - b.y);

  // Calculate page metrics
  const pageWidth = dims.width;
  const pageHeight = dims.height;

  // Body size is the mode across the WHOLE document (Pass 1), never this page
  // alone: a title page set in oversized type would otherwise become its own
  // baseline and classify its own title as body text.
  const avgFontSize = global.globalBodySize;

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
  const footnoteY = detectFootnoteZone(lines, dims, medianLineHeight, avgFontSize);

  console.log(`[OCR PostProc] Page ${pageNum}: ${lines.length} lines, bodySize=${avgFontSize.toFixed(1)} (global), medianLineHeight=${medianLineHeight.toFixed(1)}, footnoteY=${footnoteY !== null ? (footnoteY / pageHeight * 100).toFixed(0) + '%' : 'none'}`);

  return {
    pageNum,
    dims,
    groups: mergeLines(lines, medianLineHeight, pageWidth, global.medianLineGap),
    footnoteY,
    avgFontSize,
  };
}

/**
 * Rejoin the pieces of a display heading that paragraph grouping cut apart.
 *
 * A chapter opening arrives as three or four groups — a tracked `CHAPTER 1`
 * kicker, the title over two lines, sometimes a subtitle — because grouping is a
 * local rule that sees two lines and the space between them. Every one of those
 * pieces then gets its own category and, in a labelling session, its own human
 * label, for what the page shows as one heading.
 *
 * `planDisplayRuns` decides which pieces belong together from geometry alone,
 * and it is the SAME MODULE foundry runs before its blocks model classifies
 * anything (`src/blocks/display-run-merge.ts` there) — so a corpus book labelled
 * here and a book classified there are segmented identically. See that file's
 * header for the two-repo contract and the shared fixture that guards it.
 *
 * Category-blind by necessity: this runs before `categorizeBlock`, which is the
 * point. A merged heading is categorized as the heading it is, rather than one
 * fragment at a time.
 *
 * The merged group is rebuilt by `finalizeGroup` from the union of its lines, so
 * its text, size, typography and confidence are computed the one way a
 * paragraph's fields are ever computed. Its ID therefore changes, because ids
 * are a hash of geometry and text — which is the documented behaviour of a
 * segmentation change, and why re-OCR moves labels aside.
 */
function mergeDisplayRunsInPlace(pages: PageGroups[]): void {
  if (pages.length === 0) return;

  const key = (pageNum: number, index: number): string => `p${pageNum}g${index}`;
  const forRule: DisplayRunBlock[] = [];
  for (const page of pages) {
    page.groups.forEach((g, i) => {
      forRule.push({
        id: key(page.pageNum, i),
        page: page.pageNum,
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
        fontSize: g.fontSize,
        lineCount: g.lineCount,
        pageWidth: page.dims.width,
        pageHeight: page.dims.height,
        text: g.text,
      });
    });
  }
  if (forRule.length === 0) return;

  const plan = planDisplayRuns(forRule);
  if (plan.runs.length === 0) return;

  const groupOf = new Map<string, MergedGroup>();
  for (const page of pages) {
    page.groups.forEach((g, i) => groupOf.set(key(page.pageNum, i), g));
  }
  const swallowed = new Set(plan.runs.flatMap(r => r.slice(1)));
  const leadOf = new Map(plan.runs.map(r => [r[0], r]));

  let merged = 0;
  for (const page of pages) {
    const kept: MergedGroup[] = [];
    page.groups.forEach((g, i) => {
      const id = key(page.pageNum, i);
      if (swallowed.has(id)) return;
      const run = leadOf.get(id);
      if (!run) { kept.push(g); return; }
      // The plan's member order IS reading order, which is the order the lines
      // of the heading have to be joined in.
      kept.push(finalizeGroup(run.flatMap(memberId => groupOf.get(memberId)!.lines)));
      merged++;
    });
    // Grouping handed these over sorted by Y and the passes after this one read
    // them in that order; a merged unit starts where its first piece did, so
    // re-sorting keeps that true without moving anything else.
    kept.sort((a, b) => a.y - b.y || a.x - b.x);
    page.groups = kept;
  }
  console.log(`[OCR Post-Processor] display-run merge: ${merged} heading(s) rejoined from `
    + `${plan.runs.reduce((n, r) => n + r.length, 0)} block(s)`
    + ` (modal type ${plan.modalFontSize}, measure ${Math.round(plan.bodyColumnWidth)},`
    + ` ${plan.furnitureIds.length} block(s) held back as page furniture)`);
}

/**
 * Categorize a page's groups and emit the blocks the app stores (Pass 2b).
 */
function categorizePage(page: PageGroups, global: GlobalContext): TextBlock[] {
  const { pageNum, dims, groups, footnoteY, avgFontSize } = page;
  const categorizedBlocks = groups.map(m => ({
    ...m,
    category: categorizeBlock(m, dims, avgFontSize, footnoteY, global.repeatingTexts)
  }));

  // ── Pass 3: Cross-block footnote reclassification ───────────────────
  reclassifyFootnotes(categorizedBlocks, dims, avgFontSize, pageNum);

  // Convert back to TextBlock format.
  //
  // IDs are DETERMINISTIC: page + index + a hash of the block's geometry and
  // text. Tesseract is exactly reproducible (measured: 206/206 identical bboxes
  // and text on a re-run), so with unchanged code the same book re-OCRs to the
  // same ids — labels no longer orphan on an identical re-run. This replaced a
  // Math.random() suffix, whose only virtue was that stale labels could never
  // silently match; the hash keeps that protection, because a SEGMENTATION
  // change moves geometry or text and therefore changes the hash, so labels
  // keyed to a different segmentation still miss instead of mismatching.
  return categorizedBlocks.map((merged, index) => ({
    id: `ocr_p${pageNum}_${index}_${blockIdHash(merged.x, merged.y, merged.width, merged.height, merged.text)}`,
    page: pageNum,
    x: merged.x,
    y: merged.y,
    width: merged.width,
    height: merged.height,
    text: merged.text,
    font_size: merged.fontSize,
    // Preserve typography recovered by the legacy attribute pass. Falling
    // back to the 'OCR' placeholder here would discard the strongest signals
    // the classifier has — font differs from body, and boldness.
    font_name: merged.fontName || 'OCR',
    is_bold: merged.boldFrac >= 0.6,
    is_italic: merged.italicFrac >= 0.6,
    ocr_confidence: merged.confidence,
    ocr_descender_ratio: merged.descenderRatio,
    char_count: merged.text.length,
    region: CATEGORIES[merged.category]?.region || 'body',
    category_id: merged.category,
    is_ocr: true,
    line_count: merged.lineCount,
    line_boxes: merged.lines.map(l => [
      Math.round(l.x * 10) / 10,
      Math.round(l.y * 10) / 10,
      Math.round(l.width * 10) / 10,
      Math.round(l.height * 10) / 10,
    ] as [number, number, number, number]),
  }));
}

/**
 * Deterministic short hash over a block's identity — djb2-xor, base36.
 *
 * Not cryptographic and does not need to be: its job is (a) reproducibility, so
 * an identical OCR run mints identical ids, and (b) making ids from a DIFFERENT
 * segmentation practically never collide, so labels keyed to old blocks fail to
 * match rather than silently attaching to the wrong ones. No Node `crypto` —
 * this file also compiles into the renderer.
 */
function blockIdHash(x: number, y: number, width: number, height: number, text: string): string {
  const s = `${x.toFixed(1)},${y.toFixed(1)},${width.toFixed(1)},${height.toFixed(1)}|${text}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).padStart(4, '0').slice(0, 6);
}

/**
 * Detect the Y coordinate where footnotes begin on this page.
 * Finds the FIRST significant vertical gap in the lower portion of the page —
 * this is the body→footnote separator (horizontal rule + whitespace).
 * Returns null if no footnote zone is detected (page has no footnotes).
 */
function detectFootnoteZone(
  lines: LineBlock[],
  dims: PageDimension,
  medianLineHeight: number,
  bodySize?: number
): number | null {
  if (lines.length < 3) return null;

  const sorted = [...lines].sort((a, b) => a.y - b.y);

  // Primary: find first significant gap in the lower portion (> 1.5× median).
  // Lowered from 2× to catch pages with thinner separators or minimal whitespace.
  for (let i = 1; i < sorted.length; i++) {
    const gapTop = sorted[i - 1].y + sorted[i - 1].height;
    const gapBottom = sorted[i].y;
    const gapSize = gapBottom - gapTop;

    if (gapTop > dims.height * 0.40 && gapSize > medianLineHeight * 1.5) {
      return gapBottom;
    }
  }

  // Fallback: no gap found — check if bottom lines have noticeably smaller font.
  // Catches pages with thin separator rules or no separator at all.
  if (bodySize && bodySize > 0) {
    // Scan from bottom up: find the first line with small font in the bottom 40%
    for (let i = sorted.length - 1; i >= 0; i--) {
      const line = sorted[i];
      const yPct = line.y / dims.height;
      if (yPct < 0.60) break;  // Stop once we leave bottom 40%

      const fontRatio = line.fontSize / bodySize;
      if (fontRatio >= 0.90) {
        // Hit a normal-sized line — footnotes must start below this
        if (i < sorted.length - 1) {
          // Check if lines below this one were small
          const nextLine = sorted[i + 1];
          const nextRatio = nextLine.fontSize / bodySize;
          if (nextRatio < 0.90) {
            return nextLine.y;
          }
        }
        break;
      }
    }
  }

  return null;
}

/**
 * Pass 3: Cross-block footnote reclassification.
 *
 * Runs after all blocks are categorized (by layout or heuristic). Uses
 * cross-block context that individual block classification can't see:
 *
 * 1. If footnotes already exist on this page, flood-fill downward: everything
 *    below the first footnote with small font is also a footnote.
 * 2. If NO footnotes exist, try content-based bootstrap: scan from the bottom
 *    for blocks matching the footnote text pattern in the bottom 40% with
 *    smaller font. Once one is found, flood-fill the rest.
 *
 * Mutates `blocks` in place.
 */
function reclassifyFootnotes(
  blocks: Array<{ x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number; category: string }>,
  dims: PageDimension,
  bodySize: number,
  pageNum: number
): void {
  if (blocks.length < 2) return;

  // Broadened footnote text pattern (same as in categorizeBlock)
  const footnotePattern = /^(\d{1,3}[.\s°)\]:]\s*|[*†‡§¶•]\s?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s?)\S/;

  // Separate body and existing footnote blocks, sorted by Y
  const bodyBlocks = blocks
    .filter(b => b.category === 'body')
    .sort((a, b) => a.y - b.y);
  const existingFootnotes = blocks.filter(b => b.category === 'footnote');

  let footnoteZoneY: number | null = null;
  let reclassified = 0;

  // ── Strategy 1: Flood-fill below existing footnotes ───────────────
  if (existingFootnotes.length > 0) {
    footnoteZoneY = Math.min(...existingFootnotes.map(f => f.y));

    for (const block of bodyBlocks) {
      if (block.y < footnoteZoneY) continue;

      const fontRatio = block.fontSize / bodySize;
      if (fontRatio < 1.05 || footnotePattern.test(block.text.trim())) {
        block.category = 'footnote';
        reclassified++;
      }
    }
  }

  // ── Strategy 2: Content-based bootstrap (no footnotes found yet) ──
  if (existingFootnotes.length === 0 && reclassified === 0) {
    // Scan body blocks from bottom up looking for footnote-like content
    for (let i = bodyBlocks.length - 1; i >= 0; i--) {
      const block = bodyBlocks[i];
      const yPct = block.y / dims.height;
      if (yPct < 0.60) break;  // Only check bottom 40%

      const fontRatio = block.fontSize / bodySize;
      const matchesPattern = footnotePattern.test(block.text.trim());

      if (matchesPattern && fontRatio < 1.0) {
        // Found a likely footnote — establish zone and flood-fill
        footnoteZoneY = block.y;
        block.category = 'footnote';
        reclassified++;

        // Reclassify all body blocks at or below this Y
        for (let j = i + 1; j < bodyBlocks.length; j++) {
          const below = bodyBlocks[j];
          const belowRatio = below.fontSize / bodySize;
          if (belowRatio < 1.05 || footnotePattern.test(below.text.trim())) {
            below.category = 'footnote';
            reclassified++;
          }
        }
        break;
      }
    }
  }

  if (reclassified > 0) {
    console.log(`[OCR PostProc] Page ${pageNum}: reclassifyFootnotes() upgraded ${reclassified} body block(s) to footnote (zone Y=${footnoteZoneY !== null ? (footnoteZoneY / dims.height * 100).toFixed(0) + '%' : 'n/a'})`);
  }
}

/**
 * Categorize a merged block using a two-stage approach:
 *   Stage 1: Region detection (header / footer / lower / body)
 *   Stage 2: Semantic classification within the region
 *
 * Cross-page repeating text (from Pass 1) is the highest-priority signal
 * for headers and footers — it fires before any position/font heuristic.
 */
function categorizeBlock(
  block: { x: number; y: number; width: number; height: number; text: string; fontSize: number; lineCount: number },
  dims: PageDimension,
  bodySize: number,
  footnoteY: number | null,
  repeatingTexts: Set<string>
): string {
  const text = block.text.trim();
  const yPct = block.y / dims.height;
  const bottomPct = (block.y + block.height) / dims.height;
  const fontRatio = block.fontSize / bodySize;

  // ── Highest priority: cross-page repeat detection ────────────────────
  // Text that repeats across 3+ pages at margin positions is a running
  // header or footer with near-100% certainty. No position/font heuristic
  // comes close to this signal strength.
  if (repeatingTexts.size > 0) {
    const normalized = normalizeForRepeatDetection(text);
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

  // Content-based footnote pattern — broadened to catch academic variants:
  //   "18 Russell...", "31° See...", "* Note...", "18see also...", "18) Russell...",
  //   "¹⁸ Russell...", "• See...", "18] Russell..."
  const looksLikeFootnote = /^(\d{1,3}[.\s°)\]:]\s*|[*†‡§¶•]\s?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s?)\S/.test(text);

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
 * Merge adjacent lines into paragraphs using content-aware logic
 */
function mergeLines(
  lines: LineBlock[],
  medianLineHeight: number,
  pageWidth: number,
  medianLineGap: number | null
): MergedGroup[] {
  if (lines.length === 0) return [];

  const result: MergedGroup[] = [];

  let currentGroup: LineBlock[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];

    const shouldMerge = shouldMergeLines(prev, curr, medianLineHeight, pageWidth, currentGroup, medianLineGap);

    if (shouldMerge) {
      currentGroup.push(curr);
    } else {
      result.push(finalizeGroup(currentGroup));
      currentGroup = [curr];
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    result.push(finalizeGroup(currentGroup));
  }

  console.log(`[OCR PostProc] Merged ${lines.length} lines → ${result.length} blocks`);

  return result;
}

/**
 * Determine if two lines should be merged using content-aware logic
 */
function shouldMergeLines(
  prev: LineBlock,
  curr: LineBlock,
  medianLineHeight: number,
  pageWidth: number,
  currentGroup: LineBlock[],
  medianLineGap: number | null
): boolean {
  // === TESSERACT LAYOUT ANALYSIS (authoritative one way only) ===
  // A paragraph BOUNDARY Tesseract drew is always kept — never joining across it
  // is what guarantees every final block sits inside exactly one raw paragraph,
  // which keeps label transfer between segmentations a pure containment lookup.
  //
  // A Tesseract MERGE, though, is only a claim, and a frequently false one: it
  // lumps runs of list items, a heading and its first paragraph, a footnote and
  // the body above it, into one `ocr_par`. This branch used to trust it entirely
  // (`return prev.parKey === curr.parKey`), which is why nine bulleted list
  // items could arrive as one unlabellable block. Within a paragraph the
  // grouping is now split-only, on three line signals, each biased eager —
  // a false split is one extra block later carrying the same label, a false
  // merge is a block with no correct label at all.
  if (prev.parKey !== undefined && curr.parKey !== undefined) {
    if (prev.parKey !== curr.parKey) return false;

    // 1. Whitespace: a gap clearly wider than the book's own leading is a
    //    layout break, whatever Tesseract thought (list item spacing, a
    //    heading floated above its section, a stanza break).
    if (medianLineGap !== null) {
      const gap = curr.y - (prev.y + prev.height);
      const threshold = Math.max(
        medianLineGap * WITHIN_PAR_GAP_RATIO,
        medianLineGap + WITHIN_PAR_GAP_FLOOR);
      if (gap > threshold) return false;
    }

    // 2. Type size: adjacent lines a size class apart are different elements
    //    (heading over body, body over spilled footnote).
    const sizeRatio = Math.max(prev.fontSize, curr.fontSize)
      / Math.min(prev.fontSize, curr.fontSize);
    if (sizeRatio > WITHIN_PAR_FONT_RATIO) return false;

    // 3. Weight: boldFrac is already a per-line majority vote (0 or 1), so a
    //    flip is a line-level weight change — a bold lead-in or run-in heading —
    //    not one misread word.
    if ((prev.boldFrac ?? 0) !== (curr.boldFrac ?? 0)) return false;

    return true;
  }

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
function finalizeGroup(lines: LineBlock[]): MergedGroup {
  // Calculate bounding box
  const minX = Math.min(...lines.map(l => l.x));
  const minY = Math.min(...lines.map(l => l.y));
  const maxX = Math.max(...lines.map(l => l.x + l.width));
  const maxY = Math.max(...lines.map(l => l.y + l.height));

  // Combine text intelligently. Lines within one OCR paragraph are page
  // line-wraps, so they join into flowing prose with a single space.
  //
  // A WRAP HYPHEN is the one break we keep — see line-join.ts for why deciding
  // it here is guesswork. This used to dehyphenate UNCONDITIONALLY, with no test
  // at all, so every real compound that happened to fall at a line end was
  // silently welded shut ("far-|right" → "farright") and the evidence destroyed
  // along with it.
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].text.trim();

    if (i === 0) {
      text = lineText;
      continue;
    }

    text += lineSeparator(text, lineText) + lineText;
  }

  // Use average font size
  const fontSizes = lines.map(l => l.fontSize);
  const avgFontSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;

  // Typography, aggregated across the merged lines. Majority font and mean
  // bold/italic share — a single stray word must not flip a paragraph's
  // weight, and a genuine heading is bold across all of its lines.
  const fontVotes = new Map<string, number>();
  for (const l of lines) {
    if (l.fontName) fontVotes.set(l.fontName, (fontVotes.get(l.fontName) ?? 0) + 1);
  }
  let fontName: string | undefined;
  let bestCount = 0;
  for (const [name, count] of fontVotes) {
    if (count > bestCount) { bestCount = count; fontName = name; }
  }
  const mean = (pick: (l: LineBlock) => number) =>
    lines.reduce((acc, l) => acc + pick(l), 0) / lines.length;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    text,
    fontSize: Math.round(avgFontSize),
    lineCount: lines.length,
    lines,
    fontName,
    boldFrac: mean(l => l.boldFrac ?? 0),
    italicFrac: mean(l => l.italicFrac ?? 0),
    // Worst line drives confidence: one badly recognized line makes the whole
    // paragraph suspect, and averaging would hide it.
    confidence: lines.some(l => l.confidence !== undefined)
      ? Math.min(...lines.filter(l => l.confidence !== undefined).map(l => l.confidence!))
      : undefined,
    descenderRatio: lines.some(l => l.descenderRatio !== undefined)
      ? mean(l => l.descenderRatio ?? 0)
      : undefined,
  };
}
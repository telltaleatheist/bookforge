/**
 * Category Re-detection Engine
 *
 * One classifier — see recategorize() for the staged algorithm. Thresholds
 * always apply; centroids refine the heuristic once corrections exist rather
 * than replacing it, and hand-set categories are never touched.
 *
 * The invariant everything else depends on: a block the user categorized by
 * hand keeps that category until the user changes or clears it. No inference
 * stage, no page-level cleanup pass, and no threshold change may override it.
 * This is what makes the corrections usable as training labels.
 */

import { TextBlock, PageDimension } from './pdf.service';
import { lineSeparator } from '@shared/text/line-join';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockFeatureVector {
  fontSizeRatio: number;    // block.font_size / baselines.bodySize
  isBold: number;           // 0 or 1
  isItalic: number;         // 0 or 1
  xOffsetRatio: number;     // block.x / pageWidth
  widthRatio: number;       // block.width / pageWidth
  yPositionRatio: number;   // block.y / pageHeight
  lineCountNorm: number;    // min(block.line_count / 20, 1)
  charCountNorm: number;    // min(block.char_count / 500, 1)
  nearImage: number;        // 0 or 1 (adjacent to image block)
  fontNameMatch: number;    // 1 if same font as body, 0 otherwise
  isAllCaps: number;        // 1 if text is predominantly uppercase, 0 otherwise
  isCentered: number;       // 1 if block appears centered on page, 0 otherwise
  indentRatio: number;      // (block.x - bodyMarginX) / pageWidth, clamped to [-0.5, 0.5]
  gapAboveNorm: number;     // gap above block / bodySize, clamped to [0, 1]
}

export interface CategoryBaselines {
  bodySize: number;         // Most common font size in body region
  bodyFont: string;         // Most common font name
  bodyIsItalic: boolean;    // Whether body text is predominantly italic
  bodyMarginX: number;      // Most common X position
  bodyWidth: number;        // Most common block width for body text
}

export interface ClassificationThresholds {
  region: {
    headerBottomPct: number;       // 0.15 — blocks fully above this = header
    footerBottomPct: number;       // 0.92 — blocks below this = footer
    footerShortBottomPct: number;  // 0.88 — short text below this = footer
    footerShortMaxChars: number;   // 50
    lowerBottomPct: number;        // 0.70 — blocks below this = lower
  };
  footnoteRef: {
    maxFontRatio: number;          // 0.75
    maxChars: number;              // 4
  };
  header: {
    regionScoreThreshold: number;  // 2
    nonRegionScoreThreshold: number; // 3
    topYPct: number;               // 0.10
  };
  footnote: {
    fontRatio: number;             // 0.95
    lowerHalfYPct: number;         // 0.50
  };
  caption: {
    smallFontRatio: number;        // 0.85
    nearImageFontRatio: number;    // 0.95
    maxLinesNearImage: number;     // 8
  };
  title: {
    minFontRatio: number;          // 1.4
    minChars: number;              // 3
  };
  heading: {
    minFontRatio: number;          // 1.1
  };
  subheading: {
    maxLines: number;              // 2
    maxChars: number;              // 200
  };
  quote: {
    minLines: number;              // 2
  };
}

export function getDefaultThresholds(): ClassificationThresholds {
  return {
    region: {
      headerBottomPct: 0.15,
      footerBottomPct: 0.92,
      footerShortBottomPct: 0.88,
      footerShortMaxChars: 50,
      lowerBottomPct: 0.70,
    },
    footnoteRef: {
      maxFontRatio: 0.75,
      maxChars: 4,
    },
    header: {
      regionScoreThreshold: 2,
      nonRegionScoreThreshold: 3,
      topYPct: 0.10,
    },
    footnote: {
      fontRatio: 0.95,
      lowerHalfYPct: 0.50,
    },
    caption: {
      smallFontRatio: 0.85,
      nearImageFontRatio: 0.95,
      maxLinesNearImage: 8,
    },
    title: {
      minFontRatio: 1.4,
      minChars: 3,
    },
    heading: {
      minFontRatio: 1.1,
    },
    subheading: {
      maxLines: 2,
      maxChars: 200,
    },
    quote: {
      minLines: 2,
    },
  };
}

export function isDefaultThresholds(t: ClassificationThresholds): boolean {
  return JSON.stringify(t) === JSON.stringify(getDefaultThresholds());
}

// ─────────────────────────────────────────────────────────────────────────────
// Baselines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute document baselines from all blocks.
 * Mirrors the logic in pdf-analyzer.ts generateCategories().
 *
 * `regions` optionally supplies a recomputed region per block id (from the
 * user's thresholds). Without it we fall back to `block.region`, which was
 * frozen at PDF-analysis time and therefore ignores threshold changes.
 */
export function computeBaselines(
  blocks: TextBlock[],
  regions?: Map<string, string>
): CategoryBaselines {
  const regionOf = (b: TextBlock) => regions?.get(b.id) ?? b.region;

  // Body size: most common font size among non-bold, non-image body-region blocks
  const sizeChars = new Map<number, number>();
  for (const block of blocks) {
    if (regionOf(block) === 'body' && !block.is_bold && !block.is_image) {
      sizeChars.set(block.font_size, (sizeChars.get(block.font_size) || 0) + block.char_count);
    }
  }
  let bodySize = 10;
  let maxChars = 0;
  for (const [size, chars] of sizeChars) {
    if (chars > maxChars) { maxChars = chars; bodySize = size; }
  }

  // Body font: most common font name
  const fontChars = new Map<string, number>();
  let bodyItalicChars = 0;
  let bodyTotalChars = 0;
  for (const block of blocks) {
    if (regionOf(block) === 'body' && !block.is_bold && !block.is_image) {
      fontChars.set(block.font_name, (fontChars.get(block.font_name) || 0) + block.char_count);
      bodyTotalChars += block.char_count;
      if (block.is_italic) bodyItalicChars += block.char_count;
    }
  }
  let bodyFont = 'unknown';
  let maxFontChars = 0;
  for (const [font, chars] of fontChars) {
    if (chars > maxFontChars) { maxFontChars = chars; bodyFont = font; }
  }
  const bodyIsItalic = bodyTotalChars > 0 && bodyItalicChars > bodyTotalChars * 0.5;

  // Body margin: most common X position (weighted by char count)
  const marginCounts = new Map<number, number>();
  for (const block of blocks) {
    if (regionOf(block) === 'body' && !block.is_image) {
      const roundedX = Math.round(block.x);
      marginCounts.set(roundedX, (marginCounts.get(roundedX) || 0) + block.char_count);
    }
  }
  let bodyMarginX = 0;
  let maxMarginChars = 0;
  for (const [x, chars] of marginCounts) {
    if (chars > maxMarginChars) { maxMarginChars = chars; bodyMarginX = x; }
  }

  // Body width: most common block width for body-region blocks
  const widthCounts = new Map<number, number>();
  for (const block of blocks) {
    if (regionOf(block) === 'body' && !block.is_image && block.char_count > 50) {
      const roundedW = Math.round(block.width / 5) * 5; // bucket to nearest 5
      widthCounts.set(roundedW, (widthCounts.get(roundedW) || 0) + block.char_count);
    }
  }
  let bodyWidth = 400;
  let maxWidthChars = 0;
  for (const [w, chars] of widthCounts) {
    if (chars > maxWidthChars) { maxWidthChars = chars; bodyWidth = w; }
  }

  return { bodySize, bodyFont, bodyIsItalic, bodyMarginX, bodyWidth };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build per-page index of image block positions.
 */
function buildImageIndex(blocks: TextBlock[]): Map<number, TextBlock[]> {
  const imagesByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (block.is_image) {
      if (!imagesByPage.has(block.page)) imagesByPage.set(block.page, []);
      imagesByPage.get(block.page)!.push(block);
    }
  }
  return imagesByPage;
}

/**
 * Check if a block is adjacent to an image (within threshold pixels).
 */
function isAdjacentToImage(
  block: TextBlock,
  imagesByPage: Map<number, TextBlock[]>,
  threshold = 30
): boolean {
  const pageImages = imagesByPage.get(block.page);
  if (!pageImages) return false;
  return pageImages.some(img => {
    const imgBottom = img.y + img.height;
    const blockBottom = block.y + block.height;
    const belowImage = block.y >= imgBottom - 5 && block.y <= imgBottom + threshold;
    const aboveImage = blockBottom >= img.y - threshold && blockBottom <= img.y + 5;
    const hOverlap = block.x < img.x + img.width && block.x + block.width > img.x;
    return (belowImage || aboveImage) && hOverlap;
  });
}

/**
 * Compute the vertical gap above each block (distance from block above on same page).
 * First block on a page gets its Y position as the gap (distance from top).
 */
function computeGapsAbove(blocks: TextBlock[]): Map<string, number> {
  const blocksByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (!block.is_image) {
      if (!blocksByPage.has(block.page)) blocksByPage.set(block.page, []);
      blocksByPage.get(block.page)!.push(block);
    }
  }

  const gaps = new Map<string, number>();
  for (const [, pageBlocks] of blocksByPage) {
    const sorted = [...pageBlocks].sort((a, b) => a.y - b.y);
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0) {
        gaps.set(sorted[i].id, sorted[i].y);
      } else {
        const prevBottom = sorted[i - 1].y + sorted[i - 1].height;
        gaps.set(sorted[i].id, Math.max(0, sorted[i].y - prevBottom));
      }
    }
  }
  return gaps;
}

/**
 * Check if text is predominantly uppercase (ignoring non-letter chars).
 */
function isTextAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper > letters.length * 0.8;
}

/**
 * Check if a block appears to be centered on the page.
 * Centered = left and right margins roughly equal, block is narrower than body width.
 */
function isBlockCentered(block: TextBlock, pageWidth: number, bodyWidth: number): boolean {
  const leftMargin = block.x;
  const rightMargin = pageWidth - (block.x + block.width);
  const marginDiff = Math.abs(leftMargin - rightMargin);
  // Centered if margins are similar, block isn't full-width, and has meaningful margins
  return marginDiff < pageWidth * 0.08
    && block.width < bodyWidth * 0.9
    && leftMargin > pageWidth * 0.05;
}

/**
 * Extract a normalized feature vector from a block.
 */
export function extractBlockFeatures(
  block: TextBlock,
  baselines: CategoryBaselines,
  pageDimensions: PageDimension[],
  imagesByPage: Map<number, TextBlock[]>,
  gapsAbove: Map<string, number>
): BlockFeatureVector {
  const pageDim = pageDimensions[block.page];
  const pageWidth = pageDim?.width || 612;
  const pageHeight = pageDim?.height || 792;

  const gapAbove = gapsAbove.get(block.id) || 0;
  const indentFromMargin = block.x - baselines.bodyMarginX;

  return {
    fontSizeRatio: baselines.bodySize > 0 ? block.font_size / baselines.bodySize : 1,
    isBold: block.is_bold ? 1 : 0,
    isItalic: block.is_italic ? 1 : 0,
    xOffsetRatio: block.x / pageWidth,
    widthRatio: block.width / pageWidth,
    yPositionRatio: block.y / pageHeight,
    lineCountNorm: Math.min((block.line_count || 1) / 20, 1),
    charCountNorm: Math.min(block.char_count / 500, 1),
    nearImage: isAdjacentToImage(block, imagesByPage) ? 1 : 0,
    fontNameMatch: block.font_name === baselines.bodyFont ? 1 : 0,
    isAllCaps: isTextAllCaps(block.text) ? 1 : 0,
    isCentered: isBlockCentered(block, pageWidth, baselines.bodyWidth) ? 1 : 0,
    indentRatio: Math.max(-0.5, Math.min(0.5, indentFromMargin / pageWidth)),
    gapAboveNorm: baselines.bodySize > 0 ? Math.min(gapAbove / (baselines.bodySize * 3), 1) : 0
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Distance & centroid
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE_KEYS: (keyof BlockFeatureVector)[] = [
  'fontSizeRatio', 'isBold', 'isItalic', 'xOffsetRatio', 'widthRatio',
  'yPositionRatio', 'lineCountNorm', 'charCountNorm', 'nearImage',
  'fontNameMatch', 'isAllCaps', 'isCentered', 'indentRatio', 'gapAboveNorm'
];

type FeatureWeights = Record<keyof BlockFeatureVector, number>;

function weightedDistance(a: BlockFeatureVector, b: BlockFeatureVector, weights: FeatureWeights): number {
  let sum = 0;
  for (const key of FEATURE_KEYS) {
    const diff = a[key] - b[key];
    sum += weights[key] * diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Compute per-feature discriminative weights from centroids.
 *
 * Features where centroids differ a lot (e.g. isBold=0 for quotes vs isBold=1
 * for subheadings) get high weight. Features where centroids are similar
 * (e.g. yPositionRatio) get low weight. This prevents positional features
 * from drowning out the actually meaningful differences.
 */
function computeDiscriminativeWeights(centroids: Map<string, BlockFeatureVector>): FeatureWeights {
  const centroidValues = [...centroids.values()];
  const weights: any = {};

  if (centroidValues.length < 2) {
    for (const key of FEATURE_KEYS) weights[key] = 1;
    return weights as FeatureWeights;
  }

  // For each feature, compute the variance across centroids
  for (const key of FEATURE_KEYS) {
    const values = centroidValues.map(c => c[key]);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
    // Use standard deviation as weight — features with more spread across
    // centroids are more discriminative. Minimum 0.1 so every feature contributes.
    weights[key] = Math.max(Math.sqrt(variance), 0.1);
  }

  // Normalize so weights sum to the number of features
  const total = FEATURE_KEYS.reduce((s, k) => s + weights[k], 0);
  const scale = FEATURE_KEYS.length / total;
  for (const key of FEATURE_KEYS) {
    weights[key] *= scale;
  }

  return weights as FeatureWeights;
}

function computeCentroid(vectors: BlockFeatureVector[]): BlockFeatureVector {
  const centroid: any = {};
  for (const key of FEATURE_KEYS) centroid[key] = 0;
  for (const v of vectors) {
    for (const key of FEATURE_KEYS) {
      centroid[key] += v[key];
    }
  }
  const n = vectors.length;
  for (const key of FEATURE_KEYS) {
    centroid[key] /= n;
  }
  return centroid as BlockFeatureVector;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural constraints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a block can be assigned to a given category.
 * Returns false if a hard structural constraint is violated.
 *
 * Every bound here is derived from the same `thresholds` the heuristic pass
 * uses, so a block the heuristic would happily call a footnote can never be
 * refused footnote by this gate. Previously these were hardcoded and
 * contradicted the heuristic (title 1.2x vs 1.4x, footnotes forced below
 * body size), which silently prevented user corrections from propagating.
 */
function passesStructuralConstraint(
  categoryType: string,
  block: TextBlock,
  region: string,
  baselines: CategoryBaselines,
  pageDimensions: PageDimension[],
  imagesByPage: Map<number, TextBlock[]>,
  blocksByPage: Map<number, TextBlock[]>,
  thresholds: ClassificationThresholds
): boolean {
  const pageDim = pageDimensions[block.page];
  const pageHeight = pageDim?.height || 792;
  const yRatio = block.y / pageHeight;
  const bottomRatio = (block.y + block.height) / pageHeight;

  // An image block is an image and nothing else; conversely a text block can
  // never become one.
  if (block.is_image) return categoryType === 'image';
  if (categoryType === 'image') return false;

  switch (categoryType) {
    case 'footnote':
      // Lower part of the page, and either visually smaller than body or
      // carrying a footnote marker (footnotes at body size are common).
      return yRatio > thresholds.footnote.lowerHalfYPct && (
        block.font_size < baselines.bodySize * thresholds.footnote.fontRatio
        || startsWithFootnotePattern(block.text)
      );

    case 'footnote_ref':
      return block.char_count <= thresholds.footnoteRef.maxChars && (
        !!block.is_superscript
        || block.font_size < baselines.bodySize * thresholds.footnoteRef.maxFontRatio
      );

    case 'header':
      // Page header must be near the top AND have nothing substantial above it
      return (region === 'header' || yRatio < thresholds.header.topYPct)
        && (block.line_count || 1) <= 2
        && !hasSubstantialTextAbove(block, blocksByPage);

    case 'footer':
      // Page footer must be near the bottom AND have nothing substantial below it
      return bottomRatio > thresholds.region.footerShortBottomPct
        && !hasSubstantialTextBelow(block, blocksByPage);

    case 'caption':
      return isAdjacentToImage(block, imagesByPage);

    case 'title':
      return block.font_size > baselines.bodySize * thresholds.title.minFontRatio
        && block.char_count > thresholds.title.minChars;

    case 'chapter':
      // Either the wording says so, or it is large type. Kept permissive on
      // purpose: books set chapter openers in wildly different ways, and an
      // over-tight gate here would stop the user's corrections propagating.
      return isChapterOpenerText(block.text)
        || block.font_size >= baselines.bodySize * thresholds.heading.minFontRatio;

    // body, heading, subheading, quote and any user-defined category —
    // no structural constraint.
    default:
      return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic fallback (ported from pdf-analyzer.ts classifyBlock)
// ─────────────────────────────────────────────────────────────────────────────

function isFootnoteMarkerText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 6) return false;
  if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹\u00B9\u00B2\u00B3]+$/.test(trimmed)) return true;
  if (/^\d{1,3}$/.test(trimmed)) return true;
  if (/^[\[\(]\d{1,3}[\]\)]$/.test(trimmed)) return true;
  if (/^[\*†‡§¶]+$/.test(trimmed)) return true;
  return false;
}

/**
 * Text that opens a chapter — "Chapter 12", "Chapter Two", "CHAPTER XIV",
 * with or without a following title on the same line.
 *
 * Deliberately does NOT match "Part"/"Book" dividers: those are structural
 * titles, not chapter breaks, and should not become EPUB split points.
 */
function isChapterOpenerText(text: string): boolean {
  return /^\s*chapter\b/i.test(text.trim());
}

/**
 * Matches text that starts with a footnote numbering/marker pattern.
 */
function startsWithFootnotePattern(text: string): boolean {
  return /^(\d{1,3}[.\s°)\]:]\s*|[*†‡§¶•]\s?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s?)\S/.test(text.trim());
}

/**
 * Detects whether a block has a significant vertical gap above it on the same page.
 */
function hasSignificantGapAbove(
  block: TextBlock,
  blocksByPage: Map<number, TextBlock[]>,
  pageHeight: number
): boolean {
  if (block.y / pageHeight < 0.50) return false;

  const pageBlocks = blocksByPage.get(block.page);
  if (!pageBlocks) return false;

  let nearestAboveBottom = 0;
  for (const b of pageBlocks) {
    if (b.id === block.id || b.is_image) continue;
    const bBottom = b.y + b.height;
    if (bBottom <= block.y && bBottom > nearestAboveBottom) {
      nearestAboveBottom = bBottom;
    }
  }

  if (nearestAboveBottom === 0) return false;

  const gap = block.y - nearestAboveBottom;
  return gap > block.height * 1.5;
}

/**
 * Checks whether any genuine body text exists below a block on the same page.
 * Excludes blocks that start with footnote numbering patterns — those are
 * sibling footnotes, not body text (important when footnotes share body font size).
 */
function hasBodyTextBelowBlock(
  block: TextBlock,
  blocksByPage: Map<number, TextBlock[]>,
  bodySize: number
): boolean {
  const pageBlocks = blocksByPage.get(block.page);
  const blockBottom = block.y + block.height;
  return !!pageBlocks?.some(b =>
    b.y > blockBottom &&
    b.id !== block.id &&
    !b.is_image &&
    b.char_count > 20 &&
    b.font_size >= bodySize * 0.95 &&
    !startsWithFootnotePattern(b.text)
  );
}

/**
 * Check if there's any substantial text block below this one on the same page.
 * Used to reject footer classification — a real footer has nothing meaningful below it.
 */
function hasSubstantialTextBelow(
  block: TextBlock,
  blocksByPage: Map<number, TextBlock[]>
): boolean {
  const pageBlocks = blocksByPage.get(block.page);
  const blockBottom = block.y + block.height;
  return !!pageBlocks?.some(b =>
    b.y > blockBottom &&
    b.id !== block.id &&
    !b.is_image &&
    b.char_count > 20
  );
}

/**
 * Check if there's any substantial text block above this one on the same page.
 * Used to reject header classification — a real page header is the first thing on the page.
 */
function hasSubstantialTextAbove(
  block: TextBlock,
  blocksByPage: Map<number, TextBlock[]>
): boolean {
  const pageBlocks = blocksByPage.get(block.page);
  return !!pageBlocks?.some(b =>
    (b.y + b.height) < block.y &&
    b.id !== block.id &&
    !b.is_image &&
    b.char_count > 20
  );
}

/**
 * Heuristic block classification at default thresholds.
 *
 * Thin wrapper over classifyBlockWithThresholds() — kept for callers that
 * classify a single freshly-created block (e.g. the children of a block split)
 * and have no threshold context. It used to be a near-identical copy of the
 * threshold classifier that read the stale analysis-time `block.region`; the
 * two drifted apart, so it now delegates and recomputes region like everything
 * else does.
 */
export function classifyBlockHeuristic(
  block: TextBlock,
  baselines: CategoryBaselines,
  imagesByPage: Map<number, TextBlock[]>,
  blocksByPage: Map<number, TextBlock[]>,
  pageDimensions: PageDimension[],
  repeatedTopTexts: Set<string>
): string {
  const thresholds = getDefaultThresholds();
  const pageHeight = pageDimensions[block.page]?.height || 800;
  const region = computeRegion(block, pageHeight, thresholds);
  return classifyBlockWithThresholds(
    block, region, baselines, imagesByPage, blocksByPage,
    pageDimensions, repeatedTopTexts, thresholds
  );
}

/**
 * Header scoring — port from pdf-analyzer.ts computeHeaderScore().
 */
function computeHeaderScore(
  block: TextBlock,
  baselines: CategoryBaselines,
  blocksByPage: Map<number, TextBlock[]>,
  repeatedTopTexts: Set<string>
): number {
  let score = 0;
  const trimmed = block.text.trim();

  if (Math.round(block.font_size) !== Math.round(baselines.bodySize)) score += 2;

  const norm = trimmed.replace(/[\d\-\u2013\u2014.,;:!?]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (norm.length > 3 && repeatedTopTexts.has(norm)) score += 3;

  const hasPageNum = /^\d{1,4}\s+\S/.test(trimmed) || /\S\s+\d{1,4}$/.test(trimmed) ||
    (block.char_count <= 5 && /^\d+$/.test(trimmed));
  if (hasPageNum) score += 1;

  if (block.is_italic && !baselines.bodyIsItalic) score += 1;
  if (block.font_name !== baselines.bodyFont) score += 1;

  const pageBlocks = blocksByPage.get(block.page);
  if (pageBlocks) {
    const blockBottom = block.y + block.height;
    const nextBlock = pageBlocks.find(b => b.y >= blockBottom && b.id !== block.id);
    if (nextBlock && (nextBlock.y - blockBottom) > baselines.bodySize * 1.5) score += 1;
  }

  if (Math.abs(block.x - baselines.bodyMarginX) > baselines.bodySize * 0.5) score += 1;
  if (block.char_count < 60) score += 1;

  return score;
}

/**
 * Detect repeated top-of-page text (running headers).
 */
function detectRepeatedTopTexts(blocks: TextBlock[], pageDimensions: PageDimension[]): Set<string> {
  const topTextPages = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (block.is_image || (block.line_count || 1) > 2) continue;
    const ph = pageDimensions[block.page]?.height || 800;
    if (block.y / ph < 0.10) {
      const norm = block.text.trim().replace(/[\d\-\u2013\u2014.,;:!?]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (norm.length > 3) {
        if (!topTextPages.has(norm)) topTextPages.set(norm, new Set());
        topTextPages.get(norm)!.add(block.page);
      }
    }
  }
  const repeated = new Set<string>();
  for (const [text, pages] of topTextPages) {
    if (pages.size >= 3) repeated.add(text);
  }
  return repeated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold-aware classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute a block's region from raw Y position using user thresholds.
 * The original block.region was assigned at PDF analysis time with hardcoded values.
 */
function computeRegion(
  block: TextBlock,
  pageHeight: number,
  thresholds: ClassificationThresholds
): string {
  const bottomPct = (block.y + block.height) / pageHeight;

  if (bottomPct < thresholds.region.headerBottomPct) return 'header';

  if (bottomPct > thresholds.region.footerBottomPct) return 'footer';
  if (bottomPct > thresholds.region.footerShortBottomPct && block.char_count <= thresholds.region.footerShortMaxChars) return 'footer';

  if (bottomPct > thresholds.region.lowerBottomPct) return 'lower';

  return 'body';
}

/**
 * Classify a block using user-adjustable thresholds.
 * Mirrors classifyBlockHeuristic() but replaces every hardcoded number.
 */
export function classifyBlockWithThresholds(
  block: TextBlock,
  region: string,
  baselines: CategoryBaselines,
  imagesByPage: Map<number, TextBlock[]>,
  blocksByPage: Map<number, TextBlock[]>,
  pageDimensions: PageDimension[],
  repeatedTopTexts: Set<string>,
  thresholds: ClassificationThresholds
): string {
  if (block.is_image) return 'image';

  // A bare note marker OCR split off from its surroundings.
  //
  // This used to return `footnote_ref`, a class retired in Jul 2026 (2 examples
  // in a 42,759-block corpus). The convention that replaced it goes by what the
  // marker was split OFF from: a number lifted out of a note entry belongs to
  // that entry, so `footnote`. Nothing here can see the surrounding entry, but
  // the test itself — tiny type, one line, a handful of characters — is
  // overwhelmingly satisfied inside the note band rather than in running prose,
  // which is why `footnote` is the right default and a superscript in body text
  // is the acknowledged miss. A hand label overrides either way.
  if (isFootnoteMarkerText(block.text)) return 'footnote';
  if (block.is_superscript) return 'footnote';
  if (block.font_size < baselines.bodySize * thresholds.footnoteRef.maxFontRatio
      && block.char_count <= thresholds.footnoteRef.maxChars
      && (block.line_count || 1) === 1) {
    return 'footnote';
  }

  // Header detection via scoring
  if (region === 'header') {
    const score = computeHeaderScore(block, baselines, blocksByPage, repeatedTopTexts);
    return score >= thresholds.header.regionScoreThreshold ? 'header' : 'body';
  }
  const pageHeight = pageDimensions[block.page]?.height || 800;
  const yPct = block.y / pageHeight;
  const text = block.text.trim();

  const looksLikeBodyText = block.char_count > 100 ||
    /[.!?]["']?\s+[A-Z]/.test(text) ||
    (text.endsWith('.') && block.char_count > 60);

  // Footer: only if nothing substantial below it AND it doesn't look like body text
  const isBodyFontSize = block.font_size >= baselines.bodySize * 0.90;
  if (region === 'footer' && !hasSubstantialTextBelow(block, blocksByPage)
      && !looksLikeBodyText && !isBodyFontSize) return 'footer';

  const bottomPct = (block.y + block.height) / pageHeight;
  if ((block.line_count || 1) <= 2 && (yPct < thresholds.header.topYPct || bottomPct < thresholds.region.headerBottomPct) && !looksLikeBodyText) {
    const score = computeHeaderScore(block, baselines, blocksByPage, repeatedTopTexts);
    if (score >= thresholds.header.nonRegionScoreThreshold) return 'header';
  }

  // Footnotes: multiple signals
  const isLowerHalf = block.y / pageHeight > thresholds.footnote.lowerHalfYPct;
  const hasSmallerFont = block.font_size < baselines.bodySize * thresholds.footnote.fontRatio;
  const hasFootnotePattern = startsWithFootnotePattern(block.text);
  const hasGap = hasSignificantGapAbove(block, blocksByPage, pageHeight);
  const bodyTextBelow = hasBodyTextBelowBlock(block, blocksByPage, baselines.bodySize);

  if (region === 'lower' && hasSmallerFont && !bodyTextBelow) return 'footnote';
  if (isLowerHalf && hasFootnotePattern && !bodyTextBelow) return 'footnote';
  if (isLowerHalf && hasGap && hasSmallerFont) return 'footnote';
  if (hasGap && hasFootnotePattern) return 'footnote';

  // Caption detection
  const nearImage = isAdjacentToImage(block, imagesByPage);
  const differentFont = block.font_name !== baselines.bodyFont;
  const isItalicCaption = !!block.is_italic && !baselines.bodyIsItalic;

  if (nearImage && block.font_size < baselines.bodySize * thresholds.caption.smallFontRatio) return 'caption';
  if (nearImage && isItalicCaption) return 'caption';
  if (nearImage && differentFont && (block.line_count || 1) <= thresholds.caption.maxLinesNearImage) return 'caption';
  if (nearImage && block.font_size < baselines.bodySize * thresholds.caption.nearImageFontRatio) return 'caption';

  // Chapter openings — checked BEFORE title, since both are large type and a
  // pure font-size rule cannot tell a chapter opener from the book's title.
  // Chapters are what drive EPUB file splits and M4B chapter marks, so the
  // distinction has to survive classification.
  const isLargeType = block.font_size > baselines.bodySize * thresholds.heading.minFontRatio;
  if (isLargeType && isChapterOpenerText(text)) return 'chapter';

  // Large type that opens a page and has body text under it is a chapter
  // opener, not a title: a title page (or part divider) carries no body.
  if (block.font_size > baselines.bodySize * thresholds.title.minFontRatio
      && block.char_count > thresholds.title.minChars
      && !hasSubstantialTextAbove(block, blocksByPage)
      && hasSubstantialTextBelow(block, blocksByPage)) {
    return 'chapter';
  }

  // Title
  if (block.font_size > baselines.bodySize * thresholds.title.minFontRatio && block.char_count > thresholds.title.minChars) return 'title';

  // Heading / subheading
  if (block.is_bold) {
    if (block.font_size > baselines.bodySize * thresholds.heading.minFontRatio) return 'heading';
    if ((block.line_count || 1) <= thresholds.subheading.maxLines && block.char_count < thresholds.subheading.maxChars) return 'subheading';
  }

  // Quote
  if (block.is_italic && (block.line_count || 1) > thresholds.quote.minLines && !nearImage) return 'quote';

  return 'body';
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified re-categorization
// ─────────────────────────────────────────────────────────────────────────────

/** Where a block's category came from. */
export type AssignmentSource = 'correction' | 'centroid' | 'heuristic';

export interface BlockAssignment {
  categoryId: string;
  source: AssignmentSource;
  /**
   * 0..1. For centroid assignments this is the normalized margin between the
   * best and second-best category — low values mean "this was a close call".
   * Corrections are always 1 (human ground truth). Heuristic assignments
   * report 0.5 (no meaningful score available).
   */
  confidence: number;
}

/** Corrected blocks pull their category's centroid this much harder than inferred ones. */
const CORRECTION_WEIGHT = 4;

/**
 * Beyond this weighted distance a centroid is not considered a match at all
 * and the heuristic label stands. Without this every block was force-assigned
 * to its nearest centroid no matter how far away it was.
 */
const MAX_CENTROID_DISTANCE = 1.6;

/**
 * A centroid must be built from at least this many blocks before it is allowed
 * to compete, so a one-block category can't out-attract `body`.
 */
const MIN_CENTROID_SUPPORT = 2;

/**
 * Re-classify every block in the document.
 *
 * One engine, run in stages:
 *
 *   1. Regions are recomputed from raw Y using the user's thresholds — the
 *      analysis-time `block.region` is stale and ignores threshold changes.
 *   2. Every uncorrected block gets a heuristic label from those thresholds.
 *   3. If the user has made corrections, centroids refine that label. Centroids
 *      are built from corrected blocks (weighted heavily) PLUS the blocks the
 *      heuristic just labelled, so a single correction can no longer wipe out a
 *      well-formed category. A centroid must clear a distance cut and a support
 *      floor, and must satisfy the same threshold-derived structural
 *      constraints the heuristic uses.
 *   4. Page-level cleanup (one header per page).
 *   5. Corrections are re-stamped unconditionally.
 *
 * User corrections are inviolable: they are never re-classified in stage 2 or
 * 3, never demoted by stage 4, and stage 5 restores them regardless of what any
 * earlier stage decided. A block you set by hand keeps that category until you
 * change or clear it yourself.
 *
 * @param blocks           All text blocks in the document
 * @param corrections      blockId -> categoryId, set by hand (ground truth)
 * @param pageDimensions   Per-page dimension data
 * @param thresholds       User-adjustable classification thresholds
 * @param deletedBlockIds  Excluded from spatial checks so deleted/merged-away
 *                         blocks don't act as phantom neighbours
 */
export function recategorize(
  blocks: TextBlock[],
  corrections: Map<string, string>,
  pageDimensions: PageDimension[],
  thresholds: ClassificationThresholds,
  deletedBlockIds?: Set<string>
): Map<string, BlockAssignment> {
  const result = new Map<string, BlockAssignment>();

  // ── Stage 0: indices ──────────────────────────────────────────────────
  // Regions recomputed from the user's thresholds, not block.region.
  const regions = new Map<string, string>();
  for (const block of blocks) {
    const pageHeight = pageDimensions[block.page]?.height || 800;
    regions.set(block.id, computeRegion(block, pageHeight, thresholds));
  }

  const baselines = computeBaselines(blocks, regions);
  const imagesByPage = buildImageIndex(blocks);
  const repeatedTopTexts = detectRepeatedTopTexts(blocks, pageDimensions);

  // Exclude deleted blocks (including merge sources) so spatial checks like
  // hasSubstantialTextBelow don't see phantom blocks.
  const blocksByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (!block.is_image && !deletedBlockIds?.has(block.id)) {
      if (!blocksByPage.has(block.page)) blocksByPage.set(block.page, []);
      blocksByPage.get(block.page)!.push(block);
    }
  }
  for (const [, pageBlocks] of blocksByPage) {
    pageBlocks.sort((a, b) => a.y - b.y);
  }

  // ── Stage 1: images and corrections are settled up front ──────────────
  for (const block of blocks) {
    if (block.is_image) {
      result.set(block.id, { categoryId: 'image', source: 'heuristic', confidence: 1 });
      continue;
    }
    const corrected = corrections.get(block.id);
    if (corrected !== undefined) {
      result.set(block.id, { categoryId: corrected, source: 'correction', confidence: 1 });
    }
  }

  // ── Stage 2: heuristic pass over everything not corrected ─────────────
  for (const block of blocks) {
    if (block.is_image || corrections.has(block.id)) continue;
    const categoryId = classifyBlockWithThresholds(
      block, regions.get(block.id)!, baselines, imagesByPage, blocksByPage,
      pageDimensions, repeatedTopTexts, thresholds
    );
    result.set(block.id, { categoryId, source: 'heuristic', confidence: 0.5 });
  }

  // ── Stage 3: centroid refinement (only once corrections exist) ────────
  let centroidChanges = 0;
  if (corrections.size > 0) {
    const gapsAbove = computeGapsAbove(blocks);
    const features = new Map<string, BlockFeatureVector>();
    for (const block of blocks) {
      if (block.is_image) continue;
      features.set(
        block.id,
        extractBlockFeatures(block, baselines, pageDimensions, imagesByPage, gapsAbove)
      );
    }

    // Build centroids from corrections AND current (heuristic) assignments.
    // Corrections carry more weight but do not replace the category's other
    // evidence — replacing it meant one correction could redefine an entire
    // category and trigger a document-wide reshuffle.
    const samples = new Map<string, Array<{ vector: BlockFeatureVector; weight: number }>>();
    const support = new Map<string, number>();
    for (const block of blocks) {
      if (block.is_image) continue;
      const vector = features.get(block.id);
      const assignment = result.get(block.id);
      if (!vector || !assignment) continue;
      const weight = assignment.source === 'correction' ? CORRECTION_WEIGHT : 1;
      if (!samples.has(assignment.categoryId)) samples.set(assignment.categoryId, []);
      samples.get(assignment.categoryId)!.push({ vector, weight });
      support.set(assignment.categoryId, (support.get(assignment.categoryId) || 0) + 1);
    }

    const centroids = new Map<string, BlockFeatureVector>();
    for (const [categoryId, group] of samples) {
      if ((support.get(categoryId) || 0) < MIN_CENTROID_SUPPORT) continue;
      centroids.set(categoryId, computeWeightedCentroid(group));
    }

    if (centroids.size >= 2) {
      const weights = computeDiscriminativeWeights(centroids);

      for (const block of blocks) {
        if (block.is_image || corrections.has(block.id)) continue;
        const vector = features.get(block.id);
        const current = result.get(block.id);
        if (!vector || !current) continue;

        const region = regions.get(block.id)!;
        const candidates: Array<{ categoryId: string; distance: number }> = [];
        for (const [categoryId, centroid] of centroids) {
          if (!passesStructuralConstraint(
            categoryId, block, region, baselines, pageDimensions,
            imagesByPage, blocksByPage, thresholds
          )) continue;
          candidates.push({ categoryId, distance: weightedDistance(vector, centroid, weights) });
        }
        if (candidates.length === 0) continue;

        candidates.sort((a, b) => a.distance - b.distance);
        const best = candidates[0];

        // Too far from every centroid — the heuristic label stands.
        if (best.distance > MAX_CENTROID_DISTANCE) continue;

        const runnerUp = candidates[1];
        const confidence = runnerUp
          ? Math.min(1, (runnerUp.distance - best.distance) / Math.max(runnerUp.distance, 1e-6))
          : 1;

        if (best.categoryId !== current.categoryId) centroidChanges++;
        result.set(block.id, { categoryId: best.categoryId, source: 'centroid', confidence });
      }
    }
  }

  // ── Stage 4: page-level cleanup — one header per page ─────────────────
  // Never demotes a corrected block: if the user says two blocks on a page are
  // both headers, they are both headers.
  const headersByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (result.get(block.id)?.categoryId === 'header') {
      if (!headersByPage.has(block.page)) headersByPage.set(block.page, []);
      headersByPage.get(block.page)!.push(block);
    }
  }
  for (const [, headers] of headersByPage) {
    if (headers.length <= 1) continue;
    headers.sort((a, b) => a.y - b.y);
    let kept = false;
    for (const header of headers) {
      const assignment = result.get(header.id)!;
      if (assignment.source === 'correction') { kept = true; continue; }
      if (!kept) { kept = true; continue; }
      result.set(header.id, { categoryId: 'body', source: 'heuristic', confidence: 0.5 });
    }
  }

  // ── Stage 5: corrections are final ────────────────────────────────────
  // Nothing above may alter a hand-set category. This is the guarantee the
  // labelling workflow depends on.
  for (const [blockId, categoryId] of corrections) {
    result.set(blockId, { categoryId, source: 'correction', confidence: 1 });
  }

  let changed = 0;
  let lowConfidence = 0;
  for (const block of blocks) {
    const assignment = result.get(block.id);
    if (!assignment) continue;
    if (assignment.categoryId !== block.category_id) changed++;
    if (assignment.source !== 'correction' && assignment.confidence < 0.15) lowConfidence++;
  }
  console.log(
    `[category-learner] recategorize: ${changed} changed, ${corrections.size} locked by hand, ` +
    `${centroidChanges} refined by centroid, ${lowConfidence} low-confidence`
  );

  return result;
}

/** Centroid of weighted samples (corrections count for more). */
function computeWeightedCentroid(
  samples: Array<{ vector: BlockFeatureVector; weight: number }>
): BlockFeatureVector {
  const centroid: any = {};
  for (const key of FEATURE_KEYS) centroid[key] = 0;
  let totalWeight = 0;
  for (const { vector, weight } of samples) {
    totalWeight += weight;
    for (const key of FEATURE_KEYS) centroid[key] += vector[key] * weight;
  }
  if (totalWeight > 0) {
    for (const key of FEATURE_KEYS) centroid[key] /= totalWeight;
  }
  return centroid as BlockFeatureVector;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block merging
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeGroup {
  blockIds: string[];
  blocks: TextBlock[];
}

/**
 * Does this text stop mid-thought?
 *
 * A trailing hyphen is a word broken across lines — unambiguous. Otherwise the
 * test is the absence of terminal punctuation: a line that ends without one is
 * a line the sentence continues past.
 */
function endsUnfinished(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  if (/[-\u2010\u2011]$/.test(t)) return true;
  // Only a full stop ends a paragraph. A colon or semicolon does NOT — and the
  // distinction is load-bearing here, because OCR misreads "poss" as "po:",
  // which a colon-terminated test would take for the end of a thought and
  // refuse to rejoin.
  return !/[.!?"'\u201d\u2019)\]]$/.test(t);
}

/** Does this text read as the continuation of the line before it? */
function startsAsContinuation(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  return /^[a-z\u00df-\u00ff]/.test(t);
}

/**
 * Two blocks that obviously belong to one another.
 *
 * This is the evidence that outranks geometry. OCR estimates font size from
 * bounding-box height, which on a scan routinely reports the two halves of one
 * broken sentence as different sizes — "…it wasn't po:" came back at 14 and
 * "ible to vote Social" at 8 — so a size gate refuses to rejoin text that is
 * plainly a single sentence. Wording is the more reliable witness here.
 */
function looksLikeContinuation(prev: TextBlock, curr: TextBlock): boolean {
  return endsUnfinished(prev.text) && startsAsContinuation(curr.text);
}

/** A trailing hyphen is a hard override: the word itself is split. */
function endsWithBrokenWord(text: string): boolean {
  return /[-\u2010\u2011]$/.test(text.trimEnd());
}

/**
 * Strip PDF subset prefix from font names.
 * PDF fonts often have prefixes like "BCDEFG+TimesNewRoman" where the prefix
 * differs between blocks even though they use the same font.
 */
function stripFontPrefix(fontName: string): string {
  // Pattern: 6 uppercase letters followed by '+' (PDF subset tag)
  const plusIdx = fontName.indexOf('+');
  if (plusIdx >= 1 && plusIdx <= 10) {
    return fontName.substring(plusIdx + 1);
  }
  return fontName;
}

/**
 * Detect groups of consecutive same-category blocks that can be merged into
 * one block per paragraph.
 *
 * Only single-line blocks are merged. A document re-ingested from an EPUB
 * (or a PDF) often arrives as one block per visual line; this consolidates
 * those line-blocks back into paragraphs. Multi-line blocks are already
 * paragraphs, so they are left untouched and also break a run (we never fold a
 * paragraph into its neighbour).
 *
 * Algorithm per page:
 * 1. Filter to visible text blocks (not deleted, not is_image, and not the
 *    retired `footnote_ref` — nothing assigns it since Jul 2026, but books
 *    labelled before then still carry it and must keep merging the same way)
 * 2. Sort by Y then X
 * 3. Walk sequentially, building merge groups where consecutive single-line
 *    blocks share:
 *    - Same category_id
 *    - Vertical gap < 2 * prev.font_size
 *    - X alignment within 3 * font_size
 *    - Same font_name (after stripping subset prefix) and font_size within 1pt
 *    A run is also cut at a paragraph boundary (a block in `paragraphBreaks`),
 *    so each emitted group is exactly one paragraph — multiple adjacent
 *    paragraphs never collapse into one giant block.
 * 4. Only emit groups with 2+ blocks
 *
 * @param paragraphBreaks Block IDs where a new paragraph starts (from the
 *   paragraph detector). When provided, runs are split at these boundaries.
 */
export function detectMergeableGroups(
  blocks: TextBlock[],
  deletedBlockIds: Set<string>,
  paragraphBreaks?: Set<string>
): MergeGroup[] {
  // Filter to visible text blocks
  const visible = blocks.filter(b =>
    !deletedBlockIds.has(b.id) &&
    !b.is_image &&
    b.category_id !== 'footnote_ref'
  );

  // Group by page
  const byPage = new Map<number, TextBlock[]>();
  for (const b of visible) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page)!.push(b);
  }

  // A block is mergeable only if it is a single line. Blocks missing line_count
  // (e.g. freshly re-ingested per-line blocks) are treated as single-line.
  const isSingleLine = (b: TextBlock) => (b.line_count ?? 1) <= 1;

  const groups: MergeGroup[] = [];

  for (const [, pageBlocks] of byPage) {
    if (pageBlocks.length < 2) continue;

    // Sort by Y then X
    const sorted = [...pageBlocks].sort((a, b) => a.y - b.y || a.x - b.x);

    let currentGroup: TextBlock[] = [];
    const flush = () => {
      if (currentGroup.length >= 2) {
        groups.push({
          blockIds: currentGroup.map(b => b.id),
          blocks: [...currentGroup],
        });
      }
      currentGroup = [];
    };

    for (const curr of sorted) {
      // A multi-line block is already a paragraph and is never folded into the
      // run before it — but it MAY seed a run, so that a last line the scan
      // stranded below it can rejoin the paragraph it belongs to.
      if (!isSingleLine(curr)) {
        flush();
        currentGroup = [curr];
        continue;
      }

      if (currentGroup.length === 0) {
        currentGroup = [curr];
        continue;
      }

      const prev = currentGroup[currentGroup.length - 1];
      const fontSize = Math.max(prev.font_size, 1);
      const verticalGap = curr.y - (prev.y + prev.height);

      const sameCategory = curr.category_id === prev.category_id;
      const closeVertically = verticalGap < 2 * fontSize;
      const alignedX = Math.abs(curr.x - prev.x) < 3 * fontSize;
      const sameFont = stripFontPrefix(curr.font_name) === stripFontPrefix(prev.font_name);
      const similarSize = Math.abs(curr.font_size - prev.font_size) <= 1.0;

      // Wording can outrank a font-size disagreement, but nothing else.
      //
      // OCR derives font size from bounding-box height, and on a scan it
      // routinely reports the two halves of ONE broken sentence as different
      // sizes — "…it wasn't po:" came back at 14 and "ible to vote Social" at
      // 8, so the size gate refused to rejoin a single word. When the text
      // plainly continues (no terminal punctuation, next starts lowercase) and
      // the two sit on the same left edge, the size disagreement is noise.
      //
      // Deliberately does NOT relax alignedX, sameCategory or sameFont. Left
      // edge and measure are precisely what separate a block quote from body
      // text — in a real book quotes sat at indent +23 with width 366 against
      // body's 0 and 410 — so merging across them would destroy a boundary the
      // user may not have labelled yet, and a merged block cannot be split back
      // into the two categories it came from.
      const sameLeftEdge = Math.abs(curr.x - prev.x) <= 12;
      const continues = looksLikeContinuation(prev, curr);
      const sizeOk = similarSize || (continues && sameLeftEdge);

      // One printed line that the scan split ACROSS rather than down.
      // Tesseract occasionally breaks a single line into segments when it
      // misreads size or hits noise mid-line: "…it wasn't po:" ended at x=360
      // and "ible to vote Social" began at x=368.7 on the same baseline —
      // one word, two blocks, side by side. The stacked-line rules above can
      // never see this, because the two are not above one another.
      //
      // Requires the vertical spans to genuinely overlap and the right edge of
      // one to nearly touch the left edge of the next, so a two-column layout
      // (separated by a wide gutter) can't be swept up.
      const verticalOverlap =
        Math.min(prev.y + prev.height, curr.y + curr.height) - Math.max(prev.y, curr.y);
      const shorter = Math.min(prev.height, curr.height);
      const onSameLine = shorter > 0 && verticalOverlap >= shorter * 0.5;
      const horizontalGap = curr.x - (prev.x + prev.width);
      const joinsAcross = onSameLine && horizontalGap > -4 && horizontalGap < 2 * fontSize && continues;

      // A detected paragraph break ends the run — unless the previous line ends
      // mid-word, which is unambiguous evidence the break is spurious.
      const paragraphBoundary = (paragraphBreaks?.has(curr.id) ?? false)
        && !endsWithBrokenWord(prev.text);

      const joinsDown = closeVertically && alignedX && sameFont && sizeOk && !paragraphBoundary;

      // Category agreement gates BOTH paths. A merged block cannot be split
      // back into the two categories it came from, so merging across an
      // unlabelled boundary would destroy work the user can never recover.
      if (sameCategory && (joinsDown || joinsAcross)) {
        currentGroup.push(curr);
      } else {
        flush();
        currentGroup = [curr];
      }
    }

    flush();
  }

  console.log('[detectMergeableGroups]', visible.length, 'visible blocks →', groups.length, 'merge groups (single-line, paragraph-bounded)');

  return groups;
}

/**
 * Create a merged TextBlock from a group of source blocks.
 *
 * - Bounding box: union of all source blocks
 * - Text: stacked lines joined as flowing prose (see line-join.ts)
 * - Inherits category_id, font_size, font_name, region from first block
 * - Provenance (`bf_group` / `bf_blocks`): see below — the merged block keeps
 *   the record of what it was made from, or it is not a record any more.
 */
export function createMergedBlock(mergedId: string, blocks: TextBlock[]): TextBlock {
  const first = blocks[0];

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of blocks) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }

  // Segments of ONE line that the scan split horizontally join directly, since any
  // separator there would break a word in half ("po:" + "ible").
  //
  // STACKED lines are page line-wraps, so they join as flowing prose — a single
  // space, except at a wrap hyphen (see line-join.ts). This used to join them with
  // a newline, and because mupdf hands back EPUBs as per-line blocks, that is what
  // put thousands of hard breaks into EPUB-sourced exports: measured across the
  // library, an EPUB with 1,219 authored paragraphs came back out as 104 blocks
  // carrying 4,480 mid-sentence line breaks, all of them audible in TTS.
  const mergedText = blocks.reduce((acc, b, i) => {
    if (i === 0) return b.text;
    const prev = blocks[i - 1];
    const overlap = Math.min(prev.y + prev.height, b.y + b.height) - Math.max(prev.y, b.y);
    const sameLine = Math.min(prev.height, b.height) > 0
      && overlap >= Math.min(prev.height, b.height) * 0.5;
    return sameLine ? acc + b.text : acc + lineSeparator(acc, b.text) + b.text;
  }, '');
  const totalLines = blocks.reduce((sum, b) => sum + (b.line_count || 1), 0);

  // Provenance travels with the text it describes. `bf_blocks` is the union in
  // reading order (deduplicated — an EPUB paragraph laid out as five lines gives
  // five blocks all naming the same source ids), which is the honest answer for
  // a merge however it was formed.
  //
  // `bf_group` is carried only when every source block that has one AGREES.
  // Merging lines of one authored paragraph is the normal case and they all
  // share its group; merging across a group boundary produces a block that came
  // from two elements, and naming one of them would be a claim the block cannot
  // support. Absent is the truth there, and the ids in `bf_blocks` still say
  // exactly what went in.
  const groups = new Set(blocks.map(b => b.bf_group).filter((g): g is string => g !== undefined));
  const sourceIds: string[] = [];
  const seenSourceIds = new Set<string>();
  for (const b of blocks) {
    // Undefined is a real state, not a missing value: a PDF block, or a block of
    // an EPUB nobody here wrote, has no provenance to carry.
    if (b.bf_blocks === undefined) continue;
    for (const id of b.bf_blocks) {
      if (seenSourceIds.has(id)) continue;
      seenSourceIds.add(id);
      sourceIds.push(id);
    }
  }

  return {
    id: mergedId,
    page: first.page,
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    text: mergedText,
    font_size: first.font_size,
    font_name: first.font_name,
    char_count: mergedText.length,
    region: first.region,
    category_id: first.category_id,
    is_bold: first.is_bold,
    is_italic: first.is_italic,
    is_superscript: false,
    is_image: false,
    is_footnote_marker: false,
    line_count: totalLines,
    ...(groups.size === 1 ? { bf_group: [...groups][0] } : {}),
    ...(sourceIds.length > 0 ? { bf_blocks: sourceIds } : {}),
  };
}

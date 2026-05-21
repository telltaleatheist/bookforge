/**
 * Category Re-detection Engine
 *
 * Nearest-centroid classifier with structural priors for re-classifying
 * PDF text blocks based on user corrections.
 *
 * Algorithm:
 * 1. Compute baselines from all blocks (body size, font, margin)
 * 2. Extract feature vectors for all blocks (14 dimensions)
 * 3. Build centroids for ALL existing categories from current block assignments
 * 4. Override centroids for corrected categories with correction-only centroids
 * 5. For each uncorrected block, find nearest centroid across ALL categories,
 *    check structural constraints, assign nearest valid category
 *
 * Key insight: centroids exist for every category that has blocks, so "body"
 * text has a centroid that defends it. Corrections replace their category's
 * centroid with a more accurate one, but uncorrected categories keep their
 * centroid and compete normally.
 */

import { TextBlock, PageDimension } from './pdf.service';

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
 */
export function computeBaselines(blocks: TextBlock[]): CategoryBaselines {
  // Body size: most common font size among non-bold, non-image body-region blocks
  const sizeChars = new Map<number, number>();
  for (const block of blocks) {
    if (block.region === 'body' && !block.is_bold && !block.is_image) {
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
    if (block.region === 'body' && !block.is_bold && !block.is_image) {
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
    if (block.region === 'body' && !block.is_image) {
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
    if (block.region === 'body' && !block.is_image && block.char_count > 50) {
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
 */
function passesStructuralConstraint(
  categoryType: string,
  block: TextBlock,
  baselines: CategoryBaselines,
  pageDimensions: PageDimension[],
  imagesByPage: Map<number, TextBlock[]>,
  blocksByPage: Map<number, TextBlock[]>
): boolean {
  const pageDim = pageDimensions[block.page];
  const pageHeight = pageDim?.height || 792;
  const yRatio = block.y / pageHeight;
  const bottomRatio = (block.y + block.height) / pageHeight;

  switch (categoryType) {
    case 'footnote':
      return yRatio > 0.6 && block.font_size < baselines.bodySize;

    case 'footnote_ref':
      return block.char_count <= 4 && (
        !!block.is_superscript || block.font_size < baselines.bodySize * 0.8
      );

    case 'header':
      // Page header must be near the top AND have nothing substantial above it
      return yRatio < 0.15 && (block.line_count || 1) <= 2
        && !hasSubstantialTextAbove(block, blocksByPage);

    case 'footer':
      // Page footer must be near the bottom AND have nothing substantial below it
      return bottomRatio > 0.85
        && !hasSubstantialTextBelow(block, blocksByPage);

    case 'caption':
      return isAdjacentToImage(block, imagesByPage) ||
        block.font_size < baselines.bodySize * 0.9;

    case 'image':
      return !!block.is_image;

    case 'title':
      return block.font_size > baselines.bodySize * 1.2 && block.char_count > 3;

    // body, heading, subheading, quote — no structural constraints
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
 * Heuristic block classification — port of classifyBlock() from pdf-analyzer.ts.
 * Used as fallback when no centroid is close enough.
 */
export function classifyBlockHeuristic(
  block: TextBlock,
  baselines: CategoryBaselines,
  imagesByPage: Map<number, TextBlock[]>,
  blocksByPage: Map<number, TextBlock[]>,
  pageDimensions: PageDimension[],
  repeatedTopTexts: Set<string>
): string {
  if (block.is_image) return 'image';

  if (isFootnoteMarkerText(block.text)) return 'footnote_ref';
  if (block.is_superscript) return 'footnote_ref';
  if (block.font_size < baselines.bodySize * 0.75 && block.char_count <= 4 && (block.line_count || 1) === 1) {
    return 'footnote_ref';
  }

  // Header detection via scoring
  if (block.region === 'header') {
    const score = computeHeaderScore(block, baselines, blocksByPage, repeatedTopTexts);
    return score >= 2 ? 'header' : 'body';
  }
  const pageHeight = pageDimensions[block.page]?.height || 800;
  const yPct = block.y / pageHeight;
  const text = block.text.trim();

  const looksLikeBodyText = block.char_count > 100 ||
    /[.!?]["']?\s+[A-Z]/.test(text) ||
    (text.endsWith('.') && block.char_count > 60);

  // Footer: only if nothing substantial below it AND it doesn't look like body text
  // Body text at the bottom of a page should remain "body", not get reclassified as "footer"
  const isBodyFontSize = block.font_size >= baselines.bodySize * 0.90;
  if (block.region === 'footer' && !hasSubstantialTextBelow(block, blocksByPage)
      && !looksLikeBodyText && !isBodyFontSize) return 'footer';

  const bottomPct = (block.y + block.height) / pageHeight;
  if ((block.line_count || 1) <= 2 && (yPct < 0.10 || bottomPct < 0.15) && !looksLikeBodyText) {
    const score = computeHeaderScore(block, baselines, blocksByPage, repeatedTopTexts);
    if (score >= 3) return 'header';
  }

  // Footnotes: multiple signals — font size, content pattern, gap above
  const isLowerHalf = block.y / pageHeight > 0.50;
  const hasSmallerFont = block.font_size < baselines.bodySize * 0.95;
  const hasFootnotePattern = startsWithFootnotePattern(block.text);
  const hasGap = hasSignificantGapAbove(block, blocksByPage, pageHeight);
  const bodyTextBelow = hasBodyTextBelowBlock(block, blocksByPage, baselines.bodySize);

  // Original rule: lower region + smaller font + no body text below
  if (block.region === 'lower' && hasSmallerFont && !bodyTextBelow) {
    return 'footnote';
  }

  // Content pattern in lower half — even at body font size
  if (isLowerHalf && hasFootnotePattern && !bodyTextBelow) {
    return 'footnote';
  }

  // Gap above + lower half — strong spatial signal (footnote separator)
  if (isLowerHalf && hasGap && hasSmallerFont) {
    return 'footnote';
  }

  // Gap above + content pattern — very strong combined signal
  if (hasGap && hasFootnotePattern) {
    return 'footnote';
  }

  // Caption detection
  const nearImage = isAdjacentToImage(block, imagesByPage);
  const differentFont = block.font_name !== baselines.bodyFont;
  const isItalicCaption = !!block.is_italic && !baselines.bodyIsItalic;

  if (block.font_size < baselines.bodySize * 0.85 && block.region !== 'lower') return 'caption';
  if (nearImage && isItalicCaption) return 'caption';
  if (nearImage && differentFont && (block.line_count || 1) <= 8) return 'caption';
  if (nearImage && block.font_size < baselines.bodySize * 0.95) return 'caption';

  // Large text = titles — but not drop caps (<=3 chars).
  if (block.font_size > baselines.bodySize * 1.4 && block.char_count > 3) return 'title';

  // Bold = headings
  if (block.is_bold) {
    if (block.font_size > baselines.bodySize * 1.1) return 'heading';
    if ((block.line_count || 1) <= 2 && block.char_count < 200) return 'subheading';
  }

  // Italic multi-line = quotes (not near images)
  if (block.is_italic && (block.line_count || 1) > 2 && !nearImage) return 'quote';

  return 'body';
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
// Main re-detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-classify all blocks using user corrections as training data.
 *
 * The algorithm builds centroids for ALL categories (not just corrected ones),
 * so every category "defends" its blocks. Corrections override their category's
 * centroid with a more accurate human-verified one. Each uncorrected block is
 * assigned to its nearest centroid, subject to structural constraints.
 *
 * @param blocks All text blocks in the document
 * @param corrections Map of blockId -> target categoryId (user corrections)
 * @param pageDimensions Per-page dimension data
 * @returns Map of blockId -> new categoryId for every non-image block
 */
export function redetectCategories(
  blocks: TextBlock[],
  corrections: Map<string, string>,
  pageDimensions: PageDimension[],
  deletedBlockIds?: Set<string>
): Map<string, string> {
  const result = new Map<string, string>();
  const baselines = computeBaselines(blocks);
  const imagesByPage = buildImageIndex(blocks);
  const repeatedTopTexts = detectRepeatedTopTexts(blocks, pageDimensions);
  const gapsAbove = computeGapsAbove(blocks);

  // Build blocksByPage for heuristic fallback and spatial checks.
  // Exclude deleted blocks (including merge sources) so spatial checks
  // like hasSubstantialTextBelow don't see phantom blocks.
  const blocksByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (!block.is_image && !(deletedBlockIds?.has(block.id))) {
      if (!blocksByPage.has(block.page)) blocksByPage.set(block.page, []);
      blocksByPage.get(block.page)!.push(block);
    }
  }
  for (const [, pageBlocks] of blocksByPage) {
    pageBlocks.sort((a, b) => a.y - b.y);
  }

  // Extract feature vectors for all non-image blocks
  const blockFeatures = new Map<string, BlockFeatureVector>();
  for (const block of blocks) {
    if (!block.is_image) {
      blockFeatures.set(block.id, extractBlockFeatures(block, baselines, pageDimensions, imagesByPage, gapsAbove));
    }
  }

  // ── Phase 1: Build centroids for ALL existing categories ──────────────
  // Group blocks by their CURRENT category_id
  const currentCategoryVectors = new Map<string, BlockFeatureVector[]>();
  for (const block of blocks) {
    if (block.is_image) continue;
    const features = blockFeatures.get(block.id);
    if (!features) continue;
    const catId = block.category_id;
    if (!currentCategoryVectors.has(catId)) currentCategoryVectors.set(catId, []);
    currentCategoryVectors.get(catId)!.push(features);
  }

  // Compute centroid for every category that has blocks
  const centroids = new Map<string, BlockFeatureVector>();
  for (const [catId, vectors] of currentCategoryVectors) {
    centroids.set(catId, computeCentroid(vectors));
  }

  // ── Phase 2: Override centroids for corrected categories ──────────────
  // For categories that have user corrections, replace the centroid with one
  // built from ONLY the corrected blocks (human-verified, more accurate).
  const correctedCategoryVectors = new Map<string, BlockFeatureVector[]>();
  for (const [blockId, categoryId] of corrections) {
    const features = blockFeatures.get(blockId);
    if (!features) continue;
    if (!correctedCategoryVectors.has(categoryId)) correctedCategoryVectors.set(categoryId, []);
    correctedCategoryVectors.get(categoryId)!.push(features);
  }

  const correctedCategories = new Set<string>();
  for (const [categoryId, vectors] of correctedCategoryVectors) {
    centroids.set(categoryId, computeCentroid(vectors));
    correctedCategories.add(categoryId);
  }

  console.log(`[category-learner] Centroids: ${centroids.size} total, ${correctedCategories.size} from corrections`);

  // ── Phase 3: Compute discriminative feature weights ───────────────────
  const featureWeights = computeDiscriminativeWeights(centroids);

  // Block lookup for structural constraint checks
  const blocksById = new Map<string, TextBlock>();
  for (const block of blocks) {
    blocksById.set(block.id, block);
  }

  // ── Phase 4: Classify each block ─────────────────────────────────────
  let changedCount = 0;

  for (const block of blocks) {
    // Image blocks keep their classification
    if (block.is_image) {
      result.set(block.id, block.category_id);
      continue;
    }

    // Corrected blocks keep their correction
    if (corrections.has(block.id)) {
      result.set(block.id, corrections.get(block.id)!);
      continue;
    }

    const features = blockFeatures.get(block.id);
    if (!features) {
      result.set(block.id, block.category_id);
      continue;
    }

    // Find nearest centroid across ALL categories (corrected and uncorrected).
    // Sort candidates by distance, pick first that passes structural constraints.
    const candidates: Array<{ categoryId: string; distance: number }> = [];
    for (const [categoryId, centroid] of centroids) {
      const distance = weightedDistance(features, centroid, featureWeights);
      candidates.push({ categoryId, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);

    let assigned = false;
    const pageH = pageDimensions[block.page]?.height || 800;
    const bPct = (block.y + block.height) / pageH;
    const isBottomBlock = bPct > 0.80;

    for (const candidate of candidates) {
      if (passesStructuralConstraint(candidate.categoryId, block, baselines, pageDimensions, imagesByPage, blocksByPage)) {
        result.set(block.id, candidate.categoryId);
        if (candidate.categoryId !== block.category_id) changedCount++;
        assigned = true;
        // Diagnostic: why didn't a bottom block get assigned footer?
        if (isBottomBlock && candidate.categoryId !== 'footer' && block.category_id === 'title') {
          const top3 = candidates.slice(0, 3).map(c => `${c.categoryId}:${c.distance.toFixed(2)}`);
          console.log('[redetect] Bottom title block not assigned footer:',
            'text:', JSON.stringify(block.text.substring(0, 40)),
            'assigned:', candidate.categoryId,
            'top3:', top3.join(', '),
            'region:', block.region, 'bottomPct:', bPct.toFixed(3));
        }
        break;
      }
    }

    if (!assigned) {
      // No centroid passed structural constraints — fall back to heuristic
      const heuristicType = classifyBlockHeuristic(
        block, baselines, imagesByPage, blocksByPage, pageDimensions, repeatedTopTexts
      );
      result.set(block.id, heuristicType);
      if (heuristicType !== block.category_id) changedCount++;
      if (isBottomBlock && heuristicType !== 'footer') {
        console.log('[redetect] Bottom block heuristic fallback:',
          'text:', JSON.stringify(block.text.substring(0, 40)),
          'result:', heuristicType, 'region:', block.region, 'bottomPct:', bPct.toFixed(3));
      }
    }
  }

  // ── Phase 5: Post-processing ──────────────────────────────────────────
  // Enforce one header per page
  const headersByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    const catId = result.get(block.id);
    if (catId === 'header') {
      if (!headersByPage.has(block.page)) headersByPage.set(block.page, []);
      headersByPage.get(block.page)!.push(block);
    }
  }
  for (const [, headers] of headersByPage) {
    if (headers.length > 1) {
      headers.sort((a, b) => a.y - b.y);
      for (let i = 1; i < headers.length; i++) {
        result.set(headers[i].id, 'body');
      }
    }
  }

  console.log(`[category-learner] Re-detection complete: ${changedCount} blocks changed`);

  return result;
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

  // Footnote references
  if (isFootnoteMarkerText(block.text)) return 'footnote_ref';
  if (block.is_superscript) return 'footnote_ref';
  if (block.font_size < baselines.bodySize * thresholds.footnoteRef.maxFontRatio
      && block.char_count <= thresholds.footnoteRef.maxChars
      && (block.line_count || 1) === 1) {
    return 'footnote_ref';
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

  if (block.font_size < baselines.bodySize * thresholds.caption.smallFontRatio && region !== 'lower') return 'caption';
  if (nearImage && isItalicCaption) return 'caption';
  if (nearImage && differentFont && (block.line_count || 1) <= thresholds.caption.maxLinesNearImage) return 'caption';
  if (nearImage && block.font_size < baselines.bodySize * thresholds.caption.nearImageFontRatio) return 'caption';

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

/**
 * Re-classify all blocks using user-adjustable thresholds.
 *
 * Key difference from redetectCategories(): this doesn't use centroids.
 * It re-runs heuristic classification with the user's adjusted thresholds,
 * recomputing regions from raw Y positions (fixing the "footnote as footer" problem).
 *
 * Explicit user corrections (categoryCorrections) are preserved.
 */
export function recategorizeWithThresholds(
  blocks: TextBlock[],
  corrections: Map<string, string>,
  pageDimensions: PageDimension[],
  thresholds: ClassificationThresholds,
  deletedBlockIds?: Set<string>
): Map<string, string> {
  const result = new Map<string, string>();
  const baselines = computeBaselines(blocks);
  const imagesByPage = buildImageIndex(blocks);
  const repeatedTopTexts = detectRepeatedTopTexts(blocks, pageDimensions);

  // Build blocksByPage index — exclude deleted blocks (including merge sources)
  // so spatial checks like hasSubstantialTextBelow don't see phantom blocks.
  const blocksByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (!block.is_image && !(deletedBlockIds?.has(block.id))) {
      if (!blocksByPage.has(block.page)) blocksByPage.set(block.page, []);
      blocksByPage.get(block.page)!.push(block);
    }
  }
  for (const [, pageBlocks] of blocksByPage) {
    pageBlocks.sort((a, b) => a.y - b.y);
  }

  let changedCount = 0;

  for (const block of blocks) {
    // Image blocks keep their classification
    if (block.is_image) {
      result.set(block.id, 'image');
      continue;
    }

    // Preserve explicit user corrections
    if (corrections.has(block.id)) {
      result.set(block.id, corrections.get(block.id)!);
      continue;
    }

    // Recompute region from raw Y position using user's thresholds
    const pageHeight = pageDimensions[block.page]?.height || 800;
    const region = computeRegion(block, pageHeight, thresholds);

    const newCategory = classifyBlockWithThresholds(
      block, region, baselines, imagesByPage, blocksByPage,
      pageDimensions, repeatedTopTexts, thresholds
    );

    // Diagnostic: log blocks in bottom 20% that get classified as title
    const pageH = pageDimensions[block.page]?.height || 800;
    const bPct = (block.y + block.height) / pageH;
    if (newCategory === 'title' && bPct > 0.80) {
      console.log('[recategorize] Bottom block classified as title:',
        'text:', JSON.stringify(block.text.substring(0, 40)),
        'page:', block.page,
        'region:', region,
        'bottomPct:', bPct.toFixed(3),
        'fontSize:', block.font_size, 'bodySize:', baselines.bodySize,
        'charCount:', block.char_count,
        'belowCheck:', hasSubstantialTextBelow(block, blocksByPage));
    }

    result.set(block.id, newCategory);
    if (newCategory !== block.category_id) changedCount++;
  }

  // Post-processing: enforce one header per page (keep topmost)
  const headersByPage = new Map<number, TextBlock[]>();
  for (const block of blocks) {
    if (result.get(block.id) === 'header') {
      if (!headersByPage.has(block.page)) headersByPage.set(block.page, []);
      headersByPage.get(block.page)!.push(block);
    }
  }
  for (const [, headers] of headersByPage) {
    if (headers.length > 1) {
      headers.sort((a, b) => a.y - b.y);
      for (let i = 1; i < headers.length; i++) {
        result.set(headers[i].id, 'body');
      }
    }
  }

  console.log(`[category-learner] Threshold re-categorization: ${changedCount} blocks changed`);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block merging
// ─────────────────────────────────────────────────────────────────────────────

export interface MergeGroup {
  blockIds: string[];
  blocks: TextBlock[];
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
 * Detect groups of consecutive same-category blocks that can be merged.
 *
 * Algorithm per page:
 * 1. Filter to visible text blocks (not deleted, not is_image, not footnote_ref)
 * 2. Sort by Y then X
 * 3. Walk sequentially, building merge groups where consecutive blocks share:
 *    - Same category_id
 *    - Vertical gap < 2 * prev.font_size
 *    - X alignment within 3 * font_size
 *    - Same font_name (after stripping subset prefix) and font_size within 1pt
 * 4. Only emit groups with 2+ blocks
 */
export function detectMergeableGroups(
  blocks: TextBlock[],
  deletedBlockIds: Set<string>
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

  const groups: MergeGroup[] = [];
  let rejections = 0;

  for (const [, pageBlocks] of byPage) {
    if (pageBlocks.length < 2) continue;

    // Sort by Y then X
    const sorted = [...pageBlocks].sort((a, b) => a.y - b.y || a.x - b.x);

    let currentGroup: TextBlock[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      const prevBottom = prev.y + prev.height;
      const verticalGap = curr.y - prevBottom;
      const fontSize = Math.max(prev.font_size, 1);

      const sameCategory = curr.category_id === prev.category_id;
      const closeVertically = verticalGap < 2 * fontSize;
      const alignedX = Math.abs(curr.x - prev.x) < 3 * fontSize;
      const sameFont = stripFontPrefix(curr.font_name) === stripFontPrefix(prev.font_name);
      const similarSize = Math.abs(curr.font_size - prev.font_size) <= 1.0;

      if (sameCategory && closeVertically && alignedX && sameFont && similarSize) {
        currentGroup.push(curr);
      } else {
        if (currentGroup.length >= 2) {
          groups.push({
            blockIds: currentGroup.map(b => b.id),
            blocks: [...currentGroup],
          });
        }
        if (rejections < 5 && sameCategory) {
          console.log('[detectMergeableGroups] Rejected merge:',
            'gap:', verticalGap.toFixed(1), 'vs', (2 * fontSize).toFixed(1),
            'xDiff:', Math.abs(curr.x - prev.x).toFixed(1), 'vs', (3 * fontSize).toFixed(1),
            'font:', stripFontPrefix(prev.font_name), 'vs', stripFontPrefix(curr.font_name),
            'size:', prev.font_size, 'vs', curr.font_size,
            'cat:', prev.category_id, 'vs', curr.category_id);
          rejections++;
        }
        currentGroup = [curr];
      }
    }

    // Flush last group
    if (currentGroup.length >= 2) {
      groups.push({
        blockIds: currentGroup.map(b => b.id),
        blocks: [...currentGroup],
      });
    }
  }

  console.log('[detectMergeableGroups]', visible.length, 'visible blocks →', groups.length, 'merge groups');

  return groups;
}

/**
 * Create a merged TextBlock from a group of source blocks.
 *
 * - Bounding box: union of all source blocks
 * - Text: blocks joined with \n
 * - Inherits category_id, font_size, font_name, region from first block
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

  const mergedText = blocks.map(b => b.text).join('\n');
  const totalLines = blocks.reduce((sum, b) => sum + (b.line_count || 1), 0);

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
  };
}

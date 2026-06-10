/**
 * Paragraph Detection Engine
 *
 * Pure stateless module for detecting paragraph boundaries in PDF text blocks.
 * PDFs often encode each visual line as a separate text block, destroying paragraph
 * structure. This engine learns from user-provided training examples to distinguish
 * paragraph breaks from line continuations.
 *
 * Uses three signal types:
 * 1. Spatial features (learned): vertical gap, indentation, last-line width
 * 2. Text-content priors (fixed): sentence-ending punctuation, lowercase starts, hyphenation
 * 3. Hard overrides: hyphenated word splits are always continuations
 */

import { TextBlock } from './pdf.service';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentBaselines {
  bodySize: number;           // Most common font size in body region
  bodyFont: string;           // Most common font name in body region
  bodyMarginX: number;        // Most common left edge of body blocks
  expectedLineWidth: number;  // Median width of body blocks (full-line proxy)
  typicalGapRatio: number;    // Median vertical gap ratio between consecutive body lines
}

export interface BoundaryFeatures {
  blockAId: string;
  blockBId: string;
  verticalGapRatio: number;   // (B.y - (A.y + A.height)) / bodySize
  indentationRatio: number;   // (B.x - bodyMarginX) / bodySize
  lastLineWidthRatio: number; // A.width / expectedLineWidth
  sameFontSize: boolean;
  sameFontName: boolean;
  sameBold: boolean;
  sameItalic: boolean;
  blockACharCount: number;
  blockBCharCount: number;
  // Text-content signals
  endsWithHyphen: boolean;    // Block A ends with a hyphenated word split
  endsWithSentenceEnd: boolean; // Block A ends with sentence-ending punctuation (.!?")
  startsWithLowercase: boolean; // Block B starts with a lowercase letter
}

export interface LearnedModel {
  weights: FeatureWeights;
  threshold: number;
}

export interface FeatureWeights {
  verticalGap: number;
  indentation: number;
  lastLineWidth: number;
  fontSizeChange: number;
  fontNameChange: number;
  boldChange: number;
  italicChange: number;
}

export interface DetectionConfig {
  weights: FeatureWeights;
  threshold: number;
  indentationCutoff: number;      // default 1.5 — indent ratio above which block is always a break
  gapMultiplier: number;          // default 2.5 — gap vs typical ratio above which block is always a break
  shortLineDeadZone: number;      // default 0.92 — lines wider than this fraction are "full"
  sentenceEndingOverride: boolean; // default true — blocks not ending in sentence punctuation are continuations
}

export function getDefaultConfig(): DetectionConfig {
  return {
    weights: { verticalGap: 0.5, indentation: 0.3, lastLineWidth: 0.2, fontSizeChange: 0, fontNameChange: 0, boldChange: 0, italicChange: 0 },
    threshold: 0.4,
    indentationCutoff: 1.5,
    gapMultiplier: 2.5,
    shortLineDeadZone: 0.92,
    sentenceEndingOverride: true,
  };
}

export interface DetectionResult {
  breaks: Set<string>;
  model: LearnedModel;
  baselines: DocumentBaselines;
  stats: DetectionStats;
  config: DetectionConfig;
}

export interface DetectionStats {
  totalBoundaries: number;
  paragraphBreaks: number;
  continuations: number;
  weights: FeatureWeights;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1a. Document Baselines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute document baselines from body-region blocks.
 * Mirrors the approach in pdf-analyzer.ts generateCategories().
 */
export function computeBaselines(blocks: TextBlock[], deletedBlockIds: Set<string>): DocumentBaselines {
  const bodyBlocks = blocks.filter(b =>
    !deletedBlockIds.has(b.id) &&
    !b.is_image &&
    b.region === 'body'
  );

  // Most common font size
  const sizeCounts = new Map<number, number>();
  for (const b of bodyBlocks) {
    sizeCounts.set(b.font_size, (sizeCounts.get(b.font_size) || 0) + b.char_count);
  }
  let bodySize = 12; // fallback
  let maxSizeCount = 0;
  for (const [size, count] of sizeCounts) {
    if (count > maxSizeCount) {
      maxSizeCount = count;
      bodySize = size;
    }
  }

  // Most common font name
  const fontCounts = new Map<string, number>();
  for (const b of bodyBlocks) {
    fontCounts.set(b.font_name, (fontCounts.get(b.font_name) || 0) + b.char_count);
  }
  let bodyFont = '';
  let maxFontCount = 0;
  for (const [font, count] of fontCounts) {
    if (count > maxFontCount) {
      maxFontCount = count;
      bodyFont = font;
    }
  }

  // Most common left edge (bodyMarginX) -- quantize to reduce noise
  const marginCounts = new Map<number, number>();
  for (const b of bodyBlocks) {
    const quantized = Math.round(b.x * 2) / 2; // round to 0.5
    marginCounts.set(quantized, (marginCounts.get(quantized) || 0) + 1);
  }
  let bodyMarginX = 0;
  let maxMarginCount = 0;
  for (const [margin, count] of marginCounts) {
    if (count > maxMarginCount) {
      maxMarginCount = count;
      bodyMarginX = margin;
    }
  }

  // Median width of body blocks (full-line proxy)
  const widths = bodyBlocks.map(b => b.width).sort((a, b) => a - b);
  const expectedLineWidth = widths.length > 0
    ? widths[Math.floor(widths.length / 2)]
    : 400; // fallback

  // Typical vertical gap ratio between consecutive body lines (excluding page crossings
  // and same-line blocks). Used to distinguish normal line spacing from paragraph gaps.
  const sorted = bodyBlocks.sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);
  const gapRatios: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].page !== sorted[i - 1].page) continue;
    const yDiff = sorted[i].y - sorted[i - 1].y;
    if (yDiff < bodySize * 0.5) continue; // same-line block
    const gap = sorted[i].y - (sorted[i - 1].y + sorted[i - 1].height);
    if (bodySize > 0) gapRatios.push(gap / bodySize);
  }
  gapRatios.sort((a, b) => a - b);
  const typicalGapRatio = gapRatios.length > 0
    ? gapRatios[Math.floor(gapRatios.length / 2)]
    : 0;

  return { bodySize, bodyFont, bodyMarginX, expectedLineWidth, typicalGapRatio };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Boundary Features
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get body blocks sorted by page then Y position.
 */
export function getSortedBodyBlocks(
  blocks: TextBlock[],
  deletedBlockIds: Set<string>
): TextBlock[] {
  return blocks
    .filter(b =>
      !deletedBlockIds.has(b.id) &&
      !b.is_image &&
      b.region === 'body'
    )
    .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);
}

/**
 * Check if two blocks are on the same visual line.
 * Inline formatting (italic/bold) splits one line into multiple blocks.
 * Same-line blocks share approximately the same Y coordinate (baseline).
 * Consecutive lines have a Y jump of at least one line height (~bodySize).
 */
function isSameLine(a: TextBlock, b: TextBlock, baselines: DocumentBaselines): boolean {
  if (a.page !== b.page) return false;
  // Use Y-coordinate difference, not gap. PDF block heights often include
  // leading, making the gap between consecutive lines ~0. But the Y jump
  // between lines is always at least bodySize.
  return (b.y - a.y) < baselines.bodySize * 0.5;
}

/**
 * Detect if a block is likely a drop cap (decorative initial letter).
 * Drop caps are typically 1-3 characters with a significantly larger font size.
 */
function isLikelyDropCap(block: TextBlock, baselines: DocumentBaselines): boolean {
  if (block.char_count > 3) return false;
  // Must have a noticeably larger font size than body text (at least 50% bigger)
  if (block.font_size <= baselines.bodySize * 1.5) return false;
  // Text should be mostly letters (not punctuation or numbers)
  const text = block.text.trim();
  if (text.length === 0) return false;
  return /^[A-Za-z\u00C0-\u024F"'\u2018\u2019\u201C\u201D]{1,3}$/.test(text);
}

/**
 * Check if block text ends with a hyphenated word split.
 * Matches "hor-" at line end (word broken across lines), but NOT
 * em-dashes, en-dashes, or hyphenated compound words like "well-known".
 */
function endsWithWordHyphen(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('-')) return false;
  // Must not be an em-dash or en-dash
  if (trimmed.endsWith('\u2014') || trimmed.endsWith('\u2013')) return false;
  // Must not be a standalone hyphen or double hyphen
  if (trimmed.endsWith('--')) return false;
  // The character before the hyphen should be a lowercase letter (word fragment)
  const beforeHyphen = trimmed.charAt(trimmed.length - 2);
  return /[a-z\u00E0-\u00FF]/.test(beforeHyphen);
}

/**
 * Check if block text ends with sentence-ending punctuation.
 * Recognizes . ! ? … ) " \u201D as direct terminals, then falls back
 * to stripping trailing quotes/parens for nested cases like 'hmm."'.
 */
function endsWithSentencePunctuation(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  const lastChar = trimmed.charAt(trimmed.length - 1);
  // Direct terminals — these characters end sentences on their own
  if ('.!?\u2026)\u201D"'.includes(lastChar)) return true;
  // Fallback: strip trailing closing quotes/parens/brackets, then check
  const stripped = trimmed.replace(/[\u201D\u2019"')}\]]+$/, '');
  if (stripped.length === 0) return false;
  const inner = stripped.charAt(stripped.length - 1);
  return '.!?\u2026'.includes(inner);
}

/**
 * Check if block text starts with a lowercase letter.
 * Skips leading quotes/parens.
 */
function startsWithLowercaseLetter(text: string): boolean {
  const trimmed = text.trimStart();
  // Skip leading opening quotes/parens
  const stripped = trimmed.replace(/^[\u201C\u2018"'(\[]+/, '');
  if (stripped.length === 0) return false;
  const firstChar = stripped.charAt(0);
  return firstChar === firstChar.toLowerCase() && firstChar !== firstChar.toUpperCase();
}

/**
 * Compute boundary features between two adjacent body blocks.
 */
export function computeBoundaryFeatures(
  blockA: TextBlock,
  blockB: TextBlock,
  baselines: DocumentBaselines
): BoundaryFeatures {
  // Vertical gap: distance from bottom of A to top of B, normalized by body font size
  let verticalGapRatio: number;
  if (blockA.page !== blockB.page) {
    // Cross-page: neutral by default, but slightly positive if block A ends with
    // sentence-ending punctuation (likely a paragraph boundary at page break)
    verticalGapRatio = endsWithSentencePunctuation(blockA.text) ? 0.15 : 0;
  } else {
    const gap = blockB.y - (blockA.y + blockA.height);
    verticalGapRatio = baselines.bodySize > 0 ? gap / baselines.bodySize : 0;
  }

  // Indentation: how far B's left edge is from the baseline margin
  const indentationRatio = baselines.bodySize > 0
    ? (blockB.x - baselines.bodyMarginX) / baselines.bodySize
    : 0;

  // Drop cap detection: if blockA is a drop cap, suppress font-related signals
  // because the large decorative initial is part of the same paragraph as blockB.
  // Also suppress last-line-width since a drop cap is naturally narrow.
  const dropCapA = isLikelyDropCap(blockA, baselines);

  // Last line width: how much of the expected line width A occupies
  // For drop caps, treat as full width (neutral) to avoid false "short line = break" signal
  const lastLineWidthRatio = dropCapA ? 1 : (
    baselines.expectedLineWidth > 0
      ? blockA.width / baselines.expectedLineWidth
      : 1
  );

  return {
    blockAId: blockA.id,
    blockBId: blockB.id,
    verticalGapRatio,
    indentationRatio,
    lastLineWidthRatio,
    sameFontSize: dropCapA ? true : blockA.font_size === blockB.font_size,
    sameFontName: dropCapA ? true : blockA.font_name === blockB.font_name,
    sameBold: (blockA.is_bold || false) === (blockB.is_bold || false),
    sameItalic: (blockA.is_italic || false) === (blockB.is_italic || false),
    blockACharCount: blockA.char_count,
    blockBCharCount: blockB.char_count,
    endsWithHyphen: dropCapA ? false : endsWithWordHyphen(blockA.text),
    endsWithSentenceEnd: endsWithSentencePunctuation(blockA.text),
    startsWithLowercase: startsWithLowercaseLetter(blockB.text),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1c. Learning from Breaks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Learn a classification model from user-placed paragraph breaks.
 *
 * Training data comes only from regions the user actively annotated:
 * - External (break) examples: boundaries at each manual break
 * - Internal (continuation) examples: boundaries between consecutive breaks,
 *   where the user was working and chose NOT to place breaks
 *
 * Boundaries outside annotated regions are ignored — they're unknown, not
 * confirmed continuations, and including them would drown the signal.
 */
export function learnFromBreaks(
  blocks: TextBlock[],
  manualBreaks: Set<string>,
  baselines: DocumentBaselines,
  deletedBlockIds?: Set<string>,
  shortLineDeadZone = 0.92
): LearnedModel {
  const sorted = getSortedBodyBlocks(blocks, deletedBlockIds || new Set());

  // Find sorted indices of blocks with manual breaks
  const breakIndices: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (manualBreaks.has(sorted[i].id)) {
      breakIndices.push(i);
    }
  }

  if (breakIndices.length === 0) {
    // No training data: use a balanced heuristic default that weighs all three
    // spatial signals. Clear cases (indentation >= 1.5× body size, large gaps)
    // are caught by hard overrides in detectParagraphBreaks, so the threshold
    // here should be conservative to avoid false positives on every sentence
    // boundary within a paragraph.
    return {
      weights: { verticalGap: 0.5, indentation: 0.3, lastLineWidth: 0.2, fontSizeChange: 0, fontNameChange: 0, boldChange: 0, italicChange: 0 },
      threshold: 0.4,
    };
  }

  const internalFeatures: BoundaryFeatures[] = [];
  const externalFeatures: BoundaryFeatures[] = [];
  const breakSet = new Set(breakIndices);

  // For each manual break, collect training data from the local neighborhood.
  // The break boundary itself is external; nearby non-break boundaries are internal.
  // This avoids treating distant unlabeled boundaries as confirmed continuations.
  const WINDOW = 4;
  const usedPairs = new Set<number>(); // avoid duplicate boundary entries

  for (const idx of breakIndices) {
    // External: the boundary at the break (block above → break block)
    if (idx > 0 && !usedPairs.has(idx)) {
      const features = computeBoundaryFeatures(sorted[idx - 1], sorted[idx], baselines);
      // Skip hyphenated boundaries from training — they're hard overrides, not learnable
      if (!features.endsWithHyphen) {
        externalFeatures.push(features);
      }
      usedPairs.add(idx);
    }

    // Internal: nearby boundaries that aren't breaks.
    // Skip same-line boundaries (inline formatting) — they have misleading spatial features.
    // Above the break (within the previous paragraph):
    for (let i = Math.max(1, idx - WINDOW); i < idx; i++) {
      if (!breakSet.has(i) && !usedPairs.has(i) && !isSameLine(sorted[i - 1], sorted[i], baselines)) {
        const features = computeBoundaryFeatures(sorted[i - 1], sorted[i], baselines);
        if (!features.endsWithHyphen) {
          internalFeatures.push(features);
        }
        usedPairs.add(i);
      }
    }
    // Below the break (within the new paragraph):
    for (let i = idx + 1; i <= Math.min(sorted.length - 1, idx + WINDOW); i++) {
      if (!breakSet.has(i) && !usedPairs.has(i) && !isSameLine(sorted[i - 1], sorted[i], baselines)) {
        const features = computeBoundaryFeatures(sorted[i - 1], sorted[i], baselines);
        if (!features.endsWithHyphen) {
          internalFeatures.push(features);
        }
        usedPairs.add(i);
      }
    }
  }

  // Only use spatial features for weight computation.
  // Boolean features (font name/size/bold/italic changes) are unreliable for PDFs
  // because inline formatting (italic words, drop caps) creates separate text blocks
  // with style changes that have nothing to do with paragraph structure.
  const gapWeight = computeContinuousWeight(
    internalFeatures.map(f => f.verticalGapRatio),
    externalFeatures.map(f => f.verticalGapRatio)
  );

  const indentWeight = computeContinuousWeight(
    internalFeatures.map(f => f.indentationRatio),
    externalFeatures.map(f => f.indentationRatio)
  );

  const widthWeight = computeContinuousWeight(
    internalFeatures.map(f => f.lastLineWidthRatio),
    externalFeatures.map(f => f.lastLineWidthRatio)
  );

  // Normalize spatial weights to sum to 1
  const totalWeight = gapWeight + indentWeight + widthWeight;
  const weights: FeatureWeights = totalWeight > 0
    ? {
        verticalGap: gapWeight / totalWeight,
        indentation: indentWeight / totalWeight,
        lastLineWidth: widthWeight / totalWeight,
        fontSizeChange: 0,
        fontNameChange: 0,
        boldChange: 0,
        italicChange: 0,
      }
    : { verticalGap: 1, indentation: 0, lastLineWidth: 0, fontSizeChange: 0, fontNameChange: 0, boldChange: 0, italicChange: 0 };

  // Compute threshold: midpoint between mean internal score and mean external score.
  // scoreBoundary includes text-content priors, so the threshold accounts for them.
  const internalScores = internalFeatures.map(f => scoreBoundary(f, weights, shortLineDeadZone));
  const externalScores = externalFeatures.map(f => scoreBoundary(f, weights, shortLineDeadZone));

  const meanInternal = internalScores.length > 0
    ? internalScores.reduce((s, v) => s + v, 0) / internalScores.length
    : 0;
  const meanExternal = externalScores.length > 0
    ? externalScores.reduce((s, v) => s + v, 0) / externalScores.length
    : 1;

  const threshold = (meanInternal + meanExternal) / 2;

  return { weights, threshold };
}

/**
 * Score a boundary: higher = more likely a paragraph break.
 *
 * Combines learned spatial features with fixed text-content priors.
 * Text priors are applied during both training and inference so the
 * threshold is calibrated against the full scoring function.
 */
function scoreBoundary(
  features: BoundaryFeatures,
  weights: FeatureWeights,
  shortLineDeadZone = 0.92
): number {
  // Normalize spatial weights so they sum to 1 (keeps scores in a
  // consistent range regardless of raw slider values).
  const totalW = weights.verticalGap + weights.indentation + weights.lastLineWidth;
  const wGap = totalW > 0 ? weights.verticalGap / totalW : 0;
  const wIndent = totalW > 0 ? weights.indentation / totalW : 0;
  const wWidth = totalW > 0 ? weights.lastLineWidth / totalW : 0;

  let score = 0;

  // ── Learned spatial features ──────────────────────────────────────────

  // Larger gap → more likely break
  score += wGap * features.verticalGapRatio;

  // Larger indentation → more likely break (new paragraph indent)
  score += wIndent * Math.abs(features.indentationRatio);

  // Shorter last line → more likely break (paragraph ended before margin).
  // Dead zone: lines wider than shortLineDeadZone fraction are treated as full.
  // This prevents nearly-full lines from producing false break signals.
  const shortLineFactor = features.lastLineWidthRatio < shortLineDeadZone
    ? (shortLineDeadZone - features.lastLineWidthRatio) / shortLineDeadZone
    : 0;
  score += wWidth * shortLineFactor;

  // ── Fixed text-content priors ─────────────────────────────────────────
  // These are weak tie-breakers, not primary signals. Sentence-ending
  // punctuation is extremely common mid-paragraph (every sentence ends
  // with one), so it should only nudge the score slightly.

  // Block A ends with sentence-ending punctuation → weak pro-break
  if (features.endsWithSentenceEnd) {
    score += 0.08;
  }

  // Block B starts with lowercase → weak anti-break (mid-sentence continuation)
  if (features.startsWithLowercase) {
    score -= 0.08;
  }

  return score;
}

/**
 * Compute separation weight for a continuous feature.
 * Returns normalized distance between internal and external distributions.
 */
function computeContinuousWeight(internal: number[], external: number[]): number {
  if (internal.length === 0 || external.length === 0) return 0;

  const maxInternal = Math.max(...internal);
  const minExternal = Math.min(...external);

  // If external values are consistently larger than internal, good separation
  const separation = minExternal - maxInternal;
  if (separation <= 0) {
    // Distributions overlap — check if means are at least different
    const meanI = internal.reduce((s, v) => s + v, 0) / internal.length;
    const meanE = external.reduce((s, v) => s + v, 0) / external.length;
    const diff = Math.abs(meanE - meanI);
    // Small weight proportional to mean difference
    const range = Math.max(
      Math.max(...external) - Math.min(...internal),
      1e-6
    );
    return diff / range * 0.3; // dampened when overlapping
  }

  // Clean separation — weight proportional to gap relative to range
  const range = Math.max(
    Math.max(...external) - Math.min(...internal),
    1e-6
  );
  return Math.min(separation / range, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1d. Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect paragraph breaks across all body blocks.
 * Returns a Set of block IDs where a new paragraph starts.
 * Manual breaks are always preserved — the model only decides boundaries
 * the user hasn't explicitly placed.
 */
export function detectParagraphBreaks(
  blocks: TextBlock[],
  model: LearnedModel,
  baselines: DocumentBaselines,
  deletedBlockIds: Set<string>,
  chapterBlockIds?: Set<string>,
  manualBreaks?: Set<string>,
  config?: DetectionConfig
): DetectionResult {
  const cfg: DetectionConfig = config ?? {
    ...getDefaultConfig(),
    weights: model.weights,
    threshold: model.threshold,
  };
  const sorted = getSortedBodyBlocks(blocks, deletedBlockIds);
  const breaks = new Set<string>();
  let paragraphBreakCount = 0;
  let continuationCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];

    // First body block always starts a paragraph
    if (i === 0) {
      breaks.add(block.id);
      continue;
    }

    // Manual breaks are always preserved
    if (manualBreaks?.has(block.id)) {
      breaks.add(block.id);
      paragraphBreakCount++;
      continue;
    }

    // Chapter boundary blocks always start paragraphs
    if (chapterBlockIds?.has(block.id)) {
      breaks.add(block.id);
      paragraphBreakCount++;
      continue;
    }

    const prev = sorted[i - 1];

    // Skip same-line boundaries: inline formatting (italic/bold words) creates
    // separate blocks on the same visual line. Same-line blocks share approximately
    // the same Y coordinate — the Y jump between real lines is at least bodySize.
    if (isSameLine(prev, block, baselines)) {
      continuationCount++;
      continue;
    }

    const features = computeBoundaryFeatures(prev, block, baselines);

    // Hard override: hyphenated word splits are always continuations.
    // A line ending with "hor-" followed by "rible" is a word broken across
    // lines, never a paragraph boundary.
    if (features.endsWithHyphen) {
      continuationCount++;
      continue;
    }

    // Hard override: clear indentation → always a paragraph break.
    // If block B is indented >= indentationCutoff× body font size relative to the
    // body margin, this is a new paragraph indent.
    if (features.indentationRatio >= cfg.indentationCutoff) {
      breaks.add(block.id);
      paragraphBreakCount++;
      continue;
    }

    // Hard override: large vertical gap → always a paragraph break.
    // If the gap is significantly larger than the typical inter-line gap
    // (more than gapMultiplier× typical + a small absolute buffer), it's extra
    // spacing between paragraphs.
    if (baselines.typicalGapRatio > 0 &&
        features.verticalGapRatio > baselines.typicalGapRatio * cfg.gapMultiplier + 0.1) {
      breaks.add(block.id);
      paragraphBreakCount++;
      continue;
    }

    // Sentence-ending override: if the previous block does NOT end with sentence
    // punctuation, treat this as a continuation (mid-line break in PDFs).
    if (cfg.sentenceEndingOverride && !features.endsWithSentenceEnd) {
      continuationCount++;
      continue;
    }

    const score = scoreBoundary(features, cfg.weights, cfg.shortLineDeadZone);

    if (score >= cfg.threshold) {
      breaks.add(block.id);
      paragraphBreakCount++;
    } else {
      continuationCount++;
    }
  }

  // Post-processing: merge runs of uniformly-styled blocks that differ from body text.
  // E.g. consecutive italic blocks at a different indent (epigraphs, quotes, poetry)
  // should be treated as a single unit, not split into one-line paragraphs.
  mergeStyledRuns(sorted, breaks, baselines);

  // Re-add any manual breaks that mergeStyledRuns may have removed
  if (manualBreaks) {
    for (const id of manualBreaks) {
      breaks.add(id);
    }
  }

  // Recount after merging
  paragraphBreakCount = 0;
  continuationCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (breaks.has(sorted[i].id)) paragraphBreakCount++;
    else continuationCount++;
  }

  return {
    breaks,
    model,
    baselines,
    stats: {
      totalBoundaries: sorted.length > 0 ? sorted.length - 1 : 0,
      paragraphBreaks: paragraphBreakCount,
      continuations: continuationCount,
      weights: cfg.weights,
    },
    config: cfg,
  };
}

/**
 * Merge runs of uniformly-styled blocks that differ from normal body text.
 * Consecutive blocks sharing the same italic/bold/font style, where that style
 * differs from the document baseline (e.g. italic epigraphs, block quotes, poetry),
 * are merged into a single paragraph by removing internal breaks.
 */
function mergeStyledRuns(
  sorted: TextBlock[],
  breaks: Set<string>,
  baselines: DocumentBaselines
): void {
  if (sorted.length < 2) return;

  let runStart = 0;

  for (let i = 1; i <= sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = i < sorted.length ? sorted[i] : null;

    // Check if curr continues the same styled run as prev
    // (normalize style flags — OCR blocks leave them undefined)
    const continues = curr &&
      !!curr.is_italic === !!prev.is_italic &&
      !!curr.is_bold === !!prev.is_bold &&
      curr.font_name === prev.font_name &&
      curr.font_size === prev.font_size &&
      // Must be on the same page or adjacent pages
      (curr.page === prev.page || curr.page === prev.page + 1);

    if (!continues) {
      // Run from runStart to i-1. Check if this run has a distinctive style
      // (differs from body baseline) and has 2+ blocks
      const runLength = i - runStart;
      if (runLength >= 2) {
        const sample = sorted[runStart];
        const isDistinctive =
          sample.is_italic === true ||  // italic text
          sample.is_bold === true ||    // bold text
          sample.font_name !== baselines.bodyFont ||
          sample.font_size !== baselines.bodySize;

        if (isDistinctive) {
          // Remove all internal breaks within this run (keep the first block's break)
          for (let j = runStart + 1; j < i; j++) {
            breaks.delete(sorted[j].id);
          }
        }
      }
      runStart = i;
    }
  }
}

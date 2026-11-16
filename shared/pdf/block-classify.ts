/**
 * block-classify — what each block of a laid-out document IS: body, running
 * head, folio, footnote, caption, heading, title, quote...
 *
 * ONE set of rules for the app's analyzer (`electron/pdf-analyzer.ts`, which
 * turns the answer into its named, coloured categories) and the BookForge
 * Reader extension's PDF viewer (which skips the page furniture and footnotes
 * when it reads aloud). Pure — blocks and page heights in, a category per block
 * out. The blocks themselves come from `./text-blocks.ts`.
 *
 * `layout` says what kind of pages the blocks sit on, and the ONE thing it
 * decides is whether page furniture exists to be found. A PDF page is a sheet
 * of paper: it has a running head, it has a folio, and a block at the top or
 * bottom edge is evidence of one. An EPUB has neither. mupdf reflows it onto
 * pages of its own invention at its own window size, so "in the bottom tenth"
 * means the paragraph happened to land at the end of a synthetic page —
 * measured on Killing America, that is how ordinary prose came back `footer`.
 * The rules that read page position are therefore skipped for reflowed books,
 * explicitly, rather than left to misfire on evidence that does not exist.
 */

/** Is this text, on its own, a footnote reference marker (¹, 12, [3], †)? */
export function isFootnoteMarkerText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 6) return false;

  // Unicode superscript numbers
  if (/^[⁰¹²³⁴⁵⁶⁷⁸⁹¹²³]+$/.test(trimmed)) return true;

  // Plain numbers (1-999)
  if (/^\d{1,3}$/.test(trimmed)) return true;

  // Bracketed numbers [1], (1), etc.
  if (/^[\[\(]\d{1,3}[\]\)]$/.test(trimmed)) return true;

  // Asterisk or dagger markers
  if (/^[\*†‡§¶]+$/.test(trimmed)) return true;

  return false;
}

/** The fields classification reads. The analyzer's `TextBlock` is a superset. */
export interface ClassifiableBlock {
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
  is_bold: boolean;
  is_italic: boolean;
  is_superscript: boolean;
  is_image: boolean;
  line_count: number;
}

export type BlockLayout = 'pdf-page' | 'epub-reflow';

/** The category types classification can answer. */
export type BlockCategoryType =
  | 'body' | 'footnote' | 'footnote_ref' | 'heading' | 'subheading' | 'title'
  | 'chapter' | 'header' | 'footer' | 'caption' | 'quote' | 'image';

interface BodyStats {
  bodySize: number;
  bodyFont: string;
  bodyIsItalic: boolean;
  bodyMarginX: number;
  imagesByPage: Map<number, ClassifiableBlock[]>;
  blocksByPage: Map<number, ClassifiableBlock[]>;
  repeatedTopTexts: Set<string>;
}

/**
 * Classify every block. `stated` holds the categories the DOCUMENT ITSELF
 * declared for its blocks; those are used verbatim — not as a hint, not as a
 * tiebreaker — and only the blocks absent from it are classified.
 * `pageHeightOf` answers in the same units as the blocks' y.
 */
export function classifyBlocks(
  blocks: readonly ClassifiableBlock[],
  pageHeightOf: (page: number) => number | undefined,
  layout: BlockLayout,
  stated: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const hasPageFurniture = layout === 'pdf-page';
  const heightOf = (page: number) => pageHeightOf(page) || 800;
  const stats = bodyStats(blocks, heightOf, hasPageFurniture);

  // Classify blocks — except where the document already stated the answer,
  // which is not something to second-guess.
  const out = new Map<string, string>();
  for (const block of blocks) {
    const declared = stated.get(block.id);
    if (declared !== undefined) {
      out.set(block.id, declared);
      continue;
    }
    out.set(block.id, classifyBlock(block, stats, heightOf, hasPageFurniture));
  }

  // Enforce one header per page — keep only the topmost, reclassify the rest as
  // body. Blocks the document labelled are exempt: this rule exists to clean up
  // a guess, and there is no guess to clean up on those. Nor on a reflow, which
  // produced no header to thin out in the first place.
  const headersByPage = new Map<number, ClassifiableBlock[]>();
  for (const block of hasPageFurniture ? blocks : []) {
    if (stated.has(block.id)) continue;
    if (out.get(block.id) === 'header') {
      if (!headersByPage.has(block.page)) headersByPage.set(block.page, []);
      headersByPage.get(block.page)!.push(block);
    }
  }
  for (const [, headers] of headersByPage) {
    if (headers.length > 1) {
      headers.sort((a, b) => a.y - b.y);
      for (let i = 1; i < headers.length; i++) out.set(headers[i].id, 'body');
    }
  }
  return out;
}

function bodyStats(
  blocks: readonly ClassifiableBlock[],
  heightOf: (page: number) => number,
  hasPageFurniture: boolean,
): BodyStats {
  // Body text size: most chars in the body region
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

  // Dominant body font name and italic status
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

  // Per-page index of image positions, for caption adjacency
  const imagesByPage = new Map<number, ClassifiableBlock[]>();
  for (const block of blocks) {
    if (block.is_image) {
      if (!imagesByPage.has(block.page)) imagesByPage.set(block.page, []);
      imagesByPage.get(block.page)!.push(block);
    }
  }

  // Dominant body left margin (most common X)
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

  // Per-page text blocks sorted by Y, for gap detection
  const blocksByPage = new Map<number, ClassifiableBlock[]>();
  for (const block of blocks) {
    if (!block.is_image) {
      if (!blocksByPage.has(block.page)) blocksByPage.set(block.page, []);
      blocksByPage.get(block.page)!.push(block);
    }
  }
  for (const [, list] of blocksByPage) list.sort((a, b) => a.y - b.y);

  // Repeated top-of-page text across pages (running header signal). Normalized
  // by stripping digits, punctuation and whitespace, so "10 Childhood, 1886-1904"
  // matches "Childhood, 1886-1904 12". Not built at all for a reflow: the
  // "running head" it would find is the first line of whatever paragraph the
  // window happened to break at.
  const topTextPages = new Map<string, Set<number>>();
  for (const block of hasPageFurniture ? blocks : []) {
    if (block.is_image || block.line_count > 2) continue;
    if (block.y / heightOf(block.page) < 0.10) {
      const norm = normalizeHeadText(block.text);
      if (norm.length > 3) {
        if (!topTextPages.has(norm)) topTextPages.set(norm, new Set());
        topTextPages.get(norm)!.add(block.page);
      }
    }
  }
  const repeatedTopTexts = new Set<string>();
  for (const [text, pages] of topTextPages) {
    if (pages.size >= 3) repeatedTopTexts.add(text);
  }

  return { bodySize, bodyFont, bodyIsItalic, bodyMarginX, imagesByPage, blocksByPage, repeatedTopTexts };
}

function normalizeHeadText(text: string): string {
  return text.trim().replace(/[\d\-–—.,;:!?]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Is a text block adjacent to an image on the same page (within threshold points)? */
function isAdjacentToImage(
  block: ClassifiableBlock,
  imagesByPage: Map<number, ClassifiableBlock[]>,
  threshold = 30,
): boolean {
  const pageImages = imagesByPage.get(block.page);
  if (!pageImages) return false;
  return pageImages.some(img => {
    const imgBottom = img.y + img.height;
    const blockBottom = block.y + block.height;
    // Text below image (most common caption position)
    const belowImage = block.y >= imgBottom - 5 && block.y <= imgBottom + threshold;
    // Text above image (less common)
    const aboveImage = blockBottom >= img.y - threshold && blockBottom <= img.y + 5;
    // Must overlap horizontally
    const hOverlap = block.x < img.x + img.width && block.x + block.width > img.x;
    return (belowImage || aboveImage) && hOverlap;
  });
}

/**
 * Score how likely a block is to be a running header. Several weak signals
 * that together form a strong consensus.
 */
function computeHeaderScore(block: ClassifiableBlock, s: BodyStats): number {
  let score = 0;
  const trimmed = block.text.trim();

  // Strong: different font size from body (+2)
  if (Math.round(block.font_size) !== Math.round(s.bodySize)) score += 2;

  // Strong: same text appears at top of 3+ pages (+3)
  const norm = normalizeHeadText(trimmed);
  if (norm.length > 3 && s.repeatedTopTexts.has(norm)) score += 3;

  // Page number pattern (+1)
  const hasPageNum = /^\d{1,4}\s+\S/.test(trimmed) || /\S\s+\d{1,4}$/.test(trimmed) ||
                     (block.char_count <= 5 && /^\d+$/.test(trimmed));
  if (hasPageNum) score += 1;

  // Italic when body text isn't (+1)
  if (block.is_italic && !s.bodyIsItalic) score += 1;

  // Different font name from body (+1)
  if (block.font_name !== s.bodyFont) score += 1;

  // Gap to next block on same page larger than normal line spacing (+1)
  const pageBlocks = s.blocksByPage.get(block.page);
  if (pageBlocks) {
    const blockBottom = block.y + block.height;
    const nextBlock = pageBlocks.find(b => b.y >= blockBottom && b.id !== block.id);
    if (nextBlock && (nextBlock.y - blockBottom) > s.bodySize * 1.5) score += 1;
  }

  // Not aligned with body text left margin (+1)
  if (Math.abs(block.x - s.bodyMarginX) > s.bodySize * 0.5) score += 1;

  // Short text — headers are brief (+1)
  if (block.char_count < 60) score += 1;

  return score;
}

/**
 * Text that starts with a footnote numbering/marker pattern:
 *   "1. Russell...", "18 See...", "31° See...", "* Note...",
 *   "¹⁸ Russell...", "• See...", "18] Russell...", "1) See..."
 */
function startsWithFootnotePattern(text: string): boolean {
  return /^(\d{1,3}[.\s°)\]:]\s*|[*†‡§¶•]\s?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s?)\S/.test(text.trim());
}

/** A significant vertical gap above a lower-half block — a footnote separator. */
function hasSignificantGapAbove(
  block: ClassifiableBlock,
  blocksByPage: Map<number, ClassifiableBlock[]>,
  pageHeight: number,
): boolean {
  if (block.y / pageHeight < 0.50) return false;
  const pageBlocks = blocksByPage.get(block.page);
  if (!pageBlocks) return false;

  let nearestAboveBottom = 0;
  for (const b of pageBlocks) {
    if (b.id === block.id || b.is_image) continue;
    const bBottom = b.y + b.height;
    if (bBottom <= block.y && bBottom > nearestAboveBottom) nearestAboveBottom = bBottom;
  }
  if (nearestAboveBottom === 0) return false;

  // A gap of > 1.5× the block's own height suggests a separator
  return block.y - nearestAboveBottom > block.height * 1.5;
}

/**
 * Is there genuine body text below a block on the same page? Blocks that start
 * with a footnote numbering pattern are sibling footnotes, not body text
 * (important when footnotes share the body font size).
 */
function hasBodyTextBelow(
  block: ClassifiableBlock,
  blocksByPage: Map<number, ClassifiableBlock[]>,
  bodySize: number,
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
 * Classify one block. Every rule that reads a Y coordinate against the page
 * height asks "is this a running head / a folio / a footnote at the foot of the
 * page", and on a reflow the page is mupdf's invention, so the question has no
 * answer and is not asked. The typographic rules — relative type size, weight,
 * italics, adjacency to an image — mean the same thing on both and are asked
 * either way.
 */
function classifyBlock(
  block: ClassifiableBlock,
  s: BodyStats,
  heightOf: (page: number) => number,
  hasPageFurniture: boolean,
): BlockCategoryType {
  const { bodySize, bodyFont, bodyIsItalic } = s;
  if (block.is_image) return 'image';

  // Text that is PRIMARILY a footnote marker — small isolated reference numbers
  if (isFootnoteMarkerText(block.text)) return 'footnote_ref';

  // Superscript text blocks (mupdf flag detection)
  if (block.is_superscript) return 'footnote_ref';

  // Very small isolated text with small font might be footnote refs
  if (block.font_size < bodySize * 0.75 && block.char_count <= 4 && block.line_count === 1) {
    return 'footnote_ref';
  }

  if (hasPageFurniture) {
    const pageHeight = heightOf(block.page);

    // Header detection — scoring-based consensus. Already in the header region
    // (top of page, ≤2 lines, no body-text indicators), so the positional
    // evidence is strong — threshold of 2.
    if (block.region === 'header') {
      return computeHeaderScore(block, s) >= 2 ? 'header' : 'body';
    }
    if (block.region === 'footer') return 'footer';

    // Headers that slipped through region detection
    const yPct = block.y / pageHeight;
    const text = block.text.trim();
    const looksLikeBodyText = block.char_count > 100 ||
                              /[.!?]["']?\s+[A-Z]/.test(text) ||  // Multiple sentences
                              (text.endsWith('.') && block.char_count > 60);
    const bottomPct = (block.y + block.height) / pageHeight;
    if (block.line_count <= 2 && (yPct < 0.10 || bottomPct < 0.15) && !looksLikeBodyText) {
      // Not initially assigned header region — require stronger evidence (threshold 3)
      if (computeHeaderScore(block, s) >= 3) return 'header';
    }

    // Footnotes: font size, content pattern, gap above. Every one of them reads
    // the page, so all four go together.
    const isLowerHalf = block.y / pageHeight > 0.50;
    const hasSmallerFont = block.font_size < bodySize * 0.95;
    const hasFootnotePattern = startsWithFootnotePattern(block.text);
    const hasGap = hasSignificantGapAbove(block, s.blocksByPage, pageHeight);
    const bodyTextBelow = hasBodyTextBelow(block, s.blocksByPage, bodySize);

    // Lower region + smaller font + no body text below
    if (block.region === 'lower' && hasSmallerFont && !bodyTextBelow) return 'footnote';
    // Content pattern in lower half — even at body font size
    if (isLowerHalf && hasFootnotePattern && !bodyTextBelow) return 'footnote';
    // Gap above + lower half — strong spatial signal (footnote separator)
    if (isLowerHalf && hasGap && hasSmallerFont) return 'footnote';
    // Gap above + content pattern — very strong combined signal
    if (hasGap && hasFootnotePattern) return 'footnote';
  }

  // --- Captions ---
  const nearImage = isAdjacentToImage(block, s.imagesByPage);
  const differentFont = block.font_name !== bodyFont;
  const isItalicCaption = block.is_italic && !bodyIsItalic;
  if (nearImage && block.font_size < bodySize * 0.85) return 'caption';
  if (nearImage && isItalicCaption) return 'caption';
  if (nearImage && differentFont && block.line_count <= 8) return 'caption';
  if (nearImage && block.font_size < bodySize * 0.95) return 'caption';

  // Chapter openings, checked before titles — both are large type, so a pure
  // size rule cannot separate a chapter opener from the book's own title.
  // "Part"/"Book" dividers stay titles: they aren't chapter breaks.
  if (block.font_size > bodySize * 1.1 && /^\s*chapter\b/i.test(block.text.trim())) {
    return 'chapter';
  }

  // Large text is titles — but not drop caps (1–3 oversized characters).
  if (block.font_size > bodySize * 1.4 && block.char_count > 3) return 'title';

  // Bold text = headings
  if (block.is_bold) {
    if (block.font_size > bodySize * 1.1) return 'heading';
    // Not a subheading if also italic (mixed format = likely quote or body) or
    // if it has a quote attribution pattern (—NAME)
    if (block.line_count <= 2 && block.char_count < 200
        && !block.is_italic
        && !/[—–-]\s*[A-Z][A-Z\s.]+$/.test(block.text.trim())) {
      return 'subheading';
    }
  }

  // Italic multi-line = quotes (but NOT if adjacent to an image — those are captions)
  if (block.is_italic && block.line_count > 2 && !nearImage) return 'quote';

  return 'body';
}

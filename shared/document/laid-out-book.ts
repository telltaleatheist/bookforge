/**
 * The book AS A VIEWER LAID IT OUT — the one shape the picker's selection,
 * deletion, category, chapter and narration-strike logic reads.
 *
 * It exists because there is about to be a second viewer. Today the picker's
 * whole idea of "the book on screen" is `TextBlock[]` + `PageDimension[]`:
 * rectangles in PDF-point space over a bitmap of a mupdf-laid-out page. A
 * live-DOM EPUB viewer has no bitmap, no point space and no fixed pagination,
 * yet it has to feed exactly the same deletion and strike machinery. So the
 * MEANING half of a block is declared here, separately from the geometry half,
 * and the geometry half is grouped and optional: present for a viewer that
 * paints on a raster, entirely absent for one that paints from its own box
 * model.
 *
 * Nothing about HOW a viewer paints belongs here — zoom, crop regions, sample
 * rects, drag/resize offsets, page reorder, page-image URLs, text-layer
 * toggles, virtualization row heights. Those are the raster viewer's private
 * business; a DOM viewer either has no such concept or implements it in a
 * wholly different, non-geometric way it owns itself.
 *
 * `toLaidOutBook()` at the bottom of this file is the proof that the existing
 * raster model satisfies the contract: `TextBlock[]`/`PageDimension[]` in, a
 * `LaidOutBook` out, no data invented on the way.
 */

import type { NarrationElementKey } from '../vlm/narration-deletions';
import type { BlockCategoryProvenance, PageDimension, TextBlock } from '../ocr/text-block';

/**
 * Optional pagination unit. Raster viewers always report one entry per
 * mupdf/mutool page. A live-DOM viewer with no fixed pagination reports an
 * empty array — every page-scoped gesture (delete-page, select-source-page,
 * page marquee, organize/reorder) degrades to "not offered" rather than the
 * picker guessing at a page concept that doesn't exist for that viewer.
 */
export interface LaidOutPage {
  index: number;   // 0-based, matches LaidOutBlock.page
  width: number;   // layout-only — raster CSS sizing / itemSize estimates
  height: number;  // absent any meaning beyond "how this viewer chooses to paint"
}

/**
 * The MEANING half of a block: everything the picker needs regardless of how
 * the block is painted. This is what crosses into selection, deletion,
 * category, chapter, merge, and narration-strike logic. A DOM viewer
 * satisfies this from its own element/DOM-node model directly, no raster
 * involved.
 */
export interface LaidOutBlock {
  id: string;
  page: number;                        // index into LaidOutBook.pages, or 0 if pages is empty
  text: string;
  category_id: string;
  is_image?: boolean;
  is_footnote_marker?: boolean;
  parent_block_id?: string;
  merged_foundry_ids?: string[];
  is_manual?: boolean;
  line_count?: number;                 // gates split-eligibility UI

  /**
   * Reading-order authority. Raster viewer sources it from the working PDF's
   * /FoundrySeq annotation; a DOM viewer sources it from natural document
   * order. Required for merge eligibility (mergeRefusal()) regardless of
   * viewer.
   */
  seq?: number;

  /**
   * What narration deletion actually strikes. On the raster viewer this is a
   * many-to-one alignment target (several mupdf blocks -> one EPUB element,
   * see deriveNarrationStrikes). On a live-DOM viewer this SHOULD be the
   * block's own identity 1:1 — do not bypass deriveNarrationStrikes even so;
   * its document-escalation and unstruck-deletion diagnostics must still run.
   */
  bf_element?: NarrationElementKey;

  /** Present only on blocks whose element was read off an ORIGINAL PDF page
   *  (a converted book). Absent on every publisher EPUB block, on both
   *  viewers alike — already optional-gated in the current UI. */
  bf_source_page?: number;

  /**
   * Present only for a viewer that paints on a fixed-aspect raster (SVG
   * overlay on a bitmap). Entirely absent for a live-DOM viewer, which paints
   * from its own box model and needs none of this. Grouped so a consumer can
   * check `geometry !== undefined` once rather than null-checking four
   * fields independently.
   */
  geometry?: {
    x: number; y: number; width: number; height: number;  // page-point space
    font_size?: number;
    region?: string;
  };
}

/**
 * The book, as laid out by whichever viewer is currently mounted — the ONE
 * shape the picker's selection/deletion logic depends on, satisfied today by
 * the raster viewer's TextBlock[]/PageDimension[] and going forward by a
 * live-DOM EPUB viewer's own element model.
 */
export interface LaidOutBook {
  blocks: readonly LaidOutBlock[];
  pages: readonly LaidOutPage[];        // may be empty — see LaidOutPage doc
  /** Whole-book fact, not per-block — mirrors BlockCategoryProvenance.source.
   *  Lets the picker avoid re-deriving "can I trust these category labels"
   *  per viewer. */
  categoryProvenance: 'document' | 'markup' | 'heuristic';
}

/** The three answers `LaidOutBook.categoryProvenance` may carry. */
const CATEGORY_PROVENANCE_SOURCES: ReadonlyArray<LaidOutBook['categoryProvenance']> =
  ['document', 'markup', 'heuristic'];

/**
 * Say what is wrong with a block, or nothing.
 *
 * Presence and type only — never emptiness. An image block legitimately has
 * `text: ''`, and rejecting that would be this adapter inventing a rule the
 * block model does not have. What it does catch is the hole the block model
 * cannot: the picker receives analysis payloads over IPC and casts them
 * (`data.blocks as TextBlock[]`), so a field the producer stopped sending
 * arrives here as `undefined` with the compiler none the wiser.
 */
function blockDefect(block: TextBlock, index: number): string | null {
  const at = `Block ${index}`;
  if (typeof block.id !== 'string') return `${at} has no id.`;
  const named = `Block ${block.id}`;
  if (!Number.isFinite(block.page)) return `${named} has no page number.`;
  if (typeof block.text !== 'string') return `${named} has no text.`;
  if (typeof block.category_id !== 'string') return `${named} has no category_id.`;
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isFinite(block[field])) return `${named} has no ${field}, so it cannot be painted.`;
  }
  return null;
}

/**
 * One block of the raster model, as the viewer-agnostic contract sees it.
 *
 * The optional MEANING fields are copied only when the source block actually
 * carries them, so `'bf_element' in block` stays a true statement about the
 * book rather than about this function. The four LAYOUT fields are always
 * present on a `TextBlock` — it is a rectangle on a page by construction — so
 * `geometry` is always built here, and it is exactly that always-ness that
 * marks these blocks as coming from a raster viewer.
 */
export function toLaidOutBlock(block: TextBlock, index: number): LaidOutBlock {
  const defect = blockDefect(block, index);
  if (defect !== null) {
    throw new Error(
      `${defect} A block that cannot be described to a viewer cannot be selected, deleted or `
      + `struck out, so this is refused rather than painted with something made up.`,
    );
  }
  return {
    id: block.id,
    page: block.page,
    text: block.text,
    category_id: block.category_id,
    ...(block.is_image !== undefined ? { is_image: block.is_image } : {}),
    ...(block.is_footnote_marker !== undefined
      ? { is_footnote_marker: block.is_footnote_marker } : {}),
    ...(block.parent_block_id !== undefined ? { parent_block_id: block.parent_block_id } : {}),
    ...(block.merged_foundry_ids !== undefined
      ? { merged_foundry_ids: block.merged_foundry_ids } : {}),
    ...(block.is_manual !== undefined ? { is_manual: block.is_manual } : {}),
    ...(block.line_count !== undefined ? { line_count: block.line_count } : {}),
    ...(block.seq !== undefined ? { seq: block.seq } : {}),
    ...(block.bf_element !== undefined ? { bf_element: block.bf_element } : {}),
    ...(block.bf_source_page !== undefined ? { bf_source_page: block.bf_source_page } : {}),
    geometry: {
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
      ...(block.font_size !== undefined ? { font_size: block.font_size } : {}),
      ...(block.region !== undefined ? { region: block.region } : {}),
    },
  };
}

/**
 * The raster viewer's model, as a `LaidOutBook` — the adapter that proves the
 * existing `TextBlock[]`/`PageDimension[]` pair already satisfies the contract.
 *
 * `pageDimensions` becomes `pages` one-for-one, in array order, because that
 * IS the raster viewer's page identity: `TextBlock.page` indexes this array,
 * and so does `deletedPages`. It is NOT cross-checked against the blocks —
 * `pages` is allowed to be empty by design (a live-DOM viewer reports no
 * pagination at all), so "every block's page exists" is not a rule of this
 * contract and enforcing it here would forbid the very case the contract was
 * widened for.
 *
 * `categoryProvenance` is a REQUIRED argument and there is no default. The
 * three sources are not interchangeable — `document` is the book's own record
 * and `heuristic` is this app's font-and-geometry guess — so a caller that
 * does not know which it holds must not be allowed to say `heuristic` by
 * omission and have a guess pass for a record.
 */
export function toLaidOutBook(
  blocks: readonly TextBlock[],
  pageDimensions: readonly PageDimension[],
  categoryProvenance: BlockCategoryProvenance['source'],
): LaidOutBook {
  if (!CATEGORY_PROVENANCE_SOURCES.includes(categoryProvenance)) {
    throw new Error(
      `A book was described with category provenance "${categoryProvenance}", which is none of `
      + `${CATEGORY_PROVENANCE_SOURCES.join(', ')}. Whether these labels are the document's own `
      + `record or this app's guess cannot be answered, so the book is not described at all.`,
    );
  }
  const pages: LaidOutPage[] = pageDimensions.map((dim, index) => {
    if (!Number.isFinite(dim.width) || !Number.isFinite(dim.height)) {
      throw new Error(
        `Page ${index} has no width/height, so nothing can be laid out on it.`,
      );
    }
    return { index, width: dim.width, height: dim.height };
  });
  return {
    blocks: blocks.map(toLaidOutBlock),
    pages,
    categoryProvenance,
  };
}

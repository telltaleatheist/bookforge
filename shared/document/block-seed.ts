/**
 * block-seed — turning an analysis of a PDF into the block layer a working copy
 * is BORN with.
 *
 * A working copy is a copy of the archive original plus a marker
 * (electron/working-copy.ts), and for one release that was the whole of it. It
 * made the copy unusable: every curation edit — relabel, retitle, delete,
 * restore, merge — names a block id, and `applyWorkingDocumentEdits` looks that
 * id up in the annotations the document already carries. A document carrying
 * none refuses every gesture by name ("there is no block … in this document"),
 * so the picker opened on an empty page and nothing the user did landed. There
 * is no `add` edit and there should not be one: the block layer is a reading of
 * the document, not a thing a user assembles a box at a time.
 *
 * So the copy is seeded at mint time, from the SAME analysis the picker shows —
 * `pdf-analyzer`'s blocks, categories and all — and this module is the pure part
 * of that: the frame conversion, the reading order, and the projection of the
 * analyzer's category vocabulary onto the block-category contract. Everything
 * that touches a file is in electron/working-document-writer.ts, which is the
 * one thing that writes annotations.
 *
 * ── The frame, and why the conversion is exactly this one ───────────────────
 *
 * The analyzer reports blocks in POINTS with the origin at the top-left of the
 * page box and y DOWN (mutool's own frame, with the page origin already
 * subtracted — `electron/mutool-bridge.ts`). A PDF annotation's `/Rect` is
 * points with the origin bottom-left and y UP, in user space. The picker already
 * owns one direction of that conversion (`toTextBlock` in
 * `document-blocks.service.ts`): given the page's crop box,
 *
 *     x = rect.x0 - crop.x0        y = crop.y1 - rect.y1
 *
 * This is that mapping read backwards, and it has to be exactly its inverse: a
 * block seeded here is read back through it the moment the picker opens the
 * book, and a half-point of drift between the two would put every box slightly
 * off the words it names.
 *
 * Page ROTATION is not applied, on either side. That is not an oversight — the
 * reader does not apply it either, so applying it here would make the round trip
 * disagree with itself. If rotated pages ever need handling it is one change, in
 * both directions, measured against a rotated book.
 *
 * ── Categories: thirteen, and nothing else ──────────────────────────────────
 *
 * `pdf-analyzer.classifyBlock` still answers `footnote_ref` — a class retired
 * from the contract in Jul 2026 (2 examples in 42,759) — and a user's own
 * analysis can carry custom ids. An annotation carrying one of those would paint
 * with no colour, list with no name, and be un-relabellable, because
 * `shared/ocr/block-categories.ts` is the one palette and the writer validates
 * against it. So a category outside the contract is projected onto `body`, which
 * is what `classifyBlock` itself falls through to, and every projection is
 * COUNTED and reported so the mint can say what it did rather than quietly
 * flattening a book.
 */

import { BLOCK_CATEGORY_IDS } from '../ocr/block-categories';

/** The category an unrecognized one is projected onto — `classifyBlock`'s own default. */
export const SEED_FALLBACK_CATEGORY = 'body';

/**
 * One block as the analyzer reports it: points, origin top-left of the page box,
 * y down. A structural subset of `TextBlock` — this module needs the geometry,
 * the text and the class, and naming only those keeps it testable with plain
 * objects.
 */
export interface BlockSeedSource {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  category_id: string;
}

/** One block as it will be written: PDF user space, with its place in reading order. */
export interface SeedBlockAnnotation {
  id: string;
  page: number;
  seq: number;
  category: string;
  /** `[x0, y0, x1, y1]` in PDF user space — the annotation's `/Rect`. */
  rect: [number, number, number, number];
  text: string;
}

export interface BlockSeedPlan {
  annotations: SeedBlockAnnotation[];
  /**
   * Analyzer categories outside the contract → how many blocks carried each,
   * all of them written as `body`. Empty on the ordinary book.
   */
  projected: Record<string, number>;
}

/** A page's crop box in user space, `[x0, y0, x1, y1]`. */
export type SeedCropBox = readonly [number, number, number, number];

function finite(...values: number[]): boolean {
  return values.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Plan the block layer for a freshly minted working copy.
 *
 * `cropBoxes` is indexed by page, read off the document the annotations are
 * about — the copy and the original are the same bytes, so the analyzer's page
 * numbers and these indices are the same page.
 *
 * NO BLOCKS IS AN ANSWER, not a failure. A scanned PDF with no text layer yields
 * few blocks or none at all, and that is the truth about the document: page
 * deletions still work, and reading its pages is `foundry vlm-convert`'s job.
 * Fabricating a box so the picker looks populated would be inventing content.
 *
 * Everything else is refused by name. A block on a page the document does not
 * have, two blocks claiming one id, or geometry that is not a number are all
 * signs that the analysis and the file have come apart, and a seeded document is
 * read back as fact by everything downstream.
 */
export function planBlockSeed(
  blocks: readonly BlockSeedSource[],
  cropBoxes: readonly SeedCropBox[],
): BlockSeedPlan {
  const legal = new Set(BLOCK_CATEGORY_IDS);
  const projected: Record<string, number> = {};
  const seen = new Set<string>();

  // Stable by page, keeping the analyzer's own order within a page: for text
  // that is mutool's reading order, which multi-column layouts depend on and a
  // sort by y would destroy. Image blocks are appended to the analysis after the
  // text, so they land at the end of their page — where a figure with no
  // measured place in the prose honestly belongs.
  const ordered = blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => (a.block.page - b.block.page) || (a.index - b.index));

  const annotations: SeedBlockAnnotation[] = [];
  for (const { block } of ordered) {
    if (seen.has(block.id)) {
      throw new Error(
        `two analyzed blocks claim the id ${block.id}. Block ids are keys — every curation edit `
        + 'names one — so a document seeded from this analysis would take an edit on whichever '
        + 'annotation was read second.'
      );
    }
    seen.add(block.id);

    const crop = cropBoxes[block.page];
    if (!crop) {
      throw new Error(
        `block ${block.id} is on page ${block.page + 1}, and the document has `
        + `${cropBoxes.length} pages. The analysis and the file are not of the same document.`
      );
    }
    if (!finite(block.x, block.y, block.width, block.height)) {
      throw new Error(
        `block ${block.id} has geometry that is not four numbers `
        + `(x=${block.x}, y=${block.y}, w=${block.width}, h=${block.height}).`
      );
    }
    if (block.width < 0 || block.height < 0) {
      throw new Error(
        `block ${block.id} has a negative size (${block.width} × ${block.height}), so there is no `
        + 'box to draw for it.'
      );
    }

    const [cx0, , , cy1] = crop;
    const x0 = block.x + cx0;
    const y1 = cy1 - block.y;
    const rect: [number, number, number, number] = [
      x0,
      y1 - block.height,
      x0 + block.width,
      y1,
    ];

    let category = block.category_id;
    if (!legal.has(category)) {
      projected[category] = (projected[category] ?? 0) + 1;
      category = SEED_FALLBACK_CATEGORY;
    }

    annotations.push({
      id: block.id,
      page: block.page,
      seq: annotations.length,
      category,
      rect,
      text: block.text,
    });
  }

  return { annotations, projected };
}

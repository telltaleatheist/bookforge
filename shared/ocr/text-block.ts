/**
 * The block model the picker edits and the manifest stores.
 *
 * These three types used to be declared in
 * `src/app/features/pdf-picker/services/pdf.service.ts`, which put them out of
 * reach of the main process and the CLI even though `manifest.editor.ocrBlocks`
 * is exactly an array of `TextBlock`. They live under `shared/` so the one
 * program that produces those blocks (the OCR post-processor) and the two
 * programs that persist and re-load them (the renderer's project save, the CLI's
 * `--project` write) all describe them with the same declaration.
 *
 * `pdf.service.ts` re-exports all three, so every existing import site is
 * unchanged.
 */

export interface TextBlock {
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
  /**
   * The block's place in the book's READING ORDER, as the working document
   * states it (`/FoundrySeq`).
   *
   * Stated rather than implied by array order, because reading order has to
   * survive a round trip through any reader that rewrote a page's `/Annots`
   * array — and because two blocks claiming the same place is an error rather
   * than an arbitrary tiebreak. Absent on blocks that did not come from a
   * working document: a native PDF text-layer analysis has only page order.
   */
  seq?: number;
  /**
   * Authored by the user, not by OCR or the PDF text layer — currently a chapter
   * box dropped where the page carries no usable chapter title.
   *
   * It exists to keep these blocks OUT of `ocr_blocks` on save. Restoring that
   * field calls `replaceTextBlocksOnPages`, which drops every non-image block on
   * the pages it touches, so a manual block riding along in there would take the
   * page's entire native text layer with it on the next open.
   */
  is_manual?: boolean;
  /**
   * The OTHER foundry blocks this one swallowed when adjacent `chapter` blocks
   * were merged into a single chapter marker on paint.
   *
   * Block formation splits a display heading into one block per line, so a real
   * chapter heading arrives as two or three adjacent `chapter` blocks. The
   * picker merges them: this block keeps foundry's own id and its text becomes
   * the joined line, and the ids listed here are the ones that no longer have a
   * block of their own. At export they become exclusions — leave them in and
   * foundry emits the fragments a second time, under the merged heading.
   *
   * Derived, never authoritative: `loadFoundryRun` rebuilds it from the run
   * directory on every paint, so it does not have to survive a save. What has
   * to survive is the user's EDIT of the merged text, and that lives where every
   * other text edit lives — `editorState.blockEdits`, keyed by this block's id.
   */
  merged_foundry_ids?: string[];
  is_bold?: boolean;
  is_italic?: boolean;
  is_superscript?: boolean;
  is_image?: boolean;
  is_footnote_marker?: boolean;  // Inline footnote reference marker (¹, ², [1], etc.)
  parent_block_id?: string;      // If this is a marker extracted from a parent block
  line_count?: number;
  is_ocr?: boolean;              // True if this block was generated via OCR (independent from images)
  // Tesseract's paragraph identity for OCR line-blocks ("blockNum:parNum").
  // Lines sharing a key are one paragraph; the post-processor uses this as a
  // hard boundary instead of re-deriving paragraph breaks from geometry.
  ocr_par_key?: string;
  /** Mean word recognition confidence, 0..1. Low values mark degraded regions. */
  ocr_confidence?: number;
  /**
   * The recognized lines this block was built from, as [x, y, width, height] in
   * page points, top to bottom.
   *
   * Kept because dropping them made under-segmentation unfixable after the fact:
   * a block that merges two things (a running head and the section heading under
   * it, a footnote and the body above it) has no correct label, and the only
   * honest repair is to cut it at a line boundary — which needs the lines. The
   * in-app split popover had nothing to cut on precisely because these were
   * discarded, and tools/split-ocr-block.js had to re-OCR a page to get them back.
   * Per-line x-runs are also the structural signal `table` detection needs.
   */
  line_boxes?: Array<[number, number, number, number]>;
  /**
   * Descender depth as a fraction of type size. Near zero means the line is set
   * in capitals — which identifies running heads and chapter openers optically,
   * even where OCR misread the characters.
   */
  ocr_descender_ratio?: number;
  /**
   * The id of the paragraph GROUP foundry rendered this block's source element
   * from — the `data-bf-group` attribute it stamps on every element it writes.
   *
   * Written by `readEpubBlockProvenance` (electron/epub-processor.ts) when an
   * EPUB the pipeline itself built is analyzed: the laid-out block is aligned
   * back to the element it came from, and the element says what it is. Absent on
   * every other block — a PDF has no such record, and neither does a book that
   * came from somewhere else.
   *
   * SEVERAL BLOCKS MAY SHARE ONE GROUP ID, and that is the truth rather than a
   * collision: mupdf re-lays the book out at its own page size, so one authored
   * paragraph becomes one block per visual line and may straddle a page turn.
   * They all came from the one element, so they all carry its group.
   *
   * Its presence is also what marks `category_id` as the BOOK'S OWN record
   * rather than the analyzer's font/geometry guess — foundry writes all three
   * attributes together or none of them.
   */
  bf_group?: string;
  /**
   * The WORKING PDF block ids that were joined to make this block's source
   * element — the `data-bf-blocks` attribute, split on whitespace.
   *
   * These are the same ids the working document's annotations carry, so a
   * paragraph in the book can be traced back to the blocks and pages it was
   * made from. Written by the same reader as `bf_group`, under the same rules.
   */
  bf_blocks?: string[];
  /**
   * What the document VISION MODEL called this block's source element — the
   * `data-bf-cat` attribute `foundry vlm-convert` stamps, verbatim and
   * lower-cased (`text`, `title`, `section-header`, `footnote`, `caption`,
   * `table`, `picture`, `quote`, `formula`, `list-item`).
   *
   * The OTHER stamp, and it means the same thing `bf_group` means: this block's
   * `category_id` is the BOOK'S OWN record rather than the analyzer's font and
   * geometry guess. The two never appear together — a book was written by
   * reflow or by vlm-convert, and each stamps its own — and `category_id`
   * carries the translation into the one palette
   * (shared/vlm/conversion.ts `VLM_CATEGORY_TO_BLOCK`), so nothing downstream
   * has to know which dialect a book speaks.
   */
  bf_cat?: string;
  /**
   * The PDF page this block's element was read from — `data-bf-page`.
   *
   * NOT `page`, which is the page mupdf laid the EPUB out onto at its own page
   * size and has nothing to do with the paper. This is what makes "delete
   * everything that was on page 12" answerable in a book that has no pages.
   */
  bf_source_page?: number;
  /**
   * This block's source element, as the narration deletions name it:
   * `<zip entry>#<index within that document's unit list>`.
   *
   * Positional, because foundry's emitter gives elements no ids and the book it
   * writes is never written to again. See shared/vlm/narration-deletions.ts.
   * Several blocks share one key when mupdf split a paragraph across visual
   * lines — that is the truth, and striking any of them strikes the element.
   */
  bf_element?: string;
}

/**
 * Where a set of blocks got their categories — a fact about the INPUT, not a
 * quality score.
 *
 * There are two input classes and they are not comparable:
 *
 *  - `document`: the book carries the pipeline's own record of what it wrote
 *    (foundry stamps `data-bf-category` on every element of every EPUB it
 *    reflows), and the categories were read off it. They are not a guess: the
 *    `<h1>` that says `chapter` IS the chapter block of the working PDF.
 *  - `heuristic`: nothing in the document says what its blocks are, so they were
 *    classified from relative font size, weight and page position. A book
 *    imported from elsewhere was never written by our reflow and there is
 *    nothing else to read — this is the honest answer for that class, not a
 *    fallback standing in for a missing value.
 *
 * A caller that needs to know whether it can trust the labels reads `source`.
 * The counts exist so a `document` book that only PARTLY aligned cannot quietly
 * pass itself off as fully recorded.
 */
export interface BlockCategoryProvenance {
  source: 'document' | 'heuristic';
  /** Blocks whose category was read off their source element's stamp. */
  stampedBlocks: number;
  /**
   * Blocks aligned to a source element that carries no stamp — the nav TOC and
   * any hand-added markup. Expected in small numbers; their categories are the
   * heuristic's.
   */
  unstampedElementBlocks: number;
  /**
   * Blocks the aligner could not place in the source markup at all. Their
   * categories are the heuristic's, and a non-zero count is reported as an
   * analysis warning: a stamped book must not degrade to guessing in silence.
   */
  unalignedBlocks: number;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  color: string;
  block_count: number;
  char_count: number;
  font_size: number;
  region: string;
  sample_text: string;
}

export interface PageDimension {
  width: number;
  height: number;
}

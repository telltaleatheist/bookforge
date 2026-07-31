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
   * Authored by the user, not by OCR or the PDF text layer — currently a chapter
   * box dropped where the page carries no usable chapter title.
   *
   * It exists to keep these blocks OUT of `ocr_blocks` on save. Restoring that
   * field calls `replaceTextBlocksOnPages`, which drops every non-image block on
   * the pages it touches, so a manual block riding along in there would take the
   * page's entire native text layer with it on the next open.
   */
  is_manual?: boolean;
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

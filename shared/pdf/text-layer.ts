/**
 * Does a PDF carry text of its own, or is it pictures of pages?
 *
 * One declaration, three programs — main measures it (`pdf-analyzer`), preload
 * carries it across, and the processing wizard decides with it whether an OCR
 * pass is a choice or the only way the book gets any words. Declared here rather
 * than in pdf-analyzer because that module loads mupdf, which has no business in
 * a preload script.
 */

/**
 * A page needs this many non-whitespace characters to count as carrying text.
 *
 * A page of body text runs 1,500-3,000; a scanned page with a stamped header or
 * a page number in its text layer runs a couple of dozen. 200 sits comfortably
 * between them, and is low enough that a chapter-opening page with three lines
 * on it still counts.
 */
export const TEXT_LAYER_MIN_CHARS_PER_PAGE = 200;

/** What `measureTextLayer` found, and everything it decided from. */
export interface TextLayerReport {
  pdfPath: string;
  pageCount: number;
  /** The pages actually read, evenly spread across the document. */
  sampledPages: number[];
  /** Non-whitespace characters found, per sampled page. */
  charsByPage: Record<number, number>;
  totalChars: number;
  /** Sampled pages carrying at least `minCharsPerPage`. */
  pagesWithText: number;
  minCharsPerPage: number;
  /**
   * True when at least half the sampled pages carry text.
   *
   * Half, because a book whose text stops halfway is a book half of which cannot
   * be narrated — that is a scan for this purpose, whatever its front matter
   * says.
   */
  hasTextLayer: boolean;
}

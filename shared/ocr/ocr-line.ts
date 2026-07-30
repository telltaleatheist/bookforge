/**
 * What an OCR engine reports for one recognized line, and for one page.
 *
 * Declared here because THREE programs pass these around — the OCR service in the
 * main process, the renderer that displays them, and the CLI — and they were three
 * separate declarations of the same shape (`electron/ocr-service.ts`,
 * `src/app/features/pdf-picker/services/ocr-job.service.ts`, plus a private copy in
 * `electron.service.ts`). `ocr-service.ts` and `ocr-job.service.ts` re-export these,
 * so every existing import site is unchanged.
 *
 * All geometry is in IMAGE PIXELS of a raster rendered at `OCR_RENDER_SCALE`
 * (see ocr-render.ts) — never in page points.
 */

export interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
  // Tesseract's own layout analysis. Lines sharing a (blockNum, parNum) pair
  // belong to the same paragraph — this is the segmentation Tesseract already
  // performed, and it is far more reliable than re-deriving paragraph breaks
  // from geometry downstream. Absent for OCR plugins that don't report it.
  blockNum?: number;
  parNum?: number;
  /**
   * Typography, from the legacy-engine attribute pass. LSTM (--oem 1) reports
   * none of this, so without the second pass every OCR line arrives the same
   * size and weight and the classifier is blind to the strongest heading,
   * caption and footnote signals.
   */
  fontName?: string;
  /** Point size, as reported (not derived from bounding-box height). */
  fontSize?: number;
  /** 0..1 share of the line's words marked bold. Per-word reads are noisy. */
  boldFrac?: number;
  /** 0..1 share of the line's words marked italic. */
  italicFrac?: number;
  /**
   * Line metrics Tesseract reports in hOCR but not in TSV — which is why the
   * pipeline used to estimate font size from bounding-box height and land 86%
   * of a book on the clamp floor.
   */
  /** Measured type size in image pixels (from x-height). Divide by render scale for points. */
  xSize?: number;
  /** Ascender height above the x-height band, in image pixels. */
  ascenders?: number;
  /**
   * Descender depth below the baseline, in image pixels.
   *
   * Text set in capitals has essentially none, which identifies running heads,
   * chapter openers and small-caps subheads optically — that holds even when
   * OCR misreads the letters themselves, which case-from-text cannot.
   */
  descenders?: number;
  /** Baseline slope. Near zero on a flat scan; rises where the page curves. */
  baselineSlope?: number;
}

/**
 * The OCR result of one page, reduced to what block construction reads.
 *
 * Deliberately narrower than either caller's page-result type (the renderer's
 * `OcrPageResult`, the main process's `HeadlessOcrPageResult`) so both are
 * assignable without either having to know about the other.
 */
export interface OcrPageLines {
  /** 0-based page index. */
  page: number;
  textLines?: OcrTextLine[];
}

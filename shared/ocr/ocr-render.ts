/**
 * The ONE render resolution the OCR path uses, in one place.
 *
 * Tesseract's paragraph segmentation is resolution-dependent — it groups lines by
 * PHYSICAL distance, so the same page rasterised at a different dpi comes back with
 * different paragraphs. Every hand label in the training corpus is keyed to the
 * segmentation at 200 dpi, so moving this re-keys the corpus. Move it only if you
 * mean exactly that.
 *
 * This constant used to exist three times: `OCR_DPI` in `electron/ocr-service.ts`,
 * `OCR_DPI` + `OCR_RENDER_SCALE` in `pdf-picker.component.ts` (labelled "MIRROR of
 * OCR_DPI in electron/ocr-service.ts"), and a literal 300 in `headless-ocr.ts` that
 * had already drifted — Tesseract was told the page was 1.5x smaller than it was.
 * The mirrors are re-exports now.
 */

/** Render dpi for every page handed to OCR. */
export const OCR_DPI = 200;

/**
 * Image pixels per PDF point in an OCR raster — the number that converts an OCR
 * bounding box back into page coordinates.
 *
 * Both producers of those rasters render at exactly this scale:
 *   - the picker, via `renderPage(page, OCR_RENDER_SCALE)`
 *   - `headless-ocr.ts`, via `mutool draw -r OCR_DPI`
 *
 * so the conversion is not a caller's choice to pass in and get wrong. It used to
 * be: the picker divided OCR boxes by a scale derived from the document's PAGE
 * COUNT (1.5 / 2.0 / 2.5), left over from when OCR reused the display raster.
 * Every OCR block's geometry was inflated by 2.78/scale — up to 1.85x — which
 * moved `y / pageHeight` and with it every footnote, footer and caption verdict.
 */
export const OCR_RENDER_SCALE = OCR_DPI / 72;

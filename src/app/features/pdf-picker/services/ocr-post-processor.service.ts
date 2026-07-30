/**
 * OCR Post-Processor Service — the renderer's DI handle on shared OCR logic.
 *
 * There is no logic here. Turning recognized lines into categorized paragraph
 * blocks lives in `shared/ocr/ocr-post-processing.ts`, which the main process and
 * the CLI compile too, so `cli/ocr-pdf.js --project` writes into a manifest exactly
 * the blocks this picker would have produced — same segmentation, same categories
 * (the thirteen-class contract in `shared/ocr/block-categories.ts`), same
 * `ocr_p{page}_{suffix}_{index}` id shape. Hand labels are keyed to those ids, so a
 * second "equivalent" implementation would quietly invalidate them.
 *
 * If you are looking for the merge rules, the footnote-zone detection or the
 * category thresholds, they are in the shared module. Add nothing here.
 */

import { Injectable } from '@angular/core';
import type { PageDimension } from './pdf.service';
import type { OcrPageLines } from '@shared/ocr/ocr-line';
import { processOcrPageResults, type ProcessedOcrResult } from '@shared/ocr/ocr-post-processing';

export type { ProcessedOcrResult };

@Injectable({
  providedIn: 'root'
})
export class OcrPostProcessorService {

  /**
   * OCR page results → categorized paragraph blocks, page dimensions in POINTS.
   *
   * Throws if a page in `results` has no entry in `pageDimensions`: every category
   * threshold is a fraction of page height, so an unmeasured page cannot be
   * classified, only mis-classified.
   */
  processOcrPageResults(
    results: readonly OcrPageLines[],
    pageDimensions: PageDimension[]
  ): ProcessedOcrResult {
    return processOcrPageResults(results, pageDimensions);
  }
}

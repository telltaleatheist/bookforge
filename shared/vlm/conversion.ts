/**
 * vlm conversion — the second route from a PDF to this project's book.
 *
 * `foundry vlm-convert` hands each page picture to a document vision model
 * (dots.ocr) and takes back a description of the page: a box, a category and the
 * words, in reading order. Foundry assembles those into an EPUB and stamps every
 * element it writes with `data-bf-cat` (the model's own category) and
 * `data-bf-page` (the PDF page it was read from) — see foundry README
 * §vlm-convert. That EPUB is the COMPLETE book: footnotes collected at the end
 * of their chapter, figures cropped and embedded, captions kept.
 *
 * This module is the wire contract for driving that from BookForge, and it is
 * pure: the categories dots answers with, how they are said in BookForge's own
 * palette, and how one of foundry's progress lines is read. Main, preload and
 * the renderer all import it, so there is one spelling of each.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * It is not a processing PASS. A pass reads `manifest.outputs.epub`, transforms
 * it, and renames the result back onto the same path (docs/PROCESSING_PIPELINE_V2.md);
 * a conversion is where the book COMES FROM, so there is nothing to read and
 * nothing to diff against. It is a document stage — claimed, announced and
 * cancelled through the same registry the cast and the detect use — and the
 * chain planner never sees it.
 */

/**
 * The categories dots.ocr answers with, lower-cased, exactly as foundry stamps
 * them (`CATEGORY_ATTRIBUTE` in foundry src/vlm/dots-book.ts).
 *
 * `page-header` and `page-footer` are absent because foundry DROPS those blocks
 * — running heads and folios never reach the book — so no element can carry
 * them. Adding them here would describe a stamp that is never written.
 */
export const VLM_CATEGORIES = [
  'text',
  'title',
  'section-header',
  'footnote',
  'caption',
  'table',
  'picture',
  'quote',
  'formula',
  'list-item',
] as const;

export type VlmCategory = (typeof VLM_CATEGORIES)[number];

/**
 * dots' category → BookForge's block-category palette (shared/ocr/block-categories.ts).
 *
 * The two vocabularies were written for different jobs and the map is the whole
 * of the translation between them, stated once. Three of them need saying:
 *
 *  - `title` and `section-header` are foundry's two heading levels. BookForge
 *    has four (`title`, `chapter`, `heading`, `subheading`), and NOTHING here
 *    guesses which of the middle two a heading is: dots was not asked that
 *    question, so an answer would be invented. `title` → `title`,
 *    `section-header` → `heading`, and the user relabels a chapter opening in
 *    the picker where the page is in front of them.
 *  - `list-item` → `list`, which is BookForge's name for entry-per-line content.
 *  - `formula` has no counterpart, and that is a real gap rather than a missing
 *    value: a display equation is body content that is not a sentence. It goes
 *    to `body` — it IS narrated unless the user strikes it — and is named here
 *    so the choice is visible rather than buried in a `??`.
 *
 * A category outside this table is a disagreement between foundry and BookForge
 * about what the model can answer, and `blockCategoryForVlm` throws naming it.
 */
export const VLM_CATEGORY_TO_BLOCK: Readonly<Record<VlmCategory, string>> = {
  'text': 'body',
  'title': 'title',
  'section-header': 'heading',
  'footnote': 'footnote',
  'caption': 'caption',
  'table': 'table',
  'picture': 'image',
  'quote': 'quote',
  'formula': 'body',
  'list-item': 'list',
};

/**
 * The palette id for a `data-bf-cat` value, or a refusal naming it.
 *
 * Never a fallback: a stamp this app cannot read means the book was written by a
 * foundry that answers with categories this build does not know, and painting it
 * as body text would hide that behind a plausible screen.
 */
export function blockCategoryForVlm(stamped: string, whatFor: string): string {
  const mapped = VLM_CATEGORY_TO_BLOCK[stamped as VlmCategory];
  if (mapped === undefined) {
    throw new Error(
      `${whatFor}: an element is stamped data-bf-cat="${stamped}", which is not a category this `
      + `build of BookForge knows. The ten foundry's vlm-convert writes are `
      + `${VLM_CATEGORIES.join(', ')}. Update BookForge, or re-convert with the foundry it ships with.`
    );
  }
  return mapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// The stage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stage's user-facing name — the label the registry refuses a second run
 * with, the one the picker's progress modal shows, and the one that travels on
 * every `document:stage-*` message. Said once so those three cannot differ.
 */
export const VLM_CONVERT_STAGE = 'Convert to EPUB';

export interface VlmConvertRequest {
  /** Absolute project directory. */
  projectDir: string;
  /** The PDF variant to read, when the project holds more than one. */
  variantId?: string;
  /** An absolute PDF inside the project, when the caller already chose. */
  sourcePath?: string;
}

export interface VlmConvertResult {
  /** Absolute path to the book that was written — also `manifest.outputs.epub`. */
  epubPath: string;
  /** Project-relative, forward slashes. */
  relPath: string;
  /** Pages the model was asked for in THIS run. Zero when everything resumed. */
  inferredPages: number;
  /** Every page of the PDF. */
  totalPages: number;
  /**
   * Pages that are NOT in the book, each with foundry's own reason. Never
   * silent: a page the model could not read is a page of the user's book that
   * is missing, and it is reported rather than absorbed.
   */
  unreadable: Array<{ page: number; reason: string }>;
}

/**
 * What one of foundry's stderr lines says about how far the run has got, or null
 * when it says nothing about progress.
 *
 * Pure, so it can be tested against real lines without spawning anything. Two
 * shapes carry a page count, and they are the two routes through
 * `vlmConvert`:
 *
 *   vlm-convert: page 3/317 — 1300x2112, 4210 chars, …     (MLX, local)
 *   vlm-convert: page 12 (4/40) — 3980 chars, …            (an endpoint)
 *
 * The endpoint form counts pages IT was asked for, which is the honest total
 * for a resumed run — the pages already banked in the readings file are not
 * being read again and a bar that counted them would sit still at the start.
 */
export interface VlmProgressLine {
  done: number;
  total: number;
  message: string;
}

export function parseVlmProgressLine(line: string): VlmProgressLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('vlm-convert:')) return null;

  // The endpoint form is checked first: it also contains "page N", and reading
  // it with the MLX pattern would report the PDF page number as a count.
  const viaEndpoint = /\bpage\s+\d+\s+\((\d+)\/(\d+)\)/.exec(trimmed);
  if (viaEndpoint) {
    return { done: Number(viaEndpoint[1]), total: Number(viaEndpoint[2]), message: trimmed };
  }

  const local = /\bpage\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (local) {
    return { done: Number(local[1]), total: Number(local[2]), message: trimmed };
  }

  return null;
}

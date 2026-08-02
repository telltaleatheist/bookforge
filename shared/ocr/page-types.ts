/**
 * Page-level marking: a whole page declared a title page or a copyright page.
 *
 * Labelling a scanned book one block at a time is right for prose and wasteful
 * for the pages that are entirely one thing. A title page — and a "PART TWO"
 * divider, which is the same page in a different hat — is a handful of blocks
 * that are all the title. A copyright page is a slab of text no narration will
 * ever read. Both are one decision, and this turns them into one gesture.
 *
 *   title      every block on the page becomes `title`, except the specks
 *   copyright  every block on the page becomes `discard`
 *
 * ── THE SPECK RULE ──────────────────────────────────────────────────────────
 *
 * A scan's title page carries junk that is not type: a fleuron read as 'Ap', a
 * stray '+', the edge of a rule picked up as a character. Labelling those
 * `title` teaches the model that a 3pt smudge is a book title, so they get
 * `discard` instead.
 *
 * What counts as a speck is NOT decided here. `display-run-merge.ts` already
 * owns that test — its page gate holds sub-kicker blocks out of the merged
 * title unit for exactly this reason — and that module is byte-identical with
 * the foundry repo's copy, so it cannot be edited from this side. The threshold
 * is imported from it (`KICKER_MIN_FSIZE_RATIO`) and the comparison is written
 * the one way that module writes it, so a block held out of a merged title
 * there is a speck here.
 *
 * The modal body type size the threshold is relative to comes from
 * `planDisplayRuns` for the same reason: it is a book-global quantity with a
 * specific definition (the mode over multi-line blocks) and re-deriving it here
 * would be a second definition free to drift from the first.
 *
 * Marks are bookkeeping. The block labels they produce go through the ordinary
 * correction machinery and are the human's judgements from then on; nothing in
 * training reads `pageTypes`.
 */

import { DISPLAY_RUN_RULE, planDisplayRuns, type DisplayRunBlock } from './display-run-merge';
import type { PageDimension, TextBlock } from './text-block';

/** What a whole page can be declared to be. */
export type CorpusPageType = 'title' | 'copyright';

export const CORPUS_PAGE_TYPES: readonly CorpusPageType[] = ['title', 'copyright'];

/** How to name one in a sentence. */
export const CORPUS_PAGE_TYPE_NAMES: Record<CorpusPageType, string> = {
  title: 'title page',
  copyright: 'copyright page',
};

/** The class every block on such a page carries, specks aside. */
const PAGE_TYPE_CATEGORY: Record<CorpusPageType, string> = {
  title: 'title',
  copyright: 'discard',
};

/** Sub-kicker OCR junk is never content, whatever the page is. */
const SPECK_CATEGORY = 'discard';

/** Bad input to a page mark. Loud, and it names what was wrong. */
export class PageTypeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageTypeInputError';
  }
}

export function isCorpusPageType(value: unknown): value is CorpusPageType {
  return value === 'title' || value === 'copyright';
}

/** A block as this rule needs it — the same field names `TextBlock` uses. */
export interface PageTypeBlock {
  id: string;
  font_size: number;
}

/**
 * Below the kicker floor there is no type, only an OCR artifact.
 *
 * Written as the negation of the module's own `>=` so that a NaN or a missing
 * size reads as a speck rather than as a title.
 */
export function isSpeckFontSize(fontSize: number, modalFontSize: number): boolean {
  return !(fontSize >= DISPLAY_RUN_RULE.KICKER_MIN_FSIZE_RATIO * modalFontSize);
}

/**
 * The book's modal body type size, as the merge rule computes it.
 *
 * Whole-book by necessity: the mode is over every block in the document, so a
 * page cannot answer it on its own.
 */
export function bookModalFontSize(
  blocks: readonly TextBlock[],
  pageDimensions: readonly PageDimension[],
): number {
  if (blocks.length === 0) {
    throw new PageTypeInputError('This document has no blocks, so there is no body type size.');
  }
  const forRule: DisplayRunBlock[] = blocks.map(b => {
    const dims = pageDimensions[b.page];
    if (!dims) {
      throw new PageTypeInputError(
        `Block ${b.id} is on page ${b.page + 1}, which has no recorded page size — ` +
        'the body type size cannot be measured against pages that are not there.',
      );
    }
    return {
      id: b.id,
      page: b.page,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      fontSize: b.font_size,
      lineCount: b.line_count ?? 0,
      pageWidth: dims.width,
      pageHeight: dims.height,
      text: b.text,
    };
  });
  return planDisplayRuns(forRule).modalFontSize;
}

/**
 * The corrections a page mark makes: one entry per block on the page.
 *
 * Every block gets an entry, including ones already labelled — one gesture
 * wins, and undo covers the mistake.
 */
export function planPageTypeLabels(
  pageType: CorpusPageType,
  pageBlocks: readonly PageTypeBlock[],
  modalFontSize: number,
): Array<{ blockId: string; categoryId: string }> {
  if (!isCorpusPageType(pageType)) {
    throw new PageTypeInputError(`${String(pageType)} is not a page type.`);
  }
  if (!(modalFontSize > 0) || !Number.isFinite(modalFontSize)) {
    throw new PageTypeInputError(
      `The body type size is ${String(modalFontSize)}, so the speck floor is undefined.`,
    );
  }
  const category = PAGE_TYPE_CATEGORY[pageType];
  return pageBlocks.map(b => ({
    blockId: b.id,
    categoryId: isSpeckFontSize(b.font_size, modalFontSize) ? SPECK_CATEGORY : category,
  }));
}

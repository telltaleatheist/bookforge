/**
 * narration-editor-state — the picker's OTHER deletion record, read as element
 * strikes.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * A book curated in the picker has had two records of the same intent written
 * about it. Deleting a block or a page in Select mode lands in
 * `manifest.source.deletedBlockIds` / `.deletedPages`, which is where the
 * picker's edit set has always been saved. Striking an element for narration
 * lands in `outputs.epub.narrationDeletions`, which is what the narration cut is
 * expressed in. The cut read only the second, so a user who deleted 64 pages and
 * 58 blocks got a `.tts.epub` that left out 46 elements recorded weeks earlier
 * and none of what he had just done — and nothing anywhere said so.
 *
 * The picker now records both through one derivation (`deriveNarrationStrikes`).
 * This module is for the books that were curated BEFORE it did: their intent is
 * on disk in the old record, expressed in a vocabulary the cut does not speak,
 * and re-deleting 122 things by hand is not a reasonable thing to ask. So the
 * export translates what it finds, once, into the record it does read.
 *
 * ── Why it needs the book laid out ──────────────────────────────────────────
 *
 * A deleted PAGE is a page of MUPDF'S PAGINATION of the book — an EPUB has no
 * pages of its own, so "page 140" only means anything once the book has been
 * laid out at 600×900×18, which is what the analyzer does and what the picker
 * was looking at. A deleted BLOCK is a block of that same layout. Neither can be
 * resolved from the markup alone: `readEpubConversionUnits` gives every element
 * and its `data-bf-page`, but `data-bf-page` is the page of the PDF a CONVERTED
 * book was read from, and a publisher's EPUB — which is exactly the kind of book
 * this affects — carries no such stamp at all.
 *
 * So the block layer is read the way everything else reads it: through the pdf
 * worker, which puts the answer in the analysis cache keyed by the file's
 * sha256. The picker's own open of the same book is a hit on that cache and
 * vice-versa, so the book is laid out once however many times it is asked for.
 *
 * ── Why it is scoped to a project made from an EPUB ─────────────────────────
 *
 * For a project made from a PDF, the editor's numbers are about the PDF: a
 * deleted page is a page of paper, and a block id belongs to the scan's layout.
 * The book beside it came out of `foundry vlm-convert`, which already left the
 * skipped pages out. Translating those numbers against the book's own pagination
 * would strike whatever happened to land on the same page index — real,
 * invisible damage to a finished book. So the translation runs for projects
 * whose source IS the EPUB, and says so when it declines.
 */

import * as path from 'path';

import {
  deriveNarrationStrikes,
  describeUnstruckDeletions,
  type NarrationElementKey,
  type NarrationLaidOutBlock,
  type NarrationStrikes,
} from '../shared/vlm/narration-deletions';
import * as manifestService from './manifest-service';

/**
 * One block of the analyzer's answer, as much of it as this module reads.
 *
 * Declared rather than imported from `pdf-analyzer` so requiring this module
 * does not drag mupdf's WASM loader into whatever required it. The fields are
 * `TextBlock`'s own and are checked at runtime below, because the answer crosses
 * a worker boundary as plain JSON.
 */
interface AnalyzedBlock {
  id: string;
  page: number;
  text: string;
  is_image: boolean;
  is_footnote_marker: boolean;
  bf_element?: string;
}

/**
 * The book, laid out, as the picker sees it.
 *
 * Through the worker proxy for the two reasons every other analysis goes that
 * way (see `working-copy.ts`): mupdf's WASM heap stays out of the main process,
 * and the result lands in the analysis cache under the file's sha256 — the same
 * cache the picker's own `analyzeQuick` reads — so nothing lays this book out
 * twice.
 */
export async function readBookBlockLayer(
  bookAbsPath: string
): Promise<NarrationLaidOutBlock[]> {
  // Lazily, so requiring this module does not pull in the worker proxy and,
  // through it, Electron's `app`.
  const proxy = require('./pdf-worker-proxy') as typeof import('./pdf-worker-proxy');
  const result = await proxy.call('analyze', [bookAbsPath]);
  const blocks = (result as { blocks?: AnalyzedBlock[] } | null)?.blocks;
  if (!Array.isArray(blocks)) {
    throw new Error(
      `Analyzing ${path.basename(bookAbsPath)} answered no block list, so the deletions recorded `
      + 'against it cannot be resolved to anything. The narration copy is not written — try again.'
    );
  }

  return blocks.map((b) => {
    if (typeof b.id !== 'string' || !Number.isInteger(b.page)) {
      throw new Error(
        `Analyzing ${path.basename(bookAbsPath)} answered a block with no id or no page `
        + `(${JSON.stringify(b).slice(0, 120)}). A deletion is recorded as one of each, so there is `
        + 'nothing to resolve it against.'
      );
    }
    return {
      id: b.id,
      page: b.page,
      ...(typeof b.bf_element === 'string' ? { element: b.bf_element } : {}),
      unplaceable: b.is_image === true || b.is_footnote_marker === true,
      excerpt: (b.text ?? '').slice(0, 80),
    };
  });
}

/** What the editor's deletions came to, and what they could not reach. */
export interface EditorStateTranslation {
  /** Every element the editor's deletions name, sorted, without duplicates. */
  elements: NarrationElementKey[];
  /** How many deleted blocks and pages were read. */
  deletedBlockCount: number;
  deletedPageCount: number;
  /** The derivation itself, so a caller can report the shape of what it got. */
  strikes: NarrationStrikes;
  /** What could not be struck, in one sentence, or null. */
  unstruckReport: string | null;
}

/**
 * Why this project's editor state cannot be read as strikes against its book,
 * or null when it can.
 *
 * Separate from the translation so the export can say the reason without having
 * laid the book out to find it out.
 */
export function editorStateTranslationRefusal(
  deletions: manifestService.EditorStateDeletions,
  projectDir: string
): string | null {
  if (deletions.sourceType === 'epub') return null;
  if (deletions.blockIds.length === 0 && deletions.pages.length === 0) return null;
  return (
    `${path.basename(projectDir)} was made from a ${deletions.sourceType.toUpperCase()}, so the `
    + `${deletions.pages.length} page(s) and ${deletions.blockIds.length} block(s) its editor has `
    + 'deleted are positions in that file rather than in the book. They are not translated into '
    + 'narration strikes — strike what you want left out with the book itself on screen.'
  );
}

/**
 * The editor's deletions, resolved against the book, as element strikes.
 *
 * Lays the book out (cached) and re-uses the picker's own derivation, so the two
 * routes into the record cannot disagree about what a deletion means. Reports
 * every deletion it could NOT resolve rather than dropping it: a deletion that
 * silently does nothing is the failure this module exists to end.
 */
export async function translateEditorStateDeletions(
  deletions: manifestService.EditorStateDeletions,
  bookAbsPath: string
): Promise<EditorStateTranslation> {
  const blocks = await readBookBlockLayer(bookAbsPath);
  const strikes = deriveNarrationStrikes(
    blocks,
    new Set(deletions.blockIds),
    new Set(deletions.pages)
  );
  return {
    elements: strikes.elements,
    deletedBlockCount: deletions.blockIds.length,
    deletedPageCount: deletions.pages.length,
    strikes,
    unstruckReport: describeUnstruckDeletions(strikes),
  };
}

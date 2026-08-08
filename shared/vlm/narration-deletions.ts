/**
 * narration-deletions — what the user struck out of the book FOR NARRATION, and
 * the second file that is written from it.
 *
 * Owen's design, 2026-08-07: the EPUB `foundry vlm-convert` writes is the
 * OFFICIAL, COMPLETE book — footnotes at chapter ends, figures, captions, the
 * lot — and it becomes the project's `outputs.epub`. What a listener wants is
 * usually less than that. So the book opens in the picker, the user deletes what
 * they do not want to hear, and **exporting those deletions writes a SECOND
 * file** which is what narration reads. The official conversion is never
 * rewritten.
 *
 * ── Why the deletions are STATE and not a file ──────────────────────────────
 *
 * Because the two answers are different books and both have to survive. If a
 * deletion edited the official EPUB there would be exactly one book, and the
 * complete one the user paid ninety minutes of GPU for would be gone the first
 * time they struck a footnote. So the deletions live in the manifest, keyed to
 * the book they were made against, and the narration copy is DERIVED from them
 * at export.
 *
 * ── The identity of an element, and why it is positional ────────────────────
 *
 * foundry's emitter stamps every element with its category and its source page
 * but gives it no id, and the official EPUB is never written to — so its
 * elements cannot move. A key is therefore the spine document's zip entry name
 * and the element's index within that document's UNIT LIST, which is the
 * aligner's own traversal (`collectExportUnits`, electron/epub-processor.ts) and
 * the same traversal the narration writer walks. One traversal, two readers, and
 * an index that means the same thing to both.
 *
 * It is stamped with the book's sha256 all the same. A pass that rewrites the
 * book in place (simplify, translate) leaves deletions describing elements that
 * are no longer there, and the honest reading of that is a REFUSAL naming the
 * book — the `scanId` precedent from `manifest.source.deletedBlockLines`, for
 * the same reason: a positional record and a file that moved under it cannot be
 * reconciled by guessing.
 */

/** One element struck out of the book, `<zip entry>#<index>`. */
export type NarrationElementKey = string;

export interface NarrationDeletions {
  /**
   * sha256 of the book EPUB these deletions were made against. A book whose
   * bytes have changed since VOIDS them — see this file's header.
   */
  epubSha256: string;
  /** The struck elements, sorted, without duplicates. */
  elements: NarrationElementKey[];
  /** ISO timestamp of the last edit. */
  updatedAt: string;
}

/** The narration copy, as the manifest records it. */
export interface NarrationEpubOutput {
  /** Project-relative, forward slashes, e.g. `source/The Waste Land.tts.epub`. */
  path: string;
  modifiedAt: string;
  /** The book it was cut from, so a stale copy can be named rather than guessed at. */
  fromEpubSha256: string;
  /** How many elements were removed. Zero is legal: a copy of the whole book. */
  removedElements: number;
  /**
   * How many digits-only `<sup>` footnote references were removed as the copy
   * was written (shared/text/sup-markers.ts). Reported so the UI can say what
   * the narration copy actually differs from the book by — a copy with nothing
   * struck and 1,864 markers gone is not "identical to the book".
   *
   * OPTIONAL because records written before the strip existed have no number,
   * and inventing 0 for them would say it found none rather than that it never
   * ran.
   */
  removedSupMarkers?: number;
}

export function narrationElementKey(file: string, index: number): NarrationElementKey {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`A narration element index must be a whole number ≥ 0, not ${index}.`);
  }
  return `${file}#${index}`;
}

export function parseNarrationElementKey(key: NarrationElementKey): { file: string; index: number } {
  const at = key.lastIndexOf('#');
  const index = at < 0 ? NaN : Number(key.slice(at + 1));
  if (at <= 0 || !Number.isInteger(index) || index < 0) {
    throw new Error(
      `"${key}" is not a narration element key. The shape is <zip entry>#<index>, e.g. `
      + 'OEBPS/chapter-01.xhtml#12.'
    );
  }
  return { file: key.slice(0, at), index };
}

/**
 * A block of the book as laid out in the picker, as much of it as this module
 * needs: its id, and the element of the official EPUB it was laid out FROM.
 *
 * `element` is absent on blocks the aligner could not place — the nav TOC, a
 * page-break span with no unit of its own. Those blocks are not deletable
 * through this record and are skipped rather than guessed at.
 */
export interface NarrationBlock {
  id: string;
  element?: NarrationElementKey;
  /** The PDF page this block's element was read from (`data-bf-page`). */
  sourcePage?: number;
}

/**
 * A block of the book AS LAID OUT, with everything the strike derivation needs
 * to turn an editor deletion into an element key — or to say why it cannot.
 *
 * `page` is the page of the LAID-OUT book the block was drawn on (mupdf's own
 * pagination at 600×900), which is the number a page deletion is recorded
 * under. It is deliberately not `sourcePage`: that is `data-bf-page`, the page
 * of the PDF a converted book was READ from, and a publisher's EPUB has none at
 * all. The two are different numbers about different pieces of paper and the
 * one the user deleted is this one.
 */
export interface NarrationLaidOutBlock {
  id: string;
  page: number;
  /** The element it was laid out FROM, absent when the aligner could not place it. */
  element?: NarrationElementKey;
  /**
   * True for the two classes the aligner NEVER places, by design rather than by
   * failure: an image block (mupdf's `[Image 528x815]` furniture, which exists
   * in no DOM text node) and a footnote-marker block (whose text duplicates its
   * parent's, so aligning it would double-count). Both are skipped outright by
   * `alignBlocksToEpub` — `if (b.isImage || b.isFootnoteMarker) continue` — so
   * their having no element is a STATE and not a problem, and reporting them
   * beside genuinely unaligned prose would bury the prose in furniture.
   */
  unplaceable: boolean;
  /** The opening of the block's text, so an unstruck deletion can be NAMED. */
  excerpt: string;
}

/** Which gesture asked for a block to go. */
export type NarrationDeletionVia = 'block' | 'page';

/**
 * A deletion the user made that NOTHING can be struck for — the block carries no
 * element key, so the narration copy has no way to leave it out.
 *
 * These are surfaced rather than dropped. A deletion that silently does nothing
 * is indistinguishable from one that worked, and the user finds out by hearing
 * the paragraph read aloud in a finished audiobook.
 */
export interface UnstruckDeletion {
  blockId: string;
  page: number;
  via: NarrationDeletionVia;
  excerpt: string;
}

/** What a deletion set comes to, once resolved against the book's elements. */
export interface NarrationStrikes {
  /** The struck elements, sorted, without duplicates. */
  elements: NarrationElementKey[];
  /** How many of them a struck BLOCK named. */
  fromBlocks: number;
  /** How many of them ONLY a struck PAGE named — i.e. what block deletion missed. */
  fromPages: number;
  /** Deletions that name a placeable block carrying no element key. */
  unstruck: UnstruckDeletion[];
  /** Deleted block ids that name no block in this layout at all. */
  unknownBlockIds: string[];
  /** Deleted pages on which nothing at all could be struck. */
  pagesWithNothingStruck: number[];
}

/**
 * Everything the user has deleted, as ELEMENT STRIKES.
 *
 * ── Why pages are in here ───────────────────────────────────────────────────
 *
 * There were two deletion records and the export read one. A block deletion
 * landed in `deletedBlockIds` and a PAGE deletion landed in `deletedPages`, and
 * the strike derivation this replaces looked only at the first — so a user who
 * deleted 64 pages and 58 blocks got a narration copy explained by the 58, and
 * every page he had struck was read aloud. A page deletion is the same
 * statement as striking every block on it, said in one gesture, so it resolves
 * the same way: through the blocks that were laid out on that page.
 *
 * DERIVED, never accumulated. The editor's two sets are the state the user is
 * looking at; this reads them and produces the one record the export cuts by.
 * That is also what makes UNDO work with nothing added for it: restoring a page
 * or a block puts it back in those sets, and the next derivation simply does not
 * name its elements.
 */
export function deriveNarrationStrikes(
  blocks: readonly NarrationLaidOutBlock[],
  deletedBlockIds: ReadonlySet<string>,
  deletedPages: ReadonlySet<number>
): NarrationStrikes {
  const fromBlocks = new Set<NarrationElementKey>();
  const fromPages = new Set<NarrationElementKey>();
  const unstruck: UnstruckDeletion[] = [];
  const seenBlockIds = new Set<string>();
  const struckOnPage = new Map<number, number>();
  for (const page of deletedPages) struckOnPage.set(page, 0);

  for (const block of blocks) {
    seenBlockIds.add(block.id);
    const byBlock = deletedBlockIds.has(block.id);
    const byPage = deletedPages.has(block.page);
    if (!byBlock && !byPage) continue;

    if (block.element === undefined) {
      // Furniture has no element by construction — see `unplaceable`. Naming it
      // would be reporting the absence of something that was never there.
      if (block.unplaceable) continue;
      unstruck.push({
        blockId: block.id,
        page: block.page,
        via: byBlock ? 'block' : 'page',
        excerpt: block.excerpt,
      });
      continue;
    }

    // A block struck BOTH ways counts as a block strike: that is the gesture
    // that names it individually, and counting it twice would make the two
    // numbers add up to more than the set they describe.
    if (byBlock) fromBlocks.add(block.element);
    else fromPages.add(block.element);
    if (byPage) struckOnPage.set(block.page, (struckOnPage.get(block.page) ?? 0) + 1);
  }

  // An element named by a block AND (through a different block) by a page is a
  // block strike, so the two counts partition the set they sum to.
  for (const key of fromBlocks) fromPages.delete(key);

  return {
    elements: [...new Set([...fromBlocks, ...fromPages])].sort(),
    fromBlocks: fromBlocks.size,
    fromPages: fromPages.size,
    unstruck,
    unknownBlockIds: [...deletedBlockIds].filter((id) => !seenBlockIds.has(id)).sort(),
    pagesWithNothingStruck: [...struckOnPage.entries()]
      .filter(([, struck]) => struck === 0)
      .map(([page]) => page)
      .sort((a, b) => a - b),
  };
}

/**
 * What could NOT be struck, in one sentence, or null when everything could.
 *
 * The same shape as the analyzer's unaligned-block warning: a handful named in
 * full, the rest counted, because past a few the list itself becomes the noise.
 */
export function describeUnstruckDeletions(strikes: NarrationStrikes): string | null {
  const parts: string[] = [];

  if (strikes.unstruck.length > 0) {
    const SHOWN = 3;
    const listed = strikes.unstruck
      .slice(0, SHOWN)
      .map((u) => `page ${u.page + 1}, "${u.excerpt.trim()}"`)
      .join('; ');
    const rest = strikes.unstruck.length - SHOWN;
    parts.push(
      `${strikes.unstruck.length} deleted block(s) could not be matched to the markup they were laid `
      + `out from, so they stay in the narration copy: ${listed}`
      + `${rest > 0 ? `; and ${rest} more` : ''}.`
    );
  }

  if (strikes.unknownBlockIds.length > 0) {
    parts.push(
      `${strikes.unknownBlockIds.length} deleted block id(s) name no block in this book at all — the `
      + `first is ${strikes.unknownBlockIds[0]}. They were recorded against a different layout of it.`
    );
  }

  if (strikes.pagesWithNothingStruck.length > 0) {
    const shown = strikes.pagesWithNothingStruck.slice(0, 5).map((p) => p + 1).join(', ');
    const rest = strikes.pagesWithNothingStruck.length - 5;
    parts.push(
      `${strikes.pagesWithNothingStruck.length} deleted page(s) had nothing on them that could be `
      + `struck (page ${shown}${rest > 0 ? `, and ${rest} more` : ''}) — a blank page, or one holding `
      + 'nothing but an image.'
    );
  }

  return parts.length === 0 ? null : parts.join(' ');
}

/**
 * Which blocks a recorded deletion set names, so re-opening the book shows what
 * the user struck.
 *
 * ONE element can own SEVERAL blocks — mupdf re-lays the book out at its own
 * page size and a paragraph becomes one block per visual line — so this is a
 * fan-out, not a lookup, and every block of a struck element is struck.
 */
export function narrationDeletedBlockIds(
  blocks: readonly NarrationBlock[],
  elements: readonly NarrationElementKey[]
): string[] {
  const struck = new Set(elements);
  return blocks.filter((b) => b.element !== undefined && struck.has(b.element)).map((b) => b.id);
}

/** Every block that came off one source page — the "delete this page" selection. */
export function narrationBlocksOnSourcePage(
  blocks: readonly NarrationBlock[],
  sourcePage: number
): string[] {
  return blocks.filter((b) => b.sourcePage === sourcePage).map((b) => b.id);
}

/**
 * The narration copy's path, beside the book and named after it.
 *
 * `<stem>.tts.epub`, from the book's OWN recorded path — never re-derived from
 * the title, because the book's name is settled once by
 * `manifest-service.exportEpubStem` and a second derivation here would be a
 * second naming rung (docs: "The export EPUB — the project's converted book").
 */
export function narrationEpubRelPath(bookRelPath: string): string {
  if (!bookRelPath.toLowerCase().endsWith('.epub')) {
    throw new Error(
      `The project's book is recorded as "${bookRelPath}", which is not an EPUB. The narration copy `
      + 'is cut from the book, so there is nothing to cut.'
    );
  }
  return `${bookRelPath.slice(0, -'.epub'.length)}.tts.epub`;
}

/** One element of the official book, as the narration writer sees it. */
export interface NarrationUnit {
  key: NarrationElementKey;
  /** `data-bf-cat`, or null on an element the conversion did not stamp. */
  category: string | null;
  /** `data-bf-page`, or null for the same reason. */
  sourcePage: number | null;
}

export interface NarrationRemovalPlan {
  /** The keys to remove, in the book's own order. */
  remove: NarrationElementKey[];
  /** How many elements the book has. */
  total: number;
}

/**
 * Which of the book's elements the narration copy leaves out.
 *
 * A recorded key that names no element in the book STOPS the export by name.
 * That is the same rule the editor's block deletions follow at foundry export
 * (docs: "A deletion that cannot be re-derived … STOPS the export by name"), and
 * for the same reason: a positional record whose position is gone describes
 * something, and quietly dropping it would remove a different paragraph or none
 * at all, in a book nobody would think to check.
 */
export function planNarrationRemoval(
  units: readonly NarrationUnit[],
  deletions: readonly NarrationElementKey[]
): NarrationRemovalPlan {
  const present = new Set(units.map((u) => u.key));
  const missing = deletions.filter((key) => !present.has(key));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of the ${deletions.length} element(s) struck out of this book are not in it `
      + `any more — the first is ${missing[0]}. The narration copy is cut from the book by position, `
      + 'so a book that has been rewritten since (a simplify or translate pass) voids them. Open the '
      + 'book in the editor, strike what you want left out again, and export.'
    );
  }
  const struck = new Set(deletions);
  return {
    remove: units.filter((u) => struck.has(u.key)).map((u) => u.key),
    total: units.length,
  };
}

/**
 * Everything a window needs to open a book for narration curation, in one
 * answer — the wire shape of `narration:state`.
 *
 * Declared here rather than in main because the picker reads every field of it,
 * and a shape declared on one side of the process boundary is a shape the other
 * side re-declares slightly differently.
 */
export interface NarrationState {
  /** Absolute path to the book EPUB, or null when the project has none. */
  bookPath: string | null;
  /** Project-relative, forward slashes. */
  bookRelPath: string | null;
  /** sha256 of the book as it is on disk right now. */
  bookSha256: string | null;
  /**
   * True when the book carries `data-bf-cat` stamps — i.e. a document VLM read
   * it. Only such a book can be struck through by element, because only such a
   * book states what its elements ARE.
   */
  converted: boolean;
  /** The strikes, or null when there are none (or they were void and cleared). */
  deletions: NarrationDeletions | null;
  /**
   * Why the strikes that WERE recorded no longer describe this book, or null.
   * Set exactly when a stale record was found and cleared, so the window can say
   * it once instead of silently showing an unstruck book.
   */
  staleReason: string | null;
  /** Where the narration copy is, when one has been exported. */
  narrationPath: string | null;
  narrationRelPath: string | null;
}

/**
 * Why these deletions do not describe this book, or null when they do.
 *
 * Separate from `planNarrationRemoval` because it answers a question the UI asks
 * BEFORE anything is exported — the picker needs to know on open whether to show
 * the user's strikes or tell them the record is void.
 */
export function narrationDeletionsStaleReason(
  deletions: NarrationDeletions | null | undefined,
  bookSha256: string
): string | null {
  if (!deletions) return null;
  if (deletions.epubSha256 === bookSha256) return null;
  return (
    'This book has changed since these deletions were made, so they name elements that may no longer '
    + 'be where they were. They have been cleared — strike what you want left out of the narration '
    + 'again, then export.'
  );
}

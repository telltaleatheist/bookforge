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

/** The struck elements, derived from which blocks the editor has deleted. */
export function narrationElementsOf(
  blocks: readonly NarrationBlock[],
  deletedBlockIds: ReadonlySet<string>
): NarrationElementKey[] {
  const keys = new Set<NarrationElementKey>();
  for (const block of blocks) {
    if (!block.element) continue;
    if (!deletedBlockIds.has(block.id)) continue;
    keys.add(block.element);
  }
  return [...keys].sort();
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

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

/**
 * One thing struck out of the book. THREE forms, in THREE SEPARATE NAMESPACES:
 *
 *  - `<zip entry>#<index>` — a TEXT unit, indexed into that document's unit list
 *    (`collectExportUnits`, electron/epub-processor.ts).
 *  - `<zip entry>#img<N>` — an IMAGE element, indexed into that document's image
 *    list in flow order (`collectImageElements`, same file): `<img>`, `<svg>`,
 *    and a bare `<image>`, which is exactly the set `bodyIsEmpty` counts as
 *    content.
 *  - `<zip entry>#doc` — the WHOLE DOCUMENT, struck by name rather than by any
 *    position inside it.
 *
 * ── Why a document is a thing you can strike ────────────────────────────────
 *
 * Owen, 2026-08-09: when the identity of individual pieces is ambiguous,
 * escalate to the enclosing container whose identity is CERTAIN. A spine
 * document's identity always is — it is a zip entry name, and the book is never
 * rewritten — while the identity of a picture inside it is an ordinal the
 * matcher can refuse (`alignImageBlocks`) and the identity of a unit is an index
 * into a traversal.
 *
 * Measured on Killing America: `bm01.xhtml` states 3 image elements and mupdf
 * laid 6 picture blocks out of it, `back.xhtml` states 4 and laid out 3. Nine
 * blocks that no ordinal can settle, so nine deletions that reached nothing —
 * the user struck the plate gallery out and the plates were still in the
 * narration copy. Striking the two DOCUMENTS removes all nine without a single
 * one of them ever being identified, because the container they are in is not
 * in doubt.
 *
 * ── Why images get their own numbering rather than a place in the unit list ──
 *
 * Because the unit list is already the identity of every strike in the library.
 * A picture is not a text unit — it contributes no characters to the alignment
 * stream, `collectExportUnits` collects the ELEMENT AROUND it (a `<p>`, a
 * `<div class="image">`) or nothing at all — so giving images unit indices would
 * mean renumbering the units of every document that holds one, and every
 * recorded strike after the first picture in that document would then name a
 * different paragraph. A second namespace costs one prefix and invalidates
 * nothing.
 *
 * Until Aug 2026 images had NO identity at all, and the consequence was measured
 * on a real book: `cover.xhtml`, `htit.xhtml` and `title.xhtml` hold a single
 * `<img>` each, the user struck those pages out, and the narration copy still
 * had all three — nothing could be recorded for them, so their documents never
 * emptied and the pruning that would have removed them never fired.
 */
export type NarrationElementKey = string;

/** The prefix that puts a key in the IMAGE namespace rather than the unit one. */
const IMAGE_KEY_PREFIX = 'img';

/**
 * What follows the `#` when the key names the DOCUMENT itself.
 *
 * A word rather than a number, so it cannot collide with either of the two
 * numbered namespaces — and it is checked before them, because `img` and a
 * digit run are the only other things that may follow the `#`.
 */
const DOCUMENT_KEY_SUFFIX = 'doc';

/** Which of the three things a key names. */
export type NarrationElementKind = 'unit' | 'image' | 'doc';

/**
 * A key, taken apart. A DISCRIMINATED UNION because a document key has no index
 * and inventing one for it (0, -1) would be a position that names an element.
 */
export type ParsedNarrationElementKey =
  | { file: string; kind: 'unit'; index: number }
  | { file: string; kind: 'image'; index: number }
  | { file: string; kind: 'doc' };

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
  /**
   * The spine documents that were removed, by zip entry name.
   *
   * A document whose every element was struck is left as a blank page in the
   * copy, so it is taken out of the book entirely (electron/epub-processor.ts,
   * `writeNarrationEpub`) — as is a document a `<zip entry>#doc` key struck by
   * name, which goes whole whatever the unit walk did or did not account for.
   * The LIST rather than a count, because it is the only
   * record of which documents this copy does not have — a later reader that
   * cannot find one needs to be able to tell "pruned on purpose" from "the two
   * files have come apart", and those get very different sentences.
   *
   * OPTIONAL because records written before the pruning existed have no list,
   * and inventing an empty one for them would say nothing was pruned rather
   * than that the question was never asked.
   */
  removedDocuments?: string[];
}

export function narrationElementKey(file: string, index: number): NarrationElementKey {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`A narration element index must be a whole number ≥ 0, not ${index}.`);
  }
  return `${file}#${index}`;
}

/** The key of the Nth image element of a document, in flow order. */
export function narrationImageElementKey(file: string, ordinal: number): NarrationElementKey {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`A narration image ordinal must be a whole number ≥ 0, not ${ordinal}.`);
  }
  return `${file}#${IMAGE_KEY_PREFIX}${ordinal}`;
}

/** The key of a WHOLE spine document — everything in it, struck by name. */
export function narrationDocumentKey(file: string): NarrationElementKey {
  if (file.length === 0) {
    throw new Error('A narration document key names a zip entry, and "" is not one.');
  }
  if (file.includes('#')) {
    throw new Error(
      `"${file}" already carries a "#", so it is a key rather than the zip entry name a document `
      + 'key is made from.'
    );
  }
  return `${file}#${DOCUMENT_KEY_SUFFIX}`;
}

export function parseNarrationElementKey(key: NarrationElementKey): ParsedNarrationElementKey {
  const at = key.lastIndexOf('#');
  const rest = at < 0 ? '' : key.slice(at + 1);
  const file = key.slice(0, at);
  if (at > 0 && rest === DOCUMENT_KEY_SUFFIX) return { file, kind: 'doc' };

  const isImage = rest.startsWith(IMAGE_KEY_PREFIX);
  const digits = isImage ? rest.slice(IMAGE_KEY_PREFIX.length) : rest;
  // `Number('')` is 0, which would read `x#` and `x#img` as index 0 — so the
  // digits are checked as characters before they are read as a number.
  const index = /^\d+$/.test(digits) ? Number(digits) : NaN;
  if (at <= 0 || !Number.isInteger(index)) {
    throw new Error(
      `"${key}" is not a narration element key. The shape is <zip entry>#<index> for a text `
      + 'element (e.g. OEBPS/chapter-01.xhtml#12), <zip entry>#img<N> for a picture (e.g. '
      + 'OEBPS/cover.xhtml#img0), or <zip entry>#doc for a whole document (e.g. '
      + 'OEBPS/bm01.xhtml#doc).'
    );
  }
  return isImage ? { file, kind: 'image', index } : { file, kind: 'unit', index };
}

/** What carrying a strike record across a fold did to it. */
export interface NarrationDeletionsFoldMigration {
  /** The record's keys as they name the book AFTER the fold, sorted. */
  elements: NarrationElementKey[];
  /** Keys whose element the fold removed — they name nothing now, so they go. */
  dropped: NarrationElementKey[];
  /** How many keys named the same element under a NEW index. */
  renumbered: number;
}

/**
 * Carry a strike record across a fold that took text units OUT of one document.
 *
 * ── Why the record cannot simply be re-stamped ──────────────────────────────
 *
 * A text-unit key is a POSITION — `<zip entry>#<index>`, minted by the one
 * enumeration walk everything shares — so removing the third unit of a file
 * makes the old fourth the new third and every strike after it name the element
 * one further on. A rename (electron/book-chapters.ts) can re-stamp the record
 * untouched because it adds, removes and reorders nothing; a fold cannot,
 * because removing elements is the whole of what it does.
 *
 * The three namespaces are treated as the three separate things they are:
 *
 *   - TEXT units in the edited file are renumbered, and a key naming one of the
 *     removed units is DROPPED. It named an element that is not in the book any
 *     more; keeping it would strike whichever element slid into its index.
 *   - IMAGE keys (`#img<N>`) are ordinals in their own walk, and a fold refuses
 *     to remove anything holding an `<img>` (electron/epub-processor.ts,
 *     `foldChapterOpeningInBookFile`), so no picture moves.
 *   - `#doc` keys name the document itself and mean the same thing after.
 *
 * Every other file is untouched, because a fold rewrites exactly one.
 */
export function migrateNarrationDeletionsForFold(
  elements: readonly NarrationElementKey[],
  file: string,
  removedIndices: readonly number[],
): NarrationDeletionsFoldMigration {
  const removed = new Set(removedIndices);
  const kept: NarrationElementKey[] = [];
  const dropped: NarrationElementKey[] = [];
  let renumbered = 0;

  for (const key of elements) {
    const parsed = parseNarrationElementKey(key);
    if (parsed.file !== file || parsed.kind !== 'unit') { kept.push(key); continue; }
    if (removed.has(parsed.index)) { dropped.push(key); continue; }
    let before = 0;
    for (const r of removed) if (r < parsed.index) before++;
    if (before === 0) { kept.push(key); continue; }
    kept.push(narrationElementKey(file, parsed.index - before));
    renumbered++;
  }

  return { elements: [...new Set(kept)].sort(), dropped, renumbered };
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
   * True for the ONE class that has no element by design rather than by failure:
   * a footnote-marker block, whose text duplicates its parent's, so the text
   * aligner skips it outright to avoid double-counting. Its content is carried
   * by the paragraph it was lifted out of, and the markers themselves come out
   * of the narration copy at cut time (`stripFootnoteMarkerSups`) — so striking
   * one alone is a no-op that would be noise if it were reported as a failure.
   *
   * IMAGE blocks used to be in this class too, and that was the hole: they had
   * no element to be struck and no way to acquire one, so an image-only document
   * could never be removed from the narration copy. Since Aug 2026 image blocks
   * are matched to image ELEMENTS by document and ordinal (`alignImageBlocks`,
   * electron/epub-processor.ts), so an image is placeable; one the matcher
   * REFUSED to pair (the counts disagreed) arrives here with no element and
   * `unplaceable: false`, which is right — it is a deletion that reached
   * nothing, and the user has to be told.
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
 * ── What this is FOR, since Aug 2026 ────────────────────────────────────────
 *
 * It is the translator between a gesture and the record, and NOT the record's
 * author. It used to be both: the picker ran this over its whole view state on
 * every save and overwrote `narrationDeletions` with the answer. That made the
 * volatile thing the authority — the view resets on every document reload, and
 * a derivation over a freshly-reset view is a legitimate-looking record with
 * zero strikes in it. Measured on a real book: a document whose text aligns
 * perfectly ended with NO strikes for pages the user had deleted, and only 309
 * of 668 footnote elements survived to the export.
 *
 * So the record is the state now, and this runs TWICE PER GESTURE over the same
 * block layout — once before, once after — with the difference posted as
 * `narration:edit-deletions` (strike / unstrike). Taking the difference rather
 * than carrying a per-gesture element list is what makes overlapping gestures
 * come out right: an element two blocks name stays struck when only one of them
 * is restored, because it is still in the AFTER set.
 *
 * ── The escalation to the DOCUMENT ──────────────────────────────────────────
 *
 * A document EVERY strikeable block of which is struck comes out as the single
 * key `<zip entry>#doc` instead of its elements, one for one. The condition is
 * read off ALIGNED content only — a block carrying an element key is certain
 * evidence, and it is the only evidence there is — while the EFFECT reaches
 * further than the condition can see: `writeNarrationEpub` drops the whole
 * document, so the pictures the ordinal matcher REFUSED to identify die with it
 * without ever being named. That asymmetry is the point of the escalation, not
 * an accident of it: the user deletes the plate gallery's pages, its captions
 * all strike, the document escalates, and the six plates no ordinal could
 * settle go too.
 *
 * A document with NO strikeable blocks at all cannot escalate. Vacuous truth
 * would say "every one of its zero blocks is struck" about a document nobody
 * touched, and there would be no certain evidence anywhere that the user meant
 * it — so its deletions stay in the unstruck report, which is the honest answer.
 *
 * ── Reading order is a CONSTRAINT on the block list ─────────────────────────
 *
 * Attributing a block that carries NO element to a document (below, for the
 * report) is done from the aligned blocks either side of it, which is only
 * meaningful if the list is in the book's own reading order. It is: the list
 * comes from the analyzer's flow-order layout. Pages are sorted here anyway
 * because that half of the order can be checked; within a page the given order
 * is the layout's.
 */
export function deriveNarrationStrikes(
  blocks: readonly NarrationLaidOutBlock[],
  deletedBlockIds: ReadonlySet<string>,
  deletedPages: ReadonlySet<number>
): NarrationStrikes {
  const inReadingOrder = [...blocks].sort((a, b) => a.page - b.page);

  const fromBlocks = new Set<NarrationElementKey>();
  const fromPages = new Set<NarrationElementKey>();
  /** Deletions that reached nothing — before document coverage is considered. */
  const candidateUnstruck: Array<UnstruckDeletion & { at: number }> = [];
  const seenBlockIds = new Set<string>();
  const struckOnPage = new Map<number, number>();
  for (const page of deletedPages) struckOnPage.set(page, 0);

  /** Element-carrying blocks per document, and how many of them are struck. */
  const strikeableInDocument = new Map<string, number>();
  const struckInDocument = new Map<string, number>();
  /** The document of the nearest aligned block at or before each position. */
  const documentBefore: Array<string | null> = new Array(inReadingOrder.length).fill(null);
  const documentAfter: Array<string | null> = new Array(inReadingOrder.length).fill(null);

  {
    let running: string | null = null;
    for (let i = 0; i < inReadingOrder.length; i++) {
      documentBefore[i] = running;
      const element = inReadingOrder[i].element;
      if (element !== undefined) running = parseNarrationElementKey(element).file;
    }
    running = null;
    for (let i = inReadingOrder.length - 1; i >= 0; i--) {
      documentAfter[i] = running;
      const element = inReadingOrder[i].element;
      if (element !== undefined) running = parseNarrationElementKey(element).file;
    }
  }

  for (let i = 0; i < inReadingOrder.length; i++) {
    const block = inReadingOrder[i];
    seenBlockIds.add(block.id);
    const byBlock = deletedBlockIds.has(block.id);
    const byPage = deletedPages.has(block.page);

    if (block.element !== undefined) {
      const file = parseNarrationElementKey(block.element).file;
      strikeableInDocument.set(file, (strikeableInDocument.get(file) ?? 0) + 1);
      if (byBlock || byPage) struckInDocument.set(file, (struckInDocument.get(file) ?? 0) + 1);
    }

    if (!byBlock && !byPage) continue;

    if (block.element === undefined) {
      // Furniture has no element by construction — see `unplaceable`. Naming it
      // would be reporting the absence of something that was never there.
      if (block.unplaceable) continue;
      candidateUnstruck.push({
        blockId: block.id,
        page: block.page,
        via: byBlock ? 'block' : 'page',
        excerpt: block.excerpt,
        at: i,
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

  // ── Escalation ────────────────────────────────────────────────────────────
  const struckDocuments = new Set<string>();
  for (const [file, strikeable] of strikeableInDocument) {
    if (strikeable > 0 && struckInDocument.get(file) === strikeable) struckDocuments.add(file);
  }
  for (const file of struckDocuments) {
    const key = narrationDocumentKey(file);
    // The document key inherits the gesture that named the document: a block
    // strike if ANY of its elements was named individually, exactly as one
    // element struck both ways counts as a block strike.
    let namedByBlock = false;
    for (const set of [fromBlocks, fromPages]) {
      for (const element of [...set]) {
        if (parseNarrationElementKey(element).file !== file) continue;
        set.delete(element);
        if (set === fromBlocks) namedByBlock = true;
      }
    }
    (namedByBlock ? fromBlocks : fromPages).add(key);
  }

  // ── What a struck document COVERS ─────────────────────────────────────────
  //
  // A deletion that reached no element of its own is nevertheless carried out
  // when the document it is inside is struck whole, because the document goes
  // whole. The document of such a block is read from the aligned blocks either
  // side of it — the same window `alignImageBlocks` bounds a picture by — and
  // the block is covered only when BOTH ends name struck documents, so a block
  // that could be in a document nobody struck is still reported.
  //
  // Its page is credited too: a page holding nothing but covered blocks (the
  // plate gallery's middle pages hold no text at all) is a page whose content
  // is going, and reporting it as "nothing could be struck" would be false.
  const unstruck: UnstruckDeletion[] = [];
  for (const candidate of candidateUnstruck) {
    const before = documentBefore[candidate.at];
    const after = documentAfter[candidate.at];
    const covered = before !== null && after !== null
      && struckDocuments.has(before) && struckDocuments.has(after);
    if (covered) {
      if (deletedPages.has(candidate.page)) {
        struckOnPage.set(candidate.page, (struckOnPage.get(candidate.page) ?? 0) + 1);
      }
      continue;
    }
    unstruck.push({
      blockId: candidate.blockId,
      page: candidate.page,
      via: candidate.via,
      excerpt: candidate.excerpt,
    });
  }

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
      + `struck (page ${shown}${rest > 0 ? `, and ${rest} more` : ''}) — a blank page, or one whose `
      + 'only picture could not be matched to an image in the markup.'
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
 *
 * A `<zip entry>#doc` key fans out further still: every block of that document
 * is struck. That is the exact INVERSE of the escalation in
 * `deriveNarrationStrikes` — which emits the document key precisely when every
 * such block is struck — so a round trip through the record and back into the
 * view returns the same document key rather than fanning out into elements and
 * rewriting the record's shape on every reload.
 */
export function narrationDeletedBlockIds(
  blocks: readonly NarrationBlock[],
  elements: readonly NarrationElementKey[]
): string[] {
  const struck = new Set<NarrationElementKey>();
  const struckDocuments = new Set<string>();
  for (const key of elements) {
    const parsed = parseNarrationElementKey(key);
    if (parsed.kind === 'doc') struckDocuments.add(parsed.file);
    else struck.add(key);
  }
  return blocks
    .filter((b) => b.element !== undefined
      && (struck.has(b.element)
        || struckDocuments.has(parseNarrationElementKey(b.element).file)))
    .map((b) => b.id);
}

/**
 * Which PAGES of the laid-out book a recorded deletion set presents as deleted.
 *
 * PRESENTATION, derived, and never written back. The record says which ELEMENTS
 * are struck; "this page is deleted" is what the picker draws when there is
 * nothing left on the page that could be read aloud, which is exactly "every
 * strikeable block on it is struck".
 *
 * A page with NO strikeable blocks at all (a page of footnote markers, a blank,
 * a plate gallery's middle page holding only pictures no ordinal could settle)
 * is not deleted: vacuous truth would strike every empty page in the book the
 * moment anything else was. That holds inside a document struck WHOLE too —
 * such a page carries no block that names the document, so nothing here is
 * evidence about it, and the cut removes its content by removing the document
 * rather than by anything this projection says. And a page shown as deleted
 * must not ALSO have its blocks listed individually — the caller takes those
 * out — because restoring the page has to be one gesture that puts the whole
 * page back, not one that leaves several hundred block deletions the user never
 * made.
 */
export function narrationDeletedPages(
  blocks: readonly NarrationLaidOutBlock[],
  struckBlockIds: ReadonlySet<string>
): Set<number> {
  const strikeable = new Map<number, number>();
  const struckOn = new Map<number, number>();
  for (const b of blocks) {
    if (b.element === undefined) continue;
    strikeable.set(b.page, (strikeable.get(b.page) ?? 0) + 1);
    if (struckBlockIds.has(b.id)) struckOn.set(b.page, (struckOn.get(b.page) ?? 0) + 1);
  }
  const pages = new Set<number>();
  for (const [page, count] of strikeable) {
    if (count > 0 && struckOn.get(page) === count) pages.add(page);
  }
  return pages;
}

/**
 * One transactional edit of the record: what to add, what to take away.
 *
 * Both lists in one message because a gesture can do both at once — a page
 * toggle over a mixed selection deletes some pages and restores others — and
 * two messages would be two writes with a moment between them in which the
 * record described neither state.
 */
export interface NarrationDeletionEdit {
  strike: NarrationElementKey[];
  unstrike: NarrationElementKey[];
}

/**
 * The edit that takes `before` to `after` — the difference, both ways.
 *
 * The whole transactional model rests on this being a DIFFERENCE and not a
 * snapshot: `after` is never sent as the record. A window whose view is stale,
 * or empty because the document just reloaded, produces an empty difference and
 * therefore no write at all, which is the failure mode the old snapshot save
 * turned into silent data loss.
 */
export function narrationDeletionEdit(
  before: ReadonlySet<NarrationElementKey>,
  after: ReadonlySet<NarrationElementKey>
): NarrationDeletionEdit {
  const strike: NarrationElementKey[] = [];
  const unstrike: NarrationElementKey[] = [];
  for (const key of after) if (!before.has(key)) strike.push(key);
  for (const key of before) if (!after.has(key)) unstrike.push(key);
  return { strike: strike.sort(), unstrike: unstrike.sort() };
}

/** Every block that came off one source page — the "delete this page" selection. */
export function narrationBlocksOnSourcePage(
  blocks: readonly NarrationBlock[],
  sourcePage: number
): string[] {
  return blocks.filter((b) => b.sourcePage === sourcePage).map((b) => b.id);
}

/**
 * The narration copy's path, beside the book and named after the same thing the
 * book is named after.
 *
 * `<archive basename>.tts.epub`, derived from the book's OWN recorded path —
 * never re-derived from the title, because the name is settled once by
 * `manifest-service.exportEpubRelPath` and a second derivation here would be a
 * second naming rung (docs: "The export EPUB — the project's converted book").
 *
 * ── Why `.working` comes off ────────────────────────────────────────────────
 *
 * The book is `<archive basename>.working.epub` (Owen, 2026-08-08: the filename
 * is a sidecar declaration of which archive file it belongs to). Appending to
 * that verbatim would produce `X.working.tts.epub`, which declares that the
 * narration copy is a copy OF THE WORKING COPY. It is not — it is the third
 * member of one family, all three named after the archive file: the file you
 * handed us, the file you edit, the file narration reads. So the working marker
 * is dropped and the tts marker takes its place.
 *
 * A book that is not a working copy (there is one moment in a project's life
 * when that is true — a record written before the convention existed, on its way
 * through `migrateWorkingEpubNaming`) keeps its whole stem. That is not a
 * fallback: `.working` is a marker that is either present or absent, and absent
 * means there is nothing to take off.
 */
export function narrationEpubRelPath(bookRelPath: string): string {
  if (!bookRelPath.toLowerCase().endsWith('.epub')) {
    throw new Error(
      `The project's book is recorded as "${bookRelPath}", which is not an EPUB. The narration copy `
      + 'is cut from the book, so there is nothing to cut.'
    );
  }
  const withoutExt = bookRelPath.slice(0, -'.epub'.length);
  const stem = withoutExt.toLowerCase().endsWith('.working')
    ? withoutExt.slice(0, -'.working'.length)
    : withoutExt;
  return `${stem}.tts.epub`;
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
/**
 * A recorded deletion set, sorted into the two things it can name: whole
 * documents and individual elements.
 *
 * Split HERE rather than at each reader because the two are answered by
 * different authorities — a document key is checked against the book's spine
 * and an element key against the unit list — and a reader that let a `#doc` key
 * fall through to the element check would refuse it as a missing element, which
 * is a true refusal with a false reason.
 */
export function splitNarrationDeletions(
  deletions: readonly NarrationElementKey[]
): { documents: string[]; elements: NarrationElementKey[] } {
  const documents = new Set<string>();
  const elements: NarrationElementKey[] = [];
  for (const key of deletions) {
    const parsed = parseNarrationElementKey(key);
    if (parsed.kind === 'doc') documents.add(parsed.file);
    else elements.push(key);
  }
  return { documents: [...documents].sort(), elements };
}

export function planNarrationRemoval(
  units: readonly NarrationUnit[],
  deletions: readonly NarrationElementKey[]
): NarrationRemovalPlan {
  const documents = deletions.filter((key) => parseNarrationElementKey(key).kind === 'doc');
  if (documents.length > 0) {
    throw new Error(
      `${documents.length} of these keys name a whole document (the first is ${documents[0]}), and `
      + 'a document is not in the unit list — it is checked against the book\'s spine. Split the '
      + 'record with splitNarrationDeletions before planning the element removals.'
    );
  }
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

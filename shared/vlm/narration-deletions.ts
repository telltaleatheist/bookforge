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
 * It is stamped with the book's sha256 all the same, and every strike also
 * carries a FINGERPRINT of the text it struck. See below.
 *
 * ── Nothing but the user deletes the user's strikes ─────────────────────────
 *
 * Until 2026-08-10 the sha stamp was a guillotine: a book whose bytes had
 * changed VOIDED the whole record, and the reader that noticed deleted it and
 * said so. Owen killed it — "i dont think we need a guard so strict. or even a
 * guard at all" — after it threw away an evening of strikes because a
 * footnote-reference pass had rewritten the book, and it would have done the
 * same to a manifest and a book that Syncthing carried across two machines a
 * few seconds apart.
 *
 * The failure that guard existed to prevent is real and stays prevented: a
 * positional key whose element MOVED cuts the wrong paragraph out of the
 * audiobook, and nobody finds out until they hear it. What changed is where the
 * question is asked and what the answer is allowed to do.
 *
 *   - The question is asked AT USE — when the copy is cut, and when the picker
 *     paints the strikes — and it is asked PER STRIKE, not about the record as
 *     a whole. That is what `fingerprints` is for: each key remembers the
 *     opening of the text it struck, so a key can prove for itself that it
 *     still names what it named.
 *   - The answer may refuse, and may name what it refused, and may leave a
 *     strike unapplied. It may never delete one. The record is the user's
 *     work; only the user takes it back.
 *
 * The sha stamp survives as PROVENANCE and as a fast path: a record stamped
 * with the book in front of it was made against these very bytes, so every key
 * in it is certified without reading a word. A record stamped with anything
 * else is checked strike by strike, and the strikes made before fingerprints
 * existed are the one case that can only be warned about — an absent
 * fingerprint means "this was never fingerprinted", never "it matches".
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
import { bookDigestAlgorithmChange } from '../book-digest';

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
   * sha256 of the book EPUB these deletions were made against.
   *
   * PROVENANCE, and a fast path — no longer a guillotine. When it matches the
   * book on disk, every key in the record was minted against those exact bytes
   * and needs no further checking. When it does not, the record is still the
   * user's record; each strike is checked against its own fingerprint instead.
   */
  epubSha256: string;
  /** The struck elements, sorted, without duplicates. */
  elements: NarrationElementKey[];
  /** ISO timestamp of the last edit. */
  updatedAt: string;
  /**
   * Element key → the opening of the text that element said WHEN IT WAS STRUCK.
   *
   * ── Why the text and not a hash ─────────────────────────────────────────
   *
   * Because the whole value of the check is the sentence it lets us say. A hash
   * proves a mismatch and can describe nothing about it; 80 characters of the
   * paragraph lets the refusal read "you struck 'The first paragraph of the
   * book…' and that position now says 'A second paragraph on the following
   * page…'", which is the difference between a user who can act and a user who
   * is told a number. The cost is bounded and small — 80 bytes a strike, so a
   * book struck 700 times carries about 56 kB — and the manifest already holds
   * the keys themselves.
   *
   * ── What is in it, and what is deliberately not ─────────────────────────
   *
   * TEXT UNITS only. A `#img<N>` key names a picture, which has no text; a
   * `#doc` key names a zip entry, whose identity is certain and cannot shift.
   * Neither has anything to fingerprint, and inventing an empty string for them
   * would be a fingerprint that matches everything.
   *
   * OPTIONAL, and an absent key inside it is a real state: strikes recorded
   * before this field existed were never fingerprinted. They are reported as
   * UNVERIFIABLE when the book has moved under them — never quietly treated as
   * verified, and never dropped for it.
   */
  fingerprints?: Record<NarrationElementKey, string>;
}

/**
 * How much of an element's text a strike remembers.
 *
 * Long enough that two different paragraphs of a real book practically never
 * open the same way, short enough to print in a refusal and to carry a
 * thousand of.
 */
export const NARRATION_FINGERPRINT_CHARS = 80;

/**
 * The fingerprint of an element's text, or null when it has none to give.
 *
 * Whitespace-collapsed before it is cut, so re-serializing the book through a
 * DOM (which several passes and every chapter rename do) cannot change it, and
 * so the stored string is one printable line. Null — not `''` — for an element
 * with no text: an empty fingerprint would compare equal to every other empty
 * one, which is a match nobody proved.
 */
export function narrationFingerprint(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, NARRATION_FINGERPRINT_CHARS);
}

/**
 * The fingerprints of just these keys, for a record about to be written.
 *
 * An absent print is a real state and is NOT invented: an element with no text
 * has nothing to remember, a picture says nothing, and a key naming no element
 * has nothing to read. All three come out of the map entirely, which is how
 * "never fingerprinted" is spelled.
 */
export function narrationFingerprintsFor(
  book: Readonly<Record<NarrationElementKey, string>>,
  keys: readonly NarrationElementKey[],
): Record<NarrationElementKey, string> {
  const out: Record<NarrationElementKey, string> = {};
  for (const key of keys) {
    if (parseNarrationElementKey(key).kind !== 'unit') continue;
    const print = book[key];
    if (print !== undefined) out[key] = print;
  }
  return out;
}

/** A strike whose element does not say what the strike remembers striking. */
export interface NarrationStrikeMismatch {
  key: NarrationElementKey;
  /** The text this strike was made against, as far as it was remembered. */
  struck: string;
  /** What that position says in the book as it is now, cut the same way. */
  nowSays: string;
}

/** What checking a record's strikes against the book in front of it found. */
export interface NarrationStrikeVerification {
  /** Strikes whose element still says what it said. */
  verified: NarrationElementKey[];
  /** Strikes whose element says something else now. NOT applied by any caller. */
  mismatched: NarrationStrikeMismatch[];
  /**
   * Strikes that carry no fingerprint, on a book that cannot certify them by
   * sha. They are applied — they are the user's strikes and there is no
   * evidence against them — and said out loud, which is all the evidence there
   * is either way.
   */
  unverifiable: NarrationElementKey[];
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
   * Whether the cut was ASKED to take the footnote reference numbers out —
   * `stripSupMarkers`, the one thing about this file the strike record does not
   * describe.
   *
   * Recorded because the copy is re-cut in place when a deletion is made on it
   * (electron/narration-export.ts, `strikeInNarrationCopy`), and a re-cut that
   * guessed would silently flip a choice the user made in the export dialog. It
   * is a boolean rather than something inferred from `removedSupMarkers`,
   * because zero markers removed is what a book with no footnotes looks like
   * either way.
   *
   * OPTIONAL because records written before this field have no answer, and
   * inventing one would be exactly the guess it exists to prevent — the re-cut
   * refuses those BY NAME and asks for the copy to be generated again.
   */
  strippedSupMarkers?: boolean;
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

/** What carrying a strike record across a heading insert (or its undo) did to it. */
export interface NarrationDeletionsShiftMigration {
  /** The record's keys as they name the book AFTER the edit, sorted. */
  elements: NarrationElementKey[];
  /**
   * The fingerprints, re-keyed so each still travels with its strike. Absent
   * exactly when the record carried none — a record from before fingerprints
   * existed stays that way, because inventing prints for it would claim
   * evidence nobody took (see `NarrationDeletions.fingerprints`).
   */
  fingerprints?: Record<NarrationElementKey, string>;
  /** How many keys named the same element under a NEW index. */
  renumbered: number;
}

/**
 * Re-key one record's strikes and fingerprints through one index mapping.
 *
 * The shared arithmetic of the two heading migrations below. `mapIndex` may
 * THROW, and that throw is the whole refusal contract: a key the mapping cannot
 * carry stops the caller before any byte of the book is written — never a
 * dropped strike, which is the difference from the fold's migration above.
 *
 * The three namespaces are the three separate things they are, exactly as in
 * `migrateNarrationDeletionsForFold`: only TEXT units of the edited file move
 * (a heading holds no `<img>`, so no picture ordinal shifts), `#img<N>` and
 * `#doc` keys mean the same thing after, and every other file is untouched.
 */
function shiftNarrationDeletionKeys(
  record: Pick<NarrationDeletions, 'elements' | 'fingerprints'>,
  file: string,
  mapIndex: (index: number, key: NarrationElementKey) => number,
): NarrationDeletionsShiftMigration {
  const carryKey = (key: NarrationElementKey): NarrationElementKey => {
    const parsed = parseNarrationElementKey(key);
    if (parsed.file !== file || parsed.kind !== 'unit') return key;
    const index = mapIndex(parsed.index, key);
    return index === parsed.index ? key : narrationElementKey(file, index);
  };

  // Counted over the STRIKES alone: a strike's fingerprint moving with it is
  // the same renumbering, not a second one.
  let renumbered = 0;
  const elements = [...new Set(record.elements.map((key) => {
    const carried = carryKey(key);
    if (carried !== key) renumbered++;
    return carried;
  }))].sort();
  let fingerprints: Record<NarrationElementKey, string> | undefined;
  if (record.fingerprints !== undefined) {
    fingerprints = {};
    for (const [key, print] of Object.entries(record.fingerprints)) {
      fingerprints[carryKey(key)] = print;
    }
  }
  return { elements, ...(fingerprints !== undefined ? { fingerprints } : {}), renumbered };
}

/**
 * Carry a strike record across a chapter-heading INSERT: one new text unit,
 * put into `file` immediately before the unit at `insertIndex`.
 *
 * The insert ADDS an element where the fold removes them, so every unit key in
 * that file at `insertIndex` or beyond names the element one further on and is
 * carried `+1`; nothing is ever dropped, because no struck element left the
 * book. The fingerprints travel with their keys — each one still describes the
 * words of the element its strike named, which is what lets the carried record
 * verify against the inserted book strike for strike.
 *
 * A key that CANNOT be carried refuses the whole insert instead: a unit key at
 * or past `unitsInFile` named nothing even in the book before the edit — a
 * record already damaged — and carrying it forward would re-stamp a record
 * about a book it never described (`narrationCarryRefusal` catches the same
 * thing for passes, and for the same reason).
 */
export function migrateNarrationDeletionsForHeadingInsert(
  record: Pick<NarrationDeletions, 'elements' | 'fingerprints'>,
  file: string,
  insertIndex: number,
  unitsInFile: number,
): NarrationDeletionsShiftMigration {
  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex >= unitsInFile) {
    throw new Error(
      `A chapter heading cannot be inserted before element ${insertIndex} of ${file}, which holds `
      + `${unitsInFile} text element(s). Nothing was written.`
    );
  }
  return shiftNarrationDeletionKeys(record, file, (index, key) => {
    if (index >= unitsInFile) {
      throw new Error(
        `${key} is struck for narration but ${file} holds only ${unitsInFile} text element(s), so `
        + 'that strike names nothing in this book and cannot be carried across the insert. The '
        + 'record does not describe this book; re-open it and strike again. Nothing was written.'
      );
    }
    return index >= insertIndex ? index + 1 : index;
  });
}

/**
 * Carry a strike record across the REMOVAL of an inserted heading — the
 * insert's exact inverse: every unit key in `file` past `removedIndex` is
 * carried `-1`, fingerprints travelling with their keys.
 *
 * A strike ON the heading itself REFUSES rather than being dropped. The fold
 * drops keys whose elements it removed because a person asked for that one
 * merge with the page in front of them; this is an UNDO, and an undo that
 * quietly ate a strike would trade one user decision for another. The refusal
 * says the way out by name: unstrike the heading, then remove it.
 */
export function migrateNarrationDeletionsForHeadingRemoval(
  record: Pick<NarrationDeletions, 'elements' | 'fingerprints'>,
  file: string,
  removedIndex: number,
  unitsInFile: number,
): NarrationDeletionsShiftMigration {
  if (!Number.isInteger(removedIndex) || removedIndex < 0 || removedIndex >= unitsInFile) {
    throw new Error(
      `${file} holds ${unitsInFile} text element(s), so there is no element ${removedIndex} to `
      + 'remove. Nothing was written.'
    );
  }
  return shiftNarrationDeletionKeys(record, file, (index, key) => {
    if (index === removedIndex) {
      throw new Error(
        `${key} is struck for narration, and removing it would silently drop that strike. `
        + 'Unstrike the heading first, then remove it. Nothing was written.'
      );
    }
    if (index >= unitsInFile) {
      throw new Error(
        `${key} is struck for narration but ${file} holds only ${unitsInFile} text element(s), so `
        + 'that strike names nothing in this book and cannot be carried across the removal. The '
        + 'record does not describe this book; re-open it and strike again. Nothing was written.'
      );
    }
    return index > removedIndex ? index - 1 : index;
  });
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
 *
 * ── TWO shapes the book is recorded in, and neither is a guess ───────────────
 *
 * The working copy is an exploded DIRECTORY — `source/<stem>.working`, no
 * extension, because a directory wearing `.epub` is a masquerade. It is still
 * an EPUB; it is just not an archive. So there are exactly two forms this
 * accepts, both named:
 *
 *   `source/X.working`       the exploded working copy      → `source/X.tts.epub`
 *   `source/X.working.epub`  a book still stored as a ZIP   → `source/X.tts.epub`
 *
 * and both give the same answer, because the narration copy is named after the
 * ARCHIVE FILE and not after whichever container the book it was cut from
 * happens to be in. Anything else is refused by name rather than turned into a
 * `.tts.epub` beside a book nobody can find.
 */
export function narrationEpubRelPath(bookRelPath: string): string {
  const lower = bookRelPath.toLowerCase();
  if (lower.endsWith('.working')) {
    return `${bookRelPath.slice(0, -'.working'.length)}.tts.epub`;
  }
  if (!lower.endsWith('.epub')) {
    throw new Error(
      `The project's book is recorded as "${bookRelPath}", which is neither an EPUB archive `
      + '(".epub") nor an exploded working copy (".working"). The narration copy is cut from the '
      + 'book, so there is nothing to cut.'
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
  /**
   * What the element says, verbatim, before any normalization but the walk's
   * own (`getUnitTextContent` skips what a reader does not see).
   *
   * Carried on the unit rather than looked up later because the ONE traversal
   * that mints the keys is the only place the element and its key are both in
   * hand, and a fingerprint checked against text read by a second walk would be
   * checking two descriptions of the book against each other.
   *
   * `''` for a picture — a picture says nothing — which is exactly why image
   * keys are not fingerprinted.
   */
  text: string;
}

export interface NarrationRemovalPlan {
  /** The keys to remove, in the book's own order. */
  remove: NarrationElementKey[];
  /** How many elements the book has. */
  total: number;
  /**
   * Strikes applied on their own authority because nothing could check them:
   * recorded before fingerprints existed, on a book the sha cannot certify.
   */
  unverifiable: NarrationElementKey[];
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

/**
 * Check each strike against the text it remembers striking.
 *
 * PURE and NON-THROWING, because two callers need the same answer for opposite
 * purposes: the cut refuses on a mismatch, and the picker reports one so the
 * user can look at it. A single function that threw would force the reporting
 * caller to catch its own diagnosis.
 *
 * Keys that name no element of `units` are not this function's business —
 * `planNarrationRemoval` refuses those by name, and a key that resolves to
 * nothing has no text to compare. Image and document keys are skipped for the
 * reason `fingerprints` explains: they have nothing to fingerprint, so they are
 * neither verified nor reported as unverifiable.
 */
export function verifyNarrationStrikes(
  units: readonly NarrationUnit[],
  deletions: readonly NarrationElementKey[],
  fingerprints: Readonly<Record<NarrationElementKey, string>> | undefined,
): NarrationStrikeVerification {
  const textByKey = new Map(units.map((u) => [u.key, u.text]));
  const verified: NarrationElementKey[] = [];
  const mismatched: NarrationStrikeMismatch[] = [];
  const unverifiable: NarrationElementKey[] = [];

  for (const key of deletions) {
    if (parseNarrationElementKey(key).kind !== 'unit') continue;
    const text = textByKey.get(key);
    if (text === undefined) continue;
    const struck = fingerprints?.[key];
    if (struck === undefined) { unverifiable.push(key); continue; }
    const now = narrationFingerprint(text);
    if (now === struck) { verified.push(key); continue; }
    mismatched.push({ key, struck, nowSays: now ?? '' });
  }

  return { verified, mismatched, unverifiable };
}

/**
 * What the mismatches come to, in one sentence — or null when there are none.
 *
 * The same shape as `describeUnstruckDeletions`: a few named in full, the rest
 * counted, because past a handful the list is the noise.
 */
export function describeNarrationStrikeMismatches(
  mismatched: readonly NarrationStrikeMismatch[]
): string | null {
  if (mismatched.length === 0) return null;
  const SHOWN = 3;
  const listed = mismatched
    .slice(0, SHOWN)
    .map((m) => `${m.key} was struck on "${m.struck}" and now says `
      + `${m.nowSays.length === 0 ? '(nothing)' : `"${m.nowSays}"`}`)
    .join('; ');
  const rest = mismatched.length - SHOWN;
  return `${mismatched.length} strike(s) name an element that no longer says what it said when it `
    + `was struck: ${listed}${rest > 0 ? `; and ${rest} more` : ''}.`;
}

/**
 * @param fingerprints  What each strike remembers striking, or `undefined` to
 *   say the strikes need no checking — which is true of exactly one situation:
 *   the record is stamped with the sha of the book being cut, so every key in
 *   it was minted against these bytes. Passing the map when the shas AGREE
 *   would be harmless but wasteful; passing `undefined` when they do not would
 *   be the old guillotine's blindness with none of its bite.
 */
export function planNarrationRemoval(
  units: readonly NarrationUnit[],
  deletions: readonly NarrationElementKey[],
  fingerprints?: Readonly<Record<NarrationElementKey, string>>
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
      + 'so an element that is gone leaves its strike naming nothing. Your strikes are still on '
      + 'record and nothing has been cleared: open the book in the editor, take back the strikes '
      + 'that no longer name anything, and export again.'
    );
  }

  // ── The per-strike check, and why a mismatch STOPS the cut ────────────────
  //
  // A key whose element moved names a DIFFERENT paragraph, and applying it
  // would take that paragraph out of the audiobook — silently, in a file the
  // user only hears weeks later. That is the failure this whole record was
  // designed around, so it is refused, and the refusal names the strikes and
  // prints both texts. Cutting "only the verified ones" was the alternative and
  // it is worse: it leaves the paragraphs the user DID strike in the narration,
  // which is the same silent wrong answer from the other side.
  const verification = fingerprints === undefined
    ? { verified: [], mismatched: [], unverifiable: [] } as NarrationStrikeVerification
    : verifyNarrationStrikes(units, deletions, fingerprints);
  if (verification.mismatched.length > 0) {
    throw new Error(
      `${describeNarrationStrikeMismatches(verification.mismatched)} The book has been rewritten `
      + 'since those strikes were made, so cutting on them would remove paragraphs you never '
      + 'struck. Nothing was written and nothing was cleared — open the book in the editor, where '
      + 'these strikes are shown, and put them where you want them.'
    );
  }

  const struck = new Set(deletions);
  return {
    remove: units.filter((u) => struck.has(u.key)).map((u) => u.key),
    total: units.length,
    unverifiable: verification.unverifiable,
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
  /**
   * The strikes, verbatim, or null when there are none.
   *
   * NEVER null because the record went stale. Nothing on this path clears a
   * strike record any more — see this file's header — so what the user struck
   * is what comes back, and what could not be verified travels beside it.
   */
  deletions: NarrationDeletions | null;
  /**
   * Why the record's stamp does not name this book, or null when it does.
   *
   * A WARNING, not an obituary. It says the positions may have moved and that
   * each strike is checked on its own before it is applied; it never says
   * anything was cleared, because nothing was.
   */
  staleReason: string | null;
  /**
   * Strikes whose element no longer says what it said when it was struck.
   *
   * Empty on the fast path (the stamp names this book), and empty on a book
   * whose strikes all still check out. A window shows these BY NAME and must
   * not paint them as struck: the position names a paragraph the user never
   * chose, and painting it would invite them to confirm a strike they did not
   * make.
   */
  mismatched: NarrationStrikeMismatch[];
  /**
   * Strikes recorded before fingerprints existed, on a book the stamp cannot
   * certify. They are shown and applied as the user's strikes; there is simply
   * no evidence about them either way, and saying so is the whole answer.
   */
  unverifiable: NarrationElementKey[];
  /** Where the narration copy is, when one has been exported. */
  narrationPath: string | null;
  narrationRelPath: string | null;
  /**
   * The sha256 of the book the narration copy was CUT FROM, or null when there
   * is no copy (or a record too old to say — `fromEpubSha256` predates nothing,
   * but a null here must never be read as "fresh").
   */
  narrationCutFromSha256: string | null;
  /**
   * True when the project HAS a narration copy and it was provably cut from a
   * book other than the one on disk — the file an audiobook would be built
   * from no longer says what the book says. This is the durable form of the
   * `already-stale` answer each write reports at write time: the picker's
   * badge reads it on open, so the fact survives a window restart instead of
   * living only in the session that happened to make the edit.
   *
   * False when there is no copy, when the copy matches, and when the two
   * digests were measured under DIFFERENT algorithms (the zip → exploded
   * migration): incomparable is not evidence of an edit, and the sentence "your
   * copy is stale, export again" must not be raised by a migration that
   * changed no words. `narrationCutFromSha256` still travels for any caller
   * that wants to show "cannot verify".
   */
  narrationCopyStale: boolean;
}

/**
 * Why the record's stamp does not name this book, or null when it does.
 *
 * ── One neutral sentence, and why it says nothing about consequences ────────
 *
 * Five callers ask this and they do five different things about it: the picker
 * warns, the cut checks strike by strike, the fold and the opening-naming pass
 * refuse to edit a book they cannot carry the record across. The sentence they
 * share is therefore the FACT — the record was made against other bytes, and
 * the positions in it may have moved — and each caller adds what it is about to
 * do. The old wording did the opposite: it announced "they have been cleared"
 * on behalf of one caller, so every other caller said it too, and the one that
 * meant it deleted an evening's work (Owen, 2026-08-10).
 *
 * It is deliberately NOT a verdict on any individual strike. That question is
 * answered per key, against the fingerprints, by `verifyNarrationStrikes` —
 * against the book, not against a hash of it.
 *
 * ── The stamp can also disagree WITHOUT the book having changed ─────────────
 *
 * A working copy that was a single archived file and is now a folder of its
 * parts has its identity measured a different way (shared/book-digest.ts), so
 * every record stamped before the unpacking stops matching at once — while the
 * book, which was verified part for part during the unpacking, is character for
 * character the one those strikes were made on. "This book has changed" would
 * be a false sentence about work the user did, and it is the sentence five
 * callers put in front of them. So a stamp that PROVABLY came from the other
 * algorithm gets the true reason instead. It is still a stale reason — the two
 * values genuinely cannot be compared, and every caller's caution still applies
 * — it just stops claiming an edit that never happened.
 */
export function narrationDeletionsStaleReason(
  deletions: NarrationDeletions | null | undefined,
  bookSha256: string
): string | null {
  if (!deletions) return null;
  if (deletions.epubSha256 === bookSha256) return null;
  const withoutFingerprints = deletions.elements.filter(
    (key) => parseNarrationElementKey(key).kind === 'unit'
      && deletions.fingerprints?.[key] === undefined).length;
  // Null unless it can PROVE the two were computed differently — an unclassifiable
  // stamp leaves the sentence below exactly as it has always been.
  const measured = bookDigestAlgorithmChange(deletions.epubSha256, bookSha256);
  return (
    (measured ?? 'This book has changed since these deletions were made, so the positions they name '
      + 'may have moved.')
    + (withoutFingerprints > 0
      ? ` ${withoutFingerprints} of them were recorded before BookForge remembered what each strike `
        + 'struck, so there is nothing to check them against — they are applied as you made them.'
      : '')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Carrying a record across a PASS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One spine document, reduced to the only thing a strike key depends on: which
 * keys its walk mints, and what each of them was minted from.
 *
 * The walk is `enumerateNarrationElements` (electron/quire-stamp.ts) — the same
 * one that mints the keys in the first place — so this is a projection of the
 * book's own enumeration and never a second description of it.
 */
export interface NarrationDocumentShape {
  file: string;
  /** Every key this document mints, in walk order: text units, then pictures. */
  keys: NarrationElementKey[];
  /** The tag each of those keys was minted from, lower-case, same order. */
  tags: string[];
}

/**
 * What a pass concluded about the strike record it found, handed to the one
 * transaction that records the pass.
 *
 * A DISCRIMINATED UNION with no default, because "the pass forgot to say" and
 * "the pass proved the record still holds" must not be the same value. Every
 * caller of `appendAppliedPass` states one of the three out loud.
 */
export type NarrationDeletionsCarry =
  /** This book has no strike record. There was nothing to carry. */
  | { outcome: 'none' }
  /**
   * PROVEN: the book the pass wrote enumerates exactly what the book it read
   * did, so every key still names the element it named. `fromSha256` is the
   * book the proof was made against — checked again inside the transaction, so
   * a record edited while the pass ran cannot be re-stamped on the strength of
   * a proof about a different record.
   */
  | {
    outcome: 'carried';
    fromSha256: string;
    toSha256: string;
    /** The AFTER book's fingerprints, so the carried strikes describe it. */
    fingerprints: Readonly<Record<NarrationElementKey, string>>;
  }
  /** The proof failed. The record is LEFT ALONE, and this says what was found. */
  | { outcome: 'refused'; reason: string };

/**
 * Why the strikes recorded against `before` cannot be said to describe `after`,
 * or null when they can.
 *
 * ── What is compared, and why it is the whole BEFORE book ───────────────────
 *
 * Every document the book had must still be there, minting the same keys from
 * the same tags. Not "the documents the record happens to name": the record can
 * grow while the pass runs — a second picker window is one gesture away — and a
 * proof scoped to the keys we read would be a proof about a record that no
 * longer exists. Documents the pass ADDED are not compared, because no key
 * minted against the old book can name one.
 *
 * Tags are compared as well as keys because a key is a POSITION and a position
 * whose element changed shape is a position that may not be the same element.
 * The walk already carries the tag, so it costs nothing to be exact.
 *
 * Then the record's own keys are resolved against the new book. Under the
 * comparison above that can only fail for a key that named nothing to begin
 * with — a record already damaged — which is a thing worth catching rather than
 * carrying forward.
 */
export function narrationCarryRefusal(
  deletions: readonly NarrationElementKey[],
  before: readonly NarrationDocumentShape[],
  after: readonly NarrationDocumentShape[],
): string | null {
  const afterByFile = new Map(after.map((doc) => [doc.file, doc]));

  for (const doc of before) {
    const now = afterByFile.get(doc.file);
    if (now === undefined) {
      return `${doc.file} is not a document of the book any more, so every strike inside it names `
        + 'nothing.';
    }
    if (now.keys.length !== doc.keys.length) {
      return `${doc.file} held ${doc.keys.length} element(s) before the pass and holds `
        + `${now.keys.length} after it, so the strikes after the change name different elements.`;
    }
    for (let i = 0; i < doc.keys.length; i++) {
      if (now.keys[i] !== doc.keys[i]) {
        return `${doc.file}'s element at position ${i} was ${doc.keys[i]} before the pass and is `
          + `${now.keys[i]} after it.`;
      }
      if (now.tags[i] !== doc.tags[i]) {
        return `${doc.keys[i]} was a <${doc.tags[i]}> before the pass and is a <${now.tags[i]}> `
          + 'after it, so that position no longer names the same element.';
      }
    }
  }

  const { documents, elements } = splitNarrationDeletions(deletions);
  for (const file of documents) {
    if (!afterByFile.has(file)) {
      return `${narrationDocumentKey(file)} strikes a whole document, and the book the pass wrote `
        + 'does not have it.';
    }
  }
  const present = new Set<NarrationElementKey>();
  for (const doc of after) for (const key of doc.keys) present.add(key);
  const missing = elements.filter((key) => !present.has(key));
  if (missing.length > 0) {
    return `${missing.length} of the ${deletions.length} strike(s) name no element of the book the `
      + `pass wrote — the first is ${missing[0]}.`;
  }
  return null;
}

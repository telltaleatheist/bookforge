/**
 * shared/book — the BOOK FILE, read back into the shapes the app draws.
 *
 * ── This is a MIRROR of src/vlm/book-file.ts, and the two must grow together ──
 *
 * The engine owns the format. `vlm-book` reflows a readings bank into one row
 * per block — hyphens fused, page turns joined, ids minted, notes cut apart —
 * and writes `readings/<key>.book.jsonl`; `src/vlm/book-file.ts` is where that
 * grammar is decided and `docs/BOOK-FILE.md` is the contract both files answer
 * to. This file states the same grammar a second time, in the app, and nothing
 * here is allowed to be an opinion about it.
 *
 * IT IS RESTATED BECAUSE THE APP NEVER IMPORTS A LINE OF THE ENGINE — it
 * spawns it (electron/engine.ts) — and spawning a process to parse a file this
 * process is already holding open would be absurd. So the table is written twice
 * with the engine's file named as the contract, and the refusals below are what
 * make forgetting the second copy LOUD rather than silent: a row missing a field
 * takes the whole file down by name, and a header declaring a version this
 * program does not write is refused before a single row is read.
 *
 * If the engine's format grows a field, BOTH files grow. The version number is
 * the thing that makes that non-optional: a v4 book meets a sentence here rather
 * than a renderer quietly drawing a book with its new half missing.
 *
 * ── WHY A BAD ROW TAKES THE FILE DOWN ───────────────────────────────────────
 *
 * The engine's parser says it and it is worth saying again on this side, because
 * this side is the one with a person looking at it: this document is what every
 * op in the project is keyed to. A book assembled out of the rows that happened
 * to parse is a book with paragraphs silently missing — and the person editing it
 * would be striking, splitting and re-ordering blocks in a document that is not
 * the one on disk. A sentence naming the block that is wrong costs a reload; a
 * lenient parse costs somebody's afternoon and says nothing at all.
 *
 * ── What v3 added over v2, in one paragraph ─────────────────────────────────
 *
 * PROVENANCE, PARTS, SEAMS, THE SHELF AND THE FIGURES. The header now says what
 * the book is made of — the engine that wrote it, the read's declared language,
 * and `source.bankSha`, the identity of the receipt underneath, which is what
 * lets a loader refuse a book whose bank has moved from under its ids. Every row
 * carries `parts` in place of v2's bare `src` list: which banked answer
 * contributed which characters of its finished text, char-exact, so the page
 * inside a joined paragraph is a fact and not arithmetic. The page turns the
 * reflow declined are pairs of BLOCK IDS (`seams`), because a person joining one
 * is joining two paragraphs and "p13" names neither. The page furniture and the
 * suppressed running heads are ROWS now, at their reading-order positions,
 * wearing `shelf` and a sentence of `why` — nothing the model answered is
 * silently gone. And a Picture row can carry `image`: the name of its crop in
 * `readings/<key>.images/`, cut once when the book was made.
 */

import type { BookOp } from './ops';
import type { RewriteMode } from './types';

/** The format this program reads. A file declaring anything else is refused. */
export const BOOK_FILE_VERSION = 3;

/** Refusals from this module, named so a caller can tell them from anything else. */
export class BookFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookFileError';
  }
}

/**
 * Where a block sat on its page, in the render frame of `page`.
 *
 * A merged block's box is composed rather than dropped — origin from the first
 * part, height summed, width the union — and src/vlm/book-file.ts's header
 * explains at length what survives that addition and why it is worth keeping.
 */
export interface BookBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Where a note's number was printed in the body: a block, and a character range
 * inside its text.
 *
 * AN OFFSET AND A LENGTH, NOT A STRING TO SEARCH FOR. The same digits appear
 * five times on a page of a book with fifty notes on it, so a marker found by
 * matching text is a marker that lands on whichever occurrence came first. The
 * engine resolved it once, at reflow, with the page in front of it; this side
 * draws exactly where it was told.
 */
export interface BookRef {
  /** The body block the number was printed in. */
  block: string;
  /** Where in that block's text the marker starts, in characters. */
  at: number;
  /** How many characters of it the marker is. */
  len: number;
}

/**
 * One banked answer's contribution to a row's text.
 *
 * `chars` is a half-open `[start, end)` into the ROW's final text, and the
 * parts of a row TILE it — no gap, no overlap, first one at 0 — which the
 * parser proves rather than assumes, because an offset into somebody's text is
 * either verified where the file is read or it is a rumour every later reader
 * acts on. `fused` is the word a column broke that the reflow made whole; the
 * engine records it on the part that BEGINS with it, never the first.
 */
export interface BookPart {
  /** `page:order`, or `page:order:part` for a piece of one banked answer. */
  src: string;
  /** The page THIS part was printed on, which a joined row's `page` is not. */
  page: number;
  /** Half-open `[start, end)` into the row's final text. */
  chars: [number, number];
  /** The word the column broke, made whole. Never on the first part. */
  fused?: string;
}

/** The two ways a block can be out of the flow and still be in the book. */
export type BookShelf = 'furniture' | 'suppressed-head';

/**
 * A page turn the reflow declined to join, as the two blocks it falls between.
 *
 * Both ids name FLOWING rows and they are adjacent among the flowing prose —
 * the notes at the foot of the earlier page sit between them in the file, and
 * the engine's `bookSeams` owns the argument for why they are skipped. This is
 * the "4 page turns left as two paragraphs" report turned into something a
 * renderer can draw a control between.
 */
export interface BookSeam {
  /** The row the paragraph before the turn ends at. */
  after: string;
  /** The row the page after the turn opens with. */
  before: string;
}

/** A page whose banked answer would not parse, named and skipped. */
export interface BookUnreadable {
  page: number;
  reason: string;
}

/**
 * What this book was made out of — the bank, identified.
 *
 * `bankSha` IS THE LOAD-BEARING ONE: the first sixteen hex of a sha-256 over
 * the receipt's bytes. The book file is a pure function of the bank, so the
 * bank's identity is the book's warrant — a loader that finds a different bank
 * under the same name is holding ids that may name nothing, and the only safe
 * thing it can do is refuse by name (docs/BOOK-FILE.md §2).
 */
export interface BookSource {
  /** Page answers in the bank, whether or not they parsed. */
  pages: number;
  unreadable: BookUnreadable[];
  /** The app's binding of reading to step, carried and never interpreted. */
  generation?: string;
  /** sha-256 of the receipt's bytes, first 16 hex. */
  bankSha: string;
}

/**
 * One block of the finished book — one row of the file.
 *
 * A PARAGRAPH, A HEADING, A NOTE OR A FIGURE, whole. Never half of one, never
 * two of them, and never a page.
 */
export interface BookRow {
  /**
   * The block's name, minted once and never reused — `b<page>-<order>` of its
   * first banked answer, `-<part>` where the markdown pass cut one answer into
   * several, `#<ordinal>` for a note cut out of a footnote block, `/<n>` for a
   * half of a user split.
   *
   * OR `e-<n>`, WHEN THE BOOK WAS EXPLODED OUT OF AN IMPORTED EPUB. There is no
   * bank under one and never will be (docs/RENDERER.md §6, the refinement: a bank
   * models pages and an EPUB has none), so there is no `b<page>-<order>` to mint —
   * what an EPUB has instead is the publisher's own order, the spine and then
   * document order inside it, and `n` is that ordinal counted from 1 across the
   * whole book. `#` and `/` ride on it exactly as they ride on a banked name, so
   * every op, every chapter marker and every records entry works on one without
   * knowing which kind of book it is holding (docs/BOOK-FILE.md §4).
   *
   * IDENTITY IS THIS AND ONLY THIS. `page` below is an estimate and addresses
   * nothing; see the engine's own header for the whole of that argument. On an
   * EPUB-sourced row it is not even an estimate — it is 0, the no-page frame,
   * because nothing page-shaped exists to estimate.
   */
  id: string;
  /**
   * The dots category, in the ENGINE's spelling — `Text`, `Section-header`,
   * `Footnote`. Typed as a string rather than as a union because the union lives
   * in the engine (`DotsCategory`, src/vlm/dots.ts) and the app never imports the
   * engine; a category this build has no colour for is drawn in the fallback grey
   * and named as unknown, which is `shared/categories.ts`'s standing rule.
   */
  category: string;
  /** Dehyphenated, reflowed, page turns resolved. The text, once and finished. */
  text: string;
  /** The page this block STARTED on — a rough estimate, and never an address. */
  page: number;
  /** Every page it touches, in order. One entry for a block that stayed put. */
  pages: number[];
  box: BookBox;
  /** The page's render size, so a width can be read as a fraction of a column. */
  pageWidth: number;
  pageHeight: number;
  /** How the text was assembled, char-exact — one entry per banked answer, in order. */
  parts: BookPart[];
  /** Which note of its banked block this is, from 0. Set on a Footnote row only. */
  note?: number;
  /**
   * Where this note's number was printed. Set on EVERY Footnote row, including
   * the ones nothing points at, where it is `[]` — one spelling of "unpointed",
   * not two. Absent on every other kind.
   */
  refs?: BookRef[];
  /**
   * The figure cut for this row, by NAME inside `readings/<key>.images/` — set
   * on a Picture row of a run that was given a PDF to cut from, and absent
   * everywhere else. A name and not a path: the file is a portable document
   * about a book, and the app composes the directory itself (`imagesDirFor`,
   * electron/projects.ts).
   */
  image?: string;
  /**
   * Why this row is NOT in the flow — absent, always, on a row that is.
   * Renderers draw the flow and leave the shelf where it is; restoring a
   * shelved row is an ordinary op against its id (docs/BOOK-FILE.md §5).
   */
  shelf?: BookShelf;
  /** One sentence of evidence — set on a shelved row and on no other kind. */
  why?: string;
}

/**
 * A place the book divides, as the engine detected it.
 *
 * A SEED AND NOT A DECISION. Ownership passes to the ops the first time somebody
 * moves, renames or removes one (docs/RENDERER.md §2); until then this is what
 * the rules on the sheet are drawn from.
 */
export interface BookChapter {
  /** The block the rule sits above. */
  id: string;
  title: string;
  /** How the engine decided it, where it said. Nothing is keyed to this. */
  kind?: string;
}

/** One category's measured size, as a fact and as a ratio of the body's. */
export interface BookTypographyCategory {
  /** The median line height of this category's blocks, in render pixels. */
  medianPx: number;
  /** `medianPx` over the body's, clamped — what a stylesheet writes as `em`. */
  ratio: number;
  /** How many blocks it was taken from. */
  samples: number;
}

/**
 * What this book's type says about itself, measured off the boxes.
 *
 * NULL IS AN ORDINARY ANSWER AND IS NOT A HOLE. A book whose boxes gave fewer
 * than four samples of a category has nothing measured to say about it, and the
 * engine writes nothing rather than a number derived from one rectangle. What
 * stands in its place is the base sheet's own ratio, which is a documented rule
 * and not a fallback: see `src/vlm/dots-book.ts`'s STYLESHEET_BASE.
 */
export interface BookTypography {
  /** The median line height of the book's body column, in render pixels. */
  bodyPx: number;
  /** Keyed by dots category, and only the ones with enough blocks to calibrate. */
  categories: Record<string, BookTypographyCategory>;
}

/**
 * A printed reference number with no note under it.
 *
 * The other half of `loose` from the notes below, and the one that carries what
 * the page actually printed — because the number is all that is left of it. A
 * marker with no note is one of the two LINKING flags this app still keeps
 * (docs/RENDERER.md §0, ruling 7): it is structural, not an OCR suspicion, and it
 * is a thing a person fixes by hand with the `link` op.
 */
export interface BookLooseMarker {
  block: string;
  at: number;
  len: number;
  /** The number the page printed — the superscript run's value, as the engine read it. */
  printed: number;
}

/** The apparatus that did not join up, both directions. */
export interface BookLoose {
  /** Numbers in the body with no note carrying them. */
  markers: BookLooseMarker[];
  /** Note rows nothing in the body points at, by id. */
  notes: string[];
}

/** The file's first line — everything about the book that is not a block. */
export interface BookHeader {
  /** The foundry that wrote it. Provenance, and the only field a release moves. */
  engine: string;
  /** The read's declared language. Declared, never detected. */
  language: string;
  source: BookSource;
  chapters: BookChapter[];
  typography: BookTypography | null;
  seams: BookSeam[];
  loose: BookLoose;
}

/** A book file, parsed. */
export interface BookFile {
  header: BookHeader;
  rows: BookRow[];
}

/**
 * THE POSITION IS UNDER A TRANSLATION, AND HERE IS WHAT IT WAS MADE FROM.
 *
 * ── Why this is one fact and not three ──────────────────────────────────────
 *
 * *"Two scroll-locked columns over two book files with the same ids."*
 * (docs/RENDERER.md §5.) The pane cannot draw that pair by asking three
 * questions — is this translated, what language, and what did it say before —
 * because the three answers are composed from ONE walk of the ledger
 * (`translationInEffect`, then the step's parent, then that position's book) and
 * three round trips would be three chances for them to disagree about which
 * translation the pane is standing under. Null is the ordinary book in its own
 * language, and it is what makes the aligned view UNAVAILABLE rather than empty.
 *
 * ── `source` IS AN OUTCOME OF ITS OWN, and that is deliberate ───────────────
 *
 * The right-hand column is drawable whatever happened to the left one: the
 * derived book is on disk and the ops chain over it is already proven by the time
 * this is composed. So a parent that cannot be read — a payload swept out from
 * under an edit step, a step whose parent is not in the history — must not refuse
 * the whole load and take a working position down with it. It refuses the CONTEXT,
 * in main's own sentence, on the left sheet, and the book somebody came to edit is
 * still in front of them.
 */
export interface BookTranslation {
  /** The language the words at this position are IN — the translate step's own. */
  language: string;
  /**
   * WHICH REWRITE, WHERE THIS PASS WAS A SIMPLIFY — the step's own `params.rewrite`,
   * and absent for every ordinary translation.
   *
   * A simplify IS a translate step (shared/types.ts, `RewriteMode`): same pipeline,
   * same records file, same pair of columns. That is what makes the aligned view
   * work for one without being told about it — and it is also why the pane could
   * not tell the two apart, and told somebody who had pressed Simplify that their
   * book had been translated. One field carried beside the language settles it at
   * the same place the language is settled, off the same step, so the sentence the
   * pane says and the row `labelFor` prints cannot disagree.
   */
  rewrite?: RewriteMode;
  /**
   * The parent book AS THE RECORDS ANSWERED IT — the translate step's parent
   * position, materialised: its nearest ancestor book file with the chain up to
   * that step replayed into it.
   *
   * ROWS ONLY, AND NO OPS CHAIN COMES WITH THEM. This is not a second editable
   * book; it is the state the translator was handed, which is why the ids line up
   * with the derived file's (docs/RENDERER.md §4 — *"parent ids kept verbatim"*)
   * and why replaying anything over it would make it stop lining up. It is the
   * identical composition `writeTranslationBook` performs before it puts the
   * records' words in (electron/book.ts), which is the whole reason the two
   * columns can be locked together by id at all.
   */
  source: { ok: true; rows: BookRow[] } | { ok: false; reason: string };
}

/**
 * THE ANSWER TO `book:load` — the file, plus the two things the file does not
 * carry.
 *
 * The title is the PROJECT's, read off its catalogue by main, because a book file
 * is a list of blocks and has no idea what the book it came out of is called.
 * `figures` is where this book's cut images are served from — a URL prefix the
 * pane puts a row's `image` name after — or null for a book none were cut for,
 * which is an ordinary state (no --pdf at reflow, or no pictures in the book)
 * and not a hole. Both ride along here rather than being asked for separately
 * so that a pane has one question to ask and one answer to draw.
 */
export interface BookLoad {
  title: string;
  /** The read's declared language, from the header. */
  language: string;
  rows: BookRow[];
  chapters: BookChapter[];
  typography: BookTypography | null;
  seams: BookSeam[];
  loose: BookLoose;
  /** Where the figures are served, ending in `/`, or null when none were cut. */
  figures: string | null;
  /**
   * THE PIXELS THIS BOOK WAS READ OFF, so a block can be shown where it stood.
   *
   * *"i want to hover over a block and see that page of the original beside
   * it."* Every row already carries the address — `page`, `box`, `pageWidth`,
   * `pageHeight` — and until now the pane had the address of a document it had
   * no way to open: a `book` tab's path is the PROJECT directory, and nothing on
   * the load named the scan. This is that name, and it is the whole of the new
   * door.
   *
   * NULL IS AN ORDINARY ANSWER AND MEANS TWO TRUE THINGS. A book that arrived as
   * an EPUB has never had pages — its rows are all `page: 0`, the no-page frame
   * (`BookRow.page`) — so there is nothing to show and the pane says so rather
   * than drawing an empty frame. And a project whose archived original is gone
   * answers the same way, because the honest sentence is identical: this book
   * cannot show you its paper.
   *
   * IT IS THE ARCHIVED ORIGINAL AND NOT THE WORKING COPY, which is the same
   * choice `planReading` makes for the same reason (electron/workspace.ts): what
   * the reading photographed is the immutable copy in `archive/`, and after a
   * searchable conversion the working copy is type on blank paper with none of
   * the pixels the blocks were read from. A peek at the wrong one would be a
   * picture of a page this book was not made from.
   */
  originalPath: string | null;
  /**
   * THE PHOTOGRAPHED PAGES THIS BOOK WAS READ OFF, when that is what it was.
   *
   * A SECOND FIELD AND NOT A WIDENING OF `originalPath`, mirroring the choice
   * `bookAtPosition` already made between `pdf` and `pages` and for the same
   * reason: the two are not interchangeable to whoever is about to open one.
   * `originalPath` answers *"what document can be rasterised"*; this answers
   * *"where are the page images"*, and a directory handed to something expecting
   * a PDF is a failure at the far end of the app from the decision that caused
   * it.
   *
   * IT EXISTS BECAUSE THE ALTERNATIVE WAS A LIE. A captured project's archive is
   * a DIRECTORY of photographed pages, so `at.pdf` is null for it and the glance
   * card's sentence for a null scan — *"it arrived as a book rather than as a
   * scan"* — would be said over a book that has 25 photographs of paper. The
   * card still cannot draw one; what this buys is that it stops claiming they do
   * not exist. Rendering them is the open work (docs/PLAN.md), and this is the
   * field it will read when somebody does it.
   */
  originalPages: string | null;
  /**
   * The translation this position stands under, or null for a book in its own
   * language — and with it, the source the aligned view draws in its left column.
   */
  translation: BookTranslation | null;
  /**
   * EVERY CHANGE ON THE PATH FROM THE READING TO WHERE THE PERSON IS STANDING,
   * flattened into one list in the order they were made.
   *
   * *"Standing on any step = replay of that chain."* (docs/RENDERER.md §3.) The
   * rows above are the book as the reflow left it; these are the deltas the edit
   * steps on the ancestry retained, oldest first, and what the pane draws is
   * `replayOps(rows, [...these, ...whatever is on the stack])`. FLAT, and not one
   * list per step, because replay is a fold and a step boundary is not a fact
   * about a block — the ledger already holds the boundaries, and a pane that had
   * to reassemble them would be a second opinion about the order.
   *
   * EMPTY IS THE ORDINARY ANSWER, for every book nobody has edited yet and for
   * every position standing above the first edit. It is never absent: main
   * refuses the whole load rather than hand over a chain it could only half read
   * (electron/book.ts), because a book drawn without one of its own steps is a
   * book that has silently lost somebody's work.
   */
  ops: BookOp[];
  /**
   * THE AMENDABLE TIP'S OWN OPS, or null where the position has none.
   *
   * Set when the position stands ON an edit step with nothing landed under it:
   * that step's changes are still the person's to change, so they are NOT in
   * `ops` — the pane hydrates its undo stack from them and replays them under
   * the chain itself, which is what lets undo reach back through what was
   * already applied and lets the next Apply amend the step rather than mint a
   * sibling (user ruling, 2026-08-16; `amendBookOps`, electron/book.ts).
   */
  tip: BookOp[] | null;
  /**
   * WHAT AN OLD SAVE ON THIS PATH DECIDED AND THIS BOOK HAS NOWHERE TO PUT —
   * absent for every project made under the op grammar, which is nearly all of
   * them.
   *
   * A `curate` step froze a file of decisions keyed by the model's own page
   * coordinates, and those are re-keyed onto block ids when the book is opened
   * (`rekeyCuration`, shared/curate-bridge.ts). Most of them land. The ones that
   * cannot — an amendment about an answer this reading no longer has, a manual
   * page-turn join that is a seam on the sheet now — produce no op, and this is
   * the list of sentences saying so.
   *
   * IT IS A LIST AND NOT A COUNT because the person can act on each one: the
   * sentence names the block by page and position, which is where they would go
   * and look. And it is HERE, on the load, rather than raised as a failure,
   * because the book IS drawable — what it is missing is a handful of decisions
   * out of somebody's history, and refusing to open a book over that would be
   * worse than saying which ones they were.
   */
  unplaced?: string[];
}

/**
 * The book, or the sentence saying why there is not one.
 *
 * NOT A REJECTION, on `PdfBlocksOutcome`'s rule and for its exact reason: "this
 * book has never been read" and "the engine would not reflow this bank" are
 * ordinary answers a person should meet as a sentence on the paper rather than
 * as a broken tab. A rejection across the bridge also arrives wearing Electron's
 * own wrapper — the channel's name, twice-prefixed with `Error:` — and a page of
 * warm ivory paper is not the place to put that.
 */
export type BookOutcome =
  | ({ ok: true } & BookLoad)
  | { ok: false; reason: string };

/** A finite number, or null — the one test every numeric field below goes through. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A whole number at or above zero, or null. Offsets, lengths, ordinals, pages. */
function countOf(value: unknown): number | null {
  const found = numberOf(value);
  return found === null || !Number.isInteger(found) || found < 0 ? null : found;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{x1,y1,x2,y2}`, all four finite, or null. */
function boxOf(value: unknown): BookBox | null {
  const row = objectOf(value);
  if (row === null) return null;
  const x1 = numberOf(row['x1']);
  const y1 = numberOf(row['y1']);
  const x2 = numberOf(row['x2']);
  const y2 = numberOf(row['y2']);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
  return { x1, y1, x2, y2 };
}

/**
 * One `{block, at, len}`, or null.
 *
 * `len` MUST BE AT LEAST ONE, which is the only one of these tests that is a
 * judgement rather than a type check: a marker of zero characters is a marker
 * that cannot be drawn, clicked or struck, and drawing it as an empty span would
 * put an invisible thing in the margin flags' place.
 */
function refOf(value: unknown): BookRef | null {
  const row = objectOf(value);
  if (row === null) return null;
  const block = row['block'];
  const at = countOf(row['at']);
  const len = countOf(row['len']);
  if (typeof block !== 'string' || block.length === 0 || at === null || len === null || len < 1) {
    return null;
  }
  return { block, at, len };
}

/**
 * The header, field by field.
 *
 * EVERY FIELD IS REQUIRED, including the ones that are usually empty. A file
 * with no `seams` is not a file whose every page turn was joined — it is a file
 * written by something that does not know what a seam is, which is exactly the
 * drift the version number and this function exist to catch.
 */
function headerOf(line: string): BookHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new BookFileError(`the book's first line is not JSON (${(err as Error).message}).`);
  }
  const row = objectOf(parsed);
  if (row === null) throw new BookFileError('the book\'s first line is not an object, so it is not a header.');

  const version = row['book'];
  if (version !== BOOK_FILE_VERSION) {
    /*
     * AN OLD BOOK FILE IS REFUSED, NOT MIGRATED, and the sentence says why that
     * costs nothing: the file is derived. The engine's own parser owns the full
     * argument (parseBookFile, src/vlm/book-file.ts); this side adds the one
     * fact the app knows — that opening the position again is what remakes it.
     */
    throw new BookFileError(
      version === 1 || version === 2
        ? `this book is written in format ${String(version)}, from an earlier engine. It is derived `
          + 'and costs nothing to remake: remove it and open this position again, and the book comes '
          + 'back in the current format with every block wearing the id it already had.'
        : `this book is written in format ${String(version)} and this app reads format `
          + `${BOOK_FILE_VERSION}. It was made by a different build of the engine.`,
    );
  }

  const engine = row['engine'];
  const language = row['language'];
  if (typeof engine !== 'string' || engine.length === 0
    || typeof language !== 'string' || language.length === 0) {
    throw new BookFileError(
      'the book\'s header does not say which engine wrote it and in what language it was read.',
    );
  }
  const source = sourceOf(row['source']);

  const rawChapters = row['chapters'];
  if (!Array.isArray(rawChapters)) throw new BookFileError('the book\'s header carries no chapter list.');
  const chapters: BookChapter[] = [];
  for (const [at, candidate] of rawChapters.entries()) {
    const entry = objectOf(candidate);
    const id = entry === null ? undefined : entry['id'];
    const title = entry === null ? undefined : entry['title'];
    if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') {
      throw new BookFileError(`chapter ${at + 1} in this book names no block, or has no title.`);
    }
    const kind = entry === null ? undefined : entry['kind'];
    if (kind !== undefined && typeof kind !== 'string') {
      throw new BookFileError(`chapter ${at + 1} in this book says what kind it is in something that is not a word.`);
    }
    chapters.push(kind === undefined ? { id, title } : { id, title, kind });
  }

  const typography = typographyOf(row['typography']);

  const rawSeams = row['seams'];
  if (!Array.isArray(rawSeams)) {
    throw new BookFileError('the book\'s header carries no list of unjoined page turns.');
  }
  const seams: BookSeam[] = [];
  for (const [at, candidate] of rawSeams.entries()) {
    const entry = objectOf(candidate);
    const after = entry === null ? undefined : entry['after'];
    const before = entry === null ? undefined : entry['before'];
    if (typeof after !== 'string' || after.length === 0
      || typeof before !== 'string' || before.length === 0) {
      throw new BookFileError(`unjoined page turn ${at + 1} does not name the two blocks it falls between.`);
    }
    seams.push({ after, before });
  }

  const rawLoose = objectOf(row['loose']);
  if (rawLoose === null) {
    throw new BookFileError('the book\'s header does not say what apparatus was left unlinked.');
  }
  const rawMarkers = rawLoose['markers'];
  const rawNotes = rawLoose['notes'];
  if (!Array.isArray(rawMarkers) || !Array.isArray(rawNotes)) {
    throw new BookFileError('the book\'s record of unlinked apparatus is not two lists.');
  }
  const markers: BookLooseMarker[] = [];
  for (const [at, candidate] of rawMarkers.entries()) {
    const ref = refOf(candidate);
    const printed = countOf(objectOf(candidate)?.['printed']);
    if (ref === null || printed === null) {
      throw new BookFileError(`unlinked reference ${at + 1} does not say where in the book it was printed.`);
    }
    markers.push({ ...ref, printed });
  }
  const notes: string[] = [];
  for (const [at, candidate] of rawNotes.entries()) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new BookFileError(`unlinked note ${at + 1} has no name, and a name is the only thing that names one.`);
    }
    notes.push(candidate);
  }

  return { engine, language, source, chapters, typography, seams, loose: { markers, notes } };
}

/** The bank's identity block, or the sentence saying the header lost it. */
function sourceOf(value: unknown): BookSource {
  const row = objectOf(value);
  const pages = row === null ? null : countOf(row['pages']);
  const bankSha = row === null ? undefined : row['bankSha'];
  const rawUnreadable = row === null ? undefined : row['unreadable'];
  if (row === null || pages === null || typeof bankSha !== 'string' || bankSha.length === 0
    || !Array.isArray(rawUnreadable)) {
    throw new BookFileError(
      'the book\'s header does not say what bank it was made from — and without the bank\'s '
      + 'identity, nothing can tell whether the pages underneath this book have changed.',
    );
  }
  const unreadable: BookUnreadable[] = [];
  for (const [at, candidate] of rawUnreadable.entries()) {
    const entry = objectOf(candidate);
    const page = entry === null ? null : countOf(entry['page']);
    const reason = entry === null ? undefined : entry['reason'];
    if (page === null || typeof reason !== 'string') {
      throw new BookFileError(`unreadable page ${at + 1} in this book's record is not a page with a reason.`);
    }
    unreadable.push({ page, reason });
  }
  const generation = row['generation'];
  if (generation !== undefined && typeof generation !== 'string') {
    throw new BookFileError('the book\'s record of its generation is not a name.');
  }
  return generation === undefined
    ? { pages, unreadable, bankSha }
    : { pages, unreadable, generation, bankSha };
}

/** The measured type, or null where the book gave the engine too little to measure. */
function typographyOf(value: unknown): BookTypography | null {
  if (value === null) return null;
  const row = objectOf(value);
  if (row === null) throw new BookFileError('the book\'s measured typography is not an object.');
  const bodyPx = numberOf(row['bodyPx']);
  if (bodyPx === null) throw new BookFileError('the book\'s measured typography has no body size in it.');
  const rawCategories = objectOf(row['categories']);
  if (rawCategories === null) {
    throw new BookFileError('the book\'s measured typography lists no categories.');
  }
  const categories: Record<string, BookTypographyCategory> = {};
  for (const [name, candidate] of Object.entries(rawCategories)) {
    const entry = objectOf(candidate);
    const medianPx = entry === null ? null : numberOf(entry['medianPx']);
    const ratio = entry === null ? null : numberOf(entry['ratio']);
    const samples = entry === null ? null : countOf(entry['samples']);
    if (medianPx === null || ratio === null || samples === null) {
      throw new BookFileError(`the measured size of this book's ${name} blocks is not a measurement.`);
    }
    categories[name] = { medianPx, ratio, samples };
  }
  return { bodyPx, categories };
}

/**
 * A row's parts, proven against the row's own text.
 *
 * CHAR-EXACT IS THE CONTRACT AND SO IT IS CHECKED, not assumed — the engine's
 * `checkParts`, restated. `chars` is the one field in this format that makes a
 * claim about ANOTHER field of the same row: an offset past the end of the text
 * slices nothing, a gap between two parts loses characters that belong to a
 * page, and an overlap files the same words under two of them. All three read
 * as ordinary data and none of them is.
 */
function partsOf(id: string, text: string, value: unknown): BookPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BookFileError(
      `block "${id}" does not say which banked answers it was assembled from.`,
    );
  }
  const parts: BookPart[] = [];
  let at = 0;
  for (const [index, candidate] of value.entries()) {
    const entry = objectOf(candidate);
    const src = entry === null ? undefined : entry['src'];
    const page = entry === null ? null : countOf(entry['page']);
    const chars = entry === null ? undefined : entry['chars'];
    const start = Array.isArray(chars) ? countOf(chars[0]) : null;
    const end = Array.isArray(chars) ? countOf(chars[1]) : null;
    if (typeof src !== 'string' || src.length === 0 || page === null
      || !Array.isArray(chars) || chars.length !== 2 || start === null || end === null) {
      throw new BookFileError(
        `part ${index + 1} of block "${id}" is not a banked answer with a page and a character range.`,
      );
    }
    const fused = entry === null ? undefined : entry['fused'];
    if (fused !== undefined && typeof fused !== 'string') {
      throw new BookFileError(`part ${index + 1} of block "${id}" fused something that is not a word.`);
    }
    if (start !== at || end < at) {
      throw new BookFileError(
        `part ${index + 1} of block "${id}" covers characters ${start} to ${end} and the parts `
        + `before it end at ${at}, so the block's text is not divided between them.`,
      );
    }
    at = end;
    parts.push(fused === undefined
      ? { src, page, chars: [start, end] }
      : { src, page, chars: [start, end], fused });
  }
  if (at !== text.length) {
    throw new BookFileError(
      `block "${id}" is ${text.length} character(s) long and its parts account for ${at} of them.`,
    );
  }
  return parts;
}

/** One row, field by field. `at` is its line number, for a sentence about a row with no id. */
function rowOf(line: string, at: number, seen: Set<string>): BookRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new BookFileError(`block ${at} of this book is not JSON (${(err as Error).message}).`);
  }
  const row = objectOf(parsed);
  if (row === null) throw new BookFileError(`block ${at} of this book is not an object.`);

  const id = row['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new BookFileError(`block ${at} of this book has no id, and an id is the only thing that names one.`);
  }
  // Two blocks of one name is the failure every op in the project would inherit:
  // a strike would strike whichever the reader found first.
  if (seen.has(id)) throw new BookFileError(`two blocks in this book are called "${id}".`);
  seen.add(id);

  const category = row['category'];
  const text = row['text'];
  if (typeof category !== 'string' || category.length === 0 || typeof text !== 'string') {
    throw new BookFileError(`block "${id}" is missing its text or its category.`);
  }
  const page = countOf(row['page']);
  const box = boxOf(row['box']);
  const pageWidth = numberOf(row['pageWidth']);
  const pageHeight = numberOf(row['pageHeight']);
  const rawPages = row['pages'];
  if (page === null || box === null || pageWidth === null || pageHeight === null
    || !Array.isArray(rawPages) || rawPages.length === 0) {
    throw new BookFileError(`block "${id}" is missing its place in the book.`);
  }
  const pages: number[] = [];
  for (const candidate of rawPages) {
    const found = countOf(candidate);
    if (found === null) throw new BookFileError(`block "${id}" claims a page that is not a page number.`);
    pages.push(found);
  }
  const parts = partsOf(id, text, row['parts']);

  const made: BookRow = { id, category, text, page, pages, box, pageWidth, pageHeight, parts };

  const note = row['note'];
  if (note !== undefined) {
    const ordinal = countOf(note);
    if (ordinal === null) throw new BookFileError(`block "${id}" is a note whose ordinal is not a number.`);
    made.note = ordinal;
  }
  const refs = row['refs'];
  if (refs !== undefined) {
    if (!Array.isArray(refs)) throw new BookFileError(`block "${id}" carries references that are not a list.`);
    const found: BookRef[] = [];
    for (const [which, candidate] of refs.entries()) {
      const ref = refOf(candidate);
      if (ref === null) {
        throw new BookFileError(`reference ${which + 1} of block "${id}" does not say where in the body it was printed.`);
      }
      found.push(ref);
    }
    made.refs = found;
  }
  const image = row['image'];
  if (image !== undefined) {
    if (typeof image !== 'string' || image.length === 0) {
      throw new BookFileError(`block "${id}" names its figure as something that is not a name.`);
    }
    made.image = image;
  }
  const shelf = row['shelf'];
  if (shelf !== undefined) {
    if (shelf !== 'furniture' && shelf !== 'suppressed-head') {
      throw new BookFileError(
        `block "${id}" says it is shelved as "${String(shelf)}", and the shelf has two places on `
        + 'it: furniture, and suppressed-head.',
      );
    }
    made.shelf = shelf;
    // A shelved row without its sentence is the Furniture Review panel with a
    // blank cell where the argument goes — a block out of the book and nothing
    // saying why, which is the one thing the shelf exists to prevent.
    const why = row['why'];
    if (typeof why !== 'string' || why.length === 0) {
      throw new BookFileError(`block "${id}" is on the shelf and says nothing about why.`);
    }
    made.why = why;
  }
  return made;
}

/**
 * A book file, written down — a header line, then one row per block.
 *
 * ── WHY THE APP WRITES ONE AT ALL ───────────────────────────────────────────
 *
 * The engine is the writer of this format and stays the writer of it: `vlm-book`
 * makes a book out of a bank and nothing here will ever do that. What this writes
 * is the DERIVED book file — the same format with the same ids, with a chain of
 * ops replayed into it (docs/RENDERER.md §4) — and it has to be written here for
 * the reason the replay lives in shared/ at all: there is one implementation of
 * "what does this book say now", it is `replayOps`, and it runs in this process.
 * An engine that could materialise would be a second one (§9, R1).
 *
 * THE HEADER'S FIELDS ARE THE CONTRACT'S, IN THE CONTRACT'S ORDER, and the row
 * lines are the rows as this module parses them — same field order, same
 * spelling — so that a file written here is a file the engine's own parser reads
 * without a special case (`parseBookFile`, src/vlm/book-file.ts). Anything else
 * would be two dialects of one format, and the second one would be discovered by
 * an export failing.
 *
 * NO TIMESTAMP AND NOTHING ABOUT THIS MACHINE, which is what makes the same book
 * and the same chain produce the same bytes anywhere.
 */
export function formatBookFile(book: BookFile): string {
  const header = JSON.stringify({
    book: BOOK_FILE_VERSION,
    engine: book.header.engine,
    language: book.header.language,
    source: book.header.source,
    chapters: book.header.chapters,
    typography: book.header.typography,
    seams: book.header.seams,
    loose: book.header.loose,
  });
  return [header, ...book.rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
}

/**
 * Read a book file back, or say exactly what about it is not a book.
 *
 * ── The cross-checks, which are the ones worth having ───────────────────────
 *
 * Every field above is checked for BEING what it claims to be; these last ones
 * check that the file AGREES WITH ITSELF, and they are the ones that catch a real
 * corruption rather than a typo. A reference into a block the file does not hold
 * is a marker that can never be drawn; a loose note naming a row that is not
 * there is a flag in the margin about nothing; a seam between blocks the book
 * does not hold — or between blocks on the shelf — is a join nobody can be
 * offered. All would be invisible on the page, and all mean the file was written
 * by two things that disagree — which is precisely the state this whole format
 * exists to make impossible.
 *
 * TRUNCATION STOPPED BEING THIS PARSER'S PROBLEM AT VERSION 3: the engine
 * writes the file atomically (temp beside the target, then rename), so a crash
 * leaves the old book or none, never half of one, and the v2 header's row count
 * went with the version bump.
 */
export function parseBookFile(text: string): BookFile {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const head = lines.shift();
  if (head === undefined) throw new BookFileError('the book file is empty, so it is not a book.');
  const header = headerOf(head);

  const rows: BookRow[] = [];
  const seen = new Set<string>();
  for (const [at, line] of lines.entries()) rows.push(rowOf(line, at + 1, seen));

  /*
   * EVERY MARKER IN ONE PLACE, then checked as a set. A reference is a range of
   * characters inside somebody else's text, so the two ways it can be wrong are
   * "that text is not that long" and "two of them claim the same characters" —
   * and both are invisible in the file and fatal on the page, where the renderer
   * cuts each block's text at these offsets and would either cut past the end or
   * cut the same run twice. Checked here, once, so that nothing downstream has to
   * hold an opinion about a marker it cannot draw.
   */
  const texts = new Map(rows.map((row) => [row.id, row.text] as const));
  const spans = new Map<string, { at: number; len: number; by: string }[]>();
  const claim = (block: string, at: number, len: number, by: string): void => {
    const text = texts.get(block);
    if (text === undefined) {
      throw new BookFileError(`${by} is recorded in "${block}", which this book has no block called.`);
    }
    if (at + len > text.length) {
      throw new BookFileError(`${by} is recorded past the end of the words in "${block}".`);
    }
    const already = spans.get(block);
    if (already === undefined) spans.set(block, [{ at, len, by }]);
    else already.push({ at, len, by });
  };
  for (const row of rows) {
    for (const ref of row.refs ?? []) claim(ref.block, ref.at, ref.len, `the number for note "${row.id}"`);
  }
  for (const marker of header.loose.markers) {
    claim(marker.block, marker.at, marker.len, `an unlinked reference "${marker.printed}"`);
  }
  for (const [block, claims] of spans) {
    const sorted = [...claims].sort((one, other) => one.at - other.at);
    let end = 0;
    for (const span of sorted) {
      if (span.at < end) {
        throw new BookFileError(`two reference numbers claim the same words in "${block}" — ${span.by} is one of them.`);
      }
      end = span.at + span.len;
    }
  }
  for (const id of header.loose.notes) {
    if (!seen.has(id)) {
      throw new BookFileError(`"${id}" is listed as an unlinked note and is not a block this book holds.`);
    }
  }
  for (const chapter of header.chapters) {
    if (!seen.has(chapter.id)) {
      throw new BookFileError(`a chapter starts at "${chapter.id}", which this book has no block called.`);
    }
  }
  // A seam is an offer to join two paragraphs, so both must be blocks the book
  // holds and both must be IN THE FLOW — a join onto a shelved running head is
  // an offer nobody should ever see.
  const shelved = new Set(rows.filter((row) => row.shelf !== undefined).map((row) => row.id));
  for (const seam of header.seams) {
    for (const id of [seam.after, seam.before]) {
      if (!seen.has(id)) {
        throw new BookFileError(`an unjoined page turn names "${id}", which this book has no block called.`);
      }
      if (shelved.has(id)) {
        throw new BookFileError(`an unjoined page turn names "${id}", which is on the shelf and not in the book.`);
      }
    }
  }
  return { header, rows };
}

/**
 * curate-bridge — an old save, read as ops.
 *
 * ── What this is for, in one paragraph ──────────────────────────────────────
 *
 * Before the book file there were CURATIONS: a person struck a block, and the
 * decision was written into `overlays/<key>.json` as `{at:{page,order},
 * strike:true}` — a coordinate into the model's own answers. Pressing Apply
 * froze that whole file into `curations/<uuid>.json` and minted a `curate` step
 * naming it. Both spellings are gone (docs/RENDERER.md §7): a decision is an op
 * keyed by block id now, and the overlay grammar, the live file and every module
 * that read one were deleted at R6b.
 *
 * WHAT WAS NOT DELETED IS ANYBODY'S HISTORY. The plan's §8 is explicit — old
 * curate amendments RE-KEY through the book file's `src` mapping, and the files
 * are archived aside rather than removed — and the invariant under it is
 * sharper than the mechanism: no step is deleted from anybody's ledger, and a
 * curate step's payload is not deleted by anything. So the snapshot stays
 * exactly where it was written, and this module is the only thing that still
 * knows how to read one. It is a READER AND NEVER A WRITER: nothing in this app
 * makes another curation, and the schema below is therefore closed forever,
 * which is what makes it safe to keep a parser for it in fifty lines rather than
 * in the nine hundred the live system needed.
 *
 * ── Why re-keying is mechanical rather than a guess ─────────────────────────
 *
 * Because the book file records exactly the coordinates the overlay used. Every
 * row carries `parts`, and every part carries `src` — `"<page>:<order>"`, or
 * `"<page>:<order>:<part>"` for one piece of a banked answer that a markdown
 * split cut up (`BookPart`, shared/book.ts). That column exists FOR THIS: it is
 * the mechanical mapping the plan names, and it is why the plan can call a
 * re-key mechanical instead of hopeful.
 *
 * ── AND WHAT WILL NOT PLACE IS SAID OUT LOUD ────────────────────────────────
 *
 * The one rule this module exists to obey. §3: *"Ops that name a block a bank no
 * longer has are reported, never guessed at."* An amendment whose coordinate is
 * in no row of this book — the reading was replaced under it, the page was
 * unreadable, the answer it named was shelved as furniture — produces no op and
 * one sentence. A `join` produces no op at all and always produces a sentence,
 * because the reflow already decided every page turn it could and the seams it
 * left are joined by a gesture on the sheet against ids that had no spelling in
 * the old grammar; inventing a merge from a page coordinate would be exactly the
 * guess the rule forbids.
 *
 * The caller shows those sentences. A save that re-keys cleanly says nothing,
 * which is the ordinary case and the one worth keeping quiet.
 */

import type { BookFile, BookRow } from './book';
import type { BookOp } from './ops';

/** Refusals from this module, named so a caller can tell them from anything else. */
export class CurateBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurateBridgeError';
  }
}

/**
 * A frozen save, as it sits on disk — the closed v1 schema, and the only one
 * there has ever been.
 *
 * Read LENIENTLY IN ONE DIRECTION ONLY, and the asymmetry is deliberate. The
 * live reader refused every malformed field by name because a file it could not
 * read was a bug in a program that was still writing them, and half-applying a
 * curation would silently drop somebody's decisions. Nothing writes these any
 * more, so the interesting failures have already either happened or not. What
 * this reader still refuses outright is a file that is not a curation at all —
 * wrong version, no amendments array — because reading some other JSON as a set
 * of decisions about a book is the one way to get ops nobody made.
 */
interface FrozenCuration {
  amendments: FrozenAmendment[];
  /** Absent means nobody touched the spine. EMPTY means "this book does not divide". */
  chapters?: FrozenChapter[];
}

interface FrozenTarget {
  page: number;
  order: number;
  /** One piece of a banked answer. Absent means every part of it. */
  part?: number;
  /** One note of a footnote block, from 0. Absent means the block. */
  note?: number;
}

interface FrozenAmendment {
  at: FrozenTarget;
  strike?: boolean;
  category?: string;
  text?: string;
  join?: boolean;
}

interface FrozenChapter {
  at: FrozenTarget;
  title: string;
}

/** What a snapshot became, and what it could not. */
export interface Rekeyed {
  /** The decisions, as ops against block ids, in the order they were written. */
  ops: BookOp[];
  /**
   * One sentence per decision that has no block to be about — for the person,
   * never for a log. Empty is the ordinary answer.
   */
  unplaced: string[];
}

/** The `src` spelling of a target, which is the whole of the mapping. */
function srcOf(at: FrozenTarget): string {
  return at.part === undefined ? `${at.page}:${at.order}` : `${at.page}:${at.order}:${at.part}`;
}

/**
 * The rows one target is about, in book order.
 *
 * TWO SHAPES OF TARGET, AND THE DIFFERENCE IS THE OLD GRAMMAR'S OWN. A target
 * WITH a part names one piece of one banked answer, so it matches the parts
 * whose `src` is that exact string. A target WITHOUT one means the whole answer
 * element — which the engine may have cut into several rows — so it matches
 * every part whose `src` is that answer or any piece of it. That was the useful
 * default when a person struck a region of a page, and it stays the default
 * here for the same reason: they were pointing at the paragraph, not at the
 * markdown pass that happened to divide it.
 *
 * A NOTE TARGET NAMES A NOTE ROW AND A BLOCK TARGET NAMES A BLOCK. The engine
 * cuts one banked Footnote answer into a row per note, each carrying its
 * block's `src` and its own `note` ordinal, so both live in the same index and
 * only this test separates them. Without it, striking a footnote block would
 * come back as five note rows and striking note 3 would come back as the block.
 */
function rowsFor(at: FrozenTarget, book: BookFile): BookRow[] {
  const exact = srcOf(at);
  const family = `${at.page}:${at.order}:`;
  return book.rows.filter((row) => {
    if (at.note === undefined ? row.note !== undefined : row.note !== at.note) return false;
    return row.parts.some((part) => (
      at.part === undefined
        ? part.src === exact || part.src.startsWith(family)
        : part.src === exact
    ));
  });
}

/** How a coordinate is named to a person: never as a file, never as raw JSON. */
function said(at: FrozenTarget): string {
  const block = `block ${at.order} of page ${at.page}`;
  return at.note === undefined ? block : `note ${at.note + 1} of ${block}`;
}

/**
 * A frozen save, re-keyed onto this book.
 *
 * THE ORDER IS THE FILE'S ORDER, which is the order the writer folded
 * amendments in, and it matters for the same reason the ops chain is ordered:
 * replay is order-dependent. Chapters come last because they are a statement
 * about the whole book rather than about one block, and because the takeover
 * rule below has to see the seed as the rows left it.
 */
export function rekeyCuration(snapshot: unknown, book: BookFile): Rekeyed {
  const frozen = readCuration(snapshot);
  const ops: BookOp[] = [];
  const unplaced: string[] = [];

  for (const amendment of frozen.amendments) {
    /*
     * A JOIN HAS NO OP AND IS NOT GOING TO GET ONE. It said "join this block to
     * the one before it" across a page turn the reflow declined to resolve; the
     * book file resolves every turn it can at reflow and records the ones it
     * left as SEAMS, which are joined on the sheet against the two ids the seam
     * names (docs/BOOK-FILE.md §5). Turning a page coordinate into a merge here
     * would be this module deciding which two rows somebody meant, which is the
     * guess §3 forbids — and the seam is still on the sheet, so the gesture is
     * one click away rather than lost.
     */
    if (amendment.join !== undefined) {
      unplaced.push(
        `a join at ${said(amendment.at)}, which is now a seam you can close on the page itself`,
      );
      continue;
    }
    const rows = rowsFor(amendment.at, book);
    if (rows.length === 0) {
      unplaced.push(`a change to ${said(amendment.at)}, which this book has no block for`);
      continue;
    }
    for (const row of rows) {
      if (amendment.strike === true) ops.push({ op: 'strike', id: row.id });
      if (amendment.strike === false) ops.push({ op: 'restore', id: row.id });
      if (amendment.category !== undefined) {
        ops.push({ op: 'category', id: row.id, category: amendment.category });
      }
      /*
       * A TEXT OVERRIDE GOES TO ONE ROW ONLY, and a target that spread over
       * several is refused rather than copied into each. The override replaced
       * the words of the whole banked answer; writing them into three rows that
       * between them ARE that answer would put one paragraph on screen three
       * times. Rare, ancient, and better said than silently tripled.
       */
      if (amendment.text !== undefined) {
        if (rows.length === 1) ops.push({ op: 'text', id: row.id, text: amendment.text });
        else if (row === rows[0]) {
          unplaced.push(
            `corrected words at ${said(amendment.at)}, which this book reads as `
            + `${rows.length} separate blocks`,
          );
        }
      }
    }
  }

  /*
   * ── THE SPINE, WHICH IS DEFINITIVE OR ABSENT AND NEVER PARTIAL ─────────────
   *
   * An overlay's chapter list SPLIT THE BOOK WHERE IT SAID AND NOWHERE ELSE, and
   * an absent list meant nobody had touched the spine. The op grammar says the
   * same thing differently: the engine's seed stands until the first chapter op,
   * and from there the ops' list is in force starting FROM the seed
   * (`replayOps`). So the two are made to agree by saying it in full — every
   * seeded division the save did not keep is removed, and every division the
   * save named is set. An empty list removes them all, which is exactly the
   * statement "this book does not divide" that the old format spelled as `[]`.
   *
   * NO LIST AT ALL EMITS NOTHING, and that is not the same answer. A save that
   * said nothing about the spine leaves the engine's seed owning it, which is
   * what it meant then and what emitting nothing means now.
   */
  if (frozen.chapters !== undefined) {
    const wanted: { id: string; title: string }[] = [];
    for (const chapter of frozen.chapters) {
      const rows = rowsFor(chapter.at, book);
      const first = rows[0];
      if (first === undefined) {
        unplaced.push(
          `a chapter beginning at ${said(chapter.at)}, which this book has no block for`,
        );
        continue;
      }
      wanted.push({ id: first.id, title: chapter.title });
    }
    const kept = new Set(wanted.map((one) => one.id));
    for (const seeded of book.header.chapters ?? []) {
      if (!kept.has(seeded.id)) ops.push({ op: 'chapter', remove: seeded.id });
    }
    for (const one of wanted) ops.push({ op: 'chapter', set: one.id, title: one.title });
  }

  return { ops, unplaced };
}

/**
 * The snapshot, proved to be one.
 *
 * Everything below is a shape test and not a schema validation, for the reason
 * in the header: the writer is gone, so the only failure worth refusing is
 * "this is not a curation", and every field that is merely wrong is skipped
 * with the amendment it belongs to rather than taking the whole save down.
 */
function readCuration(value: unknown): FrozenCuration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CurateBridgeError('the decisions this row froze are not a record of decisions at all');
  }
  const root = value as Record<string, unknown>;
  if (root['overlay'] !== 1) {
    throw new CurateBridgeError(
      'the decisions this row froze are written in a form this build has never made',
    );
  }
  const raw = root['amendments'];
  if (!Array.isArray(raw)) {
    throw new CurateBridgeError('the decisions this row froze carry no list of decisions');
  }
  const amendments: FrozenAmendment[] = [];
  for (const entry of raw) {
    const one = readAmendment(entry);
    if (one !== null) amendments.push(one);
  }
  const spine = root['chapters'];
  if (!Array.isArray(spine)) return { amendments };
  const chapters: FrozenChapter[] = [];
  for (const entry of spine) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const at = readTarget(row['at']);
    const title = row['title'];
    if (at === null || typeof title !== 'string') continue;
    chapters.push({ at, title });
  }
  return { amendments, chapters };
}

function readAmendment(value: unknown): FrozenAmendment | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const at = readTarget(row['at']);
  if (at === null) return null;
  const amendment: FrozenAmendment = { at };
  if (typeof row['strike'] === 'boolean') amendment.strike = row['strike'];
  if (typeof row['category'] === 'string' && row['category'].length > 0) {
    amendment.category = row['category'];
  }
  if (typeof row['text'] === 'string' && row['text'].length > 0) amendment.text = row['text'];
  if (typeof row['join'] === 'boolean') amendment.join = row['join'];
  const decided = amendment.strike !== undefined || amendment.category !== undefined
    || amendment.text !== undefined || amendment.join !== undefined;
  return decided ? amendment : null;
}

function readTarget(value: unknown): FrozenTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const page = row['page'];
  const order = row['order'];
  if (!Number.isInteger(page) || !Number.isInteger(order)) return null;
  const at: FrozenTarget = { page: page as number, order: order as number };
  if (Number.isInteger(row['part'])) at.part = row['part'] as number;
  if (Number.isInteger(row['note'])) at.note = row['note'] as number;
  return at;
}

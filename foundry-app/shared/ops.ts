/**
 * shared/ops — the OP GRAMMAR, and the one replay every surface reads the book
 * through.
 *
 * ── What an op is, and why there is exactly one of them per decision ────────
 *
 * *"we should still operate off of a ledger-based system, and when the changes
 * are saved/committed, we could produce a new, second bank with the
 * updates/changes."* (docs/RENDERER.md §0, ruling 5.) An op is one decision about
 * one BLOCK ID: strike this paragraph, put these words in it, call it a Quote,
 * join it to the one the page turn cut it from. A step's payload is a JSONL file
 * of them and it is a DELTA — never cumulative — so standing anywhere in the
 * history means replaying the ops of every edit step on the path from the reading
 * to where you stand, in order, over the book file that reading produced
 * (docs/RENDERER.md §3).
 *
 * ONE STRIKE LIVES IN EXACTLY ONE PLACE. Today the same decision lives in four —
 * the frame's DOM, spliced XHTML in `working/`, `overlays/<key>.json` and a
 * curation snapshot — and every guard in this app exists to reconcile them
 * (docs/RENDERER.md §1). Here it is a line in a file, keyed by an id the engine
 * minted and never reuses, and the thing on screen is a pure function of the
 * book file and that list.
 *
 * ── Why the replay is PURE, and why it lives in shared/ ─────────────────────
 *
 * `shared/ledger.ts`'s reason, one document down. Two readers must agree to the
 * character: the renderer draws `replayOps(...)` as a computed signal, and
 * materialisation writes the derived book file out of the same call
 * (docs/RENDERER.md §9, R5). Two implementations of "what does this book say now"
 * is the failure the whole design is arranged to make impossible — so there is
 * one, it takes rows and ops and returns rows, and it touches no disk, no clock
 * and no Electron.
 *
 * ── EVERY SHAPE §3 DECLARES IS NOW PERFORMED ────────────────────────────────
 *
 * `strike`, `restore`, `text` and `category` landed first; `merge`, `split`,
 * `move`, `chapter`, `link` and `restore-furniture` are here now, and with them
 * the table in docs/RENDERER.md §3 is closed. Nothing in this grammar is declared
 * and refused any more. What remains refused is an op word this program has never
 * heard of, which means the file was written by a build from the future, and the
 * honest thing to do with a book somebody edited with a later Foundry is to say
 * so rather than to draw two thirds of their work.
 *
 * ── LAST OP WINS, and it is the rule rather than a tolerance ────────────────
 *
 * A chain is a list of deltas in the order the person made them, and a person
 * genuinely does strike a paragraph, apply, restore it, apply, and strike it
 * again. That is three steps, three files and three ops naming one id, and
 * replaying them in order gives the state they left it in. So `strike` of an
 * already-struck row and `restore` of an unstruck one are ordinary rather than
 * refusals: the last op to name an id is what that id says, which is what
 * "replay a delta chain" means, and any other rule would make a legal history
 * unloadable.
 *
 * ── AND WHY THAT IS NO LONGER ENOUGH, WHICH IS THE WHOLE OF THIS WAVE ───────
 *
 * Last-op-wins is a statement about ONE id's state, and it was expressible as a
 * fold because the four first ops only ever changed state: the same rows came
 * out that went in, in the same order. `merge`, `split`, `move` and
 * `restore-furniture` change WHICH ROWS EXIST AND IN WHAT ORDER, and a fold has
 * no answer for that — "the last op naming b8-1 wins" is meaningless once an
 * earlier op in the same chain has taken b8-1 out of the book. So the replay is
 * an ORDERED INTERPRETATION over a working row list now (`interpret` below):
 * every op is applied to the book as the ops before it left it, which is the only
 * reading of "a delta chain" that survives a chain that restructures.
 *
 * Last-op-wins is unchanged inside that, because it is what an interpretation of
 * a state op does anyway — the second strike of one id writes the same field the
 * first one did. And the fold SURVIVES, as a fast path over chains that contain
 * no structural op at all (`fold`): a chain of six hundred strikes should cost
 * one copy per touched row and not six hundred, and the overwhelming majority of
 * chains this app writes are still four-op chains. The guard is a single `some`
 * over the chain, and the two paths are proven to agree field for field.
 */

import type { BookChapter, BookLoose, BookRef, BookRow } from './book';
import { printedNoteNumber, superscriptRuns } from './inline';

/** Refusals from this module, named so a caller can tell them from anything else. */
export class BookOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookOpsError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The grammar — docs/RENDERER.md §3, in full
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strike a block: it stays in the document and is drawn cancelled.
 *
 * A STATE AND NOT A REMOVAL, which is the landed rule (RENDERER-DESIGN.md §3):
 * the workbench draws the proofreader's cancel over it always — struck is a state
 * of the document, not of a mode — and the EDITION leaves it out. Nothing is lost
 * by striking and nothing has to be found again to restore it.
 */
export interface StrikeOp {
  op: 'strike';
  id: string;
}

/** Un-strike a block. The other half of `strike`, and its exact inverse. */
export interface RestoreOp {
  op: 'restore';
  id: string;
}

/**
 * Replace a block's text with this string.
 *
 * THE SOURCE STRING, inline markers and all. A block's text keeps the model's own
 * markup — `*italics*`, superscript reference numbers — and the renderer draws it
 * through the same inline rules the emitter uses, so a text edit edits what the
 * model answered rather than a rendering of it (docs/RENDERER.md §2). Rich
 * WYSIWYG editing of the markup is deferred out loud (§10).
 */
export interface TextOp {
  op: 'text';
  id: string;
  text: string;
}

/** Say what kind of block this is — the engine's spelling, `Text`, `Quote`. */
export interface CategoryOp {
  op: 'category';
  id: string;
  category: string;
}

/**
 * Absorb `id` into `into`, which keeps its own id and its own place.
 *
 * THE SEAM GESTURE, and the asymmetry is the point. A page turn the reflow
 * declined to join is recorded as a pair of block ids (`BookSeam`), and a person
 * joining one is telling the book that the paragraph which ends the earlier page
 * and the one which opens the later page are one paragraph. The EARLIER of them
 * keeps its name, because it is the one whose id every marker, chapter and
 * earlier op is already keyed to — which is the engine's own rule for the joins
 * it makes itself (*"a merge consumes the SECOND block, so re-running never
 * renames survivors"*, docs/RENDERER.md §2).
 */
export interface MergeOp {
  op: 'merge';
  id: string;
  into: string;
}

/**
 * Cut `id` in two at a character offset, minting `<id>/1` and `<id>/2`.
 *
 * `at` IS THE CARET, in characters into the block's CURRENT text — the text as
 * the ops before this one left it, not as the file has it. The parser proves it
 * is a whole number at or above one; whether it falls inside the words is a
 * question only the replay can answer, and it answers it into `missing`.
 */
export interface SplitOp {
  op: 'split';
  id: string;
  at: number;
}

/** Reading-order repair — put `id` immediately before `before`. */
export interface MoveOp {
  op: 'move';
  id: string;
  before: string;
}

/**
 * Draw a division above this block, and call it this.
 *
 * Retitles in place if a division is already there, so that "set" is one gesture
 * whether or not the engine's seed happened to find the same block — a person
 * dropping a chapter line on a heading should not have to know whether they are
 * creating one or renaming one.
 */
export interface ChapterSetOp {
  op: 'chapter';
  set: string;
  title: string;
}

/** Take the division above this block away. The block stays; the rule goes. */
export interface ChapterRemoveOp {
  op: 'chapter';
  remove: string;
}

/** Call the division above this block something else. The rule stays where it is. */
export interface ChapterRenameOp {
  op: 'chapter';
  rename: string;
  title: string;
}

/** Move the division above one block to sit above another. It keeps its title. */
export interface ChapterMoveOp {
  op: 'chapter';
  move: string;
  to: string;
}

/**
 * Give the divisions back to the engine's seed.
 *
 * *"Ownership is by ops exactly as today's confirmed-list rule: the first chapter
 * op takes the list over; 'Use Foundry's' is an op that returns it."*
 * (docs/RENDERER.md §2.) This is that op, and it is spelled as a verb field like
 * the other four so that every decision about the divisions reads the same way on
 * the wire. `true` and nothing else: a reset that said `false` would be a change
 * that changes nothing, which is not a thing a ledger should be able to record.
 */
export interface ChapterResetOp {
  op: 'chapter';
  reset: true;
}

/**
 * The five verbs, as five shapes — docs/RENDERER.md §3's own list.
 *
 * A DISCRIMINATED UNION ON THE FIELD NAME rather than one shape with a `verb`
 * string, because the field a verb needs differs per verb (`set` needs a title,
 * `remove` needs nothing, `move` needs a second block) and a single shape would
 * have to carry all of them optionally — which is a shape that can spell four
 * contradictions for every legal change. Here the parser proves exactly one verb
 * field is present, and after that the compiler knows which fields exist.
 */
export type ChapterOp =
  | ChapterSetOp
  | ChapterRemoveOp
  | ChapterRenameOp
  | ChapterMoveOp
  | ChapterResetOp;

/** Bind a reference number in the prose to a note, by hand. */
export interface LinkOp {
  op: 'link';
  block: string;
  at: number;
  len: number;
  note: string;
}

/**
 * Put a row the reflow shelved back into the flow.
 *
 * KEYED BY `id`, which is the amended spelling (docs/RENDERER.md §3): the shelf
 * became ROWS at their reading-order positions when the book file went to v3, and
 * every one of them wears a minted id like any other block. The older `src`
 * spelling predated that and named a banked coordinate, which is a second way to
 * name a block and therefore a second thing that can be wrong.
 */
export interface RestoreFurnitureOp {
  op: 'restore-furniture';
  id: string;
}

export type BookOp =
  | StrikeOp
  | RestoreOp
  | TextOp
  | CategoryOp
  | MergeOp
  | SplitOp
  | MoveOp
  | ChapterOp
  | LinkOp
  | RestoreFurnitureOp;

/**
 * Every op word this grammar has. All of them are performed.
 *
 * ── The table that used to sit beside this one, and how it comes back ───────
 *
 * There was an `OWED_BY` here: op word to the capability that would perform it,
 * so that a shape §3 declared ahead of its implementation could be refused with a
 * sentence saying which part of Foundry the person needed rather than a flat no.
 * It is gone because it is EMPTY — this build performs every shape the grammar
 * declares — and a lookup table with no rows, read by a branch nothing can reach,
 * is a mechanism that looks maintained and is not.
 *
 * The day the grammar grows a shape ahead of its implementation again, the
 * mechanism is three lines and they all belong in this file: a `Record<string,
 * string>` of word to capability beside this list, a membership test after the
 * one below, and a second sentence in the refusal — so that the entry which has
 * to be deleted the day that shape lands is in the same place as the parser that
 * stops refusing it.
 */
const PERFORMED = [
  'strike',
  'restore',
  'text',
  'category',
  'merge',
  'split',
  'move',
  'chapter',
  'link',
  'restore-furniture',
] as const;

/**
 * The ops that change WHICH rows exist, or in what order, or what is on the
 * shelf — the ones a fold cannot express.
 *
 * `link` and `chapter` are in here not because they move rows (they do not) but
 * because they carry state that lives BESIDE the rows — the notes' refs, the
 * loose apparatus, the division list — and the fold path has nowhere to put it.
 * The guard is "can `fold` answer this chain honestly", and for these five words
 * the answer is no.
 */
const STRUCTURAL: ReadonlySet<string> = new Set([
  'merge',
  'split',
  'move',
  'chapter',
  'link',
  'restore-furniture',
]);

/**
 * The sentence for an op word this program has never heard of.
 *
 * NO FILENAME AND NO WAVE NUMBER — the house rules on both. Foundry's own
 * bookkeeping means nothing to somebody looking at a book that will not open;
 * what they need is that the file was written by something newer than this.
 */
function refuseUnknownOp(kind: string, where: string): never {
  throw new BookOpsError(
    `${where} is "${kind}", which is not a change this program knows how to make. This book carries `
    + 'a change of a kind this build cannot replay, and drawing the book without that change would '
    + 'show you a document nobody edited.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The file: one op per line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ops → the bytes of a step's payload.
 *
 * ONE LINE PER OP AND A TRAILING NEWLINE, which is what makes the format append-
 * friendly and diffable and is the same shape the engine writes its banks and its
 * book files in. The key order is the declaration's order because a file that
 * spelled one op two ways would be two files as far as anything comparing them is
 * concerned.
 */
export function formatOpsFile(ops: readonly BookOp[]): string {
  return ops.map((op) => JSON.stringify(op)).join('\n') + (ops.length === 0 ? '' : '\n');
}

/**
 * The bytes back → ops, or a refusal naming the line and the field.
 *
 * ONE BAD LINE TAKES THE WHOLE FILE DOWN, on `parseBookFile`'s argument and for a
 * sharper version of its reason. This file is the record of decisions somebody
 * made about their book; a list assembled out of the lines that happened to parse
 * is a book with somebody's strikes silently missing from it, and they would go on
 * editing a document that is not the one their history says they made. A sentence
 * naming the line costs a reload.
 *
 * Blank lines are skipped rather than refused: they are whitespace in a
 * line-oriented format, and the engine's own parsers skip them too.
 */
export function parseOpsFile(text: string): BookOp[] {
  const ops: BookOp[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    ops.push(opOf(line, index + 1));
  }
  return ops;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or null. Ids, categories, op words. */
function nameOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A whole number at or above `least`, or null.
 *
 * OFFSETS AND LENGTHS ARE COUNTED IN CHARACTERS, so a fractional one addresses
 * nothing and a negative one addresses the wrong end. `least` differs by field
 * and each caller says which: a `link` may start at character zero (a note whose
 * number opens the paragraph), a `split` may not cut at zero (see `SplitOp`), and
 * a marker of zero characters cannot be drawn, clicked or struck — which is
 * `refOf`'s own rule, one document down in shared/book.ts.
 */
function offsetOf(value: unknown, least: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= least ? value : null;
}

/**
 * The block a change is about, or the refusal for a change that names none.
 *
 * `id` IS THE ONE FIELD ALMOST EVERY OP SHARES, and the two that do not — `link`,
 * which names a body block and a note, and `chapter`, whose verb IS its field —
 * are exactly the two that name something other than a single block. Which is why
 * this is a helper called by the cases that want it rather than a test run before
 * the switch: a `chapter` op refused for having no `id` would be refused for not
 * being the shape it is.
 */
function idOf(row: Record<string, unknown>, where: string): string {
  const id = nameOf(row['id']);
  if (id === null) {
    throw new BookOpsError(`${where} names no block, and a block's name is the whole of what a change is about.`);
  }
  return id;
}

/** The verbs a `chapter` op may speak, and it speaks exactly one of them. */
const CHAPTER_VERBS = ['set', 'remove', 'rename', 'move', 'reset'] as const;

/**
 * One `chapter` line, verb by verb.
 *
 * EXACTLY ONE VERB FIELD, PROVEN HERE. The shape is a union discriminated by
 * which field is present (`ChapterOp`), so a line carrying two of them is not one
 * of the five shapes — it is a line that says the book divides above one block and
 * that a division somewhere else is being deleted, in one change, and there is no
 * order in which to do those that is more right than the other. A line carrying
 * none of them says nothing about the divisions at all.
 */
function chapterOpOf(row: Record<string, unknown>, where: string): ChapterOp {
  const said = CHAPTER_VERBS.filter((verb) => row[verb] !== undefined);
  if (said.length === 0) {
    throw new BookOpsError(
      `${where} is a change to where this book divides and does not say which change: a division may `
      + 'be set, removed, renamed, moved, or the whole list given back to the reading.',
    );
  }
  if (said.length > 1) {
    throw new BookOpsError(
      `${where} says ${said.length} things about where this book divides at once (${said.join(', ')}), `
      + 'and one change is one decision.',
    );
  }
  /*
   * THE TITLE MAY BE EMPTY AND `nameOf` IS DELIBERATELY NOT USED FOR IT. The book
   * file's own parser accepts an empty chapter title (shared/book.ts, `headerOf`),
   * and a division with no words over it is a rule across the page — which is a
   * real typographic decision and one a person can make with a chapter line.
   */
  const title = row['title'];
  switch (said[0]) {
    case 'set': {
      const set = nameOf(row['set']);
      if (set === null) throw new BookOpsError(`${where} divides this book above nothing.`);
      if (typeof title !== 'string') {
        throw new BookOpsError(`${where} calls the division above "${set}" something that is not words.`);
      }
      return { op: 'chapter', set, title };
    }
    case 'remove': {
      const remove = nameOf(row['remove']);
      if (remove === null) throw new BookOpsError(`${where} removes a division from above nothing.`);
      return { op: 'chapter', remove };
    }
    case 'rename': {
      const rename = nameOf(row['rename']);
      if (rename === null) throw new BookOpsError(`${where} renames a division above nothing.`);
      if (typeof title !== 'string') {
        throw new BookOpsError(`${where} renames the division above "${rename}" to something that is not words.`);
      }
      return { op: 'chapter', rename, title };
    }
    case 'move': {
      const move = nameOf(row['move']);
      if (move === null) throw new BookOpsError(`${where} moves a division from above nothing.`);
      const to = nameOf(row['to']);
      if (to === null) {
        throw new BookOpsError(`${where} moves the division above "${move}" to nowhere.`);
      }
      if (to === move) {
        throw new BookOpsError(`${where} moves the division above "${move}" to where it already is.`);
      }
      return { op: 'chapter', move, to };
    }
    default: {
      if (row['reset'] !== true) {
        throw new BookOpsError(
          `${where} gives this book's divisions back to the reading and says so with something other `
          + 'than yes, which is a change that changes nothing.',
        );
      }
      return { op: 'chapter', reset: true };
    }
  }
}

/** One line, field by field. `at` is its line number, for a line with no op word. */
function opOf(line: string, at: number): BookOp {
  const where = `change ${at} in this book's history`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new BookOpsError(`${where} is not JSON (${(err as Error).message}).`);
  }
  const row = objectOf(parsed);
  if (row === null) throw new BookOpsError(`${where} is not an object, so it is not a change.`);

  const kind = nameOf(row['op']);
  if (kind === null) {
    throw new BookOpsError(`${where} does not say what kind of change it is.`);
  }
  if (!(PERFORMED as readonly string[]).includes(kind)) refuseUnknownOp(kind, where);

  switch (kind) {
    case 'strike':
      return { op: 'strike', id: idOf(row, where) };
    case 'restore':
      return { op: 'restore', id: idOf(row, where) };
    case 'restore-furniture':
      return { op: 'restore-furniture', id: idOf(row, where) };
    case 'category': {
      const id = idOf(row, where);
      const category = nameOf(row['category']);
      if (category === null) {
        throw new BookOpsError(`${where} relabels "${id}" as nothing, and every block is some kind of block.`);
      }
      return { op: 'category', id, category };
    }
    case 'merge': {
      const id = idOf(row, where);
      const into = nameOf(row['into']);
      if (into === null) {
        throw new BookOpsError(`${where} absorbs "${id}" into nothing, and a join is two blocks or it is not one.`);
      }
      if (into === id) {
        throw new BookOpsError(`${where} absorbs "${id}" into itself, and a block cannot swallow its own words.`);
      }
      return { op: 'merge', id, into };
    }
    case 'split': {
      const id = idOf(row, where);
      /*
       * AT LEAST ONE, AND NO UPPER BOUND HERE. A cut at zero puts nothing on one
       * side of it, which is a decision nobody can act on; that much is a fact
       * about the number itself and belongs where the number is read. How long
       * the block's text is at the moment this op lands is not — earlier ops in
       * the same chain may have retyped it, merged into it or split it already —
       * so the upper bound is the replay's to check, and it reports it into
       * `missing` rather than refusing the file.
       */
      const cut = offsetOf(row['at'], 1);
      if (cut === null) {
        throw new BookOpsError(
          `${where} cuts "${id}" somewhere that is not a whole number of characters into it.`,
        );
      }
      return { op: 'split', id, at: cut };
    }
    case 'move': {
      const id = idOf(row, where);
      const before = nameOf(row['before']);
      if (before === null) {
        throw new BookOpsError(`${where} moves "${id}" to before nothing.`);
      }
      if (before === id) {
        throw new BookOpsError(`${where} moves "${id}" to before itself, which is where it already is.`);
      }
      return { op: 'move', id, before };
    }
    case 'chapter':
      return chapterOpOf(row, where);
    case 'link': {
      const block = nameOf(row['block']);
      if (block === null) {
        throw new BookOpsError(`${where} binds a reference number that is printed in no block.`);
      }
      const note = nameOf(row['note']);
      if (note === null) {
        throw new BookOpsError(`${where} binds a reference number in "${block}" to no note.`);
      }
      // Character zero is a legal place for a marker; zero characters is not a
      // marker. `refOf` in shared/book.ts owns that argument and this is its
      // other half, on the op that mints one by hand.
      const from = offsetOf(row['at'], 0);
      const len = offsetOf(row['len'], 1);
      if (from === null || len === null) {
        throw new BookOpsError(
          `${where} does not say which characters of "${block}" the reference number is.`,
        );
      }
      return { op: 'link', block, at: from, len, note };
    }
    default: {
      /*
       * AN EMPTY STRING IS A LEGAL TEXT and `nameOf` is deliberately not used
       * here. Somebody who selected a paragraph and deleted its words has said
       * something — an empty block is a block with nothing in it, which the
       * workbench draws and the edition keeps — and refusing it would make the
       * one edit nobody can undo by typing into the only edit this format cannot
       * record.
       */
      const id = idOf(row, where);
      const words = row['text'];
      if (typeof words !== 'string') {
        throw new BookOpsError(`${where} puts something that is not words into "${id}".`);
      }
      return { op: 'text', id, text: words };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One block after the chain — the file's row, plus what the ops made of it.
 *
 * A ROW AND NOT A WRAPPER, so that everything already written against `BookRow`
 * (the pane's `Line`, the export's projection) goes on working and reads the
 * derived state as one extra field. The rows a chain never named are the very
 * objects the parser produced, untouched, which is what keeps a replay over a
 * four-hundred-page book with six ops in it from allocating a second book.
 *
 * ── `parts` ON A RESTRUCTURED ROW IS STALE BY CONSTRUCTION ──────────────────
 *
 * `BookPart.chars` claims a half-open range into the row's own text and the parts
 * of a row TILE it (shared/book.ts) — which stops being true the moment a merge
 * concatenates two texts or a split cuts one in half. Nothing is repaired here,
 * and that is deliberate: `parts` is the record of WHICH BANKED ANSWER CONTRIBUTED
 * WHICH CHARACTERS, and after a person has joined two paragraphs by hand the true
 * answer involves the separator this replay inserted and the second block's own
 * parts re-based — which is a book file's worth of bookkeeping and belongs where
 * the derived book file is written (docs/RENDERER.md §4, and §9's R5). Until then
 * `parts`, `box` and `page` on a restructured row are PRESENTATION STATE that
 * nothing after the restructuring consults: the marker re-derivation deliberately
 * has no page to ask (see `rebind`), and the renderer draws text.
 */
export interface ReplayedRow extends BookRow {
  /**
   * Struck: in the document, drawn cancelled, absent from the edition.
   *
   * Only ever `true` — an unstruck row simply does not carry the field, which is
   * `LedgerStep.stale`'s rule and for its reason: a boolean that is only ever one
   * value says what it means where it is read, and leaves the ordinary case
   * looking ordinary.
   */
  struck?: true;
}

/** An op the replay could not perform — reported, never guessed at. */
export interface MissingOp {
  /** The op itself, so a surface can say what was being asked. */
  op: BookOp;
  /**
   * The block it named that the answer is about.
   *
   * FOR AN OP THAT NAMES TWO, IT IS THE ONE THAT IS WRONG — the absent half of a
   * merge, the note a `link` could not find — because a surface listing these has
   * one line to say what happened and the useful half is the one that failed. When
   * both halves are absent it is the first named, and when neither is absent and
   * the op is refused for what it asks rather than for what it names, it is the
   * block the op is about.
   */
  id: string;
  /**
   * Why, for an op that named blocks this book HOLDS and still could not be
   * performed.
   *
   * ABSENT FOR THE ORDINARY CASE, which is an op naming a block that is not there
   * — a surface already has the whole sentence for that one and does not need it
   * written out per op. It is present for the decisions this replay refuses on
   * their merits: a cut that would leave one half empty, a second reference number
   * on characters another already claims, a division asked to move from above a
   * block that has none. Those are not stale ids and a surface saying "this book
   * has no block called that" about one would be lying.
   */
  why?: string;
}

/** The book after a chain: the rows, the divisions, what could not be done, what came loose. */
export interface Replayed {
  rows: ReplayedRow[];
  /**
   * Ops this replay could not perform.
   *
   * REPORTED, NEVER GUESSED AT, and never fatal to the rest of the replay
   * (docs/RENDERER.md §3). The state it describes is real and recoverable: a bank
   * read again mints ids for blocks the model answered differently, so a chain
   * from before can name paragraphs that are genuinely not there any more. The
   * honest answer is to replay everything that still lands and to say plainly that
   * some of it did not — a replay that refused would make the whole book
   * unopenable over one stale strike, and one that silently dropped them would let
   * somebody go on editing while their history quietly stopped applying.
   *
   * THE STRUCTURE OPS WIDENED IT from "named a block this book does not hold" to
   * "could not be performed", for that same argument taken one step. A chain can
   * now name a block that its own earlier ops consumed, ask for a cut at an offset
   * a later text edit put past the end, or bind a second reference number onto
   * characters that already carry one. Every one of those is a decision that
   * cannot be carried out over THIS book; none of them is a reason to refuse to
   * draw the book. See `why`.
   */
  missing: MissingOp[];
  /**
   * The apparatus that does not join up, after the edits — the file's own record
   * with every edited block's share of it re-derived.
   *
   * The two LINKING flags are the only flags this app keeps (docs/RENDERER.md §0,
   * ruling 7), and a text edit is the one gesture that can create either of them:
   * delete a reference number and its note is pointed at by nothing; type one that
   * matches no note and it is a number carrying nothing. A merge and a split are
   * text edits for this purpose exactly (see `rebind`), and `link` is the gesture
   * that takes one back off the list by hand.
   */
  loose: BookLoose;
  /**
   * Where the book divides, after the chain — the list a renderer draws rules
   * from, and the one an export builds its table of contents out of.
   *
   * ── OWNERSHIP, AND WHY THIS IS OUTPUT RATHER THAN A FILE ────────────────
   *
   * *"Ownership is by ops exactly as today's confirmed-list rule: the first
   * chapter op takes the list over; 'Use Foundry's' is an op that returns it."*
   * (docs/RENDERER.md §2.) The engine's detected starts ride in as the SEED — the
   * `chapters` argument below — and a chain with no chapter op in it hands the
   * seed straight back. The first chapter op takes the list over for the rest of
   * the chain, and `reset` hands it back. There is no second file and no
   * confirmed flag: which one is in force is a fact about the chain, recomputed
   * every replay, and therefore cannot drift.
   *
   * ── FILTERED TO WHAT IS DRAWABLE ────────────────────────────────────────
   *
   * A division sits ABOVE A BLOCK, so a division above a block that is not in the
   * flow is not a thing anybody can draw — and the structure ops make that
   * reachable in two ordinary ways: a merge consumes the block a chapter started
   * at, and a shelved row was never in the flow to begin with. Those entries are
   * dropped from this list rather than reported into `missing`, because NOTHING
   * NAMED THEM: the op that orphaned the division named a different block, and
   * filing a failure against an op that did exactly what it was asked would put a
   * line in the margin that no gesture can clear. The list is in flow order, which
   * a `move` can change without any chapter op being involved at all.
   */
  chapters: BookChapter[];
}

/** Nothing unlinked — the answer for a book whose header said so and whose ops changed no text. */
const NOTHING_LOOSE: BookLoose = { markers: [], notes: [] };

/**
 * The book, with a chain of ops replayed over it.
 *
 * ── Two paths, one answer ───────────────────────────────────────────────────
 *
 * A chain with no structural op in it is FOLDED (`fold`): the state ops are
 * collapsed into a per-id state — struck or not, the newest text, the newest
 * category — and the rows are rebuilt from that once, so a chain of six strikes
 * and five restores of one id costs exactly what one op costs. A chain with a
 * merge, a split, a move, a chapter, a link or a furniture restore anywhere in it
 * is INTERPRETED (`interpret`): applied op by op to a working list, because those
 * ops change which rows exist and in what order and a fold has no way to say that.
 *
 * The two paths agree field for field on every chain the fold can take, which is
 * the only property that makes having two of them legitimate. The guard is one
 * `some` over the chain and it is deliberately conservative: one structural op
 * anywhere sends the whole chain down the interpreting path, because the ops
 * before it are ops against the book the ops after it will restructure.
 */
export function replayOps(
  rows: readonly BookRow[],
  ops: readonly BookOp[],
  /**
   * The file's own record of unlinked apparatus (`BookHeader.loose`).
   *
   * IT IS AN INPUT BECAUSE IT IS STATE THE EDITS CHANGE. A marker the engine
   * could not match sits at an offset inside a block, exactly as a bound one
   * does, so an edit to that block invalidates it the same way — and a replay
   * that could not see it would either lose the flag or leave it pointing at
   * characters that have moved. Defaulted for a caller with nothing to say
   * (a test, a projection over rows alone), which is the honest answer for
   * "this book records no unlinked apparatus".
   */
  loose: BookLoose = NOTHING_LOOSE,
  /**
   * The engine's detected chapter starts (`BookHeader.chapters`) — the SEED.
   *
   * IT RIDES IN FOR `loose`'s REASON, one argument down: it is state the ops
   * change, it is carried by the header rather than by the rows, and a replay
   * that could not see it could not implement the ownership rule at all. Empty is
   * the honest default for a caller with nothing to say, and it is also the
   * truthful answer for a book the engine found no divisions in.
   */
  chapters: readonly BookChapter[] = [],
): Replayed {
  return ops.some((op) => STRUCTURAL.has(op.op))
    ? interpret(rows, ops, loose, chapters)
    : fold(rows, ops, loose, chapters);
}

/**
 * THE FAST PATH — the four state ops, collapsed.
 *
 * ── The order of operations, and why it is one pass and not four ────────────
 *
 * The ops are folded into a per-id STATE first — struck or not, the newest text,
 * the newest category — and the rows are rebuilt from that state once. That is
 * what makes "last op wins" true by construction rather than by a rule somebody
 * has to remember: a fold has no history, so a chain of six strikes and five
 * restores of one id is exactly as expensive and exactly as correct as one op.
 *
 * ── And then, only for the blocks somebody actually retyped, the markers ────
 *
 * A text edit invalidates every `BookRef` offset into that block, and shifting
 * them would be a guess about which side of the edit a marker fell on. So the
 * edited blocks — and ONLY the edited blocks — are re-scanned for superscript
 * runs and rebound to the notes whose original refs named them, by printed
 * number, claim-once, in reading order (`rebind` below). Every untouched block
 * keeps the file's refs verbatim, which matters more than it looks: those offsets
 * were resolved by the engine with the page in front of it, and re-deriving them
 * everywhere would quietly replace the engine's answer with this one.
 */
function fold(
  rows: readonly BookRow[],
  ops: readonly BookOp[],
  loose: BookLoose,
  chapters: readonly BookChapter[],
): Replayed {
  const held = new Map(rows.map((row) => [row.id, row] as const));
  const struck = new Set<string>();
  const texts = new Map<string, string>();
  const categories = new Map<string, string>();
  const missing: MissingOp[] = [];

  for (const op of ops) {
    /*
     * KEYED BY `id` ALONE, and the guard in `replayOps` is what makes the cast
     * sound: this function is only ever reached for a chain with no structural op
     * in it, so every op here is one of the four, and every one of the four names
     * exactly one block. The ops that name two are all on the other path.
     */
    const id = (op as StrikeOp | RestoreOp | TextOp | CategoryOp).id;
    if (!held.has(id)) {
      missing.push({ op, id });
      continue;
    }
    /*
     * NO `default`, and the guard above is why there is nothing for one to do:
     * every op word that reaches this line is one of the four, so a fall-through
     * is unreachable and a branch written for it would be a branch nothing can
     * ever prove.
     */
    switch (op.op) {
      case 'strike': struck.add(id); break;
      case 'restore': struck.delete(id); break;
      case 'text': texts.set(id, op.text); break;
      case 'category': categories.set(id, op.category); break;
    }
  }

  /*
   * WHICH BLOCKS WERE GENUINELY RETYPED, which is not the same as which blocks a
   * `text` op named. A chain that set a block's words and then set them back is a
   * chain that changed nothing about that block, and re-deriving its markers would
   * throw away the engine's own offsets in exchange for this file's guess at them
   * — for an edit that never happened.
   */
  const edited = new Set<string>();
  for (const [id, text] of texts) {
    if (held.get(id)!.text !== text) edited.add(id);
  }

  const replayed = new Map<string, ReplayedRow>();
  const out: ReplayedRow[] = [];
  for (const row of rows) {
    const text = texts.get(row.id);
    const category = categories.get(row.id);
    const cancelled = struck.has(row.id);
    const made: ReplayedRow = text === undefined && category === undefined && !cancelled
      ? row
      : {
        ...row,
        ...(text === undefined ? {} : { text }),
        ...(category === undefined ? {} : { category }),
        ...(cancelled ? { struck: true as const } : {}),
      };
    replayed.set(row.id, made);
    out.push(made);
  }

  const drawn = drawableChapters(chapters, out);
  if (edited.size === 0) return { rows: out, missing, loose, chapters: drawn };
  const claims = claimsOn(edited, new Map(), out);
  return { ...rebind(out, replayed, edited, claims, loose), missing, chapters: drawn };
}

/**
 * THE SLOW PATH — every op, in the order the person made them, over a working
 * list of rows.
 *
 * ── Why this is an interpretation and not a bigger fold ─────────────────────
 *
 * See the module header. Once `merge` exists, "the last op naming this id wins"
 * has no meaning for an id an earlier op took out of the book, and once `split`
 * exists there are ids in the chain that no row in the FILE ever had. Both are
 * questions about the book AS THE OPS BEFORE THIS ONE LEFT IT, which is what an
 * interpretation is and what a fold cannot be.
 *
 * ── The rules each op is held to, argued where each one is applied ──────────
 *
 * Three of them are general enough to state once, here:
 *
 * IDS ARE CONSUMED AND NEVER COLLIDE. A merge consumes `id`; a split consumes its
 * parent. A later op naming a consumed id goes to `missing`, exactly as an op
 * naming a block a re-read no longer has does — from the chain's point of view
 * those are the same fact, which is that the book does not hold that block. Two
 * splits of one parent in one chain therefore land the second in `missing`: the
 * parent is gone and its halves are what exist, and guessing which half was meant
 * is precisely the guess `missing` exists instead of.
 *
 * THE STRUCTURE OPS WORK ON THE FLOW, AND THE SHELF IS NOT IN IT. A shelved row
 * sits in the file at its reading-order position wearing a sentence about why it
 * is out of the book (docs/BOOK-FILE.md §5), and merging into one, splitting one,
 * moving one or binding a reference number inside one are all gestures against a
 * block that is not in the document. They go to `missing`. `restore-furniture` is
 * the one op that names a shelved row on purpose, and after it the row is in the
 * flow for every later op in the chain. The four state ops are deliberately NOT
 * held to this: striking a shelved running head is a decision about a row of the
 * document and it is what the fold path already does, and the two paths have to
 * agree.
 *
 * A ROW THIS REPLAY HAS ALREADY COPIED IS MUTATED IN PLACE. The rows a chain
 * never names are the very objects the parser produced — the property that keeps
 * a replay over a four-hundred-page book from allocating a second book — so the
 * first op to touch a row replaces it with a copy, and every op after that writes
 * into the copy. Nothing outside this function ever sees a row mid-chain.
 */
function interpret(
  rows: readonly BookRow[],
  ops: readonly BookOp[],
  loose: BookLoose,
  chapters: readonly BookChapter[],
): Replayed {
  const flow: ReplayedRow[] = [...rows];
  const held = new Map<string, ReplayedRow>(rows.map((row) => [row.id, row] as const));
  /** The file's own words for each id, for the did-this-edit-change-anything test. */
  const original = new Map(rows.map((row) => [row.id, row.text] as const));
  /** id → its index in `flow`. Rebuilt whenever the list's shape changes. */
  let at = new Map<string, number>(rows.map((row, index) => [row.id, index] as const));
  /** The ids whose current row object belongs to this replay and may be written to. */
  const mine = new Set<string>();
  const missing: MissingOp[] = [];

  /** Ids a `text` op named, whether or not it changed the words. */
  const retyped = new Set<string>();
  /** Ids a merge or a split made or remade. Their markers are re-derived regardless. */
  const restructured = new Set<string>();
  /**
   * WHOSE REFS COUNT AS A CLAIM ON WHICH ROW — deviations from identity only.
   *
   * A note's `refs` name the block its number was printed in, and that name is the
   * FILE's. After a merge the two names b7-6 and b8-1 both mean the one row b7-6;
   * after a split the one name b2-3 means both b2-3/1 and b2-3/2. `rebind` matches
   * runs to notes by asking which notes named this block, so it has to be told
   * that inheritance or a merged row would rebind nothing and a split would rebind
   * both halves to the parent's first note.
   */
  const sources = new Map<string, Set<string>>();

  let markers = [...loose.markers];
  const orphans = new Set(loose.notes);

  let divisions: BookChapter[] = [...chapters];
  /** False while the engine's seed is in force — see `Replayed.chapters`. */
  let ownsDivisions = false;

  const reindex = (): void => {
    at = new Map(flow.map((row, index) => [row.id, index] as const));
  };
  const sourcesOf = (id: string): Set<string> => sources.get(id) ?? new Set([id]);
  /** The row for `id`, copied first if this replay does not already own it. */
  const mutable = (id: string): ReplayedRow => {
    const row = held.get(id)!;
    if (mine.has(id)) return row;
    const copy: ReplayedRow = { ...row };
    mine.add(id);
    held.set(id, copy);
    flow[at.get(id)!] = copy;
    return copy;
  };
  /** The first of these the book does not hold IN THE FLOW, or null. */
  const notInFlow = (...ids: readonly string[]): string | null => {
    for (const id of ids) {
      const row = held.get(id);
      if (row === undefined || row.shelf !== undefined) return id;
    }
    return null;
  };
  const absent = (op: BookOp, id: string): void => { missing.push({ op, id }); };
  const refused = (op: BookOp, id: string, why: string): void => { missing.push({ op, id, why }); };

  for (const op of ops) {
    switch (op.op) {
      case 'strike':
      case 'restore':
      case 'text':
      case 'category': {
        if (!held.has(op.id)) { absent(op, op.id); break; }
        const row = mutable(op.id);
        if (op.op === 'strike') row.struck = true;
        else if (op.op === 'restore') delete row.struck;
        else if (op.op === 'category') row.category = op.category;
        else {
          row.text = op.text;
          retyped.add(op.id);
        }
        break;
      }

      case 'merge': {
        const gone = notInFlow(op.into, op.id);
        if (gone !== null) { absent(op, gone); break; }
        const keeper = held.get(op.into)!;
        const eaten = held.get(op.id)!;
        /*
         * A NOTE IS NOT JOINED TO ANYTHING BY THIS GRAMMAR. Footnotes are complete
         * on their page (docs/RENDERER.md §0, ruling 4) and the engine cut the
         * page's footnote area into rows by the numbers the page printed; a person
         * telling it that two of those rows are one note is telling it its note
         * splitter read the page wrong, which is a fact about the reading and not a
         * repair to the document. Joining a note INTO prose is worse: it puts
         * apparatus in the body and takes a reference number's target out of the
         * book in one gesture. Both go here, for `split`'s reason exactly.
         */
        if (keeper.category === 'Footnote' || eaten.category === 'Footnote') {
          const note = keeper.category === 'Footnote' ? op.into : op.id;
          refused(op, note, `"${note}" is a note, and a note is one piece of apparatus printed whole at `
            + 'the foot of its page. Joining one to anything is not a repair this program offers.');
          break;
        }
        const grown = mutable(op.into);
        /*
         * ONE SPACE BETWEEN THEM, which is the engine's own `space` join for a page
         * turn continuation (`bookParts`, src/vlm/book-file.ts) — and a seam IS a
         * page turn continuation, which is the whole reason this gesture exists.
         * NO HYPHEN FUSING: dehyphenation happened at reflow, on the raw column
         * text, with the broken word in front of it. Both of these texts are
         * finished prose, and a replay that went looking for a hyphen to fuse would
         * be re-running a decision the engine already made with better evidence.
         */
        grown.text = `${grown.text} ${eaten.text}`;
        /*
         * `into` KEEPS ITS GEOMETRY AND THE PAGES ARE UNIONED. The box and the page
         * are where this row STARTS and the join did not move its start; the page
         * list is what pages it touches and after the join it touches both blocks'.
         * Order-preserving and deduped so that a row joined across a turn reads
         * [7, 8] and one joined to a block on its own page still reads [7].
         * `parts` is `into`'s, unchanged and now stale — see `ReplayedRow`.
         */
        grown.pages = joinPages(grown.pages, eaten.pages);
        /*
         * `into`'s STATE WINS AND THE ABSORBED ROW'S IS IRRELEVANT. Striking a
         * paragraph and then joining it onto another does not strike the other one:
         * the strike was a decision about a row that no longer exists, and the row
         * that does exist has its own answer. Same for the category — a Quote that
         * swallows the Text continuing it over the leaf is still a Quote, and if it
         * is not, `category` is the op for saying so.
         */
        flow.splice(at.get(op.id)!, 1);
        held.delete(op.id);
        mine.delete(op.id);
        reindex();
        const inherited = sourcesOf(op.into);
        for (const src of sourcesOf(op.id)) inherited.add(src);
        sources.set(op.into, inherited);
        sources.delete(op.id);
        restructured.add(op.into);
        restructured.delete(op.id);
        retyped.delete(op.id);
        break;
      }

      case 'split': {
        const gone = notInFlow(op.id);
        if (gone !== null) { absent(op, gone); break; }
        const parent = held.get(op.id)!;
        /*
         * A NOTE IS ATOMIC APPARATUS. Cutting one in two makes two rows where the
         * page printed one piece of prose under one number, and the second of them
         * carries a number nothing printed. See the merge above for the other half
         * of the same argument.
         */
        if (parent.category === 'Footnote') {
          refused(op, op.id, `"${op.id}" is a note, and a note is one piece of apparatus printed whole `
            + 'at the foot of its page. Cutting one in two is not a repair this program offers.');
          break;
        }
        /*
         * THE CUT HAS TO LEAVE WORDS ON BOTH SIDES. An empty block is legal — a
         * `text` op can make one and the edition keeps it — but a SPLIT that mints
         * one is a decision nobody can act on: the person put a caret somewhere and
         * asked for two paragraphs, and what they would get is their paragraph and
         * a blank row under it. The parser proved the offset is at least one; this
         * is the half of the test that needs the text, and the text is whatever the
         * ops before this one left.
         */
        if (op.at >= parent.text.length) {
          refused(op, op.id, `"${op.id}" is ${parent.text.length} character(s) long and the cut falls at `
            + `${op.at}, which would leave one of the two halves with nothing in it.`);
          break;
        }
        const first = `${op.id}/1`;
        const second = `${op.id}/2`;
        /*
         * TWO BLOCKS OF ONE NAME IS THE FAILURE EVERY LATER CHANGE WOULD INHERIT —
         * shared/book.ts's own sentence, on the one gesture in this program that
         * mints a name. It cannot happen against a book the engine wrote (a `/n`
         * suffix is minted here and nowhere else) and it is checked anyway, because
         * a materialised derived book file carries the halves of yesterday's splits
         * as ordinary rows and nothing stops a person splitting a parent that a
         * chain from before already cut.
         */
        if (held.has(first) || held.has(second)) {
          refused(op, op.id, `cutting "${op.id}" in two would mint a name this book already has a block `
            + 'under, and two blocks of one name is the failure every later change would inherit.');
          break;
        }
        /*
         * THE HALVES INHERIT EVERYTHING BUT THE WORDS — struck, category, and the
         * geometry. A struck block cut in two is two struck halves: the person
         * cancelled those words and cutting them is not un-cancelling them, and the
         * alternative (halves that come back unstruck) would make `split` a way to
         * undo a strike without a `restore` in the history. The geometry is the
         * parent's on both, and `parts` with it, stale by construction — see
         * `ReplayedRow`. Nothing after this point consults either.
         */
        const one: ReplayedRow = { ...parent, id: first, text: parent.text.slice(0, op.at) };
        const other: ReplayedRow = { ...parent, id: second, text: parent.text.slice(op.at) };
        flow.splice(at.get(op.id)!, 1, one, other);
        held.delete(op.id);
        held.set(first, one);
        held.set(second, other);
        mine.delete(op.id);
        mine.add(first);
        mine.add(second);
        reindex();
        const inherited = sourcesOf(op.id);
        sources.set(first, new Set(inherited));
        sources.set(second, new Set(inherited));
        sources.delete(op.id);
        restructured.add(first);
        restructured.add(second);
        restructured.delete(op.id);
        retyped.delete(op.id);
        break;
      }

      case 'move': {
        const gone = notInFlow(op.id, op.before);
        if (gone !== null) { absent(op, gone); break; }
        /*
         * READING-ORDER REPAIR AND NOTHING ELSE. No text changes, so no marker is
         * re-derived and no ref is touched: a `BookRef` names a block by id and an
         * offset into its words, and neither of those is a position in the book.
         * A division above the moved block moves with it for the same reason —
         * `BookChapter` is keyed by id too, and `Replayed.chapters` is sorted by
         * where the block ended up.
         */
        const row = held.get(op.id)!;
        flow.splice(at.get(op.id)!, 1);
        flow.splice(flow.findIndex((one) => one.id === op.before), 0, row);
        reindex();
        break;
      }

      case 'restore-furniture': {
        const row = held.get(op.id);
        if (row === undefined) { absent(op, op.id); break; }
        if (row.shelf === undefined) {
          refused(op, op.id, `"${op.id}" is in the book already, so there is nothing about it to put back.`);
          break;
        }
        /*
         * IT IS ALREADY WHERE IT GOES. The shelf is interleaved rather than
         * appended precisely so that this op has no position to guess at: a shelved
         * row sits in the file between the flowing rows it was printed between
         * (`bookFile`, src/vlm/book-file.ts), and putting it back in the book means
         * clearing the two fields that say it is out of the book and nothing else.
         *
         * ITS WORDS ARE NOT SCANNED FOR REFERENCE NUMBERS. The engine never scanned
         * them either — shelved rows take no part in the marker match — and a
         * running head is furniture rather than apparatus. Restoring one puts words
         * back in the flow, not a note's number.
         */
        const back = mutable(op.id);
        delete back.shelf;
        delete back.why;
        break;
      }

      case 'link': {
        const gone = notInFlow(op.block);
        if (gone !== null) { absent(op, gone); break; }
        const note = held.get(op.note);
        if (note === undefined) { absent(op, op.note); break; }
        if (note.category !== 'Footnote') {
          refused(op, op.note, `"${op.note}" is not a note, and a reference number in the prose is `
            + 'printed to point at one.');
          break;
        }
        const block = held.get(op.block)!;
        if (op.at + op.len > block.text.length) {
          refused(op, op.block, `the reference number is bound past the end of the words in "${op.block}".`);
          break;
        }
        /*
         * AN OVERLAPPING LINK IS REPORTED RATHER THAN PERFORMED, and the distinction
         * from the rest of `missing` is worth stating: this op names two blocks the
         * book holds and an offset inside one of them that exists. What is wrong is
         * the DECISION. Two reference numbers claiming the same characters is the
         * one thing the book file's own parser refuses outright (shared/book.ts:
         * *"two reference numbers claim the same words"*), because the renderer cuts
         * each block's text at these offsets and would cut the same run twice — so
         * performing this would write a book that cannot be read back. Reporting it
         * costs the person one line in the margin; performing it costs them the file.
         */
        let claimed = false;
        for (const row of flow) {
          for (const ref of row.refs ?? []) {
            if (ref.block !== op.block) continue;
            if (op.at < ref.at + ref.len && ref.at < op.at + op.len) claimed = true;
          }
        }
        for (const marker of markers) {
          if (marker.block !== op.block) continue;
          // The marker this op exists to bind overlaps itself, which is not a clash.
          if (marker.at === op.at && marker.len === op.len) continue;
          if (op.at < marker.at + marker.len && marker.at < op.at + op.len) claimed = true;
        }
        if (claimed) {
          refused(op, op.block, `the reference number claims characters of "${op.block}" that another `
            + 'reference number already claims, and two numbers on the same words is a book that cannot '
            + 'be drawn.');
          break;
        }
        /*
         * BOTH FLAGS COME OFF AT ONCE, because a hand link is the gesture that
         * answers both of them with one decision: the number in the body stops
         * being a number nothing carries, and the note stops being a note nothing
         * points at. Appended rather than sorted into place — a note's `refs` are
         * in the order they were recorded and the newest is the one just made.
         */
        const bound = mutable(op.note);
        const ref: BookRef = { block: op.block, at: op.at, len: op.len };
        bound.refs = [...(bound.refs ?? []), ref];
        markers = markers.filter(
          (marker) => !(marker.block === op.block && marker.at === op.at && marker.len === op.len),
        );
        orphans.delete(op.note);
        break;
      }

      case 'chapter': {
        if ('reset' in op) {
          divisions = [...chapters];
          ownsDivisions = false;
          break;
        }
        // THE FIRST CHAPTER OP TAKES THE LIST OVER, from wherever it stands: the
        // engine's seed, or the seed again after a reset. Everything after it in the
        // chain edits the ops' list.
        if (!ownsDivisions) {
          divisions = [...chapters];
          ownsDivisions = true;
        }
        if ('set' in op) {
          const gone = notInFlow(op.set);
          if (gone !== null) { absent(op, gone); break; }
          const found = divisions.findIndex((one) => one.id === op.set);
          /*
           * SET IS ONE GESTURE WHETHER OR NOT ONE IS ALREADY THERE. A person
           * dropping a chapter line on a heading the engine happened to seed should
           * not meet a refusal for it, and "there is already a division here" is not
           * a fact they can be expected to hold. Retitling in place keeps `kind` —
           * it is the same division, and `kind` records how it was FOUND, which
           * renaming does not change (`BookChapter`, shared/book.ts).
           */
          if (found === -1) divisions.push({ id: op.set, title: op.title });
          else divisions[found] = { ...divisions[found]!, title: op.title };
          break;
        }
        if ('rename' in op) {
          const found = divisions.findIndex((one) => one.id === op.rename);
          if (found === -1) {
            refused(op, op.rename, `nothing divides this book above "${op.rename}", so there is no `
              + 'division there to call anything.');
            break;
          }
          divisions[found] = { ...divisions[found]!, title: op.title };
          break;
        }
        if ('remove' in op) {
          const found = divisions.findIndex((one) => one.id === op.remove);
          if (found === -1) {
            refused(op, op.remove, `nothing divides this book above "${op.remove}", so there is no `
              + 'division there to take away.');
            break;
          }
          divisions.splice(found, 1);
          break;
        }
        const gone = notInFlow(op.to);
        if (gone !== null) { absent(op, gone); break; }
        const found = divisions.findIndex((one) => one.id === op.move);
        if (found === -1) {
          refused(op, op.move, `nothing divides this book above "${op.move}", so there is no division `
            + 'there to move.');
          break;
        }
        if (divisions.some((one) => one.id === op.to)) {
          refused(op, op.to, `"${op.to}" already has a division above it, and one block divides the `
            + 'book once.');
          break;
        }
        /*
         * THE TITLE TRAVELS AND `kind` DOES NOT. `kind` says how the engine decided
         * this division, at the block it decided it at; carried to a block a person
         * chose, it would be the engine's evidence attached to somebody else's
         * decision. The title is the person's either way.
         */
        divisions[found] = { id: op.to, title: divisions[found]!.title };
        break;
      }
    }
  }

  /*
   * WHICH ROWS' MARKERS MUST BE RE-DERIVED, assembled at the end because the
   * question is about the chain's OUTCOME and not about any one op in it.
   *
   * A restructured row is in unconditionally: its words were composed by this
   * replay and every offset into them is this replay's to answer for. A retyped
   * row is in only if the words actually moved — a chain that set a block's text
   * and then set it back changed nothing about that block, and re-deriving its
   * markers would throw away the engine's own offsets for an edit that never
   * happened. That is the fold path's rule, restated over a working list; the
   * comparison is against the FILE's words, which is what the fold compares too.
   *
   * Both are filtered to ids the book still holds. An id a later merge consumed
   * has had its claims carried onto the row that ate it (`sources`), so nothing
   * is lost by dropping it here — and there is no row left to re-derive anything
   * for.
   */
  const edited = new Set<string>();
  for (const id of restructured) if (held.has(id)) edited.add(id);
  for (const id of retyped) {
    const row = held.get(id);
    if (row === undefined) continue;
    const was = original.get(id);
    if (was === undefined || row.text !== was) edited.add(id);
  }

  const drawn = drawableChapters(divisions, flow);
  const nowLoose: BookLoose = { markers, notes: [...orphans] };
  if (edited.size === 0) return { rows: flow, missing, loose: nowLoose, chapters: drawn };
  const claims = claimsOn(edited, sources, flow);
  return { ...rebind(flow, held, edited, claims, nowLoose), missing, chapters: drawn };
}

/** `into`'s pages then `id`'s, in order, each page once. */
function joinPages(one: readonly number[], other: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const page of [...one, ...other]) {
    if (seen.has(page)) continue;
    seen.add(page);
    out.push(page);
  }
  return out;
}

/**
 * The divisions that can actually be drawn, in reading order.
 *
 * See `Replayed.chapters` for the whole argument. Shelved rows are excluded along
 * with absent ones because a division above a block that is not in the flow is not
 * drawable either, and the two are the same fact from the renderer's side.
 */
function drawableChapters(
  list: readonly BookChapter[],
  rows: readonly ReplayedRow[],
): BookChapter[] {
  if (list.length === 0) return [];
  const order = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    if (row.shelf === undefined) order.set(row.id, index);
  }
  return list
    .filter((one) => order.has(one.id))
    .sort((one, other) => order.get(one.id)! - order.get(other.id)!);
}

/**
 * WHICH ROW EACH RECORDED REF NAME NOW MEANS — the inverse of `sources`.
 *
 * A note's `refs` name blocks as the FILE named them. `rebind` walks those refs
 * and has to know, for a given recorded name, which of today's rows it is a claim
 * on: itself for an ordinary text edit; the survivor for a name a merge consumed;
 * BOTH HALVES, in reading order, for a name a split cut in two. The order is what
 * makes a split divide its markers correctly — two notes whose numbers were
 * printed either side of the cut both claim both halves, and each one binds in the
 * half whose text still carries its number, first half first.
 *
 * Only the edited rows appear here. Every untouched block keeps the file's refs
 * verbatim, which is the property the whole re-derivation is arranged around.
 */
function claimsOn(
  edited: ReadonlySet<string>,
  sources: ReadonlyMap<string, ReadonlySet<string>>,
  rows: readonly ReplayedRow[],
): Map<string, string[]> {
  const order = new Map<string, number>();
  for (const [index, row] of rows.entries()) order.set(row.id, index);
  const claims = new Map<string, string[]>();
  const ids = [...edited].sort((one, other) => (order.get(one) ?? 0) - (order.get(other) ?? 0));
  for (const id of ids) {
    for (const src of sources.get(id) ?? [id]) {
      const already = claims.get(src);
      if (already === undefined) claims.set(src, [id]);
      else already.push(id);
    }
  }
  return claims;
}

/**
 * The reference numbers of the edited blocks, resolved again from the words.
 *
 * ── The rule, which is the engine's own with one thing taken away ───────────
 *
 * `linkMarkers` (src/vlm/book-file.ts) matches a marker to a note by the PRINTED
 * NUMBER, on the marker's page or the page after it, first marker in reading order
 * claiming the note. This has no page to ask — the block's `parts` stopped being a
 * true division of its text the moment somebody retyped it, or joined it to
 * another, or cut it in half — so the page test is replaced by something stricter
 * and better: the ONLY notes a run in this block may bind to are the notes that
 * already named this block, or named the block it was made out of. An edit cannot
 * invent a link that was not there; it can only keep one, or lose it.
 *
 * That is what makes the two flags honest. A run that matches none of those notes
 * is a number somebody typed or a number whose note the same edit renumbered, and
 * it goes in the margin as "no note carries this number". A note whose run is gone
 * from the block it named loses that ref, and a note left with no refs anywhere is
 * "nothing in the book carries this note". Both are the LINKING flags the app
 * keeps, arrived at from the gestures that can create them.
 *
 * ── A MERGE AND A SPLIT ARE TEXT EDITS FOR THIS PURPOSE EXACTLY ─────────────
 *
 * They compose new words at new offsets, which is the whole of what invalidates a
 * `BookRef`, so they go through this and not around it. What they add is that the
 * name a note recorded may no longer be the name of the row its number is printed
 * in: `claims` carries that inheritance (see `claimsOn`), and everything below
 * reads a recorded ref's block through it. A merged row therefore rebinds the
 * notes of BOTH the blocks it is made of, and a split's two halves divide the
 * parent's notes between them by where the numbers actually fell.
 *
 * A FOOTNOTE ROW IS NEVER SCANNED, which is the engine's rule (`markersIn`): a
 * superscript inside a note is the note's own number or a reference in its own
 * prose. An edited note row therefore finds no runs at all, and any reference that
 * had somehow been recorded inside one comes loose rather than being kept at an
 * offset the edit has moved.
 */
function rebind(
  out: ReplayedRow[],
  replayed: Map<string, ReplayedRow>,
  edited: ReadonlySet<string>,
  claims: ReadonlyMap<string, readonly string[]>,
  loose: BookLoose,
): { rows: ReplayedRow[]; loose: BookLoose } {
  /*
   * WHICH NOTES NAMED EACH EDITED BLOCK — taken off the rows as they stand before
   * anything below rewrites a `refs` list, and read through `claims` so that a note
   * which named a consumed block is a claimant of the row that consumed it. The
   * note's own printed number is read off its text, because renumbering a note is
   * an ordinary edit and the number on the page is what a marker matches.
   */
  const claimants = new Map<string, { id: string; printed: number | null }[]>();
  for (const row of out) {
    const counted = new Set<string>();
    for (const ref of row.refs ?? []) {
      for (const heir of claims.get(ref.block) ?? []) {
        // One note is one claimant of one row however many of its refs point there.
        if (counted.has(heir)) continue;
        counted.add(heir);
        const already = claimants.get(heir);
        const claimant = { id: row.id, printed: printedNoteNumber(row.text) };
        if (already === undefined) claimants.set(heir, [claimant]);
        else already.push(claimant);
      }
    }
  }

  /** The ref each note now has into each edited block, or nothing. */
  const bound = new Map<string, Map<string, BookRef>>();
  const markers = loose.markers.filter((marker) => !claims.has(marker.block));

  for (const id of edited) {
    const row = replayed.get(id)!;
    const notes = claimants.get(id) ?? [];
    const taken = new Set<string>();
    // The engine's own exclusion, restated: what a superscript inside a note row
    // means is the note's own number, and neither side links anything in one.
    const runs = row.category === 'Footnote' ? [] : superscriptRuns(row.text);
    for (const run of runs) {
      const note = notes.find((candidate) => candidate.printed === run.printed && !taken.has(candidate.id));
      if (note === undefined) {
        markers.push({ block: id, at: run.at, len: run.len, printed: run.printed });
        continue;
      }
      taken.add(note.id);
      const into = bound.get(note.id);
      const ref: BookRef = { block: id, at: run.at, len: run.len };
      if (into === undefined) bound.set(note.id, new Map([[id, ref]]));
      else into.set(id, ref);
    }
  }

  const orphans = new Set(loose.notes);
  for (const [at, row] of out.entries()) {
    const was = row.refs;
    if (was === undefined) continue;
    /*
     * SUBSTITUTED IN PLACE RATHER THAN REBUILT AND SORTED. Every ref into a block
     * nobody touched survives exactly where it was in the list, and a ref into an
     * edited block is replaced by whatever this note claimed in the row or rows
     * that block became — or by nothing. `done` is keyed by the ROW rather than by
     * the recorded name, which is what keeps a note that named both halves of a
     * merge from being handed the survivor's run twice.
     */
    const kept: BookRef[] = [];
    const done = new Set<string>();
    for (const ref of was) {
      const heirs = claims.get(ref.block);
      if (heirs === undefined) {
        kept.push(ref);
        continue;
      }
      for (const heir of heirs) {
        if (done.has(heir)) continue;
        done.add(heir);
        const now = bound.get(row.id)?.get(heir);
        if (now !== undefined) kept.push(now);
      }
    }
    if (kept.length === 0) orphans.add(row.id);
    if (kept.length === was.length && kept.every((ref, which) => ref === was[which])) continue;
    const rewritten: ReplayedRow = { ...row, refs: kept };
    out[at] = rewritten;
    replayed.set(row.id, rewritten);
  }

  return { rows: out, loose: { markers, notes: [...orphans] } };
}

/**
 * The ids of the notes that are struck, so a surface can grey their numbers.
 *
 * ── Derived, and emphatically not a second op ───────────────────────────────
 *
 * *"if i delete footnotes, it removes their corresponding reference numbers."*
 * (docs/RENDERER.md §0, ruling 9.) The number in the prose belongs to the note,
 * so striking the note strikes its numbers — and restoring it brings them back —
 * as a FACT COMPUTED FROM THE REPLAYED ROWS rather than as a second op recorded
 * beside the first (§2). An op per marker would be two records of one decision,
 * and the day they disagreed the book would have a number for a note that is not
 * there.
 *
 * It is a set of NOTE ids and not of markers, because the pane already inverts
 * `refs` into a map of the markers printed in each block (`printed`, the book
 * pane): every marker element it draws already knows which note it belongs to, so
 * the cheapest possible answer here is the one it can test with a single lookup.
 */
export function struckNotes(rows: readonly ReplayedRow[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.struck === true && row.note !== undefined) out.add(row.id);
  }
  return out;
}

/**
 * How many decisions stand between a recorded list and a working one — the
 * count every "you have unapplied changes" surface shows.
 *
 * MEASURED PAST THE SHARED PREFIX, BY IDENTITY. The working stack begins life
 * as a copy of the recorded list, so its untouched head is the very same op
 * objects and identity is the honest test; an undo below the recorded boundary
 * shortens the working list, and that removal is as much a thing to write down
 * as a new strike is, which is why both tails count. Shared between the pane's
 * tray and the closing question (tabs.service), because two counts of one fact
 * is how a dialog comes to disagree with the button that opened it.
 */
export function unwritten(landed: readonly BookOp[], pending: readonly BookOp[]): number {
  let shared = 0;
  while (shared < landed.length && shared < pending.length
    && landed[shared] === pending[shared]) shared += 1;
  return (landed.length - shared) + (pending.length - shared);
}

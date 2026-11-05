/**
 * book-view.layout — how the sheet is laid out and what it can offer: room for two sheets, heading sizes, plates, and the states it says out loud.
 */
import { computed, signal } from '@angular/core';
import type { BookRow } from '@owen/foundry-core/shared/book';
import { struckNotes } from '@owen/foundry-core/shared/ops';
import { Line, ALIGNED_MIN_REM } from './book-view.model';
import { sizeOf, cut } from './book-view.lines';
import * as sheets from './book-view.sheets';
import * as bench from './book-view.bench';
import type { BookViewComponent } from './book-view.component';

/** True when two sheets fit — `ALIGNED_MIN_REM`, against the measured pane. */
export function roomy(this: BookViewComponent) {
  return computed(() => {
  const rem = this.rem();
  return rem > 0 && this.wide() >= ALIGNED_MIN_REM * rem;
});
}

/**
 * Why the aligned view cannot be had right now, or null when it can.
 *
 * ONE SENTENCE, TWO DOORS: the pointer that pauses on the segment gets it as a
 * title, and a press gets it on the window's notice strip. The control is only
 * on screen at all where there IS a translation, so "this book is not a
 * translation" is not one of the answers here — it is the absence of the
 * control, which is the plainest statement of it available.
 */
export function alignRefusal(this: BookViewComponent) {
  return computed<string | null>(() => {
  if (this.edition()) {
    return 'The final version is the finished book, and a finished book has one column. Press Workbench '
      + 'and the source can stand beside these words.';
  }
  if (!this.roomy()) {
    return 'There is not room here for two columns of book. Widen the window and the source can '
      + `stand beside the ${this.pass()}.`;
  }
  return null;
});
}

/**
 * THE AGREED ANSWER — two columns, or one.
 *
 * Derived rather than stored, so that narrowing the window takes the second
 * column away and widening it brings the same one back without a state anywhere
 * that has to be corrected on the way. Switching to the edition is the one
 * transition that changes what was ASKED FOR (`show` puts the alignment back to
 * alone), because the edition is not a place a person was reading a pair in.
 */
export function aligned(this: BookViewComponent) {
  return computed(() =>
  this.alignment() === 'aligned'
  && this.translation() !== null
  && this.roomy()
  && !this.edition());
}

/**
 * The id under the pointer in EITHER column, lighting its twin in the other.
 *
 * A signal of its own and not a mode of `lit`. `lit` is a NOTE and its printed
 * numbers — one fact about apparatus, drawn in the sienna the apparatus wears —
 * and this is one block and the same block on the other sheet. Two questions,
 * two answers, and a marker hover must not tint a paragraph across the gap.
 */
export function twinned(this: BookViewComponent) {
  return signal<string | null>(null);
}

/**
 * How many recorded changes named blocks this book no longer has.
 *
 * THE ONES WITH NO `why`, which is the ordinary case: a bank read again mints
 * ids for blocks the model answered differently, so a chain from before can name
 * paragraphs that are genuinely not there. One sentence covers all of them and
 * they are counted rather than listed.
 */
export function stranded(this: BookViewComponent) {
  return computed(
  () => this.view()?.missing.filter((one) => one.why === undefined).length ?? 0);
}

/**
 * And the ones the replay refused ON THEIR MERITS, each in the replay's own
 * words.
 *
 * These named blocks this book HOLDS and still could not be performed — a cut
 * that would leave one half empty, a reference number bound onto words another
 * already claims. There is no count that says any of that, so each carries its
 * sentence up whole rather than being tallied with the stale ones.
 */
export function refused(this: BookViewComponent) {
  return computed<string[]>(() =>
  (this.view()?.missing ?? []).flatMap((one) => (one.why === undefined ? [] : [one.why])));
}

/** The notes whose numbers are cancelled with them — derived, never an op (§2). */
export function struckNotesField(this: BookViewComponent) {
  return computed<ReadonlySet<string>>(() => {
  const replayed = this.view();
  return replayed === null ? new Set<string>() : struckNotes(replayed.rows);
});
}

/** The sentence saying why there is no source to set beside these words, or null. */
export function sourceProblem(this: BookViewComponent) {
  return computed<string | null>(() => {
  const source = this.book()?.translation?.source ?? null;
  return source === null || source.ok ? null : source.reason;
});
}

/** The list on the paper: the bench's book, or the edition's. */
export function sheetLines(this: BookViewComponent) {
  return computed<Line[]>(
  () => (this.edition() ? this.editionLines() : this.lines()));
}

/**
 * The size a division's own heading is set at, when the edition draws one.
 *
 * THE TITLE RATIO, because that is what the cast sets a chapter opening in: the
 * emitter writes the opener as `<h1 data-bf-cat="chapter">` and the sheet's own
 * `h1` rule is the measured `Title` size (or 1.5em, the base sheet's). A
 * division the Chapters panel put above a paragraph has no heading in the book
 * to take a size from, and this is the size the heading it is standing in for
 * would have had.
 */
export function headingSize(this: BookViewComponent) {
  return computed<number>(() => {
  const book = this.book();
  return book === null ? 1.5 : sizeOf(book, 'Title');
});
}

/**
 * The URL a Picture row's crop is served at, or null — for a row that names
 * no image (no PDF was given to the reflow) or a book main minted no door
 * for. Composed and never fetched: the allow-list behind the prefix is
 * main's (`bookFigureFile`), and a URL this pane got wrong is a 403 there.
 */
export function plate(this: BookViewComponent, row: BookRow): string | null {
  const figures = this.book()?.figures ?? null;
  return figures !== null && row.image !== undefined
    ? figures + encodeURIComponent(row.image)
    : null;
}

/** True while a hovered page ghost names a page this block sits on. */
export function spans(this: BookViewComponent, line: Line): boolean {
  const page = this.ghosted();
  return page !== null && line.row.pages.includes(page);
}

/** Light a note and its markers together, or put them all out. */
export function light(this: BookViewComponent, noteId: string | null): void {
  this.lit.set(noteId);
}

/**
 * A note row under the pointer lights its own markers. Anything else lights
 * nothing.
 *
 * THE GLANCE IS NO LONGER ARMED HERE, and that is Wave 30 in one line. This
 * used to start a 180 ms rest timer, because a hover trigger has to tell a
 * pointer that stopped from one that swept past. The trigger is a click now
 * (`release`), so a pointer crossing this block does exactly what it looks
 * like it does: it lights a note and nothing else.
 */
export function lightRow(this: BookViewComponent, line: Line): void {
  this.lit.set(line.ordinal === null ? null : line.row.id);
  this.twin(line.row.id);
}

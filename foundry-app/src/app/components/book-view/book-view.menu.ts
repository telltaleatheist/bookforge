/**
 * book-view.menu — the block context menu's acts: join, edit, chapter, insert, and the similar-block sweep.
 */
import { afterNextRender } from '@angular/core';
import { type BookOp, type ReplayedRow } from '@owen/foundry-core/shared/ops';
import { flowNeighbours } from '@owen/foundry-core/shared/flow';
import { Line } from './book-view.model';
import type { BookViewComponent } from './book-view.component';

export function blockMenu(this: BookViewComponent, event: MouseEvent, line: Line): void {
  if (this.edition()) return;
  const target = event.target as HTMLElement | null;
  if (target !== null && target.isContentEditable) return;
  event.preventDefault();
  event.stopPropagation();
  this.peek.set(null);
  const kin = this.lines().filter((one) => one.row.category === line.row.category);
  this.context.set({
    x: event.clientX,
    y: event.clientY,
    id: line.row.id,
    joinInto: this.joinAbove(line.row),
    chapter: line.chapter !== null,
    colour: line.colour,
    // "Text" pluralises into nonsense; every other category reads naturally.
    plural: line.row.category === 'Text' ? 'text blocks' : `${line.label.toLowerCase()}s`,
    ids: kin.map((one) => one.row.id),
    unstruck: kin.filter((one) => one.row.struck !== true).map((one) => one.row.id),
  });
}

/**
 * The block this one could be joined onto, for the menu's offer — the nearest
 * earlier row in the flow that is neither shelved nor struck, or null.
 *
 * THE SKIP IS `flowNeighbours`'s SKIP, stated once there (./flow): a struck
 * row is out of the edition, so a paragraph whose upstairs neighbour is a
 * cancelled image is a paragraph the reader sees touching the one above the
 * image — which is Owen's case for this gesture existing at all. And the note
 * rule is that function's too, refused here by not offering: a note joins
 * onto nothing and nothing joins onto a note, so a Footnote on either end
 * means no offer rather than an op the replay files in `missing`.
 */
export function joinAbove(this: BookViewComponent, row: ReplayedRow): string | null {
  if (row.shelf !== undefined || row.category === 'Footnote') return null;
  let before: ReplayedRow | null = null;
  for (const one of this.view()?.rows ?? []) {
    if (one.id === row.id) {
      return before !== null && before.category !== 'Footnote' ? before.id : null;
    }
    if (one.shelf !== undefined || one.struck === true) continue;
    before = one;
  }
  return null;
}

/** The menu's Join: the same merge the seam ghost and Ctrl+J push. */
export function joinFromMenu(this: BookViewComponent): void {
  const open = this.context();
  this.context.set(null);
  if (open === null || open.joinInto === null) return;
  this.join(open.id, open.joinInto);
}

/** The menu's Edit: close the menu, open the same editor double-click does. */
export function editFromMenu(this: BookViewComponent): void {
  const open = this.context();
  this.context.set(null);
  if (open === null) return;
  this.beginEditing(open.id);
}

/**
 * The menu's "add a chapter marker": a division above the block, titled with
 * the block's own first line.
 *
 * THE SEED IS THE PANEL'S SEED, deliberately (`makeSheetChapter`,
 * inspector.component.ts): it is right far more often than any other guess,
 * it is exactly what the detection would have called it, and it is a starting
 * point rather than a rule — the chip is renameable the moment it appears.
 * One op, so Ctrl+Z takes the whole gesture back.
 */
export function chapterFromMenu(this: BookViewComponent): void {
  const open = this.context();
  this.context.set(null);
  if (open === null || open.chapter) return;
  const row = this.view()?.rows.find((one) => one.id === open.id);
  if (row === undefined) return;
  const words = row.text.split('\n')[0]?.trim() ?? '';
  this.push({ op: 'chapter', set: open.id, title: words.slice(0, 120) });
}

/**
 * The chip's ✕ — the division above this block, taken away where it is drawn.
 * The op the Chapters panel's remove has always pushed (`dropSheetChapter`),
 * said from the paper: the block stays, the rule goes, and undo brings it
 * back title and all because the title travels with the op it reverses.
 */
export function dropChapter(this: BookViewComponent, id: string): void {
  this.push({ op: 'chapter', remove: id });
}

export function insertFromMenu(this: BookViewComponent, where: 'above' | 'below'): void {
  const open = this.context();
  this.context.set(null);
  if (open === null) return;
  // A live editor's words are somebody's edit; the phantom must not eat them.
  this.commitEditing();
  // And a phantom already holding words commits them before the next one
  // opens — blur is its ordinary ending, and unmounting it any other way
  // would be the one path where typed words leave without a decision.
  const standing = this.host.nativeElement.querySelector('.adding .editor') as HTMLElement | null;
  standing?.blur();
  this.inserting.set({ anchor: open.id, where });
  // The editor element does not exist until the template has re-run —
  // `beginEditing`'s own arrangement, for its reason (this app is zoneless).
  afterNextRender(() => {
    const editor = this.host.nativeElement.querySelector('.adding .editor') as HTMLElement | null;
    editor?.focus({ preventScroll: true });
  }, { injector: this.injector });
}

/**
 * The phantom commits: words become an insert op, nothing becomes nothing.
 *
 * THE ID IS MINTED HERE, at the gesture, and rides in the op — `InsertOp`
 * carries the argument (nothing exists to derive a name from). `u<n>`, the
 * first free ordinal over the replayed rows, which include every insert
 * already waiting on the stack because `view()` is the book as this pane
 * draws it.
 */
export function commitInsert(this: BookViewComponent, event: Event): void {
  const add = this.inserting();
  if (add === null) return;
  if (event instanceof KeyboardEvent) event.preventDefault();
  const editor = event.target as HTMLElement;
  // `textContent`, not `innerText` — `commit`'s rule: a source string must
  // survive the round trip unchanged.
  const said = editor.textContent ?? '';
  this.inserting.set(null);
  if (said.trim().length === 0) return;
  const rows = this.view()?.rows ?? [];
  const used = new Set(rows.map((row) => row.id));
  let ordinal = 1;
  while (used.has(`u${ordinal}`)) ordinal += 1;
  const id = `u${ordinal}`;
  this.push({
    op: 'insert',
    id,
    ...(add.where === 'above' ? { before: add.anchor } : { after: add.anchor }),
    category: 'Text',
    text: said,
  });
  // Selected, so the chip and the rails are already up on the block that just
  // appeared — relabelling it Section-header is the next gesture in Owen's own
  // scenario, and it is one click away rather than a hunt.
  this.chosen.set(new Set([id]));
}

/**
 * Escape empties and blurs, so the blur's commit finds nothing and cancels —
 * `revert`'s single-ending arrangement, on the editor that has no words to
 * put back.
 */
export function cancelInsert(this: BookViewComponent, event: Event): void {
  const editor = event.target as HTMLElement;
  editor.textContent = '';
  editor.blur();
}

/** The selection becomes the category — rails up, chips up, Delete waiting. */
export function selectSimilar(this: BookViewComponent): void {
  const open = this.context();
  this.context.set(null);
  if (open === null) return;
  this.chosen.set(new Set(open.ids));
}

/**
 * The one-press destination: every unstruck block of the kind, cancelled.
 * One op per block, exactly what selecting them and pressing Delete would
 * push — so undo takes it back the same way, one gesture's worth at a time.
 */
export function strikeSimilar(this: BookViewComponent): void {
  const open = this.context();
  this.context.set(null);
  if (open === null) return;
  if (open.unstruck.length === 0) return;
  this.push(...open.unstruck.map((id): BookOp => ({ op: 'strike', id })));
  this.chosen.set(new Set(open.unstruck));
}

/**
 * open-documents.dragging — dragging a row out of the rail and dropping documents onto it.
 */
import { signal } from '@angular/core';
import { type Tab } from '../../core/documents.service';
import { Row, DOCUMENT_MIME } from './open-documents.model';
import type { OpenDocumentsComponent } from './open-documents.component';

// ── Dragging a row ───────────────────────────────────────────────────────

export function onDragStart(this: OpenDocumentsComponent, event: DragEvent, tab: Tab | null): void {
  // A step or host card has no tab to carry, and the drop handler below is
  // written against a tab id. Standing on the step is what puts it on screen;
  // a host's job has nothing to put anywhere.
  if (tab === null) {
    event.preventDefault();
    return;
  }
  // The id travels in a type of our own. Nothing else in the app reads it,
  // and the window-wide file drop looks for `Files` — so the two kinds of
  // drag over this window can never be confused for one another.
  event.dataTransfer?.setData(DOCUMENT_MIME, tab.id);
  // `text/plain` as well, because a drag with no standard type is refused
  // outright by some platforms before a drop can happen at all.
  event.dataTransfer?.setData('text/plain', tab.title);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  /*
   * IT USED TO RAISE A SHIELD OVER THE WORKSPACE — a `draggingDocument`
   * signal on the old tabs service, a transparent sheet over every pane,
   * because a rendered
   * chapter is an <iframe> and a drag over one is delivered to the frame rather
   * than to the pane the user is aiming at. The drop it existed for (a row onto
   * a column) has nowhere to land now that there is one viewer, so the shield
   * and the signal that raised it are both gone (docs/PLAN.md §4, unit 8b) and
   * nothing in this app ever has a sheet of glass over it. What is left of this
   * drag is entirely inside this panel: the loose files' reorder.
   */
}

export function onDragEnd(this: OpenDocumentsComponent): void {
  this.before.set(null);
  this.landing.set(false);
}

/**
 * Over a row: the drop lands before it or after it, by which half the pointer
 * is in — the rule every list of this shape uses, and the only one that lets a
 * row be put at the very end of a list that fills the panel.
 */
export function onRowOver(this: OpenDocumentsComponent, event: DragEvent, row: Row): void {
  if (!this.carriesDocument(event)) return;
  event.preventDefault();
  event.stopPropagation();
  /*
   * A CARD INSIDE A BOOK IS NOT AN INSERTION POINT. Its order is the ledger's
   * and the catalogue's, so a line drawn above it would promise a move the
   * redraw undoes a frame later. `none` rather than `move` says so with the
   * cursor, before the drop — the refusal in `onDrop` is the sentence for
   * somebody who tried anyway.
   */
  if (row.dir !== null) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    this.before.set(null);
    this.landing.set(false);
    return;
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const target = this.landingFor(event, row);
  this.before.set(target);
  this.landing.set(target === null);
}

export function onListOver(this: OpenDocumentsComponent, event: DragEvent): void {
  if (!this.carriesDocument(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  this.before.set(null);
  this.landing.set(true);
}

export function onLeave(this: OpenDocumentsComponent): void {
  this.before.set(null);
  this.landing.set(false);
}

/**
 * A drop inside the list is a reorder.
 *
 * AN EDITOR CANNOT BE REORDERED, and the refusal is said rather than swallowed:
 * its row is drawn under the book it belongs to whatever the flat list says, so
 * moving it would change a number nobody can see and leave the row exactly
 * where it was — a gesture that appears to work and does not.
 *
 * A DOCUMENT IN A BOOK CANNOT EITHER, and for the same reason one step out.
 * Its position is the ledger's and the catalogue's, and that order is redrawn
 * from the project on every change, so a reorder would be undone before the
 * pointer was lifted. The refusal used to end by naming the gesture that WAS
 * available — dragging it onto the workspace to open it in a column — and with
 * one viewer that gesture is a click, which is what the sentence says now.
 */
export function onDrop(this: OpenDocumentsComponent, event: DragEvent, row: Row | null): void {
  const id = event.dataTransfer?.getData(DOCUMENT_MIME);
  // Where it lands was worked out on the way in, and is READ BEFORE the drag
  // state is cleared — clearing first would drop every row at the end of the
  // list and quietly undo the insertion point the user was just shown.
  const target = this.before() ?? (row === null || row.dir !== null ? null : this.landingFor(event, row));
  const onto = row;
  this.onDragEnd();
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  const moving = this.documents.byId(id);
  if (moving === null) return;
  if ((onto !== null && onto.dir !== null) || this.inBook(moving.id)) {
    this.notices.notice.set(
      'Documents in a book are listed in the order it holds them, so they cannot be reordered '
      + 'here. Click one to open it.',
    );
    return;
  }
  // No navigation: a reorder is bookkeeping about the list, not a request to
  // look at something, so it leaves a person on Settings where they were.
  this.documents.reorder(id, target);
}

/** Is this open tab one of a book's, rather than a loose file? */
export function inBook(this: OpenDocumentsComponent, id: string): boolean {
  return this.groups().some((group) => group.tabIds.includes(id));
}

/**
 * Which row a drop over this one lands in front of — by the half the pointer
 * is in, over the LOOSE list.
 *
 * The loose rows are the only ones a reorder can touch (see `onDrop`), so they
 * are the only ones this has to index into: a drop over a book's card is
 * refused before it gets here.
 */
export function landingFor(this: OpenDocumentsComponent, event: DragEvent, row: Row): string | null {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (event.clientY <= box.top + box.height / 2) return row.key;
  const list = this.loose();
  const at = list.findIndex((other) => other.key === row.key);
  return list[at + 1]?.key ?? null;
}

/**
 * Whether this drag is one of ours.
 *
 * `types` is readable during a drag; the DATA is not, by design, which is why
 * the id can only be read on drop. A file drag has `Files` here and is left
 * alone for the window's own handler to open.
 */
export function carriesDocument(this: OpenDocumentsComponent, event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(DOCUMENT_MIME) === true;
}

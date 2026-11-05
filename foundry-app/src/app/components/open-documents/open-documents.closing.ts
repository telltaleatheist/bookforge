/**
 * open-documents.closing — closing, removing and discarding, and the row menu that offers them.
 */
import { computed, effect, signal } from '@angular/core';
import { api } from '../../core/foundry';
import { ConfirmService } from '../../core/confirm.service';
import { OpenDocumentsService, type Tab } from '../../core/documents.service';
import { MenuAction, Row, Group } from './open-documents.model';
import { fold } from './open-documents.words';
import type { OpenDocumentsComponent } from './open-documents.component';

/**
 * Close every tab this book has open. Nothing on disk.
 *
 * *"Right-click the import root → Close project."* Through the ORDINARY close,
 * one tab at a time, so a document holding uncommitted work still gets its one
 * question and a "keep" leaves it where it was. With the last of them gone the
 * book leaves the library and the workspace shows its empty state — home.
 *
 * A COPY OF THE LIST FIRST, because closing mutates the very group this is
 * iterating: `groups()` is a computed over the tabs, so reading it inside the
 * loop would be reading a list that is being emptied underneath.
 */
export function closeProject(this: OpenDocumentsComponent, group: Group): void {
  for (const id of [...group.tabIds]) void this.documents.close(id);
}

/**
 * Close the workspace — and clear whatever was never made into a book.
 *
 * *"then they close the workspace and whatever wasnt assigned to a new
 * library/book is cleared away. if they want to pull it up again theyll have
 * to re-upload the images."* (Owen.) So this ✕ is not the tidying-away its
 * neighbour on a book's head is: closing a book leaves the book on disk and
 * one click from coming back, and closing this DESTROYS the only handle this
 * app has on images nobody has assigned.
 *
 * WHICH IS WHY IT ASKS, in the app's one confirmation card, naming the count —
 * the same card and the same shape as every other destruction here. It names
 * a NUMBER and no filenames: the cards on screen are the person's own
 * photographs and their names are on them, and a question listing nine of them
 * would be a dialog reading a list back to somebody who is looking at it.
 *
 * THE ANSWER IS THE ANSWER TO A REAL LOSS, so the destructive button is last
 * and says what it does, and a dismissal keeps everything (`ConfirmService`).
 */
export async function shutWorkspace(this: OpenDocumentsComponent): Promise<void> {
  const left = this.workspace.count();
  if (left > 0) {
    const yes = await this.confirm.ask({
      message: left === 1
        ? 'Close the workspace and clear the one image left in it?'
        : `Close the workspace and clear the ${left} images left in it?`,
      detail: [
        left === 1
          ? 'This image has not been made into a book, so nothing on disk holds it — '
            + 'it is only here, in this window.'
          : 'These images have not been made into a book, so nothing on disk holds them — '
            + 'they are only here, in this window.',
        'Anything you have already made into a book is safe in that book and is not affected. '
          + 'To get these back, drag them in again.',
      ],
      confirm: left === 1 ? 'Clear it' : 'Clear them',
    });
    if (!yes) return;
  }
  this.workspace.clear();
  this.chosen.set(new Set());
  this.shotAnchor = null;
  // Open, ready for the next drop. A workspace that reappeared folded shut
  // would hide the very thing that just arrived.
  this.workspaceOpen.set(true);
}

/**
 * The visible door onto that — the ✕ that appears on a root card under the
 * pointer. Same gesture as the right-click's Close book, and deliberately the
 * same CALL: it goes through the menu's own dispatch rather than looking a
 * group up for itself, because finding the book from a root row is the part
 * that can quietly be got wrong (the row's path is the project's directory,
 * matched case-folded), and a second copy of that is a second thing to keep
 * true. `fromMenu` closing a menu that is not open costs a signal write.
 *
 * `stopPropagation` because the click would otherwise land on the card as well
 * and stand the project on its import — moving the position of a book on its
 * way out of the library.
 */
export function closeBook(this: OpenDocumentsComponent, event: MouseEvent, row: Row): void {
  event.stopPropagation();
  this.fromMenu(row, 'close-project');
}

/**
 * Delete the document this card names — the file, its catalogue row, and its
 * project if it turns out to be the original.
 *
 * Every branch of that is main's to decide and the modal's to ask; this hands
 * over a path and says whatever comes back.
 */
export async function remove(this: OpenDocumentsComponent, event: MouseEvent, row: Row): Promise<void> {
  // Without this the click also lands on the card and opens the document that
  // is about to be deleted.
  event.stopPropagation();
  try {
    const said = await this.projects.removeDocument(row.path, () => {
      /*
       * CLOSED AFTER THE QUESTION AND BEFORE THE DELETE, which is why it is a
       * callback rather than two lines around the call. Closing first would
       * shut a document the user is about to decline to delete; closing after
       * would mean unlinking a file this window still has open — on Windows
       * the working copy is locked and the delete fails halfway. Main cannot
       * do it: tabs are the renderer's, and main's own reader is only told
       * about EPUBs.
       */
      // Without asking: see `OpenDocumentsService.close`. The delete's own card is the
      // question, and it has already been answered yes. RETURNED rather than
      // voided, so the delete waits for this window to let go of the file.
      if (row.tab === null) return undefined;
      return this.documents.close(row.tab.id, false);
    });
    if (said !== null) this.notices.notice.set(said);
  } catch (err) {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/*
 * `openInSplit` LIVED HERE — the right-click's "Open in split", moved in from
 * the inspector's Steps section and built as two acts arriving as one: leave an
 * intention with the tabs service, move the pointer, and let the answer main sends
 * back (which only arrives asynchronously, inside the effect that watches the
 * position) open into a NEW COLUMN instead of into the one in front. There was
 * a second door for the card you were already standing on, because `go` on your
 * own position moves nothing and the intention would have been inherited by the
 * next step somebody clicked.
 *
 * All of it is gone with the columns (docs/PLAN.md §4, unit 8b). The need it
 * served comes back as Compare on the viewer (unit 8d), and the awkward part —
 * "what does that step even show?" — is answered there by main the same way,
 * without an intention having to survive a round trip.
 */

/**
 * Delete this step. Main says what it costs, the app's own card asks, main
 * does it. Moved here from the inspector's Steps ✕ (docs/WORKBENCH.md §6c),
 * where it was a button on the row; it is behind the right-click now because a
 * step card wears no ✕ — the visible ✕ in this panel closes or deletes a FILE,
 * and one glyph meaning "and everything made from this" as well would be the
 * most expensive ambiguity in the panel.
 *
 * Never offered on the root: deleting the import is deleting the book, and
 * main refuses it by name anyway. A cancel is silence; a refusal is main's
 * sentence, as written.
 */
export async function discard(this: OpenDocumentsComponent, row: Row): Promise<void> {
  if (row.dir === null || row.step === null) return;
  try {
    /*
     * THE BOOKS THIS IS ABOUT TO ERASE ARE CLOSED FIRST, between the confirm
     * and the delete — the document delete's shape and its reason. Main
     * refuses to unlink a working tree this window is still reading (it cannot
     * be done on Windows and would leave half an unpacked book behind), so
     * without this, deleting a translation whose book is open would meet a
     * refusal one line after the user said yes. Main cannot do it: tabs are
     * the renderer's.
     */
    await this.ledger.remove(row.dir, row.step.id, (files) => this.documents.closeShowing(files));
  } catch (err) {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Right-click: whatever this kind of card can be asked to do.
 *
 * NOTHING, ON A HOST'S NODE. Delete, reveal and close are all acts on
 * something Foundry owns; a job in another application's queue is none of
 * those, and a menu that opened with nothing safe in it would be worse than no
 * menu. The default browser menu is suppressed either way, so a right-click
 * there is simply nothing.
 */
export function onMenu(this: OpenDocumentsComponent, event: MouseEvent, row: Row): void {
  event.preventDefault();
  event.stopPropagation();
  if (row.kind === 'host') return;
  this.menu.set({ row, x: event.clientX, y: event.clientY });
}

export function fromMenu(this: OpenDocumentsComponent, row: Row, action: MenuAction): void {
  this.menu.set(null);
  switch (action) {
    case 'reveal':
      void api?.reveal(row.path);
      return;
    case 'save-copy':
      void api?.saveExport(row.path).catch((err: unknown) => {
        this.notices.notice.set(err instanceof Error ? err.message : String(err));
      });
      return;
    case 'view':
      this.documents.openExportView(row.path, row.title);
      return;
    case 'close':
      if (row.tab !== null) void this.documents.close(row.tab.id);
      return;
    case 'close-project': {
      const group = this.groups().find((one) => fold(one.dir) === fold(row.path));
      if (group !== undefined) this.closeProject(group);
      return;
    }
    case 'discard':
      void this.discard(row);
      return;
    case 'delete':
      void this.remove(new MouseEvent('click'), row);
  }
}

export function close(this: OpenDocumentsComponent, event: MouseEvent, tab: Tab | null): void {
  if (tab === null) return;
  // Without this the click also lands on the card and reveals what is about to
  // be closed, which flashes the document on screen for one frame.
  event.stopPropagation();
  void this.documents.close(tab.id);
}

/** Middle-click. `auxclick` and not `mousedown`, so a middle-drag scroll is not a close. */
export function onAux(this: OpenDocumentsComponent, event: MouseEvent, tab: Tab | null): void {
  if (tab === null || event.button !== 1) return;
  event.preventDefault();
  void this.documents.close(tab.id);
}

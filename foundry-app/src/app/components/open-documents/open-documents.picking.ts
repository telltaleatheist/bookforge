/**
 * open-documents.picking — choosing a row: standing on a step, folding a book, and picking shots for a new book.
 */
import type { HostNode } from '@owen/foundry-core/shared/types';
import { api } from '../../core/foundry';
import { type WorkspaceImage } from '../../core/intake-workspace.service';
import { LedgerService } from '../../core/ledger.service';
import { type Tab } from '../../core/documents.service';
import { Row } from './open-documents.model';
import type { OpenDocumentsComponent } from './open-documents.component';

/**
 * A document is not a route. The router still owns Settings, so clicking a row
 * from the settings screen navigates back to the workspace first — the
 * document is what a row means, and it cannot be shown on a page that is not
 * showing documents.
 */
export function pick(this: OpenDocumentsComponent, tab: Tab): void {
  void this.router.navigateByUrl('/');
  this.stage.reveal(tab.id);
}

/**
 * A click on any kind of card.
 *
 * A STEP MOVES THE POSITION and everything else follows: main resolves what
 * that step shows and the panes are told (`ledger:go` → `showPosition`). It
 * costs nothing to the project and throws nothing away — the promise every
 * history panel makes by looking like one, now made by the navigator itself.
 *
 * IT USED TO SAY "ASKS NOTHING" TOO, and Owen's 2026-08-22 ruling took that
 * clause. The one thing a move can cost is the book pane's unapplied stack,
 * which cannot travel to the step being moved to, and the app used to report
 * that after the fact rather than ask about it. `stand` now raises the card —
 * only where there is something to lose, and only when the row is not the one
 * already being stood on, so the ordinary click is still the free, instant,
 * silent thing this paragraph promises.
 *
 * THE SELECTION IS TAKEN FIRST AND KEPT EITHER WAY. It is a fact about which
 * card's footer is unrolled rather than about where anybody is standing, so a
 * dismissed question leaves the row picked and the position where it was, which
 * is exactly what somebody who wanted to look at that row's acts asked for.
 *
 * A HOST NODE MOVES NOTHING. There is no position to go to — it is somebody
 * else's job, and the ledger has never heard of it — so the click does the one
 * half that still means something: it selects the card, which opens its "from
 * here" footer. That is what makes a QUEUED node chainable, which was the
 * ruling: the user can order the next act against an artifact that does not
 * exist yet, and the host is handed the pending node's id to hang it on.
 *
 * A FILE ROW puts a document in front of you: revealing it if it is open,
 * opening it if it is not, and doing nothing at all for a file this app has no
 * tab for. The first two are deliberately the same gesture — from the user's
 * side both cards say "put this in front of me", and whether that costs a tab
 * or merely a focus change is bookkeeping, not their question.
 *
 * ── AND IT REPLACES WHAT THE VIEWER WAS SHOWING ─────────────────────────────
 *
 * *"clicking another file will automatically close the one i was looking at and
 * open the one i just clicked, unless i pin the file by right-clicking the
 * chrome-style tab at the top."* This panel is the list that ruling is about,
 * and it used to be the only caller that passed a `replace` flag — everything
 * else (a drop, a finished job, a step's own document) joined the column's
 * strip instead, because none of them is a person saying "that one instead of
 * this one". With one viewer, replacing what is on screen is the only thing any
 * of them can do, so the flag is gone and the rule is the app's. What went with
 * it is the exception the sentence names: there is no pin, because there is no
 * strip for a pin to protect a place in.
 */
export function pickRow(this: OpenDocumentsComponent, row: Row): void {
  if (row.kind === 'host') {
    this.picked.set(row.key);
    // A row the host made a door (`HostNode.opens`): the click runs that operation on the node.
    const opens = row.node?.opens;
    if (opens !== undefined && row.dir !== null) {
      void this.hostOps.invoke(opens, row.dir, row.node!.id).catch((err: unknown) => {
        this.notices.notice.set(err instanceof Error ? err.message : String(err));
      });
    }
    return;
  }
  /*
   * AN ANALYSIS CARD OPENS ITS REPORT, AND MOVES NOTHING. A report is not a
   * place to stand: nothing is ever made from one, it has no rendering for
   * the bench to draw, and the landing deliberately left the pointer beside
   * it — so standing here would move the position onto a row whose only
   * answer to the screen is silence, which is exactly what the first person
   * to press one got (Owen, 2026-08-25: *"clicking it does nothing"*). What
   * the click means on this card is "show me what the analysis found", and
   * that is the hits panel, aimed at this step by the row's own project and
   * id (`startAnalysisAt` — the tree must not derive the project from the
   * screen, for the race its docblock names). The panel draws beside the
   * book the person is reading; if no document of this project is up, the
   * wish waits for one, which is the validated column's ordinary contract.
   */
  if (row.kind === 'step' && row.step !== null && row.step.action === 'analysis') {
    this.picked.set(row.key);
    // A PROMISED analysis has no report yet, and standing on it would make the
    // dock act from a report — so it takes the selection and opens nothing,
    // like a promised file. The panel opens once the card has landed.
    if (row.promise !== null) return;
    if (row.dir !== null) this.stage.startAnalysisAt(row.dir, row.step.id);
    return;
  }
  if (row.kind === 'root' || row.kind === 'step') {
    this.picked.set(row.key);
    void this.stand(row);
    return;
  }
  /*
   * A PROMISED FILE TAKES THE SELECTION AND OPENS NOTHING.
   *
   * Owen: *"i can click the grayed out exported epub and click narrate."* The
   * selection is the whole of what that press needs — it unrolls the footer the
   * host's acts live in, exactly as a landed export row's press does. What it must
   * NOT do is the rest of an export row's press: the file is not on the disk yet,
   * so `openExportView` would put a proof sheet over a path that does not exist and
   * `reveal` would open a folder to show nothing.
   *
   * AND IT LETS GO OF THE POSITION, because a file is not a place to stand. If the
   * person was standing on the promised cleanup this export hangs under, they have
   * now clicked away from it — the same thing a click on a landed export means.
   * What the press SENDS is unaffected: `nodeIdFor` reads the row's own
   * `export:<file>` id, and main resolves which queue row is going to make it.
   */
  if (row.promise !== null) {
    this.picked.set(row.key);
    this.ledger.releasePromise();
    return;
  }
  /*
   * AN EXPORT ROW TAKES THE SELECTION NOW; every other file row still clears
   * it.
   *
   * The clearing covered every file on the argument that "nothing is ever
   * made from an export" — true for as long as only this app's own acts
   * existed, and FALSE since `export` became a currency (Wave 10): a
   * narration is made from an export, the offer correctly lands on this
   * row, and the selection is the only gesture that unrolls the footer the
   * offer lives in. Owen hit the gap within minutes of the member landing —
   * *"theres no narration step available to press under the epub i
   * generated"* — because the rule was right and no click could reach it.
   * The press still does everything it did (open the proof sheet, reveal
   * the file); the selection rides along, exactly the pairing a step's
   * click has always had. A COPY still clears: nothing is made from one,
   * which is the old sentence still true of the rows it still covers.
   */
  this.picked.set(row.kind === 'export' ? row.key : null);
  if (row.tab !== null) {
    this.pick(row.tab);
    return;
  }
  if (row.openable !== true) {
    /*
     * A CARD THIS APP HAS NO TAB FOR STILL ANSWERS THE CLICK. An EPUB or txt
     * export used to eat the press — no viewer, so nothing happened — and a
     * person who just exported clicked it expecting to be taken to the file
     * (user report, 2026-08-16). "Put this in front of me" for a finished
     * file with no tab means the file manager: the same reveal the context
     * menu offers, promoted to the click, because a dead left-click teaches
     * people the card is furniture.
     */
    if (row.kind === 'export') {
      /*
       * The click model is the user's (2026-08-16): an exported BOOK opens in
       * a tab — the proof sheet locked to the Final version over the file
       * itself — and Ctrl+S there saves a copy. Plain text still reveals: it
       * has no book inside it to show.
       */
      if (row.path.toLowerCase().endsWith('.epub')) {
        this.documents.openExportView(row.path, row.title);
      } else {
        void api?.reveal(row.path);
      }
    }
    return;
  }
  void this.router.navigateByUrl('/');
  void this.documents.openFromList(row.path, row.managed === true);
}

/**
 * Stand on the step this card names — the gesture that used to live on a Steps
 * row in the inspector (docs/WORKBENCH.md §6c: the section moved here whole).
 *
 * FREE, INSTANT AND — UNTIL 2026-08-22 — UNCONFIRMED. One line of the
 * manifest, no job, no rendering. It still costs nothing to the project. What
 * it can cost is the PAGE: the book pane's stack is a delta against the step it
 * was made on, so a move has always let it go, and the app said so on the
 * notice strip AFTERWARDS. Owen's ruling turns that into a decision — *"any
 * action they take, whether it's switching to a different step or narrating or
 * anything at all, should ask if they want to apply changes in a modal"* — so
 * the same card every make-act raises stands in front of the move as well:
 * Apply changes and go, Discard and go, or dismiss and stay where you are.
 *
 * ── THIS IS THE ONE SEAM, and it is one because the door is one ────────────
 *
 * `LedgerService.go` is the only person-initiated position move in the window
 * and this is its only caller (checked, not assumed). What ELSE moves a
 * position is main — a landed job, another window, the pointer following an
 * Apply — and none of those is asked, because by the time the renderer hears
 * about them the move has already happened in the catalogue and a card would be
 * asking permission for something already true. `PositionSyncService` reacts to
 * those; it does not initiate them, and it must not grow a question.
 *
 * ── AND THE ACT'S OWN PRESS DOES NOT ASK TWICE ─────────────────────────────
 *
 * `run` gates the make-acts itself, against the same book and with the same
 * card, and then calls this to move onto the row first. `asked` is how it says
 * so. A second card between the answer and the act would be the app asking
 * whether to apply changes that the previous answer has just applied — or just
 * discarded.
 *
 * ── STANDING WHERE YOU ALREADY STAND IS NOT A MOVE ─────────────────────────
 *
 * The old comment said the current card was "not a no-op worth guarding", and
 * that was true of a click that cost nothing. It is not true of a click that
 * raises a modal: re-clicking the row you are standing on would put a card
 * about losing work in front of somebody whose work is not going anywhere. So
 * the guard exists now, it is narrow, and it guards the QUESTION rather than
 * the move — the move still goes through main and still repaints to the same
 * thing, which is the cheap, always-correct behaviour the old comment defends.
 */
export async function stand(this: OpenDocumentsComponent, row: Row, asked = false): Promise<boolean> {
  if (row.dir === null || row.step === null) return true;
  /*
   * ── A PROMISE IS STOOD ON IN THIS WINDOW AND NOWHERE ELSE ────────────────
   *
   * Owen: *"i click the grayed out row and hit the export epub tile."* Clicking a
   * promised card has to make the tiles and the dialogs answer for it, and it must
   * not send `ledger:go`: main refuses a step that does not exist, and is right
   * to — the pointer names a row of a file, and a promise is not in the file
   * (`LedgerService.standOnPromise`).
   *
   * NO UNAPPLIED CARD, AND THAT IS THE DIFFERENCE THAT EARNS THE EARLY RETURN.
   * The card below exists because moving the pointer LOSES the book pane's
   * unapplied stack — the stack is a delta against the step it was made on, and it
   * cannot travel. Standing on a promise moves no pointer and changes no pane:
   * the viewer keeps whatever it was showing, because there is no book at a step
   * nothing has made yet. Nothing is at risk, so nothing is asked — raising a card
   * about losing work here would be the app inventing a cost to warn about.
   */
  if (row.promise !== null) {
    // The workspace has to be on screen for a selection to mean anything — the
    // same reason a document row navigates, one branch down.
    void this.router.navigateByUrl('/');
    this.ledger.standOnPromise(row.dir, row.step.id);
    return true;
  }
  if (!asked && this.ledger.standingIn(row.dir)?.id !== row.step.id
    && !await this.unapplied.cleared(row.dir, 'stand')) return false;
  // A position is a thing to LOOK at, so the workspace has to be on screen for
  // it to mean anything — the same reason a document row navigates.
  void this.router.navigateByUrl('/');
  try {
    await this.ledger.go(row.dir, row.step.id);
  } catch (err) {
    // Main's words. It refuses an id this project does not hold, which means
    // the two sides are looking at different ledgers — not something to smooth
    // over.
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
  /*
   * TRUE MEANS "NOBODY SAID STOP", which is a narrower claim than "the pointer
   * moved" and is the one the caller needs. A row with nothing to stand on and
   * a move main refused both answer true: the first was never a move, the
   * second has already put its own sentence on the notice strip, and neither is
   * a reason to swallow the act the person pressed. The single false is the
   * card being dismissed, because that IS somebody saying stop.
   */
  return true;
}

/** Fold a node shut, or open it. The click must not also stand on the card. */
export function toggle(this: OpenDocumentsComponent, event: MouseEvent, row: Row): void {
  event.stopPropagation();
  this.collapsed.update((shut) => {
    const next = new Set(shut);
    if (!next.delete(row.key)) next.add(row.key);
    return next;
  });
}

// ── The accordions ─────────────────────────────────────────────────────────

/**
 * Fold one book away, or open it.
 *
 * *"an arrow to minimize it"* (Owen). No `stopPropagation` here, unlike
 * `toggle` above: that one sits INSIDE a card whose own click stands the
 * position on the row, and this is a head with nothing behind it.
 *
 * FOLDING IS NOT CLOSING and the head draws both, side by side, because they
 * are the two different things a person means by "get this out of my way": one
 * is about the panel and is free, the other closes the tabs and moves the book
 * off the screen.
 */
export function foldBook(this: OpenDocumentsComponent, key: string): void {
  this.shutBooks.update((shut) => {
    const next = new Set(shut);
    if (!next.delete(key)) next.add(key);
    return next;
  });
}

// ── The workspace ──────────────────────────────────────────────────────────

/**
 * Click an image: this one, or add to what is already picked.
 *
 * THE THREE GESTURES EVERY LIST OF THIS SHAPE HAS. A plain click replaces the
 * selection and sets the anchor; Ctrl/Cmd toggles one and moves the anchor to
 * it (so a range can be started from the thing you just added); Shift takes
 * everything between the anchor and here, in the list's own order, which is
 * drop order — the order on screen, which is the only order a range can mean.
 *
 * THE MARQUEE IS DELIBERATELY NOT HERE. The light table has one because it is
 * a full-window grid of a hundred and seventy-nine photographs where sweeping
 * is genuinely faster; this is a panel three columns wide, where a marquee
 * would mostly be a way to start a drag by accident on a surface whose rows
 * above it are draggable for something else entirely.
 */
export function pickShot(this: OpenDocumentsComponent, event: MouseEvent, shot: WorkspaceImage): void {
  const items = this.workspace.items();
  if (event.shiftKey && this.shotAnchor !== null) {
    const from = items.findIndex((one) => one.id === this.shotAnchor);
    const to = items.findIndex((one) => one.id === shot.id);
    if (from >= 0 && to >= 0) {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      this.chosen.set(new Set(items.slice(lo, hi + 1).map((one) => one.id)));
      return;
    }
  }
  if (event.ctrlKey || event.metaKey) {
    this.chosen.update((picked) => {
      const next = new Set(picked);
      if (!next.delete(shot.id)) next.add(shot.id);
      return next;
    });
    this.shotAnchor = shot.id;
    return;
  }
  this.chosen.set(new Set([shot.id]));
  this.shotAnchor = shot.id;
}

/**
 * Right-click an image.
 *
 * ON A CARD OUTSIDE THE SELECTION, THE RIGHT-CLICK IS ALSO THE SELECTION —
 * capture-grid's own correction, and the same bug it fixed: a menu opened on
 * one card while a different set was highlighted offered an act about
 * something the person was not pointing at. Inside the selection it changes
 * nothing, because "right-click the ones you swept" is the whole gesture Owen
 * described.
 */
export function onShotMenu(this: OpenDocumentsComponent, event: MouseEvent, shot: WorkspaceImage): void {
  event.preventDefault();
  event.stopPropagation();
  if (!this.chosen().has(shot.id)) {
    this.chosen.set(new Set([shot.id]));
    this.shotAnchor = shot.id;
  }
  this.shotMenu.set({ x: event.clientX, y: event.clientY });
}

/**
 * "Create new book…" — hand the selection to the naming card.
 *
 * NOTHING IS MADE HERE. The card asks the name, the workspace service runs the
 * two doors (`capture:create` then `capture:intake`) and opens the project the
 * way "Photograph a book…" opens one. This method's whole job is to turn a
 * selection into the question, which is what Owen described happening:
 * right-click, then *"itll pop up a modal to name the new book"*.
 */
export function createFromChosen(this: OpenDocumentsComponent): void {
  const picked = [...this.chosen()];
  this.shotMenu.set(null);
  if (picked.length === 0) return;
  this.ui.openCaptureNew(picked);
  // The selection goes with the question. Whatever comes back — a book, or a
  // cancelled card — the images it was about have either left this list or are
  // still in it to be picked again, and a highlight left over from a dialog
  // nobody finished is a statement about a gesture that ended.
  this.chosen.set(new Set());
  this.shotAnchor = null;
}

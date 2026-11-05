/**
 * documents-closing — letting a tab go: the questions asked first, moving on, and following a file that moved.
 */
import { effect, signal } from '@angular/core';
import { fold } from '@owen/foundry-core/shared/original';
import { BookStacksService } from './book-stacks.service';
import { api, hosted } from './foundry';
import { Tab, EMPTY_IDS, normalise } from './documents-tabs';
import type { OpenDocumentsService } from './documents.service';

/**
 * The document this tab is showing has moved to the copy this app works on.
 *
 * ── What this fixes ─────────────────────────────────────────────────────────
 *
 * A file opened from outside the library is IMPORTED — copied into the
 * project's `archive/` untouched, and again into the live layer, which is what
 * "the PDF" means in every other sentence this app says. The tab kept the
 * outside path, because the import is deliberately not awaited and there was
 * nothing else to name at the moment the tab was made.
 *
 * Everything then asked the wrong question. `projectFor(tab.path)` answers
 * null for a path outside the library, so Generate said a book that had just
 * been read had not been read, the dock's waiting light stayed lit on a
 * finished project, the nav could not group the document under its own book,
 * and the block editor had no bank to fetch. One stale string, six broken
 * features, and nothing on screen to explain any of it.
 *
 * ── The same tab, never a second one ────────────────────────────────────────
 *
 * `adopt` would make a new tab for the new path, which is exactly the failure
 * this exists to prevent: two viewers onto one document, two scroll positions,
 * and the user watching their book apparently open twice. So this PATCHES —
 * the tab keeps its id, its ledger, its selection and its place in the list,
 * and only its idea of where the file is changes.
 *
 * A PDF viewer reloads by itself: `app-pdf-view` watches `tab.path` through a
 * computed and re-opens when the string changes, which is a repaint of the
 * same pages from the same bytes. A book does not reload at all — it is
 * already unpacked, and it is unpacked from the SAME project, because the
 * import is keyed by the file's content and both paths reach it.
 *
 * `savedPath` MOVES WITH IT WHEN IT NAMED THE FILE WE ARE LEAVING. It is a
 * grant — for a book opened from the user's own disk it names their file, and
 * Save updating the copy they chose is what they asked for by opening it — but
 * that stops being true the moment the tab stops showing that file. A Save
 * that repacked the working tree over a document on another drive, while every
 * label on screen said the library's copy, is the same invariant `meta:write-pdf`
 * broke: THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY. Main revokes the
 * matching grant in the same breath. Where `savedPath` names something else
 * entirely — a Save As the user made — it is left exactly alone.
 *
 * Silent when nothing matches — the tab was closed inside the import's own
 * round trip, which is a race with no consequence.
 */
export function relocate(this: OpenDocumentsService, from: string, to: string): void {
  const was = normalise(from);
  const now = normalise(to);
  if (was === now) return;
  const moving = this.all().find((tab) => normalise(tab.path) === was);
  if (!moving) {
    // No tab for it, which for an EPUB is the ordinary case: `adopt` made none
    // and is waiting for the project this move announces.
    if (this.awaitingBooks.has(was)) {
      this.awaitingBooks.delete(was);
      this.awaitBook(to);
    }
    return;
  }
  /*
   * THE DESTINATION IS ALREADY OPEN — one book reached two ways.
   *
   * Somebody opened the project's copy from Home and then dropped their own
   * file on the window (or the reverse). This used to give up and leave the
   * outside-path tab exactly where it was, which is the worst of the three
   * outcomes: that tab keeps every identity bug the relocation exists to fix,
   * and the user is looking at two tabs of one book with only one of them
   * working.
   *
   * ONE BOOK, ONE TAB. The outside tab closes and the one already on the
   * working copy is shown. Nothing is lost — they are the same bytes, and
   * the surviving tab is the one with a project behind it. `ask: false`
   * because there is no question here: this is not a document being put away,
   * it is two views of one document becoming one.
   */
  const already = this.all().find((tab) => normalise(tab.path) === now && tab.id !== moving.id);
  if (already) {
    void this.close(moving.id, false);
    this.show(already.id);
    return;
  }
  this.patch(moving.id, {
    path: to,
    /*
     * AND THE SAVE TARGET GOES WITH THE PATH. `savedPath` names the copy the
     * user chose, and for a book opened from their own disk that is their own
     * file — which is a deliberate design and stays right up until the moment
     * the tab stops showing that file. Keeping it here would mean Ctrl+S
     * repacking the working tree over a document on E:\\ while every label on
     * screen said the library's. Main revokes the matching write grant at the
     * same instant, so the two sides cannot disagree; clearing it here is what
     * makes Save fall through to Save As, which is the door that asks.
     */
    ...(moving.savedPath !== null && normalise(moving.savedPath) === was
      ? { savedPath: null, unsaved: true }
      : {}),
    /*
     * THE TITLE ONLY IF NOBODY HAS SET A BETTER ONE. A book's title becomes
     * its `dc:title` when it unpacks — "Working Towards the Führer" rather
     * than the name it arrived under — and overwriting that because the file
     * moved between folders would undo the one piece of naming this app does
     * on the user's behalf.
     *
     * RE-DERIVED RATHER THAN CARRIED, because this move is the exact moment
     * the answer changes: the file is going from a folder of the user's into
     * a project, so the name it should now be wearing is the project's, and
     * `nameFor` is where that is decided once for the whole app.
     */
    ...(moving.named ? {} : { title: this.nameFor(to) }),
  });
}

/**
 * THE TAB THAT FOLLOWS THE POINTER MOVES ONTO THE STEP'S FILE.
 *
 * One document per project in the viewer is what makes "the viewer shows the
 * step" true, and `app-pdf-view` watches `tab.path` and re-opens when the
 * string changes — so a swap between two PDFs of one project is this patch and
 * nothing else, and it keeps the page the reader was on where opening a second
 * tab would land them back at page one of five hundred.
 *
 * `madeByUs` IS THE CHROME DOT FOLLOWING THE FILE: the tab is about to stop
 * being about the copy Foundry made and start being about the user's own, or
 * the reverse. The caller asks the catalogue, because whether a path is managed
 * is the catalogue's answer and not this file's.
 */
export function followTo(this: OpenDocumentsService, tabId: string, filePath: string, madeByUs: boolean): void {
  const tab = this.byId(tabId);
  if (tab === null) return;
  this.patch(tabId, {
    path: filePath,
    unsaved: madeByUs,
    /*
     * THE REVISION MOVES WITH THE PATH. It is what makes the viewer re-read
     * bytes it is already pointed at (see `openFinished`), and the two files
     * this swaps between can have the same name in two layers of one project —
     * so a viewer that compared only the string would faithfully conclude there
     * was nothing to do, which is the failure that whole comment is about.
     */
    revision: tab.revision + 1,
    /*
     * AND THE NAME ONLY IF NOBODY CHOSE ONE, which is `relocate`'s rule and its
     * reason: a book's `dc:title` outranks anything derived from a path, and
     * these files are all one book anyway — `nameFor` answers the project's
     * title for every layer of it.
     */
    ...(tab.named ? {} : { title: this.nameFor(filePath) }),
  });
}

// ── Closing ──────────────────────────────────────────────────────────────

/**
 * Close every tab showing one of these files — the window letting go of what is
 * about to be erased.
 *
 * ── Why it is the paths and not a tab id ────────────────────────────────────
 *
 * A step delete names PAYLOADS, not tabs: main is destroying `generated/<book>
 * (en).epub` and knows nothing about which documents this window has open, and
 * only this side can close one. So the caller hands over the list main gave it
 * and this matches whole paths, folded — never a basename, because a project
 * holds `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf` at once
 * and closing by last segment would shut the scan for a delete aimed at a
 * reprint.
 *
 * WITHOUT ASKING. Every caller has already put a confirm on screen naming
 * exactly these losses, and a second dialog about unsaved changes in a document
 * that is being destroyed is a question with no useful answer.
 *
 * A COPY OF THE LIST FIRST, because closing mutates the very signal this reads.
 */
export async function closeShowing(this: OpenDocumentsService, files: readonly string[]): Promise<void> {
  const doomed = new Set(files.map((file) => fold(file)));
  const ids = this.all()
    .filter((tab) => doomed.has(fold(tab.path)))
    .map((tab) => tab.id);
  for (const id of ids) await this.close(id, false);
}

/**
 * The window is going — every open document gets the question first.
 *
 * ── Why quitting comes back to this class ───────────────────────────────────
 *
 * Quit used to skip closing altogether: the window was destroyed and the tabs
 * went with it, so nothing was asked about any of them. That was survivable
 * while the only thing at stake was a copy of a file the user had been warned
 * about, and it stopped being survivable the moment closing a scan became the
 * event that ends a session's undo history — quitting with four books open
 * converted "undoable" into "permanent" four times over, silently. Main cannot
 * ask on its own: it knows which files were ever opened, not which documents
 * are open now, and that is renderer state.
 *
 * THE SAME QUESTION, DOCUMENT BY DOCUMENT, and not a summary of all of them.
 * Every one of these losses is about a particular book — its corrections, its
 * save, its copy — and a dialog that pooled four books into one number would be
 * asking somebody to make four decisions with one button. `keep` on any of them
 * stops the quit where it stands: the person said they wanted that book, and
 * carrying on to ask about the next one would be the app negotiating.
 *
 * NOTHING IS CLOSED HERE. The tabs are asked about and left exactly as they are;
 * main destroys the window if the answer is yes. Closing them one by one first
 * would leave a cancelled quit with a window somebody had emptied on their way
 * to changing their mind.
 */
export async function letGo(this: OpenDocumentsService): Promise<boolean> {
  /*
   * THE TABS THIS SWEEP HAS ALREADY ACCOUNTED FOR, which is what makes the
   * corrections question fire exactly once for a project with two of them open.
   *
   * `questionBefore` skips the corrections when another open tab still reaches
   * the same project's decisions — see it for why. In a sweep that is every tab
   * of the project, so with nothing carried between iterations each tab would
   * point at the next as the one that still holds them and NOBODY would be
   * asked: the window would close on a project's uncommitted decisions in
   * silence, which is the exact failure this sweep exists to prevent. Carrying
   * the ones already passed makes the LAST tab of each project the one with
   * nothing left to point at, and it is the one that asks.
   */
  const accountedFor = new Set<string>();
  // A copy, because a save made from the dialog can repaint the list underneath
  // this loop, and an iteration over the live signal would be walking an array
  // that moved.
  for (const tab of [...this.all()]) {
    if (await this.questionBefore(tab.id, accountedFor) === 'stay') return false;
    accountedFor.add(tab.id);
  }
  return true;
}

/**
 * What this document has to say for itself before it goes, asked once — and
 * ONLY when something would actually be lost.
 *
 * ── THE QUESTION THAT WAS ASKED ABOUT NOTHING ───────────────────────────────
 *
 * This used to ask whenever a tab was `unsaved`, and `unsaved` means "no copy
 * of this exists anywhere you chose" — which is true FROM BIRTH of every book
 * this app opens out of a project, because the project IS where it lives. So
 * closing a tab somebody had done nothing but look at raised a dialog about a
 * loss that had not happened, and a warning that fires when nothing is at stake
 * is how a person learns to dismiss the one that matters. The user ruled on it
 * in a sentence: *"only pop up a confirmation alert if changes have been
 * made."*
 *
 * It is also a warning that outlived its workflow. It was written when Save put
 * a copy somewhere of the user's choosing and the app could reasonably say "you
 * have not done that yet"; saving is the export modal's job now
 * (docs/WORKBENCH.md §6), a project tab that closes loses track of nothing, and
 * Home still lists the book. The DOT stays — `Tab.unsaved` is a fact worth
 * drawing — but it is not a reason to stop somebody on their way out.
 *
 * ── ONE QUESTION FOR TWO STATES ─────────────────────────────────────────────
 *
 * A book's filed copy can be out of date, and a book pane can hold changes
 * nobody applied. Main composes whichever of the two are true into one card,
 * because this codebase has already ruled that a closing document is asked
 * about once (`closeShowing`): a second dialog on top of the first is the app
 * arguing with an answer it already has.
 *
 * IT SAID "TWO LOSSES" UNTIL 2026-08-22, and the second one has stopped being
 * a loss — see the scrap-guard below for Owen's reversal and what the card asks
 * now.
 *
 * ── And the offer to keep the work is a button, not advice ─────────────────
 *
 * A dialog whose only route to keeping the work is *cancel, hunt for Apply,
 * close again* has made the user do the app's job, and the way that ends is
 * that they stop reading the box. So the answer can be "apply these changes,
 * then close" — and it goes through the viewer's own `apply`, the same path the
 * sheet's own button takes, rather than a second commit written for this
 * dialog. AN APPLY MAIN REFUSES LEAVES THE TAB OPEN: closing anyway would have
 * thrown away the very thing the answer asked to keep, and main's own sentence
 * is already in the notice strip saying why it would not land.
 */
export async function questionBefore(this: OpenDocumentsService, id: string, accountedFor: ReadonlySet<string> = EMPTY_IDS): Promise<'go' | 'stay'> {
  const current = this.byId(id);
  if (current === null || !api) return 'go';
  /*
   * ── THE STACK, AND WHAT THIS CARD IS ACTUALLY ABOUT NOW ────────────────────
   *
   * The other thing this used to ask about — the block editor's uncommitted
   * CURATION — is gone with that editor, and it was never a loss: every strike
   * was already on disk and what ended was a way back. The book viewer's stack
   * WAS the opposite: in memory, the only copy, and scrapped by closing, which
   * was the ruling (docs/RENDERER.md §3: "Apply writes and clears; closing
   * without applying scraps it").
   *
   * OWEN REVERSED THAT RULING ON 2026-08-22, after a real project lost real
   * work to it: the stack is written to a sidecar as it is made
   * (`BookStacksService.rememberPending`) and comes back the next time the book
   * is opened at the same step. So closing costs nothing by itself, and this
   * card is no longer a warning — it is the offer to RECORD the work as a step,
   * which matters because everything made from this book (an export, a
   * translation, a rewrite) is built from the recorded steps and would be built
   * without it. The one answer that still destroys is Discard, and that is now
   * the only gesture in the app that can.
   *
   * IT IS STILL ASKED PER TAB, because a stack belongs to one tab's book viewer
   * and closing that tab is the moment it stops being on screen, whatever else
   * is open onto the same book.
   *
   * ── ONE COUNT AND ONE PRESS, AND NEITHER IS SPELLED HERE ANY MORE ──────────
   *
   * `unappliedIn` routes between the live viewer and the parked stack, and
   * `applyUnapplied` makes the amend-or-land decision for whichever it is
   * (`BookStacksService`). Both moved out of this function when the make-act
   * gate needed the identical pair before an export: a second copy of either is
   * how a dialog comes to disagree with the button that opened it.
   */
  const edits = current.kind === 'book' ? this.stacks.unappliedIn(current.id) : 0;
  if (!current.modified && edits === 0) return 'go';

  const answered = await api.confirmClose({
    title: current.title,
    modified: current.modified,
    savedPath: current.savedPath,
    edits: edits > 0 ? edits : null,
  });
  if (answered === 'keep') return 'stay';
  /*
   * A REFUSAL LEAVES THE TAB OPEN: closing anyway would leave the work held
   * rather than recorded when the answer asked for it recorded, and main's own
   * sentence is already on the notice strip saying why it would not land.
   */
  if (answered === 'save' && edits > 0) return await this.stacks.applyUnapplied(current) ? 'go' : 'stay';
  /*
   * ── AND DISCARD IS THE ONE SANCTIONED SCRAP ────────────────────────────────
   *
   * The sidecar exists so that nothing but a person can throw unapplied work
   * away; this is the person. It is awaited rather than fired, because closing
   * the tab is what happens next and a clear still in flight would race a
   * reopen that put the discarded stack straight back on the page.
   *
   * IT IS ONLY REACHED WHEN THERE WAS SOMETHING TO DISCARD. A card raised for
   * the filed copy alone answers `close` too, and clearing a sidecar nobody
   * asked about would be this app scrapping work on the strength of an answer
   * to a different question.
   */
  if (answered === 'close' && edits > 0) await this.stacks.discardPending(current.path);
  return 'go';
}

/**
 * How many OTHER open tabs would still reach this document's project after it
 * goes — the count that decides whether the corrections question is owed.
 *
 * EDITORS DO NOT COUNT. An editor tab is a face of its book rather than a
 * document of its own, and closing the book closes it (`close`), so counting
 * one would be counting the tab that is going with this one.
 *
 * A DOCUMENT IN NO PROJECT HAS NO SIBLINGS: somebody's own PDF out of their
 * Downloads folder has no project, no curation and nothing to be the last way
 * back to. Zero is the honest answer and it is also the one that lets the
 * question be asked, which costs nothing — main answers null for it.
 */
export function otherTabsIn(this: OpenDocumentsService, doomed: Tab, accountedFor: ReadonlySet<string>): number {
  const dir = this.projectDirOf(doomed);
  if (dir === null) return 0;
  const key = fold(dir);
  return this.all().filter((tab) => {
    if (tab.id === doomed.id || accountedFor.has(tab.id)) return false;
    const own = this.projectDirOf(tab);
    return own !== null && fold(own) === key;
  }).length;
}

/**
 * Close a tab, asking first when it has something to lose.
 *
 * The question is `questionBefore` above, asked in the app's own card
 * (`ConfirmService`). THE BOOK IS NOT DELETED EITHER WAY (see
 * electron/workspace.ts) and neither are its corrections, so what closing costs
 * is a filed copy left behind and a state they can come back to, never the work
 * itself.
 *
 * `ask: false` FOR A CLOSE THAT IS PART OF A DELETE, and it is the difference
 * between one question and two. The question's whole subject is work the user
 * might want to keep — a copy to keep track of, corrections to keep a way back
 * to — and a document being deleted is one where all of that is false and the
 * offer to save it is an offer to write bytes into a file about to be
 * unlinked. The delete's own confirmation asked the only question there is; a
 * second card on top of it, asking about saving the thing they just told the
 * app to destroy, is the app arguing with an answer it already has.
 *
 * ── AND IT NEVER TOUCHES THE POINTER ────────────────────────────────────────
 *
 * Closing what is on screen goes to Home, and this method says nothing about
 * it. There used to be a line here that cleared the pointer when the closed tab
 * was the shown one; the split deleted it, because `StageService.active` is a
 * COMPUTED over this list and the pointer, so a document that leaves the list
 * takes the stage's answer with it by construction. That is the whole reason the
 * pointer is not validated on write: close is a fact about the LIST, and having
 * to remember to tidy up a second structure after it is exactly the kind of
 * bookkeeping that rots.
 */
export async function close(this: OpenDocumentsService, id: string, ask = true): Promise<void> {
  if (!this.all().some((candidate) => candidate.id === id)) return;
  if (ask && await this.questionBefore(id) === 'stay') return;

  // The list is re-read AFTER the dialog: that box is modal to the window but
  // not to the app, and a conversion can finish and open a tab while it is up.
  const tabs = this.all();
  if (!tabs.some((candidate) => candidate.id === id)) return;

  /*
   * The parked stack goes with the tab, and this is now a HOUSEKEEPING line
   * rather than the scrap it used to be: the map is this window's heap, and the
   * work itself is on disk in the project's sidecar unless the closing question
   * above was answered Discard (which clears it). So dropping the entry ends a
   * copy, not the copy — a reopen of this book reads the work back.
   */
  this.stacks.dropParked(id);
  this.all.set(tabs.filter((candidate) => candidate.id !== id));
  /*
   * NOTHING PER-TAB IS LEFT TO FORGET, and the emptiness is the wave landing.
   * A close used to drop five maps keyed by tab id — the frame's selection and
   * category tally, the persisted undo ledger, whether a block was being typed
   * in, and the translation world a word edit belonged to — and every one of
   * them served a surface that is deleted (docs/RENDERER.md §7). What a tab
   * still owns is its BookStack, and that is released by the viewer that
   * registered it (`releaseBookStack`), because the viewer is what knows the
   * stack has finished with the document rather than merely stopped being drawn.
   */
  this.leaveIfHostedAndEmpty();
}

/**
 * HOSTED, THE LAST DOCUMENT GOING TAKES THE WINDOW WITH IT.
 *
 * *"when I closed the tabs it brought me to the 'foundry home', which is a
 * project picker. It shouldn't bring me there. It should just close the window
 * if it runs out of tabs."* (User ruling, 2026-08-16.) Hosted, the books are
 * BookForge's and Home is a second answer to "what books do I have" — the same
 * rule that already takes the dock's Home button and Home's own recents away
 * (`hosted`, core/foundry.ts). The held bench above it is no better: it offers
 * a tree and a way back to a library this window is not the app for.
 *
 * STANDALONE NOTHING CHANGES, and that is not a concession — Home is where the
 * app legitimately begins, and the bench that keeps the project past its last
 * tab is last month's ruling about being thrown out of the room you were
 * working in (see `StageService.heldProject`).
 *
 * ASKED ONLY WHERE A CLOSE EMPTIED THE WINDOW, never from an effect on the
 * count. A hosted window has nothing open for the moment between loading and the
 * document it was opened for arriving (`openFoundryWindow`, electron/mount.ts),
 * and a watcher on "nothing open" would shut the window before the file got
 * there. Its one caller is a gesture — the last document closed — which is what
 * "runs out of tabs" means.
 *
 * IT IS THE ✕'S OWN PATH. `closeWindow` re-enters the window's close handler in
 * main, so the documents are asked what closing costs exactly as they always
 * are — an answer of yes, immediately, with nothing left open.
 */
export function leaveIfHostedAndEmpty(this: OpenDocumentsService): void {
  if (!hosted() || this.all().length > 0) return;
  // `hosted()` is only ever true because main answered `app:hosted`, so there
  // is a bridge here by construction. The `?.` is this file's spelling for
  // reaching main, not a second opinion about whether one exists.
  void api?.closeWindow();
}

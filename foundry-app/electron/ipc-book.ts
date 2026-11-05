/**
 * ipc-book — the step ledger and the book: loading, amending, the working stack.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { amendBookOps, applyBookOps, clearPendingStack, correctBookBlock, loadBook, loadBookAt, readPendingStack, savePendingStack, viewExportedBook } from '@owen/foundry-core/node/book';
import { goToStep, readStepLedger, standForDocument } from '@owen/foundry-core/node/projects';
import { confirmUnapplied } from '@owen/foundry-core/node/doors-questions';
import { deleteLedgerStep, describeLedgerStepDelete, openStepDeleteDoor } from '@owen/foundry-core/node/doors-delete';
import { documentAtPositionAdmitted, documentAtStepAdmitted } from '@owen/foundry-core/node/doors-ledger';
import { recordsBusy } from '@owen/foundry-core/node/doors-library';
import type { BookOp, PendingStack } from '@owen/foundry-core/shared/ops';
import type { Asked, UnappliedAnswer, UnappliedWarning } from '@owen/foundry-core/shared/types';

export function registerBookDoors(): void {
  ipcMain.handle('ledger:read', (_event, projectDir: string) => readStepLedger(projectDir));
  ipcMain.handle('ledger:go', (_event, projectDir: string, stepId: string) =>
    goToStep(projectDir, stepId));
  /*
   * THE SAME MOVE, NAMED BY A DOCUMENT INSTEAD OF BY A ROW.
   *
   * `go` is the user pointing at a step; this is the user pointing at a document
   * and the app working out which step that is — the gesture behind "focusing a
   * tab moves the position back" (docs/WORKBENCH.md §6c). The resolution is
   * `standForDocument` (electron/projects.ts), beside the forward direction it has
   * to agree with, for the reason every other path in a project is composed there:
   * a renderer deciding for itself which step a file belongs to would be a second
   * opinion about the ledger, and the way that opinion goes wrong is that it
   * stands somebody on the import and then translates their scan.
   *
   * NO PATH IS ADMITTED HERE, and the difference from `document-at` is worth
   * saying out loud. That call ANSWERS with a path this process then has to let a
   * viewer open, so it adds it to the allow-list. This one is handed a path the
   * renderer already has open — the allow-list said yes to it when the document
   * was opened — and answers with rows. A handler that admitted whatever it was
   * given would be a door that grants access for being asked a question.
   */
  ipcMain.handle('ledger:stand-for', (_event, projectDir: string, filePath: string) =>
    standForDocument(projectDir, filePath));
  /*
   * MAIN RESOLVES IT, SO MAIN ADMITS IT — the same pairing the import's relocation
   * already makes (`document:relocated`, above), and for the same reason. The
   * renderer is about to point a viewer, the block editor and the metadata dialog
   * at this path, and every one of those doors asks the allow-list; a path the
   * renderer named for itself is a path this process never agreed to serve.
   *
   * NOT REMEMBERED AS A RECENT. Nothing was opened here: the person clicked a row
   * in the history of a book they already have open, and a library list that grew
   * a row per click of the Steps accordion would be bookkeeping about a gesture
   * that is meant to be free.
   */
  ipcMain.handle('ledger:document-at', (_event, projectDir: string) => documentAtPositionAdmitted(projectDir));
  /*
   * THE SAME ANSWER FOR A ROW NOBODY IS STANDING ON — Compare's document resolve.
   *
   * The column beside the live one is locked to a step the person picked, and a
   * step whose picture is a FILE (the import, a rendering) needs that file's path
   * before a viewer can be pointed at it. `document-at` cannot answer it: it reads
   * the pointer, and the pointer is by definition somewhere else while a
   * comparison is on screen.
   *
   * IT ADMITS WHAT IT ANSWERS, exactly as `document-at` does one door up and for
   * the identical reason: the renderer is about to point pdf.js at this path, and
   * a path the renderer named for itself is a path this process never agreed to
   * serve. The allow-list is the only thing standing between a compare column and
   * an arbitrary file, so the pairing — main resolves it, main admits it — is not
   * a convenience here, it is the whole gate.
   *
   * NOT REMEMBERED AS A RECENT, on `document-at`'s own rule: nothing was opened,
   * somebody put a second view on a row of a book they already have open.
   */
  ipcMain.handle('ledger:document-at-step', (_event, projectDir: string, stepId: string) =>
    documentAtStepAdmitted(projectDir, stepId));
  /*
   * THE QUEUE'S HALF OF THE CORRECTION DOOR.
   *
   * A translation appends to its records file for hours and a correction swaps
   * that whole file into place, so the door is shut while a run is producing it.
   * The queue knows and projects.ts must not import it; main, which composes the
   * door, hands the check in (`recordCorrection`, electron/projects.ts).
   *
   * IT USED TO BE HANDED TO TWO DOORS. The other one started from a cast EPUB's
   * path — a word edited in the iframe reader — and both it and the reader are
   * deleted (docs/RENDERER.md §7). There is one door onto a translation's words
   * now, and it is the pane's.
   */
  /*
   * THE BOOK ITSELF — the rows the renderer draws, off the file the reflow made.
   *
   * ONE CALL AND NO PATH CROSSES IT IN EITHER DIRECTION, which is the difference
   * from `document-at` one door up and is worth saying plainly. That handler
   * ANSWERS with a path a viewer then opens, so it admits it to the allow-list;
   * this one answers with the BOOK — blocks, chapters, measured type — and the
   * renderer never learns where any of it lives. There is nothing for it to open,
   * so there is nothing to admit.
   *
   * IT MAY SPAWN THE ENGINE, and that is the whole of what makes opening a read
   * position work on a library written before this format existed
   * (electron/book.ts says why the ensure and the migration are one path). It is
   * awaited rather than fired and forgotten: the caller is a pane with
   * `Opening the book…` on it and nothing else to show, so
   * a promise that resolved before the file existed would be a blank sheet with
   * no sentence on it.
   *
   * IT ANSWERS A FAILURE RATHER THAN REJECTING ONE, and the sentence it carries
   * is composed to be READ — it lands on the paper (RENDERER-DESIGN.md §5). The
   * paths that make a refusal actionable go to the terminal instead, which is the
   * house rule for every sentence in this app. The one thing that still rejects
   * is a directory that is not one of Home's projects: that is the gate refusing,
   * not the book being unavailable.
   */
  ipcMain.handle('book:load', (_event, projectDir: string) => loadBook(projectDir));
  /*
   * THE BOOK AS OF A NAMED STEP — the read Compare is built on.
   *
   * EVERYTHING `book:load` SAYS APPLIES HERE WORD FOR WORD: no path crosses it in
   * either direction, it may spawn the engine, it answers a failure rather than
   * rejecting one, and the single thing that still rejects is a directory that is
   * not one of Home's projects. The only difference is which row the replay is
   * resolved to, and that difference is a parameter the machinery underneath has
   * carried since translations began materialising at the landing — see
   * `loadBookAt` (electron/book.ts) for why this is one replay asked twice rather
   * than two replays.
   *
   * A STALE STEP ID IS A SENTENCE, not a rejection. The picker is drawn from a
   * ledger this window read a moment ago, and a delete can land in between; the
   * compare column has a sheet to put that sentence on, which is the same contract
   * every other failure of this family has.
   */
  ipcMain.handle('book:load-at', (_event, projectDir: string, stepId: string) =>
    loadBookAt(projectDir, stepId));
  /*
   * AND THE OTHER DIRECTION — the pane's stack, landed as a step.
   *
   * IT REJECTS WHERE `book:load` ANSWERS, which is the difference worth stating
   * at the door rather than only in the module. A load with nothing to show has an
   * empty sheet to put a sentence on; an Apply that fails has the person's changes
   * still in front of them, and the honest thing is a refusal they can act on
   * rather than a stack silently cleared. `applyBookOps` writes the file before
   * the step and takes the file back if the step will not land, so there is no
   * half-applied state for this handler to describe.
   */
  ipcMain.handle('book:amend', (_event, projectDir: string, ops: BookOp[]) =>
    amendBookOps(projectDir, ops));
  // A finished export, exploded and shown read-only — never a rejection a pane
  // cannot draw: every refusal is a sentence in the outcome.
  ipcMain.handle('book:view', (_event, target: string) => viewExportedBook(target));
  ipcMain.handle('book:apply', (_event, projectDir: string, ops: BookOp[]) =>
    applyBookOps(projectDir, ops));
  /*
   * AND THE THIRD DOOR ONTO THIS BOOK — a corrected paragraph on a TRANSLATED
   * position, which is not an op and must never become one.
   *
   * *"Translated edits are per-language record corrections."* (docs/RENDERER.md
   * §5.) `book:apply` records decisions about STRUCTURE — strike, category,
   * merge, split, chapter — and every one of those is as true of a translation as
   * of the book it came from, so they ride the ops chain unchanged. The WORDS are
   * the exception: they belong to the records file, which is the step's payload
   * and the truth the derived book is a pure function of, and a `text` op over one
   * would leave the same paragraph saying two things.
   *
   * IT REJECTS, like `book:apply` and for its reason, and it ANSWERS WITH THE
   * WHOLE BOOK — the correction is not visible until the derived book has been
   * made again, and making the pane ask a second time for a state this call
   * already produced would be two questions about one gesture.
   */
  ipcMain.handle('book:correct', (_event, projectDir: string, id: string, text: string) =>
    correctBookBlock(projectDir, id, text, recordsBusy));
  /*
   * ── THE WORKING STACK, ON DISK — three doors, and none of them is history ────
   *
   * Apply is what writes a STEP. These three write the thing that has not been
   * applied yet, so that no window closing, no crash and no glance at another tab
   * can be the reason somebody's afternoon is gone (user report, 2026-08-21: a
   * chapter renamed, a paragraph retyped, an EPUB exported without either, and
   * then the stack scrapped by a window nobody asked). `savePendingStack` is
   * called on a debounce from the pane, exactly as the light table's recipe is;
   * `readPendingStack` is asked once per open and refuses out loud rather than
   * adopting a stack made somewhere else; `clearPendingStack` has two callers and
   * both of them are a person speaking.
   *
   * THEY REJECT, on `book:apply`'s rule and for its reason: the changes are in
   * front of the person and a write that quietly did not happen is the failure
   * this family exists to end. The read is the one exception in spirit — it
   * answers a refusal rather than throwing one — because "there is something held
   * and it is not about this book" is a fact the pane has to say a sentence
   * about, not an error.
   */
  ipcMain.handle('book:pending-save', (_event, projectDir: string, stack: PendingStack) =>
    savePendingStack(projectDir, stack));
  ipcMain.handle('book:pending-read', (_event, projectDir: string) =>
    readPendingStack(projectDir));
  ipcMain.handle('book:pending-clear', (_event, projectDir: string) =>
    clearPendingStack(projectDir));
  /**
   * THE CARD IN FRONT OF EVERY ACT THAT WOULD RUN PAST WORK NOBODY APPLIED.
   *
   * ── OWEN'S RULING, VERBATIM (2026-08-22) ────────────────────────────────────
   *
   * *"if the user has 'this book' selected with un-applied changes, the export
   * option shouldnt be grayed out. but any action they take, whether it's
   * switching to a different step or narrating or anything at all, should ask if
   * they want to apply changes in a modal. discard/apply changes. if they hit
   * discard, it does whatever action they selected to the step theyre on after
   * dropping changes they made. if they hit apply changes, the action they select
   * is executed after applying all changes. and maybe there should be another
   * apply changes button somewhere obvious. the button on the side of the
   * workbench works but it isnt obvious"*
   *
   * Every clause of that has a home: the two buttons are here, the widened set of
   * acts is `UnappliedAct` and `UnappliedService`, "it does whatever action they
   * selected" is that service running the act after either answer, "shouldnt be
   * grayed out" is the make-act predicates NOT consulting the stack (they never
   * did, and it was checked rather than assumed), and the obvious button is at the
   * head of the book pane.
   *
   * ── Why this is a door and not four lines in the renderer ───────────────────
   *
   * Because the sentences are main's, which is this app's one rule about this one
   * card (`ConfirmService`: *"The one thing the renderer must never do to this
   * dialog is start writing its own copy"*). The renderer hands over the facts it
   * is the only holder of — how many changes are waiting, on which book, under
   * which act — exactly as `document:confirm-close` is handed `edits`, and main
   * composes.
   *
   * ── APPLY IS OFFERED FIRST, and it is the same Apply ────────────────────────
   *
   * The closing card's own argument: a dialog whose only route to keeping the
   * work is *cancel, find Apply, press again* has made the person do the app's
   * job. It is what Enter takes and Discard is last, which is this app's rule for
   * every card that can destroy something.
   *
   * ── AND THIS CARD CAN NOW DESTROY SOMETHING, WHICH IT COULD NOT BEFORE ──────
   *
   * The three-answer version was safe by construction: apply, or go on without
   * them, or cancel — every one of them left the stack on the page, and the
   * docblock that stood here said so and gave that as the reason nothing wore the
   * error colour. Discard changes that. This is the second gesture in the app
   * (the closing card's own Discard is the first) that throws unapplied work
   * away, so it wears the error colour, it is last, and the detail says out loud
   * that it is for good. The one that used to be safe-by-construction is now
   * safe-by-aiming, which is a weaker guarantee honestly stated rather than a
   * stale sentence about a card that no longer exists.
   *
   * ── ONE CARD, FIVE ACTS, TWO SENTENCES THAT VARY ────────────────────────────
   *
   * `runs` says what the act would be made from and `then` says what happens
   * after the answer. Everything else — the title, the count, the warning about
   * Discard, the way out — is identical wherever this is raised, because it is
   * one question and a person should not have to re-read it to find out whether
   * this is the same box they answered a minute ago.
   */
  ipcMain.handle(
    'book:confirm-unapplied',
    (_event, warning: UnappliedWarning): Asked<UnappliedAnswer> => confirmUnapplied(warning),
  );
  ipcMain.handle('ledger:describe-delete', (_event, projectDir: string, stepId: string) =>
    describeLedgerStepDelete(projectDir, stepId));
  openStepDeleteDoor();
  ipcMain.handle('ledger:delete', (_event, projectDir: string, stepId: string) =>
    deleteLedgerStep(projectDir, stepId));
}

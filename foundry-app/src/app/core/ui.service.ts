import { Injectable, inject, signal } from '@angular/core';

import { hosted } from './foundry';
import { NoticeService } from './notice.service';

/**
 * WHICH HOST ACT IS BEING CONFIGURED, AND WHAT IT WOULD RUN AGAINST.
 *
 * The three facts an invoke needs, held together because they are one decision:
 * a person pressed a particular operation from a particular row of a particular
 * book. Nothing about the operation itself is copied in — the id is looked up
 * against `HostOpsService` when the dialog draws, so the registry stays the one
 * authority on what an operation is called and what it asks.
 */
export interface HostOpRequest {
  /** The host's own operation id — what `host-ops:invoke` names. */
  operationId: string;
  /** The book, as a project directory. */
  projectDir: string;
  /**
   * WHAT THE ACT WAS ORDERED FROM: a ledger step id, one of the host's own node
   * ids, or the step an export was made from. Foundry does not interpret it; the
   * host minted or recognises it. See `HostOperation.invoke`.
   */
  nodeId: string;
}

/**
 * What the mint metadata dialog was opened OVER — the two doors Owen named:
 * minting a new EPUB from a project, or re-stamping a finished export the
 * person is looking at. Discriminated on `mode` so the component cannot read
 * a mint's input path off an edit or vice versa.
 */
export type MintMetaRequest =
  | {
    mode: 'mint';
    /** The book, as a project directory. */
    projectDir: string;
    /** The document the Export dialog was aimed at — what the plan resolves. */
    inputPath: string;
  }
  | {
    mode: 'edit';
    projectDir: string;
    /** The finished export, absolute — what the stamp rewrites in place. */
    path: string;
    /** Its basename, for the card's Document row. */
    file: string;
  };

/**
 * The chrome's own state: which dialog is up, and whether the shelf is unrolled.
 *
 * The OCR tool used to be a slide-out panel beside the viewer and a toggle in
 * the rail. It is a MODAL now: configuring a conversion is a decision you make
 * once and dismiss, not a thing you keep open beside the document, and the panel
 * was spending 320 pixels of a book's width on four fields.
 */
@Injectable({ providedIn: 'root' })
export class UiService {
  /** The one reader `confirmQueued` routes to hosted — see there. */
  private readonly notices = inject(NoticeService);

  /** The OCR dialog — read the pages, and nothing else. */
  readonly ocrOpen = signal(false);
  /**
   * The Export dialog — turn a reading into a document you can take away.
   *
   * The other half of what OCR used to be. They are separate because they cost
   * different things: reading is hours of GPU and is held for a Start button,
   * exporting is arithmetic over a bank that is already paid for and runs the
   * moment it is asked for.
   *
   * IT WAS CALLED GENERATE, and the rename is a ruling rather than a coat of
   * paint (docs/WORKBENCH.md §6). A generate produced a file into the working
   * directories and left the user to work out what it was FOR; an export is
   * terminal — it is the finished thing, it lands in the project's `final/`, and
   * it is never anybody's parent. Renaming the button without moving the landing
   * would have been the same confusion with better spelling.
   */
  readonly exportOpen = signal(false);
  /** The Translate dialog. */
  readonly translateOpen = signal(false);
  /**
   * The Simplify dialog — say the book again, in the language it is already in.
   *
   * ITS OWN SIGNAL RATHER THAN A MODE ON THE ONE ABOVE, even though what it
   * enqueues is a translate job. The two dialogs ask different questions of a
   * person: one asks which language, the other asks which of three rewrites and
   * for whom. A single card that switched half its fields on a toggle would be
   * asking somebody to configure a job before they have said which job it is.
   */
  readonly simplifyOpen = signal(false);
  /** The Metadata dialog — the book's own record, not the app's idea of it. */
  readonly metadataOpen = signal(false);
  /**
   * The Sweep — a census of one pattern across the open book, verdicted (Wave 45).
   *
   * IT IS A DIALOG LIKE THE FIVE ABOVE AND IT IS ABOUT SOMETHING ELSE ENTIRELY,
   * which is worth saying here because the difference decides what it may do.
   * Those five configure an ACT against the position — a reading, a translation,
   * an export, a record — and each of them consumes the ledger, which is why each
   * is asked about unapplied work before it opens. This one stages MORE unapplied
   * work onto the very pane the person is standing in front of: it reads
   * `BookStack.view()`, it lands `BookStack.push()`, and the tray's Apply is
   * untouched by it. So there is no `clearedHere` in front of it and there must
   * not be one (docs/SWEEP.md §1) — a card asking somebody to apply their edits
   * before making more of the same kind is a card that has misread its own act.
   */
  readonly sweepOpen = signal(false);
  /**
   * The Analysis dialog — read this book against the categories (docs/ANALYSIS.md).
   *
   * IT IS ONE OF THE FIVE THAT CONFIGURE AN ACT AGAINST THE POSITION, so it looks
   * like Translate and behaves like it: a checklist, a model, an endpoint, and a
   * held job at the end of it. WHAT IT DOES NOT HAVE is a sensitivity control, and
   * that is a ruling rather than an omission (Owen, 2026-08-25): the run captures
   * once at the widest calibrated net and strictness is three buttons on the PANEL,
   * so changing your mind costs a click and never an hour.
   *
   * AND IT TAKES NO `clearedHere`, which puts it with the sweep rather than with
   * the other four. The guard protects acts that CONSUME a rendering; this run
   * reads the book file and writes a report beside it, consuming no rendering and
   * moving no pointer (docs/ANALYSIS.md §7, decided explicitly).
   */
  readonly analysisOpen = signal(false);

  /** Naming a book before photographing it. See CaptureNewDialogComponent. */
  readonly captureNewOpen = signal(false);
  /**
   * WHICH IMAGES THE NAMED BOOK IS BEING MADE FROM — empty for the plain door.
   *
   * The dialog above asks one question ("what book is this?") on behalf of two
   * gestures: *Photograph a book…* on Home, which makes an empty project to
   * shoot into, and *Create new book…* on the intake workspace, which makes one
   * and moves photographs into it. Same question, same card, same one-shot name;
   * what differs is what is standing behind it, and that is these ids.
   *
   * ── WHY IT IS NOT A `null`-IS-SHUT REQUEST LIKE `hostOpOpen` ────────────────
   *
   * Because it is not the thing that opens the dialog — the boolean above is,
   * and the boolean is in `dialogs` where the one-question-at-a-time rule can
   * reach it. Making the payload the opener would take the card out of that list
   * and leave `only()` with one dialog it does not know how to close.
   *
   * THE STALE-PAYLOAD TRAP `hostOpOpen` WARNS ABOUT IS SHUT BY AN INVARIANT
   * INSTEAD: `openCaptureNew` is the only way in and it ALWAYS writes this,
   * defaulting to empty. So the card cannot be opened against a selection
   * somebody made ten minutes ago, whatever route it was closed by — including
   * `only()` closing it from under another dialog, which clears the boolean and
   * leaves this set until the next opener overwrites it.
   */
  readonly captureNewFrom = signal<readonly string[]>([]);
  /**
   * THE HOST'S OWN OPERATION DIALOG — the only one of these that carries data.
   *
   * ── Why it is a request and not a boolean ───────────────────────────────────
   *
   * Every other dialog in this list is opened against THE POSITION: the export
   * card, the translate card and the metadata card all work out for themselves
   * what book they are about, because there is one selection and it is the
   * ledger's. A host operation cannot — it is named by an id the host registered,
   * aimed at a node the person pressed it from, and the same operation pressed on
   * two different rows is two different runs. So what opens it is the whole
   * question: which operation, in which project, from which node.
   *
   * NULL IS SHUT. There is no second boolean to keep in step with the payload,
   * which is the failure a `{ open: boolean; request: … }` pair invites — an open
   * dialog with a stale request is a form that would start the wrong run.
   *
   * IT IS HOST-AGNOSTIC ALL THE WAY DOWN: nothing here names an operation, a
   * kind, or a word like "narrate". The dialog draws what the offer says.
   */
  readonly hostOpOpen = signal<HostOpRequest | null>(null);
  /**
   * The one confirmation, asked before anything is erased (ConfirmService).
   *
   * IN THE LIST BELOW, BUT ONLY ONE DIRECTION OF THE RULE IS ABOUT IT. The
   * service sets this signal DIRECTLY rather than through `only()`, deliberately
   * and with its reasons written where it does it (`ConfirmService.put`): a
   * question is asked ABOUT the gesture that raised it, the re-read question is
   * raised from inside the OCR card by the very button that would enqueue the
   * run, and a card that took the OCR dialog away in order to ask about it would
   * answer a question nobody asked. So this one opening closes nothing. It does
   * not have to: the confirm draws in its own layer above every other dialog
   * (`z-index: 1300`, ConfirmDialogComponent), so drawing over one is exactly as
   * modal as replacing it.
   *
   * WHAT MEMBERSHIP BUYS IS THE OTHER DIRECTION. Every other opener goes through
   * `only()` and therefore clears this — and the service turns that into the
   * question's own dismissal answer, so a dialog opening over an unanswered
   * question cannot leave a caller holding a promise nobody will ever settle.
   * "Somebody closed it" becomes "they said no".
   */
  readonly confirmOpen = signal(false);
  /**
   * Whether the queue's dropdown panel is hanging under its chip.
   *
   * IT WAS `shelfExpanded`, AND THE RENAME IS THE POINT. There is no shelf: the
   * docked bottom-right pill is deleted and the queue is a chip in the top-right
   * corner with a panel under it (Owen's ruling, quoted in full at the head of
   * `QueueBarComponent`). A signal still called `shelfExpanded` would be the
   * exact trap this codebase keeps refusing — a name describing furniture nobody
   * can find, which the next person reads as evidence that the furniture is
   * still there.
   *
   * NOT IN THE ONE-QUESTION LIST BELOW, and never was. That list is for MODALS,
   * because a modal is a question and only one can be asked at a time. This is a
   * report about work already under way: opening a dialog must not shut it, and
   * it must not shut a dialog.
   */
  readonly queueOpen = signal(false);

  /**
   * Whether first-run setup is on screen.
   *
   * NOT IN THE ONE-QUESTION LIST, for the same reason the queue panel is not:
   * that list is for MODALS, and a modal is a question. Setup is a FLOW — five
   * steps, each of which starts work that outlives the step it was started from
   * — and `only()` would let any dialog opened on top of it silently clear the
   * boolean, which for a wizard mid-download reads as the app throwing away
   * what somebody was in the middle of.
   *
   * It does sit ABOVE every dialog (z-index 1250, the capture-progress rung),
   * because on first run there is nothing behind it worth reaching, and below
   * the confirm card at 1300 so a "this model is too big for your machine, are
   * you sure" still lands on top of the screen that asked it.
   *
   * TWO THINGS OPEN IT. The shell, once, on a machine whose `setup:state` says
   * it has never been through this — and the settings screen's button, which is
   * what makes every skip recoverable rather than permanent.
   */
  readonly setupOpen = signal(false);

  openSetup(): void {
    this.setupOpen.set(true);
  }

  closeSetup(): void {
    this.setupOpen.set(false);
  }

  /**
   * Whether the open-documents panel is up.
   *
   * ON by default, and it still shows nothing until there is a document — the
   * panel is hidden outright while the app is empty (see App), so Home keeps the
   * whole window it has always had rather than opening beside 220 pixels of an
   * empty list.
   *
   * OFF, IT IS A 30-PIXEL STUB rather than nothing, and the stub holds the
   * button that brings it back — in the top-left corner of the window, which is
   * where the button that put it away was. Three things press this: that button,
   * Ctrl+B on the View menu, and the dock's Documents item. A panel with only a
   * keyboard chord to bring it back is a panel people lose.
   *
   * IN MEMORY ONLY, like the panes' widths: which panels are open is an
   * arrangement for the work in front of you, and restoring last week's is
   * furniture arriving in the wrong room.
   */
  readonly documentsShown = signal(true);

  toggleDocuments(): void {
    this.documentsShown.update((shown) => !shown);
  }

  /**
   * What the queue should say out loud, and a nudge to take focus.
   *
   * TWO SIGNALS RATHER THAN A METHOD CALL ON THE COMPONENT, because the queue
   * bar is mounted by the shell and the OCR dialog has no handle on it — and
   * should not: a dialog reaching into another component to move its focus is
   * exactly the wiring that stops working the first time either of them moves.
   *
   * `queueSaid` is a live region's text: it is read by whatever is listening
   * when it changes, and it exists because the confirmation line the OCR dialog
   * used to leave on screen went away with the dialog. A change that is only
   * visible is a change a screen reader user was simply not told about. The
   * region moved from the shelf to the queue bar with the rest of the chrome;
   * the signal is the same signal, renamed off the furniture that went.
   *
   * `focusStartAt` is a counter and not a boolean. Two conversions queued in a
   * row have to move focus twice, and a flag that was already true the second
   * time would move it once — the classic shape of "it works, except when you
   * do it twice". It aims at Start, which is now inside the dropdown panel; the
   * bar's own effect is what waits for that panel to exist before focusing.
   */
  readonly queueSaid = signal('');
  readonly focusStartAt = signal(0);

  announce(said: string): void {
    this.queueSaid.set(said);
  }

  /**
   * A DIALOG JUST PUT WORK ON THE QUEUE — the one door through which every
   * dialog opens the queue panel, and the place the hosted rule lives.
   *
   * STANDALONE, this is the behaviour the dialogs always had, spelled once
   * instead of four times: open the panel, and for the OCR dialog move real DOM
   * focus to Start, since a held read's next press is exactly that button (the
   * counter's own docblock carries why it is a counter). What it opens changed
   * in Wave 43 — it was a pill in the bottom-right corner unrolling upward, and
   * it is a dropdown under the top-right chip — and not one caller had to learn
   * that, which is what having one door is for.
   *
   * HOSTED, IT DOES NOTHING, because hosted THERE IS NO FOUNDRY QUEUE SURFACE
   * AT ALL — Owen's ruling, 2026-08-21, verbatim: *"when im in bookforge, the
   * shelf shouldnt appear at all. thats the hangup. bookforge should be using
   * its own queue."* The add was routed to the host's queue (Wave 16), the
   * host's own chrome announces it, and the host's queue page releases a held
   * read (traced end to end by the host side, same day). The gate is here AND on
   * the bar's own render AND on the queue route, because a summons with nobody
   * home and a home nobody can summon are two halves of one rule, and a caller
   * cannot be trusted to remember the half it does not draw.
   */
  summonQueue(focus: boolean): void {
    if (hosted()) return;
    this.queueOpen.set(true);
    if (focus) this.focusStartAt.update((count) => count + 1);
  }

  /**
   * "DID THAT WORK?" HAS AN ANSWER IN BOTH WORLDS — the confirmation a dialog
   * owes the person after Add, routed to whichever surface this window has.
   *
   * The gap this closes was made by two right decisions crossing (found by the
   * host side, 2026-08-22, before anybody hit it): hosted there is no queue
   * surface — so no live region, its <p> went with the component — and the
   * host's own queue chrome lives in its main window, not in this pane. So a
   * hosted Add closed the dialog into silence, and the job started minutes
   * later on a card the person cannot see from here. The old undismissable
   * panel was wrong in the other direction, but it did answer the question.
   *
   * HOSTED, THE NOTICE BAR IS THE SURFACE — this app's own idiom for "a
   * sentence about what just happened", already in every window and gated by
   * nothing. STANDALONE, the sentence goes to the queue bar's live region
   * exactly as before; the panel the caller also opens is the visible half.
   * One door rather than a hosted() branch in four dialogs, because four
   * copies of one routing rule is the drift shape this repo keeps refusing.
   */
  confirmQueued(said: string): void {
    if (hosted()) this.notices.notice.set(said);
    else this.announce(said);
  }

  /**
   * ONE AT A TIME. Every dialog is a full-screen scrim at the same z-index, so
   * two open at once is two overlapping cards where the click-outside of the
   * upper one dismisses nothing visible. Opening any of them closes the rest
   * rather than stacking — a modal is a question, and there is only ever one
   * being asked.
   *
   * The rule is kept by ONE list rather than by each opener naming its
   * siblings. With two dialogs the hand-wired form was three lines; with a
   * third it is the shape of a bug, because the failure is silent — a new
   * dialog somebody forgot to clear in one of the other openers looks fine
   * until two happen to be opened in that order.
   */
  private readonly dialogs = [
    this.ocrOpen,
    this.exportOpen,
    this.translateOpen,
    this.simplifyOpen,
    this.metadataOpen,
    this.captureNewOpen,
    this.sweepOpen,
    this.analysisOpen,
    this.confirmOpen,
  ] as const;

  private only(which: typeof this.dialogs[number] | null): void {
    for (const dialog of this.dialogs) dialog.set(dialog === which);
    /*
     * AND THE TWO REQUEST-SHAPED DIALOGS, WHICH ARE NOT IN THE LIST BECAUSE
     * THEY ARE NOT BOOLEANS. They obey the same rule — a modal is a question
     * and there is only ever one being asked — so every opener clears them,
     * and they are cleared here rather than in each opener for the reason the
     * list exists at all: a sibling somebody forgot to clear is a bug that
     * only appears in one order.
     */
    this.hostOpOpen.set(null);
    this.mintMetaOpen.set(null);
  }

  /**
   * `from` is the workspace images the new book is being made of, or nothing at
   * all for the plain "photograph a book" door. Written on every open — see
   * `captureNewFrom` for why that default is the whole of the safety.
   */
  openCaptureNew(from: readonly string[] = []): void {
    this.captureNewFrom.set([...from]);
    this.only(this.captureNewOpen);
  }

  closeCaptureNew(): void {
    this.captureNewOpen.set(false);
    // Cleared on the way out as well as written on the way in, so nothing else
    // can read a selection off a card that is not on screen.
    this.captureNewFrom.set([]);
  }

  openOcr(): void {
    this.only(this.ocrOpen);
  }

  closeOcr(): void {
    this.ocrOpen.set(false);
  }

  openExport(): void {
    this.only(this.exportOpen);
  }

  closeExport(): void {
    this.exportOpen.set(false);
  }

  openTranslate(): void {
    this.only(this.translateOpen);
  }

  closeTranslate(): void {
    this.translateOpen.set(false);
  }

  openSimplify(): void {
    this.only(this.simplifyOpen);
  }

  closeSimplify(): void {
    this.simplifyOpen.set(false);
  }

  /**
   * Ask the host's own questions before running one of its acts.
   *
   * `only(null)` CLOSES EVERY OTHER DIALOG AND OPENS NONE OF THEM, which is how
   * this one joins the rule without joining the list: the booleans all go false,
   * and then the request is set. Passing null rather than adding a seventh entry
   * keeps `dialogs` what it says it is — the signals that are just open-or-shut.
   */
  openHostOp(request: HostOpRequest): void {
    this.only(null);
    this.hostOpOpen.set(request);
  }

  closeHostOp(): void {
    this.hostOpOpen.set(null);
  }

  openMetadata(): void {
    this.only(this.metadataOpen);
  }

  closeMetadata(): void {
    this.metadataOpen.set(false);
  }

  /**
   * The mint metadata dialog — who the book says it is, confirmed at the mint
   * or re-stamped onto a finished export (Owen's ruling, 2026-08-24; the
   * component carries it). Like the host-op dialog it holds a REQUEST rather
   * than a boolean, so it joins the one-modal rule through `only(null)`
   * without joining the boolean list.
   */
  readonly mintMetaOpen = signal<MintMetaRequest | null>(null);

  openMintMeta(request: MintMetaRequest): void {
    this.only(null);
    this.mintMetaOpen.set(request);
  }

  closeMintMeta(): void {
    this.mintMetaOpen.set(null);
  }

  openSweep(): void {
    this.only(this.sweepOpen);
  }

  closeSweep(): void {
    this.sweepOpen.set(false);
  }

  openAnalysis(): void {
    this.only(this.analysisOpen);
  }

  closeAnalysis(): void {
    this.analysisOpen.set(false);
  }

  /*
   * THERE IS NO `openConfirm()`. It was `only(confirmOpen)` and it never had a
   * caller: the one thing that raises the confirmation sets the signal itself,
   * because going through `only()` would close the dialog the question is about
   * (see `confirmOpen` above, and `ConfirmService.put`). A public opener that
   * does the one thing this dialog must never do is a trap left lying for the
   * next person to reach for the obvious-looking method.
   */
  closeConfirm(): void {
    this.confirmOpen.set(false);
  }
}

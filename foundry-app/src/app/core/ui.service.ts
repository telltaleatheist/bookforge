import { Injectable, signal } from '@angular/core';

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
 * The chrome's own state: which dialog is up, and whether the shelf is unrolled.
 *
 * The OCR tool used to be a slide-out panel beside the viewer and a toggle in
 * the rail. It is a MODAL now: configuring a conversion is a decision you make
 * once and dismiss, not a thing you keep open beside the document, and the panel
 * was spending 320 pixels of a book's width on four fields.
 */
@Injectable({ providedIn: 'root' })
export class UiService {
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

  /** Naming a book before photographing it. See CaptureNewDialogComponent. */
  readonly captureNewOpen = signal(false);
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
  readonly shelfExpanded = signal(false);

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
   * What the queue shelf should say out loud, and a nudge to take focus.
   *
   * TWO SIGNALS RATHER THAN A METHOD CALL ON THE COMPONENT, because the shelf is
   * mounted by the shell and the OCR dialog has no handle on it — and should
   * not: a dialog reaching into another component to move its focus is exactly
   * the wiring that stops working the first time either of them moves.
   *
   * `shelfSaid` is a live region's text: it is read by whatever is listening
   * when it changes, and it exists because the confirmation line the OCR dialog
   * used to leave on screen went away with the dialog. A change that is only
   * visible is a change a screen reader user was simply not told about.
   *
   * `focusShelfAt` is a counter and not a boolean. Two conversions queued in a
   * row have to move focus twice, and a flag that was already true the second
   * time would move it once — the classic shape of "it works, except when you
   * do it twice".
   */
  readonly shelfSaid = signal('');
  readonly focusShelfAt = signal(0);

  announce(said: string): void {
    this.shelfSaid.set(said);
  }

  focusShelf(): void {
    this.shelfExpanded.set(true);
    this.focusShelfAt.update((count) => count + 1);
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
    this.confirmOpen,
  ] as const;

  private only(which: typeof this.dialogs[number] | null): void {
    for (const dialog of this.dialogs) dialog.set(dialog === which);
    /*
     * AND THE HOST-OP DIALOG, WHICH IS NOT IN THE LIST BECAUSE IT IS NOT A
     * BOOLEAN. It obeys the same rule — a modal is a question and there is only
     * ever one being asked — so every opener clears it, and it is cleared here
     * rather than in each of them for the reason the list exists at all: a
     * sibling somebody forgot to clear is a bug that only appears in one order.
     */
    this.hostOpOpen.set(null);
  }

  openCaptureNew(): void {
    this.only(this.captureNewOpen);
  }

  closeCaptureNew(): void {
    this.captureNewOpen.set(false);
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

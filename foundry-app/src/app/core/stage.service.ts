import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { fold } from '@shared/original';

import { OpenDocumentsService, type Tab } from './documents.service';
import { LedgerService } from './ledger.service';

/**
 * WHAT IS ON SCREEN — one document, or Home.
 *
 * ── The service the single-viewer ruling made possible ──────────────────────
 *
 * There was nothing to put here while the workspace was one to five COLUMNS,
 * because "what is on screen" was not a fact: it was a list of columns, a focused
 * one among them, a strip of tabs inside each, and a pinned flag deciding which
 * of them a click was allowed to displace. "The document" meant "the focused
 * column's top tab", which is a fact about FURNITURE, and every action in the app
 * keyed off it. The user ended that (2026-08-17):
 *
 *   *"i dont think we should have tabs in foundry. i think its making things a
 *   bit confusing. however, the user should be able to compare two steps
 *   sometimes. so i think the solution is to have a single viewer window/single
 *   tab, and if the user wants to compare two steps, theres a compare button
 *   they can click and then they can choose the step to compare."*
 *
 * With one viewer the question has one answer, and this class is that answer plus
 * the three gestures that move it: Home, Ctrl+Tab, and putting a document in
 * front of somebody. Compare (docs/PLAN.md §4, unit 8d) landed here too — a
 * second, read-only stage beside the live one — which is the other reason this is
 * a service and not two computeds on the documents list.
 *
 * THAT SECOND STAGE IS A UNION NOW, and it is worth saying at the top because it
 * is the one piece of state on this class that two features share. The analysis
 * hits panel takes the same slot (docs/ANALYSIS.md §8, Owen: *"a list of hits in
 * blocks on the right side, where compare would normally be"*), so `secondColumn`
 * holds one or the other and `compare`/`analysis` are narrowings of it. Two
 * signals would have let both be open, in a row whose whole layout rule is "two
 * equal halves or one whole".
 *
 * ── The dependency arrow, and why it never runs back ────────────────────────
 *
 * Notice ← Documents ← **Stage** ← PositionSync (docs/PLAN.md §4, unit 8c). This
 * file reads and calls `OpenDocumentsService`; that file knows nothing about this
 * one. The thing that makes that possible is `active` being a COMPUTED rather
 * than a signal this class writes and maintains: closing a document is a fact
 * about the LIST, and the moment the list stops holding what the pointer names,
 * the stage answers Home by construction. `OpenDocumentsService.close` therefore
 * has nothing to tidy up, and cannot forget to.
 *
 * THE RAW POINTER LIVES ONE SERVICE DOWN, and that is the one thing about this
 * arrangement worth reading twice. Every door that opens a document ends by
 * putting it in front of the person — `adopt`, `relocate`, `openFinished`,
 * `openExportView`, `openAwaitedBooks` — and four of those five are driven by an
 * IPC callback or by an effect of the documents service, so there is no caller to
 * hoist the showing up to this class. Rather than have that file announce an
 * intention for this one to act on (a wire with a delay in it where a signal
 * write used to be), the raw write stays where the doors are and the MEANING
 * stays here. See `OpenDocumentsService.pointer`.
 */
/**
 * WHAT THE SECOND COLUMN IS, WHEN THERE IS ONE — one of exactly two things.
 *
 * ── Why a union and not two nullable signals ────────────────────────────────
 *
 * Because the workspace's layout rule is *"two equal halves or one whole"* (the
 * standing ruling, argued in the `.row` styles) and two independent signals can
 * be true at once. A union cannot: the panel and the comparison occupy one slot,
 * and opening either puts the other away by construction rather than by every
 * call site remembering to. docs/ANALYSIS.md §8 names this shape for exactly that
 * reason.
 *
 * BOTH MEMBERS CARRY THE SAME TWO FIELDS, and that is not an argument for
 * collapsing them into one record with a `kind`. They mean different things: a
 * comparison's step is a row of the book to be drawn read-only beside the live
 * one, and an analysis's step is the row whose PAYLOAD is a report about the book.
 * Discriminating them is what stops a column resolving one as the other — and it
 * is what makes `compare` and `analysis` below narrowings rather than guesses.
 */
export type SecondColumn =
  | { kind: 'compare'; projectDir: string; stepId: string }
  | { kind: 'analysis'; projectDir: string; stepId: string };

@Injectable({ providedIn: 'root' })
export class StageService {
  private readonly documents = inject(OpenDocumentsService);
  /**
   * The ledger, read for ONE question: does the second column's step still exist?
   *
   * It is what makes `secondColumn` below a computed rather than a signal somebody
   * has to remember to clear — see its docblock. Nothing else on this class
   * touches the ledger, and the position stays `PositionSyncService`'s subject
   * entirely: this asks whether a row is in a list, not what the book is standing
   * on.
   */
  private readonly ledger = inject(LedgerService);

  /**
   * THE ONE DOCUMENT ON SCREEN, by id — the single source the whole window reads.
   *
   * NULL IS HOME: nothing is open, the person pressed the rail's Home button, or
   * the document that was showing has been closed. The last of those three is the
   * reason this is a computed — see the class docblock.
   *
   * IT VALIDATES ON READ AND NOT ON WRITE. A stale pointer (a document closed
   * while it still named it) is not an error to be repaired, it is Home; and
   * repairing it would mean the documents service reaching up into this one after
   * every close, which is the dependency this whole split exists to remove.
   */
  readonly active = computed<string | null>(() => {
    const id = this.documents.showing();
    return id !== null && this.documents.byId(id) !== null ? id : null;
  });

  /**
   * The DOCUMENT the user is working on — the tab behind `active()`.
   *
   * TWO NAMES FOR ONE THING, and the second one is what everything outside this
   * file reads: the rail's Translate, the OCR dialog's source, Ctrl+S, the
   * window's title. `active()` is the id, for the surfaces that only have to
   * compare one (the rail's Home button asks whether it is null).
   */
  readonly activeDocument = computed<Tab | null>(() => this.documents.byId(this.active()));

  /**
   * The project this window is in — set by looking at any of its documents,
   * kept when the last of them closes, cleared only by leaving on purpose.
   */
  readonly heldProject = signal<string | null>(null);

  /**
   * WHAT IS IN THE SECOND COLUMN, as the person asked for it — the raw wish.
   *
   * SESSION-ONLY AND DELIBERATELY NOT PERSISTED: a second column is a thing you
   * set up for the question you are asking right now, and a window that reopened
   * yesterday's would be furniture arriving in a room nobody arranged. It is also
   * never more than ONE — this is not the panes coming back (docs/PLAN.md §4,
   * unit 8d) — which is why it is a nullable record and not a list.
   *
   * THE PROJECT RIDES WITH THE STEP because a step id alone is not enough to know
   * whether the wish is still about the book on screen. Somebody comparing two
   * rows of one book and then clicking a DIFFERENT book in the library has left
   * the comparison behind; carrying only the id would leave a column open over a
   * step belonging to a project nobody is looking at.
   *
   * ── AND IT IS A UNION, WHICH IS WHAT MAKES THE TWO EXCLUSIVE BY CONSTRUCTION ─
   *
   * *"The hits panel takes compare's slot… behind a `StageService` discriminated
   * union so the two are mutually exclusive by construction and the clearing rules
   * stay a computed, not a thing call sites remember."* (docs/ANALYSIS.md §8.)
   *
   * The alternative — a second nullable signal beside this one — is the shape that
   * fails silently: two columns opened in the wrong order, a workspace row with
   * three children in it, and a layout rule ("two equal halves or one whole") that
   * is true of every case anybody happened to test. One signal cannot hold two
   * things, so opening either puts the other away without anybody remembering to.
   */
  private readonly second = signal<SecondColumn | null>(null);

  /**
   * THE SECOND COLUMN, VALIDATED — null unless it is still about a real step of
   * the book in front of the person.
   *
   * ── Every clearing rule the brief asks for, made structural ─────────────────
   *
   * A second column has to end in three ways, and a signal somebody has to
   * remember to clear would have three call sites to keep true. It is a computed
   * instead, on exactly the precedent `active` above set: derive it and the rules
   * cannot be forgotten.
   *
   *   THE LIVE DOCUMENT CLOSED, or the person pressed Home — `activeDocument()`
   *   is null, so there is no project to be looking at a second view within, so
   *   this is null.
   *
   *   THE SHOWN DOCUMENT'S PROJECT CHANGED — they clicked another book. The
   *   recorded directory no longer matches the live one and the column goes with
   *   the book it belonged to.
   *
   *   THE STEP WAS DELETED — the ledger this window holds no longer has a row
   *   with that id. A delete rewrites the held ledger (`LedgerService` re-reads on
   *   `projects:changed`, which every delete fires), so the row vanishing from the
   *   list IS the announcement, read where it lands rather than subscribed to
   *   somewhere else and hoped for.
   *
   * ALL THREE ARE ASKED OF BOTH ARMS, and that is the point of extending this
   * computed rather than writing a second one beside it. An analysis panel is
   * pointed at an analysis STEP — the row whose payload is the report — so
   * "deleted while the panel was open" is the identical fact about the identical
   * list, and a second implementation of it would be a second chance to leave a
   * column open over a row that is gone.
   *
   * A LEDGER THIS WINDOW HAS NOT READ YET IS NOT A CLEAR. `historyFor` answers
   * null while a project's history is still in flight, and treating that silence
   * as "the step is gone" would close the column somebody just opened. The wish
   * survives an unread ledger and is judged the moment there is a list to judge it
   * against — the same shape `standForTab`'s first-focus guard uses.
   */
  readonly secondColumn = computed<SecondColumn | null>(() => {
    const wish = this.second();
    if (wish === null) return null;
    const tab = this.activeDocument();
    if (tab === null) return null;
    const dir = this.documents.projectDirOf(tab);
    if (dir === null || fold(dir) !== fold(wish.projectDir)) return null;
    const history = this.ledger.historyFor(wish.projectDir);
    if (history === null) return wish;
    return history.ledger.steps.some((step) => step.id === wish.stepId) ? wish : null;
  });

  /**
   * THE COMPARISON — the validated second column, when it is one.
   *
   * A NARROWING OF `secondColumn` AND NOT A SECOND STATE, which is what lets every
   * caller Compare already had go on reading exactly what it read before: the
   * shape is the same record, the three clearing rules are the same rules, and a
   * window with the analysis panel up answers null here without anybody having
   * written a rule saying it should.
   */
  readonly compare = computed<{ projectDir: string; stepId: string } | null>(() => {
    const which = this.secondColumn();
    return which?.kind === 'compare' ? { projectDir: which.projectDir, stepId: which.stepId } : null;
  });

  /** The hits panel, on the same terms — the analysis step whose report it draws. */
  readonly analysis = computed<{ projectDir: string; stepId: string } | null>(() => {
    const which = this.secondColumn();
    return which?.kind === 'analysis' ? { projectDir: which.projectDir, stepId: which.stepId } : null;
  });

  /**
   * Put a second, read-only column beside the live one, locked to this step.
   *
   * THE PROJECT IS TAKEN FROM WHAT IS ON SCREEN rather than passed in, and that is
   * what makes the picker's job small: a caller has a row of the ledger it is
   * already drawing for the document in front of the person, so the only thing it
   * can honestly name is the row. Nothing to compare against means nothing
   * happens — with no document up there is no book for a second column to be a
   * second view OF.
   */
  startCompare(stepId: string): void {
    this.open('compare', stepId);
  }

  /**
   * The ✕ on the compare column. Nothing is closed; a second view is put away.
   *
   * IT CLEARS ONLY A COMPARISON, which is the one line the union added and the one
   * that keeps this identical for every caller it already had. Pressing ✕ on a
   * column that is not there cannot now take away the column that is.
   */
  stopCompare(): void {
    this.close('compare');
  }

  /**
   * Put the hits panel where compare would go — Owen's own words for the slot:
   * *"a list of hits in blocks on the right side, where compare would normally
   * be."*
   *
   * `startCompare`'s body, and deliberately so: the project comes from what is on
   * screen, an empty stage does nothing, and opening this puts a comparison away
   * because one signal cannot hold both.
   */
  startAnalysis(stepId: string): void {
    this.open('analysis', stepId);
  }

  /** The ✕ on the analysis panel. See `stopCompare` for why it names its own kind. */
  stopAnalysis(): void {
    this.close('analysis');
  }

  /**
   * The same wish, from a caller that KNOWS the project — the tree's analysis
   * card.
   *
   * `open` reads the project off the document on screen because the head-row
   * picker can honestly name nothing else. The tree can: its row carries the
   * project directory the ledger row belongs to, and deriving from the screen
   * instead would put the click in a race the tree already lost once — its acts
   * go through `stand()`, which moves the pointer without awaiting a tab, so
   * "what is on screen" at click time may be yesterday's document or nothing.
   * The wish is set with the row's own facts and the validated computed does
   * what it exists to do: the column appears the moment the person is looking
   * at that project's document, and never over anybody else's.
   */
  startAnalysisAt(projectDir: string, stepId: string): void {
    this.second.set({ kind: 'analysis', projectDir, stepId });
  }

  private open(kind: SecondColumn['kind'], stepId: string): void {
    const tab = this.activeDocument();
    if (tab === null) return;
    const dir = this.documents.projectDirOf(tab);
    if (dir === null) return;
    this.second.set({ kind, projectDir: dir, stepId });
  }

  private close(kind: SecondColumn['kind']): void {
    this.second.update((held) => (held?.kind === kind ? null : held));
  }

  constructor() {
    /*
     * THE PROJECT THE WINDOW IS IN, remembered past its last document. Closing
     * everything used to bounce the window to Home, which reads as being thrown
     * out of the room you were working in (user ruling, 2026-08-16): the
     * workspace now keeps the project — its tree stays up, its empty bench says a
     * step is one click away — until the person leaves for the library on purpose
     * (`releaseProject`). Written from an effect on the shown document rather
     * than at close time, because "the project you were in" is a fact about what
     * was shown, not about what was shut.
     */
    effect(() => {
      const tab = this.activeDocument();
      if (tab === null) return;
      const dir = this.documents.projectDirOf(tab);
      if (dir !== null) this.heldProject.set(dir);
    });
  }

  /**
   * PUT A DOCUMENT IN FRONT OF THE USER — the one door onto the viewer.
   *
   * A click on its row in the library, a step whose document is already open, a
   * finished job. All of them mean the same thing now, which is why they all call
   * this and why it takes nothing but an id.
   *
   * ── What it used to have to decide ──────────────────────────────────────────
   *
   * It took two more arguments and reached a private `place` behind them:
   * `replace` (the library's auto-close rule, which closed whatever the column had
   * been showing unless it was pinned) and `intoPane` (the column this book
   * already lived in, so that a project's faces did not scatter across the
   * window). Both were answers to "WHICH of the five", and the single-viewer
   * ruling deletes the question. Replacing is the only behaviour, and it needs no
   * flag to be the only behaviour.
   *
   * NOTHING IS CLOSED BY REVEALING. A document displaced from the screen keeps
   * its tab, its unpack, its edits and its dot, and is one click away in the
   * library; closing it is the ✕, which is a different gesture with a different
   * question attached.
   *
   * AN ID THIS WINDOW DOES NOT HOLD IS A NO-OP rather than a null screen — see
   * `OpenDocumentsService.show`, which is where that refusal lives.
   */
  reveal(tabId: string): void {
    this.documents.show(tabId);
  }

  /**
   * The rail's Home. Home is "the viewer is showing nothing", not a document.
   *
   * NOTHING IS CLOSED. Every document is still open, still listed in the library,
   * and one click from coming back — which is a better Home than the one that
   * emptied the workspace, because it does not make somebody go and find their
   * book in the list again to undo pressing a button.
   */
  goHome(): void {
    this.documents.show(null);
  }

  /** Leaving for the library, on purpose — the one thing that clears the hold. */
  releaseProject(): void {
    this.heldProject.set(null);
  }

  /**
   * Ctrl/Cmd+Tab. Walks THE FLAT LIST, wrapping — every open document in the
   * order the library draws them. Answers the document it landed on.
   *
   * IT HAS MEANT THREE THINGS AND THIS IS THE HONEST ONE. Before the columns it
   * walked the flat list and pulled the next document into the one place there
   * was; with the columns it had to skip whatever another column held (taking one
   * would have swapped two columns' contents rather than advanced one); with the
   * strips it walked the focused column's own strip and left the other four
   * columns' documents alone. All three were the best a chord called "next tab"
   * could do in the arrangement it found. There is one viewer and one list now, so
   * the chord means exactly what it says.
   *
   * FROM HOME IT SHOWS THE FIRST DOCUMENT, which is what `-1` wrapping to `0`
   * gives: with nothing on screen and books open, "next" has an obvious answer and
   * refusing to give it would be the chord pretending the list is empty.
   *
   * ── AND IT ANSWERS THE ID RATHER THAN MOVING THE POSITION ITSELF ────────────
   *
   * Stepping from the scan to the book with a keystroke is the same statement as
   * clicking the row, so the position has to follow — but the mirror that does
   * that (`PositionSyncService.standForTab`) sits ABOVE this service in the
   * dependency chain, and calling it from here would run the arrow backwards. So
   * the chord's raiser does both halves, which is exactly the shape the other
   * gesture already had: the workspace's own pointerdown reveals nothing and
   * calls `standForTab` itself. Two callers, one pattern, no cycle.
   *
   * NULL FOR AN EMPTY WINDOW, so a caller with nothing to mirror can tell.
   */
  nextTab(): string | null {
    const tabs = this.documents.tabs();
    if (tabs.length === 0) return null;
    const at = tabs.findIndex((tab) => tab.id === this.active());
    const next = tabs[(at + 1) % tabs.length];
    if (next === undefined) return null;
    this.reveal(next.id);
    return next.id;
  }

  // ── The verbs that mean "the document in front of me" ────────────────────

  /**
   * Ctrl/Cmd+W.
   *
   * IT LIVES HERE AND NOT WITH `close`, and the placement is the split's own
   * rule rather than a convenience. `OpenDocumentsService.close` takes an id and
   * knows nothing about what is on screen; the word ACTIVE is this service's
   * whole subject. Three verbs made that trip — this, Save and Save As — because
   * each is a thin sentence of the form "the thing in front of me, then the
   * documents service's own door".
   */
  async closeActive(): Promise<void> {
    const tab = this.activeDocument();
    if (tab) await this.documents.close(tab.id);
  }

  /** The menu's Save. The document in the viewer. */
  async saveActive(): Promise<void> {
    const tab = this.activeDocument();
    if (tab === null) return;
    /*
     * CTRL+S OVER AN EXPORT VIEW SAVES A COPY — the user's own reading of the
     * chord (2026-08-16). The tab's file is finished and already filed in the
     * project's tray; "save" over it can only mean "put a copy where I choose",
     * which is the export door's dialog. Both chords say it, because Save and
     * Save As collapse to one meaning over a file this app will never rewrite.
     */
    if (tab.viewOnly === true) {
      await this.documents.saveExportCopy(tab);
      return;
    }
    await this.documents.save(tab.id);
  }

  /** The menu's Save As. */
  async saveActiveAs(): Promise<void> {
    const tab = this.activeDocument();
    if (tab === null) return;
    if (tab.viewOnly === true) {
      await this.documents.saveExportCopy(tab);
      return;
    }
    await this.documents.saveAs(tab.id);
  }
}

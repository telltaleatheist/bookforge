import { Injectable, inject, signal } from '@angular/core';

import { unwritten } from '@shared/ops';
import type { BookOp, PendingStack, Replayed } from '@shared/ops';
import { fold } from '@shared/original';

import { LedgerService } from './ledger.service';
import { NoticeService } from './notice.service';
import type { Tab } from './documents.service';
import { api } from './foundry';

/**
 * THE BOOK VIEWER'S STACK, as everything outside that viewer needs it.
 *
 * ── Why a wire exists at all, when the selection deliberately has none ──────
 *
 * The book viewer keeps its selection to itself on a stated rule: surface-local
 * state stays local until something else genuinely needs it, and a wire with
 * nothing on either end is worse than no wire. The stack is the case where
 * something else does need it, and TWO things do.
 *
 * THE UNDO CHORD IS ROUTED, not listened for. Ctrl+Z is a menu accelerator that
 * main swallows on its way past, and the renderer decides which of the undos a
 * chord meant — a text box's, or the book's (`MenuAction`, shared/api.ts).
 * `replay` is where that decision is made, and a global key listener added by the
 * viewer would be a second answer fighting the first.
 *
 * AND CLOSING IS ASKED ABOUT IN ONE PLACE. `questionBefore` (OpenDocumentsService)
 * is the one dialog a closing tab gets, on this codebase's own ruling that a
 * person shutting a book is asked once about everything it costs. That question
 * has to be able to see the stack — and, because a card whose only route to
 * keeping the work is *cancel, find Apply, close again* has made the user do the
 * app's job, it has to be able to press Apply too.
 *
 * WHAT THAT QUESTION IS ABOUT CHANGED ON 2026-08-22. It used to report a real
 * destruction: the stack was memory and nothing else, and "Apply writes and
 * clears; closing without applying scraps it" was the ruling (docs/RENDERER.md
 * §3). A real project then lost real work to exactly that — the pane's changes
 * were never applied, an export came out silently without them, and the stack
 * went with a window that closed without the card ever being drawn — and Owen
 * reversed it: unapplied work is never silently scrapped. The stack is written to
 * a sidecar as it is made (the bottom half of this file) and put back the next
 * time the book is opened at the same step, so the card now asks whether to
 * RECORD the work, and only its own Discard throws anything away.
 *
 * IT IS AN INTERFACE THE VIEWER IMPLEMENTS rather than state this service holds,
 * which is the whole of what keeps the ruling intact: the ops still live in the
 * component that makes them, and what crosses the boundary is a set of questions
 * and a set of verbs.
 *
 * ── AND NOW THE PANELS, WHICH IS WHY IT GREW ────────────────────────────────
 *
 * Notes, Furniture review and Chapters live in the app shell and keep its dark
 * style (RENDERER-DESIGN.md §5), which puts them OUTSIDE the viewer whose stack
 * their every gesture pushes onto. A panel that kept its own list of notes would
 * be a second account of the book — the exact failure the replay exists to make
 * impossible — so what crosses here is the viewer's OWN replay, read as a signal,
 * and one verb that puts ops on the viewer's own stack. Undo, redo and Apply then
 * take a panel's decision back exactly as they take a decision made on the paper,
 * because there is one stack and it is the viewer's.
 *
 * THE SELECTION CROSSED WITH THEM, and it crossed as a QUESTION rather than as
 * state. The viewer's own rule was that its selection stays local *until something
 * else genuinely needs it* — "the day the inspector can act on it, it moves up".
 * That day is this one: "a chapter starts at the selected block" is a panel
 * button about a block picked on the paper. It is still the viewer's signal, still
 * in no undo stack and still gone on a reload; the panel reads it and cannot
 * write it.
 */
export interface BookStack {
  /** How many changes are waiting with no Apply behind them. */
  pending(): number;
  /** True when there is anything to take back. Both directions, for the notice. */
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  /** Land the stack as a step. Resolves false when main refused; the sentence is its own. */
  apply(): Promise<boolean>;
  /**
   * THROW THE STACK OFF THE PAGE — the pane's half of the sanctioned scrap.
   *
   * The other half is the sidecar, and neither half is optional: clearing the
   * file while the pane still held the ops would have written them straight back
   * on the next gesture's debounce, and clearing the pane while the file held
   * them would have offered them again as a recovery on the next open. So this
   * is never called on its own — `discardUnapplied` below is the door, and it
   * presses both.
   *
   * IT RETURNS TO THE RECORDED BOOK rather than to an empty page. The stack
   * begins life as a copy of the tip's own ops (see the viewer's `load`), so
   * "discard what has not been applied" means "put the list back to what the
   * disk says", which is also the only reading under which an amendment's
   * undone-below-the-boundary ops come back.
   */
  discard(): void;
  /**
   * THE BOOK AS THE SHEET IS DRAWING IT — the file with the chain and the stack
   * replayed, and null while the viewer is still opening.
   *
   * A SIGNAL READ, so a panel calling it inside a computed repaints with the
   * paper. It is the viewer's own `view()` and not a copy of it: the rows the
   * Notes panel lists and the rows on the sheet are one array, so the two cannot
   * disagree about what this book says.
   */
  view(): Replayed | null;
  /** The blocks picked on the paper. Read-only, and never a fact about the book. */
  selected(): ReadonlySet<string>;
  /**
   * True when the ops own the divisions — the first chapter op takes the list
   * over and `reset` hands it back (`Replayed.chapters`).
   *
   * The panel needs it twice: to say whose list the rows are, and to know whether
   * "Use Foundry's" has anything to give back. A reset pushed over a seed already
   * in force would be a row in somebody's history recording a change that changed
   * nothing.
   */
  chaptersOwned(): boolean;
  /** Ops onto the same stack the gestures on the paper push onto. */
  push(ops: readonly BookOp[]): void;
  /** Put a block in the middle of the sheet and pulse it — the panels' jump. */
  reveal(id: string): void;
}

/** What a viewer leaves behind when its tab stops being the one on screen. */
export interface ParkedStack {
  /** The tab's revision when parked — a move while parked bumps it. */
  revision: number;
  landed: readonly BookOp[];
  pending: readonly BookOp[];
  undone: readonly BookOp[];
}

/**
 * THE REGISTRY OF OPEN BOOK STACKS, and the one place the undo chord is routed.
 *
 * ── Why it is a service of its own ──────────────────────────────────────────
 *
 * It came out of `TabsService` with the rest of unit 8c (docs/PLAN.md §4), and it
 * is the piece with the cleanest edge of the five: it knows about a MAP KEYED BY
 * TAB ID and about nothing else in the window. No list, no pointer, no position,
 * no opening or closing. That is why it may be depended on by the documents
 * service — the closing question has to be able to count what a close would scrap
 * — without that dependency ever running back the other way.
 *
 * IT DEPENDS ON THE NOTICE AND NOTHING ELSE. `Tab` arrives as a TYPE (erased at
 * emit, so no module cycle with the service that owns it) and the tab itself
 * arrives as an ARGUMENT: `undo`/`redo` are handed the document in front of the
 * user by whoever raised the chord, because "what is on screen" is the stage's
 * question and asking it here would be this service reaching up the chain it sits
 * at the bottom of.
 */
@Injectable({ providedIn: 'root' })
export class BookStacksService {
  private readonly notices = inject(NoticeService);
  /**
   * The history mirror, for the ONE apply this service now owns.
   *
   * ── Why this dependency, when the class was proud of having none ────────────
   *
   * Because "what would be lost" and "land it" were being answered in two places
   * and one of them was about to become three. The closing question counted a
   * stack and pressed Apply for it (`questionBefore`, core/documents.service.ts);
   * the make-act gate needed the identical count and the identical press before
   * an export, and a second copy of "amend the tip or land a step" is exactly how
   * a dialog comes to disagree with the button that opened it. So the pair moved
   * HERE, where both halves of the answer already live — the live viewer's stack
   * and the parked one — and adopting the history main hands back is the one
   * thing that press cannot do without.
   *
   * IT DOES NOT WIDEN THE EDGE THIS CLASS DEFENDS. The map is still keyed by tab
   * id and this service still knows nothing about which document is on screen,
   * which tab is open or where any of them sit; `applyUnapplied` is handed the
   * tab, exactly as `undo` and `redo` are, for the same reason.
   */
  private readonly ledger = inject(LedgerService);

  constructor() {
    /*
     * THE WINDOW GOING AWAY IS AN EXIT LIKE ANY OTHER, and it is the one exit
     * that cannot wait 400ms — `CaptureService`'s own arrangement, for its
     * reason and now for a sharper one. Best effort and said plainly: this
     * cannot await, so it starts the write immediately rather than leaving it on
     * a timer, which turns "up to 400ms of unwritten work, guaranteed lost" into
     * "a write already in flight". The guarantee would have to be main refusing
     * to close while a stack write is outstanding, and that is a bigger change
     * than this defect earns.
     */
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => void this.flushPending());
    }
  }

  /**
   * The open book viewers' stacks, by tab id — see `BookStack`.
   *
   * A SIGNAL OF A MAP, AND IT USED TO BE A PLAIN ONE. The argument for the plain
   * map was that nothing DREW from it: the undo chord reads it the instant a chord
   * arrives and the closing question reads it the instant a tab goes, and both are
   * events rather than repaints. The panels ended that — Notes, Furniture and
   * Chapters are drawn in the shell out of the viewer's own replay, so the
   * inspector has to hear a viewer arrive and hear it leave, and a lookup in a
   * plain map inside a computed is a read of something that can change with
   * nothing to notice it.
   *
   * WHAT THIS IS NOT is a signal that a PUSH moves. The map answers which viewer
   * is in which tab; the ops behind `pending()` and the rows behind `view()` are
   * the viewer's own signals, reached through the entry. So a gesture on the paper
   * still repaints exactly what depends on it, and registering a viewer — twice
   * per tab, in a session — is what writes here.
   *
   * The viewer puts itself in on init and takes itself out on destroy, so an entry
   * here is always a viewer that exists — which is what lets every reader treat a
   * missing entry as "that book has nothing waiting" rather than as an error.
   */
  private readonly bookStacks = signal<ReadonlyMap<string, BookStack>>(new Map());

  /**
   * A BOOK VIEWER'S UNWRITTEN STACK, HELD WHILE ITS TAB IS NOT THE ONE SHOWN.
   *
   * Showing another tab DESTROYS the book component (the viewer renders one tab
   * at a time), and the first draft let the stack die with it — a glance at the
   * scan cost every strike since the last Apply (user report, 2026-08-16). The
   * ruling: the stack belongs to the TAB, not to the component's lifetime. The
   * viewer parks it here on destroy and claims it back on load; it is dropped when
   * the tab closes (after the closing question, which consults it — see
   * `questionBefore`) and let go with a notice when the position moved while it
   * was parked, because ops made against the book at one step are a delta against
   * a state the tab is no longer showing.
   *
   * A plain map: written at destroy, read at load and at close, drawn by nothing.
   */
  private readonly parkedStacks = new Map<string, ParkedStack>();

  /**
   * The viewer, on destroy, leaving its unwritten work with the tab.
   *
   * AND WITH THE DISK, IN THE SAME BREATH. Parking survives a glance at another
   * tab and nothing else — the map is this window's heap — so the same handful of
   * ops goes to the sidecar without waiting for the debounce that would otherwise
   * have carried it. A destroy is very often the last thing that happens before
   * the window does, and 400ms is a long time to be the only copy.
   */
  parkBookStack(tabId: string, held: ParkedStack): void {
    this.parkedStacks.set(tabId, held);
    void this.flushPending();
  }

  /** The viewer, on load, taking it back — a claim, so nothing is answered twice. */
  claimBookStack(tabId: string): ParkedStack | null {
    const held = this.parkedStacks.get(tabId) ?? null;
    this.parkedStacks.delete(tabId);
    return held;
  }

  /**
   * What a close would scrap, without taking it — the closing question's read.
   *
   * A CLAIM WOULD BE WRONG HERE and that is why this is a second door rather than
   * a reuse of `claimBookStack`: the question may be answered "keep", in which
   * case the tab stays open with its parked work exactly where it was, and a read
   * that emptied the map would have destroyed the thing the person just said they
   * wanted.
   */
  parkedFor(tabId: string): ParkedStack | null {
    return this.parkedStacks.get(tabId) ?? null;
  }

  /** The tab is going and the answer was not "keep" — the scrap the person chose. */
  dropParked(tabId: string): void {
    this.parkedStacks.delete(tabId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ONE COUNT AND ONE PRESS, for every surface that asks about unapplied work
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * WHAT IS WAITING ON THIS TAB'S BOOK, live viewer or parked — the one count.
   *
   * ── Why it is here and not restated at each caller ──────────────────────────
   *
   * There are three surfaces now: the pane's own Apply label, the closing card,
   * and the card before Export / Translate / Simplify / a host act. The first is
   * the pane's own `waiting()`; the other two used to be a hand-written pair of
   * branches inside the closing question, and a copy of that pair inside the gate
   * would have been two answers to "how much has not been applied" a refactor
   * away from disagreeing. `unwritten` (shared/ops.ts) is the arithmetic and this
   * is the routing: a live viewer answers for itself, a tab whose viewer is not on
   * screen answers out of its parked stack, and everything else is zero.
   *
   * ZERO FOR A TAB THAT IS NOT A BOOK, said by construction rather than by a
   * `kind` test: no other kind of tab ever registers a stack or parks one, so a
   * missing entry in both maps is already the honest answer.
   */
  unappliedIn(tabId: string): number {
    const live = this.bookStackFor(tabId);
    if (live !== null) return live.pending();
    const parked = this.parkedFor(tabId);
    return parked === null ? 0 : unwritten(parked.landed, parked.pending);
  }

  /**
   * LAND IT — the one press, whichever of the two holds the work.
   *
   * ── The amend-or-apply decision is made once, here ──────────────────────────
   *
   * A live viewer presses its own `apply`, which is the sheet's own button and
   * makes the decision inside the pane (`landedOps` non-empty means the position
   * is an amendable tip). A PARKED stack has no viewer to press anything, so the
   * same decision is made from the shape the park recorded — the doors are main's
   * either way (`book:amend` rewrites the tip, `book:apply` lands a step) and the
   * viewer was only ever the thing that pressed them.
   *
   * FALSE MEANS MAIN REFUSED AND THE WORK IS STILL THERE, which is what every
   * caller needs: the closing card leaves the tab open on it, and the make-act
   * gate does not start hours of work on it. Main's own sentence is already on the
   * notice strip saying why it would not land.
   *
   * THE PARKED STACK GOES ON SUCCESS AND ONLY ON SUCCESS. It has just been
   * recorded as a step, so a copy left in the map is a delta that would be
   * offered a second time against a book that already has it.
   */
  async applyUnapplied(tab: Tab): Promise<boolean> {
    const live = this.bookStackFor(tab.id);
    if (live !== null) return await live.apply();
    const parked = this.parkedFor(tab.id);
    if (parked === null || !api) return false;
    try {
      const history = parked.landed.length > 0
        ? await api.book.amend(tab.path, parked.pending)
        : await api.book.apply(tab.path, parked.pending);
      this.ledger.adopt(tab.path, history);
      this.parkedStacks.delete(tab.id);
      await this.discardPending(tab.path);
      return true;
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * DROP IT — the other answer to the unapplied card, and the one that destroys.
   *
   * ── THREE PLACES HOLD THIS STACK, AND ALL THREE HAVE TO LET GO ─────────────
   *
   * This is the whole of why it is a method here rather than two lines at the
   * call site. Unapplied work lives in up to three places at once and each of
   * them is a route by which "discarded" changes come back:
   *
   *  1. THE LIVE VIEWER's own `pending`/`undone` signals — what is on the paper
   *     in front of the person. `discard()` on the stack interface.
   *  2. THE PARKED STACK, when the pane is not the tab on screen. `dropParked`,
   *     which is the same door the closing question's `letGo` path uses.
   *  3. THE SIDECAR under the project, which is the copy that outlives the
   *     window. `discardPending`, which is `book:pending-clear`.
   *
   * The closing card's Discard reaches all three too, and it is worth saying how,
   * because it looks like it only reaches one: it awaits `discardPending`
   * (documents.service.ts, `questionBefore`), then `close` calls `dropParked`,
   * and the live viewer is destroyed by the tab going — its signals die with the
   * component and its destroy hook declines to park anything because the sidecar
   * has already been cleared under it. THAT LAST STEP IS THE ONE THIS PATH DOES
   * NOT GET. Nothing is closing here. The tab stays, the component stays, and a
   * viewer left holding the ops would put them back on the debounce and hand them
   * to the next Apply — so the in-memory drop is explicit, and it is first.
   *
   * ORDER MATTERS AND IT IS NOT ALPHABETICAL. The pane is emptied BEFORE the file
   * is cleared: `discardPending` cancels the outstanding debounced write and
   * deletes the project's entry from `owed`, so a pane that emptied itself first
   * can only have made that entry staler, never resurrected it. The reverse order
   * would leave a window in which a gesture (or the pane's own bookkeeping) could
   * write the doomed stack back after the file was gone.
   *
   * IT IS AWAITED, on `discardPending`'s own rule: the act the person chose runs
   * next, and for a position move that act ends in a load that ASKS FOR THIS
   * FILE. A clear still in flight would be a recovery card for work somebody just
   * threw away.
   */
  async discardUnapplied(tab: Tab): Promise<void> {
    this.bookStackFor(tab.id)?.discard();
    this.parkedStacks.delete(tab.id);
    await this.discardPending(tab.path);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // THE SIDECAR — unapplied work, on disk, continuously
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * WRITES OWED TO THE DISK, by folded project directory.
   *
   * ── Why the key is the project and not the tab ──────────────────────────────
   *
   * Because the FILE is per project (`ops/pending.jsonl`), and it is per project
   * because the position is: this app opens exactly one book tab per project
   * directory (`bookTabIn`, core/documents.service.ts — *"Never a second one"*)
   * and the pane draws whichever step the project's pointer is on. Keying by tab
   * would be a key that means the same thing with a spelling nothing on disk
   * shares, and folded because on Windows one directory arrives spelled three
   * ways.
   *
   * A MAP RATHER THAN ONE SLOT because parking flushes: the pane that is being
   * destroyed and the pane that is being built can both owe a write in the same
   * turn, and the two are different books.
   */
  private readonly owed = new Map<string, { dir: string; stack: PendingStack }>();
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The pane, after a gesture: what is waiting, for the disk.
   *
   * DEBOUNCED, AND THE RECIPE'S OWN NUMBER. A drag across nine blocks is nine
   * calls and only where it came to rest is worth writing; `SAVE_AFTER_MS` is the
   * light table's constant restated rather than shared, because these are two
   * files with two writers and a shared knob would tie one surface's feel to the
   * other's.
   *
   * THE LAST STATE WINS, which is what makes an undo expressible: taking a change
   * back is a change to what is waiting, and a write that only ever grew would
   * leave the disk holding decisions the person has taken off the page.
   *
   * A FAILED WRITE SAYS SO ONCE AND KEEPS THE PAGE. What is in memory is what
   * somebody is looking at, and throwing it away to match a disk that refused
   * would lose work to a transient error — the exact failure this file exists to
   * end, arriving from the other direction.
   */
  rememberPending(projectDir: string, stack: PendingStack): void {
    if (!api) return;
    this.owed.set(fold(projectDir), { dir: projectDir, stack });
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => { void this.flushPending(); }, SAVE_AFTER_MS);
  }

  /**
   * Write everything owed NOW, and wait for it — park, and the window going.
   *
   * Nothing owed is the ordinary case and costs one comparison, on
   * `CaptureService.flush`'s rule: the map is empty whenever the last write has
   * already gone.
   */
  async flushPending(): Promise<void> {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (this.owed.size === 0 || !api) return;
    const due = [...this.owed.values()];
    this.owed.clear();
    for (const one of due) {
      try {
        await api.book.pendingSave(one.dir, one.stack);
      } catch (err) {
        this.notices.notice.set(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * THROW THE HELD STACK AWAY — the one sanctioned scrap, and it is awaited.
   *
   * EVERY CALLER IS A PERSON SPEAKING, and there are three of them now. An Apply,
   * which has just recorded every one of these decisions as a step. The closing
   * card's Discard, which is somebody reading a sentence about what they are
   * about to lose and pressing the red button anyway. And, since Owen's
   * two-answer ruling (2026-08-22), the unapplied card's Discard, through
   * `discardUnapplied` above — the same red button in front of a different
   * question, and the reason that one is a method is that it has a live viewer to
   * empty as well. Nothing else in the app may reach any of this: the whole point
   * of the file is that no window closing, no crash and no glance at another tab
   * can.
   *
   * (There is one further clear, and it is not a person: the viewer's own `load`
   * clears the file after announcing that a position move let the stack go. That
   * is the same scrap this card now asks about, said out loud at the moment it
   * happens — and with the card in front of the move, it is what runs after
   * somebody has already answered Discard.)
   *
   * THE OUTSTANDING WRITE IS CANCELLED FIRST, and that is the correctness rather
   * than an optimisation: a debounced write still on the timer would land AFTER
   * the delete and put the scrapped stack straight back.
   *
   * IT IS AWAITED BY ITS CALLERS, which is why it is a promise. An Apply is
   * followed by a reload that asks for this very file, and a clear still in flight
   * when that read arrives is a recovery card for work that was just written down.
   */
  async discardPending(projectDir: string): Promise<void> {
    this.owed.delete(fold(projectDir));
    if (!api) return;
    try {
      await api.book.pendingClear(projectDir);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** The book viewer in this tab, announcing itself. Called once, on init. */
  registerBookStack(tabId: string, stack: BookStack): void {
    this.bookStacks.update((held) => new Map(held).set(tabId, stack));
  }

  /** And letting go, on destroy — an entry for a viewer that is gone answers for nothing. */
  releaseBookStack(tabId: string): void {
    this.bookStacks.update((held) => {
      const next = new Map(held);
      next.delete(tabId);
      return next;
    });
  }

  /**
   * The stack of the book viewer in this tab, or null for every other kind of tab
   * and for a book still opening.
   *
   * THE PANELS' ONE DOOR. Everything the inspector's three book sections draw and
   * everything they do goes through the returned interface, so the shell holds no
   * copy of the book and no second list of ops.
   */
  bookStackFor(tabId: string | null): BookStack | null {
    return tabId === null ? null : this.bookStacks().get(tabId) ?? null;
  }

  /**
   * Ctrl/Cmd+Z, from the Edit menu — for the document handed in, never a global
   * one.
   *
   * THE TAB IS AN ARGUMENT AND NOT A LOOKUP. It used to read `activeDocument()`
   * off the same class it lived in; with the split that answer belongs to
   * `StageService`, which sits ABOVE this service in the chain, so the chord's
   * raiser (App's key handler) asks the stage and hands the answer down. Null is a
   * legitimate value and gets the honest sentence: the chord arrived over Home.
   */
  async undo(tab: Tab | null): Promise<void> {
    await this.replay(tab, 'undo');
  }

  /** Ctrl/Cmd+Shift+Z. */
  async redo(tab: Tab | null): Promise<void> {
    await this.replay(tab, 'redo');
  }

  /**
   * Put one change back — which is now one stack, in one place.
   *
   * THERE WERE FIVE DOORS INTO THIS FUNCTION AND THERE IS ONE. The chord used to
   * be routed by what the shown tab was: a caret in an iframe took the typing
   * back, a scan replayed rows into the live curation, a cast book replayed them
   * into somebody's markup, and two of those three consulted a persisted ledger
   * on disk. All of it is deleted with the surfaces that had it
   * (docs/RENDERER.md §7). What is left is the proof sheet's LIFO of ops, held in
   * memory until Apply writes them down (§3) — so this is the one undo in the app
   * and it touches no disk at all: no ledger to read back, no file to put a row
   * into, nothing to await.
   *
   * IT IS STILL ASYNC, and deliberately: the menu action and the two public
   * wrappers are `Promise`-typed across the app, and narrowing them here would be
   * a signature change in five call sites to save one microtask.
   *
   * EVERY REFUSAL IS A SENTENCE, including "there is nothing to undo": the menu
   * item cannot grey itself out against renderer state, so a chord that quietly
   * did nothing would be indistinguishable from a chord that is broken.
   */
  private async replay(tab: Tab | null, direction: 'undo' | 'redo'): Promise<void> {
    if (!api || !tab) {
      this.notices.notice.set('There is no document in front of you to undo anything in.');
      return;
    }
    /*
     * THE BOOK'S STACK IS THE VIEWER'S, AND THE CHORD IS ROUTED TO IT.
     *
     * It is a LIFO of ops the pane works out of until Apply writes them down as
     * a step (docs/RENDERER.md §3), so this is the one undo in the app that
     * touches no disk ON ITS OWN PATH — no ledger to read back, no file to put a
     * row into, nothing to await. (The pane hands the result to `rememberPending`
     * afterwards, which writes the sidecar on a debounce; that is a copy being
     * kept up to date, not a step being recorded, and this function neither waits
     * for it nor knows about it.) What arrives here is a chord main swallowed as
     * a menu accelerator,
     * and this function is where the window decides which of its three undos it
     * meant; the viewer deliberately adds no listener of its own, because two
     * answers to one keypress is how a book and a text field end up both taking
     * one back.
     *
     * EVERY REFUSAL IS STILL A SENTENCE, which is this function's own rule: a
     * chord that quietly did nothing cannot be told from a chord that is broken.
     * "Nothing to undo" on a book that has never been touched and on a book whose
     * stack has just been applied are the same true statement, and both are worth
     * making — the second one especially, because Apply is exactly the moment
     * somebody's next instinct is Ctrl+Z.
     */
    if (tab.kind === 'book') {
      const stack = this.bookStackFor(tab.id);
      if (stack === null) {
        this.notices.notice.set(`${tab.title} is still opening.`);
        return;
      }
      if (direction === 'undo') {
        if (!stack.canUndo()) {
          this.notices.notice.set(
            `There is nothing to undo in ${tab.title}. Changes on the book are taken back until you `
            + 'apply them; applying makes them a row in Steps you can stand on instead.',
          );
          return;
        }
        stack.undo();
        return;
      }
      if (!stack.canRedo()) {
        this.notices.notice.set(`There is nothing to redo in ${tab.title}.`);
        return;
      }
      stack.redo();
      return;
    }
    /*
     * AND ANYTHING ELSE HAS NO STACK, which is the honest end of the routing
     * rather than a fall-through. A scan is a photograph and the app does not
     * edit one (docs/RENDERER.md §0 A1); the sentence names the surface that
     * does, because a chord that quietly did nothing is this function's own
     * definition of a failure nobody can act on.
     */
    if (tab.kind === 'capture') {
      /*
       * A LIGHT TABLE HAS NO STACK BY DESIGN, and the sentence has to say so
       * rather than send somebody to a book that does not exist yet. Corners,
       * splits, strikes and order are written to the recipe as they are made
       * (`CaptureService`, debounced), which is the opposite trade from the book
       * viewer's: nothing is held back, so there is nothing to take back.
       */
      this.notices.notice.set(
        `Changes to ${tab.title} are kept as you make them, so there is nothing to undo. `
        + 'Corners, splits and order can each be changed back by hand.',
      );
      return;
    }
    this.notices.notice.set(
      `There is nothing to undo in ${tab.title}. Changes are made on the book — open it from the `
      + 'step you want to work from, and undo takes them back until you apply them.',
    );
  }
}

/**
 * How long the stack has to stand still before it is written down.
 *
 * The light table's number, restated rather than imported: two files, two
 * writers, and a shared constant would tie one surface's feel to the other's the
 * first time either is tuned.
 */
const SAVE_AFTER_MS = 400;

import { Injectable, inject, signal } from '@angular/core';

import type { BookOp, Replayed } from '@shared/ops';

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
 * person shutting a book is asked once about everything it costs. The stack is in
 * memory and closing genuinely scraps it (docs/RENDERER.md §3), so that question
 * has to be able to see it — and, because a card whose only route to keeping the
 * work is *cancel, find Apply, close again* has made the user do the app's job, it
 * has to be able to press Apply too.
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

  /** The viewer, on destroy, leaving its unwritten work with the tab. */
  parkBookStack(tabId: string, held: ParkedStack): void {
    this.parkedStacks.set(tabId, held);
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
     * It is a LIFO of ops held in memory until Apply writes them down
     * (docs/RENDERER.md §3), so this is the one undo in the app that touches no
     * disk at all — no ledger to read back, no file to put a row into, nothing to
     * await. What arrives here is a chord main swallowed as a menu accelerator,
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
    this.notices.notice.set(
      `There is nothing to undo in ${tab.title}. Changes are made on the book — open it from the `
      + 'step you want to work from, and undo takes them back until you apply them.',
    );
  }
}

/**
 * book-view.wiring — what the constructor sets running, in the order it sets it running.
 */
import { DestroyRef, afterNextRender, computed, effect, input, signal, untracked } from '@angular/core';
import { unwritten, type ReplayedRow } from '@owen/foundry-core/shared/ops';
import { ChangesService } from '../../core/changes.service';
import { type BookStack } from '../../core/book-stacks.service';
import { ALIGNED_MIN_REM, MEASURE_REM, MEASURE_GRIP_PX, MEASURE_KEY } from './book-view.model';
import type { BookViewComponent } from './book-view.component';

export function announceStack(this: BookViewComponent, destroy: DestroyRef): void {
  /*
   * THE STACK, ANNOUNCED — see `BookStack` (core/book-stacks.service.ts) for the whole
   * argument. Four things outside this pane need it now: the undo chord, which
   * main swallows as a menu accelerator and the window routes; the closing
   * question, asked once per tab about everything closing costs; and the Notes,
   * Furniture and Chapters panels, which are drawn in the shell out of the very
   * replay the paper draws and push their ops onto this very list.
   *
   * WHAT CROSSES IS THIS PANE'S OWN SIGNALS, called rather than copied. A panel
   * reading `view()` inside a computed depends on the same graph the sheet does,
   * so the panel and the paper cannot come to different conclusions about what
   * this book says — there is nothing to keep in step, because there is only one
   * of it.
   */
  /*
   * ── GRAVESTONE: the many-blocks-dismiss effect (2026-08-23) ───────────────
   *
   * An effect stood here putting the glance card down whenever the selection
   * grew past one block — *"if multiple blocks are selected, it should not
   * show at all"* — the backstop behind `release`'s own refusals. The ruling
   * was about a CARD answering a question asked of one block; the docked
   * original panel answers "where am I in the scan", which a forty-block
   * selection has a perfectly good answer to. So the panel ignores the
   * selection's size, and the backstop went with the card it was backstopping.
   */

  const stacks = this.stacks;
  const stack: BookStack = {
    pending: () => this.waiting(),
    // The JOURNAL and not the ops stack: a corrected paragraph on a
    // translated position is undoable now, and it was never an op.
    canUndo: () => this.did().length > 0,
    canRedo: () => this.rewound().length > 0,
    undo: () => this.undo(),
    redo: () => this.redo(),
    apply: () => this.apply(),
    discard: () => this.discardStack(),
    view: () => this.view(),
    selected: () => this.chosen(),
    chaptersOwned: () => this.chaptersOwned(),
    push: (ops) => this.push(...ops),
    pushGroup: (what, ops) => this.pushAsOne(what, ops),
    /*
     * THE TRANSLATED PASS'S TWO MEMBERS, AND THEY ARE THE PANE'S OWN.
     *
     * `correct` is the private method the double-click editor commits through,
     * handed out rather than reimplemented: the one-in-flight guard, the load
     * ticket and the book refresh are all inside it, and an Ask run landing
     * fifty corrections in a row must obey exactly the rules one hand-typed
     * paragraph obeys. `translated` is the question that decides which of the
     * two doors an outside surface should be taking in the first place.
     */
    translated: () => this.translation() !== null,
    correct: (id, text) => this.correct(id, text),
    reveal: (id) => this.scrollTo(id),
    askStack: () => this.askStack(),
  };
  /*
   * IN AN EFFECT AND NOT ON THIS LINE, because a required input has no value
   * until the first change detection and the constructor runs before it. The
   * effect also happens to make the registration correct rather than merely
   * legal: a pane pointed at another tab lets go of the first id before it
   * claims the second, so no stack is ever answered for by a pane that has
   * stopped being about it.
   */
  let registered: string | null = null;
  effect(() => {
    const id = this.tab().id;
    /*
     * A COMPARED COLUMN REGISTERS NOTHING. The registry answers "which book
     * viewer is in this tab" for the undo chord and the closing question, and a
     * compare column is neither: it has no tab in the list to be closed, and
     * Ctrl+Z means the document in front of the person, which is the OTHER
     * column. Registering under a synthetic id would put an entry in the map
     * that nothing can reach and that a future reader would have to work out is
     * unreachable.
     */
    if (this.atStep() !== null) return;
    untracked(() => {
      if (registered === id) return;
      if (registered !== null) stacks.releaseBookStack(registered);
      stacks.registerBookStack(id, stack);
      registered = id;
    });
  });
  destroy.onDestroy(() => {
    if (registered !== null) stacks.releaseBookStack(registered);
    /*
     * UNWRITTEN WORK RIDES THE TAB, NOT THE COMPONENT. This pane dies every
     * time its pane shows another tab — a glance at the scan — and the stack
     * used to die with it (user report, 2026-08-16). Anything not yet on
     * disk (a differing stack, or a redo pile that could put ops back) is
     * parked with the tab and claimed by the next incarnation; `load` decides
     * whether it still applies. Nothing is parked when everything is
     * recorded, so the map stays the size of the abandoned work.
     */
    /*
     * AND NOT AFTER AN APPLY THAT HAS NOT COME BACK YET. `landed` is true
     * between a successful `book:apply` and the reload it causes (see its own
     * comment), and in that gap the stack still LOOKS unwritten: the ops are
     * still on `pending` and `landedOps` is still empty, because clearing
     * either one early would flash the unedited book. Closing the tab in that
     * gap — which is exactly what the closing card's Apply does — used to leave
     * a parked entry for a tab that no longer exists, which was a harmless leak
     * in a map. It stopped being harmless when parking began flushing to the
     * sidecar: the file would come back holding decisions main had just
     * recorded as a step, and the next open would offer them again as a delta
     * against a book that already has them.
     */
    if (registered !== null && !this.landed
      && (this.waiting() > 0 || this.undone().length > 0)) {
      stacks.parkBookStack(registered, {
        revision: this.tab().revision,
        landed: this.landedOps(),
        pending: this.pending(),
        undone: this.undone(),
      });
    }
  });
}

export function watchWidthAndAim(this: BookViewComponent, destroy: DestroyRef): void {
  /*
   * ── HOW WIDE THIS PANE IS, MEASURED, BECAUSE NOTHING ELSE KNOWS ───────────
   *
   * The aligned view is unavailable below a bench two sheets cannot breathe in
   * (`ALIGNED_MIN_REM`), and the only honest source for that number is this
   * element: the window holds a left nav, an inspector and a tab strip, every
   * one of which can be opened and shut, so a media query on the window would
   * answer for a width this surface never had. A `ResizeObserver` is one
   * observer for the life of the pane and it fires when the pane's box changes
   * for ANY of those reasons.
   *
   * The rem is read once, here, rather than per resize: it is the document's
   * font size and nothing in this app changes it while a window is open. Zero
   * until this runs, which is what makes the toggle refuse rather than guess
   * before anything has been laid out.
   */
  afterNextRender(() => {
    const root = getComputedStyle(document.documentElement).fontSize;
    const rem = Number.parseFloat(root);
    if (Number.isFinite(rem) && rem > 0) this.rem.set(rem);
    // The glance card's re-placement lived here too, once — a docked panel
    // has no placement to redo, so the observer is back to its one job.
    const watch = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) this.wide.set(box.width);
    });
    watch.observe(this.host.nativeElement);
    destroy.onDestroy(() => watch.disconnect());
  });

  /*
   * ── AND THE ANALYSIS PANEL IS AIMED THE MOMENT IT OPENS ───────────────────
   *
   * `toggleOriginal`'s rule, borrowed: *"a panel opened before any click or
   * scroll has ever aimed it would stand there saying 'The original' over no
   * page at all"*. The hits panel has the same problem in a worse form — it
   * opens over a book somebody is already halfway through, and a list that
   * starts at finding one while the reading is at page ninety is a list that has
   * to be searched before it can be used.
   *
   * IT WATCHES THE LIGHT AND NOT THE STAGE, because the light is the thing that
   * has to be DRAWN before a rect can be asked for: `hitLight()` going non-empty
   * is the report placed onto these very rows, and the frame after it is the
   * first one in which lit blocks exist in the DOM. `afterNextRender` is what
   * waits for that frame; reading a rect inside the effect itself would measure
   * the page as it was before the highlights landed.
   */
  effect(() => {
    const lit = this.analysis.lit();
    if (lit.size === 0) return;
    afterNextRender(() => this.followAnalysis(), { injector: this.injector });
  });

  /*
   * ── AND THE PULSE LETS GO WHEN ITS PASSAGE LEAVES THE PAGE ────────────────
   *
   * Owen's third deselect condition, verbatim: *"if i click the block, the text
   * block pulses until i click somewhere else or scroll offscreen."* The first
   * two are clicks (`release` here, and the panel's own); this is the third, and
   * it is watched HERE because the paper is the thing being scrolled — the
   * panel's card leaving the panel's own viewport means nothing, since the panel
   * follows the reading and moves that card itself.
   *
   * AN OBSERVER, AND THIS IS THE ONE PLACE ONE IS RIGHT. `followAnalysis` says
   * at length why an IntersectionObserver over the lit RUNS is the wrong
   * instrument — the runs are inside the `content-visibility: auto` wrapper and
   * a skipped subtree gives its descendants no boxes at all. A BLOCK always has
   * a box (the containment is on its wrapper, never on the block itself), so an
   * observer on the block is asking a question the browser can answer. And the
   * question here is genuinely a threshold rather than a position — "is it still
   * on screen" — which is what an observer is for and what a scroll walk would
   * have to re-derive per frame.
   *
   * IT WAITS TO SEE THE BLOCK ARRIVE BEFORE IT WILL LET GO. An observer fires
   * once on registration with the element's current state, and the selection is
   * very often made a frame before the travel that brings the block into view
   * (a click on a panel card calls `reveal` and this effect in the same turn).
   * Without `seen`, that first not-intersecting callback would cancel the
   * selection the click had just made.
   */
  effect(() => {
    const hit = this.analysis.selectedHit();
    this.watchSelection(hit?.spans[0]?.id ?? null);
  });
}

export function publishRows(this: BookViewComponent, destroy: DestroyRef): void {
  /*
   * ── THIS SHEET'S ROWS, PUBLISHED TO THE COMPARISON WHILE IT IS A PARTY ───
   *
   * The diff between the two columns is made in one place from both sheets'
   * OWN replayed rows (`ChangesService`, docs/COMPARE-CHANGES.md), and the
   * rows get there from here: the live pane writes `live`, the compare
   * column's pane writes `compared`, and each writes its `view()` — the chain
   * and the pending stack already replayed — so the light agrees with the
   * paper, strike by strike. The registry cannot carry this for the compare
   * column because that pane registers no stack, on purpose (the registration
   * effect above says why), so the publication runs from the pane outward.
   *
   * A PANE CLEARS ONLY WHAT IT WROTE. Two panes can be the live party in one
   * session (the viewer reuses this component across book tabs, and a compare
   * column is destroyed and rebuilt between steps), and a pane that nulled the
   * side on the way out would take out the rows its successor had just put
   * there. So the clear is conditional on the side still holding THIS pane's
   * last publication — identity against the array — and a stranger's rows are
   * left alone. `untracked`, because the write is to a signal a computed this
   * pane draws from depends on, and an effect that reads its own writes is a
   * loop.
   */
  let published: { side: 'live' | 'compared'; rows: readonly ReplayedRow[] | null } | null = null;
  const withdraw = (): void => {
    if (published === null) return;
    const held = this.changes[published.side];
    if (held() === published.rows) held.set(null);
    published = null;
  };
  effect(() => {
    const party = this.party();
    const rows = party === null ? null : this.view()?.rows ?? null;
    untracked(() => {
      if (published !== null && published.side !== party) withdraw();
      if (party === null) return;
      this.changes[party].set(rows);
      published = { side: party, rows };
    });
  });
  destroy.onDestroy(withdraw);
}

export function travelTogether(this: BookViewComponent): void {
  /*
   * ── AND BOTH PARTIES TRAVEL TOGETHER when the head's ↑↓ are pressed ──────
   *
   * The compare column's head walks the changed blocks and stamps
   * `ChangesService.reveal`; each party sees the stamp and scrolls ITSELF to
   * the block, through the same `scrollTo` a panel's jump uses. It is an
   * effect on the stamp's tick and not on its id, on `pointedAt`'s rule: the
   * same block pressed twice is a second journey. The tick is adopted on the
   * first run without travelling, so a pane built while a stamp is standing
   * (a compare column rebuilt between steps) does not set off toward a block it
   * has not loaded yet.
   */
  let seenTick: number | null = null;
  effect(() => {
    const wish = this.changes.reveal();
    const party = this.party();
    untracked(() => {
      if (wish === null) {
        seenTick = null;
        return;
      }
      if (seenTick === null) {
        seenTick = wish.tick;
        return;
      }
      if (wish.tick === seenTick) return;
      seenTick = wish.tick;
      if (party !== null) this.scrollTo(wish.id);
    });
  });
}

export function wireSurface(this: BookViewComponent, destroy: DestroyRef): void {
  /*
   * ── THE SCROLL LOCK'S LISTENERS, AND WHY THEY ARE NOT TEMPLATE BINDINGS ───
   *
   * An Angular event binding marks this view dirty every time it fires, and this
   * app is zoneless — so a `(scroll)` on the bench would put a change-detection
   * pass behind every frame of every drag of every book, on a sheet whose DOM is
   * the whole four hundred pages (there is no virtual scroller here;
   * `content-visibility` skips the PAINT and leaves the nodes). The lock writes
   * no signal and draws nothing — it moves one element's `scrollTop` — so there
   * is nothing for a change-detection pass to do, and the honest way to say that
   * is to stay outside the machinery that schedules one.
   *
   * ON THE HOST, IN THE CAPTURE PHASE, because scroll events do not bubble: an
   * ancestor sees them on the way DOWN or not at all. One pair of listeners for
   * the life of the pane, rather than a pair that has to be added and removed
   * every time a toggle is pressed or a window is dragged narrower.
   *
   * WHICH COLUMN IT WAS IS THE ELEMENT'S OWN CLASS. Anything else in this pane
   * that scrolls — the category menu is the only one — is neither, and is left
   * alone rather than mistaken for a column.
   */
  const surface = this.host.nativeElement;
  const which = (event: Event): 'live' | 'source' | null => {
    const target = event.target as HTMLElement | null;
    if (target === null || target.classList === undefined) return null;
    if (target.classList.contains('bench')) return 'live';
    return target.classList.contains('context') ? 'source' : null;
  };
  const scrolled = (event: Event): void => {
    const column = which(event);
    if (column !== null) this.scrolled(column);
    /*
     * AND THE ORIGINAL PANEL FOLLOWS THE LIVE COLUMN. Same discipline as the
     * lock around it: this runs per scroll frame, so it must cost nothing in
     * the ordinary case — `followOriginal` returns at once while the panel
     * is closed, and writes its signal only when the topmost block CHANGES,
     * which is a paragraph boundary and not a pixel.
     */
    if (column === 'live') this.followOriginal();
    /*
     * AND THE ANALYSIS PANEL FOLLOWS IT TOO, under the identical discipline —
     * `followAnalysis` returns at once while nothing is lit, and writes its
     * signal only when the finding nearest the fold CHANGES, which is a
     * paragraph boundary and not a pixel.
     */
    if (column === 'live') this.followAnalysis();

    /*
     * A WHEEL TURNS MID-MARQUEE and the pointer never moves, so no pointermove
     * fires and the sweep would freeze while the paper slides past it. The
     * scroll is the event that says the paper moved; the sweep re-runs with
     * the pointer where it last was, and the rectangle — anchored to the
     * PAPER, not the glass (`sweep`) — grows over everything scrolled past.
     */
    const held = this.pressed;
    if (held !== null && held.dragging && held.sheet !== null) {
      this.sweep(held.sheet, held.lastX, held.lastY);
    }
  };
  const settled = (event: Event): void => {
    const column = which(event);
    if (column !== null) this.settled(column);
  };
  /*
   * CTRL+WHEEL IS THE LOUPE (user ruling, 2026-08-16). It scales the paper's
   * own type through a custom property the stylesheet multiplies into the
   * sheet's font-size, so every em-derived measure — the measured ratios, the
   * gutter marks, the cards — scales with the words as one thing. Set
   * NATIVELY, no signal and no change-detection pass: zoom is presentation,
   * exactly like the scroll lock above, and this pane is zoneless. Clamped to
   * [0.6, 2.2]; the browser's own page-zoom stays on Ctrl+/- untouched.
   */
  let zoom = 1;
  const wheeled = (event: WheelEvent): void => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoom = Math.min(2.2, Math.max(0.6, zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)));
    surface.style.setProperty('--zoom', String(zoom));
  };
  /*
   * THE PAPER'S EDGE IS A HANDLE (Owen, 2026-09-22 — see the stylesheet's
   * §5 for the ruling). Native for the loupe's reason: a drag writes a width
   * every frame and a width is presentation. On the HOST IN CAPTURE so a
   * press on the edge is taken before the sheet's own `press` can start a
   * marquee from it, and so one set of listeners serves every sheet in either
   * column without the template growing a handle per sheet.
   *
   * CENTRED PAPER MOVES BOTH EDGES, so alone a pointer's travel is half the
   * change in width. Aligned, the pair stands centred on the gap between the
   * two sheets, which holds still while each sheet grows outward by the whole
   * change — so there the travel IS the change. Either way the edge follows
   * the hand for as long as the pane has room to give.
   */
  const measures: Record<'alone' | 'aligned', number> = {
    alone: MEASURE_REM.alone.opens,
    aligned: MEASURE_REM.aligned.opens,
  };
  try {
    const kept = JSON.parse(localStorage.getItem(MEASURE_KEY) ?? '{}') as Record<string, unknown>;
    for (const view of ['alone', 'aligned'] as const) {
      const rem = kept[view];
      if (typeof rem === 'number' && Number.isFinite(rem)) {
        measures[view] = Math.max(MEASURE_REM[view].floor, rem);
      }
    }
  } catch { /* no storage, or nothing sensible in it: the defaults stand */ }
  const paint = (view: 'alone' | 'aligned'): void => {
    surface.style.setProperty(`--measure-${view}`, `${measures[view]}rem`);
  };
  paint('alone');
  paint('aligned');

  const edgeUnder = (event: PointerEvent): { sheet: HTMLElement; side: 1 | -1 } | null => {
    const column = (event.target as Element | null)?.closest?.('.bench, .context');
    if (column === null || column === undefined) return null;
    for (const sheet of column.querySelectorAll<HTMLElement>(':scope > .sheet')) {
      const box = sheet.getBoundingClientRect();
      if (event.clientY < box.top || event.clientY > box.bottom) continue;
      if (Math.abs(event.clientX - box.right) <= MEASURE_GRIP_PX) return { sheet, side: 1 };
      if (Math.abs(event.clientX - box.left) <= MEASURE_GRIP_PX) return { sheet, side: -1 };
    }
    return null;
  };
  let measuring: {
    view: 'alone' | 'aligned';
    side: 1 | -1;
    x: number;
    from: number;
    ceiling: number;
    rem: number;
  } | null = null;
  const gripped = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const edge = edgeUnder(event);
    if (edge === null) return;
    event.preventDefault();
    event.stopPropagation();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const view = this.aligned() ? 'aligned' : 'alone';
    const pair = surface.querySelector<HTMLElement>('.pair');
    const room = pair?.clientWidth ?? surface.clientWidth;
    measuring = {
      view,
      side: edge.side,
      x: event.clientX,
      from: edge.sheet.getBoundingClientRect().width / rem,
      ceiling: Math.max(MEASURE_REM[view].floor, (view === 'aligned' ? room / 2 : room) / rem - 10),
      rem,
    };
    surface.setPointerCapture(event.pointerId);
  };
  const hovered = (event: PointerEvent): void => {
    const held = measuring;
    if (held === null) {
      // Only a free pointer is offered the handle: a marquee in progress
      // crossing the paper's edge is still a marquee.
      surface.classList.toggle('grip', event.buttons === 0 && edgeUnder(event) !== null);
      return;
    }
    const travel = (event.clientX - held.x) * held.side / held.rem;
    const width = held.from + travel * (held.view === 'aligned' ? 1 : 2);
    measures[held.view] = Math.round(Math.min(held.ceiling, Math.max(MEASURE_REM[held.view].floor, width)) * 10) / 10;
    paint(held.view);
  };
  const released = (event: PointerEvent): void => {
    if (measuring === null) return;
    measuring = null;
    surface.releasePointerCapture(event.pointerId);
    surface.classList.remove('grip');
    try {
      localStorage.setItem(MEASURE_KEY, JSON.stringify(measures));
    } catch { /* not kept: the width holds for this session regardless */ }
  };
  // A double-click on the edge puts that view's measure back where it opens.
  const reset = (event: MouseEvent): void => {
    if (edgeUnder(event as PointerEvent) === null) return;
    event.preventDefault();
    event.stopPropagation();
    const view = this.aligned() ? 'aligned' : 'alone';
    measures[view] = MEASURE_REM[view].opens;
    paint(view);
    try {
      localStorage.setItem(MEASURE_KEY, JSON.stringify(measures));
    } catch { /* as above */ }
  };

  surface.addEventListener('scroll', scrolled, { capture: true, passive: true });
  surface.addEventListener('scrollend', settled, { capture: true, passive: true });
  surface.addEventListener('wheel', wheeled, { passive: false });
  surface.addEventListener('pointerdown', gripped, { capture: true });
  surface.addEventListener('pointermove', hovered, { passive: true });
  surface.addEventListener('pointerup', released);
  surface.addEventListener('pointercancel', released);
  surface.addEventListener('dblclick', reset, { capture: true });
  destroy.onDestroy(() => {
    surface.removeEventListener('scroll', scrolled, { capture: true });
    surface.removeEventListener('scrollend', settled, { capture: true });
    surface.removeEventListener('wheel', wheeled);
    surface.removeEventListener('pointerdown', gripped, { capture: true });
    surface.removeEventListener('pointermove', hovered);
    surface.removeEventListener('pointerup', released);
    surface.removeEventListener('pointercancel', released);
    surface.removeEventListener('dblclick', reset, { capture: true });
  });
}

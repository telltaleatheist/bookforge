/**
 * book-view.gestures — the pointer on the sheet: press, sweep and release on blocks, and the draggable chapter rule.
 */
import { computed, untracked } from '@angular/core';
import { AnalysisViewService } from '../../core/analysis-view.service';
import { DRAG_SLOP } from './book-view.model';
import { cut } from './book-view.lines';
import type { BookViewComponent } from './book-view.component';

/**
 * A press on the sheet — the start of a click OR of a marquee, and which of
 * them it was is decided by whether the pointer moves.
 *
 * ONE GESTURE FOR BOTH, because from the hand's side they are one: press,
 * maybe move, let go. Deciding at pointerdown would mean guessing, and the
 * guess would be wrong exactly where the blocks are — which is everywhere on
 * this sheet, since a paragraph fills the column and there is almost no empty
 * paper to start a rectangle in.
 */
export function press(this: BookViewComponent, event: PointerEvent): void {
  if (event.button !== 0) return;
  /*
   * AND IN THE EDITION THERE IS NO GESTURE HERE AT ALL — not a flip, either.
   * A press is the start of a selection or of a marquee, and both of those are
   * chrome: there is no rail to raise, no chip to hang and no rectangle to
   * draw. It is not an EDIT gesture, so §5's "flips back to Workbench" is not
   * about it, and treating it as one would mean a preview nobody can click
   * anywhere on — including on the words they came to read. Standing aside
   * also leaves the browser's own selection alone, which the edition turns
   * back on.
   */
  if (this.edition()) return;
  const target = event.target as HTMLElement | null;
  const block = target === null ? null : target.closest('.block');
  /*
   * A PRESS INSIDE THE BLOCK BEING EDITED IS THE CARET'S, and nothing else's.
   * Selection and the marquee both take pointer capture, and a captured pointer
   * cannot place a caret or drag over a word — so while a block is live this
   * function stands aside for it entirely. Everywhere else on the sheet the
   * ordinary gestures still work, which is what makes a press on another
   * paragraph commit the edit (through the editor's own blur) and select that
   * paragraph in one movement.
   */
  const editing = this.editingId();
  if (editing !== null && block !== null && block.getAttribute('data-id') === editing) return;
  const marker = target === null ? null : target.closest('.marker');
  /*
   * AND WHETHER THE PRESS LANDED ON A FLAGGED PASSAGE. Read here, with the
   * marker and the jump, because this is where the sheet has always asked the
   * DOM what was under the pointer — by the time `release` runs the pointer may
   * be somewhere else entirely.
   *
   * THE GUARD IS STRUCTURAL AND NOT A BOOLEAN. There is no `.run[data-hit]` in
   * this DOM unless an analysis panel is open: the class and the attribute are
   * drawn from `hitLight()`, which is `AnalysisViewService.lit()`, which is
   * empty whenever the stage's second column is not an analysis. So "only when
   * the panel is open" is a fact about the markup rather than a condition
   * somebody has to remember to write, and nothing about block selection needs
   * a branch for the ordinary case.
   */
  const litRun = target === null ? null : target.closest('.run.hit[data-hit]');
  const sheet = event.currentTarget as HTMLElement;
  // The Delete key has to reach a marquee's selection, and a marquee focuses
  // nothing — see the sheet's own `tabindex` in the template.
  if (block === null) sheet.focus({ preventScroll: true });
  sheet.setPointerCapture(event.pointerId);
  const paper = sheet.getBoundingClientRect();
  this.pressed = {
    x: event.clientX,
    y: event.clientY,
    sheetX: event.clientX - paper.left,
    sheetY: event.clientY - paper.top,
    lastX: event.clientX,
    lastY: event.clientY,
    sheet,
    id: block === null ? null : block.getAttribute('data-id'),
    onMarker: marker !== null,
    note: marker === null ? null : marker.getAttribute('data-note'),
    jump: block === null ? null : block.getAttribute('data-jump'),
    hitKey: litRun === null ? null : litRun.getAttribute('data-hit'),
    extend: event.ctrlKey || event.metaKey || event.shiftKey,
    similar: event.altKey,
    base: this.chosen(),
    dragging: false,
  };
  // A new press anywhere on the paper closes an open card; the branches at
  // release may put a new one up. The card's own pointerdown never reaches
  // here (it stops propagation), so clicking ON the card holds it open.
  this.peek.set(null);
}

/**
 * A drag over the sheet is the marquee, and it is the ONLY thing a drag is.
 *
 * ── WHERE THE REORDER MODE WOULD HANG, AND WHY IT IS NOT HERE ──────────────
 *
 * `{ op: 'move', id, before }` is performed by the replay and nothing on this
 * surface mints it. The gesture docs/RENDERER.md §5 names is *"drag to reorder
 * in an explicit order-repair mode"*, and that is a second meaning for the one
 * gesture below: a mode to enter and leave, a lift under the pointer, a drop
 * indicator between two blocks, a hit test per block on every pointer move and
 * an autoscroll when the drag reaches the top or the bottom of a bench holding a
 * four-hundred-page book. That is real machinery, it is the same machinery a
 * draggable chapter rule needs (see `rename`), and the op exists without it —
 * so the two gestures are deferred together and out loud rather than half-built.
 *
 * WHAT STANDS IN THE MEANTIME IS NOTHING, deliberately. Reading order coming out
 * wrong is a reflow problem before it is an editing one, and a repair nobody can
 * reach is better than a repair that reorders a book on a slip of the hand.
 */
export function drag(this: BookViewComponent, event: PointerEvent): void {
  const from = this.pressed;
  if (from === null) return;
  if (!from.dragging) {
    if (Math.abs(event.clientX - from.x) < DRAG_SLOP
      && Math.abs(event.clientY - from.y) < DRAG_SLOP) {
      return;
    }
    from.dragging = true;
  }
  from.lastX = event.clientX;
  from.lastY = event.clientY;
  this.sweep(event.currentTarget as HTMLElement, event.clientX, event.clientY);
}

/**
 * The marquee's rectangle and its catch, computed IN SHEET COORDINATES.
 *
 * The anchor corner is the paper's own point the press landed on (`sheetX`,
 * `sheetY` — see `pressed`), and the moving corner is the pointer converted
 * into the same frame at this instant. That is what makes the sweep survive a
 * wheel-scroll mid-drag: scrolling moves the paper, the anchor is a point ON
 * the paper, and everything the rectangle grows over on the way is caught —
 * which is the gesture's whole promise. The scroll listener re-runs this with
 * the pointer where it last was (`lastX`/`lastY`), because a wheel turns
 * without the pointer moving and no pointermove ever fires.
 */
export function sweep(this: BookViewComponent, sheet: HTMLElement, clientX: number, clientY: number): void {
  const from = this.pressed;
  if (from === null || !from.dragging) return;
  const paper = sheet.getBoundingClientRect();
  const px = clientX - paper.left;
  const py = clientY - paper.top;
  const left = Math.min(from.sheetX, px);
  const top = Math.min(from.sheetY, py);
  const right = Math.max(from.sheetX, px);
  const bottom = Math.max(from.sheetY, py);
  this.marquee.set({ left, top, width: right - left, height: bottom - top });
  const taken = new Set(from.extend ? from.base : []);
  for (const element of sheet.querySelectorAll('.block')) {
    const id = element.getAttribute('data-id');
    if (id === null) continue;
    const at = element.getBoundingClientRect();
    const blockTop = at.top - paper.top;
    const blockBottom = at.bottom - paper.top;
    const blockLeft = at.left - paper.left;
    const blockRight = at.right - paper.left;
    if (blockBottom >= top && blockTop <= bottom && blockRight >= left && blockLeft <= right) {
      taken.add(id);
    }
  }
  this.chosen.set(taken);
}

/** The end of it: a marquee keeps what it swept, a press takes one block. */
export function release(this: BookViewComponent, event: PointerEvent): void {
  const from = this.pressed;
  this.pressed = null;
  this.marquee.set(null);
  const sheet = event.currentTarget as HTMLElement;
  if (sheet.hasPointerCapture(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
  if (from === null || from.dragging) return;
  /*
   * A PRESS ON A REFERENCE NUMBER IS A PEEK AND NOTHING ELSE — not a selection
   * of the paragraph it happens to sit in. The two halves of an apparatus are
   * a pair, and the ruling is that reading the other half must not move the
   * scrollbar: the note appears on a card beside the number, joined by the
   * leader, and the card's own "Go there" is the deliberate journey. A number
   * nothing carries shows nothing; the amber pill in the margin has already
   * said why.
   */
  if (from.onMarker) {
    if (from.note !== null) this.peekAt(sheet, from.x, from.y, from.note, from.note);
    return;
  }
  /*
   * A PRESS ON A FLAGGED PASSAGE SELECTS THE FINDING — Owen, 2026-08-25: *"as i
   * scroll/click highlighted text, it should jump to that spot in the
   * analysis"*, and then *"have it pulse as long as it's selected. if i click
   * the block, the text block pulses until i click somewhere else or scroll
   * offscreen."*
   *
   * IT RIDES THE EXISTING GESTURE AND TAKES NOTHING FROM IT, which is the whole
   * of why it is two lines here rather than a handler of its own. Everything
   * below still happens: the paragraph becomes the block selection, Alt still
   * takes the category, Ctrl still adds one, the original panel is still aimed.
   * A flagged paragraph is not a paragraph you cannot edit — that was the very
   * failure the no-overlay ruling was written against (`cut`) — so the click
   * that says "this one" goes on saying it and merely says one more thing.
   *
   * AND A PRESS ANYWHERE ELSE LETS GO OF IT. *"Until i click somewhere else."*
   * This line is where "somewhere else" is decided on the paper, and what it
   * deliberately does NOT catch is every other gesture: a right-click never
   * reaches here (the context menu is its own handler), a marquee drag returned
   * above, a press on a reference number returned above, and a press on a
   * gutter chip never became a `pressed` at all because those stop the pointer
   * event where it happens. What is left is exactly a plain click on the words,
   * which is the gesture that means "I am looking at this instead".
   *
   * BEFORE THE BRANCHES rather than after, because the selection-BUILDING
   * clicks return early and a person Ctrl-clicking a second flagged passage is
   * still telling the panel which passage they are looking at.
   *
   * THE GUARD IS A READ AND NOT A FLAG: with no analysis open the service holds
   * null already, so the else-branch writes null over null once per click and
   * costs a comparison.
   */
  // A place an Ask run pointed at is lit with these runs too, and is no analysis finding.
  if (from.hitKey !== null && !from.hitKey.startsWith('ask:')) this.analysis.select(from.hitKey);
  else if (untracked(() => this.analysis.selected()) !== null) this.analysis.select(null);
  if (from.id === null) {
    // A press on the paper itself, off every block: the ordinary "let go of
    // what I had", which is how a selection is dropped everywhere in this app.
    if (!from.extend) this.chosen.set(new Set());
    // The glance card went down here once. The panel stays: it says where
    // the reading is, and letting go of a selection does not move the reading.
    return;
  }
  const id = from.id;
  /*
   * ALT+CLICK TAKES THE WHOLE CATEGORY — every block set as this one is, in
   * one selection, for the gesture "act on all the footnotes" (or captions, or
   * quotes) without sweeping a four-hundred-page book by hand. Alt rather than
   * double-click because double-click is the editor's (RENDERER-DESIGN.md §3:
   * the block itself is the editor), and a gesture that sometimes edited and
   * sometimes selected three hundred rows would be two meanings on one motion.
   */
  /*
   * ── WHICH CLICKS AIM THE ORIGINAL PANEL ───────────────────────────────────
   *
   * Only the plain single-select click, below. The selection-BUILDING
   * clicks — Alt for the whole category, Ctrl/Shift for one more or one
   * fewer — leave the panel where it was: a click whose whole meaning is
   * "and this one too" is not a statement about where the reading moved,
   * and a panel that jumped to each addition while a selection is gathered
   * across three pages would be flipping the scan under the very comparison
   * being made. (The card these rules used to DISMISS is gone; the panel
   * has no dismissal to route, only an aim to withhold.)
   */
  if (from.similar) {
    const line = this.lines().find((one) => one.row.id === id);
    if (line !== undefined) {
      const category = line.row.category;
      this.chosen.set(new Set(
        this.lines()
          .filter((one) => one.row.category === category)
          .map((one) => one.row.id),
      ));
    }
    return;
  }
  if (from.extend) {
    const taken = new Set(from.base);
    if (!taken.delete(id)) taken.add(id);
    this.chosen.set(taken);
  } else {
    this.chosen.set(new Set([id]));
    /*
     * THE CLICK AIMS THE PANEL, and it is the click that was already here:
     * the same press-and-let-go that makes a block THE selection turns the
     * original to its page. Selection-BUILDING clicks (Alt, Ctrl/Shift,
     * above) deliberately do not — "and this one too" is not a statement
     * about where the reading moved — which keeps the panel still while a
     * selection is being gathered across three pages.
     */
    this.aimOriginal(id);
  }
  // A note peeks the other way: the paragraph its number is printed in comes
  // to the card, with that number lit inside it.
  if (from.jump !== null) this.peekAt(sheet, from.x, from.y, from.jump, id);
}

/**
 * A press on a chapter chip arms the drag without starting it.
 *
 * THE SAME SLOP AS THE MARQUEE separates the three things a chip press can
 * mean — a click (nothing), a double-click (the rename), a drag (the move) —
 * so a hand that only wanted to rename never sees the rule twitch. Pointer
 * capture on the chip itself, which is what lets the drag run the length of
 * the sheet without the sheet's own gestures waking.
 */
export function grabRule(this: BookViewComponent, event: PointerEvent, id: string): void {
  event.stopPropagation();
  if (event.button !== 0) return;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  this.draggingRule.set({ id, over: null, live: false, startY: event.clientY });
}

/**
 * The carry: find the block whose head is nearest the pointer, and offer it.
 *
 * CANDIDATES ARE THE FLOWING BLOCKS THAT COULD HONESTLY TAKE A DIVISION — not
 * the one it already sits on, and not one already carrying its own, because
 * the replay would refuse both and a glow the drop cannot honour is a lie in
 * spruce. The hit test asks the DOM the same question the marquee asks
 * (`getBoundingClientRect` per block), which a drag's cadence affords.
 */
export function dragRule(this: BookViewComponent, event: PointerEvent): void {
  const held = this.draggingRule();
  if (held === null) return;
  if (!held.live) {
    if (Math.abs(event.clientY - held.startY) < DRAG_SLOP) return;
  }
  const divisions = new Set((this.view()?.chapters ?? []).map((chapter) => chapter.id));
  let nearest: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  const sheet = this.host.nativeElement.querySelector('.bench .sheet');
  if (sheet === null) return;
  for (const element of sheet.querySelectorAll('.block[data-id]')) {
    const id = element.getAttribute('data-id');
    if (id === null || id === held.id || divisions.has(id)) continue;
    const gap = Math.abs(element.getBoundingClientRect().top - event.clientY);
    if (gap < distance) {
      distance = gap;
      nearest = id;
    }
  }
  this.draggingRule.set({ ...held, live: true, over: nearest });
}

/**
 * The drop: one `chapter move` op, or nothing where the hand never cleared
 * the slop or let go over no honest candidate. The rule settles into place
 * because the replay recomputes and the chip is drawn at its new block —
 * the state reads perfectly as a still, which is §6's own standard.
 */
export function dropRule(this: BookViewComponent, event: PointerEvent): void {
  const held = this.draggingRule();
  this.draggingRule.set(null);
  if (held === null || !held.live) return;
  event.stopPropagation();
  if (held.over === null || held.over === held.id) return;
  this.push({ op: 'chapter', move: held.id, to: held.over });
}

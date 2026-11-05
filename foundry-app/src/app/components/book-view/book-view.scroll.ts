/**
 * book-view.scroll — the scroll lock between sheets, the peek card, and landing on a block.
 */
import { afterNextRender } from '@angular/core';
import { sharedAnchor } from '@owen/foundry-core/shared/flow';
import { PULSE_MS, GLIDE_TAU_MS, GLIDE_MAX_MS, SCROLL_SETTLE_MS } from './book-view.model';
import { cut } from './book-view.lines';
import type { BookViewComponent } from './book-view.component';

/** A column was scrolled: it takes the wheel, and the other one follows. */
export function scrolled(this: BookViewComponent, which: 'live' | 'source'): void {
  if (!this.aligned()) return;
  // The passenger's own scroll, which this pane caused a moment ago. Ignored,
  // and that is the whole of the re-entrancy guard.
  if (this.driving !== null && this.driving !== which) return;
  this.driving = which;
  if (this.drivingTimer !== null) clearTimeout(this.drivingTimer);
  this.drivingTimer = setTimeout(() => {
    this.driving = null;
    this.drivingTimer = null;
  }, SCROLL_SETTLE_MS);
  this.lock(which);
}

/** `scrollend` on the driving column: the wheel goes back at once. */
export function settled(this: BookViewComponent, which: 'live' | 'source'): void {
  if (this.driving !== which) return;
  this.driving = null;
  if (this.drivingTimer !== null) {
    clearTimeout(this.drivingTimer);
    this.drivingTimer = null;
  }
}

/**
 * PUT THE OTHER COLUMN WHERE THIS ONE IS — the lock, by block id.
 *
 * ── What "the same place" means, and it is not a fraction ──────────────────
 *
 * *"Scrolling either column finds its topmost fully-visible block id and scrolls
 * the other column so its row of the SAME id sits at the same viewport offset."*
 * Not a proportion of the scroll height: a translation is a different length
 * from its source in every language anybody translates into, so tying the two
 * scrollbars together by percentage would put paragraph four hundred beside
 * paragraph four hundred and thirty and drift the whole way down the book. The
 * ids are the same on both sides by construction (docs/RENDERER.md §4 — *"parent
 * ids kept verbatim"*), so the id is the place.
 *
 * ── NEAREST PRECEDING IS A RULE HERE, NOT A FALLBACK ───────────────────────
 *
 * A row can be on one side and not the other, and both ways of it happening are
 * ordinary: a block struck under the translation is absent from the derived
 * book, and a cut applied under it mints ids (`b2-3/1`) the source never had. The
 * ruling (this wave's brief, and it is written down here because it is the kind
 * of decision that gets mistaken for a shortcut later) is the NEAREST PRECEDING
 * id present on both — the last shared paragraph at or above the one on screen.
 * It is not a guess at where the missing row would have been: it is the true
 * statement that both columns are somewhere after that paragraph, and it is
 * stable, because the same anchor is chosen whichever column is driving.
 *
 * A book with NO shared row above the anchor moves nothing at all, which is the
 * top of the book and needs no help.
 */
export function lock(this: BookViewComponent, driver: 'live' | 'source'): void {
  const host = this.host.nativeElement;
  const live = host.querySelector('.bench') as HTMLElement | null;
  const source = host.querySelector('.context') as HTMLElement | null;
  if (live === null || source === null) return;
  const from = driver === 'live' ? live : source;
  const to = driver === 'live' ? source : live;

  const fromBox = from.getBoundingClientRect();
  const rows = [...from.querySelectorAll('.block[data-id]')] as HTMLElement[];
  /*
   * THE TOPMOST ROW NOT CUT OFF AT THE TOP. A block whose first line is above
   * the fold is a block the reader is in the MIDDLE of, and putting its top edge
   * at the other column's top edge would scroll the passenger backwards past
   * words the driver can still see. The one under it is the first whole thing on
   * screen, which is what a person would point at if asked where they were.
   *
   * The half-pixel is the browser's own subpixel layout and not a tolerance
   * invented here: two boxes flush against each other can differ in the last
   * place of a fractional rectangle.
   *
   * IT IS A WALK FROM THE TOP AND IT IS AFFORDABLE, which is worth saying so
   * that nobody optimises it in the dark. The rects are read after the layout
   * the scroll already forced, so a four-hundred-page book costs a few thousand
   * property reads and no reflow — and it costs them only while two columns are
   * on screen, which is a mode somebody chose. A binary search would work (the
   * blocks are in document order in normal flow, so their tops only increase)
   * and it is not here because the walk is honest and the search is a claim
   * about the layout that nothing in this file could check.
   */
  const anchor = rows.findIndex((row) => row.getBoundingClientRect().top >= fromBox.top - 0.5);
  if (anchor < 0) return;

  const twins = new Map<string, HTMLElement>();
  for (const row of to.querySelectorAll('.block[data-id]')) {
    const id = row.getAttribute('data-id');
    if (id !== null) twins.set(id, row as HTMLElement);
  }

  // The rule itself is `sharedAnchor` (./flow) — pure, over two lists of ids,
  // where a script can exercise it. What is left here is the arithmetic, which
  // needs a laid-out document and can only be checked by looking at one.
  const shared = sharedAnchor(
    rows.map((row) => row.getAttribute('data-id') ?? ''),
    anchor,
    new Set(twins.keys()),
  );
  if (shared === null) return;
  const twin = twins.get(rows[shared]!.getAttribute('data-id')!);
  if (twin === undefined) return;
  /*
   * THE SHARED ROW'S OWN OFFSET, and not the anchor's. When the row on screen is
   * one the other column does not have, what is being lined up is the last
   * paragraph they both hold — so the offset that matters is where THAT
   * paragraph sits in the driving column, which is off the top of the screen by
   * however far the reader has come since. Using the anchor's offset would put a
   * paragraph the reader has already passed at the top of the other column.
   */
  const offset = rows[shared]!.getBoundingClientRect().top - fromBox.top;
  const moved = (twin.getBoundingClientRect().top - to.getBoundingClientRect().top) - offset;
  // A move of less than a pixel is the two columns already agreeing. Assigning
  // it anyway would fire a scroll event on the passenger for nothing, which costs
  // a frame and a guarded handler on every notch of a wheel.
  if (Math.abs(moved) >= 1) to.scrollTop += moved;
}

/** The note whose pair is on the card — the number the card lights. */
export function peekFrom(this: BookViewComponent): string | null {
  return this.peek()?.from ?? null;
}

/**
 * Open the card beside the click, or close it when the same counterpart is
 * asked for twice — the second click is the reader saying they are done.
 *
 * The geometry is decided here, once: the card stands to the RIGHT of the
 * click where the paper has room and to the left where it does not, and the
 * leader runs from the click point to the card's near top corner. All of it
 * in sheet coordinates — see `peek`.
 */
export function peekAt(this: BookViewComponent, sheet: HTMLElement, clientX: number, clientY: number, target: string, from: string | null): void {
  if (this.peek()?.target === target) {
    this.peek.set(null);
    return;
  }
  const box = sheet.getBoundingClientRect();
  const ax = clientX - box.left;
  const ay = clientY - box.top;
  const width = 352;
  const right = ax + 28;
  const x = right + width > box.width - 12 ? Math.max(12, ax - 28 - width) : right;
  const y = Math.max(12, ay - 14);
  const entryX = x > ax ? x : x + width;
  const entryY = y + 18;
  const left = Math.min(ax, entryX) - 4;
  const top = Math.min(ay, entryY) - 4;
  this.peek.set({
    target,
    from,
    x,
    y,
    line: {
      left,
      top,
      width: Math.abs(entryX - ax) + 8,
      height: Math.abs(entryY - ay) + 8,
      x1: ax - left,
      y1: ay - top,
      x2: entryX - left,
      y2: entryY - top,
    },
  });
}

/** The card's one deliberate journey: the old jump, asked for by name. */
export function travel(this: BookViewComponent, id: string): void {
  this.peek.set(null);
  this.scrollTo(id);
}

/**
 * Escape puts down every card on the paper — which is the peek, alone, now.
 *
 * The glance card used to go down beside it; the original panel does not —
 * it is a toggled column, not a card, and Escape putting a docked reference
 * away would make one key mean two sizes of thing. The plural name stays
 * because the CALLERS are about "whatever cards are up", and the next card
 * this paper grows will belong here too.
 */
export function dismissCards(this: BookViewComponent): void {
  this.peek.set(null);
}

/**
 * Put a block in the middle of the sheet and tint it for `PULSE_MS`.
 *
 * The pulse is the whole point of the gesture: a jump that merely scrolled
 * would leave the reader looking at a page of prose with no sign of which line
 * of it they had been sent to.
 */
export function scrollTo(this: BookViewComponent, id: string): void {
  /*
   * A JUMP OUT OF A PANEL PUTS THE PANE BACK ON THE BENCH FIRST, which is the
   * same rule `push` states one level down and for the same reason: the panels
   * draw the WORKBENCH's book. A note the Notes panel is pointing at may be
   * struck — absent from the edition entirely — or may be sitting somewhere
   * else on the page, because the edition collects the apparatus at the end of
   * its chapter. Following that jump into the preview would land on nothing or
   * on the wrong thing, and doing nothing at all would be a click that reports
   * no answer.
   */
  if (this.edition() && !this.viewing()) {
    this.mode.set('workbench');
    afterNextRender(() => this.land(id), { injector: this.injector });
    return;
  }
  this.land(id);
}

/**
 * The scroll and the pulse, once the list under them is the bench's.
 *
 * ── A GLIDE THAT RE-AIMS EVERY FRAME, because the target MOVES ─────────────
 *
 * The sheet's bodies sit under `content-visibility: auto` with a 4rem
 * placeholder, so every block the viewport has never reached is ESTIMATED at
 * 4rem — a fraction of what a paragraph actually measures. Any scroll aimed
 * ONCE therefore aims at a fiction: as blocks near the destination render and
 * take their real heights, the target slides away from wherever the scroll was
 * told to go. One `scrollIntoView({smooth})` landed a chapter-four heading in
 * the middle of chapter two; an instant jump with an after-the-fact settle
 * still left the block half off the screen, because the placeholders around it
 * resolve on the frames AFTER the one the settle checked.
 *
 * So the correction is not a step after the motion — it IS the motion. Each
 * frame measures where the target's centre actually stands against the
 * bench's, and closes a time-constant fraction of that distance: an ease-out
 * glide of about three-quarters of a second that a reader can follow, whose
 * aim is refreshed on every frame, so the layout growing underneath it is
 * absorbed while it travels instead of discovered after it stops. The chase
 * ends when the centres agree, and the bound snaps the last of the distance
 * closed so a landing is centred even if the clock runs out first.
 *
 * THE SCROLLBAR STAYS THE READER'S. A wheel or a press on the sheet while the
 * glide is in flight cancels it — the app asked to move the page, the person
 * moved it instead, and the person wins. Reduced motion collapses the chase to
 * its endpoint: the same loop with the whole distance closed each frame, which
 * is an instant landing that still absorbs the late-resolving placeholders.
 */
export function land(this: BookViewComponent, id: string): void {
  const element = this.host.nativeElement.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
  const bench = element?.closest('.bench, .context') as HTMLElement | null;
  if (element === null || bench === null) return;
  if (this.gliding !== null) cancelAnimationFrame(this.gliding);
  const centreDelta = (): number => {
    const box = element.getBoundingClientRect();
    const view = bench.getBoundingClientRect();
    return (box.top + box.height / 2) - (view.top + view.height / 2);
  };
  const abort = (): void => {
    if (this.gliding !== null) cancelAnimationFrame(this.gliding);
    this.gliding = null;
  };
  bench.addEventListener('wheel', abort, { once: true, passive: true });
  bench.addEventListener('pointerdown', abort, { once: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started = performance.now();
  let last = started;
  const step = (now: number): void => {
    const delta = centreDelta();
    const dt = now - last;
    last = now;
    const done = Math.abs(delta) < 0.5 || now - started > GLIDE_MAX_MS;
    bench.scrollTop += done || reduced ? delta : delta * (1 - Math.exp(-dt / GLIDE_TAU_MS));
    this.gliding = done && (reduced ? Math.abs(centreDelta()) < 0.5 : true)
      ? null
      : requestAnimationFrame(step);
  };
  this.gliding = requestAnimationFrame(step);
  if (this.pulseTimer !== null) clearTimeout(this.pulseTimer);
  this.pulse.set(id);
  this.pulseTimer = setTimeout(() => this.pulse.set(null), PULSE_MS);
}

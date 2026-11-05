/**
 * book-view.bench — which sheets are on the bench, and how the original and analysis panels follow the selection.
 */
import { afterNextRender, effect, signal, untracked } from '@angular/core';
import { cut } from './book-view.lines';
import type { BookViewComponent } from './book-view.component';

/**
 * The register, chosen — the toggle's whole behaviour.
 *
 * A LIVE BLOCK IS PUT TO BED FIRST. The edition has no editor to blur later
 * and no caret to leave one in, so words somebody typed and did not commit
 * would go with the flip — and the flip is not a gesture about those words.
 * `commitEditing` runs while the bench is still on, so its own text op lands
 * the ordinary way (and `push` below finds the mode it expects).
 */
export function show(this: BookViewComponent, register: 'workbench' | 'edition'): void {
  if (this.mode() === register) return;
  this.commitEditing();
  this.renaming.set(null);
  this.menu.set(null);
  /*
   * AND THE EDITION DROPS TO ONE COLUMN. The edition is the finished book, a
   * finished book has one column, and there is no such thing as a preview of a
   * translation WITH its source down the side — the export writes nothing like
   * it. It is put back rather than merely hidden, so that coming back to the
   * bench is the page somebody left and not a page that reassembles itself
   * around them.
   */
  if (register === 'edition') this.alignment.set('alone');
  // The peek is a card about the bench's book; neither register keeps one
  // up. The original panel STAYS through the flip — the scan is worth
  // checking against the finished page exactly as much as against the bench.
  this.dismissCards();
  // An export view has one register: the file is finished, and a workbench
  // over it would draw instruments nothing here can honour.
  if (this.viewing()) return;
  this.mode.set(register);
}

/**
 * The source beside the translation, or not — the second control's whole
 * behaviour.
 *
 * A REFUSAL IS SAID OUT LOUD. The Aligned segment is `aria-disabled` and not
 * `disabled` precisely so that pressing it can reach here and put the reason on
 * the notice strip: a control that cannot be pressed cannot explain itself, and
 * a title alone is a sentence only a pointer that pauses ever reads.
 *
 * A LIVE BLOCK IS PUT TO BED FIRST, on `show`'s rule: both sheets change measure
 * when the pair opens or closes, and words somebody typed into a paragraph that
 * is about to reflow are not a thing to lose to a layout.
 */
export function align(this: BookViewComponent, which: 'alone' | 'aligned'): void {
  if (which === 'aligned') {
    const refused = this.alignRefusal();
    if (refused !== null) {
      this.notices.notice.set(refused);
      return;
    }
  }
  if (this.alignment() === which) return;
  this.commitEditing();
  this.alignment.set(which);
  this.twinned.set(null);
  /*
   * AND THE COLUMNS ARE PUT IN STEP THE MOMENT THE SECOND ONE EXISTS. The
   * source arrives scrolled to its own top while the translation is wherever the
   * person had been reading, and two columns that do not agree on the first
   * frame are two columns somebody has to scroll to reconcile before the lock is
   * any use. The LIVE column drives, because that is the one they were reading.
   *
   * THROUGH `scrolled` AND NOT STRAIGHT INTO `lock`, so that the sync takes the
   * wheel like any other gesture: the source column is about to be moved, its own
   * scroll event is about to fire, and an unguarded one would drive the live
   * column back off the place this was called to put it.
   */
  if (which === 'aligned') {
    afterNextRender(() => this.scrolled('live'), { injector: this.injector });
  }
}

/**
 * Back to the bench, with a block picked out — the ending EVERY edit gesture
 * takes while the edition is on.
 *
 * *"Edition is read-only; any edit gesture flips back to Workbench with the
 * block focused."* (RENDERER-DESIGN.md §5.) THE FLIP IS THE ANSWER and the
 * gesture is not also performed: a double-click on a preview is somebody
 * reaching for the words, and putting a caret in them as well would have one
 * press both change the mode and start an edit in a mode they had not seen
 * yet. The second press does the thing, on the bench, where its marks are.
 *
 * FOCUS AFTER THE FRAME THAT DRAWS IT, for `edit`'s reason: the bench's list is
 * a different list and the element under the pointer belongs to the edition's.
 */
export function toBench(this: BookViewComponent, id: string | null): void {
  this.mode.set('workbench');
  if (id === null) return;
  this.chosen.set(new Set([id]));
  afterNextRender(() => {
    const block = this.host.nativeElement
      .querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    block?.focus({ preventScroll: true });
  }, { injector: this.injector });
}

/**
 * Aim the original panel at a block — the click's half of the following.
 *
 * CALLED FROM THE CLICK THAT ALREADY SELECTED THE BLOCK (`release`): the
 * press-and-let-go that makes a block THE selection is the same one that
 * turns the panel to its page, so a reader checking the scan does what they
 * were already doing to act on the paragraph. The scroll's half is
 * `followOriginal`, below.
 *
 * A ROW THE BOOK NO LONGER HAS AIMS NOTHING — `lines()` is the book as
 * replayed at this instant, and an id a join or cut has taken out from
 * under the click leaves the panel exactly where it was, which is the last
 * true place the reading stood.
 *
 * THE CARD'S PLACEMENT DIED HERE (2026-08-23): `placeGlance` and its
 * viewport arithmetic — the measured width, the clamps, the centring, the
 * two-frame re-place — served a fixed-position card that a docked column
 * does not need a line of. The gravestone at the old mount carries the
 * succession; Owen's 2026-08-22 gray-gutter ruling that shaped the
 * arithmetic is satisfied by the column standing in that gray for good.
 */
export function aimOriginal(this: BookViewComponent, id: string): void {
  const line = this.lines().find((one) => one.row.id === id);
  if (line !== undefined) this.originalRow.set(line.row);
}

/**
 * The head-row toggle — and an OPEN aims at once. A panel opened before any
 * click or scroll has ever aimed it would stand there saying "The original"
 * over no page at all, so opening asks the bench where the reading already
 * is. The scroll's own following needs the flag set first, which is why this
 * is a method and not a bare `set` in the template.
 */
export function toggleOriginal(this: BookViewComponent): void {
  const open = !this.originalOpen();
  this.originalOpen.set(open);
  if (open) this.followOriginal();
}

/**
 * THE SCROLL'S HALF OF THE FOLLOWING: aim the panel at the topmost block on
 * the bench, so the scan turns its pages as the reading moves.
 *
 * The walk is the scroll lock's own (`lock`) — the first block not cut off
 * at the fold is what a person would point at if asked where they are — and
 * it is run only while the panel is open, so a closed panel costs a boolean.
 * THE SIGNAL IS WRITTEN ONLY WHEN THE BLOCK CHANGES: this runs per scroll
 * frame outside Angular's scheduling, and an unconditional set would put a
 * change-detection pass behind every frame of every drag. A block boundary
 * crosses the fold a handful of times per screenful, which is the rate the
 * panel actually needs.
 */
export function followOriginal(this: BookViewComponent): void {
  if (!this.originalOpen()) return;
  const bench = this.host.nativeElement.querySelector('.bench');
  if (!(bench instanceof HTMLElement)) return;
  const fold = bench.getBoundingClientRect().top;
  const rows = [...bench.querySelectorAll('.block[data-id]')] as HTMLElement[];
  const anchor = rows.find((row) => row.getBoundingClientRect().top >= fold - 0.5);
  const id = anchor?.getAttribute('data-id');
  if (id == null || untracked(() => this.originalRow())?.id === id) return;
  this.aimOriginal(id);
}

/**
 * THE SCROLL'S HALF OF THE ANALYSIS FOLLOWING: say which finding the reader has
 * arrived at, so the panel can keep that card in view.
 *
 * Owen, 2026-08-25: *"as i scroll/click highlighted text, it should jump to that
 * spot in the analysis."* The click's half is in `release`; this is the scroll's.
 *
 * ── AN INTERSECTION OBSERVER WAS THE OBVIOUS SHAPE AND IS NOT THE RIGHT ONE ─
 *
 * The thing worth watching is a lit RUN — that is where a finding's words
 * actually are — and a run cannot be watched from here. The runs live inside
 * `.body`, which is under `content-visibility: auto` (the class docblock: it is
 * on a wrapper INSIDE each block, never on the block, because paint containment
 * would clip every gutter mark away). A subtree that is skipped generates no
 * boxes for its descendants, so an off-screen run has no geometry at all: an
 * observer reports it as not intersecting — which is true and useless — and a
 * rect asked for directly comes back as zeros, which reads as a rectangle
 * sitting at the top-left of the viewport and would make the FURTHEST finding
 * look like the nearest. That is the measured reason this is a rect walk over
 * BLOCKS and not an observer over runs, and it is written down here because it
 * is exactly the sort of thing that gets "cleaned up" into an observer later.
 *
 * A block always has a box. The containment is on its wrapper, its height is
 * `contain-intrinsic-size`'s estimate while it is off screen and its real one
 * when it is not, and either way its position is a fact. So the walk is
 * `followOriginal`'s, verbatim in shape — the first block not cut off at the
 * fold, which is what a person would point at if asked where they are —
 * narrowed by the selector to the handful of blocks an open report lit.
 *
 * TWO THINGS KEEP IT CHEAP, both of them the neighbour's own rules. It returns
 * at once while nothing is lit, so a book with no analysis over it pays one
 * empty `querySelectorAll` per scroll frame and no arithmetic. And THE SIGNAL IS
 * WRITTEN ONLY WHEN THE ANSWER CHANGES: this runs outside Angular's scheduling
 * and an unconditional set would put a change-detection pass behind every frame
 * of every drag.
 */
export function followAnalysis(this: BookViewComponent): void {
  const bench = this.host.nativeElement.querySelector('.bench');
  if (!(bench instanceof HTMLElement)) return;
  const lit = [...bench.querySelectorAll('.block[data-hit-key]')] as HTMLElement[];
  if (lit.length === 0) return;
  const fold = bench.getBoundingClientRect().top;
  /*
   * THE FIRST ONE AT OR BELOW THE FOLD, and the LAST one when the reader has
   * scrolled past every finding in the book. Falling back to the last is not a
   * guess: past the final flagged paragraph the nearest finding really is the
   * final one, and leaving the panel pointed at whatever it happened to hold
   * would strand it in the middle of a list the reader has walked off the end of.
   */
  const anchor = lit.find((block) => block.getBoundingClientRect().top >= fold - 0.5)
    ?? lit[lit.length - 1]!;
  const key = anchor.getAttribute('data-hit-key');
  if (key === null || untracked(() => this.analysis.nearest()) === key) return;
  this.analysis.nearest.set(key);
}

/**
 * Watch one block, and drop the selection when it goes off the page.
 *
 * See the effect in the constructor for the argument. `null` tears down and
 * watches nothing, which is the ordinary state of this app.
 *
 * THE ROOT IS THE BENCH AND NOT THE VIEWPORT, because the bench is what
 * scrolls: a block below the fold of a scrolling column is inside the window and
 * is not on the page, and the window is not the thing a reader is moving.
 */
export function watchSelection(this: BookViewComponent, id: string | null): void {
  this.selectionWatch?.disconnect();
  this.selectionWatch = null;
  if (id === null) return;
  afterNextRender(() => {
    // The selection may have moved again while this waited for a frame; the
    // service holds the newest wish, so identity against it is the whole test.
    const still = untracked(() => this.analysis.selectedHit());
    if (still?.spans[0]?.id !== id) return;
    const bench = this.host.nativeElement.querySelector('.bench');
    const block = this.host.nativeElement
      .querySelector(`.block[data-id="${CSS.escape(id)}"]`);
    if (!(bench instanceof HTMLElement) || !(block instanceof HTMLElement)) return;
    let seen = false;
    const watch = new IntersectionObserver((entries) => {
      const on = entries[entries.length - 1]?.isIntersecting ?? false;
      if (on) {
        seen = true;
        return;
      }
      if (!seen) return;
      watch.disconnect();
      if (this.selectionWatch === watch) this.selectionWatch = null;
      if (untracked(() => this.analysis.selected()) === still.key) this.analysis.select(null);
    }, { root: bench });
    watch.observe(block);
    this.selectionWatch = watch;
  }, { injector: this.injector });
}

/**
 * Light the same block on the other sheet — the coupling, both directions.
 *
 * *"Hovering a block in either column lights the SAME id in the other."* It is
 * an id and not an element, so the two columns never have to find each other for
 * this: each draws the class where its own row's id matches, and a row the other
 * column does not have simply lights nothing, which is the honest picture of a
 * paragraph that the translation struck or a cut has since divided.
 *
 * NOTHING IS LIT WHILE THERE IS ONE COLUMN. The tint would be indistinguishable
 * from the hover it is made of, so it would be a class that changed nothing —
 * but it would also be a signal writing on every pointer move across a book that
 * has no use for it.
 */
export function twin(this: BookViewComponent, id: string | null): void {
  this.twinned.set(this.aligned() ? id : null);
}

/**
 * The pointer left a block: the note goes out and its twin with it.
 * Nothing else moves — the original panel in particular, which follows the
 * reading and not the hand.
 */
export function dim(this: BookViewComponent): void {
  this.lit.set(null);
  this.twinned.set(null);
}

export function haunt(this: BookViewComponent, page: number | null): void {
  this.ghosted.set(page);
}

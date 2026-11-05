import type { CaptureQuad } from '@owen/foundry-core/shared/types';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { Rectifier } from '@owen/foundry-core/browser/rectify';
import { CaptureCardComponent } from './capture-card.component';
import { CaptureCard, SWEEP_STARTS_AT, SCROLL_STEP } from './capture-grid.model';
export type { CaptureCard } from './capture-grid.model';
import * as carry from './capture-grid.carry';

@Component({
  selector: 'app-capture-grid',
  imports: [CaptureCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-grid.component.html',
  styleUrl: './capture-grid.component.scss',
})
export class CaptureGridComponent {
  readonly host = inject(ElementRef<HTMLElement>);

  constructor() {
    // The context goes when the table does. Chromium would collect it with the
    // canvas eventually; asking now is what keeps a person who opens four
    // capture projects in a session from holding four contexts against a cap
    // measured in the low tens.
    inject(DestroyRef).onDestroy(() => {
      this.gl?.dispose();
      this.gl = null;
      // A drag that was still auto-scrolling when the tab changed would leave a
      // frame loop measuring an element that is no longer in the document.
      this.stopChasing();
    });
  }

  /** The page ids the marquee has chosen, in grid order. */
  protected readonly chosen = signal<readonly string[]>([]);
  /**
   * THE PHOTOGRAPHS THOSE PAGES ARE ON, which is what removal actually takes.
   *
   * The menu used to count `chosen()` and call the result photographs. On a
   * split shoot that is wrong by exactly double: 27 photographs are 52 pages,
   * so sweeping the table offered to "Delete 52 photographs" and the confirm
   * behind it said "Remove 27". Two numbers for one act on the destructive
   * path, and the FIRST one is the one that decides whether somebody clicks.
   *
   * The fold lives HERE, once, and the parent no longer repeats it. Two folds
   * that agree today are the shape this feature has now paid for three times.
   */
  protected readonly chosenPhotos = computed(() => {
    const pages = new Set(this.chosen());
    const photos: string[] = [];
    for (const card of this.cards()) {
      if (pages.has(card.id) && !photos.includes(card.photoId)) photos.push(card.photoId);
    }
    return photos;
  });
  /** The rubber band while it is being drawn, in table coordinates. */
  protected readonly band = signal<{ left: number; top: number; width: number; height: number } | null>(null);
  /** Where the context menu is, or null. */
  protected readonly menu = signal<{ x: number; y: number } | null>(null);

  private sweepFrom: { x: number; y: number } | null = null;
  private sweptFar = false;
  /** The last card chosen WITHOUT shift — where a shift-extended run starts. */
  private anchor: string | null = null;

  /**
   * A press on the table, which might become a sweep and might stay a click.
   *
   * IT DOES NOT DECIDE YET. At twenty-seven cards almost every pixel of the
   * table is a card, so a marquee that only started on empty space would be a
   * marquee nobody could start. The press is remembered, the band appears once
   * the pointer has actually travelled, and a card's own click still fires when
   * it has not -- so the two gestures share a starting position and separate on
   * evidence rather than on where the finger landed.
   */
  protected startSweep(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.menu.set(null);
    this.sweepFrom = { x: event.clientX, y: event.clientY };
    this.sweptFar = false;
  }

  protected moveSweep(event: PointerEvent): void {
    const from = this.sweepFrom;
    if (from === null) return;
    const travelled = Math.hypot(event.clientX - from.x, event.clientY - from.y);
    // Below the threshold this is still a click with a shaky hand.
    if (!this.sweptFar && travelled < SWEEP_STARTS_AT) return;
    this.sweptFar = true;

    const table = this.tableBox();
    if (table === null) return;
    const left = Math.min(from.x, event.clientX);
    const top = Math.min(from.y, event.clientY);
    this.band.set({
      left: left - table.left,
      top: top - table.top,
      width: Math.abs(event.clientX - from.x),
      height: Math.abs(event.clientY - from.y),
    });
    this.chosen.set(this.within(left, top, Math.abs(event.clientX - from.x), Math.abs(event.clientY - from.y)));
  }

  protected endSweep(event: PointerEvent): void {
    const swept = this.sweptFar;
    this.sweepFrom = null;
    this.sweptFar = false;
    this.band.set(null);
    if (!swept) {
      // A press that never travelled: the card under it handles its own click,
      // and a selection the person did not draw should not survive the attempt.
      // The card's own click lands AFTER this, so clearing here and choosing
      // there is one gesture in two steps rather than a fight. Shift joins ctrl
      // and meta in being left alone: a range is computed from the anchor, and
      // clearing first would be harmless but reads as a bug in the log.
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) this.chosen.set([]);
      return;
    }
    this.chose.emit(this.chosen());
  }

  /** Which cards the band covers, in grid order — geometry, not hit testing. */
  private within(left: number, top: number, width: number, height: number): string[] {
    const chosen: string[] = [];
    const slots: NodeListOf<HTMLElement> = this.host.nativeElement.querySelectorAll('[data-id]');
    for (const slot of Array.from(slots)) {
      const box = slot.getBoundingClientRect();
      const overlaps = box.right >= left && box.left <= left + width
        && box.bottom >= top && box.top <= top + height;
      const id = slot.getAttribute('data-id');
      if (overlaps && id !== null) chosen.push(id);
    }
    return chosen;
  }

  private tableBox(): DOMRect | null {
    return this.tableEl()?.getBoundingClientRect() ?? null;
  }

  /**
   * Right-click on the selection. Owen's own flow: sweep, then right-click the
   * highlighted cards.
   *
   * A right-click on NOTHING chosen is left to the platform rather than
   * answered with an empty menu -- a menu whose only item would be "Delete 0"
   * is a menu that exists to say no.
   *
   * ── A RIGHT-CLICK ON A CARD TAKES THAT CARD FIRST ──────────────────────────
   *
   * Which is what every file list does, and what Wave 25 needs it to do: the
   * contract's door is *right-click a card and release it*, and until now that
   * gesture only worked on a card somebody had already selected. On any other
   * card it either opened a menu about a DIFFERENT selection -- a release that
   * would free three photographs somewhere else on the table -- or, with
   * nothing chosen, did nothing at all.
   *
   * A card already IN the selection leaves the selection alone, so the sweep
   * flow is untouched: right-clicking one of nine highlighted cards still
   * offers all nine.
   */
  protected openMenu(event: MouseEvent): void {
    const target = event.target;
    const slot = target instanceof Element ? target.closest('[data-id]') : null;
    const id = slot?.getAttribute('data-id') ?? null;
    if (id !== null && !this.chosen().includes(id)) {
      this.anchor = id;
      this.chosen.set([id]);
      this.chose.emit(this.chosen());
    }
    if (this.chosen().length === 0) return;
    event.preventDefault();
    this.menu.set({ x: event.clientX, y: event.clientY });
  }

  /**
   * The chosen photographs the book has stopped moving -- what the hand-back
   * acts on.
   *
   * Read off the CARDS rather than asked of anything else, because the card's
   * dot and this list have to be the same answer: a menu offering to release
   * two photographs when one dot is showing would be the surface disagreeing
   * with itself about a promise. The card's mark is `isComplete` all the way
   * down (the service's `cards`), so this is that test folded to photographs.
   */
  protected readonly completeChosen = computed(() => {
    const pages = new Set(this.chosen());
    const photos: string[] = [];
    for (const card of this.cards()) {
      if (pages.has(card.id) && card.own && !photos.includes(card.photoId)) photos.push(card.photoId);
    }
    return photos;
  });

  /** Give these photographs back to the book. One press, the whole selection. */
  protected followChosen(): void {
    const photos = this.completeChosen();
    this.menu.set(null);
    if (photos.length > 0) this.follow.emit(photos);
  }

  /**
   * SHOW ME THOSE ONES — the door behind the rail's pressable counts.
   *
   * Wave 24 shipped the mark and deferred this half out loud: *"the rail's 'N
   * by hand' count is not clickable … it needs a selection input on the grid,
   * whose `chosen` is private today, plus scroll-into-view to be worth
   * having."* This is that, and it is a METHOD rather than an input on purpose.
   * An input carrying the ids would be compared by value, so pressing "3
   * complete" a second time -- after sweeping something else in between --
   * would be a press that visibly did nothing, and the fix for that is a nonce
   * travelling beside the payload, which is a signal pretending to be an event.
   *
   * IT IS SELECTION AND NOT A NEW MODE. The cards it lights are lit the way a
   * sweep lights them, they answer Delete and Turn the way a sweep's do, and
   * the next click anywhere clears them. Nothing here is a second kind of
   * chosen.
   */
  showOnly(ids: readonly string[]): void {
    // In GRID order, like every other writer of `chosen` -- the run a shift
    // extends and the count Delete names both read the way the table does.
    const wanted = new Set(ids);
    const inOrder = this.cards().map((card) => card.id).filter((id) => wanted.has(id));
    this.anchor = inOrder[0] ?? null;
    this.chosen.set(inOrder);
    this.chose.emit(inOrder);
    const first = inOrder[0];
    if (first === undefined) return;
    /*
     * The cards are already drawn -- this only ever selects among what the
     * table is holding -- so the scroll can happen now rather than after a
     * render. `nearest` and not `center`: a selection that is already on screen
     * should not move under the hand that just asked for it.
     */
    const slot = this.host.nativeElement.querySelector(`[data-id="${CSS.escape(first)}"]`);
    slot?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * A CLICK ON A CARD, WHICH IS NOW A SELECTION RATHER THAN AN OPEN.
   *
   * Wave 21 point 1. The three modifiers are the ones every file list in every
   * operating system has taught people, and they are here rather than in the
   * card because only this component can see the other cards:
   *
   *   plain          this card alone
   *   ctrl / meta    toggle this card, keep the rest
   *   shift          the run from the anchor to here, in GRID order
   *
   * THE ANCHOR IS THE LAST CARD CHOSEN WITHOUT SHIFT, which is what makes a
   * run extendable -- shift-clicking twice re-measures from the same start
   * rather than growing from wherever the last shift ended, so somebody who
   * overshoots by three cards corrects with one click instead of starting over.
   */
  protected chooseCard(event: MouseEvent, id: string): void {
    const ids = this.cards().map((card) => card.id);

    if (event.shiftKey && this.anchor !== null) {
      const from = ids.indexOf(this.anchor);
      const to = ids.indexOf(id);
      if (from !== -1 && to !== -1) {
        this.chosen.set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
        this.chose.emit(this.chosen());
        return;
      }
    }

    this.anchor = id;
    if (event.ctrlKey || event.metaKey) {
      const already = this.chosen();
      this.chosen.set(
        already.includes(id)
          ? already.filter((one) => one !== id)
          // Kept in GRID order rather than in click order, so the run a shift
          // extends and the list Delete names read the way the table does.
          : ids.filter((one) => already.includes(one) || one === id),
      );
    } else {
      this.chosen.set([id]);
    }
    this.chose.emit(this.chosen());
  }

  /**
   * Turn every chosen photograph a quarter, in place, on the table.
   *
   * IT DOES NOT CLOSE THE MENU WHEN IT CAME FROM THE HEADER and it does when it
   * came from the menu -- one line, because the menu is a place you press once
   * and the header is a place you press four times to get all the way round.
   * Leaving the selection alone is the same thought: after a turn the same
   * photographs are still chosen, so a shoot that came out sideways is four
   * presses rather than four sweeps.
   */
  protected turnChosen(turns: number): void {
    const photos = this.chosenPhotos();
    if (this.menu() !== null) this.menu.set(null);
    if (photos.length > 0) this.turn.emit({ photos, turns });
  }

  /** What a turn button promises, counted. */
  protected turnSays(way: string): string {
    const count = this.chosenPhotos().length;
    if (count === 0) return 'Choose photographs on the table to turn them';
    return `Turn ${count} ${count === 1 ? 'photograph' : 'photographs'} ${way}`;
  }

  protected removeChosen(): void {
    // PHOTOGRAPHS, matching the number the menu just showed. The parent asks
    // the question about exactly what this offered to do.
    const photos = this.chosenPhotos();
    this.menu.set(null);
    if (photos.length > 0) this.remove.emit(photos);
  }

  /**
   * Delete asks the same question the menu does.
   *
   * Ignored while a field has focus, and while nothing is chosen -- a Delete
   * key that did something invisible would be the worst key on the board.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (!this.active()) return;
    if (event.key !== 'Delete' && event.key !== 'Enter') return;
    if (this.chosen().length === 0) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }

    if (event.key === 'Enter') {
      /*
       * ENTER OPENS, AND IT COUNTS PHOTOGRAPHS RATHER THAN CARDS.
       *
       * Wave 21 says "Enter with one selected". One WHAT is the question a
       * split shoot asks: both halves of a spread are two cards on one
       * photograph, and the editor edits the photograph -- so a person who
       * swept across a single spread has two cards chosen and exactly one
       * thing to open. Counting cards would refuse them for having selected
       * too much of one picture.
       *
       * Asked of the SAME fold the menu and the confirm already use. This is
       * the third reader of chosenPhotos and still the only body of it.
       *
       * A card that has the focus answers Enter itself and stops the event, so
       * this only runs when the focus is on the table -- after a sweep, which
       * is exactly when there is a selection and no focused card.
       */
      if (this.chosenPhotos().length !== 1) return;
      const first = this.chosen()[0];
      if (first === undefined) return;
      event.preventDefault();
      this.open.emit(first);
      return;
    }

    event.preventDefault();
    this.removeChosen();
  }

  /** The pages, in the order they should be drawn. */
  readonly cards = input.required<readonly CaptureCard[]>();
  /** True once the person has dragged, after which the sort no longer applies. */
  readonly arranged = input.required<boolean>();
  /**
   * Whether this table is the surface the keyboard is talking to.
   *
   * FALSE WHILE THE EDITOR IS OPEN OVER IT. Delete and Enter are answered on
   * the WINDOW, so they kept arriving here while the modal had the screen:
   * Delete would have opened a removal confirm for the swept selection behind
   * a picture somebody was cropping, and Enter would have re-opened the
   * photograph already in front of them.
   *
   * An input rather than a look at the DOM, because "is a modal open" is the
   * parent's fact -- this component has never heard of the editor and should
   * not start now to answer a keystroke.
   */
  readonly active = input<boolean>(true);

  /**
   * DRAW THE REGISTERED PAGES — true from the crop pass's Apply onward.
   *
   * The book's pass, handed down rather than asked for, because this component
   * has never held a recipe and this is not the fact to start with. Every card
   * flips together: it is one commitment, made once on the rail, and a table
   * where some cards were photographs and some were pages would be showing two
   * passes at once.
   */
  readonly projecting = input<boolean>(false);

  /**
   * ONE WEBGL CONTEXT FOR THE WHOLE TABLE, BUILT LATE AND KEPT.
   *
   * `rectify.ts` is emphatic and measured about this: Chromium caps live
   * contexts in the low tens and drops the OLDEST when a new one exceeds the
   * cap, silently, so the failure presents as blank cards rather than as an
   * error. Fifty cards each building their own would lose the first thirty.
   *
   * BUILT INSIDE A COMPUTED, which is a side effect in a pure place and is
   * deliberate. The alternative is building it in the constructor, which opens
   * a GPU context for every capture project ever opened including the ones that
   * never leave the crop pass. The computed depends on ONE boolean, so the
   * construction happens at most once per component and only when the table is
   * actually about to draw pages.
   *
   * A window with no WebGL at all gets null and every card falls back to its
   * thumbnail. That is a rougher table, not a broken one, and it is silent
   * because there is nothing a person could do about it here.
   */
  private gl: Rectifier | null = null;
  private glRefused = false;
  protected readonly rectifier = computed<Rectifier | null>(() => {
    if (!this.projecting() || this.glRefused) return null;
    if (this.gl === null) {
      try {
        this.gl = new Rectifier();
      } catch {
        this.glRefused = true;
        return null;
      }
    }
    return this.gl;
  });

  /** The whole list of ids, rearranged — never a single move. */
  readonly reorder = output<readonly string[]>();
  readonly open = output<string>();
  readonly strike = output<string>();
  /** These PHOTOGRAPHS take the book's lines again — the right-click door. */
  readonly follow = output<readonly string[]>();
  /** A sort was picked: the key and the direction. Only the service can sort by spread. */
  readonly sortBy = output<{ key: 'name' | 'taken'; descending: boolean }>();
  /** Whether the Sort dropdown is open. Session-only chrome, nobody else's fact. */
  protected readonly sortOpen = signal(false);
  /** Close the menu, then ask — the act belongs to the service, like every reorder. */
  protected pickSort(key: 'name' | 'taken', descending: boolean): void {
    this.sortOpen.set(false);
    this.sortBy.emit({ key, descending });
  }
  /**
   * Files dropped on the strip. `File` rather than a path, because turning one
   * into the other is `api.pathForFile` and this component holds no bridge —
   * the service does that, and hands the paths to `capture:intake`.
   */
  readonly dropped = output<readonly File[]>();
  /** The marquee's selection, whenever it changes. Page ids, in grid order. */
  readonly chose = output<readonly string[]>();
  /** Delete these PHOTOGRAPHS — the owner confirms and calls the door. */
  readonly remove = output<readonly string[]>();
  /** Turn these photographs a quarter each, where they sit. */
  readonly turn = output<{ photos: readonly string[]; turns: number }>();

  /**
   * WHERE THE CARRIED CARD WOULD GO — an INSERTION INDEX, not a slot.
   *
   * The difference is the whole of Wave 51's reorder fix. It used to be "the
   * slot this would land in front of", which has n values for n cards and can
   * therefore only ever name a position BEFORE something. There are n+1 places
   * to insert into a list of n, and the missing one is the end of the book —
   * which is where a back cover goes.
   *
   * So 0..n, drawn as a leading line on card i for i < n and as a trailing line
   * on the last card for n. Null while nothing is up.
   */
  protected readonly landing = signal<number | null>(null);
  protected readonly hot = signal(false);
  carrying: string | null = null;

  protected pickUp(event: DragEvent, id: string): void { return carry.pickUp.call(this, event, id); }

  protected overTable(event: DragEvent): void { return carry.overTable.call(this, event); }

  landingFor(event: DragEvent): number { return carry.landingFor.call(this, event); }

  protected landOnTable(event: DragEvent): void { return carry.landOnTable.call(this, event); }

  protected putDown(): void { return carry.putDown.call(this); }

  protected leftTable(event: DragEvent): void { return carry.leftTable.call(this, event); }

  /**
   * SCROLL THE TABLE WHILE A CARD IS HELD NEAR ITS EDGE.
   *
   * ── Why a frame loop, when there is a perfectly good event ───────────────
   *
   * An HTML5 drag suppresses pointermove entirely, so `dragover` is the only
   * thing that reports the pointer — and it fires on every small movement and
   * NOT AT ALL while the hand is held still. Scrolling per event would therefore
   * be both jittery (speed set by how fast somebody happens to be moving) and
   * dead in the one case that matters: a card held motionless at the bottom edge
   * of a shoot of a hundred and seventy-nine, waiting to travel. So the event
   * only records WHERE the pointer is, and a frame loop does the moving.
   *
   * ── THE RAMP, AND WHY IT IS NOT A CONSTANT ──────────────────────────────
   *
   * Speed rises from nothing at the edge of the band to `SCROLL_STEP` at the
   * table's border, which makes the gesture controllable: a person nudging into
   * the band creeps a row, and one who wants the far end of the book pushes to
   * the edge. A single speed is either too slow to cross a long table or too
   * fast to stop on a row.
   */
  chasing = 0;
  chasingAt: number | null = null;

  chase(y: number): void { return carry.chase.call(this, y); }

  stopChasing(): void { return carry.stopChasing.call(this); }

  tableEl(): HTMLElement | null { return carry.tableEl.call(this); }

  protected warm(event: DragEvent): void { return carry.warm.call(this, event); }

  protected cool(): void { return carry.cool.call(this); }

  protected take(event: DragEvent): void { return carry.take.call(this, event); }
}

import type { CaptureQuad } from '@shared/types';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { CaptureCardComponent } from './capture-card.component';

/** One page on the table, as the grid needs to draw it. */
export interface CaptureCard {
  /** The page id — `<photoId>:<n>`, the recipe's own. */
  readonly id: string;
  /**
   * The PHOTOGRAPH this page is on.
   *
   * Here so the grid can count photographs without holding a recipe. It could
   * be parsed out of the id, and must not be: a surface that derives an
   * identity by splitting a string is a surface that keeps working until the
   * day the id format changes under it.
   */
  readonly photoId: string;
  /** The 640 px thumbnail's URL, through the capture door. */
  readonly thumb: string;
  /** What to call it on the table. */
  readonly label: string;
  /** Struck pages stay on the table and out of the mint. */
  readonly struck: boolean;
  /** The page this card will mint, for the crop drawn over its thumbnail. */
  quad: CaptureQuad;
  /**
   * THE PHOTOGRAPH'S PIXELS, and the card cannot do without them.
   *
   * A quad is FRACTIONS of the working copy, so a half-width crop reads
   * 0.5 x 1.0 on every photograph in the project -- and the page it prints is
   * 2016 x 3024 on one shot and something else entirely on another. The shape a
   * card must draw itself at is not recoverable from the quad alone.
   *
   * They are on the card rather than looked up because the grid holds cards and
   * not a recipe, which is the line this file's docblock already draws.
   */
  readonly width: number;
  readonly height: number;
  /**
   * SOMEBODY PLACED THIS ONE THEMSELVES, so a global leaves it alone.
   *
   * The table has to say it because the promise is open-ended: a photograph with
   * its own crop sits out every future *Crop all* for the life of the project.
   * Without a mark, the way to find the ones that did not move is to press the
   * button, count the cards, and squint -- and the rail's "2 by hand" says how
   * many while saying nothing about which.
   *
   * A fact about the PHOTOGRAPH, so both cards of a cut spread carry it: the
   * mark is set on every page of a photograph together, and a pair showing it on
   * one card and not its twin would read as a defect rather than as a pair.
   */
  readonly own: boolean;
}

/**
 * The drag payload's type. A private MIME rather than `text/plain` so a page
 * dragged inside the grid is distinguishable, BEFORE the drop, from a file
 * dragged in from Explorer — `dataTransfer.types` is the only part of a payload
 * readable during a drag, and the two mean opposite things here. The dock does
 * the same for its document rows, and for the same reason.
 */
const PAGE_MIME = 'application/x-foundry-capture-page';

/**
 * THE LIGHT TABLE — the main viewer for a capture project with no minted PDF.
 *
 * ── What this owns, and what it refuses to ──────────────────────────────────
 *
 * The arrangement: which card sits where, which way the sort runs, where a
 * dragged page lands, and where files may be dropped. It owns none of the
 * meaning — a card is a row of pixels and a label handed to it, the recipe is
 * the service's, and every gesture leaves here as an event rather than as a
 * mutation.
 *
 * That is what lets the grid be drawn against anything: it never learns what a
 * quad is, and the rules about spreads and splits live where they can be shared
 * (`capture-editor/geometry.ts`, and the service above it).
 *
 * ── A CLICK CHOOSES; OPENING TAKES TWO ─────────────────────────────────────
 *
 * Wave 21 point 1. Until tonight a single click OPENED the editor, so the only
 * way to select one card was to draw a marquee band across it and stop -- and
 * selection is now the gesture the table is FOR: it feeds reorder, delete, and
 * which photograph the modal opens on. A gesture that common cannot cost a
 * rubber band.
 *
 * So a click chooses, ctrl and meta toggle, shift takes the run, and OPENING is
 * a double-click or Enter. The marquee is untouched and still starts anywhere
 * on the table, because at fifty-two cards almost every pixel is a card.
 *
 * The one number that moves between the two worlds is what "one selected" means
 * for Enter: PHOTOGRAPHS, not cards, through the same fold the menu and the
 * confirm use. Both halves of a split spread are two cards on one picture, and
 * the editor edits the picture.
 *
 * ── THE ORDER STOPS BEING A SORT THE MOMENT SOMEBODY DRAGS ──────────────────
 *
 * docs/CAPTURE.md: cards arrive "sorted by capture time … Cards drag to
 * reorder; once the user has dragged, the sort is history and their order is the
 * order." So this component emits a REORDER — the full list of ids in their new
 * arrangement — and never a "move card 3 to slot 7" that a re-sort could
 * silently undo. The service decides that the recipe's `order` is now the
 * person's and stops sorting.
 *
 * ── REVERSE IS ASKED FOR, NOT DONE ──────────────────────────────────────────
 *
 * The doc's sharpest trap: "Reverse operates on capture order, not on split
 * halves. A book shot back-to-front reverses into reading order by spread;
 * within each split the left page still precedes the right. Reversing raw page
 * cards would silently swap every pair." A grid holding a flat list of cards
 * CANNOT honour that — it cannot see which two cards were one photograph. So it
 * emits `reverse` and the service, which holds the photos, does it properly.
 * Reversing the array here would be exactly the bug the doc names.
 *
 * ── The drop zone stops the drop, and that was NOT ENOUGH ───────────────────
 *
 * This zone calls `stopPropagation` so the window’s own file-drop handler does
 * not also answer a drop the grid has taken. That much was always right and it
 * still is. What it was NOT is sufficient, and Owen found out in the first
 * minutes of the acceptance run: the zone is a STRIP DOWN ONE SIDE, so a drop
 * on the table, on the empty state, or on the header sailed past it to the
 * window and came back as “IMG_0238.HEIC is not something Foundry opens”.
 *
 * The window handler now routes a drop to intake whenever a capture tab is in
 * front (app.ts, `intaking`), which is the app’s own philosophy applied where
 * it had not been: dropping a book at the app is not aiming at a rectangle, and
 * neither is dropping photographs. So this strip is no longer the only way in —
 * it is the OBVIOUS one, kept because a gesture with nowhere visible to aim is
 * a gesture people do not discover.
 *
 * `stopPropagation` therefore now prevents a DOUBLE INTAKE rather than a wrong
 * one. Both paths call the same `intake`, and without it a drop on the strip
 * would be answered twice.
 */
/**
 * How far a pointer must travel before a press becomes a sweep rather than a
 * click. Small enough that a deliberate drag is caught immediately, large
 * enough that a click with a shaky hand is still a click.
 */
const SWEEP_STARTS_AT = 5;

@Component({
  selector: 'app-capture-grid',
  imports: [CaptureCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="column">
    <header>
      <span class="count">{{ cards().length }} {{ cards().length === 1 ? 'page' : 'pages' }}</span>
      <!--
        Disabled on an empty table as well as an arranged one. Reversing nothing
        is a control that does nothing, which this component has already decided
        once (the note below) reads as a broken app rather than as a no-op.
      -->
      <button type="button" (click)="reverse.emit()" [disabled]="arranged() || cards().length === 0">
        {{ descending() ? 'Oldest first' : 'Newest first' }}
      </button>

      <!--
        TURNING IS A TABLE ACT, not only an editor one.

        Owen: *"i think rotate should be the kind of thing where i select items
        on the main window and then click rotate and it just rotates the ones i
        have selected in-place"*. Turning a photograph the right way up is the
        commonest thing anybody does to a shoot and it needed a double-click, a
        modal, a tool tab and a trip back -- for a gesture whose whole content
        is "this one is on its side".

        It acts on the SELECTION and says how many, because a turn that quietly
        took the whole table would be unrecoverable-looking on a shoot of
        fifty. Nothing chosen, nothing offered.
      -->
      <span class="turnpair">
        <button
          type="button"
          [disabled]="chosenPhotos().length === 0"
          [title]="turnSays('anticlockwise')"
          (click)="turnChosen(-1)"
        >⟲</button>
        <button
          type="button"
          [disabled]="chosenPhotos().length === 0"
          [title]="turnSays('clockwise')"
          (click)="turnChosen(1)"
        >⟳</button>
      </span>
      @if (arranged()) {
        <!--
          Said out loud rather than just disabling the button: the sort is gone
          because the person arranged the pages themselves, and a control that
          greys with no reason reads as a bug.
        -->
        <span class="note">Your order — the capture-time sort no longer applies</span>
      }
    </header>

    <!--
      THE MARQUEE IS ON THE TABLE, NOT ON THE CARDS. A rubber band that started
      only on empty space would be unusable at twenty-seven cards, where almost
      every pixel is a card -- so the press starts anywhere and a card decides on
      RELEASE whether it was a click or the beginning of a sweep.
    -->
    <div
      class="table"
      (pointerdown)="startSweep($event)"
      (pointermove)="moveSweep($event)"
      (pointerup)="endSweep($event)"
      (pointercancel)="endSweep($event)"
      (contextmenu)="openMenu($event)"
    >
      @if (band(); as box) {
        <div
          class="band"
          [style.left.px]="box.left"
          [style.top.px]="box.top"
          [style.width.px]="box.width"
          [style.height.px]="box.height"
        ></div>
      }
      @for (card of cards(); track card.id; let index = $index) {
        <div
          class="slot"
          [attr.data-id]="card.id"
          [class.landing]="landing() === index"
          draggable="true"
          (dragstart)="pickUp($event, card.id)"
          (dragover)="over($event, index)"
          (dragend)="putDown()"
          (drop)="land($event, index)"
        >
          <app-capture-card
            [chosen]="chosen().includes(card.id)"
            [thumb]="card.thumb"
            [label]="card.label"
            [struck]="card.struck"
            [own]="card.own"
            [quad]="card.quad"
            [width]="card.width"
            [height]="card.height"
            (choose)="chooseCard($event, card.id)"
            (open)="open.emit(card.id)"
            (strike)="strike.emit(card.id)"
          />
        </div>
      } @empty {
        <!--
          IT DOES NOT SAY WHERE TO AIM ANY MORE. It used to read "Drop them on the
          strip to the right", which was the instruction the window handler made
          unnecessary -- and this is the FIRST SENTENCE a person reads after
          making a project, which is exactly where Owen was standing when the
          drop failed. Telling him to aim at a strip he no longer has to find
          would have taught the wrong gesture at the one moment he was looking
          for the right one.
        -->
        <p class="empty">No photographs yet — drop them anywhere in this window.</p>
      }
    </div>
    </div>

    <!--
      PERSISTENT, for the life of the project (docs/CAPTURE.md: "Files can keep
      landing there for the life of the project") — not a state the grid enters
      when something is dragged over it. A zone that only appears mid-drag is a
      zone you have to already know about.
    -->
    @if (menu(); as at) {
      <!--
        Owen's flow: sweep, then right-click the highlighted cards. The menu is
        the only place Delete is offered by mouse, so it names the count rather
        than the word "selection" -- somebody about to destroy nine photographs
        should read the nine.
      -->
      <div class="menu" [style.left.px]="at.x" [style.top.px]="at.y">
        <button type="button" (click)="turnChosen(-1)">
          Turn {{ chosenPhotos().length }}
          {{ chosenPhotos().length === 1 ? 'photograph' : 'photographs' }} left
        </button>
        <button type="button" (click)="turnChosen(1)">
          Turn {{ chosenPhotos().length }}
          {{ chosenPhotos().length === 1 ? 'photograph' : 'photographs' }} right
        </button>
        <button type="button" (click)="removeChosen()">
          Delete {{ chosenPhotos().length }}
          {{ chosenPhotos().length === 1 ? 'photograph' : 'photographs' }}…
        </button>
      </div>
    }

    <aside
      class="dropzone"
      [class.hot]="hot()"
      (dragenter)="warm($event)"
      (dragover)="warm($event)"
      (dragleave)="cool()"
      (drop)="take($event)"
    >
      <span>Drop photographs here</span>
    </aside>
  `,
  styles: [`
    .table { position: relative; }
    /* A hairline and a wash. The band is a statement about a region, not an
       object in its own right, so it does not compete with the photographs. */
    .band {
      position: absolute;
      z-index: 2;
      border: 1px solid var(--accent);
      background: var(--accent-faint);
      pointer-events: none;
    }
    .menu {
      position: fixed;
      z-index: 1100;
      padding: 4px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 12px 24px -8px rgba(0, 0, 0, 0.5);
    }
    .menu button { border: none; background: transparent; white-space: nowrap; }
    .menu button:hover { background: var(--bg-hover); }

    /* The table and the strip side by side; the header above the table only. */
    :host { display: flex; flex-direction: row; height: 100%; min-height: 0; }
    .column { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }

    header {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--text-tertiary);
    }
    header button {
      padding: 3px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }
    header button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    header button:disabled { opacity: 0.4; cursor: default; }
    .note { font-style: italic; }

    .table {
      flex: 1;
      min-width: 0;
      align-content: start;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 10px;
      padding: 10px;
      overflow-y: auto;
    }

    .slot { position: relative; }
    /*
      The landing is a line down the leading edge rather than a gap that opens
      up: an insertion that reflows the whole grid moves every other card out
      from under the pointer while the person is still aiming at one.
    */
    .slot.landing::before {
      content: '';
      position: absolute;
      inset: -5px auto -5px -6px;
      width: 2px;
      background: var(--accent, #4c9aff);
    }

    .empty { color: var(--text-tertiary); font-size: 12px; padding: 20px; }

    .dropzone {
      flex: 0 0 130px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 10px;
      padding: 10px;
      border: 1px dashed var(--border-default);
      border-radius: var(--radius-md, 6px);
      color: var(--text-tertiary);
      font-size: 12px;
      text-align: center;
    }
    .dropzone.hot { border-color: var(--accent, #4c9aff); color: var(--text-primary); background: var(--bg-hover); }
  `],
})
export class CaptureGridComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

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
    const table: HTMLElement | null = this.host.nativeElement.querySelector('.table');
    return table === null ? null : table.getBoundingClientRect();
  }

  /**
   * Right-click on the selection. Owen's own flow: sweep, then right-click the
   * highlighted cards.
   *
   * A right-click on NOTHING chosen is left to the platform rather than
   * answered with an empty menu -- a menu whose only item would be "Delete 0"
   * is a menu that exists to say no.
   */
  protected openMenu(event: MouseEvent): void {
    if (this.chosen().length === 0) return;
    event.preventDefault();
    this.menu.set({ x: event.clientX, y: event.clientY });
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
  /** Which way the capture-time sort runs, while there still is one. */
  readonly descending = input.required<boolean>();
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

  /** The whole list of ids, rearranged — never a single move. */
  readonly reorder = output<readonly string[]>();
  readonly open = output<string>();
  readonly strike = output<string>();
  /** Asked for, not done: only the service can reverse by spread. */
  readonly reverse = output<void>();
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

  /** The slot a dragged card would land in front of, or null when nothing is up. */
  protected readonly landing = signal<number | null>(null);
  protected readonly hot = signal(false);
  private carrying: string | null = null;

  protected pickUp(event: DragEvent, id: string): void {
    this.carrying = id;
    event.dataTransfer?.setData(PAGE_MIME, id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected over(event: DragEvent, index: number): void {
    if (this.carrying === null) return;
    // Without preventDefault the browser refuses the drop and the whole gesture
    // ends in the "return to origin" animation with nothing having happened.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.landing.set(index);
  }

  protected land(event: DragEvent, index: number): void {
    const carried = this.carrying;
    this.putDown();
    if (carried === null) return;
    event.preventDefault();
    // Inside the grid only — a file dropped on a card is not a reorder, and
    // letting it fall through to the window would open it as a document.
    event.stopPropagation();

    const ids = this.cards().map((card) => card.id);
    const from = ids.indexOf(carried);
    if (from === -1 || from === index) return;

    const rest = ids.filter((id) => id !== carried);
    // The landing is a slot in the ORIGINAL list; once the carried card is
    // removed, every slot after it shifts down by one.
    const at = from < index ? index - 1 : index;
    this.reorder.emit([...rest.slice(0, at), carried, ...rest.slice(at)]);
  }

  protected putDown(): void {
    this.carrying = null;
    this.landing.set(null);
  }

  protected warm(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.hot.set(true);
  }

  protected cool(): void {
    this.hot.set(false);
  }

  protected take(event: DragEvent): void {
    this.cool();
    if (!carriesFiles(event)) return;
    event.preventDefault();
    // See the class docblock: the window now intakes too, so without this a
    // drop on the strip would be answered twice.
    event.stopPropagation();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) this.dropped.emit(files);
  }
}

/** Whether a drag carries files from outside the app rather than a page card. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}

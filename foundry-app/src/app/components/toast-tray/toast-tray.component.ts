import {
  ChangeDetectionStrategy, Component, DestroyRef, HostListener, effect, inject, signal, untracked,
} from '@angular/core';

import { hosted } from '../../core/foundry';
import { NoticeService } from '../../core/notice.service';

/**
 * WHAT THE WINDOW SAYS ABOUT ITSELF, said in the corner and then let go.
 *
 * A drop this app will not open, a save that failed, an intake that took nine
 * photographs and refused three. Everything that goes wrong OUT HERE — rather
 * than inside a document, where the document's own surface says it — arrives on
 * `NoticeService.notice` and is drawn here, bottom-right, one card per sentence,
 * newest nearest the corner and the older ones pushed up above it.
 *
 * ── Why it is a toast and no longer a strip along the top ────────────────────
 *
 * Owen's ruling, 2026-08-22: Foundry's notices should be toasts. He hit it on a
 * capture intake refusal — a multi-line report about which photographs came in
 * and which would not, drawn as a full-width band under the window's chrome,
 * which pushed the whole workspace down to say something about three files. A
 * band across the top of a document app is furniture: it takes height off the
 * page for as long as it is up, it is nowhere near whatever the person just
 * clicked, and it has to be dismissed by hand before the window is the size it
 * was. A card in the corner takes nothing, appears where the app's other
 * transient reports appear, and leaves by itself.
 *
 * ── THE CONSUME-AND-RESET CONTRACT, which is the whole of the mechanism ──────
 *
 * `NoticeService.notice` is a bare writable signal with dozens of writers and,
 * as of this component, exactly ONE reader — this tray. The effect below reads a
 * non-null value, copies it into this component's own stack, and SETS THE SIGNAL
 * BACK TO NULL in the same turn. The signal is therefore a doorway rather than a
 * place: it holds a sentence for the length of one effect and is empty again,
 * which is what lets the stack exist at all.
 *
 * WHAT THAT BUYS IS THE SECOND SENTENCE. The old strip drew the signal directly,
 * so a notice raised while another was still up REPLACED it — silently, with no
 * mark of any kind — and the first sentence was simply gone whether or not
 * anybody had read it. Every batch operation in this app can raise two: a save
 * that fails while a refusal is up, an intake report followed by the mint's own.
 * Stacking is not a feature that was added here; it is what falls out of a reader
 * that empties the door behind itself.
 *
 * It also makes the SAME sentence twice work, which it did not before: two
 * identical failures used to set an identical string and change nothing, so the
 * second one was invisible. Null in between means the second one is a change.
 *
 * ── Where it sits, and the arithmetic behind the number ──────────────────────
 *
 * The queue shelf owns the bottom-right corner: `bottom: 16px`, 320px wide,
 * z-index 900, unrolling upward. Fully open it is about 393px tall — a 37px
 * head, a 12px aggregate bar, 300px of scrolling rows, a 42px foot and its two
 * borders — so its top edge lands about 409px off the bottom of the window. This
 * tray is anchored at `bottom: 424px`, which is that plus a 15px gap, and grows
 * upward from there. A shelf with every row showing and a toast are both
 * readable at once, which is the case that matters: the shelf is where the work
 * is, and the sentence about why some of it did not happen must not cover it.
 *
 * THE OFFSET IS FIXED AND THAT COSTS SOMETHING, named here rather than
 * discovered later. Most of the time the shelf is a collapsed pill 37px tall,
 * or — with no jobs — nothing, and then a toast floats with several hundred
 * pixels of empty window under it. The alternative is a tray that reads the
 * queue's state and moves, and that is worse in the way that matters: a
 * sentence that jumps up the screen while somebody is reading it, because a
 * job they had nothing to do with finished. A gap is quiet; motion under the
 * eye is not.
 *
 * HOSTED IS NOT THAT CASE, and Owen met the difference before this clause did
 * (*"it was elevated to halfway up the screen"*, a hosted narrate refusal —
 * relayed with the argument by the host side, 2026-08-22). Hosted there is NO
 * shelf, ever (d9ed267, Owen's own ruling), and `hosted()` is fixed for the
 * life of the window — so a hosted tray anchored in the corner is not a tray
 * that moves, it is a second static layout. The anti-motion argument was about
 * queue state changing under a reader's eye; a fact that cannot change during
 * a session costs none of that. Standalone keeps the held gap exactly as
 * chosen, because there the shelf CAN appear.
 *
 * z-index 1100: above the shelf (900) and the drag veil (1000), below the
 * dialogs (1200). A dialog is a question being asked right now and must not have
 * a card over its corner; the shelf and the veil are surfaces a notice is
 * routinely ABOUT, so it goes over them.
 *
 * ── THE NAMED COST: EVERY SENTENCE EXPIRES AT THE SAME EIGHT SECONDS ─────────
 *
 * `NoticeService` has no severity — no formatting, no history, no levels — and
 * this tray invents none, because a red card over a message the data cannot
 * classify would be the app claiming to know something it does not. The
 * consequence is real and is accepted deliberately: a REFUSAL times out on the
 * same eight seconds as a confirmation, so somebody who started an export and
 * walked away can come back to a window with nothing on it and no idea that the
 * export was declined. The old strip held such a sentence until it was dismissed,
 * and that much it did better.
 *
 * IF THAT BITES, THE FIX IS A SEVERITY FIELD ON THE SERVICE — a second argument
 * at the writing sites that already know which kind of sentence they are raising,
 * and a tray that gives an error no timer at all. It is deferred, not forgotten,
 * and it is deferred because guessing severity from the text ("does it contain
 * the word failed") would be a heuristic making a promise the data cannot keep.
 *
 * ── The rest of the behaviour ────────────────────────────────────────────────
 *
 * FOUR AT A TIME, AND THE FIFTH IS NOT DROPPED. Notices beyond the visible four
 * wait in a line and are shown as the ones above them leave, so a burst of
 * sentences is a queue rather than a stampede, and no sentence raised is a
 * sentence nobody ever had the chance to read. (Four because a fifth card would
 * be climbing towards the middle of the window, and because past four the person
 * has plainly stopped reading them one at a time.)
 *
 * HOVER IS READING, SO HOVER STOPS THE CLOCK. Every visible toast's timer pauses
 * while the pointer is anywhere in the tray and resumes with the time it had left
 * when the pointer goes. A multi-line intake report does not fit in eight seconds
 * of glancing, and the one gesture that says "I am reading this" is the pointer
 * arriving on it. The ✕ ends one immediately.
 */
@Component({
  selector: 'app-toast-tray',
  changeDetection: ChangeDetectionStrategy.OnPush,
  /*
    THE REGION IS ALWAYS IN THE DOM, EMPTY OR NOT, and that is the whole reason
    the live-region attributes are on the host rather than on a wrapper inside
    the template. A live region that is created at the same moment as its first
    child is a region screen readers may never announce — the announcement is of
    a CHANGE INSIDE a region that was already being watched. The host element
    exists for the life of the window and is zero-sized while the stack is empty
    (see the styles), so this costs a node and nothing else.

    Polite rather than assertive: a notice is news about something the person
    just did, not an alarm that should cut across what is being read to them.
  */
  host: { 'role': 'status', 'aria-live': 'polite', '[class.hosted]': 'hosted()' },
  template: `
    @for (toast of shown(); track toast.id) {
      <div class="toast">
        <!--
          \`pre-line\` because a good half of what lands here is a REPORT rather
          than a sentence: the capture intake writes one line per outcome, and
          collapsing those newlines would run nine findings into one paragraph.
          It is the one piece of rendering this tray does to the string, and it
          preserves the writer's own line breaks without honouring runs of spaces
          — a message is prose, not a table.
        -->
        <p class="said">{{ toast.text }}</p>
        <button class="x" type="button"
                (click)="dismiss(toast.id)"
                title="Dismiss"
                aria-label="Dismiss this notice">✕</button>
      </div>
    }
  `,
  styles: [`
    /*
      SHRINK TO FIT, so an empty tray is an empty box and not an invisible sheet
      over the corner of the window. A fixed element with no width takes the
      width of its content, and with no toasts there is no content: zero pixels,
      nothing to intercept a click, nothing to hover. That is also why the pause
      listeners can live on the host — the box is the cards and the gaps between
      them, so the pointer entering it means the pointer is in the stack.
    */
    :host {
      position: fixed;
      right: 16px;
      /* The standalone anchor; hosted overrides to the corner — see the header. */
      bottom: 424px;
      z-index: 1100;
      display: flex;
      flex-direction: column;
      /*
        Plain column with the newest appended LAST, which is what puts the newest
        card at the bottom of the stack, nearest the corner. The box is anchored
        by its bottom edge, so each arrival grows it upward and the older cards
        move up rather than the new one landing on top of them.
      */
      justify-content: flex-end;
      align-items: flex-end;
      gap: 8px;
      max-width: 400px;
      /*
        The ceiling is the top of the window with the tray's own offset taken off
        it. Four long reports at 40vh apiece cannot fit in any window, and the
        overflow is clipped from the TOP — which takes the oldest cards, the ones
        already closest to expiring, rather than the one that just arrived.
      */
      max-height: calc(100vh - 440px);
      overflow: hidden;
    }
    /*
      Hosted: no shelf exists to clear (d9ed267), and hosted() cannot change
      while the window lives -- a second static layout, not a moving anchor.
      The header carries the whole argument.
    */
    :host(.hosted) { bottom: 16px; max-height: calc(100vh - 32px); }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      flex: 0 0 auto;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      /* The shelf's shadow, verbatim: the two surfaces float over the same
         corner and a card that hovered at a different height would read as
         belonging to a different app. */
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      color: var(--text-primary);
      font-size: 13px;
      /* The dialogs' entrance, at the dialogs' timing (140ms, same curve): this
         is the same act — something arriving over the window — and the house has
         one gesture for it. */
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .said {
      flex: 1 1 auto;
      min-width: 0;
      margin: 0;
      white-space: pre-line;
      line-height: 1.45;
      /* A long report scrolls INSIDE its own card rather than growing one that
         reaches the top of the window. 40vh is about as much of the screen as a
         thing nobody asked to see may take. */
      max-height: 40vh;
      overflow-y: auto;
      overflow-wrap: anywhere;
    }

    .x {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
      padding: 2px 4px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    /*
      SOMEBODY WHO HAS ASKED FOR LESS MOTION STILL GETS THE SENTENCE, it simply
      does not slide in. Nothing is lost with the animation off — the card says
      what it says by being there, and the rise was only ever the manners.
    */
    @media (prefers-reduced-motion: reduce) {
      .toast { animation: none; }
    }
  `],
})
export class ToastTrayComponent {
  /** Anchors the tray in the corner where no shelf can exist — see the header. */
  protected readonly hosted = hosted;

  private readonly notices = inject(NoticeService);

  /** The cards on screen, oldest first — the last one is nearest the corner. */
  protected readonly shown = signal<readonly Toast[]>([]);

  /**
   * Sentences raised while four were already up, in the order they were said.
   *
   * A plain array rather than a signal: nothing draws it. What it protects is the
   * promise that a notice raised is a notice eventually shown — the alternative
   * to a line here is dropping the fifth sentence on the floor, which is the
   * exact failure the old strip had and the reason this component exists.
   */
  private readonly waiting: string[] = [];

  /** One clock per visible card. See `startClock` for why it is not just a handle. */
  private readonly clocks = new Map<number, Clock>();

  /** True while the pointer is in the tray, which is the app's proxy for reading. */
  private reading = false;

  private nextId = 1;

  constructor() {
    /*
     * THE DOOR, READ AND EMPTIED. See the class docblock for the contract; the
     * mechanics are that reading a non-null value and writing null back makes
     * this effect run a second time, on null, where it returns at the first line.
     *
     * `untracked` around the side effects so that the stack this component keeps
     * is not a dependency of the effect that fills it — without it, every
     * dismissal would re-run this, harmlessly but for no reason at all.
     */
    effect(() => {
      const said = this.notices.notice();
      if (said === null) return;
      untracked(() => {
        this.notices.notice.set(null);
        this.offer(said);
      });
    });

    /*
     * The window is going and there may be four timers standing. Nothing in this
     * app destroys the tray short of the window closing, so this is insurance
     * rather than a live path — but a component that leaves callbacks pointing at
     * a destroyed instance is a component that will one day be mounted twice.
     */
    inject(DestroyRef).onDestroy(() => {
      for (const clock of this.clocks.values()) {
        if (clock.handle !== null) clearTimeout(clock.handle);
      }
      this.clocks.clear();
    });
  }

  /** A new sentence: shown now if there is room, otherwise put in the line. */
  private offer(text: string): void {
    if (this.shown().length >= VISIBLE) {
      this.waiting.push(text);
      return;
    }
    this.raise(text);
  }

  /** Put a card on screen and start its clock — unless a pointer is already in
   *  the tray, in which case it arrives paused, like everything beside it. */
  private raise(text: string): void {
    const id = this.nextId;
    this.nextId += 1;
    this.shown.update((list) => [...list, { id, text }]);
    const clock: Clock = { handle: null, left: LIFE_MS, since: 0 };
    this.clocks.set(id, clock);
    if (!this.reading) this.startClock(id, clock);
  }

  /**
   * Arm one card's timer for whatever time it has left.
   *
   * THE CLOCK REMEMBERS RATHER THAN RESTARTS, which is the whole reason it is a
   * record and not a bare handle: `setTimeout` cannot be paused, so a pause is a
   * `clearTimeout` plus the arithmetic of how much of the eight seconds had
   * already run. Re-arming at the full eight would mean a card the pointer
   * brushed twice never leaves.
   */
  private startClock(id: number, clock: Clock): void {
    clock.since = Date.now();
    clock.handle = setTimeout(() => this.dismiss(id), clock.left);
  }

  /**
   * A card leaves — by its own timer or by its ✕ — and the next one in the line
   * takes its place immediately, rather than waiting for a fifth notice to push
   * it out.
   */
  protected dismiss(id: number): void {
    const clock = this.clocks.get(id);
    if (clock !== undefined && clock.handle !== null) clearTimeout(clock.handle);
    this.clocks.delete(id);
    this.shown.update((list) => list.filter((toast) => toast.id !== id));

    const next = this.waiting.shift();
    if (next !== undefined) this.raise(next);
  }

  /**
   * The pointer is in the tray, so every clock stops.
   *
   * ALL OF THEM AND NOT THE ONE UNDER THE CURSOR, because the tray is read as a
   * column: somebody working down four cards would otherwise watch the three
   * they had not reached yet expire while they read the first.
   */
  @HostListener('pointerenter')
  protected hold(): void {
    this.reading = true;
    const now = Date.now();
    for (const clock of this.clocks.values()) {
      if (clock.handle === null) continue;
      clearTimeout(clock.handle);
      clock.handle = null;
      clock.left = Math.max(0, clock.left - (now - clock.since));
    }
  }

  @HostListener('pointerleave')
  protected release(): void {
    this.reading = false;
    for (const [id, clock] of this.clocks) {
      if (clock.handle === null) this.startClock(id, clock);
    }
  }
}

/** One card: the sentence, and an id that is only ever compared. */
interface Toast {
  readonly id: number;
  readonly text: string;
}

/**
 * A card's timer, held open so it can be stopped and started again.
 *
 * `left` is the milliseconds still owed at the moment it was last armed, `since`
 * the clock time it was armed at, and `handle` null exactly when the card is
 * paused. See `startClock`.
 */
interface Clock {
  handle: ReturnType<typeof setTimeout> | null;
  left: number;
  since: number;
}

/**
 * How long a sentence stands unattended.
 *
 * Eight seconds is the read time of a two-line notice with a beat either side of
 * it, and it is the same eight seconds for a refusal as for a confirmation — the
 * cost this component names in its docblock, and the thing a severity field on
 * `NoticeService` would fix.
 */
const LIFE_MS = 8000;

/** How many stand at once. The rest wait; none are dropped. */
const VISIBLE = 4;

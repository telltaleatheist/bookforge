import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';

import { analysisCategoryHue, analysisCategoryName } from '@owen/foundry-core/shared/analysis-categories';

import { AnalysisViewService } from '../../core/analysis-view.service';
import { BookStacksService } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import type { AnalysisHit } from '@owen/foundry-core/shared/analysis';

/**
 * THE HITS PANEL — what the analysis found, in the slot Compare would have had.
 *
 * Owen, 2026-08-25: *"it should light up/highlight text that matches the
 * categories, and have a list of hits in blocks on the right side, where compare
 * would normally be."* This is the right-hand side. The lighting is the paper's
 * own (`book-view.component.ts`), driven by the same signals this panel reads, so
 * the two halves of that sentence can never disagree about which passages are in.
 *
 * ── IT IS A COLUMN AND NOT A MODAL, WHICH IS THE POINT ──────────────────────
 *
 * The sweep is a card, and it CLOSES when a row travels: the point of that trip
 * is to look at the paragraph, and a modal over the page would be the one thing
 * in the way. This is a column standing beside the page, so travel closes
 * nothing — you click a card, the paper scrolls, the list is still there, and the
 * next one is one click away. That is the whole argument for taking Compare's
 * slot rather than being a seventh dialog (docs/ANALYSIS.md §8).
 *
 * ── THE REWORK, 2026-08-25, CLAUSE BY CLAUSE ────────────────────────────────
 *
 * The first cut of this panel was sections: a category heading, then its
 * findings, then the next heading, each row a chip naming a block id, a
 * quotation with the hit lit inside it, and a hover glance holding a longer
 * quotation. Owen read it and said what was wrong with it:
 *
 *   *"lets rework it a bit so each item is in its own block, in the order in
 *   which it appears. maybe each category has its own color or something… im
 *   not sure what the items next to the quotes mean. b151-5? b159-2? those arent
 *   necessary for a human to see. the tool tips are just repeating whats already
 *   on screen - unnecessary. and they shouldnt be highlighted inside the
 *   analysis, they should be highlighted inside the document viewer (as they
 *   are). as i scroll/click highlighted text, it should jump to that spot in the
 *   analysis"*
 *
 * Every clause is answered here and each answer is a rule rather than a tweak:
 *
 *   **ONE CARD PER FINDING, IN THE BOOK'S ORDER.** The grouping is gone. A list
 *   beside a book is read AGAINST the book, and grouping scatters one page's
 *   findings down five sections — so the list is the flat sequence `place()`
 *   already returns, which is reading order (core/analysis.ts). What the
 *   headings used to carry — the category names and their counts — is the legend
 *   above, where it is also the filter.
 *
 *   **A HUE PER CATEGORY, ON THE RAIL.** The card's left edge is the category's
 *   colour, which is the app's own gutter-rail idiom (the block chrome next
 *   door), and the same colour is the legend's dot. The hues come from ONE table
 *   (`ANALYSIS_CATEGORIES`, shared/analysis-categories.ts) and mean nothing as a
 *   scale — there is no severity in this feature and a cool-to-hot table would
 *   have smuggled one in through the paint.
 *
 *   **AND THE PAPER KEEPS ITS ONE INK.** docs/ANALYSIS.md §8 — *"the page must
 *   not turn into confetti"* — stands exactly as written, and this table does not
 *   reach it: `Piece.hit` is still one field with no category in it and the sheet
 *   still lights every finding in `--ink-hit`. Colour here is a legend for a
 *   list; colour there would be four inks on a paragraph.
 *
 *   **NO BLOCK IDS.** `b151-5` is a coordinate this program keys ops and travel
 *   by, and it is not a thing a reader has any use for. It is gone from the
 *   surface, and the codebase's standing rule about filenames in user-facing copy
 *   is read here as covering it: a person is shown the words and the page, never
 *   the address the words are filed under. TRAVEL IS THE WHOLE CARD, which is
 *   also the fix for what the chip cost — a button the size of a chip inside a
 *   row the size of a paragraph is a target you can miss.
 *
 *   **NO TOOLTIP THAT REPEATS THE CARD.** What was on hover is on the card, in
 *   words, or it is not there at all: the categories a passage ALSO matched are
 *   named instead of counted, and the verifier's reason for each is a sentence
 *   on the card. (The tier buttons and the score, the two that carried a hover
 *   sentence of their own, went with the tiers on 2026-09-25.)
 *
 *   **THE GLANCE IS CUT, and that is a judgement rather than an omission.** It
 *   was the one hover on this panel that showed MORE than the row did (the fuller
 *   passage), so it survives the "repeats what is on screen" test — and it goes
 *   anyway, because the rework gives its job to something strictly better. A card
 *   click now travels to the passage AND the paper scrolls this list back, so the
 *   fuller passage is not a rectangle that appears under a pointer held still: it
 *   is the book, in the column beside the list, with the words lit in place. A
 *   floating preview of a paragraph you are one click from reading is a worse
 *   copy of the reading — and it was a rectangle that appeared under the pointer
 *   exactly where the pointer is now aiming at a click target.
 *
 *   **THE QUOTATION IN THE CARD IS PLAIN PROSE.** *"They shouldnt be highlighted
 *   inside the analysis, they should be highlighted inside the document viewer
 *   (as they are)."* The flagged words keep a little weight so the eye finds them
 *   in the sentence, and they carry no highlight ink: two surfaces painting the
 *   same marker pen makes the panel look like a second copy of the page instead
 *   of an index into it.
 *
 * ── THE TWO-WAY SYNC, AND WHOSE MANNERS PROBLEM IT IS ───────────────────────
 *
 * *"As i scroll/click highlighted text, it should jump to that spot in the
 * analysis."* Two halves. The paper owns the measuring, because the DOM being
 * measured is the paper's (`release` and `followAnalysis`,
 * book-view.component.ts); it writes two signals and holds no opinion about them.
 * This panel owns the OBEYING, because when to follow is a question about the
 * list a hand is on:
 *
 *   * A CLICK IS ALWAYS OBEYED and always brings its card into view. It is a
 *     deliberate act, and a deliberate act that sometimes did nothing would be
 *     the worst of the three behaviours available.
 *   * AND THE FINDING STAYS SELECTED, PULSING ON BOTH SIDES, until the reader
 *     says otherwise. Owen, after the first cut: *"when i click a highlighted
 *     block, the corresponding analysis block only blinks for about 1/4 of a
 *     second. can we make it pulse? on either side. have it pulse as long as it's
 *     selected. if i click the block, the text block pulses until i click
 *     somewhere else or scroll offscreen."* A blink announces and is gone; a
 *     pulse is a state, and a state is what this gesture needs, because the whole
 *     point of clicking a passage is to then look at the other end of the room.
 *     The selection lives in `AnalysisViewService.selected` — one nullable key,
 *     both surfaces drawing it — and it is let go of by a click that is not on it
 *     (either surface), by a click that selects another, or by its passage
 *     scrolling off the page (watched on the paper, which is the thing being
 *     scrolled).
 *   * A SCROLL IS OBEYED ONLY WHEN THE LIST IS NOT BEING READ. The pointer
 *     resting over this column pauses it outright, and scrolling the list by hand
 *     pauses it for `FOLLOW_REST_MS`. A list that scrolls itself out from under
 *     somebody's eyes is worse than one that lags: the lag costs a scroll they
 *     were going to make anyway, and the fight costs them their place.
 */
@Component({
  selector: 'app-analysis-panel',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './analysis-panel.component.html',
  styleUrl: './analysis-panel.component.scss',
})
export class AnalysisPanelComponent {
  protected readonly stage = inject(StageService);
  protected readonly analysis = inject(AnalysisViewService);
  private readonly stacks = inject(BookStacksService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly named = analysisCategoryName;


  /**
   * WHETHER THE HAND IS ON THIS COLUMN, and WHEN IT LAST WAS — the two facts the
   * auto-follow asks before it moves anything.
   *
   * THEY ARE FIELDS AND NOT SIGNALS, on the book view's own discipline and for
   * its reason: nothing draws either of them, the second changes many times a
   * second while a wheel is turning, and this app is zoneless — a signal would put
   * a change-detection pass behind every scroll frame of a list nobody is looking
   * at. The listeners below are native for the same reason (an Angular
   * \`(scroll)\` binding marks the view dirty whether or not anything changed).
   */
  private handOn = false;
  private touchedAt = 0;
  /**
   * Until when a scroll event on this list is THIS PANEL'S OWN and must not be
   * mistaken for the reader's.
   *
   * Without it the following would switch itself off on its first success: the
   * panel scrolls a card into view, the browser fires a scroll event, the listener
   * reads it as a hand and pauses for four seconds. The window covers a smooth
   * scroll's whole animation, which is the longest one of these takes.
   */
  private selfScrollUntil = 0;

  constructor() {
    afterNextRender(() => {
      const list = this.list();
      if (list === null) return;
      /*
       * PASSIVE, because neither of these ever calls `preventDefault` and saying
       * so lets the browser scroll without waiting to find out.
       */
      list.addEventListener('pointerenter', () => { this.handOn = true; }, { passive: true });
      list.addEventListener('pointerleave', () => { this.handOn = false; }, { passive: true });
      list.addEventListener('scroll', () => {
        if (Date.now() < this.selfScrollUntil) return;
        this.touchedAt = Date.now();
      }, { passive: true });
    });

    /*
     * ── A CLICK ON THE PAPER, OBEYED WITHOUT CONDITION ────────────────────────
     *
     * `pointedAt` carries a counter as well as a key so that clicking the same
     * passage twice is two different values and therefore two effects — the one
     * thing a person does when they think a click was missed is do it again.
     *
     * `untracked` around the work, because the scroll and the flash read and write
     * state this effect must not be re-run by.
     */
    effect(() => {
      const pointed = this.analysis.pointedAt();
      if (pointed === null) return;
      untracked(() => this.bring(pointed.key, 'smooth'));
    });

    /*
     * ── AND A SCROLL, OBEYED ONLY WHEN NOBODY IS READING THE LIST ─────────────
     *
     * The two pauses are different in kind and both are needed. THE POINTER
     * RESTING HERE is a hand on this column: it pauses outright and resumes the
     * moment the pointer leaves, because there is no ambiguity about what somebody
     * whose pointer is over a list is doing. HAVING SCROLLED THIS LIST is a hand
     * that has left: it pauses for `FOLLOW_REST_MS` and then gives the wheel back,
     * because a person who scrolled the panel and then went back to reading the
     * book wants the following again and is not going to ask for it.
     */
    effect(() => {
      const key = this.analysis.nearest();
      if (key === null) return;
      untracked(() => {
        if (this.handOn) return;
        if (Date.now() - this.touchedAt < FOLLOW_REST_MS) return;
        this.bring(key, 'auto');
      });
    });
  }

  /** The scrolling element, or null before the first render. */
  private list(): HTMLElement | null {
    const found = this.host.nativeElement.querySelector('.list');
    return found instanceof HTMLElement ? found : null;
  }

  /**
   * PUT A CARD IN VIEW — arithmetic on this list, and never `scrollIntoView`.
   *
   * `scrollIntoView` scrolls every scrollable ancestor that needs it, and this
   * column stands inside a shell whose layout is not this component's business.
   * Moving one element's `scrollTop` by a measured delta cannot reach past this
   * list, which is the whole reason for spelling it out.
   *
   * IT DOES NOTHING WHEN THE CARD IS ALREADY COMFORTABLY IN VIEW, which is what
   * makes the following feel like the list is pinned rather than twitching: most
   * scroll movements land on a card that is already on screen, and re-centring it
   * every time would be motion with no information in it.
   */
  private bring(key: string, how: ScrollBehavior): void {
    const list = this.list();
    if (list === null) return;
    const card = list.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!(card instanceof HTMLElement)) return;
    const box = list.getBoundingClientRect();
    const at = card.getBoundingClientRect();
    if (at.top >= box.top + EDGE && at.bottom <= box.bottom - EDGE) return;
    this.selfScrollUntil = Date.now() + SELF_SCROLL_MS;
    list.scrollTo({ top: list.scrollTop + (at.top - box.top) - EDGE, behavior: how });
  }

  /**
   * A CLICK IN THE LIST THAT IS NOT ON A CARD LETS GO OF THE SELECTION.
   *
   * Owen, 2026-08-25: *"have it pulse as long as it's selected… until i click
   * somewhere else."* This is where "somewhere else" is decided on THIS side; the
   * paper decides it on its own in `release` (book-view.component.ts).
   *
   * ONE LISTENER ON THE CONTAINER rather than a backdrop element, and the test is
   * `closest`: a click on a card bubbles here too, finds itself, and is left
   * alone — the card's own handler has already selected it. A click on the air
   * between cards, on the foot, or on the empty state finds nothing and clears.
   * The head and the legend are outside this element, so pressing a legend chip
   * is not "somewhere else": changing what is shown is not the same act as
   * looking away from a finding, and a filter that dropped the selection would
   * make the two controls fight.
   */
  protected clearOnBackdrop(event: Event): void {
    const under = event.target instanceof HTMLElement ? event.target.closest('.card') : null;
    if (under === null && this.analysis.selected() !== null) this.analysis.select(null);
  }

  /**
   * THE CARDS — the visible findings with everything the template draws already
   * decided.
   *
   * COMPOSED IN ONE COMPUTED rather than by calling helpers from the template,
   * which is this codebase's standing rule about template expressions (`linesOf`,
   * book-view.component.ts, says it at length): a method in a binding is
   * re-evaluated on every change-detection pass, so a list of a hundred findings
   * would re-derive a hundred colour strings and a hundred joined lists every time
   * a pointer moved anywhere in the window. This runs when the findings change,
   * which is when the answers can.
   *
   * The list is `analysis.hits()` verbatim and in its own order, which is the
   * BOOK'S order (`place`, core/analysis.ts). Nothing here re-sorts it: that is
   * the whole of Owen's *"in the order in which it appears"*.
   */
  protected readonly cards = computed(() => this.analysis.hits().map((found) => ({
    found,
    key: found.key,
    category: analysisCategoryName(found.category),
    ink: this.ink(found.category),
    washRest: this.wash(found.category, false),
    washDeep: this.wash(found.category, true),
    page: found.spans[0]?.page ?? 0,
    also: found.also.map((other, index) => ({
      name: analysisCategoryName(other),
      ink: this.ink(other),
      reason: found.alsoReasons[index] ?? '',
    })),
  })));

  /** The header's line: how many of how many, in words rather than a fraction. */
  protected readonly said = computed(() => {
    if (this.analysis.loading()) return 'Reading the report…';
    const shown = this.analysis.hits().length;
    const all = this.analysis.found().length;
    if (all === 0) return 'Nothing found';
    return shown === all
      ? `${all} ${all === 1 ? 'passage' : 'passages'}`
      : `${shown} of ${all} passages`;
  });

  /** The staleness caveat main composed, or null. See `AnalysisReading.stale`. */
  protected readonly stale = computed(() => this.analysis.reading()?.stale ?? null);

  /**
   * The untuned categories, said aloud — or null where every one was calibrated.
   *
   * NAMED AND NOT COUNTED, which is the report header's own rule (docs/ANALYSIS.md
   * §5): a reader deciding whether to trust a count needs to know WHICH ones are
   * first drafts. Only the ones this report actually ran against appear, because
   * the header lists what the plan held — and a category the user wrote themselves
   * is always among them, because nothing has calibrated a sentence somebody typed
   * this afternoon.
   */
  protected readonly untuned = computed<string | null>(() => {
    const said = (this.analysis.reading()?.untuned ?? []).map(analysisCategoryName);
    return said.length === 0 ? null : listed(said);
  });

  /** What an empty list says, which depends on why it is empty. */
  protected readonly empty = computed(() => {
    if (this.analysis.loading()) return 'Reading the report…';
    if (this.analysis.reading() === null) return '';
    if (this.analysis.found().length === 0) {
      return 'This analysis found nothing in the book at this position.';
    }
    return 'Every category is switched off. Turn one back on above.';
  });

  /**
   * The colour a category is known by on THIS surface.
   *
   * The hue is the category's own (`analysisCategoryHue`, shared) and the rest of
   * it is decided here, once, because it is a decision about a charcoal ground and
   * not about the category: 55% saturation and 62% lightness is the band that
   * stays legible as a 7px dot and as a 3px rail against `--bg-sunken` without any
   * of the twelve turning into a warning light. THE PAPER NEVER CALLS THIS — its
   * one \`--ink-hit\` is mixed for cream and stays exactly as it is.
   */
  protected ink(category: string): string {
    return `hsl(${analysisCategoryHue(category)} 55% 62%)`;
  }

  /**
   * The two ends of a selected card's breath — dark, OPAQUE tones of the
   * category's own hue, computed here and not mixed in CSS.
   *
   * They used to be `color-mix()` expressions in the keyframes, and the card
   * BLINKED: the engine would not interpolate between them and snapped at the
   * midpoint (Owen, 2026-08-26: *"the analysis block isnt pulsing, its
   * blinking"*). The paper's breath never blinked, and the difference was the
   * mechanism — a plain colour bound per element, one midpoint keyframe, the
   * underlying value as both ends. So the card now does exactly what the paper
   * does, and the two sides breathe on the same 1.9s clock with the same
   * easing, which is what makes one selection read as one thing seen from two
   * places.
   */
  protected wash(category: string, deep: boolean): string {
    return `hsl(${analysisCategoryHue(category)} ${deep ? 48 : 34}% ${deep ? 33 : 24}%)`;
  }

  /**
   * A CARD TRAVELS, AND NOTHING CLOSES.
   *
   * The sweep's card closes on the way because it is a modal standing over the
   * page; this is a column standing beside it, which is exactly why Owen asked for
   * the hits to live *"where compare would normally be"*. Click a card, the block
   * comes to the middle of the page and pulses, and the list is still there to
   * click the next one.
   *
   * THE FIRST SPAN, for a finding that crosses a paragraph break: a passage has
   * one place to be shown from and it is where it begins.
   *
   * AND IT SELECTS, which is the other direction of Owen's *"pulse… on either
   * side"*: the card pulses here and the passage's lit runs pulse on the paper,
   * whichever end the click came from. The selection is set BEFORE the travel so
   * that the runs are already wearing the class when `reveal` brings them into
   * view, rather than lighting up a frame after they arrive.
   */
  protected travel(hit: AnalysisHit): void {
    const span = hit.spans[0];
    if (span === undefined) return;
    this.analysis.select(hit.key);
    this.stacks.bookStackFor(this.stage.active())?.reveal(span.id);
  }
}

/** "a", "a and b", "a, b and c" — the app's way of saying a short list aloud. */
function listed(said: readonly string[]): string {
  if (said.length === 0) return '';
  if (said.length === 1) return said[0]!;
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]!}`;
}

/**
 * How long the panel leaves the wheel alone after somebody scrolls it themselves.
 *
 * FOUR SECONDS, and the number is an argument about two failures rather than a
 * measurement. Too short and the list snaps back while the hand is still moving
 * between one card and the next; too long and a person who glanced at the panel
 * and went back to the book finds the following dead for a page and a half. Four
 * seconds is long enough to read two cards and short enough that returning to the
 * paper resumes before the next paragraph is finished.
 */
const FOLLOW_REST_MS = 4000;

/**
 * How long a scroll event may still be this panel's own after it scrolled itself.
 *
 * Long enough for a smooth scroll's animation to finish, which is the longest one
 * of these takes; short enough that a real scroll a moment later is read as one.
 */
const SELF_SCROLL_MS = 600;

/** How much air a card gets above the fold when the list is scrolled to it. */
const EDGE = 10;

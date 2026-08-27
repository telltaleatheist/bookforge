import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { AnalysisReading } from '@shared/types';
import type { ReplayedRow } from '@shared/ops';

import { BookStacksService } from './book-stacks.service';
import { StageService } from './stage.service';
import { api } from './foundry';
import {
  legendOf,
  litRanges,
  onlyCategories,
  place,
  tiered,
  type AnalysisHit,
  type AnalysisLegendEntry,
  type AnalysisTier,
  type LitRange,
} from './analysis';

/**
 * THE ANALYSIS BEING LOOKED AT — the report, the tier, and the one placement both
 * surfaces draw from.
 *
 * ── Why this is a service and not state on the panel ────────────────────────
 *
 * Because the report reaches TWO surfaces and they must never disagree. The panel
 * lists the findings in the second column; the paper lights the same passages
 * inside the same blocks (docs/ANALYSIS.md §8). If the panel held the report and
 * the book view asked for it separately, the two would be two reads of one file
 * mapped by two calls to `place()` against two reads of the rows — and the first
 * symptom of a drift would be a highlighted paragraph with no row beside it.
 *
 * So there is ONE load, ONE placement and ONE tier, here, and both surfaces read
 * computeds off them. `core/analysis.ts` is the arithmetic; this is the sitting.
 *
 * ── The tier is session state and is deliberately not persisted ─────────────
 *
 * *"The tier is session display state, not persisted, not a param of the step —
 * the report is the same file under every button."* (docs/ANALYSIS.md §8.) It
 * opens on MODERATE, which is briefcase's calibrated default and therefore the
 * set a plain run of that pipeline would have produced: the honest middle, from
 * which Strict is one click narrower and Loose one click wider.
 *
 * ── WHAT DRIVES THE LOAD IS THE STAGE, WHICH IS WHAT KEEPS IT HONEST ────────
 *
 * `StageService.analysis()` is a computed with the three clearing rules already in
 * it — the document closed, the project changed, the step deleted — so a panel
 * pointed at a row that has gone answers null there and the report is dropped
 * here without anybody writing a rule to drop it. Nothing in this file decides
 * when an analysis stops being open.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisViewService {
  private readonly stage = inject(StageService);
  /**
   * The registry, read for ONE question: what does the book on screen say NOW?
   *
   * The rows a report is laid over are the viewer's own replayed rows, not the
   * file's — the recorded chain and the pending stack already in them — because
   * what the panel must agree with is the paper in front of the person, including
   * the strike they made a moment ago. `BookStack.view()` is a signal read, so
   * the placement below repaints with the book.
   */
  private readonly stacks = inject(BookStacksService);

  /** Which of the three buttons is pressed. See the class docblock. */
  readonly tier = signal<AnalysisTier>('moderate');

  /**
   * THE CATEGORIES SWITCHED OFF IN THE LEGEND — hidden, never "the shown ones".
   *
   * Session state beside the tier and for the tier's own reason: the report is
   * the same file whatever is switched off, and a filter remembered across
   * closings would be a report that opens missing findings nobody can see are
   * missing. It is cleared when the panel moves to another analysis (below),
   * because a category name switched off in one report may not exist in the next.
   *
   * WHY THE HIDDEN AND NOT THE SHOWN is argued at `onlyCategories`
   * (core/analysis.ts): an empty set has to mean "everything", which is what makes
   * a report growing an unfamiliar category show it rather than hide it.
   */
  readonly hidden = signal<ReadonlySet<string>>(NO_CATEGORIES);

  /**
   * THE FINDING THAT IS SELECTED — one at a time, or none.
   *
   * ── It is STATE, and it was a blink, and the difference is Owen's ─────────
   *
   * The first cut of the two-way sync flashed a card for a beat when its passage
   * was clicked. Owen, watching it: *"when i click a highlighted block, the
   * corresponding analysis block only blinks for about 1/4 of a second. can we
   * make it pulse? on either side. have it pulse as long as it's selected. if i
   * click the block, the text block pulses until i click somewhere else or scroll
   * offscreen."* A blink is an ANNOUNCEMENT — it says "over here" and is gone; a
   * pulse is a STATE — it says "this one, still, while you look at the other
   * side". The second is what a two-surface instrument actually needs, because
   * the whole point of the gesture is to look away from the thing you clicked.
   *
   * SO IT LIVES HERE, in the one place both surfaces already read from, and both
   * of them draw it: the card pulses in the panel and the passage's lit runs
   * pulse on the paper, whichever end the click came from. A selection held by
   * either component would be a selection the other had to be told about.
   *
   * IT IS CLEARED BY THREE THINGS and each is a person saying they are done with
   * it: a click that is not on this finding (either surface), a click that
   * selects a different one, and the passage scrolling off the page — Owen's own
   * third condition, watched by the book view because the paper is the thing
   * being scrolled.
   */
  readonly selected = signal<string | null>(null);

  /**
   * THE FINDING THE PAPER WAS JUST CLICKED ON — a deliberate act, stamped.
   *
   * Owen, 2026-08-25: *"as i scroll/click highlighted text, it should jump to
   * that spot in the analysis."* This is the CLICK half, and it is SEPARATE from
   * `selected` above even though one gesture writes both. `selected` is a state
   * and answers "which one is lit"; this is an EVENT and answers "scroll the
   * panel to it now". Clicking the same passage a second time does not change the
   * state and must still bring the panel back to it — which a signal holding a
   * bare key cannot say, because writing the same value is no change at all.
   */
  readonly pointedAt = signal<{ key: string; at: number } | null>(null);

  /** The counter behind `pointedAt`. Never read; it exists to be different. */
  private clicks = 0;

  /**
   * Select a finding, and ask the panel to bring it into view — the click, from
   * either surface. `null` deselects and asks for nothing.
   */
  select(key: string | null): void {
    this.selected.set(key);
    if (key === null) return;
    this.clicks += 1;
    this.pointedAt.set({ key, at: this.clicks });
  }

  /** The selected finding itself, or null — for the surfaces that need its spans. */
  readonly selectedHit = computed<AnalysisHit | null>(() => {
    const key = this.selected();
    if (key === null) return null;
    return this.hits().find((one) => one.key === key) ?? null;
  });

  /**
   * THE FINDING NEAREST THE TOP OF THE PAGE — the SCROLL half of the same wish.
   *
   * Written by the book view's scroll listener, and only when the answer CHANGES
   * (`followAnalysis`, book-view.component.ts): this app is zoneless and an
   * unconditional write per scroll frame would put a change-detection pass behind
   * every frame of every drag of a four-hundred-page book.
   *
   * The panel decides whether to obey it. Following is the panel's own manners
   * problem — a list that scrolls itself under a hand reading it is worse than one
   * that lags — so the rule about when to follow lives there and this is only the
   * fact.
   */
  readonly nearest = signal<string | null>(null);

  /**
   * THE REPORT AS MAIN READ IT, together with the step it is about.
   *
   * THE STEP RIDES WITH IT for `CompareColumnComponent.target`'s reason and it is
   * the same hazard: a person clicking down a list of analysis rows issues several
   * of these, main answers them in whatever order the disk feels like, and an
   * answer about the row they have just left must not be drawn under the name of
   * the row they are on. Identity against the standing wish is the whole test.
   */
  private readonly loaded = signal<{ stepId: string; reading: AnalysisReading } | null>(null);

  /** The sentence main gave instead of a report, or null. Cleared by every load. */
  readonly problem = signal<string | null>(null);

  /** True while a report is in flight — the panel's quiet, not a spinner. */
  readonly loading = signal(false);

  /**
   * The report for the analysis that is actually open, or null.
   *
   * VALIDATED AGAINST THE STAGE ON READ rather than cleared on write, which is
   * `StageService.active`'s own pattern: the moment the second column stops being
   * this analysis, this answers null, and nothing had to remember to say so.
   */
  readonly reading = computed<AnalysisReading | null>(() => {
    const open = this.stage.analysis();
    const held = this.loaded();
    if (open === null || held === null || held.stepId !== open.stepId) return null;
    return held.reading;
  });

  /** The rows the report is laid over — the paper's own, or none. */
  private readonly rows = computed<readonly ReplayedRow[]>(() => {
    if (this.stage.analysis() === null) return NO_ROWS;
    const stack = this.stacks.bookStackFor(this.stage.active());
    return stack?.view()?.rows ?? NO_ROWS;
  });

  /**
   * THE REPORT, LAID OVER THE BOOK — one placement, for both surfaces.
   *
   * Every finding the book can still put somewhere, in reading order, plus one
   * sentence per finding it cannot (`place`, core/analysis.ts). The panel draws
   * both halves: the list, and the sentences at its foot.
   */
  private readonly placement = computed(() => {
    const reading = this.reading();
    if (reading === null) return EMPTY;
    return place(this.rows(), reading.findings);
  });

  /** Every finding this book can place, before the tier — for the panel's counts. */
  readonly found = computed<readonly AnalysisHit[]>(() => this.placement().hits);

  /** The findings this book has nowhere to put, as sentences. Never a refusal. */
  readonly unplaced = computed<readonly string[]>(() => this.placement().unplaced);

  /**
   * What the tier lets through, BEFORE the legend's switches — what the legend
   * counts, and nothing else reads.
   *
   * It is a step of its own so that a category switched off keeps its own count
   * beside its switch. See `legendOf`.
   */
  private readonly atTier = computed<readonly AnalysisHit[]>(
    () => tiered(this.placement().hits, this.tier()),
  );

  /** The categories present at this tier, counted — the legend's rows. */
  readonly legend = computed<readonly AnalysisLegendEntry[]>(() => legendOf(this.atTier()));

  /** What the tier AND the legend let through — the cards, and the light on the paper. */
  readonly hits = computed<readonly AnalysisHit[]>(
    () => onlyCategories(this.atTier(), this.hidden()),
  );

  /** Switch one category's cards — and its highlights — off, or back on. */
  toggleCategory(category: string): void {
    this.hidden.update((held) => {
      const next = new Set(held);
      if (!next.delete(category)) next.add(category);
      return next;
    });
  }

  /**
   * WHICH CHARACTERS THE PAPER LIGHTS, by block — read by the book view and by
   * nothing else.
   *
   * IT IS NON-EMPTY ONLY WHILE THE PANEL IS OPEN, which is a ruling rather than an
   * implementation detail: *"Highlights draw only when the analysis panel is open.
   * The paper is a workbench; a report is an apparatus a reader summons, not a
   * permanent recolouring of the book."* (docs/ANALYSIS.md §8.) It falls out of
   * `reading` being validated against the stage — close the panel and the chain
   * answers empty from the top.
   */
  readonly lit = computed<ReadonlyMap<string, readonly LitRange[]>>(() => litRanges(this.hits()));

  constructor() {
    /*
     * ASK MAIN FOR THE REPORT, AND ASK AGAIN WHEN THE ROW CHANGES.
     *
     * `CompareColumnComponent`'s effect, verbatim in shape and for its reasons.
     * The wish is a computed that can go null underneath this — the step deleted,
     * the book on screen changed — and when it does the workspace stops drawing
     * the panel entirely, so there is nothing to tear down; what this owes is the
     * other direction, a panel that MOVED from one analysis to another while it
     * stayed up, which is what happens when somebody picks a second row without
     * closing it.
     */
    effect(() => {
      const open = this.stage.analysis();
      untracked(() => {
        if (open === null) {
          this.loaded.set(null);
          this.problem.set(null);
          this.loading.set(false);
          this.forget();
          return;
        }
        if (this.loaded()?.stepId === open.stepId) return;
        // Cleared first: the old report is about the row they have just left, and
        // drawing it under the new row's name for one frame would be the panel
        // lying about which analysis it is showing.
        this.loaded.set(null);
        this.problem.set(null);
        // AND SO IS EVERYTHING KEYED TO THE OLD REPORT. A hidden category may not
        // exist in the next one, and a hit key certainly does not — `${id}#${start}`
        // is a passage of a report, and pointing the new panel at one of the old
        // one's would scroll to a card that is not there.
        this.forget();
        void this.load(open.projectDir, open.stepId);
      });
    });
  }

  /** Everything that was true of the report we are leaving, dropped together. */
  private forget(): void {
    this.hidden.set(NO_CATEGORIES);
    this.selected.set(null);
    this.pointedAt.set(null);
    this.nearest.set(null);
  }

  private async load(projectDir: string, stepId: string): Promise<void> {
    if (!api) return;
    this.loading.set(true);
    try {
      const answer = await api.workspace.readAnalysis(projectDir, stepId);
      // The panel may have moved (or closed) while main was answering. `analysis`
      // holds the newest wish, so identity against it is the whole test.
      if (this.stage.analysis()?.stepId !== stepId) return;
      if (!answer.ok) {
        this.problem.set(answer.reason);
        return;
      }
      this.loaded.set({ stepId, reading: answer.reading });
    } catch (err) {
      if (this.stage.analysis()?.stepId !== stepId) return;
      /*
       * THE ONLY THING THAT REJECTS IS THE DIRECTORY GATE, which cannot fire for a
       * project this window has open — every other refusal comes back as a
       * sentence inside the answer. It is caught anyway and said in words, because
       * a panel that drew nothing and explained nothing is the one outcome worse
       * than a wrong sentence.
       */
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.stage.analysis()?.stepId === stepId) this.loading.set(false);
    }
  }
}

const NO_ROWS: readonly ReplayedRow[] = [];
const EMPTY = { hits: [] as readonly AnalysisHit[], unplaced: [] as readonly string[] };
/** Nothing switched off, which is how every report opens. */
const NO_CATEGORIES: ReadonlySet<string> = new Set<string>();

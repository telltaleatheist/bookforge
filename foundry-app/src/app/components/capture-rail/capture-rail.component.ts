import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { CapturePrepared } from '@shared/types';

import type { PrepareCounts } from '../../core/capture.service';

/** The three verbs, which are also the three keys of `CapturePrepared`. */
export type PrepareVerb = keyof CapturePrepared;

/** What a task row draws. Composed here so the template stays a list. */
interface Task {
  verb: PrepareVerb;
  glyph: string;
  words: string;
  /** The derivation, or null where there is nothing honest to derive. */
  state: string | null;
  ticked: boolean;
}

/**
 * PREPARE THIS BOOK — the light table's right-hand rail, and the answer to the
 * evening that produced it.
 *
 * ── Why a rail at all ───────────────────────────────────────────────────────
 *
 * Owen minted before he had turned the pages, and said so: *"i minted but didnt
 * have an opportunity to rotate the pages"*. Nothing had gone wrong with the
 * data — a mint is a snapshot of the recipe rather than its funeral — but the
 * surface had offered the LAST ACT FIRST. Mint sat in the footer of the table
 * from the moment the photographs landed, and the three things you are supposed
 * to do before it lived inside a modal you had to know to open.
 *
 * So the three verbs come out of the modal and stand in a list, in any order,
 * with the act at the bottom of them. The rail is the whole of the fix; the
 * gate below is what stops it being advice.
 *
 * ── THE TICK IS THE PERSON SPEAKING, AND THE STATUS IS NOT ─────────────────
 *
 * Each row carries a live status read from the recipe and a tick the person
 * sets, and they are different kinds of thing on purpose: THE DERIVATION NEVER
 * CLEARS A TICK. Nothing here decides that a step is finished.
 *
 * That is not deference for its own sake. A shoot with no spreads must be
 * tickable on "split spreads" without lying, and no rule can know the pages are
 * turned right — one photograph in the acceptance shoot is a magazine
 * advertisement, portrait, the same shape as the volume, and a derived
 * turned-done would be confidently wrong exactly where wrongness is most
 * expensive.
 *
 * TURN PAGES CARRIES NO STATUS AT ALL, which is a ruling and not an omission. A
 * count of turns performed IS derivable and was withdrawn: a count needs a
 * denominator and a denominator asserts a target. The correct final state of
 * this shoot is twenty-five spreads turned and at least two photographs left
 * alone, so "25 of 27 turned" would read as two still to do and quietly ask him
 * to break two pages that are already right. A progress count without a true
 * denominator is a lie with a number in it.
 */
@Component({
  selector: 'app-capture-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="rail">
      <header class="head">
        <h3>Prepare this book</h3>
        <p>Any order. Tick a step when the book looks right.</p>
      </header>

      <div class="tasks">
        @for (task of tasks(); track task.verb) {
          <!--
            ONE ROW, TWO CONTROLS, and the tick is not a checkbox beside a
            button: pressing the row OPENS the editor on that tool, and pressing
            the tick SAYS SO. A single control would have to guess which of the
            two a click meant, and the guess would be wrong on whichever one the
            person did not want.
          -->
          <div class="task" [class.ticked]="task.ticked">
            <button class="go" type="button" (click)="open.emit(task.verb)">
              <span class="glyph">{{ task.glyph }}</span>
              <span class="words">
                <span class="verb">{{ task.words }}</span>
                @if (task.state !== null) {
                  <span class="state">{{ task.state }}</span>
                }
              </span>
            </button>
            <button
              class="mark"
              type="button"
              role="checkbox"
              [attr.aria-checked]="task.ticked"
              [title]="task.ticked
                ? 'You said this is done — press to take it back'
                : 'Say this step is done'"
              (click)="tick.emit(task.verb)"
            ><span class="dot">{{ task.ticked ? '✓' : '' }}</span></button>
          </div>
        }
      </div>

      <footer class="foot">
        <!--
          THE DIVERGENCE SENTENCE, said once, about the difference, and only
          while there is one.

          Every count on this surface acquired a second referent the moment a
          mint existed -- what a mint WOULD produce, and what the book on the
          shelf actually holds -- which is the two-things-one-name defect
          arriving through a feature rather than through a variable. The rail
          goes on speaking about the recipe, which is the truth and the thing
          being edited, and this one line carries the difference.
        -->
        @if (diverged()) {
          <p class="moved">The book on the shelf was made from an earlier arrangement.</p>
        }

        @if (progress(); as running) {
          <p class="why">Making page {{ running.done }} of {{ running.total }}…</p>
          <button class="stop" type="button" (click)="stop.emit()">Stop</button>
        } @else {
          <!--
            THE COUNT LIVES ON THIS LINE AND NOT INSIDE THE BUTTON. It moves as
            pages are struck and as spreads are split, and a button whose own
            name reflows under the pointer is hard to aim at.
          -->
          <p class="why">
            @if (ready()) {
              {{ pages() }}
            } @else {
              Finishing unlocks when every step is ticked.
            }
          </p>
          <button
            class="mint"
            type="button"
            [class.ready]="ready() && mintable() > 0"
            [disabled]="!ready() || mintable() === 0"
            [title]="mintTitle()"
            (click)="mint.emit()"
          >{{ minted() ? 'Finish again' : 'Finish the pages' }}</button>
        }
      </footer>
    </aside>
  `,
  styles: [`
    :host { display: block; height: 100%; }

    .rail {
      height: 100%;
      width: 292px;
      box-sizing: border-box;
      border-left: 1px solid var(--border-subtle, #2a2824);
      background: var(--bg-elevated);
      display: flex; flex-direction: column;
      overflow: hidden;
    }

    .head { padding: 18px 18px 6px; }
    .head h3 {
      margin: 0;
      font-family: var(--font-display); font-size: 13px; font-weight: 600;
      letter-spacing: -0.025em;
    }
    .head p { margin: 4px 0 0; color: var(--text-tertiary); font-size: 11.5px; }

    .tasks {
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
      overflow: auto;
    }

    .task {
      display: flex; align-items: stretch; gap: 0;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius, 8px);
      overflow: hidden;
    }
    .task:hover { border-color: var(--border-strong); }

    /* The row's own press, which opens the editor. It is the whole width the
       tick does not take, so there is no dead ground between them. */
    .go {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 12px;
      padding: 12px 0 12px 14px;
      background: none; border: none; color: inherit; font: inherit;
      text-align: left; cursor: pointer;
    }
    .go:hover { background: var(--bg-hover); }

    .glyph {
      flex: 0 0 30px; height: 30px;
      display: grid; place-items: center;
      border-radius: var(--radius-md, 6px);
      background: var(--bg-base);
      border: 1px solid var(--border-subtle, #2a2824);
      color: var(--text-secondary);
      font-size: 15px;
    }
    .task.ticked .glyph { color: var(--ok, #4ade80); border-color: var(--ok, #4ade80); }

    .words { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .verb { font-size: 12.5px; font-weight: 600; }
    .state {
      margin-top: 1px;
      color: var(--text-tertiary); font-size: 11px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* The tick, which is a control and not a picture: it has to be pressable to
       be taken back, since the derivation never clears one. */
    .mark {
      flex: 0 0 44px;
      display: grid; place-items: center;
      background: none; border: none;
      color: var(--ok, #4ade80); font-size: 13px; cursor: pointer;
    }
    .dot {
      width: 20px; height: 20px; border-radius: 99px;
      border: 1.5px solid var(--border-strong);
      display: grid; place-items: center;
      line-height: 1;
    }
    .task.ticked .dot {
      background: var(--ok-soft, rgba(74, 222, 128, 0.12));
      border-color: var(--ok, #4ade80);
    }
    .mark:hover .dot { border-color: var(--ok, #4ade80); }

    .foot {
      margin-top: auto;
      padding: 16px 18px 18px;
      border-top: 1px solid var(--border-subtle, #2a2824);
    }
    .why { margin: 0 0 10px; color: var(--text-tertiary); font-size: 11.5px; }

    /* Quieter than the gate's own line and warmer than the body text: it is not
       a warning -- nothing is wrong, and the older book is still openable from
       its step -- it is the one fact this surface cannot show you. */
    .moved {
      margin: 0 0 10px;
      color: var(--warn);
      font-size: 11.5px;
      line-height: 1.35;
    }

    .mint, .stop {
      width: 100%;
      padding: 11px 0;
      border-radius: var(--radius, 8px);
      font: inherit; font-weight: 600;
      cursor: pointer;
      background: var(--bg-input);
      color: var(--text-tertiary);
      border: 1px solid var(--border-default);
    }
    .mint.ready {
      background: var(--accent);
      color: var(--text-inverse);
      border-color: var(--accent);
    }
    .mint:disabled { cursor: not-allowed; }
    .stop { color: var(--text-primary); }
    .stop:hover { background: var(--bg-hover); }
  `],
})
export class CaptureRailComponent {
  readonly counts = input.required<PrepareCounts>();
  readonly prepared = input.required<CapturePrepared>();
  /** Pages a mint would produce — struck ones already left out. */
  readonly mintable = input.required<number>();
  /** Every verb ticked. The service owns the rule; this only draws it. */
  readonly ready = input.required<boolean>();
  /** True once this project has a minted book, which changes one word. */
  readonly minted = input(false);
  readonly progress = input<{ done: number; total: number } | null>(null);
  /** The shelf's book was made from an older arrangement than the one on screen. */
  readonly diverged = input(false);

  readonly open = output<PrepareVerb>();
  readonly tick = output<PrepareVerb>();
  readonly mint = output<void>();
  readonly stop = output<void>();

  protected readonly tasks = computed<readonly Task[]>(() => {
    const counts = this.counts();
    const prepared = this.prepared();
    return [
      {
        verb: 'turned',
        glyph: '↻',
        words: 'Turn pages',
        // Nothing derived, and the class docblock carries the whole reason.
        state: null,
        ticked: prepared.turned === true,
      },
      {
        verb: 'cropped',
        glyph: '⌗',
        words: 'Place the crop',
        state: cropState(counts),
        ticked: prepared.cropped === true,
      },
      {
        verb: 'split',
        glyph: '∥',
        words: 'Split spreads',
        state: splitState(counts),
        ticked: prepared.split === true,
      },
    ];
  });

  protected readonly pages = computed<string>(() => {
    const pages = this.mintable();
    return pages === 1 ? '1 page' : `${pages} pages`;
  });

  /**
   * WHAT THE LAST ACT PROMISES, IN THE PERSON'S OWN WORDS.
   *
   * Owen described the act he was looking for as "a finalize button that does
   * all the final splits/crops" -- and it was already here, called Mint,
   * offering to "Make the PDF from these pages". Two things were wrong with
   * that and neither was the button.
   *
   * MINT IS THE SYSTEM'S WORD. It is a good word inside the code, where a mint
   * is a specific event with a fingerprint and a step, and it is the wrong word
   * on a control: nobody arrives at a light table looking for a mint. The
   * vocabulary of an interface is signposting, so it uses the vocabulary of the
   * person reading it.
   *
   * AND "MAKE THE PDF" NAMED THE CONTAINER RATHER THAN THE WORK. Under Owen's
   * pages-not-PDF ruling (docs/CAPTURE.md) the product of this act is the
   * PAGES; a PDF is something somebody exports afterwards, on purpose. A button
   * that promised a PDF was promising the one part of this that was about to
   * stop being true.
   */
  protected readonly mintTitle = computed<string>(() => {
    if (this.mintable() === 0) return 'There are no pages to make yet';
    if (!this.ready()) return 'Tick all three steps first';
    return this.minted()
      ? 'Make these pages again, as a new book beside the last one'
      : 'Cut, crop and turn every page as you have marked them';
  });
}

/**
 * "25 cropped · 3 by hand", and the counts behind it are about SHEETS.
 *
 * A split photograph has no half that is the whole frame and a turned one fails
 * an exact frame test, so both would read as cropped under the obvious version
 * of this question — see `CaptureService.prepare`, which is where that is
 * handled and where it has to stay.
 */
function cropState(counts: PrepareCounts): string {
  if (counts.photos === 0) return 'no photographs yet';
  if (counts.cropped === 0) return 'nothing cropped yet';
  const cropped = `${counts.cropped} of ${counts.photos} cropped`;
  return counts.byHand === 0 ? cropped : `${cropped} · ${counts.byHand} by hand`;
}

/**
 * "12 split into 24 pages".
 *
 * The page count is worth saying beside the photograph count because they are
 * the two numbers a spread changes, and the second is the one the mint uses.
 */
function splitState(counts: PrepareCounts): string {
  if (counts.photos === 0) return 'no photographs yet';
  if (counts.split === 0) return 'nothing split yet';
  const photographs = counts.split === 1 ? '1 spread' : `${counts.split} spreads`;
  return `${photographs} split into ${counts.pagesFromSplits} pages`;
}

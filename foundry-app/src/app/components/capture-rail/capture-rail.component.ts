import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { CapturePrepared } from '@shared/types';

import type { PrepareCounts, StampCost } from '../../core/capture.service';

/** The three verbs, which are also the three keys of `CapturePrepared`. */
export type PrepareVerb = keyof CapturePrepared;

/**
 * WHICH POPULATION A PRESSED COUNT ASKS FOR.
 *
 * The same three the Apply's consequence line names, because they are the same
 * three photographs: a number on this rail and the cards it lights have to be
 * one answer or the count is a claim nobody can check.
 */
export type Population = 'follow' | 'complete' | 'shape';

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
 * So the three verbs come out of the modal and stand in a list, with the act at
 * the bottom of them. The rail is the whole of the fix; the gate below is what
 * stops it being advice.
 *
 * ── AND SINCE WAVE 25 THE LIST IS AN ORDER, NOT A SET ──────────────────────
 *
 * *"maybe my goal should be to crop the pages so theyre positioned right, then
 * it moves to the page splitting after cropping is done. if cropping is done,
 * page splits will almost certainly be lined up already."*
 *
 * The rail draws the sequence — Crop, Split, Finish — because that IS the
 * insight: once the crops are applied every page is a squared, registered
 * rectangle, so one gutter placed once falls in nearly the same fractional
 * place on all of them. The well-aligned shoot needs no ceremony BY
 * CONSTRUCTION rather than by a mode switch, and each pass has one kind of
 * handle on its stage, which answers the scope question before it is asked.
 *
 * The row that used to say "any order" says "crop first", and that is the whole
 * change of instruction.
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
 *
 * ── THREE TICKS ON TWO STEPS, AND WHICH FOLDS WHERE ────────────────────────
 *
 * `CapturePrepared` still has exactly three keys and Finish still gates on all
 * three; what changed is where they are drawn. Turn and Crop fold under the
 * Crop step, on the contract's own ruling — *"turn belongs to the crop pass;
 * orienting the shot is part of deciding its rectangle"* — and Split stands
 * under the Split step alone.
 *
 * They are NOT derived from the passes and the passes do not tick them. An
 * Apply is the book moving; a tick is a person saying they have looked, and
 * Wave 21c's whole argument for the tick was that a derivation cannot know
 * that. So a person may apply the crops without ticking Crop, and Finish will
 * still be locked, and that is the gate doing its job rather than a defect.
 *
 * ── THE FINALIZE CARRIES THE CONSEQUENCE, AND IT IS NOW A REPORT ───────────
 *
 * Wave 24 put the sentence under *Crop all* in the modal, because that press
 * both recorded the book's crop and copied it onto twenty-four other pictures.
 * Wave 25 split those in two: the modal RECORDED and the table APPLIED, per the
 * rule that a control on the rail speaks for the book. Wave 51 removed the
 * record and made the propagation LIVE — a gesture made with *Global* ticked
 * reaches every follower as the hand opens — so the button below is a
 * commitment point plus a safety net, and the sentence above it describes a
 * state the book is already in rather than one a press is about to produce.
 *
 * The counts stay the service's `applyCost` — one walk, shared by the sentence
 * and the act, so they cannot disagree.
 *
 * ── AND THE COUNTS ARE PRESSABLE, WHICH CLOSES WAVE 24's DEFERRAL ──────────
 *
 * Wave 24 shipped the mark and said out loud what it had not shipped: *"the
 * rail's 'N by hand' count is not clickable … the mark is built and is the half
 * that matters, but finding them from the rail's number still means scanning."*
 * Pressing a count selects exactly those cards and scrolls to the first. It is
 * a number that can prove itself.
 */
@Component({
  selector: 'app-capture-rail',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="rail">
      <header class="head">
        <h3>Prepare this book</h3>
        <p>Crop first — square pages make one cut land right everywhere.</p>
      </header>

      <div class="steps">
        <!--
          ══ STEP 1 · CROP ═════════════════════════════════════════════════
          The pass a project starts in and the one \`Reopen\` returns it to.
        -->
        <section class="step" [class.now]="pass() === 'crop'" [class.done]="pass() === 'split'">
          <div class="line">
            <span class="no">{{ pass() === 'split' ? '✓' : '1' }}</span>
            <span class="words">
              <span class="verb">Crop</span>
              <span class="state">{{ cropStep() }}</span>
            </span>
            @if (pass() === 'split') {
              <!--
                REOPEN COSTS NOTHING AND DESTROYS NOTHING, which is the property
                that makes Apply safe to press in the first place: no pixels
                were cut — that happens once, at Finish — so every line every
                photograph holds is exactly where it was. Reopening is not a
                rollback. It is the corners being offered again.
              -->
              <button
                class="ghost"
                type="button"
                title="Back to the corners. Nothing is undone and nothing is lost."
                (click)="reopen.emit()"
              >Reopen</button>
            }
          </div>

          <div class="under">
            @for (task of cropTasks(); track task.verb) {
              <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: task }" />
            }

            @if (pass() === 'crop') {
              @if (standing()) {
                <p class="cost">{{ cropCost() }}</p>
                <ng-container [ngTemplateOutlet]="populations" />
                <!--
                  FINALIZE, NOT APPLY, SINCE WAVE 26 — and the word had to move
                  with the meaning. The crops already landed: every follower took
                  the book's crop at the moment the gesture that set it was let
                  go of. What this press does is close the pass, and run the same
                  walk once more so that anything that arrived late lands too.
                  "Apply" named a propagation that is no longer waiting to happen.
                -->
                <button class="apply" type="button" (click)="applyCrops.emit()">Finalize page crops</button>
              } @else {
                <!--
                  NO BUTTON, because there is no book's crop for it to land and
                  a press would only be able to refuse. The stage's own rule,
                  from the split button and then from Wave 24's whole control
                  table: a control that would change nothing is not shown. What
                  IS shown is the way forward, which a greyed button would not
                  have been.
                -->
                <p class="cost">Open a page that sits well and place its crop with <em>Global</em> ticked — every other page takes it as you go.</p>
              }
            } @else {
              <p class="cost">Nothing was thrown away. Reopening shows every corner exactly as you left it.</p>
            }
          </div>
        </section>

        <!--
          ══ STEP 2 · SPLIT ════════════════════════════════════════════════
          Inert until the crops land, and it says why rather than going grey in
          silence: the reason it waits is the reason the sequence exists.
        -->
        <section class="step" [class.now]="pass() === 'split'" [class.waiting]="pass() === 'crop'">
          <div class="line">
            <span class="no">2</span>
            <span class="words">
              <span class="verb">Split</span>
              <span class="state">{{ splitStep() }}</span>
            </span>
          </div>

          @if (pass() === 'split') {
            <div class="under">
              @for (task of splitTasks(); track task.verb) {
                <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: task }" />
              }
              @if (bookCut()) {
                <p class="cost">{{ cutCost() }}</p>
                <ng-container [ngTemplateOutlet]="populations" />
                <!--
                  REPEATABLE, and repeating it costs nothing: the cut is always
                  made against the SHEET, so a second press moves the gutter
                  rather than quartering the page. Like its sibling above it is
                  the safety net rather than the propagation — a line slid with
                  <em>Global</em> ticked has already reached every follower.
                -->
                <button class="apply" type="button" (click)="applyCuts.emit()">Finalize page splits</button>
              } @else {
                <!-- Absent for the same reason as above: with no book's cut this
                     press could only say no. -->
                <p class="cost">Open a spread and put the line down the gutter with <em>Global</em> ticked — the rest follow it as you go.</p>
              }
            </div>
          }
        </section>
      </div>

      <!--
        ══ STEP 3 · FINISH ═══════════════════════════════════════════════════
        At the foot, where the act has been since Wave 21b, and numbered like
        the other two because it is the end of the same sequence rather than a
        different kind of thing sitting underneath it.
      -->
      <footer class="foot" [class.now]="mintable() > 0">
        <div class="line">
          <span class="no">3</span>
          <span class="words">
            <span class="verb">Generate</span>
            <span class="state">Cuts the pixels once and makes the pages</span>
          </span>
        </div>

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
          <!--
            THE GATE IS GONE — Owen (2026-08-22): \`"sometimes i wont need to
            do any of the three. if thats the case i should be able to click
            finish/finalize anyway."\` The ticks above stay as the record
            (auto-set by the work itself, still yours to set by hand); the
            only thing that disables Finish now is having nothing to finish.
          -->
          <p class="why">{{ pages() }}</p>
          <button
            class="mint"
            type="button"
            [class.ready]="mintable() > 0"
            [disabled]="mintable() === 0"
            [title]="mintTitle()"
            (click)="mint.emit()"
          >{{ minted() ? 'Generate book again' : 'Generate book' }}</button>
        }

        <!--
          PERSISTENCE, SAID ONCE, WHERE THE DOUBT ACTUALLY LIVES.

          Owen: *"i need a way to finalize the action … when i change something
          on one page, it stays that way. if i leave and come back, it's set to
          that."* It already was — every drag has written to the recipe at the
          moment it was made since the stage was built. What was missing was any
          surface saying so, which is why it FELT unset, and a thing a person
          cannot tell is true is a thing that is not true for them.

          At the foot rather than at the head, because this is the sentence that
          answers "can I stop now?" and the foot is where somebody stands when
          they are deciding whether to. Once, and not per control: a promise
          repeated on every row reads as a system protesting.
        -->
        <p class="kept">Everything above is kept the moment you do it — leaving and coming back changes nothing.</p>
      </footer>
    </aside>

    <!--
      ONE ROW, TWO CONTROLS, and the tick is not a checkbox beside a button:
      pressing the row OPENS the editor on that tool, and pressing the tick SAYS
      SO. A single control would have to guess which of the two a click meant,
      and the guess would be wrong on whichever one the person did not want.

      A template rather than a repeated block because the rows are now spread
      across two steps, and a row drawn twice in two places is a row that grows
      a difference nobody meant.
    -->
    <ng-template #row let-task>
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
    </ng-template>

    <!--
      THE POPULATIONS, AND EACH OF THEM IS A PRESS.

      The same three the consequence line above has just named, from the same
      count, offered as a way to LOOK at them. This is Wave 24's deferral
      discharged: a number that says how many and nothing about which is a
      number you have to take on trust, and this table has fifty cards on it.

      Drawn once and outlet twice, because the crop pass and the split pass name
      the same three photographs -- one Apply cost serves both, since a crop and
      a cut are fractions of the same frame and skip on the same test.

      A population of nobody is not drawn: pressing it would select nothing,
      which is a control that does nothing wearing a number.
    -->
    <ng-template #populations>
      <div class="who">
        @if (cost().takes > 0) {
          <button
            class="pop follow"
            type="button"
            title="Show me the ones the book still moves"
            (click)="select.emit('follow')"
          ><span class="pip"></span>{{ cost().takes }} follow</button>
        }
        @if (cost().complete > 0) {
          <button
            class="pop done"
            type="button"
            title="Show me the ones the book leaves alone"
            (click)="select.emit('complete')"
          ><span class="pip"></span>{{ cost().complete }} complete</button>
        }
        @if (cost().shape > 0) {
          <button
            class="pop odd"
            type="button"
            title="Show me the ones this leaves out"
            (click)="select.emit('shape')"
          ><span class="pip"></span>{{ cost().shape }} a different shape</button>
        }
      </div>
    </ng-template>
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

    .steps {
      padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
      overflow: auto;
    }

    /*
      A STEP IS A CARD AND THE PASS IS ITS BORDER. The sequence has to be legible
      at a glance -- where you are, what is behind you, what is still ahead --
      and three states on one element is the smallest way to say it: the live
      step is accented, the finished one is quiet and ticked, and the one still
      waiting is dimmed. Nothing here is a mode; it is a report on which pass the
      recipe is in.
    */
    .step {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius, 8px);
      overflow: hidden;
    }
    .step.now { border-color: var(--accent); }
    .step.waiting { opacity: 0.62; }

    .line {
      display: flex; align-items: center; gap: 11px;
      padding: 11px 12px;
    }
    .no {
      flex: 0 0 22px; height: 22px;
      border-radius: 99px;
      display: grid; place-items: center;
      background: var(--bg-base);
      border: 1px solid var(--border-strong);
      color: var(--text-tertiary);
      font-size: 11.5px; font-weight: 600;
      line-height: 1;
    }
    .step.now .no, .foot.now .no {
      background: var(--accent-faint);
      border-color: var(--accent);
      color: var(--accent);
    }
    .step.done .no {
      background: var(--ok-soft, rgba(74, 222, 128, 0.12));
      border-color: var(--ok, #4ade80);
      color: var(--ok, #4ade80);
    }

    .words { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .verb { font-size: 12.5px; font-weight: 600; }
    .state {
      margin-top: 1px;
      color: var(--text-tertiary); font-size: 11px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /*
      A STEP'S OWN LINE WRAPS; A TASK ROW'S DOES NOT.
      The ellipsis is right on a task row, where the text is a derived count and
      the row has to stay one height whatever the shoot does. It is wrong on a
      step, where the text is a SENTENCE and the step already shares its line
      with Reopen -- measured on the walk, "Applied — the table shows the
      cropped pages" was cut to "Applied — the table show…", which is a
      sentence a person has to guess the end of.
    */
    .step > .line .state, .foot .line .state { white-space: normal; overflow: visible; }

    .under {
      padding: 0 12px 11px;
      display: flex; flex-direction: column; gap: 8px;
    }

    /* Quiet, bordered, and never the accent: it is the way BACK, and a way back
       that competed with the way forward would be inviting the undo. */
    .ghost {
      flex: 0 0 auto;
      padding: 4px 10px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-tertiary);
      font: inherit; font-size: 11.5px;
      cursor: pointer;
    }
    .ghost:hover { background: var(--bg-hover); color: var(--text-primary); }

    /*
      THE CONSEQUENCE LINE. Not decoration: it is the whole of how a person knows
      what a global act will cost before pressing it, so it sits ABOVE the button
      rather than under it -- read, then press.
    */
    .cost {
      margin: 0;
      color: var(--text-tertiary);
      font-size: 11px;
      line-height: 1.4;
    }

    .who { display: flex; flex-wrap: wrap; gap: 6px; }
    /* Pressable, and it has to LOOK pressable: a number that selects cards and
       is drawn as text is a feature nobody finds twice. */
    .pop {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px;
      border: 1px solid var(--border-default);
      border-radius: 99px;
      background: transparent;
      color: var(--text-tertiary);
      font: inherit; font-size: 11px;
      cursor: pointer;
    }
    .pop:hover { background: var(--bg-hover); color: var(--text-primary); }
    .pip { width: 7px; height: 7px; border-radius: 99px; }
    /* The follower's pip is hollow and the complete one is filled, matching the
       card exactly: an empty corner is a photograph the book still moves. */
    .pop.follow .pip { border: 1.5px solid var(--accent); }
    .pop.done .pip { background: var(--ok, #4ade80); }
    .pop.odd .pip { background: var(--text-tertiary); }

    .apply {
      align-self: flex-start;
      padding: 6px 13px;
      border: 1px solid var(--accent);
      border-radius: var(--radius-md, 6px);
      background: var(--accent-faint);
      color: var(--accent);
      font: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer;
    }
    .apply:hover { background: var(--accent-soft); }

    .task {
      display: flex; align-items: stretch; gap: 0;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle, #2a2824);
      border-radius: var(--radius-md, 6px);
      overflow: hidden;
    }
    .task:hover { border-color: var(--border-strong); }

    /* The row's own press, which opens the editor. It is the whole width the
       tick does not take, so there is no dead ground between them. */
    .go {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 10px;
      padding: 9px 0 9px 11px;
      background: none; border: none; color: inherit; font: inherit;
      text-align: left; cursor: pointer;
    }
    .go:hover { background: var(--bg-hover); }

    .glyph {
      flex: 0 0 26px; height: 26px;
      display: grid; place-items: center;
      border-radius: var(--radius-md, 6px);
      background: var(--bg-input);
      border: 1px solid var(--border-subtle, #2a2824);
      color: var(--text-secondary);
      font-size: 14px;
    }
    .task.ticked .glyph { color: var(--ok, #4ade80); border-color: var(--ok, #4ade80); }
    .task .verb { font-size: 12px; font-weight: 500; }

    /* The tick, which is a control and not a picture: it has to be pressable to
       be taken back, since the derivation never clears one. */
    .mark {
      flex: 0 0 40px;
      display: grid; place-items: center;
      background: none; border: none;
      color: var(--ok, #4ade80); font-size: 13px; cursor: pointer;
    }
    .dot {
      width: 18px; height: 18px; border-radius: 99px;
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
      padding: 6px 18px 18px;
      border-top: 1px solid var(--border-subtle, #2a2824);
    }
    .foot .line { padding: 12px 0 10px; }
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

    /* Under the act, small, and stated as a fact rather than as reassurance. */
    .kept {
      margin: 10px 0 0;
      color: var(--text-tertiary);
      font-size: 11px;
      line-height: 1.4;
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
  /** True once this project has a minted book, which changes one word. */
  readonly minted = input(false);
  readonly progress = input<{ done: number; total: number } | null>(null);
  /** The shelf's book was made from an older arrangement than the one on screen. */
  readonly diverged = input(false);

  /**
   * WHICH PASS THE BOOK IS IN — the service's word, drawn and never decided.
   *
   * There is no 'crop' on disk; absent IS the crop pass, and `Reopen` returns
   * the recipe to it. The rail asks the service rather than remembering,
   * because the pass is a fact about the project and this component is redrawn
   * against whatever project the tab is pointing at.
   */
  readonly pass = input.required<'crop' | 'split'>();

  /** Whether the book has a crop yet — what decides if there is an act at all. */
  readonly standing = input(false);
  /** Whether the book has a cut yet — the same question for the split pass. */
  readonly bookCut = input(false);

  /**
   * THE BOOK'S LINES ARE SPLIT BY SIDE — odd pages one way, even pages another.
   *
   * It changes the WORDS and never the numbers. "22 take the book's crop and
   * cut" is a sentence about one crop and one cut; once the two sides have their
   * own, those twenty-two are taking two different rectangles and perhaps only
   * half of them a cut, so the sentence names the sides instead of promising a
   * single answer it no longer has. The counts beside it stay exact either way —
   * they are resolved per photograph in the service, against the standing that
   * photograph would actually be given.
   */
  readonly sided = input(false);

  /**
   * WHAT AN APPLY WOULD COST — the service's three populations, unaltered.
   *
   * Never recomputed here, and that is the rule the consequence line lives or
   * dies by: the sentence under the button and the walk the stamp makes are ONE
   * count, so a person who reads "22 take the book's crop" and then watches
   * twenty-two cards move has been told the truth by construction rather than
   * by two pieces of arithmetic that happen to agree today.
   */
  readonly cost = input.required<StampCost>();

  readonly open = output<PrepareVerb>();
  readonly tick = output<PrepareVerb>();
  readonly mint = output<void>();
  readonly stop = output<void>();
  /**
   * FINALIZE PAGE CROPS — close the pass, and land the standing on any straggler.
   *
   * The names on the wire are still `applyCrops`/`applyCuts` because the service
   * doors are, and the doors are where the rename would have to start; the
   * BUTTONS say Finalize, which is what a person is doing. Said here rather than
   * quietly left, so the next reader knows the two words are one act.
   */
  readonly applyCrops = output<void>();
  /** The same act, for the cut. */
  readonly applyCuts = output<void>();
  /** Back to the corners. Costs nothing, destroys nothing. */
  readonly reopen = output<void>();
  /** Light these cards on the table — a count proving itself. */
  readonly select = output<Population>();

  /** Turn and Crop, which are both about deciding the rectangle. */
  protected readonly cropTasks = computed<readonly Task[]>(() => {
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
    ];
  });

  /** Split, alone, under the pass it belongs to. */
  protected readonly splitTasks = computed<readonly Task[]>(() => {
    const counts = this.counts();
    return [{
      verb: 'split' as const,
      glyph: '∥',
      words: 'Split spreads',
      state: splitState(counts),
      ticked: this.prepared().split === true,
    }];
  });

  /** What the Crop step says about itself, which depends on where the book is. */
  protected readonly cropStep = computed<string>(() =>
    (this.pass() === 'split'
      ? 'Applied — the table shows the cropped pages'
      : 'Square every page against the book’s crop'));

  /**
   * And the Split step.
   *
   * In the crop pass it says WHY it is waiting rather than simply going dim,
   * because the reason is the whole argument for the order: a registered page
   * puts the gutter in the same fractional place on all of them, so one line
   * placed once fits the book.
   *
   * IN THE SPLIT PASS IT DOES NOT REPEAT THE COUNT. It did in the first build
   * and the walk caught it: the step's line and the *Split spreads* row
   * underneath it both read "25 spreads split into 50 pages", eight millimetres
   * apart. The derived count belongs to the task row, where the tick beside it
   * is the thing it is evidence for; the step line says what the pass is FOR.
   */
  protected readonly splitStep = computed<string>(() =>
    (this.pass() === 'crop'
      ? 'After the crops — one line then fits them all'
      : 'Put one line down the gutter and let the book take it'));

  /**
   * THE CONSEQUENCE LINE FOR *APPLY CROPS* — every population it touches.
   *
   * Three short sentences at most and each earns its place: who TAKES it, which
   * is the act's own number; who is SPARED for being complete, which is Owen's
   * standing ruling made visible and which, left unsaid, would read as a
   * failure to move; and who is spared for being a different SHAPE, which the
   * notice bar reports afterwards and which is worth knowing before.
   *
   * THE CUT IS NAMED WHENEVER THERE IS ONE, which is Wave 24's ruling holding:
   * a standing carries a crop AND a cut, so a button labelled Crop can cut
   * twenty-two photographs in two, and one button plus an honest sentence beat
   * a second button that appears and disappears.
   */
  protected readonly cropCost = computed<string>(() => {
    const { takes, complete, shape } = this.cost();
    const cut = this.bookCut();
    const said: string[] = [];
    /*
     * WHEN THE SIDES DIFFER, THE SENTENCE NAMES THE SIDES (Wave 51b).
     *
     * "and cut, two pages each" is a promise about ONE cut, and a book whose odd
     * pages are spreads and whose even ones are single sheets would have it told
     * about the wrong half. The count is still exact — the service resolves each
     * photograph against the standing it will actually be given — so what has to
     * change is the claim about what they are all taking, not the number taking
     * it.
     */
    if (takes === 0) said.push('Nothing is free to take the book’s crop.');
    else if (this.sided()) {
      said.push(takes === 1
        ? 'One takes the lines its side of the book is set to.'
        : `${takes} take the lines their side of the book is set to.`);
    } else if (takes === 1) {
      said.push(cut
        ? 'One takes the book’s crop and cut, in two pages.'
        : 'One takes the book’s crop.');
    } else {
      said.push(cut
        ? `${takes} take the book’s crop and cut, two pages each.`
        : `${takes} take the book’s crop.`);
    }
    said.push(...spared(complete, shape));
    return said.join(' ');
  });

  /** The same sentence for the cut, which lands on the crops already there. */
  protected readonly cutCost = computed<string>(() => {
    const { takes, complete, shape } = this.cost();
    const said: string[] = [];
    // In the split pass the count is of photographs whose side of the book has a
    // CUT to give them, so nobody in it is going to be left whole — which is
    // what lets the sentence keep saying "two pages each" beside a book whose
    // sides differ.
    if (takes === 0) said.push('Nothing is free to take the book’s cut.');
    else if (takes === 1) {
      said.push(this.sided()
        ? 'One is cut where its side of the book is cut, into two pages.'
        : 'One is cut where the book is cut, into two pages.');
    } else {
      said.push(this.sided()
        ? `${takes} are cut where their side of the book is cut, two pages each.`
        : `${takes} are cut where the book is cut, two pages each.`);
    }
    said.push(...spared(complete, shape));
    // Every crop stays put, and it has to be said: the word "apply" has just
    // meant "take the book's corners" one step above this one.
    said.push('Every crop stays where it is.');
    return said.join(' ');
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
    return this.minted()
      ? 'Make this book again, as a new one beside the last'
      : 'Cut, crop and turn every page as you have marked them';
  });
}

/**
 * WHO IS LEFT ALONE, AND WHY — the two spared populations, in the Apply's own
 * words.
 *
 * One body for both passes, because both skip on the same two tests in the same
 * order (`applyCost` asks shape first, then complete). Two sentences written
 * twice would be two chances to describe one walk differently.
 */
function spared(complete: number, shape: number): string[] {
  const said: string[] = [];
  if (complete > 0) {
    said.push(complete === 1
      ? 'One is complete and keeps its own.'
      : `${complete} complete keep their own.`);
  }
  if (shape > 0) {
    said.push(shape === 1
      ? 'One is a different shape and is left out.'
      : `${shape} are a different shape and are left out.`);
  }
  return said;
}

/**
 * "25 cropped · 3 complete", and the counts behind it are about SHEETS.
 *
 * A split photograph has no half that is the whole frame and a turned one fails
 * an exact frame test, so both would read as cropped under the obvious version
 * of this question — see `CaptureService.prepare`, which is where that is
 * handled and where it has to stay.
 *
 * THE SECOND NUMBER IS `complete` AND NOT `byHand`, which is the same change the
 * card's dot made: the rail and the table have to count one population, or a
 * person who presses the count and reads the dots is looking at two answers to
 * one question.
 */
function cropState(counts: PrepareCounts): string {
  if (counts.photos === 0) return 'no photographs yet';
  if (counts.cropped === 0) return 'nothing cropped yet';
  const cropped = `${counts.cropped} of ${counts.photos} cropped`;
  return counts.complete === 0 ? cropped : `${cropped} · ${counts.complete} complete`;
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

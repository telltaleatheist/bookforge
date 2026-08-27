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

import { analysisCategoryHue, analysisCategoryName } from '@shared/analysis-categories';

import { AnalysisViewService } from '../../core/analysis-view.service';
import { BookStacksService } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import type { AnalysisHit, AnalysisTier } from '../../core/analysis';

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
 *   named instead of counted, and the verifier's rejection is a sentence under
 *   the quotation instead of a two-word chip with the sentence hidden behind it.
 *   The three that remain each say something the surface does not — what a tier
 *   means, and that the score is not a severity.
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
  template: `
    <!--
      THE COLUMN NAMES ITSELF, exactly as the compare column does and for its
      reason: a second view with no label is two things side by side and no way to
      tell which is which.
    -->
    <header class="head">
      <span class="tag">Analysis</span>
      <span class="counts">{{ said() }}</span>
      <button
        type="button"
        class="x"
        title="Close the analysis"
        aria-label="Close the analysis"
        (click)="stage.stopAnalysis()"
      >✕</button>
    </header>

    <!--
      THE STRICTNESS, AS THREE BUTTONS AND NOT A SLIDER. They are named rather
      than numbered because the numbers are measured constants a person has no
      way to reason about (0.9 and 0.7 came out of briefcase's calibration), and
      what somebody actually wants to say is "only the certain ones" or "show me
      everything". The counts under each are what make the choice legible.

      THE TOOLTIP HERE SURVIVED THE CULL because it does not repeat the button:
      the button says "Strict" and the sentence says what strict MEANS, which is
      the one fact this control cannot fit on itself.
    -->
    <div class="tiers" role="group" aria-label="How strict to be">
      @for (one of tiers; track one.tier) {
        <button
          type="button"
          class="tier"
          [class.on]="analysis.tier() === one.tier"
          [title]="one.why"
          (click)="analysis.tier.set(one.tier)"
        >
          <span class="tier-name">{{ one.name }}</span>
          <span class="tier-count">{{ countFor(one.tier) }}</span>
        </button>
      }
    </div>

    <!--
      THE LEGEND, WHICH IS ALSO THE FILTER — what the category headings used to
      carry, made into switches.

      This is the clause docs/ANALYSIS.md §8 promised and the first cut deferred
      out loud (*"a panel filter lights one category at a time when asked"*).
      Pressing a row switches that category's cards off AND its highlights on the
      paper, because they are one list: \`hits\` is what the panel draws and what
      \`litRanges\` paints, so a filter can only ever move both.

      THE COUNT DOES NOT MOVE WHEN A ROW IS SWITCHED OFF (\`legendOf\` counts
      before the filter). A number that went to zero the moment you pressed it
      would erase the label telling you what pressing it again would bring back.
    -->
    @if (analysis.legend().length > 1 || analysis.hidden().size > 0) {
      <div class="legend" role="group" aria-label="Which categories to show">
        @for (row of analysis.legend(); track row.category) {
          <button
            type="button"
            class="key"
            [class.off]="analysis.hidden().has(row.category)"
            [attr.aria-pressed]="!analysis.hidden().has(row.category)"
            (click)="analysis.toggleCategory(row.category)"
          >
            <span class="dot" [style.background]="ink(row.category)"></span>
            <span class="key-name">{{ named(row.category) }}</span>
            <span class="key-count">{{ row.count }}</span>
          </button>
        }
      </div>
    }

    @if (analysis.problem(); as reason) {
      <p class="problem">{{ reason }}</p>
    }
    @if (stale(); as caveat) {
      <p class="problem">{{ caveat }}</p>
    }

    <div class="list" (click)="clearOnBackdrop($event)">
      @for (card of cards(); track card.key) {
        <!--
          THE WHOLE CARD IS THE BUTTON. The chip that used to be the only target
          named a block id nobody needed and was a chip-sized target inside a
          paragraph-sized row; the card is the thing a person is looking at, so
          the card is the thing that travels. Everything inside it is a \`span\`
          rather than a \`p\` — a button may only hold phrasing content, and the
          block layout is the stylesheet's.
        -->
        <button
          type="button"
          class="card"
          [class.ghost]="card.found.struck"
          [class.rejected]="card.found.verdict === 'skip'"
          [class.on]="analysis.selected() === card.key"
          [style.--card-ink]="card.ink"
          [style.--card-rest]="card.washRest"
          [style.--card-deep]="card.washDeep"
          [attr.data-key]="card.key"
          (click)="travel(card.found)"
        >
          <span class="rail" [style.background]="card.ink"></span>
          <span class="top">
            <span class="cat" [style.color]="card.ink">{{ card.category }}</span>
            @if (card.page > 0) {
              <span class="at">≈ {{ card.page }}</span>
            }
            <!--
              THE SCORE KEEPS ITS ONE SENTENCE. It is the only thing on the card
              that can be READ AS A SEVERITY, and docs/ANALYSIS.md §1 rules that
              there is no severity — the passage IS the finding. A number with no
              explanation beside it invites exactly the misreading the design
              spent a section refusing.
            -->
            <span class="score" [title]="scoreWhy">{{ card.score }}</span>
          </span>
          <span class="quote">
            <span class="q-side">{{ card.found.quote.before }}</span><span
              class="q-hit"
            >{{ card.found.quote.hit }}</span><span
              class="q-side"
            >{{ card.found.quote.after }}</span>
          </span>
          <!--
            THE OTHER CATEGORIES, NAMED RATHER THAN COUNTED. It was "+2" with the
            names on a tooltip; the names are two short words and the tooltip was
            a door in front of them.
          -->
          @if (card.also.length > 0) {
            <span class="also">also {{ card.also }}</span>
          }
          <!--
            THE VERIFIER'S REJECTION, AS THE SENTENCE IT ALWAYS WAS.
            docs/ANALYSIS.md §8: the loosest tier shows the skips *"ghosted and
            labelled as the verifier's rejection (reported speech, quotation,
            argument against)"*. It was a two-word chip with that sentence hidden
            on a tooltip; on a card there is room to simply say it.
          -->
          @if (card.found.verdict === 'skip') {
            <span class="threw-back">
              Not the author asserting this — reported, quoted, or argued against.
            </span>
          }
        </button>
      } @empty {
        <p class="none">{{ empty() }}</p>
      }

      <!--
        THE FOOT: what this book could not place, and which categories were never
        calibrated. Sentences rather than a refusal (\`BookLoad.unplaced\`'s own
        precedent) and at the END rather than the top, because they are caveats
        about a list somebody is reading and not reasons not to read it.
      -->
      @if (analysis.unplaced().length > 0) {
        <div class="foot">
          <p class="foot-lede">
            {{ analysis.unplaced().length }} passage(s) could not be placed on this book:
          </p>
          <ul>
            @for (said of analysis.unplaced(); track $index) {
              <li>{{ said }}</li>
            }
          </ul>
        </div>
      }
      @if (untuned(); as names) {
        <div class="foot">
          <p class="foot-lede">
            Nothing has calibrated {{ names }}, so the counts for those are a first draft — they
            may turn up too much or too little.
          </p>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      background: var(--bg-sunken);
    }

    /*
      A QUIET BAR, NOT A TAB STRIP — the compare column's head, to the pixel,
      because the two occupy one slot and a person switching between them should
      not feel the furniture change.
    */
    .head {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px 6px 10px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
    }
    .tag {
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--accent);
    }
    .counts {
      flex: 1; min-width: 0;
      font-size: 11.5px; color: var(--text-secondary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* ALWAYS VISIBLE, on the compare column's own rule: this is the only way out
       of a mode, and a way out that has to be discovered by hovering is a mode
       people feel stuck in. */
    .x {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* ── The three buttons ──────────────────────────────────────────────────── */
    .tiers {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      padding: 8px 10px 6px;
    }
    .tier {
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      padding: 5px 4px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-secondary);
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .tier:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .tier.on {
      background: var(--accent-faint);
      border-color: var(--accent-strong);
      color: var(--accent);
    }
    .tier-name { font-size: 11px; line-height: 1.2; }
    .tier-count { font-size: 10px; font-variant-numeric: tabular-nums; opacity: 0.75; }

    /*
      ── The legend, which is the filter ──────────────────────────────────────

      CHIPS THAT WRAP rather than a column of rows: a report names three or four
      categories in the ordinary case and twelve at the outside, and twelve rows
      would push the first card off the screen. The dot is the colour, the name is
      the identity, the count is the size — and the whole chip is the switch.
    */
    .legend {
      flex: 0 0 auto;
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 2px 10px 8px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .key {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 2px 7px 2px 5px;
      border-radius: 999px;
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-secondary);
      font-size: 10.5px; line-height: 1.5;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  opacity 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .key:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    /*
      SWITCHED OFF IS FADED AND STILL READABLE, which is the shown-but-inert
      register this app uses everywhere for a thing that is present and not
      counting (a struck row, a rejected verdict). A chip that vanished would take
      its own count and its own way back with it.
    */
    .key.off { opacity: 0.4; }
    .key.off .key-name { text-decoration: line-through; }
    .dot {
      flex: 0 0 auto;
      width: 7px; height: 7px; border-radius: 50%;
    }
    .key-name { max-width: 128px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .key-count {
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    .problem {
      margin: 0; padding: 8px 10px;
      font-size: 11.5px; line-height: 1.5; color: var(--warn);
      border-bottom: 1px solid var(--border-subtle);
    }

    /* ── The findings, one card each ────────────────────────────────────────── */
    .list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 14px; }
    .none {
      margin: 0; padding: 28px 16px;
      text-align: center;
      font-size: 12px; color: var(--text-tertiary);
    }

    /*
      THE CARD. A rail in the category's colour down the left edge — the block
      chrome's own idiom, one surface over — then the category, the page and the
      score on one line, then the quotation as the body. It reads in that order
      because that is the order somebody scans it: what kind of thing, where, then
      what it says.
    */
    .card {
      position: relative;
      display: block;
      width: 100%;
      text-align: left;
      margin: 0 0 5px;
      padding: 7px 9px 7px 13px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      background: var(--bg-elevated);
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    /*
      A SUBTLE RAISE, because a card that is a button has to say so. It is 1px and
      a border, not a shadow and a scale: the list is scanned by running an eye
      down it, and a card that leapt under the pointer would be the "rows that
      grow under the hand" fault Owen ruled against on the sweep (2026-08-24)
      arriving in a different costume.
    */
    .card:hover {
      background: var(--bg-hover);
      border-color: var(--border-strong);
      transform: translateY(-1px);
    }
    .card:active { transform: translateY(0); }

    .rail {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      border-radius: var(--radius-md) 0 0 var(--radius-md);
    }

    /* A struck block's findings are listed and are inert: seeing that a passage
       the analysis found is one you already cancelled is half of trusting it. */
    .card.ghost { opacity: 0.45; }
    /* And a verdict the verifier REJECTED is shown-but-inert in the same way —
       the treatment a struck row gets, for the reason docs/ANALYSIS.md §8 gives:
       it is the net's contents, honestly labelled, not a finding. */
    .card.rejected { background: var(--bg-sunken); }
    .card.rejected .q-hit { color: var(--text-secondary); font-weight: 400; }

    /*
      ── THE SELECTED CARD, PULSING ──────────────────────────────────────────

      It was a 700ms flash. Owen, watching it: *"when i click a highlighted block,
      the corresponding analysis block only blinks for about 1/4 of a second. can
      we make it pulse? on either side. have it pulse as long as it's selected."*
      A blink announces and is gone; a pulse is a STATE, which is what this
      gesture actually needs — the whole point of clicking a passage on the page
      is to then look over here, by which time a flash has finished.

      1.9 SECONDS, matching the paper's breath exactly. The two marks are one
      selection seen from two sides, and two pulses at different rates would read
      as two different things happening.
    */
    /*
      THE CARD BREATHES IN ITS OWN CATEGORY'S SHADE — the accent ring went the
      way the paper's ring went, and on the same word (Owen, 2026-08-25: *"its
      just blinking an ugly outline. can we make it actually pulse darker and
      lighter for that particular shade?"*). The card's hue rides in as
      \`--card-ink\` (the rail's own colour), and the breath is a wash of it
      mixed into the card's ground — darker and lighter of the one shade, never
      a second colour fighting the rail two pixels away. The border takes the
      ink too, steadily: the moving part is the wash, the standing part says
      which card is selected even mid-breath.
    */
    /*
      THE PAPER'S OWN MECHANISM, COPIED EXACTLY, because the paper's breath works
      and this one's did not. The first cut mixed the two ends in the keyframes
      (\`color-mix\` over \`var()\`), and the engine refused to interpolate
      between them — the card snapped instead of breathing (Owen, 2026-08-26:
      *"the analysis block isnt pulsing, its blinking. can you make it pulse in
      sync with the highlight on the page"*). The paper never blinked, and the
      difference was mechanism, not taste: a plain colour bound per element,
      the resting value as the underlying style, ONE midpoint keyframe. So:
      \`--card-rest\` is the selected card's standing background, the keyframe
      names only \`--card-deep\`, and the browser draws the breath between them.

      IN SYNC WITH THE PAGE BY CONSTRUCTION: same 1900ms, same easing curve
      (the literal below IS book-view's \`--ease\` — that token lives on the
      paper's host and cannot be read from here, so the number is copied and
      this sentence is the tether), and both sides' \`.on\` flip on the same
      signal in the same change-detection pass, so the two animations start on
      the same frame and never drift.
    */
    .card.on {
      border-color: color-mix(in srgb, var(--card-ink) 55%, var(--border-strong));
      background: var(--card-rest);
      animation: card-breathe 1900ms cubic-bezier(0.2, 0.7, 0.3, 1) infinite;
    }
    @keyframes card-breathe {
      50% { background-color: var(--card-deep); }
    }
    /*
      AND IT HOLDS STILL WHERE MOTION IS UNWELCOME, at the breath's own midpoint.
      The book view's glide sets the precedent: reduced motion means the movement
      is skipped, not that the destination is refused — so the emphasis stays and
      only the breathing stops.
    */
    @media (prefers-reduced-motion: reduce) {
      .card.on {
        animation: none;
        background: var(--card-deep);
      }
    }

    .top {
      display: flex; align-items: baseline; gap: 6px;
      margin-bottom: 3px;
    }
    /*
      THE CATEGORY IN ITS OWN COLOUR, quietly. The rail carries the identity at a
      glance; this carries it in words, and giving the words the same hue is what
      ties the two together without a third mark.
    */
    .cat {
      flex: 1; min-width: 0;
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /*
      THE PAGE, WITH THE SHEET'S OWN ≈. It is an ESTIMATE and not an address
      (\`BookRow.page\`), which is why it wears the tilde the page ghosts in the
      book's gutter wear. It is NOT a block id: a page is where a person would
      look in the physical book, which is the one coordinate a reader has any use
      for.
    */
    .at {
      flex: 0 0 auto;
      font-size: 9.5px; color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }
    .score {
      flex: 0 0 auto;
      font-family: var(--font-mono); font-size: 9.5px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    /*
      THE PASSAGE AS PLAIN PROSE — Owen's ruling: *"they shouldnt be highlighted
      inside the analysis, they should be highlighted inside the document viewer
      (as they are)."* The flagged words are a shade brighter and a little heavier
      so the eye finds them inside the sentence; there is NO marker-pen background
      here, and there is not going to be. Two surfaces painting one highlight makes
      the panel look like a second copy of the page rather than an index into it.
    */
    .quote {
      display: block;
      font-size: 12px; line-height: 1.55;
      color: var(--text-tertiary);
      white-space: normal;
    }
    .q-side { color: var(--text-tertiary); }
    .q-hit { color: var(--text-primary); font-weight: 500; }

    .also {
      display: block;
      margin-top: 4px;
      font-size: 9.5px; color: var(--text-tertiary);
    }
    .threw-back {
      display: block;
      margin-top: 4px;
      font-size: 9.5px; line-height: 1.45; color: var(--warn);
    }

    /* ── The caveats, at the foot ───────────────────────────────────────────── */
    .foot {
      padding: 10px 4px 0;
      font-size: 11px; line-height: 1.5;
      color: var(--text-tertiary);
    }
    .foot-lede { margin: 0 0 4px; }
    .foot ul { margin: 0; padding-left: 1.1rem; }
    .foot li { margin: 0 0 2px; }
  `],
})
export class AnalysisPanelComponent {
  protected readonly stage = inject(StageService);
  protected readonly analysis = inject(AnalysisViewService);
  private readonly stacks = inject(BookStacksService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The three buttons, with the sentence each one is owed on hover. */
  protected readonly tiers: readonly { tier: AnalysisTier; name: string; why: string }[] = [
    {
      tier: 'strict',
      name: 'Strict',
      why: 'Only what the verifier flagged, at the near-certain end — the few options.',
    },
    {
      tier: 'moderate',
      name: 'Moderate',
      why: 'What the verifier flagged, at the calibrated default — the ordinary answer.',
    },
    {
      tier: 'loose',
      name: 'Loose',
      why: 'Everything the net caught, including the passages the verifier threw back — '
        + 'shown greyed and labelled.',
    },
  ];

  protected readonly named = analysisCategoryName;

  /** The one sentence the score is owed. See the template. */
  protected readonly scoreWhy =
    'How strongly the passage matches this category\'s claim, as the ranker measured it. '
    + 'Not a severity: the passage is the finding.';


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
   * The head, the tiers and the legend are outside this element, so pressing a
   * tier button or a legend chip is not "somewhere else": changing what is shown
   * is not the same act as looking away from a finding, and a filter that dropped
   * the selection would make the two controls fight.
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
    score: found.score.toFixed(2),
    also: listed(found.also.map(analysisCategoryName)),
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
    if (this.analysis.hidden().size > 0 && this.analysis.legend().length > 0) {
      return 'Every category is switched off. Turn one back on above.';
    }
    return this.analysis.tier() === 'strict'
      ? 'Nothing is certain enough for Strict. Try Moderate.'
      : 'Nothing at this strictness. Try Loose to see everything the net caught.';
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

  /** How many findings a tier would show — the number under each button. */
  protected countFor(tier: AnalysisTier): number {
    const all = this.analysis.found();
    if (tier === 'loose') return all.length;
    const floor = tier === 'strict' ? 0.9 : 0.7;
    return all.filter((one) => one.verdict === 'flag' && one.score >= floor).length;
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

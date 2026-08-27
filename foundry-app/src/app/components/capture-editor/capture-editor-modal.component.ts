import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

import { isWholeFrameTurned, joinedQuad } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

// The scope's three words, from the service that owns the state — the same
// import the rail makes for `StampCost`, and for the same reason: a second
// spelling of a three-arm union is a fourth arm waiting to be added to one of
// them.
import type { CaptureScope } from '../../core/capture.service';
import { CapturePageEditorComponent } from './capture-page-editor.component';
import { type Dimensions, type FractionQuad } from './geometry';

/**
 * ONE PHOTOGRAPH IN THE FILMSTRIP along the modal's foot.
 *
 * A picture, a name, and the one thing that has to be visible from in here: is
 * the book still moving this one. Composed by the light table, because the
 * arrangement and the recipe are its, and handed over whole — this component
 * walks it and does not know how it was built.
 */
export interface EditorFrame {
  /** The PHOTOGRAPH's id, which is what the walk steps through. */
  readonly id: string;
  /** The 640 px thumbnail's URL, through the capture door. */
  readonly thumb: string;
  /** What to call it in a title: its name, or its place in the walk. */
  readonly label: string;
  /** The book has stopped moving this one — `isComplete`, the one test. */
  readonly complete: boolean;
}

/**
 * THE EDITOR AS A ROOM YOU STEP INTO: this photograph, then the book.
 *
 * ── Why a modal and not a pane ──────────────────────────────────────────────
 *
 * Wave 21 point 1, from Owen's own reading of PDFElement: the grid is where you
 * choose, and the editor is where you work. The editor used to REPLACE the grid
 * inside the same tab, so leaving it meant a button called "All photographs" and
 * coming back meant finding your card again. A modal keeps the table underneath,
 * which is the difference between going somewhere and opening something.
 *
 * ── THE SURFACE NAMES THE SCOPE, AND WAVE 26 NAMES IT ON THE PHOTOGRAPH ────
 *
 *     A control on a CARD speaks for that photograph.
 *     A control on the RAIL speaks for the book.
 *     The MODAL speaks for the photograph it has open —
 *     AND THE HAND SAYS WHETHER THE GESTURE SPEAKS FOR THE BOOK.
 *
 * Wave 24 named two levels and left the book's one holding a press that changed
 * twenty-four other pictures. Wave 25 made that press a RECORD and moved the
 * propagation to the rail, which was the right rule and the wrong sequence:
 * place a crop, press Record, walk out to the table, press Apply, walk back to
 * see whether it fitted. Owen (2026-08-26) collapsed it into one tick.
 *
 * *Global*, on by default and STICKY (Wave 51b — the last line of that sentence
 * used to read "and the PHOTOGRAPH says whether it speaks for the book"). While
 * it is ticked, a gesture made in here — corners, gutter, turn — is the book's
 * gesture: every photograph that is not its own takes it as the hand opens,
 * including the one under the hand if it had been taken for somebody's own. The
 * modal still speaks only for the photograph it has open; the gesture on that
 * photograph now has something to say about the book, which is not the same
 * thing as the modal reaching past it.
 *
 * Untick it and a gesture moves the page it is made on and marks it as its own.
 * Everything else keeps the lines it was last given, and no later global reaches
 * it — which is Owen's standing ruling (a hand-placed change is assumed correct)
 * with a control on the front of it. The box stays where it is put: it survives
 * every step through the walk, because the second half of an evening is one pass
 * through the book tweaking pages one at a time, and a box derived per
 * photograph had to be unticked before every single one of them.
 *
 * ── AND IT CAN SPEAK FOR ONE SIDE OF THE BOOK ──────────────────────────────
 *
 * *All pages / Odd / Even*, under the tick and only while it is on. The case is
 * recto/verso — a book shot one page at a time from a fixed stand puts the
 * left-hand pages in one part of the frame and the right-hand pages in another,
 * so one crop is wrong about half of them by construction. Parity is by
 * PHOTOGRAPH (the 1st, 3rd, 5th … in the arrangement), which for a spread means
 * both of its pages: see `CaptureStanding`.
 *
 * ── TWO PASSES, TWO CONTROL SETS, AND NO MODE TO BE IN ──────────────────────
 *
 * Crop everything, apply, then split the cropped pages. The pass is the book's
 * and arrives as an input, so nobody in here chooses it and nobody can be stood
 * in the wrong one. What it changes is which handles the stage has:
 *
 *   CROP PASS   the photograph, its corners, the turn pair, the tick
 *   SPLIT PASS  the rectified PAGE, no corners at all, the gutter alone
 *
 * Which is exactly why the scope switch that was drawn for this surface is not
 * built: what is grabbable answers the scope question before it is asked. The
 * turn belongs to the crop pass (contract, "Ruled inline") because orienting the
 * shot is part of deciding its rectangle; the tick survives both, because a
 * spread is a fact about the photograph in either pass.
 *
 * ── A CONTROL THAT WOULD CHANGE NOTHING IS NOT SHOWN ────────────────────────
 *
 * This stage's own precedent, from the split button: *"not a disabled button but
 * an ABSENT one"*. It is what lets every control be named after its outcome
 * instead of after the state it is in, and it is why a photograph that matches
 * the rest carries almost nothing — just the picture and its handles.
 *
 * ── THERE ARE NO ACTS LEFT IN THE COLUMN, AND THAT IS THE SHAPE ────────────
 *
 * The record, the record-and-apply, the bulk turn, the say-so and the two ways
 * back to the book all stood here and all of them are gone (Wave 51). What is
 * left is the picture with its handles, two ticks that say what a gesture MEANS,
 * and one destructive door with a confirm on it. A column of buttons is what a
 * surface grows when the gesture cannot say what it is for; the gesture can now.
 *
 * ── What it does NOT own ────────────────────────────────────────────────────
 *
 * The corners, the split line, the projection and the previews are all
 * `CapturePageEditorComponent`, still pointable at any image. What lives up here
 * are the SCOPE and the walk.
 */
@Component({
  selector: 'app-capture-editor-modal',
  imports: [CapturePageEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>

    <div class="card" role="dialog" aria-modal="true">
      <button class="shut" type="button" title="Back to the table (Escape)" (click)="close.emit()">✕</button>

      <div class="work">
        <div class="stage">
          <app-capture-page-editor
            [source]="source()"
            [dimensions]="dimensions()"
            [quads]="quads()"
            [split]="split()"
            [projecting]="splitting()"
            [ghost]="ghost()"
            (quadsChange)="quadsChange.emit($event)"
            (splitChange)="splitChange.emit($event)"
            (settled)="settled.emit()"
          />
          <!--
            THE WALK, AT THE HAND — Owen (2026-08-22), stepping a 179-page
            screenshot shoot: \`"maybe an arrow on the left and right side of
            each page so i can move between the pages quickly and easily."\`
            The cluster's Back/Next and the arrow keys both survive; these are
            the same act at the place the eye already is, the lightbox idiom.
            ABSENT at either end rather than disabled, this stage's own rule —
            and they sit at the stage's edges, outside the photograph's usual
            fit, so they cover no corner anybody is trying to grab.
          -->
          @if (hasPrevious()) {
            <button class="leaf back" type="button" title="Previous photograph (left arrow)" (click)="step.emit(-1)">‹</button>
          }
          @if (hasNext()) {
            <button class="leaf next" type="button" title="Next photograph (right arrow)" (click)="step.emit(1)">›</button>
          }
        </div>

        <!--
          ONE COLUMN, IN THE ORDER THE WORK HAPPENS, and it replaces a perimeter.

          Owen: "the buttons are all on the other side of the app from each other."
          They were: walking in the header, the tools in the header, the gestures
          in the footer's left corner and the acts in its right. Four groups on
          three edges of a window whose middle is a photograph.

          Now: who you are looking at and how to move, what this photograph is,
          and last whose hand the handles are answering to. Nothing is left on
          any edge, and nothing in the column is an ACT any more — the gestures
          on the picture are the acts, and the column says what they reach.
        -->
        <aside class="cluster">
          <div class="who">
            @if (name(); as called) {
              <div class="name">{{ called }}</div>
            }
            <div class="pos">{{ label() }}</div>
            <!--
              THE PASS, SAID ONCE, WHERE THE PERSON IS STANDING. The rail carries
              the sequence and the numbered steps; this is the one sentence that
              has to be true of the room you are actually in, because the stage
              below it has silently changed which handles it offers.
            -->
            <div class="pass">{{ passSays() }}</div>
            <div class="walk">
              <button
                type="button"
                [disabled]="!hasPrevious()"
                title="Previous photograph (left arrow)"
                (click)="step.emit(-1)"
              >← Back</button>
              <button
                type="button"
                [disabled]="!hasNext()"
                title="Next photograph (right arrow)"
                (click)="step.emit(1)"
              >Next →</button>
            </div>
          </div>

          <!--
            THIS PHOTOGRAPH — the facts about the picture in front of you, and
            the gestures that change only it.

            THE TOOL SELECTOR IS GONE and stays gone (Wave 24). Turn, Crop and
            Split were three exclusive MODES over one picture whose corners and
            gutter were draggable in all three -- so the mode never changed what a
            gesture did, only which buttons were on screen, which is a mode you
            cannot see the effect of. What decides now is the PASS, and a pass
            changes the handles as well as the buttons.
          -->
          <div class="does">
            <div class="cap">This photograph</div>

            <!--
              THE TURN IS THE CROP PASS'S, ruled in the contract: orienting the
              shot is part of deciding its rectangle. By the split pass the
              rectangle is settled and the page on the stage is already the way
              round it prints, so a turn here would be re-opening a decision the
              Apply has already committed.
            -->
            @if (!splitting()) {
              <div class="turnpair">
                <button type="button" title="Turn this photograph anticlockwise" (click)="turn(-1)">⟲</button>
                <button type="button" title="Turn this photograph clockwise" (click)="turn(1)">⟳</button>
              </div>
            }

            <!--
              A TICK, NOT A TOOL, AND IT SURVIVES BOTH PASSES. A split is not
              something you are holding; it is a fact about the photograph -- this
              is a spread, or it is not -- and that is as true after the crops are
              applied as before. As a mode you could stand in "split mode" on an
              uncut photograph, which is precisely the state that produced *"i set
              it, i hit ok, and nothing happened"*.

              TICKING IS THE CUT. There is no place it out and confirm it later,
              because unticking rejoins -- keeping the crop, through the same body
              the cut came from -- so the act is reversible and needs no rehearsal.
            -->
            <label class="tick">
              <input
                type="checkbox"
                [checked]="twoPages()"
                (change)="setTwoPages($any($event.target).checked)"
              />
              <span>Two pages</span>
            </label>
            <p class="says">{{ cutSays() }}</p>

            <!--
              REMOVING A CROP IS REMOVING THE MARK, so it is offered only when
              there is one -- and only in the pass that owns the rectangle. A
              control that is always there and does nothing four times out of five
              teaches people to stop reading it.
            -->
            @if (!splitting() && !wholeFrame()) {
              <button class="btn quiet" type="button" (click)="clearCrop.emit()">
                Use the whole photograph
              </button>
            }
          </div>

          <!--
            SCOPE — the one tick that says whose hand is on the handles.

            ── Owen's ruling (2026-08-26), and the two presses it replaces ────

            Wave 25 was right that the modal speaks for the photograph it has
            open, and it paid for the rule with a sequence: record the book's
            crop here, walk out to the rail, press Apply, walk back to see
            whether it fitted. \`"it wasnt obvious to me that i had to apply all
            crops from the main window"\` was the first complaint and a second
            button in here was the first answer; the real answer is that the
            SCOPE IS A STATE OF THE PHOTOGRAPH, not a property of a button.

            So: ticked, every gesture made in here — a corner, the gutter, a
            turn — is the book's gesture, and every follower takes it as the
            hand opens. Untick it and a gesture moves the page it is made on
            and marks it that page's own; the rest keep what they were last
            given.

            ── AND IT IS A MODE, NOT THE PAGE'S STATE (Wave 51b) ────────────

            It was \`!isComplete\` of the open photograph until Owen walked it:
            \`"if i uncheck global, make it so it doesnt switch back to checked
            unless i specifically set it back … i dont want to have to uncheck
            global for every one."\` A box derived per photograph is a box that
            re-ticks itself at every step, and the second half of an evening is
            one pass through fifty pages nudging each in turn.

            So TICKING MOVES NOTHING. It arms the next gesture, and the gesture
            is what defines or updates the standing — which is also what became
            of *re-tick to adopt*: a gesture made with the tick on, on a page
            somebody had taken for their own, hands it back AND leads the book,
            inside one walk.

            The current photograph is a FOLLOWER LIKE THE REST once it has led.
            It is not the source and it is not exempt — it holds the standing
            because it authored it, which is the same thing.
          -->
          <div class="scope">
            <div class="cap">Scope</div>
            <label class="tick">
              <input
                type="checkbox"
                [checked]="global()"
                (change)="globalChange.emit($any($event.target).checked)"
              />
              <span>Global</span>
            </label>
            <p class="says">{{ scopeSays() }}</p>

            <!--
              WHICH PAGES A GLOBAL GESTURE REACHES — Owen (2026-08-26): \`"a
              'just even pages' and 'just odd pages' global setting. this change
              only applies to every other page, but its global."\`

              The case is recto/verso: a book photographed one page at a time
              from a fixed stand puts the left-hand pages in one part of the
              frame and the right-hand ones in another, so a single crop is
              wrong about half the book by construction.

              ONLY WHILE GLOBAL IS TICKED, on this surface's own rule that a
              control which would change nothing is ABSENT rather than
              disabled: with the tick off a gesture reaches one page, and
              asking which half of the book that page is on would be a control
              with no act behind it.
            -->
            @if (global()) {
              <div class="sides" role="group" aria-label="Which pages a change reaches">
                @for (side of SIDES; track side.key) {
                  <button
                    type="button"
                    class="side"
                    [class.on]="scope() === side.key"
                    [attr.aria-pressed]="scope() === side.key"
                    [title]="side.title"
                    (click)="scopeChange.emit(side.key)"
                  >{{ side.word }}</button>
                }
              </div>
            }

            <!--
              WHERE THIS PAGE STANDS — a sentence, not a control, and it is no
              longer the checkbox's job to say it.

              Until Wave 51b the tick WAS this fact, so its caption could say
              both at once. The tick is a mode now and the fact is still worth
              having in front of you: a page the book has stopped moving looks
              exactly like a page it is about to move, and the dot on the card
              is behind the modal you are standing in.
            -->
            <p class="says stands">{{ standsSays() }}</p>

            <!--
              THE ONE ACT THAT OVERRULES A HAND, and the only one in this stage
              that asks first. Everything else here spares a page somebody took
              for their own — that is Owen's standing ruling and the whole point
              of the tick above. This is the door for the evening where the
              assumption is what went wrong, so it reaches the marked pages too,
              and the confirm is what keeps that from being a surprise.
            -->
            <button
              class="btn quiet"
              type="button"
              [title]="resetTitle()"
              (click)="resetAll.emit()"
            >{{ resetSays() }}</button>
            <p class="says">{{ resetMeans() }}</p>

            <!--
              THE OVERRIDE — Owen (2026-08-26): \`"if the page was individually
              edited, it's exempt from the global settings, unless the user
              specifically overrides all individual settings to revert to
              global."\`

              The exemption is everywhere in this stage already; this is the
              second half of the sentence, and until now the only door to it was
              a card's right-click, one photograph at a time, behind the modal a
              person is standing in.

              IT IS THE OTHER ACT, NOT A GENTLER RESET. Reset above goes back to
              the ORIGINALS and empties the book's standing; this KEEPS the
              standing and dresses everybody in it. Both overrule a hand, which
              is why they sit together and why both ask first — and why the
              caption has to name the one above, because the two questions are a
              step apart and the outcomes are opposite.

              ABSENT WHEN THERE IS NOBODY TO HAND BACK, on this surface's own
              rule: a control that is always there and does nothing four times
              out of five teaches people to stop reading it. It also makes the
              button a fact about the book — if it is there, some page in this
              shoot is its own.
            -->
            @if (theirOwn() > 0) {
              <button
                class="btn quiet"
                type="button"
                [title]="followAllTitle()"
                (click)="followAll.emit()"
              >Give every page back to the book</button>
              <p class="says">{{ followAllMeans() }}</p>
            }
          </div>
        </aside>
      </div>

      <!--
        THE FILMSTRIP — the book, along the foot, while you are inside a page.

        It is what makes a global act's reach VISIBLE from in here: move a corner
        with *Global* ticked and the strip is where you watch which photographs
        the book did NOT take it to — the ones carrying a tick are their own. And
        it is what makes the walk navigable without closing anything, which Back
        and Next alone never were on a shoot of fifty -- those are one step each,
        and a strip is a place.

        THE THUMBNAILS ARE RAW IN BOTH PASSES, said out loud. The cards on the
        table draw the rectified page from Apply onward; these do not, because
        the projection needs a WebGL context and this component has none -- the
        editor below owns one and the table behind owns another, and a third for
        forty-four-pixel pictures is a context per open on a surface somebody
        walks twenty-five times an evening. What the strip is FOR is the marks and
        the position, and both are honest on a raw thumbnail.
      -->
      @if (frames().length > 1) {
        <div class="strip" #strip>
          @for (frame of frames(); track frame.id) {
            <button
              type="button"
              class="shot"
              [class.now]="frame.id === here()"
              [title]="frame.label"
              (click)="jump.emit(frame.id)"
            >
              <img [src]="frame.thumb" [alt]="frame.label" loading="lazy" draggable="false" />
              @if (frame.complete) {
                <span class="dot mark">✓</span>
              }
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT -- confirm-dialog's rule,
     * for its reason: a full-window fixed host is a sheet of glass over the
     * application, and an invisible sheet still swallows every click. This one
     * is only mounted while it is open, so it is less dangerous than that
     * component's case; it follows the same rule anyway, because a component
     * that is safe only because of where it is mounted is safe by accident.
     */
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    /*
     * NEARLY THE WHOLE WINDOW, unlike every other dialog in this app, and that
     * is the point rather than an oversight: the others ask a question and this
     * one is a workbench. The photograph wants every pixel it can have, because
     * a corner placed on a small picture is a corner placed badly.
     *
     * The margin is what keeps it a modal at all -- the table stays visible
     * around the edge, so this reads as something opened OVER the work rather
     * than as a screen that replaced it.
     */
    .card {
      position: relative;
      pointer-events: auto;
      width: calc(100vw - 56px);
      height: calc(100vh - 56px);
      margin: 28px auto;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    /*
     * THE CARD IS A COLUMN OF TWO BANDS: the work, then the book.
     *
     * It was a plain row -- picture, then controls -- and the strip is what
     * needed a band of its own. Putting the strip inside the cluster would have
     * made the book a column forty-four pixels wide; putting it under the
     * picture only would have left it stopping short of the controls, which
     * reads as part of the stage rather than as the foot of the room.
     */
    .work { flex: 1; min-height: 0; display: flex; flex-direction: row; }

    .stage { flex: 1; min-width: 0; display: flex; position: relative; }
    .stage app-capture-page-editor { flex: 1; min-width: 0; }
    /*
     * The side arrows: quiet until wanted. A permanent pair of bright discs
     * flanking every photograph would be chrome louder than the corners being
     * placed; at rest they sit at the scrim's own register and the hover is
     * what makes one a control. 44px hit target, vertically centred on the
     * stage rather than the picture, so they never move as portrait and
     * landscape frames trade heights.
     */
    .leaf {
      position: absolute; top: 50%; transform: translateY(-50%);
      z-index: 2;
      width: 44px; height: 64px;
      display: grid; place-items: center;
      background: rgba(24, 23, 21, 0.55);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 26px; line-height: 1;
      cursor: pointer;
      transition: background-color 120ms cubic-bezier(0, 0, 0.2, 1), color 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    .leaf:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--border-strong); }
    .leaf.back { left: 10px; }
    .leaf.next { right: 10px; }

    .cluster {
      width: 268px; flex: none;
      border-left: 1px solid var(--border-subtle);
      background: var(--bg-base);
      display: flex; flex-direction: column;
      overflow: auto;
    }

    .who { padding: 14px 16px 12px; border-bottom: 1px solid var(--border-subtle); }
    .who .name { font-family: var(--font-mono); font-size: 12px; }
    .who .pos { color: var(--text-tertiary); font-size: 11.5px; margin-top: 2px; }
    .who .pass { color: var(--accent); font-size: 11.5px; margin-top: 4px; }
    .walk { display: flex; gap: 6px; margin-top: 10px; }

    .cap {
      color: var(--text-tertiary); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 6px;
    }

    .does { padding: 14px 16px 0; display: flex; flex-direction: column; gap: 8px; }
    /*
     * A REAL CHECKBOX, not a styled div with a role. The tick is the whole
     * control -- label included, so the words are as clickable as the box -- and
     * the native element brings the keyboard, the focus ring and the
     * announcement with it. This app has no tick-box of its own to borrow from;
     * the confirm dialog's is the only other one and it is inside a dialog
     * component that cannot be reached from here.
     */
    .tick {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: var(--text-primary);
      cursor: pointer;
      user-select: none;
    }
    .tick input { accent-color: var(--accent); cursor: pointer; margin: 0; }

    .turnpair { display: flex; gap: 8px; }
    .turnpair button {
      flex: 1; padding: 9px 0;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      color: var(--text-primary);
      font-size: 16px; line-height: 1;
      cursor: pointer;
    }
    .turnpair button:hover { background: var(--bg-hover); }

    /*
     * SCOPE SITS DIRECTLY UNDER THE PHOTOGRAPH'S OWN CONTROLS, and not at the
     * foot where the acts used to be.
     *
     * The acts belonged at the bottom because the thing you finish with is the
     * thing at the bottom -- the rail puts Mint there for the same reason. This
     * tick is not a thing you finish with: it changes what the NEXT gesture on
     * the picture means, so it has to be read beside the handles it governs
     * rather than found at the end of a column.
     */
    .scope {
      padding: 14px 16px 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    /*
     * THE THREE SIDES, AS ONE CONTROL. A segmented row rather than three ticks
     * or a <select>: the choice is exclusive and all three answers are worth
     * seeing at once, which is what a row of segments says and a dropdown hides
     * behind a click. Indented under the tick it belongs to, because it is
     * meaningless without it -- the same relationship the caption below has.
     */
    .sides { display: flex; gap: 0; margin-left: 22px; }
    .side {
      flex: 1;
      padding: 5px 0;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-right-width: 0;
      color: var(--text-secondary);
      font: inherit; font-size: 11px;
      cursor: pointer;
    }
    .side:first-child { border-radius: var(--radius-md, 6px) 0 0 var(--radius-md, 6px); }
    .side:last-child {
      border-right-width: 1px;
      border-radius: 0 var(--radius-md, 6px) var(--radius-md, 6px) 0;
    }
    .side:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* The chosen one carries the accent the ticked box does, so the two read as
       one setting rather than as a control and a decoration beside it. */
    .side.on {
      background: var(--accent-faint, var(--bg-hover));
      border-color: var(--accent);
      color: var(--text-primary);
    }
    /* Two rules of one border between neighbours would draw a two-pixel seam;
       the accent has to win over the plain edge on its left. */
    .side.on + .side { border-left-color: var(--accent); }
    /*
     * THE SAME DOT THE CARD DRAWS, at the same size and in the same colour, so
     * the mark on the table and the mark in the strip are one vocabulary rather
     * than two things that resemble each other.
     */
    .dot {
      flex: none;
      width: 13px; height: 13px;
      border-radius: 99px;
      background: var(--ok, #4ade80);
      display: grid; place-items: center;
      font-size: 8px; line-height: 1;
      color: var(--bg-base);
      margin-top: 2px;
    }

    .btn {
      width: 100%;
      padding: 9px 12px;
      border-radius: var(--radius-md, 6px);
      font: inherit; font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .btn.quiet {
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default);
    }
    .btn.quiet:hover { background: var(--bg-hover); }
    /*
     * THE .btn.primary AND .btn.right RULES STOOD HERE, AND .applied WITH THEM,
     * AND THE COLUMN HAS NO ACTS LEFT TO WEAR THEM (Wave 51).
     *
     * The accent was the record's, the green was the say-so's -- the colour of
     * the mark it produced, which is why it was the one exception in this
     * column -- and .applied was the acknowledgement both borrowed for a second
     * and a half after a press. Every one of those presses is gone: the
     * propagation is the gesture now, and a gesture acknowledges itself by
     * moving the picture. What is left is the quiet button, twice.
     */
    /* Said quietly and next to the button it describes: it is a caption on one
       control, not an announcement about the room. */
    .says { font-size: 11px; color: var(--text-tertiary); }
    /* Where the page stands is a fact about the picture rather than a note on a
       control, so it is set apart from the captions that are. */
    .says.stands { padding-top: 8px; border-top: 1px solid var(--border-subtle); }

    .walk button, .shut {
      padding: 5px 9px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      font: inherit; font-size: 12px;
      cursor: pointer;
    }
    .walk button { flex: 1; }
    .walk button:hover:not(:disabled), .shut:hover {
      background: var(--bg-hover); color: var(--text-primary);
    }
    .walk button:disabled { opacity: 0.4; cursor: default; }

    /* The one control still floating over the picture, because it belongs to
       the window rather than to the work. */
    .shut {
      position: absolute; top: 10px; right: 14px; z-index: 2;
      border-color: transparent; padding: 2px 8px;
    }

    /*
     * THE FILMSTRIP. One row, scrolling sideways, at the foot of everything --
     * the same band the table's own strip of thumbnails would occupy, so the
     * modal and the table put the book in the same place.
     */
    .strip {
      flex: none;
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      overflow-x: auto;
      overflow-y: hidden;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-base);
      scrollbar-width: thin;
    }
    .strip .shot {
      position: relative;
      flex: none;
      width: 44px; height: 44px;
      padding: 0;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm, 4px);
      background: var(--bg-sunken);
      overflow: hidden;
      cursor: pointer;
      opacity: 0.55;
    }
    .strip .shot:hover { opacity: 0.85; border-color: var(--border-default); }
    /*
     * THE ONE YOU ARE ON IS LIT, not merely outlined: at forty-four pixels a
     * border alone is two pixels of difference between the picture you are
     * editing and the twenty-four you are not.
     */
    .strip .shot.now {
      opacity: 1;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-faint);
    }
    .strip .shot img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .strip .mark {
      position: absolute;
      top: 2px; left: 2px;
      margin: 0;
      width: 11px; height: 11px;
      font-size: 7px;
      border: 1px solid var(--bg-base);
    }
  `],
})
export class CaptureEditorModalComponent {
  /** "Photograph 5 of 27 · pages 9-10 of 54" — composed by the light table. */
  readonly label = input.required<string>();
  readonly source = input.required<string>();
  readonly dimensions = input.required<Dimensions>();
  readonly quads = input.required<readonly FractionQuad[]>();
  /** The gutter as two endpoints, or null while this photograph is one page. */
  readonly split = input<CaptureSplit | null>(null);

  /**
   * WHICH PASS THE BOOK IS IN — crop everything, then split everything.
   *
   * The book's fact, handed down. Nobody chooses it in here, which is what makes
   * it a pass rather than a mode: a mode is state you can forget you are in, and
   * this one has changed the picture on the stage as well as the buttons beside
   * it. See the class docblock for what each pass offers.
   */
  readonly pass = input<'crop' | 'split'>('crop');
  protected readonly splitting = computed(() => this.pass() === 'split');

  /**
   * THE BOOK'S CROP IN THIS PHOTOGRAPH'S TERMS, or null when there is nothing
   * worth drawing under this page's own outline. Composed by the light table,
   * which is the only side that holds a standing.
   */
  readonly ghost = input<CaptureQuad | null>(null);

  /*
   * A `stage` INPUT AND A `tool` INPUT STOOD HERE AND BOTH ARE GONE (Wave 24).
   *
   * `stage` said whether this project opens on the one wide button that sets the
   * whole shoot or on the per-page row. There is one control set per pass now
   * and neither changes underneath anybody -- the encouragement `stage` carried
   * ("they were all shot the same way, so setting one sets them all") is the
   * pass model's own premise and is said by the rail, in order, with numbers.
   *
   * `tool` said which of Turn, Crop or Split the rail's row had asked for. The
   * modes are gone with the selector; the rail's rows still open this room, and
   * they all open the same one.
   */

  /**
   * IS THE BOOK STILL MOVING THIS PHOTOGRAPH — the Global tick, drawn.
   *
   * `!isComplete`, asked of the recipe by the light table, so the tick in here,
   * the dot on the card and the skip every global makes are ONE question. It is
   * a derived state rather than a setting this component keeps: a person who
   * unticks the box, walks to another photograph and walks back must find the
   * box where they left it, and the only thing that can promise that is the
   * recipe.
   *
   * ── THE COUNT ON THE OLD BULK-TURN BUTTON STOOD HERE ──────────────────────
   *
   * `outOfTurn` was how many other photographs *Turn the other 24 to match this
   * one* would move, and the number was the whole of what told that press apart
   * from the ⟲ ⟳ pair above it. The press is subsumed by this tick — a turn made
   * with it on already reaches every follower — so there is nothing left for the
   * count to label.
   */
  readonly global = input<boolean>(true);

  /**
   * WHICH PAGES A GLOBAL GESTURE REACHES — all of them, or one side of the book.
   *
   * Session state, owned by the service beside the mode, drawn here. Read only
   * while the tick is on: with it off, a gesture reaches the page in front of
   * you and the sides have nothing to be about.
   */
  readonly scope = input<CaptureScope>('all');

  /**
   * THE BOOK HAS STOPPED MOVING THIS ONE — `isComplete`, drawn as a sentence.
   *
   * It used to be the tick, inverted (`global`, before Wave 51b). The tick is a
   * mode now, so the fact needs a surface of its own: the dot that says it on the
   * table is behind the modal a person is standing in, and a page the book has
   * given up looks exactly like one it is about to move.
   */
  readonly own = input<boolean>(false);

  /**
   * HOW MANY PHOTOGRAPHS IN THE WHOLE BOOK ARE THEIR OWN — the override's
   * subject, and the reason it is sometimes not drawn at all.
   *
   * `own` above is this photograph; this is the population, because the act
   * under it speaks for the book rather than for the picture on screen. It is
   * the rail's `complete` count — one derivation, `isComplete`, asked once in
   * the service — rather than anything this component works out, so the button
   * appears exactly when the dots on the table say it should.
   *
   * A NUMBER RATHER THAN A BOOLEAN. `> 0` draws the button and the count is
   * spent in its title, which is the one place on this surface where *how many
   * pages am I about to give away* can be read before the dialog says it. A
   * boolean would be this component being handed an answer somebody upstream
   * derived from the number anyway, and then wanting the number back.
   */
  readonly theirOwn = input<number>(0);

  /**
   * THE THREE SIDES, IN THE ORDER THEY ARE OFFERED.
   *
   * A constant on the class rather than three buttons written out, so the words,
   * the titles and the arms of `CaptureScope` cannot come apart — a fourth arm
   * would fail to compile here rather than quietly go undrawn.
   */
  protected readonly SIDES: readonly { key: CaptureScope; word: string; title: string }[] = [
    { key: 'all', word: 'All pages', title: 'A change here moves every page the book still moves' },
    { key: 'odd', word: 'Odd', title: 'A change here moves the 1st, 3rd, 5th … photograph — and no others' },
    { key: 'even', word: 'Even', title: 'A change here moves the 2nd, 4th, 6th … photograph — and no others' },
  ];

  /**
   * What the person called this photograph, or NULL when nothing does.
   *
   * `CapturePhoto.name` is optional by design: a project intaken before the
   * field existed has photographs with no name and always will, and the type's
   * own docblock rules that "the position in the grid is the honest stand-in,
   * never the sha".
   *
   * Here that stand-in is ALREADY ON SCREEN -- the line below this one says
   * "Photograph 12 of 25". So a nameless photograph drops the name line rather
   * than repeating the position twice, which is what filling it with the
   * fallback would do.
   */
  readonly name = input<string | null>(null);

  /*
   * `complete`, `canMatch`, `photographs` AND `marked` STOOD HERE (Wave 51).
   *
   * `complete` is `global` above, inverted and renamed for the control that now
   * draws it. `canMatch` gated *Follow the book again*, which was release and
   * re-dress in one press and is what re-ticking the box does. The other two
   * carried "12 of 25 marked" under the say-so, and the say-so is gone: it
   * completed AND stepped, so it could not say "this one is mine" without also
   * leaving the page, which is the one thing a person unticking the box is
   * about to NOT do.
   */

  /**
   * WHERE THE BOOK IS CUT, or null when it has no cut this photograph could take.
   *
   * ── Owen: *"the split page line is not persisting from page to page"* ──────
   *
   * It was not, and deliberately: the proposal reset to dead centre on every
   * step, because with no book's cut the only fallbacks were "this photograph's"
   * and "the middle". For twenty-five frames of one book on one stand, the
   * middle is the wrong guess every time. Same missing noun, second complaint.
   *
   * Null does not mean "use the middle quietly" -- it means say so. The two
   * offers are different and `cutSays` tells them apart out loud, because a line
   * placed where the rest of the book is cut and a line placed nowhere in
   * particular are worth different amounts of trust.
   */
  readonly bookCut = input<CaptureSplit | null>(null);

  /** Whether this photograph is a spread — which is what the tick means. */
  protected readonly twoPages = computed(() => this.quads().length > 1);

  /** Which pass this is, in one sentence, for the person standing in it. */
  protected readonly passSays = computed<string>(() => (this.splitting()
    ? 'Splitting — the crops are applied; only the cut moves here.'
    : 'Cropping — place the rectangle this page prints from.'));

  /**
   * WHAT THE NEXT GESTURE WILL REACH — the caption on the tick, and on the sides.
   *
   * ── It stopped describing the PHOTOGRAPH at Wave 51b ──────────────────────
   *
   * It used to say *Following the book* / *Its own*, because the tick was that
   * state. The tick is a MODE now — whose hand is on the handles until somebody
   * says otherwise — so its caption has to be about the hand. Where the page
   * stands moved to `standsSays` below, which is a fact rather than a
   * consequence and reads perfectly well beside a control it does not govern.
   *
   * IT IS STILL NOT A PROMISE ABOUT A PRESS. Nothing happens when the tick is
   * ticked; the sentence describes what the next gesture on the picture will
   * mean, which is the one thing a person needs before they make one.
   *
   * "the book still moves" is the skip, said without a number. A count here
   * would need to be scoped, live, and recomputed on every step, and the rail
   * carries the counted version under the button that spends them.
   */
  protected readonly scopeSays = computed<string>(() => {
    if (!this.global()) return 'Your changes move this page alone. The rest keep the lines they have.';
    if (this.scope() === 'odd') {
      return 'Your changes move the odd pages the book still moves — the 1st, 3rd, 5th photograph.';
    }
    if (this.scope() === 'even') {
      return 'Your changes move the even pages the book still moves — the 2nd, 4th, 6th photograph.';
    }
    return 'Your changes move every page the book still moves.';
  });

  /**
   * WHERE THIS PHOTOGRAPH STANDS — the fact the tick used to carry.
   *
   * Two states, both of them the person's own words from Wave 51. The third
   * clause is what the mode adds: with *Global* on, a page that is its own is
   * one gesture away from being handed back, because a gesture made with the
   * book's hand IS the handing back (`leadTheBook`, whose lead is always
   * dressed). Saying so is what keeps the untick honest — a person who took this
   * page for their own and left the tick on should know the next nudge gives it
   * away.
   */
  protected readonly standsSays = computed<string>(() => {
    if (!this.own()) return 'This page is following the book.';
    return this.global()
      ? 'This page is its own — the book leaves it alone until you move something here, which hands it back.'
      : 'This page is its own — the book leaves it alone.';
  });

  /** What the reset button says. One act per pass, named for what it undoes. */
  protected readonly resetSays = computed<string>(() => (this.splitting()
    ? 'Reset every split'
    : 'Reset every crop'));

  protected readonly resetTitle = computed<string>(() => (this.splitting()
    ? 'Put every photograph in the book back together as one page, and clear the book\'s cut'
    : 'Give every photograph in the book the whole frame back, and clear the book\'s crop'));

  /**
   * WHAT THE RESET REACHES, and the one clause that matters is the last.
   *
   * Every other global in this stage spares a page somebody placed by hand. This
   * one does not, which is exactly why a person reaches for it — and exactly why
   * the sentence must say so before the dialog does, rather than letting the
   * confirm be the first place anybody learns it.
   *
   * The turns are named too. "Back to original" is ambiguous about them, and the
   * answer is the surprising one: a shoot of sideways spreads keeps the turns
   * somebody spent an evening making. See `CaptureService.resetAll`.
   */
  protected readonly resetMeans = computed<string>(() => (this.splitting()
    ? 'Every photograph in the book, rejoined — the ones you set yourself included. Crops stay.'
    : 'Every photograph in the book, back to the whole frame — the ones you set yourself '
      + 'included. Turns stay.'));

  /**
   * WHAT THE OVERRIDE REACHES, and it is the opposite of the Reset above it.
   *
   * The count is here rather than in the label because the label has to name an
   * OUTCOME — *give every page back to the book* — and a number in it would make
   * the button read as a report on a population instead of an act.
   */
  protected readonly followAllTitle = computed<string>(() => {
    const pages = this.theirOwn() === 1 ? '1 page' : `${this.theirOwn()} pages`;
    return this.splitting()
      ? `Clear the own mark on ${pages} and give each of them the cut its side of the book is set to`
      : `Clear the own mark on ${pages} and give each of them the crop and cut its side of the book `
        + 'is set to';
  });

  /**
   * WHAT IT DOES, AND — the clause that earns the sentence — WHAT IT DOES NOT.
   *
   * Two acts sit one above the other and both overrule a hand, which is the
   * whole reason a person is looking at either of them. They differ in the thing
   * that costs the most to get wrong: Reset throws the LINES away and empties
   * the book's standing with them; this keeps the standing and hands it out. So
   * the caption names the neighbour rather than letting a person discover the
   * difference by pressing one.
   *
   * The split pass's crops are named too, for `applyCuts`' reason: by then the
   * crops are committed, and somebody giving a page back in the split pass is
   * asking about the gutter, not about the corners.
   */
  protected readonly followAllMeans = computed<string>(() => (this.splitting()
    ? 'Every page you set yourself takes the book\'s cut as it stands. Crops stay, and so do the '
      + 'book\'s own lines — Reset above is the one that goes back to the originals.'
    : 'Every page you set yourself takes the book\'s crop and cut as they stand. The book\'s own '
      + 'lines stay exactly as they are — Reset above is the one that goes back to the originals.'));

  /**
   * WHAT TICKING WOULD DO, or what dragging does once it is ticked.
   *
   * The unticked sentence is the one that matters: it says WHERE the cut will
   * land before somebody commits to having one, and it distinguishes the book's
   * cut from the middle. That distinction is the visible half of the fix for the
   * line not persisting -- a person who reads "cuts where the rest of the book
   * is cut" knows the placement carried, and a person who reads "down the
   * middle" knows it has not been set yet and that this press will be what sets
   * it.
   */
  protected readonly cutSays = computed<string>(() => {
    /*
     * THE TICKED SENTENCE NAMES THE OUTCOME BEFORE THE GESTURE.
     *
     * It used to open with "Drag either end", which is a hint about a handle and
     * says nothing about what ticking DID. Owen, on meeting it: *"what does it do
     * when we split pages?"* -- a fair question of a control whose whole effect
     * is a number that changed somewhere else on the screen. The readout above
     * does say "pages 8-9 of 49", and it is the only thing that did.
     *
     * In the split pass it says WHERE THE LINE GOES, which is the tick above's
     * answer and not this control's: with *Global* on, sliding it moves the
     * whole book; with it off, this page alone. That sentence used to say the
     * second half unconditionally ("moving it makes the page its own"), which
     * was true then and is now true of exactly one of the two states.
     */
    if (this.twoPages()) {
      if (!this.splitting()) {
        return 'This is two pages of the book. Drag either end, or grab the line anywhere to slide it.';
      }
      if (!this.global()) {
        return 'Slide the line. This page is its own, so the book is left where it is.';
      }
      /*
       * AND IT NAMES THE SIDE WHEN THERE IS ONE (Wave 51b). "the rest of the
       * book follows it" is a claim about every other page, and under *Odd* or
       * *Even* it is true of half of them — which is the sentence telling
       * somebody their gutter reached twenty-five pages when it reached twelve.
       */
      if (this.scope() === 'odd') return 'Slide the line and the other odd pages follow it. Untick Global to move this one alone.';
      if (this.scope() === 'even') return 'Slide the line and the other even pages follow it. Untick Global to move this one alone.';
      return 'Slide the line and the rest of the book follows it. Untick Global to move this one alone.';
    }
    return this.bookCut() === null
      ? 'Cuts down the middle. Drag the line onto the gutter afterwards.'
      : 'Cuts where the rest of the book is cut.';
  });

  readonly hasPrevious = input.required<boolean>();
  readonly hasNext = input.required<boolean>();

  /**
   * THE BOOK ALONG THE FOOT, and which photograph of it is open.
   *
   * `here` is separate rather than a flag on the frame it belongs to, so that
   * stepping through the walk does not rebuild the list: the strip's pictures
   * are twenty-five <img> elements and an array that changed identity on every
   * arrow press would be twenty-five bindings re-evaluated to say one thing.
   */
  readonly frames = input<readonly EditorFrame[]>([]);
  readonly here = input<string | null>(null);

  /*
   * `justApplied` STOOD HERE — which of four presses had just landed, so the
   * button could say "Applied ✓" for a second and a half.
   *
   * Owen asked for it of a press whose whole effect happened somewhere else:
   * *"If it did run then there should be an indication."* All four presses are
   * gone (Wave 51), and what replaced them acknowledges itself — a corner moved
   * with *Global* ticked changes the picture under the hand and the filmstrip
   * beside it, which is the indication the button was standing in for.
   */

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<CaptureSplit>();
  /** One gesture on the picture ended, having moved something. See the editor. */
  readonly settled = output<void>();
  /**
   * THE GLOBAL TICK, BOTH WAYS — and since Wave 51b it MOVES NOTHING.
   *
   * It arms the mode and no more. Ticked, the next gesture speaks for the book;
   * unticked, the next gesture speaks for the page it is made on. Nothing is
   * marked, nothing is dressed, and the box stays where it was put until
   * somebody puts it somewhere else — which is the whole of what Owen asked for
   * ("just keep it checked/unchecked unless i check/uncheck it again").
   */
  readonly globalChange = output<boolean>();
  /** Which pages a global gesture speaks for. Session state, never the recipe. */
  readonly scopeChange = output<CaptureScope>();
  /** Put the whole book back — confirmed by the parent, never by this. */
  readonly resetAll = output<void>();
  /**
   * HAND EVERY PAGE SOMEBODY SET THEMSELVES BACK TO THE BOOK — the override.
   *
   * Confirmed by the parent for the same reason `resetAll` is, and through the
   * same door: this modal has never asked a question of its own, because the
   * dialog stacks over it and the act belongs to the book rather than to the
   * photograph on screen.
   */
  readonly followAll = output<void>();
  /** A quarter turn of this photograph, for the service to perform. */
  readonly turnBy = output<number>();
  /** Take the crop off this photograph — the whole frame, which is no crop. */
  readonly clearCrop = output<void>();
  /**
   * THE TICK, AS AN ANSWER RATHER THAN AN ACT: true cuts, false rejoins.
   *
   * One output for both directions, because they are one control and one
   * question. Two outputs -- a cut and a `clearSplit` -- would let a caller wire
   * half of a checkbox, which is a tick that goes one way and sticks.
   */
  readonly twoPagesChange = output<boolean>();

  /**
   * Whether this photograph has NO crop on it — the whole frame, however many
   * times it has been turned.
   *
   * Through the shared body rather than a comparison written here: "is there a
   * crop" is a question the service already answers for the rail's count, and
   * two spellings of it would eventually disagree about a turned photograph.
   */
  protected readonly wholeFrame = computed(() =>
    isWholeFrameTurned(joinedQuad(this.quads() as readonly CaptureQuad[], this.split())));

  /*
   * `recordStanding`, `applyStanding`, `rightNext`, `release` AND `followAgain`
   * STOOD HERE — five outputs for five presses, all of them gone (Wave 51).
   *
   * The first two wrote the book's standing (and, in the second, applied it);
   * the tick above does both as the gesture lands, so neither has a moment left
   * to happen at. `rightNext` was the say-so. `release` and `followAgain` were
   * the two halves of coming back to the book — one kept the lines and one took
   * the book's — and the tick is the single door for both, because with
   * propagation live there is no useful state in between.
   */
  /** A photograph in the strip was clicked. */
  readonly jump = output<string>();
  readonly step = output<number>();
  readonly close = output<void>();

  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');

  constructor() {
    /*
     * THE STRIP FOLLOWS THE WALK, because a strip you have to scroll to find
     * yourself in is a map with no "you are here" on it. Fifty photographs is
     * more than fits, and Back and Next move the picture without moving the row.
     *
     * By index into the element's own children, which is exact: the @for is the
     * only thing in that element, so child N is frame N. `block: 'nearest'` so
     * that a strip already in view never drags the modal vertically -- the whole
     * card is fixed, and a scroll there would look like the room moving.
     */
    effect(() => {
      const at = this.frames().findIndex((frame) => frame.id === this.here());
      const host = this.strip()?.nativeElement;
      if (host === undefined || at < 0) return;
      // A microtask, because the effect can run in the same turn the strip is
      // first created and an element that has not been laid out yet scrolls to
      // nowhere.
      queueMicrotask(() => {
        host.children[at]?.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
    });
  }

  /*
   * A PER-VISIT TURN COUNTER USED TO LIVE HERE and is gone with the button that
   * read it. "Turn all BY the same amount" needed an amount, so the amount was
   * remembered from the moment the modal opened -- and that made the control
   * dead on arrival at every photograph, because the count reset whenever the
   * picture changed. Stepping to the next page and back forgot turns that the
   * page itself had kept.
   *
   * The replacement asks the BOOK instead: how many photographs sit at a
   * different turn from this one (CaptureService.outOfTurnWith). A question
   * about state answers the same way ten seconds later; a question about a
   * visit does not.
   */

  /*
   * A "take the hand-set ones too" CHECKBOX STOOD HERE, then a `stampEverything`
   * that raised the same question in a dialog, and both are gone with the press.
   *
   * The checkbox asked on every stamp about a situation that usually does not
   * exist, which is how a control teaches people to stop reading it. The dialog
   * moved the question to the moment of conflict, which was the right direction
   * and still the wrong surface: it asked, in the modal, about twenty-four
   * photographs a person could not see, at the instant they were about to be
   * overwritten.
   *
   * WAVE 25 REMOVED THE SUBJECT INSTEAD OF THE SENTENCE. Complete photographs
   * are simply left out of every global, and Wave 51 gave the way back a control
   * of its own — the *Global* tick, re-ticked, on the ONE photograph somebody
   * means, or the same door from the card's right-click. There is nothing left
   * to ask at gesture time, because a gesture overwrites nobody who has said
   * they are their own.
   */

  /*
   * THE TICK EMITS THE ANSWER, NOT THE GEOMETRY.
   *
   * `cutInTwo` stood here and composed the segment itself -- the book's cut, or
   * `splitFromFraction` down the middle -- then emitted a split and two quads.
   * It has moved to `CaptureService.cutHere`, and the move is not tidying: WHERE
   * THE CUT CAME FROM decides whether this photograph is following the book or
   * placing its own, and only the side that owns the standing can answer that.
   * Composing it here meant the component knew the cut and the service had to
   * guess what it meant, which is how ticking to take the book's own cut came to
   * mark the photograph hand-set and exclude it from the standing it had just
   * accepted.
   *
   * `bookCut` stays an input, for the SENTENCE. Saying which of the two offers
   * is on the table is this component's job; making it is not.
   */

  /** Ticked cuts this photograph, unticked rejoins it. Both are exact. */
  protected setTwoPages(on: boolean): void {
    this.twoPagesChange.emit(on);
  }

  /**
   * Turn this photograph a quarter — THROUGH THE SERVICE, not by rotating the
   * quads on the way out.
   *
   * It used to emit `quads.map(rotate)`, which is right for a page and wrong
   * for a spread: turning two halves independently keeps their old reading
   * order, and a half turn swaps which one reads first. That is measured (see
   * `turned` in capture.service.ts) and it was invisible here, because the
   * editor draws both halves and both look correct.
   *
   * A spread's turn has to rebuild the sheet and re-derive the halves, and the
   * component that draws two quads has no business knowing that. So the turn
   * travels as a TURN and the one body that understands cuts performs it —
   * the same body the table's turn goes through, which is what keeps the two
   * surfaces from disagreeing about which way round a page is.
   */
  protected turn(turns: number): void {
    this.turnBy.emit(turns);
  }


  /**
   * Escape closes, and the arrows walk.
   *
   * On the window rather than the card because the pointer is routinely over the
   * picture and the card does not hold the focus while somebody is dragging a
   * corner. Ignored while a field has it, for the reason every shortcut in this
   * app is: a key that eats a character somebody was typing is worse than no
   * shortcut at all.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    event.preventDefault();
    if (event.key === 'Escape') this.close.emit();
    else this.step.emit(event.key === 'ArrowLeft' ? -1 : 1);
  }
}

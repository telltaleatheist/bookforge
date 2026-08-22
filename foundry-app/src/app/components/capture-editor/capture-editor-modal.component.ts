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

import { CapturePageEditorComponent } from './capture-page-editor.component';
import { type Dimensions, type FractionQuad } from './geometry';
import type { ApplyToAll } from '../../core/capture.service';

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
 * ── THE SURFACE NAMES THE SCOPE, AND THAT IS WAVE 25'S WHOLE RULE ───────────
 *
 *     A control on a CARD speaks for that photograph.
 *     A control on the RAIL speaks for the book.
 *     The MODAL speaks for the photograph it has open.
 *
 * Wave 24 got as far as NAMING the two levels — "This photograph" and "The rest
 * of the book", each under a heading — and left the second one holding a press
 * that changed twenty-four other pictures. Wave 25 finishes it: what is left in
 * the book's group is a RECORD. *Make this the book's crop* sets the standing
 * and stamps nothing; the propagation is Apply, on the table, where the book's
 * surface is. The button's own line says where it went.
 *
 * That is a smaller act, and being smaller is what makes it usable: a person can
 * set the book's crop from page 3, disagree, set it again from page 11, and
 * nothing has happened to page 7 in between.
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
 * ── What it does NOT own ────────────────────────────────────────────────────
 *
 * The corners, the split line, the projection and the previews are all
 * `CapturePageEditorComponent`, still pointable at any image. What lives up here
 * are the ACTS and the walk.
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
          where it stands with the book, the say-so, and last what the book takes
          from it. Nothing is left on any edge.
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
            WHERE IT STANDS — the identity block, and Wave 25's one state where
            Wave 24 had two.

            COMPLETE means exactly one thing: THE BOOK STOPS MOVING THIS
            PHOTOGRAPH. Every global act skips it; Finish never does. It is
            reached by placing something by hand (a hand-placed change is assumed
            correct, Owen's standing ruling) or by the say-so below.

            The old sentence here read *"You placed this crop, so Crop all leaves
            it alone"* -- which named a press that no longer exists and a
            provenance that is no longer the rule. A page can be complete with
            nobody's fingerprints on its corners.
          -->
          <div class="stands">
            <div class="cap">Where it stands</div>
            @if (complete()) {
              <p class="state">
                <span class="dot">✓</span>
                <span>Its own — the book leaves this one alone.</span>
              </p>
              <!--
                NO CONFIRM, deliberately, where removal has one: release destroys
                nothing. The page keeps its crop, its cut and its turn, and the
                only thing that changes is whether the next Apply may move it.
                Same semantics and same words as the card's right-click, because
                they are one door reached from two places.
              -->
              <button
                class="btn quiet"
                type="button"
                title="The next Apply is allowed to move this one again"
                (click)="release.emit()"
              >Release — let the book change it again</button>
              @if (canMatch()) {
                <button
                  class="btn quiet"
                  type="button"
                  title="Take the book's crop now, and move with the book from then on"
                  (click)="followAgain.emit()"
                >Follow the book again</button>
                <p class="says">Takes the book's crop now, and moves with the book from then on.</p>
              }
            } @else {
              <p class="state">
                <span>{{ followSays() }}</span>
              </p>
            }
          </div>

          <!--
            THE SAY-SO — the person speaking, at page grain.

            It is the rail's tick philosophy one level down: a derivation cannot
            know that somebody has LOOKED at a page and agreed with it. A person
            who opens a photograph the book's crop already fits, is happy, and
            steps on has moved nothing -- so there is no geometry to derive a
            completion from, and without this press the next Apply would move a
            page they had just approved.

            IT IS IN BOTH PASSES, which is a call rather than a reading. The
            contract's walking language is split-pass-centric, and the same
            sentence is true in the crop pass: the say-so is the ONLY way to
            complete a page without moving something on it, and the crop pass is
            where most pages are looked at and left alone.
          -->
          <div class="sayso">
            <button
              class="btn right"
              type="button"
              [class.applied]="justApplied() === 'right'"
              title="Complete this photograph and go to the next"
              (click)="rightNext.emit()"
            >✓ This page is right — next</button>
            <p class="says">{{ saySoSays() }}</p>
          </div>

          <!--
            THE BOOK — and what is left here is a RECORD.

            Wave 24's *Crop all* stood in this group and did two things: it wrote
            the book's standing AND copied it onto every other photograph of the
            same shape. The two are separated because the modal speaks for the
            photograph it has open, and a press here that changed twenty-four
            other pictures was the modal speaking for the book.

            So the line under it names WHAT IS RECORDED and WHERE THE
            PROPAGATION LIVES. It is not a consequence line any more -- there is
            no population to count, because this press reaches exactly one thing
            and that thing is the book's own crop. The counting moved with the
            act, to the Apply on the rail.
          -->
          <div class="acts">
            <div class="cap">The book</div>

            <!--
              ABSENT RATHER THAN GREYED, for the reason the split button already
              establishes. It used to sit here disabled saying "The others already
              match", which is a control explaining why it is not a control.

              It is the crop pass's, with the turn pair: a bulk turn is the one
              global that overwrites nobody's corners, and it belongs beside the
              gesture it repeats.
            -->
            @if (!splitting() && outOfTurn() > 0) {
              <button
                class="btn quiet"
                type="button"
                [class.applied]="justApplied() === 'turn'"
                title="Turn the rest of the book to match the one you are looking at"
                (click)="applyToAll.emit({ kind: 'turn' })"
              >{{ turnAllSays() }}</button>
            }

            <!--
              ABSENT WHEN THERE IS NO LINE TO RECORD, and that is a refusal
              rather than a tidy: in the split pass this button writes the
              book's cut, and on an uncut photograph it would write the ABSENCE
              of one -- clearing a line the rest of the book is following, from
              a press whose label says nothing about clearing. So what is drawn
              instead is the way forward, which is P2's own rule on the rail
              ("with nothing to apply the button could only refuse").
            -->
            @if (!splitting() || twoPages()) {
              <button
                class="btn primary"
                type="button"
                [class.applied]="justApplied() === 'record'"
                [title]="recordTitle()"
                (click)="recordStanding.emit(splitting() ? 'cut' : 'crop')"
              >{{ recordSays() }}</button>
              <p class="says">{{ recordMeans() }}</p>
              <!--
                RECORD-AND-APPLY IN ONE PRESS — Owen (2026-08-22), from his
                first real walk of the passes: \`"it wasnt obvious to me that i
                had to apply all crops from the main window instead of from
                within the modal. maybe there should be a button to apply crops
                to all pages... probably just an additional button."\` The two
                acts stay two doors underneath (the record, then the same Apply
                the rail presses — one predicate, one door); this button is the
                pair reachable from where the person is standing. The rail's
                Apply remains the place the consequence line lives in full; the
                announce says what this press touched.
              -->
              <button
                class="btn quiet"
                type="button"
                [class.applied]="justApplied() === 'stamp'"
                [title]="splitting()
                  ? 'Make this line the book\\'s cut and cut every following photograph now'
                  : 'Make this the book\\'s crop and apply it to every following photograph now'"
                (click)="applyStanding.emit(splitting() ? 'cut' : 'crop')"
              >{{ justApplied() === 'stamp' ? 'Applied ✓' : (splitting() ? 'Make it the book\\'s cut and cut the rest' : 'Make it the book\\'s crop and apply to all') }}</button>
            } @else {
              <p class="says">
                Tick <em>Two pages</em>, put the line down the gutter, and this is where you
                make it the book's cut.
              </p>
            }
          </div>
        </aside>
      </div>

      <!--
        THE FILMSTRIP — the book, along the foot, while you are inside a page.

        It is what makes a global act's reach VISIBLE from in here: press Apply on
        the table, come back, and the ones the book left alone are the ones
        carrying a tick. And it is what makes the walk navigable without closing
        anything, which Back and Next alone never were on a shoot of fifty --
        those are one step each, and a strip is a place.

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

    /* Where it stands, and the say-so: two small bands between the photograph's
       own controls and the book's, in the order a person reads them. */
    .stands, .sayso {
      padding: 14px 16px 0;
      display: flex; flex-direction: column; gap: 8px;
    }
    .stands .state {
      display: flex; align-items: flex-start; gap: 7px;
      font-size: 12px; color: var(--text-secondary);
    }
    /*
     * THE SAME DOT THE CARD DRAWS, at the same size and in the same colour, so
     * the mark on the table, the mark in the strip and the state in here are one
     * vocabulary rather than three things that resemble each other.
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

    /* THE ACTS SIT AT THE FOOT OF THE COLUMN, which is where the rail puts Mint
       for the same reason: the thing you finish with is the thing at the bottom. */
    .acts {
      margin-top: auto;
      padding: 14px 16px 16px;
      border-top: 1px solid var(--border-subtle);
      display: flex; flex-direction: column; gap: 8px;
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
    .btn.primary {
      background: var(--accent); color: var(--text-inverse);
      border: 1px solid var(--accent); font-weight: 600;
    }
    .btn.primary:disabled { opacity: 0.45; cursor: default; }
    /*
     * THE SAY-SO IS GREEN, and it is the only green control in this column.
     *
     * It is the same colour as the complete dot it produces, which is the whole
     * reason for the exception: pressing it puts that mark on this photograph,
     * on the card behind, and in the strip below, and a button the colour of its
     * own outcome needs no sentence explaining the connection.
     */
    .btn.right {
      background: var(--ok-soft); color: var(--ok);
      border: 1px solid var(--ok); font-weight: 600;
    }
    .btn.right:hover { background: var(--ok); color: var(--bg-base); }
    /* Said quietly and next to the button it describes: it is a caption on one
       control, not an announcement about the room. */
    .says { font-size: 11px; color: var(--text-tertiary); }

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

    /*
     * THE ACKNOWLEDGEMENT, carried over from the light table's gesture row
     * (Wave 21 point 5) and deliberately not animated. The house has no
     * precedent for a transient confirmed state, and an effect invented for one
     * button is the kind of motion that reads as decoration rather than as
     * information.
     */
    .applied {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
      color: var(--text-inverse);
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
   * HOW MANY OTHER PHOTOGRAPHS WOULD ACTUALLY TURN -- the service's count, not
   * this component's.
   *
   * It is on the button because the number is what tells a bulk turn from the
   * pair of arrows above it. "Turn all by the same amount" and "Apply to all"
   * were two labels a person could not tell apart; "Turn the other 24 to match
   * this one" differs from ⟲ by its verb AND by its count.
   */
  readonly outOfTurn = input<number>(0);

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

  /**
   * THE BOOK HAS STOPPED MOVING THIS PHOTOGRAPH — `isComplete`, the one test.
   *
   * The same question the dot on the card asks and the same one every global act
   * asks before skipping, so what this column says and what an Apply does cannot
   * promise different things.
   */
  readonly complete = input<boolean>(false);

  /**
   * Whether there is a book's crop for THIS photograph to be returned to.
   *
   * False before anybody has recorded one, and false for a photograph of a shape
   * the standing was not drawn for -- which is not the same question as "is
   * there a standing at all", and is why the parent asks it per photograph.
   */
  readonly canMatch = input<boolean>(false);

  /** How many photographs the book has, and how many of them are complete. */
  readonly photographs = input<number>(0);
  readonly marked = input<number>(0);

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

  /** What the record button says. One act per pass, named for its outcome. */
  protected readonly recordSays = computed<string>(() => {
    if (this.justApplied() === 'record') return 'Recorded ✓';
    return this.splitting() ? 'Make this line the book\'s cut' : 'Make this the book\'s crop';
  });

  protected readonly recordTitle = computed<string>(() => (this.splitting()
    ? 'Store this gutter as the book\'s cut. Nothing else moves until you apply it from the table.'
    : 'Store this rectangle as the book\'s crop. Nothing else moves until you apply it from the table.'));

  /**
   * WHAT THE RECORD MEANS — what is written, and where the propagation lives.
   *
   * This is where Wave 24's consequence line stood, and it is a different KIND
   * of sentence now rather than a shorter one. That line had to name three
   * populations, because the press it sat under changed every photograph in two
   * of them; this press changes one thing, and the thing is not a photograph.
   *
   * So the honest sentence is the two halves a person needs and no third: WHAT
   * IS RECORDED, and WHERE IT IS APPLIED FROM. The numbers did not disappear --
   * they moved to the Apply button on the rail, with the act they describe.
   */
  protected readonly recordMeans = computed<string>(() => {
    if (this.splitting()) return 'Becomes the book\'s cut. Applied from the table.';
    return this.twoPages()
      ? 'Becomes the book\'s crop and cut. Applied from the table.'
      : 'Becomes the book\'s crop. Applied from the table.';
  });

  /** What a photograph the book still moves is waiting for. */
  protected readonly followSays = computed<string>(() => (this.splitting()
    ? 'Following the book. The next Apply gives it the book\'s cut.'
    : 'Following the book. The next Apply gives it the book\'s crop.'));

  /**
   * WHAT THE SAY-SO WOULD DO, and how far through the book the marks are.
   *
   * The count is here rather than on the button because it is about the BOOK and
   * the button is about this page -- and because the reassurance is the half
   * that matters. Owen: *"i need a way to finalize the action"*, said of a
   * surface that had already been saving every drag for weeks. Nothing is at
   * stake in the press; what it buys is that the book stops moving this one.
   */
  protected readonly saySoSays = computed<string>(() => {
    const said = ['Marks it and steps on.'];
    const total = this.photographs();
    if (total > 0) said.push(`${this.marked()} of ${total} marked.`);
    said.push('Nothing is lost either way — every change is kept the moment you make it.');
    return said.join(' ');
  });

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
     * In the split pass it says the other half as well, because that is the
     * pass's whole gesture: sliding the line is a PLACEMENT, so it completes the
     * page and the book stops moving it. A person who does not know that would
     * nudge a gutter and then wonder why the next Apply skipped the picture.
     */
    if (this.twoPages()) {
      return this.splitting()
        ? 'Slide the line if this one sits differently. Moving it makes the page its own, and the book leaves it alone from then on.'
        : 'This is two pages of the book. Drag either end, or grab the line anywhere to slide it.';
    }
    return this.bookCut() === null
      ? 'Cuts down the middle. Drag the line onto the gutter afterwards.'
      : 'Cuts where the rest of the book is cut.';
  });

  /** What the bulk-turn button says, which is always what it would do. */
  protected readonly turnAllSays = computed<string>(() => {
    if (this.justApplied() === 'turn') return 'Turned ✓';
    const others = this.outOfTurn();
    return others === 1
      ? 'Turn the other one to match this'
      : `Turn the other ${others} to match this one`;
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

  /**
   * Which act just landed, for the button that was pressed. Owned by the parent,
   * because the acknowledgement outlives the click by a second and a half and
   * this component holds no timers.
   */
  readonly justApplied = input<'turn' | 'record' | 'stamp' | 'right' | null>(null);

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<CaptureSplit>();
  readonly applyToAll = output<ApplyToAll>();
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

  /**
   * THIS PHOTOGRAPH'S CROP OR CUT BECOMES THE BOOK'S — and nothing is stamped.
   *
   * The pass travels WITH the press rather than being read again on the other
   * side. Two surfaces deciding independently which of two acts a single button
   * meant is the shape that produced Wave 24's shape-shifting primary; the
   * button knows which one it drew, so it says.
   */
  readonly recordStanding = output<'crop' | 'cut'>();
  /** The record AND the table's Apply, one press — see the button's own comment. */
  readonly applyStanding = output<'crop' | 'cut'>();
  /** Complete this photograph and step to the next. */
  readonly rightNext = output<void>();
  /** Let the book change this one again. Same door as the card's right-click. */
  readonly release = output<void>();
  /** Take the book's crop now, and follow it from then on. See `canMatch`. */
  readonly followAgain = output<void>();
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
   * are simply left out of every global; RELEASE is the deliberate press that
   * puts one back in the flow, on the ONE photograph somebody means, reached
   * from the card it is about or from *Where it stands* above. There is nothing
   * left to ask at record time, because a record overwrites nobody.
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

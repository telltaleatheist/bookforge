import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  input,
  output,
} from '@angular/core';

import { isWholeFrameTurned, joinedQuad } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { CapturePageEditorComponent } from './capture-page-editor.component';
import { type Dimensions, type FractionQuad } from './geometry';
import type { ApplyToAll, StampCost } from '../../core/capture.service';

/**
 * THE EDITOR AS A ROOM YOU STEP INTO: this photograph, then the rest of the book.
 *
 * ── Why a modal and not a pane ──────────────────────────────────────────────
 *
 * Wave 21 point 1, from Owen's own reading of PDFElement: the grid is where you
 * choose, and the editor is where you work. The editor used to REPLACE the grid
 * inside the same tab, so leaving it meant a button called "All photographs" and
 * coming back meant finding your card again. A modal keeps the table underneath,
 * which is the difference between going somewhere and opening something.
 *
 * ── THE TWO LEVELS ARE THE TWO GROUPS, AND THAT IS THE WHOLE STRUCTURE ──────
 *
 * Wave 24. The controls that change THIS PHOTOGRAPH are in one group and the
 * controls that change THE BOOK are in another, each under a heading that says
 * so. Both levels have existed since Wave 21 and the app never said which was
 * which -- the rail was the book, this column was the page, and the buttons
 * shape-shifted between the two. Owen: *"the two buttons at the bottom are
 * confusing as hell… the whole paradigm of how we're doing it now versus
 * global+individual"*.
 *
 * Two things went to make that legible. THE TOOL SELECTOR, because Turn, Crop
 * and Split were modes over a picture whose corners and gutter stayed draggable
 * in all three -- so a mode changed no gesture, only which buttons were on
 * screen. And THE STAGES: a derived stage 1 / stage 2 that decided whether the
 * primary button set the whole shoot or one page. There is one control set now
 * and it does not change, which is what lets every control be named after its
 * outcome instead of after the state it is in.
 *
 * What holds the surface together instead is one rule, and it is this stage's
 * own precedent (from the split button: *"not a disabled button but an ABSENT
 * one"*):
 *
 *     A CONTROL THAT WOULD CHANGE NOTHING IS NOT SHOWN.
 *
 * ── What it does NOT own ────────────────────────────────────────────────────
 *
 * The corners, the split line and the previews are still
 * `CapturePageEditorComponent`, unchanged and still pointable at any image. What
 * lives up here is the ACTS -- because those are decisions about the shoot, and
 * the picture below is one photograph.
 */
@Component({
  selector: 'app-capture-editor-modal',
  imports: [CapturePageEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>

    <div class="card" role="dialog" aria-modal="true">
      <button class="shut" type="button" title="Back to the table (Escape)" (click)="close.emit()">✕</button>

      <div class="stage">
        <app-capture-page-editor
          [source]="source()"
          [dimensions]="dimensions()"
          [quads]="quads()"
          [split]="split()"
          (quadsChange)="quadsChange.emit($event)"
          (splitChange)="splitChange.emit($event)"
        />
      </div>

      <!--
        ONE COLUMN, IN THE ORDER THE WORK HAPPENS, and it replaces a perimeter.

        Owen: "the buttons are all on the other side of the app from each other."
        They were: walking in the header, the tools in the header, the gestures
        in the footer's left corner and the acts in its right. Four groups on
        three edges of a window whose middle is a photograph.

        Now: who you are looking at and how to move, then what you are doing,
        then what that tool does to THIS photograph, then what it does to the
        BOOK. Nothing is left on any edge.
      -->
      <aside class="cluster">
        <div class="who">
          @if (name(); as called) {
            <div class="name">{{ called }}</div>
          }
          <div class="pos">{{ label() }}</div>
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
          THIS PHOTOGRAPH, THEN THE REST OF THE BOOK — the two levels, named.

          They have both existed since Wave 21 and the app never said so: the
          prepare rail is the book and this column is the page, and the buttons
          shape-shifted to cope with carrying both. Owen: *"the two buttons at
          the bottom are confusing as hell… the whole paradigm of how we're doing
          it now versus global+individual"*.

          THE TOOL SELECTOR IS GONE, and that is the structural change. Turn,
          Crop and Split were three exclusive MODES over one picture whose
          corners and gutter were draggable in all three -- so the mode never
          changed what a gesture did, only which buttons were on screen, which is
          a mode you cannot see the effect of. Every control it used to hide is
          here at once, governed by one rule instead:

            A CONTROL THAT WOULD CHANGE NOTHING IS NOT SHOWN.

          Which is this stage's own precedent, from the split button: *"not a
          disabled button but an ABSENT one"*. A photograph that matches the rest
          therefore carries almost nothing -- just the picture and its handles.
        -->
        <div class="does">
          <div class="cap">This photograph</div>

          <div class="turnpair">
            <button type="button" title="Turn this photograph anticlockwise" (click)="turn(-1)">⟲</button>
            <button type="button" title="Turn this photograph clockwise" (click)="turn(1)">⟳</button>
          </div>

          <!--
            A TICK, NOT A TOOL. A split is not something you are holding; it is a
            fact about the photograph -- this is a spread, or it is not. As a
            mode you could stand in "split mode" on an uncut photograph, which is
            precisely the state that produced *"i set it, i hit ok, and nothing
            happened"*, and it forced the primary button to change identity
            between cutting this one and stamping the book.

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
            there is one. A control that is always there and does nothing four
            times out of five teaches people to stop reading it.
          -->
          @if (!wholeFrame()) {
            <button class="btn quiet" type="button" (click)="clearCrop.emit()">
              Use the whole photograph
            </button>
          }

          <!--
            THE RELEASE, NAMED FOR ITS OUTCOME AT LAST.

            This button used to read *"Let apply-to-all change it again"* -- a
            sentence about a POLICY governing a FUTURE PRESS, which was the only
            kind of name available while there was nothing on the other side of
            the release to point at. Owen: *"i dont know what the point of this
            is"*. He was reading it correctly.

            There is a noun now (CaptureStanding), so the control can be named
            after what a person watches happen. It is absent when the book has no
            standing yet, because then there is nothing to match.
          -->
          @if (handSetHere()) {
            <p class="says">You placed this crop, so Crop all leaves it alone.</p>
            @if (canMatch()) {
              <button
                class="btn quiet"
                type="button"
                title="Give this photograph the crop the rest of the book has"
                (click)="matchTheOthers.emit()"
              >Match the others</button>
            }
          }
        </div>

        <div class="acts">
          <div class="cap">The rest of the book</div>

          <!--
            ABSENT RATHER THAN GREYED, for the reason the split button already
            establishes. It used to sit here disabled saying "The others already
            match", which is a control explaining why it is not a control.
          -->
          @if (outOfTurn() > 0) {
            <button
              class="btn quiet"
              type="button"
              [class.applied]="justApplied() === 'turn'"
              title="Turn the rest of the book to match the one you are looking at"
              (click)="applyToAll.emit({ kind: 'turn' })"
            >{{ turnAllSays() }}</button>
          }

          <!--
            ONE BUTTON, AND THE LINE UNDER IT IS WHERE THE HONESTY LIVES.

            Crop all carries the cut as well as the crop -- which is what the
            stamp has always done -- so a button labelled Crop can cut
            twenty-three photographs in two. Owen ruled that the consequence line
            covers it rather than a second Cut all appearing and disappearing
            beside it.

            So the line is not decoration. It is the whole of how a person knows
            what a global act will cost BEFORE pressing it, and it has to name
            all three populations: what changes, what is spared for being
            hand-set, and what is spared for being a different shape.
          -->
          <button
            class="btn primary"
            type="button"
            [class.applied]="justApplied() === 'stamp'"
            title="Make this the crop the rest of the book takes"
            (click)="stampEverything()"
          >{{ cropAllSays() }}</button>
          <p class="says">{{ cropAllCosts() }}</p>
        </div>
      </aside>
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
      display: flex; flex-direction: row;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .which { font-size: 12px; color: var(--text-secondary); }
    .grow { flex: 1; }

/* THE CARD IS A ROW NOW: the photograph, then the column of controls. It was
       a column of three bands -- header, picture, footer -- which is what put the
       controls on three different edges. */
    .stage { flex: 1; min-width: 0; display: flex; }
    .stage app-capture-page-editor { flex: 1; min-width: 0; }

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
    .btn.kept {
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default);
    }
    .btn.kept.on {
      background: var(--ok-soft); color: var(--ok); border-color: var(--ok);
    }
    /* Said quietly and next to the button it describes: it is a caption on one
       control, not an announcement about the room. */
    .says { font-size: 11px; color: var(--text-tertiary); }

    /* A segmented control, which is what three exclusive tools are. It sits
       above what it changes, because the column reads top to bottom in the order
       the work happens. */
    .tools {
      display: flex; gap: 4px;
      padding: 3px;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle, #2a2824);
      border-radius: var(--radius-md, 6px);
    }
    .tools button {
      flex: 1;
      border: none; background: none;
      color: var(--text-secondary);
      font: inherit; font-size: 12px;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .tools button:hover { color: var(--text-primary); }
    .tools button.on { background: var(--accent-soft); color: var(--accent); }

    /* Beside the button it changes, in the tick-box voice confirm-dialog
       already uses for a statement about an act rather than an act of its own. */

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

    .act {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border: none;
      border-radius: var(--radius-md);
      background: var(--accent-strong); color: var(--text-inverse);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .act:hover { background: var(--accent); }
    .act:active { transform: scale(0.98); }

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

  /*
   * A `stage` INPUT AND A `tool` INPUT STOOD HERE AND BOTH ARE GONE (Wave 24).
   *
   * `stage` said whether this project opens on the one wide button that sets the
   * whole shoot or on the per-page row. There is one control set now and it does
   * not change, so there is no stage to be in -- the encouragement it carried
   * ("they were all shot the same way, so setting one sets them all") is said
   * better and more precisely by the consequence line under Crop all, which
   * gives the actual number.
   *
   * `tool` said which of Turn, Crop or Split the rail's row had asked for. The
   * modes are gone with the selector; the rail's three rows still open this
   * room, and now they all open the same one.
   */

  /**
   * HOW MANY OTHER PHOTOGRAPHS WOULD ACTUALLY TURN -- the service's count, not
   * this component's.
   *
   * It is on the button because the number is the difference between this
   * control and the crop stamp beside it. "Turn all by the same amount" and
   * "Apply to all" were two labels a person could not tell apart; "Turn the
   * other 24 to match this one" and "Use this crop on all 25 photographs"
   * differ by their verb AND by their count, and the count is the half that was
   * on neither button.
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
   * WHAT *CROP ALL* WOULD COST, in the three populations the line under it names.
   *
   * The service counts it against the same rules the stamp applies, so the
   * sentence cannot promise a different act from the one the button performs.
   * See `StampCost`.
   */
  readonly cost = input<StampCost>({ takes: 0, byHand: 0, shape: 0 });

  /**
   * Whether there is a book's crop for THIS photograph to be returned to.
   *
   * False before anybody has pressed *Crop all*, and false for a photograph of a
   * shape the standing was not drawn for -- which is not the same question as
   * "is there a standing at all", and is why the parent asks it per photograph.
   */
  readonly canMatch = input<boolean>(false);

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

  /** What the primary act says. One label now, because it is one act. */
  protected readonly cropAllSays = computed<string>(() =>
    (this.justApplied() === 'stamp' ? 'Applied ✓' : 'Crop all'));

  /**
   * THE CONSEQUENCE LINE — every population the press touches, before it lands.
   *
   * Four short sentences at most, and each of them earns its place:
   *
   *   what this press MEANS, which is the part that has never been sayable --
   *     there was no book's crop to become;
   *   who TAKES it, which is the old button's number moved under the button;
   *   who is SPARED for being hand-set, which is Owen's ruling made visible.
   *     Left unsaid, a count of photographs that did not move reads as failure;
   *   who is spared for being a different SHAPE, which the notice bar reports
   *     afterwards and which is worth knowing before rather than after.
   *
   * The counts are the service's, so the sentence and the act cannot disagree.
   */
  protected readonly cropAllCosts = computed<string>(() => {
    const { takes, byHand, shape } = this.cost();
    const cut = this.twoPages();
    const said: string[] = [
      cut ? 'Becomes the book\'s crop and cut.' : 'Becomes the book\'s crop.',
    ];
    if (takes > 1) {
      said.push(`${takes} photographs take ${cut ? 'them' : 'it'}${cut ? ', two pages each' : ''}.`);
    }
    if (byHand > 0) {
      said.push(byHand === 1
        ? 'One you placed by hand keeps its own.'
        : `${byHand} you placed by hand keep their own.`);
    }
    if (shape > 0) {
      said.push(shape === 1
        ? 'One is a different shape and is left out.'
        : `${shape} are a different shape and are left out.`);
    }
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
     */
    if (this.twoPages()) {
      return 'This is two pages of the book. Drag either end, or grab the line anywhere to slide it.';
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
  /** Whether THIS photograph was placed by hand. */
  readonly handSetHere = input<boolean>(false);
  /** Which act just landed, for the button that was pressed. Owned by the parent. */
  readonly justApplied = input<ApplyToAll['kind'] | null>(null);

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
  /** Give this photograph back to the book's crop. See `canMatch`. */
  readonly matchTheOthers = output<void>();
  readonly step = output<number>();
  readonly close = output<void>();

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
   * A "take the hand-set ones too" CHECKBOX STOOD HERE and is gone. Owen: "that
   * should be assumed." It asked, on every stamp, about a situation that
   * usually does not exist -- which is how a control teaches people to stop
   * reading it -- and it asked BEFORE the act rather than at the moment of
   * conflict. The question moved to a confirmation that appears only when there
   * is something of theirs to overwrite, and names it. See
   * CaptureViewComponent.applyToAll.
   */

  /*
   * AN `advanced` FLAG AND A `showing` STAGE STOOD HERE AND WENT WITH THE STAGES.
   *
   * They existed to work around one thing: on a virgin project the stamp copies
   * whole-frame quads onto whole-frame quads, so the recipe afterwards was byte
   * for byte the recipe before and the DERIVED stage still read "nobody has set
   * anything" -- leaving somebody in stage 1 having pressed the one button that
   * was supposed to take them out of it. Measured: three untouched photographs,
   * stamp from the first, stage 1 before and stage 1 after.
   *
   * There is no stage to be stuck in now. And the press is no longer a no-op on
   * a virgin project either, which is the quieter half: it records the book's
   * standing crop, so it changes the recipe even when it changes no photograph.
   */

  /**
   * *CROP ALL* — this photograph's crop and cut become the book's, and every
   * following photograph of this shape takes them.
   *
   * IT CARRIES NO OVERRIDE FLAG. Whether the hand-set photographs come too is
   * asked at the moment of conflict, by the surface that owns dialogs, and this
   * component's job is to say WHICH ACT rather than to answer a question about
   * it in advance.
   */
  protected stampEverything(): void {
    this.applyToAll.emit({ kind: 'stamp' });
  }

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

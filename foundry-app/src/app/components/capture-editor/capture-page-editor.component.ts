import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';

import {
  type Dimensions,
  type FractionPoint,
  type FractionQuad,
  cornerNear,
  distanceToEdge,
  toPixels,
  withCorner,
} from './geometry';
import {
  cutOf, joinedQuad, outputSizeFor, seatSplit, slideSplit, turnsOf, WHOLE_FRAME,
} from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { Rectifier } from './rectify';

/**
 * ONE PHOTOGRAPH, WITH ITS CORNERS IN THE USER'S HANDS.
 *
 * ── What this component is responsible for, and what it deliberately is not ──
 *
 * It draws a working copy, puts handles on the quads over it, and says what the
 * person did to them. It knows nothing about the recipe, the project, or IPC:
 * quads arrive as an input and leave as an output, in the recipe's own unit
 * (fractions of the working copy), and `capture.service.ts` is what turns that
 * into a `capture:recipe-save`.
 *
 * That line is drawn where it is because this is the surface the corners are
 * chosen on, and a surface that also owned the saving would have to be opened to
 * be tested by hand, and would drag the whole contract in behind it. As written
 * it can be pointed at any image with any quads.
 *
 * ── THE PREVIEW IS THE SAME SHADER AS THE MINT, WHICH IS THE POINT ──────────
 *
 * The panel on the right is `Rectifier` — the identical transform the mint will
 * run at full resolution, drawn small. docs/CAPTURE.md rules that the mint and
 * the preview are "one shader, not two implementations", so what a person sees
 * while dragging a corner is the page they are going to get rather than a
 * promise about it. It also means the doc's own out-of-bounds hazard is visible
 * here: `withinSource` comes back false and the panel says so.
 *
 * ── CORNERS CLAMP TO THE PHOTOGRAPH, WHICH THEY DID NOT AT FIRST ────────────
 *
 * An earlier revision let a corner be dragged off the frame and merely SAID so
 * in the preview panel, on the reasoning that a crop is somebody's choice. Two
 * things killed it. There is nothing out there — sampling past the edge clamps
 * to the last row of pixels, so an off-frame crop is a smear rather than a
 * choice — and `validQuad` in electron/capture.ts refuses any coordinate
 * outside [0,1] when the recipe is saved. Together those made one drag past the
 * edge stop the recipe SAVING, for the rest of the session, while the light
 * table went on looking alive. Pointer capture means the pointer is routinely
 * outside the picture box, so it was not a corner case.
 *
 * So the drag clamps, the way the split line always did, and `withinSource`
 * stops being a routine notice and becomes what it should have been: a
 * should-never-happen that says the shader was handed something impossible.
 *
 * ── THE GESTURE ROW MOVED UP, AND THAT IS THIS FILE GETTING ITS JOB BACK ────
 *
 * Turn, Split and the applies used to sit under the picture here. Wave 21 put
 * them in the modal footer, which is where they belonged all along: an apply-to-
 * all is an act on THE WHOLE SHOOT, and this component has never heard of a
 * second photograph. What is left is exactly what the docblock above always
 * claimed -- a picture, handles on it, and what the person did to them.
 *
 * ── Geometry lives next door, not here ──────────────────────────────────────
 *
 * Every rule about what a corner MEANS — a quarter turn is a permutation, a
 * split cuts across the quad's own edges rather than the photograph's, a quad
 * may only be copied onto a photo of the same shape — is in `geometry.ts` and
 * shared with the grid and the mint driver. What is left here is pointer
 * arithmetic and drawing, which is the only part that could not be shared.
 *
 * ── The wrapper is the picture, so there is no letterbox arithmetic ─────────
 *
 * The image sits in a box given the working copy's own aspect ratio, sized to
 * fit whatever room it has. So the box's client rectangle IS the picture, and
 * turning a pointer position into a fraction is one subtraction and one divide
 * — no `object-fit` maths that has to agree with the browser's, and nothing
 * that goes subtly wrong when the pane is resized mid-drag.
 */
@Component({
  selector: 'app-capture-page-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="editor">
      <div class="picture-column">
        <!--
          THE FRAME OWNS THE LEFTOVER HEIGHT. See the styles: without it the
          picture sized itself against the whole column and overflowed it.
        -->
        <!--
          THE LISTENERS ARE ON THE FRAME, NOT ON THE PICTURE, and that is the
          whole of Owen's "cant grab the top two".

          A handle is 18px wide and centred ON its corner with a -9px margin, so
          a quad hugging an edge -- which the whole-frame default is, on every
          photograph of this shoot -- puts HALF of each edge handle outside the
          picture. A press aimed at the visible dot then lands on whatever is
          behind it, and grab() never runs. The bottom corners happened to sit
          far enough inside the visible area on his screen for their circles to
          be fully over the listener, which is the entire asymmetry: the top two
          were not special, they were just the ones at an edge he pressed above.

          The frame owns the leftover space and is padded (see the styles), so
          every handle now has listening surface all the way around it. The
          fraction conversion still measures the PICTURE, so a press that starts
          in the padding is simply a fraction slightly outside [0,1] -- which the
          drag already clamps, and which cornerNear already measures honestly.
        -->
        <!--
          THE CURSOR IS THE ONLY THING SAYING ANY OF THIS IS DRAGGABLE.

          Every handle here is pointer-events:none, so the browser hit-tests
          nothing and a :hover rule on a corner or the gutter would never match.
          The frame carries the classes instead, off the same walk the press
          uses -- see under(). Held beats hovering, because a hand that has
          already taken hold of something is past being told it could.
        -->
        <div
          class="frame"
          #frame
          [class.can-grab]="over() !== null"
          [class.grabbing]="held() !== null || holdingSplit() !== null"
          [class.on-cut]="onTheCut()"
          (pointerdown)="grab($event)"
          (pointermove)="drag($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
          (pointerleave)="over.set(null)"
        >
        <div
          class="picture"
          #picture
          [class.page]="projecting()"
          [style.aspect-ratio]="turned().box"
          [style.width]="turned().slotWidth"
          [style.height]="turned().slotHeight"
        >
        <!--
          THE PHOTOGRAPH IS SHOWN THE WAY ROUND IT WILL PRINT.

          Owen, three separate reports, the last of them: "no matter how i
          rotated it, the thumbnails are properly rotated, but the main image
          inside the modal is not rotated". It was not, and that was the
          design -- a turn permutes the corner assignment without moving a
          corner, so the picture is identical before and after and only the
          first-corner mark moves.

          It is a bad argument, and the evidence is that the person it was
          written for could not read it three times running. The table draws the
          printed orientation, so the editor was the one surface disagreeing
          with every other: turn twenty-five spreads upright, see them upright
          on the table, open one, find it on its side.

          Picture and handles turn as ONE element, as the card does and for the
          same reason -- the handles are drawn in the photograph's own fraction
          space, so turning one without the other would put a sideways crop over
          an upright photograph, which reads as a bug in the crop rather than as
          an absence.
        -->
        <div
          class="spun"
          #spun
          [class.texture]="projecting()"
          [style.width]="turned().spunWidth"
          [style.height]="turned().spunHeight"
          [style.transform]="turned().spin"
        >
          <!--
            (load) IS THE OTHER HALF OF THE REDRAW, and see repaint() for why an
            effect alone could not be.

            IT IS STILL HERE IN THE SPLIT PASS AND IT IS THE TEXTURE THEN, not
            the picture -- invisible rather than absent, exactly as the light
            table's cards do it, because \`display: none\` would be a photograph
            the browser never decodes and a canvas that never gets anything to
            draw.
          -->
          <img
            #photo
            [src]="source()"
            [alt]="'The photograph being edited'"
            (load)="repaint()"
            draggable="false"
          />

          @if (!projecting()) {
            <!--
              The handles are an SVG in the picture's own fraction space
              (viewBox 0 0 1 1), so nothing here has to know the pixel size of
              the box it is drawn in, and a resize needs no recomputation.
              \`vector-effect\` keeps the strokes one pixel wide at any scale.
            -->
            <svg class="handles" viewBox="0 0 1 1" preserveAspectRatio="none">
              <!--
                THE BOOK'S CROP, UNDER THIS PAGE'S OWN, so a deviation is a thing
                you can SEE rather than a thing you have to remember.

                A complete photograph sits out every Apply, which means the crop
                it holds can drift arbitrarily far from the book's and nothing on
                the surface would say so -- the page looks correct because it IS
                what somebody placed. Drawn faint and dashed and BENEATH the real
                outline, so it reads as a reference rather than as a second
                choice: the solid line is the page that will be minted, always.

                Absent when the two agree, because a control -- or a mark -- that
                would change nothing is not shown, and a dashed line hiding
                exactly under a solid one is noise on every page in the book.
              -->
              @if (ghost(); as book) {
                <polygon
                  class="ghost"
                  vector-effect="non-scaling-stroke"
                  [attr.points]="outlineOf(book)"
                />
              }
              @for (quad of quads(); track $index) {
                <polygon
                  class="outline"
                  vector-effect="non-scaling-stroke"
                  [attr.points]="outlineOf(quad)"
                />
              }
              @if (cut(); as line) {
                <line
                  class="split"
                  vector-effect="non-scaling-stroke"
                  [attr.x1]="line.a.point[0]" [attr.y1]="line.a.point[1]"
                  [attr.x2]="line.b.point[0]" [attr.y2]="line.b.point[1]"
                />
              }
            </svg>

            <!--
              Corner handles are DOM rather than SVG circles: they want a hit area
              bigger than the dot a person aims at, and a CSS box gives that for
              free at any zoom. Positioned in percentages, which is the same
              fraction space the quads are already in.
            -->
            @for (handle of handles(); track handle.key) {
              <span
                class="handle"
                [class.first]="handle.corner === 0"
                [class.held]="held()?.quad === handle.quad && held()?.corner === handle.corner"
                [style.left.%]="handle.at[0] * 100"
                [style.top.%]="handle.at[1] * 100"
              ></span>
            }

            <!--
              THE GUTTER'S TWO ENDS, EACH RIDING AN EDGE OF THE PAGE.

              Drawn where the geometry resolves the end to, not at the stored endpoint:
              the segment is gesture state and goes stale against a crop dragged
              after it, so what is on screen is where the geometry says the end
              actually sits. They are a different colour from the corners because
              they do a different thing -- a corner moves the page, these move the
              cut through it.
            -->
            @if (cut(); as line) {
              <span
                class="gutter"
                [class.held]="holdingSplit() === 'a'"
                [style.left.%]="line.a.point[0] * 100"
                [style.top.%]="line.a.point[1] * 100"
              ></span>
              <span
                class="gutter"
                [class.held]="holdingSplit() === 'b'"
                [style.left.%]="line.b.point[0] * 100"
                [style.top.%]="line.b.point[1] * 100"
              ></span>
            }
          }
        </div>

        <!--
          THE SPLIT PASS'S STAGE: THE PAGE, AND ONE LINE THROUGH IT.

          Wave 25's Apply is a commitment point -- no pixels are cut until Finish,
          but every surface starts drawing the rectified projection. The table
          did it first (the cards); this is the same picture at workbench size,
          off the same shader, drawn into a 2D canvas from the editor's ONE
          rectifier so the window gains no second WebGL context.

          THE CORNERS ARE NOT DRAWN AND NOT GRABBABLE HERE, which is the whole
          argument for the pass being a pass: what is on the stage answers the
          scope question before it is asked. The frame is settled; a handle that
          re-opened it would put the crop pass back on top of the split pass and
          undo the reason the cut fits every page at once.
        -->
        @if (projecting()) {
          <canvas #face class="face" [class.drawn]="drawn()"></canvas>
          <svg class="handles" viewBox="0 0 1 1" preserveAspectRatio="none">
            @if (pageCut(); as line) {
              <line
                class="split"
                vector-effect="non-scaling-stroke"
                [attr.x1]="line.a[0]" [attr.y1]="line.a[1]"
                [attr.x2]="line.b[0]" [attr.y2]="line.b[1]"
              />
            }
          </svg>
          @if (pageCut(); as line) {
            <span
              class="gutter"
              [class.held]="holdingSplit() === 'a'"
              [style.left.%]="line.a[0] * 100"
              [style.top.%]="line.a[1] * 100"
            ></span>
            <span
              class="gutter"
              [class.held]="holdingSplit() === 'b'"
              [style.left.%]="line.b[0] * 100"
              [style.top.%]="line.b[1] * 100"
            ></span>
          }
        }
        </div>
        </div>

      </div>

      <div class="previews">
        @for (preview of previews(); track preview.index) {
          <figure>
            <canvas #previewCanvas [width]="preview.width" [height]="preview.height"></canvas>
            <figcaption>
              Page {{ preview.index + 1 }}
              @if (!preview.withinSource) {
                <span class="outside">— corners fall outside this photograph</span>
              }
            </figcaption>
          </figure>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; height: 100%; min-height: 0; }
    .editor { display: flex; flex: 1; min-width: 0; gap: 16px; padding: 12px; }

    .picture-column { display: flex; flex-direction: column; min-width: 0; min-height: 0; flex: 1 1 0; gap: 8px; }

    /*
     * THE FRAME, AND WHY THE TOP TWO CORNERS COULD NOT BE GRABBED.
     *
     * The picture used to be a direct child of the column, sized with a
     * max-height of 100% and centred with an auto margin. That 100% resolves
     * against THE WHOLE COLUMN, which also holds the gestures row and a gap --
     * so the picture was allowed to be as tall as everything, the column
     * overflowed, and the auto margin split the overflow evenly above and below.
     *
     * CONTENT PUSHED ABOVE A CONTAINERS START EDGE CANNOT BE SCROLLED TO. So the
     * top of the photograph, and the two corner handles on it, were off screen
     * and unclickable while the bottom two were reachable. Owen found it as
     * "cant grab the top two", which is exactly what that looks like from the
     * outside: a hit test that works at one end of the picture and not the
     * other. The hit test was never wrong.
     *
     * The frame takes the leftover height as a flex item, so the max-height on
     * the picture now resolves against the space that is actually free, and the
     * centring is done by the container rather than by an auto margin that can
     * push its own item out of reach.
     */
    .frame {
      flex: 1 1 0;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      /*
       * ROOM FOR THE HANDLES TO HANG OVER THE EDGE. Half a handle is 9px, so 12
       * leaves a margin for the hand as well as for the dot. Without it a
       * picture that exactly fills the frame would put its edge handles hard
       * against the clip again, and moving the listeners here would have bought
       * nothing at the one place it was needed.
       */
      padding: 12px;
      touch-action: none;
    }
    /*
     * THE CURSOR, AND THERE WAS NONE IN THIS COMPONENT AT ALL UNTIL WAVE 24.
     *
     * Not a preference: with nothing here, a picture whose every corner and
     * whose whole gutter can be dragged looked exactly like a picture. The
     * corners at least LOOK like handles -- round, raised, the shape everything
     * uses -- and the cut's ends borrow that shape, so the one thing with no
     * sign whatever was the LINE, which slides from a grab anywhere along it.
     *
     * "grabbing" beats "can-grab" by coming later at equal specificity, which is
     * the right way round: a hand that has hold of something is past being
     * offered it. Both are on the frame because the frame is what the pointer is
     * actually over -- see the template.
     */
    .frame.can-grab { cursor: grab; }
    .frame.grabbing { cursor: grabbing; }

    /*
      The box IS the picture — see the class docblock. \`max-height: 100%\` with
      \`aspect-ratio\` set from the working copy lets it letterbox itself inside
      whatever room the pane has, without anything measuring it.
    */
    .picture {
      position: relative;
      max-width: 100%;
      max-height: 100%;
      user-select: none;
      background: var(--bg-sunken);
    }
    /*
     * Laid out at the PHOTOGRAPH's aspect and rotated onto the slot, exactly as
     * the card's .spun is -- see the template. Centred, because a rotation
     * about a corner would swing the picture out of the box.
     */
    .spun { position: absolute; top: 50%; left: 50%; transform-origin: center; }
    .picture img { display: block; width: 100%; height: 100%; }

    /*
     * THE SPLIT PASS'S STAGE.
     *
     * A ground of its own, because the thing on it is a PAGE: the shot's edges
     * are gone, so there is nothing left to explain the dark surround a raw
     * photograph brings with it, and this is also what is shown for the frame or
     * two between the picture decoding and the rectify landing.
     */
    .picture.page { background: var(--bg-sunken); }
    /*
     * The photograph is the TEXTURE now, not the picture. Invisible rather than
     * absent -- \`display: none\` would be a picture the browser never decodes and
     * a canvas that never gets anything to draw -- and inert, so the layout it
     * keeps for the crop pass cannot catch a pointer here.
     */
    .spun.texture { opacity: 0; pointer-events: none; }
    /*
     * It fades in rather than appearing, for the reason the cards do: the page is
     * drawn a frame or two after the photograph loads, and a hard swap at that
     * distance reads as a flicker in the stage rather than as a picture arriving.
     */
    .face {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      display: block;
      opacity: 0;
      transition: opacity 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    .face.drawn { opacity: 1; }

    .handles { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    .outline { fill: none; stroke: var(--accent, #4c9aff); stroke-width: 2; }
    /*
     * THE BOOK'S CROP: the same shape, said quietly. Dashed and half-faded and
     * ONE pixel where the real outline is two, so at a glance there is never a
     * question about which line is the page -- the solid one is what gets minted,
     * on every photograph, in every state. Drawn first, so the outline that
     * matters is the one on top.
     */
    .ghost {
      fill: none;
      stroke: var(--text-tertiary, #8a837a);
      stroke-width: 1;
      stroke-dasharray: 5 4;
      opacity: 0.6;
    }
    .split { stroke: var(--warn, #d08770); stroke-width: 2; stroke-dasharray: 6 4; }
    /*
     * THICKER UNDER THE HAND — the other half of the affordance, and the half
     * that says WHICH thing the cursor is about.
     *
     * A grab cursor over a picture full of handles does not say what would be
     * grabbed. The line answering to the hand does, and it answers for its whole
     * length, which is the fact that was invisible: slideSplit has always taken
     * a grab anywhere along the cut, and only the two end dots looked like they
     * could be held.
     *
     * On the frame rather than on the line, because the line cannot be hovered
     * -- it is pointer-events:none like every handle here, so the hit test is
     * under() and the class it sets is the only thing that knows.
     */
    .frame.on-cut .split { stroke-width: 3.5; stroke-dasharray: none; }

    .handle {
      position: absolute;
      width: 18px; height: 18px;
      margin: -9px 0 0 -9px;
      border: 2px solid var(--accent, #4c9aff);
      border-radius: 50%;
      background: var(--bg-raised, #fff);
      pointer-events: none;
    }
    /*
     * THE CORNER MARK, CARRIED IN FROM THE CARD (Wave 21 point 5).
     *
     * A quarter turn permutes the corner assignment WITHOUT MOVING ANY OF THEM,
     * so the outline is identical before and after and four identical handles
     * say nothing about which way the page comes out. The card already solved
     * this with a filled dot on the corner that becomes the minted page's
     * top-left; this is the same device in the same colour, so the mark means
     * one thing in both places rather than two things that resemble each other.
     *
     * It matters most on exactly this shoot: every spread of the 1876 volume
     * lies sideways and wants THREE quarter turns, and without the mark the
     * only way to see that a turn happened is to look away at the preview.
     */
    .handle.first { background: var(--accent, #4c9aff); }

    /*
     * HELD IS A RING AND A LIFT, not a fill, now that a fill means something
     * else. Filling on grab would have made every held corner look like the
     * first one -- two things sharing a name, in a colour.
     */
    .handle.held {
      transform: scale(1.15);
      box-shadow: 0 0 0 3px var(--accent-faint);
    }

    /* The gutter's ends take the split line's own colour, so the line and the
       thing that moves it read as one object rather than two controls. */
    .gutter {
      position: absolute;
      width: 16px; height: 16px;
      margin: -8px 0 0 -8px;
      border: 2px solid var(--warn, #d08770);
      border-radius: 50%;
      background: var(--bg-raised, #fff);
      pointer-events: none;
    }
    .gutter.held { background: var(--warn, #d08770); }

    .previews { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; flex: 0 0 220px; }
    .previews figure { margin: 0; }
    .previews canvas { width: 100%; height: auto; background: var(--bg-sunken); }
    figcaption { font-size: 11px; color: var(--text-tertiary); }
    .outside { color: var(--warn); }
  `],
})
export class CapturePageEditorComponent {
  /** The working copy's URL — a `foundry-file://capture/<token>/<name>` served by main. */
  readonly source = input.required<string>();
  /** Its pixel size AS THE DECODER REPORTED IT, never as EXIF describes it. */
  readonly dimensions = input.required<Dimensions>();
  /** One quad per page of this photograph: one before a split, two after. */
  readonly quads = input.required<readonly FractionQuad[]>();
  /**
   * The gutter, as the two endpoints the person dragged, or null for unsplit.
   *
   * A SEGMENT AND NOT A FRACTION SINCE WAVE 21. One number can only cut
   * parallel to the sides, and a book under a phone is never quite square to
   * it, so a straight cut through a leaning gutter takes a sliver of the facing
   * page onto both leaves.
   */
  readonly split = input<CaptureSplit | null>(null);

  /**
   * DRAW THE PAGE RATHER THAN THE PHOTOGRAPH — true through the split pass.
   *
   * ── It is a fact about the BOOK, so it is handed down ─────────────────────
   *
   * The pass belongs to the recipe and this component has never held one. It
   * arrives as an input for the same reason the grid's does: every surface flips
   * together at one commitment, and an editor deciding for itself would be a
   * second answer to a question the table has already answered.
   *
   * ── WHAT IT CHANGES IS THE WHOLE STAGE, not a style ──────────────────────
   *
   * The picture becomes the rectified sheet — square, registered, upright,
   * because the corner order is the orientation and rectifying spends it. The
   * corner handles are neither drawn nor grabbable. And the coordinate space the
   * pointer works in becomes THE PAGE'S own unit square rather than the
   * photograph's, which is what `pageMap` exists to cross.
   */
  readonly projecting = input<boolean>(false);

  /**
   * THE BOOK'S CROP, DRAWN FAINT UNDER THIS PAGE'S OWN, or null for nothing.
   *
   * In this photograph's own fraction space and already turned to face the way
   * this photograph does — the caller owes that, because relabelling a quad's
   * corners is `turnedLike`'s job and this component has no standing to read.
   *
   * Null when there is nothing worth drawing, which the caller decides: no
   * standing, a photograph of another shape, or a page that already holds the
   * book's crop exactly. See the template for why the last of those is a
   * refusal rather than an invisible coincidence.
   */
  readonly ghost = input<CaptureQuad | null>(null);

  /*
   * A `proposal` INPUT STOOD HERE, AND THE CHECKBOX RETIRED IT (Wave 24).
   *
   * It was the line the Split TOOL drew before anything had been cut -- a
   * suggestion you could move and then confirm with a button, because choosing a
   * tool must not change the page count of the book and there was no un-cut.
   *
   * Both halves of that reasoning are gone. Split is no longer a tool you stand
   * in, it is a tick that says whether this photograph is a spread; ticking IS
   * the cut, so there is no interval during which a line exists and a page does
   * not. And there is an un-cut now and there has been since `clearSplit`:
   * unticking rejoins, keeping the crop, through the same body the cut came
   * from.
   *
   * So a line on this picture is a fact about the recipe again, which is what
   * makes `cut()` below one question rather than two.
   */

  readonly quadsChange = output<readonly FractionQuad[]>();
  readonly splitChange = output<CaptureSplit>();

  /**
   * The listening surface. Capture is set here rather than on the picture
   * because a pointer is captured by the element that HEARD the press, and a
   * press on a handle overhanging the edge is heard by this one.
   */
  private readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  private readonly picture = viewChild.required<ElementRef<HTMLElement>>('picture');
  /** The element that carries the turn -- see turned() and fractionOf(). */
  private readonly spun = viewChild.required<ElementRef<HTMLElement>>('spun');
  private readonly photo = viewChild.required<ElementRef<HTMLImageElement>>('photo');
  /*
   * The preview canvases, in template order — which is `previews()` order,
   * because they are that list's `@for`. Asked for as a view query rather than
   * found with `querySelector` on a data attribute: the query is checked at
   * compile time and cannot go stale against a selector somebody renamed.
   */
  private readonly previewCanvases = viewChildren<ElementRef<HTMLCanvasElement>>('previewCanvas');
  /**
   * The split pass's stage canvas. Optional, because it exists only in that
   * pass — a required query would throw the moment somebody reopened the crops.
   */
  private readonly face = viewChild<ElementRef<HTMLCanvasElement>>('face');
  /** Whether the stage has the page in it yet — the fade, and nothing else. */
  protected readonly drawn = signal(false);

  /** Which corner is under the pointer right now, or null between drags. */
  protected readonly held = signal<{ quad: number; corner: 0 | 1 | 2 | 3 } | null>(null);
  /**
   * Which end of the gutter is under the pointer, 'line' while the whole cut is
   * being slid, or null.
   *
   * A signal rather than a field because the two handles draw their held state
   * from it, and a plain boolean could not say WHICH end is being moved.
   */
  protected readonly holdingSplit = signal<'a' | 'b' | 'line' | null>(null);
  /** Where the pointer was, and where the ends were, when a line drag started. */
  private slidFrom: { at: FractionPoint; split: CaptureSplit } | null = null;

  /**
   * WHAT THE POINTER IS OVER WHILE NOTHING IS HELD — the affordance, and only
   * that.
   *
   * It changes the cursor and thickens the line under the hand. It decides
   * nothing: `grab` asks `under` again on the press rather than reading this,
   * so a stale hover can never start a gesture on the wrong thing.
   */
  protected readonly over = signal<Under['what'] | null>(null);

  /** Whether the hand is on the cut, either resting on it or moving it. */
  protected readonly onTheCut = computed(() => {
    const gutter = this.holdingSplit();
    if (gutter !== null) return true;
    const over = this.over();
    return over === 'end' || over === 'line';
  });

  /**
   * HOW TO LAY THIS PHOTOGRAPH OUT SO IT SITS THE WAY THE PAGE WILL PRINT.
   *
   * The same arithmetic the card does, through the same turnsOf, so the table
   * and the editor cannot disagree about which way round a page is. The SLOT
   * takes the printed aspect and the element inside is laid out at the
   * photograph's own, so that rotating it lands exactly on the slot.
   *
   * -- WHY THE SLOT'S SIZE IS CHOSEN HERE AND NOT LEFT TO CSS ----------------
   *
   * The card writes width:100% and stops, because the grid hands it a definite
   * width. This has to FIT inside a frame that constrains both axes, and
   * aspect-ratio with max-width and max-height DOES NOT PRESERVE THE RATIO WHEN
   * IT CLAMPS. Measured in Chromium: a turned page in a narrow frame came out
   * 496x372 inside a slot of 496x396, and the handle layer stopped matching the
   * picture. A crop outline sitting beside the photograph instead of on it is a
   * worse defect than a picture facing the wrong way, which is why the first
   * attempt at this was reverted rather than shipped.
   *
   * So the BINDING AXIS is made definite and the ratio derives the other. Which
   * axis binds is a fact about the FRAME, not about the photograph, which is
   * why the frame is measured. Five CSS-only spellings were tried and none held
   * the ratio across turned-and-upright times narrow-and-wide; this rule holds
   * all four.
   */
  protected readonly turned = computed(() => {
    const { width, height } = this.dimensions();
    const turns = turnsOf(this.quads()[0] ?? WHOLE_FRAME);
    const sideways = turns % 2 === 1;
    const shot = sideways ? height / width : width / height;
    /*
     * THE SLOT IS THE PAGE IN THE SPLIT PASS AND THE PHOTOGRAPH IN THE CROP
     * PASS, and the two are different rectangles: the whole point of rectifying
     * is that the frame's edges go away. `pageSize` is the mint's own measure,
     * so the stage and the minted page are one rectangle at two sizes.
     *
     * The element INSIDE the slot keeps the photograph's own aspect either way,
     * because in the split pass it is no longer the picture -- it is the
     * texture, and a texture that has been squashed by a layout is still the
     * same decoded pixels to `rectify`.
     */
    const page = this.pageSize();
    const box = this.projecting() ? page.width / page.height : shot;
    const room = this.frameBox();
    // Until the frame has been measured the height binds, which is what this
    // editor did before it turned anything -- so the first paint is never worse
    // than it used to be.
    const heightBinds = room.height === 0 || room.width / room.height > box;
    return {
      turns,
      box: String(box),
      slotWidth: heightBinds ? 'auto' : '100%',
      slotHeight: heightBinds ? '100%' : 'auto',
      spunWidth: sideways ? (100 / shot) + '%' : '100%',
      spunHeight: sideways ? (100 * shot) + '%' : '100%',
      spin: 'translate(-50%, -50%) rotate(' + (turns * 90) + 'deg)',
    };
  });

  /**
   * HOW BIG THE PAGE THIS SHEET MAKES IS — the mint's own arithmetic.
   *
   * Through `outputSizeFor`, which is what decides how many pixels a rectified
   * page actually gets, so the stage's box and the minted page are the same
   * rectangle. Measuring the sheet's own spans here instead would be a second
   * body of that rule, which is the shape this feature has already paid for
   * three times over.
   */
  protected readonly pageSize = computed(() =>
    outputSizeFor(toPixels(this.sheet() as FractionQuad, this.dimensions())));

  /**
   * THE MAP BETWEEN THE PHOTOGRAPH AND THE PAGE, both ways, or null when the
   * four corners enclose nothing.
   *
   * ── Why the split pass needs one at all ──────────────────────────────────
   *
   * The stage draws the RECTIFIED sheet, so what is on screen is the page and
   * not the photograph — and the recipe stores the gutter in the PHOTOGRAPH's
   * fractions. Those two spaces are related by the same projective transform the
   * shader runs, and by nothing simpler: a homography does not preserve ratios
   * along a line, so "48% across the page" and "48% along the sheet's top edge"
   * are two different points on any photograph with keystone in it. Reading the
   * seat's own `at` and drawing it as a fraction of the stage would put the line
   * beside the gutter it is supposed to be on, by more the more the shot leans.
   *
   * ── AND WHY THE ROUND TRIP MATTERS MORE THAN EITHER DIRECTION ────────────
   *
   * The pointer comes in through `toPhoto` and the drawn line goes out through
   * `toPage`. They are exact inverses — one matrix and its adjugate — so a
   * handle sits where the hand left it rather than creeping by a fraction of a
   * per cent on every frame of a drag.
   */
  protected readonly pageMap = computed(() => pageMapFor(this.sheet()));

  /**
   * THE CUT IN THE PAGE'S OWN SPACE — the split pass's line, drawn and grabbed.
   *
   * The two ENDS are mapped and the segment between them is drawn straight,
   * which is exact rather than an approximation: a projective map takes lines to
   * lines, so the gutter is as straight on the rectified page as it was on the
   * photograph.
   */
  protected readonly pageCut = computed<{ a: FractionPoint; b: FractionPoint } | null>(() => {
    const line = this.cut();
    const map = this.pageMap();
    if (line === null || map === null) return null;
    return {
      a: map.toPage(line.a.point as FractionPoint),
      b: map.toPage(line.b.point as FractionPoint),
    };
  });

  /**
   * The frame's CONTENT box, watched.
   *
   * contentRect and not getBoundingClientRect, because the frame carries 12px
   * of padding to keep the handles off the clip, and the question here is how
   * much room the picture actually has.
   */
  private readonly frameBox = signal<{ width: number; height: number }>({ width: 0, height: 0 });

  /** Every corner of every quad, flattened for the template. */
  /**
   * THE CORNER HANDLES — AND NOT THE ONES THAT ARE REALLY THE GUTTER.
   *
   * ── Three handles were stacked on every knob, and it cost three grabs ──────
   *
   * `halvesOf` gives the two halves the cut's endpoints AS CORNERS: on a
   * side-by-side cut the top point is half A's corner 1 and half B's corner 0,
   * and the bottom point is half A's corner 2 and half B's corner 3. So a cut
   * photograph drew EIGHT corner handles, four of them underneath the two gutter
   * knobs, and `under()` tested corners first.
   *
   * Owen: *"when i grab the splitter knobs, it grabs a crop node rather than the
   * yellow splitter node. then i grab it again and its a second crop node.
   * finally, the third and yellow grab is the actual splitter, and the other two
   * i grabbed snap to the yellow."* That last clause is the whole mechanism: the
   * first two grabs moved real corners of real halves, and the moment the gutter
   * finally moved, `setSplit` rebuilt both halves from `halvesOf` and put them
   * back. Two gestures that did something, and then undid it.
   *
   * ── A corner that is the cut is not a corner, it is the cut ────────────────
   *
   * There is nothing an independent drag of one could mean. The halves must stay
   * joined along the cut -- that is what makes them two pages of one sheet -- so
   * any state where they are not is one the next gutter drag erases. So the
   * handle is not drawn and (see `under`) not grabbed either.
   *
   * GEOMETRIC RATHER THAN STRUCTURAL, deliberately. The corner indices above are
   * exact and knowable, and encoding them here would be a THIRD place that knows
   * `halvesOf`'s corner layout -- after `halvesOf` and `joinedQuad` -- which is
   * the drift this file's neighbours keep paying for. Asking "is this corner
   * where the gutter is" needs no such knowledge and stays right if the layout
   * ever changes.
   *
   * The tolerance is loose on purpose. A crop corner dragged after the cut moves
   * the sheet and re-seats the gutter, so the stored half-corners can go stale
   * against it -- and while they are more than a handle apart, both draw, which
   * is true. The next gutter drag rebuilds them and they merge again.
   */
  protected readonly handles = computed(() => {
    const line = this.cut();
    const ends = line === null ? [] : [line.a.point, line.b.point];
    const isTheCut = (at: FractionPoint): boolean =>
      ends.some((end) => Math.hypot(at[0] - end[0], at[1] - end[1]) <= HANDLES_MERGE);
    return this.quads().flatMap((quad, quadIndex) =>
      ([0, 1, 2, 3] as const)
        .filter((corner) => !isTheCut(quad[corner]))
        .map((corner) => ({
          key: `${quadIndex}:${corner}`,
          quad: quadIndex,
          corner,
          at: quad[corner],
        })),
    );
  });

  /**
   * THE ONE PAGE THE GUTTER CUTS, whether or not it has been cut yet.
   *
   * After a split there is no single quad that is the sheet -- it is the two
   * halves seen as the page they came from -- and asking one HALF where the
   * gutter goes is the mistake that put the handle at a quarter of the page and
   * halved it again on every drag. `joinedQuad` reads the segment for its
   * DIRECTION only, which is what lets it reassemble a stacked pair correctly:
   * the vertical-only reconstruction returns a convex quad of exactly half the
   * sheet's area at every cut position, so nothing downstream could have
   * noticed.
   */
  protected readonly sheet = computed(() =>
    joinedQuad(this.quads() as readonly CaptureQuad[], this.split()));

  /**
   * The gutter resolved against that sheet: both ends put back on the edges
   * they ride, and which pair of edges those are.
   *
   * RE-SEATED RATHER THAN TRUSTED. The stored segment is the gesture's own
   * state and the quads are authoritative, so dragging a corner after a split
   * leaves the endpoints floating off the crop they were drawn on. Null is a
   * segment that does not resolve to opposite edges at all, which `seatSplit`
   * cannot produce -- so it means a hand-edited file rather than anything a
   * person did here.
   */
  /**
   * THE LINE ON SCREEN, which since Wave 24 is exactly the line in the recipe.
   *
   * It used to be `split() ?? proposal()` -- a real cut, or a suggested one --
   * and the two had to be told apart everywhere downstream, including in the
   * half of the drag gesture that once forgot to. A tick that cuts leaves one
   * source of truth, so this is a re-seating of the stored segment and nothing
   * else.
   */
  protected readonly cut = computed(() => {
    const split = this.split();
    return split === null ? null : cutOf(this.sheet(), split);
  });

  /** The size each page will mint at, and whether its corners are on the photo. */
  protected readonly previews = computed(() =>
    this.quads().map((quad, index) => {
      const size = outputSizeFor(toPixels(quad, this.dimensions()));
      const longest = Math.max(size.width, size.height);
      const scale = longest > 200 ? 200 / longest : 1;
      return {
        index,
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        withinSource: quad.every(([x, y]) => x >= 0 && y >= 0 && x <= 1 && y <= 1),
      };
    }),
  );

  private rectifier: Rectifier | null = null;
  /** What the stage currently holds, as a value. See `project`. */
  private projected: string | null = null;

  constructor() {
    /*
     * ONE RECTIFIER FOR THE LIFE OF THE EDITOR, and it is disposed with the
     * component. Browsers cap live WebGL contexts and drop the oldest without
     * saying so, and this app can have an editor open beside a grid of cards
     * that also want to draw — a context per redraw would blank them in an
     * order nobody could predict. `rectify.ts` argues the same point at length.
     */
    inject(DestroyRef).onDestroy(() => {
      this.rectifier?.dispose();
      this.rectifier = null;
    });

    /*
     * WATCH THE FRAME, because which axis binds the picture is a fact about the
     * room and not about the photograph -- see turned(). A ResizeObserver and
     * not a window resize listener: the frame changes when the rail opens, when
     * the previews change height and when the window resizes, and only one of
     * those is a window event.
     */
    const watcher = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) this.frameBox.set({ width: box.width, height: box.height });
    });
    inject(DestroyRef).onDestroy(() => watcher.disconnect());
    // afterNextRender and not an effect: the frame is one element for the life
    // of this component, so there is nothing to re-observe -- and a required
    // view query read from an effect is a race with the view that creates it.
    afterNextRender(() => watcher.observe(this.frame().nativeElement));

    /*
     * Redraw whenever the quads move. It reads `previews()` and `source()`, so
     * the effect re-runs on a drag, a turn, a split, or a change of photograph
     * — and does nothing at all while the pointer is still.
     */
    effect(() => {
      const previews = this.previews();
      const quads = this.quads();
      const dimensions = this.dimensions();
      // Read unconditionally, so the effect depends on the pass and the sheet as
      // well: the stage has to be repainted when a project enters the split pass
      // and when the gutter re-seats the halves under it.
      const projecting = this.projecting();
      const sheet = this.sheet();
      void this.source();
      queueMicrotask(() => {
        this.draw(previews, quads, dimensions);
        this.project(projecting, sheet);
      });
    });
  }

  /**
   * The photograph finished decoding — draw the previews that are ITS previews.
   *
   * Called from (load), which fires on the first picture and on every change of
   * `source()` after it. Cheap to call spuriously: `draw` is a handful of
   * canvas blits and only runs at all once the element holds the picture the
   * previews are supposed to be of.
   */
  protected repaint(): void {
    this.draw(this.previews(), this.quads(), this.dimensions());
    this.project(this.projecting(), this.sheet());
  }

  /**
   * DRAW THE PAGE ON THE STAGE — the split pass's picture.
   *
   * ── The same rectifier the previews use, and that is the point ───────────
   *
   * `rectify.ts` is emphatic: browsers cap live WebGL contexts in the low tens
   * and drop the oldest silently. This window already has the light table's one
   * behind the modal; a second one for the stage would be a context per open, on
   * a surface a person walks through twenty-five times an evening. So the stage
   * borrows the editor's own, which is built lazily and disposed with the
   * component, and copies out of it at once -- the rectifier owns ONE canvas and
   * the previews overwrite it a microtask later.
   *
   * ── IT IS GUARDED BY VALUE, WHICH IS NOT AN OPTIMISATION ─────────────────
   *
   * `sheet()` is `joinedQuad(...)` and returns a fresh array every time the
   * quads or the split change identity -- so sliding the gutter, which re-seats
   * both halves on every pointermove, would otherwise re-upload a twelve
   * megapixel texture and rebuild its mipmaps once per frame while the hand is
   * moving. The sheet does not actually MOVE during a slide: the halves change
   * and their join does not. Comparing the numbers is what notices that.
   */
  private project(projecting: boolean, sheet: CaptureQuad): void {
    if (!projecting) {
      // Back in the crop pass: the canvas went with the @if, so the fade has to
      // be rearmed or the next projection would appear without one.
      this.projected = null;
      this.drawn.set(false);
      return;
    }
    const target = this.face()?.nativeElement;
    if (target === undefined) return;
    const image = this.photo().nativeElement;
    // BOTH checks, for `draw`'s measured reason: `complete` is the one that
    // refuses a STALE picture -- the previous photograph, still in the element
    // one microtask after the src changed -- and `naturalWidth` refuses a
    // broken one. A stage left holding the page you just stepped away from is
    // the worst of the three states, because it looks correct.
    if (!image.complete || image.naturalWidth === 0) {
      this.drawn.set(false);
      return;
    }

    /*
     * ROUNDED, and the rounding is the point rather than a tidy: a slid gutter
     * rebuilds the halves and `joinedQuad` puts them back together, which
     * returns the sheet it started from to within the float noise `slideSplit`
     * measures at 5.6e-17. Compared exactly, that noise would defeat the guard
     * on some frames and not others -- the worst kind of cost, because it would
     * be invisible until somebody profiled a drag. Nine places is three
     * thousandths of a pixel on a twelve-megapixel frame, which is far below
     * anything the shader could sample differently.
     */
    const key = `${image.src}|${sheet.map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)}`).join(';')}`;
    if (key === this.projected) return;

    const { width, height } = this.pageSize();
    const scale = Math.min(1, STAGE_PIXELS / Math.max(width, height));
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    this.rectifier ??= new Rectifier();
    try {
      const done = this.rectifier.rectify(
        image,
        // In the ELEMENT'S own pixels rather than the recipe's `dimensions`,
        // exactly as the cards do it: the quad is fractions of the frame, and
        // the frame in hand is whatever the decoder actually produced.
        toPixels(sheet as FractionQuad, {
          width: image.naturalWidth,
          height: image.naturalHeight,
        }),
        outWidth,
        outHeight,
      );
      target.width = outWidth;
      target.height = outHeight;
      target.getContext('2d')?.drawImage(done.canvas, 0, 0);
      this.projected = key;
      this.drawn.set(true);
    } catch {
      /*
       * Four corners that do not enclose a page — `homography` throws rather
       * than drawing a degenerate smear. The stage keeps whatever it last had
       * and stays quiet, because the surface that can fix it is the crop pass
       * and the way back to it is on the rail.
       */
    }
  }

  protected outlineOf(quad: FractionQuad): string {
    return quad.map(([x, y]) => `${x},${y}`).join(' ');
  }

  /**
   * WHAT IS UNDER THE POINTER — one hit test, for the grab AND for the cursor.
   *
   * ── Why the cursor cannot come from `:hover` ──────────────────────────────
   *
   * Every handle on this picture is `pointer-events: none`. It has to be: the
   * corner handles overhang the picture's edge, and a press on the overhanging
   * part must still be heard by the frame that owns the pointer capture — which
   * is the defect that made corners near the border ungrabbable the first time.
   * So the browser does no hit testing here at all; this method IS the hit
   * testing, and anything that wants to know what the pointer is over has to ask
   * it rather than write a `:hover` rule that will never match.
   *
   * ── Which is how the gutter came to be invisible ─────────────────────────
   *
   * `slideSplit` has been wired since Wave 21: the whole cut slides from a grab
   * ANYWHERE along its length, not merely at the two ends. Nothing said so.
   * There is no cursor rule anywhere in this component, no hover state, and only
   * the two end dots are styled as handles — so the line reads as decoration and
   * the gesture went unused. This is an affordance rather than a feature: the
   * capability was already there and had nothing pointing at it.
   *
   * ── THE ORDER IS LOAD-BEARING, AND IT USED TO BE WRONG ───────────────────
   *
   * The cut's ENDS, then corners, then the line between the ends.
   *
   * Ends before the line, because an end is ALWAYS on the line and the reverse
   * is not true — testing the line first would make the ends ungrabbable, the
   * same class of defect as the corner handles that hung over the listening
   * element.
   *
   * ENDS BEFORE CORNERS, which is the fix, and it reads backwards until you know
   * that ON A CUT PHOTOGRAPH THE ENDS *ARE* CORNERS. `halvesOf` hands each half
   * the cut's endpoints as two of its four corners, so three targets sat on
   * every knob and the corner loop answered twice before the gutter ever got
   * asked. Owen met it as three grabs to move one line, the first two of them
   * silently dragging halves apart. See `handles` for the full account.
   *
   * Nothing else is shadowed by the reorder: the only corners inside a cut end's
   * radius are the ones that are that cut end. The sheet's own four corners are
   * a page away from it, and `SLIVER_FLOOR` keeps them there.
   *
   * Sharing one body with the cursor is what keeps the affordance honest: it
   * cannot promise a grab the press would resolve differently, because it is the
   * same walk.
   */
  private under(at: FractionPoint): Under | null {
    /*
     * THE SPLIT PASS ASKS A SHORTER QUESTION, IN A DIFFERENT SPACE.
     *
     * There are no corners on that stage -- not hidden, ABSENT, which is this
     * surface's own rule -- so the walk is the cut's two ends and then the line
     * between them, in the page's unit square, against the line that is actually
     * drawn there. Ends before the line for the reason below: an end is always
     * on the line and the reverse is not.
     *
     * `from` still carries the PHOTOGRAPH-space seats, because that is what
     * `slideSplit` measures against and what the recipe stores. The pass changes
     * where the hand is, never what a cut is.
     */
    if (this.projecting()) {
      const page = this.pageCut();
      const line = this.cut();
      if (page === null || line === null) return null;
      const across = this.picture().nativeElement.offsetWidth;
      const radius = across === 0 ? 0 : 14 / across;
      for (const which of ['a', 'b'] as const) {
        const end = page[which];
        if (Math.hypot(at[0] - end[0], at[1] - end[1]) <= radius) return { what: 'end', which };
      }
      if (distanceToEdge(at, page.a, page.b) <= radius) {
        return { what: 'line', from: { a: line.a.point, b: line.b.point } };
      }
      return null;
    }

    // THE SPUN ELEMENT, NOT THE SLOT: the radius is in the photograph's own
    // fraction space, and a rotation preserves lengths -- so the photograph's
    // on-screen x extent is the width it was LAID OUT at, whichever way round
    // it now sits. Measuring the slot would make the hit radius wrong by the
    // aspect ratio on every turned photograph.
    const width = this.spun().nativeElement.offsetWidth;
    // The hit radius is in PIXELS on screen and converted, so the handle is the
    // same size to the hand whatever the picture has been scaled to.
    const radius = width === 0 ? 0 : 14 / width;

    /*
     * THE LINE THAT IS DRAWN IS THE LINE THAT CAN BE GRABBED, and asking
     * `cut()` rather than `split()` is the whole of that sentence.
     *
     * Owen: *"i couldnt grab the knobs to move the split - it didnt do
     * anything when i click/dragged the knob"*. The knobs were there, seeded by
     * a proposal, and the press used to refuse anything `split()` did not
     * answer for -- so the half of the gesture that MOVES the cut understood
     * proposals and the half that STARTS it did not, and a gesture is only as
     * wired as its first half. The proposal is retired and the lesson is not:
     * one question, asked once, for both halves.
     */
    const line = this.cut();

    if (line !== null) {
      for (const which of ['a', 'b'] as const) {
        const point = line[which].point;
        if (Math.hypot(at[0] - point[0], at[1] - point[1]) <= radius) return { what: 'end', which };
      }
    }

    const quads = this.quads();
    for (let index = 0; index < quads.length; index += 1) {
      const corner = cornerNear(toPixels(quads[index]!, UNIT), [at[0], at[1]], radius);
      if (corner !== null) return { what: 'corner', quad: index, corner };
    }

    if (line === null) return null;

    /*
     * SLIDING THE WHOLE CUT, which is the common gesture and would otherwise
     * have been lost: a straight gutter on a square-on spread wants to move
     * sideways, and making somebody drag two handles to do it once per
     * photograph is fifty-four extra gestures on this shoot.
     *
     * Hit against THE LINE THAT IS DRAWN. The old test measured the pointer's
     * distance from a vertical line at a fraction of the frame, which was true
     * only while the quad was upright -- and every photograph of the 1876
     * volume is turned a quarter before anything else happens to it.
     */
    if (distanceToEdge(at, line.a.point, line.b.point) <= radius) {
      return { what: 'line', from: { a: line.a.point, b: line.b.point } };
    }
    return null;
  }

  protected grab(event: PointerEvent): void {
    const at = this.stageOf(event);
    const found = this.under(at);
    if (found === null) return;
    if (found.what === 'corner') {
      this.held.set({ quad: found.quad, corner: found.corner });
    } else if (found.what === 'end') {
      this.holdingSplit.set(found.which);
    } else {
      this.holdingSplit.set('line');
      /*
       * THE ORIGIN IS THE SEATED SEGMENT, NOT THE STORED ONE.
       *
       * The stored endpoints are gesture state and go stale against a crop
       * dragged after the split -- that is the whole reason the line is drawn
       * from cutOf rather than from the file. Sliding FROM the stale points
       * would measure the offset from somewhere the gutter is not, so the cut
       * would jump the instant the pointer moved and then track correctly from
       * the wrong place. The seated points are where the line actually is,
       * which is where a slide has to start.
       */
      this.slidFrom = { at: this.photoOf(at), split: found.from };
    }
    this.frame().nativeElement.setPointerCapture(event.pointerId);
  }

  protected drag(event: PointerEvent): void {
    const holding = this.held();
    const gutter = this.holdingSplit();
    if (holding === null && gutter === null) {
      /*
       * NOTHING IS HELD, SO THE ONLY THING TO DO IS SAY WHAT COULD BE.
       *
       * On the same handler as the drag rather than a second `pointermove`
       * listener: two listeners on one element for one pointer is two things
       * that can disagree about where it is, and this component has already paid
       * for that shape once in the two halves of the split gesture.
       */
      this.over.set(this.under(this.stageOf(event))?.what ?? null);
      return;
    }
    /*
     * THE GESTURE'S ARITHMETIC IS ALWAYS THE PHOTOGRAPH'S, whichever stage the
     * hand is on. `seatSplit` and `slideSplit` cut the SHEET, and the sheet is
     * four fractions of a photograph -- so the split pass crosses back here,
     * once, and every line below it is the code the crop pass has always run.
     */
    const at = this.photoOf(this.stageOf(event));

    if (gutter !== null) {
      const split = this.split();
      if (split === null) return;
      const sheet = this.sheet();
      // One destination since the proposal retired: every gutter on this
      // picture is a cut the recipe already holds, so moving one is a save.
      const moved = this.splitChange;

      if (gutter === 'line') {
        /*
         * THE WHOLE CUT MOVES AS ONE ACT, THROUGH ONE FUNCTION.
         *
         * This used to carry each end by the offset and hand each to
         * `seatSplit` in turn. Both calls were individually correct and the
         * composition was not: each clamps the end it moves against THE
         * PARTNER AS IT STANDS, and in the second call the partner is the end
         * the first already moved -- so each believed a partner that was no
         * longer where its floor had been computed for, and the pair walked
         * past a limit neither call thought it was crossing.
         *
         * Measured through the shipped chord: the smaller half reached 0.28%
         * of the sheet on a skewed quad, a seventh of the floor, and past a
         * point both ends landed on corners of one edge and halvesOf refused
         * the segment outright. So the gesture could produce a state the
         * validator rejects -- the draws-fine-refuses-to-save class, which is
         * exactly what putting the seating in shared/ was supposed to make
         * impossible.
         *
         * `slideSplit` fixes the edges before anything moves and applies the
         * floor and the edge-riding rule as ONE predicate to the pair, so the
         * slide stops where the first of them binds. The lesson is the one
         * this feature keeps paying for: an invariant enforced once is a rule,
         * and an invariant enforced twice is two rules that agree until they
         * do not.
         */
        const from = this.slidFrom;
        if (from === null) return;
        moved.emit(
          slideSplit(sheet, from.split, [at[0] - from.at[0], at[1] - from.at[1]]),
        );
        return;
      }

      moved.emit(seatSplit(sheet, split, gutter, [at[0], at[1]]));
      return;
    }

    // Clamped HERE and nowhere else, because this is the only place a corner is
    // invented: `rotate` permutes the tuple and `halvesOf` cuts between corners
    // that are already inside, so neither can carry a quad back out of range.
    const inside: FractionPoint = [clamp(at[0]), clamp(at[1])];
    const quads = this.quads();
    const moved = quads.map((quad, index) =>
      index === holding!.quad ? withCorner(quad, holding!.corner, inside) : quad,
    );
    this.quadsChange.emit(moved);
  }

  protected release(event: PointerEvent): void {
    if (this.held() === null && this.holdingSplit() === null) return;
    this.held.set(null);
    this.holdingSplit.set(null);
    this.slidFrom = null;
    // The hand is still where it let go, so what it is over is still true --
    // but nothing will say so until the pointer moves again, and a cursor that
    // reverted to the default on release would read as the handle vanishing
    // under a hand that had not moved.
    this.over.set(this.under(this.stageOf(event))?.what ?? null);
    // Asked of the FRAME, which is what took the capture. Asking the picture
    // would be asking an element that never holds one, so the release below
    // would never run and the next press would arrive already captured.
    if (this.frame().nativeElement.hasPointerCapture(event.pointerId)) {
      this.frame().nativeElement.releasePointerCapture(event.pointerId);
    }
  }

  /**
   * A pointer event's position in THE STAGE'S OWN SPACE.
   *
   * Which is the photograph's fractions in the crop pass and the PAGE's unit
   * square in the split pass, because the split pass draws the page. `photoOf`
   * below is the one crossing between them, and it is deliberately a second call
   * rather than folded in here: the hit test wants the space the picture is
   * drawn in, and the geometry wants the space the recipe is stored in, and
   * collapsing the two is how a gesture comes to be measured against a picture
   * it is not on.
   */
  private stageOf(event: PointerEvent): FractionPoint {
    const box = this.picture().nativeElement.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return [0, 0];
    const u = (event.clientX - box.left) / box.width;
    const v = (event.clientY - box.top) / box.height;
    /*
     * THE RECTIFIED PAGE IS ALREADY THE WAY ROUND IT PRINTS, so there is no
     * turn to undo: the corner order IS the orientation and the shader has
     * already spent it. The slot's u and v are the page's own.
     */
    if (this.projecting()) return [u, v];
    /*
     * TURNED BACK, because the slot is the axis-aligned box on screen and the
     * quads live in the photograph's own space -- the same space only at turn
     * 0. A quarter turn clockwise puts the photograph's top-left at the slot's
     * top-right, so the inverse reads the slot's y for the photograph's x.
     *
     * Without it every handle would be where it LOOKS and nowhere it is
     * grabbed, on turned photographs only: invisible until somebody turns a
     * spread, and unusable from then on.
     */
    switch (this.turned().turns) {
      case 1: return [v, 1 - u];
      case 2: return [1 - u, 1 - v];
      case 3: return [1 - v, u];
      default: return [u, v];
    }
  }

  /**
   * A STAGE POINT BACK ON THE PHOTOGRAPH — the identity in the crop pass.
   *
   * The recipe stores fractions of the working copy and nothing else does, so
   * every gesture crosses here before it becomes geometry. A degenerate sheet
   * (four corners that enclose no page) has no map, and the honest answer then
   * is the point unchanged: the split pass cannot be entered on such a
   * photograph anyway, and inventing a coordinate would move a gutter somewhere
   * nobody pointed.
   */
  private photoOf(at: FractionPoint): FractionPoint {
    if (!this.projecting()) return at;
    return this.pageMap()?.toPhoto(at) ?? at;
  }

  /**
   * Draw the previews.
   *
   * The image element is reused as the texture source rather than decoding the
   * working copy a second time: it is already in the page, already decoded, and
   * `Rectifier` takes an `HTMLImageElement` for exactly this reason.
   *
   * ── THE SENTENCE THAT USED TO BE HERE WAS FALSE, AND IT COST A DEFECT ─────
   *
   * It read: "A picture that has not finished loading has no dimensions yet and
   * is skipped — the effect will run again when the quads next move, and the
   * load itself is what puts the photograph on screen." Owen: *"turning the
   * book worked on the first one but didnt work on the next one. the thumbnail
   * turned but the main image didnt"*.
   *
   * Both clauses were wrong, and measuring the element rather than reasoning
   * about it is what showed it. Across a change of `src`, one <img> reports
   * THREE states, not two:
   *
   *   synchronously after src is set   naturalWidth 480   complete FALSE
   *                                    — still the PREVIOUS photograph's number
   *   by the next task                 naturalWidth 0     complete false
   *   after the load event             naturalWidth 480   complete true
   *
   * The effect draws in a MICROTASK, which lands in the first row. So this
   * method was never skipped at all: it rectified the photograph that was still
   * in the element into the previews of the page that had just replaced it, and
   * the person saw the picture they had just stepped away from.
   *
   * `naturalWidth` is not a question about the src that was just assigned. It
   * is a question about the picture currently in the element, and for one whole
   * microtask checkpoint those are two different pictures.
   *
   * ── SO THE REDRAW HAS TWO HALVES AND BOTH ARE REQUIRED ─────────────────
   *
   * `complete` is the half that REFUSES the stale draw — it goes false the
   * instant the src is assigned, which is the only signal in the first row that
   * tells the truth. `(load)` on the element is the half that SUPPLIES the
   * missing one, because a load is an EVENT and an effect cannot depend on it;
   * modelling it as state is the mistake the per-visit turn counter already
   * made once in this cluster.
   */
  private draw(
    previews: readonly { index: number; width: number; height: number }[],
    quads: readonly FractionQuad[],
    dimensions: Dimensions,
  ): void {
    const image = this.photo().nativeElement;
    // BOTH, and the order is not the interesting part -- see the docblock. The
    // complete check is the one that refuses a STALE picture; the naturalWidth
    // check is the one that refuses a BROKEN one.
    if (!image.complete || image.naturalWidth === 0) return;

    this.rectifier ??= new Rectifier();
    const canvases = this.previewCanvases();

    for (const preview of previews) {
      const quad = quads[preview.index];
      if (quad === undefined) continue;
      const target = canvases[preview.index]?.nativeElement;
      if (target === undefined) continue;

      const drawn = this.rectifier.rectify(
        image,
        toPixels(quad, dimensions),
        preview.width,
        preview.height,
      );
      const context = target.getContext('2d');
      // The rectifier owns ONE canvas and the next page overwrites it, so each
      // preview is copied out before the next is drawn.
      context?.drawImage(drawn.canvas, 0, 0);
    }
  }
}

/** The unit box, for turning fractions into "pixels" of a 1x1 picture. */
const UNIT: Dimensions = { width: 1, height: 1 };

/**
 * HOW MANY PIXELS THE SPLIT PASS'S STAGE DRAWS, on its longest edge.
 *
 * The modal is nearly the whole window and the stage is most of the modal, so
 * this is a comfortable two-times for a large retina pane and stops there. It is
 * also the ceiling that keeps the redraw affordable while somebody walks the
 * book: the source is a full-resolution working copy, and asking for more than
 * the pane can show is cost with nothing on the other side of it.
 */
const STAGE_PIXELS = 1600;

/**
 * THE PAGE AND THE PHOTOGRAPH, EACH IN THE OTHER'S TERMS.
 *
 * `toPhoto` takes the page's unit square onto the sheet, which is exactly the
 * map the shader runs; `toPage` is its inverse. Points only — there is no matrix
 * out here for anyone to hold, because the only two questions this surface asks
 * are "where did the hand land on the photograph" and "where does the gutter
 * fall on the page".
 */
interface PageMap {
  toPhoto(at: FractionPoint): FractionPoint;
  toPage(at: FractionPoint): FractionPoint;
}

/**
 * The projective map for a sheet, or null when the four corners enclose no page.
 *
 * ── This is the SHADER'S transform, written a second time, said out loud ────
 *
 * `rectify.ts` builds the same closed form (Heckbert §2.2 — the unit-square case
 * of the four-point fit, which is the one case with an exact solution) and hands
 * it to WebGL as a column-major `mat3`. It is private there, and deliberately:
 * that file's whole argument is that the preview and the mint must be ONE
 * shader, and exporting a matrix would invite a second drawing path.
 *
 * What is needed here is not a drawing path. It is the same correspondence asked
 * about ONE POINT AT A TIME, in both directions, on the CPU, so a pointer can be
 * turned into a gutter and a gutter into a line on the stage. The alternative is
 * to fake it from the seat's `at` — the fraction along the sheet's edge — and
 * that is wrong by exactly the amount of keystone in the shot, which is to say
 * wrong on every photograph of a book held under a phone.
 *
 * SO THE DUPLICATION IS NAMED RATHER THAN HIDDEN. If a third caller ever wants
 * it, the lift is to `geometry.ts` — where every other rule about what a corner
 * MEANS already lives — and this becomes an import. It is left here for now
 * because W25-P3's fence is the editor, and a shared file grown by a package
 * that only needed it once is how shared files fill up with one-offs.
 *
 * ── The corners are the recipe's pinned order ──────────────────────────────
 *
 * top-left, top-right, bottom-right, bottom-left OF THE OUTPUT PAGE, which is
 * (0,0), (1,0), (1,1), (0,1) of the page's unit square in that order. So a
 * turned photograph needs no special case anywhere in here: the turn is already
 * in the order, and rectifying spends it.
 */
function pageMapFor(quad: CaptureQuad): PageMap | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  let a: number;
  let b: number;
  let d: number;
  let e: number;
  let g: number;
  let h: number;

  if (dx3 === 0 && dy3 === 0) {
    // A parallelogram — a straight-on shot, or a pure crop. The projective terms
    // are exactly zero rather than nearly zero, so the map is affine and its
    // inverse is exact: a page with no keystone gets none back.
    a = x1 - x0;
    b = x2 - x1;
    d = y1 - y0;
    e = y2 - y1;
    g = 0;
    h = 0;
  } else {
    const denominator = dx1 * dy2 - dx2 * dy1;
    // Three corners collinear, or two coincident. `rectify` throws here; this
    // returns null, because a hit test has somewhere sensible to go (nowhere)
    // and a draw does not.
    if (denominator === 0) return null;
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
  }

  /*
   * M = [ a  b  x0 ]   taking (u, v, 1) on the page to (x, y, w) on the
   *     [ d  e  y0 ]   photograph, with the divide by w being the whole of
   *     [ g  h   1 ]   what makes it projective rather than affine.
   *
   * The inverse is the ADJUGATE over the determinant, which for a 3x3 is nine
   * cofactors and no iteration — the same reason the forward form is closed:
   * a solver here would leave a fraction of a per cent of skew in a page that
   * has none, and a handle that drifts while the hand holds still is worse than
   * one that is slightly in the wrong place.
   */
  const A = e - y0 * h;
  const B = -(b - x0 * h);
  const C = b * y0 - x0 * e;
  const D = -(d - y0 * g);
  const E = a - x0 * g;
  const F = -(a * y0 - x0 * d);
  const G = d * h - e * g;
  const H = -(a * h - b * g);
  const I = a * e - b * d;
  const determinant = a * A + b * D + x0 * G;
  if (determinant === 0) return null;

  return {
    toPhoto([u, v]: FractionPoint): FractionPoint {
      const w = g * u + h * v + 1;
      if (w === 0) return [u, v];
      return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w];
    },
    toPage([x, y]: FractionPoint): FractionPoint {
      const w = G * x + H * y + I;
      if (w === 0) return [x, y];
      return [(A * x + B * y + C) / w, (D * x + E * y + F) / w];
    },
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * How near a crop corner must be to a cut's end before it IS that end.
 *
 * In the photograph's own fraction space, so it scales with the picture. One
 * per cent is about 8px on an 800px-wide picture -- comfortably inside the 14px
 * grab radius, so a corner this rule hides was never separately grabbable
 * anyway, and comfortably above the float noise of re-seating (measured at
 * 5.6e-17 in `slideSplit`'s own note), so two points that ARE one point always
 * merge.
 *
 * It has to stay under the grab radius. Above it, this would hide a handle that
 * the pointer could still reach -- a control that is invisible and live, which
 * is worse than the stacked handles it replaced.
 */
const HANDLES_MERGE = 0.01;

/**
 * WHAT THE POINTER FOUND — a corner of some page, an end of the cut, or the cut
 * itself.
 *
 * A discriminated union rather than three nullable answers, because the three
 * are EXCLUSIVE and ORDERED: a point near an end of the cut is also near the
 * cut, and the walk that finds it has already decided which one wins. Three
 * separate results would let a caller take both and re-decide, which is how the
 * press and the drag came to disagree about the same pointer the first time.
 *
 * `line` carries the SEATED segment it was found against, so the slide starts
 * from where the line actually is rather than from the stored endpoints, which
 * go stale against a crop dragged after the cut. Handing it back with the answer
 * means the caller cannot forget to re-seat.
 */
type Under =
  | { what: 'corner'; quad: number; corner: 0 | 1 | 2 | 3 }
  | { what: 'end'; which: 'a' | 'b' }
  | { what: 'line'; from: CaptureSplit };

/*
 * THE OFF-THE-ENDS CLAMP WENT WITH THE FRACTION, and the hazard it guarded is
 * now somebody else's to name.
 *
 * It kept a gutter 2% from either end, so a split could never make a page of no
 * width. `seatSplit` deliberately does not do that -- P1's words, and they are
 * right: an end reaching a corner is a legal cut and a bad one, and a floor on
 * it is a question about the gesture rather than about the geometry. Rewriting
 * it here would have meant a clamp on one end at a time, which cannot express
 * "leave a page on each side" for a cut that leans.
 *
 * So a sliver is currently draggable. Said out loud rather than left as a
 * silent regression: the page it makes is visibly wrong in the preview beside
 * the picture, which is the surface that would tell somebody, and the two
 * halves both still mint.
 */

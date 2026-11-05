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
} from '@owen/foundry-core/browser/geometry';
import {
  cutOf, joinedQuad, outputSizeFor, seatSplit, slideSplit, turnsOf, WHOLE_FRAME,
} from '@owen/foundry-core/shared/capture';
import type { CaptureQuad, CaptureSplit } from '@owen/foundry-core/shared/types';

import { Rectifier } from '@owen/foundry-core/browser/rectify';
import { clamp, Under } from './capture-page-editor.map';
import * as pointer from './capture-page-editor.pointer';
import * as paint from './capture-page-editor.paint';
import * as frames from './capture-page-editor.frames';

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
  templateUrl: './capture-page-editor.component.html',
  styleUrl: './capture-page-editor.component.scss',
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
   * THE HAND LET GO, AND SOMETHING MOVED — the end of one gesture.
   *
   * ── Why the parent cannot work this out for itself ────────────────────────
   *
   * `quadsChange` and `splitChange` fire on every pointermove, which is right:
   * the recipe is the thing on screen and a drag that only landed at the end
   * would draw against a stale one. What no caller can see from those emits is
   * where the gesture STOPPED — and Wave 51 needs exactly that, because a crop
   * moved with *Global* ticked hands itself to the whole book, and doing that
   * per pointermove would be twenty-five photographs re-cut sixty times a
   * second. Once, when the hand opens.
   *
   * ── IT ONLY FIRES IF SOMETHING ACTUALLY MOVED ────────────────────────────
   *
   * A press and a release on a handle with no travel between them is not a
   * gesture, and the propagation it would trigger writes the recipe (and marks
   * the project changed) for a hand that did nothing. So the emits are counted
   * rather than the presses: `moved` is set where a change is emitted and read
   * where the pointer is released.
   */
  readonly settled = output<void>();

  /** Whether this drag has emitted anything yet. See `settled`. */
  moved = false;

  /**
   * The listening surface. Capture is set here rather than on the picture
   * because a pointer is captured by the element that HEARD the press, and a
   * press on a handle overhanging the edge is heard by this one.
   */
  readonly frame = viewChild.required<ElementRef<HTMLElement>>('frame');
  readonly picture = viewChild.required<ElementRef<HTMLElement>>('picture');
  /** The element that carries the turn -- see turned() and fractionOf(). */
  readonly spun = viewChild.required<ElementRef<HTMLElement>>('spun');
  readonly photo = viewChild.required<ElementRef<HTMLImageElement>>('photo');
  /*
   * The preview canvases, in template order — which is `previews()` order,
   * because they are that list's `@for`. Asked for as a view query rather than
   * found with `querySelector` on a data attribute: the query is checked at
   * compile time and cannot go stale against a selector somebody renamed.
   */
  readonly previewCanvases = viewChildren<ElementRef<HTMLCanvasElement>>('previewCanvas');
  /**
   * The split pass's stage canvas. Optional, because it exists only in that
   * pass — a required query would throw the moment somebody reopened the crops.
   */
  readonly face = viewChild<ElementRef<HTMLCanvasElement>>('face');
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
  slidFrom: { at: FractionPoint; split: CaptureSplit } | null = null;

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

  protected readonly pageMap = frames.pageMap.call(this);

  protected readonly pageCut = frames.pageCut.call(this);

  private readonly frameBox = frames.frameBox.call(this);

  protected readonly handles = frames.handles.call(this);

  protected readonly sheet = frames.sheet.call(this);

  protected readonly cut = frames.cut.call(this);

  protected readonly previews = frames.previews.call(this);

  rectifier: Rectifier | null = null;

  projected: string | null = frames.projected.call(this);

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

  protected repaint(): void { return paint.repaint.call(this); }

  project(projecting: boolean, sheet: CaptureQuad): void { return paint.project.call(this, projecting, sheet); }

  protected outlineOf(quad: FractionQuad): string { return paint.outlineOf.call(this, quad); }

  under(at: FractionPoint): Under | null { return pointer.under.call(this, at); }

  protected grab(event: PointerEvent): void { return pointer.grab.call(this, event); }

  protected drag(event: PointerEvent): void { return pointer.drag.call(this, event); }

  protected release(event: PointerEvent): void { return pointer.release.call(this, event); }

  stageOf(event: PointerEvent): FractionPoint { return pointer.stageOf.call(this, event); }

  photoOf(at: FractionPoint): FractionPoint { return pointer.photoOf.call(this, at); }

  draw(previews: readonly { index: number; width: number; height: number }[], quads: readonly FractionQuad[], dimensions: Dimensions): void { return paint.draw.call(this, previews, quads, dimensions); }
}

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

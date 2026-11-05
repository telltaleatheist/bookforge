/**
 * capture-page-editor.pointer — what is under the pointer, and grabbing, dragging and releasing it.
 */
import { computed } from '@angular/core';
import { type FractionPoint, cornerNear, distanceToEdge, toPixels, withCorner } from '@owen/foundry-core/browser/geometry';
import { cutOf, seatSplit, slideSplit } from '@owen/foundry-core/shared/capture';
import { UNIT, clamp, Under } from './capture-page-editor.map';
import type { CapturePageEditorComponent } from './capture-page-editor.component';

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
export function under(this: CapturePageEditorComponent, at: FractionPoint): Under | null {
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

export function grab(this: CapturePageEditorComponent, event: PointerEvent): void {
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

export function drag(this: CapturePageEditorComponent, event: PointerEvent): void {
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
      this.moved = true;
      moved.emit(
        slideSplit(sheet, from.split, [at[0] - from.at[0], at[1] - from.at[1]]),
      );
      return;
    }

    this.moved = true;
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
  this.moved = true;
  this.quadsChange.emit(moved);
}

export function release(this: CapturePageEditorComponent, event: PointerEvent): void {
  if (this.held() === null && this.holdingSplit() === null) return;
  this.held.set(null);
  this.holdingSplit.set(null);
  this.slidFrom = null;
  // Read and cleared together, so a release can only ever announce the drag
  // it ended -- see `settled`.
  const travelled = this.moved;
  this.moved = false;
  if (travelled) this.settled.emit();
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
export function stageOf(this: CapturePageEditorComponent, event: PointerEvent): FractionPoint {
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
export function photoOf(this: CapturePageEditorComponent, at: FractionPoint): FractionPoint {
  if (!this.projecting()) return at;
  return this.pageMap()?.toPhoto(at) ?? at;
}

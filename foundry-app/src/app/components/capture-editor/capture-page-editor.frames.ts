/**
 * capture-page-editor.frames — the geometry on screen, derived: the page map, the frame, the handles, the sheet and the cut.
 */
import { computed, signal } from '@angular/core';
import { type FractionPoint, toPixels } from '@owen/foundry-core/browser/geometry';
import { cutOf, joinedQuad, outputSizeFor, seatSplit } from '@owen/foundry-core/shared/capture';
import type { CaptureQuad } from '@owen/foundry-core/shared/types';
import { pageMapFor, HANDLES_MERGE } from './capture-page-editor.map';
import type { CapturePageEditorComponent } from './capture-page-editor.component';

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
export function pageMap(this: CapturePageEditorComponent) {
  return computed(() => pageMapFor(this.sheet()));
}

/**
 * THE CUT IN THE PAGE'S OWN SPACE — the split pass's line, drawn and grabbed.
 *
 * The two ENDS are mapped and the segment between them is drawn straight,
 * which is exact rather than an approximation: a projective map takes lines to
 * lines, so the gutter is as straight on the rectified page as it was on the
 * photograph.
 */
export function pageCut(this: CapturePageEditorComponent) {
  return computed<{ a: FractionPoint; b: FractionPoint } | null>(() => {
  const line = this.cut();
  const map = this.pageMap();
  if (line === null || map === null) return null;
  return {
    a: map.toPage(line.a.point as FractionPoint),
    b: map.toPage(line.b.point as FractionPoint),
  };
});
}

/**
 * The frame's CONTENT box, watched.
 *
 * contentRect and not getBoundingClientRect, because the frame carries 12px
 * of padding to keep the handles off the clip, and the question here is how
 * much room the picture actually has.
 */
export function frameBox(this: CapturePageEditorComponent) {
  return signal<{ width: number; height: number }>({ width: 0, height: 0 });
}

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
export function handles(this: CapturePageEditorComponent) {
  return computed(() => {
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
}

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
export function sheet(this: CapturePageEditorComponent) {
  return computed(() =>
  joinedQuad(this.quads() as readonly CaptureQuad[], this.split()));
}

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
export function cut(this: CapturePageEditorComponent) {
  return computed(() => {
  const split = this.split();
  return split === null ? null : cutOf(this.sheet(), split);
});
}

/** The size each page will mint at, and whether its corners are on the photo. */
export function previews(this: CapturePageEditorComponent) {
  return computed(() =>
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
}

/** What the stage currently holds, as a value. See `project`. */
export function projected(this: CapturePageEditorComponent) {
  return null;
}

/**
 * capture-page-editor.map — how a photograph maps onto the stage: constants, and the map itself.
 */
import { type Dimensions, type FractionPoint } from '@owen/foundry-core/browser/geometry';
import { slideSplit } from '@owen/foundry-core/shared/capture';
import type { CaptureQuad, CaptureSplit } from '@owen/foundry-core/shared/types';

/** The unit box, for turning fractions into "pixels" of a 1x1 picture. */
export const UNIT: Dimensions = { width: 1, height: 1 };

/**
 * HOW MANY PIXELS THE SPLIT PASS'S STAGE DRAWS, on its longest edge.
 *
 * The modal is nearly the whole window and the stage is most of the modal, so
 * this is a comfortable two-times for a large retina pane and stops there. It is
 * also the ceiling that keeps the redraw affordable while somebody walks the
 * book: the source is a full-resolution working copy, and asking for more than
 * the pane can show is cost with nothing on the other side of it.
 */
export const STAGE_PIXELS = 1600;

/**
 * THE PAGE AND THE PHOTOGRAPH, EACH IN THE OTHER'S TERMS.
 *
 * `toPhoto` takes the page's unit square onto the sheet, which is exactly the
 * map the shader runs; `toPage` is its inverse. Points only — there is no matrix
 * out here for anyone to hold, because the only two questions this surface asks
 * are "where did the hand land on the photograph" and "where does the gutter
 * fall on the page".
 */
export interface PageMap {
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
export function pageMapFor(quad: CaptureQuad): PageMap | null {
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

export function clamp(value: number): number {
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
export const HANDLES_MERGE = 0.01;

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
export type Under =
  | { what: 'corner'; quad: number; corner: 0 | 1 | 2 | 3 }
  | { what: 'end'; which: 'a' | 'b' }
  | { what: 'line'; from: CaptureSplit };

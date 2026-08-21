/**
 * The light table's geometry — every rule about corners, in one place.
 *
 * ── Why these are functions and not methods on a component ──────────────────
 *
 * The grid, the page editor and the mint driver all ask the same questions
 * about the same four points: where is this quad on the working copy, what does
 * a quarter turn do to it, where does the split line cut it, and may this quad
 * be copied onto that photograph. Answered in three components those become
 * three spellings, and the one that drifts is discovered by a person looking at
 * a crooked page in a minted PDF.
 *
 * Pure, over plain numbers, importing nothing: the same reasoning `shared/
 * stages.ts` gives for its predicates, applied one stage upstream.
 *
 * ── The two coordinate systems, and why they have different names ───────────
 *
 * The recipe stores FRACTIONS of the working copy (docs/CAPTURE.md, settled on
 * the feature channel 2026-08-19 after the shoot turned out to hold two shapes).
 * The rectify shader and every mouse event work in PIXELS. Both are four pairs
 * of numbers and TypeScript cannot tell them apart, which is precisely this
 * project's recurring defect — two things sharing a name — so they are named
 * apart here and every crossing between them goes through `toPixels` or
 * `toFractions`. If a quad in this codebase was not produced by one of those two
 * functions, it is in whatever unit its author was thinking in.
 *
 * ── The rotation lives in the corner order, and nowhere else ────────────────
 *
 * The recipe has no rotation field, on purpose: "the corner assignment IS the
 * orientation" (docs/CAPTURE.md, Conventions). A quarter turn is a permutation
 * of the tuple, which is why `rotate` below returns a quad rather than an angle,
 * and why nothing downstream of it has to remember that a turn happened.
 */

import type { Point, Quad } from './rectify';

/**
 * Four corners in PIXELS on the working copy — what the shader and the pointer
 * both speak. Re-exported from the rectify so there is one definition of the
 * tuple's order (top-left, top-right, bottom-right, bottom-left of the output).
 */
export type PixelQuad = Quad;
export type PixelPoint = Point;

/** A point as FRACTIONS of the working copy's width and height. */
export type FractionPoint = readonly [number, number];

/**
 * Four corners as FRACTIONS — the recipe's own unit.
 *
 * Fractions rather than pixels because the shoot holds more than one image size
 * and the recipe has to survive being read against a working copy that was
 * re-decoded at another scale. What fractions do NOT buy is safety in
 * "apply to all": see `sameShape`.
 */
export type FractionQuad = readonly [FractionPoint, FractionPoint, FractionPoint, FractionPoint];

/** The pixel dimensions of a working copy, as the DECODER reported them. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/** Fractions onto a working copy of these dimensions. */
export function toPixels(quad: FractionQuad, of: Dimensions): PixelQuad {
  return [
    [quad[0][0] * of.width, quad[0][1] * of.height],
    [quad[1][0] * of.width, quad[1][1] * of.height],
    [quad[2][0] * of.width, quad[2][1] * of.height],
    [quad[3][0] * of.width, quad[3][1] * of.height],
  ];
}

/** Pixels on a working copy of these dimensions, back to fractions. */
export function toFractions(quad: PixelQuad, of: Dimensions): FractionQuad {
  if (of.width === 0 || of.height === 0) {
    throw new Error('A working copy with no dimensions has no fractions to take.');
  }
  return [
    [quad[0][0] / of.width, quad[0][1] / of.height],
    [quad[1][0] / of.width, quad[1][1] / of.height],
    [quad[2][0] / of.width, quad[2][1] / of.height],
    [quad[3][0] / of.width, quad[3][1] / of.height],
  ];
}

/**
 * The same page, turned a quarter of the way round, `turns` times clockwise.
 *
 * ── ONE BODY, AND THE SHORT NAME THE RENDERER READS BETTER WITH ─────────────
 *
 * This was four lines of its own until main needed the same permutation to put
 * a stamped crop into its target's orientation, at which point there were two
 * copies of the sentence "a turn is a rotation of the tuple by one" -- and two
 * copies of a rule are two answers as soon as one of them is edited. The body
 * lives in `shared/capture.ts` beside the split geometry, for the reason that
 * file already gives at length: main and the renderer both need it.
 *
 * The alias stays because `rotate(quad, 1)` is what this file's callers read
 * as, and renaming forty call sites to prove a point about provenance is a
 * worse trade than one line of re-export.
 *
 * WHAT IT IS, unchanged and still worth knowing here: turn the page clockwise
 * and the corner that WAS at the bottom-left is the one now at the top-left;
 * each corner moves one place along the tuple. So a turn is a rotation of the
 * array by one, four turns are the identity EXACTLY with no floating-point
 * drift, and negative turns are anticlockwise.
 */
export { turnQuad as rotate } from '@shared/capture';

/*
 * THE WHOLE FRAME AND THE SPLIT GEOMETRY USED TO BE HERE and are not any more.
 *
 * `wholeFrame()` was the renderer's third spelling of the uncropped page --
 * intake had one and the mint needed one -- and it went to `WHOLE_FRAME` in
 * shared/capture.ts with the rest.
 *
 * `joined`, `splitAt` and `alongQuad` went the same way, as `joinedQuad`,
 * `halvesOf` and `cutOf`, when Wave 21 turned the split from a fraction into a
 * segment. They had to: MAIN needs the chord to migrate every recipe written
 * before the segment existed, and main cannot import the renderer's files. So
 * the alternative to moving them was two bodies of a cut, and the way that
 * would have been discovered is a wrong half of a page in a minted PDF.
 *
 * `joined` was also WRONG for a cut that runs across the page rather than down
 * it, and wrong in the way that hides: the sheet it reassembled was convex,
 * plausible, and exactly half the real area at every cut position, so neither a
 * self-intersection test nor an area test could have caught it. Its replacement
 * reads the segment for its direction, which is the one thing about a stale
 * segment that does not go stale.
 *
 * Fourth application of one ruling, and the first one applied at design time
 * rather than after the two copies had been found disagreeing.
 */

/** How far a point is from a line SEGMENT — the split handle's hit test. */
export function distanceToEdge(point: FractionPoint, from: FractionPoint, to: FractionPoint): number {
  const run: FractionPoint = [to[0] - from[0], to[1] - from[1]];
  const span = run[0] * run[0] + run[1] * run[1];
  const at = span === 0
    ? 0
    : Math.min(1, Math.max(0, ((point[0] - from[0]) * run[0] + (point[1] - from[1]) * run[1]) / span));
  return Math.hypot(point[0] - (from[0] + run[0] * at), point[1] - (from[1] + run[1] * at));
}

/**
 * How different two working copies' shapes may be and still count as the same
 * shape — two percent of the aspect ratio, pinned in docs/CAPTURE.md at c07f837.
 *
 * The number is the doc's, not this file's: loose enough that a camera
 * reporting 4032x3024 and 4030x3022 is one shape;
 * far tighter than the gap the real shoot contains (0.75 against 1.3333).
 */

/*
 * THE SAME-SHAPE PREDICATE USED TO BE HERE and is not any more.
 *
 * It moved to `shared/capture.ts` beside `outputSizeFor`, imported by both
 * sides of the bridge, because `electron/capture.ts` had grown its own
 * `mayInherit` saying the same thing in a different arrangement of the same
 * algebra. Raised on the read-back of Merge 2 (channel seq 46) and ruled at 47:
 * the second application of the ruling that moved `outputSizeFor`, and the
 * first time we caught the duplication BEFORE the two copies disagreed rather
 * than after. The tolerance lives there too, so this file no longer spells 0.02.
 */

/*
 * THE OUTPUT-SIZE RULE USED TO BE COPIED HERE and is not any more.
 *
 * "Output page size = the quad's opposite-edge maxima" had two implementations
 * for as long as the editor needed a preview size and main needed `outWidth`.
 * Raised on the feature channel at seq 25 with the formula written out to diff
 * against, ruled at seq 26, and `outputSizeFor` now lives in
 * `shared/capture.ts` where both sides import it. The two copies agreed to the
 * pixel when this one was deleted — which is the point: they agreed until they
 * did not, and nothing would have said when.
 */
function distance(from: PixelPoint, to: PixelPoint): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

/**
 * The corner of `quad` nearest `point`, if one is within `within` pixels — the
 * hit test behind picking up a corner handle.
 *
 * Returns the INDEX rather than the point, because what the drag then edits is
 * the tuple's slot: moving "the top-right corner" has to keep meaning the
 * second entry even after the page has been turned and that corner is somewhere
 * else on screen.
 */
export function cornerNear(quad: PixelQuad, point: PixelPoint, within: number): 0 | 1 | 2 | 3 | null {
  let best: 0 | 1 | 2 | 3 | null = null;
  let bestDistance = within;
  for (const index of [0, 1, 2, 3] as const) {
    const away = distance(quad[index], point);
    if (away <= bestDistance) {
      best = index;
      bestDistance = away;
    }
  }
  return best;
}

/** The same quad with one corner moved — the drag's whole effect on the recipe. */
export function withCorner(quad: FractionQuad, index: 0 | 1 | 2 | 3, to: FractionPoint): FractionQuad {
  const moved: [FractionPoint, FractionPoint, FractionPoint, FractionPoint] = [
    quad[0],
    quad[1],
    quad[2],
    quad[3],
  ];
  moved[index] = to;
  return moved;
}

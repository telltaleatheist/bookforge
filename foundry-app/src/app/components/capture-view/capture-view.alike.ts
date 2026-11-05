/**
 * capture-view.alike — whether two lists name the same pages.
 */
import { turnedLike } from '@owen/foundry-core/shared/capture';
import type { CaptureQuad } from '@owen/foundry-core/shared/types';

/**
 * WHETHER TWO QUADS ARE THE SAME RECTANGLE, to within the arithmetic that made
 * them.
 *
 * For the ghost, and for nothing else: a photograph that took the book's crop
 * holds it EXACTLY, because `wearing` relabels corners rather than recomputing
 * them -- but a photograph that took it, was turned, and was turned back has
 * been through `turnedLike` twice and can differ in the last bits of a double.
 * An exact comparison would draw a dashed line under a solid one on a page
 * nobody had touched, which is the noise this test exists to keep off the
 * screen.
 *
 * The tolerance is a hundred-thousandth of the frame -- three orders of
 * magnitude under the pixel it would take to see, and eleven orders above the
 * float noise `slideSplit` measured at 5.6e-17.
 */
export function alike(a: CaptureQuad, b: CaptureQuad): boolean {
  return a.every((point, index) => {
    const other = b[index];
    return other !== undefined
      && Math.abs(point[0] - other[0]) < 1e-5
      && Math.abs(point[1] - other[1]) < 1e-5;
  });
}

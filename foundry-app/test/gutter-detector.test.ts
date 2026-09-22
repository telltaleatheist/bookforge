/**
 * THE GUTTER DETECTOR, ON PICTURES WHOSE ANSWER IS KNOWN BY CONSTRUCTION.
 *
 * `gutterOf` is the one rule in this feature that cannot be read off the code:
 * it is four constants and a percentile, and whether it works is a question
 * about photographs. The real answer came from a prototype run over all 271
 * spreads of the fragebogen scan, which is not a thing a test suite can carry
 * -- so what is pinned here is the part that a refactor can break silently.
 *
 * ── WHY SYNTHETIC ARRAYS AND NOT A FIXTURE JPEG ────────────────────────────
 *
 * A fixture would test the decoder as much as the detector, and the decoder is
 * Electron's (`lumaFromBgra` is the only line of it that is ours). An array
 * built here has an answer nobody has to measure: the band is at 0.47 because
 * this file put it there.
 *
 * ── AND THE TEXT-LIKE PAGE IS THE ONE THAT EARNS ITS PLACE ─────────────────
 *
 * The flat page and the plain band would pass against a per-column MEAN, which
 * is the obvious implementation and the wrong one: a column of type is darker
 * on average than a column of gutter shadow, so a mean finds the edge of the
 * text block on any page with words on it. The alternating-rows page is that
 * failure in miniature -- dark type rows over bright interline ones -- and it
 * is here so that a well-meant simplification of `percentileOf` fails loudly
 * rather than quietly halving the accuracy of every spread in a book.
 */
import { describe, expect, test } from 'bun:test';

import { gutterOf, lumaFromBgra } from '../shared/gutter';

/** A landscape frame at the thumbnail's own scale, so the ring is full width. */
const WIDE = { width: 640, height: 480 };
/** The same frame on its side — a spread photographed sideways. */
const TALL = { width: 480, height: 640 };

/** A page of one tone, and a hand to darken a band of it. */
function page(
  width: number,
  height: number,
  paint: (x: number, y: number) => number,
): Uint8Array {
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) luma[y * width + x] = paint(x, y);
  }
  return luma;
}

/** How wide the shadow is, in pixels at 640 — narrower than the ring's gap. */
const FOLD = 5;

describe('gutterOf', () => {
  test('a flat page has no fold, and says so rather than guessing the middle', () => {
    const { width, height } = WIDE;
    expect(gutterOf(page(width, height, () => 230), width, height)).toBeNull();
  });

  test('a dark vertical band at 0.47 is found there, on the x axis', () => {
    const { width, height } = WIDE;
    const at = Math.round(0.47 * width);
    const luma = page(width, height, (x) => (Math.abs(x - at) <= FOLD ? 60 : 230));
    const gutter = gutterOf(luma, width, height);
    expect(gutter?.axis).toBe('x');
    expect(gutter?.at).toBeCloseTo(0.47, 2);
  });

  test('a page of type keeps its fold, which a per-column mean would lose', () => {
    const { width, height } = WIDE;
    const at = Math.round(0.47 * width);
    /*
     * Two text blocks with a margin between them, and the fold in the margin.
     * The type is DARKER than the fold (40 against 90) and covers two rows in
     * every three, so the darkest column by mean is in the middle of a text
     * block and nowhere near the binding. Three quarters of the way up a
     * column's sorted values, the type column is paper and the fold is not.
     */
    const luma = page(width, height, (x, y) => {
      if (Math.abs(x - at) <= FOLD) return 90;
      const margin = Math.abs(x - at) < 40;
      if (margin) return 235;
      return y % 3 === 0 ? 235 : 40;
    });
    const gutter = gutterOf(luma, width, height);
    expect(gutter?.axis).toBe('x');
    expect(gutter?.at).toBeCloseTo(0.47, 2);
  });

  test('a shadow that runs onto the type is cut in the margin, not on the first letters', () => {
    const { width, height } = WIDE;
    const fold = Math.round(0.49 * width);
    /*
     * The fragebogen preface: the left block ends 20 columns before the fold,
     * the right block begins 8 columns after it, and the binding's shadow is a
     * band from the fold to 14 columns past it that is DEEPEST at the right
     * block's first column. Rule 1 cut there, clipping every line of the right
     * page; the cut belongs in the type-free margin, a per cent off its edge.
     */
    const luma = page(width, height, (x, y) => {
      const leftType = x < fold - 20;
      const rightType = x >= fold + 8;
      const shade = x >= fold && x <= fold + 14 ? 255 - (110 - 6 * Math.abs(x - (fold + 10))) : 255;
      const paper = Math.min(235, shade);
      if ((leftType || rightType) && y % 3 !== 0) return 40;
      return paper;
    });
    const gutter = gutterOf(luma, width, height);
    expect(gutter?.axis).toBe('x');
    expect(gutter?.rule).toBe(2);
    const at = gutter!.at * width;
    expect(at).toBeLessThan(fold + 8 - 0.005 * width);
    expect(at).toBeGreaterThan(fold - 20);
  });

  test('a portrait frame is read across, and its fold is a y', () => {
    const { width, height } = TALL;
    const at = Math.round(0.52 * height);
    const luma = page(width, height, (_x, y) => (Math.abs(y - at) <= FOLD ? 60 : 230));
    const gutter = gutterOf(luma, width, height);
    expect(gutter?.axis).toBe('y');
    expect(gutter?.at).toBeCloseTo(0.52, 2);
  });

  test('a band outside the central band is not a fold', () => {
    const { width, height } = WIDE;
    // The left edge of a text block, where a mean-based detector lands.
    const at = Math.round(0.14 * width);
    const luma = page(width, height, (x) => (Math.abs(x - at) <= FOLD ? 40 : 230));
    expect(gutterOf(luma, width, height)).toBeNull();
  });

  test('a shadow shallower than the floor is not a fold', () => {
    const { width, height } = WIDE;
    const at = Math.round(0.5 * width);
    // Eight levels down, against a floor of ten.
    const luma = page(width, height, (x) => (Math.abs(x - at) <= FOLD ? 222 : 230));
    expect(gutterOf(luma, width, height)).toBeNull();
  });

  test('a frame it cannot measure is not a fold either', () => {
    expect(gutterOf(new Uint8Array(0), 0, 0)).toBeNull();
    // Fewer bytes than the frame claims: a caller that got its stride wrong.
    expect(gutterOf(new Uint8Array(100), 640, 480)).toBeNull();
  });

  test('a gradient across the page is not a fold, however dark it gets', () => {
    const { width, height } = WIDE;
    const luma = page(width, height, (x) => 240 - Math.round((x / width) * 120));
    expect(gutterOf(luma, width, height)).toBeNull();
  });
});

describe('lumaFromBgra', () => {
  test('reads blue, green, red in that order and weights them 601', () => {
    // One pure red pixel, laid out the way nativeImage hands a bitmap over.
    const bgra = new Uint8Array([0, 0, 255, 255]);
    expect(Array.from(lumaFromBgra(bgra, 1, 1))).toEqual([Math.trunc(255 * 299 / 1000)]);
  });

  test('a red pixel and a blue one do not read the same', () => {
    const red = lumaFromBgra(new Uint8Array([0, 0, 255, 255]), 1, 1)[0];
    const blue = lumaFromBgra(new Uint8Array([255, 0, 0, 255]), 1, 1)[0];
    expect(red).not.toBe(blue);
  });
});

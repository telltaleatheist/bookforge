/**
 * shared/gutter — WHERE THE FOLD IS, guessed from the coloured page alone.
 *
 * Owen asked for this on 2026-09-21, and the whole brief is in the asking:
 * *"is there any way we could detect a book gutter and try to place page splits
 * roughly where the gutter is, which might be different on each page? just a
 * rudimentary gutter detector? not perfect, just estimate based on page
 * coloring or something?"*
 *
 * ── WHAT IT IS FOR, WHICH IS NARROWER THAN "FINDING THE GUTTER" ─────────────
 *
 * A scanned book's fold is not in the same place twice. The fragebogen scan is
 * 271 landscape spreads and the shadow down the middle wanders across a couple
 * of percent of the frame from page to page, which is a few millimetres of
 * paper and quite enough to leave a sliver of the facing page on every leaf.
 * Nothing here is trying to replace the gutter handle: it is trying to put the
 * handle somewhere a person does not have to move, on all 271 pages at once.
 *
 * So this answers a question about ONE photograph, and the split pass's own
 * rule -- one line for the whole book -- is left exactly as it was. The two are
 * reconciled at the LANDING, not in the standing: see `seated` in the
 * renderer's capture service, which is this module's only real caller.
 *
 * ── THE 75TH PERCENTILE IS THE WHOLE ALGORITHM ──────────────────────────────
 *
 * A gutter is a band of shadow running the height of the page, so the naive
 * measure is the mean luminance of each column: dark column, fold. That finds
 * the EDGE OF THE TEXT BLOCK instead, on every page with text on it, because a
 * column of type is darker on average than a column of shadow.
 *
 * The 75th percentile of each column separates them, and separates them on the
 * one property that actually distinguishes them: a column of text is BRIGHT
 * between its lines, so three quarters of the way up its sorted values it is
 * paper-white; a column of gutter shadow is dark even at its brightest rows,
 * because the shadow does not stop between the lines. Measured on the whole
 * fragebogen book, that one substitution is the difference between landing on
 * the fold on every spread and landing on the left margin on most of them.
 *
 * Everything else here is the arithmetic that turns a profile into a position:
 * a three-wide smooth so a single dark pixel column is not a fold, a "ring"
 * comparison that asks whether this position is darker than the paper either
 * side of it rather than darker than some absolute, and a floor under how much
 * darker it has to be before this says it saw anything.
 *
 * ── IT SAYS NOTHING RATHER THAN GUESSING ────────────────────────────────────
 *
 * Null is a real answer and the callers treat it as one. The prototype this was
 * ported from had a second pass -- the widest bright plateau near the middle,
 * then the middle itself -- so it always returned a number, which is right for
 * a script measuring a known book and wrong for a field on a photograph. A page
 * with no visible fold (a flatbed scan of a loose leaf, a cover, a spread shot
 * in flat light) has no gutter, and the surface that reads this must be able to
 * tell "the fold is at 0.5" from "I cannot see a fold", because the second one
 * means the middle is a placement somebody should look at.
 *
 * ── PURE, AND IN `shared/` FOR ONE REASON ───────────────────────────────────
 *
 * It takes bytes and returns a fraction. Intake computes it in MAIN, from the
 * thumbnail bitmap it has just made; the tests compute it from arrays they
 * build by hand. Neither needs Electron and neither needs a file, which is what
 * makes the one interesting rule in here testable at all.
 */
import type { CaptureGutter } from './types';

/**
 * The rows a vertical gutter is measured over, as fractions of the height --
 * and the columns a horizontal one is measured over, as fractions of the width.
 *
 * The middle seven tenths, so the measurement misses the scanner's own edges:
 * a flatbed leaves a dark rim and a bright lip at the top and bottom of the
 * glass, and both run the full width of the frame, so both are in every column
 * equally and neither says anything about where the fold is. Trimming them is
 * cheaper than making the profile robust to them.
 */
const BAND_FROM = 0.15;
const BAND_TO = 0.85;

/**
 * WHERE A FOLD IS ALLOWED TO BE -- the middle two fifths of the frame.
 *
 * A spread is photographed roughly centred, so the fold is near the middle, and
 * the two things that look most like a fold on a scanned page are both OUTSIDE
 * this band: the dark rim where the page stops and the platen begins, and the
 * left edge of the text block. Allowing the whole frame would find one of those
 * on a page whose fold is genuinely invisible, which is the failure this band
 * and the dip floor below exist to make impossible rather than unlikely.
 */
const CENTRE_FROM = 0.30;
const CENTRE_TO = 0.70;

/**
 * HOW MUCH DARKER THAN ITS SURROUNDINGS A FOLD HAS TO BE, in levels of 0..255.
 *
 * Ten is low, deliberately. The fold on a well-lit flatbed scan of a thin
 * paperback is a very slight grey gradient -- the weakest dip in the fragebogen
 * book is around fourteen -- and a threshold set for a comfortable margin over
 * that would refuse the pages that most need the help. Below ten the profile's
 * own noise on a textured paper is the same size as the signal, so a number
 * from there would be a coin toss wearing a decimal point.
 */
const DIP_FLOOR = 10;

/**
 * The paper the dip is measured AGAINST: a band either side of the position,
 * held off it by `RING_INNER` and reaching out to `RING_OUTER`.
 *
 * In pixels at `RING_SCALE`, which is the thumbnail's long edge, and scaled by
 * the profile's own length so a profile of another size measures the same
 * physical distance. The gap matters as much as the reach: a fold is six to
 * twelve pixels wide at this scale, so a ring that started at the position
 * itself would average the shadow into the paper it is being compared with and
 * measure the fold as half as deep as it is.
 */
const RING_INNER = 6;
const RING_OUTER = 20;
const RING_SCALE = 640;

/** The smooth, in profile samples: one column of dark pixels is not a fold. */
const SMOOTH = 3;

/** Where in each column's sorted values the profile is read. See the docblock. */
const PERCENTILE = 0.75;

/**
 * THE RULE THIS MEASUREMENT WAS MADE UNDER, stored beside every gutter so a
 * book measured under an older rule is measured again on its next open
 * (`gutteredRecipe`). Bump it when the answer for the same pixels changes.
 *
 *   1  the darkest column of the shadow (2026-09-21, first landing)
 *   2  the same, held inside the strip with no type in it (see `foldIn`)
 */
export const GUTTER_RULE = 2;

/**
 * HOW MUCH A COLUMN'S LUMINANCE HAS TO SPREAD (75th minus 25th percentile)
 * BEFORE IT IS TYPE. A column through a text block is paper between the lines
 * and ink on them, so its quartiles sit far apart; a column through the
 * gutter's shadow is uniformly dark, and one through a margin uniformly
 * bright, so both sit close. Measured on the fragebogen scan: text columns
 * read 60-120, shadow and margin under 25. Forty is the middle of the gap.
 */
const TEXT_SPREAD = 40;
/** The smoothing over the spread before it is read as type or not, at 640 px. */
const TEXT_SMOOTH = 5;
/**
 * HOW FAR INSIDE THE TYPE-FREE STRIP THE FOLD IS HELD, as a fraction of the
 * profile. A cut exactly on the first column of type clips the first stroke
 * of every line; one per cent of the frame is a few pixels on a thumbnail and
 * a comfortable margin on the page.
 */
const TEXT_MARGIN = 0.01;

/**
 * THE FOLD IN ONE FRAME, or null because there is no fold to be seen.
 *
 * `luma` is one byte a pixel, row-major, `width * height` of them -- the
 * thumbnail, not the working copy, which is not a compromise: a fold is a
 * centimetre of shadow and 640 pixels resolve it to a fraction of a percent of
 * the frame, which is finer than the thing being measured is defined.
 *
 * ── THE AXIS IS THE FRAME'S SHAPE, AND A PORTRAIT SPREAD IS SIDEWAYS ────────
 *
 * A landscape frame is a spread lying the way a book lies, so its fold runs
 * down it and the halves are side by side: axis 'x'. A PORTRAIT frame in a book
 * of spreads is the same spread photographed on its side -- the fold runs
 * across it and the halves are stacked -- so it is measured the other way and
 * answers 'y'. That is the same reading `cutOf` takes of a split and the same
 * reading `halvesOf` takes of a quad, and it has to be, because the answer here
 * is only useful if it can be compared with those.
 *
 * A single page is landscape or portrait too and has no fold at all; it is
 * measured anyway and says null, because nothing on disk knows whether a
 * photograph is a spread until somebody says so.
 */
export function gutterOf(
  luma: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): CaptureGutter | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 2 || height < 2 || luma.length < width * height) return null;
  const axis: 'x' | 'y' = width > height ? 'x' : 'y';
  const read = axis === 'x'
    ? downColumns(luma, width, height)
    : alongRows(luma, width, height);
  return foldIn(read.paper, read.spread, axis);
}

/** The two profiles one pass over the frame yields: see `foldIn`. */
interface Profiles {
  /** The 75th-percentile luminance per column (or row): the paper's brightness. */
  paper: Float64Array;
  /** The 75th minus the 25th: how much type is in the column. */
  spread: Float64Array;
}

/**
 * The 75th-percentile luminance of every column, over the middle rows.
 *
 * Gathered column by column rather than by sorting the band once, because the
 * profile IS per column: there is no shared order to reuse, and a 640-wide
 * thumbnail is 640 sorts of about 450 values, which is a few milliseconds once
 * per photograph at intake.
 */
function downColumns(
  luma: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Profiles {
  const from = Math.floor(BAND_FROM * height);
  const to = Math.floor(BAND_TO * height);
  const rows = Math.max(1, to - from);
  const column = new Float64Array(rows);
  const paper = new Float64Array(width);
  const spread = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    for (let row = 0; row < rows; row += 1) {
      column[row] = luma[(from + row) * width + x] ?? 0;
    }
    const [lower, upper] = quartilesOf(column);
    paper[x] = upper;
    spread[x] = upper - lower;
  }
  return { paper, spread };
}

/** The same reading turned a quarter: per row, over the middle columns. */
function alongRows(
  luma: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Profiles {
  const from = Math.floor(BAND_FROM * width);
  const to = Math.floor(BAND_TO * width);
  const columns = Math.max(1, to - from);
  const row = new Float64Array(columns);
  const paper = new Float64Array(height);
  const spread = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let at = 0; at < columns; at += 1) {
      row[at] = luma[y * width + from + at] ?? 0;
    }
    const [lower, upper] = quartilesOf(row);
    paper[y] = upper;
    spread[y] = upper - lower;
  }
  return { paper, spread };
}

/** The 25th and 75th percentiles of one column, from one sort. */
function quartilesOf(values: Float64Array): [number, number] {
  values.sort();
  return [percentileAt(values, 1 - PERCENTILE), percentileAt(values, PERCENTILE)];
}

function percentileAt(sorted: Float64Array, fraction: number): number {
  const at = fraction * (sorted.length - 1);
  const below = Math.floor(at);
  const above = Math.min(sorted.length - 1, below + 1);
  const part = at - below;
  return (sorted[below] ?? 0) * (1 - part) + (sorted[above] ?? 0) * part;
}

/**
 * The `PERCENTILE` of these values, interpolated between the two that straddle
 * it -- which is numpy's default and therefore the prototype's, and the reason
 * this is not simply an index into the sorted array. The difference is under a
 * level, and it is written out so a disagreement with the prototype's numbers
 * can only ever be about the picture.
 *
 * SORTS ITS ARGUMENT IN PLACE. Both callers hand it a scratch buffer they are
 * about to overwrite, which is what keeps this to one allocation per profile.
 */

/**
 * THE DEEPEST DIP IN THE CENTRAL BAND, as a fraction of the profile's length.
 *
 * "Dip" is the ring either side minus the profile here, so it is a question
 * about CONTRAST and not about darkness: a page printed on grey stock has a
 * dark profile end to end and the fold still stands out of it, and a page with
 * a photograph bled across the middle has a dark region that is dark uniformly
 * and produces no dip at all. An absolute threshold would get both backwards.
 *
 * The first maximum wins a tie, which matters only on a synthetic image and is
 * stated so the answer is a function of the bytes rather than of the loop.
 */
function foldIn(profile: Float64Array, spread: Float64Array, axis: 'x' | 'y'): CaptureGutter | null {
  const n = profile.length;
  const smoothed = smoothOf(profile, SMOOTH);
  // Prefix sums, so a ring mean is two subtractions rather than a walk: the
  // loop below asks for 2n segment means over a 640-long profile.
  const sums = new Float64Array(n + 1);
  for (let at = 0; at < n; at += 1) sums[at + 1] = sums[at]! + smoothed[at]!;
  const meanOf = (from: number, to: number): number | null => {
    const start = Math.max(0, from);
    const end = Math.min(n, to);
    return end > start ? (sums[end]! - sums[start]!) / (end - start) : null;
  };

  const scale = n / RING_SCALE;
  const inner = Math.max(2, Math.floor(RING_INNER * scale));
  const outer = Math.max(inner + 2, Math.floor(RING_OUTER * scale));
  const from = Math.floor(CENTRE_FROM * n);
  const to = Math.floor(CENTRE_TO * n);

  let foundAt = -1;
  let deepest = Number.NEGATIVE_INFINITY;
  for (let at = from; at < to; at += 1) {
    const left = meanOf(at - outer, at - inner + 1);
    const right = meanOf(at + inner, at + outer + 1);
    // One side is enough when the other falls off the frame, which only happens
    // on a profile short enough that the central band reaches the edge.
    const ring = left === null
      ? right
      : (right === null ? left : (left + right) / 2);
    if (ring === null) continue;
    const dip = ring - smoothed[at]!;
    if (dip > deepest) {
      deepest = dip;
      foundAt = at;
    }
  }
  if (foundAt < 0 || deepest < DIP_FLOOR) return null;
  return { axis, at: heldOffTheType(foundAt, spread) / n, rule: GUTTER_RULE };
}

/**
 * THE FOLD, HELD INSIDE THE STRIP WITH NO TYPE IN IT.
 *
 * ── Owen, 2026-09-21: the minted page viii carried a sliver of ix, and ix
 * lost its first letters ─────────────────────────────────────────────────
 *
 * On a tightly bound book the gutter's shadow is not a line, it is a band,
 * and it lies mostly on the page that curves down into the binding -- where
 * the type begins INSIDE the shadow. The darkest column of that band is the
 * deepest part of the curve, which on the fragebogen preface was the first
 * column of page ix's type, 2.5% of the frame right of the fold. A cut there
 * gives the flat page a sliver of its neighbour and clips every line of the
 * curved one. The fold a person would cut on is the shadow's edge on the
 * flat page's side; the cut that loses nothing is anywhere in the strip
 * between the two blocks of type.
 *
 * So the darkest column is the FIRST answer, not the last: it is held inside
 * the type-free run it falls in, `TEXT_MARGIN` off either end; and when it
 * falls inside type (the shadow over the first letters), it is moved to the
 * nearest type-free run and held there the same way. Type is read off the
 * spread profile -- see `TEXT_SPREAD` -- which is what tells a column of type
 * from a column of shadow, since both are dark by the 75th percentile alone.
 * A blank spread has one run the width of the frame, and the darkest column
 * stands; a scan with no shadow at all never reaches here (`DIP_FLOOR`).
 *
 * Measured over the 271 spreads of that scan against the first rule: 39
 * moved by more than half a per cent, five of them off the type (the
 * preface pair by 2.4-2.6%), and every one of the largest moves landed on
 * the fold in a contact sheet.
 */
function heldOffTheType(foundAt: number, spread: Float64Array): number {
  const n = spread.length;
  const scale = n / RING_SCALE;
  const type = smoothOf(spread, Math.max(3, Math.floor(TEXT_SMOOTH * scale)));
  const free = (at: number): boolean => (type[at] ?? 0) <= TEXT_SPREAD;
  const runAround = (at: number): [number, number] | null => {
    if (!free(at)) return null;
    let from = at;
    while (from > 0 && free(from - 1)) from -= 1;
    let to = at;
    while (to < n - 1 && free(to + 1)) to += 1;
    return [from, to];
  };
  let run = runAround(foundAt);
  if (run === null) {
    // The shadow lies over type: the nearest run with none in it.
    let nearest: [number, number] | null = null;
    let away = Number.POSITIVE_INFINITY;
    for (let at = 0; at < n; at += 1) {
      const here = runAround(at);
      if (here === null) continue;
      const gap = Math.min(Math.abs(here[0] - foundAt), Math.abs(here[1] - foundAt));
      if (gap < away) {
        away = gap;
        nearest = here;
      }
      at = here[1];
    }
    if (nearest === null) return foundAt;
    run = nearest;
  }
  const margin = TEXT_MARGIN * n;
  let low = run[0] + margin;
  let high = run[1] - margin;
  if (high < low) low = high = (run[0] + run[1]) / 2;
  return Math.min(Math.max(foundAt, low), high);
}

/**
 * A `SMOOTH`-wide box mean, with the ends held at their own value.
 *
 * Edge-padded rather than shortened, so the profile keeps its length and a
 * position in it is still a fraction of the frame. The ends are outside the
 * central band anyway; the padding is there so nothing here has to reason about
 * two coordinate systems.
 */
function smoothOf(profile: Float64Array, window: number): Float64Array {
  const n = profile.length;
  const width = window % 2 === 0 ? window + 1 : window;
  const reach = width >> 1;
  const out = new Float64Array(n);
  for (let at = 0; at < n; at += 1) {
    let total = 0;
    for (let step = -reach; step <= reach; step += 1) {
      total += profile[Math.min(n - 1, Math.max(0, at + step))]!;
    }
    out[at] = total / width;
  }
  return out;
}

/**
 * BGRA, as Electron's `nativeImage.toBitmap()` hands it over, read down to one
 * luminance byte a pixel.
 *
 * ── THE CHANNEL ORDER IS THE ONLY THING THAT CAN BE WRONG HERE ──────────────
 *
 * It is BGRA on every platform Electron documents, and getting it backwards
 * would not throw: it would swap red and blue, which changes the luminance of a
 * coloured page by a few levels and of a grey one not at all. So the defect
 * would be invisible on the scanned book this was written for and would quietly
 * cost accuracy on a colour plate. This is the same hazard the PNG encoder in
 * electron/capture.ts carries a docblock about, and it is answered the same
 * way: one function, named, with the order written down.
 *
 * ── AND THE WEIGHTS ARE ITU-R 601, BECAUSE THE PROTOTYPE'S WERE ─────────────
 *
 * 299/587/114 is what PIL's `convert('L')` does, which is what the prototype
 * measured this algorithm's thresholds against on all 271 spreads. Any other
 * set of weights is defensible and none of them is the one the number ten was
 * calibrated on.
 */
export function lumaFromBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const luma = new Uint8Array(width * height);
  for (let at = 0; at < luma.length; at += 1) {
    const here = at * 4;
    const blue = bgra[here] ?? 0;
    const green = bgra[here + 1] ?? 0;
    const red = bgra[here + 2] ?? 0;
    luma[at] = (red * 299 + green * 587 + blue * 114) / 1000;
  }
  return luma;
}

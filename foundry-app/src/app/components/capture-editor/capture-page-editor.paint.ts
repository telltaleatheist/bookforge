/**
 * capture-page-editor.paint — drawing the stage and projecting the previews.
 */
import { effect, signal } from '@angular/core';
import { type Dimensions, type FractionQuad, toPixels } from '@owen/foundry-core/browser/geometry';
import { joinedQuad, slideSplit } from '@owen/foundry-core/shared/capture';
import type { CaptureQuad } from '@owen/foundry-core/shared/types';
import { Rectifier } from '@owen/foundry-core/browser/rectify';
import { STAGE_PIXELS } from './capture-page-editor.map';
import type { CapturePageEditorComponent } from './capture-page-editor.component';

/**
 * The photograph finished decoding — draw the previews that are ITS previews.
 *
 * Called from (load), which fires on the first picture and on every change of
 * `source()` after it. Cheap to call spuriously: `draw` is a handful of
 * canvas blits and only runs at all once the element holds the picture the
 * previews are supposed to be of.
 */
export function repaint(this: CapturePageEditorComponent): void {
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
export function project(this: CapturePageEditorComponent, projecting: boolean, sheet: CaptureQuad): void {
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

export function outlineOf(this: CapturePageEditorComponent, quad: FractionQuad): string {
  return quad.map(([x, y]) => `${x},${y}`).join(' ');
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
export function draw(this: CapturePageEditorComponent, previews: readonly { index: number; width: number; height: number }[], quads: readonly FractionQuad[], dimensions: Dimensions): void {
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

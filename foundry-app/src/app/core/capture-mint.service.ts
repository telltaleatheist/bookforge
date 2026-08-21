import { Injectable, inject, signal } from '@angular/core';

import type { CaptureMintPage, LedgerStep } from '@shared/types';

import { Rectifier } from '../components/capture-editor/rectify';
import { CaptureService } from './capture.service';
import { api } from './foundry';
import { NoticeService } from './notice.service';

/** How far a mint has got, for the progress the doc promises on the job row. */
export interface MintProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * THE MINT DRIVER — the renderer's half of turning photographs into a PDF.
 *
 * ── Who decides what, and why the split is where it is ──────────────────────
 *
 * MAIN COMPUTES THE LIST and the renderer renders exactly that list. Strikes
 * filtered, order applied, quads denormalized, output sizes decided — all of it
 * happens once, on the side that owns the recipe, and arrives as
 * `CaptureMintPage[]`. This file does not consult the recipe at all, which is
 * what stops the mint from being a second opinion about which pages exist.
 *
 * THE RENDERER RASTERIZES because the pixels are here: `createImageBitmap`, a
 * WebGL rectify and `canvas.toBlob` are native-speed browser primitives, and the
 * editor needs the identical transform for its preview anyway. Doing it in main
 * would mean a second implementation of the one shader (docs/CAPTURE.md).
 *
 * ── ONE PAGE AT A TIME, DELIBERATELY ────────────────────────────────────────
 *
 * A working copy is a 12-megapixel PNG — around 46 MiB of RGBA decoded, and one
 * of the acceptance shoot's is 93 MiB. Twenty-seven of those resident at once is
 * over a gigabyte, so each page is loaded, rectified, encoded, sent, and
 * RELEASED before the next begins. The finished JPEG crosses IPC one page at a
 * time for the same reason: no whole book is ever in one heap, on either side.
 *
 * ── JPEG AT 0.92, AND THAT NUMBER IS THE CONTRACT ───────────────────────────
 *
 * Owen's ruling: the shoot is small poor-quality print and HEIC is already one
 * lossy generation, so the working copies are lossless PNG and the ONE lossy
 * step after the camera is this encode — full resolution, taken at the last
 * moment, from a lossless source. The quality lives in `docs/CAPTURE.md` and is
 * repeated here rather than passed in, because a mint that could be asked for a
 * different number is a mint that can produce two different books.
 */
@Injectable({ providedIn: 'root' })
export class CaptureMintService {
  private readonly captures = inject(CaptureService);
  private readonly notices = inject(NoticeService);

  private readonly state = signal<MintProgress | null>(null);
  /** Non-null while a mint is running. */
  readonly progress = this.state.asReadonly();

  private cancelled = false;

  /** Ask for the run to stop. The page in flight finishes; nothing after starts. */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Rasterize every page main listed and commit the PDF.
   *
   * Answers the minted step, or null if it was cancelled or refused — the
   * caller draws the result and this says what happened in the notice bar,
   * because a mint is minutes of work and a silent failure is unbearable.
   */
  async mint(projectDir: string): Promise<LedgerStep | null> {
    if (api === null) return null;
    const bridge = api;
    this.cancelled = false;

    let begun;
    try {
      begun = await bridge.capture.mintBegin(projectDir);
    } catch (err) {
      this.complain(err);
      return null;
    }

    this.state.set({ done: 0, total: begun.pages.length });
    /*
     * ONE RECTIFIER FOR THE WHOLE RUN. A context per page would exceed the
     * browser's live-context cap within the first dozen photographs and the
     * earliest ones would be dropped silently — see rectify.ts, which argues it
     * at length. It is disposed in the `finally` whatever happens, including a
     * cancel, because a leaked context outlives the mint that made it.
     */
    const rectifier = new Rectifier();

    try {
      for (const [index, page] of begun.pages.entries()) {
        if (this.cancelled) {
          await bridge.capture.mintAbort(begun.mintId).catch(() => undefined);
          this.notices.notice.set('The mint was cancelled. Nothing was written.');
          return null;
        }
        const jpeg = await this.render(rectifier, page);
        if (jpeg === null) {
          await bridge.capture.mintAbort(begun.mintId).catch(() => undefined);
          return null;
        }
        await bridge.capture.mintPage(begun.mintId, index, jpeg);
        this.state.set({ done: index + 1, total: begun.pages.length });
      }
      return await bridge.capture.mintCommit(begun.mintId);
    } catch (err) {
      this.complain(err);
      await bridge.capture.mintAbort(begun.mintId).catch(() => undefined);
      return null;
    } finally {
      rectifier.dispose();
      this.state.set(null);
    }
  }

  /** One page: load, assert, rectify, encode. Null means it said why and stopped. */
  private async render(rectifier: Rectifier, page: CaptureMintPage): Promise<ArrayBuffer | null> {
    const image = new Image();
    try {
      image.src = this.captures.url(page.workingCopy);
      await image.decode();

      /*
       * THE ASSERTION THE CONTRACT ASKS FOR. `sourceWidth`/`sourceHeight` are
       * what MAIN measured the working copy to be, and `quadPx` was multiplied
       * out against exactly those numbers. If the file on disk is a different
       * size — a half-written decode, a stale derived file from an older
       * intake — then the quad describes a rectangle on an image that no longer
       * exists, and the page would mint plausible and wrong. Refusing here costs
       * one book; not refusing costs a book nobody can tell is wrong.
       */
      if (image.naturalWidth !== page.sourceWidth || image.naturalHeight !== page.sourceHeight) {
        this.notices.notice.set(
          `${page.workingCopy} is ${image.naturalWidth}x${image.naturalHeight} on disk `
          + `but the recipe was measured against ${page.sourceWidth}x${page.sourceHeight}. `
          + 'The mint stopped rather than write a page from corners that no longer fit.',
        );
        return null;
      }

      const drawn = rectifier.rectify(image, page.quadPx, page.outWidth, page.outHeight);
      /*
       * `withinSource` is NOT fatal here, and that is a decision rather than an
       * oversight: a quad hanging off the edge is a crop somebody chose, and the
       * editor already says so beside the page while they are choosing it. The
       * mint's job is to produce what the recipe describes.
       */
      return await encode(drawn.canvas);
    } catch (err) {
      this.complain(err);
      return null;
    } finally {
      // Let the decoded frame go before the next page's is decoded. Without
      // this the run holds every photograph it has touched.
      image.src = '';
    }
  }

  private complain(err: unknown): void {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/** The pinned quality. See the class docblock: it is the contract, not a default. */
const JPEG_QUALITY = 0.92;

/** The canvas as JPEG bytes, ready to cross the bridge. */
function encode(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('The page could not be encoded — the browser returned no image.'));
          return;
        }
        resolve(blob.arrayBuffer());
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

import { Injectable, inject, signal } from '@angular/core';
/*
 * ── pdf.js IS IMPORTED FOR ITS TYPES HERE AND FOR ITS CODE AT THE CALL ──────
 *
 * A `type` import is erased, so this line costs nothing at runtime; the module
 * itself is fetched by a dynamic `import()` inside `explode`. THAT IS LOAD-
 * BEARING RATHER THAN TIDY. This service is `providedIn: 'root'` and is injected
 * by `CaptureService`, which the shell injects — so a static import would pull
 * half a megabyte of pdf.js out of the lazy chunk it currently lives in
 * (`PdfViewComponent`'s route) and into the INITIAL bundle, where every launch
 * of the app would parse it whether or not anybody ever drops a PDF. Measured:
 * the initial bundle goes from 949 kB to 1.44 MB.
 *
 * THE LEGACY BUILD IS A REQUIREMENT RATHER THAN A HEDGE, and the whole of the
 * argument is in `PdfViewComponent`'s header, where the same specifier stands:
 * pdf.js v6's modern build calls `Uint8Array.prototype.toHex`, newer than the
 * Chromium inside this app's Electron, so the first thing it does with a file
 * dies before a page exists. The two specifiers must stay identical — a second
 * copy of pdf.js in the bundle is the cost of a typo here.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { pdfPageName, pdfPageScale, pdfStem } from '@shared/capture';

import { api } from './foundry';
import { NoticeService } from './notice.service';

/**
 * ONE PAGE OF AN EXPLODED PDF, on its way to becoming a photograph.
 *
 * `path` is what `capture:intake` needs and is the only field that outlives this
 * renderer; `url` draws a card while the page is still loose on the workspace
 * table, and is null for the door that has no table (see `explode`).
 */
export interface StagedPage {
  /** The name the card prints and intake stores — `pdfPageName`'s. */
  name: string;
  /** Where main put it. Handed to `capture:intake` verbatim. */
  path: string;
  /** A thumbnail-sized object URL, or null when nobody is going to draw one. */
  url: string | null;
}

/** What one explosion produced, and the handle that frees the staging. */
export interface StagedPdf {
  /** Main's handle on the staging directory. Release it when the pages are copied. */
  stageId: string;
  /** The PDF's name with its extension off — the title a new book would take. */
  stem: string;
  pages: readonly StagedPage[];
  /** How many pages this PDF has, including any that would not draw. */
  total: number;
  /** Pages that would not rasterize, each with a sentence saying why. */
  refused: readonly { file: string; why: string }[];
}

/** Where a rasterizing pass has got to, or null when none is running. */
export interface PdfPagesProgress {
  /** Pages finished. Zero while the first one is being drawn. */
  done: number;
  total: number;
  /** The PDF being taken apart — the one name a person can recognise here. */
  file: string;
}

/**
 * TAKING A PDF APART INTO THE PAGES IT IS PICTURES OF.
 *
 * ── Owen's ask, 2026-09-10, verbatim ────────────────────────────────────────
 *
 * *"give me the ability to drag/drop a pdf into a new book, not just images. if
 * i do, it should take each page as an individual image. theres a book that is
 * just a bunch of scanned images that need to be cropped and split and stuff"*
 *
 * That is the light table's own case arriving in the one container it could not
 * read. A scan whose pages are photographs of paper needs the crop, the split
 * and the turn; that a scanner wrapped them in a PDF before Foundry saw them is
 * a fact about the delivery and not about the work.
 *
 * ── WHAT THIS IS NOT: IT IS NOT A READ ──────────────────────────────────────
 *
 * Nothing here looks at the PDF's text, its outline or its structure. A PDF
 * opened the ordinary way is a DOCUMENT — pdf.js draws it, the reading stage
 * mines it, and that path is untouched. This one throws all of that away
 * deliberately and keeps the pixels, because the person invoking it has already
 * said the pages are pictures. The two meanings of a dropped PDF are asked about
 * at the drop (see `App.onDrop`), never guessed at here.
 *
 * ── THE PAGES ARE PNG, AND THAT IS THE ONE DIFFERENCE FROM THE MINT ─────────
 *
 * `CaptureMintService` encodes JPEG at a pinned quality because it is writing a
 * finished book into a container. This writes intake's ORIGINAL, and intake
 * takes a PNG's bytes as the working copy BYTE FOR BYTE (`intakePhotos`) — so
 * the pixels pdf.js drew are the pixels the editor crops, with no encoder in
 * between. On a bilevel scan that difference is the whole ballgame: JPEG ringing
 * around type is invisible on screen and is exactly what OCR then has to read
 * through, and it would be baked into the only copy this project keeps.
 *
 * ── THE THUMBNAILS ARE A SECOND, TINY ENCODE, AND NOT THE PAGE ──────────────
 *
 * The workspace draws a card per loose image off an object URL. Pointing those
 * at the full-size PNG blobs would pin the whole scan in this renderer's heap
 * for as long as the pages sit unassigned — gigabytes, for pictures drawn at
 * 160 px. So a small JPEG is made per page and the full-size blob is released
 * the moment main has its bytes. The light table needs none of this (intake
 * makes its own thumbnail from the file), and asks for none.
 */
@Injectable({ providedIn: 'root' })
export class PdfPagesService {
  private readonly notices = inject(NoticeService);

  /**
   * HOW FAR A RASTERIZING PASS HAS GOT, or null when none is running.
   *
   * Set before the first page and cleared in a `finally`, so its lifetime is
   * exactly the work it describes — `CaptureService.intakeProgress`'s own rule,
   * and drawn by the same card. Unlike that one this is not a push from main:
   * the work is happening in this process, so the count is simply true as it is
   * written.
   */
  private readonly run = signal<PdfPagesProgress | null>(null);
  readonly progress = this.run.asReadonly();

  /**
   * ASKED FOR, AND CHECKED BETWEEN PAGES ONLY.
   *
   * The intake modal has no cancel and says why: a wasm decode cannot be
   * interrupted, so a button there would stop between photographs at best. This
   * pass is different in the one way that matters — a page is a canvas render
   * that takes a fraction of a second, and a 600-page scan is minutes of work a
   * person may well have started by accident. Stopping leaves a staging
   * directory that is released on the way out and a project untouched, because
   * nothing has been intaken yet.
   */
  private cancelled = false;

  /**
   * WHETHER THE LAST RUN ENDED BY HAND, which is not the same question as
   * whether it ended.
   *
   * `explode` answers null for three different things: it could not run, the PDF
   * would not open, or somebody pressed Stop. A caller working through several
   * PDFs has to tell the last one from the other two — a scan that will not open
   * is no reason to skip the three beside it, and a person who pressed Stop
   * meant all four. This is the only field that separates them, and it is read
   * immediately after a null rather than stored, because the next `explode`
   * clears it.
   */
  private halted = false;

  /** True when the last `explode` ended because Stop was pressed. */
  stopped(): boolean {
    return this.halted;
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Rasterize every page of `file` and stage it on disk.
   *
   * `thumbnails` asks for the small JPEGs the workspace draws its cards from —
   * see the class docblock. The light table passes false, because intake makes a
   * thumbnail of its own from the file and a second one here would be an encode
   * per page thrown away.
   *
   * Answers null when it could not run or was cancelled, having already said
   * why: this is minutes of work and a silent failure is unbearable
   * (`CaptureMintService.mint`'s rule, for the same reason).
   */
  async explode(file: File, thumbnails: boolean): Promise<StagedPdf | null> {
    if (api === null) return null;
    const bridge = api;
    this.cancelled = false;
    this.halted = false;

    /*
     * A WORKER PER RUN, MADE HERE AND KILLED IN THE `finally`.
     *
     * `PdfViewComponent` keeps one for the life of a tab because a tab is
     * looking at a document continuously. This is a burst: a person explodes a
     * scan once and then spends an hour cropping it, and a parser thread parked
     * in the background for that hour is a thread doing nothing.
     *
     * IT IS CONSTRUCTED RATHER THAN CONFIGURED, and that is not a style choice.
     * Handing pdf.js a `workerSrc` sends a packaged build down its blob-wrapper
     * path, into `script-src 'self'`, and out the other side as a FAKE worker on
     * the UI thread with nothing said — so a 600-page scan would parse in the
     * thread drawing the progress bar. The whole argument is in
     * `PdfViewComponent`'s header, and this is the same three lines because it
     * is the same trap.
     */
    const { PDFWorker, getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const thread = new Worker(new URL('pdf.worker.min.mjs', PDFJS_ASSETS), { type: 'module' });
    const worker = PDFWorker.create({ name: 'foundry-pdf-pages', port: thread });

    const stem = pdfStem(file.name);
    let stageId: string | null = null;
    let canvas: HTMLCanvasElement | null = null;

    try {
      const bytes = await file.arrayBuffer();
      const task = getDocument({
        data: new Uint8Array(bytes),
        worker,
        // Everything pdf.js may need at runtime, shipped beside the worker.
        // Absent, a scan with JPEG 2000 images rasterizes to blank pages and
        // says nothing — which here would be a book of blank pages on disk.
        cMapUrl: new URL('cmaps/', PDFJS_ASSETS).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', PDFJS_ASSETS).href,
        wasmUrl: new URL('wasm/', PDFJS_ASSETS).href,
        iccUrl: new URL('iccs/', PDFJS_ASSETS).href,
      });
      const doc = await task.promise;
      const total = doc.numPages;
      if (total === 0) {
        this.notices.notice.set(`${file.name} has no pages in it.`);
        return null;
      }

      this.run.set({ done: 0, total, file: file.name });
      stageId = await bridge.capture.pdfStageBegin();

      /*
       * ONE CANVAS FOR THE WHOLE RUN, resized per page. A canvas per page would
       * leave three hundred backing stores for the garbage collector to get to
       * in its own time, which on a long scan is the difference between a pass
       * that finishes and one that runs the renderer out of memory partway.
       */
      canvas = document.createElement('canvas');
      const pages: StagedPage[] = [];
      const refused: { file: string; why: string }[] = [];

      for (let number = 1; number <= total; number += 1) {
        if (this.cancelled) {
          this.halted = true;
          // The staging goes with it: nothing has been intaken, so there is
          // nothing half-made to keep and nothing to explain later.
          await bridge.capture.pdfStageRelease(stageId).catch(() => undefined);
          this.notices.notice.set(`Reading ${file.name} was stopped. Nothing was added.`);
          return null;
        }
        const name = pdfPageName(stem, number - 1, total);
        // Said BEFORE the work rather than after it, so the count names the page
        // being waited ON — `intakePhotos`' rule, kept so the two cards read the
        // same way.
        this.run.set({ done: number - 1, total, file: file.name });

        try {
          const png = await this.draw(doc, canvas, number);
          const path = await bridge.capture.pdfStagePage(stageId, name, await png.arrayBuffer());
          pages.push({
            name,
            path,
            url: thumbnails ? await this.thumbnail(canvas) : null,
          });
        } catch (err) {
          /*
           * ON THE PAGE, NOT OVER THE BOOK. A page that will not draw is a fact
           * about that page; taking the whole scan down for it would cost the
           * other 599, and the person can drop the PDF again or photograph the
           * one leaf. It is COUNTED AND NAMED rather than skipped silently,
           * because a book quietly short a leaf is the failure this app refuses
           * to ship.
           */
          refused.push({
            file: name,
            why: err instanceof Error ? err.message : String(err),
          });
        }
      }

      this.run.set({ done: total, total, file: file.name });
      // Destroying the loading task takes the document and the transport with
      // it. Caught because there is nothing a rejection here could mean — the
      // pages are already on disk.
      await task.destroy().catch(() => undefined);
      return { stageId, stem, pages, total, refused };
    } catch (err) {
      if (stageId !== null) await bridge.capture.pdfStageRelease(stageId).catch(() => undefined);
      this.notices.notice.set(
        `${file.name} could not be read as a PDF: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      // Zeroing the dimensions is what actually frees a canvas's backing store;
      // dropping the reference leaves the pixels to the collector's schedule.
      if (canvas !== null) { canvas.width = 0; canvas.height = 0; }
      void worker.destroy();
      thread.terminate();
      this.run.set(null);
    }
  }

  /** One page onto the shared canvas, and out as PNG bytes. */
  private async draw(doc: PDFDocumentProxy, canvas: HTMLCanvasElement, number: number): Promise<Blob> {
    const page = await doc.getPage(number);
    /*
     * SCALE 1 FIRST, TO MEASURE. `pdfPageScale` wants the page box in POINTS,
     * which is what a unit viewport reports; asking for the real viewport in one
     * step would mean guessing the scale before knowing the size. The rotation
     * the page declares is already applied by pdf.js at this point, so a scan
     * stored sideways measures — and rasterizes — the way it reads.
     */
    const box = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: pdfPageScale(box.width, box.height) });

    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('the browser would not give this page a drawing context');
    }
    /*
     * PAINTED WHITE FIRST, deliberately. A PDF page has no background of its
     * own, so an unpainted canvas is TRANSPARENT — and a transparent PNG is a
     * page whose ink sits on nothing. Everything downstream treats these as
     * photographs of paper: the editor's crop preview, the mint's JPEG (which
     * has no alpha channel at all and would composite it black), and the
     * reading. Paper is white; this is that sentence.
     */
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: context, viewport }).promise;
    // Freed before the next page is asked for, rather than at the end of the
    // book: pdf.js caches a page's operator list and images on the proxy.
    page.cleanup();
    return encode(canvas, 'image/png');
  }

  /** The page just drawn, small enough to hold onto. See the class docblock. */
  private async thumbnail(canvas: HTMLCanvasElement): Promise<string> {
    const scale = Math.min(1, THUMB_EDGE / Math.max(canvas.width, canvas.height));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(canvas.width * scale));
    small.height = Math.max(1, Math.round(canvas.height * scale));
    const context = small.getContext('2d');
    if (context === null) return '';
    context.drawImage(canvas, 0, 0, small.width, small.height);
    const url = URL.createObjectURL(await encode(small, 'image/jpeg', THUMB_QUALITY));
    small.width = 0;
    small.height = 0;
    return url;
  }
}

/**
 * Where pdf.js's own files were copied to, addressed off the document.
 *
 * `/pdfjs/…` under `ng serve` and `./pdfjs/…` beside index.html in a packaged
 * build, because the production configuration sets baseHref to `./` and a
 * packaged renderer is a `file://` page with no server under it. The same one
 * line stands in `PdfViewComponent`; it is four characters of arithmetic over a
 * global and moving it into a shared module would buy an import to save nothing.
 */
const PDFJS_ASSETS = new URL('pdfjs/', document.baseURI);

/**
 * The longest edge of a workspace thumbnail, and the quality it is written at.
 *
 * NOT `THUMB_EDGE` FROM THE CAPTURE STAGE, which is 640 and is a fact about
 * files main writes into a project and keeps. This one is pixels held in this
 * renderer's heap for as long as a pile of pages sits unassigned, drawn on a
 * card about 160 px wide. 480 is generous at every display density the app
 * runs at, and three hundred of them is megabytes rather than gigabytes.
 */
const THUMB_EDGE = 480;
const THUMB_QUALITY = 0.8;

/** A canvas as bytes. The browser's encoder, which is the only fast one here. */
function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('the browser returned no image for this page'));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

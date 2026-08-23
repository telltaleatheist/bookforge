import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import type { BookRow } from '@shared/book';
import { api } from '../../core/foundry';

/**
 * THE PAGE THE BLOCK WAS PRINTED ON, beside the block.
 *
 * ── What was asked for ──────────────────────────────────────────────────────
 *
 * *"i want to hover over a block and see that page of the original beside it."*
 *
 * Everything needed to answer that has been in the book file since v2 and no
 * surface had ever used it: a row carries the page it started on, the box it
 * occupied, and the render frame that box was measured in (BookRow.page, .box,
 * .pageWidth, .pageHeight). What was missing was the scan itself — a book tab's
 * path is the PROJECT directory, and nothing on the load named the document the
 * reading photographed. BookLoad.originalPath is that name, and this component
 * is everything downstream of it.
 *
 * ── IT IS NOT THE PEEK CARD, AND THE DISTINCTION IS DELIBERATE ──────────────
 *
 * The sheet already has a card beside the hand: the note peek, opened by
 * CLICKING a marker, joined to the click by a sienna leader, dismissed by
 * clicking again or by Escape (§4 of the sheet's own stylesheet). This is a
 * second card and it wears the same paper on purpose — a reader should not have
 * to learn two idioms for "a small sheet showing you the other thing" — but it
 * answers a different question, and conflating them would be wrong in both
 * directions. A peek says what the OTHER HALF OF AN APPARATUS reads; a glance
 * says what THIS PARAGRAPH LOOKED LIKE ON THE PRINTED PAGE. So they have
 * separate state, and both can be open at once without either one having an
 * opinion about the other.
 *
 * The two are now opened by the same KIND of gesture — a click — and that is
 * the correction and not a collapse. It used to say here that a peek is
 * deliberate and stays while a glance is incidental and goes; the second half
 * of that was a description of a hover trigger, and the hover is gone.
 *
 * ── A CLICK, AND NOT A POINTER THAT STOPPED ────────────────────────────────
 *
 * *"it should only appear when a block is actually clicked."* The card rides
 * the click that already SELECTS a block — the one gesture, not a second one
 * bolted beside it — so a reader who wants the page does what they were doing
 * anyway, and a reader who wants neither is never shown one.
 *
 * WHAT THAT REPLACED IS WORTH KEEPING, because it was right for what it was:
 * the trigger used to be a pointer that had STOPPED on a block for 180 ms, on
 * the argument that a pane of prose is swept across on the way somewhere else
 * and a card on every crossing would flash a dozen times down a page, each
 * flash costing a PDF page render. That argument protected against the HOVER,
 * and there is no hover left to protect against: a click happens once, when it
 * is meant. The delay was also what made the NO-PAPER sentence bearable, and a
 * click does that better — nothing is flashed at anybody, because nobody sees
 * this card without having asked for it.
 *
 * This component was never told about any of it. It is handed a row or handed
 * null, and it has never had to reason about pointers.
 *
 * ── ONE RENDER IN FLIGHT, AND THE OLD ONE IS CANCELLED, NOT AWAITED ─────────
 *
 * Clicking a block, then the next one, then the next is the ordinary gesture
 * here, and pdf.js will happily queue every page it is asked for. So each
 * request cancels the outstanding render and bumps a generation, and a task
 * that resolves for a generation nobody is looking at draws nothing. Without
 * that, walking down a page of forty blocks leaves forty renders racing to
 * paint one canvas and the LAST to finish wins — which is not the one the
 * reader is on.
 *
 * ── IT IS MOUNTED FOR THE LIFE OF THE PANE, AND EVERYTHING BELOW DEPENDS ON
 *    THAT ─────────────────────────────────────────────────────────────────
 *
 * A null row means "show nothing"; it does not mean "go away". Two sections of
 * this header — one worker built once and kept, a cache that makes the second
 * glance at a page free — are claims about state that survives a glance, and
 * they were BOTH FALSE for as long as book-view put this card up behind an @if
 * and took it down every time the card went away. MEASURED, walking ten glances
 * down one book: ten pdf.js workers built, none terminated, every glance
 * re-reading the whole scan over IPC and re-parsing it, 0.7-1.0s each and never
 * falling. Mounted once, the same walk builds ONE worker and costs ~0.2s.
 *
 * The lesson is worth more than the fix: a docblock arguing for an economy is
 * not evidence there is one. Nothing in this file was wrong — the thing that
 * made it a fiction was one @if in a different file.
 *
 * ── THE CACHE IS SMALL ON PURPOSE ──────────────────────────────────────────
 *
 * Every block on a printed page glances at the SAME page, so the second click
 * on a page should cost nothing — but a book is hundreds of pages and a bitmap
 * is megabytes, so this holds CACHE_PAGES of them and evicts the oldest. Twelve
 * is roughly "the spread you are working on and what you just came from", which
 * is the whole of the locality a reader has.
 *
 * page.cleanup() after every render, which is pdf.js's own door for releasing a
 * page's parsed operator list. Without it, a walk through a book leaves every
 * page it touched resident in the worker for as long as the document is open.
 *
 * ── pdf.js IS LOADED ON THE FIRST GLANCE AND NOT BEFORE ─────────────────────
 *
 * app-book-view is NOT deferred — it is what a book tab draws and the app's
 * whole surface leads to it — so a static import of pdf.js here would put half
 * a bundle in the chunk this window boots with, which is precisely what
 * viewer.component.ts defers the PDF branch to avoid. So the import is dynamic,
 * taken the first time somebody actually clicks a block, and a book nobody
 * glances at costs nothing at all.
 *
 * The worker is built the way app-pdf-view builds its own, for the reason its
 * header sets out at length: handing pdf.js a workerSrc sends a packaged build
 * down the blob-wrapper path, into the CSP, and out the other side as a FAKE
 * worker on the UI thread with no word said.
 */
@Component({
  selector: 'app-page-glance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  /*
   * NOTHING TO SHOW IS SHOWN AS NOTHING, in the host and not by unmounting.
   * The card is mounted for the life of the pane (book-view's own comment at
   * the mount says what taking it down cost), so between glances there is a
   * bordered, shadowed, padded box with no content in it — which is a visible
   * empty sliver, not an absence. `.idle` is the absence; see the rule for
   * which flavour of absence it is and why that choice is load-bearing.
   */
  host: { '[class.idle]': 'row() === null' },
  template: `
    @if (row(); as at) {
      @if (sentence(); as said) {
        <p class="says">{{ said }}</p>
      } @else {
        <div class="frame" [style.aspect-ratio]="ratio()">
          <canvas #sheet></canvas>
          <!--
            THE OUTLINE IS IN FRACTIONS OF THE PAGE and not in pixels of the
            canvas, so it is right at every card width and needs no redraw when
            one changes. The box arrives in the render frame the engine measured
            it in — the row's own pageWidth and pageHeight — which is the only
            frame it means anything in: a box divided by anything else is a
            rectangle somewhere near where the block was.
          -->
          @if (mark(); as box) {
            <div
              class="box"
              [style.left.%]="box.left"
              [style.top.%]="box.top"
              [style.width.%]="box.width"
              [style.height.%]="box.height"
            ></div>
          }
        </div>
        <p class="foot">{{ where(at) }}</p>
      }
    }
  `,
  styles: [`
    :host {
      /*
        FIXED TO THE VIEWPORT — Owen's ruling (2026-08-22), and it overrules
        two earlier designs at once: *"the preview of the original document is
        supposed to be outside of the white window and in the gray area.
        instead, it sits on the top right of the document... if i scroll down
        too far it disappears. lots of empty space to the right and it should
        scroll with the document so the user can see it anywhere."*

        The card was INK — absolute in the sheet's coordinates, anchored at
        the clicked block — on the argument that ink rides a scroll instead of
        being chased down one. True, and it produced exactly what Owen met:
        a card parked at the top of a long book, gone the moment the reading
        moved past it. \`position: fixed\` is the design both arguments were
        reaching for: the card stands in the workbench's gray, holds still on
        screen through any scroll, and needs no scroll listener at all —
        viewport coordinates do not move when the bench's inside does.
        book-view writes \`left\`/\`top\` in those coordinates (its placeGlance
        carries the arithmetic and the clamps).

        THE WIDTH IS STILL DECLARED EXACTLY ONCE, HERE, and the placement over
        there READS it off the element rather than keeping a copy. A px
        constant in one file mirroring a rem width in this one drifted the
        moment anybody looked (256 said about a box that renders at 195);
        measured off the thing itself, it cannot drift at all.
      */
      position: fixed;
      z-index: 4;
      display: block;
      width: 15rem;
      padding: 0.5rem 0.5rem 0.4rem;
      border: 1px solid color-mix(in srgb, var(--ink-note) 30%, transparent);
      border-left: 3px solid color-mix(in srgb, var(--ink-note) 65%, transparent);
      border-radius: var(--radius);
      background: var(--paper-high);
      box-shadow: 0 2px 6px rgb(0 0 0 / .18), 0 8px 28px rgb(0 0 0 / .12);
      /*
        IT CATCHES NOTHING, and the reason changed under it without the line
        needing to.

        IT USED TO BE FORCED: the card was put there by a HOVER on the block
        behind it, so a card that took the pointer would have ended that hover
        the instant it appeared, closed itself, reopened on the block and
        flickered forever. A click put an end to that hazard — the peek card
        takes the pointer for exactly this reason and always has.

        IT IS NOW CHOSEN. The card falls back to sitting ON the paper when the
        bench is too narrow to stand it beside one, and there it lies over the
        prose of the very paragraph that was clicked. A box that swallowed
        presses there would make a strip of the book unclickable and unselectable
        with nothing on screen saying why; letting them through means the reader
        clicks the paragraph under the card and the card re-aims at it, which is
        the honest behaviour of a thing that is not really there.
      */
      pointer-events: none;
    }
    /*
      THE IDLE CARD IS HIDDEN BUT STILL LAID OUT, and \`visibility\` rather than
      \`display\` is the whole of that.

      \`display: none\` was right while nothing outside this file needed a number
      from the box — and then the placement started asking the ELEMENT how wide
      it is rather than keeping a copy of the answer (see the \`right\` rule above
      for what a copy cost). A box with no layout has no width, so the FIRST
      click of a session would have measured zero, failed the fit test, and put
      the card on the paper — every time, in the one place a person would call it
      broken rather than narrow.

      What \`display: none\` bought is bought here too: the card is invisible, it
      is out of the accessibility tree, and it takes no pointer. It is absolutely
      positioned, so it takes no room in the flow either — the sliver this rule
      exists to suppress cannot come back through this door.
    */
    :host(.idle) { visibility: hidden; }
    .frame {
      position: relative;
      display: block;
      /*
        A DEFINITE WIDTH, which is the lesson the capture cards cost an evening:
        an item that resolves its cross size from its own aspect ratio does not
        take the stretch, and collapses to zero with the ratio still reading
        correctly in the inspector.
      */
      width: 100%;
      overflow: hidden;
      background: #fff;
      border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    }
    .frame canvas { display: block; width: 100%; height: 100%; }
    .box {
      position: absolute;
      border: 1.5px solid var(--ink-note);
      background: color-mix(in srgb, var(--ink-note) 12%, transparent);
    }
    .says { margin: 0; font-size: 0.8em; line-height: 1.5; color: var(--ink-soft); }
    .foot {
      margin: 0.35rem 0 0;
      font-size: 0.75em;
      color: var(--ink-soft);
    }
  `],
})
export class PageGlanceComponent {
  /**
   * The scan, or null for a book with none — which BookLoad.originalPath
   * documents as two true things at once: a book that arrived as an EPUB and
   * has never had paper, and a project whose archived original is gone. The
   * sentence below is deliberately the same for both, because the fact the
   * reader needs is the same one.
   */
  readonly original = input.required<string | null>();

  /*
   * ── GRAVESTONE: `originalPages` (Wave 41) ─────────────────────────────────
   *
   * A second input stood here naming the folder of photographs a captured book
   * was read off, and it was read ONLY to say a true sentence: this card could
   * not draw a page image, everything below it opens a PDF, so all it changed
   * was WHICH silence the reader was told about.
   *
   * A captured book's original is a PDF now (`recordMint`, electron/projects.ts),
   * so `original` above is non-null for it and the machinery below this line
   * draws the page — the outcome the second input was a placeholder for, reached
   * by giving the book a container instead of teaching the card a second format.
   */

  /** The block to show, or null for a sheet with no card up. */
  readonly row = input.required<BookRow | null>();

  private readonly sheet = viewChild<ElementRef<HTMLCanvasElement>>('sheet');

  /** Bumped per request. A render that finishes for an old one draws nothing. */
  private generation = 0;
  private task: { cancel(): void } | null = null;
  /**
   * The open document, held as its promise so two glances share one open — AND
   * THE SCAN IT IS THE OPEN OF.
   *
   * The path is half the value and not bookkeeping. This card outlives any one
   * glance now, so it can outlive the BOOK: a pane whose load changes hands
   * this component a different `original`, and a held promise that remembered
   * only "a document is open" would answer the new book's rests with pages of
   * the old one — the same picture, no error, and nothing on the card to say
   * which scan it came from. Keyed by path, a changed path is a miss.
   */
  private opening: { scan: string; doc: Promise<GlanceDocument> } | null = null;
  private engine: GlanceEngine | null = null;
  /** Page number to bitmap, oldest first. Evicted at CACHE_PAGES. */
  private readonly cache = new Map<number, ImageBitmap>();
  /** The engine's own words when a page would not open. Never paraphrased. */
  private readonly failure = signal<string | null>(null);

  /**
   * WHY THERE IS NO PAGE, when there is not one — and null when there is.
   *
   * Two causes and ONE sentence, because the reader's question is "can this book
   * show me its paper" and the answer is no in both. A book with no original at
   * all is an EPUB or a project that has lost its scan; a row with page 0 is the
   * no-page frame the engine writes for a block that came out of a container
   * rather than off a sheet (BookRow.page).
   */
  protected readonly sentence = computed<string | null>(() => {
    const at = this.row();
    if (at === null) return null;
    /*
     * A CAPTURED-BOOK ARM STOOD HERE (Wave 41's gravestone) saying that this
     * book was read off photographed pages and the card could not show one. It
     * existed because the sentence below is FALSE about such a book: its paper
     * exists and was photographed page by page, and saying "it arrived as a book
     * rather than as a scan" over a project holding two dozen photographs would
     * be the app telling a reader something it can see is untrue.
     *
     * There is no such book any more. A mint's pages are bound into a PDF, so a
     * captured book reaches the ordinary path and this card draws its paper.
     */
    if (this.original() === null || at.page <= 0) {
      return 'This book has no paper behind it — it arrived as a book rather than as a scan, '
        + 'so there is no photograph of this block to show.';
    }
    return this.failure();
  });

  /** The page's shape, so the frame is the right height before a pixel is drawn. */
  protected readonly ratio = computed<string>(() => {
    const at = this.row();
    if (at === null || at.pageWidth <= 0 || at.pageHeight <= 0) return '3 / 4';
    return `${at.pageWidth} / ${at.pageHeight}`;
  });

  /**
   * The block's box as percentages of the page — or null where drawing one
   * would be a lie.
   *
   * NO OUTLINE ON A ROW THAT SPANS PAGES, and this is not fussiness. A merged
   * block's box is COMPOSED: origin from the first part, height SUMMED, width
   * the union (BookBox, shared/book.ts). So a paragraph the printer broke across
   * a leaf has a box taller than the page it starts on, and outlining it would
   * draw a rectangle running off the bottom of the sheet and stopping nowhere in
   * particular. The page is still worth showing — it IS where the paragraph
   * begins — and the footer says it carried on, which is the true thing a box
   * cannot say.
   */
  protected readonly mark = computed<Outline | null>(() => {
    const at = this.row();
    if (at === null || at.pages.length > 1) return null;
    if (at.pageWidth <= 0 || at.pageHeight <= 0) return null;
    const { x1, y1, x2, y2 } = at.box;
    return {
      left: (x1 / at.pageWidth) * 100,
      top: (y1 / at.pageHeight) * 100,
      width: ((x2 - x1) / at.pageWidth) * 100,
      height: ((y2 - y1) / at.pageHeight) * 100,
    };
  });

  /** What the footer says: one page, or the run of them this block crossed. */
  protected where(at: BookRow): string {
    if (at.pages.length > 1) {
      return `Printed across pages ${at.pages.join(', ')} — the outline is left off, `
        + 'because a block that crossed a leaf has no one rectangle.';
    }
    return `Page ${at.page}`;
  }

  constructor() {
    /*
     * THE ONE EFFECT, and it is the whole engine of the component: a row
     * arrived, so draw its page. It reads `row` and `original` and nothing else,
     * so a change to either re-runs it — and MOVING the card does not. That is
     * what makes book-view's re-placement on a pane resize free: the two
     * placement signals are written, the row is not, and no page is re-rendered
     * by dragging a window edge or opening the inspector.
     */
    effect(() => {
      const at = this.row();
      const scan = this.original();
      this.generation += 1;
      const mine = this.generation;
      this.task?.cancel();
      this.task = null;
      this.failure.set(null);
      if (at === null || scan === null || at.page <= 0) return;
      void this.draw(scan, at.page, mine);
    });

    /*
     * The worker is a THREAD and the document is memory in it; a pane that
     * closes without saying so leaves both running for the life of the window.
     * Nothing above this line is reachable after destroy, so the generation
     * bump is enough to make any render still in flight drop what it produces.
     */
    inject(DestroyRef).onDestroy(() => {
      this.generation += 1;
      this.task?.cancel();
      this.task = null;
      for (const bitmap of this.cache.values()) bitmap.close();
      this.cache.clear();
      this.release();
    });
  }

  /**
   * Let go of the open document and the thread it was parsed on, in that order.
   *
   * ORDER, BECAUSE THE DOCUMENT LIVES IN THE WORKER: terminating the thread
   * first leaves `destroy()` waiting on a reply from something that no longer
   * exists. The failures are swallowed by design — this runs when a pane is
   * already going away, and there is nobody left to tell.
   */
  private release(): void {
    const open = this.opening;
    const engine = this.engine;
    this.opening = null;
    this.engine = null;
    const stop = (): void => { engine?.thread.terminate(); };
    if (open === null) { stop(); return; }
    void open.doc.then((doc) => doc.destroy()).catch(() => undefined).then(stop);
  }

  /**
   * Open the scan once, then paint one page of it.
   *
   * THE CANVAS IS LOOKED UP AFTER THE AWAITS AND NOT BEFORE, because on the
   * first glance of a session there is no canvas yet: the template only renders
   * the frame once a row is set, and this effect runs in that same turn. By the
   * time a page has been decoded the view exists, and a generation that has
   * moved on is dropped before anything is touched.
   *
   * THE CACHE HIT PAINTS IN THAT SAME TURN AND IT IS FINE — measured, because
   * it is the one path that does not await anything and the paragraph above
   * reads like a reason it should fail. Now that the card outlives a glance its
   * cache can be hit, so this was worth proving rather than routing around: the
   * draw was rewritten to hand the bitmap to a signal an effect painted, the
   * old direct draw was put BACK IN and measured against repeat glances, and it
   * painted every time. Angular has refreshed the view by then. The indirection
   * bought nothing and was dropped. Cache hits land at ~210ms against a probe
   * whose own floor is 210ms; a fresh render of a page from an open document is
   * 500-650ms, which is the gap that tells the two apart.
   */
  private async draw(scan: string, page: number, mine: number): Promise<void> {
    try {
      const held = this.cache.get(page);
      if (held !== undefined) {
        this.paint(held, mine);
        return;
      }
      const engine = await this.load();
      if (mine !== this.generation) return;
      const doc = await this.open(engine, scan);
      if (mine !== this.generation) return;
      if (page > doc.numPages) {
        /*
         * A ROW POINTING PAST THE END OF ITS OWN SCAN, said rather than drawn
         * around. `BookRow.page` is documented as an ESTIMATE and never an
         * address, so this is reachable without anything being broken — and a
         * card that silently drew the last page instead would be this app
         * telling a reader they are looking at their block when they are not.
         */
        this.failure.set(
          `This block is recorded on page ${page}, and the scan behind this book has `
          + `${doc.numPages}. Nothing is drawn rather than a page that is not the one asked for.`,
        );
        return;
      }
      const sheet = await doc.getPage(page);
      let bitmap: ImageBitmap | null = null;
      try {
        if (mine !== this.generation) return;
        bitmap = await this.rasterise(sheet, mine);
      } finally {
        sheet.cleanup();
      }
      if (bitmap === null || mine !== this.generation) return;
      this.keep(page, bitmap);
      this.paint(bitmap, mine);
    } catch (err) {
      if (mine !== this.generation) return;
      // By name and never swallowed: a card showing nothing with no reason on it
      // is the failure this app refuses to ship (ARCHITECTURE §8).
      this.failure.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * pdf.js, on the first glance of this pane's life.
   *
   * Built once and kept, so the worker is one thread rather than one per glance.
   * The second caller to arrive while the import is in flight gets its own await
   * of the same dynamic import, which the module system already dedupes.
   */
  private async load(): Promise<GlanceEngine> {
    if (this.engine !== null) return this.engine;
    const assets = new URL('pdfjs/', document.baseURI);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfModule;
    if (this.engine !== null) return this.engine;
    const thread = new Worker(new URL('pdf.worker.min.mjs', assets), { type: 'module' });
    this.engine = {
      assets,
      getDocument: pdfjs.getDocument,
      worker: pdfjs.PDFWorker.create({ name: 'foundry-glance', port: thread }),
      thread,
    };
    return this.engine;
  }

  private async open(engine: GlanceEngine, scan: string): Promise<GlanceDocument> {
    const already = this.opening;
    if (already !== null && already.scan === scan) return await already.doc;
    /*
     * A DIFFERENT SCAN CLOSES THE OLD ONE FIRST. Dropping the reference alone
     * would leave the previous book's document parsed in the worker for as long
     * as this pane lives, which is the same leak as the one the destroy hook
     * closes, arrived at from the other direction.
     */
    if (already !== null) {
      this.opening = null;
      void already.doc.then((doc) => doc.destroy()).catch(() => undefined);
    }
    const opening = (async (): Promise<GlanceDocument> => {
      if (api === null || api === undefined) {
        throw new Error('This window is not running inside Foundry, so it cannot read the scan.');
      }
      const bytes = await api.documentBytes(scan);
      return await engine.getDocument({
        data: bytes,
        worker: engine.worker,
        // The same runtime data app-pdf-view passes, for its reason: without
        // them an unusual scan renders blank and says nothing at all.
        cMapUrl: new URL('cmaps/', engine.assets).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', engine.assets).href,
        wasmUrl: new URL('wasm/', engine.assets).href,
        iccUrl: new URL('iccs/', engine.assets).href,
      }).promise;
    })();
    /*
     * THE FAILED OPEN IS NOT REMEMBERED. A held rejected promise would answer
     * every later glance with the first failure forever, so a scan that was
     * momentarily unreadable — a drive asleep, a file mid-copy — would stay
     * broken for the life of the pane. The sentence is still shown; only the
     * memory of it is dropped.
     */
    this.opening = { scan, doc: opening };
    try {
      return await opening;
    } catch (err) {
      if (this.opening?.doc === opening) this.opening = null;
      throw err;
    }
  }

  /** One page to a bitmap at the card's own width, or null if it was cancelled. */
  private async rasterise(sheet: GlancePage, mine: number): Promise<ImageBitmap | null> {
    const unit = sheet.getViewport({ scale: 1 });
    if (unit.width <= 0) return null;
    const scale = (CARD_WIDTH_PX * devicePixelRatio) / unit.width;
    const viewport = sheet.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d');
    if (context === null) return null;
    const task = sheet.render({ canvas, canvasContext: context, viewport });
    this.task = task;
    try {
      await task.promise;
    } catch (err) {
      // A cancelled render is this component working correctly — the reader
      // clicked the next block — and is not a sentence anybody should be shown.
      if (err instanceof Error && err.name === 'RenderingCancelledException') return null;
      throw err;
    } finally {
      if (this.task === task) this.task = null;
    }
    if (mine !== this.generation) return null;
    return await createImageBitmap(canvas);
  }

  /** Newest in, oldest out. See the header for why twelve. */
  private keep(page: number, bitmap: ImageBitmap): void {
    this.cache.set(page, bitmap);
    while (this.cache.size > CACHE_PAGES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.get(oldest.value)?.close();
      this.cache.delete(oldest.value);
    }
  }

  private paint(bitmap: ImageBitmap, mine: number): void {
    if (mine !== this.generation) return;
    const canvas = this.sheet()?.nativeElement;
    if (canvas === undefined) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.drawImage(bitmap, 0, 0);
  }
}

interface Outline {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How wide the page is rastered, in CSS pixels.
 *
 * A CEILING RATHER THAN A MATCH, and deliberately not read off the frame: the
 * canvas is drawn at `width: 100%` of a frame the stylesheet sizes, so this only
 * has to be AT LEAST that wide for the page to be sharp. Measured at 179 CSS px
 * on a 13px-root window; 224 covers a larger root font without a second
 * measurement, and over-rendering by a quarter costs a fraction of a frame.
 *
 * It is also why this number CANNOT drift into a defect the way the placement
 * constant did: too small and the page is soft, which is visible; there is no
 * value of it that puts the card in the wrong place.
 */
const CARD_WIDTH_PX = 224;
/** Pages held as bitmaps. See the header: the locality of a person reading. */
const CACHE_PAGES = 12;

/*
 * ── The narrowest types this file can do its work through ───────────────────
 *
 * Declared here rather than imported from pdfjs-dist's deep type paths, which is
 * the choice app-pdf-view already made and for a reason that is sharper here:
 * the import is DYNAMIC, and a static type import from the package is the one
 * line that could pull it back into this chunk and undo the split.
 */
interface GlancePage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}

interface GlanceDocument {
  numPages: number;
  getPage(number: number): Promise<GlancePage>;
  destroy(): Promise<void>;
}

interface PdfModule {
  getDocument(opts: Record<string, unknown>): { promise: Promise<GlanceDocument> };
  PDFWorker: { create(opts: { name: string; port: Worker }): unknown };
}

interface GlanceEngine {
  assets: URL;
  getDocument: PdfModule['getDocument'];
  worker: unknown;
  /**
   * The thread itself, kept beside pdf.js's handle to it. `PDFWorker` is
   * `unknown` here on purpose — this file declares only what it calls — and a
   * thread that must be terminated on destroy is a thing this file calls.
   */
  thread: Worker;
}

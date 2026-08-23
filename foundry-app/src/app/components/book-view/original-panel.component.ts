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
  untracked,
  viewChild,
} from '@angular/core';

import type { BookRow } from '@shared/book';
import { api } from '../../core/foundry';

/**
 * THE ORIGINAL PDF, DOCKED BESIDE THE BOOK — a full page of the scan, standing
 * in the workbench's gray to the right of the paper, following the reading.
 *
 * ── What was asked for, and what it replaces ────────────────────────────────
 *
 * Owen, 2026-08-23: *"instead of having a little preview pop up, we should
 * make it a full-page comparison that i can choose to pop up to the right of
 * the workspace, in that gray area… and i can scroll through and see what the
 * original looked like."* And the correction that names this file: *"shouldnt
 * be facsimile comparison, it should be pdf comparison. facsimile is created
 * after dots runs… i want the original pdf comparison, so i know what im
 * looking at and how to correct it if dots makes a mistake."*
 *
 * So this is the page-glance card, grown up and moved house. The card was
 * 15rem of fixed-position paper that appeared beside a clicked block; this is
 * a COLUMN of the pane, toggled from the head row, showing the whole printed
 * page at a width a person can read. What it shows is `BookLoad.originalPath`
 * — the document the reading photographed, the same source the card always
 * drew — which for a captured book is the minted PDF and for a scanned one is
 * the archived original. NEVER the facsimile: the facsimile is derived from
 * the bank AFTER the model read the pages, so a mistake the model made is IN
 * it, and a comparison against it would show the reader the error agreeing
 * with itself.
 *
 * ── FOLLOWING, AND PARKING ──────────────────────────────────────────────────
 *
 * The panel follows the reading: book-view aims it at the topmost block on the
 * bench as the bench scrolls, and at the block a click selects. Its page is
 * that block's page, and the view nudges so the block's printed box sits near
 * the top of the panel — "pretty close" to level with the words on the sheet,
 * which is what reflowed prose against printed pages can honestly offer.
 *
 * The steppers park it: a person hunting a chapter head pages freely, the
 * caption says whose page is up, and ⌖ (or any new aim from the bench — a
 * scroll, a click) brings it home. That is the glance's own browse/home
 * design, kept because the chapter hunt that motivated it did not go away
 * when the card grew.
 *
 * ── EVERYTHING BELOW THE TEMPLATE IS THE GLANCE'S ENGINE, KEPT WHOLE ────────
 *
 * One pdf.js worker built on first use and kept for the panel's life; the open
 * document held as a promise KEYED BY PATH so a pane whose load changes hands
 * cannot serve the old book's pages; a small bitmap cache, oldest out; one
 * render in flight and the old one cancelled, not awaited; `page.cleanup()`
 * after every render. Each of those is argued at length in the glance's
 * history (./page-glance, now retired into this file) and the arguments moved
 * here with the code. The one deliberate difference is size: pages raster at
 * `PANEL_WIDTH_PX` instead of a card's 224, so the cache holds fewer of them
 * (`CACHE_PAGES`) for the same memory.
 *
 * IT IS MOUNTED FOR THE LIFE OF THE PANE and hidden by the host's `.closed`
 * class, never unmounted by the toggle — the glance's own measured lesson: an
 * `@if` around a component that promises "one worker, built once" rebuilds
 * the worker and empties the cache every time the condition blinks. book-view
 * passes `row: null` while the panel is closed, so a closed panel draws
 * nothing and costs nothing, and its worker, document and cache are warm the
 * moment it opens again.
 */
@Component({
  selector: 'app-original-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="strip">
      <button
        type="button"
        class="step"
        aria-label="Previous page"
        [disabled]="shown() <= 1"
        (click)="flip(-1)"
      >‹</button>
      <span class="foot">{{ caption() }}</span>
      @if (browse() !== null) {
        <button
          type="button"
          class="step"
          aria-label="Back to the reading position"
          title="Back to the reading position"
          (click)="home()"
        >⌖</button>
      }
      <button
        type="button"
        class="step"
        aria-label="Next page"
        [disabled]="count() !== null && shown() >= count()!"
        (click)="flip(1)"
      >›</button>
    </div>
    @if (sentence(); as said) {
      <p class="says">{{ said }}</p>
    } @else if (row() !== null) {
      <!--
        THE PAGE SCROLLS INSIDE ITS OWN BOX. The panel is a column of the
        pane's height and a printed page at reading width is taller than it,
        so the scroller is where the rest of the page lives — a plain
        overflow, so the mouse wheel over the panel does what a wheel over a
        tall thing does everywhere, with no listener written for it.
      -->
      <div class="frames" #frames>
        <div class="frame" [style.aspect-ratio]="ratio()">
          <canvas #sheet></canvas>
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
      </div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      /*
        THE PANEL'S ONE DECLARED WIDTH. A fraction of the pane with a floor a
        page is still readable at and a ceiling that keeps the bench the wider
        partner — the paper is the work and this is the reference. The bench
        beside it keeps its own scroller and its sheet re-centres in what is
        left, which is the "gray area" of the ruling giving some of itself up.

        (This comment once ended with an HTML closer instead of this CSS one —
        one character of template muscle-memory, and the parser silently ate
        every rule from here to the middle of .frame: no .closed, no flex
        basis, a white host, a bench squeezed to zero. The gates cannot see a
        wrong terminator inside a string; the running page named it.)
      */
      flex: 0 0 clamp(16rem, 28vw, 30rem);
      border-left: 1px solid color-mix(in srgb, var(--ink-note) 30%, transparent);
      background: var(--bench);
    }
    :host(.closed) { display: none; }
    .strip {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.6rem;
      border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
      color: var(--ink-soft);
    }
    .step {
      flex: none;
      width: 1.35rem;
      height: 1.35rem;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
      border-radius: var(--radius);
      background: transparent;
      color: inherit;
      font-size: 0.9em;
      line-height: 1;
      cursor: pointer;
    }
    .step:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent); }
    .step:disabled { opacity: 0.35; cursor: default; }
    .foot { flex: 1; font-size: 0.75em; }
    .frames {
      flex: 1 1 0;
      min-height: 0;
      overflow: hidden auto;
      padding: 0.6rem;
      scrollbar-width: thin;
    }
    .frame {
      position: relative;
      /* A DEFINITE WIDTH — the capture cards' lesson: an item sized only by
         its own aspect ratio collapses to zero with the ratio still reading
         correctly in the inspector. */
      width: 100%;
      background: #fff;
      border: 1px solid rgb(0 0 0 / 0.25);
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
    }
    .frame canvas { display: block; width: 100%; height: 100%; }
    .box {
      position: absolute;
      border: 1.5px solid var(--ink-note);
      background: color-mix(in srgb, var(--ink-note) 12%, transparent);
    }
    .says {
      margin: 0;
      padding: 1rem;
      font-size: 0.8em;
      line-height: 1.5;
      color: var(--ink-soft);
    }
  `],
})
export class OriginalPanelComponent {
  /**
   * The scan, or null for a book with none — `BookLoad.originalPath`'s two
   * true things at once: a book that arrived as an EPUB and has never had
   * paper, and a project whose archived original is gone.
   */
  readonly original = input.required<string | null>();

  /**
   * The block the reading is at — the panel's aim. book-view sets it from the
   * click that selects a block and from the bench's own scroll, and passes
   * null while the panel is closed so a hidden panel renders nothing.
   */
  readonly row = input.required<BookRow | null>();

  /**
   * THE PAGE SOMEBODY TURNED TO, or null while the panel follows the reading.
   * The steppers write it; a new aim from the bench clears it (the first
   * effect in the constructor), and so does ⌖. Null rather than a copy of the
   * block's page, so "following" and "parked where it happens to be" stay two
   * different states — the outline and the nudge exist only in the first.
   */
  protected readonly browse = signal<number | null>(null);
  /** How many pages the open scan has — known after the first draw. */
  protected readonly count = signal<number | null>(null);
  /** The page on the panel right now: turned-to, or the reading's own. */
  protected readonly shown = computed<number>(() => this.browse() ?? this.row()?.page ?? 0);

  private readonly frames = viewChild<ElementRef<HTMLElement>>('frames');
  private readonly sheet = viewChild<ElementRef<HTMLCanvasElement>>('sheet');

  /** Bumped per request. A render that finishes for an old one draws nothing. */
  private generation = 0;
  private task: { cancel(): void } | null = null;
  /** The open document as its promise, KEYED BY THE SCAN IT IS THE OPEN OF. */
  private opening: { scan: string; doc: Promise<PanelDocument> } | null = null;
  private engine: PanelEngine | null = null;
  /** Page number to bitmap, oldest first. Evicted at CACHE_PAGES. */
  private readonly cache = new Map<number, ImageBitmap>();
  /** The engine's own words when a page would not open. Never paraphrased. */
  private readonly failure = signal<string | null>(null);

  /**
   * WHY THERE IS NO PAGE, when there is not one — and null when there is.
   * A book with no original at all is an EPUB or a project that has lost its
   * scan; a row with page 0 is the no-page frame the engine writes for a block
   * that came out of a container rather than off a sheet (BookRow.page).
   */
  protected readonly sentence = computed<string | null>(() => {
    const at = this.row();
    if (at === null) return null;
    if (this.original() === null || at.page <= 0) {
      return 'This book has no paper behind it — it arrived as a book rather than as a scan, '
        + 'so there is no original page to stand beside it.';
    }
    return this.failure();
  });

  /** The page's shape, so the frame is the right height before a pixel lands. */
  protected readonly ratio = computed<string>(() => {
    const at = this.row();
    if (at === null || at.pageWidth <= 0 || at.pageHeight <= 0) return '3 / 4';
    return `${at.pageWidth} / ${at.pageHeight}`;
  });

  /**
   * The aimed block's box as percentages of the page — or null where drawing
   * one would be a lie: a row that spans pages has a COMPOSED box taller than
   * the page it starts on; a parked panel is showing some other page; an
   * empty box is a block nothing measured.
   */
  protected readonly mark = computed<Outline | null>(() => {
    const at = this.row();
    if (at === null || at.pages.length > 1) return null;
    if (at.pageWidth <= 0 || at.pageHeight <= 0) return null;
    if (this.browse() !== null) return null;
    const { x1, y1, x2, y2 } = at.box;
    if (x2 <= x1 || y2 <= y1) return null;
    return {
      left: (x1 / at.pageWidth) * 100,
      top: (y1 / at.pageHeight) * 100,
      width: ((x2 - x1) / at.pageWidth) * 100,
      height: ((y2 - y1) / at.pageHeight) * 100,
    };
  });

  /** What the strip says: where the panel is parked, or where the reading is. */
  protected caption(): string {
    const total = this.count();
    const pages = total === null ? '' : ` of ${total}`;
    if (this.browse() !== null) return `Page ${this.shown()}${pages}`;
    const at = this.row();
    if (at === null) return 'The original';
    if (at.pages.length > 1) return `Pages ${at.pages.join(', ')} — reading`;
    return `Page ${at.page}${pages} — reading`;
  }

  /** Turn the page, clamped to the scan; landing on the reading's page IS home. */
  protected flip(delta: number): void {
    const at = this.row();
    if (at === null) return;
    const total = this.count();
    const next = Math.max(1, Math.min(total ?? Number.MAX_SAFE_INTEGER, this.shown() + delta));
    if (next === this.shown()) return;
    this.browse.set(next === at.page ? null : next);
  }

  /** Back to the reading position — the nudge included, which a bare page match is not. */
  protected home(): void {
    this.browse.set(null);
    requestAnimationFrame(() => { this.nudge(); });
  }

  constructor() {
    // A NEW AIM BRINGS THE PANEL HOME — the bench scrolled or a block was
    // clicked, and a panel parked three pages into a hunt would answer the new
    // place with the wrong sheet.
    effect(() => {
      this.row();
      untracked(() => { this.browse.set(null); });
    });

    /*
     * THE ONE DRAWING EFFECT: an aim arrived or a page was turned, so draw
     * that page. It reads `row`, `original` and `shown` and nothing else, so
     * layout changes around the panel re-render nothing.
     */
    effect(() => {
      const at = this.row();
      const scan = this.original();
      const page = this.shown();
      this.generation += 1;
      const mine = this.generation;
      this.task?.cancel();
      this.task = null;
      this.failure.set(null);
      if (at === null || scan === null || page <= 0) return;
      void this.draw(scan, page, mine);
    });

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
   * Let go of the open document and the thread it was parsed on, in that
   * order — terminating the thread first leaves `destroy()` waiting on a
   * reply from something that no longer exists.
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
   * SCROLL THE PAGE SO THE AIMED BLOCK IS WHERE THE EYE IS — the "pretty
   * close" of the ruling. The frame's height is settled by its aspect ratio
   * (row data, not the render), so this can run the frame after an aim
   * without waiting on pdf.js; the box's top lands about a quarter down the
   * panel, which is where the topmost block on the bench stands too.
   *
   * ONLY WHILE FOLLOWING. A parked panel is somewhere the person chose, and
   * scrolling it under them would be the panel disagreeing about that.
   */
  private nudge(): void {
    if (this.browse() !== null) return;
    const at = this.row();
    const scroller = this.frames()?.nativeElement;
    if (at === null || scroller === undefined) return;
    if (at.pageHeight <= 0 || at.pages.length > 1) { scroller.scrollTop = 0; return; }
    const frame = scroller.firstElementChild;
    if (!(frame instanceof HTMLElement)) return;
    const target = frame.clientHeight * (at.box.y1 / at.pageHeight)
      - scroller.clientHeight * 0.25;
    scroller.scrollTop = Math.max(0, target);
  }

  /** Open the scan once, then paint one page of it. See the glance's history
   *  for why the canvas is looked up after the awaits and why the cache hit
   *  may paint in the same turn (measured; Angular has refreshed the view). */
  private async draw(scan: string, page: number, mine: number): Promise<void> {
    try {
      const held = this.cache.get(page);
      if (held !== undefined) {
        this.paint(held, mine);
        requestAnimationFrame(() => { if (mine === this.generation) this.nudge(); });
        return;
      }
      const engine = await this.load();
      if (mine !== this.generation) return;
      const doc = await this.open(engine, scan);
      if (mine !== this.generation) return;
      this.count.set(doc.numPages);
      if (page > doc.numPages) {
        // A row pointing past the end of its own scan, said rather than drawn
        // around — BookRow.page is an ESTIMATE and never an address.
        this.failure.set(this.row()?.page === page
          ? `This block is recorded on page ${page}, and the scan behind this book has `
            + `${doc.numPages}. Nothing is drawn rather than a page that is not the one asked for.`
          : `The scan behind this book has ${doc.numPages} page(s), and page ${page} is past its end.`);
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
      requestAnimationFrame(() => { if (mine === this.generation) this.nudge(); });
    } catch (err) {
      if (mine !== this.generation) return;
      // By name and never swallowed: a panel showing nothing with no reason on
      // it is the failure this app refuses to ship (ARCHITECTURE §8).
      this.failure.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** pdf.js, on the panel's first page — built once and kept, one thread. */
  private async load(): Promise<PanelEngine> {
    if (this.engine !== null) return this.engine;
    const assets = new URL('pdfjs/', document.baseURI);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfModule;
    if (this.engine !== null) return this.engine;
    const thread = new Worker(new URL('pdf.worker.min.mjs', assets), { type: 'module' });
    this.engine = {
      assets,
      getDocument: pdfjs.getDocument,
      worker: pdfjs.PDFWorker.create({ name: 'foundry-original', port: thread }),
      thread,
    };
    return this.engine;
  }

  private async open(engine: PanelEngine, scan: string): Promise<PanelDocument> {
    const already = this.opening;
    if (already !== null && already.scan === scan) return await already.doc;
    // A DIFFERENT SCAN CLOSES THE OLD ONE FIRST, and the old book's pixels go
    // with its document: the cache is keyed by page number alone, so across a
    // change of scan every key is a lie.
    if (already !== null) {
      this.opening = null;
      void already.doc.then((doc) => doc.destroy()).catch(() => undefined);
      for (const bitmap of this.cache.values()) bitmap.close();
      this.cache.clear();
      this.count.set(null);
    }
    const opening = (async (): Promise<PanelDocument> => {
      if (api === null || api === undefined) {
        throw new Error('This window is not running inside Foundry, so it cannot read the scan.');
      }
      const bytes = await api.documentBytes(scan);
      return await engine.getDocument({
        data: bytes,
        worker: engine.worker,
        cMapUrl: new URL('cmaps/', engine.assets).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', engine.assets).href,
        wasmUrl: new URL('wasm/', engine.assets).href,
        iccUrl: new URL('iccs/', engine.assets).href,
      }).promise;
    })();
    // THE FAILED OPEN IS NOT REMEMBERED — a held rejected promise would answer
    // every later aim with the first failure forever.
    this.opening = { scan, doc: opening };
    try {
      return await opening;
    } catch (err) {
      if (this.opening?.doc === opening) this.opening = null;
      throw err;
    }
  }

  /** One page to a bitmap at the panel's own width, or null if cancelled. */
  private async rasterise(sheet: PanelPage, mine: number): Promise<ImageBitmap | null> {
    const unit = sheet.getViewport({ scale: 1 });
    if (unit.width <= 0) return null;
    const scale = (PANEL_WIDTH_PX * devicePixelRatio) / unit.width;
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
      // moved on — and is not a sentence anybody should be shown.
      if (err instanceof Error && err.name === 'RenderingCancelledException') return null;
      throw err;
    } finally {
      if (this.task === task) this.task = null;
    }
    if (mine !== this.generation) return null;
    return await createImageBitmap(canvas);
  }

  /** Newest in, oldest out. */
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
 * How wide the page is rastered, in CSS pixels — a ceiling over the widest the
 * panel's clamp can reach (30rem at a 16px root is 480), so the page is sharp
 * at every width the column can take. Too small is soft and visible; there is
 * no value of this that draws the page in the wrong place.
 */
const PANEL_WIDTH_PX = 520;
/**
 * Pages held as bitmaps. Fewer than the glance's twelve because each one is
 * more than five times the pixels; the locality is the same — the spread being
 * worked on and what the reader just came from.
 */
const CACHE_PAGES = 6;

/*
 * ── The narrowest types this file can do its work through ───────────────────
 * Declared rather than imported from pdfjs-dist's deep type paths: the import
 * is DYNAMIC, and a static type import from the package is the one line that
 * could pull it back into this chunk and undo the split.
 */
interface PanelPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}

interface PanelDocument {
  numPages: number;
  getPage(number: number): Promise<PanelPage>;
  destroy(): Promise<void>;
}

interface PdfModule {
  getDocument(opts: Record<string, unknown>): { promise: Promise<PanelDocument> };
  PDFWorker: { create(opts: { name: string; port: Worker }): unknown };
}

interface PanelEngine {
  assets: URL;
  getDocument: PdfModule['getDocument'];
  worker: unknown;
  /** The thread itself, kept beside pdf.js's handle — a thing destroy calls. */
  thread: Worker;
}

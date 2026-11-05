import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
/*
 * The LEGACY build, and it is a requirement, not a hedge. pdf.js v6's modern
 * build calls `Uint8Array.prototype.toHex` — a JavaScript method newer than the
 * Chromium inside this app's Electron — so the first thing it does with a file
 * (fingerprint it) dies with "toHex is not a function" before a page exists.
 * The legacy build carries its own polyfills. The worker in angular.json's
 * assets comes from the same legacy directory for the same reason: the main
 * thread and the worker are the same codebase and fail the same way.
 */
import {
  PDFWorker,
  Util,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PageViewport,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

import { ComparePickerComponent } from '../compare/compare-picker.component';
import { OpenDocumentsService, type Tab } from '../../core/documents.service';
import { api } from '../../core/foundry';
import { PageBox, Shell, Match, PageText, TextItem, PdfPage, PDFJS_ASSETS, ZOOM_STEPS, WHEEL_RATE, THUMB_WIDTH, pageOf, layoutText } from './pdf-view.model';
import * as search from './pdf-view.search';
import * as drawing from './pdf-view.draw';

/**
 * The scan — rendered here rather than by Chromium, so the app can show the
 * thing the engine actually wrote.
 *
 * WHY THIS EXISTS AT ALL is two complaints the <iframe> could not answer. Its
 * thumbnail rail is nailed to the left edge, cannot be moved, restyled or
 * turned off from outside the plugin, and eats a column of a window whose whole
 * job is showing a page. And there is no way to SEE WHAT A PAGE'S TEXT ACTUALLY
 * IS: a viewer draws glyphs, and the question this app is usually asking of a
 * converted book is what a copy-and-paste or a search would find in it, which
 * is not the same question. That mattered most when foundry's PDF conversion
 * wrote text in rendering mode 3 and Chromium drew nothing at all; it still
 * matters now that the text is visible, because a reprint whose words are right
 * and whose ORDER is wrong looks perfect and copies as nonsense. The strip here
 * is along the BOTTOM, on by default and one click to dismiss; the layer view
 * (below) is the other half.
 *
 * ── The worker ───────────────────────────────────────────────────────────────
 *
 * pdf.js runs its parser in a Worker, and this file CONSTRUCTS THAT WORKER
 * ITSELF rather than handing pdf.js a `GlobalWorkerOptions.workerSrc`. That is
 * not a preference. pdf.js checks whether the worker URL is same-origin with
 * the page (`PDFWorker._isSameOrigin`), and a packaged Electron renderer is a
 * `file://` document whose origin is the string "null" — so the check fails for
 * every URL, always, and pdf.js falls back to wrapping the worker in a `blob:`
 * URL meant for CDN loads. `script-src 'self'` refuses a blob worker, pdf.js
 * catches the failure and silently sets up a FAKE worker on the main thread,
 * and a 600-page scan then parses in the UI thread with nothing said. That is
 * precisely the quiet degradation ARCHITECTURE §8 exists to forbid. Passing our
 * own `Worker` as a port skips the origin check, the blob and the fallback.
 *
 * The worker and pdf.js's runtime data (cmaps, standard fonts, the JPX/JBIG2
 * wasm, ICC profiles) are copied into `dist/renderer/browser/pdfjs/` by
 * angular.json's `assets`, and addressed off `document.baseURI` — `/pdfjs/…`
 * under `ng serve`, `./pdfjs/…` beside index.html when packaged. Nothing is
 * fetched from a CDN, because this app is expected to work on a machine that
 * has never had a network. The data files are not optional decoration: a scan
 * with JPEG 2000 images renders as blank pages without the wasm, and a blank
 * page is indistinguishable from a broken one.
 *
 * ── The bytes ────────────────────────────────────────────────────────────────
 *
 * `api.documentBytes(path)` — IPC, not `fetch` on `foundry-file://`. The
 * argument is in electron/ipc.ts beside the handler; the short version is that
 * the page is served under `connect-src 'self'` and the allow-list is the same
 * one either way.
 *
 * ── The layer view ───────────────────────────────────────────────────────────
 *
 * The button beside "Thumbnails" splits the pane: the rendered page on the
 * left, and on the right the SAME text items, positioned by the same arithmetic
 * at the same scale, but drawn in ink on paper instead of in nothing. A layer
 * that sits where the ink does not is then visible at a glance rather than only
 * to a search that comes back empty.
 *
 * BOTH PANES ARE LAID OUT BY ONE FUNCTION (`layoutText`), and that is the whole
 * point of the feature. If the visible pane derived its positions separately it
 * could be wrong in its own way, and the user would be checking the checker.
 * The two differ by a CSS class and nothing else.
 *
 * The panes are kept together by COPYING scrollTop, not by matching a scroll
 * fraction. They hold the same page boxes at the same size with the same gaps,
 * so their scroll heights are equal by construction and one number keeps them
 * aligned line for line. A fraction would only agree at the two ends and drift
 * everywhere a fraction of a differing height is not a fraction of the other.
 *
 * WHAT IS NOT DONE HERE: the layer view does NOT try to tell foundry's text
 * from anybody else's. It was considered back when every stream the conversion
 * wrote carried a `/FoundryTextLayer` mark, and it was out then for two reasons
 * — the renderer would need raw page objects pdf.js does not expose, and the
 * question is the wrong one. This pane shows THE text of the document in front
 * of you, whatever put it there. The mark is gone now (the conversion builds a
 * whole document rather than marking streams inside somebody else's), which
 * settles it: there is nothing left to filter on and nothing that should be.
 *
 * PRINTING IS DELIBERATELY NOT HERE. Chromium's viewer had it for free and this
 * does not, because a print pipeline is a second renderer at a second scale
 * with its own page-break rules — and the file is a PDF sitting on disk that
 * every OS already prints. Reveal (↗) in Home puts the user in front of it.
 */
@Component({
  selector: 'app-pdf-view',
  imports: [ComparePickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pdf-view.component.html',
  styleUrl: './pdf-view.component.scss',
})
export class PdfViewComponent implements OnDestroy {
  readonly tab = input.required<Tab>();
  /**
   * DRAWN WITHOUT THE CONTROLS THAT WRITE — Compare's second column.
   *
   * A PDF viewer has nothing to edit, so this is smaller than the book's
   * `viewing()`: what it takes away is the two VIEW-MODE toggles, which live on
   * the tab and are written by id, and the Compare control, which would offer a
   * third column from inside the second. The pages, the zoom, the search and the
   * page counter are all reads and all stay — a comparison you cannot scroll or
   * zoom is a picture, not a viewer.
   */
  readonly readOnly = input(false);

  protected readonly documents = inject(OpenDocumentsService);

  protected readonly doc = signal<PDFDocumentProxy | null>(null);
  protected readonly problem = signal<string | null>(null);
  /** Page sizes in POINTS, in order. The shells are these times the scale. */
  readonly boxes = signal<readonly PageBox[]>([]);
  protected readonly scale = signal(1);
  protected readonly current = signal(1);

  protected readonly shells = computed<readonly Shell[]>(() => {
    const factor = this.scale();
    return this.boxes().map((box) => ({
      number: box.number,
      width: Math.round(box.width * factor),
      height: Math.round(box.height * factor),
    }));
  });

  /**
   * How many text items each page turned out to have, once it has been read.
   *
   * A page ABSENT from this map has not been read yet; a page mapped to 0 has
   * been read and has nothing on it. The layer pane needs the difference — "not
   * loaded" and "no layer" both look like blank paper, and only one of them is
   * worth saying out loud.
   */
  protected readonly itemCounts = signal<ReadonlyMap<number, number>>(new Map());
  /** Pages that refused to draw, and why. Said on the page rather than over the book. */
  protected readonly pageProblems = signal<ReadonlyMap<number, string>>(new Map());

  // ── Searching ────────────────────────────────────────────────────────────
  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly matches = signal<readonly Match[]>([]);
  protected readonly at = signal(0);

  private readonly viewportEl = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly layerViewportEl = viewChild<ElementRef<HTMLElement>>('layerViewport');
  private readonly stripEl = viewChild<ElementRef<HTMLElement>>('strip');
  readonly pageEls = viewChildren<ElementRef<HTMLElement>>('pageBox');
  readonly layerEls = viewChildren<ElementRef<HTMLElement>>('layerBox');
  readonly thumbEls = viewChildren<ElementRef<HTMLElement>>('thumbBox');

  /**
   * pdf.js's parser thread, ours to make and ours to kill.
   *
   * See the header: handing pdf.js a workerSrc would send a packaged build down
   * the blob-wrapper path, into the CSP, and out the other side as a fake
   * worker on the UI thread without a word.
   */
  private readonly thread = new Worker(new URL('pdf.worker.min.mjs', PDFJS_ASSETS), { type: 'module' });
  // `create` rather than `new`: it is the overload pdf.js types properly, and
  // it returns the worker already attached to a port rather than throwing on a
  // second attach. Each component makes its own thread, so it always builds one.
  readonly worker = PDFWorker.create({ name: 'foundry-pdf', port: this.thread });

  loadingTask: PDFDocumentLoadingTask | null = null;
  /** Bumped per load, so a document that arrives after the tab moved on is dropped. */
  generation = 0;

  /** Page -> the scale it is currently drawn at. Absent means nothing is drawn. */
  readonly drawn = new Map<number, number>();
  readonly tasks = new Map<number, RenderTask>();
  /** Page -> its text items, with the empty ones already gone. Shared by both panes and the search. */
  readonly items = new Map<number, readonly TextItem[]>();
  /** Page -> the spans of the invisible layer and of the visible one, index-aligned with `items`. */
  readonly spans = new Map<number, HTMLElement[][]>();
  /**
   * Pages the observer says are within reach of the viewport.
   *
   * A SIGNAL as well as a set, because the block layer is drawn from it. Every
   * page of the document has a `.page` div from the moment the file opens — that
   * is what makes the scrollbar tell the truth — so building outlines for all of
   * them would be ten thousand divs for a book this viewer is showing eleven
   * pages of. The canvases are already lazy for the same reason; this is that
   * rule applied to the third layer.
   */
  private readonly near = new Set<number>();
  private readonly nearPages = signal<ReadonlySet<number>>(new Set());
  readonly thumbsDrawn = new Set<number>();

  private pages: IntersectionObserver | null = null;
  private thumbs: IntersectionObserver | null = null;

  searchIndex: readonly PageText[] | null = null;
  queryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private scrollPending = false;
  /** Measures a string the way the browser will draw it, without touching the DOM. */
  readonly ruler = document.createElement('canvas').getContext('2d');

  constructor() {
    /**
     * A new file — or the same tab switched back to. Everything is rebuilt.
     *
     * `untracked` around the work, and it is not tidiness: opening WRITES the
     * signals it also reads (`doc`, `boxes`), so a tracked call would make the
     * document it just loaded the reason to load it again, forever. The source
     * below is the only thing this effect is allowed to watch.
     *
     * WATCHED THROUGH A COMPUTED, and that part is load-bearing too: reading
     * `this.tab()` here would depend on the whole TAB, and every patch makes a
     * new tab object — so pressing "Thumbnails" or "Text layer" would re-read
     * the file from disk and throw the reader back to page one. The computed
     * only fires when what it names changes.
     */
    /*
     * WATCHED THROUGH A COMPUTED OF THE PATH **AND THE REVISION**, and the
     * revision is not decoration.
     *
     * A rendering that produces a PDF replaces the project's live PDF AT THE
     * SAME PATH. With only the path watched, generating a real-text reprint of
     * the book you were looking at did nothing observable: the file changed
     * underneath a viewer that had no reason to believe it had. The revision is
     * what the rest of this app already uses to say "same name, new bytes" — an
     * <iframe> pointed at a URL it is already showing ignores it too — so this
     * pane reads it for the same reason the book's does.
     */
    const source = computed(() => `${this.tab().revision}\u0000${this.tab().path}`);
    effect(() => {
      void source();
      const file = untracked(() => this.tab().path);
      untracked(() => { void this.open(file); });
    });

    /**
     * Zoom and the layer pane both invalidate every drawn page: one changes the
     * canvas resolution, the other adds a second set of spans that pages drawn
     * before the toggle never got. Redrawing only what is near the viewport is
     * what keeps that from being 500 canvases.
     */
    effect(() => {
      const factor = this.scale();
      const split = this.tab().layerView;
      untracked(() => {
        void factor;
        void split;
        this.redrawNear();
      });
    });

    // The observers watch elements @for creates, so they are re-attached every
    // time that list changes — a new document, the strip appearing.
    effect(() => {
      const boxes = this.pageEls();
      const observer = this.pages;
      if (!observer) return;
      observer.disconnect();
      for (const box of boxes) observer.observe(box.nativeElement);
    });
    effect(() => {
      const boxes = this.thumbEls();
      const observer = this.thumbs;
      if (!observer) return;
      observer.disconnect();
      for (const box of boxes) observer.observe(box.nativeElement);
    });

    /**
     * A page is drawn while it is within one screen of the viewport and
     * released the moment it is not.
     *
     * The release is the half that matters. Drawing lazily but never letting go
     * turns a scroll through a 600-page scan into 600 canvases at two device
     * pixels each, which is gigabytes — lazy once is not lazy.
     */
    this.pages = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const page = pageOf(entry.target);
        if (page === null) continue;
        if (entry.isIntersecting) {
          this.near.add(page);
          void this.draw(page);
        } else {
          this.near.delete(page);
          this.release(page);
        }
      }
      this.nearPages.set(new Set(this.near));
    }, { rootMargin: '100% 0px' });

    this.thumbs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const page = pageOf(entry.target);
        if (page !== null && entry.isIntersecting) void this.drawThumb(page);
      }
    }, { rootMargin: '0px 200%' });
  }

  ngOnDestroy(): void {
    this.pages?.disconnect();
    this.thumbs?.disconnect();
    if (this.queryTimer !== null) clearTimeout(this.queryTimer);
    this.teardown();
    // The port pdf.js was given is ours; destroying the loading task does not
    // reach it (pdf.js only owns a worker it created itself), so the thread
    // would outlive the tab if this line were not here.
    void this.worker.destroy();
    this.thread.terminate();
  }

  private open(filePath: string): Promise<void> { return drawing.open.call(this, filePath); }

  teardown(): void {
    for (const task of this.tasks.values()) task.cancel();
    this.tasks.clear();
    this.drawn.clear();
    this.items.clear();
    this.spans.clear();
    this.near.clear();
    this.thumbsDrawn.clear();
    this.searchIndex = null;
    this.doc.set(null);
    const task = this.loadingTask;
    this.loadingTask = null;
    // Destroying the loading task takes the document and the transport with it.
    // The rejection is caught because there is nothing it could mean: this runs
    // when the file is already being discarded, and the alternative is an
    // unhandled rejection in the renderer about an object nobody holds.
    if (task) task.destroy().catch(() => undefined);
  }

  private draw(number: number): Promise<void> { return drawing.draw.call(this, number); }

  private release(number: number): void {
    this.tasks.get(number)?.cancel();
    this.tasks.delete(number);
    this.drawn.delete(number);
    this.spans.delete(number);
    const shell = this.pageEls().find((box) => pageOf(box.nativeElement) === number)?.nativeElement;
    const canvas = shell?.querySelector('canvas');
    // Zeroing the dimensions is what actually frees the backing store; clearing
    // the pixels only paints it white and keeps every byte.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    const textEl = shell?.querySelector<HTMLElement>('.text');
    if (textEl) textEl.replaceChildren();
    const layerText = this.layerEls().find((box) => pageOf(box.nativeElement) === number)
      ?.nativeElement.querySelector<HTMLElement>('.text');
    if (layerText) layerText.replaceChildren();
  }

  /** Every page near the viewport, drawn again from scratch. Zoom, and the layer toggle. */
  private redrawNear(): void {
    for (const number of this.near) {
      this.drawn.delete(number);
      void this.draw(number);
    }
  }

  textOf(page: PdfPage, number: number): Promise<readonly TextItem[]> { return drawing.textOf.call(this, page, number); }

  private drawThumb(number: number): Promise<void> { return drawing.drawThumb.call(this, number); }

  protected readonly thumbWidth = THUMB_WIDTH;

  /** Every thumbnail is the same width; a landscape page is simply shorter. */
  protected thumbHeight(shell: Shell): number {
    return Math.round((shell.height / shell.width) * THUMB_WIDTH);
  }

  // ── Moving around ────────────────────────────────────────────────────────

  protected onScroll(): void {
    this.mirror(this.viewportEl()?.nativeElement, this.layerViewportEl()?.nativeElement);
    if (this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.scrollPending = false;
      this.settleCurrentPage();
    });
  }

  protected onLayerScroll(): void {
    this.mirror(this.layerViewportEl()?.nativeElement, this.viewportEl()?.nativeElement);
  }

  /**
   * One number, copied. The panes hold identical boxes, so their scroll heights
   * are identical and there is nothing to convert between them; the flag is
   * only there so the mirrored scroll does not mirror itself back.
   */
  private mirror(from: HTMLElement | undefined, to: HTMLElement | undefined): void {
    if (this.syncing || !from || !to || from === to) return;
    this.syncing = true;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => { this.syncing = false; });
  }

  /** The page a third of the way down the viewport — the one being read, not the one peeking in. */
  private settleCurrentPage(): void {
    const viewport = this.viewportEl()?.nativeElement;
    if (!viewport) return;
    const mark = viewport.scrollTop + viewport.clientHeight / 3;
    let found = 1;
    for (const box of this.pageEls()) {
      const el = box.nativeElement;
      if (el.offsetTop > mark) break;
      found = pageOf(el) ?? found;
    }
    if (found !== this.current()) {
      this.current.set(found);
      this.revealThumb(found);
    }
  }

  protected jumpTo(number: number): void {
    const viewport = this.viewportEl()?.nativeElement;
    const el = this.pageEls().find((box) => pageOf(box.nativeElement) === number)?.nativeElement;
    if (!viewport || !el) return;
    viewport.scrollTo({ top: el.offsetTop - 14, behavior: 'auto' });
    this.current.set(number);
  }

  private revealThumb(number: number): void {
    const strip = this.stripEl()?.nativeElement;
    const el = this.thumbEls().find((box) => pageOf(box.nativeElement) === number)?.nativeElement;
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.clientWidth / 2 + el.clientWidth / 2;
    strip.scrollTo({ left, behavior: 'smooth' });
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────

  /**
   * Ctrl (Cmd on a Mac) + wheel zooms the DOCUMENT, and only the document.
   *
   * The scale signal only reaches the page shells and their canvases, so the
   * toolbar, the tabs and the rest of the window cannot move — this is not
   * Chromium's page zoom and must never trigger it, which is what the
   * preventDefault is for. A trackpad pinch arrives as exactly this event
   * (ctrlKey wheel), so pinch-to-zoom works unasked.
   *
   * ANCHORED UNDER THE CURSOR: the content point under the pointer stays under
   * it, which is what makes wheel zoom usable at all — zooming toward the top
   * of the document while reading page 40 is a teleport. The new scrollTop is
   * set a frame later, once Angular has resized the shells the arithmetic
   * assumed. Continuous rather than stepped, because a wheel is continuous;
   * the +/− buttons keep their fixed stops.
   */
  protected onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const scroller = event.currentTarget as HTMLElement;
    // deltaMode 1 is lines (a plugged-in mouse on Firefox conventions); pixels
    // otherwise. 16 is the browsers' own line height for this conversion.
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const before = this.scale();
    const after = Math.min(
      ZOOM_STEPS[ZOOM_STEPS.length - 1]!,
      Math.max(ZOOM_STEPS[0]!, before * Math.exp(-delta * WHEEL_RATE)),
    );
    if (after === before) return;
    const rect = scroller.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    const ratio = after / before;
    const top = (scroller.scrollTop + anchorY) * ratio - anchorY;
    const left = (scroller.scrollLeft + anchorX) * ratio - anchorX;
    this.scale.set(after);
    requestAnimationFrame(() => {
      scroller.scrollTop = top;
      scroller.scrollLeft = left;
    });
  }

  protected zoomIn(): void {
    const now = this.scale();
    this.scale.set(ZOOM_STEPS.find((step) => step > now + 0.001) ?? now);
  }

  protected zoomOut(): void {
    const now = this.scale();
    this.scale.set([...ZOOM_STEPS].reverse().find((step) => step < now - 0.001) ?? now);
  }

  /** The widest page fills the pane. The widest, so no page in the book overflows sideways. */
  protected fitWidth(): void {
    const viewport = this.viewportEl()?.nativeElement;
    const widest = Math.max(...this.boxes().map((box) => box.width), 1);
    if (!viewport || this.boxes().length === 0) return;
    // The pane's own width, so this needs no opinion about whether the layer
    // view is open: when it is, the flex box has already halved clientWidth.
    // 28 is the reel's padding, 12 keeps the shadow off the scrollbar.
    this.scale.set(Math.max(0.1, (viewport.clientWidth - 28 - 12) / widest));
  }

  protected onQuery(text: string): void { return search.onQuery.call(this, text); }

  run(text: string): Promise<void> { return search.run.call(this, text); }

  index(): Promise<readonly PageText[] | null> { return search.index.call(this); }

  protected step(delta: number): void { return search.step.call(this, delta); }

  go(match: Match): void { return search.go.call(this, match); }

  paintHit(): void { return search.paintHit.call(this); }
}

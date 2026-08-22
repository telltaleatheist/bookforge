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
  template: `
    <div class="pdf">
      <header class="toolbar">
        <!-- THIS ROW DOES NOT NAME THE DOCUMENT. It did, for as long as there
             was nothing above it that would — but the chrome-style strip is
             back (the workspace draws a tab per document, with its title on
             it), so a title here is the same word twice, one row apart, on a
             row that already has to fit a search box, a zoom group and a page
             counter. -->
        <!--
          THE TWO VIEW MODES, AND THE COMPARE CONTROL, ARE THE THREE THINGS A
          COMPARE COLUMN HAS NO USE FOR. Both toggles write through the tab id
          (\`toggleLayerView\`, \`toggleThumbnails\`) and a compare column's tab
          is synthetic — not in the documents list, so the write would land
          nowhere and the buttons would be dead. Compare itself is worse than
          dead there: it would offer a third column from inside the second.
          Everything else on this row — the search, the zoom, the page counter —
          is exactly what somebody comparing a scan wants, and stays.
        -->
        @if (!readOnly()) {
          <button
            class="ghost"
            [class.on]="tab().layerView"
            [disabled]="doc() === null"
            (click)="documents.toggleLayerView(tab().id)"
          >{{ tab().layerView ? 'Hide text layer' : 'Text layer' }}</button>
          <button
            class="ghost"
            [class.on]="tab().thumbnails"
            [disabled]="doc() === null"
            (click)="documents.toggleThumbnails(tab().id)"
          >Thumbnails</button>
          <!--
            AND A SCAN GETS COMPARE TOO. The question *"is this what the page
            actually said?"* is asked at least as often over a photograph of a
            page as over the book reflowed from it, and a control that existed
            only on the book would make the answer depend on which face of the
            project happened to be up. This toolbar is its natural home: it is
            the row that already carries what-am-I-looking-at-and-how.
          -->
          <app-compare-picker />
        }
        <!--
          ── THERE IS NO BLOCKS BUTTON AND THERE IS NO BLOCK LAYER ──

          Both are deleted. The layer turned this pane into an editing surface —
          outline what the model read off the scan, strike it, relabel it, mark
          the chapters — and the user asked what it was for, which is the answer:
          a scan is a photograph of pages, and editing what the book SAYS on a
          photograph of it means every correction is made in per-page coordinates
          the flowing document has already thrown away. A1 retires it
          (docs/RENDERER.md §0): the scan and the facsimile stay VIEWABLE, and
          editing happens on the rendered book alone.

          THE DISPLAY WENT WITH THE EDITOR AND THAT IS A JUDGEMENT, not an
          oversight. What remained after the gestures came out would have read the
          overlay file — {page, order, note} decisions over a bank — and that
          grammar and every module that speaks it are deleted whole in the same
          wave (§7). An outline layer that survived would have had to keep the
          grammar alive to draw less than the proof sheet already draws, over a
          photograph, in the chrome ruling 8 calls "sloppy and ugly". So the pane
          is a viewer: the page, its text layer, the thumbnails and the search.
        -->

        <span class="counter">{{ current() }} / {{ shells().length }}</span>

        <div class="zoom">
          <button class="icon" title="Zoom out" [disabled]="doc() === null" (click)="zoomOut()">−</button>
          <button class="icon" title="Zoom in" [disabled]="doc() === null" (click)="zoomIn()">+</button>
          <button class="icon wide" title="Fit width" [disabled]="doc() === null" (click)="fitWidth()">Fit</button>
        </div>

        <div class="find">
          <input
            #needle
            type="search"
            placeholder="Search this document"
            spellcheck="false"
            [value]="query()"
            (input)="onQuery(needle.value)"
            (keydown.enter)="step(1)"
            [attr.aria-label]="'Search ' + tab().title"
          >
          <span class="hits">
            @if (searching()) { reading… }
            @else if (query().length === 0) { }
            @else if (matches().length === 0) { no matches }
            @else { {{ at() + 1 }} of {{ matches().length }} }
          </span>
          <button class="icon" title="Previous match" [disabled]="matches().length === 0" (click)="step(-1)">‹</button>
          <button class="icon" title="Next match" [disabled]="matches().length === 0" (click)="step(1)">›</button>
        </div>

        <!--
          ── SAVE A COPY IS NOT ON THIS ROW ANY MORE ──

          It dropped a copy of whatever file the pane happened to be pointed at
          into a folder of the user's choosing — no record of it in the project,
          nothing to say which step of the ledger it was a picture of, and one
          more copy of a scan for somebody to find in six months and wonder about.
          Getting a document out is Export, on the dock: it names a PRODUCT, it
          is made from the position you are standing on, and the result is filed
          under the project where it can be found again.

          The save-as call on the service stays — the close-with-corrections
          dialog is still allowed to offer somewhere to put them.
        -->
      </header>

      @if (problem(); as reason) {
        <div class="problem">
          <h1>This PDF would not open</h1>
          <p>{{ reason }}</p>
        </div>
      } @else {
        <div class="panes" [class.split]="tab().layerView">
          <div class="viewport" #viewport (scroll)="onScroll()" (wheel)="onWheel($event)">
            <div class="reel">
              @for (shell of shells(); track shell.number) {
                <div
                  class="page"
                  #pageBox
                  [attr.data-page]="shell.number"
                  [style.width.px]="shell.width"
                  [style.height.px]="shell.height"
                >
                  <canvas></canvas>
                  <div class="text"></div>
                  @if (pageProblems().get(shell.number); as reason) {
                    <p class="page-problem">This page would not render — {{ reason }}</p>
                  }
                </div>
              }
            </div>
          </div>

          @if (tab().layerView) {
            <div class="viewport paper-side" #layerViewport (scroll)="onLayerScroll()" (wheel)="onWheel($event)">
              <div class="reel">
                @for (shell of shells(); track shell.number) {
                  <div
                    class="page paper"
                    #layerBox
                    [attr.data-page]="shell.number"
                    [style.width.px]="shell.width"
                    [style.height.px]="shell.height"
                  >
                    <div class="text shown"></div>
                    @if (itemCounts().get(shell.number) === 0) {
                      <p class="no-layer">This page has no text layer</p>
                    }
                  </div>
                }
              </div>
            </div>
          }
        </div>

        @if (tab().thumbnails) {
          <div class="strip" #strip>
            @for (shell of shells(); track shell.number) {
              <button
                class="thumb"
                #thumbBox
                [class.on]="current() === shell.number"
                [attr.data-page]="shell.number"
                [style.width.px]="thumbWidth"
                [title]="'Page ' + shell.number"
                (click)="jumpTo(shell.number)"
              >
                <canvas [style.height.px]="thumbHeight(shell)"></canvas>
                <span>{{ shell.number }}</span>
              </button>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; background: var(--bg-sunken); }
    .pdf { display: flex; flex-direction: column; height: 100%; }

    /* The same row the book pane wears, so the two do not feel like two apps. */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      height: 44px;
      padding: 0 12px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .counter {
      min-width: 72px;
      font-size: 11px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .zoom { display: flex; gap: 4px; }
    .find { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; justify-content: flex-end; }
    .find input { width: 220px; max-width: 40vw; height: 26px; padding: 0 10px; font-size: 12px; border-radius: var(--radius-sm); }
    .hits {
      min-width: 82px;
      font-size: 11px;
      color: var(--text-tertiary);
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .panes { flex: 1; min-height: 0; display: flex; }
    .panes.split .viewport { flex: 1 1 50%; min-width: 0; }
    .panes.split .paper-side { border-left: 1px solid var(--border-default); }

    /*
      \`position: relative\` is load-bearing, not decoration: it makes this the
      offsetParent of every page box, so a page's offsetTop is measured from the
      scroller's own content top and can be compared with scrollTop directly.
      Without it the pages measure from the document body and every jump — the
      thumbnails, the search, the page counter — lands somewhere else.
    */
    .viewport { position: relative; flex: 1; min-width: 0; overflow: auto; }
    .reel { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 14px; }

    .page {
      position: relative; flex-shrink: 0;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .page canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

    /* Paper, not white: the right pane is a reconstruction and should not be
       mistaken at a glance for the scan on the left. */
    .page.paper { background: #f6f3ec; }

    .page-problem {
      position: absolute; inset: 0; margin: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      /* Not --error: this one is printed ON the page, and the chrome's red is
         mixed for a dark surface. */
      color: #dc2626; font-size: 12px; text-align: center;
    }

    .no-layer {
      position: absolute; inset: 0; margin: 0;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      color: #8a8172; font-size: 13px; font-style: italic; text-align: center;
    }

    /*
      The text layer. Transparent over the page — pdf.js paints the glyphs and
      this is the selectable copy of them — and inked in the layer pane, so the
      same geometry reads twice: once as the page, once as what a search finds.
      \`user-select: text\` on both, because copying out of either is the point.

      EVERY span RULE GOES THROUGH ::ng-deep, and it is load-bearing: the spans
      are made by \`layoutText\` with document.createElement, and Angular's style
      emulation scopes a component's CSS by stamping an attribute on template
      elements — an attribute a dynamically created element never receives. The
      first version of this file wrote these as plain \`.text span\` and every
      rule silently missed: no absolute positioning (the whole layer piled up
      in the page's top-left), no transparent ink over the scan, no dark ink in
      the layer pane. The \`.text\` ancestor IS from the template, so the rules
      stay this component's own; only the leap to its children is unscoped.
    */
    .text {
      position: absolute; inset: 0;
      overflow: hidden;
      line-height: 1;
      user-select: text;
      -webkit-user-select: text;
    }
    .text ::ng-deep span {
      position: absolute;
      white-space: pre;
      transform-origin: 0% 0%;
      color: transparent;
      cursor: text;
    }
    /*
     * \`color: transparent\` HERE IS LOAD-BEARING. The app's global rule paints
     * selected text near-white (styles.scss ::selection), and the cascade is
     * per-property: this rule won the background and never declared a color,
     * so the global's #faf9f7 re-inked the invisible text layer during every
     * selection — a white ghost copy of the glyphs, offset from the canvas's
     * printed ones by the layer's approximation (Owen, 2026-08-21, "is it
     * revealing the hidden layer as white text?" — almost exactly). Over
     * paper, the selected words are already printed beneath; selection here
     * is a box, never a second inking.
     */
    .text ::ng-deep span::selection { background: rgba(6, 182, 212, 0.4); color: transparent; }
    .text.shown ::ng-deep span { color: #23201a; }
    /* Over the scan the hit is a BOX and the text under it stays invisible —
       painting it would double the ink the highlight is pointing at. The fill
       is the accent, but at an alpha that stays findable on a full white page
       rather than at the chrome's. */
    .text ::ng-deep span.hit { background: rgba(6, 182, 212, 0.55); border-radius: 2px; }
    .text.shown ::ng-deep span.hit { background: rgba(6, 182, 212, 0.85); }

    .strip {
      /* Positioned for the same reason the viewport is — revealThumb reads
         offsetLeft against this element's scrollLeft. */
      position: relative;
      flex-shrink: 0;
      display: flex; gap: 8px;
      padding: 8px 10px;
      overflow-x: auto; overflow-y: hidden;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-subtle);
    }
    .thumb {
      flex-shrink: 0;
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 0;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .thumb canvas {
      display: block; width: 100%;
      background: #fff;
      border: 2px solid transparent; border-radius: var(--radius-sm);
      transition: border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .thumb:hover canvas { border-color: var(--border-strong); }
    .thumb.on canvas { border-color: var(--accent); }
    .thumb.on { color: var(--accent); font-weight: 500; }

    .problem {
      flex: 1;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; padding: 32px;
      color: var(--text-tertiary); text-align: center;
    }
    .problem h1 { margin: 0; font-size: 16px; font-weight: 600; color: var(--error); }
    .problem p { margin: 0; font-size: 13px; max-width: 70ch; white-space: pre-wrap; }

    /* One button shape across the row — 26px tall, 4px radius — so the toolbar
       reads as a strip of controls rather than a line of separate widgets.
       There is no accented button here now: nothing on this row is the thing
       you came to press, and the one control that was (Save a copy) is on the
       dock as Export. */
    .ghost, .icon {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 10px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer; white-space: nowrap;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .ghost, .icon {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled), .icon:hover:not(:disabled) {
      background: var(--bg-hover); border-color: var(--border-strong);
    }
    .ghost.on { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
    .icon { min-width: 26px; padding: 0 6px; }
    .icon.wide { min-width: 34px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
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
  private readonly boxes = signal<readonly PageBox[]>([]);
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
  private readonly pageEls = viewChildren<ElementRef<HTMLElement>>('pageBox');
  private readonly layerEls = viewChildren<ElementRef<HTMLElement>>('layerBox');
  private readonly thumbEls = viewChildren<ElementRef<HTMLElement>>('thumbBox');

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
  private readonly worker = PDFWorker.create({ name: 'foundry-pdf', port: this.thread });

  private loadingTask: PDFDocumentLoadingTask | null = null;
  /** Bumped per load, so a document that arrives after the tab moved on is dropped. */
  private generation = 0;

  /** Page -> the scale it is currently drawn at. Absent means nothing is drawn. */
  private readonly drawn = new Map<number, number>();
  private readonly tasks = new Map<number, RenderTask>();
  /** Page -> its text items, with the empty ones already gone. Shared by both panes and the search. */
  private readonly items = new Map<number, readonly TextItem[]>();
  /** Page -> the spans of the invisible layer and of the visible one, index-aligned with `items`. */
  private readonly spans = new Map<number, HTMLElement[][]>();
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
  private readonly thumbsDrawn = new Set<number>();

  private pages: IntersectionObserver | null = null;
  private thumbs: IntersectionObserver | null = null;

  private searchIndex: readonly PageText[] | null = null;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private scrollPending = false;
  /** Measures a string the way the browser will draw it, without touching the DOM. */
  private readonly ruler = document.createElement('canvas').getContext('2d');

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

  // ── Opening ──────────────────────────────────────────────────────────────

  /**
   * Read the file and take its measurements.
   *
   * EVERY PAGE'S SIZE IS ASKED FOR UP FRONT, which for a long book is a few
   * hundred round trips to the worker before the first page appears. It buys a
   * scrollbar that tells the truth: guessing the rest of the book from page one
   * makes every page after the first mixed-size one jump under the reader's
   * cursor, and a viewer that moves the page while you read it is worse than
   * one that took another moment to open.
   */
  private async open(filePath: string): Promise<void> {
    this.generation += 1;
    const mine = this.generation;
    /*
     * WHERE THE READER WAS, kept across the re-open.
     *
     * A tab's document is re-read for two reasons and BOTH of them are the same
     * document: it was relocated onto the project's own copy of itself (the
     * bytes are identical), or it was generated again under the same name. In
     * neither case has the person stopped reading page 214 — but the pane threw
     * them back to page one, because a re-open is a fresh document as far as
     * everything below here is concerned.
     *
     * Restored only when the new document is long enough to have that page,
     * which is the whole of the safety: a shorter book simply opens where it
     * always did.
     */
    const wasAt = this.current();
    this.teardown();
    this.problem.set(null);
    this.boxes.set([]);
    this.itemCounts.set(new Map());
    this.pageProblems.set(new Map());
    this.matches.set([]);
    this.query.set('');
    this.current.set(1);

    if (!api) {
      this.problem.set('This window is not running inside Foundry, so it cannot read files.');
      return;
    }

    try {
      const bytes = await api.documentBytes(filePath);
      if (mine !== this.generation) return;

      const task = getDocument({
        data: bytes,
        worker: this.worker,
        // Everything pdf.js may need at runtime, shipped beside the worker.
        // Absent, an unusual scan renders blank and says nothing.
        cMapUrl: new URL('cmaps/', PDFJS_ASSETS).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', PDFJS_ASSETS).href,
        wasmUrl: new URL('wasm/', PDFJS_ASSETS).href,
        iccUrl: new URL('iccs/', PDFJS_ASSETS).href,
      });
      this.loadingTask = task;
      const doc = await task.promise;
      if (mine !== this.generation) { task.destroy().catch(() => undefined); return; }

      const boxes: PageBox[] = [];
      for (let number = 1; number <= doc.numPages; number += 1) {
        const page = await doc.getPage(number);
        if (mine !== this.generation) return;
        const viewport = page.getViewport({ scale: 1 });
        boxes.push({ number, width: viewport.width, height: viewport.height });
      }
      this.doc.set(doc);
      this.boxes.set(boxes);
      this.fitWidth();
      // A frame later, because `jumpTo` measures the page divs `shells()` has
      // only just been given the numbers for.
      if (wasAt > 1 && wasAt <= boxes.length) {
        requestAnimationFrame(() => {
          if (mine === this.generation) this.jumpTo(wasAt);
        });
      }
    } catch (err) {
      if (mine !== this.generation) return;
      // By name, never swallowed: a tab showing nothing with no reason on it is
      // the failure this app refuses to ship (ARCHITECTURE §8).
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }

  private teardown(): void {
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

  // ── Drawing ──────────────────────────────────────────────────────────────

  private async draw(number: number): Promise<void> {
    const doc = this.doc();
    const factor = this.scale();
    if (!doc || this.drawn.get(number) === factor) return;
    const shell = this.pageEls().find((box) => pageOf(box.nativeElement) === number)?.nativeElement;
    const canvas = shell?.querySelector('canvas');
    const textEl = shell?.querySelector<HTMLElement>('.text');
    if (!shell || !canvas || !textEl) return;

    this.tasks.get(number)?.cancel();
    this.drawn.set(number, factor);
    const mine = this.generation;

    try {
      const page = await doc.getPage(number);
      if (mine !== this.generation || this.drawn.get(number) !== factor) return;
      const viewport = page.getViewport({ scale: factor });

      // devicePixelRatio-aware, capped. A 3× display would otherwise quadruple
      // the memory of every page on screen for a difference nobody can see on
      // a photograph of paper.
      const density = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(viewport.width * density);
      canvas.height = Math.round(viewport.height * density);
      const context = canvas.getContext('2d');
      if (!context) return;

      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
      });
      this.tasks.set(number, task);
      await task.promise;
      this.tasks.delete(number);
      if (mine !== this.generation) return;

      const items = await this.textOf(page, number);
      if (mine !== this.generation || this.drawn.get(number) !== factor) return;

      const layerEl = this.tab().layerView
        ? this.layerEls().find((box) => pageOf(box.nativeElement) === number)
          ?.nativeElement.querySelector<HTMLElement>('.text')
        : null;
      this.spans.set(number, [
        layoutText(items, viewport, textEl, this.ruler),
        layerEl ? layoutText(items, viewport, layerEl, this.ruler) : [],
      ]);
      this.paintHit();
    } catch (err) {
      // Our own cancel, by name — the one outcome that is not a failure.
      if (err instanceof Error && err.name === 'RenderingCancelledException') return;
      this.drawn.delete(number);
      // ON THE PAGE, not over the document. A page that will not draw is a fact
      // about that page, and taking the whole book down for it would hide the
      // 499 that are fine — the reason is still said, by name, where the thing
      // it is about would have been. A blank page with no explanation is the
      // failure ARCHITECTURE §8 is about; this is not that.
      this.pageProblems.update((problems) => new Map(problems)
        .set(number, err instanceof Error ? err.message : String(err)));
    }
  }

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

  /**
   * A page's text items, cached and stripped of the empty ones.
   *
   * pdf.js emits a zero-length item every time the text state changes, which
   * for foundry's layer is once per line. They would be zero-width spans in
   * both panes and holes in the search's item indexing, so they go here — once,
   * where every consumer sees the same list.
   */
  private async textOf(page: PdfPage, number: number): Promise<readonly TextItem[]> {
    const cached = this.items.get(number);
    if (cached) return cached;
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter(
      (item) => typeof item.str === 'string' && item.str.length > 0,
    );
    this.items.set(number, items);
    this.itemCounts.update((counts) => new Map(counts).set(number, items.length));
    return items;
  }

  private async drawThumb(number: number): Promise<void> {
    const doc = this.doc();
    if (!doc || this.thumbsDrawn.has(number)) return;
    const canvas = this.thumbEls().find((box) => pageOf(box.nativeElement) === number)
      ?.nativeElement.querySelector('canvas');
    if (!canvas) return;
    this.thumbsDrawn.add(number);
    const mine = this.generation;
    try {
      const page = await doc.getPage(number);
      if (mine !== this.generation) return;
      const unit = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / unit.width });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    } catch (err) {
      // A thumbnail that will not draw stays blank rather than taking the
      // viewer down with it — the page itself is where a real failure is said.
      if (!(err instanceof Error && err.name === 'RenderingCancelledException')) {
        this.thumbsDrawn.delete(number);
      }
    }
  }

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

  // ── Searching ────────────────────────────────────────────────────────────

  /**
   * CASE-INSENSITIVE SUBSTRING, and nothing cleverer. No word boundaries, no
   * regex, no ligature or diacritic folding — the job this has to do is let
   * Owen type a word he can see on the scan and find out whether the layer
   * under it says the same thing, and for that a substring is the honest test.
   * Anything smarter would find matches the layer does not literally contain,
   * which is the one answer this feature must never give.
   */
  protected onQuery(text: string): void {
    this.query.set(text);
    if (this.queryTimer !== null) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => { void this.run(text); }, QUERY_DELAY_MS);
  }

  private async run(text: string): Promise<void> {
    const needle = text.trim().toLowerCase();
    if (needle.length === 0) {
      this.matches.set([]);
      this.paintHit();
      return;
    }
    const index = await this.index();
    if (index === null || this.query().trim().toLowerCase() !== needle) return;

    const found: Match[] = [];
    for (const page of index) {
      const hay = page.lower;
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
        // The item the match STARTS in. A match that runs over the end of one
        // item is highlighted on the item it began in rather than on both —
        // the highlight is a pointer to the place, not a measurement of it.
        found.push({ page: page.number, item: itemAt(page.starts, at) });
      }
    }
    this.matches.set(found);
    this.at.set(0);
    if (found.length > 0) this.go(found[0]!);
    else this.paintHit();
  }

  /**
   * Every page's text, read once.
   *
   * This is the expensive thing in the file — a whole book through the worker —
   * so it happens on the first search rather than on open, and is kept until
   * the document changes. The toolbar says "reading…" while it runs, because a
   * search box that does nothing for four seconds looks broken.
   */
  private async index(): Promise<readonly PageText[] | null> {
    if (this.searchIndex) return this.searchIndex;
    const doc = this.doc();
    if (!doc) return null;
    const mine = this.generation;
    this.searching.set(true);
    try {
      const pages: PageText[] = [];
      for (let number = 1; number <= doc.numPages; number += 1) {
        const page = await doc.getPage(number);
        if (mine !== this.generation) return null;
        const items = await this.textOf(page, number);
        let text = '';
        const starts: number[] = [];
        for (const item of items) {
          starts.push(text.length);
          // A newline where the item said the line ended, so two lines of the
          // layer cannot be read as one word run together.
          text += item.hasEOL ? `${item.str}\n` : item.str;
        }
        pages.push({ number, lower: text.toLowerCase(), starts });
      }
      if (mine !== this.generation) return null;
      this.searchIndex = pages;
      return pages;
    } finally {
      this.searching.set(false);
    }
  }

  protected step(delta: number): void {
    const found = this.matches();
    if (found.length === 0) {
      // Enter on a query that has not run yet — run it now rather than nothing.
      if (this.query().trim().length > 0) void this.run(this.query());
      return;
    }
    const next = (this.at() + delta + found.length) % found.length;
    this.at.set(next);
    this.go(found[next]!);
  }

  private go(match: Match): void {
    this.jumpTo(match.page);
    // The page may not be drawn yet; `draw` calls paintHit when it finishes, so
    // this call is for the case where it already is.
    this.paintHit();
  }

  /** The current match's spans, in whichever panes are drawn. */
  private paintHit(): void {
    const found = this.matches();
    const hit = found[this.at()] ?? null;
    for (const [number, panes] of this.spans) {
      for (const pane of panes) {
        for (let index = 0; index < pane.length; index += 1) {
          const wanted = hit !== null && hit.page === number && hit.item === index;
          pane[index]?.classList.toggle('hit', wanted);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface PageBox { number: number; width: number; height: number }
interface Shell { number: number; width: number; height: number }

interface Match { page: number; item: number }
interface PageText { number: number; lower: string; starts: readonly number[] }

/**
 * A text item, as much of one as this file touches.
 *
 * Declared here rather than imported from pdfjs-dist's deep type paths: four
 * fields is the whole of the contract, and a structural type cannot break on a
 * version that moves a declaration file.
 */
interface TextItem {
  str: string;
  width: number;
  height: number;
  hasEOL: boolean;
  transform: number[];
}

/** Only the two methods this file calls, so the page proxy need not be imported. */
interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
}

/**
 * Where pdf.js's own files were copied to, addressed off the document.
 *
 * `/pdfjs/…` under `ng serve` and `./pdfjs/…` beside index.html in a packaged
 * build, because the production configuration sets baseHref to `./` and a
 * packaged renderer is a `file://` page with no server under it.
 */
const PDFJS_ASSETS = new URL('pdfjs/', document.baseURI);

const ZOOM_STEPS = [0.25, 0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4] as const;
/** e^(100·rate) ≈ 1.2 — one wheel notch is one comfortable zoom step. */
const WHEEL_RATE = 0.0018;
const THUMB_WIDTH = 84;
/** Long enough that typing a word is one search, short enough to feel live. */
const QUERY_DELAY_MS = 250;

function pageOf(target: Element): number | null {
  const raw = target.getAttribute('data-page');
  if (raw === null) return null;
  const number = Number.parseInt(raw, 10);
  return Number.isFinite(number) ? number : null;
}

/** Which item a character offset falls in. The starts are ascending, so this is a walk. */
function itemAt(starts: readonly number[], offset: number): number {
  let found = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index]! > offset) break;
    found = index;
  }
  return found;
}

/**
 * Put every text item where the page put it — THE arithmetic of this file.
 *
 * `Util.transform(viewport.transform, item.transform)` composes the item's text
 * matrix with the viewport's, which is what turns PDF user space (y up, origin
 * bottom-left, points) into CSS pixels (y down, origin top-left, at the scale
 * the canvas beside it was drawn at). Both panes call this, so a layer that is
 * half a page off is half a page off in both — which is the only way the right
 * pane can be evidence about the left.
 *
 * The horizontal squeeze is measured rather than assumed: the layer's own font
 * is not on this machine, so a span set at the right size is still the wrong
 * WIDTH, and a line of text 15% too long is a line that no longer sits over its
 * ink. The item carries the width it occupied; the ruler says what the browser
 * will actually draw; the ratio between them goes on as a scaleX.
 */
function layoutText(
  items: readonly TextItem[],
  viewport: PageViewport,
  into: HTMLElement,
  ruler: CanvasRenderingContext2D | null,
): HTMLElement[] {
  const spans: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const tx = Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(tx[2]!, tx[3]!);
    const angle = Math.atan2(tx[1]!, tx[0]!);
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.fontFamily = LAYER_FONT;
    span.style.fontSize = `${size}px`;
    // An upright item's baseline box hangs from its origin; a rotated one's
    // hangs along the rotation. foundry never writes an angled line, but a page
    // bound sideways or somebody else's layer can carry one.
    span.style.left = `${angle === 0 ? tx[4]! : tx[4]! + size * Math.sin(angle)}px`;
    span.style.top = `${angle === 0 ? tx[5]! - size : tx[5]! - size * Math.cos(angle)}px`;

    let transform = angle === 0 ? '' : `rotate(${angle}rad)`;
    if (ruler) {
      ruler.font = `${size}px ${LAYER_FONT}`;
      const drawn = ruler.measureText(item.str).width;
      const wanted = item.width * viewport.scale;
      if (drawn > 0 && wanted > 0) transform += ` scaleX(${wanted / drawn})`;
    }
    if (transform.length > 0) span.style.transform = transform;

    spans.push(span);
    fragment.append(span);
  }
  into.replaceChildren(fragment);
  return spans;
}

/**
 * One family for both panes and for the ruler that measures them.
 *
 * The point is not that it resembles the scan's typeface — it cannot, and the
 * squeeze above corrects the width regardless. The point is that the measuring
 * and the drawing use the SAME font, because the moment they disagree every
 * span is scaled by a ratio computed for a different shape.
 */
const LAYER_FONT = 'serif';

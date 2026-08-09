/**
 * The EPUB viewer: a book's own pages, live, in a grid the picker can point at.
 *
 * The raster viewer (`pdf-viewer.component.ts`) paints rectangles over a bitmap
 * of a mupdf-laid-out page. This one paints nothing. It mounts the book's real
 * DOM — real fonts, real images, the publisher's own typesetting — inside
 * sandboxed frames, and puts the picker's marks ON those elements as CSS
 * classes. Both feed the same {@link LaidOutBook} contract and emit the same
 * gestures, so the picker above them does not care which is mounted.
 *
 * ── The host, and the measurement that chose it ────────────────────────────
 *
 * See `README.md` beside this file for the numbers. The short version, because
 * it is the reason this component is shaped the way it is:
 *
 *  - The book's bytes are served by `quire://`, which is registered on the
 *    DOCUMENT'S OWN Electron session, not the app's. An `<iframe>` in the
 *    Angular renderer is on the app's session and cannot resolve that scheme at
 *    all; giving the app's session a quire handler would put a stranger's markup
 *    on BookForge's own origin. So the frame is a `<webview>` with the
 *    document's `partition` — an out-of-process frame that keeps the book behind
 *    quire's CSP, which is what `packages/quire/src/mount.ts` already builds.
 *  - Under `fragmented-boxes` every page of a spine document is its own DOM
 *    subtree inside ONE frame, and the ~1 MB fragmenter that builds them runs
 *    once per frame. So a frame holds a whole SPINE DOCUMENT, gridded, not a
 *    page.
 *  - **A frame paginates only while it is on screen.** Paged.js ticks on
 *    `requestAnimationFrame` and Chromium gives an entirely off-screen frame
 *    none. Measured on Killing America: 20.7 ms/page fully visible, 20.9 ms/page
 *    half below the fold, and NO ANSWER AT ALL — twice, at 90 s — for a frame
 *    entirely below the fold. That single fact writes the virtualisation policy:
 *    a document is mounted when it comes into view and never before, and a
 *    mounted frame is then kept (it costs nothing once paginated) up to
 *    {@link MOUNTED_DOCUMENT_BUDGET}, evicting the least recently seen.
 *
 * ── What crosses the boundary ──────────────────────────────────────────────
 *
 * Ids, numbers and rectangles. Never markup, in either direction. The book's
 * HTML is never parsed into the Angular document, and the app never writes HTML
 * into the book: the marks are classes toggled on elements that are already
 * there, through one stylesheet, which is what quire's CSP admits. All of that
 * lives in `quire-frame-scripts.ts`.
 *
 * ── How a click becomes a block ────────────────────────────────────────────
 *
 * The frame reports, once, where every stamped element ended up. Hit-testing is
 * then pure arithmetic in Angular against those rectangles — no round trip per
 * click, no coordinates in the gestures. A stamped element resolves to the
 * `LaidOutBlock` whose `bf_element` IS that stamp, because that is what the
 * stamp is: `electron/quire-stamp.ts` writes the narration element key onto the
 * element. A book whose blocks do not carry `bf_element`, or two of whose blocks
 * claim the same one, is refused by name rather than guessed at.
 */
import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy,
  computed, effect, inject, input, output, signal, viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { LaidOutBlock, LaidOutBook } from '@shared/document/laid-out-book';
import type { Category } from '../../services/pdf.service';
import { blockCategoryColor } from '@shared/ocr/block-categories';
// Relative, not aliased: the package is outside `src/` and outside the Angular
// build's `include`, and `mount.ts` is written to be importable from a renderer
// (it imports nothing — see its header).
import { mountQuirePage, type MountedQuirePage } from '../../../../../../packages/quire/src/mount';
import { QUIRE_PAGE_MARGIN, type QuirePageMount } from '../../../../../../packages/quire/src/types';
import {
  applyMarksScript, arrangeScript, flowArrangeScript, flowZoomScript, zoomScript,
  type QuireFlowArrangement, type QuireFrameArrangement, type QuireFrameElement,
  type QuireFrameMarks, type QuireFramePage,
} from './quire-frame-scripts';

/**
 * Everything the viewer needs to SHOW a book, beside the {@link LaidOutBook}
 * that says what is in it.
 *
 * One entry per spine document, in spine order, each being the mount quire
 * produced for that document's FIRST page — which carries the document's URL,
 * its page-box size, its page count and its scripts. The individual pages need
 * no mounts of their own: they are page boxes inside that one frame.
 */
export interface EpubViewerSource {
  /** The Electron partition the document is confined to — `quire-<session>`. */
  partition: string;
  /** One per spine document, in spine order. */
  documents: readonly QuirePageMount[];
  /** Page-box width in CSS pixels, as the book was laid out. */
  pageWidth: number;
  /** Page-box height in CSS pixels, as the book was laid out. */
  pageHeight: number;
  /** Root font size the book was laid out at. The flow presentation sets the
   *  same one, so a paragraph reads identically paginated and flowing. */
  fontSize: number;
}

/** A spine document's band in the scroll column. */
interface DocumentBand {
  index: number;
  mount: QuirePageMount;
  /** Global page index of this document's first page. */
  firstPage: number;
  pageCount: number;
  columns: number;
  rows: number;
  /** Laid-out size at the current zoom, in CSS pixels. */
  width: number;
  height: number;
}

/** What a band's frame is doing. Never a guess — each state is a fact. */
type BandState =
  | { kind: 'unmounted' }
  | { kind: 'waiting-for-view' }
  | { kind: 'mounting' }
  /** `columns` is the grid the frame was ARRANGED into — compared against the
   *  band's current column count so a zoom that changes how many pages fit a
   *  row re-arranges the frame instead of leaving its grid and the overlay's
   *  grid disagreeing about where every page is. */
  | { kind: 'ready'; arrangement: QuireFrameArrangement; columns: number }
  | { kind: 'refused'; why: string };

/** A page as the overlay draws it: chrome, not content. */
interface PageChrome {
  globalPage: number;
  localPage: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How many paginated frames stay alive. Beyond this the least-recently-seen goes. */
const MOUNTED_DOCUMENT_BUDGET = 8;
/** Gap between page boxes, inside the frame and between bands. Matches the raster viewer's feel. */
const PAGE_GAP = 24;
/** Grid mode's base page width, the same 200 px the raster viewer uses for thumbnails. */
const GRID_BASE_WIDTH = 200;

@Component({
  selector: 'app-epub-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (refusal(); as why) {
      <div class="placeholder"><div class="refusal">{{ why }}</div></div>
    } @else if (source().documents.length === 0) {
      <div class="placeholder"><p>No book is open.</p></div>
    } @else {
      <div class="epub-viewport" #viewport (scroll)="onScroll()" (wheel)="onWheel($event)">
        <div
          class="epub-content"
          [class.single-column]="layout() !== 'grid'"
          [class.flow]="layout() === 'flow'"
        >
          @for (band of bands(); track band.index) {
            <div
              class="band"
              [attr.data-band]="band.index"
              [style.width.px]="band.width"
              [style.height.px]="band.height"
            >
              <div class="frame-host" [attr.data-frame-host]="band.index"></div>

              @let state = bandState(band.index);
              @if (state.kind !== 'ready') {
                <div class="band-placeholder">
                  @for (slot of placeholderSlots(band); track slot.localPage) {
                    <div
                      class="page-slot"
                      [style.left.px]="slot.x" [style.top.px]="slot.y"
                      [style.width.px]="slot.w" [style.height.px]="slot.h"
                    >
                      <span class="slot-label">{{ slot.globalPage + 1 }}</span>
                    </div>
                  }
                  <div class="band-status" [class.refused]="state.kind === 'refused'">
                    @switch (state.kind) {
                      @case ('waiting-for-view') { Waiting to come into view — a page only lays itself out on screen }
                      @case ('mounting') { Laying out {{ band.mount.document }}… }
                      @case ('refused') { {{ asRefused(state) }} }
                      @default { {{ band.mount.document }} }
                    }
                  </div>
                </div>
              }

              <div
                class="band-overlay"
                [class.marquee-active]="marqueeBand() === band.index"
                (mousedown)="onOverlayMouseDown($event, band)"
                (mousemove)="onOverlayMouseMove($event, band)"
                (mouseup)="onOverlayMouseUp($event, band)"
                (mouseleave)="onOverlayMouseLeave()"
                (contextmenu)="onOverlayContextMenu($event, band)"
              >
                @for (page of pageChrome(band.index); track page.globalPage) {
                  <div
                    class="page-frame"
                    [class.page-deleted]="deletedPages().has(page.globalPage)"
                    [class.page-selected]="selectedPages().has(page.globalPage)"
                    [style.left.px]="page.x" [style.top.px]="page.y"
                    [style.width.px]="page.w" [style.height.px]="page.h"
                  ></div>
                  <div
                    class="page-label"
                    [style.left.px]="page.x" [style.top.px]="page.y + page.h"
                    [style.width.px]="page.w"
                  >
                    <button
                      type="button"
                      class="page-delete"
                      [class.on]="deletedPages().has(page.globalPage)"
                      [title]="deletedPages().has(page.globalPage)
                        ? 'Bring this page back' : 'Exclude this page'"
                      (click)="onPageDeleteClick($event, page.globalPage)"
                    >{{ deletedPages().has(page.globalPage) ? '↺' : '✕' }}</button>
                    <span
                      class="page-number"
                      (click)="onPageLabelClick($event, page.globalPage)"
                    >Page {{ page.globalPage + 1 }}</span>
                    @if (deletedPages().has(page.globalPage)) {
                      <span class="deleted-badge">excluded</span>
                    }
                  </div>
                }
                @if (hoveredElement(); as hovered) {
                  @if (hovered.band === band.index) {
                    <div
                      class="hover-rect"
                      [style.left.px]="hovered.rect.x * scale()"
                      [style.top.px]="hovered.rect.y * scale()"
                      [style.width.px]="hovered.rect.w * scale()"
                      [style.height.px]="hovered.rect.h * scale()"
                      [style.borderColor]="hovered.color"
                    ></div>
                  }
                }
                @if (marqueeBand() === band.index) {
                  @if (marqueeRect(); as m) {
                    <div
                      class="marquee-rect"
                      [style.left.px]="m.x" [style.top.px]="m.y"
                      [style.width.px]="m.w" [style.height.px]="m.h"
                    ></div>
                  }
                }
              </div>
            </div>
          }
        </div>
      </div>

      @if (contextMenu(); as menu) {
        <div class="context-backdrop" (click)="closeContextMenu()" (contextmenu)="closeContextMenu()"></div>
        <div class="context-menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
          @if (menu.block) {
            <button type="button" (click)="fire('selectLikeThis', menu.block)">Select like this</button>
            <button type="button" (click)="fire('deleteLikeThis', menu.block)">Strike like this</button>
            <button type="button" (click)="onDeleteBlock(menu.block)">Strike this block</button>
            <div class="sep"></div>
          }
          <button type="button" (click)="onSelectAllOnPage(menu.page)">Select all on page {{ menu.page + 1 }}</button>
          <button type="button" (click)="onDeselectAllOnPage(menu.page)">Deselect page {{ menu.page + 1 }}</button>
          <button type="button" (click)="onPageDeleteToggle(menu.page)">
            {{ deletedPages().has(menu.page) ? 'Bring page back' : 'Exclude page' }}
          </button>
          <div class="sep"></div>
          <button
            type="button"
            class="disabled"
            disabled
            title="Merging is a working-PDF operation. On a live EPUB the picker's merge
                   goes through editorState, not the viewer — Phase C decides which."
          >Merge selection</button>
          <button
            type="button"
            class="disabled"
            disabled
            title="Splitting finds its split points from mupdf spans, which a live EPUB has none of."
          >Split block</button>
          <button
            type="button"
            class="disabled"
            disabled
            title="Cropping applies to a rasterized page. An EPUB page has no raster to crop."
          >Crop page</button>
        </div>
      }
    }
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      overflow: hidden;
    }

    .placeholder {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-sunken);
      padding: var(--ui-spacing-xl);
      color: var(--text-secondary);
      font-size: var(--ui-font-base);
    }

    .refusal {
      max-width: 640px;
      color: var(--text-primary);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      padding: var(--ui-spacing-lg);
      line-height: 1.5;
    }

    .epub-viewport {
      flex: 1;
      min-height: 0;
      overflow: auto;
      background: var(--bg-sunken);
      user-select: none;
      -webkit-user-select: none;
    }

    // The table the pages lie on should read as GRAY. In the light palette
    // --bg-sunken already is one (light sand), but the dark palette resolves it
    // to $neutral-950 — the deepest black on the ramp — and a grid of white
    // pages sits in a void. One step up the SAME ramp, $neutral-800 ("Dark
    // charcoal", the constant --bg-input is built from), is that gray. No new
    // token, and only the dark theme has anything to say.
    :host-context([data-theme='dark']) {
      .placeholder,
      .epub-viewport { background: $neutral-800; }
    }

    .epub-content {
      display: flex;
      flex-direction: column;
      // GRID is left-aligned, the way the raster viewer's grid is (flex-start
      // on both axes): centring made a narrow band sit under a wide one's
      // middle, so page 1 of one document did not line up with page 1 of the
      // next. A SINGLE COLUMN (list, flow) has no such alignment to keep —
      // every band is the same width — so it reads better centred, like a
      // page on a desk rather than a page against a wall.
      align-items: flex-start;
      gap: var(--ui-spacing-xl);
      padding: var(--ui-spacing-xl);

      &.single-column { align-items: center; }

      // FLOW is a book, not a table of cards. The chapters butt together into
      // one continuous white column — the seam between two bands is invisible
      // because both sides of it are the same white, and the 48px flow padding
      // on each side of the join is the chapter break's whitespace. Per-band
      // shadows would betray the seams (each band's shadow falls on its
      // neighbour's white), so the column wears none; on the gray table it
      // reads as one tall page. Generous tail padding so the last line of the
      // book is not glued to the bottom of the window.
      &.flow {
        gap: 0;
        padding-top: var(--ui-spacing-xl);
        padding-bottom: 120px;
      }

      &.flow .frame-host ::ng-deep webview { box-shadow: none; }
      &.flow .page-slot { box-shadow: none; }
    }

    .band {
      position: relative;
      flex-shrink: 0;
    }

    .frame-host {
      position: absolute;
      inset: 0;
      // The book is shown, never touched. Every pointer event belongs to the
      // overlay above, which is where the picker's gestures are decided.
      pointer-events: none;
    }

    .frame-host ::ng-deep webview {
      display: block;
      border: 0;
      background: #fff;
      box-shadow: var(--shadow-lg);
    }

    .band-placeholder {
      position: absolute;
      inset: 0;
    }

    // A slot and a mounted page are the same page at two moments, so they carry
    // the same chrome: one hairline at the page edge and the raster viewer's
    // drop shadow. A band that is still laying out must not look like a
    // different kind of thing from the band beside it that is ready.
    .page-slot {
      position: absolute;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      box-shadow: var(--shadow-lg);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .slot-label {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
    }

    .band-status {
      position: absolute;
      left: 0;
      bottom: -22px;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);

      &.refused { color: #ff6b6b; }
    }

    .band-overlay {
      position: absolute;
      inset: 0;
      cursor: default;

      &.marquee-active { cursor: crosshair; }
    }

    .page-frame {
      position: absolute;
      pointer-events: none;
      // Each of these is ONE page. Inside a band the pages share a single
      // white webview, so without this the 24 px gutter between two pages is
      // white on white and there is no telling where one ends. Outline and
      // shadow both paint OUTSIDE the border box, so the page boxes do not
      // move — the gutter the arrange script laid out is untouched.
      outline: 1px solid var(--border-default);
      box-shadow: var(--shadow-lg);

      &.page-selected { outline: 2px solid var(--accent); }
      &.page-deleted { outline: 2px solid #ff4444; background: rgba(255, 68, 68, 0.08); }
    }

    .page-label {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xs) 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .page-number { cursor: pointer; }

    .page-delete {
      border: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border-radius: $radius-sm;
      cursor: pointer;
      font-size: var(--ui-font-xs);
      line-height: 1;
      padding: 2px 6px;

      &:hover { background: var(--hover-bg); }
      &.on { color: #ff4444; border-color: #ff4444; }
    }

    .deleted-badge {
      color: #ff4444;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .hover-rect {
      position: absolute;
      pointer-events: none;
      border: 1px solid var(--accent);
      background: rgba(6, 182, 212, 0.08);
    }

    .marquee-rect {
      position: absolute;
      pointer-events: none;
      background: var(--accent-subtle);
      border: 2px solid var(--accent);
    }

    .context-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
    }

    .context-menu {
      position: fixed;
      z-index: 41;
      min-width: 220px;
      background: var(--bg-overlay);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      box-shadow: var(--shadow-lg);
      padding: var(--ui-spacing-xs);
      display: flex;
      flex-direction: column;

      button {
        text-align: left;
        background: transparent;
        border: 0;
        color: var(--text-primary);
        font-size: var(--ui-font-sm);
        padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
        border-radius: $radius-sm;
        cursor: pointer;

        &:hover:not(:disabled) { background: var(--hover-bg); }
        &:disabled { color: var(--text-tertiary); cursor: not-allowed; }
      }

      .sep {
        height: 1px;
        background: var(--border-subtle);
        margin: var(--ui-spacing-xs) 0;
      }
    }
  `],
})
export class EpubViewerComponent implements AfterViewInit, OnDestroy {
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  // ── inputs: the meaning half, the same names the raster viewer uses ───────

  /** The book as a viewer laid it out. See `shared/document/laid-out-book.ts`. */
  readonly book = input.required<LaidOutBook>();
  /** How to SHOW it — quire's mounts. Separate because it is not the picker's business. */
  readonly source = input.required<EpubViewerSource>();
  readonly categories = input.required<Record<string, Category>>();
  readonly hiddenCategoryIds = input.required<ReadonlySet<string>>();
  readonly selectedBlockIds = input.required<readonly string[]>();
  readonly deletedBlockIds = input.required<ReadonlySet<string>>();
  readonly deletedPages = input<ReadonlySet<number>>(new Set<number>());
  readonly selectedPages = input<ReadonlySet<number>>(new Set<number>());
  readonly tocSelectedBlockIds = input<ReadonlySet<string>>(new Set<string>());
  /** Percent, exactly like the raster viewer's — 100 is 1:1. */
  readonly zoom = input.required<number>();
  /**
   * `vertical` and `grid` show the book's PAGES — one column or as many as
   * fit. `flow` shows each chapter as one continuous column, unpaginated, the
   * way the publisher's own markup flows; the next chapter starts a new band.
   * Identity does not move with the mode: blocks keep their paginated page
   * numbers, because the pages are what the book was analysed as.
   */
  readonly layout = input.required<'vertical' | 'grid' | 'flow'>();
  /** The picker's colour layer — every categorised block wears a wash of its
   *  category's colour, exactly as the raster viewer paints it. */
  readonly showCategoryColors = input<boolean>(false);

  // ── outputs: the same gestures, in LaidOutBlock terms ─────────────────────

  readonly blockClick = output<{
    block: LaidOutBlock; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean;
  }>();
  /**
   * Modifiers ride along because the picker reads them: a double-click with
   * meta/ctrl held ADDS the like-this run to the selection instead of replacing
   * it. Emitting the block alone would have made every double-click on a live
   * book replacing, which is a quiet behaviour change rather than a missing
   * feature — the raster viewer has carried them all along.
   */
  readonly blockDoubleClick = output<{
    block: LaidOutBlock; metaKey: boolean; ctrlKey: boolean;
  }>();
  readonly blockHover = output<LaidOutBlock | null>();
  readonly selectLikeThis = output<LaidOutBlock>();
  readonly deleteLikeThis = output<LaidOutBlock>();
  readonly deleteBlock = output<string>();
  readonly marqueeSelect = output<{ blockIds: string[]; additive: boolean }>();
  readonly pageDeleteToggle = output<number>();
  readonly pageSelect = output<{
    pageNum: number; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean;
  }>();
  readonly selectAllOnPage = output<number>();
  readonly deselectAllOnPage = output<number>();
  /** A zoom DELTA in percent, the same shape the raster viewer emits. */
  readonly zoomChange = output<number>();

  // ── internal state ────────────────────────────────────────────────────────

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');

  private readonly viewportWidth = signal(0);
  private readonly states = signal<ReadonlyMap<number, BandState>>(new Map());
  private readonly mounted = new Map<number, MountedQuirePage>();
  private readonly lastSeen = new Map<number, number>();
  /**
   * The geometry each frame SHOULD be showing right now, and which frames have
   * a worker chasing it. One worker per frame, always chasing the latest
   * target: a ctrl+wheel burst lands many zoom changes in a row, and letting
   * each start its own sync loop was measured to fail — a stale loop's pixel
   * nudge re-imposed its old size while the newer loop was checking, the two
   * fought, and the band refused with the previous zoom step's viewport
   * (368×552 inside 300×450 — exactly one step's ratio apart).
   */
  private readonly syncTargets = new Map<number, { w: number; h: number; scale: number }>();
  private readonly syncing = new Set<number>();
  /**
   * Measured content height of each FLOW frame, unscaled CSS pixels. A flow's
   * height is a fact only its own layout can state, so until a frame reports,
   * its band reserves an estimate (see {@link bands}) and is corrected here.
   */
  private readonly flowHeights = signal<ReadonlyMap<number, number>>(new Map());
  /** The layout the frames were MOUNTED for — see the mode-switch effect. */
  private prevLayoutWasFlow: boolean | null = null;
  private observer: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reconcileQueued = false;

  protected readonly hoveredElement = signal<
    { band: number; id: string; rect: QuireFrameElement; color: string } | null>(null);
  protected readonly marqueeBand = signal<number | null>(null);
  protected readonly marqueeRect = signal<{ x: number; y: number; w: number; h: number } | null>(null);
  private marqueeOrigin: { x: number; y: number; additive: boolean } | null = null;
  protected readonly contextMenu = signal<
    { x: number; y: number; page: number; block: LaidOutBlock | null } | null>(null);
  private lastClick = { id: '', at: 0 };

  /** Display scale: a transform, never a reflow. See {@link zoomScript}. */
  protected readonly scale = computed(() => {
    const z = this.zoom() / 100;
    if (this.layout() === 'grid') return (GRID_BASE_WIDTH / this.source().pageWidth) * z;
    return z; // vertical and flow are both one column at the page's own width
  });

  /**
   * The book's blocks, indexed by the element key the frame will report.
   *
   * SEVERAL blocks per key is the split design, not an error: an element that
   * crosses a page break yields one block per page it touches, every one
   * carrying the same `bf_element` (on Killing America, 69 elements do this).
   * The fragments are kept sorted by page, and a hit resolves to the fragment
   * on the page the click actually landed on — deterministic, never arbitrary.
   *
   * What IS refused: a block without a key (nothing to point at — this viewer
   * will not fall back to matching by position), and two blocks claiming one
   * element on the SAME page, which no click could ever tell apart.
   */
  private readonly blocksByElement = computed<ReadonlyMap<string, readonly LaidOutBlock[]>>(() => {
    const map = new Map<string, LaidOutBlock[]>();
    for (const block of this.book().blocks) {
      const key = block.bf_element;
      if (key === undefined) {
        throw new Error(
          `Block ${block.id} carries no bf_element, so the element it names on the page cannot `
          + 'be found. The EPUB viewer points at the book\'s own markup and has nothing else to '
          + 'point with; it will not fall back to matching by position.',
        );
      }
      const fragments = map.get(key);
      if (fragments === undefined) {
        map.set(key, [block]);
        continue;
      }
      const samePage = fragments.find((f) => f.page === block.page);
      if (samePage !== undefined) {
        throw new Error(
          `Blocks ${samePage.id} and ${block.id} both claim element ${key} on page `
          + `${block.page}. Split fragments live on different pages by construction, so two on `
          + 'one page cannot be told apart, and the book is not shown.',
        );
      }
      fragments.push(block);
    }
    for (const fragments of map.values()) fragments.sort((a, b) => a.page - b.page);
    return map;
  });

  /**
   * The fragment of `key` on global page `page` — exact for a split element,
   * and the only fragment there is for everything else.
   *
   * A miss is a refusal, not a nearest-match: the arrangement said the element
   * has a box on this page, so a block list that disagrees means the analysis
   * and the viewer paginated differently, which the page-count guard exists to
   * catch — never resolved here by guessing.
   */
  private fragmentOn(key: string, fragments: readonly LaidOutBlock[], page: number): LaidOutBlock {
    if (fragments.length === 1) return fragments[0];
    const exact = fragments.find((f) => f.page === page);
    if (exact === undefined) {
      throw new Error(
        `Element ${key} has a box on page ${page}, but its blocks claim only page(s) `
        + `${fragments.map((f) => f.page).join(', ')}. The analysis and the viewer disagree `
        + 'about this book\'s pagination, and a click will not pick a page for them.',
      );
    }
    return exact;
  }

  /** Element keys of the blocks the picker says are struck. */
  private readonly struckElements = computed(() => {
    const byId = new Map(this.book().blocks.map((b) => [b.id, b]));
    const out: string[] = [];
    for (const id of this.deletedBlockIds()) {
      const block = byId.get(id);
      if (block?.bf_element !== undefined) out.push(block.bf_element);
    }
    return out;
  });

  /**
   * Element keys with a fragment on a DELETED page.
   *
   * The picker presents a page whose every block is struck as a deleted PAGE
   * and takes those blocks OUT of the block-strike set (rebuildNarrationView).
   * The paginated layouts show that as page chrome — a red outline and an
   * "excluded" badge on the page box. FLOW has no page boxes, so without this
   * the content of a deleted page looks completely untouched (measured on
   * Killing America: 345 footnote blocks struck, 39 footnote-only pages
   * converted, and only the 82 blocks sharing a page with body text showed any
   * strikethrough — the user re-deleted the "missing" ones for an hour, each
   * attempt a silent already-recorded no-op). In flow, the elements themselves
   * wear the strike.
   */
  private readonly pageDeletedElements = computed(() => {
    const pages = this.deletedPages();
    if (pages.size === 0) return [] as string[];
    const out: string[] = [];
    for (const [key, fragments] of this.blocksByElement()) {
      if (fragments.some((f) => pages.has(f.page))) out.push(key);
    }
    return out;
  });

  private readonly selectedElements = computed(() => this.elementsFor(this.selectedBlockIds()));
  private readonly tocElements = computed(() => this.elementsFor([...this.tocSelectedBlockIds()]));

  /**
   * Each element's category colour, as a palette of distinct colours plus an
   * index per element — the shape {@link applyMarksScript} builds its
   * stylesheet from.
   *
   * The colour is the raster viewer's `getCategoryColor` verbatim: the
   * contract palette wins, the book's own measured record covers custom
   * categories, unlabeled is the same neutral gray. A split element's
   * fragments share one category in practice; if they ever disagree, the
   * FIRST fragment's colour paints the element — marks are per element, so
   * one element cannot wear two colours anyway.
   *
   * `washable` is the colour layer's audience: every categorised element
   * whose category is not hidden. Unlabeled elements stay blank there — in
   * the colour layer, no wash IS the "unjudged" state.
   */
  private readonly categoryMarks = computed(() => {
    const hidden = this.hiddenCategoryIds();
    const palette: string[] = [];
    const paletteIndex = new Map<string, number>();
    const categoryOf: Record<string, number> = {};
    const washable: string[] = [];
    for (const [key, fragments] of this.blocksByElement()) {
      const id = fragments[0].category_id;
      const color = this.colorOf(fragments[0]);
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw new Error(
          `Category "${id}" resolves to colour "${color}", which is not a six-digit hex colour. `
          + 'The viewer derives its highlight opacities by appending an alpha byte, so this '
          + 'colour cannot be painted and the marks are not applied.',
        );
      }
      let idx = paletteIndex.get(color);
      if (idx === undefined) { idx = palette.length; palette.push(color); paletteIndex.set(color, idx); }
      categoryOf[key] = idx;
      if (id && !hidden.has(id)) washable.push(key);
    }
    return { palette, categoryOf, washable };
  });

  /**
   * The colour of a block's category — the raster viewer's `getCategoryColor`
   * verbatim: the contract palette wins, the book's own record covers custom
   * categories, unlabeled is a neutral gray rather than the unresolvable-
   * category orange.
   */
  private colorOf(block: LaidOutBlock): string {
    const id = block.category_id;
    if (!id) return '#9E9E9E';
    return blockCategoryColor(id, this.categories()[id]?.color || '#FF9500');
  }

  private elementsFor(blockIds: readonly string[]): string[] {
    const byId = new Map(this.book().blocks.map((b) => [b.id, b]));
    const out: string[] = [];
    for (const id of blockIds) {
      const block = byId.get(id);
      if (block?.bf_element !== undefined) out.push(block.bf_element);
    }
    return out;
  }

  /**
   * Anything that stops the book being shown at all, said in one place.
   *
   * A viewer that cannot resolve a click to a block would emit gestures naming
   * the wrong block, and the picker would strike the wrong text — so this is a
   * refusal, not a warning.
   */
  protected readonly refusal = computed<string | null>(() => {
    const src = this.source();
    if (src.documents.length > 0) {
      const wrong = src.documents.find((m) => m.boxModel !== 'fragmented-boxes');
      if (wrong) {
        return `This book was paginated with a "${wrong.boxModel}" strategy, whose pages are `
          + 'windows onto one continuous flow rather than separate boxes. This viewer grids page '
          + 'boxes and has nothing to grid.';
      }
    }
    try {
      this.blocksByElement();
      this.categoryMarks();
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  });

  /** The bands, laid out — one per spine document, in spine order. */
  protected readonly bands = computed<DocumentBand[]>(() => {
    const src = this.source();
    const scale = this.scale();
    const layout = this.layout();
    const available = Math.max(1, this.viewportWidth() - 2 * PAGE_GAP);
    const pageW = src.pageWidth * scale;
    const pageH = src.pageHeight * scale;
    const gap = PAGE_GAP;
    const fit = layout === 'grid'
      ? Math.max(1, Math.floor((available + gap) / (pageW + gap)))
      : 1;
    const flowHeights = this.flowHeights();

    const out: DocumentBand[] = [];
    let firstPage = 0;
    for (let i = 0; i < src.documents.length; i++) {
      const mount = src.documents[i];
      const pageCount = mount.documentPageCount;
      if (layout === 'flow') {
        // One continuous column per chapter. Until the frame has measured its
        // own flow, the band reserves the paginated CONTENT length — page
        // count times the content box — which is a reservation awaiting the
        // measurement, not an answer in its place: the frame's report replaces
        // it the moment the chapter is laid out.
        const measured = flowHeights.get(i);
        const contentH = measured
          ?? pageCount * (src.pageHeight - 2 * QUIRE_PAGE_MARGIN) + 2 * QUIRE_PAGE_MARGIN;
        out.push({
          index: i, mount, firstPage, pageCount,
          columns: 1, rows: 1,
          width: pageW,
          height: contentH * scale,
        });
        firstPage += pageCount;
        continue;
      }
      const columns = Math.max(1, Math.min(fit, pageCount));
      const rows = Math.ceil(pageCount / columns);
      out.push({
        index: i,
        mount,
        firstPage,
        pageCount,
        columns,
        rows,
        width: columns * pageW + (columns - 1) * gap * scale,
        height: rows * pageH + (rows - 1) * gap * scale,
      });
      firstPage += pageCount;
    }
    return out;
  });

  constructor() {
    // Zoom is a transform on already-measured boxes, so a change costs one
    // script per live frame and no re-measurement — UNLESS it changed how many
    // columns fit a grid row, in which case the frame must be re-arranged (a
    // re-grid and re-measure, still never a re-pagination). Either way the
    // effect only RECORDS what each frame should look like; the one worker per
    // frame (chaseFrameSync) does the asking, so a burst of wheel ticks
    // coalesces instead of racing.
    effect(() => {
      const scale = this.scale();
      const bands = this.bands();
      const states = this.states(); // dependency: chase a band the moment it becomes ready
      for (const [index, frame] of this.mounted) {
        const band = bands[index];
        if (!band) continue;
        frame.element.style.width = `${band.width}px`;
        frame.element.style.height = `${band.height}px`;
        this.syncTargets.set(index, { w: band.width, h: band.height, scale });
        // Only a READY frame is chased. While a band is mounting, mountBand
        // owns its frame and sequences sync → arrange itself; when it finishes,
        // this effect re-runs (states is a dependency) and catches it up to
        // whatever the zoom is by then.
        if (states.get(index)?.kind === 'ready') void this.chaseFrameSync(index, frame);
      }
    });

    // The marks are whole-state, so any change to any of them re-states all of
    // them on every live frame. See applyMarksScript for why not a diff.
    effect(() => {
      // A refused book mounts nothing, and reading categoryMarks below would
      // re-throw the very error the refusal is already displaying.
      if (this.refusal() !== null) return;
      // Read every marks input HERE, not only inside frameMarks — the effect
      // must track them even at a moment when no frame is mounted, or the
      // first mount after a change would wear the state before it.
      this.struckElements();
      this.selectedElements();
      this.tocElements();
      this.deletedPages();
      this.categoryMarks();
      this.showCategoryColors();
      const bands = this.bands();
      for (const [index, frame] of this.mounted) {
        const band = bands[index];
        if (!band) continue;
        // Never mark a frame that is still paginating: applyMarksScript builds
        // its id→elements index on first use, and an index built before
        // Paged.js has cloned the elements into page boxes would be cached
        // wrong for the frame's whole life. mountBand applies the marks itself
        // the moment the frame is ready.
        if (this.bandState(index).kind !== 'ready') continue;
        void this.evaluate(frame, applyMarksScript(this.frameMarks(band)))
          .catch((err: unknown) => {
            this.setState(index, { kind: 'refused', why: String((err as Error).message) });
          });
      }
    });

    // A band list that changed shape needs its elements re-observed.
    effect(() => {
      this.bands();
      this.queueReconcile();
    });

    // A frame's PRESENTATION is decided at mount: paginated frames ran the
    // fragmenter, flow frames never will. Crossing that line, in either
    // direction, therefore unmounts everything — the frames' contents are the
    // wrong kind of thing, not the wrong arrangement of it. vertical↔grid
    // stays cheap: same frames, re-gridded by the sync worker.
    effect(() => {
      const isFlow = this.layout() === 'flow';
      const was = this.prevLayoutWasFlow;
      this.prevLayoutWasFlow = isFlow;
      if (was === null || was === isFlow) return;
      queueMicrotask(() => {
        for (const index of [...this.mounted.keys()]) this.unmountBand(index);
        this.flowHeights.set(new Map());
        this.queueReconcile();
        this.reconcileVisibility();
      });
    });
  }

  ngAfterViewInit(): void {
    const viewport = this.viewport()?.nativeElement;
    if (!viewport) {
      throw new Error('The EPUB viewer has no viewport element, so it cannot decide what is on screen.');
    }
    this.viewportWidth.set(viewport.clientWidth);
    this.resizeObserver = new ResizeObserver(() => this.viewportWidth.set(viewport.clientWidth));
    this.resizeObserver.observe(viewport);

    // rootMargin is deliberately ZERO. A frame paginates only while it is on
    // screen (measured: no answer at all, twice at 90 s, for a frame entirely
    // below the fold), so mounting one "just ahead" would mount something that
    // then sits there doing nothing until the user scrolls onto it.
    this.observer = new IntersectionObserver(() => this.reconcileVisibility(),
      { root: viewport, rootMargin: '0px', threshold: 0 });

    this.queueReconcile();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.resizeObserver?.disconnect();
    for (const frame of this.mounted.values()) frame.destroy();
    this.mounted.clear();
  }

  // ── the parent's one reach-in ─────────────────────────────────────────────

  /**
   * Put a page on screen. The raster viewer's method of the same name, and the
   * only one of its seven the parent calls that means anything to a live book —
   * search results, the page timeline and the outline all navigate by page.
   *
   * Arithmetic against the band geometry rather than `scrollIntoView` on a page
   * element, because the page in question may well not exist yet: its band's
   * frame is mounted only once the band is on screen, so the target is usually a
   * placeholder slot at the moment it is asked for. The bands reserve exactly
   * the space their pages will occupy, so the arithmetic lands in the same place
   * either way, and scrolling there is what causes the frame to mount.
   */
  scrollToPage(page: number): void {
    const viewport = this.viewport()?.nativeElement;
    if (!viewport) return; // not in the DOM yet; the initial scroll position is page 0 anyway

    const bands = this.bands();
    const band = bands.find((b) => page >= b.firstPage && page < b.firstPage + b.pageCount);
    if (!band) {
      throw new Error(
        `The book on screen has ${bands.reduce((n, b) => n + b.pageCount, 0)} page(s), so page `
        + `${page + 1} cannot be scrolled to. Nothing was moved.`,
      );
    }

    const root = this.hostRef.nativeElement as HTMLElement;
    const bandEl = root.querySelector<HTMLElement>(`[data-band="${band.index}"]`);
    if (!bandEl) return; // the band is rendered on the next tick; the caller may ask again

    // A flow has no page boundaries to land on, so the chapter is entered at
    // the page's share of its length — page 3 of a 10-page chapter lands
    // three tenths of the way down. Approximate by construction, and honestly
    // so: the exact position of a page break is a fact only pagination has.
    if (this.layout() === 'flow') {
      const frac = (page - band.firstPage) / band.pageCount;
      viewport.scrollTop = Math.max(0, bandEl.offsetTop + frac * band.height - PAGE_GAP);
      this.reconcileVisibility();
      return;
    }

    // Which ROW of this band's grid the page sits in. A band is the only thing
    // with a position of its own — pages inside it are laid out by the same
    // columns/rows arithmetic the placeholder slots use.
    const scale = this.scale();
    const row = Math.floor((page - band.firstPage) / band.columns);
    const rowHeight = this.source().pageHeight * scale + PAGE_GAP * scale;

    viewport.scrollTop = Math.max(0, bandEl.offsetTop + row * rowHeight - PAGE_GAP);
    this.reconcileVisibility();
  }

  // ── mounting ──────────────────────────────────────────────────────────────

  private queueReconcile(): void {
    if (this.reconcileQueued) return;
    this.reconcileQueued = true;
    queueMicrotask(() => {
      this.reconcileQueued = false;
      this.observeBands();
    });
  }

  /** Watch every band element currently rendered. Cheap and idempotent. */
  private observeBands(): void {
    const observer = this.observer;
    if (!observer) return;
    const root = this.hostRef.nativeElement as HTMLElement;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-band]'))) {
      observer.observe(el);
    }
  }

  protected bandState(index: number): BandState {
    return this.states().get(index) ?? { kind: 'unmounted' };
  }

  protected asRefused(state: BandState): string {
    return state.kind === 'refused' ? state.why : '';
  }

  private setState(index: number, state: BandState): void {
    const next = new Map(this.states());
    next.set(index, state);
    this.states.set(next);
  }

  /**
   * Bring one spine document's frame up: load it, let quire paginate it, then
   * grid its page boxes and read where everything landed.
   *
   * Idempotent, and never runs twice for the same band at once — a second
   * pagination of the same frame would produce a second, possibly different,
   * page map for one document.
   */
  private async mountBand(index: number): Promise<void> {
    const current = this.bandState(index);
    if (current.kind === 'mounting' || current.kind === 'ready' || current.kind === 'refused') return;

    const band = this.bands()[index];
    if (!band) return;
    const host = (this.hostRef.nativeElement as HTMLElement)
      .querySelector<HTMLElement>(`[data-frame-host="${index}"]`);
    if (!host) {
      // The band is in the model but not yet in the DOM. The observer will call
      // again the moment it is, so this is a fact about timing, not a failure.
      this.setState(index, { kind: 'waiting-for-view' });
      this.queueReconcile();
      return;
    }

    this.setState(index, { kind: 'mounting' });
    const flow = this.layout() === 'flow';
    const frame = mountQuirePage(band.mount, host, {
      partition: this.source().partition, flow,
    });
    this.mounted.set(index, frame);
    // A mount can be CANCELLED — the user scrolls past a chapter before it has
    // finished laying itself out, and an off-screen frame cannot finish anyway.
    // Every await below therefore checks that this frame is still the band's
    // frame, and returns silently if it is not. Without that check a cancelled
    // mount comes back as a refusal, and the band would tell the user its
    // chapter is broken when all that happened is that they scrolled.
    const cancelled = (): boolean => this.mounted.get(index) !== frame;
    try {
      // The frame is one page wide until it has been arranged; give it the
      // band's size straight away so the layout does not jump under the user.
      frame.element.style.width = `${band.width}px`;
      frame.element.style.height = `${band.height}px`;
      await frame.ready;
      if (cancelled()) return;

      // The element is sized; make sure the guest actually FOLLOWED before
      // anything is arranged or measured in it. Measured failure mode: element
      // 200×300, guest viewport 200×150 — the bottom half of every page is
      // simply never painted, and nothing errors.
      await this.syncGuestViewport(frame, band.width, band.height);
      if (cancelled()) return;

      if (flow) {
        const src = this.source();
        const flowed = await this.evaluate<QuireFlowArrangement>(
          frame, flowArrangeScript(src.pageWidth, QUIRE_PAGE_MARGIN, src.fontSize, this.scale()));
        if (cancelled()) return;
        // A flow has no page boxes, so the paginated invariants (page count,
        // orphans) have nothing to say here; every stamped element is measured
        // in one unbroken column. The empty pages array is what turns the page
        // chrome off in the overlay.
        const arrangement: QuireFrameArrangement = {
          pages: [], elements: flowed.elements, nodes: flowed.nodes, orphans: 0,
        };
        this.flowHeights.update((m) => new Map(m).set(index, flowed.height));
        this.setState(index, { kind: 'ready', arrangement, columns: 1 });
      } else {
        const arrangement = await this.evaluate<QuireFrameArrangement>(
          frame, arrangeScript(band.columns, PAGE_GAP, this.scale()));
        if (cancelled()) return;
        if (arrangement.pages.length !== band.pageCount) {
          throw new Error(
            `quire said ${band.mount.document} has ${band.pageCount} pages but the frame laid out `
            + `${arrangement.pages.length}. The page numbers on screen would not be the page `
            + 'numbers the book was analysed with.');
        }
        if (arrangement.orphans > 0) {
          throw new Error(
            `${arrangement.orphans} stamped element(s) in ${band.mount.document} are inside no `
            + 'page box, so they could be shown but not pointed at.');
        }
        this.setState(index, { kind: 'ready', arrangement, columns: band.columns });
      }

      await this.evaluate(frame, applyMarksScript(this.frameMarks(band)));
      this.evictBeyondBudget();
    } catch (err) {
      if (cancelled()) return;
      this.unmountBand(index);
      this.setState(index, { kind: 'refused', why: String((err as Error).message ?? err) });
    }
  }

  private unmountBand(index: number): void {
    const frame = this.mounted.get(index);
    if (!frame) return;
    frame.destroy();
    this.mounted.delete(index);
    this.syncTargets.delete(index);
    this.setState(index, { kind: 'unmounted' });
  }

  /**
   * The whole of what a band's frame should be wearing, assembled from the
   * picker's current state. The wash — the colour layer — subtracts anything
   * selected or toc-selected, so the 1 px wash outline never overrides a
   * stronger mark's 2 px one (both stylesheets speak with !important, and the
   * category sheet is the later of the two).
   */
  private frameMarks(band: DocumentBand): QuireFrameMarks {
    const selected = this.selectedElements();
    const toc = this.tocElements();
    const { palette, categoryOf, washable } = this.categoryMarks();
    const strong = new Set([...selected, ...toc]);
    return {
      // In flow the page-deleted content strikes element by element — there is
      // no page box to carry the state. Paginated layouts keep the page chrome
      // and the block strikes exactly as they were.
      struck: this.layout() === 'flow'
        ? [...new Set([...this.struckElements(), ...this.pageDeletedElements()])]
        : this.struckElements(),
      selected,
      tocSelected: toc,
      struckPages: [...this.deletedPages()]
        .filter((p) => p >= band.firstPage && p < band.firstPage + band.pageCount)
        .map((p) => p - band.firstPage),
      palette,
      categoryOf,
      wash: this.showCategoryColors() ? washable.filter((k) => !strong.has(k)) : [],
    };
  }

  /**
   * A paginated frame costs nothing off screen, so frames are kept rather than
   * dropped the moment they leave the viewport — re-mounting one costs a whole
   * re-pagination, and a re-pagination that starts off screen never finishes.
   */
  private evictBeyondBudget(): void {
    while (this.mounted.size > MOUNTED_DOCUMENT_BUDGET) {
      let oldest = -1;
      let oldestAt = Infinity;
      for (const index of this.mounted.keys()) {
        // Only a FINISHED frame may be evicted. A frame still paginating owns a
        // promise this component is awaiting; destroying it would reject that
        // promise and the band would show a refusal for a mount that was going
        // perfectly well. Scrolling fast therefore goes briefly over budget
        // rather than briefly wrong.
        if (this.bandState(index).kind !== 'ready') continue;
        const at = this.lastSeen.get(index) ?? 0;
        if (at < oldestAt) { oldestAt = at; oldest = index; }
      }
      if (oldest < 0) return;
      this.unmountBand(oldest);
    }
  }

  /**
   * Evaluate one of the viewer's scripts in a frame and insist on an answer.
   *
   * The scripts always return a JSON string — the same convention quire's own
   * prelude and present scripts use — so an error inside the frame arrives here
   * as a named message rather than as an undefined value.
   */
  private async evaluate<T>(frame: MountedQuirePage, script: string): Promise<T> {
    const guest = frame.element as HTMLElement & { executeJavaScript(code: string): Promise<unknown> };
    const raw = await guest.executeJavaScript(script);
    const parsed = JSON.parse(String(raw)) as T & { error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return parsed;
  }

  /**
   * Bring one frame up to date with the LATEST recorded target, however many
   * targets were recorded while it worked.
   *
   * The loop shape is the whole point: it re-reads `syncTargets` after every
   * await, so a zoom that lands mid-chase is simply the next lap, never a
   * second concurrent chaser. A sync failure against a target that is no
   * longer the latest is not a verdict about the frame — the size it failed to
   * reach is not the size wanted any more.
   *
   * A failure against the CURRENT target is retried before anything drastic:
   * a busy or occluded guest can lag its element for seconds (occlusion
   * throttles the guest's whole event loop), and a refusal for a lag that
   * clears itself is an error dialog about weather. Only a frame that
   * persistently will not follow is dealt with — by REMOUNT, not refusal: the
   * band re-lays itself out fresh, which actually fixes the stale viewport,
   * where a refusal would just describe it and strand the chapter.
   */
  private async chaseFrameSync(index: number, frame: MountedQuirePage): Promise<void> {
    if (this.syncing.has(index)) return; // the running worker re-reads the target each lap
    this.syncing.add(index);
    let failures = 0;
    try {
      for (;;) {
        const target = this.syncTargets.get(index);
        if (!target || this.mounted.get(index) !== frame) return;
        const state = this.bandState(index);
        if (state.kind !== 'ready') return;
        try {
          await this.syncGuestViewport(frame, target.w, target.h);
          failures = 0;
          if (this.mounted.get(index) !== frame) return;
          if (this.syncTargets.get(index) !== target) continue;
          const band = this.bands()[index];
          if (!band) return;
          if (this.layout() === 'flow') {
            // A flow is always one column; only its transform follows the zoom.
            await this.evaluate(frame, flowZoomScript(target.scale));
            if (this.mounted.get(index) !== frame) return;
          } else if (band.columns !== state.columns) {
            // The zoom changed how many pages fit a row. A transform cannot
            // express that — the page boxes must actually move — so re-grid
            // and re-measure. Pagination is untouched: the boxes are the same
            // boxes, in new places.
            const arrangement = await this.evaluate<QuireFrameArrangement>(
              frame, arrangeScript(band.columns, PAGE_GAP, target.scale));
            if (this.mounted.get(index) !== frame) return;
            this.setState(index, { kind: 'ready', arrangement, columns: band.columns });
          } else {
            await this.evaluate(frame, zoomScript(target.scale));
            if (this.mounted.get(index) !== frame) return;
          }
        } catch (err) {
          if (this.mounted.get(index) !== frame) return;
          if (this.syncTargets.get(index) !== target) continue; // stale failure, chase the new size
          failures++;
          if (failures < 3) {
            // Give a lagging guest time to breathe, then try the same target
            // again from the top (repair, nudge and all).
            await new Promise<void>((r) => setTimeout(r, 500 * failures));
            continue;
          }
          console.warn(
            `[epub-viewer] band ${index} (${frame.element.getAttribute('src') ?? '?'}): `
            + `${String((err as Error).message)} Remounting the band instead of stranding it.`,
          );
          this.unmountBand(index);
          this.queueReconcile();
          this.reconcileVisibility();
          return;
        }
        if (this.syncTargets.get(index) === target) return; // caught up
      }
    } finally {
      this.syncing.delete(index);
    }
  }

  /**
   * Make the frame's INNER viewport actually match its element, or refuse.
   *
   * A `<webview>` guest is supposed to follow the element's box, but Electron
   * drops resizes that land while the guest is busy loading or laying out —
   * measured on the real book: element 200×300, guest viewport 200×150, and a
   * browser paints nothing below its viewport, so the bottom half of every
   * page simply did not exist on screen (and each zoom re-resize could strand
   * it somewhere new). So the guest is ASKED, and if it disagrees the element
   * is nudged by a pixel — which forces Electron's internal resize path — and
   * asked again. Loudly refusing beats quietly showing the top of a page.
   */
  private async syncGuestViewport(
    frame: MountedQuirePage, width: number, height: number,
  ): Promise<void> {
    const guest = frame.element as HTMLElement & { executeJavaScript(code: string): Promise<unknown> };
    const expected = { w: Math.round(width), h: Math.round(height) };
    let got = { w: 0, h: 0 };
    for (let attempt = 0; attempt < 6; attempt++) {
      got = await guest.executeJavaScript(
        'JSON.parse(JSON.stringify({w: window.innerWidth, h: window.innerHeight}))',
      ) as { w: number; h: number };
      if (Math.abs(got.w - expected.w) <= 2 && Math.abs(got.h - expected.h) <= 2) return;
      // The measured mechanism (guest stuck at 200×150 — the replaced-element
      // DEFAULT): Electron's <webview> hosts the guest in a shadow <iframe>
      // that does not get a height, so the guest viewport never follows the
      // element. The repair is to size that iframe explicitly; the pixel
      // nudge afterwards forces the resize message through for embedders
      // where the iframe was fine and the message was merely dropped.
      const shadow = (frame.element as unknown as { shadowRoot: ShadowRoot | null }).shadowRoot;
      const inner = shadow?.querySelector('iframe');
      if (inner) {
        inner.style.width = '100%';
        inner.style.height = '100%';
        inner.style.border = '0';
      }
      frame.element.style.height = `${expected.h + 1}px`;
      frame.element.style.width = `${expected.w + 1}px`;
      // A timeout, DELIBERATELY not requestAnimationFrame: an occluded or
      // minimized window gets no animation frames at all (measured — a mount
      // sat at the +1 nudge size forever while the window was behind another),
      // and this wait only exists to let Electron's resize path run, which it
      // does regardless of whether anything paints.
      await new Promise<void>((r) => setTimeout(r, 16));
      frame.element.style.height = `${expected.h}px`;
      frame.element.style.width = `${expected.w}px`;
      await new Promise<void>((r) => setTimeout(r, 60 * (attempt + 1)));
    }
    throw new Error(
      `This chapter's frame paints a ${got.w}×${got.h} viewport inside a ${expected.w}×`
      + `${expected.h} box, so part of every page would simply not be drawn. The frame was `
      + 'nudged and would not follow its own size.',
    );
  }

  // ── geometry the overlay draws from ───────────────────────────────────────

  /** Page rectangles for a band, in band-local CSS pixels at the current zoom. */
  protected pageChrome(index: number): PageChrome[] {
    const state = this.bandState(index);
    if (state.kind !== 'ready') return [];
    const band = this.bands()[index];
    if (!band) return [];
    const scale = this.scale();
    return state.arrangement.pages.map((p: QuireFramePage) => ({
      globalPage: band.firstPage + p.localPage,
      localPage: p.localPage,
      x: p.x * scale, y: p.y * scale, w: p.w * scale, h: p.h * scale,
    }));
  }

  /**
   * Where the pages of a band WILL be, before its frame has said so.
   *
   * Arithmetic from the page box quire laid the book out into — not a guess at
   * an aspect ratio — so the scroll height a placeholder reserves is the height
   * its pages will occupy, and nothing jumps when the frame arrives.
   */
  protected placeholderSlots(band: DocumentBand): PageChrome[] {
    // A flow band is one column of one chapter: one slot, the whole band.
    if (this.layout() === 'flow') {
      return [{
        globalPage: band.firstPage, localPage: 0,
        x: 0, y: 0, w: band.width, h: band.height,
      }];
    }
    const src = this.source();
    const scale = this.scale();
    const w = src.pageWidth * scale;
    const h = src.pageHeight * scale;
    const gap = PAGE_GAP * scale;
    const out: PageChrome[] = [];
    for (let i = 0; i < band.pageCount; i++) {
      const col = i % band.columns;
      const row = Math.floor(i / band.columns);
      out.push({
        globalPage: band.firstPage + i,
        localPage: i,
        x: col * (w + gap), y: row * (h + gap), w, h,
      });
    }
    return out;
  }

  // ── hit testing ───────────────────────────────────────────────────────────

  /**
   * Which stamped element is under this point, and which block that is.
   *
   * Pure arithmetic against rectangles the frame measured once. The smallest
   * containing rectangle wins, which is how a caption inside a figure resolves
   * to the caption rather than to the figure — the same tiebreak the raster
   * viewer uses on overlapping blocks.
   *
   * Elements whose category is hidden are not hit — mirroring the raster
   * viewer, where a hidden category's rectangles are not rendered and therefore
   * cannot be clicked.
   */
  private hitTest(index: number, x: number, y: number):
  { element: QuireFrameElement; block: LaidOutBlock } | null {
    const state = this.bandState(index);
    if (state.kind !== 'ready') return null;
    const band = this.bands()[index];
    const scale = this.scale();
    const flow = this.layout() === 'flow';
    const byElement = this.blocksByElement();
    const hidden = this.hiddenCategoryIds();
    let best: { element: QuireFrameElement; block: LaidOutBlock } | null = null;
    let bestArea = Infinity;
    for (const el of state.arrangement.elements) {
      const left = el.x * scale;
      const top = el.y * scale;
      if (x < left || y < top || x > left + el.w * scale || y > top + el.h * scale) continue;
      const fragments = byElement.get(el.id);
      if (!fragments) continue;
      // Paginated, the occurrence knows its page, so a split element resolves
      // to the fragment under the cursor. In FLOW there is no page break on
      // screen — the element is one unbroken thing — so the gesture lands on
      // its first fragment; the marks are per element, so what the user sees
      // highlighted is identical whichever fragment carries the gesture.
      const block = flow
        ? fragments[0]
        : this.fragmentOn(el.id, fragments, band.firstPage + el.localPage);
      if (hidden.has(block.category_id)) continue;
      const area = el.w * el.h;
      if (area < bestArea) { bestArea = area; best = { element: el, block }; }
    }
    return best;
  }

  /** Every block whose element rectangle meets this band-local rectangle. */
  private blocksInRect(index: number, rect: { x: number; y: number; w: number; h: number }): string[] {
    const state = this.bandState(index);
    if (state.kind !== 'ready') return [];
    const band = this.bands()[index];
    const scale = this.scale();
    const flow = this.layout() === 'flow';
    const byElement = this.blocksByElement();
    const hidden = this.hiddenCategoryIds();
    const ids = new Set<string>();
    for (const el of state.arrangement.elements) {
      const left = el.x * scale;
      const top = el.y * scale;
      const right = left + el.w * scale;
      const bottom = top + el.h * scale;
      if (right < rect.x || left > rect.x + rect.w || bottom < rect.y || top > rect.y + rect.h) continue;
      const fragments = byElement.get(el.id);
      if (!fragments) continue;
      // A marquee that crosses a page break meets one occurrence per page and
      // so collects each page's own fragment — the same set striking derives.
      // In flow the element occurs once, and the first fragment stands for it
      // (see hitTest for why that is a rule, not a guess).
      const block = flow
        ? fragments[0]
        : this.fragmentOn(el.id, fragments, band.firstPage + el.localPage);
      if (hidden.has(block.category_id)) continue;
      ids.add(block.id);
    }
    return [...ids];
  }

  private localPoint(event: MouseEvent): { x: number; y: number } {
    const overlay = event.currentTarget as HTMLElement;
    const rect = overlay.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private pageAt(index: number, y: number): number {
    const chrome = this.pageChrome(index);
    const band = this.bands()[index];
    if (chrome.length === 0 || !band) return band ? band.firstPage : 0;
    let best = chrome[0];
    for (const page of chrome) {
      if (y >= page.y && y <= page.y + page.h) return page.globalPage;
      if (Math.abs(page.y - y) < Math.abs(best.y - y)) best = page;
    }
    return best.globalPage;
  }

  // ── gestures ──────────────────────────────────────────────────────────────

  protected onOverlayMouseDown(event: MouseEvent, band: DocumentBand): void {
    if (event.button !== 0) return;
    this.closeContextMenu();
    const point = this.localPoint(event);
    const hit = this.hitTest(band.index, point.x, point.y);
    if (hit) {
      const now = performance.now();
      const isDouble = this.lastClick.id === hit.block.id && now - this.lastClick.at < 250;
      this.lastClick = { id: hit.block.id, at: now };
      if (isDouble) {
        this.blockDoubleClick.emit({
          block: hit.block, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
        });
        return;
      }
      this.blockClick.emit({
        block: hit.block,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      });
      return;
    }
    // Empty space starts a marquee, exactly as it does over a raster page.
    this.marqueeBand.set(band.index);
    this.marqueeOrigin = { x: point.x, y: point.y, additive: event.shiftKey || event.metaKey };
    this.marqueeRect.set({ x: point.x, y: point.y, w: 0, h: 0 });
  }

  protected onOverlayMouseMove(event: MouseEvent, band: DocumentBand): void {
    const point = this.localPoint(event);
    const origin = this.marqueeOrigin;
    if (origin && this.marqueeBand() === band.index) {
      this.marqueeRect.set({
        x: Math.min(origin.x, point.x),
        y: Math.min(origin.y, point.y),
        w: Math.abs(point.x - origin.x),
        h: Math.abs(point.y - origin.y),
      });
      return;
    }
    const hit = this.hitTest(band.index, point.x, point.y);
    const current = this.hoveredElement();
    if (hit === null) {
      if (current !== null) { this.hoveredElement.set(null); this.blockHover.emit(null); }
      return;
    }
    if (current?.id === hit.element.id && current.band === band.index) return;
    this.hoveredElement.set({
      band: band.index,
      id: hit.element.id,
      rect: hit.element,
      color: this.colorOf(hit.block),
    });
    this.blockHover.emit(hit.block);
  }

  protected onOverlayMouseUp(_event: MouseEvent, band: DocumentBand): void {
    const origin = this.marqueeOrigin;
    const rect = this.marqueeRect();
    this.marqueeOrigin = null;
    this.marqueeBand.set(null);
    this.marqueeRect.set(null);
    if (!origin || !rect || (rect.w < 4 && rect.h < 4)) return;
    const blockIds = this.blocksInRect(band.index, rect);
    if (blockIds.length > 0) this.marqueeSelect.emit({ blockIds, additive: origin.additive });
  }

  protected onOverlayMouseLeave(): void {
    if (this.hoveredElement() !== null) {
      this.hoveredElement.set(null);
      this.blockHover.emit(null);
    }
  }

  protected onOverlayContextMenu(event: MouseEvent, band: DocumentBand): void {
    event.preventDefault();
    const point = this.localPoint(event);
    const hit = this.hitTest(band.index, point.x, point.y);
    this.contextMenu.set({
      x: event.clientX,
      y: event.clientY,
      // The block's own page: identical to firstPage + localPage when
      // paginated, and the only page a hit HAS in flow, where the overlay
      // draws no page boxes to ask.
      page: hit ? hit.block.page : this.pageAt(band.index, point.y),
      block: hit ? hit.block : null,
    });
  }

  protected closeContextMenu(): void { this.contextMenu.set(null); }

  protected fire(which: 'selectLikeThis' | 'deleteLikeThis', block: LaidOutBlock): void {
    this[which].emit(block);
    this.closeContextMenu();
  }

  protected onDeleteBlock(block: LaidOutBlock): void {
    this.deleteBlock.emit(block.id);
    this.closeContextMenu();
  }

  protected onSelectAllOnPage(page: number): void {
    this.selectAllOnPage.emit(page);
    this.closeContextMenu();
  }

  protected onDeselectAllOnPage(page: number): void {
    this.deselectAllOnPage.emit(page);
    this.closeContextMenu();
  }

  protected onPageDeleteToggle(page: number): void {
    this.pageDeleteToggle.emit(page);
    this.closeContextMenu();
  }

  protected onPageDeleteClick(event: MouseEvent, page: number): void {
    event.stopPropagation();
    this.pageDeleteToggle.emit(page);
  }

  protected onPageLabelClick(event: MouseEvent, page: number): void {
    event.stopPropagation();
    this.pageSelect.emit({
      pageNum: page,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    });
  }

  /**
   * Mount what is on screen, drop what is stalled off it. The authority on
   * both, run on every scroll.
   *
   * An `IntersectionObserver` reports EDGES, and an edge can be missed — a band
   * that was mounted, evicted while off screen, and scrolled back to has not
   * changed its intersection state since the observer last spoke about it, so
   * nothing fires and the band sits there empty. Measured, on Killing America,
   * scrolling the whole book and coming back. So the observer is kept for the
   * first paint (there is no scroll event then) and this is what actually
   * decides, from the rectangles, every time the user moves.
   */
  private reconcileVisibility(): void {
    const viewport = this.viewport()?.nativeElement;
    if (!viewport) return;
    const root = this.hostRef.nativeElement as HTMLElement;
    const bounds = viewport.getBoundingClientRect();
    // An unmeasurable viewport decides nothing. A zero-height box means the
    // layout has (transiently or by a host CSS bug) collapsed — every band
    // would measure off-screen and mounting frames would be dropped for a
    // reason that is not theirs. Keep the current state and decide on the next
    // call, when there is a box to measure against.
    if (bounds.height <= 0) return;
    for (const band of this.bands()) {
      const el = root.querySelector<HTMLElement>(`[data-band="${band.index}"]`);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const onScreen = rect.bottom > bounds.top && rect.top < bounds.bottom;
      if (onScreen) {
        this.lastSeen.set(band.index, performance.now());
        void this.mountBand(band.index);
        continue;
      }
      // A frame that is still laying itself out and has gone off screen cannot
      // finish — Paged.js ticks on animation frames and an off-screen frame gets
      // none. Keeping it would hold a renderer process open to do nothing, so it
      // is dropped and will start again, in a couple of hundred milliseconds,
      // when the user scrolls back to it.
      if (this.bandState(band.index).kind === 'mounting') this.unmountBand(band.index);
    }
  }

  protected onScroll(): void { this.reconcileVisibility(); }

  /** Ctrl/Cmd + wheel zooms, at the same sensitivity as the raster viewer. */
  protected onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.zoomChange.emit(-event.deltaY * 0.15);
  }
}

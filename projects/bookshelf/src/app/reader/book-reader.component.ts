import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import ePub from 'epubjs';
import type { Book, Rendition } from 'epubjs';
import { ApiService } from '../services/api.service';
import { ReaderStateService } from '../services/reader-state.service';
import { ReaderService } from '../services/reader.service';
import { LocalLibraryService, isLocalPath, localIdOf } from '../services/local-library.service';
import { IconComponent } from '../shared/icon.component';
import { VisibleDirective } from '../shared/visible.directive';
import { decodePathId } from '../shared/path-id';
import { ReadInfo } from '../models/types';

interface ChapterItem {
  label: string;
  depth: number;
  epubHref?: string;
  pdfPage?: number;
}

interface ReadBookmark {
  id: string;
  label: string;
  cfi?: string;   // epub
  page?: number;  // pdf (0-indexed)
  at: number;
}

/**
 * In-app book reader — the reading peer of the audio player. Opens a book by
 * `ref` (`e:<relativePath>` for an Ebooks-tab file, or `p:<projectId>` for a
 * project's archived source — the server resolves both):
 *   - EPUB → epub.js, reflowable + paginated (page-turn), font-size + dark theme.
 *   - PDF  → server-rasterized page images (mupdf), lazily loaded in a scroll view.
 *
 * Matches the player's overlay behavior: floating pop-up on desktop, full-screen
 * on mobile; the down-chevron (and scrim) MINIMIZE to a mini-bar (session kept,
 * position restored on reopen); the ✕ fully closes. Bookmarks and a chapter
 * seeker (epub TOC / pdf outline) mirror the player's sheets.
 */
@Component({
  selector: 'app-book-reader',
  standalone: true,
  imports: [IconComponent, VisibleDirective],
  template: `
    <div class="scrim" (click)="minimize()"></div>
    <div class="reader">
      <header class="topbar">
        <button class="icon-btn" (click)="minimize()" title="Minimize"><app-icon name="chevron-down" [size]="24" /></button>
        <div class="topbar-title">
          <div class="t-title">{{ title() }}</div>
          @if (author()) { <div class="t-author">{{ author() }}</div> }
        </div>
        <a class="icon-btn" [href]="downloadHref()" [attr.download]="info()?.filename || ''" title="Download"><app-icon name="download" [size]="20" /></a>
        <button class="icon-btn close" (click)="closeFully()" title="Close">✕</button>
      </header>

      @if (error()) {
        <div class="state"><div class="icon">⚠️</div><p>{{ error() }}</p></div>
      } @else if (loading()) {
        <div class="state"><div class="spinner"></div><p>Opening book…</p></div>
      } @else if (info()?.format === 'epub') {
        <div class="viewport" (touchstart)="onTouchStart($event)" (touchend)="onTouchEnd($event)">
          <div class="viewer" #viewer></div>
          <button class="nav-side left" (click)="pagePrev()" aria-label="Previous page"><app-icon name="chevron-left" [size]="28" /></button>
          <button class="nav-side right" (click)="pageNext()" aria-label="Next page"><app-icon name="chevron-right" [size]="28" /></button>
        </div>
      } @else if (info()?.format === 'pdf') {
        <div class="viewport" (touchstart)="onTouchStart($event)" (touchend)="onTouchEnd($event)">
          <div class="pdf-scroll" #pdfScroll (scroll)="onPdfScroll()">
            @for (pg of pdfPages(); track pg) {
              <div class="pdf-page" [style.aspect-ratio]="pdfAspect()" [style.width]="pdfWidth()" [attr.data-page]="pg">
                <img appVisible (visible)="loadPdfPage(pg)" [attr.src]="pdfSrc().get(pg) || null"
                     [class.loaded]="pdfSrc().has(pg)" alt="Page {{ pg + 1 }}" />
              </div>
            }
          </div>
          <button class="nav-side left" (click)="pagePrev()" aria-label="Previous page"><app-icon name="chevron-left" [size]="28" /></button>
          <button class="nav-side right" (click)="pageNext()" aria-label="Next page"><app-icon name="chevron-right" [size]="28" /></button>
        </div>
      }

      @if (!loading() && !error()) {
        <div class="controls">
          <div class="pager"><span class="pg-label">{{ progressLabel() }}</span></div>

          <div class="bottom-row">
            <div class="chip-group">
              @if (chapters().length > 0) {
                <button class="chip" [class.on]="chaptersOpen()" (click)="chaptersOpen.set(!chaptersOpen())">
                  <app-icon name="list" [size]="15" /> Chapters
                </button>
              }
              <button class="chip" [class.on]="bookmarksOpen()" (click)="bookmarksOpen.set(!bookmarksOpen())">
                <app-icon name="bookmark" [size]="15" /> Bookmarks
              </button>
            </div>
            <div class="settings">
              @if (info()?.format === 'epub') {
                <button class="set-btn" (click)="changeFont(-10)" title="Smaller text"><app-icon name="minus" [size]="18" /></button>
                <span class="set-val">A</span>
                <button class="set-btn" (click)="changeFont(10)" title="Larger text"><app-icon name="plus" [size]="18" /></button>
              } @else {
                <button class="set-btn" (click)="changeZoom(-0.15)" title="Zoom out"><app-icon name="minus" [size]="18" /></button>
                <span class="set-val">{{ zoomLabel() }}</span>
                <button class="set-btn" (click)="changeZoom(0.15)" title="Zoom in"><app-icon name="plus" [size]="18" /></button>
              }
            </div>
          </div>
        </div>
      }

      @if (chaptersOpen()) {
        <div class="sheet-backdrop" (click)="chaptersOpen.set(false)"></div>
        <div class="sheet">
          <div class="sheet-head"><span>Chapters</span><button class="icon-btn sm" (click)="chaptersOpen.set(false)">✕</button></div>
          <div class="sheet-body">
            @for (item of chapters(); track $index) {
              <button class="row-item" [style.padding-left.px]="10 + item.depth * 16" (click)="gotoChapter(item)">
                <span class="row-title">{{ item.label }}</span>
              </button>
            } @empty {
              <p class="sheet-empty">No chapters.</p>
            }
          </div>
        </div>
      }

      @if (bookmarksOpen()) {
        <div class="sheet-backdrop" (click)="bookmarksOpen.set(false)"></div>
        <div class="sheet">
          <div class="sheet-head"><span>Bookmarks</span><button class="icon-btn sm" (click)="bookmarksOpen.set(false)">✕</button></div>
          <div class="sheet-body">
            @for (bm of bookmarks(); track bm.id) {
              <div class="row-item bm">
                <button class="bm-jump" (click)="gotoBookmark(bm)">
                  <span class="row-title">{{ bm.label }}</span>
                </button>
                <button class="bm-del" (click)="removeBookmark(bm)" title="Remove">✕</button>
              </div>
            } @empty {
              <p class="sheet-empty">No bookmarks yet.</p>
            }
          </div>
          <button class="sheet-action" (click)="addBookmark()">+ Bookmark this spot</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center; }
    .scrim { position: absolute; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }

    .reader { position: relative; z-index: 1; display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; background: var(--bg-base); touch-action: manipulation; }
    /* Pop-up only on a tall viewport; a phone in landscape stays full-screen. */
    @media (min-width: 768px) and (min-height: 601px) {
      .reader {
        width: min(820px, 94vw);
        height: min(1200px, 95vh);
        border-radius: 20px;
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        box-shadow: 0 24px 80px rgba(0,0,0,0.55), 0 0 60px -14px color-mix(in srgb, var(--accent) 55%, transparent);
      }
    }

    .topbar { display: flex; align-items: center; gap: 6px; flex-shrink: 0;
      padding: calc(8px + env(safe-area-inset-top)) 8px 8px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle); }
    .topbar-title { flex: 1; min-width: 0; text-align: center; }
    .t-title { font-size: 14px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t-author { font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-btn { width: 38px; height: 38px; flex-shrink: 0; border: none; background: var(--bg-elevated); border-radius: 8px; color: var(--text-primary);
      font-size: 18px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; text-decoration: none; }
    .icon-btn.sm { width: 30px; height: 30px; font-size: 14px; background: transparent; color: var(--text-tertiary); }
    .icon-btn.close { font-size: 16px; color: var(--text-secondary); }

    .state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: var(--text-secondary); text-align: center; padding: 24px; }
    .state .icon { font-size: 44px; }
    .spinner { width: 34px; height: 34px; border: 3px solid var(--bg-elevated); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Shared viewport for epub + pdf. touch-action: pan-y lets vertical scroll
       (pdf) through while we capture horizontal swipes for page turns, and it
       suppresses double-tap-to-zoom on mobile. */
    .viewport { position: relative; flex: 1; min-height: 0; touch-action: pan-y; }
    .viewer { position: absolute; inset: 0; }

    /* Full-height narrow page-turn buttons flanking the content (Kindle-style).
       The arrow sits in a translucent dark chip so it reads clearly over both
       white PDF pages and dark epub themes. */
    .nav-side { position: absolute; top: 0; bottom: 0; width: 48px; border: none; z-index: 3; cursor: pointer;
      display: flex; align-items: center; justify-content: center; padding: 0;
      background: transparent; -webkit-tap-highlight-color: transparent; transition: background 0.15s; }
    .nav-side.left { left: 0; }
    .nav-side.right { right: 0; }
    .nav-side app-icon { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;
      border-radius: 50%; background: rgba(0,0,0,0.34); color: var(--text-on-accent); box-shadow: 0 1px 4px rgba(0,0,0,0.4); }
    .nav-side:hover { background: color-mix(in srgb, var(--bg-elevated) 55%, transparent); }
    .nav-side:active app-icon { background: var(--accent); }

    /* PDF — block flow (NOT flex): a flex item's aspect-ratio won't resolve its
       height, collapsing the page to 0px. A block box sizes height from width +
       aspect-ratio correctly. */
    .pdf-scroll { position: absolute; inset: 0; overflow: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 12px; background: var(--bg-sunken, var(--bg-base)); }
    .pdf-page { position: relative; display: block; width: 100%; margin: 0 auto 12px; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,0.35); border-radius: 2px; overflow: hidden; }
    .pdf-page:last-child { margin-bottom: 0; }
    .pdf-page img { display: block; width: 100%; height: 100%; opacity: 0; transition: opacity 0.2s; }
    .pdf-page img.loaded { opacity: 1; }

    /* Controls */
    .controls { flex-shrink: 0; padding: 8px 16px calc(8px + env(safe-area-inset-bottom)); background: var(--bg-surface); border-top: 1px solid var(--border-subtle); }
    .pager { display: flex; align-items: center; justify-content: center; padding: 2px 0 8px; }
    .pg-label { font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; text-align: center; }
    .bottom-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .chip-group { display: flex; align-items: center; gap: 8px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--bg-elevated); color: var(--text-secondary); font-size: 13px; cursor: pointer; }
    .chip.on { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
    .settings { display: flex; align-items: center; gap: 6px; }
    .set-btn { width: 34px; height: 34px; border: none; border-radius: 8px; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .set-val { font-size: 12px; color: var(--text-secondary); min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; }

    /* Sheets */
    .sheet-backdrop { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,0.5); }
    .sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 11; max-height: 72%; display: flex; flex-direction: column;
      background: var(--bg-elevated); border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom); animation: sheetUp 0.2s ease-out; }
    @keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
    .sheet-body { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 6px; }
    .sheet-empty { padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 13px; }
    .sheet-action { margin: 4px 10px 10px; padding: 12px; border: 1px solid var(--accent); border-radius: 10px; background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent); font-size: 14px; font-weight: 600; cursor: pointer; }
    .row-item { display: flex; align-items: center; width: 100%; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .row-item.bm { padding: 0; }
    .bm-jump { flex: 1; min-width: 0; display: flex; align-items: center; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .bm-del { flex-shrink: 0; width: 36px; height: 36px; margin-right: 6px; border: none; background: transparent; color: var(--text-tertiary); font-size: 13px; cursor: pointer; border-radius: 8px; }
    .row-title { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `],
})
export class BookReaderComponent implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderStateService);
  private readonly identity = inject(ReaderService);
  private readonly local = inject(LocalLibraryService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly viewerRef = viewChild<ElementRef<HTMLDivElement>>('viewer');
  private readonly pdfScrollRef = viewChild<ElementRef<HTMLDivElement>>('pdfScroll');

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly info = signal<ReadInfo | null>(null);
  readonly title = signal('Reader');
  readonly author = signal('');
  readonly progressLabel = signal('');

  readonly chaptersOpen = signal(false);
  readonly bookmarksOpen = signal(false);
  readonly chapters = signal<ChapterItem[]>([]);
  readonly bookmarks = signal<ReadBookmark[]>([]);

  // EPUB
  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private fontPct = 100;
  private epubInitStarted = false;
  private currentCfi = '';

  // PDF
  readonly pdfPages = signal<number[]>([]);
  readonly pdfSrc = signal<Map<number, string>>(new Map());
  readonly pdfAspect = signal('0.77');
  readonly pdfZoom = signal(1);
  readonly zoomLabel = computed(() => `${Math.round(this.pdfZoom() * 100)}%`);
  private currentPdfPage = 0;
  private pdfScrollRaf = 0;
  private pdfRestored = false;

  /** `p:<projectId>` or `e:<relativePath>` — see ReaderStateService/server. */
  private ref = '';

  // Durable position: localStorage (instant/offline) + server (cross-device,
  // survives Safari evicting localStorage). Newest write wins on open.
  private serverStart: { kind: string; value: unknown; at: number } | null = null;
  private lastServerPosAt = 0;

  // Keep the screen awake while reading (released on close/minimize; re-acquired
  // when the tab returns to the foreground, since the OS auto-releases on hide).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wakeLock: any = null;

  constructor() {
    effect(() => {
      const el = this.viewerRef()?.nativeElement;
      if (el && this.info()?.format === 'epub' && !this.epubInitStarted) {
        this.epubInitStarted = true;
        void this.initEpub(el);
      }
    });
    effect(() => {
      const scroll = this.pdfScrollRef()?.nativeElement;
      if (scroll && this.pdfPages().length > 0 && !this.pdfRestored) {
        this.pdfRestored = true;
        queueMicrotask(() => this.restorePdfPage());
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.ref = decodePathId(this.route.snapshot.paramMap.get('id') || '');
    const stateTitle = history.state?.title as string | undefined;
    const stateAuthor = history.state?.author as string | undefined;
    const cover = (history.state?.cover as string | undefined) ?? null;
    if (stateTitle) this.title.set(stateTitle);
    if (stateAuthor) this.author.set(stateAuthor);

    this.fontPct = Number(localStorage.getItem('bookshelf-read-fontsize')) || 100;
    this.loadBookmarks();

    try {
      const info = await this.api.getReadInfo(this.ref);
      if (!info) {
        this.error.set('This book can’t be opened for reading.');
        this.loading.set(false);
        return;
      }
      this.info.set(info);
      if (!stateTitle && info.filename) this.title.set(info.filename.replace(/\.[^.]+$/, ''));
      // Only track a session (mini-bar) once we know the book is genuinely readable.
      this.reader.open({ ref: this.ref, title: this.title(), author: this.author(), cover });
      // Fetch the durable position BEFORE rendering so the restore uses it.
      this.serverStart = await this.loadServerPosition();
      if (info.format === 'pdf') this.setupPdf(info);
      this.loading.set(false);
      void this.acquireWakeLock();
      document.addEventListener('visibilitychange', this.onVisibility);
      window.addEventListener('beforeunload', this.onBeforeUnload);
    } catch (err) {
      console.error('[Reader] failed to open book', err);
      this.error.set('Could not open this book.');
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    this.flushReaderPos(); // force-save the final position to the server
    try { this.rendition?.destroy(); } catch { /* ignore */ }
    try { this.book?.destroy(); } catch { /* ignore */ }
    document.removeEventListener('keyup', this.onKey);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.releaseWakeLock();
    if (this.pdfScrollRaf) cancelAnimationFrame(this.pdfScrollRaf);
  }

  private readonly onBeforeUnload = (): void => this.flushReaderPos();

  // ── Window controls (parity with the player) ─────────────────────────────────
  minimize(): void {
    // Keep the session so the mini-bar shows; position is persisted per book.
    this.router.navigate(['/']);
  }

  closeFully(): void {
    this.reader.end();
    this.router.navigate(['/']);
  }

  downloadHref(): string { return this.api.readFileUrl(this.ref); }

  // ── Durable position (server + localStorage; newest write wins) ──────────────
  private async loadServerPosition(): Promise<{ kind: string; value: unknown; at: number } | null> {
    const token = this.identity.token();
    if (!token) return null;
    try {
      const p = await this.api.getPosition(token, { ref: this.ref });
      if (p && p.kind && p.value != null) return { kind: p.kind, value: p.value, at: p.at ? Date.parse(p.at) : 0 };
    } catch { /* offline */ }
    return null;
  }

  private readerPosKey(kind: 'epub' | 'pdf'): string {
    return kind === 'epub' ? this.epubKey() : this.pdfKey();
  }

  private loadLocalReaderPos(kind: 'epub' | 'pdf'): { v: unknown; at: number } | null {
    const raw = localStorage.getItem(this.readerPosKey(kind));
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && 'v' in o) return { v: o.v, at: Number(o.at) || 0 };
    } catch { /* legacy plain value below */ }
    return { v: kind === 'pdf' ? Number(raw) : raw, at: 0 };
  }

  /** Newer of local vs. server (string CFI for epub, page number for pdf). */
  private pickReaderStart(kind: 'epub' | 'pdf'): unknown {
    const local = this.loadLocalReaderPos(kind);
    const server = this.serverStart && this.serverStart.kind === kind ? this.serverStart : null;
    if (local && server) return server.at >= local.at ? server.value : local.v;
    return server?.value ?? local?.v ?? null;
  }

  private saveReaderPos(kind: 'epub' | 'pdf', value: unknown, force = false): void {
    if (value === null || value === undefined || value === '') return;
    localStorage.setItem(this.readerPosKey(kind), JSON.stringify({ v: value, at: Date.now() }));
    const token = this.identity.token();
    if (!token) return;
    const now = Date.now();
    if (force || now - this.lastServerPosAt > 10_000) {
      this.lastServerPosAt = now;
      this.api.postPosition(token, { ref: this.ref, kind, value });
    }
  }

  private flushReaderPos(): void {
    const fmt = this.info()?.format;
    if (fmt === 'epub' && this.currentCfi) this.saveReaderPos('epub', this.currentCfi, true);
    else if (fmt === 'pdf') this.saveReaderPos('pdf', this.currentPdfPage, true);
  }

  // ── Keep screen awake while reading ──────────────────────────────────────────
  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'visible' && !this.wakeLock) void this.acquireWakeLock();
  };

  private async acquireWakeLock(): Promise<void> {
    const wl = (navigator as unknown as { wakeLock?: { request(type: string): Promise<unknown> } }).wakeLock;
    if (!wl) return;
    try {
      this.wakeLock = await wl.request('screen');
      this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
    } catch { /* denied, or tab not visible */ }
  }

  private releaseWakeLock(): void {
    try { this.wakeLock?.release(); } catch { /* already released */ }
    this.wakeLock = null;
  }

  // ── EPUB ───────────────────────────────────────────────────────────────────
  private async initEpub(el: HTMLElement): Promise<void> {
    // Local books have no server URL — open epub.js from the on-device bytes.
    let book;
    if (isLocalPath(this.ref)) {
      const bytes = await this.local.bytes(localIdOf(this.ref), 'main');
      if (!bytes) { this.error.set('This book’s file is missing from this device.'); this.loading.set(false); return; }
      book = ePub(bytes);
    } else {
      book = ePub(this.api.readFileUrl(this.ref));
    }
    this.book = book;
    const rendition = book.renderTo(el, { width: '100%', height: '100%', flow: 'paginated', spread: 'none' });
    this.rendition = rendition;

    this.registerEpubSwipe(rendition);
    this.applyEpubTheme();
    rendition.themes.fontSize(`${this.fontPct}%`);

    const saved = this.pickReaderStart('epub') as string | null;
    await rendition.display(saved || undefined);

    book.loaded.navigation.then((navDoc) => {
      const flat: ChapterItem[] = [];
      const walk = (items: { label?: string; href: string; subitems?: unknown[] }[], depth: number) => {
        for (const it of items) {
          flat.push({ label: (it.label || '').trim() || 'Untitled', depth, epubHref: it.href });
          if (it.subitems && it.subitems.length) walk(it.subitems as typeof items, depth + 1);
        }
      };
      walk(navDoc.toc as never, 0);
      this.chapters.set(flat);
    });

    book.ready
      .then(() => book.locations.generate(1600))
      .then(() => this.updateProgress())
      .catch(() => { /* progress is best-effort */ });

    rendition.on('relocated', (loc: { start?: { cfi?: string } }) => {
      const cfi = loc?.start?.cfi;
      if (cfi) { this.currentCfi = cfi; this.saveReaderPos('epub', cfi); }
      this.updateProgress();
    });

    rendition.on('keyup', (e: KeyboardEvent) => this.onKey(e));
    document.addEventListener('keyup', this.onKey);
  }

  /**
   * epub content renders in a sandboxed iframe, so its touch events never reach
   * the parent. Inject swipe detection (page turns) + touch-action into each
   * rendered document so left/right swipes flip pages and double-tap can't zoom.
   */
  private registerEpubSwipe(rendition: Rendition): void {
    const hooks = (rendition as unknown as { hooks?: { content?: { register(fn: (c: unknown) => void): void } } }).hooks;
    hooks?.content?.register((contents: unknown) => {
      const doc = (contents as { document?: Document }).document;
      if (!doc) return;
      doc.documentElement?.style.setProperty('touch-action', 'manipulation');
      let sx = 0, sy = 0;
      doc.addEventListener('touchstart', (ev) => {
        const t = (ev as TouchEvent).changedTouches[0];
        sx = t.clientX; sy = t.clientY;
      }, { passive: true });
      doc.addEventListener('touchend', (ev) => {
        const t = (ev as TouchEvent).changedTouches[0];
        this.handleSwipe(t.clientX - sx, t.clientY - sy);
      }, { passive: true });
    });
  }

  private applyEpubTheme(): void {
    if (!this.rendition) return;
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--bg-base').trim();
    const fg = css.getPropertyValue('--text-primary').trim();
    const link = css.getPropertyValue('--accent').trim();
    this.rendition.themes.register('bf', {
      body: { background: bg, color: fg, 'line-height': '1.6', padding: '0 4px' },
      p: { color: fg, 'line-height': '1.6' },
      a: { color: link },
      'h1, h2, h3, h4, h5, h6': { color: fg },
    });
    this.rendition.themes.select('bf');
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') this.prev();
    else if (e.key === 'ArrowRight') this.next();
  };

  private updateProgress(): void {
    const book = this.book;
    if (!book || !this.currentCfi || !book.locations || book.locations.length() === 0) return;
    const pct = book.locations.percentageFromCfi(this.currentCfi);
    if (Number.isFinite(pct)) {
      const label = `${Math.round(pct * 100)}%`;
      this.progressLabel.set(label);
      this.reader.setProgress(label);
    }
  }

  next(): void { void this.rendition?.next(); }
  prev(): void { void this.rendition?.prev(); }

  // ── Unified page navigation (side buttons + swipe) ───────────────────────────
  pageNext(): void {
    if (this.info()?.format === 'pdf') this.scrollToPdfPage(Math.min(this.pdfPages().length - 1, this.livePdfPage() + 1));
    else this.next();
  }

  pagePrev(): void {
    if (this.info()?.format === 'pdf') this.scrollToPdfPage(Math.max(0, this.livePdfPage() - 1));
    else this.prev();
  }

  /** Current page computed live from scroll position (not the async-updated field). */
  private livePdfPage(): number {
    const scroll = this.pdfScrollRef()?.nativeElement;
    return scroll ? this.computeCurrentPdfPage(scroll) : this.currentPdfPage;
  }

  private touchX = 0;
  private touchY = 0;

  onTouchStart(e: TouchEvent): void {
    const t = e.changedTouches[0];
    this.touchX = t.clientX;
    this.touchY = t.clientY;
  }

  onTouchEnd(e: TouchEvent): void {
    const t = e.changedTouches[0];
    this.handleSwipe(t.clientX - this.touchX, t.clientY - this.touchY);
  }

  /** Left swipe → next page, right swipe → previous (ignores vertical drags). */
  private handleSwipe(dx: number, dy: number): void {
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) this.pageNext();
    else this.pagePrev();
  }

  changeFont(delta: number): void {
    this.fontPct = Math.min(220, Math.max(70, this.fontPct + delta));
    localStorage.setItem('bookshelf-read-fontsize', String(this.fontPct));
    this.rendition?.themes.fontSize(`${this.fontPct}%`);
  }

  private epubKey(): string { return `bookshelf-read-epub:${this.ref}`; }

  // ── PDF ────────────────────────────────────────────────────────────────────
  private setupPdf(info: ReadInfo): void {
    const pages = info.pages ?? 0;
    if (info.aspect && info.aspect > 0) this.pdfAspect.set(info.aspect.toFixed(4));
    this.pdfZoom.set(Number(localStorage.getItem('bookshelf-read-zoom')) || 1);
    this.pdfPages.set(Array.from({ length: pages }, (_, i) => i));
    this.chapters.set((info.outline ?? []).map((o) => ({ label: o.title, depth: o.depth, pdfPage: o.page })));
    this.setPdfProgress(0);
  }

  pdfWidth(): string { return `${Math.round(this.pdfZoom() * 100)}%`; }

  loadPdfPage(page: number): void {
    if (this.pdfSrc().has(page)) return;
    const next = new Map(this.pdfSrc());
    next.set(page, this.api.readPageUrl(this.ref, page, 2));
    this.pdfSrc.set(next);
  }

  changeZoom(delta: number): void {
    const z = Math.min(3, Math.max(0.6, Math.round((this.pdfZoom() + delta) * 100) / 100));
    this.pdfZoom.set(z);
    localStorage.setItem('bookshelf-read-zoom', String(z));
  }

  onPdfScroll(): void {
    if (this.pdfScrollRaf) return;
    this.pdfScrollRaf = requestAnimationFrame(() => {
      this.pdfScrollRaf = 0;
      const scroll = this.pdfScrollRef()?.nativeElement;
      if (!scroll) return;
      const current = this.computeCurrentPdfPage(scroll);
      this.setPdfProgress(current);
      this.saveReaderPos('pdf', current);
    });
  }

  /** The page whose top is nearest the scroll viewport's top. */
  private computeCurrentPdfPage(scroll: HTMLElement): number {
    const wrappers = scroll.querySelectorAll<HTMLElement>('.pdf-page');
    const top = scroll.scrollTop;
    let current = 0;
    let best = Infinity;
    wrappers.forEach((w) => {
      const d = Math.abs(w.offsetTop - scroll.offsetTop - top);
      if (d < best) { best = d; current = Number(w.dataset['page']); }
    });
    return current;
  }

  private setPdfProgress(current: number): void {
    this.currentPdfPage = current;
    const total = this.pdfPages().length;
    const label = total ? `${current + 1} / ${total}` : '';
    this.progressLabel.set(label);
    this.reader.setProgress(label);
  }

  private restorePdfPage(): void {
    const scroll = this.pdfScrollRef()?.nativeElement;
    if (!scroll) return;
    const saved = Number(this.pickReaderStart('pdf'));
    if (!saved || saved <= 0) return;
    this.scrollToPdfPage(saved);
  }

  private scrollToPdfPage(page: number): void {
    const scroll = this.pdfScrollRef()?.nativeElement;
    if (!scroll) return;
    const target = scroll.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`);
    if (target) scroll.scrollTop = target.offsetTop - scroll.offsetTop;
  }

  private pdfKey(): string { return `bookshelf-read-pdf:${this.ref}`; }

  // ── Chapters ─────────────────────────────────────────────────────────────────
  gotoChapter(item: ChapterItem): void {
    this.chaptersOpen.set(false);
    if (item.epubHref !== undefined) void this.rendition?.display(item.epubHref);
    else if (item.pdfPage !== undefined) this.scrollToPdfPage(item.pdfPage);
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────────
  private bmKey(): string { return `bookshelf-read-bm:${this.ref}`; }

  private loadBookmarks(): void {
    try {
      const raw = localStorage.getItem(this.bmKey());
      this.bookmarks.set(raw ? (JSON.parse(raw) as ReadBookmark[]) : []);
    } catch {
      this.bookmarks.set([]);
    }
    void this.mergeServerBookmarks();
  }

  /** Union local with the server's set (never drops a local bookmark) and push
   *  local-only ones up. On an unreachable/old server we keep the local cache. */
  private async mergeServerBookmarks(): Promise<void> {
    const token = this.identity.token();
    if (!token) return;
    let server: ReadBookmark[];
    try { server = await this.api.getBookmarks<ReadBookmark>(token, { ref: this.ref }); }
    catch { return; } // unreachable/old server → keep local cache
    const byId = new Map<string, ReadBookmark>();
    for (const b of server) byId.set(b.id, b);
    const localOnly = this.bookmarks().filter((b) => !byId.has(b.id));
    for (const b of localOnly) byId.set(b.id, b);
    const merged = [...byId.values()].sort((a, b) => b.at - a.at);
    this.bookmarks.set(merged);
    localStorage.setItem(this.bmKey(), JSON.stringify(merged));
    for (const b of localOnly) {
      this.api.postBookmark(token, { ref: this.ref, op: 'add', bookmark: b as unknown as { id: string } & Record<string, unknown> });
    }
  }

  private saveBookmarks(list: ReadBookmark[]): void {
    this.bookmarks.set(list);
    localStorage.setItem(this.bmKey(), JSON.stringify(list));
  }

  addBookmark(): void {
    const id = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    let bm: ReadBookmark | null = null;
    if (this.info()?.format === 'epub' && this.currentCfi) {
      bm = { id, label: this.progressLabel() || 'Bookmark', cfi: this.currentCfi, at: Date.now() };
    } else if (this.info()?.format === 'pdf') {
      bm = { id, label: `Page ${this.currentPdfPage + 1}`, page: this.currentPdfPage, at: Date.now() };
    }
    if (!bm) return;
    this.saveBookmarks([bm, ...this.bookmarks()]);
    const token = this.identity.token();
    if (token) this.api.postBookmark(token, { ref: this.ref, op: 'add', bookmark: bm as unknown as { id: string } & Record<string, unknown> });
  }

  removeBookmark(bm: ReadBookmark): void {
    this.saveBookmarks(this.bookmarks().filter((b) => b.id !== bm.id));
    const token = this.identity.token();
    if (token) this.api.postBookmark(token, { ref: this.ref, op: 'del', bookmark: { id: bm.id } });
  }

  gotoBookmark(bm: ReadBookmark): void {
    this.bookmarksOpen.set(false);
    if (bm.cfi) void this.rendition?.display(bm.cfi);
    else if (bm.page !== undefined) this.scrollToPdfPage(bm.page);
  }
}

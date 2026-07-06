/**
 * PdfEditorComponent — the mupdf-style page-crop editor. A PDF ingested via the ＋
 * sheet arrives as pages carrying per-block boxes; this shows ONE rasterized page
 * at a time with its text blocks overlaid and lets the reader CROP the junk away
 * (running heads, folios, footnotes) so it never reaches the audiobook.
 *
 * Because the audio path is text→epub, "cropping" is a spatial BLOCK FILTER, not an
 * image crop. The reader drags a rectangle over the page; every block whose CENTRE
 * falls outside the rect is greyed out and dropped. "Apply to all pages" copies that
 * rect onto every page, so one gesture kills the page numbers/headers on the whole
 * book. Individual blocks can still be tapped to override the crop either way, and a
 * block can be flagged as a chapter start. Done gathers the surviving blocks in
 * reading order (page, then y) and finalizes exactly like the flow editor.
 *
 * ── Coordinate system (the transform we reuse) ────────────────────────────────────
 * Block boxes come from the server in PDF POINTS with a top-left origin, and each
 * page carries its {width,height} in points. The rasterized image is points × scale
 * (server default 1.5), but we never touch that scale here: both the <img> and every
 * overlay are laid out in NORMALISED fractions — coord / pageDimension ∈ [0,1] — so
 * the raster scale cancels out. The crop rect is likewise stored as a {x,y,w,h}
 * fraction of the page, computed from the pointer's position within the page frame's
 * client rect. A block is inside the crop iff its normalised centre is inside the
 * normalised rect — identical math to the old margin test, generalised to 2-D.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';
import { IconComponent } from '../shared/icon.component';

interface PdfBlock { id: string; page: number; x: number; y: number; w: number; h: number; text: string; region: string; isImage: boolean; }
interface PdfPage { index: number; width: number; height: number; blocks: PdfBlock[]; }
interface PdfState { docId?: string; title?: string; pages?: PdfPage[]; defaultTag?: 'book' | 'article'; }
/** Crop rectangle as a fraction of the page (scale-independent, see file header). */
interface CropRect { x: number; y: number; w: number; h: number; }

type EditMode = 'crop' | 'trim' | 'chapter';

@Component({
  selector: 'app-pdf-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="ed">
      <!-- Sticky translucent top bar (matches the shelf navbar). -->
      <header class="bar bar-top">
        <button class="ghost" (click)="cancel()" aria-label="Cancel"><app-icon name="close" [size]="20" /></button>
        <span class="bar-title">Crop &amp; import</span>
        <button class="cta" [disabled]="finalizing() || keptCount() === 0" (click)="finalize()">
          <app-icon name="check" [size]="18" /> {{ finalizing() ? 'Saving…' : 'Done' }}
        </button>
      </header>

      @if (!pages().length && !finalizing()) {
        <div class="empty">
          <p>No pages to edit. Start an import from the ＋ button.</p>
          <button class="cta" (click)="cancel()">Back</button>
        </div>
      } @else {
        <!-- Tools: title + Ebook/Article tag + edit-mode segmented control. -->
        <div class="tools">
          <input class="ti" type="text" [value]="docTitle()" (input)="docTitle.set($any($event.target).value)" placeholder="Title" />
          <div class="seg" role="group" aria-label="Content type">
            <button [class.on]="tag()==='book'" (click)="tag.set('book')" aria-label="Ebook"><app-icon name="book" [size]="16" /> Ebook</button>
            <button [class.on]="tag()==='article'" (click)="tag.set('article')" aria-label="Article"><app-icon name="article" [size]="16" /> Article</button>
          </div>
        </div>
        <div class="tools tools-modes">
          <div class="seg seg-modes" role="group" aria-label="Edit mode">
            <button [class.on]="mode()==='crop'" (click)="setMode('crop')"><app-icon name="crop" [size]="16" /> Crop</button>
            <button [class.on]="mode()==='trim'" (click)="setMode('trim')"><app-icon name="tap" [size]="16" /> Tap</button>
            <button [class.on]="mode()==='chapter'" (click)="setMode('chapter')"><app-icon name="flag" [size]="16" /> Chapter</button>
          </div>
          <label class="chk"><input type="checkbox" [checked]="dropHF()" (change)="dropHF.set($any($event.target).checked)" /> Drop heads/feet</label>
        </div>

        <!-- One page, centered on a base-colour letterbox. -->
        @if (curPage(); as p) {
          <div class="stage" [class.cropping]="mode()==='crop'">
            <div class="page-frame" [style.aspectRatio]="p.width + ' / ' + p.height" [class.dropped]="deletedPages().has(p.index)">
              <img [src]="pageSrc(p.index)" loading="eager" alt="" draggable="false" />

              <!-- Text-block overlays. In Crop mode they're display-only (pointer
                   events go to the crop layer); in Tap/Chapter mode they're tappable. -->
              @for (b of p.blocks; track b.id) {
                <button class="ov" type="button"
                        [class.excl]="isExcluded(b)" [class.chap]="chapters().has(b.id)"
                        [class.pass]="mode()==='crop'"
                        [style.left.%]="b.x / p.width * 100" [style.top.%]="b.y / p.height * 100"
                        [style.width.%]="b.w / p.width * 100" [style.height.%]="b.h / p.height * 100"
                        (click)="onBlock(b)" [title]="b.text.slice(0, 80)">
                  @if (chapters().has(b.id)) { <span class="chap-badge"><app-icon name="flag" [size]="12" /></span> }
                </button>
              }

              <!-- Crop capture + visualisation layer. Only interactive in Crop mode;
                   touch-action:none there so the drag draws instead of scrolling. -->
              <div class="crop-layer" [class.active]="mode()==='crop'"
                   (pointerdown)="onCropDown($event)" (pointermove)="onCropMove($event)"
                   (pointerup)="onCropUp($event)" (pointercancel)="onCropUp($event)">
                @if (curRect(); as r) {
                  <div class="crop-rect"
                       [style.left.%]="r.x * 100" [style.top.%]="r.y * 100"
                       [style.width.%]="r.w * 100" [style.height.%]="r.h * 100">
                    <span class="handle tl"></span><span class="handle tr"></span>
                    <span class="handle bl"></span><span class="handle br"></span>
                  </div>
                }
              </div>
            </div>
          </div>

          <!-- Crop actions appear only while a rect exists on this page. -->
          @if (curRect()) {
            <div class="crop-actions">
              <button class="pill" (click)="applyCropToAll()"><app-icon name="copy" [size]="16" /> Apply to all pages</button>
              <button class="pill" (click)="clearCrop()"><app-icon name="undo" [size]="16" /> Clear crop</button>
            </div>
          } @else if (mode()==='crop') {
            <p class="hint">Drag a box over the text you want to keep.</p>
          }
        }

        <!-- Sticky translucent bottom bar: page nav + delete-page + kept count. -->
        <footer class="bar bar-bottom">
          <button class="ghost" [disabled]="curIndex()===0" (click)="prevPage()" aria-label="Previous page"><app-icon name="chevron-left" [size]="22" /></button>
          <div class="pager">
            <span class="pg">Page {{ curIndex() + 1 }} of {{ pages().length }}</span>
            <button class="del" (click)="toggleDeletePage()">
              @if (deletedPages().has(curIndex())) { <app-icon name="undo" [size]="14" /> Restore page }
              @else { <app-icon name="trash" [size]="14" /> Delete page }
            </button>
          </div>
          <button class="ghost" [disabled]="curIndex()>=pages().length-1" (click)="nextPage()" aria-label="Next page"><app-icon name="chevron-right" [size]="22" /></button>
        </footer>
        <div class="count-strip">{{ keptCount() }} blocks kept · {{ chapters().size }} chapters</div>
        @if (error()) { <p class="err">{{ error() }}</p> }
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary);
      display: flex; flex-direction: column; }
    .ed { display: flex; flex-direction: column; height: 100%; min-height: 0; }
    button { font: inherit; }
    button:active { opacity: .6; }

    /* Sticky translucent bars — same recipe as the shelf navbar. */
    .bar { display: flex; align-items: center; gap: 10px; flex-shrink: 0; z-index: 10;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
    .bar-top { padding: calc(10px + env(safe-area-inset-top)) 14px 10px; border-bottom: 0.5px solid var(--border-subtle); }
    .bar-bottom { padding: 8px 14px calc(8px + env(safe-area-inset-bottom)); border-top: 0.5px solid var(--border-subtle);
      justify-content: space-between; }
    .bar-title { font-weight: 600; font-size: 16px; flex: 1; text-align: center; }

    .ghost { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px;
      background: var(--bg-elevated); color: var(--text-primary); border: none; border-radius: 10px; cursor: pointer; }
    .ghost:disabled { opacity: .3; }
    .cta { display: inline-flex; align-items: center; gap: 6px; background: var(--accent); color: var(--text-on-accent); border: none;
      border-radius: 10px; padding: 9px 16px; cursor: pointer; font-weight: 600; font-size: 15px; }
    .cta:disabled { opacity: .4; }

    .empty { padding: 48px 16px; text-align: center; color: var(--text-secondary);
      display: flex; flex-direction: column; gap: 16px; align-items: center; }

    /* Tool rows. */
    .tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 14px; flex-shrink: 0; }
    .tools-modes { padding-top: 0; }
    .ti { flex: 1 1 160px; min-width: 120px; background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-input); border-radius: 10px; padding: 10px 12px; font: inherit; outline: none; }
    .ti:focus { border-color: var(--accent); }

    /* iOS segmented control. */
    .seg { display: inline-flex; background: var(--seg-bg); border-radius: 9px; padding: 2px; }
    .seg button { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent;
      color: var(--text-primary); padding: 7px 12px; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .seg button.on { background: var(--seg-active); box-shadow: 0 1px 4px rgba(0,0,0,.16); }
    .seg-modes { flex: 1; }
    .seg-modes button { flex: 1; justify-content: center; }
    .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }

    /* Page stage: centered on a base-colour letterbox. */
    .stage { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
      display: flex; justify-content: center; align-items: flex-start; padding: 16px; background: var(--bg-base); }
    /* In Crop mode, fit the WHOLE page in view (no scroll) so one drag can reach
       every corner, and freeze the letterbox so the gesture never scrolls the page. */
    .stage.cropping { overflow: hidden; align-items: center; }
    .stage.cropping .page-frame { width: auto; height: 100%; max-width: 100%; }

    .page-frame { position: relative; width: 100%; max-width: 560px; background: #fff; border-radius: 12px;
      overflow: hidden; box-shadow: 0 10px 34px rgba(0,0,0,.45); }
    .page-frame.dropped { opacity: .3; }
    .page-frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; user-select: none; -webkit-user-drag: none; }

    /* Block overlays. Default = faint accent tint; excluded = red; chapter = amber. */
    .ov { position: absolute; margin: 0; padding: 0; cursor: pointer; border-radius: 3px;
      border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
      background: color-mix(in srgb, var(--accent) 12%, transparent); transition: opacity .12s, background .12s; }
    .ov.excl { border-color: color-mix(in srgb, var(--error) 70%, transparent);
      background: color-mix(in srgb, var(--error) 26%, transparent); opacity: .55; }
    .ov.chap { border-color: var(--warning); background: color-mix(in srgb, var(--warning) 26%, transparent); opacity: 1; }
    /* In crop mode the boxes must not swallow the drag. */
    .ov.pass { pointer-events: none; }
    .chap-badge { position: absolute; top: -8px; left: -6px; width: 18px; height: 18px; border-radius: 50%;
      background: var(--warning); color: var(--text-on-warning); display: flex; align-items: center; justify-content: center; }

    /* Crop layer + rectangle. */
    .crop-layer { position: absolute; inset: 0; pointer-events: none; }
    .crop-layer.active { pointer-events: auto; touch-action: none; cursor: crosshair; }
    /* The huge box-shadow dims everything OUTSIDE the rect (clipped by the frame). */
    .crop-rect { position: absolute; border: 2px dashed var(--accent); border-radius: 2px;
      box-shadow: 0 0 0 9999px rgba(0,0,0,.5); box-sizing: border-box; }
    .handle { position: absolute; width: 12px; height: 12px; background: var(--accent); border: 2px solid var(--text-on-accent); border-radius: 50%; }
    .handle.tl { left: -7px; top: -7px; } .handle.tr { right: -7px; top: -7px; }
    .handle.bl { left: -7px; bottom: -7px; } .handle.br { right: -7px; bottom: -7px; }

    /* Crop action pills + hint. */
    .crop-actions { display: flex; gap: 10px; justify-content: center; padding: 8px 14px 0; flex-shrink: 0; }
    .pill { display: inline-flex; align-items: center; gap: 6px; background: var(--bg-elevated); color: var(--text-primary);
      border: 1px solid var(--border-subtle); border-radius: 999px; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .hint { text-align: center; color: var(--text-tertiary); font-size: 13px; padding: 8px 14px 0; margin: 0; flex-shrink: 0; }

    /* Bottom pager. */
    .pager { display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .pg { font-size: 14px; font-weight: 600; }
    .del { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent;
      color: var(--error); font-size: 12px; cursor: pointer; padding: 2px 6px; }
    .count-strip { text-align: center; font-size: 12px; color: var(--text-tertiary);
      padding: 0 14px calc(6px + env(safe-area-inset-bottom)); flex-shrink: 0;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
    .err { color: var(--error); text-align: center; padding: 0 16px 10px; margin: 0; }
  `],
})
export class PdfEditorComponent {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);
  private readonly router = inject(Router);

  readonly docTitle = signal('');
  readonly tag = signal<'book' | 'article'>('book');
  readonly mode = signal<EditMode>('crop');
  readonly dropHF = signal(true);
  readonly pages = signal<PdfPage[]>([]);
  readonly curIndex = signal(0);
  readonly deletedPages = signal<Set<number>>(new Set());
  /** Per-page crop rectangles (fraction of the page). Absence = no crop on that page. */
  readonly cropRects = signal<Map<number, CropRect>>(new Map());
  /** Per-block manual override; wins over crop + margins so a tap is always final. */
  readonly blockOverride = signal<Map<string, 'keep' | 'drop'>>(new Map());
  readonly chapters = signal<Set<string>>(new Set());
  readonly finalizing = signal(false);
  readonly error = signal<string | null>(null);
  private docId = '';
  private token = '';

  // Live drag state. Kept as plain fields (not signals) — only the committed rect,
  // held in cropRects, needs to be reactive; the origin is scratch during a drag.
  private dragging = false;
  private dragOrigin: { x: number; y: number } | null = null;

  readonly curPage = computed(() => this.pages()[this.curIndex()]);
  readonly curRect = computed(() => this.cropRects().get(this.curIndex()));

  readonly keptCount = computed(() => {
    let n = 0;
    for (const p of this.pages()) for (const b of p.blocks) if (!this.isExcluded(b)) n++;
    return n;
  });

  constructor() {
    const st = (this.router.getCurrentNavigation()?.extras.state ?? history.state ?? {}) as PdfState;
    this.docId = st.docId || '';
    this.docTitle.set(st.title || '');
    if (st.defaultTag) this.tag.set(st.defaultTag);
    this.pages.set(Array.isArray(st.pages) ? st.pages : []);
    this.token = this.reader.token() || '';
  }

  pageSrc(page: number): string {
    return this.docId ? this.api.editPageUrl(this.token, this.docId, page, 1.5) : '';
  }

  setMode(m: EditMode): void { this.mode.set(m); }

  /** Effective keep/drop decision for a block (overrides > region > crop rect). */
  isExcluded(b: PdfBlock): boolean {
    if (this.deletedPages().has(b.page)) return true;
    const ov = this.blockOverride().get(b.id);
    if (ov === 'keep') return false;        // a tap always wins over the crop
    if (ov === 'drop') return true;
    if (b.isImage || !b.text) return true;
    if (this.dropHF() && (b.region === 'header' || b.region === 'footer')) return true;
    const rect = this.cropRects().get(b.page);
    if (rect) {
      const page = this.pages()[b.page];
      if (page) {
        // Normalised centre vs normalised rect — the raster scale cancels out.
        const cx = (b.x + b.w / 2) / page.width;
        const cy = (b.y + b.h / 2) / page.height;
        if (cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) return true;
      }
    }
    return false;
  }

  // ── Block tap (Tap = include/exclude, Chapter = mark start) ─────────────────────
  onBlock(b: PdfBlock): void {
    if (this.mode() === 'chapter') {
      const chaps = new Set(this.chapters());
      if (chaps.has(b.id)) chaps.delete(b.id);
      else { chaps.add(b.id); if (this.isExcluded(b)) this.setOverride(b.id, 'keep'); } // a chapter must survive
      this.chapters.set(chaps);
      return;
    }
    // Tap mode: flip the block's effective state via a manual override.
    if (this.isExcluded(b)) this.setOverride(b.id, 'keep');
    else { this.setOverride(b.id, 'drop'); this.unmarkChapter(b.id); }
  }

  private setOverride(id: string, v: 'keep' | 'drop'): void {
    const m = new Map(this.blockOverride()); m.set(id, v); this.blockOverride.set(m);
  }
  private unmarkChapter(id: string): void {
    const chaps = new Set(this.chapters()); if (chaps.delete(id)) this.chapters.set(chaps);
  }

  // ── Crop drag (pointer events; touch + mouse) ───────────────────────────────────
  /** Pointer position as a clamped [0,1] fraction of the crop layer. */
  private frac(e: PointerEvent): { x: number; y: number } {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  }

  onCropDown(e: PointerEvent): void {
    if (this.mode() !== 'crop') return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.dragging = true;
    this.dragOrigin = this.frac(e);
    this.writeRect(this.dragOrigin, this.dragOrigin); // seed a zero rect for live feedback
  }

  onCropMove(e: PointerEvent): void {
    if (!this.dragging || !this.dragOrigin) return;
    e.preventDefault();
    this.writeRect(this.dragOrigin, this.frac(e)); // recompute exclusions live
  }

  onCropUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    // A tiny drag reads as a tap — clear the crop instead of leaving a sliver.
    const r = this.cropRects().get(this.curIndex());
    if (r && (r.w < 0.03 || r.h < 0.03)) this.clearCrop();
    this.dragOrigin = null;
  }

  /** Store the normalised rect between two points on the current page. */
  private writeRect(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const rect: CropRect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    const m = new Map(this.cropRects()); m.set(this.curIndex(), rect); this.cropRects.set(m);
  }

  /** Copy this page's crop onto every page — kills page numbers/heads in one move. */
  applyCropToAll(): void {
    const rect = this.cropRects().get(this.curIndex());
    if (!rect) return;
    const m = new Map<number, CropRect>();
    for (const p of this.pages()) m.set(p.index, { ...rect });
    this.cropRects.set(m);
  }

  clearCrop(): void {
    const m = new Map(this.cropRects()); m.delete(this.curIndex()); this.cropRects.set(m);
  }

  // ── Page navigation + deletion ──────────────────────────────────────────────────
  prevPage(): void { if (this.curIndex() > 0) this.curIndex.update((i) => i - 1); }
  nextPage(): void { if (this.curIndex() < this.pages().length - 1) this.curIndex.update((i) => i + 1); }

  toggleDeletePage(): void {
    const i = this.curIndex();
    const d = new Set(this.deletedPages());
    if (d.has(i)) d.delete(i); else d.add(i);
    this.deletedPages.set(d);
  }

  // ── Finalize ────────────────────────────────────────────────────────────────────
  async finalize(): Promise<void> {
    if (this.finalizing() || this.keptCount() === 0) return;
    const token = this.reader.token();
    if (!token) { this.error.set('Sign in as a reader to import.'); return; }

    // Gather kept blocks in reading order (page, then y).
    const kept: Array<{ text: string; chapterStart: boolean }> = [];
    const pagesInOrder = [...this.pages()].sort((a, b) => a.index - b.index);
    for (const p of pagesInOrder) {
      const blocks = [...p.blocks].sort((a, b) => a.y - b.y);
      for (const b of blocks) {
        if (this.isExcluded(b)) continue;
        kept.push({ text: b.text, chapterStart: this.chapters().has(b.id) });
      }
    }
    if (kept.length === 0) { this.error.set('Everything is cropped away — keep at least one block.'); return; }

    this.finalizing.set(true);
    this.error.set(null);
    try {
      const res = await this.api.finalizeImport(token, {
        title: this.docTitle().trim() || 'Untitled',
        language: 'en',
        projectType: this.tag(),
        blocks: kept,
      });
      await this.router.navigate(['/book', res.projectId], { state: { title: this.docTitle().trim() } });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Import failed.');
      this.finalizing.set(false);
    }
  }

  cancel(): void { void this.router.navigateByUrl('/'); }
}

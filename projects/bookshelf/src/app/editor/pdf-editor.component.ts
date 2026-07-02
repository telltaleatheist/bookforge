/**
 * PdfEditorComponent — the mupdf-style page-crop editor. A PDF ingested via the ＋
 * sheet arrives as pages carrying per-block boxes; this shows each rasterized page
 * with its text blocks overlaid and lets the reader exclude junk (headers, footers,
 * page numbers) so it doesn't end up in the audiobook.
 *
 * Because the audio path is text→epub, "cropping" is a spatial BLOCK FILTER, not an
 * image crop: top/bottom margins (applied to every page) drop blocks whose center
 * falls in the margin, header/footer regions are dropped by default, and any block
 * can be toggled by tapping it. Chapter markers tag a block as a chapter start. Done
 * gathers the surviving blocks in reading order and finalizes exactly like the flow
 * editor (same /api/edit/finalize → project → Read&Listen).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';

interface PdfBlock { id: string; page: number; x: number; y: number; w: number; h: number; text: string; region: string; isImage: boolean; }
interface PdfPage { index: number; width: number; height: number; blocks: PdfBlock[]; }
interface PdfState { docId?: string; title?: string; pages?: PdfPage[]; defaultTag?: 'book' | 'article'; }

@Component({
  selector: 'app-pdf-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ed">
      <header class="bar-top">
        <button class="icon" (click)="cancel()" aria-label="Cancel">✕</button>
        <span class="title">Crop &amp; import</span>
        <button class="done" [disabled]="finalizing() || keptCount() === 0" (click)="finalize()">
          {{ finalizing() ? 'Saving…' : 'Done' }}
        </button>
      </header>

      @if (!pages().length && !finalizing()) {
        <div class="empty"><p>No pages to edit. Start an import from the ＋ button.</p><button class="primary" (click)="cancel()">Back</button></div>
      } @else {
        <div class="tools">
          <input class="ti" type="text" [value]="docTitle()" (input)="docTitle.set($any($event.target).value)" placeholder="Title" />
          <div class="seg">
            <button [class.on]="tag()==='book'" (click)="tag.set('book')">📖</button>
            <button [class.on]="tag()==='article'" (click)="tag.set('article')">📰</button>
          </div>
          <div class="seg">
            <button [class.on]="tapMode()==='trim'" (click)="tapMode.set('trim')" title="Tap blocks to keep/remove">✂ Trim</button>
            <button [class.on]="tapMode()==='chapter'" (click)="tapMode.set('chapter')" title="Tap a block to start a chapter">▸ Chapter</button>
          </div>
          <label class="chk"><input type="checkbox" [checked]="dropHF()" (change)="dropHF.set($any($event.target).checked)" /> Drop headers/footers</label>
          <label class="sl">Top {{ marginTop() }}%<input type="range" min="0" max="25" [value]="marginTop()" (input)="marginTop.set(+$any($event.target).value)" /></label>
          <label class="sl">Bottom {{ marginBottom() }}%<input type="range" min="0" max="25" [value]="marginBottom()" (input)="marginBottom.set(+$any($event.target).value)" /></label>
        </div>

        <div class="pages">
          @for (p of pages(); track p.index) {
            <div class="page-wrap" [class.dropped]="deletedPages().has(p.index)">
              <div class="page-head">
                <span>Page {{ p.index + 1 }}</span>
                <button class="mini" (click)="togglePage(p.index)">{{ deletedPages().has(p.index) ? 'Restore' : 'Delete page' }}</button>
              </div>
              <div class="canvas" [style.aspectRatio]="p.width + ' / ' + p.height">
                <img [src]="pageSrc(p.index)" loading="lazy" alt="" />
                @for (b of p.blocks; track b.id) {
                  <button class="ov" type="button"
                          [class.excl]="isExcluded(b)" [class.chap]="chapters().has(b.id)"
                          [style.left.%]="b.x / p.width * 100" [style.top.%]="b.y / p.height * 100"
                          [style.width.%]="b.w / p.width * 100" [style.height.%]="b.h / p.height * 100"
                          (click)="onBlock(b)" [title]="b.text.slice(0, 80)"></button>
                }
              </div>
            </div>
          }
        </div>

        <footer class="foot">
          <span class="count">{{ keptCount() }} blocks kept · {{ chapters().size }} chapters</span>
          <button class="primary" [disabled]="finalizing() || keptCount() === 0" (click)="finalize()">{{ finalizing() ? 'Saving…' : 'Import & open' }}</button>
        </footer>
        @if (error()) { <p class="err">{{ error() }}</p> }
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary, #eee); display: flex; flex-direction: column; }
    .ed { display: flex; flex-direction: column; height: 100%; }
    .bar-top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .bar-top .title { font-weight: 600; flex: 1; }
    .icon { background: var(--bg-elevated); color: inherit; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px 12px; cursor: pointer; }
    .done, .primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-weight: 600; }
    .done:disabled, .primary:disabled { opacity: .4; }
    .empty { padding: 48px 16px; text-align: center; opacity: .8; display: flex; flex-direction: column; gap: 16px; align-items: center; }
    .tools { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .ti { flex: 1 1 160px; min-width: 120px; background: var(--bg-input); color: inherit; border: 1px solid var(--border-input); border-radius: 8px; padding: 8px 10px; font: inherit; }
    .seg { display: inline-flex; background: var(--bg-elevated); border-radius: 8px; padding: 2px; gap: 2px; }
    .seg button { border: none; background: transparent; color: var(--text-tertiary); padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .seg button.on { background: var(--accent); color: #fff; }
    .chk, .sl { font-size: 12px; display: flex; align-items: center; gap: 6px; opacity: .85; }
    .sl input { width: 90px; }
    .pages { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; }
    .page-wrap { margin-bottom: 18px; }
    .page-wrap.dropped { opacity: .35; }
    .page-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 12px; opacity: .7; }
    .mini { border: 1px solid var(--border-subtle); background: var(--bg-surface); color: inherit; border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
    .canvas { position: relative; width: 100%; background: #fff; border: 1px solid var(--border-subtle); border-radius: 4px; overflow: hidden; }
    .canvas img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .ov { position: absolute; margin: 0; padding: 0; border: 1px solid color-mix(in srgb, var(--accent) 70%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); cursor: pointer; border-radius: 2px; }
    .ov.excl { border-color: rgba(200,60,60,.85); background: rgba(200,60,60,.28); }
    .ov.chap { border-color: #f1c40f; background: rgba(241,196,15,.28); }
    .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); flex-shrink: 0; }
    .count { font-size: 12px; opacity: .7; }
    .err { color: #e66; padding: 0 16px 10px; margin: 0; }
  `],
})
export class PdfEditorComponent {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);
  private readonly router = inject(Router);

  readonly docTitle = signal('');
  readonly tag = signal<'book' | 'article'>('book');
  readonly tapMode = signal<'trim' | 'chapter'>('trim');
  readonly dropHF = signal(true);
  readonly marginTop = signal(0);
  readonly marginBottom = signal(0);
  readonly pages = signal<PdfPage[]>([]);
  readonly deletedPages = signal<Set<number>>(new Set());
  readonly excludeOverrides = signal<Set<string>>(new Set());
  readonly keepOverrides = signal<Set<string>>(new Set());
  readonly chapters = signal<Set<string>>(new Set());
  readonly finalizing = signal(false);
  readonly error = signal<string | null>(null);
  private docId = '';
  private token = '';

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

  /** Effective keep/drop decision for a block (margins + region + manual override). */
  isExcluded(b: PdfBlock): boolean {
    if (this.deletedPages().has(b.page)) return true;
    if (this.keepOverrides().has(b.id)) return false;
    if (this.excludeOverrides().has(b.id)) return true;
    if (b.isImage || !b.text) return true;
    if (this.dropHF() && (b.region === 'header' || b.region === 'footer')) return true;
    const page = this.pages()[b.page];
    if (!page) return false;
    const cy = (b.y + b.h / 2) / page.height * 100;
    if (cy < this.marginTop()) return true;
    if (cy > 100 - this.marginBottom()) return true;
    return false;
  }

  onBlock(b: PdfBlock): void {
    if (this.tapMode() === 'chapter') {
      // Only meaningful on a kept block; marking also forces it kept.
      const chaps = new Set(this.chapters());
      if (chaps.has(b.id)) chaps.delete(b.id);
      else { chaps.add(b.id); if (this.isExcluded(b)) this.forceKeep(b); }
      this.chapters.set(chaps);
      return;
    }
    // Trim: flip the block's effective state via overrides.
    if (this.isExcluded(b)) this.forceKeep(b);
    else this.forceExclude(b);
  }

  private forceKeep(b: PdfBlock): void {
    const keep = new Set(this.keepOverrides()); keep.add(b.id); this.keepOverrides.set(keep);
    const excl = new Set(this.excludeOverrides()); excl.delete(b.id); this.excludeOverrides.set(excl);
  }
  private forceExclude(b: PdfBlock): void {
    const excl = new Set(this.excludeOverrides()); excl.add(b.id); this.excludeOverrides.set(excl);
    const keep = new Set(this.keepOverrides()); keep.delete(b.id); this.keepOverrides.set(keep);
    const chaps = new Set(this.chapters()); if (chaps.delete(b.id)) this.chapters.set(chaps);
  }

  togglePage(i: number): void {
    const d = new Set(this.deletedPages());
    if (d.has(i)) d.delete(i); else d.add(i);
    this.deletedPages.set(d);
  }

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
    if (kept.length === 0) { this.error.set('Everything is trimmed away — keep at least one block.'); return; }

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

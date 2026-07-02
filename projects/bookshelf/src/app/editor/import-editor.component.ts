/**
 * ImportEditorComponent — the mobile import→edit surface (flow mode). A freshly
 * ingested URL/file arrives as blocks (via router state from the shelf's ＋ import
 * sheet); the reader trims junk blocks (page numbers, boilerplate), marks chapter
 * starts, picks an Ebook/Article tag, and hits Done. Done builds a chaptered epub
 * server-side, creates a persisted project, and opens it in the reader.
 *
 * Flow mode covers epub / URL / text (reflowable, no pages). The PDF page-crop
 * editor is a separate mode (Phase C); both finalize through /api/edit/finalize.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';

interface EditBlock {
  id: string;
  text: string;
  chapterStart: boolean;
}

interface EditState {
  title?: string;
  blocks?: Array<{ id?: string; text: string }>;
  defaultTag?: 'book' | 'article';
  url?: string | null;
}

@Component({
  selector: 'app-import-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="editor">
      <header class="bar-top">
        <button class="icon" (click)="cancel()" aria-label="Cancel">✕</button>
        <span class="title">Edit &amp; import</span>
        <button class="done" [disabled]="finalizing() || blocks().length === 0" (click)="finalize()">
          {{ finalizing() ? 'Saving…' : 'Done' }}
        </button>
      </header>

      @if (blocks().length === 0 && !finalizing()) {
        <div class="empty">
          <p>Nothing to edit. Start an import from the ＋ button.</p>
          <button class="primary" (click)="cancel()">Back</button>
        </div>
      } @else {
        <div class="meta">
          <label class="field">
            <span>Title</span>
            <input type="text" [value]="docTitle()" (input)="docTitle.set($any($event.target).value)"
                   placeholder="Title" />
          </label>
          <div class="field">
            <span>Save as</span>
            <div class="seg">
              <button [class.on]="tag() === 'book'" (click)="tag.set('book')">📖 Ebook</button>
              <button [class.on]="tag() === 'article'" (click)="tag.set('article')">📰 Article</button>
            </div>
          </div>
          <p class="hint">Remove junk (page numbers, headers) with 🗑. Tap ▸ to start a new chapter at a block.</p>
        </div>

        <div class="blocks">
          @for (b of blocks(); track b.id) {
            @if (b.chapterStart) {
              <div class="chap-divider"><span>Chapter start</span></div>
            }
            <div class="block" [class.is-chap]="b.chapterStart">
              <div class="block-actions">
                <button class="mini" [class.on]="b.chapterStart" (click)="toggleChapter(b)"
                        [title]="b.chapterStart ? 'Not a chapter start' : 'Start a chapter here'">▸</button>
                <button class="mini danger" (click)="remove(b)" title="Remove this block">🗑</button>
              </div>
              <p class="block-text">{{ b.text }}</p>
            </div>
          }
        </div>

        <footer class="foot">
          <span class="count">{{ blocks().length }} blocks · {{ chapterCount() }} chapter{{ chapterCount() === 1 ? '' : 's' }}</span>
          <button class="primary" [disabled]="finalizing() || blocks().length === 0" (click)="finalize()">
            {{ finalizing() ? 'Saving…' : 'Import & open' }}
          </button>
        </footer>

        @if (error()) { <p class="err">{{ error() }}</p> }
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary, #eee); display: flex; flex-direction: column; }
    .editor { display: flex; flex-direction: column; height: 100%; }
    .bar-top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .bar-top .title { font-weight: 600; flex: 1; }
    .icon { background: var(--bg-elevated); color: inherit; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 15px; }
    .done, .primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 15px; font-weight: 600; }
    .done:disabled, .primary:disabled { opacity: .4; cursor: default; }
    .empty { padding: 48px 16px; text-align: center; opacity: .8; display: flex; flex-direction: column; gap: 16px; align-items: center; }
    .meta { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; flex-shrink: 0; }
    .field { display: block; margin-bottom: 12px; }
    .field > span { display: block; font-size: 13px; opacity: .7; margin-bottom: 6px; }
    .field input[type=text] { width: 100%; box-sizing: border-box; background: var(--bg-input); color: inherit; border: 1px solid var(--border-input); border-radius: 8px; padding: 10px; font: inherit; }
    .seg { display: inline-flex; background: var(--bg-elevated); border-radius: 8px; padding: 2px; gap: 2px; }
    .seg button { border: none; background: transparent; color: var(--text-tertiary); padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .seg button.on { background: var(--accent); color: #fff; }
    .hint { font-size: 12px; opacity: .65; margin: 4px 0 0; }
    .blocks { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px 16px 24px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; }
    .chap-divider { display: flex; align-items: center; gap: 10px; margin: 18px 0 8px; }
    .chap-divider span { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 700; }
    .chap-divider::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 40%, transparent); }
    .block { display: flex; gap: 10px; padding: 8px; border-radius: 8px; margin-bottom: 6px; background: var(--bg-elevated); }
    .block.is-chap { outline: 1px solid color-mix(in srgb, var(--accent) 50%, transparent); }
    .block-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
    .mini { width: 34px; height: 34px; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: inherit; border-radius: 8px; cursor: pointer; font-size: 15px; }
    .mini.on { background: var(--accent); color: #fff; border-color: var(--accent); }
    .mini.danger:active { background: var(--error, #c0392b); color: #fff; }
    .block-text { margin: 0; line-height: 1.5; font-size: 15px; overflow-wrap: anywhere; }
    .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; flex-shrink: 0; }
    .count { font-size: 12px; opacity: .7; }
    .err { color: #e66; padding: 0 16px 12px; margin: 0; }
  `],
})
export class ImportEditorComponent {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);
  private readonly router = inject(Router);

  readonly docTitle = signal('');
  readonly tag = signal<'book' | 'article'>('article');
  readonly blocks = signal<EditBlock[]>([]);
  readonly finalizing = signal(false);
  readonly error = signal<string | null>(null);
  private sourceUrl: string | null = null;

  readonly chapterCount = computed(() => {
    const list = this.blocks();
    if (list.length === 0) return 0;
    // Content before the first marker is chapter 1; each marker starts another.
    const markers = list.filter((b) => b.chapterStart).length;
    const hasLead = list.some((b) => !b.chapterStart) && (!list[0] || !list[0].chapterStart);
    return markers + (hasLead ? 1 : 0) || 1;
  });

  constructor() {
    // Blocks arrive via router state from the shelf's import sheet. history.state
    // survives the lazy-load; a reload loses it (handled by the empty view).
    const state = (this.router.getCurrentNavigation()?.extras.state ?? history.state ?? {}) as EditState;
    this.docTitle.set(state.title || '');
    if (state.defaultTag === 'book' || state.defaultTag === 'article') this.tag.set(state.defaultTag);
    this.sourceUrl = state.url || null;
    const incoming = Array.isArray(state.blocks) ? state.blocks : [];
    this.blocks.set(
      incoming
        .map((b, i) => ({ id: b.id || `b${i}`, text: (b.text || '').replace(/\s+/g, ' ').trim(), chapterStart: false }))
        .filter((b) => b.text.length > 0),
    );
  }

  toggleChapter(b: EditBlock): void {
    this.blocks.update((list) => list.map((x) => (x.id === b.id ? { ...x, chapterStart: !x.chapterStart } : x)));
  }

  remove(b: EditBlock): void {
    this.blocks.update((list) => list.filter((x) => x.id !== b.id));
  }

  async finalize(): Promise<void> {
    const list = this.blocks();
    if (list.length === 0 || this.finalizing()) return;
    const token = this.reader.token();
    if (!token) { this.error.set('Sign in as a reader to import.'); return; }

    this.finalizing.set(true);
    this.error.set(null);
    try {
      const res = await this.api.finalizeImport(token, {
        title: this.docTitle().trim() || 'Untitled',
        language: 'en',
        projectType: this.tag(),
        url: this.sourceUrl || undefined,
        blocks: list.map((b) => ({ text: b.text, chapterStart: b.chapterStart })),
      });
      // Open the freshly-created project in the Read&Listen view.
      await this.router.navigate(['/book', res.projectId], { state: { title: this.docTitle().trim() } });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Import failed.');
      this.finalizing.set(false);
    }
  }

  cancel(): void {
    void this.router.navigateByUrl('/');
  }
}

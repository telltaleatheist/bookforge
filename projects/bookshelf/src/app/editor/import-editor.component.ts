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
import { IconComponent } from '../shared/icon.component';

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
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="editor">
      <header class="bar-top">
        <button class="round-btn" (click)="cancel()" aria-label="Cancel">
          <app-icon name="close" [size]="20" />
        </button>
        <div class="bar-title">
          <span class="title">Edit &amp; import</span>
          @if (blocks().length > 0) {
            <span class="subtitle">{{ blocks().length }} block{{ blocks().length === 1 ? '' : 's' }} · {{ chapterCount() }} chapter{{ chapterCount() === 1 ? '' : 's' }}</span>
          }
        </div>
        @if (blocks().length > 0) {
          <span class="count-chip">{{ blocks().length }}</span>
        }
      </header>

      @if (blocks().length === 0 && !finalizing()) {
        <div class="empty">
          <p>Nothing to edit. Start an import from the ＋ button.</p>
          <button class="primary compact" (click)="cancel()">Back to library</button>
        </div>
      } @else {
        <div class="scroll">
          <div class="meta card">
            <label class="field">
              <span class="field-label">Title</span>
              <input type="text" [value]="docTitle()" (input)="docTitle.set($any($event.target).value)"
                     placeholder="Untitled" />
            </label>
            <div class="field">
              <span class="field-label">Save as</span>
              <div class="seg">
                <button [class.on]="tag() === 'book'" (click)="tag.set('book')">
                  <app-icon name="book" [size]="17" /><span>Ebook</span>
                </button>
                <button [class.on]="tag() === 'article'" (click)="tag.set('article')">
                  <app-icon name="article" [size]="17" /><span>Article</span>
                </button>
              </div>
            </div>
            <p class="hint">Remove junk blocks (page numbers, headers) and flag where each new chapter begins.</p>
          </div>

          <div class="blocks">
            @for (b of blocks(); track b.id) {
              @if (b.chapterStart) {
                <div class="chap-divider"><span>Chapter start</span></div>
              }
              <div class="block" [class.is-chap]="b.chapterStart">
                @if (b.chapterStart) { <span class="chap-chip">Chapter</span> }
                <p class="block-text">{{ b.text }}</p>
                <div class="block-actions">
                  <button class="round-btn small" [class.on]="b.chapterStart" (click)="toggleChapter(b)"
                          [attr.aria-label]="b.chapterStart ? 'Remove chapter start' : 'Start a chapter here'"
                          [title]="b.chapterStart ? 'Not a chapter start' : 'Start a chapter here'">
                    <app-icon name="flag" [size]="17" />
                  </button>
                  <button class="round-btn small danger" (click)="remove(b)"
                          aria-label="Remove this block" title="Remove this block">
                    <app-icon name="trash" [size]="17" />
                  </button>
                </div>
              </div>
            }
          </div>

          @if (error()) { <p class="err">{{ error() }}</p> }
        </div>

        @if (removedNotice()) {
          <div class="undo-pill">
            <span>Block removed</span>
            <button (click)="undoRemove()"><app-icon name="undo" [size]="16" /> Undo</button>
          </div>
        }

        <footer class="bar-bottom">
          <button class="primary" [disabled]="finalizing() || blocks().length === 0" (click)="finalize()">
            {{ finalizing() ? 'Saving…' : 'Import &amp; open' }}
          </button>
        </footer>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary); display: flex; flex-direction: column; }
    .editor { display: flex; flex-direction: column; height: 100%; min-height: 0; }

    /* ── Sticky translucent top bar (iOS large-title style, condensed) ── */
    .bar-top { position: sticky; top: 0; z-index: 10; flex-shrink: 0; display: flex; align-items: center; gap: 12px;
      padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      border-bottom: 0.5px solid var(--border-subtle);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
    .bar-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .bar-title .title { font-size: 17px; font-weight: 600; line-height: 1.2; }
    .bar-title .subtitle { font-size: 12px; color: var(--text-tertiary); }
    .count-chip { flex-shrink: 0; min-width: 26px; text-align: center; padding: 3px 9px; border-radius: 12px;
      background: var(--bg-input); color: var(--text-secondary); font-size: 12px; font-weight: 600; }

    /* Circular icon buttons — 40px touch target. */
    .round-btn { width: 40px; height: 40px; flex-shrink: 0; border: none; border-radius: 50%;
      background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; justify-content: center; }
    .round-btn:active { opacity: 0.6; }
    .round-btn.small { width: 40px; height: 40px; }
    .round-btn.on { background: var(--accent); color: #fff; }
    .round-btn.danger { color: var(--error); }
    .round-btn.danger:active { background: color-mix(in srgb, var(--error) 20%, var(--bg-elevated)); opacity: 1; }

    /* ── Scroll region ── */
    .scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
      padding: 14px 16px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; }

    .card { background: var(--bg-surface); border-radius: 12px; padding: 14px; }
    .meta { margin-bottom: 16px; }
    .field { display: block; }
    .field + .field { margin-top: 14px; }
    .field-label { display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 7px; }
    .field input[type=text] { width: 100%; box-sizing: border-box; background: var(--bg-input); color: var(--text-primary);
      border: 1px solid transparent; border-radius: 10px; padding: 11px 12px; font: inherit; font-size: 16px; outline: none; }
    .field input[type=text]:focus { border-color: var(--accent); }

    /* iOS segmented control: gray track, raised selected segment. */
    .seg { display: flex; background: var(--seg-bg); border-radius: 9px; padding: 2px; }
    .seg button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
      border: none; background: transparent; color: var(--text-primary); padding: 7px 12px; border-radius: 7px;
      cursor: pointer; font-size: 14px; font-weight: 500; }
    .seg button.on { background: var(--seg-active); box-shadow: 0 1px 4px rgba(0,0,0,0.16); }
    .seg button:active { opacity: 0.6; }
    .hint { font-size: 12px; color: var(--text-tertiary); margin: 12px 0 0; line-height: 1.4; }

    /* ── Block list ── */
    .blocks { display: flex; flex-direction: column; gap: 8px; }
    .chap-divider { display: flex; align-items: center; gap: 10px; margin: 12px 0 2px; }
    .chap-divider span { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 700; }
    .chap-divider::after { content: ''; flex: 1; height: 0.5px; background: color-mix(in srgb, var(--accent) 40%, transparent); }

    .block { position: relative; display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 12px 12px 14px; border-radius: 12px; background: var(--bg-surface); }
    .block.is-chap { padding-left: 16px; }
    /* Accent left-edge inset bar for chapter-start blocks. */
    .block.is-chap::before { content: ''; position: absolute; left: 5px; top: 10px; bottom: 10px;
      width: 3px; border-radius: 2px; background: var(--accent); }
    .chap-chip { position: absolute; top: -7px; left: 14px; padding: 2px 7px; border-radius: 8px;
      background: var(--accent); color: #fff; font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .block-text { flex: 1; min-width: 0; margin: 0; line-height: 1.55; font-size: 15px; color: var(--text-primary); overflow-wrap: anywhere; }
    .block-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; margin: -2px -2px 0 0; }

    /* ── Undo pill (floats just above the bottom bar for ~4s) ── */
    .undo-pill { position: absolute; left: 50%; transform: translateX(-50%); z-index: 20;
      bottom: calc(72px + env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 14px;
      background: var(--bg-elevated); color: var(--text-primary); border: 0.5px solid var(--border-subtle);
      border-radius: 22px; padding: 8px 8px 8px 16px; font-size: 13px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      animation: pillUp 0.18s ease; }
    .undo-pill button { display: inline-flex; align-items: center; gap: 5px; border: none; background: var(--accent);
      color: #fff; border-radius: 16px; padding: 6px 13px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .undo-pill button:active { opacity: 0.6; }
    @keyframes pillUp { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

    /* ── Sticky translucent bottom bar ── */
    .bar-bottom { position: sticky; bottom: 0; z-index: 10; flex-shrink: 0;
      padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      border-top: 0.5px solid var(--border-subtle);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
    .primary { display: block; width: 100%; box-sizing: border-box; background: var(--accent); color: #fff; border: none;
      border-radius: 12px; padding: 14px; cursor: pointer; font-size: 16px; font-weight: 600; }
    .primary:active { opacity: 0.6; }
    .primary:disabled { opacity: 0.4; cursor: default; }
    .primary.compact { display: inline-block; width: auto; padding: 12px 24px; }

    .empty { flex: 1; display: flex; flex-direction: column; gap: 18px; align-items: center; justify-content: center;
      padding: 48px 24px; text-align: center; color: var(--text-secondary); }
    .err { color: var(--error); margin: 12px 2px 0; font-size: 14px; }

    @media (min-width: 768px) {
      .bar-bottom { padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
      .primary { max-width: 720px; margin: 0 auto; }
    }
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

  // Undo affordance: the most recent removal (block + its original index) plus a
  // transient flag that drives the ~4s pill. Only the last removal is restorable.
  readonly removedNotice = signal(false);
  private lastRemoved: { block: EditBlock; index: number } | null = null;
  private undoTimer: ReturnType<typeof setTimeout> | null = null;

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
    const index = this.blocks().findIndex((x) => x.id === b.id);
    if (index < 0) return;
    this.lastRemoved = { block: b, index };
    this.blocks.update((list) => list.filter((x) => x.id !== b.id));
    this.removedNotice.set(true);
    if (this.undoTimer) clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => {
      this.removedNotice.set(false);
      this.lastRemoved = null;
    }, 4000);
  }

  undoRemove(): void {
    const rec = this.lastRemoved;
    if (!rec) return;
    if (this.undoTimer) { clearTimeout(this.undoTimer); this.undoTimer = null; }
    this.blocks.update((list) => {
      const next = [...list];
      next.splice(Math.min(rec.index, next.length), 0, rec.block);
      return next;
    });
    this.removedNotice.set(false);
    this.lastRemoved = null;
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

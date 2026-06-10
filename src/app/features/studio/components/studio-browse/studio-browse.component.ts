import { Component, input, output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StudioItem } from '../../models/studio.types';

/**
 * StudioBrowseComponent - cover-grid "Browse" view of the unified collection.
 *
 * Renders the same project data Studio works on (books + articles) as an
 * archival/library-style cover grid. Selecting a card opens it in the Studio
 * workspace. Reads item.coverData (base64), already populated by StudioService.
 */
@Component({
  selector: 'app-studio-browse',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="browse">
      @if (items().length === 0) {
        <div class="empty">
          <div class="empty-icon">\u{1F4DA}</div>
          <div>No books yet. Use + to import.</div>
        </div>
      } @else {
        <div class="grid">
          @for (item of items(); track item.id) {
            <button
              class="card"
              [class.selected]="item.id === selectedId()"
              (click)="open.emit(item)"
              (contextmenu)="onContextMenu($event, item)"
              [title]="item.title"
            >
              <div class="cover">
                @if (item.coverData) {
                  <img [src]="item.coverData" [alt]="item.title" loading="lazy" />
                } @else {
                  <div class="cover-placeholder">{{ item.type === 'article' ? '\u{1F4C4}' : '\u{1F4D6}' }}</div>
                }
                @if (item.audiobookPath || hasBilingual(item)) {
                  <span class="badge audio" title="Has audiobook">\u{1F3A7}</span>
                } @else if (item.hasCleaned || item.hasTranslated || item.hasTtsCache) {
                  <span class="badge wip" title="In production">\u{2699}</span>
                }
              </div>
              <div class="meta">
                <div class="title">{{ item.title }}</div>
                <div class="author">{{ item.author || 'Unknown' }}{{ item.year ? ' · ' + item.year : '' }}</div>
              </div>
            </button>
          }
        </div>
      }

      @if (ctxMenu(); as ctx) {
        <div class="ctx-backdrop" (click)="ctxMenu.set(null)" (contextmenu)="$event.preventDefault(); ctxMenu.set(null)"></div>
        <div class="ctx-menu" [style.top.px]="ctx.y" [style.left.px]="ctx.x">
          <button class="ctx-item" (click)="editRequested.emit(ctx.item); ctxMenu.set(null)">Edit (PDF viewer)</button>
          <button class="ctx-item" (click)="open.emit(ctx.item); ctxMenu.set(null)">Open in workspace</button>
          @if (ctx.item.audiobookPath || hasBilingual(ctx.item)) {
            <button class="ctx-item" (click)="exportRequested.emit(ctx.item); ctxMenu.set(null)">Export audiobook…</button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .browse {
      height: 100%; width: 100%; box-sizing: border-box;
      overflow-y: auto; overflow-x: hidden;   /* never scroll sideways */
      padding: 16px 20px 40px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 18px 16px;
      width: 100%;
    }
    .card {
      display: flex; flex-direction: column; gap: 8px;
      min-width: 0;   /* allow grid item to shrink below its content's min-width */
      background: none; border: none; padding: 6px; margin: 0;
      cursor: pointer; text-align: left; border-radius: 8px;
      transition: background 0.12s;
    }
    .card:hover { background: var(--bg-elevated); }
    .card.selected { background: color-mix(in srgb, var(--accent-primary) 18%, transparent); }
    .cover {
      position: relative;
      aspect-ratio: 2 / 3;
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-elevated);
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cover-placeholder {
      width: 100%; height: 100%;
      display: flex; align-items: center; justify-content: center;
      font-size: 2.5rem; opacity: 0.5;
    }
    .badge {
      position: absolute; bottom: 6px; right: 6px;
      width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.7rem;
      background: color-mix(in srgb, var(--bg-base) 75%, transparent);
      backdrop-filter: blur(4px);
    }
    .badge.audio { background: color-mix(in srgb, var(--accent-primary) 85%, transparent); }
    .meta { min-width: 0; }
    .title {
      font-size: 0.8rem; font-weight: 600; color: var(--text-primary);
      line-height: 1.25; overflow: hidden; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow-wrap: anywhere; word-break: break-word;  /* wrap long words, never overflow the box */
    }
    .author {
      font-size: 0.72rem; color: var(--text-secondary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;
    }
    .empty {
      height: 100%; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      color: var(--text-secondary);
    }
    .empty-icon { font-size: 3rem; opacity: 0.5; }
    .ctx-backdrop { position: fixed; inset: 0; z-index: 999; }
    .ctx-menu {
      position: fixed; z-index: 1000; min-width: 180px;
      background: var(--bg-elevated); border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 8px; padding: 4px; box-shadow: 0 8px 28px rgba(0,0,0,0.4);
    }
    .ctx-item {
      display: block; width: 100%; text-align: left;
      background: none; border: none; color: var(--text-primary);
      padding: 8px 12px; border-radius: 5px; font-size: 0.82rem; cursor: pointer;
    }
    .ctx-item:hover { background: var(--accent-primary, #06b6d4); color: #fff; }
  `]
})
export class StudioBrowseComponent {
  readonly items = input<StudioItem[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly open = output<StudioItem>();
  readonly editRequested = output<StudioItem>();
  readonly exportRequested = output<StudioItem>();

  readonly ctxMenu = signal<{ x: number; y: number; item: StudioItem } | null>(null);

  onContextMenu(event: MouseEvent, item: StudioItem): void {
    event.preventDefault();
    // keep the menu within the viewport
    const x = Math.min(event.clientX, window.innerWidth - 200);
    const y = Math.min(event.clientY, window.innerHeight - 140);
    this.ctxMenu.set({ x, y, item });
  }

  hasBilingual(item: StudioItem): boolean {
    return !!item.bilingualOutputs && Object.keys(item.bilingualOutputs).length > 0;
  }
}

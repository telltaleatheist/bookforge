import { Component, input, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, CdkDrag, CdkDropList, CdkDropListGroup, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { StudioItem } from '../../models/studio.types';

/**
 * StudioListComponent - Accordion list for books, articles, and archived items
 *
 * Features:
 * - Collapsible sections for Articles, Books, and Archived
 * - Multi-select via Cmd/Ctrl+Click (toggle) and Shift+Click (range)
 * - Drag/drop reordering within and between sections
 * - Drag multi-selected items to archive
 * - Context menu support (respects multi-selection)
 */
@Component({
  selector: 'app-studio-list',
  standalone: true,
  imports: [CommonModule, CdkDrag, CdkDropList, CdkDropListGroup],
  template: `
    <div class="studio-list" cdkDropListGroup>
      <!-- Articles Accordion -->
      <div class="accordion-section">
        <button
          class="accordion-header"
          [class.expanded]="articlesExpanded()"
          (click)="articlesExpanded.set(!articlesExpanded())"
        >
          <span class="accordion-icon">{{ articlesExpanded() ? '\u25BC' : '\u25B6' }}</span>
          <span class="accordion-title">Articles</span>
          <span class="accordion-count">({{ articles().length }})</span>
        </button>

        @if (articlesExpanded()) {
          <div
            class="accordion-content"
            cdkDropList
            [cdkDropListData]="articleItems()"
            (cdkDropListDropped)="onDrop($event, 'articles')"
          >
            @for (item of articleItems(); track item.id) {
              <div
                class="list-item"
                cdkDrag
                [cdkDragData]="item"
                [class.selected]="selectedId() === item.id"
                [class.multi-selected]="isMultiSelected(item.id)"
                (click)="onItemClick($event, item)"
                (contextmenu)="onContextMenu($event, item)"
              >
                <div class="drag-handle" cdkDragHandle>
                  <span class="drag-icon">\u2630</span>
                </div>
                <div class="item-icon">\uD83D\uDCC4</div>
                <div class="item-content">
                  <div class="item-title">{{ item.title || 'Untitled' }}</div>
                  <div class="item-meta">
                    <span class="status-badge" [class]="item.status">{{ item.status }}</span>
                    @if (item.targetLang) {
                      <span class="lang-badge">{{ item.targetLang | uppercase }}</span>
                    }
                  </div>
                </div>
                @if (item.audiobookPath) {
                  <button class="btn-play-item" (click)="onPlayClick($event, item)" title="Play audiobook">\u25B6</button>
                }
              </div>
            } @empty {
              <div class="empty-section">
                <p>No articles yet</p>
              </div>
            }
          </div>
        }
      </div>

      <!-- Books Accordion -->
      <div class="accordion-section">
        <button
          class="accordion-header"
          [class.expanded]="booksExpanded()"
          (click)="booksExpanded.set(!booksExpanded())"
        >
          <span class="accordion-icon">{{ booksExpanded() ? '\u25BC' : '\u25B6' }}</span>
          <span class="accordion-title">Books</span>
          <span class="accordion-count">({{ books().length }})</span>
        </button>

        @if (booksExpanded()) {
          <div
            class="accordion-content"
            cdkDropList
            [cdkDropListData]="bookItems()"
            (cdkDropListDropped)="onDrop($event, 'books')"
          >
            @for (item of bookItems(); track item.id) {
              <div
                class="list-item"
                cdkDrag
                [cdkDragData]="item"
                [class.selected]="selectedId() === item.id"
                [class.multi-selected]="isMultiSelected(item.id)"
                (click)="onItemClick($event, item)"
                (contextmenu)="onContextMenu($event, item)"
              >
                <div class="drag-handle" cdkDragHandle>
                  <span class="drag-icon">\u2630</span>
                </div>
                <div class="item-cover">
                  @if (item.coverData) {
                    <img [src]="item.coverData" alt="">
                  } @else {
                    <div class="cover-placeholder">\uD83D\uDCDA</div>
                  }
                </div>
                <div class="item-content">
                  <div class="item-title">{{ item.title || 'Untitled' }}</div>
                  <div class="item-meta">
                    <span class="status-badge" [class]="item.status">{{ item.status }}</span>
                    @if (item.author) {
                      <span class="author">{{ item.author }}</span>
                    }
                  </div>
                </div>
                @if (item.audiobookPath) {
                  <button class="btn-play-item" (click)="onPlayClick($event, item)" title="Play audiobook">\u25B6</button>
                }
              </div>
            } @empty {
              <div class="empty-section">
                <p>No books yet</p>
              </div>
            }
          </div>
        }
      </div>

      <!-- Archived Accordion -->
      <div class="accordion-section">
        <button
          class="accordion-header"
          [class.expanded]="archivedExpanded()"
          (click)="archivedExpanded.set(!archivedExpanded())"
        >
          <span class="accordion-icon">{{ archivedExpanded() ? '\u25BC' : '\u25B6' }}</span>
          <span class="accordion-title">Archived</span>
          <span class="accordion-count">({{ archived().length }})</span>
        </button>

        @if (archivedExpanded()) {
          <div
            class="accordion-content"
            cdkDropList
            [cdkDropListData]="archivedItems()"
            (cdkDropListDropped)="onDrop($event, 'archived')"
          >
            @for (item of archivedItems(); track item.id) {
              <div
                class="list-item archived-item"
                cdkDrag
                [cdkDragData]="item"
                [class.selected]="selectedId() === item.id"
                [class.multi-selected]="isMultiSelected(item.id)"
                (click)="onItemClick($event, item)"
                (contextmenu)="onContextMenu($event, item)"
              >
                <div class="drag-handle" cdkDragHandle>
                  <span class="drag-icon">\u2630</span>
                </div>
                @if (item.type === 'book') {
                  <div class="item-cover">
                    @if (item.coverData) {
                      <img [src]="item.coverData" alt="">
                    } @else {
                      <div class="cover-placeholder">\uD83D\uDCDA</div>
                    }
                  </div>
                } @else {
                  <div class="item-icon">\uD83D\uDCC4</div>
                }
                <div class="item-content">
                  <div class="item-title">{{ item.title || 'Untitled' }}</div>
                  <div class="item-meta">
                    <span class="type-badge">{{ item.type }}</span>
                    @if (item.author) {
                      <span class="author">{{ item.author }}</span>
                    }
                  </div>
                </div>
              </div>
            } @empty {
              <div class="empty-section">
                <p>No archived items</p>
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .studio-list {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow-y: auto;
    }

    .accordion-section {
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .accordion-header {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 12px 16px;
      background: var(--bg-elevated);
      border: none;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.expanded {
        border-bottom: 1px solid var(--border-subtle);
      }
    }

    .accordion-icon {
      font-size: 10px;
      color: var(--text-secondary);
      width: 12px;
    }

    .accordion-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      flex: 1;
    }

    .accordion-count {
      font-size: 12px;
      color: var(--text-muted);
    }

    .accordion-content {
      background: var(--bg-surface);
      min-height: 24px;
    }

    .list-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      cursor: pointer;
      transition: background 0.15s ease;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: rgba(6, 182, 212, 0.12);
        border-left: 3px solid var(--accent);
        padding-left: 13px;
      }

      &.multi-selected {
        background: rgba(6, 182, 212, 0.08);
        border-left: 3px solid rgba(6, 182, 212, 0.5);
        padding-left: 13px;
      }

      &.selected.multi-selected {
        background: rgba(6, 182, 212, 0.16);
        border-left: 3px solid var(--accent);
      }

      &.archived-item {
        opacity: 0.7;
      }
    }

    .drag-handle {
      cursor: grab;
      display: flex;
      align-items: center;
      opacity: 0;
      transition: opacity 0.15s;
      flex-shrink: 0;
    }

    .list-item:hover .drag-handle {
      opacity: 0.5;
    }

    .drag-icon {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1;
    }

    .item-icon {
      font-size: 24px;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .item-cover {
      width: 36px;
      height: 48px;
      border-radius: 3px;
      overflow: hidden;
      flex-shrink: 0;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    }

    .cover-placeholder {
      width: 100%;
      height: 100%;
      background: var(--bg-elevated);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .item-content {
      flex: 1;
      min-width: 0;
    }

    .item-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
    }

    .item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }

    .status-badge {
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.5px;

      &.draft {
        background: var(--bg-elevated);
        color: var(--text-secondary);
      }

      &.ready {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      &.processing {
        background: rgba(234, 179, 8, 0.15);
        color: #eab308;
      }

      &.completed {
        background: rgba(6, 182, 212, 0.15);
        color: #06b6d4;
      }

      &.error {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }
    }

    .type-badge {
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--bg-elevated);
      color: var(--text-muted);
      font-weight: 500;
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.5px;
    }

    .lang-badge {
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(139, 92, 246, 0.15);
      color: #8b5cf6;
      font-weight: 600;
      font-size: 9px;
    }

    .author {
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .btn-play-item {
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 50%;
      background: var(--accent);
      color: white;
      font-size: 10px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.15s, transform 0.15s;

      &:hover {
        transform: scale(1.1);
      }
    }

    .list-item:hover .btn-play-item {
      opacity: 1;
    }

    .list-item.selected .btn-play-item {
      opacity: 1;
    }

    .empty-section {
      padding: 24px 16px;
      text-align: center;

      p {
        margin: 0;
        font-size: 13px;
        color: var(--text-muted);
      }
    }

    /* CDK drag-drop styles */
    .cdk-drag-preview {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .cdk-drag-placeholder {
      opacity: 0.3;
    }

    .cdk-drag-animating {
      transition: transform 200ms ease;
    }

    .cdk-drop-list-dragging .list-item:not(.cdk-drag-placeholder) {
      transition: transform 200ms ease;
    }
  `]
})
export class StudioListComponent {
  // Inputs
  readonly articles = input<StudioItem[]>([]);
  readonly books = input<StudioItem[]>([]);
  readonly archived = input<StudioItem[]>([]);
  readonly selectedId = input<string | null>(null);

  // Outputs
  readonly select = output<StudioItem>();
  readonly play = output<StudioItem>();
  readonly contextMenu = output<{ event: MouseEvent; item: StudioItem; selectedIds: string[] }>();
  readonly reorder = output<{ section: 'articles' | 'books' | 'archived'; orderedIds: string[] }>();
  readonly archive = output<string[]>();
  readonly unarchive = output<string[]>();

  // Multi-selection state
  private readonly _multiSelectedIds = signal<Set<string>>(new Set());
  private lastClickedId: string | null = null;

  readonly multiSelectedIds = computed(() => this._multiSelectedIds());

  // State — mutable copies for drag/drop
  readonly articleItems = signal<StudioItem[]>([]);
  readonly bookItems = signal<StudioItem[]>([]);
  readonly archivedItems = signal<StudioItem[]>([]);
  readonly articlesExpanded = signal<boolean>(true);
  readonly booksExpanded = signal<boolean>(true);
  readonly archivedExpanded = signal<boolean>(false);

  /** All items in display order (for shift-click range selection) */
  private readonly allItems = computed(() => [
    ...this.articleItems(),
    ...this.bookItems(),
    ...this.archivedItems(),
  ]);

  ngOnChanges(): void {
    this.articleItems.set([...this.articles()]);
    this.bookItems.set([...this.books()]);
    this.archivedItems.set([...this.archived()]);
  }

  isMultiSelected(id: string): boolean {
    return this._multiSelectedIds().has(id);
  }

  /** Get the IDs that are currently part of the multi-selection (or just the given id if none) */
  getEffectiveSelection(itemId: string): string[] {
    const sel = this._multiSelectedIds();
    if (sel.size > 0 && sel.has(itemId)) {
      return [...sel];
    }
    return [itemId];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Click handling (single, Cmd/Ctrl+Click, Shift+Click)
  // ─────────────────────────────────────────────────────────────────────────

  onItemClick(event: MouseEvent, item: StudioItem): void {
    const metaKey = event.metaKey || event.ctrlKey;
    const shiftKey = event.shiftKey;

    if (metaKey) {
      // Toggle item in multi-selection
      this._multiSelectedIds.update(set => {
        const next = new Set(set);
        if (next.has(item.id)) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      this.lastClickedId = item.id;
    } else if (shiftKey && this.lastClickedId) {
      // Range select from lastClickedId to item.id
      const all = this.allItems();
      const lastIdx = all.findIndex(i => i.id === this.lastClickedId);
      const curIdx = all.findIndex(i => i.id === item.id);
      if (lastIdx !== -1 && curIdx !== -1) {
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        const rangeIds = all.slice(start, end + 1).map(i => i.id);
        this._multiSelectedIds.update(set => {
          const next = new Set(set);
          for (const id of rangeIds) next.add(id);
          return next;
        });
      }
    } else {
      // Normal click: clear multi-selection, select single item
      this._multiSelectedIds.set(new Set());
      this.lastClickedId = item.id;
      this.select.emit(item);
    }
  }

  clearMultiSelection(): void {
    this._multiSelectedIds.set(new Set());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Drag/Drop
  // ─────────────────────────────────────────────────────────────────────────

  onDrop(event: CdkDragDrop<StudioItem[]>, targetSection: 'articles' | 'books' | 'archived'): void {
    const item: StudioItem = event.item.data;
    const sourceSection = this.getSectionForContainer(event.previousContainer);
    const draggedIds = this.getEffectiveSelection(item.id);

    if (event.previousContainer === event.container) {
      // Reorder within same list
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
      this.reorder.emit({ section: targetSection, orderedIds: event.container.data.map(i => i.id) });
    } else {
      // Transfer between lists — handle multi-select
      if (draggedIds.length > 1) {
        // Remove all selected items from source
        const selectedSet = new Set(draggedIds);
        const removedItems = event.previousContainer.data.filter(i => selectedSet.has(i.id));
        event.previousContainer.data.splice(0, event.previousContainer.data.length,
          ...event.previousContainer.data.filter(i => !selectedSet.has(i.id)));
        // Insert at drop position
        event.container.data.splice(event.currentIndex, 0, ...removedItems);
      } else {
        transferArrayItem(
          event.previousContainer.data,
          event.container.data,
          event.previousIndex,
          event.currentIndex
        );
      }

      if (targetSection === 'archived') {
        this.archive.emit(draggedIds);
      } else if (sourceSection === 'archived') {
        this.unarchive.emit(draggedIds);
      }

      this.reorder.emit({ section: sourceSection, orderedIds: event.previousContainer.data.map(i => i.id) });
      this.reorder.emit({ section: targetSection, orderedIds: event.container.data.map(i => i.id) });
      this._multiSelectedIds.set(new Set());
    }
  }

  private getSectionForContainer(container: any): 'articles' | 'books' | 'archived' {
    const data = container.data as StudioItem[];
    if (data === this.articleItems()) return 'articles';
    if (data === this.bookItems()) return 'books';
    return 'archived';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Other events
  // ─────────────────────────────────────────────────────────────────────────

  onPlayClick(event: MouseEvent, item: StudioItem): void {
    event.stopPropagation();
    this.play.emit(item);
  }

  onContextMenu(event: MouseEvent, item: StudioItem): void {
    event.preventDefault();
    // If right-clicking a non-selected item, make it the only selection
    const sel = this._multiSelectedIds();
    if (sel.size > 0 && !sel.has(item.id)) {
      this._multiSelectedIds.set(new Set());
    }
    const selectedIds = this.getEffectiveSelection(item.id);
    this.contextMenu.emit({ event, item, selectedIds });
  }
}

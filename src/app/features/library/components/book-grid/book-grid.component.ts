import { Component, inject, output, signal, computed, ElementRef, viewChild, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EbookLibraryService } from '../../services/ebook-library.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { BookCardComponent } from '../book-card/book-card.component';
import type { LibraryBook } from '../../models/library.types';

@Component({
  selector: 'app-book-grid',
  standalone: true,
  imports: [CommonModule, FormsModule, BookCardComponent],
  template: `
    <div class="grid-container" #gridContainer>
      <!-- Toolbar -->
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="search-box">
            <span class="search-icon">\u{1F50D}</span>
            <input
              type="text"
              placeholder="Search books..."
              [ngModel]="libraryService.searchQuery()"
              (ngModelChange)="libraryService.setSearchQuery($event)"
              class="search-input"
            />
            @if (libraryService.searchQuery()) {
              <button class="clear-btn" (click)="libraryService.setSearchQuery('')">x</button>
            }
          </div>
          <span class="book-count">{{ libraryService.filteredBooks().length }} books</span>
        </div>
        <div class="toolbar-right">
          <!-- Format filter -->
          @if (libraryService.availableFormats().length > 1) {
            <select
              class="toolbar-select"
              [ngModel]="selectedFormat"
              (ngModelChange)="onFormatChange($event)"
            >
              <option value="">All formats</option>
              @for (fmt of libraryService.availableFormats(); track fmt) {
                <option [value]="fmt">{{ fmt.toUpperCase() }}</option>
              }
            </select>
          }

          <!-- Sort -->
          <select
            class="toolbar-select"
            [ngModel]="libraryService.sortBy()"
            (ngModelChange)="libraryService.setSortBy($event)"
          >
            <option value="title">Title</option>
            <option value="author">Author</option>
            <option value="year">Year</option>
            <option value="dateAdded">Date Added</option>
          </select>
        </div>
      </div>

      <!-- Grid -->
      @if (libraryService.filteredBooks().length > 0) {
        <div
          class="book-grid"
          #bookGrid
          (mousedown)="onMarqueeStart($event)"
          (contextmenu)="onBookContextMenu($event)"
        >
          @for (book of libraryService.filteredBooks(); track book.relativePath) {
            <app-book-card
              [book]="book"
              [selected]="libraryService.selectedBooks().has(book.relativePath)"
              [attr.data-path]="book.relativePath"
              (cardClicked)="onCardClick($event)"
              (cardDoubleClicked)="bookDoubleClicked.emit($event)"
            />
          }
        </div>
      } @else if (libraryService.loading()) {
        <div class="empty-state">
          <div class="empty-icon">\u{23F3}</div>
          <div class="empty-text">Scanning library...</div>
        </div>
      } @else if (libraryService.searchQuery()) {
        <div class="empty-state">
          <div class="empty-icon">\u{1F50D}</div>
          <div class="empty-text">No books match "{{ libraryService.searchQuery() }}"</div>
        </div>
      } @else {
        <div class="empty-state">
          <div class="empty-icon">\u{1F4DA}</div>
          <div class="empty-text">Drop ebooks here to add them</div>
          <div class="empty-subtext">Supports EPUB, PDF, AZW3, MOBI, FB2, and more</div>
        </div>
      }

      <!-- Book context menu -->
      @if (bookContextMenuVisible()) {
        <div
          class="context-menu"
          [style.top.px]="bookContextMenuY()"
          [style.left.px]="bookContextMenuX()"
          (mousedown)="$event.stopPropagation()"
          (click)="$event.stopPropagation()"
        >
          <button class="ctx-item" (click)="revealBook()">Open</button>
          @if (libraryService.categories().length > 0) {
            <div class="ctx-separator"></div>
            <div class="ctx-label">Move to</div>
            @for (cat of libraryService.categories(); track cat.name) {
              <button class="ctx-item" (click)="moveToCategory(cat.name)">{{ cat.name }}</button>
            }
          }
          <div class="ctx-separator"></div>
          <button class="ctx-item ctx-danger" (click)="removeBook()">Remove</button>
        </div>
      }

      <!-- Marquee rectangle: always in DOM, toggled via class -->
      <div
        class="selection-rect"
        [class.active]="isDragSelecting()"
        [style.left.px]="marqueeLeft()"
        [style.top.px]="marqueeTop()"
        [style.width.px]="marqueeWidth()"
        [style.height.px]="marqueeHeight()"
      ></div>
    </div>
  `,
  host: {
    style: 'flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;',
    '(document:click)': 'closeBookContextMenu()',
  },
  styles: [`
    .grid-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      position: relative;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
      gap: 8px;
      flex-shrink: 0;
    }

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .search-box {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 4px 8px;
      min-width: 200px;
    }

    .search-icon {
      font-size: 0.8rem;
      opacity: 0.5;
    }

    .search-input {
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 0.8rem;
      outline: none;
      flex: 1;
      min-width: 0;
    }

    .clear-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 0.8rem;
      padding: 0 2px;
      line-height: 1;
    }

    .book-count {
      font-size: 0.75rem;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .toolbar-select {
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 0.75rem;
      padding: 4px 8px;
      cursor: pointer;
    }

    .book-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 12px;
      overflow-y: auto;
      flex: 1;
      align-content: flex-start;
      user-select: none;
    }

    .selection-rect {
      position: absolute;
      border: 2px solid #06b6d4;
      background: rgba(6, 182, 212, 0.12);
      pointer-events: none;
      z-index: 1000;
    }

    .selection-rect:not(.active) {
      display: none;
    }

    .context-menu {
      position: fixed;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 1001;
      overflow: hidden;
      min-width: 120px;
    }

    .ctx-item {
      display: block;
      width: 100%;
      padding: 6px 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: var(--text-primary);
      font-size: 0.8rem;
      text-align: left;
    }

    .ctx-item:hover {
      background: var(--bg-hover);
    }

    .ctx-danger {
      color: var(--accent-danger);
    }

    .ctx-separator {
      height: 1px;
      background: var(--border-default);
      margin: 4px 0;
    }

    .ctx-label {
      padding: 4px 12px 2px;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: var(--text-muted);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: 48px;
      text-align: center;
    }

    .empty-icon {
      font-size: 3rem;
      margin-bottom: 12px;
      opacity: 0.4;
    }

    .empty-text {
      font-size: 1rem;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    .empty-subtext {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
  `]
})
export class BookGridComponent implements OnDestroy {
  readonly libraryService = inject(EbookLibraryService);
  private readonly electronService = inject(ElectronService);
  private readonly cdr = inject(ChangeDetectorRef);
  readonly bookDoubleClicked = output<LibraryBook>();
  readonly gridContainerRef = viewChild<ElementRef<HTMLElement>>('gridContainer');
  readonly bookGridRef = viewChild<ElementRef<HTMLElement>>('bookGrid');

  selectedFormat = '';

  // Book context menu
  bookContextMenuVisible = signal(false);
  bookContextMenuX = signal(0);
  bookContextMenuY = signal(0);
  private contextMenuBookPath: string | null = null;

  // Marquee signals
  isDragSelecting = signal(false);
  private readonly startX = signal(0);
  private readonly startY = signal(0);
  private readonly currentX = signal(0);
  private readonly currentY = signal(0);

  marqueeLeft = computed(() => Math.min(this.startX(), this.currentX()));
  marqueeTop = computed(() => Math.min(this.startY(), this.currentY()));
  marqueeWidth = computed(() => Math.abs(this.currentX() - this.startX()));
  marqueeHeight = computed(() => Math.abs(this.currentY() - this.startY()));

  // Private drag state
  private dragSelectionInitialSelected = new Set<string>();
  private readonly dragMinDistance = 5;
  private dragHasMoved = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private justFinishedDrag = false;
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollSpeed = 0;
  private readonly AUTO_SCROLL_ZONE = 50;
  private readonly AUTO_SCROLL_MAX_SPEED = 15;

  ngOnDestroy(): void {
    this.stopAutoScroll();
    document.removeEventListener('mousemove', this.onMarqueeMove);
    document.removeEventListener('mouseup', this.onMarqueeEnd);
  }

  onCardClick(data: { book: LibraryBook; event: MouseEvent }): void {
    if (this.justFinishedDrag) return;

    const additive = data.event.metaKey || data.event.ctrlKey || data.event.shiftKey;
    this.libraryService.toggleBookSelection(data.book.relativePath, additive);
  }

  onFormatChange(format: string): void {
    this.selectedFormat = format;
    this.libraryService.setFormatFilter(format ? [format] : []);
  }

  // --- Book Context Menu ---

  onBookContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const cardEl = target.closest('app-book-card');
    if (!cardEl) return;

    event.preventDefault();
    const path = cardEl.getAttribute('data-path');
    if (!path) return;

    this.contextMenuBookPath = path;
    this.bookContextMenuX.set(event.clientX);
    this.bookContextMenuY.set(event.clientY);
    this.bookContextMenuVisible.set(true);

    // Select the book if not already selected
    if (!this.libraryService.selectedBooks().has(path)) {
      this.libraryService.toggleBookSelection(path, false);
    }
  }

  closeBookContextMenu(): void {
    this.bookContextMenuVisible.set(false);
  }

  revealBook(): void {
    this.bookContextMenuVisible.set(false);
    if (this.contextMenuBookPath) {
      this.electronService.ebookLibraryRevealBook(this.contextMenuBookPath);
    }
  }

  async removeBook(): Promise<void> {
    this.bookContextMenuVisible.set(false);
    const selected = this.libraryService.selectedBooks();
    if (selected.size > 0) {
      for (const path of selected) {
        await this.libraryService.removeBook(path);
      }
    } else if (this.contextMenuBookPath) {
      await this.libraryService.removeBook(this.contextMenuBookPath);
    }
  }

  async moveToCategory(category: string): Promise<void> {
    this.bookContextMenuVisible.set(false);
    const selected = this.libraryService.selectedBooks();
    if (selected.size > 0) {
      await this.libraryService.moveBooks([...selected], category);
    } else if (this.contextMenuBookPath) {
      await this.libraryService.moveBooks([this.contextMenuBookPath], category);
    }
  }

  // --- Marquee Selection ---

  onMarqueeStart(event: MouseEvent): void {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('select') || target.closest('.toolbar')) return;

    // If clicking on an already-selected card, allow native drag (for drag-to-category)
    const cardEl = target.closest('app-book-card');
    if (cardEl) {
      const path = cardEl.getAttribute('data-path');
      if (path && this.libraryService.selectedBooks().has(path)) {
        return;
      }
    }

    // Prevent native HTML drag so mousemove fires instead of dragstart
    event.preventDefault();

    this.dragStartClientX = event.clientX;
    this.dragStartClientY = event.clientY;
    this.dragHasMoved = false;

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      this.dragSelectionInitialSelected = new Set(this.libraryService.selectedBooks());
    } else {
      this.dragSelectionInitialSelected = new Set();
    }

    const container = this.gridContainerRef()?.nativeElement;
    if (!container) return;

    const cr = container.getBoundingClientRect();
    const x = event.clientX - cr.left;
    const y = event.clientY - cr.top;

    this.startX.set(x);
    this.startY.set(y);
    this.currentX.set(x);
    this.currentY.set(y);

    document.addEventListener('mousemove', this.onMarqueeMove);
    document.addEventListener('mouseup', this.onMarqueeEnd);
  }

  private onMarqueeMove = (event: MouseEvent): void => {
    const dx = event.clientX - this.dragStartClientX;
    const dy = event.clientY - this.dragStartClientY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (!this.dragHasMoved && distance >= this.dragMinDistance) {
      this.dragHasMoved = true;
      this.isDragSelecting.set(true);

      if (this.dragSelectionInitialSelected.size === 0) {
        this.libraryService.setSelectedBooks(new Set());
      }

      this.startAutoScroll();
    }

    if (!this.dragHasMoved) return;

    const container = this.gridContainerRef()?.nativeElement;
    if (!container) return;

    const cr = container.getBoundingClientRect();
    this.currentX.set(event.clientX - cr.left);
    this.currentY.set(event.clientY - cr.top);

    // Auto-scroll speed based on cursor distance from grid edges
    const grid = this.bookGridRef()?.nativeElement;
    if (grid) {
      const gridRect = grid.getBoundingClientRect();
      if (event.clientY < gridRect.top + this.AUTO_SCROLL_ZONE) {
        const distanceFromEdge = gridRect.top + this.AUTO_SCROLL_ZONE - event.clientY;
        this.autoScrollSpeed = -Math.min(distanceFromEdge / 2, this.AUTO_SCROLL_MAX_SPEED);
      } else if (event.clientY > gridRect.bottom - this.AUTO_SCROLL_ZONE) {
        const distanceFromEdge = event.clientY - (gridRect.bottom - this.AUTO_SCROLL_ZONE);
        this.autoScrollSpeed = Math.min(distanceFromEdge / 2, this.AUTO_SCROLL_MAX_SPEED);
      } else {
        this.autoScrollSpeed = 0;
      }
    }

    this.updateMarqueeSelection();
    this.cdr.detectChanges();
  };

  private onMarqueeEnd = (event: MouseEvent): void => {
    const wasDragging = this.dragHasMoved;

    this.stopAutoScroll();
    this.isDragSelecting.set(false);
    this.dragSelectionInitialSelected = new Set();
    this.dragHasMoved = false;

    if (wasDragging) {
      this.justFinishedDrag = true;
      setTimeout(() => { this.justFinishedDrag = false; }, 0);
    } else {
      // Simple click (no drag) on empty space — deselect all
      const target = event.target as HTMLElement;
      if (!target.closest('app-book-card')) {
        this.libraryService.setSelectedBooks(new Set());
      }
    }

    document.removeEventListener('mousemove', this.onMarqueeMove);
    document.removeEventListener('mouseup', this.onMarqueeEnd);
    this.cdr.detectChanges();
  };

  private startAutoScroll(): void {
    if (this.autoScrollInterval) return;

    this.autoScrollInterval = setInterval(() => {
      if (this.autoScrollSpeed === 0) return;

      const grid = this.bookGridRef()?.nativeElement;
      if (!grid) return;

      grid.scrollTop = Math.max(0, grid.scrollTop + this.autoScrollSpeed);

      // Extend start point opposite to scroll so the rect grows visually
      this.startY.update(y => y - this.autoScrollSpeed);
      this.updateMarqueeSelection();
      this.cdr.detectChanges();
    }, 16);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollInterval) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
    this.autoScrollSpeed = 0;
  }

  private updateMarqueeSelection(): void {
    const container = this.gridContainerRef()?.nativeElement;
    const grid = this.bookGridRef()?.nativeElement;
    if (!container || !grid) return;

    // Convert marquee from container-relative to viewport coordinates
    const cr = container.getBoundingClientRect();
    const selLeft = cr.left + this.marqueeLeft();
    const selTop = cr.top + this.marqueeTop();
    const selRight = selLeft + this.marqueeWidth();
    const selBottom = selTop + this.marqueeHeight();

    const newSelection = new Set(this.dragSelectionInitialSelected);

    const cards = grid.querySelectorAll('app-book-card');
    cards.forEach((card: Element) => {
      const cardRect = card.getBoundingClientRect();

      const intersects =
        cardRect.right > selLeft &&
        cardRect.left < selRight &&
        cardRect.bottom > selTop &&
        cardRect.top < selBottom;

      if (intersects) {
        const path = card.getAttribute('data-path');
        if (path) {
          if (this.dragSelectionInitialSelected.has(path)) {
            newSelection.delete(path);
          } else {
            newSelection.add(path);
          }
        }
      }
    });

    this.libraryService.setSelectedBooks(newSelection);
  }
}

import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EbookLibraryService } from '../../services/ebook-library.service';
import { ElectronService } from '../../../../core/services/electron.service';

@Component({
  selector: 'app-category-sidebar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="sidebar">
      <div class="sidebar-header">Categories</div>

      <!-- All Books -->
      <button
        class="category-item"
        [class.active]="libraryService.activeCategory() === 'All Books'"
        (click)="libraryService.setActiveCategory('All Books')"
        (contextmenu)="onAllBooksContextMenu($event)"
      >
        <span class="cat-name">All Books</span>
        <span class="cat-count">{{ libraryService.bookCount() }}</span>
      </button>

      <div class="category-divider"></div>

      <!-- Category list -->
      @for (cat of libraryService.categories(); track cat.name) {
        <button
          class="category-item"
          [class.active]="libraryService.activeCategory() === cat.name"
          (click)="libraryService.setActiveCategory(cat.name)"
          (contextmenu)="onContextMenu($event, cat.name)"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event, cat.name)"
          [class.drag-over]="dragOverCategory === cat.name"
        >
          @if (editingCategory === cat.name) {
            <input
              class="rename-input"
              [ngModel]="editingName"
              (ngModelChange)="editingName = $event"
              (blur)="finishRename()"
              (keydown.enter)="finishRename()"
              (keydown.escape)="cancelRename()"
              (click)="$event.stopPropagation()"
              #renameInput
            />
          } @else {
            <span class="cat-name">{{ cat.name }}</span>
            <span class="cat-count">{{ cat.bookCount }}</span>
          }
        </button>
      }

      <!-- Add new category -->
      @if (isCreating()) {
        <div class="category-item new-category">
          <input
            class="rename-input"
            [(ngModel)]="newCategoryName"
            (blur)="finishCreate()"
            (keydown.enter)="finishCreate()"
            (keydown.escape)="cancelCreate()"
            placeholder="Category name"
            #createInput
          />
        </div>
      } @else {
        <button class="category-item add-btn" (click)="startCreate()">
          <span class="cat-name">+ New Category</span>
        </button>
      }

      <!-- Context menu -->
      @if (contextMenuVisible) {
        <div
          class="context-menu"
          [style.top.px]="contextMenuY"
          [style.left.px]="contextMenuX"
        >
          <button class="ctx-item" (click)="openCategoryFolder()">Open</button>
          @if (contextMenuCategory !== 'Uncategorized') {
            <button class="ctx-item" (click)="startRename()">Rename</button>
            <button class="ctx-item ctx-danger" (click)="deleteCategory()">Delete</button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .sidebar {
      width: 180px;
      min-width: 180px;
      border-right: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
      padding: 8px 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .sidebar-header {
      padding: 4px 12px 8px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .category-divider {
      height: 1px;
      background: var(--border-default);
      margin: 4px 12px;
    }

    .category-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 6px 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 0.8rem;
      text-align: left;
      transition: all 0.1s ease;
      border-left: 3px solid transparent;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
        color: var(--accent-primary);
        border-left-color: var(--accent-primary);
        font-weight: 500;
      }

      &.drag-over {
        background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
        border-left-color: var(--accent-primary);
      }
    }

    .cat-count {
      font-size: 0.7rem;
      color: var(--text-muted);
      background: var(--bg-elevated);
      padding: 0 6px;
      border-radius: 8px;
      min-width: 20px;
      text-align: center;
    }

    .add-btn {
      color: var(--text-muted);
      margin-top: 4px;

      &:hover {
        color: var(--accent-primary);
      }
    }

    .rename-input {
      width: 100%;
      border: 1px solid var(--accent-primary);
      border-radius: 4px;
      background: var(--bg-default);
      color: var(--text-primary);
      font-size: 0.8rem;
      padding: 2px 6px;
      outline: none;
    }

    .context-menu {
      position: fixed;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 1000;
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

      &:hover {
        background: var(--bg-hover);
      }
    }

    .ctx-danger {
      color: var(--accent-danger);
    }
  `],
  host: {
    '(document:click)': 'closeContextMenu()',
  }
})
export class CategorySidebarComponent {
  readonly libraryService = inject(EbookLibraryService);
  private readonly electronService = inject(ElectronService);

  isCreating = signal(false);
  newCategoryName = '';

  editingCategory: string | null = null;
  editingName = '';

  contextMenuVisible = false;
  contextMenuX = 0;
  contextMenuY = 0;
  contextMenuCategory = '';

  dragOverCategory: string | null = null;

  startCreate(): void {
    this.isCreating.set(true);
    this.newCategoryName = '';
    setTimeout(() => {
      const input = document.querySelector('.new-category input') as HTMLInputElement;
      input?.focus();
    });
  }

  async finishCreate(): Promise<void> {
    const name = this.newCategoryName.trim();
    this.isCreating.set(false);
    if (name) {
      await this.libraryService.createCategory(name);
    }
  }

  cancelCreate(): void {
    this.isCreating.set(false);
  }

  onContextMenu(event: MouseEvent, categoryName: string): void {
    event.preventDefault();
    this.contextMenuVisible = true;
    this.contextMenuX = event.clientX;
    this.contextMenuY = event.clientY;
    this.contextMenuCategory = categoryName;
  }

  closeContextMenu(): void {
    this.contextMenuVisible = false;
  }

  startRename(): void {
    this.editingCategory = this.contextMenuCategory;
    this.editingName = this.contextMenuCategory;
    this.contextMenuVisible = false;
    setTimeout(() => {
      const input = document.querySelector('.rename-input') as HTMLInputElement;
      input?.focus();
      input?.select();
    });
  }

  async finishRename(): Promise<void> {
    const oldName = this.editingCategory;
    const newName = this.editingName.trim();
    this.editingCategory = null;

    if (oldName && newName && newName !== oldName) {
      await this.libraryService.renameCategory(oldName, newName);
    }
  }

  cancelRename(): void {
    this.editingCategory = null;
  }

  async deleteCategory(): Promise<void> {
    const name = this.contextMenuCategory;
    this.contextMenuVisible = false;
    if (name) {
      await this.libraryService.deleteCategory(name);
    }
  }

  openCategoryFolder(): void {
    const name = this.contextMenuCategory;
    this.contextMenuVisible = false;
    if (name) {
      this.electronService.ebookLibraryOpenCategoryFolder(name);
    }
  }

  onAllBooksContextMenu(event: MouseEvent): void {
    event.preventDefault();
    // Open the ebooks root folder
    this.electronService.ebookLibraryOpenCategoryFolder('');
  }

  onDragOver(event: DragEvent): void {
    const hasEbook = event.dataTransfer?.types.includes('application/x-ebook-path');
    if (hasEbook) {
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      const catName = target.textContent?.trim().replace(/\d+$/, '').trim();
      this.dragOverCategory = catName || null;
    }
  }

  onDragLeave(_event: DragEvent): void {
    this.dragOverCategory = null;
  }

  async onDrop(event: DragEvent, categoryName: string): Promise<void> {
    event.preventDefault();
    this.dragOverCategory = null;

    const bookPath = event.dataTransfer?.getData('application/x-ebook-path');
    if (bookPath) {
      await this.libraryService.moveBooks([bookPath], categoryName);
    }
  }
}

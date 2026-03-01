import { Component, inject, signal, computed, effect, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EbookLibraryService } from '../../services/ebook-library.service';

@Component({
  selector: 'app-book-metadata',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (libraryService.selectedBook(); as book) {
      <div class="metadata-panel" (paste)="onPaste($event)" tabindex="0">
        <div class="panel-header">Metadata</div>

        <!-- Cover -->
        <div class="cover-section">
          @if (coverPreview() || book.coverData) {
            <img [src]="coverPreview() || book.coverData" class="panel-cover" alt="Cover" />
          } @else {
            <div class="cover-empty">
              <div>No cover</div>
              <div class="cover-hint">Cmd+V to paste</div>
            </div>
          }
        </div>

        <!-- Form -->
        <div class="form-fields">
          <label class="field">
            <span class="field-label">Title</span>
            <input class="field-input" [(ngModel)]="editTitle" />
          </label>

          <label class="field">
            <span class="field-label">Subtitle</span>
            <input class="field-input" [(ngModel)]="editSubtitle" placeholder="Optional" />
          </label>

          <label class="field">
            <span class="field-label">Author Last</span>
            <input class="field-input" [(ngModel)]="editAuthorLast" />
          </label>
          <label class="field">
            <span class="field-label">Author First</span>
            <input class="field-input" [(ngModel)]="editAuthorFirst" />
          </label>

          <label class="field">
            <span class="field-label">Year</span>
            <input class="field-input" type="number" [(ngModel)]="editYear" />
          </label>
          <label class="field">
            <span class="field-label">Language</span>
            <input class="field-input" [(ngModel)]="editLanguage" placeholder="eng" />
          </label>

          <label class="field">
            <span class="field-label">Category</span>
            <select class="field-input" [(ngModel)]="editCategory">
              @for (cat of libraryService.categories(); track cat.name) {
                <option [value]="cat.name">{{ cat.name }}</option>
              }
            </select>
          </label>

          <div class="field">
            <span class="field-label">File</span>
            <div class="field-static">{{ book.filename }}</div>
          </div>

          <div class="field">
            <span class="field-label">Format</span>
            <div class="field-static format-badge">{{ book.format.toUpperCase() }}</div>
          </div>

          <div class="field">
            <span class="field-label">Size</span>
            <div class="field-static">{{ formatSize(book.fileSize) }}</div>
          </div>
        </div>

        <!-- Actions -->
        <div class="actions">
          @if (!libraryService.ebookMetaAvailable()) {
            <div class="calibre-warning">
              Install Calibre to enable metadata editing
            </div>
          }

          <button
            class="btn btn-primary"
            (click)="save()"
            [disabled]="saving() || !libraryService.ebookMetaAvailable()"
          >
            {{ saving() ? 'Saving...' : 'Save' }}
          </button>

          <button class="btn btn-default" (click)="importToStudio()">
            Import to Studio
          </button>

          <button class="btn btn-danger" (click)="remove()">
            Remove
          </button>
        </div>
      </div>
    } @else {
      <div class="metadata-panel empty">
        <div class="empty-hint">Select a book to view details</div>
      </div>
    }
  `,
  styles: [`
    .metadata-panel {
      width: 260px;
      min-width: 260px;
      border-left: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
      padding: 12px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      outline: none;

      &.empty {
        display: flex;
        align-items: center;
        justify-content: center;
      }
    }

    .panel-header {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .cover-section {
      width: 100%;
      aspect-ratio: 2/3;
      max-height: 260px;
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-elevated);
    }

    .panel-cover {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .cover-empty {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    .cover-hint {
      font-size: 0.65rem;
      margin-top: 4px;
      opacity: 0.6;
    }

    .form-fields {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .field-row {
      display: flex;
      gap: 8px;
    }

    .flex-1 {
      flex: 1;
    }

    .field-label {
      font-size: 0.65rem;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .field-input {
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      color: var(--text-primary);
      font-size: 0.8rem;
      padding: 4px 6px;
      outline: none;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;

      &:focus {
        border-color: var(--accent-primary);
      }
    }

    .field-static {
      font-size: 0.8rem;
      color: var(--text-secondary);
      word-break: break-all;
    }

    .format-badge {
      display: inline-block;
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.05em;
    }

    .empty-hint {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: auto;
      padding-top: 12px;
    }

    .calibre-warning {
      font-size: 0.7rem;
      color: var(--accent-warning, #f59e0b);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--accent-warning, #f59e0b) 10%, transparent);
      border-radius: 4px;
      text-align: center;
    }

    .btn {
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .btn-primary {
      background: var(--accent-primary);
      color: white;

      &:hover:not(:disabled) {
        filter: brightness(1.1);
      }
    }

    .btn-default {
      background: var(--bg-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-default);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .btn-danger {
      background: transparent;
      color: var(--accent-danger);
      border: 1px solid var(--accent-danger);

      &:hover {
        background: color-mix(in srgb, var(--accent-danger) 10%, transparent);
      }
    }
  `]
})
export class BookMetadataComponent {
  readonly libraryService = inject(EbookLibraryService);
  readonly importCompleted = output<{ success: boolean; title: string }>();

  editTitle = '';
  editSubtitle = '';
  editAuthorFirst = '';
  editAuthorLast = '';
  editYear: number | null = null;
  editLanguage = '';
  editCategory = '';

  saving = signal(false);
  coverPreview = signal<string | null>(null);
  private pendingCoverData: string | null = null;

  constructor() {
    // Sync form fields when selected book changes
    effect(() => {
      const book = this.libraryService.selectedBook();
      if (book) {
        this.editTitle = book.title || '';
        this.editSubtitle = book.subtitle || '';
        this.editAuthorFirst = book.authorFirst || '';
        this.editAuthorLast = book.authorLast || '';
        this.editYear = book.year || null;
        this.editLanguage = book.language || '';
        this.editCategory = book.category || 'Uncategorized';
        this.coverPreview.set(null);
        this.pendingCoverData = null;

        // Load cover if not already loaded
        if (!book.coverData) {
          this.loadCover(book.relativePath);
        }
      }
    });
  }

  private async loadCover(relativePath: string): Promise<void> {
    const coverData = await this.libraryService.getCover(relativePath);
    if (coverData && this.libraryService.selectedBook()?.relativePath === relativePath) {
      // Update the book's coverData in the service state
      this.coverPreview.set(coverData);
    }
  }

  async onPaste(event: ClipboardEvent): Promise<void> {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          this.coverPreview.set(dataUrl);
          this.pendingCoverData = dataUrl;
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  }

  async save(): Promise<void> {
    const book = this.libraryService.selectedBook();
    if (!book) return;

    this.saving.set(true);
    try {
      // Save metadata to file (may rename the file, changing relativePath)
      const updated = await this.libraryService.updateMetadata(book.relativePath, {
        title: this.editTitle,
        subtitle: this.editSubtitle || undefined,
        authorFirst: this.editAuthorFirst || undefined,
        authorLast: this.editAuthorLast || undefined,
        authorFull: this.editAuthorLast
          ? (this.editAuthorFirst ? `${this.editAuthorLast}, ${this.editAuthorFirst}` : this.editAuthorLast)
          : undefined,
        year: this.editYear || undefined,
        language: this.editLanguage || undefined,
      });
      const currentPath = updated?.relativePath || book.relativePath;

      // Move to new category if changed
      if (this.editCategory !== book.category) {
        await this.libraryService.moveBooks([currentPath], this.editCategory);
      }

      // Save cover if pasted
      if (this.pendingCoverData) {
        // Re-read path in case moveBooks changed it
        const latestPath = this.libraryService.selectedBook()?.relativePath || currentPath;
        await this.libraryService.setCover(latestPath, this.pendingCoverData);
        this.pendingCoverData = null;
      }
    } finally {
      this.saving.set(false);
    }
  }

  async importToStudio(): Promise<void> {
    const book = this.libraryService.selectedBook();
    if (!book) return;
    const result = await this.libraryService.importToStudio(book.relativePath);
    this.importCompleted.emit(result);
  }

  async remove(): Promise<void> {
    const book = this.libraryService.selectedBook();
    if (!book) return;
    await this.libraryService.removeBook(book.relativePath);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

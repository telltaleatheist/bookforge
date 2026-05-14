import { Component, inject, signal, computed, effect, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EbookLibraryService } from '../../services/ebook-library.service';
import type { LibraryBook } from '../../models/library.types';

@Component({
  selector: 'app-book-metadata',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (libraryService.selectedBook(); as book) {
      <div class="metadata-panel" (paste)="onPaste($event)" tabindex="0">
        <!-- Scrollable content -->
        <div class="panel-scroll">
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

          <!-- Tab bar -->
          <div class="meta-tabs">
            <button class="meta-tab" [class.active]="activeMetaTab() === 'details'" (click)="activeMetaTab.set('details')">Details</button>
            <button class="meta-tab" [class.active]="activeMetaTab() === 'tags'" (click)="activeMetaTab.set('tags')">Tags</button>
          </div>

          <!-- Details tab -->
          @if (activeMetaTab() === 'details') {
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

              <!-- Inline tags -->
              <div class="field">
                <span class="field-label">Tags</span>
                <div class="tag-editor" (click)="focusTagInput($event)">
                  @for (tag of book.tags || []; track tag) {
                    <span class="tag-pill">
                      {{ tag }}
                      <button class="tag-remove" (click)="removeTag(tag)">&times;</button>
                    </span>
                  }
                  <input
                    class="tag-input"
                    type="text"
                    [ngModel]="tagInput()"
                    (ngModelChange)="onTagInputChange($event)"
                    (keydown.enter)="addTag($event)"
                    (keydown.Comma)="addTag($event)"
                    (keydown.backspace)="onTagBackspace()"
                    placeholder="Add tag..."
                  />
                </div>
                @if (tagSuggestions().length > 0) {
                  <div class="tag-suggestions">
                    @for (s of tagSuggestions(); track s) {
                      <button class="tag-suggestion" (click)="selectSuggestion(s)">{{ s }}</button>
                    }
                  </div>
                }
              </div>
            </div>
          }

          <!-- Tags tab -->
          @if (activeMetaTab() === 'tags') {
            <div class="form-fields">
              <!-- Current book tags -->
              <div class="field">
                <span class="field-label">Book Tags</span>
                <div class="tag-editor" (click)="focusTagInput($event)">
                  @for (tag of book.tags || []; track tag) {
                    <span class="tag-pill">
                      {{ tag }}
                      <button class="tag-remove" (click)="removeTag(tag)">&times;</button>
                    </span>
                  }
                  <input
                    class="tag-input"
                    type="text"
                    [ngModel]="tagInput()"
                    (ngModelChange)="onTagInputChange($event)"
                    (keydown.enter)="addTag($event)"
                    (keydown.Comma)="addTag($event)"
                    (keydown.backspace)="onTagBackspace()"
                    placeholder="Add tag..."
                  />
                </div>
                @if (tagSuggestions().length > 0) {
                  <div class="tag-suggestions">
                    @for (s of tagSuggestions(); track s) {
                      <button class="tag-suggestion" (click)="selectSuggestion(s)">{{ s }}</button>
                    }
                  </div>
                }
              </div>

              <!-- Previously used tags cloud -->
              @if (recentTags().length > 0) {
                <div class="field">
                  <span class="field-label">Previously Used</span>
                  <div class="tag-cloud">
                    @for (tag of recentTags(); track tag) {
                      <button
                        class="tag-cloud-pill"
                        [class.applied]="book.tags?.includes(tag)"
                        (click)="toggleCloudTag(tag)"
                      >
                        @if (book.tags?.includes(tag)) {
                          <span class="tag-check">&#10003;</span>
                        }
                        {{ tag }}
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Pinned Actions -->
        <div class="actions">
          @if (!libraryService.ebookMetaAvailable()) {
            <div class="calibre-warning">
              Install Calibre to enable metadata editing
            </div>
          }

          @if (saveWarning()) {
            <div class="save-warning">{{ saveWarning() }}</div>
          }

          <button
            class="btn btn-primary"
            (click)="save()"
            [disabled]="saving()"
          >
            {{ saving() ? 'Saving...' : 'Save' }}
          </button>

          @if (book.format === 'epub' || book.format === 'pdf') {
            <button class="btn btn-default" (click)="editInViewer()">
              Edit in Viewer
            </button>
          }

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
    :host {
      display: flex;
      overflow: hidden;
      min-height: 0;
    }

    .metadata-panel {
      width: 260px;
      min-width: 260px;
      height: 100%;
      border-left: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      outline: none;

      &.empty {
        display: flex;
        align-items: center;
        justify-content: center;
      }
    }

    .panel-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .cover-section {
      width: 100%;
      aspect-ratio: 2/3;
      max-height: 260px;
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-elevated);
      flex-shrink: 0;
    }

    .panel-cover {
      width: 100%;
      height: 100%;
      object-fit: contain;
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

    .meta-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
      flex-shrink: 0;
    }

    .meta-tab {
      flex: 1;
      padding: 6px 8px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
    }

    .meta-tab:hover {
      color: var(--text-primary);
    }

    .meta-tab.active {
      color: var(--accent-primary);
      border-bottom-color: var(--accent-primary);
    }

    .tag-cloud {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .tag-cloud-pill {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 3px 8px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 0.7rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .tag-cloud-pill:hover {
      border-color: var(--accent-primary);
      color: var(--accent-primary);
    }

    .tag-cloud-pill.applied {
      background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
      border-color: var(--accent-primary);
      color: var(--accent-primary);
    }

    .tag-check {
      font-size: 0.6rem;
      font-weight: 700;
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

    .tag-editor {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: flex-start;
      align-content: flex-start;
      min-height: 64px;
      padding: 6px;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      cursor: text;
      transition: border-color 0.15s ease;
    }

    .tag-editor:focus-within {
      border-color: var(--accent-primary);
    }

    .tag-pill {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 3px 8px;
      background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
      color: var(--accent-primary);
      border-radius: 12px;
      font-size: 0.7rem;
      white-space: nowrap;
      line-height: 1.3;
    }

    .tag-remove {
      background: none;
      border: none;
      color: var(--accent-primary);
      cursor: pointer;
      font-size: 0.8rem;
      padding: 0 2px;
      opacity: 0.6;
      line-height: 1;
    }

    .tag-remove:hover { opacity: 1; }

    .tag-input {
      border: none;
      background: transparent;
      outline: none;
      flex: 1;
      min-width: 60px;
      color: var(--text-primary);
      font-size: 0.75rem;
      padding: 3px 4px;
      line-height: 1.3;
    }

    .tag-input::placeholder { color: var(--text-tertiary); }

    .tag-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 2px;
    }

    .tag-suggestion {
      padding: 2px 8px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: 0.65rem;
      cursor: pointer;
    }

    .tag-suggestion:hover {
      border-color: var(--accent-primary);
      color: var(--accent-primary);
    }

    .empty-hint {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
      padding: 12px;
      border-top: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
    }

    .calibre-warning {
      font-size: 0.7rem;
      color: var(--accent-warning, #f59e0b);
      padding: 6px 8px;
      background: color-mix(in srgb, var(--accent-warning, #f59e0b) 10%, transparent);
      border-radius: 4px;
      text-align: center;
    }

    .save-warning {
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
  readonly editRequested = output<LibraryBook>();

  editTitle = '';
  editSubtitle = '';
  editAuthorFirst = '';
  editAuthorLast = '';
  editYear: number | null = null;
  editLanguage = '';
  editCategory = '';

  saving = signal(false);
  saveWarning = signal<string | null>(null);
  coverPreview = signal<string | null>(null);
  private pendingCoverData: string | null = null;
  private lastBookPath: string | null = null;

  // Meta tab
  readonly activeMetaTab = signal<'details' | 'tags'>('details');
  readonly recentTags = computed(() => this.libraryService.allTags().slice(0, 25));

  // Tag editor
  readonly tagInput = signal('');
  readonly tagSuggestions = computed(() => {
    const input = this.tagInput().toLowerCase().trim();
    if (!input) return [];
    const currentTags = new Set(this.libraryService.selectedBook()?.tags || []);
    return this.libraryService.allTags()
      .filter(t => t.toLowerCase().includes(input) && !currentTags.has(t))
      .slice(0, 8);
  });

  constructor() {
    // Sync form fields when a different book is selected
    effect(() => {
      const book = this.libraryService.selectedBook();
      if (book) {
        const pathChanged = book.relativePath !== this.lastBookPath;
        this.lastBookPath = book.relativePath;

        if (pathChanged) {
          this.editTitle = book.title || '';
          this.editSubtitle = book.subtitle || '';
          this.editAuthorFirst = book.authorFirst || '';
          this.editAuthorLast = book.authorLast || '';
          this.editYear = book.year || null;
          this.editLanguage = book.language || '';
          this.editCategory = book.category || 'Uncategorized';
          this.coverPreview.set(null);
          this.saveWarning.set(null);
          this.pendingCoverData = null;
          this.tagInput.set('');
          this.activeMetaTab.set('details');

          // Load cover if not already loaded
          if (!book.coverData) {
            this.loadCover(book.relativePath);
          }
        }
      } else {
        this.lastBookPath = null;
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
    this.saveWarning.set(null);
    try {
      // Save metadata to file (may rename the file, changing relativePath)
      const result = await this.libraryService.updateMetadata(book.relativePath, {
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
      if (result?.warning) {
        this.saveWarning.set(result.warning);
      }
      const currentPath = result?.book?.relativePath || book.relativePath;

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

  editInViewer(): void {
    const book = this.libraryService.selectedBook();
    if (!book) return;
    this.editRequested.emit(book);
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

  // ─── Tag Editor ───

  focusTagInput(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;
    const container = target.closest('.tag-editor') as HTMLElement;
    const input = container?.querySelector('.tag-input') as HTMLInputElement;
    input?.focus();
  }

  onTagInputChange(value: string): void {
    this.tagInput.set(value);
  }

  async addTag(event: Event): Promise<void> {
    event.preventDefault();
    const raw = this.tagInput().trim().replace(/,$/, '').trim().toLowerCase();
    if (!raw) return;
    const book = this.libraryService.selectedBook();
    if (!book) return;
    const current = book.tags || [];
    if (current.includes(raw)) {
      this.tagInput.set('');
      return;
    }
    await this.libraryService.updateTags(book.relativePath, [...current, raw]);
    this.tagInput.set('');
  }

  async removeTag(tag: string): Promise<void> {
    const book = this.libraryService.selectedBook();
    if (!book) return;
    const newTags = (book.tags || []).filter(t => t !== tag);
    await this.libraryService.updateTags(book.relativePath, newTags);
  }

  async selectSuggestion(tag: string): Promise<void> {
    const book = this.libraryService.selectedBook();
    if (!book) return;
    const current = book.tags || [];
    if (current.includes(tag)) return;
    await this.libraryService.updateTags(book.relativePath, [...current, tag]);
    this.tagInput.set('');
  }

  async onTagBackspace(): Promise<void> {
    if (this.tagInput()) return;
    const book = this.libraryService.selectedBook();
    if (!book) return;
    const current = book.tags || [];
    if (current.length > 0) {
      await this.libraryService.updateTags(book.relativePath, current.slice(0, -1));
    }
  }

  async toggleCloudTag(tag: string): Promise<void> {
    const book = this.libraryService.selectedBook();
    if (!book) return;
    const current = book.tags || [];
    if (current.includes(tag)) {
      await this.libraryService.updateTags(book.relativePath, current.filter(t => t !== tag));
    } else {
      await this.libraryService.updateTags(book.relativePath, [...current, tag]);
    }
  }
}

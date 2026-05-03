import { Component, input, output, signal, computed, effect, HostListener, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFirst?: string;
  authorLast?: string;
  year?: string;
  language: string;
  coverPath?: string;
  coverData?: string;
  outputFilename?: string;
  contributors?: Array<{ first: string; last: string }>;
  tags?: string[];
}

@Component({
  selector: 'app-metadata-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="metadata-editor">
      <!-- Cover Section -->
      <div class="cover-section">
        <div class="cover-preview" (click)="selectCover()">
          @if (coverPreview()) {
            <img [src]="coverPreview()" alt="Book cover" />
          } @else {
            <div class="no-cover">
              <span class="icon">&#128247;</span>
              <span>Click or paste image</span>
            </div>
          }
        </div>
        @if (coverPreview()) {
          <desktop-button variant="ghost" size="sm" (click)="removeCover()">
            Remove Cover
          </desktop-button>
        }
      </div>

      <!-- Form Section -->
      <div class="form-section">
        <div class="form-group">
          <label for="title">Title</label>
          <input
            id="title"
            type="text"
            [ngModel]="formData().title"
            (ngModelChange)="updateField('title', $event)"
            placeholder="Book title"
          />
        </div>

        <!-- Authors -->
        <div class="authors-section">
          <label class="section-label">Authors</label>
          @for (author of formAuthors(); track $index) {
            <div class="form-row author-row">
              <div class="form-group">
                <input
                  type="text"
                  [ngModel]="author.first"
                  (ngModelChange)="updateAuthor($index, 'first', $event)"
                  placeholder="First name"
                />
              </div>
              <div class="form-group">
                <input
                  type="text"
                  [ngModel]="author.last"
                  (ngModelChange)="updateAuthor($index, 'last', $event)"
                  placeholder="Last name"
                />
              </div>
              @if (formAuthors().length > 1) {
                <button class="remove-author-btn" (click)="removeAuthor($index)" title="Remove author">
                  &times;
                </button>
              }
            </div>
          }
          <button class="add-author-btn" (click)="addAuthor()">+ Add Author</button>
        </div>

        <div class="form-row">
          <div class="form-group year-group">
            <label for="year">Year</label>
            <input
              id="year"
              type="text"
              [ngModel]="formData().year"
              (ngModelChange)="updateField('year', $event)"
              placeholder="2024"
              maxlength="4"
            />
          </div>

          <div class="form-group">
            <label for="language">Language</label>
            <select
              id="language"
              [ngModel]="formData().language"
              (ngModelChange)="updateField('language', $event)"
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
            </select>
          </div>
        </div>

        <!-- Tags -->
        <div class="form-group tags-group">
          <label>Tags</label>
          <div class="tags-container" (click)="focusTagInput()">
            @for (tag of formData().tags || []; track tag) {
              <span class="tag-pill">
                {{ tag }}
                <button class="tag-remove" (click)="removeTag(tag); $event.stopPropagation()">&times;</button>
              </span>
            }
            <input
              #tagInputEl
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

        <div class="form-group filename-group">
          <label for="outputFilename">Output Filename</label>
          <input
            id="outputFilename"
            type="text"
            [ngModel]="formData().outputFilename || generatedFilename()"
            (ngModelChange)="updateField('outputFilename', $event)"
            (focus)="onFilenameFocus()"
            placeholder="filename.m4b"
            class="filename-input"
          />
        </div>

        <div class="save-section">
          <desktop-button
            variant="primary"
            (click)="onSave()"
            [disabled]="saving()"
          >
            @if (saving()) {
              Saving...
            } @else if (saveSuccess()) {
              Saved!
            } @else {
              Save Metadata
            }
          </desktop-button>
        </div>

      </div>

      <!-- Hidden file input for cover selection -->
      <input
        #fileInput
        type="file"
        accept="image/*"
        style="display: none"
        (change)="onCoverSelected($event)"
      />
    </div>
  `,
  styles: [`
    .metadata-editor {
      display: flex;
      gap: 1.5rem;
    }

    .cover-section {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }

    .cover-preview {
      width: 140px;
      height: 200px;
      background: var(--bg-subtle);
      border: 2px dashed var(--border-default);
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      transition: border-color 0.2s;

      &:hover {
        border-color: var(--accent-primary);
      }

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .no-cover {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        color: var(--text-muted);

        .icon {
          font-size: 2rem;
        }

        span:last-child {
          font-size: 0.75rem;
        }
      }
    }

    .form-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;

      label {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      input, select {
        padding: 0.5rem 0.75rem;
        background: var(--bg-subtle);
        border: 1px solid var(--border-default);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 0.875rem;
        transition: border-color 0.2s;

        &:focus {
          outline: none;
          border-color: var(--accent-primary);
        }

        &::placeholder {
          color: var(--text-muted);
        }
      }

      select {
        cursor: pointer;
      }

      .hint {
        font-size: 0.6875rem;
        color: var(--text-muted);
      }
    }

    .form-row {
      display: flex;
      gap: 1rem;

      .form-group {
        flex: 1;
      }
    }

    .authors-section {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;

      .section-label {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
    }

    .author-row {
      align-items: flex-end;
    }

    .remove-author-btn {
      flex-shrink: 0;
      width: 28px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 1.125rem;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        color: var(--error);
        border-color: var(--error);
      }
    }

    .add-author-btn {
      align-self: flex-start;
      background: none;
      border: none;
      color: var(--accent-primary);
      font-size: 0.8125rem;
      cursor: pointer;
      padding: 0.25rem 0;

      &:hover {
        text-decoration: underline;
      }
    }

    .year-group {
      flex: 0 0 auto;
      width: 80px;
    }

    .tags-container {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      min-height: 34px;
      align-items: center;
      cursor: text;
    }

    .tag-pill {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px 8px;
      background: var(--accent-primary, #6366f1);
      color: #fff;
      border-radius: 12px;
      font-size: 0.75rem;
      white-space: nowrap;
    }

    .tag-remove {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      font-size: 0.875rem;
      padding: 0 2px;
      line-height: 1;

      &:hover {
        color: #fff;
      }
    }

    .tag-input {
      border: none;
      background: transparent;
      outline: none;
      flex: 1;
      min-width: 80px;
      color: var(--text-primary);
      font-size: 0.875rem;
      padding: 4px;
    }

    .tag-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }

    .tag-suggestion {
      padding: 2px 8px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: var(--bg-elevated, #1a1a1a);
      color: var(--text-secondary);
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--accent-primary, #6366f1);
        color: var(--accent-primary, #6366f1);
      }
    }

    .filename-group {
      .filename-input {
        font-family: monospace;
        font-size: 0.8125rem;
      }
    }

    .save-section {
      margin-top: 0.5rem;
      display: flex;
      justify-content: flex-end;
    }

  `]
})
export class MetadataEditorComponent {
  // Inputs
  readonly metadata = input<EpubMetadata | null>(null);
  readonly saving = input<boolean>(false);
  // Outputs
  readonly metadataChange = output<EpubMetadata>();
  readonly coverChange = output<string>();
  readonly save = output<EpubMetadata>();

  // Electron access
  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron
      ? (window as any).electron
      : null;
  }

  // Local state for save feedback
  readonly saveSuccess = signal(false);

  // Authors array (separate signal for clean reactivity)
  readonly formAuthors = signal<Array<{ first: string; last: string }>>([{ first: '', last: '' }]);

  // Internal form state
  readonly formData = signal<EpubMetadata>({
    title: '',
    subtitle: '',
    author: '',
    authorFirst: '',
    authorLast: '',
    year: '',
    language: 'en',
    coverPath: '',
    coverData: '',
    outputFilename: ''
  });

  // Tag input state
  readonly tagInput = signal('');
  readonly allTags = signal<string[]>([]);
  @ViewChild('tagInputEl') tagInputEl?: ElementRef<HTMLInputElement>;

  readonly tagSuggestions = computed(() => {
    const input = this.tagInput().toLowerCase().trim();
    if (!input) return [];
    const currentTags = new Set(this.formData().tags || []);
    return this.allTags()
      .filter(t => t.toLowerCase().includes(input) && !currentTags.has(t))
      .slice(0, 8);
  });

  // Track if user has manually edited the filename
  private filenameManuallyEdited = false;

  // Cover preview
  readonly coverPreview = computed(() => {
    const data = this.formData();
    return data.coverData || null;
  });

  // Generated filename (used when not manually edited)
  readonly generatedFilename = computed(() => {
    const data = this.formData();
    const authors = this.formAuthors();
    let filename = data.title || 'Untitled';

    if (data.subtitle) {
      filename += ` - ${data.subtitle}`;
    }

    filename += '.';

    const authorStr = this.formatAuthorsForFilename(authors);
    if (authorStr) {
      filename += ` ${authorStr}.`;
    }

    if (data.year) {
      filename += ` (${data.year})`;
    }

    filename += '.m4b';

    // Clean up the filename
    return filename.replace(/\s+/g, ' ').replace(/\.\s*\./g, '.');
  });

  private wasSaving = false;

  constructor() {
    // Sync form data with input metadata
    effect(() => {
      const meta = this.metadata();
      if (meta) {
        // Build authors array from contributors or fall back to parsing author string
        let authors: Array<{ first: string; last: string }>;
        if (meta.contributors && meta.contributors.length > 0) {
          authors = meta.contributors.map(c => ({ ...c }));
        } else {
          let first = meta.authorFirst || '';
          let last = meta.authorLast || '';
          if (!first && !last && meta.author) {
            const parts = meta.author.trim().split(' ');
            if (parts.length >= 2) {
              last = parts.pop() || '';
              first = parts.join(' ');
            } else {
              first = meta.author;
            }
          }
          authors = [{ first, last }];
        }

        this.formAuthors.set(authors);
        this.formData.set({
          ...meta,
          authorFirst: authors[0]?.first || '',
          authorLast: authors[0]?.last || '',
        });

        // Reset manual edit flag when loading new metadata
        this.filenameManuallyEdited = !!meta.outputFilename;
      }
    }, { allowSignalWrites: true });

    // Show "Saved!" when saving completes
    effect(() => {
      const isSaving = this.saving();
      if (this.wasSaving && !isSaving) {
        // Saving just finished
        this.saveSuccess.set(true);
        setTimeout(() => this.saveSuccess.set(false), 2000);
      }
      this.wasSaving = isSaving;
    }, { allowSignalWrites: true });

    // Load all existing tags for autocomplete suggestions
    this.loadAllTags();
  }

  updateField(field: keyof EpubMetadata, value: string): void {
    this.formData.update(data => ({ ...data, [field]: value }));

    // Track if filename was manually edited
    if (field === 'outputFilename') {
      this.filenameManuallyEdited = true;
    }

    // If other fields change and filename wasn't manually edited, clear it to use generated
    if (field !== 'outputFilename' && !this.filenameManuallyEdited) {
      this.formData.update(data => ({ ...data, outputFilename: '' }));
    }

    this.metadataChange.emit(this.buildEmitData());
  }

  updateAuthor(index: number, field: 'first' | 'last', value: string): void {
    this.formAuthors.update(authors => {
      const updated = authors.map((a, i) => i === index ? { ...a, [field]: value } : a);
      return updated;
    });
    this.syncAuthorToFormData();

    // If filename wasn't manually edited, clear it to use generated
    if (!this.filenameManuallyEdited) {
      this.formData.update(data => ({ ...data, outputFilename: '' }));
    }

    this.metadataChange.emit(this.buildEmitData());
  }

  addAuthor(): void {
    this.formAuthors.update(authors => [...authors, { first: '', last: '' }]);
    this.syncAuthorToFormData();

    if (!this.filenameManuallyEdited) {
      this.formData.update(data => ({ ...data, outputFilename: '' }));
    }

    this.metadataChange.emit(this.buildEmitData());
  }

  removeAuthor(index: number): void {
    this.formAuthors.update(authors => authors.filter((_, i) => i !== index));
    this.syncAuthorToFormData();

    if (!this.filenameManuallyEdited) {
      this.formData.update(data => ({ ...data, outputFilename: '' }));
    }

    this.metadataChange.emit(this.buildEmitData());
  }

  private syncAuthorToFormData(): void {
    const authors = this.formAuthors();
    // Build combined author string from all authors: "First Last, First Last"
    const authorStr = authors
      .map(a => [a.first, a.last].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(', ');
    const first = authors[0]?.first || '';
    const last = authors[0]?.last || '';
    this.formData.update(data => ({
      ...data,
      author: authorStr,
      authorFirst: first,
      authorLast: last,
    }));
  }

  private formatAuthorsForFilename(authors: Array<{ first: string; last: string }>): string {
    const valid = authors.filter(a => a.first || a.last);
    if (valid.length === 0) return '';

    const formatOne = (a: { first: string; last: string }) => {
      if (a.last && a.first) return `${a.last}, ${a.first}`;
      return a.last || a.first;
    };

    if (valid.length === 1) {
      return formatOne(valid[0]);
    }
    if (valid.length === 2) {
      return `${formatOne(valid[0])} and ${formatOne(valid[1])}`;
    }
    // 3+: first author et al.
    return `${formatOne(valid[0])} et al.`;
  }

  private buildEmitData(): EpubMetadata {
    const data = this.formData();
    const authors = this.formAuthors();
    return {
      ...data,
      contributors: authors.filter(a => a.first || a.last),
      tags: data.tags || [],
    };
  }

  // ─── Tag Methods ───

  onTagInputChange(value: string): void {
    this.tagInput.set(value);
  }

  addTag(event: Event): void {
    event.preventDefault();
    const raw = this.tagInput().trim().replace(/,$/,'').trim().toLowerCase();
    if (!raw) return;
    const current = this.formData().tags || [];
    if (!current.includes(raw)) {
      this.formData.update(d => ({ ...d, tags: [...current, raw] }));
      this.metadataChange.emit(this.buildEmitData());
    }
    this.tagInput.set('');
  }

  removeTag(tag: string): void {
    const current = this.formData().tags || [];
    this.formData.update(d => ({ ...d, tags: current.filter(t => t !== tag) }));
    this.metadataChange.emit(this.buildEmitData());
  }

  selectSuggestion(tag: string): void {
    const current = this.formData().tags || [];
    if (!current.includes(tag)) {
      this.formData.update(d => ({ ...d, tags: [...current, tag] }));
      this.metadataChange.emit(this.buildEmitData());
    }
    this.tagInput.set('');
  }

  onTagBackspace(): void {
    if (this.tagInput()) return; // only delete last tag when input is empty
    const current = this.formData().tags || [];
    if (current.length > 0) {
      this.formData.update(d => ({ ...d, tags: current.slice(0, -1) }));
      this.metadataChange.emit(this.buildEmitData());
    }
  }

  focusTagInput(): void {
    this.tagInputEl?.nativeElement.focus();
  }

  async loadAllTags(): Promise<void> {
    const electron = this.electron;
    if (electron?.manifest?.getAllTags) {
      try {
        const tags = await electron.manifest.getAllTags();
        this.allTags.set(tags || []);
      } catch {
        // Silently fail if IPC not available
      }
    }
  }

  onFilenameFocus(): void {
    // If no custom filename yet, populate with generated one so user can edit it
    const data = this.formData();
    if (!data.outputFilename) {
      this.formData.update(d => ({ ...d, outputFilename: this.generatedFilename() }));
    }
  }

  selectCover(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        this.readCoverFile(file);
      }
    };
    input.click();
  }

  onCoverSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      this.readCoverFile(file);
    }
  }

  private readCoverFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const coverData = reader.result as string;
      this.formData.update(data => ({ ...data, coverData }));
      this.coverChange.emit(coverData);
      this.metadataChange.emit(this.buildEmitData());
    };
    reader.readAsDataURL(file);
  }

  removeCover(): void {
    this.formData.update(data => ({ ...data, coverData: '', coverPath: '' }));
    this.coverChange.emit('');
    this.metadataChange.emit(this.buildEmitData());
  }

  onSave(): void {
    this.save.emit(this.buildEmitData());
  }


  @HostListener('window:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          this.readCoverFile(file);
        }
        break;
      }
    }
  }
}

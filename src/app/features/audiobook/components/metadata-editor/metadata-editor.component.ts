import { Component, input, output, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFileAs?: string;
  year?: string;
  language: string;
  coverPath?: string;
  coverData?: string;
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
              <span>Click to add cover</span>
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

        <div class="form-group">
          <label for="subtitle">Subtitle</label>
          <input
            id="subtitle"
            type="text"
            [ngModel]="formData().subtitle"
            (ngModelChange)="updateField('subtitle', $event)"
            placeholder="Subtitle (optional)"
          />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="author">Author</label>
            <input
              id="author"
              type="text"
              [ngModel]="formData().author"
              (ngModelChange)="updateField('author', $event)"
              placeholder="Author name"
            />
          </div>

          <div class="form-group">
            <label for="authorFileAs">Author (File As)</label>
            <input
              id="authorFileAs"
              type="text"
              [ngModel]="formData().authorFileAs"
              (ngModelChange)="updateField('authorFileAs', $event)"
              placeholder="Last, First"
            />
            <span class="hint">Used for sorting (e.g., "Smith, John")</span>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
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

        <!-- Output filename preview -->
        <div class="output-preview">
          <label>Output Filename</label>
          <div class="preview-text">{{ outputFilename() }}</div>
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
      gap: 2rem;
    }

    .cover-section {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.75rem;
    }

    .cover-preview {
      width: 180px;
      height: 260px;
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
      gap: 1rem;
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

    .output-preview {
      margin-top: 1rem;
      padding: 1rem;
      background: var(--bg-subtle);
      border-radius: 6px;

      label {
        display: block;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
        margin-bottom: 0.5rem;
      }

      .preview-text {
        font-family: monospace;
        font-size: 0.8125rem;
        color: var(--text-primary);
        word-break: break-all;
      }
    }
  `]
})
export class MetadataEditorComponent {
  // Inputs
  readonly metadata = input<EpubMetadata | null>(null);

  // Outputs
  readonly metadataChange = output<EpubMetadata>();
  readonly coverChange = output<string>();

  // Internal form state
  readonly formData = signal<EpubMetadata>({
    title: '',
    subtitle: '',
    author: '',
    authorFileAs: '',
    year: '',
    language: 'en',
    coverPath: '',
    coverData: ''
  });

  // Cover preview
  readonly coverPreview = computed(() => {
    const data = this.formData();
    return data.coverData || null;
  });

  // Computed output filename
  readonly outputFilename = computed(() => {
    const data = this.formData();
    let filename = data.title || 'Untitled';

    if (data.subtitle) {
      filename += ` - ${data.subtitle}`;
    }

    filename += '.';

    if (data.authorFileAs) {
      filename += ` ${data.authorFileAs}.`;
    } else if (data.author) {
      // Auto-convert "First Last" to "Last, First"
      const parts = data.author.trim().split(' ');
      if (parts.length >= 2) {
        const last = parts.pop();
        filename += ` ${last}, ${parts.join(' ')}.`;
      } else {
        filename += ` ${data.author}.`;
      }
    }

    if (data.year) {
      filename += ` (${data.year})`;
    }

    filename += '.m4b';

    // Clean up the filename
    return filename.replace(/\s+/g, ' ').replace(/\.\s*\./g, '.');
  });

  constructor() {
    // Sync form data with input metadata
    effect(() => {
      const meta = this.metadata();
      if (meta) {
        this.formData.set({ ...meta });
      }
    }, { allowSignalWrites: true });
  }

  updateField(field: keyof EpubMetadata, value: string): void {
    this.formData.update(data => ({ ...data, [field]: value }));

    // Auto-generate authorFileAs if not set
    if (field === 'author' && !this.formData().authorFileAs) {
      const parts = value.trim().split(' ');
      if (parts.length >= 2) {
        const last = parts.pop();
        const fileAs = `${last}, ${parts.join(' ')}`;
        this.formData.update(data => ({ ...data, authorFileAs: fileAs }));
      }
    }

    this.metadataChange.emit(this.formData());
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
      this.metadataChange.emit(this.formData());
    };
    reader.readAsDataURL(file);
  }

  removeCover(): void {
    this.formData.update(data => ({ ...data, coverData: '', coverPath: '' }));
    this.coverChange.emit('');
    this.metadataChange.emit(this.formData());
  }
}

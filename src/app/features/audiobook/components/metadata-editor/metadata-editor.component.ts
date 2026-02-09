import { Component, input, output, signal, computed, effect, HostListener } from '@angular/core';
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
            <label for="authorFirst">Author First Name</label>
            <input
              id="authorFirst"
              type="text"
              [ngModel]="formData().authorFirst"
              (ngModelChange)="updateAuthorField('authorFirst', $event)"
              placeholder="First name"
            />
          </div>

          <div class="form-group">
            <label for="authorLast">Author Last Name</label>
            <input
              id="authorLast"
              type="text"
              [ngModel]="formData().authorLast"
              (ngModelChange)="updateAuthorField('authorLast', $event)"
              placeholder="Last name"
            />
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

        <!-- Output filename (editable) -->
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
          <span class="hint">Auto-generated from metadata. Edit to customize.</span>
        </div>

        <!-- Save button -->
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

        <!-- Show audiobook file in its BFP project folder -->
        <div class="output-section">
          <desktop-button
            variant="secondary"
            (click)="onShowInFinder()"
          >
            Show Audiobook File
          </desktop-button>
        </div>

        <!-- Audio File Linking Section -->
        <div class="audio-link-section">
          <label>Linked Audio File</label>
          @if (audioFilePath()) {
            <div class="audio-file-row" [class.path-invalid]="!audioFilePathValid()">
              <span class="audio-file-path" [title]="audioFilePath()">{{ getFilename(audioFilePath()) }}</span>
              @if (!audioFilePathValid()) {
                <span class="path-warning" title="File not found on this system">File not found</span>
              }
              <desktop-button
                variant="ghost"
                size="xs"
                (click)="browseForAudio()"
                title="Change linked audio file"
              >
                {{ audioFilePathValid() ? 'Change' : 'Relink' }}
              </desktop-button>
            </div>
          } @else {
            <div class="no-audio-row">
              <span class="no-audio-text">No audio file linked</span>
              <desktop-button
                variant="secondary"
                size="sm"
                (click)="browseForAudio()"
              >
                Link Audio File
              </desktop-button>
            </div>
            <span class="hint">Link an audiobook file to enable enhancement features</span>
          }
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

    .filename-group {
      margin-top: 1rem;

      .filename-input {
        font-family: monospace;
        font-size: 0.8125rem;
      }
    }

    .save-section {
      margin-top: 1.5rem;
      display: flex;
      justify-content: flex-end;
    }

    .output-section {
      margin-top: 1rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;

      .output-hint {
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .audio-link-section {
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      gap: 0.5rem;

      > label {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      .hint {
        font-size: 0.6875rem;
        color: var(--text-muted);
      }
    }

    .audio-file-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg-subtle);
      border-radius: 6px;
      border: 1px solid var(--border-default);

      &.path-invalid {
        border-color: var(--warning, #f59e0b);
        background: color-mix(in srgb, var(--warning, #f59e0b) 8%, var(--bg-subtle));
      }
    }

    .audio-file-path {
      flex: 1;
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      .path-invalid & {
        color: var(--text-secondary);
      }
    }

    .path-warning {
      font-size: 0.6875rem;
      font-weight: 500;
      color: var(--warning, #f59e0b);
      white-space: nowrap;
    }

    .no-audio-row {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .no-audio-text {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
  `]
})
export class MetadataEditorComponent {
  // Inputs
  readonly metadata = input<EpubMetadata | null>(null);
  readonly saving = input<boolean>(false);
  readonly audioFilePath = input<string>('');
  readonly audioFilePathValid = input<boolean>(true);  // Cross-platform path validation

  // Outputs
  readonly metadataChange = output<EpubMetadata>();
  readonly coverChange = output<string>();
  readonly save = output<EpubMetadata>();
  readonly showInFinder = output<void>();
  readonly linkAudio = output<string>();

  // Electron access
  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron
      ? (window as any).electron
      : null;
  }

  // Local state for save feedback
  readonly saveSuccess = signal(false);

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
    let filename = data.title || 'Untitled';

    if (data.subtitle) {
      filename += ` - ${data.subtitle}`;
    }

    filename += '.';

    // Use Last, First format
    if (data.authorLast) {
      filename += ` ${data.authorLast}`;
      if (data.authorFirst) {
        filename += `, ${data.authorFirst}`;
      }
      filename += '.';
    } else if (data.authorFirst) {
      filename += ` ${data.authorFirst}.`;
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
        // Parse author into first/last if not already set
        let authorFirst = meta.authorFirst || '';
        let authorLast = meta.authorLast || '';

        if (!authorFirst && !authorLast && meta.author) {
          const parts = meta.author.trim().split(' ');
          if (parts.length >= 2) {
            authorLast = parts.pop() || '';
            authorFirst = parts.join(' ');
          } else {
            authorFirst = meta.author;
          }
        }

        this.formData.set({
          ...meta,
          authorFirst,
          authorLast
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

    this.metadataChange.emit(this.formData());
  }

  updateAuthorField(field: 'authorFirst' | 'authorLast', value: string): void {
    this.formData.update(data => {
      const updated = { ...data, [field]: value };
      // Also update the combined author field
      const first = field === 'authorFirst' ? value : data.authorFirst || '';
      const last = field === 'authorLast' ? value : data.authorLast || '';
      updated.author = [first, last].filter(Boolean).join(' ');
      return updated;
    });

    // If filename wasn't manually edited, clear it to use generated
    if (!this.filenameManuallyEdited) {
      this.formData.update(data => ({ ...data, outputFilename: '' }));
    }

    this.metadataChange.emit(this.formData());
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
      this.metadataChange.emit(this.formData());
    };
    reader.readAsDataURL(file);
  }

  removeCover(): void {
    this.formData.update(data => ({ ...data, coverData: '', coverPath: '' }));
    this.coverChange.emit('');
    this.metadataChange.emit(this.formData());
  }

  onSave(): void {
    this.save.emit(this.formData());
  }

  onShowInFinder(): void {
    this.showInFinder.emit();
  }

  getFilename(path: string): string {
    if (!path) return '';
    // Handle both forward and back slashes
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }

  async browseForAudio(): Promise<void> {
    console.log('[MetadataEditor] browseForAudio called');
    console.log('[MetadataEditor] electron:', !!this.electron);
    console.log('[MetadataEditor] electron.dialog:', !!this.electron?.dialog);
    console.log('[MetadataEditor] electron.dialog.openAudio:', !!this.electron?.dialog?.openAudio);

    if (!this.electron?.dialog?.openAudio) {
      console.error('[MetadataEditor] dialog.openAudio not available');
      return;
    }

    try {
      console.log('[MetadataEditor] Calling openAudio...');
      const result = await this.electron.dialog.openAudio();
      console.log('[MetadataEditor] openAudio result:', result);

      if (result.success && result.filePath) {
        console.log('[MetadataEditor] Emitting linkAudio with path:', result.filePath);
        this.linkAudio.emit(result.filePath);
      } else {
        console.log('[MetadataEditor] Dialog result did not have success/filePath:', result);
      }
    } catch (err) {
      console.error('[MetadataEditor] Error opening file dialog:', err);
    }
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

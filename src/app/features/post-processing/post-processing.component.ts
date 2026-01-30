import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../core/services/electron.service';
import { SettingsService } from '../../core/services/settings.service';
import { LibraryService } from '../../core/services/library.service';
import { QueueService } from '../queue/services/queue.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';
import { Router } from '@angular/router';

interface AudioFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  format: string;
  selected?: boolean;
}

interface EnhanceProgress {
  phase: 'starting' | 'converting' | 'enhancing' | 'finalizing' | 'complete' | 'error';
  percentage: number;
  message: string;
  error?: string;
}

type OutputMode = 'same-folder' | 'custom' | 'replace';

@Component({
  selector: 'app-post-processing',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="post-processing">
      <header class="header">
        <h1>Post-Processing</h1>
        <p class="subtitle">Enhance audio files using Resemble Enhance</p>
      </header>

      @if (checkingAvailability()) {
        <div class="loading-screen">
          <div class="loading-spinner"></div>
          <p>Checking Resemble Enhance availability...</p>
        </div>
      } @else {
      <div class="content">
        <!-- Drop Zone -->
        <section
          class="drop-zone"
          [class.dragover]="isDragging()"
          [class.has-files]="files().length > 0"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event)"
        >
          @if (files().length === 0) {
            <div class="drop-content">
              <div class="drop-icon">&#127911;</div>
              <p>Drop audio files here</p>
              <p class="hint">or</p>
              <desktop-button variant="secondary" (click)="pickFiles()">
                Browse Files...
              </desktop-button>
              <p class="formats">Supported: M4B, M4A, MP3, WAV, FLAC, OGG, OPUS</p>
            </div>
          } @else {
            <!-- File List -->
            <div class="file-list-container">
              <div class="file-list-header">
                <span>{{ files().length }} file{{ files().length === 1 ? '' : 's' }} loaded</span>
                <div class="header-actions">
                  <desktop-button variant="ghost" size="sm" (click)="pickFiles()">
                    Add More
                  </desktop-button>
                  <desktop-button variant="ghost" size="sm" (click)="clearFiles()">
                    Clear All
                  </desktop-button>
                </div>
              </div>
              <div class="file-grid">
                @for (file of files(); track file.path) {
                  <div
                    class="file-card"
                    [class.selected]="file.selected"
                    (click)="toggleFile(file)"
                  >
                    <div class="file-icon">{{ getFormatIcon(file.format) }}</div>
                    <div class="file-info">
                      <div class="file-name" [title]="file.name">{{ file.name }}</div>
                      <div class="file-meta">
                        <span class="format">{{ file.format }}</span>
                        <span class="size">{{ formatSize(file.size) }}</span>
                      </div>
                    </div>
                    <div class="checkbox">
                      @if (file.selected) {
                        <span class="check">&#10003;</span>
                      }
                    </div>
                  </div>
                }
              </div>
            </div>
          }
        </section>

        <!-- Output Configuration -->
        @if (files().length > 0) {
          <section class="output-section">
            <h3>Output Location</h3>
            <div class="output-options">
              <label class="output-option" [class.selected]="outputMode() === 'replace'">
                <input
                  type="radio"
                  name="outputMode"
                  [value]="'replace'"
                  [checked]="outputMode() === 'replace'"
                  (change)="setOutputMode('replace')"
                />
                <div class="option-content">
                  <strong>Replace original</strong>
                  <span>Overwrite the original file with the enhanced version</span>
                </div>
              </label>
              <label class="output-option" [class.selected]="outputMode() === 'same-folder'">
                <input
                  type="radio"
                  name="outputMode"
                  [value]="'same-folder'"
                  [checked]="outputMode() === 'same-folder'"
                  (change)="setOutputMode('same-folder')"
                />
                <div class="option-content">
                  <strong>Same folder with suffix</strong>
                  <span>Save as filename_enhanced.ext in the same folder</span>
                </div>
              </label>
              <label class="output-option" [class.selected]="outputMode() === 'custom'">
                <input
                  type="radio"
                  name="outputMode"
                  [value]="'custom'"
                  [checked]="outputMode() === 'custom'"
                  (change)="setOutputMode('custom')"
                />
                <div class="option-content">
                  <strong>Custom directory</strong>
                  <span>Save enhanced files to a specific folder</span>
                </div>
              </label>
            </div>

            @if (outputMode() === 'custom') {
              <div class="custom-output-path">
                <input
                  type="text"
                  [value]="customOutputPath()"
                  (input)="customOutputPath.set($any($event.target).value)"
                  placeholder="Select output folder..."
                  readonly
                />
                <desktop-button variant="secondary" size="sm" (click)="browseOutputFolder()">
                  Browse...
                </desktop-button>
              </div>
            }

            @if (outputMode() === 'replace') {
              <div class="warning-message">
                <strong>Warning:</strong> Original files will be permanently replaced.
                Make sure you have backups if needed.
              </div>
            }
          </section>

          <!-- Actions -->
          <section class="actions-section">
            <div class="selection-info">
              {{ selectedCount() }} file{{ selectedCount() === 1 ? '' : 's' }} selected
            </div>

            <div class="action-buttons">
              <desktop-button
                variant="primary"
                [disabled]="selectedCount() === 0 || !isAvailable() || (outputMode() === 'custom' && !customOutputPath())"
                (click)="addToQueue()"
              >
                Add to Queue
              </desktop-button>
            </div>

            @if (queuedCount() > 0) {
              <div class="success-message">
                Added {{ queuedCount() }} file{{ queuedCount() === 1 ? '' : 's' }} to queue.
                <a href="javascript:void(0)" (click)="goToQueue()">View Queue</a>
              </div>
            }

            @if (lastError()) {
              <div class="error-message">
                {{ lastError() }}
              </div>
            }
          </section>
        }

        <!-- Info Panel -->
        <section class="info-section">
          <h3>About Resemble Enhance</h3>
          <p>
            Resemble Enhance is a deep learning audio enhancement tool that removes
            reverb, echo, and improves speech quality. It works especially well for
            TTS artifacts like the baked-in reverb in Orpheus output.
          </p>
          @if (deviceInfo()) {
            <p class="device-info">
              <strong>Device:</strong> {{ deviceInfo() }}
            </p>
          }
          @if (!isAvailable()) {
            <p class="error">
              <strong>Not Available:</strong> {{ availabilityError() || 'Resemble Enhance is not installed.' }}
              See AUDIO_ENHANCEMENT.md for setup instructions.
            </p>
          }
        </section>
      </div>
      }
    </div>
  `,
  styles: [`
    .post-processing {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--border-default);
      background: var(--bg-subtle);

      h1 {
        margin: 0 0 0.25rem;
        font-size: 1.5rem;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        color: var(--text-secondary);
        font-size: 0.875rem;
      }
    }

    .loading-screen {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      color: var(--text-secondary);

      p {
        margin: 0;
        font-size: 0.875rem;
      }
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .drop-zone {
      min-height: 200px;
      border: 2px dashed var(--border-default);
      border-radius: 12px;
      transition: all 0.2s ease;

      &.dragover {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }

      &.has-files {
        border-style: solid;
        border-color: var(--border-default);
      }
    }

    .drop-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      text-align: center;
      color: var(--text-secondary);

      .drop-icon {
        font-size: 3rem;
        margin-bottom: 1rem;
      }

      p {
        margin: 0 0 0.5rem;
      }

      .hint {
        font-size: 0.75rem;
        margin: 0.75rem 0;
      }

      .formats {
        margin-top: 1rem;
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .file-list-container {
      padding: 1rem;
    }

    .file-list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border-default);

      span {
        font-weight: 500;
        color: var(--text-primary);
      }

      .header-actions {
        display: flex;
        gap: 0.5rem;
      }
    }

    .file-grid {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 300px;
      overflow-y: auto;
    }

    .file-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1rem;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
        background: var(--bg-subtle);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }
    }

    .file-icon {
      font-size: 1.5rem;
      width: 40px;
      text-align: center;
    }

    .file-info {
      flex: 1;
      min-width: 0;

      .file-name {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .file-meta {
        display: flex;
        gap: 1rem;
        font-size: 0.75rem;
        color: var(--text-secondary);
        margin-top: 0.25rem;
      }
    }

    .checkbox {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border-default);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-default);

      .check {
        color: var(--accent-primary);
        font-weight: bold;
      }
    }

    .file-card.selected .checkbox {
      border-color: var(--accent-primary);
      background: var(--accent-primary);

      .check {
        color: white;
      }
    }

    .output-section {
      h3 {
        margin: 0 0 1rem;
        font-size: 1rem;
        font-weight: 600;
      }
    }

    .output-options {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .output-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }

      input[type="radio"] {
        margin-top: 0.25rem;
      }

      .option-content {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;

        strong {
          font-size: 0.875rem;
        }

        span {
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
      }
    }

    .custom-output-path {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;

      input {
        flex: 1;
        padding: 0.5rem 0.75rem;
        border: 1px solid var(--border-default);
        border-radius: 6px;
        background: var(--bg-default);
        color: var(--text-primary);
        font-size: 0.875rem;
      }
    }

    .warning-message {
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      background: var(--warning-bg, #fff3cd);
      color: var(--warning-text, #856404);
      border-radius: 6px;
      font-size: 0.8125rem;
    }

    .actions-section {
      padding: 1.5rem;
      background: var(--bg-subtle);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      align-items: center;

      .selection-info {
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .action-buttons {
        display: flex;
        gap: 0.75rem;
      }
    }

    .error-message {
      padding: 0.75rem 1rem;
      background: var(--danger-bg, #f8d7da);
      color: var(--danger-text, #721c24);
      border-radius: 6px;
      font-size: 0.875rem;
    }

    .success-message {
      padding: 0.75rem 1rem;
      background: var(--success-bg, #d4edda);
      color: var(--success-text, #155724);
      border-radius: 6px;
      font-size: 0.875rem;

      a {
        color: var(--accent-primary);
        text-decoration: underline;
        margin-left: 0.5rem;
      }
    }

    .info-section {
      padding: 1.5rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        font-weight: 600;
      }

      p {
        margin: 0 0 0.5rem;
        font-size: 0.875rem;
        color: var(--text-secondary);
        line-height: 1.5;
      }

      .device-info {
        color: var(--text-primary);
      }

      .error {
        margin-top: 1rem;
        padding: 0.75rem;
        background: var(--danger-bg, #f8d7da);
        border-radius: 4px;
        color: var(--danger-text, #721c24);
      }
    }
  `]
})
export class PostProcessingComponent implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly router = inject(Router);
  private unsubscribeProgress?: () => void;

  // State
  readonly isAvailable = signal(false);
  readonly availabilityError = signal<string | null>(null);
  readonly deviceInfo = signal<string | null>(null);
  readonly checkingAvailability = signal(true);
  readonly files = signal<AudioFile[]>([]);
  readonly isDragging = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly queuedCount = signal(0);

  // Output configuration - default to same-folder mode with _enhanced suffix
  // (replace mode should only be used from the book panel's Enhance tab)
  readonly outputMode = signal<OutputMode>('same-folder');
  readonly customOutputPath = signal('');

  // Computed
  readonly selectedCount = computed(() =>
    this.files().filter(f => f.selected).length
  );

  readonly selectedFiles = computed(() =>
    this.files().filter(f => f.selected)
  );

  ngOnInit(): void {
    this.checkAvailability();
    this.setupProgressListener();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
  }

  private async checkAvailability(): Promise<void> {
    console.log('[PostProcessing] Checking Resemble Enhance availability...');
    this.checkingAvailability.set(true);
    const result = await this.electron.resembleCheckAvailable();
    console.log('[PostProcessing] Availability result:', JSON.stringify(result));
    this.isAvailable.set(result.available);
    this.availabilityError.set(result.error || null);
    this.checkingAvailability.set(false);

    // Set device info
    if (result.available && result.device) {
      const deviceName = result.device.toUpperCase();
      const wslSuffix = result.usingWsl ? ' (WSL)' : '';
      this.deviceInfo.set(`${deviceName}${wslSuffix}`);
    }
  }

  private setupProgressListener(): void {
    this.unsubscribeProgress = this.electron.onResembleProgress((progress) => {
      // Progress is now handled by the queue system
      // This listener is kept for backwards compatibility
      console.log('[PostProcessing] Progress:', progress);
    });
  }

  // Drag and drop handlers
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const supportedExtensions = ['m4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'opus'];
    const newFiles: AudioFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split('.').pop()?.toLowerCase() || '';

      if (supportedExtensions.includes(ext)) {
        // Get the file path - this works in Electron
        const filePath = (file as any).path;
        if (filePath) {
          newFiles.push({
            name: file.name,
            path: filePath,
            size: file.size,
            modifiedAt: new Date(file.lastModified),
            format: ext.toUpperCase(),
            selected: true
          });
        }
      }
    }

    if (newFiles.length > 0) {
      // Add to existing files, avoiding duplicates
      const existingPaths = new Set(this.files().map(f => f.path));
      const uniqueNewFiles = newFiles.filter(f => !existingPaths.has(f.path));
      this.files.update(files => [...files, ...uniqueNewFiles]);
    }
  }

  async pickFiles(): Promise<void> {
    const result = await this.electron.resemblePickFiles();
    if (result.success && result.data && result.data.length > 0) {
      // Add picked files to the list, avoiding duplicates
      const existingPaths = new Set(this.files().map(f => f.path));
      const newFiles = result.data
        .filter(f => !existingPaths.has(f.path))
        .map(f => ({ ...f, selected: true }));

      if (newFiles.length > 0) {
        this.files.update(files => [...files, ...newFiles]);
      }
    }
  }

  clearFiles(): void {
    this.files.set([]);
    this.queuedCount.set(0);
    this.lastError.set(null);
  }

  toggleFile(file: AudioFile): void {
    this.files.update(files =>
      files.map(f =>
        f.path === file.path ? { ...f, selected: !f.selected } : f
      )
    );
  }

  setOutputMode(mode: OutputMode): void {
    this.outputMode.set(mode);
  }

  async browseOutputFolder(): Promise<void> {
    const result = await this.electron.openFolderDialog();
    if (result.success && result.folderPath) {
      this.customOutputPath.set(result.folderPath);
    }
  }

  async addToQueue(): Promise<void> {
    const selected = this.selectedFiles();
    if (selected.length === 0) return;

    this.lastError.set(null);
    let addedCount = 0;

    try {
      for (const file of selected) {
        // Determine output path based on mode
        let outputPath: string | undefined;
        const mode = this.outputMode();

        if (mode === 'same-folder') {
          // Add _enhanced suffix before extension
          const dir = file.path.substring(0, file.path.lastIndexOf('/'));
          const ext = file.path.substring(file.path.lastIndexOf('.'));
          const basename = file.path.substring(file.path.lastIndexOf('/') + 1, file.path.lastIndexOf('.'));
          outputPath = `${dir}/${basename}_enhanced${ext}`;
        } else if (mode === 'custom') {
          const customDir = this.customOutputPath();
          if (!customDir) {
            this.lastError.set('Please select an output folder');
            return;
          }
          outputPath = `${customDir}/${file.name}`;
        }
        // For 'replace' mode, outputPath stays undefined (will replace original)

        await this.queueService.addJob({
          type: 'resemble-enhance',
          epubPath: file.path, // Using epubPath field for the audio file path
          config: {
            type: 'resemble-enhance',
            inputPath: file.path,
            outputPath,
            replaceOriginal: mode === 'replace'
          },
          metadata: {
            title: file.name
          }
        });

        addedCount++;
      }

      this.queuedCount.set(addedCount);

      // Deselect queued files
      this.files.update(files =>
        files.map(f => ({ ...f, selected: false }))
      );

    } catch (err) {
      console.error('[PostProcessing] Failed to add jobs to queue:', err);
      this.lastError.set(err instanceof Error ? err.message : 'Failed to add to queue');
    }
  }

  goToQueue(): void {
    this.router.navigate(['/queue']);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  getFormatIcon(format: string): string {
    switch (format.toUpperCase()) {
      case 'M4B':
      case 'M4A':
        return '\uD83C\uDFA7'; // Headphones
      case 'MP3':
        return '\uD83C\uDFB5'; // Musical note
      case 'WAV':
      case 'FLAC':
        return '\uD83C\uDF9B'; // Control knobs
      default:
        return '\uD83D\uDCBE'; // Floppy disk
    }
  }
}

import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../core/services/electron.service';
import { SettingsService } from '../../core/services/settings.service';
import { LibraryService } from '../../core/services/library.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';

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

@Component({
  selector: 'app-post-processing',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="post-processing">
      <header class="header">
        <h1>Post-Processing</h1>
        <p class="subtitle">Enhance audiobooks using Resemble Enhance</p>
      </header>

      @if (!isAvailable()) {
        <div class="warning-banner">
          <span class="warning-icon">&#9888;</span>
          <div>
            <strong>Resemble Enhance not available</strong>
            <p>{{ availabilityError() || 'Please set up the resemble conda environment. See AUDIO_ENHANCEMENT.md for instructions.' }}</p>
          </div>
        </div>
      }

      <div class="content">
        <!-- File List -->
        <section class="file-list-section">
          <div class="section-header">
            <h2>Audio Files</h2>
            <desktop-button
              variant="ghost"
              size="sm"
              [disabled]="isProcessing()"
              (click)="refreshFiles()"
            >
              Refresh
            </desktop-button>
          </div>

          @if (loading()) {
            <div class="loading">Loading files...</div>
          } @else if (files().length === 0) {
            <div class="empty-state">
              <p>No audio files found in the audiobooks output folder.</p>
              <p class="hint">Configure the output folder in Settings > Audiobook.</p>
            </div>
          } @else {
            <div class="file-grid">
              @for (file of files(); track file.path) {
                <div
                  class="file-card"
                  [class.selected]="file.selected"
                  [class.disabled]="isProcessing()"
                  (click)="toggleFile(file)"
                >
                  <div class="file-icon">{{ getFormatIcon(file.format) }}</div>
                  <div class="file-info">
                    <div class="file-name" [title]="file.name">{{ file.name }}</div>
                    <div class="file-meta">
                      <span class="format">{{ file.format }}</span>
                      <span class="size">{{ formatSize(file.size) }}</span>
                      <span class="date">{{ formatDate(file.modifiedAt) }}</span>
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
          }
        </section>

        <!-- Actions -->
        <section class="actions-section">
          <div class="selection-info">
            {{ selectedCount() }} file{{ selectedCount() === 1 ? '' : 's' }} selected
          </div>

          @if (isProcessing()) {
            <div class="progress-panel">
              <div class="progress-header">
                <span class="phase">{{ currentProgress()?.message || 'Processing...' }}</span>
                <span class="percentage">{{ currentProgress()?.percentage || 0 }}%</span>
              </div>
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  [style.width.%]="currentProgress()?.percentage || 0"
                ></div>
              </div>
              <div class="progress-file">{{ currentFile() }}</div>
              <desktop-button
                variant="danger"
                size="sm"
                (click)="cancelProcessing()"
              >
                Cancel
              </desktop-button>
            </div>
          } @else {
            <desktop-button
              variant="primary"
              [disabled]="selectedCount() === 0 || !isAvailable()"
              (click)="startProcessing()"
            >
              Enhance Selected Files
            </desktop-button>
          }

          @if (lastError()) {
            <div class="error-message">
              {{ lastError() }}
            </div>
          }

          @if (completedCount() > 0 && !isProcessing()) {
            <div class="success-message">
              Successfully enhanced {{ completedCount() }} file{{ completedCount() === 1 ? '' : 's' }}
            </div>
          }
        </section>

        <!-- Info Panel -->
        <section class="info-section">
          <h3>About Resemble Enhance</h3>
          <p>
            Resemble Enhance is a deep learning audio enhancement tool that removes
            reverb, echo, and improves speech quality. It works better than DeepFilterNet
            for TTS artifacts like the baked-in reverb in Orpheus output.
          </p>
          <p class="warning">
            <strong>Note:</strong> Processing will replace the original file. Enhancement
            may take several minutes per file (roughly 2.5x audio length on CPU).
          </p>
        </section>
      </div>
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

    .warning-banner {
      display: flex;
      gap: 1rem;
      padding: 1rem 2rem;
      background: var(--warning-bg, #fff3cd);
      border-bottom: 1px solid var(--warning-border, #ffc107);
      color: var(--warning-text, #856404);

      .warning-icon {
        font-size: 1.5rem;
      }

      p {
        margin: 0.25rem 0 0;
        font-size: 0.875rem;
      }
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .file-list-section {
      flex: 1;
      min-height: 200px;

      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;

        h2 {
          margin: 0;
          font-size: 1.125rem;
          font-weight: 600;
        }
      }
    }

    .loading, .empty-state {
      padding: 2rem;
      text-align: center;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border-radius: 8px;

      .hint {
        font-size: 0.875rem;
        margin-top: 0.5rem;
      }
    }

    .file-grid {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
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

      &:hover:not(.disabled) {
        border-color: var(--border-hover);
        background: var(--bg-subtle);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }

      &.disabled {
        opacity: 0.6;
        cursor: not-allowed;
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
    }

    .progress-panel {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      align-items: center;

      .progress-header {
        width: 100%;
        display: flex;
        justify-content: space-between;
        font-size: 0.875rem;

        .percentage {
          font-weight: 600;
        }
      }

      .progress-bar {
        width: 100%;
        height: 8px;
        background: var(--bg-default);
        border-radius: 4px;
        overflow: hidden;

        .progress-fill {
          height: 100%;
          background: var(--accent-primary);
          transition: width 0.3s ease;
        }
      }

      .progress-file {
        font-size: 0.75rem;
        color: var(--text-secondary);
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

      .warning {
        margin-top: 1rem;
        padding: 0.75rem;
        background: var(--bg-elevated);
        border: 1px solid var(--border-default);
        border-radius: 4px;
        color: var(--text-secondary);
      }
    }
  `]
})
export class PostProcessingComponent implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private unsubscribeProgress?: () => void;

  // State
  readonly isAvailable = signal(false);
  readonly availabilityError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly files = signal<AudioFile[]>([]);
  readonly isProcessing = signal(false);
  readonly currentProgress = signal<EnhanceProgress | null>(null);
  readonly currentFile = signal<string>('');
  readonly lastError = signal<string | null>(null);
  readonly completedCount = signal(0);

  // Computed
  readonly selectedCount = computed(() =>
    this.files().filter(f => f.selected).length
  );

  readonly selectedFiles = computed(() =>
    this.files().filter(f => f.selected)
  );

  ngOnInit(): void {
    this.checkAvailability();
    this.refreshFiles();
    this.setupProgressListener();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
  }

  private async checkAvailability(): Promise<void> {
    console.log('[PostProcessing] Checking Resemble Enhance availability...');
    const result = await this.electron.resembleCheckAvailable();
    console.log('[PostProcessing] Availability result:', JSON.stringify(result));
    console.log('[PostProcessing] available:', result.available, 'error:', result.error);
    this.isAvailable.set(result.available);
    this.availabilityError.set(result.error || null);
  }

  private setupProgressListener(): void {
    this.unsubscribeProgress = this.electron.onResembleProgress((progress) => {
      this.currentProgress.set(progress);

      if (progress.phase === 'complete') {
        this.completedCount.update(c => c + 1);
        this.processNextFile();
      } else if (progress.phase === 'error') {
        this.lastError.set(progress.error || 'Unknown error');
        this.isProcessing.set(false);
      }
    });
  }

  async refreshFiles(): Promise<void> {
    this.loading.set(true);
    this.lastError.set(null);

    try {
      const configuredDir = this.settings.get<string>('audiobookOutputDir');
      const libraryAudiobooksPath = this.libraryService.audiobooksPath();
      const audiobooksDir = configuredDir || libraryAudiobooksPath;

      console.log('[PostProcessing] Configured dir:', configuredDir);
      console.log('[PostProcessing] Library audiobooks path:', libraryAudiobooksPath);
      console.log('[PostProcessing] Using:', audiobooksDir);

      if (!audiobooksDir) {
        console.error('[PostProcessing] No audiobooks directory - library path not set');
        this.lastError.set('Library not configured. Complete onboarding first.');
        this.files.set([]);
        return;
      }

      const result = await this.electron.resembleListFiles(audiobooksDir);
      console.log('[PostProcessing] List files result:', result.success, 'count:', result.data?.length);

      if (result.success && result.data) {
        this.files.set(result.data.map(f => ({ ...f, selected: false })));
      } else {
        this.files.set([]);
        if (result.error) {
          console.error('[PostProcessing] Failed to list files:', result.error);
        }
      }
    } catch (err) {
      console.error('[PostProcessing] Error refreshing files:', err);
      this.files.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  toggleFile(file: AudioFile): void {
    console.log('[PostProcessing] toggleFile called for:', file.name, 'isProcessing:', this.isProcessing());
    if (this.isProcessing()) return;

    this.files.update(files =>
      files.map(f =>
        f.path === file.path ? { ...f, selected: !f.selected } : f
      )
    );
    console.log('[PostProcessing] Selected count after toggle:', this.selectedCount());
  }

  async startProcessing(): Promise<void> {
    console.log('[PostProcessing] startProcessing called, isAvailable:', this.isAvailable(), 'selectedCount:', this.selectedCount());
    const selected = this.selectedFiles();
    console.log('[PostProcessing] Starting processing, selected files:', selected.length);
    if (selected.length === 0) {
      console.log('[PostProcessing] No files selected');
      return;
    }

    this.isProcessing.set(true);
    this.lastError.set(null);
    this.completedCount.set(0);

    // Start with the first file
    this.processNextFile();
  }

  private filesToProcess: AudioFile[] = [];
  private currentIndex = 0;

  private async processNextFile(): Promise<void> {
    // Initialize queue if starting
    if (this.completedCount() === 0 && this.currentIndex === 0) {
      this.filesToProcess = [...this.selectedFiles()];
      this.currentIndex = 0;
      console.log('[PostProcessing] Initialized queue with', this.filesToProcess.length, 'files');
    }

    // Check if we're done
    if (this.currentIndex >= this.filesToProcess.length) {
      console.log('[PostProcessing] All files processed');
      this.isProcessing.set(false);
      this.currentProgress.set(null);
      this.currentFile.set('');
      this.filesToProcess = [];
      this.currentIndex = 0;
      // Refresh file list to show updated files
      this.refreshFiles();
      return;
    }

    const file = this.filesToProcess[this.currentIndex];
    console.log('[PostProcessing] Processing file:', file.name, 'path:', file.path);
    this.currentFile.set(file.name);
    this.currentIndex++;

    const result = await this.electron.resembleEnhance(file.path);
    console.log('[PostProcessing] Enhance result:', result);

    if (!result.success) {
      console.error('[PostProcessing] Enhancement failed:', result.error);
      this.lastError.set(result.error || 'Failed to process file');
      this.isProcessing.set(false);
    }
    // Progress events will handle the rest
  }

  async cancelProcessing(): Promise<void> {
    await this.electron.resembleCancel();
    this.isProcessing.set(false);
    this.currentProgress.set(null);
    this.currentFile.set('');
    this.filesToProcess = [];
    this.currentIndex = 0;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  formatDate(date: Date): string {
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

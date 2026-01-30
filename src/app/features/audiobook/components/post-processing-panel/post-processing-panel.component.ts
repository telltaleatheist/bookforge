import { Component, input, output, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueService } from '../../../queue/services/queue.service';

export type EnhancementStatus = 'none' | 'pending' | 'processing' | 'complete' | 'error';

@Component({
  selector: 'app-post-processing-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="post-processing-panel">
      <div class="panel-header">
        <h3>Audio Enhancement</h3>
        <p class="subtitle">Remove reverb and enhance speech quality using Resemble Enhance</p>
      </div>

      <!-- No audio file linked -->
      @if (!audioFilePath()) {
        <div class="no-audio-section">
          <div class="no-audio-icon">&#127911;</div>
          <p>No audio file found for this project.</p>
          <p class="hint">If you've moved the audiobook to a different location, you can link it manually.</p>
          <desktop-button
            variant="primary"
            (click)="browseForAudio()"
          >
            Link Audio File
          </desktop-button>
        </div>
      } @else {
        <!-- Audio file info -->
        <div class="audio-file-section">
          <div class="audio-file-info">
            <span class="audio-file-label">Audio File:</span>
            <span class="audio-file-path" [title]="audioFilePath()">{{ getFilename(audioFilePath()) }}</span>
          </div>
          <desktop-button
            variant="ghost"
            size="xs"
            (click)="browseForAudio()"
            title="Change linked audio file"
          >
            Change
          </desktop-button>
        </div>

        <div class="status-section">
          <div class="status-badge" [class]="enhancementStatus()">
            @switch (enhancementStatus()) {
              @case ('none') {
                <span class="badge">Not Enhanced</span>
              }
              @case ('pending') {
                <span class="badge pending">Queued</span>
              }
              @case ('processing') {
                <span class="badge processing">
                  <span class="spinner"></span>
                  Processing...
                </span>
              }
              @case ('complete') {
                <span class="badge complete">Enhanced</span>
              }
              @case ('error') {
                <span class="badge error">Error</span>
              }
            }
          </div>

          @if (enhancedAt()) {
            <div class="timestamp">
              Enhanced on {{ formatDate(enhancedAt()!) }}
            </div>
          }
        </div>

        @if (enhancementStatus() === 'processing' && enhancementProgress() !== undefined) {
          <div class="progress-section">
            <div class="progress-bar">
              <div
                class="progress-fill"
                [style.width.%]="enhancementProgress()"
              ></div>
            </div>
            <div class="progress-text">{{ enhancementProgress() }}%</div>
          </div>
        }

        @if (enhancementError()) {
          <div class="error-message">
            {{ enhancementError() }}
          </div>
        }

        <div class="actions">
          @if (enhancementStatus() === 'none' || enhancementStatus() === 'error') {
            <desktop-button
              variant="primary"
              [disabled]="!isAvailable()"
              (click)="addToQueue()"
            >
              Add to Queue
            </desktop-button>
          } @else if (enhancementStatus() === 'complete') {
            <desktop-button
              variant="secondary"
              [disabled]="!isAvailable()"
              (click)="addToQueue()"
            >
              Re-enhance
            </desktop-button>
          } @else if (enhancementStatus() === 'pending') {
            <desktop-button
              variant="ghost"
              (click)="goToQueue()"
            >
              View in Queue
            </desktop-button>
          }

          @if (!isAvailable()) {
            <p class="warning">Resemble Enhance is not available. Check Settings for setup.</p>
          }
        </div>
      }

      <div class="info-section">
        <h4>About Resemble Enhance</h4>
        <p>
          Resemble Enhance is a deep learning audio enhancement tool that removes
          reverb, echo, and improves speech quality. It works especially well for
          TTS artifacts like the baked-in reverb in Orpheus output.
        </p>
        <p class="note">
          <strong>Note:</strong> Enhancement replaces the original audiobook file.
          GPU processing is roughly 10x faster than real-time.
        </p>
      </div>
    </div>
  `,
  styles: [`
    .post-processing-panel {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .panel-header {
      h3 {
        margin: 0 0 0.25rem;
        font-size: 1.125rem;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }
    }

    .no-audio-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 2rem;
      background: var(--bg-subtle);
      border-radius: 8px;
      border: 1px dashed var(--border-default);

      .no-audio-icon {
        font-size: 2.5rem;
        opacity: 0.5;
        margin-bottom: 0.75rem;
      }

      p {
        margin: 0 0 0.5rem;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .hint {
        font-size: 0.75rem;
        color: var(--text-muted);
        margin-bottom: 1rem;
      }
    }

    .audio-file-section {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-subtle);
      border-radius: 6px;
      border: 1px solid var(--border-default);
    }

    .audio-file-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .audio-file-label {
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    .audio-file-path {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .status-badge {
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border-radius: 6px;
        font-size: 0.875rem;
        font-weight: 500;
        background: var(--bg-subtle);
        color: var(--text-secondary);

        &.pending {
          background: var(--warning-bg, #fef3cd);
          color: var(--warning-text, #856404);
        }

        &.processing {
          background: var(--accent-subtle);
          color: var(--accent-primary);
        }

        &.complete {
          background: var(--success-bg, #d4edda);
          color: var(--success-text, #155724);
        }

        &.error {
          background: var(--danger-bg, #f8d7da);
          color: var(--danger-text, #721c24);
        }
      }
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .timestamp {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .progress-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .progress-bar {
      flex: 1;
      height: 8px;
      background: var(--bg-subtle);
      border-radius: 4px;
      overflow: hidden;

      .progress-fill {
        height: 100%;
        background: var(--accent-primary);
        transition: width 0.3s ease;
      }
    }

    .progress-text {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-primary);
      min-width: 40px;
      text-align: right;
    }

    .error-message {
      padding: 0.75rem 1rem;
      background: var(--danger-bg, #f8d7da);
      color: var(--danger-text, #721c24);
      border-radius: 6px;
      font-size: 0.875rem;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 1rem;

      .warning {
        margin: 0;
        font-size: 0.8125rem;
        color: var(--warning-text, #856404);
      }
    }

    .info-section {
      padding: 1rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      h4 {
        margin: 0 0 0.5rem;
        font-size: 0.875rem;
        font-weight: 600;
      }

      p {
        margin: 0 0 0.5rem;
        font-size: 0.8125rem;
        color: var(--text-secondary);
        line-height: 1.5;

        &:last-child {
          margin-bottom: 0;
        }
      }

      .note {
        margin-top: 0.75rem;
        padding: 0.5rem 0.75rem;
        background: var(--bg-elevated);
        border: 1px solid var(--border-default);
        border-radius: 4px;
      }
    }
  `]
})
export class PostProcessingPanelComponent implements OnInit, OnDestroy {
  private readonly queueService = inject(QueueService);
  private unsubscribeProgress?: () => void;

  // Inputs
  readonly audioFilePath = input<string>('');
  readonly projectId = input<string>('');
  readonly bfpPath = input<string>('');
  readonly bookTitle = input<string>('');
  readonly bookAuthor = input<string>('');
  readonly enhancementStatus = input<EnhancementStatus>('none');
  readonly enhancedAt = input<string | undefined>(undefined);

  // Outputs
  readonly jobQueued = output<string>(); // Emits job ID when queued
  readonly linkAudio = output<string>(); // Emits path when user links an audio file

  // State
  readonly isAvailable = signal(false);
  readonly enhancementProgress = signal<number | undefined>(undefined);
  readonly enhancementError = signal<string | null>(null);

  // Check for the current job in the queue
  readonly currentJob = computed(() => {
    const projectId = this.projectId();
    if (!projectId) return null;

    // Find a job for this project
    return this.queueService.jobs().find(
      job => job.type === 'resemble-enhance' &&
             (job.config as any)?.projectId === projectId
    );
  });

  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron
      ? (window as any).electron
      : null;
  }

  ngOnInit(): void {
    this.checkAvailability();
    this.setupProgressListener();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
  }

  private async checkAvailability(): Promise<void> {
    if (!this.electron?.resemble) {
      this.isAvailable.set(false);
      return;
    }

    const result = await this.electron.resemble.checkAvailable();
    this.isAvailable.set(result.success && result.data?.available);
  }

  private setupProgressListener(): void {
    if (!this.electron?.resemble) return;

    this.unsubscribeProgress = this.electron.resemble.onProgress((progress: any) => {
      // Check if this progress is for our file
      // The progress events come through the general listener
      if (progress.percentage !== undefined) {
        this.enhancementProgress.set(progress.percentage);
      }
      if (progress.error) {
        this.enhancementError.set(progress.error);
      }
    });
  }

  async addToQueue(): Promise<void> {
    const filePath = this.audioFilePath();
    if (!filePath) return;

    // Normalize path separators for cross-platform compatibility
    const normalizedPath = filePath.replace(/\\/g, '/');

    try {
      const job = await this.queueService.addJob({
        type: 'resemble-enhance',
        epubPath: normalizedPath, // Using epubPath field for the audio file path
        config: {
          type: 'resemble-enhance',
          inputPath: normalizedPath,
          projectId: this.projectId(),
          bfpPath: this.bfpPath(),
          replaceOriginal: true
        },
        bfpPath: this.bfpPath(),
        metadata: {
          title: this.bookTitle() || 'Audio Enhancement',
          author: this.bookAuthor()
        }
      });

      this.jobQueued.emit(job.id);
      console.log('[PostProcessingPanel] Job queued:', job.id);
    } catch (err) {
      console.error('[PostProcessingPanel] Failed to add job to queue:', err);
      this.enhancementError.set(err instanceof Error ? err.message : 'Failed to add to queue');
    }
  }

  goToQueue(): void {
    // Navigate to queue page - this should be handled by the parent component
    // For now, we'll use window location
    if (typeof window !== 'undefined') {
      // The parent audiobook component can listen for this and handle navigation
      window.dispatchEvent(new CustomEvent('navigate-to-queue'));
    }
  }

  formatDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  getFilename(path: string): string {
    if (!path) return '';
    // Handle both forward and back slashes
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }

  async browseForAudio(): Promise<void> {
    if (!this.electron?.dialog) return;

    try {
      const result = await this.electron.dialog.openAudio();

      if (result.success && result.filePath) {
        this.linkAudio.emit(result.filePath);
      }
    } catch (err) {
      console.error('[PostProcessingPanel] Error opening file dialog:', err);
    }
  }
}

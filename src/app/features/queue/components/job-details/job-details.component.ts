/**
 * Job Details Component - Displays detailed info for a selected job (when not processing)
 */

import { Component, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueJob, OcrCleanupConfig, TtsConversionConfig } from '../../models/queue.types';

@Component({
  selector: 'app-job-details',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    @if (job(); as selectedJob) {
      <div class="details-panel">
        <!-- Header with status badge -->
        <div class="details-header">
          <div class="status-badge" [class]="selectedJob.status">
            @switch (selectedJob.status) {
              @case ('pending') {
                <span class="icon">&#9711;</span>
                <span>Pending</span>
              }
              @case ('processing') {
                <span class="icon spinning">&#10227;</span>
                <span>Processing</span>
              }
              @case ('complete') {
                <span class="icon">&#10003;</span>
                <span>Complete</span>
              }
              @case ('error') {
                <span class="icon">&#10007;</span>
                <span>Error</span>
              }
            }
          </div>
          <div class="header-actions">
            @if (selectedJob.status === 'pending') {
              <desktop-button variant="primary" size="xs" (click)="runNow.emit(selectedJob.id)">
                &#9654; Run Now
              </desktop-button>
              <desktop-button variant="ghost" size="xs" (click)="remove.emit(selectedJob.id)">
                Remove
              </desktop-button>
            }
            @if (selectedJob.status === 'error') {
              <desktop-button variant="primary" size="xs" (click)="retry.emit(selectedJob.id)">
                Retry
              </desktop-button>
              <desktop-button variant="ghost" size="xs" (click)="remove.emit(selectedJob.id)">
                Remove
              </desktop-button>
            }
            @if (selectedJob.status === 'complete') {
              <desktop-button variant="ghost" size="xs" (click)="remove.emit(selectedJob.id)">
                Remove
              </desktop-button>
            }
          </div>
        </div>

        <!-- Job Type -->
        <div class="job-type-section">
          @if (selectedJob.type === 'ocr-cleanup') {
            <span class="type-icon">&#128221;</span>
            <span class="type-label">OCR Cleanup</span>
          } @else if (selectedJob.type === 'tts-conversion') {
            <span class="type-icon">&#127911;</span>
            <span class="type-label">TTS Conversion</span>
          }
        </div>

        <!-- Book Info -->
        <div class="info-section">
          <h4>Book</h4>
          <div class="info-row">
            <span class="info-label">Title</span>
            <span class="info-value">{{ selectedJob.metadata?.title || 'Untitled' }}</span>
          </div>
          @if (selectedJob.metadata?.author) {
            <div class="info-row">
              <span class="info-label">Author</span>
              <span class="info-value">{{ selectedJob.metadata!.author }}</span>
            </div>
          }
        </div>

        <!-- Configuration -->
        @if (selectedJob.config) {
          <div class="info-section">
            <h4>Configuration</h4>
            @if (isOcrConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">AI Provider</span>
                <span class="info-value">{{ formatProvider(selectedJob.config.aiProvider) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Model</span>
                <span class="info-value">{{ selectedJob.config.aiModel }}</span>
              </div>
            }
            @if (isTtsConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">Device</span>
                <span class="info-value">{{ selectedJob.config.device.toUpperCase() }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Voice Model</span>
                <span class="info-value">{{ selectedJob.config.fineTuned }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">TTS Engine</span>
                <span class="info-value">{{ selectedJob.config.ttsEngine }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Language</span>
                <span class="info-value">{{ selectedJob.config.language }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Speed</span>
                <span class="info-value">{{ selectedJob.config.speed }}x</span>
              </div>
            }
          </div>
        }

        <!-- Timestamps -->
        <div class="info-section">
          <h4>Timeline</h4>
          <div class="info-row">
            <span class="info-label">Added</span>
            <span class="info-value">{{ formatDateTime(selectedJob.addedAt) }}</span>
          </div>
          @if (selectedJob.startedAt) {
            <div class="info-row">
              <span class="info-label">Started</span>
              <span class="info-value">{{ formatDateTime(selectedJob.startedAt) }}</span>
            </div>
          }
          @if (selectedJob.completedAt) {
            <div class="info-row">
              <span class="info-label">Completed</span>
              <span class="info-value">{{ formatDateTime(selectedJob.completedAt) }}</span>
            </div>
          }
          @if (selectedJob.startedAt && selectedJob.completedAt) {
            <div class="info-row">
              <span class="info-label">Duration</span>
              <span class="info-value">{{ formatDuration(selectedJob.startedAt, selectedJob.completedAt) }}</span>
            </div>
          }
        </div>

        <!-- Error Message -->
        @if (selectedJob.status === 'error' && selectedJob.error) {
          <div class="error-section">
            <h4>Error</h4>
            <div class="error-message">{{ selectedJob.error }}</div>
          </div>
        }

        <!-- Progress (if processing) -->
        @if (selectedJob.status === 'processing') {
          <div class="progress-section">
            <div class="progress-bar-large">
              <div class="progress-fill" [style.width.%]="selectedJob.progress || 0"></div>
            </div>
            <div class="progress-text">{{ (selectedJob.progress || 0) | number:'1.1-1' }}%</div>
          </div>
        }

        <!-- View Changes button for OCR cleanup jobs with output -->
        @if (selectedJob.type === 'ocr-cleanup' && selectedJob.outputPath) {
          <div class="diff-section">
            <desktop-button
              variant="secondary"
              size="sm"
              (click)="onViewDiff(selectedJob)"
            >
              View Changes
            </desktop-button>
            <span class="diff-hint">
              @if (selectedJob.status === 'processing') {
                See changes so far
              } @else if (selectedJob.status === 'complete') {
                Compare original vs cleaned
              }
            </span>
          </div>
        }

        <!-- Show in Finder button for completed TTS jobs -->
        @if (selectedJob.type === 'tts-conversion' && selectedJob.status === 'complete' && selectedJob.outputPath) {
          <div class="output-section">
            <desktop-button
              variant="secondary"
              size="sm"
              (click)="onShowInFolder(selectedJob.outputPath!)"
            >
              Show in Finder
            </desktop-button>
            <span class="output-hint">Open audiobook location</span>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .details-panel {
      padding: 1.5rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 8px;
    }

    .details-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.25rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border-subtle);
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.375rem 0.75rem;
      border-radius: 20px;

      .icon {
        font-size: 1rem;
      }

      &.pending {
        background: var(--bg-elevated);
        color: var(--text-secondary);
      }

      &.processing {
        background: color-mix(in srgb, var(--accent) 15%, transparent);
        color: var(--accent);
      }

      &.complete {
        background: color-mix(in srgb, var(--success) 15%, transparent);
        color: var(--success);
      }

      &.error {
        background: color-mix(in srgb, var(--error) 15%, transparent);
        color: var(--error);
      }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .header-actions {
      display: flex;
      gap: 0.5rem;
    }

    .job-type-section {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }

    .type-icon {
      font-size: 2rem;
    }

    .type-label {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .info-section {
      margin-bottom: 1.25rem;

      h4 {
        margin: 0 0 0.75rem 0;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
      }
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0.375rem 0;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .info-label {
      font-size: 0.8125rem;
      color: var(--text-secondary);
    }

    .info-value {
      font-size: 0.8125rem;
      color: var(--text-primary);
      font-weight: 500;
      text-align: right;
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .error-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);

      h4 {
        margin: 0 0 0.5rem 0;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--error);
      }
    }

    .error-message {
      font-size: 0.8125rem;
      color: var(--error);
      padding: 0.75rem;
      background: color-mix(in srgb, var(--error) 10%, transparent);
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .progress-section {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);
    }

    .progress-bar-large {
      flex: 1;
      height: 8px;
      background: var(--bg-elevated);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(
        90deg,
        var(--accent),
        color-mix(in srgb, var(--accent) 80%, var(--info))
      );
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    .progress-text {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--accent);
      min-width: 3rem;
      text-align: right;
    }

    .diff-section,
    .output-section {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);
    }

    .diff-hint,
    .output-hint {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
  `]
})
export class JobDetailsComponent {
  // Inputs
  readonly job = input<QueueJob | null>(null);

  // Outputs
  readonly remove = output<string>();
  readonly retry = output<string>();
  readonly runNow = output<string>();  // Run job standalone
  readonly viewDiff = output<{ originalPath: string; cleanedPath: string }>();
  readonly showInFolder = output<string>();

  isOcrConfig(config: any): config is OcrCleanupConfig {
    return config?.type === 'ocr-cleanup';
  }

  isTtsConfig(config: any): config is TtsConversionConfig {
    return config?.type === 'tts-conversion';
  }

  formatProvider(provider: string): string {
    switch (provider) {
      case 'ollama': return 'Ollama (Local)';
      case 'claude': return 'Claude (Anthropic)';
      case 'openai': return 'OpenAI';
      default: return provider;
    }
  }

  formatDateTime(date: Date | string | undefined): string {
    if (!date) return '-';
    const d = new Date(date);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatDuration(start: Date | string, end: Date | string): string {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    const seconds = Math.floor((endTime - startTime) / 1000);

    if (seconds < 60) {
      return `${seconds}s`;
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    }
    return `${minutes}m ${secs}s`;
  }

  onViewDiff(job: QueueJob): void {
    if (job.outputPath) {
      this.viewDiff.emit({
        originalPath: job.epubPath,
        cleanedPath: job.outputPath
      });
    }
  }

  onShowInFolder(path: string): void {
    this.showInFolder.emit(path);
  }
}

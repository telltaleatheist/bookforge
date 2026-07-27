/**
 * The details column of the queue panel: what this job IS, as opposed to how far
 * along it is. Book, configuration, timeline, error text, and the couple of
 * job-specific controls that belong with the settings rather than the progress.
 *
 * It used to be a whole alternative screen you reached instead of the progress view,
 * complete with its own duplicate progress bar. Progress now lives entirely in the
 * step cards beside it, so everything here is static per job — which is exactly why
 * it can sit in a narrow column and never compete for attention.
 */

import { Component, input, output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import {
  QueueJob,
  OcrCleanupConfig,
  TtsConversionConfig,
  BilingualTranslationJobConfig,
  BilingualCleanupJobConfig,
  BilingualAssemblyJobConfig,
  TranslationJobConfig,
  ReassemblyJobConfig
} from '../../models/queue.types';
import { QueueService } from '../../services/queue.service';

@Component({
  selector: 'app-job-details',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    @if (job(); as selectedJob) {
      <div class="details">
        <!-- Book -->
        <section class="info-section">
          <h4>Book</h4>
          <div class="info-row">
            <span class="info-label">Title</span>
            <span class="info-value" [title]="selectedJob.metadata?.title || 'Untitled'">
              {{ selectedJob.metadata?.title || 'Untitled' }}
            </span>
          </div>
          @if (selectedJob.metadata?.author) {
            <div class="info-row">
              <span class="info-label">Author</span>
              <span class="info-value" [title]="selectedJob.metadata!.author!">{{ selectedJob.metadata!.author }}</span>
            </div>
          }
        </section>

        <!-- Configuration -->
        @if (selectedJob.config) {
          <section class="info-section">
            <h4>Configuration</h4>

            @if (isOcrConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">Provider</span>
                <span class="info-value">{{ formatProvider(selectedJob.config.aiProvider) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Model</span>
                <span class="info-value" [title]="selectedJob.config.aiModel">{{ selectedJob.config.aiModel }}</span>
              </div>
              @if (selectedJob.config.simplifyForLearning) {
                <div class="info-row">
                  <span class="info-label">Mode</span>
                  <span class="info-value">Simplify for Learners</span>
                </div>
              }
              @if (selectedJob.config.useParallel && selectedJob.config.parallelWorkers) {
                <div class="info-row">
                  <span class="info-label">Workers</span>
                  <span class="info-value">{{ selectedJob.config.parallelWorkers }}</span>
                </div>
              }
              @if (selectedJob.config.testMode) {
                <div class="info-row">
                  <span class="info-label">Test Mode</span>
                  <span class="info-value">{{ selectedJob.config.testModeChunks }} chunks</span>
                </div>
              }
            }

            @if (isBilingualCleanupConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">Provider</span>
                <span class="info-value">{{ formatProvider(selectedJob.config.aiProvider) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Model</span>
                <span class="info-value" [title]="selectedJob.config.aiModel">{{ selectedJob.config.aiModel }}</span>
              </div>
              @if (selectedJob.config.simplifyForLearning) {
                <div class="info-row">
                  <span class="info-label">Mode</span>
                  <span class="info-value">Simplify for Learners</span>
                </div>
              }
              @if (selectedJob.config.testMode) {
                <div class="info-row">
                  <span class="info-label">Test Mode</span>
                  <span class="info-value">{{ selectedJob.config.testModeChunks }} chunks</span>
                </div>
              }
            }

            @if (isTtsConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">Engine</span>
                <span class="info-value">{{ capitalizeEngine(selectedJob.config.ttsEngine) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Voice</span>
                <span class="info-value" [title]="selectedJob.config.fineTuned">{{ selectedJob.config.fineTuned }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Language</span>
                <span class="info-value">{{ selectedJob.config.language }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Speed</span>
                <span class="info-value">{{ selectedJob.config.speed }}x</span>
              </div>
              <div class="info-row">
                <span class="info-label">Device</span>
                <span class="info-value">{{ selectedJob.config.device.toUpperCase() }}</span>
              </div>
              @if (selectedJob.config.useParallel && selectedJob.config.parallelWorkers) {
                <div class="info-row">
                  <span class="info-label">Workers</span>
                  <span class="info-value">{{ selectedJob.config.parallelWorkers }}</span>
                </div>
              }
            }

            @if (isTranslationConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">Provider</span>
                <span class="info-value">{{ formatProvider(selectedJob.config.aiProvider) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Model</span>
                <span class="info-value" [title]="selectedJob.config.aiModel">{{ selectedJob.config.aiModel }}</span>
              </div>
            }

            @if (isBilingualTranslationConfig(selectedJob.config)) {
              <div class="info-row">
                <span class="info-label">Provider</span>
                <span class="info-value">{{ formatProvider(selectedJob.config.aiProvider) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Model</span>
                <span class="info-value" [title]="selectedJob.config.aiModel">{{ selectedJob.config.aiModel }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Languages</span>
                <span class="info-value">{{ selectedJob.config.sourceLang }} → {{ selectedJob.config.targetLang }}</span>
              </div>
              @if (selectedJob.config.splitGranularity) {
                <div class="info-row">
                  <span class="info-label">Split</span>
                  <span class="info-value">{{ selectedJob.config.splitGranularity }}</span>
                </div>
              }
              @if (selectedJob.config.monoTranslation) {
                <div class="info-row">
                  <span class="info-label">Mode</span>
                  <span class="info-value">Mono (full book)</span>
                </div>
              }
              @if (selectedJob.config.testMode) {
                <div class="info-row">
                  <span class="info-label">Test Mode</span>
                  <span class="info-value">{{ selectedJob.config.testModeChunks }} chunks</span>
                </div>
              }
            }

            @if (isBilingualAssemblyConfig(selectedJob.config)) {
              @if (selectedJob.config.sourceLang && selectedJob.config.targetLang) {
                <div class="info-row">
                  <span class="info-label">Languages</span>
                  <span class="info-value">{{ selectedJob.config.sourceLang }} → {{ selectedJob.config.targetLang }}</span>
                </div>
              }
              @if (selectedJob.config.pauseDuration !== undefined) {
                <div class="info-row">
                  <span class="info-label">Pause</span>
                  <span class="info-value">{{ selectedJob.config.pauseDuration }}s</span>
                </div>
              }
              @if (selectedJob.config.gapDuration !== undefined) {
                <div class="info-row">
                  <span class="info-label">Gap</span>
                  <span class="info-value">{{ selectedJob.config.gapDuration }}s</span>
                </div>
              }
              @if (selectedJob.config.pattern) {
                <div class="info-row">
                  <span class="info-label">Pattern</span>
                  <span class="info-value">{{ selectedJob.config.pattern }}</span>
                </div>
              }
            }

            @if (isReassemblyConfig(selectedJob.config)) {
              @if (selectedJob.config.sessionId) {
                <div class="info-row">
                  <span class="info-label">Session</span>
                  <span class="info-value" [title]="selectedJob.config.sessionId">
                    {{ selectedJob.config.sessionId.slice(0, 8) }}…
                  </span>
                </div>
              }
              @if (selectedJob.config.excludedChapters.length > 0) {
                <div class="info-row">
                  <span class="info-label">Excluded</span>
                  <span class="info-value">{{ selectedJob.config.excludedChapters.length }} chapters</span>
                </div>
              }
            }
          </section>
        }

        <!-- Bilingual translation: the one setting editable from the queue -->
        @if (isBilingualTranslationConfig(selectedJob.config)) {
          <section class="info-section">
            <h4>Alignment</h4>
            <label class="checkbox-label">
              <input
                type="checkbox"
                [checked]="selectedJob.config.autoApproveAlignment !== false"
                (change)="onAutoApproveAlignmentChange(selectedJob, $event)"
                [disabled]="selectedJob.status !== 'pending'"
              >
              <span class="checkbox-text">Auto-approve if aligned</span>
            </label>
            <p class="checkbox-hint">
              TTS starts automatically when sentence counts match. The preview window
              still appears for review.
            </p>
          </section>
        }

        <!-- Timeline -->
        <section class="info-section">
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
        </section>

        <!-- Warnings the job raised while it ran -->
        @if (selectedJob.copyrightIssuesDetected) {
          <div class="warning">
            &#9888; Copyright issues: {{ selectedJob.copyrightChunksAffected }} chunks used original text. Try Ollama.
          </div>
        }
        @if (selectedJob.contentSkipsDetected) {
          <div class="warning">
            @if (selectedJob.type === 'book-analysis') {
              &#9888; Analysis gaps: {{ selectedJob.contentSkipsAffected }} transcript ranges could not be analyzed.
            } @else {
              &#9888; Content skips: {{ selectedJob.contentSkipsAffected }} chunks refused by AI. Try Ollama.
            }
          </div>
        }
        @if (selectedJob.translationFailedChunks) {
          <div class="warning">
            &#9888; {{ selectedJob.translationFailedChunks }} chunks kept original (untranslated) text.
          </div>
        }

        <!-- Error -->
        @if (selectedJob.status === 'error' && selectedJob.error) {
          <section class="info-section">
            <h4 class="error-heading">Error</h4>
            <div class="error-message">{{ selectedJob.error }}</div>
          </section>
        }

        <!-- Output actions -->
        @if (selectedJob.type === 'ocr-cleanup' && selectedJob.outputPath) {
          <div class="action-row">
            <desktop-button variant="secondary" size="sm" (click)="onViewDiff(selectedJob)">
              View Changes
            </desktop-button>
            <span class="action-hint">
              @if (selectedJob.status === 'processing') { See changes so far }
              @else { Compare original vs cleaned }
            </span>
          </div>
        }

        @if (selectedJob.type === 'tts-conversion' && selectedJob.status === 'complete' && selectedJob.outputPath) {
          <div class="action-row">
            <desktop-button variant="secondary" size="sm" (click)="onShowInFolder(selectedJob.outputPath!)">
              Show in Folder
            </desktop-button>
            <span class="action-hint">Open audiobook location</span>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
    }

    .details {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 0.75rem 0.875rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
    }

    .info-section h4 {
      margin: 0 0 0.4rem 0;
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
    }

    .info-section h4.error-heading {
      color: var(--error);
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.25rem 0;
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .info-label {
      flex-shrink: 0;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .info-value {
      min-width: 0;
      font-size: 0.75rem;
      color: var(--text-primary);
      font-weight: 500;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .warning {
      font-size: 0.6875rem;
      line-height: 1.4;
      color: var(--warning);
    }

    .error-message {
      font-size: 0.6875rem;
      line-height: 1.4;
      color: var(--error);
      padding: 0.5rem;
      background: color-mix(in srgb, var(--error) 10%, transparent);
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      font-size: 0.75rem;
      color: var(--text-primary);

      input[type="checkbox"] {
        width: 14px;
        height: 14px;
        accent-color: var(--accent);
        cursor: pointer;

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      &:has(input:disabled) {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }

    .checkbox-text {
      font-weight: 500;
    }

    .checkbox-hint {
      margin: 0.375rem 0 0 0;
      font-size: 0.6875rem;
      line-height: 1.4;
      color: var(--text-tertiary);
    }

    .action-row {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.375rem;
    }

    .action-hint {
      font-size: 0.6875rem;
      color: var(--text-tertiary);
    }
  `]
})
export class JobDetailsComponent {
  private readonly queueService = inject(QueueService);

  readonly job = input<QueueJob | null>(null);

  readonly viewDiff = output<{ originalPath: string; cleanedPath: string }>();
  readonly showInFolder = output<string>();

  isOcrConfig(config: unknown): config is OcrCleanupConfig {
    return (config as { type?: string })?.type === 'ocr-cleanup';
  }

  isTtsConfig(config: unknown): config is TtsConversionConfig {
    return (config as { type?: string })?.type === 'tts-conversion';
  }

  isBilingualCleanupConfig(config: unknown): config is BilingualCleanupJobConfig {
    return (config as { type?: string })?.type === 'bilingual-cleanup';
  }

  isBilingualTranslationConfig(config: unknown): config is BilingualTranslationJobConfig {
    return (config as { type?: string })?.type === 'bilingual-translation';
  }

  isTranslationConfig(config: unknown): config is TranslationJobConfig {
    return (config as { type?: string })?.type === 'translation';
  }

  isBilingualAssemblyConfig(config: unknown): config is BilingualAssemblyJobConfig {
    return (config as { type?: string })?.type === 'bilingual-assembly';
  }

  isReassemblyConfig(config: unknown): config is ReassemblyJobConfig {
    return (config as { type?: string })?.type === 'reassembly';
  }

  onAutoApproveAlignmentChange(job: QueueJob, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.queueService.updateJobConfig(job.id, { autoApproveAlignment: checked });
  }

  capitalizeEngine(engine: string): string {
    switch (engine.toLowerCase()) {
      case 'xtts': return 'XTTS';
      case 'orpheus': return 'Orpheus';
      default: return engine.charAt(0).toUpperCase() + engine.slice(1);
    }
  }

  formatProvider(provider: string): string {
    switch (provider) {
      case 'ollama': return 'Ollama (Local)';
      case 'claude': return 'Claude';
      case 'openai': return 'OpenAI';
      default: return provider;
    }
  }

  formatDateTime(date: Date | string | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatDuration(start: Date | string, end: Date | string): string {
    const seconds = Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    return `${minutes}m ${secs}s`;
  }

  onViewDiff(job: QueueJob): void {
    if (job.outputPath && job.epubPath) {
      this.viewDiff.emit({ originalPath: job.epubPath, cleanedPath: job.outputPath });
    }
  }

  onShowInFolder(path: string): void {
    this.showInFolder.emit(path);
  }
}

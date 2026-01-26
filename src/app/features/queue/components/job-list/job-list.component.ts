/**
 * Job List Component - Displays queue jobs with status and actions
 */

import { Component, input, output, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueJob, JobType, JobStatus } from '../../models/queue.types';

interface DragState {
  draggedIndex: number;
  dragOverIndex: number;
}

@Component({
  selector: 'app-job-list',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="job-list">
      @for (job of jobs(); track job.id; let i = $index) {
        <div
          class="job-item"
          [class.processing]="job.status === 'processing'"
          [class.complete]="job.status === 'complete'"
          [class.error]="job.status === 'error'"
          [class.selected]="job.id === selectedJobId()"
          [class.dragging]="dragState()?.draggedIndex === i"
          [class.drag-over]="dragState()?.dragOverIndex === i && dragState()?.draggedIndex !== i"
          [attr.draggable]="job.status === 'pending'"
          (click)="select.emit(job.id)"
          (dragstart)="onDragStart($event, i, job)"
          (dragover)="onDragOver($event, i, job)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event, i)"
          (dragend)="onDragEnd()"
        >
          <!-- Status indicator -->
          <div class="status-indicator" [class]="job.status">
            @switch (job.status) {
              @case ('pending') {
                <span class="icon">&#9711;</span>
              }
              @case ('processing') {
                <span class="icon spinning">&#10227;</span>
              }
              @case ('complete') {
                <span class="icon">&#10003;</span>
              }
              @case ('error') {
                <span class="icon">&#10007;</span>
              }
            }
          </div>

          <!-- Job info -->
          <div class="job-info">
            <div class="job-title">
              <span class="job-type-badge" [class]="job.type">
                {{ getJobTypeLabel(job.type) }}
              </span>
              <span class="book-title">{{ job.metadata?.title || 'Untitled' }}</span>
            </div>
            @if (job.metadata?.author) {
              <div class="job-meta">{{ job.metadata!.author }}</div>
            }
            @if (job.type === 'ocr-cleanup' && getOcrModel(job)) {
              <div class="job-meta model">&#129302; {{ getOcrModel(job) }}</div>
            }
            @if (job.type === 'translation' && getTranslationInfo(job)) {
              <div class="job-meta model">&#127760; {{ getTranslationInfo(job) }}</div>
            }
            @if (job.status === 'processing' && job.progress !== undefined) {
              <div class="progress-bar">
                <div class="progress-fill" [style.width.%]="job.progress"></div>
              </div>
            }
            @if (job.status === 'error' && job.error) {
              <div class="error-message">{{ job.error }}</div>
            }
            @if (job.status === 'complete' && job.copyrightIssuesDetected) {
              <div class="copyright-warning">
                &#9888; Copyright issues: {{ job.copyrightChunksAffected }} chunks used original text. Try Ollama.
              </div>
            }
            @if (job.status === 'complete' && job.contentSkipsDetected) {
              <div class="content-skip-warning">
                &#9888; Content skips: {{ job.contentSkipsAffected }} chunks refused by AI. Try Ollama.
              </div>
            }
          </div>

          <!-- Actions -->
          <div class="job-actions">
            @if (job.status === 'pending') {
              <desktop-button
                variant="ghost"
                size="xs"
                [iconOnly]="true"
                title="Move up"
                (click)="moveUp.emit(job.id); $event.stopPropagation()"
              >
                &#8593;
              </desktop-button>
              <desktop-button
                variant="ghost"
                size="xs"
                [iconOnly]="true"
                title="Move down"
                (click)="moveDown.emit(job.id); $event.stopPropagation()"
              >
                &#8595;
              </desktop-button>
              <button
                class="remove-btn"
                title="Remove"
                (click)="remove.emit(job.id); $event.stopPropagation()"
              >
                ✕
              </button>
            }
            @if (job.status === 'processing') {
              <button
                class="cancel-btn"
                title="Cancel"
                (click)="cancel.emit(job.id); $event.stopPropagation()"
              >
                ■
              </button>
            }
            @if (job.status === 'error') {
              <desktop-button
                variant="ghost"
                size="xs"
                [iconOnly]="true"
                title="Retry"
                (click)="retry.emit(job.id); $event.stopPropagation()"
              >
                &#8635;
              </desktop-button>
              <button
                class="remove-btn"
                title="Remove"
                (click)="remove.emit(job.id); $event.stopPropagation()"
              >
                ✕
              </button>
            }
            @if (job.status === 'complete') {
              <button
                class="remove-btn"
                title="Remove"
                (click)="remove.emit(job.id); $event.stopPropagation()"
              >
                ✕
              </button>
            }
          </div>
        </div>
      } @empty {
        <div class="empty-list">
          <p>No jobs in queue</p>
        </div>
      }
    </div>
  `,
  styles: [`
    .job-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .job-item {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      transition: all 0.15s ease;
      cursor: pointer;

      &[draggable="true"] {
        cursor: grab;

        &:active {
          cursor: grabbing;
        }
      }

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 10%, var(--bg-subtle));
      }

      &.processing {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 5%, var(--bg-subtle));
      }

      &.complete {
        border-color: var(--success);
        opacity: 0.8;

        &.selected {
          opacity: 1;
          border-color: var(--accent);
        }
      }

      &.error {
        border-color: var(--error);

        &.selected {
          border-color: var(--accent);
        }
      }

      &.dragging {
        opacity: 0.5;
        border-style: dashed;
      }

      &.drag-over {
        border-color: var(--accent);
        border-width: 2px;
        background: color-mix(in srgb, var(--accent) 10%, var(--bg-subtle));
      }
    }

    .status-indicator {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;

      .icon {
        line-height: 1;
      }

      &.pending {
        color: var(--text-secondary);
      }

      &.processing {
        color: var(--accent);
      }

      &.complete {
        color: var(--success);
      }

      &.error {
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

    .job-info {
      flex: 1;
      min-width: 0;
    }

    .job-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .job-type-badge {
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      letter-spacing: 0.02em;

      &.ocr-cleanup {
        background: var(--accent-subtle);
        color: var(--accent);
      }

      &.translation {
        background: color-mix(in srgb, var(--info) 15%, transparent);
        color: var(--info);
      }

      &.tts-conversion {
        background: var(--selected-bg-muted);
        color: var(--accent-hover);
      }
    }

    .book-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .job-meta {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      &.model {
        color: var(--text-tertiary);
        font-size: 0.6875rem;
      }
    }

    .progress-bar {
      height: 4px;
      background: var(--bg-elevated);
      border-radius: 2px;
      margin-top: 0.5rem;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .error-message {
      font-size: 0.75rem;
      color: var(--error);
      margin-top: 0.25rem;
    }

    .copyright-warning,
    .content-skip-warning {
      font-size: 0.75rem;
      color: var(--warning, #f59e0b);
      margin-top: 0.25rem;
    }

    .job-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .job-item:hover .job-actions {
      opacity: 1;
    }

    .job-item.processing .job-actions,
    .job-item.error .job-actions {
      opacity: 1;
    }

    .remove-btn,
    .cancel-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.15s ease;
    }

    .remove-btn {
      background: color-mix(in srgb, var(--error) 15%, transparent);
      color: var(--error);

      &:hover {
        background: color-mix(in srgb, var(--error) 30%, transparent);
      }
    }

    .cancel-btn {
      background: color-mix(in srgb, var(--warning, orange) 15%, transparent);
      color: var(--warning, orange);

      &:hover {
        background: color-mix(in srgb, var(--warning, orange) 30%, transparent);
      }
    }

    .empty-list {
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }
  `]
})
export class JobListComponent {
  // Inputs
  readonly jobs = input<QueueJob[]>([]);
  readonly selectedJobId = input<string | null>(null);

  // Outputs
  readonly remove = output<string>();
  readonly retry = output<string>();
  readonly cancel = output<string>();
  readonly moveUp = output<string>();
  readonly moveDown = output<string>();
  readonly select = output<string>();
  readonly reorder = output<{ fromId: string; toId: string }>();

  // Drag state
  readonly dragState = signal<DragState | null>(null);

  onDragStart(event: DragEvent, index: number, job: QueueJob): void {
    if (job.status !== 'pending') {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData('text/plain', index.toString());
    this.dragState.set({ draggedIndex: index, dragOverIndex: -1 });
  }

  onDragOver(event: DragEvent, index: number, job: QueueJob): void {
    // Only allow dropping on pending jobs
    if (job.status !== 'pending') return;

    event.preventDefault();
    const state = this.dragState();
    if (state && state.dragOverIndex !== index) {
      this.dragState.set({ ...state, dragOverIndex: index });
    }
  }

  onDragLeave(event: DragEvent): void {
    // Only clear if leaving the list entirely
    const relatedTarget = event.relatedTarget as HTMLElement;
    if (!relatedTarget?.closest('.job-item')) {
      const state = this.dragState();
      if (state) {
        this.dragState.set({ ...state, dragOverIndex: -1 });
      }
    }
  }

  onDrop(event: DragEvent, toIndex: number): void {
    event.preventDefault();
    const state = this.dragState();
    const jobs = this.jobs();
    if (state && state.draggedIndex !== toIndex && state.draggedIndex < jobs.length && toIndex < jobs.length) {
      const fromJob = jobs[state.draggedIndex];
      const toJob = jobs[toIndex];
      this.reorder.emit({ fromId: fromJob.id, toId: toJob.id });
    }
    this.dragState.set(null);
  }

  onDragEnd(): void {
    this.dragState.set(null);
  }

  getJobTypeLabel(type: JobType): string {
    switch (type) {
      case 'ocr-cleanup':
        return 'OCR';
      case 'translation':
        return 'Translate';
      case 'tts-conversion':
        return 'TTS';
      default:
        return type;
    }
  }

  getOcrModel(job: QueueJob): string | null {
    if (job.type !== 'ocr-cleanup' || !job.config) return null;
    const config = job.config as { aiModel?: string };
    return config.aiModel || null;
  }

  getTranslationInfo(job: QueueJob): string | null {
    if (job.type !== 'translation' || !job.config) return null;
    const config = job.config as { aiModel?: string };
    return config.aiModel || null;
  }
}

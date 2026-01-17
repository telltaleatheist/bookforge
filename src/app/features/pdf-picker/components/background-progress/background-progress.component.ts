import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface BackgroundJob {
  id: string;
  type: 'ocr' | 'export' | 'render';
  title: string;
  progress: number;  // 0-100
  current: number;
  total: number;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
  error?: string;
  queuePosition?: number;  // Position in queue (1-based)
}

@Component({
  selector: 'app-background-progress',
  standalone: true,
  imports: [CommonModule],
  // Using Default change detection to ensure updates from OcrJobService signal are detected
  // changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="background-progress" [class.has-jobs]="jobs.length > 0">
      @for (job of jobs; track job.id) {
        <div
          class="job-card"
          [class.completed]="job.status === 'completed'"
          [class.error]="job.status === 'error'"
          [class.queued]="job.status === 'queued'"
          [class.cancelled]="job.status === 'cancelled'"
        >
          <div class="job-header">
            <span class="job-icon">
              @switch (job.type) {
                @case ('ocr') { 👁️ }
                @case ('export') { 📤 }
                @case ('render') { 🖼️ }
              }
            </span>
            <span class="job-title">{{ job.title }}</span>
            @if (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') {
              <button class="dismiss-btn" (click)="dismiss.emit(job.id)" title="Dismiss">×</button>
            } @else {
              <button class="cancel-btn" (click)="cancel.emit(job.id)" title="Cancel">×</button>
            }
          </div>

          @if (job.status === 'queued') {
            <div class="job-status queued">
              ⏳ Queued{{ job.queuePosition ? ' (#' + job.queuePosition + ')' : '' }}
            </div>
          } @else if (job.status === 'running') {
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="job.progress"></div>
            </div>
            <div class="job-status">
              {{ job.current }} / {{ job.total }} pages
            </div>
          } @else if (job.status === 'completed') {
            <div class="job-status success">
              ✓ Complete
            </div>
          } @else if (job.status === 'cancelled') {
            <div class="job-status cancelled">
              ⊘ Cancelled
            </div>
          } @else if (job.status === 'error') {
            <div class="job-status error">
              ✗ {{ job.error || 'Failed' }}
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .background-progress {
      position: fixed;
      bottom: 60px;  /* Above the status bar */
      right: 16px;
      z-index: 150;  /* Above content but below modals (200+) */
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;

      &.has-jobs {
        pointer-events: auto;
      }
    }

    .job-card {
      background: var(--bg-elevated, #2a2a2a);
      border: 1px solid var(--border-default, #444);
      border-radius: 8px;
      padding: 12px 16px;
      min-width: 220px;
      max-width: 300px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      animation: slideIn 0.2s ease-out;

      &.completed {
        border-color: #4caf50;
        background: rgba(76, 175, 80, 0.1);
      }

      &.error {
        border-color: #f44336;
        background: rgba(244, 67, 54, 0.1);
      }

      &.queued {
        border-color: var(--text-tertiary, #666);
        opacity: 0.85;
      }

      &.cancelled {
        border-color: var(--text-tertiary, #666);
        opacity: 0.7;
      }
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .job-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .job-icon {
      font-size: 16px;
    }

    .job-title {
      flex: 1;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary, #fff);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dismiss-btn, .cancel-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary, #888);
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;

      &:hover {
        color: var(--text-primary, #fff);
      }
    }

    .cancel-btn:hover {
      color: #f44336;
    }

    .progress-bar {
      height: 4px;
      background: var(--bg-sunken, #1a1a1a);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 6px;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent, #ff9500);
      border-radius: 2px;
      transition: width 0.2s ease-out;
    }

    .job-status {
      font-size: 11px;
      color: var(--text-secondary, #888);

      &.success {
        color: #4caf50;
      }

      &.error {
        color: #f44336;
      }

      &.queued {
        color: var(--text-tertiary, #888);
      }

      &.cancelled {
        color: var(--text-tertiary, #666);
      }
    }
  `]
})
export class BackgroundProgressComponent {
  @Input() jobs: BackgroundJob[] = [];
  @Output() dismiss = new EventEmitter<string>();
  @Output() cancel = new EventEmitter<string>();
}

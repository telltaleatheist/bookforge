import { Component, input, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export type ConversionPhase = 'preparing' | 'converting' | 'merging' | 'complete' | 'error';

export interface TTSProgress {
  phase: ConversionPhase;
  currentChapter: number;
  totalChapters: number;
  percentage: number;
  estimatedRemaining: number; // seconds
  message?: string;
  error?: string;
}

@Component({
  selector: 'app-progress-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="progress-panel" [class.error]="progress().phase === 'error'" [class.complete]="progress().phase === 'complete'">
      <!-- Progress Circle -->
      <div class="progress-circle">
        <svg viewBox="0 0 100 100">
          <circle
            class="progress-bg"
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke-width="8"
          />
          <circle
            class="progress-fill"
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke-width="8"
            [attr.stroke-dasharray]="circumference"
            [attr.stroke-dashoffset]="dashOffset()"
          />
        </svg>
        <div class="progress-text">
          <span class="percentage">{{ progress().percentage }}%</span>
          <span class="phase">{{ phaseLabel() }}</span>
        </div>
      </div>

      <!-- Status Info -->
      <div class="status-info">
        @switch (progress().phase) {
          @case ('preparing') {
            <p class="status-message">Preparing audiobook conversion...</p>
          }
          @case ('converting') {
            <p class="status-message">
              Converting chapter {{ progress().currentChapter }} of {{ progress().totalChapters }}
            </p>
            @if (progress().message) {
              <p class="current-action">{{ progress().message }}</p>
            }
          }
          @case ('merging') {
            <p class="status-message">Merging chapters into final audiobook...</p>
          }
          @case ('complete') {
            <p class="status-message success">Conversion complete!</p>
          }
          @case ('error') {
            <p class="status-message error">Conversion failed</p>
            @if (progress().error) {
              <p class="error-details">{{ progress().error }}</p>
            }
          }
        }
      </div>

      <!-- Time Remaining -->
      @if (progress().phase === 'converting' || progress().phase === 'merging') {
        <div class="time-remaining">
          <span class="label">Estimated time remaining:</span>
          <span class="value">{{ formatTime(progress().estimatedRemaining) }}</span>
        </div>
      }

      <!-- Progress Bar -->
      <div class="progress-bar-container">
        <div class="progress-bar">
          <div
            class="progress-bar-fill"
            [style.width.%]="progress().percentage"
            [class.indeterminate]="progress().phase === 'preparing'"
          ></div>
        </div>
        <div class="progress-chapters">
          @if (progress().totalChapters > 0) {
            {{ progress().currentChapter }}/{{ progress().totalChapters }} chapters
          }
        </div>
      </div>

      <!-- Log Output (Collapsible) -->
      <div class="log-section">
        <button class="log-toggle" (click)="showLog.set(!showLog())">
          <span class="toggle-icon">{{ showLog() ? '&#9660;' : '&#9654;' }}</span>
          Conversion Log
        </button>
        @if (showLog()) {
          <div class="log-content">
            <pre>{{ logOutput() }}</pre>
          </div>
        }
      </div>

      <!-- Actions -->
      <div class="actions">
        @if (progress().phase === 'complete') {
          <desktop-button variant="primary" (click)="openOutput()">
            Open Output Folder
          </desktop-button>
          <desktop-button variant="ghost" (click)="convertAnother()">
            Convert Another
          </desktop-button>
        } @else if (progress().phase === 'error') {
          <desktop-button variant="primary" (click)="retry()">
            Retry
          </desktop-button>
          <desktop-button variant="ghost" (click)="cancel.emit()">
            Cancel
          </desktop-button>
        } @else {
          <desktop-button variant="danger" (click)="cancel.emit()">
            Cancel Conversion
          </desktop-button>
        }
      </div>
    </div>
  `,
  styles: [`
    .progress-panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
      padding: 2rem;
    }

    .progress-circle {
      position: relative;
      width: 160px;
      height: 160px;

      svg {
        transform: rotate(-90deg);
        width: 100%;
        height: 100%;
      }

      .progress-bg {
        stroke: var(--bg-subtle);
      }

      .progress-fill {
        stroke: var(--accent-primary);
        stroke-linecap: round;
        transition: stroke-dashoffset 0.3s ease;
      }

      .error & .progress-fill {
        stroke: var(--accent-danger);
      }

      .complete & .progress-fill {
        stroke: var(--accent-success);
      }

      .progress-text {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;

        .percentage {
          font-size: 2rem;
          font-weight: 600;
          color: var(--text-primary);
        }

        .phase {
          font-size: 0.75rem;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.02em;
        }
      }
    }

    .status-info {
      text-align: center;

      .status-message {
        margin: 0;
        font-size: 1rem;
        color: var(--text-primary);

        &.success {
          color: var(--accent-success);
        }

        &.error {
          color: var(--accent-danger);
        }
      }

      .current-action {
        margin: 0.5rem 0 0 0;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .error-details {
        margin: 0.5rem 0 0 0;
        font-size: 0.875rem;
        color: var(--accent-danger);
        max-width: 400px;
      }
    }

    .time-remaining {
      display: flex;
      gap: 0.5rem;
      font-size: 0.875rem;

      .label {
        color: var(--text-secondary);
      }

      .value {
        color: var(--text-primary);
        font-weight: 500;
      }
    }

    .progress-bar-container {
      width: 100%;
      max-width: 400px;
    }

    .progress-bar {
      height: 8px;
      background: var(--bg-subtle);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background: var(--accent-primary);
      border-radius: 4px;
      transition: width 0.3s ease;

      &.indeterminate {
        width: 30% !important;
        animation: indeterminate 1.5s infinite ease-in-out;
      }

      .error & {
        background: var(--accent-danger);
      }

      .complete & {
        background: var(--accent-success);
      }
    }

    @keyframes indeterminate {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(400%); }
    }

    .progress-chapters {
      margin-top: 0.5rem;
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .log-section {
      width: 100%;
      max-width: 500px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      overflow: hidden;
    }

    .log-toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--bg-subtle);
      border: none;
      color: var(--text-secondary);
      font-size: 0.8125rem;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      .toggle-icon {
        font-size: 0.625rem;
      }
    }

    .log-content {
      max-height: 200px;
      overflow-y: auto;
      padding: 0.75rem 1rem;
      background: var(--bg-base);

      pre {
        margin: 0;
        font-size: 0.6875rem;
        font-family: monospace;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--text-muted);
      }
    }

    .actions {
      display: flex;
      gap: 0.75rem;
    }
  `]
})
export class ProgressPanelComponent {
  // Inputs
  readonly progress = input<TTSProgress>({
    phase: 'preparing',
    currentChapter: 0,
    totalChapters: 0,
    percentage: 0,
    estimatedRemaining: 0
  });

  // Outputs
  readonly cancel = output<void>();

  // State
  readonly showLog = signal(false);
  readonly logOutput = signal('Starting conversion...\n');

  // Circle progress calculations
  readonly circumference = Math.PI * 2 * 45; // 2 * PI * radius

  readonly dashOffset = computed(() => {
    const percentage = this.progress().percentage;
    return this.circumference * (1 - percentage / 100);
  });

  readonly phaseLabel = computed(() => {
    switch (this.progress().phase) {
      case 'preparing': return 'Preparing';
      case 'converting': return 'Converting';
      case 'merging': return 'Merging';
      case 'complete': return 'Complete';
      case 'error': return 'Error';
      default: return '';
    }
  });

  formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${mins}m`;
    }
  }

  openOutput(): void {
    // TODO: Open the output folder in file manager
  }

  convertAnother(): void {
    // TODO: Reset and go back to queue
  }

  retry(): void {
    // TODO: Retry the conversion
  }
}

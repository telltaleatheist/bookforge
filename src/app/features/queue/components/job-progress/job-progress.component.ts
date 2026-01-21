/**
 * Job Progress Component - Displays detailed progress for the current job
 *
 * Implements Google Maps-style dynamic ETA calculation:
 * - Tracks time per chunk completion
 * - Calculates rolling average
 * - Counts down between updates
 * - Recalculates when new data arrives
 */

import { Component, input, output, computed, signal, effect, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueJob } from '../../models/queue.types';

// ETA calculation state
interface ETAState {
  lastChunksCompleted: number;     // Last known chunks completed count
  estimatedSecondsRemaining: number; // Current ETA countdown value
}

@Component({
  selector: 'app-job-progress',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    @if (job(); as currentJob) {
      <div class="progress-panel">
        <div class="progress-header">
          <h3>Processing</h3>
          <desktop-button
            variant="ghost"
            size="sm"
            (click)="cancel.emit()"
          >
            Cancel
          </desktop-button>
        </div>

        <div class="job-details">
          <div class="job-type">
            @if (currentJob.type === 'ocr-cleanup') {
              <span class="type-icon">&#128221;</span>
              <span>OCR Cleanup</span>
            } @else if (currentJob.type === 'tts-conversion') {
              <span class="type-icon">&#127911;</span>
              <span>TTS Conversion</span>
            }
          </div>

          <div class="job-title">{{ currentJob.metadata?.title || 'Untitled' }}</div>
          @if (currentJob.metadata?.author) {
            <div class="job-author">{{ currentJob.metadata!.author }}</div>
          }
        </div>

        <div class="progress-visual">
          <div class="progress-bar-large">
            <div
              class="progress-fill"
              [style.width.%]="currentJob.progress || 0"
            ></div>
          </div>
          <div class="progress-text">
            {{ (currentJob.progress || 0) | number:'1.1-1' }}%
          </div>
        </div>

        @if (currentJob.progressMessage) {
          <div class="progress-message">{{ currentJob.progressMessage }}</div>
        }

        <div class="progress-stats">
          <div class="stat">
            <span class="stat-label">Elapsed</span>
            <span class="stat-value">{{ elapsedTimeFormatted() }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">ETA</span>
            <span class="stat-value">{{ etaFormatted() }}</span>
          </div>
          @if (job()?.totalChunksInJob) {
            <div class="stat">
              <span class="stat-label">Chunks</span>
              <span class="stat-value">{{ job()!.chunksCompletedInJob || 0 }}/{{ job()!.totalChunksInJob }}</span>
            </div>
          }
        </div>
      </div>
    } @else {
      <div class="no-job">
        <div class="idle-icon">&#9673;</div>
        <p>Queue is idle</p>
      </div>
    }
  `,
  styles: [`
    .progress-panel {
      padding: 1.5rem;
      background: var(--bg-subtle);
      border: 1px solid var(--border-default);
      border-radius: 8px;
    }

    .progress-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;

      h3 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .job-details {
      margin-bottom: 1.5rem;
    }

    .job-type {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .type-icon {
      font-size: 1rem;
    }

    .job-title {
      font-size: 1rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    .job-author {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    .progress-visual {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
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

    .progress-message {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 1rem;
      padding: 0.5rem;
      background: var(--bg-base);
      border-radius: 4px;
    }

    .progress-stats {
      display: flex;
      gap: 2rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .stat-label {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .stat-value {
      font-size: 0.875rem;
      color: var(--text-primary);
    }

    .no-job {
      text-align: center;
      padding: 3rem 2rem;
      color: var(--text-secondary);
    }

    .idle-icon {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      opacity: 0.5;
    }

    .no-job p {
      margin: 0;
      font-size: 0.875rem;
    }
  `]
})
export class JobProgressComponent implements OnDestroy {
  // Inputs
  readonly job = input<QueueJob | null>(null);
  readonly message = input<string | undefined>(undefined);

  // Outputs
  readonly cancel = output<void>();

  // Timer state - updates every second
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private readonly tick = signal(0);

  // Track when job started for elapsed time
  private jobStartTime: number | null = null;

  // ETA calculation state
  private etaState: ETAState = {
    lastChunksCompleted: 0,
    estimatedSecondsRemaining: 0
  };

  // Signal to track current ETA countdown (decrements every second)
  private readonly etaCountdown = signal<number>(0);

  constructor() {
    // Start timer when job changes
    effect(() => {
      const j = this.job();
      if (j?.startedAt && j.status === 'processing') {
        this.jobStartTime = new Date(j.startedAt).getTime();
        this.startTimer();
      } else {
        this.stopTimer();
        this.jobStartTime = null;
        this.resetETAState();
      }
    });

    // Track chunk completions and recalculate ETA
    effect(() => {
      const j = this.job();
      if (!j || j.status !== 'processing') return;

      const chunksCompleted = j.chunksCompletedInJob || 0;

      // Check if a new chunk was completed
      if (chunksCompleted > this.etaState.lastChunksCompleted) {
        this.etaState.lastChunksCompleted = chunksCompleted;
        // Recalculate ETA based on total elapsed time and chunks completed
        this.recalculateETA(j);
      }
    });
  }

  ngOnDestroy(): void {
    this.stopTimer();
  }

  private resetETAState(): void {
    this.etaState = {
      lastChunksCompleted: 0,
      estimatedSecondsRemaining: 0
    };
    this.etaCountdown.set(0);
  }

  /**
   * Recalculate ETA based on total elapsed time and chunks completed.
   *
   * Simple algorithm:
   * 1. avgTimePerChunk = totalElapsedTime / chunksCompleted
   * 2. remainingChunks = totalChunksInJob - chunksCompleted
   * 3. ETA = remainingChunks × avgTimePerChunk
   */
  private recalculateETA(job: QueueJob): void {
    const chunksCompleted = job.chunksCompletedInJob || 0;
    const totalChunksInJob = job.totalChunksInJob || job.totalChunks || 0;

    if (chunksCompleted === 0 || totalChunksInJob === 0 || !this.jobStartTime) {
      return;
    }

    // Total elapsed time since job started
    const totalElapsedMs = Date.now() - this.jobStartTime;
    const totalElapsedSec = totalElapsedMs / 1000;

    // Average time per chunk = total elapsed / chunks completed
    const avgTimePerChunkSec = totalElapsedSec / chunksCompleted;

    // Remaining chunks
    const remainingChunks = totalChunksInJob - chunksCompleted;

    // ETA = remaining chunks × avg time per chunk
    const remainingSeconds = Math.round(remainingChunks * avgTimePerChunkSec);

    // Update countdown
    this.etaState.estimatedSecondsRemaining = remainingSeconds;
    this.etaCountdown.set(remainingSeconds);

    console.log(`[ETA] ${chunksCompleted}/${totalChunksInJob} done in ${totalElapsedSec.toFixed(0)}s → ${avgTimePerChunkSec.toFixed(1)}s/chunk`);
    console.log(`[ETA] ${remainingChunks} remaining × ${avgTimePerChunkSec.toFixed(1)}s = ${remainingSeconds}s (${this.formatDuration(remainingSeconds)})`);
  }

  private startTimer(): void {
    if (this.timerInterval) return;
    this.timerInterval = setInterval(() => {
      this.tick.update(t => t + 1);

      // Countdown the ETA (but don't go below 0)
      const currentEta = this.etaCountdown();
      if (currentEta > 0) {
        this.etaCountdown.set(currentEta - 1);
      }
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  // Computed: elapsed time in seconds (reactive to tick)
  readonly elapsedSeconds = computed(() => {
    this.tick(); // Subscribe to tick updates
    if (!this.jobStartTime) return 0;
    return Math.floor((Date.now() - this.jobStartTime) / 1000);
  });

  // Computed: formatted elapsed time
  readonly elapsedTimeFormatted = computed(() => {
    const elapsed = this.elapsedSeconds();
    return this.formatDuration(elapsed);
  });

  // Computed: ETA - uses chunk-based countdown when available, falls back to percentage-based
  readonly etaFormatted = computed(() => {
    const j = this.job();
    const countdown = this.etaCountdown();
    this.tick(); // Subscribe to tick for countdown updates

    if (!j || j.status !== 'processing') {
      return '-';
    }

    const progress = j?.progress || 0;
    if (progress >= 100) {
      return 'Complete';
    }

    // If we have chunk-based ETA, use it
    if (countdown > 0) {
      return this.formatDuration(countdown);
    }

    // Fall back to percentage-based ETA if no chunk data yet
    const elapsed = this.elapsedSeconds();
    if (progress <= 0 || elapsed <= 0) {
      return 'Calculating...';
    }

    // Calculate remaining time: (elapsed / progress) * remaining
    const remaining = ((elapsed / progress) * (100 - progress));
    return this.formatDuration(Math.round(remaining));
  });

  private formatDuration(seconds: number): string {
    if (seconds < 0) seconds = 0;

    if (seconds < 60) {
      return `${seconds}s`;
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m ${secs}s`;
  }

  formatTime(date: Date | undefined): string {
    if (!date) return '-';
    return new Date(date).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}

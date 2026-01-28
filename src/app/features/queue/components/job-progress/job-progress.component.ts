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
import { QueueJob, ParallelWorkerProgress } from '../../models/queue.types';

// ETA calculation state
interface ETAState {
  lastChunksCompleted: number;     // Last known chunks completed count
  estimatedSecondsRemaining: number; // Current ETA countdown value
  initialChunksCompleted: number;  // Chunks already done when THIS session started (for resume jobs)
  firstWorkTime: number | null;    // Timestamp when first actual work completed (excludes model load)
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
            } @else if (currentJob.type === 'translation') {
              <span class="type-icon">&#127760;</span>
              <span>Translation</span>
            } @else if (currentJob.type === 'tts-conversion') {
              <span class="type-icon">&#127911;</span>
              <span>TTS Conversion</span>
            } @else if (currentJob.type === 'reassembly') {
              <span class="type-icon">&#128295;</span>
              <span>Reassembly</span>
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
          @if (job()?.type === 'reassembly') {
            <div class="stat">
              <span class="stat-label">Phase</span>
              <span class="stat-value">{{ getReassemblyPhase() }}</span>
            </div>
          } @else if (job()?.totalChunksInJob) {
            <div class="stat">
              <span class="stat-label">Chunks</span>
              <span class="stat-value">{{ job()!.chunksCompletedInJob || 0 }}/{{ job()!.totalChunksInJob }}</span>
            </div>
          }
        </div>

        <!-- Per-Worker Progress (for parallel TTS) -->
        @if (hasWorkers()) {
          <div class="workers-section">
            <div class="workers-header">Workers</div>
            <div class="workers-grid">
              @for (worker of currentJob.parallelWorkers; track worker.id) {
                <div class="worker-row" [class.complete]="worker.status === 'complete'" [class.error]="worker.status === 'error'">
                  <span class="worker-label">W{{ worker.id }}</span>
                  <div class="worker-progress-bar">
                    <div
                      class="worker-progress-fill"
                      [style.width.%]="getWorkerPercentage(worker)"
                    ></div>
                  </div>
                  <span class="worker-pct">{{ getWorkerPercentage(worker) | number:'1.0-0' }}%</span>
                </div>
              }
            </div>
          </div>
        }
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

    .workers-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);
    }

    .workers-header {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.02em;
      margin-bottom: 0.5rem;
    }

    .workers-grid {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    .worker-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .worker-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      width: 1.75rem;
      flex-shrink: 0;
    }

    .worker-progress-bar {
      flex: 1;
      height: 6px;
      background: var(--bg-elevated);
      border-radius: 3px;
      overflow: hidden;
    }

    .worker-progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.3s ease;

      .complete & {
        background: var(--accent-success, #10b981);
      }

      .error & {
        background: var(--accent-danger, #ef4444);
      }
    }

    .worker-pct {
      font-size: 0.75rem;
      color: var(--text-secondary);
      width: 2.5rem;
      text-align: right;
      flex-shrink: 0;
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
    estimatedSecondsRemaining: 0,
    initialChunksCompleted: -1,  // -1 means not yet initialized
    firstWorkTime: null          // Set when first chunk/sentence completes
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

      // For reassembly jobs, track chapter progress instead of chunks
      if (j.type === 'reassembly') {
        const currentChapter = j.currentChapter || 0;

        if (currentChapter > this.etaState.lastChunksCompleted) {
          // Record first work time when first chapter completes
          if (this.etaState.firstWorkTime === null && currentChapter > 0) {
            this.etaState.firstWorkTime = Date.now();
            console.log('[ETA] Reassembly: First chapter completed - timer started');
          }

          this.etaState.lastChunksCompleted = currentChapter;
          this.recalculateReassemblyETA(j);
        }
        return;
      }

      const chunksCompleted = j.chunksCompletedInJob || 0;

      // Check if a new chunk was completed
      if (chunksCompleted > this.etaState.lastChunksCompleted) {
        // Record first work time when first chunk completes (excludes model loading)
        if (this.etaState.firstWorkTime === null && chunksCompleted > 0) {
          this.etaState.firstWorkTime = Date.now();
          console.log('[ETA] First work completed - timer started (model load time excluded)');
        }

        this.etaState.lastChunksCompleted = chunksCompleted;
        // Recalculate ETA based on actual processing time (not including model load)
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
      estimatedSecondsRemaining: 0,
      initialChunksCompleted: -1,  // -1 means not yet initialized
      firstWorkTime: null          // Reset - will be set on first chunk completion
    };
    this.etaCountdown.set(0);
  }

  /**
   * Recalculate ETA based on chunks completed IN THIS SESSION.
   *
   * Uses chunksDoneInSession from the backend which correctly tracks:
   * - For resume jobs: only new conversions since resume started
   * - For fresh jobs: all chunks completed
   *
   * Algorithm:
   * 1. avgTimePerChunk = totalElapsedTime / chunksDoneInSession
   * 2. remainingChunks = totalChunksInJob - chunksCompleted
   * 3. ETA = remainingChunks × avgTimePerChunk
   */
  private recalculateETA(job: QueueJob): void {
    const chunksCompleted = job.chunksCompletedInJob || 0;
    const totalChunksInJob = job.totalChunksInJob || job.totalChunks || 0;
    // Use backend-provided session count (accurate for resume jobs)
    const chunksDoneInSession = job.chunksDoneInSession || chunksCompleted;

    // Use firstWorkTime (excludes model loading) instead of jobStartTime
    if (chunksCompleted === 0 || totalChunksInJob === 0 || !this.etaState.firstWorkTime) {
      return;
    }

    // Total elapsed time since FIRST WORK completed (excludes model load time)
    const totalElapsedMs = Date.now() - this.etaState.firstWorkTime;
    const totalElapsedSec = totalElapsedMs / 1000;

    // Need at least 2 chunks to calculate meaningful average
    // (first chunk sets firstWorkTime, so we need one more)
    if (chunksDoneInSession <= 1 || totalElapsedSec < 5) {
      // Not enough data yet - wait for more progress
      return;
    }

    // Average time per chunk = elapsed time / (chunks done - 1)
    // Subtract 1 because firstWorkTime is set AFTER first chunk completes
    const chunksForAverage = chunksDoneInSession - 1;
    const avgTimePerChunkSec = totalElapsedSec / chunksForAverage;

    // Remaining chunks
    const remainingChunks = totalChunksInJob - chunksCompleted;

    // ETA = remaining chunks × avg time per chunk
    const remainingSeconds = Math.round(remainingChunks * avgTimePerChunkSec);

    // Update countdown
    this.etaState.estimatedSecondsRemaining = remainingSeconds;
    this.etaCountdown.set(remainingSeconds);

    console.log(`[ETA] Processing: ${chunksForAverage} chunks in ${totalElapsedSec.toFixed(0)}s → ${avgTimePerChunkSec.toFixed(1)}s/chunk (model load excluded)`);
    console.log(`[ETA] ${remainingChunks} remaining × ${avgTimePerChunkSec.toFixed(1)}s = ${remainingSeconds}s (${this.formatDuration(remainingSeconds)})`);
  }

  /**
   * Recalculate ETA for reassembly jobs based on chapter progress.
   * Reassembly has phases:
   * - Combining chapters (0-50%): combine sentences into chapter FLACs
   * - Concatenating (50-65%): merge chapter FLACs into one FLAC
   * - Encoding (65-90%): FLAC to M4B with AAC
   * - Metadata (90-100%): chapter markers, tags
   *
   * We estimate based on chapter combining progress during that phase,
   * then switch to progress-based estimates for later phases.
   */
  private recalculateReassemblyETA(job: QueueJob): void {
    const currentChapter = job.currentChapter || 0;
    const totalChapters = job.totalChapters || 0;
    const progress = job.progress || 0;

    if (!this.etaState.firstWorkTime) {
      return;
    }

    const totalElapsedMs = Date.now() - this.etaState.firstWorkTime;
    const totalElapsedSec = totalElapsedMs / 1000;

    // If we're past the chapter combining phase (> 50%), use progress-based ETA
    if (progress > 50) {
      // Simple progress-based estimate
      const progressRemaining = 100 - progress;
      // Estimate based on how long we've been past 50%
      // This is rough but better than nothing for the encoding phase
      if (progress > 0 && totalElapsedSec > 0) {
        const remainingSeconds = Math.round((totalElapsedSec / progress) * progressRemaining);
        this.etaState.estimatedSecondsRemaining = remainingSeconds;
        this.etaCountdown.set(remainingSeconds);
        console.log(`[ETA] Reassembly (post-combining): ${progress}% done, ~${remainingSeconds}s remaining`);
      }
      return;
    }

    // In chapter combining phase - use chapter-based estimates
    if (currentChapter < 2 || totalChapters === 0) {
      return;
    }

    // Average time per chapter
    const chaptersForAverage = currentChapter - 1;
    const avgTimePerChapterSec = totalElapsedSec / chaptersForAverage;

    // Remaining chapters in combining phase
    const remainingChapters = totalChapters - currentChapter;

    // Estimate: remaining chapters + concatenation (5-10% of total) + encoding (~30% of total)
    // Encoding typically takes about 50-70% as long as chapter combining
    const combiningRemaining = remainingChapters * avgTimePerChapterSec;
    const concatenatingEstimate = totalChapters * avgTimePerChapterSec * 0.1; // Concatenation is fast
    const encodingEstimate = totalChapters * avgTimePerChapterSec * 0.5; // Encoding takes about 50%

    const remainingSeconds = Math.round(combiningRemaining + concatenatingEstimate + encodingEstimate);

    this.etaState.estimatedSecondsRemaining = remainingSeconds;
    this.etaCountdown.set(remainingSeconds);

    console.log(`[ETA] Reassembly: ${chaptersForAverage} chapters in ${totalElapsedSec.toFixed(0)}s → ${avgTimePerChapterSec.toFixed(1)}s/chapter`);
    console.log(`[ETA] ${remainingChapters} chapters + concat + encoding = ${remainingSeconds}s (${this.formatDuration(remainingSeconds)})`);
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

    // If first work hasn't completed yet, show appropriate loading status
    if (!this.etaState.firstWorkTime) {
      // Reassembly doesn't load models - show different message
      if (j.type === 'reassembly') {
        return 'Starting...';
      }
      return 'Loading models...';
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

  // Check if job has parallel workers to display
  readonly hasWorkers = computed(() => {
    const j = this.job();
    return j?.parallelWorkers && j.parallelWorkers.length > 1;
  });

  // Calculate percentage for a worker
  getWorkerPercentage(worker: ParallelWorkerProgress): number {
    const totalSentences = worker.sentenceEnd - worker.sentenceStart + 1;
    if (totalSentences <= 0) return 0;
    return Math.min(100, (worker.completedSentences / totalSentences) * 100);
  }

  // Get human-readable phase name for reassembly jobs
  getReassemblyPhase(): string {
    const j = this.job();
    if (!j) return '-';

    const progress = j.progress || 0;
    const message = j.progressMessage?.toLowerCase() || '';

    // Use message content if available
    if (message.includes('combining chapter') && message.includes('sentences')) {
      return `Chapters (${j.currentChapter || 0}/${j.totalChapters || '?'})`;
    }
    if (message.includes('concatenat')) {
      return 'Concatenating';
    }
    if (message.includes('encod') || message.includes('aac')) {
      return 'Encoding M4B';
    }
    if (message.includes('metadata') || message.includes('chapter marker')) {
      return 'Metadata';
    }
    if (message.includes('finaliz')) {
      return 'Finalizing';
    }

    // Fall back to progress-based phase
    if (progress < 50) {
      return `Chapters (${j.currentChapter || 0}/${j.totalChapters || '?'})`;
    } else if (progress < 65) {
      return 'Concatenating';
    } else if (progress < 90) {
      return 'Encoding M4B';
    } else {
      return 'Metadata';
    }
  }
}

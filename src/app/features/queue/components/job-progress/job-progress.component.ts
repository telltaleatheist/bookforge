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
  // Phase tracking for reassembly (different phases have very different speeds)
  lastPhase: 'combining' | 'encoding' | 'export' | null;
  phaseStartTime: number | null;   // When current phase started
  phaseStartProgress: number;      // Progress when current phase started
  lastProgress: number;            // Last progress value for progress-based ETA updates
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
            } @else if (currentJob.type === 'resemble-enhance') {
              <span class="type-icon">&#10024;</span>
              <span>Audio Enhancement</span>
            } @else if (currentJob.type === 'bilingual-cleanup') {
              <span class="type-icon">&#128221;</span>
              <span>Bilingual Cleanup</span>
            } @else if (currentJob.type === 'bilingual-translation') {
              <span class="type-icon">&#127891;</span>
              <span>Bilingual Translation</span>
            } @else if (currentJob.type === 'bilingual-assembly') {
              <span class="type-icon">&#127925;</span>
              <span>Bilingual Assembly</span>
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

        @if (currentJob.progressMessage && currentJob.type !== 'resemble-enhance') {
          <div class="progress-message">{{ currentJob.progressMessage }}</div>
        }

        <div class="progress-stats">
          <div class="stat">
            <span class="stat-label">Elapsed</span>
            <span class="stat-value">{{ elapsedTimeFormatted() }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">ETA</span>
            <span class="stat-value">{{ getEtaDisplay(currentJob) }}</span>
          </div>
          @if (job()?.type === 'reassembly') {
            <div class="stat">
              <span class="stat-label">Phase</span>
              <span class="stat-value">{{ getReassemblyPhase() }}</span>
            </div>
          } @else if (job()?.type === 'bilingual-cleanup' || job()?.type === 'bilingual-translation') {
            <div class="stat">
              <span class="stat-label">Phase</span>
              <span class="stat-value">{{ getBilingualPhase() }}</span>
            </div>
            @if (job()?.currentChunk && job()?.totalChunks) {
              <div class="stat">
                <span class="stat-label">Sentences</span>
                <span class="stat-value">{{ job()!.currentChunk }}/{{ job()!.totalChunks }}</span>
              </div>
            }
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
                      [style.width.%]="getWorkerPercentage(worker, currentJob)"
                    ></div>
                  </div>
                  <span class="worker-pct">{{ getWorkerPercentage(worker, currentJob) | number:'1.0-0' }}%</span>
                </div>
              }
            </div>
          </div>
        }

        <!-- TTS Phases Progress (TTS Conversion + Assembly) -->
        <!-- Only show phases for TTS jobs that have internal assembly (not skipAssembly) -->
        @if (currentJob.type === 'tts-conversion' && currentJob.ttsPhase && !hasSkipAssembly(currentJob)) {
          <div class="phases-section">
            <div class="phases-header">Phases</div>
            <div class="phases-grid">
              <!-- TTS Conversion Phase -->
              <div class="phase-row" [class.active]="currentJob.ttsPhase === 'converting'" [class.complete]="currentJob.ttsConversionProgress === 100">
                <span class="phase-label">TTS Conversion</span>
                <div class="phase-progress-bar">
                  <div
                    class="phase-progress-fill"
                    [style.width.%]="currentJob.ttsConversionProgress || 0"
                  ></div>
                </div>
                <span class="phase-pct">{{ currentJob.ttsConversionProgress || 0 | number:'1.0-0' }}%</span>
              </div>
              <!-- Assembly Phase -->
              <div class="phase-row" [class.active]="currentJob.ttsPhase === 'assembling'" [class.complete]="currentJob.assemblyProgress === 100" [class.pending]="currentJob.ttsPhase === 'converting' || currentJob.ttsPhase === 'preparing'">
                <span class="phase-label">Assembly</span>
                <div class="phase-progress-bar">
                  <div
                    class="phase-progress-fill"
                    [style.width.%]="currentJob.assemblyProgress || 0"
                  ></div>
                </div>
                <span class="phase-pct">
                  @if (currentJob.ttsPhase === 'assembling' || currentJob.assemblyProgress) {
                    {{ currentJob.assemblyProgress || 0 | number:'1.0-0' }}%
                  } @else {
                    --
                  }
                </span>
              </div>
            </div>
            @if (currentJob.ttsPhase === 'assembling' && currentJob.assemblySubPhase) {
              <div class="assembly-subphase">{{ getAssemblySubPhaseLabel(currentJob.assemblySubPhase) }}</div>
            }
          </div>
        }

        <!-- Bilingual Assembly Phases -->
        @if (currentJob.type === 'bilingual-assembly') {
          <div class="phases-section">
            <div class="phases-header">Assembly Phases</div>
            <div class="phases-grid">
              <!-- Combining Phase -->
              <div class="phase-row"
                   [class.active]="currentJob.assemblySubPhase === 'combining'"
                   [class.complete]="isAssemblyPhaseComplete('combining', currentJob)">
                <span class="phase-label">Combining</span>
                <div class="phase-progress-bar">
                  <div
                    class="phase-progress-fill"
                    [style.width.%]="getAssemblyPhaseProgress('combining', currentJob)"
                  ></div>
                </div>
                <span class="phase-pct">{{ getAssemblyPhasePct('combining', currentJob) }}</span>
              </div>
              <!-- VTT Phase -->
              <div class="phase-row"
                   [class.active]="currentJob.assemblySubPhase === 'vtt'"
                   [class.complete]="isAssemblyPhaseComplete('vtt', currentJob)"
                   [class.pending]="!isAssemblyPhaseStarted('vtt', currentJob)">
                <span class="phase-label">Subtitles</span>
                <div class="phase-progress-bar">
                  <div
                    class="phase-progress-fill"
                    [style.width.%]="getAssemblyPhaseProgress('vtt', currentJob)"
                  ></div>
                </div>
                <span class="phase-pct">{{ getAssemblyPhasePct('vtt', currentJob) }}</span>
              </div>
              <!-- Encoding Phase -->
              <div class="phase-row"
                   [class.active]="currentJob.assemblySubPhase === 'encoding'"
                   [class.complete]="isAssemblyPhaseComplete('encoding', currentJob)"
                   [class.pending]="!isAssemblyPhaseStarted('encoding', currentJob)">
                <span class="phase-label">Encoding M4B</span>
                <div class="phase-progress-bar">
                  <div
                    class="phase-progress-fill"
                    [style.width.%]="getAssemblyPhaseProgress('encoding', currentJob)"
                  ></div>
                </div>
                <span class="phase-pct">{{ getAssemblyPhasePct('encoding', currentJob) }}</span>
              </div>
              <!-- Metadata Phase -->
              <div class="phase-row"
                   [class.active]="currentJob.assemblySubPhase === 'metadata'"
                   [class.complete]="isAssemblyPhaseComplete('metadata', currentJob)"
                   [class.pending]="!isAssemblyPhaseStarted('metadata', currentJob)">
                <span class="phase-label">Metadata</span>
                <div class="phase-progress-bar">
                  <div
                    class="phase-progress-fill"
                    [style.width.%]="getAssemblyPhaseProgress('metadata', currentJob)"
                  ></div>
                </div>
                <span class="phase-pct">{{ getAssemblyPhasePct('metadata', currentJob) }}</span>
              </div>
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

    /* TTS Phases Section */
    .phases-section {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle);
    }

    .phases-label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 0.5rem;
    }

    .phases-grid {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .phase-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .phase-name {
      font-size: 0.8rem;
      color: var(--text-secondary);
      width: 5rem;
      flex-shrink: 0;
    }

    .phase-progress-bar {
      flex: 1;
      height: 6px;
      background: var(--bg-elevated);
      border-radius: 3px;
      overflow: hidden;
    }

    .phase-progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.3s ease;

      .complete & {
        background: var(--accent-success, #10b981);
      }
    }

    .phase-row.pending {
      opacity: 0.5;

      .phase-label {
        color: var(--text-tertiary);
      }
    }

    .phase-row.active {
      .phase-label {
        color: var(--accent);
        font-weight: 500;
      }
    }

    .phase-row.complete {
      .phase-label {
        color: var(--accent-success, #10b981);
      }
    }

    .phases-header {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.02em;
      margin-bottom: 0.5rem;
    }

    .phase-label {
      font-size: 0.8rem;
      color: var(--text-secondary);
      width: 6rem;
      flex-shrink: 0;
    }

    .phase-pct {
      font-size: 0.75rem;
      color: var(--text-secondary);
      width: 2.5rem;
      text-align: right;
      flex-shrink: 0;
    }

    .assembly-subphase {
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
      padding-left: 5.75rem;
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
    firstWorkTime: null,         // Set when first chunk/sentence completes
    lastPhase: null,
    phaseStartTime: null,
    phaseStartProgress: 0,
    lastProgress: 0
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
        const progress = j.progress || 0;

        // During combining phase (progress < 50%), trigger on chapter completion
        if (currentChapter > this.etaState.lastChunksCompleted) {
          // Record first work time when first chapter completes
          if (this.etaState.firstWorkTime === null && currentChapter > 0) {
            this.etaState.firstWorkTime = Date.now();
            console.log('[ETA] Reassembly: First chapter completed - timer started');
          }

          this.etaState.lastChunksCompleted = currentChapter;
          this.recalculateReassemblyETA(j);
        }

        // During encoding/export phase (progress >= 50%), trigger on progress changes
        // Since no chapters complete during encoding, we need progress-based updates
        if (progress >= 50 && this.etaState.firstWorkTime) {
          // Track last progress to avoid recalculating on every render
          const lastProgress = this.etaState.lastProgress || 0;
          if (progress > lastProgress + 1) {  // Only recalculate every 1%+ change
            this.etaState.lastProgress = progress;
            this.recalculateReassemblyETA(j);
          }
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
      firstWorkTime: null,         // Reset - will be set on first chunk completion
      lastPhase: null,
      phaseStartTime: null,
      phaseStartProgress: 0,
      lastProgress: 0
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
   * Reassembly has distinct phases with very different speeds:
   * - Combining (0-50%): Slow, chapter-based
   * - Assemble (50-90%): Medium speed
   * - Export (90-100%): Very fast
   *
   * We track each phase separately to give accurate ETAs.
   */
  private recalculateReassemblyETA(job: QueueJob): void {
    const currentChapter = job.currentChapter || 0;
    const totalChapters = job.totalChapters || 0;
    const progress = job.progress || 0;

    if (!this.etaState.firstWorkTime) {
      return;
    }

    const now = Date.now();
    const totalElapsedMs = now - this.etaState.firstWorkTime;
    const totalElapsedSec = totalElapsedMs / 1000;

    // Determine current phase based on progress
    let currentPhase: 'combining' | 'encoding' | 'export';
    if (progress >= 90) {
      currentPhase = 'export';
    } else if (progress >= 50) {
      currentPhase = 'encoding';
    } else {
      currentPhase = 'combining';
    }

    // Track phase transitions
    if (currentPhase !== this.etaState.lastPhase) {
      console.log(`[ETA] Phase change: ${this.etaState.lastPhase || 'none'} → ${currentPhase} at ${progress.toFixed(1)}%`);
      this.etaState.lastPhase = currentPhase;
      this.etaState.phaseStartTime = now;
      this.etaState.phaseStartProgress = progress;
    }

    // Export phase (90-100%): Very fast, calculate based on phase speed only
    if (currentPhase === 'export') {
      const phaseElapsedMs = now - (this.etaState.phaseStartTime || now);
      const phaseElapsedSec = phaseElapsedMs / 1000;
      const phaseProgress = progress - this.etaState.phaseStartProgress;
      const progressRemaining = 100 - progress;

      if (phaseProgress > 1 && phaseElapsedSec > 0) {
        // Calculate based on speed within export phase only
        const speedPerPercent = phaseElapsedSec / phaseProgress;
        const remainingSeconds = Math.max(1, Math.round(speedPerPercent * progressRemaining));
        this.etaState.estimatedSecondsRemaining = remainingSeconds;
        this.etaCountdown.set(remainingSeconds);
        console.log(`[ETA] Export phase: ${phaseProgress.toFixed(1)}% in ${phaseElapsedSec.toFixed(1)}s → ~${remainingSeconds}s remaining`);
      } else {
        // Just started export, estimate ~30 seconds
        this.etaState.estimatedSecondsRemaining = 30;
        this.etaCountdown.set(30);
      }
      return;
    }

    // Assemble/Encoding phase (50-90%): Calculate based on phase speed
    if (currentPhase === 'encoding') {
      const phaseElapsedMs = now - (this.etaState.phaseStartTime || now);
      const phaseElapsedSec = phaseElapsedMs / 1000;
      const phaseProgress = progress - this.etaState.phaseStartProgress;
      const progressToPhaseEnd = 90 - progress; // End of encoding phase
      const exportEstimate = 30; // Export is typically ~30 seconds

      if (phaseProgress > 2 && phaseElapsedSec > 0) {
        // Calculate based on speed within encoding phase
        const speedPerPercent = phaseElapsedSec / phaseProgress;
        const encodingRemaining = Math.round(speedPerPercent * progressToPhaseEnd);
        const remainingSeconds = encodingRemaining + exportEstimate;
        this.etaState.estimatedSecondsRemaining = remainingSeconds;
        this.etaCountdown.set(remainingSeconds);
        console.log(`[ETA] Assemble phase: ${phaseProgress.toFixed(1)}% in ${phaseElapsedSec.toFixed(1)}s → ${encodingRemaining}s + ${exportEstimate}s export`);
      } else {
        // Just started encoding, rough estimate based on combining speed
        const remainingSeconds = Math.round((totalElapsedSec / progress) * (100 - progress) * 0.5);
        this.etaState.estimatedSecondsRemaining = remainingSeconds;
        this.etaCountdown.set(remainingSeconds);
      }
      return;
    }

    // Combining phase (0-50%): Use chapter-based estimates
    if (currentChapter < 2 || totalChapters === 0) {
      return;
    }

    // Average time per chapter
    const chaptersForAverage = currentChapter - 1;
    const avgTimePerChapterSec = totalElapsedSec / chaptersForAverage;

    // Remaining chapters in combining phase
    const remainingChapters = totalChapters - currentChapter;

    // Estimate: remaining chapters + assemble (~40% of combining time) + export (~30s)
    const combiningRemaining = remainingChapters * avgTimePerChapterSec;
    const assembleEstimate = totalChapters * avgTimePerChapterSec * 0.4;
    const exportEstimate = 30;

    const remainingSeconds = Math.round(combiningRemaining + assembleEstimate + exportEstimate);

    this.etaState.estimatedSecondsRemaining = remainingSeconds;
    this.etaCountdown.set(remainingSeconds);

    console.log(`[ETA] Combining: ${chaptersForAverage} chapters in ${totalElapsedSec.toFixed(0)}s → ${avgTimePerChapterSec.toFixed(1)}s/chapter`);
    console.log(`[ETA] ${remainingChapters} chapters + assemble + export = ${remainingSeconds}s (${this.formatDuration(remainingSeconds)})`);
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

    // For resemble-enhance jobs, parse ETA from progressMessage or use percentage-based
    if (j.type === 'resemble-enhance') {
      // Try to extract remaining time from message like "Enhancing: 13% (57:54 remaining)"
      const message = j.progressMessage || '';
      const remainingMatch = message.match(/\(([^)]+)\s+remaining\)/);
      if (remainingMatch && remainingMatch[1]) {
        // Parse mm:ss or hh:mm:ss format to seconds and reformat consistently
        const timeParts = remainingMatch[1].split(':').map(Number);
        let seconds = 0;
        if (timeParts.length === 2) {
          seconds = timeParts[0] * 60 + timeParts[1];
        } else if (timeParts.length === 3) {
          seconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
        }
        if (seconds > 0) {
          return this.formatDuration(seconds);
        }
        return remainingMatch[1];
      }
      // Fall back to percentage-based ETA
      const elapsed = this.elapsedSeconds();
      if (progress > 2 && elapsed > 10) {
        // Simple linear estimate: (elapsed / progress) * remaining_progress
        const totalEstimate = elapsed / (progress / 100);
        const remaining = totalEstimate - elapsed;
        if (remaining > 0) {
          return this.formatDuration(Math.round(remaining));
        }
      }
      return 'Calculating...';
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
  // For resume jobs, distributes baseline progress evenly so all workers start at the same %
  getWorkerPercentage(worker: ParallelWorkerProgress, job?: QueueJob): number {
    const workerCount = job?.parallelWorkers?.length || 1;

    // For resume jobs, distribute completed sentences evenly among workers
    // so each worker's progress reflects their share of the overall book
    if (job?.isResumeJob && job.resumeCompletedSentences !== undefined && job.resumeMissingSentences !== undefined) {
      const totalSentences = job.resumeCompletedSentences + job.resumeMissingSentences;
      if (totalSentences > 0 && workerCount > 0) {
        // Each worker is "responsible for" an equal share of the book
        const totalPerWorker = totalSentences / workerCount;
        // Distribute already-completed sentences evenly as baseline
        const baselinePerWorker = job.resumeCompletedSentences / workerCount;
        // Use actualConversions for resume jobs (accurate count of TTS work done)
        const workDone = worker.actualConversions ?? worker.completedSentences;
        // Worker's progress = (baseline + work done) / total responsibility
        return Math.min(100, ((baselinePerWorker + workDone) / totalPerWorker) * 100);
      }
    }

    // Fresh job: show progress through the full range
    const totalInRange = worker.sentenceEnd - worker.sentenceStart + 1;
    if (totalInRange <= 0) return 0;
    return Math.min(100, (worker.completedSentences / totalInRange) * 100);
  }

  // Get ETA display - takes job directly to ensure reactivity
  getEtaDisplay(job: QueueJob): string {
    // Subscribe to tick for reactivity (ensures re-render on timer tick)
    this.tick();

    if (!job || job.status !== 'processing') {
      return '-';
    }

    const progress = job.progress || 0;
    if (progress >= 100) {
      return 'Complete';
    }

    // For resemble-enhance jobs, parse ETA from progressMessage
    if (job.type === 'resemble-enhance') {
      const message = job.progressMessage || '';
      // Extract time from "Enhancing: 13% (57:54 remaining)"
      const remainingMatch = message.match(/\(([^)]+)\s+remaining\)/);
      if (remainingMatch && remainingMatch[1]) {
        // Parse mm:ss or hh:mm:ss format to seconds and reformat consistently
        const timeParts = remainingMatch[1].split(':').map(Number);
        let seconds = 0;
        if (timeParts.length === 2) {
          seconds = timeParts[0] * 60 + timeParts[1];
        } else if (timeParts.length === 3) {
          seconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
        }
        if (seconds > 0) {
          return this.formatDuration(seconds);
        }
        return remainingMatch[1];
      }
      // Fall back to percentage-based ETA
      const elapsed = this.elapsedSeconds();
      if (progress > 2 && elapsed > 10) {
        const totalEstimate = elapsed / (progress / 100);
        const remaining = totalEstimate - elapsed;
        if (remaining > 0) {
          return this.formatDuration(Math.round(remaining));
        }
      }
      return 'Calculating...';
    }

    // For OCR cleanup and TTS jobs with chunk data, calculate ETA directly
    // This avoids issues with effect batching in parallel processing
    const chunksCompleted = job.chunksCompletedInJob || 0;
    const totalChunks = job.totalChunksInJob || job.totalChunks || 0;
    // Use session-specific count for rate calculation (critical for resume jobs)
    const chunksDoneInSession = job.chunksDoneInSession || chunksCompleted;

    if (chunksDoneInSession >= 2 && totalChunks > 0) {
      const elapsed = this.elapsedSeconds();
      if (elapsed > 10) {
        // Calculate rate based on work done in THIS session only
        const avgTimePerChunk = elapsed / chunksDoneInSession;
        // But remaining work is based on total progress
        const remainingChunks = totalChunks - chunksCompleted;
        const remainingSeconds = Math.round(remainingChunks * avgTimePerChunk);
        return this.formatDuration(remainingSeconds);
      }
    }

    // For reassembly jobs, use the effect-based calculation
    if (job.type === 'reassembly') {
      return this.etaFormatted();
    }

    // For resume jobs without enough session data, don't use percentage-based fallback
    // (percentage includes previous session work, but elapsed time is only this session)
    if (job.isResumeJob) {
      return 'Calculating...';
    }

    // Fall back to percentage-based ETA (only for fresh jobs)
    const elapsed = this.elapsedSeconds();
    if (progress > 2 && elapsed > 10) {
      const totalEstimate = elapsed / (progress / 100);
      const remaining = totalEstimate - elapsed;
      if (remaining > 0) {
        return this.formatDuration(Math.round(remaining));
      }
    }

    return 'Calculating...';
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

  getBilingualPhase(): string {
    const j = this.job();
    if (!j) return '-';

    const progress = j.progress || 0;
    const message = j.progressMessage?.toLowerCase() || '';

    // Use message content to determine phase
    if (message.includes('extract')) {
      return 'Extracting';
    }
    if (message.includes('clean')) {
      return 'AI Cleanup';
    }
    if (message.includes('split')) {
      return 'Splitting';
    }
    if (message.includes('translat')) {
      return 'Translating';
    }
    if (message.includes('epub')) {
      return 'Generating EPUB';
    }
    if (message.includes('tts')) {
      return 'TTS Conversion';
    }

    // Fall back to progress-based phase
    if (progress < 5) {
      return 'Extracting';
    } else if (progress < 20) {
      return 'AI Cleanup';
    } else if (progress < 22) {
      return 'Splitting';
    } else if (progress < 70) {
      return 'Translating';
    } else if (progress < 75) {
      return 'Generating EPUB';
    } else {
      return 'TTS Conversion';
    }
  }

  getAssemblySubPhaseLabel(subPhase: string | undefined): string {
    switch (subPhase) {
      case 'combining': return 'Combining audio';
      case 'vtt': return 'Building subtitles';
      case 'encoding': return 'Encoding M4B';
      case 'metadata': return 'Writing metadata';
      default: return subPhase || '';
    }
  }

  // Check if TTS job has skipAssembly (bilingual workflow - assembly is separate job)
  hasSkipAssembly(job: QueueJob): boolean {
    const config = job.config as { skipAssembly?: boolean } | undefined;
    return config?.skipAssembly === true;
  }

  // Assembly phase order and percentage ranges (based on bilingual-assembly-bridge.ts emissions)
  // combining: 0-70%, vtt: 70-85%, encoding: 85-100%, metadata: (not explicitly emitted, part of encoding)
  private readonly assemblyPhaseOrder: string[] = ['combining', 'vtt', 'encoding', 'metadata'];
  private readonly assemblyPhaseRanges: Record<string, { start: number; end: number }> = {
    'combining': { start: 0, end: 70 },
    'vtt': { start: 70, end: 85 },
    'encoding': { start: 85, end: 95 },
    'metadata': { start: 95, end: 100 }
  };

  // Check if an assembly phase is complete
  isAssemblyPhaseComplete(phase: string, job: QueueJob): boolean {
    const progress = job.progress || 0;
    const range = this.assemblyPhaseRanges[phase];
    if (!range) return false;

    // Phase is complete if progress is past its end
    return progress >= range.end || job.status === 'complete';
  }

  // Check if an assembly phase has started
  isAssemblyPhaseStarted(phase: string, job: QueueJob): boolean {
    const progress = job.progress || 0;
    const range = this.assemblyPhaseRanges[phase];
    if (!range) return false;

    // Phase has started if progress is at or past its start
    return progress >= range.start;
  }

  // Get progress percentage for an assembly phase (0-100 within the phase)
  getAssemblyPhaseProgress(phase: string, job: QueueJob): number {
    const progress = job.progress || 0;
    const range = this.assemblyPhaseRanges[phase];
    if (!range) return 0;

    if (progress < range.start) return 0;
    if (progress >= range.end) return 100;

    // Map job progress to phase progress (0-100)
    const phaseWidth = range.end - range.start;
    return ((progress - range.start) / phaseWidth) * 100;
  }

  // Get display percentage for an assembly phase
  getAssemblyPhasePct(phase: string, job: QueueJob): string {
    if (!this.isAssemblyPhaseStarted(phase, job)) {
      return '--';
    }
    const progress = this.getAssemblyPhaseProgress(phase, job);
    return `${Math.round(progress)}%`;
  }
}

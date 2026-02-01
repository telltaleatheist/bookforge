/**
 * Queue Service - Manages the unified processing queue
 *
 * Signal-based state management for job queue operations.
 * Jobs are processed sequentially and automatically.
 */

import { Injectable, inject, signal, computed, DestroyRef, NgZone, effect } from '@angular/core';
import {
  QueueJob,
  JobType,
  JobStatus,
  QueueState,
  QueueProgress,
  JobResult,
  CreateJobRequest,
  OcrCleanupConfig,
  TtsConversionConfig,
  TranslationJobConfig,
  ReassemblyJobConfig,
  ResembleEnhanceJobConfig,
  ResumeCheckResult,
  TtsResumeInfo
} from '../models/queue.types';
import { AIProvider } from '../../../core/models/ai-config.types';

// AI Provider config for IPC
interface AIProviderConfig {
  provider: AIProvider;
  ollama?: { baseUrl: string; model: string };
  claude?: { apiKey: string; model: string };
  openai?: { apiKey: string; model: string };
}

// Parallel TTS progress type
interface ParallelWorkerState {
  id: number;
  sentenceStart: number;
  sentenceEnd: number;
  currentSentence: number;
  completedSentences: number;
  status: 'pending' | 'running' | 'complete' | 'error';
  error?: string;
}

interface ParallelAggregatedProgress {
  phase: 'preparing' | 'converting' | 'assembling' | 'complete' | 'error';
  totalSentences: number;
  completedSentences: number;
  percentage: number;
  activeWorkers: number;
  workers: ParallelWorkerState[];
  estimatedRemaining: number;
  message?: string;
  error?: string;
}

// Access window.electron directly
declare global {
  interface Window {
    electron?: {
      queue?: {
        runOcrCleanup: (jobId: string, epubPath: string, model?: string, aiConfig?: AIProviderConfig & {
          useDetailedCleanup?: boolean;
          deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
          useParallel?: boolean;
          parallelWorkers?: number;
          cleanupMode?: 'structure' | 'full';
          testMode?: boolean;
        }) => Promise<{ success: boolean; data?: any; error?: string }>;
        runTtsConversion: (jobId: string, epubPath: string, config: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        runTranslation: (jobId: string, epubPath: string, translationConfig: any, aiConfig?: AIProviderConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
        cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
        saveState: (queueState: string) => Promise<{ success: boolean; error?: string }>;
        loadState: () => Promise<{ success: boolean; data?: any; error?: string }>;
        onProgress: (callback: (progress: QueueProgress) => void) => () => void;
        onComplete: (callback: (result: JobResult) => void) => () => void;
      };
      parallelTts?: {
        detectRecommendedWorkerCount: () => Promise<{ success: boolean; data?: { count: number; reason: string }; error?: string }>;
        startConversion: (jobId: string, config: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        stopConversion: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
        getProgress: (jobId: string) => Promise<{ success: boolean; data?: ParallelAggregatedProgress | null; error?: string }>;
        isActive: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
        listActive: () => Promise<{ success: boolean; data?: Array<{ jobId: string; progress: ParallelAggregatedProgress; epubPath: string; startTime: number }>; error?: string }>;
        onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => () => void;
        onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any }) => void) => () => void;
        // Resume support
        checkResumeFast: (epubPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
        checkResume: (sessionPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
        resumeConversion: (jobId: string, config: any, resumeInfo: ResumeCheckResult) => Promise<{ success: boolean; data?: any; error?: string }>;
        buildResumeInfo: (prepInfo: any, settings: any) => Promise<{ success: boolean; data?: TtsResumeInfo; error?: string }>;
      };
      shell?: {
        openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
      };
      ai?: {
        checkProviderConnection: (provider: AIProvider) => Promise<{ success: boolean; data?: { available: boolean; error?: string; models?: string[] }; error?: string }>;
      };
      epub?: {
        editText: (epubPath: string, chapterId: string, oldText: string, newText: string) => Promise<{ success: boolean; error?: string }>;
      };
      fs?: {
        exists: (filePath: string) => Promise<boolean>;
      };
      reassembly?: {
        startReassembly: (jobId: string, config: {
          sessionId: string;
          sessionDir: string;
          processDir: string;
          outputDir: string;
          metadata: { title: string; author: string; year?: string; coverPath?: string; outputFilename?: string };
          excludedChapters: number[];
        }) => Promise<{ success: boolean; data?: { outputPath?: string }; error?: string }>;
        onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
      };
      resemble?: {
        runForQueue: (jobId: string, config: {
          inputPath: string;
          outputPath?: string;
          projectId?: string;
          bfpPath?: string;
          replaceOriginal?: boolean;
        }) => Promise<{ success: boolean; data?: { success: boolean; outputPath?: string; error?: string }; error?: string }>;
      };
    };
  }
}

@Injectable({
  providedIn: 'root'
})
export class QueueService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly ngZone = inject(NgZone);

  // Progress listener cleanup
  private unsubscribeProgress: (() => void) | null = null;
  private unsubscribeComplete: (() => void) | null = null;
  private unsubscribeParallelProgress: (() => void) | null = null;
  private unsubscribeParallelComplete: (() => void) | null = null;
  private unsubscribeReassemblyProgress: (() => void) | null = null;

  // State signals
  private readonly _jobs = signal<QueueJob[]>([]);
  private readonly _isRunning = signal<boolean>(false); // Don't auto-run - user starts manually
  private readonly _currentJobId = signal<string | null>(null); // Queue-driven job
  private readonly _standaloneJobIds = signal<Set<string>>(new Set()); // Manually started jobs
  private readonly _lastCompletedJobWithAnalytics = signal<{
    jobId: string;
    jobType: string;
    bfpPath?: string;
    analytics: any;
  } | null>(null);

  // Public readonly computed signals
  readonly jobs = computed(() => this._jobs());
  readonly isRunning = computed(() => this._isRunning());
  readonly currentJobId = computed(() => this._currentJobId());
  readonly standaloneJobIds = computed(() => this._standaloneJobIds());
  readonly lastCompletedJobWithAnalytics = computed(() => this._lastCompletedJobWithAnalytics());

  // Check if any job is currently running (queue or standalone)
  readonly hasActiveJobs = computed(() =>
    this._currentJobId() !== null || this._standaloneJobIds().size > 0
  );

  // Computed helpers
  readonly currentJob = computed(() => {
    const id = this._currentJobId();
    if (!id) return null;
    return this._jobs().find(j => j.id === id) || null;
  });

  readonly pendingJobs = computed(() =>
    this._jobs().filter(j => j.status === 'pending')
  );

  readonly completedJobs = computed(() =>
    this._jobs().filter(j => j.status === 'complete')
  );

  readonly errorJobs = computed(() =>
    this._jobs().filter(j => j.status === 'error')
  );

  readonly queueLength = computed(() =>
    this._jobs().filter(j => j.status === 'pending' || j.status === 'processing').length
  );

  constructor() {
    this.setupIpcListeners();

    // Load persisted queue state on startup
    this.loadQueueState();

    // Auto-save queue state when jobs change (debounced)
    let saveTimeout: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const jobs = this._jobs();
      // Debounce saves to avoid excessive writes
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        this.saveQueueState();
      }, 500);
    });

    this.destroyRef.onDestroy(() => {
      if (this.unsubscribeProgress) {
        this.unsubscribeProgress();
      }
      if (this.unsubscribeComplete) {
        this.unsubscribeComplete();
      }
      if (this.unsubscribeParallelProgress) {
        this.unsubscribeParallelProgress();
      }
      if (this.unsubscribeParallelComplete) {
        this.unsubscribeParallelComplete();
      }
      if (this.unsubscribeReassemblyProgress) {
        this.unsubscribeReassemblyProgress();
      }
    });
  }

  private setupIpcListeners(): void {
    const electron = window.electron;
    if (!electron?.queue) return;

    // Listen for progress updates
    this.unsubscribeProgress = electron.queue.onProgress((progress: QueueProgress) => {
      this.ngZone.run(() => {
        this.handleProgressUpdate(progress);
      });
    });

    // Listen for job completion
    this.unsubscribeComplete = electron.queue.onComplete((result: JobResult) => {
      this.ngZone.run(() => {
        this.handleJobComplete(result);
      });
    });

    // Listen for parallel TTS progress updates
    if (electron.parallelTts) {
      this.unsubscribeParallelProgress = electron.parallelTts.onProgress((data) => {
        this.ngZone.run(() => {
          this.handleParallelProgressUpdate(data.jobId, data.progress);
        });
      });

      this.unsubscribeParallelComplete = electron.parallelTts.onComplete((data) => {
        this.ngZone.run(() => {
          this.handleJobComplete({
            jobId: data.jobId,
            success: data.success,
            outputPath: data.outputPath,
            error: data.error,
            analytics: data.analytics
          });
        });
      });
    }

    // Listen for reassembly progress updates
    if (electron.reassembly) {
      this.unsubscribeReassemblyProgress = electron.reassembly.onProgress((data) => {
        this.ngZone.run(() => {
          this.handleReassemblyProgressUpdate(data.jobId, data.progress);
        });
      });
    }
  }

  private handleReassemblyProgressUpdate(jobId: string, progress: any): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;
        return {
          ...job,
          progress: progress.percentage || 0,
          status: progress.phase === 'complete' ? 'completed' as JobStatus :
                  progress.phase === 'error' ? 'error' as JobStatus :
                  'processing' as JobStatus,
          currentChapter: progress.currentChapter,
          totalChapters: progress.totalChapters,
          progressMessage: progress.message || progress.phase,
          error: progress.error
        };
      })
    );
  }

  private handleProgressUpdate(progress: QueueProgress): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== progress.jobId) return job;
        return {
          ...job,
          progress: progress.progress,
          status: 'processing' as JobStatus,
          // Track outputPath from progress for diff view during processing
          outputPath: progress.outputPath || job.outputPath,
          // Progress tracking for ETA calculation
          currentChunk: progress.currentChunk,
          totalChunks: progress.totalChunks,
          currentChapter: progress.currentChapter,
          totalChapters: progress.totalChapters,
          chunksCompletedInJob: progress.chunksCompletedInJob,
          totalChunksInJob: progress.totalChunksInJob,
          chunkCompletedAt: progress.chunkCompletedAt,
          progressMessage: progress.message
        };
      })
    );
    // Don't save on every progress update - too frequent
  }

  private handleParallelProgressUpdate(jobId: string, progress: ParallelAggregatedProgress): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        // For resume jobs, ensure progress is capped at 100% and uses correct counts
        let displayProgress = progress.percentage;
        let displayCompleted = progress.completedSentences;
        let displayTotal = progress.totalSentences;

        // During assembly phase, show phase-specific progress instead of overall
        // This makes the progress bar show meaningful progress for each phase
        if (progress.phase === 'assembling' && (progress as any).assemblyProgress !== undefined) {
          displayProgress = (progress as any).assemblyProgress;
        }

        // Cap percentage at 100% (in case of any calculation issues)
        if (displayProgress > 100) {
          displayProgress = Math.min(100, displayProgress);
        }

        // Build progress message
        let progressMessage = progress.message;
        if (!progressMessage) {
          if (job.isResumeJob) {
            progressMessage = `Resuming: ${progress.activeWorkers} workers (${displayCompleted}/${displayTotal} sentences)`;
          } else {
            progressMessage = `${progress.activeWorkers} workers active (${displayCompleted}/${displayTotal} sentences)`;
          }
        }

        return {
          ...job,
          progress: displayProgress,
          status: 'processing' as JobStatus,
          progressMessage,
          // Map parallel progress to ETA calculation fields
          chunksCompletedInJob: displayCompleted,
          totalChunksInJob: displayTotal,
          chunkCompletedAt: displayCompleted > (job.chunksCompletedInJob || 0) ? Date.now() : job.chunkCompletedAt,
          // Session-specific progress for accurate ETA (especially for resume jobs)
          chunksDoneInSession: (progress as any).completedInSession || displayCompleted,
          // Store per-worker progress for UI display
          parallelWorkers: progress.workers.map(w => ({
            id: w.id,
            sentenceStart: w.sentenceStart,
            sentenceEnd: w.sentenceEnd,
            completedSentences: w.completedSentences,
            status: w.status,
            error: w.error,
            totalAssigned: (w as any).totalAssigned
          }))
        };
      })
    );
    // Don't save on every progress update - too frequent
  }

  private handleJobComplete(result: JobResult): void {
    console.log(`[QUEUE] handleJobComplete called for job ${result.jobId}, success=${result.success}`);
    console.log(`[QUEUE] Current state: isRunning=${this._isRunning()}, currentJobId=${this._currentJobId()}`);

    // Get the job before updating to capture the type
    const completedJob = this._jobs().find(j => j.id === result.jobId);

    // Update the job status
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== result.jobId) return job;
        return {
          ...job,
          status: result.success ? 'complete' : 'error',
          error: result.error,
          progress: result.success ? 100 : job.progress,
          completedAt: new Date(),
          outputPath: result.outputPath || job.outputPath,
          // Copyright detection for AI cleanup jobs
          copyrightIssuesDetected: result.copyrightIssuesDetected,
          copyrightChunksAffected: result.copyrightChunksAffected,
          // Content skips detection for AI cleanup jobs
          contentSkipsDetected: result.contentSkipsDetected,
          contentSkipsAffected: result.contentSkipsAffected,
          // Path to skipped chunks JSON
          skippedChunksPath: result.skippedChunksPath,
          // Analytics data
          analytics: result.analytics
        };
      })
    );

    // Save analytics directly to BFP (no longer using signal/effect pattern to avoid duplicates)
    if (result.analytics && completedJob?.bfpPath) {
      this.saveAnalyticsToBfp(
        completedJob.bfpPath,
        completedJob.type,
        result.analytics
      );
    }

    // Check if this was a standalone job
    const standaloneIds = this._standaloneJobIds();
    if (standaloneIds.has(result.jobId)) {
      // Standalone job completed - just remove from tracking, don't process next
      const newSet = new Set(standaloneIds);
      newSet.delete(result.jobId);
      this._standaloneJobIds.set(newSet);
      console.log(`[QUEUE] Standalone job ${result.jobId} completed, not processing next`);
      return;
    }

    // Only clear current job and process next if this IS the current queue job
    // This prevents a failed TTS job from interrupting a running OCR job
    if (this._currentJobId() === result.jobId) {
      this._currentJobId.set(null);

      // Process next job if queue is running
      if (this._isRunning()) {
        console.log(`[QUEUE] Job ${result.jobId} completed, processing next job`);
        this.processNext();
      } else {
        console.log(`[QUEUE] Job ${result.jobId} completed but queue is paused, not processing next`);
      }
    } else {
      console.log(`[QUEUE] Job ${result.jobId} completed but is not the current job (${this._currentJobId()}), not processing next`);
    }
  }

  /**
   * Add a new job to the queue
   * Automatically starts processing if queue is idle
   */
  async addJob(request: CreateJobRequest): Promise<QueueJob> {
    const filename = request.epubPath.split('/').pop() || 'unknown.epub';

    const job: QueueJob = {
      id: this.generateId(),
      type: request.type,
      epubPath: request.epubPath,
      epubFilename: filename,
      status: 'pending',
      addedAt: new Date(),
      metadata: request.metadata,
      config: this.buildJobConfig(request),
      bfpPath: request.bfpPath  // For analytics saving
    };

    // Handle resume info if provided
    if (request.resumeInfo && request.type === 'tts-conversion') {
      job.isResumeJob = true;
      job.resumeCompletedSentences = request.resumeInfo.completedSentences;
      job.resumeMissingSentences = request.resumeInfo.missingSentences;

      // Store resume info in config
      const config = job.config as TtsConversionConfig;
      if (config) {
        config.resumeInfo = {
          sessionId: request.resumeInfo.sessionId!,
          sessionDir: request.resumeInfo.sessionDir!,
          processDir: request.resumeInfo.processDir!,
          totalSentences: request.resumeInfo.totalSentences!,
          totalChapters: request.resumeInfo.totalChapters!,
          chapters: request.resumeInfo.chapters || [],
          language: config.language,
          voice: config.fineTuned,
          ttsEngine: config.ttsEngine,
          createdAt: new Date().toISOString()
        };
        // Also store the missing ranges for the parallel bridge
        (config as any).missingRanges = request.resumeInfo.missingRanges;
      }

      console.log('[QUEUE] Resume job added:', {
        jobId: job.id,
        completedSentences: job.resumeCompletedSentences,
        missingSentences: job.resumeMissingSentences,
        sessionId: request.resumeInfo.sessionId
      });
    }

    console.log('[QUEUE] Job added:', {
      jobId: job.id,
      type: job.type,
      config: job.config,
      metadata: job.metadata,
      'metadata.outputFilename': job.metadata?.outputFilename,
      isResume: job.isResumeJob
    });

    this._jobs.update(jobs => [...jobs, job]);

    // Don't auto-start - user must manually start the queue

    return job;
  }

  /**
   * Remove a job from the queue
   * If the job is currently processing, it will be cancelled first
   */
  async removeJob(jobId: string): Promise<boolean> {
    const job = this._jobs().find(j => j.id === jobId);
    if (!job) return false;

    // If job is processing, cancel it first
    if (job.status === 'processing') {
      const electron = window.electron;
      if (electron?.queue) {
        await electron.queue.cancelJob(jobId);
      }
      this._currentJobId.set(null);
    }

    this._jobs.update(jobs => jobs.filter(j => j.id !== jobId));
    return true;
  }

  /**
   * Clear completed/error jobs from the queue
   */
  clearCompleted(): void {
    this._jobs.update(jobs =>
      jobs.filter(j => j.status === 'pending' || j.status === 'processing')
    );
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<boolean> {
    const job = this._jobs().find(j => j.id === jobId);
    if (!job || job.status !== 'error') return false;

    // Reset job to pending
    this._jobs.update(jobs =>
      jobs.map(j => {
        if (j.id !== jobId) return j;
        return {
          ...j,
          status: 'pending' as JobStatus,
          error: undefined,
          progress: undefined,
          startedAt: undefined,
          completedAt: undefined
        };
      })
    );

    // Try to process if queue is running
    if (this._isRunning() && !this._currentJobId()) {
      await this.processNext();
    }

    return true;
  }

  /**
   * Start/resume queue processing
   */
  async startQueue(): Promise<void> {
    this._isRunning.set(true);
    if (!this._currentJobId()) {
      await this.processNext();
    }
  }

  /**
   * Pause queue processing (current job will complete)
   */
  pauseQueue(): void {
    this._isRunning.set(false);
  }

  /**
   * Stop queue processing immediately - kills current AI job and resets it to pending
   */
  async stopQueue(): Promise<void> {
    this._isRunning.set(false);

    const currentId = this._currentJobId();
    if (!currentId) return;

    const electron = window.electron;
    if (!electron?.queue) return;

    // Cancel the job (this will unload the AI model)
    await electron.queue.cancelJob(currentId);

    // Reset the job to pending so it can be restarted
    this._jobs.update(jobs =>
      jobs.map(j => {
        if (j.id !== currentId) return j;
        return {
          ...j,
          status: 'pending' as JobStatus,
          error: undefined,
          progress: undefined,
          startedAt: undefined
        };
      })
    );

    this._currentJobId.set(null);
  }

  /**
   * Cancel the currently running job
   */
  async cancelCurrent(): Promise<boolean> {
    const currentId = this._currentJobId();
    if (!currentId) return false;

    const electron = window.electron;
    if (!electron?.queue) return false;

    const result = await electron.queue.cancelJob(currentId);
    if (result.success) {
      this._jobs.update(jobs =>
        jobs.map(j => {
          if (j.id !== currentId) return j;
          return {
            ...j,
            status: 'error' as JobStatus,
            error: 'Cancelled by user'
          };
        })
      );
      this._currentJobId.set(null);

      // Process next if running
      if (this._isRunning()) {
        await this.processNext();
      }
    }

    return result.success;
  }

  /**
   * Start a specific job as standalone (doesn't chain to next job when complete)
   * Can run alongside the queue - useful for running reassembly while TTS is processing
   */
  async runJobStandalone(jobId: string): Promise<boolean> {
    const job = this._jobs().find(j => j.id === jobId);
    if (!job) {
      console.error(`[QUEUE] Job ${jobId} not found`);
      return false;
    }

    if (job.status !== 'pending') {
      console.error(`[QUEUE] Job ${jobId} is not pending (status: ${job.status})`);
      return false;
    }

    // Mark job as standalone
    this._jobs.update(jobs =>
      jobs.map(j => {
        if (j.id !== jobId) return j;
        return { ...j, isStandalone: true };
      })
    );

    // Track in standalone set
    const newSet = new Set(this._standaloneJobIds());
    newSet.add(jobId);
    this._standaloneJobIds.set(newSet);

    console.log(`[QUEUE] Starting standalone job ${jobId}`);

    // Run the job (reuse existing runJob logic)
    await this.runJob(job);

    return true;
  }

  /**
   * Move a job up in the queue
   */
  moveJobUp(jobId: string): boolean {
    const jobs = this._jobs();
    const index = jobs.findIndex(j => j.id === jobId);
    if (index <= 0) return false;

    const job = jobs[index];
    if (job.status !== 'pending') return false;

    // Find the previous pending job
    let targetIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (jobs[i].status === 'pending') {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) return false;

    const newJobs = [...jobs];
    newJobs.splice(index, 1);
    newJobs.splice(targetIndex, 0, job);
    this._jobs.set(newJobs);
    return true;
  }

  /**
   * Move a job down in the queue
   */
  moveJobDown(jobId: string): boolean {
    const jobs = this._jobs();
    const index = jobs.findIndex(j => j.id === jobId);
    if (index === -1 || index >= jobs.length - 1) return false;

    const job = jobs[index];
    if (job.status !== 'pending') return false;

    // Find the next pending job
    let targetIndex = -1;
    for (let i = index + 1; i < jobs.length; i++) {
      if (jobs[i].status === 'pending') {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) return false;

    const newJobs = [...jobs];
    newJobs.splice(index, 1);
    newJobs.splice(targetIndex, 0, job);
    this._jobs.set(newJobs);
    return true;
  }

  /**
   * Reorder jobs via drag-and-drop using job IDs
   * This correctly handles filtered views (activeJobs vs full jobs array)
   * Only pending jobs can be reordered
   */
  reorderJobsById(fromId: string, toId: string): boolean {
    const jobs = this._jobs();
    const fromIndex = jobs.findIndex(j => j.id === fromId);
    let toIndex = jobs.findIndex(j => j.id === toId);

    if (fromIndex === -1 || toIndex === -1) return false;
    if (fromIndex === toIndex) return false;

    const job = jobs[fromIndex];
    if (job.status !== 'pending') return false;

    const newJobs = [...jobs];
    newJobs.splice(fromIndex, 1);
    // After removal, indices shift - recalculate toIndex
    if (fromIndex < toIndex) {
      toIndex--;
    }
    newJobs.splice(toIndex, 0, job);
    this._jobs.set(newJobs);
    return true;
  }

  /**
   * @deprecated Use reorderJobsById instead - this has issues with filtered views
   */
  reorderJobs(fromIndex: number, toIndex: number): boolean {
    const jobs = this._jobs();
    if (fromIndex < 0 || fromIndex >= jobs.length) return false;
    if (toIndex < 0 || toIndex >= jobs.length) return false;
    if (fromIndex === toIndex) return false;

    const job = jobs[fromIndex];
    if (job.status !== 'pending') return false;

    const newJobs = [...jobs];
    newJobs.splice(fromIndex, 1);
    newJobs.splice(toIndex, 0, job);
    this._jobs.set(newJobs);
    return true;
  }

  /**
   * Process the next pending job in the queue
   */
  private async processNext(): Promise<void> {
    if (this._currentJobId()) return; // Already processing

    const pending = this._jobs().filter(j => j.status === 'pending');
    if (pending.length === 0) return;

    const nextJob = pending[0];
    await this.runJob(nextJob);
  }

  /**
   * Run a specific job
   */
  private async runJob(job: QueueJob): Promise<void> {
    const electron = window.electron;
    if (!electron?.queue) {
      this._jobs.update(jobs =>
        jobs.map(j => {
          if (j.id !== job.id) return j;
          return { ...j, status: 'error' as JobStatus, error: 'Electron not available' };
        })
      );
      return;
    }

    // Check if this is a standalone job (already tracked in _standaloneJobIds)
    const isStandalone = this._standaloneJobIds().has(job.id);

    // Only set as current job if not standalone
    if (!isStandalone) {
      this._currentJobId.set(job.id);
    }

    // Update job status to processing
    this._jobs.update(jobs =>
      jobs.map(j => {
        if (j.id !== job.id) return j;
        return {
          ...j,
          status: 'processing' as JobStatus,
          startedAt: new Date(),
          progress: 0
        };
      })
    );

    // Start the appropriate job type
    try {
      if (job.type === 'ocr-cleanup') {
        const config = job.config as OcrCleanupConfig | undefined;
        if (!config) {
          throw new Error('OCR cleanup configuration required');
        }
        // Build AI config from per-job settings
        const aiConfig: AIProviderConfig & {
          useDetailedCleanup?: boolean;
          deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
          useParallel?: boolean;
          parallelWorkers?: number;
          cleanupMode?: 'structure' | 'full';
          testMode?: boolean;
        } = {
          provider: config.aiProvider,
          ollama: config.aiProvider === 'ollama' ? {
            baseUrl: config.ollamaBaseUrl || 'http://localhost:11434',
            model: config.aiModel
          } : undefined,
          claude: config.aiProvider === 'claude' ? {
            apiKey: config.claudeApiKey || '',
            model: config.aiModel
          } : undefined,
          openai: config.aiProvider === 'openai' ? {
            apiKey: config.openaiApiKey || '',
            model: config.aiModel
          } : undefined,
          // Detailed cleanup options
          useDetailedCleanup: config.useDetailedCleanup,
          deletedBlockExamples: config.deletedBlockExamples,
          // Parallel processing (Claude/OpenAI only)
          useParallel: config.useParallel,
          parallelWorkers: config.parallelWorkers,
          // Cleanup mode
          cleanupMode: config.cleanupMode || 'structure',
          // Test mode
          testMode: config.testMode
        };
        console.log('[QUEUE] Job config from storage:', { testMode: config.testMode, cleanupMode: config.cleanupMode, fullConfig: JSON.stringify(config) });
        console.log('[QUEUE] Built aiConfig:', { testMode: aiConfig.testMode, cleanupMode: aiConfig.cleanupMode });
        console.log('[QUEUE] Calling runOcrCleanup with:', {
          jobId: job.id,
          model: config.aiModel,
          useDetailedCleanup: config.useDetailedCleanup,
          exampleCount: config.deletedBlockExamples?.length || 0,
          cleanupMode: config.cleanupMode || 'structure',
          testMode: config.testMode,
          aiConfig: {
            provider: aiConfig.provider,
            ollamaModel: aiConfig.ollama?.model,
            claudeModel: aiConfig.claude?.model,
            openaiModel: aiConfig.openai?.model
          }
        });
        await electron.queue.runOcrCleanup(job.id, job.epubPath, config.aiModel, aiConfig);
      } else if (job.type === 'translation') {
        const config = job.config as TranslationJobConfig | undefined;
        if (!config) {
          throw new Error('Translation configuration required');
        }
        // Build AI config from per-job settings
        const aiConfig: AIProviderConfig = {
          provider: config.aiProvider,
          ollama: config.aiProvider === 'ollama' ? {
            baseUrl: config.ollamaBaseUrl || 'http://localhost:11434',
            model: config.aiModel
          } : undefined,
          claude: config.aiProvider === 'claude' ? {
            apiKey: config.claudeApiKey || '',
            model: config.aiModel
          } : undefined,
          openai: config.aiProvider === 'openai' ? {
            apiKey: config.openaiApiKey || '',
            model: config.aiModel
          } : undefined
        };
        const translationConfig = {
          chunkSize: config.chunkSize
        };
        console.log('[QUEUE] Calling runTranslation with:', {
          jobId: job.id,
          model: config.aiModel
        });
        await electron.queue.runTranslation(job.id, job.epubPath, translationConfig, aiConfig);
      } else if (job.type === 'tts-conversion') {
        const config = job.config as TtsConversionConfig | undefined;
        if (!config) {
          throw new Error('TTS configuration required');
        }

        // Check if parallel processing is enabled
        if (config.useParallel && electron.parallelTts) {
          // Determine worker count - auto-detect or use configured value
          let workerCount = config.parallelWorkers;
          if (!workerCount || workerCount <= 0) {
            try {
              const result = await electron.parallelTts.detectRecommendedWorkerCount();
              workerCount = result.data?.count || 2;
              console.log(`[QUEUE] Auto-detected ${workerCount} workers: ${result.data?.reason}`);
            } catch {
              workerCount = 2; // Default fallback
            }
          }

          const parallelMode = config.parallelMode || 'sentences';
          const resolvedOutputFilename = job.metadata?.outputFilename || config.outputFilename;
          console.log(`[QUEUE] Starting parallel TTS conversion with ${workerCount} workers in ${parallelMode} mode`);
          console.log(`[QUEUE] Output filename: ${resolvedOutputFilename}`);
          console.log(`[QUEUE] Output dir from config: '${config.outputDir}'`);
          console.log(`[QUEUE] job.metadata:`, job.metadata);
          console.log(`[QUEUE] config.outputFilename:`, config.outputFilename);
          console.log(`[QUEUE] isResumeJob:`, job.isResumeJob);

          // Prefer processed epubs in order: translated+cleaned > translated > cleaned > original
          let epubPathForTts = job.epubPath;
          if (job.outputPath) {
            // Job has an explicit output path (e.g., from chained workflow)
            epubPathForTts = job.outputPath;
            console.log(`[QUEUE] Using job.outputPath for TTS: ${epubPathForTts}`);
          } else if (electron.fs?.exists) {
            // Check for processed EPUBs in priority order
            const basePath = job.epubPath.replace(/\.epub$/i, '');
            const epubDir = job.epubPath.substring(0, job.epubPath.lastIndexOf('/'));
            const candidates = [
              `${basePath}_translated_cleaned.epub`,  // Translated + cleaned (best)
              `${basePath}_translated.epub`,           // Translated only
              `${basePath}_cleaned.epub`,              // Cleaned only (new naming: exported_cleaned.epub)
              `${epubDir}/cleaned.epub`                // Cleaned only (legacy naming: cleaned.epub)
            ];
            let foundPath: string | null = null;
            for (const candidatePath of candidates) {
              try {
                if (await electron.fs.exists(candidatePath)) {
                  foundPath = candidatePath;
                  break;
                }
              } catch {
                // Continue checking
              }
            }
            if (foundPath) {
              epubPathForTts = foundPath;
              console.log(`[QUEUE] Found processed epub, using: ${epubPathForTts}`);
            } else {
              console.log(`[QUEUE] No processed epub found, using original: ${epubPathForTts}`);
            }
          }

          const parallelConfig = {
            workerCount,
            epubPath: epubPathForTts,
            outputDir: config.outputDir || '',
            parallelMode,
            settings: {
              device: config.device,
              language: config.language,
              ttsEngine: config.ttsEngine,
              fineTuned: config.fineTuned,
              temperature: config.temperature,
              topP: config.topP,
              topK: config.topK,
              repetitionPenalty: config.repetitionPenalty,
              speed: config.speed,
              enableTextSplitting: config.enableTextSplitting
            },
            // Pass metadata for final audiobook (applied after assembly via m4b-tool)
            // Always pass metadata with at least the outputFilename for proper file naming
            metadata: {
              title: job.metadata?.title,
              author: job.metadata?.author,
              year: job.metadata?.year,
              coverPath: job.metadata?.coverPath,
              outputFilename: job.metadata?.outputFilename || config.outputFilename
            }
          };

          // Check if this is a resume job
          if (job.isResumeJob && config.resumeInfo) {
            // Build resume check result from stored info
            const resumeCheckResult: ResumeCheckResult = {
              success: true,
              sessionId: config.resumeInfo.sessionId,
              sessionDir: config.resumeInfo.sessionDir,
              processDir: config.resumeInfo.processDir,
              totalSentences: config.resumeInfo.totalSentences,
              totalChapters: config.resumeInfo.totalChapters,
              completedSentences: job.resumeCompletedSentences,
              missingSentences: job.resumeMissingSentences,
              missingRanges: (config as any).missingRanges,
              chapters: config.resumeInfo.chapters
            };

            console.log(`[QUEUE] Resuming TTS conversion from ${job.resumeCompletedSentences} sentences`);
            await electron.parallelTts.resumeConversion(job.id, parallelConfig, resumeCheckResult);
          } else {
            // Start fresh conversion
            await electron.parallelTts.startConversion(job.id, parallelConfig);
          }
        } else {
          // Use sequential TTS conversion (also check for translated/cleaned epub)
          let seqEpubPath = job.epubPath;
          if (job.outputPath) {
            seqEpubPath = job.outputPath;
          } else if (electron.fs?.exists) {
            const basePath = job.epubPath.replace(/\.epub$/i, '');
            const epubDir = job.epubPath.substring(0, job.epubPath.lastIndexOf('/'));
            const candidates = [
              `${basePath}_translated_cleaned.epub`,
              `${basePath}_translated.epub`,
              `${basePath}_cleaned.epub`,
              `${epubDir}/cleaned.epub`  // Legacy naming
            ];
            for (const candidatePath of candidates) {
              try {
                if (await electron.fs.exists(candidatePath)) {
                  seqEpubPath = candidatePath;
                  console.log(`[QUEUE] Sequential TTS: using processed epub: ${seqEpubPath}`);
                  break;
                }
              } catch { /* continue checking */ }
            }
          }
          await electron.queue.runTtsConversion(job.id, seqEpubPath, config);
        }
      } else if (job.type === 'reassembly') {
        // Reassembly job - reassemble incomplete e2a session
        const config = job.config as ReassemblyJobConfig | undefined;
        if (!config) {
          throw new Error('Reassembly configuration required');
        }

        console.log('[QUEUE] Starting reassembly job:', {
          sessionId: config.sessionId,
          outputDir: config.outputDir
        });

        // Call the reassembly API
        if (!electron.reassembly) {
          throw new Error('Reassembly not available');
        }

        const result = await electron.reassembly.startReassembly(job.id, config);
        if (!result.success) {
          throw new Error(result.error || 'Reassembly failed');
        }

        // The job completion will be handled by the onComplete callback
      } else if (job.type === 'resemble-enhance') {
        // Resemble Enhance job - audio enhancement/denoising
        const config = job.config as ResembleEnhanceJobConfig | undefined;
        if (!config) {
          throw new Error('Resemble Enhance configuration required');
        }

        console.log('[QUEUE] Starting resemble-enhance job:', {
          inputPath: config.inputPath,
          outputPath: config.outputPath,
          projectId: config.projectId,
          replaceOriginal: config.replaceOriginal
        });

        // Call the resemble API
        if (!electron.resemble) {
          throw new Error('Resemble Enhance not available');
        }

        const result = await electron.resemble.runForQueue(job.id, {
          inputPath: config.inputPath,
          outputPath: config.outputPath,
          projectId: config.projectId,
          bfpPath: config.bfpPath || job.bfpPath,
          replaceOriginal: config.replaceOriginal
        });
        if (!result.success) {
          throw new Error(result.error || 'Resemble Enhance failed');
        }

        // The job completion will be handled by the onComplete callback
      }
    } catch (err) {
      // Error starting job
      this._jobs.update(jobs =>
        jobs.map(j => {
          if (j.id !== job.id) return j;
          return {
            ...j,
            status: 'error' as JobStatus,
            error: err instanceof Error ? err.message : 'Failed to start job'
          };
        })
      );

      // Check if this was a standalone job
      const standaloneIds = this._standaloneJobIds();
      if (standaloneIds.has(job.id)) {
        // Remove from standalone tracking
        const newSet = new Set(standaloneIds);
        newSet.delete(job.id);
        this._standaloneJobIds.set(newSet);
        console.log(`[QUEUE] Standalone job ${job.id} failed to start`);
      } else {
        // Queue job - clear current and try next
        this._currentJobId.set(null);
        if (this._isRunning()) {
          await this.processNext();
        }
      }
    }
  }

  private buildJobConfig(request: CreateJobRequest): OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | ReassemblyJobConfig | ResembleEnhanceJobConfig | undefined {
    if (request.type === 'ocr-cleanup') {
      const config = request.config as Partial<OcrCleanupConfig>;
      if (!config?.aiProvider || !config?.aiModel) {
        return undefined; // AI provider and model are required
      }
      return {
        type: 'ocr-cleanup',
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        // Detailed cleanup mode settings
        useDetailedCleanup: config.useDetailedCleanup,
        deletedBlockExamples: config.deletedBlockExamples,
        // Parallel processing (Claude/OpenAI only)
        useParallel: config.useParallel,
        parallelWorkers: config.parallelWorkers,
        // Cleanup mode and test mode
        cleanupMode: config.cleanupMode,
        testMode: config.testMode
      };
    } else if (request.type === 'translation') {
      const config = request.config as Partial<TranslationJobConfig>;
      if (!config?.aiProvider || !config?.aiModel) {
        return undefined; // AI provider and model are required
      }
      return {
        type: 'translation',
        chunkSize: config.chunkSize,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey
      };
    } else if (request.type === 'tts-conversion') {
      const config = request.config as TtsConversionConfig;
      if (!config) return undefined;
      return {
        type: 'tts-conversion',
        device: config.device || 'mps',
        language: config.language || 'en',
        ttsEngine: config.ttsEngine || 'xtts',
        fineTuned: config.fineTuned || 'ScarlettJohansson',
        temperature: config.temperature ?? 0.7,
        topP: config.topP ?? 0.9,
        topK: config.topK ?? 40,
        repetitionPenalty: config.repetitionPenalty ?? 2.0,
        speed: config.speed ?? 1.0,
        enableTextSplitting: config.enableTextSplitting ?? false,
        outputFilename: config.outputFilename,
        outputDir: config.outputDir,
        // Parallel processing options
        parallelWorkers: config.parallelWorkers,
        useParallel: config.useParallel ?? false,
        parallelMode: config.parallelMode
      };
    } else if (request.type === 'reassembly') {
      const config = request.config as Partial<ReassemblyJobConfig>;
      if (!config?.sessionId || !config?.sessionDir || !config?.processDir || !config?.outputDir) {
        return undefined; // Session info and output dir are required
      }
      return {
        type: 'reassembly',
        sessionId: config.sessionId,
        sessionDir: config.sessionDir,
        processDir: config.processDir,
        outputDir: config.outputDir,
        metadata: config.metadata || { title: 'Unknown', author: 'Unknown' },
        excludedChapters: config.excludedChapters || []
      };
    } else if (request.type === 'resemble-enhance') {
      const config = request.config as Partial<ResembleEnhanceJobConfig>;
      if (!config?.inputPath) {
        return undefined; // Input path is required
      }
      return {
        type: 'resemble-enhance',
        inputPath: config.inputPath,
        outputPath: config.outputPath,
        projectId: config.projectId,
        bfpPath: config.bfpPath,
        replaceOriginal: config.replaceOriginal ?? true
      };
    }
    return undefined;
  }

  private generateId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Refresh queue state by checking for active backend jobs.
   * Used to re-sync UI after app rebuild when jobs are still running in background.
   */
  async refreshFromBackend(): Promise<void> {
    const electron = window.electron;
    if (!electron?.parallelTts?.listActive) {
      console.log('[QUEUE] No parallelTts.listActive available');
      return;
    }

    try {
      const result = await electron.parallelTts.listActive();
      if (!result.success || !result.data) {
        console.log('[QUEUE] No active sessions found');
        return;
      }

      const activeSessions = result.data;
      console.log(`[QUEUE] Found ${activeSessions.length} active backend sessions`);

      for (const session of activeSessions) {
        // Check if we have this job in our queue
        const existingJob = this._jobs().find(j => j.id === session.jobId);

        if (existingJob) {
          // Update existing job with current progress
          this._jobs.update(jobs =>
            jobs.map(j => {
              if (j.id !== session.jobId) return j;
              return {
                ...j,
                status: 'processing' as JobStatus,
                progress: session.progress.percentage,
                progressMessage: session.progress.message,
                parallelWorkers: session.progress.workers?.map(w => ({
                  id: w.id,
                  sentenceStart: w.sentenceStart,
                  sentenceEnd: w.sentenceEnd,
                  completedSentences: w.completedSentences,
                  status: w.status,
                  totalAssigned: (w as any).totalAssigned
                })),
                startedAt: new Date(session.startTime)
              };
            })
          );
          this._currentJobId.set(session.jobId);
          this._isRunning.set(true);
          console.log(`[QUEUE] Updated existing job ${session.jobId} with progress ${session.progress.percentage}%`);
        } else {
          // Create a placeholder job for the orphaned session
          const filename = session.epubPath.split('/').pop() || 'Unknown';
          const newJob: QueueJob = {
            id: session.jobId,
            type: 'tts-conversion',
            epubPath: session.epubPath,
            epubFilename: filename,
            status: 'processing',
            progress: session.progress.percentage,
            progressMessage: session.progress.message,
            parallelWorkers: session.progress.workers?.map(w => ({
              id: w.id,
              sentenceStart: w.sentenceStart,
              sentenceEnd: w.sentenceEnd,
              completedSentences: w.completedSentences,
              status: w.status,
              totalAssigned: (w as any).totalAssigned
            })),
            addedAt: new Date(session.startTime),
            startedAt: new Date(session.startTime),
            metadata: {
              title: filename.replace(/\.epub$/i, '').replace(/_/g, ' ')
            }
          };
          this._jobs.update(jobs => [...jobs, newJob]);
          this._currentJobId.set(session.jobId);
          this._isRunning.set(true);
          console.log(`[QUEUE] Created placeholder job for orphaned session ${session.jobId}`);
        }
      }

      if (activeSessions.length > 0) {
        console.log('[QUEUE] Refresh complete - queue is now synced with backend');
      }
    } catch (err) {
      console.error('[QUEUE] Error refreshing from backend:', err);
    }
  }

  /**
   * Save queue state to disk for persistence across app restarts/rebuilds
   */
  private async saveQueueState(): Promise<void> {
    const electron = window.electron;
    if (!electron?.queue?.saveState) return;

    try {
      // Serialize jobs, converting Date objects to ISO strings
      const jobs = this._jobs().map(job => ({
        ...job,
        addedAt: job.addedAt instanceof Date ? job.addedAt.toISOString() : job.addedAt,
        startedAt: job.startedAt instanceof Date ? job.startedAt.toISOString() : job.startedAt,
        completedAt: job.completedAt instanceof Date ? job.completedAt.toISOString() : job.completedAt
      }));

      const state = {
        jobs,
        isRunning: this._isRunning(),
        currentJobId: this._currentJobId(),
        savedAt: new Date().toISOString()
      };

      await electron.queue.saveState(JSON.stringify(state, null, 2));
      console.log(`[QUEUE] Saved ${jobs.length} jobs to disk`);
    } catch (err) {
      console.error('[QUEUE] Error saving queue state:', err);
    }
  }

  /**
   * Save job analytics directly to the BFP project file.
   * Called once per job completion to avoid duplicate saves from component effects.
   * Uses the appendAnalytics IPC handler which atomically handles read-dedupe-write.
   */
  private async saveAnalyticsToBfp(
    bfpPath: string,
    jobType: string,
    analytics: { jobId: string; [key: string]: unknown }
  ): Promise<void> {
    const electron = window.electron as any;
    if (!electron?.audiobook?.appendAnalytics) {
      console.warn('[QUEUE] Cannot save analytics - electron.audiobook.appendAnalytics not available');
      return;
    }

    // Validate job type
    if (jobType !== 'tts-conversion' && jobType !== 'ocr-cleanup') {
      console.log('[QUEUE] Unknown job type for analytics:', jobType);
      return;
    }

    try {
      // Use the atomic appendAnalytics handler which handles deduplication
      const result = await electron.audiobook.appendAnalytics(bfpPath, jobType, analytics);
      if (result.success) {
        console.log(`[QUEUE] Saved ${jobType} analytics to BFP:`, analytics.jobId);
      } else {
        console.error('[QUEUE] Failed to save analytics to BFP:', result.error);
      }
    } catch (err) {
      console.error('[QUEUE] Error saving analytics to BFP:', err);
    }
  }

  /**
   * Load queue state from disk on startup
   */
  private async loadQueueState(): Promise<void> {
    const electron = window.electron;
    if (!electron?.queue?.loadState) return;

    try {
      const result = await electron.queue.loadState();
      if (!result.success || !result.data) {
        console.log('[QUEUE] No saved queue state found');
        return;
      }

      const state = result.data;
      console.log(`[QUEUE] Loading ${state.jobs?.length || 0} jobs from disk`);

      if (state.jobs && Array.isArray(state.jobs)) {
        // Deserialize jobs, converting ISO strings back to Date objects
        const jobs: QueueJob[] = state.jobs.map((job: any) => ({
          ...job,
          addedAt: new Date(job.addedAt),
          startedAt: job.startedAt ? new Date(job.startedAt) : undefined,
          completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
          // Reset processing jobs to pending (they were interrupted)
          status: job.status === 'processing' ? 'pending' : job.status
        }));

        this._jobs.set(jobs);

        // Don't restore isRunning - user should manually restart
        // this._isRunning.set(state.isRunning || false);

        // Check for active backend jobs and sync
        await this.refreshFromBackend();
      }
    } catch (err) {
      console.error('[QUEUE] Error loading queue state:', err);
    }
  }
}

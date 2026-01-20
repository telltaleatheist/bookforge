/**
 * Queue Service - Manages the unified processing queue
 *
 * Signal-based state management for job queue operations.
 * Jobs are processed sequentially and automatically.
 */

import { Injectable, inject, signal, computed, DestroyRef, NgZone } from '@angular/core';
import {
  QueueJob,
  JobType,
  JobStatus,
  QueueState,
  QueueProgress,
  JobResult,
  CreateJobRequest,
  OcrCleanupConfig,
  TtsConversionConfig
} from '../models/queue.types';
import { AIProvider } from '../../../core/models/ai-config.types';

// AI Provider config for IPC
interface AIProviderConfig {
  provider: AIProvider;
  ollama?: { baseUrl: string; model: string };
  claude?: { apiKey: string; model: string };
  openai?: { apiKey: string; model: string };
}

// Access window.electron directly
declare global {
  interface Window {
    electron?: {
      queue?: {
        runOcrCleanup: (jobId: string, epubPath: string, model?: string, aiConfig?: AIProviderConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
        runTtsConversion: (jobId: string, epubPath: string, config: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
        saveState: (queueState: string) => Promise<{ success: boolean; error?: string }>;
        loadState: () => Promise<{ success: boolean; data?: any; error?: string }>;
        onProgress: (callback: (progress: QueueProgress) => void) => () => void;
        onComplete: (callback: (result: JobResult) => void) => () => void;
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
    };
  }
}

// Serializable queue state for persistence
interface PersistedQueueState {
  jobs: QueueJob[];
  version: number;
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

  // State signals
  private readonly _jobs = signal<QueueJob[]>([]);
  private readonly _isRunning = signal<boolean>(false); // Don't auto-run - user starts manually
  private readonly _currentJobId = signal<string | null>(null);

  // Public readonly computed signals
  readonly jobs = computed(() => this._jobs());
  readonly isRunning = computed(() => this._isRunning());
  readonly currentJobId = computed(() => this._currentJobId());

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

  // Debounce timer for saving
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor() {
    this.setupIpcListeners();
    this.loadPersistedState();

    this.destroyRef.onDestroy(() => {
      if (this.unsubscribeProgress) {
        this.unsubscribeProgress();
      }
      if (this.unsubscribeComplete) {
        this.unsubscribeComplete();
      }
      // Save state before destroy
      this.saveStateNow();
    });
  }

  /**
   * Load persisted queue state from disk
   * Auto-resumes processing if there were pending jobs
   */
  private async loadPersistedState(): Promise<void> {
    const electron = window.electron;
    if (!electron?.queue?.loadState) return;

    try {
      const result = await electron.queue.loadState();
      if (result.success && result.data) {
        const state = result.data as PersistedQueueState;
        console.log('[QUEUE] Loading persisted state with', state.jobs?.length || 0, 'jobs');
        if (state.jobs && Array.isArray(state.jobs)) {
          state.jobs.forEach((job, i) => {
            console.log(`[QUEUE] Loaded job ${i}:`, job.id, job.type, (job.config as any)?.aiModel || 'no model');
          });
          // Reset any "processing" jobs to "pending" (they were interrupted)
          const recoveredJobs = state.jobs.map(job => {
            if (job.status === 'processing') {
              return {
                ...job,
                status: 'pending' as JobStatus,
                progress: undefined,
                startedAt: undefined
              };
            }
            return job;
          });
          this._jobs.set(recoveredJobs);

          // Don't auto-resume - user must manually start the queue
        }
      }
    } catch (err) {
      console.error('Failed to load queue state:', err);
    }
  }

  /**
   * Save queue state to disk (debounced)
   */
  private saveState(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveStateNow();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Save queue state immediately
   */
  private async saveStateNow(): Promise<void> {
    const electron = window.electron;
    if (!electron?.queue?.saveState) return;

    try {
      const state: PersistedQueueState = {
        jobs: this._jobs(),
        version: 1
      };
      await electron.queue.saveState(JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save queue state:', err);
    }
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
          outputPath: progress.outputPath || job.outputPath
        };
      })
    );
    // Don't save on every progress update - too frequent
  }

  private handleJobComplete(result: JobResult): void {
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
          outputPath: result.outputPath || job.outputPath
        };
      })
    );

    // Clear current job
    this._currentJobId.set(null);

    // Save state after job completes
    this.saveState();

    // Process next job if queue is running
    if (this._isRunning()) {
      this.processNext();
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
      config: this.buildJobConfig(request)
    };

    console.log('[QUEUE] Job added:', {
      jobId: job.id,
      type: job.type,
      config: job.config
    });

    this._jobs.update(jobs => [...jobs, job]);

    // Save state after adding job
    this.saveState();

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
    this.saveState();
    return true;
  }

  /**
   * Clear completed/error jobs from the queue
   */
  clearCompleted(): void {
    this._jobs.update(jobs =>
      jobs.filter(j => j.status === 'pending' || j.status === 'processing')
    );
    this.saveState();
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

    this.saveState();

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
    this.saveState();
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

      this.saveState();

      // Process next if running
      if (this._isRunning()) {
        await this.processNext();
      }
    }

    return result.success;
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
    this.saveState();
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
    this.saveState();
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

    // Update job status to processing
    this._currentJobId.set(job.id);
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
        console.log('[QUEUE] Calling runOcrCleanup with:', {
          jobId: job.id,
          model: config.aiModel,
          aiConfig: {
            provider: aiConfig.provider,
            ollamaModel: aiConfig.ollama?.model,
            claudeModel: aiConfig.claude?.model,
            openaiModel: aiConfig.openai?.model
          }
        });
        await electron.queue.runOcrCleanup(job.id, job.epubPath, config.aiModel, aiConfig);
      } else if (job.type === 'tts-conversion') {
        const config = job.config as TtsConversionConfig | undefined;
        if (!config) {
          throw new Error('TTS configuration required');
        }
        await electron.queue.runTtsConversion(job.id, job.epubPath, config);
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
      this._currentJobId.set(null);

      this.saveState();

      // Try next job
      if (this._isRunning()) {
        await this.processNext();
      }
    }
  }

  private buildJobConfig(request: CreateJobRequest): OcrCleanupConfig | TtsConversionConfig | undefined {
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
        outputDir: config.outputDir
      };
    }
    return undefined;
  }

  private generateId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

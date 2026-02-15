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
  BilingualCleanupJobConfig,
  BilingualTranslationJobConfig,
  BilingualAssemblyJobConfig,
  VideoAssemblyJobConfig,
  AudiobookJobConfig,
  ResumeCheckResult,
  TtsResumeInfo
} from '../models/queue.types';
import { AIProvider } from '../../../core/models/ai-config.types';
import { StudioService } from '../../studio/services/studio.service';
import { SettingsService } from '../../../core/services/settings.service';

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
          testModeChunks?: number;
          simplifyForLearning?: boolean;
          cleanupPrompt?: string;
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
        onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string }; sessionId?: string; sessionDir?: string }) => void) => () => void;
        // Session tracking for stop/resume
        onSessionCreated: (callback: (data: { jobId: string; sessionId: string; sessionDir: string; processDir: string; totalSentences: number; totalChapters: number }) => void) => () => void;
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
          totalChapters?: number;
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
      languageLearning?: {
        runJob: (jobId: string, config: {
          projectId: string;
          sourceUrl: string;
          sourceLang: string;
          targetLang?: string;      // Legacy single language
          targetLangs?: string[];   // Multi-language support
          htmlPath: string;
          pdfPath?: string;
          deletedBlockIds: string[];
          title?: string;
          aiProvider: AIProvider;
          aiModel: string;
          ollamaBaseUrl?: string;
          claudeApiKey?: string;
          openaiApiKey?: string;
          // AI prompt settings
          translationPrompt?: string;
          enableCleanup?: boolean;
          cleanupPrompt?: string;
          // TTS settings
          sourceVoice: string;
          targetVoice: string;
          ttsEngine: 'xtts' | 'orpheus';
          sourceTtsSpeed: number;
          targetTtsSpeed: number;
          device: 'gpu' | 'mps' | 'cpu';
          workerCount?: number;
        }) => Promise<{ success: boolean; data?: any; error?: string }>;
        onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
      };
      // Language Learning Split Pipeline
      bilingualCleanup?: {
        run: (jobId: string, config: {
          projectId: string;
          projectDir: string;
          sourceEpubPath?: string;
          sourceLang: string;
          aiProvider: AIProvider;
          aiModel: string;
          ollamaBaseUrl?: string;
          claudeApiKey?: string;
          openaiApiKey?: string;
          cleanupPrompt?: string;
          simplifyForLearning?: boolean;
          startFresh?: boolean;
          testMode?: boolean;
          testModeChunks?: number;
        }) => Promise<{
          success: boolean;
          outputPath?: string;
          error?: string;
          nextJobConfig?: { cleanedEpubPath?: string };
        }>;
        onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
      };
      bilingualTranslation?: {
        run: (jobId: string, config: {
          projectId?: string;
          projectDir?: string;
          cleanedEpubPath?: string;
          sourceLang: string;
          targetLang: string;
          title?: string;
          aiProvider: AIProvider;
          aiModel: string;
          ollamaBaseUrl?: string;
          claudeApiKey?: string;
          openaiApiKey?: string;
          translationPrompt?: string;
          monoTranslation?: boolean;  // Full book translation (not bilingual interleave)
          testMode?: boolean;
          testModeChunks?: number;
        }) => Promise<{
          success: boolean;
          outputPath?: string;
          error?: string;
          nextJobConfig?: {
            epubPath?: string;
            sentencePairsPath?: string;
            sourceEpubPath?: string;
            targetEpubPath?: string;
          };
        }>;
        onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
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
  private readonly studioService = inject(StudioService);
  private readonly settingsService = inject(SettingsService);

  // Progress listener cleanup
  private unsubscribeProgress: (() => void) | null = null;
  private unsubscribeComplete: (() => void) | null = null;
  private unsubscribeParallelProgress: (() => void) | null = null;
  private unsubscribeParallelComplete: (() => void) | null = null;
  private unsubscribeParallelSessionCreated: (() => void) | null = null;
  private unsubscribeReassemblyProgress: (() => void) | null = null;
  private unsubscribeLanguageLearningProgress: (() => void) | null = null;
  private unsubscribeLLJobProgress: (() => void) | null = null;

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
      if (this.unsubscribeParallelSessionCreated) {
        this.unsubscribeParallelSessionCreated();
      }
      if (this.unsubscribeReassemblyProgress) {
        this.unsubscribeReassemblyProgress();
      }
      if (this.unsubscribeLanguageLearningProgress) {
        this.unsubscribeLanguageLearningProgress();
      }
      if (this.unsubscribeLLJobProgress) {
        this.unsubscribeLLJobProgress();
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
      this.ngZone.run(async () => {
        await this.handleJobComplete(result);
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
        this.ngZone.run(async () => {
          await this.handleJobComplete({
            jobId: data.jobId,
            success: data.success,
            outputPath: data.outputPath,
            error: data.error,
            analytics: data.analytics,
            wasStopped: data.wasStopped,
            stopInfo: data.stopInfo,
            sessionId: data.sessionId,
            sessionDir: data.sessionDir
          });
        });
      });

      // Listen for session-created events to save sessionId to BFP for pause/resume
      if (electron.parallelTts.onSessionCreated) {
        this.unsubscribeParallelSessionCreated = electron.parallelTts.onSessionCreated((data) => {
          this.ngZone.run(() => {
            this.handleSessionCreated(data);
          });
        });
      }
    }

    // Listen for reassembly progress updates
    if (electron.reassembly) {
      this.unsubscribeReassemblyProgress = electron.reassembly.onProgress((data) => {
        this.ngZone.run(() => {
          this.handleReassemblyProgressUpdate(data.jobId, data.progress);
        });
      });
    }

    // Listen for language learning progress updates
    if (electron.languageLearning) {
      this.unsubscribeLanguageLearningProgress = electron.languageLearning.onProgress((data) => {
        this.ngZone.run(() => {
          this.handleLanguageLearningProgressUpdate(data.jobId, data.progress);
        });
      });
    }

    // Listen for LL split pipeline job progress (cleanup + translation)
    if (electron.bilingualCleanup) {
      this.unsubscribeLLJobProgress = electron.bilingualCleanup.onProgress((data) => {
        this.ngZone.run(() => {
          this.handleLLJobProgressUpdate(data.jobId, data.progress);
        });
      });
    }
  }

  private handleLLJobProgressUpdate(jobId: string, progress: any): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;
        const currentChunk = progress.currentChunk || progress.currentSentence || 0;
        const totalChunks = progress.totalChunks || progress.totalSentences || 0;
        const prevCompleted = job.chunksCompletedInJob || 0;
        return {
          ...job,
          progress: progress.percentage || 0,
          status: progress.phase === 'complete' ? 'complete' as JobStatus :
                  progress.phase === 'error' ? 'error' as JobStatus :
                  'processing' as JobStatus,
          currentChunk,
          totalChunks,
          // Map to ETA calculation fields
          chunksCompletedInJob: currentChunk,
          totalChunksInJob: totalChunks,
          chunkCompletedAt: currentChunk > prevCompleted ? Date.now() : job.chunkCompletedAt,
          progressMessage: progress.message || progress.phase,
          error: progress.error
        };
      })
    );
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

  private handleLanguageLearningProgressUpdate(jobId: string, progress: any): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;
        return {
          ...job,
          progress: progress.percentage || 0,
          status: progress.phase === 'complete' ? 'complete' as JobStatus :
                  progress.phase === 'error' ? 'error' as JobStatus :
                  'processing' as JobStatus,
          currentChunk: progress.currentSentence,
          totalChunks: progress.totalSentences,
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

        // Calculate TTS conversion progress (before assembly)
        const ttsConversionProgress = displayTotal > 0
          ? Math.min(100, Math.round((displayCompleted / displayTotal) * 100))
          : 0;

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
          // Map assembly chapter progress (from parallel-tts-bridge during assembly phase)
          currentChapter: (progress as any).assemblyChapter || job.currentChapter,
          totalChapters: (progress as any).assemblyTotalChapters || job.totalChapters,
          // Store per-worker progress for UI display
          parallelWorkers: progress.workers.map(w => ({
            id: w.id,
            sentenceStart: w.sentenceStart,
            sentenceEnd: w.sentenceEnd,
            completedSentences: w.completedSentences,
            status: w.status,
            error: w.error,
            totalAssigned: (w as any).totalAssigned,
            actualConversions: (w as any).actualConversions
          })),
          // Phase tracking for TTS + Assembly progress display
          ttsPhase: progress.phase as 'preparing' | 'converting' | 'assembling' | 'complete',
          ttsConversionProgress: progress.phase === 'converting' ? ttsConversionProgress :
                                  progress.phase === 'assembling' || progress.phase === 'complete' ? 100 :
                                  job.ttsConversionProgress || 0,
          assemblyProgress: (progress as any).assemblyProgress,
          assemblySubPhase: (progress as any).assemblySubPhase
        };
      })
    );
    // Don't save on every progress update - too frequent
  }

  /**
   * Handle session-created event from parallel TTS.
   * Saves the sessionId to the BFP so we can resume if the job is stopped.
   */
  private async handleSessionCreated(data: {
    jobId: string;
    sessionId: string;
    sessionDir: string;
    processDir: string;
    totalSentences: number;
    totalChapters: number;
  }): Promise<void> {
    console.log(`[QUEUE] Session created for job ${data.jobId}: sessionId=${data.sessionId}`);

    // Find the job to get the bfpPath
    const job = this._jobs().find(j => j.id === data.jobId);
    if (!job?.bfpPath) {
      console.warn('[QUEUE] Cannot save session info - no bfpPath for job', data.jobId);
      return;
    }

    // Save session info to BFP for pause/resume capability
    const electron = window.electron as any;
    if (!electron?.audiobook?.updateState) {
      console.warn('[QUEUE] Cannot save session info - electron.audiobook.updateState not available');
      return;
    }

    try {
      const result = await electron.audiobook.updateState(job.bfpPath, {
        ttsSessionId: data.sessionId,
        ttsSessionDir: data.sessionDir,
        ttsProcessDir: data.processDir,
        ttsSentenceProgress: {
          completed: 0,
          total: data.totalSentences
        },
        ttsStatus: 'processing'
      });

      if (result.success) {
        console.log('[QUEUE] Saved session info to BFP:', job.bfpPath);
      } else {
        console.error('[QUEUE] Failed to save session info:', result.error);
      }
    } catch (err) {
      console.error('[QUEUE] Error saving session info to BFP:', err);
    }
  }

  /**
   * Update BFP state when a job is stopped by user.
   * Sets ttsStatus to 'stopped' and saves progress for resume.
   */
  /**
   * Check if a BFP has a resumable TTS session.
   * Returns ResumeCheckResult if found and valid, null otherwise.
   */
  private async checkBfpForResumableSession(
    bfpPath: string,
    epubPath: string
  ): Promise<ResumeCheckResult | null> {
    const electron = window.electron as any;
    if (!electron?.parallelTts?.checkResumeFast) {
      return null;
    }

    try {
      // First check for a resumable session using the epub path
      // This will find the session directory and scan for completed sentences
      const result = await electron.parallelTts.checkResumeFast(epubPath);

      if (result.success && result.data?.success) {
        const resumeData = result.data;

        // Only auto-resume if there's actual progress (not starting fresh)
        if (resumeData.completedSentences && resumeData.completedSentences > 0) {
          console.log(`[QUEUE] Found resumable session: ${resumeData.completedSentences}/${resumeData.totalSentences} sentences complete`);
          return resumeData;
        }
      }

      return null;
    } catch (err) {
      console.error('[QUEUE] Error checking for resumable session:', err);
      return null;
    }
  }

  private async updateBfpStoppedState(
    bfpPath: string,
    stopInfo?: {
      sessionId?: string;
      sessionDir?: string;
      processDir?: string;
      completedSentences?: number;
      totalSentences?: number;
      stoppedAt?: string;
    }
  ): Promise<void> {
    const electron = window.electron as any;
    if (!electron?.audiobook?.updateState) {
      console.warn('[QUEUE] Cannot update stopped state - electron.audiobook.updateState not available');
      return;
    }

    try {
      const result = await electron.audiobook.updateState(bfpPath, {
        ttsStatus: 'stopped',
        ttsStoppedAt: stopInfo?.stoppedAt || new Date().toISOString(),
        ttsSentenceProgress: stopInfo ? {
          completed: stopInfo.completedSentences || 0,
          total: stopInfo.totalSentences || 0
        } : undefined
      });

      if (result.success) {
        console.log('[QUEUE] Updated BFP with stopped state:', bfpPath);
      } else {
        console.error('[QUEUE] Failed to update BFP stopped state:', result.error);
      }
    } catch (err) {
      console.error('[QUEUE] Error updating BFP stopped state:', err);
    }
  }

  private async handleJobComplete(result: JobResult): Promise<void> {
    console.log(`[QUEUE] handleJobComplete called for job ${result.jobId}, success=${result.success}, wasStopped=${result.wasStopped}`);
    console.log(`[QUEUE] Current state: isRunning=${this._isRunning()}, currentJobId=${this._currentJobId()}`);

    // Get the job before updating to capture the type
    const completedJob = this._jobs().find(j => j.id === result.jobId);
    console.log('[QUEUE] Found completed job:', completedJob ? `type=${completedJob.type}, id=${completedJob.id}, status=${completedJob.status}` : 'NOT FOUND');

    // Guard against double-processing — inline + event-based handlers can both call this.
    // The first handler does the full work (session caching, chaining, processNext).
    // The second handler must NOT call processNext() — doing so would start the next job
    // while the first handler is still awaiting async work (e.g., WSL session caching),
    // causing race conditions where chained jobs can't find the session yet.
    if (completedJob && (completedJob.status === 'complete' || completedJob.status === 'error')) {
      console.log(`[QUEUE] handleJobComplete: job ${result.jobId} already ${completedJob.status}, skipping (first handler will call processNext)`);
      return;
    }

    // Determine the final status:
    // - success=true -> 'complete'
    // - wasStopped=true -> 'pending' (can be resumed, stays in queue)
    // - otherwise -> 'error'
    let finalStatus: JobStatus = result.success ? 'complete' : 'error';
    if (result.wasStopped) {
      // Job was stopped by user - keep it in pending state so it can be resumed
      finalStatus = 'pending';
      console.log(`[QUEUE] Job ${result.jobId} was stopped - setting status to 'pending' for resume`);
    }

    // Update the job status
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== result.jobId) return job;
        return {
          ...job,
          status: finalStatus,
          error: result.wasStopped ? undefined : result.error, // Clear error for stopped jobs
          progress: result.success ? 100 : job.progress,
          completedAt: result.success ? new Date() : job.completedAt,
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

    // Update BFP state for stopped jobs
    if (result.wasStopped && completedJob?.bfpPath) {
      this.updateBfpStoppedState(completedJob.bfpPath, result.stopInfo);
    }

    // If any job in a workflow fails, cancel all remaining pending jobs in the same workflow.
    // This prevents downstream jobs (TTS, reassembly, video) from running when an earlier
    // step (cleanup, translation, etc.) has failed.
    if (!result.success && !result.wasStopped && completedJob?.workflowId) {
      const failedType = completedJob.type;
      const workflowId = completedJob.workflowId;
      const pendingInWorkflow = this._jobs().filter(j =>
        j.workflowId === workflowId &&
        j.status === 'pending' &&
        j.id !== completedJob.id
      );
      if (pendingInWorkflow.length > 0) {
        const failIds = new Set(pendingInWorkflow.map(j => j.id));
        console.log(`[QUEUE] ${failedType} job failed in workflow ${workflowId} - cancelling ${failIds.size} pending job(s)`);
        this._jobs.update(jobs =>
          jobs.map(job => {
            if (!failIds.has(job.id)) return job;
            console.log(`[QUEUE] Cancelling ${job.type} job ${job.id} due to ${failedType} failure`);
            return {
              ...job,
              status: 'error' as JobStatus,
              error: `Skipped: ${failedType} failed. Fix the issue and re-run the workflow.`,
              metadata: {
                ...job.metadata,
                bilingualPlaceholder: undefined, // Clear placeholder flag if present
              },
            };
          })
        );
      }
    }

    // Save analytics directly to BFP (no longer using signal/effect pattern to avoid duplicates)
    if (result.analytics && completedJob?.bfpPath) {
      this.saveAnalyticsToBfp(
        completedJob.bfpPath,
        completedJob.type,
        result.analytics
      );
    }

    // Copy VTT file to BFP audiobook folder for TTS and reassembly jobs (for chapter recovery)
    if (result.success && result.outputPath && completedJob?.bfpPath &&
        (completedJob.type === 'tts-conversion' || completedJob.type === 'reassembly')) {
      this.copyVttToBfp(completedJob.bfpPath, result.outputPath);
    }

    // Link the completed audio file to the BFP so it shows up in Studio and Audiobook tabs
    // without relying on filename matching (which can fail if e2a names the file differently)
    if (result.success && result.outputPath && completedJob?.bfpPath &&
        (completedJob.type === 'tts-conversion' || completedJob.type === 'reassembly') &&
        result.outputPath.endsWith('.m4b')) {
      try {
        const electron = (window as any).electron;
        if (electron?.audiobook?.linkAudio) {
          console.log(`[QUEUE] Auto-linking audio to BFP: ${result.outputPath}`);
          await electron.audiobook.linkAudio(completedJob.bfpPath, result.outputPath);
        }
      } catch (err) {
        console.error('[QUEUE] Failed to auto-link audio to BFP:', err);
      }
    }

    // Cache TTS session to BFP for future reassembly
    if (result.success && result.sessionDir && completedJob?.bfpPath &&
        completedJob.type === 'tts-conversion') {
      try {
        const electron = (window as any).electron;
        if (electron?.sessionCache?.saveToBfp) {
          console.log(`[QUEUE] Caching TTS session to BFP: ${result.sessionDir}`);
          const cacheResult = await electron.sessionCache.saveToBfp(result.sessionDir, completedJob.bfpPath);
          if (cacheResult.success) {
            console.log(`[QUEUE] Session cached to: ${cacheResult.cachedPath}`);
          } else {
            console.error('[QUEUE] Failed to cache session to BFP:', cacheResult.error);
          }
        }
      } catch (err) {
        console.error('[QUEUE] Error caching session to BFP:', err);
      }
    }

    // Cache LL TTS session to project directory (per-language)
    // This persists the session so assembly can run later even if temp dirs are cleaned
    if (result.success && result.sessionDir && completedJob?.projectDir &&
        completedJob.type === 'tts-conversion' && !completedJob.bfpPath) {
      const ttsConfig = completedJob.config as TtsConversionConfig;
      if (ttsConfig?.language) {
        try {
          const electron = (window as any).electron;
          if (electron?.sessionCache?.saveToProject) {
            console.log(`[QUEUE] Caching LL TTS session for ${ttsConfig.language} to project: ${completedJob.projectDir}`);
            const cacheResult = await electron.sessionCache.saveToProject(
              result.sessionDir, completedJob.projectDir, ttsConfig.language
            );
            if (cacheResult.success && cacheResult.cachedSentencesDir) {
              console.log(`[QUEUE] LL session cached, sentences at: ${cacheResult.cachedSentencesDir}`);
              // Update outputPath to cached location so chaining handler uses persistent paths
              result.outputPath = cacheResult.cachedSentencesDir;
            } else {
              console.error('[QUEUE] Failed to cache LL session:', cacheResult.error);
            }
          }
        } catch (err) {
          console.error('[QUEUE] Error caching LL session to project:', err);
        }
      }
    }

    // Cache audio files for cached-language TTS jobs (bilingual tab)
    if (result.success && result.outputPath && completedJob?.type === 'tts-conversion') {
      const ttsConfig = completedJob.config as TtsConversionConfig;
      if (ttsConfig?.cacheAudioTo && ttsConfig?.cacheLanguage) {
        console.log(`[QUEUE] Caching audio for ${ttsConfig.cacheLanguage} to ${ttsConfig.cacheAudioTo}`);
        this.cacheAudioAfterTts(
          result.outputPath,  // sentencesDir from TTS
          ttsConfig.cacheAudioTo,
          ttsConfig.cacheLanguage,
          {
            engine: ttsConfig.ttsEngine as 'xtts' | 'orpheus',
            voice: ttsConfig.fineTuned,
            speed: ttsConfig.speed,
          }
        );
      }
    }

    // Handle bilingual dual-voice workflow chaining
    const bilingualWorkflow = (completedJob?.metadata as any)?.bilingualWorkflow;
    if (result.success && bilingualWorkflow && completedJob?.type === 'tts-conversion') {
      if (bilingualWorkflow.role === 'source') {
        // Source TTS complete - update existing target TTS job with chaining metadata
        console.log('[QUEUE] Bilingual source TTS complete, updating target TTS job');
        const sourceSentencesDir = result.outputPath; // With skipAssembly, outputPath is sentences dir
        const targetConfig = bilingualWorkflow.targetConfig;
        const assemblyConfig = bilingualWorkflow.assemblyConfig;

        // Fallback: use assemblyConfig.audiobooksDir if targetConfig.outputDir is missing
        const targetOutputDir = targetConfig?.outputDir || assemblyConfig?.audiobooksDir;

        // Look for existing placeholder target TTS job in the same workflow
        const existingTargetJob = this._jobs().find(j =>
          j.workflowId === completedJob.workflowId &&
          j.type === 'tts-conversion' &&
          j.status === 'pending' &&
          j.id !== completedJob.id &&
          j.epubPath === bilingualWorkflow.targetEpubPath
        );

        if (existingTargetJob) {
          // Update existing target TTS job with chaining metadata
          console.log('[QUEUE] Found existing target TTS job, updating with chaining metadata:', existingTargetJob.id);
          this._jobs.update(jobs =>
            jobs.map(j => {
              if (j.id === existingTargetJob.id) {
                return {
                  ...j,
                  metadata: {
                    ...j.metadata,
                    bilingualPlaceholder: undefined, // Clear placeholder so processNext() picks it up
                    bilingualWorkflow: {
                      role: 'target',
                      sourceSentencesDir, // Pass source sentences dir for assembly
                      assemblyConfig
                    }
                  },
                  config: {
                    ...j.config as TtsConversionConfig,
                    outputDir: targetOutputDir,
                    outputFilename: targetConfig.outputFilename,
                    speed: targetConfig.speed
                  }
                };
              }
              return j;
            })
          );
        } else {
          // Fallback: create new target TTS job (legacy behavior)
          console.log('[QUEUE] No existing target TTS job found, creating new one');
          const targetLangName = this.getLanguageName(targetConfig?.language);

          this.addJob({
            type: 'tts-conversion',
            epubPath: bilingualWorkflow.targetEpubPath,
            workflowId: completedJob.workflowId,
            parentJobId: completedJob.parentJobId,
            metadata: {
              title: `${targetLangName} TTS`,
              author: 'Language Learning',
              outputFilename: targetConfig.outputFilename,
              bilingualWorkflow: {
                role: 'target',
                sourceSentencesDir,
                assemblyConfig
              }
            },
            config: {
              type: 'tts-conversion',
              useParallel: true,
              parallelMode: 'sentences',
              parallelWorkers: targetConfig.workerCount,
              device: targetConfig.device,
              language: targetConfig.language,
              ttsEngine: targetConfig.ttsEngine,
              fineTuned: targetConfig.voice,
              speed: targetConfig.speed,
              outputDir: targetOutputDir,
              outputFilename: targetConfig.outputFilename,
              skipAssembly: true,
              sentencePerParagraph: true,
              skipHeadings: true,
              temperature: 0.75,
              topP: 0.85,
              topK: 50,
              repetitionPenalty: 5.0,
              enableTextSplitting: true
            }
          });
        }
      } else if (bilingualWorkflow.role === 'target' || bilingualWorkflow.role === 'solo') {
        // TTS complete - chain bilingual assembly
        // 'target': last TTS in source→target chain, sourceSentencesDir from earlier TTS
        // 'solo': single TTS with cached partner, dirs pre-assigned by wizard
        const isSolo = bilingualWorkflow.role === 'solo';
        console.log(`[QUEUE] Bilingual ${isSolo ? 'solo' : 'target'} TTS complete, chaining assembly`);

        const freshDir = result.outputPath || '';
        let sourceSentencesDir: string;
        let targetSentencesDir: string;

        if (isSolo) {
          // Solo: one dir is pre-filled (cached), the other gets the fresh TTS output
          sourceSentencesDir = bilingualWorkflow.assemblySourceSentencesDir || freshDir;
          targetSentencesDir = bilingualWorkflow.assemblyTargetSentencesDir || freshDir;
        } else {
          // Target role: source was set by source TTS completion
          sourceSentencesDir = bilingualWorkflow.sourceSentencesDir || '';
          targetSentencesDir = freshDir;
        }

        const assemblyConfig = bilingualWorkflow.assemblyConfig;

        // Validate both sentence dirs exist
        const electron = window.electron;
        for (const [label, dir] of [['Source', sourceSentencesDir], ['Target', targetSentencesDir]] as const) {
          let exists = false;
          try {
            exists = await electron?.fs?.exists?.(dir) ?? false;
          } catch {
            exists = false;
          }
          if (!exists) {
            console.error(`[QUEUE] ${label} sentences directory does not exist, cannot create bilingual assembly:`, dir);
            this._jobs.update(jobs =>
              jobs.map(j => {
                if (j.id !== completedJob.id) return j;
                return {
                  ...j,
                  status: 'error' as JobStatus,
                  error: `${label} TTS sentences not found at: ${dir}`
                };
              })
            );
            return;
          }
        }

        // Look for existing placeholder assembly job
        const existingAssemblyJob = this._jobs().find(j =>
          j.workflowId === completedJob.workflowId &&
          j.type === 'bilingual-assembly' &&
          j.status === 'pending' &&
          (j.metadata as any)?.bilingualPlaceholder?.role === 'assembly'
        );

        if (existingAssemblyJob) {
          // Update the placeholder with actual config
          console.log('[QUEUE] Found placeholder assembly job, updating with config:', existingAssemblyJob.id);
          this._jobs.update(jobs =>
            jobs.map(j => {
              if (j.id !== existingAssemblyJob.id) return j;
              return {
                ...j,
                metadata: {
                  ...j.metadata,
                  bilingualPlaceholder: undefined, // Clear placeholder marker
                  title: 'Assembly'
                },
                config: {
                  type: 'bilingual-assembly',
                  projectId: assemblyConfig.projectId,
                  sourceSentencesDir,
                  targetSentencesDir,
                  sentencePairsPath: assemblyConfig.sentencePairsPath,
                  outputDir: assemblyConfig.audiobooksDir,
                  pauseDuration: assemblyConfig.pauseDuration,
                  gapDuration: assemblyConfig.gapDuration,
                  // Output naming with language suffix
                  title: assemblyConfig.title,
                  sourceLang: assemblyConfig.sourceLang,
                  targetLang: assemblyConfig.targetLang,
                  bfpPath: assemblyConfig.bfpPath,
                  pattern: assemblyConfig.pattern
                }
              };
            })
          );
        } else {
          // Fallback: create new assembly job
          console.log('[QUEUE] No placeholder assembly job found, creating new one');
          this.addJob({
            type: 'bilingual-assembly',
            workflowId: completedJob.workflowId,
            parentJobId: completedJob.parentJobId,  // Link to master language-learning job
            metadata: {
              title: 'Assembly'
            },
            config: {
              type: 'bilingual-assembly',
              projectId: assemblyConfig.projectId,
              sourceSentencesDir,
              targetSentencesDir,
              sentencePairsPath: assemblyConfig.sentencePairsPath,
              outputDir: assemblyConfig.audiobooksDir,
              pauseDuration: assemblyConfig.pauseDuration,
              gapDuration: assemblyConfig.gapDuration,
              // Output naming with language suffix
              title: assemblyConfig.title,
              sourceLang: assemblyConfig.sourceLang,
              targetLang: assemblyConfig.targetLang,
              bfpPath: assemblyConfig.bfpPath,
              pattern: assemblyConfig.pattern
            }
          });
        }
      }
    }

    // Update master job progress when a child job completes
    if (completedJob?.parentJobId && completedJob.workflowId) {
      this.updateMasterJobProgress(completedJob.workflowId, completedJob.parentJobId);
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
    // Determine filename based on job type
    let filename = request.epubPath?.replace(/\\/g, '/').split('/').pop();
    if (!filename) {
      if (request.type === 'bilingual-assembly') {
        filename = 'Bilingual Assembly';
      } else if (request.type === 'audiobook') {
        filename = request.metadata?.title || 'Audiobook';
      } else {
        filename = 'unknown.epub';
      }
    }

    const job: QueueJob = {
      id: this.generateId(),
      type: request.type,
      epubPath: request.epubPath,
      epubFilename: filename,
      status: 'pending',
      addedAt: new Date(),
      metadata: request.metadata,
      projectDir: request.projectDir,  // For LL jobs
      parentJobId: request.parentJobId,  // For workflow grouping
      workflowId: request.workflowId,    // For workflow grouping
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
   * If the job is a master job (has workflowId but no parentJobId), also removes child jobs
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

    // Check if this is a master job (has workflowId but no parentJobId)
    const isMasterJob = job.workflowId && !job.parentJobId;

    if (isMasterJob) {
      // Remove this job and all child jobs in the same workflow
      this._jobs.update(jobs => jobs.filter(j =>
        j.id !== jobId && j.workflowId !== job.workflowId
      ));
    } else {
      // Just remove this single job
      this._jobs.update(jobs => jobs.filter(j => j.id !== jobId));
    }

    return true;
  }

  /**
   * Update a job's config (for modifying settings before job runs)
   */
  updateJobConfig(jobId: string, configUpdate: Partial<Record<string, any>>): void {
    this._jobs.update(jobs => jobs.map(job => {
      if (job.id !== jobId) return job;
      return {
        ...job,
        config: job.config ? { ...job.config, ...configUpdate } as typeof job.config : undefined
      };
    }));
  }

  /**
   * Clean up orphaned sub-items (sub-items whose master job doesn't exist)
   * This can happen if the app crashes or if there's a bug in job removal
   */
  private cleanupOrphanedSubItems(): void {
    const jobs = this._jobs();
    const jobIds = new Set(jobs.map(j => j.id));

    // Find sub-items whose parentJobId doesn't exist in the queue
    const orphanedIds = jobs
      .filter(j => j.parentJobId && !jobIds.has(j.parentJobId))
      .map(j => j.id);

    if (orphanedIds.length > 0) {
      console.log(`[QUEUE] Removing ${orphanedIds.length} orphaned sub-items:`, orphanedIds);
      this._jobs.update(jobs => jobs.filter(j => !orphanedIds.includes(j.id)));
    }
  }

  /**
   * Update master job progress based on child job completion
   */
  private updateMasterJobProgress(workflowId: string, masterJobId: string): void {
    const jobs = this._jobs();
    const childJobs = jobs.filter(j => j.parentJobId === masterJobId);
    const completedChildren = childJobs.filter(j => j.status === 'complete').length;
    const errorChildren = childJobs.filter(j => j.status === 'error').length;
    const totalChildren = childJobs.length;

    if (totalChildren === 0) return;

    // Calculate progress as percentage of completed children
    const progress = Math.round((completedChildren / totalChildren) * 100);

    // Determine master job status
    let masterStatus: JobStatus = 'processing';
    if (completedChildren + errorChildren === totalChildren) {
      // All children finished - master is complete (or error if any child errored)
      masterStatus = errorChildren > 0 ? 'error' : 'complete';
    }

    // Update master job
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== masterJobId) return job;
        return {
          ...job,
          status: masterStatus,
          progress,
          // Show progress message
          progressMessage: `${completedChildren}/${totalChildren} steps complete`,
          completedAt: masterStatus === 'complete' ? new Date() : job.completedAt,
          error: masterStatus === 'error' ? 'One or more steps failed' : undefined
        };
      })
    );

    console.log(`[QUEUE] Master job ${masterJobId} progress: ${completedChildren}/${totalChildren} (${progress}%)`);
  }

  /**
   * Update language learning project status after workflow completion
   */
  private async updateLanguageLearningProjectStatus(projectId: string, status: string): Promise<void> {
    const electron = window.electron as any;
    if (!electron?.languageLearning?.loadProject || !electron?.languageLearning?.saveProject) {
      console.warn('[QUEUE] Cannot update project status: language learning API not available');
      return;
    }

    // Skip if projectId looks like an absolute path (BFP project opened in LL tab, not a native LL project)
    if (projectId.includes('\\') || projectId.includes('/') || /^[A-Za-z]:/.test(projectId)) {
      console.log(`[QUEUE] Skipping LL project status update — projectId is a BFP path: ${projectId}`);
      return;
    }

    try {
      // Load current project
      const loadResult = await electron.languageLearning.loadProject(projectId);
      if (!loadResult.success || !loadResult.project) {
        console.warn(`[QUEUE] Failed to load project ${projectId}: ${loadResult.error}`);
        return;
      }

      // Update status
      const project = loadResult.project;
      project.status = status;
      project.modifiedAt = new Date().toISOString();

      // Save updated project
      const saveResult = await electron.languageLearning.saveProject(project);
      if (saveResult.success) {
        console.log(`[QUEUE] Updated project ${projectId} status to '${status}'`);
      } else {
        console.warn(`[QUEUE] Failed to save project ${projectId}: ${saveResult.error}`);
      }
    } catch (err) {
      console.error(`[QUEUE] Error updating project status: ${err}`);
    }
  }

  /**
   * Clear completed/error jobs from the queue
   */
  clearCompleted(): void {
    this._jobs.update(jobs =>
      jobs.filter(j => j.status === 'pending' || j.status === 'processing')
    );
    // Also clean up any orphaned sub-items
    this.cleanupOrphanedSubItems();
  }

  /**
   * Force clear all jobs from the queue (use with caution)
   */
  clearAll(): void {
    // Cancel any running job first
    const currentId = this._currentJobId();
    if (currentId) {
      const electron = window.electron;
      electron?.queue?.cancelJob(currentId);
      this._currentJobId.set(null);
    }
    this._jobs.set([]);
    this._isRunning.set(false);
    console.log('[QUEUE] All jobs cleared');
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

    // Get pending jobs, but skip:
    // - Master workflow jobs (they don't process themselves)
    // - TTS placeholder jobs (waiting for translation to set epubPath)
    const pending = this._jobs().filter(j => {
      if (j.status !== 'pending') return false;
      // Skip master workflow jobs (audiobook containers)
      if (j.type === 'audiobook' && j.workflowId && !j.parentJobId) return false;
      // Skip TTS placeholder jobs that are waiting for translation
      if (j.type === 'tts-conversion' && (j.metadata as any)?.bilingualPlaceholder) return false;
      // Skip bilingual assembly placeholder jobs that are waiting for TTS to complete
      if (j.type === 'bilingual-assembly' && (j.metadata as any)?.bilingualPlaceholder) return false;
      return true;
    });
    if (pending.length === 0) return;

    const nextJob = pending[0];

    // If this job is part of a workflow, ensure the master job is marked as processing
    if (nextJob.parentJobId) {
      const masterJob = this._jobs().find(j => j.id === nextJob.parentJobId);
      if (masterJob && masterJob.status === 'pending') {
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== masterJob.id) return j;
            return {
              ...j,
              status: 'processing' as JobStatus,
              startedAt: new Date(),
              progress: 0,
              progressMessage: 'Starting workflow...'
            };
          })
        );
      }
    }

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
        if (!job.epubPath) {
          throw new Error('EPUB path is required for OCR cleanup');
        }
        // Build AI config from per-job settings
        const aiConfig: AIProviderConfig & {
          useDetailedCleanup?: boolean;
          deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
          useParallel?: boolean;
          parallelWorkers?: number;
          cleanupMode?: 'structure' | 'full';
          testMode?: boolean;
          testModeChunks?: number;
          enableAiCleanup?: boolean;
          simplifyForLearning?: boolean;
          cleanupPrompt?: string;
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
          testMode: config.testMode,
          testModeChunks: config.testModeChunks,
          // Processing options
          enableAiCleanup: config.enableAiCleanup,
          simplifyForLearning: config.simplifyForLearning,
          cleanupPrompt: config.cleanupPrompt
        };
        console.log('[QUEUE] Job config from storage:', { testMode: config.testMode, cleanupMode: config.cleanupMode, enableAiCleanup: config.enableAiCleanup, simplifyForLearning: config.simplifyForLearning, fullConfig: JSON.stringify(config) });
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
        const ocrResult = await electron.queue.runOcrCleanup(job.id, job.epubPath, config.aiModel, aiConfig);

        // Handle completion inline via handleJobComplete (don't rely solely on queue:job-complete IPC event).
        // This ensures all OCR-specific logic runs (TOO_MANY_FALLBACKS skip, analytics, etc.)
        // The IPC event may also arrive — handleJobComplete is idempotent for already-completed jobs.
        const ocrData = ocrResult?.data || {};
        await this.handleJobComplete({
          jobId: job.id,
          success: ocrData.success ?? ocrResult?.success ?? false,
          outputPath: ocrData.outputPath,
          error: ocrData.error || ocrResult?.error,
          copyrightIssuesDetected: ocrData.copyrightIssuesDetected,
          copyrightChunksAffected: ocrData.copyrightChunksAffected,
          contentSkipsDetected: ocrData.contentSkipsDetected,
          contentSkipsAffected: ocrData.contentSkipsAffected,
          skippedChunksPath: ocrData.skippedChunksPath,
          analytics: ocrData.analytics,
        });

      } else if (job.type === 'translation') {
        const config = job.config as TranslationJobConfig | undefined;
        if (!config) {
          throw new Error('Translation configuration required');
        }
        if (!job.epubPath) {
          throw new Error('EPUB path is required for translation');
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
        const transResult = await electron.queue.runTranslation(job.id, job.epubPath, translationConfig, aiConfig);

        // Handle completion inline via handleJobComplete (don't rely solely on queue:job-complete IPC event)
        const transData = transResult?.data || {};
        await this.handleJobComplete({
          jobId: job.id,
          success: transData.success ?? transResult?.success ?? false,
          outputPath: transData.outputPath,
          error: transData.error || transResult?.error,
          analytics: transData.analytics,
        });

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
          console.log(`[QUEUE] skipAssembly from config: ${config.skipAssembly}`);
          console.log(`[QUEUE] job.metadata:`, job.metadata);
          console.log(`[QUEUE] config.outputFilename:`, config.outputFilename);
          console.log(`[QUEUE] isResumeJob:`, job.isResumeJob);

          // IMPORTANT: For Language Learning pipeline, trust the EPUB path that was resolved when the job was created
          // The LL wizard uses EpubResolverService to find the correct language-specific EPUB (en.epub, de.epub, etc.)
          // Do NOT override with hardcoded search logic that would find cleaned.epub instead
          let epubPathForTts: string = job.epubPath || '';
          const isBilingualTts = !!(job.metadata as any)?.bilingualWorkflow;

          // Check if this is a Language Learning TTS job (has language config and sentencePerParagraph)
          const isLanguageLearningTts = config.sentencePerParagraph === true;

          if (job.outputPath) {
            // Job has an explicit output path (e.g., from chained workflow)
            epubPathForTts = job.outputPath;
            console.log(`[QUEUE] Using job.outputPath for TTS: ${epubPathForTts}`);
          } else if (isBilingualTts || isLanguageLearningTts) {
            // Language Learning or Bilingual TTS jobs already have the correct epub path
            // These use language-specific EPUBs (en.epub, de.epub) with sentence-per-paragraph format
            // Don't override with cleaned.epub which would have wrong format and too many chunks
            console.log(`[QUEUE] Language Learning TTS job, using resolved epubPath: ${epubPathForTts}`);
          } else if (electron.fs?.exists && job.epubPath) {
            // Standard audiobook workflow: Check for processed EPUBs in priority order
            // This is for regular audiobooks, not Language Learning
            const epubPathNorm = job.epubPath.replace(/\\/g, '/');
            const epubDir = epubPathNorm.substring(0, epubPathNorm.lastIndexOf('/'));

            // Derive project dir from epub path (epub is in source/ or stages/01-cleanup/)
            let projectDirForTts = '';
            if (epubDir.includes('/stages/01-cleanup')) {
              projectDirForTts = epubDir.substring(0, epubDir.indexOf('/stages/01-cleanup'));
            } else if (epubDir.endsWith('/source')) {
              projectDirForTts = epubDir.substring(0, epubDir.lastIndexOf('/source'));
            }

            const candidates = [
              // Mono translation output in stages/02-translate/
              ...(projectDirForTts ? [`${projectDirForTts}/stages/02-translate/translated.epub`] : []),
              // AI-simplified or AI-cleaned in stages/01-cleanup/
              ...(projectDirForTts ? [
                `${projectDirForTts}/stages/01-cleanup/simplified.epub`,
                `${projectDirForTts}/stages/01-cleanup/cleaned.epub`,
              ] : [
                `${epubDir}/simplified.epub`,
                `${epubDir}/cleaned.epub`,
              ]),
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
              console.log(`[QUEUE] Standard audiobook: Found processed epub, using: ${epubPathForTts}`);
            } else {
              console.log(`[QUEUE] Standard audiobook: No processed epub found, using original: ${epubPathForTts}`);
            }
          }

          if (!epubPathForTts) {
            throw new Error('EPUB path is required for parallel TTS conversion');
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
              enableTextSplitting: config.enableTextSplitting,
              // For language learning: preserve paragraph boundaries as sentences
              sentencePerParagraph: config.sentencePerParagraph,
              // For bilingual: skip reading heading tags as chapter titles
              skipHeadings: config.skipHeadings,
              // Test mode - only process first N sentences
              testMode: config.testMode,
              testSentences: config.testSentences
            },
            // Pass metadata for final audiobook (applied after assembly via m4b-tool)
            // Use bookTitle/author for m4b tags (metadata.title is the queue display label)
            metadata: {
              title: job.metadata?.bookTitle || job.metadata?.title,
              author: job.metadata?.author,
              year: job.metadata?.year,
              coverPath: job.metadata?.coverPath,
              outputFilename: job.metadata?.outputFilename || config.outputFilename
            },
            // Bilingual mode for language learning audiobooks
            bilingual: config.bilingual,
            // Skip assembly for dual-voice workflows (assembly happens separately)
            skipAssembly: config.skipAssembly,
            // Temp folder workflow for Syncthing compatibility
            bfpPath: job.bfpPath,
            isArticle: !!(job.projectDir && job.projectDir.replace(/\\/g, '/').includes('/language-learning/projects/')),
            externalAudiobooksDir: this.settingsService.get<string>('externalAudiobooksDir')
          };

          // Resume logic — three modes:
          // 1. Explicit resume (wizard "Continue" button): job.isResumeJob + config.resumeInfo
          // 2. Interrupted job (app crash/close): job.wasInterrupted — check for existing session
          // 3. Fresh start (default): clean old sessions and start new
          let shouldResume = false;
          let resumeCheckResult: ResumeCheckResult | null = null;

          if (job.isResumeJob && config.resumeInfo) {
            // Mode 1: Explicit resume from wizard "Continue" button
            resumeCheckResult = {
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
            shouldResume = true;
            console.log(`[QUEUE] Explicit resume job from ${job.resumeCompletedSentences} sentences`);
          } else if (job.wasInterrupted && job.bfpPath) {
            // Mode 2: Job was interrupted by app close/crash — try to resume
            resumeCheckResult = await this.checkBfpForResumableSession(job.bfpPath, epubPathForTts);
            if (resumeCheckResult?.success && !resumeCheckResult.complete) {
              shouldResume = true;
              this._jobs.update(jobs => jobs.map(j => {
                if (j.id !== job.id) return j;
                return {
                  ...j,
                  isResumeJob: true,
                  resumeCompletedSentences: resumeCheckResult!.completedSentences,
                  resumeMissingSentences: resumeCheckResult!.missingSentences
                };
              }));
              console.log(`[QUEUE] Auto-resuming interrupted job: ${resumeCheckResult.completedSentences}/${resumeCheckResult.totalSentences} sentences`);
            } else {
              console.log(`[QUEUE] Interrupted job has no resumable session, starting fresh`);
            }
          }
          // Mode 3: Fresh start — clean old sessions
          if (!shouldResume) {
            (parallelConfig as any).cleanSession = true;
          }

          // Create a promise that resolves when TTS completes (inline completion handling)
          // This prevents the race condition where the event-based onComplete fires
          // but processNext() isn't called due to timing issues.
          const ttsComplete = new Promise<{
            success: boolean; outputPath?: string; error?: string;
            sessionId?: string; sessionDir?: string;
            analytics?: any; wasStopped?: boolean; stopInfo?: any;
          }>((resolve) => {
            const unsub = electron.parallelTts!.onComplete((data: any) => {
              if (data.jobId !== job.id) return;
              unsub();
              resolve(data);
            });
          });

          if (shouldResume && resumeCheckResult) {
            console.log(`[QUEUE] Resuming TTS conversion from ${resumeCheckResult.completedSentences} sentences`);
            await electron.parallelTts.resumeConversion(job.id, parallelConfig, resumeCheckResult);
          } else {
            // Start fresh conversion
            await electron.parallelTts.startConversion(job.id, parallelConfig);
          }

          // Wait for TTS to actually finish (the invoke above returns immediately)
          const ttsResult = await ttsComplete;
          console.log(`[QUEUE] Parallel TTS inline completion: success=${ttsResult.success}, jobId=${job.id}`);

          // Delegate to handleJobComplete for all TTS-specific logic
          // (session caching, processNext, etc.)
          // This is idempotent — if the event-based handler already processed this, it's a no-op
          // because _currentJobId will have been cleared and the "not the current job" branch runs.
          await this.handleJobComplete({
            jobId: job.id,
            success: ttsResult.success,
            outputPath: ttsResult.outputPath,
            error: ttsResult.error,
            analytics: ttsResult.analytics,
            wasStopped: ttsResult.wasStopped,
            stopInfo: ttsResult.stopInfo,
            sessionId: ttsResult.sessionId,
            sessionDir: ttsResult.sessionDir,
          });

        } else {
          // Use sequential TTS conversion
          // IMPORTANT: Use the EPUB path that was resolved when the job was created
          // Do NOT override with hardcoded search logic - this breaks Language Learning pipeline
          let seqEpubPath = job.epubPath || '';

          // Only use outputPath if explicitly set (from previous job in chain)
          if (job.outputPath) {
            seqEpubPath = job.outputPath;
            console.log(`[QUEUE] Sequential TTS: using output from previous job: ${seqEpubPath}`);
          } else if (!seqEpubPath) {
            throw new Error('EPUB path is required for TTS conversion');
          } else {
            console.log(`[QUEUE] Sequential TTS: using job's EPUB path: ${seqEpubPath}`);
          }

          const seqResult = await electron.queue.runTtsConversion(job.id, seqEpubPath, config);

          // Handle completion inline via handleJobComplete (don't rely solely on queue:job-complete IPC event)
          const seqData = seqResult?.data || {};
          await this.handleJobComplete({
            jobId: job.id,
            success: seqData.success ?? seqResult?.success ?? false,
            outputPath: seqData.outputPath,
            error: seqData.error || seqResult?.error,
            analytics: seqData.analytics,
            sessionId: seqData.sessionId,
            sessionDir: seqData.sessionDir,
          });
        }
      } else if (job.type === 'reassembly') {
        // Reassembly job - reassemble incomplete e2a session
        let config = job.config as ReassemblyJobConfig | undefined;
        if (!config) {
          throw new Error('Reassembly configuration required');
        }

        // Runtime session discovery — resolve session data from BFP cache if not provided
        if (!config.sessionId && job.bfpPath) {
          console.log('[QUEUE] Reassembly: discovering session from BFP cache...');
          const sessionResult = await (electron.reassembly as any).getBfpSession(job.bfpPath);
          if (sessionResult.success && sessionResult.data) {
            const s = sessionResult.data;
            config = {
              ...config,
              sessionId: s.sessionId,
              sessionDir: s.sessionDir,
              processDir: s.processDir,
              totalChapters: s.chapters?.filter((ch: any) => !ch.excluded)?.length || 0,
            };
            console.log(`[QUEUE] Reassembly: found session ${s.sessionId}, ${config.totalChapters} chapters`);
          } else {
            throw new Error('No TTS session found in project — run TTS first');
          }
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

        // Mark job as complete
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== job.id) return j;
            return {
              ...j,
              status: 'complete' as JobStatus,
              progress: 100,
              completedAt: new Date(),
              outputPath: result.data?.outputPath,
            };
          })
        );

        console.log('[QUEUE] Reassembly complete:', result.data?.outputPath);

        // Copy VTT to BFP audiobook folder
        if (result.data?.outputPath && job.bfpPath) {
          this.copyVttToBfp(job.bfpPath, result.data.outputPath);
        }

        // Link audio to BFP
        if (result.data?.outputPath?.endsWith('.m4b') && job.bfpPath) {
          try {
            const el = (window as any).electron;
            if (el?.audiobook?.linkAudio) {
              await el.audiobook.linkAudio(job.bfpPath, result.data.outputPath);
            }
          } catch (err) {
            console.error('[QUEUE] Failed to auto-link audio after reassembly:', err);
          }
        }

        // Copy to external audiobooks directory
        if (result.data?.outputPath?.endsWith('.m4b')) {
          const externalDir = this.settingsService.get<string>('externalAudiobooksDir');
          if (externalDir) {
            try {
              const el = (window as any).electron;
              if (el?.audiobook?.copyToExternal) {
                const title = (job.metadata as any)?.title || (job.metadata as any)?.bookTitle || '';
                const author = (job.metadata as any)?.author || '';
                const copyResult = await el.audiobook.copyToExternal({
                  m4bPath: result.data.outputPath,
                  externalDir,
                  title,
                  author,
                });
                if (copyResult.success) {
                  console.log('[QUEUE] Copied audiobook to external dir:', copyResult.externalPath);
                } else {
                  console.error('[QUEUE] Failed to copy to external dir:', copyResult.error);
                }
              }
            } catch (err) {
              console.error('[QUEUE] Error copying to external dir:', err);
            }
          }
        }

        // Reload studio item
        if (job.bfpPath) {
          await this.studioService.reloadItem(job.bfpPath);
        }

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // Clear current job and process next
        this._currentJobId.set(null);
        await this.processNext();
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
      } else if (job.type === 'bilingual-cleanup') {
        // Language Learning Cleanup job
        const config = job.config as BilingualCleanupJobConfig | undefined;
        if (!config) {
          throw new Error('Bilingual Cleanup configuration required');
        }

        console.log('[QUEUE] Starting bilingual-cleanup job:', {
          projectId: config.projectId,
          aiProvider: config.aiProvider,
          aiModel: config.aiModel,
          simplifyForLearning: config.simplifyForLearning,
          cleanupPrompt: config.cleanupPrompt ? 'PROVIDED' : 'NOT PROVIDED'
        });

        if (!electron.bilingualCleanup) {
          throw new Error('Bilingual Cleanup not available');
        }

        const result = await electron.bilingualCleanup.run(job.id, {
          projectId: config.projectId,
          projectDir: config.projectDir,
          sourceEpubPath: config.sourceEpubPath,
          sourceLang: config.sourceLang,
          aiProvider: config.aiProvider,
          aiModel: config.aiModel,
          ollamaBaseUrl: config.ollamaBaseUrl,
          claudeApiKey: config.claudeApiKey,
          openaiApiKey: config.openaiApiKey,
          cleanupPrompt: config.cleanupPrompt,
          simplifyForLearning: config.simplifyForLearning,
          testMode: config.testMode,
          testModeChunks: config.testModeChunks
        });

        if (!result.success) {
          throw new Error(result.error || 'Bilingual Cleanup failed');
        }

        // Mark cleanup job as complete
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== job.id) return j;
            return { ...j, status: 'complete' as JobStatus, progress: 100, outputPath: result.outputPath };
          })
        );

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // Clear current job and process next (the translation job)
        this._currentJobId.set(null);
        await this.processNext();

      } else if (job.type === 'bilingual-translation') {
        // Language Learning Translation job
        const config = job.config as BilingualTranslationJobConfig | undefined;
        if (!config) {
          throw new Error('Bilingual Translation configuration required');
        }

        console.log('[QUEUE] Starting bilingual-translation job:', {
          projectId: config.projectId,
          targetLang: config.targetLang,
          aiProvider: config.aiProvider,
          aiModel: config.aiModel
        });

        if (!electron.bilingualTranslation) {
          throw new Error('Bilingual Translation not available');
        }

        const result = await electron.bilingualTranslation.run(job.id, {
          projectId: config.projectId,
          projectDir: config.projectDir,
          cleanedEpubPath: config.cleanedEpubPath || job.epubPath,  // Use epubPath if cleanedEpubPath not set
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          title: config.title,
          aiProvider: config.aiProvider,
          aiModel: config.aiModel,
          ollamaBaseUrl: config.ollamaBaseUrl,
          claudeApiKey: config.claudeApiKey,
          openaiApiKey: config.openaiApiKey,
          translationPrompt: config.translationPrompt,
          monoTranslation: config.monoTranslation,
          testMode: config.testMode,
          testModeChunks: config.testModeChunks
        });

        if (!result.success) {
          throw new Error(result.error || 'Bilingual Translation failed');
        }

        // Mark translation job as complete
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== job.id) return j;
            return { ...j, status: 'complete' as JobStatus, progress: 100, outputPath: result.outputPath };
          })
        );

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // For mono translation, skip the dual-EPUB workflow — just advance the queue
        if (config.monoTranslation) {
          console.log('[QUEUE] Mono translation complete, skipping dual-EPUB workflow');
          this._currentJobId.set(null);
          await this.processNext();
          return;
        }

        // Check if translation returned dual EPUB paths for dual-voice TTS
        // Check both result.nextJobConfig (old format) and result.data (new format from language-learning-jobs.ts)
        const nextConfig = (result as any).nextJobConfig || (result as any).data;
        console.log('[QUEUE] Translation complete, checking for TTS chaining:', {
          hasSourceEpub: !!nextConfig?.sourceEpubPath,
          hasTargetEpub: !!nextConfig?.targetEpubPath,
          hasParentJobId: !!job.parentJobId,
          parentJobId: job.parentJobId
        });

        if (nextConfig?.sourceEpubPath && nextConfig?.targetEpubPath && job.parentJobId && config.projectDir) {
          // Get TTS settings from the master job (legacy workflow support)
          const masterJob = this._jobs().find(j => j.id === job.parentJobId);
          const masterConfig = masterJob?.config as any;

          console.log('[QUEUE] Master job lookup:', {
            found: !!masterJob,
            hasConfig: !!masterConfig,
            configType: masterConfig?.type
          });

          if (masterConfig) {
            console.log('[QUEUE] Bilingual Translation complete with dual EPUBs, updating placeholder TTS jobs');

            // Calculate paths - handle both article and book project structures
            // Normalize backslashes for cross-platform path manipulation
            const projectDir = config.projectDir.replace(/\\/g, '/');
            let audiobooksDir: string;

            // Book projects: projectDir is like /library/projects/bookname
            // Output goes to projectDir/output/
            if (projectDir.includes('/projects/')) {
              audiobooksDir = `${projectDir}/output`;
            } else {
              // Fallback for other structures
              audiobooksDir = `${projectDir}/output`;
            }

            // Get bfpPath from the job for book projects (needed to update bilingual paths later)
            const bfpPath = job.bfpPath;

            const workerCount = masterConfig.ttsEngine === 'orpheus' ? 1 : (masterConfig.workerCount || 4);

            // Find existing placeholder TTS jobs created upfront
            const workflowJobs = this._jobs().filter(j =>
              j.workflowId === job.workflowId &&
              j.type === 'tts-conversion' &&
              j.status === 'pending'
            );

            const sourceTtsJob = workflowJobs.find(j =>
              (j.metadata as any)?.bilingualPlaceholder?.role === 'source'
            );
            const targetTtsJob = workflowJobs.find(j =>
              (j.metadata as any)?.bilingualPlaceholder?.role === 'target'
            );

            if (sourceTtsJob && targetTtsJob) {
              console.log('[QUEUE] Found placeholder TTS jobs, updating with EPUB paths:', {
                sourceJobId: sourceTtsJob.id,
                targetJobId: targetTtsJob.id
              });

              // Update SOURCE TTS job with actual EPUB path and chaining metadata
              this._jobs.update(jobs =>
                jobs.map(j => {
                  if (j.id === sourceTtsJob.id) {
                    return {
                      ...j,
                      epubPath: nextConfig.sourceEpubPath,
                      epubFilename: nextConfig.sourceEpubPath.replace(/\\/g, '/').split('/').pop() || 'source.epub',
                      metadata: {
                        ...j.metadata,
                        bilingualPlaceholder: undefined, // Clear placeholder marker
                        bilingualWorkflow: {
                          role: 'source',
                          targetEpubPath: nextConfig.targetEpubPath,
                          targetConfig: {
                            epubPath: nextConfig.targetEpubPath,
                            title: (targetTtsJob.metadata as any)?.title || 'Target TTS',
                            ttsEngine: masterConfig.ttsEngine,
                            voice: masterConfig.targetVoice,
                            device: masterConfig.device || 'cpu',
                            speed: masterConfig.targetTtsSpeed,
                            workerCount,
                            language: masterConfig.targetLang,
                            outputDir: audiobooksDir
                          },
                          assemblyConfig: {
                            projectId: masterConfig.projectId,
                            audiobooksDir,
                            bfpPath: projectDir, // Use project dir as BFP for temp folder workflow
                            sentencePairsPath: nextConfig.sentencePairsPath,
                            pauseDuration: 0.3,
                            gapDuration: 1.0,
                            // Output naming with language suffix
                            title: masterConfig.title,
                            sourceLang: masterConfig.sourceLang,
                            targetLang: masterConfig.targetLang
                          }
                        }
                      },
                      config: {
                        ...j.config as TtsConversionConfig,
                        outputDir: '', // Not needed - using bfpPath
                        outputFilename: `${masterConfig.projectId}_source.m4b`
                      },
                      bfpPath: projectDir // Use project dir as BFP for temp folder workflow
                    };
                  }
                  if (j.id === targetTtsJob.id) {
                    // Update target TTS job with EPUB path (will be processed via chaining)
                    return {
                      ...j,
                      epubPath: nextConfig.targetEpubPath,
                      epubFilename: nextConfig.targetEpubPath.replace(/\\/g, '/').split('/').pop() || 'target.epub',
                      metadata: {
                        ...j.metadata,
                        bilingualPlaceholder: undefined // Clear placeholder marker
                      },
                      config: {
                        ...j.config as TtsConversionConfig,
                        outputDir: '', // Not needed - using bfpPath
                        outputFilename: `${masterConfig.projectId}_target.m4b`
                      },
                      bfpPath: projectDir // Use project dir as BFP for temp folder workflow
                    };
                  }
                  return j;
                })
              );

              console.log('[QUEUE] Updated placeholder TTS jobs, source TTS will process next');
            } else {
              // Fallback: No placeholder jobs found, create new ones (legacy behavior)
              console.log('[QUEUE] No placeholder TTS jobs found, creating new ones');
              const bilWorkflowId = `bilingual-${Date.now()}`;

              await this.addJob({
                type: 'tts-conversion',
                epubPath: nextConfig.sourceEpubPath,
                workflowId: bilWorkflowId,
                parentJobId: job.parentJobId,
                metadata: {
                  title: `${masterConfig.projectId || 'LL'} Source TTS`,
                  author: 'Language Learning',
                  bilingualWorkflow: {
                    role: 'source',
                    targetEpubPath: nextConfig.targetEpubPath,
                    targetConfig: {
                      epubPath: nextConfig.targetEpubPath,
                      title: `${masterConfig.projectId || 'LL'} Target TTS`,
                      ttsEngine: masterConfig.ttsEngine,
                      voice: masterConfig.targetVoice,
                      device: masterConfig.device || 'cpu',
                      speed: masterConfig.targetTtsSpeed,
                      workerCount,
                      language: masterConfig.targetLang,
                      bfpPath: projectDir
                    },
                    assemblyConfig: {
                      projectId: masterConfig.projectId,
                      audiobooksDir,
                      bfpPath: projectDir, // Use project dir as BFP for temp folder workflow
                      sentencePairsPath: nextConfig.sentencePairsPath,
                      pauseDuration: 0.3,
                      gapDuration: 1.0,
                      // Output naming with language suffix
                      title: masterConfig.title,
                      sourceLang: masterConfig.sourceLang,
                      targetLang: masterConfig.targetLang
                    }
                  }
                },
                bfpPath: projectDir, // Use project dir as BFP for temp folder workflow
                config: {
                  type: 'tts-conversion',
                  useParallel: true,
                  parallelMode: 'sentences',
                  parallelWorkers: workerCount,
                  device: masterConfig.device || 'cpu',
                  language: masterConfig.sourceLang,
                  ttsEngine: masterConfig.ttsEngine,
                  fineTuned: masterConfig.sourceVoice,
                  speed: masterConfig.sourceTtsSpeed,
                  outputDir: '', // Not needed - using bfpPath
                  outputFilename: `${masterConfig.projectId}_source.m4b`,
                  skipAssembly: true,
                  temperature: 0.75,
                  topP: 0.85,
                  topK: 50,
                  repetitionPenalty: 5.0,
                  enableTextSplitting: true
                }
              });
            }
          }
        }

        // Clear current job and process next
        this._currentJobId.set(null);
        await this.processNext();

      } else if (job.type === 'bilingual-assembly') {
        // Bilingual Assembly job - combines source and target TTS outputs
        const config = job.config as any;
        if (!config) {
          throw new Error('Bilingual Assembly configuration required');
        }

        console.log('[QUEUE] Starting bilingual-assembly job:', {
          projectId: config.projectId,
          sourceSentencesDir: config.sourceSentencesDir,
          targetSentencesDir: config.targetSentencesDir
        });

        // Call the bilingual assembly API
        const bilingualAssembly = (window.electron as any)?.bilingualAssembly;
        if (!bilingualAssembly) {
          throw new Error('Bilingual Assembly not available');
        }

        // Subscribe to progress updates to show assembly phases
        const unsubscribeProgress = bilingualAssembly.onProgress((data: {
          jobId: string;
          progress: { phase: string; percentage: number; message: string }
        }) => {
          if (data.jobId !== job.id) return;

          // Map phase to assemblySubPhase
          const phaseMap: Record<string, 'combining' | 'vtt' | 'encoding' | 'metadata'> = {
            'combining': 'combining',
            'vtt': 'vtt',
            'encoding': 'encoding',
            'metadata': 'metadata'
          };

          this._jobs.update(jobs =>
            jobs.map(j => {
              if (j.id !== job.id) return j;
              return {
                ...j,
                progress: data.progress.percentage,
                progressMessage: data.progress.message,
                assemblySubPhase: phaseMap[data.progress.phase] || j.assemblySubPhase,
                assemblyProgress: data.progress.percentage
              };
            })
          );
        });

        const result = await bilingualAssembly.run(job.id, {
          projectId: config.projectId,
          sourceSentencesDir: config.sourceSentencesDir,
          targetSentencesDir: config.targetSentencesDir,
          sentencePairsPath: config.sentencePairsPath,
          outputDir: config.outputDir,
          pauseDuration: config.pauseDuration,
          gapDuration: config.gapDuration,
          // Output naming with language suffix
          outputName: config.outputName,
          title: config.title || job.metadata?.title,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          bfpPath: config.bfpPath
        });

        // Unsubscribe from progress
        if (unsubscribeProgress) unsubscribeProgress();

        if (!result.success) {
          throw new Error(result.error || 'Bilingual Assembly failed');
        }

        // Mark job as complete
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== job.id) return j;
            return {
              ...j,
              status: 'complete' as JobStatus,
              progress: 100,
              outputPath: result.data?.audioPath
            };
          })
        );

        console.log('[QUEUE] Bilingual assembly complete:', {
          audioPath: result.data?.audioPath,
          vttPath: result.data?.vttPath,
          projectDir: job.projectDir,
          sentencePairsPath: config.sentencePairsPath
        });

        // Finalize output: copy to project dir, update manifest, copy to external audiobooks dir
        if (result.data?.audioPath && job.projectDir) {
          const bilingualAssembly = (window.electron as any)?.bilingualAssembly;
          if (bilingualAssembly?.finalizeOutput) {
            // Build metadata-based filename base: "{Title}. {Author}"
            // The finalize handler appends "(language learning, english-german)" with full language names
            const title = config.title || config.projectId || 'Audiobook';
            const author = job.metadata?.author || '';
            let metadataFilename = title;
            if (author && !title.includes(author)) {
              metadataFilename += `. ${author}`;
            }

            const externalAudiobooksDir = this.settingsService.get<string>('externalAudiobooksDir') || '';

            const finalizeResult = await bilingualAssembly.finalizeOutput({
              audioPath: result.data.audioPath,
              vttPath: result.data.vttPath,
              projectDir: job.projectDir,
              projectId: config.projectId,
              sourceLang: config.sourceLang || 'en',
              targetLang: config.targetLang || 'de',
              externalAudiobooksDir: externalAudiobooksDir || undefined,
              metadataFilename,
              sentencePairsPath: config.sentencePairsPath,
            });

            if (finalizeResult?.success) {
              console.log('[QUEUE] Bilingual assembly output finalized to project');
              // Reload the book in StudioService so the Play button lights up
              await this.studioService.reloadItem(job.projectDir);
            } else {
              console.error('[QUEUE] Failed to finalize bilingual assembly output:', finalizeResult?.error);
            }
          }
        }

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // Clear current job and process next
        this._currentJobId.set(null);
        await this.processNext();

      } else if (job.type === 'video-assembly') {
        // Video Assembly job - renders subtitle MP4 from M4B + VTT
        const config = job.config as any;
        if (!config) {
          throw new Error('Video Assembly configuration required');
        }

        console.log('[QUEUE] Starting video-assembly job:', {
          mode: config.mode,
          resolution: config.resolution,
          m4bPath: config.m4bPath,
        });

        const videoAssembly = (window.electron as any)?.videoAssembly;
        if (!videoAssembly) {
          throw new Error('Video Assembly not available');
        }

        // Subscribe to progress
        const unsubscribeProgress = videoAssembly.onProgress((data: {
          jobId: string; phase: string; percentage: number; message: string;
        }) => {
          if (data.jobId !== job.id) return;
          this._jobs.update(jobs =>
            jobs.map(j => {
              if (j.id !== job.id) return j;
              return {
                ...j,
                progress: data.percentage,
                progressMessage: data.message,
              };
            })
          );
        });

        // Subscribe to completion
        const videoComplete = new Promise<{ success: boolean; outputPath?: string; error?: string }>((resolve) => {
          const unsub = videoAssembly.onComplete((data: {
            jobId: string; success: boolean; outputPath?: string; error?: string;
          }) => {
            if (data.jobId !== job.id) return;
            unsub();
            resolve(data);
          });
        });

        // Start the video assembly (async - returns immediately)
        const externalAudiobooksDir = this.settingsService.get<string>('externalAudiobooksDir') || '';
        const startResult = await videoAssembly.run(job.id, {
          projectId: config.projectId,
          bfpPath: config.bfpPath,
          mode: config.mode,
          m4bPath: config.m4bPath,
          vttPath: config.vttPath,
          sentencePairsPath: config.sentencePairsPath,
          title: config.title || job.metadata?.title,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          resolution: config.resolution,
          externalAudiobooksDir: externalAudiobooksDir || undefined,
          outputFilename: config.outputFilename || job.metadata?.outputFilename,
        });

        if (!startResult.success) {
          if (unsubscribeProgress) unsubscribeProgress();
          throw new Error(startResult.error || 'Failed to start video assembly');
        }

        // Wait for completion
        const result = await videoComplete;
        if (unsubscribeProgress) unsubscribeProgress();

        if (!result.success) {
          throw new Error(result.error || 'Video assembly failed');
        }

        // Mark complete
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== job.id) return j;
            return {
              ...j,
              status: 'complete' as JobStatus,
              progress: 100,
              outputPath: result.outputPath,
            };
          })
        );

        console.log('[QUEUE] Video assembly complete:', result.outputPath);

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // Clear current job and process next
        this._currentJobId.set(null);
        await this.processNext();
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

  private buildJobConfig(request: CreateJobRequest): OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | ReassemblyJobConfig | ResembleEnhanceJobConfig | BilingualCleanupJobConfig | BilingualTranslationJobConfig | BilingualAssemblyJobConfig | VideoAssemblyJobConfig | AudiobookJobConfig | undefined {
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
        testMode: config.testMode,
        testModeChunks: config.testModeChunks,
        // Processing options
        enableAiCleanup: config.enableAiCleanup,
        simplifyForLearning: config.simplifyForLearning,
        cleanupPrompt: config.cleanupPrompt
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
        device: config.device || 'cpu',
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
        parallelMode: config.parallelMode,
        // Bilingual mode and skip assembly for dual-voice workflows
        bilingual: config.bilingual,
        skipAssembly: config.skipAssembly,
        // Never use cleanSession - preserve session contents
        // Preserve paragraph boundaries (for language learning)
        sentencePerParagraph: config.sentencePerParagraph,
        // Skip reading heading tags as chapter titles (for bilingual)
        skipHeadings: config.skipHeadings,
        // Test mode - only process first N sentences
        testMode: config.testMode,
        testSentences: config.testSentences
      };
    } else if (request.type === 'reassembly') {
      const config = request.config as Partial<ReassemblyJobConfig>;
      // sessionId/sessionDir/processDir may be empty — filled at runtime via BFP session discovery
      // outputDir is required — it's known at creation time from bfpPath
      if (!config?.outputDir) {
        return undefined;
      }
      return {
        type: 'reassembly',
        sessionId: config.sessionId || '',
        sessionDir: config.sessionDir || '',
        processDir: config.processDir || '',
        outputDir: config.outputDir,
        totalChapters: config.totalChapters,
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
    } else if (request.type === 'bilingual-cleanup') {
      const config = request.config as Partial<BilingualCleanupJobConfig>;
      if (!config?.projectId || !config?.projectDir || !config?.aiProvider || !config?.aiModel) {
        return undefined;
      }
      return {
        type: 'bilingual-cleanup',
        projectId: config.projectId,
        projectDir: config.projectDir,
        sourceEpubPath: config.sourceEpubPath || request.epubPath,  // Fall back to request.epubPath
        sourceLang: config.sourceLang || 'en',
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        cleanupPrompt: config.cleanupPrompt,
        simplifyForLearning: config.simplifyForLearning,
        testMode: config.testMode,
        testModeChunks: config.testModeChunks
      };
    } else if (request.type === 'bilingual-translation') {
      const config = request.config as Partial<BilingualTranslationJobConfig>;
      // Only aiProvider and aiModel are strictly required
      if (!config?.aiProvider || !config?.aiModel) {
        return undefined;
      }
      return {
        type: 'bilingual-translation',
        projectId: config.projectId,
        projectDir: config.projectDir,
        cleanedEpubPath: config.cleanedEpubPath || request.epubPath, // Fall back to epubPath
        sourceLang: config.sourceLang || 'en',
        targetLang: config.targetLang || 'de',
        title: config.title,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        translationPrompt: config.translationPrompt,
        monoTranslation: config.monoTranslation,
        testMode: config.testMode,
        testModeChunks: config.testModeChunks
      };
    } else if (request.type === 'bilingual-assembly') {
      const config = request.config as Partial<BilingualAssemblyJobConfig>;
      if (!config?.projectId || !config?.sourceSentencesDir || !config?.targetSentencesDir || !config?.sentencePairsPath || !config?.outputDir) {
        return undefined;
      }
      return {
        type: 'bilingual-assembly',
        projectId: config.projectId,
        sourceSentencesDir: config.sourceSentencesDir,
        targetSentencesDir: config.targetSentencesDir,
        sentencePairsPath: config.sentencePairsPath,
        outputDir: config.outputDir,
        pauseDuration: config.pauseDuration ?? 0.3,
        gapDuration: config.gapDuration ?? 1.0
      };
    } else if (request.type === 'video-assembly') {
      const config = request.config as Partial<VideoAssemblyJobConfig>;
      if (!config?.projectId || !config?.bfpPath || !config?.m4bPath || !config?.vttPath) {
        return undefined;
      }
      return {
        type: 'video-assembly',
        projectId: config.projectId,
        bfpPath: config.bfpPath,
        mode: config.mode || 'monolingual',
        m4bPath: config.m4bPath,
        vttPath: config.vttPath,
        sentencePairsPath: config.sentencePairsPath,
        title: config.title || 'Audiobook',
        sourceLang: config.sourceLang || 'en',
        targetLang: config.targetLang,
        resolution: config.resolution || '1080p',
        outputFilename: config.outputFilename,
      };
    } else if (request.type === 'audiobook') {
      // Audiobook master jobs are containers - no config needed
      return { type: 'audiobook' };
    }
    return undefined;
  }

  private generateId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get human-readable language name from language code
   */
  private getLanguageName(code: string | undefined): string {
    const languageNames: Record<string, string> = {
      'en': 'English',
      'de': 'German',
      'es': 'Spanish',
      'fr': 'French',
      'it': 'Italian',
      'pt': 'Portuguese',
      'nl': 'Dutch',
      'pl': 'Polish',
      'ru': 'Russian',
      'ja': 'Japanese',
      'zh': 'Chinese',
      'ko': 'Korean',
      'ar': 'Arabic',
      'hi': 'Hindi',
      'tr': 'Turkish',
      'vi': 'Vietnamese',
      'th': 'Thai',
      'sv': 'Swedish',
      'da': 'Danish',
      'no': 'Norwegian',
      'fi': 'Finnish',
    };
    return code ? (languageNames[code] || code.toUpperCase()) : 'Unknown';
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
                  totalAssigned: (w as any).totalAssigned,
                  actualConversions: (w as any).actualConversions
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
          const filename = session.epubPath.replace(/\\/g, '/').split('/').pop() || 'Unknown';
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
              totalAssigned: (w as any).totalAssigned,
              actualConversions: (w as any).actualConversions
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
   * Copy VTT file to BFP audiobook folder for chapter recovery.
   * Called after TTS completion when an output M4B is available.
   */
  private async copyVttToBfp(bfpPath: string, m4bOutputPath: string): Promise<void> {
    const electron = window.electron as any;
    if (!electron?.audiobook?.copyVtt) {
      console.warn('[QUEUE] Cannot copy VTT - electron.audiobook.copyVtt not available');
      return;
    }

    try {
      const result = await electron.audiobook.copyVtt(bfpPath, m4bOutputPath);
      if (result.success) {
        if (result.vttPath) {
          console.log('[QUEUE] Copied VTT to BFP:', result.vttPath);
        } else {
          console.log('[QUEUE] No VTT file found to copy');
        }
      } else {
        console.error('[QUEUE] Failed to copy VTT to BFP:', result.error);
      }
    } catch (err) {
      console.error('[QUEUE] Error copying VTT to BFP:', err);
    }
  }

  /**
   * Cache audio files after TTS completion for cached-language TTS jobs
   */
  private async cacheAudioAfterTts(
    sentencesDir: string,
    cacheDir: string,
    language: string,
    ttsSettings: {
      engine: 'xtts' | 'orpheus';
      voice: string;
      speed: number;
    }
  ): Promise<void> {
    const electron = window.electron as any;
    if (!electron?.sentenceCache?.cacheAudio) {
      console.warn('[QUEUE] Cannot cache audio - electron.sentenceCache.cacheAudio not available');
      return;
    }

    try {
      // Extract audiobook folder from cache dir (e.g., 'audiobooks/book/audio/en' -> 'audiobooks/book')
      const audiobookFolder = cacheDir.replace(/\/audio\/[^/]+$/, '');

      const result = await electron.sentenceCache.cacheAudio({
        audiobookFolder,
        language,
        sentencesDir,
        ttsSettings,
      });

      if (result.success) {
        console.log(`[QUEUE] Cached ${result.fileCount} audio files for ${language}`);
      } else {
        console.error('[QUEUE] Failed to cache audio:', result.error);
      }
    } catch (err) {
      console.error('[QUEUE] Error caching audio:', err);
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
          status: job.status === 'processing' ? 'pending' : job.status,
          // Mark interrupted jobs so TTS can auto-resume instead of starting fresh
          wasInterrupted: job.status === 'processing' ? true : job.wasInterrupted
        }));

        this._jobs.set(jobs);

        // Clean up orphaned sub-items (sub-items whose master job doesn't exist)
        this.cleanupOrphanedSubItems();

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

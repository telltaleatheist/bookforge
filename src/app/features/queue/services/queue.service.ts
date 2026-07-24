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
  RvcEnhancementJobConfig,
  ReassemblyJobConfig,
  BilingualCleanupJobConfig,
  BilingualTranslationJobConfig,
  BilingualAssemblyJobConfig,
  VideoAssemblyJobConfig,
  AudiobookJobConfig,
  BookAnalysisConfig,
  GenerateSentencesJobConfig,
  ResumeCheckResult,
  TtsResumeInfo,
  AlignStageProgress
} from '../models/queue.types';
import { AIProvider } from '../../../core/models/ai-config.types';
import { collapseFilenameDots } from '../../../core/utils/filename-utils';
import { StudioService } from '../../studio/services/studio.service';
import { SettingsService } from '../../../core/services/settings.service';
import { RuntimeService } from '../../../core/services/runtime.service';

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
          testMode?: boolean;
          testModeChunks?: number;
          simplifyForLearning?: boolean;
          cleanupPrompt?: string;
          customInstructions?: string;
        }) => Promise<{ success: boolean; data?: any; error?: string }>;
        runTtsConversion: (jobId: string, epubPath: string, config: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        runTranslation: (jobId: string, epubPath: string, translationConfig: any, aiConfig?: AIProviderConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
        runBookAnalysis: (jobId: string, source: BookAnalysisConfig['source'], aiConfig: AIProviderConfig & {
          categories: Array<{ id: string; name: string; description: string; color: string; enabled: boolean }>;
          testMode?: boolean;
          testModeChunks?: number;
        }) => Promise<{ success: boolean; data?: any; error?: string }>;
        cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
        saveState: (queueState: string) => Promise<{ success: boolean; error?: string }>;
        loadState: () => Promise<{ success: boolean; data?: any; error?: string }>;
        onProgress: (callback: (progress: QueueProgress) => void) => () => void;
        onComplete: (callback: (result: JobResult) => void) => () => void;
        onRemoteControl: (callback: (action: 'start' | 'pause') => void) => () => void;
      };
      parallelTts?: {
        detectRecommendedWorkerCount: () => Promise<{ success: boolean; data?: { count: number; reason: string }; error?: string }>;
        startConversion: (jobId: string, config: any) => Promise<{ success: boolean; data?: any; error?: string }>;
        stopConversion: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
        getProgress: (jobId: string) => Promise<{ success: boolean; data?: ParallelAggregatedProgress | null; error?: string }>;
        isActive: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
        listActive: () => Promise<{ success: boolean; data?: Array<{ jobId: string; progress: ParallelAggregatedProgress; epubPath: string; startTime: number }>; error?: string }>;
        onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => () => void;
        onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; rvcAnalytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string }; sessionId?: string; sessionDir?: string }) => void) => () => void;
        // Session tracking for stop/resume
        onSessionCreated: (callback: (data: { jobId: string; sessionId: string; sessionDir: string; processDir: string; totalSentences: number; totalChapters: number }) => void) => () => void;
        // Resume support
        checkResumeFast: (epubPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
        checkResumeFromDir: (processDir: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
        checkResume: (sessionPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
        resumeConversion: (jobId: string, config: any, resumeInfo: ResumeCheckResult) => Promise<{ success: boolean; data?: any; error?: string }>;
        buildResumeInfo: (prepInfo: any, settings: any) => Promise<{ success: boolean; data?: TtsResumeInfo; error?: string }>;
      };
      sessionCache?: {
        scanProject: (projectDir: string) => Promise<{ success: boolean; sessions?: Array<{ language: string; sessionDir: string; sentencesDir: string; sentenceCount: number; createdAt: string }>; error?: string }>;
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
        deleteDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
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
          rvcEnhancement?: { voiceId: string; indexRate?: number; protectRate?: number; nSemitones?: number };
          sentencesDir?: string;
          finalDenoise?: boolean;
          applyDeRing?: boolean;
          sentenceGap?: number;
        }) => Promise<{ success: boolean; data?: { outputPath?: string }; error?: string }>;
        onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
      };
      rvc?: {
        startEnhancement: (jobId: string, config: {
          sessionId: string;
          sessionDir: string;
          processDir: string;
          voiceId: string;
          indexRate?: number;
          protectRate?: number;
          nSemitones?: number;
          finalDenoise?: boolean;
        }) => Promise<{ success: boolean; data?: { scratchDir?: string }; error?: string; wasStopped?: boolean }>;
        stopEnhancement: (jobId: string) => Promise<{ success: boolean; error?: string }>;
        onProgress: (callback: (data: { jobId: string; progress: { phase: string; percentage: number; processed?: number; total?: number; message?: string; error?: string } }) => void) => () => void;
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
          customInstructions?: string;
          simplifyForLearning?: boolean;
          simplifyMode?: 'dejargon' | 'destiffen' | 'learner' | 'learning' | 'plain';
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
          customInstructions?: string;
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
  private readonly runtimeService = inject(RuntimeService);

  // Progress listener cleanup
  private unsubscribeProgress: (() => void) | null = null;
  private unsubscribeComplete: (() => void) | null = null;
  private unsubscribeParallelProgress: (() => void) | null = null;
  private unsubscribeParallelComplete: (() => void) | null = null;
  private unsubscribeParallelSessionCreated: (() => void) | null = null;
  private unsubscribeReassemblyProgress: (() => void) | null = null;
  private unsubscribeRvcProgress: (() => void) | null = null;
  private unsubscribeLanguageLearningProgress: (() => void) | null = null;
  private unsubscribeLLJobProgress: (() => void) | null = null;
  private unsubscribeRemoteControl: (() => void) | null = null;

  // Scratch dir of enhanced sentences produced by an 'rvc-enhancement' job,
  // keyed by workflowId, consumed by the downstream reassembly job in the same
  // workflow (injected as config.sentencesDir). Cleared once consumed.
  private readonly rvcScratchByWorkflow = new Map<string, string>();

  // State signals
  private readonly _jobs = signal<QueueJob[]>([]);
  private readonly _isRunning = signal<boolean>(false); // Don't auto-run - user starts manually
  private readonly _currentJobId = signal<string | null>(null); // Queue-driven job in the EXCLUSIVE (GPU/CPU/local) lane
  private readonly _currentCloudJobId = signal<string | null>(null); // Queue-driven job in the CLOUD lane (Claude/OpenAI network jobs)
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
  readonly currentCloudJobId = computed(() => this._currentCloudJobId());
  readonly standaloneJobIds = computed(() => this._standaloneJobIds());
  readonly lastCompletedJobWithAnalytics = computed(() => this._lastCompletedJobWithAnalytics());

  // Check if any job is currently running (either lane or standalone)
  readonly hasActiveJobs = computed(() =>
    this._currentJobId() !== null || this._currentCloudJobId() !== null || this._standaloneJobIds().size > 0
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

  getChildJobs(masterJobId: string): QueueJob[] {
    return this._jobs().filter(j => j.parentJobId === masterJobId);
  }

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

    // Resume the queue once the bundled runtime finishes its first-run unpack.
    // processNext() bails out while the runtime is preparing (see guard there),
    // so a job queued during setup — or a remote start from the bookshelf —
    // would otherwise sit until the next completion event nudged the queue.
    effect(() => {
      if (this.runtimeService.ready() && this._isRunning()) {
        this.processNext();
      }
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
      if (this.unsubscribeRvcProgress) {
        this.unsubscribeRvcProgress();
      }
      if (this.unsubscribeLanguageLearningProgress) {
        this.unsubscribeLanguageLearningProgress();
      }
      if (this.unsubscribeLLJobProgress) {
        this.unsubscribeLLJobProgress();
      }
      if (this.unsubscribeRemoteControl) {
        this.unsubscribeRemoteControl();
      }
      this.stopMasterEtaTimer();
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

    // Listen for remote control commands from library web UI
    this.unsubscribeRemoteControl = electron.queue.onRemoteControl((action: 'start' | 'pause') => {
      this.ngZone.run(() => {
        if (action === 'start') {
          this.startQueue();
        } else if (action === 'pause') {
          this.pauseQueue();
        }
      });
    });

    // Listen for parallel TTS progress updates (rAF-coalesced)
    if (electron.parallelTts) {
      let pendingParallelData: any = null;
      let parallelRaf: number | null = null;
      this.unsubscribeParallelProgress = electron.parallelTts.onProgress((data) => {
        // Always process completion/error immediately (same pattern as reassembly)
        if (data.progress?.phase === 'complete' || data.progress?.phase === 'error') {
          // Clear pending RAF data so a stale progress event doesn't overwrite completion
          pendingParallelData = null;
          this.ngZone.run(() => this.handleParallelProgressUpdate(data.jobId, data.progress));
          return;
        }
        pendingParallelData = data;
        if (!parallelRaf) {
          parallelRaf = requestAnimationFrame(() => {
            parallelRaf = null;
            if (pendingParallelData) {
              const d = pendingParallelData;
              pendingParallelData = null;
              this.ngZone.run(() => this.handleParallelProgressUpdate(d.jobId, d.progress));
            }
          });
        }
      });

      this.unsubscribeParallelComplete = electron.parallelTts.onComplete((data) => {
        // Clear any pending progress RAF so it can't overwrite the completion status
        pendingParallelData = null;
        this.ngZone.run(async () => {
          await this.handleJobComplete({
            jobId: data.jobId,
            success: data.success,
            outputPath: data.outputPath,
            error: data.error,
            analytics: data.analytics,
            rvcAnalytics: (data as any).rvcAnalytics,
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

    // Listen for reassembly progress updates.
    // Coalesce with rAF so at most one ngZone.run per frame — prevents
    // change detection storms when the renderer is loading heavy components.
    if (electron.reassembly) {
      let pendingReassemblyData: any = null;
      let reassemblyRaf: number | null = null;
      this.unsubscribeReassemblyProgress = electron.reassembly.onProgress((data) => {
        // Always process completion/error immediately
        if (data.progress?.phase === 'complete' || data.progress?.phase === 'error') {
          // Clear any pending RAF data so a stale progress event doesn't overwrite completion
          pendingReassemblyData = null;
          this.ngZone.run(() => this.handleReassemblyProgressUpdate(data.jobId, data.progress));
          return;
        }
        pendingReassemblyData = data;
        if (!reassemblyRaf) {
          reassemblyRaf = requestAnimationFrame(() => {
            reassemblyRaf = null;
            if (pendingReassemblyData) {
              const d = pendingReassemblyData;
              pendingReassemblyData = null;
              this.ngZone.run(() => this.handleReassemblyProgressUpdate(d.jobId, d.progress));
            }
          });
        }
      });
    }

    // Listen for RVC enhancement progress (rAF-coalesced). Maps per-sentence
    // progress to the job's chunk fields so the queue UI shows a real ETA, the
    // same way TTS does.
    if (electron.rvc) {
      let pendingRvcData: any = null;
      let rvcRaf: number | null = null;
      this.unsubscribeRvcProgress = electron.rvc.onProgress((data) => {
        if (data.progress?.phase === 'complete' || data.progress?.phase === 'error') {
          pendingRvcData = null;
          this.ngZone.run(() => this.handleRvcProgressUpdate(data.jobId, data.progress));
          return;
        }
        pendingRvcData = data;
        if (!rvcRaf) {
          rvcRaf = requestAnimationFrame(() => {
            rvcRaf = null;
            if (pendingRvcData) {
              const d = pendingRvcData;
              pendingRvcData = null;
              this.ngZone.run(() => this.handleRvcProgressUpdate(d.jobId, d.progress));
            }
          });
        }
      });
    }

    // Listen for language learning progress updates
    if (electron.languageLearning) {
      let pendingLLData: any = null;
      let llRaf: number | null = null;
      this.unsubscribeLanguageLearningProgress = electron.languageLearning.onProgress((data) => {
        if (data.progress?.phase === 'complete' || data.progress?.phase === 'error') {
          pendingLLData = null;
          this.ngZone.run(() => this.handleLanguageLearningProgressUpdate(data.jobId, data.progress));
          return;
        }
        pendingLLData = data;
        if (!llRaf) {
          llRaf = requestAnimationFrame(() => {
            llRaf = null;
            if (pendingLLData) {
              const d = pendingLLData;
              pendingLLData = null;
              this.ngZone.run(() => this.handleLanguageLearningProgressUpdate(d.jobId, d.progress));
            }
          });
        }
      });
    }

    // Listen for LL split pipeline job progress (cleanup + translation, rAF-coalesced)
    if (electron.bilingualCleanup) {
      let pendingLLJobData: any = null;
      let llJobRaf: number | null = null;
      this.unsubscribeLLJobProgress = electron.bilingualCleanup.onProgress((data) => {
        if (data.progress?.phase === 'complete' || data.progress?.phase === 'error') {
          // Clear any pending RAF data so a stale progress event can't overwrite completion
          pendingLLJobData = null;
          this.ngZone.run(() => this.handleLLJobProgressUpdate(data.jobId, data.progress));
          return;
        }
        pendingLLJobData = data;
        if (!llJobRaf) {
          llJobRaf = requestAnimationFrame(() => {
            llJobRaf = null;
            if (pendingLLJobData) {
              const d = pendingLLJobData;
              pendingLLJobData = null;
              this.ngZone.run(() => this.handleLLJobProgressUpdate(d.jobId, d.progress));
            }
          });
        }
      });
    }
  }

  private handleLLJobProgressUpdate(jobId: string, progress: any): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        // Don't overwrite terminal statuses — runJob/handleJobComplete may have
        // already marked this job complete before this RAF-coalesced update fires.
        // Without this, a late "saving 95%" event reverts a finished translation
        // to 'processing', which then blocks its reassembly sibling forever.
        if (job.status === 'complete' || job.status === 'error') return job;

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

  /**
   * RVC enhancement progress → job fields. Maps processed/total to the chunk
   * fields the UI's chunk-rate ETA reads (chunksCompletedInJob/totalChunksInJob/
   * chunksDoneInSession/chunkCompletedAt), so the RVC job shows a real ETA and a
   * "Chunks X/Y" stat exactly like TTS — no bridge-side ETA math needed.
   */
  private handleRvcProgressUpdate(
    jobId: string,
    progress: { phase: string; percentage: number; processed?: number; total?: number; message?: string; error?: string }
  ): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;
        if (job.status === 'complete' || job.status === 'error') return job;

        const processed = progress.processed ?? 0;
        const total = progress.total ?? job.totalChunksInJob ?? 0;
        const prev = job.chunksCompletedInJob ?? 0;
        return {
          ...job,
          status: 'processing' as JobStatus,
          progress: progress.percentage,
          progressMessage: progress.message,
          chunksCompletedInJob: processed,
          totalChunksInJob: total,
          chunksDoneInSession: processed,
          chunkCompletedAt: processed > prev ? Date.now() : job.chunkCompletedAt,
          error: progress.error,
        };
      })
    );
    this.bubbleProgressToMaster(jobId);
  }

  private handleReassemblyProgressUpdate(jobId: string, progress: any): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        // Don't overwrite terminal statuses — handleJobComplete may have already
        // marked this job as complete/error before this RAF-coalesced update fires
        if (job.status === 'complete' || job.status === 'error') return job;

        return {
          ...job,
          progress: progress.percentage || 0,
          status: progress.phase === 'complete' ? 'complete' as JobStatus :
                  progress.phase === 'error' ? 'error' as JobStatus :
                  'processing' as JobStatus,
          // Only update chapter fields when actually sent — encoding phase omits them
          currentChapter: progress.currentChapter ?? job.currentChapter,
          totalChapters: progress.totalChapters ?? job.totalChapters,
          progressMessage: progress.message || progress.phase,
          error: progress.error
        };
      })
    );
    this.bubbleProgressToMaster(jobId);
  }

  private handleLanguageLearningProgressUpdate(jobId: string, progress: any): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        // Don't overwrite terminal statuses — handleJobComplete may have already
        // marked this job as complete/error before this RAF-coalesced update fires
        if (job.status === 'complete' || job.status === 'error') return job;

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
    this.bubbleProgressToMaster(jobId);
  }

  private handleProgressUpdate(progress: QueueProgress): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== progress.jobId) return job;

        // Don't overwrite terminal statuses — handleJobComplete may have already
        // marked this job as complete/error before this RAF-coalesced update fires
        if (job.status === 'complete' || job.status === 'error') return job;

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
          // Nullish (not ||): a legit session count of 0 (first emit after resume) must
          // NOT collapse to the cumulative chunksCompletedInJob, or speed/ETA would divide
          // prior-session chunks by this-session elapsed → a huge phantom rate at startup.
          chunksDoneInSession: progress.completedInSession ?? progress.chunksCompletedInJob,
          progressMessage: progress.message,
          // Backend phase drives the phase-1 (analyzing) UI on the mono cleanup path.
          cleanupPhase: progress.phase as QueueJob['cleanupPhase']
        };
      })
    );
    this.bubbleProgressToMaster(progress.jobId);
  }

  private handleParallelProgressUpdate(jobId: string, progress: ParallelAggregatedProgress): void {
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== jobId) return job;

        // Don't overwrite terminal statuses — handleJobComplete may have already
        // marked this job as complete/error before this RAF-coalesced update fires
        if (job.status === 'complete' || job.status === 'error') return job;

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
          const n = progress.activeWorkers;
          const workerWord = n === 1 ? 'worker' : 'workers';
          if (job.isResumeJob) {
            progressMessage = `Resuming: ${n} ${workerWord} (${displayCompleted}/${displayTotal} chunks)`;
          } else {
            progressMessage = `${n} ${workerWord} active (${displayCompleted}/${displayTotal} chunks)`;
          }
        }

        // Calculate TTS conversion progress (before assembly)
        const ttsConversionProgress = displayTotal > 0
          ? Math.min(100, Math.round((displayCompleted / displayTotal) * 100))
          : 0;

        return {
          ...job,
          progress: displayProgress,
          // Completion is finalized ONLY by handleJobComplete — the authoritative
          // path that caches the session, releases the exclusive lane, and chains
          // the reassembly job. emitComplete() (parallel-tts-bridge) fires this
          // progress 'complete' event immediately BEFORE 'parallel-tts:complete';
          // if we set status 'complete' here and it wins the race, handleJobComplete
          // sees an already-terminal job, takes its double-processing guard, and
          // never clears the lane — the exclusive lane stays pinned to the finished
          // TTS job and the pending reassembly never starts (the queue freezes).
          // So only surface a terminal ERROR here (errors don't chain); leave the
          // 'complete' transition to handleJobComplete, which always runs next.
          status: progress.phase === 'error' ? 'error' as JobStatus : 'processing' as JobStatus,
          error: progress.error ?? job.error,
          progressMessage,
          // Map parallel progress to ETA calculation fields
          chunksCompletedInJob: displayCompleted,
          totalChunksInJob: displayTotal,
          // Real sentence total (chunks pack 2-3 sentences) — for a true sentences/min
          // readout. Set once from prep; persists across progress ticks.
          totalRawSentencesInJob: (progress as any).totalRawSentences ?? job.totalRawSentencesInJob,
          // EXACT real sentences rendered this session (backend summed per-chunk counts) —
          // for a precise sentences/min. Absent on old sessions → estimate used instead.
          rawSentencesDoneInSession: (progress as any).rawCompletedInSession ?? job.rawSentencesDoneInSession,
          chunkCompletedAt: displayCompleted > (job.chunksCompletedInJob || 0) ? Date.now() : job.chunkCompletedAt,
          // Session-specific progress for accurate ETA (especially for resume jobs).
          // Nullish (not ||): a legit session count of 0 must not collapse to the
          // cumulative displayCompleted, or the rate spikes at resume startup.
          chunksDoneInSession: (progress as any).completedInSession ?? displayCompleted,
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
          assemblySubPhase: (progress as any).assemblySubPhase,
          // Orpheus memory level badge (sticky: keep the last non-empty value).
          orpheusMemoryLevel: (progress as any).orpheusMemoryLevel || job.orpheusMemoryLevel
        };
      })
    );
    this.bubbleProgressToMaster(jobId);
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
    _bfpPath: string,
    epubPath: string
  ): Promise<ResumeCheckResult | null> {
    const electron = window.electron as any;
    if (!electron?.parallelTts?.checkResumeFast) {
      console.log('[QUEUE] checkResumeFast not available');
      return null;
    }

    try {
      // Check for a resumable session using the epub path
      // This scans e2a's tmp/ folder for sessions matching this epub
      console.log(`[QUEUE] Checking for resumable session: ${epubPath}`);
      const result = await electron.parallelTts.checkResumeFast(epubPath);

      if (result.success && result.data?.success) {
        const resumeData = result.data;

        // Only auto-resume if there's actual progress (not starting fresh)
        if (resumeData.completedSentences && resumeData.completedSentences > 0) {
          console.log(`[QUEUE] Found resumable session: ${resumeData.completedSentences}/${resumeData.totalSentences} sentences, sessionId=${resumeData.sessionId}`);
          return resumeData;
        }
        console.log(`[QUEUE] Session found but no progress (${resumeData.completedSentences} sentences)`);
      } else {
        console.log(`[QUEUE] No resumable session found: ipcSuccess=${result.success}, dataSuccess=${result.data?.success}, error=${result.data?.error || result.error || 'none'}`);
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

  /**
   * When a job fails, cancel every still-pending job in the same workflow so
   * downstream steps (translation, TTS, reassembly, assembly, video) never run on
   * missing or unclean input. Called from BOTH failure paths: handleJobComplete
   * (job types that finish via a result) and runJob's catch (job types that report
   * failure by throwing — rvc-enhancement, reassembly, bilingual-*, video-assembly,
   * generate-sentences). Before this was extracted, only the former cancelled
   * siblings, so a thrown failure left downstream jobs pending and the master
   * workflow spinning forever.
   */
  private cancelPendingWorkflowJobs(failedJob: QueueJob): void {
    if (!failedJob.workflowId) return;
    const failedType = failedJob.type;
    const workflowId = failedJob.workflowId;
    const pendingInWorkflow = this._jobs().filter(j =>
      j.workflowId === workflowId &&
      j.status === 'pending' &&
      j.id !== failedJob.id
    );
    if (pendingInWorkflow.length === 0) return;
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

  private async handleJobComplete(result: JobResult): Promise<void> {
    console.log(`[QUEUE] handleJobComplete called for job ${result.jobId}, success=${result.success}, wasStopped=${result.wasStopped}`);
    console.log(`[QUEUE] Current state: isRunning=${this._isRunning()}, currentJobId=${this._currentJobId()}`);

    // Get the job before updating to capture the type
    const completedJob = this._jobs().find(j => j.id === result.jobId);
    console.log('[QUEUE] Found completed job:', completedJob ? `type=${completedJob.type}, id=${completedJob.id}, status=${completedJob.status}` : 'NOT FOUND');

    // Guard against double-processing (status-based, for non-race cases like retries).
    // Still try to advance the queue — the first caller may not have reached processNext()
    // yet (e.g., if it's awaiting a slow IPC call like updatePipeline).
    if (completedJob && (completedJob.status === 'complete' || completedJob.status === 'error')) {
      console.log(`[QUEUE] handleJobComplete: job ${result.jobId} already ${completedJob.status}, skipping processing`);
      // A progress-phase handler (handleParallelProgressUpdate / handleReassemblyProgressUpdate /
      // handleLanguageLearningProgressUpdate) can mark a job terminal from a 'complete'/'error'
      // progress event that lands just before this authoritative completion — but those handlers
      // do NOT release the lane. If this finished job still holds a lane, clear it here; otherwise
      // the safety-net processNext() below sees the lane busy and never starts the next sibling
      // (e.g. reassembly), freezing the queue until app restart.
      if (this._currentJobId() === result.jobId || this._currentCloudJobId() === result.jobId) {
        this.clearRunningJob(result.jobId);
        console.log(`[QUEUE] handleJobComplete: released lane still held by already-${completedJob.status} job ${result.jobId}`);
      }
      // Safety net: ensure the queue advances even if the first caller hasn't reached processNext yet.
      // processNext() is idempotent and lane-aware — it fills whichever lane is free.
      if (this._isRunning()) {
        console.log(`[QUEUE] handleJobComplete: safety-net processNext for already-completed job`);
        this.processNext();
      }
      return;
    }

    // Determine the final status:
    // - success=true -> 'complete'
    // - wasStopped=true -> 'stopped' (stays in queue with its cached progress, but is
    //   NEVER auto-picked by processNext — an explicit Start/▶ resumes it. The old
    //   'pending' value made processNext re-pick the job in the same tick, spawning a
    //   new GPU worker while the stopped one was still dying — the WSL wedge trigger.)
    // - otherwise -> 'error'
    let finalStatus: JobStatus = result.success ? 'complete' : 'error';
    if (result.wasStopped) {
      finalStatus = 'stopped';
      console.log(`[QUEUE] Job ${result.jobId} was stopped by the user - setting status to 'stopped' (resume requires explicit Start)`);
      // A user stop idles the WHOLE queue (you stop a GPU job to get the GPU/memory
      // back — auto-starting the next job would defeat the purpose). This also covers
      // stop paths that don't go through cancelJob() (e.g. main-process initiated).
      this._isRunning.set(false);
    }

    // Update the job status
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== result.jobId) return job;
        return {
          ...job,
          status: finalStatus,
          error: result.wasStopped ? undefined : result.error, // Clear error for stopped jobs
          // Mark stopped jobs so TTS auto-resumes instead of starting fresh
          wasInterrupted: result.wasStopped ? true : job.wasInterrupted,
          progress: result.success ? 100 : job.progress,
          completedAt: result.success ? new Date() : job.completedAt,
          outputPath: result.outputPath || job.outputPath,
          // Copyright detection for AI cleanup jobs
          copyrightIssuesDetected: result.copyrightIssuesDetected,
          copyrightChunksAffected: result.copyrightChunksAffected,
          // Content skips detection for AI cleanup jobs
          contentSkipsDetected: result.contentSkipsDetected,
          contentSkipsAffected: result.contentSkipsAffected,
          // Translation chunks that failed and kept original (untranslated) text
          translationFailedChunks: result.translationFailedChunks,
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

    // If any job in a workflow fails, cancel all remaining pending jobs in the same
    // workflow so downstream steps don't run on missing/unclean input.
    if (!result.success && !result.wasStopped && completedJob) {
      this.cancelPendingWorkflowJobs(completedJob);
    }

    // Save analytics to the project folder (no longer using signal/effect pattern to avoid duplicates)
    if (result.analytics && completedJob?.bfpPath) {
      this.saveProjectAnalytics(
        completedJob.bfpPath,
        completedJob.type,
        result.analytics
      );
    }

    // RVC enhancement runs as a sub-pass of the TTS job, so it arrives on the
    // same completion event but is persisted as its own 'rvc' analytics entry.
    if (result.rvcAnalytics && completedJob?.bfpPath) {
      this.saveProjectAnalytics(
        completedJob.bfpPath,
        'rvc',
        result.rvcAnalytics
      );
    }

    // Post-completion tasks (session caching, audio linking, bilingual chaining).
    // Wrapped in try/catch to guarantee processNext() runs even if something here fails.
    try {

    // Embed-only: the TTS/reassembly bridges seal the transcript INTO the m4b, so
    // there is no sidecar to copy here (copying one was the anti-pattern we removed).

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

    // Write pipeline.cleanup status to manifest after AI cleanup completes.
    // Fire-and-forget: don't await, so this can't block queue advancement.
    if (result.success && completedJob?.type === 'ocr-cleanup' && completedJob.bfpPath) {
      const electron = (window as any).electron;
      if (electron?.audiobook?.updatePipeline) {
        const projectId = completedJob.bfpPath.replace(/\\/g, '/').split('/').pop();
        if (projectId) {
          const outputRelPath = result.outputPath
            ? 'stages/01-cleanup/' + result.outputPath.replace(/\\/g, '/').split('/').pop()
            : undefined;
          console.log(`[QUEUE] Writing pipeline.cleanup to manifest for project: ${projectId}`);
          electron.audiobook.updatePipeline(projectId, {
            cleanup: {
              status: 'complete',
              outputPath: outputRelPath,
              completedAt: new Date().toISOString(),
            }
          }).catch((err: Error) => {
            console.error('[QUEUE] Failed to write pipeline.cleanup to manifest:', err);
          });
        }
      }
    }

    // Cache TTS session to project's stages/03-tts/sessions/{lang}/ directory
    // Both standard and LL pipelines use the same location for consistency
    if (result.success && result.sessionDir && completedJob?.type === 'tts-conversion') {
      const ttsConfig = completedJob.config as TtsConversionConfig;
      const projectDir = completedJob.bfpPath || completedJob.projectDir;
      const language = ttsConfig?.language || 'en';

      if (projectDir) {
        try {
          const electron = (window as any).electron;
          if (electron?.sessionCache?.saveToProject) {
            console.log(`[QUEUE] Caching TTS session for ${language} to project: ${projectDir}`);
            const cacheResult = await electron.sessionCache.saveToProject(
              result.sessionDir, projectDir, language
            );
            if (cacheResult.success && cacheResult.cachedSentencesDir) {
              console.log(`[QUEUE] Session cached, sentences at: ${cacheResult.cachedSentencesDir}`);
              // Update outputPath to cached location so chaining handler uses persistent paths
              result.outputPath = cacheResult.cachedSentencesDir;
              // Also update the job's stored outputPath so queue state reflects the
              // persistent cached path instead of the ephemeral e2a tmp path
              this._jobs.update(jobs =>
                jobs.map(j => j.id === result.jobId ? { ...j, outputPath: cacheResult.cachedSentencesDir } : j)
              );
            } else {
              console.error('[QUEUE] Failed to cache session:', cacheResult.error);
            }
          }
        } catch (err) {
          console.error('[QUEUE] Error caching TTS session:', err);
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
            // MUST throw, not return: a bare `return` here exits handleJobComplete
            // from inside the post-completion try (line ~1079) and skips the tail
            // (clearRunningJob + processNext), leaving the exclusive lane holding
            // this finished job forever — the queue freezes until app restart. The
            // catch at ~1388 swallows this throw and lets the tail advance the queue.
            throw new Error(`Bilingual assembly aborted: ${label} sentences not found at ${dir}`);
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

    } catch (postCompletionErr) {
      console.error('[QUEUE] Error in post-completion tasks (session caching, linking, chaining):', postCompletionErr);
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

    // Clear the completed job from whichever lane held it (may already be cleared
    // or reassigned to the next job in that lane).
    if (this._currentJobId() === result.jobId || this._currentCloudJobId() === result.jobId) {
      this.clearRunningJob(result.jobId);
      console.log(`[QUEUE] Cleared lane for completed job ${result.jobId}`);
    } else {
      console.log(`[QUEUE] Job ${result.jobId} completed, lanes are exclusive=${this._currentJobId()} cloud=${this._currentCloudJobId()} (already advanced or cleared)`);
    }

    // ALWAYS try to advance the queue. processNext() is idempotent — returns
    // immediately if a job is already running. This ensures the queue advances
    // even when _currentJobId was already cleared/reassigned by the safety net
    // (e.g., TTS completion where session caching delays handleJobComplete).
    if (this._isRunning()) {
      console.log(`[QUEUE] Job ${result.jobId} completed, calling processNext`);
      this.processNext();
    } else {
      console.log(`[QUEUE] Job ${result.jobId} completed but queue is paused, not processing next`);
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

    this._jobs.update(jobs => {
      // Child jobs: insert right after master + existing siblings to keep groups together
      if (job.parentJobId) {
        const newJobs = [...jobs];
        // Find the last index occupied by the master or any sibling
        let insertAfter = -1;
        for (let i = 0; i < newJobs.length; i++) {
          if (newJobs[i].id === job.parentJobId || newJobs[i].parentJobId === job.parentJobId) {
            insertAfter = i;
          }
        }
        if (insertAfter >= 0) {
          newJobs.splice(insertAfter + 1, 0, job);
          return newJobs;
        }
      }
      return [...jobs, job];
    });

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

    const electron = window.electron;
    const isMasterJob = job.workflowId && !job.parentJobId;

    if (isMasterJob && electron?.queue) {
      // Cancel ALL processing children by their own IDs (not the master's)
      const children = this._jobs().filter(j => j.workflowId === job.workflowId && j.id !== jobId);
      for (const child of children) {
        if (child.status === 'processing') {
          await electron.queue.cancelJob(child.id);
        }
      }
    }

    // Cancel this specific job if it's processing
    if (job.status === 'processing' && electron?.queue) {
      await electron.queue.cancelJob(jobId);
    }

    // Clear either lane if a removed job was running in it
    if (isMasterJob) {
      const workflowJobs = this._jobs().filter(j => j.workflowId === job.workflowId);
      for (const wj of workflowJobs) this.clearRunningJob(wj.id);
      // Remove master and all children
      this._jobs.update(jobs => jobs.filter(j =>
        j.id !== jobId && j.workflowId !== job.workflowId
      ));
    } else {
      this.clearRunningJob(jobId);
      this._jobs.update(jobs => jobs.filter(j => j.id !== jobId));
    }

    // Clean up any resulting orphans (e.g. master with no children left)
    this.cleanupOrphanedSubItems();

    // Resume queue if it was running
    if (this._isRunning()) {
      await this.processNext();
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
   * Normalize job array so child jobs are always grouped after their master.
   * Fixes legacy state where children could be scattered in the array.
   */
  private normalizeJobGrouping(): void {
    const jobs = this._jobs();
    // Build a map: masterJobId -> child jobs (in their current order)
    const childrenOf = new Map<string, QueueJob[]>();
    const topLevel: QueueJob[] = [];

    for (const j of jobs) {
      if (j.parentJobId) {
        const siblings = childrenOf.get(j.parentJobId) || [];
        siblings.push(j);
        childrenOf.set(j.parentJobId, siblings);
      } else {
        topLevel.push(j);
      }
    }

    // Rebuild: for each top-level job, append its children right after it
    const normalized: QueueJob[] = [];
    for (const j of topLevel) {
      normalized.push(j);
      const children = childrenOf.get(j.id);
      if (children) {
        normalized.push(...children);
        childrenOf.delete(j.id);
      }
    }

    // Append any orphaned children (master not found) — cleanupOrphanedSubItems will handle them
    for (const orphans of childrenOf.values()) {
      normalized.push(...orphans);
    }

    if (normalized.length === jobs.length) {
      this._jobs.set(normalized);
    }
  }

  /**
   * Clean up orphaned sub-items (sub-items whose master job doesn't exist)
   * This can happen if the app crashes or if there's a bug in job removal
   */
  private cleanupOrphanedSubItems(): void {
    const jobs = this._jobs();
    const jobIds = new Set(jobs.map(j => j.id));

    // Find sub-items whose parentJobId doesn't exist in the queue
    const orphanedChildIds = jobs
      .filter(j => j.parentJobId && !jobIds.has(j.parentJobId))
      .map(j => j.id);

    // Find orphaned masters (masters with no remaining children)
    const orphanedMasterIds = jobs
      .filter(j => j.workflowId && !j.parentJobId)
      .filter(master => !jobs.some(j => j.parentJobId === master.id))
      .map(j => j.id);

    const allOrphanedIds = [...orphanedChildIds, ...orphanedMasterIds];

    if (allOrphanedIds.length > 0) {
      console.log(`[QUEUE] Removing ${allOrphanedIds.length} orphaned jobs (${orphanedChildIds.length} children, ${orphanedMasterIds.length} masters):`, allOrphanedIds);
      this._jobs.update(jobs => jobs.filter(j => !allOrphanedIds.includes(j.id)));
    }
  }

  /**
   * Bubble a child job's progress to its master job.
   * Called from progress handlers so the master bar tracks the active child.
   * Throttled to avoid excessive signal updates (progress fires frequently).
   */
  private _lastMasterBubbleTime = 0;
  private _pendingMasterBubble: ReturnType<typeof setTimeout> | null = null;
  private bubbleProgressToMaster(childJobId: string): void {
    const child = this._jobs().find(j => j.id === childJobId);
    if (!child?.parentJobId || !child.workflowId) return;

    const now = Date.now();
    const workflowId = child.workflowId;
    const masterJobId = child.parentJobId;

    // Throttle: update master at most every 500ms
    if (now - this._lastMasterBubbleTime >= 500) {
      this._lastMasterBubbleTime = now;
      if (this._pendingMasterBubble) {
        clearTimeout(this._pendingMasterBubble);
        this._pendingMasterBubble = null;
      }
      this.updateMasterJobProgress(workflowId, masterJobId);
    } else if (!this._pendingMasterBubble) {
      // Schedule a trailing update so we don't miss the last progress value
      this._pendingMasterBubble = setTimeout(() => {
        this._pendingMasterBubble = null;
        this._lastMasterBubbleTime = Date.now();
        this.updateMasterJobProgress(workflowId, masterJobId);
      }, 500);
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

    // Calculate progress factoring in the active child's progress.
    // e.g. 3 steps, 1 done, 1 at 50% → (1 + 0.5) / 3 = 50%
    const processingChild = childJobs.find(j => j.status === 'processing');
    // For TTS jobs, calculate progress from chunks (step.progress can be 0 during conversion)
    let childProgress = processingChild?.progress || 0;
    if (processingChild?.type === 'tts-conversion' && processingChild.totalChunksInJob) {
      const chunkPct = ((processingChild.chunksCompletedInJob || 0) / processingChild.totalChunksInJob) * 100;
      childProgress = Math.max(childProgress, chunkPct);
    }
    const processingFraction = processingChild ? childProgress / 100 : 0;
    const progress = Math.round(((completedChildren + processingFraction) / totalChildren) * 100);

    // Determine master job status
    const stoppedChildren = childJobs.filter(j => j.status === 'stopped').length;
    let masterStatus: JobStatus = 'processing';
    if (completedChildren + errorChildren === totalChildren) {
      // All children finished - master is complete (or error if any child errored)
      masterStatus = errorChildren > 0 ? 'error' : 'complete';
    } else if (stoppedChildren > 0 && !processingChild) {
      // A child was explicitly stopped and nothing is running — the workflow is
      // stopped, not processing. Start/▶ flips stopped → pending and revives it.
      masterStatus = 'stopped';
    }

    // Calculate master ETA from child job estimates
    const estimatedSecondsRemaining = this.computeMasterEta(childJobs);

    // Update master job
    this._jobs.update(jobs =>
      jobs.map(job => {
        if (job.id !== masterJobId) return job;
        return {
          ...job,
          status: masterStatus,
          progress,
          estimatedSecondsRemaining: masterStatus === 'complete' ? undefined : estimatedSecondsRemaining,
          // Show progress message
          progressMessage: `${completedChildren}/${totalChildren} steps complete`,
          completedAt: masterStatus === 'complete' ? new Date() : job.completedAt,
          error: masterStatus === 'error' ? 'One or more steps failed' : undefined
        };
      })
    );

    console.log(`[QUEUE] Master job ${masterJobId} progress: ${completedChildren}/${totalChildren} (${progress}%)` +
      (estimatedSecondsRemaining !== undefined ? `, ETA: ${estimatedSecondsRemaining}s` : ''));

    // Start/stop periodic ETA refresh timer based on workflow state
    if (masterStatus === 'processing') {
      this.startMasterEtaTimer(workflowId, masterJobId);
    } else {
      this.stopMasterEtaTimer();
    }
  }

  // --- Master ETA Timer ---
  private masterEtaTimerInterval: ReturnType<typeof setInterval> | null = null;

  private startMasterEtaTimer(workflowId: string, masterJobId: string): void {
    // Already running — don't start another
    if (this.masterEtaTimerInterval) return;

    this.masterEtaTimerInterval = setInterval(() => {
      this.ngZone.run(() => {
        // Check if master job still processing
        const masterJob = this._jobs().find(j => j.id === masterJobId);
        if (!masterJob || masterJob.status !== 'processing') {
          this.stopMasterEtaTimer();
          return;
        }
        // Recompute ETA
        this.updateMasterJobProgress(workflowId, masterJobId);
      });
    }, 15_000); // Every 15 seconds
  }

  private stopMasterEtaTimer(): void {
    if (this.masterEtaTimerInterval) {
      clearInterval(this.masterEtaTimerInterval);
      this.masterEtaTimerInterval = null;
    }
  }

  // --- Master ETA Computation ---

  /**
   * Compute the total estimated seconds remaining for a master/workflow job
   * by summing estimates for the currently-running child and all pending children.
   *
   * Uses actual completed sibling durations (inherently model/engine-aware since the
   * same workflow uses the same settings) and progress-based estimates for running children.
   */
  private computeMasterEta(childJobs: QueueJob[]): number | undefined {
    const runningChild = childJobs.find(j => j.status === 'processing');
    const pendingChildren = childJobs.filter(j => j.status === 'pending');
    const completedChildren = childJobs.filter(j => j.status === 'complete');

    // Need at least one running or pending child to estimate
    if (!runningChild && pendingChildren.length === 0) return undefined;

    let totalEta = 0;

    // Estimate remaining time for the currently-running child
    if (runningChild) {
      const runningEta = this.estimateRunningChildEta(runningChild);
      if (runningEta !== null) {
        totalEta += runningEta;
      } else {
        // Can't estimate running child — return undefined rather than misleading partial ETA
        return undefined;
      }
    }

    // Estimate duration for each pending child
    for (const pending of pendingChildren) {
      totalEta += this.estimatePendingChildDuration(pending, completedChildren, runningChild);
    }

    return Math.round(totalEta);
  }

  /**
   * Estimate remaining seconds for a currently-processing child job.
   * Uses the same logic as job-progress.component.ts but computed server-side.
   */
  private estimateRunningChildEta(job: QueueJob): number | null {
    const progress = job.progress || 0;
    if (progress <= 0 || !job.startedAt) return null;

    const elapsed = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
    if (elapsed < 10) return null;

    // For OCR/TTS jobs with chunk data, use chunk-based estimation (most accurate)
    const chunksCompleted = job.chunksCompletedInJob || 0;
    const totalChunks = job.totalChunksInJob || job.totalChunks || 0;
    // Nullish, not ||: a real session count of 0 must not collapse to the cumulative count.
    const chunksDoneInSession = job.chunksDoneInSession ?? chunksCompleted;

    if (chunksDoneInSession >= 2 && totalChunks > 0) {
      const avgTimePerChunk = elapsed / chunksDoneInSession;
      const remainingChunks = totalChunks - chunksCompleted;
      return remainingChunks * avgTimePerChunk;
    }

    // For progress-based estimation (reassembly, video-assembly, early-stage jobs)
    if (progress > 2) {
      const totalEstimate = elapsed / (progress / 100);
      const remaining = totalEstimate - elapsed;
      return remaining > 0 ? remaining : 0;
    }

    return null;
  }

  /**
   * Estimate the TOTAL duration for a pending child job.
   *
   * Strategy (in order of preference):
   * 1. Use completed sibling of the same type (same model/engine/settings by definition)
   * 2. Use type-based ratio relative to the longest completed sibling
   * 3. Use a percentage of the running child's estimated total duration
   */
  private estimatePendingChildDuration(
    pendingJob: QueueJob,
    completedChildren: QueueJob[],
    runningChild: QueueJob | undefined
  ): number {
    // 1. Check for completed sibling of the same type
    const sameSibling = completedChildren.find(c => c.type === pendingJob.type);
    if (sameSibling?.startedAt && sameSibling?.completedAt) {
      const duration = (new Date(sameSibling.completedAt).getTime() - new Date(sameSibling.startedAt).getTime()) / 1000;
      if (duration > 0) return duration;
    }

    // 2. Use type-based heuristic ratios relative to completed work
    // These ratios are empirically observed: reassembly and video-assembly are
    // orders of magnitude faster than TTS or cleanup
    const longestCompleted = this.getLongestCompletedDuration(completedChildren);
    if (longestCompleted > 0) {
      const ratio = this.getTypeSpeedRatio(pendingJob.type);
      return longestCompleted * ratio;
    }

    // 3. If nothing has completed but something is running, estimate from the running child
    if (runningChild?.startedAt && runningChild.progress && runningChild.progress > 5) {
      const runningElapsed = (Date.now() - new Date(runningChild.startedAt).getTime()) / 1000;
      const runningTotalEstimate = runningElapsed / (runningChild.progress / 100);
      const ratio = this.getTypeSpeedRatio(pendingJob.type);
      return runningTotalEstimate * ratio;
    }

    // No basis for estimation
    return 0;
  }

  /**
   * Get the duration of the longest completed child job.
   */
  private getLongestCompletedDuration(completedChildren: QueueJob[]): number {
    let longest = 0;
    for (const child of completedChildren) {
      if (child.startedAt && child.completedAt) {
        const dur = (new Date(child.completedAt).getTime() - new Date(child.startedAt).getTime()) / 1000;
        if (dur > longest) longest = dur;
      }
    }
    return longest;
  }

  /**
   * Get a speed ratio for a job type relative to the slowest step (TTS).
   * These represent how fast this step typically is relative to the slowest completed step.
   *
   * For example, reassembly typically takes ~3-5% of TTS duration.
   * These are rough heuristics used only when no completed sibling exists.
   */
  private getTypeSpeedRatio(jobType: JobType): number {
    switch (jobType) {
      case 'reassembly':        return 0.05;  // ~5% of TTS duration
      case 'rvc-enhancement':   return 0.40;  // RVC is per-sentence but faster than TTS
      case 'video-assembly':    return 0.10;  // ~10% of TTS duration
      case 'ocr-cleanup':       return 0.50;  // Comparable to TTS (depends on model)
      case 'tts-conversion':    return 1.00;  // Baseline
      default:                  return 0.20;  // Conservative default
    }
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
    const electron = window.electron;

    // Cancel the queue's current job(s) — both the exclusive and cloud lanes
    for (const currentId of [this._currentJobId(), this._currentCloudJobId()]) {
      if (currentId) {
        electron?.queue?.cancelJob(currentId);
        this.clearRunningJob(currentId);
      }
    }

    // Cancel any standalone jobs
    const standaloneIds = this._standaloneJobIds();
    if (standaloneIds.size > 0 && electron?.queue) {
      for (const id of standaloneIds) {
        electron.queue.cancelJob(id);
      }
      this._standaloneJobIds.set(new Set());
    }

    this._jobs.set([]);
    this._isRunning.set(false);
    console.log('[QUEUE] All jobs cleared');
  }

  /**
   * Retry a failed or completed job.
   * For workflow (master) jobs, only resets non-complete children — subtasks that
   * already succeeded are left alone.
   */
  async retryJob(jobId: string): Promise<boolean> {
    const job = this._jobs().find(j => j.id === jobId);
    if (!job || (job.status !== 'error' && job.status !== 'complete')) return false;

    // A "master" job is a container (type 'audiobook') that has children via parentJobId.
    // LL wizard uses flat workflows (all peers share workflowId, no parentJobId) — not master/child.
    const hasChildren = this._jobs().some(j => j.parentJobId === jobId);

    if (hasChildren) {
      // Master job: only reset children that didn't complete successfully
      const childIdsToReset = new Set(
        this._jobs()
          .filter(j => j.parentJobId === jobId && j.status !== 'complete')
          .map(j => j.id)
      );
      console.log(`[QUEUE] Retrying workflow ${jobId}: resetting master + ${childIdsToReset.size} non-complete child(ren)`);

      this._jobs.update(jobs =>
        jobs.map(j => {
          if (j.id === jobId || childIdsToReset.has(j.id)) {
            return {
              ...j,
              status: 'pending' as JobStatus,
              error: undefined,
              progress: undefined,
              startedAt: undefined,
              completedAt: undefined
            };
          }
          return j;
        })
      );
    } else {
      // Single job, flat workflow peer, or child job: reset just this one
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

      // If this is a child job, also reset the master so it tracks progress again
      if (job.parentJobId) {
        const masterId = job.parentJobId;
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== masterId) return j;
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
      }
    }

    // Reposition the retried job to just after the currently processing job
    // so it appears below the running item in the UI (not above it).
    const processingIdx = this._jobs().findIndex(j => j.status === 'processing' && !j.parentJobId);
    if (processingIdx >= 0) {
      const retriedIdx = this._jobs().findIndex(j => j.id === jobId);
      if (retriedIdx >= 0 && retriedIdx < processingIdx) {
        this._jobs.update(jobs => {
          const newJobs = [...jobs];
          // Collect the retried job and any children that belong to it
          const idsToMove = new Set([jobId]);
          for (const j of newJobs) {
            if (j.parentJobId === jobId) idsToMove.add(j.id);
          }
          const toMove = newJobs.filter(j => idsToMove.has(j.id));
          const remaining = newJobs.filter(j => !idsToMove.has(j.id));
          // Find the processing job in the remaining array and insert after it
          const newProcessingIdx = remaining.findIndex(j => j.status === 'processing' && !j.parentJobId);
          remaining.splice(newProcessingIdx + 1, 0, ...toMove);
          return remaining;
        });
      }
    }

    // Try to process if queue is running — processNext fills whichever lane is free
    if (this._isRunning()) {
      await this.processNext();
    }

    return true;
  }

  /**
   * Start/resume queue processing
   */
  async startQueue(): Promise<void> {
    // Explicit Start = consent to resume: flip user-stopped jobs back to 'pending'
    // so processNext can pick them up. They keep wasInterrupted, so TTS resumes from
    // the cached sentences instead of starting fresh.
    if (this._jobs().some(j => j.status === 'stopped')) {
      console.log('[QUEUE] Start pressed — reviving stopped job(s) to pending');
      this._jobs.update(jobs =>
        jobs.map(j => j.status === 'stopped' ? { ...j, status: 'pending' as JobStatus } : j)
      );
    }
    this._isRunning.set(true);
    // processNext is lane-aware and idempotent — it fills each idle lane.
    await this.processNext();
  }

  /**
   * Pause queue processing (current job will complete)
   */
  pauseQueue(): void {
    this._isRunning.set(false);
  }

  /**
   * Resume ONE explicitly-stopped job (the per-job ▶ on a 'stopped' row). Flips just
   * that job back to pending and starts the queue — the explicit user action that a
   * stopped job requires. wasInterrupted is preserved, so TTS resumes from cache.
   */
  async resumeStoppedJob(jobId: string): Promise<void> {
    const job = this._jobs().find(j => j.id === jobId);
    if (!job || job.status !== 'stopped') return;
    console.log(`[QUEUE] Resuming stopped job ${jobId} (explicit user action)`);
    // Revive the job — and, for a workflow child, its stopped master too, so
    // processNext can mark the master 'processing' again.
    this._jobs.update(jobs =>
      jobs.map(j => {
        if (j.id === jobId) return { ...j, status: 'pending' as JobStatus };
        if (job.parentJobId && j.id === job.parentJobId && j.status === 'stopped') {
          return { ...j, status: 'pending' as JobStatus };
        }
        return j;
      })
    );
    this._isRunning.set(true);
    // processNext is lane-aware and idempotent — it fills each idle lane.
    await this.processNext();
  }

  /**
   * Stop queue processing immediately - kills current AI job and resets it to pending
   */
  async stopQueue(): Promise<void> {
    this._isRunning.set(false);

    // Stop BOTH lanes — the exclusive (GPU/local) job and the cloud (Claude/OpenAI) job.
    const currentIds = [this._currentJobId(), this._currentCloudJobId()].filter((id): id is string => !!id);
    if (currentIds.length === 0) return;

    const electron = window.electron;
    if (!electron?.queue) return;

    for (const currentId of currentIds) {
      // Snapshot the type BEFORE the await — the wasStopped completion event lands
      // during it and may already have updated the job.
      const currentJob = this._jobs().find(j => j.id === currentId);

      // Cancel the job (this will unload the AI model)
      await electron.queue.cancelJob(currentId);

      // TTS jobs: handleJobComplete owns the final state ('stopped' + wasInterrupted,
      // set by the backend's wasStopped event) — overwriting it to 'pending' here would
      // make the job auto-pickable again. Other job types have no stop event, so reset
      // them to 'stopped' too: toolbar Stop is an explicit user stop either way, and
      // Start/▶ flips them back to pending.
      if (currentJob && currentJob.type !== 'tts-conversion') {
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== currentId) return j;
            return {
              ...j,
              status: 'stopped' as JobStatus,
              error: undefined,
              progress: undefined,
              startedAt: undefined
            };
          })
        );
      }

      this.clearRunningJob(currentId);
    }
  }

  /**
   * Cancel the currently running job
   */
  async cancelCurrent(): Promise<boolean> {
    const currentId = this._currentJobId();
    if (!currentId) return false;
    return this.cancelJob(currentId);
  }

  /**
   * Cancel a specific job by ID (works for both queue and standalone jobs)
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = this._jobs().find(j => j.id === jobId);
    if (!job || job.status !== 'processing') return false;

    const electron = window.electron;
    if (!electron?.queue) return false;

    // Stop = the whole queue goes idle. Set BEFORE awaiting the backend stop: the
    // wasStopped completion event arrives DURING the await, and handleJobComplete's
    // tail must see isRunning=false so nothing auto-starts. (The old code left the
    // queue running; the stopped job went back to 'pending' and processNext re-picked
    // it in the same tick — a new GPU worker spawned against the dying one, which is
    // what wedged WSL.) Standalone jobs run alongside the queue and don't touch it.
    const isStandalone = this._standaloneJobIds().has(jobId);
    if (!isStandalone) {
      this._isRunning.set(false);
    }

    const result = await electron.queue.cancelJob(jobId);
    if (result.success) {
      // TTS jobs: the backend emits a wasStopped completion event and
      // handleJobComplete owns the final state ('stopped' + wasInterrupted) — writing
      // 'error' here would race/overwrite it. Other job types have no stop event with
      // resume semantics, so mark them cancelled directly.
      if (job.type !== 'tts-conversion') {
        this._jobs.update(jobs =>
          jobs.map(j => {
            if (j.id !== jobId) return j;
            return {
              ...j,
              status: 'error' as JobStatus,
              error: 'Cancelled by user'
            };
          })
        );
      }

      // Clean up standalone tracking if this was a standalone job
      if (isStandalone) {
        const newSet = new Set(this._standaloneJobIds());
        newSet.delete(jobId);
        this._standaloneJobIds.set(newSet);
        console.log(`[QUEUE] Standalone job ${jobId} cancelled`);
      } else {
        this.clearRunningJob(jobId);
        // Queue is now idle by design — no processNext. Toolbar Start (or the
        // per-job ▶ on the stopped job) is the explicit consent to run again.
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
    const fromJob = jobs.find(j => j.id === fromId);
    if (!fromJob) return false;

    // Collect the "block" to move: the job itself + any children (if it's a master)
    const isMaster = fromJob.workflowId && !fromJob.parentJobId;
    const blockIds = new Set<string>([fromId]);
    if (isMaster) {
      for (const j of jobs) {
        if (j.parentJobId === fromId) blockIds.add(j.id);
      }
    }

    // Split array: everything NOT in the block, and the block itself (preserving order)
    const rest: QueueJob[] = [];
    const block: QueueJob[] = [];
    for (const j of jobs) {
      if (blockIds.has(j.id)) {
        block.push(j);
      } else {
        rest.push(j);
      }
    }

    // Find target position in the rest array
    const toIndex = rest.findIndex(j => j.id === toId);
    if (toIndex === -1) return false;

    // Insert block at target position
    rest.splice(toIndex, 0, ...block);
    this._jobs.set(rest);
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
   * Handle inline job completion: clean up standalone tracking or advance the queue.
   * Job types that handle completion inline (reassembly, bilingual-*, video-assembly)
   * must call this instead of directly calling processNext(), so standalone jobs
   * don't accidentally trigger the next queue item.
   */
  private async finishJob(jobId: string): Promise<void> {
    const standaloneIds = this._standaloneJobIds();
    if (standaloneIds.has(jobId)) {
      const newSet = new Set(standaloneIds);
      newSet.delete(jobId);
      this._standaloneJobIds.set(newSet);
      console.log(`[QUEUE] Standalone job ${jobId} completed, not processing next`);
      return;
    }

    this.clearRunningJob(jobId);
    if (this._isRunning()) {
      await this.processNext();
    }
  }

  // Job types that are pure cloud/network AI calls when their provider is a
  // hosted API (Claude/OpenAI). These contend for nothing local (no GPU, no
  // bundled llama, no Ollama runner), so they run in their own lane concurrently
  // with a GPU/local job instead of waiting behind it. ollama/local providers
  // stay in the exclusive lane — they DO share the GPU.
  private static readonly CLOUD_CAPABLE_JOB_TYPES: ReadonlySet<string> = new Set([
    'ocr-cleanup', 'bilingual-cleanup', 'bilingual-translation', 'translation', 'book-analysis'
  ]);

  /**
   * Which execution lane a job belongs to. 'cloud' jobs (hosted-API AI) can run
   * concurrently with an 'exclusive' (GPU/CPU/local) job. Classification is stable
   * for a given job (derived from its type + provider), so the lane a job starts
   * in is the same lane it's cleared from.
   */
  private jobLane(job: QueueJob): 'cloud' | 'exclusive' {
    if (QueueService.CLOUD_CAPABLE_JOB_TYPES.has(job.type)) {
      const provider = (job.config as { aiProvider?: string } | undefined)?.aiProvider;
      if (provider === 'claude' || provider === 'openai') return 'cloud';
    }
    return 'exclusive';
  }

  private laneBusy(lane: 'cloud' | 'exclusive'): boolean {
    return lane === 'cloud' ? this._currentCloudJobId() !== null : this._currentJobId() !== null;
  }

  /** Mark a job as the running job in its lane. */
  private setLaneCurrent(job: QueueJob): void {
    if (this.jobLane(job) === 'cloud') {
      this._currentCloudJobId.set(job.id);
    } else {
      this._currentJobId.set(job.id);
    }
  }

  /** Clear a job from whichever lane currently holds it (no-op if it holds neither). */
  private clearRunningJob(jobId: string): void {
    if (this._currentJobId() === jobId) this._currentJobId.set(null);
    if (this._currentCloudJobId() === jobId) this._currentCloudJobId.set(null);
  }

  /**
   * Process the next pending job in the queue. Fills every idle lane: an idle
   * exclusive (GPU/local) lane and an idle cloud lane can each pick up a job in
   * the same pass, so a Claude/OpenAI job runs alongside a GPU job instead of
   * waiting behind it. Idempotent — a busy lane is skipped.
   */
  private async processNext(): Promise<void> {
    if (this.laneBusy('exclusive') && this.laneBusy('cloud')) {
      console.log(`[QUEUE] processNext: both lanes busy (exclusive=${this._currentJobId()}, cloud=${this._currentCloudJobId()}), returning`);
      return;
    }

    // Don't start work against a half-ready runtime. While the bundled env/e2a
    // are still unpacking (first run), leave jobs pending; the runtime-ready
    // effect in the constructor calls processNext() again once setup completes.
    // Only the active 'preparing' state gates — an errored setup falls through
    // so the job can run (and surface the real failure) instead of hanging.
    if (this.runtimeService.preparing()) {
      console.log('[QUEUE] processNext: runtime still preparing, deferring until ready');
      return;
    }

    // Get pending jobs, but skip:
    // - Master workflow jobs (they don't process themselves)
    // - TTS placeholder jobs (waiting for translation to set epubPath)
    // - Jobs whose workflow sibling is still processing (e.g., don't start reassembly while TTS is running)
    const allJobs = this._jobs();
    const pending = allJobs.filter(j => {
      if (j.status !== 'pending') return false;
      // Skip master workflow jobs (audiobook containers)
      if (j.type === 'audiobook' && j.workflowId && !j.parentJobId) return false;
      // Skip TTS placeholder jobs that are waiting for translation
      if (j.type === 'tts-conversion' && (j.metadata as any)?.bilingualPlaceholder) return false;
      // Skip bilingual assembly placeholder jobs that are waiting for TTS to complete
      if (j.type === 'bilingual-assembly' && (j.metadata as any)?.bilingualPlaceholder) return false;
      // Skip workflow jobs whose earlier siblings haven't completed yet.
      // Workflows execute in array order (OCR → TTS → Reassembly), so a later
      // step must not start until all preceding steps in the same workflow are complete.
      if (j.parentJobId && j.workflowId) {
        const hasIncompleteEarlierSibling = allJobs.some(s =>
          s.id !== j.id &&
          s.workflowId === j.workflowId &&
          s.parentJobId === j.parentJobId &&
          s.status !== 'complete' &&
          allJobs.indexOf(s) < allJobs.indexOf(j)
        );
        if (hasIncompleteEarlierSibling) {
          console.log(`[QUEUE] processNext: skipping ${j.type} job ${j.id} — has incomplete earlier sibling`);
          return false;
        }
      }
      return true;
    });
    // Pick up to one job per IDLE lane and start them concurrently. The first
    // eligible job (in queue order) for each free lane is chosen, so ordering
    // within a lane is preserved. A cloud (Claude/OpenAI) job and a GPU/local job
    // can therefore start in the same pass.
    const toStart: QueueJob[] = [];
    if (!this.laneBusy('exclusive')) {
      const j = pending.find(p => this.jobLane(p) === 'exclusive');
      if (j) toStart.push(j);
    }
    if (!this.laneBusy('cloud')) {
      const j = pending.find(p => this.jobLane(p) === 'cloud');
      if (j) toStart.push(j);
    }

    if (toStart.length === 0) {
      // Nothing startable right now. Only declare the queue drained (drop the
      // running flag so the toolbar shows Start) when BOTH lanes are also idle —
      // otherwise a still-running lane's completion will call processNext() again.
      if (!this.laneBusy('exclusive') && !this.laneBusy('cloud')) {
        console.log(`[QUEUE] processNext: no startable jobs and both lanes idle — queue drained (total: ${allJobs.length}, pending: ${pending.length})`);
        this._isRunning.set(false);
      } else {
        console.log(`[QUEUE] processNext: no startable jobs for idle lane(s); a lane is still busy — waiting for its completion`);
      }
      return;
    }

    for (const job of toStart) {
      console.log(`[QUEUE] processNext: starting ${this.jobLane(job)}-lane job: ${job.type} (${job.id})`);

      // If this job is part of a workflow, ensure the master job is marked as processing
      if (job.parentJobId) {
        const masterJob = this._jobs().find(j => j.id === job.parentJobId);
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

      // Fire-and-forget so both lanes run concurrently — awaiting here would
      // serialize them. Completion is driven by handleJobComplete/finishJob,
      // which clear the lane and call processNext() again to refill. runJob has
      // its own try/catch; guard the promise against unhandled rejections.
      void this.runJob(job).catch(err => console.error(`[QUEUE] runJob(${job.id}) failed:`, err));
    }
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

    // Only set as current job if not standalone — into the job's lane (cloud vs
    // exclusive) so a Claude/OpenAI job and a GPU/local job track independently.
    if (!isStandalone) {
      this.setLaneCurrent(job);
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

    // Persist the 'processing' status IMMEDIATELY (not on the 500ms debounce). If the
    // app is hard-killed/crashes early in a job, the saved state must show 'processing'
    // so loadQueueState marks it wasInterrupted → the job resumes (and is protected from
    // cleanSession) instead of restarting fresh and destroying the rendered sentences.
    void this.saveQueueState();

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
          testMode?: boolean;
          testModeChunks?: number;
          enableAiCleanup?: boolean;
          simplifyForLearning?: boolean;
          simplifyMode?: 'dejargon' | 'destiffen' | 'learner' | 'learning' | 'plain';
          cleanupPrompt?: string;
          customInstructions?: string;
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
          // Test mode
          testMode: config.testMode,
          testModeChunks: config.testModeChunks,
          // Processing options
          enableAiCleanup: config.enableAiCleanup,
          simplifyForLearning: config.simplifyForLearning,
          simplifyMode: config.simplifyMode,
          cleanupPrompt: config.cleanupPrompt,
          customInstructions: config.customInstructions
        };
        console.log('[QUEUE] Job config from storage:', { testMode: config.testMode, enableAiCleanup: config.enableAiCleanup, simplifyForLearning: config.simplifyForLearning, fullConfig: JSON.stringify(config) });
        console.log('[QUEUE] Built aiConfig:', { testMode: aiConfig.testMode });
        console.log('[QUEUE] Calling runOcrCleanup with:', {
          jobId: job.id,
          model: config.aiModel,
          useDetailedCleanup: config.useDetailedCleanup,
          exampleCount: config.deletedBlockExamples?.length || 0,
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
          // Chunks that failed translation and kept original (untranslated) text
          translationFailedChunks: transData.failedChunkCount,
          skippedChunksPath: transData.skippedChunksPath,
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
            // Standard audiobook workflow: pick the most recently modified processed EPUB
            // This is for regular audiobooks, not Language Learning
            const epubPathNorm = job.epubPath.replace(/\\/g, '/');
            const epubDir = epubPathNorm.substring(0, epubPathNorm.lastIndexOf('/'));

            // Derive project dir from epub path (epub is in source/, stages/01-cleanup/, or stages/02-translate/)
            let projectDirForTts = '';
            if (epubDir.includes('/stages/')) {
              projectDirForTts = epubDir.substring(0, epubDir.indexOf('/stages/'));
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

            // Use mtime-based resolution: pick the most recently modified candidate
            let foundPath: string | null = null;
            const fsAny = electron.fs as any;
            if (fsAny.batchStat) {
              try {
                const statResults = await fsAny.batchStat(candidates);
                let bestMtime = -1;
                for (const c of candidates) {
                  const stat = statResults[c];
                  if (stat && stat.mtimeMs > bestMtime) {
                    bestMtime = stat.mtimeMs;
                    foundPath = c;
                  }
                }
              } catch {
                // Fall through to sequential exists check
              }
            }
            // Fallback: sequential exists (first match wins, preserves old behavior)
            if (!foundPath) {
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
            // Pass metadata for final audiobook (applied after assembly via ffmpeg)
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
            // RVC voice enhancement (post-render, pre-assembly): re-render each
            // sentence through the chosen enhancement voice, then assemble that set.
            // Sourced from Pipeline Defaults; the backend resolves the voice id.
            rvcEnhancement: (() => {
              const pd = this.settingsService.getPipelineDefaults();
              return pd.rvcEnhancementEnabled && pd.rvcEnhancementVoiceId
                ? {
                    enabled: true,
                    voiceId: pd.rvcEnhancementVoiceId,
                    indexRate: pd.rvcEnhancementIndexRate,
                    protectRate: pd.rvcEnhancementProtectRate,
                    nSemitones: pd.rvcEnhancementNSemitones,
                  }
                : undefined;
            })(),
            // Final-audio denoise: per-job choice from the wizard (default ON
            // there for Orpheus). The bridge runs the block-based roformer pass
            // over the rendered sentences before any RVC pass / assembly;
            // false/absent = zero behavioral change.
            finalDenoise: config.finalDenoise
          };

          // Resume logic — three modes:
          // 1. Explicit resume (wizard "Continue" button): job.isResumeJob + config.resumeInfo
          // 2. Interrupted job (app crash/close): job.wasInterrupted — check for existing session
          // 3. Fresh start (default): clean old sessions and start new
          let shouldResume = false;
          let resumeCheckResult: ResumeCheckResult | null = null;

          console.log(`[QUEUE] Resume decision: isResumeJob=${job.isResumeJob}, hasResumeInfo=${!!config.resumeInfo}, wasInterrupted=${job.wasInterrupted}`);

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
          } else if (job.wasInterrupted || job.isResumeJob) {
            // Mode 2: Job was interrupted by app close/crash/user stop — try to resume
            // Also fires for stale isResumeJob=true (from a prior resume) with no config.resumeInfo
            console.log(`[QUEUE] Checking for resumable session: epubPath=${epubPathForTts}, bfpPath=${job.bfpPath || 'none'}, projectDir=${job.projectDir || 'none'}`);
            resumeCheckResult = await this.checkBfpForResumableSession(job.bfpPath || job.projectDir || '', epubPathForTts);
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
              console.log(`[QUEUE] Interrupted job has no resumable session (result: ${JSON.stringify(resumeCheckResult?.error || resumeCheckResult?.complete ? 'complete' : 'null')}), starting fresh`);
            }
          }
          // Explicit "Start fresh": the user chose New over Continue on the wizard's
          // TTS page while a cached session existed. Skip the cached-session
          // auto-resume below AND delete the per-language cache now, so the old
          // render can't resurface later via interrupt-flush or auto-resume. An
          // interrupted startFresh job (requeued with wasInterrupted) resumes its
          // OWN partial work through Mode 2/2.5 as usual.
          const explicitFresh = !!(config as TtsConversionConfig).startFresh
            && !job.wasInterrupted && !job.isResumeJob;
          if (explicitFresh && !shouldResume) {
            const projectDirForFresh = job.bfpPath || job.projectDir || '';
            const freshLang = (config.language || '').toLowerCase();
            if (projectDirForFresh && freshLang && electron?.fs?.deleteDirectory) {
              const cachedLangDir = `${projectDirForFresh}/stages/03-tts/sessions/${freshLang}`;
              console.log(`[QUEUE] Start fresh: deleting cached TTS session ${cachedLangDir}`);
              const del = await electron.fs.deleteDirectory(cachedLangDir);
              if (!del?.success && del?.error) {
                console.warn(`[QUEUE] Start fresh: failed to delete cached session: ${del.error}`);
              }
            }
          }

          // Mode 2.5: Check project-cached sessions before starting fresh.
          // Sessions are cached in stages/03-tts/sessions/{lang}/ after TTS completes (or partial).
          // If a partial session exists for this language, auto-resume it.
          if (!shouldResume && !explicitFresh) {
            const projectDirForResume = job.bfpPath || job.projectDir || '';
            if (projectDirForResume && electron?.sessionCache?.scanProject && electron?.parallelTts?.checkResumeFromDir) {
              try {
                const scanResult = await electron.sessionCache.scanProject(projectDirForResume);
                if (scanResult.success && scanResult.sessions?.length) {
                  const jobLang = (config.language || '').toLowerCase();
                  // Find a session matching this job's language
                  const matchingSession = scanResult.sessions.find(
                    (s: any) => s.language.toLowerCase() === jobLang
                  ) || (scanResult.sessions.length === 1 ? scanResult.sessions[0] : null);

                  if (matchingSession) {
                    const resumeResult = await electron.parallelTts.checkResumeFromDir(matchingSession.sessionDir);
                    if (resumeResult.success && resumeResult.data?.success && !resumeResult.data.complete
                        && (resumeResult.data.completedSentences ?? 0) > 0) {
                      const data = resumeResult.data;
                      resumeCheckResult = data;
                      shouldResume = true;
                      this._jobs.update(jobs => jobs.map(j => {
                        if (j.id !== job.id) return j;
                        return {
                          ...j,
                          isResumeJob: true,
                          resumeCompletedSentences: data.completedSentences,
                          resumeMissingSentences: data.missingSentences
                        };
                      }));
                      console.log(`[QUEUE] Auto-resuming from cached session: ${data.completedSentences}/${data.totalSentences} sentences (lang=${matchingSession.language})`);
                    }
                  }
                }
              } catch (err) {
                console.warn('[QUEUE] Error checking cached sessions for auto-resume:', err);
              }
            }
          }

          // Mode 3: Fresh start — clean old sessions
          // SAFETY: Never clean sessions for interrupted jobs. If resume failed, the old
          // session with completed sentences may still be recoverable on a future attempt.
          // Deleting it would permanently destroy hours of TTS work.
          if (!shouldResume) {
            if (job.wasInterrupted) {
              console.warn(`[QUEUE] Resume failed for interrupted job, starting fresh WITHOUT cleaning old sessions (preserving partial work)`);
            } else {
              (parallelConfig as any).cleanSession = true;
            }
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

          // Capture the invoke result so we can detect failures that occur BEFORE
          // the bridge can emit parallel-tts:complete (e.g. missing outputDir, prep
          // crash). Those used to leave the job hung in "running" forever because
          // ttsComplete never resolved. The bridge now emits complete for those via
          // emitJobFailure; this is the belt-and-suspenders inline fallback.
          let invokeResult: { success: boolean; data?: any; error?: string };
          if (shouldResume && resumeCheckResult) {
            console.log(`[QUEUE] Resuming TTS conversion from ${resumeCheckResult.completedSentences} sentences`);
            invokeResult = await electron.parallelTts.resumeConversion(job.id, parallelConfig, resumeCheckResult);
          } else {
            // Start fresh conversion
            invokeResult = await electron.parallelTts.startConversion(job.id, parallelConfig);
          }

          // `data` is the bridge's ParallelConversionResult ({ success, error? }).
          const bridgeResult = invokeResult?.data ?? invokeResult;
          if (invokeResult?.success === false || bridgeResult?.success === false) {
            const errMsg = bridgeResult?.error || invokeResult?.error || 'TTS conversion failed to start';
            console.warn(`[QUEUE] TTS invoke reported failure for jobId=${job.id}: ${errMsg}`);
            // The bridge normally emits parallel-tts:complete for failures (handled by
            // the constructor listener, which owns completion). Wait briefly; if the
            // event never arrives (e.g. the IPC handler threw before the bridge could
            // emit), finalize inline. handleJobComplete is idempotent if both fire.
            const settled = await Promise.race([
              ttsComplete,
              new Promise(res => setTimeout(() => res(null), 3000))
            ]);
            if (!settled) {
              await this.handleJobComplete({ jobId: job.id, success: false, error: errMsg });
            }
            return;
          }

          // Wait for TTS to actually finish (the invoke above returns immediately).
          // The constructor listener (line ~382) handles all completion logic — session
          // caching, status update, chaining, and processNext(). We only await here so
          // processNext() doesn't fall through to the next job prematurely.
          // Do NOT call handleJobComplete here — that caused a double-call race where the
          // second invocation deleted the just-cached session and then failed mid-copy.
          await ttsComplete;
          console.log(`[QUEUE] Parallel TTS inline await resolved for jobId=${job.id}, _currentJobId=${this._currentJobId()}, isRunning=${this._isRunning()}`);

          // Do NOT clear _currentJobId here. handleJobComplete (from the constructor
          // listener) owns the entire completion flow: it marks the job complete, caches
          // the TTS session to the project, and THEN clears _currentJobId + calls
          // processNext(). Clearing _currentJobId here opened a race window where the
          // job was marked complete and _currentJobId was null, allowing a premature
          // processNext() to start reassembly before session caching finished.
          // handleJobComplete always reaches lines 1207-1221 (outside try/catch),
          // so _currentJobId will be cleared and processNext() called reliably.
          return;

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
      } else if (job.type === 'rvc-enhancement') {
        // RVC enhancement job — re-render the session's sentences through an RVC
        // voice into a scratch dir, then hand that dir to the downstream
        // reassembly job (same workflow) via rvcScratchByWorkflow. Its own queue
        // step with a per-sentence ETA.
        let config = job.config as RvcEnhancementJobConfig | undefined;
        if (!config) {
          throw new Error('RVC enhancement configuration required');
        }
        if (!electron.rvc) {
          throw new Error('RVC enhancement not available');
        }

        // Runtime session discovery (same retry pattern as reassembly): when
        // chained after TTS, the session is cached just before this job runs.
        if (!config.sessionId && job.bfpPath) {
          let sessionData: any = null;
          const retryDelays = [0, 2000, 5000, 10000];
          for (let attempt = 0; attempt < retryDelays.length; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, retryDelays[attempt]));
            const sessionResult = await (electron.reassembly as any).getBfpSession(job.bfpPath);
            if (sessionResult.success && sessionResult.data) { sessionData = sessionResult.data; break; }
          }
          if (sessionData) {
            config = {
              ...config,
              sessionId: sessionData.sessionId,
              sessionDir: sessionData.sessionDir,
              processDir: sessionData.processDir,
            };
          } else {
            throw new Error('No TTS session found for RVC enhancement — run TTS first');
          }
        }

        const result = await electron.rvc.startEnhancement(job.id, config);
        if (!result.success || !result.data?.scratchDir) {
          throw new Error(result.error || 'RVC enhancement failed');
        }

        // Stash the enhanced set for the downstream reassembly job in this workflow.
        if (job.workflowId) this.rvcScratchByWorkflow.set(job.workflowId, result.data.scratchDir);

        // Mark complete inline (same pattern as reassembly), then advance the queue.
        this._jobs.update(jobs =>
          jobs.map(j => (j.id === job.id ? { ...j, status: 'complete' as JobStatus, progress: 100, completedAt: new Date() } : j))
        );
        console.log('[QUEUE] RVC enhancement complete:', result.data.scratchDir);
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }
        await this.finishJob(job.id);

      } else if (job.type === 'reassembly') {
        // Reassembly job - reassemble incomplete e2a session
        let config = job.config as ReassemblyJobConfig | undefined;
        if (!config) {
          throw new Error('Reassembly configuration required');
        }

        // Runtime session discovery — resolve session data from BFP cache if not provided
        // Retry with backoff because session caching (from TTS completion handler) may still
        // be in-flight when this job starts — the TTS completion event can race with processNext
        if (!config.sessionId && job.bfpPath) {
          console.log('[QUEUE] Reassembly: discovering session from BFP cache...');
          let sessionData: any = null;
          const retryDelays = [0, 2000, 5000, 10000]; // immediate, then 2s, 5s, 10s
          for (let attempt = 0; attempt < retryDelays.length; attempt++) {
            if (attempt > 0) {
              console.log(`[QUEUE] Reassembly: session not found, retrying in ${retryDelays[attempt]}ms (attempt ${attempt + 1}/${retryDelays.length})...`);
              await new Promise(r => setTimeout(r, retryDelays[attempt]));
            }
            const sessionResult = await (electron.reassembly as any).getBfpSession(job.bfpPath);
            if (sessionResult.success && sessionResult.data) {
              sessionData = sessionResult.data;
              break;
            }
          }
          if (sessionData) {
            config = {
              ...config,
              sessionId: sessionData.sessionId,
              sessionDir: sessionData.sessionDir,
              processDir: sessionData.processDir,
              totalChapters: sessionData.chapters?.filter((ch: any) => !ch.excluded)?.length || 0,
            };
            console.log(`[QUEUE] Reassembly: found session ${sessionData.sessionId}, ${config.totalChapters} chapters`);
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

        // RVC voice enhancement source. Preferred: a separate 'rvc-enhancement'
        // job in this workflow already produced an enhanced sentence set under
        // [library]/tmp — assemble THAT set (and the bridge deletes it after).
        const rvcScratch = job.workflowId ? this.rvcScratchByWorkflow.get(job.workflowId) : undefined;
        if (rvcScratch) {
          config = { ...config, sentencesDir: rvcScratch };
          this.rvcScratchByWorkflow.delete(job.workflowId!);
        } else {
          // Fallback (legacy callers with no upstream rvc-enhancement job in the
          // workflow): run the inline RVC pass from Pipeline Defaults. Skipped when
          // an rvc-enhancement sibling exists, so RVC never double-processes.
          const hasRvcSibling = job.workflowId
            ? this._jobs().some(j => j.workflowId === job.workflowId && j.type === 'rvc-enhancement')
            : false;
          if (!hasRvcSibling) {
            const rvcPd = this.settingsService.getPipelineDefaults();
            if (rvcPd.rvcEnhancementEnabled && rvcPd.rvcEnhancementVoiceId) {
              config = {
                ...config,
                rvcEnhancement: {
                  voiceId: rvcPd.rvcEnhancementVoiceId,
                  indexRate: rvcPd.rvcEnhancementIndexRate,
                  protectRate: rvcPd.rvcEnhancementProtectRate,
                  nSemitones: rvcPd.rvcEnhancementNSemitones,
                },
              };
            }
          }
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

        // Save reassembly analytics
        if (job.bfpPath && job.startedAt) {
          const completedAt = new Date();
          const durationSeconds = Math.round((completedAt.getTime() - new Date(job.startedAt).getTime()) / 1000);
          this.saveProjectAnalytics(job.bfpPath, 'reassembly', {
            jobId: job.id,
            startedAt: new Date(job.startedAt).toISOString(),
            completedAt: completedAt.toISOString(),
            durationSeconds,
            totalChapters: config.totalChapters || job.totalChapters || 0,
            success: true,
            outputPath: result.data?.outputPath
          });
        }

        // Embed-only: the bridge embeds the transcript into the m4b; no sidecar copy.

        // Link audio to BFP
        if (result.data?.outputPath?.endsWith('.m4b') && job.bfpPath) {
          try {
            const el = (window as any).electron;
            if (el?.audiobook?.linkAudio) {
              console.log('[QUEUE] Linking audio to BFP:', { bfpPath: job.bfpPath, outputPath: result.data.outputPath });
              const linkResult = await el.audiobook.linkAudio(job.bfpPath, result.data.outputPath);
              console.log('[QUEUE] linkAudio result:', linkResult);
            } else {
              console.warn('[QUEUE] linkAudio API not available');
            }
          } catch (err) {
            console.error('[QUEUE] Failed to auto-link audio after reassembly:', err);
          }
        } else {
          console.warn('[QUEUE] Skipping linkAudio:', {
            outputPath: result.data?.outputPath,
            endsWithM4b: result.data?.outputPath?.endsWith('.m4b'),
            bfpPath: job.bfpPath
          });
        }

        // Reload studio item (non-fatal — must not block master update or queue advance)
        if (job.bfpPath) {
          try {
            await this.studioService.reloadItem(job.bfpPath);
          } catch (err) {
            console.error('[QUEUE] Failed to reload studio item after reassembly:', err);
          }
        }

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // Finish job (standalone-aware: won't advance queue for standalone jobs)
        await this.finishJob(job.id);
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
          customInstructions: config.customInstructions,
          simplifyForLearning: config.simplifyForLearning,
          simplifyMode: config.simplifyMode,
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

        // Finish job (standalone-aware: won't advance queue for standalone jobs)
        await this.finishJob(job.id);

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

        // If this job was interrupted, check if the output file already exists before
        // re-running. This prevents wasting API calls when the translation completed but
        // the app was killed before the completion status was persisted to queue.json.
        if (job.wasInterrupted && config.monoTranslation) {
          const expectedOutput = job.outputPath
            || (job.bfpPath ? `${job.bfpPath}/stages/02-translate/translated.epub` : null);
          const fsAny = electron.fs as any;
          if (expectedOutput && fsAny?.batchStat) {
            try {
              const statResult = await fsAny.batchStat([expectedOutput]);
              if (statResult[expectedOutput]) {
                console.log(`[QUEUE] Interrupted translation already has output: ${expectedOutput} — marking complete`);
                this._jobs.update(jobs =>
                  jobs.map(j => {
                    if (j.id !== job.id) return j;
                    return { ...j, status: 'complete' as JobStatus, progress: 100, outputPath: expectedOutput };
                  })
                );
                if (job.parentJobId && job.workflowId) {
                  this.updateMasterJobProgress(job.workflowId, job.parentJobId);
                }
                await this.finishJob(job.id);
                return;
              }
            } catch {
              // batchStat failed — proceed with re-running the job
            }
          }
        }

        // If this workflow INCLUDED a cleanup step, translation must receive its
        // cleaned EPUB. A missing cleanedEpubPath here means cleanup silently didn't
        // produce output and we'd translate the RAW source — refuse loudly. Workflows
        // with no cleanup step legitimately translate job.epubPath directly (the
        // cleanedEpubPath field is optional by design; see queue.types.ts).
        const workflowHadCleanup = job.workflowId
          ? this._jobs().some(j => j.workflowId === job.workflowId && j.type === 'bilingual-cleanup')
          : false;
        if (workflowHadCleanup && !config.cleanedEpubPath) {
          throw new Error('Bilingual translation expected a cleaned EPUB from the cleanup step, but none was provided — refusing to translate the uncleaned source. Re-run the workflow.');
        }

        const result = await electron.bilingualTranslation.run(job.id, {
          projectId: config.projectId,
          projectDir: config.projectDir,
          cleanedEpubPath: config.cleanedEpubPath || job.epubPath,  // Use epubPath only when no cleanup step ran (guarded above)
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          title: config.title,
          aiProvider: config.aiProvider,
          aiModel: config.aiModel,
          ollamaBaseUrl: config.ollamaBaseUrl,
          claudeApiKey: config.claudeApiKey,
          openaiApiKey: config.openaiApiKey,
          translationPrompt: config.translationPrompt,
          customInstructions: config.customInstructions,
          monoTranslation: config.monoTranslation,
          testMode: config.testMode,
          testModeChunks: config.testModeChunks
        });

        if (!result.success) {
          throw new Error(result.error || 'Bilingual Translation failed');
        }

        // Persist translation analytics (this path finishes via finishJob, not
        // handleJobComplete, so save the record directly here).
        if ((result as any).analytics && job.bfpPath) {
          this.saveProjectAnalytics(job.bfpPath, 'translation', (result as any).analytics);
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

        // For mono translation, skip the dual-EPUB workflow — just finish
        if (config.monoTranslation) {
          console.log('[QUEUE] Mono translation complete, skipping dual-EPUB workflow');
          await this.finishJob(job.id);
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

        // Finish job (standalone-aware: won't advance queue for standalone jobs)
        await this.finishJob(job.id);

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
            // Build metadata-based filename base: "{Title}. {Author}. (Year)"
            // The finalize handler appends "(language learning, english-german)" with full language names
            const title = config.title || config.projectId || 'Audiobook';
            const author = (job.metadata as any)?.author || '';
            const year = (job.metadata as any)?.year || '';
            let metadataFilename = title;
            if (author && !title.includes(author)) {
              metadataFilename += `. ${author}`;
            }
            if (year) {
              metadataFilename += `. (${year})`;
            }
            // Guard the "Last, First M." author case (e.g. "Green, Simon R.") whose
            // trailing period collides with the ". (Year)" separator → "…R.. (Year)".
            metadataFilename = collapseFilenameDots(metadataFilename);

            const finalizeResult = await bilingualAssembly.finalizeOutput({
              audioPath: result.data.audioPath,
              vttPath: result.data.vttPath,
              projectDir: job.projectDir,
              projectId: config.projectId,
              sourceLang: config.sourceLang || 'en',
              targetLang: config.targetLang || 'de',
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

        // Finish job (standalone-aware: won't advance queue for standalone jobs)
        await this.finishJob(job.id);

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

        // Save video-assembly analytics
        if (job.bfpPath && job.startedAt) {
          const completedAt = new Date();
          const durationSeconds = Math.round((completedAt.getTime() - new Date(job.startedAt).getTime()) / 1000);
          this.saveProjectAnalytics(job.bfpPath, 'video-assembly', {
            jobId: job.id,
            startedAt: new Date(job.startedAt).toISOString(),
            completedAt: completedAt.toISOString(),
            durationSeconds,
            resolution: config.resolution || 'unknown',
            mode: config.mode || 'unknown',
            success: true,
            outputPath: result.outputPath
          });
        }

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        // Finish job (standalone-aware: won't advance queue for standalone jobs)
        await this.finishJob(job.id);

      } else if (job.type === 'generate-sentences') {
        // Generate-sentences job — transcribe an audiobook variant into a synced
        // VTT with Whisper and link it to that variant.
        const config = job.config as GenerateSentencesJobConfig;
        if (!config) {
          throw new Error('Generate sentences configuration required');
        }

        const generateSentences = (window.electron as any)?.generateSentences;
        if (!generateSentences) {
          throw new Error('Generate sentences not available');
        }

        const unsubscribeProgress = generateSentences.onProgress((data: {
          jobId: string; percentage: number; message: string;
          stages?: AlignStageProgress[];
        }) => {
          if (data.jobId !== job.id) return;
          this._jobs.update(jobs =>
            jobs.map(j => j.id === job.id
              ? { ...j, progress: data.percentage, progressMessage: data.message,
                  ...(data.stages ? { alignStages: data.stages } : {}) }
              : j)
          );
        });

        const done = new Promise<{ success: boolean; outputPath?: string; error?: string }>((resolve) => {
          const unsub = generateSentences.onComplete((data: {
            jobId: string; success: boolean; outputPath?: string; error?: string;
          }) => {
            if (data.jobId !== job.id) return;
            unsub();
            resolve(data);
          });
        });

        const startResult = await generateSentences.run(job.id, {
          projectId: config.projectId,
          variantId: config.variantId,
          m4bPath: config.m4bPath,
          modelId: config.modelId,
          language: config.language || 'auto',
          method: config.method,
          epubVariantId: config.epubVariantId,
        });

        if (!startResult.success) {
          if (unsubscribeProgress) unsubscribeProgress();
          throw new Error(startResult.error || 'Failed to start transcription');
        }

        const result = await done;
        if (unsubscribeProgress) unsubscribeProgress();

        if (!result.success) {
          throw new Error(result.error || 'Transcription failed');
        }

        this._jobs.update(jobs =>
          jobs.map(j => j.id === job.id
            ? { ...j, status: 'complete' as JobStatus, progress: 100, outputPath: result.outputPath }
            : j)
        );

        await this.finishJob(job.id);

      } else if (job.type === 'book-analysis') {
        // Book Analysis job — sends EPUB text to AI for content flagging
        const config = job.config as BookAnalysisConfig;
        const electron = window.electron;

        if (!electron?.queue?.runBookAnalysis) {
          throw new Error('Book Analysis not available');
        }

        // Build AI config from per-job settings (same pattern as ocr-cleanup)
        const aiConfig: AIProviderConfig & {
          categories: Array<{ id: string; name: string; description: string; color: string; enabled: boolean }>;
          testMode?: boolean;
          testModeChunks?: number;
          target?: { versionId: string; versionType: string; versionLabel: string };
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
          categories: config.categories,
          testMode: config.testMode,
          testModeChunks: config.testModeChunks,
          target: config.target,
        };

        console.log('[QUEUE] Starting book analysis:', {
          jobId: job.id,
          provider: config.aiProvider,
          model: config.aiModel,
          categoryCount: config.categories?.length || 0,
          testMode: config.testMode,
        });

        const analysisResult = await electron.queue.runBookAnalysis(job.id, config.source, aiConfig);

        const analysisData = analysisResult?.data || {};
        await this.handleJobComplete({
          jobId: job.id,
          success: analysisData.success ?? analysisResult?.success ?? false,
          outputPath: analysisData.outputPath,
          error: analysisData.error || analysisResult?.error,
          contentSkipsDetected: analysisData.contentSkipsDetected,
          contentSkipsAffected: analysisData.contentSkipsAffected,
          skippedChunksPath: analysisData.skippedChunksPath,
          analytics: analysisData.analytics,
        });

        // Update master job progress
        if (job.parentJobId && job.workflowId) {
          this.updateMasterJobProgress(job.workflowId, job.parentJobId);
        }

        await this.finishJob(job.id);
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

      // Cancel the rest of the workflow. Job types that report failure by throwing
      // (rvc-enhancement, reassembly, bilingual-*, video-assembly, generate-sentences)
      // land here instead of handleJobComplete, so without this their downstream
      // siblings would sit pending forever and the master workflow would never finish.
      this.cancelPendingWorkflowJobs(job);

      // Update master job progress so workflow status reflects the error
      if (job.parentJobId && job.workflowId) {
        this.updateMasterJobProgress(job.workflowId, job.parentJobId);
      }

      // Check if this was a standalone job
      const standaloneIds = this._standaloneJobIds();
      if (standaloneIds.has(job.id)) {
        // Remove from standalone tracking
        const newSet = new Set(standaloneIds);
        newSet.delete(job.id);
        this._standaloneJobIds.set(newSet);
        console.log(`[QUEUE] Standalone job ${job.id} failed to start`);
      } else {
        // Queue job - clear its lane and try next
        this.clearRunningJob(job.id);
        if (this._isRunning()) {
          await this.processNext();
        }
      }
    }
  }

  private buildJobConfig(request: CreateJobRequest): OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | RvcEnhancementJobConfig | ReassemblyJobConfig | BilingualCleanupJobConfig | BilingualTranslationJobConfig | BilingualAssemblyJobConfig | VideoAssemblyJobConfig | AudiobookJobConfig | BookAnalysisConfig | GenerateSentencesJobConfig | undefined {
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
        // Test mode
        testMode: config.testMode,
        testModeChunks: config.testModeChunks,
        // Processing options
        enableAiCleanup: config.enableAiCleanup,
        simplifyForLearning: config.simplifyForLearning,
        simplifyMode: config.simplifyMode,
        cleanupPrompt: config.cleanupPrompt,
        customInstructions: config.customInstructions
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
      // Engine + voice are REQUIRED — never silently default them. These used to fall
      // back to xtts/ScarlettJohansson, which silently overrode Orpheus (and every other
      // voice) on resume jobs whose config omitted them. A missing engine/voice here is a
      // real bug in the caller, so surface it instead of shipping the wrong voice. (NO FALLBACKS.)
      if (!config.ttsEngine) {
        throw new Error('TTS job config is missing ttsEngine — the caller must set it explicitly (no default).');
      }
      if (!config.fineTuned) {
        throw new Error('TTS job config is missing a voice (fineTuned) — the caller must set it explicitly (no default).');
      }
      return {
        type: 'tts-conversion',
        device: config.device || 'cpu',
        language: config.language || 'en',
        ttsEngine: config.ttsEngine,
        fineTuned: config.fineTuned,
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
        // Explicit "Start fresh" choice from the wizard (suppresses cached-session
        // auto-resume and clears the per-language project cache at job start)
        startFresh: config.startFresh,
        // Preserve paragraph boundaries (for language learning)
        sentencePerParagraph: config.sentencePerParagraph,
        // Skip reading heading tags as chapter titles (for bilingual)
        skipHeadings: config.skipHeadings,
        // Test mode - only process first N sentences
        testMode: config.testMode,
        testSentences: config.testSentences,
        // Final-assembly denoise (per-job; default ON in the wizard for Orpheus)
        finalDenoise: config.finalDenoise
      };
    } else if (request.type === 'rvc-enhancement') {
      const config = request.config as Partial<RvcEnhancementJobConfig>;
      // session* may be empty — filled at runtime via BFP session discovery.
      // voiceId is required (which RVC voice to enhance through).
      if (!config?.voiceId) {
        return undefined;
      }
      return {
        type: 'rvc-enhancement',
        sessionId: config.sessionId || '',
        sessionDir: config.sessionDir || '',
        processDir: config.processDir || '',
        voiceId: config.voiceId,
        indexRate: config.indexRate,
        protectRate: config.protectRate,
        nSemitones: config.nSemitones,
        // Final-audio denoise rides on this job so denoise runs BEFORE conversion
        finalDenoise: config.finalDenoise,
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
        excludedChapters: config.excludedChapters || [],
        // Final-assembly denoise (per-job; default ON in the wizard for Orpheus)
        finalDenoise: config.finalDenoise,
        // Assembly-time sentence-gap override; undefined → voice's models.json default
        sentenceGap: config.sentenceGap
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
        customInstructions: config.customInstructions,
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
    } else if (request.type === 'book-analysis') {
      const config = request.config as Partial<BookAnalysisConfig>;
      if (!config?.source || !config?.aiProvider || !config?.aiModel || !config?.categories) {
        return undefined;
      }
      return {
        type: 'book-analysis',
        projectDir: config.projectDir || '',
        source: config.source!,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        ollamaBaseUrl: config.ollamaBaseUrl,
        claudeApiKey: config.claudeApiKey,
        openaiApiKey: config.openaiApiKey,
        categories: config.categories,
        testMode: config.testMode,
        testModeChunks: config.testModeChunks,
        target: config.target,
      };
    } else if (request.type === 'generate-sentences') {
      const config = request.config as Partial<GenerateSentencesJobConfig>;
      if (!config?.projectId || !config?.variantId || !config?.m4bPath || !config?.modelId) {
        return undefined;
      }
      return {
        type: 'generate-sentences',
        projectId: config.projectId,
        variantId: config.variantId,
        m4bPath: config.m4bPath,
        modelId: config.modelId,
        modelLabel: config.modelLabel,
        language: config.language || 'auto',
        method: config.method,
        epubVariantId: config.epubVariantId,
      };
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
   * Save job analytics to the project folder ({projectDir}/job-analytics.json).
   * Called once per job completion to avoid duplicate saves from component effects.
   * Uses the appendAnalytics IPC handler which atomically handles read-dedupe-write.
   * (bfpPath is the absolute project directory — the legacy ".bfp" naming is gone.)
   */
  private async saveProjectAnalytics(
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
    const validTypes = ['tts-conversion', 'ocr-cleanup', 'reassembly', 'video-assembly', 'rvc', 'translation'];
    if (!validTypes.includes(jobType)) {
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
      if (!result.success) {
        // Not the same as "no saved state": the file existed but couldn't be read.
        // The main process preserved it as queue.json.corrupt-<ts> before we got
        // here (otherwise our debounced auto-save would overwrite it with []).
        const r = result as { error?: string; backupPath?: string };
        console.error(`[QUEUE] Saved queue state was corrupt and could not be loaded${r.backupPath ? ` — preserved at ${r.backupPath}` : ''}:`, r.error);
        return;
      }
      if (!result.data) {
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

        // Clean up orphaned sub-items, then normalize grouping
        this.cleanupOrphanedSubItems();
        this.normalizeJobGrouping();

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

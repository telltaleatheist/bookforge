/**
 * OCR Job Service
 *
 * Manages OCR jobs that can run in the background.
 * Jobs are queued and run sequentially (one at a time).
 * Jobs continue even when the OCR modal is closed.
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';
import { PluginService, PluginLayoutBlock } from '../../../core/services/plugin.service';

// Defined here to avoid circular dependency with ocr-settings-modal.component
export interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
}

export interface OcrJobResult {
  page: number;
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];
  layoutBlocks?: PluginLayoutBlock[];
}

export interface OcrJob {
  id: string;
  documentId: string;
  documentName: string;
  engine: 'tesseract' | 'surya';
  language: string;
  pages: number[];
  status: 'queued' | 'pending' | 'running' | 'completed' | 'cancelled' | 'error';
  progress: number;  // 0-100
  currentPage: number;
  processedCount: number;
  totalPages: number;
  results: OcrJobResult[];
  error?: string;
  startTime?: number;
  endTime?: number;
  queuePosition?: number;  // Position in queue (1-based, only for queued jobs)
}

@Injectable({
  providedIn: 'root'
})
export class OcrJobService {
  private readonly electronService = inject(ElectronService);
  private readonly pluginService = inject(PluginService);

  // Active jobs (includes queued, running, and completed)
  readonly jobs = signal<OcrJob[]>([]);

  // Computed: jobs by status
  readonly runningJob = computed(() => this.jobs().find(j => j.status === 'running'));
  readonly queuedJobs = computed(() => this.jobs().filter(j => j.status === 'queued'));
  readonly hasRunningJobs = computed(() => !!this.runningJob());
  readonly hasQueuedJobs = computed(() => this.queuedJobs().length > 0);

  // Callback for when a job completes (per-job callbacks)
  private completionCallbacks = new Map<string, (job: OcrJob) => void>();

  // Global completion callback (for pdf-picker to handle all completions)
  private globalCompletionCallback: ((job: OcrJob) => void) | null = null;

  // Image provider for pages (set by the component that starts the job)
  private imageProviders = new Map<string, (pageNum: number) => string | null>();

  // Flag to prevent multiple queue processors
  private isProcessingQueue = false;

  /**
   * Queue a new OCR job. Jobs run sequentially - one at a time.
   */
  async startJob(
    documentId: string,
    documentName: string,
    engine: 'tesseract' | 'surya',
    language: string,
    pages: number[],
    getPageImage: (pageNum: number) => string | null,
    onComplete?: (job: OcrJob) => void
  ): Promise<string> {
    const jobId = `ocr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Determine initial status - queued if another job is running, otherwise pending
    const hasRunning = this.hasRunningJobs();
    const queuePosition = hasRunning ? this.queuedJobs().length + 1 : undefined;

    const job: OcrJob = {
      id: jobId,
      documentId,
      documentName,
      engine,
      language,
      pages,
      status: hasRunning ? 'queued' : 'pending',
      progress: 0,
      currentPage: 0,
      processedCount: 0,
      totalPages: pages.length,
      results: [],
      queuePosition
    };

    // Store the image provider and completion callback
    this.imageProviders.set(jobId, getPageImage);
    if (onComplete) {
      this.completionCallbacks.set(jobId, onComplete);
    }

    // Add job to list
    this.jobs.update(jobs => [...jobs, job]);

    console.log(`[OCR Queue] Job ${jobId} added - status: ${job.status}${queuePosition ? `, position: ${queuePosition}` : ''}`);
    console.log(`[OCR Queue] Total jobs now: ${this.jobs().length}, pages: ${pages.length}`);

    // Start processing queue if not already running (use setTimeout to allow UI to update first)
    setTimeout(() => this.processQueue(), 0);

    return jobId;
  }

  /**
   * Cancel a running or queued job
   */
  cancelJob(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job) return;

    if (job.status === 'running' || job.status === 'queued') {
      this.jobs.update(jobs => jobs.map(j =>
        j.id === jobId ? { ...j, status: 'cancelled' as const } : j
      ));
      // Update queue positions for remaining queued jobs
      this.updateQueuePositions();
    }
  }

  /**
   * Remove a completed/cancelled job from the list
   */
  dismissJob(jobId: string): void {
    this.jobs.update(jobs => jobs.filter(j => j.id !== jobId));
    this.imageProviders.delete(jobId);
    this.completionCallbacks.delete(jobId);
  }

  /**
   * Register a global completion callback that fires for ALL completed jobs
   * This is used by pdf-picker to handle results after the modal is closed
   */
  onJobComplete(callback: (job: OcrJob) => void): void {
    this.globalCompletionCallback = callback;
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): OcrJob | undefined {
    return this.jobs().find(j => j.id === jobId);
  }

  /**
   * Process the job queue - runs jobs one at a time
   */
  private async processQueue(): Promise<void> {
    // Prevent multiple queue processors
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (true) {
        // Find next job to process (first pending or queued job)
        const nextJob = this.jobs().find(j => j.status === 'pending' || j.status === 'queued');
        if (!nextJob) {
          console.log('[OCR Queue] No more jobs to process');
          break;
        }

        console.log(`[OCR Queue] Starting job ${nextJob.id} for "${nextJob.documentName}"`);
        await this.processJob(nextJob.id);

        // Update queue positions after job completes
        this.updateQueuePositions();
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Update queue positions for all queued jobs
   */
  private updateQueuePositions(): void {
    this.jobs.update(jobs => {
      let position = 1;
      return jobs.map(j => {
        if (j.status === 'queued') {
          return { ...j, queuePosition: position++ };
        }
        return { ...j, queuePosition: undefined };
      });
    });
  }

  /**
   * Process a single job
   */
  private async processJob(jobId: string): Promise<void> {
    const getImage = this.imageProviders.get(jobId);
    if (!getImage) {
      this.updateJobStatus(jobId, 'error', 'No image provider');
      return;
    }

    // Mark as running and set start time
    this.jobs.update(jobs => jobs.map(j =>
      j.id === jobId ? {
        ...j,
        status: 'running' as const,
        startTime: Date.now(),
        queuePosition: undefined
      } : j
    ));

    const job = this.getJob(jobId);
    if (!job) return;

    for (let i = 0; i < job.pages.length; i++) {
      // Check if cancelled
      const currentJob = this.getJob(jobId);
      if (!currentJob || currentJob.status === 'cancelled') {
        console.log(`[OCR Queue] Job ${jobId} was cancelled`);
        break;
      }

      const pageNum = job.pages[i];

      // Update current page
      this.jobs.update(jobs => jobs.map(j =>
        j.id === jobId ? {
          ...j,
          currentPage: pageNum,
          progress: Math.round((i / job.pages.length) * 100)
        } : j
      ));

      try {
        const imageData = getImage(pageNum);
        if (!imageData) {
          console.warn(`[OCR Job] No image for page ${pageNum + 1}, skipping`);
          this.incrementProcessed(jobId);
          continue;
        }

        let result: OcrJobResult | null = null;

        if (job.engine === 'surya') {
          const suryaResult = await this.pluginService.runOcr('surya-ocr', imageData);
          if (suryaResult.success && suryaResult.text) {
            result = {
              page: pageNum,
              text: suryaResult.text,
              confidence: suryaResult.confidence || 0.9,
              textLines: suryaResult.textLines
            };
          } else if (suryaResult.error) {
            throw new Error(suryaResult.error);
          }
        } else {
          const tesseractResult = await this.electronService.ocrRecognize(imageData);
          if (tesseractResult) {
            result = {
              page: pageNum,
              text: tesseractResult.text,
              confidence: tesseractResult.confidence,
              textLines: tesseractResult.textLines
            };
          }
        }

        // Run Surya layout detection ONLY if Surya is the selected engine
        // (Don't run Surya when Tesseract is selected - it causes unnecessary memory pressure)
        if (result && job.engine === 'surya') {
          try {
            const suryaPlugin = this.pluginService.getPlugin('surya-ocr');
            if (suryaPlugin?.available) {
              console.log(`[OCR Job] Running layout detection for page ${pageNum}`);
              const layoutResult = await this.pluginService.detectLayout('surya-ocr', imageData);
              if (layoutResult.success && layoutResult.layoutBlocks) {
                result.layoutBlocks = layoutResult.layoutBlocks;
                console.log(`[OCR Job] Layout detection returned ${layoutResult.layoutBlocks.length} blocks for page ${pageNum}`);
              }
            }
          } catch (layoutErr) {
            console.warn(`[OCR Job] Layout detection failed for page ${pageNum}:`, layoutErr);
          }
        }

        if (result) {
          this.addResult(jobId, result);
        }
      } catch (err) {
        console.error(`[OCR Job] Failed on page ${pageNum + 1}:`, err);
        // Continue processing other pages, just log the error
      }

      this.incrementProcessed(jobId);
    }

    // Mark as completed (if not cancelled)
    const finalJob = this.getJob(jobId);
    if (finalJob && finalJob.status === 'running') {
      this.jobs.update(jobs => jobs.map(j =>
        j.id === jobId ? {
          ...j,
          status: 'completed' as const,
          progress: 100,
          endTime: Date.now()
        } : j
      ));

      console.log(`[OCR Queue] Job ${jobId} completed`);

      // Call completion callbacks
      const completedJob = this.getJob(jobId);
      if (completedJob) {
        // Per-job callback (may fail if modal is destroyed)
        const callback = this.completionCallbacks.get(jobId);
        if (callback) {
          try {
            callback(completedJob);
          } catch (e) {
            console.warn('[OCR Queue] Per-job callback failed (modal may be closed):', e);
          }
        }

        // Global callback (pdf-picker handles this)
        if (this.globalCompletionCallback) {
          this.globalCompletionCallback(completedJob);
        }
      }
    }
  }

  private updateJobStatus(jobId: string, status: OcrJob['status'], error?: string): void {
    this.jobs.update(jobs => jobs.map(j =>
      j.id === jobId ? { ...j, status, error } : j
    ));
  }

  private incrementProcessed(jobId: string): void {
    this.jobs.update(jobs => jobs.map(j =>
      j.id === jobId ? {
        ...j,
        processedCount: j.processedCount + 1,
        progress: Math.round(((j.processedCount + 1) / j.totalPages) * 100)
      } : j
    ));
  }

  private addResult(jobId: string, result: OcrJobResult): void {
    this.jobs.update(jobs => jobs.map(j =>
      j.id === jobId ? { ...j, results: [...j.results, result] } : j
    ));
  }
}

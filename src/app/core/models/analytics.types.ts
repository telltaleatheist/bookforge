/**
 * Analytics Types for TTS and AI Cleanup Jobs
 */

export interface TTSJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;
  totalChapters: number;

  // Worker metrics
  workerCount: number;

  // Performance metrics
  sentencesPerMinute: number;
  audioDurationSeconds?: number;  // Duration of output audio

  // Settings used
  settings: {
    device: string;
    language: string;
    ttsEngine: string;
    fineTuned?: string;
  };

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;

  // Resume info (if this was a resume job)
  isResumeJob?: boolean;
  sentencesProcessedInSession?: number;

  // Cancellation info (if job was cancelled)
  wasCancelled?: boolean;
  completedSentencesAtCancel?: number;
}

export interface CleanupJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalChapters: number;
  totalChunks: number;
  totalCharacters: number;

  // Performance metrics
  chunksPerMinute: number;
  charactersPerMinute: number;

  // Model info
  model: string;

  // Outcome
  success: boolean;
  chaptersProcessed: number;

  // Issues
  copyrightChunksAffected: number;
  contentSkipsAffected: number;
  skippedChunksPath?: string;

  error?: string;
}

export interface ProjectAnalytics {
  ttsJobs: TTSJobAnalytics[];
  cleanupJobs: CleanupJobAnalytics[];
}

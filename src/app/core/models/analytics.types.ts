/**
 * Analytics Types for TTS and AI Cleanup Jobs
 */

export interface TTSJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;       // GENERATION CHUNKS (a chunk packs 2-3 real sentences)
  /** Real sentence count across all chunks. Optional (absent on old runs / minimal prep);
   *  when present and > totalSentences it yields the true sentences/min via the ratio. */
  totalRawSentences?: number;
  totalChapters: number;

  // Worker metrics
  workerCount: number;

  // Performance metrics
  sentencesPerMinute: number;   // Actually CHUNKS per minute (see totalRawSentences)
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

export interface ReassemblyJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalChapters: number;

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface RvcJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;

  // Performance metrics
  sentencesPerMinute: number;

  // RVC settings
  modelName: string;       // urvc voice-model folder name
  voiceLabel?: string;     // friendly label (e.g. "US Female 1")
  indexRate: number;
  protectRate?: number;

  // Outcome
  success: boolean;
  outputPath?: string;     // enhanced sentences dir
  error?: string;
}

export interface TranslationJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;       // sentences/paragraphs translated
  totalCharacters?: number;

  // Performance metrics
  sentencesPerMinute: number;

  // Settings
  provider: string;             // e.g. 'ollama', 'openai'
  model: string;
  sourceLang?: string;
  targetLang: string;
  mode: 'mono' | 'bilingual';   // whole-book vs sentence-aligned

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;

  // Issues: chunks that failed translation and kept original (untranslated) text
  failedChunkCount?: number;
  skippedChunksPath?: string;
}

export interface VideoAssemblyJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Settings
  resolution: string;
  mode: string;

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface ProjectAnalytics {
  ttsJobs: TTSJobAnalytics[];
  cleanupJobs: CleanupJobAnalytics[];
  reassemblyJobs?: ReassemblyJobAnalytics[];
  videoAssemblyJobs?: VideoAssemblyJobAnalytics[];
  rvcJobs?: RvcJobAnalytics[];
  translationJobs?: TranslationJobAnalytics[];
}

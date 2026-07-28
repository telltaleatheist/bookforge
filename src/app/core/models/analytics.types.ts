/**
 * Analytics Types for TTS and AI Cleanup Jobs
 */

export interface TTSJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;       // GENERATION CHUNKS for the whole book, not sentences
  /** Real sentence count across all chunks of the book. Optional (absent on old runs). */
  totalRawSentences?: number;
  totalChapters: number;

  // Worker metrics
  workerCount: number;

  // Performance metrics
  sentencesPerMinute: number;   // Actually CHUNKS per minute (see chunksPerMinute)
  audioDurationSeconds?: number;  // Duration of output audio

  /**
   * ── Measured throughput ──────────────────────────────────────────────────
   *
   * How many real sentences a chunk holds is a property of THIS run's packing, not a
   * constant: raising the packer's character budget moved it from ~1.5 to ~2.7 on real
   * books, and individual chunks range from 1 to 9. So none of these are derived from an
   * assumed ratio — each is counted from the work the run actually did, which is what
   * keeps them correct the next time the packing changes.
   *
   * All optional: runs recorded before this existed have none of them, and the panel
   * falls back to the whole-book ratio for those rather than inventing values.
   */

  /** Chunks rendered in THIS session. */
  chunksInSession?: number;
  /** EXACT real sentences in those chunks — summed per chunk, never chunks × average. */
  rawSentencesInSession?: number;
  /**
   * Seconds spent actually rendering: measured from the first completed chunk, so model
   * load and prep are excluded. `durationSeconds` includes them, which is why a rate
   * derived from it reads lower than the throughput the queue showed while running.
   */
  workSeconds?: number;
  /** Chunks per minute over workSeconds. */
  chunksPerMinute?: number;
  /** Real sentences per minute over workSeconds. Measured, not scaled from a ratio. */
  rawSentencesPerMinute?: number;

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

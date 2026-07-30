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
  /**
   * CHUNKS per minute over the WHOLE job, model load and prep included — which is why it
   * reads lower than the rate the queue showed while running (`chunksPerMinute` below
   * divides by render time only).
   *
   * Was named `sentencesPerMinute` while holding chunks. Readers that trusted the name
   * reported chunks as sentences, which is the same class of error the sentences/min
   * readout itself turned out to be. Records written before the rename carry the old key;
   * see `legacySentencesPerMinute`.
   */
  chunksPerMinuteOverall?: number;
  /**
   * @deprecated The pre-rename key, holding the SAME chunks-per-minute figure. Present
   * only on records written before the rename; new records never set it. Reading it is
   * not a fallback for a missing measurement — it IS the measurement under its former
   * name, so readers take whichever key the record actually carries.
   */
  sentencesPerMinute?: number;
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
  /** EXACT words and characters in those chunks — summed per chunk, same as sentences. */
  rawWordsInSession?: number;
  rawCharsInSession?: number;
  /** Chunks per minute over workSeconds. */
  chunksPerMinute?: number;
  /** Real sentences per minute over workSeconds. Measured, not scaled from a ratio. */
  rawSentencesPerMinute?: number;
  /**
   * Words and characters per minute over workSeconds.
   *
   * Both are comparable across books in a way sentences/min is not: a chunk is packed to
   * a character budget, so a dense author's chunk holds ~1.9 sentences where a sparse
   * one holds ~4.4, and sentences/min halves between two runs of identical throughput.
   * Words are the legible unit for display; characters are the one that predicts audio
   * duration best and that the ETA divides.
   */
  wordsPerMinute?: number;
  charsPerMinute?: number;
  /**
   * Seconds of AUDIO produced per character of text, sampled from this run's own rendered
   * FLACs, and the realtime factor built from it (audio seconds produced per wall second).
   *
   * The realtime factor is the ONLY throughput figure comparable across books AND voices,
   * because audio is the actual unit of work: measured across three jobs, sentences/min
   * ranged 92–188 while the realtime factor held at 12.0–14.0×. It also exposes what the
   * text rates hide — a voice that narrates at 145 wpm against another's 170 produces ~17%
   * more audio from the same book, so it genuinely takes longer at identical efficiency.
   */
  audioSecondsPerChar?: number;
  realtimeFactor?: number;

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

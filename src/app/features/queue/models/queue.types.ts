/**
 * Queue Types - Type definitions for the unified processing queue
 */

import { AIProvider } from '../../../core/models/ai-config.types';

// Job types supported by the queue
export type JobType = 'ocr-cleanup' | 'tts-conversion' | 'translation' | 'rvc-enhancement' | 'reassembly' | 'bilingual-cleanup' | 'bilingual-translation' | 'bilingual-assembly' | 'video-assembly' | 'audiobook' | 'book-analysis' | 'generate-sentences';

// Job status
// 'stopped' = explicitly stopped by the user. Stays in the queue with its cached
// progress, but processNext() NEVER auto-picks it — only an explicit user action
// (toolbar Start, or the per-job resume button) flips it back to 'pending'.
// This is what killed the old stop→instant-auto-resume bounce (a stopped job used
// to go back to 'pending' and be re-picked in the same tick).
export type JobStatus = 'pending' | 'processing' | 'complete' | 'error' | 'stopped';

// Parallel worker progress tracking
export type ParallelWorkerStatus = 'pending' | 'running' | 'complete' | 'error';

export interface ParallelWorkerProgress {
  id: number;
  sentenceStart: number;
  sentenceEnd: number;
  completedSentences: number;
  status: ParallelWorkerStatus;
  error?: string;
  // Total sentences assigned to this worker (for accurate progress calculation)
  // For resume jobs, this may be less than (sentenceEnd - sentenceStart + 1)
  // because some sentences in the range are already complete
  totalAssigned?: number;
  // Actual TTS conversions done (for resume jobs, excludes skipped sentences)
  actualConversions?: number;
}

// Per-stage progress for the epub-align (Generate Sentences) pipeline. Rendered
// as stacked bars, one per stage, each 0-100%. Only set on epub-align jobs.
export type AlignStageStatus = 'pending' | 'running' | 'complete';
export interface AlignStageProgress {
  name: string;
  label: string;
  pct: number;            // 0-100 within this stage
  status: AlignStageStatus;
}

// Base job interface
export interface QueueJob {
  id: string;
  type: JobType;
  epubPath?: string;      // Optional for bilingual-assembly jobs
  epubFilename?: string;  // Optional for bilingual-assembly jobs
  status: JobStatus;
  progress?: number;          // 0-100 percentage
  alignStages?: AlignStageProgress[];  // epub-align stacked stage bars (undefined for other job types)
  error?: string;             // Error message if status is 'error'
  outputPath?: string;        // Path to output file (e.g., cleaned.epub for OCR jobs)
  addedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  metadata?: AudiobookMetadata;
  // Language learning project directory
  projectDir?: string;
  // Job grouping for multi-step workflows (ll-cleanup, ll-translation, tts)
  parentJobId?: string;        // ID of the master job (first in workflow)
  workflowId?: string;         // Shared ID for all jobs in a workflow
  // Job-specific configuration
  config?: JobConfig;
  // Standalone mode - job was started manually, doesn't trigger next job on completion
  isStandalone?: boolean;
  // Progress tracking for ETA calculation
  currentChunk?: number;          // Current chunk (1-indexed, job-wide)
  totalChunks?: number;           // Total chunks in entire job
  currentChapter?: number;
  totalChapters?: number;
  chunksCompletedInJob?: number;  // Chunks completed so far
  totalChunksInJob?: number;      // Total chunks in entire job
  totalRawSentencesInJob?: number; // Real sentences across all chunks (chunks pack 2-3); for true sentences/min
  chunkCompletedAt?: number;      // Timestamp of last chunk completion
  progressMessage?: string;       // Current progress message
  // Parallel TTS worker progress
  parallelWorkers?: ParallelWorkerProgress[];
  // Resume state for interrupted TTS jobs
  isResumeJob?: boolean;                     // Is this a resume job?
  resumeCompletedSentences?: number;         // Sentences already completed before resume
  resumeMissingSentences?: number;           // Sentences to process in this resume
  // Session progress tracking (for accurate ETA on resume jobs)
  chunksDoneInSession?: number;              // Chunks completed in THIS session only
  rawSentencesDoneInSession?: number;        // EXACT real sentences rendered THIS session (precise sentences/min; absent → chunk×average estimate)
  // Copyright issues detected during AI cleanup
  copyrightIssuesDetected?: boolean;
  copyrightChunksAffected?: number;
  // Content skips detected during AI cleanup (AI refused via [SKIP] marker)
  contentSkipsDetected?: boolean;
  contentSkipsAffected?: number;
  // Translation chunks that failed and kept original (untranslated) text
  translationFailedChunks?: number;
  // Path to JSON file containing skipped chunk details
  skippedChunksPath?: string;
  // BFP project path for analytics saving
  bfpPath?: string;
  // Analytics data (from completed job)
  analytics?: any;
  // TTS phase tracking (for showing TTS + Assembly as separate progress)
  ttsPhase?: 'preparing' | 'converting' | 'assembling' | 'complete';
  // TTS conversion progress (sentences) - separate from assembly
  ttsConversionProgress?: number;  // 0-100 for sentence conversion only
  // Assembly progress details
  assemblyProgress?: number;       // 0-100 for assembly phase
  assemblySubPhase?: 'combining' | 'vtt' | 'encoding' | 'metadata';
  // Job was interrupted by app close/crash — TTS should auto-resume instead of starting fresh
  wasInterrupted?: boolean;
  // Orpheus memory level this job resolved to (e.g. 'Light') — shown as a queue badge.
  orpheusMemoryLevel?: string;
  // Pre-computed ETA for master/workflow jobs (calculated in queue service from child job estimates)
  estimatedSecondsRemaining?: number;
}

// Job configuration union type
export type JobConfig = OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | RvcEnhancementJobConfig | ReassemblyJobConfig | BilingualCleanupJobConfig | BilingualTranslationJobConfig | BilingualAssemblyJobConfig | VideoAssemblyJobConfig | AudiobookJobConfig | BookAnalysisConfig | GenerateSentencesJobConfig;

// Deleted block example for detailed cleanup mode
export interface DeletedBlockExample {
  text: string;
  category: 'header' | 'footer' | 'page_number' | 'custom' | 'block';
  page?: number;
}

// OCR Cleanup job configuration
export interface OcrCleanupConfig {
  type: 'ocr-cleanup';
  // AI Provider settings (per-job)
  aiProvider: AIProvider;
  aiModel: string;
  // Provider-specific settings (only the relevant one is used)
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  // Detailed cleanup mode - uses deleted blocks as few-shot examples
  deletedBlockExamples?: DeletedBlockExample[];
  useDetailedCleanup?: boolean;
  // Parallel processing (only for non-local APIs: Claude, OpenAI)
  parallelWorkers?: number;  // 1-5, default 1 (sequential)
  useParallel?: boolean;     // Enable parallel processing
  // Test mode: only process first N chunks
  testMode?: boolean;
  testModeChunks?: number;  // Number of chunks to process in test mode
  // Enable standard AI cleanup (OCR fixes, formatting)
  enableAiCleanup?: boolean;
  // Simplify for language learners
  simplifyForLearning?: boolean;
  // Simplify mode: 'dejargon' (plain English for academic prose), 'destiffen' (natural
  // English for machine-translated prose), or 'learner' (B1-B2 language learner).
  // Legacy 'learning'/'plain' from older queued jobs are still accepted (mapped in the
  // main process's resolveSimplifyMode).
  simplifyMode?: 'dejargon' | 'destiffen' | 'learner' | 'learning' | 'plain';
  // Custom cleanup prompt (overrides default)
  cleanupPrompt?: string;
  // Additional instructions appended to the AI prompt
  customInstructions?: string;
}

// TTS Conversion job configuration
export interface TtsConversionConfig {
  type: 'tts-conversion';
  // 'auto' (default) resolves in the main process to the best device present —
  // CUDA when the GPU pack is installed, MPS on Apple Silicon, else CPU. Explicit
  // choices are honored exactly.
  device: 'auto' | 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;        // e.g., 'xtts'
  fineTuned: string;        // voice model e.g., 'ScarlettJohansson'
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
  outputFilename?: string;
  outputDir?: string;       // Custom output directory (empty = default)
  // Parallel processing options
  parallelWorkers?: number; // undefined = auto, 1 = sequential, 2-4 = parallel workers
  useParallel?: boolean;    // Enable parallel processing (default: false for backwards compat)
  parallelMode?: 'sentences' | 'chapters'; // Division strategy (default: sentences for fine-grained)
  // Bilingual mode for language learning audiobooks
  bilingual?: {
    enabled: boolean;
    pauseDuration?: number;  // Seconds between source and target (default 0.3)
    gapDuration?: number;    // Seconds between pairs (default 1.0)
  };
  // Skip assembly - for dual-voice bilingual workflows where assembly happens after
  // both source and target TTS jobs complete
  skipAssembly?: boolean;
  // Resume info (saved after prep for resume capability)
  resumeInfo?: TtsResumeInfo;
  // Clean session - delete any existing e2a sessions for this epub before starting
  // Used for language learning jobs which should always start fresh (no resume)
  cleanSession?: boolean;
  // User explicitly chose "Start fresh" in the wizard while a partial cached
  // session existed. Suppresses the queue's cached-session auto-resume AND
  // deletes the per-language project cache at job start, so the old render
  // can't silently resurface. An interrupted startFresh job still resumes its
  // OWN partial work on requeue (wasInterrupted wins over this flag).
  startFresh?: boolean;
  // Preserve paragraph boundaries as sentences (for language learning EPUBs)
  // When true, e2a treats each <p> tag as a sentence without re-splitting
  sentencePerParagraph?: boolean;
  // Skip reading heading tags (h1-h4) as chapter titles (for bilingual EPUBs)
  skipHeadings?: boolean;
  // Audio caching for cached-language TTS (bilingual tab)
  // When set, audio files are copied to this folder after TTS completes
  cacheAudioTo?: string;  // e.g., 'projects/book/output/audio/en'
  // Language code for cache metadata (needed for updating sentence cache JSON)
  cacheLanguage?: string;  // e.g., 'en'
  // Test mode - only process first N sentences (for quick validation)
  testMode?: boolean;
  testSentences?: number;  // Number of sentences to process in test mode
  // Final-assembly denoise (e2a FINAL_DENOISE): strip the faint background hiss that
  // hiss-bed-trained voices (Orpheus) reproduce, once, inside the final export encode.
  // Per-job choice from the wizard (default ON there when the engine is Orpheus).
  // false/absent = legacy byte-identical assembly.
  finalDenoise?: boolean;
}

// Translation job configuration (auto-detects source language)
export interface TranslationJobConfig {
  type: 'translation';
  chunkSize?: number;  // Default 2500 characters
  // AI Provider settings (per-job)
  aiProvider: AIProvider;
  aiModel: string;
  // Provider-specific settings
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
}

// Reassembly job configuration - reassembles incomplete e2a sessions
export interface ReassemblyJobConfig {
  type: 'reassembly';
  sessionId: string;
  sessionDir: string;
  processDir: string;
  outputDir: string;
  e2aTmpPath?: string;  // Path to e2a tmp folder from settings - app path is derived from this
  totalChapters?: number;  // Total chapters for progress display (excluding excluded ones)
  metadata: {
    title: string;
    author: string;
    year?: string;
    coverPath?: string;
    outputFilename?: string;
    // Extended metadata (applied with bundled ffmpeg)
    narrator?: string;
    series?: string;
    seriesNumber?: string;
    genre?: string;
    description?: string;
  };
  excludedChapters: number[];
  /** Optional RVC voice enhancement run inline before assembly (LEGACY / fallback
   *  path). The preferred flow is now a separate 'rvc-enhancement' job that writes
   *  enhanced sentences and hands the dir to this job via `sentencesDir`. This
   *  inline path only runs when `sentencesDir` is absent, so the two never
   *  double-process. voiceId is the RVC asset id; the backend resolves the model. */
  rvcEnhancement?: { voiceId: string; indexRate?: number; protectRate?: number; nSemitones?: number };
  /** A pre-rendered set of sentence files (e.g. produced by an upstream
   *  'rvc-enhancement' job in [library]/tmp). When set, assemble THIS set via
   *  e2a's --sentences_dir instead of the cached originals, then delete it after
   *  assembly (merge-and-delete). Takes precedence over `rvcEnhancement`. */
  sentencesDir?: string;
  /** Final-assembly denoise (e2a FINAL_DENOISE): strip the faint hiss bed that
   *  hiss-bed-trained voices (Orpheus) reproduce, inside the final export encode.
   *  false/absent = legacy byte-identical assembly (env var not set at all). */
  finalDenoise?: boolean;
}

// RVC voice-enhancement job — re-renders a session's sentences through an RVC
// voice into a scratch dir under [library]/tmp, then (via the queue) hands that
// dir to a downstream reassembly job. Runs as its own visible queue step with a
// per-chunk ETA, like TTS. session* may be empty at creation and discovered at
// runtime (chained after TTS), exactly like reassembly.
export interface RvcEnhancementJobConfig {
  type: 'rvc-enhancement';
  sessionId: string;
  sessionDir: string;
  processDir: string;
  /** RVC asset id; backend resolves it to the urvc model folder name. */
  voiceId: string;
  indexRate?: number;
  protectRate?: number;
  nSemitones?: number;
}

// Bilingual Cleanup job configuration - AI cleanup of extracted text
export interface BilingualCleanupJobConfig {
  type: 'bilingual-cleanup';
  projectId: string;
  projectDir: string;          // Path to project directory
  sourceEpubPath?: string;     // Path to source EPUB
  sourceLang: string;          // Source language code

  // AI settings
  aiProvider: AIProvider;
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  cleanupPrompt?: string;      // Custom cleanup prompt template

  // Test mode - only process first N chunks
  testMode?: boolean;
  testModeChunks?: number;

  // Cleanup options
  enableCleanup?: boolean;         // Enable standard AI cleanup (OCR fixes)
  simplifyForLearning?: boolean;   // Simplify text for language learners
  // Which simplify mode to use (see OcrCleanupConfig.simplifyMode). Legacy values accepted.
  simplifyMode?: 'dejargon' | 'destiffen' | 'learner' | 'learning' | 'plain';
  // Additional instructions appended to the AI prompt
  customInstructions?: string;
}

// Sentence splitting granularity for bilingual processing
export type SplitGranularity = 'sentence' | 'paragraph';

// Bilingual Translation job configuration - translate and create EPUB
export interface BilingualTranslationJobConfig {
  type: 'bilingual-translation';
  projectId?: string;           // Optional for mono translation
  projectDir?: string;          // Path to project directory (optional for mono)
  cleanedEpubPath?: string;     // Path to cleaned/simplified EPUB from cleanup step (optional - uses epubPath if not set)
  sourceLang: string;
  targetLang: string;
  title?: string;

  // AI settings
  aiProvider: AIProvider;
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  translationPrompt?: string;  // Custom translation prompt template
  customInstructions?: string;  // Additional instructions appended to the translation prompt

  // Alignment verification
  autoApproveAlignment?: boolean;  // Skip preview if sentence counts match (default: true)

  // Sentence splitting granularity
  splitGranularity?: SplitGranularity;  // 'sentence' (default), 'paragraph' (fewer segments)

  // Test mode - limit sentences for faster testing
  testMode?: boolean;
  testModeChunks?: number;  // Number of chunks to process in test mode

  // Mono translation - full book translation to single language (not bilingual interleave)
  // When true, translates entire book and outputs _translated.epub
  monoTranslation?: boolean;
}

// Bilingual Assembly job configuration - combines dual-voice TTS outputs
export interface BilingualAssemblyJobConfig {
  type: 'bilingual-assembly';
  projectId: string;
  sourceSentencesDir: string;  // Directory with source language sentence audio files
  targetSentencesDir: string;  // Directory with target language sentence audio files
  sentencePairsPath: string;   // Path to sentence_pairs.json
  outputDir: string;           // Where to save M4B and VTT
  pauseDuration?: number;      // Seconds between source and target (default 0.3)
  gapDuration?: number;        // Seconds between pairs (default 1.0)
  // Output naming with language suffix
  outputName?: string;         // Custom output name (e.g., "My Book [Bilingual EN-DE]")
  sourceLang?: string;         // Source language code (e.g., 'en')
  targetLang?: string;         // Target language code (e.g., 'de')
  title?: string;              // Book/article title for naming
  // BFP path for saving bilingual audio path to book project
  bfpPath?: string;
  // Assembly pattern for cached audio (interleaved or sequential)
  pattern?: 'interleaved' | 'sequential';
  // Use cached audio directories (from audiobooks/{book}/audio/{lang}/)
  useCachedAudio?: boolean;
  // Audiobook folder for cached audio lookup
  audiobookFolder?: string;
}

// Video Assembly job configuration - renders subtitle video from M4B + VTT
export interface VideoAssemblyJobConfig {
  type: 'video-assembly';
  projectId: string;
  bfpPath: string;
  mode: 'bilingual' | 'monolingual';
  m4bPath: string;
  vttPath: string;
  sentencePairsPath?: string;  // bilingual only
  title: string;
  sourceLang: string;
  targetLang?: string;         // bilingual only
  resolution: '480p' | '720p' | '1080p';
  outputFilename?: string;          // Custom filename (without extension)
}

// Audiobook job configuration - master container for audiobook production workflows
// This job type doesn't run any processing itself; it groups sub-jobs (cleanup, TTS)
export interface AudiobookJobConfig {
  type: 'audiobook';
}

// Generate-sentences job configuration — transcribe an audiobook m4b into a synced
// VTT with Whisper and link it to the ONE variant it describes.
export interface GenerateSentencesJobConfig {
  type: 'generate-sentences';
  projectId: string;
  variantId: string;
  /** Absolute path to the audiobook m4b to transcribe. */
  m4bPath: string;
  /** Whisper model id (small | medium | large-v3 | distil-large-v3). */
  modelId: string;
  /** Human-readable model name for the queue row (e.g. "Medium"). */
  modelLabel?: string;
  /** ISO language code, or 'auto' (default). */
  language?: string;
  /** Alignment method: 'whisper' transcribes audio; 'epub-align' force-aligns the project's ebook text to the audio (accurate text). Absent = 'whisper'. */
  method?: 'whisper' | 'epub-align';
  /** When method='epub-align', the ebook ProjectVariant.id to align against. */
  epubVariantId?: string;
}

export type BookAnalysisSource =
  | { kind: 'document'; epubPath: string }
  | { kind: 'audiobook'; projectId: string; variantId: string };

// Book Analysis job configuration
export interface BookAnalysisConfig {
  type: 'book-analysis';
  projectDir: string;
  /** The exact source identity. Audiobook paths are deliberately not accepted
   *  from the renderer; the main process resolves projectId + variantId through
   *  manifest.json immediately before analysis. */
  source: BookAnalysisSource;
  // AI Provider settings (per-job)
  aiProvider: AIProvider;
  aiModel: string;
  // Provider-specific settings (only the relevant one is used)
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  // Analysis categories
  categories: Array<{
    id: string;
    name: string;
    description: string;
    color: string;
    enabled: boolean;
  }>;
  // Test mode
  testMode?: boolean;
  testModeChunks?: number;
  // Durable descriptor of which project version this analysis targets. Stamped
  // into the written report so its version association sticks permanently.
  target?: { versionId: string; versionType: string; versionLabel: string };
}

// Resume info for TTS jobs - allows resuming interrupted conversions
export interface TtsResumeInfo {
  sessionId: string;           // e2a session UUID
  sessionDir: string;          // Full path to session directory
  processDir: string;          // Full path to process directory
  totalSentences: number;      // Total sentences in book
  totalChapters: number;       // Total chapters
  chapters: ChapterSentenceRange[]; // Chapter boundaries for assembly
  language: string;            // Language used
  voice?: string;              // Voice model used
  ttsEngine?: string;          // TTS engine used
  createdAt: string;           // ISO timestamp when session started
}

// Chapter sentence range for resume
export interface ChapterSentenceRange {
  chapter_num: number;         // 1-indexed
  sentence_start: number;      // 0-indexed
  sentence_end: number;        // 0-indexed, inclusive
  sentence_count: number;
}

// Original render settings a partial session was produced with, read back from
// session_state.json so a Continue pre-fills the wizard with what the user ran before.
export interface ResumeRenderSettings {
  ttsEngine?: string;
  fineTuned?: string;          // e2a's term for the voice
  device?: string;
  language?: string;
  speed?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  enableTextSplitting?: boolean;
}

// Resume check result from e2a
export interface ResumeCheckResult {
  success: boolean;
  complete?: boolean;          // All sentences already done
  error?: string;
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  sourceEpubPath?: string;
  totalSentences?: number;
  totalChapters?: number;
  completedSentences?: number;
  missingSentences?: number;
  missingIndices?: number[];
  missingRanges?: MissingSentenceRange[];
  progressPercent?: number;
  chapters?: ChapterSentenceRange[];
  metadata?: { title?: string; creator?: string; language?: string };
  // Original render settings + RVC-enhancement config from the previous run (Continue pre-fill).
  renderSettings?: ResumeRenderSettings;
  rvcEnhancement?: {
    enabled: boolean;
    voiceId: string;
    indexRate?: number;
    protectRate?: number;
    nSemitones?: number;
  };
  warnings?: string[];
}

// Missing sentence range for parallel workers
export interface MissingSentenceRange {
  start: number;
  end: number;
  count: number;
}

// Queue state
export interface QueueState {
  jobs: QueueJob[];
  isRunning: boolean;         // Is the queue actively processing?
  currentJobId: string | null;
}

// Progress update from IPC
export interface QueueProgress {
  jobId: string;
  type: JobType;
  phase: string;
  progress: number;           // 0-100
  message?: string;
  currentChunk?: number;      // Current chunk (1-indexed, job-wide)
  totalChunks?: number;       // Total chunks in entire job
  currentChapter?: number;
  totalChapters?: number;
  outputPath?: string;        // Path to output file (available during processing for diff view)
  // Timing data for dynamic ETA calculation
  chunksCompletedInJob?: number;  // Chunks completed so far (0-indexed)
  totalChunksInJob?: number;      // Total chunks in entire job
  chunkCompletedAt?: number;      // Timestamp when last chunk completed
  completedInSession?: number;    // Chunks completed in THIS session only (excludes checkpoint)
}

// Job result from IPC
export interface JobResult {
  jobId: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  // Copyright detection for AI cleanup
  copyrightIssuesDetected?: boolean;
  copyrightChunksAffected?: number;
  // Content skips detection for AI cleanup
  contentSkipsDetected?: boolean;
  contentSkipsAffected?: number;
  // Translation chunks that failed and kept original (untranslated) text
  translationFailedChunks?: number;
  // Path to JSON file containing skipped chunk details
  skippedChunksPath?: string;
  // Analytics data (TTS or cleanup job)
  analytics?: any;
  // RVC enhancement analytics (present when an RVC pass ran inside a TTS job);
  // persisted as a separate 'rvc' entry, not merged into the TTS analytics.
  rvcAnalytics?: any;
  // TTS session info (for caching after completion)
  sessionId?: string;
  sessionDir?: string;
  // Stop/resume support for TTS jobs
  wasStopped?: boolean;          // True if job was stopped by user (can be resumed)
  stopInfo?: {
    sessionId?: string;
    sessionDir?: string;
    processDir?: string;
    completedSentences?: number;
    totalSentences?: number;
    stoppedAt?: string;
  };
}

// Skipped chunk data structure (matches ai-bridge.ts)
export interface SkippedChunk {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number (e.g., "Chunk 5/121")
  totalChunks: number;         // Total chunks in the job
  reason: 'copyright' | 'content-skip' | 'ai-refusal' | 'truncated' | 'error' | 'repetition';
  text: string;
  aiResponse?: string;
}

// Audiobook metadata for TTS jobs
export interface AudiobookMetadata {
  title?: string;
  bookTitle?: string;  // Actual book title for m4b metadata (title is used for queue display)
  author?: string;
  year?: string;
  coverPath?: string;      // Path to cover image file
  outputFilename?: string; // Custom output filename (e.g., "My Book.m4b")
  // Placeholder marker for TTS/assembly jobs that are waiting for previous step to complete
  // When set, the job is skipped during queue processing until the previous step updates it
  bilingualPlaceholder?: {
    role: 'source' | 'target' | 'assembly';
    projectId: string;
    targetLang?: string;  // Only for source role
  };
  // Bilingual workflow state (for chaining TTS jobs)
  bilingualWorkflow?: {
    role: 'source' | 'target';
    targetEpubPath?: string;
    targetConfig?: any;
    sourceSentencesDir?: string;
    assemblyConfig?: {
      projectId: string;
      audiobooksDir: string;
      sentencePairsPath: string;
      pauseDuration: number;
      gapDuration: number;
      // Output naming with language suffix
      title?: string;
      sourceLang?: string;
      targetLang?: string;
      bfpPath?: string;
    };
  };
}

// Create job request
export interface CreateJobRequest {
  type: JobType;
  epubPath?: string;  // Optional for bilingual-assembly and audiobook jobs
  config?: Partial<OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | RvcEnhancementJobConfig | ReassemblyJobConfig | BilingualCleanupJobConfig | BilingualTranslationJobConfig | BilingualAssemblyJobConfig | VideoAssemblyJobConfig | AudiobookJobConfig | BookAnalysisConfig | GenerateSentencesJobConfig>;
  metadata?: AudiobookMetadata;
  // Resume info for continuing interrupted TTS jobs
  resumeInfo?: ResumeCheckResult;
  // BFP project path for analytics saving
  bfpPath?: string;
  // Bilingual project directory
  projectDir?: string;
  // Job grouping for multi-step workflows
  parentJobId?: string;
  workflowId?: string;
}

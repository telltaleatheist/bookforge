/**
 * Queue Types - Type definitions for the unified processing queue
 */

import { AIProvider } from '../../../core/models/ai-config.types';
import type { PassJobConfig } from '@shared/processing/pass-types';
import type {
  ArtifactRef, FoundryJobLineage, JobType as EngineJobType,
} from '@shared/queue/engine-types';

/**
 * Minimum span, in seconds, before a chunk-rate window is reported at all.
 *
 * Batched engines emit progress in bursts of 64, and consecutive bursts can land only
 * ~25s apart when two batches' emits coalesce — timing that single gap gives 143
 * chunks/min for a job actually running at ~70. A window shorter than roughly one batch
 * cycle cannot average out that quantization, so it is not shown. The window only ever
 * widens after that, so the estimate tightens as the job runs.
 */
export const RATE_WINDOW_MIN_SECONDS = 45;

/**
 * Which of the two AI-cleanup passes to run. Independent products, not degrees of
 * one setting: 'ocr' repairs scanner damage and stops (repaired.epub — faithful
 * text, markers and curly quotes intact); 'tts' runs only the deterministic prep
 * (footnote markers, quotes, number expansion → cleaned.epub, seconds not hours);
 * 'both' runs the repair then the prep.
 */
export type CleanupStages = 'ocr' | 'tts' | 'both';

/**
 * Job types supported by the queue: THE ENGINE'S LIST, plus the one this side
 * has that the engine does not.
 *
 * ── Why this is derived and not written out ─────────────────────────────────
 *
 * It WAS written out — the engine's fourteen members, restated here by hand — and
 * on 2026-08-19 that cost main. `foundry-job` was added to the engine's union
 * for the centralized queue seam (aa3c6dbb) and this copy did not get it, so the
 * two assignments below (`QueueJob.type`, `CreateJobRequest.type`) stopped
 * compiling and the Angular bundle failed outright. The app did not start on any
 * machine that pulled it. bookforge-mac-2 found it in seven seconds of `ng build`
 * and, correctly, refused to paper over it with a fifteenth hand-copied member.
 *
 * A duplicated wire type is a lockstep contract with nothing enforcing the step,
 * and this file's own comment at `CreateJobRequest.config` already said so about
 * the same class of bug: "One list, in one place." Now it is one list.
 *
 * `audiobook` IS THIS SIDE'S OWN and is why the type is a union rather than a
 * re-export: it names a renderer-only row the engine never schedules, and it is
 * read in ~50 places here. It has no engine member and must not gain one.
 */
export type JobType = EngineJobType | 'audiobook';

/** The job types that are processing passes, for a runtime membership test. */
export const PASS_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'simplify', 'translate-pass', 'footnote-refs',
]);

/**
 * The retired job types moved to shared/queue/engine-types.ts with the queue
 * itself: it is the ENGINE that meets a persisted row of a dead type, on load,
 * in main, and fails it with the sentence that explains it. A second copy here
 * would be a list the renderer could not act on and the two could disagree.
 */

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

// Per-stage progress for a multi-step job (epub-align, reassembly). Rendered as
// stacked bars, one per stage, each 0-100% within itself — see electron/job-stages.ts
// for the weighted-master model these come from.
export type JobStageStatus = 'pending' | 'running' | 'complete';
export interface JobStageProgress {
  name: string;
  label: string;
  pct: number;            // 0-100 within this stage
  status: JobStageStatus;
  /**
   * Normalized share of the whole run (all stages sum to 1), when the bridge declares
   * relative stage costs. Absent on stage lists derived in the renderer from a job's
   * phase fields, which carry no such information — those are treated as equal-cost.
   */
  weight?: number;
}

/**
 * Progress WITHIN the MLX batch a TTS worker is decoding right now. Mirrors
 * ActiveBatchProgress in electron/mlx-batch-progress.ts (the renderer can't import
 * from electron/, same pattern as JobStageProgress).
 *
 * On Mac, Orpheus renders ~96 chunks as ONE atomic 5-7 minute decode whose files all
 * land at the end, so the chunk bar is frozen for the whole batch. This is what moves
 * during that window. Every field is what the engine actually reported — nothing is
 * defaulted, and the whole object is absent when no batch is decoding.
 */
export interface ActiveBatchProgress {
  rowsTotal: number;
  rowsDone?: number;
  tokenStep: number;
  tokenCap?: number;
  /** 0-1, monotone within a batch. Absent when the engine gave no basis for one. */
  fraction?: number;
  batchNo?: number;
  batchCount?: number;
  /**
   * When THIS batch's decode began (epoch ms). Timed separately from the step:
   * the step's elapsed folds in the model load and every batch before this one,
   * so it cannot say whether the decode running right now is on its usual
   * cadence. Absent against an engine build that reported no batch.
   */
  startedAt?: number;
}

// Base job interface
export interface QueueJob {
  id: string;
  type: JobType;
  epubPath?: string;      // Optional for bilingual-assembly jobs
  epubFilename?: string;  // Optional for bilingual-assembly jobs
  status: JobStatus;
  progress?: number;          // 0-100 percentage
  // Stacked per-stage bars supplied by the bridge running this job (generate-sentences,
  // reassembly, tts-conversion). Absent for job types whose bridge doesn't report
  // stages — those derive their bars from type-specific fields instead (see job-stages.ts).
  stages?: JobStageProgress[];
  // What the RUNNING stage is doing right now, when the stage's own percentage can't
  // move for minutes. An MLX batch renders 7-23 sentences as one atomic unit, so this
  // ("Rendering 21 sentences together · 2,949 tokens") is the only proof of life
  // between one bucket landing and the next.
  stageDetail?: string;
  // Live progress inside the MLX batch being decoded. Unlike stageDetail this is
  // BLANKED when the bridge reports none — a finished batch must not leave a full
  // secondary bar sitting under the chunk bar.
  activeBatch?: ActiveBatchProgress;
  error?: string;             // Error message if status is 'error'
  outputPath?: string;        // Path to the file this job produced
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
  // Real sentences across all chunks of the book. A chunk holds a variable number of them
  // (whatever the packer's character budget fitted), so this is counted, never assumed.
  totalRawSentencesInJob?: number;
  // Whole-book word and character totals. Characters are what the ETA divides: chunks are
  // packed to a character budget, so remaining CHUNKS overstates the tail (the last chunk
  // of every chapter is a short one), and characters are also the best predictor of the
  // audio duration that is the real work. Words exist for the readout only.
  totalRawWordsInJob?: number;
  totalRawCharsInJob?: number;
  chunkCompletedAt?: number;      // Timestamp of last chunk completion
  // Timestamp of the FIRST chunk completion of this session. Rate must be measured from
  // here, not startedAt: job-start elapsed includes model load / pass-1 planning, which
  // inflates time-per-chunk and then dilutes as work accumulates, so an ETA based on
  // startedAt drifts downward on every refresh instead of holding steady.
  firstChunkCompletedAt?: number;
  /**
   * Session chunk count AT the instant firstChunkCompletedAt was stamped. Required to
   * measure a rate: Orpheus flushes progress in batches of 64, so the first observation
   * can already be 128 chunks in. Crediting all of them to the window that opened at
   * that instant overstates the rate by ~6x. Written atomically with the stamp.
   */
  chunksAtFirstStamp?: number;
  progressMessage?: string;       // Current progress message
  // Cleanup pass-1 phase (the simplify / bilingual-cleanup path). 'analyzing' = pre-chunk planning
  // (footnote/hyphen/pre-scan); the front end shows a phase-1 bar instead of the ETA.
  cleanupPhase?: 'loading' | 'analyzing' | 'processing' | 'saving' | 'complete' | 'error';
  // Parallel TTS worker progress
  parallelWorkers?: ParallelWorkerProgress[];
  // Resume state for interrupted TTS jobs
  isResumeJob?: boolean;                     // Is this a resume job?
  resumeCompletedSentences?: number;         // Sentences already completed before resume
  resumeMissingSentences?: number;           // Sentences to process in this resume
  // Session progress tracking (for accurate ETA on resume jobs)
  chunksDoneInSession?: number;              // Chunks completed in THIS session only
  rawSentencesDoneInSession?: number;        // EXACT real sentences rendered THIS session (precise sentences/min; absent → chunk×average estimate)
  rawWordsDoneInSession?: number;            // EXACT words rendered THIS session (drives words/min)
  rawCharsDoneInSession?: number;            // EXACT characters rendered THIS session (drives the ETA)
  /**
   * Seconds of audio produced per character of text, sampled from this session's rendered
   * FLACs by the bridge. Multiplied by the measured chars/min it gives the REALTIME FACTOR
   * — the only speed figure comparable across books and voices, because audio is the unit
   * of work. Absent until enough has been sampled; the readout must show the text rates
   * alone rather than a zero.
   */
  audioSecondsPerChar?: number;
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
  // Absolute project DIRECTORY, for analytics saving.
  // Still named bfpPath because that is the key persisted in queue.json.
  bfpPath?: string;
  // Analytics data (from completed job)
  analytics?: any;
  // TTS phase tracking (for showing TTS + Assembly as separate progress)
  // Mirrors AggregatedProgress.phase. 'error' and 'stopped' were reachable long before
  // they were declared here — the assignment casts — so a stopped job wrote a ttsPhase
  // the type said could not exist.
  ttsPhase?: 'preparing' | 'converting' | 'assembling' | 'complete' | 'error' | 'stopped';
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
  /**
   * What the finished job has to SAY, in whole sentences, when succeeding was not
   * the whole story.
   *
   * A processing pass can succeed and still owe the user an explanation — most of
   * all when it recorded no ledger row, so the book gains no "Review changes" /
   * "Compare books" line and the absence reads as a bug. The pass writes that
   * sentence (`PassJobResult.ledgerRefusal`, and beside it `summary` and
   * `narrationCarryNote`); this is where it survives long enough to be read.
   *
   * Persisted with the row, so it outlives the completion event that carried it —
   * the user who comes back to a finished queue an hour later is exactly the one
   * who needs it. A row with these is NOT failed: it is complete, and it is
   * rendered as complete.
   */
  completionNotes?: string[];
}

/**
 * A processing pass's configuration, as the queue persists it.
 *
 * `type` is the queue's discriminator and `kind` is the pass — they carry the
 * same fact in the two vocabularies that already exist (queue.json's job types
 * and the manifest's appliedPasses kinds), and the planner sets both. The rest is
 * the plan, verbatim: a pass job is not re-planned when it runs.
 */
export type ProcessingPassJobConfig = PassJobConfig & {
  // The three that exist. The retired document-pipeline spellings were listed
  // here long after shared/processing/pass-types.ts had narrowed them away, so
  // the union claimed four members no code could produce.
  type: 'simplify' | 'translate-pass' | 'footnote-refs';
};

// Job configuration union type
/**
 * A queued conversion. Defined in `../jobs/vlm-convert-job.ts` beside the code
 * that runs it, and re-exported here so the union has one spelling — the job
 * type owns its own shape rather than having it declared away from its runner.
 */
export type { VlmConvertJobConfig } from '../jobs/vlm-convert-job';
import type { VlmConvertJobConfig } from '../jobs/vlm-convert-job';

export type JobConfig = ProcessingPassJobConfig | TtsConversionConfig | TranslationJobConfig | FinalDenoiseJobConfig | RvcEnhancementJobConfig | ReassemblyJobConfig | BilingualCleanupJobConfig | BilingualTranslationJobConfig | BilingualAssemblyJobConfig | VideoAssemblyJobConfig | AudiobookJobConfig | BookAnalysisConfig | GenerateSentencesJobConfig | VlmConvertJobConfig;

// Deleted block example for detailed cleanup mode
export interface DeletedBlockExample {
  text: string;
  category: 'header' | 'footer' | 'page_number' | 'custom' | 'block';
  page?: number;
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
  // Final-audio denoise: strip the faint background hiss that hiss-bed-trained
  // voices (Orpheus) reproduce — a block-based roformer pass over the rendered
  // sentences, run after generation and before any RVC pass / assembly.
  // Per-job choice from the wizard (default ON there when the engine is Orpheus).
  // false/absent = zero behavioral change.
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
  /** Final-audio denoise: block-based roformer pass over the session's sentences
   *  BEFORE assembly (and before any inline RVC pass — denoise first, then RVC).
   *  When `sentencesDir` is set, the upstream rvc-enhancement job (which receives
   *  the same flag) already applied it. false/absent = zero behavioral change. */
  finalDenoise?: boolean;
  /** De-ring (OPT-IN): apply the session voice's per-voice post-render ffmpeg filter
   *  chain (the notch/comb that removes SNAC tonal ringing) at e2a's final encode. The
   *  backend resolves the actual chain from session provenance ONLY when this is true.
   *  Absent/false → no filter is passed. Per-job choice from the wizard (default OFF). */
  applyDeRing?: boolean;
  /** Assembly-time inter-sentence gap in seconds. Normalizes the silence between
   *  sentences on the RAW cached set before assembly (strips e2a's artificial trailing
   *  exact-zero pad and re-applies this much silence). When set, this value wins; when
   *  absent, the backend resolves the session voice's models.json default from
   *  provenance, and skips the step if that is unset too (no invented default). */
  sentenceGap?: number;
  /** File the finished M4B as a SECOND audiobook version of this book rather than
   *  replacing the project's one — set only for a run that converted sentences it
   *  did not itself render. The backend then names the file after the voice, spares
   *  the output folder's existing audiobooks, and writes a manifest variant instead
   *  of overwriting `outputs.audiobook`. See shared/queue/narration-run.ts. */
  registerAsNewVariant?: boolean;
  /** The RVC voice that second version is named after — its variant id, its filename
   *  and its narrator tag. Required whenever `registerAsNewVariant` is set. */
  rvcVoiceId?: string;
}

// RVC voice-enhancement job — re-renders a session's sentences through an RVC
// voice into a durable derived set inside the session, then (via the queue) hands
// that dir to the step behind it. Runs as its own visible queue step with a
// per-chunk ETA, like TTS. session* may be empty at creation and discovered at
// runtime (chained after TTS), exactly like reassembly.
//
// It reads EITHER the session's raw sentences or the denoise pass's output,
// whichever its parent step wrote: since 2026-08-29 the user chooses which of the
// two enhancement passes runs first (shared/queue/narration-run.ts).
export interface RvcEnhancementJobConfig {
  type: 'rvc-enhancement';
  sessionId: string;
  sessionDir: string;
  processDir: string;
  /** RVC asset id; backend resolves it to the urvc model folder name. */
  voiceId: string;
  indexRate?: number;
  /** Consonant/breath protection, on an INVERTED scale: lower protects more and
   *  0.5 disables protection. It does nothing at all when `indexRate` is 0. */
  protectRate?: number;
  nSemitones?: number;
  /** Pitch-extraction method (rmvpe|crepe|crepe-tiny). Absent = urvc's own default,
   *  which is a real answer here and never filled in on the way through. */
  f0Method?: string;
  /** f0 analysis hop in samples (1–512). Read ONLY by the crepe family — rmvpe
   *  ignores it. Absent = urvc's own default. */
  hopLength?: number;
  /** The set this pass converts, when a denoise produced it and no parent step
   *  hands it over. Absent = the session's raw cached sentences. */
  sentencesDir?: string;
  /**
   * NOT A PASS THIS JOB RUNS ANY MORE — the conversion used to denoise its own
   * input, which is how "denoise before RVC" was realised before the order became
   * the user's choice. Declared only so a row queued before the change is REFUSED
   * by name (electron/rvc-job.ts) rather than silently converting raw audio.
   */
  finalDenoise?: boolean;
  /** Inter-sentence gap, baked in HERE when this pass reads the RAW sentences,
   *  i.e. when it is the first enhancement pass. Absent when a denoise runs in
   *  front of it — that pass owns the gap. See electron/sentence-gap.ts. */
  sentenceGap?: number;
}

/**
 * Final-audio denoise as its own job — the block-based roformer pass over a
 * session's sentences, producing the durable set
 * `<processDir>/chapters/sentences-denoised/` that a downstream reassembly job
 * assembles (and does NOT delete).
 *
 * It was a flag on the reassembly job until 2026-08-29, which made the whole
 * assembly a GPU step: the card stayed held through the chapter combine and the
 * AAC encode, neither of which touches it. session* may be empty at creation and
 * discovered at runtime (chained after TTS), exactly like reassembly.
 */
export interface FinalDenoiseJobConfig {
  type: 'final-denoise';
  sessionId: string;
  sessionDir: string;
  processDir: string;
  /** The set this pass denoises, when a voice conversion produced it and no
   *  parent step hands it over. Absent = the session's raw cached sentences. */
  sentencesDir?: string;
  /** Inter-sentence gap in seconds, baked in by the gap pass that runs in front
   *  of the roformer — and ONLY when this pass reads the raw sentences. Absent =
   *  the session's provenance decides. */
  sentenceGap?: number;
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
  // Which simplify mode to use. Legacy values accepted (mapped in the main process).
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
  // Project directory — where the finished bilingual audio is copied to book project
  bfpPath?: string;
  // Assembly pattern for cached audio (interleaved or sequential)
  pattern?: 'interleaved' | 'sequential';
  // Use cached audio directories (from audiobooks/{book}/audio/{lang}/)
  useCachedAudio?: boolean;
  // Audiobook folder for cached audio lookup
  audiobookFolder?: string;
}

// Video Assembly job configuration - renders subtitle video from M4B + VTT
//
// Deliberately carries NO m4bPath/vttPath. This job is queued alongside the assembly
// job that PRODUCES those files, so at queue time they do not exist yet and cannot be
// verified; the renderer used to invent them as `${bfpPath}/output/audiobook.m4b` and
// `.../bilingual-<pair>.m4b`, which for the monolingual pipeline was never the real
// name (the assembler writes "{title}.m4b"). video-assembly-bridge.resolveOutputPaths
// resolves both from `bfpPath`/output at RUN time, when the files are actually there,
// and throws naming that directory when they are not.
export interface VideoAssemblyJobConfig {
  type: 'video-assembly';
  projectId: string;
  bfpPath: string;
  mode: 'bilingual' | 'monolingual';
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
  // A LABEL only — the row is found by jobId. Producers that do not know which
  // job type they are serving (ai-bridge's cleanupEpub runs for two of them)
  // omit it rather than naming one of them at random.
  type?: JobType;
  phase: string;
  progress: number;           // 0-100
  message?: string;
  /**
   * Stacked per-stage bars from the bridge running this job.
   *
   * A processing pass that owns several foundry stages reports one bar per stage
   * with that stage's own 0-100 (Render pages / Tesseract / OCR correction /
   * Detection). Absent means this producer has no breakdown to give — the row
   * keeps whatever bars it already had rather than being blanked, because a
   * one-off event (a download note) must not erase the run's progress.
   */
  stages?: JobStageProgress[];
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
  /**
   * Sentences a SUCCESSFUL job still owes the user — see QueueJob.completionNotes,
   * which is where these land. Built by `passResultNotes`
   * (shared/processing/pass-notes.ts) at every point a PassJobResult is consumed,
   * including main's `queue:job-complete` broadcast, so the fallback completion
   * signal carries them too.
   */
  completionNotes?: string[];
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
  // `Partial<JobConfig>` rather than the union re-listed by hand. The hand-copied
  // copy is why adding a job type compiled everywhere except the places that
  // create one — the same duplication that made buildJobConfig's return type go
  // stale. One list, in one place.
  config?: Partial<ProcessingPassJobConfig> | Partial<JobConfig>;
  metadata?: AudiobookMetadata;
  // Resume info for continuing interrupted TTS jobs
  resumeInfo?: ResumeCheckResult;
  // Absolute project DIRECTORY, for analytics saving.
  // Still named bfpPath because that is the key persisted in queue.json.
  bfpPath?: string;
  // Bilingual project directory
  projectDir?: string;
  /**
   * WHICH VERSION of the project's book this job's document is — the manifest
   * variant id.
   *
   * Owen, 2026-08-10: a project may hold several versions of one book. The path
   * says which FILE; this says which of the project's version records that file
   * is. Set by the button the user pressed — never derived on the far side,
   * where "the project's book" names two files and picking one is how a run
   * comes to be filed against the wrong edition.
   *
   * Optional because most job types are about a file and not about a version (an
   * M4B import, a bilingual assembly); absent means "this job is about no
   * version record", never "look one up".
   *
   * It replaced `familyId` in Wave 1 (2026-08-16), when the working chain was
   * retired.
   */
  variantId?: string;
  /**
   * WHAT THE FIRST STEP OF THIS RUN READS, when it is not the document above.
   *
   * The engine refuses a chain at COMPOSE time whose first step reads a kind its
   * source does not provide (`checkLineage`, electron/queue-engine.ts), and this
   * door handed it `{ kind: 'epub' }` for every job it ever queued — true of
   * everything that starts by reading a book, and false of a run that starts by
   * converting sentences a narration left cached weeks ago. Such a run is
   * refused before it can explain itself unless the caller says otherwise.
   *
   * ABSENT MEANS "this run starts by reading the document it names", which is
   * what it has always meant here — not "look one up". It is only ever consulted
   * for the step that has no parent; a request appended onto an existing run
   * reads that run's last step and this is ignored.
   */
  sourceRef?: ArtifactRef;
  // Job grouping for multi-step workflows
  parentJobId?: string;
  workflowId?: string;
  /**
   * Foundry ordered this run — which project, and which ledger step.
   *
   * Set only on the `type: 'audiobook'` MASTER of a composition (or on a
   * standalone request), because it is a fact about the run: the engine records
   * it on the JOB, and every step appended afterwards belongs to that same job.
   * See {@link FoundryJobLineage}.
   */
  foundry?: FoundryJobLineage;
}

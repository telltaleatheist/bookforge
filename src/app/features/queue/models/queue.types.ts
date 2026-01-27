/**
 * Queue Types - Type definitions for the unified processing queue
 */

import { AIProvider } from '../../../core/models/ai-config.types';

// Job types supported by the queue
export type JobType = 'ocr-cleanup' | 'tts-conversion' | 'translation' | 'reassembly';

// Job status
export type JobStatus = 'pending' | 'processing' | 'complete' | 'error';

// Parallel worker progress tracking
export type ParallelWorkerStatus = 'pending' | 'running' | 'complete' | 'error';

export interface ParallelWorkerProgress {
  id: number;
  sentenceStart: number;
  sentenceEnd: number;
  completedSentences: number;
  status: ParallelWorkerStatus;
  error?: string;
}

// Base job interface
export interface QueueJob {
  id: string;
  type: JobType;
  epubPath: string;
  epubFilename: string;
  status: JobStatus;
  progress?: number;          // 0-100 percentage
  error?: string;             // Error message if status is 'error'
  outputPath?: string;        // Path to output file (e.g., _cleaned.epub for OCR jobs)
  addedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  metadata?: AudiobookMetadata;
  // Job-specific configuration
  config?: JobConfig;
  // Progress tracking for ETA calculation
  currentChunk?: number;          // Current chunk (1-indexed, job-wide)
  totalChunks?: number;           // Total chunks in entire job
  currentChapter?: number;
  totalChapters?: number;
  chunksCompletedInJob?: number;  // Chunks completed so far
  totalChunksInJob?: number;      // Total chunks in entire job
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
  // Copyright issues detected during AI cleanup
  copyrightIssuesDetected?: boolean;
  copyrightChunksAffected?: number;
  // Content skips detected during AI cleanup (AI refused via [SKIP] marker)
  contentSkipsDetected?: boolean;
  contentSkipsAffected?: number;
  // Path to JSON file containing skipped chunk details
  skippedChunksPath?: string;
  // BFP project path for analytics saving
  bfpPath?: string;
  // Analytics data (from completed job)
  analytics?: any;
}

// Job configuration union type
export type JobConfig = OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | ReassemblyJobConfig;

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
  // Cleanup mode: 'structure' preserves HTML, 'full' sends HTML to AI for structural fixes
  cleanupMode?: 'structure' | 'full';
  // Test mode: only process first 5 chunks
  testMode?: boolean;
}

// TTS Conversion job configuration
export interface TtsConversionConfig {
  type: 'tts-conversion';
  device: 'gpu' | 'mps' | 'cpu';
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
  // Resume info (saved after prep for resume capability)
  resumeInfo?: TtsResumeInfo;
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
  metadata: {
    title: string;
    author: string;
    year?: string;
    coverPath?: string;
    outputFilename?: string;
    // Extended metadata (applied with m4b-tool)
    narrator?: string;
    series?: string;
    seriesNumber?: string;
    genre?: string;
    description?: string;
  };
  excludedChapters: number[];
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

// Resume check result from e2a
export interface ResumeCheckResult {
  success: boolean;
  complete?: boolean;          // All sentences already done
  error?: string;
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  totalSentences?: number;
  totalChapters?: number;
  completedSentences?: number;
  missingSentences?: number;
  missingIndices?: number[];
  missingRanges?: MissingSentenceRange[];
  progressPercent?: number;
  chapters?: ChapterSentenceRange[];
  metadata?: { title?: string; creator?: string; language?: string };
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
  // Path to JSON file containing skipped chunk details
  skippedChunksPath?: string;
  // Analytics data (TTS or cleanup job)
  analytics?: any;
}

// Skipped chunk data structure (matches ai-bridge.ts)
export interface SkippedChunk {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number (e.g., "Chunk 5/121")
  totalChunks: number;         // Total chunks in the job
  reason: 'copyright' | 'content-skip' | 'ai-refusal';
  text: string;
  aiResponse?: string;
}

// Audiobook metadata for TTS jobs
export interface AudiobookMetadata {
  title?: string;
  author?: string;
  year?: string;
  coverPath?: string;      // Path to cover image file
  outputFilename?: string; // Custom output filename (e.g., "My Book.m4b")
}

// Create job request
export interface CreateJobRequest {
  type: JobType;
  epubPath: string;
  config?: Partial<OcrCleanupConfig | TtsConversionConfig | TranslationJobConfig | ReassemblyJobConfig>;
  metadata?: AudiobookMetadata;
  // Resume info for continuing interrupted TTS jobs
  resumeInfo?: ResumeCheckResult;
  // BFP project path for analytics saving
  bfpPath?: string;
}

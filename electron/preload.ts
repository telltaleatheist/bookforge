import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  ComponentStatus,
  SystemProfile,
  InstallResult,
  InstallProgress,
  EnvDiagnosticResult,
} from './components/component-types';
import type { DoctorReport } from './doctor';
import type { ComponentUpdateStatus } from './update/component-updater';
import type { StartupUpgradeReport } from './components/startup-upgrade-check';
import type { StarterStatus } from './update/starter-library';
import type { OrpheusBatchConfig } from './orpheus-batch';
import type { EpubPreservingEdits } from './epub-processor';
import type { WhisperModelStatus, WhisperDownloadProgress } from './whisper-models';
import type { CorrectSentencesSession, GenerateCandidatesResult } from './correct-sentences-bridge';
import type { JobStageProgress } from './job-stages';
// The Adopt door's wire shapes, imported rather than re-declared for the reason
// stated below the pass types: this module compiles to nothing at runtime, so a
// second spelling of them here could only ever be a spelling that drifts.
import type {
  AdoptableFoundryProject as FoundryAdoptableProject,
  BlockedFoundryProject as FoundryBlockedProject,
  AdoptResult as FoundryAdoptResult,
  FoundryRefreshResult,
  FoundryStandaloneSource,
} from '../shared/foundry/adopt-types';
// Types only — this module compiles to nothing at runtime, so the wire shapes are
// imported rather than re-declared (see shared/processing/pass-types.ts).
import type {
  PassDiffEntry,
  PassJobConfig,
  PassJobResult,
  ProcessingChainPlan,
  ProcessingChainRequest,
} from '../shared/processing/pass-types';
import type { BookResetSummary } from '../shared/processing/reset-book';
import type { NarrateTarget as FoundryNarrateTarget } from '../shared/queue/narrate-target';
import type {
  QueueNotice,
  QueueSnapshot,
  QueueJob as QueueEngineJob,
  QueueStep as QueueEngineStep,
} from '../shared/queue/engine-types';
import type {
  AppendStepSpec as QueueAppendStepSpec,
  JobSpec as QueueJobSpec,
  StepFinished as QueueStepFinished,
  StepSpec as QueueStepSpec,
} from './queue-engine';

/** Which run, or which step of one, a queue command is about. */
interface QueueTarget { jobId?: string; stepId?: string }
import type {
  VlmConvertRequest,
  VlmConvertResult,
  VlmEndpointCheck,
  VlmEndpointConfig,
} from '../shared/vlm/conversion';
import type {
  CrucibleCoordinationMap,
  CrucibleCoordinationState,
} from '../shared/crucible/coordinate-wire';
import type {
  CrucibleActivityView,
  CrucibleEngineSettings,
  CrucibleEngineSettingsPatch,
  CrucibleEngineSettingsRefusal,
  CrucibleModelRow,
  CrucibleCapabilityView,
  CrucibleProbeResult,
  CrucibleServersView,
  CrucibleUpstreamName,
  CrucibleUpstreamProbe,
  CrucibleUpstreamTestResult,
  CrucibleModuleProgress,
  PairingResult,
  CrucibleServerRow,
  RoutingView as CrucibleRoutingView,
  WaitForDefault as CrucibleWaitForDefault,
} from '../shared/crucible/settings-wire';
import type {
  CrucibleCatalogView,
  CruciblePullProgress,
  CrucibleRemovalPrompt,
  CrucibleSubjectKind,
} from '../shared/crucible/catalog-wire';
import type {
  CrucibleHostFacts,
  CrucibleHostRefusal,
  CrucibleInstallPlan,
  CrucibleInstallProgress,
} from '../shared/crucible/install-wire';
import type {
  CrucibleUninstallPlan,
  CrucibleUninstallRefusalCode,
} from '../shared/crucible/uninstall-wire';
import type { VlmReadingsBank } from '../shared/vlm/readings-bank';
import type { NarrationDeletions, NarrationState } from '../shared/vlm/narration-deletions';
import type {
  BookChapterAddResult, BookChapterRenameResult, BookChapterTitles,
} from '../shared/vlm/chapter-titles';
import type { TextLayerReport } from '../shared/pdf/text-layer';
import type { VoicePickerDto } from '../shared/tts/voice-picker-dto';
import type { DocumentStageProgressEvent } from '../shared/document/pipeline-types';

/**
 * Preload script - Exposes safe IPC methods to renderer process
 */

export interface ProjectSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
  /**
   * Present on a SUCCESSFUL save that nonetheless did not write the page and
   * block deletions, because this window was never given the project's own —
   * they were recorded against a layout of the book this build no longer
   * produces (`electron/legacy-epub-layout.ts`).
   *
   * Success and this field together are not a contradiction: the metadata, the
   * highlights and everything that names no position DID go to disk. Only the
   * positional records were left alone, and a window that gets this must say so
   * rather than letting the user believe the strikes they just made are on file.
   */
  staleLayoutRefusal?: string;
}

export interface ProjectLoadResult {
  success: boolean;
  canceled?: boolean;
  data?: unknown;
  filePath?: string;
  error?: string;
}

export interface OpenPdfResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

export interface PdfAnalyzeResult {
  success: boolean;
  data?: {
    blocks: Array<{
      id: string;
      page: number;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      font_size: number;
      font_name: string;
      char_count: number;
      region: string;
      category_id: string;
      is_bold: boolean;
      is_italic: boolean;
      is_superscript: boolean;
      is_image: boolean;
      line_count: number;
    }>;
    categories: Record<string, {
      id: string;
      name: string;
      description: string;
      color: string;
      block_count: number;
      char_count: number;
      font_size: number;
      region: string;
      sample_text: string;
    }>;
    page_count: number;
    page_dimensions: Array<{ width: number; height: number }>;
    pdf_name: string;
    // Non-fatal analysis problems (e.g. image extraction failed) — surface to the user
    warnings?: string[];
  };
  error?: string;
}

// Plugin system types
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  available: boolean;
  availabilityDetails?: {
    available: boolean;
    version?: string;
    path?: string;
    error?: string;
    installInstructions?: string;
  };
  settingsSchema: Array<{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'select' | 'path';
    label: string;
    description?: string;
    default: unknown;
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
    placeholder?: string;
  }>;
}

export interface PluginProgress {
  pluginId: string;
  operation: string;
  current: number;
  total: number;
  message?: string;
  percentage?: number;
}

/**
 * What is known about one audiobook, and what is still being worked out.
 *
 * `deriving` is a THIRD state and the whole reason this has one: an audiobook
 * whose transcript has not been checked yet is not an audiobook without one, and
 * the Versions page must never offer to overwrite a transcript it has not looked
 * for. The shape is electron/versions-page-data.ts's `AudiobookFacts`, restated
 * here because preload declares its own surface.
 */
export interface VersionsAudiobookFacts {
  variantId: string;
  transcript: 'eligible' | 'ineligible' | 'deriving';
  cueCount: number | null;
  reportStatus: 'valid' | 'stale' | 'missing' | 'deriving';
  analyzedAt: string | null;
  flagCount: number | null;
}

export interface SkippedChunk {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;  // 1-based overall chunk number (e.g., "Chunk 5/121")
  totalChunks: number;         // Total chunks in the job
  reason: 'copyright' | 'content-skip' | 'ai-refusal';
  text: string;
  aiResponse?: string;
}

export interface TextSpan {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
  font_name: string;
  is_bold: boolean;
  is_italic: boolean;
  baseline_offset: number;
  block_id: string;
}

// Character class for text matching
type CharClass = 'digits' | 'uppercase' | 'lowercase' | 'mixed_alpha' | 'mixed_alphanum' | 'symbols' | 'mixed';

// Learned fingerprint from sample analysis - captures all discriminating properties
export interface SamplePattern {
  // Font properties (null = don't filter)
  font_size_min: number | null;
  font_size_max: number | null;
  font_size_ratio_to_body: [number, number] | null;
  font_names: string[] | null;
  is_bold: boolean | null;
  is_italic: boolean | null;

  // Text properties
  char_class: CharClass | null;
  length_min: number | null;
  length_max: number | null;

  // Position properties
  baseline_offset_min: number | null;
  baseline_offset_max: number | null;

  // Context properties
  preceded_by: ('space' | 'punctuation' | 'letter' | 'digit' | 'line_start')[] | null;
  followed_by: ('space' | 'punctuation' | 'letter' | 'digit' | 'line_end')[] | null;

  // Metadata
  sample_count: number;
  body_font_size: number;
  description: string;
}

// Lightweight match representation (40 bytes vs 200+ for full TextBlock)
export interface MatchRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;  // Keep text for display/tooltip
}

export interface MatchingSpansResult {
  matches: MatchRect[];  // Lightweight match rects
  matchesByPage: Record<number, MatchRect[]>;  // Grouped by page for O(1) lookup
  total: number;
  pattern: string;  // The pattern that was matched
}

// Chapter structure for TOC extraction and chapter marking
export interface Chapter {
  id: string;
  title: string;
  page: number;              // 0-indexed
  blockId?: string;          // Linked text block
  y?: number;                // Y position for ordering within page
  level: number;             // 1=chapter, 2=section, 3+=subsection
  source: 'toc' | 'heuristic' | 'manual';
  confidence?: number;       // 0-1 for heuristic detection
}

// Outline item from PDF/EPUB TOC
export interface OutlineItem {
  title: string;
  page: number;              // 0-indexed
  y?: number;                // Y position on the page (from resolved links)
  down?: OutlineItem[];      // Nested children
}

export interface RenderProgressCallback {
  (progress: { current: number; total: number }): void;
}

export interface RenderWithPreviewsResult {
  previewPaths: string[];
  fileHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFileAs?: string;
  year?: string;
  language: string;
  coverPath?: string;
  identifier?: string;
  publisher?: string;
  description?: string;
}

export interface EpubChapter {
  id: string;
  title: string;
  href: string;
  order: number;
  wordCount: number;
}

export interface EpubStructure {
  metadata: EpubMetadata;
  chapters: EpubChapter[];
  spine: string[];
  opfPath: string;
  rootPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Types (Multi-provider)
// ─────────────────────────────────────────────────────────────────────────────

// The provider list and its config block are ai-bridge.ts's, imported rather
// than re-declared: this module compiles to nothing at runtime, so a second
// spelling here could only ever be a spelling that drifts — and it had already
// drifted, missing `crucible` for the whole of phase 2.
import type { AIProvider, AIProviderConfig } from './ai-bridge';
export type { AIProvider, AIProviderConfig };

// Bundled local AI (llama.cpp) — mirrors electron/llama-bridge.ts shapes.
export interface LocalAiModel {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  minRAM: number;
  description: string;
  downloaded: boolean;
  isActive: boolean;
  recommended: boolean;
}

export interface LocalAiSystemInfo {
  platform: string;
  totalRamGB: number;
  cuda: boolean;
  cudaName?: string;
  vramGB?: number;
  effectiveGB: number;
  recommendedModelId: string;
}

export interface LocalAiStatus {
  binaryPresent: boolean;
  ready: boolean;
  activeModelId: string | null;
  activeModelDownloaded: boolean;
  anyModelDownloaded: boolean;
  modelsDir: string;
}

export interface LocalAiModelProgress {
  modelId: string;
  pct: number;
  receivedBytes: number;
  totalBytes: number;
  speed?: string;
  eta?: string;
  phase: 'download' | 'done' | 'error' | 'cancelled';
  message?: string;
}

/*
 * `AICleanupOptions`, `CleanupProgress` and `CleanupResult` ARE DELETED
 * (2026-09-14, crucible PHASE15 §5.3), along with `ai.cleanupChapter` and
 * `ai.onCleanupProgress`.
 *
 * They belonged to the ONE-CHAPTER cleanup, which was Ollama end to end: a
 * model tag, `localhost:11434`, a stream, and a progress channel only that
 * stream emitted on. Nothing in the renderer reached it — the cleanup a person
 * runs is the EPUB pass, which goes through the queue, the provider block and
 * the engine's `capability.selected`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TTS Types (ebook2audiobook)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Processing Queue Types
// ─────────────────────────────────────────────────────────────────────────────

export type QueueJobType = 'tts-conversion';

export interface QueueProgress {
  jobId: string;
  type: QueueJobType;
  phase: string;
  progress: number;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
  /**
   * Stacked per-stage bars, when the job running has a real breakdown to report.
   * A processing pass that owns several foundry stages sends one bar per stage
   * (Render pages / Tesseract / OCR correction / Detection); everything else
   * omits the field and draws its single overall bar.
   */
  stages?: JobStageProgress[];
}

export interface QueueJobResult {
  jobId: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  // Copyright detection for AI cleanup jobs
  copyrightIssuesDetected?: boolean;
  copyrightChunksAffected?: number;
  // Content skips detection for AI cleanup jobs
  contentSkipsDetected?: boolean;
  contentSkipsAffected?: number;
  // Path to skipped chunks JSON
  skippedChunksPath?: string;
  // Analytics data (TTS or cleanup job)
  analytics?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff Comparison Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DiffComparisonChapter {
  id: string;
  title: string;
  originalText: string;
  cleanedText: string;
}

export interface DiffComparisonResult {
  chapters: DiffComparisonChapter[];
}

export interface DiffLoadProgress {
  phase: 'loading-original' | 'loading-cleaned' | 'complete';
  currentChapter: number;
  totalChapters: number;
  chapterTitle?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Play Tab Types (streaming TTS)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaySettings {
  voice: string;
  speed: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

export interface TtsJobConfig {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;
  fineTuned: string;
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
  outputFilename?: string;
  outputDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallel TTS Types
// ─────────────────────────────────────────────────────────────────────────────

export type ParallelWorkerStatus = 'pending' | 'running' | 'complete' | 'error';

export interface ParallelWorkerState {
  id: number;
  sentenceStart: number;
  sentenceEnd: number;
  currentSentence: number;
  completedSentences: number;
  status: ParallelWorkerStatus;
  error?: string;
  pid?: number;
}

export interface ParallelTtsSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;
  fineTuned: string;
  speed: number;
  enableTextSplitting: boolean;
}

export interface ParallelConversionConfig {
  workerCount: number;
  epubPath: string;
  outputDir: string;
  settings: ParallelTtsSettings;
  parallelMode: 'sentences' | 'chapters';
}

export interface ParallelAggregatedProgress {
  /** Mirrors AggregatedProgress.phase in parallel-tts-bridge.ts. 'stopped' is a user stop:
   *  terminal but RESUMABLE, and deliberately distinct from 'error'. */
  phase: 'preparing' | 'converting' | 'assembling' | 'complete' | 'error' | 'stopped';
  totalSentences: number;
  completedSentences: number;
  percentage: number;
  activeWorkers: number;
  workers: ParallelWorkerState[];
  estimatedRemaining: number;
  message?: string;
  error?: string;
}

export interface ParallelConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration?: number;
}

export interface HardwareRecommendation {
  count: number;
  reason: string;
}

// Resume support types
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
  missingRanges?: Array<{ start: number; end: number; count: number }>;
  progressPercent?: number;
  chapters?: Array<{
    chapter_num: number;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>;
  metadata?: { title?: string; creator?: string; language?: string };
  warnings?: string[];
}

export interface TtsResumeInfo {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  totalSentences: number;
  totalChapters: number;
  chapters: Array<{
    chapter_num: number;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>;
  language: string;
  voice?: string;
  ttsEngine?: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reassembly Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NarratorSession {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  metadata: {
    title?: string;
    author?: string;
    language?: string;
    epubPath?: string;
  };
  totalSentences: number;
  completedSentences: number;
  percentComplete: number;
  chapters: E2aChapter[];
  createdAt: string;   // ISO string
  modifiedAt: string;  // ISO string
  source?: 'e2a-tmp' | 'project-cache';  // Where this session was found
}

export interface E2aChapter {
  chapterNum: number;
  title?: string;
  sentenceStart: number;
  sentenceEnd: number;
  sentenceCount: number;
  completedCount: number;
  excluded: boolean;
}

export interface ReassemblyConfig {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  outputDir: string;
  totalChapters?: number;  // Total chapters for progress display
  metadata: {
    title: string;
    author: string;
    year?: string;
    coverPath?: string;
    outputFilename?: string;
  };
  excludedChapters: number[];
}

export interface ReassemblyProgress {
  phase: 'preparing' | 'combining' | 'encoding' | 'metadata' | 'complete' | 'error';
  percentage: number;
  currentChapter?: number;
  totalChapters?: number;
  message?: string;
  error?: string;
}

export interface NarratorSessionScanResult {
  sessions: NarratorSession[];
  tmpPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bookshelf Server Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BookshelfStatus {
  running: boolean;
  port: number;
  addresses: string[];
}

export interface BookshelfConfig {
  port: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Language Learning Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LanguageLearningProject {
  id: string;
  sourceUrl: string;
  title: string;
  sourceLang: string;           // 'en' (auto-detected or manual)
  targetLang: string;           // 'de', 'es', 'fr', etc. (user selected)
  status: 'fetched' | 'selected' | 'processing' | 'completed' | 'error';

  // File paths
  pdfPath: string;              // Generated PDF for viewing
  htmlPath: string;             // Original HTML for text extraction
  deletedBlockIds: string[];    // Blocks user removed

  // Outputs
  bilingualEpubPath?: string;
  audiobookPath?: string;
  vttPath?: string;

  // Timestamps
  createdAt: string;
  modifiedAt: string;
}

export interface CompletedAudiobook {
  id: string;
  title: string;
  path: string;
  duration?: number;
  createdAt: string;
  sourceLang?: string;
  targetLang?: string;
}


/**
 * One Higgs catalog voice as `higgsModels.listCatalog` returns it — the
 * renderer-side mirror of electron/higgs-models' `HiggsModel` (this file must not
 * import from the main process).
 *
 * `_pendingNote` travels because the Settings panel SHOWS it: a voice waiting on
 * an artifact is the one a person most wants an explanation for, and the note is
 * the explanation. The narration picker only ever sees the value/label pair.
 */
/** The measured knobs of ONE backend. See `HiggsModelDto.backends`. */
export interface HiggsBackendCapsDto {
  /** null = declared UNMEASURED, which for a fine-tune is a refusal. */
  maxChars?: number | null;
  maxCharsSource?: string | null;
  edgeFadeMs?: { in: number; out: number };
  sampling?: { temperature?: number; topP?: number; topK?: number };
  referenceSecondsCap?: number;
  allowedControls?: string[];
}

export interface HiggsModelDto {
  id: string;
  label: string;
  engineVersion: string;
  /**
   * THREE shapes, not two — see electron/higgs-models.ts. 'default' is the served
   * model's own speaker and carries NEITHER clips nor a checkpoint; it is not an
   * empty clone, which narrator refuses by name. 'checkpoint' is a MERGED
   * fine-tune directory (vllm-omni has no runtime LoRA path), and it is the only
   * kind besides 'default' the narration dropdown offers.
   */
  kind: 'default' | 'clips' | 'checkpoint';
  voice: {
    clips?: Array<{ path: string; transcript: string; seconds: number }>;
    /**
     * ONE MERGED DIRECTORY PER ARM. The two Higgs arms cannot see each other's
     * disks — the served one loads from inside the WSL guest, the MLX one from
     * the Mac's own userData — so a checkpoint voice names both, and an arm with
     * no entry is an arm the voice is NOT loadable on. `wsl` is the guest's
     * absolute path; `darwin` is relative to the app's userData directory.
     */
    checkpoint?: { wsl?: string; darwin?: string };
    scene?: string;
  };
  license: string;
  commercialUse: boolean;
  sampleRate: number;
  addedAt: string;
  /**
   * ONE BLOCK PER BACKEND — `served` is vllm-omni behind WSL, `mlx` is the
   * in-process mlx-audio sampler on the Mac, and the loader picks by ARM. They do
   * not share numbers: a cap is produced by rendering, and the two arms sample
   * through different implementations over different runtimes.
   */
  backends?: {
    served?: HiggsBackendCapsDto;
    mlx?: HiggsBackendCapsDto;
  };
  _pendingNote?: string;
  /** The HF repo a checkpoint voice can be downloaded from, when the catalog names one. */
  source?: { type: 'hf'; ref: string };
  note?: string;
}

export interface ElectronAPI {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    analyzeQuick: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    analyzeText: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    /** Does this PDF carry text of its own? Sampled — see pdf-analyzer. */
    measureTextLayer: (pdfPath: string, maxSamples?: number) =>
      Promise<{ success: boolean; data?: TextLayerReport; error?: string }>;
    onTextReady: (callback: (data: { blocks: any[]; categories: Record<string, any>; spans: any[]; pdfPath: string; warnings?: string[] }) => void) => () => void;
    renderPage: (pageNum: number, scale?: number, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>, removeBackground?: boolean) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderBlankPage: (pageNum: number, scale?: number) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderAllPages: (pdfPath: string, scale?: number, concurrency?: number) => Promise<{ success: boolean; data?: { paths: string[] }; error?: string }>;
    renderWithPreviews: (pdfPath: string, concurrency?: number) => Promise<{ success: boolean; data?: RenderWithPreviewsResult; error?: string }>;
    renderPages: (pdfPath: string, pageNumbers: number[], quality?: 'preview' | 'full') => Promise<{ success: boolean; data?: Record<number, string>; error?: string }>;
    closeRenderDoc: () => Promise<{ success: boolean; error?: string }>;
    closePdf: () => Promise<{ success: boolean; error?: string }>;
    onRenderProgress: (callback: RenderProgressCallback) => () => void;
    onAnalyzeProgress: (callback: (progress: { phase: string; message: string }) => void) => () => void;
    onPageUpgraded: (callback: (data: { pageNum: number; path: string }) => void) => () => void;
    onExportProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;
    cleanupTempFiles: () => Promise<{ success: boolean; error?: string }>;
    clearCache: (fileHash: string) => Promise<{ success: boolean; error?: string }>;
    clearAllCache: () => Promise<{ success: boolean; data?: { cleared: number; freedBytes: number }; error?: string }>;
    getCacheSize: (fileHash: string) => Promise<{ success: boolean; data?: { size: number }; error?: string }>;
    getTotalCacheSize: () => Promise<{ success: boolean; data?: { size: number }; error?: string }>;
    exportText: (enabledCategories: string[]) => Promise<{ success: boolean; data?: { text: string; char_count: number }; error?: string }>;
    exportTextOnlyEpub: (pdfPath: string, metadata?: { title?: string; author?: string }) => Promise<{ success: boolean; data?: string; error?: string }>;
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>, deletedPages?: number[]) => Promise<{ success: boolean; data?: { pdf_base64: string; warnings?: string[] }; error?: string }>;
    exportPdfNoBackgrounds: (scale?: number, deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>, deletedPages?: number[]) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    exportPdfWysiwyg: (deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, deletedPages?: number[], scale?: number, ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    findSimilar: (blockId: string) => Promise<{ success: boolean; data?: { similar_ids: string[]; count: number }; error?: string }>;
    findSpansInRect: (page: number, x: number, y: number, width: number, height: number) => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
    analyzeSamples: (sampleSpans: TextSpan[]) => Promise<{ success: boolean; data?: SamplePattern; error?: string }>;
    findMatchingSpans: (pattern: SamplePattern) => Promise<{ success: boolean; data?: MatchingSpansResult; error?: string }>;
    findSpansByRegex: (pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) => Promise<{ success: boolean; data?: MatchingSpansResult; error?: string }>;
    getSpans: () => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
    getSpansForBlock: (blockId: string) => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
    updateSpansForOcr: (pageNum: number, ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>) => Promise<{ success: boolean; error?: string }>;
    // Chapter detection
    extractOutline: () => Promise<{ success: boolean; data?: OutlineItem[]; error?: string }>;
    outlineToChapters: (outline: OutlineItem[], deletedPages?: number[]) => Promise<{ success: boolean; data?: Chapter[]; error?: string }>;
    detectChapters: (deletedPages?: number[]) => Promise<{ success: boolean; data?: Chapter[]; error?: string }>;
    detectChaptersFromExamples: (blockIds: string[], deletedPages?: number[]) => Promise<{ success: boolean; data?: Chapter[]; error?: string }>;
    mapTocEntries: (tocBlockIds: string[], deletedPages?: number[]) => Promise<{ success: boolean; data?: { chapters: Chapter[]; unmapped: Array<{ title: string; printedPage?: number; rawLine: string }> }; error?: string }>;
    splitTocBlocks: (tocBlockIds: string[]) => Promise<{ success: boolean; data?: Array<{ text: string; blockId: string; blockPage: number; isPageNumber: boolean }>; error?: string }>;
    mapTitlesToChapters: (titles: string[], tocPages: number[], deletedPages?: number[]) => Promise<{ success: boolean; data?: { chapters: Chapter[]; unmapped: Array<{ title: string; rawLine: string }> }; error?: string }>;
    addBookmarks: (pdfBase64: string, chapters: Chapter[]) => Promise<{ success: boolean; data?: string; error?: string }>;
    // WYSIWYG export from canvas-rendered images
    assembleFromImages: (pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>, chapters?: Chapter[]) => Promise<{ success: boolean; data?: string; error?: string }>;
  };
  /**
   * The live-DOM EPUB viewer's own opening. Separate from `pdf`, because a book
   * shown as itself is not a book photographed: nothing here renders, caches or
   * returns an image. `data` is a QuireViewerOpening (electron/quire-viewer-bridge.ts).
   */
  quire: {
    openBook: (epubPath: string, geometry?: { width: number; height: number; fontSize: number })
      => Promise<{ success: boolean; data?: any; error?: string }>;
    closeBook: (handle: string) => Promise<{ success: boolean; error?: string }>;
    /**
     * Lay the documents an edit rewrote out again, in a book already open.
     * `data` is a QuireRelayoutResult (electron/quire-viewer-bridge.ts).
     */
    relayoutEntries: (handle: string, bookPath: string, entries: string[])
      => Promise<{ success: boolean; data?: any; error?: string }>;
  };
  fs: {
    browse: (dirPath: string) => Promise<{
      path: string;
      parent: string;
      items: Array<{ name: string; path: string; type: string; size: number | null }>;
    }>;
    readBinary: (filePath: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
    exists: (filePath: string) => Promise<boolean>;
    batchExists: (filePaths: string[]) => Promise<Record<string, boolean>>;
    batchStat: (filePaths: string[]) => Promise<Record<string, { mtimeMs: number } | null>>;
    writeText: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    deleteDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
    writeTempFile: (filename: string, data: Uint8Array) => Promise<{ success: boolean; path?: string; dataUrl?: string; error?: string }>;
    readText: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    readAudio: (audioPath: string) => Promise<{ success: boolean; dataUrl?: string; size?: number; error?: string }>;
    listDirectory: (dirPath: string) => Promise<string[]>;
    generateUniqueFilename: (originalPath: string, suffix: string) => Promise<{ success: boolean; data?: { path: string }; error?: string }>;
  };
  project: {
    saveToPath: (filePath: string, projectData: unknown) => Promise<ProjectSaveResult>;
    updateMetadata: (projectDir: string, metadata: unknown) => Promise<{ success: boolean; error?: string; warnings?: string[]; newProjectDir?: string }>;
  };
  dialog: {
    openPdf: () => Promise<OpenPdfResult>;
    openVersion: () => Promise<{ success: boolean; canceled?: boolean; filePaths?: string[]; error?: string }>;
    openFolder: () => Promise<{ success: boolean; canceled?: boolean; folderPath?: string; error?: string }>;
    openAudio: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveEpub: (defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveText: (defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveM4b: (defaultName?: string, defaultDir?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveWav: (bytesBase64: string, defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    /** Choose a location and copy this file's bytes there, unchanged. */
    saveFileCopy: (sourcePath: string, defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    // File choosers only. Confirms and one-button messages are the in-app
    // dialog component's job (DialogService), not the OS's — see the note
    // where this bridge is built.
  };
  projects: {
    ensureFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
    getFolder: () => Promise<{ path: string }>;
    findManifestBySource: (fileHash: string | undefined, sourcePath: string | undefined) => Promise<{ found: boolean; projectPath?: string; error?: string }>;
    loadFromPath: (filePath: string) => Promise<ProjectLoadResult>;
    exportInfo: (projectDir: string, familyId?: string) => Promise<{
      success: boolean;
      /**
       * WHICH working chain the answer is about — echoed back so a caller can
       * quote it in every act it performs afterwards rather than asking again
       * and possibly being answered about a different version.
       */
      familyId?: string | null;
      exported?: { relPath: string; absPath: string; modifiedAt?: string } | null;
      error?: string;
    }>;
  };
  library: {
    seedBookPath: () => Promise<string | null>;
    removeAllData: () => Promise<{ ok: boolean; freedBytes: number; userData: string; platform: string }>;
    importFile: (sourcePath: string) => Promise<{
      success: boolean;
      libraryPath?: string;
      hash?: string;
      alreadyExists?: boolean;
      error?: string;
    }>;
    resolveSource: (options: {
      libraryPath?: string;
      sourcePath?: string;
      fileHash?: string;
      sourceName?: string;
    }) => Promise<{
      success: boolean;
      resolvedPath?: string;
      error?: string;
    }>;
    translatePath: (inputPath: string) => Promise<{
      success: boolean;
      translated: string | null;
    }>;
    setRoot: (libraryPath: string | null) => Promise<{ success: boolean; error?: string }>;
    getRoot: () => Promise<{ path: string }>;
    migrateAudiobooksToArchive: () => Promise<{
      success: boolean;
      books: Array<{ projectId: string; title: string; status: 'migrated' | 'skipped' | 'failed'; reason?: string; orphans?: string[] }>;
      migrated: number;
      skipped: number;
      failed: number;
    }>;
    onArchiveMigrationProgress: (callback: (progress: { current: number; total: number; projectId: string; title: string }) => void) => void;
    offArchiveMigrationProgress: () => void;
  };
  media: {
    saveImage: (base64Data: string, prefix?: string) => Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }>;
    loadImage: (relativePath: string) => Promise<{
      success: boolean;
      data?: string;
      error?: string;
    }>;
    /** Many images in one round-trip. Values are null for images that couldn't be read. */
    loadImages: (relativePaths: string[], maxWidth?: number) => Promise<{
      success: boolean;
      data?: Record<string, string | null>;
      error?: string;
    }>;
  };
  audiobook: {
    // Unified audiobook export (saves into the project directory)
    exportFromProject: (projectDir: string, epubData: ArrayBuffer, deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>, savePath?: string, familyId?: string) => Promise<{
      success: boolean;
      audiobookFolder?: string;
      epubPath?: string;
      error?: string;
    }>;
    // Extract metadata from EPUB without importing.
    // degraded=true means the EPUB could not be parsed and `metadata` is only a
    // filename guess (error carries the parse reason).
    extractMetadata: (epubSourcePath: string) => Promise<{
      success: boolean;
      metadata?: { title: string; author: string; year: string; language: string; coverData: string | null };
      degraded?: boolean;
      error?: string;
    }>;
    // Import EPUB directly (creates the project directory + output folder)
    importEpub: (epubSourcePath: string, confirmedMetadata?: { title: string; author: string; year?: string; language?: string; subtitle?: string; coverData?: string }) => Promise<{
      success: boolean;
      projectDir?: string;
      audiobookFolder?: string;
      epubPath?: string;
      projectName?: string;
      error?: string;
    }>;
    importAudiobook: (audioSourcePath: string) => Promise<{
      success: boolean;
      projectId?: string;
      projectPath?: string;
      projectDir?: string;
      projectName?: string;
      duplicate?: boolean;
      existingProjectId?: string;
      existingTitle?: string;
      error?: string;
    }>;
    onImportProgress: (callback: (p: { name: string; fraction: number; projectId?: string }) => void) => () => void;
    saveAudiobookMetadata: (projectId: string, meta: { title?: string; author?: string; year?: string; narrator?: string; series?: string; seriesPosition?: number; description?: string }, coverData?: string) => Promise<{
      success: boolean;
      coverPath?: string;
      error?: string;
    }>;
    deleteOutput: (projectId: string, key: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    appendAnalytics: (projectDir: string, jobType: 'tts-conversion' | 'reassembly' | 'video-assembly' | 'rvc' | 'translation', analytics: { jobId: string; [key: string]: unknown }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    getAnalytics: (projectDir: string) => Promise<{
      success: boolean;
      analytics?: Record<string, unknown> | null;
      error?: string;
    }>;
    copyVtt: (projectDir: string, m4bOutputPath: string) => Promise<{
      success: boolean;
      vttPath?: string | null;
      message?: string;
      error?: string;
    }>;
    extractEmbeddedVtt: (m4bPath: string) => Promise<{
      success: boolean;
      vtt?: string;
      error?: string;
    }>;
    getFolder: (projectDir: string) => Promise<{
      success: boolean;
      folder?: string;
      error?: string;
    }>;
    updatePipeline: (projectId: string, pipelineData: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
    linkAudio: (projectDir: string, audioPath: string) => Promise<{ success: boolean; error?: string }>;
    copyToPath: (source: string, dest: string) => Promise<{ success: boolean; error?: string }>;
  };
  variant: {
    list: (projectId: string) => Promise<{ success: boolean; variants?: unknown[]; primaryVariantId?: string; ttsVariantId?: string; error?: string }>;
    add: (projectId: string, filePath: string) => Promise<{ success: boolean; variantId?: string; variant?: unknown; error?: string }>;
    saveMetadata: (projectId: string, variantId: string, meta: Record<string, unknown>, coverData?: string) => Promise<{ success: boolean; coverPath?: string; error?: string }>;
    ensureCover: (projectId: string, variantId: string) => Promise<{ success: boolean; coverPath?: string; data?: string; error?: string }>;
    delete: (projectId: string, variantId: string) => Promise<{ success: boolean; error?: string }>;
    setPrimary: (projectId: string, variantId: string) => Promise<{ success: boolean; error?: string }>;
    pullMetadata: (projectId: string, fromId: string, toId: string, fields: string[]) => Promise<{ success: boolean; error?: string }>;
    sendToPipeline: (projectId: string, variantId: string) => Promise<{ success: boolean; sourcePath?: string; projectDir?: string; error?: string }>;
    setProfessional: (projectId: string, variantId: string, value: boolean) => Promise<{ success: boolean; error?: string }>;
    /** Mark ONE version as this book's TTS file, or clear the mark with `null`. */
    setTts: (projectId: string, variantId: string | null) => Promise<{ success: boolean; error?: string }>;
  };
  epub: {
    parse: (epubPath: string) => Promise<{ success: boolean; data?: EpubStructure; error?: string }>;
    getCover: (epubPath?: string) => Promise<{ success: boolean; data?: string | null; error?: string }>;
    setCover: (coverDataUrl: string) => Promise<{ success: boolean; error?: string }>;
    getChapterText: (chapterId: string) => Promise<{ success: boolean; data?: string; error?: string }>;
    getMetadata: () => Promise<{ success: boolean; data?: EpubMetadata | null; error?: string }>;
    setMetadata: (metadata: Partial<EpubMetadata>) => Promise<{ success: boolean; error?: string }>;
    getChapters: () => Promise<{ success: boolean; data?: EpubChapter[]; error?: string }>;
    close: () => Promise<{ success: boolean; error?: string }>;
    saveModified: (outputPath: string) => Promise<{ success: boolean; data?: { outputPath: string }; error?: string }>;
    editText: (epubPath: string, chapterId: string, oldText: string, newText: string) => Promise<{ success: boolean; error?: string }>;
    exportWithRemovals: (inputPath: string, removals: Record<string, Array<{ chapterId: string; text: string; cfi: string }>>, outputPath?: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
    copyFile: (inputPath: string, outputPath: string) => Promise<{ success: boolean; error?: string }>;
    exportWithDeletedBlocks: (inputPath: string, deletedBlockIds: string[], outputPath?: string) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
    exportPreservingMarkup: (
      projectDir: string | null,
      epubSourcePath: string,
      savePathOverride: string | null,
      edits: EpubPreservingEdits,
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>,
      familyId?: string,
    ) => Promise<{
      success: boolean;
      epubPath?: string;
      chapterCount?: number;
      blockCount?: number;
      unalignedUntouched?: number;
      warnings?: string[];
      error?: string;
    }>;
    classifyEditorSource: (targetPath: string) => Promise<{
      success: boolean;
      kind?: 'project' | 'loose';
      projectDir?: string;
      projectId?: string;
      sourceType?: string | null;
      archiveEpubPath?: string | null;
      error?: string;
    }>;
    saveAsDialog: (epubData: ArrayBuffer, defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
  };
  ai: {
    /**
     * `crucibleServer` NAMES a registered server and
     * is read only by the `crucible` provider, which has no default one —
     * asking for it without a name is refused by name.
     *
     * THERE IS NO `apiKey` ARGUMENT, and there is no `checkConnection`,
     * `getModels`, `getClaudeModels` or `getOpenAIModels` beside it (deleted
     * 2026-09-14, crucible PHASE15 §5.3). A key belongs to the ENGINE, and
     * what an engine can serve is `crucible.capability` — so nothing a
     * renderer could send across this seam is a credential, and no model list
     * is composed on this side.
     */
    checkProviderConnection: (provider: AIProvider, crucibleServer?: string) => Promise<{ success: boolean; data?: { available: boolean; error?: string; models?: string[] }; error?: string }>;
    loadSkippedChunks: (jsonPath: string) => Promise<{ success: boolean; chunks?: SkippedChunk[]; error?: string }>;
    replaceTextInEpub: (epubPath: string, oldText: string, newText: string) => Promise<{ success: boolean; chapterFound?: string; error?: string }>;
    updateSkippedChunk: (jsonPath: string, index: number, newText: string) => Promise<{ success: boolean; error?: string }>;
    getPrompt: () => Promise<{ success: boolean; data?: { prompt: string; filePath: string }; error?: string }>;
    savePrompt: (prompt: string) => Promise<{ success: boolean; error?: string }>;
    // Bundled local AI (llama.cpp) — AI Setup wizard
    localStatus: () => Promise<{ success: boolean; data?: LocalAiStatus; error?: string }>;
    localSystemInfo: () => Promise<{ success: boolean; data?: LocalAiSystemInfo; error?: string }>;
    localListModels: () => Promise<{ success: boolean; data?: LocalAiModel[]; error?: string }>;
    localDownloadModel: (modelId: string) => Promise<{ success: boolean; error?: string }>;
    localCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
    localDeleteModel: (modelId: string) => Promise<{ success: boolean; error?: string }>;
    localSetActive: (modelId: string) => Promise<{ success: boolean; error?: string }>;
    onLocalModelProgress: (callback: (p: LocalAiModelProgress) => void) => () => void;
  };
  shell: {
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };
  bookshelf: {
    start: (config: BookshelfConfig) => Promise<{ success: boolean; data?: BookshelfStatus; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<{ success: boolean; data?: BookshelfStatus; error?: string }>;
  };
  narrator: {
    configurePaths: (config: { condaPath?: string; narratorScratchPath?: string }) => Promise<{ success: boolean; error?: string }>;
  };
  orpheus: {
    getBatchConfig: () => Promise<OrpheusBatchConfig>;
    setBatchMax: (value: number | null) => Promise<OrpheusBatchConfig>;
    getMemoryTier: () => Promise<{ tier: string; resolvedTier: string; autoCeiling: string | null; profile: { tier: string; capMB: number; marginMB: number; ceiling: number; batchSize: number }; platform: 'mac' | 'nvidia'; viable: boolean; steppedDown?: boolean; freeMB: number | null; usedMB: number | null; totalMB: number | null; reserveMB: number | null }>;
    setMemoryTier: (tier: string) => Promise<{ tier: string; resolvedTier: string; autoCeiling: string | null; profile: { tier: string; capMB: number; marginMB: number; ceiling: number; batchSize: number }; platform: 'mac' | 'nvidia'; viable: boolean; steppedDown?: boolean; freeMB: number | null; usedMB: number | null; totalMB: number | null; reserveMB: number | null }>;
  };
  runtime: {
    getStatus: () => Promise<{ success: boolean; data?: { state: 'preparing' | 'ready' | 'error'; message: string; error?: string }; error?: string }>;
    onStatus: (callback: (status: { state: 'preparing' | 'ready' | 'error'; message: string; error?: string }) => void) => () => void;
    usingBundledEnv: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    isFreshInstall: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    completeSetup: () => Promise<{ success: boolean; error?: string }>;
  };
  higgsModels: {
    /** The Higgs narration roster as a picker wants it. A voice whose artifact has
     *  not landed yet is INCLUDED, with "— not installed yet" in its label: the
     *  catalog is the whole roster, so omitting it would leave nothing anywhere
     *  saying the voice exists. `resolveHiggsModel` refuses to render it. */
    list: () => Promise<{ success: boolean; data?: Array<{ value: string; label: string }>; error?: string }>;
    /** The full catalog entries — voice ref, licence, measured caps — for the
     *  Settings → Higgs voices panel. */
    listCatalog: () => Promise<{ success: boolean; data?: HiggsModelDto[]; error?: string }>;
    /** Which MACHINES can speak which voice, grouped by the set that can — the
     *  servers' own answer, not this box's disk. A voice only one server serves
     *  PINS the venue (Owen, 2026-09-15), which is why `missing` is part of the
     *  reply rather than something the caller infers: a server that did not
     *  answer contributes no voices, and treating that as "it does not have
     *  them" would silently reroute a book. */
    picker: () => Promise<{ success: boolean; data?: VoicePickerDto; error?: string }>;
  };
  rvcVoices: {
    /** User-added RVC voice sources ({ url, name }). */
    sourcesGet: () => Promise<{ success: boolean; data?: Array<{ url: string; name: string }>; error?: string }>;
    /** Add a source (archive URL + display name). */
    sourcesAdd: (url: string, name: string) => Promise<{ success: boolean; error?: string }>;
    /** Remove a user source by its synthetic component id + delete any install. */
    sourcesRemove: (id: string) => Promise<{ success: boolean; error?: string }>;
  };
  toolPaths: {
    getConfig: () => Promise<{ success: boolean; data?: Record<string, string | undefined>; error?: string }>;
    updateConfig: (updates: Record<string, string | undefined>) => Promise<{ success: boolean; data?: Record<string, string | undefined>; error?: string }>;
    getStatus: () => Promise<{ success: boolean; data?: Record<string, { configured: boolean; detected: boolean; path: string }>; error?: string }>;
  };
  wsl: {
    detect: () => Promise<{ success: boolean; data?: { available: boolean; version?: number; distros: string[]; defaultDistro?: string; error?: string }; error?: string }>;
    checkOrpheusSetup: (config: { distro?: string; condaPath?: string; sessionsRoot?: string }) => Promise<{
      success: boolean;
      data?: { valid: boolean; condaFound: boolean; sessionsRootFound: boolean; orpheusEnvFound: boolean; errors: string[] };
      error?: string;
    }>;
  };
  /**
   * The Crucible inference servers this machine can reach (Settings → Crucible
   * Servers). Wire shapes come from shared/crucible/settings-wire.ts — the main
   * process owns the registry and the rank record, and the renderer must not
   * re-spell either.
   *
   * ONE KIND OF SERVER (Owen's ruling, 2026-09-15). There is no reserved name
   * for the machine this app runs on: a Crucible on `127.0.0.1` is added,
   * named, tested, ranked and removed by exactly these calls.
   */
  crucible: {
    pairStart: (address: string) => Promise<{ success: boolean; data?: import('../shared/crucible/connect-wire').CruciblePairingPrompt; error?: string }>;
    pairPoll: (requestId: string) => Promise<{ success: boolean; data?: import('../shared/crucible/connect-wire').CruciblePairingDecision; error?: string }>;
    pairCancel: () => Promise<{ success: boolean }>;
    pairRequests: (server: string) => Promise<{ success: boolean; data?: import('../shared/crucible/engine-controls-wire').CrucibleConnectionApproval[]; error?: string }>;
    pairDecide: (server: string, id: string, userCode: string, allow: boolean) => Promise<{ success: boolean; error?: string }>;
    upgradeWsl: (server: string) => Promise<{ success: boolean; error?: string }>;
    onUpgradeProgress: (callback: (progress: import('../shared/crucible/engine-controls-wire').CrucibleEngineUpgradeProgress) => void) => () => void;
    /** Every registered server, the rank record, and the OFFER of one found on this computer. */
    servers: () => Promise<{ success: boolean; data?: CrucibleServersView; error?: string }>;
    /** Record a server. Refuses exactly as the registry refuses; the row shows its message. */
    add: (server: { name: string; url: string; token: string }) => Promise<{ success: boolean; data?: CrucibleServerRow; error?: string }>;
    /**
     * The SAME add, for the Crucible `servers().discovered` found on this
     * computer: only the NAME crosses, because the token may not (see the
     * wire's header). Not a second kind of server — a registry row like any
     * other, under whatever it is called here.
     */
    addDiscovered: (name: string) => Promise<{ success: boolean; data?: CrucibleServerRow; error?: string }>;
    /** Forget a server. An unknown name is refused by name. */
    remove: (name: string) => Promise<{ success: boolean; data?: CrucibleServerRow; error?: string }>;
    /** Test an address+token that is not registered yet: ping, then info. */
    testAddress: (url: string, token: string) => Promise<{ success: boolean; data?: CrucibleProbeResult; error?: string }>;
    /** The same test for a server this machine already knows, by its registry name. */
    test: (name: string) => Promise<{ success: boolean; data?: CrucibleProbeResult; error?: string }>;
    /** `GET /v1/activity` — a bench read, never admission. */
    activity: (name: string) => Promise<{ success: boolean; data?: { outcome: 'ok'; activity: CrucibleActivityView } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>; error?: string }>;
    /** `GET /v1/models` — the four facts about each, and the reason for a no. */
    models: (name: string) => Promise<{ success: boolean; data?: { outcome: 'ok'; models: CrucibleModelRow[] } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>; error?: string }>;
    /** Re-rank. The WHOLE visible list, best first — a drag reorders, it never drops a row. */
    setOrder: (order: string[]) => Promise<{ success: boolean; data?: CrucibleRoutingView; error?: string }>;
    /** The capacity switch: may the queue use this server at all. */
    setEnabled: (name: string, enabled: boolean) => Promise<{ success: boolean; data?: CrucibleRoutingView; error?: string }>;
    /**
     * Put one server's `crucible://` line on the clipboard. `copied` is that
     * line with its token replaced by `****` — the real one is written in main
     * and never crosses this boundary.
     */
    copyConnectCode: (name: string) => Promise<{ success: boolean; data?: { copied: string }; error?: string }>;
    /** What a NEW queue row waits for: the top-ranked server, or any. */
    setWaitFor: (value: CrucibleWaitForDefault) => Promise<{ success: boolean; data?: CrucibleRoutingView; error?: string }>;
    /**
     * The ONE switch for the legacy local narrator: render audiobooks by
     * spawning narrator here instead of on a Crucible server. A dated stopgap
     * (docs/CRUCIBLE_ROLLOUT_PLAN.md §2 ruling 4), never set by a failure.
     */
    /** Drop a name the rank record mentions that no server answers to. */
    forget: (name: string) => Promise<{ success: boolean; data?: CrucibleRoutingView; error?: string }>;
    /** OPERATOR VERB: submits a `load-model` job, which takes that machine's card. */
    loadModel: (name: string, model: string) => Promise<{ success: boolean; data?: { outcome: 'ok'; jobId: string } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>; error?: string }>;
    /** OPERATOR VERB: submits an `unload-model` job. Nothing here does it unasked. */
    unloadModel: (name: string, model: string) => Promise<{ success: boolean; data?: { outcome: 'ok'; jobId: string } | Exclude<CrucibleProbeResult, { outcome: 'ok' }>; error?: string }>;
    /**
     * `GET /v1/capability` on a named server: what it can hold per class, the
     * model it SELECTED for each, and the server's own reason either way.
     *
     * A READ. The per-act model record this app used to keep is deleted — the
     * capability record owns that mapping, because `crucible install` measured
     * the card to make it.
     */
    capability: (name: string) => Promise<{ success: boolean; data?: CrucibleCapabilityView; error?: string }>;

    /*
     * ── THE ENGINE'S OWN SETTINGS (crucible PHASE15 §3.1, §3.2, §5.2) ───────
     *
     * "Settings are the engine's; the app draws a window." These three are the
     * window's whole supply, and there is deliberately no fourth that saves
     * anything: nothing on this side is stored, so there is nothing to save.
     * A key travels UP through {@link writeEngineSettings} or
     * {@link testUpstream} and never comes back — the read shape has a hint of
     * four characters and no field a key could sit in.
     *
     * THE METHOD NAMES AND THE CHANNEL NAMES DIFFER, as they already do for
     * `add`/`crucible:add-server`. The vendored Foundry claims
     * `crucible:settings` for its own Servers card, so ours are
     * `bookforge:crucible-engine-settings` and `bookforge:crucible-engine-settings-write`; the
     * renderer only ever spells the method, so the skew stops at this file and
     * `tools/test-ipc-collision.js` is what guards it.
     */

    /**
     * ── THE CATALOG: EVERYTHING THIS SERVER COULD HOLD ────────────────────
     *
     * `engineSettings().localModels.choices` offers what is INSTALLED. These
     * four offer the rest — the models and voices a server could have and does
     * not — which is what a "more" button needs to exist at all.
     *
     * Every row's `source` is `hf:<repo>`. That is the whole of what "connected
     * to HuggingFace" means here and it is not a search of the Hub: Crucible
     * serves the subjects its manifests declare and has no endpoint that
     * queries HuggingFace, so a search box would be a box that cannot.
     */
    catalog: (name: string) => Promise<{
      success: boolean;
      data?: CrucibleCatalogView;
      error?: string;
      /** The server's own refusal code, where it gave one. Never renamed. */
      code?: string | null;
    }>;
    /**
     * Download one subject onto a server, resolving with the TERMINAL frame.
     *
     * Progress arrives on {@link onPullProgress}, not here. `already_installed`
     * and `task_busy` come back as ordinary refusals with their code intact —
     * a Crucible runs one task at a time and naming the one in the way is this
     * door's entire contribution to backing off.
     */
    pull: (name: string, kind: CrucibleSubjectKind, id: string) => Promise<{
      success: boolean;
      data?: CrucibleModuleProgress;
      error?: string;
      code?: string | null;
    }>;
    /** Every frame of every pull this window started. Filter by `kind`+`id`. */
    onPullProgress: (callback: (progress: CruciblePullProgress) => void) => () => void;
    /**
     * What removing this subject would destroy, BEFORE anything is destroyed.
     *
     * Its one job is to give a confirm modal the SIZE: crucible
     * `docs/MODEL-CHOICE.md` §7 — deciding about 17.3 GB is a different
     * decision from deciding about "a file".
     */
    removalPrompt: (name: string, kind: CrucibleSubjectKind, id: string) => Promise<{
      success: boolean;
      data?: CrucibleRemovalPrompt;
      error?: string;
    }>;
    /**
     * Delete an installed subject's files. **Confirm first** — this door does
     * not, and the SDK's condition is that an app never calls it on a person's
     * behalf without saying so on screen.
     */
    removeSubject: (name: string, kind: CrucibleSubjectKind, id: string) => Promise<{
      success: boolean;
      error?: string;
      code?: string | null;
    }>;

    /** `GET /v1/settings` on a named server — routes, upstreams, allowance, backend. */
    engineSettings: (name: string) => Promise<{
      success: boolean;
      data?: CrucibleEngineSettings;
      error?: string;
      refusal?: CrucibleEngineSettingsRefusal;
    }>;
    /**
     * `PUT /v1/settings` — a partial patch, applied as a whole or not at all.
     *
     * One patch may configure an upstream AND route a class to it; the server
     * applies upstreams first, then routes, then validates (§3.2), so there is
     * no window in which a route names a key that is not there yet. The answer
     * is the WHOLE document after the write, which is what a panel re-draws
     * from.
     */
    writeEngineSettings: (name: string, patch: CrucibleEngineSettingsPatch) => Promise<{
      success: boolean;
      data?: CrucibleEngineSettings;
      error?: string;
      refusal?: CrucibleEngineSettingsRefusal;
    }>;
    /**
     * `POST /v1/settings/upstreams/{name}/test` — what that account reaches.
     *
     * The probe is tested WITHOUT being stored, which is what makes Test
     * before Save a fact rather than a wording. The three upstream refusals
     * ANSWER inside `data` (§3.8); only an engine-level failure fails the call.
     */
    testUpstream: (
      name: string,
      upstream: CrucibleUpstreamName,
      probe: CrucibleUpstreamProbe,
    ) => Promise<{
      success: boolean;
      data?: CrucibleUpstreamTestResult;
      error?: string;
      refusal?: CrucibleEngineSettingsRefusal;
    }>;

    /*
     * ── THE INSTALL STORY'S THIRD DOOR ──────────────────────────────────────
     *
     * Doors 1 and 2 are already up there: `testAddress` + `add` is "connect to
     * one", and `servers().discovered` is the same door with the fields filled
     * in from a Crucible found on this computer. These three are "install one
     * here".
     */

    /** What this machine can run a Crucible with, measured — `detectHost()`'s shape. */
    hostFacts: () => Promise<{ success: boolean; data?: CrucibleHostFacts; error?: string }>;
    /** What installing one here would do, for this platform. A read. */
    installPlan: () => Promise<{ success: boolean; data?: CrucibleInstallPlan; error?: string }>;
    /**
     * THE DRIVEN INSTALL, through `@crucible/bootstrap`. On Windows that is
     * the HOST's door and nothing else (PHASE15 §4.3): a machine with no host
     * refuses `host_not_installed` carrying the one `install.ps1` line. Every
     * refusal is the refusing owner's own, `command` included — nothing is
     * renamed on the way through. Watch `onInstallProgress` while it runs.
     */
    install: () => Promise<{ success: boolean; data?: unknown; error?: string; refusal?: CrucibleHostRefusal }>;
    /** Every step, line, byte count and WSL state of the install above, as it happens. */
    onInstallProgress: (callback: (progress: CrucibleInstallProgress) => void) => () => void;
    /**
     * WHAT UNINSTALLING WOULD DO — `crucible uninstall --dry-run --json`,
     * which touches nothing. The same plan object the real run performs, so
     * the two cannot describe different things.
     *
     * THIS MACHINE ONLY, AND PROVED: a row whose URL is not the URL of the
     * Crucible found on this computer is `uninstall_not_local`, whatever it is
     * called, and a Crucible whose CLI predates the verb is
     * `uninstall_not_available`.
     */
    uninstallPlan: (
      name: string,
      options: { purgeWeights: boolean; wslToo: boolean },
    ) => Promise<{
      success: boolean; data?: CrucibleUninstallPlan; error?: string;
      refusal?: { code: CrucibleUninstallRefusalCode; message: string; command: string | null; detail: string | null };
    }>;
    /** The real run. Weights are KEPT unless `purgeWeights`. Streams on `onUninstallProgress`. */
    uninstall: (
      name: string,
      options: { purgeWeights: boolean; wslToo: boolean },
    ) => Promise<{
      success: boolean; data?: CrucibleUninstallPlan; error?: string;
      refusal?: { code: CrucibleUninstallRefusalCode; message: string; command: string | null; detail: string | null };
    }>;
    /** Every line the uninstall printed, as it printed it. */
    onUninstallProgress: (
      callback: (line: { stream: 'stdout' | 'stderr'; text: string }) => void,
    ) => () => void;

    /*
     * ── THE OPERATOR DOOR (PHASE13-OPERATOR.md section 5) ───────────────────
     *
     * Crucible serves its own page, and after a server exists everything an
     * operator does to it happens there. These four are what an app keeps.
     */

    /**
     * One pasted `crucible://name@host:port/#token` line becomes the connect
     * door's three fields. Never a half-filled form: a line the SDK does not
     * recognise comes back `invalid_pairing` with its own sentence and nothing
     * is filled.
     */
    parsePairing: (line: string) => Promise<{ success: boolean; data?: PairingResult; error?: string }>;
    /** What `shared/crucible/bookforge.module.json` asks a server for. */
    module: () => Promise<{ success: boolean; data?: { version: string; jobTypes: string[]; subjects: string[] }; error?: string }>;
    /**
     * WHERE COORDINATION WITH EACH SERVER STANDS — the whole map, as main holds
     * it (crucible `docs/PHASE14-ENVPACKS.md` §4a).
     *
     * There is no `setUpModule` any more and no button that would have called
     * one: BookForge coordinates with every server it connects to, so a screen
     * READS this and subscribes to {@link onCoordination}. A server absent from
     * the map is one nothing has asked yet.
     */
    coordination: () => Promise<{ success: boolean; data?: CrucibleCoordinationMap; error?: string }>;
    /**
     * Coordinate with one named server now — the wizard's step landing on
     * "connected", and a driven install that has just finished. Joins a run
     * already in flight rather than starting a second.
     */
    coordinate: (name: string) => Promise<{ success: boolean; data?: CrucibleCoordinationState; deferred?: boolean; error?: string }>;
    /** Stop the module task this server is running. Answers `cancelling`. */
    cancelSetUp: (name: string, taskId: string) => Promise<{ success: boolean; error?: string }>;
    /** Every coordination state change, for every server, as main learns it. */
    onCoordination: (callback: (state: CrucibleCoordinationState) => void) => () => void;
  };
  foundry: {
    version: () => Promise<{ ok: boolean; path?: string; version?: string; commit?: string | null; error?: string }>;
  };
  /**
   * BookForge's OWN record about the hosted Foundry: which project a book has.
   * Its own family, deliberately not `foundry:*` — that name belongs to the
   * foundry CLI, and the hosted window brings its own IPC.
   */
  foundryHost: {
    /**
     * The project KEY and its resolved directory, or nulls when the book has none.
     *
     * `standaloneSource` is the project in STANDALONE Foundry’s own library that
     * this book was adopted from, when one is still there. Null is the ordinary
     * state of a book whose project was made in the hosted window, and it is what
     * draws the Reload button disabled — the reason in words belongs to a press,
     * not to a greyed control.
     */
    project: (projectDir: string) => Promise<{
      success: boolean;
      key?: string | null;
      dir?: string | null;
      standaloneSource?: FoundryStandaloneSource | null;
      error?: string;
    }>;
    /**
     * Open the Foundry window on this book — deep-linked into its project, or
     * bare when it has none yet (the Import-via-Foundry door). `opened` says
     * which happened. A second press raises the window already open.
     */
    open: (projectDir: string) =>
      Promise<{ success: boolean; opened?: 'bare' | 'project'; error?: string }>;
    /**
     * Foundry projects this library has never seen — standalone Foundry's own
     * library, and orphans in our hosted root that no book's manifest maps.
     *
     * `blocked` are projects that ARE projects and cannot be adopted; they are
     * drawn greyed with their one-clause `reason` on hover, rather than
     * explained in a paragraph beside a list they are absent from. `refusals`
     * is what is left: a root that would not list at all, which has no row to
     * be shown on.
     */
    adoptables: () => Promise<{
      success: boolean;
      projects?: FoundryAdoptableProject[];
      blocked?: FoundryBlockedProject[];
      refusals?: string[];
      error?: string;
    }>;
    /**
     * Make a book of this library out of an existing Foundry project: copy it
     * under the hosted root if it is not already there, mint the book from the
     * project's own archived original, record the mapping, and land whatever is
     * already in its export tray as versions.
     */
    adopt: (sourceDir: string) =>
      Promise<{ success: boolean; result?: FoundryAdoptResult; error?: string }>;
    /**
     * Bring an already-adopted book’s hosted copy forward from the standalone
     * project it came from — only the files that differ — and land any export
     * that has appeared in its tray since. Never overwrites a hosted copy that is
     * ahead of the original; that is reported as its own outcome.
     */
    reload: (bookDir: string) =>
      Promise<{ success: boolean; result?: FoundryRefreshResult; error?: string }>;
    /** Pick a project folder by hand — the fallback for one in neither place. */
    browseForProject: () =>
      Promise<{ success: boolean; folderPath?: string; canceled?: boolean; error?: string }>;
    /**
     * Foundry landed an export as a VERSION of a book. Broadcast to EVERY window
     * — the versions page can be open in more than one, the shelf is drawn in
     * another, and the export was started somewhere else entirely.
     */
    onVersionsChanged: (callback: (event: { projectDir: string }) => void) => () => void;
    /** A book's Foundry project mapping was learned or corrected (first contact). */
    onProjectChanged: (callback: (event: { projectDir: string }) => void) => () => void;
    /**
     * An export landed from a Foundry project no book of ours claims. Nothing
     * was recorded; this exists so the user is told rather than left wondering.
     */
    onUnmatchedExport: (callback: (event: { key: string; title: string }) => void) => () => void;
    /**
     * Somebody clicked the status chip in the hosted Foundry's chrome, and main
     * has raised this window. Show them the queue the chip describes.
     *
     * MAIN WINDOW ONLY, unlike the three announcements above: main sends it to
     * `mainWindow` alone, because a standalone popup has no nav rail and no
     * route to /queue to land on.
     */
    onOpenQueue: (callback: () => void) => () => void;
    /**
     * Narrate was pressed in Foundry's window; main has raised this one. Open
     * the narration dialog on the book it names.
     *
     * MAIN WINDOW ONLY, for the same reason as `onOpenQueue`: main sends it to
     * `mainWindow` alone, and a broadcast would have every open popup race to
     * answer one press.
     */
    onNarrate: (callback: (target: FoundryNarrateTarget) => void) => () => void;
  };
  /**
   * The document pipeline: a book's working PDF and the book itself.
   *
   * Every call names a PROJECT, never a path. The working document's name is
   * derived from the original's, so a renderer that held one could hold a stale
   * one — and a window open across a re-import would then curate a document
   * belonging to different bytes. Deriving it per call costs a path join and
   * makes that unreachable.
   */
  document: {
    cancelStage: (projectDir: string) => Promise<{ success: boolean; stopped?: boolean }>;
    /** Stages running right now, with the last line each emitted. */
    activeStages: () => Promise<{
      success: boolean;
      stages: Array<{
        projectDir: string;
        label: string;
        startedAt: number;
        lastProgress: {
          stage: string; message: string; done: number; total: number;
          render?: { done: number; total: number }; at: number;
        } | null;
      }>;
    }>;
    onStageProgress: (callback: (event: DocumentStageProgressEvent) => void) => () => void;
    onStageStarted: (callback: (event: { projectDir: string; stage: string }) => void) => () => void;
    onStageFinished: (callback: (event: { projectDir: string; stage: string }) => void) => () => void;
  };
  /**
   * A processing run: an ordered list of passes over one project's book.
   *
   * `submitChain` is THE entry point — main plans it (it is the side that knows
   * the manifest, the run directory and the page count) and QUEUES it, because
   * the queue is main's. `followOn` is the work that rides behind the passes in
   * the same run — narrate, enhance, assemble — built by the caller so that
   * anything which can fail while building it fails with nothing queued.
   * Nothing else may build pass jobs by hand.
   */
  narration: {
    textReadiness: (projectDir: string, askedPath?: string, familyId?: string) =>
      Promise<{
      success: boolean;
      readiness?: { ok: true; at: string; model: string }
        | { ok: false; state: 'missing' | 'stale'; reason: string }
        | null;
      fileState?: { ok: true; stamp: { normalizerVersion: string; punctuationSpec: string;
        model: string } }
        | { ok: false; state: 'missing' | 'stale'; reason: string }
        | null;
      familyId?: string | null;
      bookPath?: string | null;
      familyNote?: string;
      error?: string;
    }>;
  };
  processing: {
    planChain: (request: ProcessingChainRequest) =>
      Promise<{ success: boolean; plan?: ProcessingChainPlan; error?: string }>;
    submitChain: (request: ProcessingChainRequest, followOn?: QueueStepSpec[]) =>
      Promise<{ success: boolean; plan?: ProcessingChainPlan; jobId?: string; error?: string }>;
    runPass: (jobId: string, config: PassJobConfig) =>
      Promise<{ success: boolean; data?: PassJobResult; error?: string }>;
    listPassDiffs: (projectDir: string, familyId?: string) =>
      Promise<{ success: boolean; diffs?: PassDiffEntry[]; error?: string }>;
    /** Start a book over. `preview: true` reports what WOULD go, writing nothing. */
    resetBook: (request: { projectDir: string; preview?: boolean }) =>
      Promise<{ success: boolean; summary?: BookResetSummary; error?: string }>;
  };
  /**
   * The other route to a book (`foundry vlm-convert`), and the narration copy
   * cut from what the user struck out of it. See shared/vlm/.
   */
  vlm: {
    convert: (request: VlmConvertRequest) =>
      Promise<{ success: boolean; result?: VlmConvertResult; error?: string }>;
    /** Is the configured endpoint up, and what is it serving? */
    checkEndpoint: (config: VlmEndpointConfig) =>
      Promise<{ success: boolean; check?: VlmEndpointCheck; error?: string }>;
    /**
     * What page answers are already banked for this PDF, and whether the run
     * that banked them FINISHED — asked at the moment a conversion is committed
     * to, so the user chooses what happens to hours of banked GPU work.
     */
    readingsBank: (request: VlmConvertRequest) =>
      Promise<{ success: boolean; bank?: VlmReadingsBank; error?: string }>;
    /**
     * Why the WSL page reader is unavailable (null when it is ready), and
     * whether one is running right now. Fed to `resolveVlmRoute` by every
     * surface that has to state whether a conversion can happen.
     */
    readerStatus: () => Promise<{
      success: boolean;
      wslRefusal?: string | null;
      server?: { running: boolean; url: string; model: string | null };
      /**
       * WHICH MACHINE THE RUN WOULD GO TO, read the way the run reads it
       * (`decideWherePagesRun`). Null when the decision itself refused, in which
       * case `venueRefusal` says so — a card that drew a local GPU for a run
       * about to go to a Crucible was the defect this field closes.
       */
      venue?: { where: 'crucible'; server: string; because: string } | null;
      /** The venue decision's own refusal, verbatim. The run refuses the same way. */
      venueRefusal?: string | null;
      error?: string;
    }>;
  };
  window: {
    hide: () => Promise<{ success: boolean }>;
    close: () => Promise<{ success: boolean }>;
    /**
     * Ask main to raise the main window and have it queue this project's
     * PDF→EPUB conversion. The queue lives in the main window; a second window
     * enqueueing into its own copy would overwrite the state the user watches.
     */
    showBookConversion: (projectDir: string) => Promise<{ success: boolean; error?: string }>;
    /** Main asked THIS window to queue a conversion. Main window only. */
    onShowBookConversion: (callback: (projectDir: string) => void) => () => void;
    /**
     * Does ANY BookForge window have focus? The completion toasts show in the
     * focused window only, and a renderer can see its own focus and nothing
     * else's — so the unfocused main window asks this before speaking for an app
     * nobody is looking at.
     */
    anyFocused: () => Promise<{ focused: boolean }>;
  };
  plugins: {
    list: () => Promise<{ success: boolean; data?: PluginInfo[]; error?: string }>;
    getSettings: (pluginId: string) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
    updateSettings: (pluginId: string, settings: Record<string, unknown>) => Promise<{ success: boolean; errors?: string[]; error?: string }>;
    checkAvailability: (pluginId: string) => Promise<{ success: boolean; data?: { available: boolean; version?: string; path?: string; error?: string; installInstructions?: string }; error?: string }>;
    invoke: (pluginId: string, channel: string, ...args: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    onProgress: (callback: (progress: PluginProgress) => void) => () => void;
  };
  /**
   * The queue, which is MAIN's.
   *
   * Every door here is a command or a question — nothing STARTS a job through
   * this namespace any more. `runTtsConversion` / `runTranslation` /
   * `runBookAnalysis` went with the renderer-side scheduler that called them: the
   * work is started by a step module beside the bridge it calls, and asking a
   * window to start a nine-hour render is the arrangement this replaced.
   *
   * `onChanged` carries the WHOLE list, to every window, on every change. The
   * mirror replaces rather than patches, so it cannot drift by missing an event.
   */
  queue: {
    list: () => Promise<{ success: boolean; data?: QueueSnapshot; error?: string }>;
    enqueue: (spec: QueueJobSpec) => Promise<{ success: boolean; data?: QueueEngineJob; error?: string }>;
    appendStep: (jobId: string, spec: QueueAppendStepSpec) => Promise<{ success: boolean; data?: QueueEngineStep; error?: string }>;
    release: (target?: QueueTarget) => Promise<{ success: boolean; error?: string }>;
    start: (target?: QueueTarget) => Promise<{ success: boolean; error?: string }>;
    pause: () => Promise<{ success: boolean; error?: string }>;
    cancel: (target: QueueTarget, reason?: string,
      opts?: { resumable?: boolean }) => Promise<{ success: boolean; error?: string }>;
    retry: (target: QueueTarget) => Promise<{ success: boolean; error?: string }>;
    remove: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    reorder: (jobId: string, beforeJobId: string | null) => Promise<{ success: boolean; error?: string }>;
    clearFinished: () => Promise<{ success: boolean; error?: string }>;
    updateStepConfig: (stepId: string, patch: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
    /**
     * WHICH CRUCIBLE SERVER THIS BOOK WAITS FOR — a server's name, or `any`
     * (crucible `docs/PHASE7-LANES.md` §4.2.1).
     *
     * Editable while the row is queued; refused once the book has been
     * assigned, because a job is atomic and finishes on the machine it started
     * on. A name this machine does not have is refused by name.
     */
    setWaitFor: (jobId: string, value: string) => Promise<{ success: boolean; error?: string }>;
    /**
     * How many queued books name each server, and how many say nothing.
     *
     * What the Servers row shows beside a switch somebody just turned off:
     * *"12 rows are waiting for this PC, which is now disabled."* They are
     * TOLD, never moved — see {@link bulkWaitFor} for the one-click answer.
     */
    waitForCounts: () => Promise<{
      success: boolean;
      data?: { counts: Record<string, number>; unset: number };
      error?: string;
    }>;
    /** Move every queued book that says `from` (null = says nothing) onto `to`. */
    bulkWaitFor: (from: string | null, to: string) =>
      Promise<{ success: boolean; data?: { moved: number }; error?: string }>;
    /**
     * TURN THE QUEUE'S GPU DIAL — `any`, or one registered server's name
     * (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`).
     *
     * The dial DEFERS: a book that names a machine is never sent elsewhere by
     * it, and a book that says `any` takes the dial's machine. A RUNNING job
     * ignores it entirely — turning it governs the admission of new runs only,
     * so this can never take work off a card.
     *
     * Its current value rides on the snapshot (`QueueSnapshot.gpuDial`); this is
     * only the write. A server this machine does not have is refused BY NAME.
     */
    setGpuDial: (value: string) =>
      Promise<{ success: boolean; data?: { dial: string }; error?: string }>;
    /**
     * SEND A STAGED BOOK INTO THE LIVE QUEUE.
     *
     * Adding a book puts it in Pending, where its server is chosen while nothing
     * about it is committed; this is the press that commits it. Refused by name
     * for a run that is already in the queue.
     */
    sendToQueue: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    /**
     * The reverse press: take a book back out of the queue and into Pending,
     * stopping it first if it is running. Its settings are kept exactly and its
     * server is a question again. Refused by name for a run already in Pending,
     * and for one that chooses no machine.
     */
    returnToPending: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    /** What that return would NOT throw away — a sentence, or null. Read-only. */
    returnToPendingWarning: (jobId: string) => Promise<{
      success: boolean; data?: { warning: string | null }; error?: string;
    }>;
    onChanged: (callback: (snapshot: QueueSnapshot) => void) => () => void;
    onStepFinished: (callback: (event: QueueStepFinished) => void) => () => void;
    /**
     * The queue has something to say about work it did NOT accept.
     *
     * `onStepFinished` is news about a step; this is news about a run that never
     * became one — a Narrate pressed on a Foundry step with nothing exported
     * yet, an Enhance whose settings name no model. Those refusals are thrown
     * back to the tree that asked as well, but the thing to DO about them is in
     * a BookForge window, so they are said in both places.
     */
    onNotice: (callback: (notice: QueueNotice) => void) => () => void;
  };
  diff: {
    loadComparison: (originalPath: string, cleanedPath: string) => Promise<{
      success: boolean;
      data?: DiffComparisonResult;
      error?: string;
    }>;
    // Memory-efficient: get only chapter metadata (no text)
    getMetadata: (originalPath: string, cleanedPath: string) => Promise<{
      success: boolean;
      data?: {
        chapters: Array<{
          id: string;
          title: string;
          hasOriginal: boolean;
          hasCleaned: boolean;
        }>;
      };
      error?: string;
    }>;
    // Memory-efficient: load a single chapter's text on demand
    getChapter: (originalPath: string, cleanedPath: string, chapterId: string) => Promise<{
      success: boolean;
      data?: {
        originalText: string;
        cleanedText: string;
      };
      error?: string;
    }>;
    // Compute change counts for chapters not covered by a cleanup job's cache
    getChangeCounts: (originalPath: string, cleanedPath: string, chapterIds?: string[]) => Promise<{
      success: boolean;
      data?: {
        counts: Array<{ id: string; changeCount: number }>;
      };
      error?: string;
    }>;
    onLoadProgress: (callback: (progress: DiffLoadProgress) => void) => () => void;
    // Cache operations
    saveCache: (originalPath: string, cleanedPath: string, chapterId: string, cacheData: unknown) => Promise<{
      success: boolean;
      error?: string;
    }>;
    loadCache: (originalPath: string, cleanedPath: string, chapterId: string) => Promise<{
      success: boolean;
      data?: unknown;
      notFound?: boolean;
      error?: string;
    }>;
    clearCache: (originalPath: string, cleanedPath: string) => Promise<{
      success: boolean;
      deleted?: number;
      error?: string;
    }>;
    getCacheKey: (originalPath: string, cleanedPath: string) => Promise<{
      success: boolean;
      cacheKey?: string;
      error?: string;
    }>;
    // Pre-computed diff cache (created during AI cleanup)
    loadCachedFile: (cleanedPath: string) => Promise<{
      success: boolean;
      data?: {
        version: number;
        createdAt: string;
        updatedAt: string;
        ignoreWhitespace: boolean;
        completed: boolean;  // True when job finished, false if still running/interrupted
        chapters: Array<{
          id: string;
          title: string;
          originalCharCount: number;
          cleanedCharCount: number;
          changeCount: number;
          changes: Array<{ pos: number; len: number; add?: string; rem?: string }>;
        }>;
      };
      needsRecompute?: boolean;
      error?: string;
    }>;
    hydrateChapter: (originalPath: string, cleanedPath: string, chapterId: string, changes: Array<{ pos: number; len: number; add?: string; rem?: string }>) => Promise<{
      success: boolean;
      data?: {
        diffWords: Array<{ text: string; type: 'unchanged' | 'added' | 'removed' }>;
        cleanedText: string;
        originalText: string;
      };
      error?: string;
    }>;
    /** One pass diff by its own path. Self-contained: it carries its after-text. */
    loadPassFile: (diffPath: string) => Promise<{
      success: boolean;
      data?: {
        version: number;
        createdAt: string;
        updatedAt: string;
        ignoreWhitespace: boolean;
        completed: boolean;
        chapters: Array<{
          id: string;
          title: string;
          originalCharCount: number;
          cleanedCharCount: number;
          changeCount: number;
          changes: Array<{ pos: number; len: number; add?: string; rem?: string; fn?: 'archive' | 'inferred' }>;
          text?: string;
        }>;
      };
      error?: string;
    }>;
    // Pre-compute diff cache for an arbitrary EPUB pair (background)
    precomputePair: (originalPath: string, targetPath: string) => Promise<{
      success: boolean;
      cached?: boolean;
      chapters?: number;
      error?: string;
    }>;
  };
  ebookConvert: {
    isAvailable: () => Promise<{ success: boolean; data?: { available: boolean }; error?: string }>;
    getSupportedExtensions: () => Promise<{ success: boolean; data?: string[]; error?: string }>;
    isConvertible: (filePath: string) => Promise<{ success: boolean; data?: { convertible: boolean; native: boolean }; error?: string }>;
    convert: (inputPath: string, outputDir?: string) => Promise<{ success: boolean; data?: { outputPath: string }; error?: string }>;
    convertToLibrary: (inputPath: string) => Promise<{ success: boolean; data?: { outputPath: string }; error?: string }>;
  };
  jwpub: {
    convert: (jwpubPath: string) => Promise<{
      success: boolean;
      outputPath?: string;
      metadata?: { title: string; author: string; year: string; language: string };
      error?: string;
    }>;
  };
  play: {
    startSession: () => Promise<{ success: boolean; data?: { voices: string[] }; error?: string }>;
    loadVoice: (voice: string) => Promise<{ success: boolean; error?: string }>;
    endSession: () => Promise<{ success: boolean; error?: string }>;
    isSessionActive: () => Promise<{ success: boolean; data?: { active: boolean }; error?: string }>;
    getVoices: () => Promise<{ success: boolean; data?: { voices: Array<{ id: string; name: string; group: string }> }; error?: string }>;
    onStatus: (callback: (status: { message: string }) => void) => () => void;
    onSessionEnded: (callback: (data: { code: number }) => void) => () => void;
    onSessionStarted: (callback: () => void) => () => void;
    openListenWindow: (projectPath: string, audioPath?: string) => Promise<{ success: boolean; alreadyOpen?: boolean; error?: string }>;
    onSelectAudio: (callback: (audioPath: string) => void) => () => void;
    listListenSources: (projectPath: string) => Promise<{
      success: boolean;
      epubs?: Array<{ kind: string; lang?: string; path: string; mtimeMs: number }>;
      m4bs?: Array<{ fileName: string; path: string; vttPath?: string; mtimeMs: number }>;
      error?: string;
    }>;
    streamStart: (sentences: string[], startIndex: number, settings: PlaySettings, requestId: number) => Promise<{ success: boolean; error?: string }>;
    streamStop: () => Promise<{ success: boolean; error?: string }>;
    streamPlayhead: (requestId: number, sentenceIndex: number) => Promise<{ success: boolean; error?: string }>;
    onStreamEvent: (callback: (event: Record<string, unknown>) => void) => () => void;
  };
  ttsService: {
    start: (voice?: string) => Promise<{ success: boolean; voices?: string[]; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    status: () => Promise<{ success: boolean; state?: 'stopped' | 'starting' | 'warming' | 'running'; serviceMode?: boolean; error?: string }>;
    onState: (callback: (state: { state: 'stopped' | 'starting' | 'warming' | 'running'; serviceMode: boolean }) => void) => () => void;
    onWarmup: (callback: (data: { pct: number; message?: string }) => void) => () => void;
    /** Fired when the streaming voice/engine selection changes from any source. */
    onConfig: (callback: () => void) => () => void;
  };
  /** The tab recorder's endpoint (docs/TAB_RECORDER.md). This socket carried
   *  speech until Phase 16 step 8; it does not any more — the extension talks to
   *  a Crucible directly. What is left is the recorder's address, which is still
   *  the app's to decide because the recorder's file lands on the app's disk. */
  tabRecord: {
    status: () => Promise<{ success: boolean; data?: { running: boolean; port: number; host: string; token: string; addresses: string[] }; error?: string }>;
    configure: (updates: { port?: number; host?: string }) => Promise<{ success: boolean; data?: { running: boolean; port: number; host: string; token: string; addresses: string[] }; error?: string }>;
  };
  ttsStream: {
    getWorkerConfig: () => Promise<{ success: boolean; data?: { enabled: boolean; count: number; defaultCount: number; minWorkers: number; maxWorkers: number; devicePref: 'auto' | 'cpu' | 'gpu' | 'mps'; device: 'cpu' | 'cuda' | 'mps' | null; deviceWorkers: number; activeWorkers: number; engine?: 'orpheus'; engines?: { id: 'orpheus'; name: string; available: boolean; reason?: string }[]; voices?: string[]; voice?: string; currentVoice?: string | null }; error?: string }>;
    setWorkerConfig: (updates: { engine?: 'orpheus'; enabled?: boolean; count?: number; devicePref?: 'auto' | 'cpu' | 'gpu' | 'mps'; voice?: string }) => Promise<{ success: boolean; data?: { enabled: boolean; count: number; defaultCount: number; minWorkers: number; maxWorkers: number; devicePref: 'auto' | 'cpu' | 'gpu' | 'mps'; device: 'cpu' | 'cuda' | 'mps' | null; deviceWorkers: number; activeWorkers: number; engine?: 'orpheus'; engines?: { id: 'orpheus'; name: string; available: boolean; reason?: string }[]; voices?: string[]; voice?: string; currentVoice?: string | null }; error?: string }>;
  };
  /**
   * The Doctor (Settings → Doctor). One reading over the two mechanisms that
   * own this machine's necessary parts, and one repair per row.
   */
  /**
   * The local Crucible's presence at startup, and the door the offer presses.
   *
   * The main process REPORTS; this app draws it with its own modal and toast.
   * There is no native message box behind any of this (Owen, 2026-09-17).
   */
  enginePresence: {
    onNotice: (callback: (n: {
      state: string; detail: string; message: string; offerStart: boolean;
    }) => void) => () => void;
    start: () => Promise<{ success: boolean; error?: string }>;
  };
  doctor: {
    check: () => Promise<{ success: boolean; data?: DoctorReport; error?: string }>;
    fix: (id: string) => Promise<{ success: boolean; error?: string }>;
    /** Progress lines while a fix runs. Returns its own unsubscribe. */
    onProgress: (callback: (p: { id: string; message: string }) => void) => () => void;
  };
  components: {
    list: () => Promise<ComponentStatus[]>;
    get: (id: string) => Promise<ComponentStatus | null>;
    probe: (force?: boolean) => Promise<SystemProfile>;
    detectExternal: (id: string) => Promise<string | null>;
    setExternalPath: (id: string, path: string) => Promise<ComponentStatus>;
    install: (id: string) => Promise<InstallResult>;
    runInstaller: (id: string) => Promise<InstallResult>;
    installers: () => Promise<{ ids: string[]; notes: Record<string, string | null> }>;
    cancel: (id: string) => Promise<void>;
    uninstall: (id: string) => Promise<void>;
    testEnv: (id: string) => Promise<EnvDiagnosticResult>;
    onProgress: (callback: (p: InstallProgress) => void) => () => void;
    /** The startup upgrade sweep: null until it has finished. */
    upgrades: () => Promise<StartupUpgradeReport | null>;
    onUpgradesAvailable: (callback: (report: StartupUpgradeReport) => void) => () => void;
  };
  whisper: {
    listModels: () => Promise<{ success: boolean; data?: WhisperModelStatus[]; error?: string }>;
    downloadModel: (id: string) => Promise<{ ok: boolean; error?: string }>;
    deleteModel: (id: string) => Promise<{ ok: boolean; error?: string }>;
    onDownloadProgress: (callback: (p: WhisperDownloadProgress) => void) => () => void;
  };
  update: {
    // Managed binaries (ffmpeg, yt-dlp, …) — our server-hosted, watched components.
    listComponents: (force?: boolean) => Promise<ComponentUpdateStatus[]>;
    installComponent: (id: string) => Promise<ComponentUpdateStatus>;
    onComponentStatus: (callback: (s: ComponentUpdateStatus) => void) => () => void;
    onComponentsAvailable: (callback: (list: ComponentUpdateStatus[]) => void) => () => void;
    // Starter library — finished sample seeded into an empty library on first run.
    getStarterStatus: () => Promise<StarterStatus>;
    installStarter: () => Promise<StarterStatus>;
    onStarterProgress: (callback: (s: StarterStatus) => void) => () => void;
  };
  parallelTts: {
    detectRecommendedWorkerCount: () => Promise<{ success: boolean; data?: HardwareRecommendation; error?: string }>;
    startConversion: (jobId: string, config: ParallelConversionConfig) => Promise<{ success: boolean; data?: ParallelConversionResult; error?: string }>;
    stopConversion: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    getProgress: (jobId: string) => Promise<{ success: boolean; data?: ParallelAggregatedProgress | null; error?: string }>;
    isActive: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    listActive: () => Promise<{ success: boolean; data?: Array<{ jobId: string; progress: ParallelAggregatedProgress; epubPath: string; startTime: number }>; error?: string }>;
    onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => () => void;
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string }; sessionId?: string; sessionDir?: string }) => void) => () => void;
    onSessionCreated: (callback: (data: { jobId: string; sessionId: string; sessionDir: string; processDir: string; totalSentences: number; totalChapters: number }) => void) => () => void;
    // Resume support
    /** A half-finished render cached under this project, or null. The narration
     *  dialog asks so it can offer Resume vs Start over; the queue step asks the
     *  same function to decide. */
    cachedRender: (projectDir: string, language?: string) => Promise<{
      success: boolean;
      data?: { sessionDir: string; language: string; completedSentences: number; totalSentences: number } | null;
      error?: string;
    }>;
    checkResumeFast: (epubPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
    checkResumeFromDir: (processDir: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
    checkResume: (sessionPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
    resumeConversion: (jobId: string, config: ParallelConversionConfig, resumeInfo: ResumeCheckResult) => Promise<{ success: boolean; data?: ParallelConversionResult; error?: string }>;
    buildResumeInfo: (prepInfo: any, settings: any) => Promise<{ success: boolean; data?: TtsResumeInfo; error?: string }>;
  };
  sessionCache: {
    saveToBfp: (sessionDir: string, projectDir: string) => Promise<{ success: boolean; cachedPath?: string; error?: string }>;
    saveToProject: (sessionDir: string, projectDir: string, language: string) => Promise<{ success: boolean; cachedSentencesDir?: string; error?: string }>;
    scanProject: (projectDir: string) => Promise<{ success: boolean; sessions: Array<{ language: string; sessionDir: string; sentencesDir: string; sentenceCount: number; createdAt: string }>; error?: string }>;
  };
  videoAssembly: {
    run: (jobId: string, config: {
      projectId: string;
      bfpPath: string;
      mode: 'bilingual' | 'monolingual';
      // No m4bPath/vttPath: main resolves both from bfpPath/output at run time, when
      // the assembly step has actually produced them (see resolveOutputPaths in
      // electron/video-assembly-bridge.ts).
      sentencePairsPath?: string;
      title: string;
      sourceLang: string;
      targetLang?: string;
      resolution: '480p' | '720p' | '1080p';
      outputFilename?: string;
    }) => Promise<{ success: boolean; jobId?: string; error?: string }>;
    cancel: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    onProgress: (callback: (data: { jobId: string; phase: string; percentage: number; message: string }) => void) => () => void;
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string }) => void) => () => void;
  };
  generateSentences: {
    run: (jobId: string, config: {
      projectId: string;
      variantId: string;
      m4bPath: string;
      modelId: string;
      language?: string;
    }) => Promise<{ success: boolean; jobId?: string; error?: string }>;
    cancel: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    onProgress: (callback: (data: { jobId: string; percentage: number; message: string }) => void) => () => void;
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string }) => void) => () => void;
  };
  reassembly: {
    scanSessions: (customTmpPath?: string) => Promise<{ success: boolean; data?: NarratorSessionScanResult; error?: string }>;
    getSession: (sessionId: string, customTmpPath?: string) => Promise<{ success: boolean; data?: NarratorSession; error?: string }>;
    resolveSentenceGap: (processDir: string) => Promise<{ success: boolean; data?: { isOrpheus: boolean; voice?: string; gap: number; hasModelValue: boolean }; error?: string }>;
    startReassembly: (jobId: string, config: ReassemblyConfig) => Promise<{ success: boolean; data?: { outputPath?: string }; error?: string }>;
    stopReassembly: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string, customTmpPath?: string) => Promise<{ success: boolean; error?: string }>;
    saveMetadata: (
      sessionId: string,
      processDir: string,
      metadata: {
        title?: string;
        author?: string;
        year?: string;
        narrator?: string;
        series?: string;
        seriesNumber?: string;
        genre?: string;
        description?: string;
      },
      coverData?: {
        type: 'base64' | 'path';
        data: string;
        mimeType?: string;
      }
    ) => Promise<{ success: boolean; error?: string; coverPath?: string }>;
    isAvailable: () => Promise<{ success: boolean; data?: { available: boolean }; error?: string }>;
    getBfpSession: (projectDir: string) => Promise<{ success: boolean; data?: NarratorSession | null; error?: string }>;
    onProgress: (callback: (data: { jobId: string; progress: ReassemblyProgress }) => void) => () => void;
  };
  correctSentences: {
    getSession: (projectDir: string) => Promise<{ success: boolean; data?: CorrectSentencesSession; error?: string }>;
    generateCandidates: (
      jobId: string,
      params: { projectDir: string; indices: number[]; takes?: number; overrides?: Record<number, string> }
    ) => Promise<{ success: boolean; data?: GenerateCandidatesResult; error?: string }>;
    cancel: (jobId: string) => Promise<{ success: boolean }>;
    commit: (params: { projectDir: string; index: number; sourceFlacPath: string; text?: string }) => Promise<{ success: boolean; error?: string }>;
    revert: (params: { projectDir: string; index: number }) => Promise<{ success: boolean; error?: string }>;
    cleanup: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    onProgress: (callback: (data: { jobId: string; done: number; total: number }) => void) => () => void;
  };
  rvc: {
    startEnhancement: (jobId: string, config: unknown) => Promise<{ success: boolean; data?: { scratchDir?: string }; error?: string; wasStopped?: boolean }>;
    stopEnhancement: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    onProgress: (callback: (data: { jobId: string; progress: { phase: string; percentage: number; processed?: number; total?: number; message?: string; error?: string } }) => void) => () => void;
  };
  chapterRecovery: {
    detectChapters: (epubPath: string, vttPath: string, m4bPath?: string) => Promise<{
      success: boolean;
      chapters?: Array<{
        id: string;
        title: string;
        epubOrder: number;
        detectedTimestamp: string | null;
        detectedSeconds: number | null;
        confidence: 'high' | 'medium' | 'low' | 'manual' | 'not_found';
        manualTimestamp: string | null;
        openingText: string;
      }>;
      error?: string;
    }>;
    applyChapters: (m4bPath: string, chapters: Array<{ title: string; timestamp: string }>) => Promise<{
      success: boolean;
      outputPath?: string;
      chaptersApplied?: number;
      error?: string;
    }>;
    probeChapters: (audioPath: string) => Promise<{ success: boolean; chapters?: Array<{ title: string; start: number; end: number }>; error?: string }>;
  };
  reader: {
    list: () => Promise<{ success: boolean; readers: Array<{ id: string; name: string; hasPin: boolean }>; error?: string }>;
    recordListening: (p: { readerId: string; bookPath: string; title: string; author: string; seconds: number; id?: string }) => Promise<{ success: boolean; error?: string }>;
    savePosition: (p: { readerId: string; bookPath: string; seconds: number }) => Promise<{ success: boolean; error?: string }>;
    getPosition: (p: { readerId: string; bookPath: string }) => Promise<{ success: boolean; seconds: number | null; error?: string }>;
    listBookmarks: (p: { readerId: string; bookPath: string }) => Promise<{ success: boolean; bookmarks: Array<Record<string, unknown>>; error?: string }>;
    saveBookmark: (p: { readerId: string; bookPath: string; op: 'add' | 'del'; bookmark: Record<string, unknown> & { id?: string } }) => Promise<{ success: boolean; error?: string }>;
  };
  debug: {
    log: (message: string) => Promise<void>;
    /** Write a TTS resume/cache decision into the persisted tts.log (see main.ts). */
    ttsDecision: (level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: Record<string, unknown>) => Promise<void>;
    saveLogs: (content: string, filename: string) => Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }>;
  };
  /**
   * ARTICLE IMPORT — the two survivors of the language-learning namespace.
   *
   * The feature was removed on 2026-09-05; these two were never part of it.
   * `fetchUrl` is the studio's "add from a URL" door and `finalizeContent` writes
   * the article EPUB its content editor produces. The key and the channel names
   * are the wire contract with main and `ElectronService`, so they keep the old
   * spelling rather than a rename across three files to fix a word.
   */
  languageLearning: {
    fetchUrl: (url: string, projectId?: string) => Promise<{
      success: boolean;
      projectId?: string;
      htmlPath?: string;
      title?: string;
      byline?: string;
      excerpt?: string;
      content?: string;
      textContent?: string;
      wordCount?: number;
      partial?: boolean;
      warning?: string;
      error?: string;
    }>;
    finalizeContent: (projectId: string, finalizedHtml: string) => Promise<{
      success: boolean;
      epubPath?: string;
      error?: string;
    }>;
  };
  manifest: {
    create: (
      projectType: 'book' | 'article',
      source: Record<string, unknown>,
      metadata: Record<string, unknown>
    ) => Promise<{
      success: boolean;
      projectId?: string;
      projectPath?: string;
      manifestPath?: string;
      error?: string;
    }>;
    get: (projectId: string) => Promise<{
      success: boolean;
      manifest?: Record<string, unknown>;
      projectPath?: string;
      error?: string;
    }>;
    update: (update: {
      projectId: string;
      source?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      chapters?: unknown[];
      pipeline?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
      editor?: Record<string, unknown>;
    }) => Promise<{
      success: boolean;
      manifestPath?: string;
      error?: string;
    }>;
    /**
     * One project's editor state, from its own file. `get`/`list` do NOT carry
     * it — that is the point. `editor: null` means the project has none.
     */
    getEditorState: (projectId: string) => Promise<{
      success: boolean;
      editor?: Record<string, unknown> | null;
      error?: string;
    }>;
    list: (filter?: { type?: 'book' | 'article' }) => Promise<{
      success: boolean;
      projects?: Record<string, unknown>[];
      error?: string;
    }>;
    delete: (projectId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    importSource: (projectId: string, sourcePath: string, targetFilename?: string) => Promise<{
      success: boolean;
      relativePath?: string;
      error?: string;
    }>;
    resolvePath: (projectId: string, relativePath: string) => Promise<{ path: string }>;
    getProjectPath: (projectId: string) => Promise<{ path: string }>;
    exists: (projectId: string) => Promise<{ exists: boolean }>;
    getAllTags: () => Promise<string[]>;
    scanLegacy: () => Promise<{
      success: boolean;
      bfpCount: number;
      audiobookCount: number;
      articleCount: number;
      total: number;
    }>;
    needsMigration: () => Promise<{ needsMigration: boolean }>;
    migrateAll: () => Promise<{
      success: boolean;
      migrated: string[];
      failed: Array<{ path: string; error: string }>;
    }>;
    onMigrationProgress: (callback: (progress: Record<string, unknown>) => void) => void;
    offMigrationProgress: () => void;
  };
  archive: {
    saveToArchive: (projectId: string, sourcePath: string, options: {
      role: 'original' | 'translation' | 'export' | 'audiobook';
      format: string;
      language?: string;
      label?: string;
    }) => Promise<{
      success: boolean;
      entry?: Record<string, unknown>;
      error?: string;
    }>;
    list: (projectId: string) => Promise<{
      success: boolean;
      entries?: Array<Record<string, unknown>>;
      error?: string;
    }>;
    addFile: (projectId: string) => Promise<{
      success: boolean;
      canceled?: boolean;
      entry?: Record<string, unknown>;
      error?: string;
    }>;
  };
  editor: {
    /** Returns the unsubscribe closure for THIS listener (see the impl). */
    onWindowClosed: (callback: (projectPath: string) => void) => () => void;
    /** Returns the unsubscribe closure for THIS listener (see the impl). */
    onFilesChanged: (callback: (projectPath: string) => void) => () => void;
  };
  analysis: {
    delete: (projectDir: string) => Promise<{ success: boolean; error?: string }>;
  };
  /**
   * The Versions page's entry payload, and the push that finishes it.
   *
   * `pageData` is stat-level and returns immediately. Any audiobook fact it
   * could not answer from the derivation cache comes back as `deriving` and
   * arrives later on `onAudiobookFacts` — see electron/versions-page-data.ts.
   */
  versions: {
    pageData: (projectId: string) => Promise<{
      success: boolean;
      error?: string;
      variants?: unknown[];
      primaryVariantId?: string;
      ttsVariantId?: string;
      analysis?: {
        path: string;
        modifiedAt: string;
        flagCount: number;
        isCheckpoint: boolean;
        target: { versionId: string | null; versionType: string; versionLabel: string };
      } | null;
      audiobooks?: VersionsAudiobookFacts[];
      audiobookFactsComplete?: boolean;
    }>;
    /** Returns the unsubscribe closure for THIS listener (see the impl). */
    onAudiobookFacts: (
      callback: (event: { projectId: string; audiobooks: VersionsAudiobookFacts[] }) => void,
    ) => () => void;
  };
  pipeline: {
    deleteCleanup: (projectPath: string) => Promise<{
      success: boolean;
      deletedFiles?: string[];
      message?: string;
      error?: string;
    }>;
    deleteSimplify: (projectPath: string) => Promise<{
      success: boolean;
      deletedFiles?: string[];
      message?: string;
      error?: string;
    }>;
    deleteTranslation: (projectPath: string, epubName?: string) => Promise<{
      success: boolean;
      deletedItems?: string[];
      message?: string;
      error?: string;
    }>;
    deleteTtsCache: (projectPath: string, language?: string) => Promise<{
      success: boolean;
      deletedSessions?: string[];
      message?: string;
      error?: string;
    }>;
    deleteOutput: (projectPath: string) => Promise<{
      success: boolean;
      deletedFiles?: string[];
      message?: string;
      error?: string;
    }>;
    deleteAll: (projectPath: string) => Promise<{
      success: boolean;
      results?: {
        cleanup: { success: boolean; message?: string };
        translation: { success: boolean; message?: string };
        tts: { success: boolean; message?: string };
      };
      message?: string;
      error?: string;
    }>;
    resetEditorState: (projectPath: string, familyId?: string) => Promise<{
      success: boolean;
      message?: string;
      error?: string;
    }>;
    exportEpub: (sourcePath: string, metadata: any, coverPath?: string) => Promise<{
      success: boolean;
      canceled?: boolean;
      filePath?: string;
      error?: string;
    }>;
  };
  platform: string;
  /**
   * `process.arch`. Beside `platform` because the pair is one fact, not two:
   * darwin alone does not say whether MLX can run here (an Intel Mac is darwin
   * and has no Metal runtime for it), and `navigator.platform` says "MacIntel"
   * on both. Read by Settings so the page-reading card can state, before a
   * ninety-minute run rather than after it, that this machine needs an endpoint.
   */
  arch: string;
  /**
   * Where a `File` the renderer was handed — from a drop, or from an `<input
   * type="file">` — actually lives on disk.
   *
   * Electron 32 deleted the `File.path` property the renderer used to read, and
   * `webUtils.getPathForFile` is the replacement; it only works in the preload,
   * which is why it is a door rather than something the renderer does itself.
   *
   * Returns the EMPTY STRING for a File that has no path — one made by `new
   * File(...)`, or dropped out of another page rather than off the filesystem.
   * Callers must read that as "this file is not on disk" and say so; a name is
   * not a path and must never be passed off as one.
   */
  getPathForFile: (file: File) => string;
}

const electronAPI: ElectronAPI = {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) =>
      ipcRenderer.invoke('pdf:analyze', pdfPath, maxPages),
    analyzeQuick: (pdfPath: string, maxPages?: number) =>
      ipcRenderer.invoke('pdf:analyze-quick', pdfPath, maxPages),
    analyzeText: (pdfPath: string, maxPages?: number) =>
      ipcRenderer.invoke('pdf:analyze-text', pdfPath, maxPages),
    measureTextLayer: (pdfPath: string, maxSamples?: number) =>
      ipcRenderer.invoke('pdf:measure-text-layer', pdfPath, maxSamples),
    onTextReady: (callback: (data: { blocks: any[]; categories: Record<string, any>; spans: any[]; pdfPath: string; warnings?: string[] }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: any) => {
        callback(data);
      };
      ipcRenderer.on('pdf:text-ready', listener);
      return () => {
        ipcRenderer.removeListener('pdf:text-ready', listener);
      };
    },
    renderPage: (pageNum: number, scale: number = 2.0, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>, removeBackground?: boolean) =>
      ipcRenderer.invoke('pdf:render-page', pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground),
    renderBlankPage: (pageNum: number, scale: number = 2.0) =>
      ipcRenderer.invoke('pdf:render-blank-page', pageNum, scale),
    renderAllPages: (pdfPath: string, scale: number = 2.0, concurrency: number = 4) =>
      ipcRenderer.invoke('pdf:render-all-pages', pdfPath, scale, concurrency),
    renderWithPreviews: (pdfPath: string, concurrency: number = 4) =>
      ipcRenderer.invoke('pdf:render-with-previews', pdfPath, concurrency),
    renderPages: (pdfPath: string, pageNumbers: number[], quality: 'preview' | 'full' = 'preview') =>
      ipcRenderer.invoke('pdf:render-pages', pdfPath, pageNumbers, quality),
    closeRenderDoc: () =>
      ipcRenderer.invoke('pdf:close-render-doc'),
    closePdf: () =>
      ipcRenderer.invoke('pdf:close'),
    onRenderProgress: (callback: RenderProgressCallback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number; phase?: string }) => {
        callback(progress);
      };
      ipcRenderer.on('pdf:render-progress', listener);
      return () => {
        ipcRenderer.removeListener('pdf:render-progress', listener);
      };
    },
    onAnalyzeProgress: (callback: (progress: { phase: string; message: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { phase: string; message: string }) => {
        callback(progress);
      };
      ipcRenderer.on('pdf:analyze-progress', listener);
      return () => {
        ipcRenderer.removeListener('pdf:analyze-progress', listener);
      };
    },
    onPageUpgraded: (callback: (data: { pageNum: number; path: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { pageNum: number; path: string }) => {
        callback(data);
      };
      ipcRenderer.on('pdf:page-upgraded', listener);
      return () => {
        ipcRenderer.removeListener('pdf:page-upgraded', listener);
      };
    },
    onExportProgress: (callback: (progress: { current: number; total: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: { current: number; total: number }) => {
        callback(progress);
      };
      ipcRenderer.on('pdf:export-progress', listener);
      return () => {
        ipcRenderer.removeListener('pdf:export-progress', listener);
      };
    },
    cleanupTempFiles: () =>
      ipcRenderer.invoke('pdf:cleanup-temp-files'),
    clearCache: (fileHash: string) =>
      ipcRenderer.invoke('pdf:clear-cache', fileHash),
    clearAllCache: () =>
      ipcRenderer.invoke('pdf:clear-all-cache'),
    getCacheSize: (fileHash: string) =>
      ipcRenderer.invoke('pdf:get-cache-size', fileHash),
    getTotalCacheSize: () =>
      ipcRenderer.invoke('pdf:get-total-cache-size'),
    exportText: (enabledCategories: string[]) =>
      ipcRenderer.invoke('pdf:export-text', enabledCategories),
    exportTextOnlyEpub: (pdfPath: string, metadata?: { title?: string; author?: string }) =>
      ipcRenderer.invoke('pdf:export-text-only-epub', pdfPath, metadata),
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>, deletedPages?: number[], chapters?: Array<{ title: string; page: number; level: number }>) =>
      ipcRenderer.invoke('pdf:export-pdf', pdfPath, deletedRegions, ocrBlocks, deletedPages, chapters),
    exportPdfNoBackgrounds: (scale: number = 2.0, deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>, deletedPages?: number[]) =>
      ipcRenderer.invoke('pdf:export-pdf-no-backgrounds', scale, deletedRegions, ocrBlocks, deletedPages),
    exportPdfWysiwyg: (deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, deletedPages?: number[], scale: number = 2.0, ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>) =>
      ipcRenderer.invoke('pdf:export-pdf-wysiwyg', deletedRegions, deletedPages, scale, ocrPages),
    findSimilar: (blockId: string) =>
      ipcRenderer.invoke('pdf:find-similar', blockId),
    findSpansInRect: (page: number, x: number, y: number, width: number, height: number) =>
      ipcRenderer.invoke('pdf:find-spans-in-rect', page, x, y, width, height),
    analyzeSamples: (sampleSpans: TextSpan[]) =>
      ipcRenderer.invoke('pdf:analyze-samples', sampleSpans),
    findMatchingSpans: (pattern: SamplePattern) =>
      ipcRenderer.invoke('pdf:find-matching-spans', pattern),
    findSpansByRegex: (pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) =>
      ipcRenderer.invoke('pdf:find-spans-by-regex', pattern, minFontSize, maxFontSize, minBaseline, maxBaseline, caseSensitive),
    getSpans: () =>
      ipcRenderer.invoke('pdf:get-spans'),
    getSpansForBlock: (blockId: string) =>
      ipcRenderer.invoke('pdf:get-spans-for-block', blockId),
    updateSpansForOcr: (pageNum: number, ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>) =>
      ipcRenderer.invoke('pdf:update-spans-for-ocr', pageNum, ocrBlocks),
    // Chapter detection
    extractOutline: () =>
      ipcRenderer.invoke('pdf:extract-outline'),
    outlineToChapters: (outline: OutlineItem[], deletedPages?: number[]) =>
      ipcRenderer.invoke('pdf:outline-to-chapters', outline, deletedPages),
    detectChapters: (deletedPages?: number[]) =>
      ipcRenderer.invoke('pdf:detect-chapters', deletedPages),
    detectChaptersFromExamples: (blockIds: string[], deletedPages?: number[]) =>
      ipcRenderer.invoke('pdf:detect-chapters-from-examples', blockIds, deletedPages),
    mapTocEntries: (tocBlockIds: string[], deletedPages?: number[]) =>
      ipcRenderer.invoke('pdf:map-toc-entries', tocBlockIds, deletedPages),
    splitTocBlocks: (tocBlockIds: string[]) =>
      ipcRenderer.invoke('pdf:split-toc-blocks', tocBlockIds),
    mapTitlesToChapters: (titles: string[], tocPages: number[], deletedPages?: number[]) =>
      ipcRenderer.invoke('pdf:map-titles-to-chapters', titles, tocPages, deletedPages),
    addBookmarks: (pdfBase64: string, chapters: Chapter[]) =>
      ipcRenderer.invoke('pdf:add-bookmarks', pdfBase64, chapters),
    assembleFromImages: (pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>, chapters?: Chapter[]) =>
      ipcRenderer.invoke('pdf:assemble-from-images', pages, chapters),
  },

  quire: {
    openBook: (epubPath: string, geometry?: { width: number; height: number; fontSize: number }) =>
      ipcRenderer.invoke('quire:open-book', epubPath, geometry),
    closeBook: (handle: string) => ipcRenderer.invoke('quire:close-book', handle),
    relayoutEntries: (handle: string, bookPath: string, entries: string[]) =>
      ipcRenderer.invoke('quire:relayout-entries', handle, bookPath, entries),
  },

  fs: {
    browse: (dirPath: string) =>
      ipcRenderer.invoke('fs:browse', dirPath),
    readBinary: (filePath: string) =>
      ipcRenderer.invoke('file:read-binary', filePath),
    readText: (filePath: string) =>
      ipcRenderer.invoke('fs:read-text', filePath),
    readAudio: (audioPath: string) =>
      ipcRenderer.invoke('fs:read-audio', audioPath),
    exists: (filePath: string) =>
      ipcRenderer.invoke('fs:exists', filePath),
    batchExists: (filePaths: string[]) =>
      ipcRenderer.invoke('fs:batch-exists', filePaths),
    batchStat: (filePaths: string[]) =>
      ipcRenderer.invoke('fs:batch-stat', filePaths),
    writeText: (filePath: string, content: string) =>
      ipcRenderer.invoke('fs:write-text', filePath, content),
    deleteFile: (filePath: string) =>
      ipcRenderer.invoke('fs:delete-file', filePath),
    deleteDirectory: (dirPath: string) =>
      ipcRenderer.invoke('fs:delete-directory', dirPath),
    writeTempFile: (filename: string, data: Uint8Array) =>
      ipcRenderer.invoke('fs:write-temp-file', filename, data),
    listDirectory: (dirPath: string) =>
      ipcRenderer.invoke('fs:list-directory', dirPath),
    generateUniqueFilename: (originalPath: string, suffix: string) =>
      ipcRenderer.invoke('fs:generate-unique-filename', originalPath, suffix),
  },
  project: {
    saveToPath: (filePath: string, projectData: unknown) =>
      ipcRenderer.invoke('project:save-to-path', filePath, projectData),
    updateMetadata: (projectDir: string, metadata: unknown) =>
      ipcRenderer.invoke('project:update-metadata', projectDir, metadata),
  },
  dialog: {
    openPdf: () =>
      ipcRenderer.invoke('dialog:open-pdf'),
    openVersion: () =>
      ipcRenderer.invoke('dialog:open-version'),
    openFolder: () =>
      ipcRenderer.invoke('dialog:open-folder'),
    openAudio: () =>
      ipcRenderer.invoke('dialog:open-audio'),
    saveEpub: (defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-epub', defaultName),
    saveText: (defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-text', defaultName),
    saveM4b: (defaultName?: string, defaultDir?: string) =>
      ipcRenderer.invoke('dialog:save-m4b', defaultName, defaultDir),
    saveWav: (bytesBase64: string, defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-wav', bytesBase64, defaultName),
    saveFileCopy: (sourcePath: string, defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-file-copy', sourcePath, defaultName),
    // No `confirm` / `message` here: confirms and one-button messages render
    // the in-app dialog component, never a native box. Their handlers went with
    // this bridge (electron/main.ts).
  },
  projects: {
    ensureFolder: () =>
      ipcRenderer.invoke('projects:ensure-folder'),
    getFolder: () =>
      ipcRenderer.invoke('projects:get-folder'),
    findManifestBySource: (fileHash: string | undefined, sourcePath: string | undefined) =>
      ipcRenderer.invoke('projects:find-manifest-by-source', fileHash, sourcePath),
    loadFromPath: (filePath: string) =>
      ipcRenderer.invoke('projects:load-from-path', filePath),
    exportInfo: (projectDir: string, familyId?: string, askedPath?: string) =>
      ipcRenderer.invoke('projects:export-info', projectDir, familyId, askedPath),
  },
  library: {
    seedBookPath: () =>
      ipcRenderer.invoke('app:seed-book-path') as Promise<string | null>,
    removeAllData: () =>
      ipcRenderer.invoke('app:remove-all-data') as Promise<{ ok: boolean; freedBytes: number; userData: string; platform: string }>,
    importFile: (sourcePath: string) =>
      ipcRenderer.invoke('library:import-file', sourcePath),
    resolveSource: (options: { libraryPath?: string; sourcePath?: string; fileHash?: string; sourceName?: string }) =>
      ipcRenderer.invoke('library:resolve-source', options),
    translatePath: (inputPath: string) =>
      ipcRenderer.invoke('library:translate-path', inputPath) as Promise<{ success: boolean; translated: string | null }>,
    setRoot: (libraryPath: string | null) =>
      ipcRenderer.invoke('library:set-root', libraryPath),
    getRoot: () =>
      ipcRenderer.invoke('library:get-root'),
    // Relocate existing professionally-read audiobooks output/ → archive/ (protects
    // irreplaceable uploads from pipeline:delete-output). One-shot, idempotent;
    // resolves to a per-book success/skip/failure report.
    migrateAudiobooksToArchive: (): Promise<{
      success: boolean;
      books: Array<{ projectId: string; title: string; status: 'migrated' | 'skipped' | 'failed'; reason?: string; orphans?: string[] }>;
      migrated: number;
      skipped: number;
      failed: number;
    }> => ipcRenderer.invoke('library:migrate-audiobooks-to-archive'),
    onArchiveMigrationProgress: (callback: (progress: { current: number; total: number; projectId: string; title: string }) => void) => {
      ipcRenderer.on('library:archive-migration-progress', (_event, progress) => callback(progress));
    },
    offArchiveMigrationProgress: () => {
      ipcRenderer.removeAllListeners('library:archive-migration-progress');
    },
  },
  media: {
    saveImage: (base64Data: string, prefix?: string) =>
      ipcRenderer.invoke('media:save-image', base64Data, prefix),
    loadImage: (relativePath: string, maxWidth?: number) =>
      ipcRenderer.invoke('media:load-image', relativePath, maxWidth),
    loadImages: (relativePaths: string[], maxWidth?: number) =>
      ipcRenderer.invoke('media:load-images', relativePaths, maxWidth),
  },
  audiobook: {
    // NOTE: create/list/get/save/delete-project and get-paths are GONE (Aug 3
    // 2026) along with their handlers — the legacy `project.json` folder layout
    // they served, and the `exported.epub` name they wrote, are retired.
    // Unified audiobook export (saves into the project directory)
    exportFromProject: (projectDir: string, epubData: ArrayBuffer, deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>, savePath?: string, familyId?: string) =>
      ipcRenderer.invoke('audiobook:export-from-project', projectDir, epubData, deletedBlockExamples, savePath, familyId),
    // Extract metadata from EPUB without importing
    extractMetadata: (epubSourcePath: string) =>
      ipcRenderer.invoke('audiobook:extract-epub-metadata', epubSourcePath),
    // Import EPUB directly (creates the project directory + output folder)
    importEpub: (epubSourcePath: string, confirmedMetadata?: { title: string; author: string; year?: string; language?: string; subtitle?: string; coverData?: string }) =>
      ipcRenderer.invoke('audiobook:import-epub', epubSourcePath, confirmedMetadata),
    // Import an existing audio file as a complete audiobook project
    importAudiobook: (audioSourcePath: string) =>
      ipcRenderer.invoke('audiobook:import-audiobook', audioSourcePath),
    // Progress (0..1) for a running audio import (the ffmpeg transcode/remux).
    onImportProgress: (callback: (p: { name: string; fraction: number; projectId?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, p: { name: string; fraction: number; projectId?: string }) => callback(p);
      ipcRenderer.on('import:progress', listener);
      return () => { ipcRenderer.removeListener('import:progress', listener); };
    },
    // Edit the audiobook's (m4b) metadata — writes an existing m4b, else held for reassembly
    saveAudiobookMetadata: (projectId: string, meta: { title?: string; author?: string; year?: string; narrator?: string; series?: string; seriesPosition?: number; description?: string }, coverData?: string) =>
      ipcRenderer.invoke('audiobook:save-audiobook-metadata', projectId, meta, coverData),
    // Delete a finished audiobook output (.m4b + paired VTT) and clear it from the
    // manifest. key='mono' → the main audiobook; else a bilingual language-pair key.
    deleteOutput: (projectId: string, key: string) =>
      ipcRenderer.invoke('audiobook:delete-output', projectId, key),
    appendAnalytics: (projectDir: string, jobType: 'tts-conversion' | 'reassembly' | 'video-assembly' | 'rvc' | 'translation', analytics: { jobId: string; [key: string]: unknown }) =>
      ipcRenderer.invoke('audiobook:append-analytics', projectDir, jobType, analytics),
    getAnalytics: (projectDir: string) =>
      ipcRenderer.invoke('audiobook:get-analytics', projectDir),
    copyVtt: (projectDir: string, m4bOutputPath: string) =>
      ipcRenderer.invoke('audiobook:copy-vtt', projectDir, m4bOutputPath),
    extractEmbeddedVtt: (m4bPath: string) =>
      ipcRenderer.invoke('audiobook:extract-embedded-vtt', m4bPath),
    getFolder: (projectDir: string) =>
      ipcRenderer.invoke('audiobook:get-folder', projectDir),
    updatePipeline: (projectId: string, pipelineData: Record<string, unknown>) =>
      ipcRenderer.invoke('audiobook:update-pipeline', projectId, pipelineData),
    linkAudio: (projectDir: string, audioPath: string) =>
      ipcRenderer.invoke('audiobook:link-audio', projectDir, audioPath),
    copyToPath: (source: string, dest: string) =>
      ipcRenderer.invoke('audiobook:copy-to-path', source, dest),
  },
  variant: {
    list: (projectId: string) => ipcRenderer.invoke('variant:list', projectId),
    add: (projectId: string, filePath: string) => ipcRenderer.invoke('variant:add', projectId, filePath),
    saveMetadata: (projectId: string, variantId: string, meta: Record<string, unknown>, coverData?: string) => ipcRenderer.invoke('variant:save-metadata', projectId, variantId, meta, coverData),
    ensureCover: (projectId: string, variantId: string) => ipcRenderer.invoke('variant:ensure-cover', projectId, variantId),
    delete: (projectId: string, variantId: string) => ipcRenderer.invoke('variant:delete', projectId, variantId),
    setPrimary: (projectId: string, variantId: string) => ipcRenderer.invoke('variant:set-primary', projectId, variantId),
    pullMetadata: (projectId: string, fromId: string, toId: string, fields: string[]) => ipcRenderer.invoke('variant:pull-metadata', projectId, fromId, toId, fields),
    sendToPipeline: (projectId: string, variantId: string) => ipcRenderer.invoke('variant:send-to-pipeline', projectId, variantId),
    setProfessional: (projectId, variantId, value) => ipcRenderer.invoke('variant:set-professional', projectId, variantId, value),
    setTts: (projectId: string, variantId: string | null) => ipcRenderer.invoke('variant:set-tts', projectId, variantId),
  },
  epub: {
    parse: (epubPath: string) =>
      ipcRenderer.invoke('epub:parse', epubPath),
    getCover: (epubPath?: string) =>
      ipcRenderer.invoke('epub:get-cover', epubPath),
    setCover: (coverDataUrl: string) =>
      ipcRenderer.invoke('epub:set-cover', coverDataUrl),
    getChapterText: (chapterId: string) =>
      ipcRenderer.invoke('epub:get-chapter-text', chapterId),
    getMetadata: () =>
      ipcRenderer.invoke('epub:get-metadata'),
    setMetadata: (metadata: Partial<{
      title: string;
      subtitle?: string;
      author: string;
      authorFileAs?: string;
      year?: string;
      language: string;
      identifier?: string;
      publisher?: string;
      description?: string;
    }>) =>
      ipcRenderer.invoke('epub:set-metadata', metadata),
    getChapters: () =>
      ipcRenderer.invoke('epub:get-chapters'),
    close: () =>
      ipcRenderer.invoke('epub:close'),
    saveModified: (outputPath: string) =>
      ipcRenderer.invoke('epub:save-modified', outputPath),
    editText: (epubPath: string, chapterId: string, oldText: string, newText: string) =>
      ipcRenderer.invoke('epub:edit-text', epubPath, chapterId, oldText, newText),
    exportWithRemovals: (inputPath: string, removals: Record<string, Array<{ chapterId: string; text: string; cfi: string }>>, outputPath?: string) =>
      ipcRenderer.invoke('epub:export-with-removals', inputPath, removals, outputPath),
    copyFile: (inputPath: string, outputPath: string) =>
      ipcRenderer.invoke('epub:copy-file', inputPath, outputPath),
    exportWithDeletedBlocks: (inputPath: string, deletedBlockIds: string[], outputPath?: string) =>
      ipcRenderer.invoke('epub:export-with-deleted-blocks', inputPath, deletedBlockIds, outputPath),
    exportPreservingMarkup: (
      projectDir: string | null,
      epubSourcePath: string,
      savePathOverride: string | null,
      edits: EpubPreservingEdits,
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>,
      familyId?: string,
    ) =>
      ipcRenderer.invoke(
        'epub:export-preserving-markup',
        projectDir, epubSourcePath, savePathOverride, edits, deletedBlockExamples, familyId,
      ),
    classifyEditorSource: (targetPath: string) =>
      ipcRenderer.invoke('editor:classify-source', targetPath),
    saveAsDialog: (epubData: ArrayBuffer, defaultName?: string) =>
      ipcRenderer.invoke('epub:save-as-dialog', epubData, defaultName),
  },
  ai: {
    checkProviderConnection: (provider: AIProvider, crucibleServer?: string) =>
      ipcRenderer.invoke('ai:check-provider-connection', provider, crucibleServer),
    loadSkippedChunks: (jsonPath: string) =>
      ipcRenderer.invoke('ai:load-skipped-chunks', jsonPath),
    replaceTextInEpub: (epubPath: string, oldText: string, newText: string) =>
      ipcRenderer.invoke('ai:replace-text-in-epub', epubPath, oldText, newText),
    updateSkippedChunk: (jsonPath: string, index: number, newText: string) =>
      ipcRenderer.invoke('ai:update-skipped-chunk', jsonPath, index, newText),
    getPrompt: () =>
      ipcRenderer.invoke('ai:get-prompt'),
    savePrompt: (prompt: string) =>
      ipcRenderer.invoke('ai:save-prompt', prompt),
    localStatus: () =>
      ipcRenderer.invoke('ai:local-status'),
    localSystemInfo: () =>
      ipcRenderer.invoke('ai:local-system-info'),
    localListModels: () =>
      ipcRenderer.invoke('ai:local-list-models'),
    localDownloadModel: (modelId: string) =>
      ipcRenderer.invoke('ai:local-download-model', modelId),
    localCancelDownload: (modelId: string) =>
      ipcRenderer.invoke('ai:local-cancel-download', modelId),
    localDeleteModel: (modelId: string) =>
      ipcRenderer.invoke('ai:local-delete-model', modelId),
    localSetActive: (modelId: string) =>
      ipcRenderer.invoke('ai:local-set-active', modelId),
    onLocalModelProgress: (callback: (p: LocalAiModelProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, p: LocalAiModelProgress) => callback(p);
      ipcRenderer.on('ai:local-model-progress', listener);
      return () => ipcRenderer.removeListener('ai:local-model-progress', listener);
    },
  },
  shell: {
    openExternal: (url: string) =>
      ipcRenderer.invoke('shell:open-external', url),
    showItemInFolder: (filePath: string) =>
      ipcRenderer.invoke('shell:show-item-in-folder', filePath),
    openPath: (filePath: string) =>
      ipcRenderer.invoke('shell:open-path', filePath),
  },
  bookshelf: {
    start: (config: BookshelfConfig) =>
      ipcRenderer.invoke('bookshelf:start', config),
    stop: () =>
      ipcRenderer.invoke('bookshelf:stop'),
    getStatus: () =>
      ipcRenderer.invoke('bookshelf:status'),
  },
  narrator: {
    configurePaths: (config: { condaPath?: string; narratorScratchPath?: string }) =>
      ipcRenderer.invoke('narrator:configure-paths', config),
  },
  orpheus: {
    getBatchConfig: () => ipcRenderer.invoke('orpheus-batch:get'),
    setBatchMax: (value: number | null) => ipcRenderer.invoke('orpheus-batch:set', value),
    getMemoryTier: () => ipcRenderer.invoke('orpheus-memory:get'),
    setMemoryTier: (tier: string) => ipcRenderer.invoke('orpheus-memory:set', tier),
  },
  runtime: {
    getStatus: () =>
      ipcRenderer.invoke('runtime:get-status'),
    onStatus: (callback: (status: { state: 'preparing' | 'ready' | 'error'; message: string; error?: string }) => void) => {
      const handler = (_event: unknown, status: { state: 'preparing' | 'ready' | 'error'; message: string; error?: string }) => callback(status);
      ipcRenderer.on('runtime:status', handler);
      return () => ipcRenderer.removeListener('runtime:status', handler);
    },
    usingBundledEnv: () =>
      ipcRenderer.invoke('runtime:using-bundled-env'),
    isFreshInstall: () =>
      ipcRenderer.invoke('runtime:is-fresh-install'),
    completeSetup: () => ipcRenderer.invoke('bookforge:setup-complete'),
  },
  /*
   * THE VOICE CATALOG, AND NOTHING THAT DOWNLOADS ONE.
   *
   * `list` is what the narration voice picker reads
   * (`narration-voices.service.ts` → `higgsNarrationVoices`), and `listCatalog`
   * is the Settings panel's fuller view of the same shipped file. Both read
   * `electron/data/higgs-models.json`, which is DATA — it reads even when
   * nothing else on this machine works.
   *
   * The doctor, the env installer and the two checkpoint-download doors are
   * GONE with the local weights machinery (docs/LEGACY-REMOVAL.md). Weights are
   * Crucible's: a voice is pulled on the server that will speak it
   * (`crucible voices pull <id>`), not onto this disk.
   *
   * `orpheusModels` went whole with the retired engine. Its renderer caller
   * already treats an absent API as "no custom voices" and keeps its shipped
   * list, so nothing breaks by its going — see `loadOrpheus()` there.
   */
  higgsModels: {
    list: () =>
      ipcRenderer.invoke('higgs:list-models'),
    listCatalog: () =>
      ipcRenderer.invoke('higgs:list-catalog'),
    /*
     * WHICH MACHINES CAN SPEAK WHICH VOICE — the servers' answer, sectioned.
     *
     * Not a richer `list`. `list` reads the shipped catalog file and answers
     * even when nothing else on this machine works; this one goes to every
     * enabled Crucible server and can therefore be slow, partial, or refuse.
     * Two different questions with two different failure modes, so two doors:
     * a caller that needs a name for a saved voice id must not be made to wait
     * on a tailnet to get one.
     */
    picker: () =>
      ipcRenderer.invoke('higgs:voice-picker'),
  },
  rvcVoices: {
    // User-added RVC voice sources ({ url, name }); installs flow through the
    // components API (kind 'rvc-model'), same as the built-in RVC voices.
    sourcesGet: () =>
      ipcRenderer.invoke('rvc:sources-get'),
    sourcesAdd: (url: string, name: string) =>
      ipcRenderer.invoke('rvc:sources-add', url, name),
    sourcesRemove: (id: string) =>
      ipcRenderer.invoke('rvc:sources-remove', id),
  },
  toolPaths: {
    getConfig: () =>
      ipcRenderer.invoke('tool-paths:get-config'),
    updateConfig: (updates: Record<string, string | undefined>) =>
      ipcRenderer.invoke('tool-paths:update-config', updates),
    getStatus: () =>
      ipcRenderer.invoke('tool-paths:get-status'),
  },
  wsl: {
    detect: () =>
      ipcRenderer.invoke('wsl:detect'),
    checkOrpheusSetup: (config: { distro?: string; condaPath?: string; sessionsRoot?: string }) =>
      ipcRenderer.invoke('wsl:check-orpheus-setup', config),
  },
  crucible: {
    servers: () => ipcRenderer.invoke('crucible:servers'),
    // THE CHANNEL NAMES `add-server` AND `test-server` ARE RENAMES, and the
    // METHOD names either side of them deliberately are not. Foundry e6d5424
    // claims `crucible:add` and `crucible:test`; the subtree is sealed, so ours
    // moved (see electron/main.ts). Because the renderer only ever spells the
    // method, the rename stops at this file — `tools/test-ipc-collision.js` is
    // what guards the pair, and it reads BOTH sides' channel strings.
    add: (server: { name: string; url: string; token: string }) =>
      ipcRenderer.invoke('crucible:add-server', server),
    pairStart: (address: string) => ipcRenderer.invoke('bookforge:crucible-pair-start', address),
    pairPoll: (requestId: string) => ipcRenderer.invoke('bookforge:crucible-pair-poll', requestId),
    pairCancel: () => ipcRenderer.invoke('bookforge:crucible-pair-cancel'),
    pairRequests: (server: string) => ipcRenderer.invoke('bookforge:crucible-pair-requests', server),
    pairDecide: (server: string, id: string, userCode: string, allow: boolean) => ipcRenderer.invoke('bookforge:crucible-pair-decide', server, id, userCode, allow),
    upgradeWsl: (server: string) => ipcRenderer.invoke('bookforge:crucible-upgrade-wsl', server),
    onUpgradeProgress: (callback: (progress: import('../shared/crucible/engine-controls-wire').CrucibleEngineUpgradeProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: import('../shared/crucible/engine-controls-wire').CrucibleEngineUpgradeProgress) => callback(progress);
      ipcRenderer.on('bookforge:crucible-upgrade-progress', listener);
      return () => ipcRenderer.removeListener('bookforge:crucible-upgrade-progress', listener);
    },
    addDiscovered: (name: string) => ipcRenderer.invoke('crucible:add-discovered', name),
    remove: (name: string) => ipcRenderer.invoke('crucible:remove', name),
    testAddress: (url: string, token: string) =>
      ipcRenderer.invoke('crucible:test-address', url, token),
    test: (name: string) => ipcRenderer.invoke('crucible:test-server', name),
    activity: (name: string) => ipcRenderer.invoke('crucible:activity', name),
    models: (name: string) => ipcRenderer.invoke('crucible:models', name),
    setOrder: (order: string[]) => ipcRenderer.invoke('crucible:set-order', order),
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('crucible:set-enabled', name, enabled),
    copyConnectCode: (name: string) =>
      ipcRenderer.invoke('crucible:copy-connect-code', name),
    setWaitFor: (value: CrucibleWaitForDefault) =>
      ipcRenderer.invoke('crucible:set-wait-for', value),
    forget: (name: string) => ipcRenderer.invoke('crucible:forget', name),
    // The two operator verbs. They reach a card; nothing calls them but a button.
    loadModel: (name: string, model: string) =>
      ipcRenderer.invoke('crucible:load-model', name, model),
    unloadModel: (name: string, model: string) =>
      ipcRenderer.invoke('crucible:unload-model', name, model),
    // The install story's third door. The channel names are `crucible:host-*`
    // and NOT `crucible:install-plan` / `crucible:install`, which the vendored
    // Foundry (e6d5424) registers for its own copy of this screen — a duplicate
    // `ipcMain.handle` name throws at registration and the app would not boot.
    hostFacts: () => ipcRenderer.invoke('crucible:host-facts'),
    installPlan: () => ipcRenderer.invoke('crucible:host-install-plan'),
    install: () => ipcRenderer.invoke('crucible:host-install'),
    // Every step, line, byte count and WSL state of a RUNNING install. The
    // install itself downloads gigabytes and, on Windows, crosses a UAC prompt
    // and possibly a reboot — an `await` with nothing in between would be a
    // spinner for twenty minutes.
    onInstallProgress: (callback: (progress: CrucibleInstallProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: CrucibleInstallProgress) =>
        callback(progress);
      ipcRenderer.on('crucible:install-progress', listener);
      return () => { ipcRenderer.removeListener('crucible:install-progress', listener); };
    },
    // Taking it off again. The dry run touches nothing; the real one deletes a
    // service, a home directory and — only with `purgeWeights` — the weights.
    // Both refuse `uninstall_not_local` for anything but this machine's engine.
    uninstallPlan: (name: string, options: { purgeWeights: boolean; wslToo: boolean }) =>
      ipcRenderer.invoke('crucible:host-uninstall-plan', name, options),
    uninstall: (name: string, options: { purgeWeights: boolean; wslToo: boolean }) =>
      ipcRenderer.invoke('crucible:host-uninstall', name, options),
    onUninstallProgress: (callback: (line: { stream: 'stdout' | 'stderr'; text: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, line: { stream: 'stdout' | 'stderr'; text: string }) =>
        callback(line);
      ipcRenderer.on('crucible:uninstall-progress', listener);
      return () => { ipcRenderer.removeListener('crucible:uninstall-progress', listener); };
    },
    capability: (name: string) => ipcRenderer.invoke('crucible:capability', name),
    // The engine's own settings. The channel names are `crucible:engine-*` and
    // NOT `crucible:settings`, which the vendored Foundry (e6d5424) registers
    // for its Servers card — a duplicate `ipcMain.handle` name throws at
    // registration and the app would not boot with that window mounted.
    catalog: (name: string) => ipcRenderer.invoke('bookforge:crucible-catalog', name),
    pull: (name: string, kind: CrucibleSubjectKind, id: string) =>
      ipcRenderer.invoke('bookforge:crucible-pull', name, kind, id),
    onPullProgress: (callback: (progress: CruciblePullProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: CruciblePullProgress) =>
        callback(progress);
      ipcRenderer.on('bookforge:crucible-pull-progress', listener);
      return () => { ipcRenderer.removeListener('bookforge:crucible-pull-progress', listener); };
    },
    removalPrompt: (name: string, kind: CrucibleSubjectKind, id: string) =>
      ipcRenderer.invoke('bookforge:crucible-removal-prompt', name, kind, id),
    removeSubject: (name: string, kind: CrucibleSubjectKind, id: string) =>
      ipcRenderer.invoke('bookforge:crucible-remove-subject', name, kind, id),
    engineSettings: (name: string) => ipcRenderer.invoke('bookforge:crucible-engine-settings', name),
    writeEngineSettings: (name: string, patch: CrucibleEngineSettingsPatch) =>
      ipcRenderer.invoke('bookforge:crucible-engine-settings-write', name, patch),
    testUpstream: (name: string, upstream: CrucibleUpstreamName, probe: CrucibleUpstreamProbe) =>
      ipcRenderer.invoke('crucible:upstream-test', name, upstream, probe),
    // The operator door. `coordination`, `coordinate`, `cancel-setup`,
    // `module` and `parse-pairing` are names the hosted Foundry's `crucible:`
    // family does not have (foundry-app/IPC-CHANNELS.md), which
    // tools/test-ipc-collision.js keeps true.
    //
    // `open-ui` LEFT WITH ITS BUTTONS (2026-09-17). Owen: *"no more opening a
    // crucible page in bookforge settings."* Nothing in the renderer called it
    // once the two buttons went, and a door with no caller is a door that
    // rots. The engine still serves its own page at its own address.
    parsePairing: (line: string) => ipcRenderer.invoke('crucible:parse-pairing', line),
    module: () => ipcRenderer.invoke('crucible:module'),
    coordination: () => ipcRenderer.invoke('bookforge:crucible-coordination'),
    coordinate: (name: string) => ipcRenderer.invoke('bookforge:crucible-coordinate', name),
    cancelSetUp: (name: string, taskId: string) =>
      ipcRenderer.invoke('crucible:cancel-setup', name, taskId),
    onCoordination: (callback: (state: CrucibleCoordinationState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: CrucibleCoordinationState) =>
        callback(state);
      ipcRenderer.on('bookforge:crucible-coordination-state', listener);
      return () => { ipcRenderer.removeListener('bookforge:crucible-coordination-state', listener); };
    },
  },
  foundry: {
    version: () => ipcRenderer.invoke('foundry:version'),
  },
  foundryHost: {
    project: (projectDir: string) => ipcRenderer.invoke('foundry-host:project', projectDir),
    open: (projectDir: string, documentPath?: string) =>
      ipcRenderer.invoke('foundry-host:open', projectDir, documentPath),
    // The Adopt door: Foundry projects this library has never seen — standalone
    // Foundry's own library, and orphans in our hosted root that no book maps.
    adoptables: () => ipcRenderer.invoke('foundry-host:adoptables'),
    adopt: (sourceDir: string) => ipcRenderer.invoke('foundry-host:adopt', sourceDir),
    reload: (bookDir: string) => ipcRenderer.invoke('foundry-host:reload', bookDir),
    browseForProject: () => ipcRenderer.invoke('foundry-host:browse-for-project'),
    // A Foundry landing changed this book's VERSIONS. Named for what it means
    // since 2026-08-17: an export is copied in and minted as a variant, so what
    // the listener must re-read is the version list, not an export list.
    onVersionsChanged: (callback: (event: { projectDir: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: { projectDir: string }) =>
        callback(event);
      ipcRenderer.on('foundry-host:versions-changed', listener);
      return () => { ipcRenderer.removeListener('foundry-host:versions-changed', listener); };
    },
    onProjectChanged: (callback: (event: { projectDir: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: { projectDir: string }) =>
        callback(event);
      ipcRenderer.on('foundry-host:project-changed', listener);
      return () => { ipcRenderer.removeListener('foundry-host:project-changed', listener); };
    },
    onUnmatchedExport: (callback: (event: { key: string; title: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: { key: string; title: string }) =>
        callback(event);
      ipcRenderer.on('foundry-host:unmatched-export', listener);
      return () => { ipcRenderer.removeListener('foundry-host:unmatched-export', listener); };
    },
    // The status chip in Foundry's chrome was pressed. Main has already raised
    // this window; all that is left is the route.
    onOpenQueue: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('foundry-host:open-queue', listener);
      return () => { ipcRenderer.removeListener('foundry-host:open-queue', listener); };
    },
    /**
     * Narrate was pressed in Foundry's window and this window has been raised to
     * ask about it. The book is fully resolved on main's side before it is sent
     * — which exported EPUB the press meant, and its version record — so the
     * dialog opens on a target rather than on a lookup.
     */
    onNarrate: (callback: (target: FoundryNarrateTarget) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, target: FoundryNarrateTarget) =>
        callback(target);
      ipcRenderer.on('foundry-host:narrate', listener);
      return () => { ipcRenderer.removeListener('foundry-host:narrate', listener); };
    },
  },
  document: {
    cancelStage: (projectDir: string) => ipcRenderer.invoke('document:cancel-stage', projectDir),
    /** Stages running right now and where they have got to — what a reloaded window asks for. */
    activeStages: () => ipcRenderer.invoke('document:active-stages'),
    onStageProgress: (callback: (event: DocumentStageProgressEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: DocumentStageProgressEvent) =>
        callback(event);
      ipcRenderer.on('document:stage-progress', listener);
      return () => { ipcRenderer.removeListener('document:stage-progress', listener); };
    },
    onStageStarted: (callback: (event: { projectDir: string; stage: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: { projectDir: string; stage: string }) =>
        callback(event);
      ipcRenderer.on('document:stage-started', listener);
      return () => { ipcRenderer.removeListener('document:stage-started', listener); };
    },
    onStageFinished: (callback: (event: { projectDir: string; stage: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: { projectDir: string; stage: string }) =>
        callback(event);
      ipcRenderer.on('document:stage-finished', listener);
      return () => { ipcRenderer.removeListener('document:stage-finished', listener); };
    },
  },
  window: {
    hide: () =>
      ipcRenderer.invoke('window:hide'),
    close: () =>
      ipcRenderer.invoke('window:close-main'),
    showBookConversion: (projectDir: string) =>
      ipcRenderer.invoke('app:show-book-conversion', projectDir),
    anyFocused: () => ipcRenderer.invoke('window:any-focused'),
    onShowBookConversion: (callback: (projectDir: string) => void) => {
      const listener = (_e: any, projectDir: string) => callback(projectDir);
      ipcRenderer.on('app:show-book-conversion', listener);
      return () => { ipcRenderer.removeListener('app:show-book-conversion', listener); };
    },
  },
  plugins: {
    list: () =>
      ipcRenderer.invoke('plugins:list'),
    getSettings: (pluginId: string) =>
      ipcRenderer.invoke('plugins:get-settings', pluginId),
    updateSettings: (pluginId: string, settings: Record<string, unknown>) =>
      ipcRenderer.invoke('plugins:update-settings', pluginId, settings),
    checkAvailability: (pluginId: string) =>
      ipcRenderer.invoke('plugins:check-availability', pluginId),
    invoke: (pluginId: string, channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(`plugin:${pluginId}:${channel}`, ...args),
    onProgress: (callback: (progress: PluginProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: PluginProgress) => {
        callback(progress);
      };
      ipcRenderer.on('plugin:progress', listener);
      // Return unsubscribe function
      return () => {
        ipcRenderer.removeListener('plugin:progress', listener);
      };
    },
  },
  queue: {
    list: () => ipcRenderer.invoke('jobs:list'),
    enqueue: (spec: QueueJobSpec) => ipcRenderer.invoke('jobs:enqueue', spec),
    appendStep: (jobId: string, spec: QueueAppendStepSpec) =>
      ipcRenderer.invoke('jobs:append-step', jobId, spec),
    release: (target?: QueueTarget) => ipcRenderer.invoke('jobs:release', target),
    start: (target?: QueueTarget) => ipcRenderer.invoke('jobs:start', target),
    pause: () => ipcRenderer.invoke('jobs:pause'),
    cancel: (target: QueueTarget, reason?: string, opts?: { resumable?: boolean }) =>
      ipcRenderer.invoke('jobs:cancel', target, reason, opts),
    retry: (target: QueueTarget) => ipcRenderer.invoke('jobs:retry', target),
    remove: (jobId: string) => ipcRenderer.invoke('jobs:remove', jobId),
    reorder: (jobId: string, beforeJobId: string | null) =>
      ipcRenderer.invoke('jobs:reorder', jobId, beforeJobId),
    clearFinished: () => ipcRenderer.invoke('jobs:clear-finished'),
    updateStepConfig: (stepId: string, patch: Record<string, unknown>) =>
      ipcRenderer.invoke('jobs:update-step-config', stepId, patch),
    setWaitFor: (jobId: string, value: string) =>
      ipcRenderer.invoke('jobs:set-wait-for', jobId, value),
    waitForCounts: () => ipcRenderer.invoke('jobs:wait-for-counts'),
    bulkWaitFor: (from: string | null, to: string) =>
      ipcRenderer.invoke('jobs:bulk-wait-for', from, to),
    setGpuDial: (value: string) => ipcRenderer.invoke('jobs:set-gpu-dial', value),
    sendToQueue: (jobId: string) => ipcRenderer.invoke('jobs:send-to-queue', jobId),
    returnToPending: (jobId: string) => ipcRenderer.invoke('jobs:return-to-pending', jobId),
    returnToPendingWarning: (jobId: string) =>
      ipcRenderer.invoke('jobs:return-to-pending-warning', jobId),
    onChanged: (callback: (snapshot: QueueSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: QueueSnapshot) => callback(snapshot);
      ipcRenderer.on('jobs:changed', listener);
      return () => { ipcRenderer.removeListener('jobs:changed', listener); };
    },
    onStepFinished: (callback: (event: QueueStepFinished) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: QueueStepFinished) => callback(event);
      ipcRenderer.on('jobs:step-finished', listener);
      return () => { ipcRenderer.removeListener('jobs:step-finished', listener); };
    },
    onNotice: (callback: (notice: QueueNotice) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, notice: QueueNotice) => callback(notice);
      ipcRenderer.on('jobs:notice', listener);
      return () => { ipcRenderer.removeListener('jobs:notice', listener); };
    },
  },
  ebookConvert: {
    isAvailable: () =>
      ipcRenderer.invoke('ebook-convert:is-available'),
    getSupportedExtensions: () =>
      ipcRenderer.invoke('ebook-convert:get-supported-extensions'),
    isConvertible: (filePath: string) =>
      ipcRenderer.invoke('ebook-convert:is-convertible', filePath),
    convert: (inputPath: string, outputDir?: string) =>
      ipcRenderer.invoke('ebook-convert:convert', inputPath, outputDir),
    convertToLibrary: (inputPath: string) =>
      ipcRenderer.invoke('ebook-convert:convert-to-library', inputPath),
  },
  jwpub: {
    convert: (jwpubPath: string) =>
      ipcRenderer.invoke('jwpub:convert', jwpubPath),
  },
  diff: {
    // Legacy: loads all chapters at once (can cause OOM on large EPUBs)
    loadComparison: (originalPath: string, cleanedPath: string) =>
      ipcRenderer.invoke('diff:load-comparison', originalPath, cleanedPath),
    // Memory-efficient: get only chapter metadata (no text)
    getMetadata: (originalPath: string, cleanedPath: string) =>
      ipcRenderer.invoke('diff:get-metadata', originalPath, cleanedPath),
    // Memory-efficient: load a single chapter's text on demand
    getChapter: (originalPath: string, cleanedPath: string, chapterId: string) =>
      ipcRenderer.invoke('diff:get-chapter', originalPath, cleanedPath, chapterId),
    // Compute change counts for chapters not covered by a cleanup job's cache
    getChangeCounts: (originalPath: string, cleanedPath: string, chapterIds?: string[]) =>
      ipcRenderer.invoke('diff:get-change-counts', originalPath, cleanedPath, chapterIds),
    onLoadProgress: (callback: (progress: DiffLoadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DiffLoadProgress) => callback(progress);
      ipcRenderer.on('diff:load-progress', handler);
      return () => ipcRenderer.removeListener('diff:load-progress', handler);
    },
    // Cache operations
    saveCache: (originalPath: string, cleanedPath: string, chapterId: string, cacheData: unknown) =>
      ipcRenderer.invoke('diff:save-cache', originalPath, cleanedPath, chapterId, cacheData),
    loadCache: (originalPath: string, cleanedPath: string, chapterId: string) =>
      ipcRenderer.invoke('diff:load-cache', originalPath, cleanedPath, chapterId),
    clearCache: (originalPath: string, cleanedPath: string) =>
      ipcRenderer.invoke('diff:clear-cache', originalPath, cleanedPath),
    getCacheKey: (originalPath: string, cleanedPath: string) =>
      ipcRenderer.invoke('diff:get-cache-key', originalPath, cleanedPath),
    // Pre-computed diff cache (created during AI cleanup)
    loadCachedFile: (cleanedPath: string) =>
      ipcRenderer.invoke('diff:load-cached-file', cleanedPath),
    hydrateChapter: (originalPath: string, cleanedPath: string, chapterId: string, changes: Array<{ pos: number; len: number; add?: string; rem?: string }>) =>
      ipcRenderer.invoke('diff:hydrate-chapter', originalPath, cleanedPath, chapterId, changes),
    loadPassFile: (diffPath: string) =>
      ipcRenderer.invoke('diff:load-pass-file', diffPath),
    // Pre-compute diff cache for an arbitrary EPUB pair (background)
    precomputePair: (originalPath: string, targetPath: string) =>
      ipcRenderer.invoke('diff:precompute-pair', originalPath, targetPath),
  },
  narration: {
    textReadiness: (projectDir: string, askedPath?: string, familyId?: string) =>
      ipcRenderer.invoke('narration:text-readiness', projectDir, askedPath, familyId),
  },
  processing: {
    planChain: (request: ProcessingChainRequest) =>
      ipcRenderer.invoke('processing:plan-chain', request),
    submitChain: (request: ProcessingChainRequest, followOn?: QueueStepSpec[]) =>
      ipcRenderer.invoke('processing:submit-chain', request, followOn ?? []),
    runPass: (jobId: string, config: PassJobConfig) =>
      ipcRenderer.invoke('queue:run-pass', jobId, config),
    listPassDiffs: (projectDir: string, familyId?: string) =>
      ipcRenderer.invoke('processing:list-pass-diffs', projectDir, familyId),
    resetBook: (request: { projectDir: string; preview?: boolean }) =>
      ipcRenderer.invoke('processing:reset-book', request),
  },
  /**
   * The other route to a book, and the narration copy cut from it.
   *
   * `convert` is long (ninety minutes for a 300-page book) and reports on
   * `document:stage-progress` like every other document stage — there is no
   * progress channel of its own, because a window watching a project's documents
   * must not have to listen on two.
   */
  vlm: {
    convert: (request: VlmConvertRequest) =>
      ipcRenderer.invoke('vlm:convert', request),
    checkEndpoint: (config: VlmEndpointConfig) =>
      ipcRenderer.invoke('vlm:check-endpoint', config),
    /** What is banked for this PDF, and whether the run that banked it finished. */
    readingsBank: (request: VlmConvertRequest) =>
      ipcRenderer.invoke('vlm:readings-bank', request),
    readerStatus: () => ipcRenderer.invoke('vlm:reader-status'),
  },
  play: {
    startSession: () =>
      ipcRenderer.invoke('play:start-session'),
    loadVoice: (voice: string) =>
      ipcRenderer.invoke('play:load-voice', voice),
    endSession: () =>
      ipcRenderer.invoke('play:end-session'),
    isSessionActive: () =>
      ipcRenderer.invoke('play:is-session-active'),
    getVoices: () =>
      ipcRenderer.invoke('play:get-voices'),
    onStatus: (callback: (status: { message: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: { message: string }) => {
        callback(status);
      };
      ipcRenderer.on('play:status', listener);
      return () => {
        ipcRenderer.removeListener('play:status', listener);
      };
    },
    onSessionEnded: (callback: (data: { code: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { code: number }) => {
        callback(data);
      };
      ipcRenderer.on('play:session-ended', listener);
      return () => {
        ipcRenderer.removeListener('play:session-ended', listener);
      };
    },
    onSessionStarted: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('play:session-started', listener);
      return () => {
        ipcRenderer.removeListener('play:session-started', listener);
      };
    },
    openListenWindow: (projectPath: string, audioPath?: string) =>
      ipcRenderer.invoke('listen:open-window', projectPath, audioPath),
    onSelectAudio: (callback: (audioPath: string) => void) => {
      const listener = (_e: unknown, audioPath: string) => callback(audioPath);
      ipcRenderer.on('listen:select-audio', listener);
      return () => { ipcRenderer.removeListener('listen:select-audio', listener); };
    },
    listListenSources: (projectPath: string) =>
      ipcRenderer.invoke('listen:list-sources', projectPath),
    // Stream scheduler (main-process generation orchestration)
    streamStart: (sentences: string[], startIndex: number, settings: PlaySettings, requestId: number) =>
      ipcRenderer.invoke('stream:start', sentences, startIndex, settings, requestId),
    streamStop: () =>
      ipcRenderer.invoke('stream:stop'),
    streamPlayhead: (requestId: number, sentenceIndex: number) =>
      ipcRenderer.invoke('stream:playhead', requestId, sentenceIndex),
    onStreamEvent: (callback: (event: Record<string, unknown>) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => callback(data);
      ipcRenderer.on('stream:event', listener);
      return () => {
        ipcRenderer.removeListener('stream:event', listener);
      };
    },
  },
  ttsService: {
    start: (voice?: string) =>
      ipcRenderer.invoke('tts-service:start', voice),
    stop: () =>
      ipcRenderer.invoke('tts-service:stop'),
    status: () =>
      ipcRenderer.invoke('tts-service:status'),
    onState: (callback: (state: { state: 'stopped' | 'starting' | 'warming' | 'running'; serviceMode: boolean }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { state: 'stopped' | 'starting' | 'warming' | 'running'; serviceMode: boolean }) => callback(data);
      ipcRenderer.on('tts-service:state', listener);
      return () => {
        ipcRenderer.removeListener('tts-service:state', listener);
      };
    },
    onWarmup: (callback: (data: { pct: number; message?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { pct: number; message?: string }) => callback(data);
      ipcRenderer.on('tts-service:warmup', listener);
      return () => {
        ipcRenderer.removeListener('tts-service:warmup', listener);
      };
    },
    onConfig: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('tts-service:config', listener);
      return () => {
        ipcRenderer.removeListener('tts-service:config', listener);
      };
    },
  },
  tabRecord: {
    status: () =>
      ipcRenderer.invoke('tab-record:status'),
    configure: (updates: { port?: number; host?: string }) =>
      ipcRenderer.invoke('tab-record:configure', updates),
  },
  ttsStream: {
    getWorkerConfig: () =>
      ipcRenderer.invoke('tts-stream:get-worker-config'),
    setWorkerConfig: (updates: { engine?: 'orpheus'; enabled?: boolean; count?: number; devicePref?: 'auto' | 'cpu' | 'gpu' | 'mps' }) =>
      ipcRenderer.invoke('tts-stream:set-worker-config', updates),
  },
  enginePresence: {
    onNotice: (callback: (n: any) => void) => {
      const handler = (_e: unknown, n: any) => callback(n);
      ipcRenderer.on('crucible:engine-presence', handler);
      return () => ipcRenderer.removeListener('crucible:engine-presence', handler);
    },
    start: () => ipcRenderer.invoke('crucible:start-local-engine'),
  },
  doctor: {
    check: () => ipcRenderer.invoke('doctor:check'),
    fix: (id: string) => ipcRenderer.invoke('doctor:fix', id),
    onProgress: (callback: (p: { id: string; message: string }) => void) => {
      const handler = (_e: unknown, p: { id: string; message: string }) => callback(p);
      ipcRenderer.on('doctor:progress', handler);
      return () => ipcRenderer.removeListener('doctor:progress', handler);
    },
  },
  components: {
    list: () =>
      ipcRenderer.invoke('components:list'),
    get: (id: string) =>
      ipcRenderer.invoke('components:get', id),
    probe: (force?: boolean) =>
      ipcRenderer.invoke('components:probe', force),
    detectExternal: (id: string) =>
      ipcRenderer.invoke('components:detect', id),
    setExternalPath: (id: string, path: string) =>
      ipcRenderer.invoke('components:set-path', id, path),
    install: (id: string) =>
      ipcRenderer.invoke('components:install', id),
    runInstaller: (id: string) =>
      ipcRenderer.invoke('components:run-installer', id),
    installers: () =>
      ipcRenderer.invoke('components:installers') as Promise<{ ids: string[]; notes: Record<string, string | null> }>,
    cancel: (id: string) =>
      ipcRenderer.invoke('components:cancel', id),
    uninstall: (id: string) =>
      ipcRenderer.invoke('components:uninstall', id),
    testEnv: (id: string) =>
      ipcRenderer.invoke('components:test-env', id),
    onProgress: (callback: (p: InstallProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, p: InstallProgress) => callback(p);
      ipcRenderer.on('components:progress', listener);
      return () => {
        ipcRenderer.removeListener('components:progress', listener);
      };
    },
    // The startup upgrade sweep. Both halves are exposed because there is no
    // ordering guarantee between the sweep finishing and the renderer
    // subscribing: subscribe for the push, then pull once in case it already
    // went out.
    upgrades: () =>
      ipcRenderer.invoke('components:upgrades') as Promise<StartupUpgradeReport | null>,
    onUpgradesAvailable: (callback: (report: StartupUpgradeReport) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, report: StartupUpgradeReport) => callback(report);
      ipcRenderer.on('components:upgrades-available', listener);
      return () => {
        ipcRenderer.removeListener('components:upgrades-available', listener);
      };
    },
  },
  whisper: {
    listModels: () =>
      ipcRenderer.invoke('whisper:list-models'),
    downloadModel: (id: string) =>
      ipcRenderer.invoke('whisper:download-model', id),
    deleteModel: (id: string) =>
      ipcRenderer.invoke('whisper:delete-model', id),
    onDownloadProgress: (callback: (p: WhisperDownloadProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, p: WhisperDownloadProgress) => callback(p);
      ipcRenderer.on('whisper:download-progress', listener);
      return () => {
        ipcRenderer.removeListener('whisper:download-progress', listener);
      };
    },
  },
  update: {
    listComponents: (force?: boolean) => ipcRenderer.invoke('update:list-components', force),
    installComponent: (id: string) => ipcRenderer.invoke('update:install-component', id),
    onComponentStatus: (callback: (s: ComponentUpdateStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, s: ComponentUpdateStatus) => callback(s);
      ipcRenderer.on('update:component-status', listener);
      return () => {
        ipcRenderer.removeListener('update:component-status', listener);
      };
    },
    onComponentsAvailable: (callback: (list: ComponentUpdateStatus[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, list: ComponentUpdateStatus[]) => callback(list);
      ipcRenderer.on('update:components-available', listener);
      return () => {
        ipcRenderer.removeListener('update:components-available', listener);
      };
    },
    getStarterStatus: () => ipcRenderer.invoke('starter-library:status'),
    installStarter: () => ipcRenderer.invoke('starter-library:install'),
    onStarterProgress: (callback: (s: StarterStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, s: StarterStatus) => callback(s);
      ipcRenderer.on('starter-library:progress', listener);
      return () => {
        ipcRenderer.removeListener('starter-library:progress', listener);
      };
    },
  },
  parallelTts: {
    detectRecommendedWorkerCount: () =>
      ipcRenderer.invoke('parallel-tts:detect-worker-count'),
    startConversion: (jobId: string, config: ParallelConversionConfig) =>
      ipcRenderer.invoke('parallel-tts:start-conversion', jobId, config),
    stopConversion: (jobId: string) =>
      ipcRenderer.invoke('parallel-tts:stop-conversion', jobId),
    getProgress: (jobId: string) =>
      ipcRenderer.invoke('parallel-tts:get-progress', jobId),
    isActive: (jobId: string) =>
      ipcRenderer.invoke('parallel-tts:is-active', jobId),
    listActive: () =>
      ipcRenderer.invoke('parallel-tts:list-active'),
    onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: ParallelAggregatedProgress }) => {
        callback(data);
      };
      ipcRenderer.on('parallel-tts:progress', listener);
      return () => {
        ipcRenderer.removeListener('parallel-tts:progress', listener);
      };
    },
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string }; sessionId?: string; sessionDir?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string }; sessionId?: string; sessionDir?: string }) => {
        callback(data);
      };
      ipcRenderer.on('parallel-tts:complete', listener);
      return () => {
        ipcRenderer.removeListener('parallel-tts:complete', listener);
      };
    },
    // Session tracking for stop/resume
    onSessionCreated: (callback: (data: { jobId: string; sessionId: string; sessionDir: string; processDir: string; totalSentences: number; totalChapters: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; sessionId: string; sessionDir: string; processDir: string; totalSentences: number; totalChapters: number }) => {
        callback(data);
      };
      ipcRenderer.on('parallel-tts:session-created', listener);
      return () => {
        ipcRenderer.removeListener('parallel-tts:session-created', listener);
      };
    },
    // Resume support
    cachedRender: (projectDir: string, language?: string) =>
      ipcRenderer.invoke('parallel-tts:cached-render', projectDir, language),
    checkResumeFast: (epubPath: string) =>
      ipcRenderer.invoke('parallel-tts:check-resume-fast', epubPath),
    checkResumeFromDir: (processDir: string) =>
      ipcRenderer.invoke('parallel-tts:check-resume-from-dir', processDir),
    checkResume: (sessionPath: string) =>
      ipcRenderer.invoke('parallel-tts:check-resume', sessionPath),
    resumeConversion: (jobId: string, config: ParallelConversionConfig, resumeInfo: ResumeCheckResult) =>
      ipcRenderer.invoke('parallel-tts:resume-conversion', jobId, config, resumeInfo),
    buildResumeInfo: (prepInfo: any, settings: any) =>
      ipcRenderer.invoke('parallel-tts:build-resume-info', prepInfo, settings),
  },
  sessionCache: {
    // Cache full TTS session into the project for permanent storage
    saveToBfp: (sessionDir: string, projectDir: string) =>
      ipcRenderer.invoke('session-cache:save-to-bfp', sessionDir, projectDir) as Promise<{
        success: boolean;
        cachedPath?: string;
        error?: string;
      }>,
    // Cache TTS session to LL project directory, keyed by language
    saveToProject: (sessionDir: string, projectDir: string, language: string) =>
      ipcRenderer.invoke('session-cache:save-to-project', sessionDir, projectDir, language) as Promise<{
        success: boolean;
        cachedSentencesDir?: string;
        error?: string;
      }>,
    // Scan LL project for cached TTS sessions
    scanProject: (projectDir: string) =>
      ipcRenderer.invoke('session-cache:scan-project', projectDir) as Promise<{
        success: boolean;
        sessions: Array<{ language: string; sessionDir: string; sentencesDir: string; sentenceCount: number; createdAt: string }>;
        error?: string;
      }>,
  },
  videoAssembly: {
    run: (jobId: string, config: {
      projectId: string;
      bfpPath: string;
      mode: 'bilingual' | 'monolingual';
      // No m4bPath/vttPath: main resolves both from bfpPath/output at run time, when
      // the assembly step has actually produced them (see resolveOutputPaths in
      // electron/video-assembly-bridge.ts).
      sentencePairsPath?: string;
      title: string;
      sourceLang: string;
      targetLang?: string;
      resolution: '480p' | '720p' | '1080p';
      outputFilename?: string;
    }) =>
      ipcRenderer.invoke('video-assembly:run', jobId, config),
    cancel: (jobId: string) =>
      ipcRenderer.invoke('video-assembly:cancel', jobId),
    onProgress: (callback: (data: { jobId: string; phase: string; percentage: number; message: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; phase: string; percentage: number; message: string }) => {
        callback(data);
      };
      ipcRenderer.on('video-assembly:progress', listener);
      return () => {
        ipcRenderer.removeListener('video-assembly:progress', listener);
      };
    },
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; success: boolean; outputPath?: string; error?: string }) => {
        callback(data);
      };
      ipcRenderer.on('video-assembly:complete', listener);
      return () => {
        ipcRenderer.removeListener('video-assembly:complete', listener);
      };
    },
  },
  generateSentences: {
    run: (jobId: string, config: {
      projectId: string;
      variantId: string;
      m4bPath: string;
      modelId: string;
      language?: string;
    }) =>
      ipcRenderer.invoke('generate-sentences:run', jobId, config),
    cancel: (jobId: string) =>
      ipcRenderer.invoke('generate-sentences:cancel', jobId),
    onProgress: (callback: (data: { jobId: string; percentage: number; message: string; stages?: Array<{ name: string; label: string; pct: number; status: 'pending' | 'running' | 'complete' }> }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; percentage: number; message: string; stages?: Array<{ name: string; label: string; pct: number; status: 'pending' | 'running' | 'complete' }> }) => {
        callback(data);
      };
      ipcRenderer.on('generate-sentences:progress', listener);
      return () => {
        ipcRenderer.removeListener('generate-sentences:progress', listener);
      };
    },
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; warning?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; success: boolean; outputPath?: string; error?: string; warning?: string }) => {
        callback(data);
      };
      ipcRenderer.on('generate-sentences:complete', listener);
      return () => {
        ipcRenderer.removeListener('generate-sentences:complete', listener);
      };
    },
  },
  reassembly: {
    scanSessions: async (customTmpPath?: string) => {
      console.log('[PRELOAD] reassembly:scanSessions calling IPC with path:', customTmpPath);
      const result = await ipcRenderer.invoke('reassembly:scan-sessions', customTmpPath);
      console.log('[PRELOAD] reassembly:scanSessions result:', result?.success, 'sessions:', result?.data?.sessions?.length);
      return result;
    },
    getSession: (sessionId: string, customTmpPath?: string) =>
      ipcRenderer.invoke('reassembly:get-session', sessionId, customTmpPath),
    resolveSentenceGap: (processDir: string) =>
      ipcRenderer.invoke('reassembly:resolve-sentence-gap', processDir),
    startReassembly: (jobId: string, config: ReassemblyConfig) =>
      ipcRenderer.invoke('reassembly:start', jobId, config),
    stopReassembly: (jobId: string) =>
      ipcRenderer.invoke('reassembly:stop', jobId),
    deleteSession: (sessionId: string, customTmpPath?: string) =>
      ipcRenderer.invoke('reassembly:delete-session', sessionId, customTmpPath),
    saveMetadata: (
      sessionId: string,
      processDir: string,
      metadata: {
        title?: string;
        author?: string;
        year?: string;
        narrator?: string;
        series?: string;
        seriesNumber?: string;
        genre?: string;
        description?: string;
      },
      coverData?: {
        type: 'base64' | 'path';
        data: string;
        mimeType?: string;
      }
    ) => ipcRenderer.invoke('reassembly:save-metadata', sessionId, processDir, metadata, coverData),
    isAvailable: () =>
      ipcRenderer.invoke('reassembly:is-available'),
    getBfpSession: (projectDir: string) =>
      ipcRenderer.invoke('reassembly:get-bfp-session', projectDir),
    onProgress: (callback: (data: { jobId: string; progress: ReassemblyProgress }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: ReassemblyProgress }) => {
        callback(data);
      };
      ipcRenderer.on('reassembly:progress', listener);
      return () => {
        ipcRenderer.removeListener('reassembly:progress', listener);
      };
    },
  },
  correctSentences: {
    getSession: (projectDir: string) =>
      ipcRenderer.invoke('correct-sentences:get-session', projectDir),
    generateCandidates: (jobId: string, params: { projectDir: string; indices: number[]; takes?: number; overrides?: Record<number, string> }) =>
      ipcRenderer.invoke('correct-sentences:generate-candidates', jobId, params),
    cancel: (jobId: string) =>
      ipcRenderer.invoke('correct-sentences:cancel', jobId),
    commit: (params: { projectDir: string; index: number; sourceFlacPath: string; text?: string }) =>
      ipcRenderer.invoke('correct-sentences:commit', params),
    revert: (params: { projectDir: string; index: number }) =>
      ipcRenderer.invoke('correct-sentences:revert', params),
    cleanup: (sessionId: string) =>
      ipcRenderer.invoke('correct-sentences:cleanup', sessionId),
    onProgress: (callback: (data: { jobId: string; done: number; total: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; done: number; total: number }) => {
        callback(data);
      };
      ipcRenderer.on('correct-sentences:progress', listener);
      return () => {
        ipcRenderer.removeListener('correct-sentences:progress', listener);
      };
    },
  },
  rvc: {
    startEnhancement: (jobId: string, config: unknown) =>
      ipcRenderer.invoke('rvc:start-enhancement', jobId, config),
    stopEnhancement: (jobId: string) =>
      ipcRenderer.invoke('rvc:stop-enhancement', jobId),
    onProgress: (callback: (data: { jobId: string; progress: { phase: string; percentage: number; processed?: number; total?: number; message?: string; error?: string } }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: { phase: string; percentage: number; processed?: number; total?: number; message?: string; error?: string } }) => {
        callback(data);
      };
      ipcRenderer.on('rvc:progress', listener);
      return () => {
        ipcRenderer.removeListener('rvc:progress', listener);
      };
    },
  },
  chapterRecovery: {
    detectChapters: (epubPath: string, vttPath: string, m4bPath?: string) =>
      ipcRenderer.invoke('chapter-recovery:detect-chapters', epubPath, vttPath, m4bPath),
    applyChapters: (m4bPath: string, chapters: Array<{ title: string; timestamp: string }>) =>
      ipcRenderer.invoke('chapter-recovery:apply-chapters', m4bPath, chapters),
    probeChapters: (audioPath: string) =>
      ipcRenderer.invoke('chapter-recovery:probe-chapters', audioPath),
  },
  reader: {
    list: () => ipcRenderer.invoke('reader:list'),
    recordListening: (p: { readerId: string; bookPath: string; title: string; author: string; seconds: number; id?: string }) =>
      ipcRenderer.invoke('reader:record-listening', p),
    savePosition: (p: { readerId: string; bookPath: string; seconds: number }) =>
      ipcRenderer.invoke('reader:save-position', p),
    getPosition: (p: { readerId: string; bookPath: string }) =>
      ipcRenderer.invoke('reader:get-position', p),
    listBookmarks: (p: { readerId: string; bookPath: string }) =>
      ipcRenderer.invoke('reader:list-bookmarks', p),
    saveBookmark: (p: { readerId: string; bookPath: string; op: 'add' | 'del'; bookmark: Record<string, unknown> & { id?: string } }) =>
      ipcRenderer.invoke('reader:save-bookmark', p),
  },
  debug: {
    log: (message: string) =>
      ipcRenderer.invoke('debug:log', message),
    ttsDecision: (level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: Record<string, unknown>) =>
      ipcRenderer.invoke('tts-log:decision', level, message, data),
    saveLogs: (content: string, filename: string) =>
      ipcRenderer.invoke('debug:save-logs', content, filename),
  },

  // Article import — see the note on the type declaration above.
  languageLearning: {
    fetchUrl: (url: string, projectId?: string) =>
      ipcRenderer.invoke('language-learning:fetch-url', url, projectId),
    finalizeContent: (projectId: string, finalizedHtml: string): Promise<{ success: boolean; epubPath?: string; error?: string }> =>
      ipcRenderer.invoke('language-learning:finalize-content', projectId, finalizedHtml),
  },
  manifest: {
    // Create a new project
    create: (
      projectType: 'book' | 'article',
      source: {
        type?: 'pdf' | 'epub' | 'url';
        originalFilename?: string;
        fileHash?: string;
        url?: string;
        fetchedAt?: string;
        deletedBlockIds?: string[];
        pageOrder?: number[];
      },
      metadata: {
        title?: string;
        author?: string;
        authorFileAs?: string;
        year?: string;
        language?: string;
        publisher?: string;
        description?: string;
        coverPath?: string;
        byline?: string;
        excerpt?: string;
        wordCount?: number;
        narrator?: string;
        series?: string;
        seriesPosition?: number;
        outputFilename?: string;
      }
    ): Promise<{
      success: boolean;
      projectId?: string;
      projectPath?: string;
      manifestPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('manifest:create', projectType, source, metadata),

    // Get a project manifest
    get: (projectId: string): Promise<{
      success: boolean;
      manifest?: any;
      projectPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('manifest:get', projectId),

    // Update specific fields in a manifest
    update: (update: {
      projectId: string;
      source?: any;
      metadata?: any;
      chapters?: any[];
      pipeline?: any;
      outputs?: any;
      editor?: any;
      /** Re-classify the project; Studio and the Bookshelf split their lists by it. */
      projectType?: 'book' | 'article';
      archived?: boolean;
      sortOrder?: number;
    }): Promise<{
      success: boolean;
      manifestPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('manifest:update', update),

    // One project's editor state, from the sidecar file it lives in. A manifest
    // from `get`/`list` does NOT carry it — ask here, per project, when you are
    // about to edit that project. `editor: null` means it has none.
    getEditorState: (projectId: string): Promise<{
      success: boolean;
      editor?: any;
      error?: string;
    }> => ipcRenderer.invoke('manifest:get-editor-state', projectId),

    // List all projects
    list: (filter?: { type?: 'book' | 'article' }): Promise<{
      success: boolean;
      projects?: any[];
      error?: string;
    }> => ipcRenderer.invoke('manifest:list', filter),

    // Delete a project
    delete: (projectId: string): Promise<{
      success: boolean;
      error?: string;
    }> => ipcRenderer.invoke('manifest:delete', projectId),

    // Import a source file into a project
    importSource: (projectId: string, sourcePath: string, targetFilename?: string): Promise<{
      success: boolean;
      relativePath?: string;
      error?: string;
    }> => ipcRenderer.invoke('manifest:import-source', projectId, sourcePath, targetFilename),

    // Resolve a relative manifest path to absolute OS path
    resolvePath: (projectId: string, relativePath: string): Promise<{
      path: string;
    }> => ipcRenderer.invoke('manifest:resolve-path', projectId, relativePath),

    // Get project folder path
    getProjectPath: (projectId: string): Promise<{
      path: string;
    }> => ipcRenderer.invoke('manifest:get-project-path', projectId),

    // Check if project exists
    exists: (projectId: string): Promise<{
      exists: boolean;
    }> => ipcRenderer.invoke('manifest:exists', projectId),

    // Get all unique tags across all projects
    getAllTags: (): Promise<string[]> => ipcRenderer.invoke('manifest:get-all-tags'),

    // Migration methods
    scanLegacy: (): Promise<{
      success: boolean;
      bfpCount: number;
      audiobookCount: number;
      articleCount: number;
      total: number;
    }> => ipcRenderer.invoke('manifest:scan-legacy'),

    needsMigration: (): Promise<{
      needsMigration: boolean;
    }> => ipcRenderer.invoke('manifest:needs-migration'),

    migrateAll: (): Promise<{
      success: boolean;
      migrated: string[];
      failed: Array<{ path: string; error: string }>;
    }> => ipcRenderer.invoke('manifest:migrate-all'),

    // Listen for migration progress updates
    onMigrationProgress: (callback: (progress: {
      phase: 'scanning' | 'migrating' | 'complete' | 'error';
      current: number;
      total: number;
      currentProject?: string;
      migratedProjects: string[];
      failedProjects: Array<{ id: string; error: string }>;
    }) => void) => {
      ipcRenderer.on('manifest:migration-progress', (_event, progress) => callback(progress));
    },

    offMigrationProgress: () => {
      ipcRenderer.removeAllListeners('manifest:migration-progress');
    },
  },

  archive: {
    saveToArchive: (projectId: string, sourcePath: string, options: {
      role: 'original' | 'translation' | 'export' | 'audiobook';
      format: string;
      language?: string;
      label?: string;
    }) =>
      ipcRenderer.invoke('archive:save-to-archive', projectId, sourcePath, options),
    list: (projectId: string) =>
      ipcRenderer.invoke('archive:list', projectId),
    addFile: (projectId: string) =>
      ipcRenderer.invoke('archive:add-file', projectId),
  },

  editor: {
    // ── Per-listener subscriptions, as every other channel here does them ────
    //
    // These two used to be `on` + a bare `off` that called
    // `removeAllListeners`, which is a channel-wide act performed by one
    // subscriber: Studio's teardown unsubscribed the editor window, and there
    // was no spelling of "unsubscribe me" that did not. So they return the
    // closure that removes the listener that was just added — the
    // `tts.onProgress` / `document.onStageProgress` shape — and there is no
    // `off*` any more.
    //
    // `onFilesChanged` is misfiled rather than dead: it listens on
    // `project:files-changed`, which every write handler still broadcasts.
    onWindowClosed: (callback: (projectPath: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, projectPath: string) =>
        callback(projectPath);
      ipcRenderer.on('editor:window-closed', listener);
      return () => { ipcRenderer.removeListener('editor:window-closed', listener); };
    },
    onFilesChanged: (callback: (projectPath: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, projectPath: string) =>
        callback(projectPath);
      ipcRenderer.on('project:files-changed', listener);
      return () => { ipcRenderer.removeListener('project:files-changed', listener); };
    },
  },
  analysis: {
    delete: (projectDir: string) =>
      ipcRenderer.invoke('analysis:delete', projectDir),
  },
  versions: {
    pageData: (projectId: string) =>
      ipcRenderer.invoke('versions:page-data', projectId),
    // The finished audiobook facts, once main has worked out what the cache did
    // not already know. Per-listener unsubscribe, as everything else here does
    // it — a bare removeAllListeners would take the page's subscription away
    // from whichever window unmounted second.
    onAudiobookFacts: (
      callback: (event: { projectId: string; audiobooks: VersionsAudiobookFacts[] }) => void,
    ) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        event: { projectId: string; audiobooks: VersionsAudiobookFacts[] },
      ) => callback(event);
      ipcRenderer.on('versions:audiobook-facts', listener);
      return () => { ipcRenderer.removeListener('versions:audiobook-facts', listener); };
    },
  },
  pipeline: {
    deleteCleanup: (projectPath: string) =>
      ipcRenderer.invoke('pipeline:delete-cleanup', projectPath),
    deleteSimplify: (projectPath: string) =>
      ipcRenderer.invoke('pipeline:delete-simplify', projectPath),
    deleteTranslation: (projectPath: string, epubName?: string) =>
      ipcRenderer.invoke('pipeline:delete-translation', projectPath, epubName),
    deleteTtsCache: (projectPath: string, language?: string) =>
      ipcRenderer.invoke('pipeline:delete-tts-cache', projectPath, language),
    deleteOutput: (projectPath: string) =>
      ipcRenderer.invoke('pipeline:delete-output', projectPath),
    deleteAll: (projectPath: string) =>
      ipcRenderer.invoke('pipeline:delete-all', projectPath),
    resetEditorState: (projectPath: string, familyId?: string) =>
      ipcRenderer.invoke('pipeline:reset-editor-state', projectPath, familyId),
    exportEpub: (sourcePath: string, metadata: any, coverPath?: string) =>
      ipcRenderer.invoke('epub:export-book', sourcePath, metadata, coverPath),
  },


  platform: process.platform,
  arch: process.arch,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// Type declaration for renderer
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

/**
 * Unified Project Manifest Types
 *
 * Single source of truth for all project data (books and articles).
 * All paths in the manifest are stored as relative paths with forward slashes
 * and resolved at runtime using the configured library path.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectType = 'book' | 'article';
export type SourceType = 'pdf' | 'epub' | 'url';

export type PipelineStageStatus = 'none' | 'pending' | 'processing' | 'complete' | 'error';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Schema (Version 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectManifest {
  version: 2;
  projectId: string;
  projectType: ProjectType;
  createdAt: string;          // ISO timestamp
  modifiedAt: string;         // ISO timestamp

  source: ManifestSource;
  metadata: ManifestMetadata;
  chapters: ManifestChapter[];
  pipeline: ManifestPipeline;
  outputs: ManifestOutputs;

  // Editor state (for books from PDF)
  editor?: ManifestEditorState;

  // Organization
  archived?: boolean;          // Hidden from active lists, shown in Archived section
  sortOrder?: number;          // Manual sort order (ascending); fallback to modifiedAt
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Information
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestSource {
  type: SourceType;
  originalFilename: string;   // Original filename before import
  fileHash?: string;          // SHA256 hash for deduplication

  // For articles (type: 'url')
  url?: string;               // Source URL
  fetchedAt?: string;         // When URL was fetched

  // For PDFs - editor-specific source data
  deletedBlockIds?: string[]; // Blocks deleted in editor
  pageOrder?: number[];       // Reordered pages
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestMetadata {
  title: string;
  author: string;             // Author or byline for articles
  authorFileAs?: string;      // "Last, First" format for sorting
  year?: string;
  language: string;           // Primary/source language (ISO 639-1)
  publisher?: string;
  description?: string;
  coverPath?: string;         // Relative path: "source/cover.jpg"

  // Article-specific
  byline?: string;            // Article author info from Readability
  excerpt?: string;           // Article summary
  wordCount?: number;         // Article word count

  // Audiobook-specific
  narrator?: string;
  series?: string;
  seriesPosition?: number;
  outputFilename?: string;    // Custom output filename
  contributors?: Array<{ first: string; last: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapters with Stable IDs
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestChapter {
  id: string;                 // Stable UUID
  title: string;
  order: number;              // Sort order within book

  // Chapter-level metadata
  sourceIndex?: number;       // Original index in source document

  // Sentences with multi-language support
  sentences: ManifestSentence[];
}

export interface ManifestSentence {
  id: string;                 // Stable UUID

  // Multi-language text: { "en": "Hello", "de": "Hallo", "ko": "안녕" }
  text: Record<string, string>;

  // Audio paths per language: { "en": "stages/03-tts/en/0001.wav" }
  audio?: Record<string, string>;

  // Sentence-level metadata
  order: number;              // Sort order within chapter
  deleted?: boolean;          // Soft-deleted by user
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline State
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestPipeline {
  cleanup?: CleanupStage;
  translations?: Record<string, TranslationStage>;  // Keyed by language code
  tts?: Record<string, TTSStage>;                   // Keyed by language code
  bilingualAssembly?: Record<string, BilingualAssemblyStage>;  // Keyed by lang pair
}

export interface CleanupStage {
  status: PipelineStageStatus;
  outputPath?: string;        // Relative: "stages/01-cleanup/cleaned.epub"
  completedAt?: string;
  error?: string;
  model?: string;             // AI model used
  skippedChunks?: SkippedChunkInfo[];
}

export interface SkippedChunkInfo {
  chapterTitle: string;
  chunkIndex: number;
  overallChunkNumber: number;
  originalText: string;
  modelOutput: string;
  reason: string;
}

export interface TranslationStage {
  status: PipelineStageStatus;
  completedAt?: string;
  error?: string;
  model?: string;             // AI model used
  sentenceCount?: number;     // Number of sentences translated
}

export interface TTSStage {
  status: PipelineStageStatus;
  sessionId?: string;         // e2a session UUID
  sessionDir?: string;        // Relative path to session directory
  completedAt?: string;
  error?: string;
  progress?: {
    completed: number;
    total: number;
  };
  settings?: TTSSettings;
}

export interface TTSSettings {
  engine: 'xtts' | 'orpheus';
  device: 'gpu' | 'mps' | 'cpu';
  voice: string;
  temperature?: number;
  speed?: number;
  workerCount?: number;
}

export interface BilingualAssemblyStage {
  status: PipelineStageStatus;
  completedAt?: string;
  error?: string;
  sourceLang: string;
  targetLang: string;
  pauseDuration?: number;     // Pause between source/target in ms
  gapDuration?: number;       // Gap between sentence pairs in ms
}

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestOutputs {
  // Single-language audiobook
  audiobook?: AudiobookOutput;

  // Bilingual audiobooks keyed by "sourceLang-targetLang" (e.g., "en-de")
  bilingualAudiobooks?: Record<string, AudiobookOutput>;

  // Enhanced audiobook (post Resemble Enhance)
  enhancedAudiobook?: AudiobookOutput;

  // Playback position bookmarks keyed by output identifier: "audiobook", "en-de", etc.
  bookmarks?: Record<string, BookmarkState>;

  // User-created named bookmarks keyed by output identifier
  namedBookmarks?: Record<string, NamedBookmark[]>;
}

export interface BookmarkState {
  position: number;        // currentTime in seconds
  chapterId?: string;
  cueIndex?: number;
  lastPlayedAt: string;    // ISO timestamp
  speed?: number;          // playback speed (mono player)
  sourceSpeed?: number;    // source language speed (bilingual)
  targetSpeed?: number;    // target language speed (bilingual)
}

export interface NamedBookmark {
  name: string;
  position: number;        // seconds
  chapterId?: string;
  createdAt: string;       // ISO timestamp
}

export interface AudiobookOutput {
  path: string;               // Relative: "output/audiobook.m4b"
  vttPath?: string;           // Relative: "output/audiobook.vtt"
  sentencePairsPath?: string; // Relative: "stages/02-translate/sentence_pairs_de.json"
  duration?: number;          // Duration in seconds
  completedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor State (for PDF source)
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestEditorState {
  // Undo/redo stacks
  undoStack?: EditorHistoryAction[];
  redoStack?: EditorHistoryAction[];

  // Article-specific: deleted selectors
  deletedSelectors?: string[];
}

export interface EditorHistoryAction {
  type: 'delete' | 'restore' | 'reorder';
  ids: string[];              // Block IDs or selectors
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration Support
// ─────────────────────────────────────────────────────────────────────────────

export interface MigrationResult {
  success: boolean;
  projectId?: string;
  manifestPath?: string;
  error?: string;
  warnings?: string[];
}

export interface MigrationProgress {
  phase: 'scanning' | 'migrating' | 'complete' | 'error';
  current: number;
  total: number;
  currentProject?: string;
  migratedProjects: string[];
  failedProjects: Array<{ path: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Result Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestListResult {
  success: boolean;
  projects?: ProjectManifest[];
  error?: string;
}

export interface ManifestGetResult {
  success: boolean;
  manifest?: ProjectManifest;
  projectPath?: string;       // Absolute path to project folder
  error?: string;
}

export interface ManifestSaveResult {
  success: boolean;
  manifestPath?: string;
  error?: string;
}

export interface ManifestCreateResult {
  success: boolean;
  projectId?: string;
  projectPath?: string;
  manifestPath?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Partial manifest for updates - all fields optional except projectId
 */
export type ManifestUpdate = Partial<Omit<ProjectManifest, 'projectId' | 'version'>> & {
  projectId: string;
};

/**
 * Project summary for list views (doesn't include full chapters/sentences)
 */
export interface ProjectSummary {
  projectId: string;
  projectType: ProjectType;
  title: string;
  author: string;
  coverPath?: string;
  coverData?: string;         // Base64 encoded cover for display
  language: string;
  createdAt: string;
  modifiedAt: string;

  // Status indicators
  hasCleanup: boolean;
  hasTranslations: string[];  // Language codes
  hasTTS: string[];           // Language codes
  hasAudiobook: boolean;
  hasBilingualAudiobooks: string[];  // Lang pair keys

  // For articles
  sourceUrl?: string;
  wordCount?: number;
}

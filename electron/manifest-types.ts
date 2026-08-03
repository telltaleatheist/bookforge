/**
 * Manifest Types for Electron Main Process
 *
 * These types mirror the Angular types in src/app/core/models/manifest.types.ts
 * Keep both in sync when making changes.
 */

import type { TextBlock, Category } from '../shared/ocr/text-block';

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectType = 'book' | 'article';
export type SourceType = 'pdf' | 'epub' | 'url' | 'audiobook';
export type PipelineStageStatus = 'none' | 'pending' | 'processing' | 'complete' | 'error';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Schema (Version 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectManifest {
  version: 2;
  projectId: string;
  projectType: ProjectType;
  createdAt: string;
  modifiedAt: string;
  source: ManifestSource;
  metadata: ManifestMetadata;
  chapters: ManifestChapter[];
  pipeline: ManifestPipeline;
  outputs: ManifestOutputs;
  editor?: ManifestEditorState;

  // Organization
  archived?: boolean;
  sortOrder?: number;

  // Archive
  archive?: ArchiveEntry[];

  // Book variants — distinct editions/languages/formats of the SAME book in one
  // project (English epub, German epub, the m4b audiobook…). The primaryVariantId
  // variant represents the project (its metadata mirrors `metadata`). Separate
  // from pipeline "versions" (original/exported/cleaned…), which are stages of the
  // active source. Derived lazily from archive[]/outputs for older projects.
  variants?: ProjectVariant[];
  primaryVariantId?: string;

  /**
   * Completed audiobook analyses, keyed by the stable audiobook variant id.
   * The referenced report is usable only after the protocol verifies both hashes
   * against the current variant. Document analysis remains in pipeline.analysis.
   */
  audiobookAnalyses?: Record<string, AudiobookAnalysisManifestEntry>;
}

export interface AudiobookAnalysisManifestEntry {
  protocolVersion: 1;
  analysisId: string;
  variantId: string;
  reportPath: string; // project-relative canonical report path
  reportHashAlgorithm: 'sha256';
  reportSha256: string;
  m4bHashAlgorithm: 'sha256';
  m4bSha256: string;
  m4bSizeBytes: number;
  transcriptDigestAlgorithm: 'bookforge-vtt-cues-v1';
  transcriptSha256: string;
  cueCount: number;
  analyzedAt: string;
}

export type VariantKind = 'ebook' | 'audiobook';

export interface VariantMetadata {
  title?: string;
  author?: string;
  year?: string;
  language?: string;
  narrator?: string;
  series?: string;
  seriesPosition?: number;
  description?: string;
  coverPath?: string; // library-relative, e.g. "media/cover_ab12.jpg"
}

export interface ProjectVariant {
  id: string;
  kind: VariantKind;
  format: string; // 'epub' | 'pdf' | 'm4b' | …
  path: string;   // project-relative: "archive/…epub" or "output/…m4b"
  descriptor?: string; // free text: "German", "First edition", "TTS", …
  metadata: VariantMetadata;
  vttPath?: string;        // audiobook variants: project-relative synced transcript
  sourceFileHash?: string; // dedup
  addedAt: string;
  professionallyRead?: boolean;  // audiobook variants: user-settable "professionally read" flag
}

/**
 * A variant as handed to the RENDERER — with its file already resolved.
 *
 * `ProjectVariant.path` is project-relative and slash-separated, so it means
 * nothing without the project directory it belongs to. The renderer used to join
 * the two itself, reading the live "currently selected book" path at click time;
 * because the variant rows load asynchronously, a row could be paired with a
 * DIFFERENT book's directory in the window between the selection changing and the
 * rows finishing their reload — addressing a file that has never existed
 * ("<project B>/archive/<book A>.pdf": ENOENT).
 *
 * So resolution happens HERE, in main, in the same call that produces the row:
 * `absPath` is bound to the project the variant was read from and cannot drift.
 * `exists` is that path stat'ed at list time, so a caller can refuse an action
 * with a message that names the missing file instead of failing later, deeper,
 * with a path the user cannot place.
 */
export interface ResolvedProjectVariant extends ProjectVariant {
  absPath: string;  // absolute, platform-native, NFC-normalized
  exists: boolean;  // absPath was a regular file when this list was produced
  /** `vttPath` resolved the same way, or null when the variant declares no VTT. */
  vttAbsPath: string | null;
  /** vttAbsPath was a regular file when this list was produced (false when null). */
  vttExists: boolean;
}

export interface ArchiveEntry {
  path: string;           // Relative: "archive/Title. Author. (2022).pdf"
  role: 'original' | 'translation' | 'export' | 'audiobook';
  format: string;         // 'pdf', 'epub', 'm4b', etc.
  language?: string;      // For translations: 'en', 'de', etc.
  label?: string;         // User-facing: "Original PDF", "English Translation"
  archivedAt: string;     // ISO timestamp
  size?: number;          // File size in bytes
}

export interface ManifestSource {
  type: SourceType;
  originalFilename: string;
  fileHash?: string;
  url?: string;
  fetchedAt?: string;
  deletedBlockIds?: string[];
  pageOrder?: number[];
  /** Written by the markup-preserving EPUB export — see ExportProvenance. */
  exportProvenance?: ExportProvenance;
}

/**
 * Which file an export came out of, and what came out.
 *
 * The markup-preserving EPUB export aligns the editor's blocks against a
 * specific EPUB; the edits only mean anything against THAT file. Recording both
 * hashes binds the three artifacts together — the source, the edit set that was
 * applied to it, and the produced exported.epub — so a later reader can prove
 * the export still matches what it claims to (the same dual-hash discipline as
 * `audiobookAnalyses`, which will not trust a report whose hashes drifted).
 */
export interface ExportProvenance {
  sourceSha256: string;      // hash of the epub the edits were aligned against
  sourceRelPath: string;     // project-relative, slash-separated
  exportedSha256: string;    // hash of the produced exported.epub
  exportedAt: string;        // ISO timestamp
}

export interface ManifestMetadata {
  title: string;
  author: string;
  authorFileAs?: string;
  year?: string;
  language: string;
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
  contributors?: Array<{ first: string; last: string }>;
  tags?: string[];
  /**
   * Per-format overrides for the AUDIOBOOK, independent from the ebook/canonical
   * fields above. Only the fields the user changed for the audiobook are stored;
   * unset fields fall back to the canonical values (see effectiveAudiobookMetadata).
   * This is what gets embedded into the m4b's tags.
   */
  audiobook?: {
    title?: string;
    author?: string;
    year?: string;
    narrator?: string;
    series?: string;
    seriesPosition?: number;
    description?: string;
    coverPath?: string;
  };
}

export interface ManifestChapter {
  id: string;
  title: string;
  order: number;
  sourceIndex?: number;
  sentences: ManifestSentence[];
}

export interface ManifestSentence {
  id: string;
  text: Record<string, string>;
  audio?: Record<string, string>;
  order: number;
  deleted?: boolean;
}

export interface ManifestPipeline {
  cleanup?: CleanupStage;
  translations?: Record<string, TranslationStage>;
  tts?: Record<string, TTSStage>;
  bilingualAssembly?: Record<string, BilingualAssemblyStage>;
}

export interface CleanupStage {
  status: PipelineStageStatus;
  outputPath?: string;
  completedAt?: string;
  error?: string;
  model?: string;
}

export interface TranslationStage {
  status: PipelineStageStatus;
  completedAt?: string;
  error?: string;
  model?: string;
  sentenceCount?: number;
}

export interface TTSStage {
  status: PipelineStageStatus;
  sessionId?: string;
  sessionDir?: string;
  completedAt?: string;
  error?: string;
  progress?: { completed: number; total: number };
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
  pauseDuration?: number;
  gapDuration?: number;
}

export interface ManifestOutputs {
  audiobook?: AudiobookOutput;
  bilingualAudiobooks?: Record<string, AudiobookOutput>;
  /** The project's converted book — see EpubOutput. */
  epub?: EpubOutput;
}

/**
 * The EPUB the editor produced: the project's converted book, not a throwaway
 * TTS artifact. Its filename comes from the book's title, so this record is the
 * ONE authority on where it is — nothing may scan `source/` for a name pattern.
 */
export interface EpubOutput {
  /** Project-relative, forward slashes, e.g. `source/The Waste Land.epub`. */
  path: string;
  modifiedAt: string;
}

export interface AudiobookOutput {
  path: string;
  vttPath?: string;
  sentencePairsPath?: string;
  duration?: number;
  completedAt?: string;
  professionallyRead?: boolean;  // user-settable "professionally read" flag
}

export interface ManifestEditorState {
  undoStack?: EditorHistoryAction[];
  redoStack?: EditorHistoryAction[];
  deletedSelectors?: string[];
  /**
   * A completed OCR pass: the categorized paragraph blocks, and the category
   * records they were classified into.
   *
   * Written by the picker's save (`project:save-to-path`) and by
   * `cli/ocr-pdf.js --project` via `ocr-project-store.ts`; read back by
   * `projects:load-from-path`, which is what makes reopening an OCR'd book show
   * the stored blocks instead of re-OCRing. Typed here because the CLI writes
   * them from outside the renderer — `project:save-to-path` still assigns them
   * through an untyped parsed manifest, so this declaration documents the
   * contract rather than enforcing it there.
   *
   * Block IDs are FROZEN once written: `categoryCorrections` keys hand labels by
   * block id, so replacing these blocks orphans those labels.
   */
  ocrBlocks?: TextBlock[];
  ocrCategories?: Record<string, Category>;
}

export interface EditorHistoryAction {
  type: 'delete' | 'restore' | 'reorder';
  ids: string[];
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Result Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestGetResult {
  success: boolean;
  manifest?: ProjectManifest;
  projectPath?: string;
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

/**
 * Which kinds of narration a project actually has. Both can be true — a book can
 * carry a bought human-narrated m4b AND a TTS render — and both false means it has
 * no audiobook at all, which is why "AI" is not the negation of "professional".
 *
 * Derived in the main process from getVariants(), the ONE place that knows how
 * audiobook outputs dedupe against real variants and which default each kind takes.
 * Never persisted to a manifest.
 */
export interface NarrationFlags {
  professional: boolean;
  ai: boolean;
}

export interface ManifestListResult {
  success: boolean;
  projects?: ProjectManifest[];
  /** Narration flags per projectId. Populated for EVERY returned project. */
  narration?: Record<string, NarrationFlags>;
  error?: string;
}

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

export interface ProjectSummary {
  projectId: string;
  projectType: ProjectType;
  title: string;
  author: string;
  coverPath?: string;
  coverData?: string;
  language: string;
  createdAt: string;
  modifiedAt: string;
  hasCleanup: boolean;
  hasTranslations: string[];
  hasTTS: string[];
  hasAudiobook: boolean;
  hasBilingualAudiobooks: string[];
  sourceUrl?: string;
  wordCount?: number;
}

/**
 * A patch for `updateManifest`. The sub-objects it merges — source, metadata,
 * pipeline, outputs, editor — are SHALLOW-MERGED into the stored manifest
 * (`{...manifest.source, ...update.source}`), so a caller is meant to send only
 * the fields it is changing. `Partial<ProjectManifest>` alone made each of those
 * optional-but-complete, which forced callers to either restate required fields
 * they were not touching or cast the whole patch away.
 */
export type ManifestUpdate =
  Partial<Omit<ProjectManifest, 'projectId' | 'version' | 'source' | 'metadata' | 'pipeline' | 'outputs' | 'editor'>>
  & {
    projectId: string;
    source?: Partial<ProjectManifest['source']>;
    metadata?: Partial<ProjectManifest['metadata']>;
    pipeline?: Partial<ProjectManifest['pipeline']>;
    outputs?: Partial<ProjectManifest['outputs']>;
    editor?: Partial<ProjectManifest['editor']>;
  };

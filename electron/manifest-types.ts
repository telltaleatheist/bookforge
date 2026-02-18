/**
 * Manifest Types for Electron Main Process
 *
 * These types mirror the Angular types in src/app/core/models/manifest.types.ts
 * Keep both in sync when making changes.
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
}

export interface ManifestSource {
  type: SourceType;
  originalFilename: string;
  fileHash?: string;
  url?: string;
  fetchedAt?: string;
  deletedBlockIds?: string[];
  pageOrder?: number[];
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
  enhancedAudiobook?: AudiobookOutput;
}

export interface AudiobookOutput {
  path: string;
  vttPath?: string;
  sentencePairsPath?: string;
  duration?: number;
  completedAt?: string;
}

export interface ManifestEditorState {
  undoStack?: EditorHistoryAction[];
  redoStack?: EditorHistoryAction[];
  deletedSelectors?: string[];
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

export interface ManifestListResult {
  success: boolean;
  projects?: ProjectManifest[];
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

export type ManifestUpdate = Partial<Omit<ProjectManifest, 'projectId' | 'version'>> & {
  projectId: string;
};

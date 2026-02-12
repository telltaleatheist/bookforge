import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script - Exposes safe IPC methods to renderer process
 */

export interface ProjectSaveResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
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

export interface ProjectInfo {
  name: string;
  path: string;
  sourcePath: string;
  sourceName: string;
  libraryPath?: string;
  fileHash?: string;
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
  coverImagePath?: string;  // Relative path to cover in media folder
}

export interface ProjectListResult {
  success: boolean;
  projects: ProjectInfo[];
  error?: string;
}

export interface ProjectsDeleteResult {
  success: boolean;
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
  error?: string;
}

export interface ProjectsImportResult {
  success: boolean;
  canceled?: boolean;
  imported: string[];
  failed: Array<{ path: string; error: string }>;
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
      enabled: boolean;
    }>;
    page_count: number;
    page_dimensions: Array<{ width: number; height: number }>;
    pdf_name: string;
  };
  error?: string;
}

export interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
}

export interface OcrParagraph {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
  lineCount: number;
  blockNum: number;
  parNum: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];
  paragraphs?: OcrParagraph[];
}

export interface DeskewResult {
  angle: number;
  confidence: number;
}

// Layout detection categories from Surya
export type LayoutLabel =
  | 'Caption'
  | 'Footnote'
  | 'Formula'
  | 'List-item'
  | 'Page-footer'
  | 'Page-header'
  | 'Picture'
  | 'Figure'
  | 'Section-header'
  | 'Table'
  | 'Form'
  | 'Table-of-contents'
  | 'Handwriting'
  | 'Text'
  | 'Text-inline-math'
  | 'Title';

export interface LayoutBlock {
  bbox: [number, number, number, number];
  polygon: number[][];
  label: LayoutLabel;
  confidence: number;
  position: number;
  text?: string;
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

export type AIProvider = 'ollama' | 'claude' | 'openai';

export interface AIProviderConfig {
  provider: AIProvider;
  ollama?: {
    baseUrl: string;
    model: string;
  };
  claude?: {
    apiKey: string;
    model: string;
  };
  openai?: {
    apiKey: string;
    model: string;
  };
}

export interface OllamaModel {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface AICleanupOptions {
  fixHyphenation: boolean;
  fixOcrArtifacts: boolean;
  expandAbbreviations: boolean;
}

export interface CleanupProgress {
  chapterId: string;
  chapterTitle: string;
  currentChunk: number;
  totalChunks: number;
  percentage: number;
}

export interface CleanupResult {
  success: boolean;
  cleanedText?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// TTS Types (ebook2audiobook)
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionPhase = 'preparing' | 'converting' | 'merging' | 'complete' | 'error';

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
}

export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  voice: string;
  temperature: number;
  speed: number;
}

export interface TTSProgress {
  phase: ConversionPhase;
  currentChapter: number;
  totalChapters: number;
  percentage: number;
  estimatedRemaining: number;
  message?: string;
  error?: string;
}

export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audiobook Queue Types
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueFileInfo {
  path: string;
  filename: string;
  size: number;
  addedAt: string;
  projectId?: string;
  hasCleaned?: boolean;
  skippedChunksPath?: string;
}

export interface CompletedAudiobookInfo {
  path: string;
  filename: string;
  size: number;
  modifiedAt: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audiobook Project Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AudiobookProjectMetadata {
  title: string;
  subtitle?: string;
  author: string;
  authorFirstName?: string;
  authorLastName?: string;
  year?: string;
  language: string;
  coverPath?: string;
  outputFilename?: string;
}

export interface AudiobookProjectState {
  cleanupStatus: 'none' | 'pending' | 'processing' | 'complete' | 'error';
  cleanupProgress?: number;
  cleanupError?: string;
  cleanupJobId?: string;
  ttsStatus: 'none' | 'pending' | 'processing' | 'complete' | 'error';
  ttsProgress?: number;
  ttsError?: string;
  ttsJobId?: string;
  ttsSettings?: {
    device: 'gpu' | 'mps' | 'cpu';
    language: string;
    voice: string;
    temperature: number;
    speed: number;
  };
}

export interface AudiobookProjectInfo {
  id: string;
  folderPath: string;
  originalFilename: string;
  metadata: AudiobookProjectMetadata;
  state: AudiobookProjectState;
  hasOriginal: boolean;
  hasCleaned: boolean;
  hasOutput: boolean;
  createdAt: string;
  modifiedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processing Queue Types
// ─────────────────────────────────────────────────────────────────────────────

export type QueueJobType = 'ocr-cleanup' | 'tts-conversion';

export interface QueueProgress {
  jobId: string;
  type: QueueJobType;
  phase: string;
  progress: number;
  message?: string;
  currentChunk?: number;
  totalChunks?: number;
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
// Play Tab Types (XTTS Streaming)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaySettings {
  voice: string;
  speed: number;
  temperature?: number;
  topP?: number;
  repetitionPenalty?: number;
}

export interface PlayAudioChunk {
  data: string;  // Base64 WAV
  duration: number;
  sampleRate: number;
}

export interface PlayAudioGeneratedEvent {
  sentenceIndex: number;
  audio: PlayAudioChunk;
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
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
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
  phase: 'preparing' | 'converting' | 'assembling' | 'complete' | 'error';
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

export interface E2aSession {
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

export interface E2aSessionScanResult {
  sessions: E2aSession[];
  tmpPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeepFilterNet Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioFileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  format: string;
}

export interface DenoiseProgress {
  phase: 'starting' | 'converting' | 'denoising' | 'finalizing' | 'complete' | 'error';
  percentage: number;
  message: string;
  error?: string;
}

export interface EnhanceProgress {
  phase: 'starting' | 'converting' | 'enhancing' | 'finalizing' | 'complete' | 'error';
  percentage: number;
  message: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Library Server Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LibraryServerStatus {
  running: boolean;
  port: number;
  addresses: string[];
  booksPath: string;
}

export interface LibraryServerConfig {
  booksPath: string;
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

export interface ElectronAPI {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    renderPage: (pageNum: number, scale?: number, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>, removeBackground?: boolean) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderBlankPage: (pageNum: number, scale?: number) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderAllPages: (pdfPath: string, scale?: number, concurrency?: number) => Promise<{ success: boolean; data?: { paths: string[] }; error?: string }>;
    renderWithPreviews: (pdfPath: string, concurrency?: number) => Promise<{ success: boolean; data?: RenderWithPreviewsResult; error?: string }>;
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
    exportPdf: (pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>, deletedPages?: number[]) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    exportPdfNoBackgrounds: (scale?: number, deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, ocrBlocks?: Array<{ page: number; x: number; y: number; width: number; height: number; text: string; font_size: number }>, deletedPages?: number[]) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    exportPdfWysiwyg: (deletedRegions?: Array<{ page: number; x: number; y: number; width: number; height: number; isImage?: boolean }>, deletedPages?: number[], scale?: number, ocrPages?: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}>) => Promise<{ success: boolean; data?: { pdf_base64: string }; error?: string }>;
    findSimilar: (blockId: string) => Promise<{ success: boolean; data?: { similar_ids: string[]; count: number }; error?: string }>;
    findSpansInRect: (page: number, x: number, y: number, width: number, height: number) => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
    analyzeSamples: (sampleSpans: TextSpan[]) => Promise<{ success: boolean; data?: SamplePattern; error?: string }>;
    findMatchingSpans: (pattern: SamplePattern) => Promise<{ success: boolean; data?: MatchingSpansResult; error?: string }>;
    findSpansByRegex: (pattern: string, minFontSize: number, maxFontSize: number, minBaseline?: number | null, maxBaseline?: number | null, caseSensitive?: boolean) => Promise<{ success: boolean; data?: MatchingSpansResult; error?: string }>;
    getSpans: () => Promise<{ success: boolean; data?: TextSpan[]; error?: string }>;
    updateSpansForOcr: (pageNum: number, ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>) => Promise<{ success: boolean; error?: string }>;
    // Chapter detection
    extractOutline: () => Promise<{ success: boolean; data?: OutlineItem[]; error?: string }>;
    outlineToChapters: (outline: OutlineItem[]) => Promise<{ success: boolean; data?: Chapter[]; error?: string }>;
    detectChapters: () => Promise<{ success: boolean; data?: Chapter[]; error?: string }>;
    addBookmarks: (pdfBase64: string, chapters: Chapter[]) => Promise<{ success: boolean; data?: string; error?: string }>;
    // WYSIWYG export from canvas-rendered images
    assembleFromImages: (pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>, chapters?: Chapter[]) => Promise<string | null>;
  };
  fs: {
    browse: (dirPath: string) => Promise<{
      path: string;
      parent: string;
      items: Array<{ name: string; path: string; type: string; size: number | null }>;
    }>;
    readBinary: (filePath: string) => Promise<{ success: boolean; data?: Uint8Array; error?: string }>;
    exists: (filePath: string) => Promise<boolean>;
    writeText: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
    writeTempFile: (filename: string, data: Uint8Array) => Promise<{ success: boolean; path?: string; dataUrl?: string; error?: string }>;
    readText: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    readAudio: (audioPath: string) => Promise<{ success: boolean; dataUrl?: string; size?: number; error?: string }>;
    listDirectory: (dirPath: string) => Promise<string[]>;
  };
  project: {
    save: (projectData: unknown, suggestedName?: string) => Promise<ProjectSaveResult>;
    load: () => Promise<ProjectLoadResult>;
    saveToPath: (filePath: string, projectData: unknown) => Promise<ProjectSaveResult>;
    updateMetadata: (bfpPath: string, metadata: unknown) => Promise<{ success: boolean; error?: string }>;
  };
  dialog: {
    openPdf: () => Promise<OpenPdfResult>;
    openFolder: () => Promise<{ success: boolean; canceled?: boolean; folderPath?: string; error?: string }>;
    openAudio: () => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveEpub: (defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveText: (defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    confirm: (options: {
      title: string;
      message: string;
      detail?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      type?: 'none' | 'info' | 'error' | 'question' | 'warning';
    }) => Promise<{ confirmed: boolean }>;
  };
  projects: {
    ensureFolder: () => Promise<{ success: boolean; path?: string; error?: string }>;
    getFolder: () => Promise<{ path: string }>;
    list: () => Promise<ProjectListResult>;
    save: (projectData: unknown, name: string) => Promise<ProjectSaveResult>;
    delete: (filePaths: string[]) => Promise<ProjectsDeleteResult>;
    import: () => Promise<ProjectsImportResult>;
    export: (projectPath: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    loadFromPath: (filePath: string) => Promise<ProjectLoadResult>;
    finalize: (bfpPath: string) => Promise<{ success: boolean; epubPath?: string; error?: string }>;
    migrateAll: () => Promise<{
      success: boolean;
      migrated: string[];
      skipped: string[];
      failed: Array<{ name: string; error: string }>;
      error?: string;
    }>;
  };
  library: {
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
    copyToQueue: (data: ArrayBuffer | string, filename: string, metadata?: {
      title?: string;
      author?: string;
      language?: string;
      coverImage?: string;
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
    }) => Promise<{
      success: boolean;
      destinationPath?: string;
      error?: string;
    }>;
    listQueue: () => Promise<{
      success: boolean;
      files?: QueueFileInfo[];
      error?: string;
    }>;
    getAudiobooksPath: () => Promise<{
      success: boolean;
      queuePath?: string;
      completedPath?: string;
      error?: string;
    }>;
    listCompleted: (folderPath?: string) => Promise<{
      success: boolean;
      files?: CompletedAudiobookInfo[];
      error?: string;
    }>;
    saveMetadata: (epubPath: string, metadata: EpubMetadata) => Promise<{
      success: boolean;
      error?: string;
    }>;
    loadMetadata: (epubPath: string) => Promise<{
      success: boolean;
      metadata?: EpubMetadata;
      error?: string;
    }>;
    loadCoverImage: (projectId: string, coverFilename: string) => Promise<{
      success: boolean;
      coverData?: string;
      error?: string;
    }>;
    loadDeletedExamplesFromBfp: (epubPath: string) => Promise<{
      success: boolean;
      examples?: Array<{ text: string; category: string; page?: number }>;
      error?: string;
    }>;
    setRoot: (libraryPath: string | null) => Promise<{ success: boolean; error?: string }>;
    getRoot: () => Promise<{ path: string }>;
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
  };
  audiobook: {
    createProject: (sourcePath: string, originalFilename: string) => Promise<{
      success: boolean;
      projectId?: string;
      folderPath?: string;
      originalPath?: string;
      error?: string;
    }>;
    listProjects: () => Promise<{
      success: boolean;
      projects?: AudiobookProjectInfo[];
      error?: string;
    }>;
    getProject: (projectId: string) => Promise<{
      success: boolean;
      project?: AudiobookProjectInfo;
      error?: string;
    }>;
    saveProject: (projectId: string, updates: { metadata?: Partial<AudiobookProjectMetadata>; state?: Partial<AudiobookProjectState> }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    deleteProject: (projectId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    getPaths: (projectId: string) => Promise<{
      success: boolean;
      folderPath?: string;
      originalPath?: string;
      cleanedPath?: string;
      outputPath?: string;
      error?: string;
    }>;
    // Unified audiobook export (saves to BFP project folder)
    exportFromProject: (bfpPath: string, epubData: ArrayBuffer, deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>) => Promise<{
      success: boolean;
      audiobookFolder?: string;
      epubPath?: string;
      error?: string;
    }>;
    // Import EPUB directly (creates BFP + audiobook folder)
    importEpub: (epubSourcePath: string) => Promise<{
      success: boolean;
      bfpPath?: string;
      audiobookFolder?: string;
      epubPath?: string;
      projectName?: string;
      error?: string;
    }>;
    updateState: (bfpPath: string, audiobookState: Record<string, unknown>) => Promise<{
      success: boolean;
      error?: string;
    }>;
    appendAnalytics: (bfpPath: string, jobType: 'tts-conversion' | 'ocr-cleanup', analytics: { jobId: string; [key: string]: unknown }) => Promise<{
      success: boolean;
      error?: string;
    }>;
    copyVtt: (bfpPath: string, m4bOutputPath: string) => Promise<{
      success: boolean;
      vttPath?: string | null;
      message?: string;
      error?: string;
    }>;
    getFolder: (bfpPath: string) => Promise<{
      success: boolean;
      folder?: string;
      error?: string;
    }>;
    listProjectsWithAudiobook: () => Promise<{
      success: boolean;
      projects?: Array<{
        name: string;
        bfpPath: string;
        audiobookFolder: string;
        status: string;
        exportedAt?: string;
        cleanedAt?: string;
        completedAt?: string;
        metadata?: {
          title?: string;
          author?: string;
          coverImagePath?: string;
        };
      }>;
      error?: string;
    }>;
    linkAudio: (bfpPath: string, audioPath: string) => Promise<{ success: boolean; error?: string }>;
    linkBilingualAudio: (bfpPath: string, audioPath: string, vttPath?: string) => Promise<{ success: boolean; error?: string }>;
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
  };
  ai: {
    checkConnection: () => Promise<{ success: boolean; data?: { connected: boolean; models?: OllamaModel[]; error?: string }; error?: string }>;
    checkProviderConnection: (provider: 'ollama' | 'claude' | 'openai') => Promise<{ success: boolean; data?: { available: boolean; error?: string; models?: string[] }; error?: string }>;
    getModels: () => Promise<{ success: boolean; data?: OllamaModel[]; error?: string }>;
    getClaudeModels: (apiKey: string) => Promise<{ success: boolean; models?: { value: string; label: string }[]; error?: string }>;
    getOpenAIModels: (apiKey: string) => Promise<{ success: boolean; models?: { value: string; label: string }[]; error?: string }>;
    loadSkippedChunks: (jsonPath: string) => Promise<{ success: boolean; chunks?: SkippedChunk[]; error?: string }>;
    replaceTextInEpub: (epubPath: string, oldText: string, newText: string) => Promise<{ success: boolean; chapterFound?: string; error?: string }>;
    updateSkippedChunk: (jsonPath: string, index: number, newText: string) => Promise<{ success: boolean; error?: string }>;
    cleanupChapter: (
      text: string,
      options: AICleanupOptions,
      chapterId: string,
      chapterTitle: string,
      model?: string
    ) => Promise<{ success: boolean; data?: CleanupResult; error?: string }>;
    onCleanupProgress: (callback: (progress: CleanupProgress) => void) => () => void;
    getPrompt: () => Promise<{ success: boolean; data?: { prompt: string; filePath: string }; error?: string }>;
    savePrompt: (prompt: string) => Promise<{ success: boolean; error?: string }>;
  };
  shell: {
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  };
  libraryServer: {
    start: (config: LibraryServerConfig) => Promise<{ success: boolean; data?: LibraryServerStatus; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<{ success: boolean; data?: LibraryServerStatus; error?: string }>;
  };
  e2a: {
    configurePaths: (config: { e2aPath?: string; condaPath?: string }) => Promise<{ success: boolean; error?: string }>;
  };
  toolPaths: {
    getConfig: () => Promise<{ success: boolean; data?: Record<string, string | undefined>; error?: string }>;
    updateConfig: (updates: Record<string, string | undefined>) => Promise<{ success: boolean; data?: Record<string, string | undefined>; error?: string }>;
    getStatus: () => Promise<{ success: boolean; data?: Record<string, { configured: boolean; detected: boolean; path: string }>; error?: string }>;
  };
  wsl: {
    detect: () => Promise<{ success: boolean; data?: { available: boolean; version?: number; distros: string[]; defaultDistro?: string; error?: string }; error?: string }>;
    checkOrpheusSetup: (config: { distro?: string; condaPath?: string; e2aPath?: string }) => Promise<{
      success: boolean;
      data?: { valid: boolean; condaFound: boolean; e2aFound: boolean; orpheusEnvFound: boolean; errors: string[] };
      error?: string;
    }>;
  };
  tts: {
    checkAvailable: () => Promise<{ success: boolean; data?: { available: boolean; version?: string; error?: string }; error?: string }>;
    getVoices: () => Promise<{ success: boolean; data?: VoiceInfo[]; error?: string }>;
    startConversion: (
      epubPath: string,
      outputDir: string,
      settings: TTSSettings
    ) => Promise<{ success: boolean; data?: ConversionResult; error?: string }>;
    stopConversion: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    generateFilename: (
      title: string,
      subtitle?: string,
      author?: string,
      authorFileAs?: string,
      year?: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>;
    onProgress: (callback: (progress: TTSProgress) => void) => () => void;
  };
  ocr: {
    isAvailable: () => Promise<{ success: boolean; available?: boolean; version?: string | null; error?: string }>;
    getLanguages: () => Promise<{ success: boolean; languages?: string[]; error?: string }>;
    recognize: (imageData: string) => Promise<{ success: boolean; data?: OcrResult; error?: string }>;
    detectSkew: (imageData: string) => Promise<{ success: boolean; data?: DeskewResult; error?: string }>;
    processPdfHeadless: (pdfPath: string, options: {
      engine: 'tesseract' | 'surya';
      language?: string;
      pages?: number[];
    }) => Promise<{ success: boolean; results?: Array<{
      page: number;
      text: string;
      confidence: number;
      textLines?: OcrTextLine[];
      layoutBlocks?: any[];
    }>; error?: string }>;
    onHeadlessProgress: (callback: (data: { current: number; total: number }) => void) => () => void;
  };
  window: {
    hide: () => Promise<{ success: boolean }>;
    close: () => Promise<{ success: boolean }>;
  };
  plugins: {
    list: () => Promise<{ success: boolean; data?: PluginInfo[]; error?: string }>;
    getSettings: (pluginId: string) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
    updateSettings: (pluginId: string, settings: Record<string, unknown>) => Promise<{ success: boolean; errors?: string[]; error?: string }>;
    checkAvailability: (pluginId: string) => Promise<{ success: boolean; data?: { available: boolean; version?: string; path?: string; error?: string; installInstructions?: string }; error?: string }>;
    invoke: (pluginId: string, channel: string, ...args: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: string }>;
    onProgress: (callback: (progress: PluginProgress) => void) => () => void;
  };
  queue: {
    runOcrCleanup: (jobId: string, epubPath: string, model?: string, aiConfig?: AIProviderConfig & {
      useDetailedCleanup?: boolean;
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
      useParallel?: boolean;
      parallelWorkers?: number;
      cleanupMode?: 'structure' | 'full';
      testMode?: boolean;
      enableAiCleanup?: boolean;
      simplifyForChildren?: boolean;
    }) => Promise<{ success: boolean; data?: any; error?: string }>;
    runTtsConversion: (jobId: string, epubPath: string, config: TtsJobConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
    runTranslation: (jobId: string, epubPath: string, translationConfig: {
      chunkSize?: number;
    }, aiConfig?: AIProviderConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
    cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;
    saveState: (queueState: string) => Promise<{ success: boolean; error?: string }>;
    loadState: () => Promise<{ success: boolean; data?: any; error?: string }>;
    onProgress: (callback: (progress: QueueProgress) => void) => () => void;
    onComplete: (callback: (result: QueueJobResult) => void) => () => void;
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
    // Compute diff using system diff command (efficient, runs in main process)
    computeSystemDiff: (originalText: string, cleanedText: string) => Promise<{
      success: boolean;
      data?: Array<{ text: string; type: 'unchanged' | 'added' | 'removed' }>;
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
  };
  ebookConvert: {
    isAvailable: () => Promise<{ success: boolean; data?: { available: boolean }; error?: string }>;
    getSupportedExtensions: () => Promise<{ success: boolean; data?: string[]; error?: string }>;
    isConvertible: (filePath: string) => Promise<{ success: boolean; data?: { convertible: boolean; native: boolean }; error?: string }>;
    convert: (inputPath: string, outputDir?: string) => Promise<{ success: boolean; data?: { outputPath: string }; error?: string }>;
    convertToLibrary: (inputPath: string) => Promise<{ success: boolean; data?: { outputPath: string }; error?: string }>;
  };
  play: {
    startSession: () => Promise<{ success: boolean; data?: { voices: string[] }; error?: string }>;
    loadVoice: (voice: string) => Promise<{ success: boolean; error?: string }>;
    generateSentence: (
      text: string,
      sentenceIndex: number,
      settings: PlaySettings
    ) => Promise<{ success: boolean; data?: PlayAudioChunk; error?: string }>;
    stop: () => Promise<{ success: boolean; error?: string }>;
    endSession: () => Promise<{ success: boolean; error?: string }>;
    isSessionActive: () => Promise<{ success: boolean; data?: { active: boolean }; error?: string }>;
    getVoices: () => Promise<{ success: boolean; data?: { voices: string[] }; error?: string }>;
    onAudioGenerated: (callback: (event: PlayAudioGeneratedEvent) => void) => () => void;
    onStatus: (callback: (status: { message: string }) => void) => () => void;
    onSessionEnded: (callback: (data: { code: number }) => void) => () => void;
  };
  parallelTts: {
    detectRecommendedWorkerCount: () => Promise<{ success: boolean; data?: HardwareRecommendation; error?: string }>;
    startConversion: (jobId: string, config: ParallelConversionConfig) => Promise<{ success: boolean; data?: ParallelConversionResult; error?: string }>;
    stopConversion: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    getProgress: (jobId: string) => Promise<{ success: boolean; data?: ParallelAggregatedProgress | null; error?: string }>;
    isActive: (jobId: string) => Promise<{ success: boolean; data?: boolean; error?: string }>;
    listActive: () => Promise<{ success: boolean; data?: Array<{ jobId: string; progress: ParallelAggregatedProgress; epubPath: string; startTime: number }>; error?: string }>;
    onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => () => void;
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string } }) => void) => () => void;
    onSessionCreated: (callback: (data: { jobId: string; sessionId: string; sessionDir: string; processDir: string; totalSentences: number; totalChapters: number }) => void) => () => void;
    // Resume support
    checkResumeFast: (epubPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
    checkResume: (sessionPath: string) => Promise<{ success: boolean; data?: ResumeCheckResult; error?: string }>;
    resumeConversion: (jobId: string, config: ParallelConversionConfig, resumeInfo: ResumeCheckResult) => Promise<{ success: boolean; data?: ParallelConversionResult; error?: string }>;
    buildResumeInfo: (prepInfo: any, settings: any) => Promise<{ success: boolean; data?: TtsResumeInfo; error?: string }>;
  };
  sessionCache: {
    save: (sessionDir: string, projectDir: string, language: string) => Promise<{ success: boolean; cachedPath?: string; error?: string }>;
    list: (projectDir: string) => Promise<{ success: boolean; data?: Array<{ language: string; sessionDir: string; sentenceCount: number; createdAt: string }>; error?: string }>;
    restore: (projectDir: string, language: string) => Promise<{ success: boolean; sessionDir?: string; error?: string }>;
  };
  bilingualAssembly: {
    run: (jobId: string, config: {
      projectId: string;
      sourceSentencesDir: string;
      targetSentencesDir: string;
      sentencePairsPath: string;
      outputDir: string;
      pauseDuration?: number;
      gapDuration?: number;
      audioFormat?: string;
    }) => Promise<{ success: boolean; data?: { success: boolean; audioPath?: string; vttPath?: string; error?: string }; error?: string }>;
    onProgress: (callback: (data: { jobId: string; progress: { phase: string; percentage: number; message: string } }) => void) => () => void;
    onComplete: (callback: (data: { jobId: string; success: boolean; audioPath?: string; vttPath?: string; error?: string }) => void) => () => void;
  };
  reassembly: {
    scanSessions: (customTmpPath?: string) => Promise<{ success: boolean; data?: E2aSessionScanResult; error?: string }>;
    getSession: (sessionId: string, customTmpPath?: string) => Promise<{ success: boolean; data?: E2aSession; error?: string }>;
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
    onProgress: (callback: (data: { jobId: string; progress: ReassemblyProgress }) => void) => () => void;
  };
  deepfilter: {
    checkAvailable: () => Promise<{ success: boolean; data?: { available: boolean; error?: string }; error?: string }>;
    listFiles: (audiobooksDir: string) => Promise<{ success: boolean; data?: AudioFileInfo[]; error?: string }>;
    denoise: (filePath: string) => Promise<{ success: boolean; data?: { success: boolean; outputPath?: string; error?: string }; error?: string }>;
    cancel: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    onProgress: (callback: (progress: DenoiseProgress) => void) => () => void;
  };
  resemble: {
    checkAvailable: () => Promise<{ success: boolean; data?: { available: boolean; device?: string; usingWsl?: boolean; error?: string }; error?: string }>;
    listFiles: (audiobooksDir: string) => Promise<{ success: boolean; data?: AudioFileInfo[]; error?: string }>;
    pickFiles: () => Promise<{ success: boolean; data?: AudioFileInfo[]; error?: string }>;
    enhance: (filePath: string) => Promise<{ success: boolean; data?: { success: boolean; outputPath?: string; error?: string }; error?: string }>;
    cancel: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
    onProgress: (callback: (progress: EnhanceProgress) => void) => () => void;
    // Queue-based enhancement
    runForQueue: (jobId: string, config: {
      inputPath: string;
      outputPath?: string;
      projectId?: string;
      bfpPath?: string;
      replaceOriginal?: boolean;
    }) => Promise<{ success: boolean; data?: { success: boolean; outputPath?: string; error?: string }; error?: string }>;
  };
  chapterRecovery: {
    detectChapters: (epubPath: string, vttPath: string) => Promise<{
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
  };
  debug: {
    log: (message: string) => Promise<void>;
    saveLogs: (content: string, filename: string) => Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }>;
  };
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
      error?: string;
    }>;
    saveProject: (project: LanguageLearningProject) => Promise<{
      success: boolean;
      error?: string;
    }>;
    loadProject: (projectId: string) => Promise<{
      success: boolean;
      project?: LanguageLearningProject;
      error?: string;
    }>;
    listProjects: () => Promise<{
      success: boolean;
      projects?: LanguageLearningProject[];
      error?: string;
    }>;
    deleteProject: (projectId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    updateProject: (projectId: string, updates: any) => Promise<{
      success: boolean;
      error?: string;
    }>;
    confirmDelete: (title: string) => Promise<{
      confirmed: boolean;
    }>;
    ensureDirectory: (dirPath: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    deleteAudiobooks: (projectId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    listCompleted: () => Promise<{
      success: boolean;
      audiobooks?: CompletedAudiobook[];
      error?: string;
    }>;
    extractText: (htmlPath: string, deletedSelectors: string[]) => Promise<{
      success: boolean;
      text?: string;
      error?: string;
    }>;
    writeFile: (filePath: string, content: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    finalizeContent: (projectId: string, finalizedHtml: string) => Promise<{
      success: boolean;
      epubPath?: string;
      error?: string;
    }>;
    getAudioPath: (projectId: string) => Promise<{
      success: boolean;
      path?: string;
      error?: string;
    }>;
    getAudioData: (projectId: string) => Promise<{
      success: boolean;
      dataUrl?: string;
      size?: number;
      error?: string;
    }>;
    hasAudio: (projectId: string) => Promise<{
      success: boolean;
      hasAudio?: boolean;
      error?: string;
    }>;
    deleteAudio: (projectId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    readVtt: (projectId: string) => Promise<{
      success: boolean;
      content?: string;
      error?: string;
    }>;
    readSentencePairs: (projectId: string) => Promise<{
      success: boolean;
      pairs?: Array<{
        index: number;
        source: string;
        target: string;
        sourceTimestamp?: number;
        targetTimestamp?: number;
      }>;
      error?: string;
    }>;
    getAnalytics: (projectId: string) => Promise<{
      success: boolean;
      analytics?: any;
      error?: string;
    }>;
    saveAnalytics: (projectId: string, analytics: any) => Promise<{
      success: boolean;
      error?: string;
    }>;
    runJob: (jobId: string, config: {
      projectId: string;
      sourceUrl: string;
      sourceLang: string;
      targetLang: string;
      htmlPath: string;
      pdfPath?: string;
      deletedBlockIds: string[];
      title?: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      aiModel: string;
      ollamaBaseUrl?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
      // AI prompt settings
      translationPrompt?: string;
      enableCleanup?: boolean;
      cleanupPrompt?: string;
      // TTS settings
      sourceVoice: string;
      targetVoice: string;
      ttsEngine: 'xtts' | 'orpheus';
      sourceTtsSpeed: number;
      targetTtsSpeed: number;
      device: 'gpu' | 'mps' | 'cpu';
      workerCount?: number;
    }) => Promise<{
      success: boolean;
      data?: {
        epubPath?: string;
        sentencePairsPath?: string;
        ttsConfig?: {
          outputDir: string;
          outputFilename: string;
          title: string;
          ttsEngine: 'xtts' | 'orpheus';
          voice: string;
          device: 'gpu' | 'mps' | 'cpu';
          speed: number;
          workerCount: number;
          language: string;
        };
      };
      error?: string;
    }>;
    onProgress: (callback: (data: { jobId: string; progress: {
      phase: string;
      currentSentence: number;
      totalSentences: number;
      percentage: number;
      message: string;
    }}) => void) => () => void;
  };
  bilingualCleanup: {
    run: (jobId: string, config: {
      projectId: string;
      projectDir: string;
      sourceEpubPath?: string;
      sourceLang: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      aiModel: string;
      ollamaBaseUrl?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
      cleanupPrompt?: string;
      simplifyForLearning?: boolean;
      startFresh?: boolean;
      testMode?: boolean;
      testModeChunks?: number;
    }) => Promise<{
      success: boolean;
      outputPath?: string;
      error?: string;
      nextJobConfig?: { cleanedEpubPath?: string };
    }>;
    onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
  };
  bilingualTranslation: {
    run: (jobId: string, config: {
      projectId?: string;
      projectDir?: string;
      cleanedEpubPath?: string;
      sourceLang: string;
      targetLang: string;
      title?: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      aiModel: string;
      ollamaBaseUrl?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
      translationPrompt?: string;
      monoTranslation?: boolean;  // Full book translation (not bilingual interleave)
      testMode?: boolean;
      testModeChunks?: number;
    }) => Promise<{
      success: boolean;
      outputPath?: string;
      translatedEpubPath?: string;  // For mono translation, path to translated EPUB
      error?: string;
      nextJobConfig?: { sourceEpubPath?: string; targetEpubPath?: string; sentencePairsPath?: string };
    }>;
    onProgress: (callback: (data: { jobId: string; progress: any }) => void) => () => void;
  };
  alignment: {
    getData: () => Promise<{
      pairs: Array<{ index: number; source: string; target: string }>;
      sourceLang: string;
      targetLang: string;
      blocking: boolean;
      projectId: string;
      jobId: string;
    } | null>;
    userInteracted: () => Promise<{ success: boolean }>;
    saveResult: (result: {
      approved: boolean;
      pairs: Array<{ index: number; source: string; target: string }>;
      cancelled?: boolean;
    }) => Promise<{ success: boolean }>;
    cancel: () => Promise<{ success: boolean }>;
  };
  sentenceCache: {
    list: (audiobookFolder: string) => Promise<{
      success: boolean;
      languages: Array<{
        code: string;
        name: string;
        sentenceCount: number;
        sourceLanguage: string | null;
        createdAt: string;
        hasAudio: boolean;
        ttsSettings?: {
          engine: 'xtts' | 'orpheus';
          voice: string;
          speed: number;
          temperature?: number;
          topP?: number;
        };
      }>;
      error?: string;
    }>;
    get: (audiobookFolder: string, language: string) => Promise<{
      success: boolean;
      cache?: {
        language: string;
        sourceLanguage: string | null;
        createdAt: string;
        sentenceCount: number;
        sentences: string[] | Array<{ source: string; target: string }>;
        hasAudio?: boolean;
        audioDir?: string;
        ttsSettings?: {
          engine: 'xtts' | 'orpheus';
          voice: string;
          speed: number;
          temperature?: number;
          topP?: number;
        };
      };
      error?: string;
    }>;
    save: (audiobookFolder: string, language: string, data: {
      language: string;
      sourceLanguage: string | null;
      sentences: string[] | Array<{ source: string; target: string }>;
      hasAudio?: boolean;
      audioDir?: string;
      ttsSettings?: {
        engine: 'xtts' | 'orpheus';
        voice: string;
        speed: number;
        temperature?: number;
        topP?: number;
      };
    }) => Promise<{ success: boolean; error?: string }>;
    clear: (audiobookFolder: string, languages?: string[]) => Promise<{
      success: boolean;
      cleared: string[];
      error?: string;
    }>;
    runTts: (config: {
      audiobookFolder: string;
      language: string;
      ttsConfig: {
        engine: 'xtts' | 'orpheus';
        voice: string;
        speed: number;
        device: 'cpu' | 'mps' | 'gpu';
        workers: number;
      };
    }) => Promise<{
      success: boolean;
      jobId?: string;
      message?: string;
      sentencesDir?: string;
      error?: string;
    }>;
    cacheAudio: (config: {
      audiobookFolder: string;
      language: string;
      sentencesDir: string;
      ttsSettings: {
        engine: 'xtts' | 'orpheus';
        voice: string;
        speed: number;
      };
    }) => Promise<{
      success: boolean;
      audioDir?: string;
      fileCount?: number;
      error?: string;
    }>;
    runAssembly: (config: {
      audiobookFolder: string;
      languages: string[];
      pattern: 'interleaved' | 'sequential';
      pauseBetweenLanguages: number;
      outputFormat: 'm4b' | 'mp3';
    }) => Promise<{
      success: boolean;
      audioPath?: string;
      vttPath?: string;
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
    save: (manifest: Record<string, unknown>) => Promise<{
      success: boolean;
      manifestPath?: string;
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
    list: (filter?: { type?: 'book' | 'article' }) => Promise<{
      success: boolean;
      projects?: Record<string, unknown>[];
      error?: string;
    }>;
    listSummaries: (filter?: { type?: 'book' | 'article' }) => Promise<{
      success: boolean;
      summaries?: Record<string, unknown>[];
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
  editor: {
    openWindow: (projectPath: string) => Promise<{ success: boolean; alreadyOpen?: boolean; error?: string }>;
    openWindowWithBfp: (bfpPath: string, sourcePath: string) => Promise<{ success: boolean; alreadyOpen?: boolean; error?: string }>;
    closeWindow: (projectPath: string) => Promise<{ success: boolean }>;
    getVersions: (bfpPath: string) => Promise<{
      success: boolean;
      error?: string;
      versions?: Array<{
        id: string;
        type: string;
        label: string;
        description: string;
        path: string;
        extension: string;
        language?: string;
        modifiedAt?: string;
        fileSize?: number;
        editable: boolean;
        icon: string;
      }>;
    }>;
    onWindowClosed: (callback: (projectPath: string) => void) => void;
    offWindowClosed: () => void;
    saveEpubToPath: (epubPath: string, epubData: ArrayBuffer) => Promise<{ success: boolean; error?: string }>;
  };
  platform: string;
}

const electronAPI: ElectronAPI = {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) =>
      ipcRenderer.invoke('pdf:analyze', pdfPath, maxPages),
    renderPage: (pageNum: number, scale: number = 2.0, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>, removeBackground?: boolean) =>
      ipcRenderer.invoke('pdf:render-page', pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground),
    renderBlankPage: (pageNum: number, scale: number = 2.0) =>
      ipcRenderer.invoke('pdf:render-blank-page', pageNum, scale),
    renderAllPages: (pdfPath: string, scale: number = 2.0, concurrency: number = 4) =>
      ipcRenderer.invoke('pdf:render-all-pages', pdfPath, scale, concurrency),
    renderWithPreviews: (pdfPath: string, concurrency: number = 4) =>
      ipcRenderer.invoke('pdf:render-with-previews', pdfPath, concurrency),
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
    updateSpansForOcr: (pageNum: number, ocrBlocks: Array<{ x: number; y: number; width: number; height: number; text: string; font_size: number; id?: string }>) =>
      ipcRenderer.invoke('pdf:update-spans-for-ocr', pageNum, ocrBlocks),
    // Chapter detection
    extractOutline: () =>
      ipcRenderer.invoke('pdf:extract-outline'),
    outlineToChapters: (outline: OutlineItem[]) =>
      ipcRenderer.invoke('pdf:outline-to-chapters', outline),
    detectChapters: () =>
      ipcRenderer.invoke('pdf:detect-chapters'),
    addBookmarks: (pdfBase64: string, chapters: Chapter[]) =>
      ipcRenderer.invoke('pdf:add-bookmarks', pdfBase64, chapters),
    assembleFromImages: (pages: Array<{ pageNum: number; imageData: string; width: number; height: number }>, chapters?: Chapter[]) =>
      ipcRenderer.invoke('pdf:assemble-from-images', pages, chapters),
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
    writeText: (filePath: string, content: string) =>
      ipcRenderer.invoke('fs:write-text', filePath, content),
    writeTempFile: (filename: string, data: Uint8Array) =>
      ipcRenderer.invoke('fs:write-temp-file', filename, data),
    listDirectory: (dirPath: string) =>
      ipcRenderer.invoke('fs:list-directory', dirPath),
  },
  project: {
    save: (projectData: unknown, suggestedName?: string) =>
      ipcRenderer.invoke('project:save', projectData, suggestedName),
    load: () =>
      ipcRenderer.invoke('project:load'),
    saveToPath: (filePath: string, projectData: unknown) =>
      ipcRenderer.invoke('project:save-to-path', filePath, projectData),
    updateMetadata: (bfpPath: string, metadata: unknown) =>
      ipcRenderer.invoke('project:update-metadata', bfpPath, metadata),
  },
  dialog: {
    openPdf: () =>
      ipcRenderer.invoke('dialog:open-pdf'),
    openFolder: () =>
      ipcRenderer.invoke('dialog:open-folder'),
    openAudio: () =>
      ipcRenderer.invoke('dialog:open-audio'),
    saveEpub: (defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-epub', defaultName),
    saveText: (defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-text', defaultName),
    confirm: (options: {
      title: string;
      message: string;
      detail?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      type?: 'none' | 'info' | 'error' | 'question' | 'warning';
    }) =>
      ipcRenderer.invoke('dialog:confirm', options),
  },
  projects: {
    ensureFolder: () =>
      ipcRenderer.invoke('projects:ensure-folder'),
    getFolder: () =>
      ipcRenderer.invoke('projects:get-folder'),
    list: () =>
      ipcRenderer.invoke('projects:list'),
    save: (projectData: unknown, name: string) =>
      ipcRenderer.invoke('projects:save', projectData, name),
    delete: (filePaths: string[]) =>
      ipcRenderer.invoke('projects:delete', filePaths),
    import: () =>
      ipcRenderer.invoke('projects:import'),
    export: (projectPath: string) =>
      ipcRenderer.invoke('projects:export', projectPath),
    loadFromPath: (filePath: string) =>
      ipcRenderer.invoke('projects:load-from-path', filePath),
    finalize: (bfpPath: string) =>
      ipcRenderer.invoke('projects:finalize', bfpPath),
    migrateAll: () =>
      ipcRenderer.invoke('projects:migrate-all'),
  },
  library: {
    importFile: (sourcePath: string) =>
      ipcRenderer.invoke('library:import-file', sourcePath),
    resolveSource: (options: { libraryPath?: string; sourcePath?: string; fileHash?: string; sourceName?: string }) =>
      ipcRenderer.invoke('library:resolve-source', options),
    copyToQueue: (data: ArrayBuffer | string, filename: string, metadata?: { title?: string; author?: string; language?: string }) =>
      ipcRenderer.invoke('library:copy-to-queue', data, filename, metadata),
    listQueue: () =>
      ipcRenderer.invoke('library:list-queue'),
    getAudiobooksPath: () =>
      ipcRenderer.invoke('library:get-audiobooks-path'),
    listCompleted: (folderPath?: string) =>
      ipcRenderer.invoke('library:list-completed', folderPath),
    saveMetadata: (epubPath: string, metadata: EpubMetadata) =>
      ipcRenderer.invoke('library:save-metadata', epubPath, metadata),
    loadMetadata: (epubPath: string) =>
      ipcRenderer.invoke('library:load-metadata', epubPath),
    loadCoverImage: (projectId: string, coverFilename: string) =>
      ipcRenderer.invoke('library:load-cover-image', projectId, coverFilename),
    loadDeletedExamplesFromBfp: (epubPath: string) =>
      ipcRenderer.invoke('library:load-deleted-examples-from-bfp', epubPath),
    setRoot: (libraryPath: string | null) =>
      ipcRenderer.invoke('library:set-root', libraryPath),
    getRoot: () =>
      ipcRenderer.invoke('library:get-root'),
  },
  media: {
    saveImage: (base64Data: string, prefix?: string) =>
      ipcRenderer.invoke('media:save-image', base64Data, prefix),
    loadImage: (relativePath: string) =>
      ipcRenderer.invoke('media:load-image', relativePath),
  },
  audiobook: {
    createProject: (sourcePath: string, originalFilename: string) =>
      ipcRenderer.invoke('audiobook:create-project', sourcePath, originalFilename),
    listProjects: () =>
      ipcRenderer.invoke('audiobook:list-projects'),
    getProject: (projectId: string) =>
      ipcRenderer.invoke('audiobook:get-project', projectId),
    saveProject: (projectId: string, updates: { metadata?: any; state?: any }) =>
      ipcRenderer.invoke('audiobook:save-project', projectId, updates),
    deleteProject: (projectId: string) =>
      ipcRenderer.invoke('audiobook:delete-project', projectId),
    getPaths: (projectId: string) =>
      ipcRenderer.invoke('audiobook:get-paths', projectId),
    // Unified audiobook export (saves to BFP project folder)
    exportFromProject: (bfpPath: string, epubData: ArrayBuffer, deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>) =>
      ipcRenderer.invoke('audiobook:export-from-project', bfpPath, epubData, deletedBlockExamples),
    // Import EPUB directly (creates BFP + audiobook folder)
    importEpub: (epubSourcePath: string) =>
      ipcRenderer.invoke('audiobook:import-epub', epubSourcePath),
    updateState: (bfpPath: string, audiobookState: Record<string, unknown>) =>
      ipcRenderer.invoke('audiobook:update-state', bfpPath, audiobookState),
    appendAnalytics: (bfpPath: string, jobType: 'tts-conversion' | 'ocr-cleanup', analytics: { jobId: string; [key: string]: unknown }) =>
      ipcRenderer.invoke('audiobook:append-analytics', bfpPath, jobType, analytics),
    copyVtt: (bfpPath: string, m4bOutputPath: string) =>
      ipcRenderer.invoke('audiobook:copy-vtt', bfpPath, m4bOutputPath),
    getFolder: (bfpPath: string) =>
      ipcRenderer.invoke('audiobook:get-folder', bfpPath),
    listProjectsWithAudiobook: () =>
      ipcRenderer.invoke('audiobook:list-projects-with-audiobook'),
    linkAudio: (bfpPath: string, audioPath: string) =>
      ipcRenderer.invoke('audiobook:link-audio', bfpPath, audioPath),
    linkBilingualAudio: (bfpPath: string, audioPath: string, vttPath?: string) =>
      ipcRenderer.invoke('audiobook:link-bilingual-audio', bfpPath, audioPath, vttPath),
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
  },
  ai: {
    checkConnection: () =>
      ipcRenderer.invoke('ai:check-connection'),
    checkProviderConnection: (provider: 'ollama' | 'claude' | 'openai') =>
      ipcRenderer.invoke('ai:check-provider-connection', provider),
    getModels: () =>
      ipcRenderer.invoke('ai:get-models'),
    getClaudeModels: (apiKey: string) =>
      ipcRenderer.invoke('ai:get-claude-models', apiKey),
    getOpenAIModels: (apiKey: string) =>
      ipcRenderer.invoke('ai:get-openai-models', apiKey),
    loadSkippedChunks: (jsonPath: string) =>
      ipcRenderer.invoke('ai:load-skipped-chunks', jsonPath),
    replaceTextInEpub: (epubPath: string, oldText: string, newText: string) =>
      ipcRenderer.invoke('ai:replace-text-in-epub', epubPath, oldText, newText),
    updateSkippedChunk: (jsonPath: string, index: number, newText: string) =>
      ipcRenderer.invoke('ai:update-skipped-chunk', jsonPath, index, newText),
    cleanupChapter: (
      text: string,
      options: AICleanupOptions,
      chapterId: string,
      chapterTitle: string,
      model?: string
    ) =>
      ipcRenderer.invoke('ai:cleanup-chapter', text, options, chapterId, chapterTitle, model),
    onCleanupProgress: (callback: (progress: CleanupProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: CleanupProgress) => {
        callback(progress);
      };
      ipcRenderer.on('ai:cleanup-progress', listener);
      return () => {
        ipcRenderer.removeListener('ai:cleanup-progress', listener);
      };
    },
    getPrompt: () =>
      ipcRenderer.invoke('ai:get-prompt'),
    savePrompt: (prompt: string) =>
      ipcRenderer.invoke('ai:save-prompt', prompt),
  },
  shell: {
    openExternal: (url: string) =>
      ipcRenderer.invoke('shell:open-external', url),
    showItemInFolder: (filePath: string) =>
      ipcRenderer.invoke('shell:show-item-in-folder', filePath),
    openPath: (filePath: string) =>
      ipcRenderer.invoke('shell:open-path', filePath),
  },
  libraryServer: {
    start: (config: LibraryServerConfig) =>
      ipcRenderer.invoke('library-server:start', config),
    stop: () =>
      ipcRenderer.invoke('library-server:stop'),
    getStatus: () =>
      ipcRenderer.invoke('library-server:status'),
  },
  e2a: {
    configurePaths: (config: { e2aPath?: string; condaPath?: string }) =>
      ipcRenderer.invoke('e2a:configure-paths', config),
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
    checkOrpheusSetup: (config: { distro?: string; condaPath?: string; e2aPath?: string }) =>
      ipcRenderer.invoke('wsl:check-orpheus-setup', config),
  },
  tts: {
    checkAvailable: () =>
      ipcRenderer.invoke('tts:check-available'),
    getVoices: () =>
      ipcRenderer.invoke('tts:get-voices'),
    startConversion: (
      epubPath: string,
      outputDir: string,
      settings: TTSSettings
    ) =>
      ipcRenderer.invoke('tts:start-conversion', epubPath, outputDir, settings),
    stopConversion: () =>
      ipcRenderer.invoke('tts:stop-conversion'),
    generateFilename: (
      title: string,
      subtitle?: string,
      author?: string,
      authorFileAs?: string,
      year?: string
    ) =>
      ipcRenderer.invoke('tts:generate-filename', title, subtitle, author, authorFileAs, year),
    onProgress: (callback: (progress: TTSProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: TTSProgress) => {
        callback(progress);
      };
      ipcRenderer.on('tts:progress', listener);
      return () => {
        ipcRenderer.removeListener('tts:progress', listener);
      };
    },
  },
  ocr: {
    isAvailable: () =>
      ipcRenderer.invoke('ocr:is-available'),
    getLanguages: () =>
      ipcRenderer.invoke('ocr:get-languages'),
    recognize: (imageData: string) =>
      ipcRenderer.invoke('ocr:recognize', imageData),
    detectSkew: (imageData: string) =>
      ipcRenderer.invoke('ocr:detect-skew', imageData),
    processPdfHeadless: (pdfPath: string, options: {
      engine: 'tesseract' | 'surya';
      language?: string;
      pages?: number[];
    }) =>
      ipcRenderer.invoke('ocr:process-pdf-headless', pdfPath, options),
    onHeadlessProgress: (callback: (data: { current: number; total: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { current: number; total: number }) => {
        callback(data);
      };
      ipcRenderer.on('ocr:headless-progress', listener);
      return () => {
        ipcRenderer.removeListener('ocr:headless-progress', listener);
      };
    },
  },
  window: {
    hide: () =>
      ipcRenderer.invoke('window:hide'),
    close: () =>
      ipcRenderer.invoke('window:close'),
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
    runOcrCleanup: (jobId: string, epubPath: string, model?: string, aiConfig?: AIProviderConfig & {
      useDetailedCleanup?: boolean;
      deletedBlockExamples?: Array<{ text: string; category: string; page?: number }>;
      useParallel?: boolean;
      parallelWorkers?: number;
      cleanupMode?: 'structure' | 'full';
      testMode?: boolean;
      enableAiCleanup?: boolean;
      simplifyForChildren?: boolean;
    }) =>
      ipcRenderer.invoke('queue:run-ocr-cleanup', jobId, epubPath, model, aiConfig),
    runTtsConversion: (jobId: string, epubPath: string, config: TtsJobConfig) =>
      ipcRenderer.invoke('queue:run-tts-conversion', jobId, epubPath, config),
    runTranslation: (jobId: string, epubPath: string, translationConfig: {
      chunkSize?: number;
    }, aiConfig?: AIProviderConfig) =>
      ipcRenderer.invoke('queue:run-translation', jobId, epubPath, translationConfig, aiConfig),
    cancelJob: (jobId: string) =>
      ipcRenderer.invoke('queue:cancel-job', jobId),
    saveState: (queueState: string) =>
      ipcRenderer.invoke('queue:save-state', queueState),
    loadState: () =>
      ipcRenderer.invoke('queue:load-state'),
    onProgress: (callback: (progress: QueueProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: QueueProgress) => {
        callback(progress);
      };
      ipcRenderer.on('queue:progress', listener);
      return () => {
        ipcRenderer.removeListener('queue:progress', listener);
      };
    },
    onComplete: (callback: (result: QueueJobResult) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, result: QueueJobResult) => {
        callback(result);
      };
      ipcRenderer.on('queue:job-complete', listener);
      return () => {
        ipcRenderer.removeListener('queue:job-complete', listener);
      };
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
    // Compute diff using system diff command (efficient, runs in main process)
    computeSystemDiff: (originalText: string, cleanedText: string) =>
      ipcRenderer.invoke('diff:compute-system-diff', originalText, cleanedText),
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
  },
  play: {
    startSession: () =>
      ipcRenderer.invoke('play:start-session'),
    loadVoice: (voice: string) =>
      ipcRenderer.invoke('play:load-voice', voice),
    generateSentence: (
      text: string,
      sentenceIndex: number,
      settings: PlaySettings
    ) =>
      ipcRenderer.invoke('play:generate-sentence', text, sentenceIndex, settings),
    stop: () =>
      ipcRenderer.invoke('play:stop'),
    endSession: () =>
      ipcRenderer.invoke('play:end-session'),
    isSessionActive: () =>
      ipcRenderer.invoke('play:is-session-active'),
    getVoices: () =>
      ipcRenderer.invoke('play:get-voices'),
    onAudioGenerated: (callback: (event: PlayAudioGeneratedEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: PlayAudioGeneratedEvent) => {
        callback(data);
      };
      ipcRenderer.on('play:audio-generated', listener);
      return () => {
        ipcRenderer.removeListener('play:audio-generated', listener);
      };
    },
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
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string } }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number; analytics?: any; wasStopped?: boolean; stopInfo?: { sessionId?: string; sessionDir?: string; processDir?: string; completedSentences?: number; totalSentences?: number; stoppedAt?: string } }) => {
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
    checkResumeFast: (epubPath: string) =>
      ipcRenderer.invoke('parallel-tts:check-resume-fast', epubPath),
    checkResume: (sessionPath: string) =>
      ipcRenderer.invoke('parallel-tts:check-resume', sessionPath),
    resumeConversion: (jobId: string, config: ParallelConversionConfig, resumeInfo: ResumeCheckResult) =>
      ipcRenderer.invoke('parallel-tts:resume-conversion', jobId, config, resumeInfo),
    buildResumeInfo: (prepInfo: any, settings: any) =>
      ipcRenderer.invoke('parallel-tts:build-resume-info', prepInfo, settings),
  },
  sessionCache: {
    // Save a TTS session to project folder for later assembly
    save: (sessionDir: string, projectDir: string, language: string) =>
      ipcRenderer.invoke('session-cache:save', sessionDir, projectDir, language),
    // List available sessions in a project
    list: (projectDir: string) =>
      ipcRenderer.invoke('session-cache:list', projectDir) as Promise<{
        success: boolean;
        data?: Array<{ language: string; sessionDir: string; sentenceCount: number; createdAt: string }>;
        error?: string;
      }>,
    // Restore a cached session from project folder to e2a tmp
    restore: (projectDir: string, language: string) =>
      ipcRenderer.invoke('session-cache:restore', projectDir, language) as Promise<{
        success: boolean;
        sessionDir?: string;
        error?: string;
      }>,
  },
  bilingualAssembly: {
    run: (jobId: string, config: {
      projectId: string;
      sourceSentencesDir: string;
      targetSentencesDir: string;
      sentencePairsPath: string;
      outputDir: string;
      pauseDuration?: number;
      gapDuration?: number;
      audioFormat?: string;
      // Output naming with language suffix
      outputName?: string;
      title?: string;
      sourceLang?: string;
      targetLang?: string;
      bfpPath?: string;
    }) =>
      ipcRenderer.invoke('bilingual-assembly:run', jobId, config),
    onProgress: (callback: (data: { jobId: string; progress: { phase: string; percentage: number; message: string } }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: { phase: string; percentage: number; message: string } }) => {
        callback(data);
      };
      ipcRenderer.on('bilingual-assembly:progress', listener);
      return () => {
        ipcRenderer.removeListener('bilingual-assembly:progress', listener);
      };
    },
    onComplete: (callback: (data: { jobId: string; success: boolean; audioPath?: string; vttPath?: string; error?: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; success: boolean; audioPath?: string; vttPath?: string; error?: string }) => {
        callback(data);
      };
      ipcRenderer.on('bilingual-assembly:complete', listener);
      return () => {
        ipcRenderer.removeListener('bilingual-assembly:complete', listener);
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
  deepfilter: {
    checkAvailable: () =>
      ipcRenderer.invoke('deepfilter:check-available'),
    listFiles: (audiobooksDir: string) =>
      ipcRenderer.invoke('deepfilter:list-files', audiobooksDir),
    denoise: (filePath: string) =>
      ipcRenderer.invoke('deepfilter:denoise', filePath),
    cancel: () =>
      ipcRenderer.invoke('deepfilter:cancel'),
    onProgress: (callback: (progress: DenoiseProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: DenoiseProgress) => {
        callback(progress);
      };
      ipcRenderer.on('deepfilter:progress', listener);
      return () => {
        ipcRenderer.removeListener('deepfilter:progress', listener);
      };
    },
  },
  resemble: {
    checkAvailable: () =>
      ipcRenderer.invoke('resemble:check-available'),
    listFiles: (audiobooksDir: string) =>
      ipcRenderer.invoke('resemble:list-files', audiobooksDir),
    pickFiles: () =>
      ipcRenderer.invoke('resemble:pick-files'),
    enhance: (filePath: string) =>
      ipcRenderer.invoke('resemble:enhance', filePath),
    cancel: () =>
      ipcRenderer.invoke('resemble:cancel'),
    onProgress: (callback: (progress: EnhanceProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: EnhanceProgress) => {
        callback(progress);
      };
      ipcRenderer.on('resemble:progress', listener);
      return () => {
        ipcRenderer.removeListener('resemble:progress', listener);
      };
    },
    // Queue-based enhancement
    runForQueue: (jobId: string, config: {
      inputPath: string;
      outputPath?: string;
      projectId?: string;
      bfpPath?: string;
      replaceOriginal?: boolean;
    }) =>
      ipcRenderer.invoke('queue:run-resemble-enhance', jobId, config),
  },
  chapterRecovery: {
    detectChapters: (epubPath: string, vttPath: string) =>
      ipcRenderer.invoke('chapter-recovery:detect-chapters', epubPath, vttPath),
    applyChapters: (m4bPath: string, chapters: Array<{ title: string; timestamp: string }>) =>
      ipcRenderer.invoke('chapter-recovery:apply-chapters', m4bPath, chapters),
  },
  debug: {
    log: (message: string) =>
      ipcRenderer.invoke('debug:log', message),
    saveLogs: (content: string, filename: string) =>
      ipcRenderer.invoke('debug:save-logs', content, filename),
  },
  languageLearning: {
    fetchUrl: (url: string, projectId?: string) =>
      ipcRenderer.invoke('language-learning:fetch-url', url, projectId),
    saveProject: (project: LanguageLearningProject) =>
      ipcRenderer.invoke('language-learning:save-project', project),
    loadProject: (projectId: string) =>
      ipcRenderer.invoke('language-learning:load-project', projectId),
    listProjects: () =>
      ipcRenderer.invoke('language-learning:list-projects'),
    deleteProject: (projectId: string) =>
      ipcRenderer.invoke('language-learning:delete-project', projectId),
    updateProject: (projectId: string, updates: any) =>
      ipcRenderer.invoke('language-learning:update-project', projectId, updates),
    confirmDelete: (title: string) =>
      ipcRenderer.invoke('language-learning:confirm-delete', title),
    ensureDirectory: (dirPath: string) =>
      ipcRenderer.invoke('language-learning:ensure-directory', dirPath),
    deleteAudiobooks: (projectId: string) =>
      ipcRenderer.invoke('language-learning:delete-audiobooks', projectId),
    listCompleted: () =>
      ipcRenderer.invoke('language-learning:list-completed'),
    extractText: (htmlPath: string, deletedSelectors: string[]) =>
      ipcRenderer.invoke('language-learning:extract-text', htmlPath, deletedSelectors),
    writeFile: (filePath: string, content: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('language-learning:write-file', filePath, content),
    finalizeContent: (projectId: string, finalizedHtml: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('language-learning:finalize-content', projectId, finalizedHtml),
    getAudioPath: (projectId: string) =>
      ipcRenderer.invoke('language-learning:get-audio-path', projectId),
    getAudioData: (projectId: string) =>
      ipcRenderer.invoke('language-learning:get-audio-data', projectId),
    hasAudio: (projectId: string) =>
      ipcRenderer.invoke('language-learning:has-audio', projectId),
    deleteAudio: (projectId: string) =>
      ipcRenderer.invoke('language-learning:delete-audio', projectId),
    readVtt: (projectId: string) =>
      ipcRenderer.invoke('language-learning:read-vtt', projectId),
    readSentencePairs: (projectId: string) =>
      ipcRenderer.invoke('language-learning:read-sentence-pairs', projectId),
    getAnalytics: (projectId: string) =>
      ipcRenderer.invoke('language-learning:get-analytics', projectId),
    saveAnalytics: (projectId: string, analytics: any) =>
      ipcRenderer.invoke('language-learning:save-analytics', projectId, analytics),
    runJob: (jobId: string, config: {
      projectId: string;
      sourceUrl: string;
      sourceLang: string;
      targetLang: string;
      htmlPath: string;
      pdfPath?: string;
      deletedBlockIds: string[];
      title?: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      aiModel: string;
      ollamaBaseUrl?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
      // AI prompt settings
      translationPrompt?: string;
      enableCleanup?: boolean;
      cleanupPrompt?: string;
      // TTS settings
      sourceVoice: string;
      targetVoice: string;
      ttsEngine: 'xtts' | 'orpheus';
      sourceTtsSpeed: number;
      targetTtsSpeed: number;
      device: 'gpu' | 'mps' | 'cpu';
      workerCount?: number;
    }) =>
      ipcRenderer.invoke('language-learning:run-job', jobId, config),
    onProgress: (callback: (data: { jobId: string; progress: {
      phase: string;
      currentSentence: number;
      totalSentences: number;
      percentage: number;
      message: string;
    }}) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: any }) => {
        callback(data);
      };
      ipcRenderer.on('language-learning:progress', listener);
      return () => {
        ipcRenderer.removeListener('language-learning:progress', listener);
      };
    },
  },

  // Bilingual Processing Pipeline Jobs
  bilingualCleanup: {
    run: (jobId: string, config: {
      projectId: string;
      projectDir: string;
      sourceEpubPath?: string;
      sourceLang: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      aiModel: string;
      ollamaBaseUrl?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
      cleanupPrompt?: string;
      simplifyForLearning?: boolean;
      startFresh?: boolean;
      testMode?: boolean;
      testModeChunks?: number;
    }): Promise<{
      success: boolean;
      outputPath?: string;
      error?: string;
      nextJobConfig?: { cleanedEpubPath?: string };
    }> =>
      ipcRenderer.invoke('bilingual-cleanup:run', jobId, config),
    onProgress: (callback: (data: { jobId: string; progress: any }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: any }) => {
        callback(data);
      };
      ipcRenderer.on('ll-job:progress', listener);
      return () => {
        ipcRenderer.removeListener('ll-job:progress', listener);
      };
    },
  },

  bilingualTranslation: {
    run: (jobId: string, config: {
      projectId?: string;
      projectDir?: string;
      cleanedEpubPath?: string;
      sourceLang: string;
      targetLang: string;
      title?: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      aiModel: string;
      ollamaBaseUrl?: string;
      claudeApiKey?: string;
      openaiApiKey?: string;
      translationPrompt?: string;
      monoTranslation?: boolean;
      testMode?: boolean;
      testModeChunks?: number;
    }): Promise<{
      success: boolean;
      outputPath?: string;
      translatedEpubPath?: string;
      error?: string;
      nextJobConfig?: { sourceEpubPath?: string; targetEpubPath?: string; sentencePairsPath?: string };
    }> =>
      ipcRenderer.invoke('bilingual-translation:run', jobId, config),
    onProgress: (callback: (data: { jobId: string; progress: any }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: any }) => {
        callback(data);
      };
      // Uses same progress channel as cleanup
      ipcRenderer.on('ll-job:progress', listener);
      return () => {
        ipcRenderer.removeListener('ll-job:progress', listener);
      };
    },
  },

  // Sentence Alignment Window
  alignment: {
    getData: () => ipcRenderer.invoke('alignment:get-data'),
    userInteracted: () => ipcRenderer.invoke('alignment:user-interacted'),
    saveResult: (result: {
      approved: boolean;
      pairs: Array<{ index: number; source: string; target: string }>;
      cancelled?: boolean;
    }) => ipcRenderer.invoke('alignment:save-result', result),
    cancel: () => ipcRenderer.invoke('alignment:cancel'),
  },

  // Sentence Cache for Bilingual TTS
  sentenceCache: {
    list: (audiobookFolder: string): Promise<{
      success: boolean;
      languages: Array<{
        code: string;
        name: string;
        sentenceCount: number;
        sourceLanguage: string | null;
        createdAt: string;
        hasAudio: boolean;
        ttsSettings?: {
          engine: 'xtts' | 'orpheus';
          voice: string;
          speed: number;
          temperature?: number;
          topP?: number;
        };
      }>;
      error?: string;
    }> => ipcRenderer.invoke('sentence-cache:list', audiobookFolder),

    get: (audiobookFolder: string, language: string): Promise<{
      success: boolean;
      cache?: {
        language: string;
        sourceLanguage: string | null;
        createdAt: string;
        sentenceCount: number;
        sentences: string[] | Array<{ source: string; target: string }>;
        hasAudio?: boolean;
        audioDir?: string;
        ttsSettings?: {
          engine: 'xtts' | 'orpheus';
          voice: string;
          speed: number;
          temperature?: number;
          topP?: number;
        };
      };
      error?: string;
    }> => ipcRenderer.invoke('sentence-cache:get', audiobookFolder, language),

    save: (audiobookFolder: string, language: string, data: {
      language: string;
      sourceLanguage: string | null;
      sentences: string[] | Array<{ source: string; target: string }>;
      hasAudio?: boolean;
      audioDir?: string;
      ttsSettings?: {
        engine: 'xtts' | 'orpheus';
        voice: string;
        speed: number;
        temperature?: number;
        topP?: number;
      };
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('sentence-cache:save', audiobookFolder, language, data),

    clear: (audiobookFolder: string, languages?: string[]): Promise<{
      success: boolean;
      cleared: string[];
      error?: string;
    }> => ipcRenderer.invoke('sentence-cache:clear', audiobookFolder, languages),

    runTts: (config: {
      audiobookFolder: string;
      language: string;
      ttsConfig: {
        engine: 'xtts' | 'orpheus';
        voice: string;
        speed: number;
        device: 'cpu' | 'mps' | 'gpu';
        workers: number;
      };
    }): Promise<{
      success: boolean;
      jobId?: string;
      message?: string;
      sentencesDir?: string;
      error?: string;
    }> => ipcRenderer.invoke('sentence-cache:run-tts', config),

    cacheAudio: (config: {
      audiobookFolder: string;
      language: string;
      sentencesDir: string;
      ttsSettings: {
        engine: 'xtts' | 'orpheus';
        voice: string;
        speed: number;
      };
    }): Promise<{
      success: boolean;
      audioDir?: string;
      fileCount?: number;
      error?: string;
    }> => ipcRenderer.invoke('sentence-cache:cache-audio', config),

    runAssembly: (config: {
      audiobookFolder: string;
      languages: string[];
      pattern: 'interleaved' | 'sequential';
      pauseBetweenLanguages: number;
      outputFormat: 'm4b' | 'mp3';
    }): Promise<{
      success: boolean;
      audioPath?: string;
      vttPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('sentence-cache:run-assembly', config),
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // Manifest Service (Unified Project Management)
  // ─────────────────────────────────────────────────────────────────────────────
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

    // Save (update) a manifest
    save: (manifest: any): Promise<{
      success: boolean;
      manifestPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('manifest:save', manifest),

    // Update specific fields in a manifest
    update: (update: {
      projectId: string;
      source?: any;
      metadata?: any;
      chapters?: any[];
      pipeline?: any;
      outputs?: any;
      editor?: any;
    }): Promise<{
      success: boolean;
      manifestPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('manifest:update', update),

    // List all projects
    list: (filter?: { type?: 'book' | 'article' }): Promise<{
      success: boolean;
      projects?: any[];
      error?: string;
    }> => ipcRenderer.invoke('manifest:list', filter),

    // List project summaries (lightweight)
    listSummaries: (filter?: { type?: 'book' | 'article' }): Promise<{
      success: boolean;
      summaries?: any[];
      error?: string;
    }> => ipcRenderer.invoke('manifest:list-summaries', filter),

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

  editor: {
    openWindow: (projectPath: string) =>
      ipcRenderer.invoke('editor:open-window', projectPath),
    openWindowWithBfp: (bfpPath: string, sourcePath: string) =>
      ipcRenderer.invoke('editor:open-window-with-bfp', bfpPath, sourcePath),
    closeWindow: (projectPath: string) =>
      ipcRenderer.invoke('editor:close-window', projectPath),
    getVersions: (bfpPath: string) =>
      ipcRenderer.invoke('editor:get-versions', bfpPath),
    onWindowClosed: (callback: (projectPath: string) => void) => {
      ipcRenderer.on('editor:window-closed', (_event, projectPath) => callback(projectPath));
    },
    offWindowClosed: () => {
      ipcRenderer.removeAllListeners('editor:window-closed');
    },
    saveEpubToPath: (epubPath: string, epubData: ArrayBuffer) =>
      ipcRenderer.invoke('editor:save-epub', epubPath, epubData),
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('electron', electronAPI);

// Type declaration for renderer
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

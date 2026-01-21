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
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
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

export interface ElectronAPI {
  pdf: {
    analyze: (pdfPath: string, maxPages?: number) => Promise<PdfAnalyzeResult>;
    renderPage: (pageNum: number, scale?: number, pdfPath?: string, redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>, fillRegions?: Array<{ x: number; y: number; width: number; height: number }>, removeBackground?: boolean) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderBlankPage: (pageNum: number, scale?: number) => Promise<{ success: boolean; data?: { image: string }; error?: string }>;
    renderAllPages: (pdfPath: string, scale?: number, concurrency?: number) => Promise<{ success: boolean; data?: { paths: string[] }; error?: string }>;
    renderWithPreviews: (pdfPath: string, concurrency?: number) => Promise<{ success: boolean; data?: RenderWithPreviewsResult; error?: string }>;
    onRenderProgress: (callback: RenderProgressCallback) => () => void;
    onPageUpgraded: (callback: (data: { pageNum: number; path: string }) => void) => () => void;
    onExportProgress: (callback: (progress: { current: number; total: number }) => void) => () => void;
    cleanupTempFiles: () => Promise<{ success: boolean; error?: string }>;
    clearCache: (fileHash: string) => Promise<{ success: boolean; error?: string }>;
    clearAllCache: () => Promise<{ success: boolean; data?: { cleared: number; freedBytes: number }; error?: string }>;
    getCacheSize: (fileHash: string) => Promise<{ success: boolean; data?: { size: number }; error?: string }>;
    getTotalCacheSize: () => Promise<{ success: boolean; data?: { size: number }; error?: string }>;
    exportText: (enabledCategories: string[]) => Promise<{ success: boolean; data?: { text: string; char_count: number }; error?: string }>;
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
  };
  project: {
    save: (projectData: unknown, suggestedName?: string) => Promise<ProjectSaveResult>;
    load: () => Promise<ProjectLoadResult>;
    saveToPath: (filePath: string, projectData: unknown) => Promise<ProjectSaveResult>;
  };
  dialog: {
    openPdf: () => Promise<OpenPdfResult>;
    openFolder: () => Promise<{ success: boolean; canceled?: boolean; folderPath?: string; error?: string }>;
    saveEpub: (defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
    saveText: (defaultName?: string) => Promise<{ success: boolean; canceled?: boolean; filePath?: string; error?: string }>;
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
  };
  library: {
    importFile: (sourcePath: string) => Promise<{
      success: boolean;
      libraryPath?: string;
      hash?: string;
      alreadyExists?: boolean;
      error?: string;
    }>;
    copyToQueue: (data: ArrayBuffer | string, filename: string, metadata?: { title?: string; author?: string; language?: string }) => Promise<{
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
    runOcrCleanup: (jobId: string, epubPath: string, model?: string, aiConfig?: AIProviderConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
    runTtsConversion: (jobId: string, epubPath: string, config: TtsJobConfig) => Promise<{ success: boolean; data?: any; error?: string }>;
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
    onLoadProgress: (callback: (progress: DiffLoadProgress) => void) => () => void;
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
    onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => () => void;
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number }) => void) => () => void;
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
    exists: (filePath: string) =>
      ipcRenderer.invoke('fs:exists', filePath),
    writeText: (filePath: string, content: string) =>
      ipcRenderer.invoke('fs:write-text', filePath, content),
  },
  project: {
    save: (projectData: unknown, suggestedName?: string) =>
      ipcRenderer.invoke('project:save', projectData, suggestedName),
    load: () =>
      ipcRenderer.invoke('project:load'),
    saveToPath: (filePath: string, projectData: unknown) =>
      ipcRenderer.invoke('project:save-to-path', filePath, projectData),
  },
  dialog: {
    openPdf: () =>
      ipcRenderer.invoke('dialog:open-pdf'),
    openFolder: () =>
      ipcRenderer.invoke('dialog:open-folder'),
    saveEpub: (defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-epub', defaultName),
    saveText: (defaultName?: string) =>
      ipcRenderer.invoke('dialog:save-text', defaultName),
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
  },
  library: {
    importFile: (sourcePath: string) =>
      ipcRenderer.invoke('library:import-file', sourcePath),
    copyToQueue: (data: ArrayBuffer | string, filename: string, metadata?: { title?: string; author?: string; language?: string }) =>
      ipcRenderer.invoke('library:copy-to-queue', data, filename, metadata),
    listQueue: () =>
      ipcRenderer.invoke('library:list-queue'),
    getAudiobooksPath: () =>
      ipcRenderer.invoke('library:get-audiobooks-path'),
    saveMetadata: (epubPath: string, metadata: EpubMetadata) =>
      ipcRenderer.invoke('library:save-metadata', epubPath, metadata),
    loadMetadata: (epubPath: string) =>
      ipcRenderer.invoke('library:load-metadata', epubPath),
    loadCoverImage: (projectId: string, coverFilename: string) =>
      ipcRenderer.invoke('library:load-cover-image', projectId, coverFilename),
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
    runOcrCleanup: (jobId: string, epubPath: string, model?: string, aiConfig?: AIProviderConfig) =>
      ipcRenderer.invoke('queue:run-ocr-cleanup', jobId, epubPath, model, aiConfig),
    runTtsConversion: (jobId: string, epubPath: string, config: TtsJobConfig) =>
      ipcRenderer.invoke('queue:run-tts-conversion', jobId, epubPath, config),
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
    loadComparison: (originalPath: string, cleanedPath: string) =>
      ipcRenderer.invoke('diff:load-comparison', originalPath, cleanedPath),
    onLoadProgress: (callback: (progress: DiffLoadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DiffLoadProgress) => callback(progress);
      ipcRenderer.on('diff:load-progress', handler);
      return () => ipcRenderer.removeListener('diff:load-progress', handler);
    },
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
    onProgress: (callback: (data: { jobId: string; progress: ParallelAggregatedProgress }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; progress: ParallelAggregatedProgress }) => {
        callback(data);
      };
      ipcRenderer.on('parallel-tts:progress', listener);
      return () => {
        ipcRenderer.removeListener('parallel-tts:progress', listener);
      };
    },
    onComplete: (callback: (data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { jobId: string; success: boolean; outputPath?: string; error?: string; duration?: number }) => {
        callback(data);
      };
      ipcRenderer.on('parallel-tts:complete', listener);
      return () => {
        ipcRenderer.removeListener('parallel-tts:complete', listener);
      };
    },
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

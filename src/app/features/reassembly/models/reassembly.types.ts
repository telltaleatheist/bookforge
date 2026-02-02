/**
 * Reassembly Types - Type definitions for browsing and reassembling incomplete e2a conversions
 */

// E2A session from tmp folder
export interface E2aSession {
  sessionId: string;
  sessionDir: string;        // Full path to ebook-{uuid} folder
  processDir: string;        // Full path to {hash} subfolder
  metadata: E2aSessionMetadata;
  totalSentences: number;
  completedSentences: number;
  percentComplete: number;
  chapters: E2aChapter[];
  createdAt: string;         // ISO string
  modifiedAt: string;        // ISO string
  bfpPath?: string;          // Path to linked BFP project.json (if found)
}

export interface E2aSessionMetadata {
  title?: string;
  author?: string;
  language?: string;
  epubPath?: string;
  coverPath?: string;  // Path to cover image if available
  // Extended metadata (saved by BookForge)
  year?: string;
  narrator?: string;
  series?: string;
  seriesNumber?: string;
  genre?: string;
  description?: string;
  outputFilename?: string;
}

export interface E2aChapter {
  chapterNum: number;
  title?: string;
  sentenceStart: number;
  sentenceEnd: number;
  sentenceCount: number;
  completedCount: number;
  excluded: boolean;  // User can exclude chapters from reassembly
}

// Configuration for reassembly job
export interface ReassemblyConfig {
  sessionId: string;
  sessionDir: string;
  processDir: string;
  outputDir: string;
  metadata: ReassemblyMetadata;
  excludedChapters: number[];  // Chapter numbers to exclude
}

export interface ReassemblyMetadata {
  title: string;
  author: string;
  year?: string;
  coverPath?: string;
  outputFilename?: string;
  // Additional metadata
  narrator?: string;
  series?: string;
  seriesNumber?: string;
  genre?: string;
  description?: string;
}

// Progress tracking for reassembly
export interface ReassemblyProgress {
  phase: 'preparing' | 'combining' | 'encoding' | 'metadata' | 'complete' | 'error';
  percentage: number;
  currentChapter?: number;
  totalChapters?: number;
  message?: string;
  error?: string;
}

// Result from session scan
export interface E2aSessionScanResult {
  sessions: E2aSession[];
  tmpPath: string;
}

// Session state from session-state.json
export interface E2aSessionState {
  metadata?: {
    title?: string;
    creator?: string;
    language?: string;
  };
  chapters?: Array<{
    chapter_num: number;
    title?: string;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>;
  totalSentences?: number;
  totalChapters?: number;
  epubPath?: string;
}

// Chapter sentences from chapter_sentences.json
export interface ChapterSentencesData {
  chapters: Array<{
    chapter_num: number;
    title?: string;
    sentence_start: number;
    sentence_end: number;
    sentence_count: number;
  }>;
  total_sentences: number;
}

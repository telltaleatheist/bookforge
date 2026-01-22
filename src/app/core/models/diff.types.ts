/**
 * Types for word-level diff comparison between original and AI-cleaned EPUB content
 */

export interface DiffWord {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
}

// Full chapter with text - used when a chapter is loaded
export interface DiffChapter {
  id: string;
  title: string;
  originalText: string;
  cleanedText: string;
  diffWords: DiffWord[];
  changeCount: number;
  loadedChars: number;   // How many chars have been diffed
  totalChars: number;    // Total chars in chapter
}

// Lightweight chapter metadata - no text content (for lazy loading)
export interface DiffChapterMeta {
  id: string;
  title: string;
  hasOriginal: boolean;
  hasCleaned: boolean;
  // These are set after loading
  changeCount?: number;
  isLoaded?: boolean;
  isOversized?: boolean;  // True if chapter exceeds safe size limit
}

// Session with lazy loading support
export interface DiffSession {
  originalPath: string;
  cleanedPath: string;
  chapters: DiffChapter[];  // Only loaded chapters
  chaptersMeta: DiffChapterMeta[];  // All chapter metadata
  currentChapterId: string;
}

// Legacy: used by old loadComparison method
export interface DiffComparisonResult {
  chapters: Array<{
    id: string;
    title: string;
    originalText: string;
    cleanedText: string;
  }>;
}

// Constants for memory protection and performance
export const DIFF_INITIAL_LOAD = 20_000;  // 20k chars initially - fast load
export const DIFF_LOAD_MORE_SIZE = 20_000;  // 20k chars per "Load More" click
export const DIFF_SAFE_CHAR_LIMIT = 50_000;  // 50k chars before showing warning
export const DIFF_HARD_LIMIT = 100_000;  // 100k chars - definitely use pagination

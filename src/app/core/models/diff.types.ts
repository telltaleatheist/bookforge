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

// Constants for memory protection
export const DIFF_SAFE_CHAR_LIMIT = 100_000;  // 100k chars per chapter before warning
export const DIFF_HARD_LIMIT = 500_000;  // 500k chars - show paginated view
export const DIFF_PAGE_SIZE = 50_000;  // 50k chars per page in paginated view

/**
 * Types for word-level diff comparison between original and AI-cleaned EPUB content
 */

export interface DiffWord {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
  /**
   * Set on a removed/added run that a FOOTNOTE REFERENCE MARKER removal produced,
   * and where the proof came from. Carried through hydration so Review Changes can
   * label it even when the marker shared a span with a quote edit.
   */
  fn?: 'archive' | 'inferred';
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

// Compact diff change representation (from pre-computed cache)
export interface DiffChange {
  pos: number;    // Position in cleaned text
  len: number;    // Length in cleaned (0 for deletions)
  add?: string;   // Added text
  rem?: string;   // Removed text
  fn?: 'archive' | 'inferred';  // set when a footnote marker removal produced this change
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
  // Pre-computed cache data (set when loading from .diff.json)
  cachedChanges?: DiffChange[];
  originalCharCount?: number;
  cleanedCharCount?: number;
}

/**
 * A PASS diff as it sits on disk: `stages/NN-<kind>/diff.json`.
 *
 * Same shape as the cleanup cache the Review Changes UI already reads, with one
 * addition that matters — each chapter carries BOTH of its texts. A pass rewrites
 * the book in place, so by the time this file is opened the text it describes has
 * been overwritten by whatever ran next; the diff has to be self-contained or it
 * is unreadable.
 */
export interface PassDiffFile {
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
    changes: DiffChange[];
    /** After-text. */
    text?: string;
    /** Before-text. */
    originalText?: string;
  }>;
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
export const DIFF_INITIAL_LOAD = 5_000;  // 5k chars initially - very fast first paint
export const DIFF_CHUNK_SIZE = 5_000;  // 5k chars per background chunk (~300-400 words, <50ms diff)
export const DIFF_LOAD_MORE_SIZE = 20_000;  // 20k chars per manual "Load More" click
export const DIFF_SAFE_CHAR_LIMIT = 50_000;  // 50k chars before showing warning
export const DIFF_HARD_LIMIT = 100_000;  // 100k chars - definitely use pagination

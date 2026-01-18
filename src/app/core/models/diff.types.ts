/**
 * Types for word-level diff comparison between original and AI-cleaned EPUB content
 */

export interface DiffWord {
  text: string;
  type: 'unchanged' | 'added' | 'removed';
}

export interface DiffChapter {
  id: string;
  title: string;
  originalText: string;
  cleanedText: string;
  diffWords: DiffWord[];
  changeCount: number;
}

export interface DiffSession {
  originalPath: string;
  cleanedPath: string;
  chapters: DiffChapter[];
  currentChapterId: string;
}

export interface DiffComparisonResult {
  chapters: Array<{
    id: string;
    title: string;
    originalText: string;
    cleanedText: string;
  }>;
}

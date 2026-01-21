import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from '../../../core/services/electron.service';
import { DiffSession, DiffChapter, DiffWord } from '../../../core/models/diff.types';
import { computeWordDiff, countChanges, summarizeChanges } from '../../../core/utils/diff-algorithm';

export interface DiffLoadingProgress {
  phase: 'loading-original' | 'loading-cleaned' | 'computing-diff' | 'complete';
  currentChapter: number;
  totalChapters: number;
  chapterTitle?: string;
  percentage: number;
}

@Injectable({
  providedIn: 'root'
})
export class DiffService {
  private sessionSubject = new BehaviorSubject<DiffSession | null>(null);
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private errorSubject = new BehaviorSubject<string | null>(null);
  private loadingProgressSubject = new BehaviorSubject<DiffLoadingProgress | null>(null);

  session$ = this.sessionSubject.asObservable();
  loading$ = this.loadingSubject.asObservable();
  error$ = this.errorSubject.asObservable();
  loadingProgress$ = this.loadingProgressSubject.asObservable();

  private progressUnsubscribe: (() => void) | null = null;

  constructor(private electronService: ElectronService) {}

  /**
   * Load and compare two EPUBs for diff viewing.
   */
  async loadComparison(originalPath: string, cleanedPath: string): Promise<boolean> {
    this.loadingSubject.next(true);
    this.errorSubject.next(null);
    this.loadingProgressSubject.next({
      phase: 'loading-original',
      currentChapter: 0,
      totalChapters: 0,
      percentage: 0
    });

    // Subscribe to loading progress from electron
    this.progressUnsubscribe = this.electronService.onDiffLoadProgress((progress) => {
      // During loading, we're at 0-60% (original is 0-30%, cleaned is 30-60%)
      let percentage = 0;
      if (progress.phase === 'loading-original') {
        percentage = Math.round((progress.currentChapter / Math.max(progress.totalChapters, 1)) * 30);
      } else if (progress.phase === 'loading-cleaned') {
        percentage = 30 + Math.round((progress.currentChapter / Math.max(progress.totalChapters, 1)) * 30);
      }

      this.loadingProgressSubject.next({
        phase: progress.phase,
        currentChapter: progress.currentChapter,
        totalChapters: progress.totalChapters,
        chapterTitle: progress.chapterTitle,
        percentage
      });
    });

    try {
      const result = await this.electronService.loadDiffComparison(originalPath, cleanedPath);

      // Clean up progress listener
      if (this.progressUnsubscribe) {
        this.progressUnsubscribe();
        this.progressUnsubscribe = null;
      }

      if (!result.success || !result.chapters) {
        this.errorSubject.next(result.error || 'Failed to load EPUB comparison');
        this.loadingSubject.next(false);
        this.loadingProgressSubject.next(null);
        return false;
      }

      // Compute diffs for each chapter (60-100% of progress)
      const totalChapters = result.chapters.length;
      const chapters: DiffChapter[] = [];

      for (let i = 0; i < result.chapters.length; i++) {
        const chapter = result.chapters[i];

        // Update progress for diff computation
        this.loadingProgressSubject.next({
          phase: 'computing-diff',
          currentChapter: i + 1,
          totalChapters,
          chapterTitle: chapter.title,
          percentage: 60 + Math.round(((i + 1) / totalChapters) * 40)
        });

        // Small delay to allow UI to update (prevents blocking)
        if (i % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        const diffWords = computeWordDiff(chapter.originalText, chapter.cleanedText);
        const changeCount = countChanges(diffWords);

        chapters.push({
          id: chapter.id,
          title: chapter.title,
          originalText: chapter.originalText,
          cleanedText: chapter.cleanedText,
          diffWords,
          changeCount
        });
      }

      // Create session
      const session: DiffSession = {
        originalPath,
        cleanedPath,
        chapters,
        currentChapterId: chapters.length > 0 ? chapters[0].id : ''
      };

      this.loadingProgressSubject.next({
        phase: 'complete',
        currentChapter: totalChapters,
        totalChapters,
        percentage: 100
      });

      this.sessionSubject.next(session);
      this.loadingSubject.next(false);
      this.loadingProgressSubject.next(null);
      return true;
    } catch (err) {
      // Clean up progress listener
      if (this.progressUnsubscribe) {
        this.progressUnsubscribe();
        this.progressUnsubscribe = null;
      }
      this.errorSubject.next((err as Error).message);
      this.loadingSubject.next(false);
      this.loadingProgressSubject.next(null);
      return false;
    }
  }

  /**
   * Get the current session.
   */
  getSession(): DiffSession | null {
    return this.sessionSubject.getValue();
  }

  /**
   * Get the current chapter.
   */
  getCurrentChapter(): DiffChapter | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;

    return session.chapters.find(c => c.id === session.currentChapterId) || null;
  }

  /**
   * Set the current chapter by ID.
   */
  setCurrentChapter(chapterId: string): void {
    const session = this.sessionSubject.getValue();
    if (!session) return;

    const chapter = session.chapters.find(c => c.id === chapterId);
    if (chapter) {
      this.sessionSubject.next({
        ...session,
        currentChapterId: chapterId
      });
    }
  }

  /**
   * Navigate to the next chapter.
   */
  nextChapter(): boolean {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const currentIndex = session.chapters.findIndex(c => c.id === session.currentChapterId);
    if (currentIndex < session.chapters.length - 1) {
      this.setCurrentChapter(session.chapters[currentIndex + 1].id);
      return true;
    }
    return false;
  }

  /**
   * Navigate to the previous chapter.
   */
  previousChapter(): boolean {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const currentIndex = session.chapters.findIndex(c => c.id === session.currentChapterId);
    if (currentIndex > 0) {
      this.setCurrentChapter(session.chapters[currentIndex - 1].id);
      return true;
    }
    return false;
  }

  /**
   * Get total change count across all chapters.
   */
  getTotalChangeCount(): number {
    const session = this.sessionSubject.getValue();
    if (!session) return 0;

    return session.chapters.reduce((sum, chapter) => sum + chapter.changeCount, 0);
  }

  /**
   * Get change summary for a chapter.
   */
  getChapterSummary(chapterId: string): { added: number; removed: number } | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;

    const chapter = session.chapters.find(c => c.id === chapterId);
    if (!chapter) return null;

    return summarizeChanges(chapter.diffWords);
  }

  /**
   * Get chapters with changes (non-zero change count).
   */
  getChaptersWithChanges(): DiffChapter[] {
    const session = this.sessionSubject.getValue();
    if (!session) return [];

    return session.chapters.filter(c => c.changeCount > 0);
  }

  /**
   * Clear the current session.
   */
  clearSession(): void {
    this.sessionSubject.next(null);
    this.errorSubject.next(null);
  }
}

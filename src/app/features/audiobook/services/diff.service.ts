import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from '../../../core/services/electron.service';
import { DiffSession, DiffChapter, DiffWord } from '../../../core/models/diff.types';
import { computeWordDiff, countChanges, summarizeChanges } from '../../../core/utils/diff-algorithm';

@Injectable({
  providedIn: 'root'
})
export class DiffService {
  private sessionSubject = new BehaviorSubject<DiffSession | null>(null);
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private errorSubject = new BehaviorSubject<string | null>(null);

  session$ = this.sessionSubject.asObservable();
  loading$ = this.loadingSubject.asObservable();
  error$ = this.errorSubject.asObservable();

  constructor(private electronService: ElectronService) {}

  /**
   * Load and compare two EPUBs for diff viewing.
   */
  async loadComparison(originalPath: string, cleanedPath: string): Promise<boolean> {
    this.loadingSubject.next(true);
    this.errorSubject.next(null);

    try {
      const result = await this.electronService.loadDiffComparison(originalPath, cleanedPath);

      if (!result.success || !result.chapters) {
        this.errorSubject.next(result.error || 'Failed to load EPUB comparison');
        this.loadingSubject.next(false);
        return false;
      }

      // Compute diffs for each chapter
      const chapters: DiffChapter[] = result.chapters.map(chapter => {
        const diffWords = computeWordDiff(chapter.originalText, chapter.cleanedText);
        const changeCount = countChanges(diffWords);

        return {
          id: chapter.id,
          title: chapter.title,
          originalText: chapter.originalText,
          cleanedText: chapter.cleanedText,
          diffWords,
          changeCount
        };
      });

      // Create session
      const session: DiffSession = {
        originalPath,
        cleanedPath,
        chapters,
        currentChapterId: chapters.length > 0 ? chapters[0].id : ''
      };

      this.sessionSubject.next(session);
      this.loadingSubject.next(false);
      return true;
    } catch (err) {
      this.errorSubject.next((err as Error).message);
      this.loadingSubject.next(false);
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

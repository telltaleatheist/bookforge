import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ElectronService } from '../../../core/services/electron.service';
import {
  DiffSession,
  DiffChapter,
  DiffChapterMeta,
  DiffWord,
  DIFF_SAFE_CHAR_LIMIT,
  DIFF_HARD_LIMIT
} from '../../../core/models/diff.types';
import { computeWordDiff, countChanges, summarizeChanges } from '../../../core/utils/diff-algorithm';

export interface DiffLoadingProgress {
  phase: 'loading-metadata' | 'loading-chapter' | 'computing-diff' | 'complete';
  currentChapter: number;
  totalChapters: number;
  chapterTitle?: string;
  percentage: number;
}

// Cache loaded chapters to avoid reloading, but limit total cached
const MAX_CACHED_CHAPTERS = 5;

@Injectable({
  providedIn: 'root'
})
export class DiffService {
  private sessionSubject = new BehaviorSubject<DiffSession | null>(null);
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private errorSubject = new BehaviorSubject<string | null>(null);
  private loadingProgressSubject = new BehaviorSubject<DiffLoadingProgress | null>(null);
  private chapterLoadingSubject = new BehaviorSubject<boolean>(false);

  session$ = this.sessionSubject.asObservable();
  loading$ = this.loadingSubject.asObservable();
  error$ = this.errorSubject.asObservable();
  loadingProgress$ = this.loadingProgressSubject.asObservable();
  chapterLoading$ = this.chapterLoadingSubject.asObservable();

  // Track which chapters are cached (LRU order)
  private cachedChapterIds: string[] = [];

  constructor(private electronService: ElectronService) {}

  /**
   * Load comparison metadata only (no text content).
   * This is memory-efficient and won't cause OOM on large EPUBs.
   */
  async loadComparison(originalPath: string, cleanedPath: string): Promise<boolean> {
    this.loadingSubject.next(true);
    this.errorSubject.next(null);
    this.cachedChapterIds = [];

    this.loadingProgressSubject.next({
      phase: 'loading-metadata',
      currentChapter: 0,
      totalChapters: 0,
      percentage: 0
    });

    try {
      // Get chapter metadata only (no text)
      const result = await this.electronService.getDiffMetadata(originalPath, cleanedPath);

      if (!result.success || !result.chapters) {
        this.errorSubject.next(result.error || 'Failed to load EPUB comparison metadata');
        this.loadingSubject.next(false);
        this.loadingProgressSubject.next(null);
        return false;
      }

      // Convert to chapter metadata
      const chaptersMeta: DiffChapterMeta[] = result.chapters.map(ch => ({
        id: ch.id,
        title: ch.title,
        hasOriginal: ch.hasOriginal,
        hasCleaned: ch.hasCleaned,
        isLoaded: false
      }));

      // Create session with metadata only
      const session: DiffSession = {
        originalPath,
        cleanedPath,
        chapters: [],  // Start empty - chapters loaded on demand
        chaptersMeta,
        currentChapterId: chaptersMeta.length > 0 ? chaptersMeta[0].id : ''
      };

      this.loadingProgressSubject.next({
        phase: 'complete',
        currentChapter: chaptersMeta.length,
        totalChapters: chaptersMeta.length,
        percentage: 100
      });

      this.sessionSubject.next(session);
      this.loadingSubject.next(false);
      this.loadingProgressSubject.next(null);

      // Auto-load the first chapter
      if (chaptersMeta.length > 0) {
        await this.loadChapter(chaptersMeta[0].id);
      }

      return true;
    } catch (err) {
      this.errorSubject.next((err as Error).message);
      this.loadingSubject.next(false);
      this.loadingProgressSubject.next(null);
      return false;
    }
  }

  /**
   * Load a single chapter's text content on demand.
   * Uses caching to avoid reloading recently viewed chapters.
   */
  async loadChapter(chapterId: string): Promise<DiffChapter | null> {
    const session = this.sessionSubject.getValue();
    if (!session) return null;

    // Check if already loaded
    const existing = session.chapters.find(c => c.id === chapterId);
    if (existing) {
      // Move to end of cache (most recently used)
      this.updateCacheOrder(chapterId);
      return existing;
    }

    // Find metadata
    const meta = session.chaptersMeta.find(m => m.id === chapterId);
    if (!meta) return null;

    this.chapterLoadingSubject.next(true);
    this.loadingProgressSubject.next({
      phase: 'loading-chapter',
      currentChapter: 0,
      totalChapters: 1,
      chapterTitle: meta.title,
      percentage: 0
    });

    try {
      const result = await this.electronService.getDiffChapter(
        session.originalPath,
        session.cleanedPath,
        chapterId
      );

      if (!result.success) {
        this.errorSubject.next(result.error || 'Failed to load chapter');
        this.chapterLoadingSubject.next(false);
        this.loadingProgressSubject.next(null);
        return null;
      }

      const originalText = result.originalText || '';
      const cleanedText = result.cleanedText || '';

      // Check for oversized chapter
      const totalSize = originalText.length + cleanedText.length;
      const isOversized = totalSize > DIFF_HARD_LIMIT;

      // Update metadata
      meta.isLoaded = true;
      meta.isOversized = isOversized;

      this.loadingProgressSubject.next({
        phase: 'computing-diff',
        currentChapter: 0,
        totalChapters: 1,
        chapterTitle: meta.title,
        percentage: 50
      });

      // For oversized chapters, compute diff on truncated text or skip
      let diffWords: DiffWord[];
      let changeCount: number;

      if (isOversized) {
        // For very large chapters, compute diff on first chunk only
        // to get an approximate change count
        const truncatedOriginal = originalText.slice(0, DIFF_SAFE_CHAR_LIMIT);
        const truncatedCleaned = cleanedText.slice(0, DIFF_SAFE_CHAR_LIMIT);
        const partialDiff = computeWordDiff(truncatedOriginal, truncatedCleaned);
        const partialCount = countChanges(partialDiff);

        // Estimate total changes based on partial
        const ratio = totalSize / (DIFF_SAFE_CHAR_LIMIT * 2);
        changeCount = Math.round(partialCount * ratio);

        // Store partial diff for display
        diffWords = partialDiff;
      } else {
        // Normal chapter - compute full diff
        diffWords = computeWordDiff(originalText, cleanedText);
        changeCount = countChanges(diffWords);
      }

      meta.changeCount = changeCount;

      const chapter: DiffChapter = {
        id: chapterId,
        title: meta.title,
        originalText,
        cleanedText,
        diffWords,
        changeCount
      };

      // Manage cache - evict oldest if needed
      this.evictOldestIfNeeded(session);

      // Add to session
      const updatedSession: DiffSession = {
        ...session,
        chapters: [...session.chapters, chapter]
      };

      this.cachedChapterIds.push(chapterId);

      this.loadingProgressSubject.next({
        phase: 'complete',
        currentChapter: 1,
        totalChapters: 1,
        percentage: 100
      });

      this.sessionSubject.next(updatedSession);
      this.chapterLoadingSubject.next(false);
      this.loadingProgressSubject.next(null);

      return chapter;
    } catch (err) {
      this.errorSubject.next((err as Error).message);
      this.chapterLoadingSubject.next(false);
      this.loadingProgressSubject.next(null);
      return null;
    }
  }

  /**
   * Evict the oldest cached chapter if we've exceeded the limit.
   */
  private evictOldestIfNeeded(session: DiffSession): void {
    while (this.cachedChapterIds.length >= MAX_CACHED_CHAPTERS) {
      const oldestId = this.cachedChapterIds.shift();
      if (oldestId) {
        // Remove from chapters array (but keep metadata)
        session.chapters = session.chapters.filter(c => c.id !== oldestId);
        // Update metadata
        const meta = session.chaptersMeta.find(m => m.id === oldestId);
        if (meta) {
          meta.isLoaded = false;
        }
      }
    }
  }

  /**
   * Update cache order when a chapter is accessed.
   */
  private updateCacheOrder(chapterId: string): void {
    const idx = this.cachedChapterIds.indexOf(chapterId);
    if (idx > -1) {
      this.cachedChapterIds.splice(idx, 1);
      this.cachedChapterIds.push(chapterId);
    }
  }

  /**
   * Get the current session.
   */
  getSession(): DiffSession | null {
    return this.sessionSubject.getValue();
  }

  /**
   * Get the current chapter (loaded).
   */
  getCurrentChapter(): DiffChapter | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;

    return session.chapters.find(c => c.id === session.currentChapterId) || null;
  }

  /**
   * Get metadata for the current chapter.
   */
  getCurrentChapterMeta(): DiffChapterMeta | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;

    return session.chaptersMeta.find(m => m.id === session.currentChapterId) || null;
  }

  /**
   * Set the current chapter by ID and load it if needed.
   */
  async setCurrentChapter(chapterId: string): Promise<void> {
    const session = this.sessionSubject.getValue();
    if (!session) return;

    const meta = session.chaptersMeta.find(m => m.id === chapterId);
    if (!meta) return;

    // Update current chapter ID
    this.sessionSubject.next({
      ...session,
      currentChapterId: chapterId
    });

    // Load chapter if not already loaded
    if (!meta.isLoaded) {
      await this.loadChapter(chapterId);
    }
  }

  /**
   * Navigate to the next chapter.
   */
  async nextChapter(): Promise<boolean> {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const currentIndex = session.chaptersMeta.findIndex(m => m.id === session.currentChapterId);
    if (currentIndex < session.chaptersMeta.length - 1) {
      await this.setCurrentChapter(session.chaptersMeta[currentIndex + 1].id);
      return true;
    }
    return false;
  }

  /**
   * Navigate to the previous chapter.
   */
  async previousChapter(): Promise<boolean> {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const currentIndex = session.chaptersMeta.findIndex(m => m.id === session.currentChapterId);
    if (currentIndex > 0) {
      await this.setCurrentChapter(session.chaptersMeta[currentIndex - 1].id);
      return true;
    }
    return false;
  }

  /**
   * Get total change count across all loaded chapters.
   * For unloaded chapters, this returns 0 until they're loaded.
   */
  getTotalChangeCount(): number {
    const session = this.sessionSubject.getValue();
    if (!session) return 0;

    // Sum up change counts from metadata (set when chapters are loaded)
    return session.chaptersMeta.reduce((sum, meta) => sum + (meta.changeCount || 0), 0);
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
   * Get chapters with changes (loaded chapters only).
   */
  getChaptersWithChanges(): DiffChapter[] {
    const session = this.sessionSubject.getValue();
    if (!session) return [];

    return session.chapters.filter(c => c.changeCount > 0);
  }

  /**
   * Check if a chapter is loaded.
   */
  isChapterLoaded(chapterId: string): boolean {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    return session.chapters.some(c => c.id === chapterId);
  }

  /**
   * Clear the current session.
   */
  clearSession(): void {
    this.sessionSubject.next(null);
    this.errorSubject.next(null);
    this.cachedChapterIds = [];
  }
}

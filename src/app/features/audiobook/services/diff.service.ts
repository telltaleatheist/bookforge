import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ElectronService } from '../../../core/services/electron.service';
import {
  DiffSession,
  DiffChapter,
  DiffChapterMeta,
  DiffWord,
  DIFF_INITIAL_LOAD,
  DIFF_LOAD_MORE_SIZE
} from '../../../core/models/diff.types';
import { computeWordDiff, countChanges, summarizeChanges } from '../../../core/utils/diff-algorithm';

export interface DiffLoadingProgress {
  phase: 'loading-metadata' | 'loading-chapter' | 'computing-diff' | 'complete';
  currentChapter: number;
  totalChapters: number;
  chapterTitle?: string;
  percentage: number;
}

// Cache structure stored to disk
interface CachedChapterData {
  diffWords: DiffWord[];
  changeCount: number;
  loadedChars: number;
  totalChars: number;
  fullyLoaded: boolean;
}

// Cache loaded chapters to avoid reloading, but limit total cached in memory
const MAX_CACHED_CHAPTERS = 10;

@Injectable({
  providedIn: 'root'
})
export class DiffService {
  private sessionSubject = new BehaviorSubject<DiffSession | null>(null);
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private errorSubject = new BehaviorSubject<string | null>(null);
  private loadingProgressSubject = new BehaviorSubject<DiffLoadingProgress | null>(null);
  private chapterLoadingSubject = new BehaviorSubject<boolean>(false);
  private backgroundLoadingSubject = new BehaviorSubject<boolean>(false);

  session$ = this.sessionSubject.asObservable();
  loading$ = this.loadingSubject.asObservable();
  error$ = this.errorSubject.asObservable();
  loadingProgress$ = this.loadingProgressSubject.asObservable();
  chapterLoading$ = this.chapterLoadingSubject.asObservable();
  backgroundLoading$ = this.backgroundLoadingSubject.asObservable();

  // Track which chapters are cached in memory (LRU order)
  private cachedChapterIds: string[] = [];

  // Background loading state
  private backgroundLoadingAborted = false;
  private backgroundLoadingPromise: Promise<void> | null = null;

  constructor(private electronService: ElectronService) {}

  /**
   * Load comparison metadata only (no text content).
   * This is memory-efficient and won't cause OOM on large EPUBs.
   * After loading, starts background loading of all chapters.
   */
  async loadComparison(originalPath: string, cleanedPath: string): Promise<boolean> {
    console.log('[DiffService] loadComparison called:', originalPath.slice(-40));

    // Abort any in-progress background loading
    this.backgroundLoadingAborted = true;
    if (this.backgroundLoadingPromise) {
      await this.backgroundLoadingPromise.catch(() => {});
    }
    this.backgroundLoadingAborted = false;

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
      console.log('[DiffService] Calling getDiffMetadata...');
      const result = await this.electronService.getDiffMetadata(originalPath, cleanedPath);
      console.log('[DiffService] getDiffMetadata returned:', result.success, result.chapters?.length, result.error);

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

      // Auto-load the first chapter, then start background loading
      if (chaptersMeta.length > 0) {
        console.log('[DiffService] Auto-loading first chapter:', chaptersMeta[0].id);
        const chapter = await this.loadChapter(chaptersMeta[0].id);
        console.log('[DiffService] First chapter loaded:', chapter ? 'success' : 'failed');

        // Start background loading of all chapters
        this.startBackgroundLoading();
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
   * Start background loading of all chapters.
   * Loads current chapter fully, then moves to next chapters.
   */
  private startBackgroundLoading(): void {
    this.backgroundLoadingPromise = this.backgroundLoadAll();
  }

  /**
   * Background loading loop - loads all chapters progressively.
   */
  private async backgroundLoadAll(): Promise<void> {
    const session = this.sessionSubject.getValue();
    if (!session) return;

    this.backgroundLoadingSubject.next(true);
    console.log('[DiffService] Starting background loading for', session.chaptersMeta.length, 'chapters');

    try {
      // First, fully load the current chapter
      await this.backgroundLoadChapterFully(session.currentChapterId);

      // Then load remaining chapters in order
      for (const meta of session.chaptersMeta) {
        if (this.backgroundLoadingAborted) {
          console.log('[DiffService] Background loading aborted');
          break;
        }

        // Skip if already fully loaded
        const chapter = session.chapters.find(c => c.id === meta.id);
        if (chapter && chapter.loadedChars >= chapter.totalChars) {
          continue;
        }

        await this.backgroundLoadChapterFully(meta.id);
      }

      console.log('[DiffService] Background loading complete');
    } catch (err) {
      console.error('[DiffService] Background loading error:', err);
    } finally {
      this.backgroundLoadingSubject.next(false);
      this.backgroundLoadingPromise = null;
    }
  }

  /**
   * Load a chapter fully in the background (all chunks).
   */
  private async backgroundLoadChapterFully(chapterId: string): Promise<void> {
    const session = this.sessionSubject.getValue();
    if (!session || this.backgroundLoadingAborted) return;

    // Load initial chunk if not loaded
    let chapter: DiffChapter | undefined = session.chapters.find(c => c.id === chapterId);
    if (!chapter) {
      // Try to load from cache first
      const cached = await this.loadFromCache(session.originalPath, session.cleanedPath, chapterId);
      if (cached && cached.fullyLoaded) {
        // Full cache hit - add directly to session
        await this.addCachedChapterToSession(chapterId, cached);
        return;
      }

      // Load chapter text
      const loaded = await this.loadChapter(chapterId);
      if (!loaded) return;
      chapter = loaded;
    }

    // Continue loading remaining chunks
    while (chapter && chapter.loadedChars < chapter.totalChars && !this.backgroundLoadingAborted) {
      await this.loadMoreBackground(chapterId);

      // Re-fetch chapter from session (it may have been updated)
      const updatedSession = this.sessionSubject.getValue();
      chapter = updatedSession?.chapters.find(c => c.id === chapterId);

      // Small yield to keep UI responsive
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Save fully loaded chapter to cache
    if (chapter && chapter.loadedChars >= chapter.totalChars) {
      await this.saveToCache(session.originalPath, session.cleanedPath, chapterId, {
        diffWords: chapter.diffWords,
        changeCount: chapter.changeCount,
        loadedChars: chapter.loadedChars,
        totalChars: chapter.totalChars,
        fullyLoaded: true
      });
    }
  }

  /**
   * Load more content in background (doesn't set chapterLoadingSubject).
   */
  private async loadMoreBackground(chapterId: string): Promise<boolean> {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const chapter = session.chapters.find(c => c.id === chapterId);
    if (!chapter) return false;

    if (chapter.loadedChars >= chapter.totalChars) {
      return false;
    }

    try {
      const newLoadedChars = Math.min(
        chapter.loadedChars + DIFF_LOAD_MORE_SIZE,
        chapter.totalChars
      );

      // Recompute diff for the extended range
      const truncatedOriginal = chapter.originalText.slice(0, newLoadedChars);
      const truncatedCleaned = chapter.cleanedText.slice(0, newLoadedChars);
      const diffWords = computeWordDiff(truncatedOriginal, truncatedCleaned);
      const changeCount = countChanges(diffWords);

      // Update chapter
      const updatedChapter: DiffChapter = {
        ...chapter,
        diffWords,
        changeCount,
        loadedChars: newLoadedChars
      };

      // Update session without triggering full reload
      const currentSession = this.sessionSubject.getValue();
      if (!currentSession) return false;

      const updatedChapters = currentSession.chapters.map(c =>
        c.id === chapter.id ? updatedChapter : c
      );

      // Update metadata change count
      const meta = currentSession.chaptersMeta.find(m => m.id === chapter.id);
      if (meta) {
        meta.changeCount = changeCount;
      }

      this.sessionSubject.next({
        ...currentSession,
        chapters: updatedChapters
      });

      return true;
    } catch (err) {
      console.error('[DiffService] loadMoreBackground error:', err);
      return false;
    }
  }

  /**
   * Load a single chapter's text content on demand.
   * First checks disk cache, then IPC.
   */
  async loadChapter(chapterId: string): Promise<DiffChapter | null> {
    console.log('[DiffService] loadChapter called:', chapterId);
    const session = this.sessionSubject.getValue();
    if (!session) {
      console.log('[DiffService] loadChapter: no session');
      return null;
    }

    // Check if already loaded in memory
    const existing = session.chapters.find(c => c.id === chapterId);
    if (existing) {
      console.log('[DiffService] loadChapter: already cached in memory');
      this.updateCacheOrder(chapterId);
      return existing;
    }

    // Find metadata
    const meta = session.chaptersMeta.find(m => m.id === chapterId);
    if (!meta) {
      console.log('[DiffService] loadChapter: no metadata');
      return null;
    }

    // Try disk cache first
    const cached = await this.loadFromCache(session.originalPath, session.cleanedPath, chapterId);
    if (cached) {
      console.log('[DiffService] loadChapter: loaded from disk cache');
      return await this.loadChapterWithCache(chapterId, meta, cached, session);
    }

    console.log('[DiffService] loadChapter: fetching from IPC...');
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
      console.log('[DiffService] loadChapter IPC returned:', result.success, result.error);

      if (!result.success) {
        this.errorSubject.next(result.error || 'Failed to load chapter');
        this.chapterLoadingSubject.next(false);
        this.loadingProgressSubject.next(null);
        return null;
      }

      const originalText = result.originalText || '';
      const cleanedText = result.cleanedText || '';
      console.log('[DiffService] loadChapter text lengths:', originalText.length, cleanedText.length);

      // Update metadata
      meta.isLoaded = true;
      meta.isOversized = cleanedText.length > DIFF_INITIAL_LOAD;

      this.loadingProgressSubject.next({
        phase: 'computing-diff',
        currentChapter: 0,
        totalChapters: 1,
        chapterTitle: meta.title,
        percentage: 50
      });

      // Yield to UI thread so loading state can render before heavy computation
      await new Promise(resolve => setTimeout(resolve, 50));

      // Only compute diff for initial chunk (fast load)
      const loadChars = Math.min(DIFF_INITIAL_LOAD, cleanedText.length);
      console.log('[DiffService] Computing diff for first', loadChars, 'chars...');
      const diffStartTime = Date.now();

      const truncatedOriginal = originalText.slice(0, loadChars);
      const truncatedCleaned = cleanedText.slice(0, loadChars);
      const diffWords = computeWordDiff(truncatedOriginal, truncatedCleaned);
      const changeCount = countChanges(diffWords);

      console.log('[DiffService] Diff complete:', diffWords.length, 'words,', changeCount, 'changes in', Date.now() - diffStartTime, 'ms');

      meta.changeCount = changeCount;

      const chapter: DiffChapter = {
        id: chapterId,
        title: meta.title,
        originalText,
        cleanedText,
        diffWords,
        changeCount,
        loadedChars: loadChars,
        totalChars: cleanedText.length
      };

      // Add to session
      const currentSession = this.sessionSubject.getValue();
      if (currentSession) {
        this.evictOldestIfNeeded(currentSession);
        this.sessionSubject.next({
          ...currentSession,
          chapters: [...currentSession.chapters, chapter]
        });
        this.cachedChapterIds.push(chapterId);
      }

      this.loadingProgressSubject.next({
        phase: 'complete',
        currentChapter: 1,
        totalChapters: 1,
        percentage: 100
      });

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
   * Load chapter with cached diff data (still needs original text for load more).
   */
  private async loadChapterWithCache(
    chapterId: string,
    meta: DiffChapterMeta,
    cached: CachedChapterData,
    session: DiffSession
  ): Promise<DiffChapter | null> {
    this.chapterLoadingSubject.next(true);

    try {
      // If fully cached, we still need the text for potential edits
      const result = await this.electronService.getDiffChapter(
        session.originalPath,
        session.cleanedPath,
        chapterId
      );

      if (!result.success) {
        this.chapterLoadingSubject.next(false);
        return null;
      }

      const chapter: DiffChapter = {
        id: chapterId,
        title: meta.title,
        originalText: result.originalText || '',
        cleanedText: result.cleanedText || '',
        diffWords: cached.diffWords,
        changeCount: cached.changeCount,
        loadedChars: cached.loadedChars,
        totalChars: cached.totalChars
      };

      meta.isLoaded = true;
      meta.changeCount = cached.changeCount;

      // Add to session
      const currentSession = this.sessionSubject.getValue();
      if (currentSession) {
        this.evictOldestIfNeeded(currentSession);
        this.sessionSubject.next({
          ...currentSession,
          chapters: [...currentSession.chapters, chapter]
        });
        this.cachedChapterIds.push(chapterId);
      }

      this.chapterLoadingSubject.next(false);
      return chapter;
    } catch (err) {
      this.chapterLoadingSubject.next(false);
      return null;
    }
  }

  /**
   * Add a fully cached chapter to session (when we have complete cache).
   */
  private async addCachedChapterToSession(chapterId: string, cached: CachedChapterData): Promise<void> {
    const session = this.sessionSubject.getValue();
    if (!session) return;

    const meta = session.chaptersMeta.find(m => m.id === chapterId);
    if (!meta) return;

    // Still need text for potential edits
    const result = await this.electronService.getDiffChapter(
      session.originalPath,
      session.cleanedPath,
      chapterId
    );

    if (!result.success) return;

    const chapter: DiffChapter = {
      id: chapterId,
      title: meta.title,
      originalText: result.originalText || '',
      cleanedText: result.cleanedText || '',
      diffWords: cached.diffWords,
      changeCount: cached.changeCount,
      loadedChars: cached.loadedChars,
      totalChars: cached.totalChars
    };

    meta.isLoaded = true;
    meta.changeCount = cached.changeCount;

    const currentSession = this.sessionSubject.getValue();
    if (currentSession) {
      this.evictOldestIfNeeded(currentSession);
      this.sessionSubject.next({
        ...currentSession,
        chapters: [...currentSession.chapters, chapter]
      });
      this.cachedChapterIds.push(chapterId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cache Operations
  // ─────────────────────────────────────────────────────────────────────────────

  private async loadFromCache(originalPath: string, cleanedPath: string, chapterId: string): Promise<CachedChapterData | null> {
    try {
      const result = await this.electronService.loadDiffCache(originalPath, cleanedPath, chapterId);
      if (result.success && result.data) {
        return result.data as CachedChapterData;
      }
    } catch (err) {
      console.error('[DiffService] Cache load error:', err);
    }
    return null;
  }

  private async saveToCache(originalPath: string, cleanedPath: string, chapterId: string, data: CachedChapterData): Promise<void> {
    try {
      await this.electronService.saveDiffCache(originalPath, cleanedPath, chapterId, data);
      console.log('[DiffService] Saved chapter to cache:', chapterId);
    } catch (err) {
      console.error('[DiffService] Cache save error:', err);
    }
  }

  /**
   * Clear cache for the current session (call when files change).
   */
  async clearCache(): Promise<void> {
    const session = this.sessionSubject.getValue();
    if (session) {
      await this.electronService.clearDiffCache(session.originalPath, session.cleanedPath);
      console.log('[DiffService] Cache cleared');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Memory Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Evict the oldest cached chapter if we've exceeded the limit.
   */
  private evictOldestIfNeeded(session: DiffSession): void {
    while (this.cachedChapterIds.length >= MAX_CACHED_CHAPTERS) {
      const oldestId = this.cachedChapterIds.shift();
      if (oldestId && oldestId !== session.currentChapterId) {
        // Remove from chapters array (but keep metadata)
        session.chapters = session.chapters.filter(c => c.id !== oldestId);
        // Update metadata - chapter is still "loaded" because it's cached to disk
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Accessors
  // ─────────────────────────────────────────────────────────────────────────────

  getSession(): DiffSession | null {
    return this.sessionSubject.getValue();
  }

  getCurrentChapter(): DiffChapter | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;
    return session.chapters.find(c => c.id === session.currentChapterId) || null;
  }

  getCurrentChapterMeta(): DiffChapterMeta | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;
    return session.chaptersMeta.find(m => m.id === session.currentChapterId) || null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Load More (User-triggered, shows loading state)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Load more content for the current chapter.
   * This is the user-triggered version that shows loading state.
   */
  async loadMore(): Promise<boolean> {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const chapter = session.chapters.find(c => c.id === session.currentChapterId);
    if (!chapter) return false;

    if (chapter.loadedChars >= chapter.totalChars) {
      console.log('[DiffService] loadMore: already fully loaded');
      return false;
    }

    console.log('[DiffService] loadMore: extending from', chapter.loadedChars, 'chars');

    // NOTE: We don't set chapterLoadingSubject here because we don't want to blank the view
    // The background loading will update the chapter incrementally

    try {
      const newLoadedChars = Math.min(
        chapter.loadedChars + DIFF_LOAD_MORE_SIZE,
        chapter.totalChars
      );

      console.log('[DiffService] loadMore: computing diff up to', newLoadedChars, 'chars');
      const diffStartTime = Date.now();

      // Yield to UI thread
      await new Promise(resolve => setTimeout(resolve, 10));

      // Recompute diff for the extended range
      const truncatedOriginal = chapter.originalText.slice(0, newLoadedChars);
      const truncatedCleaned = chapter.cleanedText.slice(0, newLoadedChars);
      const diffWords = computeWordDiff(truncatedOriginal, truncatedCleaned);
      const changeCount = countChanges(diffWords);

      console.log('[DiffService] loadMore complete:', diffWords.length, 'words,', changeCount, 'changes in', Date.now() - diffStartTime, 'ms');

      // Update chapter
      const updatedChapter: DiffChapter = {
        ...chapter,
        diffWords,
        changeCount,
        loadedChars: newLoadedChars
      };

      // Update session
      const currentSession = this.sessionSubject.getValue();
      if (!currentSession) return false;

      const updatedChapters = currentSession.chapters.map(c =>
        c.id === chapter.id ? updatedChapter : c
      );

      // Update metadata change count
      const meta = currentSession.chaptersMeta.find(m => m.id === chapter.id);
      if (meta) {
        meta.changeCount = changeCount;
      }

      this.sessionSubject.next({
        ...currentSession,
        chapters: updatedChapters
      });

      // Save to cache if now fully loaded
      if (newLoadedChars >= chapter.totalChars) {
        await this.saveToCache(currentSession.originalPath, currentSession.cleanedPath, chapter.id, {
          diffWords,
          changeCount,
          loadedChars: newLoadedChars,
          totalChars: chapter.totalChars,
          fullyLoaded: true
        });
      }

      return true;
    } catch (err) {
      console.error('[DiffService] loadMore error:', err);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  hasMoreContent(): boolean {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    const chapter = session.chapters.find(c => c.id === session.currentChapterId);
    if (!chapter) return false;

    return chapter.loadedChars < chapter.totalChars;
  }

  getLoadingProgress(): number {
    const session = this.sessionSubject.getValue();
    if (!session) return 100;

    const chapter = session.chapters.find(c => c.id === session.currentChapterId);
    if (!chapter || chapter.totalChars === 0) return 100;

    return Math.round((chapter.loadedChars / chapter.totalChars) * 100);
  }

  getTotalChangeCount(): number {
    const session = this.sessionSubject.getValue();
    if (!session) return 0;

    return session.chaptersMeta.reduce((sum, meta) => sum + (meta.changeCount || 0), 0);
  }

  getChapterSummary(chapterId: string): { added: number; removed: number } | null {
    const session = this.sessionSubject.getValue();
    if (!session) return null;

    const chapter = session.chapters.find(c => c.id === chapterId);
    if (!chapter) return null;

    return summarizeChanges(chapter.diffWords);
  }

  getChaptersWithChanges(): DiffChapter[] {
    const session = this.sessionSubject.getValue();
    if (!session) return [];

    return session.chapters.filter(c => c.changeCount > 0);
  }

  isChapterLoaded(chapterId: string): boolean {
    const session = this.sessionSubject.getValue();
    if (!session) return false;

    return session.chapters.some(c => c.id === chapterId);
  }

  clearSession(): void {
    this.backgroundLoadingAborted = true;
    this.sessionSubject.next(null);
    this.errorSubject.next(null);
    this.cachedChapterIds = [];
  }
}

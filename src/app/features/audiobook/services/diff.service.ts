import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ElectronService } from '../../../core/services/electron.service';
import { SettingsService } from '../../../core/services/settings.service';
import {
  DiffSession,
  DiffChapter,
  DiffChapterMeta,
  DiffWord,
  DiffChange,
  DIFF_INITIAL_LOAD,
  DIFF_CHUNK_SIZE,
  DIFF_LOAD_MORE_SIZE
} from '../../../core/models/diff.types';
import { computeWordDiffAsync, countChanges, summarizeChanges, DiffOptions } from '../../../core/utils/diff-algorithm';

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

  // Streaming diff state (per-chapter incremental computation)
  private streamingAborted = false;
  private streamingChapterId: string | null = null;
  private streamingGeneration = 0;  // Incremented on stop to invalidate pending setTimeout callbacks
  private emissionsBlocked = false;  // When true, no session updates are emitted

  // Web Worker for off-main-thread diff computation
  private diffWorker: Worker | null = null;
  private workerRequestId = 0;
  private pendingWorkerRequests = new Map<number, {
    resolve: (result: DiffWord[]) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    private electronService: ElectronService,
    private settingsService: SettingsService
  ) {}

  /**
   * Get current diff options based on settings.
   */
  private getDiffOptions(): DiffOptions {
    const ignoreWhitespace = this.settingsService.get<boolean>('diffIgnoreWhitespace') ?? true;
    return { ignoreWhitespace };
  }

  /**
   * Initialize the diff worker if not already created.
   */
  private initWorker(): Worker {
    if (!this.diffWorker) {
      this.diffWorker = new Worker(new URL('../../../core/workers/diff.worker.ts', import.meta.url), { type: 'module' });
      this.diffWorker.onmessage = (event) => {
        const { id, diffWords, error } = event.data;
        const pending = this.pendingWorkerRequests.get(id);
        if (pending) {
          this.pendingWorkerRequests.delete(id);
          if (error) {
            console.error('[DiffService] Worker error:', error);
            pending.reject(new Error(error));
          } else {
            pending.resolve(diffWords);
          }
        }
      };
      this.diffWorker.onerror = (error) => {
        console.error('[DiffService] Worker error:', error);
      };
    }
    return this.diffWorker;
  }

  /**
   * Compute diff using Web Worker ONLY (off main thread).
   * No fallbacks - if worker fails or is stopped, returns empty result.
   */
  private async computeDiff(originalText: string, cleanedText: string): Promise<DiffWord[]> {
    // Check if streaming was aborted before starting
    if (this.streamingAborted) {
      return [];
    }

    const options = this.getDiffOptions();

    try {
      const worker = this.initWorker();
      const id = ++this.workerRequestId;
      const currentGeneration = this.streamingGeneration;

      const result = await new Promise<DiffWord[]>((resolve, reject) => {
        // Check abort again
        if (this.streamingAborted || this.streamingGeneration !== currentGeneration) {
          resolve([]);
          return;
        }

        this.pendingWorkerRequests.set(id, { resolve, reject });

        // Timeout after 30 seconds
        const timeout = setTimeout(() => {
          this.pendingWorkerRequests.delete(id);
          resolve([]); // Return empty on timeout, don't block
        }, 30000);

        worker.postMessage({ id, originalText, cleanedText, options });

        // Update handlers to clear timeout
        this.pendingWorkerRequests.set(id, {
          resolve: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timeout);
            resolve([]); // Return empty on error, don't fallback
          }
        });
      });

      return result;
    } catch (err) {
      console.warn('[DiffService] Worker diff failed:', err);
      return []; // No fallback - just return empty
    }
  }

  /**
   * Load comparison metadata only (no text content).
   * This is memory-efficient and won't cause OOM on large EPUBs.
   * After loading, starts background loading of all chapters.
   */
  async loadComparison(originalPath: string, cleanedPath: string): Promise<boolean> {
    console.log('[DiffService] loadComparison called:', originalPath.slice(-40));

    // Reset all streaming flags (may have been set by previous stopStreaming)
    this.emissionsBlocked = false;
    this.streamingAborted = false;  // CRITICAL: Reset this or computeDiff returns empty!

    // Abort any in-progress background loading
    this.backgroundLoadingAborted = true;
    if (this.backgroundLoadingPromise) {
      await this.backgroundLoadingPromise.catch(() => {});
    }
    this.backgroundLoadingAborted = false;

    this.loadingSubject.next(true);
    this.errorSubject.next(null);
    this.cachedChapterIds = [];

    // Try loading from pre-computed diff cache first (created during AI cleanup)
    console.log('[DiffService] Trying pre-computed diff cache...');
    const cacheResult = await this.electronService.loadCachedDiffFile(cleanedPath);

    if (cacheResult.success && cacheResult.data) {
      console.log('[DiffService] Found pre-computed cache with', cacheResult.data.chapters.length, 'chapters');
      return this.initSessionFromCache(cacheResult.data, originalPath, cleanedPath);
    }

    console.log('[DiffService] No pre-computed cache, falling back to on-demand loading');
    return this.loadComparisonOnDemand(originalPath, cleanedPath);
  }

  /**
   * Initialize session from pre-computed diff cache.
   * This is instant - no IPC calls or diff computation needed.
   *
   * For incomplete jobs (completed=false), we merge cached chapters with
   * EPUB metadata to show all chapters, with uncached ones falling back
   * to on-demand loading.
   */
  private async initSessionFromCache(
    cache: {
      version: number;
      createdAt: string;
      updatedAt?: string;
      ignoreWhitespace: boolean;
      completed?: boolean;
      chapters: Array<{
        id: string;
        title: string;
        originalCharCount: number;
        cleanedCharCount: number;
        changeCount: number;
        changes: DiffChange[];
      }>;
    },
    originalPath: string,
    cleanedPath: string
  ): Promise<boolean> {
    const isComplete = cache.completed !== false;  // Default to true for old caches
    console.log(`[DiffService] Initializing from cache (${isComplete ? 'complete' : 'in-progress'}, ${cache.chapters.length} chapters)...`);

    // Build a map of cached chapters for quick lookup
    const cachedChapterIds = new Set(cache.chapters.map(ch => ch.id));

    // Convert cached chapters to metadata with pre-computed changes
    let chaptersMeta: DiffChapterMeta[] = cache.chapters.map(ch => ({
      id: ch.id,
      title: ch.title,
      hasOriginal: true,
      hasCleaned: true,
      changeCount: ch.changeCount,
      isLoaded: false,  // Not yet hydrated
      cachedChanges: ch.changes,  // Store for hydration on demand
      originalCharCount: ch.originalCharCount,
      cleanedCharCount: ch.cleanedCharCount
    }));

    // If job is incomplete, also get EPUB metadata to find chapters not yet cached
    if (!isComplete) {
      try {
        const epubResult = await this.electronService.getDiffMetadata(originalPath, cleanedPath);
        if (epubResult.success && epubResult.chapters) {
          // Add any chapters from EPUB that aren't in cache yet
          for (const epubCh of epubResult.chapters) {
            if (!cachedChapterIds.has(epubCh.id)) {
              chaptersMeta.push({
                id: epubCh.id,
                title: epubCh.title,
                hasOriginal: epubCh.hasOriginal,
                hasCleaned: epubCh.hasCleaned,
                isLoaded: false
                // No cachedChanges - will use on-demand loading
              });
            }
          }
          console.log(`[DiffService] Merged with EPUB metadata: ${chaptersMeta.length} total chapters`);
        }
      } catch (err) {
        console.warn('[DiffService] Failed to get EPUB metadata for incomplete job:', err);
        // Continue with just cached chapters
      }
    }

    // Create session
    const session: DiffSession = {
      originalPath,
      cleanedPath,
      chapters: [],  // Chapters hydrated on demand
      chaptersMeta,
      currentChapterId: chaptersMeta.length > 0 ? chaptersMeta[0].id : ''
    };

    this.sessionSubject.next(session);
    this.loadingSubject.next(false);
    this.loadingProgressSubject.next(null);

    // Auto-load the first chapter (will use hydration if cached)
    if (chaptersMeta.length > 0) {
      console.log('[DiffService] Loading first chapter from cache:', chaptersMeta[0].id);
      const chapter = await this.loadChapter(chaptersMeta[0].id);
      console.log('[DiffService] First chapter loaded:', chapter ? 'success' : 'failed');

      // Start background loading of remaining chapters
      this.startBackgroundLoading();
    }

    return true;
  }

  /**
   * Load comparison with on-demand diff computation.
   * Used as fallback when no pre-computed cache exists.
   */
  private async loadComparisonOnDemand(originalPath: string, cleanedPath: string): Promise<boolean> {
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
    // Re-fetch session at the START to get the most current state
    // (not from a captured variable that might be stale)
    let session = this.sessionSubject.getValue();
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

      // Re-fetch session since loadChapter may have updated it
      session = this.sessionSubject.getValue();
      if (!session) return;
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
      const diffWords = await this.computeDiff(truncatedOriginal, truncatedCleaned);

      // CRITICAL: Never update with empty diffWords - this would corrupt the session
      // This can happen if streaming was aborted or there was a computation error
      if (diffWords.length === 0) {
        console.log('[DiffService] loadMoreBackground: empty diff result, skipping update');
        return false;
      }

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

    // Try pre-computed cache hydration first (from .diff.json created during AI cleanup)
    if (meta.cachedChanges !== undefined) {
      console.log('[DiffService] loadChapter: hydrating from pre-computed cache');
      const hydrated = await this.loadChapterFromHydration(chapterId, meta, session);
      if (hydrated) {
        return hydrated;
      }
      // Hydration failed, fall through to disk cache/IPC
      console.log('[DiffService] loadChapter: hydration failed, falling back');
    }

    // Try disk cache second (per-chapter cache from previous sessions)
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

      const truncatedOriginal = originalText.slice(0, loadChars);
      const truncatedCleaned = cleanedText.slice(0, loadChars);
      const diffWords = await this.computeDiff(truncatedOriginal, truncatedCleaned);
      const changeCount = countChanges(diffWords);

      console.log('[DiffService] Diff complete:', diffWords.length, 'words,', changeCount, 'changes');

      if (diffWords.length === 0 && cleanedText.length > 0) {
        console.warn('[DiffService] Got empty diffWords for non-empty chapter - streaming may have been aborted');
      }

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
        const newSession = {
          ...currentSession,
          chapters: [...currentSession.chapters, chapter]
        };
        this.sessionSubject.next(newSession);
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

      // Start streaming the rest of the chapter in background
      this.startStreamingDiff(chapterId);

      return chapter;
    } catch (err) {
      this.errorSubject.next((err as Error).message);
      this.chapterLoadingSubject.next(false);
      this.loadingProgressSubject.next(null);
      return null;
    }
  }

  /**
   * Load chapter using hydration from pre-computed cache.
   * This is much faster than computing diff on-demand.
   */
  private async loadChapterFromHydration(
    chapterId: string,
    meta: DiffChapterMeta,
    session: DiffSession
  ): Promise<DiffChapter | null> {
    this.chapterLoadingSubject.next(true);
    this.loadingProgressSubject.next({
      phase: 'loading-chapter',
      currentChapter: 0,
      totalChapters: 1,
      chapterTitle: meta.title,
      percentage: 10
    });

    try {
      // Call hydration API
      const result = await this.electronService.hydrateChapter(
        session.cleanedPath,
        chapterId,
        meta.cachedChanges || []
      );

      if (!result.success || !result.data) {
        console.error('[DiffService] Hydration failed, falling back to on-demand loading');
        // Clear cached changes so we don't try hydration again
        meta.cachedChanges = undefined;
        // Fall through to regular loading
        this.chapterLoadingSubject.next(false);
        this.loadingProgressSubject.next(null);
        return null;
      }

      const { diffWords, cleanedText, originalText } = result.data;

      // Update metadata
      meta.isLoaded = true;
      meta.isOversized = false;  // Full chapter is loaded via hydration
      meta.changeCount = countChanges(diffWords);

      console.log('[DiffService] Hydration complete:', diffWords.length, 'words,', meta.changeCount, 'changes');

      const chapter: DiffChapter = {
        id: chapterId,
        title: meta.title,
        originalText,
        cleanedText,
        diffWords,
        changeCount: meta.changeCount,
        loadedChars: cleanedText.length,  // Fully loaded
        totalChars: cleanedText.length
      };

      // Add to session
      const currentSession = this.sessionSubject.getValue();
      if (currentSession) {
        this.evictOldestIfNeeded(currentSession);
        const newSession = {
          ...currentSession,
          chapters: [...currentSession.chapters, chapter]
        };
        this.sessionSubject.next(newSession);
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
      console.error('[DiffService] Hydration error:', err);
      // Clear cached changes so we don't try hydration again
      meta.cachedChanges = undefined;
      this.chapterLoadingSubject.next(false);
      this.loadingProgressSubject.next(null);
      return null;
    }
  }

  /**
   * Start streaming diff computation for a chapter.
   * Processes in small chunks, yielding to UI between each chunk.
   * Automatically stops when streamingAborted is set or chapter is fully loaded.
   */
  private startStreamingDiff(chapterId: string): void {
    // Abort any previous streaming
    this.streamingAborted = true;
    this.streamingGeneration++;
    const thisGeneration = this.streamingGeneration;

    // Use setTimeout to let the abort take effect
    setTimeout(() => {
      // Check if stopStreaming was called between scheduling and execution
      if (this.streamingGeneration !== thisGeneration || this.emissionsBlocked) {
        return;  // A newer stop/start happened, don't proceed
      }
      this.streamingAborted = false;
      this.emissionsBlocked = false;  // Re-enable emissions for new stream
      this.streamingChapterId = chapterId;
      this.streamDiffChunks(chapterId);
    }, 0);
  }

  /**
   * Process diff chunks incrementally. Non-blocking via setTimeout yielding.
   */
  private async streamDiffChunks(chapterId: string): Promise<void> {
    while (!this.streamingAborted && this.streamingChapterId === chapterId) {
      const session = this.sessionSubject.getValue();
      if (!session) break;

      const chapter = session.chapters.find(c => c.id === chapterId);
      if (!chapter) break;

      // Check if fully loaded
      if (chapter.loadedChars >= chapter.totalChars) {
        console.log('[DiffService] Streaming complete for chapter:', chapterId);
        break;
      }

      // Compute next chunk
      const newLoadedChars = Math.min(
        chapter.loadedChars + DIFF_CHUNK_SIZE,
        chapter.totalChars
      );

      try {
        // Yield to UI before heavy computation
        await new Promise(resolve => setTimeout(resolve, 0));

        if (this.streamingAborted || this.streamingChapterId !== chapterId) break;

        // Check abort before expensive operations
        if (this.streamingAborted || this.streamingChapterId !== chapterId) {
          console.log('[DiffService] Streaming aborted before compute');
          break;
        }

        const truncatedOriginal = chapter.originalText.slice(0, newLoadedChars);
        const truncatedCleaned = chapter.cleanedText.slice(0, newLoadedChars);
        const diffWords = await this.computeDiff(truncatedOriginal, truncatedCleaned);

        // Check abort immediately after compute (worker may have been terminated)
        if (this.streamingAborted || this.streamingChapterId !== chapterId) {
          console.log('[DiffService] Streaming aborted after compute');
          break;
        }

        // If diffWords is empty (aborted/error), skip update
        if (diffWords.length === 0) {
          console.log('[DiffService] Empty diff result, skipping update');
          break;
        }

        const changeCount = countChanges(diffWords);

        // Final abort check before emitting update
        if (this.streamingAborted || this.streamingChapterId !== chapterId || this.emissionsBlocked) {
          console.log('[DiffService] Streaming aborted before session update');
          break;
        }

        // Update chapter in session
        const currentSession = this.sessionSubject.getValue();
        if (!currentSession) break;

        const updatedChapter: DiffChapter = {
          ...chapter,
          diffWords,
          changeCount,
          loadedChars: newLoadedChars
        };

        const updatedChapters = currentSession.chapters.map(c =>
          c.id === chapterId ? updatedChapter : c
        );

        // Update metadata change count
        const meta = currentSession.chaptersMeta.find(m => m.id === chapterId);
        if (meta) {
          meta.changeCount = changeCount;
        }

        this.sessionSubject.next({
          ...currentSession,
          chapters: updatedChapters
        });

        // Longer delay between chunks to reduce main thread work
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (err) {
        console.error('[DiffService] Streaming chunk error:', err);
        break;
      }
    }

    // Clear streaming state if this was the active stream
    if (this.streamingChapterId === chapterId) {
      this.streamingChapterId = null;
    }
  }

  /**
   * Stop any active streaming diff computation.
   * Call this when user navigates away from the diff view.
   */
  stopStreaming(): void {
    console.log('[DiffService] stopStreaming called');

    // Block all emissions FIRST
    this.emissionsBlocked = true;

    this.streamingAborted = true;
    this.streamingChapterId = null;
    this.streamingGeneration++;  // Invalidate any pending setTimeout callbacks

    // Cancel any pending worker requests
    for (const [id, pending] of this.pendingWorkerRequests) {
      pending.reject(new Error('Streaming stopped'));
    }
    this.pendingWorkerRequests.clear();

    // Terminate worker to free resources
    if (this.diffWorker) {
      this.diffWorker.terminate();
      this.diffWorker = null;
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
        const cached = result.data as CachedChapterData;

        // CRITICAL: Reject corrupted cache entries (empty diffWords but has content)
        // This can happen if a previous session crashed or had a race condition
        if (cached.diffWords.length === 0 && cached.totalChars > 0) {
          console.warn('[DiffService] Ignoring corrupted cache (empty diffWords) for chapter:', chapterId);
          return null;
        }

        return cached;
      }
    } catch (err) {
      console.error('[DiffService] Cache load error:', err);
    }
    return null;
  }

  private async saveToCache(originalPath: string, cleanedPath: string, chapterId: string, data: CachedChapterData): Promise<void> {
    // CRITICAL: Never save empty diffWords - this would corrupt the cache
    // and cause all future loads to show "no changes"
    if (data.diffWords.length === 0 && data.totalChars > 0) {
      console.warn('[DiffService] Refusing to save empty diffWords to cache for chapter:', chapterId);
      return;
    }

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

    // Stop streaming the previous chapter
    this.streamingAborted = true;

    // Update current chapter ID
    this.sessionSubject.next({
      ...session,
      currentChapterId: chapterId
    });

    // Load chapter if not already loaded
    if (!meta.isLoaded) {
      // Reset streamingAborted before loading - we just used it to stop previous streaming
      this.streamingAborted = false;
      await this.loadChapter(chapterId);
    } else {
      // Chapter is loaded, but may not be fully streamed - restart streaming
      const chapter = session.chapters.find(c => c.id === chapterId);
      if (chapter && chapter.loadedChars < chapter.totalChars) {
        this.startStreamingDiff(chapterId);
      }
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
      const diffWords = await this.computeDiff(truncatedOriginal, truncatedCleaned);
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
    this.streamingAborted = true;
    this.streamingChapterId = null;
    this.sessionSubject.next(null);
    this.errorSubject.next(null);
    this.cachedChapterIds = [];
  }

  /**
   * Check if whitespace is being ignored in diffs.
   */
  isIgnoringWhitespace(): boolean {
    return this.settingsService.get<boolean>('diffIgnoreWhitespace') ?? true;
  }

  /**
   * Toggle the ignore whitespace setting and recompute the current chapter's diff.
   */
  async toggleIgnoreWhitespace(): Promise<void> {
    const current = this.isIgnoringWhitespace();
    this.settingsService.set('diffIgnoreWhitespace', !current);
    await this.recomputeCurrentChapterDiff();
  }

  /**
   * Recompute the diff for the current chapter with current settings.
   * Call this after changing diff-related settings.
   */
  async recomputeCurrentChapterDiff(): Promise<void> {
    const session = this.sessionSubject.getValue();
    if (!session) return;

    const chapter = session.chapters.find(c => c.id === session.currentChapterId);
    if (!chapter) return;

    this.chapterLoadingSubject.next(true);

    try {
      // Recompute diff with current settings
      const truncatedOriginal = chapter.originalText.slice(0, chapter.loadedChars);
      const truncatedCleaned = chapter.cleanedText.slice(0, chapter.loadedChars);
      const diffWords = await this.computeDiff(truncatedOriginal, truncatedCleaned);
      const changeCount = countChanges(diffWords);

      // Update chapter
      const updatedChapter: DiffChapter = {
        ...chapter,
        diffWords,
        changeCount
      };

      // Update session
      const currentSession = this.sessionSubject.getValue();
      if (!currentSession) return;

      const updatedChapters = currentSession.chapters.map(c =>
        c.id === chapter.id ? updatedChapter : c
      );

      // Update metadata
      const meta = currentSession.chaptersMeta.find(m => m.id === chapter.id);
      if (meta) {
        meta.changeCount = changeCount;
      }

      this.sessionSubject.next({
        ...currentSession,
        chapters: updatedChapters
      });

      // Clear disk cache since settings changed
      await this.clearCache();
    } finally {
      this.chapterLoadingSubject.next(false);
    }
  }
}

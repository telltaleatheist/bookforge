import { Injectable, inject, signal } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';

/**
 * PageRenderService - Manages pre-rendered page images with two-tier caching
 *
 * New approach:
 * 1. First render low-res previews quickly (0.5x scale)
 * 2. Show previews immediately so user can start working
 * 3. Background render high-res versions (2.5x scale)
 * 4. Replace previews with high-res as they complete
 * 5. All cached persistently to disk for instant reload
 */
@Injectable({
  providedIn: 'root'
})
export class PageRenderService {
  private readonly electronService = inject(ElectronService);

  // Page file paths - maps page number to file path
  private previewPaths: string[] = [];
  private fullPaths: string[] = [];
  private currentFileHash: string = '';

  // Loading state
  readonly isLoading = signal(false);
  readonly loadingProgress = signal({ current: 0, total: 0, phase: 'preview' as 'preview' | 'full' });
  readonly isUpgradingToFull = signal(false);

  // Page images signal (for compatibility with existing code)
  readonly pageImages = signal<Map<number, string>>(new Map());

  // Current document context
  private currentPdfPath: string = '';
  private currentTotalPages: number = 0;
  // Cache-buster: changes on each document open to invalidate stale browser cache
  private cacheBuster: string = '';
  // Generation token: incremented on every initialize()/clear(). Async work
  // captures the generation at entry and abandons its results if the document
  // changed while it was awaiting — otherwise a stale render for document A
  // writes its page paths into document B's state.
  private generation = 0;

  // Callbacks
  private progressUnsubscribe: (() => void) | null = null;
  private upgradeUnsubscribe: (() => void) | null = null;

  // On-demand rendering state
  private inFlightPages = new Set<number>();
  private demandDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDemandPages = new Set<number>();
  private fullResIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVisiblePages: number[] = [];
  private readonly onDemandMode = signal(false);
  private backgroundUpgradeRunning = false;
  private backgroundUpgradeCancelled = false;

  /**
   * Initialize for a new document
   */
  initialize(pdfPath: string, totalPages: number): void {
    this.currentPdfPath = pdfPath;
    this.currentTotalPages = totalPages;
    // New cache buster per document open — invalidates any stale browser-cached images
    this.cacheBuster = Date.now().toString(36);
    this.clear();
  }

  /**
   * Clear all cached paths and reset state
   */
  clear(): void {
    this.generation++;
    this.previewPaths = [];
    this.fullPaths = [];
    this.pageImages.set(new Map());
    this.loadingProgress.set({ current: 0, total: 0, phase: 'preview' });
    this.isLoading.set(false);
    this.isUpgradingToFull.set(false);
    this.unsubscribe();
    // Clear on-demand state
    this.inFlightPages.clear();
    this.pendingDemandPages.clear();
    this.onDemandMode.set(false);
    this.backgroundUpgradeCancelled = true;
    this.backgroundUpgradeRunning = false;
    if (this.demandDebounceTimer) {
      clearTimeout(this.demandDebounceTimer);
      this.demandDebounceTimer = null;
    }
    if (this.fullResIdleTimer) {
      clearTimeout(this.fullResIdleTimer);
      this.fullResIdleTimer = null;
    }
    this.lastVisiblePages = [];
  }

  private unsubscribe(): void {
    if (this.progressUnsubscribe) {
      this.progressUnsubscribe();
      this.progressUnsubscribe = null;
    }
    if (this.upgradeUnsubscribe) {
      this.upgradeUnsubscribe();
      this.upgradeUnsubscribe = null;
    }
  }

  /**
   * Get the image URL for a page.
   * Returns full-res if available, otherwise preview.
   */
  getPageImageUrl(pageNum: number): string {
    // Prefer full-res if available
    const fullPath = this.fullPaths[pageNum];
    if (fullPath) {
      if (fullPath.startsWith('__data__')) {
        return fullPath.substring(8);
      }
      // Normalize path separators to forward slashes for URL
      // Append cache buster to bypass stale browser cache entries
      return `bookforge-page://${fullPath.replace(/\\/g, '/')}?v=${this.cacheBuster}`;
    }

    // Fall back to preview
    const previewPath = this.previewPaths[pageNum];
    if (previewPath) {
      return `bookforge-page://${previewPath.replace(/\\/g, '/')}?v=${this.cacheBuster}`;
    }

    return '';
  }

  /**
   * Check if a page has full-res image
   */
  isPageFullRes(pageNum: number): boolean {
    return !!this.fullPaths[pageNum];
  }

  /**
   * Check if all pages are loaded (at least preview)
   */
  areAllPagesLoaded(): boolean {
    return this.previewPaths.length === this.currentTotalPages &&
           this.previewPaths.every(p => !!p);
  }

  /**
   * Get the current file hash
   */
  getFileHash(): string {
    return this.currentFileHash;
  }

  /**
   * Load all pages with two-tier approach:
   * 1. Render previews first (fast, ~0.5s for 200 pages)
   * 2. Start background high-res rendering
   * 3. Update UI as high-res pages complete
   */
  async loadAllPageImages(pageCount?: number): Promise<void> {
    const count = pageCount ?? this.currentTotalPages;
    if (!this.currentPdfPath || count === 0) return;
    const gen = this.generation;

    this.isLoading.set(true);
    this.loadingProgress.set({ current: 0, total: count, phase: 'preview' });

    // Subscribe to progress updates (only show preview phase progress)
    this.progressUnsubscribe = this.electronService.onRenderProgress((progress) => {
      // Only update UI for preview phase - full phase runs silently in background
      if (progress.phase === 'preview' || !progress.phase) {
        this.loadingProgress.set({
          current: progress.current,
          total: progress.total,
          phase: 'preview'
        });
      }
    });

    // Subscribe to page upgrade notifications
    this.upgradeUnsubscribe = this.electronService.onPageUpgraded((data) => {
      if (gen !== this.generation) return; // stale event from a previous document
      this.fullPaths[data.pageNum] = data.path;
      this.updatePageImagesSignal();
    });

    try {
      const result = await this.electronService.renderWithPreviews(
        this.currentPdfPath,
        4 // concurrency
      );

      if (result && gen === this.generation) {
        this.previewPaths = result.previewPaths;
        this.currentFileHash = result.fileHash;
        this.updatePageImagesSignal();

        // Mark that high-res is rendering in background
        this.isUpgradingToFull.set(true);
      }
    } finally {
      this.isLoading.set(false);
      // Don't unsubscribe upgrade listener - we want to keep receiving updates
      if (this.progressUnsubscribe) {
        this.progressUnsubscribe();
        this.progressUnsubscribe = null;
      }
    }
  }

  /**
   * Start on-demand rendering for a new document.
   * Renders previews for ALL pages (cached pages resolve instantly via disk lookup).
   * Then starts a background pass to upgrade everything to full-res.
   */
  async startOnDemandRendering(pageCount?: number): Promise<void> {
    const count = pageCount ?? this.currentTotalPages;
    if (!this.currentPdfPath || count === 0) return;

    this.onDemandMode.set(true);
    this.isLoading.set(true);
    this.backgroundUpgradeCancelled = false;

    try {
      // Render ALL pages as previews in batches.
      // For cached documents this is nearly instant (disk cache lookups).
      const allPages = Array.from({ length: count }, (_, i) => i);
      await this.requestPagesImmediate(allPages, 'preview');
    } finally {
      this.isLoading.set(false);
    }

    // Start background full-res upgrade for ALL pages
    this.startBackgroundFullResUpgrade();
  }

  /**
   * Background full-res upgrade: systematically upgrades ALL pages to full-res
   * in small batches, yielding between batches to keep the UI responsive.
   */
  private async startBackgroundFullResUpgrade(): Promise<void> {
    if (this.backgroundUpgradeRunning) return;
    this.backgroundUpgradeRunning = true;
    const gen = this.generation;

    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 200; // Pause between batches to yield to UI

    try {
      for (let i = 0; i < this.currentTotalPages; i += BATCH_SIZE) {
        if (gen !== this.generation || this.backgroundUpgradeCancelled || !this.currentPdfPath) break;

        // Collect pages in this batch that need full-res
        const batch: number[] = [];
        for (let j = i; j < Math.min(i + BATCH_SIZE, this.currentTotalPages); j++) {
          if (!this.fullPaths[j] && this.previewPaths[j] && !this.inFlightPages.has(j)) {
            batch.push(j);
          }
        }

        if (batch.length > 0) {
          await this.requestPagesImmediate(batch, 'full');
        }

        // Yield to event loop between batches
        if (i + BATCH_SIZE < this.currentTotalPages) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
    } finally {
      this.backgroundUpgradeRunning = false;
    }
  }

  /**
   * Request pages to be rendered on demand (debounced).
   * Called when the visible page range changes (scroll).
   * Filters out already-rendered and in-flight pages.
   */
  requestPages(pageNumbers: number[]): void {
    if (!this.currentPdfPath || !this.onDemandMode()) return;

    // Add to pending set
    for (const p of pageNumbers) {
      if (p >= 0 && p < this.currentTotalPages && !this.previewPaths[p] && !this.inFlightPages.has(p)) {
        this.pendingDemandPages.add(p);
      }
    }

    // Track visible pages for full-res upgrade
    this.lastVisiblePages = pageNumbers;

    if (this.pendingDemandPages.size === 0 && this.inFlightPages.size === 0) {
      // All visible pages have previews and nothing is in-flight — upgrade to full-res
      this.scheduleFullResUpgrade(pageNumbers);
      return;
    }

    // Debounce: flush pending pages after 50ms
    if (this.demandDebounceTimer) {
      clearTimeout(this.demandDebounceTimer);
    }
    this.demandDebounceTimer = setTimeout(() => {
      this.demandDebounceTimer = null;
      const pages = Array.from(this.pendingDemandPages);
      this.pendingDemandPages.clear();
      if (pages.length > 0) {
        this.requestPagesImmediate(pages, 'preview');
      }
    }, 50);
  }

  // Max pages per IPC call
  private readonly RENDER_BATCH_SIZE = 50;
  // How often to update the UI signal (every N pages rendered)
  private readonly SIGNAL_UPDATE_INTERVAL = 100;

  /**
   * Immediately request rendering of specific pages (no debounce).
   * Batches large requests to avoid blocking the Electron main process.
   * Retries failed pages once after a short delay.
   */
  private async requestPagesImmediate(pageNumbers: number[], quality: 'preview' | 'full'): Promise<void> {
    if (!this.currentPdfPath) return;
    // Capture the document context — if the document changes mid-flight,
    // results are discarded rather than written into the new document's state
    const gen = this.generation;
    const pdfPath = this.currentPdfPath;

    // Filter out already-rendered and in-flight pages
    const toRender = pageNumbers.filter(p => {
      if (p < 0 || p >= this.currentTotalPages) return false;
      if (this.inFlightPages.has(p)) return false;
      if (quality === 'preview' && this.previewPaths[p]) return false;
      if (quality === 'full' && this.fullPaths[p]) return false;
      return true;
    });

    if (toRender.length === 0) return;

    // Mark as in-flight
    for (const p of toRender) {
      this.inFlightPages.add(p);
    }

    const failedPages: number[] = [];
    let pagesSinceLastSignal = 0;

    try {
      // Batch into chunks to avoid long-blocking IPC calls
      for (let i = 0; i < toRender.length; i += this.RENDER_BATCH_SIZE) {
        // Full-res batches yield to pending preview requests (previews take priority)
        if (quality === 'full' && this.pendingDemandPages.size > 0) {
          break;
        }

        const batch = toRender.slice(i, i + this.RENDER_BATCH_SIZE);

        const result = await this.electronService.renderPages(
          pdfPath,
          batch,
          quality
        );

        // Document changed while we were rendering — discard stale results
        if (gen !== this.generation) return;

        // Update paths with results from this batch
        for (const [pageNumStr, filePath] of Object.entries(result)) {
          const pageNum = Number(pageNumStr);
          if (quality === 'preview') {
            this.previewPaths[pageNum] = filePath;
          } else {
            this.fullPaths[pageNum] = filePath;
          }
        }

        // Track pages that the backend failed to render
        for (const p of batch) {
          if (!(String(p) in result)) {
            failedPages.push(p);
          }
        }

        // Throttle signal updates: update every ~100 pages or on last batch
        pagesSinceLastSignal += batch.length;
        const isLastBatch = i + this.RENDER_BATCH_SIZE >= toRender.length;
        if (pagesSinceLastSignal >= this.SIGNAL_UPDATE_INTERVAL || isLastBatch) {
          this.updatePageImagesSignal();
          pagesSinceLastSignal = 0;
        }
      }
    } finally {
      // Only release in-flight markers for our own generation — after a
      // document switch the set tracks the new document's requests
      if (gen === this.generation) {
        for (const p of toRender) {
          this.inFlightPages.delete(p);
        }
      }
    }

    // Retry failed pages once after a short delay
    if (failedPages.length > 0) {
      console.warn(`[page-render] ${failedPages.length} pages failed to render, retrying in 500ms:`, failedPages);
      setTimeout(() => {
        if (gen === this.generation && this.currentPdfPath) {
          this.requestPagesImmediate(failedPages, quality);
        }
      }, 500);
    }

    // After preview batches complete, schedule full-res upgrade for visible pages.
    // The 300ms idle timer in scheduleFullResUpgrade resets on each scroll,
    // so upgrades only start when the user stops scrolling.
    if (quality === 'preview') {
      this.scheduleFullResUpgrade(this.lastVisiblePages);
    }
  }

  /**
   * Schedule full-res upgrade for visible pages after scroll stops (300ms idle).
   * Prioritizes visible pages, then restarts background upgrade for the rest.
   */
  private scheduleFullResUpgrade(pageNumbers: number[]): void {
    if (this.fullResIdleTimer) {
      clearTimeout(this.fullResIdleTimer);
    }

    const gen = this.generation;
    this.fullResIdleTimer = setTimeout(async () => {
      this.fullResIdleTimer = null;
      if (gen !== this.generation) return; // document changed
      // Prioritize visible pages for immediate upgrade
      const toUpgrade = pageNumbers.filter(p =>
        p >= 0 && p < this.currentTotalPages &&
        this.previewPaths[p] && !this.fullPaths[p] &&
        !this.inFlightPages.has(p)
      );
      if (toUpgrade.length > 0) {
        await this.requestPagesImmediate(toUpgrade, 'full');
      }
      // Restart background upgrade if it stopped
      if (!this.backgroundUpgradeRunning && !this.backgroundUpgradeCancelled) {
        this.startBackgroundFullResUpgrade();
      }
    }, 300);
  }

  /**
   * Close the document and free backend resources.
   * Call when navigating away from the PDF viewer.
   */
  async closeDocument(): Promise<void> {
    this.clear();
    await this.electronService.closeRenderDoc();
  }

  /**
   * Check if we're in on-demand rendering mode
   */
  isOnDemandMode(): boolean {
    return this.onDemandMode();
  }

  /**
   * Update the pageImages signal from paths
   */
  private updatePageImagesSignal(): void {
    const map = new Map<number, string>();
    const maxLen = Math.max(this.previewPaths.length, this.fullPaths.length);

    for (let i = 0; i < maxLen; i++) {
      const url = this.getPageImageUrl(i);
      if (url) {
        map.set(i, url);
      }
    }

    this.pageImages.set(map);
  }

  /**
   * Get render scale (for compatibility)
   */
  getRenderScale(pageCount?: number): number {
    const count = pageCount ?? this.currentTotalPages;
    if (count > 500) return 1.5;
    if (count > 200) return 2.0;
    return 2.5;
  }

  /**
   * Get the current page images map
   */
  getPageImagesMap(): Map<number, string> {
    return new Map(this.pageImages());
  }

  /**
   * Restore page images from saved state
   */
  restorePageImages(images: Map<number, string>): void {
    this.previewPaths = [];
    this.fullPaths = [];

    images.forEach((url, pageNum) => {
      if (url.startsWith('bookforge-page://')) {
        // Strip protocol and any cache-buster query string
        let filePath = url.substring(17);
        const qIdx = filePath.indexOf('?');
        if (qIdx !== -1) filePath = filePath.substring(0, qIdx);
        // Route to the correct tier based on the cache directory — calling a
        // preview "full-res" would permanently block its upgrade
        // (check both separators: Windows paths may carry backslashes)
        if (filePath.includes('/preview/') || filePath.includes('\\preview\\')) {
          this.previewPaths[pageNum] = filePath;
        } else {
          this.fullPaths[pageNum] = filePath;
        }
      } else if (url.startsWith('file://')) {
        this.fullPaths[pageNum] = url.substring(7);
      } else if (url.startsWith('data:')) {
        this.fullPaths[pageNum] = `__data__${url}`;
      }
    });

    this.updatePageImagesSignal();
  }

  /**
   * Invalidate a page's cached image
   */
  invalidatePage(pageNum: number): void {
    if (pageNum >= 0) {
      if (pageNum < this.previewPaths.length) {
        this.previewPaths[pageNum] = '';
      }
      if (pageNum < this.fullPaths.length) {
        this.fullPaths[pageNum] = '';
      }
      this.updatePageImagesSignal();
    }
  }

  /**
   * Re-render a page from the original PDF (no redactions)
   * Used when undoing deletions to restore the original image
   */
  async rerenderPageFromOriginal(pageNum: number): Promise<string | null> {
    if (!this.currentPdfPath) return null;
    const gen = this.generation;

    const scale = this.getRenderScale();
    const dataUrl = await this.electronService.renderPage(
      pageNum,
      scale,
      this.currentPdfPath
      // No redactRegions - render original
    );

    if (dataUrl && gen === this.generation) {
      this.fullPaths[pageNum] = `__data__${dataUrl}`;
      this.updatePageImagesSignal();
    }

    return dataUrl;
  }

  /**
   * Re-render a page with redactions and/or background fills applied.
   * @param redactRegions - Regions to redact (remove content completely)
   * @param fillRegions - Regions to fill with background color (for moved blocks)
   */
  async rerenderPageWithRedactions(
    pageNum: number,
    redactRegions?: Array<{ x: number; y: number; width: number; height: number; isImage?: boolean }>,
    fillRegions?: Array<{ x: number; y: number; width: number; height: number }>
  ): Promise<string | null> {
    if (!this.currentPdfPath) return null;
    const gen = this.generation;

    const scale = this.getRenderScale();
    const dataUrl = await this.electronService.renderPage(
      pageNum,
      scale,
      this.currentPdfPath,
      redactRegions,
      fillRegions
    );

    if (dataUrl && gen === this.generation) {
      this.fullPaths[pageNum] = `__data__${dataUrl}`;
      this.updatePageImagesSignal();
    }

    return dataUrl;
  }

  /**
   * Render a blank white page (for removing background images)
   * Text will be shown via overlays
   */
  async renderBlankPage(pageNum: number): Promise<string | null> {
    const gen = this.generation;
    const scale = this.getRenderScale();
    const dataUrl = await this.electronService.renderBlankPage(pageNum, scale);

    if (dataUrl && gen === this.generation) {
      this.fullPaths[pageNum] = `__data__${dataUrl}`;
      this.updatePageImagesSignal();
    }

    return dataUrl;
  }

  /**
   * Render all pages as blank white pages
   */
  async renderAllBlankPages(totalPages: number): Promise<void> {
    for (let i = 0; i < totalPages; i++) {
      await this.renderBlankPage(i);
    }
  }

  /**
   * Clear cache for the current file
   */
  async clearCurrentCache(): Promise<void> {
    if (this.currentFileHash) {
      await this.electronService.clearCache(this.currentFileHash);
      this.clear();
    }
  }

  /**
   * Get cache size for current file
   */
  async getCurrentCacheSize(): Promise<number> {
    if (this.currentFileHash) {
      return this.electronService.getCacheSize(this.currentFileHash);
    }
    return 0;
  }
}

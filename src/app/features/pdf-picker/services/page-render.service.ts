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

  /**
   * Initialize for a new document
   */
  initialize(pdfPath: string, totalPages: number): void {
    this.currentPdfPath = pdfPath;
    this.currentTotalPages = totalPages;
    this.clear();
  }

  /**
   * Clear all cached paths and reset state
   */
  clear(): void {
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
      return `bookforge-page://${fullPath.replace(/\\/g, '/')}`;
    }

    // Fall back to preview
    const previewPath = this.previewPaths[pageNum];
    if (previewPath) {
      // Normalize path separators to forward slashes for URL
      return `bookforge-page://${previewPath.replace(/\\/g, '/')}`;
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
      this.fullPaths[data.pageNum] = data.path;
      this.updatePageImagesSignal();
    });

    try {
      const result = await this.electronService.renderWithPreviews(
        this.currentPdfPath,
        4 // concurrency
      );

      if (result) {
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
   * Renders only the first viewport of pages immediately, then renders
   * additional pages as the user scrolls (via requestPages).
   */
  async startOnDemandRendering(pageCount?: number): Promise<void> {
    const count = pageCount ?? this.currentTotalPages;
    if (!this.currentPdfPath || count === 0) return;

    this.onDemandMode.set(true);
    this.isLoading.set(true);

    try {
      // Render the first viewport (~15 pages)
      const initialPages = Array.from({ length: Math.min(15, count) }, (_, i) => i);
      await this.requestPagesImmediate(initialPages, 'preview');
    } finally {
      this.isLoading.set(false);
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

  // Max pages per IPC call to avoid blocking the main process
  private readonly RENDER_BATCH_SIZE = 20;

  /**
   * Immediately request rendering of specific pages (no debounce).
   * Batches large requests to avoid blocking the Electron main process.
   */
  private async requestPagesImmediate(pageNumbers: number[], quality: 'preview' | 'full'): Promise<void> {
    if (!this.currentPdfPath) return;

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

    try {
      // Batch into chunks to avoid long-blocking IPC calls
      for (let i = 0; i < toRender.length; i += this.RENDER_BATCH_SIZE) {
        // Full-res batches yield to pending preview requests (previews take priority)
        if (quality === 'full' && this.pendingDemandPages.size > 0) {
          break;
        }

        const batch = toRender.slice(i, i + this.RENDER_BATCH_SIZE);

        const result = await this.electronService.renderPages(
          this.currentPdfPath,
          batch,
          quality
        );

        // Update paths with results from this batch
        for (const [pageNumStr, filePath] of Object.entries(result)) {
          const pageNum = Number(pageNumStr);
          if (quality === 'preview') {
            this.previewPaths[pageNum] = filePath;
          } else {
            this.fullPaths[pageNum] = filePath;
          }
        }

        // Update UI after each batch so pages appear progressively
        this.updatePageImagesSignal();
      }
    } finally {
      for (const p of toRender) {
        this.inFlightPages.delete(p);
      }
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
   */
  private scheduleFullResUpgrade(pageNumbers: number[]): void {
    if (this.fullResIdleTimer) {
      clearTimeout(this.fullResIdleTimer);
    }

    this.fullResIdleTimer = setTimeout(() => {
      this.fullResIdleTimer = null;
      // Only upgrade pages that have preview but not full-res
      const toUpgrade = pageNumbers.filter(p =>
        p >= 0 && p < this.currentTotalPages &&
        this.previewPaths[p] && !this.fullPaths[p] &&
        !this.inFlightPages.has(p)
      );
      if (toUpgrade.length > 0) {
        this.requestPagesImmediate(toUpgrade, 'full');
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
        // Assume full-res for restored images
        this.fullPaths[pageNum] = url.substring(17);
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

    const scale = this.getRenderScale();
    const dataUrl = await this.electronService.renderPage(
      pageNum,
      scale,
      this.currentPdfPath
      // No redactRegions - render original
    );

    if (dataUrl) {
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

    const scale = this.getRenderScale();
    const dataUrl = await this.electronService.renderPage(
      pageNum,
      scale,
      this.currentPdfPath,
      redactRegions,
      fillRegions
    );

    if (dataUrl) {
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
    const scale = this.getRenderScale();
    const dataUrl = await this.electronService.renderBlankPage(pageNum, scale);

    if (dataUrl) {
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

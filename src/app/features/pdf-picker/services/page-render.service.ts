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
      return `bookforge-page://${fullPath}`;
    }

    // Fall back to preview
    const previewPath = this.previewPaths[pageNum];
    if (previewPath) {
      return `bookforge-page://${previewPath}`;
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

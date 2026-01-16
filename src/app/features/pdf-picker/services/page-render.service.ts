import { Injectable, inject, signal } from '@angular/core';
import { PdfService } from './pdf.service';

type PageImageStatus = string; // 'loading' | 'failed' | data URL

/**
 * PageRenderService - Manages page image rendering with throttled queue
 *
 * Handles:
 * - Concurrent render limiting (prevents memory issues)
 * - Page load queue with priority
 * - Image caching
 * - Scale calculation based on document size
 */
@Injectable({
  providedIn: 'root'
})
export class PageRenderService {
  private readonly pdfService = inject(PdfService);

  // Page images cache - maps page number to data URL or status
  readonly pageImages = signal<Map<number, PageImageStatus>>(new Map());

  // Queue management
  private pageLoadQueue: number[] = [];
  private activeRenders = 0;
  private readonly MAX_CONCURRENT_RENDERS = 2;

  // Current document context
  private currentPdfPath: string = '';
  private currentTotalPages: number = 0;

  /**
   * Initialize for a new document
   */
  initialize(pdfPath: string, totalPages: number): void {
    this.currentPdfPath = pdfPath;
    this.currentTotalPages = totalPages;
    this.clear();
  }

  /**
   * Clear all cached images and reset state
   */
  clear(): void {
    this.pageImages.set(new Map());
    this.pageLoadQueue = [];
    this.activeRenders = 0;
  }

  /**
   * Get the image URL for a page, queueing load if needed
   * Returns: data URL, 'loading', or '' (empty for not started)
   */
  getPageImageUrl(pageNum: number): string {
    const cached = this.pageImages().get(pageNum);
    if (cached && cached !== 'loading' && cached !== 'failed') {
      return cached;
    }
    // Queue this page for loading
    this.queuePageLoad(pageNum);
    // Return 'loading' so template can show placeholder
    return cached === 'loading' ? 'loading' : '';
  }

  /**
   * Check if a page image is loaded (not loading, not failed)
   */
  isPageLoaded(pageNum: number): boolean {
    const status = this.pageImages().get(pageNum);
    return !!status && status !== 'loading' && status !== 'failed';
  }

  /**
   * Get render scale based on document size
   * Higher values = sharper but more memory
   */
  getRenderScale(pageCount?: number): number {
    const count = pageCount ?? this.currentTotalPages;
    if (count > 1000) return 2.0;
    if (count > 500) return 2.5;
    return 3.0; // 3x scale for crisp text
  }

  /**
   * Load all page images with priority loading
   */
  async loadAllPageImages(pageCount?: number): Promise<void> {
    const count = pageCount ?? this.currentTotalPages;
    const scale = this.getRenderScale(count);

    // Load first 5 pages immediately (sequentially for fast display)
    const priorityPages = Math.min(count, 5);
    for (let i = 0; i < priorityPages; i++) {
      await this.loadPageImage(i, scale);
    }

    // Queue all remaining pages
    for (let i = priorityPages; i < count; i++) {
      this.pageLoadQueue.push(i);
    }

    // Start processing queue with concurrency
    this.processQueue();
  }

  /**
   * Queue a single page for loading
   */
  private queuePageLoad(pageNum: number): void {
    const current = this.pageImages().get(pageNum);
    if (current && current !== 'failed') return;

    if (!this.pageLoadQueue.includes(pageNum)) {
      this.pageLoadQueue.push(pageNum);
    }
    this.processQueue();
  }

  /**
   * Process the render queue with concurrency limiting
   */
  private async processQueue(): Promise<void> {
    while (this.pageLoadQueue.length > 0 && this.activeRenders < this.MAX_CONCURRENT_RENDERS) {
      const pageNum = this.pageLoadQueue.shift()!;
      this.activeRenders++;

      const scale = this.getRenderScale();
      this.loadPageImage(pageNum, scale).finally(() => {
        this.activeRenders--;
        this.processQueue();
      });
    }
  }

  /**
   * Load a single page image
   */
  private async loadPageImage(pageNum: number, scale: number): Promise<void> {
    // Check if already loaded
    const current = this.pageImages().get(pageNum);
    if (current && current !== 'failed' && current !== 'loading') return;

    // Mark as loading
    this.updatePageImage(pageNum, 'loading');

    try {
      if (!this.currentPdfPath) return;

      const dataUrl = await this.pdfService.renderPage(pageNum, scale, this.currentPdfPath);
      if (dataUrl) {
        this.updatePageImage(pageNum, dataUrl);
      } else {
        this.updatePageImage(pageNum, 'failed');
      }
    } catch {
      this.updatePageImage(pageNum, 'failed');
    }
  }

  /**
   * Update a single page's image status
   */
  private updatePageImage(pageNum: number, status: PageImageStatus): void {
    this.pageImages.update(map => {
      const newMap = new Map(map);
      newMap.set(pageNum, status);
      return newMap;
    });
  }

  /**
   * Get the current page images map (for saving state)
   */
  getPageImagesMap(): Map<number, string> {
    return new Map(this.pageImages());
  }

  /**
   * Restore page images from saved state
   */
  restorePageImages(images: Map<number, string>): void {
    this.pageImages.set(new Map(images));
  }

  /**
   * Re-render a page with redactions applied
   * Used when blocks are edited/moved to hide original text
   */
  async rerenderPageWithRedactions(
    pageNum: number,
    redactRegions: Array<{ x: number; y: number; width: number; height: number }>
  ): Promise<void> {
    if (!this.currentPdfPath) return;

    // Mark as loading while re-rendering
    this.updatePageImage(pageNum, 'loading');

    try {
      const scale = this.getRenderScale();
      const dataUrl = await this.pdfService.renderPage(pageNum, scale, this.currentPdfPath, redactRegions);
      if (dataUrl) {
        this.updatePageImage(pageNum, dataUrl);
      } else {
        this.updatePageImage(pageNum, 'failed');
      }
    } catch {
      this.updatePageImage(pageNum, 'failed');
    }
  }

  /**
   * Invalidate a page's cached image (will be reloaded on next access)
   */
  invalidatePage(pageNum: number): void {
    this.pageImages.update(map => {
      const newMap = new Map(map);
      newMap.delete(pageNum);
      return newMap;
    });
  }
}

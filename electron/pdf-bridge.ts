/**
 * PDF Bridge - Abstraction layer for PDF manipulation
 *
 * This provides a unified interface for PDF operations that can be implemented
 * by different backends:
 * - PyMuPDF via subprocess (current)
 * - Compiled binary (future)
 * - Native JS library if one ever works (future)
 */

export interface RedactionRegion {
  page: number;      // 0-indexed page number
  x: number;         // Left edge in screen coords
  y: number;         // Top edge in screen coords (y=0 at top)
  width: number;
  height: number;
  isImage?: boolean; // True if this is an image region
}

export interface Bookmark {
  title: string;
  page: number;   // 0-indexed, should already account for deleted pages
  level: number;  // 1 = top level, 2 = subsection, etc.
}

export interface RedactionOptions {
  deletedPages?: number[];  // Pages to delete entirely (0-indexed)
  removeImages?: boolean;   // Whether to remove images in regions
  removeText?: boolean;     // Whether to remove text in regions
  bookmarks?: Bookmark[];   // Bookmarks/TOC to add
}

export interface PdfBridge {
  /**
   * Check if this bridge implementation is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get the name of this implementation
   */
  getName(): string;

  /**
   * Redact regions from a PDF
   * @param inputPath Path to source PDF
   * @param outputPath Path for output PDF
   * @param regions Array of regions to redact
   * @param options Additional options
   */
  redact(
    inputPath: string,
    outputPath: string,
    regions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void>;

  /**
   * Delete pages from a PDF
   * @param inputPath Path to source PDF
   * @param outputPath Path for output PDF
   * @param pages Page numbers to delete (0-indexed)
   */
  deletePages(
    inputPath: string,
    outputPath: string,
    pages: number[]
  ): Promise<void>;
}

/**
 * PDF Bridge Manager - Handles bridge selection and fallback
 */
class PdfBridgeManager {
  private bridges: PdfBridge[] = [];
  private activeBridge: PdfBridge | null = null;

  /**
   * Register a bridge implementation
   */
  register(bridge: PdfBridge): void {
    this.bridges.push(bridge);
  }

  /**
   * Initialize and select the best available bridge
   */
  async initialize(): Promise<PdfBridge> {
    for (const bridge of this.bridges) {
      try {
        if (await bridge.isAvailable()) {
          this.activeBridge = bridge;
          console.log(`[PdfBridge] Using ${bridge.getName()}`);
          return bridge;
        }
      } catch (e) {
        console.warn(`[PdfBridge] ${bridge.getName()} not available:`, e);
      }
    }
    throw new Error('No PDF bridge implementation available');
  }

  /**
   * Get the active bridge (must call initialize first)
   */
  getBridge(): PdfBridge {
    if (!this.activeBridge) {
      throw new Error('PdfBridgeManager not initialized. Call initialize() first.');
    }
    return this.activeBridge;
  }

  /**
   * Check if a bridge is available
   */
  isInitialized(): boolean {
    return this.activeBridge !== null;
  }
}

// Singleton instance
export const pdfBridgeManager = new PdfBridgeManager();

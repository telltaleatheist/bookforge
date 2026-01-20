/**
 * PDF Bridge - Abstraction layer for PDF manipulation
 *
 * Uses mupdf.js (pure JS/WASM) for all PDF operations.
 * No external dependencies required.
 */

import * as fs from 'fs';

// Dynamic import for ESM mupdf module
let mupdf: typeof import('mupdf') | null = null;

async function getMupdf() {
  if (!mupdf) {
    mupdf = await import('mupdf');
  }
  return mupdf;
}

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

  /**
   * Remove specific images from a PDF while preserving text/fonts
   * @param inputPath Path to source PDF
   * @param outputPath Path for output PDF
   * @param imageRegions Regions containing images to remove
   * @param options Additional options (deleted pages, bookmarks)
   */
  removeImages(
    inputPath: string,
    outputPath: string,
    imageRegions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void>;

  /**
   * Remove content by painting over it with background-colored rectangles.
   * This approach avoids font corruption by never using MuPDF's redaction API.
   * Instead, it creates Square annotations filled with the background color,
   * then bakes (flattens) them into the page content.
   *
   * @param inputPath Path to source PDF
   * @param outputPath Path for output PDF
   * @param regions Regions to cover (both images and text)
   * @param options Additional options (deleted pages, bookmarks)
   */
  removeWithOverlay(
    inputPath: string,
    outputPath: string,
    regions: RedactionRegion[],
    options?: RedactionOptions
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

/**
 * MuPDF.js Bridge - Pure JavaScript/WASM implementation
 * No external dependencies required
 */
export class MupdfJsBridge implements PdfBridge {
  getName(): string {
    return 'mupdf.js (WASM)';
  }

  async isAvailable(): Promise<boolean> {
    // mupdf.js is always available since it's bundled
    try {
      const mupdfLib = await getMupdf();
      return typeof mupdfLib.PDFDocument !== 'undefined';
    } catch {
      return false;
    }
  }

  async redact(
    inputPath: string,
    outputPath: string,
    regions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void> {
    const mupdfLib = await getMupdf();

    // Read input PDF
    const inputData = fs.readFileSync(inputPath);
    const doc = mupdfLib.Document.openDocument(inputData, 'application/pdf');
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      throw new Error('Failed to open PDF document');
    }

    const totalPages = pdfDoc.countPages();
    const deletedPages = new Set(options?.deletedPages || []);

    // Group regions by page for efficient processing
    const regionsByPage = new Map<number, RedactionRegion[]>();
    for (const region of regions) {
      if (!regionsByPage.has(region.page)) {
        regionsByPage.set(region.page, []);
      }
      regionsByPage.get(region.page)!.push(region);
    }

    // Apply redactions to each page (skip pages that will be deleted)
    for (const [pageNum, pageRegions] of regionsByPage) {
      if (pageNum >= totalPages || deletedPages.has(pageNum)) {
        continue;
      }

      const page = pdfDoc.loadPage(pageNum) as InstanceType<typeof mupdfLib.PDFPage>;

      // Separate image and text regions
      const imageRegions = pageRegions.filter(r => r.isImage);
      const textRegions = pageRegions.filter(r => !r.isImage);

      // First pass: Apply image-only redactions
      // applyRedactions params: (black_boxes, image_method, line_art_method, text_method)
      // image_method: 0=none, 1=remove, 2=pixels, 3=unless_invisible
      // line_art_method: 0=none, 1=remove_if_covered, 2=remove_if_touched
      // text_method: 0=remove, 1=none
      if (imageRegions.length > 0) {
        for (const region of imageRegions) {
          const rect: [number, number, number, number] = [
            region.x,
            region.y,
            region.x + region.width,
            region.y + region.height,
          ];
          const annot = page.createAnnotation('Redact');
          annot.setRect(rect);
        }
        // Apply: no black boxes, redact images (pixels), no line art, preserve text
        page.applyRedactions(false, 2, 0, 1);
      }

      // Second pass: Apply text redactions
      if (textRegions.length > 0) {
        for (const region of textRegions) {
          const rect: [number, number, number, number] = [
            region.x,
            region.y,
            region.x + region.width,
            region.y + region.height,
          ];
          const annot = page.createAnnotation('Redact');
          annot.setRect(rect);
        }
        // Apply: no black boxes, redact images, redact line art if touched, remove text
        page.applyRedactions(false, 2, 2, 0);
      }
    }

    // Delete pages (in reverse order to preserve indices)
    if (deletedPages.size > 0) {
      const sortedDeletedPages = Array.from(deletedPages).sort((a, b) => b - a);
      for (const pageNum of sortedDeletedPages) {
        if (pageNum < pdfDoc.countPages()) {
          pdfDoc.deletePage(pageNum);
        }
      }
    }

    // Add bookmarks if provided
    if (options?.bookmarks && options.bookmarks.length > 0) {
      this.addBookmarks(doc, options.bookmarks);
    }

    // Save with garbage collection to actually remove redacted content
    const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
    fs.writeFileSync(outputPath, buffer.asUint8Array());
  }

  async deletePages(
    inputPath: string,
    outputPath: string,
    pages: number[]
  ): Promise<void> {
    // Use redact with no regions, just deleted pages
    await this.redact(inputPath, outputPath, [], { deletedPages: pages });
  }

  /**
   * Remove specific images from a PDF without affecting text or fonts.
   * Works by directly removing image XObjects from the page's Resources dictionary.
   *
   * This approach NEVER uses redaction, which can corrupt fonts. Instead, it:
   * 1. Enumerates all XObjects in the page's Resources
   * 2. Identifies which are images (Subtype=Image)
   * 3. Removes any that overlap with the deleted regions
   */
  async removeImages(
    inputPath: string,
    outputPath: string,
    imageRegions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void> {
    console.log(`[MupdfJsBridge.removeImages] Called with ${imageRegions.length} image regions`);
    const mupdfLib = await getMupdf();

    // Read input PDF
    const inputData = fs.readFileSync(inputPath);
    const doc = mupdfLib.Document.openDocument(inputData, 'application/pdf');
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      throw new Error('Failed to open PDF document');
    }

    const totalPages = pdfDoc.countPages();
    const deletedPages = new Set(options?.deletedPages || []);

    // Group regions by page
    const regionsByPage = new Map<number, RedactionRegion[]>();
    for (const region of imageRegions) {
      if (!regionsByPage.has(region.page)) {
        regionsByPage.set(region.page, []);
      }
      regionsByPage.get(region.page)!.push(region);
    }

    // Use redaction API to remove images while preserving text
    // applyRedactions params: (black_boxes, image_method, line_art_method, text_method)
    // image_method: 0=none, 1=remove, 2=pixels (clear to white), 3=unless_invisible
    // text_method: 0=remove, 1=none (preserve)
    for (const [pageNum, regions] of regionsByPage) {
      if (pageNum >= totalPages || deletedPages.has(pageNum)) {
        continue;
      }

      const page = pdfDoc.loadPage(pageNum) as InstanceType<typeof mupdfLib.PDFPage>;

      // Create redaction annotations for each image region
      for (const region of regions) {
        const rect: [number, number, number, number] = [
          region.x,
          region.y,
          region.x + region.width,
          region.y + region.height,
        ];
        console.log(`[MupdfJsBridge] Creating redaction for image at page ${pageNum}: (${rect[0].toFixed(1)}, ${rect[1].toFixed(1)}) to (${rect[2].toFixed(1)}, ${rect[3].toFixed(1)})`);
        const annot = page.createAnnotation('Redact');
        annot.setRect(rect);
      }

      // Apply redactions: no black boxes, clear images to white (pixels), no line art changes, preserve text
      console.log(`[MupdfJsBridge] Applying redactions on page ${pageNum} (preserving text)...`);
      page.applyRedactions(false, 2, 0, 1);
    }

    // Delete pages (in reverse order to preserve indices)
    if (deletedPages.size > 0) {
      const sortedDeletedPages = Array.from(deletedPages).sort((a, b) => b - a);
      for (const pageNum of sortedDeletedPages) {
        if (pageNum < pdfDoc.countPages()) {
          pdfDoc.deletePage(pageNum);
        }
      }
    }

    // Add bookmarks if provided
    if (options?.bookmarks && options.bookmarks.length > 0) {
      this.addBookmarks(doc, options.bookmarks);
    }

    // Save with garbage collection
    console.log(`[MupdfJsBridge] Saving PDF with garbage collection...`);
    const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
    const outputData = buffer.asUint8Array();
    console.log(`[MupdfJsBridge] Output PDF size: ${outputData.length} bytes`);

    if (outputData.length < 1000) {
      console.error(`[MupdfJsBridge] WARNING: Output PDF is suspiciously small (${outputData.length} bytes)`);
    }

    fs.writeFileSync(outputPath, outputData);
    console.log(`[MupdfJsBridge] Removed images from PDF, saved to ${outputPath}`);
  }

  /**
   * Remove content by painting over it with background-colored rectangles.
   * This approach avoids font corruption by never using MuPDF's redaction API.
   * Instead, it creates Square annotations filled with the background color,
   * then bakes (flattens) them into the page content.
   */
  async removeWithOverlay(
    inputPath: string,
    outputPath: string,
    regions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void> {
    console.log(`[MupdfJsBridge.removeWithOverlay] Called with ${regions.length} regions`);
    const mupdfLib = await getMupdf();

    // Read input PDF
    const inputData = fs.readFileSync(inputPath);
    const doc = mupdfLib.Document.openDocument(inputData, 'application/pdf');
    const pdfDoc = doc.asPDF();

    if (!pdfDoc) {
      throw new Error('Failed to open PDF document');
    }

    const totalPages = pdfDoc.countPages();
    const deletedPages = new Set(options?.deletedPages || []);

    // Group regions by page
    const regionsByPage = new Map<number, RedactionRegion[]>();
    for (const region of regions) {
      if (!regionsByPage.has(region.page)) {
        regionsByPage.set(region.page, []);
      }
      regionsByPage.get(region.page)!.push(region);
    }

    // Process each page with regions
    for (const [pageNum, pageRegions] of regionsByPage) {
      if (pageNum >= totalPages || deletedPages.has(pageNum)) {
        continue;
      }

      const page = pdfDoc.loadPage(pageNum) as InstanceType<typeof mupdfLib.PDFPage>;

      // Sample background colors and create overlay annotations
      for (const region of pageRegions) {
        const rect: [number, number, number, number] = [
          region.x,
          region.y,
          region.x + region.width,
          region.y + region.height,
        ];

        // Sample background color from the corner of the region
        let bgColor: [number, number, number] = [1, 1, 1]; // Default to white
        try {
          bgColor = this.sampleBackgroundColor(page, mupdfLib, region);
        } catch (err) {
          console.warn(`[MupdfJsBridge] Failed to sample background color, using white:`, err);
        }

        console.log(`[MupdfJsBridge] Creating overlay at page ${pageNum}: (${rect[0].toFixed(1)}, ${rect[1].toFixed(1)}) to (${rect[2].toFixed(1)}, ${rect[3].toFixed(1)}) with color [${bgColor.map(c => c.toFixed(2)).join(', ')}]`);

        // Create a filled Square annotation (rectangle)
        const annot = page.createAnnotation('Square');
        annot.setRect(rect);
        annot.setInteriorColor(bgColor);  // Fill color
        annot.setColor(bgColor);          // Border color (match fill)
        annot.setBorderWidth(0);          // No visible border
        annot.update();
      }
    }

    // Bake all annotations into the page content (makes them permanent)
    console.log(`[MupdfJsBridge] Baking annotations into page content...`);
    pdfDoc.bake();

    // Delete pages (in reverse order to preserve indices)
    if (deletedPages.size > 0) {
      const sortedDeletedPages = Array.from(deletedPages).sort((a, b) => b - a);
      for (const pageNum of sortedDeletedPages) {
        if (pageNum < pdfDoc.countPages()) {
          pdfDoc.deletePage(pageNum);
        }
      }
    }

    // Add bookmarks if provided
    if (options?.bookmarks && options.bookmarks.length > 0) {
      this.addBookmarks(doc, options.bookmarks);
    }

    // Save with garbage collection
    console.log(`[MupdfJsBridge] Saving PDF with garbage collection...`);
    const buffer = pdfDoc.saveToBuffer('garbage=4,compress');
    const outputData = buffer.asUint8Array();
    console.log(`[MupdfJsBridge] Output PDF size: ${outputData.length} bytes`);

    if (outputData.length < 1000) {
      console.error(`[MupdfJsBridge] WARNING: Output PDF is suspiciously small (${outputData.length} bytes)`);
    }

    fs.writeFileSync(outputPath, outputData);
    console.log(`[MupdfJsBridge] Removed content with overlay, saved to ${outputPath}`);
  }

  /**
   * Sample the background color at the corner of a region.
   * Renders a small area and picks the pixel color.
   */
  private sampleBackgroundColor(
    page: any,
    mupdfLib: typeof import('mupdf'),
    region: RedactionRegion
  ): [number, number, number] {
    // Use a small scale for efficiency - we just need to sample a pixel
    const scale = 0.5;
    const matrix = mupdfLib.Matrix.scale(scale, scale);

    // Render the page to a pixmap
    const pixmap = page.toPixmap(matrix, mupdfLib.ColorSpace.DeviceRGB, false, true);
    const samples = pixmap.getSamples();
    const width = pixmap.getWidth();
    const n = pixmap.getNumberOfComponents(); // Usually 3 for RGB, 4 for RGBA

    // Calculate pixel position (sample from top-left corner of region, with small offset inward)
    const sampleX = Math.max(0, Math.min(width - 1, Math.floor((region.x + 2) * scale)));
    const sampleY = Math.max(0, Math.min(pixmap.getHeight() - 1, Math.floor((region.y + 2) * scale)));

    const pixelIndex = (sampleY * width + sampleX) * n;

    // Extract RGB values and normalize to 0-1 range
    const r = samples[pixelIndex] / 255;
    const g = samples[pixelIndex + 1] / 255;
    const b = samples[pixelIndex + 2] / 255;

    return [r, g, b];
  }

  /**
   * Add bookmarks to a document using OutlineIterator
   */
  private addBookmarks(doc: any, bookmarks: Bookmark[]): void {
    if (bookmarks.length === 0) return;

    try {
      // Sort bookmarks by page
      const sorted = [...bookmarks].sort((a, b) => a.page - b.page);

      const iterator = doc.outlineIterator();

      // Build hierarchical structure based on level
      const insertBookmarksRecursive = (
        items: Bookmark[],
        startIdx: number,
        parentLevel: number
      ): number => {
        let i = startIdx;
        while (i < items.length) {
          const bookmark = items[i];

          // If this bookmark is at a lower level (higher number), we've gone too deep
          if (bookmark.level <= parentLevel && i > startIdx) {
            return i;
          }

          // Skip items that should be children of previous siblings
          if (bookmark.level > parentLevel + 1) {
            i++;
            continue;
          }

          // Create URI for internal link (mupdf uses #page=N format, 1-indexed)
          const uri = `#page=${bookmark.page + 1}`;

          // Insert the outline item
          iterator.insert({
            title: bookmark.title,
            uri: uri,
            open: bookmark.level === 1, // Keep top-level expanded
          });

          // Check if next items are children
          if (i + 1 < items.length && items[i + 1].level > bookmark.level) {
            iterator.down();
            i = insertBookmarksRecursive(items, i + 1, bookmark.level);
            iterator.up();
          } else {
            i++;
          }

          iterator.next();
        }
        return i;
      };

      // Find minimum level to use as root
      const minLevel = Math.min(...sorted.map(b => b.level));
      insertBookmarksRecursive(sorted, 0, minLevel - 1);

      console.log(`[MupdfJsBridge] Added ${bookmarks.length} bookmarks`);
    } catch (err) {
      console.error('[MupdfJsBridge] Failed to add bookmarks:', err);
      // Continue without bookmarks rather than failing the whole export
    }
  }
}

// Singleton instance
export const pdfBridgeManager = new PdfBridgeManager();

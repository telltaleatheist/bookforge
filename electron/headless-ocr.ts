/**
 * Headless OCR Service - Performs OCR directly on PDF pages without rendering to UI
 *
 * Memory-efficient approach:
 * - Processes one page at a time
 * - Extracts page -> OCR -> Save results -> Flush memory
 * - Never holds multiple page images in memory
 * - Returns complete results only after all pages processed
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getOcrService, OcrTextLine } from './ocr-service';

const execAsync = promisify(exec);

export interface HeadlessOcrPageResult {
  page: number;
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];
  layoutBlocks?: any[];  // Plugin layout blocks if available
}

export interface HeadlessOcrOptions {
  engine: 'tesseract' | 'surya';
  language?: string;
  pages?: number[];  // Specific pages to OCR, or all if not specified
  onProgress?: (current: number, total: number) => void;
  tempDir?: string;  // Custom temp directory
}

export class HeadlessOcrService {
  private mutoolPath: string = '/opt/homebrew/bin/mutool';

  constructor() {
    // Try to find mutool in common locations
    const possiblePaths = [
      '/opt/homebrew/bin/mutool',
      '/usr/local/bin/mutool',
      '/usr/bin/mutool',
    ];

    for (const p of possiblePaths) {
      if (require('fs').existsSync(p)) {
        this.mutoolPath = p;
        break;
      }
    }
  }

  /**
   * Process a PDF file for OCR without rendering to UI
   * Processes one page at a time to minimize memory usage
   */
  async processPdf(
    pdfPath: string,
    options: HeadlessOcrOptions
  ): Promise<HeadlessOcrPageResult[]> {
    const results: HeadlessOcrPageResult[] = [];

    // Create temp directory for page images
    const tempDir = options.tempDir || path.join(os.tmpdir(), `ocr-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      // Get page count
      const pageCount = await this.getPageCount(pdfPath);

      // Determine which pages to process
      const pagesToProcess = options.pages ||
        Array.from({ length: pageCount }, (_, i) => i);

      console.log(`[Headless OCR] Processing ${pagesToProcess.length} pages from ${pdfPath}`);

      // Process each page individually
      for (let i = 0; i < pagesToProcess.length; i++) {
        const pageNum = pagesToProcess[i];

        // Report progress
        if (options.onProgress) {
          options.onProgress(i + 1, pagesToProcess.length);
        }

        try {
          // Extract single page to temporary image
          const imagePath = path.join(tempDir, `page-${pageNum}.png`);
          await this.extractPageImage(pdfPath, pageNum, imagePath);

          // Perform OCR on the page
          const result = await this.ocrPage(imagePath, pageNum, options.engine, options.language);
          results.push(result);

          // Delete the temporary image immediately to free memory
          await fs.unlink(imagePath).catch(() => {});

          console.log(`[Headless OCR] Completed page ${pageNum + 1}/${pagesToProcess.length}`);
        } catch (err) {
          console.error(`[Headless OCR] Failed on page ${pageNum}:`, err);
          // Continue with other pages even if one fails
          results.push({
            page: pageNum,
            text: '',
            confidence: 0
          });
        }
      }

      return results;
    } finally {
      // Clean up temp directory
      await this.cleanupTempDir(tempDir);
    }
  }

  /**
   * Get the number of pages in a PDF
   */
  private async getPageCount(pdfPath: string): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `"${this.mutoolPath}" info "${pdfPath}" | grep "Pages:" | awk '{print $2}'`
      );
      return parseInt(stdout.trim()) || 0;
    } catch {
      // Fallback: try to count by extracting page info
      const { stdout } = await execAsync(
        `"${this.mutoolPath}" show "${pdfPath}" trailer/Root/Pages/Count`
      );
      return parseInt(stdout.trim()) || 0;
    }
  }

  /**
   * Extract a single page from PDF to image file
   */
  private async extractPageImage(
    pdfPath: string,
    pageNum: number,
    outputPath: string
  ): Promise<void> {
    // Use mutool to extract page as high-quality PNG (300 DPI for good OCR)
    const pageNumOneBased = pageNum + 1;  // mutool uses 1-based page numbers
    await execAsync(
      `"${this.mutoolPath}" draw -r 300 -o "${outputPath}" "${pdfPath}" ${pageNumOneBased}`
    );
  }

  /**
   * Perform OCR on a single page image
   */
  private async ocrPage(
    imagePath: string,
    pageNum: number,
    engine: 'tesseract' | 'surya',
    language?: string
  ): Promise<HeadlessOcrPageResult> {
    // For now, headless OCR only supports Tesseract
    // Surya requires plugin IPC which is more complex to invoke directly
    const ocrService = getOcrService();

    // Configure language if provided
    if (language) {
      (ocrService as any).config = {
        ...(ocrService as any).config,
        lang: language
      };
    }

    const result = await ocrService.recognizeFileWithBounds(imagePath);

    return {
      page: pageNum,
      text: result.text,
      confidence: result.confidence,
      textLines: result.textLines
    };
  }

  /**
   * Clean up temporary directory
   */
  private async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      const files = await fs.readdir(tempDir);
      for (const file of files) {
        await fs.unlink(path.join(tempDir, file)).catch(() => {});
      }
      await fs.rmdir(tempDir).catch(() => {});
    } catch {
      // Best effort cleanup
    }
  }
}

// Singleton instance
let headlessOcrService: HeadlessOcrService | null = null;

export function getHeadlessOcrService(): HeadlessOcrService {
  if (!headlessOcrService) {
    headlessOcrService = new HeadlessOcrService();
  }
  return headlessOcrService;
}
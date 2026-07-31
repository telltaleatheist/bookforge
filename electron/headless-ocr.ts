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
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { OcrService, OcrParagraph, OcrTextLine, OCR_DPI } from './ocr-service';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface HeadlessOcrPageResult {
  page: number;
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];
  /**
   * Tesseract's own paragraph grouping, passed through rather than dropped.
   *
   * The block classifier consumes paragraphs, not lines. This path used to
   * return only `textLines`, so every caller had to re-derive paragraphs from
   * (blockNum, parNum) itself — duplicating grouping logic that OcrService
   * already performs, and losing it entirely for OCR plugins that report no
   * grouping at all.
   */
  paragraphs?: OcrParagraph[];
  /** Page size in POINTS, for converting OCR pixel boxes to page coordinates. */
  pageWidth?: number;
  pageHeight?: number;
}

export interface HeadlessOcrOptions {
  engine: string;
  language?: string;
  pages?: number[];  // Specific pages to OCR, or all if not specified
  onProgress?: (current: number, total: number) => void;
  tempDir?: string;  // Custom temp directory
  /**
   * Pages OCR'd concurrently. Default 1 — the interactive path stays as it was,
   * one page in memory at a time. Batch callers (the CLI) raise it; each worker
   * holds one rendered page plus one Tesseract process, so cost scales linearly.
   */
  concurrency?: number;
  /** Run the OpenCV pass before Tesseract. See OcrServiceConfig.preprocess. */
  preprocess?: boolean;
}

export class HeadlessOcrService {
  private mutoolPath: string = 'mutool';

  constructor() {
    const homeDir = require('os').homedir();

    // Platform-specific search paths for mutool
    const possiblePaths = process.platform === 'win32'
      ? [
          path.join(homeDir, 'scoop', 'shims', 'mutool.exe'),
          'C:\\Program Files\\MuPDF\\mutool.exe',
          'C:\\Program Files (x86)\\MuPDF\\mutool.exe',
          'C:\\ProgramData\\chocolatey\\bin\\mutool.exe',
          path.join(homeDir, 'mupdf', 'mutool.exe'),
        ]
      : [
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

      const pageSizes = await this.getPageSizes(pdfPath, pagesToProcess);
      const workers = Math.max(1, Math.min(options.concurrency ?? 1, pagesToProcess.length));

      console.log(`[Headless OCR] Processing ${pagesToProcess.length} pages from ${pdfPath}`
        + ` at ${OCR_DPI}dpi, ${workers} worker(s)`);

      const ocrOnePage = async (pageNum: number): Promise<HeadlessOcrPageResult> => {
        // Per-page filename: with more than one worker in flight these must not collide.
        const imagePath = path.join(tempDir, `page-${pageNum}.png`);
        try {
          await this.extractPageImage(pdfPath, pageNum, imagePath);
          const result = await this.ocrPage(imagePath, pageNum, options.engine, options.language,
            options.preprocess);
          const size = pageSizes.get(pageNum);
          return { ...result, pageWidth: size?.width, pageHeight: size?.height };
        } catch (err) {
          console.error(`[Headless OCR] Failed on page ${pageNum}:`, err);
          // Continue with other pages even if one fails
          return { page: pageNum, text: '', confidence: 0 };
        } finally {
          // Delete the temporary image immediately to free memory
          await fs.unlink(imagePath).catch(() => {});
        }
      };

      // Shared cursor rather than fixed slices: pages differ wildly in cost
      // (a blank page is ~10x faster than a dense one), so slicing would leave
      // workers idle waiting on whichever chunk drew the heavy pages.
      let next = 0;
      let completed = 0;
      const collected: Array<HeadlessOcrPageResult | undefined> = new Array(pagesToProcess.length);
      const runWorker = async () => {
        for (;;) {
          const i = next++;
          if (i >= pagesToProcess.length) return;
          collected[i] = await ocrOnePage(pagesToProcess[i]);
          completed++;
          if (options.onProgress) options.onProgress(completed, pagesToProcess.length);
          console.log(`[Headless OCR] Completed ${completed}/${pagesToProcess.length}`
            + ` (page ${pagesToProcess[i] + 1})`);
        }
      };
      await Promise.all(Array.from({ length: workers }, runWorker));

      // Indexed writes, so results stay in requested page order regardless of
      // which worker finished first.
      results.push(...collected.filter((r): r is HeadlessOcrPageResult => r !== undefined));

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
      // Use mutool show which outputs the page count directly (cross-platform, no shell pipes)
      const { stdout } = await execAsync(
        `"${this.mutoolPath}" show "${pdfPath}" trailer/Root/Pages/Count`
      );
      return parseInt(stdout.trim()) || 0;
    } catch {
      // Fallback: parse "Pages:" from mutool info output using JS regex (no grep/awk)
      try {
        const { stdout } = await execAsync(
          `"${this.mutoolPath}" info "${pdfPath}"`
        );
        const match = stdout.match(/Pages:\s*(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      } catch {
        return 0;
      }
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
    // OCR_DPI, not 300. This rendered at 300 while the OcrService it hands the
    // image to declares user_defined_dpi=200 — so Tesseract was told the page was
    // 1.5x smaller than it is, and its paragraph segmentation (which is driven by
    // physical size) diverged from the picker's and from every label in the
    // training corpus. One resolution, declared honestly, everywhere.
    const pageNumOneBased = pageNum + 1;  // mutool uses 1-based page numbers
    await execFileAsync(this.mutoolPath,
      ['draw', '-r', String(OCR_DPI), '-o', outputPath, pdfPath, String(pageNumOneBased)]);
  }

  /**
   * Size of each requested page as RENDERED, in points, keyed by 0-based page
   * number.
   *
   * One mutool call for the whole run: OCR boxes come back in image pixels, and
   * turning them into page coordinates needs the page size, which nothing else
   * on this path carries.
   *
   * CROPBOX, FALLING BACK TO MEDIABOX — not the other way round. `mutool draw`
   * renders the CropBox, so on a PDF where the two differ, reporting the
   * MediaBox describes a page that is not the one OCR read. Every block then
   * gets its `x / pageWidth` and `y / pageHeight` computed against a page bigger
   * than the raster, which shifts each block towards the origin and moves every
   * position-dependent verdict in shared/ocr/ocr-post-processing.ts with it —
   * header, footer, footnote, caption, margin. Those labels are the training
   * corpus, so the error does not stay in the OCR layer; it is baked into what
   * the model is taught a header looks like.
   *
   * Measured across the 18-book corpus (Jul 2026): one book differs, Twisted
   * Cross, by 4.0% of width and 2.7% of height. Rare, silent, and permanent in
   * anything labelled before this — which is the combination that makes it worth
   * a comment rather than a one-word change.
   */
  private async getPageSizes(
    pdfPath: string,
    pages: number[]
  ): Promise<Map<number, { width: number; height: number }>> {
    const sizes = new Map<number, { width: number; height: number }>();
    if (pages.length === 0) return sizes;
    const { stdout } = await execFileAsync(this.mutoolPath,
      ['pages', pdfPath, ...pages.map(p => String(p + 1))],
      { maxBuffer: 16 * 1024 * 1024 });

    // Per PAGE rather than per box, because the choice between the two boxes can
    // only be made among the boxes belonging to the same page.
    const pageRe = /<page pagenum="(\d+)">([\s\S]*?)<\/page>/g;
    const boxRe = (name: string) =>
      new RegExp(`<${name} l="([-\\d.]+)" b="([-\\d.]+)" r="([-\\d.]+)" t="([-\\d.]+)"`);
    let m: RegExpExecArray | null;
    while ((m = pageRe.exec(stdout)) !== null) {
      const body = m[2];
      // A PDF without a CropBox is the common case; MediaBox is then what
      // renders, and using it is correct rather than a fallback.
      const box = boxRe('CropBox').exec(body) ?? boxRe('MediaBox').exec(body);
      if (!box) continue;
      sizes.set(Number(m[1]) - 1, {
        width: Math.abs(Number(box[3]) - Number(box[1])),
        height: Math.abs(Number(box[4]) - Number(box[2])),
      });
    }
    return sizes;
  }

  /**
   * One OcrService per language, built with the render dpi.
   *
   * The old code reached into the shared singleton and overwrote its private
   * `config` through an `as any` cast. That leaked: OCR one page as 'deu' and
   * every later page in the process stayed German, including in the picker,
   * because the singleton is shared. Constructing per language keeps the
   * language scoped to the call and lets dpi be set properly rather than
   * defaulted.
   */
  private ocrServices = new Map<string, OcrService>();

  private serviceFor(language?: string, preprocess?: boolean): OcrService {
    const lang = language || 'eng';
    const key = `${lang}:${preprocess ? 'pp' : 'raw'}`;
    let svc = this.ocrServices.get(key);
    if (!svc) {
      svc = new OcrService({ lang, dpi: OCR_DPI, preprocess });
      this.ocrServices.set(key, svc);
    }
    return svc;
  }

  /**
   * Perform OCR on a single page image
   */
  private async ocrPage(
    imagePath: string,
    pageNum: number,
    engine: string,
    language?: string,
    preprocess?: boolean
  ): Promise<HeadlessOcrPageResult> {
    if (engine === 'tesseract') {
      // One service per (language, preprocess) pair rather than one shared,
      // re-configured instance: the binary and the traineddata directory are
      // resolved INSIDE the service and cached per language, so a service that
      // gets its language at construction never has to re-resolve, and two
      // languages in one run cannot tread on each other's cache.
      const result = await this.serviceFor(language, preprocess).recognizeFileWithBounds(imagePath);

      return {
        page: pageNum,
        text: result.text,
        confidence: result.confidence,
        textLines: result.textLines,
        paragraphs: result.paragraphs,
      };
    }

    // For plugin-based engines, invoke the plugin's recognize handler directly
    const { getPluginRegistry } = require('./plugins/plugin-registry');
    const registry = getPluginRegistry();
    const plugin = registry.getPlugin(engine);

    if (!plugin) {
      throw new Error(`OCR engine "${engine}" not found`);
    }

    // Find the recognize handler
    const handlers = plugin.getIpcHandlers();
    const recognizeHandler = handlers.find((h: any) => h.channel === 'recognize');

    if (!recognizeHandler) {
      throw new Error(`OCR engine "${engine}" does not support recognize`);
    }

    // Invoke the handler directly with the file path
    const result = await recognizeHandler.handler({} as any, imagePath);
    const typedResult = result as { success: boolean; data?: any; error?: string };

    if (!typedResult.success) {
      throw new Error(typedResult.error || `OCR engine "${engine}" failed`);
    }

    return {
      page: pageNum,
      text: typedResult.data?.text || '',
      confidence: typedResult.data?.confidence || 0,
      textLines: typedResult.data?.textLines
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
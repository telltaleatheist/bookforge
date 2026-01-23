import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PdfService, TextBlock, Category } from './pdf.service';
import { Chapter } from '../../../core/services/electron.service';
import { BookMetadata } from '../pdf-picker.component';
import { DeletedBlockExample } from '../../queue/models/queue.types';

export interface ExportableBlock {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size?: number;
  is_image?: boolean;
  is_ocr?: boolean;
}

export interface OcrTextBlock {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
}

export interface DeletedRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isImage?: boolean;
  text?: string;  // Text content for content-based matching
}

export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;  // Text content for content-based matching
}

export interface ExportResult {
  success: boolean;
  message: string;
  filename?: string;
  charCount?: number;
  blockCount?: number;
  chapterCount?: number;
  regionCount?: number;
}

// Pattern from deleted custom categories to strip from exported text
export interface DeletedCategoryPattern {
  pattern: string;
  caseSensitive: boolean;
  literalMode: boolean;
}

// Deleted highlight with coordinates for precise removal
export interface DeletedHighlight {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/**
 * ExportService - Handles TXT, EPUB, and PDF export functionality
 *
 * Stateless service - all data passed as method parameters for testability.
 */
@Injectable({
  providedIn: 'root'
})
export class ExportService {
  private readonly pdfService = inject(PdfService);
  private readonly router = inject(Router);
  private crc32Table: number[] | null = null;

  // Check if we're running in Electron
  private get electron(): any {
    return typeof window !== 'undefined' && (window as any).electron ? (window as any).electron : null;
  }

  /**
   * Export text content to a .txt file
   */
  async exportText(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>
  ): Promise<ExportResult> {
    const exportBlocks = blocks
      .filter(b => !deletedIds.has(b.id) && !b.is_image && !deletedPages?.has(b.page))
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    if (exportBlocks.length === 0) {
      return {
        success: false,
        message: 'No text to export. All blocks have been deleted.'
      };
    }

    const lines: string[] = [];
    let currentPage = -1;

    for (const block of exportBlocks) {
      if (block.page !== currentPage) {
        if (currentPage >= 0) lines.push('');
        currentPage = block.page;
      }
      // Use corrected text if available, otherwise original
      const blockText = textCorrections?.get(block.id) ?? block.text;
      const cleanedText = this.stripFootnoteRefs(blockText);
      if (cleanedText.trim()) {
        lines.push(cleanedText);
      }
    }

    const text = lines.join('\n');
    const filename = this.generateFilename(pdfName, 'txt');

    this.downloadBlob(
      new Blob([text], { type: 'text/plain' }),
      filename
    );

    return {
      success: true,
      message: `Exported ${text.length.toLocaleString()} characters from ${exportBlocks.length} blocks.`,
      filename,
      charCount: text.length,
      blockCount: exportBlocks.length
    };
  }

  /**
   * Export content to an EPUB file
   * Creates one section per PDF page to preserve page structure
   */
  async exportEpub(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[]
  ): Promise<ExportResult> {
    const exportBlocks = blocks
      .filter(b => !deletedIds.has(b.id) && !b.is_image && !deletedPages?.has(b.page))
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    if (exportBlocks.length === 0) {
      return {
        success: false,
        message: 'No text to export. All blocks have been deleted.'
      };
    }

    const bookTitle = pdfName.replace(/\.pdf$/i, '');

    // Group blocks by page to preserve page structure
    const pageMap = new Map<number, string[]>();
    for (const block of exportBlocks) {
      if (!pageMap.has(block.page)) {
        pageMap.set(block.page, []);
      }

      // Use corrected text if available, otherwise original
      let blockText = textCorrections?.get(block.id) ?? block.text;

      // Strip deleted highlights from this block using coordinate-based matching
      if (deletedHighlights && deletedHighlights.length > 0) {
        blockText = this.stripHighlightsFromBlock(
          { ...block, text: blockText },
          deletedHighlights
        );
      }

      // Sanitize text to remove garbage characters (image placeholders, etc.)
      const sanitizedText = this.sanitizeText(blockText);
      if (sanitizedText) {
        pageMap.get(block.page)!.push(`<p>${this.escapeHtml(sanitizedText)}</p>`);
      }
    }

    // Convert to array of page contents, sorted by page number
    const sortedPages = Array.from(pageMap.entries())
      .sort((a, b) => a[0] - b[0]);

    // Create sections - one per page
    const sections = sortedPages
      .filter(([_, content]) => content.length > 0)
      .map(([pageNum, content]) => ({
        pageNum: pageNum + 1, // 1-based for display
        content: content.join('\n')
      }));

    const epub = this.generateEpubBlobWithPages(bookTitle, sections);
    const filename = this.generateFilename(pdfName, 'epub');

    this.downloadBlob(epub, filename);

    return {
      success: true,
      message: `Exported EPUB with ${sections.length} pages, ${exportBlocks.length} blocks.`,
      filename,
      chapterCount: sections.length,
      blockCount: exportBlocks.length
    };
  }

  /**
   * Export content to an EPUB file with chapter structure
   * Groups blocks by chapters instead of pages for better ebook compatibility
   */
  async exportEpubWithChapters(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[]
  ): Promise<ExportResult> {
    const result = this.generateEpubBlobInternal(
      blocks,
      deletedIds,
      chapters,
      pdfName,
      textCorrections,
      deletedPages,
      deletedHighlights
    );

    if (!result.success || !result.blob) {
      return {
        success: false,
        message: result.message || 'Failed to generate EPUB'
      };
    }

    const filename = this.generateFilename(pdfName, 'epub');
    this.downloadBlob(result.blob, filename);

    return {
      success: true,
      message: `Exported EPUB with ${result.chapterCount} chapters, ${result.blockCount} blocks.`,
      filename,
      chapterCount: result.chapterCount,
      blockCount: result.blockCount
    };
  }

  /**
   * Export PDF with deleted regions removed
   * When image blocks are deleted, OCR text blocks are embedded to replace the removed images
   * If chapters are provided, bookmarks are added to the PDF
   */
  async exportPdf(
    blocks: ExportableBlock[],
    deletedBlockIds: Set<string>,
    deletedHighlightIds: Set<string>,
    categoryHighlights: Map<string, Record<number, HighlightRect[]>>,
    libraryPath: string,
    pdfName: string,
    getHighlightId: (categoryId: string, page: number, x: number, y: number) => string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    chapters?: Chapter[]
  ): Promise<ExportResult> {
    const deletedRegions: DeletedRegion[] = [];

    console.log(`[exportPdf] Starting export. Total blocks: ${blocks.length}, deletedBlockIds: ${deletedBlockIds.size}`);

    // Group blocks by page
    const blocksByPage = new Map<number, ExportableBlock[]>();
    for (const block of blocks) {
      if (!blocksByPage.has(block.page)) {
        blocksByPage.set(block.page, []);
      }
      blocksByPage.get(block.page)!.push(block);
    }

    // Identify pages where ALL image blocks are deleted (background image removed)
    // These pages should show OCR text instead of the original page
    const pagesWithDeletedBackground = new Set<number>();
    const ocrBlocksByPage = new Map<number, ExportableBlock[]>();

    for (const [pageNum, pageBlocks] of blocksByPage) {
      if (deletedPages?.has(pageNum)) continue;

      const imageBlocks = pageBlocks.filter(b => b.is_image);
      const ocrBlocks = pageBlocks.filter(b => b.is_ocr && !deletedBlockIds.has(b.id));

      // Check if all images on this page are deleted
      if (imageBlocks.length > 0 && imageBlocks.every(b => deletedBlockIds.has(b.id))) {
        console.log(`[exportPdf] Page ${pageNum}: all images deleted, will render OCR text (${ocrBlocks.length} blocks)`);
        pagesWithDeletedBackground.add(pageNum);
        if (ocrBlocks.length > 0) {
          // Apply text corrections to OCR blocks
          const correctedBlocks = ocrBlocks.map(b => ({
            ...b,
            text: textCorrections?.get(b.id) ?? b.text
          }));
          ocrBlocksByPage.set(pageNum, correctedBlocks);
        }
      }
    }

    // Collect deleted blocks (skip blocks on deleted pages and pages with deleted backgrounds)
    for (const block of blocks) {
      if (deletedPages?.has(block.page)) continue;
      if (pagesWithDeletedBackground.has(block.page)) continue; // Skip - handled specially
      if (deletedBlockIds.has(block.id)) {
        console.log(`[exportPdf] Deleted block: page=${block.page}, (${block.x.toFixed(1)}, ${block.y.toFixed(1)}) ${block.width.toFixed(1)}x${block.height.toFixed(1)}, isOCR=${block.is_ocr}`);
        deletedRegions.push({
          page: block.page,
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height,
          isImage: block.is_image
        });
      }
    }

    console.log(`[exportPdf] Collected ${deletedRegions.length} deleted regions (${deletedRegions.filter(r => r.isImage).length} images)`);
    if (deletedRegions.length > 0) {
      console.log(`[exportPdf] First few regions:`, deletedRegions.slice(0, 3).map(r =>
        `page ${r.page}: (${r.x.toFixed(0)}, ${r.y.toFixed(0)}) ${r.width.toFixed(0)}x${r.height.toFixed(0)} isImage=${r.isImage}`
      ));
    }

    // Add deleted custom category highlights (skip deleted pages)
    if (deletedHighlightIds.size > 0) {
      for (const [categoryId, pageMap] of categoryHighlights) {
        for (const [pageStr, rects] of Object.entries(pageMap)) {
          const page = parseInt(pageStr);
          if (deletedPages?.has(page)) continue; // Skip highlights on deleted pages
          for (const rect of rects) {
            const highlightId = getHighlightId(categoryId, page, rect.x, rect.y);
            if (deletedHighlightIds.has(highlightId)) {
              deletedRegions.push({
                page,
                x: rect.x,
                y: rect.y,
                width: rect.w,
                height: rect.h,
                text: rect.text  // Include text for content-based matching
              });
            }
          }
        }
      }
    }

    if (deletedRegions.length === 0 && pagesWithDeletedBackground.size === 0) {
      return {
        success: false,
        message: 'No blocks or highlights have been deleted. The exported PDF would be identical to the original.'
      };
    }

    if (!libraryPath) {
      return {
        success: false,
        message: 'No PDF file loaded'
      };
    }

    // Convert OCR blocks map to array format for IPC
    // IMPORTANT: Include ALL pages with deleted backgrounds, even ones with no OCR text
    // These pages should render as blank white instead of showing the original scanned image
    const ocrBlocksForExport: Array<{page: number; blocks: Array<{x: number; y: number; width: number; height: number; text: string; font_size: number}>}> = [];
    for (const pageNum of pagesWithDeletedBackground) {
      const pageBlocks = ocrBlocksByPage.get(pageNum) || [];
      ocrBlocksForExport.push({
        page: pageNum,
        blocks: pageBlocks.map(b => ({
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          text: b.text,
          font_size: b.font_size || 12
        }))
      });
    }

    // Use WYSIWYG export - renders pages exactly as the viewer shows them
    // This guarantees visual fidelity: what you see is what you get
    console.log(`[exportPdf] Calling WYSIWYG export with ${deletedRegions.length} regions, ${deletedPages?.size || 0} deleted pages, ${pagesWithDeletedBackground.size} pages with OCR text`);
    let pdfBase64 = await this.pdfService.exportPdfWysiwyg(
      deletedRegions,
      deletedPages,
      2.0,
      ocrBlocksForExport.length > 0 ? ocrBlocksForExport : undefined
    );

    // Add bookmarks if chapters are provided
    let bookmarksAdded = 0;
    if (chapters && chapters.length > 0) {
      // Filter out chapters on deleted pages and remap page numbers
      const validChapters = chapters.filter(c => !deletedPages?.has(c.page));
      if (validChapters.length > 0) {
        // Remap page numbers to account for deleted pages
        const remappedChapters = validChapters.map(c => {
          let newPage = c.page;
          if (deletedPages) {
            // Count how many deleted pages come before this chapter's page
            for (const dp of deletedPages) {
              if (dp < c.page) newPage--;
            }
          }
          return { ...c, page: newPage };
        });

        const withBookmarks = await this.pdfService.addBookmarksToPdf(pdfBase64, remappedChapters);
        if (withBookmarks) {
          pdfBase64 = withBookmarks;
          bookmarksAdded = remappedChapters.length;
        }
      }
    }

    const binaryString = atob(pdfBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const filename = this.generateFilename(pdfName, 'pdf');
    this.downloadBlob(
      new Blob([bytes], { type: 'application/pdf' }),
      filename
    );

    const bookmarkMsg = bookmarksAdded > 0 ? ` and ${bookmarksAdded} bookmarks added` : '';
    return {
      success: true,
      message: `Exported PDF with ${deletedRegions.length} regions removed${bookmarkMsg}.`,
      filename,
      regionCount: deletedRegions.length,
      chapterCount: bookmarksAdded
    };
  }

  /**
   * Export PDF from canvas-rendered page images (WYSIWYG approach)
   *
   * This is the true WYSIWYG export - it takes screenshots of what the viewer shows
   * and assembles them into a PDF. Guaranteed to match the viewer exactly.
   *
   * @param renderedPages - Array of { pageNum, dataUrl } from viewer's renderAllPagesForExport()
   * @param pageDimensions - Page dimensions in PDF points
   * @param pdfName - Original PDF name for generating output filename
   * @param chapters - Optional chapter bookmarks to add
   */
  async exportPdfFromCanvas(
    renderedPages: Array<{ pageNum: number; dataUrl: string }>,
    pageDimensions: Array<{ width: number; height: number }>,
    pdfName: string,
    chapters?: Chapter[]
  ): Promise<ExportResult> {
    if (!this.electron) {
      return {
        success: false,
        message: 'PDF export is only available in Electron'
      };
    }

    if (renderedPages.length === 0) {
      return {
        success: false,
        message: 'No pages to export'
      };
    }

    console.log(`[exportPdfFromCanvas] Exporting ${renderedPages.length} canvas-rendered pages`);

    try {
      // Send rendered pages to main process for PDF assembly
      const pdfBase64 = await this.electron.pdf.assembleFromImages(
        renderedPages.map(p => ({
          pageNum: p.pageNum,
          imageData: p.dataUrl,
          width: pageDimensions[p.pageNum]?.width || 612,
          height: pageDimensions[p.pageNum]?.height || 792
        })),
        chapters
      );

      if (!pdfBase64) {
        return {
          success: false,
          message: 'Failed to assemble PDF from images'
        };
      }

      // Convert base64 to blob and download
      const binaryString = atob(pdfBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const filename = this.generateFilename(pdfName, 'pdf');
      this.downloadBlob(
        new Blob([bytes], { type: 'application/pdf' }),
        filename
      );

      const chapterMsg = chapters && chapters.length > 0 ? ` with ${chapters.length} bookmarks` : '';
      return {
        success: true,
        message: `Exported PDF with ${renderedPages.length} pages${chapterMsg}.`,
        filename,
        regionCount: renderedPages.length
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to export PDF: ${message}`
      };
    }
  }

  /**
   * Export content to EPUB and save to audiobook producer queue.
   * Uses generateEpubBlobInternal to create the EPUB, then saves to queue folder.
   * Optionally collects deleted block examples for detailed AI cleanup.
   */
  async exportToAudiobook(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[],
    metadata?: BookMetadata,
    navigateAfter: boolean = true,
    categories?: Map<string, Category>
  ): Promise<ExportResult> {
    if (!this.electron) {
      return {
        success: false,
        message: 'Audiobook export is only available in Electron'
      };
    }

    // Generate EPUB using the shared internal method
    const epubResult = this.generateEpubBlobInternal(
      blocks,
      deletedIds,
      chapters,
      pdfName,
      textCorrections,
      deletedPages,
      deletedHighlights,
      metadata
    );

    if (!epubResult.success || !epubResult.blob) {
      return {
        success: false,
        message: epubResult.message || 'Failed to generate EPUB'
      };
    }

    const filename = this.generateFilename(pdfName, 'epub');
    const arrayBuffer = await epubResult.blob.arrayBuffer();

    // Collect deleted block examples for detailed cleanup mode
    const deletedBlockExamples = this.collectDeletedExamples(
      blocks,
      deletedIds,
      deletedHighlights,
      categories
    );

    try {
      const pathResult = await this.electron.library.getAudiobooksPath();
      if (!pathResult.success || !pathResult.queuePath) {
        return {
          success: false,
          message: 'Library not configured. Please complete the onboarding setup first.'
        };
      }

      // Use metadata if provided, otherwise fall back to filename-derived title
      const bookTitle = metadata?.title || pdfName.replace(/\.(pdf|epub)$/i, '');
      const copyResult = await this.electron.library.copyToQueue(arrayBuffer, filename, {
        title: bookTitle,
        author: metadata?.author || '',
        language: metadata?.language || 'en',
        coverImage: metadata?.coverImage,
        deletedBlockExamples: deletedBlockExamples.length > 0 ? deletedBlockExamples : undefined
      });

      if (!copyResult.success) {
        return {
          success: false,
          message: copyResult.error || 'Failed to copy EPUB to Audiobook Producer queue'
        };
      }

      if (navigateAfter) {
        this.router.navigate(['/audiobook']);
      }

      return {
        success: true,
        message: `Exported EPUB with ${epubResult.chapterCount} chapters to Audiobook Producer.${deletedBlockExamples.length > 0 ? ` (${deletedBlockExamples.length} deletion examples)` : ''}`,
        filename,
        chapterCount: epubResult.chapterCount,
        blockCount: epubResult.blockCount
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to export to Audiobook Producer: ${message}`
      };
    }
  }

  /**
   * Collect deleted block examples for detailed AI cleanup mode.
   * Gathers text from deleted blocks and highlights to use as few-shot examples.
   */
  private collectDeletedExamples(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    deletedHighlights?: DeletedHighlight[],
    categories?: Map<string, Category>
  ): DeletedBlockExample[] {
    const examples: DeletedBlockExample[] = [];
    const seenTexts = new Set<string>(); // Deduplicate exact matches
    const MAX_EXAMPLES = 30;
    const MIN_TEXT_LENGTH = 3; // Skip very short strings
    const MAX_TEXT_LENGTH = 200; // Skip very long strings (probably full paragraphs)

    // Collect examples from deleted blocks
    for (const block of blocks) {
      if (!deletedIds.has(block.id)) continue;
      if (block.is_image) continue; // Skip images

      const text = block.text.trim();
      if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) continue;
      if (seenTexts.has(text.toLowerCase())) continue;
      seenTexts.add(text.toLowerCase());

      // Determine category based on block position or category
      const category = this.categorizeDeletedBlock(block, categories);
      examples.push({
        text,
        category,
        page: block.page
      });

      if (examples.length >= MAX_EXAMPLES) break;
    }

    // Collect examples from deleted highlights
    if (deletedHighlights && examples.length < MAX_EXAMPLES) {
      for (const highlight of deletedHighlights) {
        const text = highlight.text.trim();
        if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) continue;
        if (seenTexts.has(text.toLowerCase())) continue;
        seenTexts.add(text.toLowerCase());

        examples.push({
          text,
          category: 'custom', // Highlights from custom categories
          page: highlight.page
        });

        if (examples.length >= MAX_EXAMPLES) break;
      }
    }

    return examples;
  }

  /**
   * Categorize a deleted block based on its properties.
   */
  private categorizeDeletedBlock(
    block: ExportableBlock,
    categories?: Map<string, Category>
  ): 'header' | 'footer' | 'page_number' | 'custom' | 'block' {
    // Check if it looks like a page number (short numeric text)
    const text = block.text.trim();
    if (/^[\d\-—–\s]+$/.test(text) && text.length < 10) {
      return 'page_number';
    }

    // Check block position (top 10% = header, bottom 10% = footer)
    // Assume page height around 792 (standard letter)
    const relativeY = block.y;
    if (relativeY < 80) {
      return 'header';
    }
    if (relativeY > 700) {
      return 'footer';
    }

    // Check category name if available
    if (categories) {
      const category = categories.get((block as any).category_id);
      if (category) {
        const nameLower = category.name.toLowerCase();
        if (nameLower.includes('header') || nameLower.includes('running')) {
          return 'header';
        }
        if (nameLower.includes('footer')) {
          return 'footer';
        }
        if (nameLower.includes('page') && nameLower.includes('number')) {
          return 'page_number';
        }
      }
    }

    return 'block';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Internal method to generate EPUB blob with chapter structure.
   * Used by both exportEpubWithChapters and exportToAudiobook.
   */
  private generateEpubBlobInternal(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[],
    metadata?: BookMetadata
  ): { success: boolean; blob?: Blob; message?: string; chapterCount?: number; blockCount?: number } {
    const exportBlocks = blocks
      .filter(b => !deletedIds.has(b.id) && !b.is_image && !deletedPages?.has(b.page))
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    const exportChapters = chapters.filter(c => !deletedPages?.has(c.page));

    if (exportBlocks.length === 0) {
      return { success: false, message: 'No text to export. All blocks have been deleted.' };
    }

    const bookTitle = metadata?.title || pdfName.replace(/\.(pdf|epub)$/i, '');

    const sortedChapters = [...exportChapters].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      return (a.y || 0) - (b.y || 0);
    });

    const chapterSections: { title: string; level: number; content: string[] }[] = [];
    let currentChapterIndex = 0;
    let currentContent: string[] = [];
    let currentTitle = 'Introduction';
    let normalizedTitle = 'introduction';
    let blocksInChapter = 0; // Track how many blocks processed in current chapter
    const SKIP_TITLE_WITHIN_FIRST_N_BLOCKS = 5; // Skip title matches within first N blocks

    for (const block of exportBlocks) {
      while (
        currentChapterIndex < sortedChapters.length &&
        (block.page > sortedChapters[currentChapterIndex].page ||
         (block.page === sortedChapters[currentChapterIndex].page &&
          block.y >= (sortedChapters[currentChapterIndex].y || 0)))
      ) {
        if (currentContent.length > 0) {
          chapterSections.push({
            title: currentTitle,
            level: currentChapterIndex === 0 ? 1 : (sortedChapters[currentChapterIndex - 1]?.level || 1),
            content: currentContent
          });
        }
        currentTitle = sortedChapters[currentChapterIndex].title;
        normalizedTitle = currentTitle.toLowerCase().replace(/\s+/g, ' ').trim();
        currentContent = [];
        currentChapterIndex++;
        blocksInChapter = 0; // Reset counter for new chapter
      }

      let blockText = textCorrections?.get(block.id) ?? block.text;

      if (deletedHighlights && deletedHighlights.length > 0) {
        blockText = this.stripHighlightsFromBlock(
          { ...block, text: blockText },
          deletedHighlights
        );
      }

      // Sanitize text first to remove garbage characters (image placeholders, etc.)
      const sanitizedText = this.sanitizeText(blockText);
      if (sanitizedText) {
        blocksInChapter++;
        // Skip blocks that match the chapter title near the start of a chapter
        const normalizedBlock = sanitizedText.toLowerCase().replace(/\s+/g, ' ').trim();
        if (blocksInChapter <= SKIP_TITLE_WITHIN_FIRST_N_BLOCKS && normalizedBlock === normalizedTitle) {
          continue; // Skip this title block
        }
        currentContent.push(`<p>${this.escapeHtml(sanitizedText)}</p>`);
      }
    }

    if (currentContent.length > 0) {
      chapterSections.push({
        title: currentTitle,
        level: sortedChapters.length > 0 ? (sortedChapters[sortedChapters.length - 1]?.level || 1) : 1,
        content: currentContent
      });
    }

    if (chapterSections.length === 0) {
      return { success: false, message: 'No content to export after organizing by chapters.' };
    }

    const blob = this.generateEpubBlobWithChapters(bookTitle, chapterSections, metadata);
    return {
      success: true,
      blob,
      chapterCount: chapterSections.length,
      blockCount: exportBlocks.length
    };
  }

  private generateFilename(pdfName: string, extension: string): string {
    const baseName = pdfName
      .replace(/\.(pdf|epub)$/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().slice(0, 10);
    return `${baseName}_cleaned_${timestamp}.${extension}`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private stripFootnoteRefs(text: string): string {
    // WYSIWYG: Export should ONLY remove content that was explicitly marked as deleted.
    // No automatic stripping of footnote references, superscripts, or anything else.
    // If users want to remove footnote refs, they should use custom categories to
    // highlight and delete them explicitly.
    return text;
  }

  /**
   * Check if two bounding boxes overlap.
   * Uses a small tolerance to handle floating point imprecision.
   */
  private bboxOverlaps(
    block: { x: number; y: number; width: number; height: number },
    highlight: { x: number; y: number; w: number; h: number }
  ): boolean {
    const tolerance = 2; // pixels tolerance for edge cases

    const blockRight = block.x + block.width;
    const blockBottom = block.y + block.height;
    const highlightRight = highlight.x + highlight.w;
    const highlightBottom = highlight.y + highlight.h;

    // Check if boxes overlap (with tolerance)
    return !(
      highlight.x > blockRight + tolerance ||
      highlightRight < block.x - tolerance ||
      highlight.y > blockBottom + tolerance ||
      highlightBottom < block.y - tolerance
    );
  }

  /**
   * Strip deleted highlights from block text using coordinate-based matching.
   * Only removes text from highlights that overlap with the block's bounding box.
   */
  private stripHighlightsFromBlock(
    block: ExportableBlock,
    deletedHighlights: DeletedHighlight[]
  ): string {
    let text = block.text;

    // Find highlights on the same page that overlap with this block
    const overlappingHighlights = deletedHighlights.filter(h =>
      h.page === block.page && this.bboxOverlaps(block, h)
    );

    if (overlappingHighlights.length === 0) {
      return text;
    }

    // Remove each highlight's text from the block
    for (const highlight of overlappingHighlights) {
      if (highlight.text && text.includes(highlight.text)) {
        // Only remove the FIRST occurrence to be precise
        // (if same text appears multiple times, only the one at this position should be removed)
        text = text.replace(highlight.text, '');
      }
    }

    // Clean up any double spaces left behind
    text = text.replace(/  +/g, ' ').trim();

    return text;
  }

  /**
   * Strip matches of deleted custom category patterns from text
   * @deprecated Use stripHighlightsFromBlock for coordinate-based removal
   */
  private stripDeletedPatterns(text: string, patterns: DeletedCategoryPattern[]): string {
    let result = text;

    for (const patternDef of patterns) {
      try {
        let patternStr = patternDef.pattern;

        // If literal mode, escape regex special characters
        if (patternDef.literalMode) {
          patternStr = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        const flags = patternDef.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(patternStr, flags);
        result = result.replace(regex, '');
      } catch (e) {
        // Invalid regex pattern, skip it
        console.warn('Invalid regex pattern in deleted category:', patternDef.pattern, e);
      }
    }

    // Clean up any double spaces left behind
    result = result.replace(/  +/g, ' ');

    return result;
  }

  /**
   * Sanitize text by removing problematic characters:
   * - Object Replacement Character (U+FFFC) - placeholder for images/objects
   * - Replacement Character (U+FFFD) - encoding errors
   * - Control characters (except newlines/tabs)
   * - Zero-width characters
   * - Private Use Area characters
   */
  private sanitizeText(text: string): string {
    return text
      // Remove object replacement and replacement characters
      .replace(/[\uFFFC\uFFFD]/g, '')
      // Remove control characters except \n \r \t
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Remove zero-width characters
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      // Remove Private Use Area characters
      .replace(/[\uE000-\uF8FF]/g, '')
      // Collapse multiple spaces into one
      .replace(/  +/g, ' ')
      // Trim
      .trim();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  private generateEpubBlob(title: string, chapters: string[]): Blob {
    const uuid = 'urn:uuid:' + this.generateUuid();
    const date = new Date().toISOString().split('T')[0];

    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const chapterManifest = chapters.map((_, i) =>
      `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
    ).join('\n');

    const chapterSpine = chapters.map((_, i) =>
      `    <itemref idref="chapter${i + 1}"/>`
    ).join('\n');

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${this.escapeHtml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapterManifest}
  </manifest>
  <spine>
${chapterSpine}
  </spine>
</package>`;

    const navItems = chapters.map((_, i) =>
      `        <li><a href="chapter${i + 1}.xhtml">Chapter ${i + 1}</a></li>`
    ).join('\n');

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Navigation</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

    const chapterXhtmls = chapters.map((content, i) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Chapter ${i + 1}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    p { margin: 0.5em 0; text-indent: 1em; }
  </style>
</head>
<body>
  <h1>Chapter ${i + 1}</h1>
${content}
</body>
</html>`);

    const files: { name: string; content: string }[] = [
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: containerXml },
      { name: 'OEBPS/content.opf', content: contentOpf },
      { name: 'OEBPS/nav.xhtml', content: navXhtml },
      ...chapterXhtmls.map((content, i) => ({
        name: `OEBPS/chapter${i + 1}.xhtml`,
        content
      }))
    ];

    return this.createZipBlob(files);
  }

  /**
   * Generate EPUB with page structure preserved (one section per PDF page)
   */
  private generateEpubBlobWithPages(title: string, sections: { pageNum: number; content: string }[]): Blob {
    const uuid = 'urn:uuid:' + this.generateUuid();
    const date = new Date().toISOString().split('T')[0];

    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const pageManifest = sections.map((s) =>
      `    <item id="page${s.pageNum}" href="page${s.pageNum}.xhtml" media-type="application/xhtml+xml"/>`
    ).join('\n');

    const pageSpine = sections.map((s) =>
      `    <itemref idref="page${s.pageNum}"/>`
    ).join('\n');

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${this.escapeHtml(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${pageManifest}
  </manifest>
  <spine>
${pageSpine}
  </spine>
</package>`;

    const navItems = sections.map((s) =>
      `        <li><a href="page${s.pageNum}.xhtml">Page ${s.pageNum}</a></li>`
    ).join('\n');

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Navigation</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

    const pageXhtmls = sections.map((s) => ({
      pageNum: s.pageNum,
      xhtml: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Page ${s.pageNum}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    p { margin: 0.5em 0; text-indent: 1em; }
    .page-number { text-align: center; color: #666; font-size: 0.9em; margin-bottom: 1em; }
  </style>
</head>
<body>
  <div class="page-number">— ${s.pageNum} —</div>
${s.content}
</body>
</html>`
    }));

    const files: { name: string; content: string }[] = [
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: containerXml },
      { name: 'OEBPS/content.opf', content: contentOpf },
      { name: 'OEBPS/nav.xhtml', content: navXhtml },
      ...pageXhtmls.map((p) => ({
        name: `OEBPS/page${p.pageNum}.xhtml`,
        content: p.xhtml
      }))
    ];

    return this.createZipBlob(files);
  }

  /**
   * Generate EPUB with chapter structure (for better ebook reader compatibility)
   */
  private generateEpubBlobWithChapters(
    title: string,
    chapters: { title: string; level: number; content: string[] }[],
    metadata?: BookMetadata
  ): Blob {
    const uuid = 'urn:uuid:' + this.generateUuid();
    const date = new Date().toISOString().split('T')[0];
    // Note: Cover images are not currently added to the EPUB (createZipBlob only handles strings).
    // Don't add cover manifest entry to avoid referencing a non-existent file.
    const hasCover = false; // TODO: Implement binary file support for covers

    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    const chapterManifest = chapters.map((_, i) =>
      `    <item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`
    ).join('\n');

    const chapterSpine = chapters.map((_, i) =>
      `    <itemref idref="chapter${i + 1}"/>`
    ).join('\n');

    // Build metadata elements
    const authorMeta = metadata?.author
      ? `    <dc:creator>${this.escapeHtml(metadata.author)}</dc:creator>`
      : '';
    const publisherMeta = metadata?.publisher
      ? `    <dc:publisher>${this.escapeHtml(metadata.publisher)}</dc:publisher>`
      : '';
    const descriptionMeta = metadata?.description
      ? `    <dc:description>${this.escapeHtml(metadata.description)}</dc:description>`
      : '';
    const dateMeta = metadata?.year
      ? `    <dc:date>${this.escapeHtml(metadata.year)}</dc:date>`
      : '';
    const coverManifest = hasCover
      ? `    <item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`
      : '';

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${this.escapeHtml(title)}</dc:title>
${authorMeta}
${publisherMeta}
${descriptionMeta}
${dateMeta}
    <dc:language>${metadata?.language || 'en'}</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${coverManifest}
${chapterManifest}
  </manifest>
  <spine>
${chapterSpine}
  </spine>
</package>`;

    // Build hierarchical navigation
    const navItems = this.buildNavItems(chapters);

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc">
    <h1>Table of Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

    const chapterXhtmls = chapters.map((chapter, i) => ({
      index: i + 1,
      xhtml: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${this.escapeHtml(chapter.title)}</title>
  <style>
    body { font-family: serif; line-height: 1.6; margin: 1em; }
    h1 { font-size: 1.5em; margin-bottom: 1em; }
    h2 { font-size: 1.3em; margin-bottom: 0.8em; }
    h3 { font-size: 1.1em; margin-bottom: 0.6em; }
    p { margin: 0.5em 0; text-indent: 1em; }
  </style>
</head>
<body>
  <h${Math.min(chapter.level, 3)}>${this.escapeHtml(chapter.title)}</h${Math.min(chapter.level, 3)}>
${chapter.content.join('\n')}
</body>
</html>`
    }));

    const files: { name: string; content: string }[] = [
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: containerXml },
      { name: 'OEBPS/content.opf', content: contentOpf },
      { name: 'OEBPS/nav.xhtml', content: navXhtml },
      ...chapterXhtmls.map((c) => ({
        name: `OEBPS/chapter${c.index}.xhtml`,
        content: c.xhtml
      }))
    ];

    return this.createZipBlob(files);
  }

  /**
   * Build hierarchical navigation items for EPUB TOC
   */
  private buildNavItems(chapters: { title: string; level: number; content: string[] }[]): string {
    const items: string[] = [];
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const indent = '      '.repeat(Math.max(1, chapter.level));
      items.push(`${indent}<li><a href="chapter${i + 1}.xhtml">${this.escapeHtml(chapter.title)}</a></li>`);
    }
    return items.join('\n');
  }

  private createZipBlob(files: { name: string; content: string }[]): Blob {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const centralDirectory: Uint8Array[] = [];
    let offset = 0;

    for (const file of files) {
      const fileData = encoder.encode(file.content);
      const fileName = encoder.encode(file.name);

      // Local file header
      const localHeader = new Uint8Array(30 + fileName.length);
      const view = new DataView(localHeader.buffer);

      view.setUint32(0, 0x04034b50, true);  // Local file header signature
      view.setUint16(4, 20, true);           // Version needed to extract
      view.setUint16(6, 0, true);            // General purpose bit flag
      view.setUint16(8, 0, true);            // Compression method (store)
      view.setUint16(10, 0, true);           // File last mod time
      view.setUint16(12, 0, true);           // File last mod date
      view.setUint32(14, this.crc32(fileData), true); // CRC-32
      view.setUint32(18, fileData.length, true);      // Compressed size
      view.setUint32(22, fileData.length, true);      // Uncompressed size
      view.setUint16(26, fileName.length, true);      // File name length
      view.setUint16(28, 0, true);           // Extra field length

      localHeader.set(fileName, 30);

      // Central directory entry
      const centralEntry = new Uint8Array(46 + fileName.length);
      const centralView = new DataView(centralEntry.buffer);

      centralView.setUint32(0, 0x02014b50, true);  // Central directory signature
      centralView.setUint16(4, 20, true);          // Version made by
      centralView.setUint16(6, 20, true);          // Version needed
      centralView.setUint16(8, 0, true);           // General purpose bit flag
      centralView.setUint16(10, 0, true);          // Compression method
      centralView.setUint16(12, 0, true);          // File last mod time
      centralView.setUint16(14, 0, true);          // File last mod date
      centralView.setUint32(16, this.crc32(fileData), true); // CRC-32
      centralView.setUint32(20, fileData.length, true);      // Compressed size
      centralView.setUint32(24, fileData.length, true);      // Uncompressed size
      centralView.setUint16(28, fileName.length, true);      // File name length
      centralView.setUint16(30, 0, true);          // Extra field length
      centralView.setUint16(32, 0, true);          // File comment length
      centralView.setUint16(34, 0, true);          // Disk number start
      centralView.setUint16(36, 0, true);          // Internal file attributes
      centralView.setUint32(38, 0, true);          // External file attributes
      centralView.setUint32(42, offset, true);     // Relative offset of local header

      centralEntry.set(fileName, 46);

      parts.push(localHeader);
      parts.push(fileData);
      centralDirectory.push(centralEntry);

      offset += localHeader.length + fileData.length;
    }

    // End of central directory record
    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const entry of centralDirectory) {
      parts.push(entry);
      centralDirSize += entry.length;
    }

    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);

    endView.setUint32(0, 0x06054b50, true);  // End of central dir signature
    endView.setUint16(4, 0, true);           // Disk number
    endView.setUint16(6, 0, true);           // Disk number with central dir
    endView.setUint16(8, files.length, true);  // Entries on this disk
    endView.setUint16(10, files.length, true); // Total entries
    endView.setUint32(12, centralDirSize, true); // Size of central directory
    endView.setUint32(16, centralDirOffset, true); // Offset of central directory
    endView.setUint16(20, 0, true);          // ZIP file comment length

    parts.push(endRecord);

    // Combine all parts
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const part of parts) {
      result.set(part, pos);
      pos += part.length;
    }

    return new Blob([result], { type: 'application/epub+zip' });
  }

  private crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    const table = this.getCrc32Table();
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  private getCrc32Table(): number[] {
    if (this.crc32Table) return this.crc32Table;

    const table: number[] = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    this.crc32Table = table;
    return table;
  }
}

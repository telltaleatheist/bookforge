import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PdfService, TextBlock, Category } from './pdf.service';
import { Chapter, ElectronService, EpubPreservingEdits } from '../../../core/services/electron.service';
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
  /**
   * The block-category contract id (shared/ocr/block-categories.ts). It drives
   * the EPUB's markup — see `markupKindFor`. Optional only because a block that
   * has never been through Detect or Label carries `''`; every caller passes a
   * full `TextBlock`, where the field is required.
   */
  category_id?: string;
}

/**
 * The markup shape a block gets in the exported EPUB.
 *
 * `standalone` is the bucket for classes that are page furniture rather than
 * prose (header, footer, image, discard). Nothing in this export path filters by
 * category — a block reaches here unless the user deleted it by hand — so they
 * are emitted, but as their own `<p>`, never glued into a neighbouring
 * paragraph, because a running head spliced into the sentence that straddles the
 * page break is unlistenable.
 */
type MarkupKind =
  | 'title' | 'chapter' | 'heading' | 'subheading'
  | 'body' | 'quote' | 'caption' | 'list' | 'table' | 'footnote' | 'standalone';

/**
 * One XHTML document in the exported EPUB.
 *
 * `frontMatter` marks the bucket for blocks that precede the first chapter; it
 * is dropped when empty, while a chapter section is kept even with no body,
 * because the heading alone is meaningful.
 */
interface EpubSection {
  title: string;
  level: number;
  frontMatter: boolean;
  /** Whether to render the section's own title as a heading element. */
  showHeading: boolean;
  content: string[];
  /** Footnote paragraphs, emitted as a trailing `<section epub:type="footnotes">`. */
  footnotes: string[];
}

/**
 * Where the book splits, resolved against the prepared block list rather than
 * against page coordinates, so the emitter never has to re-derive it.
 */
interface ChapterPlan {
  /** Chapters starting at a prepared-block index. Several can start at one index. */
  startsAt: Map<number, { title: string; level: number }[]>;
  /** Prepared-block indices spent as a chapter title — never emitted as content. */
  consumed: Set<number>;
  /** Chapters falling past the last block; emitted as heading-only sections. */
  trailing: { title: string; level: number }[];
  /** False only when the book has neither `chapter` blocks nor markers. */
  hasChapters: boolean;
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
  epubPath?: string;  // Absolute path the EPUB was actually written to (audiobook export)
  charCount?: number;
  blockCount?: number;
  chapterCount?: number;
  regionCount?: number;
  warning?: string;  // Non-fatal warning to display to user
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
  private readonly electronService = inject(ElectronService);
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
    deletedPages?: Set<number>,
    paragraphBreaks?: Set<string>
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
    let paragraphBuffer: string[] = [];

    for (const block of exportBlocks) {
      if (block.page !== currentPage) {
        // Flush paragraph buffer on page change
        if (paragraphBuffer.length > 0) {
          lines.push(this.joinParagraphLines(paragraphBuffer));
          paragraphBuffer = [];
        }
        if (currentPage >= 0) lines.push('');
        currentPage = block.page;
      }
      // Use corrected text if available, otherwise original
      const blockText = textCorrections?.get(block.id) ?? block.text;
      const cleanedText = this.stripFootnoteRefs(blockText);
      if (cleanedText.trim()) {
        if (paragraphBreaks && paragraphBreaks.size > 0) {
          if (paragraphBreaks.has(block.id) && paragraphBuffer.length > 0) {
            lines.push(this.joinParagraphLines(paragraphBuffer));
            paragraphBuffer = [];
          }
          paragraphBuffer.push(cleanedText);
        } else {
          lines.push(cleanedText);
        }
      }
    }

    // Flush remaining buffer
    if (paragraphBuffer.length > 0) {
      lines.push(this.joinParagraphLines(paragraphBuffer));
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
   * Export content to an EPUB file when the user has marked no chapters.
   *
   * There is no page-structured export any more: an EPUB whose sections are PDF
   * pages splits the book mid-sentence at every page turn, which the TTS engine
   * then reads as a hard stop. Every export goes through the same
   * category-driven chapter builder; with no chapter markers it simply derives
   * the chapters from the `chapter` blocks, and falls back to a single
   * whole-book chapter when there are none.
   *
   * Every parameter is REQUIRED. They were optional, and when `paragraphBreaks`
   * was added both call sites kept passing six arguments — so the whole no-marker
   * path, which is now the primary one, silently threw away every paragraph break
   * the user had placed and emitted one `<p>` per chapter. TypeScript cannot
   * catch a dropped optional argument; it catches a dropped required one.
   */
  async exportEpub(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    pdfName: string,
    textCorrections: Map<string, string>,
    deletedPages: Set<number>,
    deletedHighlights: DeletedHighlight[],
    paragraphBreaks: Set<string>,
    metadata: BookMetadata
  ): Promise<ExportResult> {
    return this.exportEpubWithChapters(
      blocks,
      deletedIds,
      [],
      pdfName,
      textCorrections,
      deletedPages,
      deletedHighlights,
      paragraphBreaks
    );
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
    deletedHighlights?: DeletedHighlight[],
    paragraphBreaks?: Set<string>,
    metadata?: BookMetadata
  ): Promise<ExportResult> {
    const result = this.generateEpubBlobInternal(
      blocks,
      deletedIds,
      chapters,
      pdfName,
      textCorrections,
      deletedPages,
      deletedHighlights,
      undefined,
      paragraphBreaks
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
      blockCount: result.blockCount,
      warning: result.warning
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
      const assembleResult = await this.electron.pdf.assembleFromImages(
        renderedPages.map(p => ({
          pageNum: p.pageNum,
          imageData: p.dataUrl,
          width: pageDimensions[p.pageNum]?.width || 612,
          height: pageDimensions[p.pageNum]?.height || 792
        })),
        chapters
      );

      if (!assembleResult?.success || !assembleResult.data) {
        return {
          success: false,
          message: assembleResult?.error
            ? `Failed to assemble PDF from images: ${assembleResult.error}`
            : 'Failed to assemble PDF from images'
        };
      }
      const pdfBase64: string = assembleResult.data;

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
   * Save edited content directly to an EPUB file.
   * Used when editing an EPUB directly (not via BFP project).
   * Generates EPUB with chapters and writes to the specified path.
   */
  async saveToEpub(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    epubPath: string,  // Absolute path to save the EPUB
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[],
    metadata?: BookMetadata,
    paragraphBreaks?: Set<string>
  ): Promise<ExportResult> {
    if (!this.electron) {
      return {
        success: false,
        message: 'Saving EPUB is only available in Electron'
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
      metadata,
      paragraphBreaks
    );

    if (!epubResult.success || !epubResult.blob) {
      return {
        success: false,
        message: epubResult.message || 'Failed to generate EPUB'
      };
    }

    const arrayBuffer = await epubResult.blob.arrayBuffer();

    try {
      // Save directly to the specified path
      const saveResult = await this.electronService.saveEpubToPath(
        epubPath,
        arrayBuffer
      );

      if (!saveResult.success) {
        return {
          success: false,
          message: saveResult.error || 'Failed to save EPUB file'
        };
      }

      return {
        success: true,
        message: `Saved EPUB with ${epubResult.chapterCount} chapters.`,
        filename: epubPath,
        chapterCount: epubResult.chapterCount,
        blockCount: epubResult.blockCount,
        warning: epubResult.warning
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to save EPUB: ${message}`
      };
    }
  }

  /**
   * Save EPUB to a user-chosen location via Save As dialog.
   * Generates an EPUB from the current editor state (with deletions/corrections applied)
   * and lets the user pick where to save it. Does not affect exported.epub.
   */
  async saveEpubAs(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[],
    metadata?: BookMetadata,
    paragraphBreaks?: Set<string>,
  ): Promise<ExportResult> {
    if (!this.electron) {
      return { success: false, message: 'Save As is only available in Electron' };
    }

    const epubResult = this.generateEpubBlobInternal(
      blocks, deletedIds, chapters, pdfName,
      textCorrections, deletedPages, deletedHighlights, metadata,
      paragraphBreaks,
    );

    if (!epubResult.success || !epubResult.blob) {
      return { success: false, message: epubResult.message || 'Failed to generate EPUB' };
    }

    const arrayBuffer = await epubResult.blob.arrayBuffer();
    const baseName = (metadata?.title || pdfName).replace(/\.[^.]+$/, '');
    const defaultName = `${baseName}.epub`;

    try {
      const result = await this.electronService.saveEpubAs(arrayBuffer, defaultName);

      if (result.canceled) {
        return { success: false, message: 'Canceled' };
      }

      if (!result.success) {
        return { success: false, message: result.error || 'Failed to save EPUB' };
      }

      return {
        success: true,
        message: `Saved EPUB with ${epubResult.chapterCount} chapters to ${result.filePath}`,
        filename: result.filePath?.split('/').pop() || defaultName,
        chapterCount: epubResult.chapterCount,
        blockCount: epubResult.blockCount,
        warning: epubResult.warning,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, message: `Failed to save EPUB: ${message}` };
    }
  }

  /**
   * Export content to EPUB and save to audiobook folder within the BFP project.
   * Uses generateEpubBlobInternal to create the EPUB, then saves to project's audiobook folder.
   * Optionally collects deleted block examples for detailed AI cleanup.
   */
  async exportToAudiobook(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    bfpPath: string,  // Path to the BFP project file
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[],
    metadata?: BookMetadata,
    navigateAfter: boolean = true,
    categories?: Map<string, Category>,
    savePath?: string,
    paragraphBreaks?: Set<string>
  ): Promise<ExportResult> {
    if (!this.electron) {
      return {
        success: false,
        message: 'Audiobook export is only available in Electron'
      };
    }

    if (!bfpPath) {
      return {
        success: false,
        message: 'Project must be saved before exporting to Audiobook Producer'
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
      metadata,
      paragraphBreaks
    );

    if (!epubResult.success || !epubResult.blob) {
      return {
        success: false,
        message: epubResult.message || 'Failed to generate EPUB'
      };
    }

    const arrayBuffer = await epubResult.blob.arrayBuffer();

    // Collect deleted block examples for detailed cleanup mode
    const deletedBlockExamples = this.collectDeletedExamples(
      blocks,
      deletedIds,
      deletedHighlights,
      categories
    );

    try {
      // Use the unified audiobook export - saves to BFP project's audiobook folder
      const exportResult = await this.electronService.audiobookExportFromProject(
        bfpPath,
        arrayBuffer,
        deletedBlockExamples.length > 0 ? deletedBlockExamples : undefined,
        savePath
      );

      if (!exportResult.success) {
        return {
          success: false,
          message: exportResult.error || 'Failed to export EPUB to Audiobook Producer'
        };
      }

      if (navigateAfter) {
        this.router.navigate(['/studio']);
      }

      return {
        success: true,
        message: `Exported EPUB with ${epubResult.chapterCount} chapters to Audiobook Producer.${deletedBlockExamples.length > 0 ? ` (${deletedBlockExamples.length} deletion examples)` : ''}`,
        filename: savePath ? savePath.split('/').pop()! : 'exported.epub',
        epubPath: exportResult.epubPath,  // Authoritative path from main — layout differs for manifest dir vs legacy .bfp
        chapterCount: epubResult.chapterCount,
        blockCount: epubResult.blockCount,
        warning: epubResult.warning
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
   * The blocks whose text GENUINELY changed, keyed by block id.
   *
   * This is the markup-preserving export's rebuild list: a block that appears
   * here loses its source markup (the element is rebuilt as plain text), and a
   * block that does not appear is copied out of the book verbatim. So the set has
   * to be exactly the blocks the user really edited — nothing more.
   *
   * Sanitization is therefore NOT applied here. `sanitizeText` strips object
   * replacement characters, control characters and double spaces from every block
   * on the legacy path; running it here would flag a block as "changed" because
   * the SOURCE had a stray U+FFFC in it, and strip its italics as a side effect.
   * The main process sanitizes the text of an element it is already rebuilding.
   */
  computeEffectiveTexts(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    textCorrections: Map<string, string>,
    deletedHighlights?: DeletedHighlight[]
  ): Record<string, string> {
    const effective: Record<string, string> = {};

    for (const block of blocks) {
      if (deletedIds.has(block.id)) continue;

      const correction = textCorrections.get(block.id);
      const base = correction ?? block.text;

      const stripped = deletedHighlights && deletedHighlights.length > 0
        ? this.stripHighlightsFromBlock({ ...block, text: base }, deletedHighlights)
        : base;

      // A correction is an edit by definition; a strip only counts when it
      // actually removed something.
      if (correction !== undefined || stripped !== block.text) {
        effective[block.id] = stripped;
      }
    }

    return effective;
  }

  /**
   * Export by editing the SOURCE EPUB's own markup (the EPUB-source path).
   *
   * Thin wrapper over the main-process exporter: it only builds the deleted-block
   * examples the AI cleanup step consumes — exactly as exportToAudiobook does —
   * and normalizes the reply into the same ExportResult every caller here
   * already handles.
   */
  async exportEpubPreserving(
    projectDir: string | null,
    epubSourcePath: string,
    savePath: string | null,
    edits: EpubPreservingEdits,
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    deletedHighlights?: DeletedHighlight[],
    categories?: Map<string, Category>
  ): Promise<ExportResult> {
    if (!this.electron) {
      return {
        success: false,
        message: 'EPUB export is only available in Electron'
      };
    }

    const deletedBlockExamples = this.collectDeletedExamples(
      blocks,
      deletedIds,
      deletedHighlights,
      categories
    );

    try {
      const result = await this.electronService.exportEpubPreservingMarkup(
        projectDir,
        epubSourcePath,
        savePath,
        edits,
        deletedBlockExamples.length > 0 ? deletedBlockExamples : undefined
      );

      if (!result.success) {
        // The exporter names the block that blocked the export — never summarize it.
        return {
          success: false,
          message: result.error || 'Failed to export EPUB'
        };
      }

      if (!result.epubPath) {
        return {
          success: false,
          message: 'Export did not report where the EPUB was written.'
        };
      }

      const notes: string[] = [];
      if (result.unalignedUntouched && result.unalignedUntouched > 0) {
        notes.push(`${result.unalignedUntouched} block(s) could not be matched to the source EPUB and were left as the book has them.`);
      }
      if (result.warnings && result.warnings.length > 0) {
        notes.push(...result.warnings);
      }

      return {
        success: true,
        message: `Exported EPUB with ${result.chapterCount} chapters, preserving the source markup.`
          + (deletedBlockExamples.length > 0 ? ` (${deletedBlockExamples.length} deletion examples)` : '')
          + (notes.length > 0 ? `\n\n${notes.join('\n')}` : ''),
        filename: result.epubPath.split(/[/\\]/).pop(),
        epubPath: result.epubPath,
        chapterCount: result.chapterCount,
        blockCount: result.blockCount
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to export EPUB: ${message}`
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
   * Generate the EPUB blob. The one EPUB writer — every export path lands here.
   *
   * The structure comes from the blocks' own categories: `chapter` blocks split
   * the book, and every other class picks its element (see `markupKindFor`).
   * Callers may still pass hand-placed chapter markers; those are only consulted
   * when the book carries no `chapter` blocks at all, because a category is a
   * statement about the block itself while a marker is a coordinate that stops
   * being true the moment the page is re-OCR'd.
   */
  private generateEpubBlobInternal(
    blocks: ExportableBlock[],
    deletedIds: Set<string>,
    chapters: Chapter[],
    pdfName: string,
    textCorrections?: Map<string, string>,
    deletedPages?: Set<number>,
    deletedHighlights?: DeletedHighlight[],
    metadata?: BookMetadata,
    paragraphBreaks?: Set<string>
  ): { success: boolean; blob?: Blob; message?: string; chapterCount?: number; blockCount?: number; warning?: string } {
    console.log('[generateEpub] Input blocks:', blocks.length,
      'deletedIds:', deletedIds.size,
      'deletedPages:', deletedPages ? `Set(${deletedPages.size}): [${[...deletedPages].join(',')}]` : 'undefined',
      'pages in blocks:', [...new Set(blocks.map(b => b.page))].slice(0, 5).join(','));

    const exportBlocks = blocks
      .filter(b => !deletedIds.has(b.id) && !b.is_image && !deletedPages?.has(b.page))
      .sort((a, b) => a.page !== b.page ? a.page - b.page : a.y - b.y);

    console.log('[generateEpub] After filter:', exportBlocks.length, 'blocks,',
      'first page:', exportBlocks[0]?.page, 'pages:', [...new Set(exportBlocks.map(b => b.page))].slice(0, 5).join(','));

    if (exportBlocks.length === 0) {
      return { success: false, message: 'No text to export. All blocks have been deleted.' };
    }

    const bookTitle = metadata?.title || pdfName.replace(/\.(pdf|epub)$/i, '');

    const sortedChapters = chapters
      .filter(c => !deletedPages?.has(c.page))
      .sort((a, b) => a.page !== b.page ? a.page - b.page : (a.y || 0) - (b.y || 0));

    // Resolve every block's exported text BEFORE deciding the structure. A
    // chapter title is the same corrected/stripped/sanitized text the body gets,
    // and a block that sanitizes away to nothing must not leave a phantom
    // chapter boundary (or an empty <li>) behind it.
    const prepared: { block: ExportableBlock; text: string; kind: MarkupKind }[] = [];
    for (const block of exportBlocks) {
      let blockText = textCorrections?.get(block.id) ?? block.text;

      if (deletedHighlights && deletedHighlights.length > 0) {
        blockText = this.stripHighlightsFromBlock(
          { ...block, text: blockText },
          deletedHighlights
        );
      }

      const sanitizedText = this.sanitizeText(blockText);
      if (!sanitizedText) continue;

      prepared.push({ block, text: sanitizedText, kind: this.markupKindFor(block.category_id) });
    }

    if (prepared.length === 0) {
      return { success: false, message: 'No text to export. Every remaining block was empty after cleanup.' };
    }

    const plan = this.planChapters(prepared, sortedChapters);
    const sections = this.emitSections(prepared, plan, bookTitle, paragraphBreaks);

    // ebook2audiobook requires at least one chapter, and the planner guarantees
    // one — reaching zero means the emitter dropped something it should not have,
    // which is a bug to surface rather than an empty EPUB to ship.
    if (sections.length === 0) {
      return { success: false, message: 'No content to export after organizing by chapters.' };
    }

    // Every marker now becomes a section or a trailing section, so this can only
    // fire if the planner lost one. Kept as the invariant check it always was.
    const warnings: string[] = [];
    if (chapters.length > 0 && sections.length === 1) {
      console.warn('[EXPORT] Warning: %d chapters were provided but only 1 section generated.', chapters.length);
      console.warn('[EXPORT] Chapter pages:', chapters.map(c => c.page).join(', '));
      console.warn('[EXPORT] Block pages:', [...new Set(exportBlocks.map(b => b.page))].sort((a, b) => a - b).slice(0, 20).join(', '), '...');
      console.warn('[EXPORT] This usually means chapter page numbers don\'t match block page numbers.');
      warnings.push(`Warning: ${chapters.length} chapters were defined, but only 1 chapter was generated. This usually means the chapter page numbers don't match the text block page numbers. The TTS engine will use automatic chapter detection instead.`);
    }

    // `dc:language` is mandatory in EPUB 3, and guessing it is not harmless: the
    // value chooses the narrator's voice downstream, so defaulting a German book
    // to `en` produces an English-accented German audiobook and nothing anywhere
    // reports a failure. Refuse instead, and say exactly what to do about it.
    const language = metadata?.language?.trim();
    if (!language) {
      return {
        success: false,
        message: 'This book has no language set, and an EPUB cannot be written without one. '
          + 'Open Metadata, set the language (for example "en" or "de"), then export again.',
      };
    }

    const blob = this.generateEpubBlobWithChapters(bookTitle, sections, language, metadata);
    return {
      success: true,
      blob,
      chapterCount: sections.length,
      blockCount: exportBlocks.length,
      warning: warnings.length > 0 ? warnings.join('\n\n') : undefined
    };
  }

  /**
   * The markup shape for a block-category contract id.
   *
   * Ids outside the contract map to `body`: a user's own custom category, and a
   * block the classifier has never seen (`category_id: ''`, the state every
   * block is in before Detect or Label runs). That is not papering over a
   * missing value — an unlabelled block is a run of words the user chose to
   * keep, and a paragraph is the only honest rendering for words with no
   * structure attached.
   */
  private markupKindFor(categoryId: string | undefined): MarkupKind {
    switch (categoryId) {
      case 'title': return 'title';
      case 'chapter': return 'chapter';
      case 'heading': return 'heading';
      case 'subheading': return 'subheading';
      case 'quote': return 'quote';
      case 'caption': return 'caption';
      case 'list': return 'list';
      case 'table': return 'table';
      case 'footnote': return 'footnote';
      // Page furniture the user explicitly kept. Not this function's job to drop.
      case 'header':
      case 'footer':
      case 'image':
      case 'discard': return 'standalone';
      default: return 'body';
    }
  }

  /**
   * Where the book splits — from BOTH sources at once.
   *
   * A `chapter` block is a model's prediction; a hand-placed marker is the user
   * saying so. Picking one source throws the other away: preferring categories
   * meant a book with twenty markers where Detect happened to label three blocks
   * exported three chapters, with seventeen deliberate splits gone from the
   * spine and the TOC, the user's corrected titles lost, and each marker-bound
   * heading re-read as prose mid-sentence. So they are merged in document order.
   *
   * Where both name the same place — the marker resolves into a category run, or
   * lands at the same block — the MARKER's title and level win, because explicit
   * user intent outranks a prediction. Two distinct markers at one position stay
   * two chapters; that is not a duplicate.
   */
  private planChapters(
    prepared: { block: ExportableBlock; text: string; kind: MarkupKind }[],
    sortedChapters: Chapter[]
  ): ChapterPlan {
    interface PlannedChapter { title: string; level: number; fromMarker: boolean }
    const planned = new Map<number, PlannedChapter[]>();
    const consumed = new Set<number>();
    const trailing: { title: string; level: number }[] = [];

    // Category runs. Adjacent `chapter` blocks are ONE title: an opening set as
    // "CHAPTER SEVEN" over "The Long Retreat" arrives as two blocks, and
    // splitting twice there makes an empty section and a heading that reads as a
    // sentence fragment.
    const runStart = new Map<number, number>();
    let i = 0;
    while (i < prepared.length) {
      if (prepared[i].kind !== 'chapter') {
        i++;
        continue;
      }

      const start = i;
      const lines: string[] = [];
      while (i < prepared.length && prepared[i].kind === 'chapter') {
        lines.push(prepared[i].text);
        consumed.add(i);
        runStart.set(i, start);
        i++;
      }

      planned.set(start, [{ title: this.joinParagraphLines(lines), level: 1, fromMarker: false }]);
    }

    const indexOfBlock = new Map<string, number>();
    for (let j = 0; j < prepared.length; j++) indexOfBlock.set(prepared[j].block.id, j);

    // A block bound to a marker is rendered as that section's heading, so it must
    // not also appear as body — matched by id, never by text or position, so a
    // rename or a re-OCR cannot turn the dedup into a silent prose deletion.
    for (const ch of sortedChapters) {
      for (const bid of [ch.blockId, ...(ch.mergedBlockIds ?? [])]) {
        if (!bid) continue;
        const at = indexOfBlock.get(bid);
        if (at !== undefined) consumed.add(at);
      }
    }

    // Position each marker on the first block at or after its coordinates, the
    // walk this has always used.
    const anchors: (number | null)[] = sortedChapters.map(() => null);
    let marker = 0;
    for (let j = 0; j < prepared.length && marker < sortedChapters.length; j++) {
      const block = prepared[j].block;
      while (
        marker < sortedChapters.length &&
        (block.page > sortedChapters[marker].page ||
         (block.page === sortedChapters[marker].page &&
          block.y >= (sortedChapters[marker].y || 0)))
      ) {
        anchors[marker] = j;
        marker++;
      }
    }

    for (let m = 0; m < sortedChapters.length; m++) {
      const ch = sortedChapters[m];
      // The bound block id beats the coordinates: an id survives a re-OCR that
      // moves every y on the page.
      const bound = ch.blockId !== undefined ? indexOfBlock.get(ch.blockId) : undefined;
      const at = bound ?? anchors[m];

      if (at === null || at === undefined) {
        // Past the last exportable block — would otherwise vanish entirely.
        trailing.push({ title: ch.title, level: ch.level || 1 });
        continue;
      }

      // A marker landing anywhere inside a category run is naming that run's
      // chapter, not opening a second one a line later.
      const target = runStart.get(at) ?? at;
      const list = planned.get(target) ?? [];
      list.push({ title: ch.title, level: ch.level || 1, fromMarker: true });
      planned.set(target, list);
    }

    const startsAt = new Map<number, { title: string; level: number }[]>();
    for (const [at, list] of planned) {
      const markers = list.filter(c => c.fromMarker);
      const kept = markers.length > 0 ? markers : list;
      startsAt.set(at, kept.map(c => ({ title: c.title, level: c.level })));
    }

    return {
      startsAt,
      consumed,
      trailing,
      hasChapters: startsAt.size > 0 || trailing.length > 0
    };
  }

  /**
   * Turn the prepared blocks into XHTML sections.
   *
   * The paragraph rule is the load-bearing part: a `<p>` boundary is a prosody
   * boundary for the TTS engine, so one is only opened where the book actually
   * has one. With explicit `paragraphBreaks` the run is cut at those ids; with
   * none, a whole run of consecutive body blocks is a SINGLE paragraph, because
   * the blocks are OCR lines and one `<p>` per line makes the narrator stop at
   * the end of every printed line.
   */
  private emitSections(
    prepared: { block: ExportableBlock; text: string; kind: MarkupKind }[],
    plan: ChapterPlan,
    bookTitle: string,
    paragraphBreaks?: Set<string>
  ): EpubSection[] {
    const sections: EpubSection[] = [];
    const useBreaks = !!paragraphBreaks && paragraphBreaks.size > 0;

    // With no chapters anywhere this opening section IS the book's one chapter,
    // so it is never dropped. It carries no heading of its own: the title would
    // be one the printed page does not have, and the narrator would read it out.
    let current: EpubSection = {
      title: bookTitle,
      level: 1,
      frontMatter: plan.hasChapters,
      showHeading: false,
      content: [],
      footnotes: []
    };

    let proseKind: 'body' | 'quote' | null = null;
    let proseLines: string[] = [];
    let proseParagraphs: string[] = [];
    let tableRows: string[] | null = null;

    const closeProse = () => {
      if (proseKind === null) return;
      if (proseLines.length > 0) {
        proseParagraphs.push(this.joinParagraphLines(proseLines));
        proseLines = [];
      }
      // Emitted exactly as accumulated. A run only splits where the user placed a
      // break, and re-merging any paragraph that does not end in terminal
      // punctuation would delete those breaks — a paragraph ending "as follows:"
      // or on an OCR'd note number ("the long retreat.3") is a perfectly good
      // paragraph, and in no-breaks mode there is nothing to merge in the first
      // place because the whole run is already one <p>.
      const paragraphs = proseParagraphs.map(p => `<p>${p}</p>`);
      if (proseKind === 'quote') {
        current.content.push(`<blockquote>\n${paragraphs.map(p => `  ${p}`).join('\n')}\n</blockquote>`);
      } else {
        current.content.push(...paragraphs);
      }
      proseParagraphs = [];
      proseKind = null;
    };

    const closeTable = () => {
      if (!tableRows) return;
      current.content.push(`<table>\n${tableRows.join('\n')}\n</table>`);
      tableRows = null;
    };

    const closeRuns = () => {
      closeProse();
      closeTable();
    };

    const finishSection = () => {
      closeRuns();
      if (current.footnotes.length > 0) {
        // No "Notes" heading: it is English the printed page does not have, and
        // the narrator would read it out at the end of every chapter — in a
        // German book too. The epub:type is what marks the section.
        current.content.push(
          `<section epub:type="footnotes" class="footnotes">\n`
          + `${current.footnotes.map(f => `  ${f}`).join('\n')}\n</section>`
        );
      }
      // A chapter with no body is still a chapter — its heading is content. An
      // empty front-matter bucket is not.
      if (current.content.length > 0 || !current.frontMatter) sections.push(current);
    };

    for (let i = 0; i < prepared.length; i++) {
      const starts = plan.startsAt.get(i);
      if (starts) {
        for (const start of starts) {
          finishSection();
          current = {
            title: start.title,
            level: start.level,
            frontMatter: false,
            showHeading: true,
            content: [],
            footnotes: []
          };
        }
      }

      if (plan.consumed.has(i)) continue;

      const { block, text, kind } = prepared[i];
      const escaped = this.escapeHtml(text);

      switch (kind) {
        case 'body':
        case 'quote': {
          closeTable();
          if (proseKind !== null && proseKind !== kind) closeProse();
          proseKind = kind;
          if (useBreaks && paragraphBreaks!.has(block.id) && proseLines.length > 0) {
            proseParagraphs.push(this.joinParagraphLines(proseLines));
            proseLines = [];
          }
          proseLines.push(escaped);
          break;
        }
        case 'list':
          // A list entry is its OWN <p>, never a <li>. <p> is the unit the TTS
          // pipeline reads as one prosody group; whatever extracts text from the
          // EPUB downstream may drop <li> boundaries or turn them into spurious
          // pauses. The class carries the visual difference through CSS instead.
          closeRuns();
          current.content.push(`<p class="list">${escaped}</p>`);
          break;
        case 'table':
          // A table keeps its structure — it is never narrated as prose, and the
          // grid IS the content.
          closeProse();
          if (!tableRows) tableRows = [];
          tableRows.push(`  <tr><td>${escaped}</td></tr>`);
          break;
        case 'title':
          closeRuns();
          current.content.push(`<h1 class="book-title">${escaped}</h1>`);
          break;
        case 'heading':
          closeRuns();
          current.content.push(`<h2>${escaped}</h2>`);
          break;
        case 'subheading':
          closeRuns();
          current.content.push(`<h3>${escaped}</h3>`);
          break;
        case 'caption':
          closeRuns();
          // Wrapped in a <figure> because HTML5 only admits <figcaption> as a
          // figure's child — a bare one is well-formed XML that epubcheck
          // rejects. The figure holds only the caption: image blocks export as
          // their OCR text, not as embedded raster.
          current.content.push(`<figure>\n  <figcaption>${escaped}</figcaption>\n</figure>`);
          break;
        case 'footnote':
          // Held back and emitted after the chapter's prose, so the narrator does
          // not read a note into the middle of the sentence that cites it.
          //
          // Deliberately does NOT close the prose run: nothing is written to the
          // section here, so there is no ordering to preserve, and a footnote
          // sits at the foot of a page — between the last body block of one page
          // and the first of the next, i.e. inside the sentence that straddles
          // them. Closing here put a full stop in the middle of that sentence on
          // every footnote-bearing page.
          current.footnotes.push(`<p>${escaped}</p>`);
          break;
        case 'standalone':
          closeRuns();
          current.content.push(`<p>${escaped}</p>`);
          break;
        case 'chapter':
          // Consumed by the planner as this section's title.
          break;
      }
    }

    finishSection();

    for (const t of plan.trailing) {
      current = {
        title: t.title,
        level: t.level,
        frontMatter: false,
        showHeading: true,
        content: [],
        footnotes: []
      };
      finishSection();
    }

    return sections;
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

  /**
   * Join paragraph buffer lines, handling end-of-line hyphens.
   * If line A ends with a hyphen and line B starts with a lowercase letter,
   * join them without space and strip the hyphen ("excep-" + "tional" = "exceptional").
   */
  private joinParagraphLines(lines: string[]): string {
    if (lines.length === 0) return '';
    if (lines.length === 1) return lines[0];

    let result = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (result.endsWith('-') && line.length > 0 && line[0] === line[0].toLowerCase() && line[0] !== line[0].toUpperCase()) {
        // Strip trailing hyphen and join without space
        result = result.slice(0, -1) + line;
      } else {
        result += ' ' + line;
      }
    }
    return result;
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

  /**
   * Ensure a chapter title ends with a period for TTS readability.
   * TTS engines often run headings into the following text without punctuation,
   * so we add a period to create a natural pause.
   */
  private ensureTitleEndsWithPunctuation(title: string): string {
    const trimmed = title.trim();
    if (!trimmed) return trimmed;
    // Check if title already ends with sentence-ending punctuation
    const lastChar = trimmed[trimmed.length - 1];
    if (['.', '!', '?', ':', ';'].includes(lastChar)) {
      return trimmed;
    }
    return trimmed + '.';
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * The EPUB's one stylesheet. Every XHTML document links it.
   *
   * `p.list` is styled rather than marked up as a list: list entries stay `<p>`
   * so the TTS pipeline sees one kind of prosody unit everywhere, and the hanging
   * indent is what makes them still READ as a list.
   */
  private readonly epubStylesheet = `body {
  font-family: serif;
  line-height: 1.6;
  margin: 1em;
}

h1, h2, h3 {
  line-height: 1.25;
  page-break-after: avoid;
}

h1 { font-size: 1.6em; margin: 1.2em 0 0.8em; }
h2 { font-size: 1.3em; margin: 1.2em 0 0.6em; }
h3 { font-size: 1.1em; margin: 1em 0 0.5em; }

h1.book-title {
  font-size: 2em;
  text-align: center;
  margin: 2em 0 1em;
}

p {
  margin: 0.5em 0;
  text-indent: 1em;
}

p.list {
  margin: 0.2em 0 0.2em 1.5em;
  text-indent: -1.5em;
}

blockquote {
  margin: 1em 2em;
  font-size: 0.95em;
}

blockquote p { text-indent: 0; }

figure {
  margin: 0;
}

figcaption {
  font-size: 0.9em;
  font-style: italic;
  text-align: center;
  margin: 0.5em 0 1.2em;
}

table {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
}

td {
  border: 1px solid #999999;
  padding: 0.25em 0.5em;
  text-align: left;
  vertical-align: top;
}

.footnotes {
  margin-top: 2.5em;
  padding-top: 0.5em;
  border-top: 1px solid #999999;
  font-size: 0.9em;
}

.footnotes p {
  text-indent: 0;
  margin: 0.4em 0;
}
`;

  /**
   * Generate EPUB with chapter structure (for better ebook reader compatibility)
   */
  private generateEpubBlobWithChapters(
    title: string,
    chapters: EpubSection[],
    language: string,
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
    <dc:language>${this.escapeHtml(language)}</dc:language>
    <meta property="dcterms:modified">${date}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
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

    const chapterXhtmls = chapters.map((chapter, i) => {
      // A section only announces its own title when it HAS one from the book —
      // a front-matter bucket or a whole-book single chapter does not, and a
      // synthetic heading there is a line the narrator would read aloud.
      const level = Math.min(chapter.level, 3);
      const headingHtml = chapter.showHeading
        ? `  <h${level}>${this.escapeHtml(this.ensureTitleEndsWithPunctuation(chapter.title))}</h${level}>\n`
        : '';

      return {
        index: i + 1,
        // The epub namespace is declared on every document because the footnotes
        // section carries epub:type.
        xhtml: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${this.escapeHtml(chapter.title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${headingHtml}${chapter.content.join('\n')}
</body>
</html>`
      };
    });

    const files: { name: string; content: string }[] = [
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: containerXml },
      { name: 'OEBPS/content.opf', content: contentOpf },
      { name: 'OEBPS/style.css', content: this.epubStylesheet },
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
  private buildNavItems(chapters: { title: string; level: number }[]): string {
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
      const crc = this.crc32(fileData);

      // Local file header
      const localHeader = new Uint8Array(30 + fileName.length);
      const view = new DataView(localHeader.buffer);

      view.setUint32(0, 0x04034b50, true);  // Local file header signature
      view.setUint16(4, 20, true);           // Version needed to extract
      view.setUint16(6, 0, true);            // General purpose bit flag
      view.setUint16(8, 0, true);            // Compression method (store)
      view.setUint16(10, 0, true);           // File last mod time
      view.setUint16(12, 0, true);           // File last mod date
      view.setUint32(14, crc, true); // CRC-32
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
      centralView.setUint32(16, crc, true); // CRC-32
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

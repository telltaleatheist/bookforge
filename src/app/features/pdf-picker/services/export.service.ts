import { Injectable, inject } from '@angular/core';
import { PdfService, Category } from './pdf.service';
import { Chapter, ElectronService, EpubPreservingEdits } from '../../../core/services/electron.service';
import { DeletedBlockExample } from '../../queue/models/queue.types';
import { WORKING_COPY_SUFFIX } from '@shared/document/book-path';

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
   * The block-category contract id (shared/ocr/block-categories.ts). Optional
   * only because a block that has never been through Detect or Label carries
   * `''`; every caller passes a full `TextBlock`, where the field is required.
   */
  category_id?: string;
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
 * ExportService — the exports that are NOT the book.
 *
 * Making the book is Reflow's, and Reflow's alone: it reads the working document
 * and writes `<Original>.epub` (docs/DOCUMENT_PIPELINE.md §Reflow). The EPUB
 * writer that used to live here — `generateEpubBlobInternal` and everything that
 * fed it — is gone, because two writers meant two different books out of one set
 * of blocks, and which one you got depended on how the export was reached.
 *
 * What remains is the side exports (a .txt or a redacted .pdf of what is on
 * screen) and the markup-preserving EPUB path, which is not a second writer at
 * all: it edits the SOURCE EPUB's own XHTML in the main process rather than
 * rebuilding a book from block text.
 *
 * Stateless — all data passed as method parameters for testability.
 */
@Injectable({
  providedIn: 'root'
})
export class ExportService {
  private readonly pdfService = inject(PdfService);
  private readonly electronService = inject(ElectronService);

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
   * The blocks whose text GENUINELY changed, keyed by block id.
   *
   * This is the markup-preserving export's rebuild list: a block that appears
   * here loses its source markup (the element is rebuilt as plain text), and a
   * block that does not appear is copied out of the book verbatim. So the set has
   * to be exactly the blocks the user really edited — nothing more.
   *
   * Sanitization is therefore NOT applied here. Stripping object replacement
   * characters, control characters and double spaces would flag a block as
   * "changed" because the SOURCE had a stray U+FFFC in it, and strip its italics
   * as a side effect. The main process sanitizes the text of an element it is
   * already rebuilding.
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
    categories?: Map<string, Category>,
    /** WHICH working chain the export registers against — the window's own. */
    familyId?: string,
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
        deletedBlockExamples.length > 0 ? deletedBlockExamples : undefined,
        familyId,
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
   * The name of the file this export downloads as, from the name of the document
   * it came out of.
   *
   * The suffix strip has to know about `.working`. A migrated project's document
   * is the exploded working copy `<stem>.working`, and the `(pdf|epub)` strip is
   * a no-op on it — so `.working` survived into the next line, where the
   * non-alphanumeric squash laundered the dot into an underscore and shipped the
   * user `Nuremberg__Persico__Joseph_E___1994__working_cleaned_2026-08-11.txt`.
   * A container detail ended up in the middle of a filename as if it were part of
   * the book's title.
   *
   * Stripped as a KNOWN suffix — `WORKING_COPY_SUFFIX`, the app's one spelling of
   * it — and never as "whatever follows the last dot": real book names carry dots
   * of their own ("Nuremberg. Persico, Joseph E. (1994)"), and a blind
   * `\.[^.]+$` would eat "(1994)" off a plain `.epub` that had already been
   * stripped. It runs AFTER the format strip so the zipped family members
   * (`<stem>.working.epub`) lose both halves.
   */
  private generateFilename(pdfName: string, extension: string): string {
    const withoutFormat = pdfName.replace(/\.(pdf|epub)$/i, '');
    const withoutWorking = withoutFormat.toLowerCase().endsWith(WORKING_COPY_SUFFIX)
      ? withoutFormat.slice(0, -WORKING_COPY_SUFFIX.length)
      : withoutFormat;
    const baseName = withoutWorking.replace(/[^a-zA-Z0-9_-]/g, '_');
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
}

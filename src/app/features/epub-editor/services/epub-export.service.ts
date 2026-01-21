import { Injectable, inject } from '@angular/core';
import { EpubEditorStateService } from './epub-editor-state.service';
import { EpubSearchService } from './epub-search.service';
import { ElectronService } from '../../../core/services/electron.service';
import { EpubHighlight, getEpubHighlightId } from '../../../core/models/epub-highlight.types';

/**
 * Text removal instruction for the main process
 */
export interface TextRemovalEntry {
  chapterId: string;
  text: string;
  cfi: string;
}

/**
 * Export result
 */
export interface EpubExportResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

/**
 * EpubExportService - Handles EPUB export with deletions applied
 *
 * Flow:
 * 1. Collect all deleted highlights
 * 2. Group by chapter
 * 3. Send to main process for text removal
 * 4. Save modified EPUB
 */
@Injectable({
  providedIn: 'root'
})
export class EpubExportService {
  private readonly editorState = inject(EpubEditorStateService);
  private readonly searchService = inject(EpubSearchService);
  private readonly electron = inject(ElectronService);

  /**
   * Export EPUB with deleted content removed
   * Supports both block-based deletions (from EPUB editor) and highlight-based deletions
   */
  async exportWithDeletions(outputPath?: string): Promise<EpubExportResult> {
    const epubPath = this.editorState.effectivePath();
    console.log('[EPUB Export] Starting export, epubPath:', epubPath);

    if (!epubPath) {
      console.log('[EPUB Export] No EPUB loaded');
      return { success: false, error: 'No EPUB loaded' };
    }

    // Check for block-based deletions first (primary deletion mode for EPUB editor)
    const deletedBlockIds = Array.from(this.editorState.deletedBlockIds());
    console.log('[EPUB Export] Deleted block IDs count:', deletedBlockIds.length);

    if (deletedBlockIds.length > 0) {
      console.log('[EPUB Export] Using block-based deletion export');
      console.log('[EPUB Export] Deleted blocks:', deletedBlockIds);

      try {
        const result = await this.electron.exportEpubWithDeletedBlocks(
          epubPath,
          deletedBlockIds,
          outputPath
        );
        console.log('[EPUB Export] Result:', result);
        return result;
      } catch (error) {
        console.error('[EPUB Export] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Export failed'
        };
      }
    }

    // Fall back to highlight-based deletions (for search/custom category deletions)
    const deletedHighlights = this.searchService.getDeletedHighlightsForExport();
    console.log('[EPUB Export] Deleted highlights count:', deletedHighlights.length);

    if (deletedHighlights.length === 0) {
      console.log('[EPUB Export] No deletions, copying file');
      // No deletions - just copy the file
      return this.exportCopy(outputPath);
    }

    // Group by chapter and prepare removal instructions
    const removalsByChapter = this.groupHighlightsByChapter(deletedHighlights);
    console.log('[EPUB Export] Removals by chapter:', Array.from(removalsByChapter.entries()));

    try {
      // Call the main process to perform the export
      const result = await this.electron.exportEpubWithRemovals(
        epubPath,
        removalsByChapter,
        outputPath
      );
      console.log('[EPUB Export] Result:', result);

      return result;
    } catch (error) {
      console.error('[EPUB Export] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Export failed'
      };
    }
  }

  /**
   * Export as plain text (only non-deleted content)
   */
  async exportAsText(): Promise<{ success: boolean; text?: string; error?: string }> {
    const includedHighlights = this.searchService.getHighlightsForExport();

    // If no highlights, return empty
    if (includedHighlights.length === 0) {
      return { success: true, text: '' };
    }

    // Combine text from all included highlights
    const text = includedHighlights
      .map(h => h.text)
      .join('\n\n');

    return { success: true, text };
  }

  /**
   * Get export preview (what will be removed)
   * Includes both block-based and highlight-based deletions
   */
  getExportPreview(): {
    deletedCount: number;
    deletedChars: number;
    blockCount: number;
    byChapter: Map<string, { count: number; chars: number }>;
  } {
    // Count block-based deletions
    const deletedBlockIds = this.editorState.deletedBlockIds();
    const blockCount = deletedBlockIds.size;

    // Group blocks by section for stats
    const bySection = new Map<string, number>();
    deletedBlockIds.forEach(blockId => {
      const colonIndex = blockId.lastIndexOf(':');
      if (colonIndex > 0) {
        const sectionHref = blockId.substring(0, colonIndex);
        bySection.set(sectionHref, (bySection.get(sectionHref) || 0) + 1);
      }
    });

    // Also get highlight-based deletions
    const deletedHighlights = this.searchService.getDeletedHighlightsForExport();
    const byChapter = new Map<string, { count: number; chars: number }>();

    for (const highlight of deletedHighlights) {
      const existing = byChapter.get(highlight.chapterId) || { count: 0, chars: 0 };
      byChapter.set(highlight.chapterId, {
        count: existing.count + 1,
        chars: existing.chars + highlight.text.length
      });
    }

    return {
      deletedCount: deletedHighlights.length,
      deletedChars: deletedHighlights.reduce((sum, h) => sum + h.text.length, 0),
      blockCount,
      byChapter
    };
  }

  /**
   * Simple copy export (no modifications)
   */
  private async exportCopy(outputPath?: string): Promise<EpubExportResult> {
    const epubPath = this.editorState.effectivePath();
    if (!epubPath) {
      return { success: false, error: 'No EPUB loaded' };
    }

    // If no output path, use the original path with _edited suffix
    const finalPath = outputPath || epubPath.replace(/\.epub$/i, '_edited.epub');

    try {
      const result = await this.electron.copyFile(epubPath, finalPath);
      return {
        success: result.success,
        outputPath: finalPath,
        error: result.error
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Copy failed'
      };
    }
  }

  /**
   * Group highlights by chapter for efficient processing
   */
  private groupHighlightsByChapter(highlights: EpubHighlight[]): Map<string, TextRemovalEntry[]> {
    const grouped = new Map<string, TextRemovalEntry[]>();

    for (const highlight of highlights) {
      const existing = grouped.get(highlight.chapterId) || [];
      existing.push({
        chapterId: highlight.chapterId,
        text: highlight.text,
        cfi: highlight.cfi
      });
      grouped.set(highlight.chapterId, existing);
    }

    return grouped;
  }
}

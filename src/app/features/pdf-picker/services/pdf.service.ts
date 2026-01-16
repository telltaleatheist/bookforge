import { Injectable, inject } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';

export interface TextBlock {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  font_size: number;
  font_name: string;
  char_count: number;
  region: string;
  category_id: string;
  is_bold?: boolean;
  is_italic?: boolean;
  is_superscript?: boolean;
  is_image?: boolean;
  is_footnote_marker?: boolean;  // Inline footnote reference marker (¹, ², [1], etc.)
  parent_block_id?: string;      // If this is a marker extracted from a parent block
  line_count?: number;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  color: string;
  block_count: number;
  char_count: number;
  font_size: number;
  region: string;
  sample_text: string;
  enabled: boolean;
}

export interface PageDimension {
  width: number;
  height: number;
}

export interface PdfAnalysisResult {
  blocks: TextBlock[];
  categories: Record<string, Category>;
  page_count: number;
  page_dimensions: PageDimension[];
  pdf_name: string;
}

/**
 * PdfService - Handles PDF analysis and manipulation
 *
 * Uses pure TypeScript mupdf.js - no Python required!
 * In browser mode: Falls back to HTTP API (legacy Flask server)
 */
@Injectable({
  providedIn: 'root',
})
export class PdfService {
  private readonly electron = inject(ElectronService);
  private readonly apiBase = 'http://localhost:5848';

  async analyzePdf(pdfPath: string, maxPages?: number): Promise<PdfAnalysisResult> {
    if (this.electron.isRunningInElectron) {
      const result = await this.electron.analyzePdf(pdfPath, maxPages);
      if (result.success && result.data) {
        return result.data as PdfAnalysisResult;
      }
      throw new Error(result.error || 'Failed to analyze PDF');
    }

    // HTTP fallback for browser dev
    const response = await fetch(`${this.apiBase}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_path: pdfPath, max_pages: maxPages || null }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to analyze PDF');
    }

    return response.json();
  }

  getPageImageUrl(pageNum: number, scale = 2.0): string {
    // Fallback URL for browser mode - used if async rendering fails
    return `${this.apiBase}/api/page/${pageNum}?scale=${scale}`;
  }

  async renderPage(pageNum: number, scale = 2.0, pdfPath?: string): Promise<string | null> {
    return this.electron.renderPage(pageNum, scale, pdfPath);
  }

  async exportText(enabledCategoryIds: string[]): Promise<{ text: string; char_count: number }> {
    if (this.electron.isRunningInElectron) {
      const result = await this.electron.exportPdfText(enabledCategoryIds);
      if (result) {
        return result;
      }
      throw new Error('Failed to export text');
    }

    const response = await fetch(`${this.apiBase}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled_categories: enabledCategoryIds }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to export');
    }

    return response.json();
  }

  async findSimilar(blockId: string): Promise<string[]> {
    if (this.electron.isRunningInElectron) {
      const result = await this.electron.findSimilarBlocks(blockId);
      if (result) {
        return result.similar_ids;
      }
      throw new Error('Failed to find similar');
    }

    const response = await fetch(`${this.apiBase}/api/similar/${blockId}`);
    const data = await response.json();
    return data.similar_ids;
  }

  async exportCleanPdf(pdfPath: string, deletedRegions: Array<{ page: number; x: number; y: number; width: number; height: number }>): Promise<string> {
    return this.electron.exportCleanPdf(pdfPath, deletedRegions);
  }
}

import { Injectable, inject } from '@angular/core';
import { EpubjsService } from './epubjs.service';
import { EpubEditorStateService } from './epub-editor-state.service';
import { EpubHighlight, EpubCategory, getEpubHighlightId } from '../../../core/models/epub-highlight.types';

/**
 * Search result with additional metadata
 */
export interface EpubSearchMatch {
  cfi: string;
  chapterId: string;
  chapterLabel: string;
  text: string;
  excerpt: string;
}

/**
 * EpubSearchService - Handles text search and pattern matching in EPUBs
 *
 * Provides:
 * - Regex-based search across all chapters
 * - Category creation from search patterns
 * - Sample-based pattern learning (future)
 */
@Injectable({
  providedIn: 'root'
})
export class EpubSearchService {
  private readonly epubjs = inject(EpubjsService);
  private readonly editorState = inject(EpubEditorStateService);

  /**
   * Search all chapters for a pattern and return matches
   */
  async searchPattern(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      maxResults?: number;
      regex?: boolean;
    }
  ): Promise<EpubSearchMatch[]> {
    const chapters = this.epubjs.chapters();
    if (chapters.length === 0) return [];

    const results: EpubSearchMatch[] = [];
    const maxResults = options?.maxResults || 1000;

    // For each chapter, search for the pattern
    for (const chapter of chapters) {
      if (results.length >= maxResults) break;

      const chapterResults = await this.epubjs.searchChapter(chapter.href, pattern);

      for (const result of chapterResults) {
        if (results.length >= maxResults) break;

        results.push({
          cfi: result.cfi,
          chapterId: chapter.id,
          chapterLabel: chapter.label,
          // IMPORTANT: text is the actual search pattern, NOT the excerpt
          text: pattern,
          excerpt: result.excerpt,
        });
      }
    }

    return results;
  }

  /**
   * Create a category from search matches
   */
  createCategoryFromSearch(
    name: string,
    description: string,
    color: string,
    pattern: string,
    matches: EpubSearchMatch[]
  ): string {
    const categoryId = `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create the category
    const category: EpubCategory = {
      id: categoryId,
      name,
      description,
      color,
      type: 'custom',
      pattern,
      enabled: true,
      highlightCount: matches.length,
      charCount: matches.reduce((sum, m) => sum + m.text.length, 0),
    };

    this.editorState.addCategory(category);

    // Convert matches to highlights
    const highlights: EpubHighlight[] = matches.map(match => ({
      cfi: match.cfi,
      chapterId: match.chapterId,
      text: match.text,
      excerpt: match.excerpt,
    }));

    this.editorState.addHighlights(categoryId, highlights);

    return categoryId;
  }

  /**
   * Search with a regular expression pattern
   */
  async searchRegex(
    pattern: string,
    flags: string = 'gi',
    maxResults: number = 1000
  ): Promise<EpubSearchMatch[]> {
    // epub.js doesn't natively support regex, so we search for literal parts
    // and filter results with the regex
    const regex = new RegExp(pattern, flags);
    const chapters = this.epubjs.chapters();
    const results: EpubSearchMatch[] = [];

    // Extract a searchable literal from the regex (simplistic approach)
    const literalPart = this.extractLiteralFromRegex(pattern);

    if (!literalPart) {
      console.warn('Cannot extract literal part from regex pattern:', pattern);
      return [];
    }

    // Search for the literal part, then filter with regex
    for (const chapter of chapters) {
      if (results.length >= maxResults) break;

      const chapterResults = await this.epubjs.searchChapter(chapter.href, literalPart);

      for (const result of chapterResults) {
        if (results.length >= maxResults) break;

        // Filter with regex
        const text = this.extractTextFromExcerpt(result.excerpt);
        if (regex.test(text)) {
          results.push({
            cfi: result.cfi,
            chapterId: chapter.id,
            chapterLabel: chapter.label,
            text,
            excerpt: result.excerpt,
          });
        }
      }
    }

    return results;
  }

  /**
   * Find common patterns in a set of text samples
   * Returns potential regex patterns that match all samples
   */
  analyzePatterns(samples: string[]): string[] {
    if (samples.length === 0) return [];

    const patterns: string[] = [];

    // Check for common prefixes
    const commonPrefix = this.findCommonPrefix(samples);
    if (commonPrefix.length >= 2) {
      patterns.push(`^${this.escapeRegex(commonPrefix)}`);
    }

    // Check for common suffixes
    const commonSuffix = this.findCommonSuffix(samples);
    if (commonSuffix.length >= 2) {
      patterns.push(`${this.escapeRegex(commonSuffix)}$`);
    }

    // Check for numeric patterns
    const allNumeric = samples.every(s => /^\d+$/.test(s.trim()));
    if (allNumeric) {
      patterns.push('\\b\\d+\\b');
    }

    // Check for Roman numerals
    const allRoman = samples.every(s => /^[IVXLCDM]+$/i.test(s.trim()));
    if (allRoman) {
      patterns.push('\\b[IVXLCDM]+\\b');
    }

    // Exact match pattern (if samples are similar)
    if (samples.length <= 5) {
      const escaped = samples.map(s => this.escapeRegex(s.trim()));
      patterns.push(`(${escaped.join('|')})`);
    }

    return patterns;
  }

  /**
   * Get highlights for export (non-deleted only)
   */
  getHighlightsForExport(): EpubHighlight[] {
    const deleted = this.editorState.deletedHighlightIds();
    const highlights: EpubHighlight[] = [];

    this.editorState.categoryHighlights().forEach((chapterMap, categoryId) => {
      chapterMap.forEach((chapterHighlights, chapterId) => {
        for (const highlight of chapterHighlights) {
          const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
          if (!deleted.has(id)) {
            highlights.push(highlight);
          }
        }
      });
    });

    return highlights;
  }

  /**
   * Get deleted highlights for export
   */
  getDeletedHighlightsForExport(): EpubHighlight[] {
    const deleted = this.editorState.deletedHighlightIds();
    const highlights: EpubHighlight[] = [];

    this.editorState.categoryHighlights().forEach((chapterMap, categoryId) => {
      chapterMap.forEach((chapterHighlights, chapterId) => {
        for (const highlight of chapterHighlights) {
          const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
          if (deleted.has(id)) {
            highlights.push(highlight);
          }
        }
      });
    });

    return highlights;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extract plain text from an excerpt (remove HTML/highlighting markers)
   */
  private extractTextFromExcerpt(excerpt: string): string {
    // epub.js excerpts may contain HTML or markers
    return excerpt
      .replace(/<[^>]+>/g, '') // Remove HTML tags
      .replace(/\s+/g, ' ')    // Normalize whitespace
      .trim();
  }

  /**
   * Extract a literal searchable string from a regex pattern
   */
  private extractLiteralFromRegex(pattern: string): string | null {
    // Remove regex metacharacters and extract longest literal sequence
    const literals = pattern.split(/[\\^$.*+?()[\]{}|]/);
    const longest = literals.reduce((a, b) => a.length > b.length ? a : b, '');
    return longest.length >= 2 ? longest : null;
  }

  /**
   * Find common prefix among strings
   */
  private findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (strings[i].indexOf(prefix) !== 0) {
        prefix = prefix.substring(0, prefix.length - 1);
        if (prefix.length === 0) return '';
      }
    }
    return prefix;
  }

  /**
   * Find common suffix among strings
   */
  private findCommonSuffix(strings: string[]): string {
    const reversed = strings.map(s => s.split('').reverse().join(''));
    const commonReversed = this.findCommonPrefix(reversed);
    return commonReversed.split('').reverse().join('');
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

import { Injectable, signal, computed, NgZone, inject } from '@angular/core';
import ePub, { Book, Rendition, Contents, NavItem } from 'epubjs';
import type Section from 'epubjs/types/section';
import type Spine from 'epubjs/types/spine';
import { EpubSearchResult, EpubChapterInfo, EpubHighlight } from '../../../core/models/epub-highlight.types';

/**
 * EpubjsService - Angular wrapper for epub.js library
 *
 * Handles:
 * - EPUB loading and rendering
 * - CFI generation from text selections
 * - Text search across chapters
 * - Annotation/highlight management
 */
@Injectable({
  providedIn: 'root'
})
export class EpubjsService {
  private readonly ngZone = inject(NgZone);

  private book: Book | null = null;
  private rendition: Rendition | null = null;

  // State signals
  readonly isLoaded = signal(false);
  readonly isRendered = signal(false);
  readonly currentChapter = signal<EpubChapterInfo | null>(null);
  readonly chapters = signal<EpubChapterInfo[]>([]);
  readonly title = signal('');
  readonly author = signal('');
  readonly coverUrl = signal<string | null>(null);
  readonly totalChapters = signal(0);

  // Selection state
  readonly selectedCfi = signal<string | null>(null);
  readonly selectedText = signal<string | null>(null);

  // Navigation state
  readonly atStart = signal(true);
  readonly atEnd = signal(false);

  // Event callbacks
  private selectionCallback: ((cfi: string, text: string, contents: Contents) => void) | null = null;
  private relocatedCallback: ((location: { start: { cfi: string }; end: { cfi: string } }) => void) | null = null;

  /**
   * Load an EPUB file from a path or URL
   */
  async loadEpub(source: string | ArrayBuffer): Promise<void> {
    // Clean up previous book if any
    this.destroy();

    this.book = ePub(source);

    // Wait for book to be ready
    await this.book.ready;

    // Extract metadata
    const metadata = await this.book.loaded.metadata;
    this.title.set(metadata.title || 'Untitled');
    this.author.set(metadata.creator || 'Unknown');

    // Extract cover
    try {
      const coverUrl = await this.book.coverUrl();
      this.coverUrl.set(coverUrl);
    } catch {
      this.coverUrl.set(null);
    }

    // Extract chapters from navigation
    const navigation = await this.book.loaded.navigation;
    const chapterList = this.flattenNavigation(navigation.toc);
    this.chapters.set(chapterList);
    this.totalChapters.set(chapterList.length);

    this.isLoaded.set(true);
  }

  /**
   * Render the EPUB to a container element
   */
  async render(container: HTMLElement, options?: {
    width?: string | number;
    height?: string | number;
    spread?: 'auto' | 'none' | 'always';
    flow?: 'paginated' | 'scrolled' | 'scrolled-doc';
    manager?: 'default' | 'continuous';
  }): Promise<void> {
    if (!this.book) {
      throw new Error('No EPUB loaded');
    }

    // Render with continuous manager for infinite scroll
    this.rendition = this.book.renderTo(container, {
      width: options?.width || '100%',
      height: options?.height || '100%',
      spread: options?.spread || 'none',
      flow: options?.flow || 'scrolled',
      manager: options?.manager || 'continuous',
      allowScriptedContent: false,
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Display first chapter
    await this.rendition.display();

    this.isRendered.set(true);
  }

  /**
   * Navigate to a specific CFI location
   */
  async goToCfi(cfi: string): Promise<void> {
    if (!this.rendition) return;
    await this.rendition.display(cfi);
  }

  /**
   * Navigate to a specific chapter by index
   */
  async goToChapter(index: number): Promise<void> {
    if (!this.book || !this.rendition) return;

    const spine = this.book.spine as Spine;
    const spineItem = spine.get(index);
    if (spineItem) {
      await this.rendition.display(spineItem.href);
    }
  }

  /**
   * Navigate to a specific chapter by href
   */
  async goToHref(href: string): Promise<void> {
    if (!this.rendition) return;
    await this.rendition.display(href);
  }

  /**
   * Navigate to next page/section
   */
  async next(): Promise<void> {
    if (!this.rendition) return;
    await this.rendition.next();
  }

  /**
   * Navigate to previous page/section
   */
  async prev(): Promise<void> {
    if (!this.rendition) return;
    await this.rendition.prev();
  }

  /**
   * Search all chapters for a pattern
   */
  async searchAllChapters(query: string, options?: {
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<EpubSearchResult[]> {
    if (!this.book) return [];

    const results: EpubSearchResult[] = [];
    const maxResults = options?.maxResults || 1000;
    const spine = this.book.spine as Spine;

    // Search each spine item
    for (const spineItem of (spine as unknown as { items: Array<{ href: string; index: number }> }).items) {
      if (results.length >= maxResults) break;

      try {
        // Load the section
        const section = this.book.section(spineItem.href);
        if (!section) continue;

        // Load section content
        await section.load();

        // Search within the section using DOM methods
        const sectionResults = this.searchInSection(section, query, options?.caseSensitive);

        for (const result of sectionResults) {
          if (results.length >= maxResults) break;
          results.push(result);
        }
      } catch (err) {
        console.warn(`Error searching section ${spineItem.href}:`, err);
      }
    }

    return results;
  }

  /**
   * Search within a section's document
   * Uses epub.js cfiFromRange for proper CFI generation
   */
  private searchInSection(section: Section, query: string, caseSensitive?: boolean): EpubSearchResult[] {
    const results: EpubSearchResult[] = [];

    if (!section.document) return results;

    const body = section.document.body;
    if (!body) return results;

    const searchText = caseSensitive ? query : query.toLowerCase();

    // Collect all text nodes
    const textNodes: Text[] = [];
    const collectTextNodes = (node: Node): void => {
      for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          textNodes.push(child as Text);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          collectTextNodes(child);
        }
      }
    };
    collectTextNodes(body);

    // Search in each text node and create Range for CFI generation
    for (const textNode of textNodes) {
      const nodeText = textNode.nodeValue || '';
      const searchIn = caseSensitive ? nodeText : nodeText.toLowerCase();

      let localIndex = 0;
      while ((localIndex = searchIn.indexOf(searchText, localIndex)) !== -1) {
        // Create a Range spanning the matched text
        const range = section.document.createRange();
        range.setStart(textNode, localIndex);
        range.setEnd(textNode, localIndex + query.length);

        // Use epub.js to generate CFI from the range
        const cfi = section.cfiFromRange(range);

        // Get surrounding excerpt
        const excerptStart = Math.max(0, localIndex - 30);
        const excerptEnd = Math.min(nodeText.length, localIndex + query.length + 30);
        const excerpt = nodeText.substring(excerptStart, excerptEnd);

        results.push({
          cfi,
          excerpt: excerpt.trim(),
        });

        localIndex += query.length;
      }
    }

    return results;
  }

  /**
   * Search within a specific chapter
   */
  async searchChapter(chapterHref: string, query: string): Promise<EpubSearchResult[]> {
    if (!this.book) return [];

    try {
      const section = this.book.section(chapterHref);
      if (!section) return [];

      await section.load();
      return this.searchInSection(section, query);
    } catch (err) {
      console.warn(`Error searching chapter ${chapterHref}:`, err);
      return [];
    }
  }

  /**
   * Add a highlight annotation at a CFI location
   */
  addHighlight(cfi: string, data?: Record<string, unknown>, className?: string): void {
    if (!this.rendition) return;

    this.rendition.annotations.highlight(
      cfi,
      data || {},
      undefined,
      className || 'epub-highlight',
      {
        fill: 'rgba(255, 255, 0, 0.3)',
        'fill-opacity': '0.3',
        'mix-blend-mode': 'multiply',
      }
    );
  }

  /**
   * Add a highlight with custom styling
   */
  addStyledHighlight(cfi: string, color: string, data?: Record<string, unknown>): void {
    if (!this.rendition) return;

    this.rendition.annotations.highlight(
      cfi,
      data || {},
      undefined,
      'epub-styled-highlight',
      {
        fill: color,
        'fill-opacity': '0.3',
        'mix-blend-mode': 'multiply',
      }
    );
  }

  /**
   * Remove a highlight annotation
   */
  removeHighlight(cfi: string): void {
    if (!this.rendition) return;
    this.rendition.annotations.remove(cfi, 'highlight');
  }

  /**
   * Add an underline annotation (for deletions)
   */
  addUnderline(cfi: string, data?: Record<string, unknown>): void {
    if (!this.rendition) return;

    this.rendition.annotations.underline(
      cfi,
      data || {},
      undefined,
      'epub-underline',
      {
        stroke: 'rgba(255, 0, 0, 0.6)',
        'stroke-width': '2px',
        'stroke-linecap': 'round',
      }
    );
  }

  /**
   * Clear all annotations
   */
  clearAllAnnotations(): void {
    if (!this.rendition) return;
    // epub.js doesn't have a built-in clear all, so we track and remove individually
    // For now, just remove the rendition and recreate if needed
  }

  /**
   * Get the text content at a CFI range
   */
  async getTextAtCfi(cfi: string): Promise<string | null> {
    if (!this.book) return null;

    try {
      const range = await this.book.getRange(cfi);
      return range?.toString() || null;
    } catch (err) {
      console.warn('Error getting text at CFI:', err);
      return null;
    }
  }

  /**
   * Get the chapter ID for a given CFI
   */
  getChapterIdFromCfi(cfi: string): string | null {
    if (!this.book) return null;

    try {
      // Parse the CFI to extract the spine index
      // CFI format: epubcfi(/6/4!/4/2/1:0) - /6/4 refers to spine item
      const match = cfi.match(/epubcfi\(\/\d+\/(\d+)/);
      if (!match) return null;

      const spineIndex = Math.floor(parseInt(match[1], 10) / 2) - 1;
      const spine = this.book.spine as Spine;
      const spineItem = spine.get(spineIndex);
      return spineItem?.idref || null;
    } catch {
      return null;
    }
  }

  /**
   * Register a callback for text selection events
   */
  onSelection(callback: (cfi: string, text: string, contents: Contents) => void): void {
    this.selectionCallback = callback;
  }

  /**
   * Register a callback for location changes
   */
  onRelocated(callback: (location: { start: { cfi: string }; end: { cfi: string } }) => void): void {
    this.relocatedCallback = callback;
  }

  /**
   * Get current location
   */
  getCurrentLocation(): { start: { cfi: string }; end: { cfi: string } } | null {
    if (!this.rendition) return null;
    return this.rendition.location as { start: { cfi: string }; end: { cfi: string } };
  }

  /**
   * Inject custom CSS into the rendered content
   */
  injectStyles(css: string): void {
    if (!this.rendition) return;

    this.rendition.hooks.content.register((contents: Contents) => {
      // Parse CSS string into rules object
      const rules = this.parseCssToRules(css);
      contents.addStylesheetRules(rules, 'epub-editor-styles');
    });
  }

  /**
   * Parse a CSS string into a rules object for epub.js
   */
  private parseCssToRules(css: string): Record<string, Record<string, string>> {
    const rules: Record<string, Record<string, string>> = {};

    // Simple CSS parser - handles basic selectors and properties
    const ruleRegex = /([^{]+)\{([^}]+)\}/g;
    let match;

    while ((match = ruleRegex.exec(css)) !== null) {
      const selector = match[1].trim();
      const declarations = match[2].trim();

      const properties: Record<string, string> = {};
      const propRegex = /([\w-]+)\s*:\s*([^;]+);?/g;
      let propMatch;

      while ((propMatch = propRegex.exec(declarations)) !== null) {
        const prop = propMatch[1].trim();
        const value = propMatch[2].trim();
        properties[prop] = value;
      }

      rules[selector] = properties;
    }

    return rules;
  }

  /**
   * Get the underlying epub.js Book instance
   */
  getBook(): Book | null {
    return this.book;
  }

  /**
   * Get the underlying epub.js Rendition instance
   */
  getRendition(): Rendition | null {
    return this.rendition;
  }

  /**
   * Clean up and destroy the current EPUB
   */
  destroy(): void {
    if (this.rendition) {
      this.rendition.destroy();
      this.rendition = null;
    }
    if (this.book) {
      this.book.destroy();
      this.book = null;
    }

    // Reset state
    this.isLoaded.set(false);
    this.isRendered.set(false);
    this.currentChapter.set(null);
    this.chapters.set([]);
    this.title.set('');
    this.author.set('');
    this.coverUrl.set(null);
    this.totalChapters.set(0);
    this.selectedCfi.set(null);
    this.selectedText.set(null);
    this.atStart.set(true);
    this.atEnd.set(false);

    // Clear callbacks
    this.selectionCallback = null;
    this.relocatedCallback = null;
  }

  /**
   * Set up event handlers for rendition
   */
  private setupEventHandlers(): void {
    if (!this.rendition) return;

    // Handle text selection
    this.rendition.on('selected', (cfiRange: string, contents: Contents) => {
      this.ngZone.run(() => {
        const selection = contents.window.getSelection();
        const text = selection?.toString() || '';

        this.selectedCfi.set(cfiRange);
        this.selectedText.set(text);

        if (this.selectionCallback) {
          this.selectionCallback(cfiRange, text, contents);
        }
      });
    });

    // Handle location changes
    this.rendition.on('relocated', (location: { start: { cfi: string; index: number }; end: { cfi: string; index: number }; atStart: boolean; atEnd: boolean }) => {
      this.ngZone.run(() => {
        this.atStart.set(location.atStart);
        this.atEnd.set(location.atEnd);

        // Update current chapter
        const chapters = this.chapters();
        if (chapters.length > 0) {
          const currentIndex = location.start.index;
          const chapter = chapters.find(c => c.index === currentIndex) || chapters[0];
          this.currentChapter.set(chapter);
        }

        if (this.relocatedCallback) {
          this.relocatedCallback(location);
        }
      });
    });

    // Handle rendered content (for injecting styles)
    this.rendition.on('rendered', (section: Section) => {
      this.ngZone.run(() => {
        // Content has been rendered
      });
    });
  }

  /**
   * Flatten navigation tree into a flat list
   */
  private flattenNavigation(toc: NavItem[], list: EpubChapterInfo[] = [], level: number = 0): EpubChapterInfo[] {
    for (const item of toc) {
      list.push({
        id: item.id || item.href,
        href: item.href,
        label: item.label,
        index: list.length,
      });

      if (item.subitems && item.subitems.length > 0) {
        this.flattenNavigation(item.subitems, list, level + 1);
      }
    }

    return list;
  }
}

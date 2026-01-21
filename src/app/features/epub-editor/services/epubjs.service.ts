import { Injectable, signal, NgZone, inject } from '@angular/core';
import ePub, { Book, Rendition, Contents, NavItem } from 'epubjs';
import type Section from 'epubjs/types/section';
import type Spine from 'epubjs/types/spine';
import { EpubSearchResult, EpubChapterInfo } from '../../../core/models/epub-highlight.types';
import { EpubChapter } from '../../../core/models/book-metadata.types';

/**
 * Represents a clickable block element in the EPUB
 */
export interface EpubBlock {
  id: string;           // Unique identifier (section:index)
  type: 'paragraph' | 'heading' | 'image' | 'blockquote' | 'list' | 'other';
  text: string;         // Text content (or alt text for images)
  element: HTMLElement; // Reference to the DOM element
  sectionHref: string;  // Which section this block belongs to
  index: number;        // Index within the section
}

/**
 * Chapter marker click event
 */
export interface ChapterMarkerEvent {
  chapterId: string;
  chapter: EpubChapter;
}

/**
 * Chapter marker drag event
 */
export interface ChapterMarkerDragEvent {
  chapterId: string;
  sectionHref: string;
  sectionIndex: number;
  y: number;
  blockId?: string;
  blockText?: string;
}

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

  // Block tracking
  readonly blocks = signal<EpubBlock[]>([]);
  private deletedBlockIds = new Set<string>();
  private selectedBlockIds = new Set<string>();

  // Event callbacks
  private selectionCallback: ((cfi: string, text: string, contents: Contents) => void) | null = null;
  private relocatedCallback: ((location: { start: { cfi: string }; end: { cfi: string } }) => void) | null = null;
  private highlightClickCallback: ((cfi: string, data: Record<string, unknown>) => void) | null = null;
  private blockClickCallback: ((block: EpubBlock, additive: boolean) => void) | null = null;
  private marqueeSelectCallback: ((blockIds: string[], additive: boolean) => void) | null = null;
  private clearSelectionCallback: (() => void) | null = null;
  private keydownCallback: ((event: KeyboardEvent) => void) | null = null;
  private chapterMarkerClickCallback: ((event: ChapterMarkerEvent) => void) | null = null;
  private chapterMarkerDragCallback: ((event: ChapterMarkerDragEvent) => void) | null = null;
  private chapterPlacementCallback: ((event: ChapterMarkerDragEvent) => void) | null = null;

  // Chapter markers state
  private chapterMarkers: EpubChapter[] = [];
  private chaptersMode = false;
  private selectedChapterId: string | null = null;
  private draggingChapterMarker: EpubChapter | null = null;
  private chapterMarkerElements: Map<string, HTMLElement> = new Map();

  // Mouse state for iframe event handling
  private isMouseDown = false;
  private mouseDownPos: { x: number; y: number } | null = null;
  private isMarqueeActive = false;
  private marqueeElement: HTMLDivElement | null = null;
  private clickedBlockId: string | null = null;
  private currentIframeDoc: Document | null = null;
  private mouseDownModifiers: { metaKey: boolean; ctrlKey: boolean } = { metaKey: false, ctrlKey: false };

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

    // Set up event handlers and block detection
    this.setupEventHandlers();

    // Inject block styles before display
    this.injectBlockStyles();

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

    // Create click callback that forwards to the registered handler
    const clickCallback = () => {
      this.ngZone.run(() => {
        if (this.highlightClickCallback) {
          this.highlightClickCallback(cfi, data || {});
        }
      });
    };

    this.rendition.annotations.highlight(
      cfi,
      data || {},
      clickCallback,
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
   * Register a callback for highlight clicks
   */
  onHighlightClick(callback: (cfi: string, data: Record<string, unknown>) => void): void {
    this.highlightClickCallback = callback;
  }

  /**
   * Register a callback for block clicks
   * @param callback - Called with block and whether Cmd/Ctrl was held
   */
  onBlockClick(callback: (block: EpubBlock, additive: boolean) => void): void {
    this.blockClickCallback = callback;
  }

  /**
   * Register a callback for marquee selection
   * @param callback - Called with block IDs and whether Cmd/Ctrl was held
   */
  onMarqueeSelect(callback: (blockIds: string[], additive: boolean) => void): void {
    this.marqueeSelectCallback = callback;
  }

  /**
   * Register a callback for clearing selection (click on empty space)
   */
  onClearSelection(callback: () => void): void {
    this.clearSelectionCallback = callback;
  }

  /**
   * Register a callback for keydown events from inside the iframe
   */
  onKeydown(callback: (event: KeyboardEvent) => void): void {
    this.keydownCallback = callback;
  }

  /**
   * Register callback for chapter marker clicks
   */
  onChapterMarkerClick(callback: (event: ChapterMarkerEvent) => void): void {
    this.chapterMarkerClickCallback = callback;
  }

  /**
   * Register callback for chapter marker drags (reposition)
   */
  onChapterMarkerDrag(callback: (event: ChapterMarkerDragEvent) => void): void {
    this.chapterMarkerDragCallback = callback;
  }

  /**
   * Register callback for chapter placement (click in empty area in chapters mode)
   */
  onChapterPlacement(callback: (event: ChapterMarkerDragEvent) => void): void {
    this.chapterPlacementCallback = callback;
  }

  /**
   * Set chapters mode (enables chapter marker interactions)
   */
  setChaptersMode(enabled: boolean): void {
    this.chaptersMode = enabled;
    this.renderChapterMarkers();
  }

  /**
   * Set chapter markers to display
   */
  setChapterMarkers(chapters: EpubChapter[]): void {
    this.chapterMarkers = chapters;
    this.renderChapterMarkers();
  }

  /**
   * Set selected chapter ID
   */
  setSelectedChapterId(chapterId: string | null): void {
    this.selectedChapterId = chapterId;
    this.updateChapterMarkerStyles();
  }

  /**
   * Get current section href
   */
  getCurrentSectionHref(): string | null {
    return this.currentSectionHref;
  }

  private currentSectionHref: string | null = null;

  /**
   * Set which blocks are deleted (for visual styling)
   */
  setDeletedBlocks(blockIds: Set<string>): void {
    this.deletedBlockIds = blockIds;
    this.updateBlockStyles();
  }

  /**
   * Set which blocks are selected (for visual styling)
   */
  setSelectedBlocks(blockIds: Set<string>): void {
    this.selectedBlockIds = blockIds;
    this.updateBlockStyles();
  }

  /**
   * Update visual styles for all blocks (selected and deleted states)
   */
  private updateBlockStyles(): void {
    const blocks = this.blocks();
    for (const block of blocks) {
      const isDeleted = this.deletedBlockIds.has(block.id);
      const isSelected = this.selectedBlockIds.has(block.id);

      if (isDeleted) {
        block.element.classList.add('epub-block-deleted');
      } else {
        block.element.classList.remove('epub-block-deleted');
      }

      if (isSelected) {
        block.element.classList.add('selected');
      } else {
        block.element.classList.remove('selected');
      }
    }
  }

  /**
   * Check if a block is deleted
   */
  isBlockDeleted(blockId: string): boolean {
    return this.deletedBlockIds.has(blockId);
  }

  /**
   * Check if a block is selected
   */
  isBlockSelected(blockId: string): boolean {
    return this.selectedBlockIds.has(blockId);
  }

  /**
   * Render chapter markers in the current view
   */
  private renderChapterMarkers(): void {
    if (!this.currentIframeDoc) return;

    // Remove existing markers
    this.chapterMarkerElements.forEach(el => el.remove());
    this.chapterMarkerElements.clear();

    // Remove container if not in chapters mode
    const existingContainer = this.currentIframeDoc.getElementById('epub-chapter-markers');
    if (!this.chaptersMode) {
      if (existingContainer) {
        existingContainer.remove();
      }
      return;
    }

    // Get current section href
    const currentHref = this.currentSectionHref;
    if (!currentHref) return;

    // Find chapters for current section
    const chaptersInSection = this.chapterMarkers.filter(ch => ch.sectionHref === currentHref);

    // Create container for markers (only in chapters mode)
    let markerContainer = existingContainer;
    if (!markerContainer) {
      markerContainer = this.currentIframeDoc.createElement('div');
      markerContainer.id = 'epub-chapter-markers';
      markerContainer.style.cssText = 'position: absolute; top: 0; left: 0; right: 0; pointer-events: none; z-index: 1000;';
      this.currentIframeDoc.body.appendChild(markerContainer);
    }
    markerContainer.innerHTML = '';

    // Create markers
    for (const chapter of chaptersInSection) {
      const marker = this.createChapterMarkerElement(chapter);
      markerContainer.appendChild(marker);
      this.chapterMarkerElements.set(chapter.id, marker);
    }
  }

  /**
   * Create a chapter marker DOM element
   */
  private createChapterMarkerElement(chapter: EpubChapter): HTMLElement {
    const marker = this.currentIframeDoc!.createElement('div');
    marker.className = 'epub-chapter-marker';
    marker.dataset['chapterId'] = chapter.id;

    const isSelected = this.selectedChapterId === chapter.id;
    const color = isSelected ? '#1565c0' : '#4caf50';

    // Position the marker at the chapter's Y position, or find the block
    let yPos = chapter.y || 20;
    if (chapter.blockId) {
      const block = this.blocks().find(b => b.id === chapter.blockId);
      if (block) {
        const rect = block.element.getBoundingClientRect();
        yPos = rect.top + this.currentIframeDoc!.defaultView!.scrollY;
      }
    }

    marker.style.cssText = `
      position: absolute;
      top: ${yPos}px;
      left: 0;
      right: 0;
      height: 24px;
      pointer-events: ${this.chaptersMode ? 'auto' : 'none'};
      cursor: ${this.chaptersMode ? 'grab' : 'default'};
      z-index: 1000;
    `;

    // Line
    const line = this.currentIframeDoc!.createElement('div');
    line.className = 'chapter-line';
    line.style.cssText = `
      position: absolute;
      top: 12px;
      left: 0;
      right: 0;
      height: 0;
      border-top: ${isSelected ? '3px' : '2px'} dashed ${color};
    `;
    marker.appendChild(line);

    // Label
    const label = this.currentIframeDoc!.createElement('div');
    label.className = 'chapter-label';
    const displayTitle = chapter.title.length > 30 ? chapter.title.substring(0, 27) + '...' : chapter.title;
    const indent = chapter.level > 1 ? '  ' : '';
    label.textContent = indent + displayTitle;
    label.style.cssText = `
      position: absolute;
      top: 4px;
      left: 4px;
      padding: 2px 8px;
      background: ${color};
      color: white;
      font-size: 10px;
      font-weight: 500;
      border-radius: 3px;
      white-space: nowrap;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    marker.appendChild(label);

    // Add event listeners in chapters mode
    if (this.chaptersMode) {
      marker.addEventListener('mousedown', (e) => this.handleChapterMarkerMouseDown(e, chapter));
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ngZone.run(() => {
          if (this.chapterMarkerClickCallback) {
            this.chapterMarkerClickCallback({ chapterId: chapter.id, chapter });
          }
        });
      });
    }

    return marker;
  }

  /**
   * Handle chapter marker mouse down for dragging
   */
  private handleChapterMarkerMouseDown(event: MouseEvent, chapter: EpubChapter): void {
    if (!this.chaptersMode) return;
    event.preventDefault();
    event.stopPropagation();

    this.draggingChapterMarker = chapter;
    const startY = event.clientY;
    const marker = this.chapterMarkerElements.get(chapter.id);
    if (!marker) return;

    const startTop = parseInt(marker.style.top) || 0;
    let hasMoved = false;

    const onMouseMove = (e: MouseEvent) => {
      const dy = e.clientY - startY;
      if (!hasMoved && Math.abs(dy) > 5) {
        hasMoved = true;
        marker.style.cursor = 'grabbing';
      }
      if (hasMoved) {
        const newY = startTop + dy;
        marker.style.top = `${newY}px`;
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      this.currentIframeDoc!.removeEventListener('mousemove', onMouseMove);
      this.currentIframeDoc!.removeEventListener('mouseup', onMouseUp);

      if (hasMoved && this.draggingChapterMarker) {
        const finalY = parseInt(marker.style.top) || 0;

        // Find nearest block for snapping
        const nearestBlock = this.findNearestBlock(finalY);

        this.ngZone.run(() => {
          if (this.chapterMarkerDragCallback) {
            const sectionIndex = this.chapters().findIndex(ch => ch.href === this.currentSectionHref);
            this.chapterMarkerDragCallback({
              chapterId: chapter.id,
              sectionHref: this.currentSectionHref || '',
              sectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
              y: nearestBlock ? nearestBlock.y : finalY,
              blockId: nearestBlock?.id,
              blockText: nearestBlock?.text,
            });
          }
        });
      }

      this.draggingChapterMarker = null;
      marker.style.cursor = 'grab';
    };

    this.currentIframeDoc!.addEventListener('mousemove', onMouseMove);
    this.currentIframeDoc!.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Find the nearest block to a Y position
   */
  private findNearestBlock(y: number): { id: string; y: number; text: string } | null {
    const blocks = this.blocks();
    if (blocks.length === 0) return null;

    let nearest: EpubBlock | null = null;
    let minDistance = Infinity;

    for (const block of blocks) {
      const rect = block.element.getBoundingClientRect();
      const blockY = rect.top + (this.currentIframeDoc?.defaultView?.scrollY || 0);
      const distance = Math.abs(blockY - y);

      if (distance < minDistance) {
        minDistance = distance;
        nearest = block;
      }
    }

    if (nearest && minDistance < 50) {
      const rect = nearest.element.getBoundingClientRect();
      return {
        id: nearest.id,
        y: rect.top + (this.currentIframeDoc?.defaultView?.scrollY || 0),
        text: nearest.text,
      };
    }

    return null;
  }

  /**
   * Update chapter marker visual styles (selection state)
   */
  private updateChapterMarkerStyles(): void {
    this.chapterMarkerElements.forEach((marker, chapterId) => {
      const isSelected = this.selectedChapterId === chapterId;
      const color = isSelected ? '#1565c0' : '#4caf50';

      const line = marker.querySelector('.chapter-line') as HTMLElement;
      const label = marker.querySelector('.chapter-label') as HTMLElement;

      if (line) {
        line.style.borderTop = `${isSelected ? '3px' : '2px'} dashed ${color}`;
      }
      if (label) {
        label.style.background = color;
      }
    });
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
   * Inject block styles into rendered content
   */
  private injectBlockStyles(): void {
    if (!this.rendition) return;

    const css = this.getBlockStyles();

    this.rendition.hooks.content.register((contents: Contents) => {
      // Inject the CSS directly into the iframe document
      const doc = contents.document;
      if (doc) {
        const style = doc.createElement('style');
        style.textContent = css;
        doc.head.appendChild(style);
      }
    });
  }

  /**
   * Get the CSS for block styling
   * Colors match the PDF viewer: #8bc34a (light green) for body text blocks
   */
  getBlockStyles(): string {
    return `
      /* Disable text selection - we want block selection only */
      body {
        -webkit-user-select: none !important;
        -moz-user-select: none !important;
        -ms-user-select: none !important;
        user-select: none !important;
        cursor: default;
      }

      .epub-block-wrapper {
        position: relative;
        cursor: pointer;
        transition: all 0.15s ease;
        border-radius: 2px;
        margin: 1px 0;
        padding: 2px;
      }

      /* Hover state - light fill with border, matches PDF viewer */
      .epub-block-wrapper:hover {
        background-color: #8bc34a20;
        outline: 1px solid #8bc34a;
      }

      /* Selected state - matches PDF viewer: fill with alpha + solid stroke */
      .epub-block-wrapper.selected {
        background-color: #8bc34a70;
        outline: 2px solid #8bc34a;
        outline-offset: 0;
      }

      /* Deleted state - red tint with X marks */
      .epub-block-deleted {
        position: relative;
        opacity: 0.5;
        background-color: rgba(255, 68, 68, 0.15) !important;
        outline: 1px solid #ff4444 !important;
      }

      .epub-block-deleted::before {
        content: '✕';
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 2.5rem;
        color: rgba(255, 68, 68, 0.7);
        pointer-events: none;
        z-index: 10;
        text-shadow: 0 0 4px white;
      }

      .epub-block-deleted > * {
        text-decoration: line-through;
        text-decoration-color: rgba(255, 68, 68, 0.6);
      }

      .epub-block-deleted img {
        filter: grayscale(100%) opacity(0.5);
      }

      /* Marquee selection box - matches PDF viewer accent colors */
      .epub-marquee {
        position: fixed;
        border: 2px solid #06b6d4;
        background-color: rgba(6, 182, 212, 0.12);
        pointer-events: none;
        z-index: 2147483647;
      }
    `;
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
    this.highlightClickCallback = null;
    this.blockClickCallback = null;
    this.marqueeSelectCallback = null;
    this.clearSelectionCallback = null;
    this.keydownCallback = null;

    // Clear blocks and mouse state
    this.blocks.set([]);
    this.deletedBlockIds.clear();
    this.selectedBlockIds.clear();
    this.cleanupMarquee();
    this.currentIframeDoc = null;
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

    // Handle rendered content using the content hook (more reliable)
    this.rendition.hooks.content.register((contents: Contents) => {
      this.ngZone.run(() => {
        const doc = contents.document;
        // Get section info from contents - sectionIndex maps to spine items
        const sectionIndex = (contents as unknown as { sectionIndex?: number }).sectionIndex;
        let sectionHref = `section-${sectionIndex ?? 0}`;

        // Try to get the actual href from the spine if possible
        if (this.book && sectionIndex !== undefined) {
          const spine = this.book.spine as Spine;
          const spineItem = spine.get(sectionIndex);
          if (spineItem) {
            sectionHref = spineItem.href;
          }
        }

        if (doc) {
          this.setupBlocksInViewByHref(sectionHref, doc);
        }
      });
    });
  }

  /**
   * Setup clickable blocks in a rendered view (by href)
   */
  private setupBlocksInViewByHref(sectionHref: string, doc: Document): void {
    if (!doc || !doc.body) return;

    // Store reference to current iframe document for mouse events
    this.currentIframeDoc = doc;

    // Track current section for chapter marker rendering
    this.currentSectionHref = sectionHref;

    const blockSelectors = 'p, h1, h2, h3, h4, h5, h6, img, blockquote, ul, ol, figure, div.image, div.figure';
    const elements = doc.body.querySelectorAll(blockSelectors);

    const newBlocks: EpubBlock[] = [];
    let index = 0;

    elements.forEach((el) => {
      const element = el as HTMLElement;

      // Skip empty paragraphs and very short text (likely formatting artifacts)
      const text = element.textContent?.trim() || '';
      const isImage = element.tagName === 'IMG' || element.querySelector('img');

      if (!isImage && text.length < 2) return;

      // Skip elements that are children of other block elements we've already processed
      if (element.closest('.epub-block-wrapper')) return;

      const blockId = `${sectionHref}:${index}`;
      const type = this.getBlockType(element);

      // Wrap the element for click handling
      const wrapper = doc.createElement('div');
      wrapper.className = 'epub-block-wrapper';
      wrapper.dataset['blockId'] = blockId;

      // Insert wrapper before element and move element inside
      element.parentNode?.insertBefore(wrapper, element);
      wrapper.appendChild(element);

      // Create the block object
      const block: EpubBlock = {
        id: blockId,
        type,
        text: isImage ? (element as HTMLImageElement).alt || '[Image]' : text.substring(0, 200),
        element: wrapper,
        sectionHref,
        index,
      };

      // Apply deleted and selected styling if needed
      if (this.deletedBlockIds.has(blockId)) {
        wrapper.classList.add('epub-block-deleted');
      }
      if (this.selectedBlockIds.has(blockId)) {
        wrapper.classList.add('selected');
      }

      newBlocks.push(block);
      index++;
    });

    // Update blocks signal (merge with existing blocks from other sections)
    this.blocks.update(existing => {
      // Remove old blocks from this section
      const filtered = existing.filter(b => b.sectionHref !== sectionHref);
      return [...filtered, ...newBlocks];
    });

    // Re-apply deleted/selected styles after blocks are added
    // This ensures styles are applied even if project was loaded before blocks rendered
    this.updateBlockStyles();

    // Set up mouse event handlers in the iframe document
    this.setupIframeMouseHandlers(doc);

    // Render chapter markers if in chapters mode
    if (this.chaptersMode) {
      this.renderChapterMarkers();
    }
  }

  /**
   * Set up mouse and keyboard event handlers in the iframe document
   */
  private setupIframeMouseHandlers(doc: Document): void {
    // Remove any existing handlers first
    doc.removeEventListener('mousedown', this.handleIframeMouseDown);
    doc.removeEventListener('mousemove', this.handleIframeMouseMove);
    doc.removeEventListener('mouseup', this.handleIframeMouseUp);
    doc.removeEventListener('keydown', this.handleIframeKeydown);

    // Add new handlers
    doc.addEventListener('mousedown', this.handleIframeMouseDown);
    doc.addEventListener('mousemove', this.handleIframeMouseMove);
    doc.addEventListener('mouseup', this.handleIframeMouseUp);
    doc.addEventListener('keydown', this.handleIframeKeydown);
  }

  /**
   * Handle keydown in the iframe - forward to parent
   */
  private handleIframeKeydown = (event: KeyboardEvent): void => {
    this.ngZone.run(() => {
      if (this.keydownCallback) {
        this.keydownCallback(event);
      }
    });
  };

  /**
   * Handle mousedown in the iframe
   */
  private handleIframeMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return; // Only left click

    this.isMouseDown = true;
    this.mouseDownPos = { x: event.clientX, y: event.clientY };
    this.isMarqueeActive = false;

    // Capture modifier keys at mousedown time
    this.mouseDownModifiers = {
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    };

    // Check if clicking on a block wrapper
    const target = event.target as HTMLElement;
    const blockWrapper = target.closest('.epub-block-wrapper') as HTMLElement;

    if (blockWrapper) {
      this.clickedBlockId = blockWrapper.dataset['blockId'] || null;
    } else {
      this.clickedBlockId = null;
    }
  };

  /**
   * Handle mousemove in the iframe
   */
  private handleIframeMouseMove = (event: MouseEvent): void => {
    if (!this.isMouseDown || !this.mouseDownPos) return;

    const dx = Math.abs(event.clientX - this.mouseDownPos.x);
    const dy = Math.abs(event.clientY - this.mouseDownPos.y);

    // If moved more than 5px, start marquee mode
    if (!this.isMarqueeActive && (dx > 5 || dy > 5)) {
      this.isMarqueeActive = true;
      this.clickedBlockId = null; // Cancel block click

      // Create marquee element in the iframe - matches PDF viewer accent colors
      if (this.currentIframeDoc) {
        this.marqueeElement = this.currentIframeDoc.createElement('div');
        this.marqueeElement.className = 'epub-marquee';
        this.marqueeElement.style.cssText = `
          position: fixed;
          border: 2px solid #06b6d4;
          background-color: rgba(6, 182, 212, 0.12);
          pointer-events: none;
          z-index: 2147483647;
        `;
        this.currentIframeDoc.body.appendChild(this.marqueeElement);
      }
    }

    // Update marquee position
    if (this.isMarqueeActive && this.marqueeElement && this.mouseDownPos) {
      const x = Math.min(this.mouseDownPos.x, event.clientX);
      const y = Math.min(this.mouseDownPos.y, event.clientY);
      const width = Math.abs(event.clientX - this.mouseDownPos.x);
      const height = Math.abs(event.clientY - this.mouseDownPos.y);

      this.marqueeElement.style.left = `${x}px`;
      this.marqueeElement.style.top = `${y}px`;
      this.marqueeElement.style.width = `${width}px`;
      this.marqueeElement.style.height = `${height}px`;
    }
  };

  /**
   * Handle mouseup in the iframe
   */
  private handleIframeMouseUp = (event: MouseEvent): void => {
    if (!this.isMouseDown) return;

    // Check modifier keys - use either mousedown modifiers or current event
    const additive = this.mouseDownModifiers.metaKey || this.mouseDownModifiers.ctrlKey ||
                     event.metaKey || event.ctrlKey;

    this.ngZone.run(() => {
      if (this.isMarqueeActive && this.mouseDownPos) {
        // Marquee selection - find all blocks that intersect
        const marqueeBounds = {
          left: Math.min(this.mouseDownPos.x, event.clientX),
          top: Math.min(this.mouseDownPos.y, event.clientY),
          right: Math.max(this.mouseDownPos.x, event.clientX),
          bottom: Math.max(this.mouseDownPos.y, event.clientY),
        };

        const selectedBlockIds = this.findBlocksInMarquee(marqueeBounds);

        if (selectedBlockIds.length > 0 && this.marqueeSelectCallback) {
          this.marqueeSelectCallback(selectedBlockIds, additive);
        }
      } else if (this.clickedBlockId) {
        // Click on a block
        const block = this.blocks().find(b => b.id === this.clickedBlockId);
        if (this.chaptersMode && this.chapterPlacementCallback && block) {
          // In chapters mode, place a chapter marker at this block
          const rect = block.element.getBoundingClientRect();
          const y = rect.top + (this.currentIframeDoc?.defaultView?.scrollY || 0);
          const sectionIndex = this.chapters().findIndex(ch => ch.href === block.sectionHref);
          this.chapterPlacementCallback({
            chapterId: '', // New chapter, no ID yet
            y,
            sectionHref: block.sectionHref,
            sectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
            blockId: block.id,
            blockText: block.text?.substring(0, 100),
          });
        } else if (block && this.blockClickCallback) {
          // Regular click on a block in normal mode
          this.blockClickCallback(block, additive);
        }
      } else {
        // Click on empty space
        if (this.chaptersMode && this.chapterPlacementCallback) {
          // In chapters mode, place a chapter marker at click position
          const y = event.clientY + (this.currentIframeDoc?.defaultView?.scrollY || 0);
          const sectionIndex = this.chapters().findIndex(ch => ch.href === this.currentSectionHref);
          this.chapterPlacementCallback({
            chapterId: '', // New chapter, no ID yet
            y,
            sectionHref: this.currentSectionHref || '',
            sectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
          });
        } else if (this.clearSelectionCallback) {
          // Clear selection in normal mode
          this.clearSelectionCallback();
        }
      }

      this.cleanupMarquee();
    });
  };

  /**
   * Find blocks that intersect with the marquee bounds
   */
  private findBlocksInMarquee(marqueeBounds: { left: number; top: number; right: number; bottom: number }): string[] {
    const selectedIds: string[] = [];
    const blocks = this.blocks();

    for (const block of blocks) {
      // Get the element's bounding rect (in iframe coordinates)
      const rect = block.element.getBoundingClientRect();

      // Check if the block intersects with the marquee
      const intersects = !(
        rect.right < marqueeBounds.left ||
        rect.left > marqueeBounds.right ||
        rect.bottom < marqueeBounds.top ||
        rect.top > marqueeBounds.bottom
      );

      if (intersects) {
        selectedIds.push(block.id);
      }
    }

    return selectedIds;
  }

  /**
   * Cleanup marquee element and state
   */
  private cleanupMarquee(): void {
    this.isMouseDown = false;
    this.mouseDownPos = null;
    this.isMarqueeActive = false;
    this.clickedBlockId = null;

    if (this.marqueeElement) {
      this.marqueeElement.remove();
      this.marqueeElement = null;
    }
  }

  /**
   * Get the block type from an element
   */
  private getBlockType(element: HTMLElement): EpubBlock['type'] {
    const tag = element.tagName.toLowerCase();

    if (tag === 'img' || element.querySelector('img')) return 'image';
    if (tag.startsWith('h')) return 'heading';
    if (tag === 'blockquote') return 'blockquote';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'p') return 'paragraph';

    return 'other';
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

import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  input,
  output,
  signal,
  effect,
  computed,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { EpubjsService, EpubBlock, ChapterMarkerEvent, ChapterMarkerDragEvent } from '../../services/epubjs.service';
import { EpubEditorStateService } from '../../services/epub-editor-state.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { EpubHighlight, getEpubHighlightId } from '../../../../core/models/epub-highlight.types';
import { EpubChapter } from '../../../../core/models/book-metadata.types';
import type { Contents } from 'epubjs';

/**
 * Selection event emitted when user selects text
 */
export interface EpubSelectionEvent {
  cfi: string;
  text: string;
  chapterId: string | null;
}

/**
 * Highlight click event
 */
export interface EpubHighlightClickEvent {
  cfi: string;
  highlightId?: string;
  categoryId?: string;
  data: Record<string, unknown>;
}

/**
 * EpubViewerComponent - Renders EPUB content using epub.js
 *
 * Features:
 * - EPUB rendering in scrolled or paginated mode
 * - Text selection with CFI capture
 * - Highlight visualization
 * - Chapter navigation
 */
@Component({
  selector: 'app-epub-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="epub-viewer-wrapper">
      <!-- Zoom controls -->
      <div class="zoom-toolbar">
        <span class="toolbar-label">Zoom:</span>
        <button class="zoom-btn" (click)="zoomOut()" title="Zoom Out (Cmd+Scroll Down)">−</button>
        <input
          type="range"
          min="50"
          max="200"
          step="10"
          [value]="zoomPercent()"
          (input)="setZoom(+$any($event.target).value)"
          class="zoom-slider"
        />
        <button class="zoom-btn" (click)="zoomIn()" title="Zoom In (Cmd+Scroll Up)">+</button>
        <span class="zoom-label">{{ zoomPercent() }}%</span>
        <button class="zoom-btn reset-btn" (click)="resetZoom()" title="Reset to 100%">↺</button>
      </div>

      <!-- Loading overlay -->
      @if (loading()) {
        <div class="loading-overlay">
          <div class="spinner"></div>
          <span>Loading EPUB...</span>
        </div>
      }

      <!-- Error display -->
      @if (error()) {
        <div class="error-display">
          <span class="error-icon">!</span>
          <span>{{ error() }}</span>
        </div>
      }

      <!-- Fixed viewport - no scrollbars on this container -->
      <div class="epub-viewport" [class.hidden]="loading() || error()">
        <div
          #viewerContainer
          class="epub-container"
          [style.transform]="'scale(' + zoomLevel() + ')'"
          [style.width.%]="100 / zoomLevel()"
          [style.height.%]="100 / zoomLevel()"
        ></div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .epub-viewer-wrapper {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .zoom-toolbar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
    }

    .toolbar-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .zoom-btn {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      font-weight: bold;
      transition: all 0.15s ease;

      &:hover {
        background: var(--hover-bg);
        border-color: var(--accent);
      }
    }

    .zoom-slider {
      width: 120px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--border-default);
      border-radius: 2px;
      cursor: pointer;

      &::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
      }
    }

    .zoom-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      min-width: 40px;
      text-align: center;
    }

    .reset-btn {
      font-size: 0.875rem;
      margin-left: 0.25rem;
    }

    .epub-viewport {
      flex: 1;
      overflow: hidden;
      background: var(--bg-sunken, #e0e0e0);
      display: flex;
      justify-content: center;

      &.hidden {
        visibility: hidden;
      }
    }

    .epub-container {
      max-width: 800px;
      background: #ffffff;
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
      transform-origin: top center;
    }

    /* Ensure epub.js iframe fills container */
    :host ::ng-deep .epub-container {
      iframe {
        border: none !important;
        width: 100% !important;
        height: 100% !important;
      }
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      background: var(--bg-surface);
      color: var(--text-secondary);
      z-index: 10;
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-display {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      background: var(--bg-surface);
      color: var(--error, #ff4444);
    }

    .error-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--error, #ff4444);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 1.5rem;
    }

    /* Custom styles injected into epub.js iframe */
    :host ::ng-deep {
      .epub-highlight {
        background-color: rgba(255, 255, 0, 0.3) !important;
      }

      .epub-highlight-deleted {
        background-color: rgba(255, 0, 0, 0.2) !important;
        text-decoration: line-through;
      }

      .epub-highlight-selected {
        background-color: rgba(100, 149, 237, 0.4) !important;
        outline: 2px solid var(--accent);
      }
    }
  `]
})
export class EpubViewerComponent implements AfterViewInit, OnDestroy {
  readonly epubjs = inject(EpubjsService);
  private readonly editorState = inject(EpubEditorStateService);
  private readonly electronService = inject(ElectronService);

  @ViewChild('viewerContainer', { static: true })
  viewerContainer!: ElementRef<HTMLDivElement>;

  // Inputs
  readonly epubSource = input<string | ArrayBuffer | null>(null);

  // Outputs
  readonly selectionChanged = output<EpubSelectionEvent>();
  readonly chapterChanged = output<string>();
  readonly highlightClicked = output<EpubHighlightClickEvent>();
  readonly blockClicked = output<{ block: EpubBlock; additive: boolean }>();
  readonly marqueeSelect = output<{ blockIds: string[]; additive: boolean }>();
  readonly iframeKeydown = output<KeyboardEvent>(); // Forward keyboard events from iframe
  readonly chapterMarkerClicked = output<ChapterMarkerEvent>();
  readonly chapterMarkerDragged = output<ChapterMarkerDragEvent>();
  readonly chapterPlacement = output<ChapterMarkerDragEvent>();
  readonly loaded = output<void>();
  readonly loadError = output<string>();

  // Local state
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly zoomPercent = signal(100); // 50-200%
  readonly zoomLevel = computed(() => this.zoomPercent() / 100);

  private highlightClasses = new Map<string, string>();

  // Zoom control methods
  zoomIn(): void {
    this.setZoom(Math.min(200, this.zoomPercent() + 10));
  }

  zoomOut(): void {
    this.setZoom(Math.max(50, this.zoomPercent() - 10));
  }

  setZoom(percent: number): void {
    this.zoomPercent.set(Math.max(50, Math.min(200, percent)));
  }

  resetZoom(): void {
    this.zoomPercent.set(100);
  }

  /**
   * Handle Cmd+scroll (Mac) or Ctrl+scroll (Windows) for zoom
   */
  @HostListener('wheel', ['$event'])
  onWheel(event: WheelEvent): void {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (event.deltaY < 0) {
        this.zoomIn();
      } else {
        this.zoomOut();
      }
    }
  }

  constructor() {
    // Watch for source changes
    effect(() => {
      const source = this.epubSource();
      if (source) {
        this.loadEpub(source);
      }
    });

    // Watch for deleted highlight changes
    effect(() => {
      const deleted = this.editorState.deletedHighlightIds();
      this.updateHighlightStyles(deleted);
    });

    // Watch for selection changes
    effect(() => {
      const selected = this.editorState.selectedHighlightIds();
      this.updateSelectionStyles(selected);
    });
  }

  ngAfterViewInit(): void {
    // If source was provided before view init, load it
    const source = this.epubSource();
    if (source) {
      this.loadEpub(source);
    }
  }

  ngOnDestroy(): void {
    this.epubjs.destroy();
  }

  /**
   * Load and render an EPUB
   */
  async loadEpub(source: string | ArrayBuffer): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      // If source is a file path string, read it as binary first
      // epub.js can't load local file paths directly in Electron
      let epubData: string | ArrayBuffer = source;
      if (typeof source === 'string' && !source.startsWith('http')) {
        const result = await this.electronService.readFileBinary(source);
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Failed to read EPUB file');
        }
        epubData = result.data;
      }

      // Load the EPUB
      await this.epubjs.loadEpub(epubData);

      // Render to container in continuous scroll mode (entire book)
      await this.epubjs.render(this.viewerContainer.nativeElement, {
        flow: 'scrolled',
        spread: 'none',
        manager: 'continuous',
      });

      // Set up selection handler
      this.epubjs.onSelection((cfi, text, contents) => {
        const chapterId = this.epubjs.getChapterIdFromCfi(cfi);
        this.selectionChanged.emit({ cfi, text, chapterId });
      });

      // Set up relocated handler for chapter tracking
      this.epubjs.onRelocated((location) => {
        const chapterId = this.epubjs.getChapterIdFromCfi(location.start.cfi);
        if (chapterId) {
          this.chapterChanged.emit(chapterId);
        }
      });

      // Set up highlight click handler
      this.epubjs.onHighlightClick((cfi, data) => {
        this.highlightClicked.emit({
          cfi,
          highlightId: data['highlightId'] as string | undefined,
          categoryId: data['categoryId'] as string | undefined,
          data
        });
      });

      // Set up block click handler
      this.epubjs.onBlockClick((block, additive) => {
        this.blockClicked.emit({ block, additive });
      });

      // Set up marquee selection handler
      this.epubjs.onMarqueeSelect((blockIds, additive) => {
        this.marqueeSelect.emit({ blockIds, additive });
      });

      // Set up clear selection handler (click on empty space)
      this.epubjs.onClearSelection(() => {
        // Emit empty marquee select to clear selection
        this.marqueeSelect.emit({ blockIds: [], additive: false });
      });

      // Forward keyboard events from iframe to parent
      this.epubjs.onKeydown((event) => {
        this.iframeKeydown.emit(event);
      });

      // Set up chapter marker callbacks
      this.epubjs.onChapterMarkerClick((event) => {
        this.chapterMarkerClicked.emit(event);
      });

      this.epubjs.onChapterMarkerDrag((event) => {
        this.chapterMarkerDragged.emit(event);
      });

      this.epubjs.onChapterPlacement((event) => {
        this.chapterPlacement.emit(event);
      });

      // Inject custom styles including block styles
      this.injectCustomStyles();

      this.loading.set(false);
      this.loaded.emit();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load EPUB';
      this.error.set(message);
      this.loading.set(false);
      this.loadError.emit(message);
    }
  }

  /**
   * Navigate to next page/section
   */
  async next(): Promise<void> {
    await this.epubjs.next();
  }

  /**
   * Navigate to previous page/section
   */
  async prev(): Promise<void> {
    await this.epubjs.prev();
  }

  /**
   * Navigate to a specific chapter
   */
  async goToChapter(chapterIndex: number): Promise<void> {
    await this.epubjs.goToChapter(chapterIndex);
  }

  /**
   * Navigate to a specific CFI
   */
  async goToCfi(cfi: string): Promise<void> {
    await this.epubjs.goToCfi(cfi);
  }

  /**
   * Add a highlight at a CFI location
   */
  addHighlight(cfi: string, categoryId: string, color: string): void {
    this.epubjs.addStyledHighlight(cfi, color, { categoryId });
    this.highlightClasses.set(cfi, 'epub-highlight');
  }

  /**
   * Remove a highlight
   */
  removeHighlight(cfi: string): void {
    this.epubjs.removeHighlight(cfi);
    this.highlightClasses.delete(cfi);
  }

  /**
   * Apply all highlights from the editor state
   */
  applyAllHighlights(): void {
    const categories = this.editorState.categories();
    const highlights = this.editorState.categoryHighlights();
    const deleted = this.editorState.deletedHighlightIds();

    highlights.forEach((chapterMap, categoryId) => {
      const category = categories[categoryId];
      if (!category) return;

      chapterMap.forEach((chapterHighlights, chapterId) => {
        for (const highlight of chapterHighlights) {
          const id = getEpubHighlightId(categoryId, chapterId, highlight.cfi);
          const isDeleted = deleted.has(id);

          // Use different colors for deleted vs active highlights
          const color = isDeleted
            ? 'rgba(255, 0, 0, 0.2)'
            : category.color || 'rgba(255, 255, 0, 0.3)';

          this.epubjs.addStyledHighlight(highlight.cfi, color, {
            categoryId,
            highlightId: id,
            isDeleted,
          });

          this.highlightClasses.set(highlight.cfi, isDeleted ? 'epub-highlight-deleted' : 'epub-highlight');
        }
      });
    });
  }

  /**
   * Clear all highlights from the view
   */
  clearAllHighlights(): void {
    this.epubjs.clearAllAnnotations();
    this.highlightClasses.clear();
  }

  /**
   * Set which blocks are deleted (updates visual state)
   */
  setDeletedBlocks(blockIds: Set<string>): void {
    this.epubjs.setDeletedBlocks(blockIds);
  }

  /**
   * Set which blocks are selected (updates visual state)
   */
  setSelectedBlocks(blockIds: Set<string>): void {
    this.epubjs.setSelectedBlocks(blockIds);
  }

  /**
   * Get all detected blocks
   */
  getBlocks(): EpubBlock[] {
    return this.epubjs.blocks();
  }

  /**
   * Set chapter markers to display
   */
  setChapterMarkers(chapters: EpubChapter[]): void {
    this.epubjs.setChapterMarkers(chapters);
  }

  /**
   * Set chapters mode (enables chapter marker interactions)
   */
  setChaptersMode(enabled: boolean): void {
    this.epubjs.setChaptersMode(enabled);
  }

  /**
   * Set selected chapter ID
   */
  setSelectedChapterId(chapterId: string | null): void {
    this.epubjs.setSelectedChapterId(chapterId);
  }

  /**
   * Update highlight styles based on deletion state
   */
  private updateHighlightStyles(deletedIds: Set<string>): void {
    // This would require re-applying all highlights
    // For now, we'll do a full refresh when deletion state changes
    // In a production app, we'd want more granular updates
  }

  /**
   * Update selection styles
   */
  private updateSelectionStyles(selectedIds: string[]): void {
    // Similar to above - would need to update individual highlight styles
  }

  /**
   * Inject custom CSS into the epub.js renderer
   */
  private injectCustomStyles(): void {
    const baseCss = `
      /* Force readable colors - white background, black text */
      html, body {
        background-color: #ffffff !important;
        color: #1a1a1a !important;
      }

      /* Ensure all text elements have proper color */
      p, div, span, h1, h2, h3, h4, h5, h6, li, td, th, a {
        color: #1a1a1a !important;
      }

      a {
        color: #0066cc !important;
      }

      /* Disable text selection highlighting - we use block selection */
      ::selection {
        background-color: transparent;
      }

      ::-moz-selection {
        background-color: transparent;
      }

      .epub-highlight {
        background-color: rgba(255, 255, 0, 0.3);
        border-radius: 2px;
      }

      .epub-highlight-deleted {
        background-color: rgba(255, 0, 0, 0.2);
        text-decoration: line-through;
        text-decoration-color: rgba(255, 0, 0, 0.6);
      }

      .epub-highlight-selected {
        background-color: rgba(100, 149, 237, 0.4);
        outline: 2px solid #6495ED;
        outline-offset: 1px;
      }

      .epub-styled-highlight {
        border-radius: 2px;
        transition: background-color 0.2s ease;
        cursor: pointer;
      }

      .epub-styled-highlight:hover {
        filter: brightness(0.85);
        outline: 2px solid rgba(0, 0, 0, 0.3);
        outline-offset: 1px;
      }
    `;

    // Combine base CSS with block styles
    const fullCss = baseCss + this.epubjs.getBlockStyles();
    this.epubjs.injectStyles(fullCss);
  }
}

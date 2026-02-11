import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ViewChild,
  HostListener,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { EpubjsService } from './services/epubjs.service';
import { EpubEditorStateService } from './services/epub-editor-state.service';
import { EpubSearchService, EpubSearchMatch } from './services/epub-search.service';
import { EpubExportService } from './services/epub-export.service';
import { EpubProjectService } from './services/epub-project.service';
import { EpubViewerComponent, EpubSelectionEvent, EpubHighlightClickEvent } from './components/epub-viewer/epub-viewer.component';
import { EpubBlock, ChapterMarkerEvent, ChapterMarkerDragEvent } from './services/epubjs.service';
import { EpubCategoriesPanelComponent } from './components/epub-categories-panel/epub-categories-panel.component';
import { ChapterNavComponent } from './components/chapter-nav/chapter-nav.component';
import { ChaptersPanelComponent } from '../pdf-picker/components/chapters-panel/chapters-panel.component';
import { ExportSettingsModalComponent, ExportResult, ExportFormat } from '../pdf-picker/components/export-settings-modal/export-settings-modal.component';
import { SplitPaneComponent } from '../../creamsicle-desktop';
import { ElectronService, Chapter } from '../../core/services/electron.service';
import { EpubHighlight, EpubCategory, getEpubHighlightId, EpubChapterInfo } from '../../core/models/epub-highlight.types';
import { BookMetadata, EpubChapter } from '../../core/models/book-metadata.types';

/**
 * Editor modes
 */
type EditorMode = 'select' | 'search' | 'chapters';

interface ModeInfo {
  id: EditorMode;
  icon: string;
  label: string;
  tooltip: string;
}

/**
 * EpubEditorComponent - Main page for EPUB editing
 *
 * Features:
 * - EPUB loading and viewing via epub.js
 * - Text search with CFI-based highlighting
 * - Category creation and management
 * - Highlight deletion for export
 * - Undo/redo support
 */
@Component({
  selector: 'app-epub-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    EpubViewerComponent,
    EpubCategoriesPanelComponent,
    ChapterNavComponent,
    ChaptersPanelComponent,
    ExportSettingsModalComponent,
    SplitPaneComponent
  ],
  template: `
    <div class="epub-editor">
      <!-- Toolbar -->
      <header class="toolbar">
        <div class="toolbar-left">
          <button class="btn icon-btn" (click)="goBack()" title="Back to Library">
            <span class="icon">\u2190</span>
          </button>
          <div class="doc-info">
            <h2 class="doc-title">{{ editorState.epubName() || 'No EPUB loaded' }}</h2>
            @if (editorState.author()) {
              <span class="doc-author">{{ editorState.author() }}</span>
            }
          </div>
        </div>

        <div class="toolbar-center">
          <!-- Chapter navigation in center -->
          @if (epubSource() && epubjs.isLoaded()) {
            <app-chapter-nav
              (chapterChanged)="onChapterNavChange($event)"
            ></app-chapter-nav>
          }
        </div>

        <div class="toolbar-right">
          <button
            class="btn"
            [disabled]="!editorState.canUndo()"
            (click)="undo()"
            title="Undo (Cmd+Z)"
          >
            Undo
          </button>
          <button
            class="btn"
            [disabled]="!editorState.canRedo()"
            (click)="redo()"
            title="Redo (Cmd+Shift+Z)"
          >
            Redo
          </button>
          <button
            class="btn primary"
            [disabled]="!editorState.epubLoaded()"
            (click)="showExportModal()"
            title="Export (Cmd+E)"
          >
            Export
          </button>
        </div>
      </header>

      <!-- Main Layout -->
      @if (epubSource()) {
        <desktop-split-pane
          direction="horizontal"
          [primarySize]="splitSize()"
          [minSize]="400"
          [maxSize]="3000"
          (sizeChanged)="onSplitSizeChanged($event)"
        >
          <!-- Primary: Left Tools + Viewer -->
          <div pane-primary class="viewer-pane-container">
            <!-- Left Tools Sidebar -->
            <div class="tools-sidebar">
              <div class="tools-section">
                <div class="tools-label">Tools</div>
                @for (mode of modes; track mode.id) {
                  <button
                    class="menu-item"
                    [class.active]="currentMode() === mode.id"
                    [title]="mode.tooltip"
                    (click)="setMode(mode.id)"
                  >
                    <span class="menu-icon">{{ mode.icon }}</span>
                    <span class="menu-text">{{ mode.label }}</span>
                  </button>
                }
              </div>

              <div class="tools-divider"></div>

              <div class="tools-section">
                <div class="tools-label">Actions</div>
                <button
                  class="menu-item"
                  [class.active]="editorState.selectedHighlightIds().length > 0"
                  title="Delete selected highlights"
                  [disabled]="editorState.selectedHighlightIds().length === 0"
                  (click)="deleteSelectedHighlights()"
                >
                  <span class="menu-icon">🗑️</span>
                  <span class="menu-text">Delete Selected</span>
                </button>
              </div>
            </div>

            <!-- Viewer Area -->
            <div class="viewer-wrapper">
              @if (epubSource()) {
                <app-epub-viewer
                  [epubSource]="epubSource()"
                  (selectionChanged)="onSelection($event)"
                  (chapterChanged)="onChapterChange($event)"
                  (highlightClicked)="onHighlightClick($event)"
                  (blockClicked)="onBlockClick($event)"
                  (marqueeSelect)="onMarqueeSelect($event)"
                  (iframeKeydown)="onIframeKeydown($event)"
                  (chapterMarkerClicked)="onChapterMarkerClick($event)"
                  (chapterMarkerDragged)="onChapterMarkerDrag($event)"
                  (chapterPlacement)="onChapterPlacement($event)"
                  (loaded)="onEpubLoaded()"
                  (loadError)="onEpubError($event)"
                ></app-epub-viewer>
              }
            </div>
          </div>

          <!-- Secondary: Categories Panel (Right Side) -->
          <div pane-secondary class="categories-pane">
            <!-- Search Section -->
            @if (currentMode() === 'search') {
              <div class="search-panel">
                <h3>Search & Create Categories</h3>
                <div class="search-input-group">
                  <input
                    type="text"
                    [(ngModel)]="searchQuery"
                    placeholder="Enter search pattern..."
                    (keyup.enter)="performSearch()"
                  />
                  <button class="btn" (click)="performSearch()" [disabled]="!searchQuery">
                    Search
                  </button>
                </div>
                <label class="checkbox-label">
                  <input type="checkbox" [(ngModel)]="useRegex" />
                  Use regex
                </label>

                @if (isSearching()) {
                  <div class="searching">Searching...</div>
                }

                @if (searchResults().length > 0) {
                  <div class="search-results">
                    <div class="results-header">
                      <span>{{ searchResults().length }} matches</span>
                      <button class="btn small primary" (click)="createCategoryFromResults()">
                        + Create Category
                      </button>
                    </div>
                    <div class="results-list">
                      @for (result of searchResults(); track result.cfi) {
                        <div
                          class="result-item"
                          (click)="goToResult(result)"
                          [class.selected]="selectedResult()?.cfi === result.cfi"
                        >
                          <span class="result-chapter">{{ result.chapterLabel }}</span>
                          <span class="result-text">{{ result.excerpt }}</span>
                        </div>
                      }
                    </div>
                  </div>
                }

                <div class="panel-divider"></div>
              </div>
            }

            <!-- Chapters Panel -->
            @if (currentMode() === 'chapters') {
              <app-chapters-panel
                [chapters]="chaptersForPanel()"
                [chaptersSource]="editorState.chaptersSource()"
                [detecting]="detectingChapters()"
                [finalizing]="finalizingChapters()"
                [selectedChapterId]="editorState.selectedChapterId()"
                (cancel)="setMode('select')"
                (autoDetect)="autoDetectChapters()"
                (clearChapters)="clearChapters()"
                (selectChapter)="selectChapter($event)"
                (removeChapter)="removeChapter($event)"
                (finalizeChapters)="finalizeChapters()"
                (renameChapter)="renameChapter($event)"
              ></app-chapters-panel>
            } @else {
              <!-- Categories Panel (for select/search modes) -->
              <app-epub-categories-panel
                [blocks]="epubjs.blocks()"
                (categorySelected)="onCategorySelected($event)"
                (jumpToHighlight)="onJumpToHighlight($event)"
                (switchToSearch)="setMode('search')"
              ></app-epub-categories-panel>
            }
          </div>
        </desktop-split-pane>
      } @else {
        <!-- Empty State -->
        <div class="empty-state">
          <span class="icon">\u{1F4D6}</span>
          <h3>No EPUB loaded</h3>
          <p>Open an EPUB file from the library to start editing.</p>
          <button class="btn primary" (click)="openFilePicker()">Open EPUB</button>
        </div>
      }

      <!-- Status bar -->
      <footer class="status-bar">
        <div class="status-left">
          @if (editorState.currentChapterId()) {
            <span>Chapter: {{ getCurrentChapterLabel() }}</span>
          }
          @if (currentMode() === 'select') {
            <span class="mode-hint">Click to select, Delete key to remove, click deleted to restore</span>
          }
        </div>
        <div class="status-center">
          <span class="stat">{{ epubjs.blocks().length }} blocks</span>
          @if (editorState.selectedBlockIds().length > 0) {
            <span class="divider">|</span>
            <span class="selected-count">{{ editorState.selectedBlockIds().length }} selected</span>
          }
          @if (editorState.deletedBlockIds().size > 0) {
            <span class="divider">|</span>
            <span class="excluded">{{ editorState.deletedBlockIds().size }} deleted</span>
          }
        </div>
        <div class="status-right">
          @if (editorState.hasUnsavedChanges()) {
            <span class="unsaved-indicator">Unsaved changes</span>
          }
        </div>
      </footer>
    </div>

    <!-- Create Category Modal -->
    @if (showCreateCategoryModal()) {
      <div class="modal-backdrop" (click)="closeCreateCategoryModal()">
        <div class="modal" (click)="$event.stopPropagation()">
          <h3>Create Category</h3>
          <div class="form-group">
            <label>Name</label>
            <input type="text" [(ngModel)]="newCategoryName" placeholder="e.g., Page Numbers" />
          </div>
          <div class="form-group">
            <label>Description</label>
            <input type="text" [(ngModel)]="newCategoryDescription" placeholder="e.g., Running page numbers" />
          </div>
          <div class="form-group">
            <label>Color</label>
            <input type="color" [(ngModel)]="newCategoryColor" />
          </div>
          <div class="modal-actions">
            <button class="btn" (click)="closeCreateCategoryModal()">Cancel</button>
            <button class="btn primary" (click)="confirmCreateCategory()">Create</button>
          </div>
        </div>
      </div>
    }

    <!-- Export Settings Modal -->
    @if (showExportSettings()) {
      <app-export-settings-modal
        [pdfName]="editorState.epubName() || 'Untitled'"
        [totalPages]="epubjs.totalChapters()"
        [availableFormats]="['epub', 'txt', 'audiobook']"
        (result)="onExportResult($event)"
      />
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
    }

    .epub-editor {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 48px;
      padding: 0 1rem;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
      flex-shrink: 0;
    }

    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .toolbar-center {
      display: flex;
      align-items: center;
      flex: 1;
      justify-content: center;
    }

    .doc-info {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .doc-title {
      font-size: 0.875rem;
      font-weight: 600;
      margin: 0;
      color: var(--text-primary);
    }

    .doc-author {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    /* Main Layout */
    .viewer-pane-container {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    /* Left Tools Sidebar */
    .tools-sidebar {
      width: 180px;
      min-width: 180px;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      padding: 0.5rem 0;
    }

    .tools-section {
      padding: 0 0.5rem;
    }

    .tools-label {
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-tertiary);
      padding: 0.5rem 0.75rem 0.25rem;
      letter-spacing: 0.05em;
    }

    .tools-divider {
      height: 1px;
      background: var(--border-default);
      margin: 0.5rem 0;
    }

    .menu-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 0.75rem;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s ease;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent-subtle);
        border-color: var(--accent);

        .menu-text {
          color: var(--accent);
          font-weight: 500;
        }
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .menu-icon {
      font-size: 1rem;
      width: 1.25rem;
      text-align: center;
    }

    .menu-text {
      flex: 1;
    }

    /* Viewer Wrapper */
    .viewer-wrapper {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Categories Pane (Right Side) */
    .categories-pane {
      height: 100%;
      overflow-y: auto;
      background: var(--bg-elevated);
      padding: 1rem;
      display: flex;
      flex-direction: column;
    }

    /* Search Panel */
    .search-panel {
      flex-shrink: 0;

      h3 {
        margin: 0 0 0.75rem 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .search-input-group {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.5rem;

      input {
        flex: 1;
        padding: 0.5rem;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 0.875rem;
      }
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.5rem;
    }

    .searching {
      color: var(--text-secondary);
      font-size: 0.875rem;
      padding: 1rem 0;
    }

    .search-results {
      margin-top: 0.5rem;
    }

    .results-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .results-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      max-height: 300px;
      overflow-y: auto;
    }

    .result-item {
      padding: 0.5rem;
      background: var(--bg-surface);
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s ease;

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: color-mix(in srgb, var(--accent-primary) 20%, transparent);
        outline: 1px solid var(--accent-primary);
      }
    }

    .result-chapter {
      display: block;
      font-size: 0.625rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      margin-bottom: 0.125rem;
    }

    .result-text {
      font-size: 0.75rem;
      color: var(--text-primary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .panel-divider {
      height: 1px;
      background: var(--border-default);
      margin: 1rem 0;
    }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 0.5rem;
      color: var(--text-secondary);

      .icon {
        font-size: 3rem;
        opacity: 0.5;
      }

      h3 {
        margin: 0;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 1rem 0;
      }
    }

    /* Status bar */
    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 28px;
      padding: 0 1rem;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      font-size: 0.75rem;
      color: var(--text-secondary);
      flex-shrink: 0;
    }

    .status-left {
      display: flex;
      gap: 1rem;
    }

    .mode-hint {
      color: var(--text-tertiary);
      font-style: italic;
    }

    .status-center {
      display: flex;
      gap: 0.5rem;
    }

    .included {
      color: var(--accent-success);
    }

    .selected-count {
      color: var(--accent);
    }

    .excluded {
      color: var(--accent-danger);
    }

    .divider {
      opacity: 0.3;
    }

    .unsaved-indicator {
      color: var(--accent-warning);
    }

    /* Buttons */
    .btn {
      padding: 0.375rem 0.75rem;
      border-radius: 4px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.primary {
        background: var(--accent-primary);
        border-color: var(--accent-primary);
        color: white;

        &:hover:not(:disabled) {
          background: var(--accent-primary-hover);
        }
      }

      &.small {
        padding: 0.25rem 0.5rem;
        font-size: 0.625rem;
      }
    }

    .icon-btn {
      padding: 0.375rem;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;

      .icon {
        font-size: 1rem;
      }
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal {
      background: var(--bg-elevated);
      border-radius: 8px;
      padding: 1.5rem;
      min-width: 400px;
      max-width: 90vw;

      h3 {
        margin: 0 0 1rem 0;
        font-size: 1rem;
        font-weight: 600;
      }
    }

    .form-group {
      margin-bottom: 1rem;

      label {
        display: block;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
        margin-bottom: 0.25rem;
      }

      input[type="text"] {
        width: 100%;
        padding: 0.5rem;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 0.875rem;
      }

      input[type="color"] {
        width: 60px;
        height: 32px;
        padding: 0;
        border: 1px solid var(--border-default);
        border-radius: 4px;
        cursor: pointer;
      }
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1.5rem;
    }
  `]
})
export class EpubEditorComponent implements OnInit, OnDestroy {
  readonly epubjs = inject(EpubjsService);
  readonly editorState = inject(EpubEditorStateService);
  private readonly searchService = inject(EpubSearchService);
  private readonly exportService = inject(EpubExportService);
  private readonly projectService = inject(EpubProjectService);
  private readonly electron = inject(ElectronService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  @ViewChild(EpubViewerComponent) viewer!: EpubViewerComponent;

  // Editor modes
  readonly modes: ModeInfo[] = [
    { id: 'select', icon: '🎯', label: 'Select', tooltip: 'Click blocks to select/delete (S)' },
    { id: 'search', icon: '🔍', label: 'Search', tooltip: 'Search and create categories (F)' },
    { id: 'chapters', icon: '📑', label: 'Chapters', tooltip: 'Define chapter markers (H)' },
  ];

  // Layout constants
  private readonly CATEGORIES_WIDTH = 280;

  // Local state
  readonly currentMode = signal<EditorMode>('select');
  readonly epubSource = signal<string | ArrayBuffer | null>(null);
  readonly splitSize = signal(Math.max(400, window.innerWidth - this.CATEGORIES_WIDTH));
  readonly isConverting = signal(false);

  // Selection state
  readonly selectedText = signal<string | null>(null);
  readonly selectedCfi = signal<string | null>(null);

  // Search state
  searchQuery = '';
  useRegex = false;
  readonly isSearching = signal(false);
  readonly searchResults = signal<EpubSearchMatch[]>([]);
  readonly selectedResult = signal<EpubSearchMatch | null>(null);

  // Create category modal
  readonly showCreateCategoryModal = signal(false);
  newCategoryName = '';
  newCategoryDescription = '';
  newCategoryColor = '#ffff00';

  // Export modal
  readonly showExportSettings = signal(false);

  // Chapters state
  readonly detectingChapters = signal(false);
  readonly finalizingChapters = signal(false);

  /**
   * Convert EpubChapter to Chapter format for the ChaptersPanel
   * (ChaptersPanel expects page-based Chapter, we use sectionIndex)
   */
  readonly chaptersForPanel = computed<Chapter[]>(() => {
    return this.editorState.chapters().map(ch => ({
      id: ch.id,
      title: ch.title,
      page: ch.sectionIndex, // Use sectionIndex as "page"
      blockId: ch.blockId,
      y: ch.y,
      level: ch.level,
      source: ch.source,
      confidence: ch.confidence,
    }));
  });

  constructor() {
    // Sync deleted blocks with the viewer when deletion state changes
    effect(() => {
      const deletedBlocks = this.editorState.deletedBlockIds();
      if (this.viewer) {
        this.viewer.setDeletedBlocks(deletedBlocks);
      }
    });

    // Sync selected blocks with the viewer when selection state changes
    effect(() => {
      const selectedBlocks = new Set(this.editorState.selectedBlockIds());
      if (this.viewer) {
        this.viewer.setSelectedBlocks(selectedBlocks);
      }
    });

    // Sync chapter markers with the viewer
    effect(() => {
      const chapters = this.editorState.chapters();
      if (this.viewer) {
        this.viewer.setChapterMarkers(chapters);
      }
    });

    // Sync chapters mode with the viewer
    effect(() => {
      const isChaptersMode = this.currentMode() === 'chapters';
      if (this.viewer) {
        this.viewer.setChaptersMode(isChaptersMode);
      }
    });

    // Sync selected chapter ID with the viewer
    effect(() => {
      const selectedChapterId = this.editorState.selectedChapterId();
      if (this.viewer) {
        this.viewer.setSelectedChapterId(selectedChapterId);
      }
    });
  }

  ngOnInit(): void {
    // Check for epub path in route params or query params
    this.route.queryParams.subscribe(params => {
      if (params['path']) {
        this.loadEpubFromPath(params['path']);
      }
    });

    // Listen for window resize
    window.addEventListener('resize', this.onWindowResize);
  }

  private onWindowResize = (): void => {
    // Update split size to maintain categories panel width
    this.splitSize.set(Math.max(400, window.innerWidth - this.CATEGORIES_WIDTH));
  };

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onWindowResize);
    this.epubjs.destroy();
    this.editorState.reset();
    this.projectService.reset();
  }

  /**
   * Keyboard shortcuts
   */
  @HostListener('window:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    // Mode shortcuts (when not in input)
    if ((event.target as HTMLElement).tagName !== 'INPUT' && (event.target as HTMLElement).tagName !== 'TEXTAREA') {
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        this.setMode('select');
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        this.setMode('search');
      } else if (event.key === 'h' || event.key === 'H') {
        event.preventDefault();
        this.setMode('chapters');
      }

      // Delete/Backspace to mark selected blocks as deleted
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this.deleteSelectedBlocks();
      }

      // Escape to clear selection
      if (event.key === 'Escape') {
        event.preventDefault();
        this.editorState.clearBlockSelection();
      }
    }

    // Undo/redo and export shortcut
    if (event.metaKey || event.ctrlKey) {
      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.undo();
      } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
        event.preventDefault();
        this.redo();
      } else if (event.key === 'e') {
        event.preventDefault();
        if (this.editorState.epubLoaded()) {
          this.showExportSettings.set(true);
        }
      } else if (event.key === 'a') {
        // Cmd+A to select all blocks
        event.preventDefault();
        this.selectAllBlocks();
      }
    }
  }

  /**
   * Delete selected blocks
   */
  deleteSelectedBlocks(): void {
    const selected = this.editorState.selectedBlockIds();
    if (selected.length > 0) {
      this.editorState.deleteBlocks(selected);
    }
  }

  /**
   * Select all blocks
   */
  selectAllBlocks(): void {
    const allBlockIds = this.epubjs.blocks().map(b => b.id);
    this.editorState.selectedBlockIds.set(allBlockIds);
  }

  /**
   * Handle marquee selection
   */
  onMarqueeSelect(event: { blockIds: string[]; additive: boolean }): void {
    const { blockIds, additive } = event;

    if (additive) {
      // Add to existing selection
      const current = new Set(this.editorState.selectedBlockIds());
      blockIds.forEach(id => current.add(id));
      this.editorState.selectedBlockIds.set(Array.from(current));
    } else {
      // Replace selection
      this.editorState.selectedBlockIds.set(blockIds);
    }
  }

  /**
   * Load EPUB from file path
   * If the file is not an EPUB (e.g., AZW3, MOBI), converts it first using Calibre's ebook-convert
   */
  async loadEpubFromPath(filePath: string): Promise<void> {
    try {
      let effectivePath = filePath;
      const originalFilename = filePath.replace(/\\/g, '/').split('/').pop() || 'Untitled';

      // Check if file needs conversion (AZW3, MOBI, KFX, etc.)
      const ext = filePath.toLowerCase().split('.').pop() || '';
      if (ext !== 'epub') {
        console.log('[EpubEditor] File needs conversion:', filePath);

        // Check if ebook-convert is available
        const isAvailable = await this.electron.isEbookConvertAvailable();
        if (!isAvailable) {
          console.error('[EpubEditor] ebook-convert not available, cannot open non-EPUB file');
          alert('Cannot open this file format. Install Calibre to enable format conversion.');
          return;
        }

        // Convert to EPUB (saved to ~/Documents/BookForge/converted/)
        console.log('[EpubEditor] Converting to EPUB...');
        this.isConverting.set(true);
        const convertResult = await this.electron.convertEbookToLibrary(filePath);
        this.isConverting.set(false);

        if (!convertResult.success || !convertResult.outputPath) {
          console.error('[EpubEditor] Conversion failed:', convertResult.error);
          alert(convertResult.error || 'Failed to convert file to EPUB');
          return;
        }

        effectivePath = convertResult.outputPath;
        console.log('[EpubEditor] Converted to:', effectivePath);
      }

      // Load the EPUB
      this.epubSource.set(effectivePath);
      const filename = originalFilename.replace(/\.[^.]+$/, '.epub');
      this.editorState.epubPath.set(effectivePath);
      this.editorState.epubName.set(filename);
    } catch (error) {
      console.error('Failed to load EPUB:', error);
      this.isConverting.set(false);
      alert(error instanceof Error ? error.message : 'Failed to load file');
    }
  }

  /**
   * Open file picker
   * Accepts EPUB and other ebook formats (AZW3, MOBI, etc.) - non-EPUB will be converted
   */
  async openFilePicker(): Promise<void> {
    try {
      const result = await this.electron.openPdfDialog();
      if (result.success && result.filePath) {
        const ext = result.filePath.toLowerCase().split('.').pop() || '';
        const ebookFormats = ['epub', 'azw3', 'azw', 'mobi', 'kfx', 'prc', 'fb2'];
        if (ebookFormats.includes(ext)) {
          await this.loadEpubFromPath(result.filePath);
        }
      }
    } catch (error) {
      console.error('Failed to open file picker:', error);
    }
  }

  /**
   * Go back to library
   */
  goBack(): void {
    this.router.navigate(['/library']);
  }

  /**
   * Set editor mode
   */
  setMode(newMode: EditorMode): void {
    this.currentMode.set(newMode);
  }

  /**
   * Handle split pane resize
   */
  onSplitSizeChanged(size: number): void {
    this.splitSize.set(size);
  }

  /**
   * Handle EPUB loaded
   */
  async onEpubLoaded(): Promise<void> {
    const epubPath = this.editorState.epubPath();
    const epubName = this.editorState.epubName();

    // Auto-create or load project BEFORE loading document state
    // This will restore deleted blocks from saved project
    await this.projectService.autoCreateProject(epubPath, epubName);

    this.editorState.loadDocument({
      epubPath,
      epubName,
      title: this.epubjs.title(),
      author: this.epubjs.author(),
      coverUrl: this.epubjs.coverUrl(),
      totalChapters: this.epubjs.totalChapters(),
      // Don't override chapters/deletions if already loaded from project
      deletedBlockIds: this.editorState.deletedBlockIds(),
      chapters: this.editorState.chapters().length > 0 ? this.editorState.chapters() : undefined,
      chaptersSource: this.editorState.chaptersSource(),
    });

    // Auto-load chapters from EPUB's TOC only if not already loaded from project
    if (this.editorState.chapters().length === 0) {
      this.loadChaptersFromToc();
    }

    // Sync initial deleted blocks state to viewer
    setTimeout(() => {
      if (this.viewer) {
        this.viewer.setDeletedBlocks(this.editorState.deletedBlockIds());
      }
    }, 100);
  }

  /**
   * Load chapters from the EPUB's table of contents
   */
  private loadChaptersFromToc(): void {
    const tocChapters = this.epubjs.chapters();
    if (tocChapters.length > 0) {
      const chapters: EpubChapter[] = tocChapters.map((toc, index) => ({
        id: `toc-${index}-${Date.now()}`,
        title: toc.label,
        sectionIndex: toc.index,
        sectionHref: toc.href,
        level: 1,
        source: 'toc' as const,
      }));
      this.editorState.setChapters(chapters, 'toc');
    }
  }

  /**
   * Handle EPUB load error
   */
  onEpubError(error: string): void {
    console.error('EPUB load error:', error);
  }

  /**
   * Handle text selection
   */
  onSelection(event: EpubSelectionEvent): void {
    this.selectedText.set(event.text || null);
    this.selectedCfi.set(event.cfi || null);
  }

  /**
   * Handle chapter change
   */
  onChapterChange(chapterId: string): void {
    this.editorState.currentChapterId.set(chapterId);
  }

  /**
   * Handle highlight click - toggle deletion state (legacy, for search-based highlights)
   */
  onHighlightClick(event: EpubHighlightClickEvent): void {
    if (event.highlightId) {
      this.editorState.toggleHighlightDeletion(event.highlightId);
      this.refreshHighlights();
    }
  }

  /**
   * Handle block click - select or restore if deleted
   */
  onBlockClick(event: { block: EpubBlock; additive: boolean }): void {
    const { block, additive } = event;

    // In chapters mode, clicking creates chapter markers
    if (this.currentMode() === 'chapters') {
      this.handleChapterModeBlockClick(block, additive);
      return;
    }

    // If block is deleted, restore it on click
    if (this.editorState.isBlockDeleted(block.id)) {
      this.editorState.restoreBlocks([block.id]);
      return;
    }

    // Otherwise, toggle selection
    this.editorState.selectBlock(block.id, additive);
  }

  /**
   * Handle keydown events forwarded from the iframe
   */
  onIframeKeydown(event: KeyboardEvent): void {
    // Delete/Backspace to mark selected blocks as deleted
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelectedBlocks();
    }

    // Escape to clear selection
    if (event.key === 'Escape') {
      event.preventDefault();
      this.editorState.clearBlockSelection();
    }

    // Cmd+A to select all blocks
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      event.preventDefault();
      this.selectAllBlocks();
    }
  }

  /**
   * Delete selected highlights
   */
  deleteSelectedHighlights(): void {
    this.editorState.deleteSelectedHighlights();
    this.refreshHighlights();
  }

  /**
   * Refresh all highlights to reflect current deletion state
   */
  private refreshHighlights(): void {
    this.viewer.clearAllHighlights();
    this.viewer.applyAllHighlights();
  }

  /**
   * Get current chapter label
   */
  getCurrentChapterLabel(): string {
    const chapterId = this.editorState.currentChapterId();
    if (!chapterId) return '';

    const chapters = this.epubjs.chapters();
    const chapter = chapters.find(c => c.id === chapterId);
    return chapter?.label || chapterId;
  }

  /**
   * Perform text search
   */
  async performSearch(): Promise<void> {
    if (!this.searchQuery) return;

    this.isSearching.set(true);
    this.searchResults.set([]);
    this.selectedResult.set(null);

    try {
      const results = this.useRegex
        ? await this.searchService.searchRegex(this.searchQuery)
        : await this.searchService.searchPattern(this.searchQuery);

      this.searchResults.set(results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      this.isSearching.set(false);
    }
  }

  /**
   * Navigate to a search result
   */
  async goToResult(result: EpubSearchMatch): Promise<void> {
    this.selectedResult.set(result);
    await this.viewer.goToCfi(result.cfi);
  }

  /**
   * Create category from search results
   */
  createCategoryFromResults(): void {
    if (this.searchResults().length === 0) return;

    this.newCategoryName = this.searchQuery;
    this.newCategoryDescription = `Pattern: ${this.searchQuery}`;
    this.showCreateCategoryModal.set(true);
  }

  /**
   * Close create category modal
   */
  closeCreateCategoryModal(): void {
    this.showCreateCategoryModal.set(false);
    this.newCategoryName = '';
    this.newCategoryDescription = '';
    this.newCategoryColor = '#ffff00';
  }

  /**
   * Confirm category creation
   */
  confirmCreateCategory(): void {
    if (!this.newCategoryName) return;

    const categoryId = this.searchService.createCategoryFromSearch(
      this.newCategoryName,
      this.newCategoryDescription,
      this.newCategoryColor,
      this.searchQuery,
      this.searchResults()
    );

    // Apply highlights to viewer
    const results = this.searchResults();
    for (const result of results) {
      this.viewer.addHighlight(result.cfi, categoryId, this.newCategoryColor);
    }

    this.closeCreateCategoryModal();
    this.setMode('select');
  }

  /**
   * Handle category selection from categories panel
   */
  onCategorySelected(categoryId: string): void {
    console.log('Category selected:', categoryId);
  }

  /**
   * Handle jump to highlight from categories panel
   */
  async onJumpToHighlight(cfi: string): Promise<void> {
    await this.viewer.goToCfi(cfi);
  }

  /**
   * Handle chapter change from chapter navigation
   */
  onChapterNavChange(chapter: EpubChapterInfo): void {
    this.editorState.currentChapterId.set(chapter.id);
  }

  /**
   * Undo last action
   */
  undo(): void {
    this.editorState.undo();
    this.refreshHighlights();
  }

  /**
   * Redo last undone action
   */
  redo(): void {
    this.editorState.redo();
    this.refreshHighlights();
  }

  /**
   * Show export modal
   */
  showExportModal(): void {
    this.showExportSettings.set(true);
  }

  /**
   * Handle export modal result
   */
  async onExportResult(result: ExportResult): Promise<void> {
    this.showExportSettings.set(false);

    if (!result.confirmed || !result.settings) {
      return;
    }

    const format = result.settings.format;

    if (format === 'audiobook') {
      await this.transferToAudiobook();
    } else if (format === 'epub') {
      await this.exportEpub();
    } else if (format === 'txt') {
      await this.exportAsText();
    }
  }

  /**
   * Export EPUB with deletions applied
   */
  async exportEpub(): Promise<void> {
    try {
      const preview = this.exportService.getExportPreview();
      console.log(`Exporting EPUB with ${preview.deletedCount} deletions (${preview.deletedChars} chars)`);

      const result = await this.exportService.exportWithDeletions();

      if (result.success) {
        console.log(`EPUB exported successfully to: ${result.outputPath}`);
        this.editorState.markSaved();
      } else {
        console.error('Export failed:', result.error);
      }
    } catch (error) {
      console.error('Export error:', error);
    }
  }

  /**
   * Export as plain text
   */
  async exportAsText(): Promise<void> {
    try {
      const result = await this.exportService.exportAsText();

      if (result.success && result.text) {
        const epubName = this.editorState.epubName() || 'export';
        const baseName = epubName.replace(/\.[^.]+$/, '');
        const dialogResult = await this.electron.showSaveTextDialog(`${baseName}.txt`);

        if (dialogResult.success && dialogResult.filePath) {
          const writeResult = await this.electron.writeTextFile(dialogResult.filePath, result.text);
          if (writeResult.success) {
            console.log('Text exported successfully to:', dialogResult.filePath);
          } else {
            console.error('Failed to write text file:', writeResult.error);
          }
        }
      } else {
        console.error('Export as text failed:', result.error);
      }
    } catch (error) {
      console.error('Export as text error:', error);
    }
  }

  /**
   * Transfer EPUB to Audiobook Producer
   */
  async transferToAudiobook(): Promise<void> {
    const epubPath = this.editorState.epubPath();
    const epubName = this.editorState.epubName();
    if (!epubPath || !epubName) return;

    try {
      let transferPath = epubPath;
      const deletedCount = this.editorState.deletedHighlightIds().size;

      if (deletedCount > 0) {
        const exportResult = await this.exportService.exportWithDeletions();
        if (!exportResult.success || !exportResult.outputPath) {
          console.error('Export failed before transfer:', exportResult.error);
          return;
        }
        transferPath = exportResult.outputPath;
        this.editorState.markSaved();
      }

      const result = await this.electron.copyToAudiobookQueue(transferPath, epubName);

      if (result.success) {
        console.log('EPUB transferred to Audiobook Producer');
        this.router.navigate(['/audiobook']);
      } else {
        console.error('Transfer to Audiobook failed:', result.error);
      }
    } catch (error) {
      console.error('Transfer error:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chapter Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Auto-detect chapters from EPUB TOC (re-detect if already loaded)
   */
  async autoDetectChapters(): Promise<void> {
    this.detectingChapters.set(true);
    try {
      this.loadChaptersFromToc();
    } catch (error) {
      console.error('Failed to auto-detect chapters:', error);
    } finally {
      this.detectingChapters.set(false);
    }
  }

  /**
   * Clear all chapters
   */
  clearChapters(): void {
    this.editorState.clearChapters();
  }

  /**
   * Select a chapter
   */
  selectChapter(chapterId: string): void {
    this.editorState.selectedChapterId.set(chapterId);
    // Navigate to the chapter
    const chapter = this.editorState.chapters().find(c => c.id === chapterId);
    if (chapter) {
      this.viewer.goToChapter(chapter.sectionIndex);
    }
  }

  /**
   * Remove a chapter
   */
  removeChapter(chapterId: string): void {
    this.editorState.removeChapter(chapterId);
  }

  /**
   * Rename a chapter
   */
  renameChapter(event: { chapterId: string; newTitle: string }): void {
    this.editorState.renameChapter(event.chapterId, event.newTitle);
  }

  /**
   * Finalize chapters
   */
  async finalizeChapters(): Promise<void> {
    this.finalizingChapters.set(true);
    try {
      // Save the project with chapter data
      // For now, just mark as complete and exit chapters mode
      this.editorState.markChanged();
      this.setMode('select');
    } finally {
      this.finalizingChapters.set(false);
    }
  }

  /**
   * Handle metadata change from chapters panel
   */
  onMetadataChange(metadata: BookMetadata): void {
    this.editorState.updateMetadata(metadata);
  }

  /**
   * Save metadata
   */
  saveMetadata(): void {
    this.editorState.markChanged();
  }

  /**
   * Handle block click in chapters mode - create chapter marker
   */
  private handleChapterModeBlockClick(block: EpubBlock, additive: boolean): void {
    // Check if this block already has a chapter marker
    const existingChapter = this.editorState.chapters().find(c => c.blockId === block.id);
    if (existingChapter) {
      // Toggle: remove if already marked
      this.editorState.removeChapter(existingChapter.id);
      return;
    }

    // Get section info from block
    const sectionHref = block.sectionHref;
    const sectionIndex = this.epubjs.chapters().findIndex(ch => ch.href === sectionHref);

    // Create new chapter
    const level = additive ? 2 : 1; // Shift+click for section (level 2)
    const chapter: EpubChapter = {
      id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title: block.text.length > 80 ? block.text.substring(0, 77) + '...' : block.text,
      sectionIndex: sectionIndex >= 0 ? sectionIndex : 0,
      sectionHref,
      blockId: block.id,
      y: block.element.getBoundingClientRect().top,
      level,
      source: 'manual',
    };

    this.editorState.addChapter(chapter);
  }

  /**
   * Handle chapter marker click - select the chapter
   */
  onChapterMarkerClick(event: ChapterMarkerEvent): void {
    this.editorState.selectedChapterId.set(event.chapterId);
  }

  /**
   * Handle chapter marker drag - update position
   */
  onChapterMarkerDrag(event: ChapterMarkerDragEvent): void {
    this.editorState.updateChapterPosition(
      event.chapterId,
      event.sectionIndex,
      event.sectionHref,
      event.y,
      event.blockId,
      event.blockText
    );
  }

  /**
   * Handle chapter placement (click in empty area in chapters mode)
   */
  onChapterPlacement(event: ChapterMarkerDragEvent): void {
    // Create new chapter at the clicked position
    const chapter: EpubChapter = {
      id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title: event.blockText || 'New Chapter',
      sectionIndex: event.sectionIndex,
      sectionHref: event.sectionHref,
      blockId: event.blockId,
      y: event.y,
      level: 1,
      source: 'manual',
    };

    this.editorState.addChapter(chapter);
    this.editorState.selectedChapterId.set(chapter.id);
  }
}

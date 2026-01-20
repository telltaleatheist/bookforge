import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ViewChild,
  HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { EpubjsService } from './services/epubjs.service';
import { EpubEditorStateService } from './services/epub-editor-state.service';
import { EpubSearchService, EpubSearchMatch } from './services/epub-search.service';
import { EpubExportService } from './services/epub-export.service';
import { EpubViewerComponent, EpubSelectionEvent } from './components/epub-viewer/epub-viewer.component';
import { EpubCategoriesPanelComponent } from './components/epub-categories-panel/epub-categories-panel.component';
import { ChapterNavComponent } from './components/chapter-nav/chapter-nav.component';
import { ElectronService } from '../../core/services/electron.service';
import { EpubHighlight, EpubCategory, getEpubHighlightId, EpubChapterInfo } from '../../core/models/epub-highlight.types';

/**
 * Editor modes
 */
type EditorMode = 'select' | 'search' | 'categories';

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
  imports: [CommonModule, FormsModule, EpubViewerComponent, EpubCategoriesPanelComponent, ChapterNavComponent],
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
          <!-- Empty center area - modes removed -->
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
            (click)="exportEpub()"
            title="Export EPUB"
          >
            Export
          </button>
          <button
            class="btn"
            [disabled]="!editorState.epubLoaded()"
            (click)="transferToAudiobook()"
            title="Transfer to Audiobook Producer"
          >
            \u{1F3A7} Audiobook
          </button>
        </div>
      </header>

      <!-- Main content -->
      <div class="main-content">
        <!-- Left sidebar (always visible with search + categories) -->
        <aside class="sidebar">
          <!-- Search section -->
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
          </div>

          <!-- Divider -->
          <div class="sidebar-divider"></div>

          <!-- Categories section -->
          <div class="categories-section">
            <app-epub-categories-panel
              (categorySelected)="onCategorySelected($event)"
              (jumpToHighlight)="onJumpToHighlight($event)"
            ></app-epub-categories-panel>
          </div>
        </aside>

        <!-- EPUB viewer -->
        <div class="viewer-area">
          <!-- Chapter navigation bar -->
          @if (epubSource() && epubjs.isLoaded()) {
            <div class="chapter-nav-bar">
              <app-chapter-nav
                (chapterChanged)="onChapterNavChange($event)"
              ></app-chapter-nav>
            </div>
          }

          @if (epubSource()) {
            <app-epub-viewer
              [epubSource]="epubSource()"
              (selectionChanged)="onSelection($event)"
              (chapterChanged)="onChapterChange($event)"
              (loaded)="onEpubLoaded()"
              (loadError)="onEpubError($event)"
            ></app-epub-viewer>
          } @else {
            <div class="empty-state">
              <span class="icon">\u{1F4D6}</span>
              <h3>No EPUB loaded</h3>
              <p>Open an EPUB file from the library to start editing.</p>
              <button class="btn primary" (click)="openFilePicker()">Open EPUB</button>
            </div>
          }
        </div>

      </div>

      <!-- Status bar -->
      <footer class="status-bar">
        <div class="status-left">
          @if (editorState.currentChapterId()) {
            <span>Chapter: {{ getCurrentChapterLabel() }}</span>
          }
        </div>
        <div class="status-center">
          <span class="included">{{ editorState.includedChars() | number }} chars included</span>
          <span class="divider">|</span>
          <span class="excluded">{{ editorState.excludedChars() | number }} chars excluded</span>
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
    }

    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .toolbar-center {
      display: flex;
      align-items: center;
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

    .mode-switcher {
      display: flex;
      gap: 2px;
      background: var(--bg-surface);
      padding: 2px;
      border-radius: 6px;
    }

    .mode-btn {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.375rem 0.75rem;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--text-secondary);
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent-primary);
        color: white;
      }

      .icon {
        font-size: 1rem;
      }
    }

    /* Main content */
    .main-content {
      display: flex;
      flex: 1;
      overflow: hidden;
    }

    .sidebar {
      width: 320px;
      min-width: 320px;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
      padding: 1rem;
      overflow-y: auto;
      display: flex;
      flex-direction: column;

      h3 {
        margin: 0 0 0.75rem 0;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .search-panel {
      flex-shrink: 0;
    }

    .sidebar-divider {
      height: 1px;
      background: var(--border-default);
      margin: 1rem 0;
      flex-shrink: 0;
    }

    .categories-section {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
    }

    .selection-sidebar {
      border-right: none;
      border-left: 1px solid var(--border-default);
    }

    .viewer-area {
      flex: 1;
      padding: 1rem;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .chapter-nav-bar {
      padding: 0 0 0.75rem 0;
      flex-shrink: 0;
    }

    /* Search panel */
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
      margin-bottom: 1rem;
    }

    .searching {
      color: var(--text-secondary);
      font-size: 0.875rem;
      padding: 1rem 0;
    }

    .search-results {
      margin-top: 1rem;
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
      max-height: 400px;
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

    /* Categories panel */
    .category-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .category-item {
      padding: 0.75rem;
      background: var(--bg-surface);
      border-radius: 4px;
      border-left: 3px solid var(--accent-primary);
    }

    .category-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .category-name {
      font-weight: 500;
      font-size: 0.875rem;
      color: var(--text-primary);
    }

    .category-count {
      font-size: 0.75rem;
      color: var(--text-secondary);
      background: var(--bg-elevated);
      padding: 0.125rem 0.375rem;
      border-radius: 10px;
    }

    .category-actions {
      display: flex;
      gap: 0.5rem;
    }

    .empty-message {
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    /* Selection sidebar */
    .selected-text-preview {
      background: var(--bg-surface);
      padding: 0.75rem;
      border-radius: 4px;
      font-size: 0.875rem;
      color: var(--text-primary);
      max-height: 200px;
      overflow-y: auto;
      margin-bottom: 1rem;
    }

    .selection-actions {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    /* Empty state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
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
    }

    .status-center {
      display: flex;
      gap: 0.5rem;
    }

    .included {
      color: var(--accent-success);
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

      &.danger {
        color: var(--accent-danger);

        &:hover:not(:disabled) {
          background: color-mix(in srgb, var(--accent-danger) 10%, transparent);
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
  private readonly electron = inject(ElectronService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  @ViewChild(EpubViewerComponent) viewer!: EpubViewerComponent;

  // Local state
  readonly mode = signal<EditorMode>('select');
  readonly epubSource = signal<string | ArrayBuffer | null>(null);

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

  ngOnInit(): void {
    // Check for epub path in route params or query params
    this.route.queryParams.subscribe(params => {
      if (params['path']) {
        this.loadEpubFromPath(params['path']);
      }
    });
  }

  ngOnDestroy(): void {
    this.epubjs.destroy();
    this.editorState.reset();
  }

  /**
   * Keyboard shortcuts
   */
  @HostListener('window:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    // Mode shortcuts (when not in input)
    if ((event.target as HTMLElement).tagName !== 'INPUT') {
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        this.setMode('select');
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        this.setMode('search');
      } else if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        this.setMode('categories');
      }
    }

    // Undo/redo
    if (event.metaKey || event.ctrlKey) {
      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.undo();
      } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
        event.preventDefault();
        this.redo();
      }
    }
  }

  /**
   * Load EPUB from file path
   */
  async loadEpubFromPath(filePath: string): Promise<void> {
    try {
      // Read the file via Electron
      // For now, we'll just set the path directly - epub.js can handle file paths
      this.epubSource.set(filePath);

      // Extract filename
      const filename = filePath.split('/').pop() || 'Untitled.epub';
      this.editorState.epubPath.set(filePath);
      this.editorState.epubName.set(filename);
    } catch (error) {
      console.error('Failed to load EPUB:', error);
    }
  }

  /**
   * Open file picker
   */
  async openFilePicker(): Promise<void> {
    try {
      const result = await this.electron.openPdfDialog();
      if (result.success && result.filePath && result.filePath.endsWith('.epub')) {
        await this.loadEpubFromPath(result.filePath);
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
    this.mode.set(newMode);
  }

  /**
   * Handle EPUB loaded
   */
  onEpubLoaded(): void {
    // Update editor state with epub.js data
    this.editorState.loadDocument({
      epubPath: this.editorState.epubPath(),
      epubName: this.editorState.epubName(),
      title: this.epubjs.title(),
      author: this.epubjs.author(),
      coverUrl: this.epubjs.coverUrl(),
      totalChapters: this.epubjs.totalChapters(),
    });
  }

  /**
   * Handle EPUB load error
   */
  onEpubError(error: string): void {
    console.error('EPUB load error:', error);
    // Could show a toast notification here
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
    this.setMode('categories');
  }

  /**
   * Search for selected text
   */
  searchSelectedText(): void {
    const text = this.selectedText();
    if (!text) return;

    this.searchQuery = text;
    this.setMode('search');
    this.performSearch();
  }

  /**
   * Create highlight from current selection
   */
  createHighlightFromSelection(): void {
    const cfi = this.selectedCfi();
    const text = this.selectedText();
    if (!cfi || !text) return;

    // For now, just add a temporary highlight
    // In a full implementation, this would open a category selector
    this.viewer.addHighlight(cfi, 'selection', '#6495ED');
  }

  /**
   * Select all highlights in a category
   */
  selectAllInCategory(categoryId: string): void {
    this.editorState.selectAllInCategory(categoryId);
  }

  /**
   * Delete all highlights in a category
   */
  deleteCategoryHighlights(categoryId: string): void {
    this.editorState.deleteCategory(categoryId);
  }

  /**
   * Undo last action
   */
  undo(): void {
    this.editorState.undo();
  }

  /**
   * Redo last undone action
   */
  redo(): void {
    this.editorState.redo();
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
        // Mark as saved
        this.editorState.markSaved();
        // Could show a success notification here
      } else {
        console.error('Export failed:', result.error);
        // Could show an error notification here
      }
    } catch (error) {
      console.error('Export error:', error);
    }
  }

  /**
   * Handle category selection from categories panel
   */
  onCategorySelected(categoryId: string): void {
    console.log('Category selected:', categoryId);
    // Could scroll to first highlight in category
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
   * Transfer EPUB to Audiobook Producer
   * If there are deletions, exports first then transfers
   * Otherwise transfers the original file
   */
  async transferToAudiobook(): Promise<void> {
    const epubPath = this.editorState.epubPath();
    const epubName = this.editorState.epubName();
    if (!epubPath || !epubName) return;

    try {
      let transferPath = epubPath;
      const deletedCount = this.editorState.deletedHighlightIds().size;

      // If there are deletions, export first
      if (deletedCount > 0) {
        const exportResult = await this.exportService.exportWithDeletions();
        if (!exportResult.success || !exportResult.outputPath) {
          console.error('Export failed before transfer:', exportResult.error);
          return;
        }
        transferPath = exportResult.outputPath;
        this.editorState.markSaved();
      }

      // Copy to audiobook queue
      const result = await this.electron.copyToAudiobookQueue(transferPath, epubName);

      if (result.success) {
        console.log('EPUB transferred to Audiobook Producer');
        // Navigate to audiobook producer
        this.router.navigate(['/audiobook']);
      } else {
        console.error('Transfer to Audiobook failed:', result.error);
      }
    } catch (error) {
      console.error('Transfer error:', error);
    }
  }
}
